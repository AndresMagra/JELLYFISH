import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listExpiring, listLots, receiveLot } from '../services/lots';
import { parse, positiveInt, uuid } from './validate';

const bool01 = z.enum(['0', '1']).default('0');

export async function registerLotRoutes(app: FastifyInstance) {
  // Recibir mercancía es trabajo del personal de almacén, igual que ajustar el inventario.
  const staff = { preHandler: app.requireRole('admin', 'staff') };

  // Recepción: crea el lote y suma al inventario físico en una sola transacción.
  app.post('/v1/admin/inventory/lots', staff, async (req, reply) => {
    const body = parse(
      z.object({
        variantId: uuid,
        lotCode: z
          .string()
          .trim()
          .min(1, 'El código del lote es obligatorio')
          .max(40)
          // Sin caracteres de control: el código se imprime en etiquetas y reportes.
          .regex(/^[^\p{C}]+$/u, 'El código del lote tiene caracteres no válidos'),
        expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD'),
        quantity: positiveInt.max(1_000_000_000),
        unitCostCentavos: z.number().int().min(0).max(100_000_000).nullable().optional(),
        note: z.string().trim().max(300).default(''),
      }),
      req.body,
    );
    const lot = await receiveLot(app.orderCtx, body, req.session!.id);
    return reply.status(201).send(lot);
  });

  app.get('/v1/admin/inventory/lots', staff, async (req) => {
    const q = parse(
      z.object({
        variantId: uuid.optional(),
        includeEmpty: bool01,
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      req.query,
    );
    return listLots(app.orderCtx, {
      variantId: q.variantId,
      includeEmpty: q.includeEmpty === '1',
      limit: q.limit,
    });
  });

  // Lo que hay que mirar en el congelador: por vencer y ya vencido, con días restantes.
  app.get('/v1/admin/inventory/expiring', staff, async (req) => {
    const { days } = parse(
      z.object({ days: z.coerce.number().int().min(0).max(365).default(30) }),
      req.query,
    );
    return listExpiring(app.orderCtx, days);
  });
}
