// Revision diffs beyond pixels (patch-plan-2 P19). When both revisions are
// born-digital, their drawing geometry and text layers say exactly what
// changed: segments added or removed (grouped into regions), whole pieces
// moved, and printed values changed in place ("4.00 m" → "5.00 m"). The
// raster overlay stays the fallback for scans. Vision-language models find
// a minority of real changes on revision benchmarks, so nothing here asks a
// model to spot differences.

import type { VecPage, VecSeg } from './vector.ts';
import type { OcrWord } from './ocr.ts';

export interface DiffRegion {
  kind: 'added' | 'removed';
  xPt: number;
  yPt: number;
  wPt: number;
  hPt: number;
  segments: number;
}

export interface VectorDiff {
  identical: boolean;
  added: number;
  removed: number;
  /** a removed piece that reappears translated in B */
  moved: { fromPt: [number, number]; toPt: [number, number]; dxPt: number; dyPt: number; segments: number }[];
  regions: DiffRegion[];
}

/** Coordinates are compared on this grid (pt). */
const Q = 0.25;
/** Changed segments this close (pt) belong to the same region. */
const REGION_JOIN_PT = 6;

const q = (v: number) => Math.round(v / Q);
function segKey(s: VecSeg, dx = 0, dy = 0): string {
  let a = [q(s.x1 - dx), q(s.y1 - dy)];
  let b = [q(s.x2 - dx), q(s.y2 - dy)];
  if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
  return `${a[0]},${a[1]},${b[0]},${b[1]},${Math.round(s.lineWidth * 10)}`;
}

/** Cluster segments by bbox proximity into regions. */
function cluster(segs: VecSeg[]): VecSeg[][] {
  const groups: { x0: number; y0: number; x1: number; y1: number; segs: VecSeg[] }[] = [];
  for (const s of segs) {
    const x0 = Math.min(s.x1, s.x2);
    const y0 = Math.min(s.y1, s.y2);
    const x1 = Math.max(s.x1, s.x2);
    const y1 = Math.max(s.y1, s.y2);
    const hit = groups.filter(
      (g) => x0 - REGION_JOIN_PT <= g.x1 && g.x0 - REGION_JOIN_PT <= x1 && y0 - REGION_JOIN_PT <= g.y1 && g.y0 - REGION_JOIN_PT <= y1,
    );
    if (hit.length === 0) {
      groups.push({ x0, y0, x1, y1, segs: [s] });
      continue;
    }
    const into = hit[0];
    for (const g of hit.slice(1)) {
      into.segs.push(...g.segs);
      into.x0 = Math.min(into.x0, g.x0);
      into.y0 = Math.min(into.y0, g.y0);
      into.x1 = Math.max(into.x1, g.x1);
      into.y1 = Math.max(into.y1, g.y1);
      groups.splice(groups.indexOf(g), 1);
    }
    into.segs.push(s);
    into.x0 = Math.min(into.x0, x0);
    into.y0 = Math.min(into.y0, y0);
    into.x1 = Math.max(into.x1, x1);
    into.y1 = Math.max(into.y1, y1);
  }
  return groups.map((g) => g.segs);
}

const bbox = (segs: VecSeg[]) => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of segs) {
    x0 = Math.min(x0, s.x1, s.x2);
    y0 = Math.min(y0, s.y1, s.y2);
    x1 = Math.max(x1, s.x1, s.x2);
    y1 = Math.max(y1, s.y1, s.y2);
  }
  return { x0, y0, x1, y1 };
};

/** Shape of a cluster relative to its bbox corner, for move detection. */
function shapeKey(segs: VecSeg[]): string {
  const b = bbox(segs);
  return segs
    .map((s) => segKey(s, b.x0, b.y0))
    .sort()
    .join('|');
}

