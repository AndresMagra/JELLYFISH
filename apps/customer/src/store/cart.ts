import {
  type PricedLineInput,
  type ProductDTO,
  type QuantityRules,
  type VariantDTO,
  computeOrderTotals,
  stepDown,
  stepUp,
} from '@jellyfish/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { mergeReorderQuantity, plainStorage } from '@jellyfish/mobile-core';

export interface CartLine extends QuantityRules {
  variantId: string;
  group: string;
  name: string;
  variant: string;
  category: string;
  unitPrice: number;
  itbisBps: number;
  variableWeight: boolean;
  frozen: boolean;
  /** Centilibras (por libra) o unidades. */
  quantity: number;
  /** Lo disponible cuando se agregó; el servidor valida de nuevo al cotizar. */
  available: number;
  photo: string;
  /** false = foto real del producto. Carritos guardados antes de este campo se tratan como ilustrativos. */
  photoIllustrative?: boolean;
}

/** Lo que "Pedir de nuevo" agrega: producto, variante y la cantidad ya validada. */
export interface CartAddition {
  product: ProductDTO;
  variant: VariantDTO;
  quantity: number;
}

function toLine(product: ProductDTO, v: VariantDTO, quantity: number): CartLine {
  return {
    variantId: v.id,
    group: product.group,
    name: product.name,
    variant: v.variant,
    category: product.category,
    pricingUnit: v.pricingUnit,
    stepCentilb: v.stepCentilb,
    minCentilb: v.minCentilb,
    unitPrice: v.price,
    itbisBps: v.itbisBps,
    variableWeight: v.variableWeight,
    frozen: v.frozen,
    quantity,
    available: v.available,
    photo: v.photo,
    photoIllustrative: v.photoIllustrative,
  };
}

interface CartState {
  lines: CartLine[];
  add: (product: ProductDTO, variant: VariantDTO) => void;
  /** Pedir de nuevo: agrega varias líneas a la vez (sin duplicar si ya estaban). */
  addMany: (items: CartAddition[]) => void;
  increment: (variantId: string) => void;
  decrement: (variantId: string) => void;
  remove: (variantId: string) => void;
  clear: () => void;
}

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],

      add: (product, v) =>
        set((s) => {
          const existing = s.lines.find((l) => l.variantId === v.id);
          if (existing) {
            return {
              lines: s.lines.map((l) =>
                l.variantId === v.id
                  ? { ...l, quantity: stepUp(l.quantity, l, v.available), available: v.available }
                  : l,
              ),
            };
          }
          const quantity = stepUp(0, v, v.available);
          if (quantity === 0) return s; // no hay ni el mínimo disponible
          const line = toLine(product, v, quantity);
          return { lines: [...s.lines, line] };
        }),

      addMany: (items) =>
        set((s) => {
          let lines = s.lines;
          for (const { product, variant: v, quantity } of items) {
            const existing = lines.find((l) => l.variantId === v.id);
            const next = mergeReorderQuantity(existing?.quantity, quantity, v, v.available);
            if (next <= 0) continue;
            lines = existing
              ? lines.map((l) => (l.variantId === v.id ? { ...toLine(product, v, next) } : l))
              : [...lines, toLine(product, v, next)];
          }
          return { lines };
        }),

      increment: (variantId) =>
        set((s) => ({
          lines: s.lines.map((l) =>
            l.variantId === variantId ? { ...l, quantity: stepUp(l.quantity, l, l.available) } : l,
          ),
        })),

      decrement: (variantId) =>
        set((s) => ({
          lines: s.lines
            .map((l) =>
              l.variantId === variantId ? { ...l, quantity: stepDown(l.quantity, l) } : l,
            )
            .filter((l) => l.quantity > 0),
        })),

      remove: (variantId) =>
        set((s) => ({ lines: s.lines.filter((l) => l.variantId !== variantId) })),
      clear: () => set({ lines: [] }),
    }),
    {
      name: 'jellyfish.cart',
      version: 1,
      storage: createJSONStorage(() => plainStorage),
    },
  ),
);

/** Cantidad total de líneas (para el globito del carrito). */
export const selectCount = (s: CartState) => s.lines.length;

export function quantityOf(lines: CartLine[], variantId: string): number {
  return lines.find((l) => l.variantId === variantId)?.quantity ?? 0;
}

/** Totales locales (estimados) mientras llega la cotización oficial del servidor. */
export function localTotals(lines: CartLine[], deliveryFee = 0) {
  const inputs: PricedLineInput[] = lines.map((l) => ({
    id: l.variantId,
    pricingUnit: l.pricingUnit,
    unitPrice: l.unitPrice,
    itbisBps: l.itbisBps,
    quantity: l.quantity,
    variableWeight: l.variableWeight,
  }));
  return computeOrderTotals(inputs, { deliveryFee });
}
