import {
  type CatalogItem,
  type MergeResult,
  type ParsedPriceList,
  type PlanRow,
  type PriceListStatus,
  DEFAULT_ITBIS_BPS,
  LARGE_CHANGE_PCT,
  catalogToCsv,
  mergePriceListIntoCatalog,
  parsePercentToBps,
  parsePriceListRows,
} from '@jellyfish/catalog';
import type { ImportResultDTO } from '@jellyfish/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Loading,
  PageHead,
  useToast,
} from '../components/ui';
import { formatDOP, qtyLabel } from '../lib/format';
import {
  PRICE_LIST_META,
  formatChange,
  importCatalogCsv,
  listDateOf,
  loadCurrentCatalog,
  loadMargin,
  readPriceListFile,
  saveMargin,
} from '../lib/pricelist';

const CATALOG_KEY = ['admin', 'pricelist', 'catalog-export'] as const;

const STATUS: Record<
  PriceListStatus,
  { label: string; tone: 'success' | 'info' | 'neutral' | 'warning' }
> = {
  nuevo: { label: 'Nuevo', tone: 'success' },
  cambia: { label: 'Cambia', tone: 'info' },
  igual: { label: 'Igual', tone: 'neutral' },
  'sin-ficha': { label: 'Sin ficha', tone: 'warning' },
};

type Filter = 'todos' | 'cambian' | 'nuevos' | 'sin-ficha' | 'iguales' | 'grandes';

const FILTERS: { id: Filter; label: string; test: (r: PlanRow) => boolean }[] = [
  { id: 'todos', label: 'Todos', test: () => true },
  { id: 'cambian', label: 'Cambian', test: (r) => r.status === 'cambia' },
  { id: 'nuevos', label: 'Nuevos', test: (r) => r.status === 'nuevo' },
  { id: 'sin-ficha', label: 'Sin ficha', test: (r) => r.status === 'sin-ficha' },
  { id: 'iguales', label: 'Iguales', test: (r) => r.status === 'igual' },
  { id: 'grandes', label: 'Cambios grandes', test: (r) => r.largeChange },
];

interface Loaded {
  id: number;
  name: string;
  parsed: ParsedPriceList;
}

interface Review {
  /** Combinación de archivo y opciones que se revisó: si algo cambia, la revisión ya no vale. */
  key: string;
  /** El CSV exacto que se probó en seco; es el que se aplica. */
  csv: string;
  result: ImportResultDTO;
  rows: PlanRow[];
  counts: MergeResult['counts'];
}

interface Done {
  counts: MergeResult['counts'];
  result: ImportResultDTO;
}

/** El catálogo del servidor cambió entre la revisión y el momento de aplicar. */
class CatalogChanged extends Error {}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summaryText(c: MergeResult['counts']): string {
  const created = c.nuevo + c.sinFicha;
  return [
    plural(created, 'producto nuevo', 'productos nuevos'),
    plural(c.cambia, 'con cambios', 'con cambios'),
    plural(c.igual, 'sin cambios', 'sin cambios'),
  ].join(', ');
}

