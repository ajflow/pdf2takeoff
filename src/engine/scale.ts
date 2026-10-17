// Drawing scale from printed evidence: parse every scale note on a sheet into
// a vote, then find the ratio the votes agree on (patch-plan-2 P14). Pure
// text + arithmetic; hosts supply words from the PDF text layer or OCR.
//
// Votes come from:
//   - ratios with a colon ("1:100", "1 : 50");
//   - ratios whose colon was dropped or misread ("1;100", "1 100", "1100"),
//     accepted only right after a SCALE keyword and at reduced weight, since
//     a bare "1200" is far more often a dimension;
//   - imperial notes: architectural 1/4" = 1'-0" (1:48) and engineering
//     1" = 20' (1:240);
//   - FULL SIZE / HALF SIZE;
//   - printed dimensions measured against their drawn length (dimensionVote).
// NTS / NOT TO SCALE abstains. Consensus groups votes within ±2%; when two
// groups disagree, the ratio between them hints at the cause (x6 the
// "1200 read as 1:200" slip, x10 a unit slip, x2 or √2 a reduced print).

import type { OcrWord } from './ocr.ts';
import { METERS_PER_PT } from './units.ts';

export interface ScaleVote {
  /** drawing ratio N of 1:N */
  ratio: number;
  /** human-readable provenance, e.g. 'text layer 1:100' */
  source: string;
  /** 1 for unambiguous notes and measured dimensions, below 1 for guesses */
  weight: number;
  kind: 'ratio' | 'imperial' | 'size' | 'guess' | 'dimension';
  /** printed next to a SCALE keyword (title-block style) */
  keyword: boolean;
  /** where the note sits (PDF pt), when known */
  at?: { x: number; y: number };
  conf?: number;
}

/** ISO 5455 reductions (1, 2, 5 x 10^n) plus the common AEC 25 / 250 and imperial 48 / 96. */
const PREFERRED = new Set([1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 48, 96, 192, 24, 12]);

const KEYWORD = /^scale\s*:?\s*/i;
const RATIO = /^1\s*:\s*(\d{1,5})$/;
const COLON_SUBSTITUTE = /^1\s*[;|il.]\s*(\d{2,4})$/i;
const SPACED = /^1\s+(\d{2,4})$/;
const RUN_TOGETHER = /^1(\d{2,4})$/;
const INCH = String.raw`(?:"|''|in\b|inch(?:es)?)`;
const FOOT = String.raw`(?:'|ft\b|feet|foot)`;
const ARCH = new RegExp(String.raw`^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*${INCH}\s*=\s*1\s*${FOOT}\s*(?:-?\s*0\s*${INCH}?)?$`, 'i');
const ENG = new RegExp(String.raw`^1\s*${INCH}\s*=\s*(\d+(?:\.\d+)?)\s*${FOOT}\s*(?:-?\s*0\s*${INCH}?)?$`, 'i');
const NTS = /^(n\.?\s*t\.?\s*s\.?|not\s+to\s+scale)$/i;

function inches(raw: string): number {
  const mixed = raw.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
  const frac = raw.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);
  return parseFloat(raw);
}

/**
 * Every scale note in the words, as votes, plus whether the sheet says it is
 * not to scale. Words are tried in reading order as windows of up to six
 * consecutive tokens, so notes split across tokens ("1 : 50",
 * '1/4" = 1'-0"') still parse.
 */
