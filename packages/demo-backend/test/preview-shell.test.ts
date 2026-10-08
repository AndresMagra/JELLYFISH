import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APP_ROUTES,
  BRAND,
  ENV_SOURCE,
  PAGE_TITLE,
  candidateBases,
  fragmentProblems,
  guardHistory,
  keepAssetFile,
  patchAppBundle,
  renderFragment,
  renderIndexHtml,
  resolveEnv,
  scanFontUsage,
  wrapLikeHost,
} from '../../../scripts/preview-shell';
import { cleanMutants, expectKilled, loadMutant } from './mutation-lib';

const FILES = { data: 'js/demo-data.abc.js', demo: 'js/demo.abc.js', app: 'js/app.abc.js' };
const OPTS = { buildId: 'abc1234567', files: FILES };

// ───────────────────────── dónde está publicada la página ─────────────────────────

type EnvApi = {
  candidateBases: (pathname: string) => string[];
  resolveEnv: (pathname: string, dir: string) => { assets: string; router: string; noslash: boolean };
  guardHistory: (history: object) => void;
  routes: readonly string[];
};

/** Las funciones del arranque, construidas a partir de un texto (el original o uno con una mutación). */
function envFrom(source: string): EnvApi {
  const api = new Function(
    `${source}; return { c: jfCandidateBases, e: jfEnv, g: jfGuardHistory, r: JF_ROUTES };`,
  )() as { c: EnvApi['candidateBases']; e: EnvApi['resolveEnv']; g: EnvApi['guardHistory']; r: string[] };
  return { candidateBases: api.c, resolveEnv: api.e, guardHistory: api.g, routes: api.r };
}

/** Una publicación posible: dónde está la página y en qué carpeta quedaron sus archivos. */
interface Publication {
  name: string;
  page: string;
  files: string;
}

const PUBLICATIONS: Publication[] = [
  { name: 'raíz', page: '/', files: '/' },
  { name: 'raíz con index.html', page: '/index.html', files: '/' },
  { name: 'raíz con artifact.html', page: '/artifact.html', files: '/' },
  { name: '/x/', page: '/x/', files: '/x/' },
  { name: '/x/index.html', page: '/x/index.html', files: '/x/' },
  { name: '/x/y/z/', page: '/x/y/z/', files: '/x/y/z/' },
  { name: '/x/y/z/index.html', page: '/x/y/z/index.html', files: '/x/y/z/' },
  { name: '/x/y/z/artifact.html', page: '/x/y/z/artifact.html', files: '/x/y/z/' },
  { name: 'sin barra, archivos en la carpeta hermana', page: '/artifact/abc', files: '/artifact/' },
  { name: 'sin barra, archivos dentro de la ruta', page: '/artifact/def', files: '/artifact/def/' },
  { name: 'carpeta con espacio (codificada)', page: '/mi%20vista/', files: '/mi%20vista/' },
];

/** Lo que tiene que deducir el arranque, calculado SIN usar su código (el "oráculo"). */
const expectedEnv = (p: Publication) => ({
  assets: p.files.replace(/\/+$/, ''),
  router: p.page.endsWith('/') ? p.page.replace(/\/+$/, '') : p.page,
  noslash: !p.page.endsWith('/'),
});

/**
 * Lo que hace el navegador al abrir `pathname` cuando los archivos de la publicación están en `files`:
 * (A) los <script src> relativos aciertan si la carpeta de la URL es la de los archivos; (B) si no, se
 * prueban las carpetas candidatas (cada prueba "acierta" solo en la carpeta real, como jf-probe.json).
 */
function boot(api: EnvApi, pathname: string, files: string) {
  const tried = new URL('./', `https://visor.example${pathname}`).pathname;
  if (tried === files) return { plan: 'A' as const, env: api.resolveEnv(pathname, tried) };
  const found = api.candidateBases(pathname).find((d) => d !== tried && d === files);
  if (found === undefined) return null;
  return { plan: 'B' as const, env: api.resolveEnv(pathname, found) };
}

/** Pantallas internas con su dirección real (la base del router + la ruta de la app). */
const INNER = ['search', 'cart', 'orders', 'profile', 'product/camaron', 'order/abc-123', 'checkout', 'login', 'verify', 'address-new', 'favorites', 'legal/terminos'];

