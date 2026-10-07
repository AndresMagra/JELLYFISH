import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { OTP_TTL_MINUTES } from '../src/config';
import { otpCodes } from '../src/db/schema';
import { DomainError } from '../src/errors';
import { ConsoleOtpSender } from '../src/services/auth';
import type { FetchLike, Logger } from '../src/services/http-util';
import {
  OTP_REQUEST_TIMEOUT_MS,
  TWILIO_MESSAGES_URL,
  TwilioSmsSender,
  WHATSAPP_MESSAGES_URL,
  WhatsAppCloudSender,
  createOtpSender,
  otpMessage,
} from '../src/services/otp-senders';
import { fakeFetch, hang, json, recordingLogger } from './fake-fetch';
import { type World, makeWorld } from './helpers';

const SID = `AC${'a1'.repeat(16)}`;
const MG = `MG${'b2'.repeat(16)}`;
const TOKEN = 'tok_super_secreto_de_twilio';
const WA_TOKEN = 'EAAG_token_secreto_de_meta_0123456789';
const PHONE = '+18095550123';
const CODE = '482916';

const noSleep = async () => {};
/** Para que las fallas esperadas de cada prueba no ensucien la salida. */
const quiet = () => recordingLogger().logger;

function twilio(
  fetch: FetchLike,
  extra: { logger?: Logger; ttlMinutes?: number; timeoutMs?: number } = {},
) {
  return new TwilioSmsSender(
    { accountSid: SID, authToken: TOKEN, from: '+18095550000' },
    { fetch, sleep: noSleep, ttlMinutes: 5, logger: quiet(), ...extra },
  );
}

function whatsapp(
  fetch: FetchLike,
  extra: { logger?: Logger; timeoutMs?: number; language?: string } = {},
) {
  const { language, ...options } = extra;
  return new WhatsAppCloudSender(
    {
      phoneNumberId: '109876543210',
      accessToken: WA_TOKEN,
      template: 'jellyfish_otp',
      language,
    },
    { fetch, sleep: noSleep, logger: quiet(), ...options },
  );
}

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  }
  throw new Error('Se esperaba un error y la promesa se resolvió');
}

describe('texto del mensaje', () => {
  it('usa la vigencia que recibe y concuerda en singular y plural', () => {
    expect(otpMessage('123456', 5)).toBe(
      'Tu código de JELLYFISH es 123456. Vence en 5 minutos. No lo compartas con nadie.',
    );
    expect(otpMessage('123456', 10)).toContain('Vence en 10 minutos.');
    expect(otpMessage('123456', 1)).toContain('Vence en 1 minuto.');
  });
});

