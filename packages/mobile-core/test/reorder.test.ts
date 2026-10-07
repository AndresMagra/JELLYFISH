import type { ProductDTO, ReorderDTO, ReorderLineDTO, VariantDTO } from '@jellyfish/shared';
import { describe, expect, it } from 'vitest';
import { mergeReorderQuantity, planReorder, reorderSummaryText } from '../src/logic/reorder';

const variant = (id: string, over: Partial<VariantDTO> = {}): VariantDTO => ({
  id,
  sku: `SKU-${id}`,
  variant: '',
  pricingUnit: 'lb',
  price: 10_000,
  itbisBps: 0,
  variableWeight: true,
  frozen: true,
  stepCentilb: 50,
  minCentilb: 100,
  pieceCentilb: null,
  available: 5_000,
  inStock: true,
  photo: 'https://example.com/p.png',
  photoIllustrative: true,
  unconfirmed: false,
  ...over,
});

const product = (group: string, variants: VariantDTO[]): ProductDTO => ({
  group,
  name: group,
  category: 'res',
  subcategory: '',
  description: '',
  cookingTip: '',
  pricingUnit: variants[0]?.pricingUnit ?? 'lb',
  fromPrice: 10_000,
  variants,
});

const line = (variantId: string, over: Partial<ReorderLineDTO> = {}): ReorderLineDTO => ({
  variantId,
  name: variantId,
  variant: '',
  photo: 'https://example.com/p.png',
  photoIllustrative: true,
  pricingUnit: 'lb',
  unitPrice: 10_000,
  previousUnitPrice: 10_000,
  requestedQuantity: 200,
  quantity: 200,
  status: 'ok',
  ...over,
});

const order = (lines: ReorderLineDTO[]): ReorderDTO => ({
  orderId: 'o1',
  code: 'JF-000001',
  demo: false,
  lines,
});

describe('planReorder', () => {
  const catalog = [
    product('bistec', [variant('v-bistec')]),
    product('camaron', [variant('v-cam-a'), variant('v-cam-b', { available: 100 })]),
    product('combo', [
      variant('v-combo', {
        pricingUnit: 'unit',
        stepCentilb: null,
        minCentilb: null,
        available: 3,
      }),
    ]),
    product('agotado', [variant('v-out', { inStock: false, available: 0 })]),
  ];

  it('agrega las líneas ok con la cantidad que devuelve el servidor', () => {
    const plan = planReorder(
      order([line('v-bistec', { quantity: 250, requestedQuantity: 250 })]),
      catalog,
    );
    expect(plan.summary).toEqual({ added: 1, reduced: 0, unavailable: 0, priceChanged: 0 });
    expect(plan.toAdd).toHaveLength(1);
    expect(plan.toAdd[0]).toMatchObject({ outcome: 'added', quantity: 250 });
    expect(plan.toAdd[0]!.product?.group).toBe('bistec');
    expect(plan.toAdd[0]!.variant?.id).toBe('v-bistec');
  });

  it('las líneas reduced se agregan con la cantidad reducida y se explican', () => {
    const plan = planReorder(
      order([
        line('v-cam-a', {
          status: 'reduced',
          requestedQuantity: 400,
          quantity: 150,
          reason: 'Solo quedan 1.5 lb',
        }),
      ]),
      catalog,
    );
    expect(plan.summary.reduced).toBe(1);
    expect(plan.toAdd[0]).toMatchObject({ outcome: 'reduced', quantity: 150 });
    expect(plan.toAdd[0]!.note).toContain('Agregamos 1.5 lb de 4 lb que pediste');
    expect(plan.toAdd[0]!.note).toContain('Solo quedan 1.5 lb');
  });

  it('las líneas unavailable no van al carrito y traen su motivo', () => {
    const plan = planReorder(
      order([line('v-out', { status: 'unavailable', quantity: 0, reason: 'Agotado por ahora' })]),
      catalog,
    );
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.summary.unavailable).toBe(1);
    expect(plan.items[0]).toMatchObject({
      outcome: 'unavailable',
      quantity: 0,
      note: 'Agotado por ahora',
    });
  });

  it('una línea ok que ya no existe en el catálogo se trata como sin existencia', () => {
    const plan = planReorder(order([line('v-fantasma')]), catalog);
    expect(plan.summary).toEqual({ added: 0, reduced: 0, unavailable: 1, priceChanged: 0 });
    expect(plan.items[0]!.note).toBe('Ya no está en el catálogo');
  });

  it('si el catálogo de hoy tiene menos que lo que dijo el servidor, la cantidad baja y cuenta como reducida', () => {
    // el servidor dijo 3 lb, pero la app ve solo 1 lb disponible
    const plan = planReorder(
      order([line('v-cam-b', { quantity: 300, requestedQuantity: 300 })]),
      catalog,
    );
    expect(plan.toAdd[0]).toMatchObject({ outcome: 'reduced', quantity: 100 });
  });

  it('un artículo agotado hoy no se agrega aunque el servidor lo haya dado por bueno', () => {
    const plan = planReorder(order([line('v-out')]), catalog);
    expect(plan.summary.unavailable).toBe(1);
    expect(plan.toAdd).toHaveLength(0);
  });

  it('un artículo marcado sin existencia hoy no se agrega aunque sus datos aún digan que hay', () => {
    const odd = [product('raro', [variant('v-raro', { inStock: false, available: 500 })])];
    const plan = planReorder(order([line('v-raro')]), odd);
    expect(plan.toAdd).toHaveLength(0);
    expect(plan.items[0]).toMatchObject({ outcome: 'unavailable', note: 'Se agotó' });
  });

  it('respeta los pasos: nunca agrega una cantidad que no sea múltiplo del paso', () => {
    const plan = planReorder(
      order([line('v-bistec', { quantity: 275, requestedQuantity: 275 })]),
      catalog,
    );
    expect(plan.toAdd[0]!.quantity % 50).toBe(0);
    expect(plan.toAdd[0]!.outcome).toBe('reduced');
  });

  it('productos por unidad: cantidades enteras y tope por existencias', () => {
    const plan = planReorder(
      order([line('v-combo', { pricingUnit: 'unit', quantity: 5, requestedQuantity: 5 })]),
      catalog,
    );
    expect(plan.toAdd[0]).toMatchObject({ outcome: 'reduced', quantity: 3 });
    expect(plan.toAdd[0]!.note).toContain('Agregamos 3 u. de 5 u. que pediste');
  });

  it('avisa si el precio cambió (y lo cuenta solo en líneas agregadas)', () => {
    const plan = planReorder(
      order([
        line('v-bistec', { unitPrice: 12_000, previousUnitPrice: 10_000 }),
        line('v-out', {
          status: 'unavailable',
          quantity: 0,
          unitPrice: 9_000,
          previousUnitPrice: 8_000,
        }),
      ]),
      catalog,
    );
    expect(plan.summary.priceChanged).toBe(1);
    expect(plan.items[0]!.priceChanged).toBe(true);
    expect(plan.items[0]!.note).toContain('El precio cambió: antes RD$ 100.00, ahora RD$ 120.00');
  });

  it('una línea ok con motivo (subió al mínimo) conserva el motivo como nota', () => {
    const plan = planReorder(
      order([
        line('v-bistec', {
          quantity: 100,
          requestedQuantity: 50,
          reason: 'El mínimo ahora es 1 lb',
        }),
      ]),
      catalog,
    );
    expect(plan.toAdd[0]).toMatchObject({
      outcome: 'added',
      quantity: 100,
      note: 'El mínimo ahora es 1 lb',
    });
  });

  it('un pedido mixto: se parten bien las cuentas y se conserva el orden', () => {
    const plan = planReorder(
      order([
        line('v-bistec'),
        line('v-cam-a', { status: 'reduced', requestedQuantity: 400, quantity: 200 }),
        line('v-out', { status: 'unavailable', quantity: 0 }),
        line('v-combo', { pricingUnit: 'unit', quantity: 2, requestedQuantity: 2 }),
      ]),
      catalog,
    );
    expect(plan.summary).toEqual({ added: 2, reduced: 1, unavailable: 1, priceChanged: 0 });
    expect(plan.toAdd.map((i) => i.line.variantId)).toEqual(['v-bistec', 'v-cam-a', 'v-combo']);
  });
});

