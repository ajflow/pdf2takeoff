#!/usr/bin/env node
// Room-area bench for Dynamic Fill on rendered floor-plan datasets.
//
// Takes a folder written by scripts/bench/resplan_to_pdf.py (`<id>_<variant>.pdf`
// plus `<id>_tasks.json`), runs dynamicFill at every room's click point through
// the same headless raster, text-layer and vector paths the CLI and MCP use,
// and scores each room against the ground-truth polygon: relative area error
// under three boundary conventions (polygon as is, inside face, centreline),
// IoU, a leak flag (fill > 1.5x the room) and an unbounded flag (fill error).
// Prints per-variant, per-room-type tables and optionally the per-room JSON.
// Rooms the task file marks open (no wall or door between them and a
// neighbour) or expect-leak (outside the envelope) are scored on their own
// rows; "all enclosed rooms" is the headline.
//
//   node --experimental-strip-types scripts/room-bench.mjs --dir <outdir>
//       [--variants ABC] [--hints all|scale|labels|none] [--limit N] [--ids 1,8]
//       [--jobs N] [--json out.json] [--quiet]
//
// Setup (dataset, Python deps) is in scripts/bench/README.md.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { RASTER_SCALE } from '../src/engine/ports.ts';
import { dynamicFill } from '../src/engine/dynamicfill.ts';
import { vectorDocPage } from '../src/headless/ops.ts';
import { doorBridgesFor } from '../src/engine/fill-vector.ts';
import { roomLabelPoints } from '../src/engine/ocr.ts';

// --- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(name);
const dir = opt('--dir', null);
if (!dir || !existsSync(dir)) {
  console.error('usage: room-bench.mjs --dir <folder from resplan_to_pdf.py> [--variants ABC] [--hints all|scale|labels|none] [--limit N] [--ids a,b] [--jobs N] [--json out.json]');
  process.exit(2);
}
const hintsMode = opt('--hints', 'all');
const jsonOut = opt('--json', null);
const quiet = flag('--quiet');
const isWorker = flag('--worker');
const jobs = Math.max(1, Number(opt('--jobs', '1')) || 1);
const limit = Number(opt('--limit', '0')) || 0;
const idsArg = opt('--ids', null);
const LEAK_FACTOR = 1.5;

const index = existsSync(join(dir, 'index.json')) ? JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) : null;
let planIds = idsArg
  ? idsArg.split(',').map((s) => s.trim()).filter(Boolean)
  : index?.ids?.map(String) ?? readdirSync(dir).filter((f) => f.endsWith('_tasks.json')).map((f) => f.replace('_tasks.json', '')).sort((a, b) => Number(a) - Number(b));
if (limit > 0) planIds = planIds.slice(0, limit);
const variants = (opt('--variants', index?.variants?.filter((v) => v !== 'D').join('') ?? 'ABC')).toUpperCase().split('').filter((v) => 'ABCD'.includes(v));

// --- geometry ----------------------------------------------------------------
function polyArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** x crossings of the rings (even-odd) with the horizontal line at y, as sorted spans */
function spansAt(rings, y) {
  const xs = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      if (y1 === y2) continue;
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
  }
  xs.sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
  return spans;
}

function spanLength(spans) {
  let l = 0;
  for (const [a, b] of spans) l += b - a;
  return l;
}

function spanIntersection(a, b) {
  let l = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) l += hi - lo;
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return l;
}

/**
 * IoU of two even-odd polygons given as ring lists ([[x, y], ...]), exact in
 * x and sampled in y every `step` PDF points (0.25 pt = 0.75 raster px at the
 * fill's render scale, so the sampling error is well under the trace error).
 */
export function polygonIoU(ringsA, ringsB, step = 0.25) {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const ring of [...ringsA, ...ringsB]) for (const [, y] of ring) {
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  if (!(ymax > ymin)) return 0;
  let inter = 0;
  let union = 0;
  for (let y = ymin + step / 2; y < ymax; y += step) {
    const a = spansAt(ringsA, y);
    const b = spansAt(ringsB, y);
    const i = spanIntersection(a, b);
    inter += i;
    union += spanLength(a) + spanLength(b) - i;
  }
  return union > 0 ? inter / union : 0;
}

