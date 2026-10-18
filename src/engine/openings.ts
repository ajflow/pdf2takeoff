// Raster opening detector: doors, Window groups and enclosed spaces from a
// rendered or scanned floor plan, without a vector layer and without a
// trained model. Pure typed-array math, environment-agnostic.
//
// Why a separate pass: the click-exemplar scan (scan-cv.ts) matches isolated
// repeated symbols, and door swing arcs are never isolated. The arc, the leaf
// and the wall ink form one connected component, so there is no exemplar to
// click. Dynamic Fill (dynamicfill.ts, fill-vector.ts) already finds door
// gaps between wall ends to close them; this module runs the same idea in
// the other direction, finds every gap in the wall mask and classifies what
// is drawn across it.
//
// Pipeline (all sizes derive from one estimate, the wall thickness t, which
// stands in for the drawing scale: plans here carry no scale and the
// benchmark that motivated the module never needs one):
//   1. binarize (luminance under a threshold, alpha composited on white)
//   2. stroke-width histogram: for every ink pixel the shorter of its
//      horizontal and vertical ink runs, weighted by the longer one and
//      restricted to long runs, so walls dominate and glyph stems and
//      furniture edges barely register. The pen weight (the width that
//      holds the first fifth of the ink) sets a floor; walls are the
//      thinnest significant peak above it (partitions are thinner than the
//      outer walls, and a kernel sized for the outer wall would erase them)
//   3. optionally close with a small square so hatched or double-line walls
//      become solid bands; a closing is kept only when it clearly raises the
//      share of ink that lies in long bands of wall-class thickness
//   4. thin walls (under 7 px) make the page work at an integer upsample,
//      so the opening kernel can sit between the wall and the line weight
//   5. morphological opening with a square just under t: the wall mask
//   6. gaps: along rows and columns, a non-wall run between a wall END
//      (ink that carries on along the run's axis for at least 2t) and wall
//      ink, within a plausible opening width; runs stack across the wall
//      thickness into one gap
//   7. classify each gap by what thin ink (ink minus walls) is drawn in it:
//      an arc from one jamb, of a radius up to the gap width, with its
//      hinge on the other jamb or inside the gap, plus a leaf line where
//      the arc ends, is a door (one per leaf: two arcs from the two jambs
//      are two doors); an angle on the arc only counts when the ink there
//      is a lone thin curve, so hatching, text and stair treads score
//      nothing; parallel lines along an otherwise empty band are a Window
//      group (sliding doors read the same way, as the benchmark wants);
//      anything else is an open passage
//   8. Window groups closer than one wall thickness merge (adjacent units
//      without a wall between them count as one group)
//   9. spaces: flood-fill the complement of the wall mask with every gap
//      bridged, count enclosed regions above a minimum area, exterior out
//
// Coordinates: Opening.px fields are page pixels (top-left origin), `at`
// is the gap centre in PDF user space via RasterPage.toPdf; the wall mask
// in WallSummary is at the working scale.

import type { Pt } from './types.ts';
import type { RasterPage } from './ports.ts';

export interface OpeningOptions {
  /** Luminance (0..255) below which a pixel is ink. Scans and light hatch need a high value. */
  inkThreshold: number;
  /** Closing radii (px at the page scale) tried before the wall estimate. [0] disables. */
  closeRadii: number[];
  /** A closing is used only when its wall score beats no closing by this factor (hatched walls score near zero unclosed). */
  closeGain: number;
  /** Fixed closing radius (px); overrides the automatic choice when set. */
  closeRadius?: number;
  /** Walls thinner than this (px) make the page work at an integer upsample so the kernel can separate walls from lines. */
  minWorkingT: number;
  /** Largest upsample factor, and the working-pixel budget that caps it. */
  maxUpsample: number;
  maxWorkingPx: number;
  /** Smallest stroke width (px) that can be a wall; thinner peaks are text and furniture. */
  minWallPx: number;
  /** The same floor as a share of the longer page side (300 dpi text strokes are 3 px). */
  minWallFraction: number;
  /** The same floor as a multiple of the pen weight (the width at which penShare of the ink count is reached). */
  penGain: number;
  penShare: number;
  /** A wall run counts as long when it spans this share of the longer page side (closing-radius score). */
  longRunFraction: number;
  /** The thickness histogram only counts ink on runs of this share of the longer page side (walls, not furniture). */
  histLongFraction: number;
  /** Largest stroke width (px) considered in the thickness histogram. */
  maxWallPx: number;
  /** A thickness peak counts as a wall class when its mass is at least this share of the strongest peak. */
  peakShare: number;
  /** Fixed wall thickness (px); overrides the histogram estimate when set. */
  wallThicknessPx?: number;
  /** Opening kernel side as a fraction of the wall thickness (kept odd, at least 3). */
  kernelFraction: number;
  /** Wall-mask blobs whose bounding box is shorter than this many t on both axes are dropped. */
  minWallBlobT: number;
  /** Gap widths considered, in multiples of t. */
  minGapT: number;
  maxGapT: number;
  /** A wall end must carry on along the gap axis for at least this many t. */
  wallEndT: number;
  /** Gap stacks thicker than this many t are not openings (corridors between wall sides). */
  maxGapThicknessT: number;
  /** Door arc: share of sampled arc angles that must find thin ink. */
  arcScore: number;
  /** Door arc without a visible leaf line: the arc alone must reach this share. */
  arcScoreAlone: number;
  /** Door arc on a gap that also carries Window lines: the arc must reach this share (with a leaf). */
  arcScoreOverLines: number;
  /** Door arc on a gap crossed by one full-length line (a threshold): the arc must reach this share. */
  arcScoreOverLine: number;
  /** A shorter arc (leaf drawn part open) passes when the leaf line is at least strongLeaf covered. */
  arcScoreWithLeaf: number;
  strongLeaf: number;
  /** Smallest leaf considered, in wall thicknesses. */
  minLeafT: number;
  /** Radial tolerance of the arc test as a fraction of the radius (at least 1.5 px). */
  arcTolerance: number;
  /** Door leaf: share of the leaf line that must find ink. */
  leafScore: number;
  /** Single-leaf arc radius range as a fraction of the gap width. */
  leafRadius: [number, number];
  /** Radius range, as a fraction of the gap width, for two leaves sharing one gap (a double door, or two doors side by side). */
  halfLeafRadius: [number, number];
  /** Window: share of the gap length a line along the gap must cover. */
  lineCover: number;
  /** Window: lines needed across the gap (1 accepts a single glazing line). */
  minLines: number;
  /** Window: union coverage of all offsets across the gap that also qualifies (sliding doors). */
  unionCover: number;
  /** Window: the band's offsets that are not lines may carry at most this mean coverage. */
  maxClutter: number;
  /** Window: union coverage at which a single line already reads as glazing (door arcs must then be near complete). */
  fullCover: number;
  /** Window groups separated by less than this many t merge into one group. */
  mergeGapT: number;
  /** Space: minimum enclosed area in t squared. */
  minSpaceAreaT2: number;
  /** Space: gaps up to this many t wide are bridged before counting (wider ones stay open). */
  spaceBridgeT: number;
}

