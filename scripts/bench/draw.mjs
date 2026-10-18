// Shared drawing helpers for the synthetic generators: a seeded RNG, a tiny
// grayscale raster with line art primitives, PNG encoding, and the scan-like
// degradation recipes. Used by scripts/generate-synthetic-dataset.mjs (the
// detector training set) and scripts/scaled-drawing-bench.mjs (the measurement
// benchmark). Pure Node, no dependencies beyond built-in zlib.
//
// Every function that draws random numbers takes the caller's rng helpers
// (see rngHelpers) so each generator keeps its own deterministic sequence.

import { deflateSync } from 'node:zlib';

// ---------- seeded RNG ----------
export function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** rng in [0,1) plus rand(lo, hi), randInt(lo, hi) inclusive, pick(array), all on one seeded stream. */
export function rngHelpers(seed) {
  const rng = mulberry32(seed);
  const rand = (lo, hi) => lo + rng() * (hi - lo);
  const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  return { rng, rand, randInt, pick };
}

// ---------- tiny raster renderer (grayscale, black ink on white) ----------
export class Raster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h).fill(255);
  }
  put(x, y, v) {
    x |= 0;
    y |= 0;
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = v;
  }
  brush(x, y, v, size) {
    if (size <= 1) this.put(x, y, v);
    else {
      const r = (size - 1) / 2;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.put(x + dx, y + dy, v);
    }
  }
  line(x0, y0, x1, y1, v, thick = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.brush(x0, y0, v, thick);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
  rect(x, y, w, h, v, thick = 1) {
    this.line(x, y, x + w, y, v, thick);
    this.line(x, y + h, x + w, y + h, v, thick);
    this.line(x, y, x, y + h, v, thick);
    this.line(x + w, y, x + w, y + h, v, thick);
  }
  circle(cx, cy, r, v, thick = 1) {
    let x = r, y = 0, err = 1 - r;
    while (x >= y) {
      for (const [px, py] of [[cx + x, cy + y], [cx + y, cy + x], [cx - y, cy + x], [cx - x, cy + y], [cx - x, cy - y], [cx - y, cy - x], [cx + y, cy - x], [cx + x, cy - y]]) {
        this.brush(px, py, v, thick);
      }
      y++;
      if (err < 0) err += 2 * y + 1;
      else { x--; err += 2 * (y - x) + 1; }
    }
  }
  fillTriangle(x0, y0, x1, y1, x2, y2, v) {
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = minY; y <= maxY; y++) {
      let xa = Infinity, xb = -Infinity;
      for (const [ax, ay, bx, by] of [[x0, y0, x1, y1], [x1, y1, x2, y2], [x2, y2, x0, y0]]) {
        if ((ay <= y && by > y) || (by <= y && ay > y)) {
          const t = (y - ay) / (by - ay);
          const x = ax + t * (bx - ax);
          if (x < xa) xa = x;
          if (x > xb) xb = x;
        }
      }
      for (let x = Math.max(0, Math.floor(xa)); x <= Math.min(this.w - 1, Math.ceil(xb)); x++) this.put(x, y, v);
    }
  }
}

/** A Raster holding the luma of an RGBA buffer (row-major, top-left origin). */
export function rasterFromRGBA(width, height, data) {
  const r = new Raster(width, height);
  for (let i = 0, p = 0; i < r.px.length; i++, p += 4) {
    r.px[i] = Math.round((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000);
  }
  return r;
}

// ---------- PNG encoding (RGB, filter 0, built-in zlib) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function encodePNG(raster) {
  const { w, h, px } = raster;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter none
    for (let x = 0; x < w; x++) {
      const v = px[y * w + x];
      raw[row + 1 + x * 3] = v;
      raw[row + 2 + x * 3] = v;
      raw[row + 3 + x * 3] = v;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- degradation (SESYD-style scan simulation) ----------
// One recipe per sheet, chosen by the caller's seeded RNG. The photocopy
// recipe is a deliberate composite (edge shadow + contrast + dust); everything
// else is a single artifact so a detector can attribute its errors.

export function boxBlur(r, radius) {
  const { w, h, px } = r;
  for (let pass = 0; pass < 2; pass++) {
    const src = Uint8Array.from(px);
    const div = 2 * radius + 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const row = yy * w;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            sum += src[row + xx];
          }
        }
        px[y * w + x] = Math.round(sum / (div * div));
      }
    }
  }
}

