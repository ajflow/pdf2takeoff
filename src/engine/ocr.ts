// OCR word parsing: turn recognized words into calibration suggestions.
// Pure text + geometry heuristics; the host runs the actual recognizer and
// supplies words positioned in PDF-point space (origin bottom-left).

import type { Pt } from './types.ts';
import type { Unit } from './units.ts';

export interface OcrWord {
  text: string;
  conf: number; // recognizer confidence 0..100
  xPt: number; // bbox centre
  yPt: number;
  wPt: number;
  hPt: number;
}

/** A drawing ratio read from the sheet, e.g. 1:100 from a title block. */
export interface ScaleHit {
  ratio: number;
  source: string;
}

// the colon is required: a bare "1200" or "1050" is far more often a
// dimension than a ratio whose colon got lost
const RATIO_WORD_RE = /^1\s*:\s*(\d{2,4})$/;

/**
 * Find a drawing ratio (1:N) in the recognized text. Individual words are
 * checked ("1:100"), adjacent triples joined ("1 : 100"), and hits nearest a
 * scale/frequency keyword ("SCALE", "@ A1") win — detail viewports often
 * print secondary ratios that would mislead. `origin` names where the words
 * came from in the hit's source (the recognizer, or a PDF text layer).
 */
export function findScaleRatio(words: OcrWord[], origin = 'OCR'): ScaleHit | null {
  const hits: { ratio: number; word: OcrWord }[] = [];
  const clean = words.map((w) => ({ ...w, text: w.text.trim() })).filter((w) => w.text);
  for (const w of clean) {
    const m = w.text.match(RATIO_WORD_RE);
    if (m) hits.push({ ratio: parseInt(m[1], 10), word: w });
  }
  // "1 : 100" split across tokens: join each word with its next two neighbours
  for (let i = 0; i + 2 < clean.length; i++) {
    const joined = `${clean[i].text} ${clean[i + 1].text} ${clean[i + 2].text}`.replace(/\s+/g, ' ');
    const m = joined.match(/^1 ?: ?(\d{2,4})$/);
    if (m) hits.push({ ratio: parseInt(m[1], 10), word: clean[i + 1] });
  }
  const valid = hits.filter((h) => h.ratio >= 10 && h.ratio <= 5000);
  if (valid.length === 0) return null;
  const scaleWords = clean.filter((w) => /scale|@/i.test(w.text));
  const score = (h: { word: OcrWord }) => {
    if (scaleWords.length === 0) return 1;
    const nearest = Math.min(...scaleWords.map((s) => Math.hypot(s.xPt - h.word.xPt, s.yPt - h.word.yPt)));
    return nearest < 150 ? 0 : 1; // near a SCALE label wins
  };
  valid.sort((a, b) => score(a) - score(b) || b.word.conf - a.word.conf);
  return { ratio: valid[0].ratio, source: `${origin} 1:${valid[0].ratio}` };
}

/** A printed dimension value near a clicked line. */
export interface DimensionHit {
  value: number;
  unit: Unit;
  text: string;
}

