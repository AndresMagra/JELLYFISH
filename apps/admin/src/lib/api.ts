import type { ApiErrorBody } from '@jellyfish/shared';

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const TOKEN_KEY = 'jellyfish.admin.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* sin almacenamiento: la sesión dura mientras no recargues */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nada */
    }
  },
};

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

interface Opts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Cuerpo de texto plano (CSV) en vez de JSON. */
  csv?: string;
  silent401?: boolean;
}

async function request(path: string, opts: Opts): Promise<Response> {
  const url = new URL(`${API_URL}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.csv !== undefined
          ? { 'Content-Type': 'text/csv' }
          : opts.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.csv ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    throw new ApiError('network', 'No se pudo conectar con el servidor.', 0);
  }
  if (!res.ok) {
    let err: ApiErrorBody['error'] | undefined;
    try {
      err = ((await res.json()) as ApiErrorBody).error;
    } catch {
      /* respuesta sin JSON */
    }
    if (res.status === 401 && !opts.silent401) onUnauthorized();
    throw new ApiError(
      err?.code ?? 'http_error',
      err?.message ?? 'Algo salió mal.',
      res.status,
      err?.details,
    );
  }
  return res;
}

export async function api<T>(path: string, opts: Opts = {}): Promise<T> {
  const res = await request(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Descarga un archivo autenticado (el navegador no manda el token en un enlace normal). */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await request(path, {});
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo salió mal.');
