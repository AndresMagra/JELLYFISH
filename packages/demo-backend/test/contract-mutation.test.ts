/**
 * Prueba de la prueba: si el servidor de demostración se desvía del API real, la comparación
 * de contrato TIENE que dar la alarma. Aquí se "rompe" la demostración de siete maneras distintas
 * (se renombra una clave, se cambia un estado HTTP, un código de error, un mensaje, un tipo, se
 * quita una clave, se descuadra un centavo) y se exige que cada una sea detectada, en el escenario
 * correcto. La corrida sin romper nada debe salir limpia.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Api,
  type Run,
  compareRuns,
  realClock,
  scenario,
  startDemo,
  startReal,
} from './contract-harness';
import { T0 } from './helpers';

type Res = { status: number; headers: Record<string, string>; body: string };
type Req = { method: string; url: string };

const edit = (res: Res, fn: (body: any) => void) => {
  if (!res.body) return;
  const b = JSON.parse(res.body);
  fn(b);
  res.body = JSON.stringify(b);
};

const mutations: { name: string; expectLabel: RegExp; tamper: (res: Res, req: Req) => void }[] = [
  {
    name: 'renombra la clave deliveryPin → pin en el detalle del pedido',
    expectLabel: /detalle/,
    tamper: (res, req) => {
      if (/\/v1\/orders\/[0-9a-f-]{36}$/.test(req.url)) {
        edit(res, (b) => {
          if ('deliveryPin' in b) {
            b.pin = b.deliveryPin;
            delete b.deliveryPin;
          }
        });
      }
    },
  },
  {
    name: 'responde 400 en vez de 409 cuando no hay stock',
    expectLabel: /solo quedan 3 lb|agotado/,
    tamper: (res) => {
      if (res.status === 409 && res.body.includes('out_of_stock')) res.status = 400;
    },
  },
  {
    name: 'cambia el código de error out_of_zone',
    expectLabel: /fuera de zona/,
    tamper: (res) => {
      if (res.body.includes('"out_of_zone"'))
        res.body = res.body.replace('"out_of_zone"', '"zona"');
    },
  },
  {
    name: 'cambia el texto del mensaje de pedido mínimo',
    expectLabel: /bajo el mínimo/,
    tamper: (res) => {
      if (res.body.includes('below_minimum'))
        res.body = res.body.replace('El pedido mínimo', 'El mínimo del pedido');
    },
  },
  {
    name: 'el total de la cotización viaja como texto en vez de número',
    expectLabel: /cotización/,
    tamper: (res, req) => {
      if (req.url.endsWith('/v1/quote'))
        edit(res, (b) => typeof b.total === 'number' && (b.total = String(b.total)));
    },
  },
  {
    name: 'quita photoIllustrative de las variantes',
    expectLabel: /producto|productos/,
    tamper: (res, req) => {
      if (req.url.includes('/v1/products')) {
        edit(res, (b) => {
          const prods = b.items ?? (b.product ? [b.product] : []);
          for (const p of prods) for (const v of p.variants) delete v.photoIllustrative;
        });
      }
    },
  },
  {
    name: 'descuadra la cotización por un centavo (misma forma, otro valor)',
    expectLabel: /cotización con dirección/,
    tamper: (res, req) => {
      if (req.url.endsWith('/v1/quote'))
        edit(res, (b) => typeof b.total === 'number' && (b.total += 1));
    },
  },
];

let real: Api;
let realRun: Run;

beforeAll(async () => {
  real = await startReal();
  realRun = await scenario(real);
  realClock.set(T0);
}, 240_000);

afterAll(async () => {
  await real?.close();
});

async function demoRunWith(tamper?: (res: Res, req: Req) => void): Promise<Run> {
  const demo = await startDemo(tamper);
  try {
    return await scenario(demo);
  } finally {
    await demo.close();
  }
}

describe('el contrato detecta las desviaciones', () => {
  it('sin romper nada, no hay ninguna diferencia (línea base)', async () => {
    const run = await demoRunWith();
    expect(compareRuns(realRun, run)).toEqual([]);
  });

  it.each(mutations)('detecta: $name', async ({ expectLabel, tamper }) => {
    const run = await demoRunWith(tamper);
    const problems = compareRuns(realRun, run);
    expect(
      problems.length,
      'la mutación pasó sin que la prueba de contrato se enterara',
    ).toBeGreaterThan(0);
    expect(
      problems.some((p) => expectLabel.test(p.split('\n')[0]!)),
      `se detectó, pero no en el escenario esperado:\n${problems.slice(0, 3).join('\n')}`,
    ).toBe(true);
  });
});
