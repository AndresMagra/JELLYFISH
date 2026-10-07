import type { TransferInfoDTO } from '@jellyfish/shared';
import type { DemoCatalog } from './catalog';
import type { DemoCoupon } from './coupons';
import type { DemoState, LifecycleStage, StockRec } from './types';
import type { Random } from './util';
import type { ZoneRec } from './zones';

/** Valores ya resueltos de las opciones (con sus predeterminados). */
export interface Cfg {
  baseUrl: string;
  speed: number;
  /** Duración de cada etapa en milisegundos (ya dividida entre la velocidad). */
  stageMs: Record<LifecycleStage, number>;
  paymentApproveMs: number;
  transferVerifyMs: number;
  transferInfo: TransferInfoDTO;
  otpCode: string;
  strictOtp: boolean;
  reservationMinutesCard: number;
  reservationMinutesTransfer: number;
  authBufferBps: number;
  otpTtlMinutes: number;
}

/** Todo lo que necesitan las reglas del servidor: estado, catálogo, reloj y azar. */
export interface Ctx {
  state: DemoState;
  catalog: DemoCatalog;
  zone: ZoneRec;
  cfg: Cfg;
  coupons: DemoCoupon[];
  rng: Random;
  now(): number;
}

/** Existencias de un artículo; la primera vez salen del catálogo de demostración. */
export function stockOf(ctx: Ctx, variantId: string): StockRec {
  let rec = ctx.state.stock[variantId];
  if (!rec) {
    const v = ctx.catalog.variantsById.get(variantId);
    rec = v ? { ...v.initialStock } : { onHand: 0, reserved: 0 };
    ctx.state.stock[variantId] = rec;
  }
  return rec;
}
