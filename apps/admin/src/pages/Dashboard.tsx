import type { OrderDTO } from '@jellyfish/shared';
import { useQuery } from '@tanstack/react-query';
import { Snowflake } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useSummary } from '../App';
import { Badge, Card, ErrorBox, Loading, PageHead, StaleNote } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, formatDOP, statusLabel } from '../lib/format';
import { expiryAlertText } from '../lib/lots';
import './panel-extra.css';

function Stat({
  label,
  value,
  hint,
  to,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  to?: string;
  tone?: 'warn';
}) {
  const nav = useNavigate();
  return (
    <div
      className={`card stat ${to ? 'link' : ''}`.trim()}
      style={tone === 'warn' && Number(value) > 0 ? { borderColor: '#f59e0b' } : undefined}
      onClick={() => to && nav(to)}
      role={to ? 'link' : undefined}
      data-testid={`stat-${label}`}
    >
      <span className="muted small">{label}</span>
      <span className="value">{value}</span>
      {hint ? <span className="muted small">{hint}</span> : null}
    </div>
  );
}

export function Dashboard() {
  const summary = useSummary();
  const recent = useQuery({
    queryKey: ['admin', 'orders', 'recent'],
    queryFn: () => api<OrderDTO[]>('/v1/admin/orders', { query: { limit: 8 } }),
    refetchInterval: 15_000,
  });

  if (summary.isLoading) return <Loading />;
  if (!summary.data)
    return <ErrorBox error={summary.error} onRetry={() => void summary.refetch()} />;
  const s = summary.data;

  return (
    <>
      <PageHead title="Resumen" subtitle="Cómo va el día y qué necesita tu atención" />

      {summary.isError ? (
        <StaleNote
          error={summary.error}
          onRetry={() => void summary.refetch()}
          busy={summary.isFetching}
        />
      ) : null}

      {s.expired > 0 || s.expiringSoon > 0 ? (
        <div className="stack" style={{ gap: 10, marginBottom: 22 }}>
          {s.expired > 0 ? (
            <Link
              to="/inventario?tab=lotes"
              className="alert-link danger"
              data-testid="alert-expired"
            >
              <Snowflake size={18} />
              <span className="grow">{expiryAlertText('expired', s.expired)}</span>
              <span className="alert-go">Ver lotes →</span>
            </Link>
          ) : null}
          {s.expiringSoon > 0 ? (
            <Link
              to="/inventario?tab=lotes"
              className="alert-link warn"
              data-testid="alert-expiring"
            >
              <Snowflake size={18} />
              <span className="grow">{expiryAlertText('expiring', s.expiringSoon)}</span>
              <span className="alert-go">Ver lotes →</span>
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="grid cols-3" style={{ marginBottom: 22 }}>
        <Stat
          label="Ventas de hoy"
          value={formatDOP(s.today.sales)}
          hint={`${s.today.orders} pedidos`}
        />
        <Stat label="Entregados hoy" value={s.today.delivered} />
        <Stat label="En camino" value={s.active.out_for_delivery} to="/pedidos" />
      </div>

      <h2 style={{ marginBottom: 12 }}>Requiere atención</h2>
      <div className="grid cols-3" style={{ marginBottom: 26 }}>
        <Stat
          label="Por preparar"
          value={s.active.confirmed + s.active.picking}
          hint="Confirmados y en preparación"
          to="/pedidos"
          tone="warn"
        />
        <Stat label="Esperando pago" value={s.active.pending_payment} to="/pedidos" />
        <Stat
          label="Transferencias por verificar"
          value={s.transfersToVerify}
          to="/pagos"
          tone="warn"
        />
        <Stat
          label="Devoluciones pendientes"
          value={s.refunds.count}
          hint={s.refunds.count ? formatDOP(s.refunds.amount) : undefined}
          to="/pagos"
          tone="warn"
        />
        <Stat
          label="Efectivo por entregar"
          value={formatDOP(s.cashOutstanding)}
          hint="Lo que tienen los repartidores"
          to="/pagos"
        />
        <Stat
          label="Entregas fallidas"
          value={s.active.delivery_failed}
          to="/pedidos"
          tone="warn"
        />
        <Stat
          label="Catálogo sin publicar"
          value={s.catalog.blocked}
          hint={`de ${s.catalog.variants} artículos`}
          to="/catalogo"
          tone="warn"
        />
        <Stat label="Sin existencias" value={s.catalog.outOfStock} to="/inventario" />
      </div>

      <Card title="Pedidos recientes" actions={<Link to="/pedidos">Ver tablero</Link>}>
        {recent.isLoading ? (
          <Loading />
        ) : (recent.data ?? []).length === 0 ? (
          <div className="muted">Todavía no hay pedidos.</div>
        ) : (
          <div className="table-wrap fit-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th>Estado</th>
                  <th className="right">Total</th>
                  <th>Creado</th>
                </tr>
              </thead>
              <tbody>
                {recent.data!.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/pedidos/${o.id}`}>{o.code}</Link>
                    </td>
                    <td>{o.customer.name || o.customer.phone}</td>
                    <td>
                      <Badge
                        tone={
                          o.status === 'delivered'
                            ? 'success'
                            : o.status === 'cancelled'
                              ? 'danger'
                              : o.status === 'pending_payment'
                                ? 'warning'
                                : 'info'
                        }
                      >
                        {statusLabel(o.status)}
                      </Badge>
                    </td>
                    <td className="right">{formatDOP(o.finalTotal ?? o.total)}</td>
                    <td className="muted">{dateTime(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
