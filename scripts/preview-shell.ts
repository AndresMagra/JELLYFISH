/**
 * Piezas puras de la vista previa web (sin disco ni red, para poder probarlas):
 *  - parches al bundle de la app exportada por Expo,
 *  - el FRAGMENTO que se publica como página (artifact.html: sin <html>, <head> ni <body>; la plataforma
 *    lo envuelve) y el index.html completo para probar en local o en otros alojamientos,
 *  - el arranque que averigua en qué ruta quedó publicada la página,
 *  - qué fuentes se usan de verdad (para no publicar las demás) y cómo se llaman al publicarlas.
 * Las usa scripts/build-preview.ts; las prueba packages/demo-backend/test/preview-shell.test.ts.
 *
 * Reglas del alojamiento (sin service workers, sin servidores externos, sin diálogos del navegador, sin
 * `window.open` confiable) y por qué cada cosa está como está: docs/VISTA-PREVIA.md.
 */

export const BRAND = {
  abyss: '#050B1F',
  deep: '#0A1633',
  cyan: '#22D3EE',
  ribbon: '#FBBF24',
  ribbonText: '#1A1200',
  text: '#EAF2FF',
  muted: '#93A4C3',
  line: '#1B2A4F',
} as const;

export const DEMO_BASE_URL = 'https://demo.jellyfish.local';
export const DEMO_OTP_HINT = '123456';
/** Nombre corto y estable de la página (así se llama en el visor). */
export const PAGE_TITLE = 'JELLYFISH';

// ───────────────────────── dónde está publicada la página ─────────────────────────

/**
 * Código del navegador que averigua dónde quedó publicada la página. Está como TEXTO a propósito: se
 * copia tal cual dentro de la página y las pruebas lo ejecutan igual (`new Function`), sin que el
 * transpilador le meta ayudantes que el navegador no tiene. ES5 con cuidado: corre en cualquier teléfono.
 *
 *  - `jfCandidateBases(pathname)`: carpetas donde pueden estar los archivos, de la más probable a la
 *    menos: la carpeta de la URL ("/a/b/" para "/a/b/", "/a/b/index.html" o "/a/b/artifact.html"), la
 *    propia URL como carpeta si la última parte no parece un archivo ("/a/b" → "/a/b/") y todas las
 *    carpetas superiores (por si el alojamiento sirvió la página en una pantalla interna).
 *  - `jfEnv(pathname, dir)`: con la carpeta de archivos ya conocida, la base del router y si la pantalla
 *    de inicio lleva barra final. La página SE QUEDA en la URL en que la abrieron (nunca se reescribe
 *    para "limpiarla"): recargar siempre vuelve a pedir una URL que existe.
 *  - `jfGuardHistory(history)`: pushState/replaceState nunca lanzan (un marco con otro origen los
 *    rechaza con SecurityError y la app no debe quedar en blanco por eso).
 */
export const ENV_SOURCE = `
var JF_ROUTES = ['search', 'cart', 'orders', 'profile', 'product', 'order', 'checkout', 'login', 'verify', 'address-new', 'favorites', 'legal'];

function jfCandidateBases(pathname) {
  var out = [];
  var dir = pathname.replace(/[^/]*$/, '');
  if (!dir) dir = '/';
  out.push(dir);
  var last = pathname.slice(dir.length);
  if (last && last.indexOf('.') === -1) out.push(pathname + '/');
  var up = dir;
  while (up.length > 1) {
    up = up.replace(/[^/]+\\/$/, '');
    out.push(up);
  }
  return out;
}

function jfEnv(pathname, dir) {
  var assets = dir.replace(/\\/+$/, '');
  var router;
  var noslash;
  if (pathname === dir) {
    router = assets;
    noslash = false;
  } else if (pathname + '/' === dir) {
    router = pathname;
    noslash = true;
  } else if (pathname.indexOf(dir) === 0) {
    var first = pathname.slice(dir.length).split('/')[0];
    if (first.indexOf('.') === -1 && JF_ROUTES.indexOf(first) !== -1) {
      router = assets;
      noslash = false;
    } else {
      router = dir + first;
      noslash = true;
    }
  } else {
    router = pathname.replace(/\\/+$/, '');
    noslash = pathname.charAt(pathname.length - 1) !== '/';
  }
  return { assets: assets, router: router, noslash: noslash };
}

function jfGuardHistory(history) {
  var names = ['pushState', 'replaceState'];
  for (var i = 0; i < names.length; i++) {
    var orig = history[names[i]];
    if (typeof orig !== 'function') continue;
    try {
      history[names[i]] = (function (fn) {
        return function () {
          try { return fn.apply(history, arguments); } catch (e) { return undefined; }
        };
      })(orig);
    } catch (e) {}
  }
}
`;

