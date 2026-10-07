import { describe, expect, it } from 'vitest';
import {
  BRAND,
  candidateBases,
  keepAssetFile,
  patchAppBundle,
  renderIndexHtml,
  renderServiceWorker,
  renderWebManifest,
  scanFontUsage,
} from '../../../scripts/preview-shell';

describe('candidateBases: dónde puede estar publicada la página', () => {
  it.each([
    ['/', ['/']],
    ['/index.html', ['/']],
    ['/artifact/xyz/', ['/artifact/xyz/']],
    ['/artifact/xyz/index.html', ['/artifact/xyz/']],
    ['/artifact/xyz', ['/artifact/', '/artifact/xyz/']],
    ['/a/b/c/', ['/a/b/c/']],
    ['/vista.previa/app', ['/vista.previa/', '/vista.previa/app/']],
  ])('%s → %j', (pathname, expected) => {
    expect(candidateBases(pathname)).toEqual(expected);
  });

  it('es JavaScript plano: se puede copiar tal cual dentro del index.html', () => {
    const copy = new Function(`return (${candidateBases.toString()})`)() as typeof candidateBases;
    expect(copy('/artifact/xyz')).toEqual(['/artifact/', '/artifact/xyz/']);
  });
});

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
    expect(js).not.toContain('"/assets/');
    expect(js).toContain('uri:"assets/__node_modules/expo-router');
    expect(js).toContain('m.exports="assets/__node_modules/@expo/vector-icons');
    expect(js).toContain('function o(t,a=globalThis.__JF_BASE__||""){return a?t.replace(');
    expect(js).toContain(
      'getUrlWithReactNavigationConcessions=function(t,n=globalThis.__JF_BASE__||""){',
    );
    expect(
      js.match(/appendBaseUrl=function\(t,n=globalThis\.__JF_BASE__\|\|""\)\{if\(n\)return/g),
    ).toHaveLength(2);
  });

  it('el resultado sigue siendo JavaScript válido', () => {
    const { js } = patchAppBundle(SAMPLE);
    // `new Function` parsea sin ejecutar: si el parche rompiera la sintaxis, lanzaría.
    expect(() => new Function(`${js}`)).not.toThrow();
  });

  it('con base vacía (raíz) y con base de subcarpeta se comporta como expo-router', () => {
    const { js } = patchAppBundle(
      `function o(t,a=""){return a?t.replace(/^\\/+/g,'/').replace(new RegExp('^\\\\/?'+a.replace(/\\//g,'\\\\/'),'g'),''):t}` +
        `e.appendBaseUrl=function(t,n=""){if(n)return\`/\${n.replace(/^\\/+/,'').replace(/\\/$/,'')}\${t}\`;return t};` +
        `e.getUrlWithReactNavigationConcessions=function(t,n=""){return o(t,n)};"/assets/x"`,
    );
    const make = (base: string) =>
      new Function(
        'globalThis',
        `const e={};${js.replace('"/assets/x"', '"assets/x"')};return {o,e}`,
      )({ __JF_BASE__: base }) as {
        o: (p: string) => string;
        e: { appendBaseUrl: (p: string) => string };
      };
    const root = make('');
    expect(root.o('/search')).toBe('/search');
    expect(root.e.appendBaseUrl('/search')).toBe('/search');
    const sub = make('/artifact/xyz');
    expect(sub.o('/artifact/xyz/search')).toBe('/search');
    expect(sub.o('/artifact/xyz/')).toBe('/');
    expect(sub.e.appendBaseUrl('/search')).toBe('/artifact/xyz/search');
  });

  it('falla en voz alta si una versión nueva de Expo cambia los patrones', () => {
    expect(() =>
      patchAppBundle(
        SAMPLE.replace(/appendBaseUrl=function\(t,n=""\)/g, 'appendBaseUrl=function(t,n)'),
      ),
    ).toThrow(/appendBaseUrl/);
    expect(() => patchAppBundle('console.log(1)')).toThrow(/No se pudo parchear el bundle/);
  });
});

