import { afterAll, describe, expect, it } from 'vitest';
import * as shortcuts from '../src/shortcuts';
import { cleanMutants, expectKilled, loadMutant } from './mutation-lib';

type Api = typeof shortcuts;

/** Un almacenamiento de mentira (como localStorage / sessionStorage). */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function suite(api: Api): void {
  // ── ?speed= y #rapido ──
  expect(api.parseSpeed('?speed=3')).toBe(3);
  expect(api.parseSpeed('?a=1&speed=0.5')).toBe(0.5);
  expect(api.parseSpeed('?speed=0.1')).toBe(0.1);
  expect(api.parseSpeed('?speed=60')).toBe(60);
  for (const bad of ['', '?speed=0', '?speed=0.09', '?speed=-2', '?speed=abc', '?speed=61', '?speed=1000', undefined])
    expect(api.parseSpeed(bad), String(bad)).toBe(1);
  // El visor solo deja pasar el #ancla: ahí viajan las velocidades con nombre.
  expect(api.parseSpeed('', '#rapido')).toBe(3);
  expect(api.parseSpeed('', '#muyrapido')).toBe(10);
  expect(api.parseSpeed('', '#lento')).toBe(0.5);
  expect(api.parseSpeed('', '#RAPIDO')).toBe(3);
  expect(api.parseSpeed('', '#otra-cosa')).toBe(1);
  // Si hay las dos, manda ?speed=.
  expect(api.parseSpeed('?speed=2', '#rapido')).toBe(2);

  expect(api.parseShortcuts('', '')).toEqual({ speed: 1, reset: null });
  expect(api.parseShortcuts('?reset=1', '')).toEqual({ speed: 1, reset: 'query' });
  expect(api.parseShortcuts('?reset=2', '')).toEqual({ speed: 1, reset: null });
  expect(api.parseShortcuts('', '#reiniciar')).toEqual({ speed: 1, reset: 'anchor' });
  expect(api.parseShortcuts('?speed=3&reset=1', '#reiniciar')).toEqual({ speed: 3, reset: 'query' });

  // ── carpeta de la página para las fotos ──
  expect(api.photoBaseFrom('https://h.example/x/y/z/artifact.html?a=1', '/x/y/z')).toBe('https://h.example/x/y/z/');
  expect(api.photoBaseFrom('https://h.example/', '')).toBe('https://h.example/');
  expect(api.photoBaseFrom('https://h.example/', undefined)).toBe('https://h.example/');
  expect(api.photoBaseFrom('https://h.example/mi%20vista/', '/mi%20vista')).toBe('https://h.example/mi%20vista/');
  expect(api.photoBaseFrom('https://h.example/x/', '/x/')).toBe('https://h.example/x/');
  expect(api.photoBaseFrom('no es una url', '/x')).toBeUndefined();

  // ── almacenamiento que lanza ──
  const throwing = {
    get localStorage(): never {
      throw new DOMException('bloqueado', 'SecurityError');
    },
    sessionStorage: 'ok',
  };
  expect(api.storageOf(throwing, 'localStorage')).toBeUndefined();
  expect(api.storageOf(throwing, 'sessionStorage')).toBe('ok');

  // ── borrar solo lo nuestro ──
  const store = fakeStorage({ 'jellyfish.token': 't', 'jellyfish.demo.abc': '{}', 'jellyfish.cart': '[]', otro: 'x', 'jf-reset-done': '1' });
  expect(api.clearStoredKeys(store)).toBe(3);
  expect([...store.data.keys()].sort()).toEqual(['jf-reset-done', 'otro']);
  expect(api.clearStoredKeys(undefined)).toBe(0);
  expect(
    api.clearStoredKeys({
      length: 1,
      key: () => {
        throw new Error('bloqueado');
      },
      removeItem: () => {},
    }),
  ).toBe(0);

  // ── ?reset=1: borra siempre y se quita de la dirección ──
  const calls: string[] = [];
  const env = (search: string, hash: string, local = fakeStorage({ 'jellyfish.token': 't' }), session = fakeStorage()) => ({
    localStorage: local,
    sessionStorage: session,
    history: { state: { a: 1 }, replaceState: (_s: unknown, _t: string, url: string) => void calls.push(url) },
    location: { pathname: '/x/y/z/', search, hash },
  });
  const q = env('?speed=3&reset=1', '#rapido');
  expect(api.applyReset('query', q)).toBe(true);
  expect(q.localStorage.data.size).toBe(0);
  expect(calls.at(-1)).toBe('/x/y/z/?speed=3#rapido');
  const q2 = env('?reset=1', '');
  api.applyReset('query', q2);
  expect(calls.at(-1)).toBe('/x/y/z/');
  const q3 = env('?reset=1&speed=3', '');
  api.applyReset('query', q3);
  expect(calls.at(-1)).toBe('/x/y/z/?speed=3');
  // Sin reset, no hace nada.
  const none = env('', '');
  expect(api.applyReset(null, none)).toBe(false);
  expect(none.localStorage.data.size).toBe(1);
  // Un marco que no deja reescribir la dirección: borra igual y no lanza.
  const stuck = env('?reset=1', '');
  stuck.history.replaceState = () => {
    throw new DOMException('no', 'SecurityError');
  };
  expect(() => api.applyReset('query', stuck)).not.toThrow();
  expect(stuck.localStorage.data.size).toBe(0);

  // ── #reiniciar: borra UNA vez por sesión del navegador (el ancla se queda en la dirección) ──
  const local = fakeStorage({ 'jellyfish.token': 't' });
  const session = fakeStorage();
  expect(api.applyReset('anchor', env('', '#reiniciar', local, session))).toBe(true);
  expect(local.data.size).toBe(0);
  local.setItem('jellyfish.token', 'nuevo');
  expect(api.applyReset('anchor', env('', '#reiniciar', local, session))).toBe(false); // recargar no vuelve a borrar
  expect(local.getItem('jellyfish.token')).toBe('nuevo');
  expect(session.getItem(api.RESET_FLAG)).toBe('1');
  expect(api.RESET_FLAG.startsWith(api.STORAGE_PREFIX)).toBe(false); // el propio reinicio no borra su marca
  // Sin sessionStorage (bloqueado): borra al abrir y no lanza.
  const blocked = {
    localStorage: fakeStorage({ 'jellyfish.token': 't' }),
    get sessionStorage(): never {
      throw new DOMException('bloqueado', 'SecurityError');
    },
    location: { pathname: '/', search: '', hash: '#reiniciar' },
  };
  expect(() => api.applyReset('anchor', blocked)).not.toThrow();
  expect(blocked.localStorage.data.size).toBe(0);
}

