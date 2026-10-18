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
//   6. a look-alike pair differing by one interior dot (globe against gate
//      valve) is not cross-counted in either direction (the look-alike gate
//      on the localized difference; the signature distance alone lets the
//      dotted ones through)
//   7. symbols fused with a touching text tag count once the tag boxes are
//      supplied as textBoxes (and count 1 without them)
//   8. 8 siblings of which 3 are lightly degraded (1 px erosion over a
//      growing part of the symbol): under the per-sheet threshold they all
//      count with or without expansion (the degraded ones are true siblings
//      inside the band); under a fixed 0.15 they count 8 with expansion
//      and 7 without
//   9. autoThreshold itself: a noise-floor gap inside the sibling band
//      (render spread between siblings, all within MATCH_DIST) must not
//      cut the cluster; clear edges still do
// Everything is drawn with a 2 px stroke (thicker where a case says so) so
// the measured stroke width, the run threshold and the stub rule are
// exercised at a realistic ratio.

import { cvScan, autoThreshold } from '../src/engine/scan-cv.ts';
import { estimateStrokeWidth, removeLines } from '../src/engine/line-removal.ts';

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL ' + msg);
};

function sheet(W, H, penSize = 2) {
  const px = new Uint8ClampedArray(W * H * 4).fill(255);
  const dot = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = 0;
  };
  // the pen: every drawn point covers a penSize x penSize block (2 px by default)
  const pen = (x, y) => {
    for (let dy = 0; dy < penSize; dy++) for (let dx = 0; dx < penSize; dx++) dot(x + dx, y + dy);
  };
  const fill = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) dot(x, y);
  };
  // 1 px erosion of the ink inside a box: a pixel survives only when its 4 neighbours are ink
  const erode = (x0, y0, x1, y1) => {
    const ink = (x, y) => x >= 0 && y >= 0 && x < W && y < H && px[(y * W + x) * 4] < 128;
    const keep = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ink(x, y) && ink(x - 1, y) && ink(x + 1, y) && ink(x, y - 1) && ink(x, y + 1)) keep.push(y * W + x);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 255;
    }
    for (const i of keep) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 0;
  };
  const line = (x0, y0, x1, y1) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) pen(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n));
  };
  const circle = (cx, cy, r) => {
    for (let a = 0; a < 360; a += 2) pen(Math.round(cx + r * Math.cos((a * Math.PI) / 180)), Math.round(cy + r * Math.sin((a * Math.PI) / 180)));
  };
  const raster = { width: W, height: H, data: px, toPdf: (x, y) => ({ x, y: H - y }), toRaster: (x, y) => ({ x, y: H - y }) };
  return { pen, line, circle, fill, erode, raster, mask: () => {
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

// --- 6. look-alikes: 5 bowtie valves and 3 bowties with a filled dot at the waist (globe valve)
{
  const s = sheet(1000, 300);
  const valve = (x, y, dot) => {
    s.line(x - 12, y - 9, x - 12, y + 9);
    s.line(x - 12, y - 9, x, y);
    s.line(x - 12, y + 9, x, y);
    s.line(x + 12, y - 9, x + 12, y + 9);
    s.line(x + 12, y - 9, x, y);
    s.line(x + 12, y + 9, x, y);
    if (dot) s.fill(x - 3, y - 3, x + 5, y + 5); // a 9 px dot on a 26 px symbol
  };
  const plain = [[100, 80], [250, 80], [400, 80], [550, 80], [700, 80]];
  const dotted = [[100, 200], [250, 200], [400, 200]];
  plain.forEach(([x, y]) => valve(x, y, false));
  dotted.forEach(([x, y]) => valve(x, y, true));
  const got = count(s.raster, 100 - 12, 80);
  if (got !== plain.length) fail(`look-alikes: expected ${plain.length} plain valves, got ${JSON.stringify(got)}`);
  else console.log(`look-alikes: ${plain.length} plain valves counted, the dotted ones excluded`);
  const dots = count(s.raster, 100 - 12, 200);
  if (dots !== dotted.length) fail(`look-alikes: expected ${dotted.length} dotted valves, got ${JSON.stringify(dots)}`);
  else console.log(`look-alikes: ${dotted.length} dotted valves counted from a click on one of them`);
  const ungated = count(s.raster, 100 - 12, 80, { lookAlike: false, matchDistance: 0.15 });
  if (ungated !== plain.length + dotted.length) fail(`look-alikes: without the gate the dot should be within the signature distance (expected 8, got ${JSON.stringify(ungated)}); the case no longer exercises it`);
  else console.log('look-alikes: the signature distance alone counts all 8 (the gate is what separates them)');
}

// --- 7. symbols fused with a touching text tag: 5 boxed circles, 4 of them with glyph-like tags on the top edge
{
  const s = sheet(1200, 300);
  const box = (x, y) => {
    s.line(x - 20, y - 15, x + 20, y - 15);
    s.line(x + 20, y - 15, x + 20, y + 15);
    s.line(x + 20, y + 15, x - 20, y + 15);
    s.line(x - 20, y + 15, x - 20, y - 15);
    s.circle(x, y, 8);
  };
  // a tag of n glyph-like strokes whose stems touch the box's top edge; the tags differ so the fused components differ
  const tag = (x, y, n) => {
    for (let i = 0; i < n; i++) {
      const gx = x - 18 + i * 9;
      s.line(gx, y - 27, gx, y - 15);
      s.line(gx, y - 27, gx + 5, y - 27);
      if (i % 2) s.line(gx, y - 21, gx + 5, y - 21);
      else s.line(gx + 5, y - 27, gx + 5, y - 21);
    }
  };
  const xs = [100, 300, 500, 700, 900];
  xs.forEach((x, i) => {
    box(x, 150);
    if (i > 0) tag(x, 150, 2 + (i % 3));
  });
  const textBoxes = xs.slice(1).map((x) => ({ x0: x - 20, y0: 150 - 29, x1: x + 20, y1: 150 - 15 }));
  const fused = count(s.raster, 100 - 20, 150);
  if (fused !== 1) fail(`text tags: expected the fused symbols to count 1 without text boxes, got ${JSON.stringify(fused)}`);
  const masked = count(s.raster, 100 - 20, 150, { textBoxes });
  if (masked !== xs.length) fail(`text tags: expected ${xs.length} with the tags masked, got ${JSON.stringify(masked)}`);
  else console.log(`text tags: ${xs.length} counted with the tag boxes erased (${fused} without)`);
  const r = cvScan(s.raster, { x: 100 - 20, y: 300 - 150 }, { textBoxes });
  if ('error' in r || r.cv?.textBoxesMasked !== textBoxes.length) fail(`text tags: expected cv.textBoxesMasked ${textBoxes.length}, got ${JSON.stringify('error' in r ? r : r.cv)}`);
  // a click inside a text box keeps that box: the glyph under the click is the symbol then
  const onTag = cvScan(s.raster, { x: 300 - 18, y: 300 - (150 - 21) }, { textBoxes, removeLines: false });
  if ('error' in onTag || onTag.cv?.textBoxesMasked !== textBoxes.length - 1) fail(`text tags: a click inside a box should erase only the other ${textBoxes.length - 1}, got ${JSON.stringify('error' in onTag ? onTag : onTag.cv)}`);
  else console.log('text tags: the box under the click is kept');
}

// --- 8. template expansion: 5 intact siblings and 3 eroded over a growing part (a quarter, a half, nearly all)
{
  const sym = (s, x, y) => {
    s.line(x - 18, y - 18, x + 18, y - 18);
    s.line(x + 18, y - 18, x + 18, y + 18);
    s.line(x + 18, y + 18, x - 18, y + 18);
    s.line(x - 18, y + 18, x - 18, y - 18);
    s.line(x - 18, y - 18, x + 18, y + 18);
    s.line(x - 18, y, x + 18, y);
  };
  const pos = [[100, 100], [300, 100], [500, 100], [700, 100], [900, 100], [300, 300], [600, 300], [900, 300]];
  const make = (penSize, fractions) => {
    const s = sheet(1200, 400, penSize);
    pos.forEach(([x, y]) => sym(s, x, y));
    pos.slice(5).forEach(([x, y], i) => s.erode(x - 20, y - 20, x - 20 + Math.round(fractions[i] * 42), y + 22));
    return s;
  };
  // per-sheet threshold: the farthest sibling sits just past it and inside a nearer sibling's
  const auto = make(5, [0.25, 0.5, 0.875]);
  const on = cvScan(auto.raster, { x: 100 - 18, y: 400 - 100 });
  const off = count(auto.raster, 100 - 18, 100, { expand: false });
  if ('error' in on || on.hits.length !== pos.length) fail(`expansion (auto threshold): expected ${pos.length}, got ${JSON.stringify('error' in on ? on : on.hits.length)}`);
  else if (!on.cv || on.cv.expansionRounds < 1 || on.cv.templates < 2) fail(`expansion (auto threshold): expected at least one round, got ${JSON.stringify(on.cv)}`);
  else console.log(`expansion (auto threshold): ${pos.length} counted after ${on.cv.expansionRounds} round(s), ${on.cv.templates} templates, threshold ${on.cv.matchDistance}`);
  // the degraded siblings are all true siblings inside the MATCH_DIST band:
  // since the sibling-band hardening, the auto threshold keeps them on its own
  // (noise-floor gaps no longer cut the cluster), so expansion adds nothing
  // here — the fixed-threshold variant below is what pins the mechanism
  if (off !== pos.length) fail(`expansion off (auto threshold): expected ${pos.length} (degraded siblings stay inside the hardened threshold), got ${JSON.stringify(off)}`);
  else console.log(`expansion off (auto threshold): ${off} counted (all siblings within the hardened threshold)`);
  // fixed threshold: the same chain, two rounds deep
  const fixed = make(4, [0.125, 0.375, 0.625]);
  const onF = count(fixed.raster, 100 - 18, 100, { matchDistance: 0.15 });
  const offF = count(fixed.raster, 100 - 18, 100, { matchDistance: 0.15, expand: false });
  if (onF !== pos.length) fail(`expansion (fixed 0.15): expected ${pos.length}, got ${JSON.stringify(onF)}`);
  if (offF !== pos.length - 1) fail(`expansion off (fixed 0.15): expected ${pos.length - 1}, got ${JSON.stringify(offF)}`);
  if (onF === pos.length && offF === pos.length - 1) console.log(`expansion (fixed 0.15): ${onF} counted with expansion, ${offF} without`);
}

// --- 9. autoThreshold directly: a noise-floor gap must not cut the sibling band
{
  const near = (t, want, why) => {
    const got = autoThreshold(t);
    if (got === null || Math.abs(got - want) > 0.001) fail(`autoThreshold ${why}: ${JSON.stringify(t)} -> ${got}, expected ${want}`);
  };
  // render spread inside the sibling cluster: the 0.03 gaps between 0.10..0.16
  // are noise, not class edges; the cut lands past the last member the constant
  // MATCH_DIST (0.15) would keep, at the gap to the first clear non-member
  near([0.1, 0.1, 0.13, 0.13, 0.16, 0.16, 0.4, 0.5], 0.145, 'intra-cluster noise gaps');
  // a wide gap right at the band edge still tightens below the constant
  near([0.06, 0.08, 0.11, 0.3, 0.5], 0.14, 'clear edge at 0.11');
  // identical renders then look-alikes: the big gap below the floor still wins
  // (returned clamped up to AUTO_MIN = 0.1)
  near([0.01, 0.02, 0.12, 0.3], 0.1, 'pixel-identical cluster');
  // continuous distribution running past AUTO_MAX: no gap anywhere, the
  // caller keeps the constant (a vector ending before AUTO_MAX would hit the
  // gap-to-nothing sentinel after the last member and legitimately cut there)
  if (autoThreshold([0.05, 0.07, 0.09, 0.11, 0.13, 0.15, 0.17, 0.19, 0.21, 0.23]) !== null) fail('autoThreshold continuous distribution should be null');
  console.log('autoThreshold: noise-floor gaps do not cut the sibling band, clear edges do');
}

if (failures) {
  console.error(`\nscan check: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nscan check OK');
