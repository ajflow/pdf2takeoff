// pdf.js document loading for Node (the legacy build runs on the main
// thread with no worker). Mirrors the browser's viewer.ts loading options.

// @ts-ignore -- pdfjs-dist's legacy build ships without type declarations
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createCanvas } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

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

/**
 * Canvas factory backed by OUR @napi-rs/canvas. pdfjs-dist pins its own,
 * older @napi-rs/canvas (0.1.x, nested under node_modules/pdfjs-dist), and
 * its built-in NodeCanvasFactory requires that copy, so two skia binaries
 * end up loaded in one process. Image XObjects are the only thing drawn via
 * a factory-made temporary canvas; handing that foreign CanvasElement to
 * drawImage() on a canvas from the top-level copy makes native code unwrap
 * an object of a class it does not know and segfault (exit 139, silent).
 * Vector pages never create a temporary canvas, which is why only image
 * pages crashed. Creating every canvas here keeps one native instance.
 */
class SameInstanceCanvasFactory {
  constructor(_opts?: { enableHWA?: boolean }) {}
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(entry: { canvas: ReturnType<typeof createCanvas> | null }, width: number, height: number) {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }
  destroy(entry: { canvas: ReturnType<typeof createCanvas> | null; context: unknown }) {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    entry.canvas.width = entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }
}

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({
    data: data.slice(),
    verbosity: 0,
    standardFontDataUrl: standardFontsUrl(),
    CanvasFactory: SameInstanceCanvasFactory,
  }).promise;
}