describe('atajos de la vista previa', () => {
  afterAll(cleanMutants);

  it('?speed=, ?reset=1, #rapido, #reiniciar, fotos y almacenamiento bloqueado', () => suite(shortcuts));

  it('detecta cada mutación de los atajos', async () => {
    const file = new URL('../src/shortcuts.ts', import.meta.url).pathname;
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      ['acepta velocidades absurdas', [['n >= 0.1 && n <= 60', 'n >= 0.1']]],
      ['acepta velocidad 0', [['n >= 0.1 &&', 'n >= 0 &&']]],
      ['#rapido ya no acelera', [['rapido: 3,', 'rapido: 1,']]],
      ['el ancla manda sobre ?speed=', [['if (raw) {', 'if (false) {']]],
      ['#reiniciar no se reconoce', [["anchorName(hash) === 'reiniciar'", "anchorName(hash) === 'nada'"]]],
      ['#reiniciar borra en cada recarga', [['if (session?.getItem(RESET_FLAG)) return false;', '']]],
      ['la marca de reinicio se borra con el reinicio', [["export const RESET_FLAG = 'jf-reset-done';", "export const RESET_FLAG = 'jellyfish-reset-done';"]]],
      ['se borra todo el almacenamiento, no solo lo nuestro', [['if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);', 'if (k) keys.push(k);']]],
      ['?reset=1 se queda en la dirección', [["env.history?.replaceState(env.history.state, '', env.location.pathname + search + env.location.hash);", '']]],
      ['la carpeta de la página ignora la ruta de archivos', [['const dir = `${(assets ?? \'\').replace(/\\/+$/, \'\')}/`;', "const dir = '/';"]]],
      ['localStorage bloqueado rompe el arranque', [['  try {\n    return (env as Record<string, unknown>)[name] as T | undefined;\n  } catch {\n    return undefined;\n  }', '  return (env as Record<string, unknown>)[name] as T | undefined;']]],
      ['una dirección que no se puede reescribir rompe el arranque', [['    } catch {\n      /* un marco que no deja reescribir la dirección: se queda con ?reset=1 */\n    }', '    } finally {}']]],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<Api>(file, edits);
      expectKilled(name, () => suite(mutant));
    }
  });
});
