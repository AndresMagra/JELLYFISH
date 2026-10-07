import { ORDER_STATUSES } from '@jellyfish/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orders, users } from '../db/schema';
import { conflict, notFound } from '../errors';
import { inviteUser } from '../services/auth';
import {
  exportCatalogCsv,
  importCatalog,
  listCatalogAdmin,
  patchVariant,
} from '../services/catalog';
import { adminSummary } from '../services/reports';
import { lowStock } from '../services/inventory';
import { adjustStockWithLots, reconcileLots } from '../services/lots';
import {
  assignDriver,
  getOrder,
  listOrdersAdmin,
  recordWeights,
  transitionOrder,
} from '../services/orders';
import { createZone, listZones, updateZone } from '../services/zones';
import { collectCash } from '../services/payments';
import { parse, positiveInt, uuid } from './validate';

const statusSchema = z.enum(ORDER_STATUSES);

export async function registerAdminRoutes(app: FastifyInstance) {
  const { deps } = app;
  const staff = { preHandler: app.requireRole('admin', 'staff') };
  const adminOnly = { preHandler: app.requireRole('admin') };
  const idParams = z.object({ id: uuid });

  // ── Resumen del día ──
  app.get('/v1/admin/summary', staff, async () => adminSummary(app.orderCtx));

  // ── Pedidos ──
  app.get('/v1/admin/orders', staff, async (req) => {
    const q = parse(
      z.object({ status: z.string().optional(), limit: z.coerce.number().int().optional() }),
      req.query,
    );
    const status = q.status
      ? q.status.split(',').map((s) => parse(statusSchema, s.trim()))
      : undefined;
    return listOrdersAdmin(app.orderCtx, { status, limit: q.limit });
  });

  app.get('/v1/admin/orders/:id', staff, async (req) => {
    const { id } = parse(idParams, req.params);
    return getOrder(app.orderCtx, id);
  });

  app.post('/v1/admin/orders/:id/transition', staff, async (req) => {
    const { id } = parse(idParams, req.params);
    const { to, note, pinOverrideReason } = parse(
      z.object({
        to: statusSchema,
        note: z.string().max(300).default(''),
        // Para 'delivered' sin el PIN del cliente: el servicio exige ≥ 8 caracteres y lo deja en el historial.
        pinOverrideReason: z.string().max(300).optional(),
      }),
      req.body,
    );
    return transitionOrder(
      app.orderCtx,
      id,
      to,
      { id: req.session!.id, role: req.session!.role },
      note,
      { pinOverrideReason },
    );
  });

  app.post('/v1/admin/orders/:id/weights', staff, async (req) => {
    const { id } = parse(idParams, req.params);
    const { weights } = parse(
      z.object({
        weights: z.array(z.object({ itemId: uuid, finalQuantity: positiveInt })).min(1),
      }),
      req.body,
    );
    return recordWeights(app.orderCtx, id, weights);
  });

  app.post('/v1/admin/orders/:id/assign-driver', staff, async (req) => {
    const { id } = parse(idParams, req.params);
    const { driverId } = parse(z.object({ driverId: uuid }), req.body);
    const [before] = await deps.db
      .select({ driverId: orders.driverId })
      .from(orders)
      .where(eq(orders.id, id));
    const order = await assignDriver(app.orderCtx, id, driverId);
    // Solo avisa si cambió de repartidor (reasignar al mismo no repite la notificación).
    if (order.driverId && order.driverId !== before?.driverId) app.push.notifyDriverAssigned(id);
    return order;
  });

  // ── Catálogo e importación ──
  app.get('/v1/admin/catalog', staff, async (req) => {
    const q = parse(
      z.object({ category: z.string().optional(), blockedOnly: z.enum(['0', '1']).optional() }),
      req.query,
    );
    return listCatalogAdmin(deps.db, deps.config.demo, {
      category: q.category,
      blockedOnly: q.blockedOnly === '1',
    });
  });

  app.patch('/v1/admin/variants/:id', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(
      z.object({
        price: positiveInt.optional(),
        priceSource: z.enum(['ancla', 'estimado', 'usuario']).optional(),
        priceNote: z.string().max(300).optional(),
        cost: positiveInt.nullable().optional(),
        itbisBps: z.number().int().min(0).max(10_000).nullable().optional(),
        active: z.boolean().optional(),
        lowStockThreshold: z.number().int().min(0).optional(),
        photo: z.string().max(300).optional(),
        photoIllustrative: z.boolean().optional(),
      }),
      req.body,
    );
    return patchVariant(deps.db, id, patch);
  });

  app.get('/v1/admin/catalog/export', adminOnly, async (_req, reply) => {
    const day = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="jellyfish-catalogo-${day}.csv"`)
      .send(await exportCatalogCsv(deps.db));
  });

  // Acepta el CSV como cuerpo `text/csv` o como JSON { "csv": "…" }.
  app.post('/v1/admin/catalog/import', adminOnly, async (req) => {
    const q = parse(
      z.object({
        dryRun: z.enum(['0', '1']).default('1'),
        applyStock: z.enum(['0', '1']).default('0'),
        overwriteConfirmed: z.enum(['0', '1']).default('0'),
      }),
      req.query,
    );
    const csv =
      typeof req.body === 'string'
        ? req.body
        : parse(z.object({ csv: z.string().min(1) }), req.body).csv;
    const result = await importCatalog(deps.db, csv, {
      dryRun: q.dryRun === '1',
      applyStockToExisting: q.applyStock === '1',
      overwriteConfirmed: q.overwriteConfirmed === '1',
      actorId: req.session!.id,
    });
    // "Aplicar existencias" fija on_hand a un valor absoluto: los lotes no pueden quedar por encima.
    if (q.dryRun === '0' && q.applyStock === '1') await reconcileLots(deps.db);
    return result;
  });

  // ── Inventario ──
  app.post('/v1/admin/inventory/adjust', staff, async (req) => {
    const body = parse(
      z.object({
        variantId: uuid,
        type: z.enum(['receive', 'adjust', 'waste']),
        delta: z.number().int(),
        note: z.string().max(300).default(''),
      }),
      req.body,
    );
    // Las bajas (merma, ajuste negativo) también descuentan de los lotes, primero en vencer primero.
    return adjustStockWithLots(deps.db, body.variantId, body.type, body.delta, {
      actorId: req.session!.id,
      note: body.note,
    });
  });

  app.get('/v1/admin/inventory/low', staff, async () => lowStock(deps.db));

  // ── Zonas de entrega ──
  app.get('/v1/admin/zones', adminOnly, async () => listZones(deps.db, false));

  app.post('/v1/admin/zones', adminOnly, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80),
        areas: z.array(z.string().trim().min(2).max(80)).min(1),
        feeCentavos: z.number().int().min(0),
        minOrderCentavos: z.number().int().min(0).default(0),
        freeOverCentavos: z.number().int().min(0).nullable().default(null),
      }),
      req.body,
    );
    return reply.status(201).send(await createZone(deps.db, body));
  });

  app.patch('/v1/admin/zones/:id', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(
      z.object({
        name: z.string().trim().min(2).max(80).optional(),
        areas: z.array(z.string().trim().min(2).max(80)).min(1).optional(),
        feeCentavos: z.number().int().min(0).optional(),
        minOrderCentavos: z.number().int().min(0).optional(),
        freeOverCentavos: z.number().int().min(0).nullable().optional(),
        active: z.boolean().optional(),
      }),
      req.body,
    );
    return updateZone(deps.db, id, patch);
  });

  // El personal puede registrar un cobro en efectivo (p. ej. si el repartidor no tiene la app a mano).
  app.post('/v1/admin/orders/:id/collect-cash', staff, async (req) => {
    const { id } = parse(idParams, req.params);
    const { amount } = parse(z.object({ amount: positiveInt }), req.body);
    return collectCash(
      app.orderCtx,
      id,
      { id: req.session!.id, role: req.session!.role as 'admin' | 'staff' },
      amount,
    );
  });

  // El personal necesita ver los repartidores para asignarlos; el resto de usuarios es solo del admin.
  app.get('/v1/admin/drivers', staff, async () =>
    deps.db
      .select({ id: users.id, phone: users.phone, name: users.name })
      .from(users)
      .where(eq(users.role, 'driver'))
      .orderBy(asc(users.name)),
  );

  // ── Personas ──
  app.get('/v1/admin/users', adminOnly, async (req) => {
    const { role } = parse(
      z.object({ role: z.enum(['customer', 'admin', 'staff', 'driver']).optional() }),
      req.query,
    );
    return deps.db
      .select({ id: users.id, phone: users.phone, name: users.name, role: users.role })
      .from(users)
      .where(role ? eq(users.role, role) : undefined)
      .orderBy(asc(users.createdAt))
      .limit(200);
  });

  app.post('/v1/admin/users', adminOnly, async (req, reply) => {
    const body = parse(
      z.object({
        phone: z.string().min(7).max(30),
        name: z.string().trim().max(80).optional(),
        role: z.enum(['admin', 'staff', 'driver']),
      }),
      req.body,
    );
    const user = await inviteUser(deps.db, body);
    return reply
      .status(201)
      .send({ id: user.id, phone: user.phone, name: user.name, role: user.role });
  });

  app.post('/v1/admin/users/:id/role', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params);
    const { role } = parse(
      z.object({ role: z.enum(['customer', 'admin', 'staff', 'driver']) }),
      req.body,
    );
    if (id === req.session!.id && role !== 'admin') {
      throw conflict('self_demote', 'No puedes quitarte a ti mismo el rol de administrador');
    }
    const [row] = await deps.db
      .update(users)
      .set({ role })
      .where(eq(users.id, id))
      .returning({ id: users.id, phone: users.phone, name: users.name, role: users.role });
    if (!row) throw notFound('Usuario');
    return row;
  });
}