export interface PageEnv {
  /** Carpeta de los archivos, sin "/" final ("" en la raíz). */
  assets: string;
  /** Base del router de la app (sin "/" final). */
  router: string;
  /** true = la pantalla de inicio se escribe sin barra final (la página es un archivo o "/a/b"). */
  noslash: boolean;
}

const envApi = new Function(
  `${ENV_SOURCE}; return { jfCandidateBases: jfCandidateBases, jfEnv: jfEnv, jfGuardHistory: jfGuardHistory, JF_ROUTES: JF_ROUTES };`,
)() as {
  jfCandidateBases: (pathname: string) => string[];
  jfEnv: (pathname: string, dir: string) => PageEnv;
  jfGuardHistory: (history: object) => void;
  JF_ROUTES: string[];
};

/** Primer segmento de cada pantalla de la app (las rutas de apps/customer/app): una prueba lo compara con el código. */
export const APP_ROUTES: readonly string[] = envApi.JF_ROUTES;

/** Ver `ENV_SOURCE`. */
export const candidateBases = envApi.jfCandidateBases;
export const resolveEnv = envApi.jfEnv;
export const guardHistory = envApi.jfGuardHistory;

// ───────────────────────── parches al bundle de la app ─────────────────────────

export interface PatchReport {
  assets: number;
  stripBaseUrl: number;
  concessions: number;
  appendBaseUrl: number;
}

/** Texto con que se reemplaza el predeterminado `""` de la base del router (se lee al ejecutar). */
export const RUNTIME_BASE_EXPR = 'globalThis.__JF_BASE__||""';
/** Carpeta de archivos de la página, leída al ejecutar (antes de que cargue la app). */
export const RUNTIME_ASSETS_EXPR = '(globalThis.__JF_ASSETS__||"")';

/**
 * Hace que el bundle funcione en cualquier ruta, sin `<base>` y sin tocar la URL:
 *  1. las URLs de assets ("/assets/…", fuentes e imágenes) se anteponen con la carpeta real de la
 *     página, que el arranque guarda en `globalThis.__JF_ASSETS__`;
 *  2. el router (expo-router) toma su base de `globalThis.__JF_BASE__` en vez de la fijada al compilar
 *     (""), así las rutas internas, el botón atrás y recargar funcionan en cualquier subcarpeta;
 *  3. la pantalla de inicio se escribe sin barra final cuando la página es un archivo (`…/artifact.html`):
 *     si el router añadiera "/", recargar pediría una URL que no existe.
 * Falla en voz alta si algún patrón no aparece (una actualización de Expo puede cambiarlos).
 */
