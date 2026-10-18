#!/usr/bin/env node
// Dataset-P&ID one-shot counting benchmark over many sheets.
//
// Runs the single-sheet protocol of scripts/check-scan-dataset.mts (click the
// centre of the first ground-truth instance of every class, run the scan,
// match hits to that class's boxes by centre-in-box) on every sheet of a
// manifest written by scripts/bench/pid_fetch.py, and aggregates:
//   - per class, pooled over sheets: GT, hits, TP, recall, precision, the
//     exact-count rate and MAPE over (sheet, class) pairs, mean scan time;
//   - overall: pooled numbers and the mean of the per-sheet means;
//   - per sheet: classes, boxes, mean recall, mean precision, exact rate,
//     MAPE, scan time and wall time of the harness process;
//   - the worst (sheet, class) pairs with a heuristic failure type.
//
// Tier-1 CV path (default): the harness is spawned once per sheet with
// --json, so its code is run unchanged; nothing engine-side lives here.
// Detector path (--model <dir>): each click goes through the CLI
// (`pdf2takeoff scan sheet.png --at x,y --model <dir>`), which opens the PNG
// as one page of W/3 x H/3 points and answers with the trained ONNX model
// when the directory holds symbols.json + symbols.onnx. Same protocol, same
// matching, so detector and CV numbers are comparable.
//
//   node scripts/bench/pid-count-bench.mjs --manifest /data/pid/manifest.json \
//     [--jobs 2] [--limit 10] [--sheets 134,7] [--k 3] \
//     [--remove-lines auto|true|false] [--dihedral on|off] [--match-distance 0.15] \
//     [--model public/models] [--json out.json] [--md out.md] [--worst 10] [--keep-scans dir]
//
// Failure types (heuristic, from the per-class row and the label file):
//   click rejected          the scan returned an error for the click
//   rotated sibling missed  misses dominate and the class has instances in
//                           both orientations on the sheet (a 90 degree twin)
//   fused with text         misses dominate on an instrument bubble or box
//                           class (paper Symbols 26 to 32, which carry tag
//                           text and leaders), or the click resolved through
//                           the glyph-sized path
//   interior differs        misses dominate, same orientation and size: the
//                           siblings' interior or attachments differ
//   look-alike confusion    false hits dominate and land in another class's
//                           boxes (named)
//   spurious hits           false hits dominate and land outside every box

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = join(ROOT, 'scripts', 'check-scan-dataset.mts');
const CLI = join(ROOT, 'bin', 'pdf2takeoff.js');

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args.set(a.slice(2), 'true');
    else args.set(a.slice(2), next), i++;
  }
}
const manifestPath = args.get('manifest');
if (!manifestPath) {
  console.error('usage: pid-count-bench.mjs --manifest manifest.json [--jobs 2] [--limit N] [--sheets a,b] [--k 3] [--remove-lines auto|true|false] [--dihedral on|off] [--match-distance 0.15] [--model dir] [--json out.json] [--md out.md] [--worst 10] [--keep-scans dir]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const base = dirname(resolve(manifestPath));
const k = Number(args.get('k') ?? '3');
const jobs = Math.max(1, Number(args.get('jobs') ?? Math.min(2, availableParallelism())));
const worstN = Number(args.get('worst') ?? '10');
const modelDir = args.get('model');
const keepScans = args.get('keep-scans');
if (keepScans) mkdirSync(keepScans, { recursive: true });
const classes = manifest.classes ?? readFileSync(join(base, 'classes.txt'), 'utf8').trim().split('\n');
const basicGroup = new Set(classes.map((_, i) => i).filter((i) => /^S(2[6-9]|3[0-2])_/.test(classes[i])));

let sheets = manifest.sheets.slice();
if (args.get('sheets')) {
  const want = new Set(args.get('sheets').split(',').map(Number));
  sheets = sheets.filter((s) => want.has(Number(s.sheet)));
}
if (args.get('limit')) sheets = sheets.slice(0, Number(args.get('limit')));
if (!sheets.length) {
  console.error('no sheets selected');
  process.exit(2);
}

const harnessFlags = [];
for (const f of ['remove-lines', 'dihedral', 'match-distance']) if (args.get(f)) harnessFlags.push(`--${f}`, args.get(f));

function run(cmd, argv, opts = {}) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const p = spawn(cmd, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => res({ code, out, err, ms: Date.now() - t0 }));
  });
}

