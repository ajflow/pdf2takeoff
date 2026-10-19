#!/usr/bin/env node
// Behavioural check for tiled detector inference (specs/detector-tiling.md).
// Two layers:
//   1. A fake session whose run() returns one fixed detection per tile in
//      input coordinates — asserts hits land at the expected tile centres in
//      raster space, duplicate rows merge under NMS, and the legacy no-tile
//      path still maps a whole-page detection back correctly.
//   2. A self-locating stub that flood-fills dark blobs in the actual CHW
//      input — verifies the full geometry round-trip (tile → resample →
//      decode → offset → NMS → PDF pts) on synthetic rasters: every planted
//      symbol recovered exactly once (including border straddlers and sheet
//      corners), column-major outputs, the crushed-symbol error path, the
//      runaway tile guard, and the MAX_DET cap.
// Run via npm run typecheck:engine.

import { detectorScan } from '../src/engine/scan-onnx.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

// ---------- layer 1: fixed-answer fake session ----------
const S = 128;
const W = 256; // = S * RASTER_SCALE(3) / pxPerPt(1.5)

function fakeSession(tile) {
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
      void input;
      runs++;
      // one row [x1,y1,x2,y2,obj,pA,pB], duplicated to prove NMS dedup
      const stride = 7;
      const arr = new Float32Array(2 * stride);
      for (const r of [0, 1]) {
        const o = r * stride;
        arr[o] = 54; arr[o + 1] = 54; arr[o + 2] = 74; arr[o + 3] = 74;
        arr[o + 4] = 0.9; arr[o + 5] = 0.9; arr[o + 6] = 0.05;
      }
      return { data: arr, dims: [1, 2, stride] };
    },
  };
  return { det, count: () => runs };
}

// raster content is irrelevant (run ignores the input); geometry is what's tested
const raster = {
  width: 600,
  height: 400,
  data: new Uint8ClampedArray(600 * 400 * 4).fill(255),
  toPdf: (x, y) => ({ x, y }),
  toRaster: (x, y) => ({ x, y }),
};

// --- tiled: 600x400 @ W=256, overlap 20 → xs [0,172,344], ys [0,144] ---
{
  const { det, count } = fakeSession({ pxPerPt: 1.5, overlapPx: 20 });
  const r = await detectorScan(raster, { x: 472, y: 272 }, det);
  if ('error' in r) fail(`tiled scan errored: ${r.error}`);
  if (count() !== 6) fail(`expected 6 windows (3x2), ran ${count()}`);
  if (r.hits.length !== 6) fail(`expected 6 deduped hits, got ${r.hits.length}`);
  const centers = [[128, 128], [300, 128], [472, 128], [128, 272], [300, 272], [472, 272]];
  for (const [ex, ey] of centers) {
    const h = r.hits.find((x) => Math.hypot(x.x - ex, x.y - ey) < 1.5);
    if (!h) fail(`no hit at expected window centre (${ex},${ey}); got ${r.hits.map((x) => `${x.x},${x.y}`).join(' ')}`);
    if (h.label !== 'a') fail(`hit at (${ex},${ey}) labelled ${h.label}, expected 'a'`);
  }
  console.log('ok: tiled scan maps 6 window detections to raster-space window centres (dupes NMS-merged)');
}

// --- legacy: no tile → whole-page letterbox, input centre → page centre ---
{
  const { det, count } = fakeSession(null);
  const r = await detectorScan(raster, { x: 300, y: 200 }, det);
  if ('error' in r) fail(`legacy scan errored: ${r.error}`);
  if (count() !== 1) fail(`legacy path ran ${count()} windows, expected 1`);
  // scale = 128/600, dh = (128 - 400*scale)/2 → (64-dh)/scale = 200
  const h = r.hits[0];
  if (Math.hypot(h.x - 300, h.y - 200) > 1.5) fail(`legacy hit at (${h.x},${h.y}), expected (300,200)`);
  console.log('ok: legacy whole-page letterbox maps input centre to page centre');
}

// ---------- layer 2: self-locating stub over synthetic rasters ----------
const PAGE_W_PT = 1200;
const PAGE_H_PT = 840;