export function patchAppBundle(js: string): { js: string; report: PatchReport } {
  const report: PatchReport = { assets: 0, stripBaseUrl: 0, concessions: 0, appendBaseUrl: 0 };

  // m.exports="/assets/…"  (fuentes; el nombre del parámetro cambia: a.exports, m.exports…)   ·   uri:"/assets/…"  (imágenes)
  let out = js.replace(
    /([\w$]+\.exports=|uri:)"\/assets\/([^"]*)"/g,
    (_m, head: string, rest: string) => {
      report.assets++;
      return `${head}${RUNTIME_ASSETS_EXPR}+"/assets/${rest}"`;
    },
  );
  // Lo parcheado quedó como `+"/assets/…"`; cualquier otra ruta de assets es un contexto que no conocemos.
  const leftover = /(?<!\+)["'`]\/assets\//.exec(out);
  if (leftover) {
    throw new Error(
      `No se pudo parchear el bundle de la app (quedó una ruta de assets en un contexto desconocido: …${out
        .slice(Math.max(0, leftover.index - 40), leftover.index + 60)
        .replace(
          /\s+/g,
          ' ',
        )}…). Probablemente cambió la versión de Expo: revisa patchAppBundle en scripts/preview-shell.ts.`,
    );
  }

  // function o(t,a=""){return a?t.replace(/^\/+/g,'/')…   (stripBaseUrl)
  out = out.replace(
    /function ([\w$]+)\(([\w$]+),([\w$]+)=""\)\{return \3\?\2\.replace\(\/\^\\\/\+\/g,'\/'\)/g,
    (_m, fn: string, a: string, b: string) => {
      report.stripBaseUrl++;
      return `function ${fn}(${a},${b}=${RUNTIME_BASE_EXPR}){return ${b}?${a}.replace(/^\\/+/g,'/')`;
    },
  );
  // getUrlWithReactNavigationConcessions=function(t,n=""){
  out = out.replace(
    /(getUrlWithReactNavigationConcessions=function\([\w$]+,)([\w$]+)=""(\)\{)/g,
    (_m, head: string, b: string, tail: string) => {
      report.concessions++;
      return `${head}${b}=${RUNTIME_BASE_EXPR}${tail}`;
    },
  );
  // appendBaseUrl=function(t,n=""){if(n)return…
  out = out.replace(
    /(appendBaseUrl=function\()([\w$]+),([\w$]+)=""\)\{if\(\3\)return/g,
    (_m, head: string, path: string, base: string) => {
      report.appendBaseUrl++;
      return (
        `${head}${path},${base}=${RUNTIME_BASE_EXPR}){` +
        `if(${base}&&${path}==="/"&&globalThis.__JF_NOSLASH__)return"/"+${base}.replace(/^\\/+/,"").replace(/\\/$/,"");` +
        `if(${base})return`
      );
    },
  );

  const missing = Object.entries(report)
    .filter(([, n]) => n === 0)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `No se pudo parchear el bundle de la app (no aparece: ${missing.join(', ')}). ` +
        'Probablemente cambió la versión de Expo o de expo-router: revisa patchAppBundle en scripts/preview-shell.ts.',
    );
  }
  return { js: out, report };
}

// ───────────────────────── fuentes que de verdad se usan ─────────────────────────

const ICON_FAMILIES = [
  'MaterialCommunityIcons',
  'MaterialIcons',
  'FontAwesome6',
  'FontAwesome5',
  'FontAwesome',
  'Ionicons',
  'AntDesign',
  'Entypo',
  'EvilIcons',
  'Feather',
  'Fontisto',
  'Foundation',
  'Octicons',
  'SimpleLineIcons',
  'Zocial',
];

export interface FontUsage {
  /** Nombres de fuentes de @expo-google-fonts que el código importa (PlusJakartaSans_400Regular…). */
  googleFonts: Set<string>;
  /** Familias de @expo/vector-icons que el código importa. */
  iconFamilies: Set<string>;
}

/** Busca en el código fuente qué fuentes se importan (no depende de lo que Expo meta en el bundle). */
export function scanFontUsage(sources: string[]): FontUsage {
  const googleFonts = new Set<string>();
  const iconFamilies = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/\b([A-Z][A-Za-z0-9]*_\d{3}[A-Za-z]+(?:_Italic)?)\b/g)) {
      googleFonts.add(m[1]!);
    }
    for (const m of src.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*['"]@expo\/vector-icons(?:\/[\w-]+)?['"]/g,
    )) {
      for (const name of m[1]!.split(',')) {
        const id = name
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim();
        if (ICON_FAMILIES.includes(id)) iconFamilies.add(id);
      }
    }
    for (const m of src.matchAll(/from\s*['"]@expo\/vector-icons\/(\w+)['"]/g)) {
      if (ICON_FAMILIES.includes(m[1]!)) iconFamilies.add(m[1]!);
    }
  }
  return { googleFonts, iconFamilies };
}

