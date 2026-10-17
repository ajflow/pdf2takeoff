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

if (failed) process.exit(1);
console.log('PASS: revision diffs and quantity delta');
