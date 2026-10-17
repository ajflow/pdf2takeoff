// Browser OCR adapter: lazily loads tesseract.js (WASM) on first use, reads
// the current page, and maps recognized words into PDF-point space for the
// engine's calibration heuristics. The first run fetches the language pack
// from a CDN (~4 MB, then cached) — everything after that is local.
//
// Dimension reads go through ocrCorridor: instead of the whole page, only a
// strip along the clicked segment is recognized — rotated so the text is
// always upright for the recognizer (tesseract's weak point is text aligned
// to arbitrary-angle dimension lines), and pre-filtered to drop line work
// (Fletcher–Kasturi-style component pruning) so digits are not confused with
// tick marks and wall strokes.

import { renderRaster } from './raster';
import { corridorAngles, pickCorridorReading, type OcrWord } from '../engine/ocr';
import type { Pt } from '../engine/types';

let workerPromise: Promise<import('tesseract.js').Worker> | null = null;

async function getWorker() {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    return createWorker('eng');
  })();
  return workerPromise;
}

function rasterToCanvas(raster: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): HTMLCanvasElement {
  const cnv = document.createElement('canvas');
  cnv.width = raster.width;
  cnv.height = raster.height;
  const ctx = cnv.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.createImageData(raster.width, raster.height);
  img.data.set(raster.data as Uint8ClampedArray);
  ctx.putImageData(img, 0, 0);
  return cnv;
}

interface RawWord {
  text: string;
  conf: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Characters a printed dimension can contain (digits, separators, unit marks). */
const DIMENSION_CHARS = "0123456789.,'\"-xXmMcCnNiIfFtT";

async function recognize(cnv: HTMLCanvasElement, whitelist = ''): Promise<RawWord[]> {
  const worker = await getWorker();
  // the worker is shared with full-page reads, so the whitelist is set per call
  await worker.setParameters({ tessedit_char_whitelist: whitelist });
  const { data } = await worker.recognize(cnv, {}, { blocks: true, text: true });
  // v7 nests words under blocks -> paragraphs -> lines -> words
  const raw: RawWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) raw.push({ text: w.text ?? '', conf: w.confidence ?? 0, bbox: w.bbox });
      }
    }
  }
  return raw;
}

export async function ocrPage(pageNum: number): Promise<OcrWord[]> {
  const raster = await renderRaster(pageNum, 3);
  const cnv = rasterToCanvas(raster);
  const raw = await recognize(cnv);

  const words: OcrWord[] = [];
  for (const w of raw) {
    const text = w.text.trim();
    const b = w.bbox;
    if (!text || !b) continue;
    const p0 = raster.toPdf(b.x0, b.y0);
    const p1 = raster.toPdf(b.x1, b.y1);
    words.push({
      text,
      conf: w.conf,
      xPt: (p0.x + p1.x) / 2,
      yPt: (p0.y + p1.y) / 2,
      wPt: Math.abs(p1.x - p0.x),
      hPt: Math.abs(p1.y - p0.y),
    });
  }
  return words;
}

/**
 * White-out line work inside the crop so the recognizer sees glyphs only:
 * connected components of the ink mask that are elongated (the dimension
 * line and any crossing walls/extension lines) or tiny specks are removed.
 */
function dropLineArt(ctx: CanvasRenderingContext2D, w: number, h: number, threshold = 150): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    mask[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 < threshold ? 1 : 0;
  }
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pxs: number[] = [];
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      pxs.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (mask[ni] && !seen[ni]) {
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
    const cw = x1 - x0 + 1;
    const chh = y1 - y0 + 1;
    const lineLike = (cw > 3.5 * chh && cw > 40) || (chh > 3.5 * cw && chh > 40);
    const speck = pxs.length < 5;
    if (!lineLike && !speck) continue;
    for (const i of pxs) {
      const p = i * 4;
      d[p] = d[p + 1] = d[p + 2] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * OCR just the corridor along a clicked segment, rotated so its text reads
 * upright. Returns words in PDF-point space (same shape as ocrPage), ready
 * for nearestDimensionValue. Near-vertical segments read bottom to top by
 * drafting convention; the opposite reading is tried too and the better
 * parse wins (corridorAngles / pickCorridorReading).
 */
export async function ocrCorridor(pageNum: number, a: Pt, b: Pt): Promise<OcrWord[]> {
  const raster = await renderRaster(pageNum, 3);
  const page = rasterToCanvas(raster);
  const ra = raster.toRaster(a.x, a.y);
  const rb = raster.toRaster(b.x, b.y);
  const readings: OcrWord[][] = [];
  for (const theta of corridorAngles(ra, rb)) readings.push(await readCorridor(page, raster, ra, rb, theta));
  return readings[pickCorridorReading(readings, a, b)];
}

async function readCorridor(
  page: HTMLCanvasElement,
  raster: Awaited<ReturnType<typeof renderRaster>>,
  ra: Pt,
  rb: Pt,
  theta: number,
): Promise<OcrWord[]> {
  const len = Math.hypot(rb.x - ra.x, rb.y - ra.y);
  const band = 60; // px each side of the line (~20 pt, where labels sit)
  const cw = Math.ceil(len + 2 * band);
  const ch = Math.ceil(2 * band);

  const cnv = document.createElement('canvas');
  cnv.width = cw;
  cnv.height = ch;
  const ctx = cnv.getContext('2d', { willReadFrequently: true })!;
  const cx = (ra.x + rb.x) / 2;
  const cy = (ra.y + rb.y) / 2;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(-theta);
  ctx.translate(-cx, -cy);
  ctx.drawImage(page, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  dropLineArt(ctx, cw, ch);

  const raw = await recognize(cnv, DIMENSION_CHARS);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // crop px → raster px: src = C + R(θ)·(dest − crop centre)
  const toRaster = (dx: number, dy: number): Pt => ({
    x: cx + cos * (dx - cw / 2) - sin * (dy - ch / 2),
    y: cy + sin * (dx - cw / 2) + cos * (dy - ch / 2),
  });

  const words: OcrWord[] = [];
  for (const w of raw) {
    const text = w.text.trim();
    const bb = w.bbox;
    if (!text || !bb) continue;
    const p0 = toRaster(bb.x0, bb.y0);
    const p1 = toRaster(bb.x1, bb.y1);
    const q0 = raster.toPdf(p0.x, p0.y);
    const q1 = raster.toPdf(p1.x, p1.y);
    words.push({
      text,
      conf: w.conf,
      xPt: (q0.x + q1.x) / 2,
      yPt: (q0.y + q1.y) / 2,
      wPt: Math.abs(q1.x - q0.x),
      hPt: Math.abs(q1.y - q0.y),
    });
  }
  return words;
}