/**
 * ¿Se publica este archivo de assets? Los .ttf de @expo-google-fonts y de @expo/vector-icons que el
 * código no importa se descartan (el bundle los referencia todos, pero solo se descargan los que se
 * dibujan). Cualquier otro archivo se conserva. Sin datos de uso, se conserva todo.
 */
export function keepAssetFile(relPath: string, usage: FontUsage): boolean {
  if (!relPath.endsWith('.ttf')) return true;
  const file = relPath.slice(relPath.lastIndexOf('/') + 1);
  const name = file.replace(/\.[0-9a-f]{32}\.ttf$/, '').replace(/\.ttf$/, '');
  if (relPath.includes('@expo-google-fonts/')) {
    if (usage.googleFonts.size === 0) return true;
    return usage.googleFonts.has(name);
  }
  if (relPath.includes('@expo/vector-icons/')) {
    if (usage.iconFamilies.size === 0) return true;
    const family = name.split('_')[0]!;
    return usage.iconFamilies.has(family);
  }
  return true;
}

/**
 * Nombres de íconos que el código usa de verdad: toda cadena de texto del código que sea un nombre del
 * mapa de glifos de la fuente (p. ej. 'snowflake', 'cart-outline'). Es un conjunto "de más" a propósito
 * (una palabra suelta que coincida no cuesta nada); lo que NO puede pasar es que falte un ícono, así que
 * también se incluye la variante con y sin "-outline".
 */
export function iconNamesIn(sources: string[], glyphNames: Iterable<string>): Set<string> {
  const known = new Set(glyphNames);
  const found = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(/(['"`])([a-z0-9][a-z0-9-]*)\1/g)) {
      const name = m[2]!;
      if (known.has(name)) found.add(name);
    }
  }
  for (const name of [...found]) {
    const pair = name.endsWith('-outline') ? name.slice(0, -'-outline'.length) : `${name}-outline`;
    if (known.has(pair)) found.add(pair);
  }
  return found;
}

/** Familia de una fuente de @expo/vector-icons a partir del nombre de su archivo .ttf. */
export function iconFamilyOfFile(relPath: string): string | null {
  if (!relPath.includes('@expo/vector-icons/') || !relPath.endsWith('.ttf')) return null;
  const file = relPath.slice(relPath.lastIndexOf('/') + 1);
  return (
    file
      .replace(/\.[0-9a-f]{32}\.ttf$/, '')
      .replace(/\.ttf$/, '')
      .split('_')[0] ?? null
  );
}

// ───────────────────────── nombres de los archivos publicados ─────────────────────────

const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|ico)$/i;

/**
 * Ruta con que se publica un archivo de assets de Expo. Las de Metro traen carpetas como
 * `__node_modules/@expo-google-fonts/sora/600SemiBold/` (guiones bajos dobles y "@"), que no conviene
 * dejar en una dirección web. Se conserva el nombre con su hash, que ya es único por contenido.
 */
export function publishedAssetPath(rel: string): string {
  const file = (rel.slice(rel.lastIndexOf('/') + 1) || 'archivo').replace(/@/g, '-');
  if (FONT_EXT.test(file)) return `assets/fonts/${file}`;
  if (IMAGE_EXT.test(file)) return `assets/img/${file}`;
  return `assets/other/${file}`;
}

// ───────────────────────── la página ─────────────────────────

export interface ShellFiles {
  data: string;
  demo: string;
  app: string;
}

export interface ShellOptions {
  buildId: string;
  files: ShellFiles;
}

/**
 * Estilos de la página. Una sola apariencia, a propósito (marca oscura con la cinta amarilla): la app
 * dibuja encima su propio tema claro u oscuro. Tokens en :root y fondo explícito en body.
 *
 * El visor ya trae su propio reset (color-scheme claro, :root con relleno por las zonas seguras, fuente de
 * 14 px, `img{max-width:100%}`): lo que sigue lo pisa donde hace falta y no depende de él. La app va en
 * una capa fija a pantalla completa, así el relleno de :root no la mueve.
 */
