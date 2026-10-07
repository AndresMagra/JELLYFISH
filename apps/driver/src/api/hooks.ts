import type { DriverLocationAckDTO, OrderDTO } from '@jellyfish/shared';
import { ApiError, type GeoFix, api, toLocationBody, useSignedIn } from '@jellyfish/mobile-core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** Entregas asignadas a este repartidor que siguen activas. Se actualiza solo cada 15 s. */
export function useDeliveries() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['deliveries'],
    enabled: signedIn,
    queryFn: () => api<OrderDTO[]>('/v1/driver/orders'),
    refetchInterval: 15_000,
  });
}

type Move = 'out_for_delivery' | 'delivered' | 'delivery_failed';

/** Códigos del PIN y del cobro tras los cuales los datos del pedido cambiaron en el servidor. */
const REFRESH_ON = new Set(['pin_incorrect', 'pin_locked', 'pin_required', 'cash_not_collected']);

export function useMove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; to: Move; note?: string; pin?: string }) =>
      api<OrderDTO>(`/v1/driver/orders/${v.id}/transition`, {
        method: 'POST',
        body: { to: v.to, note: v.note ?? '', ...(v.pin !== undefined ? { pin: v.pin } : {}) },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }),
    // Un PIN fallido gasta un intento: se vuelve a leer el pedido para ver los que quedan.
    onError: (e) => {
      if (e instanceof ApiError && REFRESH_ON.has(e.code)) {
        void qc.invalidateQueries({ queryKey: ['deliveries'] });
      }
    },
  });
}

export function useCollectCash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; amount: number }) =>
      api<OrderDTO>(`/v1/driver/orders/${v.id}/collect`, {
        method: 'POST',
        body: { amount: v.amount },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }),
  });
}

/**
 * Manda la posición del repartidor (POST /v1/driver/location). Si el API dice que el pedido ya no
 * es suyo (403/404: se entregó o se reasignó mientras tanto) reintenta sin `orderId` para que la
 * posición siga viva para los otros pedidos en camino.
 */
export async function sendDriverLocation(
  fix: GeoFix,
  orderId: string | null,
): Promise<DriverLocationAckDTO> {
  const post = (id: string | null) =>
    api<DriverLocationAckDTO>('/v1/driver/location', {
      method: 'POST',
      body: toLocationBody(fix, id),
    });
  try {
    return await post(orderId);
  } catch (e) {
    if (orderId && e instanceof ApiError && (e.status === 403 || e.status === 404)) {
      return post(null);
    }
    throw e;
  }
}
