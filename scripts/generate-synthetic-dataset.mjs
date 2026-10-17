// Synthetic training-set generator for the pdf2takeoff detector.
// Produces randomised construction-style sheets as PNGs with pixel-perfect
// YOLO-format labels — no labelling, no dependencies (pure Node + built-in
// zlib for PNG encoding, a tiny raster renderer for line art).
//
//   node scripts/generate-synthetic-dataset.mjs --count 200 --seed 42 [--debug] [--degrade 0.5]
//
// Output (gitignored; regenerate on demand or inside the training notebook):
//   training/synthetic/images/{train,val}/sheet-NNNN.png
//   training/synthetic/labels/{train,val}/sheet-NNNN.txt   (YOLO: cls cx cy w h, normalised)
//   training/synthetic/dataset.yaml
//   training/synthetic/debug/overlay-NNNN.png              (--debug: labels drawn as boxes)
//
// Sheets mix two regimes: crisp vector-style art and scan-like degraded art
// (--degrade sets the fraction, one recipe per sheet — blur, speckle,
// contrast, slight rotation, photocopy — never stacked, so the detector
// meets each artifact in isolation). A quota of symbols is parked on wall
// lines so the detector trains on symbols touching linework, the declared
// blind spot of the tier-1 CV scan.

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
const DEGRADE = Number(arg('degrade', 0.5));
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
  const wallGaps = []; // { wx, y0, y1 } — the doorway opening in each wall
  for (let i = 0; i < vWalls; i++) {
    const wx = Math.round(bx + ((i + 1) * bw) / (vWalls + 1) + rand(-30, 30));
    wallXs.push(wx);
    const gapY = rand(by + 40, by + bh - 140);
    wallGaps.push({ wx, y0: gapY, y1: gapY + 100 });
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

  // symbols: a quota parks on wall lines (ink crossing the bbox — the tier-1
  // CV scan's blind spot and a reason tier-2 exists), the rest are placed
  // clear of walls and each other as before
  const target = randInt(14, 42);
  const overlapQuota = Math.min(Math.floor(target * rand(0.15, 0.35)), 10);
  const walls = [
    { wx: bx, gap: null },
    { wx: bx + bw, gap: null },
    ...wallGaps.map((g) => ({ wx: g.wx, gap: g })),
  ];
  const placed = [];
  let attempts = 0;
  const tryPlace = (mayTouchWall) => {
    const cls = randInt(0, CLASSES.length - 1);
    const s = Math.round(rand(9, 21)); // half-extent px
    let cx, cy;
    if (mayTouchWall) {
      const w = pick(walls);
      cx = w.wx + rand(-6, 6);
      let ok = false;
      for (let t = 0; t < 40 && !ok; t++) {
        cy = rand(by + 24, by + bh - 24);
        ok = !(w.gap && cy > w.gap.y0 - 24 && cy < w.gap.y1 + 24); // not floating in the doorway
      }
      if (!ok) return null;
    } else {
      cx = rand(bx + 24, bx + bw - 24);
      cy = rand(by + 24, by + bh - 24);
      if (wallXs.some((wx) => Math.abs(cx - wx) < s + 14)) return null;
    }
    if (placed.some((p) => Math.hypot(p.cx - cx, p.cy - cy) < p.s + s + 12)) return null;
    return { cls, cx, cy, s };
  };
  while (placed.length < target && attempts < 1200) {
    attempts++;
    const p = tryPlace(placed.length < overlapQuota);
    if (!p) continue;
    placed.push(p);
    const ink = randInt(20, 70);
    const box = drawSymbol(r, p.cls, p.cx, p.cy, p.s, ink, randInt(1, 2));
    labels.push({ cls: p.cls, box });
  }

  return { raster: r, labels, placed };
}

// ---------- degradation (SESYD-style scan simulation) ----------
// One recipe per sheet, chosen by the seeded RNG. The photocopy recipe is a
// deliberate composite (edge shadow + contrast + dust); everything else is a
// single artifact so the detector can attribute its errors.

