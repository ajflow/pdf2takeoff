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
// Rooms joined by an interior door never leak, so two hints escalate the
// closing further (patch-plan-2 P13): with a known scale, doorways up to
// 1.0 m between wall ends are always closed; and a fill holding two or more
// room labels from the text layer keeps escalating until the clicked room
// holds one.

import type { Pt } from './types.ts';
import type { RasterPage } from './ports.ts';

/** A filled region larger than this share of the page counts as unbounded. */
const MAX_FILL_FRACTION = 0.4;
/**
 * Closing half-lengths tried until the fill bounds (px at the render scale):
 * r bridges door/opening widths up to 2r px — at scale 3 (px/pt) that covers
 * 0.9 m doors from 1:200 (~14 px) through 1:50 (~54 px) on the middle rungs.
 */
const GAP_HALF = [0, 8, 16, 28, 44];

export type FillResult = { points: Pt[]; gapPx?: number } | { error: string };

/** Widest doorway closed automatically once the page scale is known (m). */
const DOOR_MAX_M = 1.0;
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
 * face on one side, so neither closes and the floor area is kept. With equal
 * line weights a door hard against a corner (no return nib) looks the same
 * as that bench gap and is not bridged.
 */
function closingThresholds(ink: Uint8Array, w: number, h: number): Uint8Array {
  const thr = new Uint8Array(w * h).fill(NEVER);
  /** consecutive ink from i stepping by d, at most WALL_END_REACH (inBounds guards the axis) */
  const runFrom = (i: number, d: number, steps: number): number => {
    let n = 0;
    for (let k = 0; k < Math.min(steps, WALL_END_REACH) && ink[i + k * d]; k++) n++;
    return n;
  };
  // end ink at (x, y) continuing in direction (dx, dy): along length vs its thickness across
  const wallEnd = (x: number, y: number, dx: number, dy: number): boolean => {
    const i = y * w + x;
    const along = dx > 0 ? runFrom(i, 1, w - x) : dx < 0 ? runFrom(i, -1, x + 1) : dy > 0 ? runFrom(i, w, h - y) : runFrom(i, -w, y + 1);
    const across = dx !== 0 ? runFrom(i, w, h - y) + runFrom(i, -w, y + 1) - 1 : runFrom(i, 1, w - x) + runFrom(i, -1, x + 1) - 1;
    return along >= Math.min(WALL_END_REACH, 2 * across);
  };
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
      const t = mark(b - a, a > 0, b < w, () => wallEnd(a - 1, y, -1, 0) && wallEnd(b, y, 1, 0));
      if (t < NEVER) for (let i = row + a; i < row + b; i++) thr[i] = t;
    }
  }
  // columns, swept row by row (one open-run start per column) so reads stay
  // sequential; only the backfill of a closed run walks a column
  const runStart = new Int32Array(w).fill(-1);
  const flush = (x: number, end: number) => {
    const a = runStart[x];
    const t = mark(end - a, a > 0, end < h, () => wallEnd(x, a - 1, 0, -1) && wallEnd(x, end, 0, 1));
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

  const unbounded = (): FillResult => ({
    error: 'that region is not bounded by lines on all sides — draw around it with the Area tool instead',
  });

  // flood fill (4-connectivity keeps the boundary tight), boundary = ink with
  // gaps up to 2r closed; escalate only while the fill leaks or holds more
  // than one room label. A fill stops the moment it passes the cap: a leak
  // is a leak, however far it would run.
  const cap = MAX_FILL_FRACTION * w * h;
  const mask = new Uint8Array(w * h);
  const thr = closingThresholds(ink, w, h);
  const pxPerPt = Math.hypot(raster.toRaster(1, 0).x - raster.toRaster(0, 0).x, raster.toRaster(1, 0).y - raster.toRaster(0, 0).y) || 1;
  // a known scale puts the doorway rung on the ladder and starts there:
  // every smaller rung only closes a subset of what it closes
  const doorR = hints.metersPerPt ? Math.min(NEVER - 1, Math.ceil(((DOOR_MAX_M / hints.metersPerPt) * pxPerPt) / 2)) : 0;
  const ladder = [...new Set([...GAP_HALF, doorR])].filter((r) => r >= doorR).sort((a, b) => a - b);
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

  let filled: Uint8Array | null = null;
  let count = 0;
  let gapR = 0;
  let merged: { mask: Uint8Array; count: number; r: number } | null = null;
  const stack: number[] = [];
  // lowest threshold among pixels the last fill reached: a rung below it
  // blocks none of them, so its fill would retrace the same region exactly
  let reachedMin = 0;
  for (const r of ladder) {
    if (r < reachedMin) continue;
    mask.fill(0);
    stack.length = 0;
    const seedIdx = sy * w + sx;
    if (thr[seedIdx] <= r) continue; // the closing swallowed the click point
    stack.push(seedIdx);
    mask[seedIdx] = 1;
    reachedMin = thr[seedIdx];
    let n = 1;
    const visit = (i: number) => {
      mask[i] = 1;
      n++;
      if (thr[i] < reachedMin) reachedMin = thr[i];
      stack.push(i);
    };
    while (stack.length && n <= cap) {
      const idx = stack.pop()!;
      const x = idx % w;
      if (x > 0 && !mask[idx - 1] && thr[idx - 1] > r) visit(idx - 1);
      if (x < w - 1 && !mask[idx + 1] && thr[idx + 1] > r) visit(idx + 1);
      if (idx >= w && !mask[idx - w] && thr[idx - w] > r) visit(idx - w);
      if (idx + w < w * h && !mask[idx + w] && thr[idx + w] > r) visit(idx + w);
    }
    if (n > cap) continue; // leaked
    if (labelIdx.length && labelsIn(mask) >= 2) {
      // bounded but spans several labelled rooms: keep it as the fallback
      // and try closing wider gaps
      merged ??= { mask: mask.slice(), count: n, r };
      continue;
    }
    filled = mask;
    count = n;
    gapR = r;
    break;
  }
  if (!filled && merged) {
    filled = merged.mask;
    count = merged.count;
    gapR = merged.r;
  }
  if (!filled) return unbounded();
  const region: Uint8Array = filled;

  // Moore-neighbour boundary trace, clockwise from the topmost-leftmost pixel
  let startIdx = -1;
  for (let i = 0; i < region.length; i++) {
    if (region[i]) {
      startIdx = i;
      break;
    }
  }
  const dirs = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ] as const;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && region[y * w + x];
  const boundaryPts: { x: number; y: number }[] = [];
  let cx = startIdx % w;
  let cy = (startIdx / w) | 0;
  let dir = 0; // entered heading east (nothing lies above or left of start)
  const startX = cx;
  const startY = cy;
  let firstDir = -1;
  for (let guard = 0; guard < 4 * region.length; guard++) {
    // search clockwise starting 90° left of the heading, so the trace hugs
    // the outside and follows concave corners instead of cutting across them
    let d = -1;
    for (let k = 0; k < 8; k++) {
      const c = (dir + 6 + k) % 8;
      if (at(cx + dirs[c][0], cy + dirs[c][1])) {
        d = c;
        break;
      }
    }
    // Jacob's stopping criterion: back at the start, leaving the way we first left
    if (d >= 0 && cx === startX && cy === startY && d === firstDir) break;
    boundaryPts.push({ x: cx, y: cy });
    if (d < 0) break; // single-pixel region
    if (firstDir < 0) firstDir = d;
    cx += dirs[d][0];
    cy += dirs[d][1];
    dir = d;
  }
  if (boundaryPts.length < 8) return { error: 'that region is too small to fill' };

  const simplified = douglasPeucker(boundaryPts, 1.5);
  if (simplified.length < 3) return { error: 'that region is too small to fill' };

  // plausibility: the polygon runs through the centres of the boundary
  // pixels, so its area sits at roughly count minus half the perimeter (more
  // when ink islands inside the room are excluded from count). Well under
  // count minus the full perimeter means the trace cut across the region.
  const area = shoelace(simplified);
  if (area < 0.8 * (count - boundaryPts.length) || area > 5 * count) return unbounded();

  const points = simplified.map((p) => raster.toPdf(p.x, p.y));
  return { points, ...(gapR > 0 ? { gapPx: 2 * gapR } : {}) };
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
