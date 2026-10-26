// Printed dimensions as a witness for the scale. A CAD sheet prints its
// dimensions ("3570" over a dimension line), and each one says what scale the
// drawing is really at: the printed value over the drawn length. When enough
// of them agree, that is a stronger witness than the title block, which is
// typed by hand and sometimes wrong (a sheet labelled "1:100 @ A3" drawn at
// 1:50 doubles every length and quadruples every area taken from it).
//
// Words come from the text layer, or from the "AutoCAD SHX Text" comments
// Acrobat adds when a CAD export draws its text as line work (the values are
// then in the comments, not the text layer). Lines come from the vector layer.

import { dimensionVote, scaleConsensus, type ScaleVote } from './scale.ts';
import type { OcrWord, TextLayerWord } from './ocr.ts';

/** A word with its baseline angle when known (OCR words are upright). */
export type DimWord = OcrWord & { angleDeg?: number };
import type { VecPage } from './vector.ts';

/** A printed millimetre dimension, in metres: "3570", "6,223". Null for anything else. */
export function parseDimensionMm(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,2},\d{3}$|^\d{3,5}$/.test(t)) return null;
  const mm = Number(t.replace(',', ''));
  // under 100 mm the drawn line is too short to measure reliably; over 60 m
  // is not a building dimension (job numbers, dates and codes fall out here)
  if (mm < 100 || mm > 60000) return null;
  return mm / 1000;
}

/** The comment shape pdf.js returns from page.getAnnotations() (only what is read here). */
export interface AnnotationLike {
  rect?: number[];
  contentsObj?: { str?: string };
  titleObj?: { str?: string };
}

/**
 * Acrobat's "AutoCAD SHX Text" comments as words: one per comment, centred
 * on its box, upright or turned 90 degrees by the box's shape. Other
 * comments are ignored.
 */
export function shxWords(annots: AnnotationLike[]): TextLayerWord[] {
  const out: TextLayerWord[] = [];
  for (const a of annots) {
    if (a.titleObj?.str !== 'AutoCAD SHX Text' || !a.rect || a.rect.length < 4) continue;
    const text = (a.contentsObj?.str ?? '').trim();
    if (!text) continue;
    const [x0, y0, x1, y1] = a.rect;
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    const vertical = h > w * 1.4 && text.length > 1;
    out.push({
      text,
      conf: 100,
      xPt: (x0 + x1) / 2,
      yPt: (y0 + y1) / 2,
      wPt: vertical ? h : w,
      hPt: vertical ? w : h,
      angleDeg: vertical ? 90 : 0,
    });
  }
  return out;
}

/** Segments bucketed by 16 pt cells, so lookups near a word or a line end stay cheap on 100k-segment sheets. */
const CELL = 16;
class SegIndex {
  private cells = new Map<number, number[]>();
  private stamp: Uint32Array;
  private round = 0;
  readonly vec: VecPage;
  constructor(vec: VecPage) {
    this.vec = vec;
    this.stamp = new Uint32Array(vec.segs.length);
    vec.segs.forEach((s, i) => {
      const [cx0, cy0, cx1, cy1] = [Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.max(s.x1, s.x2), Math.max(s.y1, s.y2)].map((v) => Math.floor(v / CELL));
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) return; // sheet frames and long diagonals: never a dimension part
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const k = (cx + 4096) * 8192 + (cy + 4096);
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      }
    });
  }
  /** Indices of segments whose cells meet the box (each once). */
  near(x0: number, y0: number, x1: number, y1: number): number[] {
    const out: number[] = [];
    const r = ++this.round;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        for (const i of this.cells.get((cx + 4096) * 8192 + (cy + 4096)) ?? []) {
          if (this.stamp[i] === r) continue;
          this.stamp[i] = r;
          out.push(i);
        }
      }
    }
    return out;
  }
}

/**
 * Where a dimension line ends, along its own direction: the nearest mark (a
 * tick, an arrow stroke or an extension line, anything not parallel to it)
 * meeting the line within a short reach of its end. CAD exports often stop
 * the line short of its tick, so the tick, not the line, marks the end.
 */