export const SHELL_CSS = `
      /* Cinta amarilla arriba, la app debajo a pantalla completa; avisos y confirmación encima de todo. */
      :root {
        --jf-abyss: ${BRAND.abyss};
        --jf-deep: ${BRAND.deep};
        --jf-cyan: ${BRAND.cyan};
        --jf-ribbon: ${BRAND.ribbon};
        --jf-ribbon-ink: ${BRAND.ribbonText};
        --jf-text: ${BRAND.text};
        --jf-muted: ${BRAND.muted};
        --jf-line: ${BRAND.line};
        --jf-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        --jf-h: calc(34px + env(safe-area-inset-top, 0px));
        color-scheme: dark;
      }
      html, body { height: 100%; }
      body { margin: 0; overflow: hidden; background: var(--jf-abyss); color: var(--jf-text); font: 600 14px/1.4 var(--jf-sans); -webkit-text-size-adjust: 100%; }
      #jf-ribbon { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483000; box-sizing: border-box; min-height: 30px;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        padding: calc(5px + env(safe-area-inset-top, 0px)) 8px 5px;
        background: var(--jf-ribbon); color: var(--jf-ribbon-ink); font: 600 10.5px/1.25 var(--jf-sans); letter-spacing: .02em; text-align: center; }
      #jf-ribbon b { font-weight: 800; letter-spacing: .08em; }
      #jf-restart { flex: none; border: 1px solid rgba(26,18,0,.45); background: rgba(255,255,255,.35); color: inherit; border-radius: 999px;
        font: 700 10px/1 var(--jf-sans); padding: 5px 8px; cursor: pointer; }
      #root { position: fixed; top: var(--jf-h); left: 0; right: 0; bottom: 0; display: flex; background: var(--jf-abyss); }
      /* La cinta ya cubre la zona segura de arriba: la app no la suma otra vez. */
      body > div[style*="safe-area-inset-top"] { padding-top: 0 !important; }
      #jf-boot { margin: auto; text-align: center; color: var(--jf-text); font: 600 15px/1.4 var(--jf-sans); padding: 24px; }
      #jf-boot small { display: block; margin-top: 6px; font-weight: 400; color: var(--jf-muted); }
      #jf-boot button { margin-top: 16px; background: var(--jf-cyan); color: var(--jf-abyss); border: 0; border-radius: 999px; padding: 12px 22px; font: 700 15px/1 var(--jf-sans); cursor: pointer; }
      #jf-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--jf-cyan); margin: 0 auto 14px; animation: jf-pulse 1.1s ease-in-out infinite; }
      @keyframes jf-pulse { 0%,100% { transform: scale(.7); opacity: .5; } 50% { transform: scale(1.15); opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { #jf-dot { animation: none; } }
      #jf-toast { position: fixed; z-index: 2147483001; left: 12px; right: 12px; top: calc(var(--jf-h) + 8px); box-sizing: border-box; max-width: 460px; margin: 0 auto;
        display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 10px 8px 10px 14px; border-radius: 14px;
        background: var(--jf-deep); color: var(--jf-text); border: 1px solid var(--jf-line); box-shadow: 0 10px 30px rgba(0,0,0,.45);
        font: 500 13px/1.4 var(--jf-sans); }
      #jf-toast span { flex: 1 1 220px; min-width: 0; }
      #jf-toast a { color: var(--jf-cyan); font-weight: 700; }
      #jf-toast button { flex: none; margin-left: auto; width: 32px; height: 32px; border: 0; border-radius: 16px; background: transparent; color: var(--jf-muted); font: 400 22px/1 var(--jf-sans); cursor: pointer; }
      #jf-confirm { position: fixed; z-index: 2147483002; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; box-sizing: border-box; background: rgba(5,11,31,.78); }
      #jf-confirm > div { width: 100%; max-width: 340px; box-sizing: border-box; padding: 20px; border-radius: 18px; background: var(--jf-deep); border: 1px solid var(--jf-line); color: var(--jf-text); box-shadow: 0 18px 50px rgba(0,0,0,.5); }
      #jf-confirm h2 { margin: 0 0 6px; font: 700 17px/1.3 var(--jf-sans); }
      #jf-confirm p { margin: 0 0 16px; font: 400 14px/1.45 var(--jf-sans); color: var(--jf-muted); }
      #jf-confirm .jf-actions { display: flex; gap: 10px; }
      #jf-confirm button { flex: 1; min-height: 44px; border-radius: 999px; border: 1px solid var(--jf-line); background: transparent; color: var(--jf-text); font: 700 14px/1 var(--jf-sans); cursor: pointer; }
      #jf-confirm button.jf-primary { background: var(--jf-cyan); border-color: var(--jf-cyan); color: var(--jf-abyss); }
      #jf-ribbon button:focus-visible, #jf-toast button:focus-visible, #jf-toast a:focus-visible, #jf-confirm button:focus-visible, #jf-boot button:focus-visible { outline: 2px solid var(--jf-cyan); outline-offset: 2px; }`;

