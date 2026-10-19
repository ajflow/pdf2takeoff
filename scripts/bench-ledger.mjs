#!/usr/bin/env node
// Results ledger: run the fast benches that need no external data and append
// one JSON line per run to bench/results/ledger.jsonl, so accuracy numbers
// travel with the commit that produced them (schema in bench/results/README.md).
//
//   npm run bench:ledger                       run and append a "synthetic" line
//   npm run bench:ledger -- --compare          also print the delta against the previous synthetic line
//   npm run bench:ledger -- --dry-run          run and print the line without appending
//   npm run bench:ledger -- --skip floorplancad   leave the FloorPlanCAD step out (no Python / cairosvg)
//
// What runs (all local, all deterministic):
//   1. scripts/takeoff-bench.mjs    fill pass count + median area error, count exact rate, scale pass count
//   2. scripts/check-scan.mjs       the tier-1 CV scan behavioural check (ok or failure count)
//   3. FloorPlanCAD synthetic bench scripts/make-floorplancad-sample.py (seed 7, 3 drawings) ->
//                                   scripts/floorplancad-convert.py --counts-only ->
//                                   scripts/floorplancad-count-bench.mjs: exact rate, recall, stairs recall
//   4. scripts/check-fill.mjs       Dynamic Fill behavioural check: cases, median area error
// Step 3 needs a Python with cairosvg: --python <bin> or PDF2TAKEOFF_PYTHON (default python3),
// --cairosvg <bin> or CAIROSVG (default: next to the Python, else on PATH). Without them the
// line records floorplancad: null and says why.
//
// External-data benches (room-bench, aecv-bench, check-scan-dataset, scaled-drawing-bench)
// append their own line with a `dataset` field:
//   node scripts/bench-ledger.mjs --external room-bench --dataset resplan \
//       --metrics '{"plans":100,"medErrFace":-0.021,"recovered":0.93}' [--source out.json] [--note "..."] [--compare]
// --metrics takes inline JSON or a path to a JSON file holding a flat object of headline numbers.

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);
const ledgerPath = resolve(root, opt('ledger', 'bench/results/ledger.jsonl'));
const compare = flag('compare');
const dryRun = flag('dry-run');
const skip = new Set((opt('skip', '') || '').split(',').filter(Boolean));
const note = opt('note', undefined);
const SCHEMA = 1;

