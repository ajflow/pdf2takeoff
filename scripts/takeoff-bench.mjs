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
import { dynamicFill, sheetDoorWidthPx } from '../src/engine/dynamicfill.ts';
import { doorWidthCheck } from '../src/engine/scale.ts';
import { scanDocAt, vectorDocPage } from '../src/headless/ops.ts';
import { doorBridgesFor } from '../src/engine/fill-vector.ts';
import { findScaleRatio, roomLabelPoints, wordsFromTextItem } from '../src/engine/ocr.ts';
import { metersPerPtForRatio } from '../src/engine/units.ts';

const SCALE = 100; // drawings below are 1:100
const M = 1 / metersPerPtForRatio(SCALE); // PDF points per real metre (≈ 28.35)
const BLACK = rgb(0, 0, 0);

// --- drawing helpers (real metres → PDF points from an origin) --------------
// Every sheet carries what real sheets carry: a border frame and a title
// block with text. Rules that read the sheet (door widths, scale notes) must
// hold with those present, and an "outside" bounded by a frame must still
// read as unbounded.
let sheetNo = 0;
function sheet(doc, width = 842, height = 595) {
  const page = doc.addPage([width, height]);
  sheetNo++;
  page.drawRectangle({ x: 12, y: 12, width: width - 24, height: height - 24, borderColor: BLACK, borderWidth: 0.8 });
  const tb = { x: width - 12 - 190, y: 12, w: 190, h: 44 };
  page.drawRectangle({ x: tb.x, y: tb.y, width: tb.w, height: tb.h, borderColor: BLACK, borderWidth: 0.8 });
  page.drawLine({ start: { x: tb.x, y: tb.y + 22 }, end: { x: tb.x + tb.w, y: tb.y + 22 }, thickness: 0.5, color: BLACK });
  page.drawText(`BENCH SHEET ${sheetNo}`, { x: tb.x + 6, y: tb.y + 30, size: 7, font });
  page.drawText('pdf2takeoff accuracy bench', { x: tb.x + 6, y: tb.y + 8, size: 6, font });
  return page;
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
let PAGE_1C = 0; // set when page 1c is built
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
    // no scale, no labels, no vector layer (a scan before calibration): the
    // sheet's own door width (its clustered wall-end gaps) closes the door
    cases.push({ id: 'fill/interior-door-no-hints', kind: 'fill', page: 1, at, expectM2: inner(3, 3), hints: 'none' });
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
    w(0, 0, 4, 0); w(4, 0, 4, 2); w(3, 3, 0, 3); w(0, 3, 0, 0);
    // the diagonal 4,2 → 3,3 drawn as two pieces leaving a 0.96 m door
    w(4, 2, 3.84, 2.16); w(3.16, 2.84, 3, 3);
    const expect = (4 * 3 - 0.5) - 0.06; // 4x3 minus the 1x1 corner triangle, minus stroke allowance
    cases.push({ id: 'fill/diagonal-wall-door', kind: 'fill', page: 1, at: pt(560, 200, 1.5, 1.5), expectM2: expect, tol: 0.05 });
    cases.push({ id: 'fill/diagonal-wall-door-no-hints', kind: 'fill', page: 1, at: pt(560, 200, 1.5, 1.5), expectM2: expect, tol: 0.05, hints: 'none', known: 'axis-aligned closing cannot bridge a diagonal door without the vector layer' });
  }
  // H: an L-shaped corridor 0.9 m wide in 1.2 pt walls. Its inner corner is
  // a heavy wall end facing the opposite wall 0.9 m away, which is inside
  // the calibrated doorway rung: only a FREE wall end may close onto a wall
  // side, so the corridor must come back whole, not cut at the elbow
  {
    const Tc = 1.2;
    const w = wall(page, 40, 470, Tc);
    w(0, 0, 4, 0); w(4, 0, 4, 0.9); w(4, 0.9, 0.9, 0.9); w(0.9, 0.9, 0.9, 4); w(0.9, 4, 0, 4); w(0, 4, 0, 0);
    const Tm = Tc / M;
    const expect = (4 - Tm) * (0.9 - Tm) + (0.9 - Tm) * (3.1 - Tm / 2);
    cases.push({ id: 'fill/l-corridor-0.9m', kind: 'fill', page: 1, at: pt(40, 470, 2.5, 0.45), expectM2: expect, tol: 0.04 });
  }
  // every page-1 room again with no hints: the sheet door width must not
  // change a room that was already right (benches, alcoves, L-shapes stay)
  for (const c of cases.filter((k) => k.kind === 'fill' && !k.hints && k.page === 1)) {
    const id = `${c.id}-no-hints`;
    if (!cases.some((k) => k.id === id)) cases.push({ ...c, id, hints: 'none' });
  }
}

