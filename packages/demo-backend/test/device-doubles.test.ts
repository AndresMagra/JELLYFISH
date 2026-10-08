import { afterAll, describe, expect, it } from 'vitest';
import * as doubles from '../src/device-doubles';
import { cleanMutants, expectKilledAsync, loadMutant } from './mutation-lib';

type Api = typeof doubles;

/** Planificador de mentira: guarda lo pendiente y lo corre cuando la prueba lo decide. */
function fakeClock() {
  const queue: { fn: () => void; ms: number }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      queue.push({ fn, ms });
      return queue.length;
    },
    /** Corre lo que hay pendiente en este momento (lo que se agregue mientras tanto queda para la próxima). */
    flush() {
      const now = queue.splice(0);
      for (const t of now) t.fn();
      return now.length;
    },
    pending: () => queue.length,
  };
}

/** Un navegador de mentira con `geolocation` y `permissions` en el prototipo, como el de verdad. */
function fakeNavigator() {
  const proto = {
    get geolocation() {
      return { real: true };
    },
    permissions: {
      query: (d: { name?: string }) =>
        Promise.resolve({ name: d.name, state: 'denied', real: true }),
    },
  };
  return Object.create(proto) as Record<string, unknown> & {
    permissions: { query: (d: { name?: string }) => Promise<unknown> };
  };
}

async function suite(api: Api): Promise<void> {
  // ── ubicación ──
  const clock = fakeClock();
  const geo = api.createGeolocationDouble({
    now: () => 1234,
    schedule: clock.schedule,
    watchEveryMs: 5000,
  });
  const seen: { coords: Record<string, unknown>; timestamp: number }[] = [];
  geo.getCurrentPosition((p) => seen.push(p as never));
  expect(seen).toHaveLength(0); // el GPS de verdad no contesta al instante
  clock.flush();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.coords.latitude).toBe(18.4861);
  expect(seen[0]!.coords.longitude).toBe(-69.9312);
  expect(seen[0]!.coords.accuracy).toBe(35);
  expect(seen[0]!.timestamp).toBe(1234);

  // watchPosition repite hasta que se llama clearWatch.
  const ticks: number[] = [];
  const id = geo.watchPosition(() => ticks.push(1));
  clock.flush();
  clock.flush();
  expect(ticks.length).toBe(2);
  geo.clearWatch(id);
  clock.flush();
  expect(ticks.length).toBe(2);
  expect(clock.pending()).toBe(0);
  const id2 = geo.watchPosition(() => {});
  expect(id2).not.toBe(id);

  // permisos: como un navegador de verdad, empieza en 'prompt' y pasa a 'granted' al entregar la primera posición.
  expect(api.createPermissionStatus().state).toBe('granted');
  expect(api.createPermissionStatus({ state: 'prompt' }).state).toBe('prompt');

  const nav = fakeNavigator();
  const handle = api.installGeolocationDouble(nav, { schedule: clock.schedule });
  expect(handle.installed).toEqual({ geolocation: true, permissions: true });
  // Antes de la primera lectura el permiso está por preguntar: la app muestra su propia explicación…
  expect(await nav.permissions.query({ name: 'geolocation' })).toMatchObject({
    name: 'geolocation',
    state: 'prompt',
  });
  expect(await nav.permissions.query({ name: 'camera' })).toMatchObject({
    state: 'denied',
    real: true,
  });
  const fix: number[] = [];
  (
    nav.geolocation as {
      getCurrentPosition(cb: (p: { coords: { latitude: number } }) => void): void;
    }
  ).getCurrentPosition((p) => fix.push(p.coords.latitude));
  expect(await nav.permissions.query({ name: 'geolocation' })).toMatchObject({ state: 'prompt' }); // aún no contesta
  clock.flush();
  expect(fix).toEqual([18.4861]);
  // …y después de dar la posición, concedido (como el navegador cuando la persona toca "Permitir").
  expect(await nav.permissions.query({ name: 'geolocation' })).toMatchObject({ state: 'granted' });
  handle.uninstall();
  expect(nav.geolocation).toEqual({ real: true });
  expect(await nav.permissions.query({ name: 'geolocation' })).toMatchObject({ state: 'denied' });

  // Con el permiso ya concedido de entrada (opción), se contesta 'granted' desde la primera consulta.
  const pre = fakeNavigator();
  api.installGeolocationDouble(pre, { initialPermission: 'granted', schedule: clock.schedule });
  expect(await pre.permissions.query({ name: 'geolocation' })).toMatchObject({ state: 'granted' });

  // Safari viejo / visor sin `permissions`: se crea uno mínimo y se retira al desinstalar.
  const bare: Record<string, unknown> = {};
  const h2 = api.installGeolocationDouble(bare);
  expect(h2.installed.permissions).toBe(true);
  expect(
    await (bare.permissions as { query: (d: unknown) => Promise<{ state: string }> }).query({
      name: 'geolocation',
    }),
  ).toMatchObject({ state: 'prompt' });
  await expect(
    (bare.permissions as { query: (d: unknown) => Promise<unknown> }).query({ name: 'camera' }),
  ).rejects.toBeInstanceOf(TypeError);
  h2.uninstall();
  expect('permissions' in bare).toBe(false);

  // Un navegador que no deja redefinir nada: no lanza y lo dice.
  const frozen = Object.freeze({
    geolocation: 1,
    permissions: Object.freeze({ query: () => Promise.resolve(1) }),
  });
  const h3 = api.installGeolocationDouble(frozen);
  expect(h3.installed).toEqual({ geolocation: false, permissions: false });
  expect(() => h3.uninstall()).not.toThrow();

  // ── window.open ──
  const shown: ReturnType<typeof api.noticeForOpen>[] = [];
  const win: { open?: unknown } = { open: () => 'original' };
  const guard = api.installOpenGuard(win, (n) => shown.push(n));
  const result = (win.open as (u?: string) => unknown)(
    'https://www.google.com/maps/search/?api=1&query=18.48,-69.93',
  );
  expect(result).toBeNull(); // igual que el visor, pero ahora la persona lo ve
  expect(shown).toHaveLength(1);
  expect(shown[0]!.text).toMatch(/Vista previa/);
  expect(shown[0]!.text).toMatch(/mapa/);
  expect(shown[0]!.href).toBe('https://www.google.com/maps/search/?api=1&query=18.48,-69.93');
  expect(shown[0]!.linkLabel).toBe('Abrir el mapa');
  // Un enlace que no es del mapa: aviso genérico, con el enlace.
  (win.open as (u?: string) => unknown)('https://ejemplo.do/pasarela?x=1');
  expect(shown[1]!.text).toMatch(/otras pestañas/);
  expect(shown[1]!.linkLabel).toBe('Abrir el enlace');
  expect(shown[1]!.href).toBe('https://ejemplo.do/pasarela?x=1');
  // Esquemas que NO son web jamás se vuelven enlace (un `javascript:` en un aviso sería un agujero).
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'jellyfish://order/1',
    '',
    undefined,
    null,
  ]) {
    (win.open as (u?: unknown) => unknown)(url);
    expect(shown.at(-1)!.href, String(url)).toBeNull();
  }
  guard.uninstall();
  expect((win.open as () => string)()).toBe('original');

  // `open` heredado del prototipo (como en un navegador de verdad): al desinstalar vuelve a funcionar el original.
  const inherited = Object.create({ open: () => 'del prototipo' }) as { open: () => unknown };
  const guard2 = api.installOpenGuard(inherited, () => {});
  expect(inherited.open()).toBeNull();
  guard2.uninstall();
  expect(inherited.open()).toBe('del prototipo');

  // Mostrar el aviso nunca rompe la app.
  const win2: { open?: unknown } = {};
  api.installOpenGuard(win2, () => {
    throw new Error('el DOM no está');
  });
  expect(() => (win2.open as () => unknown)()).not.toThrow();
  expect((win2.open as () => unknown)()).toBeNull();
  // Una ventana donde `open` no se puede reemplazar: no lanza.
  expect(() => api.installOpenGuard(Object.freeze({ open: () => 1 }), () => {})).not.toThrow();
}

