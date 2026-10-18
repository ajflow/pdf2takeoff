#!/usr/bin/env node
// AECV-Bench room labels: OCR every plan image in a local clone of
// AECFoundry/AECV-Bench, count rooms by class with the room-label
// dictionary, and write one JSON that the counting harness
// (scripts/aecv-bench.mjs, its labelsFor(planId) hook) reads instead of
// running OCR itself. Also scores bedroom and toilet against the ground
// truth (metadata.json) the way the benchmark's visualizer does.
//
// Usage:
//   node --experimental-strip-types scripts/aecv-labels.mjs --data <clone> --out labels.json
//        [--ids 0000-0001,5000_0010] [--family 5000] [--limit N] [--jobs N]
//        [--debug-dir DIR] [--threshold T] [--no-small-print] [--no-flip] [--harness-out words.json]
//
// --data is the clone root (the "data/Use Case 1 - Object Counting/1 - Full
// Datasets" folder is found under it) or that folder itself. --jobs N
// splits the plans over N child processes (one tesseract worker each).
// --debug-dir writes <id>.png per plan: the image with every word boxed
// (grey: ignored, blue: used, class colour: part of a counted label). A
// plan that yields no room label at all is read again turned 180 degrees
// (several CubiCasa scans in the set are upside down); --no-flip skips that.
//
// Two files come out. --out holds everything (schema below). The harness
// file (--harness-out, default <out basename>.harness.json next to it) is
// what scripts/aecv-bench.mjs --labels reads: { "<planId>": [label, ...] },
// one string per counted bedroom or toilet label, written as "Bedroom: <as
// printed>" or "WC: <as printed>" so the harness's own regexes count them
// exactly as this script did (a fuzzy "HH" read as MH arrives as
// "Bedroom: HH").
//
// Output schema (labels.json):
// {
//   "schema": "pdf2takeoff-aecv-labels/1",
//   "generated": ISO date, "engine": { "ocr": "tesseract.js", "options": {...} },
//   "plans": [
//     {
//       "id": "5000_0010",            // folder name in the dataset
//       "family": "5000",             // leading digits of the id (0000, 2000, 3000, 4000, 5000, 6000)
//       "file": "5000_0010.png",
//       "width": 2197, "height": 2624, // image px
//       "words": [ { "text", "conf", "xPt", "yPt", "wPt", "hPt" } ],
//           // every OCR word, in PDF points of the one-page document openAny
//           // makes of the image: 1 pt = 3 px (RASTER_SCALE), y up.
//           // px x = xPt * 3, px y = height - yPt * 3.
//       "labels": [ { "text", "cls", "conf", "fuzzy"?, "xPt", "yPt", "xPx", "yPx" } ],
//           // the room labels countRoomsByClass built from the words; "fuzzy"
//           // names the confusion rule when the label only read through one
//       "bedroom", "toilet", "kitchen", "living", "hall", "closet", "other", // counts
//       "gt": { "Bedroom", "Toilet", "Door", "Window", "Space" },           // metadata.json
//       "rotated": false,               // true when the plan only read turned 180 degrees (see --no-flip)
//       "seconds": 12.3                 // OCR wall time for this plan
//     }
//   ],
//   "summary": { "overall": {...}, "byFamily": { "5000": {...} } }
//       // per group: n, bedroomEM, toiletEM, bedroomMAPE, toiletMAPE, seconds
// }
//
// MAPE follows the benchmark (src/benchmark/visualizer.py): |pred - gt| / gt
// per plan, a plan with gt 0 contributes 0 when pred is 0 and is skipped
// otherwise. EM is the share of plans with pred === gt.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { RASTER_SCALE } from '../src/engine/ports.ts';
import { openAny, openImage } from '../src/headless/image-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';
import { ocrRaster, terminateOcr } from '../src/headless/ocr-node.ts';
import { countRoomsByClass, ROOM_CLASSES } from '../src/engine/room-labels.ts';

const SELF = fileURLToPath(import.meta.url);
const DATASET_SUBDIR = join('data', 'Use Case 1 - Object Counting', '1 - Full Datasets');
const IMAGE_EXT = /\.(png|jpe?g)$/i;
const FAMILIES = ['0000', '2000', '3000', '4000', '5000', '6000'];

