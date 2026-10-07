import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type CouponTerms,
  couponTermIssues,
  createCoupon,
  getCouponDTO,
  listCoupons,
  listRedemptions,
  normalizeCouponCode,
  toCouponDTO,
  updateCoupon,
} from '../services/coupons';
import { parse, uuid } from './validate';

/** Código de cupón opcional en pedidos y cotizaciones: vacío o solo espacios = sin cupón. */
export const couponCodeField = z
  .string()
  .max(60, 'Código de cupón demasiado largo')
  .nullish()
  .transform((v) => (v && v.trim() ? v : undefined));

/**
 * La cotización es pública, pero un cupón se valida contra una persona (sus usos y el freno a
 * quien adivina códigos). Sin sesión válida devuelve null y el cupón responde "Inicia sesión".
 */
export async function optionalSessionId(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  if (!req.headers.authorization) return null;
  try {
    await app.authenticate(req, reply);
    return req.session?.id ?? null;
  } catch {
    return null;
  }
}

const int = (label: string) =>
  z.number({ error: `${label} debe ser un número` }).int(`${label} debe ser un entero`);

const isoDate = z.iso
  .datetime({
    offset: true,
    error: 'Usa una fecha ISO 8601 con zona horaria (2026-10-15T04:00:00Z)',
  })
  .transform((s) => new Date(s));

/** Estricto: un campo mal escrito (p. ej. `maxRedemption`) se rechaza en vez de ignorarse. */
const strict = <T extends z.core.$ZodShape>(shape: T) =>
  z.strictObject(shape, {
    error: (iss) =>
      iss.code === 'unrecognized_keys' ? `Campo desconocido: ${iss.keys.join(', ')}` : undefined,
  });

const fields = {
  description: z.string().trim().max(140, 'La descripción admite hasta 140 caracteres'),
  kind: z.enum(['percent', 'fixed', 'free_delivery'], {
    error: 'El tipo debe ser percent, fixed o free_delivery',
  }),
  value: int('El valor'),
  minSubtotal: int('El subtotal mínimo'),
  maxDiscount: int('El tope'),
  startsAt: isoDate,
  endsAt: isoDate,
  maxRedemptions: int('El máximo de usos'),
  perUserLimit: int('El límite por persona'),
  active: z.boolean({ error: 'active debe ser true o false' }),
};

/** Las reglas que dependen del tipo (porcentaje 1-10000, fijo > 0…) viven en el servicio. */
const createSchema = strict({
  code: z.string({ error: 'Escribe el código del cupón' }).max(60),
  description: fields.description.default(''),
  kind: fields.kind,
  value: fields.value.default(0),
  minSubtotal: fields.minSubtotal.default(0),
  maxDiscount: fields.maxDiscount.nullable().default(null),
  startsAt: fields.startsAt.nullable().default(null),
  endsAt: fields.endsAt.nullable().default(null),
  maxRedemptions: fields.maxRedemptions.nullable().default(null),
  perUserLimit: fields.perUserLimit.default(1),
  active: fields.active.default(true),
})
  .transform((b): CouponTerms => ({ ...b, code: normalizeCouponCode(b.code) }))
  .superRefine((terms, ctx) => {
    for (const issue of couponTermIssues(terms)) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
  });

const patchSchema = strict({
  description: fields.description.optional(),
  kind: fields.kind.optional(),
  value: fields.value.optional(),
  minSubtotal: fields.minSubtotal.optional(),
  maxDiscount: fields.maxDiscount.nullable().optional(),
  startsAt: fields.startsAt.nullable().optional(),
  endsAt: fields.endsAt.nullable().optional(),
  maxRedemptions: fields.maxRedemptions.nullable().optional(),
  perUserLimit: fields.perUserLimit.optional(),
  active: fields.active.optional(),
}).refine((b) => Object.values(b).some((v) => v !== undefined), {
  message: 'No hay nada que cambiar',
});

export async function registerCouponRoutes(app: FastifyInstance) {
  const { deps } = app;
  const staff = { preHandler: app.requireRole('admin', 'staff') };
  const adminOnly = { preHandler: app.requireRole('admin') };
  const now = () => (deps.now ?? (() => new Date()))();
  const idParams = z.object({ id: uuid });

  // El personal puede ver los cupones y quién los usó (para atender a un cliente); solo el admin cambia algo.
  app.get('/v1/admin/coupons', staff, async () => listCoupons(deps.db, now()));

  app.post('/v1/admin/coupons', adminOnly, async (req, reply) => {
    const terms = parse(createSchema, req.body);
    const row = await createCoupon(deps.db, terms);
    return reply.status(201).send(toCouponDTO(row, { redemptions: 0, discountTotal: 0 }, now()));
  });

  app.patch('/v1/admin/coupons/:id', adminOnly, async (req) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(patchSchema, req.body);
    await updateCoupon(deps.db, id, patch);
    return getCouponDTO(deps.db, id, now());
  });

  app.get('/v1/admin/coupons/:id/redemptions', staff, async (req) => {
    const { id } = parse(idParams, req.params);
    return listRedemptions(deps.db, id);
  });
}
