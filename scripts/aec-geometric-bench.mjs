#!/usr/bin/env node
// AEC-Geometric-Bench (KamaiEnterprises, MIT): run the click-free raster
// engine over the fifteen released sheets and emit the benchmark's
// prediction JSONs, then score them with the bench's own scorer.
//
//   node --experimental-strip-types scripts/aec-geometric-bench.mjs \
//     --bench /path/to/aec-geometric-bench --out bench/aec-geometric-bench/results
//
// What the engine submits, honestly: walls and enclosed areas from the
// raster opening detector (src/engine/openings.ts — wall-mask closing,
// threshold-gap scanning, enclosed-space counting), doors and windows from
// its gap classifier. Fixtures (sinks, toilets, bathtubs, showers, cooktops)
// have no click-free detector, so they are simply not submitted — the
// benchmark's protocol scores everything reported, and absence costs recall
// only. All doors are submitted as 'Single Swing Door' (the engine counts
// leaves and does not pair double doors). No vision model, no clicks, no
// network: this is the deterministic floor of the engine, first pass.
//
// Coordinates: the bench scores in the manifest's pixel frame (300 dpi);
// each PDF is rendered at exactly that scale, so engine raster pixels map
// one-to-one onto the scoring frame.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { detectOpenings, countEnclosedSpaces } from '../src/engine/openings.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const benchDir = resolve(arg('bench', join(__dirname, '..', 'bench', 'aec-geometric-bench', 'external')));
const outDir = resolve(arg('out', join(__dirname, '..', 'bench', 'aec-geometric-bench', 'results')));
const python = process.env.PDF2TAKEOFF_PYTHON || 'python3';

if (!existsSync(join(benchDir, 'dataset', 'manifest.json'))) {
  console.error(`no dataset/manifest.json under ${benchDir} — clone github.com/KamaiEnterprises/aec-geometric-bench (MIT) and pass --bench <dir>`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(benchDir, 'dataset', 'manifest.json'), 'utf8'));
mkdirSync(outDir, { recursive: true });

// --- unassisted Dynamic Fill sweep (areas only), one sheet -------------------
//
//   node --experimental-strip-types scripts/aec-geometric-bench.mjs --fill-auto \
//     --bench <clone> --out <dir> [--sheet sheet_02] [--grid 90] [--arms on,off]
//
// The B6d unassisted protocol on the current engine: a grid of seeds every
// `grid` manifest px (column by column), each filled by Dynamic Fill on the
// app's 3 px/pt raster with no hints (no clicks, no labels, no scale), the
// ink threshold escalating 150 -> 185 -> 220 only while a fill fails (the
// ladder the B6d engine carried), rooms under 250 manifest px² dropped and
// rooms overlapping an earlier one by intersection-over-min >= 0.6 dropped
// (autoRooms, src/engine/auto-rooms.ts, compares exact pixels; children of a
// partitioned region replace their merged parent). Arm `on` runs the room
// partition pass, arm `off` the same with the pass disabled, on the same
// raster. Each arm is scored with the bench's own scoring functions.
if (args.includes('--fill-auto')) {
  const { createHash } = await import('node:crypto');
  const { autoRooms } = await import('../src/engine/auto-rooms.ts');
  const { RASTER_SCALE } = await import('../src/engine/ports.ts');
  const sheetId = arg('sheet', 'sheet_02');
  const GRID = Number(arg('grid', 90));
  const arms = arg('arms', 'on,off').split(',');
  const entry = manifest.sheets.find((s) => s.sheet === sheetId);
  const bytes = new Uint8Array(readFileSync(join(benchDir, 'dataset', entry.pdf)));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (entry.pdf_sha256 && sha !== entry.pdf_sha256) {
    console.error(`${sheetId}.pdf sha256 ${sha} does not match the manifest`);
    process.exit(1);
  }
  const doc = await openPdf(bytes);
  const page = await doc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const frameScale = entry.width / vp1.width; // manifest px per PDF pt
  const pdfH = vp1.height;
  const raster = await renderRasterNode(doc, 1, RASTER_SCALE);
  console.log(`${sheetId}: sha256 ${sha.slice(0, 16)}…, fill raster ${raster.width}×${raster.height} at ${RASTER_SCALE} px/pt, manifest ${entry.width}×${entry.height} at ${frameScale.toFixed(4)} px/pt`);
  const seeds = [];
  for (let mx = GRID / 2; mx < entry.width; mx += GRID) for (let my = GRID / 2; my < entry.height; my += GRID) seeds.push({ x: mx / frameScale, y: pdfH - my / frameScale });
  const minAreaPx = Math.round(250 * (RASTER_SCALE / frameScale) ** 2);
  const summary = { sheet: sheetId, pdfSha256: sha, grid: GRID, seeds: seeds.length, rasterScale: RASTER_SCALE, minAreaPx, tolerances: [150, 185, 220], arms: {} };
  for (const arm of arms) {
    const t = Date.now();
    const { rooms, stats } = autoRooms(raster, seeds, {}, { tolerances: [150, 185, 220], minAreaPx, overlapKeep: 0.6, partition: arm === 'on' });
    const areas = rooms.map((r) => r.points.map((p) => [Math.round(p.x * frameScale * 100) / 100, Math.round((pdfH - p.y) * frameScale * 100) / 100]));
    const dir = join(outDir, `arm-${arm}`);
    mkdirSync(dir, { recursive: true });
    const predFile = join(dir, `${sheetId}.json`);
    writeFileSync(predFile, JSON.stringify({ sheet: sheetId, objects: [], areas, walls: [] }) + '\n');
    const seconds = Math.round((Date.now() - t) / 1000);
    console.log(`arm ${arm}: ${rooms.length} rooms (${rooms.filter((r) => r.evidence).length} partition children) from ${seeds.length} seeds in ${seconds} s; ${JSON.stringify(stats)}`);
    const sc = spawnSync(python, ['-I', join(__dirname, 'bench', 'aecgb-score-sheet.py'), '--bench', benchDir, '--sheet', sheetId, '--pred', predFile], { encoding: 'utf8' });
    if (sc.status !== 0) {
      console.error(sc.stderr || sc.stdout);
      process.exit(1);
    }
    writeFileSync(join(outDir, `score-${arm}.json`), sc.stdout);
    console.log(sc.stdout);
    summary.arms[arm] = { rooms: rooms.length, partitionChildren: rooms.filter((r) => r.evidence).length, seconds, stats, score: JSON.parse(sc.stdout) };
  }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.exit(0);
}

