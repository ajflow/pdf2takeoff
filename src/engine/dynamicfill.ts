// Dynamic Fill: click inside a bounded region and get its area as a polygon.
// Flood-fills the page raster from the click (ink acts as the boundary),
// traces the filled region's outline, simplifies it, and returns PDF-space
// points ready to become a normal area markup. Pure typed-array math.
//
// Door gaps: a click in a room whose walls have openings would leak. Instead
// of dilating walls (which shifts every wall face), the fill boundary is the
// ink mask closed with axis-aligned line structuring elements — the
// "replace doors with solid lines" operator. Closing bridges any gap up to
// 2·r px without moving or thickening any existing wall, so the traced
// polygon keeps true wall faces and spans openings exactly where the wall
// line runs. The ladder starts at r=0 (pure ink) and escalates only when the
// fill leaks, so the least intervention that bounds the region wins; a
// shoelace-vs-pixel-count check rejects pathological traces
// (docs/research/patch-plan.md, patch 2).
//
// Rooms joined by an interior door never leak, so the ladder also climbs
// past a bounded fill (patch-plan-2 P13): a rung that closes a door-width
// gap between wall ends and cuts a room-sized part off the fill wins, while
// one that only shaves an alcove is kept as floor and the climb goes on,
// since a wider doorway to a whole room may still be ahead. The rungs
// between the door and leak widths are the closing widths the sheet has,
// so each opening is judged on its own. Two hints sharpen this: with a
// known scale, doorways up to 1.0 m are always closed and openings up to
// 1.3 m may be cut; and a fill holding exactly one room label from the
// text layer is the clicked room. On born-digital sheets the host can also
// pass doorway bridges from the vector layer (fill-vector.ts, P18), which
// close doors at any angle, including in diagonal walls. A wall end must
// have a flat face: the side of a wall crossed at a shallow angle is long
// along the run and wall-thick across it, but its face slopes.
//
// Arcs are not walls: a door swing arc is a thin circular stroke of door
// radius hinged on a wall end, and a fill that stops at it loses the swing
// sector. Thin curvy ink (stroke no thicker than a third of the dominant
// stroke, on no long straight run) is grouped into pieces; a piece that fits
// a circle of door radius over a quarter-ish of a turn with ink at its centre
// is a swing. It is erased from the mask and its two chords are drawn
// instead, hinge to leaf tip and hinge to far jamb, so the door is closed
// at any angle and the fill runs to the door line, as for a leaf drawn
// closed. If the fill then finds no bounded region at all the arcs go
// back. Glyphs and dimension strings touching walls make false necks the
// same way, so hosts pass text boxes (FillHints.textBoxes) and the thin
// curvy ink inside them is erased too; the wall a label straddles is thick
// or straight and stays.
//
// Front doors and patio doors are wider than interior doors (1.3 to 2 m),
// and a fill through one runs off the page. The leak rung (LEAK_MAX_M) is
// tried only while every narrower rung leaked. It closes every gap up to
// 2 m at once, so the fill it bounds is then redone with only the gaps that
// face the page exterior sealed (the free space reachable from the page
// border with the gaps closed is the outside world), and the interior
// openings are judged by the cut rule as usual.
//
// The traced outline follows the pixel edges of the filled region, so the
// polygon runs along the ink face and its area is the inside-face area
// (scripts/room-bench.mjs scores this against ResPlan floor plans).

import type { Pt } from './types.ts';
import type { RasterPage } from './ports.ts';
import { estimateStrokeWidth } from './line-removal.ts';

/** A filled region larger than this share of the page counts as unbounded. */
const MAX_FILL_FRACTION = 0.4;
/**
 * Closing half-lengths tried until the fill bounds (px at the render scale):
 * r bridges door/opening widths up to 2r px — at scale 3 (px/pt) that covers
 * 0.9 m doors from 1:200 (~14 px) through 1:50 (~54 px) on the middle rungs.
 */
const GAP_HALF = [0, 8, 16, 28, 44];

/**
 * points: the room outline (PDF pt). gapPx: width (raster px) of the widest
 * gap the closing actually bridged on this room's boundary, absent when the
 * room was sealed by ink alone. bridged: a vector doorway bridge formed part
 * of the boundary. swings: a door swing arc was erased and its door line
 * formed part of the boundary.
 */
export type FillResult = { points: Pt[]; gapPx?: number; bridged?: boolean; swings?: boolean } | { error: string };

/** Widest doorway closed automatically once the page scale is known (m). */
const DOOR_MAX_M = 1.0;
/**
 * Widest opening a bounded fill may still be cut at with a known scale (m):
 * entrance doors and framed openings run to about 1.2 m. Unlike DOOR_MAX_M
 * the cut is guarded, it must separate room-sized parts (see the ladder).
 */
const DOOR_WIDE_M = 1.3;
/**
 * Widest gap closed to stop a LEAK with a known scale (m): front doors and
 * patio doors run to 2 m. This rung is never used to cut a bounded fill.
 */
