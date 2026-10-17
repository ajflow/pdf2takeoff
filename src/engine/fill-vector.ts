// Doorway bridges from vector geometry (patch-plan-2 P18). The raster gap
// closing in dynamicfill.ts works along rows and columns only, so a door in a
// diagonal or curved wall leaks. On born-digital sheets the wall ends are
// exact: a free wall end (an endpoint no other segment shares) that faces
// another free wall end across a doorway, at any angle, gets a virtual wall
// line across the opening. A heavy wall end whose line runs into a heavy
// wall within door width (a doorway hard against a corner) is bridged too;
// thin lines only bridge to another wall end, so a bench or fixture line
// never gets closed onto a wall (the same rule as the raster gate).
//
// Dynamic Fill draws these bridges into its ink mask (FillHints.bridges).

import type { VecPage, VecSeg } from './vector.ts';

export interface Bridge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Endpoints closer than this (pt) are joined, not free. */
const JOIN_PT = 0.4;
/** Wall pieces shorter than this (pt) are ignored (ticks, hatching). */
const MIN_WALL_PT = 3;
/** Facing directions may differ from the gap direction by up to ~15°. */
const COS_FACING = Math.cos((15 * Math.PI) / 180);
/** Strokes at least this heavy (pt) may bridge onto the side of a wall. */
const HEAVY_PT = 0.9;

interface End {
  x: number;
  y: number;
  /** outward unit direction of the wall at this end */
  dx: number;
  dy: number;
  seg: VecSeg;
}

/**
 * Bridges across doorways up to maxGapPt wide (PDF pt). Only stroked,
 * straight, non-dashed segments of at least MIN_WALL_PT take part.
 */
export function doorBridges(vec: VecPage, maxGapPt: number): Bridge[] {
  const walls = vec.segs.filter(
    (s) => s.stroked && !s.curve && !s.dashed && s.lineWidth > 0 && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= MIN_WALL_PT,
  );
  if (walls.length === 0) return [];
  // endpoint hash: an end is free when no other wall segment shares it
  const key = (x: number, y: number) => `${Math.round(x / JOIN_PT)},${Math.round(y / JOIN_PT)}`;
  const at = new Map<string, number>();
  const bump = (x: number, y: number) => {
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
      const k = `${Math.round(x / JOIN_PT) + dx},${Math.round(y / JOIN_PT) + dy}`;
      at.set(k, (at.get(k) ?? 0) + 1);
    }
  };
  for (const s of walls) {
    bump(s.x1, s.y1);
    bump(s.x2, s.y2);
  }
  const ends: End[] = [];
  for (const s of walls) {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    const ux = (s.x2 - s.x1) / len;
    const uy = (s.y2 - s.y1) / len;
    if ((at.get(key(s.x1, s.y1)) ?? 0) <= 1) ends.push({ x: s.x1, y: s.y1, dx: -ux, dy: -uy, seg: s });
    if ((at.get(key(s.x2, s.y2)) ?? 0) <= 1) ends.push({ x: s.x2, y: s.y2, dx: ux, dy: uy, seg: s });
  }

  const bridges: Bridge[] = [];
  const used = new Set<End>();
  // 1. free end facing free end
  for (const a of ends) {
    if (used.has(a)) continue;
    let best: End | null = null;
    let bestD = Infinity;
    for (const b of ends) {
      if (b === a || b.seg === a.seg || used.has(b)) continue;
      const gx = b.x - a.x;
      const gy = b.y - a.y;
      const d = Math.hypot(gx, gy);
      if (d <= JOIN_PT || d > maxGapPt || d >= bestD) continue;
      const along = (gx * a.dx + gy * a.dy) / d;
      const back = (-gx * b.dx - gy * b.dy) / d;
      if (along < COS_FACING || back < COS_FACING) continue;
      best = b;
      bestD = d;
    }
    if (best) {
      used.add(a);
      used.add(best);
      bridges.push({ x1: a.x, y1: a.y, x2: best.x, y2: best.y });
    }
  }
  // 2. heavy free end whose line runs into a heavy wall's side
  for (const a of ends) {
    if (used.has(a) || a.seg.lineWidth < HEAVY_PT) continue;
    let bestT = Infinity;
    for (const w of walls) {
      if (w === a.seg || w.lineWidth < HEAVY_PT) continue;
      // ray a + t·d against segment w
      const ex = w.x2 - w.x1;
      const ey = w.y2 - w.y1;
      const den = a.dx * ey - a.dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const qx = w.x1 - a.x;
      const qy = w.y1 - a.y;
      const t = (qx * ey - qy * ex) / den;
      const u = (qx * a.dy - qy * a.dx) / den;
      if (t > JOIN_PT && t <= maxGapPt && u >= 0 && u <= 1 && t < bestT) bestT = t;
    }
    if (bestT < Infinity) {
      used.add(a);
      bridges.push({ x1: a.x, y1: a.y, x2: a.x + a.dx * bestT, y2: a.y + a.dy * bestT });
    }
  }
  return bridges;
}

/** Widest doorway bridged without a scale (pt): the raster ladder's top rung at 3 px/pt. */
const UNCALIBRATED_GAP_PT = 30;

/** doorBridges with the door width taken from the scale (1.0 m), or a raster-equivalent default. */
export function doorBridgesFor(vec: VecPage, metersPerPt?: number): Bridge[] {
  return doorBridges(vec, metersPerPt ? 1.0 / metersPerPt : UNCALIBRATED_GAP_PT);
}
