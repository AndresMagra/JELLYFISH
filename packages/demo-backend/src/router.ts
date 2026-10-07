import type { OrderDTO } from '@jellyfish/shared';
import {
  authenticate,
  createAddress,
  deleteAccount,
  deleteAddress,
  listAddresses,
  openSession,
  publicUser,
  registerDevice,
  requestOtp,
  unregisterDevice,
  updateAddress,
  verifyOtp,
} from './auth';
import { getProductByGroup, listCategories, listProducts } from './catalog';
import { type Ctx, stockOf } from './context';
import { buildReorder, getTracking } from './delivery';
import { DemoError, invalid, notFound } from './errors';
import {
  cancelOrder,
  createOrder,
  findOwnOrder,
  listOrdersForUser,
  quoteOrder,
  startCardPayment,
  submitTransferProof,
  toOrderDTO,
} from './orders';
import {
  addressWithDefaultSchema,
  cancelBodySchema,
  createOrderBodySchema,
  deviceBodySchema,
  deviceTokenParamsSchema,
  groupParamsSchema,
  idParamsSchema,
  otpRequestBodySchema,
  otpVerifyBodySchema,
  parse,
  patchMeBodySchema,
  productsQuerySchema,
  quoteBodySchema,
  transferProofBodySchema,
  zoneQuerySchema,
} from './schemas';
import type { AddressSnapshot, UserRec } from './types';
import { findZone, listSlots, slotsToDTO } from './zones';

