// Node OCR for the reference solver's raster half: the product's own OCR
// pipeline (src/headless/ocr-node.ts — windowed reads, the small-print 3-4x
// pass, Sauvola cleaning), so the benchmark measures what the tool actually
// reads, not a simpler stand-in. Words are mapped into the solver's PDF-point
// frame (origin bottom-left, like OcrWord in src/engine/ocr.ts) and cached
// per sheet and orientation under the set's .cache directory, so re-runs of
// the reference are fast and reproducible.
//
// The English language pack is fetched once by the product adapter (mirror
// recorded in the cache stamp below; override with --tessdata <dir>, which
// is passed through as PDF2TAKEOFF_TESSDATA).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ocrRaster, terminateOcr as terminateProductOcr, TESSDATA_MIRROR } from '../../src/headless/ocr-node.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '..', 'bench', 'scaled-drawing-bench', '.cache');

export async function terminateOcr() {
  await terminateProductOcr();
}

/**
 * Engine identity for the OCR cache key: without it, upgrading tesseract.js
 * or pointing at a different tessdata pack would silently serve stale words
 * from the cache and a "re-run" would not measure the new engine at all.
 */
function engineStamp() {
  let ver = '';
  try {
    ver = JSON.parse(readFileSync(join(__dirname, '..', '..', 'node_modules', 'tesseract.js', 'package.json'), 'utf8')).version;
  } catch { /* checkout without the dep installed: stamp what we know */ }
  const lang = `${TESSDATA_MIRROR}`;
  let h = 0;
  for (let i = 0; i < lang.length; i++) h = ((h * 31 + lang.charCodeAt(i)) | 0) >>> 0;
  return `tesseract.js-${ver}-lang${h.toString(36)}`;
}

/**
 * Words of an upright RGBA page raster (at `scale` px per point), each as
 * { text, conf, xPt, yPt, wPt, hPt } in the page's point frame, run through
 * the product pipeline (small-print pass included).
 */
export async function ocrWords(rgba, scale, cacheKey, opts = {}) {
  const cacheFile = cacheKey ? join(CACHE_DIR, 'ocr', `${cacheKey}-${engineStamp()}.json`) : null;
  if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  if (opts.tessdata && existsSync(opts.tessdata)) process.env.PDF2TAKEOFF_TESSDATA = opts.tessdata;
  const raster = {
    width: rgba.width,
    height: rgba.height,
    data: rgba.data,
    toPdf: (x, y) => ({ x: x / scale, y: rgba.height / scale - y / scale }),
    toRaster: (x, y) => ({ x: x * scale, y: rgba.height - y * scale }),
  };
  const words = (await ocrRaster(raster, {})).map((w) => ({ ...w, angleDeg: 0 }));
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
