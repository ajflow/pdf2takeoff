// Scan provider, vector tier: count repeated symbols straight from the PDF's
// drawing operators (patch-plan-2 P17). On born-digital sheets every symbol
// instance is the same geometry, so matching is exact and needs no tiles, no
// raster thresholds and no training. Long paths (walls, grid, leaders) are
// left out of symbol grouping, so a symbol touching a wall still stands on
// its own, the declared blind spot of the raster CV tier.
//
// Click → the small paths around the click form the template → every group
// of small paths with the same shape (any of 8 right-angle rotations and
// mirrors, same size) is a hit. Returns null when there is no vector
// symbol at the click (scans, raster-only sheets), so the host falls back
// to the raster tiers.

import type { Pt, ScanHit, ScanResult } from './types.ts';
import type { VecPage } from './vector.ts';

/** Paths longer than this (PDF pt) are structure, not symbol parts. */
const DEFAULT_MAX_SYMBOL_PT = 30;
/** Paths whose boxes come this close (pt) belong to the same symbol. */
const JOIN_PT = 0.6;
/**
 * Paths join a symbol only when drawn within this many paths of each other
 * (or inside the same Form XObject): exporters write a symbol's parts
 * together, while a wire or leader touching it is drawn elsewhere.
 */
const ORDER_GAP = 4;
/** Size tolerance between template and candidate (pt, per side). */
const SIZE_TOL_PT = 0.6;

interface Group {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  paths: number[];
}

