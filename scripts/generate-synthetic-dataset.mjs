// Synthetic training-set generator for the pdf2takeoff detector.
// Produces randomised construction-style sheets as PNGs with pixel-perfect
// YOLO-format labels — no labelling, no dependencies (pure Node + built-in
// zlib for PNG encoding, a tiny raster renderer for line art).
//
//   node scripts/generate-synthetic-dataset.mjs --count 200 --seed 42 [--debug]
//
// Output (gitignored; regenerate on demand or inside the training notebook):
//   training/synthetic/images/{train,val}/sheet-NNNN.png
//   training/synthetic/labels/{train,val}/sheet-NNNN.txt   (YOLO: cls cx cy w h, normalised)
//   training/synthetic/dataset.yaml
//   training/synthetic/debug/overlay-NNNN.png              (--debug: labels drawn as boxes)

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const COUNT = Number(arg('count', 200));
const SEED = Number(arg('seed', 42));
const VAL_FRAC = Number(arg('val-frac', 0.15));
const DEBUG = args.includes('--debug');
const OUT = join(ROOT, 'training', 'synthetic');

const CLASSES = ['downlight', 'gpo', 'switch', 'smoke', 'diffuser'];
const W = 1280;
const H = 905; // ~A4 landscape aspect

// ---------- seeded RNG ----------
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const rand = (lo, hi) => lo + rng() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

