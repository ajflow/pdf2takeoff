// Node OCR adapter: tesseract.js (WASM in a worker thread) reading a
// RasterPage into OcrWord[] in PDF points. The Node twin of app/ocr.ts: the
// same page and corridor reads, the corridor rotated so dimension text is
// upright and pruned of line work, words mapped back through the page's
// toPdf. Page reads can also be taken at extra rotations (vertical room
// labels, title blocks on portrait sheets) and merged.
//
// Language data is local: PDF2TAKEOFF_TESSDATA, else
// $XDG_CACHE_HOME/pdf2takeoff/tessdata (~/.cache/pdf2takeoff/tessdata). When
// eng.traineddata is missing there it is fetched once (about 3 MB) from the
// tessdata mirror the browser build also uses, then cached. That download is
// the only network access in the headless engine; the drawing never leaves
// the machine. Point PDF2TAKEOFF_TESSDATA at a folder holding
// eng.traineddata(.gz) for fully offline runs.

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { RasterPage } from '../engine/ports.ts';
import type { Pt } from '../engine/types.ts';
import { corridorAngles, pickCorridorReading, type OcrWord } from '../engine/ocr.ts';

type TessWorker = import('tesseract.js').Worker;

/** Mirror holding the tesseract.js 4.0.0 LSTM language packs (naptha/tessdata, gh-pages). */
export const TESSDATA_MIRROR = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_best_int';

/** Where language packs live: the env override, else the user cache. */
export function tessdataDir(): string {
  if (process.env.PDF2TAKEOFF_TESSDATA) return process.env.PDF2TAKEOFF_TESSDATA;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'pdf2takeoff', 'tessdata');
}

/**
 * Make sure `<lang>.traineddata` (or its .gz) is in the tessdata directory,
 * downloading it from the mirror when absent. Returns the directory and
 * whether the gzipped form is what is on disk.
 */
