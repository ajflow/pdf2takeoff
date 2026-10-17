#!/usr/bin/env node
// Takeoff accuracy bench (patch-plan-2 P12). Builds vector PDFs with known
// answers (rooms, doors, furniture, symbols, scale notes) using pdf-lib,
// runs them through the same Node raster and text-layer paths the CLI and
// MCP use, and scores each case: room areas (Dynamic Fill), symbol counts
// (scan), and drawing scale (text layer).
//
// Every case states what it expects. A case marked `known` documents a gap a
// later patch targets: it may fail without failing the bench, and the bench
// says so when it starts passing. Any other failure exits non-zero, so CI
// catches regressions.
//
//   node --experimental-strip-types scripts/takeoff-bench.mjs [--json out.json]

import { writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';
import { dynamicFill } from '../src/engine/dynamicfill.ts';
import { cvScan } from '../src/engine/scan-cv.ts';
import { findScaleRatio, roomLabelPoints, wordsFromTextItem } from '../src/engine/ocr.ts';
import { metersPerPtForRatio } from '../src/engine/units.ts';

const SCALE = 100; // drawings below are 1:100
const M = 1 / metersPerPtForRatio(SCALE); // PDF points per real metre (≈ 28.35)
const BLACK = rgb(0, 0, 0);

// --- drawing helpers (real metres → PDF points from an origin) --------------
function sheet(doc, width = 842, height = 595) {
  return doc.addPage([width, height]);
}
const wall = (page, ox, oy, t) => (x0, y0, x1, y1) =>
  page.drawLine({ start: { x: ox + x0 * M, y: oy + y0 * M }, end: { x: ox + x1 * M, y: oy + y1 * M }, thickness: t, color: BLACK });
const pt = (ox, oy, x, y) => ({ x: ox + x * M, y: oy + y * M });

function polyArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

// --- fixtures ------------------------------------------------------------------
const cases = [];
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

// Page 1: rooms. Thin 0.7 pt walls unless noted. Areas are between wall
// centrelines minus half the stroke each side (what the ink leaves open).
{
  const page = sheet(doc);
  const T = 0.7;
  const inner = (wM, hM) => (wM * M - T) * (hM * M - T) / (M * M); // m²

  // A: sealed 4 x 3 m room
  {
    const w = wall(page, 40, 380, T);
    w(0, 0, 4, 0); w(4, 0, 4, 3); w(4, 3, 0, 3); w(0, 3, 0, 0);
    cases.push({ id: 'fill/sealed-room', kind: 'fill', page: 1, at: pt(40, 380, 2, 1.5), expectM2: inner(4, 3) });
  }
  // B: 4 x 3 m room, 0.9 m door to outside in the bottom wall, with returns
  {
    const w = wall(page, 200, 380, T);
    w(0, 0, 1.2, 0); w(2.1, 0, 4, 0); w(4, 0, 4, 3); w(4, 3, 0, 3); w(0, 3, 0, 0);
    cases.push({ id: 'fill/exterior-door', kind: 'fill', page: 1, at: pt(200, 380, 2, 1.5), expectM2: inner(4, 3) });
  }
  // C: 4 x 3 m room with a bench line 0.5 m off the back wall, ends 0.4 m from the side walls
  {
    const w = wall(page, 360, 380, T);
    w(0, 0, 4, 0); w(4, 0, 4, 3); w(4, 3, 0, 3); w(0, 3, 0, 0);
    w(0.4, 2.5, 3.6, 2.5);
    cases.push({ id: 'fill/bench-near-wall', kind: 'fill', page: 1, at: pt(360, 380, 2, 1.0), expectM2: inner(4, 3) });
  }
  // D: L-shaped room, 4 x 3 m minus a 2 x 1.5 m notch
  {
    const w = wall(page, 520, 380, T);
    w(0, 0, 4, 0); w(4, 0, 4, 1.5); w(4, 1.5, 2, 1.5); w(2, 1.5, 2, 3); w(2, 3, 0, 3); w(0, 3, 0, 0);
    const expect = (4 * M - T) * (1.5 * M - T) / (M * M) + (2 * M - T) * (1.5 * M) / (M * M);
    cases.push({ id: 'fill/l-shaped-room', kind: 'fill', page: 1, at: pt(520, 380, 1, 1), expectM2: expect, tol: 0.04 });
  }
  // E: two 3 x 3 m rooms inside a sealed outline, joined by a 0.9 m interior door
  {
    const w = wall(page, 40, 200, T);
    w(0, 0, 6, 0); w(6, 0, 6, 3); w(6, 3, 0, 3); w(0, 3, 0, 0);
    w(3, 0, 3, 1.05); w(3, 1.95, 3, 3);
    page.drawText('BED 1', { x: 40 + 1.2 * M, y: 200 + 2.2 * M, size: 6, font });
    page.drawText('BED 2', { x: 40 + 4.2 * M, y: 200 + 2.2 * M, size: 6, font });
    const at = pt(40, 200, 1.5, 1.0);
    cases.push({ id: 'fill/interior-door', kind: 'fill', page: 1, at, expectM2: inner(3, 3) });
    cases.push({ id: 'fill/interior-door-labels-only', kind: 'fill', page: 1, at, expectM2: inner(3, 3), hints: 'labels' });
    cases.push({ id: 'fill/interior-door-scale-only', kind: 'fill', page: 1, at, expectM2: inner(3, 3), hints: 'scale' });
    cases.push({ id: 'fill/interior-door-no-hints', kind: 'fill', page: 1, at, expectM2: inner(3, 3), hints: 'none', known: 'P13 neck cuts' });
  }
  // F: 4 x 3 m room in 0.2 m filled walls (drawn as filled rectangles), 0.9 m door to outside
  {
    const ox = 360;
    const oy = 200;
    const t = 0.2;
    const rect = (x0, y0, x1, y1) => page.drawRectangle({ x: ox + x0 * M, y: oy + y0 * M, width: (x1 - x0) * M, height: (y1 - y0) * M, color: BLACK });
    rect(-t, -t, 1.2, 0); rect(2.1, -t, 4 + t, 0); rect(4, 0, 4 + t, 3); rect(-t, 3, 4 + t, 3 + t); rect(-t, 0, 0, 3);
    cases.push({ id: 'fill/thick-walls-door', kind: 'fill', page: 1, at: pt(ox, oy, 2, 1.5), expectM2: 4 * 3 });
  }
  // G: room with a diagonal wall carrying a 0.9 m door to outside
  {
    const w = wall(page, 560, 200, T);
    w(0, 0, 4, 0); w(4, 0, 4, 2); w(4, 2, 3, 3); w(3, 3, 0, 3); w(0, 3, 0, 0);
    // door in the diagonal: replace the 4,2 → 3,3 segment with two pieces leaving a gap
    page.drawLine({ start: pt(560, 200, 4, 2), end: pt(560, 200, 3, 3), thickness: T + 1.5, color: rgb(1, 1, 1) });
    w(4, 2, 3.84, 2.16); w(3.16, 2.84, 3, 3);
    const expect = (4 * 3 - 0.5) - 0.06; // 4x3 minus the 1x1 corner triangle, minus stroke allowance
    cases.push({ id: 'fill/diagonal-wall-door', kind: 'fill', page: 1, at: pt(560, 200, 1.5, 1.5), expectM2: expect, tol: 0.05, known: 'P18' });
  }
}

// Page 1b: heavy-wall plan where the partition stops 1 m short of the outer
// wall (a doorway hard against a corner), with a row of downlights that must
// not be chained into a wall.
{
  const page = sheet(doc);
  const ox = 60;
  const oy = 300;
  page.drawRectangle({ x: ox, y: oy, width: 8 * M, height: 5 * M, borderColor: BLACK, borderWidth: 2.4 });
  page.drawLine({ start: pt(ox, oy, 3, 1), end: pt(ox, oy, 3, 5), thickness: 1.6, color: BLACK });
  for (const x of [4.2, 5.4, 6.6]) page.drawCircle({ x: ox + x * M, y: oy + 2.5 * M, size: 6, borderColor: BLACK, borderWidth: 1.1, color: rgb(1, 1, 1) });
  page.drawText('STORE', { x: ox + 1.1 * M, y: oy + 3.2 * M, size: 8, font });
  page.drawText('OFFICE', { x: ox + 5 * M, y: oy + 3.6 * M, size: 8, font });
  const left = ((3 * M - 1.2 - 0.8) * (5 * M - 2.4)) / (M * M);
  const right = ((5 * M - 1.2 - 0.8) * (5 * M - 2.4)) / (M * M);
  cases.push({ id: 'fill/corner-doorway-left', kind: 'fill', page: doc.getPageCount(), at: pt(ox, oy, 1.5, 3), expectM2: left });
  cases.push({ id: 'fill/corner-doorway-downlight-row', kind: 'fill', page: doc.getPageCount(), at: pt(ox, oy, 5, 1.5), expectM2: right });
}

// Page 2: symbol counts. 12 downlight-style symbols (circle + cross) on an
// open floor, plus 3 touching a wall line (the CV scan's declared blind spot).
{
  const page = sheet(doc);
  const sym = (x, y) => {
    page.drawCircle({ x, y, size: 5, borderColor: BLACK, borderWidth: 0.8 });
    page.drawLine({ start: { x: x - 5, y }, end: { x: x + 5, y }, thickness: 0.6, color: BLACK });
    page.drawLine({ start: { x, y: y - 5 }, end: { x, y: y + 5 }, thickness: 0.6, color: BLACK });
  };
  const open = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) open.push([120 + c * 90, 400 - r * 80]);
  open.forEach(([x, y]) => sym(x, y));
  page.drawLine({ start: { x: 80, y: 150 }, end: { x: 600, y: 150 }, thickness: 1.2, color: BLACK });
  const onWall = [[200, 155.5], [320, 155.5], [440, 155.5]];
  onWall.forEach(([x, y]) => sym(x, y));
  cases.push({ id: 'count/open-floor', kind: 'count', page: doc.getPageCount(), at: { x: open[0][0], y: open[0][1] }, expect: open.length, accept: [open.length, open.length + onWall.length] });
  cases.push({ id: 'count/touching-walls', kind: 'count', page: doc.getPageCount(), at: { x: open[0][0], y: open[0][1] }, expect: open.length + onWall.length, known: 'P17' });
}

