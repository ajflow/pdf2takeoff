#!/usr/bin/env node
// Behavioural check for tiled detector inference (specs/detector-tiling.md).
// Drives detectorScan with a fake session whose run() "detects" every dark
// blob in the input it is actually given (connected components of the
// letterboxed pixels), so window offsets, resampling and box mapping are all
// exercised: feed a window the wrong pixels and the hits land in the wrong
// place. Asserts:
//   - legacy whole-page letterbox maps a detection back to the page;
//   - symbols straddling tile seams count exactly once (edge-cut fragments
//     dropped, cross-window duplicates merged);
//   - neighbouring symbols on a seam still count separately;
//   - blank windows are skipped, so a sparse sheet needing thousands of
//     windows still runs;
//   - more hits than the cap set `truncated` instead of silently clipping.

import { detectorScan } from '../src/engine/scan-onnx.ts';

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

/** Fake session: one [x1,y1,x2,y2,obj,pA,pB] row per dark blob in the input. */
function blobSession(S, tile) {
  let runs = 0;
  const det = {
    inputSize: S,
    classes: ['a', 'b'],
    score: 0.3,
    iou: 0.5,
    head: 'yolox-raw',
    modelName: 'fake',
    ...(tile ? { tile } : {}),
    run: async (input, size) => {
      runs++;
      const dark = new Uint8Array(size * size);
      for (let i = 0; i < size * size; i++) dark[i] = input[i] < 0.5 ? 1 : 0;
      const seen = new Uint8Array(size * size);
      const rows = [];
      for (let start = 0; start < size * size; start++) {
        if (!dark[start] || seen[start]) continue;
        let x0 = size, y0 = size, x1 = -1, y1 = -1;
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
          const i = stack.pop();
          const x = i % size;
          const y = (i / size) | 0;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          for (const j of [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, i - size, i + size]) {
            if (j >= 0 && j < size * size && dark[j] && !seen[j]) {
              seen[j] = 1;
              stack.push(j);
            }
          }
        }
        rows.push([x0, y0, x1 + 1, y1 + 1, 0.9, 0.9, 0.05]);
      }
      const stride = 7;
      const arr = new Float32Array(Math.max(1, rows.length) * stride);
      rows.forEach((r, k) => arr.set(r, k * stride));
      return { data: arr, dims: [1, Math.max(1, rows.length), stride] };
    },
  };
  return { det, count: () => runs };
}

