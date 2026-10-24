// TIFF pages into a PDF. Black-and-white fax scans (CCITT Group 4, how most
// plan sets are scanned) pass straight through as CCITTFaxDecode image
// streams, one per strip: nothing is decoded here and an A0 scan stays a few
// hundred kilobytes. Every other TIFF (LZW, Deflate, PackBits, JPEG, G3,
// tiles, colour, grey) is decoded with UTIF and embedded as Flate-compressed
// grey or RGB pixels. Each page of a multi-page TIFF becomes a page (reduced
// resolution sub-files are skipped). Loaded only when a TIFF is opened.

/// <reference path="./utif.d.ts" />
import UTIF from 'utif';
import type { PDFDocument } from 'pdf-lib';
import { RASTER_SCALE } from './ports.ts';
import { plausibleDpi } from './inputs.ts';
import { drawRows, pixelImage } from './pixels.ts';

type Ifd = Record<string, number[] | undefined> & { subIFD?: Ifd[] };

const first = (ifd: Ifd, tag: number, fallback: number): number => ifd[`t${tag}`]?.[0] ?? fallback;

/** Stated resolution in dpi (XResolution + ResolutionUnit), 0 when unknown or not believable. */
function dpiOf(ifd: Ifd): number {
  const x = first(ifd, 282, 0);
  const unit = first(ifd, 296, 2);
  return plausibleDpi(unit === 3 ? x * 2.54 : unit === 2 ? x : 0);
}

/** A strip-organised bilevel Group 4 page with the usual bit order: it can go in as it is. */
function passesThrough(ifd: Ifd): boolean {
  return (
    first(ifd, 259, 1) === 4 && // compression: CCITT T.6
    first(ifd, 258, 1) === 1 && // 1 bit per sample
    first(ifd, 277, 1) === 1 && // one sample per pixel
    first(ifd, 266, 1) === 1 && // most significant bit first
    first(ifd, 262, 0) <= 1 && // white is zero, or black is zero
    !!ifd.t273?.length &&
    ifd.t273.length === ifd.t279?.length // strips, not tiles
  );
}

/**
 * Append every page of the TIFF to `out` at the raster convention (W x H px
 * = W/RASTER_SCALE x H/RASTER_SCALE pt). Returns each new page's stated dpi
 * (0 = unknown) in order.
 */
export function addTiffPages(out: PDFDocument, bytes: Uint8Array): number[] {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const ifds = (UTIF.decode(buffer) as Ifd[]).filter((ifd) => !(first(ifd, 254, 0) & 1) && first(ifd, 256, 0) > 0);
  if (!ifds.length) throw new Error('this TIFF has no pages');
  const dpis: number[] = [];
  for (const ifd of ifds) {
    const w = first(ifd, 256, 0);
    const h = first(ifd, 257, 0);
    const page = out.addPage([w / RASTER_SCALE, h / RASTER_SCALE]);
    const draw = (stream: ReturnType<PDFDocument['context']['stream']>, top: number, rows: number) => drawRows(out, page, stream, top, rows);
    if (passesThrough(ifd)) {
      const perStrip = first(ifd, 278, h);
      ifd.t273!.forEach((offset, i) => {
        const top = i * perStrip;
        const rows = Math.min(perStrip, h - top);
        if (rows <= 0) return;
        const data = bytes.subarray(offset, offset + ifd.t279![i]);
        // fax codes are white and black runs whatever the photometric tag says,
        // so the decoded black runs are black: BlackIs1 true either way (as
        // libtiff's tiff2pdf writes it)
        const stream = out.context.stream(data, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: w,
          Height: rows,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 1,
          Filter: 'CCITTFaxDecode',
          DecodeParms: { K: -1, Columns: w, Rows: rows, BlackIs1: true },
        });
        draw(stream, top, rows);
      });
    } else {
      UTIF.decodeImage(buffer, ifd);
      draw(pixelImage(out, UTIF.toRGBA8(ifd), w, h), 0, h);
    }
    dpis.push(dpiOf(ifd));
  }
  return dpis;
}
