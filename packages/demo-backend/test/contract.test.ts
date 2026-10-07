/**
 * PRUEBA DE CONTRATO: el servidor de demostración no puede desviarse del API real.
 *
 * Levanta el API REAL (buildApp con PGlite, escuchando en un puerto) y el servidor de
 * demostración (con `fetch` reemplazado), corre EXACTAMENTE los mismos escenarios por HTTP en
 * ambos —catálogo, búsqueda, cotización, cuenta, pedido en efectivo/tarjeta/transferencia,
 * detalle, cancelación, error de stock, seguimiento, pedir de nuevo, cupones, dispositivos— y
 * compara la FORMA de cada respuesta (claves, tipos, formato de ids y fechas), el estado HTTP y,
 * en los errores, el código y el mensaje. Los valores que dependen de las reglas de dinero
 * (totales, envío, cupones) también deben ser idénticos.
 *
 * Si alguien cambia el API (agrega un campo, cambia un mensaje o un código) y no actualiza el
 * simulador, esta prueba falla. `contract-mutation.test.ts` demuestra que de verdad detecta.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Api,
  type Run,
  SAME_VALUES,
  compareRuns,
  realClock,
  scenario,
  startDemo,
  startReal,
} from './contract-harness';
import { sameValues } from './contract-lib';
import { T0 } from './helpers';

// ───────────────────────── la prueba ─────────────────────────

let real: Api & { app: FastifyInstance };
let demo: Api;
let realRun: Run;
let demoRun: Run;

beforeAll(async () => {
  real = await startReal();
  realRun = await scenario(real);
  realClock.set(T0);
  demo = await startDemo();
  demoRun = await scenario(demo);
}, 240_000);

afterAll(async () => {
  await real?.close();
  await demo?.close();
});

describe('contrato: el servidor de demostración responde como el API real', () => {
  it('corre los mismos escenarios en los dos (mismas etiquetas, mismo orden)', () => {
    expect(demoRun.recs.map((r) => r.label)).toEqual(realRun.recs.map((r) => r.label));
    expect(realRun.recs.length).toBeGreaterThan(100);
  });

  it('cubre los escenarios obligatorios', () => {
    const labels = realRun.recs.map((r) => r.label).join('\n');
    for (const needed of [
      'categorías',
      'búsqueda sin acento',
      'cotización con dirección',
      'pedido efectivo: crear',
      'pedido efectivo: detalle',
      'cancelar (confirmado)',
      'cotización: solo quedan 3 lb',
      'en camino: seguimiento',
      'pedir de nuevo',
    ]) {
      expect(labels, needed).toContain(needed);
    }
  });

  it('cada respuesta tiene la misma forma, estado HTTP y errores (código y mensaje)', () => {
    const problems = compareRuns(realRun, demoRun, { values: false });
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('los valores de dinero, franjas, cupones y mensajes coinciden exactamente', () => {
    const problems: string[] = [];
    for (const [label, paths] of Object.entries(SAME_VALUES)) {
      const i = realRun.recs.findIndex((r) => r.label === label);
      expect(i, `escenario "${label}"`).toBeGreaterThanOrEqual(0);
      const diffs = sameValues(realRun.recs[i]!, demoRun.recs[i]!, paths);
      if (diffs.length) problems.push(`── ${label}: ${diffs.join('; ')}`);
    }
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('la lista de claves que el API real todavía no emite está vacía (o cada entrada tiene su motivo)', async () => {
    const { PENDING_IN_REAL_API } = await import('./contract-lib');
    expect(PENDING_IN_REAL_API).toEqual([]);
  });
});

