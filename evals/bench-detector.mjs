#!/usr/bin/env node
// B3 detector-accuracy bench: run the real tier-1 CV scan (src/engine/scan-cv.ts,
// the same code the browser Scan tool runs) over seeded synthetic sheets whose
// labels are exact by construction, and report micro precision / recall / F1
// per class plus miss attribution — every miss tagged with the pipeline stage
// that dropped it (teach-failed / filtered:size|aspect|fill|signature /
// merged / dropped / no-ink). Deterministic end to end (seeded generator,
// pure typed-array engine, deterministic assignment), so numbers are
// reproducible in CI.
//
// Two phases from the same seed, differing only in the degrade setting:
//   clean     --degrade 0  (vector-fresh sheets)
//   degraded  --degrade 1  (every sheet gets one artifact: blur/speckle/
//                          rotate/photocopy/contrast — the tier-2 detector's job)
// Same seed ⇒ same distribution, but not sheet-paired: degradation consumes
// the generator's rng stream, so sheets diverge after the first degraded
// sheet. Compare the phases as distributions, not per-sheet.
// Teach policy mirrors the UX: click instances in order until the scan
// accepts one (the app tells users "try a smaller, isolated symbol");
// teach attempts are counted. Tier-2 (ONNX) joins automatically once
// public/models/symbols.onnx exists; until then it is reported as absent.
// Matching design follows Takeoff-Lens (MIT): centre distance with a
// per-instance radius, Hungarian-style augmenting paths, deterministic order.
// See evals/README.md and docs/research/bench-patch-plan.md (patch B3).

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { load as yamlLoad } from 'js-yaml';

import { cvScan } from '../src/engine/scan-cv.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SYN = join(ROOT, 'training', 'synthetic');
// phase copies + stamps live outside SYN: the generator tree is wiped and
// rebuilt per phase, which would eat them (they are derived artifacts →
// evals/artifacts/, gitignored)
const BENCH = join(here, 'artifacts', 'bench-detector-data');
const OUT = join(here, 'artifacts', 'bench-detector.json');

const COUNT = 60;
const SEED = 42;
const PHASES = [
  { name: 'clean', degrade: 0 },
  { name: 'degraded', degrade: 1 },
];

// ---------- deterministic one-to-one assignment (Kuhn's algorithm) ----------
// Edges: hit centre within the GT instance's radius; per-GT candidate order
// is (distance, hit index), per-run GT order is label order — fully
// deterministic, no greedy order sensitivity.
function assign(hits, gts) {
  const cands = gts.map((g) => hits
    .map((h, hi) => ({ hi, d: Math.hypot(h.x - g.x, h.y - g.y) }))
    .filter((c) => c.d <= g.r)
    .sort((a, b) => a.d - b.d || a.hi - b.hi)
    .map((c) => c.hi));
  const owner = new Array(hits.length).fill(-1); // hit → gt index
  const augment = (gi, seen) => {
    for (const hi of cands[gi]) {
      if (seen[hi]) continue;
      seen[hi] = true;
      if (owner[hi] === -1 || augment(owner[hi], seen)) {
        owner[hi] = gi;
        return true;
      }
    }
    return false;
  };
  gts.forEach((_, gi) => augment(gi, new Array(hits.length).fill(false)));
  const pairs = [];
  owner.forEach((gi, hi) => { if (gi !== -1) pairs.push({ gt: gi, hit: hi }); });
  return pairs;
}

// ---------- miss attribution via the engine's opt-in trace ----------
function attributeMiss(gt, trace) {
  const near = (c) => Math.hypot(c.cx - gt.x, c.cy - gt.y) <= gt.r;
  if (trace.components.some((c) => c.status === 'hit' && near(c))) {
    return 'merged-with-neighbour'; // matched component inside this GT's radius, taken by another instance
  }
  const comp = trace.components.filter(near)
    .sort((a, b) => Math.hypot(a.cx - gt.x, a.cy - gt.y) - Math.hypot(b.cx - gt.x, b.cy - gt.y))[0];
  if (comp) return `filtered:${comp.status}`;
  const contains = (c) => gt.x >= c.x0 && gt.x <= c.x1 && gt.y >= c.y0 && gt.y <= c.y1;
  const big = trace.components.filter(contains).sort((a, b) => b.count - a.count)[0];
  if (big) return 'merged'; // bbox swallows the symbol but the centre is far → wall/large-structure merge
  const dropped = trace.dropped.filter(contains).sort((a, b) => b.count - a.count)[0];
  if (dropped) return `dropped:${dropped.reason}`;
  return 'no-ink-linked';
}

