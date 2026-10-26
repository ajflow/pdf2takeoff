// Browser raster adapter: renders a page off-screen at an integer scale via
// pdf.js and returns it as the engine's RasterPage (pixels + coordinate
// transforms). Shared by both scan tiers so they always see identical pixels.

import type { PDFPageProxy } from 'pdfjs-dist';
import { getPdfDoc, type LayerConfig } from './viewer';
import type { RasterPage } from '../engine/ports';

export async function renderRaster(pageNum: number, scale: number, layers?: LayerConfig): Promise<RasterPage> {
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
  await page.render({ canvas, canvasContext: ctx, viewport: vp, ...(layers ? { optionalContentConfigPromise: Promise.resolve(layers) } : {}) }).promise;
  const img = ctx.getImageData(0, 0, w, h);
  return {
    width: w,
    height: h,
    data: img.data,
    toPdf: (x, y) => {
      const [px, py] = vp.convertToPdfPoint(x, y);
      return { x: px, y: py };
    },
    toRaster: (x, y) => {
      const [vx, vy] = vp.convertToViewportPoint(x, y);
      return { x: vx, y: vy };
    },
  };
}