export const DEFAULT_OPENING_OPTIONS: OpeningOptions = {
  inkThreshold: 200,
  closeRadii: [0, 1, 2, 3],
  closeGain: 1.5,
  minWorkingT: 7,
  maxUpsample: 3,
  maxWorkingPx: 16e6,
  minWallPx: 3,
  minWallFraction: 0.0015,
  penGain: 1.6,
  penShare: 0.2,
  longRunFraction: 0.03,
  histLongFraction: 0.08,
  maxWallPx: 80,
  peakShare: 0.1,
  kernelFraction: 0.75,
  minWallBlobT: 4,
  minGapT: 1.5,
  maxGapT: 25,
  wallEndT: 2,
  maxGapThicknessT: 5,
  arcScore: 0.45,
  arcScoreAlone: 0.75,
  arcScoreOverLines: 0.85,
  arcScoreOverLine: 0.6,
  arcScoreWithLeaf: 0.35,
  strongLeaf: 0.7,
  minLeafT: 2,
  arcTolerance: 0.03,
  leafScore: 0.35,
  leafRadius: [0.2, 1.15],
  halfLeafRadius: [0.2, 0.6],
  lineCover: 0.6,
  minLines: 2,
  unionCover: 0.85,
  maxClutter: 0.2,
  fullCover: 0.95,
  mergeGapT: 1.0,
  minSpaceAreaT2: 30,
  spaceBridgeT: 25,
};

export type OpeningKind = 'door' | 'windowGroup' | 'passage';

export interface Opening {
  kind: OpeningKind;
  /** 'h': the gap runs along x (a horizontal wall); 'v': along y. */
  axis: 'h' | 'v';
  /** Gap bounding box in raster px, spanning the wall thickness. */
  px: { x0: number; y0: number; x1: number; y1: number };
  /** Gap width (px) between the jambs. */
  widthPx: number;
  /** Wall thickness (px) at the gap. */
  wallPx: number;
  /** Gap centre in PDF user space. */
  at: Pt;
  /** Door: hinge point (page px, on a jamb or inside the gap), swing side and arc radius found. */
  hinge?: { x: number; y: number; side: 1 | -1; radiusPx: number };
  /** Door: 1 for a single leaf, 2 when the gap holds two leaves (reported once per leaf). */
  leaves?: number;
  /** Window group: how many gaps merged into it. */
  units?: number;
  /** Classifier confidence 0..1 (arc score for doors, line cover for Window groups). */
  score: number;
  /** What the classifier measured on this gap (for tuning and the harness probe). */
  detail?: OpeningDetail;
}

export interface OpeningDetail {
  /** Best arc per far jamb and swing side: 'A' is the jamb at the smaller along-coordinate; the hinge is radiusPx from it. */
  arcs: { jamb: 'A' | 'B'; side: 1 | -1; score: number; radiusPx: number; leaf: number; half: boolean }[];
  /** Lines along the gap across the wall band, their union coverage, and the mean coverage of the other offsets. */
  lines: number;
  union: number;
  bestLine: number;
  clutter: number;
}

export interface WallSummary {
  /** Size of `mask`: the page size times `scale`. */
  width: number;
  height: number;
  /** Integer upsample the detector worked at (1 = page pixels). */
  scale: number;
  /** Wall thickness estimate (page px). */
  thicknessPx: number;
  /** Closing radius used before the estimate (working px). */
  closeRadiusPx: number;
  /** Opening kernel side (working px). */
  kernelPx: number;
  /** Share of pixels that are ink / wall. */
  inkFraction: number;
  wallFraction: number;
  /** Wall score of the chosen estimate (share of ink in long wall bands). */
  score: number;
  /** Length-weighted stroke-width histogram the thickness came from (working px bins). */
  histogram: Float64Array;
  /** Every closing radius tried at the working scale, with its thickness, kernel, score and long-run histogram. */
  tried: { r: number; t: number; k: number; score: number; histogram: Float64Array }[];
  /** Pen weight (page px), the resulting wall floor, and the pixel-count stroke histogram of the raw ink. */
  penPx: number;
  minWallPx: number;
  countHistogram: Float64Array;
  /** 1 = wall, row-major, at the working scale. */
  mask: Uint8Array;
}

export interface OpeningsResult {
  doors: Opening[];
  windows: Opening[];
  passages: Opening[];
  walls: WallSummary;
}

export interface SpaceResult {
  count: number;
  spaces: { areaPx: number; x0: number; y0: number; x1: number; y1: number; at: Pt }[];
  /** Enclosed regions rejected as too small. */
  rejected: number;
  /** Every region that does not touch the page edge (page px), with why it was dropped if it was. */
  regions: { areaPx: number; x0: number; y0: number; x1: number; y1: number; dropped?: 'small' | 'exterior' }[];
}

// --- binary morphology (separable square structuring elements) ---------------

/** 1-D erosion along x with half-length r: 1 where all of x-r..x+r are 1 (outside = 0). */
function erodeX(src: Uint8Array, w: number, h: number, r: number, out: Uint8Array): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    // run of consecutive ones ending at x
    let run = 0;
    for (let x = 0; x < w; x++) {
      run = src[row + x] ? run + 1 : 0;
      // the span x-2r..x is all ones when run >= 2r+1; it is centred at x-r
      const c = x - r;
      if (c >= 0) out[row + c] = run >= 2 * r + 1 ? 1 : 0;
    }
    for (let c = Math.max(0, w - r); c < w; c++) out[row + c] = 0;
  }
}

function erodeY(src: Uint8Array, w: number, h: number, r: number, out: Uint8Array): void {
  const run = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const c = y - r;
    const crow = c * w;
    for (let x = 0; x < w; x++) {
      run[x] = src[row + x] ? run[x] + 1 : 0;
      if (c >= 0) out[crow + x] = run[x] >= 2 * r + 1 ? 1 : 0;
    }
  }
  for (let c = Math.max(0, h - r); c < h; c++) out.fill(0, c * w, (c + 1) * w);
}

/** 1-D dilation along x with half-length r: 1 where any of x-r..x+r is 1. */
function dilateX(src: Uint8Array, w: number, h: number, r: number, out: Uint8Array): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1e9; // x of the most recent ink
    for (let x = 0; x < w; x++) {
      if (src[row + x]) last = x;
      const c = x - r;
      if (c >= 0) out[row + c] = x - last <= 2 * r ? 1 : 0;
    }
    for (let c = Math.max(0, w - r); c < w; c++) {
      let v = 0;
      for (let x = c - r; x < w; x++) if (x >= 0 && src[row + x]) { v = 1; break; }
      out[row + c] = v;
    }
  }
}

function dilateY(src: Uint8Array, w: number, h: number, r: number, out: Uint8Array): void {
  const last = new Int32Array(w).fill(-1e9);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const c = y - r;
    const crow = c * w;
    for (let x = 0; x < w; x++) {
      if (src[row + x]) last[x] = y;
      if (c >= 0) out[crow + x] = y - last[x] <= 2 * r ? 1 : 0;
    }
  }
  for (let c = Math.max(0, h - r); c < h; c++) {
    for (let x = 0; x < w; x++) out[c * w + x] = c - last[x] <= r ? 1 : 0;
  }
}

