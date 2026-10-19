#!/usr/bin/env node
// B5 perf bench: time the engine's hot paths in-process (the same Node
// adapters the CLI/MCP use) and record deterministic counts alongside.
// Counts (pages rendered, scan hits, rooms filled, markups round-tripped,
// compare fraction) are byte-deterministic given the same inputs and go
// into the B4 baseline ratchet; millisecond medians are informational only
// — never gated, because CI runners flap. Browser-side numbers (tier-2 ML
// scan latency, model size) are published in evals/perf.md, not measured
// here — this harness has no browser.
// See evals/README.md and docs/research/bench-patch-plan.md (patch B5).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { openPdf, renderRasterNode } from '../src/headless/cli.ts';
import { compareDocs } from '../src/headless/ops.ts';
import { cvScan } from '../src/engine/scan-cv.ts';
import { dynamicFill } from '../src/engine/dynamicfill.ts';
import { buildAnnotatedPdf } from '../src/engine/annotate.ts';
import { parseMarkups } from '../src/engine/read.ts';
import { metersPerPtForRatio } from '../src/engine/units.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const ART = join(here, 'artifacts');
const OUT = join(ART, 'perf-results.json');

const SAMPLE = join(ROOT, 'public', 'examples', 'sample-floor-plan.pdf');
const SAMPLE_B = join(ROOT, 'public', 'examples', 'sample-floor-plan-rev-b.pdf');
const SOAK = join(ART, 'soak-12.pdf');
const ROOM_REF = join(here, 'room-sheet.reference.json');
const ROOM_PDF = join(ART, 'room-sheet.pdf');

const SOAK_PAGES = 12;
const SOAK_SEED = 7;

// deterministic 7-markup set (same shapes as scripts/roundtrip-check.mjs)
const MARKUPS = [
  { id: 't1', page: 1, type: 'length', label: 'External wall', points: [{ x: 60, y: 90 }, { x: 400.02, y: 90 }], createdAt: 1 },
  { id: 't2', page: 1, type: 'area', label: 'Zone A: lobby', points: [{ x: 60, y: 90 }, { x: 173.39, y: 90 }, { x: 173.39, y: 316.77 }, { x: 60, y: 316.77 }], createdAt: 2 },
  { id: 't3', page: 1, type: 'count', label: 'DL: type A', points: [{ x: 100, y: 100 }], createdAt: 3 },
  { id: 't4', page: 1, type: 'note', label: 'Check: ceiling height', points: [{ x: 120, y: 120 }], createdAt: 4 },
  { id: 't5', page: 1, type: 'volume', label: 'Slab', depth: 0.15, points: [{ x: 60, y: 90 }, { x: 173.39, y: 90 }, { x: 173.39, y: 316.77 }, { x: 60, y: 316.77 }], createdAt: 5 },
  { id: 't6', page: 1, type: 'angle', label: 'Corner 45° bend', points: [{ x: 60, y: 90 }, { x: 200, y: 90 }, { x: 60, y: 200 }], createdAt: 6 },
  { id: 't7', page: 1, type: 'perimeter', label: 'Room boundary', points: [{ x: 60, y: 90 }, { x: 173.39, y: 90 }, { x: 173.39, y: 316.77 }, { x: 60, y: 316.77 }], createdAt: 7 },
];
const CALIBRATIONS = new Map([[1, { metersPerPt: metersPerPtForRatio(100), source: 'bench 1:100' }]]);

async function timeMs(fn, reps = 5) {
  await fn(); // warm-up (JIT, page cache)
  const t = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return { median: t[Math.floor(t.length / 2)], min: t[0], max: t[t.length - 1] };
}
const r1 = (v) => Math.round(v * 10) / 10;

mkdirSync(ART, { recursive: true });

// ---------- soak PDF (regenerate on demand, stamped by its own determinism) ----------
if (!existsSync(SOAK)) {
  const gen = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-soak.mjs'), '--pages', String(SOAK_PAGES), '--seed', String(SOAK_SEED), '--out', SOAK], { stdio: 'inherit' });
  if (gen.status !== 0) { console.error('FAIL: make-soak failed'); process.exit(1); }
}

const counts = {};
const ms = {};

// ---------- render: every soak page at RASTER_SCALE ----------
{
  const doc = await openPdf(new Uint8Array(readFileSync(SOAK)));
  counts.render_pages = doc.numPages;
  const perPage = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const r = await timeMs(() => renderRasterNode(doc, p, RASTER_SCALE), 3);
    perPage.push(r.median);
  }
  perPage.sort((a, b) => a - b);
  ms.render_page_median = r1(perPage[Math.floor(perPage.length / 2)]);
  ms.render_page_max = r1(perPage[perPage.length - 1]);
  console.log(`render: ${counts.render_pages} pages, median ${ms.render_page_median} ms/page (max ${ms.render_page_max})`);
}