// Pages 3+: scale notes in the text layer, one sheet each.
const scaleSheets = [
  { id: 'scale/ratio-with-keyword', lines: ['SCALE 1:100 @ A1'], expect: 100 },
  { id: 'scale/ratio-spaced', lines: ['SCALE', '1 : 50'], expect: 50 },
  { id: 'scale/dimension-not-a-scale', lines: ['1200', '3600'], expect: null },
  { id: 'scale/nts', lines: ['SCALE: NTS'], expect: null },
  { id: 'scale/imperial-architectural', lines: ['SCALE: 1/4" = 1\'-0"'], expect: 48 },
  { id: 'scale/imperial-engineering', lines: ['SCALE: 1" = 20\''], expect: 240 },
  { id: 'scale/colon-dropped-after-keyword', lines: ['SCALE 1;100'], expect: 100 },
  { id: 'scale/keyword-beats-detail-ratio', lines: ['DETAIL A 1:20', 'SCALE 1:100'], expect: 100 },
  { id: 'scale/full-size', lines: ['SCALE: FULL SIZE'], expect: 1 },
];
for (const s of scaleSheets) {
  const page = sheet(doc);
  s.lines.forEach((t, i) => page.drawText(t, { x: 600 + i * 40, y: 60, size: 9, font }));
  page.drawText('A-101 GROUND FLOOR PLAN', { x: 600, y: 80, size: 9, font });
  cases.push({ id: s.id, kind: 'scale', page: doc.getPageCount(), expect: s.expect, known: s.known });
}