function envSuite(api: EnvApi): void {
  // candidateBases: de la carpeta de la URL hacia arriba, sin repetir.
  expect(api.candidateBases('/')).toEqual(['/']);
  expect(api.candidateBases('/index.html')).toEqual(['/']);
  expect(api.candidateBases('/x/y/z/artifact.html')).toEqual(['/x/y/z/', '/x/y/', '/x/', '/']);
  expect(api.candidateBases('/artifact/xyz')).toEqual(['/artifact/', '/artifact/xyz/', '/']);
  expect(api.candidateBases('/vista.previa/app')).toEqual(['/vista.previa/', '/vista.previa/app/', '/']);
  expect(api.candidateBases('/x/y/z/product/camaron')).toEqual(['/x/y/z/product/', '/x/y/z/product/camaron/', '/x/y/z/', '/x/y/', '/x/', '/']);

  for (const p of PUBLICATIONS) {
    const want = expectedEnv(p);
    // Abrir la página tal cual.
    const first = boot(api, p.page, p.files);
    expect(first, `${p.name}: no encontró los archivos`).not.toBeNull();
    expect(first!.env, p.name).toEqual(want);
    expect(first!.plan, p.name).toBe(p.name === 'sin barra, archivos dentro de la ruta' ? 'B' : 'A');
    // Recargar dentro de cualquier pantalla: la misma carpeta de archivos y la misma base del router.
    for (const inner of INNER) {
      const pathname = `${want.router}/${inner}`;
      const again = boot(api, pathname, p.files);
      expect(again, `${p.name} → /${inner}: no encontró los archivos`).not.toBeNull();
      expect(again!.env.assets, `${p.name} → /${inner}`).toBe(want.assets);
      expect(again!.env.router, `${p.name} → /${inner}`).toBe(want.router);
    }
  }

  // Una base que no coincide con ninguna carpeta candidata no inventa archivos.
  expect(boot(api, '/a/b', '/otra/')).toBeNull();
}

function historySuite(api: EnvApi): void {
  // Un marco con otro origen rechaza pushState y replaceState con SecurityError: la app no puede quedar en blanco.
  const calls: string[] = [];
  const hist: { pushState: (...a: unknown[]) => unknown; replaceState: (...a: unknown[]) => unknown } = {
    pushState() {
      throw new DOMException('Bloqueado por el marco', 'SecurityError');
    },
    replaceState(_s: unknown, _t: unknown, url: unknown) {
      calls.push(String(url));
      return 'ok';
    },
  };
  api.guardHistory(hist);
  expect(() => hist.pushState({}, '', '/x')).not.toThrow();
  expect(hist.pushState({}, '', '/x')).toBeUndefined();
  // Lo que sí funciona, sigue funcionando igual y con sus argumentos.
  expect(hist.replaceState({}, '', '/y')).toBe('ok');
  expect(calls).toEqual(['/y']);
  // No se rompe con un historial raro o sin esos métodos.
  expect(() => api.guardHistory({})).not.toThrow();
  expect(() => api.guardHistory({ pushState: 1, replaceState: null })).not.toThrow();
  // Un objeto con propiedades de solo lectura (congelado): no lanza.
  expect(() => api.guardHistory(Object.freeze({ pushState() {}, replaceState() {} }))).not.toThrow();
}

