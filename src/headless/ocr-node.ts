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

/**
 * Binary PPM (P6) of a canvas: header, then row-major RGB bytes. Tesseract.js
 * writes the bytes straight to its in-memory FS, where leptonica's built-in
 * PNM reader picks them up — an uncompressed stand-in for the PNG encode
 * every recognise call paid for (about 137 ms on a page-size crop).
 * Tesseract greys the RGB itself, with the same values the PNG carried, so
 * it reads identical pixels. PPM has no alpha, so a canvas with any
 * transparency (a transparent PNG input) returns null and stays a PNG.
 */
function ppmOf(cnv: Canvas): Buffer | null {
  const { data, width, height } = cnv.getContext('2d').getImageData(0, 0, cnv.width, cnv.height);
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0, p = 0; i < rgb.length; p += 4) {
    if (data[p + 3] !== 255) return null;
    rgb[i++] = data[p];
    rgb[i++] = data[p + 1];
    rgb[i++] = data[p + 2];
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]);
}

async function recognize(cnv: Canvas, psm: string, whitelist = '', langs = 'eng'): Promise<RawWord[]> {
  const worker = await getWorker(langs);
  // one shared worker: whitelist and segmentation mode are set per call
  await worker.setParameters({ tessedit_char_whitelist: whitelist, tessedit_pageseg_mode: psm as never });
  const { data } = await worker.recognize(ppmOf(cnv) ?? cnv.toBuffer('image/png'), {}, { blocks: true, text: true });
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
   * the height of the words it is sure of and the windows with unread print
   * are read again, at 3 to 4x when those words are under 20 px (scans at
   * screen resolution) and cleaned at 1x otherwise (see `smallPrint`); the
   * passes are merged. A number reads once at that factor.
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
   * Binarise at this global luminance (0..255) before recognising. Off by
   * default: it wipes light-grey line work and labels on some sheets, so
   * callers choose it per sheet; 190 suits soft scans. The small-print pass
   * binarises adaptively instead (see `binarize`), which is what rescues
   * blurred 10 px labels without that cost.
   */
  threshold?: number;
  /**
   * Adaptive (Sauvola) binarisation per window, the threshold following the
   * local mean and contrast with a window about three text heights wide,
   * so faint strokes on a blurred scan go black while light-grey plans keep
   * their labels. 'small' (default) applies it to the upsampled small-print
   * windows only; 'all' to the first pass too; 'off' never.
   */
  binarize?: 'small' | 'all' | 'off';
  /**
   * Second pass (default true): after the 1x read, windows holding
   * glyph-sized ink that no sure word accounts for, or whose sure words are
   * small (under 12 px), or that read nothing with confidence, are read
   * again, twice: as printed in sparse-text mode and cleaned (adaptive
   * binarisation, line work and large glyphs removed, words already read
   * masked) in block mode, at 3 to 4x for small print and 1x for sheets
   * printed large. Windows that read well are not re-read, so sheets
   * printed large keep most of their first-pass time. false reads once at
   * 1x (same as upsample: 1).
   */
  smallPrint?: boolean;
  /**
   * White out walls, furniture and other ink far larger than a glyph before
   * recognising, so the layout pass is not sized by them (dropNonGlyphs).
   * 'small' (default) on the second-pass windows, 'all' on the first pass
   * too, 'off' never.
   */
  glyphsOnly?: 'small' | 'all' | 'off';
}

const TILE = 640;
/** glyph height (raster px) the recogniser is comfortable with */
const TARGET_GLYPH_PX = 30;
/** words shorter than this (raster px) on the first pass mark a window as small print */
const SMALL_PRINT_PX = 12;
/** a first-pass word this sure, with two or more letters or digits, counts as read */
const SURE_CONF = 70;
/** share of a window's pixels that must be ink for it to be worth a second read */
const MIN_INK = 0.001;
/** Sauvola parameters: k scales the contrast term, R is the dynamic range of the standard deviation */
const SAUVOLA_K = 0.2;
const SAUVOLA_R = 128;

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

