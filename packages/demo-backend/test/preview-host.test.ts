import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as host from '../../../scripts/preview-host';
import { renderFragment, renderIndexHtml } from '../../../scripts/preview-shell';
import { cleanMutants, expectKilledAsync, loadMutant } from './mutation-lib';

type Api = typeof host;
const OPTS = { buildId: 'abc', files: { data: 'js/d.js', demo: 'js/s.js', app: 'js/a.js' } };
let dist = '';

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'jf-host-'));
  mkdirSync(join(dist, 'js'));
  mkdirSync(join(dist, 'photos'));
  writeFileSync(join(dist, 'artifact.html'), renderFragment(OPTS));
  writeFileSync(join(dist, 'index.html'), renderIndexHtml(OPTS));
  writeFileSync(join(dist, 'js/a.js'), 'window.a=1');
  writeFileSync(join(dist, 'photos/JF-X-001.thumb.webp'), 'webp');
  writeFileSync(join(dist, 'secret.txt'), 'no se publica');
  writeFileSync(
    join(dist, 'publish-files.json'),
    JSON.stringify({ files: { 'js/a.js': `${dist}/js/a.js`, 'photos/JF-X-001.thumb.webp': `${dist}/photos/JF-X-001.thumb.webp` } }),
  );
});
afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  cleanMutants();
});

const get = async (origin: string, path: string, accept = '*/*') => {
  const r = await fetch(`${origin}${path}`, { headers: { accept } });
  return { status: r.status, type: r.headers.get('content-type') ?? '', csp: r.headers.get('content-security-policy'), text: await r.text() };
};

