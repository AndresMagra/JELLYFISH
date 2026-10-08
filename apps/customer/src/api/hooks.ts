import {
  type AddressDTO,
  type AddressInput,
  type CategoryDTO,
  type OrderDTO,
  type PaymentMethodName,
  type PaymentMethodsDTO,
  type ProductDTO,
  type ProductListDTO,
  type QuoteDTO,
  type ReorderDTO,
  type SlotDTO,
  type StartPaymentDTO,
  type TrackingDTO,
  type TransferInfoDTO,
  type UserDTO,
  type ZoneCheckDTO,
  isTerminal,
} from '@jellyfish/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TRACKING_POLL_MS, api, planReorder, useSignedIn } from '@jellyfish/mobile-core';
import { IS_DEMO } from '../lib/config';

// ───────────── catálogo (público) ─────────────

export const useCategories = () =>
  useQuery({
    queryKey: ['categories'],
    queryFn: () => api<CategoryDTO[]>('/v1/categories'),
    staleTime: 10 * 60_000,
  });

export interface ProductQuery {
  category?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export const useProducts = (query: ProductQuery = {}) =>
  useQuery({
    queryKey: ['products', query],
    queryFn: () => api<ProductListDTO>('/v1/products', { query: { limit: 100, ...query } }),
    staleTime: 60_000,
  });

export const useProduct = (group: string | undefined) =>
  useQuery({
    queryKey: ['product', group],
    enabled: !!group,
    queryFn: () => api<{ product: ProductDTO; demo: boolean }>(`/v1/products/${group}`),
    staleTime: 30_000,
  });

// ───────────── entrega ─────────────

export const useZoneCheck = (sector: string, city: string) =>
  useQuery({
    queryKey: ['zone', sector, city],
    enabled: sector.trim().length >= 2 || city.trim().length >= 2,
    queryFn: () => api<ZoneCheckDTO>('/v1/delivery/zone', { query: { sector, city } }),
  });

export const useSlots = () =>
  useQuery({
    queryKey: ['slots'],
    queryFn: () => api<SlotDTO[]>('/v1/delivery/slots'),
    staleTime: 30_000,
  });

export const usePaymentMethods = () =>
  useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => api<PaymentMethodsDTO>('/v1/payments/methods'),
    staleTime: 5 * 60_000,
  });

export function useTransferInfo(enabled: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['transfer-info'],
    enabled: enabled && signedIn,
    queryFn: () => api<TransferInfoDTO>('/v1/payments/transfer-info'),
    staleTime: 10 * 60_000,
  });
}

export interface QuoteRequest {
  items: { variantId: string; quantity: number }[];
  address?: { sector: string; city: string };
  /** Código de cupón (ya normalizado). Si no sirve, la cotización lo explica en `couponError`. */
  couponCode?: string;
}

/**
 * Cotización oficial del servidor (precios, ITBIS, descuento de cupón, envío, cobertura).
 * `keepPrevious` deja a la vista la cotización anterior mientras llega la nueva (sin parpadeo);
 * quien lo usa debe revisar `isPlaceholderData` antes de dejar confirmar.
 */
export const useQuote = (req: QuoteRequest, opts: { keepPrevious?: boolean } = {}) =>
  useQuery({
    queryKey: ['quote', req],
    enabled: req.items.length > 0,
    queryFn: () => api<QuoteDTO>('/v1/quote', { method: 'POST', body: req }),
    retry: false,
    staleTime: 15_000,
    ...(opts.keepPrevious ? { placeholderData: keepPreviousData } : null),
  });

// ───────────── sesión y cuenta ─────────────

export const useDeleteAccount = () =>
  useMutation({ mutationFn: () => api<void>('/v1/me', { method: 'DELETE' }) });

// ───────────── direcciones ─────────────

export function useAddresses() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['addresses'],
    enabled: signedIn,
    queryFn: () => api<AddressDTO[]>('/v1/me/addresses'),
  });
}

export function useCreateAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: AddressInput) =>
      api<AddressDTO>('/v1/me/addresses', { method: 'POST', body: a }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['addresses'] }),
  });
}

