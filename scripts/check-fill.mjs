#!/usr/bin/env node
// Behavioural check for the gap-closing Dynamic Fill. Builds a 300x200
// raster: a room with a 25px door gap in its left wall, plus a fully sealed
// room as the control case, then asserts: the gapped room bounds through the
// gap with area within 12% of ideal, the sealed room is unchanged, and an
// unbounded region still errors. A second 600x400 raster covers what the
// first can't see: an L-shaped room (the trace must follow concave corners,
// not cut across them) and a door in a horizontal wall (row-wise closing).

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

const tol = 0.12; // the polygon runs through boundary-pixel centres; 12% headroom
if (Math.abs(aA - 20511) / 20511 > tol) { console.error(`FAIL room A area off: ${aA}`); process.exit(1); }
if (Math.abs(aB - 17331) / 17331 > tol) { console.error(`FAIL room B area off: ${aB}`); process.exit(1); }

// --- second sheet: concave room + door in a horizontal wall -----------------
const W2 = 600;
const H2 = 400;
const px2 = new Uint8ClampedArray(W2 * H2 * 4).fill(255);
const ink2 = (x, y) => {
  const i = (y * W2 + x) * 4;
  px2[i] = px2[i + 1] = px2[i + 2] = 0;
};
const seg = (x0, y0, x1, y1) => {
  if (y0 === y1) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) ink2(x, y0);
  else for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) ink2(x0, y);
};
// sealed L: 20..220 x 20..220 minus the top-right 120..220 x 20..120
seg(20, 20, 120, 20); seg(120, 20, 120, 120); seg(120, 120, 220, 120);
seg(220, 120, 220, 220); seg(220, 220, 20, 220); seg(20, 220, 20, 20);
// room C: 300..560 x 40..260 with a 30px door in its bottom wall (x 400..429)
seg(300, 40, 560, 40); seg(300, 40, 300, 260); seg(560, 40, 560, 260);
seg(300, 260, 399, 260); seg(430, 260, 560, 260);
const raster2 = { width: W2, height: H2, data: px2, toPdf: (x, y) => ({ x, y: H2 - y }), toRaster: (x, y) => ({ x, y: H2 - y }) };

// 4. L room: true inner area = 199*199 - 100*100 = 29601
r = dynamicFill(raster2, { x: 60, y: H2 - 180 });
if ('error' in r) { console.error('FAIL L room:', r.error); process.exit(1); }
const aL = area(r.points);
console.log(`L room (concave): ${r.points.length} pts, area ${aL.toFixed(0)} (ideal ~29601)`);
if (Math.abs(aL - 29601) / 29601 > 0.03) { console.error(`FAIL L room area off: ${aL}`); process.exit(1); }

// 5. room C through the door in its bottom wall: true inner area = 259 x 219 = 56721
r = dynamicFill(raster2, { x: 430, y: H2 - 150 });
if ('error' in r) { console.error('FAIL room C (horizontal-wall door):', r.error); process.exit(1); }
const aC = area(r.points);
console.log(`room C (door in horizontal wall): ${r.points.length} pts, area ${aC.toFixed(0)} (ideal ~56721)`);
if (Math.abs(aC - 56721) / 56721 > 0.03) { console.error(`FAIL room C area off: ${aC}`); process.exit(1); }

console.log('PASS: gap rooms bound with area within tolerance; sealed and concave rooms traced; unbounded errors');
