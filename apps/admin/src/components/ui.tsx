import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ButtonHTMLAttributes,
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
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error ? (
        <span className="err">{error}</span>
      ) : hint ? (
        <span className="muted small">{hint}</span>
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

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
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
