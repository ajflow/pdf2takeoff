// Node OCR for the reference solver's raster half: tesseract.js (the same
// recognizer the browser app uses in src/app/ocr.ts), run on an upright page
// raster, with words mapped into the solver's PDF-point frame (origin
// bottom-left, like OcrWord in src/engine/ocr.ts). Results are cached per
// sheet and orientation under the set's .cache directory, so re-runs of the
// reference are fast and reproducible.
//
// The English language pack is fetched once from a tessdata mirror (override
// with --tessdata <url or dir>) and cached under bench/scaled-drawing-bench/.cache.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rgbaToPng } from './raster.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TESSDATA = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0';
const CACHE_DIR = join(__dirname, '..', '..', 'bench', 'scaled-drawing-bench', '.cache');

let workerPromise = null;
async function worker(tessdata) {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    mkdirSync(join(CACHE_DIR, 'tessdata'), { recursive: true });
    return createWorker('eng', 1, { langPath: tessdata ?? process.env.SDB_TESSDATA ?? DEFAULT_TESSDATA, cachePath: join(CACHE_DIR, 'tessdata'), logger: () => {} });
  })();
  return workerPromise;
}

export async function terminateOcr() {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}

/**
 * Engine identity for the OCR cache key: without it, upgrading tesseract.js
 * or pointing at a different tessdata pack would silently serve stale words
 * from the cache and a "re-run" would not measure the new engine at all.
 */
function engineStamp(tessdata) {
  let ver = '';
  try {
    ver = JSON.parse(readFileSync(join(__dirname, '..', '..', 'node_modules', 'tesseract.js', 'package.json'), 'utf8')).version;
  } catch { /* checkout without the dep installed: stamp what we know */ }
  const lang = `${tessdata ?? process.env.SDB_TESSDATA ?? DEFAULT_TESSDATA}`;
  let h = 0;
  for (let i = 0; i < lang.length; i++) h = ((h * 31 + lang.charCodeAt(i)) | 0) >>> 0;
  return `tesseract.js-${ver}-lang${h.toString(36)}`;
}

/**
 * OCR scale: the page raster (RASTER_SCALE px/pt) is resampled to this many
 * px per point. 2 (144 dpi) read the speckled and blurred sample sheets
 * better than the raster's own 3 px/pt in tests; the browser app OCRs at 3.
 */
export const OCR_PX_PER_PT = 2;

/**
 * Words of an upright RGBA page raster (at `scale` px per point), each as
 * { text, conf, xPt, yPt, wPt, hPt, angleDeg: 0 } in the page's point frame.
 */
export async function ocrWords(rgba, scale, cacheKey, opts = {}) {
  const cacheFile = cacheKey ? join(CACHE_DIR, 'ocr', `${cacheKey}-${engineStamp(opts.tessdata)}.json`) : null;
  if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  const factor = OCR_PX_PER_PT / scale;
  const png = rgbaToPng(rgba, factor);
  const w = await worker(opts.tessdata);
  const { data } = await w.recognize(png, {}, { blocks: true, text: false });
  const hPt = rgba.height / scale;
  const words = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const wd of line.words ?? []) {
          const text = (wd.text ?? '').trim();
          const b = wd.bbox;
          if (!text || !b) continue;
          words.push({
            text,
            conf: Math.round(wd.confidence ?? 0),
            xPt: (b.x0 + b.x1) / 2 / OCR_PX_PER_PT,
            yPt: hPt - (b.y0 + b.y1) / 2 / OCR_PX_PER_PT,
            wPt: (b.x1 - b.x0) / OCR_PX_PER_PT,
            hPt: (b.y1 - b.y0) / OCR_PX_PER_PT,
            angleDeg: 0,
          });
        }
      }
    }
  }
  if (cacheFile) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(words));
  }
  return words;
}

/** How much a set of OCR words looks like upright drawing text: confidence-weighted letters. */
export function uprightScore(words) {
  let s = 0;
  for (const w of words) {
    const letters = (w.text.match(/[A-Za-z]/g) ?? []).length;
    if (letters >= 3 && w.conf >= 60) s += w.conf * letters;
  }
  return s;
}
