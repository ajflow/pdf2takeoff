// Automatic room extraction: Dynamic Fill from many seeds (a grid, or any
// points the caller proposes), with no human in the loop, reduced to one set
// of non-overlapping rooms (docs/research/room-partition-design-review.md,
// step D). Rooms are compared by their exact pixels, not by polygons.
//
// Selection rules (roomSelector), in seed order:
//   - a seed inside a room already accepted is skipped (component identity:
//     the same region gives the same rooms);
//   - children of a partitioned region (partition.ts: split at door-cued,
//     wall-supported portals) replace any accepted room they cover as a
//     parent, atomically: a merged parent is never emitted beside its
//     children, whichever seed produced it first;
//   - otherwise a candidate overlapping an accepted room (intersection over
//     the smaller of the two at least `overlapKeep`) is a duplicate and is
//     dropped, and the first one stands.
// The result does not depend on which of a parent and its children came
// first. Rooms are returned in raster order of their first pixel.

import type { Pt } from './types.ts';
import type { RasterPage } from './ports.ts';
import { dynamicFillRooms, type FillHints } from './dynamicfill.ts';

export interface AutoRoomsOptions {
  /** Ink thresholds tried per seed, in order, until a fill bounds (default [150], the engine default). */
  tolerances?: number[];
  /** Rooms with fewer pixels than this are dropped (default 0). */
  minAreaPx?: number;
  /** Intersection over the smaller room at which two rooms are the same (default 0.6). */
  overlapKeep?: number;
  /** Run the partition pass (default true). */
  partition?: boolean;
}

export interface AutoRoom {
  /** Outline, PDF pt. */
  points: Pt[];
  /** Sorted raster pixel indices. */
  px: Int32Array;
  /** A child of a partitioned region. */
  evidence: boolean;
  /** Index of the seed that produced it. */
  seed: number;
}

export interface AutoRoomsStats {
  seeds: number;
  covered: number;
  errors: Record<string, number>;
  candidates: number;
  duplicates: number;
  small: number;
  partitioned: number;
  unresolved: number;
  parentsReplaced: number;
}

/** Pixels two sorted index lists share. */
export function sharedPixels(a: Int32Array, b: Int32Array): number {
  if (a[a.length - 1] < b[0] || b[b.length - 1] < a[0]) return 0;
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      n++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return n;
}

function contains(px: Int32Array, v: number): boolean {
  let lo = 0;
  let hi = px.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (px[m] === v) return true;
    if (px[m] < v) lo = m + 1;
    else hi = m - 1;
  }
  return false;
}

/**
 * The selection rules as a pure accumulator: offer() each fill's rooms in
 * seed order (evidence: they are the children of a partitioned region),
 * rooms() for the result.
 */
export function roomSelector(overlapKeep = 0.6) {
  let accepted: AutoRoom[] = [];
  const tally = { duplicates: 0, parentsReplaced: 0 };
  return {
    tally,
    covers: (pixel: number) => accepted.some((r) => contains(r.px, pixel)),
    offer(cands: AutoRoom[], evidence: boolean): void {
      if (evidence && cands.length) {
        // children replace the parent they cover (an accepted room mostly
        // inside their union), atomically
        accepted = accepted.filter((a) => {
          if (a.evidence) return true;
          let inter = 0;
          for (const c of cands) inter += sharedPixels(a.px, c.px);
          if (inter >= overlapKeep * a.px.length) {
            tally.parentsReplaced++;
            return false;
          }
          return true;
        });
      }
      for (const c of cands) {
        if (accepted.some((a) => sharedPixels(a.px, c.px) >= overlapKeep * Math.min(a.px.length, c.px.length))) {
          tally.duplicates++;
          continue;
        }
        accepted.push(c);
      }
    },
    rooms: (): AutoRoom[] => accepted.slice().sort((a, b) => a.px[0] - b.px[0]),
  };
}

export function autoRooms(raster: RasterPage, seeds: Pt[], hints: FillHints = {}, options: AutoRoomsOptions = {}): { rooms: AutoRoom[]; stats: AutoRoomsStats } {
  const tolerances = options.tolerances ?? [150];
  const minAreaPx = options.minAreaPx ?? 0;
  const partition = options.partition !== false;
  const w = raster.width;
  const h = raster.height;
  const stats: AutoRoomsStats = { seeds: seeds.length, covered: 0, errors: {}, candidates: 0, duplicates: 0, small: 0, partitioned: 0, unresolved: 0, parentsReplaced: 0 };
  const sel = roomSelector(options.overlapKeep ?? 0.6);
  for (let k = 0; k < seeds.length; k++) {
    const s = raster.toRaster(seeds[k].x, seeds[k].y);
    const sx = Math.round(s.x);
    const sy = Math.round(s.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    if (sel.covers(sy * w + sx)) {
      stats.covered++;
      continue;
    }
    let res: ReturnType<typeof dynamicFillRooms> | null = null;
    for (const t of tolerances) {
      res = dynamicFillRooms(raster, seeds[k], t, hints, { partition });
      if (!('error' in res)) break;
    }
    if (!res || 'error' in res) {
      const why = res && 'error' in res ? res.error.replace(/ — .*$/, '') : 'no fill';
      stats.errors[why] = (stats.errors[why] ?? 0) + 1;
      continue;
    }
    if (res.partition === 'partitioned') stats.partitioned++;
    else if (res.partition === 'unresolved') stats.unresolved++;
    const evidence = res.partition === 'partitioned';
    const cands: AutoRoom[] = [];
    for (const room of res.rooms) {
      if (!room.px || room.px.length < minAreaPx) {
        stats.small++;
        continue;
      }
      cands.push({ points: room.points, px: room.px, evidence, seed: k });
    }
    stats.candidates += cands.length;
    sel.offer(cands, evidence);
  }
  stats.duplicates = sel.tally.duplicates;
  stats.parentsReplaced = sel.tally.parentsReplaced;
  return { rooms: sel.rooms(), stats };
}

/**
 * A grid of seed points (PDF pt) over a raster, `step` raster px apart,
 * starting half a step in, row by row.
 */
export function gridSeeds(raster: RasterPage, step: number): Pt[] {
  const out: Pt[] = [];
  for (let y = step / 2; y < raster.height; y += step) for (let x = step / 2; x < raster.width; x += step) out.push(raster.toPdf(x, y));
  return out;
}