const NODE_TS = [process.execPath, '--experimental-strip-types'];
const run = (cmd, cmdArgs, env = {}) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: Date.now() - t0, error: r.error?.message };
};
const round = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function gitInfo() {
  const git = (...a) => {
    try {
      return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  return { commit: git('rev-parse', '--short=12', 'HEAD'), branch: git('branch', '--show-current'), dirty: dirty === null ? null : dirty.length > 0 };
}

// --- external line -------------------------------------------------------------
function externalLine() {
  const bench = opt('external');
  const dataset = opt('dataset');
  const metricsArg = opt('metrics');
  if (!dataset || !metricsArg) {
    console.error('usage: bench-ledger.mjs --external <bench> --dataset <name> --metrics <json or file> [--source file] [--note text] [--compare]');
    process.exit(2);
  }
  let metrics;
  try {
    metrics = JSON.parse(existsSync(resolve(metricsArg)) ? readFileSync(resolve(metricsArg), 'utf8') : metricsArg);
  } catch (err) {
    console.error(`--metrics is neither inline JSON nor a readable JSON file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) {
    console.error('--metrics must be a JSON object of headline numbers');
    process.exit(2);
  }
  return {
    schema: SCHEMA,
    kind: 'external',
    dataset,
    bench,
    date: new Date().toISOString(),
    ...gitInfo(),
    node: process.version,
    headline: metrics,
    ...(opt('source') ? { source: opt('source') } : {}),
    notes: note ? [note] : [],
  };
}

// --- synthetic line ------------------------------------------------------------
function takeoffBench(tmp) {
  const out = join(tmp, 'takeoff-bench.json');
  const r = run(NODE_TS[0], [NODE_TS[1], 'scripts/takeoff-bench.mjs', '--json', out]);
  if (!existsSync(out)) return { ok: false, ms: r.ms, error: r.error ?? r.stderr.trim().split('\n').pop() ?? `exit ${r.status}` };
  const results = JSON.parse(readFileSync(out, 'utf8'));
  const by = (kind) => results.filter((x) => x.kind === kind);
  const fill = by('fill');
  const fillErrs = fill.map((x) => /\(([\d.]+)%\)/.exec(x.detail)?.[1]).filter((v) => v !== undefined).map(Number);
  const count = by('count');
  const scale = by('scale');
  return {
    ok: r.status === 0,
    ms: r.ms,
    fill: { pass: fill.filter((x) => x.pass).length, total: fill.length, medianErrPct: round(median(fillErrs), 2) },
    count: { exact: count.filter((x) => x.pass).length, total: count.length },
    scale: { pass: scale.filter((x) => x.pass).length, total: scale.length },
    knownOpen: results.filter((x) => x.known && !x.pass).length,
    failing: results.filter((x) => !x.pass && !x.known).map((x) => x.id),
  };
}

function scanCheck() {
  const r = run(NODE_TS[0], [NODE_TS[1], 'scripts/check-scan.mjs']);
  const failures = (r.stderr.match(/^FAIL /gm) ?? []).length;
  return { ok: r.status === 0 && /scan check OK/.test(r.stdout), ms: r.ms, failures, cases: r.stdout.split('\n').filter((l) => /^[a-z-]+: /.test(l)).length, ...(r.error ? { error: r.error } : {}) };
}

function fillCheck() {
  const r = run(NODE_TS[0], [NODE_TS[1], 'scripts/check-fill.mjs']);
  const errs = [];
  for (const m of r.stdout.matchAll(/area (\d+(?:\.\d+)?) \(ideal ~(\d+(?:\.\d+)?)/g)) errs.push((100 * Math.abs(Number(m[1]) - Number(m[2]))) / Number(m[2]));
  const fails = r.stdout.split('\n').concat(r.stderr.split('\n')).filter((l) => l.startsWith('FAIL'));
  return { ok: r.status === 0, ms: r.ms, cases: errs.length, medianErrPct: round(median(errs), 2), maxErrPct: round(errs.length ? Math.max(...errs) : null, 2), failures: fails.length, ...(r.error ? { error: r.error } : {}) };
}

function floorplancadBench(tmp) {
  const python = opt('python', process.env.PDF2TAKEOFF_PYTHON || 'python3');
  const besidePython = join(dirname(python), 'cairosvg');
  const cairosvg = opt('cairosvg', process.env.CAIROSVG || (python.includes('/') && existsSync(besidePython) ? besidePython : 'cairosvg'));
  const svg = join(tmp, 'fpc-svg');
  const ds = join(tmp, 'fpc-ds');
  const pdf = join(tmp, 'fpc-pdf');
  const out = join(tmp, 'fpc.json');
  const t0 = Date.now();
  const gen = run(python, ['-I', 'scripts/make-floorplancad-sample.py', '--out', svg, '--count', '3', '--seed', '7']);
  if (gen.status !== 0) return { ok: false, ms: Date.now() - t0, error: `sample generator: ${gen.error ?? gen.stderr.trim().split('\n').pop() ?? `exit ${gen.status}`}` };
  const conv = run(python, ['-I', 'scripts/floorplancad-convert.py', '--src', svg, '--out', ds, '--counts-only']);
  if (conv.status !== 0 || !existsSync(join(ds, 'counts.json'))) return { ok: false, ms: Date.now() - t0, error: `converter (needs cairosvg in the Python): ${conv.error ?? conv.stderr.trim().split('\n').pop() ?? `exit ${conv.status}`}` };
  mkdirSync(pdf, { recursive: true });
  const bench = run(NODE_TS[0], [NODE_TS[1], 'scripts/floorplancad-count-bench.mjs', svg, '--counts', join(ds, 'counts.json'), '--pdf-dir', pdf, '--json', out], { CAIROSVG: cairosvg });
  if (bench.status !== 0 || !existsSync(out)) return { ok: false, ms: Date.now() - t0, error: `count bench (needs cairosvg at ${cairosvg}): ${bench.error ?? bench.stderr.trim().split('\n').pop() ?? `exit ${bench.status}`}` };
  const j = JSON.parse(readFileSync(out, 'utf8'));
  const all = { pages: 0, exact: 0, tp: 0, fp: 0, fn: 0 };
  const perClass = {};
  for (const [name, c] of Object.entries(j.perClass)) {
    for (const k of Object.keys(all)) all[k] += c[k];
    perClass[name] = { pages: c.pages, exactRate: round(c.exact / c.pages), recall: round(c.tp / Math.max(1, c.tp + c.fn)), precision: round(c.tp / Math.max(1, c.tp + c.fp)) };
  }
  return {
    ok: true,
    ms: Date.now() - t0,
    drawings: j.drawings.length,
    policy: j.policy,
    pages: all.pages,
    exactRate: round(all.exact / all.pages),
    recall: round(all.tp / Math.max(1, all.tp + all.fn)),
    precision: round(all.tp / Math.max(1, all.tp + all.fp)),
    perClass,
  };
}

function syntheticLine() {
  const tmp = mkdtempSync(join(tmpdir(), 'bench-ledger-'));
  const t0 = Date.now();
  const steps = {};
  try {
    process.stderr.write('ledger: takeoff bench\n');
    steps.takeoff = takeoffBench(tmp);
    process.stderr.write('ledger: scan check\n');
    steps.scanCheck = scanCheck();
    process.stderr.write('ledger: fill check\n');
    steps.fillCheck = fillCheck();
    if (skip.has('floorplancad')) steps.floorplancad = null;
    else {
      process.stderr.write('ledger: FloorPlanCAD synthetic count bench\n');
      steps.floorplancad = floorplancadBench(tmp);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const notes = note ? [note] : [];
  if (steps.floorplancad === null) notes.push('floorplancad skipped (--skip floorplancad)');
  else if (!steps.floorplancad.ok) notes.push(`floorplancad not run: ${steps.floorplancad.error}`);
  for (const k of ['takeoff', 'scanCheck', 'fillCheck']) if (!steps[k].ok) notes.push(`${k} failed${steps[k].error ? `: ${steps[k].error}` : ''}`);
  const fpc = steps.floorplancad?.ok ? steps.floorplancad : null;
  const t = steps.takeoff.ok || steps.takeoff.fill ? steps.takeoff : null;
  return {
    schema: SCHEMA,
    kind: 'synthetic',
    dataset: 'synthetic',
    date: new Date().toISOString(),
    ...gitInfo(),
    node: process.version,
    durationMs: Date.now() - t0,
    headline: {
      fillPass: t?.fill?.pass ?? null,
      fillTotal: t?.fill?.total ?? null,
      fillMedianErrPct: t?.fill?.medianErrPct ?? null,
      countExact: t?.count?.exact ?? null,
      countTotal: t?.count?.total ?? null,
      countExactRate: t?.count ? round(t.count.exact / Math.max(1, t.count.total)) : null,
      scalePass: t?.scale?.pass ?? null,
      scaleTotal: t?.scale?.total ?? null,
      knownOpen: t?.knownOpen ?? null,
      scanCheck: steps.scanCheck.ok ? 'ok' : `${steps.scanCheck.failures} failure(s)`,
      scanCheckFailures: steps.scanCheck.failures,
      fillCheck: steps.fillCheck.ok ? 'ok' : `${steps.fillCheck.failures} failure(s)`,
      fillCheckMedianErrPct: steps.fillCheck.medianErrPct,
      floorplancadExactRate: fpc?.exactRate ?? null,
      floorplancadRecall: fpc?.recall ?? null,
      floorplancadStairsRecall: fpc?.perClass?.stairs?.recall ?? null,
    },
    benches: steps,
    notes,
  };
}

// --- ledger I/O ------------------------------------------------------------------
function readLedger() {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        console.error(`ledger line ${i + 1} is not JSON; skipped`);
        return null;
      }
    })
    .filter(Boolean);
}

function printDelta(prev, cur) {
  if (!prev) {
    console.log(`compare: no earlier ${cur.kind === 'external' ? `${cur.bench} / ${cur.dataset}` : cur.dataset} line to compare against`);
    return;
  }
  console.log(`compare: ${prev.commit ?? '?'} (${prev.date}) -> ${cur.commit ?? '?'} (${cur.date})`);
  const keys = [...new Set([...Object.keys(prev.headline ?? {}), ...Object.keys(cur.headline ?? {})])];
  for (const k of keys) {
    const a = prev.headline?.[k];
    const b = cur.headline?.[k];
    let delta = '';
    if (typeof a === 'number' && typeof b === 'number') {
      const d = b - a;
      delta = d === 0 ? 'same' : `${d > 0 ? '+' : ''}${round(d, 4)}`;
    } else delta = a === b ? 'same' : 'changed';
    console.log(`  ${k.padEnd(28)} ${String(a ?? 'n/a').padStart(10)} -> ${String(b ?? 'n/a').padStart(10)}  ${delta}`);
  }
}

const line = flag('external') ? externalLine() : syntheticLine();
const previous = readLedger()
  .filter((l) => l.dataset === line.dataset && (line.kind !== 'external' || l.bench === line.bench))
  .pop();
console.log(JSON.stringify(line));
if (compare) printDelta(previous, line);
if (dryRun) console.error('dry run: nothing appended');
else {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, JSON.stringify(line) + '\n');
  console.error(`appended to ${ledgerPath}`);
}
if (line.kind === 'synthetic' && line.notes.some((n) => / failed/.test(n))) process.exit(1);
