import { afterAll, describe, expect, it } from 'vitest';
import * as toast from '../src/toast';
import { cleanMutants, expectKilled, loadMutant } from './mutation-lib';

type Api = typeof toast;

/** Un elemento del DOM de mentira con lo mínimo que usa el aviso. */
class FakeEl {
  hidden = true;
  id = '';
  textContent: string | null = null;
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  onclick: (() => void) | null = null;
  constructor(public tag: string) {}
  get firstChild() {
    return this.children[0] ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: unknown) {
    this.children.push(c as FakeEl);
    return c;
  }
  removeChild(c: unknown) {
    this.children = this.children.filter((x) => x !== c);
    return c;
  }
}

function fakeDoc(withToast: boolean) {
  const body = new FakeEl('body');
  const doc = {
    body,
    createElement: (tag: string) => new FakeEl(tag),
    getElementById: (id: string) => (id === 'jf-toast' && body.children.find((c) => c.id === 'jf-toast')) || null,
  };
  if (withToast) {
    const el = new FakeEl('div');
    el.id = 'jf-toast';
    body.appendChild(el);
  }
  return { doc, body };
}

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      set: (fn: () => void) => {
        pending.set(next, fn);
        return next++;
      },
      clear: (h: unknown) => void pending.delete(h as number),
    },
    pending,
    fireAll() {
      for (const [k, fn] of [...pending]) {
        pending.delete(k);
        fn();
      }
    },
  };
}

function suite(api: Api): void {
  expect(api.TOAST_ID).toBe('jf-toast');
  expect(api.TOAST_MS).toBeGreaterThanOrEqual(5000);

  // El elemento que trae la página se reutiliza; con enlace, texto y botón de cerrar.
  const { doc, body } = fakeDoc(true);
  const t = fakeTimers();
  const show = api.createNoticeToast(doc as never, t.timers);
  show({ text: 'Vista previa: no se abre el mapa.', href: 'https://maps.example/x', linkLabel: 'Abrir el mapa' });
  const el = body.children[0]!;
  expect(body.children).toHaveLength(1);
  expect(el.hidden).toBe(false);
  expect(el.children.map((c) => c.tag)).toEqual(['span', 'a', 'button']);
  expect(el.children[0]!.textContent).toBe('Vista previa: no se abre el mapa.');
  expect(el.children[1]!.attrs).toEqual({ href: 'https://maps.example/x', target: '_blank', rel: 'noopener noreferrer' });
  expect(el.children[1]!.textContent).toBe('Abrir el mapa');
  expect(el.children[2]!.attrs['aria-label']).toBe('Cerrar aviso');
  // El texto va como texto (nunca como HTML).
  show({ text: '<img src=x onerror=alert(1)>', href: null, linkLabel: '' });
  expect(el.children.map((c) => c.tag)).toEqual(['span', 'button']); // sin enlace si no hay dirección web
  expect(el.children[0]!.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(el.hidden).toBe(false);

  // Se cierra con la ×, y solo con un temporizador (el anterior se cancela al mostrar otro aviso).
  expect(t.pending.size).toBe(1);
  el.children[1]!.onclick!();
  expect(el.hidden).toBe(true);
  show({ text: 'otro', href: null, linkLabel: '' });
  expect(el.hidden).toBe(false);
  t.fireAll();
  expect(el.hidden).toBe(true);

  // Si la página no trae el elemento, se crea (accesible).
  const empty = fakeDoc(false);
  api.createNoticeToast(empty.doc as never, fakeTimers().timers)({ text: 'hola', href: null, linkLabel: '' });
  const created = empty.body.children[0]!;
  expect(created.id).toBe('jf-toast');
  expect(created.attrs).toMatchObject({ role: 'status', 'aria-live': 'polite' });
  expect(created.hidden).toBe(false);
}

describe('aviso de la vista previa', () => {
  afterAll(cleanMutants);

  it('muestra el aviso con enlace de verdad, se cierra y no inyecta HTML', () => suite(toast));

  it('detecta cada mutación del aviso', async () => {
    const file = new URL('../src/toast.ts', import.meta.url).pathname;
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      ['el aviso queda oculto', [['    el.hidden = false;\n    if (handle', '    if (handle']]],
      ['el texto se inserta sin escapar', [['text.textContent = notice.text;', '(text as unknown as { innerHTML: string }).innerHTML = notice.text; text.textContent = null;']]],
      ['el enlace no lleva rel=noopener', [["link.setAttribute('rel', 'noopener noreferrer');", '']]],
      ['el enlace se muestra aunque no haya dirección web', [['if (notice.href) {', 'if (true) {']]],
      ['el aviso no se cierra solo', [['    handle = timers.set(() => {\n      shown.hidden = true;\n    }, TOAST_MS);', '    handle = null;']]],
      ['el temporizador viejo cierra el aviso nuevo', [['if (handle !== null) timers.clear(handle);', '']]],
      ['la × no cierra', [['      shown.hidden = true;\n    };\n    el.appendChild(close);', '    };\n    el.appendChild(close);']]],
      ['el aviso anterior se queda debajo del nuevo', [['while (el.firstChild) el.removeChild(el.firstChild);', '']]],
      ['no se crea el elemento si falta', [['    if (!el) {', '    if (false as boolean) {']]],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<Api>(file, edits);
      expectKilled(name, () => suite(mutant));
    }
  });
});