const fileList = (files: ShellFiles) => [files.data, files.demo, files.app];

/** Primer script: dónde está la página, qué base usa el router y que el historial nunca lance errores. */
function envScript(): string {
  return `
${ENV_SOURCE}
function jfApply(env) {
  window.__JF_ASSETS__ = env.assets;
  window.__JF_BASE__ = env.router;
  window.__JF_NOSLASH__ = env.noslash;
}
var jfDir;
try { jfDir = new URL('./', document.baseURI).pathname; } catch (e) { jfDir = jfCandidateBases(location.pathname)[0]; }
window.__JF_TRIED__ = jfDir;
jfApply(jfEnv(location.pathname, jfDir));
try { jfGuardHistory(window.history); } catch (e) {}
// Los <script src> que no cargaron (el error de un archivo no sube por el documento: se oye en la captura).
window.__JF_FAILED__ = [];
window.addEventListener('error', function (e) {
  var t = e && e.target;
  if (t && t.tagName === 'SCRIPT' && t.src) window.__JF_FAILED__.push(t.src);
}, true);`;
}

/** Último script: la cinta, la confirmación de "Reiniciar" y el plan B si los archivos no están donde se esperaba. */
function shellScript(opts: ShellOptions): string {
  return `
(function () {
  var BUILD = ${JSON.stringify(opts.buildId)};
  var FILES = ${JSON.stringify(fileList(opts.files))};
  var root = document.getElementById('root');

  // La cinta puede ocupar una o dos líneas según el ancho del teléfono: la app empieza justo debajo.
  function fit() {
    var r = document.getElementById('jf-ribbon');
    if (r) document.documentElement.style.setProperty('--jf-h', r.offsetHeight + 'px');
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);

  // "Reiniciar": una confirmación dentro de la página (el visor no muestra los diálogos del navegador).
  var dialog = document.getElementById('jf-confirm');
  var restart = document.getElementById('jf-restart');
  var lastFocus = null;
  function closeDialog() {
    if (!dialog) return;
    dialog.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function doRestart() {
    if (window.JellyfishDemo) { window.JellyfishDemo.restart(); return; }
    try {
      for (var n = localStorage.length - 1; n >= 0; n--) { var key = localStorage.key(n); if (key && key.indexOf('jellyfish') === 0) localStorage.removeItem(key); }
    } catch (e) {}
    location.reload();
  }
  if (restart && dialog) {
    restart.onclick = function () {
      lastFocus = restart;
      dialog.hidden = false;
      var cancel = document.getElementById('jf-cancel');
      if (cancel) cancel.focus();
    };
    document.getElementById('jf-cancel').onclick = closeDialog;
    document.getElementById('jf-accept').onclick = doRestart;
    dialog.addEventListener('click', function (e) { if (e.target === dialog) closeDialog(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !dialog.hidden) closeDialog(); });
  }

  function fail(detail) {
    if (window.console && console.error) console.error('[JELLYFISH vista previa] ' + detail);
    root.innerHTML = '<div id="jf-boot">No pudimos abrir la vista previa<small>Revisa tu conexión y vuelve a intentarlo.</small><button type="button" id="jf-retry">Reintentar</button></div>';
    var b = document.getElementById('jf-retry');
    if (b) b.onclick = function () { location.reload(); };
  }
  function probe(dir) {
    return fetch(dir + 'jf-probe.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return !!j && j.jf === BUILD; })
      .catch(function () { return false; });
  }
  function pick(list, i) {
    if (i >= list.length) return Promise.resolve(null);
    if (list[i] === window.__JF_TRIED__) return pick(list, i + 1);
    return probe(list[i]).then(function (ok) { return ok ? list[i] : pick(list, i + 1); });
  }
  function load(dir, src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.async = false;
      s.src = dir + src;
      s.onload = ok;
      s.onerror = function () { bad(new Error('No cargó ' + src)); };
      document.body.appendChild(s);
    });
  }

  // Plan A: los <script src> relativos de arriba ya cargaron (la carpeta de la URL es la de los archivos).
  // Plan B: la página se abrió en otra ruta (una pantalla interna, "/a/b" sin barra…): se buscan los
  // archivos subiendo por las carpetas, pidiendo jf-probe.json, y se cargan desde ahí.
  // Si ya cargó una parte (los datos sí, la app no), no es un problema de ruta: es una publicación a medias.
  document.addEventListener('DOMContentLoaded', function () {
    var failed = window.__JF_FAILED__ || [];
    if (window.__JF_DEMO_DATA__ && failed.length === 0) return;
    if (window.__JF_DEMO_DATA__ || window.JellyfishDemo) {
      fail('Faltan archivos de la vista previa: ' + failed.join(', '));
      return;
    }
    pick(jfCandidateBases(location.pathname), 0).then(function (dir) {
      if (!dir) throw new Error('No se encontraron los archivos de la vista previa');
      jfApply(jfEnv(location.pathname, dir));
      return load(dir, FILES[0]).then(function () { return load(dir, FILES[1]); }).then(function () { return load(dir, FILES[2]); });
    }).catch(function (e) { fail(e && e.message ? e.message : String(e)); });
  });

  // Si pasa mucho tiempo y la app no apareció (red lenta, un archivo que no termina de bajar), se avisa y se ofrece reintentar.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var boot = document.getElementById('jf-boot');
      if (!boot || document.getElementById('jf-retry')) return;
      var small = boot.querySelector('small');
      if (small) small.textContent = 'Está tardando más de lo normal. Revisa tu conexión.';
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'jf-retry';
      b.textContent = 'Reintentar';
      b.onclick = function () { location.reload(); };
      boot.appendChild(b);
    }, 30000);
  });
})();`;
}

