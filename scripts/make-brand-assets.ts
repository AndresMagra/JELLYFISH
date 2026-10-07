/**
 * Marca de JELLYFISH: genera los íconos y la pantalla de inicio de las dos apps móviles.
 *
 *   npm run brand:assets                 → regenera apps/{customer,driver}/assets/*.png
 *   npm run brand:assets -- --preview    → además deja una hoja de contactos en tmp/brand-preview.png
 *   npm run brand:check                  → solo valida los PNG existentes (tamaño, alfa, zona segura…)
 *
 * El dibujo es un SVG propio (medusa bioluminiscente sobre océano profundo, paleta de
 * packages/shared/src/tokens.ts) que Chromium rasteriza a PNG. No usa fuentes ni imágenes externas,
 * así que el resultado es el mismo en cualquier computadora con Chromium (ruta en CHROME_PATH).
 *
 * Cliente: medusa cian con detalles coral. Repartidor: la misma medusa con la paleta invertida
 * (cuerpo coral, detalles cian) y una insignia de moto de entrega, para no confundirlas en el teléfono.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { palette } from '@jellyfish/shared';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export type Variant = 'customer' | 'driver';
export const VARIANTS: readonly Variant[] = ['customer', 'driver'];

/* ───────────────────────────── PNG (sin dependencias) ───────────────────────────── */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const body = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

export interface Raster {
  width: number;
  height: number;
  /** 3 = RGB (sin alfa), 4 = RGBA */
  channels: 3 | 4;
  data: Uint8Array;
}

