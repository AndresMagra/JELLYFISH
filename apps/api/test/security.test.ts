import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig, parseTrustProxy } from '../src/config';
import {
  DEFAULT_BODY_LIMIT,
  LARGE_BODY_LIMIT,
  LOG_REDACT,
  STRICT_RATE_RULES,
  isLargeBodyRoute,
  isWeakSecret,
  rateRuleFor,
  redactQuery,
  toFastifyTrustProxy,
  validateProductionEnv,
} from '../src/plugins/security';
import {
  type ErrorReporter,
  type SentrySdk,
  SentryReporter,
  createErrorReporter,
  noopReporter,
  scrubEvent,
  scrubText,
} from '../src/plugins/sentry';
import { MemoryOtpSender } from '../src/services/auth';
import { type World, makeWorld } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
const UUID = '3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c';
const root = fileURLToPath(new URL('../../../', import.meta.url));

const GOOD_ENV = {
  NODE_ENV: 'production',
  JWT_SECRET: 'f3a9c1e07b5d42a8916c0e7d3b8a5f21c4d6e9087a1b3c5d7e9f0a2b4c6d8e1f',
  OTP_PEPPER: '9b1d3f5a7c9e0b2d4f6a8c0e',
  DATABASE_URL: 'postgres://jf:clave-larga@db.interna:5432/jellyfish',
  PUBLIC_API_URL: 'https://api.jellyfish.do',
  CORS_ORIGINS: 'https://panel.jellyfish.do',
  TRUST_PROXY: '1',
  SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1',
} satisfies NodeJS.ProcessEnv;

