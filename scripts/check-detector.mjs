#!/usr/bin/env node
// Behavioural check for tiled detector inference (specs/detector-tiling.md).
// Drives detectorScan with a fake session whose run() returns one fixed
// detection per window in input coordinates; asserts the hits land at the
// expected window centres in raster space, duplicates merge under NMS, and
// the legacy no-tile path still maps a whole-page detection back correctly.

import { detectorScan } from '../src/engine/scan-onnx.ts';

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

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

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

console.log('PASS: tiling geometry, cross-window NMS and legacy path verified');
