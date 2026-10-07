import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  isExpoPushToken,
  registerDevice,
  unregisterDevice,
  type PushScope,
} from '../services/push';
import type { PushService } from '../services/push';
import { parse } from './validate';

declare module 'fastify' {
  interface FastifyInstance {
    push: PushService;
  }
}

/**
 * Conecta el "después del commit" al ciclo de vida de cada petición:
 *  - `preHandler` abre la cola de la petición. Se hace con callback (`done` dentro de `run`), que
 *    es la forma que conserva el contexto de AsyncLocalStorage en todo lo que viene después, y
 *    no en `onRequest`, para no depender de cómo cada versión de Node propaga el contexto a través
 *    de la lectura del cuerpo (en Node 22 + Fastify 5 también funcionaría; así no hay sorpresas).
 *  - `onSend` programa el envío de lo anotado. No lo espera, así que un push lento o caído nunca
 *    retrasa la respuesta. No depende del código de estado: lo que cuenta es que el evento del
 *    pedido exista ya en la base (ver PushService).
 */
export function installPushLifecycle(app: FastifyInstance, push: PushService): void {
  // Siempre se espera a los envíos pendientes antes de cerrar (la base se cierra después).
  app.addHook('onClose', async () => {
    await push.drain();
  });
  if (!push.enabled) return;

  const scopes = new WeakMap<FastifyRequest, PushScope>();
  app.addHook('preHandler', (req, _reply, done) => {
    const scope = push.createScope();
    scopes.set(req, scope);
    push.runInScope(scope, done);
  });
  app.addHook('onSend', (req, _reply, payload, done) => {
    const scope = scopes.get(req);
    if (scope) push.flush(scope);
    done(null, payload);
  });
}

const deviceSchema = z.object({
  token: z
    .string('Falta el token del dispositivo')
    .trim()
    .refine(isExpoPushToken, 'Token de notificaciones inválido'),
  platform: z.enum(['ios', 'android', 'web'], {
    error: 'Plataforma inválida (ios, android o web)',
  }),
});

export async function registerPushRoutes(app: FastifyInstance) {
  const { deps } = app;
  const me = { preHandler: app.authenticate };

  // La app lo llama al iniciar sesión y cada vez que abre (refresca lastSeenAt).
  app.post('/v1/me/devices', me, async (req) => {
    const body = parse(deviceSchema, req.body);
    return registerDevice(deps.db, req.session!.id, body, (deps.now ?? (() => new Date()))());
  });

  // Al cerrar sesión. Idempotente: si el token ya no estaba, también responde 204.
  app.delete('/v1/me/devices/:token', me, async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(255) }), req.params);
    await unregisterDevice(deps.db, req.session!.id, token);
    return reply.status(204).send();
  });
}
