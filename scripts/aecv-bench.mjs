#!/usr/bin/env node
// AECV-Bench object-counting harness (docs/research/benchmarks/aecv-bench.md).
// Runs the raster opening detector (src/engine/openings.ts) over the
// benchmark's 120 floor plans, writes a result CSV in the benchmark's own
// layout (name, original, extracted) and prints per-field exact match and
// MAPE computed the way the benchmark's src/benchmark/visualizer.py does.
//
//   node --experimental-strip-types scripts/aecv-bench.mjs --data <AECV-Bench clone>
//        [--limit N] [--ids a,b,c] [--labels words.json] [--debug-dir dir]
//        [--out results.csv] [--json summary.json] [--opt key=value ...]
//        [--verbose] [--probe x,y]
//
// --verbose prints the wall estimate (pen weight, stroke histograms, every
// closing radius tried) per plan; --probe prints what the classifier
// measured on the gaps around a page pixel; --debug-dir writes one PNG per
// plan with the wall mask tinted, doors red (hinge circle), Window groups
// blue, passages grey and counted spaces numbered.
//
// The data never lives in this repo (the plans derive from CC BY-NC
// material); pass the path to a local clone. Images load through
// @napi-rs/canvas at 1 px = 1 pt. Bedroom and Toilet are label fields: the
// detector has no OCR, so they come from `labelsFor(planId)`, which reads
// the optional --labels JSON ({ "<planId>": ["CHAMBRE 1", "WC", ...] }) and
// returns [] otherwise. A headless OCR pass can be plugged in there.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { countEnclosedSpaces, detectOpenings, DEFAULT_OPENING_OPTIONS } from '../src/engine/openings.ts';

// --- args --------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const dataRoot = opt('--data');
if (!dataRoot) {
  console.error('usage: aecv-bench.mjs --data <path to AECV-Bench clone> [--limit N] [--ids a,b] [--labels f.json] [--debug-dir d] [--out f.csv]');
  process.exit(2);
}
const limit = Number(opt('--limit', '0')) || 0;
const onlyIds = opt('--ids') ? opt('--ids').split(',').map((s) => s.trim()).filter(Boolean) : null;
const debugDir = opt('--debug-dir');
const outCsv = opt('--out', join(tmpdir(), 'aecv-pdf2takeoff.csv'));
const outJson = opt('--json');
const labelsPath = opt('--labels');
const verbose = args.includes('--verbose');
// --probe x,y: print the classifier's measurements for the gaps around a page point
const probe = opt('--probe') ? (([x, y]) => ({ x: Number(x), y: Number(y) }))(opt('--probe').split(',')) : null;
// detector tunables from the command line: --opt arcScore=0.5 --opt closeRadius=2
const overrides = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--opt' || !args[i + 1]) continue;
  const [k, v] = args[i + 1].split('=');
  const optional = ['wallThicknessPx', 'closeRadius']; // overrides that have no default
  if (!(k in DEFAULT_OPENING_OPTIONS) && !optional.includes(k)) { console.error(`unknown option ${k}`); process.exit(2); }
  overrides[k] = v.includes(',') ? v.split(',').map(Number) : Number(v);
}

// --- data layout ---------------------------------------------------------------
// <root>/data/Use Case 1 - Object Counting/1 - Full Datasets/<id>/{<id>.png|jpg, metadata.json}
function findPlanRoot(root) {
  const direct = join(root, 'data', 'Use Case 1 - Object Counting', '1 - Full Datasets');
  if (existsSync(direct)) return direct;
  if (existsSync(join(root, '1 - Full Datasets'))) return join(root, '1 - Full Datasets');
  return root;
}
const planRoot = findPlanRoot(resolve(dataRoot));
const FIELDS = ['Door', 'Window', 'Space', 'Bedroom', 'Toilet'];
const plans = [];
for (const id of readdirSync(planRoot).sort()) {
  const dir = join(planRoot, id);
  const meta = join(dir, 'metadata.json');
  if (!existsSync(meta)) continue;
  const img = readdirSync(dir).find((f) => /\.(png|jpe?g)$/i.test(f));
  if (!img) continue;
  // metadata is UTF-8 with a BOM
  const gt = JSON.parse(readFileSync(meta, 'utf8').replace(/^﻿/, ''));
  plans.push({ id, image: join(dir, img), gt });
}
let selected = onlyIds ? plans.filter((p) => onlyIds.includes(p.id)) : plans;
if (limit > 0) selected = selected.slice(0, limit);
if (!selected.length) { console.error(`no plans found under ${planRoot}`); process.exit(1); }

