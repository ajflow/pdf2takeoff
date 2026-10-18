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
// one that only shaves an alcove stops the climb. Two hints sharpen this:
// with a known scale, doorways up to 1.0 m are always closed and openings
// up to 1.3 m may be cut; and a fill holding exactly one room label from
// the text layer is the clicked room. On born-digital sheets the host can
// also pass doorway bridges from the vector layer (fill-vector.ts, P18),
// which close doors at any angle, including in diagonal walls.
//
// The traced outline follows the pixel edges of the filled region, so the
// polygon runs along the ink face and its area is the inside-face area
// (scripts/room-bench.mjs scores this against ResPlan floor plans).

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

/**
 * points: the room outline (PDF pt). gapPx: width (raster px) of the widest
 * gap the closing actually bridged on this room's boundary, absent when the
 * room was sealed by ink alone. bridged: a vector doorway bridge formed part
 * of the boundary.
 */
export type FillResult = { points: Pt[]; gapPx?: number; bridged?: boolean } | { error: string };

/** Widest doorway closed automatically once the page scale is known (m). */
const DOOR_MAX_M = 1.0;
/**
 * Widest opening a bounded fill may still be cut at with a known scale (m):
 * entrance doors and framed openings run to about 1.2 m. Unlike DOOR_MAX_M
 * the cut is guarded, it must separate room-sized parts (see the ladder).
 */
const DOOR_WIDE_M = 1.3;
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
  // end ink at (x, y) continuing in direction (dx, dy): its length along the
  // run's axis and its thickness across it
  const endInk = (x: number, y: number, dx: number, dy: number) => {
    const i = y * w + x;
    const along = dx > 0 ? runFrom(i, 1, w - x) : dx < 0 ? runFrom(i, -1, x + 1) : dy > 0 ? runFrom(i, w, h - y) : runFrom(i, -w, y + 1);
    const across = dx !== 0 ? runFrom(i, w, h - y) + runFrom(i, -w, y + 1) - 1 : runFrom(i, 1, w - x) + runFrom(i, -1, x + 1) - 1;
    const solid = structural(i);
    return { along, across, solid, wallEnd: solid && along >= Math.min(WALL_END_REACH, 2 * across) };
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
    const n = Math.ceil(Math.hypot(c.x - a.x, c.y - a.y)) + 1;
    for (let k = 0; k <= n; k++) {
      const x = Math.round(a.x + ((c.x - a.x) * k) / n);
      const y = Math.round(a.y + ((c.y - a.y) * k) / n);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const px = x + ox;
          const py = y + oy;
          if (px >= 0 && py >= 0 && px < w && py < h && !ink[py * w + px]) {
            ink[py * w + px] = 1;
            bridgePx![py * w + px] = 1;
          }
        }
      }
    }
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
  const thr = closingThresholds(ink, w, h, Math.max(2, Math.round(HEAVY_PT * pxPerPt)), Math.round(STRUCT_PT * pxPerPt));
  // a known scale puts the doorway rung on the ladder and starts there
  // (every smaller rung only closes a subset of what it closes), and adds
  // the wide-doorway rung: the widest gap a bounded fill may still be cut
  // at. Rungs above it stay on the ladder for leaks only.
  const rungFor = (m: number) => Math.min(NEVER - 1, Math.ceil(((m / hints.metersPerPt!) * pxPerPt) / 2));
  const doorR = hints.metersPerPt ? rungFor(DOOR_MAX_M) : 0;
  const wideR = hints.metersPerPt ? rungFor(DOOR_WIDE_M) : Infinity;
  const ladder = [...new Set([...GAP_HALF, doorR, ...(hints.metersPerPt ? [wideR] : [])])].filter((r) => r >= doorR).sort((a, b) => a - b);
  const cutMaxR = wideR;
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
  // fill. A rung that cuts off less is shaving an alcove or a niche, and
  // since every wider rung closes at least as much, the climb stops there.
  // A fill holding exactly one room label is the clicked room and stops
  // the climb at once.
  let best: { mask: Uint8Array; count: number; closedR: number; usedBridge: boolean } | null = null;
  let mask: Uint8Array = new Uint8Array(w * h);
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
    // what actually stopped the fill: a closed gap (0 < thr <= r) or a bridge
    let closedR = 0;
    let usedBridge = false;
    const m = mask;
    const step = (i: number) => {
      if (m[i]) return;
      const t = thr[i];
      if (t > r) {
        m[i] = 1;
        n++;
        if (t < reachedMin) reachedMin = t;
        stack.push(i);
      } else if (t > 0) {
        if (t > closedR) closedR = t;
      } else if (bridgePx && bridgePx[i]) {
        usedBridge = true;
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
      if (cut < Math.max(MIN_SPLIT_SHARE * best.count, minRoomPx)) break; // an alcove, not a room
    }
    const freed = best?.mask ?? null;
    best = { mask, count: n, closedR, usedBridge };
    if (labelIdx.length && labelsIn(mask) === 1) break; // the clicked room holds its own label only
    mask = freed ?? new Uint8Array(w * h);
  }
  if (!best) return unbounded();
  const region = best.mask;
  const count = best.count;
  const gapR = best.closedR;
  const bridged = best.usedBridge;

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
  return { points, ...(gapR > 0 ? { gapPx: 2 * gapR } : {}), ...(bridged ? { bridged: true } : {}) };
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