// Page 1c: a scan before calibration (no hints anywhere on this page). The
// sheet states its door width through four 0.9 m doorways; five dimension
// lines broken for text at door width must not be mistaken for doors; a
// 2.4 m open-plan opening is not a doorway and stays open; a door into a
// 1.2 m corridor still closes from both sides.
{
  const page = sheet(doc);
  const T = 0.7;
  const inner = (wM, hM) => (wM * M - T) * (hM * M - T) / (M * M);
  const pg = doc.getPageCount();
  PAGE_1C = pg;
  // building 1: rooms P (0..4) and Q (4..8) in one 8 x 4 m outline, a 2.4 m
  // opening in the partition, a 0.9 m door from P to outside
  {
    const w = wall(page, 40, 330, T);
    w(0, 0, 1.5, 0); w(2.4, 0, 8, 0); w(8, 0, 8, 4); w(8, 4, 0, 4); w(0, 4, 0, 0);
    w(4, 0, 4, 0.8); w(4, 3.2, 4, 4);
    cases.push({ id: 'fill/open-plan-opening-no-hints', kind: 'fill', page: pg, at: pt(40, 330, 2, 2), expectM2: inner(8, 4), hints: 'none' });
  }
  // building 2: room U (3 x 3 m) with a 0.9 m door into a 1.2 m wide corridor V (6 m long)
  {
    const w = wall(page, 300, 330, T);
    w(0, 0, 3, 0); w(0, 0, 0, 3); w(0, 3, 3, 3);
    w(3, 0, 3, 1.05); w(3, 1.95, 3, 6);
    w(3, 0, 4.2, 0); w(4.2, 0, 4.2, 6); w(4.2, 6, 3, 6);
    cases.push({ id: 'fill/corridor-door-room-side-no-hints', kind: 'fill', page: pg, at: pt(300, 330, 1.5, 1.5), expectM2: inner(3, 3), hints: 'none' });
    cases.push({ id: 'fill/corridor-door-corridor-side-no-hints', kind: 'fill', page: pg, at: pt(300, 330, 3.6, 4), expectM2: inner(1.2, 6), hints: 'none' });
  }
  // building 3: three 3 x 3 m rooms in a row, 0.9 m doors between them
  {
    const w = wall(page, 480, 330, T);
    w(0, 0, 9, 0); w(9, 0, 9, 3); w(9, 3, 0, 3); w(0, 3, 0, 0);
    w(3, 0, 3, 1.05); w(3, 1.95, 3, 3); w(6, 0, 6, 1.05); w(6, 1.95, 6, 3);
    cases.push({ id: 'fill/middle-of-three-rooms-no-hints', kind: 'fill', page: pg, at: pt(480, 330, 4.5, 1.5), expectM2: inner(3, 3), hints: 'none' });
  }
  // decoys: dimension lines broken for their text, the break as wide as a
  // door (0.9 m), text sitting just above the line as drafted
  for (let i = 0; i < 5; i++) {
    const y = 300 - i * 12;
    const x0 = 40 + (i % 2) * 20;
    const x1 = x0 + 8 * M;
    const mid = (x0 + x1) / 2;
    page.drawLine({ start: { x: x0, y }, end: { x: mid - 0.45 * M, y }, thickness: 0.6, color: BLACK });
    page.drawLine({ start: { x: mid + 0.45 * M, y }, end: { x: x1, y }, thickness: 0.6, color: BLACK });
    page.drawText(`${8000 - i * 250}`, { x: mid - 8, y: y + 1.2, size: 6, font });
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
  cases.push({ id: 'count/all-including-touching-walls', kind: 'count', page: doc.getPageCount(), at: { x: open[0][0], y: open[0][1] }, expect: open.length + onWall.length });
  cases.push({ id: 'count/click-on-wall-touching-one', kind: 'count', page: doc.getPageCount(), at: { x: onWall[1][0], y: onWall[1][1] }, expect: open.length + onWall.length });
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

// Door-width second opinion on a calibration. Page 1 has one interior
// doorway (its other doors open to the outside and do not vote), too little
// to warn on; page 1c has three, which measure like doors at 1:100 and like
// double garage doors at 1:50.
cases.push({ id: 'doorcheck/one-doorway-is-no-evidence', kind: 'doorcheck', page: 1, ratio: 50, expect: 'none' });
cases.push({ id: 'doorcheck/1-100-plausible', kind: 'doorcheck', page: PAGE_1C, ratio: 100, expect: 'plausible' });
cases.push({ id: 'doorcheck/1-50-implausible', kind: 'doorcheck', page: PAGE_1C, ratio: 50, expect: 'implausible' });

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
        ...(use === 'all' ? { bridges: doorBridgesFor(await vectorDocPage(pdf, c.page), mpp) } : {}),
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
    } else if (c.kind === 'doorcheck') {
      const raster = await renderRasterNode(pdf, c.page, RASTER_SCALE);
      const dc = doorWidthCheck(metersPerPtForRatio(c.ratio), sheetDoorWidthPx(raster), RASTER_SCALE);
      got = dc?.status ?? 'none';
      pass = got === c.expect;
      detail = `${got}${dc ? ` (doors read ${dc.impliedDoorM.toFixed(2)} m at 1:${c.ratio}${dc.likely ? `, likely ${dc.likely}` : ''})` : ''}, ${c.expect} expected`;
    } else if (c.kind === 'count') {
      // the product scan path: vector match on born-digital symbols, else CV
      const r = await scanDocAt(pdf, c.page, c.at);
      got = 'error' in r ? 0 : r.hits.length;
      pass = (c.accept ?? [c.expect]).includes(got);
      detail = `${got} found, ${c.expect} expected${'provider' in r ? ` (${r.provider})` : ''}`;
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
