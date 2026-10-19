// Raster-side helpers for the reference solver: an RGBA page from a scanned
// (image-only) PDF, 90-degree turns to bring a sideways scan upright, a
// RasterPage (engine port) over an upright RGBA buffer, an ink mask and the
// run-length wall finders the solver uses where there is no vector layer.
//
// Two ways to get the pixels of an image PDF:
//   engine  renderRasterNode (pdf.js + @napi-rs/canvas), the product path;
//   decode  the embedded JPEG/PNG decoded with @napi-rs/canvas directly, the
//           fallback while the engine path segfaults on image XObjects (WP1).
// Both give the same RGBA layout at RASTER_SCALE px per PDF point.

import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { RASTER_SCALE } from '../../src/engine/ports.ts';
import { openPdf } from '../../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../../src/headless/raster-node.ts';

/** RGBA of page 1 at RASTER_SCALE through the engine's Node raster adapter. */
export async function pageRgbaEngine(bytes) {
  const pdf = await openPdf(bytes);
  const r = await renderRasterNode(pdf, 1, RASTER_SCALE);
  return { width: r.width, height: r.height, data: r.data, source: 'engine' };
}

/** RGBA of page 1 at RASTER_SCALE by decoding the page's embedded image directly. */
export async function pageRgbaDecode(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(0);
  const { width: wPt, height: hPt } = page.getSize();
  let imageBytes = null;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      imageBytes = obj.contents;
      break;
    }
  }
  if (!imageBytes) throw new Error('no image XObject in the PDF');
  const img = await loadImage(Buffer.from(imageBytes));
  const w = Math.max(1, Math.floor(wPt * RASTER_SCALE));
  const h = Math.max(1, Math.floor(hPt * RASTER_SCALE));
  const cnv = createCanvas(w, h);
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data, source: 'decode' };
}

/** Rotate an RGBA buffer by `turns` quarter turns clockwise. */
export function turnRgba(r, turns) {
  turns = ((turns % 4) + 4) % 4;
  if (turns === 0) return r;
  const { width: w, height: h, data } = r;
  const out = turns === 2 ? new Uint8ClampedArray(data.length) : new Uint8ClampedArray(data.length);
  const nw = turns === 2 ? w : h;
  const nh = turns === 2 ? h : w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx;
      let ny;
      if (turns === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      const s = (y * w + x) * 4;
      const d = (ny * nw + nx) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width: nw, height: nh, data: out, source: r.source };
}

/** The engine's RasterPage port over an upright RGBA buffer at `scale` px per point. */
export function rasterPageOf(r, scale = RASTER_SCALE) {
  const hPt = r.height / scale;
  return {
    width: r.width,
    height: r.height,
    data: r.data,
    scale,
    widthPt: r.width / scale,
    heightPt: hPt,
    toPdf: (x, y) => ({ x: x / scale, y: hPt - y / scale }),
    toRaster: (x, y) => ({ x: x * scale, y: (hPt - y) * scale }),
  };
}

/** PNG bytes of an RGBA buffer, optionally resampled to `factor` of its size (for OCR). */
export function rgbaToPng(r, factor = 1) {
  const src = createCanvas(r.width, r.height);
  const sctx = src.getContext('2d');
  const img = sctx.createImageData(r.width, r.height);
  img.data.set(r.data);
  sctx.putImageData(img, 0, 0);
  if (factor === 1) return src.toBuffer('image/png');
  const w = Math.max(1, Math.round(r.width * factor));
  const h = Math.max(1, Math.round(r.height * factor));
  const dst = createCanvas(w, h);
  const dctx = dst.getContext('2d');
  dctx.drawImage(src, 0, 0, w, h);
  return dst.toBuffer('image/png');
}

/** 1 where the pixel is ink (luma below 150, the engine's threshold). */
export function inkMask(r) {
  const n = r.width * r.height;
  const ink = new Uint8Array(n);
  const d = r.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) ink[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 < 150 ? 1 : 0;
  return ink;
}

/**
 * Longest ink run per row (and per column): [length, start] arrays. Walls
 * read as bands of consecutive rows (or columns) whose longest run is long.
 * Gaps of up to `maxGap` px (white specks on a scanned wall, about 2 pt
 * once a 150 dpi speck is upsampled) do not end a run, as they would not
 * stop an estimator clicking the wall's two ends.
 */
export function longestRuns(ink, w, h, maxGap = 6) {
  const scan = (n, m, at) => {
    const len = new Int32Array(n);
    const start = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestStart = 0;
      let j = 0;
      while (j < m) {
        if (!ink[at(i, j)]) {
          j++;
          continue;
        }
        const a = j;
        let last = j;
        let gap = 0;
        while (j < m) {
          if (ink[at(i, j)]) {
            last = j;
            gap = 0;
          } else if (++gap > maxGap) break;
          j++;
        }
        if (last - a + 1 > best) {
          best = last - a + 1;
          bestStart = a;
        }
      }
      len[i] = best;
      start[i] = bestStart;
    }
    return { len, start };
  };
  const rows = scan(h, w, (y, x) => y * w + x);
  const cols = scan(w, h, (x, y) => y * w + x);
  return { rowLen: rows.len, rowStart: rows.start, colLen: cols.len, colStart: cols.start };
}

/**
 * Bands of consecutive indices whose run is at least minLen, at least
 * minThick wide, away from the page edges. Returns [{a, b, len, start}].
 */
export function bands(lenArr, startArr, minLen, minThick, margin) {
  const out = [];
  let i = margin;
  const n = lenArr.length - margin;
  while (i < n) {
    if (lenArr[i] < minLen) {
      i++;
      continue;
    }
    const a = i;
    let len = 0;
    let start = 0;
    while (i < n && lenArr[i] >= minLen) {
      if (lenArr[i] > len) {
        len = lenArr[i];
        start = startArr[i];
      }
      i++;
    }
    if (i - a >= minThick) out.push({ a, b: i, len, start });
  }
  return out;
}

/** Walk the ink along a column (dx=0) or row from (x,y) in direction (dx,dy), bridging gaps up to maxGap px; returns the last ink coordinate reached. */
export function followInk(ink, w, h, x, y, dx, dy, maxGap) {
  let last = { x, y };
  let gap = 0;
  let cx = x;
  let cy = y;
  for (;;) {
    cx += dx;
    cy += dy;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) break;
    if (ink[cy * w + cx]) {
      gap = 0;
      last = { x: cx, y: cy };
    } else if (++gap > maxGap) break;
  }
  return last;
}
