// Wall runs read off a CAD sheet's wall layers. Fit-out drawings fill each
// wall piece with the shade its legend gives it ("PROPOSED PARTITION" mid
// grey, "EXISTING PARTITION" dark, "HALF HEIGHT" white), so the new walls an
// estimator prices are the pieces in the proposed shades, and their length is
// each piece's centreline. Pieces come back as proposals: the person sees
// every run on the drawing and confirms or deletes it.

import type { VecPage } from './vector.ts';
import type { Pt } from './types.ts';
import type { DimWord } from './dimensions.ts';

/** The closed outlines of a filled path, in order (a fill closes each subpath implicitly). */
export function ringsOf(vec: VecPage, pathIndex: number): Pt[][] {
  const [a, b] = vec.paths[pathIndex].segs;
  const rings: Pt[][] = [];
  let ring: Pt[] = [];
  for (let i = a; i < b; i++) {
    const s = vec.segs[i];
    const last = ring[ring.length - 1];
    if (!last || Math.hypot(last.x - s.x1, last.y - s.y1) > 0.01) {
      if (ring.length >= 3) rings.push(ring);
      ring = [{ x: s.x1, y: s.y1 }];
    }
    ring.push({ x: s.x2, y: s.y2 });
  }
  if (ring.length >= 3) rings.push(ring);
  // drop the repeated closing vertex
  return rings.map((r) => (Math.hypot(r[0].x - r[r.length - 1].x, r[0].y - r[r.length - 1].y) < 0.01 ? r.slice(0, -1) : r)).filter((r) => r.length >= 3);
}

const area = (r: Pt[]) => Math.abs(r.reduce((s, p, i) => s + p.x * r[(i + 1) % r.length].y - r[(i + 1) % r.length].x * p.y, 0)) / 2;
const dist = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y);
const mid = (p: Pt, q: Pt): Pt => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
const polyLength = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);

/** Points spaced evenly along a polyline, `n` of them including both ends. */
function resample(pts: Pt[], n: number): Pt[] {
  const total = polyLength(pts);
  if (total === 0) return Array.from({ length: n }, () => ({ ...pts[0] }));
  const out: Pt[] = [];
  let seg = 1;
  let walked = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (seg < pts.length - 1 && walked + dist(pts[seg - 1], pts[seg]) < target) {
      walked += dist(pts[seg - 1], pts[seg]);
      seg++;
    }
    const len = dist(pts[seg - 1], pts[seg]) || 1;
    const t = Math.min(1, Math.max(0, (target - walked) / len));
    out.push({ x: pts[seg - 1].x + (pts[seg].x - pts[seg - 1].x) * t, y: pts[seg - 1].y + (pts[seg].y - pts[seg - 1].y) * t });
  }
  return out;
}

export interface WallPiece {
  /** the centreline, end to end (PDF points) */
  points: Pt[];
  lengthPt: number;
  thicknessPt: number;
}

/**
 * A wall piece's centreline. Its two ends are the two shortest edges that
 * do not touch; the outline between them is the wall's two faces, and the
 * centreline runs midway between them (a straight piece gives a straight
 * line, a curved wall a curve). Null for shapes that are not wall-like
 * (junction blobs, columns): thicker than half their length.
 */
export function centreline(ring: Pt[]): WallPiece | null {
  const n = ring.length;
  if (n < 4) return null;
  const edge = (i: number) => dist(ring[i], ring[(i + 1) % n]);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => edge(a) - edge(b));
  const e0 = order[0];
  const e1 = order.find((i) => i !== e0 && i !== (e0 + 1) % n && i !== (e0 + n - 1) % n);
  if (e1 === undefined) return null;
  // the faces: from the end of edge e0 to the start of edge e1, and back
  const walk = (from: number, to: number) => {
    const pts: Pt[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      pts.push(ring[i]);
      if (i === to) break;
    }
    return pts;
  };
  const faceA = walk((e0 + 1) % n, e1);
  const faceB = walk((e1 + 1) % n, e0).reverse();
  const steps = Math.max(2, Math.min(32, Math.max(faceA.length, faceB.length) * 2));
  const a = resample(faceA, steps);
  const b = resample(faceB, steps);
  const points = a.map((p, k) => mid(p, b[k]));
  // straight pieces: the midpoints of the two ends, exactly
  if (n === 4) {
    points.splice(0, points.length, mid(ring[e0], ring[(e0 + 1) % n]), mid(ring[e1], ring[(e1 + 1) % n]));
  }
  const lengthPt = polyLength(points);
  if (lengthPt <= 0) return null;
  const thicknessPt = area(ring) / lengthPt;
  if (thicknessPt * 2 > lengthPt) return null;
  return { points, lengthPt, thicknessPt };
}

export interface LegendEntry {
  fill: string;
  name: string;
  /** the swatch's box, so the swatch itself is not counted as a wall */
  box?: [number, number, number, number];
}

