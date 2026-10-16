// Revision-diff metrics: pure raster math that quantifies what changed
// between two revisions of a page (the interactive colour blend lives in
// compare.ts; this answers "how much changed and where").

import type { RGBA } from './compare.ts';

/** Axis-aligned region in raster pixels, top-left origin. */
export interface DiffRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiffOptions {
  /** Ink difference (0-255) counted as a change. Default 24 (~10%). */
  threshold?: number;
  /** Offset B by this many A-raster pixels before diffing. */
  dxPx?: number;
  dyPx?: number;
}

function inkAt(r: RGBA, i: number): number {
  return 255 - (r.data[i] * 299 + r.data[i + 1] * 587 + r.data[i + 2] * 114) / 1000;
}

/** Per-pixel change mask: 1 where |inkA - inkB| exceeds the threshold. */
export function diffMask(a: RGBA, b: RGBA, opts: DiffOptions = {}): { mask: Uint8Array; changedPx: number } {
  const threshold = opts.threshold ?? 24;
  const dx = opts.dxPx ?? 0;
  const dy = opts.dyPx ?? 0;
  const mask = new Uint8Array(a.width * a.height);
  let changedPx = 0;
  for (let y = 0; y < a.height; y++) {
    const by = Math.round(y - dy);
    const rowInB = by >= 0 && by < b.height;
    for (let x = 0; x < a.width; x++) {
      const inkA = inkAt(a, (y * a.width + x) * 4);
      let inkB = 0;
      if (rowInB) {
        const bx = Math.round(x - dx);
        if (bx >= 0 && bx < b.width) inkB = inkAt(b, (by * b.width + bx) * 4);
      }
      if (Math.abs(inkA - inkB) > threshold) {
        mask[y * a.width + x] = 1;
        changedPx++;
      }
    }
  }
  return { mask, changedPx };
}

/** Share of A's pixels that changed (0..1). */
export function changedFraction(a: RGBA, b: RGBA, opts: DiffOptions = {}): number {
  const { changedPx } = diffMask(a, b, opts);
  return changedPx / Math.max(1, a.width * a.height);
}

/** Bounding boxes of changed blobs, largest first (4-connectivity). */
export function maskRegions(
  mask: Uint8Array,
  w: number,
  h: number,
  minRegionPx = 16,
  maxRegions = 50,
): DiffRegion[] {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const regions: (DiffRegion & { px: number })[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let count = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const y = (idx / w) | 0;
      const x = idx - y * w;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nidx = ny * w + nx;
        if (mask[nidx] && !seen[nidx]) {
          seen[nidx] = 1;
          stack.push(nidx);
        }
      }
    }
    if (count >= minRegionPx) regions.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, px: count });
  }
  regions.sort((a, b) => b.px - a.px);
  return regions.slice(0, maxRegions).map(({ x, y, w: rw, h: rh }) => ({ x, y, w: rw, h: rh }));
}
