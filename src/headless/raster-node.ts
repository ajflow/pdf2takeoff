// Node raster adapter: pdf.js page → skia canvas (@napi-rs/canvas) → the
// engine's RasterPage / RGBA types. Same render parameters as the browser
// adapter, so both environments see equivalent pixels (see the H2 golden
// raster check in specs/headless-engine.md).

import { createCanvas } from '@napi-rs/canvas';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RasterPage } from '../engine/ports.ts';
import type { RGBA } from '../engine/compare.ts';
import type { Pt } from '../engine/types.ts';

// The Path2D / ImageData / DOMMatrix globals pdf.js draws through are set to
// our @napi-rs/canvas classes in pdfjs-node.ts (which every render path
// imports first, and which also hands pdf.js a canvas factory from our copy).

function pageTransforms(vp: { convertToPdfPoint: (x: number, y: number) => number[]; convertToViewportPoint: (x: number, y: number) => number[] }) {
  return {
    toPdf: (x: number, y: number): Pt => {
      const [px, py] = vp.convertToPdfPoint(x, y);
      return { x: px, y: py };
    },
    toRaster: (x: number, y: number): Pt => {
      const [vx, vy] = vp.convertToViewportPoint(x, y);
      return { x: vx, y: vy };
    },
  };
}

/** Render a page at an integer scale — the Node twin of app/raster.ts. */
export async function renderRasterNode(
  doc: PDFDocumentProxy,
  pageNum: number,
  scale: number,
): Promise<RasterPage> {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale });
  const w = Math.max(1, Math.floor(vp.width));
  const h = Math.max(1, Math.floor(vp.height));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  // skia's 2D context implements the same surface pdf.js drives in the
  // browser; the canvas param is deliberately omitted (pdf.js v5 takes a
  // bitmap-transfer path with it that crashes native canvas)
  await page.render({ canvasContext: ctx, viewport: vp } as never).promise;
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data, ...pageTransforms(vp) };
}

/**
 * Rasterize a page stretched onto an exact target box (the compare path:
 * revision B is scaled to cover, then drawn onto A's page size).
 */
export async function rasterizeToNode(
  doc: PDFDocumentProxy,
  pageNum: number,
  targetW: number,
  targetH: number,
): Promise<RGBA> {
  const page = await doc.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.max(targetW / vp1.width, targetH / vp1.height);
  const vp = page.getViewport({ scale });
  const tmp = createCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
  await page.render({ canvasContext: tmp.getContext('2d'), viewport: vp } as never).promise;

  const cnv = createCanvas(Math.max(1, Math.round(targetW)), Math.max(1, Math.round(targetH)));
  const ctx = cnv.getContext('2d');
  ctx.drawImage(tmp, 0, 0, cnv.width, cnv.height);
  const img = ctx.getImageData(0, 0, cnv.width, cnv.height);
  return { width: cnv.width, height: cnv.height, data: img.data };
}
