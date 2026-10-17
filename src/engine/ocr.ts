// OCR word parsing: turn recognized words into calibration suggestions.
// Pure text + geometry heuristics; the host runs the actual recognizer and
// supplies words positioned in PDF-point space (origin bottom-left).

import type { Pt } from './types.ts';
import type { Unit } from './units.ts';
import { scaleVotesFromWords, type ScaleVote } from './scale.ts';

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

/**
 * Find the drawing scale in the recognized text. Every scale note is parsed
 * into a vote (scale.ts: ratios, imperial notes, keyword-gated guesses for a
 * dropped colon); notes printed next to a SCALE keyword or label win, since
 * detail viewports often print secondary ratios that would mislead, then
 * full-weight notes beat guesses, then recognizer confidence. `origin`
 * names where the words came from in the hit's source (the recognizer, or a
 * PDF text layer).
 */
export function findScaleRatio(words: OcrWord[], origin = 'OCR'): ScaleHit | null {
  const { votes } = scaleVotesFromWords(words, origin);
  if (votes.length === 0) return null;
  const scaleWords = words.filter((w) => /scale|@/i.test(w.text));
  // printed right after SCALE beats merely near a SCALE label beats neither
  const rank = (v: ScaleVote) =>
    v.keyword ? 2 : v.at !== undefined && scaleWords.some((s) => Math.hypot(s.xPt - v.at!.x, s.yPt - v.at!.y) < 150) ? 1 : 0;
  const best = [...votes].sort((a, b) => rank(b) - rank(a) || b.weight - a.weight || (b.conf ?? 0) - (a.conf ?? 0))[0];
  return { ratio: best.ratio, source: best.source };
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

/**
 * Centres (PDF pt) of text items that read like room labels ("BED 1",
 * "KITCHEN", "WC"): at least two letters, and not a scale note or a pure
 * dimension. One point per text item, so a two-word label counts once.
 * Dynamic Fill uses these to tell that a fill has merged rooms.
 */
export function roomLabelPoints(items: { str?: string; transform?: number[]; width?: number; height?: number }[]): Pt[] {
  const out: Pt[] = [];
  for (const it of items) {
    const str = (it.str ?? '').trim();
    if ((str.match(/[A-Za-z]/g) ?? []).length < 2) continue;
    if (/scale|\d\s*:\s*\d|^nts$/i.test(str)) continue;
    const words = wordsFromTextItem(str, it.transform, it.width, it.height);
    if (!words.length) continue;
    out.push({
      x: words.reduce((a, w) => a + w.xPt, 0) / words.length,
      y: words.reduce((a, w) => a + w.yPt, 0) / words.length,
    });
  }
  return out;
}