// --- labels hook (Bedroom, Toilet) -----------------------------------------------
const labelsJson = labelsPath ? JSON.parse(readFileSync(labelsPath, 'utf8')) : null;
/** Room-label words for a plan. Today: the --labels file or nothing. OCR plugs in here. */
function labelsFor(planId) {
  if (!labelsJson) return [];
  const v = labelsJson[planId];
  return Array.isArray(v) ? v.map(String) : [];
}
// the benchmark's own counting rules: Bedroom, Chambre, Zimmer, Camera or
// equivalent; WC, Bath, Bain, Douche, Shower, SDB, Toilet each count, Lavatory does not
const BEDROOM = /^(bed(room)?|br|chambre|ch|zimmer|schlafzimmer|sz|camera|dormitorio|quarto|mh|makuuhuone|sovrum|soverom|slaapkamer)\b/i;
const TOILET = /^(w\.?c\.?|toil(et|ette|ettes)?|bath(room)?|bad|bain|bains|sdb|s\.d\.b|douche|shower|kph|kylpyhuone|pesuhuone|ph|suihku|wc\/d|badezimmer|dusche|bagno|baño)\b/i;
function countLabels(words) {
  let bedroom = 0;
  let toilet = 0;
  for (const raw of words) {
    const word = raw.trim();
    if (!word || /^lavatory/i.test(word)) continue;
    if (BEDROOM.test(word)) bedroom++;
    else if (TOILET.test(word)) toilet++;
  }
  return { bedroom, toilet };
}

// --- raster loading -----------------------------------------------------------------
async function loadRaster(path) {
  const img = await loadImage(readFileSync(path));
  const w = img.width;
  const h = img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  return {
    raster: { width: w, height: h, data, toPdf: (x, y) => ({ x, y: h - y }), toRaster: (x, y) => ({ x, y: h - y }) },
    canvas,
  };
}

