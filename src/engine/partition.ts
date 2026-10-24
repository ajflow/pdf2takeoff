// Room partition (docs/research/room-partition-design-review.md, sections 2
// and 3). Dynamic Fill can return one bounded region that spans two rooms
// joined by an opening. This pass splits such a region into one region per
// room, or abstains, using only evidence the drawing itself shows:
//
//   1. A door cue: a swing arc found by dynamicfill.ts (swingArcs: a thin
//      arc of door radius over a quarter-ish turn, hinged on line ink),
//      whose door line (hinge to the arc's closed end) runs along a page
//      axis and whose leaf (hinge to the other end) is real ink, opened
//      between LEAF_MIN_DEG and LEAF_MAX_DEG. A double door is two such
//      arcs hinged at opposite ends of one door line, closed ends meeting.
//   2. Wall support for that cue: around the door line, a band of
//      consecutive rows (or columns) whose free run through the doorway
//      ends on ink at both jambs, the hinge on one jamb face and the closed
//      end (or the other hinge) on the other. Both jambs must be walls:
//      longer along the wall than the band is thick, as thick as the band
//      (within JAMB_RATIO of each other), and part of a structural ink
//      piece. The region must lie on both sides of the band (it crosses the
//      doorway). The search starts from the cue, so a leaf drawn touching
//      its jamb, which closingThresholds rightly refuses as a wall end, does
//      not hide the doorway. Engine-drawn pixels (swing chords, vector
//      bridges) are never wall evidence: a virtual closure cannot
//      manufacture support for another.
//   3. Every supported, cued portal becomes a finite-width strip (its band
//      rows across the opening, wall face to wall face); all strips are
//      removed together and the region is labelled once. Strips whose two
//      sides stay connected are redundant and are put back; overlapping
//      strips are rejected as a group. Each child must be room-sized; slivers
//      beside a strip (a ragged jamb) count as strip pixels within a small
//      budget, otherwise the offending strips roll back. At most three
//      labelling passes.
//
// Wall-supported openings without a cue (a cased opening, a bare gap, an
// alcove mouth: the wall-end gaps closingThresholds collects) are never cut.
// They make the result `unresolved` when cutting them would leave two
// room-sized parts, so a caller can tell "no evidence of a second room"
// (`unchanged`) from "a second room is possible but unproven". So does a
// door cue the region crosses with no axis-aligned wall support (a door in
// a diagonal wall): v1 never makes a staircase split. Distance-transform
// necks are not evidence and are not computed.
//
// The result replaces its parent atomically: either the parent alone
// (`unchanged`, `unresolved`) or children whose pixels plus the strip pixels
// account for the parent exactly (`partitioned`). Work is limited to the
// region's bounding box and fixed counts (no wall-clock limits), so the same
// input always gives the same decision.

/**
 * A bridgeable ink-free run along `pos` (row or column), from a up to b.
 * ends: both sides are wall ends (door jambs); false for a wall end facing
 * the side of another wall (a doorway hard against a corner, but also the
 * elbow of an L-shaped room), which closes but never votes for a width.
 */
export interface Gap {
  pos: number;
  a: number;
  b: number;
  ends: boolean;
}

/** Consecutive gaps with the same extents (within 2 px): one doorway through a wall band. */
export interface GapTrack {
  a: number;
  b: number;
  p0: number;
  p1: number;
  runs: Gap[];
}

/**
 * Groups gaps (sorted in place by pos, then a) into tracks: a wall of any
 * thickness crosses several rows or columns, so consecutive gaps with the
 * same extents (within 2 px of anti-aliasing) are one doorway. `finish` is
 * called once per track; a track's a/b are its last run's.
 */
export function trackGaps(gaps: Gap[], finish: (t: GapTrack) => void): void {
  gaps.sort((p, q) => p.pos - q.pos || p.a - q.a);
  let open: GapTrack[] = [];
  let lastPos = -2;
  for (let i = 0; i < gaps.length; ) {
    const pos = gaps[i].pos;
    let j = i;
    while (j < gaps.length && gaps[j].pos === pos) j++;
    if (pos !== lastPos + 1) {
      open.forEach(finish);
      open = [];
    }
    const used = new Set<GapTrack>();
    const next: GapTrack[] = [];
    for (let k = i; k < j; k++) {
      const g = gaps[k];
      const t = open.find((o) => !used.has(o) && Math.abs(o.a - g.a) <= 2 && Math.abs(o.b - g.b) <= 2);
      if (t) {
        used.add(t);
        t.a = g.a;
        t.b = g.b;
        t.p1 = pos;
        t.runs.push(g);
        next.push(t);
      } else {
        next.push({ a: g.a, b: g.b, p0: pos, p1: pos, runs: [g] });
      }
    }
    for (const o of open) if (!used.has(o)) finish(o);
    open = next;
    lastPos = pos;
    i = j;
  }
  open.forEach(finish);
}