function endMark(idx: SegIndex, horizontal: boolean, at: number, end: number, dir: 1 | -1): number | null {
  const lo = dir > 0 ? end - 4 : end - 12;
  const hi = dir > 0 ? end + 12 : end + 4;
  const ids = horizontal ? idx.near(lo, at - 6, hi, at + 6) : idx.near(at - 6, lo, at + 6, hi);
  let best: number | null = null;
  for (const i of ids) {
    const s = idx.vec.segs[i];
    // along: position on the line's own axis; across: offset from the line
    const [a1, c1, a2, c2] = horizontal ? [s.x1, s.y1, s.x2, s.y2] : [s.y1, s.x1, s.y2, s.x2];
    const dA = Math.abs(a2 - a1);
    const dC = Math.abs(c2 - c1);
    if (dC < 0.35 * dA) continue; // within ~20 degrees of parallel: part of the line, not a mark
    if (Math.min(c1, c2) > at + 3 || Math.max(c1, c2) < at - 3) continue; // does not reach the line
    const pos = dC < 1e-6 ? (a1 + a2) / 2 : a1 + ((a2 - a1) * (Math.max(Math.min(at, Math.max(c1, c2)), Math.min(c1, c2)) - c1)) / (c2 - c1);
    if (pos < lo || pos > hi) continue;
    if (best === null || Math.abs(pos - end) < Math.abs(best - end)) best = pos;
  }
  return best;
}

function measureDimension(w: DimWord, idx: SegIndex): number | null {
  const a = (((w.angleDeg ?? 0) % 180) + 180) % 180;
  const vertical = Math.abs(a - 90) < 5;
  if (!vertical && Math.min(a, 180 - a) > 5) return null; // only upright or turned text
  const reach = Math.max(14, 3 * w.hPt);
  const ids = vertical ? idx.near(w.xPt - reach, w.yPt - 2, w.xPt + reach, w.yPt + 2) : idx.near(w.xPt - 2, w.yPt - reach, w.xPt + 2, w.yPt + reach);
  let best: { off: number; at: number; lo: number; hi: number } | null = null;
  for (const i of ids) {
    const s = idx.vec.segs[i];
    if (!s.stroked || s.filled || s.curve || s.lineWidth > 0.8) continue;
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    // a dimension is written over its span, so its line is at least as long as the label
    if (len < 12 || len < 0.8 * w.wPt) continue;
    let off: number;
    let at: number;
    let lo: number;
    let hi: number;
    if (!vertical) {
      if (Math.abs(s.y1 - s.y2) > 0.3) continue;
      [lo, hi] = [Math.min(s.x1, s.x2), Math.max(s.x1, s.x2)];
      if (w.xPt < lo - 2 || w.xPt > hi + 2) continue;
      at = s.y1;
      off = Math.abs(w.yPt - at);
    } else {
      if (Math.abs(s.x1 - s.x2) > 0.3) continue;
      [lo, hi] = [Math.min(s.y1, s.y2), Math.max(s.y1, s.y2)];
      if (w.yPt < lo - 2 || w.yPt > hi + 2) continue;
      at = s.x1;
      off = Math.abs(at - w.xPt);
    }
    if (off < 0.3 * w.hPt || off > reach) continue;
    if (!best || off < best.off) best = { off, at, lo, hi };
  }
  if (!best) return null;
  // a real dimension line is closed by a mark at both ends; a stray line is not
  const start = endMark(idx, !vertical, best.at, best.lo, -1);
  const end = endMark(idx, !vertical, best.at, best.hi, 1);
  if (start === null || end === null || end - start < 12) return null;
  return end - start;
}

export interface DimensionScale {
  /** every printed dimension that found its line, as a vote */
  votes: ScaleVote[];
  /** the ratio most of them agree on, when enough do */
  ratio?: number;
  /** how many dimensions back that ratio, of how many measured */
  support: number;
  total: number;
}

