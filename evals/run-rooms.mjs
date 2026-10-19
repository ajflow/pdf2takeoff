#!/usr/bin/env node
// B2 engine runner: render the generated room sheet through the same Node
// raster adapter the CLI/MCP use, run the real Dynamic Fill
// (src/engine/dynamicfill.ts) at each reference seed, and write a
// candidate JSON + per-room overlay PNGs (truth green, candidate red).
// The candidate file is deterministic (no timestamps) so scoring it is
// reproducible; run metadata belongs in the run log, not here.
// See evals/README.md and docs/research/bench-patch-plan.md (patch B2).

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { openPdf, renderRasterNode } from '../src/headless/cli.ts';
import { dynamicFill } from '../src/engine/dynamicfill.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';

const dirname = new URL('.', import.meta.url).pathname;
const REF = new URL('./room-sheet.reference.json', import.meta.url).pathname;
const PDF = new URL('./artifacts/room-sheet.pdf', import.meta.url).pathname;
const OUT = new URL('./artifacts/candidate-rooms.json', import.meta.url).pathname;
const OVERLAY_DIR = new URL('./artifacts/', import.meta.url).pathname;

const reference = JSON.parse(readFileSync(REF, 'utf8'));
const pdfBytes = readFileSync(PDF);
const sha = createHash('sha256').update(pdfBytes).digest('hex');
if (sha !== reference.source_pdf_sha256) {
  console.error(`FAIL: sheet sha256 ${sha.slice(0, 16)}… does not match reference ${reference.source_pdf_sha256.slice(0, 16)}… — regenerate with make-room-sheet.mjs`);
  process.exit(1);
}

const doc = await openPdf(new Uint8Array(pdfBytes));
const raster = await renderRasterNode(doc, reference.page, RASTER_SCALE);
console.log(`rendered page ${reference.page}: ${raster.width}×${raster.height} px (${RASTER_SCALE} px/pt)`);

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const rooms = [];
for (const room of reference.rooms) {
  // dynamicFill takes the seed in PDF space and maps it through the page's
  // own transform (src/engine/dynamicfill.ts) — do not pre-convert
  const t0 = performance.now();
  const result = dynamicFill(raster, { x: room.seed_pt[0], y: room.seed_pt[1] });
  const ms = performance.now() - t0;
  if ('error' in result) {
    console.log(`${room.label}: ERROR — ${result.error} (${ms.toFixed(0)} ms)`);
    rooms.push({ label: room.label, error: result.error });
  } else {
    const polygon = result.points.map((p) => [r4(p.x), r4(p.y)]);
    console.log(`${room.label}: ${polygon.length} pts (${ms.toFixed(0)} ms)`);
    rooms.push({ label: room.label, polygon_pts: polygon });
  }
}

// overlay PNG per room: truth green, candidate red, 2 px/pt for legibility
const OV = 2;
for (const room of reference.rooms) {
  const cand = rooms.find((r) => r.label === room.label);
  const cnv = createCanvas(reference.pdf_points.page_width * OV, reference.pdf_points.page_height * OV);
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cnv.width, cnv.height);
  const toC = (pt) => ({ x: pt[0] * OV, y: (reference.pdf_points.page_height - pt[1]) * OV });
  const stroke = (pts, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, toC(p).x, toC(p).y));
    ctx.closePath();
    ctx.stroke();
  };
  stroke(room.truth_pts, '#16a34a', 3);
  if (cand?.polygon_pts) stroke(cand.polygon_pts, '#dc2626', 1.5);
  else if (cand) {
    ctx.fillStyle = '#dc2626';
    ctx.font = '20px sans-serif';
    ctx.fillText(`${room.label}: ${cand.error}`, 20, 40);
  }
  writeFileSync(`${OVERLAY_DIR}overlay-${room.label}.png`, cnv.toBuffer('image/png'));
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8'));
rooms.sort((a, b) => a.label.localeCompare(b.label));
writeFileSync(OUT, JSON.stringify({
  schema_version: 1,
  eval: 'room-area',
  source_pdf: 'artifacts/room-sheet.pdf',
  source_pdf_sha256: sha,
  engine: { name: 'pdf2takeoff', version, render_scale: RASTER_SCALE },
  produced_by: 'src/engine/dynamicfill.ts dynamicFill()',
  rooms,
}, null, 2) + '\n');
console.log(`ok: artifacts/candidate-rooms.json + overlay-*.png written (${rooms.filter((r) => r.polygon_pts).length}/${rooms.length} rooms filled)`);