/** Legend wording for wall types. */
const LEGEND_TEXT = /partition|wall|half height|full height|existing|proposed|\bnew\b|demoli/i;

/**
 * The sheet's wall legend: each label ("PROPOSED PARTITION") paired with the
 * filled swatch just to its left. Words are grouped into lines first.
 */
export function readWallLegend(words: DimWord[], vec: VecPage): LegendEntry[] {
  const sorted = [...words].filter((w) => (w.angleDeg ?? 0) === 0).sort((a, b) => b.yPt - a.yPt || a.xPt - b.xPt);
  const lines: { text: string; x0: number; x1: number; y: number; h: number }[] = [];
  for (const w of sorted) {
    const l = lines.find((q) => Math.abs(q.y - w.yPt) < q.h * 0.5 && w.xPt - w.wPt / 2 - q.x1 < 2 * q.h && w.xPt - w.wPt / 2 > q.x0);
    if (l) {
      l.text += ` ${w.text}`;
      l.x1 = Math.max(l.x1, w.xPt + w.wPt / 2);
    } else lines.push({ text: w.text, x0: w.xPt - w.wPt / 2, x1: w.xPt + w.wPt / 2, y: w.yPt, h: w.hPt });
  }
  const found: { fill: string; name: string; x0: number; w: number; box: [number, number, number, number] }[] = [];
  // an outlined box with no fill is a white swatch
  const outlined = (p: VecPage['paths'][number]) => p.segs[1] - p.segs[0] === 4 && vec.segs[p.segs[0]].stroked;
  for (const l of lines) {
    if (!LEGEND_TEXT.test(l.text) || l.text.split(/\s+/).length > 4) continue;
    let best: { fill: string; gap: number; x0: number; w: number; box: [number, number, number, number] } | null = null;
    for (const p of vec.paths) {
      const fill = p.fill ?? (outlined(p) ? '#ffffff' : undefined);
      if (!fill) continue;
      const w = p.x1 - p.x0;
      const h = p.y1 - p.y0;
      if (w < 4 || w > 80 || h < 1.5 || h > 24) continue;
      const gap = l.x0 - p.x1;
      if (gap < -2 || gap > 40) continue;
      // the swatch sits level with its label; a filled swatch beats an outline nearby
      const off = Math.abs((p.y0 + p.y1) / 2 - l.y);
      if (off > Math.max(h, l.h) * 0.75) continue;
      const score = gap + off * 2 + (p.fill ? 0 : 6);
      if (!best || score < best.gap) best = { fill, gap: score, x0: p.x0, w, box: [p.x0, p.y0, p.x1, p.y1] };
    }
    if (best) found.push({ fill: best.fill, name: l.text.trim(), x0: best.x0, w: best.w, box: best.box });
  }
  // a legend stacks its swatches in a column: keep the largest group of
  // same-width swatches sharing a left edge, so a stray note beside some
  // white box elsewhere on the sheet is not mistaken for an entry
  let column: typeof found = [];
  for (const f of found) {
    const group = found.filter((g) => Math.abs(g.x0 - f.x0) < 2 && Math.abs(g.w - f.w) < 2);
    if (group.length > column.length) column = group;
  }
  const out: LegendEntry[] = [];
  for (const f of column.length >= 2 ? column : found) if (!out.some((e) => e.fill === f.fill)) out.push({ fill: f.fill, name: f.name, box: f.box });
  return out;
}

