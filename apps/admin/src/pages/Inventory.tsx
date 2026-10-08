import type { AdminVariantDTO, ReceiveLotInput, StockLotDTO } from '@jellyfish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
  Tabs,
  useToast,
} from '../components/ui';
import { api, errorText } from '../lib/api';
import { dateTime, lbToCentilb, qtyLabel } from '../lib/format';
import {
  EXPIRING_WINDOWS,
  LOT_CODE_MAX,
  LOTS_LIMIT,
  LOT_NOTE_MAX,
  LOT_STATUS,
  checkLotForm,
  daysLeftText,
  expiryDateLabel,
  lotsLimitNote,
  searchVariants,
  truncatedMatchText,
  todayInRD,
} from '../lib/lots';
import './panel-extra.css';

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

type Tab = 'existencias' | 'lotes';

export function Inventory() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'lotes' ? 'lotes' : 'existencias';
  const tabs: readonly (readonly [Tab, string])[] = [
    ['existencias', 'Existencias'],
    ['lotes', 'Lotes y vencimientos'],
  ];
  return (
    <>
      <PageHead
        title="Inventario"
        subtitle="Existencias en el congelador. Lo reservado es de pedidos que aún no se empacan."
      />
      <Tabs
        tabs={tabs}
        value={tab}
        onChange={(k) => setParams(k === 'lotes' ? { tab: 'lotes' } : {}, { replace: true })}
        testIdPrefix="inv-tab-"
      >
        {tab === 'lotes' ? <Lots /> : <Stock />}
      </Tabs>
    </>
  );
}

