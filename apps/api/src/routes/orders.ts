import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AddressSnapshot, addresses } from '../db/schema';
import { invalid, notFound } from '../errors';
import { createOrder, getOrder, listOrdersForUser, transitionOrder } from '../services/orders';
import { addressInputSchema, itemsSchema, parse, uuid } from './validate';

export async function registerOrderRoutes(app: FastifyInstance) {
  const { deps } = app;

  app.post('/v1/orders', { preHandler: app.authenticate }, async (req, reply) => {
    const userId = req.session!.id;
    const body = parse(
      z
        .object({
          items: itemsSchema,
          addressId: uuid.optional(),
          address: addressInputSchema.optional(),
          slotStart: z.coerce.date(),
          paymentMethod: z.enum(['card', 'cash', 'transfer']),
          notes: z.string().trim().max(500).optional(),
          substitutionPolicy: z.enum(['contact', 'substitute', 'refund']).optional(),
        })
        .refine((b) => b.addressId || b.address, { message: 'Indica la dirección de entrega' }),
      req.body,
    );

    let address: AddressSnapshot;
    if (body.addressId) {
      const [row] = await deps.db
        .select()
        .from(addresses)
        .where(and(eq(addresses.id, body.addressId), eq(addresses.userId, userId)));
      if (!row) throw notFound('Dirección');
      address = {
        label: row.label,
        line1: row.line1,
        reference: row.reference,
        sector: row.sector,
        city: row.city,
        latitude: row.latitude,
        longitude: row.longitude,
        contactPhone: row.contactPhone ?? req.session!.phone,
      };
    } else {
      const a = body.address!;
      address = { ...a, contactPhone: a.contactPhone ?? req.session!.phone };
    }

    const key = req.headers['idempotency-key'];
    if (key !== undefined && (typeof key !== 'string' || key.length < 8 || key.length > 100)) {
      throw invalid('Idempotency-Key debe tener entre 8 y 100 caracteres');
    }

    const order = await createOrder(app.orderCtx, {
      userId,
      items: body.items,
      address,
      slotStart: body.slotStart,
      paymentMethod: body.paymentMethod,
      notes: body.notes,
      substitutionPolicy: body.substitutionPolicy,
      idempotencyKey: key,
    });
    return reply.status(201).send(order);
  });

  app.get('/v1/orders', { preHandler: app.authenticate }, async (req) =>
    listOrdersForUser(app.orderCtx, req.session!.id),
  );

  app.get('/v1/orders/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return getOrder(app.orderCtx, id, { userId: req.session!.id });
  });

  app.post('/v1/orders/:id/cancel', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { reason } = parse(
      z.object({ reason: z.string().trim().max(200).default('') }),
      req.body ?? {},
    );
    return transitionOrder(
      app.orderCtx,
      id,
      'cancelled',
      { id: req.session!.id, role: 'customer' },
      reason,
    );
  });
}
