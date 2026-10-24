#!/usr/bin/env node
// Score the prediction CSVs in bench/aecv-bench/predictions/ against the
// AECV-Bench ground truth, the way the benchmark does: exact match per field,
// a missing plan counts as wrong for every field, five-field mean over all
// 120 plans. The ground truth is read from a local clone of
// https://github.com/AECFoundry/AECV-Bench (any per-model CSV in
// benchmark_result_object_counting/ carries it in its `original` column); it
// is never copied into this repo.
//
//   node bench/aecv-bench/score.mjs --aecv /path/to/AECV-Bench [file.csv ...]

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELDS = ['Door', 'Window', 'Space', 'Bedroom', 'Toilet'];
const args = process.argv.slice(2);
const at = args.indexOf('--aecv');
if (at < 0 || !args[at + 1]) {
  console.error('usage: node bench/aecv-bench/score.mjs --aecv /path/to/AECV-Bench [file.csv ...]');
  process.exit(2);
}
const aecv = args[at + 1];
const here = dirname(fileURLToPath(import.meta.url));
const files = args.filter((_, i) => i !== at && i !== at + 1);
const inputs = files.length ? files : readdirSync(join(here, 'predictions')).filter((f) => f.endsWith('.csv')).sort().map((f) => join(here, 'predictions', f));

// RFC 4180 enough for these files: quoted fields with doubled quotes
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const gtFile = join(aecv, 'benchmark_result_object_counting', 'gemini_35_flash.csv');
const truth = new Map(parseCsv(readFileSync(gtFile, 'utf8')).map((r) => [r.name, JSON.parse(r.original)]));

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('predictions', 40)}${pad('plans', 9)}${pad('5-field', 9)}${FIELDS.map((f) => pad(f, 8)).join('')}`);
for (const file of inputs) {
  const pred = new Map(parseCsv(readFileSync(file, 'utf8')).map((r) => [r.name, r]));
  const hits = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const [name, gt] of truth) {
    const p = pred.get(name);
    if (!p) continue;
    for (const f of FIELDS) if (Number(p[f]) === gt[f]) hits[f]++;
  }
  const n = truth.size;
  const mean = FIELDS.reduce((s, f) => s + hits[f], 0) / (FIELDS.length * n);
  console.log(`${pad(basename(file, '.csv'), 40)}${pad(`${pred.size}/${n}`, 9)}${pad(mean.toFixed(3), 9)}${FIELDS.map((f) => pad((hits[f] / n).toFixed(2), 8)).join('')}`);
}
