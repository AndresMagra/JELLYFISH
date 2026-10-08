import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { errorText } from '../lib/api';

// ───────────── Botones y etiquetas ─────────────

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  small?: boolean;
  busy?: boolean;
}

export function Button({
  variant = 'primary',
  small,
  busy,
  children,
  disabled,
  className,
  ...rest
}: BtnProps) {
  const cls = ['btn', variant === 'primary' ? '' : variant, small ? 'small' : '', className ?? '']
    .join(' ')
    .trim();
  return (
    <button {...rest} className={cls} disabled={disabled || busy} aria-busy={busy}>
      {busy ? '…' : children}
    </button>
  );
}

export type Tone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export function Badge({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone === 'info' ? '' : tone}`.trim()}>{children}</span>;
}

// ───────────── Contenedores ─────────────

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ''}`.trim()}>
      {title || actions ? (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          <div className="row">{actions}</div>
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <div className="muted">{subtitle}</div> : null}
      </div>
      <div className="row wrap">{actions}</div>
    </div>
  );
}

const CONTROL = 'input:not([type="hidden"]), select, textarea';

/**
 * La etiqueta queda asociada al primer control de adentro (aunque esté envuelto en otro elemento) y el
 * error o la ayuda se leen como su descripción. Un control que ya trae su propio nombre no se toca.
 */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  const uid = useId();
  const box = useRef<HTMLDivElement>(null);
  const labelEl = useRef<HTMLLabelElement>(null);
  const marked = useRef<HTMLElement | null>(null);
  const messageId = `${uid}-msg`;
  const hasMessage = !!(error || hint);

  useLayoutEffect(() => {
    const control = box.current?.querySelector<HTMLElement>(CONTROL);
    if (!control || !labelEl.current) return;
    if (!control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby')) {
      if (!control.id) control.id = `${uid}-control`;
      labelEl.current.htmlFor = control.id;
    }
    if (hasMessage) control.setAttribute('aria-describedby', messageId);
    else control.removeAttribute('aria-describedby');
    if (error) {
      control.setAttribute('aria-invalid', 'true');
      marked.current = control;
    } else if (marked.current === control) {
      control.removeAttribute('aria-invalid');
      marked.current = null;
    }
  });

  return (
    <div className="field" ref={box}>
      <label ref={labelEl}>{label}</label>
      {children}
      {error ? (
        <span className="err" id={messageId}>
          {error}
        </span>
      ) : hint ? (
        <span className="muted small" id={messageId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Empty({ title, text }: { title: string; text?: string }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <h2>{title}</h2>
      {text ? <p className="muted">{text}</p> : null}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/** Lo que se puede alcanzar con Tab dentro de `root`: sin desactivados ni ocultos. */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.matches(':disabled') &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden',
  );
}

/**
 * Diálogo accesible: al abrir enfoca el primer control (o el propio diálogo), Tab y Mayús+Tab no lo
 * sacan, Escape lo cierra (salvo con `busy`: hay un guardado en curso) y al cerrar el foco vuelve a
 * lo que lo abrió.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  busy,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, busy });
  useEffect(() => {
    latest.current = { onClose, busy };
  });
  // Lo que tenía el foco al abrir: se lee al renderizar, antes de que un campo con autoFocus se lo lleve.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const box = dialog.current;
    if (!box) return;
    // Un campo con autoFocus ya se llevó el foco: no se le quita.
    if (!box.contains(document.activeElement)) {
      const control = box.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      );
      (control ?? box).focus();
    }
    const isTop = () => {
      const all = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      return all[all.length - 1] === box;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented || latest.current.busy) return;
        e.preventDefault();
        latest.current.onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusablesIn(box);
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        box.focus();
      } else if (!box.contains(active) || active === box) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Por si el foco se escapa de otra forma (un clic fuera, un script): se devuelve al diálogo.
    const onFocusIn = (e: FocusEvent) => {
      if (isTop() && e.target instanceof Node && !box.contains(e.target)) {
        (focusablesIn(box)[0] ?? box).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialog}
      >
        <div className="row between">
          <h2>{title}</h2>
          <Button variant="ghost" small onClick={onClose} aria-label="Cerrar">
            ✕
          </Button>
        </div>
        {children}
        {footer ? (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Pestañas con el patrón WAI-ARIA: la pestaña activa apunta a su panel (`aria-controls`), solo ella
 * entra en el orden de Tab y las flechas izquierda/derecha (y Inicio/Fin) cambian de pestaña.
 */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  testIdPrefix,
  children,
}: {
  tabs: readonly (readonly [K, string])[];
  value: K;
  onChange: (key: K) => void;
  /** `data-testid` de cada pestaña: `${testIdPrefix}${clave}`. */
  testIdPrefix: string;
  /** El contenido de la pestaña activa. */
  children: ReactNode;
}) {
  const uid = useId();
  const tabId = (k: K) => `${uid}-tab-${k}`;
  const panelId = `${uid}-panel`;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex(([k]) => k === value);
    const next =
      e.key === 'ArrowRight'
        ? (at + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : -1;
    const target = tabs[next];
    if (!target) return;
    e.preventDefault();
    onChange(target[0]);
    document.getElementById(tabId(target[0]))?.focus();
  };

  return (
    <>
      <div className="tabs" role="tablist" onKeyDown={onKeyDown}>
        {tabs.map(([k, label]) => (
          <button
            key={k}
            id={tabId(k)}
            type="button"
            role="tab"
            aria-selected={value === k}
            aria-controls={value === k ? panelId : undefined}
            tabIndex={value === k ? 0 : -1}
            className={`tab ${value === k ? 'active' : ''}`.trim()}
            onClick={() => onChange(k)}
            data-testid={`${testIdPrefix}${k}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={tabId(value)}>
        {children}
      </div>
    </>
  );
}

export function Loading({ text = 'Cargando…' }: { text?: string }) {
  return (
    <div className="muted" style={{ padding: 30, textAlign: 'center' }}>
      {text}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="card" style={{ borderColor: '#dc2626' }}>
      <strong>No pudimos cargar esto.</strong>
      <div className="muted">{errorText(error)}</div>
      {onRetry ? (
        <Button variant="secondary" small onClick={onRetry} style={{ marginTop: 10 }}>
          Reintentar
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Un refresco falló pero la pantalla ya tenía datos: se conservan (la tabla no se borra) y se avisa
 * con calma. El `ErrorBox` grande queda para cuando no hay nada que mostrar.
 */
export function StaleNote({
  error,
  onRetry,
  busy,
}: {
  error: unknown;
  onRetry: () => void;
  busy?: boolean;
}) {
  return (
    <div className="stale-note" role="status" data-testid="stale-note">
      <span>
        No pudimos actualizar esto ({errorText(error)}) Lo que ves puede estar desactualizado.
      </span>
      <Button variant="ghost" small busy={busy} onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}

// ───────────── Avisos ─────────────

interface Toast {
  id: number;
  text: string;
  error: boolean;
}
const ToastCtx = createContext<{
  notify: (text: string) => void;
  fail: (e: unknown) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 7000 : 3500);
  }, []);
  const value = {
    notify: (text: string) => push(text, false),
    fail: (e: unknown) => push(errorText(e), true),
  };
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`.trim()}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast fuera de <ToastProvider>');
  return ctx;
}
