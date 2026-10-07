import { type SQL, and, desc, eq, like, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog, users } from '../db/schema';
import { invalid } from '../errors';
import { maskPhone } from './http-util';

/**
 * Bitácora de auditoría: quién hizo qué en el panel y en la app de repartidores.
 * Este archivo solo tiene lógica pura (sanear, nombrar) y acceso a la base; el enganche con Fastify
 * está en routes/audit.ts.
 */

// ───────────── Saneamiento del cuerpo ─────────────

export const MAX_STRING = 200;
export const MAX_PAYLOAD_BYTES = 4000;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_KEYS = 30;

/** Claves que se quitan por completo (comparadas sin mayúsculas ni guiones). */
const SECRET_KEYS = new Set([
  'code',
  'otp',
  'pin',
  'token',
  'password',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'authkey',
  'authhash',
  'signature',
  'otpcode',
  'pincode',
  'smscode',
  'authcode',
  'verificationcode',
]);
/** `pushToken`, `deliveryPin`, `newPassword`, `clientSecret`, `otpCode`… */
const SECRET_SUFFIX = /(token|password|passwd|secret|pin|otp|authorization|apikey)$/;
const PHONE_KEY = /phone$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const JWT_LIKE = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isSecretKey(key: string): boolean {
  const k = normalizeKey(key);
  return SECRET_KEYS.has(k) || SECRET_SUFFIX.test(k);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function sanitizeValue(value: unknown, depth: number): Json | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (JWT_LIKE.test(value) || /^Bearer\s/i.test(value)) return '[token]';
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value !== 'object') return undefined; // undefined, función, símbolo, bigint
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((v) => sanitizeValue(v, depth + 1))
      .map((v) => (v === undefined ? null : v));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`…(${value.length - MAX_ARRAY_ITEMS} más)`);
    return items;
  }
  const out: { [key: string]: Json } = {};
  let kept = 0;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key) || isSecretKey(key)) continue;
    if (kept >= MAX_KEYS) {
      out._more = '…';
      break;
    }
    if (PHONE_KEY.test(normalizeKey(key)) && typeof v === 'string') {
      out[key] = maskPhone(v);
      kept++;
      continue;
    }
    const clean = sanitizeValue(v, depth + 1);
    if (clean !== undefined) {
      out[key] = clean;
      kept++;
    }
  }
  return out;
}

/**
 * Cuerpo y parámetros de consulta listos para guardar: sin claves secretas, teléfonos enmascarados,
 * textos recortados a 200 caracteres, profundidad y tamaño acotados. Un cuerpo de texto (el CSV de
 * importación) no se guarda, solo su tamaño.
 */
export function sanitizePayload(
  body: unknown,
  query?: unknown,
  contentType?: string,
): { [key: string]: Json } | null {
  let out: { [key: string]: Json } | null = null;
  if (typeof body === 'string') {
    out = {
      _text: true,
      _chars: body.length,
      ...(contentType ? { _contentType: contentType } : {}),
    };
  } else if (body && typeof body === 'object') {
    const clean = sanitizeValue(body, 0);
    out = Array.isArray(clean) ? { _items: clean } : ((clean as { [key: string]: Json }) ?? {});
  }
  if (query && typeof query === 'object') {
    const q = sanitizeValue(query, 1);
    if (q && typeof q === 'object' && !Array.isArray(q) && Object.keys(q).length > 0) {
      out = { ...(out ?? {}), _query: q };
    }
  }
  if (!out) return null;
  const size = Buffer.byteLength(JSON.stringify(out));
  if (size > MAX_PAYLOAD_BYTES) {
    return { _truncated: true, _bytes: size, _keys: Object.keys(out).slice(0, MAX_KEYS) };
  }
  return out;
}

// ───────────── Rutas: normalización y nombres ─────────────

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ruta sin ids ni parámetros de consulta. Normalmente se usa el patrón registrado en Fastify
 * (`/v1/admin/orders/:id/transition`); esto es para cuando solo hay una URL cruda.
 */
export function normalizePath(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path
    .split('/')
    .map((seg) => (UUID_SEGMENT.test(seg) || /^\d{3,}$/.test(seg) ? ':id' : seg))
    .join('/');
}

export interface DetailInput {
  body: Record<string, unknown>;
  query: Record<string, unknown>;
}

