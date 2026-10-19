#!/usr/bin/env node
// B2 fixture generator: draws a sealed roomed sheet whose ground truth is
// analytic by construction. Walls are stroked centerlines (pdf-lib stroke
// straddles the path by half the width), so each room's truth polygon is
// the room inset by half the adjacent stroke width. Deterministic bytes:
// fixed creation date, no fonts, no random elements — regenerating must
// reproduce the SHA-256 pinned in room-sheet.reference.json (asserted
// in-process on every run, so CI is the determinism guard too).
// See evals/README.md and docs/research/bench-patch-plan.md (patch B2).

import { PDFDocument, rgb } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PDF = join(__dirname, 'artifacts', 'room-sheet.pdf');
const OUT_REF = join(__dirname, 'room-sheet.reference.json');

const PAGE_W = 842, PAGE_H = 595; // A4 landscape, pt
const X0 = 60, Y0 = 60;
const COLS = [260, 200, 202]; // room widths, pt
const ROWS = [280, 195];      // room heights, pt
const OUTER = 3;              // outer wall stroke, pt
const INNER = 2;              // divider stroke, pt
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

const ink = rgb(0.13, 0.15, 0.2);
const grid = rgb(0.88, 0.9, 0.93); // decoy: luminance ~230, above the fill's ink threshold

const PLAN_W = COLS.reduce((a, b) => a + b, 0);
const PLAN_H = ROWS.reduce((a, b) => a + b, 0);

async function buildSheet() {
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
  const page = pdf.addPage([PAGE_W, PAGE_H]);

  // faint decoy grid (must NOT act as fill boundary)
  for (let x = X0; x <= X0 + PLAN_W + 0.1; x += 20) {
    page.drawLine({ start: { x, y: Y0 }, end: { x, y: Y0 + PLAN_H }, thickness: 0.4, color: grid });
  }
  for (let y = Y0; y <= Y0 + PLAN_H + 0.1; y += 20) {
    page.drawLine({ start: { x: X0, y }, end: { x: X0 + PLAN_W, y }, thickness: 0.4, color: grid });
  }

  // outer wall + dividers, all stroked centerlines
  page.drawRectangle({ x: X0, y: Y0, width: PLAN_W, height: PLAN_H, borderColor: ink, borderWidth: OUTER });
  let x = X0;
  for (const w of COLS.slice(0, -1)) {
    x += w;
    page.drawLine({ start: { x, y: Y0 }, end: { x, y: Y0 + PLAN_H }, thickness: INNER, color: ink });
  }
  let y = Y0;
  for (const h of ROWS.slice(0, -1)) {
    y += h;
    page.drawLine({ start: { x: X0, y }, end: { x: X0 + PLAN_W, y }, thickness: INNER, color: ink });
  }

  return pdf.save();
}

/** Rooms with analytic truth: inset half the adjacent stroke per side. */
function rooms() {
  const out = [];
  const xs = [X0]; for (const w of COLS) xs.push(xs[xs.length - 1] + w);
  const ys = [Y0]; for (const h of ROWS) ys.push(ys[ys.length - 1] + h);
  let label = 0;
  // row-major from bottom-left (PDF y-up), R1 bottom-left … R6 top-right
  for (let r = 0; r < ROWS.length; r++) {
    for (let c = 0; c < COLS.length; c++) {
      label += 1;
      const insetL = (c === 0 ? OUTER : INNER) / 2;
      const insetR = (c === COLS.length - 1 ? OUTER : INNER) / 2;
      const insetB = (r === 0 ? OUTER : INNER) / 2;
      const insetT = (r === ROWS.length - 1 ? OUTER : INNER) / 2;
      const x1 = xs[c] + insetL, y1 = ys[r] + insetB;
      const x2 = xs[c + 1] - insetR, y2 = ys[r + 1] - insetT;
      const truth = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
      out.push({
        label: `R${label}`,
        seed_pt: [(x1 + x2) / 2, (y1 + y2) / 2],
        truth_pts: truth,
        truth_area_pt2: (x2 - x1) * (y2 - y1),
      });
    }
  }
  return out;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const a = await buildSheet();
const b = await buildSheet();
if (sha(a) !== sha(b)) {
  console.error('FAIL: pdf-lib output is not byte-deterministic; SHA pinning is impossible');
  process.exit(1);
}
mkdirSync(dirname(OUT_PDF), { recursive: true });
writeFileSync(OUT_PDF, a);
const rm = rooms();
writeFileSync(OUT_REF, JSON.stringify({
  schema_version: 1,
  eval: 'room-area',
  source_pdf: 'artifacts/room-sheet.pdf',
  source_pdf_sha256: sha(a),
  page: 1,
  pdf_points: { page_width: PAGE_W, page_height: PAGE_H },
  coordinate_frame: 'PDF user space (pt, origin bottom-left)',
  wall_stroke_pt: { outer: OUTER, inner: INNER },
  rooms: rm,
  tolerances: { area_percent: 1.0, overlap_iou: 0.985, boundary_max_pt: 1.0 },
}, null, 2) + '\n');
console.log(`ok: artifacts/room-sheet.pdf written (sha256 ${sha(a).slice(0, 16)}…, byte-deterministic)`);
console.log(`ok: room-sheet.reference.json written — ${rm.length} rooms, truth = wall faces (half-stroke inset)`);
for (const r of rm) console.log(`   ${r.label}: area ${r.truth_area_pt2.toFixed(1)} pt², seed (${r.seed_pt.map((v) => v.toFixed(1)).join(', ')})`);
