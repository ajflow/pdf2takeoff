// Shared scoring helpers for the room-partition proxies (check-partition.mjs,
// partition-holdout.mjs): polygon rasterisation, IoU against analytic room
// rectangles, and the "merged region" a fill would return if every doorway
// stayed open, which is what the partition pass is fed in direct tests.

import { fillEvidence } from '../src/engine/dynamicfill.ts';
import { partitionRegion } from '../src/engine/partition.ts';

/** Pixel mask (Uint8Array W*H) of a polygon given in raster px, sampled at pixel centres (even-odd). */
export function polyMask(pts, W, H) {
  const mask = new Uint8Array(W * H);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  const xs = [];
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy)) xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(W - 1, Math.floor(xs[k + 1] - 0.5)); x++) mask[y * W + x] = 1;
    }
  }
  return mask;
}

/** Mask of a room's rectangles (px, x1/y1 exclusive). */
export function rectMask(rects, W, H) {
  const mask = new Uint8Array(W * H);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) mask[y * W + x] = 1;
  }
  return mask;
}

export function iou(a, b) {
  let i = 0;
  let u = 0;
  for (let k = 0; k < a.length; k++) {
    if (a[k] && b[k]) i++;
    if (a[k] || b[k]) u++;
  }
  return u ? i / u : 0;
}

/** Polygon (PDF pt) -> raster px mask. */
export function ptPolyMask(points, raster) {
  return polyMask(points.map((p) => raster.toRaster(p.x, p.y)), raster.width, raster.height);
}

/** Best-matching truth room for a mask: { name, iou }. */
export function matchRoom(mask, rooms, W, H, cache = new Map()) {
  let best = { name: null, iou: 0 };
  for (const r of rooms) {
    if (!cache.has(r.name)) cache.set(r.name, rectMask(r.rects, W, H));
    const v = iou(mask, cache.get(r.name));
    if (v > best.iou) best = { name: r.name, iou: v };
  }
  return best;
}

/**
 * The region a fill from `seedPx` would bound if no doorway were closed: a
 * 4-connected flood over the free pixels of the evidence ink (the engine's
 * ink with its own chords and bridges taken out, swing arcs erased). Null
 * when it reaches the page edge (not bounded).
 */
const wallCache = new WeakMap();
/** The evidence ink's walls as one mask (the engine's ink without its own chords and bridges). */
function wallMask(ev) {
  let w = wallCache.get(ev.ink);
  if (!w) {
    w = new Uint8Array(ev.ink.length);
    for (let i = 0; i < w.length; i++) w[i] = ev.ink[i];
    for (const m of ev.virtual) if (m) for (let i = 0; i < w.length; i++) if (m[i]) w[i] = 0;
    wallCache.set(ev.ink, w);
  }
  return w;
}

export function openRegion(raster, seedPx, ev = fillEvidence(raster)) {
  const W = raster.width;
  const H = raster.height;
  const wall = wallMask(ev);
  const region = new Uint8Array(W * H);
  const s = seedPx[1] * W + seedPx[0];
  if (wall[s]) return null;
  const stack = [s];
  region[s] = 1;
  let n = 1;
  let x0 = W;
  let x1 = -1;
  let y0 = H;
  let y1 = -1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    const y = (i / W) | 0;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return null;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (!region[i - 1] && !wall[i - 1]) { region[i - 1] = 1; n++; stack.push(i - 1); }
    if (!region[i + 1] && !wall[i + 1]) { region[i + 1] = 1; n++; stack.push(i + 1); }
    if (!region[i - W] && !wall[i - W]) { region[i - W] = 1; n++; stack.push(i - W); }
    if (!region[i + W] && !wall[i + W]) { region[i + W] = 1; n++; stack.push(i + W); }
  }
  return { region, count: n, box: { x0, y0, x1, y1 } };
}

/** Run the partition pass on the open region around a seed; ms: the pass alone. */
export function partitionOpen(raster, seedPx, ev = fillEvidence(raster)) {
  const reg = openRegion(raster, seedPx, ev);
  if (!reg) return null;
  const t0 = performance.now();
  const res = partitionRegion({ w: raster.width, h: raster.height, region: reg.region, count: reg.count, box: reg.box, ink: ev.ink, virtual: ev.virtual, erased: ev.erased, rowGaps: ev.rowGaps, colGaps: ev.colGaps, arcs: ev.arcs, minDoorPx: ev.minDoorPx, maxDoorPx: ev.maxDoorPx, structPx: ev.structPx });
  return { ...res, region: reg, ms: performance.now() - t0 };
}

/** Child index lists -> masks. */
export function listMask(px, W, H) {
  const m = new Uint8Array(W * H);
  for (const i of px) m[i] = 1;
  return m;
}

/**
 * Score a partition result against the truth rooms. A child is correct when
 * its best room match has IoU >= minIoU and no two children claim one room.
 * Truth room masks are clipped to the region (a child can only hold region
 * pixels: furniture pockets and ink are not the pass's business).
 */
export function scoreChildren(res, rooms, W, H, minIoU) {
  const cache = new Map();
  for (const r of rooms) {
    const mk = rectMask(r.rects, W, H);
    for (let i = 0; i < mk.length; i++) if (!res.region.region[i]) mk[i] = 0;
    cache.set(r.name, mk);
  }
  const claimed = new Map();
  const matches = res.children.map((px) => {
    const mm = matchRoom(listMask(px, W, H), rooms, W, H, cache);
    return mm;
  });
  let ok = res.children.length === rooms.length;
  for (const mm of matches) {
    if (mm.iou < minIoU || claimed.has(mm.name)) ok = false;
    claimed.set(mm.name, true);
  }
  return { ok, matches };
}
