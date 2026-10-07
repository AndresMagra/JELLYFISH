import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, toCsv } from '../src';

describe('parseCsv', () => {
  it('lee campos simples y con comillas', () => {
    expect(parseCsv('a,b,c\n1,"hola, mundo",3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'hola, mundo', '3'],
    ]);
  });

  it('soporta comillas escapadas y saltos de línea dentro de campos', () => {
    expect(parseCsv('a,b\n"di ""hola""","línea 1\nlínea 2"\n')).toEqual([
      ['a', 'b'],
      ['di "hola"', 'línea 1\nlínea 2'],
    ]);
  });

  it('acepta BOM, CRLF y filas vacías', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('conserva campos vacíos', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('falla con comillas sin cerrar', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/comillas/);
  });

  it('detecta el punto y coma de Excel en español', () => {
    expect(detectDelimiter('sku;nombre;precio\n')).toBe(';');
    expect(detectDelimiter('sku,nombre,precio\n')).toBe(',');
    expect(parseCsv('a;b\n1;2', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('toCsv escapa y se puede volver a leer', () => {
    const rows = [
      ['x', 'con "comillas"', 'coma, aquí'],
      ['1', '', 'línea\nnueva'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