function readBoxes(labelsPath, W, H) {
  return readFileSync(labelsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const p = l.trim().split(/\s+/).map(Number);
      return { c: p[0], cx: p[1] * W, cy: p[2] * H, w: p[3] * W, h: p[4] * H };
    });
}
const inside = (x, y, g) => Math.abs(x - g.cx) <= g.w / 2 && Math.abs(y - g.cy) <= g.h / 2;

/** Tier-1 path: one harness process per sheet, rows straight from its --json. */
async function scanSheetHarness(s, tmpJson) {
  const r = await run(process.execPath, ['--experimental-strip-types', HARNESS, '--png', join(base, s.image), '--labels', join(base, s.labels), '--classes', join(base, 'classes.txt'), '--k', String(k), ...harnessFlags, '--json', tmpJson]);
  if (r.code !== 0 || !existsSync(tmpJson)) throw new Error(`harness failed on sheet ${s.sheet} (exit ${r.code}): ${r.err.slice(-800)}`);
  const j = JSON.parse(readFileSync(tmpJson, 'utf8'));
  return { rows: j.rows, wallMs: r.ms };
}

/** Detector path: one CLI scan per class through the model directory. */
async function scanSheetModel(s) {
  const W = s.width;
  const H = s.height;
  const gt = readBoxes(join(base, s.labels), W, H);
  const byClass = new Map();
  for (const g of gt) byClass.set(g.c, [...(byClass.get(g.c) ?? []), g]);
  const rows = [];
  const t0 = Date.now();
  for (const [c, inst] of [...byClass.entries()].sort((a, b) => a[0] - b[0])) {
    const q = inst[0];
    const name = classes[c] ?? String(c);
    const at = `${(q.cx / k).toFixed(2)},${((H - q.cy) / k).toFixed(2)}`;
    const r = await run(process.execPath, [CLI, 'scan', join(base, s.image), '--page', '1', '--at', at, '--model', modelDir]);
    if (r.code !== 0) {
      rows.push({ cls: c, name, gt: inst.length, error: r.err.trim().split('\n').pop() ?? 'scan failed', ms: r.ms });
      continue;
    }
    const res = JSON.parse(r.out);
    const hits = res.hits.map((p) => ({ x: p.x * k, y: H - p.y * k }));
    const matched = new Set();
    let tp = 0;
    const confusions = {};
    for (const p of hits) {
      const i = inst.findIndex((g) => inside(p.x, p.y, g));
      if (i >= 0) {
        tp++;
        matched.add(i);
        continue;
      }
      const other = gt.find((g) => inside(p.x, p.y, g));
      const key = other ? classes[other.c] ?? String(other.c) : 'none';
      confusions[key] = (confusions[key] ?? 0) + 1;
    }
    rows.push({ cls: c, name, gt: inst.length, hits: hits.length, tp, precision: tp / Math.max(1, hits.length), recall: matched.size / inst.length, countErr: hits.length - inst.length, note: `provider ${res.provider}`, confusions, ms: r.ms });
  }
  return { rows, wallMs: Date.now() - t0 };
}

function orientation(g) {
  const m = Math.max(g.w, g.h);
  if (Math.abs(g.w - g.h) < 0.15 * m) return 'square';
  return g.w > g.h ? 'landscape' : 'portrait';
}

function failureType(row, inst) {
  if (row.error) return 'click rejected';
  const misses = Math.round(row.gt * (1 - row.recall));
  const falseHits = row.hits - row.tp;
  if (misses === 0 && falseHits === 0) return 'none';
  if (misses >= falseHits) {
    const first = orientation(inst[0]);
    if (first !== 'square' && inst.some((g) => orientation(g) !== 'square' && orientation(g) !== first)) return 'rotated sibling missed';
    if (basicGroup.has(row.cls) || /glyph-sized/.test(row.note ?? '') || /text/.test(row.note ?? '')) return 'fused with text';
    return 'interior differs';
  }
  const conf = Object.entries(row.confusions ?? {}).sort((a, b) => b[1] - a[1]);
  if (conf.length && conf[0][0] !== 'none') return `look-alike confusion (${conf[0][0]})`;
  return 'spurious hits';
}