// --- run -------------------------------------------------------------------------
const pdf = await openPdf(await doc.save());
const mpp = metersPerPtForRatio(SCALE);
const results = [];
for (const c of cases) {
  let got;
  let pass;
  let detail = '';
  try {
    if (c.kind === 'fill') {
      // like the app: room labels from the text layer, scale when calibrated
      const raster = await renderRasterNode(pdf, c.page, RASTER_SCALE);
      const items = (await (await pdf.getPage(c.page)).getTextContent()).items;
      const use = c.hints ?? 'all';
      const hints = {
        ...(use === 'all' || use === 'labels' ? { labels: roomLabelPoints(items) } : {}),
        ...(use === 'all' || use === 'scale' ? { metersPerPt: mpp } : {}),
      };
      const r = dynamicFill(raster, c.at, undefined, hints);
      if ('error' in r) {
        got = null;
        detail = r.error;
        pass = false;
      } else {
        got = polyArea(r.points) * mpp * mpp;
        const err = Math.abs(got - c.expectM2) / c.expectM2;
        pass = err <= (c.tol ?? 0.03);
        detail = `${got.toFixed(2)} m² vs ${c.expectM2.toFixed(2)} m² (${(err * 100).toFixed(1)}%)`;
      }
    } else if (c.kind === 'count') {
      const raster = await renderRasterNode(pdf, c.page, RASTER_SCALE);
      const r = cvScan(raster, c.at);
      got = 'error' in r ? 0 : r.hits.length;
      pass = (c.accept ?? [c.expect]).includes(got);
      detail = `${got} found, ${c.expect} expected`;
    } else {
      const tc = await (await pdf.getPage(c.page)).getTextContent();
      const words = tc.items.flatMap((it) => wordsFromTextItem(it.str ?? '', it.transform, it.width, it.height));
      const hit = findScaleRatio(words, 'text layer');
      got = hit ? hit.ratio : null;
      pass = got === c.expect;
      detail = `${got === null ? 'no scale' : `1:${got}`}, ${c.expect === null ? 'no scale' : `1:${c.expect}`} expected`;
    }
  } catch (err) {
    got = null;
    pass = false;
    detail = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  results.push({ id: c.id, kind: c.kind, pass, known: c.known ?? null, got, detail });
}

// --- report ------------------------------------------------------------------------
let regressions = 0;
let fixedKnown = 0;
for (const r of results) {
  const tag = r.pass ? (r.known ? 'PASS*' : 'pass ') : r.known ? `known` : 'FAIL ';
  if (!r.pass && !r.known) regressions++;
  if (r.pass && r.known) fixedKnown++;
  console.log(`${tag}  ${r.id.padEnd(34)} ${r.detail}${r.known && !r.pass ? `  (target: ${r.known})` : ''}`);
}
const byKind = {};
for (const r of results) {
  byKind[r.kind] ??= { pass: 0, total: 0 };
  byKind[r.kind].total++;
  if (r.pass) byKind[r.kind].pass++;
}
console.log(
  '\n' + Object.entries(byKind).map(([k, v]) => `${k}: ${v.pass}/${v.total}`).join('  ·  ') +
    `  ·  known gaps open: ${results.filter((r) => r.known && !r.pass).length}`,
);
if (fixedKnown) console.log(`${fixedKnown} known case(s) now pass (PASS*): drop their \`known\` marker to lock them in.`);
const jsonAt = process.argv.indexOf('--json');
if (jsonAt > 0 && process.argv[jsonAt + 1]) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(results, null, 2) + '\n');
if (regressions) {
  console.error(`\nFAIL: ${regressions} regression(s) outside the known gaps`);
  process.exit(1);
}
console.log('\ntakeoff bench: no regressions');
