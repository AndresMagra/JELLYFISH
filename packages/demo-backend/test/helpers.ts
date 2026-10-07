import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CategoryDTO, ProductDTO } from '@jellyfish/shared';
import { type DemoOptions, type DemoServer, createDemoServer } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
export const catalogDir = join(here, '../../../data/catalog');

export const SEED_CSV = readFileSync(join(catalogDir, 'products.seed.csv'), 'utf8');
export const CATEGORIES = JSON.parse(readFileSync(join(catalogDir, 'categories.json'), 'utf8')) as {
  slug: string;
  name: string;
  tagline: string;
  sort: number;
}[];
const manifest = JSON.parse(readFileSync(join(catalogDir, 'photos.manifest.json'), 'utf8')) as {
  items: { sku: string; minUrl: string; illustrative: boolean }[];
};
export const PHOTOS = manifest.items.map((i) => ({
  sku: i.sku,
  url: i.minUrl,
  illustrative: i.illustrative,
}));

export const BASE = 'https://demo.jellyfish.local';

/** 10:00 en RD (UTC-4): la misma hora que usan las pruebas del API. */
export const T0 = Date.parse('2026-10-07T14:00:00Z');

export interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
  set: (ms: number) => void;
}

export function fakeClock(start = T0): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

export function makeServer(
  overrides: Partial<DemoOptions> = {},
  clock: FakeClock = fakeClock(),
): { server: DemoServer; clock: FakeClock } {
  const server = createDemoServer({
    baseUrl: BASE,
    catalogCsv: SEED_CSV,
    categories: CATEGORIES,
    photos: PHOTOS,
    storage: null,
    latencyMs: 0,
    seed: 7,
    now: clock.now,
    ...overrides,
  });
  return { server, clock };
}

export interface CallResult<T = any> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

export interface Client {
  call<T = any>(
    method: string,
    path: string,
    opts?: { body?: unknown; token?: string | null; headers?: Record<string, string> },
  ): CallResult<T>;
  login(phone?: string): { token: string; userId: string };
}

export function clientFor(server: DemoServer): Client {
  const call: Client['call'] = (method, path, opts = {}) => {
    const res = server.handleSync({
      method,
      url: `${BASE}${path}`,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? null : JSON.stringify(opts.body),
    });
    return {
      status: res.status,
      headers: res.headers,
      body: res.body ? JSON.parse(res.body) : null,
    };
  };
  return {
    call,
    login(phone = '809-555-0101') {
      call('POST', '/v1/auth/otp/request', { body: { phone } });
      const v = call('POST', '/v1/auth/otp/verify', { body: { phone, code: '123456' } });
      return { token: v.body.token, userId: v.body.user.id };
    },
  };
}

export function allProducts(c: Client): ProductDTO[] {
  return c.call('GET', '/v1/products?limit=100').body.items;
}

export function categories(c: Client): CategoryDTO[] {
  return c.call('GET', '/v1/categories').body;
}

export function variantBySku(c: Client, sku: string) {
  for (const p of allProducts(c)) {
    const v = p.variants.find((x) => x.sku === sku);
    if (v) return v;
  }
  throw new Error(`No existe ${sku}`);
}

export const ADDRESS = {
  label: 'Casa',
  line1: 'Calle Max Henríquez Ureña 10',
  reference: 'Al lado del colmado Don Pepe, portón negro',
  sector: 'Naco',
  city: 'Santo Domingo',
  latitude: 18.4861,
  longitude: -69.9312,
  contactPhone: null,
};

/** Hace un pedido de ~RD$ 1,000 de camarón y devuelve todo lo necesario para seguirlo. */
export function placeOrder(
  c: Client,
  token: string,
  opts: {
    paymentMethod?: 'cash' | 'card' | 'transfer';
    quantity?: number;
    sku?: string;
    key?: string;
    couponCode?: string;
  } = {},
) {
  const v = variantBySku(c, opts.sku ?? 'JF-MAR-004'); // camarón 16/20
  const addr = c.call('POST', '/v1/me/addresses', { token, body: ADDRESS });
  const slots = c.call('GET', '/v1/delivery/slots').body as { start: string }[];
  const res = c.call<any>('POST', '/v1/orders', {
    token,
    headers: { 'idempotency-key': opts.key ?? `k-${Math.random().toString(36).slice(2, 12)}` },
    body: {
      items: [{ variantId: v.id, quantity: opts.quantity ?? 400 }],
      addressId: addr.body.id,
      slotStart: slots[0]!.start,
      paymentMethod: opts.paymentMethod ?? 'cash',
      ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
    },
  });
  return { res, variant: v, addressId: addr.body.id as string, slots };
}