const LEAK_MAX_M = 2.0;
/** Ink runs at least this long (px) are straight linework, never part of a swing arc or a glyph. */
const STRAIGHT_RUN_PX = 32;
/** Door swing radii accepted as a swing arc (m, with a scale; px bounds without). */
const SWING_MIN_M = 0.35;
const SWING_MAX_M = 2.5;
const SWING_MIN_PX = 8;
const SWING_MAX_PX = 400;
/** A swing arc covers between a chopped quarter turn and a double-door half turn (degrees). */
const SWING_MIN_SPAN_DEG = 45;
const SWING_MAX_SPAN_DEG = 200;
/** Cap on the sheet-derived fine rungs between two ladder rungs (see fineRungs). */
const MAX_FINE_RUNGS = 64;
/** Ink at least this thick (PDF pt) counts as a heavy (wall-weight) line. */
const HEAVY_PT = 0.9;
/** Ink pieces spanning less than this (PDF pt) are marks, not structure (~1.3 m at 1:100). */
const STRUCT_PT = 36;
/**
 * A label-driven split must cut off at least this share of the merged fill
 * (or MIN_ROOM_M2 when the scale is known): a stray note in a wardrobe or
 * alcove must not shave that alcove off the room.
 */
const MIN_SPLIT_SHARE = 0.15;
const MIN_ROOM_M2 = 2;
/** Label probes sit this far (PDF pt) around a label's centre. */
const LABEL_PROBE_PT = 4;

/** Optional context that lets the fill separate rooms joined by a doorway. */
export interface FillHints {
  /**
   * Centres (PDF pt) of room-label text items from the text layer (see
   * roomLabelPoints). A fill holding two or more labels has merged rooms,
   * so the gap closing keeps escalating until the clicked room holds one.
   */
  labels?: Pt[];
  /**
   * Calibrated scale at the click. Doorways up to DOOR_MAX_M between two
   * wall ends are then always closed, so a room joined to the next by a
   * door fills on its own.
   */
  metersPerPt?: number;
  /**
   * Virtual wall lines (PDF pt) across doorways, from the vector layer
   * (fill-vector.ts doorBridges). Drawn into the ink mask before filling, so
   * doors in diagonal or curved walls close too.
   */
  bridges?: { x1: number; y1: number; x2: number; y2: number }[];
  /**
   * Boxes (raster px, x0/y0 inclusive, x1/y1 exclusive) of text on the
   * sheet: text-layer words, OCR words. The thin curvy ink inside them
   * (glyphs) is erased before filling, so a label or dimension string
   * touching a wall makes no false neck; wall ink in the box stays.
   */
  textBoxes?: { x0: number; y0: number; x1: number; y1: number }[];
}

/** Threshold for pixels no closing on the ladder ever turns into wall. */
const NEVER = 255;

/** How far (px) wall-end tests look along and across a gap's end ink. */
const WALL_END_REACH = 64;

/**
 * For every pixel, the smallest half-length r at which a binary closing with
 * an axis-aligned line structuring element (dilate then erode, half-length
 * r) along either axis turns it into wall: 0 for ink, NEVER when no rung
 * reaches it. Closing along one axis fills exactly the ink-free runs of
 * length L ≤ 2r that have ink at both ends (L ≤ r for a run that ends at the
 * page edge) and touches nothing else, so every rung of the ladder is a
 * single threshold test on one precomputed array, with no wall pixel or face
 * ever moved.
 *
 * One refinement over a plain closing: an interior run only closes when both
 * of its ends are wall ENDS, ink that carries on along the run's own axis
 * and is longer than it is thick there (de las Heras et al.: walls are lines
 * longer than thick). A door gap sits between two wall ends. The strip
 * between a wall face and a parallel bench line is bounded by the sides of
 * lines, and the short gap from a bench's end to a side wall has a wall
 * face on one side, so neither closes and the floor area is kept.
 *
 * Line weight separates the one case that rule alone gets wrong, a doorway
 * hard against a corner (a wall end facing the side of another wall):
 * walls are drawn heavier than furniture, so a run also closes when one end
 * is a HEAVY wall end (at least heavyPx thick) and the other is heavy ink
 * too. Thin bench and fixture lines never qualify.
 *
 * Either kind of end must belong to STRUCTURAL ink: a connected ink piece
 * spanning at least structPx. Symbols, text glyphs and other small marks
 * (a downlight's flat top edge looks like a short heavy wall end) are
 * isolated pieces, so they never anchor a closing.
 */
