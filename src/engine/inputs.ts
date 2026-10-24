// Input files: recognise a drawing file by its bytes, and turn images (alone,
// several, or mixed with PDFs) into one PDF the rest of the engine opens
// unchanged.
//
// An image page uses the headless raster convention (image-node.ts): a W x H
// px image is a page of W/RASTER_SCALE x H/RASTER_SCALE points, drawn edge to
// edge, so the RASTER_SCALE render is the native pixels and a point means the
// same thing in the browser, the CLI and MCP. That page size is not the
// paper size, so the PDF carries a small info entry (PAPER_KEY) naming
// its image pages and each one's scan resolution when the file states a
// believable one: a printed ratio like 1:100 converts through it, and a page
// without one is calibrated from a dimension instead (paperFactor).
//
// The output is deterministic (no dates, no producer), so the same image
// always gives the same bytes: sessions and live channels key on a file hash.

import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { RASTER_SCALE } from './ports.ts';

export type InputKind =
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'bmp'
  | 'avif'
  | 'svg'
  | 'tiff'
  | 'heic'
  | 'dxf'
  | 'dwg'
  | 'unknown';

/** Raster and vector image kinds that become one page each. */
export const IMAGE_KINDS: ReadonlySet<InputKind> = new Set(['png', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'tiff', 'heic']);

/** Everything buildDocument can turn into pages. */
export const OPENABLE_KINDS: ReadonlySet<InputKind> = new Set(['pdf', 'dxf', ...IMAGE_KINDS]);

export const MIME_BY_KIND: Readonly<Partial<Record<InputKind, string>>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  heic: 'image/heic',
};

/** Every extension the file pickers offer (the bytes decide, not the name). */
export const INPUT_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg', '.tif', '.tiff', '.heic', '.heif', '.dxf', '.dwg'];

const EXT_KIND: Record<string, InputKind> = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jfif: 'jpeg',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp',
  dib: 'bmp',
  avif: 'avif',
  svg: 'svg',
  tif: 'tiff',
  tiff: 'tiff',
  heic: 'heic',
  heif: 'heic',
  dxf: 'dxf',
  dwg: 'dwg',
};

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < Math.min(b.length, start + len); i++) s += String.fromCharCode(b[i]);
  return s;
}

/** The kind of an input file, by magic bytes first and the file name's extension second. */
export function sniffInput(bytes: Uint8Array, name = ''): InputKind {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  const gif = ascii(b, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*') return 'tiff';
  // BMP: "BM" alone is weak, so the DIB header size has to be a real one too
  if (b.length >= 18 && b[0] === 0x42 && b[1] === 0x4d && [12, 40, 52, 56, 64, 108, 124].includes(b[14] | (b[15] << 8))) return 'bmp';
  // ISO media (AVIF / HEIC): "ftyp" box, then the major and compatible brands
  if (ascii(b, 4, 4) === 'ftyp') {
    const size = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 || 32);
    const brands: string[] = [ascii(b, 8, 4)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(b, i, 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return 'avif';
    if (brands.some((x) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(x))) return 'heic';
  }
  if (/^AC10\d\d/.test(ascii(b, 0, 6))) return 'dwg';
  if (ascii(b, 0, 18) === 'AutoCAD Binary DXF') return 'dxf';
  // text formats: look past a BOM, whitespace, an XML declaration and comments
  const head = ascii(b, 0, 2048).replace(/^﻿|^\xEF\xBB\xBF/, '');
  if (head.includes('%PDF-')) return 'pdf'; // the header may follow some junk bytes
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'svg';
  if (/^\s*0\s*\r?\n\s*SECTION\s*\r?\n/.test(head) || /^\s*999\s*\r?\n/.test(head)) return 'dxf';
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && EXT_KIND[ext]) || 'unknown';
}

/** What to tell someone whose file can't be opened (en-AU, plain). */
export function unsupportedMessage(kind: InputKind, name: string): string {
  const file = name || 'This file';
  switch (kind) {
    case 'dwg':
      return `${file} is a DWG, which the browser can't read. In your CAD app, export the sheet as a PDF (or DXF) and open that.`;
    case 'dxf':
      return `${file} is a binary DXF. Save it as an ASCII DXF (or plot it to PDF) from your CAD app and open that.`;
    case 'heic':
      return `${file} is a HEIC photo that couldn't be decoded. Export it as a JPEG and open that.`;
    default:
      return `${file} isn't a drawing pdf2takeoff can open. It opens PDFs, DXF drawings and images (PNG, JPEG, HEIC, TIFF, WebP, GIF, BMP, AVIF, SVG); print or export the file to PDF first.`;
  }
}

// --- scan resolution -------------------------------------------------------

/**
 * A stated resolution worth trusting as a paper size: scanners write 150 to
 * 1,200 dpi; 72 and 96 are software defaults and 144 is a Retina screenshot,
 * none of which says anything about paper. Anything else gives 0 (unknown).
 */
export function plausibleDpi(dpi: number): number {
  if (!Number.isFinite(dpi)) return 0;
  const d = Math.round(dpi);
  return d >= 150 && d <= 2400 && d !== 144 ? d : 0;
}

/** PNG pHYs resolution in dpi, or 0. */
function pngDpi(b: Uint8Array): number {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = ascii(b, i + 4, 4);
    if (type === 'pHYs' && len >= 9) {
      const d = i + 8;
      const ppx = ((b[d] << 24) | (b[d + 1] << 16) | (b[d + 2] << 8) | b[d + 3]) >>> 0;
      return b[d + 8] === 1 ? ppx * 0.0254 : 0; // unit 1 = metre
    }
    if (type === 'IDAT' || type === 'IEND') return 0; // pHYs comes before the image data
    i += 12 + len;
  }
  return 0;
}