/**
 * Sauvola binarisation in place: a pixel is ink when it is darker than
 * m * (1 + k * (s / R - 1)) for the mean m and standard deviation s of the
 * `window` x `window` neighbourhood (integral images, so the cost is a few
 * passes over the crop whatever the window). Flat white stays white (s is
 * 0, the threshold sits k below the mean), faint grey strokes next to
 * dark ones go black, and an all-grey region keeps its own contrast.
 */
function sauvola(ctx: SKRSContext2D, w: number, h: number, window: number, k = SAUVOLA_K, R = SAUVOLA_R): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSq = 0;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const v = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
      rowSum += v;
      rowSq += v * v;
      const i = (y + 1) * W + (x + 1);
      sum[i] = sum[i - W] + rowSum;
      sq[i] = sq[i - W] + rowSq;
    }
  }
  const r = Math.max(1, window >> 1);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const a = y0 * W + x0;
      const b = y0 * W + x1;
      const c = y1 * W + x0;
      const e = y1 * W + x1;
      const mean = (sum[e] - sum[b] - sum[c] + sum[a]) / n;
      const variance = Math.max(0, (sq[e] - sq[b] - sq[c] + sq[a]) / n - mean * mean);
      const t = mean * (1 + k * (Math.sqrt(variance) / R - 1));
      const p = (y * w + x) * 4;
      const v = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 < t ? 0 : 255;
      d[p] = d[p + 1] = d[p + 2] = v;
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Debug aid: PDF2TAKEOFF_OCR_DUMP=<dir> writes every crop the recogniser sees. */
let dumpSeq = 0;
function dumpCrop(cnv: Canvas, tag: string): void {
  const dir = process.env.PDF2TAKEOFF_OCR_DUMP!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(dumpSeq++).padStart(4, '0')}-${tag}.png`), cnv.toBuffer('image/png'));
}

/** Share of a crop's pixels darker than mid grey. */
function inkFraction(ctx: SKRSContext2D, w: number, h: number): number {
  const d = ctx.getImageData(0, 0, w, h).data;
  let ink = 0;
  for (let p = 0; p < d.length; p += 4) if ((d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 < 160) ink++;
  return ink / (w * h);
}

interface WindowRead {
  win: Rect;
  words: OcrWord[];
  /** share of the window that is ink (first pass only) */
  ink: number;
  /** glyph-sized ink components no sure word accounts for (first pass only) */
  stray: number;
}

interface WindowReadOptions {
  factor: number;
  psm: string;
  /** Sauvola window in crop px (0 = no binarisation) */
  binWindow: number;
  /** white out line work and furniture, leaving glyph-sized ink (dropNonGlyphs); the number is the tallest glyph kept, in 1x px */
  glyphsOnly: number | false;
  /** measure ink and stray glyphs after reading (first pass) */
  measure: boolean;
  /** raster-px boxes of words already read, whited out before the re-read so the layout pass is sized by the unread print */
  mask?: Rect[];
}

/**
 * Glyph-sized ink components (5 to 40 px tall at 1x) that lie outside every
 * box in `boxes` (crop px): labels the first pass did not read, plus some
 * hatching and symbols. Cleans the canvas in place (call after recognising).
 */
function countStrayGlyphs(ctx: SKRSContext2D, w: number, h: number, boxes: Rect[]): number {
  sauvola(ctx, w, h, 3 * SMALL_PRINT_PX + 1);
  dropNonGlyphs(ctx, w, h, 1);
  let stray = 0;
  dropComponents(ctx, w, h, 128, (cw, chh, px, x0, y0) => {
    if (chh < 5 || px < 8) return false;
    const cx = x0 + cw / 2;
    const cy = y0 + chh / 2;
    if (!boxes.some((b) => cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1)) stray++;
    return false;
  });
  return stray;
}

/** Read one window at every requested rotation and merge the rotations. */
async function readWindow(page: Canvas, raster: RasterPage, win: Rect, opts: OcrPageOptions, ro: WindowReadOptions): Promise<WindowRead> {
  const w = win.x1 - win.x0;
  const h = win.y1 - win.y0;
  const centre = { x: (win.x0 + win.x1) / 2, y: (win.y0 + win.y1) / 2 };
  const readings: OcrWord[][] = [[]];
  let ink = 1;
  let stray = 0;
  for (const deg of [0, ...(opts.rotations ?? [])]) {
    // raster y runs down, so a counter-clockwise PDF angle is a clockwise raster angle
    const theta = (-deg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(theta));
    const sin = Math.abs(Math.sin(theta));
    const crop = cropRotated(page, centre, w * cos + h * sin, w * sin + h * cos, theta, ro.factor);
    if (ro.mask?.length && deg === 0) {
      crop.ctx.fillStyle = '#fff';
      for (const b of ro.mask) crop.ctx.fillRect((b.x0 - win.x0) * ro.factor, (b.y0 - win.y0) * ro.factor, (b.x1 - b.x0) * ro.factor, (b.y1 - b.y0) * ro.factor);
    }
    if (ro.measure && deg === 0) ink = inkFraction(crop.ctx, crop.cnv.width, crop.cnv.height);
    if (ro.binWindow > 0) sauvola(crop.ctx, crop.cnv.width, crop.cnv.height, ro.binWindow);
    if (ro.glyphsOnly) dropNonGlyphs(crop.ctx, crop.cnv.width, crop.cnv.height, ro.factor, ro.glyphsOnly);
    if (process.env.PDF2TAKEOFF_OCR_DUMP) dumpCrop(crop.cnv, `${Math.round(win.x0)}-${Math.round(win.y0)}-x${ro.factor}-psm${ro.psm}-r${deg}`);
    const raw = await recognize(crop.cnv, ro.psm, opts.whitelist ?? '', opts.langs);
    const words = wordsToPdf(raw, crop.toRaster, raster);
    readings.push(words);
    if (ro.measure && deg === 0 && ro.factor === 1 && ink >= MIN_INK) {
      // what the sure words cover, in crop px (deg 0, 1x: crop px = raster px minus the window origin)
      const boxes = words
        .filter((x) => x.conf >= SURE_CONF && alnumCount(x) >= 2)
        .map((x) => {
          const a = raster.toRaster(x.xPt - x.wPt / 2, x.yPt - x.hPt / 2);
          const b = raster.toRaster(x.xPt + x.wPt / 2, x.yPt + x.hPt / 2);
          return { x0: Math.min(a.x, b.x) - win.x0 - 2, x1: Math.max(a.x, b.x) - win.x0 + 2, y0: Math.min(a.y, b.y) - win.y0 - 2, y1: Math.max(a.y, b.y) - win.y0 + 2 };
        });
      stray = countStrayGlyphs(crop.ctx, crop.cnv.width, crop.cnv.height, boxes);
    }
  }
  return { win, words: mergeReadings(readings), ink, stray };
}

const alnumCount = (w: OcrWord): number => (w.text.match(/[0-9A-Za-zÀ-ÿ]/g) ?? []).length;
const letterCount = (w: OcrWord): number => (w.text.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
/** confidence edge a sure first-pass reading gets over the re-read of the same ink */
const FIRST_PASS_EDGE = 10;
/** stray glyph components in a window that call for a second read (a short label's worth) */
const STRAY_GLYPHS = 3;

/**
 * Whether a first-pass window deserves the small-print read: it holds
 * glyph-sized ink that no sure word accounts for (labels too small or faint
 * for the 1x layout pass), or the words it is sure of are themselves small.
 */
function wantsSmallPrint(read: WindowRead, pxPerPt: number): boolean {
  if (read.ink < MIN_INK) return false;
  if (read.stray >= STRAY_GLYPHS) return true;
  const sure = read.words.filter((w) => w.conf >= SURE_CONF && alnumCount(w) >= 3);
  if (sure.some((w) => w.hPt * pxPerPt < SMALL_PRINT_PX)) return true;
  // something was read but nothing with confidence: doubted words are worth a second look
  return sure.length === 0 && read.words.some((w) => letterCount(w) >= 2);
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
  const o = raster.toRaster(0, 0);
  const u = raster.toRaster(0, 1);
  const pxPerPt = Math.hypot(u.x - o.x, u.y - o.y) || 1;
  const psm = opts.psm ?? PSM_SPARSE;
  const binarize = opts.binarize ?? 'small';
  const secondPass = opts.upsample === undefined && opts.smallPrint !== false;
  // first pass at 1x (or the caller's factor); a window about three text heights for 'all'
  const reads: WindowRead[] = [];
  for (const win of windowsOf(rect, opts.tile ?? TILE)) {
    reads.push(await readWindow(page, raster, win, opts, { factor: opts.upsample ?? 1, psm, binWindow: binarize === 'all' ? 3 * TARGET_GLYPH_PX : 0, glyphsOnly: opts.glyphsOnly === 'all' ? 40 : false, measure: secondPass }));
  }
  const first = mergeReadings(reads.map((r) => r.words));
  if (!secondPass) return first;
  // small print: measure the words the recogniser was sure of, in raster px
  const measured = (minConf: number) =>
    first
      .filter((w) => w.conf >= minConf && alnumCount(w) >= 2)
      .map((w) => w.hPt * pxPerPt)
      .sort((a, b) => a - b);
  // sure words size the print; failing any, the doubted ones do
  const heights = measured(SURE_CONF).length ? measured(SURE_CONF) : measured(40);
  const median = heights.length ? heights[heights.length >> 1] : TARGET_GLYPH_PX / 3;
  // printed large: the 1x read stands, and only windows with stray glyphs are read again at 1x, cleaned
  // (a label touching a fixture or wall, which the layout pass drops); small print gets 3x or 4x
  const lower = heights.length ? heights[heights.length >> 2] : median;
  // "printed large" takes a few sure words with even the smaller ones near the target: one big title over 8 px labels is not
  const large = measured(SURE_CONF).length >= 4 && Math.round(TARGET_GLYPH_PX / median) <= 1 && lower >= 15;
  const factor = large ? 1 : lower < 8 ? 4 : 3;
  const textPx = Math.min(lower, SMALL_PRINT_PX);
  const binWindow = binarize === 'off' ? 0 : Math.max(15, Math.round(3 * (large ? TARGET_GLYPH_PX : textPx) * factor)) | 1;
  // the tallest glyph kept by the cleaning: small print only, so one large glyph cannot size the layout pass
  const maxGlyph = large ? Math.max(40, Math.round(2 * median)) : Math.round(Math.max(1.6 * SMALL_PRINT_PX, 1.5 * lower));
  // what the first pass read with confidence at a readable size is whited out before the re-read
  // (three or more characters and well above the sure floor, so a confident junk fragment cannot hide a label)
  const mask: Rect[] = first
    .filter((w) => w.conf >= SURE_CONF + 10 && alnumCount(w) >= 3 && (large || w.hPt * pxPerPt >= SMALL_PRINT_PX))
    .map((w) => {
      const a = raster.toRaster(w.xPt - w.wPt / 2, w.yPt - w.hPt / 2);
      const b = raster.toRaster(w.xPt + w.wPt / 2, w.yPt + w.hPt / 2);
      return { x0: Math.min(a.x, b.x) - 2, x1: Math.max(a.x, b.x) + 2, y0: Math.min(a.y, b.y) - 2, y1: Math.max(a.y, b.y) + 2 };
    });
  // each window chosen is read twice and both readings merged: as printed in
  // sparse-text mode, which keeps clean small print whole ("BEDROOM" at 8 px),
  // and cleaned (binarised, line work and large glyphs removed) in block mode,
  // which finds blurred or fixture-adjacent labels the layout pass drops
  const second: OcrWord[][] = [];
  for (const read of reads) {
    if (!wantsSmallPrint(read, pxPerPt)) continue;
    if (factor > 1) second.push((await readWindow(page, raster, read.win, opts, { factor, psm: opts.psm ?? PSM_SPARSE, binWindow: 0, glyphsOnly: false, measure: false, mask })).words);
    second.push((await readWindow(page, raster, read.win, opts, { factor, psm: opts.psm ?? PSM_BLOCK, binWindow, glyphsOnly: opts.glyphsOnly === 'off' ? false : maxGlyph, measure: false, mask })).words);
  }
  if (!second.length) return first;
  // the re-read is for print the first pass missed or doubted: a sure first-pass reading keeps its ink
  const kept = new Set(first.filter((w) => w.conf >= SURE_CONF));
  const merged = mergeReadings([first.map((w) => (kept.has(w) ? { ...w, conf: Math.min(100, w.conf + FIRST_PASS_EDGE), orig: w } : w)), ...second]);
  return merged.map((w) => ('orig' in w ? (w as { orig: OcrWord }).orig : w));
}

/**
 * White out line work inside a crop so the recogniser sees glyphs only:
 * connected components of the ink mask that are elongated (the dimension
 * line, crossing walls and extension lines) or tiny specks are removed.
 * Same rule as the browser adapter.
 */
function dropLineArt(ctx: SKRSContext2D, w: number, h: number, threshold = 150): void {
  dropComponents(ctx, w, h, threshold, (cw, chh, px) => (cw > 3.5 * chh && cw > 40) || (chh > 3.5 * cw && chh > 40) || px < 5);
}

/**
 * Keep glyph-sized ink only, for the small-print read of a drawing: walls,
 * furniture and door swings are far larger than any glyph, and tesseract's
 * layout pass, which sizes its text expectations from the biggest
 * components, drops the small labels next to them. `scale` is the upsample
 * factor; a component taller than about 40 px or wider than about 100 px
 * at 1x, an elongated one, or a speck is removed.
 */
function dropNonGlyphs(ctx: SKRSContext2D, w: number, h: number, scale: number, maxGlyphPx = 40): void {
  const maxH = maxGlyphPx * scale;
  const maxW = 100 * scale;
  const minLine = 40 * scale;
  const speck = 5 * scale * scale;
  dropComponents(ctx, w, h, 128, (cw, chh, px) => chh > maxH || cw > maxW || (cw > 3.5 * chh && cw > minLine) || (chh > 3.5 * cw && chh > minLine) || px < speck);
}

/** Doubles a flat flood-fill stack until it holds `need` slots. */
function growInt32(stack: Int32Array<ArrayBuffer>, need: number): Int32Array<ArrayBuffer> {
  let n = stack.length || 1024;
  while (n < need) n *= 2;
  const out = new Int32Array(n);
  out.set(stack);
  return out;
}

/** White out every connected ink component (4-connected, darker than `threshold`) for which `drop(width, height, pixels)` holds. */
function dropComponents(ctx: SKRSContext2D, w: number, h: number, threshold: number, drop: (cw: number, ch: number, px: number, x0: number, y0: number) => boolean): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    mask[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 < threshold ? 1 : 0;
  }
  const seen = new Uint8Array(w * h);
  // preallocated flat stack and member list (doubling): the number[] stack
  // and the per-pixel neighbour tuples dominated this pass; visit order is
  // the same (neighbours still read left, right, up, down)
  let stack = new Int32Array(1024);
  let pxs = new Int32Array(1024);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    let np = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (sp > 0) {
      if (sp + 4 > stack.length) stack = growInt32(stack, sp + 4);
      const i = stack[--sp];
      if (np === pxs.length) pxs = growInt32(pxs, np + 1);
      pxs[np++] = i;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0) { const ni = i - 1; if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack[sp++] = ni; } }
      if (x < w - 1) { const ni = i + 1; if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack[sp++] = ni; } }
      if (y > 0) { const ni = i - w; if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack[sp++] = ni; } }
      if (y < h - 1) { const ni = i + w; if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack[sp++] = ni; } }
    }
    if (!drop(x1 - x0 + 1, y1 - y0 + 1, np, x0, y0)) continue;
    for (let k = 0; k < np; k++) {
      const p = pxs[k] * 4;
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
