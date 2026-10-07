import type { OrderStatus } from '../order-status';

export const orderStatusLabel: Record<OrderStatus, string> = {
  pending_payment: 'Esperando pago',
  confirmed: 'Pedido confirmado',
  picking: 'Preparando tu pedido',
  packed: 'Empacado en frío',
  out_for_delivery: 'En camino',
  delivered: 'Entregado',
  delivery_failed: 'No pudimos entregar',
  cancelled: 'Cancelado',
  refunded: 'Reembolsado',
};

export const orderStatusHint: Record<OrderStatus, string> = {
  pending_payment: 'Completa el pago para confirmar tu pedido.',
  confirmed: 'Recibimos tu pedido y vamos a prepararlo.',
  picking: 'Estamos pesando y seleccionando tus cortes.',
  packed: 'Tu pedido está listo y empacado con hielo.',
  out_for_delivery: 'Tu repartidor va hacia tu dirección.',
  delivered: 'Que lo disfrutes. Guarda tus productos en el congelador.',
  delivery_failed: 'No logramos entregar. Te contactaremos para reprogramar.',
  cancelled: 'Este pedido fue cancelado.',
  refunded: 'Te devolvimos el dinero de este pedido.',
};

export const paymentMethodLabel = {
  card: 'Tarjeta de crédito/débito',
  cash: 'Efectivo contra entrega',
  transfer: 'Transferencia bancaria',
} as const;

export const unitLabel = {
  lb: 'por libra',
  unit: 'por unidad',
} as const;

export const coldChainNotice =
  'Producto congelado. Guárdalo en el congelador al recibirlo y no lo vuelvas a congelar una vez descongelado.';

export const illustrativeImageNotice = 'Imagen ilustrativa';