function parseArgs(argv) {
  const out = { ids: null, family: null, limit: null, jobs: 1, debugDir: null, threshold: undefined, smallPrint: true, data: null, out: null, harnessOut: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--data') out.data = next();
    else if (a === '--out') out.out = next();
    else if (a === '--harness-out') out.harnessOut = next();
    else if (a === '--ids') out.ids = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--family') out.family = next();
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--jobs') out.jobs = Math.max(1, Number(next()));
    else if (a === '--debug-dir') out.debugDir = next();
    else if (a === '--threshold') out.threshold = Number(next());
    else if (a === '--no-small-print') out.smallPrint = false;
    else if (a === '--no-flip') out.noFlip = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(SELF, 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.data || !out.out) throw new Error('--data <clone> and --out <labels.json> are required');
  return out;
}

/** The plans folder: --data itself when it holds plan folders, else the known subfolder. */
function datasetDir(data) {
  const root = resolve(data);
  const direct = readdirSync(root).some((n) => existsSync(join(root, n, 'metadata.json')));
  if (direct) return root;
  const sub = join(root, DATASET_SUBDIR);
  if (existsSync(sub)) return sub;
  throw new Error(`no plan folders under ${root} (expected <id>/metadata.json or ${DATASET_SUBDIR})`);
}

function listPlans(dir) {
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, 'metadata.json')))
    .sort()
    .map((id) => {
      const file = readdirSync(join(dir, id)).find((n) => IMAGE_EXT.test(n) && n.startsWith(id)) ?? readdirSync(join(dir, id)).find((n) => IMAGE_EXT.test(n));
      return { id, family: familyOf(id), file, dir: join(dir, id) };
    })
    .filter((p) => p.file);
}

export function familyOf(id) {
  const m = /^(\d{4})/.exec(id);
  return m ? m[1] : 'other';
}