describe('TwilioSmsSender', () => {
  it('envía la petición exacta: URL, Basic auth, formulario y plazo', async () => {
    const f = fakeFetch(json({ sid: 'SM1', status: 'queued' }, 201));
    await twilio(f.fetch).send(PHONE, CODE);

    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(url).toBe(TWILIO_MESSAGES_URL(SID));
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      To: PHONE,
      From: '+18095550000',
      Body: `Tu código de JELLYFISH es ${CODE}. Vence en 5 minutos. No lo compartas con nadie.`,
    });
    // El "+" del teléfono viaja codificado: sin eso Twilio lo leería como un espacio.
    expect(init.body as string).toContain('To=%2B18095550123');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('manual');
  });

  it('con servicio de mensajería usa MessagingServiceSid y no From', async () => {
    const f = fakeFetch(json({}, 201));
    const sender = new TwilioSmsSender(
      { accountSid: SID, authToken: TOKEN, from: '+18095550000', messagingServiceSid: MG },
      { fetch: f.fetch, sleep: noSleep, logger: quiet() },
    );
    await sender.send(PHONE, CODE);
    const form = Object.fromEntries(new URLSearchParams(f.calls[0]!.init.body as string));
    expect(form.MessagingServiceSid).toBe(MG);
    expect(form).not.toHaveProperty('From');
  });

  it('la vigencia por defecto es la de la configuración real', async () => {
    const f = fakeFetch(json({}, 201));
    const sender = new TwilioSmsSender(
      { accountSid: SID, authToken: TOKEN, from: '+18095550000' },
      { fetch: f.fetch, logger: quiet() },
    );
    await sender.send(PHONE, CODE);
    const form = Object.fromEntries(new URLSearchParams(f.calls[0]!.init.body as string));
    expect(form.Body).toContain(`Vence en ${OTP_TTL_MINUTES} minutos.`);
  });

  it('reintenta una vez ante un error de red y entrega si el segundo intento funciona', async () => {
    const f = fakeFetch(new TypeError('fetch failed'), json({}, 201));
    const log = recordingLogger();
    await twilio(f.fetch, { logger: log.logger }).send(PHONE, CODE);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.url).toBe(f.calls[0]!.url);
    expect(f.calls[1]!.init.body).toBe(f.calls[0]!.init.body);
    // El primer intento fallido queda registrado como aviso, no como error.
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      level: 'warn',
      obj: { provider: 'twilio', attempt: 1, willRetry: true, reason: 'network' },
    });
  });

  it('reintenta una vez ante un 5xx y entrega si el segundo intento funciona', async () => {
    const f = fakeFetch(json({ message: 'Service unavailable' }, 503), json({}, 201));
    await twilio(f.fetch).send(PHONE, CODE);
    expect(f.calls).toHaveLength(2);
  });

  it('espera entre el primer intento y el reintento', async () => {
    const f = fakeFetch(json({}, 500), json({}, 201));
    const sleeps: number[] = [];
    const sender = new TwilioSmsSender(
      { accountSid: SID, authToken: TOKEN, from: '+18095550000' },
      {
        fetch: f.fetch,
        logger: quiet(),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    await sender.send(PHONE, CODE);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it('con dos fallas seguidas se rinde: 2 llamadas y un error genérico', async () => {
    const f = fakeFetch(json({ message: 'boom' }, 502));
    const err = await rejection(twilio(f.fetch).send(PHONE, CODE));
    expect(f.calls).toHaveLength(2);
    expect(err).toMatchObject({ code: 'otp_delivery_failed', status: 503 });
    expect(err.message).toBe(
      'No pudimos enviar el código en este momento. Intenta de nuevo en unos minutos.',
    );
    expect(err.details).toBeUndefined();
  });

  it('NO reintenta los errores del cliente (4xx), incluido 429', async () => {
    for (const status of [400, 401, 403, 429]) {
      const f = fakeFetch(json({ code: 20003, message: 'Authenticate' }, status));
      const err = await rejection(twilio(f.fetch).send(PHONE, CODE));
      expect(f.calls, `HTTP ${status}`).toHaveLength(1);
      expect(err.code).toBe('otp_delivery_failed');
    }
  });

  it('una redirección no se sigue ni se trata como éxito', async () => {
    const f = fakeFetch(
      new Response(null, { status: 302, headers: { location: 'https://x.test' } }),
    );
    const err = await rejection(twilio(f.fetch).send(PHONE, CODE));
    expect(f.calls).toHaveLength(1);
    expect(err.code).toBe('otp_delivery_failed');
  });

  it('corta la petición que no contesta (tiempo agotado) y reintenta una vez', async () => {
    const f = fakeFetch(hang);
    const log = recordingLogger();
    const err = await rejection(
      twilio(f.fetch, { timeoutMs: 15, logger: log.logger }).send(PHONE, CODE),
    );
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((c) => (c.init.signal as AbortSignal).aborted)).toBe(true);
    expect(err.code).toBe('otp_delivery_failed');
    expect(log.entries.map((e) => e.obj.reason)).toEqual(['timeout', 'timeout']);
    expect(log.entries.at(-1)).toMatchObject({ level: 'error', obj: { willRetry: false } });
  });

  describe('plazo por defecto de 8 segundos', () => {
    afterEach(() => vi.useRealTimers());

    it('aborta a los 8 s exactos, no antes', async () => {
      vi.useFakeTimers();
      expect(OTP_REQUEST_TIMEOUT_MS).toBe(8_000);
      const f = fakeFetch(hang);
      const sender = new TwilioSmsSender(
        { accountSid: SID, authToken: TOKEN, from: '+18095550000' },
        { fetch: f.fetch, sleep: noSleep, logger: quiet() },
      );
      const outcome = rejection(sender.send(PHONE, CODE));

      await vi.advanceTimersByTimeAsync(7_999);
      expect((f.calls[0]!.init.signal as AbortSignal).aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((f.calls[0]!.init.signal as AbortSignal).aborted).toBe(true);

      // El reintento tiene su propio plazo de 8 s.
      await vi.advanceTimersByTimeAsync(7_999);
      expect(f.calls).toHaveLength(2);
      expect((f.calls[1]!.init.signal as AbortSignal).aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await outcome).code).toBe('otp_delivery_failed');
    });
  });

  it('un teléfono que no está en E.164 no llega al proveedor', async () => {
    const f = fakeFetch(json({}, 201));
    const log = recordingLogger();
    const err = await rejection(twilio(f.fetch, { logger: log.logger }).send('809-555-0123', CODE));
    expect(f.calls).toHaveLength(0);
    expect(err.code).toBe('otp_delivery_failed');
    expect(log.dump()).not.toContain('555-0123');
  });

  describe('lo que NO debe salir', () => {
    it('el código y el teléfono no aparecen en los logs ni en el error (el detalle sí se registra)', async () => {
      const f = fakeFetch(
        json(
          {
            code: 21211,
            // El proveedor puede repetir el teléfono en otros formatos (no solo el exacto que enviamos).
            message: `The 'To' number ${PHONE} is not valid (also (809) 555-0123, 809-555-0123, 8095550123). Body was "Tu código de JELLYFISH es ${CODE}". Auth ${TOKEN}`,
            more_info: 'https://www.twilio.com/docs/errors/21211',
            status: 400,
          },
          400,
        ),
      );
      const log = recordingLogger();
      const err = await rejection(twilio(f.fetch, { logger: log.logger }).send(PHONE, CODE));

      const everything = `${log.dump()}${err.message}${JSON.stringify(err.details ?? null)}${err.code}`;
      for (const secret of [
        CODE,
        PHONE,
        PHONE.slice(1),
        '8095550123',
        '555-0123',
        '(809)',
        TOKEN,
        SID,
      ]) {
        expect(everything, `contiene ${secret}`).not.toContain(secret);
      }
      // El error al cliente no filtra nada del proveedor.
      expect(err.message).not.toMatch(/Twilio|21211|valid|number/i);
      expect(JSON.stringify({ ...err })).not.toContain('21211');

      // Pero el log sí conserva lo útil para diagnosticar.
      expect(log.entries).toHaveLength(1);
      expect(log.entries[0]).toMatchObject({
        level: 'error',
        obj: {
          event: 'otp_send_failed',
          provider: 'twilio',
          httpStatus: 400,
          providerCode: 21211,
          willRetry: false,
          to: '+1809*****23',
        },
      });
      expect(String(log.entries[0]!.obj.providerMessage)).toContain('not valid');
    });

    it('tampoco en los errores de red ni en los reintentos', async () => {
      const f = fakeFetch(new TypeError(`fetch failed for ${PHONE} with ${CODE}`));
      const log = recordingLogger();
      const err = await rejection(twilio(f.fetch, { logger: log.logger }).send(PHONE, CODE));
      const everything = `${log.dump()}${err.message}`;
      expect(everything).not.toContain(CODE);
      expect(everything).not.toContain('8095550123');
      expect(log.entries).toHaveLength(2);
    });

    it('un cuerpo de error que no es JSON no rompe nada ni se filtra', async () => {
      const f = fakeFetch(
        new Response(`<html>Error para ${PHONE} código ${CODE}</html>`, { status: 500 }),
      );
      const log = recordingLogger();
      const err = await rejection(twilio(f.fetch, { logger: log.logger }).send(PHONE, CODE));
      expect(err.code).toBe('otp_delivery_failed');
      expect(log.dump()).not.toContain(CODE);
      expect(log.dump()).not.toContain('8095550123');
    });
  });
});

describe('WhatsAppCloudSender', () => {
  it('envía la plantilla de autenticación con el código en el cuerpo y en el botón', async () => {
    const f = fakeFetch(json({ messages: [{ id: 'wamid.1' }] }));
    await whatsapp(f.fetch).send(PHONE, CODE);

    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v21.0/109876543210/messages');
    expect(url).toBe(WHATSAPP_MESSAGES_URL('109876543210'));
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: PHONE,
      type: 'template',
      template: {
        name: 'jellyfish_otp',
        language: { code: 'es' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: CODE }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: CODE }],
          },
        ],
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('permite cambiar el idioma de la plantilla', async () => {
    const f = fakeFetch(json({}));
    await whatsapp(f.fetch, { language: 'es_MX' }).send(PHONE, CODE);
    expect(JSON.parse(f.calls[0]!.init.body as string).template.language).toEqual({
      code: 'es_MX',
    });
  });

  it('reintenta una vez ante 5xx o red caída, y no ante 4xx', async () => {
    const retried = fakeFetch(json({ error: { message: 'down' } }, 500), json({}));
    await whatsapp(retried.fetch).send(PHONE, CODE);
    expect(retried.calls).toHaveLength(2);

    const network = fakeFetch(new TypeError('fetch failed'), json({}));
    await whatsapp(network.fetch).send(PHONE, CODE);
    expect(network.calls).toHaveLength(2);

    const rejected = fakeFetch(
      json({ error: { code: 131030, message: 'not in allowed list' } }, 400),
    );
    expect((await rejection(whatsapp(rejected.fetch).send(PHONE, CODE))).code).toBe(
      'otp_delivery_failed',
    );
    expect(rejected.calls).toHaveLength(1);
  });

  it('corta la petición que no contesta', async () => {
    const f = fakeFetch(hang);
    const err = await rejection(whatsapp(f.fetch, { timeoutMs: 15 }).send(PHONE, CODE));
    expect(f.calls).toHaveLength(2);
    expect(err.code).toBe('otp_delivery_failed');
  });

  it('registra el detalle de Meta sin el código, el teléfono ni el token', async () => {
    const f = fakeFetch(
      json(
        {
          error: {
            message: `(#131030) Recipient phone number not in allowed list: ${PHONE} / ${CODE} / ${WA_TOKEN}`,
            type: 'OAuthException',
            code: 190,
            error_subcode: 463,
            fbtrace_id: 'AbCdEfGhIjKl',
          },
        },
        401,
      ),
    );
    const log = recordingLogger();
    const err = await rejection(whatsapp(f.fetch, { logger: log.logger }).send(PHONE, CODE));

    const everything = `${log.dump()}${err.message}`;
    for (const secret of [CODE, PHONE, '8095550123', WA_TOKEN]) {
      expect(everything, `contiene ${secret}`).not.toContain(secret);
    }
    expect(err.message).not.toMatch(/allowed|Recipient|190/);
    expect(log.entries[0]).toMatchObject({
      level: 'error',
      obj: {
        provider: 'whatsapp',
        httpStatus: 401,
        providerCode: '190/463',
        providerTrace: 'AbCdEfGhIjKl',
        to: '+1809*****23',
      },
    });
  });

  it('un "código de error" con formato raro no se copia al log (podría traer datos)', async () => {
    const f = fakeFetch(
      json({ error: { code: `invalid number ${PHONE} code ${CODE}`, message: 'x' } }, 400),
    );
    const log = recordingLogger();
    await rejection(whatsapp(f.fetch, { logger: log.logger }).send(PHONE, CODE));
    expect(log.entries[0]!.obj.providerCode).toBe('[formato inesperado]');
    expect(log.dump()).not.toContain(CODE);
    expect(log.dump()).not.toContain('8095550123');
  });
});