// ---------- dataset: paired phases, val split set aside per phase ----------
function generatePhase(phase) {
  const dir = join(BENCH, phase.name);
  const stamp = `count=${COUNT} seed=${SEED} degrade=${phase.degrade} v2`; // v2: teach-gate fix — invalidate older copies
  const stampPath = join(dir, '.bench-stamp');
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === stamp) return;
  console.log(`generating ${COUNT} sheets for phase "${phase.name}" (seed ${SEED}, degrade ${phase.degrade})…`);
  rmSync(SYN, { recursive: true, force: true }); // generator appends; only fresh trees are reproducible
  const gen = spawnSync(process.execPath, [
    join(ROOT, 'scripts', 'generate-synthetic-dataset.mjs'),
    '--count', String(COUNT), '--seed', String(SEED), '--degrade', String(phase.degrade),
  ], { stdio: 'inherit' });
  if (gen.status !== 0) { console.error('FAIL: generator failed'); process.exit(1); }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const part of ['images', 'labels']) {
    mkdirSync(join(dir, part), { recursive: true });
    cpSync(join(SYN, part, 'val'), join(dir, part, 'val'), { recursive: true });
  }
  cpSync(join(SYN, 'dataset.yaml'), join(dir, 'dataset.yaml'));
  writeFileSync(stampPath, stamp + '\n');
}

for (const phase of PHASES) generatePhase(phase);