export function useDeleteAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/v1/me/addresses/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['addresses'] }),
  });
}

// ───────────── pedidos ─────────────

export function useOrders() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['orders'],
    enabled: signedIn,
    queryFn: () => api<OrderDTO[]>('/v1/orders'),
  });
}

/** Detalle del pedido; se actualiza solo mientras el pedido siga activo. */
export function useOrder(id: string | undefined) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['order', id],
    enabled: !!id && signedIn,
    queryFn: () => api<OrderDTO>(`/v1/orders/${id}`),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      // En la vista previa las etapas duran segundos: se consulta más seguido para que se vean todas.
      return status && isTerminal(status) ? false : IS_DEMO ? 2_500 : 8_000;
    },
  });
}

export interface CreateOrderInput {
  items: { variantId: string; quantity: number }[];
  addressId: string;
  slotStart: string;
  paymentMethod: PaymentMethodName;
  notes?: string;
  substitutionPolicy: 'contact' | 'substitute' | 'refund';
  /** Cupón que se mostró en la cotización; el servidor lo vuelve a validar. */
  couponCode?: string;
  /** Misma clave en reintentos ⇒ el servidor no duplica el pedido. */
  idempotencyKey: string;
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: CreateOrderInput) =>
      api<OrderDTO>('/v1/orders', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}

export const useStartPayment = () =>
  useMutation({
    mutationFn: (orderId: string) =>
      api<StartPaymentDTO>(`/v1/orders/${orderId}/pay`, { method: 'POST' }),
  });

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reason?: string }) =>
      api<OrderDTO>(`/v1/orders/${v.id}/cancel`, {
        method: 'POST',
        body: { reason: v.reason ?? '' },
      }),
    onSuccess: (order) => {
      qc.setQueryData(['order', order.id], order);
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

/**
 * ¿Dónde va mi pedido? Pregunta cada ~15 s mientras la pantalla esté abierta y el pedido vaya en
 * camino. No usa mapa embebido: solo la última posición del repartidor.
 */
export function useTracking(orderId: string | undefined, enabled: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['tracking', orderId],
    enabled: !!orderId && enabled && signedIn,
    queryFn: () => api<TrackingDTO>(`/v1/orders/${orderId}/tracking`),
    refetchInterval: TRACKING_POLL_MS,
    refetchIntervalInBackground: false,
    // Es una posición en vivo: nunca se reutiliza una vieja.
    staleTime: 0,
    gcTime: 0,
  });
}

/** Todos los productos del catálogo (el API entrega hasta 100 por página). */
export async function fetchCatalog(): Promise<ProductDTO[]> {
  const out: ProductDTO[] = [];
  for (let page = 0; page < 10; page++) {
    const res = await api<ProductListDTO>('/v1/products', {
      query: { limit: 100, offset: page * 100 },
    });
    out.push(...res.items);
    if (res.items.length === 0 || out.length >= res.total) break;
  }
  return out;
}

/**
 * Pedir de nuevo: trae el pedido anterior contra el catálogo de hoy y arma el plan del carrito.
 * No toca el carrito: eso lo hace quien llama con el plan (así se puede mostrar el resumen).
 */
export function useReorder() {
  return useMutation({
    mutationFn: async (orderId: string) => {
      const [reorder, products] = await Promise.all([
        api<ReorderDTO>(`/v1/orders/${orderId}/reorder`),
        fetchCatalog(),
      ]);
      return planReorder(reorder, products);
    },
  });
}

export function useSubmitTransferProof() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reference: string; note?: string }) =>
      api<OrderDTO>(`/v1/orders/${v.id}/transfer-proof`, {
        method: 'POST',
        body: { reference: v.reference, note: v.note },
      }),
    onSuccess: (order) => qc.setQueryData(['order', order.id], order),
  });
}

export {
  useMe,
  useRequestOtp,
  useSignedIn,
  useUpdateMe,
  useVerifyOtp,
} from '@jellyfish/mobile-core';