/** Decodifica PNG de 8 bits, sin entrelazado, RGB o RGBA (lo que produce Chromium). */
export function decodePng(file: Buffer): Raster {
  if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('No es un PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (pos < file.length) {
    const len = file.readUInt32BE(pos);
    const type = file.toString('latin1', pos + 4, pos + 8);
    const data = file.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colorType = data[9] as number;
      if (depth !== 8 || data[12] !== 0) throw new Error('Solo PNG de 8 bits y sin entrelazado');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (colorType !== 2 && colorType !== 6)
    throw new Error(`Tipo de color PNG no soportado: ${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x] as number;
      const a = x >= channels ? (out[y * stride + x - channels] as number) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] as number) : 0;
      const c = x >= channels && y > 0 ? (out[(y - 1) * stride + x - channels] as number) : 0;
      let v: number;
      switch (ft) {
        case 0:
          v = cur;
          break;
        case 1:
          v = cur + a;
          break;
        case 2:
          v = cur + b;
          break;
        case 3:
          v = cur + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`Filtro PNG desconocido: ${ft}`);
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Codifica PNG de 8 bits probando los 5 filtros por fila (el de menor suma absoluta). */
export function encodePng(img: Raster): Buffer {
  const { width, height, channels, data } = img;
  const stride = width * channels;
  const rows: Buffer[] = [];
  const at = (y: number, x: number) => (y < 0 || x < 0 ? 0 : (data[y * stride + x] as number));
  for (let y = 0; y < height; y++) {
    let best: Buffer | null = null;
    let bestScore = Infinity;
    for (let ft = 0; ft < 5; ft++) {
      const row = Buffer.alloc(stride + 1);
      row[0] = ft;
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const cur = at(y, x);
        const a = x >= channels ? at(y, x - channels) : 0;
        const b = at(y - 1, x);
        const c = x >= channels ? at(y - 1, x - channels) : 0;
        let pred = 0;
        if (ft === 1) pred = a;
        else if (ft === 2) pred = b;
        else if (ft === 3) pred = (a + b) >> 1;
        else if (ft === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur - pred) & 0xff;
        row[x + 1] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = row;
      }
    }
    rows.push(best as Buffer);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Quita el canal alfa componiendo sobre un fondo (Apple rechaza íconos con alfa). */
export function flatten(img: Raster, bg: [number, number, number]): Raster {
  if (img.channels === 3) return img;
  const out = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
    const a = (img.data[i + 3] as number) / 255;
    for (let k = 0; k < 3; k++) {
      out[j + k] = Math.round((img.data[i + k] as number) * a + bg[k]! * (1 - a));
    }
  }
  return { width: img.width, height: img.height, channels: 3, data: out };
}

/* ───────────────────────────────── Dibujo (SVG) ───────────────────────────────── */

type P = [number, number];

interface Theme {
  /** Campana: de arriba (claro) a borde (más saturado). */
  bellTop: string;
  bellMid: string;
  bellRim: string;
  /** Resplandor alrededor de la medusa. */
  halo: string;
  /** Tentáculos finos. */
  tentacle: string;
  /** Brazos orales (cintas del centro). */
  arm: string;
  armSoft: string;
  /** Perlas bioluminiscentes. */
  bead: string;
  /** Color de la insignia (repartidor). */
  badge: string;
  badgeSoft: string;
  /** Tinte del fondo. */
  bgGlow: string;
  bgGlowOpacity: number;
}

const THEMES: Record<Variant, Theme> = {
  customer: {
    bellTop: palette.cyanSoft,
    bellMid: palette.cyan,
    bellRim: palette.violet,
    halo: palette.cyan,
    tentacle: palette.cyanSoft,
    arm: palette.coral,
    armSoft: palette.coralSoft,
    bead: palette.cyanSoft,
    badge: palette.coral,
    badgeSoft: palette.coralSoft,
    bgGlow: palette.cyan,
    bgGlowOpacity: 0.1,
  },
  driver: {
    bellTop: palette.coralSoft,
    bellMid: palette.coral,
    bellRim: palette.violet,
    halo: palette.coral,
    tentacle: palette.coralSoft,
    arm: palette.cyan,
    armSoft: palette.cyanSoft,
    bead: palette.coralSoft,
    badge: palette.coral,
    badgeSoft: palette.coralSoft,
    bgGlow: palette.coral,
    bgGlowOpacity: 0.16,
  },
};

/** Posición de la insignia de moto (repartidor) en el sistema local de la medusa. */
const BADGE = { cx: 205, cy: 205, r: 132 } as const;

const f = (n: number) => Number(n.toFixed(2));

function bez(a: P, b: P, c: P, d: P, t: number): P {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
    u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
  ];
}

/**
 * Tentáculo en S: dos cúbicas con tangente continua. Devuelve el trazo y los puntos donde van las
 * perlas bioluminiscentes (calculados sobre la curva real, no a ojo).
 */
function tentacle(x0: number, y0: number, len: number, amp: number, dir: 1 | -1, drift: number) {
  const p0: P = [x0, y0];
  const c1: P = [x0 + dir * amp, y0 + len * 0.16];
  const c2: P = [x0 + dir * amp * 0.25 + drift * 0.3, y0 + len * 0.3];
  const p3: P = [x0 - dir * amp * 0.25 + drift * 0.5, y0 + len * 0.5];
  const c3: P = [2 * p3[0] - c2[0], 2 * p3[1] - c2[1]];
  const c4: P = [x0 - dir * amp * 1.05 + drift * 0.8, y0 + len * 0.76];
  const p6: P = [x0 + dir * amp * 0.35 + drift, y0 + len];
  const d = `M${f(p0[0])} ${f(p0[1])}C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p3[0])} ${f(p3[1])}C${f(c3[0])} ${f(c3[1])} ${f(c4[0])} ${f(c4[1])} ${f(p6[0])} ${f(p6[1])}`;
  return {
    d,
    beads: [bez(p0, c1, c2, p3, 0.7), bez(p3, c3, c4, p6, 0.55), p6] as P[],
  };
}

/** Contorno de la campana: cúpula suave y borde festoneado. */
const BELL_PATH =
  'M-252-34C-262-190-160-330 0-330S262-190 252-34' +
  'Q210 28 168-22Q126 30 84-22Q42 30 0-22Q-42 30-84-22Q-126 30-168-22Q-210 28-252-34Z';
/** Solo el borde inferior (para el brillo del filo). */
const BELL_RIM_PATH =
  'M-252-34Q-210 28-168-22Q-126 30-84-22Q-42 30 0-22Q42 30 84-22Q126 30 168-22Q210 28 252-34';

const TENTACLES = [
  tentacle(-196, -4, 262, 40, 1, -14),
  tentacle(-124, 2, 330, 46, -1, 10),
  tentacle(-52, 4, 372, 40, 1, -6),
  tentacle(52, 4, 372, 40, -1, 6),
  tentacle(124, 2, 330, 46, 1, -10),
  tentacle(196, -4, 262, 40, -1, 14),
];

const ARMS = [
  'M-30-8C-74 56 14 104-34 176C-56 210-46 236-58 262',
  'M30-8C74 64-12 116 36 190C58 224 46 248 60 276',
  'M0-6C26 52-22 104 8 168C22 198 12 214 18 236',
];

/** Definiciones SVG (degradados, filtros) de la medusa. */
function jellyDefs(t: Theme): string {
  return `
<linearGradient id="bell" gradientUnits="userSpaceOnUse" x1="0" y1="-330" x2="0" y2="14">
  <stop offset="0" stop-color="${t.bellTop}" stop-opacity=".98"/>
  <stop offset=".5" stop-color="${t.bellMid}" stop-opacity=".92"/>
  <stop offset="1" stop-color="${t.bellRim}" stop-opacity=".88"/>
</linearGradient>
<radialGradient id="core" gradientUnits="userSpaceOnUse" cx="0" cy="-150" r="190">
  <stop offset="0" stop-color="#fff" stop-opacity=".95"/>
  <stop offset=".45" stop-color="${t.bellTop}" stop-opacity=".45"/>
  <stop offset="1" stop-color="${t.bellTop}" stop-opacity="0"/>
</radialGradient>
<radialGradient id="halo" gradientUnits="userSpaceOnUse" cx="0" cy="-60" r="400">
  <stop offset="0" stop-color="${t.halo}" stop-opacity=".5"/>
  <stop offset=".5" stop-color="${t.halo}" stop-opacity=".16"/>
  <stop offset="1" stop-color="${t.halo}" stop-opacity="0"/>
</radialGradient>
<linearGradient id="tent" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="372">
  <stop offset="0" stop-color="${t.tentacle}" stop-opacity=".98"/>
  <stop offset=".6" stop-color="${t.tentacle}" stop-opacity=".6"/>
  <stop offset="1" stop-color="${t.tentacle}" stop-opacity="0"/>
</linearGradient>
<linearGradient id="arm" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="280">
  <stop offset="0" stop-color="${t.armSoft}" stop-opacity=".95"/>
  <stop offset=".45" stop-color="${t.arm}" stop-opacity=".85"/>
  <stop offset="1" stop-color="${t.arm}" stop-opacity="0"/>
</linearGradient>
<filter id="blur8" filterUnits="userSpaceOnUse" x="-600" y="-600" width="1200" height="1200"><feGaussianBlur stdDeviation="8"/></filter>
<filter id="blur18" filterUnits="userSpaceOnUse" x="-600" y="-600" width="1200" height="1200"><feGaussianBlur stdDeviation="18"/></filter>
<filter id="blur40" filterUnits="userSpaceOnUse" x="-600" y="-600" width="1200" height="1200"><feGaussianBlur stdDeviation="40"/></filter>
<clipPath id="bellClip"><path d="${BELL_PATH}"/></clipPath>`;
}

/** La medusa a todo color, centrada en (0,0); ocupa x ∈ [-262,262], y ∈ [-330,372]. */
function jellyArt(t: Theme, opts: { halo: boolean }): string {
  const tentacles = TENTACLES.map(
    (tn) =>
      `<path d="${tn.d}" fill="none" stroke="url(#tent)" stroke-width="11" stroke-linecap="round"/>`,
  ).join('');
  const tentacleGlow = TENTACLES.map(
    (tn) =>
      `<path d="${tn.d}" fill="none" stroke="url(#tent)" stroke-width="22" stroke-linecap="round"/>`,
  ).join('');
  const beads = TENTACLES.flatMap((tn) => tn.beads.slice(0, 3)).map(
    ([x, y], i) =>
      `<circle cx="${f(x)}" cy="${f(y)}" r="${i % 3 === 2 ? 8 : 11}" fill="${t.bead}"/>`,
  );
  const beadGlow = TENTACLES.flatMap((tn) => tn.beads)
    .map(([x, y]) => `<circle cx="${f(x)}" cy="${f(y)}" r="20" fill="${t.bead}"/>`)
    .join('');
  const arms = ARMS.map(
    (d) =>
      `<path d="${d}" fill="none" stroke="url(#arm)" stroke-width="30" stroke-linecap="round"/>`,
  ).join('');
  const armGlow = ARMS.map(
    (d) =>
      `<path d="${d}" fill="none" stroke="url(#arm)" stroke-width="46" stroke-linecap="round"/>`,
  ).join('');

  return `
${opts.halo ? '<circle cx="0" cy="-30" r="400" fill="url(#halo)"/>' : ''}
<g opacity=".6" filter="url(#blur18)">${tentacleGlow}${armGlow}</g>
${tentacles}
${arms}
<g filter="url(#blur8)" opacity=".9">${beadGlow}</g>
${beads.join('')}
<path d="${BELL_PATH}" fill="${t.bellMid}" opacity=".7" filter="url(#blur40)"/>
<path d="${BELL_PATH}" fill="url(#bell)"/>
<g clip-path="url(#bellClip)">
  <rect x="-270" y="-340" width="540" height="380" fill="url(#core)"/>
  <ellipse cx="0" cy="-118" rx="118" ry="46" fill="#fff" fill-opacity=".1" stroke="#fff" stroke-opacity=".42" stroke-width="7"/>
  <g stroke="#fff" stroke-opacity=".2" stroke-width="5" stroke-linecap="round" fill="none">
    <path d="M0-318C70-250 100-130 92-26"/><path d="M0-318C-70-250-100-130-92-26"/>
    <path d="M-30-312C-140-250-196-140-190-30"/><path d="M30-312C140-250 196-140 190-30"/>
  </g>
  <ellipse cx="-96" cy="-236" rx="86" ry="38" transform="rotate(-38 -96 -236)" fill="#fff" fill-opacity=".55" filter="url(#blur8)"/>
</g>
<path d="${BELL_RIM_PATH}" fill="none" stroke="${t.bellTop}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" opacity=".7" filter="url(#blur8)"/>
<path d="${BELL_RIM_PATH}" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>
<circle cx="-92" cy="-250" r="11" fill="#fff" opacity=".9"/>`;
}

/**
 * Moto de entrega de perfil (caja trasera, asiento, dos ruedas), centrada en (0,0) y de ~190 de ancho.
 * `fill` pinta la moto; `gap` es el color del fondo, que separa la carrocería de las ruedas.
 */
function scooter(fill: string, gap: string): string {
  const stroke = `stroke-linecap="round" stroke-linejoin="round"`;
  return `<g transform="translate(8 4)">
<g fill="none" stroke="${fill}" stroke-width="12" ${stroke}><circle cx="-58" cy="44" r="24"/><circle cx="64" cy="44" r="24"/></g>
<path fill="${fill}" stroke="${gap}" stroke-width="7" ${stroke} d="M-92 6C-92-8-78-12-64-12H0C14-12 26-6 32 6L46 30H-24C-60 30-92 30-92 6Z"/>
<path d="M64 44L46-42M34-48H62" fill="none" stroke="${fill}" stroke-width="13" ${stroke}/>
<g fill="${fill}" stroke="${gap}" stroke-width="6" ${stroke}><rect x="-104" y="-70" width="62" height="50" rx="10"/><rect x="-34" y="-30" width="58" height="16" rx="8"/></g>
</g>`;
}

/** Insignia de reparto: disco coral con anillo oscuro de separación y la moto en blanco. */
function badgeArt(t: Theme): string {
  const { cx, cy, r } = BADGE;
  return `
<g transform="translate(${cx} ${cy})">
  <circle r="${r + 26}" fill="${palette.abyss}"/>
  <circle r="${r + 26}" fill="none" stroke="${t.badge}" stroke-opacity=".5" stroke-width="3"/>
  <circle r="${r}" fill="url(#badge)"/>
  <circle r="${r - 6}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="4"/>
  <g transform="scale(.98)">${scooter('#fff', t.badge)}</g>
</g>`;
}

function badgeDefs(t: Theme): string {
  return `<linearGradient id="badge" gradientUnits="userSpaceOnUse" x1="-90" y1="-130" x2="90" y2="130">
  <stop offset="0" stop-color="${t.badgeSoft}"/><stop offset=".3" stop-color="${t.badge}"/><stop offset="1" stop-color="#E5486B"/>
</linearGradient>`;
}

/** Silueta de un solo color (ícono de notificación y ícono monocromo de Android 13+). */
function silhouetteArt(v: Variant): string {
  // Menos y más finos que en la versión a color: a 24 px los hilos se funden en una mancha.
  const strokes = [TENTACLES[0], TENTACLES[2], TENTACLES[3], TENTACLES[5]]
    .map(
      (tn) =>
        `<path d="${tn!.d}" fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round"/>`,
    )
    .join('');
  const arms = ARMS.slice(0, 2)
    .map(
      (d) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="34" stroke-linecap="round"/>`,
    )
    .join('');
  const { cx, cy, r } = BADGE;
  const jelly = `
<mask id="cut" maskUnits="userSpaceOnUse" x="-600" y="-600" width="1200" height="1200">
  <rect x="-600" y="-600" width="1200" height="1200" fill="#fff"/>
  <path d="M-196-186C-170-250-100-290-30-300" fill="none" stroke="#000" stroke-width="30" stroke-linecap="round"/>
  <ellipse cx="0" cy="-118" rx="112" ry="40" fill="none" stroke="#000" stroke-width="24"/>
  ${v === 'driver' ? `<circle cx="${cx}" cy="${cy}" r="${r + 40}" fill="#000"/>` : ''}
</mask>
<g mask="url(#cut)" fill="#fff">
  <path d="${BELL_PATH}"/>${strokes}${arms}
</g>`;
  if (v === 'customer') return jelly;
  return `${jelly}
<mask id="moto" maskUnits="userSpaceOnUse" x="-600" y="-600" width="1200" height="1200">
  <rect x="-600" y="-600" width="1200" height="1200" fill="#fff"/>
  <g transform="translate(${cx} ${cy}) scale(.98)">${scooter('#000', '#fff')}</g>
</mask>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" mask="url(#moto)"/>`;
}

/** Nieve marina: puntos de luz tenues, repartidos con una semilla fija (el resultado no cambia). */
function marineSnow(): string {
  let s = 0x9e3779b9;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const dots: string[] = [];
  while (dots.length < 26) {
    const x = rnd() * 1024;
    const y = rnd() * 1024;
    const dx = x - 512;
    const dy = y - 512;
    // lejos de la medusa para no ensuciar su silueta
    if (Math.hypot(dx / 330, (dy - 40) / 410) < 1.02) continue;
    const r = 2.5 + rnd() * 5;
    dots.push(
      `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${palette.cyanSoft}" opacity="${f(0.18 + rnd() * 0.3)}"/>`,
    );
  }
  return dots.join('');
}

function backdrop(t: Theme): string {
  return `
<radialGradient id="bg" gradientUnits="userSpaceOnUse" cx="512" cy="420" r="760">
  <stop offset="0" stop-color="${palette.tide}"/>
  <stop offset=".42" stop-color="${palette.ocean}"/>
  <stop offset=".78" stop-color="${palette.deep}"/>
  <stop offset="1" stop-color="${palette.abyss}"/>
</radialGradient>
<radialGradient id="bgGlow" gradientUnits="userSpaceOnUse" cx="512" cy="470" r="560">
  <stop offset="0" stop-color="${t.bgGlow}" stop-opacity="${t.bgGlowOpacity}"/>
  <stop offset="1" stop-color="${t.bgGlow}" stop-opacity="0"/>
</radialGradient>
<linearGradient id="ray" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="700">
  <stop offset="0" stop-color="#fff" stop-opacity=".09"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
</linearGradient>`;
}

interface Scene {
  /** Lado del PNG resultante. */
  size: number;
  /** Fondo: 'full' = cuadrado opaco; 'round' = cuadrado redondeado; 'none' = transparente. */
  bg: 'full' | 'round' | 'none';
  /** Escala de la medusa respecto al sistema local (1 ≈ ocupa ~70 % del lienzo). */
  scale: number;
  /** Desplazamiento (en el sistema de 1024) del centro de la composición. */
  dx?: number;
  dy?: number;
  halo?: boolean;
  snow?: boolean;
  badge?: boolean;
  mode?: 'color' | 'silhouette';
}

function svgFor(v: Variant, sc: Scene): string {
  const t = THEMES[v];
  const showBadge = (sc.badge ?? true) && v === 'driver';
  const bg =
    sc.bg === 'none'
      ? ''
      : `<rect width="1024" height="1024" ${sc.bg === 'round' ? 'rx="228"' : ''} fill="url(#bg)"/>
<rect width="1024" height="1024" ${sc.bg === 'round' ? 'rx="228"' : ''} fill="url(#bgGlow)"/>
<g opacity=".8"><path d="M300 0H430L560 700H330Z" fill="url(#ray)"/><path d="M600 0H690L860 640H700Z" fill="url(#ray)" opacity=".7"/></g>
${sc.snow ? marineSnow() : ''}`;
  const inner =
    sc.mode === 'silhouette'
      ? silhouetteArt(v)
      : `${jellyArt(t, { halo: sc.halo ?? true })}${showBadge ? badgeArt(t) : ''}`;
  const tx = 512 + (sc.dx ?? 0);
  const ty = 512 + (sc.dy ?? 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sc.size}" height="${sc.size}" viewBox="0 0 1024 1024">
<defs>${backdrop(t)}${jellyDefs(t)}${badgeDefs(t)}</defs>
${bg}
<g transform="translate(${tx} ${ty}) scale(${sc.scale})">${inner}</g>
</svg>`;
}

/* ─────────────────────────────── Lista de archivos ─────────────────────────────── */

export interface AssetSpec {
  file: string;
  size: number;
  /** false = PNG opaco sin canal alfa (obligatorio para el ícono de iOS). */
  alpha: boolean;
  scene: (v: Variant) => Scene;
  /** Todo lo visible debe caber en el círculo seguro de Android (66 %). */
  safeZone?: boolean;
  /** Solo blanco sobre transparente. */
  whiteOnly?: boolean;
}

/** La insignia carga el peso a la derecha: se corre el conjunto para que la caja quede centrada. */
const driverShift = (v: Variant) => (v === 'driver' ? -22 : 0);

/** Escala que deja el contenido (insignia incluida) dentro del círculo seguro del 66 %. */
const safeScale = (v: Variant) => (v === 'driver' ? 0.74 : 0.83);

export const ASSETS: readonly AssetSpec[] = [
  {
    file: 'icon.png',
    size: 1024,
    alpha: false,
    scene: (v) => ({
      size: 1024,
      bg: 'full',
      scale: v === 'driver' ? 0.98 : 1.04,
      dx: v === 'driver' ? -14 : 0,
      dy: -14,
      snow: true,
    }),
  },
  {
    file: 'adaptive-icon.png',
    size: 1024,
    alpha: true,
    safeZone: true,
    scene: (v) => ({
      size: 1024,
      bg: 'none',
      scale: safeScale(v),
      dx: driverShift(v),
      dy: -8,
    }),
  },
  {
    file: 'adaptive-icon-monochrome.png',
    size: 1024,
    alpha: true,
    safeZone: true,
    whiteOnly: true,
    scene: (v) => ({
      size: 1024,
      bg: 'none',
      scale: safeScale(v),
      dx: driverShift(v),
      dy: -8,
      mode: 'silhouette',
    }),
  },
  {
    file: 'splash-icon.png',
    size: 1024,
    alpha: true,
    safeZone: true,
    scene: (v) => ({
      size: 1024,
      bg: 'none',
      scale: safeScale(v),
      dx: driverShift(v),
      dy: -8,
    }),
  },
  {
    file: 'notification-icon.png',
    size: 96,
    alpha: true,
    whiteOnly: true,
    scene: (v) => ({
      size: 96,
      bg: 'none',
      scale: 1.18,
      dx: driverShift(v),
      dy: -14,
      mode: 'silhouette',
    }),
  },
  {
    file: 'favicon.png',
    size: 192,
    alpha: true,
    scene: (v) => ({
      size: 192,
      bg: 'round',
      scale: v === 'driver' ? 1.0 : 1.08,
      dx: v === 'driver' ? -14 : 0,
      dy: -14,
    }),
  },
];

/** Colores sobre los que se aplana el ícono de iOS si Chromium dejara algún píxel translúcido. */
const ICON_FLATTEN_BG: [number, number, number] = [0x05, 0x0b, 0x1f];

/* ──────────────────────────────── Renderizado ──────────────────────────────── */

async function render(
  page: import('playwright-core').Page,
  svg: string,
  size: number,
): Promise<Raster> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
  );
  const png = await page.screenshot({ omitBackground: true, type: 'png' });
  return decodePng(png);
}

async function generate(opts: { preview: boolean }): Promise<void> {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const written = new Map<string, Buffer>();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const v of VARIANTS) {
      for (const a of ASSETS) {
        let img = await render(page, svgFor(v, a.scene(v)), a.size);
        if (!a.alpha) img = flatten(img, ICON_FLATTEN_BG);
        const out = resolve(root, 'apps', v, 'assets', a.file);
        mkdirSync(dirname(out), { recursive: true });
        const buf = encodePng(img);
        writeFileSync(out, buf);
        written.set(`${v}/${a.file}`, buf);
        console.log(
          `• ${v}/assets/${a.file}  ${a.size}×${a.size}  ${(buf.length / 1024).toFixed(0)} KB`,
        );
      }
    }
    if (opts.preview) await contactSheet(page, written);
  } finally {
    await browser.close();
  }
}

/** Hoja de contactos para revisar a ojo: ícono en varios tamaños, máscaras de iOS/Android y notificación. */
async function contactSheet(page: import('playwright-core').Page, files: Map<string, Buffer>) {
  const uri = (k: string) => `data:image/png;base64,${files.get(k)!.toString('base64')}`;
  const row = (v: Variant) => {
    const icon = uri(`${v}/icon.png`);
    const fg = uri(`${v}/adaptive-icon.png`);
    const mono = uri(`${v}/adaptive-icon-monochrome.png`);
    const noti = uri(`${v}/notification-icon.png`);
    const splash = uri(`${v}/splash-icon.png`);
    const fav = uri(`${v}/favicon.png`);
    const sizes = [180, 120, 87, 58, 29]
      .map((s) => `<img src="${icon}" width="${s}" height="${s}" style="border-radius:22.37%">`)
      .join('');
    const adaptive = (shape: string, s: number) =>
      `<div style="width:${s}px;height:${s}px;background:${palette.deep};${shape};overflow:hidden;position:relative"><img src="${fg}" style="position:absolute;left:${-s * 0.2}px;top:${-s * 0.2}px;width:${s * 1.4}px;height:${s * 1.4}px"></div>`;
    const monoTile = (bg: string, s: number) =>
      `<div style="width:${s}px;height:${s}px;background:${bg};border-radius:50%;overflow:hidden;position:relative"><img src="${mono}" style="position:absolute;left:${-s * 0.2}px;top:${-s * 0.2}px;width:${s * 1.4}px;height:${s * 1.4}px;filter:invert(1) brightness(.4)"></div>`;
    return `<section><h2>${v}</h2>
<div class="r">${sizes}<img src="${icon}" width="256" style="border-radius:22.37%"></div>
<div class="r">${adaptive('border-radius:50%', 108)}${adaptive('border-radius:30%', 108)}${adaptive('border-radius:50%', 48)}${monoTile('#cfe8ee', 108)}
<div style="background:#c9ced8;padding:10px"><img src="${noti}" width="96"></div>
<div style="background:#777;padding:10px"><img src="${noti}" width="48"></div>
<div style="background:#777;padding:10px"><img src="${noti}" width="24"></div>
<div style="background:#050B1F;padding:10px"><img src="${splash}" width="200"></div>
<img src="${fav}" width="64"><img src="${fav}" width="32"><img src="${fav}" width="16"></div></section>`;
  };
  await page.setViewportSize({ width: 1320, height: 1000 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#1d2433;font:14px sans-serif;color:#fff}
h2{margin:0 0 8px;font-size:14px;text-transform:uppercase;opacity:.6}
section{margin-bottom:24px}.r{display:flex;gap:16px;align-items:center;margin-bottom:14px}</style>
${VARIANTS.map(row).join('')}`);
  const out = resolve(root, 'tmp', 'brand-preview.png');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await page.screenshot({ fullPage: true }));
  console.log(`• hoja de contactos: ${out}`);
}

