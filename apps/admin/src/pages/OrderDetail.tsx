import { type CouponDTO, type OrderDTO, type PaymentSummaryDTO, es } from '@jellyfish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Phone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHead,
  StaleNote,
  useToast,
} from '../components/ui';
import { api, errorText } from '../lib/api';
import {
  PIN_OVERRIDE_MAX_CHARS,
  canOfferPinOverride,
  checkOverrideReason,
  overrideCounterText,
  pinAttemptsText,
  pinRequiredText,
  pinVerifiedText,
} from '../lib/delivery';
import {
  MONEY_ERROR,
  centavosToPesos,
  dateTime,
  formatDOP,
  lbToCentilb,
  pesosToCentavos,
  qtyLabel,
  slot,
  statusLabel,
  whatsappLink,
} from '../lib/format';
import { type CouponTerms, previewOrderTotals, settledDiscount } from '../lib/orderTotals';
import './panel-extra.css';

const tone = (s: OrderDTO['status']) =>
  s === 'delivered'
    ? 'success'
    : s === 'cancelled' || s === 'delivery_failed' || s === 'refunded'
      ? 'danger'
      : s === 'pending_payment'
        ? 'warning'
        : 'info';

type Dialog =
  | { kind: 'cancel' }
  | { kind: 'paid'; payment: PaymentSummaryDTO }
  | { kind: 'refund'; payment: PaymentSummaryDTO }
  | { kind: 'cash'; due: number }
  | { kind: 'override' };

