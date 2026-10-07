import {
  type Cell,
  type ParsedCatalog,
  type PriceListMeta,
  parseCatalogExport,
} from '@jellyfish/catalog';
import type { ImportResultDTO } from '@jellyfish/shared';
import metaFile from '../../../../data/catalog/lista-proveedor.meta.json';
import { API_URL, ApiError, api, tokenStore } from './api';

/** Fichas de los productos conocidos (descripción, sinónimos…): lo que el Excel no trae. */
export const PRICE_LIST_META = metaFile as PriceListMeta[];

// ───────────── Beneficio recordado ─────────────

const MARGIN_KEY = 'jellyfish.admin.pricelist.margin';

/** El beneficio que el dueño usó la última vez ('' si nunca o si el navegador no guarda). */
export function loadMargin(): string {
  try {
    return localStorage.getItem(MARGIN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveMargin(text: string): void {
  try {
    localStorage.setItem(MARGIN_KEY, text.trim());
  } catch {
    /* sin almacenamiento: simplemente no se recuerda */
  }
}

// ───────────── Archivo ─────────────

const MAX_BYTES = 5 * 1024 * 1024;

/** Lee la primera hoja del .xlsx dentro del navegador: nada se sube a ningún servidor. */
export async function readPriceListFile(file: File): Promise<Cell[][]> {
  if (/\.xls$/i.test(file.name)) {
    throw new Error('Ese es un Excel antiguo (.xls). Ábrelo y guárdalo como .xlsx para subirlo.');
  }
  if (!/\.xlsx$/i.test(file.name)) {
    throw new Error('El listado debe ser un archivo de Excel (.xlsx).');
  }
  if (file.size > MAX_BYTES) throw new Error('El archivo es demasiado grande para ser un listado.');
  try {
    const { readSheet } = await import('read-excel-file/browser');
    // Los tipos de la librería describen las celdas de fecha de forma poco precisa.
    return (await readSheet(file)) as unknown as Cell[][];
  } catch {
    throw new Error(
      'No pude leer ese archivo. Revisa que sea un Excel (.xlsx) sin contraseña y que no esté dañado.',
    );
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "lista-de-precios-27-09-2026.xlsx" → "27-09-2026"; si el nombre no trae fecha, la de hoy. */
export function listDateOf(fileName: string, now: Date = new Date()): string {
  return (
    /\d{2}-\d{2}-\d{4}/.exec(fileName)?.[0] ??
    `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`
  );
}

// ───────────── Catálogo actual en el servidor ─────────────

export interface CurrentCatalog extends ParsedCatalog {
  /** El CSV tal como lo entregó el servidor. */
  csv: string;
}

/** Exporta y lee el catálogo completo: es la base sobre la que se aplica el listado. */
export async function loadCurrentCatalog(): Promise<CurrentCatalog> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/admin/catalog/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new ApiError('network', 'No se pudo conectar con el servidor.', 0);
  }
  if (!res.ok) {
    // Que el cliente de la API haga su flujo normal de "sesión vencida".
    if (res.status === 401) void api('/v1/me').catch(() => undefined);
    let message = 'No se pudo leer el catálogo actual.';
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* sin JSON */
    }
    throw new ApiError('http_error', message, res.status);
  }
  const csv = await res.text();
  return { csv, ...parseCatalogExport(csv) };
}

// ───────────── Importación (reutiliza la del catálogo) ─────────────

export function importCatalogCsv(csv: string, dryRun: boolean): Promise<ImportResultDTO> {
  return api<ImportResultDTO>('/v1/admin/catalog/import', {
    method: 'POST',
    csv,
    // Existencias y precios ya confirmados no se tocan por esta vía.
    query: { dryRun: dryRun ? 1 : 0, applyStock: 0, overwriteConfirmed: 0 },
  });
}

// ───────────── Presentación ─────────────

/** 1234 → "+12.3 %"; -500 → "−5.0 %"; 0 → "0.0 %". */
export function formatChange(bps: number | null): string {
  if (bps === null) return '—';
  const pct = (Math.abs(bps) / 100).toFixed(1);
  return bps > 0 ? `+${pct} %` : bps < 0 ? `−${pct} %` : `${pct} %`;
}
