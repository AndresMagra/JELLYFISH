/**
 * El aviso de la vista previa (abajo en la pantalla). Solo toca el DOM a través de un contrato mínimo,
 * así se prueba con un documento falso en Node. El elemento `#jf-toast` lo trae la página; si no está,
 * se crea.
 */
import type { OpenNotice } from './device-doubles';

export interface ElementLike {
  hidden: boolean;
  textContent: string | null;
  firstChild: unknown;
  id?: string;
  setAttribute(name: string, value: string): void;
  appendChild(child: unknown): unknown;
  removeChild(child: unknown): unknown;
}

export interface DocumentLike {
  getElementById(id: string): ElementLike | null;
  createElement(tag: string): ElementLike;
  body: { appendChild(child: unknown): unknown };
}

interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const TOAST_ID = 'jf-toast';
export const TOAST_MS = 9000;

export function createNoticeToast(
  doc: DocumentLike,
  timers: Timers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): (notice: OpenNotice) => void {
  let handle: unknown = null;
  return (notice) => {
    let el = doc.getElementById(TOAST_ID);
    if (!el) {
      el = doc.createElement('div');
      el.id = TOAST_ID;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      doc.body.appendChild(el);
    }
    while (el.firstChild) el.removeChild(el.firstChild);
    const text = doc.createElement('span');
    text.textContent = notice.text;
    el.appendChild(text);
    if (notice.href) {
      // Un enlace de verdad: en el visor se abre en una pestaña nueva con un toque, sin `window.open`.
      const link = doc.createElement('a');
      link.setAttribute('href', notice.href);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.textContent = notice.linkLabel;
      el.appendChild(link);
    }
    const close = doc.createElement('button');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Cerrar aviso');
    close.textContent = '×';
    const shown = el;
    (close as unknown as { onclick: () => void }).onclick = () => {
      shown.hidden = true;
    };
    el.appendChild(close);
    el.hidden = false;
    if (handle !== null) timers.clear(handle);
    handle = timers.set(() => {
      shown.hidden = true;
    }, TOAST_MS);
  };
}
