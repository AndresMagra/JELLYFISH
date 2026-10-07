import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
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

  it('las instrucciones están en español y dicen cómo entrar según el soporte de DEMO_OTP_CODE', () => {
    const base = { app: 'customer' as const, ip: '192.168.1.20', apiPort: 3000, expoPort: 8081 };
    const sin = instructions({ ...base, fixedCode: false });
    expect(sin).toContain('Cámara');
    expect(sin).toContain('Expo Go');
    expect(sin).toContain('exp://192.168.1.20:8081');
    expect(sin).toContain('aparece en ESTA consola');
    const con = instructions({ ...base, fixedCode: true });
    expect(con).toContain('siempre 123456');
    const driver = instructions({
      ...base,
      app: 'driver',
      fixedCode: true,
      driverPhone: '849-555-0177',
    });
    expect(driver).toContain('app del repartidor');
    expect(driver).toContain('849-555-0177');
  });
});
