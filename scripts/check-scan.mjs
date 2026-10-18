#!/usr/bin/env node
// Behavioural check for the tier-1 CV scan (src/engine/scan-cv.ts) and its
// line-removal pre-pass (src/engine/line-removal.ts). Builds small rasters
// with a pixel pen, the way check-fill.mjs does, and asserts the counts:
//   1. free-standing symbols count exactly, and a look-alike that differs by
//      one stroke is not counted (the plain path, unchanged behaviour)
//   2. N identical symbols sitting on one long pipe count N after a click
//      on one of them (line removal + stub removal)
//   3. symbols at 0/90/180/270 degrees and mirrored all count (dihedral match)
//   4. symbols hung off a dashed line count (dash-chain removal)
//   5. removeLines itself: the pipe goes, the symbol ink stays, and the
//      removed mask reports what was dropped
// Everything is drawn with a 2 px stroke so the measured stroke width, the
// run threshold and the stub rule are exercised at a realistic ratio.

import { cvScan } from '../src/engine/scan-cv.ts';
import { estimateStrokeWidth, removeLines } from '../src/engine/line-removal.ts';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL ' + msg);
};

function sheet(W, H) {
  const px = new Uint8ClampedArray(W * H * 4).fill(255);
  const dot = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = 0;
  };
  // a 2 px pen: every drawn point covers a 2x2 block
  const pen = (x, y) => {
    dot(x, y);
    dot(x + 1, y);
    dot(x, y + 1);
    dot(x + 1, y + 1);
  };
  const line = (x0, y0, x1, y1) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) pen(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n));
  };
  const circle = (cx, cy, r) => {
    for (let a = 0; a < 360; a += 2) pen(Math.round(cx + r * Math.cos((a * Math.PI) / 180)), Math.round(cy + r * Math.sin((a * Math.PI) / 180)));
  };
  const raster = { width: W, height: H, data: px, toPdf: (x, y) => ({ x, y: H - y }), toRaster: (x, y) => ({ x, y: H - y }) };
  return { pen, line, circle, raster, mask: () => {
    const m = new Uint8Array(W * H);
    for (let i = 0; i < m.length; i++) m[i] = px[i * 4] < 150 ? 1 : 0;
    return m;
  } };
}

const count = (raster, x, y, opts) => {
  const r = cvScan(raster, { x, y: raster.height - y }, opts);
  return 'error' in r ? r : r.hits.length;
};

// --- 1. free-standing symbols: 8 downlights (circle + cross), 3 look-alikes (circle only), 2 bigger circles
{
  const s = sheet(900, 400);
  const downlight = (x, y) => {
    s.circle(x, y, 14);
    s.line(x - 14, y, x + 14, y);
    s.line(x, y - 14, x, y + 14);
  };
  const dl = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) dl.push([100 + c * 120, 80 + r * 100]);
  dl.forEach(([x, y]) => downlight(x, y));
  for (let c = 0; c < 3; c++) s.circle(100 + c * 120, 300, 14);
  s.circle(600, 300, 22);
  s.circle(720, 300, 22);
  const got = count(s.raster, dl[0][0] + 14, dl[0][1]);
  if (got !== 8) fail(`free-standing downlights: expected 8, got ${JSON.stringify(got)}`);
  else console.log('free-standing: 8 downlights counted, circles and bigger circles excluded');
  const plain = count(s.raster, 100 + 14, 300, { removeLines: false });
  if (plain !== 3) fail(`free-standing circles (plain path): expected 3, got ${JSON.stringify(plain)}`);
  else console.log('free-standing: 3 plain circles counted on their own');
}

// --- 2. N symbols on one long pipe: bowtie valves (two triangles) straddling a 1000 px line
{
  const s = sheet(1200, 300);
  const valve = (x, y) => {
    // left triangle, right triangle, apexes meeting at (x, y); 24 wide, 18 tall
    s.line(x - 12, y - 9, x - 12, y + 9);
    s.line(x - 12, y - 9, x, y);
    s.line(x - 12, y + 9, x, y);
    s.line(x + 12, y - 9, x + 12, y + 9);
    s.line(x + 12, y - 9, x, y);
    s.line(x + 12, y + 9, x, y);
  };
  s.line(50, 150, 1150, 150); // the pipe, through every valve's centre line
  s.line(300, 40, 300, 150); // a branch meeting the pipe at a tee
  s.line(900, 150, 900, 260); // another branch
  const xs = [150, 350, 500, 650, 800, 1000];
  xs.forEach((x) => valve(x, 150));
  const got = count(s.raster, 150 - 12, 142);
  if (got !== xs.length) fail(`valves on a pipe: expected ${xs.length}, got ${JSON.stringify(got)}`);
  else console.log(`on-pipe: ${xs.length} valves counted through the line removal`);
  const r = cvScan(s.raster, { x: 150 - 12, y: 300 - 142 });
  if ('error' in r || !r.lineRemoval || r.lineRemoval.trigger !== 'large-component') fail(`on-pipe: expected the large-component trigger, got ${JSON.stringify(r)}`);
  const off = count(s.raster, 150 - 12, 142, { removeLines: false });
  if (typeof off === 'number' && off === xs.length) fail('on-pipe: the plain path counted the fused valves, the check no longer exercises line removal');
  else console.log(`on-pipe: without the pre-pass the click lands on the pipe network (${JSON.stringify(off)})`);
}

