import { normalizeDominicanPhone } from '@jellyfish/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import {
  AuditService,
  buildSummary,
  describeRoute,
  normalizePath,
  sanitizePayload,
} from '../services/audit';
import { maskPhone } from '../services/http-util';
import { parse, uuid } from './validate';

declare module 'fastify' {
  interface FastifyInstance {
    audit: AuditService;
  }
}

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUDITED_PREFIXES = ['/v1/admin/', '/v1/driver/'];
/**
 * La app del repartidor manda su posición cada pocos segundos: auditarla llenaría la bitácora de
 * ruido y guardaría coordenadas de una persona. Ya tiene su propio tratamiento de privacidad.
 */
const NOT_AUDITED = new Set(['POST /v1/driver/location']);
const LOGIN_ROUTE = '/v1/auth/otp/verify';
/** Roles cuyos intentos de acceso fallidos interesan (el resto de clientes es ruido). */
const WATCHED_LOGIN_ROLES = new Set(['admin', 'staff']);

interface Captured {
  entityId?: string;
  errorCode?: string;
}

type Kind = 'action' | 'login';

function classify(req: FastifyRequest): Kind | null {
  const method = req.method.toUpperCase();
  // Patrón registrado (`/v1/admin/orders/:id/transition`): ya viene sin ids. Una ruta inexistente
  // (404) no tiene patrón y no se audita.
  const pattern = req.routeOptions?.url;
  if (!pattern || !AUDITED_METHODS.has(method)) return null;
  if (method === 'POST' && pattern === LOGIN_ROUTE) return 'login';
  if (NOT_AUDITED.has(`${method} ${pattern}`)) return null;
  return AUDITED_PREFIXES.some((p) => pattern.startsWith(p)) ? 'action' : null;
}

/**
 * Registra en `audit_log` toda petición que cambia algo bajo /v1/admin y /v1/driver, y los intentos
 * fallidos de inicio de sesión de administradores y personal. Las lecturas (GET) no se auditan.
 *
 * Todo ocurre en `onResponse`: la respuesta ya salió, así que un fallo de la bitácora (se loguea)
 * jamás rompe ni retrasa la petición.
 */
export function installAudit(
  app: FastifyInstance,
  deps: { db: Db; now?: () => Date },
): AuditService {
  const audit = new AuditService({ db: deps.db, now: deps.now, logger: app.log });
  app.decorate('audit', audit);

  // El id de lo que se creó y el código de error solo existen en la respuesta.
  const captured = new WeakMap<FastifyRequest, Captured>();
  app.addHook('onSend', async (req, _reply, payload) => {
    if (classify(req) && typeof payload === 'string' && payload.length <= 64 * 1024) {
      try {
        const json = JSON.parse(payload) as { id?: unknown; error?: { code?: unknown } };
        captured.set(req, {
          entityId: typeof json.id === 'string' ? json.id : undefined,
          errorCode: typeof json.error?.code === 'string' ? json.error.code : undefined,
        });
      } catch {
        // respuesta que no es JSON (CSV, HTML): no hay nada que capturar
      }
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    try {
      const kind = classify(req);
      if (!kind) return;
      const status = reply.statusCode;
      const seen = captured.get(req) ?? {};
      if (kind === 'login') {
        if (status >= 400) void recordFailedLogin(app, audit, req, status, seen.errorCode);
        return;
      }
      // Rechazada por límite de peticiones: auditarla amplificaría justo el abuso que se frena.
      if (status === 429) return;
      const pattern = req.routeOptions.url!;
      const method = req.method.toUpperCase();
      const desc = describeRoute(method, pattern);
      // Todo lo que se guarda o se usa para el texto sale del cuerpo ya saneado.
      const payload = sanitizePayload(req.body, req.query, req.headers['content-type']);
      const input = {
        body: payload ?? {},
        query: (payload?._query ?? {}) as Record<string, unknown>,
      };
      const params = (req.params ?? {}) as Record<string, unknown>;
      const entityId =
        desc.spec.entityId?.(input) ??
        (typeof params.id === 'string' ? params.id : undefined) ??
        seen.entityId ??
        '';
      void audit.record({
        actorId: req.session?.id ?? null,
        actorRole: req.session?.role ?? '',
        method,
        path: pattern || normalizePath(req.url),
        action: desc.action,
        entity: desc.entity,
        entityId: entityId.slice(0, 100),
        status,
        summary: buildSummary(desc, input, status, seen.errorCode),
        payload,
        ip: req.ip ?? null,
      });
    } catch (e) {
      req.log.error({ err: (e as Error).name }, 'Falló el armado de la entrada de auditoría');
    }
  });

  app.addHook('onClose', async () => {
    await audit.idle();
  });
  return audit;
}

/** Solo si el teléfono es de una cuenta admin/staff; nunca guarda el código tecleado. */
function recordFailedLogin(
  app: FastifyInstance,
  audit: AuditService,
  req: FastifyRequest,
  status: number,
  errorCode: string | undefined,
): Promise<void> {
  return audit.run('auth.login_failed', async () => {
    const raw = (req.body as { phone?: unknown } | null | undefined)?.phone;
    const phone = typeof raw === 'string' ? normalizeDominicanPhone(raw) : null;
    if (!phone) return;
    const [user] = await app.deps.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.phone, phone));
    if (!user || !WATCHED_LOGIN_ROLES.has(user.role)) return;
    await audit.record({
      actorId: user.id,
      actorRole: user.role,
      method: 'POST',
      path: LOGIN_ROUTE,
      action: 'auth.login_failed',
      entity: 'user',
      entityId: user.id,
      status,
      summary: `Intento de acceso fallido (${errorCode ?? status}) de ${maskPhone(phone)}`,
      payload: { phone: maskPhone(phone), reason: errorCode ?? String(status) },
      ip: req.ip ?? null,
    });
  });
}

export async function registerAuditRoutes(app: FastifyInstance) {
  // La bitácora es solo del administrador: el personal no debe poder ver (ni borrar) su rastro.
  app.get('/v1/admin/audit', { preHandler: app.requireRole('admin') }, async (req) => {
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().max(100).optional(),
        actorId: uuid.optional(),
        action: z
          .string()
          .max(80)
          .regex(/^[a-z0-9_.*]+$/i, 'Acción inválida')
          .optional(),
      }),
      req.query,
    );
    return app.audit.list(q);
  });
}
