/**
 * Para quien SÍ tiene una computadora: levanta TODO lo necesario para abrir la app en tu iPhone o
 * Android por la red de tu casa, con datos de ejemplo.
 *
 *   npm run demo:phone                      → app del cliente
 *   npm run demo:phone -- --app driver      → app del repartidor
 *   npm run demo:phone -- --check           → solo revisa tu red (IP y firewall) y sale
 *   opciones: --ip 192.168.1.20  --api-port 3000  --expo-port 8081  --admin-phone 809-555-0100  --driver-phone 849-555-0177
 *
 * Qué hace: detecta la IP de tu red local (LAN), arranca el API en modo demo con catálogo de
 * ejemplo (JELLYFISH_DEMO=1, JELLYFISH_SEED=1, PAYMENTS_MOCK=1, PUBLIC_API_URL=http://<ip>:<puerto>) y
 * con DEMO_OTP_CODE=123456 (el código de entrada es siempre ese: no hace falta mirar la consola),
 * espera /health, comprueba que el código fijo funciona, arranca Expo (expo start --go --lan) con EXPO_PUBLIC_API_URL apuntando a esa IP,
 * te dice cómo escanear el QR y, al salir (Ctrl+C), apaga todo (grupos de procesos).
 *
 * El teléfono y la computadora deben estar en el MISMO Wi‑Fi.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces, platform } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const DEMO_CODE = '123456';

// ───────────────────────── red: qué IP usar ─────────────────────────

export interface LanCandidate {
  iface: string;
  address: string;
  kind: 'privada' | 'link-local' | 'cgnat' | 'publica';
  /** Interfaces que casi nunca son el Wi‑Fi/Ethernet (Docker, VPN, máquinas virtuales). */
  virtual: boolean;
  score: number;
}

/** Clasifica una dirección IPv4. */
export function classifyIp(ip: string): LanCandidate['kind'] {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  if (a === 169 && b === 254) return 'link-local'; // sin DHCP: no sirve para el teléfono
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'; // Tailscale/CGNAT: el teléfono no suele alcanzarla
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'privada';
  return 'publica';
}

const VIRTUAL_IFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|vEthernet|utun|tun|tap|ppp|wg|tailscale|zt|lo|awdl|llw|bridge|anpi|gif|stf)/i;

