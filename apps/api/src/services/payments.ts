import { createHmac, timingSafeEqual } from 'node:crypto';
import { AzulGateway, type CardGateway, MockGateway, type RedirectForm } from '@jellyfish/payments';
import { formatDOP } from '@jellyfish/shared';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { orders, payments, cashSettlements, users, type PaymentStatus } from '../db/schema';
import { conflict, forbidden, invalid, notFound } from '../errors';
import { formatOrderNumber } from '../text';
import {
  type Actor,
  type OrderContext,
  type OrderDTO,
  type OrderHooks,
  getOrder,
  transitionOrderInTx,
} from './orders';

export type PaymentRow = typeof payments.$inferSelect;

const SYSTEM: Actor = { id: null, role: 'system' };
const HELD: PaymentStatus[] = ['captured', 'partially_refunded'];

// ───────────────────────── pasarela ─────────────────────────

/** Crea la pasarela de tarjeta según la configuración (o null si la tarjeta está deshabilitada). */
export function createGateway(config: Config): CardGateway | null {
  const { cardProvider, azul, publicBaseUrl } = config.payments;
  if (cardProvider === 'azul' && azul) return new AzulGateway(azul);
  if (cardProvider === 'mock') return new MockGateway(`${publicBaseUrl}/v1/payments/mock/page`);
  return null;
}

export interface PaymentContext extends OrderContext {
  gateway: CardGateway | null;
}

function requireGateway(ctx: PaymentContext): CardGateway {
  if (!ctx.gateway)
    throw conflict('method_unavailable', 'El pago con tarjeta no está disponible por ahora');
  return ctx.gateway;
}

export function availableMethods(config: Config) {
  return {
    card: { available: config.payments.cardProvider !== null },
    cash: { available: true },
    transfer: { available: config.payments.transfer !== null },
  };
}

// ───────────────────────── enlaces firmados de redirección ─────────────────────────

