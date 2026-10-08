import { describe, expect, it } from 'vitest';
import { checkPhotoEdit } from '../src/lib/photo';

// Rutas inventadas: una heredada que ya no pasa la validación y otras válidas.
const LEGACY = { photo: 'fotos/pechuga.jpg', photoIllustrative: true };
const LOCAL = { photo: '/photos/pollo.webp', photoIllustrative: false };

describe('foto heredada que ya no es válida', () => {
  it('se puede guardar solo el cambio de "Imagen ilustrativa"', () => {
    const e = checkPhotoEdit(LEGACY, 'fotos/pechuga.jpg', false);
    expect(e.error).toBeNull();
    expect(e.changed).toBe(true);
    expect(e.body).toEqual({ photoIllustrative: false });
    expect(e.body).not.toHaveProperty('photo');
  });

  it('se avisa, pero no se bloquea', () => {
    const e = checkPhotoEdit(LEGACY, 'fotos/pechuga.jpg', true);
    expect(e.legacyWarning).toMatch(/ruta que empiece con \//);
    expect(e.error).toBeNull();
    expect(e.changed).toBe(false); // sin cambios todavía
  });

  it('si la persona escribe otra cosa inválida, ahí sí se bloquea', () => {
    const e = checkPhotoEdit(LEGACY, 'fotos/otra.jpg', true);
    expect(e.error).toMatch(/ruta que empiece con \//);
    expect(e.legacyWarning).toBeNull();
    expect(checkPhotoEdit(LEGACY, 'javascript:alert(1)', true).error).not.toBeNull();
    expect(checkPhotoEdit(LEGACY, '//otro-servidor/x.png', true).error).not.toBeNull();
  });

  it('cambiarla por una ruta válida la reemplaza y limpia el aviso', () => {
    const e = checkPhotoEdit(LEGACY, '  /photos/pechuga.webp  ', true);
    expect(e.error).toBeNull();
    expect(e.legacyWarning).toBeNull();
    expect(e.body).toEqual({ photo: '/photos/pechuga.webp' });
  });

  it('dejarla vacía quita la foto', () => {
    const e = checkPhotoEdit(LEGACY, '   ', true);
    expect(e.error).toBeNull();
    expect(e.body).toEqual({ photo: '' });
  });
});

describe('el PATCH solo manda lo que cambió', () => {
  it('sin cambios no hay nada que guardar', () => {
    const e = checkPhotoEdit(LOCAL, '/photos/pollo.webp', false);
    expect(e.changed).toBe(false);
    expect(e.body).toEqual({});
  });
  it('solo la foto', () => {
    expect(checkPhotoEdit(LOCAL, 'https://cdn.ejemplo.test/p.png', false).body).toEqual({
      photo: 'https://cdn.ejemplo.test/p.png',
    });
  });
  it('solo la leyenda', () => {
    expect(checkPhotoEdit(LOCAL, '/photos/pollo.webp', true).body).toEqual({
      photoIllustrative: true,
    });
  });
  it('las dos', () => {
    expect(checkPhotoEdit(LOCAL, '/photos/nueva.webp', true).body).toEqual({
      photo: '/photos/nueva.webp',
      photoIllustrative: true,
    });
  });
  it('los espacios de los extremos no cuentan como cambio', () => {
    expect(checkPhotoEdit(LOCAL, '  /photos/pollo.webp ', false).changed).toBe(false);
  });
  it('una ruta de más de 300 caracteres se rechaza', () => {
    expect(checkPhotoEdit(LOCAL, `/${'a'.repeat(300)}`, false).error).toMatch(/300/);
  });
});
