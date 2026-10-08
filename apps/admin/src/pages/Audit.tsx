import type { AuditEntryDTO, AuditPageDTO } from '@jellyfish/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  Loading,
  PageHead,
  type Tone,
} from '../components/ui';
import { api, errorText } from '../lib/api';
import { dateTime } from '../lib/format';

const PAGE_SIZE = 50;
/** Lo mismo que acepta el servidor; `*` al final filtra por prefijo (orders.*). */
const ACTION_FILTER = /^[a-z0-9_.*]+$/i;

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador',
  staff: 'Personal',
  driver: 'Repartidor',
  customer: 'Cliente',
};
const ENTITY_LABEL: Record<string, string> = {
  order: 'Pedido',
  variant: 'Artículo',
  catalog: 'Catálogo',
  lot: 'Lote',
  zone: 'Zona',
  user: 'Usuario',
  payment: 'Pago',
  driver: 'Repartidor',
  coupon: 'Cupón',
  coupons: 'Cupón',
};

function statusTone(status: number): Tone {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warning';
  if (status >= 300) return 'info';
  if (status >= 200) return 'success';
  return 'neutral';
}

const actorOf = (e: AuditEntryDTO) =>
  e.actorName || ROLE_LABEL[e.actorRole] || e.actorRole || 'Sin sesión';

export function Audit() {
  const [text, setText] = useState('');
  const [action, setAction] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const filter = text.trim();
  const invalid = filter !== '' && !ACTION_FILTER.test(filter);

  // Espera a que termine de escribir; un texto que el servidor rechazaría no se envía.
  useEffect(() => {
    if (invalid) return;
    const timer = setTimeout(() => setAction(filter), 300);
    return () => clearTimeout(timer);
  }, [filter, invalid]);

  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit', action],
    queryFn: ({ pageParam }) =>
      api<AuditPageDTO>('/v1/admin/audit', {
        query: { limit: PAGE_SIZE, before: pageParam, action: action || undefined },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = q.data?.pages.flatMap((p) => p.items) ?? [];
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div data-testid="audit-page">
      <PageHead
        title="Bitácora"
        subtitle="Quién cambió qué en el panel y en la app de repartidores, de lo más reciente a lo más antiguo"
        actions={
          <Button
            variant="ghost"
            busy={q.isRefetching && !q.isFetchingNextPage}
            onClick={() => void q.refetch()}
          >
            Actualizar
          </Button>
        }
      />
      <div className="au-filter">
        <Field
          label="Filtrar por acción"
          error={invalid ? 'Usa solo letras, números, punto, guion bajo o *' : null}
          hint="Por ejemplo orders.transition, o orders.* para todas las de pedidos"
        >
          <input
            className="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Todas las acciones"
            autoComplete="off"
            data-testid="audit-filter"
          />
        </Field>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : entries.length === 0 ? (
        <Empty
          title={action ? 'No hay movimientos con esa acción' : 'Todavía no hay movimientos'}
          text={
            action
              ? 'Prueba con otra acción o borra el filtro.'
              : 'Cada cambio que haga el equipo queda registrado aquí.'
          }
        />
      ) : (
        <Card>
          <div className="table-wrap au-scroll">
            <table className="au-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Quién</th>
                  <th>Acción</th>
                  <th>Entidad</th>
                  <th>Estado</th>
                  <th>Resumen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <Fragment key={e.id}>
                    <tr data-testid="audit-row">
                      <td className="muted nowrap">{dateTime(e.createdAt)}</td>
                      <td>
                        <strong>{actorOf(e)}</strong>
                        {e.actorName && ROLE_LABEL[e.actorRole] ? (
                          <div className="muted small">{ROLE_LABEL[e.actorRole]}</div>
                        ) : null}
                      </td>
                      <td>
                        <span className="au-action">{e.action}</span>
                      </td>
                      <td>{ENTITY_LABEL[e.entity] ?? (e.entity || '—')}</td>
                      <td>
                        <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                      </td>
                      <td>{e.summary || <span className="muted">—</span>}</td>
                      <td className="right">
                        <Button
                          small
                          variant="ghost"
                          aria-expanded={open.has(e.id)}
                          onClick={() => toggle(e.id)}
                          data-testid="audit-expand"
                        >
                          {open.has(e.id) ? 'Ocultar' : 'Ver detalle'}
                        </Button>
                      </td>
                    </tr>
                    {open.has(e.id) ? (
                      <tr className="au-detail" data-testid="audit-detail">
                        <td colSpan={7}>
                          <div className="au-facts">
                            <div>
                              <span className="muted small">Petición</span>
                              <div className="au-action">
                                {e.method} {e.path}
                              </div>
                            </div>
                            <div>
                              <span className="muted small">IP</span>
                              <div className="au-action">{e.ip ?? '—'}</div>
                            </div>
                            <div>
                              <span className="muted small">Id de la entidad</span>
                              <div className="au-action">{e.entityId || '—'}</div>
                            </div>
                          </div>
                          <span className="muted small">Datos enviados</span>
                          {e.payload ? (
                            <pre className="au-payload">{JSON.stringify(e.payload, null, 2)}</pre>
                          ) : (
                            <div className="muted">Sin datos.</div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {q.isError ? (
            <div className="au-error">No pudimos cargar la bitácora: {errorText(q.error)}</div>
          ) : null}
          {q.hasNextPage ? (
            <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
              <Button
                variant="secondary"
                busy={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
                data-testid="audit-more"
              >
                Cargar más
              </Button>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
