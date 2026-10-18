#!/usr/bin/env node
// Behavioural check for the headless detector tier: the CLI and MCP scan
// path (scanDocAt in src/headless/ops.ts) must reach the trained ONNX
// detector through src/headless/detector-node.ts, running onnxruntime-web's
// Node entry (WASM) with no browser. Drives real inference on the committed
// stub model in scripts/fixtures/detector-stub (a grid detector whose
// objectness and class scores depend on the pixels it is given; built by
// scripts/make-detector-stub.py), so loader, letterbox, decode, click-to-class
// and the coordinate round trip are all exercised. Asserts:
//   - a model directory resolves, loads, and runs with the contract's shapes;
//   - scanDocAt on a PDF returns provider "detector" with hits of the clicked
//     class only, labelled, scored, at the right PDF points;
//   - a page-wide scan threads the model option through every page;
//   - no model anywhere means the tier-1 path, unchanged;
//   - an explicit directory without a model is an error, not a silent fallback.
// Set PDF2TAKEOFF_CHECK_REAL_MODEL=<dir> to also run that model on
// public/examples/detector-demo.pdf and print what it found (no assertion on
// the count: the demo's symbols are not the model's training symbols).
//
//   node --experimental-strip-types scripts/check-detector-node.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';
import { detectorScan } from '../src/engine/scan-onnx.ts';
import { scanDocAt, scanDocAllPages } from '../src/headless/ops.ts';
import { loadDetectorNode, locateModel, MODEL_DIR_ENV } from '../src/headless/detector-node.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STUB = join(ROOT, 'scripts', 'fixtures', 'detector-stub');
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
// the environment must not decide the outcome
delete process.env[MODEL_DIR_ENV];

// --- the stub model loads and runs with the detector contract ---------------
const S = 128;
const CELL = 16;
const GRID = S / CELL;
{
  const loc = locateModel(STUB);
  if (!loc || loc.source !== 'explicit' || !loc.model.endsWith('symbols.onnx')) fail(`locateModel(stub) gave ${JSON.stringify(loc)}`);
  const det = await loadDetectorNode(STUB);
  if (!det) fail('stub model did not load');
  if (det.inputSize !== S || det.classes.join() !== 'sparse,dense' || det.head !== 'yolox-raw') fail(`manifest not honoured: ${JSON.stringify({ ...det, run: undefined })}`);
  if ((await loadDetectorNode(STUB)) !== det) fail('session is not cached per model directory');
  // white input with one black cell: that row alone carries objectness
  const input = new Float32Array(3 * S * S).fill(1);
  const [gx, gy] = [3, 2];
  for (let y = gy * CELL; y < (gy + 1) * CELL; y++) for (let x = gx * CELL; x < (gx + 1) * CELL; x++) {
    for (let c = 0; c < 3; c++) input[c * S * S + y * S + x] = 0;
  }
  const { data, dims } = await det.run(input, S);
  if (dims.join() !== `1,${GRID * GRID},7` || data.length !== GRID * GRID * 7) fail(`output dims ${dims} length ${data.length}`);
  const rowAt = (r) => Array.from(data.slice(r * 7, r * 7 + 7));
  const hot = rowAt(gy * GRID + gx);
  const cold = rowAt(0);
  if (Math.abs(hot[4] - 1) > 1e-5 || Math.abs(hot[6] - 1) > 1e-5 || hot[0] !== gx * CELL || hot[1] !== gy * CELL) fail(`inked cell row ${hot}`);
  if (cold[4] !== 0 || data.filter((_, i) => i % 7 === 4 && data[i] > 0).length !== 1) fail(`empty cell row ${cold}; objectness should be confined to the inked cell`);
  console.log(`ok: stub model loaded via onnxruntime-web (Node/WASM), output [1,${GRID * GRID},7], objectness follows the pixels`);
}

// --- a PDF scanned through scanDocAt reaches the detector ---------------------
// 300 x 200 pt page -> 900 x 600 px raster at RASTER_SCALE -> letterboxed into
// S x S. Filled-square glyphs (text, invisible to the vector tier) sit at cell
// centres; the stub reports each inked cell as a box, so every hit must land
// on its cell centre with the class the inked fraction implies.
const PAGE_W = 300;
const PAGE_H = 200;
const scale = Math.min(S / (PAGE_W * RASTER_SCALE), S / (PAGE_H * RASTER_SCALE));
const dw = (S - PAGE_W * RASTER_SCALE * scale) / 2;
const dh = (S - PAGE_H * RASTER_SCALE * scale) / 2;
/** PDF point of a cell centre, through the letterbox and the raster's y flip. */
const cellCentrePt = (gx, gy) => ({
  x: (gx * CELL + CELL / 2 - dw) / scale / RASTER_SCALE,
  y: PAGE_H - (gy * CELL + CELL / 2 - dh) / scale / RASTER_SCALE,
});
const inputPxToPt = (px) => px / scale / RASTER_SCALE;
const sparseCells = [[1, 2], [4, 3], [6, 5], [2, 4]];
const denseCells = [[3, 2], [7, 4]];

async function squaresPdf() {
  const doc = await PDFDocument.create();
  // ZapfDingbats U+25A0: ink box is 0.483 x size, offset (0.308, 0.175) x size from the text origin
  const font = await doc.embedFont(StandardFonts.ZapfDingbats);
  const square = (page, gx, gy, sidePx) => {
    const c = cellCentrePt(gx, gy);
    const size = inputPxToPt(sidePx) / 0.483;
    page.drawText('■', { x: c.x - 0.308 * size, y: c.y - 0.175 * size, size, font });
  };
  const p1 = doc.addPage([PAGE_W, PAGE_H]);
  for (const [gx, gy] of sparseCells) square(p1, gx, gy, 8); // 25% of the cell inked
  for (const [gx, gy] of denseCells) square(p1, gx, gy, 12); // 56% inked
  const p2 = doc.addPage([PAGE_W, PAGE_H]);
  square(p2, 5, 3, 8);
  return openPdf(await doc.save());
}

