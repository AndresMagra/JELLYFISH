import { AsyncLocalStorage } from 'node:async_hooks';
import { type OrderStatus, formatDOP } from '@jellyfish/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import {
  type AddressSnapshot,
  type DevicePlatform,
  type PaymentMethod,
  deviceTokens,
  orderEvents,
  orders,
  users,
} from '../db/schema';
import { formatOrderNumber } from '../text';
import {
  type FetchLike,
  type Logger,
  TransportFailure,
  consoleLogger,
  safeJson,
  sleep as realSleep,
  timedFetch,
} from './http-util';
import type { OrderHooks } from './orders';

// ───────────────────────── transporte: Expo Push API ─────────────────────────

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Máximo de mensajes por petición que acepta Expo. */
export const EXPO_BATCH_SIZE = 100;
export const PUSH_REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 500;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  /** Segundos que Expo/FCM/APNs conservan el mensaje si el teléfono está apagado. */
  ttl?: number;
}

export interface PushTicket {
  status: 'ok' | 'error';
  /** Para pedir el recibo más tarde (solo si status = ok). */
  id?: string;
  /** Código de Expo, p. ej. DeviceNotRegistered, MessageRateExceeded, TransportError. */
  error?: string;
  message?: string;
}

export interface PushReceipt {
  status: 'ok' | 'error';
  error?: string;
  message?: string;
}

/** Interfaz del transporte: en producción es Expo; en pruebas, un doble. */
export interface PushSender {
  /** Un ticket por mensaje, en el mismo orden. Un lote que falla devuelve tickets de error. */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  getReceipts?(ids: string[]): Promise<Record<string, PushReceipt>>;
}

export interface ExpoPushSenderOptions {
  /** Solo si el proyecto de Expo tiene activada la seguridad reforzada. */
  accessToken?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

type PostResult = { ok: true; json: unknown } | { ok: false; reason: string };

export class ExpoPushSender implements PushSender {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ExpoPushSenderOptions = {}) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? PUSH_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? consoleLogger;
    this.sleep = options.sleep ?? realSleep;
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
      tickets.push(...(await this.sendBatch(messages.slice(i, i + EXPO_BATCH_SIZE))));
    }
    return tickets;
  }

  async getReceipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    const out: Record<string, PushReceipt> = {};
    for (let i = 0; i < ids.length; i += 300) {
      const res = await this.post(EXPO_RECEIPTS_URL, { ids: ids.slice(i, i + 300) });
      if (!res.ok) continue;
      const data = (res.json as { data?: Record<string, unknown> } | null)?.data ?? {};
      for (const [id, raw] of Object.entries(data)) out[id] = toReceipt(raw);
    }
    return out;
  }

  private async sendBatch(batch: PushMessage[]): Promise<PushTicket[]> {
    const fail = (error: string): PushTicket[] =>
      batch.map(() => ({ status: 'error', error, message: 'No se pudo entregar el lote a Expo' }));
    const res = await this.post(EXPO_PUSH_URL, batch);
    if (!res.ok) return fail('TransportError');
    const data = (res.json as { data?: unknown } | null)?.data;
    if (!Array.isArray(data) || data.length !== batch.length) return fail('BadResponse');
    return data.map(toTicket);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.options.accessToken) headers.Authorization = `Bearer ${this.options.accessToken}`;
    return headers;
  }

  /** Un reintento ante red caída, 429 o 5xx. Nunca lanza: el push es de mejor esfuerzo. */
  private async post(url: string, payload: unknown): Promise<PostResult> {
    let reason = 'unknown';
    for (let attempt = 1; attempt <= 2; attempt++) {
      let retryable: boolean;
      try {
        const res = await timedFetch(
          this.fetchImpl,
          url,
          { method: 'POST', headers: this.headers(), body: JSON.stringify(payload) },
          this.timeoutMs,
        );
        if (res.status >= 200 && res.status < 300) return { ok: true, json: safeJson(res.text) };
        reason = `http_${res.status}`;
        retryable = res.status === 429 || res.status >= 500;
      } catch (e) {
        if (!(e instanceof TransportFailure)) throw e;
        reason = e.kind;
        retryable = true;
      }
      if (retryable && attempt < 2) {
        await this.sleep(RETRY_DELAY_MS);
        continue;
      }
      break;
    }
    this.logger.warn(
      { event: 'push_request_failed', reason },
      'Expo no aceptó la petición de push',
    );
    return { ok: false, reason };
  }
}

