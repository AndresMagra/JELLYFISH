import type { AdminVariantDTO } from '@jellyfish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
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
  useToast,
} from '../components/ui';
import { api } from '../lib/api';
import { lbToCentilb, qtyLabel } from '../lib/format';

type Kind = 'receive' | 'adjust' | 'waste';
const KIND: Record<Kind, { title: string; hint: string; sign: 1 | -1 | 0 }> = {
  receive: { title: 'Recibir mercancía', hint: 'Cantidad que entró al congelador', sign: 1 },
  waste: { title: 'Registrar merma', hint: 'Cantidad que se dañó, venció o se perdió', sign: -1 },
  adjust: {
    title: 'Ajustar por conteo',
    hint: 'Escribe cuántas libras/unidades hay realmente',
    sign: 0,
  },
};

export function Inventory() {
  const [search, setSearch] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [target, setTarget] = useState<{ row: AdminVariantDTO; kind: Kind } | null>(null);

  const list = useQuery({
    queryKey: ['admin', 'catalog'],
    queryFn: () => api<AdminVariantDTO[]>('/v1/admin/catalog'),
  });

  const rows = useMemo(() => {
    const t = search.trim().toLowerCase();
    return (list.data ?? []).filter((r) => {
      const available = r.onHand - r.reserved;
      return (
        (!onlyLow || available <= Math.max(r.lowStockThreshold, 0)) &&
        (!t || `${r.productName} ${r.variant} ${r.sku}`.toLowerCase().includes(t))
      );
    });
  }, [list.data, search, onlyLow]);

  return (
    <>
      <PageHead
        title="Inventario"
        subtitle="Existencias en el congelador. Lo reservado es de pedidos que aún no se empacan."
      />
      <Card>
        <div className="row wrap" style={{ marginBottom: 14 }}>
          <input
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="Buscar producto o SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="inv-search"
          />
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={onlyLow}
              onChange={(e) => setOnlyLow(e.target.checked)}
            />
            Solo sin existencias o bajos
          </label>
          <span className="muted small grow right">
            {rows.length} {rows.length === 1 ? 'artículo' : 'artículos'}
          </span>
        </div>
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <Empty title="Sin resultados" />
        ) : (
          <div className="table-wrap" style={{ maxHeight: '70vh' }}>
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="right">En existencia</th>
                  <th className="right">Reservado</th>
                  <th className="right">Disponible</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const available = r.onHand - r.reserved;
                  return (
                    <tr key={r.id} data-testid={`inv-${r.sku}`}>
                      <td>
                        <strong>{r.productName}</strong>
                        {r.variant ? <span className="muted"> · {r.variant}</span> : null}
                        <div className="muted small">{r.sku}</div>
                      </td>
                      <td className="right nowrap">{qtyLabel(r.pricingUnit, r.onHand)}</td>
                      <td className="right nowrap muted">{qtyLabel(r.pricingUnit, r.reserved)}</td>
                      <td className="right nowrap">
                        {available <= 0 ? (
                          <Badge tone="danger">Agotado</Badge>
                        ) : available <= r.lowStockThreshold ? (
                          <Badge tone="warning">{qtyLabel(r.pricingUnit, available)}</Badge>
                        ) : (
                          qtyLabel(r.pricingUnit, available)
                        )}
                      </td>
                      <td className="right nowrap">
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <Button
                            small
                            onClick={() => setTarget({ row: r, kind: 'receive' })}
                            data-testid={`receive-${r.sku}`}
                          >
                            Recibir
                          </Button>
                          <Button
                            small
                            variant="ghost"
                            onClick={() => setTarget({ row: r, kind: 'adjust' })}
                          >
                            Conteo
                          </Button>
                          <Button
                            small
                            variant="ghost"
                            onClick={() => setTarget({ row: r, kind: 'waste' })}
                          >
                            Merma
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {target ? (
        <AdjustDialog row={target.row} kind={target.kind} onClose={() => setTarget(null)} />
      ) : null}
    </>
  );
}

function AdjustDialog({
  row,
  kind,
  onClose,
}: {
  row: AdminVariantDTO;
  kind: Kind;
  onClose: () => void;
}) {
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const isLb = row.pricingUnit === 'lb';
  const meta = KIND[kind];

  // lb → centilibras; unidades → entero
  const parsed = isLb ? lbToCentilb(text) : /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  const delta =
    parsed === null ? null : kind === 'adjust' ? parsed - row.onHand : meta.sign * parsed;
  const valid =
    parsed !== null && parsed > 0 + (kind === 'adjust' ? -1 : 0) && delta !== 0 && delta !== null;

  const m = useMutation({
    mutationFn: () =>
      api('/v1/admin/inventory/adjust', {
        method: 'POST',
        body: { variantId: row.id, type: kind, delta, note: note.trim() || meta.title },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
      notify('Inventario actualizado');
      onClose();
    },
    onError: fail,
  });

  return (
    <Modal
      title={`${meta.title} · ${row.productName}${row.variant ? ` ${row.variant}` : ''}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            busy={m.isPending}
            disabled={!valid}
            onClick={() => m.mutate()}
            data-testid="inv-confirm"
          >
            Guardar
          </Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        Ahora hay {qtyLabel(row.pricingUnit, row.onHand)} ({qtyLabel(row.pricingUnit, row.reserved)}{' '}
        reservadas). {meta.hint}.
      </p>
      <Field
        label={`Cantidad (${isLb ? 'libras' : 'unidades'})`}
        hint={
          delta !== null && delta !== 0
            ? `Quedarán ${qtyLabel(row.pricingUnit, row.onHand + delta)}`
            : undefined
        }
      >
        <input
          className="input"
          autoFocus
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="inv-qty"
        />
      </Field>
      <Field label="Nota (opcional)">
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Ej: llegó pedido del proveedor"
        />
      </Field>
    </Modal>
  );
}