// ---------- tier-1 scan on the sample drawing ----------
{
  const doc = await openPdf(new Uint8Array(readFileSync(SAMPLE)));
  const raster = await renderRasterNode(doc, 1, RASTER_SCALE);
  const r = await timeMs(() => cvScan(raster, { x: 88.35, y: 271.42 }));
  const scan = cvScan(raster, { x: 88.35, y: 271.42 });
  if ('error' in scan) { console.error('FAIL: scan errored:', scan.error); process.exit(1); }
  counts.scan_hits = scan.hits.length;
  ms.tier1_scan_median = r1(r.median);
  console.log(`tier-1 scan: ${counts.scan_hits} hits, median ${ms.tier1_scan_median} ms`);
}

// ---------- dynamic fill on the analytic room sheet ----------
{
  if (!existsSync(ROOM_PDF)) {
    const gen = spawnSync(process.execPath, [join(here, 'make-room-sheet.mjs')], { stdio: 'inherit' });
    if (gen.status !== 0) { console.error('FAIL: make-room-sheet failed'); process.exit(1); }
  }
  const reference = JSON.parse(readFileSync(ROOM_REF, 'utf8'));
  const doc = await openPdf(new Uint8Array(readFileSync(ROOM_PDF)));
  const raster = await renderRasterNode(doc, reference.page, RASTER_SCALE);
  let filled = 0;
  const perRoom = [];
  for (const room of reference.rooms) {
    const r = await timeMs(() => dynamicFill(raster, { x: room.seed_pt[0], y: room.seed_pt[1] }), 3);
    const res = dynamicFill(raster, { x: room.seed_pt[0], y: room.seed_pt[1] });
    if (!('error' in res)) filled++;
    perRoom.push(r.median);
  }
  perRoom.sort((a, b) => a - b);
  counts.fill_rooms = filled;
  ms.fill_median = r1(perRoom[Math.floor(perRoom.length / 2)]);
  console.log(`fill: ${counts.fill_rooms}/${reference.rooms.length} rooms, median ${ms.fill_median} ms/room`);
}

// ---------- revision compare (sample A vs B) ----------
{
  const docA = await openPdf(new Uint8Array(readFileSync(SAMPLE)));
  const docB = await openPdf(new Uint8Array(readFileSync(SAMPLE_B)));
  const r = await timeMs(() => compareDocs(docA, docB, { threshold: 24 }), 3);
  const result = await compareDocs(docA, docB, { threshold: 24 });
  counts.compare_pages = result.comparedSheets;
  counts.compare_changed_sheets = result.changedSheets.length;
  const maxFrac = Math.max(...result.sheets.map((s) => s.changedFraction));
  ms.compare_median = r1(r.median);
  ms._info_compare_max_changed_fraction = maxFrac; // informational (deterministic; not baseline-gated)
  console.log(`compare: ${counts.compare_pages} sheets, ${counts.compare_changed_sheets} changed, max fraction ${maxFrac.toFixed(4)}, median ${ms.compare_median} ms`);
}

// ---------- annotation round-trip on the sample ----------
{
  const bytes = new Uint8Array(readFileSync(SAMPLE));
  const build = await timeMs(() => buildAnnotatedPdf({ bytes, markups: MARKUPS, calibrations: CALIBRATIONS, displayUnit: 'm' }), 3);
  const saved = await buildAnnotatedPdf({ bytes, markups: MARKUPS, calibrations: CALIBRATIONS, displayUnit: 'm' });
  const doc = await openPdf(saved);
  let back = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const annots = await page.getAnnotations();
    back += parseMarkups(annots, p, back).length;
  }
  counts.roundtrip_markups = back;
  ms.roundtrip_median = r1(build.median);
  console.log(`round-trip: ${counts.roundtrip_markups} markups back, median ${ms.roundtrip_median} ms`);
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
writeFileSync(OUT, JSON.stringify({
  schema: 'evals/bench-perf/1',
  eval: 'perf',
  engine: { name: 'pdf2takeoff', version, node: process.version, render_scale: RASTER_SCALE },
  note: 'ms medians are informational (machine-dependent, not gated); counts are deterministic and baseline-gated via evals/compare.mjs',
  counts,
  ms,
}, null, 2) + '\n');
console.log(`ok: ${OUT}`);
