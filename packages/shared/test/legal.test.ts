import { describe, expect, it } from 'vitest';
import {
  BUSINESS,
  LEGAL_DOCS,
  LEGAL_DOC_IDS,
  LEGAL_DRAFT,
  LEGAL_TOKENS,
  LEGAL_UPDATED_AT,
  PENDING,
  fillLegalTokens,
  formatLegalDate,
  isLegalDocId,
  isPending,
  legalDocText,
  pendingBusinessFields,
  renderLegalDoc,
  type LegalDocId,
} from '../src';

/** Texto crudo (con marcadores `{…}` sin reemplazar) de un documento. */
const rawText = (id: LegalDocId) => JSON.stringify(LEGAL_DOCS[id]).replace(/\\n/g, '\n');

describe('datos del negocio', () => {
  it('el nombre comercial es JELLYFISH y lo que no existe lleva el marcador [por definir]', () => {
    expect(BUSINESS.tradeName).toBe('JELLYFISH');
    expect(PENDING).toBe('[por definir]');
    // Nada de datos inventados: razón social, RNC, dirección, teléfono y correo quedan por definir.
    for (const k of ['legalName', 'taxId', 'address', 'phone', 'supportEmail'] as const) {
      expect(isPending(BUSINESS[k])).toBe(true);
    }
    expect(pendingBusinessFields()).toEqual([
      'legalName',
      'taxId',
      'address',
      'phone',
      'supportEmail',
    ]);
  });

  it('pendingBusinessFields queda vacío cuando el dueño completa todo', () => {
    const done = {
      ...BUSINESS,
      legalName: 'JELLYFISH SRL',
      taxId: '1-30-12345-6',
      address: 'Calle 1 #2',
      phone: '809-555-0000',
      supportEmail: 'hola@example.do',
    };
    expect(pendingBusinessFields(done)).toEqual([]);
  });
});

