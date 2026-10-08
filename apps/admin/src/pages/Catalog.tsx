import {
  type AdminVariantDTO,
  type CategoryDTO,
  type ImportResultDTO,
  absolutePhotoUrl,
  isRemotePhoto,
  photoThumb,
} from '@jellyfish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Pencil, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
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
import { API_URL, api, download } from '../lib/api';
import { MONEY_ERROR, centavosToPesos, pesosToCentavos } from '../lib/format';
import { checkPhotoEdit } from '../lib/photo';
import './panel-extra.css';

const SOURCE: Record<
  AdminVariantDTO['priceSource'],
  { label: string; tone: 'success' | 'warning' | 'neutral' }
> = {
  usuario: { label: 'Confirmado', tone: 'success' },
  ancla: { label: 'Referencia', tone: 'neutral' },
  estimado: { label: 'Estimado', tone: 'warning' },
};

export function Catalog() {
  const { isAdmin } = useAuth();
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const [category, setCategory] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(false);
  const [photoOf, setPhotoOf] = useState<AdminVariantDTO | null>(null);

  const cats = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<CategoryDTO[]>('/v1/categories'),
  });
  const list = useQuery({
    queryKey: ['admin', 'catalog'],
    queryFn: () => api<AdminVariantDTO[]>('/v1/admin/catalog'),
  });

  const patch = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) =>
      api<AdminVariantDTO>(`/v1/admin/variants/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
      notify('Guardado');
    },
    onError: fail,
  });

  const rows = useMemo(() => {
    const t = search.trim().toLowerCase();
    return (list.data ?? []).filter(
      (r) =>
        (!category || r.category === category) &&
        (!blockedOnly || r.blockers.length > 0) &&
        (!t || `${r.productName} ${r.variant} ${r.sku}`.toLowerCase().includes(t)),
    );
  }, [list.data, category, blockedOnly, search]);

  const blocked = (list.data ?? []).filter((r) => r.blockers.length > 0).length;

  return (
    <>
      <PageHead
        title="Catálogo y precios"
        subtitle="Un artículo solo se muestra a los clientes con precio confirmado e ITBIS definido"
        actions={
          isAdmin ? (
            <>
              <Button
                variant="secondary"
                onClick={() =>
                  void download('/v1/admin/catalog/export', 'catalogo.csv').catch(fail)
                }
                data-testid="export-csv"
              >
                <Download size={16} /> Exportar CSV
              </Button>
              <Button onClick={() => setImporting(true)} data-testid="open-import">
                <Upload size={16} /> Importar CSV
              </Button>
            </>
          ) : undefined
        }
      />

      <Card>
        <div className="row wrap" style={{ marginBottom: 14 }}>
          <input
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="Buscar producto o SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="catalog-search"
          />
          <select
            className="input"
            style={{ maxWidth: 200 }}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Todas las categorías</option>
            {(cats.data ?? []).map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={blockedOnly}
              onChange={(e) => setBlockedOnly(e.target.checked)}
              data-testid="blocked-only"
            />
            Solo sin publicar ({blocked})
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
          <Empty
            title="Sin resultados"
            text="Cambia los filtros o importa tu inventario con “Importar CSV”."
          />
        ) : (
          <div className="table-wrap fit-scroll" style={{ maxHeight: '68vh' }}>
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Foto</th>
                  <th className="right">Precio (RD$)</th>
                  <th>Origen</th>
                  <th>ITBIS</th>
                  <th className="right">Costo</th>
                  <th>Estado</th>
                  <th>Activo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row
                    key={r.id}
                    r={r}
                    canEdit={isAdmin}
                    busy={patch.isPending}
                    onPatch={(body) => patch.mutate({ id: r.id, body })}
                    onEditPhoto={() => setPhotoOf(r)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
      {photoOf ? (
        <PhotoDialog
          r={photoOf}
          busy={patch.isPending}
          onSave={(body) =>
            patch.mutate({ id: photoOf.id, body }, { onSuccess: () => setPhotoOf(null) })
          }
          onClose={() => setPhotoOf(null)}
        />
      ) : null}
    </>
  );
}

function Row({
  r,
  canEdit,
  busy,
  onPatch,
  onEditPhoto,
}: {
  r: AdminVariantDTO;
  canEdit: boolean;
  busy: boolean;
  onPatch: (b: Record<string, unknown>) => void;
  onEditPhoto: () => void;
}) {
  const [price, setPrice] = useState(centavosToPesos(r.price));
  const [cost, setCost] = useState(r.cost === null ? '' : centavosToPesos(r.cost));
  const cents = pesosToCentavos(price);
  const priceChanged = cents !== null && cents !== r.price;
  const src = SOURCE[r.priceSource];
  const itbis = r.itbisBps === null ? '' : String(r.itbisBps);
  const costCents = pesosToCentavos(cost);

  return (
    <>
      <tr data-testid={`row-${r.sku}`}>
        <td>
          <strong>{r.productName}</strong>
          {r.variant ? <span className="muted"> · {r.variant}</span> : null}
          <div className="muted small">
            {r.sku} · {r.pricingUnit === 'lb' ? 'por libra' : 'por unidad'}
          </div>
        </td>
        <td>
          <div className="row" style={{ gap: 8 }}>
            <PhotoThumb
              key={r.photo}
              photo={r.photo}
              label={r.productName}
              testId={`photo-thumb-${r.sku}`}
            />
            <div className="stack" style={{ gap: 2 }}>
              <span className="muted small">
                {r.photo.trim() ? (r.photoIllustrative ? 'Ilustrativa' : 'Foto real') : 'Sin foto'}
              </span>
              {canEdit ? (
                <Button
                  small
                  variant="ghost"
                  onClick={onEditPhoto}
                  data-testid={`photo-edit-${r.sku}`}
                >
                  <Pencil size={13} /> Editar foto
                </Button>
              ) : null}
            </div>
          </div>
        </td>
        <td className="right nowrap">
          <input
            className={`input num ${cents === null ? 'invalid' : ''}`}
            title={cents === null ? MONEY_ERROR : undefined}
            aria-invalid={cents === null}
            value={price}
            disabled={!canEdit}
            inputMode="decimal"
            onChange={(e) => setPrice(e.target.value)}
            onBlur={() => priceChanged && onPatch({ price: cents })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            aria-label={`Precio de ${r.productName}`}
            data-testid={`price-${r.sku}`}
          />
        </td>
        <td>
          <div className="row">
            <Badge tone={src.tone}>{src.label}</Badge>
            {canEdit && r.priceSource !== 'usuario' ? (
              <Button
                small
                variant="ghost"
                disabled={busy}
                onClick={() => onPatch({ priceSource: 'usuario' })}
                data-testid={`confirm-${r.sku}`}
                title={r.priceNote}
              >
                Confirmar
              </Button>
            ) : null}
          </div>
        </td>
        <td>
          <select
            className="input"
            style={{ width: 130 }}
            disabled={!canEdit}
            value={itbis}
            onChange={(e) =>
              onPatch({ itbisBps: e.target.value === '' ? null : Number(e.target.value) })
            }
            aria-label={`ITBIS de ${r.productName}`}
            data-testid={`itbis-${r.sku}`}
          >
            <option value="">Por confirmar</option>
            <option value="0">Exento (0 %)</option>
            <option value="1800">Gravado (18 %)</option>
          </select>
        </td>
        <td className="right">
          <input
            className={`input num ${cost.trim() !== '' && costCents === null ? 'invalid' : ''}`}
            title={cost.trim() !== '' && costCents === null ? MONEY_ERROR : undefined}
            aria-invalid={cost.trim() !== '' && costCents === null}
            style={{ width: 90 }}
            value={cost}
            placeholder="—"
            disabled={!canEdit}
            inputMode="decimal"
            onChange={(e) => setCost(e.target.value)}
            onBlur={() =>
              canEdit && costCents !== null && costCents !== r.cost && onPatch({ cost: costCents })
            }
            aria-label={`Costo de ${r.productName}`}
          />
        </td>
        <td>
          {r.blockers.length === 0 ? (
            <Badge tone="success">Publicado</Badge>
          ) : (
            <span title={r.blockers.join('\n')}>
              <Badge tone="warning">Sin publicar</Badge>
              <div className="muted small" style={{ maxWidth: 210 }}>
                {r.blockers[0]}
              </div>
            </span>
          )}
        </td>
        <td>
          <input
            type="checkbox"
            checked={r.active}
            disabled={!canEdit}
            onChange={(e) => onPatch({ active: e.target.checked })}
            aria-label={`${r.productName} activo`}
          />
        </td>
      </tr>
    </>
  );
}

// ───────────── Foto del artículo ─────────────

/** Las rutas `/photos/…` se resuelven contra el API; en listas se usa la miniatura liviana si existe. */
function PhotoThumb({
  photo,
  label,
  testId,
  big,
}: {
  photo: string;
  label: string;
  testId: string;
  big?: boolean;
}) {
  const [failures, setFailures] = useState(0);
  const full = absolutePhotoUrl(photo.trim(), API_URL);
  const thumb = big ? full : photoThumb(full);
  const src = !isRemotePhoto(full)
    ? null
    : failures === 0
      ? thumb
      : failures === 1 && thumb !== full
        ? full
        : null;
  const cls = `photo-thumb ${big ? 'big' : ''}`.trim();
  return src ? (
    <img
      className={cls}
      src={src}
      alt={`Foto de ${label}`}
      loading="lazy"
      onError={() => setFailures((n) => n + 1)}
      data-testid={testId}
    />
  ) : (
    <span className={`${cls} empty`} data-testid={testId}>
      {photo.trim() ? 'No carga' : 'Sin foto'}
    </span>
  );
}

function PhotoDialog({
  r,
  busy,
  onSave,
  onClose,
}: {
  r: AdminVariantDTO;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [photo, setPhoto] = useState(r.photo);
  const [illustrative, setIllustrative] = useState(r.photoIllustrative);
  const { clean, changed, error, legacyWarning, body } = checkPhotoEdit(r, photo, illustrative);

  return (
    <Modal
      title={`Foto de ${r.productName}${r.variant ? ` ${r.variant}` : ''}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            busy={busy}
            disabled={!changed || error !== null}
            onClick={() => onSave(body)}
            data-testid={`photo-save-${r.sku}`}
          >
            Guardar foto
          </Button>
        </>
      }
    >
      <div className="photo-editor">
        <PhotoThumb
          key={error ? '' : clean}
          photo={error ? '' : clean}
          label={r.productName}
          testId={`photo-preview-${r.sku}`}
          big
        />
        <div className="stack grow" style={{ gap: 12 }}>
          {legacyWarning ? (
            <div className="banner warn small" data-testid={`photo-legacy-${r.sku}`}>
              La foto guardada (“{clean}”) no es una ruta válida y la app no puede cargarla. Puedes
              dejarla así y cambiar lo demás, o escribir una ruta nueva. {legacyWarning}
            </div>
          ) : null}
          <Field
            label="Ruta o URL de la foto"
            error={error}
            hint="Aquí no se suben archivos: escribe la ruta de una foto que ya esté en el servidor (como /photos/archivo.webp) o la URL completa de una imagen publicada. Vacío quita la foto."
          >
            <input
              className={`input ${error ? 'invalid' : ''}`.trim()}
              value={photo}
              autoFocus
              onChange={(e) => setPhoto(e.target.value)}
              placeholder="/photos/archivo.webp"
              spellCheck={false}
              data-testid={`photo-input-${r.sku}`}
            />
          </Field>
          <label className="photo-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={illustrative}
              onChange={(e) => setIllustrative(e.target.checked)}
              data-testid={`photo-illustrative-${r.sku}`}
            />
            <span>
              <strong>Imagen ilustrativa</strong>
              <span className="muted small">
                {illustrative
                  ? 'Es una ilustración: la app del cliente la rotula como “Imagen ilustrativa”.'
                  : 'Es la foto real del producto: la app del cliente la muestra sin esa leyenda.'}
              </span>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  );
}