describe('fuentes: solo se publican las que el código usa', () => {
  const usage = scanFontUsage([
    `import { PlusJakartaSans_400Regular, PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans';`,
    `import { Sora_700Bold, useFonts } from '@expo-google-fonts/sora';`,
    `import { FontAwesome6, MaterialCommunityIcons } from '@expo/vector-icons';`,
    `import type { ComponentProps } from 'react'; const x = 'Sora_Nada';`,
  ]);

  it('detecta las fuentes de Google y las familias de íconos que se importan', () => {
    expect([...usage.googleFonts].sort()).toEqual([
      'PlusJakartaSans_400Regular',
      'PlusJakartaSans_700Bold',
      'Sora_700Bold',
    ]);
    expect([...usage.iconFamilies].sort()).toEqual(['FontAwesome6', 'MaterialCommunityIcons']);
  });

  it('conserva lo usado y descarta el resto de los .ttf', () => {
    const f = (p: string) => keepAssetFile(p, usage);
    const gf = 'assets/__node_modules/@expo-google-fonts';
    const vi =
      'assets/__node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts';
    expect(
      f(
        `${gf}/plus-jakarta-sans/400Regular/PlusJakartaSans_400Regular.dd3a1370a03dc0f2d7d093bd0ffe7c0b.ttf`,
      ),
    ).toBe(true);
    expect(
      f(
        `${gf}/plus-jakarta-sans/200ExtraLight/PlusJakartaSans_200ExtraLight.fdd89758261c9786825d3cdeaf8bc77d.ttf`,
      ),
    ).toBe(false);
    expect(f(`${gf}/sora/700Bold/Sora_700Bold.0123456789abcdef0123456789abcdef.ttf`)).toBe(true);
    expect(f(`${vi}/MaterialCommunityIcons.6e435534bd35da5fef04168860a9b8fa.ttf`)).toBe(true);
    expect(f(`${vi}/FontAwesome6_Solid.adec7d6f310bc577f05e8fe06a5daccf.ttf`)).toBe(true);
    expect(f(`${vi}/Ionicons.b4eb097d35f44ed943676fd56f6bdc51.ttf`)).toBe(false);
    expect(
      f('assets/__node_modules/expo-router/assets/error.d1ea1496f9057eb392d5bbf3732a61b7.png'),
    ).toBe(true);
  });

  it('sin datos de uso no se descarta nada (nunca se deja una fuente a medias)', () => {
    const none = scanFontUsage([]);
    expect(
      keepAssetFile('assets/__node_modules/@expo/vector-icons/Fonts/Ionicons.abc.ttf', none),
    ).toBe(true);
  });
});

describe('index.html de la vista previa', () => {
  const html = renderIndexHtml({
    buildId: 'abc1234567',
    files: { data: 'js/demo-data.abc.js', demo: 'js/demo.abc.js', app: 'js/app.abc.js' },
  });

  it('trae la cinta fija con el texto pedido y el código de prueba', () => {
    expect(html).toContain('VISTA PREVIA · datos de ejemplo · código de prueba <b>123456</b>');
    expect(html).toMatch(/#jf-ribbon \{ position: fixed; top: 0;/);
    expect(html).toContain('id="jf-restart"');
  });

  it('tiene viewport, color de tema, modo "app" para iPhone y Android y ningún ícono en ruta absoluta', () => {
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1');
    expect(html).toContain(`name="theme-color" content="${BRAND.abyss}"`);
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('apple-mobile-web-app-status-bar-style');
    // Íconos y manifest se agregan desde el arranque, con rutas relativas a la carpeta real.
    expect(html).toContain("rel: 'apple-touch-icon'");
    expect(html).toContain("href: 'icons/apple-touch-icon.png'");
    expect(html).toContain("href: 'manifest.webmanifest'");
  });

  it('ningún script, estilo ni ícono usa una ruta absoluta (que se rompería en una subcarpeta)', () => {
    const attrs = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(attrs.filter((u) => u.startsWith('/') || /^https?:/.test(u))).toEqual([]);
    expect(html).not.toMatch(/\bsrc="\/_expo/);
  });

  it('el arranque prueba la carpeta, fija <base>, la base del router y carga datos → simulador → app', () => {
    expect(html).toContain("fetch(base + 'jf-probe.json'");
    expect(html).toContain('j.jf === BUILD');
    expect(html).toContain('window.__JF_BASE__ =');
    expect(html).toContain("el('base', { href: base })");
    const order = ['FILES.data', 'FILES.demo', 'FILES.app'].map((k) =>
      html.indexOf(`load(base, ${k})`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('"abc1234567"');
  });
});

describe('manifest PWA y respaldo de navegación', () => {
  const manifest = JSON.parse(renderWebManifest());

  it('se instala como app: standalone, colores de la marca y rutas relativas', () => {
    expect(manifest).toMatchObject({
      display: 'standalone',
      background_color: BRAND.abyss,
      theme_color: BRAND.abyss,
      start_url: './',
      scope: './',
      lang: 'es-DO',
    });
    for (const icon of manifest.icons) expect(icon.src.startsWith('/')).toBe(false);
    expect(manifest.icons.map((i: { purpose: string }) => i.purpose)).toContain('maskable');
  });

  it('el service worker no guarda nada en caché y solo actúa en navegaciones que fallan', () => {
    const sw = renderServiceWorker();
    expect(sw).not.toMatch(/caches\./);
    expect(sw).toContain("e.request.mode !== 'navigate'");
    expect(sw).toContain('__JF_BASE_HINT__');
    expect(() => new Function(sw)).not.toThrow();
  });
});