/** Exact geometric diff of two pages' vector layers. */
export function vectorDiff(a: VecPage, b: VecPage): VectorDiff {
  const countB = new Map<string, number>();
  for (const s of b.segs) countB.set(segKey(s), (countB.get(segKey(s)) ?? 0) + 1);
  const removed: VecSeg[] = [];
  for (const s of a.segs) {
    const k = segKey(s);
    const n = countB.get(k) ?? 0;
    if (n > 0) countB.set(k, n - 1);
    else removed.push(s);
  }
  const countA = new Map<string, number>();
  for (const s of a.segs) countA.set(segKey(s), (countA.get(segKey(s)) ?? 0) + 1);
  const added: VecSeg[] = [];
  for (const s of b.segs) {
    const k = segKey(s);
    const n = countA.get(k) ?? 0;
    if (n > 0) countA.set(k, n - 1);
    else added.push(s);
  }

  const remClusters = cluster(removed);
  const addClusters = cluster(added);
  const moved: VectorDiff['moved'] = [];
  const addByShape = new Map<string, VecSeg[][]>();
  for (const c of addClusters) {
    const k = shapeKey(c);
    const list = addByShape.get(k);
    if (list) list.push(c);
    else addByShape.set(k, [c]);
  }
  const movedAdd = new Set<VecSeg[]>();
  const movedRem = new Set<VecSeg[]>();
  for (const c of remClusters) {
    const list = addByShape.get(shapeKey(c));
    const to = list?.find((x) => !movedAdd.has(x));
    if (!to) continue;
    const fa = bbox(c);
    const fb = bbox(to);
    movedAdd.add(to);
    movedRem.add(c);
    moved.push({
      fromPt: [Math.round(fa.x0 * 10) / 10, Math.round(fa.y0 * 10) / 10],
      toPt: [Math.round(fb.x0 * 10) / 10, Math.round(fb.y0 * 10) / 10],
      dxPt: Math.round((fb.x0 - fa.x0) * 10) / 10,
      dyPt: Math.round((fb.y0 - fa.y0) * 10) / 10,
      segments: c.length,
    });
  }
  const regions: DiffRegion[] = [];
  const region = (segs: VecSeg[], kind: DiffRegion['kind']) => {
    const r = bbox(segs);
    regions.push({ kind, xPt: Math.round(r.x0), yPt: Math.round(r.y0), wPt: Math.round(r.x1 - r.x0), hPt: Math.round(r.y1 - r.y0), segments: segs.length });
  };
  for (const c of remClusters) if (!movedRem.has(c)) region(c, 'removed');
  for (const c of addClusters) if (!movedAdd.has(c)) region(c, 'added');
  return { identical: removed.length === 0 && added.length === 0, added: added.length, removed: removed.length, moved, regions };
}

export interface TextDiff {
  /** same place, different text: a changed value or label */
  changed: { atPt: [number, number]; from: string; to: string }[];
  added: { atPt: [number, number]; text: string }[];
  removed: { atPt: [number, number]; text: string }[];
}

/** Words matched by position (within tolPt): changed in place, added, removed. */
export function textDiff(a: OcrWord[], b: OcrWord[], tolPt = 2): TextDiff {
  const usedB = new Set<number>();
  const changed: TextDiff['changed'] = [];
  const removed: TextDiff['removed'] = [];
  const at = (w: OcrWord): [number, number] => [Math.round(w.xPt * 10) / 10, Math.round(w.yPt * 10) / 10];
  // exact text matches first (unchanged, possibly nudged), then same-place edits
  const pending: OcrWord[] = [];
  for (const wa of a) {
    const j = b.findIndex((wb, k) => !usedB.has(k) && wb.text === wa.text && Math.hypot(wb.xPt - wa.xPt, wb.yPt - wa.yPt) <= tolPt);
    if (j >= 0) usedB.add(j);
    else pending.push(wa);
  }
  // a changed value keeps its start (centred text moves by half the width
  // change), measured along the word's own baseline so rotated and vertical
  // values match too
  const dir = (w: OcrWord) => {
    const a = (((w as { angleDeg?: number }).angleDeg ?? 0) * Math.PI) / 180;
    return { ux: Math.cos(a), uy: Math.sin(a), deg: (w as { angleDeg?: number }).angleDeg ?? 0 };
  };
  const start = (w: OcrWord) => {
    const d = dir(w);
    return { x: w.xPt - (d.ux * w.wPt) / 2, y: w.yPt - (d.uy * w.wPt) / 2, ...d };
  };
  for (const wa of pending) {
    const sa = start(wa);
    const similar = (t: string) => Math.abs(t.length - wa.text.length) <= Math.max(2, 0.5 * wa.text.length);
    const j = b.findIndex((wb, k) => {
      if (usedB.has(k) || !similar(wb.text)) return false;
      const sb = start(wb);
      const turn = Math.abs(((sb.deg - sa.deg + 540) % 360) - 180);
      if (turn > 5) return false;
      const dx = sb.x - sa.x;
      const dy = sb.y - sa.y;
      const along = dx * sa.ux + dy * sa.uy;
      const across = -dx * sa.uy + dy * sa.ux;
      return Math.abs(across) <= tolPt && Math.abs(along) <= Math.max(tolPt, 0.25 * Math.max(wa.wPt, wb.wPt));
    });
    if (j >= 0) {
      usedB.add(j);
      changed.push({ atPt: at(wa), from: wa.text, to: b[j].text });
    } else removed.push({ atPt: at(wa), text: wa.text });
  }
  const added = b.filter((_, k) => !usedB.has(k)).map((w) => ({ atPt: at(w), text: w.text }));
  return { changed, added, removed };
}