/** Brightness of a "#rrggbb" fill, 0 (black) to 1 (white); NaN for anything else. */
function shade(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return NaN;
  const [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  if (Math.max(r, g, b) - Math.min(r, g, b) > 24) return NaN; // a colour, not a grey: no shade matching
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * The legend entry for a wall fill: an exact colour match, else, for greys,
 * the nearest grey within 0.2 (CAD exports often print the legend swatch a
 * tint lighter than the walls it describes).
 */
export function legendFor(fill: string, legend: LegendEntry[]): LegendEntry | undefined {
  const exact = legend.find((e) => e.fill === fill);
  if (exact) return exact;
  const s = shade(fill);
  let best: { e: LegendEntry; d: number } | undefined;
  for (const e of legend) {
    const d = Math.abs(shade(e.fill) - s);
    if (d <= 0.2 && (!best || d < best.d)) best = { e, d };
  }
  return best?.e;
}

export type WallKind = 'new' | 'existing' | 'demolish' | 'unknown';

/** What a legend name says about the walls in its shade. */
export function wallKind(name: string): WallKind {
  if (/demoli|remove/i.test(name)) return 'demolish';
  if (/exist|retain/i.test(name)) return 'existing';
  if (/new|propos|half height|full height/i.test(name)) return 'new';
  return 'unknown';
}

export interface WallClass {
  fill: string;
  /** the legend's name for the shade, or a description of it */
  name: string;
  kind: WallKind;
  pieces: WallPiece[];
  lengthPt: number;
  /** filled shapes in this shade that were not wall-like (left out) */
  skipped: number;
}

/**
 * The wall runs on `walls` (the vector layer with only the wall layers
 * visible), grouped by fill shade and named from the legend. Classes come
 * longest first.
 */
export function wallRuns(walls: VecPage, legend: LegendEntry[]): WallClass[] {
  const rings = new Map<string, Pt[][]>();
  walls.paths.forEach((p, i) => {
    if (!p.fill) return;
    const list = rings.get(p.fill) ?? [];
    list.push(...ringsOf(walls, i));
    rings.set(p.fill, list);
  });
  const classes: WallClass[] = [];
  for (const [fill, list] of rings) {
    const entry = legendFor(fill, legend);
    const c: WallClass = { fill, name: entry?.name ?? `walls filled ${fill}`, kind: entry ? wallKind(entry.name) : 'unknown', pieces: [], lengthPt: 0, skipped: 0 };
    const swatches = legend.flatMap((e) => (e.box ? [e.box] : []));
    const onSwatch = (r: Pt[]) => swatches.some(([x0, y0, x1, y1]) => r.every((p) => p.x >= x0 - 0.5 && p.x <= x1 + 0.5 && p.y >= y0 - 0.5 && p.y <= y1 + 0.5));
    const squares: Pt[][] = [];
    for (const ring of pairTriangles(list)) {
      if (onSwatch(ring)) continue;
      const piece = centreline(ring);
      if (piece) {
        c.pieces.push(piece);
        c.lengthPt += piece.lengthPt;
      } else if (ring.length === 4) squares.push(ring);
      else c.skipped++;
    }
    // the squares where pieces meet (corners, junctions) are part of the run:
    // a square about one wall thick counts its side; a bigger one (a column) does not
    const t = c.pieces.map((p) => p.thicknessPt).sort((a, b) => a - b)[c.pieces.length >> 1];
    for (const sq of squares) {
      const side = Math.max(dist(sq[0], sq[1]), dist(sq[1], sq[2]));
      if (t && side >= 0.6 * t && side <= 1.6 * t) {
        const m = { x: sq.reduce((s, p) => s + p.x, 0) / 4, y: sq.reduce((s, p) => s + p.y, 0) / 4 };
        c.pieces.push({ points: [{ x: m.x - side / 2, y: m.y }, { x: m.x + side / 2, y: m.y }], lengthPt: side, thicknessPt: side });
        c.lengthPt += side;
      } else c.skipped++;
    }
    if (c.pieces.length) classes.push(c);
  }
  return classes.sort((a, b) => b.lengthPt - a.lengthPt);
}

/**
 * Some CAD exports fill each wall piece as two triangles. Triangles that
 * share an edge are joined back into the four-sided piece they came from;
 * other outlines pass through unchanged.
 */
export function pairTriangles(rings: Pt[][]): Pt[][] {
  const out: Pt[][] = [];
  const tris = rings.filter((r) => r.length === 3);
  for (const r of rings) if (r.length !== 3) out.push(r);
  const same = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) < 0.05;
  const used = new Set<number>();
  for (let i = 0; i < tris.length; i++) {
    if (used.has(i)) continue;
    const t = tris[i];
    let joined = false;
    for (let j = i + 1; j < tris.length && !joined; j++) {
      if (used.has(j)) continue;
      const u = tris[j];
      const common = t.filter((p) => u.some((q) => same(p, q)));
      if (common.length !== 2) continue;
      const [a, b] = common;
      const c = t.find((p) => !same(p, a) && !same(p, b))!;
      const d = u.find((q) => !same(q, a) && !same(q, b))!;
      out.push([a, c, b, d]);
      used.add(i).add(j);
      joined = true;
    }
    if (!joined) out.push(t); // a lone triangle: centreline() rejects it
  }
  return out;
}

/** The markup label for a class of runs: "Walls (proposed partition)" rolls up into a template's Walls line. */
export function wallLabel(c: WallClass): string {
  const detail = c.name.toLowerCase();
  if (c.kind === 'existing') return `Existing walls (${detail})`;
  if (c.kind === 'demolish') return `Walls to demolish (${detail})`;
  return `Walls (${detail})`;
}

/**
 * The classes to propose: the legend's new walls; when the sheet has no
 * legend naming any, every unnamed shade, for the person to sort out;
 * `all` adds existing and demolished walls.
 */
export function classesToPropose(classes: WallClass[], include: 'new' | 'all' = 'new'): WallClass[] {
  if (include === 'all') return classes;
  const fresh = classes.filter((c) => c.kind === 'new');
  return fresh.length ? fresh : classes.filter((c) => c.kind === 'unknown');
}