export interface DemoRequest {
  method: string;
  /** URL completa (con el baseUrl) o solo la ruta. */
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface DemoResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Respuesta con estado y encabezados propios (por defecto un handler devuelve 200 con su valor). */
class Reply {
  constructor(
    readonly status: number,
    readonly body?: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

interface RouteArgs {
  ctx: Ctx;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  user: UserRec;
}

interface Route {
  method: string;
  pattern: string[];
  auth: boolean;
  handler: (a: RouteArgs) => unknown;
}

const routes: Route[] = [];
function route(method: string, path: string, auth: boolean, handler: Route['handler']): void {
  routes.push({ method, pattern: path.split('/').filter(Boolean), auth, handler });
}

const orderJson = (ctx: Ctx, orderId: string, user: UserRec): OrderDTO =>
  toOrderDTO(findOwnOrder(ctx, orderId, user.id), user);

// ───────────── público ─────────────

route('GET', '/health', false, () => ({ status: 'ok', demo: true }));

route('GET', '/v1/categories', false, ({ ctx }) => listCategories(ctx.catalog));

route('GET', '/v1/products', false, ({ ctx, query }) => {
  const q = parse(productsQuerySchema, query);
  return {
    ...listProducts(ctx.catalog, { get: (id) => stockOf(ctx, id) }, q),
    demo: true,
  };
});

route('GET', '/v1/products/:group', false, ({ ctx, params }) => {
  const { group } = parse(groupParamsSchema, params);
  const product = getProductByGroup(ctx.catalog, { get: (id) => stockOf(ctx, id) }, group);
  if (!product) throw notFound('Producto');
  return { product, demo: true };
});

route('GET', '/v1/delivery/zone', false, ({ ctx, query }) => {
  const place = parse(zoneQuerySchema, query);
  const zone = findZone(ctx.zone, place);
  if (!zone) return { covered: false as const };
  return {
    covered: true as const,
    zone: { id: zone.id, name: zone.name },
    feeCentavos: zone.feeCentavos,
    minOrderCentavos: zone.minOrderCentavos,
    freeOverCentavos: zone.freeOverCentavos,
  };
});

route('GET', '/v1/delivery/slots', false, ({ ctx }) =>
  slotsToDTO(listSlots(ctx.state.orders, ctx.now())),
);

route('POST', '/v1/quote', false, ({ ctx, body, headers }) => {
  const b = parse(quoteBodySchema, body);
  const zone = b.address
    ? findZone(ctx.zone, { sector: b.address.sector ?? '', city: b.address.city ?? '' })
    : null;
  // La cotización es pública, pero un cupón se valida contra una persona: sin sesión válida pide iniciar sesión.
  let userId: string | null = null;
  if (headers['authorization']) {
    try {
      userId = authenticate(ctx, headers).id;
    } catch {
      userId = null;
    }
  }
  const quote = quoteOrder(ctx, {
    items: b.items,
    zone,
    coupon: b.couponCode ? { code: b.couponCode, userId } : undefined,
  });
  return { ...quote, coverage: b.address ? (zone ? 'covered' : 'not_covered') : 'unknown' };
});

route('GET', '/v1/payments/methods', false, () => ({
  card: { available: true },
  cash: { available: true },
  transfer: { available: true },
}));

route('GET', '/v1/payments/transfer-info', true, ({ ctx }) => ctx.cfg.transferInfo);

// ───────────── sesión y cuenta ─────────────

route('POST', '/v1/auth/otp/request', false, ({ ctx, body }) => {
  const { phone } = parse(otpRequestBodySchema, body);
  return requestOtp(ctx, phone);
});

route('POST', '/v1/auth/otp/verify', false, ({ ctx, body }) => {
  const { phone, code } = parse(otpVerifyBodySchema, body);
  const user = verifyOtp(ctx, phone, code);
  return { token: openSession(ctx, user), user: publicUser(user) };
});

route('GET', '/v1/me', true, ({ user }) => publicUser(user));

route('PATCH', '/v1/me', true, ({ user, body }) => {
  const patch = parse(patchMeBodySchema, body);
  if (patch.name !== undefined) user.name = patch.name;
  if (patch.email !== undefined) user.email = patch.email;
  return publicUser(user);
});

route('DELETE', '/v1/me', true, ({ ctx, user }) => {
  deleteAccount(ctx, user);
  return new Reply(204);
});

// ───────────── direcciones ─────────────

route('GET', '/v1/me/addresses', true, ({ ctx, user }) => listAddresses(ctx, user.id));

route('POST', '/v1/me/addresses', true, ({ ctx, user, body }) => {
  const b = parse(addressWithDefaultSchema, body);
  return new Reply(201, createAddress(ctx, user.id, b));
});

route('PUT', '/v1/me/addresses/:id', true, ({ ctx, user, params, body }) => {
  const { id } = parse(idParamsSchema, params);
  const b = parse(addressWithDefaultSchema, body);
  return updateAddress(ctx, user.id, id, b);
});

route('DELETE', '/v1/me/addresses/:id', true, ({ ctx, user, params }) => {
  const { id } = parse(idParamsSchema, params);
  deleteAddress(ctx, user.id, id);
  return new Reply(204);
});

// ───────────── notificaciones push (no hacen nada en la demostración) ─────────────

route('POST', '/v1/me/devices', true, ({ ctx, user, body }) => {
  const b = parse(deviceBodySchema, body);
  return registerDevice(ctx, user.id, b);
});

route('DELETE', '/v1/me/devices/:token', true, ({ ctx, user, params }) => {
  const { token } = parse(deviceTokenParamsSchema, params);
  unregisterDevice(ctx, user.id, token);
  return new Reply(204);
});

// ───────────── pedidos ─────────────

route('POST', '/v1/orders', true, ({ ctx, user, body, headers }) => {
  const b = parse(createOrderBodySchema, body);

  let address: AddressSnapshot;
  if (b.addressId) {
    const row = ctx.state.addresses.find((a) => a.id === b.addressId && a.userId === user.id);
    if (!row) throw notFound('Dirección');
    address = {
      label: row.label,
      line1: row.line1,
      reference: row.reference,
      sector: row.sector,
      city: row.city,
      latitude: row.latitude,
      longitude: row.longitude,
      contactPhone: row.contactPhone ?? user.phone,
    };
  } else {
    const a = b.address!;
    address = { ...a, contactPhone: a.contactPhone ?? user.phone };
  }

  const key = headers['idempotency-key'];
  if (key !== undefined && (key.length < 8 || key.length > 100)) {
    throw invalid('Idempotency-Key debe tener entre 8 y 100 caracteres');
  }

  const order = createOrder(ctx, {
    user,
    items: b.items,
    address,
    slotStart: b.slotStart,
    paymentMethod: b.paymentMethod,
    notes: b.notes,
    substitutionPolicy: b.substitutionPolicy,
    idempotencyKey: key,
    couponCode: b.couponCode,
  });
  return new Reply(201, toOrderDTO(order, user));
});

route('GET', '/v1/orders', true, ({ ctx, user }) =>
  listOrdersForUser(ctx, user.id).map((o) => toOrderDTO(o, user)),
);

route('GET', '/v1/orders/:id', true, ({ ctx, user, params }) => {
  const { id } = parse(idParamsSchema, params);
  return orderJson(ctx, id, user);
});

route('POST', '/v1/orders/:id/cancel', true, ({ ctx, user, params, body }) => {
  const { id } = parse(idParamsSchema, params);
  const { reason } = parse(cancelBodySchema, body ?? {});
  return toOrderDTO(cancelOrder(ctx, user, id, reason), user);
});

route('POST', '/v1/orders/:id/pay', true, ({ ctx, user, params }) => {
  const { id } = parse(idParamsSchema, params);
  const { payment, expiresAt } = startCardPayment(ctx, user, id);
  return {
    paymentId: payment.id,
    amount: payment.amount,
    // En la vista previa esta dirección NO se abre: el banco simulado aprueba el pago solo.
    redirectUrl: `${ctx.cfg.baseUrl}/v1/payments/${payment.id}/redirect?token=demo`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
});

route('POST', '/v1/orders/:id/transfer-proof', true, ({ ctx, user, params, body }) => {
  const { id } = parse(idParamsSchema, params);
  const b = parse(transferProofBodySchema, body);
  return toOrderDTO(submitTransferProof(ctx, user, id, b), user);
});

route('GET', '/v1/orders/:id/tracking', true, ({ ctx, user, params }) => {
  const { id } = parse(idParamsSchema, params);
  // Es una posición en vivo: ningún intermediario debe guardarla.
  return new Reply(200, getTracking(ctx, findOwnOrder(ctx, id, user.id)), {
    'cache-control': 'no-store',
  });
});

route('GET', '/v1/orders/:id/reorder', true, ({ ctx, user, params }) => {
  const { id } = parse(idParamsSchema, params);
  return buildReorder(ctx, findOwnOrder(ctx, id, user.id));
});

// ───────────── despacho ─────────────

function matchRoute(
  method: string,
  segments: string[],
): { route: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method || r.pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.pattern.length; i++) {
      const p = r.pattern[i]!;
      const s = segments[i]!;
      if (p.startsWith(':')) {
        try {
          params[p.slice(1)] = decodeURIComponent(s);
        } catch {
          params[p.slice(1)] = s;
        }
      } else if (p !== s) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function errorResponse(e: DemoError): DemoResponse {
  return {
    status: e.status,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } }),
  };
}

/** Atiende una petición ya normalizada. No toca el reloj ni el almacenamiento: eso lo hace el servidor. */
export function dispatch(ctx: Ctx, req: DemoRequest): DemoResponse {
  try {
    const base = ctx.cfg.baseUrl;
    let url: URL;
    try {
      url = new URL(req.url, `${base}/`);
    } catch {
      return errorResponse(new DemoError('bad_request', 'Dirección inválida', 400));
    }
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return { status: 204, headers: {}, body: '' };

    // Si el baseUrl trae una ruta (https://host/api), se descarta antes de buscar la ruta.
    const basePath = new URL(base).pathname.replace(/\/+$/, '');
    const path =
      basePath && url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname;
    const segments = path.split('/').filter(Boolean);
    const matched = matchRoute(method, segments);
    if (!matched) {
      return errorResponse(new DemoError('not_found', 'Ruta no encontrada', 404));
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;

    let body: unknown = undefined;
    if (req.body !== undefined && req.body !== null && req.body !== '') {
      try {
        body = JSON.parse(req.body);
      } catch {
        return errorResponse(new DemoError('bad_request', 'El cuerpo no es un JSON válido', 400));
      }
    }

    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    const user = matched.route.auth ? authenticate(ctx, headers) : (undefined as unknown as UserRec);
    const result = matched.route.handler({
      ctx,
      params: matched.params,
      query,
      body,
      headers,
      user,
    });
    if (result instanceof Reply) {
      if (result.status === 204 || result.body === undefined) {
        return { status: result.status, headers: { ...result.headers }, body: '' };
      }
      return {
        status: result.status,
        headers: { ...JSON_HEADERS, ...result.headers },
        body: JSON.stringify(result.body),
      };
    }
    return { status: 200, headers: { ...JSON_HEADERS }, body: JSON.stringify(result) };
  } catch (e) {
    if (e instanceof DemoError) return errorResponse(e);
    console.error('[demo-backend]', e);
    return errorResponse(
      new DemoError('internal', 'Algo salió mal de nuestro lado. Intenta de nuevo.', 500),
    );
  }
}
