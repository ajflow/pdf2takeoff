// HEIC / HEIF photos (what an iPhone takes) where the platform can't decode
// them itself (Chrome, Firefox and Edge on Windows, Node): decoded with
// libheif (LGPL-3.0, the official Emscripten build via libheif-js, loaded
// only when such a photo is opened) and embedded as pixels. libheif applies
// the photo's rotation and mirroring, so the page comes out upright. Safari
// decodes HEIC natively, and the platform is always tried first.

/// <reference path="./libheif.d.ts" />
import type { PDFDocument } from 'pdf-lib';
import { addPixelPage } from './pixels.ts';

/** Append the photo's primary image as a page; throws when libheif can't read it. */
export async function addHeicPage(out: PDFDocument, bytes: Uint8Array): Promise<void> {
  const factory = (await import('libheif-js/libheif-wasm/libheif-bundle.mjs')).default;
  const images = new (factory().HeifDecoder)().decode(bytes);
  const image = images[0];
  if (!image) throw new Error('this HEIC file has no image in it');
  const w = image.get_width();
  const h = image.get_height();
  const decoded = await new Promise<Uint8ClampedArray>((resolve, reject) =>
    image.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (d) => (d ? resolve(d.data) : reject(new Error('this HEIC photo could not be decoded')))),
  );
  addPixelPage(out, decoded, w, h);
}