function erode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src.slice();
  const a = new Uint8Array(w * h);
  const b = new Uint8Array(w * h);
  erodeX(src, w, h, r, a);
  erodeY(a, w, h, r, b);
  return b;
}

function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return src.slice();
  const a = new Uint8Array(w * h);
  const b = new Uint8Array(w * h);
  dilateX(src, w, h, r, a);
  dilateY(a, w, h, r, b);
  return b;
}

/** Opening with a (2r+1) square: erode then dilate. Keeps strokes thicker than 2r+1. */
export function openMask(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return dilate(erode(src, w, h, r), w, h, r);
}

/** Closing with a (2r+1) square: dilate then erode. Fills gaps up to 2r without thickening isolated strokes. */
export function closeMask(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return erode(dilate(src, w, h, r), w, h, r);
}
const open = openMask;
const close = closeMask;

// --- run lengths and stroke width ----------------------------------------------

/** For each pixel the length of the horizontal run of ones containing it (0 off ink). */
function hRuns(src: Uint8Array, w: number, h: number): Uint16Array {
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!src[row + x]) { x++; continue; }
      const a = x;
      while (x < w && src[row + x]) x++;
      const n = Math.min(65535, x - a);
      for (let i = row + a; i < row + x; i++) out[i] = n;
    }
  }
  return out;
}

function vRuns(src: Uint8Array, w: number, h: number): Uint16Array {
  const out = new Uint16Array(w * h);
  const start = new Int32Array(w).fill(-1);
  const flush = (x: number, end: number) => {
    const a = start[x];
    const n = Math.min(65535, end - a);
    for (let y = a; y < end; y++) out[y * w + x] = n;
    start[x] = -1;
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (src[row + x]) {
        if (start[x] < 0) start[x] = y;
      } else if (start[x] >= 0) flush(x, y);
    }
  }
  for (let x = 0; x < w; x++) if (start[x] >= 0) flush(x, h);
  return out;
}

/**
 * Stroke-width histogram: ink pixels binned by min(horizontal run, vertical
 * run), each weighted by the longer run. Walls are long bands, so their bins
 * dominate; glyph stems and furniture edges are short and barely register
 * even where their stroke width matches a partition.
 */
export function strokeHistogram(
  src: Uint8Array,
  w: number,
  h: number,
  maxW: number,
  scale = 1,
  longPx = 0,
): { weighted: Float64Array; count: Float64Array; long: Float64Array } {
  const hr = hRuns(src, w, h);
  const vr = vRuns(src, w, h);
  const weighted = new Float64Array(maxW + 1);
  const count = new Float64Array(maxW + 1);
  // `long` keeps only ink on runs of at least longPx: walls are the only
  // bands that long, so closed text and paired furniture lines drop out
  const long = new Float64Array(maxW + 1);
  for (let i = 0; i < src.length; i++) {
    if (!src[i]) continue;
    const a = hr[i];
    const b = vr[i];
    // bins are page pixels: an upsampled mask only has widths that are
    // multiples of the scale, which would leave empty bins between peaks.
    // Ink wider than maxW is not a wall candidate (filled title blocks, fat
    // blobs) — it is dropped, never clamped: clamping piles it into the last
    // bin, where it becomes a phantom strongest peak and the estimator
    // silently latches onto it (all-zero detections on thin-line drawings).
    const s = Math.round(Math.min(a, b) / scale);
    if (s > maxW) continue;
    const len = Math.max(a, b);
    weighted[s] += len;
    count[s]++;
    if (len >= longPx) long[s] += len;
  }
  return { weighted, count, long };
}

/**
 * The drawing's pen weight (px): the stroke width at which the cumulative
 * pixel count first reaches `share` of all ink. Text, arcs, furniture and
 * dimension lines are the thinnest ink on the sheet, so the first fifth of
 * the ink by width is drawn with the pen; walls dominate the ink on many
 * plans, so the overall mode would be the wall itself.
 */
function penWeight(count: Float64Array, share: number): number {
  let total = 0;
  for (let i = 1; i < count.length; i++) total += count[i];
  let cum = 0;
  for (let i = 1; i < count.length - 1; i++) {
    cum += count[i];
    if (cum >= share * total) return i;
  }
  return 1;
}

/** The heaviest wall class: the strongest bin at or above minWallPx. */
function heaviestPeak(hist: Float64Array, minWallPx: number): number {
  let best = minWallPx;
  for (let i = minWallPx; i < hist.length - 1; i++) if (hist[i] > hist[best]) best = i;
  return best;
}

/**
 * Wall thickness from the stroke-width histogram: the thinnest local peak at
 * or above minWallPx whose mass is at least peakShare of the strongest peak
 * in that range. Peaks are read on a histogram smoothed over +-smooth bins,
 * so a wall drawn at 7 and 8 px (anti-aliasing) is one peak and an
 * upsampled mask, whose widths are all multiples of the scale, has no
 * phantom peaks at every bin.
 */
function wallThickness(hist: Float64Array, minWallPx: number, peakShare: number, smooth: number): number {
  const n = hist.length;
  const sm = new Float64Array(n);
  // the last bin is excluded everywhere (as in heaviestPeak): it only bounds
  // the array, and any mass that lands there is not a wall candidate
  for (let i = minWallPx; i < n - 1; i++) {
    let s = 0;
    let k = 0;
    // bins under the floor are pen strokes; they must not smear into the first wall bin
    for (let j = Math.max(minWallPx, i - smooth); j <= Math.min(n - 2, i + smooth); j++) { s += hist[j]; k++; }
    sm[i] = k ? s / k : 0;
  }
  let strongest = 0;
  for (let i = minWallPx; i < n - 1; i++) strongest = Math.max(strongest, sm[i]);
  if (strongest <= 0) return minWallPx;
  for (let i = minWallPx; i < n - 1; i++) {
    const left = i > 0 ? sm[i - 1] : 0;
    const right = i < n - 1 ? sm[i + 1] : 0;
    if (sm[i] >= left && sm[i] >= right && sm[i] >= peakShare * strongest) {
      // centre of mass over the peak's neighbours, so 7/8 px walls read as 7.5
      const num = (i - 1) * left + i * sm[i] + (i + 1) * right;
      const den = left + sm[i] + right;
      return den > 0 ? num / den : i;
    }
  }
  // no local peak: fall back to the strongest bin
  for (let i = minWallPx; i < n; i++) if (sm[i] === strongest) return i;
  return minWallPx;
}

// --- connected components ---------------------------------------------------------

/** Clears blobs whose bounding box is shorter than minLen on both axes (4-connected). */
function dropSmallBlobs(mask: Uint8Array, w: number, h: number, minLen: number): void {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const members: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    members.length = 0;
    stack.push(start);
    seen[start] = 1;
    let x0 = start % w;
    let x1 = x0;
    let y0 = (start / w) | 0;
    let y1 = y0;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || !mask[j] || seen[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (x1 - x0 + 1 < minLen && y1 - y0 + 1 < minLen) for (const i of members) mask[i] = 0;
  }
}