function readGt(dir) {
  const raw = readFileSync(join(dir, 'metadata.json'), 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

/**
 * The plan image as a one-page document. openAny sniffs PNG/JPEG; three of
 * the dataset's .jpg files are WebP, which skia decodes, so those go
 * straight to openImage.
 */
async function openPlan(path) {
  try {
    return (await openAny(path)).doc;
  } catch {
    return openImage(new Uint8Array(readFileSync(path)));
  }
}

/** Per-plan OCR plus room count. */
async function labelPlan(plan, opts) {
  const t0 = Date.now();
  const doc = await openPlan(join(plan.dir, plan.file));
  const raster = await renderRasterNode(doc, 1, RASTER_SCALE);
  const ocrOpts = {};
  if (opts.threshold !== undefined) ocrOpts.threshold = opts.threshold;
  if (!opts.smallPrint) ocrOpts.upsample = 1;
  let words = await ocrRaster(raster, ocrOpts);
  let rooms = countRoomsByClass(words);
  let rotated = false;
  if (rooms.labels.length === 0 && !opts.noFlip) {
    // nothing read as a room: some scans in the set are upside down, so read again turned 180 degrees
    const flipped = await ocrRaster(raster, { ...ocrOpts, rotations: [180] });
    const flippedRooms = countRoomsByClass(flipped);
    if (flippedRooms.labels.length > 0) {
      words = flipped;
      rooms = flippedRooms;
      rotated = true;
    }
  }
  const seconds = (Date.now() - t0) / 1000;
  const gt = readGt(plan.dir);
  const rec = {
    id: plan.id,
    family: plan.family,
    file: plan.file,
    width: raster.width,
    height: raster.height,
    words: words.map((w) => ({ text: w.text, conf: Math.round(w.conf * 10) / 10, xPt: r1(w.xPt), yPt: r1(w.yPt), wPt: r1(w.wPt), hPt: r1(w.hPt) })),
    labels: rooms.labels.map((l) => ({ text: l.text, cls: l.cls, conf: l.conf, ...(l.fuzzy ? { fuzzy: l.fuzzy } : {}), xPt: r1(l.xPt), yPt: r1(l.yPt), xPx: Math.round(l.xPt * RASTER_SCALE), yPx: Math.round(raster.height - l.yPt * RASTER_SCALE) })),
    gt,
    rotated,
    seconds: Math.round(seconds * 10) / 10,
  };
  for (const c of ROOM_CLASSES) rec[c] = rooms.counts[c];
  if (opts.debugDir) await writeDebug(plan, raster, rec, opts.debugDir);
  return rec;
}

const r1 = (v) => Math.round(v * 10) / 10;

const CLASS_COLOURS = { bedroom: '#d62728', toilet: '#1f77b4', kitchen: '#ff7f0e', living: '#2ca02c', hall: '#9467bd', closet: '#8c564b', other: '#7f7f7f' };

/** The plan with every word boxed and the counted labels named, for eyeballing misses. */
async function writeDebug(plan, raster, rec, dir) {
  mkdirSync(dir, { recursive: true });
  const img = await loadImage(join(plan.dir, plan.file));
  const cnv = createCanvas(raster.width, raster.height);
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, raster.width, raster.height);
  ctx.globalAlpha = 0.45;
  ctx.drawImage(img, 0, 0, raster.width, raster.height);
  ctx.globalAlpha = 1;
  const s = RASTER_SCALE;
  const H = raster.height;
  const labelWords = new Set();
  for (const l of rec.labels) for (const w of rec.words) if (Math.abs(w.xPt - l.xPt) < 40 && Math.abs(w.yPt - l.yPt) < 6 && l.text.includes(w.text)) labelWords.add(w);
  const fontPx = Math.max(10, Math.round(raster.width / 150));
  ctx.font = `${fontPx}px sans-serif`;
  ctx.lineWidth = 1.5;
  for (const w of rec.words) {
    const x = (w.xPt - w.wPt / 2) * s;
    const y = H - (w.yPt + w.hPt / 2) * s;
    const used = w.conf >= 45;
    ctx.strokeStyle = labelWords.has(w) ? '#000' : used ? '#1f77b4' : '#bbb';
    ctx.strokeRect(x, y, w.wPt * s, w.hPt * s);
    ctx.fillStyle = used ? '#000' : '#999';
    ctx.fillText(`${w.text} ${Math.round(w.conf)}`, x, Math.max(fontPx, y - 2));
  }
  ctx.lineWidth = 3;
  for (const l of rec.labels) {
    ctx.strokeStyle = CLASS_COLOURS[l.cls] ?? '#000';
    ctx.strokeRect(l.xPx - 20, l.yPx - 12, 40, 24);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(`${l.cls}: ${l.text}`, l.xPx + 22, l.yPx + fontPx / 2);
  }
  ctx.fillStyle = '#000';
  ctx.font = `bold ${fontPx + 4}px sans-serif`;
  const gtLine = `${plan.id}  bedroom ${rec.bedroom} (gt ${rec.gt.Bedroom})  toilet ${rec.toilet} (gt ${rec.gt.Toilet})  ${rec.seconds}s`;
  ctx.fillText(gtLine, 8, fontPx + 8);
  writeFileSync(join(dir, `${plan.id}.png`), cnv.toBuffer('image/png'));
}

/** The flat { planId: [label, ...] } file scripts/aecv-bench.mjs --labels reads (bedroom and toilet labels only). */
export function harnessLabels(plans) {
  const out = {};
  for (const p of plans) {
    out[p.id] = p.labels.filter((l) => l.cls === 'bedroom' || l.cls === 'toilet').map((l) => `${l.cls === 'bedroom' ? 'Bedroom' : 'WC'}: ${l.text}`);
  }
  return out;
}

/** EM and MAPE for one field over a set of plans, the benchmark's way. */
function score(plans, field, gtField) {
  let exact = 0;
  let mapeSum = 0;
  let mapeN = 0;
  for (const p of plans) {
    const gt = p.gt?.[gtField] ?? 0;
    const pred = p[field] ?? 0;
    if (pred === gt) exact++;
    if (gt === 0) {
      if (pred === 0) mapeN++;
      continue;
    }
    mapeSum += Math.abs(pred - gt) / Math.abs(gt);
    mapeN++;
  }
  return { em: plans.length ? exact / plans.length : NaN, mape: mapeN ? mapeSum / mapeN : NaN };
}

export function summarize(plans) {
  const group = (ps) => {
    const b = score(ps, 'bedroom', 'Bedroom');
    const t = score(ps, 'toilet', 'Toilet');
    const secs = ps.map((p) => p.seconds);
    return {
      n: ps.length,
      bedroomEM: b.em,
      toiletEM: t.em,
      bedroomMAPE: b.mape,
      toiletMAPE: t.mape,
      seconds: secs.reduce((s, v) => s + v, 0),
      meanSeconds: secs.length ? secs.reduce((s, v) => s + v, 0) / secs.length : NaN,
      maxSeconds: secs.length ? Math.max(...secs) : NaN,
    };
  };
  const byFamily = {};
  for (const f of [...FAMILIES, ...new Set(plans.map((p) => p.family).filter((f) => !FAMILIES.includes(f)))]) {
    const ps = plans.filter((p) => p.family === f);
    if (ps.length) byFamily[f] = group(ps);
  }
  return { overall: group(plans), byFamily };
}

const pct = (v) => (Number.isNaN(v) ? '  n/a' : `${(100 * v).toFixed(1).padStart(5)}%`);
const sec = (v) => (Number.isNaN(v) ? 'n/a' : v.toFixed(1));

export function formatSummary(summary) {
  const rows = [['family', 'n', 'bedroom EM', 'bedroom MAPE', 'toilet EM', 'toilet MAPE', 'mean s', 'max s']];
  const row = (name, g) => rows.push([name, String(g.n), pct(g.bedroomEM), pct(g.bedroomMAPE), pct(g.toiletEM), pct(g.toiletMAPE), sec(g.meanSeconds), sec(g.maxSeconds)]);
  for (const [f, g] of Object.entries(summary.byFamily)) row(f, g);
  row('all', summary.overall);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
}

async function runChild(args, ids, part) {
  const argv = [...process.execArgv, SELF, '--data', args.data, '--out', part, '--ids', ids.join(','), '--quiet'];
  if (args.debugDir) argv.push('--debug-dir', args.debugDir);
  if (args.threshold !== undefined) argv.push('--threshold', String(args.threshold));
  if (!args.smallPrint) argv.push('--no-small-print');
  if (args.noFlip) argv.push('--no-flip');
  await new Promise((res, rej) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`child exited ${code}`))));
    child.on('error', rej);
  });
  return JSON.parse(readFileSync(part, 'utf8')).plans;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = datasetDir(args.data);
  let plans = listPlans(dir);
  if (args.ids) plans = plans.filter((p) => args.ids.includes(p.id));
  if (args.family) plans = plans.filter((p) => p.family === args.family);
  if (args.limit) plans = plans.slice(0, args.limit);
  if (!plans.length) throw new Error('no plans selected');
  const t0 = Date.now();
  let results;
  if (args.jobs > 1 && plans.length > 1) {
    // round-robin by size order so each child gets a mix of big and small plans
    const sized = plans.map((p) => ({ p, bytes: statSync(join(p.dir, p.file)).size })).sort((a, b) => b.bytes - a.bytes);
    const buckets = Array.from({ length: Math.min(args.jobs, plans.length) }, () => []);
    sized.forEach(({ p }, i) => buckets[i % buckets.length].push(p.id));
    mkdirSync(resolve(args.out, '..'), { recursive: true });
    const parts = await Promise.all(buckets.map((ids, k) => runChild(args, ids, `${args.out}.part${k}.json`)));
    const byId = new Map(parts.flat().map((r) => [r.id, r]));
    results = plans.map((p) => byId.get(p.id)).filter(Boolean);
  } else {
    results = [];
    for (const plan of plans) {
      let rec;
      try {
        rec = await labelPlan(plan, args);
      } catch (err) {
        console.error(`${plan.id}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      results.push(rec);
      // progress goes to stdout even in a child (--quiet only mutes the summary)
      console.log(`${rec.id} ${rec.width}x${rec.height} ${rec.seconds}s${rec.rotated ? ' (read upside down)' : ''} ${rec.words.length} words: bedroom ${rec.bedroom} (gt ${rec.gt.Bedroom}) toilet ${rec.toilet} (gt ${rec.gt.Toilet}) | ${rec.labels.map((l) => `${l.cls}:${l.text}`).join(', ')}`);
    }
    await terminateOcr();
  }
  const summary = summarize(results);
  const out = {
    schema: 'pdf2takeoff-aecv-labels/1',
    generated: new Date().toISOString(),
    engine: { ocr: 'tesseract.js', options: { threshold: args.threshold ?? null, smallPrint: args.smallPrint } },
    plans: results,
    summary,
  };
  mkdirSync(resolve(args.out, '..'), { recursive: true });
  writeFileSync(args.out, JSON.stringify(out, null, 1));
  const harnessPath = args.harnessOut ?? args.out.replace(/\.json$/i, '') + '.harness.json';
  writeFileSync(harnessPath, JSON.stringify(harnessLabels(results), null, 1));
  if (!args.quiet) {
    console.log(formatSummary(summary));
    console.log(`wall ${((Date.now() - t0) / 1000).toFixed(0)} s for ${results.length} plans (jobs ${args.jobs}); wrote ${args.out} and ${harnessPath}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
