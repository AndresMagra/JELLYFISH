import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AZUL_URLS, AzulGateway, MockGateway, azulAmount, type AzulConfig } from '../src';

const config: AzulConfig = {
  environment: 'test',
  merchantId: '39038540035',
  merchantName: 'JELLYFISH SRL',
  merchantType: 'ECommerce',
  authKey: 'clave-de-prueba-ñandú', // con ñ/ú: la codificación importa
};

const checkout = {
  orderNumber: 'JF000123A1',
  amount: 102_475,
  itbis: 0,
  approvedUrl: 'https://api.example.do/v1/payments/azul/approved',
  declinedUrl: 'https://api.example.do/v1/payments/azul/declined',
  cancelUrl: 'https://api.example.do/v1/payments/azul/cancel',
};

/** Orden documentado, escrito a mano aquí a propósito: si alguien reordena la constante, falla. */
const REQUEST_ORDER = [
  'MerchantId',
  'MerchantName',
  'MerchantType',
  'CurrencyCode',
  'OrderNumber',
  'Amount',
  'ITBIS',
  'ApprovedUrl',
  'DeclinedUrl',
  'CancelUrl',
  'UseCustomField1',
  'CustomField1Label',
  'CustomField1Value',
  'UseCustomField2',
  'CustomField2Label',
  'CustomField2Value',
];
const RESPONSE_ORDER = [
  'OrderNumber',
  'Amount',
  'AuthorizationCode',
  'DateTime',
  'ResponseCode',
  'IsoCode',
  'ResponseMessage',
  'ErrorDescription',
  'RRN',
];

const independentHash = (
  values: Record<string, string>,
  order: string[],
  key: string,
  enc: 'utf8' | 'utf16le' = 'utf8',
) =>
  createHmac('sha512', key)
    .update(Buffer.from(order.map((f) => values[f] ?? '').join('') + key, enc))
    .digest('hex');

describe('formato de montos de AZUL', () => {
  it.each([
    [0, '000'],
    [5, '005'],
    [100, '100'],
    [10_000, '10000'],
    [102_475, '102475'],
  ])('%i centavos → "%s"', (centavos, expected) => {
    expect(azulAmount(centavos)).toBe(expected);
  });

  it('rechaza negativos y no enteros', () => {
    expect(() => azulAmount(-1)).toThrow();
    expect(() => azulAmount(10.5)).toThrow();
  });
});

describe('AzulGateway.createCheckout', () => {
  const gw = new AzulGateway(config);

  it('arma el formulario hacia el ambiente correcto', () => {
    const form = gw.createCheckout(checkout);
    expect(form).toMatchObject({ kind: 'redirect_form', method: 'POST', url: AZUL_URLS.test });
    expect(
      new AzulGateway({ ...config, environment: 'production' }).createCheckout(checkout).url,
    ).toBe(AZUL_URLS.production);
    expect(form.fields).toMatchObject({
      MerchantId: '39038540035',
      CurrencyCode: '$',
      OrderNumber: 'JF000123A1',
      Amount: '102475',
      ITBIS: '000',
      ShowTransactionResult: '0',
      Locale: 'ES',
    });
  });

  it('firma con HMAC-SHA512 sobre los campos en el orden documentado + AuthKey', () => {
    const { fields } = gw.createCheckout(checkout);
    expect(fields.AuthHash).toBe(independentHash(fields, REQUEST_ORDER, config.authKey));
    expect(fields.AuthHash).toMatch(/^[0-9a-f]{128}$/);
  });

  it('la codificación UTF-16LE produce otro hash (configurable)', () => {
    const utf16 = new AzulGateway({ ...config, hashEncoding: 'utf16le' }).createCheckout(checkout);
    expect(utf16.fields.AuthHash).toBe(
      independentHash(utf16.fields, REQUEST_ORDER, config.authKey, 'utf16le'),
    );
    expect(utf16.fields.AuthHash).not.toBe(gw.createCheckout(checkout).fields.AuthHash);
  });

  it('cualquier cambio en un campo firmado cambia el hash', () => {
    const base = gw.createCheckout(checkout).fields.AuthHash;
    expect(gw.createCheckout({ ...checkout, amount: 102_476 }).fields.AuthHash).not.toBe(base);
    expect(gw.createCheckout({ ...checkout, orderNumber: 'JF000123A2' }).fields.AuthHash).not.toBe(
      base,
    );
  });

  it('valida el número de orden y el monto', () => {
    expect(() => gw.createCheckout({ ...checkout, orderNumber: 'JF-000123' })).toThrow(
      /alfanumérico/,
    );
    expect(() => gw.createCheckout({ ...checkout, orderNumber: 'A'.repeat(16) })).toThrow();
    expect(() => gw.createCheckout({ ...checkout, amount: 0 })).toThrow(/mayor que 0/);
  });

  it('exige credenciales completas', () => {
    expect(() => new AzulGateway({ ...config, authKey: '' })).toThrow(/authKey/);
  });
});

