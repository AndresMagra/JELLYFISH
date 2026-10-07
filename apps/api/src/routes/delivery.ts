import { DR_BOUNDS, OUTSIDE_DR_MESSAGE } from '@jellyfish/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildReorder, getTracking, recordDriverLocation } from '../services/delivery';
import { parse, uuid } from './validate';

const locationSchema = z.object({
  latitude: z
    .number()
    .min(DR_BOUNDS.minLat, OUTSIDE_DR_MESSAGE)
    .max(DR_BOUNDS.maxLat, OUTSIDE_DR_MESSAGE),
  longitude: z
    .number()
    .min(DR_BOUNDS.minLng, OUTSIDE_DR_MESSAGE)
    .max(DR_BOUNDS.maxLng, OUTSIDE_DR_MESSAGE),
  accuracyM: z.number().min(0).max(100_000).nullable().optional(),
  orderId: uuid.optional(),
});

export async function registerDeliveryRoutes(app: FastifyInstance) {
  // El repartidor reporta dónde está (la app lo manda cada pocos segundos mientras reparte).
  app.post('/v1/driver/location', { preHandler: app.requireRole('driver') }, async (req) => {
    const body = parse(locationSchema, req.body);
    const { updatedAt } = await recordDriverLocation(app.orderCtx, req.session!.id, body);
    return { ok: true as const, updatedAt: updatedAt.toISOString() };
  });

  // Dónde va mi pedido: solo el cliente dueño, y solo mientras va en camino.
  app.get('/v1/orders/:id/tracking', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    // Es una posición en vivo: ningún intermediario debe guardarla.
    reply.header('cache-control', 'no-store');
    return getTracking(app.orderCtx, id, req.session!.id);
  });

  // Pedir de nuevo: las líneas del pedido contra el catálogo de hoy (no toca el carrito).
  app.get('/v1/orders/:id/reorder', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return buildReorder(app.orderCtx, id, req.session!.id);
  });
}