export function OrderDetail() {
  const { id = '' } = useParams();
  const { isAdmin, user } = useAuth();
  const qc = useQueryClient();
  const { notify, fail } = useToast();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [driverId, setDriverId] = useState('');

  const q = useQuery({
    queryKey: ['admin', 'order', id],
    queryFn: () => api<OrderDTO>(`/v1/admin/orders/${id}`),
    refetchInterval: 10_000,
  });
  const drivers = useQuery({
    queryKey: ['admin', 'drivers'],
    queryFn: () => api<{ id: string; name: string; phone: string }[]>('/v1/admin/drivers'),
  });

  const refresh = (order: OrderDTO) => {
    qc.setQueryData(['admin', 'order', id], order);
    void qc.invalidateQueries({ queryKey: ['admin', 'orders'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'summary'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'payments'] });
  };

  const transition = useMutation({
    mutationFn: (v: { to: string; note?: string }) =>
      api<OrderDTO>(`/v1/admin/orders/${id}/transition`, { method: 'POST', body: v }),
    onSuccess: (o, v) => {
      refresh(o);
      notify(`Pedido → ${statusLabel(v.to as OrderDTO['status'])}`);
      setDialog(null);
    },
    onError: fail,
  });
  const assign = useMutation({
    mutationFn: (driver: string) =>
      api<OrderDTO>(`/v1/admin/orders/${id}/assign-driver`, {
        method: 'POST',
        body: { driverId: driver },
      }),
    onSuccess: (o) => {
      refresh(o);
      notify('Repartidor asignado');
    },
    onError: fail,
  });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  const driver = drivers.data?.find((d) => d.id === o.driverId);
  const pendingCash = o.payments.find((p) => p.method === 'cash' && p.status === 'pending');
  const dueNow = o.finalTotal ?? o.total;
  const busy = transition.isPending || assign.isPending;
  const askPin = canOfferPinOverride(o, user.role);

  return (
    <>
      <PageHead
        title={`Pedido ${o.code}`}
        subtitle={`${slot(o.slotStart, o.slotEnd)} · creado ${dateTime(o.createdAt)}`}
        actions={
          <>
            <Badge tone={tone(o.status)}>{statusLabel(o.status)}</Badge>
            <Link to="/pedidos">← Tablero</Link>
          </>
        }
      />

      {q.isError ? (
        <StaleNote error={q.error} onRetry={() => void q.refetch()} busy={q.isFetching} />
      ) : null}

      <div className="grid cols-2">
        <div className="stack">
          <Items
            order={o}
            editable={o.status === 'confirmed' || o.status === 'picking'}
            onSaved={refresh}
          />
          <Timeline order={o} />
        </div>

        <div className="stack">
          <Card title="Qué hacer ahora">
            <div className="stack" style={{ gap: 10 }}>
              {o.status === 'pending_payment' ? (
                <div className="muted">
                  Esperando el pago. Si el cliente ya pagó y no se refleja, confírmalo en “Pago”.
                </div>
              ) : null}
              {o.status === 'confirmed' ? (
                <Button
                  busy={busy}
                  onClick={() => transition.mutate({ to: 'picking' })}
                  data-testid="act-picking"
                >
                  Empezar a preparar
                </Button>
              ) : null}
              {o.status === 'picking' ? (
                <>
                  <div className="muted small">
                    Registra el peso real de cada corte (abajo) y luego empaca.
                  </div>
                  <Button
                    busy={busy}
                    onClick={() => transition.mutate({ to: 'packed' })}
                    data-testid="act-packed"
                  >
                    Marcar empacado
                  </Button>
                </>
              ) : null}
              {o.status === 'packed' || o.status === 'delivery_failed' ? (
                <>
                  <Field label="Repartidor">
                    <div className="row">
                      <select
                        className="input"
                        value={driverId || o.driverId || ''}
                        onChange={(e) => setDriverId(e.target.value)}
                        data-testid="driver-select"
                      >
                        <option value="">Elegir…</option>
                        {(drivers.data ?? []).map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name || d.phone}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="secondary"
                        busy={assign.isPending}
                        disabled={!(driverId || o.driverId)}
                        onClick={() => assign.mutate(driverId || o.driverId!)}
                        data-testid="act-assign"
                      >
                        Asignar
                      </Button>
                    </div>
                    {(drivers.data ?? []).length === 0 ? (
                      <span className="muted small">
                        No hay repartidores. Agrégalos en “Equipo”.
                      </span>
                    ) : null}
                  </Field>
                  <Button
                    busy={busy}
                    disabled={!o.driverId}
                    onClick={() => transition.mutate({ to: 'out_for_delivery' })}
                    data-testid="act-out"
                  >
                    {o.status === 'delivery_failed' ? 'Reintentar envío' : 'Enviar pedido'}
                  </Button>
                </>
              ) : null}
              {o.status === 'out_for_delivery' ? (
                <>
                  {pendingCash ? (
                    <Button
                      variant="secondary"
                      onClick={() => setDialog({ kind: 'cash', due: dueNow })}
                      data-testid="act-cash"
                    >
                      Registrar cobro en efectivo ({formatDOP(dueNow)})
                    </Button>
                  ) : null}
                  {askPin ? (
                    <>
                      <div className="muted small">
                        Este pedido exige el PIN del cliente: el repartidor lo confirma desde su
                        app. Si no se puede, entrégalo sin PIN dejando el motivo.
                      </div>
                      <Button
                        busy={busy}
                        onClick={() => setDialog({ kind: 'override' })}
                        data-testid="deliver-override"
                      >
                        Entregar sin PIN
                      </Button>
                    </>
                  ) : (
                    <Button
                      busy={busy}
                      onClick={() => transition.mutate({ to: 'delivered' })}
                      data-testid="act-delivered"
                    >
                      Marcar entregado
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    busy={busy}
                    onClick={() =>
                      transition.mutate({ to: 'delivery_failed', note: 'No se pudo entregar' })
                    }
                  >
                    No se pudo entregar
                  </Button>
                </>
              ) : null}
              {o.status === 'delivered' || o.status === 'cancelled' || o.status === 'refunded' ? (
                <div className="muted">Este pedido está cerrado.</div>
              ) : null}
              {['pending_payment', 'confirmed', 'picking', 'packed', 'delivery_failed'].includes(
                o.status,
              ) ? (
                <Button
                  variant="danger"
                  small
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => setDialog({ kind: 'cancel' })}
                  data-testid="act-cancel"
                >
                  Cancelar pedido
                </Button>
              ) : null}
            </div>
          </Card>

          <Card title="Cliente y entrega">
            <div className="stack" style={{ gap: 6 }}>
              <strong>{o.customer.name || 'Sin nombre'}</strong>
              <div className="row">
                <a href={`tel:${o.customer.phone}`} className="row">
                  <Phone size={15} /> {o.customer.phone}
                </a>
                <a
                  href={whatsappLink(o.customer.phone)}
                  target="_blank"
                  rel="noreferrer"
                  className="row"
                >
                  <MessageCircle size={15} /> WhatsApp
                </a>
              </div>
              <div>
                {o.address.line1}, {o.address.sector}, {o.address.city}
              </div>
              {o.address.reference ? (
                <div className="muted">Referencia: {o.address.reference}</div>
              ) : null}
              <div className="muted small">
                Si falta algo:{' '}
                {o.substitutionPolicy === 'contact'
                  ? 'avisar al cliente'
                  : o.substitutionPolicy === 'substitute'
                    ? 'sustituir'
                    : 'devolver el dinero'}
              </div>
              {o.notes ? <div className="banner warn">Nota del cliente: {o.notes}</div> : null}
              {driver ? (
                <div className="muted small">Repartidor: {driver.name || driver.phone}</div>
              ) : null}
            </div>
          </Card>

          <Card title="Entrega">
            <div className="stack" style={{ gap: 10 }} data-testid="pin-card">
              <dl className="kv">
                <dt>Exige PIN del cliente</dt>
                <dd data-testid="pin-required">{pinRequiredText(o.pinRequired)}</dd>
                <dt>Intentos restantes</dt>
                <dd data-testid="pin-attempts">
                  {o.pinAttemptsLeft !== null && o.pinAttemptsLeft <= 0 ? (
                    <Badge tone="danger">{pinAttemptsText(o.pinAttemptsLeft)}</Badge>
                  ) : (
                    pinAttemptsText(o.pinAttemptsLeft)
                  )}
                </dd>
                <dt>PIN verificado</dt>
                <dd data-testid="pin-verified">{pinVerifiedText(o)}</dd>
                {o.pinOverrideReason ? (
                  <>
                    <dt>Entregado sin PIN</dt>
                    <dd data-testid="pin-override-reason-shown">{o.pinOverrideReason}</dd>
                  </>
                ) : null}
              </dl>
              {o.pinAttemptsLeft !== null &&
              o.pinAttemptsLeft <= 0 &&
              o.status === 'out_for_delivery' ? (
                <div className="banner warn">
                  El repartidor agotó los intentos con el PIN. Confirma la entrega tú con “Entregar
                  sin PIN”.
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Pago">
            <div className="stack" style={{ gap: 10 }}>
              {o.payments.map((p) => (
                <div
                  key={p.id}
                  className="stack"
                  style={{ gap: 6 }}
                  data-testid={`payment-${p.method}`}
                >
                  <div className="row between">
                    <strong>{es.paymentMethodLabel[p.method]}</strong>
                    <Badge
                      tone={
                        p.status === 'captured'
                          ? 'success'
                          : p.status === 'failed' || p.status === 'voided'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {p.status}
                    </Badge>
                  </div>
                  <div className="muted small">
                    Monto {formatDOP(p.amount)} · cobrado {formatDOP(p.capturedAmount)}
                    {p.refundedAmount > 0 ? ` · devuelto ${formatDOP(p.refundedAmount)}` : ''}
                    {p.proofSubmitted ? ' · comprobante enviado' : ''}
                    {p.failureReason ? ` · ${p.failureReason}` : ''}
                  </div>
                  {p.refundPending > 0 ? (
                    <div className="banner warn">
                      Hay que devolver {formatDOP(p.refundPending)} al cliente.{' '}
                      {isAdmin ? (
                        <Button
                          small
                          variant="secondary"
                          onClick={() => setDialog({ kind: 'refund', payment: p })}
                          data-testid="act-refund"
                        >
                          Registrar devolución
                        </Button>
                      ) : (
                        'Pídele al administrador que la registre.'
                      )}
                    </div>
                  ) : null}
                  {p.status === 'pending' && p.method !== 'cash' ? (
                    <Button
                      small
                      variant="secondary"
                      onClick={() => setDialog({ kind: 'paid', payment: p })}
                      data-testid="act-markpaid"
                    >
                      Confirmar que el pago llegó
                    </Button>
                  ) : null}
                </div>
              ))}
              {o.payments.length === 0 ? (
                <div className="muted">El cliente aún no inicia el pago.</div>
              ) : null}
            </div>
          </Card>
        </div>
      </div>

      {dialog?.kind === 'cancel' ? (
        <ReasonDialog
          title={`Cancelar ${o.code}`}
          label="Motivo"
          confirm="Cancelar pedido"
          busy={transition.isPending}
          onClose={() => setDialog(null)}
          onSubmit={(note) => transition.mutate({ to: 'cancelled', note })}
        />
      ) : null}
      {dialog?.kind === 'paid' ? (
        <ReasonDialog
          title="Confirmar pago recibido"
          label="Referencia (banco, autorización o RRN)"
          confirm="Confirmar pago"
          onClose={() => setDialog(null)}
          action={(reference) =>
            api<OrderDTO>(`/v1/admin/payments/${dialog.payment.id}/mark-paid`, {
              method: 'POST',
              body: { reference },
            }).then((r) => {
              refresh(r);
              notify('Pago confirmado y pedido confirmado');
            })
          }
        />
      ) : null}
      {dialog?.kind === 'refund' ? (
        <RefundDialog
          payment={dialog.payment}
          onClose={() => setDialog(null)}
          onDone={() => {
            void q.refetch();
            void qc.invalidateQueries({ queryKey: ['admin'] });
            notify('Devolución registrada');
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === 'override' ? (
        <OverrideDialog
          orderId={o.id}
          code={o.code}
          onClose={() => setDialog(null)}
          onDone={(r) => {
            refresh(r);
            notify('Pedido entregado sin PIN');
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === 'cash' ? (
        <CashDialog
          due={dialog.due}
          orderId={o.id}
          onClose={() => setDialog(null)}
          onDone={(r) => {
            refresh(r);
            notify('Cobro registrado');
            setDialog(null);
          }}
        />
      ) : null}
    </>
  );
}

// ───────────── Artículos y pesaje ─────────────

function Items({
  order,
  editable,
  onSaved,
}: {
  order: OrderDTO;
  editable: boolean;
  onSaved: (o: OrderDTO) => void;
}) {
  const { notify, fail } = useToast();
  const weighable = order.items.filter((i) => i.pricingUnit === 'lb' && i.variableWeight);
  const [text, setText] = useState<Record<string, string>>({});

  useEffect(() => {
    setText(
      Object.fromEntries(
        weighable.map((i) => [i.id, ((i.finalQuantity ?? i.quantity) / 100).toString()]),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id, order.items.map((i) => i.finalQuantity).join(',')]);

  const save = useMutation({
    mutationFn: () => {
      const weights = weighable.map((i) => ({
        itemId: i.id,
        finalQuantity: lbToCentilb(text[i.id] ?? ''),
      }));
      if (weights.some((w) => !w.finalQuantity))
        throw new Error('Revisa los pesos: usa números como 2.5 (máximo 2 decimales).');
      return api<OrderDTO>(`/v1/admin/orders/${order.id}/weights`, {
        method: 'POST',
        body: { weights: weights as { itemId: string; finalQuantity: number }[] },
      });
    },
    onSuccess: (o) => {
      onSaved(o);
      notify('Pesos guardados');
    },
    onError: fail,
  });

  // El descuento de un cupón porcentual se recalcula con el peso real: hacen falta sus términos.
  const needsTerms = editable && !!order.couponCode && order.discount > 0;
  const coupons = useQuery({
    queryKey: ['admin', 'coupons'],
    queryFn: () => api<CouponDTO[]>('/v1/admin/coupons'),
    enabled: needsTerms,
  });
  const terms: CouponTerms | null | undefined = !needsTerms
    ? null
    : coupons.data
      ? (coupons.data.find((c) => c.code === order.couponCode) ?? null)
      : undefined;

  // Cantidad que se cobraría: lo escrito (si es válido) mientras se pesa; si no, lo guardado o lo pedido.
  const parsed = (i: OrderDTO['items'][number]) =>
    editable && i.pricingUnit === 'lb' && i.variableWeight ? lbToCentilb(text[i.id] ?? '') : null;
  const quantities = order.items.map((i) => ({
    ...i,
    quantity: parsed(i) || (i.finalQuantity ?? i.quantity),
  }));
  const weighing = editable && order.finalTotal === null;
  const preview = previewOrderTotals(
    order,
    quantities,
    // Fuera del pesaje el descuento no se recalcula: se muestra el que ya tiene el pedido.
    weighing ? terms : null,
  );
  const settled = order.finalTotal !== null;
  const discount = settled
    ? settledDiscount(order, preview.gross, order.finalTotal!)
    : weighing
      ? preview.discount
      : order.discount;
  const total = settled ? order.finalTotal! : weighing ? preview.total : order.total;
  const estimated = weighing && !preview.exact;
  const badWeights = weighing && weighable.some((i) => !lbToCentilb(text[i.id] ?? ''));
  const unsaved = weighing && weighable.some((i) => parsed(i) !== (i.finalQuantity ?? i.quantity));

  return (
    <Card
      title="Artículos"
      actions={
        editable && weighable.length > 0 ? (
          <Button
            small
            busy={save.isPending}
            onClick={() => save.mutate()}
            data-testid="save-weights"
          >
            Guardar pesos
          </Button>
        ) : undefined
      }
    >
      <div className="table-wrap">
        <table className="order-lines">
          <thead>
            <tr>
              <th>Producto</th>
              <th className="right">Pedido</th>
              <th className="right">Peso real</th>
              <th className="right">Importe</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((i) => {
              const canWeigh = editable && i.pricingUnit === 'lb' && i.variableWeight;
              return (
                <tr key={i.id}>
                  <td>
                    {i.name}
                    {i.variant ? <span className="muted"> · {i.variant}</span> : null}
                    <div className="muted small">{i.sku}</div>
                  </td>
                  <td className="right nowrap">{qtyLabel(i.pricingUnit, i.quantity)}</td>
                  <td className="right">
                    {canWeigh ? (
                      <span className="row" style={{ justifyContent: 'flex-end' }}>
                        <input
                          className={`input num ${lbToCentilb(text[i.id] ?? '') ? '' : 'invalid'}`}
                          inputMode="decimal"
                          value={text[i.id] ?? ''}
                          onChange={(e) => setText((t) => ({ ...t, [i.id]: e.target.value }))}
                          data-testid={`weight-${i.sku}`}
                          aria-label={`Peso real de ${i.name} en libras`}
                        />
                        <span className="muted">lb</span>
                      </span>
                    ) : i.finalQuantity !== null ? (
                      qtyLabel(i.pricingUnit, i.finalQuantity)
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="right nowrap">{formatDOP(preview.lineGross[i.id] ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <dl className="order-totals">
        <div>
          <dt className="muted">Subtotal</dt>
          <dd data-testid="order-subtotal">{formatDOP(preview.gross)}</dd>
        </div>
        {order.couponCode ? (
          <div>
            <dt className="muted">
              Cupón <strong data-testid="order-coupon">{order.couponCode}</strong>
              {estimated ? ' (estimado)' : ''}
            </dt>
            <dd data-testid="order-discount">
              {discount > 0 ? `− ${formatDOP(discount)}` : 'Envío gratis'}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="muted">Envío</dt>
          <dd>{formatDOP(order.deliveryFee)}</dd>
        </div>
        <div className="order-total-row">
          <dt>{settled ? 'Total final' : estimated ? 'Total estimado' : 'Total'}</dt>
          <dd data-testid="order-total">{formatDOP(total)}</dd>
        </div>
        {order.finalTotal === null ? (
          <div className="muted small">
            <dt>Estimado al pedir</dt>
            <dd>
              {formatDOP(order.total)} · máximo autorizado {formatDOP(order.authorizedAmount)}
            </dd>
          </div>
        ) : null}
      </dl>
      {estimated ? (
        <p className="muted small" style={{ margin: '10px 0 0' }} data-testid="order-estimated">
          No pudimos leer las condiciones del cupón. Un cupón en porcentaje se recalcula con el peso
          real al empacar, así que el total final puede ser un poco distinto.
        </p>
      ) : weighing && order.couponCode && order.discount > 0 && terms?.kind === 'percent' ? (
        <p className="muted small" style={{ margin: '10px 0 0' }}>
          El descuento del cupón se recalcula con el peso real.
        </p>
      ) : null}
      {badWeights ? (
        <p
          className="small warn-text"
          style={{ margin: '10px 0 0' }}
          data-testid="order-bad-weights"
        >
          Hay pesos por corregir: el total no los incluye.
        </p>
      ) : unsaved ? (
        <p className="muted small" style={{ margin: '10px 0 0' }} data-testid="order-unsaved">
          Este total usa los pesos escritos. Toca “Guardar pesos” antes de empacar: se cobra con los
          pesos guardados.
        </p>
      ) : null}
    </Card>
  );
}

function Timeline({ order }: { order: OrderDTO }) {
  return (
    <Card title="Historial">
      <ul className="timeline">
        {[...order.timeline].reverse().map((e) => (
          <li key={e.id}>
            <span>
              {statusLabel(e.toStatus)}
              {e.note ? <span className="muted"> — {e.note}</span> : null}
            </span>
            <span className="muted small nowrap">{dateTime(e.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ───────────── Diálogos ─────────────

function ReasonDialog({
  title,
  label,
  confirm,
  onClose,
  onSubmit,
  action,
  busy,
}: {
  title: string;
  label: string;
  confirm: string;
  onClose: () => void;
  onSubmit?: (text: string) => void;
  action?: (text: string) => Promise<unknown>;
  busy?: boolean;
}) {
  const [text, setText] = useState('');
  const [working, setWorking] = useState(false);
  const { fail } = useToast();
  const go = async () => {
    if (action) {
      setWorking(true);
      try {
        await action(text.trim());
        onClose();
      } catch (e) {
        fail(e);
      } finally {
        setWorking(false);
      }
    } else onSubmit?.(text.trim());
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      busy={busy || working}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Volver
          </Button>
          <Button
            busy={busy || working}
            disabled={text.trim().length < 3}
            onClick={go}
            data-testid="dialog-confirm"
          >
            {confirm}
          </Button>
        </>
      }
    >
      <Field label={label}>
        <input
          className="input"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="dialog-text"
          onKeyDown={(e) => e.key === 'Enter' && text.trim().length >= 3 && void go()}
        />
      </Field>
    </Modal>
  );
}

function RefundDialog({
  payment,
  onClose,
  onDone,
}: {
  payment: PaymentSummaryDTO;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(centavosToPesos(payment.refundPending));
  const [reference, setReference] = useState('');
  const { fail } = useToast();
  const cents = pesosToCentavos(amount);
  const m = useMutation({
    mutationFn: () =>
      api(`/v1/admin/payments/${payment.id}/mark-refunded`, {
        method: 'POST',
        body: { amount: cents, reference },
      }),
    onSuccess: onDone,
    onError: fail,
  });
  const invalid = !cents || cents > payment.refundPending || reference.trim().length < 3;
  return (
    <Modal
      title="Registrar devolución"
      onClose={onClose}
      busy={m.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Volver
          </Button>
          <Button
            busy={m.isPending}
            disabled={invalid}
            onClick={() => m.mutate()}
            data-testid="dialog-confirm"
          >
            Registrar
          </Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        Haz primero la devolución en el portal de AZUL (o por transferencia) y anótala aquí.
        Pendiente: {formatDOP(payment.refundPending)}.
      </p>
      <Field
        label="Monto devuelto (RD$)"
        error={
          cents === null
            ? MONEY_ERROR
            : cents > payment.refundPending
              ? 'Es más de lo pendiente'
              : null
        }
      >
        <input
          className="input"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
        />
      </Field>
      <Field label="Referencia de la devolución">
        <input
          className="input"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          data-testid="dialog-text"
        />
      </Field>
    </Modal>
  );
}

function CashDialog({
  due,
  orderId,
  onClose,
  onDone,
}: {
  due: number;
  orderId: string;
  onClose: () => void;
  onDone: (o: OrderDTO) => void;
}) {
  const [amount, setAmount] = useState(centavosToPesos(due));
  const { fail } = useToast();
  const cents = pesosToCentavos(amount);
  const m = useMutation({
    mutationFn: () =>
      api<OrderDTO>(`/v1/admin/orders/${orderId}/collect-cash`, {
        method: 'POST',
        body: { amount: cents },
      }),
    onSuccess: onDone,
    onError: fail,
  });
  return (
    <Modal
      title="Registrar cobro en efectivo"
      onClose={onClose}
      busy={m.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Volver
          </Button>
          <Button
            busy={m.isPending}
            disabled={!cents}
            onClick={() => m.mutate()}
            data-testid="dialog-confirm"
          >
            Registrar cobro
          </Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        Debe ser el monto exacto: {formatDOP(due)}.
      </p>
      <Field label="Monto cobrado (RD$)" error={cents === null ? MONEY_ERROR : null}>
        <input
          className="input"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          data-testid="dialog-text"
        />
      </Field>
    </Modal>
  );
}

function OverrideDialog({
  orderId,
  code,
  onClose,
  onDone,
}: {
  orderId: string;
  code: string;
  onClose: () => void;
  onDone: (o: OrderDTO) => void;
}) {
  const [text, setText] = useState('');
  const check = checkOverrideReason(text);
  const m = useMutation({
    mutationFn: () =>
      api<OrderDTO>(`/v1/admin/orders/${orderId}/transition`, {
        method: 'POST',
        body: { to: 'delivered', pinOverrideReason: check.reason },
      }),
    onSuccess: onDone,
  });
  return (
    <Modal
      title={`Entregar ${code} sin PIN`}
      onClose={onClose}
      busy={m.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Volver
          </Button>
          <Button
            busy={m.isPending}
            disabled={!check.valid}
            onClick={() => m.mutate()}
            data-testid="override-confirm"
          >
            Entregar sin PIN
          </Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        El cliente tiene un PIN de 4 dígitos para confirmar la entrega. Si lo entregas sin él, el
        motivo queda registrado en el historial del pedido.
      </p>
      <Field label="Motivo" error={m.isError ? errorText(m.error) : null}>
        <textarea
          className="input"
          rows={3}
          autoFocus
          maxLength={PIN_OVERRIDE_MAX_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ej: el cliente no estaba y la entrega la recibió su vecino"
          data-testid="override-reason"
        />
      </Field>
      <div
        className={`small ${check.valid ? 'muted' : 'override-short'}`}
        data-testid="override-count"
      >
        {overrideCounterText(text)}
      </div>
    </Modal>
  );
}