/** El contenido de la página (sin <html>, <head> ni <body>): lo que se publica como artifact.html. */
export function renderFragment(opts: ShellOptions): string {
  const [data, demo, app] = fileList(opts.files);
  return `<title>${PAGE_TITLE}</title>
<style>${SHELL_CSS}
</style>
<meta name="theme-color" content="${BRAND.abyss}">
<noscript>Necesitas activar JavaScript para ver la vista previa de JELLYFISH.</noscript>
<div id="jf-ribbon" role="status">
  <span>VISTA PREVIA · datos de ejemplo · código de prueba <b>${DEMO_OTP_HINT}</b></span>
  <button id="jf-restart" type="button" aria-label="Reiniciar la demostración">Reiniciar</button>
</div>
<div id="root"><div id="jf-boot"><div id="jf-dot"></div>JELLYFISH<small>Abriendo la vista previa…</small></div></div>
<div id="jf-toast" role="status" aria-live="polite" hidden></div>
<div id="jf-confirm" role="alertdialog" aria-modal="true" aria-labelledby="jf-confirm-title" aria-describedby="jf-confirm-text" hidden>
  <div>
    <h2 id="jf-confirm-title">¿Reiniciar la demostración?</h2>
    <p id="jf-confirm-text">Se borran la sesión, el carrito y los pedidos de ejemplo de este teléfono.</p>
    <div class="jf-actions"><button id="jf-cancel" type="button">Cancelar</button><button id="jf-accept" type="button" class="jf-primary">Sí, reiniciar</button></div>
  </div>
</div>
<script>${envScript()}
</script>
<script defer src="${data}"></script>
<script defer src="${demo}"></script>
<script defer src="${app}"></script>
<script>${shellScript(opts)}
</script>
`;
}