function toTicket(raw: unknown): PushTicket {
  const t = (raw ?? {}) as {
    status?: string;
    id?: string;
    message?: string;
    details?: { error?: string };
  };
  if (t.status === 'ok') return { status: 'ok', id: t.id };
  return { status: 'error', error: t.details?.error ?? 'Unknown', message: t.message };
}

function toReceipt(raw: unknown): PushReceipt {
  const r = (raw ?? {}) as { status?: string; message?: string; details?: { error?: string } };
  if (r.status === 'ok') return { status: 'ok' };
  return { status: 'error', error: r.details?.error ?? 'Unknown', message: r.message };
}

// ───────────────────────── dispositivos ─────────────────────────

/** Formato de los tokens de Expo: ExponentPushToken[…] o ExpoPushToken[…]. */
const EXPO_TOKEN = /^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

export function isExpoPushToken(token: string): boolean {
  return token.length <= 255 && EXPO_TOKEN.test(token);
}

/** Tope por persona: evita que alguien llene la tabla (y multiplique los envíos) con tokens falsos. */
export const MAX_DEVICES_PER_USER = 10;

export interface DeviceRecord {
  token: string;
  platform: DevicePlatform;
  lastSeenAt: Date;
}

/**
 * Registra o refresca un dispositivo. Un token es único: si ya existía (aunque fuera de otra
 * cuenta, p. ej. alguien cerró sesión y otra persona entró en el mismo teléfono) pasa a esta
 * persona y se actualiza `lastSeenAt`. Se conservan los 10 dispositivos más recientes.
 */
export async function registerDevice(
  db: Db,
  userId: string,
  input: { token: string; platform: DevicePlatform },
  now: Date = new Date(),
): Promise<DeviceRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(deviceTokens)
      .values({ userId, token: input.token, platform: input.platform, lastSeenAt: now })
      .onConflictDoUpdate({
        target: deviceTokens.token,
        set: { userId, platform: input.platform, lastSeenAt: now },
      })
      .returning();

    const mine = await tx
      .select({ id: deviceTokens.id })
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, userId))
      .orderBy(desc(deviceTokens.lastSeenAt), desc(deviceTokens.createdAt));
    const keep = new Set([row!.id]);
    for (const m of mine) {
      if (keep.size >= MAX_DEVICES_PER_USER) break;
      keep.add(m.id);
    }
    const evict = mine.filter((m) => !keep.has(m.id)).map((m) => m.id);
    if (evict.length > 0) await tx.delete(deviceTokens).where(inArray(deviceTokens.id, evict));

    return { token: row!.token, platform: row!.platform, lastSeenAt: row!.lastSeenAt };
  });
}

/** Quita un dispositivo de ESTA persona. Devuelve false si no lo tenía (no es un error). */
export async function unregisterDevice(db: Db, userId: string, token: string): Promise<boolean> {
  const rows = await db
    .delete(deviceTokens)
    .where(and(eq(deviceTokens.token, token), eq(deviceTokens.userId, userId)))
    .returning({ id: deviceTokens.id });
  return rows.length > 0;
}

// ───────────────────────── envío a personas ─────────────────────────