export async function ensureTessdata(lang = 'eng'): Promise<{ dir: string; gzip: boolean; downloaded: boolean }> {
  const dir = tessdataDir();
  if (existsSync(join(dir, `${lang}.traineddata`))) return { dir, gzip: false, downloaded: false };
  if (existsSync(join(dir, `${lang}.traineddata.gz`))) return { dir, gzip: true, downloaded: false };
  const url = `${TESSDATA_MIRROR}/${lang}.traineddata.gz`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch((err: unknown) => {
    throw new Error(`OCR language data missing in ${dir} and the download from ${url} failed (${err instanceof Error ? err.message : String(err)}). Set PDF2TAKEOFF_TESSDATA to a folder holding ${lang}.traineddata`);
  });
  if (!resp.ok) throw new Error(`OCR language data download failed: ${resp.status} ${url}. Set PDF2TAKEOFF_TESSDATA to a folder holding ${lang}.traineddata`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${lang}.traineddata.gz.part`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, join(dir, `${lang}.traineddata.gz`));
  return { dir, gzip: true, downloaded: true };
}

let workerPromise: Promise<TessWorker> | null = null;
let workerLangs = '';

async function getWorker(langs = 'eng'): Promise<TessWorker> {
  if (workerPromise && workerLangs !== langs) {
    await terminateOcr();
  }
  workerLangs = langs;
  workerPromise ??= (async () => {
    const { dir, gzip } = await ensureTessdata(langs.split('+')[0]);
    for (const extra of langs.split('+').slice(1)) await ensureTessdata(extra);
    const tess = (await import('tesseract.js')).default;
    // OEM 1 = LSTM only, the default core tesseract.js ships; no logger so stdout stays clean for MCP
    return tess.createWorker(langs, 1, { langPath: dir, cachePath: dir, gzip, logger: () => {} });
  })();
  return workerPromise;
}

/** Shut the recogniser's worker thread down (CLI commands call this before exiting). */
export async function terminateOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  if (p) await (await p).terminate().catch(() => {});
}

interface RawWord {
  text: string;
  conf: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Characters a printed dimension can contain (digits, separators, unit marks). */
const DIMENSION_CHARS = "0123456789.,'\"-xXmMcCnNiIfFtT";

/** Page segmentation: sparse text finds scattered labels on a drawing; a block suits a corridor strip. */
const PSM_SPARSE = '11';
const PSM_BLOCK = '6';

async function recognize(cnv: Canvas, psm: string, whitelist = '', langs = 'eng'): Promise<RawWord[]> {
  const worker = await getWorker(langs);
  // one shared worker: whitelist and segmentation mode are set per call
  await worker.setParameters({ tessedit_char_whitelist: whitelist, tessedit_pageseg_mode: psm as never });
  const { data } = await worker.recognize(cnv.toBuffer('image/png'), {}, { blocks: true, text: true });
  const raw: RawWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) raw.push({ text: w.text ?? '', conf: w.confidence ?? 0, bbox: w.bbox });
      }
    }
  }
  return raw;
}

/** A copy of the page with every pixel darker than `threshold` solid black and the rest white. */
function binarized(raster: RasterPage, threshold: number): RasterPage {
  const data = new Uint8ClampedArray(raster.data);
  for (let p = 0; p < data.length; p += 4) {
    const v = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000 < threshold ? 0 : 255;
    data[p] = data[p + 1] = data[p + 2] = v;
    data[p + 3] = 255;
  }
  return { ...raster, data };
}

function rasterToCanvas(raster: RasterPage): Canvas {
  const cnv = createCanvas(raster.width, raster.height);
  const ctx = cnv.getContext('2d');
  const img = ctx.createImageData(raster.width, raster.height);
  img.data.set(raster.data as Uint8ClampedArray);
  ctx.putImageData(img, 0, 0);
  return cnv;
}

/**
 * A window of the page, `cw` x `ch` raster px around `centre`, rotated by
 * -theta so content along angle theta reads upright, drawn at `factor`
 * times its size. Returns the crop and the map from crop px back to page
 * raster px (src = C + R(theta) * (dest / factor - crop centre)).
 */
function cropRotated(page: Canvas, centre: Pt, cw: number, ch: number, theta: number, factor: number): { cnv: Canvas; ctx: SKRSContext2D; toRaster: (dx: number, dy: number) => Pt } {
  const W = Math.max(1, Math.ceil(cw * factor));
  const H = Math.max(1, Math.ceil(ch * factor));
  const cnv = createCanvas(W, H);
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.scale(factor, factor);
  ctx.rotate(-theta);
  ctx.translate(-centre.x, -centre.y);
  ctx.drawImage(page, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const toRaster = (dx: number, dy: number): Pt => {
    const ux = dx / factor - cw / 2;
    const uy = dy / factor - ch / 2;
    return { x: centre.x + cos * ux - sin * uy, y: centre.y + sin * ux + cos * uy };
  };
  return { cnv, ctx, toRaster };
}

/** Recognised words of a crop, mapped to PDF points via the crop and page transforms. */
function wordsToPdf(raw: RawWord[], toRaster: (dx: number, dy: number) => Pt, raster: RasterPage): OcrWord[] {
  const words: OcrWord[] = [];
  for (const w of raw) {
    const text = w.text.trim();
    const b = w.bbox;
    if (!text || !b || !/[0-9A-Za-zÀ-ÿ]/.test(text)) continue;
    // a rotated crop maps the bbox to a tilted box: take its axis-aligned extent in page space
    const corners = [toRaster(b.x0, b.y0), toRaster(b.x1, b.y0), toRaster(b.x0, b.y1), toRaster(b.x1, b.y1)].map((p) => raster.toPdf(p.x, p.y));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    words.push({ text, conf: w.conf, xPt: (x0 + x1) / 2, yPt: (y0 + y1) / 2, wPt: x1 - x0, hPt: y1 - y0 });
  }
  return words;
}

/** Two readings of the same ink (other rotation, neighbouring window) overlap this much (IoU)... */
const SAME_WORD_IOU = 0.3;
/** ...or the smaller box lies this much inside the larger (a fragment cut by a window edge inside the whole word). */
const SAME_WORD_CONTAINED = 0.6;

function sameInk(a: OcrWord, b: OcrWord): boolean {
  const ix = Math.min(a.xPt + a.wPt / 2, b.xPt + b.wPt / 2) - Math.max(a.xPt - a.wPt / 2, b.xPt - b.wPt / 2);
  const iy = Math.min(a.yPt + a.hPt / 2, b.yPt + b.hPt / 2) - Math.max(a.yPt - a.hPt / 2, b.yPt - b.hPt / 2);
  if (ix <= 0 || iy <= 0) return false;
  const inter = ix * iy;
  const areaA = a.wPt * a.hPt;
  const areaB = b.wPt * b.hPt;
  return inter / (areaA + areaB - inter) > SAME_WORD_IOU || inter / Math.max(1e-9, Math.min(areaA, areaB)) > SAME_WORD_CONTAINED;
}

/**
 * Merge readings of the same page taken at several rotations, windows and
 * scales: of overlapping readings the more confident wins, a longer text
 * breaking near-ties (a word cut by a window edge reads short).
 */
function mergeReadings(readings: OcrWord[][]): OcrWord[] {
  if (readings.length === 1) return readings[0];
  const score = (w: OcrWord) => w.conf + Math.min(w.text.length, 8);
  const all = readings.flat().sort((a, b) => score(b) - score(a));
  const kept: OcrWord[] = [];
  for (const w of all) if (!kept.some((k) => sameInk(k, w))) kept.push(w);
  return kept.sort((a, b) => b.yPt - a.yPt || a.xPt - b.xPt);
}

export interface OcrRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrPageOptions {
  /** clip to this rectangle (PDF points) before recognising */
  region?: OcrRegion;
  /**
   * Extra reading angles in degrees (counter-clockwise, PDF sense) besides
   * upright; 90 reads text running bottom to top, 270 top to bottom. The
   * readings are merged, the more confident reading of the same ink winning.
   */
  rotations?: number[];
  /** tesseract character whitelist ('' = any) */
  whitelist?: string;
  /** tesseract page segmentation mode (default sparse text, 11) */
  psm?: string;
  /**
   * Upscale factor before recognising. Default auto: a pass at 1x measures
   * the height of the words it is sure of and, when they are under 20 px
   * (scans at screen resolution), a second pass at 2 to 4x reads the small
   * print; both passes are merged. Pass 1 to skip the second pass.
   */
  upsample?: number;
  /**
   * Window size in raster px for page reads (default 640; false reads the
   * page in one piece). Tesseract's layout pass loses labels scattered over
   * a drawing, while a window around them reads cleanly, so pages are read
   * window by window with a quarter overlap and merged.
   */
  tile?: number | false;
  /** tesseract language codes ('eng', 'eng+fra'); each pack is fetched once */
  langs?: string;
  /**
   * Binarise at this luminance (0..255) before recognising. Off by default:
   * it rescues blurred scans whose thin strokes read as grey (a 10 px "MH"
   * otherwise reads "HH") but wipes light-grey line work and labels, so
   * callers choose it per sheet; 190 suits soft scans.
   */
  threshold?: number;
}

const TILE = 640;
/** glyph height (raster px) the recogniser is comfortable with */
const TARGET_GLYPH_PX = 30;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Windows of side `tile` covering `rect` with a quarter overlap (one window when it already fits). */
function windowsOf(rect: Rect, tile: number | false): Rect[] {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  if (tile === false || (w <= 1.5 * tile && h <= 1.5 * tile)) return [rect];
  const step = tile - Math.floor(tile / 4);
  const starts = (len: number, from: number) => {
    if (len <= tile) return [from];
    const out: number[] = [];
    for (let s = 0; s + tile < len; s += step) out.push(from + s);
    out.push(from + len - tile);
    return out;
  };
  const out: Rect[] = [];
  for (const y of starts(h, rect.y0)) for (const x of starts(w, rect.x0)) out.push({ x0: x, y0: y, x1: Math.min(rect.x1, x + tile), y1: Math.min(rect.y1, y + tile) });
  return out;
}

async function readWindows(page: Canvas, raster: RasterPage, rect: Rect, factor: number, opts: OcrPageOptions): Promise<OcrWord[]> {
  const psm = opts.psm ?? PSM_SPARSE;
  const readings: OcrWord[][] = [[]];
  for (const win of windowsOf(rect, opts.tile ?? TILE)) {
    const w = win.x1 - win.x0;
    const h = win.y1 - win.y0;
    const centre = { x: (win.x0 + win.x1) / 2, y: (win.y0 + win.y1) / 2 };
    for (const deg of [0, ...(opts.rotations ?? [])]) {
      // raster y runs down, so a counter-clockwise PDF angle is a clockwise raster angle
      const theta = (-deg * Math.PI) / 180;
      const cos = Math.abs(Math.cos(theta));
      const sin = Math.abs(Math.sin(theta));
      const crop = cropRotated(page, centre, w * cos + h * sin, w * sin + h * cos, theta, factor);
      const raw = await recognize(crop.cnv, psm, opts.whitelist ?? '', opts.langs);
      readings.push(wordsToPdf(raw, crop.toRaster, raster));
    }
  }
  return mergeReadings(readings);
}

/**
 * Read a page (or a region of it) and return words in PDF points, like the
 * browser's ocrPage. Line work stays in the image: the windowed sparse-text
 * read copes with drawings, and the dictionary layers above drop what is
 * not a label.
 */
export async function ocrRaster(raster: RasterPage, opts: OcrPageOptions = {}): Promise<OcrWord[]> {
  const page = rasterToCanvas(opts.threshold !== undefined ? binarized(raster, opts.threshold) : raster);
  // the region in raster px (axis aligned; the page may be rotated by its viewport)
  const rect: Rect = { x0: 0, y0: 0, x1: raster.width, y1: raster.height };
  if (opts.region) {
    const r = opts.region;
    const pts = [raster.toRaster(r.x0, r.y0), raster.toRaster(r.x1, r.y0), raster.toRaster(r.x0, r.y1), raster.toRaster(r.x1, r.y1)];
    rect.x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x))));
    rect.x1 = Math.min(raster.width, Math.ceil(Math.max(...pts.map((p) => p.x))));
    rect.y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
    rect.y1 = Math.min(raster.height, Math.ceil(Math.max(...pts.map((p) => p.y))));
    if (rect.x1 - rect.x0 < 2 || rect.y1 - rect.y0 < 2) return [];
  }
  const first = await readWindows(page, raster, rect, opts.upsample ?? 1, opts);
  if (opts.upsample !== undefined) return first;
  // small print: measure the words the recogniser was sure of, in raster px
  const o = raster.toRaster(0, 0);
  const u = raster.toRaster(0, 1);
  const pxPerPt = Math.hypot(u.x - o.x, u.y - o.y) || 1;
  const heights = first
    .filter((w) => w.conf >= 70 && (w.text.match(/[0-9A-Za-z]/g) ?? []).length >= 3)
    .map((w) => w.hPt * pxPerPt)
    .sort((a, b) => a - b);
  const median = heights.length ? heights[heights.length >> 1] : TARGET_GLYPH_PX / 3;
  const factor = Math.min(4, Math.max(1, Math.round(TARGET_GLYPH_PX / median)));
  if (factor === 1) return first;
  return mergeReadings([first, await readWindows(page, raster, rect, factor, opts)]);
}

/**
 * White out line work inside a crop so the recogniser sees glyphs only:
 * connected components of the ink mask that are elongated (the dimension
 * line, crossing walls and extension lines) or tiny specks are removed.
 * Same rule as the browser adapter.
 */
function dropLineArt(ctx: SKRSContext2D, w: number, h: number, threshold = 150): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    mask[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 < threshold ? 1 : 0;
  }
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pxs: number[] = [];
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      pxs.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (mask[ni] && !seen[ni]) {
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
    const cw = x1 - x0 + 1;
    const chh = y1 - y0 + 1;
    const lineLike = (cw > 3.5 * chh && cw > 40) || (chh > 3.5 * cw && chh > 40);
    const speck = pxs.length < 5;
    if (!lineLike && !speck) continue;
    for (const i of pxs) {
      const p = i * 4;
      d[p] = d[p + 1] = d[p + 2] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * OCR just the corridor along a segment (PDF points), rotated so its text
 * reads upright, as the browser's ocrCorridor does. Near-vertical segments
 * read bottom to top by drafting convention; the opposite reading is tried
 * too and the better parse wins (corridorAngles / pickCorridorReading).
 * Words come back in PDF points, ready for nearestDimensionValue.
 */
export async function ocrCorridorRaster(raster: RasterPage, a: Pt, b: Pt): Promise<OcrWord[]> {
  const page = rasterToCanvas(raster);
  const ra = raster.toRaster(a.x, a.y);
  const rb = raster.toRaster(b.x, b.y);
  const readings: OcrWord[][] = [];
  for (const theta of corridorAngles(ra, rb)) {
    const len = Math.hypot(rb.x - ra.x, rb.y - ra.y);
    const band = 60; // raster px each side of the line (about 20 pt at scale 3, where labels sit)
    const cw = Math.ceil(len + 2 * band);
    const ch = Math.ceil(2 * band);
    const crop = cropRotated(page, { x: (ra.x + rb.x) / 2, y: (ra.y + rb.y) / 2 }, cw, ch, theta, 1);
    dropLineArt(crop.ctx, crop.cnv.width, crop.cnv.height);
    const raw = await recognize(crop.cnv, PSM_BLOCK, DIMENSION_CHARS);
    readings.push(wordsToPdf(raw, crop.toRaster, raster));
  }
  return readings[pickCorridorReading(readings, a, b)];
}
