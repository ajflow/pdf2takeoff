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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Raster, degradeSheet, encodePNG, rngHelpers } from './bench/draw.mjs';

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

// ---------- seeded RNG, raster primitives, PNG (scripts/bench/draw.mjs) ----------
const R = rngHelpers(SEED);
const { rng, rand, randInt, pick } = R;

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
// One recipe per sheet, chosen by the seeded RNG (degradeSheet in
// scripts/bench/draw.mjs draws from this script's stream). The photocopy
// recipe is a deliberate composite (edge shadow + contrast + dust);
// everything else is a single artifact so the detector can attribute its
// errors.

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
    recipe = degradeSheet(sheet.raster, sheet.labels, R);
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