export interface Notification {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushContext {
  db: Db;
  sender: PushSender;
  logger: Logger;
  enabled: boolean;
  /** Para consultar el recibo más tarde (opcional). */
  onTicket?: (ticketId: string, token: string) => void;
}

export interface NotifyResult {
  devices: number;
  sent: number;
  failed: number;
  /** Tokens borrados por DeviceNotRegistered. */
  removed: number;
}

/** Dos días: una notificación de pedido que no se entrega en ese plazo ya no sirve. */
const PUSH_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * Envía una notificación a todos los dispositivos de las personas indicadas, interpreta los
 * tickets de Expo y borra los tokens que ya no existen. NUNCA lanza: un push que falla no debe
 * afectar a quien lo dispara. En los logs solo van conteos y códigos, jamás tokens.
 */
export async function notifyUsers(
  ctx: PushContext,
  userIds: readonly string[],
  notification: Notification,
): Promise<NotifyResult> {
  const result: NotifyResult = { devices: 0, sent: 0, failed: 0, removed: 0 };
  const ids = [...new Set(userIds)];
  if (!ctx.enabled || ids.length === 0) return result;
  try {
    const rows = await ctx.db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .innerJoin(users, eq(users.id, deviceTokens.userId))
      .where(and(inArray(deviceTokens.userId, ids), isNull(users.deletedAt)));
    const tokens = [...new Set(rows.map((r) => r.token))].filter(isExpoPushToken);
    result.devices = tokens.length;
    if (tokens.length === 0) return result;

    const messages: PushMessage[] = tokens.map((to) => ({
      to,
      title: notification.title,
      body: notification.body,
      data: notification.data,
      sound: 'default',
      priority: 'high',
      ttl: PUSH_TTL_SECONDS,
    }));
    const tickets = await ctx.sender.send(messages);

    const dead: string[] = [];
    const errors: Record<string, number> = {};
    tokens.forEach((token, i) => {
      const ticket = tickets[i];
      if (ticket?.status === 'ok') {
        result.sent++;
        if (ticket.id) ctx.onTicket?.(ticket.id, token);
        return;
      }
      result.failed++;
      const code = ticket?.error ?? 'NoTicket';
      errors[code] = (errors[code] ?? 0) + 1;
      if (code === 'DeviceNotRegistered') dead.push(token);
    });

    if (dead.length > 0) {
      await ctx.db.delete(deviceTokens).where(inArray(deviceTokens.token, dead));
      result.removed = dead.length;
    }
    if (result.failed > 0) {
      ctx.logger.warn(
        { event: 'push_partial_failure', failed: result.failed, sent: result.sent, errors },
        'Algunos push no se pudieron entregar',
      );
    }
  } catch (e) {
    ctx.logger.error(
      { event: 'push_failed', err: e instanceof Error ? e.name : 'unknown' },
      'No se pudo enviar la notificación push',
    );
  }
  return result;
}

// ───────────────────────── plantillas en español ─────────────────────────

export interface OrderForPush {
  id: string;
  number: number;
  total: number;
  paymentMethod: PaymentMethod;
  address: Pick<AddressSnapshot, 'sector'>;
  /** Solo se usa para saber SI existe: el valor jamás se pone en un texto ni en `data`. */
  deliveryPin: string | null;
}

const orderData = (order: Pick<OrderForPush, 'id'>) => ({ type: 'order', orderId: order.id });

const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  card: 'Tarjeta',
  cash: 'Efectivo',
  transfer: 'Transferencia',
};

/** Aviso al cliente por cada estado del pedido (null = ese estado no genera aviso). */
export function customerNotification(to: OrderStatus, order: OrderForPush): Notification | null {
  const code = formatOrderNumber(order.number);
  const data = orderData(order);
  switch (to) {
    case 'confirmed':
      return {
        title: '¡Pedido confirmado!',
        body: `Recibimos tu pedido ${code} y ya lo tenemos en cola para prepararlo.`,
        data,
      };
    case 'picking':
      return {
        title: 'Estamos preparando tu pedido',
        body: `Ya empezamos a armar el pedido ${code}.`,
        data,
      };
    case 'packed':
      return {
        title: 'Tu pedido está listo',
        body: `El pedido ${code} ya está empacado y listo para salir.`,
        data,
      };
    case 'out_for_delivery':
      return {
        title: 'Tu pedido va en camino',
        body:
          `El pedido ${code} ya salió hacia tu dirección.` +
          (order.deliveryPin
            ? ' Ten a mano tu PIN de entrega: se lo das al repartidor cuando recibas.'
            : ''),
        data,
      };
    case 'delivered':
      return {
        title: '¡Pedido entregado!',
        body: `El pedido ${code} fue entregado. ¡Que lo disfrutes!`,
        data,
      };
    case 'delivery_failed':
      return {
        title: 'No pudimos entregar tu pedido',
        body: `No se pudo completar la entrega del pedido ${code}. Abre la app para ver los detalles.`,
        data,
      };
    case 'cancelled':
      return { title: 'Pedido cancelado', body: `El pedido ${code} fue cancelado.`, data };
    case 'refunded':
      return {
        title: 'Reembolso registrado',
        body: `Registramos el reembolso del pedido ${code}.`,
        data,
      };
    case 'pending_payment':
      return null;
  }
}

