#!/usr/bin/env node
// ScaledDrawingBench: a public, deterministic benchmark for measuring
// quantities (scale, lengths, areas, perimeters, counts, printed dimensions,
// revision changes) from scaled construction drawings. See
// bench/scaled-drawing-bench/README.md.
//
//   node --experimental-strip-types scripts/scaled-drawing-bench.mjs generate [--count 200] [--seed 20261018] [--out bench/scaled-drawing-bench/v0.1] [--no-verify]
//   node --experimental-strip-types scripts/scaled-drawing-bench.mjs score --set <dir> --predictions preds.jsonl [--out results/<system>]
//   node --experimental-strip-types scripts/scaled-drawing-bench.mjs reference --set <dir> [--half vector|raster|all] [--ocr on|off] [--out results/pdf2takeoff-reference]
//
// The reference solver answers every question with the pdf2takeoff engine
// and no model: text-layer (or OCR) scale notes, Dynamic Fill for areas,
// vector geometry or ink runs for lengths, the scan tiers for counts and the
// revision-diff path for compare questions. Raster sheets run in a child
// process per sheet so an engine crash costs one sheet, not the run.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const args = process.argv.slice(2);
const cmd = args[0];
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const DEFAULT_SET = join(ROOT, 'bench', 'scaled-drawing-bench', 'v0.1');

if (cmd === 'generate') {
  const { generateSet } = await import('./bench/generate.mjs');
  const out = resolve(arg('out', DEFAULT_SET));
  const count = Number(arg('count', 200));
  const seed = Number(arg('seed', 20261018));
  const { manifest, questions, report } = await generateSet({
    out, count, seed, noVerify: flag('no-verify'), log: flag('quiet') ? undefined : (m) => console.log(m),
  });
  console.log(`\nwrote ${manifest.sheets.length} sheets and ${questions.length} questions to ${out}\n`);
  console.log(report);
} else if (cmd === 'score') {
  const { scorePredictions, loadPredictions, renderMarkdown } = await import('./bench/score.mjs');
  const { loadSet } = await import('./bench/generate.mjs');
  const setDir = resolve(arg('set', DEFAULT_SET));
  const predsPath = arg('predictions');
  if (!predsPath) {
    console.error('score needs --predictions <preds.jsonl>');
    process.exit(2);
  }
  const { manifest, questions } = loadSet(setDir);
  const preds = loadPredictions(resolve(predsPath));
  const result = scorePredictions(questions, preds, manifest, { system: arg('system', 'submission') });
  const md = renderMarkdown(result);
  const out = arg('out');
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(`${resolve(out)}.md`, md);
    writeFileSync(`${resolve(out)}.json`, JSON.stringify(result, null, 2) + '\n');
    console.log(`wrote ${out}.md and ${out}.json`);
  }
  console.log(md);
} else if (cmd === 'reference') {
  const { runReference } = await import('./bench/reference.mjs');
  const { scorePredictions, renderMarkdown } = await import('./bench/score.mjs');
  const { loadSet } = await import('./bench/generate.mjs');
  const setDir = resolve(arg('set', DEFAULT_SET));
  const { manifest, questions } = loadSet(setDir);
  const half = arg('half', 'all');
  const out = resolve(arg('out', join(setDir, 'results', 'pdf2takeoff-reference')));
  mkdirSync(dirname(out), { recursive: true });
  const t0 = performance.now();
  const { preds, notes } = await runReference({
    setDir, manifest, questions, half, ocr: arg('ocr', 'on') !== 'off', tessdata: arg('tessdata'),
    log: flag('quiet') ? () => {} : (m) => console.log(m), script: fileURLToPath(import.meta.url),
  });
  writeFileSync(`${out}.jsonl`, preds.map((p) => JSON.stringify(p)).join('\n') + '\n');
  const scoped = half === 'all' ? questions : questions.filter((q) => manifest.sheets.find((s) => s.id === q.sheet)?.kind === half);
  const result = scorePredictions(scoped, new Map(preds.map((p) => [p.id, p])), manifest, { system: 'pdf2takeoff reference (deterministic, no model)', notes, seconds: (performance.now() - t0) / 1000 });
  const md = renderMarkdown(result);
  writeFileSync(`${out}.md`, md);
  writeFileSync(`${out}.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(md);
  console.log(`wrote ${out}.jsonl, ${out}.md, ${out}.json`);
} else if (cmd === 'solve-sheet') {
  // internal: one sheet in a child process (raster sheets); prints a JSON line
  const { solveSheetById } = await import('./bench/reference.mjs');
  const { loadSet } = await import('./bench/generate.mjs');
  const setDir = resolve(arg('set', DEFAULT_SET));
  const { manifest, questions } = loadSet(setDir);
  const res = await solveSheetById({ setDir, manifest, questions, sheetId: arg('sheet'), rasterMode: arg('raster-mode', 'engine'), ocr: arg('ocr', 'on') !== 'off', tessdata: arg('tessdata') });
  process.stdout.write('\n@@RESULT ' + JSON.stringify(res) + '\n');
  process.exit(0);
} else {
  console.error('usage: scaled-drawing-bench.mjs generate|score|reference [options]  (see the header comment)');
  process.exit(2);
}

export { readFileSync, existsSync, spawnSync };
