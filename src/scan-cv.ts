// Scan provider, tier 1: pure local computer vision, no model download.
// Click one instance of a repeated symbol; the engine rasterizes the page,
// binarizes the ink, extracts connected components, and matches every
// component to the clicked one by size, aspect, fill and a normalized shape
// signature. Runs in well under a second per sheet on typed arrays alone.
// Tier 2 (src/scan-onnx.ts) is a trained ONNX detector that slots in behind
// the same ScanResult interface; src/scan.ts picks whichever is available.

import type { PDFPageProxy } from 'pdfjs-dist';
import { getPdfDoc } from './viewer';
import type { Pt } from './state';
import type { ScanResult } from './scan';

export const RASTER_SCALE = 3;
const SIG = 20; // signature grid
const MIN_COMPONENT_PX = 12;
const MATCH_DIST = 0.16; // signature L1 distance threshold (0 = identical)
const SIZE_BAND = 0.55; // sqrt area ratio bounds (1/x .. x)
const ASPECT_BAND = 0.3; // |log aspect ratio difference|
const FILL_BAND = 0.18;

interface Component {
  label: number;
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  fill: number;
  sig: Float32Array;
}

export async function cvScan(pageNum: number, clicked: Pt): Promise<ScanResult> {
  const { canvas: cnv, viewport: vp } = await renderRaster(pageNum, RASTER_SCALE);
  const w = cnv.width;
  const h = cnv.height;
  const ctx = cnv.getContext('2d', { willReadFrequently: true })!;
  const data = ctx.getImageData(0, 0, w, h).data;

  // ink mask — vector CAD output is high-contrast, a fixed threshold is enough
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const lum = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    mask[i] = lum < 150 ? 1 : 0;
  }

  // clicked point → raster px (with a small tolerance for anti-aliased edges)
  const [vx, vy] = vp.convertToViewportPoint(clicked.x, clicked.y);
  const px = Math.round(vx);
  const py = Math.round(vy);
  let clickedLabel = 0;
  if (px >= 0 && py >= 0 && px < w && py < h) {
    // ring search up to ~3.3 PDF pt so a click anywhere inside a symbol
    // (not just exactly on a stroke) still teaches the scan
    for (let r = 0; r <= 10 && !clickedLabel; r++) {
      for (let dy = -r; dy <= r && !clickedLabel; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (mask[y * w + x]) {
            clickedLabel = -1; // marker: ink found, label assigned after pass
            break;
          }
        }
      }
    }
  }
  if (!clickedLabel) return { error: 'click directly on a symbol to teach the scan' };

  // connected components, 8-connectivity, iterative flood fill
  const labels = new Int32Array(w * h);
  const comps: Component[] = [];
  const stack: number[] = [];
  let nextLabel = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = ++nextLabel;
    stack.length = 0;
    stack.push(start);
    labels[start] = id;
    let count = 0;
    let sx = 0;
    let sy = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const y = (idx / w) | 0;
      const x = idx - y * w;
      count++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const nidx = ny * w + nx;
          if (mask[nidx] && !labels[nidx]) {
            labels[nidx] = id;
            stack.push(nidx);
          }
        }
      }
    }
    if (count < MIN_COMPONENT_PX || count > (w * h) / 16) continue;
    comps.push(makeComponent(id, count, x0, y0, x1, y1, sx / count, sy / count, labels, w));
  }

  // resolve the clicked component (first ink pixel at/around the click)
  let template: Component | undefined;
  if (px >= 0 && py >= 0 && px < w && py < h) {
    outer: for (let r = 0; r <= 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const l = labels[y * w + x];
          if (l) {
            template = comps.find((c) => c.label === l);
            break outer;
          }
        }
      }
    }
  }
  if (!template) return { error: 'that symbol is too small or part of a large structure; try a smaller, isolated symbol' };

  // match every component against the template
  const aspectT = (template.x1 - template.x0 + 1) / (template.y1 - template.y0 + 1);
  const hits: Pt[] = [];
  for (const c of comps) {
    const sizeRatio = Math.sqrt(template.count / c.count);
    if (sizeRatio < SIZE_BAND || sizeRatio > 1 / SIZE_BAND) continue;
    const aspectC = (c.x1 - c.x0 + 1) / (c.y1 - c.y0 + 1);
    if (Math.abs(Math.log(aspectT / aspectC)) > ASPECT_BAND) continue;
    if (Math.abs(template.fill - c.fill) > FILL_BAND) continue;
    let d = 0;
    for (let i = 0; i < template.sig.length; i++) d += Math.abs(template.sig[i] - c.sig[i]);
    if (d <= MATCH_DIST) {
      const [hx, hy] = vp.convertToPdfPoint(c.cx, c.cy);
      hits.push({ x: hx, y: hy });
    }
  }

  // stable numbering: reading order, rows then columns
  hits.sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
  return { hits, provider: 'cv', templatePx: template.count };
}

// Rasterize a page off-screen at an integer scale. Shared by both scan
// providers so tier 1 and tier 2 always see identical pixels.
export async function renderRaster(
  pageNum: number,
  scale: number,
): Promise<{ canvas: HTMLCanvasElement; viewport: ReturnType<PDFPageProxy['getViewport']> }> {
  const doc = getPdfDoc();
  if (!doc) throw new Error('open a drawing first');
  const page: PDFPageProxy = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale });
  const w = Math.max(1, Math.floor(vp.width));
  const h = Math.max(1, Math.floor(vp.height));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
  return { canvas, viewport: vp };
}

function makeComponent(
  label: number,
  count: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  labels: Int32Array,
  w: number,
): Component {
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // shape signature: ink coverage downsampled to a SIG x SIG grid over the bbox
  const sig = new Float32Array(SIG * SIG);
  const cellW = bw / SIG;
  const cellH = bh / SIG;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    const gy = Math.min(SIG - 1, Math.floor((y - y0) / cellH));
    for (let x = x0; x <= x1; x++) {
      if (labels[row + x] === label) {
        const gx = Math.min(SIG - 1, Math.floor((x - x0) / cellW));
        sig[gy * SIG + gx] += 1;
      }
    }
  }
  const perCell = cellW * cellH;
  for (let i = 0; i < sig.length; i++) sig[i] = Math.min(1, sig[i] / perCell);
  return { label, count, x0, y0, x1, y1, cx, cy, fill: count / (bw * bh), sig };
}