/** Límite del archivo principal de una publicación. */
const MAX_FRAGMENT_BYTES = 16 * 1024 * 1024;

/**
 * ¿El fragmento cumple el formato de una página publicada con la herramienta de Artifacts? Lista vacía =
 * cumple. La plataforma envuelve el archivo principal en su propio esqueleto, así que NO puede traer
 * <!doctype>, <html>, <head> ni <body>; debe empezar con <title> y un <style> con tokens de color en :root
 * y fondo explícito (opaco) en body; el contenido va en <div id="root"> y los scripts son archivos
 * propios con ruta relativa. Tampoco debe tocar service workers, manifest, <base> ni hojas de estilo o
 * scripts de otros servidores, ni usar diálogos del navegador.
 */
export function fragmentProblems(html: string): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, text: string) => {
    if (!ok) problems.push(text);
  };
  // El nombre es parte del contrato (corto y estable): se compara con el literal, no con la constante que lo genera.
  need(
    /^<title>JELLYFISH<\/title>\s*<style>/.test(html),
    'debe empezar con <title>JELLYFISH</title> y un <style>',
  );
  for (const tag of ['!doctype', 'html', 'head', 'body']) {
    need(!new RegExp(`<${tag}[\\s>]`, 'i').test(html), `no puede traer <${tag}>`);
  }
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  need(
    /--[\w-]+\s*:\s*#[0-9a-fA-F]{6}\b/.test(root) &&
      !/rgba?\(|#[0-9a-fA-F]{8}\b|\btransparent\b/.test(root),
    'el :root debe definir tokens de color (#rrggbb, sin transparencia)',
  );
  const bodyRules = [...css.matchAll(/(?:^|[\s,}])body\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  need(
    bodyRules.some((r) =>
      /background(?:-color)?\s*:\s*(?:var\(--[\w-]+\)|#[0-9a-fA-F]{6})\s*(?:;|$)/.test(r),
    ),
    'el body debe tener un fondo explícito y opaco',
  );
  need(/<div id="root"[ >]/.test(html), 'falta <div id="root">');
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1]!);
  need(srcs.length >= 3, 'faltan los <script src> (datos, simulador y app)');
  for (const src of srcs)
    need(
      !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(src),
      `el script "${src}" no es una ruta relativa a un archivo propio`,
    );
  need(!/<link\b/i.test(html), 'no puede traer <link> (solo hojas de Google Fonts, y no se usan)');
  need(!/<base\b/i.test(html), 'no puede traer <base>');
  need(!/https?:\/\//i.test(html), 'no puede nombrar servidores externos');
  need(
    !/serviceWorker|rel="manifest"|navigator\.share/.test(html),
    'no puede usar service workers ni manifest',
  );
  need(
    !/\b(?:alert|confirm|prompt)\s*\(|window\.open\s*\(/.test(html),
    'no puede usar alert/confirm/prompt ni window.open',
  );
  need(Buffer.byteLength(html) <= MAX_FRAGMENT_BYTES, 'el archivo principal pasa de 16 MB');
  return problems;
}

/**
 * La misma página como documento completo, para probarla en local o en un alojamiento que no la envuelva
 * (`dist-preview/index.html`). Sin service worker y sin manifest: la vista previa no se instala.
 */
export function renderIndexHtml(opts: ShellOptions): string {
  return `<!DOCTYPE html>
<html lang="es-DO">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex, nofollow">
<meta name="format-detection" content="telephone=no">
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon.png">
</head>
<body>
${renderFragment(opts)}</body>
</html>
`;
}

/**
 * El documento completo que el alojamiento arma alrededor del fragmento (para probarlo en local): doctype,
 * meta viewport con `viewport-fit=cover` y su reset mínimo. Es la descripción de las reglas de la plataforma,
 * no una copia de su código.
 */
export function wrapLikeHost(fragment: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="data:,">
<style>
:root { color-scheme: light; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #fafaf9; color: #1c1917; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
</head>
<body>
${fragment}</body>
</html>
`;
}
