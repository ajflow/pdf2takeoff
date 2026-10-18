#!/usr/bin/env node
// Behavioural check for the raster opening detector (src/engine/openings.ts).
// Builds a 1:100 floor plan with pdf-lib: 0.2 m outer walls, 0.1 m
// partitions, four rooms, five door gaps (one of them a double door, so six
// leaves), four Window gaps (two adjacent across a thin mullion, which the
// benchmark counts as one group), one bare passage, furniture and labels.
// Renders it through the same Node raster path the CLI uses and asserts the
// exact counts: 6 doors, 4 Window groups, 4 spaces, and no door or Window
// on the passage. Exits non-zero on any miscount.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';
import { countEnclosedSpaces, detectOpenings } from '../src/engine/openings.ts';

const W = 842;
const H = 595;
const M = 28.35; // pt per metre at 1:100
const OX = 60; // plan origin (pt from the left)
const OY = 60; // plan origin (pt from the top; y grows downward in plan coordinates)
const BLACK = rgb(0, 0, 0);
const OUTER = 0.2 * M; // outer wall thickness (pt)
const INNER = 0.1 * M; // partition thickness (pt)
const THIN = 0.5; // arcs, leaves, glazing, furniture

const doc = await PDFDocument.create();
const page = doc.addPage([W, H]);
const font = await doc.embedFont(StandardFonts.Helvetica);
// plan metres (y down) to page points (y up)
const P = (x, y) => ({ x: OX + x * M, y: H - (OY + y * M) });
const wall = (x0, y0, x1, y1, thickness) => page.drawLine({ start: P(x0, y0), end: P(x1, y1), thickness, color: BLACK });
const thin = (x0, y0, x1, y1) => wall(x0, y0, x1, y1, THIN);
/** quarter arc from a to b around centre c (plan metres), drawn as a thin stroke */
const arc = (cx, cy, r, a0, a1) => {
  const n = 24;
  for (let i = 0; i < n; i++) {
    const t0 = a0 + ((a1 - a0) * i) / n;
    const t1 = a0 + ((a1 - a0) * (i + 1)) / n;
    thin(cx + r * Math.cos(t0), cy + r * Math.sin(t0), cx + r * Math.cos(t1), cy + r * Math.sin(t1));
  }
};
// door in a vertical wall at x, gap y0..y0+width, hinge at the y0 end, leaf
// swinging toward +x (dir = 1) or -x (dir = -1)
const doorV = (x, y0, width, dir, hingeAtEnd = false) => {
  const hy = hingeAtEnd ? y0 + width : y0;
  const sgn = hingeAtEnd ? -1 : 1;
  thin(x, hy, x + dir * width, hy); // leaf
  // arc from the leaf tip to the far jamb
  const a0 = dir > 0 ? 0 : Math.PI;
  const a1raw = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
  // keep the sweep to a quarter turn: from pi the -y jamb sits at 3pi/2
  const a1 = dir < 0 && a1raw < 0 ? a1raw + 2 * Math.PI : a1raw;
  arc(x, hy, width, a0, a1);
};
// door in a horizontal wall at y, gap x0..x0+width, hinge at the x0 end (or the far end), leaf toward +y or -y
const doorH = (y, x0, width, dir, hingeAtEnd = false) => {
  const hx = hingeAtEnd ? x0 + width : x0;
  thin(hx, y, hx, y + dir * width); // leaf
  const leafAngle = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  const jambAngle = hingeAtEnd ? (dir < 0 ? -Math.PI : Math.PI) : 0;
  arc(hx, y, width, leafAngle, jambAngle);
};
// Window: two glazing lines along the gap, 0.05 m either side of the wall centreline
const windowH = (y, x0, x1) => { thin(x0, y - 0.05, x1, y - 0.05); thin(x0, y + 0.05, x1, y + 0.05); };
const windowV = (x, y0, y1) => { thin(x - 0.05, y0, x - 0.05, y1); thin(x + 0.05, y0, x + 0.05, y1); };

// --- building 12 x 8 m: rooms A (0-4 x 0-8), B (4-12 x 0-4), C (4-8 x 4-8), D (8-12 x 4-8)
// outer walls, with gaps for the Windows and the entrance door
wall(0, 0, 1, 0, OUTER); wall(2.2, 0, 6, 0, OUTER); wall(7.2, 0, 12.1, 0, OUTER); // top: Windows at 1..2.2 and 6..7.2
wall(0, 8, 1.5, 8, OUTER); wall(2.4, 8, 12.1, 8, OUTER); // bottom: entrance door at 1.5..2.4
wall(0, -0.1, 0, 5, OUTER); wall(0, 6.2, 0, 8.1, OUTER); // left: Window at 5..6.2
wall(12, -0.1, 12, 1, OUTER); wall(12, 2, 12, 2.08, OUTER); wall(12, 3.08, 12, 8.1, OUTER); // right: Window pair 1..2 and 2.08..3.08, 0.08 m mullion
// partitions with door gaps
wall(4, 0, 4, 1.5, INNER); wall(4, 2.4, 4, 8, INNER); // x=4: door at 1.5..2.4
wall(4, 4, 5, 4, INNER); wall(5.9, 4, 9.5, 4, INNER); wall(11.1, 4, 12, 4, INNER); // y=4: door at 5..5.9, double door at 9.5..11.1
wall(8, 4, 8, 4.5, INNER); wall(8, 5.5, 8, 6, INNER); wall(8, 6.9, 8, 8, INNER); // x=8: passage at 4.5..5.5, door at 6..6.9
// doors (6 leaves)
doorV(4, 1.5, 0.9, -1); // A/B, swings into A
doorH(4, 5, 0.9, 1, true); // B/C, hinge at x=5.9, swings into C
doorV(8, 6, 0.9, 1, true); // C/D, hinge at y=6.9, swings into D
doorH(8, 1.5, 0.9, -1); // entrance, hinge at x=1.5, swings up into A
doorH(4, 9.5, 0.8, 1); doorH(4, 10.3, 0.8, 1, true); // double door, two 0.8 m leaves into D
// Windows (4 groups)
windowH(0, 1, 2.2); windowH(0, 6, 7.2); windowV(0, 5, 6.2); windowV(12, 1, 2); windowV(12, 2.08, 3.08);
// furniture and labels that must not count
page.drawRectangle({ x: P(0.4, 0.4).x, y: P(0.4, 2.4).y, width: 1.6 * M, height: 2 * M, borderColor: BLACK, borderWidth: THIN }); // bed in A
page.drawCircle({ x: P(6, 6.5).x, y: P(6, 6.5).y, size: 0.5 * M, borderColor: BLACK, borderWidth: THIN }); // table in C
page.drawRectangle({ x: P(9, 0.3).x, y: P(9, 0.9).y, width: 2.5 * M, height: 0.6 * M, borderColor: BLACK, borderWidth: THIN }); // bench in B
for (const [t, x, y] of [['ROOM A', 1.2, 5], ['ROOM B', 7, 2], ['ROOM C', 5, 5], ['ROOM D', 9.5, 6.5], ['GROUND FLOOR 1:100', 0, 9]]) {
  page.drawText(t, { x: P(x, y).x, y: P(x, y).y, size: 7, font });
}