/** Wall mask as merged run-length rectangles (exact reconstruction when the scorer rasterizes the union). */
function maskRectangles(mask, mw, mh, s, kx, ky) {
  const rects = [];
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    let x = 0;
    while (x < mw) {
      if (!mask[row + x]) { x++; continue; }
      const x0 = x;
      while (x < mw && mask[row + x]) x++;
      const x1 = x; // exclusive
      // extend downward while the same span stays solid
      let y1 = y + 1;
      while (y1 < mh) {
        let solid = true;
        for (let i = x0; i < x1; i++) if (!mask[y1 * mw + i]) { solid = false; break; }
        if (!solid) break;
        y1++;
        for (let i = x0; i < x1; i++) mask[(y1 - 1) * mw + i] = 0; // consumed: never re-emits
      }
      rects.push([x0 * s * kx, y * s * ky, x1 * s * kx, y1 * s * ky]);
    }
  }
  return rects.map(([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
}

const failures = [];
let t0 = Date.now();
for (const sheet of manifest.sheets) {
  const id = sheet.sheet;
  const tSheet = Date.now();
  const bytes = new Uint8Array(readFileSync(join(benchDir, 'dataset', sheet.pdf)));
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const { width: ptW } = page.getSize();
  const scale = sheet.width / ptW;
  let pred = { sheet: id, objects: [], areas: [], walls: [] };
  try {
    const pdf = await openPdf(bytes);
    const raster = await renderRasterNode(pdf, 1, scale);
    const kx = sheet.width / raster.width;
    const ky = sheet.height / raster.height;
    // the anchor pins the detector config its 0.519 wall-F1 first pass ran
    // with: the base closing ladder and no closing guards. The defaults
    // since grew an extended ladder (hatched residential scans) whose guards
    // trade wall recall on these large commercial sheets for count sanity;
    // pinning keeps the anchor's time series comparable run over run.
    const anchor = { closeRadii: [0, 1, 2, 3], closeCellFactor: 1e9, closeCellAdd: 1e9, closeGrowthLimit: 1e9, spaceKernelFraction: 0.5 };
    const res = detectOpenings(raster, anchor);
    const spaces = countEnclosedSpaces(raster, anchor, res);
    const box = (b) => [b.x0 * kx, b.y0 * ky, b.x1 * kx, b.y1 * ky];
    pred.objects = [
      ...res.doors.map((d) => ({ class: 'Single Swing Door', bbox: box(d.px) })),
      ...res.windows.map((w) => ({ class: 'Window', bbox: box(w.px) })),
    ];
    pred.areas = spaces.spaces.map((sp) => [
      [sp.x0 * kx, sp.y0 * ky], [sp.x1 * kx, sp.y0 * ky], [sp.x1 * kx, sp.y1 * ky], [sp.x0 * kx, sp.y1 * ky],
    ]);
    const { mask, width: mw, scale: s } = res.walls;
    const mh = mask.length / mw;
    pred.walls = maskRectangles(mask, mw, mh, s, kx, ky);
  } catch (err) {
    failures.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  writeFileSync(join(outDir, `${id}.json`), JSON.stringify(pred));
  const secs = ((Date.now() - tSheet) / 1000).toFixed(1);
  console.log(`${id}: ${pred.objects.length} objects (${pred.objects.filter((o) => o.class === 'Window').length} windows), ${pred.areas.length} areas, ${pred.walls.length} wall rects, ${secs} s${failures.some((f) => f.startsWith(id)) ? ' [ENGINE ERROR -> empty prediction]' : ''}`);
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s total${failures.length ? `\nfailures:\n${failures.join('\n')}` : ''}`);

// score with the bench's own scorer
const scored = spawnSync(python, [join(benchDir, 'scoring', 'score.py'), '--pred', outDir], { encoding: 'utf8' });
if (scored.status !== 0) {
  console.error(scored.stderr || scored.stdout);
  process.exit(1);
}
console.log(scored.stdout);
writeFileSync(join(outDir, 'score.txt'), scored.stdout);
