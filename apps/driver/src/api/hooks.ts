import type { OrderDTO } from '@jellyfish/shared';
import { api, useSignedIn } from '@jellyfish/mobile-core';
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

export function useMove() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; to: Move; note?: string }) =>
      api<OrderDTO>(`/v1/driver/orders/${v.id}/transition`, {
        method: 'POST',
        body: { to: v.to, note: v.note ?? '' },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }),
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