// Con `fetch` real y un servidor local: comprueba lo que el `fetch` falso no puede (que el
// AbortController corte de verdad un socket colgado, que no se sigan redirecciones y que lo que sale
// por el cable sea exactamente lo que documentan Twilio y Meta).
describe('con sockets reales (servidor local)', () => {
  interface Seen {
    method: string | undefined;
    url: string | undefined;
    headers: IncomingMessage['headers'];
    body: string;
  }

  const servers: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function localServer(handler: (req: Seen, res: ServerResponse, n: number) => void) {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        handler(seen.at(-1)!, res, seen.length);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const handle = {
      seen,
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
    servers.push(handle);
    return handle;
  }

  /** `fetch` real, pero con el host del proveedor cambiado por el servidor local. */
  const viaLocal =
    (providerHost: string, base: string): FetchLike =>
    (url, init) =>
      fetch(String(url).replace(providerHost, base), init);

  const created = (_req: Seen, res: ServerResponse) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end('{"sid":"SM1"}');
  };

  it('Twilio: lo que sale por el cable es el POST con Basic auth y formulario que documenta Twilio', async () => {
    const srv = await localServer(created);
    const sender = new TwilioSmsSender(
      { accountSid: SID, authToken: TOKEN, from: '+18095550000' },
      { fetch: viaLocal('https://api.twilio.com', srv.base), ttlMinutes: 5, logger: quiet() },
    );
    await sender.send(PHONE, CODE);

    expect(srv.seen).toHaveLength(1);
    const req = srv.seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(req.headers.authorization).toBe(
      `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({
      To: PHONE,
      From: '+18095550000',
      Body: 'Tu código de JELLYFISH es 482916. Vence en 5 minutos. No lo compartas con nadie.',
    });
  });

  it('WhatsApp: el JSON que sale por el cable lleva el código en el cuerpo y en el botón', async () => {
    const srv = await localServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"messages":[{"id":"wamid.1"}]}');
    });
    const sender = new WhatsAppCloudSender(
      { phoneNumberId: '109876543210', accessToken: WA_TOKEN, template: 'jellyfish_otp' },
      { fetch: viaLocal('https://graph.facebook.com', srv.base), logger: quiet() },
    );
    await sender.send(PHONE, CODE);

    const req = srv.seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v21.0/109876543210/messages');
    expect(req.headers.authorization).toBe(`Bearer ${WA_TOKEN}`);
    expect(req.headers['content-type']).toBe('application/json');
    const body = JSON.parse(req.body);
    expect(body.to).toBe(PHONE);
    expect(body.template.language).toEqual({ code: 'es' });
    const params = body.template.components.flatMap(
      (c: { parameters: { text: string }[] }) => c.parameters,
    );
    expect(params.map((p: { text: string }) => p.text)).toEqual([CODE, CODE]);
  });

  it('un 503 real se reintenta una vez y la segunda respuesta entrega el código', async () => {
    const srv = await localServer((req, res, n) => {
      if (n === 1) {
        res.writeHead(503);
        res.end('upstream caído');
      } else created(req, res);
    });
    const sender = new TwilioSmsSender(
      { accountSid: SID, authToken: TOKEN, from: '+18095550000' },
      {
        fetch: viaLocal('https://api.twilio.com', srv.base),
        sleep: noSleep,
        logger: quiet(),
      },
    );
    await sender.send(PHONE, CODE);
    expect(srv.seen).toHaveLength(2);
  });

  it('un servidor que no contesta se corta de verdad por plazo, con un solo reintento', async () => {
    const srv = await localServer(() => {
      /* nunca responde */
    });
    const sender = new TwilioSmsSender(
      { accountSid: SID, authToken: TOKEN, from: '+18095550000' },
      {
        fetch: viaLocal('https://api.twilio.com', srv.base),
        timeoutMs: 150,
        sleep: noSleep,
        logger: quiet(),
      },
    );
    const started = Date.now();
    const err = await rejection(sender.send(PHONE, CODE));
    const elapsed = Date.now() - started;

    expect(err.code).toBe('otp_delivery_failed');
    expect(srv.seen).toHaveLength(2);
    // Dos plazos completos de 150 ms (no se corta antes) y nada que se quede esperando.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('una redirección real no se sigue: las credenciales no viajan a otro destino', async () => {
    const elsewhere = await localServer(created);
    const srv = await localServer((_req, res) => {
      res.writeHead(307, { location: `${elsewhere.base}/robado` });
      res.end();
    });
    const sender = new TwilioSmsSender(
      { accountSid: SID, authToken: TOKEN, from: '+18095550000' },
      { fetch: viaLocal('https://api.twilio.com', srv.base), sleep: noSleep, logger: quiet() },
    );
    const err = await rejection(sender.send(PHONE, CODE));

    expect(err.code).toBe('otp_delivery_failed');
    expect(srv.seen).toHaveLength(1);
    expect(elsewhere.seen).toHaveLength(0);
  });
});

describe('createOtpSender', () => {
  const fullTwilio = {
    OTP_SENDER: 'twilio',
    TWILIO_ACCOUNT_SID: SID,
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_FROM: '+18095550000',
  };
  const fullWhatsapp = {
    OTP_SENDER: 'whatsapp',
    WHATSAPP_PHONE_NUMBER_ID: '109876543210',
    WHATSAPP_ACCESS_TOKEN: WA_TOKEN,
    WHATSAPP_OTP_TEMPLATE: 'jellyfish_otp',
  };

  it('sin OTP_SENDER usa consola en desarrollo y se niega a arrancar en producción', () => {
    expect(createOtpSender({})).toBeInstanceOf(ConsoleOtpSender);
    expect(createOtpSender({ OTP_SENDER: 'console' })).toBeInstanceOf(ConsoleOtpSender);
    expect(() => createOtpSender({ NODE_ENV: 'production' })).toThrow(
      /Producción requiere OTP_SENDER=twilio o OTP_SENDER=whatsapp/,
    );
  });

  it("'console' NO se permite en producción", () => {
    expect(() => createOtpSender({ NODE_ENV: 'production', OTP_SENDER: 'console' })).toThrow(
      /console no se permite en producción/,
    );
    expect(() => createOtpSender({ NODE_ENV: 'production', OTP_SENDER: ' CONSOLE ' })).toThrow(
      /no se permite en producción/,
    );
  });

  it('rechaza un canal desconocido', () => {
    expect(() => createOtpSender({ OTP_SENDER: 'sms' })).toThrow(
      /"sms" no es válido\. Usa console, twilio o whatsapp/,
    );
  });

  it('crea Twilio con las variables completas (en producción también) e ignora mayúsculas y espacios', () => {
    expect(createOtpSender({ ...fullTwilio, NODE_ENV: 'production' })).toBeInstanceOf(
      TwilioSmsSender,
    );
    expect(createOtpSender({ ...fullTwilio, OTP_SENDER: '  Twilio ' })).toBeInstanceOf(
      TwilioSmsSender,
    );
    const { TWILIO_FROM: _from, ...noFrom } = fullTwilio;
    expect(createOtpSender({ ...noFrom, TWILIO_MESSAGING_SERVICE_SID: MG })).toBeInstanceOf(
      TwilioSmsSender,
    );
  });

  it('Twilio: nombra cada variable que falta, en español, sin revelar valores', () => {
    let message = '';
    try {
      createOtpSender({ OTP_SENDER: 'twilio' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('OTP_SENDER=twilio');
    expect(message).toContain('falta TWILIO_ACCOUNT_SID');
    expect(message).toContain('falta TWILIO_AUTH_TOKEN');
    expect(message).toContain('falta TWILIO_FROM o TWILIO_MESSAGING_SERVICE_SID');

    expect(() => createOtpSender({ ...fullTwilio, TWILIO_AUTH_TOKEN: '  ' })).toThrow(
      /falta TWILIO_AUTH_TOKEN/,
    );
  });

  it('Twilio: valida el formato de SID y remitente sin imprimir el secreto', () => {
    let message = '';
    try {
      createOtpSender({
        ...fullTwilio,
        TWILIO_ACCOUNT_SID: 'XX123',
        TWILIO_AUTH_TOKEN: TOKEN,
        TWILIO_FROM: '809 555 0000',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/TWILIO_ACCOUNT_SID no es válido/);
    expect(message).toMatch(/TWILIO_FROM no es válido/);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('XX123');
    expect(() => createOtpSender({ ...fullTwilio, TWILIO_MESSAGING_SERVICE_SID: 'nope' })).toThrow(
      /TWILIO_MESSAGING_SERVICE_SID no es válido/,
    );
  });

  it('crea WhatsApp con las variables completas', () => {
    expect(createOtpSender({ ...fullWhatsapp, NODE_ENV: 'production' })).toBeInstanceOf(
      WhatsAppCloudSender,
    );
  });

  it('WhatsApp: nombra cada variable que falta o sea inválida', () => {
    let message = '';
    try {
      createOtpSender({ OTP_SENDER: 'whatsapp' });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of [
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_OTP_TEMPLATE',
    ]) {
      expect(message).toContain(`falta ${name}`);
    }
    expect(() =>
      createOtpSender({ ...fullWhatsapp, WHATSAPP_OTP_TEMPLATE: 'Mi Plantilla' }),
    ).toThrow(/WHATSAPP_OTP_TEMPLATE no es válido/);
    expect(() => createOtpSender({ ...fullWhatsapp, WHATSAPP_PHONE_NUMBER_ID: 'abc' })).toThrow(
      /WHATSAPP_PHONE_NUMBER_ID no es válido/,
    );
    expect(() => createOtpSender({ ...fullWhatsapp, WHATSAPP_OTP_LANGUAGE: 'Español' })).toThrow(
      /WHATSAPP_OTP_LANGUAGE no es válido/,
    );
  });

  it('el sender creado usa el fetch, la vigencia y el idioma que se le pasan', async () => {
    const a = fakeFetch(json({}, 201));
    await createOtpSender(fullTwilio, { fetch: a.fetch, ttlMinutes: 7, logger: quiet() }).send(
      PHONE,
      CODE,
    );
    expect(Object.fromEntries(new URLSearchParams(a.calls[0]!.init.body as string)).Body).toContain(
      'Vence en 7 minutos.',
    );

    const b = fakeFetch(json({}));
    await createOtpSender(
      { ...fullWhatsapp, WHATSAPP_OTP_LANGUAGE: 'es_MX' },
      { fetch: b.fetch },
    ).send(PHONE, CODE);
    expect(b.calls[0]!.url).toContain('/v21.0/109876543210/messages');
    expect(JSON.parse(b.calls[0]!.init.body as string).template.language.code).toBe('es_MX');
  });
});

describe('de punta a punta por la API', () => {
  let w: World;
  let app: FastifyInstance;
  const sms = fakeFetch(json({ sid: 'SM1' }, 201));
  const provider = { current: sms };

  beforeAll(async () => {
    // 5 y no 10: así se nota si algún sitio dejó la vigencia escrita a mano.
    w = await makeWorld({ otpTtlMinutes: 5 });
    const sender = new TwilioSmsSender(
      { accountSid: SID, authToken: TOKEN, from: '+18095550000' },
      {
        // Delega en `provider.current` para poder cambiar de respuesta entre pruebas.
        fetch: ((url, init) => provider.current.fetch(url, init)) as FetchLike,
        sleep: noSleep,
        logger: quiet(),
        ttlMinutes: w.config.otpTtlMinutes,
      },
    );
    app = await buildApp({ db: w.handle.db, config: w.config, otpSender: sender, now: w.ctx.now });
  });
  afterAll(async () => {
    await app.close();
    await w.close();
  });

  it('el SMS que recibe la persona trae un código que de verdad abre sesión', async () => {
    provider.current = fakeFetch(json({ sid: 'SM1' }, 201));
    const phone = '+18295559001';
    const req = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { phone },
    });
    expect(req.statusCode).toBe(200);
    expect(JSON.parse(req.body)).toMatchObject({
      phone,
      expiresInSeconds: 300,
    });

    const body = Object.fromEntries(
      new URLSearchParams(provider.current.calls[0]!.init.body as string),
    );
    expect(body.To).toBe(phone);
    const code = /es (\d{6})\./.exec(body.Body!)?.[1];
    expect(code).toBeDefined();
    expect(w.config.otpTtlMinutes).toBe(5);
    expect(body.Body).toContain('Vence en 5 minutos.');
    const [row] = await w.handle.db.select().from(otpCodes).where(eq(otpCodes.phone, phone));
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(5 * 60_000);

    const ver = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone, code },
    });
    expect(ver.statusCode).toBe(200);
    expect(JSON.parse(ver.body).user.phone).toBe(phone);
  });

  it('si el proveedor falla, la persona ve un 503 genérico sin nada del proveedor', async () => {
    provider.current = fakeFetch(
      json({ code: 21608, message: 'Permission to send an SMS has not been enabled' }, 400),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { phone: '+18295559002' },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: 'otp_delivery_failed',
        message: 'No pudimos enviar el código en este momento. Intenta de nuevo en unos minutos.',
      },
    });
    expect(res.body).not.toMatch(/21608|Permission|Twilio|SMS has/);
  });
});