// --- one plan, one variant ---------------------------------------------------
async function runPlan(id) {
  const tasks = JSON.parse(readFileSync(join(dir, `${id}_tasks.json`), 'utf8'));
  const mpp = tasks.metersPerPt;
  const out = [];
  for (const v of variants) {
    const pdfPath = join(dir, `${id}_${v}.pdf`);
    if (!existsSync(pdfPath)) continue;
    const pdf = await openPdf(new Uint8Array(readFileSync(pdfPath)));
    const raster = await renderRasterNode(pdf, 1, RASTER_SCALE);
    const items = (await (await pdf.getPage(1)).getTextContent()).items;
    const hints = {
      ...(hintsMode === 'all' || hintsMode === 'labels' ? { labels: roomLabelPoints(items) } : {}),
      ...(hintsMode === 'all' || hintsMode === 'scale' ? { metersPerPt: mpp } : {}),
      ...(hintsMode === 'all' ? { bridges: doorBridgesFor(await vectorDocPage(pdf, 1), mpp) } : {}),
    };
    for (const room of tasks.rooms) {
      const rec = {
        plan: String(id),
        variant: v,
        room: room.name,
        type: room.type,
        expectLeak: !!room.expectLeak,
        open: !!room.open,
        doors: room.doors ?? null,
        gt_m2: room.gt_m2,
        gt_face_m2: room.gt_face_m2,
        gt_centre_m2: room.gt_centre_m2,
        gt_face_nodoor_m2: room.gt_face_nodoor_m2 ?? null,
      };
      let res = null;
      let click = null;
      const t0 = performance.now();
      for (const c of room.clicks ?? []) {
        click = c;
        res = dynamicFill(raster, { x: c[0], y: c[1] }, undefined, hints);
        if (!('error' in res) || !/clicked on a line/.test(res.error)) break;
      }
      rec.ms = Math.round(performance.now() - t0);
      rec.click = click;
      if (!res || 'error' in res) {
        rec.unbounded = !!res && /not bounded/.test(res.error);
        rec.error = res ? res.error : 'no click point';
        rec.leak = false;
        rec.iou = 0;
        rec.iouFace = 0;
        rec.fill_m2 = null;
      } else {
        const fillRings = [res.points.map((p) => [p.x, p.y])];
        rec.fill_m2 = polyArea(res.points) * mpp * mpp;
        rec.relErr = (rec.fill_m2 - room.gt_m2) / room.gt_m2;
        rec.relErrFace = room.gt_face_m2 > 0 ? (rec.fill_m2 - room.gt_face_m2) / room.gt_face_m2 : null;
        rec.relErrCentre = room.gt_centre_m2 > 0 ? (rec.fill_m2 - room.gt_centre_m2) / room.gt_centre_m2 : null;
        rec.relErrFaceNoDoor = room.gt_face_nodoor_m2 > 0 ? (rec.fill_m2 - room.gt_face_nodoor_m2) / room.gt_face_nodoor_m2 : null;
        // variant C draws door swings as ink, so the fill stops at the arc: score it against the face area minus the swings too
        const faceSwing = v === 'C' && room.swing_m2 ? room.gt_face_m2 - room.swing_m2 : room.gt_face_m2;
        rec.relErrSwing = faceSwing > 0 ? (rec.fill_m2 - faceSwing) / faceSwing : null;
        rec.iou = polygonIoU(fillRings, room.gt_rings);
        rec.iouFace = room.gt_face_rings?.length ? polygonIoU(fillRings, room.gt_face_rings) : null;
        rec.leak = rec.fill_m2 > LEAK_FACTOR * room.gt_m2;
        rec.unbounded = false;
        if (res.gapPx) rec.gapPx = res.gapPx;
        if (res.bridged) rec.bridged = true;
        rec.vertices = res.points.length;
      }
      out.push(rec);
    }
    await pdf.destroy?.();
  }
  return out;
}

// --- aggregation -------------------------------------------------------------
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const pct = (x) => (x === null || x === undefined ? '   -  ' : `${(100 * x).toFixed(1).padStart(5)}%`);
const num = (x, d = 3) => (x === null || x === undefined ? '  -  ' : x.toFixed(d).padStart(5));

function summarise(recs) {
  const n = recs.length;
  const ok = recs.filter((r) => r.fill_m2 !== null);
  const errFace = ok.filter((r) => r.relErrFace !== null).map((r) => r.relErrFace);
  const errAsIs = ok.map((r) => r.relErr);
  const errCentre = ok.filter((r) => r.relErrCentre !== null).map((r) => r.relErrCentre);
  const errSwing = ok.filter((r) => r.relErrSwing !== null && r.relErrSwing !== undefined).map((r) => r.relErrSwing);
  const errNoDoor = ok.filter((r) => r.relErrFaceNoDoor !== null && r.relErrFaceNoDoor !== undefined).map((r) => r.relErrFaceNoDoor);
  return {
    n,
    measured: ok.length,
    medErrFace: quantile(errFace, 0.5),
    p90AbsErrFace: quantile(errFace.map(Math.abs), 0.9),
    medErrAsIs: quantile(errAsIs, 0.5),
    medErrCentre: quantile(errCentre, 0.5),
    medErrSwing: quantile(errSwing, 0.5),
    medErrFaceNoDoor: quantile(errNoDoor, 0.5),
    medIoU: quantile(recs.map((r) => r.iou), 0.5),
    medIoUFace: quantile(recs.filter((r) => r.iouFace !== null).map((r) => r.iouFace), 0.5),
    leakRate: n ? recs.filter((r) => r.leak).length / n : null,
    unboundedRate: n ? recs.filter((r) => r.unbounded).length / n : null,
    recovered: n ? recs.filter((r) => r.iou >= 0.5 && !r.leak).length / n : null,
  };
}

