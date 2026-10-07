import { DR_BOUNDS, OUTSIDE_DR_MESSAGE } from '@jellyfish/shared';
// `import * as z` (y no `{ z }`) deja que el empaquetador descarte el 80 % de zod que no se usa.
import * as z from 'zod';
import { invalid } from './errors';

/** Valida con zod y devuelve un error 400 en español con el campo que falló (igual que el API). */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first?.path.length ? `${first.path.join('.')}: ` : '';
  throw invalid(`${where}${first?.message ?? 'Datos inválidos'}`, result.error.issues);
}

export const uuid = z.string().uuid('Identificador inválido');
export const positiveInt = z.number().int().positive();

/** Código de cupón opcional en pedidos y cotizaciones: vacío o solo espacios = sin cupón. */
export const couponCodeField = z
  .string()
  .max(60, 'Código de cupón demasiado largo')
  .nullish()
  .transform((v) => (v && v.trim() ? v : undefined));

export const itemsSchema = z
  .array(z.object({ variantId: uuid, quantity: positiveInt }))
  .min(1, 'El carrito está vacío')
  .max(60, 'Demasiados productos en un pedido');

export const addressInputSchema = z.object({
  label: z.string().trim().min(1).max(30).default('Casa'),
  line1: z.string().trim().min(3, 'Escribe la calle y el número').max(160),
  reference: z.string().trim().max(240).default(''),
  sector: z.string().trim().min(2, 'Indica tu sector').max(80),
  city: z.string().trim().min(2, 'Indica tu ciudad').max(80),
  latitude: z
    .number()
    .min(DR_BOUNDS.minLat, OUTSIDE_DR_MESSAGE)
    .max(DR_BOUNDS.maxLat, OUTSIDE_DR_MESSAGE)
    .nullable()
    .default(null),
  longitude: z
    .number()
    .min(DR_BOUNDS.minLng, OUTSIDE_DR_MESSAGE)
    .max(DR_BOUNDS.maxLng, OUTSIDE_DR_MESSAGE)
    .nullable()
    .default(null),
  contactPhone: z.string().max(30).nullable().default(null),
});

export const addressWithDefaultSchema = addressInputSchema.extend({
  isDefault: z.boolean().default(false),
});

// ── cuerpos y consultas de cada ruta (copia de apps/api/src/routes/*.ts) ──

export const productsQuerySchema = z.object({
  category: z.string().max(40).optional(),
  subcategory: z.string().max(60).optional(),
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const groupParamsSchema = z.object({ group: z.string().min(1).max(80) });

export const zoneQuerySchema = z.object({
  sector: z.string().max(80).default(''),
  city: z.string().max(80).default(''),
});

export const quoteBodySchema = z.object({
  items: itemsSchema,
  address: addressInputSchema.pick({ sector: true, city: true }).partial().optional(),
  couponCode: couponCodeField,
});

export const createOrderBodySchema = z
  .object({
    items: itemsSchema,
    addressId: uuid.optional(),
    address: addressInputSchema.optional(),
    slotStart: z.coerce.date(),
    paymentMethod: z.enum(['card', 'cash', 'transfer']),
    notes: z.string().trim().max(500).optional(),
    substitutionPolicy: z.enum(['contact', 'substitute', 'refund']).optional(),
    couponCode: couponCodeField,
  })
  .refine((b) => b.addressId || b.address, { message: 'Indica la dirección de entrega' });

export const idParamsSchema = z.object({ id: uuid });

export const cancelBodySchema = z.object({ reason: z.string().trim().max(200).default('') });

export const transferProofBodySchema = z.object({
  reference: z.string().trim().min(3).max(80),
  note: z.string().trim().max(300).optional(),
});

export const otpRequestBodySchema = z.object({ phone: z.string().min(7).max(30) });

export const otpVerifyBodySchema = z.object({
  phone: z.string().min(7).max(30),
  code: z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
});

export const patchMeBodySchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().email('Correo inválido').max(120).nullable().optional(),
});

const EXPO_TOKEN = /^(?:Exponent|Expo)PushToken\[[A-Za-z0-9_-]{8,200}\]$/;
export const isExpoPushToken = (token: string): boolean =>
  token.length <= 255 && EXPO_TOKEN.test(token);

export const deviceBodySchema = z.object({
  token: z
    .string('Falta el token del dispositivo')
    .trim()
    .refine(isExpoPushToken, 'Token de notificaciones inválido'),
  platform: z.enum(['ios', 'android', 'web'], {
    error: 'Plataforma inválida (ios, android o web)',
  }),
});

export const deviceTokenParamsSchema = z.object({ token: z.string().min(1).max(255) });