interface RouteSpec {
  action: string;
  entity: string;
  /** Descripción corta en español. */
  label: string;
  detail?: (input: DetailInput) => string | undefined;
  /** Cuando el id de la entidad no es `:id` de la ruta. */
  entityId?: (input: DetailInput) => string | undefined;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;
const keysOf = (b: Record<string, unknown>) => {
  const k = Object.keys(b).filter((key) => !key.startsWith('_'));
  return k.length > 0 ? `campos: ${k.join(', ')}` : undefined;
};

const KNOWN_ROUTES: Record<string, RouteSpec> = {
  'POST /v1/admin/orders/:id/transition': {
    action: 'orders.transition',
    entity: 'order',
    label: 'Cambio de estado del pedido',
    detail: ({ body }) => (body.to ? `a «${str(body.to)}»` : undefined),
  },
  'POST /v1/admin/orders/:id/weights': {
    action: 'orders.record_weights',
    entity: 'order',
    label: 'Pesos reales del pedido',
    detail: ({ body }) =>
      Array.isArray(body.weights) ? `${body.weights.length} líneas` : undefined,
  },
  'POST /v1/admin/orders/:id/assign-driver': {
    action: 'orders.assign_driver',
    entity: 'order',
    label: 'Repartidor asignado al pedido',
    detail: ({ body }) => (body.driverId ? `repartidor ${str(body.driverId)}` : undefined),
  },
  'POST /v1/admin/orders/:id/collect-cash': {
    action: 'payments.collect_cash',
    entity: 'order',
    label: 'Cobro en efectivo registrado',
    detail: ({ body }) => (body.amount ? `monto ${str(body.amount)}` : undefined),
  },
  'PATCH /v1/admin/variants/:id': {
    action: 'catalog.patch_variant',
    entity: 'variant',
    label: 'Artículo modificado',
    detail: ({ body }) => keysOf(body),
  },
  'POST /v1/admin/catalog/import': {
    action: 'catalog.import',
    entity: 'catalog',
    label: 'Importación del catálogo',
    detail: ({ query }) => (query.dryRun === '0' ? 'aplicada' : 'simulación'),
  },
  'POST /v1/admin/inventory/adjust': {
    action: 'inventory.adjust',
    entity: 'variant',
    label: 'Ajuste de inventario',
    detail: ({ body }) =>
      body.type ? `${str(body.type)} ${str(body.delta) ?? ''}`.trim() : undefined,
    entityId: ({ body }) => str(body.variantId),
  },
  'POST /v1/admin/inventory/lots': {
    action: 'inventory.receive_lot',
    entity: 'lot',
    label: 'Lote recibido',
    detail: ({ body }) =>
      body.lotCode ? `lote ${str(body.lotCode)}, cantidad ${str(body.quantity) ?? '?'}` : undefined,
  },
  'POST /v1/admin/zones': {
    action: 'zones.create',
    entity: 'zone',
    label: 'Zona de entrega creada',
    detail: ({ body }) => str(body.name),
  },
  'PATCH /v1/admin/zones/:id': {
    action: 'zones.update',
    entity: 'zone',
    label: 'Zona de entrega modificada',
    detail: ({ body }) => keysOf(body),
  },
  'POST /v1/admin/users': {
    action: 'users.invite',
    entity: 'user',
    label: 'Persona invitada al equipo',
    detail: ({ body }) => (body.role ? `rol «${str(body.role)}»` : undefined),
  },
  'POST /v1/admin/users/:id/role': {
    action: 'users.set_role',
    entity: 'user',
    label: 'Rol de usuario cambiado',
    detail: ({ body }) => (body.role ? `rol «${str(body.role)}»` : undefined),
  },
  'POST /v1/admin/payments/:id/mark-paid': {
    action: 'payments.mark_paid',
    entity: 'payment',
    label: 'Pago marcado como recibido',
  },
  'POST /v1/admin/payments/:id/mark-refunded': {
    action: 'payments.mark_refunded',
    entity: 'payment',
    label: 'Devolución registrada',
    detail: ({ body }) => (body.amount ? `monto ${str(body.amount)}` : undefined),
  },
  'POST /v1/admin/cash/settle': {
    action: 'cash.settle',
    entity: 'driver',
    label: 'Efectivo entregado por el repartidor',
    detail: ({ body }) => (body.amount ? `monto ${str(body.amount)}` : undefined),
    entityId: ({ body }) => str(body.driverId),
  },
  'POST /v1/driver/orders/:id/transition': {
    action: 'driver.transition',
    entity: 'order',
    label: 'Repartidor cambia el estado del pedido',
    detail: ({ body }) => (body.to ? `a «${str(body.to)}»` : undefined),
  },
  'POST /v1/driver/orders/:id/collect': {
    action: 'driver.collect_cash',
    entity: 'order',
    label: 'Repartidor cobró en efectivo',
    detail: ({ body }) => (body.amount ? `monto ${str(body.amount)}` : undefined),
  },
};

const METHOD_VERB: Record<string, string> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

/** Nombre automático para rutas nuevas que todavía no están en la tabla. */
function genericSpec(method: string, pattern: string): RouteSpec {
  const segments = pattern.split('/').filter(Boolean).slice(1); // sin "v1"
  const scope = segments.shift() ?? ''; // admin | driver
  const statics = segments.filter((s) => !s.startsWith(':')).map((s) => s.replace(/-/g, '_'));
  const lastIsParam = segments[segments.length - 1]?.startsWith(':') ?? false;
  const entity = statics[0] ?? 'unknown';
  const verb =
    !lastIsParam && statics.length > 1
      ? statics.slice(1).join('_')
      : (METHOD_VERB[method] ?? method.toLowerCase());
  const action = `${scope === 'driver' ? 'driver.' : ''}${entity}.${verb}`;
  return { action, entity, label: `${method} ${pattern}` };
}

export interface RouteDescription {
  action: string;
  entity: string;
  label: string;
  spec: RouteSpec;
}

export function describeRoute(method: string, pattern: string): RouteDescription {
  const spec = KNOWN_ROUTES[`${method} ${pattern}`] ?? genericSpec(method, pattern);
  return { action: spec.action, entity: spec.entity, label: spec.label, spec };
}

/** Texto legible para el historial: "Cambio de estado del pedido: a «packed»". */
export function buildSummary(
  desc: RouteDescription,
  input: DetailInput,
  status: number,
  errorCode?: string,
): string {
  const detail = desc.spec.detail?.(input);
  const base = detail ? `${desc.label}: ${detail}` : desc.label;
  if (status >= 400) return `${base} — rechazado (${errorCode ?? status})`;
  return base;
}

// ───────────── Servicio ─────────────

export interface AuditEntry {
  actorId: string | null;
  actorRole: string;
  method: string;
  path: string;
  action: string;
  entity: string;
  entityId: string;
  status: number;
  summary: string;
  payload: unknown;
  ip: string | null;
}

export interface AuditLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface AuditItem {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorName: string | null;
  actorRole: string;
  method: string;
  path: string;
  action: string;
  entity: string;
  entityId: string;
  status: number;
  summary: string;
  payload: unknown;
  ip: string | null;
}

export class AuditService {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: { db: Db; now?: () => Date; logger?: AuditLogger }) {}

