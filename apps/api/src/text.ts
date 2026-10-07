/** Minúsculas, sin acentos y con espacios colapsados: base de la búsqueda. */
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
