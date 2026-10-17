#!/usr/bin/env node
// Behavioural check for the gap-closing Dynamic Fill. Builds a 300x200
// raster: a room with a 23px door gap in its left wall, plus a fully sealed
// room as the control case, then asserts: the gapped room bounds through the
// gap with area within 12% of ideal, the sealed room is unchanged, and an
// unbounded region still errors.

import { dynamicFill } from '../src/engine/dynamicfill.ts';

const W = 300;
const H = 200;
const px = new Uint8ClampedArray(W * H * 4).fill(255);
const ink = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = px[i + 1] = px[i + 2] = 0;
};
// room A walls (left room): x 20..150, y 20..180, door gap on left wall y 90..114
for (let x = 20; x <= 150; x++) { ink(x, 20); ink(x, 180); }
for (let y = 20; y <= 180; y++) {
  if (y < 90 || y > 114) ink(20, y); // left wall with gap
  ink(150, y);
}
// room B walls (right): x 170..280, y 20..180, sealed
for (let x = 170; x <= 280; x++) { ink(x, 20); ink(x, 180); }
for (let y = 20; y <= 180; y++) { ink(170, y); ink(280, y); }

const raster = {
  width: W,
  height: H,
  data: px,
  toPdf: (x, y) => ({ x, y: H - y }),
  toRaster: (x, y) => ({ x, y: H - y }),
};

const area = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

// 1. room A through the door gap: true inner area = 129 x 159 = 20511
let r = dynamicFill(raster, { x: 85, y: 100 });
if ('error' in r) { console.error('FAIL room A (gap):', r.error); process.exit(1); }
const aA = area(r.points);
console.log(`room A (gapped): ${r.points.length} pts, area ${aA.toFixed(0)} (ideal ~20511)`);

// 2. room B sealed: true inner area = 109 x 159 = 17331
r = dynamicFill(raster, { x: 225, y: 100 });
if ('error' in r) { console.error('FAIL room B (sealed):', r.error); process.exit(1); }
const aB = area(r.points);
console.log(`room B (sealed): ${r.points.length} pts, area ${aB.toFixed(0)} (ideal ~17331)`);

// 3. unbounded: erase room B so the open area exceeds the page fraction cap
for (let y = 0; y < H; y++) for (let x = 165; x < W; x++) {
  const i = (y * W + x) * 4;
  px[i] = px[i + 1] = px[i + 2] = 255;
}
r = dynamicFill(raster, { x: 200, y: 100 });
if (!('error' in r)) { console.error('FAIL unbounded case returned a polygon'); process.exit(1); }
console.log('unbounded: error as expected →', r.error);

const tol = 0.12; // dilation is 2px at most after snapping; 12% headroom
if (Math.abs(aA - 20511) / 20511 > tol) { console.error(`FAIL room A area off: ${aA}`); process.exit(1); }
if (Math.abs(aB - 17331) / 17331 > tol) { console.error(`FAIL room B area off: ${aB}`); process.exit(1); }
console.log('PASS: gap room bounds with area within tolerance; sealed room unchanged; unbounded errors');