export function PriceList() {
  const { notify, fail } = useToast();
  const qc = useQueryClient();
  const nextId = useRef(0);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [marginText, setMarginText] = useState(loadMargin);
  const [itbisIncluded, setItbisIncluded] = useState(false);
  const [deactivate, setDeactivate] = useState(false);
  const [listDate, setListDate] = useState('');
  const [filter, setFilter] = useState<Filter>('todos');
  const [search, setSearch] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [changedNotice, setChangedNotice] = useState(false);

  const catalog = useQuery({
    queryKey: CATALOG_KEY,
    queryFn: loadCurrentCatalog,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const marginBps = parsePercentToBps(marginText);
  const marginError =
    marginText.trim() !== '' && marginBps === null
      ? 'Escribe un porcentaje entre 0 y 1000 (por ejemplo 12 o 12,5).'
      : null;
  const date = listDate.trim();

  /** Cruza el listado con el catálogo; devuelve null mientras falte algo para poder hacerlo. */
  const planWith = (items: readonly CatalogItem[]): MergeResult | null => {
    if (!loaded || loaded.parsed.errors.length > 0 || marginBps === null || date === '') {
      return null;
    }
    return mergePriceListIntoCatalog(items, loaded.parsed.rows, PRICE_LIST_META, {
      rule: { marginBps, itbisMode: itbisIncluded ? 'incluido' : 'sobre' },
      listDate: date,
      includeCost: true,
      deactivateMissing: deactivate,
    });
  };

  const catalogOk = catalog.data !== undefined && catalog.data.errors.length === 0;
  const plan = useMemo(
    () => (catalogOk ? planWith(catalog.data!.items) : null),
    // planWith depende de exactamente estas entradas.
    [catalog.data, catalogOk, loaded, marginBps, itbisIncluded, deactivate, date],
  );

  const inputKey = `${loaded?.id}|${marginBps}|${itbisIncluded}|${deactivate}|${date}`;
  const currentReview = review && review.key === inputKey ? review : null;
  const reviewOk = currentReview?.result.ok === true;

  const prepare = async () => {
    const cat = await qc.fetchQuery({
      queryKey: CATALOG_KEY,
      queryFn: loadCurrentCatalog,
      staleTime: 0,
    });
    const fresh = cat.errors.length === 0 ? planWith(cat.items) : null;
    if (!fresh) throw new Error('No se pudo preparar el listado: revisa los avisos de la página.');
    return { plan: fresh, csv: catalogToCsv(fresh.items) };
  };

  const dryRun = useMutation({
    mutationFn: async () => {
      const { plan: p, csv } = await prepare();
      const result = await importCatalogCsv(csv, true);
      const next: Review = { key: inputKey, csv, result, rows: p.rows, counts: p.counts };
      return next;
    },
    onMutate: () => {
      if (marginBps !== null) saveMargin(marginText);
      setChangedNotice(false);
    },
    onSuccess: setReview,
    onError: fail,
  });

  const apply = useMutation({
    mutationFn: async () => {
      if (!currentReview) throw new Error('Primero revisa el listado.');
      const { csv } = await prepare();
      if (csv !== currentReview.csv) throw new CatalogChanged();
      return { review: currentReview, result: await importCatalogCsv(csv, false) };
    },
    onMutate: () => {
      if (marginBps !== null) saveMargin(marginText);
    },
    onSuccess: ({ review: r, result }) => {
      if (result.ok) {
        setDone({ counts: r.counts, result });
        setReview(null);
        void qc.invalidateQueries({ queryKey: ['admin'] });
        void qc.invalidateQueries({ queryKey: ['categories'] });
        notify('Precios aplicados');
      } else {
        setReview({ ...r, result });
      }
    },
    onError: (e) => {
      if (e instanceof CatalogChanged) {
        setReview(null);
        setChangedNotice(true);
        void qc.invalidateQueries({ queryKey: CATALOG_KEY });
      } else fail(e);
    },
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setReadError(null);
    setDone(null);
    setReview(null);
    setChangedNotice(false);
    setFilter('todos');
    setSearch('');
    try {
      const parsed = parsePriceListRows(await readPriceListFile(file));
      nextId.current += 1;
      setLoaded({ id: nextId.current, name: file.name, parsed });
      setListDate(listDateOf(file.name));
    } catch (e) {
      setLoaded(null);
      setReadError(e instanceof Error ? e.message : 'No pude leer ese archivo.');
    } finally {
      setReading(false);
    }
  };

  const reset = () => {
    setLoaded(null);
    setReview(null);
    setDone(null);
    setReadError(null);
    setChangedNotice(false);
    setDeactivate(false);
  };

  const visible = useMemo(() => {
    const t = search.trim().toLowerCase();
    const f = FILTERS.find((x) => x.id === filter)!;
    return (plan?.rows ?? []).filter(
      (r) =>
        f.test(r) &&
        (!t ||
          `${r.excelName} ${r.name} ${r.variant} ${r.sku} ${r.section}`.toLowerCase().includes(t)),
    );
  }, [plan, filter, search]);

  const itbisPct = `${DEFAULT_ITBIS_BPS / 100} %`;
  const busy = dryRun.isPending || apply.isPending;
  const canReview =
    plan !== null && plan.errors.length === 0 && plan.rows.length > 0 && !busy && !done;

  return (
    <>
      <PageHead
        title="Lista de precios"
        subtitle="Sube el Excel de tu proveedor, pon tu beneficio y revisa qué cambia antes de aplicarlo"
      />

      <div className="stack">
        <Card title="1. Tu listado">
          <div className="stack">
            <Field
              label="Archivo del listado (.xlsx)"
              hint="Columnas: A = asterisco (*) si paga ITBIS · B = producto · C = presentación · D = precio por libra. Se lee en tu navegador: no se sube nada hasta que apliques."
            >
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => {
                  void onFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
                aria-label="Archivo del listado de precios (.xlsx)"
                data-testid="pl-file"
              />
            </Field>

            <div className="pl-controls">
              <Field label="Beneficio sobre el listado (%)" error={marginError}>
                <input
                  className={`input ${marginError ? 'invalid' : ''}`}
                  value={marginText}
                  inputMode="decimal"
                  placeholder="Escribe el porcentaje"
                  onChange={(e) => setMarginText(e.target.value)}
                  aria-label="Beneficio sobre el listado (%)"
                  aria-invalid={marginError !== null}
                  aria-required="true"
                  data-testid="pl-margin"
                />
              </Field>
              <Field label="Fecha del listado" hint="Se anota en la nota de cada precio.">
                <input
                  className="input"
                  value={listDate}
                  onChange={(e) => setListDate(e.target.value)}
                  aria-label="Fecha del listado"
                  data-testid="pl-date"
                />
              </Field>
            </div>

            <label className="pl-check">
              <input
                type="checkbox"
                checked={itbisIncluded}
                onChange={(e) => setItbisIncluded(e.target.checked)}
                data-testid="pl-itbis-included"
              />
              Mi listado ya incluye el ITBIS
            </label>

            <p className="muted small pl-formula" data-testid="pl-formula">
              <strong>Precio de venta</strong> = precio del listado +{' '}
              {marginBps === null ? 'tu beneficio' : `${marginBps / 100} % de beneficio`}
              {itbisIncluded
                ? '. Tu listado ya trae el ITBIS, así que no se suma otra vez.'
                : ` + ${itbisPct} de ITBIS solo en los productos marcados con asterisco (*).`}{' '}
              El precio que ve el cliente ya incluye el ITBIS. El precio del listado se guarda como
              costo.
            </p>
          </div>
        </Card>

        {reading ? <Loading text="Leyendo el archivo…" /> : null}
        {readError ? (
          <div className="banner warn" role="alert" data-testid="pl-read-error">
            {readError}
          </div>
        ) : null}

        {catalog.isLoading ? (
          <Loading text="Cargando el catálogo actual…" />
        ) : catalog.isError ? (
          <ErrorBox error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : catalog.data && catalog.data.errors.length > 0 ? (
          <IssueBox
            title={`El catálogo actual tiene filas que no se pueden leer, así que no es seguro actualizarlo desde aquí.${catalog.data.errors.some((e) => e.field === 'foto') ? ' Si es una foto, corrígela en Catálogo con «Editar foto».' : ''}`}
            issues={catalog.data.errors.map((e) => ({ ...e, where: `Fila ${e.line}` }))}
          />
        ) : null}

        {loaded && loaded.parsed.errors.length > 0 ? (
          <IssueBox
            title={`El archivo "${loaded.name}" tiene ${plural(loaded.parsed.errors.length, 'problema', 'problemas')}. Corrígelos en el Excel y súbelo de nuevo.`}
            issues={loaded.parsed.errors.map((e) => ({ ...e, where: `Fila ${e.line}` }))}
          />
        ) : null}

        {loaded && loaded.parsed.errors.length === 0 && !plan && catalogOk && !done ? (
          <p className="muted pl-empty" role="status" data-testid="pl-need-margin">
            {marginBps === null
              ? 'Escribe tu beneficio para ver los precios de venta y qué cambia.'
              : 'Escribe la fecha del listado para ver la vista previa.'}
          </p>
        ) : null}

        {!loaded && !reading && !readError && !done ? (
          <p className="muted pl-empty" data-testid="pl-empty">
            Cuando subas tu listado verás aquí cada producto con su precio de venta, qué cambia
            respecto al catálogo y qué productos son nuevos.
          </p>
        ) : null}

        {done ? (
          <Card className="pl-done">
            <div className="stack" data-testid="pl-done" role="status">
              <div className="banner pl-ok">
                ¡Precios aplicados! {summaryText(done.counts)}. Fotos, existencias y descripciones
                se conservaron.
              </div>
              {done.counts.nuevo + done.counts.sinFicha > 0 ? (
                <div className="muted">
                  Los productos nuevos entran con existencia 0: recíbelos en{' '}
                  <Link to="/inventario">Inventario</Link> para poder venderlos.
                </div>
              ) : null}
              <div className="row wrap">
                <Link className="btn" to="/catalogo">
                  Ver catálogo y precios
                </Link>
                <Button variant="secondary" onClick={reset} data-testid="pl-another">
                  Subir otro listado
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {loaded && plan && !done ? (
          <>
            <div className="pl-totals" data-testid="pl-totals">
              <Total id="rows" label="En el listado" value={plan.counts.rows} />
              <Total id="cambia" label="Cambian" value={plan.counts.cambia} />
              <Total id="nuevo" label="Nuevos" value={plan.counts.nuevo} />
              <Total id="sinFicha" label="Sin ficha" value={plan.counts.sinFicha} />
              <Total id="igual" label="Iguales" value={plan.counts.igual} />
              <Total
                id="grandes"
                label={`Cambios de más de ${LARGE_CHANGE_PCT} %`}
                value={plan.counts.largeChanges}
                warn={plan.counts.largeChanges > 0}
              />
              <Total
                id="missing"
                label="Ya no vienen"
                value={plan.counts.missing}
                warn={plan.counts.missing > 0}
              />
            </div>

            {plan.errors.length > 0 ? (
              <IssueBox
                title="Hay filas del listado que no se pueden aplicar."
                issues={plan.errors.map((e) => ({ ...e, where: `Fila ${e.line}` }))}
              />
            ) : null}

            <Card title="2. Revisar y aplicar">
              <div className="stack">
                <div>
                  <label className="pl-check">
                    <input
                      type="checkbox"
                      checked={deactivate}
                      onChange={(e) => setDeactivate(e.target.checked)}
                      data-testid="pl-deactivate"
                    />
                    Desactivar los que ya no vienen en el listado ({plan.counts.missing})
                  </label>
                  <div className="muted small">
                    No se borra nada: un producto desactivado deja de mostrarse a los clientes y
                    puedes volver a activarlo en Catálogo y precios.
                  </div>
                </div>

                <div className="row wrap">
                  <Button
                    variant="secondary"
                    busy={dryRun.isPending}
                    disabled={!canReview}
                    onClick={() => dryRun.mutate()}
                    data-testid="pl-review-btn"
                  >
                    Revisar
                  </Button>
                  <Button
                    busy={apply.isPending}
                    disabled={!reviewOk || busy}
                    onClick={() => apply.mutate()}
                    data-testid="pl-apply"
                  >
                    Aplicar precios
                  </Button>
                  <span className="muted small" aria-live="polite" data-testid="pl-hint">
                    {marginBps === null
                      ? 'Escribe tu beneficio para calcular los precios de venta.'
                      : date === ''
                        ? 'Escribe la fecha del listado.'
                        : reviewOk
                          ? 'Todo en orden: ahora puedes aplicar los precios.'
                          : 'Primero pulsa «Revisar»: el servidor comprueba todo sin guardar nada.'}
                  </span>
                </div>

                {changedNotice ? (
                  <div className="banner warn" role="alert" data-testid="pl-changed">
                    El catálogo cambió mientras revisabas. No se aplicó nada: vuelve a pulsar
                    «Revisar» para ver los datos al día.
                  </div>
                ) : null}

                {currentReview ? <ReviewResult review={currentReview} /> : null}
              </div>
            </Card>

            <Card title="3. Vista previa">
              <div className="row wrap" style={{ marginBottom: 12 }}>
                <input
                  className="input"
                  style={{ maxWidth: 260 }}
                  placeholder="Buscar producto…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Buscar en la vista previa"
                  data-testid="pl-search"
                />
                <div className="row wrap" role="group" aria-label="Filtrar por estado">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`tab ${filter === f.id ? 'active' : ''}`.trim()}
                      aria-pressed={filter === f.id}
                      onClick={() => setFilter(f.id)}
                      data-testid={`pl-filter-${f.id}`}
                    >
                      {f.label} ({plan.rows.filter(f.test).length})
                    </button>
                  ))}
                </div>
              </div>

              {visible.length === 0 ? (
                <p className="muted" data-testid="pl-none">
                  Ningún producto coincide con ese filtro.
                </p>
              ) : (
                <div className="table-wrap pl-scroll" style={{ maxHeight: '64vh' }}>
                  <table className="pl-table" data-testid="pl-table">
                    <caption className="pl-sr">
                      Productos del listado con su precio de venta y su cambio respecto al catálogo
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Producto</th>
                        <th scope="col">Sección</th>
                        <th scope="col" className="right">
                          Precio del listado
                        </th>
                        <th scope="col">ITBIS</th>
                        <th scope="col" className="right">
                          Precio de venta
                        </th>
                        <th scope="col" className="right">
                          Precio actual
                        </th>
                        <th scope="col" className="right">
                          Cambio
                        </th>
                        <th scope="col">Estado</th>
                        <th scope="col">Avisos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((r) => (
                        <PreviewRow key={r.sku} r={r} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {plan.counts.missing + plan.missingInactive > 0 ? (
                <details className="pl-missing" open={plan.counts.missing > 0}>
                  <summary data-testid="pl-missing-summary">
                    {plan.counts.missing > 0
                      ? `${plural(plan.counts.missing, 'artículo activo del catálogo ya no viene', 'artículos activos del catálogo ya no vienen')} en el listado${deactivate ? ' (quedarán desactivados)' : ' (se dejan como están)'}`
                      : 'Todo lo activo del catálogo viene en el listado'}
                  </summary>
                  {plan.counts.missing > 0 ? (
                    <div className="table-wrap pl-scroll" style={{ maxHeight: 260 }}>
                      <table data-testid="pl-missing">
                        <thead>
                          <tr>
                            <th scope="col">Producto</th>
                            <th scope="col">SKU</th>
                            <th scope="col" className="right">
                              Precio actual
                            </th>
                            <th scope="col" className="right">
                              Existencia
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.missing.map((m) => (
                            <tr key={m.sku}>
                              <td>
                                {m.name}
                                {m.variant ? <span className="muted"> · {m.variant}</span> : null}
                              </td>
                              <td className="muted">{m.sku}</td>
                              <td className="right nowrap">{formatDOP(m.price)}</td>
                              <td className="right nowrap">{qtyLabel(m.pricingUnit, m.stock)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {plan.missingInactive > 0 ? (
                    <div className="muted small" style={{ marginTop: 8 }}>
                      {plural(
                        plan.missingInactive,
                        'artículo que no viene ya estaba desactivado',
                        'artículos que no vienen ya estaban desactivados',
                      )}
                      .
                    </div>
                  ) : null}
                </details>
              ) : null}
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}

function Total({
  id,
  label,
  value,
  warn,
}: {
  id: string;
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div className={`pl-total ${warn ? 'warn' : ''}`.trim()} data-testid={`pl-total-${id}`}>
      <span className="pl-total-value">{value}</span>
      <span className="muted small">{label}</span>
    </div>
  );
}

function PreviewRow({ r }: { r: PlanRow }) {
  const st = STATUS[r.status];
  return (
    <tr className={r.largeChange ? 'pl-big' : ''} data-testid={`pl-row-${r.sku}`}>
      <td>
        <strong>{r.excelName}</strong>
        <div className="muted small">
          {r.name}
          {r.variant ? ` · ${r.variant}` : ''} · {r.sku}
        </div>
      </td>
      <td className="muted small">{r.section || '—'}</td>
      <td className="right nowrap">{formatDOP(r.listPrice)}</td>
      <td>{r.taxed ? 'Sí' : 'No'}</td>
      <td className="right nowrap">
        <strong>{formatDOP(r.newPrice)}</strong>
      </td>
      <td className="right nowrap">{r.currentPrice === null ? '—' : formatDOP(r.currentPrice)}</td>
      <td className={`right nowrap ${r.largeChange ? 'pl-change-big' : ''}`.trim()}>
        {formatChange(r.changeBps)}
      </td>
      <td>
        <Badge tone={st.tone}>{st.label}</Badge>
      </td>
      <td className="small">
        {r.largeChange ? (
          <div>
            <Badge tone="warning">Cambio grande</Badge>
          </div>
        ) : null}
        {r.notes.map((n) => (
          <div key={n} className="muted">
            {n}
          </div>
        ))}
      </td>
    </tr>
  );
}

interface Issue {
  line: number;
  sku: string;
  field: string;
  message: string;
  where: string;
}

function IssueBox({ title, issues }: { title: string; issues: Issue[] }) {
  return (
    <div className="stack pl-issues" style={{ gap: 8 }} data-testid="pl-issues">
      <div className="banner warn" role="alert">
        {title}
      </div>
      <div className="table-wrap pl-scroll" style={{ maxHeight: 220 }}>
        <table>
          <thead>
            <tr>
              <th scope="col">Dónde</th>
              <th scope="col">Producto</th>
              <th scope="col">Campo</th>
              <th scope="col">Problema</th>
            </tr>
          </thead>
          <tbody>
            {issues.slice(0, 60).map((e, i) => (
              <tr key={i}>
                <td className="nowrap">{e.where}</td>
                <td>{e.sku || '—'}</td>
                <td>{e.field}</td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewResult({ review }: { review: Review }) {
  const { result, rows } = review;
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  const issues: Issue[] = result.errors.map((e) => {
    const row = bySku.get(e.sku);
    return {
      ...e,
      sku: row ? row.excelName : e.sku,
      where: row ? `Fila ${row.line} del Excel` : `Catálogo (fila ${e.line})`,
    };
  });
  let body: ReactNode;
  if (result.ok) {
    body = (
      <div className="banner pl-ok" role="status">
        Revisión correcta: {summaryText(review.counts)}. Aún no se guardó nada.
      </div>
    );
  } else {
    body = (
      <IssueBox
        title={`No se aplicó nada: corrige ${plural(result.errors.length, 'error', 'errores')} y vuelve a revisar.`}
        issues={issues}
      />
    );
  }
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="pl-review">
      {body}
      {result.warnings.length > 0 ? (
        <details>
          <summary className="muted">{plural(result.warnings.length, 'aviso', 'avisos')}</summary>
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
  );
}