describe('reorderSummaryText', () => {
  it('arma el resumen tal como lo ve la persona', () => {
    expect(reorderSummaryText({ added: 2, reduced: 1, unavailable: 1, priceChanged: 0 })).toBe(
      '2 productos agregados · 1 con menos cantidad · 1 sin existencia',
    );
  });
  it('usa el singular y omite lo que está en cero', () => {
    expect(reorderSummaryText({ added: 1, reduced: 0, unavailable: 0, priceChanged: 0 })).toBe(
      '1 producto agregado',
    );
    expect(reorderSummaryText({ added: 0, reduced: 0, unavailable: 2, priceChanged: 0 })).toBe(
      '2 sin existencia',
    );
  });
  it('si no hay nada dice que no hay nada', () => {
    expect(reorderSummaryText({ added: 0, reduced: 0, unavailable: 0, priceChanged: 0 })).toBe(
      'No hay nada para agregar',
    );
  });
});

describe('mergeReorderQuantity', () => {
  const rules = { pricingUnit: 'lb' as const, stepCentilb: 50, minCentilb: 100 };

  it('sin línea previa usa lo del pedido anterior', () => {
    expect(mergeReorderQuantity(undefined, 250, rules, 5_000)).toBe(250);
  });
  it('es idempotente: pedir de nuevo dos veces deja el carrito igual (no suma)', () => {
    const once = mergeReorderQuantity(undefined, 250, rules, 5_000);
    expect(mergeReorderQuantity(once, 250, rules, 5_000)).toBe(once);
  });
  it('si el carrito ya tenía más, lo conserva', () => {
    expect(mergeReorderQuantity(500, 200, rules, 5_000)).toBe(500);
  });
  it('si el pedido anterior tenía más, sube a esa cantidad', () => {
    expect(mergeReorderQuantity(100, 300, rules, 5_000)).toBe(300);
  });
  it('no pasa de las existencias', () => {
    expect(mergeReorderQuantity(100, 800, rules, 400)).toBe(400);
  });
  it('si hoy no alcanza ni el mínimo, no borra lo que ya estaba en el carrito', () => {
    expect(mergeReorderQuantity(150, 200, rules, 50)).toBe(150);
  });
});