async function hostSuite(api: Api): Promise<void> {
  const h = await api.startHost({
    dist,
    port: 4600,
    mounts: [
      { name: 'xyz', page: '/x/y/z/', filesDir: '/x/y/z/', mode: 'host' },
      { name: 'vista', page: '/vista/', filesDir: '/vista/', mode: 'index' },
      { name: 'espacio', page: '/mi vista/', filesDir: '/mi vista/', mode: 'host' },
    ],
  });
  try {
    // La página se envuelve como la plataforma: doctype, viewport-fit=cover y su reset.
    const page = await get(h.origin, '/x/y/z/', 'text/html');
    expect(page.status).toBe(200);
    expect(page.type).toMatch(/text\/html/);
    expect(page.text.startsWith('<!doctype html>')).toBe(true);
    expect(page.text).toContain('viewport-fit=cover');
    expect(page.text).toContain('<title>JELLYFISH</title>');
    // Con la política estricta: solo archivos propios, data: y blob:.
    expect(page.csp).toContain("default-src 'none'");
    for (const d of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src']) expect(page.csp).toMatch(new RegExp(`${d} [^;]*'self'`));
    expect(page.csp).not.toMatch(/https?:|\*/);
    expect(page.csp).not.toContain("'unsafe-eval'");
    // El index.html completo se sirve tal cual, sin envolver.
    const full = await get(h.origin, '/vista/', 'text/html');
    expect(full.text.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(full.text).not.toContain('<!doctype html>');
    // Archivos adjuntos: solo los del mapa de publicación, bajo la carpeta de su ruta.
    expect((await get(h.origin, '/x/y/z/js/a.js')).status).toBe(200);
    expect((await get(h.origin, '/x/y/z/js/a.js')).type).toMatch(/javascript/);
    expect((await get(h.origin, '/x/y/z/photos/JF-X-001.thumb.webp')).type).toBe('image/webp');
    // Lo que NO se publica no se sirve aunque exista en disco (el visor tampoco lo tendría).
    for (const p of ['/x/y/z/secret.txt', '/x/y/z/publish-files.json', '/x/y/z/artifact.html', '/x/y/z/index.html', '/x/y/z/js/', '/x/y/z/js/no-existe.js'])
      expect((await get(h.origin, p)).status, p).toBe(404);
    // La carpeta equivocada no sirve nada: nada de "devolver index.html por si acaso".
    expect((await get(h.origin, '/js/a.js')).status).toBe(404);
    expect((await get(h.origin, '/x/js/a.js')).status).toBe(404);
    expect((await get(h.origin, '/q/w/e/js/a.js')).status).toBe(404); // otra carpeta con el mismo largo
    expect((await get(h.origin, '/x/y/z/product/camaron', 'text/html')).status).toBe(404);
    // Salirse de la carpeta tampoco.
    expect((await get(h.origin, '/x/y/z/..%2f..%2fsecret.txt')).status).toBe(404);
    expect((await get(h.origin, '/x/y/z/%2e%2e/secret.txt')).status).toBe(404);
    // Una carpeta con espacio llega codificada y se atiende por su nombre real.
    expect((await get(h.origin, '/mi%20vista/', 'text/html')).status).toBe(200);
    expect((await get(h.origin, '/mi%20vista/js/a.js')).status).toBe(200);
    // Se anota cada petición.
    expect(h.requests.some((r) => r.url === '/x/y/z/js/a.js' && r.status === 200)).toBe(true);
    expect(h.requests.some((r) => r.url === '/x/y/z/secret.txt' && r.status === 404)).toBe(true);
  } finally {
    await h.close();
  }

  // Con "SPA fallback" (opcional): una pantalla interna devuelve la página, solo si se pide y solo a quien lo pide en HTML.
  const fb = await api.startHost({ dist, port: 4620, mounts: [{ name: 'xyz', page: '/x/y/z/', filesDir: '/x/y/z/', mode: 'host' }], fallback: ['xyz'] });
  try {
    expect((await get(fb.origin, '/x/y/z/product/camaron', 'text/html')).text).toContain('<title>JELLYFISH</title>');
    expect((await get(fb.origin, '/x/y/z/product/camaron', '*/*')).status).toBe(404);
    expect((await get(fb.origin, '/x/y/z/js/no-existe.js', '*/*')).status).toBe(404);
  } finally {
    await fb.close();
  }

  // La política se puede quitar (para probar que SÍ se detecta una violación).
  const open = await api.startHost({ dist, port: 4640, mounts: [{ name: 'r', page: '/', filesDir: '/', mode: 'host' }], csp: null });
  try {
    expect((await get(open.origin, '/', 'text/html')).csp).toBeNull();
  } finally {
    await open.close();
  }
}

describe('alojamiento de prueba estricto', () => {
  it('envuelve la página como el visor, solo sirve lo publicado y manda la política de seguridad estricta', () => hostSuite(host));

  it('las rutas bajo las que se verifica cubren raíz, /x/, /x/y/z/, index.html, artifact.html y una carpeta con espacio', () => {
    const pages = host.MOUNTS.map((m) => m.page);
    for (const want of ['/', '/x/', '/x/y/z/', '/index.html', '/artifact.html', '/x/index.html', '/x/y/z/index.html', '/x/y/z/artifact.html', '/mi vista/'])
      expect(pages, want).toContain(want);
    expect(new Set(host.MOUNTS.map((m) => m.name)).size).toBe(host.MOUNTS.length);
    // Cada ruta con archivo explícito guarda sus archivos en su carpeta.
    for (const m of host.MOUNTS) {
      if (m.mode === 'host' && /\.html$/.test(m.page)) expect(m.filesDir).toBe(m.page.replace(/[^/]*$/, ''));
    }
  });

  it('la política que se manda no permite ningún servidor externo, ni hojas de Google Fonts', () => {
    expect(host.HOST_CSP).not.toMatch(/https?:\/\/|\*|googleapis|gstatic/);
    expect(host.HOST_CSP).toContain("frame-src 'none'");
    expect(host.HOST_CSP).toContain("connect-src 'self' data: blob:");
    expect(host.HOST_CSP).toContain("img-src 'self' data: blob:");
  });

  it('detecta mutaciones del alojamiento (sirve lo no publicado, sin política, sin envolver)', async () => {
    const file = new URL('../../../scripts/preview-host.ts', import.meta.url).pathname;
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      ['sirve archivos que no están en el mapa de publicación', [['if (allowed.has(rel)) {', 'if (true) {']]],
      ['devuelve la página para cualquier ruta', [["const wantsHtml = (req.headers.accept ?? '').includes('text/html');", 'const wantsHtml = true;']]],
      ['no manda la política de seguridad', [["...(csp && withCsp ? { 'content-security-policy': csp } : {}),", '']]],
      ['la política permite scripts de cualquier servidor', [[`"script-src 'self' 'unsafe-inline'",`, `"script-src * 'unsafe-inline'",`]]],
      ['la política permite eval', [[`"script-src 'self' 'unsafe-inline'",`, `"script-src 'self' 'unsafe-inline' 'unsafe-eval'",`]]],
      ['la página no se envuelve como el visor', [["m.mode === 'host'\n          ? wrapLikeHost(readFileSync(join(dist, 'artifact.html'), 'utf8'))", "m.mode === 'host'\n          ? readFileSync(join(dist, 'artifact.html'), 'utf8')"]]],
      ['la carpeta del archivo no cuenta', [["if (!path.startsWith(m.filesDir)) continue;", '']]],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<Api>(file, edits);
      await expectKilledAsync(name, () => hostSuite(mutant));
    }
  });
});