function boxBlur(r, radius) {
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

function speckle(r, density, dark) {
  const { w, h, px } = r;
  const n = Math.round(w * h * density);
  for (let i = 0; i < n; i++) {
    const x = Math.floor(rng() * w);
    const y = Math.floor(rng() * h);
    px[y * w + x] = dark ? randInt(0, 70) : randInt(200, 255);
  }
}

function contrast(r, k, bias) {
  for (let i = 0; i < r.px.length; i++) {
    const v = 128 + (r.px[i] - 128) * k + bias;
    r.px[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
}

function edgeShadow(r) {
  const { w, h, px } = r;
  const side = randInt(0, 3); // top / right / bottom / left
  const band = randInt(50, 110);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = side === 0 ? y : side === 1 ? w - 1 - x : side === 2 ? h - 1 - y : x;
      if (d >= band) continue;
      px[y * w + x] = Math.round(px[y * w + x] * (0.72 + 0.28 * (d / band)));
    }
  }
}

/** Rotate about the sheet centre and remap the label boxes to match. */
function rotateSheet(r, deg, labels) {
  const { w, h } = r;
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const cx0 = w / 2, cy0 = h / 2;
  const src = Uint8Array.from(r.px);
  r.px.fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // destination ← source (inverse of the label-space forward map)
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

function degradeSheet(r, labels) {
  const recipe = pick(['blur', 'noise', 'contrast', 'rotate', 'photocopy']);
  switch (recipe) {
    case 'blur':
      boxBlur(r, 1);
      break;
    case 'noise':
      speckle(r, rand(0.004, 0.02), true);
      speckle(r, rand(0.001, 0.004), false);
      break;
    case 'contrast':
      contrast(r, rand(0.6, 1.6), rand(-16, 16));
      break;
    case 'rotate':
      rotateSheet(r, rand(-0.6, 0.6), labels);
      break;
    case 'photocopy':
      edgeShadow(r);
      contrast(r, rand(1.1, 1.5), rand(-8, 8));
      speckle(r, rand(0.002, 0.008), true);
      break;
  }
  return recipe;
}

// ---------- debug overlay ----------
function drawOverlay(sheet) {
  const r = new Raster(W, H);
  r.px.set(sheet.raster.px);
  for (const l of sheet.labels) {
    const { x, y, w: bw, h: bh } = l.box;
    // red-ish box (grayscale renderer → draw in mid-gray dashes)
    const v = 120;
    r.line(x, y, x + bw, y, v, 1);
    r.line(x, y + bh, x + bw, y + bh, v, 1);
    r.line(x, y, x, y + bh, v, 1);
    r.line(x + bw, y, x + bw, y + bh, v, 1);
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
let nDegraded = 0;
const recipes = {};
for (let i = 0; i < COUNT; i++) {
  const sheet = generateSheet(i);
  let recipe = null;
  if (rng() < DEGRADE) {
    recipe = degradeSheet(sheet.raster, sheet.labels);
    nDegraded++;
    recipes[recipe] = (recipes[recipe] ?? 0) + 1;
  }
  nSymbols += sheet.labels.length;
  const isVal = rng() < VAL_FRAC;
  const dirI = isVal ? valDirI : trainDirI;
  const dirL = isVal ? valDirL : trainDirL;
  const name = `sheet-${String(i).padStart(4, '0')}`;
  const labelLines = sheet.labels.map(
    (l) => `${l.cls} ${(l.box.x + l.box.w / 2) / W} ${(l.box.y + l.box.h / 2) / H} ${l.box.w / W} ${l.box.h / H}`,
  );
  writeFileSync(join(dirI, `${name}.png`), encodePNG(sheet.raster));
  writeFileSync(join(dirL, `${name}.txt`), labelLines.join('\n') + '\n');
  if (isVal) nVal++;
  else nTrain++;
  if (DEBUG && i < 5) writeFileSync(join(OUT, 'debug', `overlay-${name}${recipe ? `-${recipe}` : ''}.png`), drawOverlay(sheet));
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
  `generated ${COUNT} sheets (${nTrain} train / ${nVal} val, ${nDegraded} degraded: ` +
    `${Object.entries(recipes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), ` +
    `${nSymbols} labelled symbols → ${OUT}`,
);
