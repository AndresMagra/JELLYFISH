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
  type SlotDTO,
  type StartPaymentDTO,
  type TransferInfoDTO,
  type UserDTO,
  type ZoneCheckDTO,
  isTerminal,
} from '@jellyfish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '../store/session';
import { api } from './client';

/** Reactivo: las consultas privadas se activan al iniciar sesión y se detienen al cerrarla. */
export const useSignedIn = () => useSession((s) => !!s.token);

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
}

/** Cotización oficial del servidor (precios, ITBIS, envío, cobertura). */
export const useQuote = (req: QuoteRequest) =>
  useQuery({
    queryKey: ['quote', req],
    enabled: req.items.length > 0,
    queryFn: () => api<QuoteDTO>('/v1/quote', { method: 'POST', body: req }),
    retry: false,
    staleTime: 15_000,
  });

// ───────────── sesión y cuenta ─────────────

export const useRequestOtp = () =>
  useMutation({
    mutationFn: (phone: string) =>
      api<{ phone: string; expiresInSeconds: number }>('/v1/auth/otp/request', {
        method: 'POST',
        body: { phone },
        silent401: true,
      }),
  });

export const useVerifyOtp = () =>
  useMutation({
    mutationFn: (v: { phone: string; code: string }) =>
      api<{ token: string; user: UserDTO }>('/v1/auth/otp/verify', {
        method: 'POST',
        body: v,
        silent401: true,
      }),
  });

export function useMe() {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: ['me'], enabled: signedIn, queryFn: () => api<UserDTO>('/v1/me') });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { name?: string; email?: string | null }) =>
      api<UserDTO>('/v1/me', { method: 'PATCH', body: patch }),
    onSuccess: (user) => {
      useSession.getState().setUser(user);
      qc.setQueryData(['me'], user);
    },
  });
}

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
      return status && isTerminal(status) ? false : 8_000;
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