/** Aviso a staff y administradores cuando entra un pedido ya confirmado. */
export function newOrderNotification(order: OrderForPush): Notification {
  return {
    title: 'Nuevo pedido',
    body: `${formatOrderNumber(order.number)} · ${formatDOP(order.total)} · ${PAYMENT_LABEL[order.paymentMethod]}`,
    data: orderData(order),
  };
}

/** Aviso al repartidor. Sin calle ni nombre: las notificaciones se leen en la pantalla bloqueada. */
export function driverAssignedNotification(order: OrderForPush): Notification {
  return {
    title: 'Nuevo pedido asignado',
    body: `Te asignaron el pedido ${formatOrderNumber(order.number)} (${order.address.sector}). Revisa los detalles en la app.`,
    data: orderData(order),
  };
}

// ───────────────────────── "después del commit" ─────────────────────────

/** Hecho que queda registrado DENTRO de la transacción: el id del evento del pedido ya insertado. */
export interface OrderPushEvent {
  orderId: string;
  eventId: string;
  from: OrderStatus | null;
  to: OrderStatus;
}

/** Cola de una petición (o de una tarea): se vacía cuando termina, no cuando la transacción acaba. */
export class PushScope {
  readonly events = new Map<string, OrderPushEvent>();
}

export interface PushServiceOptions {
  db: Db;
  config: Pick<Config, 'pushEnabled'>;
  sender: PushSender;
  logger?: Logger;
  /** Esperas (ms) al verificar un evento fuera de petición. Inyectable para pruebas. */
  detachedRetryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Los recibos de Expo tardan: se piden después de 15 min y se descartan a las 24 h. */
const RECEIPT_DELAY_MS = 15 * 60_000;
const RECEIPT_GIVE_UP_MS = 24 * 60 * 60_000;
const MAX_PENDING_RECEIPTS = 5_000;

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Notificaciones del ciclo del pedido.
 *
 * Los `OrderHooks` corren DENTRO de la transacción del pedido, así que enviar desde ahí podría
 * avisar de algo que luego hace rollback. Por eso los hooks solo anotan el id del evento que acaban
 * de insertar (en una cola por petición, vía AsyncLocalStorage) y el envío ocurre DESPUÉS, sin
 * esperar al cliente, y solo si ese evento existe ya en la base: que sea visible desde fuera de
 * la transacción es la prueba de que se confirmó. Así el rollback nunca notifica, ni siquiera si
 * el código llamante atrapa el error y responde 200.
 */
export class PushService {
  readonly hooks: OrderHooks;
  private readonly als = new AsyncLocalStorage<PushScope>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly receipts = new Map<string, { token: string; at: number }>();
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly detachedDelays: number[];

  constructor(private readonly options: PushServiceOptions) {
    this.logger = options.logger ?? consoleLogger;
    this.sleep = options.sleep ?? realSleep;
    this.detachedDelays = options.detachedRetryDelaysMs ?? [50, 250, 1_000, 4_000];
    this.hooks = {
      afterCreate: async (tx, order) => {
        // Un pedido que nace sin pagar (tarjeta/transferencia) no avisa a nadie todavía.
        if (!this.enabled || order.status !== 'confirmed') return;
        await this.capture(tx, order.id, null, order.status);
      },
      afterTransition: async (tx, order, from, to) => {
        if (!this.enabled || to === 'pending_payment') return;
        await this.capture(tx, order.id, from, to);
      },
    };
  }

