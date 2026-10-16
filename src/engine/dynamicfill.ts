// Dynamic Fill: click inside a bounded region and get its area as a polygon.
// Flood-fills the page raster from the click (ink acts as the boundary),
// traces the filled region's outline, simplifies it, and returns PDF-space
// points ready to become a normal area markup. Pure typed-array math.

import type { Pt } from './types.ts';
import type { RasterPage } from './ports.ts';

/** A filled region larger than this share of the page counts as unbounded. */
const MAX_FILL_FRACTION = 0.4;

export type FillResult = { points: Pt[] } | { error: string };

export function dynamicFill(raster: RasterPage, seed: Pt, tolerance = 150): FillResult {
  const w = raster.width;
  const h = raster.height;
  const data = raster.data;
  const s = raster.toRaster(seed.x, seed.y);
  const sx = Math.round(s.x);
  const sy = Math.round(s.y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { error: 'click inside the drawing' };
  const seedIdx = sy * w + sx;
  const lum = (i: number) => (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
  if (lum(seedIdx) < tolerance) return { error: 'you clicked on a line — click inside the region' };

  // flood fill (4-connectivity keeps the boundary tight)
  const filled = new Uint8Array(w * h);
  const stack = [seedIdx];
  filled[seedIdx] = 1;
  let count = 1;
  while (stack.length) {
    const idx = stack.pop()!;
    const x = idx % w;
    const y = (idx / w) | 0;
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nidx = ny * w + nx;
      if (filled[nidx] || lum(nidx) < tolerance) continue;
      filled[nidx] = 1;
      count++;
      stack.push(nidx);
    }
  }
  if (count > MAX_FILL_FRACTION * w * h) {
    return { error: 'that region is not bounded by lines on all sides — draw around it with the Area tool instead' };
  }

  // Moore-neighbour boundary trace, clockwise from the topmost-leftmost pixel
  let startIdx = -1;
  for (let i = 0; i < filled.length; i++) {
    if (filled[i]) {
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
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && filled[y * w + x];
  const boundary: { x: number; y: number }[] = [];
  let cx = startIdx % w;
  let cy = (startIdx / w) | 0;
  let dir = 0; // entered heading east
  const startX = cx;
  const startY = cy;
  let guard = 0;
  do {
    boundary.push({ x: cx, y: cy });
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const d = (dir + 7 + k) % 8; // turn clockwise from backtrack
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (at(nx, ny)) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }
    if (!found) break; // single-pixel region
    guard++;
  } while ((cx !== startX || cy !== startY) && guard < 10 * (w + h));
  if (boundary.length < 8) return { error: 'that region is too small to fill' };

  const simplified = douglasPeucker(boundary, 1.5);
  if (simplified.length < 3) return { error: 'that region is too small to fill' };
  const points = simplified.map((p) => raster.toPdf(p.x, p.y));
  return { points };
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
