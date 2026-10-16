// Measurement geometry over markup points. Points arrive in PDF user space
// (points, origin bottom-left); all returned lengths/areas are metric.

import type { Markup, MarkupType, Pt } from './types.ts';

/** Length of a markup's geometry in metres. */
export function markupLength(m: Markup, metersPerPt: number): number {
  let total = 0;
  for (let i = 1; i < m.points.length; i++) {
    total += distPt(m.points[i - 1], m.points[i]);
  }
  return total * metersPerPt;
}

/** Boundary length of a closed polygon, in metres. */
export function markupPerimeter(m: Markup, metersPerPt: number): number {
  const pts = m.points;
  const n = pts.length;
  if (n < 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) total += distPt(pts[i], pts[(i + 1) % n]);
  return total * metersPerPt;
}

/** Polygon area extruded by the markup's depth (metres), in m³. */
export function markupVolume(m: Markup, metersPerPt: number): number {
  return markupArea(m, metersPerPt) * (m.depth ?? 0);
}

/** Angle at the first point between the two rays, in degrees (0–180).
 *  Scale-free: no calibration needed. */
export function markupAngle(m: Markup): number {
  const [v, a, b] = m.points;
  if (!v || !a || !b) return 0;
  const a1 = Math.atan2(a.y - v.y, a.x - v.x);
  const a2 = Math.atan2(b.y - v.y, b.x - v.x);
  let d = (Math.abs(a1 - a2) * 180) / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}

export function markupArea(m: Markup, metersPerPt: number): number {
  const pts = m.points;
  const n = pts.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  const areaPt = Math.abs(sum) / 2;
  const mPerPt = metersPerPt;
  return areaPt * mPerPt * mPerPt;
}

export function distPt(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function defaultLabel(type: MarkupType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}
