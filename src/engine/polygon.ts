// Simple-ring validation shared by geometry producers and evaluators.
// Touches and overlapping edges are invalid as well as proper crossings.
import type { Pt } from './types.ts';

const EPS = 1e-9;
const cross = (a: Pt, b: Pt, c: Pt) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const sign = (v: number) => v > EPS ? 1 : v < -EPS ? -1 : 0;
const onSegment = (p: Pt, a: Pt, b: Pt) =>
  p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS &&
  p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;

/**
 * Null means a finite, nonzero-area simple ring. A fixed work budget keeps
 * adversarial contours bounded; exhaustion rejects rather than accepting an
 * unchecked polygon.
 */
export function simpleRingError(pts: readonly Pt[], maxChecks = 1_000_000): string | null {
  const n = pts.length;
  if (n < 3) return 'fewer than 3 vertices';
  if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return 'non-finite coordinate';
  const vertices = new Set<string>();
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const key = `${p.x},${p.y}`;
    if (vertices.has(key) || Math.hypot(q.x - p.x, q.y - p.y) < EPS) return `repeated vertex at index ${i}`;
    vertices.add(key);
    area2 += p.x * q.y - q.x * p.y;
    const previous = pts[(i + n - 1) % n];
    if (
      sign(cross(previous, p, q)) === 0 &&
      (p.x - previous.x) * (q.x - p.x) + (p.y - previous.y) * (q.y - p.y) < 0
    ) return 'self-intersecting ring (adjacent edges overlap)';
  }
  if (Math.abs(area2) <= 2 * EPS) return 'zero area';

  // Sweep edge bounding boxes by x; most short contour edges never meet.
  const edges = pts.map((a, i) => {
    const b = pts[(i + 1) % n];
    return {
      a,
      b,
      i,
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxY: Math.max(a.y, b.y),
    };
  }).sort((a, b) => a.minX - b.minX || a.i - b.i);
  let checks = 0;
  for (let i = 0; i < n; i++) {
    const a = edges[i];
    for (let j = i + 1; j < n && edges[j].minX <= a.maxX + EPS; j++) {
      if (++checks > maxChecks) return 'ring is too complex to validate';
      const b = edges[j];
      if ((a.i + 1) % n === b.i || (b.i + 1) % n === a.i) continue;
      if (a.maxY < b.minY - EPS || b.maxY < a.minY - EPS) continue;
      const c1 = sign(cross(a.a, a.b, b.a));
      const c2 = sign(cross(a.a, a.b, b.b));
      const c3 = sign(cross(b.a, b.b, a.a));
      const c4 = sign(cross(b.a, b.b, a.b));
      if (
        (c1 * c2 < 0 && c3 * c4 < 0) ||
        (c1 === 0 && onSegment(b.a, a.a, a.b)) ||
        (c2 === 0 && onSegment(b.b, a.a, a.b)) ||
        (c3 === 0 && onSegment(a.a, b.a, b.b)) ||
        (c4 === 0 && onSegment(a.b, b.a, b.b))
      ) return 'self-intersecting ring';
    }
  }
  return null;
}
