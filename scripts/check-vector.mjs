#!/usr/bin/env node
// Behavioural check for the vector layer walker (engine/vector.ts): page
// geometry from pdf.js operator lists lands in PDF user space with the right
// line weights, through transforms and Form XObjects, with dashes and
// curves flagged. Also guards extraction speed on a busy A1 sheet.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { vectorize } from '../src/engine/vector.ts';
import { vectorScan } from '../src/engine/scan-vector.ts';
import { doorBridges } from '../src/engine/fill-vector.ts';
import { vectorDocPage } from '../src/headless/ops.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};
const near = (a, b, tol = 0.2) => Math.abs(a - b) <= tol;

async function vec(bytes) {
  const page = await (await openPdf(bytes)).getPage(1);
  const t0 = performance.now();
  const v = vectorize(await page.getOperatorList(), OPS);
  return { v, ms: performance.now() - t0 };
}

// the bundled sample: 12 x 8 m plan at 1:100 from (60, 90), 2.6 pt outer
// walls, a 1.6 pt partition at x = 60 + 4 m from 1 m up to the top wall
{
  const { v } = await vec(new Uint8Array(readFileSync(join(root, 'public/examples/sample-floor-plan.pdf'))));
  const m = 72 / 0.0254 / 100;
  const part = v.segs.find((s) => near(s.lineWidth, 1.6) && near(s.x1, 60 + 4 * m, 0.5) && near(s.x2, s.x1, 0.01));
  check('sample: partition found with its 1.6 pt weight', !!part, `${v.segs.length} segs`);
  if (part) check('sample: partition runs 1 m up to the top wall', near(Math.min(part.y1, part.y2), 90 + m, 0.5) && near(Math.max(part.y1, part.y2), 90 + 8 * m, 0.5));
  check('sample: outer walls carry 2.6 pt', v.segs.filter((s) => near(s.lineWidth, 2.6)).length >= 4);
  check('sample: dashed door swing flagged', v.segs.some((s) => s.dashed && s.curve));
}

// synthetic A1: symbols as Form XObjects, dashed ticks, arcs, 20k lines
{
  const doc = await PDFDocument.create();
  const sym = await PDFDocument.create();
  const sp = sym.addPage([12, 12]);
  sp.drawCircle({ x: 6, y: 6, size: 5, borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
  sp.drawLine({ start: { x: 1, y: 6 }, end: { x: 11, y: 6 }, thickness: 0.5 });
  const page = doc.addPage([2384, 1684]);
  const [emb] = await doc.embedPages([sym.getPage(0)]);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 20000; i++) {
    const x = rnd() * 2300 + 40;
    const y = rnd() * 1600 + 40;
    page.drawLine({ start: { x, y }, end: { x: x + rnd() * 60, y: y + (rnd() < 0.5 ? 0 : rnd() * 60) }, thickness: rnd() < 0.2 ? 2 : 0.35 });
  }
  for (let i = 0; i < 300; i++) page.drawPage(emb, { x: 100 + (i % 30) * 70, y: 100 + Math.floor(i / 30) * 120 });
  for (let i = 0; i < 200; i++) page.drawLine({ start: { x: 50 + i * 10, y: 20 }, end: { x: 50 + i * 10, y: 30 }, thickness: 0.3, dashArray: [2, 2] });
  const { v, ms } = await vec(await doc.save());
  check('A1: 300 Form XObject instances seen', v.forms === 300, `got ${v.forms}`);
  const f = v.paths.find((p) => p.form === 0);
  check('A1: first symbol instance placed at its page position', f && near(f.x0, 101, 0.3) && near(f.y0, 101, 0.3) && near(f.x1, 111, 0.3) && near(f.y1, 111, 0.3), f && JSON.stringify(f));
  check('A1: dashed ticks flagged', v.segs.filter((s) => s.dashed).length === 200);
  check('A1: heavy and light weights kept apart', v.segs.some((s) => near(s.lineWidth, 2)) && v.segs.some((s) => near(s.lineWidth, 0.35)));
  check(`A1: ${v.segs.length} segments extracted in ${ms.toFixed(0)} ms (< 3000)`, ms < 3000);
  const t0 = performance.now();
  const r = vectorScan(v, { x: 106, y: 106 });
  check(`A1: vector scan finds all 300 symbols among 20k crossing lines in ${(performance.now() - t0).toFixed(0)} ms`, r?.hits.length === 300, `got ${r?.hits.length}`);
}

// vector scan: an asymmetric switch-like symbol (circle + tail to the right)
// at 0°, 90°, 180° and mirrored; a same-size lookalike (circle + cross) and
// a 1.5x copy must not match; one instance touches a wall
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const black = rgb(0, 0, 0);
  const sw = (x, y, dx, dy, k = 1) => {
    page.drawCircle({ x, y, size: 4 * k, borderColor: black, borderWidth: 0.6 });
    page.drawLine({ start: { x: x + 4 * k * dx, y: y + 4 * k * dy }, end: { x: x + 9 * k * dx, y: y + 9 * k * dy }, thickness: 0.6, color: black });
  };
  sw(100, 300, 1, 0);
  sw(200, 300, 0, 1);
  sw(300, 300, -1, 0);
  sw(400, 300, -1, 0); // the mirror of a right tail is a left tail for this symbol
  page.drawLine({ start: { x: 50, y: 195.4 }, end: { x: 550, y: 195.4 }, thickness: 2, color: black });
  sw(250, 200, 1, 0); // touching the wall above
  // lookalike: circle with a cross, same overall size
  page.drawCircle({ x: 100, y: 100, size: 4, borderColor: black, borderWidth: 0.6 });
  page.drawLine({ start: { x: 104, y: 100 }, end: { x: 109, y: 100 }, thickness: 0.6, color: black });
  page.drawLine({ start: { x: 100, y: 96 }, end: { x: 100, y: 104 }, thickness: 0.6, color: black });
  sw(300, 100, 1, 0, 1.5); // bigger copy
  const { v } = await vec(await doc.save());
  const r = vectorScan(v, { x: 100, y: 300 });
  check('vector scan: finds the symbol at the click', r && r.provider === 'vector');
  check('vector scan: 5 instances (rotated, mirrored, touching a wall); lookalike and bigger copy excluded', r?.hits.length === 5, r && JSON.stringify(r.hits.map((h) => [Math.round(h.x), Math.round(h.y)])));
  check('vector scan: nothing under an empty click', vectorScan(v, { x: 500, y: 50 }) === null);
}