interface JpegInfo {
  dpi: number;
  orientation: number;
}

/** JPEG resolution (EXIF, else JFIF) and EXIF orientation (1 = upright). */
function jpegInfo(b: Uint8Array): JpegInfo {
  let jfif = 0;
  let exif = 0;
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xda || marker === 0xd9) break; // start of scan: no more headers
    const len = (b[i + 2] << 8) | b[i + 3];
    const s = i + 4;
    if (marker === 0xe0 && ascii(b, s, 5) === 'JFIF\0') {
      const units = b[s + 7];
      const x = (b[s + 8] << 8) | b[s + 9];
      jfif = units === 1 ? x : units === 2 ? x * 2.54 : 0;
    } else if (marker === 0xe1 && ascii(b, s, 6) === 'Exif\0\0') {
      const t = s + 6;
      const le = ascii(b, t, 2) === 'II';
      const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
      const ifd = t + u32(t + 4);
      const n = ifd + 2 <= b.length ? u16(ifd) : 0;
      let xres = 0;
      let unit = 2;
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > b.length) break;
        const tag = u16(e);
        if (tag === 0x0112) orientation = u16(e + 8);
        else if (tag === 0x0128) unit = u16(e + 8);
        else if (tag === 0x011a) {
          const at = t + u32(e + 8);
          const den = at + 8 <= b.length ? u32(at + 4) : 0;
          xres = den ? u32(at) / den : 0;
        }
      }
      exif = unit === 2 ? xres : unit === 3 ? xres * 2.54 : 0;
    }
    i += 2 + len;
  }
  return { dpi: plausibleDpi(exif) || plausibleDpi(jfif), orientation: orientation >= 1 && orientation <= 8 ? orientation : 1 };
}

/** The believable scan resolution an image states, or 0. */
export function imageDpi(bytes: Uint8Array, kind: InputKind): number {
  if (kind === 'png') return plausibleDpi(pngDpi(bytes));
  if (kind === 'jpeg') return jpegInfo(bytes).dpi;
  return 0;
}

// --- building one PDF -------------------------------------------------

export interface InputFile {
  bytes: Uint8Array;
  name: string;
  kind?: InputKind;
}

/**
 * Decode an image the PDF writer can't embed as it is (WebP, GIF, SVG, a
 * rotated JPEG and so on) to PNG bytes, upright. `scale` is output pixels
 * per source pixel (below 1 when the platform had to shrink a huge image).
 * Supplied by the platform: a canvas in the browser, @napi-rs/canvas in
 * Node. Throws when the platform can't read the format.
 */
export type ImageTranscoder = (bytes: Uint8Array, kind: InputKind) => Promise<{ png: Uint8Array; scale: number }>;

export interface BuiltDocument {
  bytes: Uint8Array;
  pageCount: number;
  /** 1-based page number to stated dpi (0 = unknown) for every image page. */
  imagePages: Map<number, number>;
  /** 1-based page number to the drawing scale every DXF page was laid out at. */
  scales: Map<number, DrawingScale>;
  /** Images the platform had to shrink to decode, with the scale used. */
  shrunk: { name: string; scale: number }[];
}

/** Info-dictionary key naming a file's image pages and their resolutions. */
export const PAPER_KEY = 'Pdf2takeoffImagePages';

/**
 * One PDF from the files, in the order given: a PDF's pages are copied, each
 * image becomes one page. A single PDF comes back byte for byte.
 */
