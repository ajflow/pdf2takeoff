#!/usr/bin/env node
// B6 AEC-Geometric-Bench adapter (areas track, click-assisted, milestone 1).
// Renders one released sheet at the manifest's pixel frame through OUR engine
// adapters, runs the real Dynamic Fill at seed points, and writes a prediction
// JSON in the bench's format ({"sheet","objects","areas","walls"} — we submit
// areas only; objects/walls are out of scope and honestly empty).
//
//   node evals/aecgb/predict-sheet02.mjs --render-png evals/aecgb/sheet02.png
//   node evals/aecgb/predict-sheet02.mjs --seeds "512,730;1100,905;…" \
//        --out evals/aecgb/predictions/sheet_02.json
//
// The seeds are picked by a human inspecting the render (the "click-assisted"
// protocol — the same protocol class as opentakeoff's tool-assisted first
// pass). They are recorded in the run log, never derived from ground truth.
// The bench repo is cloned alongside (evals/aecgb/repo, gitignored) — never
// vendored, never trained on (dataset is CC BY-NC 4.0; eval only).
// See evals/README.md and docs/research/bench-patch-plan.md (patch B6).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

import { openPdf, renderRasterNode } from '../../src/headless/cli.ts';
import { dynamicFill } from '../../src/engine/dynamicfill.ts';
import { intersectionArea } from '../score-rooms.mjs';
// openings on this 300-dpi / imperial-scale sheet run ~108–225 px at
// 3 px/pt — the default ladder tops at 88 px, so the fill leaks. Pass a
// ladder scaled to the frame (recorded in the run log; engine default
// unchanged for every other caller).
const GAP_LADDER = [0, 16, 32, 48, 80, 112];

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, 'repo');
const SHEET = 'sheet_02';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};

if (!existsSync(join(REPO, 'dataset', 'manifest.json'))) {
  console.error('FAIL: evals/aecgb/repo missing — git clone --depth 1 https://github.com/KamaiEnterprises/aec-geometric-bench evals/aecgb/repo');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(REPO, 'dataset', 'manifest.json'), 'utf8'));
const entry = manifest.sheets.find((s) => s.sheet === SHEET);
if (!entry) { console.error(`FAIL: ${SHEET} not in manifest`); process.exit(1); }

const pdfBytes = readFileSync(join(REPO, 'dataset', entry.pdf));
const sha = createHash('sha256').update(pdfBytes).digest('hex');
if (sha !== entry.pdf_sha256) {
  console.error(`FAIL: ${SHEET}.pdf sha256 ${sha.slice(0, 16)}… ≠ manifest ${entry.pdf_sha256.slice(0, 16)}…`);
  process.exit(1);
}
console.log(`ok: ${SHEET}.pdf sha256 matches manifest (${sha.slice(0, 16)}…)`);

const doc = await openPdf(new Uint8Array(pdfBytes));
const page = await doc.getPage(1);
const vp1 = page.getViewport({ scale: 1 });
const frameScale = entry.width / vp1.width; // manifest px per PDF pt
// Fill runs at the app's standard raster scale (its designed operating
// point — the gap-closing ladder is tuned in px at 3 px/pt), not at the
// bench frame; polygons are transformed exactly into the manifest frame.
const fillPxPerPt = Number(arg('px-per-pt') ?? 3);
const raster = await renderRasterNode(doc, 1, fillPxPerPt);
console.log(`fill raster: ${fillPxPerPt} px/pt → ${raster.width}×${raster.height} px; manifest frame ${entry.width}×${entry.height} at ${frameScale.toFixed(4)} px/pt`);

const renderPng = arg('render-png');
if (renderPng) {
  // render at the manifest frame for seed picking (seeds are manifest px)
  const manifestRaster = await renderRasterNode(doc, 1, frameScale);
  const cnv = createCanvas(manifestRaster.width, manifestRaster.height);
  const ctx = cnv.getContext('2d');
  const img = ctx.createImageData(manifestRaster.width, manifestRaster.height);
  img.data.set(manifestRaster.data);
  ctx.putImageData(img, 0, 0);
  writeFileSync(renderPng, cnv.toBuffer('image/png'));
  console.log(`ok: ${renderPng} (${manifestRaster.width}×${manifestRaster.height}, manifest frame) — inspect it and pick one seed per room interior`);
  process.exit(0);
}

const seedsArg = arg('seeds');
const autoMode = process.argv.includes('--auto');
const outPath = arg('out');
if ((!seedsArg && !autoMode) || !outPath) {
  console.error('usage: --seeds "x,y;x,y;…" --out predictions/sheet_02.json   (click-assisted)');
  console.error('       --auto [--grid 90] --out predictions/sheet_02.json      (unassisted grid sweep)');
  process.exit(1);
}

