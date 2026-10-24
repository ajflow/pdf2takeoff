// Decoded pixels into a PDF page: RGBA composited onto white, kept as one
// grey channel when the image is grey, Flate-compressed into an image
// XObject drawn edge to edge at the raster convention (W x H px = W/3 x H/3
// pt). Shared by the TIFF and HEIC readers.

import { PDFDocument, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState, type PDFPage } from 'pdf-lib';
import { RASTER_SCALE } from './ports.ts';

/** An image XObject from RGBA pixels (alpha flattened onto white). */
export function pixelImage(out: PDFDocument, rgba: Uint8Array | Uint8ClampedArray, w: number, h: number) {
  let grey = true;
  for (let i = 0; i < rgba.length && grey; i += 4) grey = rgba[i] === rgba[i + 1] && rgba[i] === rgba[i + 2];
  const channels = grey ? 1 : 3;
  const px = new Uint8Array(w * h * channels);
  for (let i = 0, o = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    for (let c = 0; c < channels; c++) px[o++] = Math.round(rgba[i + c] * a + 255 * (1 - a));
  }
  return out.context.flateStream(px, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: w,
    Height: h,
    ColorSpace: grey ? 'DeviceGray' : 'DeviceRGB',
    BitsPerComponent: 8,
  });
}

/** Draw an image stream as rows [top, top + rows) of a page `w` px wide (all of it by default). */
export function drawRows(out: PDFDocument, page: PDFPage, stream: ReturnType<PDFDocument['context']['stream']>, top: number, rows: number): void {
  const name = page.node.newXObject('Im', out.context.register(stream));
  const wPt = page.getWidth();
  const hPt = page.getHeight();
  const hStrip = rows / RASTER_SCALE;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(wPt, 0, 0, hStrip, 0, hPt - top / RASTER_SCALE - hStrip), drawObject(name), popGraphicsState());
}

/** A page of the image's size, filled with its pixels. */
export function addPixelPage(out: PDFDocument, rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): PDFPage {
  const page = out.addPage([w / RASTER_SCALE, h / RASTER_SCALE]);
  drawRows(out, page, pixelImage(out, rgba, w, h), 0, h);
  return page;
}
