import type { FastifyInstance } from 'fastify';
import { expireStaleOrders } from './services/orders';

/**
 * Tarea periódica del servidor (cada minuto).
 *
 * Las reservas vencidas se cancelan DENTRO de `push.scope`: así esas cancelaciones, que no vienen
 * de ninguna petición, también avisan al cliente (y solo si la transacción se confirmó). Expo
 * reporta los tokens muertos en los recibos, minutos después del envío; aquí se consultan.
 * Cada paso falla por separado: uno caído no impide el otro.
 */
export async function runMaintenanceTick(app: FastifyInstance): Promise<{ cancelled: number }> {
  let cancelled = 0;
  try {
    cancelled = await app.push.scope(() => expireStaleOrders(app.orderCtx));
  } catch (e) {
    app.log.error(e, 'expireStaleOrders falló');
  }
  try {
    await app.push.checkReceipts();
  } catch (e) {
    app.log.error(e, 'checkReceipts falló');
  }
  return { cancelled };
}