describe('base en tiempo de ejecución: dónde quedó publicada la página', () => {
  afterAll(cleanMutants);
  const api = envFrom(ENV_SOURCE);

  it('el código exportado es el mismo que el del texto que viaja en la página', () => {
    expect(candidateBases('/a/b/')).toEqual(api.candidateBases('/a/b/'));
    expect(resolveEnv('/x/', '/x/')).toEqual(api.resolveEnv('/x/', '/x/'));
    expect(typeof guardHistory).toBe('function');
  });

  it('JS plano de ES5 (corre en cualquier teléfono): sin flechas, let/const ni plantillas', () => {
    expect(ENV_SOURCE).not.toMatch(/=>|\blet\b|\bconst\b|`|\.\.\./);
  });

  it.each(PUBLICATIONS)('$name ($page): deduce carpeta de archivos y base del router', (p) => {
    const first = boot(api, p.page, p.files);
    expect(first?.env).toEqual(expectedEnv(p));
  });

  it('en la raíz, en /x/, en /x/y/z/ y con index.html o artifact.html, y recargando en cualquier pantalla', () =>
    envSuite(api));

  it('la lista de pantallas es la de apps/customer/app (si alguien agrega una, esta prueba avisa)', () => {
    const dir = new URL('../../../apps/customer/app/', import.meta.url).pathname;
    const names = new Set<string>();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('(')) {
        for (const f of readdirSync(`${dir}${e.name}`)) names.add(f.replace(/\.tsx?$/, ''));
      } else names.add(e.name.replace(/\.tsx?$/, ''));
    }
    names.delete('index');
    names.delete('_layout');
    expect([...names].sort()).toEqual([...APP_ROUTES].sort());
  });

  it('si history.replaceState / pushState lanzan, el arranque lo tolera', () => historySuite(api));

  it('detecta cada mutación del arranque (ruta, carpeta, historial)', () => {
    const mutate = (from: string | RegExp, to: string): EnvApi => {
      const mutated = ENV_SOURCE.replace(from, to);
      expect(mutated, `la mutación ya no aplica: ${String(from)}`).not.toBe(ENV_SOURCE);
      return envFrom(mutated);
    };
    const killed = (name: string, m: EnvApi, suite: (a: EnvApi) => void) => expectKilled(name, () => suite(m));
    killed('cualquier segmento sin punto es una pantalla', mutate("first.indexOf('.') === -1 && JF_ROUTES.indexOf(first) !== -1", "first.indexOf('.') === -1"), envSuite);
    killed('un archivo con punto es una pantalla', mutate("first.indexOf('.') === -1 && JF_ROUTES.indexOf(first) !== -1", 'JF_ROUTES.indexOf(first) !== -1 || true'), envSuite);
    killed('no se prueba la ruta como carpeta', mutate("if (last && last.indexOf('.') === -1) out.push(pathname + '/');", ''), envSuite);
    killed('no se sube por las carpetas', mutate(/while \(up\.length > 1\) \{[\s\S]*?\n  \}\n/, ''), envSuite);
    killed('no se prueba la carpeta de la URL', mutate('out.push(dir);', ''), envSuite);
    killed('la página con archivo pierde su "sin barra"', mutate('router = dir + first;\n      noslash = true;', 'router = dir + first;\n      noslash = false;'), envSuite);
    killed('la carpeta de archivos conserva la barra final', mutate("var assets = dir.replace(/\\/+$/, '');", 'var assets = dir;'), envSuite);
    killed('en la raíz el router queda con "/"', mutate('router = assets;\n    noslash = false;\n  } else if (pathname + ', 'router = dir;\n    noslash = false;\n  } else if (pathname + '), envSuite);
    killed('falta la pantalla de textos legales', mutate("'favorites', 'legal'", "'favorites'"), envSuite);
    killed('falta la pantalla de producto', mutate("'product', ", ''), envSuite);
    killed('un error de pushState rompe la app', mutate('try { return fn.apply(history, arguments); } catch (e) { return undefined; }', 'return fn.apply(history, arguments);'), historySuite);
    killed('el envoltorio pierde los argumentos', mutate('return fn.apply(history, arguments);', 'return fn.apply(history, []);'), historySuite);
    killed('no se envuelve replaceState', mutate("var names = ['pushState', 'replaceState'];", "var names = ['replaceState'];"), historySuite);
  });
});

// ───────────────────────── parches al bundle de la app ─────────────────────────

// Fragmentos con la forma EXACTA que deja Metro al exportar (minificado).
const SAMPLE = [
  `__d(function(g,r,i,a,m,e,d){m.exports={uri:"/assets/__node_modules/expo-router/assets/error.d1ea.png",width:50,height:85,toString(){return this.uri}}},550,[]);`,
  `__d(function(g,r,i,a,m,e,d){m.exports="/assets/__node_modules/@expo/vector-icons/Fonts/MaterialCommunityIcons.6e43.ttf"},551,[]);`,
  `function o(t,a=""){return a?t.replace(/^\\/+/g,'/').replace(new RegExp(\`^\\\\/?\${(0,n.default)(a)}\`,'g'),''):t}`,
  `e.getUrlWithReactNavigationConcessions=function(t,n=""){const i=(0,a.stripGroupSegmentsFromPath)(o(t,n));return i}`,
  `e.appendBaseUrl=function(t,n=""){if(n)return\`/\${n.replace(/^\\/+/,'').replace(/\\/$/,'')}\${t}\`;return t};`,
  `e.appendBaseUrl=function(t,n=""){if(n)return\`/\${n.replace(/^\\/+/,'').replace(/\\/$/,'')}\${t}\`;return t};`,
].join('\n');

describe('patchAppBundle', () => {
  it('vuelve relativas las URLs de assets y deja que el router lea su base al ejecutar', () => {
    const { js, report } = patchAppBundle(SAMPLE);
    expect(report).toEqual({ assets: 2, stripBaseUrl: 1, concessions: 1, appendBaseUrl: 2 });
    // Ninguna ruta de assets quedó sin parchar (todas van detrás de la carpeta real de la página).
    expect(/(?<!\+)["'`]\/assets\//.test(js)).toBe(false);
    expect(js).toContain('uri:(globalThis.__JF_ASSETS__||"")+"/assets/__node_modules/expo-router');
    expect(js).toContain('m.exports=(globalThis.__JF_ASSETS__||"")+"/assets/__node_modules/@expo/vector-icons');
    expect(js).toContain('function o(t,a=globalThis.__JF_BASE__||""){return a?t.replace(');
    expect(js).toContain('getUrlWithReactNavigationConcessions=function(t,n=globalThis.__JF_BASE__||""){');
    expect(js.match(/appendBaseUrl=function\(t,n=globalThis\.__JF_BASE__\|\|""\)\{/g)).toHaveLength(2);
  });

  it('el resultado sigue siendo JavaScript válido', () => {
    const { js } = patchAppBundle(SAMPLE);
    // `new Function` parsea sin ejecutar: si el parche rompiera la sintaxis, lanzaría.
    expect(() => new Function(`${js}`)).not.toThrow();
  });

  it('las URLs de assets salen de la carpeta real de la página (en la raíz y en una subcarpeta)', () => {
    const { js } = patchAppBundle(SAMPLE);
    const expr = /m\.exports=(\(globalThis\.__JF_ASSETS__\|\|""\)\+"[^"]*MaterialCommunityIcons[^"]*")/.exec(js)![1]!;
    const read = (assets: string | undefined) => new Function('globalThis', `return ${expr}`)({ __JF_ASSETS__: assets }) as string;
    const tail = '/assets/__node_modules/@expo/vector-icons/Fonts/MaterialCommunityIcons.6e43.ttf';
    expect(read(undefined)).toBe(tail);
    expect(read('')).toBe(tail);
    expect(read('/x/y/z')).toBe(`/x/y/z${tail}`);
    expect(read('/mi%20vista')).toBe(`/mi%20vista${tail}`);
  });

  it('con base vacía (raíz) y con base de subcarpeta se comporta como expo-router; la inicio de un archivo no lleva "/"', () => {
    const { js } = patchAppBundle(
      `function o(t,a=""){return a?t.replace(/^\\/+/g,'/').replace(new RegExp('^\\\\/?'+a.replace(/\\//g,'\\\\/'),'g'),''):t}` +
        `e.appendBaseUrl=function(t,n=""){if(n)return\`/\${n.replace(/^\\/+/,'').replace(/\\/$/,'')}\${t}\`;return t};` +
        `e.getUrlWithReactNavigationConcessions=function(t,n=""){return o(t,n)};m.exports="/assets/x"`,
    );
    const make = (base: string, noslash = false) =>
      new Function('globalThis', `const e={},m={};${js};return {o,e}`)({
        __JF_BASE__: base,
        __JF_NOSLASH__: noslash,
      }) as { o: (p: string) => string; e: { appendBaseUrl: (p: string) => string } };
    const root = make('');
    expect(root.o('/search')).toBe('/search');
    expect(root.e.appendBaseUrl('/search')).toBe('/search');
    expect(root.e.appendBaseUrl('/')).toBe('/');
    const sub = make('/artifact/xyz');
    expect(sub.o('/artifact/xyz/search')).toBe('/search');
    expect(sub.o('/artifact/xyz/')).toBe('/');
    expect(sub.e.appendBaseUrl('/search')).toBe('/artifact/xyz/search');
    expect(sub.e.appendBaseUrl('/')).toBe('/artifact/xyz/');
    // La página es un archivo (…/artifact.html): su inicio es el propio archivo, sin barra que no existe.
    const file = make('/x/y/z/artifact.html', true);
    expect(file.e.appendBaseUrl('/')).toBe('/x/y/z/artifact.html');
    expect(file.e.appendBaseUrl('/search')).toBe('/x/y/z/artifact.html/search');
  });

  it('falla en voz alta si una versión nueva de Expo cambia los patrones', () => {
    expect(() =>
      patchAppBundle(SAMPLE.replace(/appendBaseUrl=function\(t,n=""\)/g, 'appendBaseUrl=function(t,n)')),
    ).toThrow(/appendBaseUrl/);
    expect(() => patchAppBundle('console.log(1)')).toThrow(/No se pudo parchear el bundle/);
    // Una ruta de assets en un contexto que no conocemos tampoco pasa en silencio.
    expect(() => patchAppBundle(`${SAMPLE}\nfoo("/assets/otra-cosa.png")`)).toThrow(/contexto desconocido/);
  });
});

// ───────────────────────── fuentes ─────────────────────────

describe('fuentes: solo se publican las que el código usa', () => {
  const usage = scanFontUsage([
    `import { PlusJakartaSans_400Regular, PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans';`,
    `import { Sora_700Bold, useFonts } from '@expo-google-fonts/sora';`,
    `import { FontAwesome6, MaterialCommunityIcons } from '@expo/vector-icons';`,
    `import type { ComponentProps } from 'react'; const x = 'Sora_Nada';`,
  ]);

  it('detecta las fuentes de Google y las familias de íconos que se importan', () => {
    expect([...usage.googleFonts].sort()).toEqual(['PlusJakartaSans_400Regular', 'PlusJakartaSans_700Bold', 'Sora_700Bold']);
    expect([...usage.iconFamilies].sort()).toEqual(['FontAwesome6', 'MaterialCommunityIcons']);
  });

  it('conserva lo usado y descarta el resto de los .ttf', () => {
    const f = (p: string) => keepAssetFile(p, usage);
    const gf = 'assets/__node_modules/@expo-google-fonts';
    const vi = 'assets/__node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts';
    expect(f(`${gf}/plus-jakarta-sans/400Regular/PlusJakartaSans_400Regular.dd3a1370a03dc0f2d7d093bd0ffe7c0b.ttf`)).toBe(true);
    expect(f(`${gf}/plus-jakarta-sans/200ExtraLight/PlusJakartaSans_200ExtraLight.fdd89758261c9786825d3cdeaf8bc77d.ttf`)).toBe(false);
    expect(f(`${gf}/sora/700Bold/Sora_700Bold.0123456789abcdef0123456789abcdef.ttf`)).toBe(true);
    expect(f(`${vi}/MaterialCommunityIcons.6e435534bd35da5fef04168860a9b8fa.ttf`)).toBe(true);
    expect(f(`${vi}/FontAwesome6_Solid.adec7d6f310bc577f05e8fe06a5daccf.ttf`)).toBe(true);
    expect(f(`${vi}/Ionicons.b4eb097d35f44ed943676fd56f6bdc51.ttf`)).toBe(false);
    expect(f('assets/__node_modules/expo-router/assets/error.d1ea1496f9057eb392d5bbf3732a61b7.png')).toBe(true);
  });

  it('sin datos de uso no se descarta nada (nunca se deja una fuente a medias)', () => {
    const none = scanFontUsage([]);
    expect(keepAssetFile('assets/__node_modules/@expo/vector-icons/Fonts/Ionicons.abc.ttf', none)).toBe(true);
  });
});

// ───────────────────────── la página ─────────────────────────

describe('artifact.html: el fragmento que se publica', () => {
  const html = renderFragment(OPTS);

  it('cumple el formato de página publicada (sin doctype/html/head/body; empieza con <title> y <style>)', () => {
    expect(fragmentProblems(html)).toEqual([]);
    expect(html.startsWith(`<title>${PAGE_TITLE}</title>\n<style>`)).toBe(true);
    expect(PAGE_TITLE).toBe('JELLYFISH');
    for (const tag of ['<!doctype', '<html', '<head', '<body']) expect(html.toLowerCase()).not.toContain(tag);
    expect(html).toContain('<div id="root">');
  });

  it('define los colores de la marca como tokens en :root y un fondo explícito y opaco en body', () => {
    const root = /:root \{([^}]*)\}/.exec(html)![1]!;
    expect(root).toContain(`--jf-abyss: ${BRAND.abyss}`);
    expect(root).toContain('color-scheme: dark');
    expect(html).toMatch(/body \{[^}]*background: var\(--jf-abyss\)/);
    // Sin transparencia: ningún token de fondo es rgba ni #rrggbbaa.
    expect(root).not.toMatch(/rgba?\(|#[0-9a-fA-F]{8}\b/);
  });

  it('los tres scripts son archivos propios con ruta relativa, en orden: datos, simulador, app', () => {
    const srcs = [...html.matchAll(/<script defer src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual([FILES.data, FILES.demo, FILES.app]);
  });

  it('trae la cinta con el código de prueba y no depende de nada de afuera', () => {
    expect(html).toContain('VISTA PREVIA · datos de ejemplo · código de prueba <b>123456</b>');
    expect(html).toContain('id="jf-restart"');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/serviceWorker|manifest|<link|<base|window\.open|\balert\(|\bconfirm\(|\bprompt\(/);
  });

  it('no promete "app instalada": sin modo standalone ni íconos de pantalla de inicio en el fragmento', () => {
    expect(html).not.toMatch(/apple-mobile-web-app|mobile-web-app-capable|apple-touch-icon|instal/i);
  });

  it('la app va en una capa fija a pantalla completa: el relleno de :root del visor no la mueve', () => {
    expect(html).toMatch(/#root \{ position: fixed; top: var\(--jf-h\); left: 0; right: 0; bottom: 0;/);
    expect(html).toMatch(/body \{ margin: 0; overflow: hidden;/);
  });

  it('el arranque es el de ENV_SOURCE, deja la URL como está y avisa si faltan archivos', () => {
    expect(html).toContain(ENV_SOURCE.trim());
    expect(html).toContain('window.__JF_BASE__ = env.router');
    expect(html).not.toMatch(/history\.(replace|push)State\s*\(/); // la página nunca reescribe su dirección
    expect(html).toContain("fetch(dir + 'jf-probe.json'");
    expect(html).toContain('"abc1234567"');
    expect(html).toContain('window.__JF_FAILED__');
    expect(html).toContain('Reintentar');
  });

  it('el HTML que no cumple el formato se rechaza, regla por regla', () => {
    const bad = (mutate: (h: string) => string) => fragmentProblems(mutate(html));
    expect(bad((h) => `<!doctype html>${h}`)).not.toEqual([]);
    expect(bad((h) => `<html><body>${h}</body></html>`).join('|')).toMatch(/<html>.*<body>|<body>.*<html>|<html>|<body>/);
    expect(bad((h) => h.replace('<title>JELLYFISH</title>', '<title>Otra cosa</title>')).join('|')).toMatch(/debe empezar/);
    expect(bad((h) => h.replace('<title>JELLYFISH</title>\n<style>', '<style>').replace('</style>', '</style><title>JELLYFISH</title>')).join('|')).toMatch(/debe empezar/);
    expect(bad((h) => h.replace('--jf-abyss: #050B1F', '--jf-abyss: rgba(5,11,31,.5)')).join('|')).toMatch(/tokens de color/);
    expect(bad((h) => h.replace('background: var(--jf-abyss); color: var(--jf-text)', 'color: var(--jf-text)')).join('|')).toMatch(/fondo explícito/);
    expect(bad((h) => h.replace('<div id="root">', '<div id="app">')).join('|')).toMatch(/id="root"/);
    expect(bad((h) => h.replace(`src="${FILES.app}"`, 'src="/js/app.js"')).join('|')).toMatch(/ruta relativa/);
    expect(bad((h) => h.replace(`src="${FILES.app}"`, 'src="https://cdn.example/app.js"')).join('|')).toMatch(/ruta relativa|externos/);
    expect(bad((h) => `${h}<link rel="stylesheet" href="x.css">`).join('|')).toMatch(/<link>/);
    expect(bad((h) => `${h}<script>navigator.serviceWorker.register('sw.js')</script>`).join('|')).toMatch(/service workers/);
    expect(bad((h) => `${h}<script>if (confirm('seguro?')) {}</script>`).join('|')).toMatch(/alert\/confirm/);
    expect(bad((h) => `${h}<script>window.open('x')</script>`).join('|')).toMatch(/window\.open/);
    expect(bad((h) => `${h}<base href="/">`).join('|')).toMatch(/<base>/);
  });
});

describe('index.html completo y esqueleto del visor', () => {
  const full = renderIndexHtml(OPTS);

  it('es un documento completo con viewport-fit=cover y el mismo fragmento adentro', () => {
    expect(full.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(full).toContain('viewport-fit=cover');
    expect(full).toContain(renderFragment(OPTS));
    expect(full).toContain('href="icons/apple-touch-icon.png"'); // ícono para "agregar a inicio", en el documento completo
    // …pero tampoco promete instalarse: sin manifest, sin service worker, sin modo standalone.
    expect(full).not.toMatch(/manifest|serviceWorker|apple-mobile-web-app-capable|mobile-web-app-capable/);
  });

  it('ninguna dirección es absoluta (se rompería en una subcarpeta)', () => {
    const attrs = [...full.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(attrs.filter((u) => u.startsWith('/') || /^https?:/.test(u))).toEqual([]);
  });

  it('wrapLikeHost envuelve el fragmento como lo hace la plataforma: doctype, viewport-fit=cover y su reset', () => {
    const wrapped = wrapLikeHost(renderFragment(OPTS));
    expect(wrapped.startsWith('<!doctype html>')).toBe(true);
    expect(wrapped).toContain('<meta charset="utf-8">');
    expect(wrapped).toContain('viewport-fit=cover');
    expect(wrapped).toContain('color-scheme: light');
    expect(wrapped).toMatch(/padding-top: env\(safe-area-inset-top/);
    expect(wrapped).toMatch(/padding-bottom: env\(safe-area-inset-bottom/);
    expect(wrapped).toMatch(/body \{ margin: 0; font: 14px/);
    expect(wrapped).toContain('img { max-width: 100%; }');
    expect(wrapped).toContain('[hidden] { display: none !important; }');
    expect(wrapped).toContain(renderFragment(OPTS));
  });
});

describe('detecta cada mutación del formato de la página', () => {
  afterAll(cleanMutants);

  it('si renderFragment deja de cumplir una regla, fragmentProblems la reporta', async () => {
    const file = new URL('../../../scripts/preview-shell.ts', import.meta.url).pathname;
    type Shell = { renderFragment: typeof renderFragment; fragmentProblems: typeof fragmentProblems };
    const suite = (api: Shell) => expect(api.fragmentProblems(api.renderFragment(OPTS))).toEqual([]);
    suite({ renderFragment, fragmentProblems });
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      ['el título cambia', [["export const PAGE_TITLE = 'JELLYFISH';", "export const PAGE_TITLE = 'JELLYFISH · vista previa';"]]],
      ['el fondo del body se vuelve transparente', [['background: var(--jf-abyss); color: var(--jf-text); font: 600 14px', 'color: var(--jf-text); font: 600 14px']]],
      ['el script de la app pasa a ruta absoluta', [['<script defer src="${app}"></script>', '<script defer src="/${app}"></script>']]],
      ['aparece un service worker', [["try { jfGuardHistory(window.history); } catch (e) {}", "try { jfGuardHistory(window.history); } catch (e) {} navigator.serviceWorker.register('sw.js');"]]],
      ['aparece un manifest', [['<meta name="theme-color"', '<link rel="manifest" href="m.json"><meta name="theme-color"']]],
      ['se pide algo a otro servidor', [['<noscript>', '<noscript>https://fonts.example/x.css ']]],
      ['falta el contenedor de la app', [['<div id="root">', '<div id="app">']]],
      ['el fragmento se vuelve un documento', [['export function renderFragment(opts: ShellOptions): string {\n  const [data, demo, app] = fileList(opts.files);\n  return `<title>', 'export function renderFragment(opts: ShellOptions): string {\n  const [data, demo, app] = fileList(opts.files);\n  return `<!doctype html><title>']]],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<Shell>(file, edits);
      expectKilled(name, () => suite(mutant));
    }
  });
});
