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
/**
 * Escalation ladder override, in px at the raster's own scale. The default
 * bridges openings up to 88 px — right for 3 px/pt renders of 1:50–1:100
 * metric sheets, too small for imperial-scale drawings (a 3′ door at
 * 1/4″=1′-0″ is ~108 px at 3 px/pt) or 300-dpi rasters. Hosts that know
 * their raster scale can pass a wider ladder; escalation still stops at the
 * first rung that bounds the region, so over-provisioning is safe.
 */
export type GapLadder = number[];

export type FillResult = { points: Pt[] } | { error: string };

/**
 * Binary closing with a line structuring element (dilate then erode along
 * one axis, half-length r) in O(pixels): each stage is two running scans.
 * Extensive: bridges gaps ≤ 2r in the wall runs perpendicular to the axis,
 * leaves every existing wall pixel and face untouched.
 *
 * minRun gates what counts as a bridgeable run: only runs of at least
 * minRun px participate, so gaps are bridged only between substantial
 * lines. Ungated closing cannot tell a door gap (two long wall runs with a
 * hole between them) from open space between parallel short linework
 * (glyphs, ticks, symbol strokes) — at imperial-scale rungs it welds that
 * linework into solid false walls and shreds room interiors into slivers
 * (measured on AEC-Geometric-Bench sheet_02: 19 of 22 rooms lost to it at
 * r=112). minRun 0 keeps the classic ungated behaviour.
 */