describe('seguridad del API', () => {
  let w: World;
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  const logLines: string[] = [];
  const reported: { error: unknown; context: unknown }[] = [];
  let reporterMode: 'ok' | 'throws' = 'ok';

  beforeAll(async () => {
    w = await makeWorld();
    const reporter: ErrorReporter = {
      capture(error, context) {
        reported.push({ error, context });
        if (reporterMode === 'throws') throw new Error('Sentry caído');
      },
      async flush() {},
    };
    app = await buildApp({
      db: w.handle.db,
      config: w.config,
      otpSender: new MemoryOtpSender(),
      now: w.ctx.now,
      errorReporter: reporter,
      logger: {
        stream: new Writable({
          write(chunk, _enc, done) {
            logLines.push(String(chunk));
            done();
          },
        }),
      },
    });
    // Rutas de utilería para provocar cada situación (se agregan antes de que el servidor esté listo).
    app.get('/__boom/:id', async () => {
      throw new Error('falló con +18095551234 y Bearer abc.def.ghi');
    });
    app.get('/v1/__cacheable', async (_req, reply) =>
      reply.header('cache-control', 'public, max-age=60').send({ ok: true }),
    );
    app.get('/v1/__plain', async () => ({ ok: true }));
    app.post('/__log', async (req) => {
      req.log.info(
        {
          headers: { authorization: req.headers.authorization, cookie: 'sesion=abc123' },
          body: req.body,
        },
        'diagnóstico',
      );
      return { ok: true };
    });
    admin = { authorization: `Bearer ${app.jwt.sign({ sub: w.adminId, role: 'admin' })}` };
    customer = { authorization: `Bearer ${app.jwt.sign({ sub: w.customerId, role: 'customer' })}` };
  });
  afterAll(async () => {
    await app.close();
    await w.close();
  });

  describe('cabeceras de seguridad (helmet)', () => {
    const expectHardened = (headers: Record<string, unknown>) => {
      expect(headers['content-security-policy']).toBe(
        "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
      );
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(headers['x-dns-prefetch-control']).toBe('off');
      expect(headers['x-powered-by']).toBeUndefined();
    };

    it('van en respuestas correctas y en todos los tipos de error', async () => {
      expectHardened((await app.inject({ url: '/health' })).headers);
      const notFound = await app.inject({ url: '/v1/no-existe' });
      expect(notFound.statusCode).toBe(404);
      expectHardened(notFound.headers);
      const unauth = await app.inject({ url: '/v1/me' });
      expect(unauth.statusCode).toBe(401);
      expectHardened(unauth.headers);
      const invalid = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone: 1 },
      });
      expect(invalid.statusCode).toBe(400);
      expectHardened(invalid.headers);
      const boom = await app.inject({ url: '/__boom/1' });
      expect(boom.statusCode).toBe(500);
      expectHardened(boom.headers);
    });

    it('los datos del API no se guardan en cachés intermedias', async () => {
      const res = await app.inject({ url: '/v1/me', headers: customer });
      expect(res.headers['cache-control']).toBe('no-store');
      const err = await app.inject({ url: '/v1/admin/summary' });
      expect(err.headers['cache-control']).toBe('no-store');
    });

    it('una ruta que define su propia caché la conserva', async () => {
      const own = await app.inject({ url: '/v1/__cacheable' });
      expect(own.headers['cache-control']).toBe('public, max-age=60');
      const plain = await app.inject({ url: '/v1/__plain' });
      expect(plain.headers['cache-control']).toBe('no-store');
      // fuera de /v1 (salud, fotos) no se impone nada
      expect((await app.inject({ url: '/health' })).headers['cache-control']).toBeUndefined();
    });

    it('las páginas HTML de pago conservan su propia política (necesitan estilos y formulario)', async () => {
      const page = await app.inject({ url: `/v1/payments/${UUID}/redirect?token=abcdefghijkl` });
      const csp = String(page.headers['content-security-policy']);
      expect(csp).toContain("style-src 'unsafe-inline'");
      expect(csp).toContain("script-src 'none'");
      expect(csp).not.toBe(
        "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
      );
    });

    it('HSTS solo en producción', async () => {
      expect(
        (await app.inject({ url: '/health' })).headers['strict-transport-security'],
      ).toBeUndefined();
      const prod = await buildApp({
        db: w.handle.db,
        config: { ...w.config, production: true },
        otpSender: new MemoryOtpSender(),
        now: w.ctx.now,
      });
      try {
        const res = await prod.inject({ url: '/health' });
        expect(res.headers['strict-transport-security']).toBe(
          'max-age=31536000; includeSubDomains',
        );
      } finally {
        await prod.close();
      }
    });

    it('no estorba al CORS del panel web', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/orders',
        headers: {
          origin: 'https://panel.ejemplo.do',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://panel.ejemplo.do');
      const get = await app.inject({
        url: '/health',
        headers: { origin: 'https://panel.ejemplo.do' },
      });
      expect(get.headers['access-control-allow-origin']).toBe('https://panel.ejemplo.do');
    });
  });

  describe('límites de cuerpo', () => {
    it('constantes: 256 KB por defecto y 5 MB solo para la importación del CSV', () => {
      expect(DEFAULT_BODY_LIMIT).toBe(256 * 1024);
      expect(LARGE_BODY_LIMIT).toBe(5 * 1024 * 1024);
      expect(isLargeBodyRoute('POST', '/v1/admin/catalog/import')).toBe(true);
      expect(isLargeBodyRoute('GET', '/v1/admin/catalog/import')).toBe(false);
      expect(isLargeBodyRoute('POST', '/v1/admin/zones')).toBe(false);
    });

    it('un JSON de más de 256 KB se rechaza con 413 y mensaje en español, incluso sin sesión', async () => {
      const big = { phone: '8095550001', pad: 'x'.repeat(300 * 1024) };
      for (const [url, headers] of [
        ['/v1/auth/otp/request', {}],
        ['/v1/admin/zones', admin],
        ['/v1/orders', customer],
      ] as const) {
        const res = await app.inject({ method: 'POST', url, headers, payload: big });
        expect(res.statusCode, url).toBe(413);
        expect(json(res).error).toEqual({
          code: 'payload_too_large',
          message: 'El envío es demasiado grande.',
        });
      }
    });

    it('un cuerpo poco menor que 256 KB sí llega a la validación de la ruta', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/zones',
        headers: admin,
        payload: { name: 'x'.repeat(200 * 1024), areas: ['Naco'], feeCentavos: 1 },
      });
      expect(res.statusCode).toBe(400); // el nombre es muy largo: lo dice la ruta, no el límite
      expect(json(res).error.code).toBe('validation');
    });

    it('la importación del CSV admite hasta 5 MB y no más', async () => {
      const header =
        'sku,grupo,nombre,variante,categoria,unidad,paso_lb,minimo_lb,precio,precio_fuente';
      const csv = (bytes: number) => `${header}\n${'\n'.repeat(bytes)}`;
      const post = (payload: string, type = 'text/csv') =>
        app.inject({
          method: 'POST',
          url: '/v1/admin/catalog/import?dryRun=1',
          headers: { ...admin, 'content-type': type },
          payload,
        });

      const mid = await post(csv(1024 * 1024)); // 1 MB como text/csv
      expect(mid.statusCode, mid.body.slice(0, 200)).not.toBe(413);
      const asJson = await app.inject({
        method: 'POST',
        url: '/v1/admin/catalog/import?dryRun=1',
        headers: admin,
        payload: { csv: csv(1024 * 1024) }, // 1 MB dentro de un JSON
      });
      expect(asJson.statusCode, asJson.body.slice(0, 200)).not.toBe(413);

      const tooBig = await post(csv(6 * 1024 * 1024));
      expect(tooBig.statusCode).toBe(413);
      expect(json(tooBig).error.code).toBe('payload_too_large');
    });

    it('el límite grande no se extiende a otras rutas de administración', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/zones',
        headers: { ...admin, 'content-type': 'text/csv' },
        payload: 'a'.repeat(300 * 1024),
      });
      expect(res.statusCode).toBe(413);
    });
  });

  describe('límites de peticiones por ruta', () => {
    it('reglas: acceso 20/10 min, PIN 30/min, ubicación 120/min', () => {
      expect(rateRuleFor('POST', '/v1/auth/magic')).toMatchObject({ name: 'auth', max: 20 });
      expect(rateRuleFor('GET', '/v1/auth/anything')).toMatchObject({ name: 'auth' });
      expect(rateRuleFor('POST', '/v1/driver/orders/:id/transition')).toMatchObject({
        name: 'driver-pin',
        max: 30,
        timeWindow: '1 minute',
      });
      expect(rateRuleFor('POST', '/v1/driver/location')).toMatchObject({ max: 120 });
      expect(rateRuleFor('GET', '/v1/driver/orders')).toBeUndefined();
      expect(rateRuleFor('GET', '/v1/driver/location')).toBeUndefined();
      expect(rateRuleFor('POST', '/v1/orders')).toBeUndefined();
      expect(STRICT_RATE_RULES.every((r) => r.max < 300)).toBe(true);
    });

    // Cada prueba usa su propia app: el contador de peticiones vive en la instancia.
    const freshApp = () =>
      buildApp({
        db: w.handle.db,
        config: w.config,
        otpSender: new MemoryOtpSender(),
        now: w.ctx.now,
      });

    it('entregas con PIN: la petición 31 en un minuto recibe 429', async () => {
      const a = await freshApp();
      try {
        const codes: number[] = [];
        for (let i = 0; i < 31; i++) {
          const res = await a.inject({
            method: 'POST',
            url: `/v1/driver/orders/${UUID}/transition`,
            payload: { to: 'delivered', pin: '0000' },
          });
          codes.push(res.statusCode);
        }
        expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
        expect(codes[30]).toBe(429);
      } finally {
        await a.close();
      }
    });

    it('ubicación del repartidor: la petición 121 en un minuto recibe 429; otras rutas no se afectan', async () => {
      const a = await freshApp();
      try {
        let last = 0;
        for (let i = 0; i < 121; i++) {
          last = (
            await a.inject({
              method: 'POST',
              url: '/v1/driver/location',
              payload: { latitude: 18.4, longitude: -69.9 },
            })
          ).statusCode;
          if (i === 119) expect(last).toBe(401);
        }
        expect(last).toBe(429);
        // otra ruta del repartidor tiene su propio contador
        expect((await a.inject({ url: '/v1/driver/orders' })).statusCode).toBe(401);
      } finally {
        await a.close();
      }
    });

    it('una ruta de acceso nueva nace con 20 por 10 minutos', async () => {
      const a = await freshApp();
      a.post('/v1/auth/nueva', async () => ({ ok: true }));
      try {
        const codes: number[] = [];
        for (let i = 0; i < 21; i++) {
          codes.push(
            (await a.inject({ method: 'POST', url: '/v1/auth/nueva', payload: {} })).statusCode,
          );
        }
        expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
        expect(codes[20]).toBe(429);
      } finally {
        await a.close();
      }
    });

    it('la solicitud de OTP conserva su propio límite (10 por 10 minutos)', async () => {
      const a = await freshApp();
      try {
        const codes: number[] = [];
        for (let i = 0; i < 11; i++) {
          codes.push(
            (
              await a.inject({
                method: 'POST',
                url: '/v1/auth/otp/request',
                payload: { phone: `82955570${String(i).padStart(2, '0')}` },
              })
            ).statusCode,
          );
        }
        expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
        expect(codes[10]).toBe(429);
      } finally {
        await a.close();
      }
    });
  });

  describe('IP real detrás del balanceador', () => {
    it('TRUST_PROXY: números, listas, palabras clave; lo ambiguo falla al arrancar', () => {
      for (const off of [undefined, '', '  ', '0', 'false', 'FALSE']) {
        expect(parseTrustProxy(off), String(off)).toBe(false);
      }
      expect(parseTrustProxy('true')).toBe(true);
      expect(parseTrustProxy(' TRUE ')).toBe(true);
      expect(parseTrustProxy('1')).toBe(1);
      expect(parseTrustProxy('2')).toBe(2);
      expect(parseTrustProxy('10.0.0.0/8, 192.168.1.5')).toEqual(['10.0.0.0/8', '192.168.1.5']);
      expect(parseTrustProxy('uniquelocal')).toEqual(['uniquelocal']);
      expect(parseTrustProxy('loopback,fd00::/8')).toEqual(['loopback', 'fd00::/8']);
      for (const bad of [
        '11',
        'abc',
        '10.0.0.0/99',
        '300.1.1.1',
        '::1/129',
        '10.0.0.0/8/1',
        '1,2',
      ]) {
        expect(() => parseTrustProxy(bad), bad).toThrow(/TRUST_PROXY/);
      }
    });

    it('un número de saltos se traduce a una función que confía solo en esos saltos', () => {
      const one = toFastifyTrustProxy(1) as (a: string, hop: number) => boolean;
      expect([one('x', 0), one('x', 1), one('x', 2)]).toEqual([true, false, false]);
      const two = toFastifyTrustProxy(2) as (a: string, hop: number) => boolean;
      expect([two('x', 0), two('x', 1), two('x', 2)]).toEqual([true, true, false]);
      expect(toFastifyTrustProxy(false)).toBe(false);
      expect(toFastifyTrustProxy(['10.0.0.0/8'])).toEqual(['10.0.0.0/8']);
    });

    const ipOf = async (
      trustProxy: Parameters<typeof toFastifyTrustProxy>[0],
      remoteAddress: string,
      xff: string,
    ) => {
      const a = await buildApp({
        db: w.handle.db,
        config: { ...w.config, trustProxy },
        otpSender: new MemoryOtpSender(),
        now: w.ctx.now,
      });
      a.get('/__ip', async (req) => ({ ip: req.ip }));
      try {
        const res = await a.inject({
          url: '/__ip',
          remoteAddress,
          headers: { 'x-forwarded-for': xff },
        });
        return json(res).ip as string;
      } finally {
        await a.close();
      }
    };

    it('sin TRUST_PROXY se ignora X-Forwarded-For', async () => {
      expect(await ipOf(false, '10.0.0.9', '6.6.6.6')).toBe('10.0.0.9');
    });

    it('con un balanceador, manda la IP que ese balanceador añadió, no la que mande el cliente', async () => {
      expect(await ipOf(1, '10.0.0.9', '203.0.113.7')).toBe('203.0.113.7');
      expect(await ipOf(1, '10.0.0.9', '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7');
    });

    it('con dos balanceadores se saltan dos', async () => {
      expect(await ipOf(2, '10.0.0.9', '6.6.6.6, 203.0.113.7, 10.1.1.1')).toBe('203.0.113.7');
    });

    it('con una lista de proxies, solo cuenta si la conexión viene de uno de ellos', async () => {
      expect(await ipOf(['10.0.0.0/8'], '10.0.0.9', '203.0.113.7')).toBe('203.0.113.7');
      // un cliente directo que manda su propia cabecera no logra falsificar nada
      expect(await ipOf(['10.0.0.0/8'], '198.51.100.4', '6.6.6.6')).toBe('198.51.100.4');
    });

    it('el límite de peticiones cuenta por la IP real, no por la del balanceador', async () => {
      const a = await buildApp({
        db: w.handle.db,
        config: { ...w.config, trustProxy: 1 },
        otpSender: new MemoryOtpSender(),
        now: w.ctx.now,
      });
      try {
        let n = 0; // un teléfono distinto por petición: el límite por teléfono es otra regla
        const hit = (client: string) =>
          a.inject({
            method: 'POST',
            url: '/v1/auth/otp/request',
            remoteAddress: '10.0.0.9',
            headers: { 'x-forwarded-for': client },
            payload: { phone: `82955599${String(n++).padStart(2, '0')}` },
          });
        // Un cliente agota su cupo de 10; otro cliente detrás del MISMO balanceador sigue pasando.
        for (let i = 0; i < 10; i++) await hit('203.0.113.1');
        expect((await hit('203.0.113.1')).statusCode).toBe(429);
        expect((await hit('203.0.113.2')).statusCode).not.toBe(429);
      } finally {
        await a.close();
      }
    });
  });

  describe('logs sin secretos', () => {
    const logged = () => logLines.join('');

    it('oculta cabeceras y campos del cuerpo (código, PIN, token, teléfono) aunque alguien los registre', async () => {
      logLines.length = 0;
      const jwt = customer.authorization!.slice('Bearer '.length);
      const res = await app.inject({
        method: 'POST',
        url: '/__log',
        headers: { ...customer, 'content-type': 'application/json' },
        payload: {
          code: '482913',
          otp: '115599',
          pin: '7312',
          token: 'tok-visible-no',
          password: 'clave-no',
          secret: 'sec-no',
          phone: '+18095550001',
          nota: 'esto sí se ve',
        },
      });
      expect(res.statusCode).toBe(200);
      const text = logged();
      for (const leaked of [
        jwt,
        'sesion=abc123',
        '482913',
        '115599',
        '7312',
        'tok-visible-no',
        'clave-no',
        'sec-no',
        '8095550001',
      ]) {
        expect(text, leaked).not.toContain(leaked);
      }
      expect(text).toContain('[redacted]');
      expect(text).toContain('esto sí se ve'); // lo que no es secreto sí queda, para poder depurar
      expect(text).toContain('diagnóstico');
    });

    it('las mismas reglas protegen la forma req/res/body de pino si alguien agrega esos serializadores', () => {
      const lines: string[] = [];
      const logger = pino(
        { redact: { paths: [...LOG_REDACT.paths], censor: LOG_REDACT.censor } },
        new Writable({
          write(chunk, _enc, done) {
            lines.push(String(chunk));
            done();
          },
        }),
      );
      logger.info({
        req: {
          headers: {
            authorization: 'Bearer aaa.bbb.ccc',
            cookie: 'sesion=abc',
            'x-api-key': 'llave-1',
          },
          body: {
            code: '112233',
            pin: '4455',
            token: 'tok-9',
            phone: '+18095550001',
            nota: 'visible',
          },
        },
        res: { headers: { 'set-cookie': ['sesion=zzz'] }, statusCode: 200 },
        body: { otp: '998877', code: '776655' },
      });
      const text = lines.join('');
      for (const leaked of [
        'aaa.bbb.ccc',
        'sesion=abc',
        'llave-1',
        '112233',
        '4455',
        'tok-9',
        '8095550001',
        'sesion=zzz',
        '998877',
        '776655',
      ]) {
        expect(text, leaked).not.toContain(leaked);
      }
      expect(text).toContain('visible');
      expect(text).toContain('"statusCode":200');
    });

    it('el registro de acceso no guarda tokens ni firmas de la URL', async () => {
      logLines.length = 0;
      await app.inject({
        url: `/v1/payments/${UUID}/redirect?token=ENLACE-FIRMADO-SECRETO&lang=es`,
      });
      await app.inject({
        url: '/v1/payments/mock/approved?AuthHash=firma-de-la-pasarela-0123&OrderNumber=JF1&code=998877',
      });
      await app.inject({ url: '/v1/orders?status=confirmed&limit=5', headers: customer });
      const text = logged();
      expect(text).not.toContain('ENLACE-FIRMADO-SECRETO');
      expect(text).not.toContain('firma-de-la-pasarela-0123');
      expect(text).not.toContain('998877');
      expect(text).toContain('lang=es'); // lo demás se conserva
      expect(text).toContain('OrderNumber=JF1');
      expect(text).toContain('status=confirmed&limit=5');
    });

    it('redactQuery respeta el marcador de http-util y no toca URLs sin query', () => {
      expect(redactQuery('/v1/x')).toBe('/v1/x');
      expect(redactQuery('/v1/x?token=:token&a=1')).toBe('/v1/x?token=:token&a=1');
      expect(redactQuery('/v1/x?PIN=1234&a=1&flag')).toBe('/v1/x?PIN=[redacted]&a=1&flag');
      expect(redactQuery('/v1/x?%74oken=abc')).toBe('/v1/x?%74oken=[redacted]');
    });
  });

  describe('Sentry: errores 5xx sin datos personales', () => {
    it('reporta solo los 5xx, con método, ruta con patrón y id de petición, y nada más', async () => {
      reported.length = 0;
      const res = await app.inject({
        url: '/__boom/98765?token=abc&phone=8095551234',
        headers: { ...customer, cookie: 'sesion=abc' },
      });
      expect(res.statusCode).toBe(500);
      expect(json(res).error.code).toBe('internal');
      // la persona no ve el detalle del error
      expect(res.body).not.toContain('8095551234');
      expect(reported).toHaveLength(1);
      expect((reported[0]!.error as Error).message).toContain('falló con');
      expect(reported[0]!.context).toEqual({
        method: 'GET',
        route: '/__boom/:id', // el patrón, no la URL con ids ni query
        status: 500,
        requestId: expect.any(String),
      });
      const sent = JSON.stringify(reported[0]!.context);
      for (const pii of ['98765', 'abc', '8095551234', 'sesion', customer.authorization!]) {
        expect(sent).not.toContain(pii);
      }
    });

    it('los errores de la persona (4xx) no se reportan', async () => {
      reported.length = 0;
      await app.inject({ url: '/v1/no-existe' }); // 404
      await app.inject({ url: '/v1/me' }); // 401
      await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: 1 } }); // 400
      await app.inject({ url: '/v1/admin/summary', headers: customer }); // 403
      await app.inject({
        method: 'POST',
        url: '/v1/admin/users/' + UUID + '/role',
        headers: admin,
        payload: { role: 'driver' },
      }); // 404
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { pad: 'x'.repeat(300 * 1024) },
      }); // 413
      expect(reported).toEqual([]);
    });

    it('si el reporte falla, la respuesta a la persona no cambia', async () => {
      reporterMode = 'throws';
      try {
        const res = await app.inject({ url: '/__boom/1' });
        expect(res.statusCode).toBe(500);
        expect(json(res)).toEqual({
          error: { code: 'internal', message: 'Algo salió mal de nuestro lado. Intenta de nuevo.' },
        });
      } finally {
        reporterMode = 'ok';
      }
    });

    it('sin reporte configurado el API responde igual', async () => {
      const a = await buildApp({
        db: w.handle.db,
        config: w.config,
        otpSender: new MemoryOtpSender(),
        now: w.ctx.now,
      });
      a.get('/__boom', async () => {
        throw new Error('x');
      });
      try {
        expect((await a.inject({ url: '/__boom' })).statusCode).toBe(500);
      } finally {
        await a.close();
      }
    });
  });
});

