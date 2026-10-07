import { ORDER_STATUSES } from '@jellyfish/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { users } from '../db/schema';
import { conflict, notFound } from '../errors';
import { importCatalog, listCatalogAdmin, patchVariant } from '../services/catalog';
import { adjustStock, lowStock } from '../services/inventory';
import {
  assignDriver,
  getOrder,
  listOrdersAdmin,
  recordWeights,
  transitionOrder,
} from '../services/orders';
import { createZone, listZones } from '../services/zones';
import { parse, positiveInt, uuid } from './validate';

const statusSchema = z.enum(ORDER_STATUSES);

export async function registerAdminRoutes(app: FastifyInstance) {
  const { deps } = app;
  const staff = { preHandler: app.requireRole('admin', 'staff') };
  const adminOnly = { preHandler: app.requireRole('admin') };
  const idParams = z.object({ id: uuid });

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
    const { to, note } = parse(
      z.object({ to: statusSchema, note: z.string().max(300).default('') }),
      req.body,
    );
    return transitionOrder(
      app.orderCtx,
      id,
      to,
      { id: req.session!.id, role: req.session!.role },
      note,
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
    return assignDriver(app.orderCtx, id, driverId);
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
      }),
      req.body,
    );
    return patchVariant(deps.db, id, patch);
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
    return importCatalog(deps.db, csv, {
      dryRun: q.dryRun === '1',
      applyStockToExisting: q.applyStock === '1',
      overwriteConfirmed: q.overwriteConfirmed === '1',
      actorId: req.session!.id,
    });
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
    return adjustStock(deps.db, body.variantId, body.type, body.delta, {
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