function synthPage(symbolsPt, pageW = PAGE_W_PT, pageH = PAGE_H_PT) {
  // symbolsPt: [{x, y}] PDF-pt centres; each becomes a 14pt dark square
  const w = pageW * RASTER_SCALE;
  const h = pageH * RASTER_SCALE;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const half = 7 * RASTER_SCALE; // 7pt half-extent → 21 raster px
  for (const s of symbolsPt) {
    const cx = Math.round(s.x * RASTER_SCALE);
    const cy = Math.round((pageH - s.y) * RASTER_SCALE); // PDF y-up → raster y-down
    for (let y = cy - half; y <= cy + half; y++) {
      for (let x = cx - half; x <= cx + half; x++) {
        const i = (y * w + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
  }
  return {
    width: w,
    height: h,
    data,
    toPdf: (x, y) => ({ x: x / RASTER_SCALE, y: pageH - y / RASTER_SCALE }),
    toRaster: (x, y) => ({ x: x * RASTER_SCALE, y: (pageH - y) * RASTER_SCALE }),
  };
}

// run() flood-fills dark blobs in the incoming CHW input and emits one
// [x1,y1,x2,y2,obj,cls...] row per blob in input px. Blobs under MIN_AREA
// px² are dropped, the way a real detector does not fire on tiny fragments.
function locatingStub({ inputSize = 400, classes = 5, columnMajor = false, minArea = 450 } = {}) {
  const MIN_AREA = minArea; // full 14pt symbol at pxPerPt 2 ≈ 28×28 = 784 px²
  const names = Array.from({ length: classes }, (_, i) => `sym${i}`);
  let runs = 0;
  const det = {
    inputSize,
    classes: names,
    score: 0.25,
    iou: 0.45,
    head: 'yolox-raw',
    modelName: 'stub',
    tile: undefined, // assigned per scenario
    run: async (input, size) => {
      runs++;
      const seen = new Uint8Array(size * size);
      const rows = [];
      const dark = (x, y) => input[y * size + x] < 0.5;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (seen[y * size + x] || !dark(x, y)) continue;
          let x0 = x, x1 = x, y0 = y, y1 = y;
          const stack = [[x, y]];
          seen[y * size + x] = 1;
          while (stack.length) {
            const [px, py] = stack.pop();
            if (px < x0) x0 = px;
            if (px > x1) x1 = px;
            if (py < y0) y0 = py;
            if (py > y1) y1 = py;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = px + dx, ny = py + dy;
              if (nx >= 0 && ny >= 0 && nx < size && ny < size && !seen[ny * size + nx] && dark(nx, ny)) {
                seen[ny * size + nx] = 1;
                stack.push([nx, ny]);
              }
            }
          }
          if ((x1 - x0 + 1) * (y1 - y0 + 1) < MIN_AREA) continue;
          const row = [x0, y0, x1 + 1, y1 + 1, 1.0];
          for (let c = 0; c < classes; c++) row.push(c === 0 ? 0.9 : 0.05);
          rows.push(row);
        }
      }
      const n = rows.length;
      const stride = 5 + classes;
      let data, dims;
      if (columnMajor && n > 0) {
        // [1, 5+C, N] with arr[c * N + r]
        data = new Float32Array(n * stride);
        rows.forEach((row, r) => row.forEach((v, c) => { data[c * n + r] = v; }));
        dims = [1, stride, n];
      } else {
        data = Float32Array.from(rows.flat());
        dims = [1, n, stride];
      }
      return { data, dims };
    },
  };
  return { det, count: () => runs };
}

function assertRecovered(label, result, symbolsPt, tolPt = 2) {
  if (!result.hits) fail(`${label}: expected hits, got error "${result.error}"`);
  const misses = symbolsPt.filter((s) => result.hits.filter((h) => Math.hypot(h.x - s.x, h.y - s.y) <= tolPt).length !== 1);
  const phantoms = result.hits.filter((h) => !symbolsPt.some((s) => Math.hypot(h.x - s.x, h.y - s.y) <= tolPt));
  if (misses.length || phantoms.length) {
    fail(
      `${label}: ${symbolsPt.length} symbols recovered exactly once (${result.hits.length} hits); ` +
        (misses.length
          ? `missed/duplicated: ${misses.map((s) => `(${s.x},${s.y})`).join(' ')}`
          : `phantoms: ${phantoms.map((h) => `(${h.x.toFixed(1)},${h.y.toFixed(1)})`).join(' ')}`),
    );
  }
  console.log(`ok: ${label}: ${symbolsPt.length} symbols recovered exactly once (${result.hits.length} hits)`);
}