describe('Sentry: configuración y filtro de datos', () => {
  const fakeSdk = () => {
    const calls = {
      init: [] as Record<string, unknown>[],
      capture: [] as { error: unknown; hint: Record<string, unknown> | undefined }[],
      flush: 0,
    };
    const sdk: SentrySdk = {
      init: (o) => void calls.init.push(o),
      captureException: (error, hint) => void calls.capture.push({ error, hint }),
      flush: async () => {
        calls.flush++;
        return true;
      },
    };
    return { calls, sdk };
  };

  it('sin DSN no hace nada: ni inicializa el SDK ni reporta', async () => {
    const { calls, sdk } = fakeSdk();
    const reporter = await createErrorReporter(
      { sentryDsn: null },
      { NODE_ENV: 'production' },
      { sdk },
    );
    expect(reporter).toBe(noopReporter);
    reporter.capture(new Error('x'), { method: 'GET', route: '/x', status: 500 });
    await reporter.flush();
    expect(calls).toEqual({ init: [], capture: [], flush: 0 });
    expect(loadConfig({}).sentryDsn).toBeNull();
    expect(loadConfig({ SENTRY_DSN: '  ' }).sentryDsn).toBeNull();
    expect(loadConfig({ SENTRY_DSN: ' https://k@o1.ingest.sentry.io/2 ' }).sentryDsn).toBe(
      'https://k@o1.ingest.sentry.io/2',
    );
  });

  it('con DSN inicializa una vez, sin datos personales por defecto ni migas de pan', async () => {
    const { calls, sdk } = fakeSdk();
    const reporter = await createErrorReporter(
      { sentryDsn: 'https://k@o1.ingest.sentry.io/2' },
      { NODE_ENV: 'production', SENTRY_RELEASE: ' v1.2.3 ' },
      { sdk },
    );
    expect(reporter).toBeInstanceOf(SentryReporter);
    expect(calls.init).toHaveLength(1);
    const init = calls.init[0]!;
    expect(init).toMatchObject({
      dsn: 'https://k@o1.ingest.sentry.io/2',
      environment: 'production',
      release: 'v1.2.3',
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
    });
    expect((init.beforeBreadcrumb as () => unknown)()).toBeNull();
    expect(init.tracesSampleRate).toBeUndefined(); // sin trazas de rendimiento
    // quita las integraciones que adjuntan petición, usuario o consola
    const integrations = init.integrations as (d: { name: string }[]) => { name: string }[];
    const kept = integrations(
      ['ProcessSession', 'RequestData', 'Console', 'Http', 'Fastify', 'Dedupe', 'LinkedErrors'].map(
        (name) => ({ name }),
      ),
    ).map((i) => i.name);
    expect(kept).toEqual(['Dedupe', 'LinkedErrors']);
  });

  it('si el SDK no arranca, el API sigue sin reporte en vez de caerse', async () => {
    const errors: Record<string, unknown>[] = [];
    const broken: SentrySdk = {
      init() {
        throw new TypeError('DSN inválido');
      },
      captureException() {},
      flush: async () => true,
    };
    const reporter = await createErrorReporter(
      { sentryDsn: 'esto-no-es-un-dsn' },
      {},
      { sdk: broken, logger: { error: (o) => void errors.push(o) } },
    );
    expect(reporter).toBe(noopReporter);
    expect(errors).toEqual([{ err: 'TypeError' }]);
  });

  it('captura con etiquetas de método, ruta y estado; nunca con cuerpo ni datos', async () => {
    const { calls, sdk } = fakeSdk();
    const reporter = await createErrorReporter(
      { sentryDsn: 'https://k@o1.ingest.sentry.io/2' },
      {},
      { sdk },
    );
    const error = new Error('boom');
    reporter.capture(error, {
      method: 'POST',
      route: '/v1/orders/:id/pay',
      status: 500,
      requestId: 'r1',
    });
    expect(calls.capture).toEqual([
      {
        error,
        hint: {
          tags: { method: 'POST', route: '/v1/orders/:id/pay', status: '500', requestId: 'r1' },
        },
      },
    ]);
    await reporter.flush();
    expect(calls.flush).toBe(1);
  });

  it('un fallo del SDK no se propaga a la petición', async () => {
    const errors: unknown[] = [];
    const reporter = new SentryReporter(
      {
        init() {},
        captureException() {
          throw new Error('red caída');
        },
        flush: async () => {
          throw new Error('red caída');
        },
      },
      { error: (o) => void errors.push(o) },
    );
    expect(() =>
      reporter.capture(new Error('x'), { method: 'GET', route: '/', status: 500 }),
    ).not.toThrow();
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('el filtro final quita petición, usuario, migas, extras y contextos, y depura los textos', async () => {
    const { calls, sdk } = fakeSdk();
    await createErrorReporter({ sentryDsn: 'https://k@o1.ingest.sentry.io/2' }, {}, { sdk });
    const beforeSend = calls.init[0]!.beforeSend as (
      e: Record<string, unknown>,
    ) => Record<string, unknown>;
    const out = beforeSend({
      event_id: 'e1',
      message: 'Fallo para +1 (809) 555-1234',
      request: {
        url: 'https://x/y?token=1',
        headers: { authorization: 'Bearer abc.def.ghi' },
        data: { pin: '1' },
      },
      user: { id: 'u1', ip_address: '1.2.3.4', username: 'Ana' },
      breadcrumbs: [{ message: 'OTP 123456' }],
      extra: { cuerpo: { code: '123456' } },
      contexts: { device: { name: 'x' } },
      server_name: 'srv-1',
      tags: { route: '/v1/orders/:id' },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.firma y +18095551234',
            stacktrace: {
              frames: [
                {
                  function: 'f',
                  vars: { phone: '+18095551234' },
                  pre_context: ['const tel = "+18095551234";'],
                  context_line: 'throw new Error(`falló ${tel}`);',
                  post_context: ['// Bearer abc.def.ghi'],
                },
              ],
            },
          },
        ],
      },
    });
    expect(out.request).toBeUndefined();
    expect(out.user).toBeUndefined();
    expect(out.breadcrumbs).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.contexts).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    expect(out.tags).toEqual({ route: '/v1/orders/:id' }); // lo que sí sirve para agrupar
    expect(out.event_id).toBe('e1');
    const text = JSON.stringify(out);
    for (const leaked of [
      '8095551234',
      '555-1234',
      'abc.def.ghi',
      'eyJhbGci',
      '123456',
      'Ana',
      '1.2.3.4',
    ]) {
      expect(text, leaked).not.toContain(leaked);
    }
    expect(text).toContain('[número]');
    expect(text).toContain('[token]');
  });

  it('scrubText cubre teléfonos con distintos formatos, JWT, Bearer y tokens de Expo', () => {
    expect(scrubText('llamar al 809-555-1234 o +1 829 555 9876 o (849) 555.0000')).toBe(
      'llamar al [número] o [número] o [número]',
    );
    expect(scrubText('t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe('t=[token]');
    expect(scrubText('Authorization: Bearer abc123.def')).toBe('Authorization: Bearer [token]');
    expect(scrubText('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] falló')).toBe('[token] falló');
    expect(scrubText('JF-000123 se canceló')).toBe('JF-000123 se canceló'); // los números de pedido se conservan
    expect(scrubEvent({ message: 'ok' })).toEqual({ message: 'ok' });
  });

  it('con el SDK real de Sentry (sin red) no sale nada de lo sensible', () => {
    const secrets = {
      userId: 'u-7a1c-user',
      name: 'Ana Pérez',
      ip: '203.0.113.9',
      code: 'OTP-654321-X',
      phone: '+18095551234',
      pin: 'PIN-4321-X',
      bearer: 'Bearer abc.def.ghi',
    };
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'apps/api/test/sentry-smoke.ts'], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SMOKE_SECRETS: JSON.stringify(secrets),
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const { events } = JSON.parse(run.stdout) as { events: string[] };
    // un solo sobre: el evento de error. Sin sesiones (llevarían usuario e IP).
    expect(events).toHaveLength(1);
    const all = events.join('\n');
    for (const value of [...Object.values(secrets), '8095551234', 'abc.def.ghi']) {
      expect(all, value).not.toContain(value);
    }
    expect(all).toContain('"type":"event"');
    expect(all).not.toContain('"type":"session"');
    expect(all).toContain('/v1/orders/:id/pay');
    expect(all).toContain('"requestId":"req-1"');
    expect(all).toContain('"release":"prueba-1"');
    expect(all).toContain('No se pudo cobrar a [número] con Bearer [token]');
  }, 90_000);
});