// --- run ---------------------------------------------------------------------
const started = Date.now();
const perSheet = [];
const queue = sheets.slice();
console.error(`${sheets.length} sheets, ${jobs} job(s), ${modelDir ? `detector via --model ${modelDir}` : 'tier-1 CV via check-scan-dataset.mts'}${harnessFlags.length ? ' ' + harnessFlags.join(' ') : ''}`);
async function worker(id) {
  while (queue.length) {
    const s = queue.shift();
    const tmpJson = join(keepScans ?? join(base, '_scans'), `${s.sheet}${modelDir ? '.model' : ''}.json`);
    mkdirSync(dirname(tmpJson), { recursive: true });
    try {
      const { rows, wallMs } = modelDir ? await scanSheetModel(s) : await scanSheetHarness(s, tmpJson);
      if (modelDir) writeFileSync(tmpJson, JSON.stringify({ sheet: s.sheet, model: modelDir, rows }, null, 1) + '\n');
      const gt = readBoxes(join(base, s.labels), s.width, s.height);
      const byClass = new Map();
      for (const g of gt) byClass.set(g.c, [...(byClass.get(g.c) ?? []), g]);
      for (const r of rows) r.failure = failureType(r, byClass.get(r.cls) ?? []);
      const scored = rows.filter((r) => r.recall !== undefined);
      const n = rows.length;
      const meanRecall = rows.reduce((a, r) => a + (r.recall ?? 0), 0) / Math.max(1, n);
      const meanPrecision = rows.reduce((a, r) => a + (r.precision ?? 0), 0) / Math.max(1, n);
      const exact = rows.filter((r) => r.countErr === 0).length;
      const gt3 = scored.filter((r) => r.gt >= 3);
      const mape = gt3.reduce((a, r) => a + Math.abs(r.countErr) / r.gt, 0) / Math.max(1, gt3.length);
      const scanMs = rows.reduce((a, r) => a + r.ms, 0);
      perSheet.push({ sheet: s.sheet, boxes: gt.length, classes: n, meanRecall, meanPrecision, exact, exactRate: exact / Math.max(1, n), mape, mapeClasses: gt3.length, errors: rows.filter((r) => r.error).length, scanMs, wallMs, rows });
      console.error(`[${perSheet.length}/${sheets.length}] sheet ${s.sheet}: ${n} classes, recall ${meanRecall.toFixed(3)}, precision ${meanPrecision.toFixed(3)}, exact ${exact}/${n}, MAPE ${(mape * 100).toFixed(0)}%, scans ${(scanMs / 1000).toFixed(1)}s, wall ${(wallMs / 1000).toFixed(1)}s (job ${id})`);
    } catch (e) {
      console.error(`sheet ${s.sheet}: ${e.message}`);
      perSheet.push({ sheet: s.sheet, failed: String(e.message) });
    }
  }
}
await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i + 1)));
perSheet.sort((a, b) => Number(a.sheet) - Number(b.sheet));

