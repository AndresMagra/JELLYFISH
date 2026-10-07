import type { UserDTO } from '@jellyfish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useSession } from './session';

/** Reactivo: las consultas privadas se activan al iniciar sesión y se detienen al cerrarla. */
export const useSignedIn = () => useSession((s) => !!s.token);

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