// ───────────── Importar CSV ─────────────

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [applyStock, setApplyStock] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [result, setResult] = useState<ImportResultDTO | null>(null);

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<ImportResultDTO>('/v1/admin/catalog/import', {
        method: 'POST',
        csv,
        query: {
          dryRun: dryRun ? 1 : 0,
          applyStock: applyStock ? 1 : 0,
          overwriteConfirmed: overwrite ? 1 : 0,
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      if (!r.dryRun && r.ok) {
        void qc.invalidateQueries({ queryKey: ['admin'] });
        void qc.invalidateQueries({ queryKey: ['categories'] });
        notify(`Importado: ${r.variantsCreated} nuevos, ${r.variantsUpdated} actualizados`);
      }
    },
    onError: fail,
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setCsv(await file.text());
    setResult(null);
  };

  const applied = result && !result.dryRun && result.ok;
  return (
    <Modal
      title="Importar inventario y precios (CSV)"
      onClose={onClose}
      busy={run.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {applied ? 'Cerrar' : 'Cancelar'}
          </Button>
          <Button
            variant="secondary"
            busy={run.isPending}
            disabled={!csv.trim()}
            onClick={() => run.mutate(true)}
            data-testid="import-check"
          >
            Revisar sin guardar
          </Button>
          <Button
            busy={run.isPending}
            disabled={!csv.trim() || !result?.ok || result.dryRun === false}
            onClick={() => run.mutate(false)}
            data-testid="import-apply"
          >
            Aplicar importación
          </Button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        Sube tu archivo o pega el contenido. Primero “Revisar sin guardar” te dice qué cambiaría y
        qué filas tienen errores; no se guarda nada hasta que apliques.
      </p>
      <Field label="Archivo CSV">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => void onFile(e.target.files?.[0])}
          data-testid="import-file"
        />
      </Field>
      <Field label="…o pega el contenido">
        <textarea
          className="input"
          rows={6}
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setResult(null);
          }}
          placeholder="sku,nombre,categoria,unidad,precio,…"
          style={{ fontFamily: 'monospace', fontSize: 12.5 }}
          data-testid="import-text"
        />
      </Field>
      <div className="row wrap">
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={applyStock}
            onChange={(e) => {
              setApplyStock(e.target.checked);
              setResult(null);
            }}
          />
          Actualizar también las existencias de artículos que ya existen
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => {
              setOverwrite(e.target.checked);
              setResult(null);
            }}
          />
          Permitir que el archivo cambie precios ya confirmados
        </label>
      </div>

      {result ? (
        <div className="stack" style={{ gap: 8 }} data-testid="import-result">
          {result.ok ? (
            <div
              className="banner"
              style={{ background: 'color-mix(in srgb, #16a34a 18%, transparent)' }}
            >
              {result.dryRun ? 'Revisión correcta. ' : '¡Importación aplicada! '}
              Productos: {result.productsCreated} nuevos, {result.productsUpdated} actualizados ·
              Artículos: {result.variantsCreated} nuevos, {result.variantsUpdated} actualizados.
              {result.dryRun ? ' Aún no se guardó nada.' : ''}
            </div>
          ) : (
            <div className="banner warn">
              No se importó nada: corrige {result.errors.length}{' '}
              {result.errors.length === 1 ? 'error' : 'errores'} y vuelve a revisar.
            </div>
          )}
          {result.keptConfirmedPrices.length > 0 ? (
            <div className="muted small">
              Precios confirmados que se conservaron:{' '}
              {result.keptConfirmedPrices.slice(0, 8).join(', ')}
              {result.keptConfirmedPrices.length > 8 ? '…' : ''}
            </div>
          ) : null}
          {result.errors.length > 0 ? (
            <div className="table-wrap" style={{ maxHeight: 200 }}>
              <table>
                <thead>
                  <tr>
                    <th>Fila</th>
                    <th>SKU</th>
                    <th>Campo</th>
                    <th>Problema</th>
                  </tr>
                </thead>
                <tbody>
                  {result.errors.slice(0, 50).map((e, i) => (
                    <tr key={i}>
                      <td>{e.line}</td>
                      <td>{e.sku || '—'}</td>
                      <td>{e.field}</td>
                      <td>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {result.warnings.length > 0 ? (
            <details>
              <summary className="muted">{result.warnings.length} avisos</summary>
              <ul>
                {result.warnings.slice(0, 30).map((w, i) => (
                  <li key={i} className="muted small">
                    Fila {w.line} [{w.sku}] {w.field}: {w.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
