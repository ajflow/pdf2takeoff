// Multi-scale viewports: drawings often mix scales on one sheet (a 1:20
// detail bubble on a 1:100 plan). A viewport is a polygon region with its own
// calibration; measurements resolve to the viewport containing them, falling
// back to the page calibration.

import type { Calibration, Markup, Pt } from './types.ts';

export interface Viewport {
  id: string;
  page: number; // 1-based
  points: Pt[]; // polygon, PDF user space
  metersPerPt: number;
  source: string; // e.g. 'viewport 1:20'
}

/** Standard even-odd point-in-polygon test (PDF-space points). */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersects = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** The viewport on this page containing the markup's centroid, if any. */
export function viewportFor(m: Markup, viewports: Viewport[]): Viewport | undefined {
  const pts = m.points;
  if (pts.length === 0) return undefined;
  const c = {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
  return viewports.find((v) => v.page === m.page && pointInPolygon(c, v.points));
}

/** Calibration for a markup: its viewport when contained, else the page's. */
export function resolveCalibration(
  m: Markup,
  calibrations: Map<number, Calibration>,
  viewports: Viewport[] = [],
): Calibration | undefined {
  return viewportFor(m, viewports) ?? calibrations.get(m.page);
}
