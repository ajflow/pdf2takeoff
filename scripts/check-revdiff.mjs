#!/usr/bin/env node
// Behavioural check for revision diffs (engine/revdiff.ts, ops.compareDocs,
// ops.quantityDelta) on the bundled REV A / REV B samples. REV B moves the
// partition from 4 m to 5 m, drops 3 of 8 downlights, adds a window and
// reprints the affected values.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { compareDocs, quantityDelta, scanDocAt } from '../src/headless/ops.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { buildAnnotatedPdf } from '../src/engine/annotate.ts';
import { dynamicFill } from '../src/engine/dynamicfill.ts';
import { metersPerPtForRatio } from '../src/engine/units.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => new Uint8Array(readFileSync(join(root, 'public/examples', f)));
let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};

const bytesA = load('sample-floor-plan.pdf');
const docA = await openPdf(bytesA);
const docB = await openPdf(load('sample-floor-plan-rev-b.pdf'));
const cmp = await compareDocs(docA, docB);
const s1 = cmp.sheets[0];
check('raster: sheet 1 changed', s1.changed);
check('vector: partition reported as moved 1 m (28.3 pt) right', s1.vector?.moved.some((m) => Math.abs(m.dxPt - 28.3) < 0.2 && m.dyPt === 0), JSON.stringify(s1.vector?.moved));
check('vector: 3 removed downlights', s1.vector?.regions.filter((r) => r.kind === 'removed' && r.wPt === 14 && r.hPt === 14).length === 3, JSON.stringify(s1.vector?.regions));
check('vector: the window shows as added', s1.vector?.regions.some((r) => r.kind === 'added' && r.hPt > 40 && r.wPt < 6), JSON.stringify(s1.vector?.regions));
check('text: "(8" changed to "(5" in the downlight note', s1.text?.changed.some((c) => c.from === '(8' && c.to === '(5'), JSON.stringify(s1.text?.changed));
check('text: no spurious label swap', !s1.text?.changed.some((c) => c.from === 'D' && c.to === 'OFFICE'), JSON.stringify(s1.text?.changed));

// a takeoff saved on REV A: 8 downlights and the office area
const scan = await scanDocAt(docA, 1, { x: 88.35, y: 271.42 });
const fill = dynamicFill(await renderRasterNode(docA, 1, 3), { x: 100, y: 200 }, undefined, { metersPerPt: metersPerPtForRatio(100) });
if ('error' in scan || 'error' in fill) {
  check('setup: takeoff on REV A', false, JSON.stringify({ scan, fill }));
} else {
  const markups = [
    ...scan.hits.map((h, i) => ({ id: `c${i}`, page: 1, type: 'count', label: 'DL-100', points: [{ x: h.x, y: h.y }], createdAt: i })),
    { id: 'a1', page: 1, type: 'area', label: 'Office', points: fill.points, createdAt: 99 },
    { id: 'l1', page: 1, type: 'length', label: 'Wall', points: [{ x: 60, y: 90 }, { x: 400, y: 90 }], createdAt: 100 },
  ];
  const calibrations = new Map([[1, { metersPerPt: metersPerPtForRatio(100), source: 'test' }]]);
  const saved = await openPdf(await buildAnnotatedPdf({ bytes: bytesA, markups, calibrations, displayUnit: 'm' }));
  const q = await quantityDelta(saved, docB);
  const dl = q.counts.find((c) => c.label === 'DL-100');
  check('quantities: downlights 8 → 5', dl?.a === 8 && dl?.b === 5 && dl?.delta === -3, JSON.stringify(q.counts));
  const office = q.areas.find((a) => a.label === 'Office');
  // the office grows from 4 m to 5 m wide: about +25%
  check('quantities: office area grows about 25%', office && Math.abs(office.changePct - 25) < 3, JSON.stringify(office));
  check('quantities: lengths listed as not re-measured', q.notReMeasured.some((n) => n.type === 'length' && n.markups === 1));
}

// many separate changes stay fast and each becomes its own region
{
  const { vectorDiff } = await import('../src/engine/revdiff.ts');
  const segs = [];
  for (let i = 0; i < 20000; i++) {
    const x = (i % 200) * 20;
    const y = Math.floor(i / 200) * 20;
    segs.push({ x1: x, y1: y, x2: x + 3, y2: y + (i % 7), lineWidth: 0.35, stroked: true, filled: false, dashed: false, curve: false, path: i, form: -1 });
  }
  const t0 = performance.now();
  const d = vectorDiff({ segs, paths: [], forms: 0, layers: 0 }, { segs: [], paths: [], forms: 0, layers: 0 });
  const ms = performance.now() - t0;
  check(`vector: 20k scattered removals -> 20k regions in ${ms.toFixed(0)} ms (< 3000)`, d.regions.length === 20000 && ms < 3000);
}

// a vertical dimension changed in place reads as a change, not remove + add
{
  const { PDFDocument, StandardFonts, degrees } = await import('pdf-lib');
  const { textDiff } = await import('../src/engine/revdiff.ts');
  const { wordsFromTextItem } = await import('../src/engine/ocr.ts');
  const sheet = async (value) => {
    const d = await PDFDocument.create();
    const page = d.addPage([400, 400]);
    const font = await d.embedFont(StandardFonts.Helvetica);
    page.drawText(value, { x: 200, y: 180, size: 8, font, rotate: degrees(90) }); // starts at y = 180, reads upward
    page.drawText('PLAN', { x: 50, y: 50, size: 8, font });
    const doc = await openPdf(await d.save());
    const tc = await (await doc.getPage(1)).getTextContent();
    return tc.items.flatMap((it) => wordsFromTextItem(it.str ?? '', it.transform, it.width, it.height));
  };
  const td = textDiff(await sheet('900'), await sheet('1200'));
  check('text: vertical dimension 900 → 1200 reads as changed', td.changed.some((c) => c.from === '900' && c.to === '1200') && td.added.length === 0 && td.removed.length === 0, JSON.stringify(td));
}

// an unchanged L-shaped room re-measures unchanged: its vertex mean sits on
// the inner corner, outside the room, so the re-fill must start inside it
{
  const { PDFDocument, rgb } = await import('pdf-lib');
  const draw = async () => {
    const d = await PDFDocument.create();
    const page = d.addPage([400, 400]);
    const L = [[100, 100], [300, 100], [300, 200], [200, 200], [200, 300], [100, 300]];
    for (let i = 0; i < L.length; i++) {
      const [x1, y1] = L[i];
      const [x2, y2] = L[(i + 1) % L.length];
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1, color: rgb(0, 0, 0) });
    }
    return d;
  };
  const a = await draw();
  const bytes = await a.save();
  const poly = [[100.5, 100.5], [299.5, 100.5], [299.5, 199.5], [199.5, 199.5], [199.5, 299.5], [100.5, 299.5]].map(([x, y]) => ({ x, y }));
  const markups = [{ id: 'L', page: 1, type: 'area', label: 'L room', points: poly, createdAt: 1 }];
  const saved = await openPdf(await buildAnnotatedPdf({ bytes, markups, calibrations: new Map(), displayUnit: 'm' }));
  const q = await quantityDelta(saved, await openPdf(await (await draw()).save()));
  const l = q.areas[0];
  check('quantities: unchanged L-shaped room re-measures unchanged', l && l.bPt2 !== null && Math.abs(l.changePct) < 3, JSON.stringify(l));
}

if (failed) process.exit(1);
console.log('PASS: revision diffs and quantity delta');
