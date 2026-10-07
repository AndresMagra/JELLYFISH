import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config';
import type { Db } from './db/client';
import { type UserRole, users } from './db/schema';
import { DomainError, forbidden, unauthorized } from './errors';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerCatalogRoutes } from './routes/catalog';
import { registerDriverRoutes } from './routes/driver';
import { registerOrderRoutes } from './routes/orders';
import type { OtpSender } from './services/auth';
import type { OrderContext, OrderHooks } from './services/orders';

export interface AppDeps {
  db: Db;
  config: Config;
  otpSender: OtpSender;
  hooks?: OrderHooks;
  now?: () => Date;
  logger?: boolean;
}

export interface SessionUser {
  id: string;
  role: UserRole;
  phone: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: UserRole };
    user: { sub: string; role: UserRole };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionUser;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      ...roles: UserRole[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    deps: AppDeps;
    orderCtx: OrderContext;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 2 * 1024 * 1024 });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(jwt, { secret: deps.config.jwtSecret, sign: { expiresIn: '30d' } });

  app.decorate('deps', deps);
  app.decorate('orderCtx', {
    db: deps.db,
    config: deps.config,
    hooks: deps.hooks,
    now: deps.now,
  } satisfies OrderContext);

  // CSV por el cuerpo (administrador sube el inventario).
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized();
    }
    const [user] = await deps.db
      .select({ id: users.id, role: users.role, phone: users.phone, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, req.user.sub));
    // El rol se lee de la base, no del token: quitar un permiso surte efecto al instante.
    if (!user || user.deletedAt) throw unauthorized('Tu sesión ya no es válida');
    req.session = { id: user.id, role: user.role, phone: user.phone };
  });

  app.decorate(
    'requireRole',
    (...roles: UserRole[]) =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        await app.authenticate(req, reply);
        if (!req.session || !roles.includes(req.session.role)) throw forbidden();
      },
  );

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof DomainError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation', message: 'Datos inválidos', details: error.issues },
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.status(429).send({
        error: { code: 'rate_limited', message: 'Demasiadas solicitudes. Espera un momento.' },
      });
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: 'bad_request', message: (error as Error).message },
      });
    }
    req.log.error(error);
    return reply.status(500).send({
      error: { code: 'internal', message: 'Algo salió mal de nuestro lado. Intenta de nuevo.' },
    });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Ruta no encontrada' } }),
  );

  app.get('/health', async () => ({ status: 'ok', demo: deps.config.demo }));

  await registerAuthRoutes(app);
  await registerCatalogRoutes(app);
  await registerOrderRoutes(app);
  await registerAdminRoutes(app);
  await registerDriverRoutes(app);

  return app;
}