// --- aggregate ----------------------------------------------------------------
const ok = perSheet.filter((s) => !s.failed);
const allRows = ok.flatMap((s) => s.rows.map((r) => ({ ...r, sheet: s.sheet })));
const perClass = new Map();
for (const r of allRows) {
  const a = perClass.get(r.cls) ?? { cls: r.cls, name: r.name, sheets: 0, gt: 0, hits: 0, tp: 0, matched: 0, exact: 0, errors: 0, pairs: 0, apeSum: 0, apeN: 0, msSum: 0, failures: {} };
  a.sheets++;
  a.gt += r.gt;
  a.msSum += r.ms;
  if (r.error) a.errors++;
  else {
    a.hits += r.hits;
    a.tp += r.tp;
    a.matched += Math.round(r.recall * r.gt);
    a.pairs++;
    if (r.countErr === 0) a.exact++;
    if (r.gt >= 3) {
      a.apeSum += Math.abs(r.countErr) / r.gt;
      a.apeN++;
    }
  }
  if (r.failure !== 'none') a.failures[r.failure] = (a.failures[r.failure] ?? 0) + 1;
  perClass.set(r.cls, a);
}
const classTable = [...perClass.values()]
  .sort((a, b) => a.cls - b.cls)
  .map((a) => ({
    cls: a.cls,
    name: a.name,
    sheets: a.sheets,
    gt: a.gt,
    hits: a.hits,
    tp: a.tp,
    recall: a.matched / Math.max(1, a.gt),
    precision: a.tp / Math.max(1, a.hits),
    exactRate: a.exact / Math.max(1, a.sheets),
    mape: a.apeN ? a.apeSum / a.apeN : null,
    mapePairs: a.apeN,
    errors: a.errors,
    meanMs: a.msSum / Math.max(1, a.sheets),
    failures: a.failures,
  }));
const scoredRows = allRows.filter((r) => !r.error);
const pooled = {
  pairs: allRows.length,
  sheets: ok.length,
  gt: allRows.reduce((a, r) => a + r.gt, 0),
  hits: scoredRows.reduce((a, r) => a + r.hits, 0),
  tp: scoredRows.reduce((a, r) => a + r.tp, 0),
  matched: scoredRows.reduce((a, r) => a + Math.round(r.recall * r.gt), 0),
  exact: scoredRows.filter((r) => r.countErr === 0).length,
  errors: allRows.filter((r) => r.error).length,
};
pooled.recall = pooled.matched / Math.max(1, pooled.gt);
pooled.precision = pooled.tp / Math.max(1, pooled.hits);
pooled.exactRate = pooled.exact / Math.max(1, pooled.pairs);
const gt3 = scoredRows.filter((r) => r.gt >= 3);
pooled.mape = gt3.reduce((a, r) => a + Math.abs(r.countErr) / r.gt, 0) / Math.max(1, gt3.length);
pooled.mapePairs = gt3.length;
const meanOf = (f) => ok.reduce((a, s) => a + f(s), 0) / Math.max(1, ok.length);
const sheetMeans = {
  meanRecall: meanOf((s) => s.meanRecall),
  meanPrecision: meanOf((s) => s.meanPrecision),
  exactRate: meanOf((s) => s.exactRate),
  mape: meanOf((s) => s.mape),
  scanMs: meanOf((s) => s.scanMs),
  wallMs: meanOf((s) => s.wallMs),
  msPerClick: allRows.reduce((a, r) => a + r.ms, 0) / Math.max(1, allRows.length),
  classesPerSheet: meanOf((s) => s.classes),
  boxesPerSheet: meanOf((s) => s.boxes),
};
const failureTotals = {};
for (const r of allRows) if (r.failure !== 'none') failureTotals[r.failure] = (failureTotals[r.failure] ?? 0) + 1;
const worst = allRows
  .map((r) => ({ ...r, misses: r.error ? r.gt : Math.round(r.gt * (1 - r.recall)), falseHits: r.error ? 0 : r.hits - r.tp }))
  .map((r) => ({ ...r, errorsTotal: r.misses + r.falseHits }))
  .sort((a, b) => b.errorsTotal - a.errorsTotal || b.gt - a.gt || Number(a.sheet) - Number(b.sheet))
  .slice(0, worstN);

