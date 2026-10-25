// Raster opening detector: doors, Window groups and enclosed spaces from a
// rendered or scanned floor plan, without a vector layer and without a
// trained model. Pure typed-array math, environment-agnostic.
//
// Why a separate pass: the click-exemplar scan (scan-cv.ts) matches isolated
// repeated symbols, and door swing arcs are never isolated. The arc, the leaf
// and the wall ink form one connected component, so there is no exemplar to
// click. Magic Fill (dynamicfill.ts, fill-vector.ts) already finds door
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
//   3. optionally close so hatched or double-line walls become solid bands:
//      the ladder climbs past 3 px because wall cavities are several times
//      the outline stroke. A closing is kept only when it clearly raises the
//      share of ink in long bands of wall-class thickness, leaves at most a
//      few times more enclosed cells than every smaller radius, and does not
//      outgrow the unclosed mask many times over (a closing that blobs text
//      or floor hatch into walls passes the score test and fails these two)
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
//   8. doors and windows must sit on a major band-like wall component (the
//      network: solid filled blocks, furniture outlines and dimension
//      chains are not it); windows must also face the exterior — one side
//      of the wall reaches the page edge without crossing a room-sized
//      region, the other side is inside — so glazing read between hatch
//      bands, furniture pairs or dimension chains is dropped
//   9. Window groups closer than one wall thickness merge (adjacent units
//      without a wall between them count as one group)
//  10. spaces: flood-fill the complement of the wall mask with every gap
//      bridged, count enclosed regions above a minimum absolute area and a
//      minimum share of the largest region (furniture interiors and text
//      cells are small against real rooms), exterior out
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
  /**
   * A closing radius above the base ladder is additionally rejected unless it
   * leaves the drawing at most this many enclosed cells (plus closeCellAdd,
   * over the best smaller radius): a closing that blobs text and floor hatch
   * into walls fragments space into many more cells than any smaller radius
   * left, while one that merges paired wall lines unifies or mildly splits.
   */
  closeCellFactor: number;
  closeCellAdd: number;
  /** A closing whose wall mask grows beyond this multiple of the unclosed mask has swallowed texture, not cavities. */
  closeGrowthLimit: number;
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
  /**
   * Kernel fraction for the enclosed-space pass alone. Interior partitions are
   * often thinner than the outer wall the thickness estimate latches onto, so
   * counting rooms against the wall mask merges them; a smaller kernel here
   * keeps partitions without touching wall extraction or opening detection.
   */
  spaceKernelFraction: number;
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
  /** Openings (doors, windows) must sit on a major wall component (this share of the largest band-like component by mass). */
  openingNetwork: boolean;
  networkShare: number;
  /** A wall component's mass may fill at most this share of its bounding box (solid blocks are not walls). */
  networkFill: number;
  /** Windows must face the exterior: enclosed interior on one side of the wall, the page-edge region on the other. */
  windowExterior: boolean;
  /** Space: minimum enclosed area in t squared. */
  minSpaceAreaT2: number;
  /** Space: rooms also span a family of sizes — regions under this share of the largest kept region are furniture interiors and text cells. */
  minSpaceShare: number;
  /** Space: gaps up to this many t wide are bridged before counting (wider ones stay open). */
  spaceBridgeT: number;
}