describe('validación del entorno de producción', () => {
  const without = (...keys: string[]) => {
    const env: NodeJS.ProcessEnv = { ...GOOD_ENV };
    for (const k of keys) delete env[k];
    return env;
  };
  const errorsFor = (patch: NodeJS.ProcessEnv) =>
    validateProductionEnv({ ...GOOD_ENV, ...patch }).errors;

  it('un entorno completo es válido y no avisa de nada', () => {
    expect(validateProductionEnv(GOOD_ENV)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('un entorno vacío lista TODO lo que falta de una vez, en español y nombrando cada variable', () => {
    const result = validateProductionEnv({ NODE_ENV: 'production' });
    expect(result.ok).toBe(false);
    const text = result.errors.join('\n');
    for (const name of [
      'JWT_SECRET',
      'OTP_PEPPER',
      'DATABASE_URL',
      'PUBLIC_API_URL',
      'CORS_ORIGINS',
    ]) {
      expect(text, name).toContain(`${name}: falta`);
    }
    expect(result.errors).toHaveLength(5);
  });

  it('cada variable obligatoria, por separado', () => {
    for (const key of [
      'JWT_SECRET',
      'OTP_PEPPER',
      'DATABASE_URL',
      'PUBLIC_API_URL',
      'CORS_ORIGINS',
    ]) {
      const result = validateProductionEnv(without(key));
      expect(result.ok, key).toBe(false);
      expect(result.errors, key).toHaveLength(1);
      expect(result.errors[0], key).toContain(`${key}: falta`);
      // vacío o solo espacios cuenta como ausente
      expect(validateProductionEnv({ ...GOOD_ENV, [key]: '   ' }).ok, key).toBe(false);
    }
  });

  it('JWT_SECRET: exige 32 caracteres y rechaza valores de muestra, repetidos o de desarrollo', () => {
    expect(errorsFor({ JWT_SECRET: 'corto' })[0]).toContain('demasiado corto');
    expect(errorsFor({ JWT_SECRET: 'a'.repeat(31) })[0]).toContain('demasiado corto');
    const weak = [
      'a'.repeat(40),
      'abcdefgh'.repeat(5),
      '0123456789'.repeat(4),
      'changeme-changeme-changeme-changeme',
      'cambiame-por-un-secreto-aleatorio-123',
      'dev-secret-dev-secret-dev-secret-dev',
      'test-secret-test-secret-test-secret-123', // el de las pruebas del repositorio
      'mi-password-super-largo-para-el-jwt-1234',
      'este-es-un-ejemplo-de-secreto-para-jwt',
      'your-secret-your-secret-your-secret-xx',
    ];
    for (const secret of weak) {
      const errors = errorsFor({ JWT_SECRET: secret });
      expect(errors, secret).toHaveLength(1);
      expect(errors[0], secret).toContain('valor de ejemplo o de desarrollo');
      expect(isWeakSecret(secret), secret).toBe(true);
    }
    expect(errorsFor({ JWT_SECRET: GOOD_ENV.JWT_SECRET })).toEqual([]);
    expect(isWeakSecret(GOOD_ENV.JWT_SECRET)).toBe(false);
    // un secreto aleatorio en base64 de 44 caracteres también sirve
    expect(errorsFor({ JWT_SECRET: 'k3Jx9Pq0vT7mZc2Rw8YbN5aLd1HsGf4UeVo6IiQtXyA=' })).toEqual([]);
  });

  it('los mensajes nunca repiten el valor de un secreto', () => {
    const secret = 'secreto-muy-reservado-que-no-debe-salir-nunca';
    const result = validateProductionEnv({
      ...GOOD_ENV,
      JWT_SECRET: 'password-' + secret,
      OTP_PEPPER: 'corto',
      DATABASE_URL: 'mysql://usuario:clave-privada@host/db',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('clave-privada');
    expect(result.errors).toHaveLength(3);
  });

  it('OTP_PEPPER: mínimo 16 caracteres', () => {
    expect(errorsFor({ OTP_PEPPER: 'x'.repeat(15) })[0]).toContain(
      'OTP_PEPPER: es demasiado corto',
    );
    expect(errorsFor({ OTP_PEPPER: 'x'.repeat(16) })).toEqual([]);
  });

  it('DATABASE_URL: solo Postgres', () => {
    for (const ok of ['postgres://u:p@h/db', 'postgresql://u:p@h:5432/db?sslmode=require']) {
      expect(errorsFor({ DATABASE_URL: ok }), ok).toEqual([]);
    }
    for (const bad of ['mysql://u:p@h/db', 'u:p@h/db', 'file:./datos', 'http://h/db']) {
      expect(errorsFor({ DATABASE_URL: bad })[0], bad).toContain(
        'DATABASE_URL: debe empezar con postgres://',
      );
    }
  });

  it('PUBLIC_API_URL: pública, válida y con https', () => {
    expect(errorsFor({ PUBLIC_API_URL: 'https://api.jellyfish.do' })).toEqual([]);
    expect(errorsFor({ PUBLIC_API_URL: 'https://api.jellyfish.do/prefijo' })).toEqual([]);
    for (const bad of [
      'http://api.jellyfish.do',
      'https://localhost:3000',
      'https://127.0.0.1',
      'http://localhost:3000',
    ]) {
      expect(errorsFor({ PUBLIC_API_URL: bad })[0], bad).toContain('https://');
    }
    expect(errorsFor({ PUBLIC_API_URL: 'api.jellyfish.do' })[0]).toContain(
      'no es una dirección válida',
    );
  });

  it('CORS_ORIGINS: lista de orígenes https, sin comodín ni rutas', () => {
    expect(
      errorsFor({ CORS_ORIGINS: 'https://panel.jellyfish.do, https://admin.jellyfish.do' }),
    ).toEqual([]);
    expect(errorsFor({ CORS_ORIGINS: 'https://panel.jellyfish.do/' })).toEqual([]); // barra final tolerada
    expect(errorsFor({ CORS_ORIGINS: 'http://localhost:5173' })).toEqual([]);
    expect(errorsFor({ CORS_ORIGINS: '*' })[0]).toContain('no puede ser "*"');
    expect(errorsFor({ CORS_ORIGINS: 'http://panel.jellyfish.do' })[0]).toContain(
      'debe usar https://',
    );
    expect(errorsFor({ CORS_ORIGINS: 'https://panel.jellyfish.do/admin' })[0]).toContain(
      'sin ruta',
    );
    expect(errorsFor({ CORS_ORIGINS: 'panel.jellyfish.do' })[0]).toContain(
      'no es un origen válido',
    );
    // un origen malo entre varios buenos se señala, y solo ese
    const mixed = errorsFor({ CORS_ORIGINS: 'https://a.jellyfish.do,*,https://b.jellyfish.do' });
    expect(mixed).toHaveLength(1);
  });

  it('el simulador de pagos no puede estar activo en producción', () => {
    expect(errorsFor({ PAYMENTS_MOCK: '1' })[0]).toContain('PAYMENTS_MOCK');
    expect(errorsFor({ PAYMENTS_MOCK: '0' })).toEqual([]);
  });

  it('avisa (sin impedir el arranque) del modo demo, de TRUST_PROXY y de Sentry', () => {
    const demo = validateProductionEnv({ ...GOOD_ENV, JELLYFISH_DEMO: '1' });
    expect(demo.ok).toBe(true);
    expect(demo.warnings.join()).toContain('JELLYFISH_DEMO=1');

    const noProxy = validateProductionEnv(without('TRUST_PROXY'));
    expect(noProxy.ok).toBe(true);
    expect(noProxy.warnings.join()).toContain('TRUST_PROXY: sin definir');
    expect(validateProductionEnv({ ...GOOD_ENV, TRUST_PROXY: '0' }).warnings.join()).toContain(
      'TRUST_PROXY',
    );

    const trustAll = validateProductionEnv({ ...GOOD_ENV, TRUST_PROXY: 'true' });
    expect(trustAll.ok).toBe(true);
    expect(trustAll.warnings.join()).toContain('falsificar');

    const noSentry = validateProductionEnv(without('SENTRY_DSN'));
    expect(noSentry.ok).toBe(true);
    expect(noSentry.warnings.join()).toContain('SENTRY_DSN');
  });

  it('es pura: no cambia el entorno que recibe y da el mismo resultado cada vez', () => {
    // valores con espacios: una versión que los "limpiara" en el objeto recibido lo dejaría cambiado
    const env = {
      ...GOOD_ENV,
      JWT_SECRET: `  ${GOOD_ENV.JWT_SECRET}  `,
      DATABASE_URL: ' postgres://u:p@h/db ',
      CORS_ORIGINS: ' https://panel.jellyfish.do , https://admin.jellyfish.do ',
    };
    const copy = { ...env };
    const first = validateProductionEnv(env);
    expect(env).toEqual(copy);
    expect(validateProductionEnv(env)).toEqual(first);
  });

  it('concuerda con loadConfig: un entorno válido carga y expone los ajustes nuevos', () => {
    const config = loadConfig(GOOD_ENV);
    expect(config).toMatchObject({
      production: true,
      trustProxy: 1,
      sentryDsn: 'https://public@o0.ingest.sentry.io/1',
      corsOrigins: ['https://panel.jellyfish.do'],
    });
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({
      production: false,
      trustProxy: false,
      sentryDsn: null,
    });
    expect(() => loadConfig({ ...GOOD_ENV, TRUST_PROXY: 'quizás' })).toThrow(/TRUST_PROXY/);
  });

  describe('al arrancar el servidor', () => {
    const start = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        encoding: 'utf8',
        timeout: 60_000,
      });

    it('en producción con la configuración incompleta no arranca y lo dice todo junto', () => {
      const run = start({
        NODE_ENV: 'production',
        JWT_SECRET: 'corto-y-secreto-1234',
        CORS_ORIGINS: '*',
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('El API no puede arrancar en producción');
      for (const expected of [
        'JWT_SECRET: es demasiado corto',
        'OTP_PEPPER: falta',
        'DATABASE_URL: falta',
        'PUBLIC_API_URL: falta',
        'CORS_ORIGINS: no puede ser "*"',
      ]) {
        expect(run.stderr, expected).toContain(expected);
      }
      expect(run.stderr).not.toContain('corto-y-secreto-1234'); // ni el valor, ni en la salida
      expect(run.stdout).not.toContain('corto-y-secreto-1234');
    }, 90_000);

    it('con la configuración completa pasa la validación (y muestra los avisos)', () => {
      // Sin canal de OTP real el arranque se detiene DESPUÉS de validar: sirve para ver que pasó la puerta.
      const { SENTRY_DSN: _dsn, TRUST_PROXY: _tp, ...rest } = GOOD_ENV;
      const run = start(rest);
      expect(run.stderr).not.toContain('El API no puede arrancar en producción');
      expect(run.stderr).toContain('Aviso de configuración: TRUST_PROXY: sin definir');
      expect(run.stderr).toContain('SENTRY_DSN: sin definir');
    }, 90_000);
  });
});