/* ──────────────────────────────── Validación ──────────────────────────────── */

const px = (img: Raster, i: number) => i * img.channels;

/** Mayor distancia (px) al centro de cualquier píxel con alfa ≥ umbral; y el centro de su caja. */
export function alphaExtent(img: Raster, threshold = 16) {
  let maxR = 0;
  let minX = img.width;
  let maxX = -1;
  let minY = img.height;
  let maxY = -1;
  let count = 0;
  const cx = img.width / 2;
  const cy = img.height / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = img.channels === 4 ? (img.data[px(img, y * img.width + x) + 3] as number) : 255;
      if (a < threshold) continue;
      count++;
      maxR = Math.max(maxR, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    maxR,
    count,
    coverage: count / (img.width * img.height),
    centerX: (minX + maxX + 1) / 2,
    centerY: (minY + maxY + 1) / 2,
  };
}

/** Reduce con promedio de caja (lo que ve el ojo a 29 px) y devuelve la luminancia por píxel. */
function lumaAt(img: Raster, size: number): number[] {
  const out: number[] = [];
  const k = img.width / size;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(oy * k); y < Math.floor((oy + 1) * k); y++) {
        for (let x = Math.floor(ox * k); x < Math.floor((ox + 1) * k); x++) {
          const i = px(img, y * img.width + x);
          const a = img.channels === 4 ? (img.data[i + 3] as number) / 255 : 1;
          sum +=
            (0.2126 * (img.data[i] as number) +
              0.7152 * (img.data[i + 1] as number) +
              0.0722 * (img.data[i + 2] as number)) *
            a;
          n++;
        }
      }
      out.push(sum / n);
    }
  }
  return out;
}

