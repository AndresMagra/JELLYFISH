import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { absolutePhotoUrl, isRemotePhoto, photoRefError, photoThumb } from '../src';

const CDN = 'https://d8j0ntlcm91z4.cloudfront.net';

describe('photoThumb', () => {
  it('reproduce la miniatura real de cada imagen del manifiesto de fotos', () => {
    const manifest = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../../../data/catalog/photos.manifest.json'),
        'utf8',
      ),
    ) as { items: { sku: string; rawUrl: string; minUrl: string }[] };
    expect(manifest.items.length).toBeGreaterThan(0);
    for (const { sku, rawUrl, minUrl } of manifest.items) {
      expect(photoThumb(rawUrl), sku).toBe(minUrl);
    }
  });

  it('cambia la imagen del CDN de generación por su variante liviana _min.webp', () => {
    expect(photoThumb(`${CDN}/user_2abc/hf_20260930_141500_9f3a.png`)).toBe(
      `${CDN}/user_2abc/hf_20260930_141500_9f3a_min.webp`,
    );
  });

  it('conserva la cadena de consulta y respeta mayúsculas en la extensión', () => {
    expect(photoThumb(`${CDN}/a/b/hf_x.PNG?v=2`)).toBe(`${CDN}/a/b/hf_x_min.webp?v=2`);
  });

  it('es idempotente: una miniatura ya convertida no se vuelve a tocar', () => {
    const once = photoThumb(`${CDN}/u/hf_abc.png`);
    expect(photoThumb(once)).toBe(once);
  });

  it('devuelve igual cualquier otra URL o ruta local', () => {
    for (const same of [
      'https://otro.example.com/u/hf_abc.png', // otro host
      `http://d8j0ntlcm91z4.cloudfront.net/u/hf_abc.png`, // sin https
      `${CDN}/u/foto-real.png`, // el CDN pero no es una generación (no empieza con hf_)
      `${CDN}/u/hf_abc.jpg`, // otra extensión
      '/photos/JF-RES-001.webp',
      'fotos/pechuga.jpg',
      'https://example.com/x.webp',
      '',
    ]) {
      expect(photoThumb(same)).toBe(same);
    }
  });

  it('no confunde un host que solo contiene el del CDN', () => {
    const evil = 'https://d8j0ntlcm91z4.cloudfront.net.evil.example/u/hf_a.png';
    expect(photoThumb(evil)).toBe(evil);
  });
});

describe('isRemotePhoto', () => {
  it('reconoce URLs http(s) y descarta rutas locales o vacías', () => {
    expect(isRemotePhoto('https://cdn.example.com/a.webp')).toBe(true);
    expect(isRemotePhoto('http://localhost:3000/photos/a.webp')).toBe(true);
    expect(isRemotePhoto('HTTPS://CDN.EXAMPLE.COM/A.WEBP')).toBe(true);
    expect(isRemotePhoto('/photos/a.webp')).toBe(false);
    expect(isRemotePhoto('fotos/a.jpg')).toBe(false);
    expect(isRemotePhoto('')).toBe(false);
    expect(isRemotePhoto('ftp://x/a.webp')).toBe(false);
  });
});

describe('absolutePhotoUrl', () => {
  it('vuelve absoluta una ruta local con la URL pública del API', () => {
    expect(absolutePhotoUrl('/photos/JF-1.webp', 'https://api.jellyfish.do')).toBe(
      'https://api.jellyfish.do/photos/JF-1.webp',
    );
  });

  it('no duplica la barra si la base termina en "/"', () => {
    expect(absolutePhotoUrl('/photos/a.webp', 'http://localhost:3000/')).toBe(
      'http://localhost:3000/photos/a.webp',
    );
  });

  it('deja intactas las URLs completas, los textos relativos y el vacío', () => {
    const base = 'https://api.jellyfish.do';
    expect(absolutePhotoUrl('https://cdn.example.com/a.webp', base)).toBe(
      'https://cdn.example.com/a.webp',
    );
    expect(absolutePhotoUrl('fotos/a.jpg', base)).toBe('fotos/a.jpg');
    expect(absolutePhotoUrl('', base)).toBe('');
  });

  it('no trata "//host/x" (protocolo implícito) como ruta local', () => {
    expect(absolutePhotoUrl('//evil.example/x.webp', 'https://api.jellyfish.do')).toBe(
      '//evil.example/x.webp',
    );
  });
});

describe('photoRefError: lo que se puede guardar como foto', () => {
  it('acepta vacío, ruta local con una sola barra y URL http(s)', () => {
    for (const ok of [
      '',
      '/photos/JF-AVE-001.thumb.webp',
      'https://d8j0ntlcm91z4.cloudfront.net/x/hf_1.png',
      'http://localhost:3000/photos/a.webp',
      'HTTPS://CDN.EJEMPLO.DO/a.jpg',
    ]) {
      expect(photoRefError(ok), ok).toBeNull();
    }
  });

  it('rechaza esquemas peligrosos, "//host", rutas relativas, espacios y textos largos', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//evil.example/x.png',
      'fotos/pechuga.jpg',
      '/photos/con espacio.webp',
      'ftp://servidor/a.png',
      'https://',
      '/',
      `/${'a'.repeat(300)}`,
    ]) {
      expect(photoRefError(bad), bad).not.toBeNull();
    }
  });
});