// ---------- tiny raster renderer (grayscale, black ink on white) ----------
class Raster {
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
function encodePNG(raster) {
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

// ---------- symbol drawing + label recording ----------
function drawSymbol(r, cls, cx, cy, size, ink, thick) {
  // returns the label bbox (pixel coords)
  const s = size; // half-extent
  switch (cls) {
    case 0: // downlight: circle + cross
      r.circle(cx, cy, s, ink, thick);
      r.line(cx - s * 0.5, cy, cx + s * 0.5, cy, ink, 1);
      r.line(cx, cy - s * 0.5, cx, cy + s * 0.5, ink, 1);
      break;
    case 1: // gpo: rectangle + inner dot
      r.rect(cx - s, cy - s * 0.7, 2 * s, 1.4 * s, ink, thick);
      r.circle(cx, cy, Math.max(2, s * 0.2), ink, 1);
      break;
    case 2: // switch: filled triangle
      r.fillTriangle(cx - s, cy + s * 0.8, cx + s, cy + s * 0.8, cx, cy - s, ink);
      break;
    case 3: // smoke detector: circle + solid centre
      r.circle(cx, cy, s, ink, thick);
      r.circle(cx, cy, Math.max(2, s * 0.3), ink, 99);
      break;
    case 4: // diffuser: square + diagonals
      r.rect(cx - s * 0.85, cy - s * 0.85, 1.7 * s, 1.7 * s, ink, thick);
      r.line(cx - s * 0.6, cy - s * 0.6, cx + s * 0.6, cy + s * 0.6, ink, 1);
      r.line(cx + s * 0.6, cy - s * 0.6, cx - s * 0.6, cy + s * 0.6, ink, 1);
      break;
  }
  const pad = 3;
  return { x: cx - s - pad, y: cy - s - pad, w: 2 * (s + pad), h: 2 * (s + pad) };
}

// ---------- sheet composition ----------
function generateSheet(index) {
  const r = new Raster(W, H);
  const labels = [];

  const wallInk = randInt(25, 60);
  const lineInk = randInt(35, 80);
  const thick = randInt(2, 3);
  const gridV = randInt(205, 235);
  const gridStep = randInt(40, 64);

  // faint grid
  for (let x = gridStep; x < W; x += gridStep) r.line(x, 0, x, H, gridV, 1);
  for (let y = gridStep; y < H; y += gridStep) r.line(0, y, W, y, gridV, 1);

  // building
  const mx = randInt(70, 110);
  const my = randInt(70, 110);
  const bx = mx, by = my, bw = W - 2 * mx - randInt(0, 40), bh = H - 2 * my - randInt(0, 40);
  r.rect(bx, by, bw, bh, wallInk, thick + 1);

  // interior walls with door gaps
  const vWalls = randInt(1, 3);
  const wallXs = [];
  for (let i = 0; i < vWalls; i++) {
    const wx = Math.round(bx + ((i + 1) * bw) / (vWalls + 1) + rand(-30, 30));
    wallXs.push(wx);
    const gapY = rand(by + 40, by + bh - 140);
    r.line(wx, by, wx, gapY, wallInk, thick);
    r.line(wx, gapY + 100, wx, by + bh, wallInk, thick);
  }

  // dimension lines (clutter, outside the building)
  const dimY = by - randInt(18, 34);
  r.line(bx, dimY, bx + bw, dimY, lineInk, 1);
  for (const x of [bx, bx + bw]) r.line(x - 6, dimY + 6, x + 6, dimY - 6, lineInk, 1);

  // title block (clutter, bottom-right)
  const tbW = randInt(180, 260), tbH = randInt(46, 70);
  r.rect(W - tbW - 30, H - tbH - 24, tbW, tbH, wallInk, 1);
  r.line(W - tbW - 30, H - tbH - 24 + 18, W - 30, H - tbH - 24 + 18, wallInk, 1);
  for (let i = 0; i < 6; i++) {
    const yy = H - tbH - 24 + 24 + i * 6;
    r.line(W - tbW - 24, yy, W - tbW + 60 + i * 18, yy, lineInk, 1);
  }

  // symbols: rejection-sample inside the building, clear of walls and each other
  const target = randInt(14, 42);
  const placed = [];
  let attempts = 0;
  while (placed.length < target && attempts < 900) {
    attempts++;
    const cls = randInt(0, CLASSES.length - 1);
    const s = Math.round(rand(9, 21)); // half-extent px
    const cx = rand(bx + 24, bx + bw - 24);
    const cy = rand(by + 24, by + bh - 24);
    if (wallXs.some((wx) => Math.abs(cx - wx) < s + 14)) continue;
    if (placed.some((p) => Math.hypot(p.cx - cx, p.cy - cy) < p.s + s + 12)) continue;
    placed.push({ cls, cx, cy, s });
    const ink = randInt(20, 70);
    const box = drawSymbol(r, cls, cx, cy, s, ink, randInt(1, 2));
    labels.push(`${cls} ${(box.x + box.w / 2) / W} ${(box.y + box.h / 2) / H} ${box.w / W} ${box.h / H}`);
  }

  return { png: encodePNG(r), labels, raster: r, placed };
}

// ---------- debug overlay ----------
function drawOverlay(sheet) {
  const r = new Raster(W, H);
  r.px.set(sheet.raster.px);
  for (const p of sheet.placed) {
    const box = { x: p.cx - p.s - 3, y: p.cy - p.s - 3, w: 2 * (p.s + 3), h: 2 * (p.s + 3) };
    // red-ish box (grayscale renderer → draw in mid-gray dashes)
    const v = 120;
    r.line(box.x, box.y, box.x + box.w, box.y, v, 1);
    r.line(box.x, box.y + box.h, box.x + box.w, box.y + box.h, v, 1);
    r.line(box.x, box.y, box.x, box.y + box.h, v, 1);
    r.line(box.x + box.w, box.y, box.x + box.w, box.y + box.h, v, 1);
  }
  return encodePNG(r);
}

// ---------- main ----------
const trainDirI = join(OUT, 'images', 'train');
const valDirI = join(OUT, 'images', 'val');
const trainDirL = join(OUT, 'labels', 'train');
const valDirL = join(OUT, 'labels', 'val');
for (const d of [trainDirI, valDirI, trainDirL, valDirL, join(OUT, 'debug')]) {
  mkdirSync(d, { recursive: true });
}

let nTrain = 0;
let nVal = 0;
let nSymbols = 0;
for (let i = 0; i < COUNT; i++) {
  const sheet = generateSheet(i);
  nSymbols += sheet.labels.length;
  const isVal = rng() < VAL_FRAC;
  const dirI = isVal ? valDirI : trainDirI;
  const dirL = isVal ? valDirL : trainDirL;
  const name = `sheet-${String(i).padStart(4, '0')}`;
  writeFileSync(join(dirI, `${name}.png`), sheet.png);
  writeFileSync(join(dirL, `${name}.txt`), sheet.labels.join('\n') + '\n');
  if (isVal) nVal++;
  else nTrain++;
  if (DEBUG && i < 5) writeFileSync(join(OUT, 'debug', `overlay-${name}.png`), drawOverlay(sheet));
}

writeFileSync(
  join(OUT, 'dataset.yaml'),
  `# generated by scripts/generate-synthetic-dataset.mjs — do not edit
path: .
train: images/train
val: images/val
names:
${CLASSES.map((c, idx) => `  ${idx}: ${c}`).join('\n')}
`,
);

console.log(
  `generated ${COUNT} sheets (${nTrain} train / ${nVal} val), ${nSymbols} labelled symbols → ${OUT}`,
);
