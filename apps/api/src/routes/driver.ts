import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orders } from '../db/schema';
import { getOrder, transitionOrder } from '../services/orders';
import { parse, uuid } from './validate';

export async function registerDriverRoutes(app: FastifyInstance) {
  const { deps } = app;
  const driver = { preHandler: app.requireRole('driver') };

  // Entregas asignadas a este repartidor que siguen activas.
  app.get('/v1/driver/orders', driver, async (req) => {
    const rows = await deps.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.driverId, req.session!.id),
          inArray(orders.status, ['packed', 'out_for_delivery', 'delivery_failed']),
        ),
      );
    return Promise.all(rows.map((r) => getOrder(app.orderCtx, r.id)));
  });

  app.post('/v1/driver/orders/:id/transition', driver, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { to, note, pin } = parse(
      z.object({
        to: z.enum(['out_for_delivery', 'delivered', 'delivery_failed']),
        note: z.string().max(300).default(''),
        // Para 'delivered': los 4 dígitos que le dice el cliente (como texto: conserva el cero inicial).
        pin: z
          .string()
          .regex(/^\d{4}$/, 'El PIN son 4 dígitos')
          .optional(),
      }),
      req.body,
    );
    return transitionOrder(app.orderCtx, id, to, { id: req.session!.id, role: 'driver' }, note, {
      pin,
    });
  });
}