/** A door swing arc as dynamicfill.ts fits it: hinge (circle centre, raster px), radius, and the arc's two end points. */
export interface SwingCue {
  hx: number;
  hy: number;
  r: number;
  ends: [{ x: number; y: number }, { x: number; y: number }];
}

export interface PartitionInput {
  w: number;
  h: number;
  /** The bounded region (1 = region pixel), page-sized. Not modified. */
  region: Uint8Array;
  /** Its pixel count. */
  count: number;
  /** Bounding box of the region (inclusive pixel coordinates). */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** The ink mask the region was bounded by (may hold virtual pixels). */
  ink: Uint8Array;
  /** Masks of virtual ink pixels (swing chords, vector bridges): never wall evidence. */
  virtual: (Uint8Array | null)[];
  /** Ink pixels the engine erased from `ink` (swing arcs): the drawing's ink all the same. */
  erased: ReadonlySet<number> | null;
  /** Wall-end gaps from closingThresholds, by orientation (row gaps run along x): uncued-opening evidence. */
  rowGaps: readonly Gap[];
  colGaps: readonly Gap[];
  /** Swing arcs found on the sheet. */
  arcs: readonly SwingCue[];
  /** Narrowest opening (px) treated as a doorway. */
  minDoorPx: number;
  /** Widest opening (px) treated as a doorway (double doors included). */
  maxDoorPx: number;
  /** Span (px) an ink piece must reach to count as structural (wall network), as closingThresholds. */
  structPx: number;
}

export interface PortalEvidence {
  /** 'row': the opening runs along x through a horizontal wall band; 'col': along y. */
  axis: 'row' | 'col';
  /** Opening extent along the wall (px, b exclusive) and the wall band across it (inclusive). */
  a: number;
  b: number;
  p0: number;
  p1: number;
  cue: 'single' | 'double' | null;
  /** cut: removed as a virtual wall strip; otherwise why not. */
  verdict: 'cut' | 'no-door-cue' | 'redundant' | 'conflict' | 'rolled-back';
}

export interface PartitionResult {
  status: 'unchanged' | 'partitioned' | 'unresolved';
  /** Children (status 'partitioned' only): sorted page pixel indices of each. */
  children: Int32Array[];
  portals: PortalEvidence[];
  reasons: string[];
  /** Pixels of the parent assigned to strips (and slivers beside them). */
  stripPx: number;
}

/** Fixed work limits: exceeding one makes the result `unresolved`, never a guess. */
const MAX_ARCS = 512;
const MAX_PORTALS = 256;
const MAX_LABEL_PASSES = 3;
/** Ink pixels a structural-piece search may visit before it calls the piece structural. */
const STRUCT_VISIT_CAP = 50_000;

/*
 * Door-cue tolerances, derived from raster geometry and frozen on the
 * synthetic proxy suite (scripts/check-partition.mjs), never on benchmark
 * data. A Kasa fit of a one-pixel arc stroke puts the hinge and the arc's
 * ends within about a pixel; the hinge may sit on either face of the wall
 * band, half a pixel either side of the jamb corner, or a stroke inside the
 * opening (a leaf drawn from the jamb's inner edge), which the per-px floor
 * plus a share of the door width covers.
 */
/** Hinge vs the hinge-side jamb face, along and across the wall: max(px, share of the door width). */
const HINGE_TOL_PX = 3;
const HINGE_TOL_SHARE = 0.08;
/** Closed end of the arc vs the far jamb face (or the other hinge): max(px, share of the radius). */
const END_TOL_PX = 4;
const END_TOL_SHARE = 0.12;
/**
 * A door line is taken along a page axis when the fitted closed end lies
 * within this angle of it (degrees). The fit grows an arc through thin ink
 * tangent to it, so a jamb's end cap can drag the closed end along the
 * tangent by up to sqrt(2 R band) px, about 16 degrees at R = 40 px; the
 * wall band itself must then be axis-aligned on both faces (scanDoorway),
 * so a door in a diagonal wall still finds no portal.
 */
const AXIS_SNAP_DEG = 20;
/** The leaf opens between these angles from the door line (degrees). */
const LEAF_MIN_DEG = 40;
const LEAF_MAX_DEG = 120;
/** Share of the leaf (hinge to arc end, sampled 20..90 %) that must be real ink within 1 px. */
const LEAF_INK_SHARE = 0.6;
/** Rows (or columns) searched either side of the door line for the wall band, as a share of the door width. */
const BAND_SEARCH_SHARE = 0.4;
/** Jamb thickness ratio a wall band may show across one opening. */
const JAMB_RATIO = 3;
/** The two leaves of a double door: radius ratio at most this. */
const DOUBLE_RADIUS_RATIO = 1.25;
/** A door line counts as crossed when this share of its interior samples is region. */
const CROSS_SHARE = 0.5;

