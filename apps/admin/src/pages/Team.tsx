import type { TeamMemberDTO } from '@jellyfish/shared';
import { normalizeDominicanPhone, formatDominicanPhone } from '@jellyfish/shared';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../auth';
import { Badge, Button, Card, Empty, Field, Loading, PageHead, useToast } from '../components/ui';
import { api } from '../lib/api';

const ROLE_LABEL = {
  admin: 'Administrador',
  staff: 'Personal',
  driver: 'Repartidor',
  customer: 'Cliente',
} as const;
const ROLES = ['driver', 'staff', 'admin'] as const;

export function Team() {
  const { user } = useAuth();
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const results = useQueries({
    queries: ROLES.map((role) => ({
      queryKey: ['admin', 'users', role],
      queryFn: () => api<TeamMemberDTO[]>('/v1/admin/users', { query: { role } }),
    })),
  });
  const members = results.flatMap((r) => r.data ?? []);
  const loading = results.some((r) => r.isLoading);

  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('driver');
  const e164 = normalizeDominicanPhone(phone);

  const invite = useMutation({
    mutationFn: () =>
      api('/v1/admin/users', {
        method: 'POST',
        body: { phone, name: name.trim() || undefined, role },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
      notify('Persona agregada. Entra con su celular y su código SMS.');
      setPhone('');
      setName('');
    },
    onError: fail,
  });
  const change = useMutation({
    mutationFn: (v: { id: string; role: string }) =>
      api(`/v1/admin/users/${v.id}/role`, { method: 'POST', body: { role: v.role } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
      notify('Rol actualizado');
    },
    onError: fail,
  });

  return (
    <>
      <PageHead title="Equipo" subtitle="Repartidores, personal y administradores" />
      <div className="grid cols-2">
        <Card title="Agregar a alguien">
          <div className="stack">
            <Field label="Celular" error={phone && !e164 ? 'Debe ser 809, 829 o 849' : null}>
              <input
                className="input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="809 555 1234"
                inputMode="tel"
                data-testid="team-phone"
              />
            </Field>
            <Field label="Nombre">
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Juan Pérez"
                data-testid="team-name"
              />
            </Field>
            <Field label="Rol">
              <select
                className="input"
                value={role}
                onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
                data-testid="team-role"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              busy={invite.isPending}
              disabled={!e164}
              onClick={() => invite.mutate()}
              data-testid="team-add"
            >
              Agregar al equipo
            </Button>
            <div className="muted small">
              La persona entra a su app o a este panel con su celular; no necesita contraseña.
            </div>
          </div>
        </Card>

        <Card title={`Equipo (${members.length})`}>
          {loading ? (
            <Loading />
          ) : members.length === 0 ? (
            <Empty title="Aún no hay equipo" />
          ) : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id} data-testid={`member-${m.phone}`}>
                      <td>
                        <strong>{m.name || 'Sin nombre'}</strong>
                        <div className="muted small">{formatDominicanPhone(m.phone)}</div>
                      </td>
                      <td className="right">
                        {m.id === user.id ? (
                          <Badge>Tú</Badge>
                        ) : (
                          <select
                            className="input"
                            style={{ width: 150 }}
                            value={m.role}
                            onChange={(e) => change.mutate({ id: m.id, role: e.target.value })}
                            aria-label={`Rol de ${m.name || m.phone}`}
                          >
                            {([...ROLES, 'customer'] as const).map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABEL[r]}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