/** Union-find grouping of small paths by bbox proximity and drawing order, via a coarse grid. */
function groupPaths(vec: VecPage, maxSymbolPt: number): Group[] {
  const small: number[] = [];
  vec.paths.forEach((p, i) => {
    if (Math.max(p.x1 - p.x0, p.y1 - p.y0) <= maxSymbolPt) small.push(i);
  });
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = a;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const i of small) parent.set(i, i);
  const cell = maxSymbolPt;
  const grid = new Map<string, number[]>();
  for (const i of small) {
    const p = vec.paths[i];
    // file under every cell the join distance reaches, so paths touching
    // across a cell boundary still meet in a shared bucket
    for (let gx = Math.floor((p.x0 - JOIN_PT) / cell); gx <= Math.floor((p.x1 + JOIN_PT) / cell); gx++) {
      for (let gy = Math.floor((p.y0 - JOIN_PT) / cell); gy <= Math.floor((p.y1 + JOIN_PT) / cell); gy++) {
        const key = `${gx},${gy}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
      }
    }
  }
  for (const bucket of grid.values()) {
    for (let a = 0; a < bucket.length; a++) {
      const p = vec.paths[bucket[a]];
      for (let b = a + 1; b < bucket.length; b++) {
        const q = vec.paths[bucket[b]];
        const together = (p.form >= 0 && p.form === q.form) || Math.abs(bucket[a] - bucket[b]) <= ORDER_GAP;
        if (together && p.x0 - JOIN_PT <= q.x1 && q.x0 - JOIN_PT <= p.x1 && p.y0 - JOIN_PT <= q.y1 && q.y0 - JOIN_PT <= p.y1) {
          const ra = find(bucket[a]);
          const rb = find(bucket[b]);
          if (ra !== rb) parent.set(ra, rb);
        }
      }
    }
  }
  const groups = new Map<number, Group>();
  for (const i of small) {
    const r = find(i);
    const p = vec.paths[i];
    const g = groups.get(r);
    if (g) {
      g.x0 = Math.min(g.x0, p.x0);
      g.y0 = Math.min(g.y0, p.y0);
      g.x1 = Math.max(g.x1, p.x1);
      g.y1 = Math.max(g.y1, p.y1);
      g.paths.push(i);
    } else groups.set(r, { x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, paths: [i] });
  }
  // a group that grew past symbol size is linework (hatching, text outlines)
  return [...groups.values()].filter((g) => Math.max(g.x1 - g.x0, g.y1 - g.y0) <= maxSymbolPt);
}

/** Points sampled along a group's segments, relative to its bbox centre. */
function samples(vec: VecPage, g: Group): Float64Array {
  const cx = (g.x0 + g.x1) / 2;
  const cy = (g.y0 + g.y1) / 2;
  const step = Math.max(0.25, Math.hypot(g.x1 - g.x0, g.y1 - g.y0) / 40);
  const out: number[] = [];
  for (const pi of g.paths) {
    const [a, b] = vec.paths[pi].segs;
    for (let s = a; s < b; s++) {
      const seg = vec.segs[s];
      const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        out.push(seg.x1 + (seg.x2 - seg.x1) * t - cx, seg.y1 + (seg.y2 - seg.y1) * t - cy);
      }
    }
  }
  return Float64Array.from(out);
}

/** The 8 right-angle rotations and mirrors, as [a, b, c, d] for (ax + by, cx + dy). */
const DIHEDRAL: [number, number, number, number][] = [
  [1, 0, 0, 1],
  [0, -1, 1, 0],
  [-1, 0, 0, -1],
  [0, 1, -1, 0],
  [-1, 0, 0, 1],
  [1, 0, 0, -1],
  [0, 1, 1, 0],
  [0, -1, -1, 0],
];

/**
 * Distance from each point of A to its nearest point of B: the mean, unless
 * any single point lies beyond `worst`, which returns Infinity (one extra
 * stroke inside an otherwise identical outline must not average away).
 */
function chamfer(a: Float64Array, b: Float64Array, t: [number, number, number, number], worst: number): number {
  let sum = 0;
  const worst2 = worst * worst;
  for (let i = 0; i < a.length; i += 2) {
    const x = t[0] * a[i] + t[1] * a[i + 1];
    const y = t[2] * a[i] + t[3] * a[i + 1];
    let best = Infinity;
    for (let j = 0; j < b.length; j += 2) {
      const dx = x - b[j];
      const dy = y - b[j + 1];
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    if (best > worst2) return Infinity;
    sum += Math.sqrt(best);
  }
  return sum / (a.length / 2);
}

export function vectorScan(vec: VecPage, clicked: Pt, opts: { maxSymbolPt?: number } = {}): ScanResult | null {
  const maxSymbolPt = opts.maxSymbolPt ?? DEFAULT_MAX_SYMBOL_PT;
  const groups = groupPaths(vec, maxSymbolPt);
  if (groups.length === 0) return null;

  // template: the group under the click, else the nearest within half a symbol
  let tpl: Group | null = null;
  let best = Infinity;
  for (const g of groups) {
    const dx = Math.max(g.x0 - clicked.x, 0, clicked.x - g.x1);
    const dy = Math.max(g.y0 - clicked.y, 0, clicked.y - g.y1);
    const d = Math.hypot(dx, dy);
    if (d < best) {
      best = d;
      tpl = g;
    }
  }
  if (!tpl || best > maxSymbolPt / 2) return null;

  const tw = tpl.x1 - tpl.x0;
  const th = tpl.y1 - tpl.y0;
  const tplPts = samples(vec, tpl);
  const tol = Math.max(0.35, 0.05 * Math.hypot(tw, th));
  const hits: ScanHit[] = [];
  for (const g of groups) {
    const w = g.x1 - g.x0;
    const h = g.y1 - g.y0;
    const same = Math.abs(w - tw) <= SIZE_TOL_PT && Math.abs(h - th) <= SIZE_TOL_PT;
    const turned = Math.abs(w - th) <= SIZE_TOL_PT && Math.abs(h - tw) <= SIZE_TOL_PT;
    if (!same && !turned) continue;
    const pts = g === tpl ? tplPts : samples(vec, g);
    let match = g === tpl;
    for (const t of DIHEDRAL) {
      if (match) break;
      // symmetric: template onto candidate, and candidate back onto template
      if (chamfer(tplPts, pts, t, 3 * tol) <= tol && chamfer(pts, tplPts, [t[0], t[2], t[1], t[3]], 3 * tol) <= tol) match = true;
    }
    if (match) hits.push({ x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2, score: 1 });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
  return { hits, provider: 'vector', note: `vector match · ${hits.length} identical symbol${hits.length === 1 ? '' : 's'}` };
}
