// Direct raster input for the headless engine: a PNG or JPG opened as a
// one-page, document-like object that the PDF code paths (renderRasterNode,
// scanDocAt, dynamicFill, readMarkups, text reads) accept unchanged.
//
// Coordinate convention: the image's native pixels ARE the RASTER_SCALE
// render. A W x H px image presents as a page of W/RASTER_SCALE by
// H/RASTER_SCALE PDF points (RASTER_SCALE = 3 px per point), so a scan
// renders at scale 3 and sees the untouched pixels; toPdf/toRaster match the
// pdf.js viewport exactly, y flipped (PDF origin bottom-left). A click at
// native pixel (px, py) is therefore --at px/3,(H - py)/3, the same point the
// pdf-lib-wrapped PDF of that image would take.

import { loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { RASTER_SCALE } from '../engine/ports.ts';
import { openPdf } from './pdfjs-node.ts';

export type ImageKind = 'png' | 'jpeg';

/** PNG / JPEG by magic bytes, else null. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

/** PNG / JPEG by file extension, else null. */
export function imageKindByExt(path: string): ImageKind | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  return null;
}

/** True when the file is PNG/JPEG by extension or magic bytes (magic wins). */
export function isImageFile(path: string, bytes: Uint8Array): boolean {
  return (sniffImage(bytes) ?? imageKindByExt(path)) !== null;
}

function imagePage(img: Image) {
  const wPt = img.width / RASTER_SCALE;
  const hPt = img.height / RASTER_SCALE;
  const getViewport = ({ scale = 1 }: { scale?: number } = {}) => {
    // W * scale / RASTER_SCALE is exact at scale === RASTER_SCALE (integers)
    const width = (img.width * scale) / RASTER_SCALE;
    const height = (img.height * scale) / RASTER_SCALE;
    return {
      width,
      height,
      scale,
      rotation: 0,
      transform: [scale, 0, 0, -scale, 0, height],
      convertToPdfPoint: (x: number, y: number) => [x / scale, hPt - y / scale],
      convertToViewportPoint: (x: number, y: number) => [x * scale, (hPt - y) * scale],
    };
  };
  return {
    pageNumber: 1,
    getViewport,
    /** Draw the image to fill the viewport (white under it, for alpha PNGs). */
    render: ({ canvasContext, viewport }: { canvasContext: SKRSContext2D; viewport: { width: number; height: number } }) => {
      const ctx = canvasContext;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, viewport.width, viewport.height);
      ctx.drawImage(img, 0, 0, viewport.width, viewport.height);
      ctx.restore();
      return { promise: Promise.resolve(), cancel() {} };
    },
    getAnnotations: async () => [] as unknown[],
    getTextContent: async () => ({ items: [] as unknown[], styles: {} }),
    getOperatorList: async () => ({ fnArray: [] as number[], argsArray: [] as unknown[] }),
    get view() {
      return [0, 0, wPt, hPt];
    },
  };
}

/**
 * Open PNG/JPEG bytes as a one-page document. The result is duck-typed to
 * PDFDocumentProxy: it implements the members the headless code uses
 * (numPages, getPage, getOptionalContentConfig, destroy) and the page
 * implements getViewport, render, getAnnotations (none), getTextContent
 * (no words), getOperatorList (no vectors, so scans take the CV tier).
 */
export async function openImage(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const img = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!img.width || !img.height) throw new Error('image has no pixels');
  const page = imagePage(img);
  const doc = {
    numPages: 1,
    getPage: async (n: number) => {
      if (n !== 1) throw new Error(`page ${n} out of range (an image is one page)`);
      return page;
    },
    getOptionalContentConfig: async () => ({ isVisible: () => true }),
    destroy: async () => {},
  };
  return doc as unknown as PDFDocumentProxy;
}

/**
 * Wrap an image as a single-page PDF (page = pixels / RASTER_SCALE points,
 * image drawn edge to edge), so annotation writers have real PDF bytes to
 * add markups to. Same geometry as openImage, so points carry over.
 */
export async function imageToPdf(bytes: Uint8Array, kind?: ImageKind): Promise<Uint8Array> {
  const k = kind ?? sniffImage(bytes);
  if (!k) throw new Error('not a PNG or JPEG');
  const pdf = await PDFDocument.create();
  const img = k === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  const w = img.width / RASTER_SCALE;
  const h = img.height / RASTER_SCALE;
  pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  return pdf.save();
}

export interface OpenedDocument {
  doc: PDFDocumentProxy;
  /** PDF bytes: the file itself, or the image wrapped as a one-page PDF. */
  bytes: Uint8Array;
  kind: 'pdf' | 'image';
}

/** Open a PDF, PNG or JPEG file (by magic bytes, then extension). */
export async function openAny(path: string): Promise<OpenedDocument> {
  const raw = new Uint8Array(readFileSync(path));
  const kind = sniffImage(raw) ?? imageKindByExt(path);
  if (kind) {
    return { doc: await openImage(raw), bytes: await imageToPdf(raw, kind), kind: 'image' };
  }
  return { doc: await openPdf(raw), bytes: raw, kind: 'pdf' };
}
