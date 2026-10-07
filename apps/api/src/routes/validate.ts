import { DR_BOUNDS, OUTSIDE_DR_MESSAGE } from '@jellyfish/shared';
import { type ZodType, z } from 'zod';
import { invalid } from '../errors';

/** Valida con zod y devuelve un error 400 en español con el campo que falló. */
export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first?.path.length ? `${first.path.join('.')}: ` : '';
  throw invalid(`${where}${first?.message ?? 'Datos inválidos'}`, result.error.issues);
}

export const uuid = z.string().uuid('Identificador inválido');
export const positiveInt = z.number().int().positive();

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
  // Coordenadas del punto de entrega (opcionales): deben caer en RD para que el repartidor las siga.
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
