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
/** A keyword'd bare architectural fraction: the note's '= 1'-0"' half did not survive the scan. */
const ARCH_LEFT_ONLY = new RegExp(String.raw`^(\d+\/\d+)\s*${INCH}$`, 'i');
const NTS = /^(n\.?\s*t\.?\s*s\.?|not\s+to\s+scale)$/i;

/**
 * The ratios a printed imperial or engineer note can mean: 12 divided by the
 * architectural inch fractions (1/16" to 6" per foot) and 12 times the
 * engineer feet (10 to 100 per inch). A parse outside this set (2.5 percent
 * tolerance) is OCR damage, not a scale: 12/14 from a `1/4"` whose slash the
 * recogniser dropped must be repaired or rejected, never answered with.
 */
const IMPERIAL_RATIOS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 120, 240, 360, 480, 600, 720, 960, 1200];
function nearImperialStandard(ratio: number): boolean {
  return IMPERIAL_RATIOS.some((s) => Math.abs(ratio - s) / s <= 0.025);
}

/** Architectural fractions as the OCR prints them with the slash dropped ("14" for 1/4"). */
const LOST_SLASH: Record<string, string> = {
  '14': '1/4', '18': '1/8', '12': '1/2', '34': '3/4', '38': '3/8',
  '116': '1/16', '316': '3/16', '132': '1/32', '332': '3/32',
};

/**
 * Letter-for-digit slips inside the numbers of a scale note (`2O'` for 20',
 * `IOO` for 100). Applied per token and kept only when the token becomes a
 * pure number with scale punctuation — words are never rewritten.
 */
function repairDigits(s: string): string {
  const slips: Record<string, string> = { O: '0', o: '0', I: '1', l: '1', i: '1', S: '5', B: '8', Z: '2', G: '6' };
  return s
    .split(' ')
    .map((tok) => {
      if (!/[0-9]/.test(tok) && !/[OIl]/.test(tok)) return tok;
      const fixed = tok.replace(/[OoIlisSBZG]/g, (c) => slips[c] ?? c);
      return /^[\d:./'"-]+$/i.test(fixed) || /^[\d./'"-]*(?:ft|in)\b/i.test(fixed) ? fixed : tok;
    })
    .join(' ');
}

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
      const parse = (str: string, repaired: boolean): Omit<ScaleVote, 'source'> & { label: string } | null => {
        let m: RegExpMatchArray | null;
        if ((m = str.match(RATIO))) {
          const ratio = parseInt(m[1], 10);
          if (keyword ? ratio >= 1 : ratio >= 10) return { ratio, weight: repaired ? 0.8 : 1, kind: 'ratio', keyword, label: repaired ? `${str} (digits repaired)` : `1:${ratio}` };
        } else if ((m = str.match(ARCH))) {
          const v = inches(m[1]);
          if (v <= 0) return null;
          let ratio = 12 / v;
          // a parse outside the printed standard is OCR damage: `1/4"` with
          // the slash dropped reads as 14 inches and 12/14 is no scale. Try
          // the fraction with its slash back before giving up
          let via = str;
          if (!nearImperialStandard(ratio) && LOST_SLASH[m[1]]) {
            const mended = LOST_SLASH[m[1]];
            if (nearImperialStandard(12 / inches(mended))) {
              ratio = 12 / inches(mended);
              via = `${mended}" = 1'-0"`;
            }
          }
          if (!nearImperialStandard(ratio)) return null;
          return { ratio: Math.round(ratio * 1000) / 1000, weight: via === str ? 1 : 0.9, kind: 'imperial', keyword, label: via === str ? str : `${str} read as ${via}` };
        } else if ((m = str.match(ENG))) {
          const ft = parseFloat(m[1]);
          if (ft <= 0) return null;
          const ratio = 12 * ft;
          if (!nearImperialStandard(ratio)) return null;
          return { ratio, weight: repaired ? 0.9 : 1, kind: 'imperial', keyword, label: repaired ? `${str} (digits repaired)` : str };
        } else if (keyword && (m = str.match(ARCH_LEFT_ONLY))) {
          // the note's right side is the smallest print in the title block and
          // the first thing a degraded scan destroys: a keyword'd bare
          // fraction ('SCALE: 1/4"', '= 1'-0"' unread) still names the scale,
          // gated to the printed standards and weighted below a whole note
          const v = inches(m[1]);
          const ratio = 12 / v;
          if (nearImperialStandard(ratio)) return { ratio, weight: 0.6, kind: 'imperial', keyword, label: `${str} (right side unread)` };
        } else if (/^full\s*size$/i.test(str)) {
          return { ratio: 1, weight: 1, kind: 'size', keyword, label: 'FULL SIZE' };
        } else if (/^half\s*size$/i.test(str)) {
          return { ratio: 2, weight: 1, kind: 'size', keyword, label: 'HALF SIZE' };
        } else if (keyword && ((m = str.match(COLON_SUBSTITUTE)) || (m = str.match(SPACED)))) {
          const ratio = parseInt(m[1], 10);
          return { ratio, weight: 0.5, kind: 'guess', keyword, label: `${str} read as 1:${ratio}` };
        } else if (keyword && (m = str.match(RUN_TOGETHER))) {
          const ratio = parseInt(m[1], 10);
          const whole = parseInt(str, 10);
          if (PREFERRED.has(ratio) && !PREFERRED.has(whole)) {
            return { ratio, weight: 0.4, kind: 'guess', keyword, label: `${str} read as 1:${ratio}` };
          }
        }
        return null;
      };
      vote = parse(s, false) ?? (() => {
        const fixedStr = repairDigits(s);
        return fixedStr === s ? null : parse(fixedStr, true);
      })();
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