function closingThresholds(ink: Uint8Array, w: number, h: number, heavyPx: number, structPx: number): Uint8Array {
  const thr = new Uint8Array(w * h).fill(NEVER);
  // structural-ink cache: 0 unknown, 1 part of a piece spanning structPx, 2 a small piece
  const piece = new Uint8Array(w * h);
  const queue: number[] = [];
  const structural = (start: number): boolean => {
    if (piece[start]) return piece[start] === 1;
    queue.length = 0;
    queue.push(start);
    piece[start] = 3; // visiting
    let x0 = start % w;
    let x1 = x0;
    let y0 = (start / w) | 0;
    let y1 = y0;
    let big = false;
    for (let q = 0; q < queue.length && !big; q++) {
      const i = queue[q];
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x1 - x0 >= structPx || y1 - y0 >= structPx) big = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= w * h || !ink[j]) continue;
        if (piece[j] === 1) big = true;
        if (piece[j]) continue;
        piece[j] = 3;
        queue.push(j);
      }
    }
    const mark = big ? 1 : 2;
    for (const i of queue) piece[i] = mark;
    return big;
  };
  /** consecutive ink from i stepping by d, at most WALL_END_REACH (inBounds guards the axis) */
  const runFrom = (i: number, d: number, steps: number): number => {
    let n = 0;
    for (let k = 0; k < Math.min(steps, WALL_END_REACH) && ink[i + k * d]; k++) n++;
    return n;
  };
  // a wall END has a flat face: the free pixels just before the end ink,
  // offset across the run by up to half the thickness, are free too. The
  // SIDE of a wall crossed at a shallow angle is long along the run and
  // wall-thick across it, like an end, but its face slopes: a few px across
  // and the ink is a step closer, which would close the corners of a room
  // on a plan a few degrees off the page axes. A quarter of the probes may
  // fail (a scan skewed a degree or two shifts the face by a pixel)
  const flatEnd = (x: number, y: number, dx: number, dy: number, across: number): boolean => {
    const kmax = Math.min(Math.floor(across / 2), WALL_END_REACH);
    if (kmax < 2) return true;
    let bad = 0;
    let checks = 0;
    for (let k = 1; k <= kmax; k++) {
      for (const s of [-1, 1]) {
        const px = dx !== 0 ? x - dx : x + s * k;
        const py = dx !== 0 ? y + s * k : y - dy;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        checks++;
        if (ink[py * w + px]) bad++;
      }
    }
    return bad <= Math.max(1, Math.floor(0.25 * checks));
  };
  // end ink at (x, y) continuing in direction (dx, dy): its length along the
  // run's axis and its thickness across it
  const endInk = (x: number, y: number, dx: number, dy: number) => {
    const i = y * w + x;
    const along = dx > 0 ? runFrom(i, 1, w - x) : dx < 0 ? runFrom(i, -1, x + 1) : dy > 0 ? runFrom(i, w, h - y) : runFrom(i, -w, y + 1);
    const across = dx !== 0 ? runFrom(i, w, h - y) + runFrom(i, -w, y + 1) - 1 : runFrom(i, 1, w - x) + runFrom(i, -1, x + 1) - 1;
    const solid = structural(i);
    return { along, across, solid, wallEnd: solid && along >= Math.min(WALL_END_REACH, 2 * across) && flatEnd(x, y, dx, dy, across) };
  };
  type EndInk = ReturnType<typeof endInk>;
  // two wall ends, or a heavy wall end facing heavy ink (a doorway at a corner)
  const bridgeable = (a: EndInk, b: EndInk): boolean =>
    (a.wallEnd && b.wallEnd) ||
    (a.wallEnd && a.across >= heavyPx && b.solid && Math.min(b.along, b.across) >= heavyPx) ||
    (b.wallEnd && b.across >= heavyPx && a.solid && Math.min(a.along, a.across) >= heavyPx);
  const mark = (L: number, before: boolean, after: boolean, wallEnded: () => boolean): number => {
    const t = before && after ? (wallEnded() ? Math.ceil(L / 2) : NEVER) : before || after ? L : NEVER;
    return Math.min(t, NEVER);
  };
  // rows
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (ink[row + x]) {
        thr[row + x] = 0;
        x++;
        continue;
      }
      const a = x;
      while (x < w && !ink[row + x]) x++;
      const b = x;
      const t = mark(b - a, a > 0, b < w, () => bridgeable(endInk(a - 1, y, -1, 0), endInk(b, y, 1, 0)));
      if (t < NEVER) for (let i = row + a; i < row + b; i++) thr[i] = t;
    }
  }
  // columns, swept row by row (one open-run start per column) so reads stay
  // sequential; only the backfill of a closed run walks a column
  const runStart = new Int32Array(w).fill(-1);
  const flush = (x: number, end: number) => {
    const a = runStart[x];
    const t = mark(end - a, a > 0, end < h, () => bridgeable(endInk(x, a - 1, 0, -1), endInk(x, end, 0, 1)));
    if (t < NEVER) for (let y = a, i = a * w + x; y < end; y++, i += w) if (t < thr[i]) thr[i] = t;
    runStart[x] = -1;
  };
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (ink[i]) {
        if (runStart[x] >= 0) flush(x, y);
      } else if (runStart[x] < 0) {
        runStart[x] = y;
      }
    }
  }
  for (let x = 0; x < w; x++) if (runStart[x] >= 0) flush(x, h);
  return thr;
}

/** thinMask values: thin ink on a straight run, and thin curvy ink. */
const THIN = 1;
const THIN_CURVY = 3;

/**
 * Thin ink: pixels whose stroke is at most thinPx thick (the shorter of the
 * row and column runs through them), marked THIN_CURVY when they also sit
 * on no straight run of STRAIGHT_RUN_PX or more. Door swing arcs, glyphs
 * and fixture outlines are thin and curvy; walls are thick, or thin but
 * straight, so they never are. One row sweep for the row runs, one column
 * sweep for the rest.
 */
function thinMask(ink: Uint8Array, w: number, h: number, thinPx: number): Uint8Array {
  const hrun = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!ink[row + x]) {
        x++;
        continue;
      }
      const a = x;
      while (x < w && ink[row + x]) x++;
      const L = Math.min(x - a, 65535);
      for (let k = row + a; k < row + x; k++) hrun[k] = L;
    }
  }
  const out = new Uint8Array(w * h);
  const runStart = new Int32Array(w).fill(-1);
  const flush = (x: number, end: number) => {
    const a = runStart[x];
    const v = end - a;
    for (let y = a, i = a * w + x; y < end; y++, i += w) {
      const hr = hrun[i];
      if (Math.min(hr, v) <= thinPx) out[i] = Math.max(hr, v) < STRAIGHT_RUN_PX ? THIN_CURVY : THIN;
    }
    runStart[x] = -1;
  };
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (ink[i]) {
        if (runStart[x] < 0) runStart[x] = y;
      } else if (runStart[x] >= 0) {
        flush(x, y);
      }
    }
  }
  for (let x = 0; x < w; x++) if (runStart[x] >= 0) flush(x, h);
  return out;
}

