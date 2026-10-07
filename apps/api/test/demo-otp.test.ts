import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, testConfig } from '../src/config';
import type { DbHandle } from '../src/db/client';
import { MemoryOtpSender, requestOtp, verifyOtp } from '../src/services/auth';
import { createTestDb } from './test-db';

describe('código OTP fijo de demostración (DEMO_OTP_CODE)', () => {
  it('solo se acepta con JELLYFISH_DEMO=1, fuera de producción y con 6 dígitos', () => {
    expect(loadConfig({ JELLYFISH_DEMO: '1', DEMO_OTP_CODE: '123456' }).demoOtpCode).toBe('123456');
    expect(loadConfig({ JELLYFISH_DEMO: '1' }).demoOtpCode).toBeNull();
    expect(loadConfig({}).demoOtpCode).toBeNull();
    // Sin modo demo no hay atajo.
    expect(() => loadConfig({ DEMO_OTP_CODE: '123456' })).toThrow(/JELLYFISH_DEMO/);
    // En producción jamás, ni aunque el modo demo esté encendido por error.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JELLYFISH_DEMO: '1',
        DEMO_OTP_CODE: '123456',
        JWT_SECRET: 'x'.repeat(40),
        OTP_PEPPER: 'y'.repeat(20),
      }),
    ).toThrow(/producción/);
    // Formato.
    for (const bad of ['12345', '1234567', 'abcdef', '12 456']) {
      expect(() => loadConfig({ JELLYFISH_DEMO: '1', DEMO_OTP_CODE: bad }), bad).toThrow(
        /6 dígitos/,
      );
    }
  });

  describe('en el flujo de inicio de sesión', () => {
    let handle: DbHandle;
    beforeAll(async () => {
      handle = await createTestDb();
    });
    afterAll(() => handle.close());

    it('con código fijo, el teléfono recibe siempre ese código y entra con él', async () => {
      const sender = new MemoryOtpSender();
      const ctx = { db: handle.db, config: testConfig({ demoOtpCode: '123456' }), sender };
      await requestOtp(ctx, '8095550101');
      expect(sender.last('+18095550101')).toBe('123456');
      const user = await verifyOtp(ctx, '8095550101', '123456');
      expect(user.phone).toBe('+18095550101');
      // Un código distinto sigue siendo rechazado.
      await requestOtp(ctx, '8095550102');
      await expect(verifyOtp(ctx, '8095550102', '654321')).rejects.toThrow();
    });

    it('sin código fijo (producción y pruebas) los códigos son aleatorios', async () => {
      const sender = new MemoryOtpSender();
      const ctx = { db: handle.db, config: testConfig(), sender };
      for (const phone of ['8095550201', '8095550202', '8295550203']) await requestOtp(ctx, phone);
      const codes = sender.sent.map((s) => s.code);
      expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
      expect(new Set(codes).size).toBeGreaterThan(1);
    });
  });
});
