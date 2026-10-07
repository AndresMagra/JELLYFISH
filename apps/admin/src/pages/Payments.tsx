import type { AdminPaymentDTO, CashRowDTO } from '@jellyfish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
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
import { centavosToPesos, dateTime, formatDOP, pesosToCentavos } from '../lib/format';

type Tab = 'refunds' | 'transfers' | 'cash' | 'all';

export function Payments() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('refunds');
  const tabs: [Tab, string][] = [
    ['refunds', 'Devoluciones'],
    ['transfers', 'Transferencias'],
    ['cash', 'Efectivo y caja'],
    ['all', 'Todos los pagos'],
  ];
  return (
    <>
      <PageHead
        title="Pagos y caja"
        subtitle="Dinero por devolver, transferencias por verificar y efectivo de los repartidores"
      />
      <div className="tabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={`tab ${tab === k ? 'active' : ''}`.trim()}
            onClick={() => setTab(k)}
            data-testid={`tab-${k}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'refunds' ? <Refunds isAdmin={isAdmin} /> : null}
      {tab === 'transfers' ? <Transfers /> : null}
      {tab === 'cash' ? <Cash isAdmin={isAdmin} /> : null}
      {tab === 'all' ? <AllPayments /> : null}
    </>
  );
}

const usePayments = (key: string, query: Record<string, string>) =>
  useQuery({
    queryKey: ['admin', 'payments', key],
    queryFn: () => api<AdminPaymentDTO[]>('/v1/admin/payments', { query }),
    refetchInterval: 15_000,
  });

function Refunds({ isAdmin }: { isAdmin: boolean }) {
  const q = usePayments('refunds', { refundPending: '1' });
  const [target, setTarget] = useState<AdminPaymentDTO | null>(null);
  const reasons: Record<string, string> = {
    order_not_active: 'Pagó cuando el pedido ya no estaba activo',
    duplicate_payment: 'Pago duplicado',
    amount_mismatch: 'El monto cobrado no coincide con el pedido',
    order_cancelled: 'Pedido cancelado',
  };
  return (
    <Card title="Dinero por devolver al cliente">
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <Empty
          title="No hay devoluciones pendientes"
          text="Cuando un pedido pagado se cancele o pese menos, la diferencia aparece aquí."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Motivo</th>
                <th>Método</th>
                <th className="right">Por devolver</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data!.map((p) => (
                <tr key={p.id} data-testid={`refund-${p.orderCode}`}>
                  <td>
                    <Link to={`/pedidos/${p.orderId}`}>{p.orderCode}</Link>
                  </td>
                  <td>
                    {p.failureReason
                      ? (reasons[p.failureReason] ?? p.failureReason)
                      : p.orderStatus === 'cancelled'
                        ? 'Pedido cancelado'
                        : 'Diferencia por peso real'}
                  </td>
                  <td>{p.method === 'card' ? 'Tarjeta' : 'Transferencia'}</td>
                  <td className="right">{formatDOP(p.refundPending)}</td>
                  <td className="right">
                    {isAdmin ? (
                      <Button
                        small
                        onClick={() => setTarget(p)}
                        data-testid={`do-refund-${p.orderCode}`}
                      >
                        Registrar devolución
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {target ? <RefundDialog p={target} onClose={() => setTarget(null)} /> : null}
    </Card>
  );
}

function RefundDialog({ p, onClose }: { p: AdminPaymentDTO; onClose: () => void }) {
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(centavosToPesos(p.refundPending));
  const [reference, setReference] = useState('');
  const cents = pesosToCentavos(amount);
  const m = useMutation({
    mutationFn: () =>
      api(`/v1/admin/payments/${p.id}/mark-refunded`, {
        method: 'POST',
        body: { amount: cents, reference },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
      notify('Devolución registrada');
      onClose();
    },
    onError: fail,
  });
  return (
    <Modal
      title={`Devolución · ${p.orderCode}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            busy={m.isPending}
            disabled={!cents || cents > p.refundPending || reference.trim().length < 3}
            onClick={() => m.mutate()}
            data-testid="dialog-confirm"
          >
            Registrar
          </Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        Primero haz la devolución en el portal de AZUL (o por transferencia) y luego anótala aquí.
        Pendiente: {formatDOP(p.refundPending)}.
      </p>
      <Field
        label="Monto devuelto (RD$)"
        error={cents && cents > p.refundPending ? 'Es más de lo pendiente' : null}
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

function Transfers() {
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const q = usePayments('transfers', { status: 'pending' });
  const rows = (q.data ?? []).filter((p) => p.method === 'transfer');
  const [target, setTarget] = useState<AdminPaymentDTO | null>(null);
  const [reference, setReference] = useState('');
  const m = useMutation({
    mutationFn: (p: AdminPaymentDTO) =>
      api(`/v1/admin/payments/${p.id}/mark-paid`, { method: 'POST', body: { reference } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
      notify('Transferencia confirmada: el pedido quedó confirmado');
      setTarget(null);
    },
    onError: fail,
  });
  return (
    <Card title="Transferencias por verificar">
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title="No hay transferencias pendientes" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Creado</th>
                <th className="right">Monto</th>
                <th>Comprobante</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} data-testid={`transfer-${p.orderCode}`}>
                  <td>
                    <Link to={`/pedidos/${p.orderId}`}>{p.orderCode}</Link>
                  </td>
                  <td className="muted">{dateTime(p.createdAt)}</td>
                  <td className="right">{formatDOP(p.amount)}</td>
                  <td>
                    {p.proofSubmitted ? (
                      <Badge tone="success">Enviado</Badge>
                    ) : (
                      <Badge tone="neutral">Sin enviar</Badge>
                    )}
                  </td>
                  <td className="right">
                    <Button
                      small
                      onClick={() => {
                        setTarget(p);
                        setReference('');
                      }}
                      data-testid={`confirm-transfer-${p.orderCode}`}
                    >
                      Confirmar pago
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {target ? (
        <Modal
          title={`Confirmar transferencia · ${target.orderCode}`}
          onClose={() => setTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setTarget(null)}>
                Cancelar
              </Button>
              <Button
                busy={m.isPending}
                disabled={reference.trim().length < 3}
                onClick={() => m.mutate(target)}
                data-testid="dialog-confirm"
              >
                Confirmar pago
              </Button>
            </>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            Verifica en tu banco que entraron {formatDOP(target.amount)} y escribe la referencia.
          </p>
          <Field label="Referencia del banco">
            <input
              className="input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              autoFocus
              data-testid="dialog-text"
            />
          </Field>
        </Modal>
      ) : null}
    </Card>
  );
}

function Cash({ isAdmin }: { isAdmin: boolean }) {
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'cash'],
    queryFn: () => api<CashRowDTO[]>('/v1/admin/cash'),
    enabled: isAdmin,
    refetchInterval: 15_000,
  });
  const [target, setTarget] = useState<CashRowDTO | null>(null);
  const [amount, setAmount] = useState('');
  const m = useMutation({
    mutationFn: (d: CashRowDTO) =>
      api('/v1/admin/cash/settle', {
        method: 'POST',
        body: {
          driverId: d.driverId,
          amount: pesosToCentavos(amount),
          note: 'Entrega de efectivo',
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
      notify('Entrega de efectivo registrada');
      setTarget(null);
    },
    onError: fail,
  });
  if (!isAdmin)
    return (
      <Card>
        <div className="muted">Solo el administrador ve el cuadre de caja.</div>
      </Card>
    );
  return (
    <Card title="Efectivo cobrado por repartidores">
      {q.isLoading ? (
        <Loading />
      ) : (q.data ?? []).length === 0 ? (
        <Empty title="No hay repartidores" text="Agrégalos en “Equipo”." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Repartidor</th>
                <th className="right">Entregas</th>
                <th className="right">Cobrado</th>
                <th className="right">Entregado al negocio</th>
                <th className="right">Debe entregar</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data!.map((d) => (
                <tr key={d.driverId} data-testid={`cash-${d.phone}`}>
                  <td>
                    <strong>{d.name || d.phone}</strong>
                    <div className="muted small">{d.phone}</div>
                  </td>
                  <td className="right">{d.deliveries}</td>
                  <td className="right">{formatDOP(d.collected)}</td>
                  <td className="right">{formatDOP(d.settled)}</td>
                  <td className="right">
                    <strong>{formatDOP(d.balance)}</strong>
                  </td>
                  <td className="right">
                    <Button
                      small
                      disabled={d.balance <= 0}
                      onClick={() => {
                        setTarget(d);
                        setAmount(centavosToPesos(d.balance));
                      }}
                      data-testid={`settle-${d.phone}`}
                    >
                      Registrar entrega
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {target ? (
        <Modal
          title={`Efectivo de ${target.name || target.phone}`}
          onClose={() => setTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setTarget(null)}>
                Cancelar
              </Button>
              <Button
                busy={m.isPending}
                disabled={
                  !pesosToCentavos(amount) || (pesosToCentavos(amount) ?? 0) > target.balance
                }
                onClick={() => m.mutate(target)}
                data-testid="dialog-confirm"
              >
                Registrar
              </Button>
            </>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            Debe entregar {formatDOP(target.balance)}. Registra lo que realmente te entregó.
          </p>
          <Field label="Monto recibido (RD$)">
            <input
              className="input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              data-testid="dialog-text"
            />
          </Field>
        </Modal>
      ) : null}
    </Card>
  );
}

function AllPayments() {
  const q = usePayments('all', {});
  return (
    <Card title="Últimos pagos">
      {q.isLoading ? (
        <Loading />
      ) : (q.data ?? []).length === 0 ? (
        <Empty title="Todavía no hay pagos" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Método</th>
                <th>Estado</th>
                <th className="right">Monto</th>
                <th className="right">Cobrado</th>
                <th className="right">Devuelto</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/pedidos/${p.orderId}`}>{p.orderCode}</Link>
                  </td>
                  <td>
                    {p.method === 'card'
                      ? 'Tarjeta'
                      : p.method === 'cash'
                        ? 'Efectivo'
                        : 'Transferencia'}
                  </td>
                  <td>
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
                  </td>
                  <td className="right">{formatDOP(p.amount)}</td>
                  <td className="right">{formatDOP(p.capturedAmount)}</td>
                  <td className="right">{p.refundedAmount ? formatDOP(p.refundedAmount) : '—'}</td>
                  <td className="muted">{dateTime(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