/**
 * Door swing arcs among the thin curvy ink: 8-connected pieces that fit a
 * circle (Kasa least squares) of door radius to within a stroke, cover
 * between SWING_MIN_SPAN_DEG and SWING_MAX_SPAN_DEG of it, and have ink at
 * the centre (the hinge sits on the jamb). Straight leaders fit no circle
 * of door radius, glyphs and basins fit no circle at all, columns and round
 * tables cover the full turn, and a bath's rounded end has no ink at its
 * centre. Returns each arc with its pixels, hinge, radius and the two
 * points where the fitted circle meets the arc's ends: the swing's chords
 * from the hinge to those points are the leaf and the door line between
 * the jambs. An accepted arc is grown along its circle through any thin ink
 * joined to it (the ends of an arc run tangent to a row or column for a
 * few px and were labelled straight), so no stub of it is left behind.
 * `ink` is the mask the hinge test reads; `thin` (from thinMask) is
 * consumed: visited pixels are cleared.
 */
interface Swing {
  px: number[];
  hx: number;
  hy: number;
  r: number;
  ends: [{ x: number; y: number }, { x: number; y: number }];
}

/** The angular extent of pixels about (cx, cy): span in degrees and the two end angles. */
function arcExtent(px: number[], w: number, cx: number, cy: number): { spanDeg: number; a0: number; a1: number } {
  const angles: number[] = [];
  for (const i of px) angles.push(Math.atan2(((i / w) | 0) - cy, (i % w) - cx));
  angles.sort((a, b) => a - b);
  const n = angles.length;
  // the largest angular gap is where the arc is not: the arc runs from
  // the angle after the gap round to the angle before it
  let gap = angles[0] + 2 * Math.PI - angles[n - 1];
  let a0 = angles[0];
  let a1 = angles[n - 1];
  for (let k = 1; k < n; k++) {
    if (angles[k] - angles[k - 1] > gap) {
      gap = angles[k] - angles[k - 1];
      a0 = angles[k];
      a1 = angles[k - 1];
    }
  }
  return { spanDeg: 360 - (gap * 180) / Math.PI, a0, a1 };
}

/**
 * Least-squares circle (Kasa) through pixels, about (mx, my): minimises
 * sum (x2 + y2 + Dx + Ey + F)2 by Cramer's rule. Null for collinear pixels.
 */
