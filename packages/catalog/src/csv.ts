/**
 * Parser y serializador CSV mínimo (RFC 4180): comillas dobles, comillas escapadas ("")
 * y saltos de línea dentro de campos. Acepta BOM y \r\n. El delimitador es configurable
 * porque Excel en español suele exportar con punto y coma.
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      i += 1;
    } else if (c === delimiter) {
      endField();
      i += 1;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (inQuotes) throw new Error('CSV inválido: comillas sin cerrar');
  if (field !== '' || row.length > 0) endRow();

  // descarta líneas totalmente vacías
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Detecta ',' o ';' mirando la cabecera (primera línea fuera de comillas). */
export function detectDelimiter(input: string): ',' | ';' {
  const firstLine =
    (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).split(/\r?\n/, 1)[0] ?? '';
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  return semicolons > commas ? ';' : ',';
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