export const DEFAULT_OPENING_OPTIONS: OpeningOptions = {
  inkThreshold: 200,
  // the ladder climbs past 3 px because hatched and double-line walls carry
  // cavities several times the outline stroke: only a cavity-scale closing
  // merges them into the solid band the opening kernel expects (clean
  // solid-wall sheets still choose r=0 by the closeGain score gate)
  closeRadii: [0, 1, 2, 3, 5, 8, 12],
  closeGain: 1.5,
  closeCellFactor: 4,
  closeCellAdd: 2,
  closeGrowthLimit: 8,
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
  spaceKernelFraction: 0.75,
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
  openingNetwork: true,
  networkShare: 0.12,
  networkFill: 0.6,
  windowExterior: true,
  minSpaceAreaT2: 30,
  minSpaceShare: 0.03,
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
  /** Every closing radius tried at the working scale, with its thickness, kernel, score, cells and long-run histogram. */
  tried: { r: number; t: number; k: number; score: number; cells: number; histogram: Float64Array }[];
  /** Pen weight (page px), the resulting wall floor, and the pixel-count stroke histogram of the raw ink. */
  penPx: number;
  minWallPx: number;
  countHistogram: Float64Array;
  /** 1 = wall, row-major, at the working scale. */
  mask: Uint8Array;
  /** Mask the enclosed-space pass uses (partitions kept at spaceKernelFraction); null = same as mask. */
  spaceMask: Uint8Array | null;
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

/** Doubles a flat flood-fill stack until it holds `need` slots. */
function growStack(stack: Int32Array<ArrayBuffer>, need: number): Int32Array<ArrayBuffer> {
  let n = stack.length || 1024;
  while (n < need) n *= 2;
  const out = new Int32Array(n);
  out.set(stack);
  return out;
}

/** Clears blobs whose bounding box is shorter than minLen on both axes (4-connected). */
function dropSmallBlobs(mask: Uint8Array, w: number, h: number, minLen: number): void {
  const seen = new Uint8Array(w * h);
  // preallocated flat stack and member list (doubling): the number[] stack and
  // the per-pixel neighbour array were most of this fill's cost; visit order
  // and results are the same (neighbours still read left, right, up, down)
  let stack = new Int32Array(1024);
  let members = new Int32Array(1024);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    let np = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let x0 = start % w;
    let x1 = x0;
    let y0 = (start / w) | 0;
    let y1 = y0;
    while (sp > 0) {
      if (sp + 4 > stack.length) stack = growStack(stack, sp + 4);
      const i = stack[--sp];
      if (np === members.length) members = growStack(members, np + 1);
      members[np++] = i;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0) { const j = i - 1; if (mask[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
      if (x < w - 1) { const j = i + 1; if (mask[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
      if (y > 0) { const j = i - w; if (mask[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
      if (y < h - 1) { const j = i + w; if (mask[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
    }
    if (x1 - x0 + 1 < minLen && y1 - y0 + 1 < minLen) for (let k = 0; k < np; k++) mask[members[k]] = 0;
  }
}

/**
 * Marks the major wall components: band-like connected blobs (fill ratio
 * under `fill` of their bounding box — a wall network is thin lines, a solid
 * title block is not) at least `share` of the largest such blob by mass (a
 * two-unit sheet has two networks of similar mass). The building's walls are
 * the network; furniture outlines, dimension chains, filled blocks and the
 * drawing frame survive in the mask only as small or solid stray blobs, so
 * an opening that does not touch the network is not an opening in the
 * building.
 */
function networkMask(mask: Uint8Array, w: number, h: number, share: number, fill: number): Uint8Array | null {
  const id = new Int32Array(w * h);
  const masses: number[] = [];
  const fills: number[] = [];
  // flat preallocated stack (see dropSmallBlobs): same visit order
  let stack = new Int32Array(1024);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || id[start]) continue;
    const cur = masses.length + 1;
    let sp = 0;
    stack[sp++] = start;
    id[start] = cur;
    let mass = 0;
    let x0 = w;
    let x1 = 0;
    let y0 = h;
    let y1 = 0;
    while (sp > 0) {
      if (sp + 4 > stack.length) stack = growStack(stack, sp + 4);
      const i = stack[--sp];
      mass++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0) { const j = i - 1; if (mask[j] && !id[j]) { id[j] = cur; stack[sp++] = j; } }
      if (x < w - 1) { const j = i + 1; if (mask[j] && !id[j]) { id[j] = cur; stack[sp++] = j; } }
      if (y > 0) { const j = i - w; if (mask[j] && !id[j]) { id[j] = cur; stack[sp++] = j; } }
      if (y < h - 1) { const j = i + w; if (mask[j] && !id[j]) { id[j] = cur; stack[sp++] = j; } }
    }
    masses.push(mass);
    fills.push(mass <= fill * (x1 - x0 + 1) * (y1 - y0 + 1) ? 1 : 0);
  }
  if (!masses.length) return null;
  let top = 0;
  for (let i = 0; i < masses.length; i++) if (fills[i] && masses[i] > top) top = masses[i];
  if (!top) return null;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const c = id[i];
    if (c && fills[c - 1] && masses[c - 1] >= share * top) out[i] = 1;
  }
  return out;
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
  /** Enclosed cells its wall mask leaves (guard input; masks may be freed). */
  cells: number;
  /** Wall-mask mass (guard input). */
  mass: number;
  tried?: { r: number; t: number; k: number; score: number; cells: number; histogram: Float64Array }[];
  pen?: number;
  minWall?: number;
  countHistogram?: Float64Array;
}

/** Stand-in for a freed trial's masks (see estimateWalls). */
const NO_MASK = new Uint8Array(0);

/**
 * Non-edge enclosed regions of the wall-mask complement above the minimum
 * room area. estimateWalls uses it as the closing guard: merging paired wall
 * lines unifies rooms, so a closing that leaves more cells than every smaller
 * radius has blobbed text or floor hatch into walls, however good its score.
 */
function enclosedCells(wall: Uint8Array, w: number, h: number, minArea: number): number {
  const seen = new Uint8Array(w * h);
  // flat preallocated stack (see dropSmallBlobs): same visit order
  let stack = new Int32Array(1024);
  let cells = 0;
  for (let start = 0; start < wall.length; start++) {
    if (wall[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let area = 0;
    let edge = false;
    while (sp > 0) {
      if (sp + 4 > stack.length) stack = growStack(stack, sp + 4);
      const i = stack[--sp];
      const x = i % w;
      const y = (i / w) | 0;
      area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0) { const j = i - 1; if (!wall[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
      if (x < w - 1) { const j = i + 1; if (!wall[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
      if (y > 0) { const j = i - w; if (!wall[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
      if (y < h - 1) { const j = i + w; if (!wall[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } }
    }
    if (!edge && area >= minArea) cells++;
  }
  return cells;
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
 * closing radii (given at page scale) and the thickness floor. `floor` (page
 * px) overrides the pen-derived wall floor: the ink-dominated retry at the
 * end re-enters with the dominant long-run bin, so thickness is read from
 * the real wall class instead of the pen-weight quantile.
 */
function estimateWalls(ink: Uint8Array, w: number, h: number, o: OpeningOptions, scale: number, floor?: number): WallEstimate {
  let inkCount = 0;
  for (let i = 0; i < ink.length; i++) inkCount += ink[i];
  const radii = (o.closeRadius !== undefined ? [o.closeRadius] : o.closeRadii).map((r) => r * scale);
  if (!radii.includes(0)) radii.unshift(0);
  const longPx = Math.round(o.longRunFraction * Math.max(w, h));
  const histLongPx = Math.round(o.histLongFraction * Math.max(w, h));
  const tried: WallEstimate[] = [];
  // a fixed closeRadius forces the last trial to win whatever its score;
  // otherwise the running best (first strict maximum) is the only closed
  // trial whose masks can still be returned
  const forcedLast = o.closeRadius !== undefined;
  let liveBest: WallEstimate | null = null;
  // thickness analysis is in page pixels whatever the working scale
  let minWall = Math.max(o.minWallPx, Math.round((o.minWallFraction * Math.max(w, h)) / scale));
  const baseMinWall = minWall;
  if (floor !== undefined) minWall = Math.max(minWall, floor);
  let pen = 1;
  let countHistogram: Float64Array = new Float64Array(0);
  // every trial's cell floor uses the unclosed thickness, so cell counts
  // compare across radii (a trial's own t shifts its floor and the comparison
  // would admit a closing that merely re-scaled the noise)
  let plainT = 0;
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
      // with an explicit floor the pen raise is what mis-set the floor
      if (floor === undefined) minWall = Math.max(minWall, Math.ceil(o.penGain * pen));
      countHistogram = hist.count;
    }
    const histogram = hist.long;
    const t = o.wallThicknessPx !== undefined ? o.wallThicknessPx * scale : wallThickness(histogram, minWall, o.peakShare, 1) * scale;
    const tHeavy = heaviestPeak(histogram, minWall) * scale;
    if (r === 0) plainT = t;
    // odd kernel just under the wall thickness
    let k = Math.floor(o.kernelFraction * t);
    if (k % 2 === 0) k--;
    k = Math.max(3, k);
    const wall = open(closed, w, h, (k - 1) / 2);
    dropSmallBlobs(wall, w, h, Math.round(o.minWallBlobT * t));
    let mass = 0;
    for (let i = 0; i < wall.length; i++) mass += wall[i];
    const e: WallEstimate = {
      closed,
      wall,
      t,
      r,
      k,
      histogram,
      score: wallScore(ink, wall, w, h, t, tHeavy, longPx, inkCount),
      cells: enclosedCells(wall, w, h, o.minSpaceAreaT2 * (plainT || t) * (plainT || t)),
      mass,
    };
    tried.push(e);
    // free the masks of trials that can no longer win, as soon as that is
    // known: at full-sheet size each trial holds two w*h masks, and with the
    // default four closing radii the sweep would otherwise keep ten of them
    // alive at once. Plain (r=0) is always eligible, so its masks always
    // stay; otherwise only the running best (or, with a forced single
    // radius, the newest trial) keeps its masks.
    if (forcedLast) {
      for (const p of tried) if (p !== e) { p.closed = NO_MASK; p.wall = NO_MASK; }
    } else if (!liveBest || e.score > liveBest.score) {
      if (liveBest && liveBest.r !== 0) { liveBest.closed = NO_MASK; liveBest.wall = NO_MASK; }
      liveBest = e;
    } else if (e.r !== 0) {
      e.closed = NO_MASK;
      e.wall = NO_MASK;
    }
  }
  // closing fuses text lines into bars that look like walls, so it has to
  // earn its place three times: its wall score must beat the unclosed score
  // by closeGain (a hatched or double-line wall barely scores unclosed), it
  // may not leave many more enclosed cells than every smaller radius, and its
  // mask may not outgrow the unclosed one by closeGrowthLimit (a closing that
  // blobs floor hatch or sparse texture swallows the page). A fixed
  // closeRadius skips all three gates.
  const plain = tried.find((e) => e.r === 0)!;
  let best = plain;
  if (o.closeRadius !== undefined) best = tried[tried.length - 1];
  else {
    for (const e of tried) {
      const smaller = tried.filter((p) => p.r < e.r);
      if (smaller.length && e.cells > o.closeCellFactor * Math.min(...smaller.map((p) => p.cells)) + o.closeCellAdd) continue;
      if (e.mass > o.closeGrowthLimit * plain.mass) continue;
      if (e.score >= o.closeGain * plain.score && e.score > best.score) best = e;
    }
  }
  // the winner may be a trial whose masks were freed when a higher-scoring
  // (but guard-rejected) trial took the running best: rebuild them
  if (best.r > 0 && best.closed === NO_MASK) {
    const closed = close(ink, w, h, best.r);
    best = { ...best, closed, wall: open(closed, w, h, (best.k - 1) / 2) };
    dropSmallBlobs(best.wall, w, h, Math.round(o.minWallBlobT * best.t));
  }
  // Ink-dominated renders (walls are nearly all of the ink): the pen weight
  // lands inside the wall band itself, the pen floor sits above the real
  // walls, thickness latches onto junction-blob bins and the opening kernel
  // erases every band, so the chosen estimate comes back with no wall-scored
  // ink at all. When thin ink holds under half the ink (on pen-dominated
  // sheets the pen model's assumptions hold and an empty mask has other
  // causes) and the floor sits above a real dominant long-run class, that
  // class is the wall stock: retry with it as the floor.
  if (floor === undefined && o.wallThicknessPx === undefined && best.score === 0) {
    const dom = heaviestPeak(plain.histogram, baseMinWall);
    if (plain.histogram[dom] > 0 && dom < minWall) {
      let thinInk = 0;
      for (let i = 1; i < dom; i++) thinInk += countHistogram[i];
      if (inkCount > 0 && 2 * thinInk < inkCount) return estimateWalls(ink, w, h, o, scale, dom);
    }
  }
  best.tried = tried.map((e) => ({ r: e.r, t: e.t, k: e.k, score: e.score, cells: e.cells, histogram: e.histogram }));
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
    // sin/cos once per angle (was once per radius sample), points inlined —
    // the arithmetic order matches polar() exactly, so the sampled pixels
    // (and the scores) are bit-identical
    const th = (deg * Math.PI) / 180;
    const along = Math.cos(th) * dir;
    const across = Math.sin(th) * side;
    for (let d = -tol; d <= tol && !on[i]; d += 1) {
      const rr = r + d;
      const x = Math.round(axis === 'h' ? hx + along * rr : hx + across * rr);
      const y = Math.round(axis === 'h' ? hy + across * rr : hy + along * rr);
      on[i] = at(x, y);
    }
    if (!on[i]) continue;
    for (let d = 1.5 * tol; d <= 3.5 * tol && !off[i]; d += 1) {
      const rr = r - d;
      const x = Math.round(axis === 'h' ? hx + along * rr : hx + across * rr);
      const y = Math.round(axis === 'h' ? hy + across * rr : hy + along * rr);
      const v = at(x, y);
      if (v) { off[i] = v; continue; }
      const r2 = r + d;
      const x2 = Math.round(axis === 'h' ? hx + along * r2 : hx + across * r2);
      const y2 = Math.round(axis === 'h' ? hy + across * r2 : hy + along * r2);
      off[i] = at(x2, y2);
    }
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
  if (o.openingNetwork) {
    const net = networkMask(wall, w, h, o.networkShare, o.networkFill);
    if (net) {
      // anchored: network wall ink within 0.75 t of the gap box (the jambs)
      const g = Math.max(2, Math.round(0.75 * t));
      const anchored = (op: Opening) => {
        const x0 = Math.max(0, op.px.x0 * s - g);
        const x1 = Math.min(w - 1, (op.px.x1 + 1) * s - 1 + g);
        const y0 = Math.max(0, op.px.y0 * s - g);
        const y1 = Math.min(h - 1, (op.px.y1 + 1) * s - 1 + g);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (net[y * w + x]) return true;
        return false;
      };
      for (let i = doors.length - 1; i >= 0; i--) if (!anchored(doors[i])) doors.splice(i, 1);
      for (let i = windows.length - 1; i >= 0; i--) if (!anchored(windows[i])) windows.splice(i, 1);
    }
  }
  if (o.windowExterior && windows.length) {
    // glazing faces the outside: one side of its wall must open onto the
    // exterior region, the other onto enclosed space. Glazing read between
    // hatch-grid bands or dimension chains has interiors (or margins) on
    // both sides and is not glazing.
    const solid = solidWithBridges(wall, w, h, [...doors, ...windows, ...passages], s, t / s, o);
    const { label, regions } = labelSolidRegions(solid, w, h);
    const ext = exteriorFlags(regions);
    const keep = windows.filter((win) => {
      const cx = Math.round(((win.px.x0 + win.px.x1 + 1) / 2) * s);
      const cy = Math.round(((win.px.y0 + win.px.y1 + 1) / 2) * s);
      const across = (win.axis === 'h' ? win.px.y1 - win.px.y0 : win.px.x1 - win.px.x0) + 1;
      const dirs: [number, number][] = win.axis === 'h' ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
      let sides = 0;
      dirs.forEach(([dx, dy], k) => {
        const from = Math.round(0.6 * across * s) + 2;
        // walk past thin ink (a bay pocket, a margin strip sealed off by
        // dimension chains) until real wall, a room, or the page edge: the
        // far side of facade glazing reaches the outside without crossing a
        // room; an interior band runs into a room or another wall first
        const to = Math.round(Math.max(2.5 * t + 4, 0.06 * Math.min(w, h)));
        const minRoom = o.minSpaceAreaT2 * t * t;
        for (let d = from; d <= to; d++) {
          const x = cx + dx * d;
          const y = cy + dy * d;
          if (x < 0 || y < 0 || x >= w || y >= h) { sides |= 1 << k; break; } // off the page: outside
          if (wall[y * w + x]) break; // the next wall ends this side's world
          const c = label[y * w + x];
          if (!c) continue;
          if (ext[c]) { sides |= 1 << k; break; }
          if (regions[c - 1].area >= minRoom) break; // a room: this side is inside
        }
      });
      return sides === 1 || sides === 2; // exactly one side exterior
    });
    windows.length = 0;
    windows.push(...keep);
  }
  let inkCount = 0;
  let wallCount = 0;
  for (let i = 0; i < ink.length; i++) { inkCount += ink[i]; wallCount += wall[i]; }
  // partitions for the space pass: a kernel under the wall estimate keeps
  // interior partitions the wall kernel erodes, at the cost of furniture
  // lines (the space area/relative floors absorb those)
  let spaceMask: Uint8Array | null = null;
  if (o.spaceKernelFraction < o.kernelFraction) {
    let k2 = Math.floor(o.spaceKernelFraction * t);
    if (k2 % 2 === 0) k2--;
    k2 = Math.max(3, k2);
    if (k2 < est.k) {
      spaceMask = open(est.closed, w, h, (k2 - 1) / 2);
      dropSmallBlobs(spaceMask, w, h, Math.round(o.minWallBlobT * t));
    }
  }
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
      spaceMask,
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

/** Wall mask with every opening box (up to spaceBridgeT wide) drawn solid. */
function solidWithBridges(mask: Uint8Array, w: number, h: number, ops: Opening[], scale: number, thicknessPx: number, o: OpeningOptions): Uint8Array {
  const solid = mask.slice();
  const bridgeMax = o.spaceBridgeT * thicknessPx;
  for (const op of ops) {
    if (op.widthPx > bridgeMax) continue;
    const x0 = op.px.x0 * scale;
    const y0 = op.px.y0 * scale;
    const x1 = (op.px.x1 + 1) * scale - 1;
    const y1 = (op.px.y1 + 1) * scale - 1;
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) solid[y * w + x] = 1;
  }
  return solid;
}

interface SolidRegion {
  id: number;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  edge: boolean;
  cx: number;
  cy: number;
}

/** Labels the complement of a solid mask 4-connected, with area, bbox, centroid and page-edge contact per region. */
function labelSolidRegions(solid: Uint8Array, w: number, h: number): { label: Int32Array; regions: SolidRegion[] } {
  const label = new Int32Array(w * h);
  const regions: SolidRegion[] = [];
  // flat preallocated stack (see dropSmallBlobs): same visit order
  let stack = new Int32Array(1024);
  for (let start = 0; start < solid.length; start++) {
    if (solid[start] || label[start]) continue;
    const id = regions.length + 1;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    let area = 0;
    let x0 = w;
    let x1 = -1;
    let y0 = h;
    let y1 = -1;
    let edge = false;
    let sx = 0;
    let sy = 0;
    while (sp > 0) {
      if (sp + 4 > stack.length) stack = growStack(stack, sp + 4);
      const i = stack[--sp];
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
      if (x > 0) { const j = i - 1; if (!solid[j] && !label[j]) { label[j] = id; stack[sp++] = j; } }
      if (x < w - 1) { const j = i + 1; if (!solid[j] && !label[j]) { label[j] = id; stack[sp++] = j; } }
      if (y > 0) { const j = i - w; if (!solid[j] && !label[j]) { label[j] = id; stack[sp++] = j; } }
      if (y < h - 1) { const j = i + w; if (!solid[j] && !label[j]) { label[j] = id; stack[sp++] = j; } }
    }
    regions.push({ id, area, x0, y0, x1, y1, edge, cx: sx / area, cy: sy / area });
  }
  return { label, regions };
}

/**
 * Regions that are the outside of the building: the page-edge regions plus,
 * on a framed sheet, the largest inner region enclosing at least three
 * others (the frame seals the margin off from the page edge).
 */
function exteriorFlags(regions: SolidRegion[]): Uint8Array {
  const ext = new Uint8Array(regions.length + 1);
  for (const r of regions) if (r.edge) ext[r.id] = 1;
  const inner = regions.filter((r) => !r.edge);
  if (inner.length) {
    const largest = inner.reduce((p, q) => (q.area > p.area ? q : p));
    const enclosed = inner.filter((r) => r !== largest && r.x0 >= largest.x0 && r.x1 <= largest.x1 && r.y0 >= largest.y0 && r.y1 <= largest.y1).length;
    if (enclosed >= 3) ext[largest.id] = 1;
  }
  return ext;
}

export function countEnclosedSpaces(raster: RasterPage, options: Partial<OpeningOptions> = {}, openings?: OpeningsResult): SpaceResult {
  const o: OpeningOptions = { ...DEFAULT_OPENING_OPTIONS, ...options };
  const res = openings ?? detectOpenings(raster, options);
  const { width: w, height: h, scale: s } = res.walls;
  const mask = res.walls.spaceMask ?? res.walls.mask;
  const t = res.walls.thicknessPx * s; // working px
  const solid = solidWithBridges(mask, w, h, [...res.doors, ...res.windows, ...res.passages], s, res.walls.thicknessPx, o);
  const { label: _label, regions } = labelSolidRegions(solid, w, h);
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
  // rooms come in a family of sizes: whatever the absolute floor keeps, a
  // region far smaller than the largest room is furniture, a text cell or a
  // bridged sliver, not a space
  const candidates = inner.filter((r) => !dropped.has(r));
  let kept = candidates;
  if (o.minSpaceShare > 0 && candidates.length > 1) {
    const largest = candidates.reduce((p, q) => (q.area > p.area ? q : p));
    kept = candidates.filter((r) => r === largest || r.area >= o.minSpaceShare * largest.area);
    for (const r of candidates) if (!kept.includes(r)) dropped.set(r, 'small');
  }
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