// ---------- unassisted mode: grid sweep, every bounded fill kept ----------
// One seed per grid cell in manifest px, mapped into the fill raster; a fill
// that bounds becomes a candidate region. Seeds inside the same room produce
// the same region — dedupe by intersection-over-min (kept when < 0.6) and
// drop slivers under min-area. No ground truth involved anywhere.
if (autoMode) {
  const GRID = Number(arg('grid') ?? 90); // manifest px between seeds
  const MIN_AREA = 250; // manifest px² — closets stay, specks go
  const OVERLAP_KEEP = 0.6; // IoMin above this counts as the same region
  const polyArea = (pts) => Math.abs(pts.reduce((s, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;
  const interArea = (a, b) => intersectionArea(a.map(([x, y]) => ({ x, y })), b.map(([x, y]) => ({ x, y })));
  const pdfH = vp1.height;
  const areas = [];
  const failures = { onLine: 0, unbounded: 0, small: 0, dupe: 0 };
  const xs = [], ys = [];
  for (let x = GRID / 2; x < entry.width; x += GRID) xs.push(x);
  for (let y = GRID / 2; y < entry.height; y += GRID) ys.push(y);
  let done = 0;
  const t0 = performance.now();
  for (const mx of xs) for (const my of ys) {
    done++;
    const seed = { x: mx / frameScale, y: pdfH - my / frameScale };
    const r = dynamicFill(raster, seed, undefined, GAP_LADDER);
    if ('error' in r) {
      if (/clicked on a line/.test(r.error)) failures.onLine++;
      else failures.unbounded++;
    } else {
      const poly = r.points.map((p) => [
        Math.round(p.x * frameScale * 100) / 100,
        Math.round((pdfH - p.y) * frameScale * 100) / 100,
      ]);
      if (polyArea(poly) < MIN_AREA) { failures.small++; continue; }
      const dupe = areas.some((a) => {
        const i = interArea(poly, a);
        return i / Math.min(polyArea(poly), polyArea(a)) >= OVERLAP_KEEP;
      });
      if (dupe) { failures.dupe++; continue; }
      areas.push(poly);
    }
    if (done % 100 === 0) console.log(`  …${done}/${xs.length * ys.length} seeds, ${areas.length} regions (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    sheet: SHEET,
    objects: [],
    areas,
    walls: [],
  }, null, 2) + '\n');
  console.log(`auto sweep: ${xs.length * ys.length} seeds (grid ${GRID}px) → ${areas.length} regions in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`  seeds: on-line ${failures.onLine}, unbounded ${failures.unbounded}, slivers ${failures.small}, duplicates ${failures.dupe}`);
  console.log(`ok: ${outPath}`);
  process.exit(0);
}

const areas = [];
const failures = [];
for (const token of seedsArg.split(';').map((s) => s.trim()).filter(Boolean)) {
  const [px, py] = token.split(',').map(Number); // manifest px
  if (!Number.isFinite(px) || !Number.isFinite(py)) { console.error(`FAIL: bad seed "${token}"`); process.exit(1); }
  // manifest px → PDF pt (y-up) → dynamicFill runs at the fill raster's own frame
  const pdfH = vp1.height;
  const seed = { x: px / frameScale, y: pdfH - py / frameScale };
  const t0 = performance.now();
  // 2026-10-19: the engine's default ink-threshold ladder now covers this
  // sheet (walls render at grey ≈212; the ladder escalates 150→185→220 only
  // while a fill is unbounded — see src/engine/dynamicfill.ts and the
  // grey-wall regression in scripts/check-fill.mjs). No host tuning needed.
  const result = dynamicFill(raster, seed, undefined, GAP_LADDER);
  if ('error' in result) {
    failures.push({ seed: [px, py], error: result.error });
    console.log(`seed (${px},${py}): ERROR — ${result.error}`);
    continue;
  }
  // fill returns PDF pts (y-up) → manifest px (y-down)
  const poly = result.points.map((p) => [
    Math.round(p.x * frameScale * 100) / 100,
    Math.round((pdfH - p.y) * frameScale * 100) / 100,
  ]);
  areas.push(poly);
  console.log(`seed (${px},${py}): ${poly.length} pts (${(performance.now() - t0).toFixed(0)} ms)`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  sheet: SHEET,
  objects: [], // architectural fixture classes — out of scope for this engine, honestly empty
  areas,
  walls: [],  // no wall extractor yet — honestly empty, scores 0 on wall pixel-F1
}, null, 2) + '\n');
console.log(`ok: ${outPath} — ${areas.length} areas, ${failures.length} seed failure(s)`);
if (failures.length) { console.log('failures recorded in the run log — pick replacement seeds for unfilled rooms'); }
