#!/usr/bin/env node
// FloorPlanCAD one-shot count bench. Takes a folder of FloorPlanCAD-style
// SVGs (per-primitive semanticId / instanceId, see scripts/floorplancad-convert.py)
// plus the counts.json that converter writes, turns each SVG into a vector
// PDF (cairosvg svg2pdf in a child process, strokes kept as paths so the
// vector tier sees them), clicks the centroid of one ground-truth instance
// per class, runs the product scan path (scanDocAt: vector match, then the
// ONNX detector when a model is present, else CV) and scores the count.
//
// Per class: pages, exact-match rate, MAPE over pages with truth >= 1, signed
// bias, instance precision / recall (hit centre inside a GT box of the class,
// one to one), and which tier answered. This is the "counts what you point
// at" protocol of docs/research/benchmarks/floorplancad-archcad.md, not the
// panoptic PQ of the literature.
//
//   node --experimental-strip-types scripts/floorplancad-count-bench.mjs <svg-dir> \
//     [--counts <dir>/counts.json] [--limit N] [--policy first|median|largest] \
//     [--mono] [--model <dir>] [--pdf-dir <dir>] [--cairosvg <bin>] [--json out.json]
//
// Page size: 1 viewBox unit = 1 mm (a 140-unit tile prints at 140 mm, 1:100
// of a 14 m slice); the mapping back to viewBox units is read from the PDF's
// actual page size, so a different cairosvg unit convention cannot skew it.
// The bench reports; it does not fail on accuracy (exit 1 only on setup errors).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { scanDocAt } from '../src/headless/ops.ts';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);
const VALUE_OPTS = new Set(['--counts', '--limit', '--policy', '--model', '--pdf-dir', '--cairosvg', '--json']);
let dir;
for (let i = 0; i < args.length; i++) {
  if (VALUE_OPTS.has(args[i])) i++;
  else if (!args[i].startsWith('--')) dir ??= args[i];
}
if (!dir || !existsSync(dir)) {
  console.error('usage: floorplancad-count-bench.mjs <svg-dir> [--counts counts.json] [--limit N] [--policy first|median|largest] [--mono] [--model dir] [--pdf-dir dir] [--cairosvg bin] [--json out.json]');
  process.exit(1);
}
const countsPath = opt('counts', join(dir, 'counts.json'));
const limit = Number(opt('limit', 0));
const policy = opt('policy', 'first');
const mono = flag('mono');
const modelDir = opt('model', undefined);
const pdfDir = opt('pdf-dir', mkdtempSync(join(tmpdir(), 'fpc-bench-')));
const cairosvg = opt('cairosvg', process.env.CAIROSVG || 'cairosvg');
const jsonOut = opt('json', undefined);
const MM_TO_PT = 72 / 25.4;
const PX_PER_PT = 96 / 72; // cairosvg sizes PDF output in CSS px

if (!existsSync(countsPath)) {
  console.error(`no counts file at ${countsPath}; run scripts/floorplancad-convert.py --counts-only on the SVGs first`);
  process.exit(1);
}
mkdirSync(pdfDir, { recursive: true });
const counts = JSON.parse(readFileSync(countsPath, 'utf8'));
let stems = Object.keys(counts).sort().filter((s) => existsSync(join(dir, `${s}.svg`)));
if (limit > 0) stems = stems.slice(0, limit);
if (stems.length === 0) {
  console.error(`counts.json names no drawing that exists as an .svg in ${dir}`);
  process.exit(1);
}

/** All strokes and fills black: the usual state of a PDF export. */
function monoSvg(text) {
  return text.replace(/\b(stroke|fill)="(?!none")[^"]*"/g, '$1="rgb(0,0,0)"');
}

function svgToPdf(stem, vb) {
  const src = join(dir, `${stem}.svg`);
  const pdf = join(pdfDir, `${stem}${mono ? '-mono' : ''}.pdf`);
  let input = src;
  if (mono) {
    input = join(pdfDir, `${stem}-mono.svg`);
    writeFileSync(input, monoSvg(readFileSync(src, 'utf8')));
  }
  const wPx = vb[2] * MM_TO_PT * PX_PER_PT;
  const hPx = vb[3] * MM_TO_PT * PX_PER_PT;
  execFileSync(cairosvg, [input, '-f', 'pdf', '-o', pdf, '--output-width', String(wPx), '--output-height', String(hPx)], { stdio: ['ignore', 'ignore', 'pipe'] });
  return pdf;
}

function pickExemplar(instances) {
  if (policy === 'median') {
    const byArea = [...instances].sort((a, b) => area(a) - area(b));
    return byArea[Math.floor((byArea.length - 1) / 2)];
  }
  if (policy === 'largest') return instances.reduce((best, i) => (i.primitives > best.primitives ? i : best), instances[0]);
  return instances[0];
}
const area = (i) => (i.bbox[2] - i.bbox[0]) * (i.bbox[3] - i.bbox[1]);