// ---------- run one phase ----------
async function runPhase(phase) {
  const dir = join(BENCH, phase.name);
  const names = yamlLoad(readFileSync(join(dir, 'dataset.yaml'), 'utf8')).names;
  const CLASSES = Object.keys(names).sort((a, b) => a - b).map((k) => names[k]);
  const sheets = readdirSync(join(dir, 'images', 'val')).filter((f) => f.endsWith('.png')).sort();

  const perClass = Object.fromEntries(CLASSES.map((c) => [c, { nGT: 0, TP: 0, FP: 0, FN: 0 }]));
  const attribution = {};
  const teachFailures = [];
  let scans = 0;
  let teachAttempts = 0;

  for (const sheetName of sheets) {
    const img = await loadImage(join(dir, 'images', 'val', sheetName));
    const cnv = createCanvas(img.width, img.height);
    const ctx = cnv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, img.width, img.height);
    const raster = {
      width: img.width, height: img.height, data: id.data,
      toPdf: (x, y) => ({ x, y }),   // bench frame = generator image px (y-down),
      toRaster: (x, y) => ({ x, y }), // identical to the label coordinate frame
    };
    const labels = readFileSync(join(dir, 'labels', 'val', sheetName.replace('.png', '.txt')), 'utf8')
      .trim().split('\n').filter(Boolean)
      .map((line) => {
        const [cls, cx, cy, w, h] = line.split(' ').map(Number);
        return { cls, x: cx * img.width, y: cy * img.height, w: w * img.width, h: h * img.height };
      })
      .map((l) => ({ ...l, r: Math.max(l.w, l.h) / 2 + 3 }));

    for (let cls = 0; cls < CLASSES.length; cls++) {
      const inst = labels.filter((l) => l.cls === cls);
      if (!inst.length) continue;
      perClass[CLASSES[cls]].nGT += inst.length;

      // teach-retry: click instances in order until the scan accepts one —
      // the app prompts "try a smaller, isolated symbol", users oblige.
      // Acceptance requires a plausible template: a click on a wall-parked
      // symbol resolves to the whole wall network (no error, huge templatePx),
      // which would size-filter every real symbol — a competent user clicks
      // an isolated instance instead, so the bench does too.
      let result = null;
      let trace = null;
      let lastError = 'no instances';
      for (const candidate of inst) {
        teachAttempts++;
        trace = { dropped: [], components: [] };
        const r = cvScan(raster, { x: candidate.x, y: candidate.y }, trace);
        if ('error' in r) { lastError = r.error; continue; }
        const boxArea = candidate.w * candidate.h;
        // stroke symbols carry a small fraction of their box as ink (thin
        // rings/outlines: 12–800 px for 700–2300 px² boxes); a wall-merged
        // template runs ~10× the box — so plausibility is an upper bound
        const templatePlausible = r.templatePx >= 12 && r.templatePx <= boxArea;
        const taughtFound = r.hits.some((h) => Math.hypot(h.x - candidate.x, h.y - candidate.y) <= candidate.r);
        if (!templatePlausible || !taughtFound) { lastError = `implausible template (${r.templatePx}px vs box ${boxArea | 0}px²)`; continue; }
        result = r;
        break;
      }
      scans++;
      if (!result) {
        teachFailures.push({ sheet: sheetName, class: CLASSES[cls], error: lastError });
        perClass[CLASSES[cls]].FN += inst.length;
        attribution['teach-failed'] = (attribution['teach-failed'] ?? 0) + inst.length;
        continue;
      }

      const pairs = assign(result.hits, inst);
      const matchedGT = new Set(pairs.map((p) => p.gt));
      perClass[CLASSES[cls]].TP += pairs.length;
      perClass[CLASSES[cls]].FP += result.hits.length - pairs.length;
      perClass[CLASSES[cls]].FN += inst.length - pairs.length;
      inst.forEach((gt, gi) => {
        if (!matchedGT.has(gi)) {
          const reason = attributeMiss(gt, trace);
          attribution[reason] = (attribution[reason] ?? 0) + 1;
        }
      });
    }
  }

  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const prf = ({ TP, FP, FN }) => ({
    precision: r4(TP + FP ? TP / (TP + FP) : 1),
    recall: r4(TP + FN ? TP / (TP + FN) : 1),
    f1: r4(TP ? (2 * TP) / (2 * TP + FP + FN) : 0),
  });
  const totals = { nGT: 0, TP: 0, FP: 0, FN: 0 };
  for (const c of CLASSES) for (const k of Object.keys(totals)) totals[k] += perClass[c][k];
  return {
    sheets: sheets.length,
    scans,
    teach_attempts: teachAttempts,
    teach_failures: teachFailures.length,
    classes: Object.fromEntries(CLASSES.map((c) => [c, { ...perClass[c], ...prf(perClass[c]) }])),
    overall: { ...totals, ...prf(totals) },
    miss_attribution: Object.fromEntries(Object.entries(attribution).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}

const phases = {};
for (const phase of PHASES) {
  phases[phase.name] = await runPhase(phase);
  const o = phases[phase.name].overall;
  console.log(`\n=== phase: ${phase.name} (${phases[phase.name].sheets} val sheets, ${phases[phase.name].scans} scans, ${phases[phase.name].teach_attempts} teach attempts) ===`);
  console.log(`${'class'.padEnd(12)}${'GT'.padStart(5)}${'TP'.padStart(5)}${'FP'.padStart(5)}${'FN'.padStart(5)}${'P'.padStart(8)}${'R'.padStart(8)}${'F1'.padStart(8)}`);
  for (const [c, s] of Object.entries(phases[phase.name].classes)) {
    console.log(c.padEnd(12) + String(s.nGT).padStart(5) + String(s.TP).padStart(5) + String(s.FP).padStart(5) + String(s.FN).padStart(5) + s.precision.toFixed(4).padStart(8) + s.recall.toFixed(4).padStart(8) + s.f1.toFixed(4).padStart(8));
  }
  console.log(`${'overall'.padEnd(12)}${String(o.nGT).padStart(5)}${String(o.TP).padStart(5)}${String(o.FP).padStart(5)}${String(o.FN).padStart(5)}${o.precision.toFixed(4).padStart(8)}${o.recall.toFixed(4).padStart(8)}${o.f1.toFixed(4).padStart(8)}`);
  console.log(`miss attribution: ${Object.entries(phases[phase.name].miss_attribution).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const hasModel = existsSync(join(ROOT, 'public', 'models', 'symbols.onnx'));
const report = {
  schema: 'evals/bench-detector/1',
  eval: 'detector-accuracy',
  engine: { name: 'pdf2takeoff', version, provider: 'cv', file: 'src/engine/scan-cv.ts' },
  dataset: {
    generator: 'scripts/generate-synthetic-dataset.mjs', count: COUNT, seed: SEED,
    split: 'val', classes: Object.keys(phases.clean.classes),
    phases: PHASES.map((p) => ({ name: p.name, degrade: p.degrade, seed: SEED, note: 'same seed, distribution-comparable (not sheet-paired)' })),
  },
  tiers: {
    tier1_cv: phases,
    tier2_onnx: hasModel ? 'present-but-not-benched-yet' : 'absent (no public/models/symbols.onnx)',
  },
};
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(`\ntier-2: ${report.tiers.tier2_onnx}`);
console.log(`ok: ${OUT}`);