// --- wall mask ------------------------------------------------------------------------

interface WallEstimate {
  closed: Uint8Array;
  wall: Uint8Array;
  t: number;
  r: number;
  k: number;
  histogram: Float64Array;
  score: number;
  tried?: { r: number; t: number; k: number; score: number; histogram: Float64Array }[];
  pen?: number;
  minWall?: number;
  countHistogram?: Float64Array;
}

/**
 * Share of the original ink that the wall mask keeps AND that lies on an
 * axis run of at least longPx: solid wall bands score high, hatch lines and
 * text score low. The length is absolute (a share of the page size), not a
 * multiple of t, so a wrong small t cannot flatter itself. Used to pick the
 * closing radius.
 */
function wallScore(ink: Uint8Array, wall: Uint8Array, w: number, h: number, t: number, tHeavy: number, longPx: number, inkCount: number): number {
  const hr = hRuns(wall, w, h);
  const vr = vRuns(wall, w, h);
  // only band-shaped wall, from the thinnest wall class up to the heaviest:
  // closing a floor hatch yields blocks far thicker than any wall, and the
  // outlines of an unclosed hatched wall are thinner than the thinnest
  const lo = 0.7 * t;
  const hi = 1.5 * Math.max(t, tHeavy);
  let n = 0;
  for (let i = 0; i < wall.length; i++) {
    if (!ink[i] || !wall[i]) continue;
    const a = hr[i];
    const b = vr[i];
    const across = Math.min(a, b);
    if (across < lo || across > hi) continue;
    if (Math.max(a, b) >= longPx) n++;
  }
  return inkCount > 0 ? n / inkCount : 0;
}

/** Nearest-neighbour upsample of a mask by an integer factor. */
function upsample(src: Uint8Array, w: number, h: number, s: number): Uint8Array {
  const W = w * s;
  const out = new Uint8Array(W * h * s);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const orow = y * s * W;
    for (let x = 0; x < w; x++) {
      if (!src[row + x]) continue;
      for (let dx = 0; dx < s; dx++) out[orow + x * s + dx] = 1;
    }
    for (let dy = 1; dy < s; dy++) out.copyWithin(orow + dy * W, orow, orow + W);
  }
  return out;
}

/**
 * Wall mask and thickness at one working scale. `scale` multiplies the
 * closing radii (given at page scale) and the thickness floor.
 */
function estimateWalls(ink: Uint8Array, w: number, h: number, o: OpeningOptions, scale: number): WallEstimate {
  let inkCount = 0;
  for (let i = 0; i < ink.length; i++) inkCount += ink[i];
  const radii = (o.closeRadius !== undefined ? [o.closeRadius] : o.closeRadii).map((r) => r * scale);
  if (!radii.includes(0)) radii.unshift(0);
  const longPx = Math.round(o.longRunFraction * Math.max(w, h));
  const histLongPx = Math.round(o.histLongFraction * Math.max(w, h));
  const tried: WallEstimate[] = [];
  // thickness analysis is in page pixels whatever the working scale
  let minWall = Math.max(o.minWallPx, Math.round((o.minWallFraction * Math.max(w, h)) / scale));
  let pen = 1;
  let countHistogram: Float64Array = new Float64Array(0);
  for (const r of radii) {
    const closed = r > 0 ? close(ink, w, h, r) : ink;
    const hist = strokeHistogram(closed, w, h, o.maxWallPx, scale, histLongPx);
    // the unclosed ink sets the pen weight: a wall is clearly heavier than
    // the pen, however long the dimension lines drawn with it are
    if (r === 0) {
      pen = penWeight(hist.count, o.penShare);
      // a sheet with little thin ink reaches the pen share only at a wall
      // width; a pen at half the heaviest class above it is no pen
      if (pen >= 0.5 * heaviestPeak(hist.long, Math.ceil(o.penGain * pen) + 1)) pen = 1;
      minWall = Math.max(minWall, Math.ceil(o.penGain * pen));
      countHistogram = hist.count;
    }
    const histogram = hist.long;
    const t = o.wallThicknessPx !== undefined ? o.wallThicknessPx * scale : wallThickness(histogram, minWall, o.peakShare, 1) * scale;
    const tHeavy = heaviestPeak(histogram, minWall) * scale;
    // odd kernel just under the wall thickness
    let k = Math.floor(o.kernelFraction * t);
    if (k % 2 === 0) k--;
    k = Math.max(3, k);
    const wall = open(closed, w, h, (k - 1) / 2);
    dropSmallBlobs(wall, w, h, Math.round(o.minWallBlobT * t));
    tried.push({ closed, wall, t, r, k, histogram, score: wallScore(ink, wall, w, h, t, tHeavy, longPx, inkCount) });
  }
  // closing fuses text lines into bars that look like walls, so it has to
  // earn its place: only when it beats the unclosed score by closeGain (a
  // hatched or double-line wall barely scores unclosed) does the best
  // closed estimate win
  const plain = tried.find((e) => e.r === 0)!;
  let best = plain;
  if (o.closeRadius !== undefined) best = tried[tried.length - 1];
  else for (const e of tried) if (e.score >= o.closeGain * plain.score && e.score > best.score) best = e;
  best.tried = tried.map((e) => ({ r: e.r, t: e.t, k: e.k, score: e.score, histogram: e.histogram }));
  best.pen = pen;
  best.minWall = minWall;
  best.countHistogram = countHistogram;
  return best;
}

// --- gaps ----------------------------------------------------------------------------------

interface Gap {
  axis: 'h' | 'v';
  /** along-axis extent of the non-wall run: a = first free px, b = first wall px after */
  a: number;
  b: number;
  /** across-axis extent (rows for 'h', columns for 'v'), inclusive */
  c0: number;
  c1: number;
  /** median wall run lengths beyond each jamb */
  alongA: number;
  alongB: number;
}

/**
 * Non-wall runs between wall ink along one axis, stacked across the other
 * axis into gaps. get(along, across) reads the mask; runs(along, across) the
 * wall run length at a pixel.
 */