export function closeLine(mask: Uint8Array, w: number, h: number, r: number, vertical: boolean, minRun = 0): Uint8Array {
  const n = w * h;
  const step = vertical ? w : 1;
  const runs = vertical ? w : h; // number of independent columns/rows
  const len = vertical ? h : w;
  if (r <= 0) return mask.slice();

  let src = mask;
  if (minRun > 1) {
    src = new Uint8Array(n);
    for (let start = 0; start < runs; start++) {
      let runStart = -1;
      for (let k = 0; k <= len; k++) {
        const on = k < len && mask[start + k * step] === 1;
        if (on && runStart < 0) runStart = k;
        else if (!on && runStart >= 0) {
          if (k - runStart >= minRun) for (let j = runStart; j < k; j++) src[start + j * step] = 1;
          runStart = -1;
        }
      }
    }
  }

  // dilate: distance to nearest 1 within the run (up and down)
  const dist = new Int32Array(n);
  const FAR = len + r + 1;
  for (let i = 0; i < n; i++) dist[i] = src[i] ? 0 : FAR;
  for (let start = 0; start < runs; start++) {
    let d = FAR;
    for (let k = 0; k < len; k++) {
      const i = start + k * step;
      if (src[i]) d = 0;
      else if (d < FAR) d++;
      dist[i] = d;
    }
    for (let k = len - 1; k >= 0; k--) {
      const i = start + k * step;
      if (src[i]) d = 0;
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

/**
 * Ink-threshold escalation for the default path. Real sheets exist whose
 * linework renders light (a measured 2026 benchmark sheet draws walls at
 * grey ≈212 with shading at ≈228): at the classic 150 threshold the walls
 * are invisible and every fill leaks. Escalate the threshold only while the
 * fill is unbounded — the least intervention that bounds the region wins,
 * exactly like the gap ladder. An explicit host-passed `tolerance` is
 * honoured exactly, with no escalation.
 */
const INK_LADDER = [150, 185, 220];

export function dynamicFill(raster: RasterPage, seed: Pt, tolerance?: number, gapHalf: GapLadder = GAP_HALF): FillResult {
  const w = raster.width;
  const h = raster.height;
  const data = raster.data;
  const s = raster.toRaster(seed.x, seed.y);
  const sx = Math.round(s.x);
  const sy = Math.round(s.y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { error: 'click inside the drawing' };
  const lum = (i: number) => (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;

  const unbounded = (): FillResult => ({
    error: 'that region is not bounded by lines on all sides — draw around it with the Area tool instead',
  });

  // flood fill (4-connectivity keeps the boundary tight), boundary = ink with
  // gaps up to 2r closed; escalate gap closing, then ink threshold, only
  // while the fill leaks. A bounded fill whose trace is implausible (a small
  // pocket masquerading as the region, e.g. inside furniture at a low ink
  // threshold) also escalates — measured on AEC-Geometric-Bench sheet_02, a
  // t=150 pocket aborted the ladder before t=185 bounded the real room.
  let result: FillResult | null = null;
  let tooSmall: string | null = null;
  for (const t of tolerance === undefined ? INK_LADDER : [tolerance]) {
    if (lum(sy * w + sx) < t) return { error: 'you clicked on a line — click inside the region' };

    // ink mask once per threshold; each retry only thickens the gap-closing on top of it
    const ink = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < ink.length; i++, p += 4) ink[i] = lum(i) < t ? 1 : 0;

  for (const r of gapHalf) {
    let boundary: Uint8Array;
    if (r > 0) {
      // run-length gate: a bridge is only made between runs at least ~r long —
      // door gaps sit between long wall runs, while the parallel short
      // linework inside rooms (glyphs, ticks, symbol strokes) must not be
      // welded into false walls (see closeLine doc comment for the measured
      // failure this prevents)
      const minRun = Math.max(24, r);
      const closedV = closeLine(ink, w, h, r, true, minRun);
      const closedH = closeLine(ink, w, h, r, false, minRun);
      boundary = new Uint8Array(w * h);
      for (let i = 0; i < boundary.length; i++) boundary[i] = closedV[i] | closedH[i] | ink[i];
    } else {
      boundary = ink;
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
    if (n > MAX_FILL_FRACTION * w * h) continue; // leak — escalate
      const traced = traceRegion(mask, n, w, h, raster);
      if ('points' in traced) {
        result = traced;
        break;
      }
      // a pocket, not the room — remember the most specific message, escalate
      tooSmall = traced.error;
    }
    if (result) break; // bounded and plausible at this rung — least intervention wins
  }
  if (!result) return tooSmall ? { error: tooSmall } : unbounded();
  return result;
}

/**
 * Outline a bounded flood fill: 4-directional wall-follower trace (the fill
 * is 4-connected, so the walker can never diagonal-jump across a notch —
 * an 8-directional Moore trace could close a sub-contour around wall-to-
 * wall interior linework and return half the region), Douglas–Peucker
 * simplify, then a plausibility check. Returns points, or an error the
 * caller treats as "this fill was a pocket, not the region — escalate".
 */
function traceRegion(filled: Uint8Array, count: number, w: number, h: number, raster: RasterPage): FillResult {
  let startIdx = -1;
  for (let i = 0; i < filled.length; i++) {
    if (filled[i]) {
      startIdx = i;
      break;
    }
  }
  // E, S, W, N in screen coordinates (y down): left of a heading is +3 mod 4
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && filled[y * w + x];
  const boundaryPts: { x: number; y: number }[] = [];
  let cx = startIdx % w;
  let cy = (startIdx / w) | 0;
  let d = 0; // entered heading east along the topmost row
  const startX = cx;
  const startY = cy;
  let exitDir = -1; // direction of the first move away from the start
  const seen = new Set<number>(); // (pos, dir) states — backstop against pathologies
  let guard = 0;
  for (;;) {
    boundaryPts.push({ x: cx, y: cy });
    let moved = false;
    for (let turn = 0; turn < 4 && !moved; turn++) {
      const left = (d + 3) % 4;
      if (at(cx + dirs[left][0], cy + dirs[left][1])) d = left; // hug the left wall
      if (at(cx + dirs[d][0], cy + dirs[d][1])) {
        if (cx === startX && cy === startY && exitDir >= 0 && d === exitDir) {
          moved = true; // signal loop closed; do not re-traverse
          cx = -1;
        } else {
          cx += dirs[d][0];
          cy += dirs[d][1];
          moved = true;
        }
      } else {
        d = (d + 1) % 4; // blocked: turn clockwise and try again
      }
    }
    if (!moved || cx < 0) break; // isolated pixel, or the contour closed
    if (exitDir < 0) exitDir = d;
    const state = (cy * w + cx) * 4 + d;
    if (seen.has(state)) break;
    seen.add(state);
    guard++;
    if (guard > 4 * (w + h) + 1000) break; // pathological contour — plausibility will reject
  }
  if (boundaryPts.length < 8) return { error: 'that region is too small to fill' };
  // the closed loop ends where it started; drop that duplicate or the
  // degenerate zero-length anchor segment collapses Douglas–Peucker
  const last = boundaryPts[boundaryPts.length - 1];
  if (last.x === boundaryPts[0].x && last.y === boundaryPts[0].y && boundaryPts.length > 1) boundaryPts.pop();

  const simplified = douglasPeucker(boundaryPts, 1.5);
  if (simplified.length < 3) return { error: 'that region is too small to fill' };

  // plausibility: a traced pixel boundary's polygon area must be within a
  // loose band of the filled pixel count (gross deviation = corrupted trace,
  // e.g. a guard-truncated loop) — thin regions legitimately run well under
  // count, since the polygon runs through the centres of boundary pixels
  const area = shoelace(simplified);
  if (area < 0.35 * count || area > 5 * count) return { error: 'that region is not bounded by lines on all sides — draw around it with the Area tool instead' };

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
