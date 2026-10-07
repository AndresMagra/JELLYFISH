import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getProduct, listCategories, listProducts } from '../services/catalog';
import { findZone, listSlots } from '../services/zones';
import { quoteOrder } from '../services/orders';
import { addressInputSchema, itemsSchema, parse } from './validate';

export async function registerCatalogRoutes(app: FastifyInstance) {
  const { deps } = app;

  app.get('/v1/categories', async () =>
    listCategories(deps.db, { visibleOnly: true, demo: deps.config.demo }),
  );

  app.get('/v1/products', async (req) => {
    const q = parse(
      z.object({
        category: z.string().max(40).optional(),
        subcategory: z.string().max(60).optional(),
        q: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      req.query,
    );
    return { ...(await listProducts(deps.db, deps.config.demo, q)), demo: deps.config.demo };
  });

  app.get('/v1/products/:group', async (req) => {
    const { group } = parse(z.object({ group: z.string().min(1).max(80) }), req.params);
    return { product: await getProduct(deps.db, deps.config.demo, group), demo: deps.config.demo };
  });

  // ¿Llegamos a mi sector? ¿Cuánto cuesta el envío?
  app.get('/v1/delivery/zone', async (req) => {
    const place = parse(
      z.object({ sector: z.string().max(80).default(''), city: z.string().max(80).default('') }),
      req.query,
    );
    const zone = await findZone(deps.db, place);
    if (!zone) return { covered: false as const };
    return {
      covered: true as const,
      zone: { id: zone.id, name: zone.name },
      feeCentavos: zone.feeCentavos,
      minOrderCentavos: zone.minOrderCentavos,
      freeOverCentavos: zone.freeOverCentavos,
    };
  });

  app.get('/v1/delivery/slots', async () => {
    const slots = await listSlots(deps.db, deps.config, (deps.now ?? (() => new Date()))());
    return slots.map((s) => ({
      start: s.start,
      end: s.end,
      remaining: s.remaining,
      available: s.remaining > 0,
    }));
  });

  // Cotización del carrito: el servidor recalcula todo (precios, ITBIS, envío).
  app.post('/v1/quote', async (req) => {
    const body = parse(
      z.object({
        items: itemsSchema,
        address: addressInputSchema.pick({ sector: true, city: true }).partial().optional(),
      }),
      req.body,
    );
    const zone = body.address
      ? await findZone(deps.db, {
          sector: body.address.sector ?? '',
          city: body.address.city ?? '',
        })
      : null;
    const quote = await quoteOrder(app.orderCtx, { items: body.items, zone });
    return { ...quote, coverage: body.address ? (zone ? 'covered' : 'not_covered') : 'unknown' };
  });
}
