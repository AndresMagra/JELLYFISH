import type { ApiErrorBody } from '@jellyfish/shared';
import { API_URL } from '../lib/config';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let getToken: () => string | null = () => null;
let onUnauthorized: () => void = () => {};

/** La sesión registra aquí cómo obtener el token y qué hacer si el servidor responde 401. */
export function configureApi(opts: { getToken: () => string | null; onUnauthorized: () => void }) {
  getToken = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** No cierra la sesión si el servidor responde 401 (p. ej. al verificar el código). */
  silent401?: boolean;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(`${API_URL}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(
      'network',
      'No pudimos conectarnos. Revisa tu internet e intenta de nuevo.',
      0,
    );
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* respuesta no JSON */
  }

  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    if (res.status === 401 && !opts.silent401) onUnauthorized();
    throw new ApiError(
      err?.code ?? 'http_error',
      err?.message ?? 'Algo salió mal. Intenta de nuevo.',
      res.status,
      err?.details,
    );
  }
  return data as T;
}

/** Mensaje amigable para mostrar a la persona. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Algo salió mal. Intenta de nuevo.';
}