export function scaleVotesFromWords(words: OcrWord[], origin = 'OCR'): { votes: ScaleVote[]; nts: boolean } {
  const clean = words.map((w) => ({ ...w, text: w.text.trim() })).filter((w) => w.text);
  const votes: ScaleVote[] = [];
  let nts = false;
  // one vote per token span end: windows are tried earliest start first, so
  // the longest reading of a note wins over the fragments inside it
  const ended = new Set<number>();
  for (let i = 0; i < clean.length; i++) {
    const prevKeyword = i > 0 && /^scale\s*:?$/i.test(clean[i - 1].text);
    for (let n = 1; n <= 6 && i + n <= clean.length; n++) {
      const joined = clean
        .slice(i, i + n)
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+/g, ' ');
      const keyword = prevKeyword || KEYWORD.test(joined);
      const s = joined.replace(KEYWORD, '').trim();
      if (!s) continue;
      if (NTS.test(s)) {
        nts = true;
        continue;
      }
      const at = { x: clean[i].xPt, y: clean[i].yPt };
      const conf = clean[i].conf;
      let vote: Omit<ScaleVote, 'source'> & { label: string } | null = null;
      let m: RegExpMatchArray | null;
      if ((m = s.match(RATIO))) {
        const ratio = parseInt(m[1], 10);
        if (keyword ? ratio >= 1 : ratio >= 10) vote = { ratio, weight: 1, kind: 'ratio', keyword, label: `1:${ratio}` };
      } else if ((m = s.match(ARCH))) {
        const v = inches(m[1]);
        if (v > 0) vote = { ratio: Math.round((12 / v) * 1000) / 1000, weight: 1, kind: 'imperial', keyword, label: s };
      } else if ((m = s.match(ENG))) {
        const ft = parseFloat(m[1]);
        if (ft > 0) vote = { ratio: 12 * ft, weight: 1, kind: 'imperial', keyword, label: s };
      } else if (/^full\s*size$/i.test(s)) {
        vote = { ratio: 1, weight: 1, kind: 'size', keyword, label: 'FULL SIZE' };
      } else if (/^half\s*size$/i.test(s)) {
        vote = { ratio: 2, weight: 1, kind: 'size', keyword, label: 'HALF SIZE' };
      } else if (keyword && ((m = s.match(COLON_SUBSTITUTE)) || (m = s.match(SPACED)))) {
        const ratio = parseInt(m[1], 10);
        vote = { ratio, weight: 0.5, kind: 'guess', keyword, label: `${s} read as 1:${ratio}` };
      } else if (keyword && (m = s.match(RUN_TOGETHER))) {
        const ratio = parseInt(m[1], 10);
        const whole = parseInt(s, 10);
        if (PREFERRED.has(ratio) && !PREFERRED.has(whole)) {
          vote = { ratio, weight: 0.4, kind: 'guess', keyword, label: `${s} read as 1:${ratio}` };
        }
      }
      if (!vote || vote.ratio > 5000) continue;
      if (ended.has(i + n)) continue;
      ended.add(i + n);
      const { label, ...rest } = vote;
      votes.push({ ...rest, source: `${origin} ${label}`, at, conf });
    }
  }
  return { votes, nts };
}

/** A printed dimension measured against its drawn length, as a vote. */
export function dimensionVote(paperPt: number, printedMeters: number, label = 'dimension'): ScaleVote | null {
  if (!(paperPt > 0) || !(printedMeters > 0)) return null;
  const ratio = printedMeters / (paperPt * METERS_PER_PT);
  return { ratio, source: `${label} ${printedMeters} m over ${paperPt.toFixed(1)} pt`, weight: 1, kind: 'dimension', keyword: false };
}

export interface ScaleConsensus {
  status: 'agreed' | 'conflict' | 'insufficient' | 'none';
  /** the winning ratio (weighted mean of its group) */
  ratio?: number;
  /** total weight behind the winner */
  support: number;
  /** other groups, with their factor to the winner and the likely cause */
  rivals: { ratio: number; support: number; factor: number; likely?: string }[];
  /** the sheet says NTS */
  nts: boolean;
}

/** What a factor between two scale readings most likely means. */
export function diagnoseFactor(factor: number): string | undefined {
  const near = (v: number) => Math.abs(factor / v - 1) < 0.03;
  if (near(6)) return 'a dimension like "1200" misread as 1:200';
  if (near(10)) return 'a unit slip (mm vs cm, or cm vs m)';
  if (near(1000)) return 'a unit slip (mm vs m)';
  if (near(2) || near(Math.SQRT2)) return 'a sheet printed at reduced size (e.g. A1 drawing on A3)';
  if (near(12)) return 'an inches vs feet slip';
  return undefined;
}