describe('AzulGateway.verifyCallback', () => {
  const gw = new AzulGateway(config);
  const unsigned = (over: Record<string, string> = {}): Record<string, string> => ({
    OrderNumber: 'JF000123A1',
    Amount: '000000102475',
    AuthorizationCode: 'A1B2C3',
    DateTime: '20261007101500',
    ResponseCode: 'ISO8583',
    IsoCode: '00',
    ResponseMessage: 'APROBADA',
    ErrorDescription: '',
    RRN: '123456789012',
    AzulOrderId: '987654',
    ...over,
  });
  const sign = (fields: Record<string, string>, enc: 'utf8' | 'utf16le' = 'utf8') => ({
    ...fields,
    AuthHash: independentHash(fields, RESPONSE_ORDER, config.authKey, enc),
  });
  const response = (over: Record<string, string> = {}) => sign(unsigned(over));

  it('acepta una respuesta aprobada y bien firmada', () => {
    const r = gw.verifyCallback(response());
    expect(r).toMatchObject({
      valid: true,
      approved: true,
      orderNumber: 'JF000123A1',
      amount: 102_475, // "000000102475" → 102475 centavos
      authorizationCode: 'A1B2C3',
      rrn: '123456789012',
      azulOrderId: '987654',
    });
  });

  it('una respuesta firmada pero rechazada es válida y NO aprobada', () => {
    const r = gw.verifyCallback(response({ IsoCode: '05', ResponseMessage: 'DECLINADA' }));
    expect(r).toMatchObject({ valid: true, approved: false, isoCode: '05', message: 'DECLINADA' });
  });

  it('acepta el hash calculado en UTF-16LE', () => {
    expect(gw.verifyCallback(sign(unsigned(), 'utf16le')).valid).toBe(true);
  });

  it('acepta el hash en mayúsculas', () => {
    const r = response();
    expect(gw.verifyCallback({ ...r, AuthHash: r.AuthHash.toUpperCase() }).valid).toBe(true);
  });

  it.each([
    ['monto alterado', { Amount: '000000000100' }],
    ['otro pedido', { OrderNumber: 'JF000999A1' }],
    ['código de respuesta cambiado a aprobado', { IsoCode: '00' }], // se firmó como 05
  ])('rechaza %s', (_name, tamper) => {
    const signed = response({ IsoCode: '05' });
    expect(gw.verifyCallback({ ...signed, ...tamper })).toMatchObject({
      valid: false,
      approved: false,
    });
  });

  it('rechaza una respuesta sin hash o con hash vacío', () => {
    const noHash = unsigned();
    expect(gw.verifyCallback(noHash)).toMatchObject({ valid: false, approved: false });
    expect(gw.verifyCallback({ ...noHash, AuthHash: '' }).valid).toBe(false);
  });

  it('rechaza una firma hecha con otra clave', () => {
    const other = new AzulGateway({ ...config, authKey: 'otra-clave' });
    const forged = response();
    expect(other.verifyCallback(forged).valid).toBe(false);
  });

  it('un hash de longitud distinta no revienta ni se acepta', () => {
    expect(gw.verifyCallback({ ...response(), AuthHash: 'abc' }).valid).toBe(false);
  });

  it('un monto ilegible llega como null', () => {
    const r = gw.verifyCallback(response({ Amount: '10.50' }));
    expect(r.valid).toBe(true);
    expect(r.amount).toBeNull();
  });
});

describe('MockGateway', () => {
  it('devuelve una página simulada y callbacks que pasan la MISMA verificación', () => {
    const mock = new MockGateway('http://localhost:3000/v1/payments/mock/page');
    const form = mock.createCheckout(checkout);
    expect(form.url).toBe('http://localhost:3000/v1/payments/mock/page');
    expect(form.fields.Amount).toBe('102475');

    const ok = mock.buildCallback('approved', { orderNumber: 'JF000123A1', amount: '102475' });
    expect(mock.verifyCallback(ok)).toMatchObject({ valid: true, approved: true, amount: 102_475 });

    const no = mock.buildCallback('declined', { orderNumber: 'JF000123A1', amount: '102475' });
    expect(mock.verifyCallback(no)).toMatchObject({ valid: true, approved: false, isoCode: '05' });
  });

  it('detecta alteraciones y no acepta callbacks de otra instancia', () => {
    const a = new MockGateway('http://x/a');
    const b = new MockGateway('http://x/b');
    const cb = a.buildCallback('approved', { orderNumber: 'JF000123A1', amount: '102475' });
    expect(a.verifyCallback({ ...cb, Amount: '100' }).valid).toBe(false);
    expect(b.verifyCallback(cb).valid).toBe(false);
  });
});
