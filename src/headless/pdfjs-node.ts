// pdf.js document loading for Node (the legacy build runs on the main
// thread with no worker). Mirrors the browser's viewer.ts loading options.

// @ts-ignore -- pdfjs-dist's legacy build ships without type declarations
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// pdf.js's own NodeCanvasFactory requires "@napi-rs/canvas" relative to
// pdfjs-dist, which resolves to the copy nested under node_modules/pdfjs-dist
// (0.1.x), not to ours (1.x). Every image on a page is first drawn into a
// temporary canvas from that factory and then drawImage'd into the page
// context, which comes from our copy: an object from one skia binary handed
// to another, a segfault on the first sheet with a logo. One canvas module
// for everything: this factory builds pdf.js's temporary canvases from ours.
class OurCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(pair: { canvas: { width: number; height: number } }, width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    pair.canvas.width = width;
    pair.canvas.height = height;
  }
  destroy(pair: { canvas: { width: number; height: number } | null; context: unknown }) {
    if (!pair.canvas) return;
    pair.canvas.width = 0;
    pair.canvas.height = 0;
    pair.canvas = null;
    pair.context = null;
  }
}
// pdf.js's legacy build publishes Path2D, ImageData and DOMMatrix from that
// nested copy on import (and before that, its own JS Path2D polyfill, which
// skia's ctx.fill(path) cannot take). Assign ours UNCONDITIONALLY, after the
// import above has run: whichever order modules load in, napi's classes from
// our copy must win, or pdf.js renders through foreign objects and segfaults.
// Every render path imports this module first, so this is the one place.
const g = globalThis as unknown as Record<string, unknown>;
g.Path2D = Path2D;
g.ImageData = ImageData;
g.DOMMatrix = DOMMatrix;

// Standard-14 font data for PDFs that reference Helvetica & co. without
// embedding them (the bundled samples do). pdf.js's Node font loader needs a
// file:// URL — a bare filesystem path silently misses and segfaults later
// inside the glyph fallback.
function standardFontsUrl(): string | undefined {
  try {
    const pkg = require.resolve('pdfjs-dist/package.json');
    return pathToFileURL(join(dirname(pkg), 'standard_fonts') + '/').href;
  } catch {
    try {
      const main = require.resolve('pdfjs-dist');
      return pathToFileURL(join(dirname(main), '..', 'standard_fonts') + '/').href;
    } catch {
      return undefined;
    }
  }
}

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({
    data: data.slice(),
    verbosity: 0,
    standardFontDataUrl: standardFontsUrl(),
    CanvasFactory: OurCanvasFactory,
  }).promise;
}