// vector scan: instances straddling the 30 pt grouping grid (a circle whose
// tail starts just across a cell boundary) still group and count
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const black = rgb(0, 0, 0);
  const sw = (x, y) => {
    page.drawCircle({ x, y, size: 4, borderColor: black, borderWidth: 0.6 });
    page.drawLine({ start: { x: x + 4.3, y }, end: { x: x + 9, y }, thickness: 0.6, color: black });
  };
  // circles end at x = 29.9 / 59.9 / 89.9 and their tails start 0.3 pt later, across the cell boundary
  for (const x of [25.9, 55.9, 85.9, 200, 300]) sw(x, 200);
  const { v } = await vec(await doc.save());
  const r = vectorScan(v, { x: 200, y: 200 });
  check('vector scan: instances on grid boundaries still count (5)', r?.hits.length === 5, r && JSON.stringify(r.hits.map((h) => Math.round(h.x))));
}

// doorway bridges
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const black = rgb(0, 0, 0);
  const line = (x1, y1, x2, y2, t) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: black });
  // A: a diagonal thin wall with a 20 pt door between two free ends
  line(50, 50, 100, 100, 0.7);
  line(114.1, 114.1, 160, 160, 0.7);
  // B: a heavy partition ending 25 pt short of a heavy wall (doorway at a corner)
  line(300, 50, 300, 150, 2);
  line(250, 175, 400, 175, 2);
  // C: a thin bench line ending 20 pt short of a heavy wall's side
  line(420, 100, 480, 100, 0.5);
  line(500, 50, 500, 200, 2);
  const { v } = await vec(await doc.save());
  const br = doorBridges(v, 30);
  const has = (x1, y1, x2, y2) => br.some((b) => (near(b.x1, x1, 0.6) && near(b.y1, y1, 0.6) && near(b.x2, x2, 0.6) && near(b.y2, y2, 0.6)) || (near(b.x1, x2, 0.6) && near(b.y1, y2, 0.6) && near(b.x2, x1, 0.6) && near(b.y2, y1, 0.6)));
  check('bridges: diagonal door between facing wall ends', has(100, 100, 114.1, 114.1), JSON.stringify(br));
  check('bridges: heavy partition end runs into the heavy wall', has(300, 150, 300, 175), JSON.stringify(br));
  check('bridges: thin bench end is never closed onto a wall side', !br.some((b) => near(b.x1, 480, 0.6) || near(b.x2, 480, 0.6)), JSON.stringify(br));
}

// hidden CAD layers (optional content switched off) are skipped
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const ctx = doc.context;
  const on = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Walls') }));
  const off = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Furniture') }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [on, off], D: { ON: [on], OFF: [off], Order: [on, off] } }));
  page.node.Resources().set(PDFName.of('Properties'), ctx.obj({ MC0: on, MC1: off }));
  const ops = '/OC /MC0 BDC 1 w 10 10 m 300 10 l S EMC /OC /MC1 BDC 1 w 10 100 m 300 100 l S EMC 1 w 10 200 m 300 200 l S';
  page.node.addContentStream(ctx.register(ctx.stream(ops)));
  const v = await vectorDocPage(await openPdf(await doc.save()), 1);
  const ys = v.segs.map((s) => Math.round(s.y1)).sort((a, b) => a - b);
  check('layers: visible-layer and unlayered lines kept, hidden-layer line skipped', JSON.stringify(ys) === '[10,200]', JSON.stringify(ys));
  check('layers: both groups counted', v.layers === 2, `got ${v.layers}`);
}

if (failed) process.exit(1);
console.log('PASS: vector layer extraction');
