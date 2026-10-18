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
//
// Rooms joined by an interior door never leak, so two hints escalate the
// closing further (patch-plan-2 P13): with a known scale, doorways up to
// 1.0 m between wall ends are always closed; and a fill holding two or more
// room labels from the text layer keeps escalating until the clicked room
// holds one. On born-digital sheets the host can also pass doorway bridges
// from the vector layer (fill-vector.ts, P18), which close doors at any
// angle, including in diagonal walls.
//
// With no hints at all (a scanned sheet before calibration) the sheet still
// shows its own doorways: gaps between two facing wall ends with open floor
// on both sides (which rules out dimension-line text breaks), and the
// threshold pass finds every such gap anyway. Their widths cluster at the
// door width. Each width is tried as a closing rung, narrowest first, and
// kept only when it bounds a fill that leaked or cuts a room-sized part off
// the fill (the door between two rooms), never when it would only shave an
// alcove. A known scale always wins.

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
 * points: the room outline (PDF pt). gapPx: width (raster px) of the widest
 * gap the closing actually bridged on this room's boundary, absent when the
 * room was sealed by ink alone. bridged: a vector doorway bridge formed part
 * of the boundary. doorPx / doorSource: the doorway width (raster px) closed
 * by default on this fill, from the calibrated scale or from the sheet's own
 * wall-end gaps; absent when no doorway rule applied.
 */
export type FillResult =
  | { points: Pt[]; gapPx?: number; bridged?: boolean; doorPx?: number; doorSource?: 'scale' | 'sheet' }
  | { error: string };

/** Widest doorway closed automatically once the page scale is known (m). */
const DOOR_MAX_M = 1.0;
/** Ink at least this thick (PDF pt) counts as a heavy (wall-weight) line. */
const HEAVY_PT = 0.9;
/** Ink pieces spanning less than this (PDF pt) are marks, not structure (~1.3 m at 1:100). */
const STRUCT_PT = 36;
/**
 * A label-driven split must cut off at least this share of the merged fill
 * (or MIN_ROOM_M2 when the scale is known): a stray note in a wardrobe or
 * alcove must not shave that alcove off the room.
 */
const MIN_SPLIT_SHARE = 0.15;
const MIN_ROOM_M2 = 2;
/** Label probes sit this far (PDF pt) around a label's centre. */
const LABEL_PROBE_PT = 4;

/** Optional context that lets the fill separate rooms joined by a doorway. */
export interface FillHints {
  /**
   * Centres (PDF pt) of room-label text items from the text layer (see
   * roomLabelPoints). A fill holding two or more labels has merged rooms,
   * so the gap closing keeps escalating until the clicked room holds one.
   */
  labels?: Pt[];
  /**
   * Calibrated scale at the click. Doorways up to DOOR_MAX_M between two
   * wall ends are then always closed, so a room joined to the next by a
   * door fills on its own.
   */
  metersPerPt?: number;
  /**
   * Virtual wall lines (PDF pt) across doorways, from the vector layer
   * (fill-vector.ts doorBridges). Drawn into the ink mask before filling, so
   * doors in diagonal or curved walls close too.
   */
  bridges?: { x1: number; y1: number; x2: number; y2: number }[];
}

/** Threshold for pixels no closing on the ladder ever turns into wall. */
const NEVER = 255;

/** How far (px) wall-end tests look along and across a gap's end ink. */
const WALL_END_REACH = 64;

/**
 * A wall-end gap is a doorway candidate only when open floor runs at least
 * this share of the gap width away from it on both sides (a dimension-line
 * text break has glyphs a few px above the line; a door swing arc crosses
 * the gap's centre line 0.87 gap widths out, a 45° leaf at 0.5) ...
 */
const DOOR_CLEARANCE = 0.4;
/**
 * ... and on at least one side that floor meets a far wall within this many
 * gap widths (about 11 m for a 0.9 m door): a doorway opens onto a room. A
 * gap with nothing at all beyond it on either side sits between two
 * separate drawings.
 */
const DOOR_DEPTH = 12;
/** Door candidates within this ratio of each other form one width cluster. */
const DOOR_CLUSTER = 1.2;
/** Fewest agreeing doorways that make a width the sheet's door width (tried whatever its size). */
const MIN_DOOR_SUPPORT = 2;
/** Other widths are tried only up to this multiple of the sheet's narrowest doorway: wider gaps are openings, not doors. */
const DOOR_WIDEST = 1.5;
/** Slack over a doorway width when it sets the closing rung. */
const DOOR_SLACK = 1.1;