const pdf = await openPdf(await doc.save());
const raster = await renderRasterNode(pdf, 1, RASTER_SCALE);
const res = detectOpenings(raster);
const spaces = countEnclosedSpaces(raster, {}, res);

// --debug out.png: the page with the wall mask tinted, spaces shaded and openings boxed
const dbgAt = process.argv.indexOf('--debug');
if (dbgAt > 0 && process.argv[dbgAt + 1]) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const { writeFileSync } = await import('node:fs');
  const cnv = createCanvas(raster.width, raster.height);
  const ctx = cnv.getContext('2d');
  const img = ctx.createImageData(raster.width, raster.height);
  const { mask, width: mw, scale: s } = res.walls;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const p = (y * raster.width + x) * 4;
      const wallHere = mask[y * s * mw + x * s];
      img.data[p] = wallHere ? 200 : raster.data[p];
      img.data[p + 1] = wallHere ? 150 : raster.data[p + 1];
      img.data[p + 2] = wallHere ? 0 : raster.data[p + 2];
      img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineWidth = 2;
  for (const sp of spaces.spaces) { ctx.fillStyle = 'rgba(0,160,0,0.15)'; ctx.fillRect(sp.x0, sp.y0, sp.x1 - sp.x0 + 1, sp.y1 - sp.y0 + 1); }
  const box = (o, c) => { ctx.strokeStyle = c; ctx.strokeRect(o.px.x0, o.px.y0, o.px.x1 - o.px.x0 + 1, o.px.y1 - o.px.y0 + 1); };
  res.passages.forEach((p) => box(p, 'gray'));
  res.windows.forEach((p) => box(p, 'blue'));
  res.doors.forEach((p) => box(p, 'red'));
  writeFileSync(process.argv[dbgAt + 1], cnv.toBuffer('image/png'));
}

const expect = { doors: 6, windows: 4, spaces: 4 };
const got = { doors: res.doors.length, windows: res.windows.length, spaces: spaces.count };
console.log(
  `walls: t=${res.walls.thicknessPx.toFixed(1)}px close=${res.walls.closeRadiusPx} kernel=${res.walls.kernelPx} ` +
    `(partition ${(INNER * RASTER_SCALE).toFixed(1)}px, outer ${(OUTER * RASTER_SCALE).toFixed(1)}px)`,
);
console.log(`doors ${got.doors}/${expect.doors}, Window groups ${got.windows}/${expect.windows}, spaces ${got.spaces}/${expect.spaces}, passages ${res.passages.length}`);
let fail = false;
for (const k of Object.keys(expect)) {
  if (got[k] !== expect[k]) { console.error(`FAIL ${k}: ${got[k]} found, ${expect[k]} expected`); fail = true; }
}
if (res.passages.length < 1) { console.error('FAIL passage: the bare gap must be reported as a passage'); fail = true; }
if (fail) {
  for (const d of res.doors) console.error(`  door   ${JSON.stringify(d.px)} r=${d.hinge?.radiusPx.toFixed(0)} score=${d.score.toFixed(2)}`);
  for (const w of res.windows) console.error(`  Window ${JSON.stringify(w.px)} units=${w.units} score=${w.score.toFixed(2)}`);
  for (const p of res.passages) {
    console.error(`  passage ${JSON.stringify(p.px)} lines=${p.detail.lines} union=${p.detail.union.toFixed(2)} clutter=${p.detail.clutter.toFixed(2)}`);
    for (const a of p.detail.arcs) console.error(`    arc ${a.jamb}${a.side > 0 ? '+' : '-'}${a.half ? ' half' : ''} score=${a.score.toFixed(2)} r=${a.radiusPx.toFixed(0)} leaf=${a.leaf.toFixed(2)}`);
  }
  for (const s of spaces.regions) console.error(`  region ${s.x0},${s.y0}..${s.x1},${s.y1} area=${s.areaPx}${s.dropped ? ` dropped: ${s.dropped}` : ''}`);
  process.exit(1);
}
console.log('PASS: synthetic plan counted exactly (6 door leaves incl. a double door, 4 Window groups incl. a merged pair, 4 spaces)');
