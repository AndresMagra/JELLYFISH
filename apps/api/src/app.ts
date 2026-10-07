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
import {
  DEFAULT_BODY_LIMIT,
  buildLoggerOptions,
  installSecurity,
  toFastifyTrustProxy,
} from './plugins/security';
import type { ErrorReporter } from './plugins/sentry';
import { registerAdminRoutes } from './routes/admin';
import { installAudit, registerAuditRoutes } from './routes/audit';
import { registerAuthRoutes } from './routes/auth';
import { registerCatalogRoutes } from './routes/catalog';
import { registerCouponRoutes } from './routes/coupons';
import { registerDeliveryRoutes } from './routes/delivery';
import { registerDriverRoutes } from './routes/driver';
import { registerLotRoutes } from './routes/lots';
import { registerOrderRoutes } from './routes/orders';
import { registerPaymentRoutes } from './routes/payments';
import { installPushLifecycle, registerPushRoutes } from './routes/push';
import { registerStaticRoutes } from './routes/static';
import type { OtpSender } from './services/auth';
import { CouponAttemptLimiter } from './services/coupons';
import { deliveryHooks } from './services/delivery';
import { lotHooks } from './services/lots';
import type { OrderContext, OrderHooks } from './services/orders';
import { type PaymentContext, createGateway, paymentHooks } from './services/payments';
import { ExpoPushSender, PushService, type PushSender } from './services/push';

export interface AppDeps {
  db: Db;
  config: Config;
  otpSender: OtpSender;
  hooks?: OrderHooks;
  /** Transporte de notificaciones push; por defecto Expo. Se inyecta un doble en las pruebas. */
  pushSender?: PushSender;
  now?: () => Date;
  /** `true` = registro de peticiones por la salida estándar; `{ stream }` lo manda a otro destino (pruebas). */
  logger?: boolean | { stream: NodeJS.WritableStream };
  /** Reporte de errores 5xx (Sentry). Sin él no se reporta nada. */
  errorReporter?: ErrorReporter;
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
    paymentCtx: PaymentContext;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Oculta cabeceras, campos secretos del cuerpo y tokens de la URL (ver plugins/security.ts).
    logger: buildLoggerOptions(deps.logger),
    // 256 KB para todo; solo la importación del CSV sube a 5 MB (por ruta, en installSecurity).
    bodyLimit: DEFAULT_BODY_LIMIT,
    // Con TRUST_PROXY, `req.ip` es la IP real detrás del balanceador (límite de peticiones y auditoría).
    trustProxy: toFastifyTrustProxy(deps.config.trustProxy),
  });

  // Antes de rateLimit: ajusta los límites por ruta que ese plugin lee al registrarlas.
  await installSecurity(app, deps.config);
  await app.register(cors, {
    origin: deps.config.corsOrigins,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    maxAge: 600,
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(jwt, { secret: deps.config.jwtSecret, sign: { expiresIn: '30d' } });

  app.decorate('deps', deps);
  // Bitácora de auditoría de lo que cambia en /v1/admin y /v1/driver (ver routes/audit.ts).
  installAudit(app, { db: deps.db, now: deps.now });
  // Las reglas de dinero siempre acompañan al pedido; `deps.hooks` permite añadir más en pruebas.
  const payHooks = paymentHooks();
  // PIN de entrega al crear el pedido y borrado de la posición del repartidor al terminar la entrega.
  const delHooks = deliveryHooks();
  // Al empacar, descuenta de los lotes por vencimiento (FEFO) dentro de la misma transacción.
  const lotH = lotHooks();
  // Avisos push del pedido: los hooks solo anotan dentro de la transacción; el envío ocurre
  // después del commit (ver services/push.ts).
  const push = new PushService({
    db: deps.db,
    config: deps.config,
    sender:
      deps.pushSender ??
      new ExpoPushSender({ accessToken: deps.config.expoAccessToken, logger: app.log }),
    logger: app.log,
  });
  app.decorate('push', push);
  installPushLifecycle(app, push);
  const hooks: OrderHooks = {
    afterCreate: async (tx, order) => {
      await payHooks.afterCreate?.(tx, order);
      await delHooks.afterCreate?.(tx, order);
      await deps.hooks?.afterCreate?.(tx, order);
      await push.hooks.afterCreate?.(tx, order);
    },
    beforeTransition: async (tx, order, to) => {
      await payHooks.beforeTransition?.(tx, order, to);
      await deps.hooks?.beforeTransition?.(tx, order, to);
    },
    afterTransition: async (tx, order, from, to) => {
      await payHooks.afterTransition?.(tx, order, from, to);
      await delHooks.afterTransition?.(tx, order, from, to);
      await lotH.afterTransition?.(tx, order, from, to);
      await deps.hooks?.afterTransition?.(tx, order, from, to);
      await push.hooks.afterTransition?.(tx, order, from, to);
    },
  };
  const orderCtx: OrderContext = {
    db: deps.db,
    config: deps.config,
    hooks,
    now: deps.now,
    // Máximo 10 cupones inexistentes por persona y por hora (ver CouponAttemptLimiter).
    couponLimiter: new CouponAttemptLimiter(),
  };
  app.decorate('orderCtx', orderCtx);
  app.decorate('paymentCtx', { ...orderCtx, gateway: createGateway(deps.config) });

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
    if (status === 413) {
      // Mensaje propio: el de Fastify está en inglés y revela el límite exacto.
      return reply.status(413).send({
        error: { code: 'payload_too_large', message: 'El envío es demasiado grande.' },
      });
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: 'bad_request', message: (error as Error).message },
      });
    }
    req.log.error(error);
    // Solo errores 5xx, sin cuerpo ni cabeceras: ver plugins/sentry.ts.
    try {
      deps.errorReporter?.capture(error, {
        method: req.method,
        route: req.routeOptions?.url ?? 'desconocida',
        status: 500,
        requestId: req.id,
      });
    } catch {
      // el reporte de errores nunca debe cambiar la respuesta que recibe la persona
    }
    return reply.status(500).send({
      error: { code: 'internal', message: 'Algo salió mal de nuestro lado. Intenta de nuevo.' },
    });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Ruta no encontrada' } }),
  );

  app.get('/health', async () => ({ status: 'ok', demo: deps.config.demo }));

  await registerAuthRoutes(app);
  await registerPushRoutes(app);
  await registerCatalogRoutes(app);
  await registerStaticRoutes(app);
  await registerOrderRoutes(app);
  await registerPaymentRoutes(app);
  await registerAdminRoutes(app);
  await registerLotRoutes(app);
  await registerAuditRoutes(app);
  await registerCouponRoutes(app);
  await registerDriverRoutes(app);
  await registerDeliveryRoutes(app);

  return app;
}