function scanGaps(
  axis: 'h' | 'v',
  nAlong: number,
  nAcross: number,
  get: (a: number, c: number) => number,
  runAt: (a: number, c: number) => number,
  minGap: number,
  maxGap: number,
  wallEnd: number,
  joinTol: number,
): Gap[] {
  interface Live { a: number; b: number; c0: number; c1: number; alongA: number[]; alongB: number[]; sumA: number; sumB: number; n: number }
  const live: Live[] = [];
  const done: Gap[] = [];
  const finish = (g: Live) => {
    const med = (v: number[]) => v.slice().sort((p, q) => p - q)[v.length >> 1];
    done.push({ axis, a: Math.round(g.sumA / g.n), b: Math.round(g.sumB / g.n), c0: g.c0, c1: g.c1, alongA: med(g.alongA), alongB: med(g.alongB) });
  };
  for (let c = 0; c < nAcross; c++) {
    let p = 0;
    const found: { a: number; b: number; alongA: number; alongB: number }[] = [];
    while (p < nAlong) {
      if (get(p, c)) { p++; continue; }
      const a = p;
      while (p < nAlong && !get(p, c)) p++;
      const b = p;
      if (a === 0 || b >= nAlong) continue;
      const L = b - a;
      if (L < minGap || L > maxGap) continue;
      const alongA = runAt(a - 1, c);
      const alongB = runAt(b, c);
      if (alongA < wallEnd && alongB < wallEnd) continue;
      found.push({ a, b, alongA, alongB });
    }
    // continue live gaps, retire the ones nothing continued
    const next: Live[] = [];
    for (const f of found) {
      let hit: Live | null = null;
      for (const g of live) {
        if (g.c1 >= c - 2 && Math.abs(g.sumA / g.n - f.a) <= joinTol && Math.abs(g.sumB / g.n - f.b) <= joinTol) { hit = g; break; }
      }
      if (hit) {
        hit.c1 = c;
        hit.sumA += f.a;
        hit.sumB += f.b;
        hit.n++;
        hit.alongA.push(f.alongA);
        hit.alongB.push(f.alongB);
        if (!next.includes(hit)) next.push(hit);
      } else {
        next.push({ a: f.a, b: f.b, c0: c, c1: c, alongA: [f.alongA], alongB: [f.alongB], sumA: f.a, sumB: f.b, n: 1 });
      }
    }
    for (const g of live) if (!next.includes(g)) { if (g.c1 >= c - 2) next.push(g); else finish(g); }
    live.length = 0;
    live.push(...next);
  }
  for (const g of live) finish(g);
  return done;
}

function findGaps(wall: Uint8Array, w: number, h: number, t: number, o: OpeningOptions): Gap[] {
  const hr = hRuns(wall, w, h);
  const vr = vRuns(wall, w, h);
  const minGap = o.minGapT * t;
  const maxGap = o.maxGapT * t;
  const wallEnd = o.wallEndT * t;
  const joinTol = Math.max(3, 0.3 * t);
  const rows = scanGaps('h', w, h, (x, y) => wall[y * w + x], (x, y) => hr[y * w + x], minGap, maxGap, wallEnd, joinTol);
  const cols = scanGaps('v', h, w, (y, x) => wall[y * w + x], (y, x) => vr[y * w + x], minGap, maxGap, wallEnd, joinTol);
  const maxTh = o.maxGapThicknessT * t;
  const minTh = Math.max(2, 0.5 * t);
  return [...rows, ...cols].filter((g) => {
    const th = g.c1 - g.c0 + 1;
    if (th < minTh || th > maxTh) return false;
    // a wall end is longer than the gap stack is thick (a wall side facing a
    // corridor is not), and at least one jamb must be a wall end
    const endA = g.alongA >= wallEnd && g.alongA >= 2 * th;
    const endB = g.alongB >= wallEnd && g.alongB >= 2 * th;
    return endA || endB;
  });
}

// --- classification ----------------------------------------------------------------------

interface Classified {
  gap: Gap;
  kind: OpeningKind;
  score: number;
  hinges: { x: number; y: number; side: 1 | -1; radiusPx: number; score: number }[];
  detail: OpeningDetail;
}

/** Point at polar (r, deg) from a hinge, in the gap's frame: `dir` is toward the far jamb, `side` the swing side. */
function polar(axis: 'h' | 'v', hx: number, hy: number, dir: 1 | -1, side: 1 | -1, r: number, deg: number): { x: number; y: number } {
  const th = (deg * Math.PI) / 180;
  const along = Math.cos(th) * dir * r;
  const across = Math.sin(th) * side * r;
  return axis === 'h' ? { x: hx + along, y: hy + across } : { x: hx + across, y: hy + along };
}

/**
 * Samples thin ink on one arc of radius r centred at a hinge, from the far
 * jamb (0 degrees, direction `dir`) toward the leaf (90 degrees, side
 * `side`). A door swing is drawn as a quarter circle when the leaf is shown
 * fully open, or as a shorter arc from the far jamb to the leaf when the
 * leaf is drawn part open, so the score is the share of the quarter sweep
 * with hits, anchored at the far jamb, and `endDeg` is where the hits run
 * out (where the leaf is).
 *
 * An angle is a clean hit when ink sits on the radius band, continues
 * into a neighbouring angle, and the bands just inside and outside are
 * empty: a drawn arc is a lone thin curve, while hatching, text and stair
 * treads fill every band. Ink on the band with ink beside it is
 * ambiguous (a crossing line, a tag, text over the arc) and counts half;
 * a hatch is ambiguous everywhere and never clean, and the arc must start
 * clean at the far jamb.
 */
function arcScoreAt(
  thin: Uint8Array,
  w: number,
  h: number,
  axis: 'h' | 'v',
  hx: number,
  hy: number,
  dir: 1 | -1,
  side: 1 | -1,
  r: number,
  tolFrac: number,
): { score: number; endDeg: number } {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? thin[y * w + x] : 0);
  const DEG0 = 6;
  const DEG1 = 90;
  const tol = Math.max(1.5, tolFrac * r);
  const n = Math.max(16, Math.round(1.4 * r));
  const on = new Uint8Array(n);
  const off = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const deg = DEG0 + ((DEG1 - DEG0) * i) / (n - 1);
    const inkAt = (rr: number) => {
      const p = polar(axis, hx, hy, dir, side, rr, deg);
      return at(Math.round(p.x), Math.round(p.y));
    };
    for (let d = -tol; d <= tol && !on[i]; d += 1) on[i] = inkAt(r + d);
    if (!on[i]) continue;
    for (let d = 1.5 * tol; d <= 3.5 * tol && !off[i]; d += 1) off[i] = inkAt(r - d) || inkAt(r + d);
  }
  // 2 = clean, 1 = ambiguous, 0 = miss
  const hit = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    const continues = (i > 0 && on[i - 1]) || (i < n - 1 && on[i + 1]);
    hit[i] = off[i] || !continues ? 1 : 2;
  }
  let first = -1;
  let clean = 0;
  let ambiguous = 0;
  for (let i = 0; i < n; i++) {
    if (hit[i] && first < 0) first = i;
    if (hit[i] === 2) clean++;
    else if (hit[i] === 1) ambiguous++;
  }
  // anchored at the far jamb (jamb boxes and returns make the start
  // ambiguous, so any hit counts there), and clean somewhere; ambiguous
  // hits only ever add to clean ones, never replace them, so a texture
  // that is ambiguous everywhere scores nothing
  if (first < 0 || first > n / 4 || clean === 0) return { score: 0, endDeg: 90 };
  const weight = clean + 0.5 * Math.min(ambiguous, clean);
  // the leaf sits where the hits run out: the angle by which 90% of the clean hits have occurred
  let acc = 0;
  let end = first;
  for (let i = 0; i < n; i++) {
    if (hit[i] === 2) acc++;
    if (hit[i] && acc <= 0.9 * clean) end = i;
  }
  return { score: weight / n, endDeg: DEG0 + ((DEG1 - DEG0) * end) / (n - 1) };
}

/**
 * Share of a leaf line that carries ink: the radial from the hinge at
 * `deg` (where the arc ends), between 0.2 r and 0.9 r, clear of the wall.
 */