function Stock() {
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
        {list.isError && list.data ? (
          <StaleNote
            error={list.error}
            onRetry={() => void list.refetch()}
            busy={list.isFetching}
          />
        ) : null}
        {list.isLoading ? (
          <Loading />
        ) : list.isError && !list.data ? (
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <Empty title="Sin resultados" />
        ) : (
          <div className="table-wrap fit-scroll" style={{ maxHeight: '70vh' }}>
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
      {kind === 'receive' ? (
        <p className="muted small" style={{ margin: 0 }}>
          ¿Tiene fecha de vencimiento?{' '}
          <Link to="/inventario?tab=lotes" onClick={onClose}>
            Regístralo como lote
          </Link>{' '}
          para que el Resumen te avise antes de que venza.
        </p>
      ) : null}
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

// ───────────── Lotes y vencimientos ─────────────

function Lots() {
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [days, setDays] = useState<number>(30);

  const lots = useQuery({
    queryKey: ['admin', 'lots', includeEmpty],
    queryFn: () =>
      api<StockLotDTO[]>('/v1/admin/inventory/lots', {
        query: { includeEmpty: includeEmpty ? 1 : 0, limit: LOTS_LIMIT },
      }),
  });
  const expiring = useQuery({
    queryKey: ['admin', 'expiring', days],
    queryFn: () => api<StockLotDTO[]>('/v1/admin/inventory/expiring', { query: { days } }),
  });

  return (
    <>
      <div className="grid cols-2" style={{ marginBottom: 14, alignItems: 'start' }}>
        <ReceiveLotForm />
        <Card
          title="Por vencer"
          actions={
            <select
              className="input"
              style={{ width: 'auto' }}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              aria-label="Días por delante"
              data-testid="expiring-days"
            >
              {EXPIRING_WINDOWS.map((d) => (
                <option key={d} value={d}>
                  {d} días
                </option>
              ))}
            </select>
          }
        >
          <p className="muted small" style={{ margin: '0 0 10px' }}>
            Lotes con existencias que vencen en los próximos {days} días, y los que ya vencieron:
            esos hay que sacarlos del congelador.
          </p>
          {expiring.isError && expiring.data ? (
            <StaleNote
              error={expiring.error}
              onRetry={() => void expiring.refetch()}
              busy={expiring.isFetching}
            />
          ) : null}
          {expiring.isLoading ? (
            <Loading />
          ) : expiring.isError && !expiring.data ? (
            <ErrorBox error={expiring.error} onRetry={() => void expiring.refetch()} />
          ) : (expiring.data ?? []).length === 0 ? (
            <div className="muted">Nada vence en los próximos {days} días.</div>
          ) : (
            <ul className="expiring-list">
              {expiring.data!.map((l) => (
                <li key={l.id} className="expiring-item" data-testid={`expiring-row-${l.lotCode}`}>
                  <div>
                    <strong>{l.productName}</strong>
                    {l.variantLabel ? <span className="muted"> · {l.variantLabel}</span> : null}
                    <div className="muted small">
                      Lote {l.lotCode} · quedan {qtyLabel(l.pricingUnit, l.qtyRemaining)}
                    </div>
                  </div>
                  <div className="expiring-when">
                    <Badge tone={LOT_STATUS[l.status].tone}>{LOT_STATUS[l.status].label}</Badge>
                    <span className="muted small">{daysLeftText(l.daysLeft)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="Lotes"
        actions={
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={includeEmpty}
              onChange={(e) => setIncludeEmpty(e.target.checked)}
              data-testid="lot-include-empty"
            />
            Incluir lotes agotados
          </label>
        }
      >
        <p className="muted small" style={{ margin: '0 0 10px' }}>
          Los lotes no bloquean la venta: lo vendible sigue siendo lo que hay menos lo reservado. Al
          empacar un pedido se descuenta primero el lote que vence antes.
        </p>
        {lots.isError && lots.data ? (
          <StaleNote
            error={lots.error}
            onRetry={() => void lots.refetch()}
            busy={lots.isFetching}
          />
        ) : null}
        {lots.isLoading ? (
          <Loading />
        ) : lots.isError && !lots.data ? (
          <ErrorBox error={lots.error} onRetry={() => void lots.refetch()} />
        ) : (lots.data ?? []).length === 0 ? (
          <Empty
            title={includeEmpty ? 'Todavía no hay lotes' : 'Ningún lote con existencias'}
            text="Recibe un lote con el formulario de arriba para llevar su vencimiento."
          />
        ) : (
          <div className="table-wrap fit-scroll" style={{ maxHeight: '60vh' }}>
            <table className="lot-table">
              <thead>
                <tr>
                  <th>Lote</th>
                  <th>Artículo</th>
                  <th>Vence</th>
                  <th>Estado</th>
                  <th className="right">Recibido</th>
                  <th className="right">Quedan</th>
                </tr>
              </thead>
              <tbody>
                {lots.data!.map((l) => (
                  <tr key={l.id} className={`lot-${l.status}`} data-testid={`lot-row-${l.lotCode}`}>
                    <td>
                      <strong>{l.lotCode}</strong>
                      <div className="muted small">Recibido {dateTime(l.receivedAt)}</div>
                      {l.note ? <div className="muted small">{l.note}</div> : null}
                    </td>
                    <td>
                      {l.productName}
                      {l.variantLabel ? <span className="muted"> · {l.variantLabel}</span> : null}
                      <div className="muted small">{l.sku}</div>
                    </td>
                    <td className="nowrap">
                      {expiryDateLabel(l.expiresOn)}
                      <div className="muted small">{daysLeftText(l.daysLeft)}</div>
                    </td>
                    <td>
                      <span data-testid={`lot-status-${l.lotCode}`} data-status={l.status}>
                        <Badge tone={LOT_STATUS[l.status].tone}>{LOT_STATUS[l.status].label}</Badge>
                      </span>
                    </td>
                    <td className="right nowrap muted">{qtyLabel(l.pricingUnit, l.qtyReceived)}</td>
                    <td className="right nowrap">
                      {l.qtyRemaining > 0 ? (
                        qtyLabel(l.pricingUnit, l.qtyRemaining)
                      ) : (
                        <Badge tone="neutral">Agotado</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {lotsLimitNote((lots.data ?? []).length) ? (
          <p className="muted small" style={{ margin: '10px 0 0' }} data-testid="lots-limit-note">
            {lotsLimitNote((lots.data ?? []).length)}
          </p>
        ) : null}
      </Card>
    </>
  );
}

const blankLot = { query: '', lotCode: '', expiresOn: '', quantity: '', cost: '', note: '' };

function ReceiveLotForm() {
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState(blankLot);
  const [picked, setPicked] = useState<AdminVariantDTO | null>(null);

  const catalog = useQuery({
    queryKey: ['admin', 'catalog'],
    queryFn: () => api<AdminVariantDTO[]>('/v1/admin/catalog'),
  });
  const search = useMemo(
    () => (picked ? { shown: [], total: 0 } : searchVariants(catalog.data ?? [], f.query)),
    [catalog.data, f.query, picked],
  );
  const results = search.shown;

  const isLb = picked?.pricingUnit === 'lb';
  const { body, errors } = checkLotForm(
    {
      variantId: picked?.id ?? null,
      pricingUnit: picked?.pricingUnit ?? null,
      lotCode: f.lotCode,
      expiresOn: f.expiresOn,
      quantity: f.quantity,
      cost: f.cost,
      note: f.note,
    },
    todayInRD(),
  );
  // Un campo vacío no se marca en rojo: el botón ya espera a que esté completo.
  const err = (k: keyof typeof errors, text: string) => (text.trim() ? errors[k] : undefined);

  const reset = () => {
    setF(blankLot);
    setPicked(null);
  };
  const set = (k: keyof typeof blankLot) => (e: { target: { value: string } }) =>
    setF((s) => ({ ...s, [k]: e.target.value }));

  const receive = useMutation({
    mutationFn: (b: ReceiveLotInput) =>
      api<StockLotDTO>('/v1/admin/inventory/lots', { method: 'POST', body: b }),
    onSuccess: (lot) => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
      notify(`Lote ${lot.lotCode} recibido`);
      reset();
    },
    onError: fail,
  });

  const pick = (v: AdminVariantDTO) => {
    setPicked(v);
    setF((s) => ({ ...s, query: `${v.productName}${v.variant ? ` · ${v.variant}` : ''}` }));
  };

  return (
    <Card
      title="Recibir un lote"
      actions={
        <Button
          small
          variant="secondary"
          onClick={() => {
            reset();
            searchRef.current?.focus();
          }}
          data-testid="lot-new"
        >
          <Plus size={14} /> Nuevo lote
        </Button>
      }
    >
      <form
        className="lot-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (body) receive.mutate(body);
        }}
      >
        <div className="lot-wide">
          <Field label="Artículo" error={catalog.data ? err('variant', f.query) : undefined}>
            <input
              ref={searchRef}
              className="input"
              value={f.query}
              placeholder="Busca por nombre o SKU…"
              autoComplete="off"
              onChange={(e) => {
                set('query')(e);
                setPicked(null);
              }}
              data-testid="lot-variant-search"
            />
            {results.length > 0 ? (
              <ul className="lot-results">
                {results.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      className="lot-pick"
                      onClick={() => pick(v)}
                      data-testid={`lot-variant-${v.sku}`}
                    >
                      <span>
                        <strong>{v.productName}</strong>
                        {v.variant ? <span className="muted"> · {v.variant}</span> : null}
                      </span>
                      <span className="muted small">
                        {v.sku} · {v.pricingUnit === 'lb' ? 'por libra' : 'por unidad'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {results.length > 0 && search.total > results.length ? (
              <span className="muted small" data-testid="lot-variant-truncated">
                {truncatedMatchText(results.length, search.total)}
              </span>
            ) : null}
            {catalog.isError && !catalog.data ? (
              <div className="row wrap small" data-testid="lot-catalog-error">
                <span className="err">
                  No pudimos cargar los artículos ({errorText(catalog.error)}) Sin ellos no se puede
                  buscar.
                </span>
                <Button
                  small
                  variant="secondary"
                  busy={catalog.isFetching}
                  onClick={() => void catalog.refetch()}
                >
                  Reintentar
                </Button>
              </div>
            ) : catalog.isLoading && f.query.trim() ? (
              <span className="muted small">Cargando artículos…</span>
            ) : results.length === 0 && f.query.trim() && !picked && catalog.data ? (
              <span className="muted small">Ningún artículo coincide.</span>
            ) : picked ? (
              <span className="muted small">
                {picked.sku} · {isLb ? 'se mide en libras' : 'se cuenta por unidades'} · ahora hay{' '}
                {qtyLabel(picked.pricingUnit, picked.onHand)}
              </span>
            ) : null}
          </Field>
        </div>
        <Field label="Código del lote" error={err('lotCode', f.lotCode)}>
          <input
            className="input"
            value={f.lotCode}
            maxLength={LOT_CODE_MAX}
            onChange={set('lotCode')}
            placeholder="Ej: L-2410-A"
            data-testid="lot-code"
          />
        </Field>
        <Field label="Fecha de vencimiento" error={err('expiresOn', f.expiresOn)}>
          <input
            type="date"
            className="input"
            value={f.expiresOn}
            onChange={set('expiresOn')}
            data-testid="lot-expires"
          />
        </Field>
        <Field
          label={`Cantidad recibida${picked ? ` (${isLb ? 'libras' : 'unidades'})` : ''}`}
          error={err('quantity', f.quantity)}
          hint={isLb ? 'Puedes usar decimales: 25 o 12.5' : undefined}
        >
          <input
            className="input"
            inputMode="decimal"
            value={f.quantity}
            onChange={set('quantity')}
            data-testid="lot-qty"
          />
        </Field>
        <Field
          label={picked ? `Costo por ${isLb ? 'libra' : 'unidad'} (RD$)` : 'Costo (RD$)'}
          error={err('cost', f.cost)}
          hint="Opcional"
        >
          <input
            className="input"
            inputMode="decimal"
            value={f.cost}
            onChange={set('cost')}
            data-testid="lot-cost"
          />
        </Field>
        <div className="lot-wide">
          <Field label="Nota (opcional)" error={err('note', f.note)}>
            <input
              className="input"
              value={f.note}
              maxLength={LOT_NOTE_MAX}
              onChange={set('note')}
              placeholder="Ej: proveedor, factura o número de entrega"
              data-testid="lot-note"
            />
          </Field>
        </div>
        <div className="lot-wide row" style={{ justifyContent: 'flex-end' }}>
          <Button type="submit" busy={receive.isPending} disabled={!body} data-testid="lot-submit">
            Recibir lote
          </Button>
        </div>
      </form>
    </Card>
  );
}
