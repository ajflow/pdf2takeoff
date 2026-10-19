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

// 4. light-line sheet (measured on a real 300-dpi benchmark sheet, 2026-10):
//    walls at grey 212 with a decoy grid at 230. At the classic threshold of
//    150 the walls are invisible and the fill must refuse; the default
//    ink-threshold ladder must find the 212-walls as boundaries while the
//    230 grid stays background.
{
  const W2 = 420, H2 = 280;
  const px2 = new Uint8ClampedArray(W2 * H2 * 4).fill(255);
  const set = (x, y, v) => {
    if (x < 0 || y < 0 || x >= W2 || y >= H2) return;
    const i = (y * W2 + x) * 4;
    px2[i] = px2[i + 1] = px2[i + 2] = v;
  };
  for (let x = 0; x < W2; x += 40) for (let y = 0; y < H2; y++) set(x, y, 230); // decoy grid (must stay background)
  for (let x = 80; x <= 340; x++) { set(x, 80, 212); set(x, 200, 212); }        // light walls (drawn over the grid)
  for (let y = 80; y <= 200; y++) { set(80, y, 212); set(340, y, 212); }
  const grey = { width: W2, height: H2, data: px2, toPdf: (x, y) => ({ x, y }), toRaster: (x, y) => ({ x, y }) };
  const ideal = 259 * 119; // wall-face interior, comfortably under the 40%-of-page cap

  const strict = dynamicFill(grey, { x: 200, y: 140 }, 150);
  if (!('error' in strict) || !/not bounded/.test(strict.error)) {
    console.error('FAIL grey-wall room should be unbounded at the strict 150 threshold');
    process.exit(1);
  }
  console.log('grey-wall at strict 150: unbounded as expected →', strict.error);

  const auto = dynamicFill(grey, { x: 200, y: 140 });
  if ('error' in auto) { console.error('FAIL grey-wall room with default ladder:', auto.error); process.exit(1); }
  const aG = area(auto.points);
  if (Math.abs(aG - ideal) / ideal > 0.12) { console.error(`FAIL grey-wall area off: ${aG}`); process.exit(1); }
  console.log(`grey-wall with default ink ladder: bounded, area ${aG.toFixed(0)} (ideal ~${ideal}), grid ignored`);
}

// 5. run-length gate (measured on AEC-Geometric-Bench sheet_02, 2026-10):
//    a room whose door needs the r=44 rung, crossed by a row of text-like
//    26px dashes with 40px gaps. Ungated closing welds the dashes into a
//    false wall at y=140 and slices the room in half; the gate must bridge
//    the door between its long wall flanks while ignoring the short runs.
{
  const W3 = 480, H3 = 320;
  const px3 = new Uint8ClampedArray(W3 * H3 * 4).fill(255);
  const set = (x, y, v = 0) => {
    if (x < 0 || y < 0 || x >= W3 || y >= H3) return;
    const i = (y * W3 + x) * 4;
    px3[i] = px3[i + 1] = px3[i + 2] = v;
  };
  for (let x = 60; x <= 360; x++) { set(x, 50); set(x, 230); }
  for (let y = 50; y <= 230; y++) {
    if (y < 115 || y > 184) set(360, y); // right wall with a 70px door
    set(60, y);
  }
  for (let x0 = 70; x0 <= 334; x0 += 66) for (let x = x0; x < x0 + 26; x++) set(x, 140); // dashed text row
  const shred = { width: W3, height: H3, data: px3, toPdf: (x, y) => ({ x, y }), toRaster: (x, y) => ({ x, y }) };
  const ideal = 299 * 179; // 34.8% of the page — under the unbounded cap

  const r5 = dynamicFill(shred, { x: 200, y: 100 });
  if ('error' in r5) { console.error('FAIL dashed room:', r5.error); process.exit(1); }
  const a5 = area(r5.points);
  if (Math.abs(a5 - ideal) / ideal > 0.12) {
    console.error(`FAIL dashed-room area ${a5} ≈ ${a5 < 0.6 * ideal ? 'half the room — the dashes were welded into a false wall' : 'unexpected'}`);
    process.exit(1);
  }
  console.log(`dashed room with run-length gate: bounded, area ${a5.toFixed(0)} (ideal ~${ideal}), dashes not welded`);
}

const tol = 0.12; // dilation is 2px at most after snapping; 12% headroom
if (Math.abs(aA - 20511) / 20511 > tol) { console.error(`FAIL room A area off: ${aA}`); process.exit(1); }
if (Math.abs(aB - 17331) / 17331 > tol) { console.error(`FAIL room B area off: ${aB}`); process.exit(1); }
console.log('PASS: gap room bounds with area within tolerance; sealed room unchanged; unbounded errors; light-line sheet bounds via the ink ladder; dashed room survives the run-length gate');
