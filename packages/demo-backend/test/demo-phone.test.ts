import { type Server, createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanMutants, expectKilledAsync, loadMutant } from './mutation-lib';
import {
  apiAcceptsFixedCode,
  classifyIp,
  findFreePort,
  instructions,
  isPortFree,
  lanCandidates,
  networkWarnings,
  pickLan,
  qrToText,
} from '../../../scripts/demo-phone';

const iface = (address: string, internal = false) => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`,
});

describe('demo:phone — qué IP usar', () => {
  it('clasifica las direcciones', () => {
    expect(classifyIp('192.168.1.20')).toBe('privada');
    expect(classifyIp('10.0.0.5')).toBe('privada');
    expect(classifyIp('172.20.1.2')).toBe('privada');
    expect(classifyIp('172.32.1.2')).toBe('publica');
    expect(classifyIp('169.254.10.1')).toBe('link-local');
    expect(classifyIp('100.100.1.1')).toBe('cgnat');
    expect(classifyIp('8.8.8.8')).toBe('publica');
  });

  it('prefiere el Wi‑Fi y deja Docker, VPN y máquinas virtuales para el final', () => {
    const list = lanCandidates({
      lo0: [iface('127.0.0.1', true)],
      docker0: [iface('172.17.0.1')],
      utun3: [iface('100.88.1.1')],
      en0: [iface('192.168.1.20')],
      vboxnet0: [iface('192.168.56.1')],
    });
    expect(list.map((c) => c.iface)).toEqual(['en0', 'vboxnet0', 'docker0', 'utun3']);
    expect(pickLan(list)?.address).toBe('192.168.1.20');
    expect(list.find((c) => c.iface === 'docker0')?.virtual).toBe(true);
  });

  it('ignora lo interno y lo que no es IPv4', () => {
    expect(lanCandidates({ lo: [iface('127.0.0.1', true)] })).toEqual([]);
    expect(pickLan([])).toBeNull();
  });

  it('--ip manda sobre la detección', () => {
    const list = lanCandidates({ en0: [iface('192.168.1.20')] });
    expect(pickLan(list, '10.1.2.3')?.address).toBe('10.1.2.3');
  });

  it('avisa de VPN, varias redes, interfaces virtuales y falta de red', () => {
    expect(networkWarnings(null, [])[0]).toMatch(/No encontré ninguna dirección/);
    const vpn = lanCandidates({ utun3: [iface('100.88.1.1')] });
    expect(networkWarnings(pickLan(vpn), vpn).join(' ')).toMatch(/VPN/);
    const two = lanCandidates({ en0: [iface('192.168.1.20')], en1: [iface('10.0.0.8')] });
    expect(networkWarnings(pickLan(two), two).join(' ')).toMatch(/varias redes activas/);
    const ll = lanCandidates({ en0: [iface('169.254.3.4')] });
    expect(networkWarnings(pickLan(ll), ll).join(' ')).toMatch(/no te dio dirección/);
    const clean = lanCandidates({ wlan0: [iface('192.168.0.9')] });
    expect(networkWarnings(pickLan(clean), clean)).toEqual([]);
  });
});

describe('demo:phone — puertos, QR e instrucciones', () => {
  it('busca el siguiente puerto libre cuando el preferido está ocupado', async () => {
    const busy = createServer();
    await new Promise<void>((ok) => busy.listen(0, '0.0.0.0', ok));
    const port = (busy.address() as { port: number }).port;
    expect(await isPortFree(port)).toBe(false);
    const next = await findFreePort(port);
    expect(next).toBeGreaterThan(port);
    expect(await isPortFree(next)).toBe(true);
    busy.close();
  });

  it('dibuja el código QR de la dirección de Expo', async () => {
    const qr = await qrToText('exp://192.168.1.20:8081');
    expect(qr).not.toBeNull();
    const rows = qr!.trimEnd().split('\n');
    expect(rows.length).toBeGreaterThan(10);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1); // rectángulo perfecto
  });

  it('las instrucciones están en español y dicen cómo entrar según el soporte del código fijo', () => {
    const base = { app: 'customer' as const, ip: '192.168.1.20', apiPort: 3000, expoPort: 8081 };
    const con = instructions(base); // lo normal: el API acepta DEMO_OTP_CODE
    expect(con).toContain('Cámara');
    expect(con).toContain('Expo Go');
    expect(con).toContain('exp://192.168.1.20:8081');
    expect(con).toContain('siempre 123456');
    expect(con).not.toContain('aparece en ESTA consola');
    const sin = instructions({ ...base, fixedCode: false });
    expect(sin).toContain('aparece en ESTA consola');
    expect(sin).not.toContain('es siempre 123456');
    const driver = instructions({ ...base, app: 'driver', driverPhone: '849-555-0177' });
    expect(driver).toContain('app del repartidor');
    expect(driver).toContain('849-555-0177');
    expect(instructions(base)).not.toContain('todavía no existe');
  });
});

describe('demo:phone — el código fijo se comprueba, no se supone', () => {
  const servers: Server[] = [];
  afterAll(() => {
    servers.forEach((s) => s.close());
    cleanMutants();
  });

  /** Un API de mentira: acepta (o no) el código 123456 y registra lo que le pidieron. */
  async function fakeApi(
    acceptCode: string | null,
    opts: { requestStatus?: number; noToken?: boolean } = {},
  ) {
    const seen: { path: string; body: { phone?: string; code?: string } }[] = [];
    const server = createHttpServer((req, res) => {
      let raw = '';
      req.on('data', (d: Buffer) => (raw += d.toString()));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as { phone?: string; code?: string }) : {};
        seen.push({ path: req.url ?? '', body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/auth/otp/request') {
          res.statusCode = opts.requestStatus ?? 200;
          res.end('{}');
        } else if (req.url === '/v1/auth/otp/verify') {
          const ok = acceptCode !== null && body.code === acceptCode;
          res.statusCode = ok ? 200 : 400;
          res.end(
            JSON.stringify(
              ok ? (opts.noToken ? {} : { token: 'jwt' }) : { error: { code: 'invalid_code' } },
            ),
          );
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    servers.push(server);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
  }

  async function suite(api: {
    apiAcceptsFixedCode: typeof apiAcceptsFixedCode;
    instructions: typeof instructions;
  }) {
    const ok = await fakeApi('123456');
    expect(await api.apiAcceptsFixedCode(ok.url)).toBe(true);
    expect(ok.seen.map((x) => x.path)).toEqual(['/v1/auth/otp/request', '/v1/auth/otp/verify']);
    expect(ok.seen[1]!.body).toEqual({ phone: '+18095550199', code: '123456' });
    expect(await api.apiAcceptsFixedCode((await fakeApi('999999')).url)).toBe(false); // código aleatorio: no lo acepta
    expect(
      await api.apiAcceptsFixedCode((await fakeApi('123456', { requestStatus: 500 })).url),
    ).toBe(false);
    expect(await api.apiAcceptsFixedCode((await fakeApi('123456', { noToken: true })).url)).toBe(
      false,
    );
    expect(await api.apiAcceptsFixedCode('http://127.0.0.1:1')).toBe(false); // nadie escucha
    const base = { app: 'customer' as const, ip: '192.168.1.20', apiPort: 3000, expoPort: 8081 };
    expect(api.instructions(base)).toContain('siempre 123456');
    expect(api.instructions({ ...base, fixedCode: false })).toContain('aparece en ESTA consola');
  }

  it('entra con 123456 y con un teléfono de prueba; si el API no lo acepta, no se promete', () =>
    suite({ apiAcceptsFixedCode, instructions }));

  it('detecta mutaciones (prometer el código fijo sin comprobarlo)', async () => {
    const file = new URL('../../../scripts/demo-phone.ts', import.meta.url).pathname;
    type Api = Parameters<typeof suite>[0];
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      [
        'el código que se prueba no es 123456',
        [["const DEMO_CODE = '123456';", "const DEMO_CODE = '000000';"]],
      ],
      [
        'se acepta una respuesta sin token',
        [["typeof ((await res.json()) as { token?: unknown }).token === 'string'", 'true']],
      ],
      [
        'si el API falla, igual se promete',
        [
          [
            '  } catch {\n    return false;\n  }\n}\n\n/** Con la app del repartidor',
            '  } catch {\n    return true;\n  }\n}\n\n/** Con la app del repartidor',
          ],
        ],
      ],
      ['las instrucciones ignoran que el código fijo falló', [['o.fixedCode === false', 'false']]],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<Api>(file, edits);
      await expectKilledAsync(name, () => suite(mutant));
    }
  });
});
