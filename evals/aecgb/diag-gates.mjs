#!/usr/bin/env node
// Gate diagnostic for Dynamic Fill leaks on sheet_02: for every ground-truth
// room polygon, seed inside it, flood against the closed boundary, and find
// the exact pixels where the fill crosses the truth boundary ("gates").
// Per gate: extent along the wall (the opening width), darkest ink nearby
// (is the wall even visible at this threshold?), and which annotations
// (doors…) overlap it. Evidence base for the opening-detection patch.
//   node evals/aecgb/diag-gates.mjs [--rung 112] [--png /tmp/gates]
// Ground truth is used for DIAGNOSIS only, never to pick seeds for
// predictions (evals/runs/2026-10-19-aecgb-b6c, patch plan patch 2).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

import { openPdf, renderRasterNode } from '../../src/headless/cli.ts';
import { closeLine } from '../../src/engine/dynamicfill.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, 'repo');
const SHEET = 'sheet_02';
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const RUNG = Number(arg('rung') ?? 112);
const MIN_RUN = arg('min-run') === null ? Math.max(24, RUNG) : Number(arg('min-run')); // default = engine gate; 0 = classic ungated
const pngDir = arg('png');

const manifest = JSON.parse(readFileSync(join(REPO, 'dataset', 'manifest.json'), 'utf8'));
const entry = manifest.sheets.find((s) => s.sheet === SHEET);
const doc = await openPdf(new Uint8Array(readFileSync(join(REPO, 'dataset', entry.pdf))));
const page = await doc.getPage(1);
const vp1 = page.getViewport({ scale: 1 });
const frameScale = entry.width / vp1.width;
const raster = await renderRasterNode(doc, 1, 3);
const w = raster.width, h = raster.height;
const pdfH = vp1.height;
const lum = (i) => (raster.data[i * 4] * 299 + raster.data[i * 4 + 1] * 587 + raster.data[i * 4 + 2] * 114) / 1000;

// ---------- ground truth from the bench's scoring-ready CVAT XML ----------
const xml = readFileSync(join(REPO, 'dataset', 'annotations_15_scoring_ready.xml'), 'utf8');
const imgMatch = xml.match(new RegExp(`<image[^>]*name="[^"]*${SHEET}[^"]*"[^>]*>([\\s\\S]*?)</image>`));
if (!imgMatch) { console.error(`FAIL: no annotations for ${SHEET}`); process.exit(1); }
const anns = [];
for (const m of imgMatch[1].matchAll(/<polygon label="([^"]+)"[^>]*points="([^"]+)"/g)) {
  anns.push({ label: m[1], poly: m[2].trim().split(/\s*;\s*/).map((p) => p.split(',').map(Number)) });
}
for (const m of imgMatch[1].matchAll(/<box label="([^"]+)"[^>]*xtl="([-\d.]+)"[^>]*ytl="([-\d.]+)"[^>]*xbr="([-\d.]+)"[^>]*ybr="([-\d.]+)"/g)) {
  const [x1, y1, x2, y2] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  anns.push({ label: m[1], poly: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] });
}
const labelCounts = {};
for (const a of anns) labelCounts[a.label] = (labelCounts[a.label] ?? 0) + 1;
console.log(`${SHEET} annotations:`, JSON.stringify(labelCounts));

// ---------- frame helpers: manifest px (y-down) ↔ raster px ----------
const toRasterPt = ([mx, my]) => raster.toRaster(mx / frameScale, pdfH - my / frameScale);
const toManifest = (rx, ry) => [rx * frameScale / 3, entry.height - ry * frameScale / 3];

// ---------- ink + closed boundary ----------
const ink = new Uint8Array(w * h);
for (let i = 0; i < ink.length; i++) ink[i] = lum(i) < 220 ? 1 : 0;
const closedV = closeLine(ink, w, h, RUNG, true, MIN_RUN);
const closedH = closeLine(ink, w, h, RUNG, false, MIN_RUN);
const boundary = new Uint8Array(w * h);
for (let i = 0; i < boundary.length; i++) boundary[i] = closedV[i] | closedH[i] | ink[i];

