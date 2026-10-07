import type { Bps, Centavos, Centilb, PricingUnit } from '@jellyfish/shared';

export const PRICE_SOURCES = ['ancla', 'estimado', 'usuario'] as const;
/**
 * ancla    → precio visto en un supermercado (referencia, aún sin verificar en la tienda).
 * estimado → calculado por ratio; NO publicable hasta confirmarlo.
 * usuario  → confirmado por el dueño del negocio (CSV propio o panel admin).
 */
export type PriceSource = (typeof PRICE_SOURCES)[number];

export interface CatalogItem {
  sku: string;
  /** Agrupa variantes (calibres, marcas) en una misma ficha de producto. */
  group: string;
  name: string;
  variant: string;
  category: string;
  subcategory: string;
  pricingUnit: PricingUnit;
  /** Incremento al elegir peso (centilibras). Solo 'lb'. */
  stepCentilb: Centilb | null;
  /** Mínimo a pedir (centilibras). Solo 'lb'. */
  minCentilb: Centilb | null;
  /** Peso aproximado de una pieza/paquete (centilibras). */
  pieceCentilb: Centilb | null;
  /** Precio por libra o por unidad, con ITBIS incluido. */
  price: Centavos;
  priceSource: PriceSource;
  priceNote: string;
  cost: Centavos | null;
  /** Existencias: centilibras si 'lb'; unidades si 'unit'. */
  stock: number;
  /** null = ITBIS por confirmar con el contador. */
  itbisBps: Bps | null;
  variableWeight: boolean;
  frozen: boolean;
  synonyms: string[];
  description: string;
  cookingTip: string;
  photo: string;
  /**
   * true = imagen ilustrativa (generada o de referencia): la app la rotula "Imagen ilustrativa".
   * false = foto real del producto. Ausente equivale a true: lo seguro es no prometer una foto real.
   */
  photoIllustrative?: boolean;
  active: boolean;
}

export interface RowIssue {
  /** Número de fila en el archivo (la cabecera es la 1). */
  line: number;
  sku: string;
  field: string;
  message: string;
}

export interface Publishability {
  publishable: boolean;
  reasons: string[];
}

export interface ParsedCatalog {
  items: CatalogItem[];
  errors: RowIssue[];
  warnings: RowIssue[];
}