/** White raster with black squares (side px) centred on the given points. */
function rasterWith(width, height, centres, side) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const h = side / 2;
  for (const [cx, cy] of centres) {
    for (let y = Math.round(cy - h); y < Math.round(cy + h); y++) {
      for (let x = Math.round(cx - h); x < Math.round(cx + h); x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return { width, height, data, toPdf: (x, y) => ({ x, y }), toRaster: (x, y) => ({ x, y }) };
}

/** Every expected centre matched by exactly one hit, and no extra hits. */
function expectHits(label, r, centres, tol = 3) {
  if ('error' in r) fail(`${label}: scan errored: ${r.error}`);
  if (r.hits.length !== centres.length) fail(`${label}: expected ${centres.length} hits, got ${r.hits.length}`);
  for (const [ex, ey] of centres) {
    const n = r.hits.filter((h) => Math.hypot(h.x - ex, h.y - ey) < tol).length;
    if (n !== 1) fail(`${label}: ${n} hits at (${ex},${ey}); hits ${r.hits.map((h) => `${h.x.toFixed(0)},${h.y.toFixed(0)}`).join(' ')}`);
  }
}

// --- legacy: no tile → whole-page letterbox maps back to the page ----------
{
  const centres = [[300, 200], [120, 80]];
  const { det, count } = blobSession(128, null);
  const r = await detectorScan(rasterWith(600, 400, centres, 30), { x: 300, y: 200 }, det);
  if (count() !== 1) fail(`legacy path ran ${count()} windows, expected 1`);
  expectHits('legacy', r, centres, 4);
  console.log('ok: legacy whole-page letterbox maps detections back to the page');
}

// --- seams: W = 256 (S 128, pxPerPt 1.5), maxSymbolPt 10 → overlap 42 px ----
// 600 px wide → window x0s [0, 172, 344]; 400 tall → y0s [0, 144]. Sweep a
// row of 20 px symbols across both vertical seams and a column across the
// horizontal seam; each must count once.
{
  const centres = [];
  for (let x = 20; x <= 580; x += 24) centres.push([x, 60]);
  for (let y = 100; y <= 380; y += 24) centres.push([300, y]); // clear of the row
  const tile = { pxPerPt: 1.5, overlapPx: 0, maxSymbolPt: 10 };
  const { det } = blobSession(128, tile);
  const r = await detectorScan(rasterWith(600, 400, centres, 20), { x: 20, y: 60 }, det);
  expectHits('seam sweep', r, centres);
  console.log(`ok: ${centres.length} symbols swept across tile seams each count once`);
}

// --- tiles too small for the symbol: the edge-cut filter must stand down ----
// W = 64 (S 64, pxPerPt 3); 12 pt symbols need ~49 px overlap but only 32 fit,
// so 40 px symbols on a seam are never whole in one tile. Dropping edge-cut boxes
// would lose them; coverage merging must count each once instead.
{
  const centres = [];
  for (let x = 25; x <= 385; x += 60) centres.push([x, 50]);
  const tile = { pxPerPt: 3, overlapPx: 0, maxSymbolPt: 12 };
  const { det } = blobSession(64, tile);
  const r = await detectorScan(rasterWith(410, 100, centres, 40), { x: 25, y: 50 }, det);
  if ('error' in r) fail(`small tiles: ${r.error}`);
  if (r.hits.length !== centres.length) fail(`small tiles: expected ${centres.length} hits, got ${r.hits.length}`);
  console.log(`ok: ${centres.length} symbols larger than the tile overlap each count once`);
}

// --- neighbours on a seam stay separate --------------------------------------
{
  const centres = [[250, 200], [274, 200], [250, 224], [274, 224]]; // 4 px gaps, around x0 = 256-ish seams
  const tile = { pxPerPt: 1.5, overlapPx: 0, maxSymbolPt: 10 };
  const { det } = blobSession(128, tile);
  const r = await detectorScan(rasterWith(600, 400, centres, 20), { x: 250, y: 200 }, det);
  expectHits('seam neighbours', r, centres);
  console.log('ok: tightly packed neighbours on a seam count separately');
}

// --- sparse huge sheet: thousands of windows, only the inked ones run --------
{
  const centres = [[500, 500], [1500, 2200], [2800, 900]];
  const tile = { pxPerPt: 3, overlapPx: 0, maxSymbolPt: 4 }; // W = 64, stride 45 → 4356 windows
  const { det, count } = blobSession(64, tile);
  const r = await detectorScan(rasterWith(3000, 3000, centres, 10), { x: 500, y: 500 }, det);
  expectHits('sparse sheet', r, centres);
  if (count() > 40) fail(`sparse sheet ran ${count()} windows; blank ones should be skipped`);
  console.log(`ok: sparse 3000x3000 sheet ran ${count()} non-blank windows of ~4356`);
}

// --- more hits than the cap: truncated, not silently clipped -----------------
{
  const centres = [];
  for (let y = 15; y < 1600; y += 30) for (let x = 15; x < 1600; x += 30) centres.push([x, y]);
  const tile = { pxPerPt: 1.5, overlapPx: 0, maxSymbolPt: 4 };
  const { det } = blobSession(128, tile);
  const r = await detectorScan(rasterWith(1600, 1600, centres, 6), { x: 15, y: 15 }, det);
  if ('error' in r) fail(`cap case errored: ${r.error}`);
  if (!r.truncated || r.hits.length !== 2000) fail(`expected 2000 hits with truncated set for ${centres.length} symbols; got ${r.hits.length}, truncated ${r.truncated}`);
  if (!/truncated/.test(r.note ?? '')) fail(`note should say the count is truncated: ${r.note}`);
  console.log(`ok: ${centres.length} symbols → first 2000 returned with truncated flag`);
}

console.log('PASS: tiling geometry, seam fusion, blank-window skip and hit cap verified');
