import {
  type ProductDTO,
  type ReorderDTO,
  type ReorderLineDTO,
  type QuantityRules,
  type VariantDTO,
  clampQuantity,
  formatDOP,
} from '@jellyfish/shared';
import { quantityLabel } from '../format';

/**
 * "Pedir de nuevo": convierte lo que devuelve GET /v1/orders/:id/reorder (el pedido anterior
 * contra el catálogo de HOY) en lo que se va a agregar al carrito y en un resumen para la persona.
 * Todo es lógica pura (sin red ni pantalla) para poder probarla.
 */

export type ReorderOutcome = 'added' | 'reduced' | 'unavailable';

export interface ReorderItem {
  line: ReorderLineDTO;
  outcome: ReorderOutcome;
  /** Cantidad que va al carrito (centilibras o unidades). 0 si no se agrega. */
  quantity: number;
  /** Producto y variante del catálogo de hoy; null cuando no se agrega. */
  product: ProductDTO | null;
  variant: VariantDTO | null;
  /** Explicación en español para mostrar junto a la línea ('' si no hace falta). */
  note: string;
  /** El precio de hoy no es el de la vez anterior. */
  priceChanged: boolean;
}

export interface ReorderSummary {
  /** Líneas agregadas tal cual se pidieron. */
  added: number;
  /** Líneas agregadas con menos cantidad que la vez anterior. */
  reduced: number;
  /** Líneas que no se pudieron agregar. */
  unavailable: number;
  /** Líneas agregadas cuyo precio cambió. */
  priceChanged: number;
}

export interface ReorderPlan {
  items: ReorderItem[];
  /** Solo lo que se agrega (added + reduced), en el orden del pedido. */
  toAdd: ReorderItem[];
  summary: ReorderSummary;
}

const qty = (v: Pick<QuantityRules, 'pricingUnit'>, q: number) => quantityLabel(v.pricingUnit, q);

export function planReorder(reorder: ReorderDTO, products: ProductDTO[]): ReorderPlan {
  const catalog = new Map<string, { product: ProductDTO; variant: VariantDTO }>();
  for (const product of products)
    for (const variant of product.variants) catalog.set(variant.id, { product, variant });

  const items: ReorderItem[] = reorder.lines.map((line): ReorderItem => {
    const gone = (note: string): ReorderItem => ({
      line,
      outcome: 'unavailable',
      quantity: 0,
      product: null,
      variant: null,
      note,
      priceChanged: false,
    });

    if (line.status === 'unavailable' || line.quantity <= 0)
      return gone(line.reason || 'Ya no está disponible');

    const found = catalog.get(line.variantId);
    if (!found) return gone('Ya no está en el catálogo');
    const { product, variant } = found;
    if (!variant.inStock) return gone('Se agotó');

    // El servidor ya ajustó la cantidad; se vuelve a ajustar con las existencias que ve la app ahora.
    const quantity = clampQuantity(line.quantity, variant, variant.available);
    if (quantity <= 0) return gone('No quedan existencias suficientes');

    const priceChanged = line.unitPrice !== line.previousUnitPrice;
    const reduced = line.status === 'reduced' || quantity < line.requestedQuantity;
    const priceNote = priceChanged
      ? `El precio cambió: antes ${formatDOP(line.previousUnitPrice)}, ahora ${formatDOP(line.unitPrice)}`
      : '';

    let note: string;
    if (reduced) {
      note = `Agregamos ${qty(line, quantity)} de ${qty(line, line.requestedQuantity)} que pediste`;
      if (line.reason) note += `. ${line.reason}`;
    } else {
      note = line.reason ?? '';
    }
    if (priceNote) note = note ? `${note}. ${priceNote}` : priceNote;

    return {
      line,
      outcome: reduced ? 'reduced' : 'added',
      quantity,
      product,
      variant,
      note,
      priceChanged,
    };
  });

  const summary: ReorderSummary = { added: 0, reduced: 0, unavailable: 0, priceChanged: 0 };
  for (const it of items) {
    summary[it.outcome]++;
    // Las líneas que no se agregan nunca llevan priceChanged (ver `gone`).
    if (it.priceChanged) summary.priceChanged++;
  }
  return { items, toAdd: items.filter((i) => i.outcome !== 'unavailable'), summary };
}

/**
 * "2 productos agregados · 1 con menos cantidad · 1 sin existencia".
 * Las cuentas no se solapan: cada línea del pedido cuenta en una sola parte.
 */
export function reorderSummaryText(s: ReorderSummary): string {
  const parts: string[] = [];
  if (s.added > 0)
    parts.push(`${s.added} ${s.added === 1 ? 'producto agregado' : 'productos agregados'}`);
  if (s.reduced > 0) parts.push(`${s.reduced} con menos cantidad`);
  if (s.unavailable > 0) parts.push(`${s.unavailable} sin existencia`);
  return parts.length ? parts.join(' · ') : 'No hay nada para agregar';
}

/**
 * Cantidad de una línea del carrito después de pedir de nuevo. No suma: usa la mayor entre lo que ya
 * había y lo del pedido anterior, para que tocar "Pedir de nuevo" dos veces deje el carrito igual.
 * Nunca borra una línea que ya estaba aunque hoy no alcance el mínimo.
 */
export function mergeReorderQuantity(
  existing: number | undefined,
  incoming: number,
  rules: QuantityRules,
  available: number,
): number {
  const have = existing ?? 0;
  const merged = clampQuantity(Math.max(have, incoming), rules, available);
  return merged > 0 ? merged : have;
}