  get enabled(): boolean {
    return this.options.config.pushEnabled;
  }

  private get ctx(): PushContext {
    return {
      db: this.options.db,
      sender: this.options.sender,
      logger: this.logger,
      enabled: this.enabled,
      onTicket: (id, token) => this.trackReceipt(id, token),
    };
  }

  /** Envío directo a personas (para otras funciones). Nunca lanza. */
  notify(userIds: readonly string[], notification: Notification): Promise<NotifyResult> {
    return notifyUsers(this.ctx, userIds, notification);
  }

  // ── cola por petición ──

  createScope(): PushScope {
    return new PushScope();
  }

  /** Ejecuta `fn` (y todo lo asíncrono que dispare) con `scope` como cola activa. */
  runInScope<T>(scope: PushScope, fn: () => T): T {
    return this.als.run(scope, fn);
  }

  /**
   * Para trabajo fuera de una petición (el temporizador de reservas vencidas): al terminar `fn`
   * se envían los avisos de lo que sí se confirmó, aunque `fn` haya fallado a medias.
   */
  async scope<T>(fn: () => Promise<T>): Promise<T> {
    const scope = this.createScope();
    try {
      return await this.als.run(scope, fn);
    } finally {
      this.flush(scope);
    }
  }

  /** Programa el envío de lo anotado; no espera ni lanza. */
  flush(scope: PushScope): void {
    const events = [...scope.events.values()];
    scope.events.clear();
    if (events.length === 0) return;
    this.track(this.dispatch(events));
  }

  private async capture(tx: Db, orderId: string, from: OrderStatus | null, to: OrderStatus) {
    try {
      const [row] = await tx
        .select({ id: orderEvents.id })
        .from(orderEvents)
        .where(
          and(
            eq(orderEvents.orderId, orderId),
            eq(orderEvents.toStatus, to),
            from ? eq(orderEvents.fromStatus, from) : isNull(orderEvents.fromStatus),
          ),
        )
        .orderBy(desc(orderEvents.createdAt))
        .limit(1);
      if (row) this.enqueue({ orderId, eventId: row.id, from, to });
    } catch (e) {
      // Un aviso perdido es aceptable; romper el pedido no.
      this.logger.error(
        { event: 'push_capture_failed', err: e instanceof Error ? e.name : 'unknown' },
        'No se pudo anotar el aviso del pedido',
      );
    }
  }

  private enqueue(event: OrderPushEvent): void {
    const scope = this.als.getStore();
    if (scope) {
      scope.events.set(event.eventId, event);
      return;
    }
    // Sin cola activa no sabemos cuándo termina la transacción: se espera a verla confirmada.
    this.track(this.dispatchDetached(event));
  }

  private async dispatch(events: OrderPushEvent[]): Promise<void> {
    await nextTick(); // que la respuesta HTTP salga primero
    for (const event of events) {
      try {
        if (await this.isCommitted(event)) await this.deliver(event);
      } catch (e) {
        this.logger.error(
          { event: 'push_dispatch_failed', err: e instanceof Error ? e.name : 'unknown' },
          'Falló el envío del aviso del pedido',
        );
      }
    }
  }

  private async dispatchDetached(event: OrderPushEvent): Promise<void> {
    try {
      for (const delay of this.detachedDelays) {
        await this.sleep(delay);
        if (await this.isCommitted(event)) {
          await this.deliver(event);
          return;
        }
      }
      // Nunca apareció: la transacción hizo rollback (o tardó demasiado). No se avisa.
    } catch (e) {
      this.logger.error(
        { event: 'push_dispatch_failed', err: e instanceof Error ? e.name : 'unknown' },
        'Falló el envío del aviso del pedido',
      );
    }
  }

  private async isCommitted(event: OrderPushEvent): Promise<boolean> {
    const [row] = await this.options.db
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(eq(orderEvents.id, event.eventId));
    return !!row;
  }

