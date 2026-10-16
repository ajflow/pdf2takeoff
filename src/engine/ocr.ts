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

const RATIO_WORD_RE = /^1[:\s]?(\d{2,4})$/;

/**
 * Find a drawing ratio (1:N) in the recognized text. Individual words are
 * checked ("1:100"), adjacent triples joined ("1 : 100"), and hits nearest a
 * scale/frequency keyword ("SCALE", "@ A1") win — detail viewports often
 * print secondary ratios that would mislead.
 */
export function findScaleRatio(words: OcrWord[]): ScaleHit | null {
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
  return { ratio: valid[0].ratio, source: `OCR 1:${valid[0].ratio}` };
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