export async function buildDocument(files: InputFile[], transcode: ImageTranscoder): Promise<BuiltDocument> {
  const kinds = files.map((f) => f.kind ?? sniffInput(f.bytes, f.name));
  if (files.length === 1 && kinds[0] === 'pdf') {
    return { bytes: files[0].bytes, pageCount: 0, imagePages: new Map(), scales: new Map(), shrunk: [] };
  }
  const out = await PDFDocument.create({ updateMetadata: false });
  const imagePages = new Map<number, number>();
  const scales: BuiltDocument['scales'] = new Map();
  const fontCache = {};
  const shrunk: BuiltDocument['shrunk'] = [];
  for (let f = 0; f < files.length; f++) {
    const { bytes, name } = files[f];
    const kind = kinds[f];
    if (kind === 'pdf') {
      const src = await PDFDocument.load(bytes, { updateMetadata: false });
      for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      continue;
    }
    if (kind === 'dxf') {
      // a vector page at a standard scale, which the PDF then carries
      if (ascii(bytes, 0, 18) === 'AutoCAD Binary DXF') throw new Error(unsupportedMessage('dxf', name));
      const { addDxfPage, dxfText } = await import('./dxf.ts');
      scales.set(out.getPageCount() + 1, await addDxfPage(out, dxfText(bytes), fontCache));
      continue;
    }
    if (!IMAGE_KINDS.has(kind)) throw new Error(unsupportedMessage(kind, name));
    if (kind === 'tiff') {
      // its own reader: Group 4 scans pass through, the rest are decoded; a page per IFD
      const { addTiffPages } = await import('./tiff.ts');
      const start = out.getPageCount();
      addTiffPages(out, bytes).forEach((d, i) => imagePages.set(start + i + 1, d));
      continue;
    }
    // HEIC: the platform if it can (Safari), else libheif (Chrome, Windows, Node)
    let heic: { png: Uint8Array; scale: number } | null = null;
    if (kind === 'heic') {
      heic = await transcode(bytes, kind).catch(() => null);
      if (!heic) {
        const { addHeicPage } = await import('./heic.ts');
        await addHeicPage(out, bytes);
        imagePages.set(out.getPageCount(), 0);
        continue;
      }
    }
    let dpi = imageDpi(bytes, kind);
    // PNG and upright JPEG embed as they are (no re-encode, no quality loss);
    // everything else, and anything pdf-lib refuses, goes through the platform
    let image = null;
    if (kind === 'png' || (kind === 'jpeg' && jpegInfo(bytes).orientation === 1)) {
      try {
        image = kind === 'png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      } catch {
        image = null;
      }
    }
    if (!image) {
      const { png, scale } = heic ?? (await transcode(bytes, kind));
      if (scale < 1) shrunk.push({ name, scale });
      dpi = dpi ? plausibleDpi(dpi * scale) : 0;
      image = await out.embedPng(png);
    }
    const w = image.width / RASTER_SCALE;
    const h = image.height / RASTER_SCALE;
    out.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
    imagePages.set(out.getPageCount(), dpi);
  }
  if (scales.size) (await import('./dxf.ts')).writeScales(out, scales);
  if (imagePages.size) {
    const entry = Object.fromEntries([...imagePages].map(([p, d]) => [String(p), d]));
    // (PDFDocument.getInfoDict is private; this is what it does)
    const existing = out.context.lookup(out.context.trailerInfo.Info);
    const info = existing instanceof PDFDict ? existing : out.context.obj({});
    if (!(existing instanceof PDFDict)) out.context.trailerInfo.Info = out.context.register(info);
    info.set(PDFName.of(PAPER_KEY), PDFString.of(JSON.stringify(entry)));
  }
  return { bytes: await out.save(), pageCount: out.getPageCount(), imagePages, scales, shrunk };
}

/** Info-dictionary key: per page, the drawing scale a DXF was laid out at. */
export const SCALE_KEY = 'Pdf2takeoffDrawingScale';

export interface DrawingScale {
  /** The page is the drawing at 1:ratio. */
  ratio: number;
  /** The unit the drawing was in, as written ('mm', 'm', 'in', 'ft', ...). */
  unit: string;
  /** True when the file did not say and the unit was inferred from its size. */
  assumed: boolean;
}

/** Parse SCALE_KEY (as pdf.js reports it) back into page -> scale. */
export function parseScales(value: unknown): Map<number, DrawingScale> {
  const out = new Map<number, DrawingScale>();
  if (typeof value !== 'string') return out;
  try {
    for (const [k, v] of Object.entries(JSON.parse(value) as Record<string, DrawingScale>)) {
      const page = Number(k);
      if (Number.isInteger(page) && page > 0 && v && v.ratio > 0) out.set(page, { ratio: v.ratio, unit: String(v.unit), assumed: !!v.assumed });
    }
  } catch {
    /* not ours */
  }
  return out;
}

/** Parse the PAPER_KEY entry (as pdf.js reports it) back into page -> dpi. */
export function parseImagePages(value: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (typeof value !== 'string') return out;
  try {
    const obj = JSON.parse(value) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const page = Number(k);
      if (Number.isInteger(page) && page > 0 && typeof v === 'number') out.set(page, plausibleDpi(v));
    }
  } catch {
    /* not ours */
  }
  return out;
}

/**
 * Paper points per page point on one page: 1 on a PDF page, RASTER_SCALE x
 * 72 / dpi on an image page with a stated resolution, null when the paper
 * size is unknown (an image without one: calibrate from a dimension).
 */
export function paperFactor(imagePages: ReadonlyMap<number, number>, page: number): number | null {
  if (!imagePages.has(page)) return 1;
  const dpi = imagePages.get(page)!;
  return dpi ? (RASTER_SCALE * 72) / dpi : null;
}