export function speckle(r, density, dark, R) {
  const { w, h, px } = r;
  const n = Math.round(w * h * density);
  for (let i = 0; i < n; i++) {
    const x = Math.floor(R.rng() * w);
    const y = Math.floor(R.rng() * h);
    px[y * w + x] = dark ? R.randInt(0, 70) : R.randInt(200, 255);
  }
}

export function contrast(r, k, bias) {
  for (let i = 0; i < r.px.length; i++) {
    const v = 128 + (r.px[i] - 128) * k + bias;
    r.px[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
}

export function edgeShadow(r, R) {
  const { w, h, px } = r;
  const side = R.randInt(0, 3); // top / right / bottom / left
  const band = R.randInt(50, 110);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = side === 0 ? y : side === 1 ? w - 1 - x : side === 2 ? h - 1 - y : x;
      if (d >= band) continue;
      px[y * w + x] = Math.round(px[y * w + x] * (0.72 + 0.28 * (d / band)));
    }
  }
}

/** Rotate about the sheet centre and remap the label boxes to match. */
export function rotateSheet(r, deg, labels) {
  const { w, h } = r;
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const cx0 = w / 2, cy0 = h / 2;
  const src = Uint8Array.from(r.px);
  r.px.fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // destination <- source (inverse of the label-space forward map)
      const dx = x - cx0, dy = y - cy0;
      const sx = Math.round(cos * dx + sin * dy + cx0);
      const sy = Math.round(-sin * dx + cos * dy + cy0);
      if (sx >= 0 && sy >= 0 && sx < w && sy < h) r.px[y * w + x] = src[sy * w + sx];
    }
  }
  const fwd = (x, y) => ({
    x: cos * (x - cx0) - sin * (y - cy0) + cx0,
    y: sin * (x - cx0) + cos * (y - cy0) + cy0,
  });
  for (const l of labels) {
    const { x, y, w: bw, h: bh } = l.box;
    const pts = [fwd(x, y), fwd(x + bw, y), fwd(x, y + bh), fwd(x + bw, y + bh)];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    l.box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
}

export const RECIPES = ['blur', 'noise', 'contrast', 'rotate', 'photocopy'];

/**
 * Apply one recipe picked by R.pick (or opts.recipe) and return its name.
 * opts.skew() supplies the rotation angle in degrees for the rotate recipe
 * (default: a slight skew within 0.6 degrees either way).
 */
export function degradeSheet(r, labels, R, opts = {}) {
  const recipe = opts.recipe ?? R.pick(RECIPES);
  switch (recipe) {
    case 'blur':
      boxBlur(r, 1);
      break;
    case 'noise':
      speckle(r, R.rand(0.004, 0.02), true, R);
      speckle(r, R.rand(0.001, 0.004), false, R);
      break;
    case 'contrast':
      contrast(r, R.rand(0.6, 1.6), R.rand(-16, 16));
      break;
    case 'rotate':
      rotateSheet(r, opts.skew ? opts.skew() : R.rand(-0.6, 0.6), labels);
      break;
    case 'photocopy':
      edgeShadow(r, R);
      contrast(r, R.rand(1.1, 1.5), R.rand(-8, 8));
      speckle(r, R.rand(0.002, 0.008), true, R);
      break;
  }
  return recipe;
}

/** Shoelace area of a polygon (any units). */
export function polyArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Perimeter of a closed polygon. */
export function polyPerimeter(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    s += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return s;
}