function leafScore(ink: Uint8Array, w: number, h: number, axis: 'h' | 'v', hx: number, hy: number, dir: 1 | -1, side: 1 | -1, r: number, deg: number, wallPx: number): number {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? ink[y * w + x] : 0);
  const from = Math.max(wallPx / 2 + 2, 0.2 * r);
  const to = 0.9 * r;
  if (to <= from) return 0;
  let n = 0;
  let hits = 0;
  for (let d = from; d <= to; d += 1) {
    n++;
    const p = polar(axis, hx, hy, dir, side, d, deg);
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (at(x, y) || at(x + 1, y) || at(x - 1, y) || at(x, y + 1) || at(x, y - 1)) hits++;
  }
  return n ? hits / n : 0;
}

/**
 * Lines along the gap: coverage per across-offset over the wall band (plus
 * 2 px either side), the union coverage of all offsets, and the clutter:
 * mean coverage of the offsets that are not part of a line. A Window band
 * is empty apart from its glazing lines; stair treads, text and fixtures
 * between two wall ends fill the band.
 */
function lineScores(ink: Uint8Array, w: number, h: number, g: Gap, lineCover: number): { lines: number; union: number; best: number; clutter: number } {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? ink[y * w + x] : 0);
  const th = g.c1 - g.c0 + 1;
  const cc = (g.c0 + g.c1) / 2;
  const a0 = g.a + 1;
  const a1 = g.b - 2;
  const len = a1 - a0 + 1;
  if (len < 3) return { lines: 0, union: 0, best: 0, clutter: 0 };
  const lo = Math.round(cc - th / 2 - 2);
  const hi = Math.round(cc + th / 2 + 2);
  const unionHit = new Uint8Array(len);
  const cover: number[] = [];
  for (let c = lo; c <= hi; c++) {
    let hits = 0;
    for (let p = a0; p <= a1; p++) {
      const v = g.axis === 'h' ? at(p, c) : at(c, p);
      if (v) { hits++; unionHit[p - a0] = 1; }
    }
    cover.push(hits / len);
  }
  let lines = 0;
  let best = 0;
  const inLine = cover.map((cv) => cv >= lineCover);
  for (let i = 0; i < cover.length; i++) {
    best = Math.max(best, cover[i]);
    if (inLine[i] && !(i > 0 && inLine[i - 1])) lines++;
  }
  // offsets next to a line carry its anti-aliasing, so they are not clutter
  let clutterSum = 0;
  let clutterN = 0;
  for (let i = 0; i < cover.length; i++) {
    if (inLine[i] || (i > 0 && inLine[i - 1]) || (i < cover.length - 1 && inLine[i + 1])) continue;
    clutterSum += cover[i];
    clutterN++;
  }
  let u = 0;
  for (let i = 0; i < len; i++) u += unionHit[i];
  return { lines, union: u / len, best, clutter: clutterN ? clutterSum / clutterN : 0 };
}

function classify(gap: Gap, ink: Uint8Array, thin: Uint8Array, w: number, h: number, wallEndPx: number, o: OpeningOptions): Classified {
  const L = gap.b - gap.a;
  const th = gap.c1 - gap.c0 + 1;
  const cc = (gap.c0 + gap.c1) / 2;
  // jamb centres
  const jambs: { x: number; y: number; dir: 1 | -1 }[] =
    gap.axis === 'h'
      ? [{ x: gap.a - 1, y: cc, dir: 1 }, { x: gap.b, y: cc, dir: -1 }]
      : [{ x: cc, y: gap.a - 1, dir: 1 }, { x: cc, y: gap.b, dir: -1 }];
  const hinges: Classified['hinges'] = [];
  // lines along the gap first: two full-length lines are a Window (or a
  // sliding door, which the benchmark counts as one) unless the door
  // evidence is near perfect
  const ls = lineScores(ink, w, h, gap, o.lineCover);
  // a band fully covered along the gap by one or more lines reads as glazing
  // (doorways with a threshold line also qualify, so the door test below
  // then needs a near-complete arc)
  const multiLined = ls.clutter <= o.maxClutter && ls.lines >= o.minLines && ls.union >= o.unionCover;
  const lined = multiLined || (ls.clutter <= o.maxClutter && ls.lines >= 1 && ls.union >= o.fullCover);
  // over several lines only a near-complete arc is a door; over a single
  // full-length line (a threshold) a good arc with a clear leaf is
  const arcOverLines = multiLined ? o.arcScoreOverLines : o.arcScoreOverLine;
  const leafOverLines = multiLined ? o.leafScore : o.strongLeaf * 0.7;
  const detail: OpeningDetail = { arcs: [], lines: ls.lines, union: ls.union, bestLine: ls.best, clutter: ls.clutter };
  /**
   * A door at jamb `j`, in either of two placements for each radius r:
   * hinged on the jamb with the arc ending r into the gap (a full-width
   * door when r = L, one leaf of a double door at r = L/2), or with the
   * arc ending on the jamb and the hinge r into the gap (a door sharing
   * its gap with an opening). Across the wall band the hinge sits at the
   * centreline or at the face on the swing side.
   */
  // one radius sweep per jamb and side serves both the single-leaf and the
  // two-leaf ranges (the two-leaf range is the lower part of the same grid)
  interface Cand { r: number; score: number; endDeg: number; hx: number; hy: number; sweep: 1 | -1 }
  const sweeps = new Map<string, Cand[]>();
  const rFloor = Math.max(Math.min(o.leafRadius[0], o.halfLeafRadius[0]) * L, o.minLeafT * th, 8);
  const rCeil = Math.max(o.leafRadius[1], o.halfLeafRadius[1]) * L;
  const sweepFor = (j: (typeof jambs)[number], side: 1 | -1): Cand[] => {
    const key = `${j.dir}:${side}`;
    const hit = sweeps.get(key);
    if (hit) return hit;
    const out: Cand[] = [];
    // geometric radius steps matched to the tolerance, which grows with r
    const offsets = th >= 4 ? [0, (side * th) / 2] : [0];
    for (let r = rFloor; r <= rCeil; r += Math.max(1.5, o.arcTolerance * r)) {
      for (const off of offsets) {
        for (const along of [0, r]) {
          // hinge = jamb + along (toward the other jamb) + off across; the
          // arc sweeps away from the jamb when hinged on it, back toward it otherwise
          const cx = gap.axis === 'h' ? j.x + j.dir * along : j.x + off;
          const cy = gap.axis === 'h' ? j.y + off : j.y + j.dir * along;
          const dir = (along ? -j.dir : j.dir) as 1 | -1;
          const a = arcScoreAt(thin, w, h, gap.axis, cx, cy, dir, side, r, o.arcTolerance);
          if (a.score > 0) out.push({ r, score: a.score, endDeg: a.endDeg, hx: cx, hy: cy, sweep: dir });
        }
      }
    }
    sweeps.set(key, out);
    return out;
  };
  const doorAt = (j: (typeof jambs)[number], side: 1 | -1, range: [number, number], half: boolean) => {
    let arc = { score: 0, endDeg: 90 };
    let radius = 0;
    let hx = j.x;
    let hy = j.y;
    let sweep: 1 | -1 = j.dir;
    // a leaf is never shorter than two wall thicknesses or a few pixels
    const rMin = Math.max(range[0] * L, o.minLeafT * th, 8);
    const rMax = range[1] * L;
    if (rMax < rMin) {
      detail.arcs.push({ jamb: j.dir > 0 ? 'A' : 'B', side, score: 0, radiusPx: 0, leaf: 0, half });
      return null;
    }
    for (const c of sweepFor(j, side)) {
      if (c.r < rMin || c.r > rMax) continue;
      if (c.score > arc.score) { arc = { score: c.score, endDeg: c.endDeg }; radius = c.r; hx = c.hx; hy = c.hy; sweep = c.sweep; }
    }
    // the leaf lies where the arc run ends, give or take: the leaf's own ink
    // fills the off-band for the last few degrees, so the run stops short
    let leaf = 0;
    if (arc.score > 0) {
      const degs: number[] = [];
      for (let d = arc.endDeg - 8; d <= arc.endDeg + 12; d += 2) degs.push(Math.min(90, d));
      if (arc.endDeg >= 75) degs.push(90);
      for (const deg of degs) leaf = Math.max(leaf, leafScore(ink, w, h, gap.axis, hx, hy, sweep, side, radius, deg, th));
    }
    detail.arcs.push({ jamb: j.dir > 0 ? 'A' : 'B', side, score: arc.score, radiusPx: radius, leaf, half });
    // a door is an arc with a leaf, a near-complete arc alone, or a shorter
    // arc (a leaf drawn part open sweeps less) with an unmistakable leaf
    const door =
      (arc.score >= o.arcScore && leaf >= o.leafScore) ||
      arc.score >= o.arcScoreAlone ||
      (arc.score >= o.arcScoreWithLeaf && leaf >= o.strongLeaf);
    if (!door) return null;
    if (lined && (arc.score < arcOverLines || leaf < leafOverLines)) return null;
    return { x: hx, y: hy, side, radiusPx: radius, score: arc.score };
  };
  // single leaf: best hinge and side
  let single: Classified['hinges'][number] | null = null;
  for (const j of jambs) {
    for (const side of [1, -1] as const) {
      const d = doorAt(j, side, o.leafRadius, false);
      if (d && (!single || d.score > single.score)) single = d;
    }
  }
  // two leaves: both jambs on the same side at up to half the gap, with
  // distinct hinges (one door read from both jambs is one door)
  let pair: Classified['hinges'] | null = null;
  for (const side of [1, -1] as const) {
    const d0 = doorAt(jambs[0], side, o.halfLeafRadius, true);
    const d1 = doorAt(jambs[1], side, o.halfLeafRadius, true);
    if (d0 && d1 && Math.hypot(d0.x - d1.x, d0.y - d1.y) > 0.3 * L) {
      const cand = [d0, d1];
      if (!pair || d0.score + d1.score > pair[0].score + pair[1].score) pair = cand;
    }
  }
  if (pair && (!single || pair[0].score + pair[1].score > 1.3 * single.score)) {
    hinges.push(...pair);
    return { gap, kind: 'door', score: (pair[0].score + pair[1].score) / 2, hinges, detail };
  }
  if (single) {
    hinges.push(single);
    return { gap, kind: 'door', score: single.score, hinges, detail };
  }
  // a Window group sits between two wall ends (the wall resumes
  // collinearly); a pair of furniture lines between a wall end and the side
  // of another wall is not glazing. Doors keep the one-end rule, since a
  // door hard against a corner faces a wall side.
  const bothEnds = gap.alongA >= wallEndPx && gap.alongB >= wallEndPx;
  if (bothEnds && ls.clutter <= o.maxClutter && (ls.lines >= o.minLines || (ls.union >= o.unionCover && ls.lines >= 1))) {
    return { gap, kind: 'windowGroup', score: ls.best, hinges, detail };
  }
  return { gap, kind: 'passage', score: ls.best, hinges, detail };
}