describe('dobles de lo que el visor no deja hacer', () => {
  afterAll(cleanMutants);

  it('ubicación fija de Santo Domingo, permiso concedido, window.open con aviso', () =>
    suite(doubles));

  it('el punto de ejemplo está dentro de la zona que cubre la demostración', () => {
    expect(doubles.DEMO_POSITION).toEqual({
      latitude: 18.4861,
      longitude: -69.9312,
      accuracyM: 35,
    });
  });

  it('detecta cada mutación de los dobles', async () => {
    const file = new URL('../src/device-doubles.ts', import.meta.url).pathname;
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      ['la posición cambia', [['latitude: 18.4861', 'latitude: 18.5']]],
      ['la longitud cambia de signo', [['longitude: -69.9312', 'longitude: 69.9312']]],
      [
        'la ubicación contesta en el mismo instante',
        [
          [
            '      schedule(() => {\n        permission.state',
            '      ((fn: () => void) => fn())(() => {\n        permission.state',
          ],
          [
            '        success(makePosition(now));\n      }, 120);',
            '        success(makePosition(now));\n      });',
          ],
        ],
      ],
      ['clearWatch no detiene nada', [['watchers.delete(id);', '']]],
      [
        'el permiso nunca pasa a concedido',
        [
          [
            "        permission.state = 'granted'; // al dar la primera posición el navegador ya tiene el permiso\n",
            '',
          ],
        ],
      ],
      [
        'el permiso empieza concedido (la app no explica nada)',
        [
          [
            "state: options.initialPermission ?? 'prompt',",
            "state: options.initialPermission ?? 'granted',",
          ],
        ],
      ],
      [
        'la consulta siempre contesta lo mismo',
        [['state: permission.state,', "state: 'granted' as const,"]],
      ],
      ['se concede cualquier permiso', [["descriptor.name === 'geolocation'", 'true']]],
      [
        'window.open devuelve algo en vez de null',
        [
          [
            '        return null;\n      },\n      configurable',
            '        return {} as never;\n      },\n      configurable',
          ],
        ],
      ],
      ['no se avisa al abrir', [['show(noticeForOpen(url));', '']]],
      [
        'un javascript: se vuelve enlace',
        [["if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {", 'if (true) {']],
      ],
      [
        'el mapa no se reconoce',
        [
          [
            'const isMap = href !== null && (MAP_HOSTS.test(host) || /maps/i.test(href));',
            'const isMap = false;',
          ],
        ],
      ],
      ['desinstalar no devuelve window.open', [['else target.open = original;', '']]],
      [
        'una excepción del aviso rompe la app',
        [
          [
            '        } catch {\n          /* mostrar el aviso nunca debe romper la app */\n        }',
            '        } finally {}',
          ],
        ],
      ],
      [
        'instalar lanza en un navegador cerrado',
        [
          [
            '  } catch {\n    /* el navegador no deja redefinirla: la app mostrará su aviso normal de "no pudimos leer tu ubicación" */\n  }',
            '  } finally {}',
          ],
        ],
      ],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<Api>(file, edits);
      await expectKilledAsync(name, () => suite(mutant));
    }
  });
});