/** Coordinates along (u) and across (v) a wall band, and back to a page index. */
interface Frame {
  axis: 'row' | 'col';
  u: (x: number, y: number) => number;
  v: (x: number, y: number) => number;
}
const ROW: Frame = { axis: 'row', u: (x) => x, v: (_x, y) => y };
const COL: Frame = { axis: 'col', u: (_x, y) => y, v: (x) => x };

interface Candidate {
  axis: 'row' | 'col';
  /** extent along the wall (b exclusive) and the band across it */
  a: number;
  b: number;
  p0: number;
  p1: number;
  L: number;
  /** page indices of the strip */
  px: number[];
  /** page indices of the region pixels just outside the band on each side, across the opening */
  sideA: number[];
  sideB: number[];
  cue: 'single' | 'double' | null;
  arcIdx: number[];
  verdict: PortalEvidence['verdict'];
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
};

/**
 * Labelling buffers, kept between calls and grown as needed (the pass runs
 * serially; reusing them keeps a page of fills from churning megabytes of
 * typed arrays). Views of the first n entries.
 */
let pool: { label: Int32Array; base: Int32Array; stack: Int32Array } | null = null;
function scratch(n: number): { label: Int32Array; base: Int32Array; stack: Int32Array } {
  if (!pool || pool.label.length < n) {
    const size = Math.max(n, 2 * (pool?.label.length ?? 0));
    // a pixel is seeded at most once from each side, so the stack needs 2n
    pool = { label: new Int32Array(size), base: new Int32Array(size), stack: new Int32Array(2 * size + 2) };
  }
  return { label: pool.label.subarray(0, n), base: pool.base.subarray(0, n), stack: pool.stack };
}