// --- debug overlay --------------------------------------------------------------------
function writeOverlay(canvas, res, spaces, path) {
  const ctx = canvas.getContext('2d');
  const { width: mw, mask, scale: s } = res.walls;
  const w = canvas.width;
  const h = canvas.height;
  // wall mask tint (the mask is at the detector's working scale)
  const img = ctx.getImageData(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * s * mw + x * s]) continue;
      const p = (y * w + x) * 4;
      img.data[p] = (img.data[p] + 255) >> 1;
      img.data[p + 1] = (img.data[p + 1] + 200) >> 1;
      img.data[p + 2] = img.data[p + 2] >> 1;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = res.walls.thicknessPx;
  const lw = Math.max(1, t / 4);
  ctx.lineWidth = lw;
  for (const s of spaces.spaces) {
    ctx.fillStyle = 'rgba(0,160,0,0.12)';
    ctx.fillRect(s.x0, s.y0, s.x1 - s.x0 + 1, s.y1 - s.y0 + 1);
  }
  const box = (o, color) => {
    ctx.strokeStyle = color;
    ctx.strokeRect(o.px.x0 - lw, o.px.y0 - lw, o.px.x1 - o.px.x0 + 1 + 2 * lw, o.px.y1 - o.px.y0 + 1 + 2 * lw);
  };
  for (const p of res.passages) box(p, 'rgba(120,120,120,0.9)');
  for (const win of res.windows) box(win, 'rgba(0,80,255,0.95)');
  for (const d of res.doors) {
    box(d, 'rgba(230,0,0,0.95)');
    if (d.hinge) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(230,0,0,0.9)';
      ctx.arc(d.hinge.x, d.hinge.y, d.hinge.radiusPx, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.fillStyle = 'rgba(0,120,0,0.9)';
  ctx.font = `${Math.max(10, Math.round(2.5 * t))}px sans-serif`;
  spaces.spaces.forEach((s, i) => ctx.fillText(String(i + 1), (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2));
  writeFileSync(path, canvas.toBuffer('image/png'));
}

// --- run ----------------------------------------------------------------------------------
if (debugDir) mkdirSync(debugDir, { recursive: true });
const rows = [];
const perPlan = [];
const t0 = Date.now();
for (const plan of selected) {
  const start = Date.now();
  let pred = { Door: 0, Window: 0, Space: 0, Bedroom: 0, Toilet: 0 };
  let note = '';
  try {
    const { raster, canvas } = await loadRaster(plan.image);
    const res = detectOpenings(raster, overrides);
    const spaces = countEnclosedSpaces(raster, overrides, res);
    const labels = countLabels(labelsFor(plan.id));
    pred = { Door: res.doors.length, Window: res.windows.length, Space: spaces.count, Bedroom: labels.bedroom, Toilet: labels.toilet };
    note = `t=${res.walls.thicknessPx.toFixed(1)} s=${res.walls.scale} r=${res.walls.closeRadiusPx} k=${res.walls.kernelPx} score=${res.walls.score.toFixed(2)} pass=${res.passages.length} ${raster.width}x${raster.height}`;
    if (verbose) {
      const fmtHist = (h) => {
        const hist = Array.from(h);
        const total = hist.reduce((a, b) => a + b, 0) || 1;
        return hist.map((v, i) => [i, v / total]).filter(([, v]) => v >= 0.01).map(([i, v]) => `${i}:${(v * 100).toFixed(0)}%`).join(' ');
      };
      note += `\n    pen=${res.walls.penPx} minWall=${res.walls.minWallPx}  count histogram: ${fmtHist(res.walls.countHistogram)}`;
      for (const c of res.walls.tried) note += `\n    r=${c.r} t=${c.t.toFixed(1)} k=${c.k} score=${c.score.toFixed(2)}  long-run histogram: ${fmtHist(c.histogram)}`;
    }
    if (debugDir) writeOverlay(canvas, res, spaces, join(debugDir, `${plan.id}.png`));
    if (probe) {
      // every gap within 3 t of the probe point, with what the classifier measured
      const reach = 3 * res.walls.thicknessPx;
      for (const op of [...res.doors, ...res.windows, ...res.passages]) {
        const { x0, y0, x1, y1 } = op.px;
        if (probe.x < x0 - reach || probe.x > x1 + reach || probe.y < y0 - reach || probe.y > y1 + reach) continue;
        const d = op.detail;
        note += `\n    ${op.kind} ${op.axis} px=${x0},${y0}..${x1},${y1} width=${op.widthPx.toFixed(0)} wall=${op.wallPx.toFixed(0)} lines=${d.lines} union=${d.union.toFixed(2)} best=${d.bestLine.toFixed(2)} clutter=${d.clutter.toFixed(2)}`;
        for (const a of d.arcs) note += `\n      arc ${a.jamb}${a.side > 0 ? '+' : '-'}${a.half ? ' half' : ''} score=${a.score.toFixed(2)} r=${a.radiusPx.toFixed(0)} leaf=${a.leaf.toFixed(2)}`;
      }
    }
  } catch (err) {
    note = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  const ms = Date.now() - start;
  rows.push({ name: plan.id, original: plan.gt, extracted: pred });
  perPlan.push({ id: plan.id, gt: plan.gt, pred, ms, note });
  const cell = (f) => `${String(pred[f]).padStart(2)}/${String(plan.gt[f] ?? 0).padEnd(2)}`;
  console.log(`${plan.id}  ${FIELDS.map((f) => `${f[0]} ${cell(f)}`).join('  ')}  ${String(ms).padStart(5)} ms  ${note}`);
}

// --- CSV (benchmark layout) ---------------------------------------------------------
const q = (s) => `"${s.replace(/"/g, '""')}"`;
const csv = ['name,original,extracted', ...rows.map((r) => `${r.name},${q(JSON.stringify(r.original))},${q(JSON.stringify(r.extracted))}`)].join('\n') + '\n';
writeFileSync(outCsv, csv);

// --- metrics, as visualizer.py computes them -------------------------------------
function score(rowsIn) {
  const exact = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const mapeSum = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const mapeN = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const r of rowsIn) {
    for (const f of FIELDS) {
      const gt = r.original[f] ?? 0;
      const ex = r.extracted[f] ?? 0;
      if (ex === gt) exact[f]++;
      if (gt === 0) {
        // zero ground truth: a zero prediction is a perfect row, anything else is skipped
        if (ex === 0) mapeN[f]++;
      } else {
        mapeSum[f] += Math.abs(ex - gt) / Math.abs(gt);
        mapeN[f]++;
      }
    }
  }
  const n = rowsIn.length;
  const em = Object.fromEntries(FIELDS.map((f) => [f, exact[f] / n]));
  const mape = Object.fromEntries(FIELDS.map((f) => [f, mapeN[f] ? mapeSum[f] / mapeN[f] : NaN]));
  const mean = (vals) => vals.reduce((a, b) => a + b, 0) / vals.length;
  const four = FIELDS.filter((f) => f !== 'Space');
  return {
    n,
    em,
    mape,
    meanEm5: mean(FIELDS.map((f) => em[f])),
    meanEm4: mean(four.map((f) => em[f])),
    meanMape5: mean(FIELDS.filter((f) => !Number.isNaN(mape[f])).map((f) => mape[f])),
    meanMape4: mean(four.filter((f) => !Number.isNaN(mape[f])).map((f) => mape[f])),
  };
}
const s = score(rows);
const fmt = (v) => (Number.isNaN(v) ? '  n/a' : v.toFixed(3).padStart(5));
console.log(`\nAECV-Bench object counting, n = ${s.n} plans, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log('field     EM     MAPE');
for (const f of FIELDS) console.log(`${f.padEnd(8)} ${fmt(s.em[f])}  ${fmt(s.mape[f])}`);
console.log(`mean(5)  ${fmt(s.meanEm5)}  ${fmt(s.meanMape5)}   (visualizer.py: five fields including Space)`);
console.log(`mean(4)  ${fmt(s.meanEm4)}  ${fmt(s.meanMape4)}   (README: four fields, no Space)`);
console.log(`csv: ${outCsv}`);
// worst plans by summed absolute error on the geometric fields, for inspection
const worst = perPlan
  .map((p) => ({ id: p.id, err: ['Door', 'Window', 'Space'].reduce((a, f) => a + Math.abs(p.pred[f] - (p.gt[f] ?? 0)), 0) }))
  .sort((a, b) => b.err - a.err)
  .slice(0, 10);
console.log('worst (Door+Window+Space abs error): ' + worst.map((x) => `${x.id}:${x.err}`).join(' '));
if (outJson) writeFileSync(outJson, JSON.stringify({ summary: s, options: overrides, plans: perPlan }, null, 2) + '\n');
