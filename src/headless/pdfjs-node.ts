// pdf.js document loading for Node (the legacy build runs on the main
// thread with no worker). Mirrors the browser's viewer.ts loading options.

// @ts-ignore -- pdfjs-dist's legacy build ships without type declarations
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
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

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({
    data: data.slice(),
    verbosity: 0,
    standardFontDataUrl: standardFontsUrl(),
  }).promise;
}