/** Ordena las direcciones locales: Wi‑Fi/Ethernet privadas primero; Docker, VPN y similares al final. */
export function lanCandidates(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): LanCandidate[] {
  const out: LanCandidate[] = [];
  for (const [iface, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const kind = classifyIp(info.address);
      const virtual = VIRTUAL_IFACE.test(iface);
      let score = 0;
      if (kind === 'privada') score += 100;
      if (kind === 'cgnat') score += 20;
      if (kind === 'publica') score += 10;
      if (!virtual) score += 50;
      if (/^(en0|wlan|wlp|wl|wi-?fi|eth|enp|eno|ethernet)/i.test(iface)) score += 20;
      if (/^192\.168\./.test(info.address)) score += 5;
      out.push({ iface, address: info.address, kind, virtual, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export function pickLan(candidates: LanCandidate[], forced?: string): LanCandidate | null {
  if (forced) {
    return (
      candidates.find((c) => c.address === forced) ?? {
        iface: '(indicada)',
        address: forced,
        kind: classifyIp(forced),
        virtual: false,
        score: 0,
      }
    );
  }
  return candidates.find((c) => c.kind === 'privada' && !c.virtual) ?? candidates[0] ?? null;
}

/** Avisos sobre la IP elegida (VPN, red de invitados, sin Wi‑Fi…). Lista vacía = nada raro. */
export function networkWarnings(chosen: LanCandidate | null, all: LanCandidate[]): string[] {
  const w: string[] = [];
  if (!chosen) {
    w.push(
      'No encontré ninguna dirección de red local. Conéctate a tu Wi‑Fi (o por cable) y vuelve a intentar, o indica la IP con --ip.',
    );
    return w;
  }
  if (chosen.kind === 'link-local')
    w.push(
      `La IP ${chosen.address} (169.254.x.x) significa que tu red no te dio dirección: revisa el Wi‑Fi o el cable.`,
    );
  if (chosen.kind === 'cgnat')
    w.push(
      `La IP ${chosen.address} parece de una VPN (Tailscale u otra). Tu teléfono probablemente no la alcance: usa la IP de tu Wi‑Fi con --ip.`,
    );
  if (chosen.kind === 'publica')
    w.push(
      `La IP ${chosen.address} no es de una red doméstica. Si el teléfono no conecta, indica la IP de tu Wi‑Fi con --ip.`,
    );
  if (chosen.virtual)
    w.push(
      `Se eligió la interfaz "${chosen.iface}", que parece virtual (Docker, VPN o máquina virtual). Si falla, usa --ip con la IP de tu Wi‑Fi.`,
    );
  const others = all.filter(
    (c) => c.address !== chosen.address && c.kind === 'privada' && !c.virtual,
  );
  if (others.length > 0) {
    w.push(
      `Tienes varias redes activas (${[chosen, ...others].map((c) => `${c.iface} ${c.address}`).join(', ')}). Usé ${chosen.address}; si el teléfono está en otra, pásala con --ip.`,
    );
  }
  if (
    chosen.kind === 'privada' &&
    /^10\.(?!0\.0\.)/.test(chosen.address) &&
    /^(utun|tun|ppp)/i.test(chosen.iface)
  ) {
    w.push('Parece que estás conectado a una VPN: desconéctala mientras pruebas.');
  }
  return w;
}

/** Revisa el firewall del sistema (mejor esfuerzo; nunca falla). Devuelve un aviso o null. */
export function firewallHint(ports: number[], os: NodeJS.Platform = platform()): string | null {
  const list = ports.join(' y ');
  const run = (cmd: string, args: string[]) => {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 4000 });
      return r.status === 0 ? `${r.stdout}${r.stderr}` : null;
    } catch {
      return null;
    }
  };
  if (os === 'darwin') {
    const out = run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']);
    if (out && /enabled|State = [12]/i.test(out)) {
      return `El firewall de macOS está activo. Cuando aparezca "¿Quieres que node acepte conexiones entrantes?", toca "Permitir". (Ajustes del Sistema → Red → Firewall.)`;
    }
    return null;
  }
  if (os === 'win32') {
    const out = run('netsh', ['advfirewall', 'show', 'currentprofile', 'state']);
    if (out && /\b(ON|activad)/i.test(out)) {
      return `El Firewall de Windows está activo. Si aparece "Windows Defender permitió algunas funciones de node", marca "Redes privadas" y toca "Permitir acceso". Si no aparece, permite los puertos ${list} (TCP) en redes privadas.`;
    }
    return null;
  }
  const ufw = run('ufw', ['status']);
  if (ufw && /Status: active/i.test(ufw))
    return `ufw está activo. Permite los puertos:  sudo ufw allow ${ports.join('/tcp && sudo ufw allow ')}/tcp`;
  const fw = run('firewall-cmd', ['--state']);
  if (fw && /running/i.test(fw))
    return `firewalld está activo. Permite los puertos ${list} (TCP) en la zona de tu Wi‑Fi.`;
  return null;
}

// ───────────────────────── puertos y procesos ─────────────────────────

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(port, '0.0.0.0', () => s.close(() => ok(true)));
  });
}

