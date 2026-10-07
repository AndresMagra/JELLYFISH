export { installDemoBackend, installServer } from './install';
export type { DemoHandle, FetchTarget, InstallOptions } from './install';
export { DEFAULT_STAGE_SECONDS, DEMO_OTP_CODE, createDemoServer, matchesBase } from './server';
export type { DemoServer } from './server';
export type { DemoRequest, DemoResponse } from './router';
export type {
  CategorySeed,
  DemoOptions,
  DemoState,
  KeyValueStorage,
  LifecycleStage,
  PhotoSeed,
  ZoneSeed,
} from './types';
export { DEFAULT_ZONE, DELIVERY_WINDOWS } from './zones';
export { normalizeText } from './util';