/** Token de un solo propósito (abrir la página de pago de un intento). HMAC con vencimiento. */
export function signRedirectToken(secret: string, paymentId: string, expiresAt: Date): string {
  const body = `${paymentId}.${expiresAt.getTime()}`;
  const sig = createHmac('sha256', secret).update(`pay-redirect:${body}`).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyRedirectToken(secret: string, token: string, now: Date): string | null {
  const [paymentId, exp, sig] = token.split('.');
  if (!paymentId || !exp || !sig) return null;
  const expected = createHmac('sha256', secret)
    .update(`pay-redirect:${paymentId}.${exp}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Number(exp) > now.getTime() ? paymentId : null;
}

// ───────────────────────── enganches con los pedidos ─────────────────────────

/**
 * Reglas de dinero que acompañan al ciclo de vida del pedido. Se registran como hooks para que
 * `orders` no dependa de `payments`; todo corre dentro de la transacción del pedido.
 */
export function paymentHooks(): OrderHooks {
  return {
    afterCreate: async (tx, order) => {
      if (order.paymentMethod === 'cash' || order.paymentMethod === 'transfer') {
        await tx.insert(payments).values({
          orderId: order.id,
          provider: order.paymentMethod,
          method: order.paymentMethod,
          status: 'pending',
          amount: order.total,
          idempotencyKey: `${order.paymentMethod}:${order.id}`,
        });
      }
    },

    beforeTransition: async (tx, order, to) => {
      if (to === 'confirmed' && order.paymentMethod !== 'cash') {
        const [paid] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.orderId, order.id), inArray(payments.status, HELD)))
          .limit(1);
        if (!paid)
          throw conflict('not_paid', 'El pedido no se puede confirmar sin un pago registrado');
      }
      if (to === 'delivered' && order.paymentMethod === 'cash') {
        const [collected] = await tx
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.orderId, order.id), inArray(payments.status, HELD)))
          .limit(1);
        if (!collected) {
          throw conflict(
            'cash_not_collected',
            'Registra el cobro en efectivo antes de marcar la entrega',
          );
        }
      }
    },

    afterTransition: async (tx, order, _from, to) => {
      const rows = await tx.select().from(payments).where(eq(payments.orderId, order.id));

      if (to === 'packed' && order.finalTotal !== null) {
        for (const p of rows) {
          if (p.method === 'cash' && p.status === 'pending') {
            // En efectivo se cobra el total real, no el estimado.
            await tx
              .update(payments)
              .set({ amount: order.finalTotal, updatedAt: new Date() })
              .where(eq(payments.id, p.id));
          }
        }
        // Prepago (tarjeta/transferencia): si el peso real cuesta menos que lo cobrado, se devuelve la diferencia.
        const prepaid = rows.filter((p) => p.method !== 'cash' && HELD.includes(p.status));
        const held = prepaid.reduce(
          (a, p) => a + p.capturedAmount - p.refundedAmount - p.refundPending,
          0,
        );
        const excess = held - order.finalTotal;
        if (excess > 0 && prepaid[0]) {
          const target = prepaid[0];
          await tx
            .update(payments)
            .set({
              refundPending: sql`${payments.refundPending} + ${excess}`,
              updatedAt: new Date(),
            })
            .where(eq(payments.id, target.id));
        }
      }

      if (to === 'cancelled') {
        for (const p of rows) {
          if (p.status === 'pending') {
            await tx
              .update(payments)
              .set({
                status: 'voided',
                failureReason: p.failureReason ?? 'order_cancelled',
                updatedAt: new Date(),
              })
              .where(eq(payments.id, p.id));
          } else if (HELD.includes(p.status)) {
            // Lo cobrado y no devuelto vuelve completo al cliente.
            const owed = p.capturedAmount - p.refundedAmount;
            await tx
              .update(payments)
              .set({ refundPending: owed, updatedAt: new Date() })
              .where(eq(payments.id, p.id));
          }
        }
      }
    },
  };
}

// ───────────────────────── tarjeta ─────────────────────────

function sanitizedRaw(params: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && k !== 'AuthHash') out[k] = v;
  }
  return out;
}

/** Número de orden que viaja a la pasarela: JF000123A1 (≤ 15 caracteres alfanuméricos). */
function gatewayOrderNumber(orderNumber: number, attempt: number): string {
  return `${formatOrderNumber(orderNumber).replace('-', '')}A${attempt}`;
}

export async function startCardPayment(ctx: PaymentContext, orderId: string, userId: string) {
  requireGateway(ctx);
  const now = (ctx.now ?? (() => new Date()))();
  return ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order || order.userId !== userId) throw notFound('Pedido');
    if (order.paymentMethod !== 'card')
      throw conflict('wrong_method', 'Este pedido no es de pago con tarjeta');
    if (order.status !== 'pending_payment') {
      throw conflict('not_payable', 'Este pedido ya no está esperando pago');
    }
    if (order.reservationExpiresAt && order.reservationExpiresAt <= now) {
      throw conflict(
        'expired',
        'Tu reserva venció. Haz el pedido de nuevo para asegurar tus productos.',
      );
    }
    const existing = await tx.select().from(payments).where(eq(payments.orderId, orderId));
    if (existing.some((p) => HELD.includes(p.status))) {
      throw conflict('already_paid', 'Este pedido ya fue pagado');
    }

    // Un intento abandonado se reemplaza: solo el último puede completarse como pago principal.
    const attempt = existing.length + 1;
    const [payment] = await tx
      .insert(payments)
      .values({
        orderId,
        provider: ctx.gateway!.name,
        method: 'card',
        status: 'pending',
        amount: order.total,
        idempotencyKey: gatewayOrderNumber(order.number, attempt),
      })
      .returning();
    return { payment: payment!, expiresAt: new Date(now.getTime() + 10 * 60_000) };
  });
}

/** Reconstruye el formulario de pago de un intento pendiente (lo sirve la página de redirección). */
export async function buildCheckout(ctx: PaymentContext, paymentId: string): Promise<RedirectForm> {
  const gateway = requireGateway(ctx);
  const now = (ctx.now ?? (() => new Date()))();
  const [row] = await ctx.db
    .select({ payment: payments, order: orders })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(payments.id, paymentId));
  if (!row) throw notFound('Pago');
  const { payment, order } = row;
  if (payment.status !== 'pending' || order.status !== 'pending_payment') {
    throw conflict('not_payable', 'Este pago ya no está disponible');
  }
  if (order.reservationExpiresAt && order.reservationExpiresAt <= now) {
    throw conflict('expired', 'Tu reserva venció');
  }
  const base = `${ctx.config.payments.publicBaseUrl}/v1/payments/${gateway.name === 'mock' ? 'mock' : 'azul'}`;
  return gateway.createCheckout({
    orderNumber: payment.idempotencyKey,
    amount: payment.amount,
    itbis: order.itbis,
    approvedUrl: `${base}/approved`,
    declinedUrl: `${base}/declined`,
    cancelUrl: `${base}/cancel`,
    customOrderId: formatOrderNumber(order.number),
  });
}

export interface CallbackOutcome {
  status: 'approved' | 'declined' | 'cancelled' | 'invalid' | 'unknown';
  orderId?: string;
  paymentId?: string;
  /** El dinero se cobró pero el pedido no estaba disponible: hay que devolverlo. */
  refundDue?: boolean;
}

function outcomeOf(p: PaymentRow): CallbackOutcome['status'] {
  if (HELD.includes(p.status) || p.status === 'refunded') return 'approved';
  if (p.status === 'voided' || p.failureReason === 'cancelled_by_user') return 'cancelled';
  return 'declined';
}

/**
 * Registra el cobro de un pago: lo marca cobrado y confirma el pedido. Si el pedido ya no está
 * esperando pago (venció, se canceló) o ya tiene otro pago, el dinero queda marcado para devolver.
 */
async function applyCapture(
  ctx: OrderContext,
  tx: Db,
  payment: PaymentRow,
  capture: { amount: number; providerRef: string; raw: Record<string, string>; note: string },
): Promise<{ refundDue: boolean }> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .for('update');
  const others = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.orderId, payment.orderId),
        ne(payments.id, payment.id),
        inArray(payments.status, HELD),
      ),
    );

  const mismatch = capture.amount !== payment.amount;
  const orderUnavailable = !order || order.status !== 'pending_payment';
  const duplicate = others.length > 0;
  const refundDue = mismatch || orderUnavailable || duplicate;
  // El motivo más específico primero: un segundo pago sobre un pedido ya confirmado es "duplicado",
  // no "pedido inactivo".
  const reason = mismatch
    ? 'amount_mismatch'
    : duplicate
      ? 'duplicate_payment'
      : orderUnavailable
        ? 'order_not_active'
        : null;

  await tx
    .update(payments)
    .set({
      status: 'captured',
      capturedAmount: capture.amount,
      refundPending: refundDue ? capture.amount : 0,
      failureReason: reason,
      providerRef: capture.providerRef || payment.providerRef,
      raw: capture.raw,
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));

  if (!refundDue) {
    await transitionOrderInTx(ctx, tx, payment.orderId, 'confirmed', SYSTEM, capture.note);
  }
  return { refundDue };
}

export async function handleCardCallback(
  ctx: PaymentContext,
  kind: 'approved' | 'declined' | 'cancel',
  params: Record<string, string | undefined>,
): Promise<CallbackOutcome> {
  const gateway = requireGateway(ctx);
  const result = gateway.verifyCallback(params);
  // Sin firma válida no se toca nada: cualquiera puede abrir esta URL.
  if (!result.valid) return { status: 'invalid' };

  return ctx.db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.idempotencyKey, result.orderNumber))
      .for('update');
    if (!payment) return { status: 'unknown' as const };
    const base = { orderId: payment.orderId, paymentId: payment.id };

    const settled = HELD.includes(payment.status) || payment.status === 'refunded';
    const approvedNow = kind === 'approved' && result.approved;

    // Reintentos o recargas de una respuesta ya procesada: mismo resultado, sin efectos nuevos.
    if (settled || (payment.status !== 'pending' && !approvedNow)) {
      return { ...base, status: outcomeOf(payment), refundDue: payment.refundPending > 0 };
    }

    const raw = sanitizedRaw(result.raw);
    if (!approvedNow) {
      const cancelled = kind === 'cancel';
      await tx
        .update(payments)
        .set({
          status: 'failed',
          failureReason: cancelled
            ? 'cancelled_by_user'
            : result.message || `declined_${result.isoCode}`,
          raw,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));
      return { ...base, status: cancelled ? ('cancelled' as const) : ('declined' as const) };
    }

    // Aprobado. El dinero ya se movió aunque nuestro intento estuviera cerrado (reserva vencida,
    // pedido cancelado): se registra siempre y, si el pedido ya no está activo, queda por devolver.
    const { refundDue } = await applyCapture(ctx, tx, payment, {
      amount: result.amount ?? payment.amount,
      providerRef: result.rrn || result.azulOrderId,
      raw,
      note: 'Pago con tarjeta aprobado',
    });
    return { ...base, status: 'approved' as const, refundDue };
  });
}

// ───────────────────────── transferencia ─────────────────────────

export async function submitTransferProof(
  ctx: OrderContext,
  orderId: string,
  userId: string,
  proof: { reference: string; note?: string },
): Promise<OrderDTO> {
  await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order || order.userId !== userId) throw notFound('Pedido');
    if (order.paymentMethod !== 'transfer')
      throw conflict('wrong_method', 'Este pedido no es de transferencia');
    if (order.status !== 'pending_payment')
      throw conflict('not_payable', 'Este pedido ya no está esperando pago');
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.method, 'transfer')));
    if (!payment) throw notFound('Pago');
    await tx
      .update(payments)
      .set({
        raw: {
          proof: {
            reference: proof.reference,
            note: proof.note ?? '',
            submittedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
  });
  return getOrder(ctx, orderId);
}

/**
 * Un administrador confirma un pago recibido por fuera del flujo automático: la transferencia
 * verificada en el banco, o una tarjeta aprobada cuya respuesta no llegó al servidor.
 */
export async function markPaid(
  ctx: OrderContext,
  paymentId: string,
  actorId: string,
  reference: string,
): Promise<OrderDTO> {
  const orderId = await ctx.db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .for('update');
    if (!payment) throw notFound('Pago');
    if (payment.method === 'cash') {
      throw conflict('use_cash_flow', 'El efectivo lo registra el repartidor al entregar');
    }
    if (payment.status !== 'pending') {
      throw conflict('not_pending', 'Este pago no está pendiente');
    }
    await applyCapture(ctx, tx, payment, {
      amount: payment.amount,
      providerRef: reference,
      raw: {
        ...((payment.raw as Record<string, unknown> | null) ?? {}),
        confirmedBy: actorId,
        reference,
      } as Record<string, string>,
      note: `Pago confirmado manualmente (${reference})`,
    });
    return payment.orderId;
  });
  return getOrder(ctx, orderId);
}

// ───────────────────────── efectivo ─────────────────────────

export async function collectCash(
  ctx: OrderContext,
  orderId: string,
  actor: { id: string; role: 'driver' | 'admin' | 'staff' },
  amount: number,
): Promise<OrderDTO> {
  await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order) throw notFound('Pedido');
    if (actor.role === 'driver' && order.driverId !== actor.id)
      throw forbidden('Este pedido no está asignado a ti');
    if (order.paymentMethod !== 'cash')
      throw conflict('wrong_method', 'Este pedido no es de pago en efectivo');
    if (order.status !== 'out_for_delivery') {
      throw conflict('wrong_status', 'El efectivo se cobra cuando el pedido va en camino');
    }
    const due = order.finalTotal ?? order.total;
    if (amount !== due) {
      throw conflict('wrong_amount', `Debes cobrar exactamente ${formatDOP(due)}`, { due });
    }
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.method, 'cash')))
      .for('update');
    if (!payment) throw notFound('Pago');
    if (payment.status !== 'pending')
      throw conflict('already_collected', 'Este cobro ya fue registrado');
    await tx
      .update(payments)
      .set({
        status: 'captured',
        amount: due,
        capturedAmount: due,
        collectedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
  });
  return getOrder(ctx, orderId);
}

// ───────────────────────── reembolsos ─────────────────────────

/**
 * Registra una devolución ya hecha (p. ej. en el portal de AZUL o por transferencia). La API de
 * reembolsos de AZUL no está integrada, así que el sistema lleva la cola de devoluciones pendientes.
 */
export async function markRefunded(
  ctx: OrderContext,
  paymentId: string,
  actorId: string,
  refund: { amount: number; reference: string },
): Promise<PaymentRow> {
  return ctx.db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .for('update');
    if (!payment) throw notFound('Pago');
    if (!Number.isSafeInteger(refund.amount) || refund.amount <= 0) throw invalid('Monto inválido');
    if (refund.amount > payment.refundPending) {
      throw conflict(
        'exceeds_pending',
        `Solo hay ${formatDOP(payment.refundPending)} pendientes de devolver en este pago`,
        { refundPending: payment.refundPending },
      );
    }
    const refunded = payment.refundedAmount + refund.amount;
    const prior = ((payment.raw as { refunds?: unknown[] } | null)?.refunds ?? []) as unknown[];
    const [updated] = await tx
      .update(payments)
      .set({
        refundedAmount: refunded,
        refundPending: payment.refundPending - refund.amount,
        status: refunded >= payment.capturedAmount ? 'refunded' : 'partially_refunded',
        raw: {
          ...((payment.raw as Record<string, unknown> | null) ?? {}),
          refunds: [
            ...prior,
            {
              amount: refund.amount,
              reference: refund.reference,
              by: actorId,
              at: new Date().toISOString(),
            },
          ],
        },
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId))
      .returning();
    return updated!;
  });
}

// ───────────────────────── consultas del panel ─────────────────────────

export async function listPayments(
  db: Db,
  filter: { status?: PaymentStatus; refundPending?: boolean; limit?: number } = {},
) {
  const conditions = [];
  if (filter.status) conditions.push(eq(payments.status, filter.status));
  if (filter.refundPending) conditions.push(sql`${payments.refundPending} > 0`);
  const rows = await db
    .select({ payment: payments, orderNumber: orders.number, orderStatus: orders.status })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(payments.createdAt))
    .limit(Math.min(filter.limit ?? 100, 200));
  return rows.map((r) => ({
    ...r.payment,
    orderCode: formatOrderNumber(r.orderNumber),
    orderStatus: r.orderStatus,
  }));
}

export interface CashRow {
  driverId: string;
  name: string;
  phone: string;
  collected: number;
  settled: number;
  /** Lo que el repartidor aún debe entregar al negocio. */
  balance: number;
  deliveries: number;
}

export async function cashReport(db: Db): Promise<CashRow[]> {
  const collected = await db
    .select({
      driverId: payments.collectedBy,
      total: sql<number>`coalesce(sum(${payments.capturedAmount}), 0)::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(and(eq(payments.method, 'cash'), inArray(payments.status, HELD)))
    .groupBy(payments.collectedBy);
  const settled = await db
    .select({
      driverId: cashSettlements.driverId,
      total: sql<number>`coalesce(sum(${cashSettlements.amount}), 0)::int`,
    })
    .from(cashSettlements)
    .groupBy(cashSettlements.driverId);
  const drivers = await db
    .select({ id: users.id, name: users.name, phone: users.phone })
    .from(users)
    .where(eq(users.role, 'driver'))
    .orderBy(asc(users.createdAt));

  const collectedBy = new Map(collected.map((c) => [c.driverId, c]));
  const settledBy = new Map(settled.map((s) => [s.driverId, s.total]));
  return drivers.map((d) => {
    const c = collectedBy.get(d.id);
    const s = settledBy.get(d.id) ?? 0;
    return {
      driverId: d.id,
      name: d.name,
      phone: d.phone,
      collected: c?.total ?? 0,
      settled: s,
      balance: (c?.total ?? 0) - s,
      deliveries: c?.n ?? 0,
    };
  });
}

/** Registra el efectivo que un repartidor entregó al negocio. No permite sobrepasar lo que debe. */
export async function settleCash(
  db: Db,
  input: { driverId: string; amount: number; actorId: string; note?: string },
) {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw invalid('Monto inválido');
  return db.transaction(async (tx) => {
    // Evita que dos cierres simultáneos del mismo repartidor superen el saldo.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'cash:' + input.driverId}))`);
    const report = (await cashReport(tx)).find((r) => r.driverId === input.driverId);
    if (!report) throw notFound('Repartidor');
    if (input.amount > report.balance) {
      throw conflict('exceeds_balance', `El repartidor solo debe ${formatDOP(report.balance)}`, {
        balance: report.balance,
      });
    }
    const [row] = await tx
      .insert(cashSettlements)
      .values({
        driverId: input.driverId,
        amount: input.amount,
        note: input.note ?? '',
        settledBy: input.actorId,
      })
      .returning();
    return { settlement: row!, balance: report.balance - input.amount };
  });
}
