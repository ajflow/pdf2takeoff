// Direct raster input for the headless engine: a PNG or JPG opened as a
// one-page, document-like object that the PDF code paths (renderRasterNode,
// scanDocAt, dynamicFill, readMarkups, text reads) accept unchanged. Other
// images @napi-rs/canvas decodes (WebP, GIF, BMP, AVIF, SVG) are wrapped as a
// one-page PDF by the shared engine/inputs.ts and opened through pdf.js; the
// geometry is the same either way.
//
// Coordinate convention: the image's native pixels ARE the RASTER_SCALE
// render. A W x H px image presents as a page of W/RASTER_SCALE by
// H/RASTER_SCALE PDF points (RASTER_SCALE = 3 px per point), so a scan
// renders at scale 3 and sees the untouched pixels; toPdf/toRaster match the
// pdf.js viewport exactly, y flipped (PDF origin bottom-left). A click at
// native pixel (px, py) is therefore --at px/3,(H - py)/3, the same point the
// pdf-lib-wrapped PDF of that image would take.

import { createCanvas, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { RASTER_SCALE } from '../engine/ports.ts';
import { buildDocument, sniffInput, unsupportedMessage, type ImageTranscoder, type InputKind } from '../engine/inputs.ts';
import { openPdf } from './pdfjs-node.ts';

/** Image kinds @napi-rs/canvas decodes (TIFF and HEIC it does not). */
export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'avif' | 'svg';
const NODE_IMAGE_KINDS: ReadonlySet<InputKind> = new Set<InputKind>(['png', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg']);

/** A decodable image by magic bytes, else null. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const k = sniffInput(bytes);
  return NODE_IMAGE_KINDS.has(k) ? (k as ImageKind) : null;
}

/** A decodable image by file extension, else null. */
export function imageKindByExt(path: string): ImageKind | null {
  const k = sniffInput(new Uint8Array(0), path);
  return NODE_IMAGE_KINDS.has(k) ? (k as ImageKind) : null;
}

/** True when the file is a decodable image by extension or magic bytes (magic wins). */
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

/** SVGs are drawn so their long side has at least this many pixels (they have no native resolution). */
const SVG_LONG_SIDE = 4000;

/** Decode any image @napi-rs/canvas reads to PNG, on white (openImage draws on white too). */
export const nodeTranscoder: ImageTranscoder = async (bytes, kind) => {
  const img = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!img.width || !img.height) throw new Error('image has no pixels');
  const up = kind === 'svg' ? Math.max(1, SVG_LONG_SIDE / Math.max(img.width, img.height)) : 1;
  const w = Math.round(img.width * up);
  const h = Math.round(img.height * up);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { png: new Uint8Array(await canvas.encode('png')), scale: 1 };
};

/**
 * Wrap an image as a single-page PDF (page = pixels / RASTER_SCALE points,
 * image drawn edge to edge), so annotation writers have real PDF bytes to
 * add markups to. Same geometry as openImage, so points carry over.
 */
export async function imageToPdf(bytes: Uint8Array, kind?: ImageKind): Promise<Uint8Array> {
  const k = kind ?? sniffImage(bytes);
  if (!k) throw new Error('not an image pdf2takeoff can read');
  return (await buildDocument([{ bytes, name: '', kind: k }], nodeTranscoder)).bytes;
}

export interface OpenedDocument {
  doc: PDFDocumentProxy;
  /** PDF bytes: the file itself, or the image wrapped as a one-page PDF. */
  bytes: Uint8Array;
  kind: 'pdf' | 'image';
}

/** Open a PDF or an image file (by magic bytes, then extension). */
export async function openAny(path: string): Promise<OpenedDocument> {
  const raw = new Uint8Array(readFileSync(path));
  const kind = sniffInput(raw, path);
  // PNG and JPEG read their native pixels directly; the other images go
  // through their wrapped PDF, which has the same geometry by construction
  if (kind === 'png' || kind === 'jpeg') {
    return { doc: await openImage(raw), bytes: await imageToPdf(raw, kind), kind: 'image' };
  }
  if (NODE_IMAGE_KINDS.has(kind)) {
    const bytes = await imageToPdf(raw, kind as ImageKind);
    return { doc: await openPdf(bytes), bytes, kind: 'image' };
  }
  if (kind === 'pdf' || kind === 'unknown') return { doc: await openPdf(raw), bytes: raw, kind: 'pdf' };
  throw new Error(unsupportedMessage(kind, basename(path)));
}