/**
 * A bridgeable ink-free run along `pos` (row or column), from a up to b.
 * ends: both sides are wall ends (door jambs); false for a wall end facing
 * the side of another wall (a doorway hard against a corner, but also the
 * elbow of an L-shaped room), which closes but never votes for a width.
 */
interface Gap {
  pos: number;
  a: number;
  b: number;
  ends: boolean;
}

/**
 * For every pixel, the smallest half-length r at which a binary closing with
 * an axis-aligned line structuring element (dilate then erode, half-length
 * r) along either axis turns it into wall: 0 for ink, NEVER when no rung
 * reaches it. Closing along one axis fills exactly the ink-free runs of
 * length L ≤ 2r that have ink at both ends (L ≤ r for a run that ends at the
 * page edge) and touches nothing else, so every rung of the ladder is a
 * single threshold test on one precomputed array, with no wall pixel or face
 * ever moved.
 *
 * One refinement over a plain closing: an interior run only closes when both
 * of its ends are wall ENDS, ink that carries on along the run's own axis
 * and is longer than it is thick there (de las Heras et al.: walls are lines
 * longer than thick). A door gap sits between two wall ends. The strip
 * between a wall face and a parallel bench line is bounded by the sides of
 * lines, and the short gap from a bench's end to a side wall has a wall
 * face on one side, so neither closes and the floor area is kept.
 *
 * Line weight separates the one case that rule alone gets wrong, a doorway
 * hard against a corner (a wall end facing the side of another wall):
 * walls are drawn heavier than furniture, so a run also closes when one end
 * is a HEAVY wall end (at least heavyPx thick) and the other is heavy ink
 * too. Thin bench and fixture lines never qualify.
 *
 * Either kind of end must belong to STRUCTURAL ink: a connected ink piece
 * spanning at least structPx. Symbols, text glyphs and other small marks
 * (a downlight's flat top edge looks like a short heavy wall end) are
 * isolated pieces, so they never anchor a closing.
 */
