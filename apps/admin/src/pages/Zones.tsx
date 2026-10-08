import type { ZoneDTO } from '@jellyfish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHead,
  StaleNote,
  useToast,
} from '../components/ui';
import { api } from '../lib/api';
import { MONEY_ERROR, centavosToPesos, formatDOP, pesosToCentavos } from '../lib/format';

export function Zones() {
  const [editing, setEditing] = useState<ZoneDTO | 'new' | null>(null);
  const q = useQuery({
    queryKey: ['admin', 'zones'],
    queryFn: () => api<ZoneDTO[]>('/v1/admin/zones'),
  });
  return (
    <>
      <PageHead
        title="Zonas de entrega"
        subtitle="Dónde entregas, cuánto cobras de envío y desde qué monto es gratis"
        actions={
          <Button onClick={() => setEditing('new')} data-testid="new-zone">
            Nueva zona
          </Button>
        }
      />
      {q.isError && q.data ? (
        <StaleNote error={q.error} onRetry={() => void q.refetch()} busy={q.isFetching} />
      ) : null}
      {q.isLoading ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <Empty
          title="Aún no entregas en ninguna zona"
          text="Crea la primera: sin zonas, los clientes no pueden hacer pedidos."
        />
      ) : (
        <div className="grid cols-2">
          {q.data!.map((z) => (
            <Card
              key={z.id}
              title={z.name}
              actions={
                <Badge tone={z.active ? 'success' : 'neutral'}>
                  {z.active ? 'Activa' : 'Pausada'}
                </Badge>
              }
            >
              <div className="stack" style={{ gap: 6 }}>
                <div>
                  Envío <strong>{formatDOP(z.feeCentavos)}</strong>
                  {z.freeOverCentavos !== null ? (
                    <>
                      {' '}
                      · gratis desde <strong>{formatDOP(z.freeOverCentavos)}</strong>
                    </>
                  ) : null}
                </div>
                <div>
                  Pedido mínimo <strong>{formatDOP(z.minOrderCentavos)}</strong>
                </div>
                <div className="muted small">Cubre: {z.areas.join(', ')}</div>
                <div>
                  <Button
                    small
                    variant="secondary"
                    onClick={() => setEditing(z)}
                    data-testid={`edit-zone-${z.name}`}
                  >
                    Editar
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing ? (
        <ZoneDialog zone={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

function ZoneDialog({ zone, onClose }: { zone: ZoneDTO | null; onClose: () => void }) {
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(zone?.name ?? '');
  const [areas, setAreas] = useState(zone?.areas.join(', ') ?? '');
  const [fee, setFee] = useState(zone ? centavosToPesos(zone.feeCentavos) : '150.00');
  const [min, setMin] = useState(zone ? centavosToPesos(zone.minOrderCentavos) : '0.00');
  const [free, setFree] = useState(
    zone?.freeOverCentavos != null ? centavosToPesos(zone.freeOverCentavos) : '',
  );
  const [active, setActive] = useState(zone?.active ?? true);

  const list = areas
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const feeC = pesosToCentavos(fee);
  const minC = pesosToCentavos(min);
  const freeC = free.trim() === '' ? null : pesosToCentavos(free);
  const valid =
    name.trim().length >= 2 &&
    list.length > 0 &&
    feeC !== null &&
    minC !== null &&
    (free.trim() === '' || freeC !== null);

  const m = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        areas: list,
        feeCentavos: feeC,
        minOrderCentavos: minC,
        freeOverCentavos: freeC,
        active,
      };
      return zone
        ? api(`/v1/admin/zones/${zone.id}`, { method: 'PATCH', body })
        : api('/v1/admin/zones', { method: 'POST', body: { ...body, active: undefined } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'zones'] });
      notify('Zona guardada');
      onClose();
    },
    onError: fail,
  });

  return (
    <Modal
      title={zone ? `Editar ${zone.name}` : 'Nueva zona'}
      onClose={onClose}
      busy={m.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            busy={m.isPending}
            disabled={!valid}
            onClick={() => m.mutate()}
            data-testid="zone-save"
          >
            Guardar
          </Button>
        </>
      }
    >
      <Field label="Nombre de la zona">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ej: Distrito Nacional"
          data-testid="zone-name"
        />
      </Field>
      <Field
        label="Sectores y ciudades que cubre"
        hint="Separados por coma. Se comparan sin importar acentos ni mayúsculas."
      >
        <textarea
          className="input"
          rows={3}
          value={areas}
          onChange={(e) => setAreas(e.target.value)}
          placeholder="Naco, Piantini, Bella Vista, Distrito Nacional"
          data-testid="zone-areas"
        />
      </Field>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Field label="Envío (RD$)" error={feeC === null ? MONEY_ERROR : null}>
          <input
            className="input"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            inputMode="decimal"
            data-testid="zone-fee"
          />
        </Field>
        <Field label="Pedido mínimo (RD$)" error={minC === null ? MONEY_ERROR : null}>
          <input
            className="input"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            inputMode="decimal"
            data-testid="zone-min"
          />
        </Field>
        <Field
          label="Envío gratis desde (RD$)"
          hint="Déjalo vacío si no ofreces envío gratis"
          error={free.trim() !== '' && freeC === null ? MONEY_ERROR : null}
        >
          <input
            className="input"
            value={free}
            onChange={(e) => setFree(e.target.value)}
            inputMode="decimal"
            data-testid="zone-free"
          />
        </Field>
      </div>
      {zone ? (
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Zona activa (si la pausas, no se aceptan pedidos nuevos ahí)
        </label>
      ) : null}
    </Modal>
  );
}
