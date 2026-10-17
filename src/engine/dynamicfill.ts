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

export type FillResult = { points: Pt[] } | { error: string };

/**
 * Binary closing with a line structuring element (dilate then erode along
 * one axis, half-length r) in O(pixels): each stage is two running scans.
 * Extensive: bridges gaps ≤ 2r in the wall runs perpendicular to the axis,
 * leaves every existing wall pixel and face untouched.
 */
function closeLine(mask: Uint8Array, w: number, h: number, r: number, vertical: boolean): Uint8Array {
  const n = w * h;
  const step = vertical ? w : 1;
  const runs = vertical ? w : h; // number of independent columns/rows
  const len = vertical ? h : w;
  if (r <= 0) return mask.slice();

  // dilate: distance to nearest 1 within the run (up and down)
  const dist = new Int32Array(n);
  const FAR = len + r + 1;
  for (let i = 0; i < n; i++) dist[i] = mask[i] ? 0 : FAR;
  for (let start = 0; start < runs; start++) {
    let d = FAR;
    for (let k = 0; k < len; k++) {
      const i = start + k * step;
      if (mask[i]) d = 0;
      else if (d < FAR) d++;
      dist[i] = d;
    }
    for (let k = len - 1; k >= 0; k--) {
      const i = start + k * step;
      if (mask[i]) d = 0;
      else if (d < FAR) d++;
      if (d < dist[i]) dist[i] = d;
    }
  }
  const dil = new Uint8Array(n);
  for (let i = 0; i < n; i++) dil[i] = dist[i] <= r ? 1 : 0;

  // erode: every pixel within r along the run must be dilated, i.e. the
  // distance to the nearest non-dilated pixel stays beyond r
  for (let i = 0; i < n; i++) dist[i] = dil[i] ? FAR : 0;
  for (let start = 0; start < runs; start++) {
    let d = FAR;
    for (let k = 0; k < len; k++) {
      const i = start + k * step;
      if (!dil[i]) d = 0;
      else if (d < FAR) d++;
      dist[i] = d;
    }
    for (let k = len - 1; k >= 0; k--) {
      const i = start + k * step;
      if (!dil[i]) d = 0;
      else if (d < FAR) d++;
      if (d < dist[i]) dist[i] = d;
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = dil[i] && dist[i] > r ? 1 : 0;
  return out;
}

export function dynamicFill(raster: RasterPage, seed: Pt, tolerance = 150): FillResult {
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
  // gaps up to 2r closed; escalate only while the fill leaks
  let filled: Uint8Array | null = null;
  let count = 0;
  let boundary = ink;
  for (const r of GAP_HALF) {
    if (r > 0) {
      const closedV = closeLine(ink, w, h, r, true);
      const closedH = closeLine(ink, w, h, r, false);
      boundary = new Uint8Array(w * h);
      for (let i = 0; i < boundary.length; i++) boundary[i] = closedV[i] | closedH[i] | ink[i];
    }
    const mask = new Uint8Array(w * h);
    const stack = [sy * w + sx];
    mask[stack[0]] = 1;
    let n = 1;
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
        if (mask[nidx] || boundary[nidx]) continue;
        mask[nidx] = 1;
        n++;
        stack.push(nidx);
      }
    }
    if (n <= MAX_FILL_FRACTION * w * h) {
      filled = mask;
      count = n;
      break;
    }
  }
  if (!filled) return unbounded();

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
  const boundaryPts: { x: number; y: number }[] = [];
  let cx = startIdx % w;
  let cy = (startIdx / w) | 0;
  let dir = 0; // entered heading east
  const startX = cx;
  const startY = cy;
  let guard = 0;
  do {
    boundaryPts.push({ x: cx, y: cy });
    let found = false;
    for (let k2 = 1; k2 <= 8; k2++) {
      const d = (dir + 7 + k2) % 8; // turn clockwise from backtrack
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
  if (boundaryPts.length < 8) return { error: 'that region is too small to fill' };

  const simplified = douglasPeucker(boundaryPts, 1.5);
  if (simplified.length < 3) return { error: 'that region is too small to fill' };

  // plausibility: a traced pixel boundary's polygon area must be within a
  // loose band of the filled pixel count (gross deviation = corrupted trace,
  // e.g. a guard-truncated loop) — thin regions legitimately run well under
  // count, since the polygon runs through the centres of boundary pixels
  const area = shoelace(simplified);
  if (area < 0.35 * count || area > 5 * count) return unbounded();

  const points = simplified.map((p) => raster.toPdf(p.x, p.y));
  return { points };
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