// --- 3. rotations and mirrors: an L-shaped symbol (a door leaf with a stop) at 0/90/180/270 and flipped
{
  const s = sheet(900, 500);
  const sym = (x, y, k, flip) => {
    // asymmetric glyph: a 30x20 box with a diagonal from one corner, rotated k * 90 degrees, mirrored when flip
    const pts = [
      [[-15, -10], [15, -10]], [[15, -10], [15, 10]], [[15, 10], [-15, 10]], [[-15, 10], [-15, -10]],
      [[-15, -10], [15, 10]], [[0, -10], [0, 2]],
    ];
    const rot = ([px, py]) => {
      let [a, b] = flip ? [-px, py] : [px, py];
      for (let i = 0; i < k; i++) [a, b] = [-b, a];
      return [x + a, y + b];
    };
    for (const [p, q] of pts) {
      const [ax, ay] = rot(p);
      const [bx, by] = rot(q);
      s.line(ax, ay, bx, by);
    }
  };
  const placed = [
    [100, 100, 0, false], [250, 100, 1, false], [400, 100, 2, false], [550, 100, 3, false],
    [100, 300, 0, true], [250, 300, 1, true], [400, 300, 2, true], [550, 300, 3, true],
  ];
  placed.forEach(([x, y, k, f]) => sym(x, y, k, f));
  s.circle(750, 100, 16); // unrelated
  const got = count(s.raster, 100 - 15, 100);
  if (got !== placed.length) fail(`rotations: expected ${placed.length}, got ${JSON.stringify(got)}`);
  else console.log(`rotations: all ${placed.length} orientations and mirrors counted`);
  const upright = count(s.raster, 100 - 15, 100, { dihedral: false });
  if (upright !== 2) fail(`rotations with dihedral off: expected 2 (the upright pair), got ${JSON.stringify(upright)}`);
  else console.log('rotations: dihedral off counts only the 2 same-orientation siblings');
}

// --- 4. symbols hung off a dashed line (instrument signal line) through short stubs
{
  const s = sheet(1200, 300);
  for (let x = 40; x < 1160; x += 24) s.line(x, 60, x + 12, 60); // dashes 12 on, 12 off
  const xs = [150, 400, 650, 900];
  xs.forEach((x) => {
    s.line(x, 60, x, 120); // stub down to the box
    s.line(x - 20, 120, x + 20, 120);
    s.line(x + 20, 120, x + 20, 160);
    s.line(x + 20, 160, x - 20, 160);
    s.line(x - 20, 160, x - 20, 120);
  });
  s.line(60, 240, 1140, 240); // a solid pipe nearby, not touching
  const got = count(s.raster, 150 - 20, 140, { removeLines: true });
  if (got !== xs.length) fail(`dashed line: expected ${xs.length} boxes, got ${JSON.stringify(got)}`);
  else console.log(`dashed line: ${xs.length} boxes counted after dash and stub removal`);
}

// --- 5. removeLines on its own: pipe gone, symbol kept, report filled in
{
  const s = sheet(600, 200);
  s.line(20, 100, 580, 100);
  s.circle(300, 100, 20);
  s.line(300, 20, 300, 180);
  const mask = s.mask();
  const sw = estimateStrokeWidth(mask, 600, 200);
  if (sw !== 2) fail(`stroke width: expected 2, got ${sw}`);
  const lr = removeLines(mask, 600, 200, { strokeWidth: sw });
  let keptOnPipe = 0;
  for (let x = 40; x < 260; x++) for (let y = 99; y <= 102; y++) if (lr.cleaned[y * 600 + x]) keptOnPipe++;
  let keptCircle = 0;
  for (let a = 0; a < 360; a += 10) {
    const x = Math.round(300 + 20 * Math.cos((a * Math.PI) / 180));
    const y = Math.round(300 - 300 + 100 + 20 * Math.sin((a * Math.PI) / 180));
    if (lr.cleaned[y * 600 + x] || lr.cleaned[y * 600 + x + 1] || lr.cleaned[(y + 1) * 600 + x]) keptCircle++;
  }
  if (keptOnPipe) fail(`removeLines: ${keptOnPipe} pipe pixels survived`);
  if (keptCircle < 30) fail(`removeLines: the circle lost its ink (${keptCircle}/36 samples kept)`);
  if (lr.removedPx < 1000 || lr.minRun !== 60) fail(`removeLines report: ${JSON.stringify({ removedPx: lr.removedPx, minRun: lr.minRun })}`);
  if (!failures) console.log(`removeLines: pipe dropped (${lr.removedPx} px), circle kept (${keptCircle}/36 samples), minRun ${lr.minRun}`);
}

if (failures) {
  console.error(`\nscan check: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nscan check OK');
