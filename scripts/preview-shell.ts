/**
 * Piezas puras de la vista previa web (sin disco ni red, para poder probarlas):
 *  - parches al bundle de la app exportada por Expo,
 *  - el index.html con la cinta, el arranque y las metaetiquetas de "agregar a la pantalla de inicio",
 *  - el manifest PWA,
 *  - qué fuentes se usan de verdad (para no publicar las demás).
 * Las usa scripts/build-preview.ts; las prueba packages/demo-backend/test/preview-shell.test.ts.
 */

export const BRAND = {
  abyss: '#050B1F',
  deep: '#0A1633',
  cyan: '#22D3EE',
  ribbon: '#FBBF24',
  ribbonText: '#1A1200',
} as const;

export const DEMO_BASE_URL = 'https://demo.jellyfish.local';
export const DEMO_OTP_HINT = '123456';

// ───────────────────────── dónde está publicada la página ─────────────────────────

/**
 * Carpetas donde puede estar la página, de la más probable a la menos: la carpeta de la URL
 * ("/a/b/" para "/a/b/" o "/a/b/index.html") y, si la última parte no parece un archivo, la propia
 * URL como carpeta ("/a/b" → "/a/b/"). El arranque prueba cada una pidiendo `jf-probe.json`.
 *
 * Es JavaScript plano y sin dependencias: se copia tal cual (`toString()`) dentro del index.html.
 */
export function candidateBases(pathname: string): string[] {
  const out: string[] = [];
  let dir = pathname.replace(/[^/]*$/, '');
  if (!dir) dir = '/';
  out.push(dir);
  const last = pathname.slice(dir.length);
  if (last && last.indexOf('.') === -1) out.push(pathname + '/');
  return out;
}

// ───────────────────────── parches al bundle de la app ─────────────────────────

export interface PatchReport {
  assets: number;
  stripBaseUrl: number;
  concessions: number;
  appendBaseUrl: number;
}

/** Texto con que se reemplaza el predeterminado `""` de la base del router (se lee al ejecutar). */
export const RUNTIME_BASE_EXPR = 'globalThis.__JF_BASE__||""';

/**
 * Hace que el bundle funcione en cualquier subcarpeta:
 *  1. las URLs absolutas de assets ("/assets/…") pasan a relativas ("assets/…"): se resuelven con
 *     el `<base>` que el arranque calcula al cargar la página;
 *  2. el router (expo-router) toma su carpeta base de `globalThis.__JF_BASE__` en vez de la que
 *     se fijó al compilar (""), así las rutas internas, el botón atrás y recargar funcionan.
 * Falla en voz alta si algún patrón no aparece (una actualización de Expo puede cambiarlos).
 */