function fitCircle(px: number[], w: number, mx: number, my: number): { cx: number; cy: number; r: number } | null {
  const n = px.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  for (const i of px) {
    const x = (i % w) - mx;
    const y = ((i / w) | 0) - my;
    const z = x * x + y * y;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const det = sxx * (syy * n - sy * sy) - sxy * (sxy * n - sy * sx) + sx * (sxy * sy - syy * sx);
  if (Math.abs(det) < 1e-9) return null;
  const bD = -sxz;
  const bE = -syz;
  const bF = -sz;
  const D = (bD * (syy * n - sy * sy) - sxy * (bE * n - sy * bF) + sx * (bE * sy - syy * bF)) / det;
  const E = (sxx * (bE * n - sy * bF) - bD * (sxy * n - sy * sx) + sx * (sxy * bF - bE * sx)) / det;
  const F = (sxx * (syy * bF - bE * sy) - sxy * (sxy * bF - bE * sx) + bD * (sxy * sy - syy * sx)) / det;
  const cx = -D / 2;
  const cy = -E / 2;
  const r2 = cx * cx + cy * cy - F;
  return r2 > 0 ? { cx, cy, r: Math.sqrt(r2) } : null;
}

function swingArcs(ink: Uint8Array, thin: Uint8Array, w: number, h: number, pxPerPt: number, metersPerPt: number | undefined): Swing[] {
  const minR = metersPerPt ? (SWING_MIN_M / metersPerPt) * pxPerPt : SWING_MIN_PX;
  const maxR = metersPerPt ? (SWING_MAX_M / metersPerPt) * pxPerPt : SWING_MAX_PX;
  const arcs: Swing[] = [];
  const comp: number[] = [];
  for (let start = 0; start < thin.length; start++) {
    if (thin[start] !== THIN_CURVY) continue;
    comp.length = 0;
    comp.push(start);
    thin[start] = 0;
    let x0 = start % w;
    let x1 = x0;
    let y0 = (start / w) | 0;
    let y1 = y0;
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q];
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (thin[j] === THIN_CURVY) {
            thin[j] = 0;
            comp.push(j);
          }
        }
      }
    }
    const n = comp.length;
    const span = Math.max(x1 - x0, y1 - y0);
    if (n < 8 || span < 0.5 * minR || span > 2.2 * maxR) continue;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    // fit, then once more on the inliers: a leaf drawn off-axis is curvy
    // too and joins its arc into one piece, and the leaf is radial, so it
    // falls far off the arc's circle and drops out of the refit
    let pts = comp;
    let fit = fitCircle(pts, w, mx, my);
    if (!fit) continue;
    const rms = (ps: number[], f: { cx: number; cy: number; r: number }) => {
      let ss = 0;
      for (const i of ps) {
        const d = Math.hypot((i % w) - mx - f.cx, ((i / w) | 0) - my - f.cy) - f.r;
        ss += d * d;
      }
      return Math.sqrt(ss / ps.length);
    };
    if (rms(pts, fit) > Math.max(1.5, 0.03 * fit.r)) {
      const f = fit;
      const inliers = pts.filter((i) => Math.abs(Math.hypot((i % w) - mx - f.cx, ((i / w) | 0) - my - f.cy) - f.r) <= Math.max(2, 0.05 * f.r));
      if (inliers.length < Math.max(8, 0.5 * n)) continue;
      fit = fitCircle(inliers, w, mx, my);
      if (!fit || rms(inliers, fit) > Math.max(1.5, 0.03 * fit.r)) continue;
      pts = inliers;
      comp.length = 0;
      comp.push(...pts);
    }
    const { cx, cy, r: R } = fit;
    if (R < minR || R > maxR) continue;
    const ax = mx + cx;
    const ay = my + cy;
    const { spanDeg } = arcExtent(comp, w, ax, ay);
    if (spanDeg < SWING_MIN_SPAN_DEG || spanDeg > SWING_MAX_SPAN_DEG) continue;
    // the hinge: ink within a few px of the centre — the jamb corner (heavy)
    // or the leaf's root / a thin-line wall end (thin, straight). Curvy ink
    // alone (a furniture blob beside a curved wall) does not hinge a door:
    // a real arc always pivots on line ink of its own, whatever the plan's
    // pen weight
    const hx = Math.round(ax);
    const hy = Math.round(ay);
    const tol = Math.max(3, Math.round(0.08 * R));
    let hinged = false;
    for (let y = Math.max(0, hy - tol); y <= Math.min(h - 1, hy + tol) && !hinged; y++) {
      for (let x = Math.max(0, hx - tol); x <= Math.min(w - 1, hx + tol); x++) {
        const j = y * w + x;
        if (ink[j] && thin[j] !== THIN_CURVY) {
          hinged = true;
          break;
        }
      }
    }
    if (!hinged) continue;
    // grow along the circle band through thin ink joined to the arc: its
    // tangent ends, labelled straight. The leaf leaves the band at once
    // (it is radial) and so does a wall line at the far jamb (the arc meets
    // it square on), so neither is eaten.
    const band = Math.max(1.5, 0.02 * R);
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q];
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (thin[j] && Math.abs(Math.hypot(nx - ax, ny - ay) - R) <= band) {
            thin[j] = 0;
            comp.push(j);
          }
        }
      }
    }
    const { a0, a1 } = arcExtent(comp, w, ax, ay);
    arcs.push({
      px: comp.slice(),
      hx: ax,
      hy: ay,
      r: R,
      ends: [
        { x: ax + R * Math.cos(a0), y: ay + R * Math.sin(a0) },
        { x: ax + R * Math.cos(a1), y: ay + R * Math.sin(a1) },
      ],
    });
  }
  return arcs;
}

/**
 * Draw a 3 px wide line of ink from (ax, ay) to (bx, by) (raster px), so a
 * 4-connected fill cannot slip through it; `mark` remembers the pixels it
 * added, for provenance. With `until`, the line may run on past (bx, by) by
 * that fraction of its length, and stops at the first ink its centre line
 * meets after `from` of its length: a swing chord ends on the jamb it was
 * fitted to, a pixel short or not, and never pokes through it.
 */
function drawBridge(ink: Uint8Array, mark: Uint8Array, w: number, h: number, ax: number, ay: number, bx: number, by: number, from = 1, until = 1): void {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay)) + 1;
  const stopAt = Math.round(n * from);
  const end = Math.round(n * until);
  for (let k = 0; k <= end; k++) {
    const x = Math.round(ax + ((bx - ax) * k) / n);
    const y = Math.round(ay + ((by - ay) * k) / n);
    if (k >= stopAt && x >= 0 && y >= 0 && x < w && y < h && ink[y * w + x] && !mark[y * w + x]) break;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const px = x + ox;
        const py = y + oy;
        if (px >= 0 && py >= 0 && px < w && py < h && !ink[py * w + px]) {
          ink[py * w + px] = 1;
          mark[py * w + px] = 1;
        }
      }
    }
  }
}

/**
 * Gaps that face the page exterior. With every gap up to rung R closed, the
 * free space reachable from the page border is the outside world; the
 * closed gaps (0 < thr <= R) touching it are the openings in the building
 * envelope: front doors, patio doors, garage doors. Returns a mask of those
 * gap pixels (grown through each gap's connected closed run), or null when
 * there are none.
 */