const rows = [];
const t0 = Date.now();
for (const stem of stems) {
  const gt = counts[stem];
  const vb = gt.viewBox;
  let pdfPath;
  try {
    pdfPath = svgToPdf(stem, vb);
  } catch (err) {
    console.error(`${stem}: svg2pdf failed: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  const doc = await openPdf(new Uint8Array(readFileSync(pdfPath)));
  const page = await doc.getPage(1);
  const { width: pageW, height: pageH } = page.getViewport({ scale: 1 });
  const sx = pageW / vb[2];
  const sy = pageH / vb[3];
  const toPt = ([x, y]) => ({ x: (x - vb[0]) * sx, y: pageH - (y - vb[1]) * sy });
  const toUnits = (h) => [vb[0] + h.x / sx, vb[1] + (pageH - h.y) / sy];

  const byClass = new Map();
  for (const inst of gt.instances) {
    if (!byClass.has(inst.class)) byClass.set(inst.class, []);
    byClass.get(inst.class).push(inst);
  }
  for (const [cls, instances] of byClass) {
    const ex = pickExemplar(instances);
    const at = toPt(ex.centroid);
    const truth = instances.length;
    let predicted = 0;
    let provider = 'none';
    let error = null;
    let tp = 0;
    let fp = 0;
    try {
      const r = await scanDocAt(doc, 1, at, { modelDir });
      if ('error' in r) {
        error = r.error;
      } else {
        predicted = r.hits.length;
        provider = r.provider;
        // one-to-one: each hit claims the first unclaimed GT box of the class that contains it
        const claimed = new Set();
        for (const h of r.hits) {
          const [ux, uy] = toUnits(h);
          const idx = instances.findIndex((i, k) => !claimed.has(k) && ux >= i.bbox[0] && ux <= i.bbox[2] && uy >= i.bbox[1] && uy <= i.bbox[3]);
          if (idx >= 0) {
            claimed.add(idx);
            tp++;
          } else fp++;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    rows.push({ drawing: stem, class: cls, truth, predicted, provider, tp, fp, fn: truth - tp, error, exemplar: ex.instanceId, at: [Math.round(at.x * 10) / 10, Math.round(at.y * 10) / 10] });
  }
}

// --- aggregate --------------------------------------------------------------
const perClass = {};
for (const r of rows) {
  const c = (perClass[r.class] ??= { pages: 0, exact: 0, apeSum: 0, bias: 0, tp: 0, fp: 0, fn: 0, providers: {}, errors: 0 });
  c.pages++;
  if (r.predicted === r.truth) c.exact++;
  c.apeSum += Math.abs(r.predicted - r.truth) / r.truth;
  c.bias += r.predicted - r.truth;
  c.tp += r.tp;
  c.fp += r.fp;
  c.fn += r.fn;
  c.providers[r.provider] = (c.providers[r.provider] ?? 0) + 1;
  if (r.error) c.errors++;
}
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a');
const line = (name, c) =>
  `${name.padEnd(16)} ${String(c.pages).padStart(5)} ${pct(c.exact, c.pages).padStart(6)} ${pct(c.apeSum, c.pages).padStart(6)} ${(c.bias / c.pages).toFixed(2).padStart(6)} ${pct(c.tp, c.tp + c.fp).padStart(6)} ${pct(c.tp, c.tp + c.fn).padStart(6)}  ${Object.entries(c.providers).map(([k, v]) => `${k}:${v}`).join(' ')}${c.errors ? ` errors:${c.errors}` : ''}`;
console.log(`FloorPlanCAD count bench: ${stems.length} drawing(s), policy ${policy}${mono ? ', mono' : ''}${modelDir ? `, model ${modelDir}` : ''}, ${Date.now() - t0} ms`);
console.log(`${'class'.padEnd(16)} ${'pages'.padStart(5)} ${'exact'.padStart(6)} ${'MAPE'.padStart(6)} ${'bias'.padStart(6)} ${'prec'.padStart(6)} ${'recall'.padStart(6)}  tier`);
for (const [name, c] of Object.entries(perClass).sort()) console.log(line(name, c));
const all = { pages: 0, exact: 0, apeSum: 0, bias: 0, tp: 0, fp: 0, fn: 0, providers: {}, errors: 0 };
for (const c of Object.values(perClass)) {
  for (const k of ['pages', 'exact', 'apeSum', 'bias', 'tp', 'fp', 'fn', 'errors']) all[k] += c[k];
  for (const [k, v] of Object.entries(c.providers)) all.providers[k] = (all.providers[k] ?? 0) + v;
}
console.log(line('all classes', all));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ policy, mono, modelDir: modelDir ?? null, drawings: stems, perClass, rows }, null, 2) + '\n');
console.log(`PDFs in ${resolve(pdfDir)}${jsonOut ? `, results in ${jsonOut}` : ''}`);