export function patchAppBundle(js: string): { js: string; report: PatchReport } {
  const report: PatchReport = { assets: 0, stripBaseUrl: 0, concessions: 0, appendBaseUrl: 0 };

  let out = js.replace(/"\/assets\//g, () => {
    report.assets++;
    return '"assets/';
  });

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
    /(appendBaseUrl=function\([\w$]+,)([\w$]+)=""(\)\{if\(\2\)return)/g,
    (_m, head: string, b: string, tail: string) => {
      report.appendBaseUrl++;
      return `${head}${b}=${RUNTIME_BASE_EXPR}${tail}`;
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

// ───────────────────────── index.html ─────────────────────────

export interface ShellFiles {
  data: string;
  demo: string;
  app: string;
}

export interface ShellOptions {
  buildId: string;
  files: ShellFiles;
  title?: string;
}

const RESET_CSS = `
      html, body { height: 100%; margin: 0; }
      body { overflow: hidden; background: ${BRAND.abyss}; color-scheme: dark light; -webkit-text-size-adjust: 100%; }
      :root { --jf-h: 34px; }
      #jf-ribbon { position: fixed; top: 0; left: 0; right: 0; min-height: 30px; z-index: 2147483000; box-sizing: border-box;
        display: flex; align-items: center; justify-content: center; gap: 8px; padding: 5px 8px;
        background: ${BRAND.ribbon}; color: ${BRAND.ribbonText}; font: 600 10.5px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        letter-spacing: .02em; text-align: center; }
      #jf-ribbon b { font-weight: 800; letter-spacing: .08em; }
      #jf-restart { flex: none; border: 1px solid rgba(26,18,0,.45); background: rgba(255,255,255,.35); color: inherit; border-radius: 999px;
        font: 700 10px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 5px 8px; cursor: pointer; }
      #root { position: fixed; top: var(--jf-h); left: 0; right: 0; bottom: 0; display: flex; }
      #jf-boot { margin: auto; text-align: center; color: #EAF2FF; font: 600 15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; }
      #jf-boot small { display: block; margin-top: 6px; font-weight: 400; color: #93A4C3; }
      #jf-boot button { margin-top: 16px; background: ${BRAND.cyan}; color: ${BRAND.abyss}; border: 0; border-radius: 999px; padding: 12px 22px; font: 700 15px/1 inherit; }
      #jf-dot { width: 12px; height: 12px; border-radius: 50%; background: ${BRAND.cyan}; margin: 0 auto 14px; animation: jf-pulse 1.1s ease-in-out infinite; }
      @keyframes jf-pulse { 0%,100% { transform: scale(.7); opacity: .5; } 50% { transform: scale(1.15); opacity: 1; } }`;

/** El arranque: calcula la carpeta, ajusta el router y carga datos → simulador → app, en orden. */
function bootstrapScript(opts: ShellOptions): string {
  return `
(function () {
  var BUILD = ${JSON.stringify(opts.buildId)};
  var FILES = ${JSON.stringify(opts.files)};
  var candidateBases = ${candidateBases.toString()};
  var root = document.getElementById('root');

  // La cinta puede ocupar una o dos líneas según el ancho del teléfono: la app empieza justo debajo.
  function fit() {
    var r = document.getElementById('jf-ribbon');
    if (r) document.documentElement.style.setProperty('--jf-h', r.offsetHeight + 'px');
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);

  function fail(detail) {
    if (window.console && console.error) console.error('[JELLYFISH vista previa] ' + detail);
    root.innerHTML = '<div id="jf-boot">No pudimos abrir la vista previa<small>Revisa tu conexión y vuelve a intentarlo.</small><button type="button" id="jf-retry">Reintentar</button></div>';
    var b = document.getElementById('jf-retry');
    if (b) b.onclick = function () { location.reload(); };
  }

  function probe(base) {
    return fetch(base + 'jf-probe.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return !!j && j.jf === BUILD; })
      .catch(function () { return false; });
  }
  function pick(list, i) {
    if (i >= list.length) return Promise.resolve(list[0]);
    return probe(list[i]).then(function (ok) { return ok ? list[i] : pick(list, i + 1); });
  }
  function el(tag, attrs) {
    var e = document.createElement(tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function load(base, src) {
    return new Promise(function (ok, bad) {
      var s = el('script', { src: base + src });
      s.onload = ok;
      s.onerror = function () { bad(new Error('No cargó ' + src)); };
      document.body.appendChild(s);
    });
  }

  // ?reset=1 borra la sesión, el carrito y los pedidos de ejemplo de este navegador.
  try {
    if (/[?&]reset=1(&|$)/.test(location.search)) {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('jellyfish') === 0) keys.push(k); }
      for (var j = 0; j < keys.length; j++) localStorage.removeItem(keys[j]);
      history.replaceState(history.state, '', location.pathname + location.search.replace(/([?&])reset=1&?/, '$1').replace(/[?&]$/, '') + location.hash);
    }
  } catch (e) {}

  var restart = document.getElementById('jf-restart');
  if (restart) restart.onclick = function () {
    if (!window.confirm('¿Reiniciar la demostración? Se borran la sesión, el carrito y los pedidos de ejemplo.')) return;
    if (window.JellyfishDemo) { window.JellyfishDemo.restart(); return; }
    try {
      for (var n = localStorage.length - 1; n >= 0; n--) { var key = localStorage.key(n); if (key && key.indexOf('jellyfish') === 0) localStorage.removeItem(key); }
    } catch (e) {}
    location.reload();
  };

  // Si la página la sirvió el respaldo (service worker) para una pantalla interna, ya sabemos la carpeta.
  var hinted = window.__JF_BASE_HINT__;
  (hinted ? Promise.resolve(hinted) : pick(candidateBases(location.pathname), 0)).then(function (base) {
    // 1) Todas las rutas relativas (fuentes, imágenes, scripts) se resuelven desde la carpeta real.
    var baseTag = el('base', { href: base });
    document.head.insertBefore(baseTag, document.head.firstChild);

    // 2) expo-router recibe esa carpeta como su base y ve "/" como pantalla de inicio.
    window.__JF_BASE__ = base.length > 1 ? base.replace(/\\/$/, '') : '';
    var last = location.pathname.slice(location.pathname.lastIndexOf('/') + 1);
    if (last.indexOf('.') !== -1) {
      try { history.replaceState(history.state, '', base + location.search + location.hash); } catch (e) {}
    }

    // 3) Respaldo para recargar en una pantalla interna aunque el alojamiento no sepa de rutas de la app.
    //    Es opcional: sin https, dentro de un marco aislado o sin soporte, la página funciona igual.
    try {
      if ('serviceWorker' in navigator) navigator.serviceWorker.register(base + 'sw.js', { scope: base }).catch(function () {});
    } catch (e) {}

    // 4) Íconos y manifest (se agregan aquí para que la ruta sea siempre la correcta).
    var head = document.head;
    head.appendChild(el('link', { rel: 'manifest', href: 'manifest.webmanifest' }));
    head.appendChild(el('link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: 'icons/favicon-32.png' }));
    head.appendChild(el('link', { rel: 'apple-touch-icon', sizes: '180x180', href: 'icons/apple-touch-icon.png' }));

    // 5) Datos de ejemplo → servidor de demostración → app. En ese orden.
    return load(base, FILES.data).then(function () { return load(base, FILES.demo); }).then(function () { return load(base, FILES.app); });
  }).catch(function (e) { fail(e && e.message ? e.message : String(e)); });
})();`;
}

export function renderIndexHtml(opts: ShellOptions): string {
  const title = opts.title ?? 'JELLYFISH · Vista previa';
  return `<!DOCTYPE html>
<html lang="es-DO">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no" />
    <meta name="theme-color" content="${BRAND.abyss}" />
    <meta name="color-scheme" content="dark light" />
    <meta name="application-name" content="JELLYFISH" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="JELLYFISH" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black" />
    <meta name="format-detection" content="telephone=no" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${title}</title>
    <style id="jf-shell">${RESET_CSS}
    </style>
  </head>
  <body>
    <noscript>Necesitas activar JavaScript para ver la vista previa de JELLYFISH.</noscript>
    <div id="jf-ribbon" role="status">
      <span>VISTA PREVIA · datos de ejemplo · código de prueba <b>${DEMO_OTP_HINT}</b></span>
      <button id="jf-restart" type="button" aria-label="Reiniciar la demostración">Reiniciar</button>
    </div>
    <div id="root"><div id="jf-boot"><div id="jf-dot"></div>JELLYFISH<small>Abriendo la vista previa…</small></div></div>
    <script>${bootstrapScript(opts)}
    </script>
  </body>
</html>
`;
}

// ───────────────────────── manifest PWA ─────────────────────────

export function renderWebManifest(): string {
  return `${JSON.stringify(
    {
      name: 'JELLYFISH (vista previa)',
      short_name: 'JELLYFISH',
      description: 'Vista previa de la app de JELLYFISH con datos de ejemplo.',
      lang: 'es-DO',
      start_url: './',
      scope: './',
      display: 'standalone',
      orientation: 'portrait',
      background_color: BRAND.abyss,
      theme_color: BRAND.abyss,
      icons: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        {
          src: 'icons/icon-maskable-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },
    null,
    2,
  )}\n`;
}

// ───────────────────────── respaldo para recargar en pantallas internas ─────────────────────────

/**
 * Service worker mínimo: NO guarda nada en caché (nunca sirve contenido viejo). Solo cuando una
 * navegación dentro de su carpeta recibe un error (p. ej. recargar en /carpeta/product/camaron en un
 * alojamiento estático que no conoce esa ruta), responde con el index.html de la vista previa, con la
 * carpeta ya indicada, para que el router de la app abra esa pantalla.
 */
export function renderServiceWorker(): string {
  return `/* JELLYFISH vista previa: respaldo de navegación (sin caché). */
var SCOPE = self.registration.scope;
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
function fallback() {
  return fetch(SCOPE + 'index.html', { cache: 'no-store' }).then(function (res) {
    return res.text().then(function (html) {
      var hint = '<script>window.__JF_BASE_HINT__=' + JSON.stringify(new URL(SCOPE).pathname) + ';</scr' + 'ipt>';
      return new Response(html.replace('<head>', '<head>' + hint), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      });
    });
  });
}
self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).then(function (res) { return res.ok ? res : fallback(); }).catch(fallback));
});
`;
}
