#!/usr/bin/env node
// Kill-criteria probes for the room-partition pass that do not belong in CI
// (docs/research/room-partition-design-review.md, section 6):
//
//   runtime gate   the pass's own time per region (warm, median of 3) and
//                  Dynamic Fill's time with the pass on and off, over the
//                  proxy matrix at 3 and 6 px/pt; scratch memory per ROI
//                  pixel; work-budget abstentions; identical decisions on a
//                  second run.
//   geometry gate  automatic extraction on every door-supported positive,
//                  written as AEC-Geometric-Bench-format area predictions
//                  (raster px frame) with the expected room count, for
//                  scripts/bench/aecgb-geometry-probe.py to run through the
//                  official scorer's preprocessing.
//
//   node --experimental-strip-types scripts/partition-gates.mjs --out <dir>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { positives, negatives, unsupported, render } from './partition-proxies.mjs';
import { partitionOpen } from './partition-lib.mjs';
import { dynamicFill, fillEvidence } from '../src/engine/dynamicfill.ts';
import { autoRooms, gridSeeds } from '../src/engine/auto-rooms.ts';

const args = process.argv.slice(2);
const outDir = args[args.indexOf('--out') + 1];
if (!outDir || args.indexOf('--out') < 0) {
  console.error('usage: --out <dir>');
  process.exit(2);
}
mkdirSync(join(outDir, 'geometry'), { recursive: true });

const pct = (xs, p) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const runtime = {};
let budgetAbstentions = 0;
let nondeterministic = 0;
for (const k of [1, 2]) {
  const pass = [];
  const roi = [];
  const fillOn = [];
  const fillOff = [];
  const cases = [...positives(), ...negatives(), ...unsupported()];
  for (const lay of k === 2 ? cases.filter((_, i) => i % 3 === 0) : cases) {
    const { raster, seeds } = render(lay, k);
    const ev = fillEvidence(raster);
    const runs = [0, 1, 2].map(() => partitionOpen(raster, seeds[0].px, ev));
    if (!runs[0]) continue;
    pass.push(runs.map((r) => r.ms).sort((a, b) => a - b)[1]);
    const b = runs[0].region.box;
    roi.push((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1));
    if (runs[0].reasons.some((r) => /budget/.test(r))) budgetAbstentions++;
    const sig = (r) => `${r.status}|${r.children.map((c) => `${c[0]}:${c.length}`).join(',')}`;
    if (sig(runs[0]) !== sig(runs[1])) nondeterministic++;
    for (const s of seeds) {
      const t = (on) => {
        const ts = [];
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          dynamicFill(raster, s.pt, undefined, {}, { partition: on });
          ts.push(performance.now() - t0);
        }
        return ts.sort((a, b) => a - b)[1];
      };
      fillOff.push(t(false));
      fillOn.push(t(true));
    }
  }
  runtime[`${3 * k}pxPerPt`] = {
    regions: pass.length,
    roiPx: { median: pct(roi, 0.5), max: Math.max(...roi) },
    passMs: { median: +pct(pass, 0.5).toFixed(1), p95: +pct(pass, 0.95).toFixed(1), max: +Math.max(...pass).toFixed(1) },
    fills: fillOn.length,
    fillMsPassOff: { median: +pct(fillOff, 0.5).toFixed(1), p95: +pct(fillOff, 0.95).toFixed(1) },
    fillMsPassOn: { median: +pct(fillOn, 0.5).toFixed(1), p95: +pct(fillOn, 0.95).toFixed(1) },
  };
  console.log(`${3 * k} px/pt: pass median ${runtime[`${3 * k}pxPerPt`].passMs.median} ms p95 ${runtime[`${3 * k}pxPerPt`].passMs.p95} ms over ${pass.length} regions (ROI median ${pct(roi, 0.5)} px); fill median ${runtime[`${3 * k}pxPerPt`].fillMsPassOff.median} -> ${runtime[`${3 * k}pxPerPt`].fillMsPassOn.median} ms with the pass, p95 ${runtime[`${3 * k}pxPerPt`].fillMsPassOff.p95} -> ${runtime[`${3 * k}pxPerPt`].fillMsPassOn.p95} ms`);
}

// geometry gate export: automatic extraction on every positive
const expect = {};
for (const lay of positives()) {
  const { raster, rooms } = render(lay, 1);
  const bx = rooms.flatMap((r) => r.rects);
  const [x0, y0, x1, y1] = [Math.min(...bx.map((b) => b[0])), Math.min(...bx.map((b) => b[1])), Math.max(...bx.map((b) => b[2])), Math.max(...bx.map((b) => b[3]))];
  const seeds = gridSeeds(raster, 40).filter((p) => {
    const q = raster.toRaster(p.x, p.y);
    return q.x >= x0 && q.x < x1 && q.y >= y0 && q.y < y1;
  });
  const { rooms: found } = autoRooms(raster, seeds);
  const id = lay.name.replace(/[^a-z0-9.+-]/gi, '_');
  writeFileSync(join(outDir, 'geometry', `${id}.json`), JSON.stringify({
    sheet: id,
    width: raster.width,
    height: raster.height,
    objects: [],
    walls: [],
    areas: found.map((r) => r.points.map((p) => {
      const q = raster.toRaster(p.x, p.y);
      return [Math.round(q.x * 100) / 100, Math.round(q.y * 100) / 100];
    })),
  }));
  expect[id] = rooms.length;
}
writeFileSync(join(outDir, 'geometry', 'expected.json'), JSON.stringify(expect, null, 2) + '\n');

const summary = {
  runtime,
  scratchBytesPerRoiPx: 16, // label Int32 + base Int32 + span stack 2x Int32, reused across calls
  workBudgets: { maxArcs: 512, maxPortals: 256, structVisitCap: 50000, maxLabelPasses: 3, abstentionsOnMatrix: budgetAbstentions },
  nondeterministicDecisions: nondeterministic,
};
writeFileSync(join(outDir, 'gates-runtime.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`work-budget abstentions ${budgetAbstentions}, nondeterministic decisions ${nondeterministic}; geometry export: ${Object.keys(expect).length} layouts`);