  /** Lee el pedido YA confirmado en la base (con su estado y PIN reales) y avisa a quien toque. */
  private async deliver(event: OrderPushEvent): Promise<void> {
    const { db } = this.options;
    const [order] = await db.select().from(orders).where(eq(orders.id, event.orderId));
    if (!order) return;

    const tasks: Promise<unknown>[] = [];
    const forCustomer = customerNotification(event.to, order);
    if (forCustomer) tasks.push(this.notify([order.userId], forCustomer));

    if (event.to === 'confirmed') {
      const team = await db
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.role, ['admin', 'staff']), isNull(users.deletedAt)));
      // Quien hizo el pedido ya recibió el suyo: no se le avisa dos veces.
      const ids = team.map((t) => t.id).filter((id) => id !== order.userId);
      tasks.push(this.notify(ids, newOrderNotification(order)));
    }
    await Promise.allSettled(tasks);
  }

  /** Aviso al repartidor. `assignDriver` no usa transacción: al volver, la asignación ya está. */
  notifyDriverAssigned(orderId: string): void {
    if (!this.enabled) return;
    this.track(this.sendDriverAssigned(orderId));
  }

  private async sendDriverAssigned(orderId: string): Promise<void> {
    try {
      await nextTick();
      const [order] = await this.options.db.select().from(orders).where(eq(orders.id, orderId));
      if (!order?.driverId) return;
      await this.notify([order.driverId], driverAssignedNotification(order));
    } catch (e) {
      this.logger.error(
        { event: 'push_dispatch_failed', err: e instanceof Error ? e.name : 'unknown' },
        'Falló el aviso al repartidor',
      );
    }
  }

  // ── recibos (DeviceNotRegistered también llega aquí, minutos después del envío) ──

  private trackReceipt(id: string, token: string): void {
    this.receipts.set(id, { token, at: Date.now() });
    if (this.receipts.size > MAX_PENDING_RECEIPTS) {
      const oldest = this.receipts.keys().next().value;
      if (oldest !== undefined) this.receipts.delete(oldest);
    }
  }

  /** Cuántos recibos esperan consulta (para pruebas y monitoreo). */
  get pendingReceipts(): number {
    return this.receipts.size;
  }

  /**
   * Consulta los recibos con más de 15 min y borra los tokens que Expo declara muertos.
   * Está en memoria: si el servidor se reinicia se pierden los pendientes, y el token muerto se
   * limpiará igual con el siguiente envío (el ticket suele traer el mismo error).
   */
  async checkReceipts(nowMs: number = Date.now()): Promise<{ checked: number; removed: number }> {
    const done = { checked: 0, removed: 0 };
    const { sender, db } = this.options;
    if (!this.enabled || !sender.getReceipts) return done;
    try {
      const due = [...this.receipts.entries()].filter(([, v]) => nowMs - v.at >= RECEIPT_DELAY_MS);
      if (due.length === 0) return done;
      const receipts = await sender.getReceipts(due.map(([id]) => id));
      const dead: string[] = [];
      for (const [id, entry] of due) {
        const receipt = receipts[id];
        if (!receipt) {
          if (nowMs - entry.at > RECEIPT_GIVE_UP_MS) this.receipts.delete(id);
          continue;
        }
        this.receipts.delete(id);
        done.checked++;
        if (receipt.status === 'error' && receipt.error === 'DeviceNotRegistered') {
          dead.push(entry.token);
        }
      }
      if (dead.length > 0) {
        await db.delete(deviceTokens).where(inArray(deviceTokens.token, dead));
        done.removed = dead.length;
      }
    } catch (e) {
      this.logger.error(
        { event: 'push_receipts_failed', err: e instanceof Error ? e.name : 'unknown' },
        'No se pudieron consultar los recibos de push',
      );
    }
    return done;
  }

  // ── ciclo de vida ──

  private track(promise: Promise<unknown>): void {
    const tracked: Promise<unknown> = promise
      .catch(() => undefined)
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Espera a que terminen los envíos en curso (apagado ordenado y pruebas). */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }
}