function meanRgb(img: Raster): [number, number, number] {
  const s = [0, 0, 0];
  const n = img.width * img.height;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) s[k]! += img.data[px(img, i) + k] as number;
  return [s[0]! / n, s[1]! / n, s[2]! / n];
}

/** Devuelve la lista de problemas encontrados (vacía = todo bien). */
export function checkAssets(dir = (v: Variant) => resolve(root, 'apps', v, 'assets')): string[] {
  const problems: string[] = [];
  const decoded = new Map<string, Raster>();
  for (const v of VARIANTS) {
    for (const a of ASSETS) {
      const tag = `${v}/${a.file}`;
      let img: Raster;
      try {
        img = decodePng(readFileSync(resolve(dir(v), a.file)));
      } catch (e) {
        problems.push(`${tag}: no se pudo leer (${(e as Error).message})`);
        continue;
      }
      decoded.set(tag, img);
      if (img.width !== a.size || img.height !== a.size) {
        problems.push(`${tag}: mide ${img.width}×${img.height}, debe medir ${a.size}×${a.size}`);
      }
      if (!a.alpha && img.channels !== 3) {
        problems.push(`${tag}: tiene canal alfa; App Store rechaza íconos con transparencia`);
      }
      if (a.alpha && img.channels !== 4) problems.push(`${tag}: debe tener canal alfa`);
      if (img.channels === 4) {
        const ext = alphaExtent(img);
        if (ext.coverage < 0.04)
          problems.push(`${tag}: casi vacío (${(ext.coverage * 100).toFixed(1)} % cubierto)`);
        if (a.safeZone) {
          const limit = img.width * 0.33 + img.width * 0.006;
          if (ext.maxR > limit) {
            problems.push(
              `${tag}: el dibujo sale de la zona segura de Android (radio ${ext.maxR.toFixed(0)} px > ${limit.toFixed(0)} px)`,
            );
          }
          if (
            Math.abs(ext.centerX - img.width / 2) > img.width * 0.03 ||
            Math.abs(ext.centerY - img.height / 2) > img.width * 0.04
          ) {
            problems.push(
              `${tag}: el dibujo no está centrado (centro ${ext.centerX.toFixed(0)},${ext.centerY.toFixed(0)})`,
            );
          }
        }
        if (a.whiteOnly) {
          let bad = 0;
          let transparent = 0;
          for (let i = 0; i < img.width * img.height; i++) {
            const al = img.data[i * 4 + 3] as number;
            if (al === 0) transparent++;
            else if (
              al >= 16 &&
              ((img.data[i * 4] as number) < 245 ||
                (img.data[i * 4 + 1] as number) < 245 ||
                (img.data[i * 4 + 2] as number) < 245)
            )
              bad++;
          }
          if (bad > 0)
            problems.push(`${tag}: ${bad} píxeles no son blancos (Android solo usa el alfa)`);
          if (transparent < img.width * img.height * 0.25)
            problems.push(`${tag}: casi no tiene transparencia`);
        }
      }
      if (a.file === 'icon.png') {
        // A 29 px (Spotlight/Ajustes) debe seguir leyéndose algo: contraste claro entre medusa y fondo.
        const l = lumaAt(img, 29);
        const spread = Math.max(...l) - Math.min(...l);
        if (spread < 90)
          problems.push(`${tag}: a 29 px el contraste es muy bajo (${spread.toFixed(0)} de 255)`);
      }
    }
  }
  // El repartidor debe distinguirse del cliente a simple vista.
  const ci = decoded.get('customer/icon.png');
  const di = decoded.get('driver/icon.png');
  if (ci && di && ci.width === di.width) {
    const a = meanRgb(ci);
    const b = meanRgb(di);
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (dist < 18)
      problems.push(
        `Los íconos de cliente y repartidor se parecen demasiado (distancia de color ${dist.toFixed(0)})`,
      );
    // y la insignia del repartidor debe ocupar su esquina inferior derecha (coral claro sobre fondo oscuro)
    const corner = (img: Raster) => {
      let warm = 0;
      for (let y = 640; y < 900; y++) {
        for (let x = 640; x < 900; x++) {
          const i = px(img, y * img.width + x);
          if ((img.data[i] as number) > 200 && (img.data[i + 1] as number) < 150) warm++;
        }
      }
      return warm;
    };
    if (corner(di) < 8000)
      problems.push('driver/icon.png: falta la insignia de moto en la esquina inferior derecha');
    if (corner(ci) > 2000)
      problems.push('customer/icon.png: no debería llevar la insignia de repartidor');
  }
  return problems;
}

/* ─────────────────────────────────── CLI ─────────────────────────────────── */

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--check')) {
    const problems = checkAssets();
    if (problems.length) {
      console.error(problems.map((p) => `✗ ${p}`).join('\n'));
      process.exit(1);
    }
    console.log(`✓ ${VARIANTS.length * ASSETS.length} archivos de marca válidos`);
    return;
  }
  await generate({ preview: args.has('--preview') });
  const problems = checkAssets();
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join('\n'));
    process.exit(1);
  }
  console.log('✓ validación de marca OK');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