// 12 symbols: four sheet corners, centre, tile-border straddlers (offset
// ~2pt off the exact border — a real detector meets near-misses, not
// perfect alignment), and filler. With inputSize 400 / pxPerPt 2 the tile
// grid is 7×5 = 35 runs; borders sit at x = {166.7, 333.3, ...} pt and
// y = {680, 520, 360, 200} pt.
const TWELVE = [
  { x: 60, y: 780 }, { x: 1140, y: 780 }, { x: 60, y: 60 }, { x: 1140, y: 60 },
  { x: 600, y: 420 },
  { x: 500 / RASTER_SCALE + 2, y: 300 },
  { x: 500 / RASTER_SCALE + 2, y: 640 },
  { x: 600, y: 680 + 2 },
  { x: 1000 / RASTER_SCALE + 2, y: 360 + 2 },
  { x: 900, y: 700 }, { x: 300, y: 100 }, { x: 1050, y: 350 },
];
const CLICK = TWELVE[0];

// --- full round-trip: every symbol recovered exactly once, in PDF pts ---
{
  const { det, count } = locatingStub();
  det.tile = { pxPerPt: 2, overlapPx: 96 };
  const r = await detectorScan(synthPage(TWELVE), CLICK, det);
  if (r.provider !== 'detector') fail(`provider ${r.provider}, expected detector`);
  if (count() !== 35) fail(`expected 35 tile runs (7x5), ran ${count()}`);
  assertRecovered('tiled round-trip', r, TWELVE);
}

// --- crushed symbols: 14pt at inputSize 400 whole-page ≈ 4.7px — the
// audit's headline finding; a detector-sized stub sees nothing → error ---
{
  const { det } = locatingStub();
  const r = await detectorScan(synthPage(TWELVE), CLICK, det);
  if (typeof r.error !== 'string') fail('expected the crushed-symbols error result');
  console.log('ok: legacy crushed: error result (symbols below usable size)');
}

// --- legacy geometry on a small sheet (letterbox padding path) ---
{
  const small = [{ x: 10, y: 80 }, { x: 120, y: 80 }, { x: 10, y: 10 }, { x: 120, y: 10 }, { x: 65, y: 45 }];
  const { det, count } = locatingStub();
  const r = await detectorScan(synthPage(small, 130, 90), small[0], det);
  if (count() !== 1) fail(`legacy small sheet ran ${count()} windows, expected 1`);
  assertRecovered('legacy small sheet', r, small);
}

// --- column-major output tensors decode to the same detections ---
{
  const small = [{ x: 10, y: 80 }, { x: 120, y: 80 }, { x: 10, y: 10 }, { x: 120, y: 10 }, { x: 65, y: 45 }];
  const { det } = locatingStub({ columnMajor: true });
  const r = await detectorScan(synthPage(small, 130, 90), small[0], det);
  assertRecovered('column-major', r, small);
}

// --- blank sheet → the documented error result, not a throw ---
{
  const { det } = locatingStub();
  det.tile = { pxPerPt: 2, overlapPx: 96 };
  const r = await detectorScan(synthPage([]), CLICK, det);
  if (typeof r.error !== 'string' || r.error.length === 0) fail('expected an error result for a blank sheet');
  console.log('ok: blank sheet: error result returned');
}

// --- runaway tile config (tiny windows → thousands of runs) is rejected ---
{
  const { det } = locatingStub();
  det.tile = { pxPerPt: 60, overlapPx: 0 };
  let threw = false;
  try {
    await detectorScan(synthPage(TWELVE), CLICK, det);
  } catch (e) {
    threw = /windows/.test(String(e.message));
  }
  if (!threw) fail('expected the runaway tile config to throw before any run');
  console.log('ok: runaway tile config rejected before any run');
}

// --- MAX_DET cap: 600 plantings cannot return more than 500 detections ---
{
  const many = [];
  for (let i = 0; i < 25; i++) for (let j = 0; j < 24; j++) many.push({ x: 24 + i * 48, y: 24 + j * 35 });
  const { det } = locatingStub();
  det.tile = { pxPerPt: 2, overlapPx: 96 };
  const r = await detectorScan(synthPage(many), many[300], det);
  if (r.hits.length !== 500) fail(`MAX_DET cap: expected 500 hits, got ${r.hits.length}`);
  console.log('ok: MAX_DET capped at 500');
}

// --- sheet smaller than one tile → single tile, still correct ---
{
  const three = [{ x: 50, y: 120 }, { x: 100, y: 70 }, { x: 160, y: 110 }];
  const { det, count } = locatingStub();
  det.tile = { pxPerPt: 2, overlapPx: 96 };
  const r = await detectorScan(synthPage(three, 200, 140), three[0], det);
  if (count() !== 1) fail(`small sheet ran ${count()} windows, expected 1`);
  assertRecovered('small sheet single tile', r, three);
}

console.log('PASS: tiling geometry, cross-tile NMS, legacy path and round-trip scenarios verified');