describe('textos legales', () => {
  it('existen los cuatro documentos, en orden, con título, resumen y fecha', () => {
    expect(LEGAL_DOC_IDS).toEqual(['terminos', 'privacidad', 'devoluciones', 'cadena-de-frio']);
    for (const id of LEGAL_DOC_IDS) {
      const doc = LEGAL_DOCS[id];
      expect(doc.id).toBe(id);
      expect(doc.title.length).toBeGreaterThan(5);
      expect(doc.summary.length).toBeGreaterThan(20);
      expect(doc.updatedAt).toBe(LEGAL_UPDATED_AT);
      expect(doc.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('cada documento tiene varias secciones, con encabezado y contenido', () => {
    for (const id of LEGAL_DOC_IDS) {
      const doc = LEGAL_DOCS[id];
      expect(doc.sections.length).toBeGreaterThanOrEqual(5);
      for (const s of doc.sections) {
        expect(s.heading.trim().length).toBeGreaterThan(3);
        expect(s.blocks.length).toBeGreaterThan(0);
        for (const b of s.blocks) {
          if (typeof b === 'string') expect(b.trim().length).toBeGreaterThan(20);
          else {
            expect(b.list.length).toBeGreaterThan(0);
            for (const li of b.list) expect(li.trim().length).toBeGreaterThanOrEqual(8);
          }
        }
      }
    }
  });

  it('los términos y la privacidad cubren lo prometido (PIN, ubicación, token, derechos)', () => {
    const terms = legalDocText(renderLegalDoc('terminos')).toLowerCase();
    expect(terms).toContain('pin');
    expect(terms).toContain('itbis');
    expect(terms).toContain('peso real');
    const priv = legalDocText(renderLegalDoc('privacidad')).toLowerCase();
    for (const word of [
      'teléfono',
      'nombre',
      'direcciones',
      'ubicación',
      'pedidos',
      'token de notificaciones',
      'acceso',
      'rectificación',
      'eliminación',
      '172-13',
    ]) {
      expect(priv, word).toContain(word);
    }
  });

  it('devoluciones: 24 horas con foto, peso real y cancelación antes de empacar', () => {
    const t = legalDocText(renderLegalDoc('devoluciones')).toLowerCase();
    expect(t).toContain('24 horas');
    // Todos los plazos en horas que menciona el texto son el de 24 (no se cuela otro número).
    for (const m of t.matchAll(/(\d+) horas/g)) expect(m[1]).toBe('24');
    expect(t).toContain('foto');
    expect(t).toContain('peso real');
    expect(t).toContain('diferencia');
    expect(t).toContain('empacado');
  });

  it('no afirma cumplir la ley ni certificaciones que no se pueden respaldar', () => {
    for (const id of LEGAL_DOC_IDS) {
      const t = legalDocText(renderLegalDoc(id)).toLowerCase();
      expect(t, id).not.toMatch(/cumplimos con la ley|cumple con la ley|certificad|100 % seguro y/);
    }
  });
});

describe('marcadores pendientes', () => {
  it('todos los {marcadores} de las plantillas están declarados', () => {
    const declared = new Set(Object.keys(LEGAL_TOKENS));
    for (const id of LEGAL_DOC_IDS) {
      const used = [...rawText(id).matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      expect(used.length, `${id} usa algún dato del negocio`).toBeGreaterThan(0);
      for (const key of used) expect(declared.has(key), `${id}: {${key}}`).toBe(true);
    }
    // y cada marcador declarado apunta a un campo real del negocio
    for (const field of Object.values(LEGAL_TOKENS)) expect(field in BUSINESS).toBe(true);
  });

  it('al armar el documento no queda ningún {marcador} sin reemplazar', () => {
    for (const id of LEGAL_DOC_IDS) {
      const text = legalDocText(renderLegalDoc(id));
      expect(text, id).not.toMatch(/\{\w+\}/);
    }
  });

  it('las plantillas no traen "[por definir]" escrito a mano: solo viene del negocio', () => {
    for (const id of LEGAL_DOC_IDS) {
      expect(rawText(id), id).not.toContain(PENDING);
    }
  });

  it('no hay marcas olvidadas (TODO, XXX, lorem, TBD…)', () => {
    for (const id of LEGAL_DOC_IDS) {
      const text = legalDocText(renderLegalDoc(id));
      // Solo se permite el corchete "[por definir]" que viene de los datos del negocio.
      expect(text, id).not.toMatch(/\bTODO\b|FIXME|XXX|\bTBD\b|\?\?\?/); // en mayúscula: "todo" es una palabra normal
      expect(text, id).not.toMatch(/lorem|ipsum/i);
      expect(text, id).not.toMatch(/\[(?!por definir\])[^\]]*\]/);
    }
  });

  it('con los datos reales completos desaparecen todos los "[por definir]"', () => {
    const done = {
      ...BUSINESS,
      legalName: 'JELLYFISH SRL',
      taxId: '1-30-12345-6',
      address: 'Calle 1 #2, Santo Domingo',
      phone: '809-555-0000',
      supportEmail: 'hola@example.do',
    };
    for (const id of LEGAL_DOC_IDS) {
      const text = legalDocText(renderLegalDoc(id, done));
      expect(text, id).not.toContain(PENDING);
      expect(text, id).not.toMatch(/\{\w+\}/);
    }
    expect(legalDocText(renderLegalDoc('terminos', done))).toContain('1-30-12345-6');
  });

  it('con los datos de hoy, el [por definir] aparece solo donde va un dato del negocio', () => {
    const text = legalDocText(renderLegalDoc('terminos'));
    expect(text).toContain('RNC: [por definir]');
    expect(text).toContain('Operado por: [por definir]');
  });
});

describe('utilidades', () => {
  it('fillLegalTokens reemplaza los conocidos y deja los desconocidos tal cual', () => {
    expect(fillLegalTokens('{negocio} · {rnc} · {otraCosa}')).toBe(
      'JELLYFISH · [por definir] · {otraCosa}',
    );
  });

  it('formatLegalDate escribe la fecha en español', () => {
    expect(formatLegalDate('2026-10-07')).toBe('7 de octubre de 2026');
    expect(formatLegalDate('2027-01-01')).toBe('1 de enero de 2027');
    expect(formatLegalDate('mañana')).toBe('mañana');
  });

  it('isLegalDocId acepta solo ids conocidos', () => {
    expect(isLegalDocId('privacidad')).toBe(true);
    expect(isLegalDocId('cadena-de-frio')).toBe(true);
    expect(isLegalDocId('otro')).toBe(false);
    expect(isLegalDocId(undefined)).toBe(false);
  });

  it('mientras no se revise, el borrador está activo (el dueño lo apaga a mano)', () => {
    expect(LEGAL_DRAFT).toBe(true);
  });
});
