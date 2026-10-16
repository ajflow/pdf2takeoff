// Browser OCR adapter: lazily loads tesseract.js (WASM) on first use, reads
// the current page, and maps recognized words into PDF-point space for the
// engine's calibration heuristics. The first run fetches the language pack
// from a CDN (~4 MB, then cached) — everything after that is local.

import { renderRaster } from './raster';
import type { OcrWord } from '../engine/ocr';

let workerPromise: Promise<import('tesseract.js').Worker> | null = null;

async function getWorker() {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    return createWorker('eng');
  })();
  return workerPromise;
}

export async function ocrPage(pageNum: number): Promise<OcrWord[]> {
  const raster = await renderRaster(pageNum, 3);
  // the recognizer reads a canvas; rebuild one from the raster bytes
  const cnv = document.createElement('canvas');
  cnv.width = raster.width;
  cnv.height = raster.height;
  const ctx = cnv.getContext('2d')!;
  const img = ctx.createImageData(raster.width, raster.height);
  img.data.set(raster.data as Uint8ClampedArray);
  ctx.putImageData(img, 0, 0);

  const worker = await getWorker();
  const { data } = await worker.recognize(cnv, {}, { blocks: true, text: true });

  // v7 nests words under blocks -> paragraphs -> lines -> words
  const raw: { text: string; conf: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) raw.push({ text: w.text ?? '', conf: w.confidence ?? 0, bbox: w.bbox });
      }
    }
  }

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