// --- public API ------------------------------------------------------------------------

/** Binarize the page: ink = composited luminance under the threshold. */
export function inkMask(raster: RasterPage, threshold: number): Uint8Array {
  const { width: w, height: h, data } = raster;
  const ink = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    const lum = ((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000) * a + 255 * (1 - a);
    ink[i] = lum < threshold ? 1 : 0;
  }
  return ink;
}

/** Working-scale gap to a page-scale Opening. */
function toOpening(c: Classified, raster: RasterPage, s: number, hinge?: Classified['hinges'][number], leaves?: number): Opening {
  const g = c.gap;
  const box = g.axis === 'h' ? { x0: g.a, y0: g.c0, x1: g.b - 1, y1: g.c1 } : { x0: g.c0, y0: g.a, x1: g.c1, y1: g.b - 1 };
  const px = { x0: Math.floor(box.x0 / s), y0: Math.floor(box.y0 / s), x1: Math.floor(box.x1 / s), y1: Math.floor(box.y1 / s) };
  const at = raster.toPdf((px.x0 + px.x1 + 1) / 2, (px.y0 + px.y1 + 1) / 2);
  return {
    kind: c.kind,
    axis: g.axis,
    px,
    widthPx: (g.b - g.a) / s,
    wallPx: (g.c1 - g.c0 + 1) / s,
    at,
    score: c.score,
    ...(hinge ? { hinge: { x: hinge.x / s, y: hinge.y / s, side: hinge.side, radiusPx: hinge.radiusPx / s } } : {}),
    ...(leaves ? { leaves } : {}),
    detail: { ...c.detail, arcs: c.detail.arcs.map((a) => ({ ...a, radiusPx: a.radiusPx / s })) },
  };
}

/**
 * Merge Window groups on one wall line that are separated by less than
 * mergeT wall thicknesses (the thicker of the estimate t and the wall at
 * the gap). Mullions shorter than the small-blob limit never reach the wall
 * mask at all, so adjacent units usually arrive here as one gap already.
 */
function mergeWindows(items: Opening[], t: number, mergeT: number): Opening[] {
  const out: Opening[] = [];
  const sorted = items.slice().sort((p, q) => (p.axis === q.axis ? (p.axis === 'h' ? p.px.x0 - q.px.x0 : p.px.y0 - q.px.y0) : p.axis < q.axis ? -1 : 1));
  for (const it of sorted) {
    let merged = false;
    for (const o of out) {
      if (o.axis !== it.axis) continue;
      const mergePx = mergeT * Math.max(t, o.wallPx, it.wallPx);
      const sameLine = it.axis === 'h' ? Math.abs((o.px.y0 + o.px.y1) / 2 - (it.px.y0 + it.px.y1) / 2) <= mergePx : Math.abs((o.px.x0 + o.px.x1) / 2 - (it.px.x0 + it.px.x1) / 2) <= mergePx;
      if (!sameLine) continue;
      const gapBetween = it.axis === 'h' ? it.px.x0 - o.px.x1 - 1 : it.px.y0 - o.px.y1 - 1;
      if (gapBetween > mergePx) continue;
      o.px = { x0: Math.min(o.px.x0, it.px.x0), y0: Math.min(o.px.y0, it.px.y0), x1: Math.max(o.px.x1, it.px.x1), y1: Math.max(o.px.y1, it.px.y1) };
      o.widthPx = it.axis === 'h' ? o.px.x1 - o.px.x0 + 1 : o.px.y1 - o.px.y0 + 1;
      o.units = (o.units ?? 1) + 1;
      o.score = Math.max(o.score, it.score);
      merged = true;
      break;
    }
    if (!merged) out.push({ ...it, units: 1 });
  }
  return out;
}