const NUM_RE = /^(\d{1,2}[.,]\d{1,2}|\d{3,5})(\s*(mm|cm|m|ft|in|'|"))?$/i;

/**
 * Numeric dimension text nearest (and roughly aligned with) the a→b segment
 * the user just clicked. "12.00" reads as metres, "12000" as millimetres; a
 * printed unit suffix wins. Labels sit just off the line near its middle.
 */
export function nearestDimensionValue(words: OcrWord[], a: Pt, b: Pt): DimensionHit | null {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const lenX = Math.abs(b.x - a.x);
  const lenY = Math.abs(b.y - a.y);
  const horizontal = lenX >= lenY;
  const lineLen = Math.max(lenX, lenY);

  let best: { d: number; hit: DimensionHit } | null = null;
  for (const w of words) {
    const m = w.text.trim().match(NUM_RE);
    if (!m) continue;
    const raw = m[1].replace(',', '.');
    // decimals look like metres ("12.00"); bare 3-5 digit integers like mm ("12000")
    let unit: Unit = raw.includes('.') ? 'm' : 'mm';
    const suffix = (m[2] ?? '').trim().toLowerCase();
    if (suffix === 'mm' || suffix === 'cm' || suffix === 'm' || suffix === 'ft' || suffix === 'in') unit = suffix;
    else if (suffix === "'") unit = 'ft';
    else if (suffix === '"') unit = 'in';
    const value = parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0) continue;

    const dx = Math.abs(w.xPt - mid.x);
    const dy = Math.abs(w.yPt - mid.y);
    const along = horizontal ? dx : dy; // distance along the line from its middle
    const across = horizontal ? dy : dx; // perpendicular offset (text sits off-line)
    if (along > lineLen / 2 + 30) continue; // not near this line
    if (across > 40) continue; // too far off the line to be its label
    const d = Math.hypot(dx, dy) - w.wPt / 4; // slight bias toward wider text
    if (!best || d < best.d) best = { d, hit: { value, unit, text: w.text.trim() } };
  }
  return best?.hit ?? null;
}

/** Within this angle of vertical, aligned-dimension text is folded to read from the right. */
const VERTICAL_FOLD_DEG = 10;
/** Within this angle of vertical, the opposite reading is also tried. */
const VERTICAL_AMBIGUOUS_DEG = 20;

/**
 * Crop rotations (radians, raster space with y down) that make text along
 * the a→b segment read upright, preferred first. Drafting convention reads
 * aligned dimensions from the bottom or the right, so the angle is folded
 * into [-90°, 90°) and a near-vertical segment always reads bottom to top
 * (-90°), whichever end was clicked first. Near vertical the opposite
 * reading is added as a fallback for sheets that break the convention.
 */
export function corridorAngles(a: Pt, b: Pt): number[] {
  let deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (deg >= 90) deg -= 180;
  else if (deg < -90) deg += 180;
  if (deg > 90 - VERTICAL_FOLD_DEG) deg -= 180; // top-to-bottom → read from the right
  const angles = [deg];
  if (Math.abs(Math.abs(deg) - 90) <= VERTICAL_AMBIGUOUS_DEG) angles.push(deg + 180);
  return angles.map((d) => (d * Math.PI) / 180);
}

/**
 * Choose between OCR readings of the same corridor taken at different
 * rotations: a parsed dimension beats none, a value without a spurious
 * leading zero beats one with (an upside-down "1200" reads "0021"), then
 * higher word confidence. Returns the index of the winning reading.
 */
export function pickCorridorReading(readings: OcrWord[][], a: Pt, b: Pt): number {
  let best = 0;
  let bestScore = -Infinity;
  readings.forEach((words, i) => {
    const hit = nearestDimensionValue(words, a, b);
    let score = 0;
    if (hit) {
      score += 1000;
      if (!/^0\d/.test(hit.text)) score += 500;
      const w = words.find((x) => x.text.trim() === hit.text);
      score += w ? w.conf : 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** A text-layer word: an OcrWord plus the reading angle of its baseline. */
export interface TextLayerWord extends OcrWord {
  /** baseline direction, degrees counter-clockwise from +x (PDF space) */
  angleDeg: number;
}

/**
 * Split one PDF text item (pdf.js getTextContent) into positioned words.
 * `transform` is the full text matrix and `width` the advance along the
 * baseline, so words are laid out along the baseline direction (t0, t1) and
 * lifted by half the height along the up direction (t2, t3); rotated and
 * vertical text lands where it is drawn. wPt and hPt are the word's length
 * along its baseline and its height.
 */
export function wordsFromTextItem(str: string, transform: number[] | undefined, width: number | undefined, height: number | undefined): TextLayerWord[] {
  if (!str.trim()) return [];
  const t = transform ?? [1, 0, 0, 1, 0, 0];
  const ul = Math.hypot(t[0], t[1]) || 1;
  const vl = Math.hypot(t[2], t[3]) || 1;
  const ux = t[0] / ul;
  const uy = t[1] / ul;
  const vx = t[2] / vl;
  const vy = t[3] / vl;
  const w = Math.abs(width ?? 0) || str.length * 3;
  const h = Math.abs(height ?? 0) || 8;
  const angleDeg = Math.round(((Math.atan2(uy, ux) * 180) / Math.PI) * 10) / 10;
  const words: TextLayerWord[] = [];
  let offset = 0;
  for (const part of str.split(/(\s+)/)) {
    const pw = (part.length / str.length) * w;
    if (part.trim()) {
      const along = offset + pw / 2;
      words.push({
        text: part,
        conf: 100,
        xPt: t[4] + ux * along + vx * (h / 2),
        yPt: t[5] + uy * along + vy * (h / 2),
        wPt: pw,
        hPt: h,
        angleDeg,
      });
    }
    offset += pw;
  }
  return words;
}
