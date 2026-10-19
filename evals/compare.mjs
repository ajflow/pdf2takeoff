#!/usr/bin/env node
// B4 baseline ratchet: compare current eval metrics against the committed
// baseline (evals/baseline.json) and fail on regression — the mechanical
// version of "a ruler that silently stops matching the engine is worse than
// no ruler". Zero dependencies, deterministic output.
//
//   node evals/compare.mjs                  # compare; exit 1 on regression
//   node evals/compare.mjs --update-baseline
//
// Rules (reimplemented from the pattern OpenConstructionERP uses — theirs is
// AGPL, this is a fresh implementation):
//   • underscore-prefixed baseline keys are metadata, not metrics
//   • each metric has a direction ("higher" or "better"), default higher
//   • regression = worse than baseline by more than the absolute threshold
//     (default 0.05, overridable per metric via "_threshold")
//   • a metric present in the baseline but missing from the current report
//     is itself a regression (run the benches)
//   • new metrics are reported but never fail
// See evals/README.md and docs/research/bench-patch-plan.md (patch B4).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ART = join(here, 'artifacts');
const BASELINE = join(here, 'baseline.json');

// ---------- current metrics from the bench artifacts ----------
function currentMetrics() {
  const metrics = {};
  const scorePath = join(ART, 'score-rooms.json');
  if (existsSync(scorePath)) {
    const score = JSON.parse(readFileSync(scorePath, 'utf8'));
    if (score.verdict === 'pass' || score.verdict === 'fail') {
      const rooms = score.rooms.filter((r) => r.metrics);
      if (rooms.length) {
        metrics['fill.area_pct_max'] = Math.max(...rooms.map((r) => r.metrics.area_pct));
        metrics['fill.iou_min'] = Math.min(...rooms.map((r) => r.metrics.iou));
        metrics['fill.boundary_pt_max'] = Math.max(...rooms.map((r) => r.metrics.boundary_pt));
      }
    }
  }
  const detPath = join(ART, 'bench-detector.json');
  if (existsSync(detPath)) {
    const det = JSON.parse(readFileSync(detPath, 'utf8'));
    for (const phase of ['clean', 'degraded']) {
      const o = det.tiers?.tier1_cv?.[phase]?.overall;
      if (o) {
        metrics[`det.${phase}.precision`] = o.precision;
        metrics[`det.${phase}.recall`] = o.recall;
        metrics[`det.${phase}.f1`] = o.f1;
      }
    }
  }
  const perfPath = join(ART, 'perf-results.json');
  if (existsSync(perfPath)) {
    const perf = JSON.parse(readFileSync(perfPath, 'utf8'));
    for (const [k, v] of Object.entries(perf.counts ?? {})) metrics[`perf.${k}`] = v;
  }
  const mcpPath = join(ART, 'mcp-workflow.json');
  if (existsSync(mcpPath)) {
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    for (const [k, v] of Object.entries(mcp.counts ?? {})) metrics[`mcp.${k}`] = v;
  }
  return metrics;
}

// ---------- compare ----------
const baselineExists = existsSync(BASELINE);
if (!baselineExists && !process.argv.includes('--update-baseline')) {
  console.error('FAIL: evals/baseline.json not found — bootstrap it with: node evals/compare.mjs --update-baseline');
  process.exit(1);
}
const baseline = baselineExists ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { _comment: 'eval baseline ratchet — see evals/README.md (bench patch B4)', _direction: {}, _threshold: {} };
const direction = baseline._direction ?? {};
const threshold = baseline._threshold ?? {};
const current = currentMetrics();

const rows = [];
let regressions = 0;
for (const key of Object.keys(baseline)) {
  if (key.startsWith('_')) continue;
  const dir = direction[key] ?? 'higher';
  const thr = threshold[key] ?? 0.05;
  if (!(key in current)) {
    rows.push({ key, dir, baseline: baseline[key], current: 'MISSING', verdict: 'REGRESSION' });
    regressions++;
    continue;
  }
  const worse = dir === 'higher' ? current[key] < baseline[key] - thr : current[key] > baseline[key] + thr;
  if (worse) regressions++;
  rows.push({ key, dir, baseline: baseline[key], current: current[key], verdict: worse ? 'REGRESSION' : 'ok' });
}
for (const key of Object.keys(current)) {
  if (key in baseline || rows.some((r) => r.key === key)) continue;
  rows.push({ key, dir: direction[key] ?? 'higher', baseline: '—', current: current[key], verdict: 'new (not gated)' });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('metric', 26)}${pad('dir', 8)}${pad('baseline', 12)}${pad('current', 12)}verdict`);
for (const r of rows) {
  console.log(`${pad(r.key, 26)}${pad(r.dir, 8)}${pad(r.baseline, 12)}${pad(r.current, 12)}${r.verdict}`);
}

if (process.argv.includes('--update-baseline')) {
  const updated = { _comment: baseline._comment, _updated: new Date().toISOString().slice(0, 10), _direction: direction, _threshold: threshold, ...current };
  writeFileSync(BASELINE, JSON.stringify(updated, null, 2) + '\n');
  console.log(`baseline updated: ${BASELINE}`);
  process.exit(0);
}

if (regressions) {
  console.error(`FAIL: ${regressions} metric regression${regressions > 1 ? 's' : ''} vs committed baseline (evals/baseline.json)`);
  process.exit(1);
}
console.log('ok: no regressions vs committed baseline');
