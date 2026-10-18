#!/usr/bin/env node
// Behavioural check for ScaledDrawingBench (scripts/scaled-drawing-bench.mjs):
// the generator is deterministic (the 5-sheet sample regenerates to the same
// questions.jsonl as the committed one), and the pdf2takeoff reference solver
// scores 100 percent within 2 percent on scale, length, area and count over
// the sample's vector sheets without hallucinating on unanswerable questions.
// The raster half is not asserted here (it is the benchmark's open ground).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSet, loadSet } from './bench/generate.mjs';
import { runReference } from './bench/reference.mjs';
import { scorePredictions } from './bench/score.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sampleDir = join(root, 'bench', 'scaled-drawing-bench', 'sample');
const committed = JSON.parse(readFileSync(join(sampleDir, 'manifest.json'), 'utf8'));

let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'sdb-check-'));
try {
  await generateSet({ out: tmp, seed: committed.seed, count: committed.count, noVerify: true });
  const fresh = readFileSync(join(tmp, 'questions.jsonl'), 'utf8');
  const kept = readFileSync(join(sampleDir, 'questions.jsonl'), 'utf8');
  check(`generator is deterministic: sample (seed ${committed.seed}, ${committed.count} sheets) regenerates to the committed questions.jsonl`, fresh === kept);

  const { manifest, questions } = loadSet(tmp);
  const vectorIds = new Set(manifest.sheets.filter((s) => s.kind === 'vector').map((s) => s.id));
  const { preds } = await runReference({ setDir: tmp, manifest, questions, half: 'vector', script: join(root, 'scripts', 'scaled-drawing-bench.mjs') });
  const scoped = questions.filter((q) => vectorIds.has(q.sheet));
  const result = scorePredictions(scoped, new Map(preds.map((p) => [p.id, p])), manifest, { system: 'check' });
  for (const type of ['scale', 'length', 'area', 'count']) {
    const agg = result.byType[type];
    check(`reference on the vector sample: ${type} ${agg ? `${agg.accuracy}% (${agg.answerable} answerable)` : 'absent'} is 100%`, agg && agg.answerable > 0 && agg.accuracy === 100, JSON.stringify(agg));
  }
  check(`reference on the vector sample: no hallucinated answers on ${result.overall.unanswerable} unanswerable questions`, result.overall.hallucinations === 0);
  const misses = result.rows.filter((r) => !r.unanswerable && !r.correct && ['scale', 'length', 'area', 'count'].includes(r.type));
  for (const m of misses) console.error(`  miss: ${m.id} ${m.type} ${JSON.stringify(preds.find((p) => p.id === m.id))}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log('PASS: ScaledDrawingBench sample is deterministic and the vector reference is exact');
