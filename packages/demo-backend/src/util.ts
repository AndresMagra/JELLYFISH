/**
 * Utilidades sin dependencias de Node: deben correr tal cual en el navegador del teléfono.
 */

/** Generador pseudoaleatorio con semilla (mulberry32): mismas semillas, mismos ids y PIN. */
export type Random = () => number;

export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash FNV-1a de 32 bits con semilla (para ids estables a partir de un texto). */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const hex = (n: number, width = 8) => (n >>> 0).toString(16).padStart(width, '0');

function formatUuid(a: number, b: number, c: number, d: number): string {
  const p1 = hex(a);
  const p2 = hex(b).slice(0, 4);
  const p3 = `4${hex(b).slice(5)}`; // versión 4
  const variant = ['8', '9', 'a', 'b'][(c >>> 28) & 3]!;
  const p4 = `${variant}${hex(c).slice(1, 4)}`;
  const p5 = `${hex(c).slice(4)}${hex(d)}`.slice(0, 12).padEnd(12, '0');
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/** UUID válido (v4) y ESTABLE para un texto: así los ids del catálogo no cambian entre cargas. */
export function stableUuid(text: string): string {
  return formatUuid(
    fnv1a(text, 0x811c9dc5),
    fnv1a(text, 0x01000193),
    fnv1a(text, 0xdeadbeef),
    fnv1a(text, 0x9e3779b9),
  );
}

/** UUID v4 a partir del generador (con semilla en las pruebas, `Math.random` en el navegador). */
export function randomUuid(rng: Random): string {
  const n = () => Math.floor(rng() * 4294967296) >>> 0;
  return formatUuid(n(), n(), n(), n());
}

/** Token opaco de sesión (no es un secreto real: la demostración no protege nada). */
export function randomToken(rng: Random): string {
  let out = '';
  for (let i = 0; i < 4; i++) out += hex(Math.floor(rng() * 4294967296));
  return `demo.${out}`;
}

/** Minúsculas, sin acentos y con espacios colapsados: base de la búsqueda (igual que el API). */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "JF-000042" */
export function formatOrderNumber(n: number): string {
  return `JF-${String(n).padStart(6, '0')}`;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Copia profunda de datos JSON (el estado nunca se comparte por referencia con las respuestas). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Comparación por unidades de código (como la colación "C" de Postgres): orden estable y determinista. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Entero pseudoaleatorio en [0, max). */
export function randomInt(rng: Random, max: number): number {
  return Math.floor(rng() * max);
}
