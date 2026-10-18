#!/usr/bin/env node --experimental-strip-types
// One-shot counting benchmark for the tier-1 CV scan on a labelled raster
// sheet (YOLO layout: a PNG/JPEG, a labels .txt with "class cx cy w h"
// normalised to the image, and a classes.txt with one name per line).
//
// Protocol (docs/research/benchmarks/raster-symbol-datasets.md, "Recommended
// evaluation design"): for every class present, click the centre of its
// first ground-truth instance, run cvScan, match hits to that class's boxes
// by centre-in-box, and report per class precision, recall and count error,
// plus mean recall, mean precision and the exact-count rate over classes.
// A hit that falls in another class's box is listed as a confusion.
//
// The image is fed straight to cvScan with the same point convention the
// CLI uses for an image wrapped in a PDF (page size = pixels / k points):
// x_pt = px / k, y_pt = (H - py) / k.
//
//   node --experimental-strip-types scripts/check-scan-dataset.mts \
//     --png sheet.png --labels labels/sheet.txt --classes classes.txt \
//     [--k 3] [--only 8,21] [--remove-lines auto|true|false] [--dihedral on|off] \
//     [--match-distance 0.15] [--json out.json]
//
// Node only (decodes the image with @napi-rs/canvas); the engine code it
// drives is the same the browser runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { cvScan, type CvScanOptions } from '../src/engine/scan-cv.ts';

interface Box {
  c: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] ?? '');
}
const png = args.get('png');
const labelsPath = args.get('labels');
const classesPath = args.get('classes');
if (!png || !labelsPath || !classesPath) {
  console.error('usage: check-scan-dataset.mts --png sheet.png --labels sheet.txt --classes classes.txt [--k 3] [--only 8,21] [--remove-lines auto|true|false] [--dihedral on|off] [--match-distance 0.15] [--json out.json]');
  process.exit(2);
}
const k = Number(args.get('k') ?? '3');
const only = args.get('only') ? new Set(args.get('only')!.split(',').map(Number)) : null;
const opts: CvScanOptions = {};
const rl = args.get('remove-lines');
if (rl === 'true') opts.removeLines = true;
else if (rl === 'false') opts.removeLines = false;
else if (rl === 'auto') opts.removeLines = 'auto';
if (args.get('dihedral') === 'off') opts.dihedral = false;
if (args.get('match-distance')) opts.matchDistance = Number(args.get('match-distance'));

const img = await loadImage(readFileSync(png));
const W = img.width;
const H = img.height;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, W, H);
ctx.drawImage(img, 0, 0);
const data = ctx.getImageData(0, 0, W, H).data;
const raster = {
  width: W,
  height: H,
  data,
  toRaster: (x: number, y: number) => ({ x: x * k, y: H - y * k }),
  toPdf: (x: number, y: number) => ({ x: x / k, y: (H - y) / k }),
};

const classes = readFileSync(classesPath, 'utf8').trim().split('\n').map((s) => s.trim());
const gt: Box[] = readFileSync(labelsPath, 'utf8')
  .trim()
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    const p = l.trim().split(/\s+/).map(Number);
    return { c: p[0], cx: p[1] * W, cy: p[2] * H, w: p[3] * W, h: p[4] * H };
  });
const inside = (x: number, y: number, g: Box) => Math.abs(x - g.cx) <= g.w / 2 && Math.abs(y - g.cy) <= g.h / 2;
const byClass = new Map<number, Box[]>();
for (const g of gt) byClass.set(g.c, [...(byClass.get(g.c) ?? []), g]);

interface Row {
  cls: number;
  name: string;
  gt: number;
  hits?: number;
  tp?: number;
  precision?: number;
  recall?: number;
  countErr?: number;
  templatePx?: number;
  note?: string;
  confusions?: Record<string, number>;
  error?: string;
  ms: number;
}
const rows: Row[] = [];
console.log(`${png}: ${W}x${H}, ${gt.length} boxes, ${byClass.size} classes, k=${k}, options ${JSON.stringify(opts)}`);
console.log('cls  name                        gt  hits   tp   prec  recall  err  template   ms  path');
for (const [c, inst] of [...byClass.entries()].sort((a, b) => a[0] - b[0])) {
  if (only && !only.has(c)) continue;
  const q = inst[0];
  const name = classes[c] ?? String(c);
  const t0 = Date.now();
  const res = cvScan(raster, { x: q.cx / k, y: (H - q.cy) / k }, opts);
  const ms = Date.now() - t0;
  if ('error' in res) {
    rows.push({ cls: c, name, gt: inst.length, error: res.error, ms });
    console.log(`${String(c).padStart(3)}  ${name.padEnd(26)} ${String(inst.length).padStart(3)}  error: ${res.error}  ${ms}ms`);
    continue;
  }
  const hits = res.hits.map((p) => ({ x: p.x * k, y: H - p.y * k }));
  const matched = new Set<number>();
  let tp = 0;
  const confusions: Record<string, number> = {};
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
  const precision = tp / Math.max(1, hits.length);
  const recall = matched.size / inst.length;
  const path = res.lineRemoval ? `lines removed (${res.lineRemoval.trigger})` : 'plain';
  rows.push({ cls: c, name, gt: inst.length, hits: hits.length, tp, precision, recall, countErr: hits.length - inst.length, templatePx: res.templatePx, note: res.note, confusions, ms });
  const conf = Object.keys(confusions).length ? '  false in ' + JSON.stringify(confusions) : '';
  console.log(
    `${String(c).padStart(3)}  ${name.padEnd(26)} ${String(inst.length).padStart(3)} ${String(hits.length).padStart(5)} ${String(tp).padStart(4)}   ${precision.toFixed(2)}    ${recall.toFixed(2)} ${String(hits.length - inst.length).padStart(4)} ${String(res.templatePx ?? '').padStart(8)}px ${String(ms).padStart(4)}  ${path}${conf}`,
  );
}

const scored = rows.filter((r) => r.recall !== undefined);
const n = rows.length;
const meanRecall = rows.reduce((s, r) => s + (r.recall ?? 0), 0) / Math.max(1, n);
const meanPrecision = rows.reduce((s, r) => s + (r.precision ?? 0), 0) / Math.max(1, n);
const exact = rows.filter((r) => r.countErr === 0).length;
const withGt3 = scored.filter((r) => r.gt >= 3);
const mape = withGt3.reduce((s, r) => s + Math.abs(r.countErr ?? 0) / r.gt, 0) / Math.max(1, withGt3.length);
const avgMs = rows.reduce((s, r) => s + r.ms, 0) / Math.max(1, n);
console.log(
  `\n${n} classes: mean recall ${meanRecall.toFixed(3)}, mean precision ${meanPrecision.toFixed(3)}, exact count ${exact}/${n}, MAPE over classes with >= 3 instances ${(mape * 100).toFixed(0)}% (${withGt3.length} classes), errors ${rows.filter((r) => r.error).length}, avg ${avgMs.toFixed(0)} ms per scan`,
);
if (args.get('json')) writeFileSync(args.get('json')!, JSON.stringify({ png, k, options: opts, rows, meanRecall, meanPrecision, exact, classes: n, mape }, null, 1) + '\n');
