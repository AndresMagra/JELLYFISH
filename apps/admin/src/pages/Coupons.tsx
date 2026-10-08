import type { CouponDTO, CouponKind, CouponRedemptionDTO } from '@jellyfish/shared';
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
  StaleNote,
  useToast,
} from '../components/ui';
import { api } from '../lib/api';
import {
  type CouponForm,
  type CouponFormErrors,
  EMPTY_COUPON_FORM,
  KIND_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  couponFormToInput,
  couponFormToPatch,
  couponPerUserText,
  couponToForm,
  couponUsageText,
  couponValueText,
  couponWindowLines,
  normalizeCouponCode,
} from '../lib/coupons';
import { dateTime, formatDOP, statusLabel } from '../lib/format';

export function Coupons() {
  const { isAdmin } = useAuth();
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CouponDTO | 'new' | null>(null);
  const [pausing, setPausing] = useState<CouponDTO | null>(null);
  const [viewing, setViewing] = useState<CouponDTO | null>(null);
  const q = useQuery({
    queryKey: ['admin', 'coupons'],
    queryFn: () => api<CouponDTO[]>('/v1/admin/coupons'),
    refetchInterval: 30_000,
  });

  const setActive = useMutation({
    mutationFn: (v: { id: string; active: boolean }) =>
      api<CouponDTO>(`/v1/admin/coupons/${v.id}`, { method: 'PATCH', body: { active: v.active } }),
    onSuccess: (_, v) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'coupons'] });
      notify(v.active ? 'Cupón activado' : 'Cupón pausado');
      setPausing(null);
    },
    onError: fail,
  });
  const toggling = (c: CouponDTO) => setActive.isPending && setActive.variables?.id === c.id;

  return (
    <div data-testid="coupons-page">
      <PageHead
        title="Cupones"
        subtitle={
          isAdmin
            ? 'Códigos de descuento que los clientes escriben al pagar'
            : 'Códigos de descuento y quién los ha usado. Solo el administrador los cambia.'
        }
        actions={
          isAdmin ? (
            <Button onClick={() => setEditing('new')} data-testid="coupon-new">
              Nuevo cupón
            </Button>
          ) : null
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
          title="Aún no hay cupones"
          text={
            isAdmin
              ? 'Crea el primero con «Nuevo cupón».'
              : 'El administrador todavía no ha creado cupones.'
          }
        />
      ) : (
        <Card>
          <div className="table-wrap cp-scroll">
            <table className="cp-table">
              <thead>
                <tr>
                  <th>Cupón</th>
                  <th>Descuento</th>
                  <th>Vigencia (hora RD)</th>
                  <th className="right">Usos</th>
                  <th className="right">Descontado</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {q.data!.map((c) => (
                  <tr key={c.id} data-testid={`coupon-row-${c.code}`}>
                    <td>
                      <strong className="cp-code">{c.code}</strong>
                      {c.description ? (
                        <div className="muted small cp-desc">{c.description}</div>
                      ) : null}
                    </td>
                    <td className="nowrap">
                      {couponValueText(c)}
                      {c.minSubtotal > 0 ? (
                        <div className="muted small">Mínimo {formatDOP(c.minSubtotal)}</div>
                      ) : null}
                      {c.maxDiscount !== null ? (
                        <div className="muted small">Tope {formatDOP(c.maxDiscount)}</div>
                      ) : null}
                    </td>
                    <td className="nowrap small">
                      {couponWindowLines(c).map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </td>
                    <td className="right nowrap">
                      {couponUsageText(c)}
                      <div className="muted small">{couponPerUserText(c.perUserLimit)}</div>
                    </td>
                    <td className="right nowrap">{formatDOP(c.discountTotal)}</td>
                    <td>
                      <span data-testid={`coupon-status-${c.code}`}>
                        <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                      </span>
                    </td>
                    <td>
                      <div className="row wrap cp-actions">
                        <Button
                          small
                          variant="secondary"
                          onClick={() => setViewing(c)}
                          data-testid={`coupon-redemptions-${c.code}`}
                        >
                          Canjes
                        </Button>
                        {isAdmin ? (
                          <>
                            <Button
                              small
                              variant="secondary"
                              onClick={() => setEditing(c)}
                              data-testid={`coupon-edit-${c.code}`}
                            >
                              Editar
                            </Button>
                            <Button
                              small
                              variant={c.active ? 'ghost' : 'primary'}
                              busy={toggling(c)}
                              onClick={() =>
                                c.active
                                  ? setPausing(c)
                                  : setActive.mutate({ id: c.id, active: true })
                              }
                              data-testid={`coupon-toggle-${c.code}`}
                            >
                              {c.active ? 'Pausar' : 'Activar'}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {editing && isAdmin ? (
        <CouponDialog
          coupon={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {pausing ? (
        <Modal
          title={`Pausar ${pausing.code}`}
          onClose={() => setPausing(null)}
          busy={setActive.isPending}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPausing(null)}>
                Cancelar
              </Button>
              <Button
                busy={setActive.isPending}
                onClick={() => setActive.mutate({ id: pausing.id, active: false })}
                data-testid="dialog-confirm"
              >
                Pausar cupón
              </Button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            Mientras esté pausado, el código <strong>{pausing.code}</strong> no funciona para los
            clientes. Los pedidos que ya lo aplicaron no cambian y puedes activarlo de nuevo cuando
            quieras.
          </p>
        </Modal>
      ) : null}
      {viewing ? <RedemptionsDialog coupon={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

function CouponDialog({ coupon, onClose }: { coupon: CouponDTO | null; onClose: () => void }) {
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<CouponForm>(coupon ? couponToForm(coupon) : EMPTY_COUPON_FORM);
  // Los errores solo se muestran en lo que la persona ya tocó o tras intentar guardar.
  const [touched, setTouched] = useState<Set<keyof CouponForm>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const locked = coupon?.termsLocked ?? false;

  const result = coupon ? couponFormToPatch(form, coupon) : couponFormToInput(form);
  const errors: CouponFormErrors = result.ok ? {} : result.errors;
  const nothingToSave = coupon !== null && result.ok && 'patch' in result && !hasKeys(result.patch);
  const shown = (f: keyof CouponForm) => (attempted || touched.has(f) ? (errors[f] ?? null) : null);
  const touch = (f: keyof CouponForm) => setTouched((t) => new Set(t).add(f));
  const set = <K extends keyof CouponForm>(f: K, v: CouponForm[K]) =>
    setForm((prev) => ({ ...prev, [f]: v }));

  // El valor de un tipo no sirve en otro (10 % no es RD$ 10): se limpia al cambiar.
  const setKind = (kind: CouponKind) =>
    setForm((prev) => ({
      ...prev,
      kind,
      value: '',
      maxDiscount: kind === 'free_delivery' ? '' : prev.maxDiscount,
    }));

  const m = useMutation({
    mutationFn: () => {
      if (!result.ok) throw new Error('Formulario inválido');
      return 'input' in result
        ? api('/v1/admin/coupons', { method: 'POST', body: result.input })
        : api(`/v1/admin/coupons/${coupon!.id}`, { method: 'PATCH', body: result.patch });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'coupons'] });
      notify(coupon ? 'Cupón actualizado' : 'Cupón creado');
      onClose();
    },
    onError: fail,
  });

  const submit = () => {
    if (m.isPending) return;
    setAttempted(true);
    if (result.ok) m.mutate();
  };

  const isFree = form.kind === 'free_delivery';
  const input = (
    f: Exclude<keyof CouponForm, 'kind'>,
    opts: { testid: string; disabled?: boolean },
  ) => ({
    className: `input${shown(f) ? ' invalid' : ''}`,
    value: form[f],
    disabled: opts.disabled,
    'data-testid': opts.testid,
    onChange: (e: { target: { value: string } }) => set(f, e.target.value),
    onBlur: () => touch(f),
  });

  return (
    <Modal
      title={coupon ? `Editar ${coupon.code}` : 'Nuevo cupón'}
      onClose={onClose}
      busy={m.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            busy={m.isPending}
            disabled={nothingToSave}
            onClick={submit}
            data-testid="coupon-submit"
          >
            {coupon ? 'Guardar cambios' : 'Crear cupón'}
          </Button>
        </>
      }
    >
      {locked ? (
        <div className="banner warn">
          Este cupón ya tiene {coupon!.redemptions} {coupon!.redemptions === 1 ? 'uso' : 'usos'}: el
          tipo, el valor y el tope no se pueden cambiar porque afectarían pedidos que ya se
          hicieron. Para otros valores, crea un cupón nuevo.
        </div>
      ) : null}
      <div className="grid cp-form">
        <Field
          label="Código"
          error={shown('code')}
          hint="De 3 a 20 caracteres: letras, números o guion. Se guarda en mayúsculas."
        >
          <input
            {...input('code', { testid: 'coupon-code', disabled: coupon !== null })}
            onChange={(e) => set('code', normalizeCouponCode(e.target.value))}
            placeholder="VERANO10"
            autoCapitalize="characters"
            autoComplete="off"
            autoFocus={coupon === null}
          />
        </Field>
        <Field
          label="Descripción"
          error={shown('description')}
          hint="Opcional. Es lo que ve el cliente; si la dejas vacía, la app arma el texto sola."
        >
          <input
            {...input('description', { testid: 'coupon-description' })}
            placeholder="10 % en tu primera compra"
          />
        </Field>
        <Field label="Tipo" error={shown('kind')}>
          <select
            className="input"
            value={form.kind}
            disabled={locked}
            onChange={(e) => setKind(e.target.value as CouponKind)}
            data-testid="coupon-kind"
          >
            {(Object.keys(KIND_LABEL) as CouponKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={
            form.kind === 'percent'
              ? 'Porcentaje (%)'
              : form.kind === 'fixed'
                ? 'Monto del descuento (RD$)'
                : 'Valor'
          }
          error={shown('value')}
          hint={isFree ? 'El envío gratis no lleva valor' : undefined}
        >
          <input
            {...input('value', { testid: 'coupon-value', disabled: locked || isFree })}
            inputMode="decimal"
            placeholder={isFree ? 'No aplica' : form.kind === 'percent' ? '10' : '150.00'}
          />
        </Field>
        <Field
          label="Compra mínima (RD$)"
          error={shown('minSubtotal')}
          hint="Opcional. Subtotal de productos que se debe alcanzar."
        >
          <input
            {...input('minSubtotal', { testid: 'coupon-min' })}
            inputMode="decimal"
            placeholder="Sin mínimo"
          />
        </Field>
        <Field
          label="Tope del descuento (RD$)"
          error={shown('maxDiscount')}
          hint={isFree ? 'El envío gratis no lleva tope' : 'Opcional. Lo máximo que se descuenta.'}
        >
          <input
            {...input('maxDiscount', { testid: 'coupon-max-discount', disabled: locked || isFree })}
            inputMode="decimal"
            placeholder={isFree ? 'No aplica' : 'Sin tope'}
          />
        </Field>
        <Field
          label="Empieza"
          error={shown('startsAt')}
          hint="Opcional. Hora de República Dominicana."
        >
          <input {...input('startsAt', { testid: 'coupon-starts' })} type="datetime-local" />
        </Field>
        <Field
          label="Termina"
          error={shown('endsAt')}
          hint="Opcional. A esa hora el cupón ya no sirve."
        >
          <input {...input('endsAt', { testid: 'coupon-ends' })} type="datetime-local" />
        </Field>
        <Field
          label="Máximo de usos"
          error={shown('maxRedemptions')}
          hint="Opcional. Vacío = sin límite."
        >
          <input
            {...input('maxRedemptions', { testid: 'coupon-max-redemptions' })}
            inputMode="numeric"
            placeholder="Sin límite"
          />
        </Field>
        <Field
          label="Usos por persona"
          error={shown('perUserLimit')}
          hint="Cuántas veces puede usarlo cada cliente."
        >
          <input {...input('perUserLimit', { testid: 'coupon-per-user' })} inputMode="numeric" />
        </Field>
      </div>
      {nothingToSave ? <div className="muted small">No hay cambios por guardar.</div> : null}
    </Modal>
  );
}

const hasKeys = (o: object) => Object.keys(o).length > 0;

function RedemptionsDialog({ coupon, onClose }: { coupon: CouponDTO; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['admin', 'coupons', coupon.id, 'redemptions'],
    queryFn: () => api<CouponRedemptionDTO[]>(`/v1/admin/coupons/${coupon.id}/redemptions`),
  });
  const rows = q.data ?? [];
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  return (
    <Modal title={`Canjes de ${coupon.code}`} onClose={onClose}>
      {q.isError && q.data ? (
        <StaleNote error={q.error} onRetry={() => void q.refetch()} busy={q.isFetching} />
      ) : null}
      {q.isLoading ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <Empty
          title="Nadie lo ha usado todavía"
          text="Cuando un pedido lo aplique, aparece aquí."
        />
      ) : (
        <>
          <div className="muted">
            {rows.length} {rows.length === 1 ? 'canje' : 'canjes'} · {formatDOP(total)}{' '}
            {coupon.kind === 'free_delivery' ? 'de envío perdonado' : 'descontados'}
            {rows.length >= 500 ? ' · se muestran los 500 más recientes' : ''}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th className="right">Monto</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`coupon-redemption-${r.orderCode}`}>
                    <td>
                      <Link to={`/pedidos/${r.orderId}`}>{r.orderCode}</Link>
                      <div className="muted small">{statusLabel(r.orderStatus)}</div>
                    </td>
                    <td>{r.customerName || <span className="muted">Sin nombre</span>}</td>
                    <td className="right nowrap">{formatDOP(r.amount)}</td>
                    <td className="muted nowrap">{dateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