export function partitionRegion(inp: PartitionInput): PartitionResult {
  const { w, h, region, box, ink, virtual } = inp;
  const reasons: string[] = [];
  const isVirtual = (i: number) => virtual.some((mk) => mk !== null && mk[i] === 1);
  const inPage = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  // the drawing's own ink: the fill's ink without the engine's chords and
  // bridges, with the swing-arc pixels it erased put back (the erase also
  // takes thin wall ink the arc touches)
  const erased = inp.erased;
  const evidence = (x: number, y: number) => {
    if (!inPage(x, y)) return false;
    const i = y * w + x;
    return (ink[i] === 1 && !isVirtual(i)) || (erased !== null && erased.has(i));
  };
  const inBox = (x: number, y: number) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
  const regionAt = (x: number, y: number) => inBox(x, y) && region[y * w + x] === 1;
  if (inp.arcs.length > MAX_ARCS) return { status: 'unresolved', children: [], portals: [], reasons: ['complex evidence: arc budget exceeded'], stripPx: 0 };

  // in frame f, page (x, y) of along u / across v
  const xy = (f: Frame, u: number, v: number): [number, number] => (f.axis === 'row' ? [u, v] : [v, u]);
  const evF = (f: Frame, u: number, v: number) => {
    const [x, y] = xy(f, u, v);
    return evidence(x, y);
  };
  // the doorway scan stops on the fill's own ink without the engine's
  // drawings, arcs still erased: a swing arc crossing a row is not a jamb
  const stopF = (f: Frame, u: number, v: number) => {
    const [x, y] = xy(f, u, v);
    return inPage(x, y) && ink[y * w + x] === 1 && !isVirtual(y * w + x);
  };
  const regF = (f: Frame, u: number, v: number) => {
    const [x, y] = xy(f, u, v);
    return regionAt(x, y);
  };
  const idxF = (f: Frame, u: number, v: number) => {
    const [x, y] = xy(f, u, v);
    return y * w + x;
  };
  /** consecutive evidence ink from (u, v) stepping du along u, up to cap */
  const runAlong = (f: Frame, u: number, v: number, du: number, cap: number) => {
    let n = 0;
    while (n < cap && evF(f, u + n * du, v)) n++;
    return n;
  };
  // the span (px, capped at structPx) of the connected evidence-ink piece
  // through a pixel, searched breadth-first with a visit cap (a piece that
  // exhausts the cap is the wall network)
  const reachCache = new Map<number, number>();
  const pieceReach = (x: number, y: number): number => {
    const start = y * w + x;
    const hit = reachCache.get(start);
    if (hit !== undefined) return hit;
    if (!evidence(x, y)) return 0;
    const seen = new Set<number>([start]);
    const queue = [start];
    let x0 = x;
    let x1 = x;
    let y0 = y;
    let y1 = y;
    let span = 0;
    for (let q = 0; q < queue.length && span < inp.structPx; q++) {
      if (queue.length > STRUCT_VISIT_CAP) {
        span = inp.structPx;
        break;
      }
      const i = queue[q];
      const px = i % w;
      const py = (i / w) | 0;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      span = Math.min(inp.structPx, Math.max(x1 - x0, y1 - y0));
      for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
        const j = ny * w + nx;
        if (!evidence(nx, ny) || seen.has(j)) continue;
        seen.add(j);
        queue.push(j);
      }
    }
    // only a finished search knows the whole piece; an early stop at
    // structPx is the cap for every pixel it reached
    for (const i of queue) reachCache.set(i, span);
    return span;
  };
  const leafInk = (hx: number, hy: number, tx: number, ty: number): boolean => {
    const len = Math.hypot(tx - hx, ty - hy);
    let hit = 0;
    let n = 0;
    for (let s = 0.2 * len; s <= 0.9 * len; s += 1) {
      const x = Math.round(hx + ((tx - hx) * s) / len);
      const y = Math.round(hy + ((ty - hy) * s) / len);
      n++;
      let found = false;
      for (let oy = -1; oy <= 1 && !found; oy++) for (let ox = -1; ox <= 1 && !found; ox++) if (evidence(x + ox, y + oy)) found = true;
      if (found) hit++;
    }
    return n > 0 && hit >= LEAF_INK_SHARE * n;
  };

  /**
   * An arc's door line along a page axis: frame, hinge (u, v), direction s
   * to the closed end, the closed end's along coordinate, and whether its
   * leaf checks out. Null when the door line is off-axis or the leaf fails.
   */
  type DoorLine = { f: Frame; uh: number; vh: number; s: number; uc: number; vc: number; r: number };
  const doorLines = (k: number): { lines: DoorLine[]; offAxis: boolean } => {
    const arc = inp.arcs[k];
    const lines: DoorLine[] = [];
    let offAxis = false;
    for (let e = 0; e < 2; e++) {
      const closed = arc.ends[e];
      const tip = arc.ends[1 - e];
      const dx = closed.x - arc.hx;
      const dy = closed.y - arc.hy;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const sinTol = Math.sin((AXIS_SNAP_DEG * Math.PI) / 180);
      const f = Math.abs(dy) <= len * sinTol ? ROW : Math.abs(dx) <= len * sinTol ? COL : null;
      // the leaf opens away from the door line, and is drawn
      const a1 = Math.atan2(dy, dx);
      const a2 = Math.atan2(tip.y - arc.hy, tip.x - arc.hx);
      let d = Math.abs(a1 - a2) * (180 / Math.PI);
      if (d > 180) d = 360 - d;
      if (d < LEAF_MIN_DEG || d > LEAF_MAX_DEG || !leafInk(arc.hx, arc.hy, tip.x, tip.y)) continue;
      if (!f) {
        offAxis = true;
        continue;
      }
      // snapped to the axis: the closed end sits one radius from the hinge
      const uh = f.u(arc.hx, arc.hy);
      const vh = f.v(arc.hx, arc.hy);
      const s = Math.sign(f.u(dx, dy));
      lines.push({ f, uh, vh, s, uc: uh + s * arc.r, vc: vh, r: arc.r });
    }
    return { lines, offAxis };
  };

  /**
   * The wall band around a door line: rows (frame-relative) whose free run
   * through the doorway midpoint ends on ink at faces matching the hinge
   * (uh) and the far end (uFar). Returns the candidate strip or null.
   */
  const scanDoorway = (f: Frame, uh: number, vh: number, s: number, uFar: number, L: number, farTol: number): Candidate | null => {
    if (L < inp.minDoorPx || L > inp.maxDoorPx) return null;
    const hingeTol = Math.max(HINGE_TOL_PX, HINGE_TOL_SHARE * L);
    const uM = Math.round((uh + uFar) / 2);
    const span = Math.max(8, Math.ceil(BAND_SEARCH_SHARE * L));
    const reach = Math.ceil(L / 2 + farTol + hingeTol + 2);
    const v0s = Math.round(vh) - span;
    const rows: ({ ua: number; ub: number; wall: boolean } | null)[] = [];
    for (let v = v0s; v <= Math.round(vh) + span; v++) {
      let row: { ua: number; ub: number; wall: boolean } | null = null;
      if (!stopF(f, uM, v) && regF(f, uM, v)) {
        let ua = NaN;
        let ub = NaN;
        for (let k = 1; k <= reach; k++) if (stopF(f, uM - s * k, v)) { ua = uM - s * k; break; }
        for (let k = 1; k <= reach; k++) if (stopF(f, uM + s * k, v)) { ub = uM + s * k; break; }
        if (Number.isFinite(ua) && Number.isFinite(ub) && Math.abs(ua + 0.5 * s - uh) <= hingeTol && Math.abs(ub - 0.5 * s - uFar) <= farTol) {
          // a row whose run ends on ink that carries on along the wall at
          // both jambs; a run ending on two door leaves (the swing side of
          // a double door) matches the faces too, but the leaves turn away
          row = { ua, ub, wall: runAlong(f, ua, v, -s, 3) >= 3 && runAlong(f, ub, v, s, 3) >= 3 };
        }
      }
      rows.push(row);
    }
    // candidate bands: runs of consecutive matching rows whose jamb ends
    // agree within 2 px (one doorway through one wall band, as trackGaps),
    // trimmed to start and end on wall rows (rows inside a hollow wall end
    // on its caps and stay), within reach of the hinge; tried nearest first
    const bands: [number, number, number][] = [];
    for (let i = 0; i < rows.length; ) {
      if (!rows[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < rows.length && rows[j + 1] && Math.abs(rows[j + 1]!.ua - rows[j]!.ua) <= 2 && Math.abs(rows[j + 1]!.ub - rows[j]!.ub) <= 2) j++;
      const next = j + 1;
      while (i <= j && !rows[i]!.wall) i++;
      while (j >= i && !rows[j]!.wall) j--;
      if (i <= j) {
        const lo = v0s + i;
        const hi = v0s + j;
        const d = vh < lo ? lo - vh : vh > hi ? vh - hi : 0;
        if (d <= hingeTol + 1) bands.push([d, lo, hi]);
      }
      i = next;
    }
    bands.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (const [, p0, p1] of bands) {
      const c = bandCheck(f, s, L, rows, v0s, p0, p1);
      if (c) return c;
    }
    return null;
  };

  /** The wall and strip checks on one candidate band p0..p1 of a doorway scan. */
  const bandCheck = (f: Frame, s: number, L: number, rows: ({ ua: number; ub: number; wall: boolean } | null)[], v0s: number, p0: number, p1: number): Candidate | null => {
    const band = p1 - p0 + 1;
    const bandRows = rows.slice(p0 - v0s, p1 - v0s + 1) as { ua: number; ub: number }[];
    // the jambs are walls: longer along the wall than the band is thick (on
    // both band faces: a hollow wall's length is in its faces), ink on both
    // band faces behind the tip, thicknesses within JAMB_RATIO, and part of
    // an ink piece at least as long as the door (the wall network, or a
    // wall stub standing between two doorways)
    const ua = median(bandRows.map((r) => r.ua));
    const ub = median(bandRows.map((r) => r.ub));
    // along the axis on both faces of the band (a diagonal wall's faces step
    // off a row within a few px), at both jambs
    const first = bandRows[0];
    const last = bandRows[bandRows.length - 1];
    const alongA = Math.min(runAlong(f, first.ua, p0, -s, 64), runAlong(f, last.ua, p1, -s, 64));
    const alongB = Math.min(runAlong(f, first.ub, p0, s, 64), runAlong(f, last.ub, p1, s, 64));
    const need = Math.min(64, Math.max(3, 2 * band));
    if (alongA < need || alongB < need) return null;
    const back = (along: number) => Math.min(along - 1, Math.max(2, band));
    const thick = (u: number) => {
      if (!evF(f, u, p0) || !evF(f, u, p1)) return 0;
      let n = band;
      for (let k = 1; k < 256 && evF(f, u, p0 - k); k++) n++;
      for (let k = 1; k < 256 && evF(f, u, p1 + k); k++) n++;
      return n;
    };
    const thA = thick(ua - s * back(alongA));
    const thB = thick(ub + s * back(alongB));
    if (!thA || !thB || Math.max(thA, thB) > JAMB_RATIO * Math.min(thA, thB)) return null;
    const vm = (p0 + p1) >> 1;
    const [jax, jay] = xy(f, ua, vm);
    const [jbx, jby] = xy(f, ub, vm);
    const pieceSpan = Math.min(inp.structPx, L);
    if (pieceReach(jax, jay) < pieceSpan || pieceReach(jbx, jby) < pieceSpan) return null;
    // the strip: each band row's free run between its jambs (region pixels only)
    const px: number[] = [];
    let a = Infinity;
    let b = -Infinity;
    bandRows.forEach((r, k) => {
      const v = p0 + k;
      const lo = Math.min(r.ua, r.ub) + 1;
      const hi = Math.max(r.ua, r.ub) - 1;
      a = Math.min(a, lo);
      b = Math.max(b, hi + 1);
      for (let u = lo; u <= hi; u++) if (regF(f, u, v)) px.push(idxF(f, u, v));
    });
    if (!px.length) return null;
    // the region lies on both sides of the band somewhere across the
    // opening (it crosses the doorway; a chord stopped short may cover part
    // of one side)
    const sideA: number[] = [];
    const sideB: number[] = [];
    for (let u = a; u < b; u++) {
      if (regF(f, u, p0 - 1)) sideA.push(idxF(f, u, p0 - 1));
      if (regF(f, u, p1 + 1)) sideB.push(idxF(f, u, p1 + 1));
    }
    if (!sideA.length || !sideB.length) return null;
    return { axis: f.axis, a, b, p0, p1, L: b - a, px, sideA, sideB, cue: null, arcIdx: [], verdict: 'cut' };
  };

  // --- step A: cue-first portals ------------------------------------------------
  const candidates: Candidate[] = [];
  const near = (k: number) => {
    const a = inp.arcs[k];
    const r = a.r + 4;
    return a.hx + r >= box.x0 && a.hx - r <= box.x1 && a.hy + r >= box.y0 && a.hy - r <= box.y1;
  };
  const lineCache = new Map<number, ReturnType<typeof doorLines>>();
  const linesOf = (k: number) => {
    let l = lineCache.get(k);
    if (!l) lineCache.set(k, (l = doorLines(k)));
    return l;
  };
  const matched = new Set<number>();
  for (let k = 0; k < inp.arcs.length && candidates.length < MAX_PORTALS; k++) {
    if (!near(k)) continue;
    for (const dl of linesOf(k).lines) {
      const c = scanDoorway(dl.f, dl.uh, dl.vh, dl.s, dl.uc, dl.r, Math.max(END_TOL_PX, END_TOL_SHARE * dl.r));
      if (c) {
        c.cue = 'single';
        c.arcIdx = [k];
        candidates.push(c);
        matched.add(k);
        break;
      }
    }
  }
  // double doors: two unmatched arcs on one door line, hinged at its two
  // ends, closed ends meeting, leaves of similar width
  for (let k1 = 0; k1 < inp.arcs.length && candidates.length < MAX_PORTALS; k1++) {
    if (matched.has(k1) || !near(k1)) continue;
    for (let k2 = k1 + 1; k2 < inp.arcs.length && !matched.has(k1); k2++) {
      if (matched.has(k2) || !near(k2)) continue;
      const r1 = inp.arcs[k1].r;
      const r2 = inp.arcs[k2].r;
      if (Math.max(r1, r2) > DOUBLE_RADIUS_RATIO * Math.min(r1, r2)) continue;
      for (const d1 of linesOf(k1).lines) {
        const d2 = linesOf(k2).lines.find((d) => d.f === d1.f && d.s === -d1.s);
        if (!d2) continue;
        const endTol = Math.max(END_TOL_PX, END_TOL_SHARE * Math.max(r1, r2));
        if (Math.abs(d1.vh - d2.vh) > endTol || Math.abs(d1.uc - d2.uc) > 2 * endTol || Math.abs(d1.vc - d2.vc) > endTol) continue;
        const L = Math.abs(d2.uh - d1.uh);
        if (Math.abs(L - (r1 + r2)) > 2 * endTol) continue;
        const c = scanDoorway(d1.f, d1.uh, d1.vh, d1.s, d2.uh, L, Math.max(HINGE_TOL_PX, HINGE_TOL_SHARE * L));
        if (c) {
          c.cue = 'double';
          c.arcIdx = [k1, k2];
          candidates.push(c);
          matched.add(k1);
          matched.add(k2);
          break;
        }
      }
    }
  }
  if (candidates.length >= MAX_PORTALS) return { status: 'unresolved', children: [], portals: [], reasons: ['complex evidence: portal budget exceeded'], stripPx: 0 };
  // the same doorway found twice (two cues on one strip) is one portal
  const seenStrip = new Set<string>();
  const cued = candidates.filter((c) => {
    const key = `${c.px[0]}:${c.px.length}`;
    if (seenStrip.has(key)) return false;
    seenStrip.add(key);
    return true;
  });

  // a door cue whose door line the region crosses with no supported portal
  // to cut there (a door in a diagonal wall, or one the jamb rules reject):
  // the region provably spans a doorway the pass cannot cut
  let unmatchedCrossed = 0;
  for (let k = 0; k < inp.arcs.length; k++) {
    if (matched.has(k) || !near(k)) continue;
    const arc = inp.arcs[k];
    const { lines, offAxis } = linesOf(k);
    if (!lines.length && !offAxis) continue; // not a door symbol (no leaf)
    for (const e of arc.ends) {
      let hit = 0;
      let n = 0;
      for (let s = 0.2; s <= 0.8 + 1e-9; s += 0.05) {
        n++;
        if (regionAt(Math.round(arc.hx + (e.x - arc.hx) * s), Math.round(arc.hy + (e.y - arc.hy) * s))) hit++;
      }
      if (hit >= CROSS_SHARE * n) {
        unmatchedCrossed++;
        break;
      }
    }
  }
  if (unmatchedCrossed) reasons.push(`${unmatchedCrossed} door cue(s) crossed without a wall-supported portal`);

  // wall-supported openings with no cue (closingThresholds' two-wall-end
  // gaps crossing the region, not already a cued strip): evidence that a
  // second room is possible, never a cut
  const uncued: Candidate[] = [];
  const cuedPx = new Set<number>();
  for (const c of cued) for (const i of c.px) cuedPx.add(i);
  let overBudget = false;
  const collectUncued = (gaps: readonly Gap[], f: Frame) => {
    const rows = f.axis === 'row';
    const inside: Gap[] = [];
    for (const g of gaps) {
      if (!g.ends) continue;
      const L = g.b - g.a;
      if (L < inp.minDoorPx || L > inp.maxDoorPx) continue;
      if (rows ? g.pos < box.y0 || g.pos > box.y1 || g.a < box.x0 || g.b - 1 > box.x1 : g.pos < box.x0 || g.pos > box.x1 || g.a < box.y0 || g.b - 1 > box.y1) continue;
      let all = true;
      for (let q = g.a; q < g.b && all; q++) {
        const i = rows ? g.pos * w + q : q * w + g.pos;
        if (!region[i] || cuedPx.has(i)) all = false;
      }
      if (!all) continue;
      const [ax, ay] = rows ? [g.a - 1, g.pos] : [g.pos, g.a - 1];
      const [bx, by] = rows ? [g.b, g.pos] : [g.pos, g.b];
      if (!evidence(ax, ay) || !evidence(bx, by)) continue;
      inside.push({ ...g });
    }
    trackGaps(inside, (t) => {
      if (uncued.length >= MAX_PORTALS) {
        overBudget = true;
        return;
      }
      const a = Math.min(...t.runs.map((g) => g.a));
      const b = Math.max(...t.runs.map((g) => g.b));
      const px: number[] = [];
      for (const g of t.runs) for (let q = g.a; q < g.b; q++) px.push(rows ? g.pos * w + q : q * w + g.pos);
      const sideA: number[] = [];
      const sideB: number[] = [];
      for (let u = a; u < b; u++) {
        if (regF(f, u, t.p0 - 1)) sideA.push(idxF(f, u, t.p0 - 1));
        if (regF(f, u, t.p1 + 1)) sideB.push(idxF(f, u, t.p1 + 1));
      }
      if (!sideA.length || !sideB.length) return;
      uncued.push({ axis: f.axis, a, b, p0: t.p0, p1: t.p1, L: b - a, px, sideA, sideB, cue: null, arcIdx: [], verdict: 'no-door-cue' });
    });
  };
  collectUncued(inp.rowGaps, ROW);
  collectUncued(inp.colGaps, COL);
  if (overBudget) reasons.push('uncued-opening budget exceeded');
  const all = [...cued, ...uncued];
  const portalsOut = (): PortalEvidence[] => all.map((c) => ({ axis: c.axis, a: c.a, b: c.b, p0: c.p0, p1: c.p1, cue: c.cue, verdict: c.verdict }));
  if (!all.length) return { status: unmatchedCrossed ? 'unresolved' : 'unchanged', children: [], portals: [], reasons, stripPx: 0 };

  // --- step C: cut the cued portals together, relabel -------------------------
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  // strip pixels are region pixels, so always inside the box
  const local = (i: number) => (((i / w) | 0) - box.y0) * bw + ((i % w) - box.x0);
  const N = bw * bh;
  // label: 0 unlabelled, -1 strip, -2 outside the region, else component
  // id; base is the region's own box with -2 outside it, made once
  const { label, base, stack } = scratch(N);
  for (let y = 0; y < bh; y++) {
    const row = (y + box.y0) * w + box.x0;
    for (let x = 0; x < bw; x++) base[y * bw + x] = region[row + x] ? 0 : -2;
  }
  const sizes: number[] = [0];
  let cutCount = 0;
  /**
   * Label the region minus the strips (4-connected), one row span at a
   * time: a span is filled whole, then each free run touching it in the
   * rows above and below seeds one more span. Returns the component count.
   */
  const relabel = (strips: Candidate[]): number => {
    label.set(base);
    cutCount = 0;
    for (const c of strips) {
      for (const i of c.px) {
        const l = local(i);
        if (label[l] === 0) cutCount++;
        label[l] = -1;
      }
    }
    sizes.length = 1;
    for (let l0 = 0; l0 < N; l0++) {
      if (label[l0] !== 0) continue;
      const id = sizes.length;
      let n = 0;
      let sp = 0;
      stack[sp++] = l0;
      while (sp) {
        const q = stack[--sp];
        if (label[q] !== 0) continue;
        const row = q - (q % bw);
        let a = q;
        let b = q;
        while (a > row && label[a - 1] === 0) a--;
        while (b < row + bw - 1 && label[b + 1] === 0) b++;
        for (let l = a; l <= b; l++) label[l] = id;
        n += b - a + 1;
        if (row > 0) {
          let inRun = false;
          for (let l = a - bw; l <= b - bw; l++) {
            if (label[l] === 0) {
              if (!inRun) stack[sp++] = l;
              inRun = true;
            } else inRun = false;
          }
        }
        if (row + bw < N) {
          let inRun = false;
          for (let l = a + bw; l <= b + bw; l++) {
            if (label[l] === 0) {
              if (!inRun) stack[sp++] = l;
              inRun = true;
            } else inRun = false;
          }
        }
      }
      sizes.push(n);
    }
    return sizes.length - 1;
  };
  const sidesOf = (c: Candidate): [Set<number>, Set<number>] => {
    const A = new Set<number>();
    const B = new Set<number>();
    for (const i of c.sideA) if (label[local(i)] > 0) A.add(label[local(i)]);
    for (const i of c.sideB) if (label[local(i)] > 0) B.add(label[local(i)]);
    return [A, B];
  };
  /** does the strip separate two labels (its sides share none) */
  const separates = (c: Candidate) => {
    const [A, B] = sidesOf(c);
    if (!A.size || !B.size) return false;
    for (const id of A) if (B.has(id)) return false;
    return true;
  };
  const minChild = (c: Candidate) => Math.max(64, (c.L / 2) ** 2);

  // overlapping strips are conflicting hypotheses: reject the group
  const owner = new Map<number, number>();
  cued.forEach((c, ci) => {
    for (const i of c.px) {
      const o = owner.get(i);
      if (o !== undefined && o !== ci) {
        c.verdict = 'conflict';
        cued[o].verdict = 'conflict';
      } else owner.set(i, ci);
    }
  });
  if (cued.some((c) => c.verdict === 'conflict')) reasons.push('conflicting portal hypotheses rejected');
  let active = cued.filter((c) => c.verdict === 'cut');

  let passes = 0;
  let slivers = 0;
  if (active.length) {
    relabel(active);
    passes++;
    // strips whose sides stay connected cut nothing: put them back
    const redundant = active.filter((c) => !separates(c));
    if (redundant.length) {
      for (const c of redundant) c.verdict = 'redundant';
      active = active.filter((c) => c.verdict === 'cut');
      if (active.length) {
        relabel(active);
        passes++;
      }
    }
    // children must be room-sized; a sliver beside a strip (a ragged jamb
    // row) is strip, within a budget of two opening lengths plus the band
    // per strip; anything else rolls back the strips it touches
    while (active.length) {
      const smallest = Math.min(...active.map(minChild));
      const budget = active.reduce((s, c) => s + 2 * (c.L + c.p1 - c.p0 + 1), 0);
      let small = 0;
      const offenders = new Set<Candidate>();
      for (let id = 1; id < sizes.length; id++) {
        if (sizes[id] >= smallest) continue;
        small += sizes[id];
        for (const c of active) {
          const [A, B] = sidesOf(c);
          if (A.has(id) || B.has(id)) offenders.add(c);
        }
      }
      if (small <= budget) {
        slivers = small;
        break;
      }
      if (passes >= MAX_LABEL_PASSES || offenders.size === 0) {
        reasons.push('partition rejected: fragments beside the strips');
        for (const c of active) c.verdict = 'rolled-back';
        active = [];
        break;
      }
      for (const c of offenders) c.verdict = 'rolled-back';
      active = active.filter((c) => c.verdict === 'cut');
      if (active.length) {
        relabel(active);
        passes++;
      }
    }
  }

  if (active.length) {
    const smallest = Math.min(...active.map(minChild));
    const keep: number[] = [];
    for (let id = 1; id < sizes.length; id++) if (sizes[id] >= smallest) keep.push(id);
    if (keep.length >= 2) {
      const lists = keep.map((id) => new Int32Array(sizes[id]));
      const slot = new Int32Array(sizes.length).fill(-1);
      keep.forEach((id, k) => (slot[id] = k));
      const at = new Int32Array(keep.length);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const id = label[y * bw + x];
          if (id <= 0) continue; // strip (-1) or outside (-2)
          const k = slot[id];
          if (k >= 0) lists[k][at[k]++] = (y + box.y0) * w + x + box.x0;
        }
      }
      const stripPx = cutCount;
      // pixel accounting: children + strips + slivers = parent, exactly
      const childPx = lists.reduce((s, a) => s + a.length, 0);
      if (childPx + stripPx + slivers !== inp.count) {
        return { status: 'unresolved', children: [], portals: portalsOut(), reasons: [...reasons, `unexplained area change (${inp.count} vs ${childPx}+${stripPx}+${slivers})`], stripPx: 0 };
      }
      return { status: 'partitioned', children: lists, portals: portalsOut(), reasons, stripPx: stripPx + slivers };
    }
  }

  // nothing cut. Unresolved when the region provably spans a doorway the
  // pass may not cut: a crossed door cue, a rejected cued split, or
  // wall-supported openings with no cue whose cut would leave two
  // room-sized parts (a cased opening, a bare doorway, an alcove mouth: the
  // information limit, design section 1)
  if (unmatchedCrossed || cued.length) return { status: 'unresolved', children: [], portals: portalsOut(), reasons, stripPx: 0 };
  relabel(uncued);
  const smallest = Math.min(...uncued.map(minChild));
  if (sizes.filter((n, id) => id > 0 && n >= smallest).length >= 2) {
    reasons.push('wall-supported opening(s) without a door cue');
    return { status: 'unresolved', children: [], portals: portalsOut(), reasons, stripPx: 0 };
  }
  return { status: 'unchanged', children: [], portals: portalsOut(), reasons, stripPx: 0 };
}