function report(all) {
  const summary = {};
  const TYPES = ['living', 'bedroom', 'bathroom', 'kitchen', 'storage', 'stair', 'balcony', 'garden', 'parking', 'pool'];
  for (const v of variants) {
    const recs = all.filter((r) => r.variant === v);
    if (!recs.length) continue;
    const rows = [];
    const enclosed = recs.filter((r) => !r.expectLeak && !r.open);
    for (const t of TYPES) {
      const rs = enclosed.filter((r) => r.type === t);
      if (rs.length) rows.push({ label: t, ...summarise(rs) });
    }
    rows.push({ label: 'all enclosed rooms', ...summarise(enclosed) });
    const open = recs.filter((r) => !r.expectLeak && r.open);
    if (open.length) rows.push({ label: 'open-plan (expect merge)', ...summarise(open) });
    for (const t of TYPES) {
      const rs = recs.filter((r) => r.expectLeak && r.type === t);
      if (rs.length) rows.push({ label: `${t} (expect leak)`, ...summarise(rs) });
    }
    summary[v] = { rows, plans: new Set(recs.map((r) => r.plan)).size };
    if (quiet) continue;
    console.log(`\nvariant ${v}  (${summary[v].plans} plans, hints=${hintsMode}; rel err vs inside-face area unless noted)`);
    const swingCol = v === 'C';
    console.log(`${'room type'.padEnd(24)} ${'n'.padStart(5)}  ${'med err'.padStart(7)}  ${'p90|err|'.padStart(8)}  ${'med asis'.padStart(8)}  ${'med ctr'.padStart(7)}${swingCol ? '  no-swing' : ''}  ${'IoU'.padStart(5)}  ${'IoUf'.padStart(5)}  ${'leak'.padStart(6)}  ${'unbnd'.padStart(6)}  ${'recov'.padStart(6)}`);
    for (const r of rows) {
      console.log(
        `${r.label.padEnd(24)} ${String(r.n).padStart(5)}  ${pct(r.medErrFace).padStart(7)}  ${pct(r.p90AbsErrFace).padStart(8)}  ${pct(r.medErrAsIs).padStart(8)}  ${pct(r.medErrCentre).padStart(7)}${swingCol ? `  ${pct(r.medErrSwing).padStart(8)}` : ''}  ${num(r.medIoU)}  ${num(r.medIoUFace)}  ${pct(r.leakRate)}  ${pct(r.unboundedRate)}  ${pct(r.recovered)}`,
      );
    }
    if (swingCol) console.log('  (no-swing: rel err vs inside-face area minus the door swing sectors the arcs wall off)');
    const encl = rows.find((r) => r.label === 'all enclosed rooms');
    if (encl?.medErrFaceNoDoor !== null && encl?.medErrFaceNoDoor !== undefined) console.log(`  (enclosed rooms vs inside face minus door openings: median ${pct(encl.medErrFaceNoDoor).trim()})`);
  }
  return summary;
}

// --- driver ------------------------------------------------------------------
async function runSerial(ids) {
  const all = [];
  let done = 0;
  for (const id of ids) {
    try {
      all.push(...(await runPlan(id)));
    } catch (err) {
      console.error(`plan ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    done++;
    if (!quiet && !isWorker && done % 10 === 0) process.stderr.write(`  ${done}/${ids.length} plans\r`);
  }
  return all;
}

async function runParallel(ids) {
  const tmp = mkdtempSync(join(tmpdir(), 'room-bench-'));
  const chunks = Array.from({ length: jobs }, () => []);
  ids.forEach((id, i) => chunks[i % jobs].push(id));
  const runs = chunks.filter((c) => c.length).map(
    (chunk, k) =>
      new Promise((resolve, reject) => {
        const outFile = join(tmp, `part-${k}.json`);
        const args = [...process.execArgv, process.argv[1], '--worker', '--dir', dir, '--variants', variants.join(''), '--hints', hintsMode, '--ids', chunk.join(','), '--json', outFile, '--quiet'];
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(readFileSync(outFile, 'utf8')).rooms) : reject(new Error(`worker ${k} exited ${code}`))));
        child.on('error', reject);
      }),
  );
  const parts = await Promise.all(runs);
  rmSync(tmp, { recursive: true, force: true });
  return parts.flat();
}

const t0 = performance.now();
const all = jobs > 1 && !isWorker ? await runParallel(planIds) : await runSerial(planIds);
const secs = (performance.now() - t0) / 1000;
if (isWorker) {
  writeFileSync(jsonOut, JSON.stringify({ rooms: all }));
  process.exit(0);
}
const summary = report(all);
if (!quiet) console.log(`\n${all.length} room fills on ${planIds.length} plans x ${variants.length} variants in ${secs.toFixed(0)} s (${RASTER_SCALE} px/pt)`);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ dir, hints: hintsMode, variants, plans: planIds.length, rasterScale: RASTER_SCALE, seconds: Math.round(secs), summary, rooms: all }, null, 1) + '\n');
  if (!quiet) console.log(`wrote ${jsonOut}`);
}