function expectHits(label, r, cells, cls) {
  if ('error' in r) fail(`${label}: ${r.error}`);
  if (r.provider !== 'detector') fail(`${label}: provider ${r.provider}, expected detector`);
  if (r.hits.length !== cells.length) fail(`${label}: ${r.hits.length} hits, expected ${cells.length}: ${JSON.stringify(r.hits)}`);
  for (const [gx, gy] of cells) {
    const c = cellCentrePt(gx, gy);
    const near = r.hits.filter((h) => Math.hypot(h.x - c.x, h.y - c.y) < 1.5);
    if (near.length !== 1) fail(`${label}: ${near.length} hits at cell (${gx},${gy}) = ${c.x.toFixed(1)},${c.y.toFixed(1)}; hits ${r.hits.map((h) => `${h.x.toFixed(1)},${h.y.toFixed(1)}`).join(' ')}`);
    const h = near[0];
    if (h.label !== cls) fail(`${label}: hit at (${gx},${gy}) labelled ${h.label}, expected ${cls}`);
    if (!(h.score > 0.4 && h.score <= 1)) fail(`${label}: hit score ${h.score}`);
  }
  if (!r.note || !r.note.includes(cls) || !r.note.includes('symbols.onnx')) fail(`${label}: note "${r.note}" should name the class and the model`);
}

const pdf = await squaresPdf();
{
  const r = await scanDocAt(pdf, 1, cellCentrePt(...sparseCells[0]), { modelDir: STUB });
  expectHits('sparse click', r, sparseCells, 'sparse');
  console.log(`ok: scanDocAt with --model reaches the detector: ${r.hits.length} sparse hits, dense ones ignored, labelled and placed`);
  const d = await scanDocAt(pdf, 1, cellCentrePt(...denseCells[0]), { modelDir: STUB });
  expectHits('dense click', d, denseCells, 'dense');
  console.log(`ok: clicking the other class counts that class (${d.hits.length} dense)`);
  const all = await scanDocAllPages(pdf, cellCentrePt(...sparseCells[0]), { modelDir: STUB });
  if (all.total !== sparseCells.length + 1 || all.pages.length !== 2) fail(`all-pages schedule ${JSON.stringify(all)}`);
  console.log(`ok: page-wide scan carries the model option (${all.pages.map((p) => p.count).join(' + ')} hits)`);
}

// --- the environment variable is the second source ---------------------------
{
  process.env[MODEL_DIR_ENV] = STUB;
  const loc = locateModel();
  if (!loc || loc.source !== 'env') fail(`${MODEL_DIR_ENV} not honoured: ${JSON.stringify(loc)}`);
  const r = await scanDocAt(pdf, 1, cellCentrePt(...sparseCells[0]));
  if ('error' in r || r.provider !== 'detector') fail(`${MODEL_DIR_ENV}: provider ${'error' in r ? r.error : r.provider}`);
  delete process.env[MODEL_DIR_ENV];
  console.log(`ok: ${MODEL_DIR_ENV} selects the model without --model`);
}

// --- no model: the classic path, untouched -----------------------------------
{
  const shipped = existsSync(join(ROOT, 'public', 'models', 'symbols.onnx'));
  if (!shipped && (await loadDetectorNode()) !== null) fail('a bare checkout should resolve no detector');
  const r = await scanDocAt(pdf, 1, cellCentrePt(...sparseCells[0]));
  if (!shipped && !('error' in r) && r.provider === 'detector') fail('scan used a detector with no model configured');
  console.log(`ok: without a model the scan stays on the ${'error' in r ? 'tier-1 path (' + r.error + ')' : r.provider + ' tier'}`);
}

// --- asking for a model that is not there is an error --------------------------
{
  const empty = mkdtempSync(join(tmpdir(), 'pdf2takeoff-nomodel-'));
  try {
    let threw = null;
    try {
      await loadDetectorNode(empty);
    } catch (err) {
      threw = err;
    }
    if (!threw || !/--model/.test(threw.message)) fail(`empty --model dir should throw, got ${threw && threw.message}`);
    console.log('ok: --model on a folder without symbols.json is reported, not silently ignored');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

// --- optional: a real trained model on the demo sheet ----------------------------
const real = process.env.PDF2TAKEOFF_CHECK_REAL_MODEL;
if (real) {
  const demo = join(ROOT, 'public', 'examples', 'detector-demo.pdf');
  const det = await loadDetectorNode(real);
  if (!det) fail(`no model in ${real}`);
  const doc = await openPdf(new Uint8Array(readFileSync(demo)));
  const t0 = Date.now();
  const raster = await renderRasterNode(doc, 1, RASTER_SCALE);
  const r = await detectorScan(raster, { x: 91, y: 268 }, det);
  if ('error' in r) fail(`real model: ${r.error}`);
  console.log(`ok: ${det.modelName} (${det.classes.length} classes, input ${det.inputSize}) ran on detector-demo.pdf p1 in ${Date.now() - t0} ms: ${r.hits.length} x ${r.hits[0]?.label}`);
}

console.log('PASS: headless detector tier loads, runs and is reached by scanDocAt');