function closingThresholds(ink: Uint8Array, w: number, h: number, heavyPx: number, structPx: number): { thr: Uint8Array; doors: SheetDoors } {
  const thr = new Uint8Array(w * h).fill(NEVER);
  // interior wall-end gaps (t < NEVER on an interior run means bridgeable),
  // the raw material for the sheet's own door-width estimate
  const rowGaps: Gap[] = [];
  const colGaps: Gap[] = [];
  // structural-ink cache: 0 unknown, 1 part of a piece spanning structPx, 2 a small piece
  const piece = new Uint8Array(w * h);
  const queue: number[] = [];
  const structural = (start: number): boolean => {
    if (piece[start]) return piece[start] === 1;
    queue.length = 0;
    queue.push(start);
    piece[start] = 3; // visiting
    let x0 = start % w;
    let x1 = x0;
    let y0 = (start / w) | 0;
    let y1 = y0;
    let big = false;
    for (let q = 0; q < queue.length && !big; q++) {
      const i = queue[q];
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x1 - x0 >= structPx || y1 - y0 >= structPx) big = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= w * h || !ink[j]) continue;
        if (piece[j] === 1) big = true;
        if (piece[j]) continue;
        piece[j] = 3;
        queue.push(j);
      }
    }
    const mark = big ? 1 : 2;
    for (const i of queue) piece[i] = mark;
    return big;
  };
  /** consecutive ink from i stepping by d, at most WALL_END_REACH (inBounds guards the axis) */
  const runFrom = (i: number, d: number, steps: number): number => {
    let n = 0;
    for (let k = 0; k < Math.min(steps, WALL_END_REACH) && ink[i + k * d]; k++) n++;
    return n;
  };
  // end ink at (x, y) continuing in direction (dx, dy): its length along the
  // run's axis and its thickness across it
  const endInk = (x: number, y: number, dx: number, dy: number) => {
    const i = y * w + x;
    const along = dx > 0 ? runFrom(i, 1, w - x) : dx < 0 ? runFrom(i, -1, x + 1) : dy > 0 ? runFrom(i, w, h - y) : runFrom(i, -w, y + 1);
    const across = dx !== 0 ? runFrom(i, w, h - y) + runFrom(i, -w, y + 1) - 1 : runFrom(i, 1, w - x) + runFrom(i, -1, x + 1) - 1;
    const solid = structural(i);
    return { along, across, solid, wallEnd: solid && along >= Math.min(WALL_END_REACH, 2 * across) };
  };
  type EndInk = ReturnType<typeof endInk>;
  // two wall ends, or a heavy wall end facing heavy ink (a doorway at a corner)
  const bridgeable = (a: EndInk, b: EndInk): boolean =>
    (a.wallEnd && b.wallEnd) ||
    (a.wallEnd && a.across >= heavyPx && b.solid && Math.min(b.along, b.across) >= heavyPx) ||
    (b.wallEnd && b.across >= heavyPx && a.solid && Math.min(a.along, a.across) >= heavyPx);
  // rows
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (ink[row + x]) {
        thr[row + x] = 0;
        x++;
        continue;
      }
      const a = x;
      while (x < w && !ink[row + x]) x++;
      const b = x;
      let t = NEVER;
      if (a > 0 && b < w) {
        const ea = endInk(a - 1, y, -1, 0);
        const eb = endInk(b, y, 1, 0);
        if (bridgeable(ea, eb)) {
          t = Math.min(Math.ceil((b - a) / 2), NEVER);
          rowGaps.push({ pos: y, a, b, ends: ea.wallEnd && eb.wallEnd });
        }
      } else if (a > 0 || b < w) {
        t = Math.min(b - a, NEVER);
      }
      if (t < NEVER) for (let i = row + a; i < row + b; i++) thr[i] = t;
    }
  }
  // columns, swept row by row (one open-run start per column) so reads stay
  // sequential; only the backfill of a closed run walks a column
  const runStart = new Int32Array(w).fill(-1);
  const flush = (x: number, end: number) => {
    const a = runStart[x];
    let t = NEVER;
    if (a > 0 && end < h) {
      const ea = endInk(x, a - 1, 0, -1);
      const eb = endInk(x, end, 0, 1);
      if (bridgeable(ea, eb)) {
        t = Math.min(Math.ceil((end - a) / 2), NEVER);
        colGaps.push({ pos: x, a, b: end, ends: ea.wallEnd && eb.wallEnd });
      }
    } else if (a > 0 || end < h) {
      t = Math.min(end - a, NEVER);
    }
    if (t < NEVER) for (let y = a, i = a * w + x; y < end; y++, i += w) if (t < thr[i]) thr[i] = t;
    runStart[x] = -1;
  };
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (ink[i]) {
        if (runStart[x] >= 0) flush(x, y);
      } else if (runStart[x] < 0) {
        runStart[x] = y;
      }
    }
  }
  for (let x = 0; x < w; x++) if (runStart[x] >= 0) flush(x, h);
  return { thr, doors: sheetDoors(rowGaps, colGaps, ink, w, h) };
}

/**
 * What the sheet says about its doors. doorPx: the door width (px) when at
 * least MIN_DOOR_SUPPORT doorways agree on one, else 0. widths: the doorway
 * widths worth trying as closing rungs, ascending: every distinct width
 * (cluster maxima) up to DOOR_WIDEST times the narrowest, plus doorPx.
 */
interface SheetDoors {
  doorPx: number;
  widths: number[];
}

/**
 * Doorways read off the gaps between two wall ends (one-ended corner gaps
 * never vote). A wall of any thickness crosses several rows or columns, so
 * consecutive gaps with the same extents (within 2 px of anti-aliasing)
 * count as one doorway. At its centre a doorway has DOOR_CLEARANCE of open
 * floor on both sides (the sheet edge that close counts as a wall) and a
 * far wall within DOOR_DEPTH on at least one. Widths within DOOR_CLUSTER of
 * each other form a cluster; the best-supported cluster (ties to the
 * narrower) sets doorPx by its widest member.
 */