export function detectOpenings(raster: RasterPage, options: Partial<OpeningOptions> = {}): OpeningsResult {
  const o: OpeningOptions = { ...DEFAULT_OPENING_OPTIONS, ...options };
  let w = raster.width;
  let h = raster.height;
  let ink = inkMask(raster, o.inkThreshold);
  let est = estimateWalls(ink, w, h, o, 1);
  // thin walls: work upsampled so the opening kernel can sit between the
  // wall thickness and the line weight (a 3 px kernel cannot tell a 5 px
  // wall from a 3 px anti-aliased line; at 2x it is 7 vs 5)
  let s = 1;
  if (est.t < o.minWorkingT && o.maxUpsample > 1) {
    s = Math.min(o.maxUpsample, Math.ceil(o.minWorkingT / est.t), Math.floor(Math.sqrt(o.maxWorkingPx / (w * h))));
    if (s > 1) {
      ink = upsample(ink, w, h, s);
      w *= s;
      h *= s;
      est = estimateWalls(ink, w, h, o, s);
    } else s = 1;
  }
  const { wall, t } = est;
  // thin ink: everything the wall mask (grown by 1 px for anti-aliased edges) does not explain
  const grown = dilate(wall, w, h, 1);
  const thin = new Uint8Array(w * h);
  for (let i = 0; i < thin.length; i++) thin[i] = ink[i] && !grown[i] ? 1 : 0;
  const gaps = findGaps(wall, w, h, t, o);
  const doors: Opening[] = [];
  const windows: Opening[] = [];
  const passages: Opening[] = [];
  for (const g of gaps) {
    const c = classify(g, ink, thin, w, h, o.wallEndT * t, o);
    if (c.kind === 'door') {
      for (const hg of c.hinges) doors.push(toOpening(c, raster, s, hg, c.hinges.length));
    } else if (c.kind === 'windowGroup') windows.push(toOpening(c, raster, s));
    else passages.push(toOpening(c, raster, s));
  }
  let inkCount = 0;
  let wallCount = 0;
  for (let i = 0; i < ink.length; i++) { inkCount += ink[i]; wallCount += wall[i]; }
  return {
    doors,
    windows: mergeWindows(windows, t / s, o.mergeGapT),
    passages,
    walls: {
      width: w,
      height: h,
      scale: s,
      thicknessPx: t / s,
      closeRadiusPx: est.r,
      kernelPx: est.k,
      inkFraction: inkCount / ink.length,
      wallFraction: wallCount / ink.length,
      score: est.score,
      histogram: est.histogram,
      tried: est.tried ?? [],
      penPx: est.pen ?? 1,
      minWallPx: est.minWall ?? o.minWallPx,
      countHistogram: est.countHistogram ?? new Float64Array(0),
      mask: wall,
    },
  };
}

/**
 * Enclosed spaces: the complement of the wall mask with every detected gap
 * (door, Window group or passage up to spaceBridgeT wide) bridged, flood-
 * filled 4-connected. Regions touching the page edge are exterior; the
 * largest remaining region is exterior too when it encloses the bounding
 * boxes of at least three others (a sheet with a frame line around the plan).
 * Regions under minSpaceAreaT2 t squared are posts, shafts and noise.
 */
export function countEnclosedSpaces(raster: RasterPage, options: Partial<OpeningOptions> = {}, openings?: OpeningsResult): SpaceResult {
  const o: OpeningOptions = { ...DEFAULT_OPENING_OPTIONS, ...options };
  const res = openings ?? detectOpenings(raster, options);
  const { width: w, height: h, mask, scale: s } = res.walls;
  const t = res.walls.thicknessPx * s; // working px
  const solid = mask.slice();
  const bridgeMax = o.spaceBridgeT * res.walls.thicknessPx;
  for (const op of [...res.doors, ...res.windows, ...res.passages]) {
    if (op.widthPx > bridgeMax) continue;
    const x0 = op.px.x0 * s;
    const y0 = op.px.y0 * s;
    const x1 = (op.px.x1 + 1) * s - 1;
    const y1 = (op.px.y1 + 1) * s - 1;
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) solid[y * w + x] = 1;
  }
  const label = new Int32Array(w * h);
  const regions: { id: number; area: number; x0: number; y0: number; x1: number; y1: number; edge: boolean; cx: number; cy: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < solid.length; start++) {
    if (solid[start] || label[start]) continue;
    const id = regions.length + 1;
    stack.length = 0;
    stack.push(start);
    label[start] = id;
    let area = 0;
    let x0 = w;
    let x1 = -1;
    let y0 = h;
    let y1 = -1;
    let edge = false;
    let sx = 0;
    let sy = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i / w) | 0;
      area++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || solid[j] || label[j]) continue;
        label[j] = id;
        stack.push(j);
      }
    }
    regions.push({ id, area, x0, y0, x1, y1, edge, cx: sx / area, cy: sy / area });
  }
  const minArea = o.minSpaceAreaT2 * t * t;
  const inner = regions.filter((r) => !r.edge);
  const dropped = new Map<(typeof inner)[number], 'small' | 'exterior'>();
  for (const r of inner) if (r.area < minArea) dropped.set(r, 'small');
  // a frame line around the sheet makes the exterior an inner region: the
  // largest room-sized region whose box holds at least three other
  // room-sized regions is that exterior
  const roomSized = inner.filter((r) => !dropped.has(r));
  if (roomSized.length) {
    const largest = roomSized.reduce((p, q) => (q.area > p.area ? q : p));
    const enclosed = roomSized.filter((r) => r !== largest && r.x0 >= largest.x0 && r.x1 <= largest.x1 && r.y0 >= largest.y0 && r.y1 <= largest.y1).length;
    if (enclosed >= 3) dropped.set(largest, 'exterior');
  }
  const kept = inner.filter((r) => !dropped.has(r));
  const pageBox = (r: (typeof inner)[number]) => ({
    areaPx: r.area / (s * s),
    x0: Math.floor(r.x0 / s),
    y0: Math.floor(r.y0 / s),
    x1: Math.floor(r.x1 / s),
    y1: Math.floor(r.y1 / s),
  });
  return {
    count: kept.length,
    spaces: kept.map((r) => ({ ...pageBox(r), at: raster.toPdf(r.cx / s, r.cy / s) })),
    rejected: inner.length - kept.length,
    regions: inner.map((r) => ({ ...pageBox(r), ...(dropped.has(r) ? { dropped: dropped.get(r) } : {}) })),
  };
}