/**
 * Group votes within ±tol (relative) and pick the heaviest group. 'agreed'
 * needs at least one full-weight vote in the winner and no rival group with
 * full weight; 'conflict' means a rival carries full weight too (often two
 * viewports at different scales, or a misread); 'insufficient' means only
 * low-weight guesses. Viewport partitions should be voted separately.
 */
export function scaleConsensus(votes: ScaleVote[], nts = false, tol = 0.02): ScaleConsensus {
  if (votes.length === 0) return { status: 'none', support: 0, rivals: [], nts };
  const groups: { ratio: number; support: number; members: ScaleVote[] }[] = [];
  const sorted = [...votes].sort((a, b) => b.weight - a.weight);
  for (const v of sorted) {
    const g = groups.find((x) => Math.abs(v.ratio / x.ratio - 1) <= tol);
    if (g) {
      g.members.push(v);
      g.support += v.weight;
      g.ratio = g.members.reduce((s, m) => s + m.ratio * m.weight, 0) / g.support;
    } else {
      groups.push({ ratio: v.ratio, support: v.weight, members: [v] });
    }
  }
  groups.sort((a, b) => b.support - a.support);
  const [top, ...others] = groups;
  const rivals = others.map((g) => {
    const factor = Math.max(g.ratio, top.ratio) / Math.min(g.ratio, top.ratio);
    const likely = diagnoseFactor(factor);
    return { ratio: g.ratio, support: g.support, factor: Math.round(factor * 1000) / 1000, ...(likely ? { likely } : {}) };
  });
  const strongTop = top.members.some((m) => m.weight >= 1);
  const strongRival = others.some((g) => g.members.some((m) => m.weight >= 1));
  const status = !strongTop ? 'insufficient' : strongRival ? 'conflict' : 'agreed';
  return { status, ratio: top.ratio, support: top.support, rivals, nts };
}

export interface SheetCheck {
  /**
   * agrees: matches the sheet's printed scale; disagrees: differs from it
   * beyond tolerance; ambiguous: the sheet prints several scales and none
   * matches (viewports, details), so no single answer; none / nts: nothing
   * to check against.
   */
  status: 'agrees' | 'disagrees' | 'ambiguous' | 'none' | 'nts';
  sheetRatio?: number;
  likely?: string;
}

/**
 * Check a scale someone set against the sheet's own notes. The main scale is
 * the one printed after a SCALE keyword (title block); detail ratios printed
 * elsewhere never trigger a warning on their own. tol is relative: keep it
 * loose (about 5%) for a scale measured from clicked points, which carries
 * hand-placement error, and tight (2%) for a typed ratio.
 */
export function checkAgainstSheet(ratio: number, votes: ScaleVote[], nts: boolean, tol = 0.05): SheetCheck {
  const full = votes.filter((v) => v.weight >= 1);
  if (full.length === 0) return { status: nts ? 'nts' : 'none' };
  const near = (r: number) => Math.abs(ratio / r - 1) <= tol;
  const main = full.filter((v) => v.keyword);
  const pool = main.length ? main : full;
  if (pool.some((v) => near(v.ratio))) {
    return { status: 'agrees', sheetRatio: pool.find((v) => near(v.ratio))!.ratio };
  }
  const distinct = scaleConsensus(pool, nts, 0.02);
  if (distinct.status !== 'agreed' || distinct.ratio === undefined) return { status: 'ambiguous' };
  const factor = Math.max(ratio, distinct.ratio) / Math.min(ratio, distinct.ratio);
  const likely = diagnoseFactor(factor);
  return { status: 'disagrees', sheetRatio: distinct.ratio, ...(likely ? { likely } : {}) };
}