function sheetDoors(rowGaps: Gap[], colGaps: Gap[], ink: Uint8Array, w: number, h: number): SheetDoors {
  const samples: number[] = [];
  // from (x, y) stepping (dx, dy): ink-free px before the first ink or the
  // sheet edge, and whether ink was met within `limit` px
  const probe = (x: number, y: number, dx: number, dy: number, limit: number): { clear: number; wall: boolean } => {
    for (let k = 0; k < limit; k++) {
      const px = x + dx * k;
      const py = y + dy * k;
      if (px < 0 || py < 0 || px >= w || py >= h) return { clear: k, wall: false };
      if (ink[py * w + px]) return { clear: k, wall: true };
    }
    return { clear: limit, wall: false };
  };
  interface Track {
    a: number;
    b: number;
    p0: number;
    p1: number;
  }
  const collect = (gaps: Gap[], rows: boolean) => {
    gaps.sort((p, q) => p.pos - q.pos || p.a - q.a);
    const finish = (t: Track) => {
      const L = t.b - t.a;
      if (L > 2 * (NEVER - 1)) return; // no rung could close it
      const need = Math.ceil(DOOR_CLEARANCE * L);
      const limit = DOOR_DEPTH * L;
      const m = (t.a + t.b - 1) >> 1;
      const [u, v] = rows
        ? [probe(m, t.p0 - 1, 0, -1, limit), probe(m, t.p1 + 1, 0, 1, limit)]
        : [probe(t.p0 - 1, m, -1, 0, limit), probe(t.p1 + 1, m, 1, 0, limit)];
      if (u.clear >= need && v.clear >= need && (u.wall || v.wall)) samples.push(L);
    };
    let open: Track[] = [];
    let lastPos = -2;
    for (let i = 0; i < gaps.length; ) {
      const pos = gaps[i].pos;
      let j = i;
      while (j < gaps.length && gaps[j].pos === pos) j++;
      if (pos !== lastPos + 1) {
        open.forEach(finish);
        open = [];
      }
      const used = new Set<Track>();
      const next: Track[] = [];
      for (let k = i; k < j; k++) {
        const g = gaps[k];
        const t = open.find((o) => !used.has(o) && Math.abs(o.a - g.a) <= 2 && Math.abs(o.b - g.b) <= 2);
        if (t) {
          used.add(t);
          t.a = g.a;
          t.b = g.b;
          t.p1 = pos;
          next.push(t);
        } else {
          next.push({ a: g.a, b: g.b, p0: pos, p1: pos });
        }
      }
      for (const o of open) if (!used.has(o)) finish(o);
      open = next;
      lastPos = pos;
      i = j;
    }
    open.forEach(finish);
  };
  collect(rowGaps.filter((g) => g.ends), true);
  collect(colGaps.filter((g) => g.ends), false);
  if (samples.length === 0) return { doorPx: 0, widths: [] };
  samples.sort((p, q) => p - q);
  const clusters: { top: number; n: number }[] = [];
  for (let i = 0; i < samples.length; ) {
    let j = i;
    while (j + 1 < samples.length && samples[j + 1] <= samples[i] * DOOR_CLUSTER) j++;
    clusters.push({ top: samples[j], n: j - i + 1 });
    i = j + 1;
  }
  let best = clusters[0];
  for (const c of clusters) if (c.n > best.n) best = c;
  const doorPx = best.n >= MIN_DOOR_SUPPORT ? best.top : 0;
  const widths = clusters.map((c) => c.top).filter((t) => t <= samples[0] * DOOR_WIDEST || t === doorPx);
  return { doorPx, widths };
}