/** Standard drawing ratios a consensus snaps to when within 3%. */
const STANDARD = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000];

/**
 * The scale the sheet's printed dimensions are drawn at. Each printed value
 * is measured between the marks that close its dimension line. Needs at
 * least three agreeing dimensions with at least twice the support of any
 * other group: a single number over a long line proves nothing, and a sheet
 * with viewports at two scales in similar numbers gives no verdict.
 */
export function dimensionScale(words: DimWord[], vec: VecPage): DimensionScale {
  const found: { len: number; metres: number; vote: ScaleVote }[] = [];
  let idx: SegIndex | null = null;
  for (const w of words) {
    const metres = parseDimensionMm(w.text);
    if (metres === null) continue;
    idx ??= new SegIndex(vec);
    const len = measureDimension(w, idx);
    if (!len) continue;
    const vote = dimensionVote(len, metres, `printed ${w.text}`);
    if (vote && vote.ratio >= 1 && vote.ratio <= 5000) found.push({ len, metres, vote });
  }
  // a dimension line's length follows its value; a level or ceiling-height
  // tag ("2930 C.L") draws the same line whatever it says. Different values
  // on lines of the same length are tags, so they do not vote.
  const votes = found
    .filter((f) => !found.some((o) => o.metres !== f.metres && Math.abs(o.len / f.len - 1) < 0.01))
    .map((f) => f.vote);
  const total = votes.length;
  if (total < 3) return { votes, support: 0, total };
  const c = scaleConsensus(votes, false, 0.03);
  const runnerUp = Math.max(0, ...c.rivals.map((r) => r.support));
  if (c.ratio === undefined || c.support < 3 || c.support < 2 * runnerUp) return { votes, support: c.support, total };
  const snap = STANDARD.find((r) => Math.abs(c.ratio! / r - 1) <= 0.03);
  return { votes, ratio: snap ?? c.ratio, support: c.support, total };
}

export interface DimensionCheck {
  /**
   * agrees: the scale matches the printed dimensions; disagrees: it does not;
   * unknown: too few dimensions agree to say.
   */
  status: 'agrees' | 'disagrees' | 'unknown';
  /** the scale the dimensions are drawn at */
  drawnRatio?: number;
  support: number;
  total: number;
  /** plain-language explanation when the scale disagrees with the dimensions */
  message?: string;
}

/**
 * Check a scale (as a ratio on this page's paper) against the printed
 * dimensions. `printedRatio` is the title block's ratio when there is one,
 * so the message can say which of the two is wrong.
 */
export function checkAgainstDimensions(ratio: number, dims: DimensionScale, printedRatio?: number): DimensionCheck {
  const { support, total } = dims;
  if (dims.ratio === undefined) return { status: 'unknown', support, total };
  const drawn = dims.ratio;
  if (Math.abs(ratio / drawn - 1) <= 0.05) return { status: 'agrees', drawnRatio: drawn, support, total };
  const fmt = (r: number) => `1:${Math.round(r)}`;
  const factor = Math.max(ratio, drawn) / Math.min(ratio, drawn);
  const times = Math.abs(factor - Math.round(factor)) < 0.05 ? `${Math.round(factor)}×` : `${factor.toFixed(1)}×`;
  // drawn at a smaller ratio than the scale in use: the drawing is larger on
  // the page than that scale assumes, so lengths come out too long
  const effect = drawn < ratio ? `lengths ${times} too long` : `lengths ${times} too short`;
  const titleBlock =
    printedRatio !== undefined && Math.abs(printedRatio / ratio - 1) <= 0.05
      ? ` The title block's ${fmt(printedRatio)} looks wrong for this sheet.`
      : '';
  const message = `This sheet's printed dimensions are drawn at ${fmt(drawn)} (${support} of ${total} agree), so ${fmt(ratio)} makes ${effect}.${titleBlock} Use ${fmt(drawn)} or calibrate from a dimension.`;
  return { status: 'disagrees', drawnRatio: drawn, support, total, message };
}
