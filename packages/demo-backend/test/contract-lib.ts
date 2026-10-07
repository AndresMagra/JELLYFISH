/**
 * Comparación de FORMA entre las respuestas del API real y las del servidor de demostración:
 * mismas claves, mismos tipos (con el formato de los textos: uuid, fecha ISO, …), mismo estado
 * HTTP y, en los errores, mismo código y mensaje. No compara valores que dependen del azar o del
 * momento (ids, fechas, PIN); los valores que sí deben coincidir (precios, totales, mensajes) se
 * piden aparte en `sameValues`.
 */

export interface Rec {
  label: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export type ArrayShape = { $array: string[] };
export type Shape = string | ArrayShape | { [key: string]: Shape };
const isArrayShape = (s: Shape): s is ArrayShape =>
  typeof s === 'object' && Array.isArray((s as { $array?: unknown }).$array);

const stable = (v: unknown): string => JSON.stringify(v);

export function shapeOf(value: unknown): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const shapes = [...new Set(value.map((v) => stable(shapeOf(v))))].sort();
    return { $array: shapes };
  }
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'string':
      return UUID.test(value) ? 'uuid' : ISO.test(value) ? 'iso-date' : 'string';
    case 'object': {
      const out: Record<string, Shape> = {};
      for (const k of Object.keys(value as object).sort()) {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) continue;
        out[k] = shapeOf(v);
      }
      return out;
    }
    default:
      return 'unknown';
  }
}

/** Diferencias entre la forma esperada (API real) y la real obtenida (demostración). */
export function diffShapes(expected: Shape, actual: Shape, path = '$'): string[] {
  if (typeof expected === 'string' || typeof actual === 'string') {
    return expected === actual
      ? []
      : [`${path}: el API real devuelve ${stable(expected)} y la demostración ${stable(actual)}`];
  }
  if (isArrayShape(expected) || isArrayShape(actual)) {
    if (!isArrayShape(expected) || !isArrayShape(actual)) {
      return [`${path}: uno es lista y el otro no`];
    }
    const a = expected.$array;
    const b = actual.$array;
    const onlyA = a.filter((x) => !b.includes(x));
    const onlyB = b.filter((x) => !a.includes(x));
    if (onlyA.length === 0 && onlyB.length === 0) return [];
    const out: string[] = [];
    const left = [...onlyB];
    for (const ea of onlyA) {
      // Se empareja con la forma más parecida del otro lado y se muestra la diferencia exacta.
      let best = -1;
      let bestDiffs: string[] | null = null;
      left.forEach((eb, i) => {
        const d = diffShapes(JSON.parse(ea) as Shape, JSON.parse(eb) as Shape, `${path}[]`);
        if (!bestDiffs || d.length < bestDiffs.length) {
          best = i;
          bestDiffs = d;
        }
      });
      if (best >= 0 && bestDiffs) {
        left.splice(best, 1);
        out.push(...(bestDiffs as string[]));
      } else {
        out.push(
          `${path}[]: el API real tiene un elemento con forma ${ea.slice(0, 200)} y la demostración ninguno parecido`,
        );
      }
    }
    for (const eb of left)
      out.push(
        `${path}[]: la demostración tiene un elemento con forma ${eb.slice(0, 200)} y el API real ninguno parecido`,
      );
    return out;
  }
  const out: string[] = [];
  const ek = Object.keys(expected);
  const ak = Object.keys(actual);
  for (const k of ek) if (!(k in actual)) out.push(`${path}.${k}: falta en la demostración`);
  for (const k of ak)
    if (!(k in expected))
      out.push(`${path}.${k}: la demostración lo agrega y el API real no lo tiene`);
  for (const k of ek)
    if (k in actual) out.push(...diffShapes(expected[k]!, actual[k]!, `${path}.${k}`));
  return out;
}

/**
 * Claves que la demostración ya devuelve (porque están en packages/shared/src/api-types.ts) pero
 * que el API real todavía no emite. Se toleran SOLO si el API real no las trae; el día que las
 * trae, deben coincidir. Mantén esta lista corta: cada entrada es deuda del API real.
 */
export const PENDING_IN_REAL_API: string[] = [];

function isPendingGap(message: string): boolean {
  return PENDING_IN_REAL_API.some((p) => message.includes(`${p}: la demostración lo agrega`));
}

/** Diferencias de una respuesta: estado HTTP, forma y, en errores, código y mensaje. */
export function compareRec(real: Rec, demo: Rec): string[] {
  const out: string[] = [];
  if (real.status !== demo.status) {
    out.push(`estado HTTP: el API real responde ${real.status} y la demostración ${demo.status}`);
  }
  const realErr = (
    real.body as { error?: { code?: string; message?: string; details?: unknown } } | null
  )?.error;
  const demoErr = (
    demo.body as { error?: { code?: string; message?: string; details?: unknown } } | null
  )?.error;
  if (realErr || demoErr) {
    if (realErr?.code !== demoErr?.code)
      out.push(`error.code: real "${realErr?.code}" vs demo "${demoErr?.code}"`);
    if (realErr?.message !== demoErr?.message) {
      out.push(`error.message: real "${realErr?.message}" vs demo "${demoErr?.message}"`);
    }
    if (stable(shapeOf(realErr?.details ?? null)) !== stable(shapeOf(demoErr?.details ?? null))) {
      out.push(
        `error.details: forma distinta (real ${stable(shapeOf(realErr?.details ?? null))} vs demo ${stable(shapeOf(demoErr?.details ?? null))})`,
      );
    }
  }
  out.push(...diffShapes(shapeOf(real.body), shapeOf(demo.body)).filter((m) => !isPendingGap(m)));
  return out;
}

/** Lee un valor por ruta ("items.0.name"). */
export function at(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((v, k) => (v == null ? v : (v as Record<string, unknown>)[k]), value);
}

/** Valores que sí tienen que ser idénticos (dinero, mensajes, franjas): mismo código de reglas. */
export function sameValues(real: Rec, demo: Rec, paths: string[]): string[] {
  return paths.flatMap((p) => {
    const a = at(real.body, p);
    const b = at(demo.body, p);
    return stable(a) === stable(b) ? [] : [`valor ${p}: real ${stable(a)} vs demo ${stable(b)}`];
  });
}