export function dynamicFill(raster: RasterPage, seed: Pt, tolerance = 150, hints: FillHints = {}): FillResult {
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
  // vector doorway bridges become ink: 3 px wide so 4-connected fills can't
  // slip through; bridgePx remembers which ink they added, for provenance
  const bridgePx = hints.bridges?.length ? new Uint8Array(w * h) : null;
  for (const b of hints.bridges ?? []) {
    const a = raster.toRaster(b.x1, b.y1);
    const c = raster.toRaster(b.x2, b.y2);
    const n = Math.ceil(Math.hypot(c.x - a.x, c.y - a.y)) + 1;
    for (let k = 0; k <= n; k++) {
      const x = Math.round(a.x + ((c.x - a.x) * k) / n);
      const y = Math.round(a.y + ((c.y - a.y) * k) / n);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const px = x + ox;
          const py = y + oy;
          if (px >= 0 && py >= 0 && px < w && py < h && !ink[py * w + px]) {
            ink[py * w + px] = 1;
            bridgePx![py * w + px] = 1;
          }
        }
      }
    }
  }

  const unbounded = (): FillResult => ({
    error: 'that region is not bounded by lines on all sides — draw around it with the Area tool instead',
  });

  // flood fill (4-connectivity keeps the boundary tight), boundary = ink with
  // gaps up to 2r closed; escalate only while the fill leaks or holds more
  // than one room label. A fill stops the moment it passes the cap: a leak
  // is a leak, however far it would run.
  const cap = MAX_FILL_FRACTION * w * h;
  const mask = new Uint8Array(w * h);
  const pxPerPt = Math.hypot(raster.toRaster(1, 0).x - raster.toRaster(0, 0).x, raster.toRaster(1, 0).y - raster.toRaster(0, 0).y) || 1;
  const { thr, doors } = closingThresholds(ink, w, h, Math.max(2, Math.round(HEAVY_PT * pxPerPt)), Math.round(STRUCT_PT * pxPerPt));
  // a known scale puts the doorway rung on the ladder and starts there:
  // every smaller rung only closes a subset of what it closes. Without a
  // scale the ladder starts at 0 and the sheet's own doorway widths are
  // tried afterwards, each one guarded (below).
  const rungFor = (gapPx: number) => Math.min(NEVER - 1, Math.ceil((DOOR_SLACK * gapPx) / 2));
  let doorR = hints.metersPerPt ? Math.min(NEVER - 1, Math.ceil(((DOOR_MAX_M / hints.metersPerPt) * pxPerPt) / 2)) : 0;
  let doorSource: 'scale' | 'sheet' | undefined = doorR ? 'scale' : undefined;
  const ladder = [...new Set([...GAP_HALF, doorR])].filter((r) => r >= doorR).sort((a, b) => a - b);
  const labelIdx = (hints.labels ?? []).map((l) => {
    const c = raster.toRaster(l.x, l.y);
    const rp = LABEL_PROBE_PT * pxPerPt;
    const probes: number[] = [];
    for (let k = 0; k < 8; k++) {
      const px = Math.round(c.x + rp * Math.cos((k * Math.PI) / 4));
      const py = Math.round(c.y + rp * Math.sin((k * Math.PI) / 4));
      if (px >= 0 && py >= 0 && px < w && py < h) probes.push(py * w + px);
    }
    return probes;
  });
  const labelsIn = (m: Uint8Array) => labelIdx.filter((probes) => probes.some((i) => m[i])).length;

  type Fill = { mask: Uint8Array; count: number; gapR: number; bridged: boolean; rung: number };
  const stack: number[] = [];
  const seedIdx = sy * w + sx;
  // one flood fill with gaps up to 2r closed. reachedMin: the lowest
  // threshold among pixels it reached (a rung below it blocks none of them,
  // so that fill would retrace the same region exactly); leaked: past the cap
  const fillRung = (r: number): { n: number; closedR: number; usedBridge: boolean; reachedMin: number; leaked: boolean } => {
    mask.fill(0);
    stack.length = 0;
    if (thr[seedIdx] <= r) return { n: 0, closedR: 0, usedBridge: false, reachedMin: 0, leaked: true }; // the closing swallowed the click point
    stack.push(seedIdx);
    mask[seedIdx] = 1;
    let reachedMin = thr[seedIdx];
    let n = 1;
    // what actually stopped the fill: a closed gap (0 < thr <= r) or a bridge
    let closedR = 0;
    let usedBridge = false;
    const step = (i: number) => {
      if (mask[i]) return;
      const t = thr[i];
      if (t > r) {
        mask[i] = 1;
        n++;
        if (t < reachedMin) reachedMin = t;
        stack.push(i);
      } else if (t > 0) {
        if (t > closedR) closedR = t;
      } else if (bridgePx && bridgePx[i]) {
        usedBridge = true;
      }
    };
    while (stack.length && n <= cap) {
      const idx = stack.pop()!;
      const x = idx % w;
      if (x > 0) step(idx - 1);
      if (x < w - 1) step(idx + 1);
      if (idx >= w) step(idx - w);
      if (idx + w < w * h) step(idx + w);
    }
    return { n, closedR, usedBridge, reachedMin, leaked: n > cap };
  };
  const keep = (f: { n: number; closedR: number; usedBridge: boolean }, rung: number): Fill => ({ mask: mask.slice(), count: f.n, gapR: f.closedR, bridged: f.usedBridge, rung });
  // a split found by escalating past labels (or by trying a doorway width)
  // must cut off a room-sized part, not an alcove
  const minRoomPx = hints.metersPerPt ? MIN_ROOM_M2 / (hints.metersPerPt / pxPerPt) ** 2 : 0;
  const roomSized = (base: Fill, n: number) => base.count - n >= Math.max(MIN_SPLIT_SHARE * base.count, minRoomPx);

  let out: Fill | null = null;
  // bounded but spanning several labelled rooms: the fallback while wider
  // gaps are tried
  let merged: Fill | null = null;
  let reachedMin = 0;
  // highest rung actually filled: fills nest, so a lower rung tried later
  // can only repeat a result the ladder already judged
  let topTried = 0;
  for (const r of ladder) {
    if (r < reachedMin) continue;
    const f = fillRung(r);
    reachedMin = f.reachedMin;
    topTried = r;
    if (f.leaked) continue;
    if (labelIdx.length && labelsIn(mask) >= 2) {
      merged ??= keep(f, r);
      continue;
    }
    if (merged && !roomSized(merged, f.n)) break;
    out = keep(f, r);
    break;
  }
  // Without a scale, each doorway width the sheet shows is tried in turn
  // (narrowest first) beyond the rung reached so far: it is kept when it
  // bounds a fill that leaked, or cuts a room-sized part off the fill (the
  // door between two rooms), never when it only shaves an alcove. A width
  // that swallows the click or still leaks is simply skipped, so nothing
  // the sheet shows can break a fill that was already bounded.
  if (!hints.metersPerPt) {
    for (const width of doors.widths) {
      const r = rungFor(width);
      const base = out ?? merged;
      if (r <= Math.max(topTried, base ? base.rung : 0)) continue;
      const f = fillRung(r);
      if (f.leaked) continue;
      if (labelIdx.length && labelsIn(mask) >= 2) {
        merged ??= keep(f, r);
        continue;
      }
      if (base && !roomSized(base, f.n)) continue;
      out = keep(f, r);
      doorR = r;
      doorSource = 'sheet';
      break;
    }
  }
  if (!out && merged) out = merged;
  if (!out) return unbounded();
  const region = out.mask;
  const count = out.count;
  const gapR = out.gapR;
  const bridged = out.bridged;

  // Moore-neighbour boundary trace, clockwise from the topmost-leftmost pixel
  let startIdx = -1;
  for (let i = 0; i < region.length; i++) {
    if (region[i]) {
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
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && region[y * w + x];
  const boundaryPts: { x: number; y: number }[] = [];
  let cx = startIdx % w;
  let cy = (startIdx / w) | 0;
  let dir = 0; // entered heading east (nothing lies above or left of start)
  const startX = cx;
  const startY = cy;
  let firstDir = -1;
  for (let guard = 0; guard < 4 * region.length; guard++) {
    // search clockwise starting 90° left of the heading, so the trace hugs
    // the outside and follows concave corners instead of cutting across them
    let d = -1;
    for (let k = 0; k < 8; k++) {
      const c = (dir + 6 + k) % 8;
      if (at(cx + dirs[c][0], cy + dirs[c][1])) {
        d = c;
        break;
      }
    }
    // Jacob's stopping criterion: back at the start, leaving the way we first left
    if (d >= 0 && cx === startX && cy === startY && d === firstDir) break;
    boundaryPts.push({ x: cx, y: cy });
    if (d < 0) break; // single-pixel region
    if (firstDir < 0) firstDir = d;
    cx += dirs[d][0];
    cy += dirs[d][1];
    dir = d;
  }
  if (boundaryPts.length < 8) return { error: 'that region is too small to fill' };

  const simplified = douglasPeucker(boundaryPts, 1.5);
  if (simplified.length < 3) return { error: 'that region is too small to fill' };

  // plausibility: the polygon runs through the centres of the boundary
  // pixels, so its area sits at roughly count minus half the perimeter (more
  // when ink islands inside the room are excluded from count). Well under
  // count minus the full perimeter means the trace cut across the region.
  const area = shoelace(simplified);
  if (area < 0.8 * (count - boundaryPts.length) || area > 5 * count) return unbounded();

  const points = simplified.map((p) => raster.toPdf(p.x, p.y));
  return {
    points,
    ...(gapR > 0 ? { gapPx: 2 * gapR } : {}),
    ...(bridged ? { bridged: true } : {}),
    ...(doorSource ? { doorPx: 2 * doorR, doorSource } : {}),
  };
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
