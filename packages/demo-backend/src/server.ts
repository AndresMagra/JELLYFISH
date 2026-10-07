import { type DemoCatalog, buildCatalog } from './catalog';
import type { Cfg, Ctx } from './context';
import { DEFAULT_COUPONS } from './coupons';
import { advanceAll } from './orders';
import { type DemoRequest, type DemoResponse, dispatch } from './router';
import { clearState, defaultStorage, freshState, loadState, saveState } from './state';
import type { DemoOptions, DemoState, KeyValueStorage, LifecycleStage } from './types';
import { type Random, fnv1a, mulberry32 } from './util';
import { DEFAULT_ZONE, makeZone } from './zones';

/** Código que se le muestra a la persona en la vista previa (cualquier código de 6 dígitos sirve). */
export type FetchInput = Parameters<typeof fetch>[0];
export type FetchInit = Parameters<typeof fetch>[1];

export const DEMO_OTP_CODE = '123456';

/** Duración base de cada etapa del pedido en segundos (antes de dividir entre la velocidad). */
export const DEFAULT_STAGE_SECONDS: Record<LifecycleStage, number> = {
  confirmed: 25,
  picking: 20,
  packed: 20,
  out_for_delivery: 30,
};

const DEFAULT_TRANSFER_INFO = {
  bank: 'Banco de Pruebas',
  accountType: 'Cuenta corriente',
  accountNumber: '000-000000-0',
  holder: 'JELLYFISH SRL (PRUEBA)',
  taxId: '000-00000-0',
};

export interface DemoServer {
  readonly baseUrl: string;
  readonly catalog: DemoCatalog;
  /** Estado y reglas (para inspeccionar en las pruebas; no lo uses desde la app). */
  readonly ctx: Ctx;
  /** Atiende una petición ya normalizada, sin latencia. Determinista con un reloj falso. */
  handleSync(req: DemoRequest): DemoResponse;
  /** Igual que `fetch`: devuelve una `Response`, con la latencia simulada. */
  fetch(input: FetchInput, init?: FetchInit): Promise<Response>;
  /** Pone al día los pedidos (etapas y pagos que ya tocaban) y guarda. */
  advance(): void;
  /** Borra todo lo guardado y vuelve al estado inicial. */
  reset(): void;
  /** Cuántos pedidos activos y cuántas sesiones hay (para mostrarlo en la consola). */
  summary(): { users: number; orders: number };
}

function resolveCfg(options: DemoOptions, baseUrl: string): Cfg {
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const secs = { ...DEFAULT_STAGE_SECONDS, ...options.stageSeconds };
  const stageMs = {
    confirmed: (secs.confirmed * 1000) / speed,
    picking: (secs.picking * 1000) / speed,
    packed: (secs.packed * 1000) / speed,
    out_for_delivery: (secs.out_for_delivery * 1000) / speed,
  };
  return {
    baseUrl,
    speed,
    stageMs,
    paymentApproveMs: (options.paymentApproveMs ?? 2000) / speed,
    transferVerifyMs: (options.transferVerifyMs ?? 6000) / speed,
    transferInfo: options.transferInfo ?? DEFAULT_TRANSFER_INFO,
    otpCode: options.otpCode ?? DEMO_OTP_CODE,
    strictOtp: options.strictOtp ?? false,
    reservationMinutesCard: 15,
    reservationMinutesTransfer: 120,
    authBufferBps: 1000,
    otpTtlMinutes: 10,
  };
}

/** Las URLs de la demostración empiezan con el baseUrl seguido de "/", "?" o nada. */
export function matchesBase(url: string, baseUrl: string): boolean {
  if (!url.startsWith(baseUrl)) return false;
  const next = url.charAt(baseUrl.length);
  return next === '' || next === '/' || next === '?' || next === '#';
}

export function createDemoServer(options: DemoOptions): DemoServer {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const catalog = buildCatalog(options);
  const cfg = resolveCfg(options, baseUrl);
  const storage: KeyValueStorage | null =
    options.storage === undefined ? defaultStorage() : options.storage;
  const storageKey = options.storageKey ?? 'jellyfish.demo.v1';
  const signature = `${catalog.signature}:${fnv1a(JSON.stringify(options.zone ?? null))}`;
  const lastSaved = { text: '' };
  const now = options.now ?? (() => Date.now());
  const zone = makeZone(options.zone ?? DEFAULT_ZONE);

  const loaded = loadState(storage, storageKey, signature);
  const state: DemoState = loaded ?? freshState(signature);

  // Con semilla fija (pruebas), un servidor que continúa un estado guardado no repite los mismos ids.
  const entropy = state.orders.length * 7919 + state.users.length * 104729 + state.addresses.length;
  const rng: Random =
    options.random ??
    (options.seed !== undefined ? mulberry32(options.seed + entropy) : Math.random);

  const ctx: Ctx = {
    state,
    catalog,
    zone,
    cfg,
    coupons: options.coupons ?? DEFAULT_COUPONS,
    rng,
    now,
  };

  const persist = () => saveState(storage, storageKey, ctx.state, lastSaved);

  function handleSync(req: DemoRequest): DemoResponse {
    advanceAll(ctx);
    const res = dispatch(ctx, req);
    persist();
    return res;
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function serverFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    const isRequest = typeof input === 'object' && 'url' in input && 'method' in input;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (isRequest ? (input as Request).method : 'GET');
    const headers: Record<string, string> = {};
    const collect = (h: NonNullable<FetchInit>['headers'] | undefined) => {
      if (!h) return;
      new Headers(h).forEach((v, k) => {
        headers[k] = v;
      });
    };
    if (isRequest) collect((input as Request).headers);
    collect(init?.headers);
    let body: string | null = null;
    if (typeof init?.body === 'string') body = init.body;
    else if (init?.body === undefined && isRequest && method !== 'GET' && method !== 'HEAD') {
      body = await (input as Request).clone().text();
    }
    if ((options.latencyMs ?? 120) > 0) await sleep(options.latencyMs ?? 120);
    const res = handleSync({ method, url, headers, body });
    return new Response(res.status === 204 ? null : res.body, {
      status: res.status,
      headers: res.headers,
    });
  }

  return {
    baseUrl,
    catalog,
    ctx,
    handleSync,
    fetch: serverFetch,
    advance() {
      advanceAll(ctx);
      persist();
    },
    reset() {
      clearState(storage, storageKey);
      lastSaved.text = '';
      const fresh = freshState(signature);
      // Se vacía y se rellena el MISMO objeto: `ctx.state` sigue siendo la referencia vigente.
      for (const k of Object.keys(ctx.state) as (keyof DemoState)[])
        delete (ctx.state as Partial<DemoState>)[k];
      Object.assign(ctx.state, fresh);
    },
    summary() {
      return { users: state.users.length, orders: state.orders.length };
    },
  };
}
