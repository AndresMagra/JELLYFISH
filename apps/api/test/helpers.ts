import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app';
import { type Config, testConfig } from '../src/config';
import { type DbHandle, createPgliteDb } from '../src/db/client';
import { users } from '../src/db/schema';
import { MemoryOtpSender } from '../src/services/auth';
import { importCatalog, syncCategories } from '../src/services/catalog';
import type { OrderContext } from '../src/services/orders';
import { createZone, listSlots } from '../src/services/zones';

const here = dirname(fileURLToPath(import.meta.url));
export const catalogDir = join(here, '../../../data/catalog');

export const categoriesJson = JSON.parse(
  readFileSync(join(catalogDir, 'categories.json'), 'utf8'),
) as { slug: string; name: string; tagline: string; sort: number }[];

/** Catálogo pequeño y determinista (precios confirmados) para probar pedidos. */
export const SMALL_CSV = [
  'sku,grupo,nombre,variante,categoria,unidad,paso_lb,minimo_lb,precio,precio_fuente,itbis,stock',
  'POL-1,pechuga,Pechuga de pollo,,aves,lb,0.5,1,174.95,usuario,0,100',
  'CAM-1,camaron,Camarón crudo,16/20,mariscos,lb,1,1,879.95,usuario,0,20',
  'CMB-1,combo,Combo Parrillero,,combos,unit,,,2450,usuario,18,5',
  'EST-1,estimado,Corte estimado,,res,lb,0.5,1,300,estimado,,50',
].join('\n');

export const NOW = new Date('2026-10-07T14:00:00Z'); // 10:00 en RD (UTC-4)

export interface World {
  handle: DbHandle;
  config: Config;
  ctx: OrderContext;
  customerId: string;
  adminId: string;
  driverId: string;
  zoneId: string;
  variant: (
    sku: string,
  ) => Promise<{ id: string; onHand: number; reserved: number; price: number }>;
  firstSlot: () => Promise<Date>;
  close: () => Promise<void>;
}

export async function makeWorld(overrides: Partial<Config> = {}): Promise<World> {
  const handle = await createPgliteDb();
  const { db } = handle;
  const config = testConfig(overrides);
  await syncCategories(db, categoriesJson);
  const imported = await importCatalog(db, SMALL_CSV);
  if (!imported.ok) throw new Error(`CSV de prueba inválido: ${JSON.stringify(imported.errors)}`);

  const [customer, admin, driver] = await db
    .insert(users)
    .values([
      { phone: '+18095550001', name: 'Cliente', role: 'customer' },
      { phone: '+18095550002', name: 'Admin', role: 'admin' },
      { phone: '+18095550003', name: 'Motorista', role: 'driver' },
    ])
    .returning({ id: users.id });

  const zone = await createZone(db, {
    name: 'Distrito Nacional',
    areas: ['Naco', 'Piantini', 'Distrito Nacional'],
    feeCentavos: 15_000,
    minOrderCentavos: 80_000,
    freeOverCentavos: 400_000,
  });

  const ctx: OrderContext = { db, config, now: () => NOW };
  const { variants } = await import('../src/db/schema');
  const { eq } = await import('drizzle-orm');

  return {
    handle,
    config,
    ctx,
    customerId: customer!.id,
    adminId: admin!.id,
    driverId: driver!.id,
    zoneId: zone.id,
    variant: async (sku) => {
      const [v] = await db.select().from(variants).where(eq(variants.sku, sku));
      if (!v) throw new Error(`No existe ${sku}`);
      return v;
    },
    firstSlot: async () => (await listSlots(db, config, NOW))[0]!.start,
    close: () => handle.close(),
  };
}

export const ADDRESS = {
  label: 'Casa',
  line1: 'Calle Max Henríquez Ureña 10',
  reference: 'Al lado del colmado Don Pepe, portón negro',
  sector: 'Naco',
  city: 'Santo Domingo',
  latitude: 18.4861,
  longitude: -69.9312,
  contactPhone: '+18095550001',
};

export async function makeApp(w: World) {
  const sender = new MemoryOtpSender();
  const app = await buildApp({
    db: w.handle.db,
    config: w.config,
    otpSender: sender,
    now: w.ctx.now,
  });
  const auth = (id: string, role: 'customer' | 'admin' | 'staff' | 'driver') => ({
    authorization: `Bearer ${app.jwt.sign({ sub: id, role })}`,
  });
  return { app, sender, auth };
}