// --- report -------------------------------------------------------------------
const pct = (v) => (v === null || v === undefined || Number.isNaN(v) ? '' : `${(v * 100).toFixed(0)}%`);
const f3 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '' : v.toFixed(3));
const mode = modelDir ? `detector (${modelDir})` : `tier-1 CV${harnessFlags.length ? ' ' + harnessFlags.join(' ') : ' (defaults)'}`;
const lines = [];
lines.push(`# Dataset-P&ID one-shot count bench: ${ok.length} sheets, ${mode}`, '');
lines.push(`Manifest ${manifestPath}; ${pooled.pairs} (sheet, class) pairs, ${pooled.gt} ground-truth symbols; ${jobs} job(s); ${((Date.now() - started) / 1000).toFixed(0)} s wall.`, '');
lines.push('| metric | mean of per-sheet means | pooled over all pairs |', '| --- | --- | --- |');
lines.push(`| mean recall | ${f3(sheetMeans.meanRecall)} | ${f3(pooled.recall)} |`);
lines.push(`| mean precision | ${f3(sheetMeans.meanPrecision)} | ${f3(pooled.precision)} |`);
lines.push(`| exact-count rate | ${pct(sheetMeans.exactRate)} | ${pct(pooled.exactRate)} (${pooled.exact} of ${pooled.pairs}) |`);
lines.push(`| MAPE (classes with 3 or more instances) | ${pct(sheetMeans.mape)} | ${pct(pooled.mape)} (${pooled.mapePairs} pairs) |`);
lines.push(`| clicks rejected | | ${pooled.errors} |`);
lines.push(`| per sheet | ${(sheetMeans.scanMs / 1000).toFixed(1)} s in scans, ${(sheetMeans.wallMs / 1000).toFixed(1)} s wall, ${sheetMeans.classesPerSheet.toFixed(1)} classes, ${sheetMeans.boxesPerSheet.toFixed(0)} symbols | ${(sheetMeans.msPerClick / 1000).toFixed(2)} s per click |`);
lines.push('', '## Per class (pooled over sheets)', '');
lines.push('| id | class | sheets | GT | hits | TP | recall | precision | exact rate | MAPE | ms per click | dominant failure |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const c of classTable) {
  const dom = Object.entries(c.failures).sort((a, b) => b[1] - a[1])[0];
  lines.push(`| ${c.cls} | ${c.name} | ${c.sheets} | ${c.gt} | ${c.hits} | ${c.tp} | ${f3(c.recall)} | ${f3(c.precision)} | ${pct(c.exactRate)} | ${c.mape === null ? '' : pct(c.mape)} | ${c.meanMs.toFixed(0)} | ${dom ? `${dom[0]} (${dom[1]})` : ''} |`);
}
lines.push('', '## Failure types over all pairs', '');
for (const [t, n] of Object.entries(failureTotals).sort((a, b) => b[1] - a[1])) lines.push(`- ${t}: ${n}`);
lines.push('', `## Worst ${worst.length} (sheet, class) pairs`, '');
lines.push('| sheet | class | GT | hits | TP | recall | precision | failure type |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of worst) lines.push(`| ${r.sheet} | ${r.name} | ${r.gt} | ${r.error ? 'error' : r.hits} | ${r.error ? '' : r.tp} | ${r.error ? '' : f3(r.recall)} | ${r.error ? '' : f3(r.precision)} | ${r.failure}${r.error ? `: ${r.error}` : ''} |`);
lines.push('', '## Per sheet', '');
lines.push('| sheet | classes | symbols | mean recall | mean precision | exact | MAPE | scans s | wall s |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const s of perSheet) {
  if (s.failed) lines.push(`| ${s.sheet} | failed | ${s.failed} | | | | | | |`);
  else lines.push(`| ${s.sheet} | ${s.classes} | ${s.boxes} | ${f3(s.meanRecall)} | ${f3(s.meanPrecision)} | ${s.exact}/${s.classes} | ${pct(s.mape)} | ${(s.scanMs / 1000).toFixed(1)} | ${(s.wallMs / 1000).toFixed(1)} |`);
}
const md = lines.join('\n') + '\n';
console.log(md);
if (args.get('md')) writeFileSync(args.get('md'), md);
if (args.get('json')) {
  writeFileSync(
    args.get('json'),
    JSON.stringify(
      {
        manifest: manifestPath,
        mode,
        k,
        jobs,
        harnessFlags,
        model: modelDir ?? null,
        wallMs: Date.now() - started,
        pooled,
        sheetMeans,
        failureTotals,
        perClass: classTable,
        worst,
        perSheet: perSheet.map((s) => (s.failed ? s : { ...s, rows: s.rows })),
      },
      null,
      1,
    ) + '\n',
  );
}
