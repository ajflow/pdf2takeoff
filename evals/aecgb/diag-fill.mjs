#!/usr/bin/env node
// Leak diagnostic for Dynamic Fill: pick a seed, build the closed boundary
// at a given rung, flood WITHOUT the fraction cap, and render where the
// fill escapes the boundary. Used to design the opening-detection patch
// against real failure cases (evals/runs/2026-10-19-aecgb-b6c).
//   node evals/aecgb/diag-fill.mjs --at 600,855 --rung 112 --png /tmp/leak.png
// (coordinates in manifest px, like the predictions)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

import { openPdf, renderRasterNode } from '../../src/headless/cli.ts';
import { dynamicFill, closeLine } from '../../src/engine/dynamicfill.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, 'repo');
const SHEET = 'sheet_02';
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const at = (arg('at') ?? '600,855').split(',').map(Number);
const RUNG = Number(arg('rung') ?? 112);
const png = arg('png') ?? '/tmp/fill-leak.png';

const manifest = JSON.parse(readFileSync(join(REPO, 'dataset', 'manifest.json'), 'utf8'));
const entry = manifest.sheets.find((s) => s.sheet === SHEET);
const pdfBytes = readFileSync(join(REPO, 'dataset', entry.pdf));
const doc = await openPdf(new Uint8Array(pdfBytes));
const page = await doc.getPage(1);
const vp1 = page.getViewport({ scale: 1 });
const frameScale = entry.width / vp1.width;
const raster = await renderRasterNode(doc, 1, 3);
const { width: w, height: h } = raster;
const pdfH = vp1.height;
const seed = { x: at[0] / frameScale, y: pdfH - at[1] / frameScale };
const sr = raster.toRaster(seed.x, seed.y);
const sx = Math.round(sr.x), sy = Math.round(sr.y);

// ink at the engine's own escalation-chosen threshold (220 for this sheet)
const lum = (i) => (raster.data[i * 4] * 299 + raster.data[i * 4 + 1] * 587 + raster.data[i * 4 + 2] * 114) / 1000;
const ink = new Uint8Array(w * h);
for (let i = 0, p = 0; i < ink.length; i++, p += 4) ink[i] = lum(i) < 220 ? 1 : 0;

const closedV = closeLine(ink, w, h, RUNG, true);
const closedH = closeLine(ink, w, h, RUNG, false);
const boundary = new Uint8Array(w * h);
for (let i = 0; i < boundary.length; i++) boundary[i] = closedV[i] | closedH[i] | ink[i];

// uncapped flood from the seed
const fill = new Uint8Array(w * h);
const stack = [sy * w + sx];
fill[stack[0]] = 1;
let n = 1;
while (stack.length) {
  const idx = stack.pop();
  const x = idx % w, y = (idx / w) | 0;
  for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const ni = ny * w + nx;
    if (fill[ni] || boundary[ni]) continue;
    fill[ni] = 1; n++;
    stack.push(ni);
  }
}
const capped = dynamicFill(raster, seed, undefined, [RUNG]);
console.log(`seed (${at[0]},${at[1]}) rung ${RUNG}: uncapped fill ${(100 * n / (w * h)).toFixed(1)}% of page; engine says: ${'error' in capped ? capped.error : `bounded, ${capped.points.length} pts`}`);

// render: closed boundary black, leaked fill red, seed green
const cnv = createCanvas(w, h);
const ctx = cnv.getContext('2d');
const img = ctx.createImageData(w, h);
for (let i = 0; i < w * h; i++) {
  const p = i * 4;
  if (fill[i]) { img.data[p] = 220; img.data[p + 1] = 60; img.data[p + 2] = 60; }
  else if (boundary[i]) { img.data[p] = img.data[p + 1] = img.data[p + 2] = 0; }
  else { img.data[p] = img.data[p + 1] = img.data[p + 2] = 255; }
  img.data[p + 3] = 255;
}
ctx.putImageData(img, 0, 0);
ctx.fillStyle = '#22c55e';
ctx.fillRect(sx - 4, sy - 4, 9, 9);
writeFileSync(png, cnv.toBuffer('image/png'));
console.log(`ok: ${png} (fill red ${n} px, boundary black, seed green)`);
