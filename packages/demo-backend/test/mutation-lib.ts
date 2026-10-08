/**
 * Pruebas de mutación a la medida: una prueba que NO falla cuando se rompe el código no prueba nada.
 *
 * `loadMutant` lee un módulo TypeScript, le aplica cambios de texto ("mutaciones": invertir una
 * comparación, quitar una guarda, cambiar un número) y lo importa como un módulo aparte. Cada prueba de
 * lógica nueva escribe su conjunto de comprobaciones como una función `suite(api)` y lo corre dos veces:
 * contra el módulo de verdad (debe pasar) y contra cada mutante (debe fallar, ver `expectKilled`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { expect } from 'vitest';

export type Edit = [from: string | RegExp, to: string];

const dirs: string[] = [];
/** Carpeta de trabajo de los mutantes: dentro del repositorio (para que se resuelvan los paquetes) pero ignorada por git. */
const WORK = join(import.meta.dirname, '.mutants');

/** Importa `file` con las `edits` aplicadas. Falla en voz alta si una mutación no cambia nada (quedó vieja). */
export async function loadMutant<T>(file: string, edits: Edit[]): Promise<T> {
  let src = readFileSync(file, 'utf8');
  for (const [from, to] of edits) {
    const before = src;
    src = src.replace(from, to);
    if (src === before)
      throw new Error(`La mutación ya no aplica a ${basename(file)}: ${String(from)}`);
  }
  const base = dirname(file);
  // Los imports relativos del original siguen apuntando al original (el mutante vive en otra carpeta).
  src = src.replace(
    /(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g,
    (_m, a: string, rel: string, c: string) => {
      const abs = resolve(base, rel);
      const withExt =
        [abs, `${abs}.ts`, join(abs, 'index.ts')].find((p) => existsSync(p) && /\.ts$/.test(p)) ??
        abs;
      return `${a}${withExt}${c}`;
    },
  );
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, '.gitignore'), '*\n');
  const dir = mkdtempSync(join(WORK, 'm-'));
  dirs.push(dir);
  const out = join(dir, basename(file));
  writeFileSync(out, src);
  return (await import(/* @vite-ignore */ out)) as T;
}

/** Borra los mutantes (llamar en `afterAll`). */
export function cleanMutants(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/**
 * La suite debe pasar con el original y FALLAR con el mutante: si no falla, la prueba es débil
 * (no detecta ese defecto).
 */
export function expectKilled(name: string, suite: () => void): void {
  let failed = false;
  try {
    suite();
  } catch {
    failed = true;
  }
  expect(
    failed,
    `la mutación "${name}" NO fue detectada: las pruebas pasan aunque el código esté roto`,
  ).toBe(true);
}

/** Igual que `expectKilled` para suites asincrónicas. */
export async function expectKilledAsync(name: string, suite: () => Promise<void>): Promise<void> {
  let failed = false;
  try {
    await suite();
  } catch {
    failed = true;
  }
  expect(
    failed,
    `la mutación "${name}" NO fue detectada: las pruebas pasan aunque el código esté roto`,
  ).toBe(true);
}