function exteriorGaps(thr: Uint8Array, w: number, h: number, R: number): Uint8Array | null {
  const mark = new Uint8Array(w * h); // 1 outside, 2 exterior-facing gap
  const stack: number[] = [];
  const seed = (i: number) => {
    if (thr[i] > R && !mark[i]) {
      mark[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  const gaps: number[] = [];
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || mark[j]) continue;
      const t = thr[j];
      if (t > R) {
        mark[j] = 1;
        stack.push(j);
      } else if (t > 0) {
        mark[j] = 2;
        gaps.push(j);
      }
    }
  }
  if (!gaps.length) return null;
  // grow through the rest of each gap's closed run
  for (let q = 0; q < gaps.length; q++) {
    const i = gaps[q];
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || mark[j]) continue;
      const t = thr[j];
      if (t > 0 && t <= R) {
        mark[j] = 2;
        gaps.push(j);
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (const i of gaps) out[i] = 1;
  return out;
}

export function dynamicFill(raster: RasterPage, seed: Pt, tolerance = 150, hints: FillHints = {}): FillResult {
  const w = raster.width;
  const h = raster.height;
  const data = raster.data;
  const s = raster.toRaster(seed.x, seed.y);
  const sx = Math.round(s.x);
  const sy = Math.round(s.y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { error: 'click inside the drawing' };
  const lum = (i: number) => (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  if (lum(sy * w + sx) < tolerance) return { error: 'you clicked on a line — click inside the region' };

  // ink mask once; each retry only thickens the gap-closing on top of it
  const ink = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) ink[i] = lum(i) < tolerance ? 1 : 0;
  // vector doorway bridges become ink: 3 px wide so 4-connected fills can't
  // slip through; bridgePx remembers which ink they added, for provenance
  const bridgePx = hints.bridges?.length ? new Uint8Array(w * h) : null;
  for (const b of hints.bridges ?? []) {
    const a = raster.toRaster(b.x1, b.y1);
    const c = raster.toRaster(b.x2, b.y2);
    drawBridge(ink, bridgePx!, w, h, a.x, a.y, c.x, c.y);
  }

  const unbounded = (): FillResult => ({
    error: 'that region is not bounded by lines on all sides — draw around it with the Area tool instead',
  });

  // flood fill (4-connectivity keeps the boundary tight), boundary = ink with
  // gaps up to 2r closed; the ladder escalates while the fill leaks, and
  // past that while a wider rung still cuts a room-sized part off (below).
  // A fill stops the moment it passes the cap: a leak is a leak, however far
  // it would run.
  const cap = MAX_FILL_FRACTION * w * h;
  const pxPerPt = Math.hypot(raster.toRaster(1, 0).x - raster.toRaster(0, 0).x, raster.toRaster(1, 0).y - raster.toRaster(0, 0).y) || 1;
  const heavyPx = Math.max(2, Math.round(HEAVY_PT * pxPerPt));
  const structPx = Math.round(STRUCT_PT * pxPerPt);

  // Thin curvy ink: strokes no thicker than a third of the dominant stroke
  // (walls on a filled-wall plan; on a thin-line plan the line weight
  // itself) that lie on no straight run. Glyphs inside the host's text
  // boxes and door swing arcs are erased from the mask before any closing,
  // so neither bounds the fill; walls through a text box are thick or
  // straight and stay.
  const thinPx = Math.max(heavyPx, Math.ceil(estimateStrokeWidth(ink, w, h) / 3));
  const curvy = thinMask(ink, w, h, thinPx);
  for (const b of hints.textBoxes ?? []) {
    const bx0 = Math.max(0, Math.floor(Math.min(b.x0, b.x1)));
    const bx1 = Math.min(w, Math.ceil(Math.max(b.x0, b.x1)));
    const by0 = Math.max(0, Math.floor(Math.min(b.y0, b.y1)));
    const by1 = Math.min(h, Math.ceil(Math.max(b.y0, b.y1)));
    for (let y = by0; y < by1; y++) {
      for (let i = y * w + bx0, e = y * w + bx1; i < e; i++) {
        if (curvy[i] === THIN_CURVY) {
          ink[i] = 0;
          curvy[i] = 0;
        }
      }
    }
  }
  // A swing arc is erased and its two chords drawn instead: from the hinge
  // to each end of the fitted circle, stopping on the first ink past 85
  // percent of the radius (the jamb, a pixel off or not) and never more
  // than 15 percent past it. One chord lies along the leaf, the other along
  // the wall line between the jambs, so the door is closed at any angle and
  // the fill runs to the door line, as it does for a leaf drawn closed in
  // the opening.
  const arcs = swingArcs(ink, curvy, w, h, pxPerPt, hints.metersPerPt);
  const swingPx = arcs.length ? new Uint8Array(w * h) : null;
  for (const a of arcs) for (const i of a.px) ink[i] = 0;
  for (const a of arcs) for (const e of a.ends) drawBridge(ink, swingPx!, w, h, a.hx, a.hy, e.x, e.y, 0.85, 1.15);

  // a known scale puts the doorway rung on the ladder and starts there
  // (every smaller rung only closes a subset of what it closes), and adds
  // the wide-doorway rung: the widest gap a bounded fill may still be cut
  // at. Rungs above it (the leak rung for front and patio doors, and the
  // fixed rungs) stay on the ladder for leaks only.
  const rungFor = (m: number) => Math.min(NEVER - 1, Math.ceil(((m / hints.metersPerPt!) * pxPerPt) / 2));
  const doorR = hints.metersPerPt ? rungFor(DOOR_MAX_M) : 0;
  const wideR = hints.metersPerPt ? rungFor(DOOR_WIDE_M) : Infinity;
  const leakR = hints.metersPerPt ? rungFor(LEAK_MAX_M) : Infinity;
  const baseLadder = [...new Set([...GAP_HALF, doorR, ...(hints.metersPerPt ? [wideR, leakR] : [])])].filter((r) => r >= doorR);
  // the closing widths the sheet actually has between two rungs, so each
  // opening is judged on its own (a 1.1 m alcove and a 1.2 m doorway must
  // not close in the same rung)
  const fineRungs = (thr: Uint8Array, lo: number, hi: number): number[] => {
    const seen = new Uint8Array(NEVER);
    for (let i = 0; i < thr.length; i++) {
      const t = thr[i];
      if (t > lo && t <= hi) seen[t] = 1;
    }
    let out: number[] = [];
    for (let t = 0; t < NEVER; t++) if (seen[t]) out.push(t);
    // a dense sheet can hold a distinct closing width in every rung between
    // the door and leak rungs; each is a full flood, so cap the ladder at an
    // even sample (ends kept) before it grows unbounded
    if (out.length > MAX_FINE_RUNGS) {
      const picked = new Set<number>();
      for (let k = 0; k < MAX_FINE_RUNGS; k++) picked.add(out[Math.round((k * (out.length - 1)) / (MAX_FINE_RUNGS - 1))]);
      out = [...picked].sort((a, b) => a - b);
    }
    return out;
  };
  const ladderTo = (thr: Uint8Array, hi: number) => [...new Set([...baseLadder, ...(hints.metersPerPt ? fineRungs(thr, doorR, hi) : [])])].sort((a, b) => a - b);
  const minRoomPx = hints.metersPerPt ? MIN_ROOM_M2 / (hints.metersPerPt / pxPerPt) ** 2 : 0;
  const labelIdx = (hints.labels ?? []).map((l) => {
    const c = raster.toRaster(l.x, l.y);
    const rp = LABEL_PROBE_PT * pxPerPt;
    const probes: number[] = [];
    for (let k = 0; k < 8; k++) {
      const px = Math.round(c.x + rp * Math.cos((k * Math.PI) / 4));
      const py = Math.round(c.y + rp * Math.sin((k * Math.PI) / 4));
      if (px >= 0 && py >= 0 && px < w && py < h) probes.push(py * w + px);
    }
    return probes;
  });
  const labelsIn = (m: Uint8Array) => labelIdx.filter((probes) => probes.some((i) => m[i])).length;

  // The ladder climbs past the first bounded fill too (P13): a room joined
  // to its neighbour by a doorway never leaks, so a rung that closes a
  // door-width gap between wall ends and cuts off a room-sized part of the
  // fill (MIN_SPLIT_SHARE, or MIN_ROOM_M2 with a scale) wins over the merged
  // fill. A rung that cuts off less is shaving an alcove or a niche: that
  // cut is kept as floor and the climb goes on, since a wider doorway to a
  // whole room may still be ahead; the kept alcoves that touch the final
  // fill are put back at the end. A fill holding exactly one room label is
  // the clicked room and stops the climb at once.
  //
  // `sealed` marks gap pixels treated as wall whatever the rung (the
  // exterior-facing gaps, see below); a fill they stop reports their own
  // closing width.
  type Best = { mask: Uint8Array; count: number; closedR: number; rung: number; usedBridge: boolean; usedSwing: boolean };
  const climb = (thr: Uint8Array, sealed: Uint8Array | null, ladder: number[], cutMaxR: number): Best | null => {
  let best: Best | null = null;
  let mask: Uint8Array = new Uint8Array(w * h);
  let kept: Uint8Array | null = null;
  const stack: number[] = [];
  // lowest threshold among pixels the last fill reached: a rung below it
  // blocks none of them, so its fill would retrace the same region exactly
  let reachedMin = 0;
  for (const r of ladder) {
    if (r < reachedMin) continue;
    if (best && r > cutMaxR) break;
    mask.fill(0);
    stack.length = 0;
    const seedIdx = sy * w + sx;
    if (thr[seedIdx] <= r) continue; // the closing swallowed the click point
    stack.push(seedIdx);
    mask[seedIdx] = 1;
    reachedMin = thr[seedIdx];
    let n = 1;
    // what actually stopped the fill: a closed gap (0 < thr <= r), a sealed
    // exterior gap, a vector bridge or a swing chord
    let closedR = 0;
    let usedBridge = false;
    let usedSwing = false;
    const m = mask;
    const step = (i: number) => {
      if (m[i]) return;
      const t = thr[i];
      if (t > r && !(sealed && sealed[i])) {
        m[i] = 1;
        n++;
        if (t < reachedMin) reachedMin = t;
        stack.push(i);
      } else if (t > 0) {
        if (t > closedR) closedR = t;
      } else if (bridgePx && bridgePx[i]) {
        usedBridge = true;
      } else if (swingPx && swingPx[i]) {
        usedSwing = true;
      }
    };
    while (stack.length && n <= cap) {
      const idx = stack.pop()!;
      const x = idx % w;
      if (x > 0) step(idx - 1);
      if (x < w - 1) step(idx + 1);
      if (idx >= w) step(idx - w);
      if (idx + w < w * h) step(idx + w);
    }
    if (n > cap) continue; // leaked
    if (best) {
      const cut = best.count - n;
      if (cut <= 0) continue; // this rung closed nothing on the room's boundary
      if (cut < Math.max(MIN_SPLIT_SHARE * best.count, minRoomPx)) {
        // an alcove, not a room: keep what this rung shaved off (its
        // opening included) and climb on
        kept ??= new Uint8Array(w * h);
        const b = best.mask;
        for (let i = 0; i < kept.length; i++) if (b[i] && !mask[i]) kept[i] = 1;
        continue;
      }
    }
    const freed = best?.mask ?? null;
    best = { mask, count: n, closedR, rung: r, usedBridge, usedSwing };
    if (labelIdx.length && labelsIn(mask) === 1) break; // the clicked room holds its own label only
    mask = freed ?? new Uint8Array(w * h);
  }
  if (best && kept) {
    // put back the kept alcoves that open onto the final fill (one cut off
    // a neighbour that was later cut off itself stays out)
    const m = best.mask;
    stack.length = 0;
    for (let i = 0; i < kept.length; i++) {
      if (!kept[i]) continue;
      const x = i % w;
      if (m[i]) kept[i] = 0; // the final fill is the one it was shaved from
      else if ((x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) || (i >= w && m[i - w]) || (i + w < w * h && m[i + w])) {
        kept[i] = 0;
        stack.push(i);
      }
    }
    while (stack.length) {
      const i = stack.pop()!;
      m[i] = 1;
      best.count++;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < w * h && kept[j] && !m[j]) {
          kept[j] = 0;
          stack.push(j);
        }
      }
    }
  }
  return best;
  };
  let thr = closingThresholds(ink, w, h, heavyPx, structPx);
  let best = climb(thr, null, ladderTo(thr, wideR), wideR);
  if (best && best.rung > wideR) {
    // Bounded only by the leak rung, which closed every gap up to LEAK_MAX_M
    // at once: the front door that let the fill out, but also every
    // interior opening wider than DOOR_WIDE_M, whether a wide door or an
    // open-plan opening to a room-sized space or an alcove. Seal just the
    // gaps that face the page exterior and climb again with the cut rule
    // allowed up to the leak rung: now each interior opening is judged on
    // its own, a room-sized part behind it is cut off, an alcove is kept.
    const sealed = exteriorGaps(thr, w, h, best.rung);
    if (sealed) best = climb(thr, sealed, ladderTo(thr, best.rung), best.rung) ?? best;
  }
  if (!best && arcs.length) {
    // nothing bounds even with the swing chords drawn: put the arcs back
    // (a swing may be the only ink sealing an odd doorway) and climb again
    for (const a of arcs) for (const i of a.px) ink[i] = 1;
    thr = closingThresholds(ink, w, h, heavyPx, structPx);
    best = climb(thr, null, ladderTo(thr, wideR), wideR);
  }
  if (!best) return unbounded();
  const region = best.mask;
  const count = best.count;
  const gapR = best.closedR;
  const bridged = best.usedBridge;
  const swung = best.usedSwing;

  // Outer boundary trace along pixel EDGES (crack following), clockwise from
  // the top-left corner of the topmost-leftmost pixel. The vertices sit on
  // the lattice of pixel corners, so the polygon is the exact outline of the
  // filled pixels and its area is their count: the boundary runs along the
  // face of the ink, not through the centres of the last free pixels, which
  // would inset every wall by half a pixel and undercount the room by half
  // its perimeter in pixels.
  let startIdx = -1;
  for (let i = 0; i < region.length; i++) {
    if (region[i]) {
      startIdx = i;
      break;
    }
  }
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && region[y * w + x] === 1;
  // headings E, S, W, N; the region stays on the right of the heading
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  // pixels ahead-left and ahead-right of a corner for each heading
  const FLX = [0, 0, -1, -1];
  const FLY = [-1, 0, 0, -1];
  const FRX = [0, -1, -1, 0];
  const FRY = [0, 0, -1, -1];
  const boundaryPts: { x: number; y: number }[] = [];
  const startX = startIdx % w;
  const startY = (startIdx / w) | 0;
  let cx = startX;
  let cy = startY;
  let dir = 0; // heading east along the top edge of the start pixel
  let perimeter = 0;
  // the start corner is a true vertex: the trace leaves it eastward and,
  // with nothing above or left of the start pixel, returns to it heading
  // north, and no other pixel touches that corner
  boundaryPts.push({ x: cx, y: cy });
  for (let guard = 0; guard <= 4 * region.length + 4; guard++) {
    // a filled pixel ahead-left means the boundary turns left (diagonal
    // contacts stay joined, as the pixel trace did); ahead-right filled means
    // straight on; nothing ahead means the outline turns right
    const next = at(cx + FLX[dir], cy + FLY[dir]) ? (dir + 3) % 4 : at(cx + FRX[dir], cy + FRY[dir]) ? dir : (dir + 1) % 4;
    if (next !== dir) {
      boundaryPts.push({ x: cx, y: cy });
      dir = next;
    }
    cx += DX[dir];
    cy += DY[dir];
    perimeter++;
    if (cx === startX && cy === startY) break;
  }
  if (perimeter < 12) return { error: 'that region is too small to fill' };

  const simplified = douglasPeucker(boundaryPts, 1.5);
  if (simplified.length < 3) return { error: 'that region is too small to fill' };

  // plausibility: the outline encloses exactly the filled pixels (plus any
  // ink islands inside the room, which count excludes), so its area is at
  // least count. Well under it means the trace cut across the region.
  const area = shoelace(simplified);
  if (area < 0.8 * count || area > 5 * count) return unbounded();

  const points = simplified.map((p) => raster.toPdf(p.x, p.y));
  return { points, ...(gapR > 0 ? { gapPx: 2 * gapR } : {}), ...(bridged ? { bridged: true } : {}), ...(swung ? { swings: true } : {}) };
}

function shoelace(pts: { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function douglasPeucker(pts: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = pts[a].x;
    const ay = pts[a].y;
    const bx = pts[b].x;
    const by = pts[b].y;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let maxD = -1;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