export async function findFreePort(preferred: number, avoid: number[] = []): Promise<number> {
  for (let p = preferred; p < preferred + 200; p++) {
    if (avoid.includes(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No encontré un puerto libre cerca de ${preferred}.`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Código QR en la consola con medios bloques (el mismo dibujo que usa Expo). Expo solo lo imprime en
 * una terminal interactiva; como aquí su salida va por un pipe, lo dibujamos nosotros con `toqr`
 * (el codificador que ya trae Expo). Si no se puede, devuelve null y se muestra solo la dirección.
 */
export async function qrToText(url: string): Promise<string | null> {
  try {
    const { toQR } = (await import('toqr')) as { toQR: (text: string) => Uint8Array };
    const data = toQR(url);
    const extent = Math.sqrt(data.byteLength) | 0;
    const FULL = '\u2588';
    const LOW = '\u2584';
    const HIGH = '\u2580';
    let out = LOW.repeat(extent + 2);
    for (let row = 0; row < extent; row += 2) {
      out += `\n${FULL}`;
      for (let col = 0; col < extent; col++) {
        const v = ((data[row * extent + col] ?? 0) << 1) | (data[(row + 1) * extent + col] ?? 0);
        out += v === 0 ? FULL : v === 1 ? HIGH : v === 2 ? LOW : ' ';
      }
      out += FULL;
    }
    if (extent % 2 === 0) out += `\n${HIGH.repeat(extent + 2)}`;
    return `${out}\n`;
  } catch {
    return null;
  }
}

async function waitFor(
  url: string,
  what: string,
  isUp: (res: Response, text: string) => boolean,
  tries = 120,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (isUp(res, text)) return;
    } catch {
      /* aún no */
    }
    await sleep(1000);
  }
  throw new Error(`${what} no respondió en ${url}`);
}

interface Managed {
  name: string;
  child: ChildProcess;
  output: { text: string };
}

const managed: Managed[] = [];

/** Arranca un proceso en su propio grupo (así se apaga con todos sus hijos) y reenvía su salida. */
function launch(
  name: string,
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: { prefix?: string; highlight?: RegExp } = {},
): Managed {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const m: Managed = { name, child, output: { text: '' } };
  const forward = (data: Buffer) => {
    const text = data.toString();
    m.output.text += text;
    if (m.output.text.length > 200_000) m.output.text = m.output.text.slice(-100_000);
    for (const line of text.split(/\r?\n/)) {
      if (line === '' && text.length > 1) continue;
      const mark = opts.highlight?.test(line) ? '★ ' : '';
      process.stdout.write(`${opts.prefix ?? ''}${mark}${line}\n`);
    }
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  managed.push(m);
  return m;
}

let shuttingDown = false;
/** Apaga todo lo que se lanzó: primero con SIGTERM al grupo y, si alguien se resiste, con SIGKILL. */
export async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const alive = managed.filter(
    (m) => m.child.pid && m.child.exitCode === null && m.child.signalCode === null,
  );
  for (const m of alive) {
    try {
      process.kill(-m.child.pid!, 'SIGTERM');
    } catch {
      /* ya terminó */
    }
  }
  for (
    let i = 0;
    i < 30 && alive.some((m) => m.child.exitCode === null && m.child.signalCode === null);
    i++
  )
    await sleep(100);
  for (const m of alive) {
    if (m.child.exitCode === null && m.child.signalCode === null) {
      try {
        process.kill(-m.child.pid!, 'SIGKILL');
      } catch {
        /* nada */
      }
    }
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 100);
}

// ───────────────────────── principal ─────────────────────────

async function otpFromLog(out: { text: string }, phoneE164: string): Promise<string> {
  const re = new RegExp(`Código para ${phoneE164.replace('+', '\\+')}: (\\d{6})`, 'g');
  for (let i = 0; i < 40; i++) {
    const m = [...out.text.matchAll(re)].pop();
    if (m) return m[1]!;
    await sleep(300);
  }
  throw new Error(`No apareció el código de ${phoneE164} en la consola del API`);
}

const e164 = (phone: string) => `+1${phone.replace(/\D/g, '').slice(-10)}`;

/**
 * ¿El API arrancado acepta el código fijo? Se prueba con un teléfono de prueba (crea esa cuenta de ejemplo):
 * pide el código y entra con 123456. Así las instrucciones nunca prometen algo que no pasa.
 */
export async function apiAcceptsFixedCode(api: string, phone = '+18095550199'): Promise<boolean> {
  try {
    const post = (path: string, body: object) =>
      fetch(`${api}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    const req = await post('/v1/auth/otp/request', { phone });
    if (!req.ok) return false;
    const res = await post('/v1/auth/otp/verify', { phone, code: DEMO_CODE });
    if (!res.ok) return false;
    return typeof ((await res.json()) as { token?: unknown }).token === 'string';
  } catch {
    return false;
  }
}

/** Con la app del repartidor hace falta una cuenta de repartidor: la crea un administrador por la API. */
async function prepareDriver(
  api: string,
  apiOut: { text: string },
  adminPhone: string,
  driverPhone: string,
  apiHasFixedCode: boolean,
): Promise<void> {
  const login = async (phone: string): Promise<string> => {
    await fetch(`${api}/v1/auth/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: e164(phone) }),
    });
    const code = apiHasFixedCode ? DEMO_CODE : await otpFromLog(apiOut, e164(phone));
    const res = await fetch(`${api}/v1/auth/otp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: e164(phone), code }),
    });
    return ((await res.json()) as { token: string }).token;
  };
  const token = await login(adminPhone);
  const res = await fetch(`${api}/v1/admin/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      phone: e164(driverPhone),
      name: 'Repartidor de prueba',
      role: 'driver',
    }),
  });
  if (!res.ok) throw new Error(`No pude crear el repartidor de prueba (${res.status})`);
}

export function instructions(o: {
  app: 'customer' | 'driver';
  ip: string;
  apiPort: number;
  expoPort: number;
  /** El API aceptó el código fijo (JELLYFISH_DEMO=1 + DEMO_OTP_CODE). Si no, el código sale en esta consola. */
  fixedCode?: boolean;
  driverPhone?: string;
}): string {
  const name = o.app === 'driver' ? 'repartidor' : 'cliente';
  const code =
    o.fixedCode === false
      ? `Para entrar, el código de verificación aparece en ESTA consola (busca la línea marcada con ★ "Código para +1809…"): el API no aceptó el código fijo ${DEMO_CODE}.`
      : `Para entrar, el código de verificación es siempre ${DEMO_CODE} (cualquier celular dominicano sirve; no llega ningún SMS).`;
  return `
══════════════════════════════════════════════════════════════════
  JELLYFISH · app del ${name} en tu teléfono
══════════════════════════════════════════════════════════════════
  1. Pon el teléfono en el MISMO Wi‑Fi que esta computadora (sin VPN ni "red de invitados").
  2. Instala "Expo Go":
       iPhone  → App Store → busca "Expo Go"
       Android → Google Play → busca "Expo Go"
  3. Escanea el código QR de arriba (si no lo ves, sube en esta consola):
       iPhone  → abre la app Cámara, apunta al QR y toca "Abrir en Expo Go"
       Android → abre Expo Go → "Scan QR code"
     ¿No funciona el QR? En Expo Go escribe:  exp://${o.ip}:${o.expoPort}
  4. ${code}${o.app === 'driver' ? `\n     Cuenta de repartidor de prueba: ${o.driverPhone}` : ''}
  5. Datos de ejemplo: nada es real; los pagos con tarjeta son simulados.

  El API de ejemplo está en  http://${o.ip}:${o.apiPort}   (prueba abrir  http://${o.ip}:${o.apiPort}/health  en el navegador del teléfono)
  ¿Se queda cargando? Casi siempre es el firewall de la computadora o que el teléfono está en otra red.
  Para apagar todo: Ctrl+C.
══════════════════════════════════════════════════════════════════
`;
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      app: { type: 'string', default: 'customer' },
      ip: { type: 'string' },
      'api-port': { type: 'string', default: process.env.API_PORT ?? '3000' },
      'expo-port': { type: 'string', default: process.env.EXPO_PORT ?? '8081' },
      'admin-phone': { type: 'string', default: '809-555-0100' },
      'driver-phone': { type: 'string', default: '849-555-0177' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (a.help) {
    console.log(
      readFileSync(import.meta.filename, 'utf8')
        .split('*/')[0]!
        .replace(/^\/\*\*\n|^ \* ?/gm, ''),
    );
    return;
  }
  const app = a.app === 'driver' ? 'driver' : 'customer';
  if (a.app !== 'customer' && a.app !== 'driver')
    throw new Error('--app debe ser "customer" o "driver"');
  const appDir = `${root}/apps/${app}`;
  if (!existsSync(appDir)) throw new Error(`No existe ${appDir}`);

  // 1) Red
  const all = lanCandidates();
  const lan = pickLan(all, a.ip);
  const warnings = networkWarnings(lan, all);
  if (!lan) {
    for (const w of warnings) console.error(`✖ ${w}`);
    process.exitCode = 1;
    return;
  }
  const apiPort = await findFreePort(Number(a['api-port']));
  const expoPort = await findFreePort(Number(a['expo-port']), [apiPort]);
  console.log(
    `• IP de tu red: ${lan.address} (${lan.iface}). Puertos: API ${apiPort}, Expo ${expoPort}.`,
  );
  for (const w of warnings) console.log(`⚠ ${w}`);
  const fw = firewallHint([apiPort, expoPort]);
  if (fw) console.log(`⚠ ${fw}`);
  if (a.check) {
    console.log(
      all.length
        ? `• Direcciones encontradas:\n${all.map((c) => `    ${c.address}  ${c.iface}  (${c.kind}${c.virtual ? ', virtual' : ''})`).join('\n')}`
        : '',
    );
    return;
  }

  // 2) API en modo demo (JELLYFISH_DEMO=1 + DEMO_OTP_CODE: el código de entrada es siempre 123456)
  const apiUrl = `http://${lan.address}:${apiPort}`;
  console.log(`• Arrancando el API de ejemplo en ${apiUrl} …`);
  const api = launch(
    'api',
    'npx',
    ['tsx', 'apps/api/src/server.ts'],
    root,
    {
      JELLYFISH_DEMO: '1',
      JELLYFISH_SEED: '1',
      PAYMENTS_MOCK: '1',
      PORT: String(apiPort),
      PUBLIC_API_URL: apiUrl,
      DEMO_OTP_CODE: DEMO_CODE,
      ...(app === 'driver' ? { BOOTSTRAP_ADMIN_PHONE: a['admin-phone']! } : {}),
      TRANSFER_BANK: 'Banco de Pruebas',
      TRANSFER_ACCOUNT_NUMBER: '000-000000-0',
      TRANSFER_HOLDER: 'JELLYFISH SRL (PRUEBA)',
      TRANSFER_RNC: '000-00000-0',
    },
    { prefix: '[api] ', highlight: /Código para \+?\d+/ },
  );
  api.child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`✖ El API se detuvo (código ${code}). Revisa los mensajes de arriba.`);
      void shutdown(1);
    }
  });
  await waitFor(`http://127.0.0.1:${apiPort}/health`, 'El API', (r) => r.ok);
  console.log('✔ API listo (/health responde).');
  const fixedCode = await apiAcceptsFixedCode(`http://127.0.0.1:${apiPort}`);
  console.log(
    fixedCode
      ? `✔ El código de entrada es siempre ${DEMO_CODE} (no hace falta mirar esta consola).`
      : `⚠ El API no aceptó el código fijo ${DEMO_CODE}: el código de cada entrada sale en esta consola (línea con ★).`,
  );

  // ¿Se alcanza por la IP de la red? Si no, casi seguro es el firewall.
  try {
    const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(String(res.status));
    console.log(`✔ El API también responde por ${lan.address}: el teléfono podrá alcanzarlo.`);
  } catch {
    console.log(
      `⚠ El API NO responde por ${lan.address}:${apiPort} desde esta misma computadora. Probablemente un firewall lo bloquea; el teléfono tampoco podrá conectarse hasta que lo permitas.`,
    );
  }

  if (app === 'driver') {
    try {
      await prepareDriver(
        apiUrl.replace(lan.address, '127.0.0.1'),
        api.output,
        a['admin-phone']!,
        a['driver-phone']!,
        fixedCode,
      );
      console.log(`✔ Cuenta de repartidor de prueba lista: ${a['driver-phone']}`);
    } catch (e) {
      console.log(
        `⚠ No pude preparar la cuenta de repartidor: ${(e as Error).message}. Pide a un administrador que la cree (panel → equipo).`,
      );
    }
  }

  // 3) Expo
  console.log(`• Arrancando Expo (app del ${app === 'driver' ? 'repartidor' : 'cliente'}) …`);
  const expo = launch(
    'expo',
    'npx',
    ['expo', 'start', '--go', '--lan', '--port', String(expoPort)],
    appDir,
    {
      EXPO_PUBLIC_API_URL: apiUrl,
      REACT_NATIVE_PACKAGER_HOSTNAME: lan.address,
      EXPO_NO_TELEMETRY: '1',
      EXPO_OFFLINE: '1',
    },
    { prefix: '' },
  );
  expo.child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`✖ Expo se detuvo (código ${code}). Revisa los mensajes de arriba.`);
      void shutdown(1);
    }
  });
  await waitFor(`http://127.0.0.1:${expoPort}/status`, 'Expo', (_r, t) =>
    /packager-status:running/.test(t),
  );
  console.log(`✔ Expo listo en el puerto ${expoPort}.`);
  const expoUrl = `exp://${lan.address}:${expoPort}`;
  const qr = await qrToText(expoUrl);
  console.log(`\n  Escanea este código con el teléfono  (${expoUrl})\n`);
  if (qr) console.log(qr);
  console.log(
    instructions({
      app,
      ip: lan.address,
      apiPort,
      expoPort,
      fixedCode,
      driverPhone: a['driver-phone'],
    }),
  );

  // Se queda corriendo hasta Ctrl+C.
  await new Promise(() => {});
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    console.log('\n• Apagando todo…');
    void shutdown(0);
  });
}
process.on('exit', () => {
  // Último recurso: si el proceso termina por otra vía, no dejar hijos vivos.
  for (const m of managed) {
    try {
      if (m.child.pid && m.child.exitCode === null) process.kill(-m.child.pid, 'SIGTERM');
    } catch {
      /* ya terminó */
    }
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`\n✖ ${e instanceof Error ? e.message : e}\n`);
    void shutdown(1);
  });
}