const pip = (poly, x, y) => { // ray-cast, raster-space float poly [{x,y}]
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

function flood(sx, sy) {
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
      fill[ni] = 1; n++; stack.push(ni);
    }
  }
  return { fill, n };
}

// ---------- per-room analysis ----------
const rooms = anns.filter((a) => a.label === 'Area' || a.label === 'Room' || a.label === 'Balcony');
const summary = { sealed: 0, leaked: 0, noSeed: 0, gates: [] };
if (pngDir) mkdirSync(pngDir, { recursive: true });

rooms.forEach((room, ri) => {
  const poly = room.poly.map(toRasterPt).map((p) => ({ x: p.x, y: p.y }));
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  // seed: the interior grid point with a fully open 21×21 neighbourhood
  // (closing at this rung solidifies furniture/text clusters, so a bare
  // "not on ink" test lands inside 1-px pockets of those blobs), nearest to
  // the centroid
  let seed = null;
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const bx = [Math.min(...xs), Math.max(...xs)], by = [Math.min(...ys), Math.max(...ys)];
  let best = Infinity;
  for (let y = Math.ceil(by[0]); y <= by[1]; y += 3) for (let x = Math.ceil(bx[0]); x <= bx[1]; x += 3) {
    if (x < 10 || y < 10 || x >= w - 10 || y >= h - 10) continue;
    if (!pip(poly, x, y) || boundary[y * w + x]) continue;
    let clear = true;
    for (let dy = -10; dy <= 10 && clear; dy++) for (let dx = -10; dx <= 10; dx++) {
      if (boundary[(y + dy) * w + x + dx]) { clear = false; break; }
    }
    if (!clear) continue;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < best) { best = d; seed = [x, y]; }
  }
  const tPx = Math.abs(poly.reduce((s, p, i) => {
    const q = poly[(i + 1) % poly.length];
    return s + p.x * q.y - q.x * p.y;
  }, 0)) / 2;
  if (!seed) { summary.noSeed++; console.log(`room ${ri}: no interior seed found (area ${Math.round(tPx)} px²)`); return; }

  const { fill, n } = flood(seed[0], seed[1]);
  let out = 0;
  // sample fill-outside via PIP on filled bbox only where near poly bbox
  for (let y = Math.max(0, Math.floor(by[0]) - 4); y < Math.min(h, Math.ceil(by[1]) + 4); y++)
    for (let x = Math.max(0, Math.floor(bx[0]) - 4); x < Math.min(w, Math.ceil(bx[1]) + 4); x++)
      if (fill[y * w + x] && !pip(poly, x, y)) out++;

  // edge pixels (Bresenham along each truth edge)
  const edge = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    let x0 = Math.round(a.x), y0 = Math.round(a.y);
    const x1 = Math.round(b.x), y1 = Math.round(b.y);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      edge.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // gate: unsealed truth-boundary pixel with fill on both sides within 2 px
  const gate = new Uint8Array(edge.length);
  for (let k = 0; k < edge.length; k++) {
    const [ex, ey] = edge[k];
    if (ex < 0 || ey < 0 || ex >= w || ey >= h) continue;
    if (boundary[ey * w + ex]) continue;
    let fin = false, fout = false;
    for (let dyy = -2; dyy <= 2 && !(fin && fout); dyy++) for (let dxx = -2; dxx <= 2; dxx++) {
      const x = ex + dxx, y = ey + dyy;
      if (x < 0 || y < 0 || x >= w || y >= h || !fill[y * w + x]) continue;
      if (pip(poly, x, y)) fin = true; else fout = true;
    }
    if (fin && fout) gate[k] = 1;
  }
  // cluster contiguous gate runs along the edge sequence
  const clusters = [];
  for (let k = 0; k < edge.length; k++) {
    if (!gate[k]) continue;
    const last = clusters[clusters.length - 1];
    if (last && k - last.end <= 6) last.end = k;
    else clusters.push({ start: k, end: k });
  }

  const sealed = out < 0.02 * tPx && clusters.length === 0;
  if (sealed) summary.sealed++;
  else summary.leaked++;
  console.log(`room ${ri} (${room.label}): truth ${Math.round(tPx)} px², fill ${n} px (${(100 * n / (w * h)).toFixed(1)}% page), fill-outside ${Math.round(out)} px → ${sealed ? 'SEALED' : `LEAKS via ${clusters.length} gate(s)`}`);

  clusters.forEach((c) => {
    const pts = edge.slice(c.start, c.end + 1);
    const gxs = pts.map((p) => p[0]), gys = pts.map((p) => p[1]);
    const pad = 12;
    const x0 = Math.max(0, Math.min(...gxs) - pad), x1 = Math.min(w - 1, Math.max(...gxs) + pad);
    const y0 = Math.max(0, Math.min(...gys) - pad), y1 = Math.min(h - 1, Math.max(...gys) + pad);
    let minLum = 255, inkNear = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l = lum(y * w + x);
      if (l < minLum) minLum = l;
      if (l < 220) inkNear++;
    }
    const center = toManifest((Math.min(...gxs) + Math.max(...gxs)) / 2, (Math.min(...gys) + Math.max(...gys)) / 2)
      .map((v) => Math.round(v)).join(',');
    const near = anns.filter((a) => {
      const ax = a.poly.map((p) => toRasterPt(p));
      const ax0 = Math.min(...ax.map((p) => p.x)), ax1 = Math.max(...ax.map((p) => p.x));
      const ay0 = Math.min(...ax.map((p) => p.y)), ay1 = Math.max(...ax.map((p) => p.y));
      return ax1 >= x0 && ax0 <= x1 && ay1 >= y0 && ay0 <= y1;
    }).map((a) => a.label);
    const info = { room: ri, center, widthPx: pts.length, minLum: Math.round(minLum), inkNear, near: [...new Set(near)] };
    summary.gates.push(info);
    console.log(`   gate @(${center}) manifest: width ${pts.length} px, minLum ${Math.round(minLum)}, ink<220 in ±12px: ${inkNear}, overlaps: ${[...new Set(near)].join(',') || '—'}`);
  });

  if (pngDir && !sealed) {
    const cx0 = Math.max(0, Math.floor(bx[0]) - 160), cx1 = Math.min(w, Math.ceil(bx[1]) + 160);
    const cy0 = Math.max(0, Math.floor(by[0]) - 160), cy1 = Math.min(h, Math.ceil(by[1]) + 160);
    const cnv = createCanvas(cx1 - cx0, cy1 - cy0);
    const ctx = cnv.getContext('2d');
    const img = ctx.createImageData(cx1 - cx0, cy1 - cy0);
    for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) {
      const p = ((y - cy0) * (cx1 - cx0) + (x - cx0)) * 4;
      if (fill[y * w + x]) { img.data[p] = 220; img.data[p + 1] = 60; img.data[p + 2] = 60; }
      else if (boundary[y * w + x]) { img.data[p] = img.data[p + 1] = img.data[p + 2] = 0; }
      else { img.data[p] = img.data[p + 1] = img.data[p + 2] = 255; }
      img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2;
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x - cx0, p.y - cy0) : ctx.moveTo(p.x - cx0, p.y - cy0)));
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = '#e040f0';
    for (let k = 0; k < edge.length; k++) if (gate[k]) ctx.fillRect(edge[k][0] - cx0 - 1, edge[k][1] - cy0 - 1, 3, 3);
    const p = join(pngDir, `room-${ri}.png`);
    writeFileSync(p, cnv.toBuffer('image/png'));
  }
});

console.log(`\nsummary (rung ${RUNG}, minRun ${MIN_RUN}): sealed ${summary.sealed}, leaked ${summary.leaked}, no-seed ${summary.noSeed}, gates ${summary.gates.length}`);
const widths = summary.gates.map((g) => g.widthPx).sort((a, b) => a - b);
if (widths.length) console.log('gate widths px (raster):', widths.join(', '), '| 2·rung =', 2 * RUNG);
const dark = summary.gates.filter((g) => g.minLum < 220).length;
console.log(`gates with ink<220 within ±12px: ${dark}/${summary.gates.length} (rest have no visible ink at threshold 220)`);
