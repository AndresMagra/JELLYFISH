import type { UserDTO } from '@jellyfish/shared';
import { normalizeDominicanPhone } from '@jellyfish/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Button, Field } from './components/ui';
import { api, errorText, setUnauthorizedHandler, tokenStore } from './lib/api';

interface AuthValue {
  user: UserDTO;
  isAdmin: boolean;
  signOut: () => void;
}
const AuthCtx = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth fuera de <AuthProvider>');
  return ctx;
}

type State =
  { status: 'loading' } | { status: 'out'; notice?: string } | { status: 'in'; user: UserDTO };

/** Muestra el panel solo a personal autorizado; todo lo demás ve el inicio de sesión. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const qc = useQueryClient();

  const signOut = useCallback(
    (notice?: string) => {
      tokenStore.clear();
      qc.clear();
      setState({ status: 'out', notice });
    },
    [qc],
  );

  useEffect(() => {
    setUnauthorizedHandler(() => signOut('Tu sesión venció. Entra de nuevo.'));
    if (!tokenStore.get()) {
      setState({ status: 'out' });
      return;
    }
    api<UserDTO>('/v1/me', { silent401: true })
      .then((user) =>
        user.role === 'admin' || user.role === 'staff'
          ? setState({ status: 'in', user })
          : signOut('Tu cuenta no tiene acceso al panel.'),
      )
      .catch(() => signOut());
  }, [signOut]);

  if (state.status === 'loading') return <div className="login muted">Cargando…</div>;
  if (state.status === 'out') {
    return (
      <Login
        notice={state.notice}
        onDone={(user) => {
          if (user.role === 'admin' || user.role === 'staff') setState({ status: 'in', user });
          else {
            tokenStore.clear();
            setState({
              status: 'out',
              notice: 'Tu cuenta no tiene acceso al panel. Pide al administrador que te dé acceso.',
            });
          }
        }}
      />
    );
  }
  return (
    <AuthCtx.Provider
      value={{ user: state.user, isAdmin: state.user.role === 'admin', signOut: () => signOut() }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

function Login({ onDone, notice }: { onDone: (u: UserDTO) => void; notice?: string }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = async () => {
    const e164 = normalizeDominicanPhone(phone);
    if (!e164) return setError('Ingresa un celular dominicano (809, 829 o 849).');
    setBusy(true);
    setError(null);
    try {
      await api('/v1/auth/otp/request', { method: 'POST', body: { phone: e164 }, silent401: true });
      setSent(e164);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!sent) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string; user: UserDTO }>('/v1/auth/otp/verify', {
        method: 'POST',
        body: { phone: sent, code },
        silent401: true,
      });
      tokenStore.set(res.token);
      onDone(res.user);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="card">
        <div className="brand" style={{ padding: 0 }}>
          <span className="bell" /> JELLYFISH
        </div>
        <div>
          <h1>Panel de administración</h1>
          <div className="muted">Entra con tu celular. Te enviamos un código por SMS.</div>
        </div>
        {notice ? <div className="banner warn">{notice}</div> : null}
        {!sent ? (
          <>
            <Field label="Celular" error={error}>
              <input
                className="input"
                data-testid="login-phone"
                inputMode="tel"
                placeholder="809 555 1234"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void request()}
                autoFocus
              />
            </Field>
            <Button onClick={request} busy={busy} data-testid="login-send">
              Enviarme el código
            </Button>
          </>
        ) : (
          <>
            <Field label={`Código enviado al ${sent}`} error={error}>
              <input
                className="input"
                data-testid="login-code"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && void verify()}
                autoFocus
              />
            </Field>
            <Button
              onClick={verify}
              busy={busy}
              disabled={code.length !== 6}
              data-testid="login-verify"
            >
              Entrar
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setSent(null);
                setCode('');
                setError(null);
              }}
            >
              Cambiar número
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
