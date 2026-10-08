import type { OrderDTO, OrderStatus } from '@jellyfish/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, Empty, ErrorBox, Loading, PageHead, StaleNote } from '../components/ui';
import { api } from '../lib/api';
import { formatDOP, slot } from '../lib/format';

const COLUMNS: { status: OrderStatus; title: string }[] = [
  { status: 'pending_payment', title: 'Esperando pago' },
  { status: 'confirmed', title: 'Confirmados' },
  { status: 'picking', title: 'Preparando' },
  { status: 'packed', title: 'Empacados' },
  { status: 'out_for_delivery', title: 'En camino' },
  { status: 'delivery_failed', title: 'Entrega fallida' },
];

function Card({ o }: { o: OrderDTO }) {
  const paid = o.payments.some((p) => p.status === 'captured' || p.status === 'partially_refunded');
  const refund = o.payments.reduce((a, p) => a + p.refundPending, 0);
  return (
    <Link to={`/pedidos/${o.id}`} className="order-card" data-testid={`order-${o.code}`}>
      <div className="row between">
        <strong>{o.code}</strong>
        <span className="muted small">{formatDOP(o.finalTotal ?? o.total)}</span>
      </div>
      <div>{o.customer.name || o.customer.phone}</div>
      <div className="muted small">
        {o.address.sector} · {slot(o.slotStart, o.slotEnd)}
      </div>
      <div className="row wrap">
        <Badge tone="neutral">
          {o.paymentMethod === 'card'
            ? 'Tarjeta'
            : o.paymentMethod === 'cash'
              ? 'Efectivo'
              : 'Transferencia'}
        </Badge>
        {paid ? <Badge tone="success">Pagado</Badge> : null}
        {refund > 0 ? <Badge tone="warning">Devolver {formatDOP(refund)}</Badge> : null}
        <span className="muted small">{o.items.length} art.</span>
      </div>
    </Link>
  );
}

export function Orders() {
  const q = useQuery({
    queryKey: ['admin', 'orders', 'board'],
    queryFn: () =>
      api<OrderDTO[]>('/v1/admin/orders', {
        query: { status: COLUMNS.map((c) => c.status).join(','), limit: 200 },
      }),
    refetchInterval: 10_000,
  });

  return (
    <>
      <PageHead title="Pedidos" subtitle="Se actualiza solo cada 10 segundos" />
      {q.isError && q.data ? (
        <StaleNote error={q.error} onRetry={() => void q.refetch()} busy={q.isFetching} />
      ) : null}
      {q.isLoading ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <Empty
          title="No hay pedidos activos"
          text="Cuando un cliente haga un pedido aparecerá aquí."
        />
      ) : (
        <div className="board">
          {COLUMNS.map((c) => {
            const items = (q.data ?? []).filter((o) => o.status === c.status);
            return (
              <div key={c.status} className="column" data-testid={`col-${c.status}`}>
                <h3>
                  <span>{c.title}</span>
                  <span>{items.length}</span>
                </h3>
                {items.map((o) => (
                  <Card key={o.id} o={o} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
