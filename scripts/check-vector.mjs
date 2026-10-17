#!/usr/bin/env node
// Behavioural check for the vector layer walker (engine/vector.ts): page
// geometry from pdf.js operator lists lands in PDF user space with the right
// line weights, through transforms and Form XObjects, with dashes and
// curves flagged. Also guards extraction speed on a busy A1 sheet.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { vectorize } from '../src/engine/vector.ts';

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
}

if (failed) process.exit(1);
console.log('PASS: vector layer extraction');