  /**
   * Ejecuta un trabajo de auditoría. NUNCA lanza: si falla se registra en el log y la petición que se
   * estaba auditando ya respondió sin enterarse. El trabajo queda en `pending` para poder esperarlo
   * (`idle`) al apagar el servidor y en las pruebas.
   */
  run(label: string, fn: () => Promise<void>): Promise<void> {
    const job: Promise<void> = (async () => {
      try {
        await fn();
      } catch (e) {
        // Solo el nombre del error: el mensaje de la base puede traer valores de la fila.
        this.deps.logger?.error(
          { err: (e as Error).name, action: label },
          'No se pudo escribir en la bitácora de auditoría',
        );
      }
    })().finally(() => this.pending.delete(job));
    this.pending.add(job);
    return job;
  }

  record(entry: AuditEntry): Promise<void> {
    return this.run(entry.action, async () => {
      await this.deps.db.insert(auditLog).values({
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        method: entry.method,
        path: entry.path,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        status: entry.status,
        summary: entry.summary,
        payload: entry.payload ?? null,
        ip: entry.ip,
        createdAt: (this.deps.now ?? (() => new Date()))(),
      });
    });
  }

  /** Espera a que terminen las escrituras en curso. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Más recientes primero. `before` es el `nextCursor` anterior (o una fecha ISO). */
  async list(
    query: { limit?: number; before?: string; actorId?: string; action?: string } = {},
  ): Promise<{ items: AuditItem[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const conditions: SQL[] = [];
    if (query.actorId) conditions.push(eq(auditLog.actorId, query.actorId));
    if (query.action) {
      // `orders.*` filtra por prefijo; sin asterisco, igualdad exacta.
      if (query.action.endsWith('*')) {
        const prefix = query.action.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`);
        conditions.push(like(auditLog.action, `${prefix}%`));
      } else {
        conditions.push(eq(auditLog.action, query.action));
      }
    }
    if (query.before) {
      const { at, id } = parseCursor(query.before);
      conditions.push(
        id
          ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${at.toISOString()}::timestamptz, ${id}::uuid)`
          : sql`${auditLog.createdAt} < ${at.toISOString()}::timestamptz`,
      );
    }

    const rows = await this.deps.db
      .select({ row: auditLog, actorName: users.name })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1]?.row;
    return {
      items: page.map(({ row, actorName }) => ({
        id: row.id,
        createdAt: row.createdAt,
        actorId: row.actorId,
        actorName: actorName ?? null,
        actorRole: row.actorRole,
        method: row.method,
        path: row.path,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        status: row.status,
        summary: row.summary,
        payload: row.payload,
        ip: row.ip,
      })),
      nextCursor: rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }
}

function parseCursor(raw: string): { at: Date; id: string | null } {
  const [ts = '', id] = raw.split('|');
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) throw invalid('before: cursor inválido');
  if (id !== undefined && !UUID_SEGMENT.test(id)) throw invalid('before: cursor inválido');
  return { at, id: id ?? null };
}
