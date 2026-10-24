// Synthetic proxy layouts for the room-partition pass (src/engine/partition.ts;
// design: docs/research/room-partition-design-review.md, section 3). Every
// layout is analytic: walls, openings, door symbols, furniture and clutter in
// layout units with the true room interiors as rectangles and one seed point
// per room. Nothing here comes from a benchmark sheet: proportions are
// ordinary residential geometry at 1:100.
//
// Units: 1 u = 1 raster px at 3 px/pt, so 1 m = 85.04 u at 1:100. render(layout,
// k) draws at k raster px per u (k = 0.5 / 1 / 2 is 1.5 / 3 / 6 px per pt),
// rounding each primitive to whole pixels; toPdf/toRaster report 3k px per pt
// so the engine's point-based constants act as on a real sheet. pdfBytes()
// draws the same layout as a vector PDF for the production render path.
//
// Primitives: rect (filled ink, x1/y1 exclusive), line (stroke of width w),
// arc (stroke, centre/radius/angles in radians, y down), ring (a glyph).

export const M = 72 / 0.0254 / 100 * 3; // u per metre at 1:100 (85.04)
export const m = (v) => Math.round(v * M);

const rect = (x0, y0, x1, y1) => ({ t: 'rect', x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
const line = (x0, y0, x1, y1, w = 1) => ({ t: 'line', x0, y0, x1, y1, w });
const arc = (cx, cy, r, a0, a1, w = 1) => ({ t: 'arc', cx, cy, r, a0, a1, w });
const ring = (cx, cy, r, w = 1) => ({ t: 'ring', cx, cy, r, w });

/**
 * A wall band from (x0,y0) to (x1,y1) along one axis, thickness t, with
 * openings [from, to] along its length (absolute coordinates). conv
 * 'filled' draws solid bands; 'thin' a single stroke of width t; 'outline'
 * two faces of width 1 with end caps at every wall end (a hollow wall).
 */
function wall(prims, axis, c0, a0, a1, t, openings = [], conv = 'filled') {
  const cuts = [...openings].sort((p, q) => p[0] - q[0]);
  const pieces = [];
  let s = a0;
  for (const [o0, o1] of cuts) {
    if (o0 > s) pieces.push([s, o0]);
    s = Math.max(s, o1);
  }
  if (s < a1) pieces.push([s, a1]);
  for (const [p0, p1] of pieces) {
    if (conv === 'outline') {
      const faces = [c0, c0 + t - 1];
      for (const f of faces) prims.push(axis === 'x' ? rect(p0, f, p1, f + 1) : rect(f, p0, f + 1, p1));
      for (const e of [p0, p1 - 1]) prims.push(axis === 'x' ? rect(e, c0, e + 1, c0 + t) : rect(c0, e, c0 + t, e + 1));
    } else {
      prims.push(axis === 'x' ? rect(p0, c0, p1, c0 + t) : rect(c0, p0, c0 + t, p1));
    }
  }
}

/**
 * A door symbol in a wall opening: leaf from the hinge, a swing arc from
 * the leaf tip to the far jamb. axis: the wall's axis ('x' horizontal wall,
 * 'y' vertical). The opening runs from o0 to o1 along it; the wall band
 * spans c0..c0+t across. hinge 'a' at o0 or 'b' at o1; side -1 swings
 * towards smaller coordinates across the wall, +1 towards larger. open:
 * leaf angle from the door line (degrees, 90 = fully open). Double doors
 * hinge one leaf at each jamb.
 */
function door(prims, axis, c0, t, o0, o1, { hinge = 'a', side = -1, open = 90, double = false, stroke = 1 } = {}) {
  const face = side < 0 ? c0 : c0 + t; // the face the door swings from
  const leafSet = double ? [['a', (o1 - o0) / 2], ['b', (o1 - o0) / 2]] : [[hinge, o1 - o0]];
  for (const [hg, R] of leafSet) {
    const hu = hg === 'a' ? o0 : o1; // along
    const dirU = hg === 'a' ? 1 : -1; // towards the far jamb
    const th = (open * Math.PI) / 180;
    // leaf: from the hinge, angle th off the door line, into the swing side
    const tipU = hu + dirU * R * Math.cos(th);
    const tipV = face + side * R * Math.sin(th);
    const P = (u, v) => (axis === 'x' ? [u, v] : [v, u]);
    const [hx, hy] = P(hu, face);
    const [tx, ty] = P(tipU, tipV);
    prims.push(line(hx, hy, tx, ty, stroke));
    // arc from the closed position (on the door line) to the tip
    const closed = Math.atan2(...(axis === 'x' ? [0, dirU] : [dirU, 0]));
    const tipA = Math.atan2(ty - hy, tx - hx);
    let a0 = closed;
    let a1 = tipA;
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    a1 = a0 + d;
    prims.push(arc(hx, hy, R, Math.min(a0, a1), Math.max(a0, a1), stroke));
  }
}

/** Outer frame (filled) around an interior box; openings as [side, from, to]. */
function frame(prims, x0, y0, x1, y1, t, openings = [], conv = 'filled') {
  const on = (s) => openings.filter((o) => o[0] === s).map((o) => [o[1], o[2]]);
  wall(prims, 'x', y0 - t, x0 - t, x1 + t, t, on('top'), conv);
  wall(prims, 'x', y1, x0 - t, x1 + t, t, on('bottom'), conv);
  wall(prims, 'y', x0 - t, y0, y1, t, on('left'), conv);
  wall(prims, 'y', x1, y0, y1, t, on('right'), conv);
}

const PAD = 420; // page margin around the building (u): the outside stays unbounded

/** A layout: prims, rooms [{name, rects}], seeds [{room, x, y}], page size. */
function layout(name, prims, rooms, extra = {}) {
  let x1 = 0;
  let y1 = 0;
  for (const p of prims) {
    x1 = Math.max(x1, p.x1 ?? p.x0 ?? 0, (p.cx ?? 0) + (p.r ?? 0));
    y1 = Math.max(y1, p.y1 ?? p.y0 ?? 0, (p.cy ?? 0) + (p.r ?? 0));
  }
  const seeds = rooms.flatMap((r) => (r.seeds ?? [centre(r.rects[0])]).map(([x, y]) => ({ room: r.name, x, y })));
  return { name, prims, rooms, seeds, W: Math.ceil(x1 + PAD), H: Math.ceil(y1 + PAD), ...extra };
}
const centre = ([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2];

const O = PAD; // building origin (interior top-left)
const T_OUT = m(0.2);
const T_IN = m(0.1);

// ---------------------------------------------------------------------------
// layout families (section 3 of the design review)

/**
 * Two rooms side by side, the partition wall vertical (axis 'y'), with the
 * openings given. door: undefined (bare gap), or door() options.
 */
export function twoRooms({ wA = m(4.5), wB = m(3.5), hgt = m(4), t = T_IN, conv = 'filled', openings = [[m(0.8), m(1.7)]], doors = [{}], tOut = T_OUT, outerConv = 'filled', name = 'two-door' } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const xw = x0 + wA; // partition wall face (room A side)
  const x1 = xw + t + wB;
  const y1 = y0 + hgt;
  frame(prims, x0, y0, x1, y1, tOut, [], outerConv);
  const abs = openings.map(([a, b]) => [y0 + a, y0 + b]);
  wall(prims, 'y', xw, y0, y1, t, abs, conv);
  abs.forEach(([a, b], k) => {
    const d = doors[k];
    if (d) door(prims, 'y', xw, t, a, b, d);
  });
  return layout(name, prims, [
    { name: 'A', rects: [[x0, y0, xw, y1]] },
    { name: 'B', rects: [[xw + t, y0, x1, y1]] },
  ]);
}

/** Three rooms in a loop: A | B above C, doors A-B, A-C, B-C. */
export function threeRoomCycle({ t = T_IN, L = m(0.9) } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const wA = m(4);
  const wB = m(3.5);
  const hTop = m(3.5);
  const hC = m(3);
  const xw = x0 + wA;
  const x1 = xw + t + wB;
  const yw = y0 + hTop;
  const y1 = yw + t + hC;
  frame(prims, x0, y0, x1, y1, T_OUT);
  const dAB = [y0 + m(1), y0 + m(1) + L];
  wall(prims, 'y', xw, y0, yw, t, [dAB]);
  door(prims, 'y', xw, t, dAB[0], dAB[1], { hinge: 'a', side: -1 });
  const dAC = [x0 + m(1), x0 + m(1) + L];
  const dBC = [xw + t + m(1.2), xw + t + m(1.2) + L];
  wall(prims, 'x', yw, x0, x1, t, [dAC, dBC]);
  door(prims, 'x', yw, t, dAC[0], dAC[1], { hinge: 'a', side: 1 });
  door(prims, 'x', yw, t, dBC[0], dBC[1], { hinge: 'b', side: -1 });
  return layout('three-room-cycle', prims, [
    { name: 'A', rects: [[x0, y0, xw, yw]] },
    { name: 'B', rects: [[xw + t, y0, x1, yw]] },
    { name: 'C', rects: [[x0, yw + t, x1, y1]] },
  ]);
}

/** Two rooms joined by a door in a diagonal wall (angle in degrees from vertical). */
export function rotatedDoor({ deg = 30, L = m(0.9), t = T_IN } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(8);
  const y1 = y0 + m(4.5);
  frame(prims, x0, y0, x1, y1, T_OUT);
  // the diagonal wall: a thick stroke from top to bottom through the middle
  const a = (deg * Math.PI) / 180;
  const cx = (x0 + x1) / 2;
  const top = [cx - Math.tan(a) * (y1 - y0) / 2, y0];
  const bot = [cx + Math.tan(a) * (y1 - y0) / 2, y1];
  const len = Math.hypot(bot[0] - top[0], bot[1] - top[1]);
  const ux = (bot[0] - top[0]) / len;
  const uy = (bot[1] - top[1]) / len;
  const g0 = len * 0.3;
  const g1 = g0 + L;
  const P = (s) => [top[0] + ux * s, top[1] + uy * s];
  prims.push(line(...P(-t), ...P(g0), t));
  prims.push(line(...P(g1), ...P(len + t), t));
  // leaf + arc hinged at the first jamb, swinging to the right side
  const [hx, hy] = P(g0 + t / 2);
  const nx = uy;
  const ny = -ux; // normal pointing to the left room... flip to the right
  const tip = [hx - nx * L, hy - ny * L];
  prims.push(line(hx, hy, tip[0], tip[1], 1));
  const aClosed = Math.atan2(uy, ux);
  const aTip = Math.atan2(tip[1] - hy, tip[0] - hx);
  let d = aTip - aClosed;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  prims.push(arc(hx, hy, L - t / 2, Math.min(aClosed, aClosed + d), Math.max(aClosed, aClosed + d), 1));
  return layout(`rotated-door-${deg}`, prims, [
    { name: 'L', rects: [[x0, y0, Math.min(top[0], bot[0]) - t, y1]], seeds: [[x0 + m(1), (y0 + y1) / 2]] },
    { name: 'R', rects: [[Math.max(top[0], bot[0]) + t, y0, x1, y1]], seeds: [[x1 - m(1), (y0 + y1) / 2]] },
  ], { approxRooms: true });
}

/** One L-shaped room (no doors); seeds in both legs. */
export function lRoom({ legW = m(2.5), conv = 'filled' } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(7);
  const y1 = y0 + m(6);
  const xe = x0 + legW; // inner corner x
  const ye = y1 - legW; // inner corner y
  // outer boundary of the L: top/left full, then the notch
  wall(prims, 'x', y0 - T_OUT, x0 - T_OUT, xe + T_OUT, T_OUT, [], conv); // top of the vertical leg
  wall(prims, 'y', x0 - T_OUT, y0, y1, T_OUT, [], conv); // left
  wall(prims, 'x', y1, x0 - T_OUT, x1 + T_OUT, T_OUT, [], conv); // bottom
  wall(prims, 'y', x1, ye - T_OUT, y1, T_OUT, [], conv); // right end of the horizontal leg
  wall(prims, 'y', xe, y0 - T_OUT, ye, T_OUT, [], conv); // inner vertical
  wall(prims, 'x', ye - T_OUT, xe, x1 + T_OUT, T_OUT, [], conv); // inner horizontal
  return layout(`l-room-${Math.round(legW / M * 10)}`, prims, [
    { name: 'L', rects: [[x0, y0, xe, y1], [xe, ye, x1, y1]], seeds: [[x0 + legW / 2, y0 + m(1)], [x1 - m(1), y1 - legW / 2], [x0 + legW / 2, y1 - legW / 2]] },
  ]);
}

/** A room with an alcove off its right wall, opening ow wide between wall ends, depth d. */
export function alcove({ ow = m(1.2), d = m(0.8), aw = null, t = T_OUT } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(4.5);
  const y1 = y0 + m(4);
  aw = aw ?? ow;
  const oy0 = y0 + m(1.2);
  frame(prims, x0, y0, x1, y1, t, [['right', oy0, oy0 + ow]]);
  // alcove box beyond the right wall, aw tall (>= ow), centred on the opening
  const ay0 = oy0 - (aw - ow) / 2;
  const ay1 = ay0 + aw;
  wall(prims, 'x', ay0 - t, x1, x1 + t + d + t, t);
  wall(prims, 'x', ay1, x1, x1 + t + d + t, t);
  wall(prims, 'y', x1 + t + d, ay0 - t, ay1 + t, t);
  return layout(`alcove-${Math.round(ow / M * 10)}x${Math.round(d / M * 10)}`, prims, [
    { name: 'R', rects: [[x0, y0, x1, y1], [x1, oy0, x1 + t, oy0 + ow], [x1 + t, ay0, x1 + t + d, ay1]], seeds: [[x0 + m(2), y0 + m(2)], [x1 + t + d / 2, (ay0 + ay1) / 2]] },
  ]);
}

/** A corridor: straight, bent (L) or widening; seeds along it. */
export function corridor({ shape = 'straight', wid = m(1.2) } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  if (shape === 'straight') {
    const x1 = x0 + m(9);
    const y1 = y0 + wid;
    frame(prims, x0, y0, x1, y1, T_IN);
    return layout(`corridor-straight-${Math.round(wid / M * 10)}`, prims, [{ name: 'C', rects: [[x0, y0, x1, y1]], seeds: [[x0 + m(1), y0 + wid / 2], [x1 - m(1), y0 + wid / 2]] }]);
  }
  if (shape === 'step') {
    // 1.2 m wide for 5 m, then 2.0 m wide for 4 m (a step on one side)
    const xs = x0 + m(5);
    const x1 = xs + m(4);
    const yw = y0 + m(2);
    wall(prims, 'x', y0 - T_IN, x0 - T_IN, x1 + T_IN, T_IN);
    wall(prims, 'y', x0 - T_IN, y0, y0 + wid, T_IN);
    wall(prims, 'x', y0 + wid, x0 - T_IN, xs + T_IN, T_IN);
    wall(prims, 'y', xs, y0 + wid, yw, T_IN);
    wall(prims, 'x', yw, xs, x1 + T_IN, T_IN);
    wall(prims, 'y', x1, y0, yw, T_IN);
    return layout(`corridor-step`, prims, [{ name: 'C', rects: [[x0, y0, xs + T_IN, y0 + wid], [xs, y0, x1, yw]], seeds: [[x0 + m(1), y0 + wid / 2], [x1 - m(1), y0 + m(1)]] }]);
  }
  // bent: horizontal leg then a vertical leg down at the right end
  const x1 = x0 + m(7);
  const y1 = y0 + m(6);
  wall(prims, 'x', y0 - T_IN, x0 - T_IN, x1 + T_IN, T_IN);
  wall(prims, 'y', x0 - T_IN, y0, y0 + wid, T_IN);
  wall(prims, 'x', y0 + wid, x0 - T_IN, x1 - wid + T_IN, T_IN);
  wall(prims, 'y', x1 - wid, y0 + wid, y1 + T_IN, T_IN);
  wall(prims, 'y', x1, y0, y1 + T_IN, T_IN);
  wall(prims, 'x', y1, x1 - wid, x1, T_IN);
  return layout(`corridor-bent`, prims, [{ name: 'C', rects: [[x0, y0, x1, y0 + wid], [x1 - wid, y0, x1, y1]], seeds: [[x0 + m(1), y0 + wid / 2], [x1 - wid / 2, y1 - m(1)]] }]);
}

/** Open plan: one space with opposing wall stubs leaving a throat; optional island. */
export function openPlan({ throat = m(2.4), island = false } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(9);
  const y1 = y0 + m(5);
  frame(prims, x0, y0, x1, y1, T_OUT);
  const xs = x0 + m(4.5);
  const stub = (y1 - y0 - throat) / 2;
  wall(prims, 'y', xs, y0, y0 + stub, T_IN);
  wall(prims, 'y', xs, y1 - stub, y1, T_IN);
  if (island) {
    const ix = x0 + m(1.5);
    const iy = y0 + m(2);
    prims.push(line(ix, iy, ix + m(2), iy), line(ix + m(2), iy, ix + m(2), iy + m(0.9)), line(ix + m(2), iy + m(0.9), ix, iy + m(0.9)), line(ix, iy + m(0.9), ix, iy));
  }
  return layout(`open-plan-${Math.round(throat / M * 10)}${island ? '-island' : ''}`, prims, [
    { name: 'P', rects: [[x0, y0, x1, y1]], seeds: [[x0 + m(1), y0 + m(1)], [x1 - m(1), y1 - m(1)]] },
  ]);
}

/** A room with an island (closed outline) leaving two walkways of width walk. */
export function islandRoom({ walk = m(0.9) } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(5);
  const y1 = y0 + m(4);
  frame(prims, x0, y0, x1, y1, T_OUT);
  const ix0 = x0 + m(1);
  const ix1 = x1 - m(1);
  const iy0 = y0 + walk;
  const iy1 = y1 - walk;
  for (const [a, b, c, d] of [[ix0, iy0, ix1, iy0], [ix1, iy0, ix1, iy1], [ix1, iy1, ix0, iy1], [ix0, iy1, ix0, iy0]]) prims.push(line(a, b, c, d, 2));
  return layout(`island-${Math.round(walk / M * 10)}`, prims, [
    { name: 'I', rects: [[x0, y0, x1, y1]], seeds: [[x0 + m(0.5), y0 + m(2)], [(x0 + x1) / 2, y0 + walk / 2], [(x0 + x1) / 2, y1 - walk / 2]] },
  ]);
}

/** A room with a grid of filled square columns. */
export function columnGrid({ cols = 3, rows = 2, size = m(0.4) } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(8);
  const y1 = y0 + m(5);
  frame(prims, x0, y0, x1, y1, T_OUT);
  for (let i = 1; i <= cols; i++) for (let j = 1; j <= rows; j++) {
    const cx = x0 + ((x1 - x0) * i) / (cols + 1);
    const cy = y0 + ((y1 - y0) * j) / (rows + 1);
    prims.push(rect(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2));
  }
  return layout(`column-grid-${cols}x${rows}`, prims, [
    { name: 'G', rects: [[x0, y0, x1, y1]], seeds: [[x0 + m(0.5), y0 + m(0.5)], [x1 - m(0.5), y1 - m(0.5)]] },
  ]);
}

/** Long cabinetry and strokes along walls, plus an arc-shaped chair (an arc with a stroke at its centre, no wall). */
export function cabinetRoom({ chair = true, run = m(3.6) } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(5);
  const y1 = y0 + m(4);
  frame(prims, x0, y0, x1, y1, T_OUT);
  // base cabinets: 0.6 m deep run along the top wall, outline drawn heavy
  prims.push(line(x0 + m(0.3), y0 + m(0.6), x0 + m(0.3) + run, y0 + m(0.6), 2));
  prims.push(line(x0 + m(0.3), y0, x0 + m(0.3), y0 + m(0.6), 2));
  prims.push(line(x0 + m(0.3) + run, y0, x0 + m(0.3) + run, y0 + m(0.6), 2));
  // a free-standing long stroke (a bench edge) mid-room
  prims.push(line(x0 + m(0.8), y0 + m(2.2), x1 - m(0.8), y0 + m(2.2), 2));
  if (chair) {
    const cx = x0 + m(2.5);
    const cy = y0 + m(3.2);
    prims.push(arc(cx, cy, m(0.45), Math.PI, 1.5 * Math.PI, 1));
    prims.push(line(cx - m(0.1), cy, cx + m(0.1), cy, 2));
  }
  return layout(`cabinet-${Math.round(run / M * 10)}${chair ? '-chair' : ''}`, prims, [
    { name: 'K', rects: [[x0, y0, x1, y1]], seeds: [[x0 + m(0.5), y1 - m(0.5)], [x1 - m(0.5), y0 + m(1.5)]] },
  ]);
}

/** A small bathroom with fixtures, door-cued to a bedroom. */
export function bathRoom({ L = m(0.8) } = {}) {
  const lay = twoRooms({ wA: m(4), wB: m(2.2), hgt: m(3), openings: [[m(0.4), m(0.4) + L]], doors: [{ hinge: 'a', side: 1 }], name: 'fixture-dense-bath' });
  const B = lay.rooms[1].rects[0];
  const [bx0, by0, bx1, by1] = B;
  const p = lay.prims;
  // bath tub along the far wall: outline + inner rounded outline
  p.push(line(bx1 - m(0.75), by0, bx1 - m(0.75), by0 + m(1.7), 1), line(bx1 - m(0.75), by0 + m(1.7), bx1, by0 + m(1.7), 1));
  p.push(arc(bx1 - m(0.37), by0 + m(1.3), m(0.25), 0, Math.PI, 1));
  // toilet: cistern box against the bottom wall, bowl ellipse-ish ring
  p.push(line(bx0 + m(0.9), by1 - m(0.2), bx0 + m(1.4), by1 - m(0.2), 1), line(bx0 + m(0.9), by1, bx0 + m(0.9), by1 - m(0.2), 1), line(bx0 + m(1.4), by1, bx0 + m(1.4), by1 - m(0.2), 1));
  p.push(ring(bx0 + m(1.15), by1 - m(0.45), m(0.2), 1));
  // basin on the bottom-left
  p.push(ring(bx0 + m(0.35), by1 - m(0.35), m(0.18), 1));
  lay.rooms[1].seeds = [[bx0 + m(0.5), by0 + m(1.4)]];
  return lay;
}

/** Hatching against a wall, glyphs and a dashed shelf line inside one room. */
export function hatchRoom() {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(5);
  const y1 = y0 + m(4);
  frame(prims, x0, y0, x1, y1, T_OUT);
  // diagonal hatch in a 0.3 m band along the left wall
  for (let y = y0; y < y1 - m(0.3); y += m(0.12)) prims.push(line(x0, y + m(0.3), x0 + m(0.3), y, 1));
  // glyph rings (text) along the middle
  for (let k = 0; k < 6; k++) prims.push(ring(x0 + m(1.5) + k * m(0.12), y0 + m(2), m(0.04), 1));
  // dashed shelving 0.4 m off the right wall: dashes of 0.3 m, gaps of 0.15 m
  for (let y = y0 + m(0.2); y < y1 - m(0.3); y += m(0.45)) prims.push(line(x1 - m(0.4), y, x1 - m(0.4), y + m(0.3), 2));
  return layout('hatch-glyph-shelf', prims, [{ name: 'H', rects: [[x0, y0, x1, y1]], seeds: [[x0 + m(2.5), y0 + m(1)], [x1 - m(1), y1 - m(0.5)]] }]);
}

/** A room with a window band in its exterior wall (three parallel lines across the opening). */
export function windowRoom({ ww = m(1.8) } = {}) {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(5);
  const y1 = y0 + m(4);
  const wx0 = x0 + m(1.5);
  frame(prims, x0, y0, x1, y1, T_OUT, [['top', wx0, wx0 + ww]]);
  for (const f of [0, 0.5, 1]) prims.push(line(wx0, y0 - T_OUT + f * (T_OUT - 1), wx0 + ww, y0 - T_OUT + f * (T_OUT - 1), 1));
  return layout(`window-${Math.round(ww / M * 10)}`, prims, [{ name: 'W', rects: [[x0, y0, x1, y1]] }]);
}

/** Two rooms each door-cued onto a corridor below them. */
export function roomCirculation() {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const wA = m(3.5);
  const wB = m(3.5);
  const hR = m(3.5);
  const hC = m(1.4);
  const xw = x0 + wA;
  const x1 = xw + T_IN + wB;
  const yw = y0 + hR;
  const y1 = yw + T_IN + hC;
  frame(prims, x0, y0, x1, y1, T_OUT);
  wall(prims, 'y', xw, y0, yw, T_IN);
  const dA = [x0 + m(1.2), x0 + m(2.1)];
  const dB = [xw + T_IN + m(1.2), xw + T_IN + m(2.1)];
  wall(prims, 'x', yw, x0, x1, T_IN, [dA, dB]);
  door(prims, 'x', yw, T_IN, dA[0], dA[1], { hinge: 'a', side: -1 });
  door(prims, 'x', yw, T_IN, dB[0], dB[1], { hinge: 'b', side: -1 });
  return layout('room-circulation', prims, [
    { name: 'A', rects: [[x0, y0, xw, yw]] },
    { name: 'B', rects: [[xw + T_IN, y0, x1, yw]] },
    { name: 'C', rects: [[x0, yw + T_IN, x1, y1]], seeds: [[x0 + m(0.6), yw + T_IN + hC / 2]] },
  ]);
}

/** A comb-shaped room: teeth separated by 1..3 px slits, and a notch. */
export function combRoom() {
  const prims = [];
  const x0 = O;
  const y0 = O;
  const x1 = x0 + m(5);
  const y1 = y0 + m(3);
  frame(prims, x0, y0, x1, y1, T_OUT);
  for (let k = 0; k < 8; k++) {
    const x = x0 + m(0.5) + k * m(0.5);
    prims.push(rect(x, y0, x + m(0.5) - 1 - (k % 3), y0 + m(1))); // teeth: ink blocks separated by 1..3 u slits
  }
  return layout('trace-comb-pinch', prims, [{ name: 'C', rects: [[x0, y0 + m(1), x1, y1]], seeds: [[x0 + m(2.5), y1 - m(0.8)]] }], { approxRooms: true });
}

/** A single room larger than 40% of a tight page; pad grows the margin. */
export function largeRoom({ pad = 40 } = {}) {
  const prims = [];
  const x0 = pad;
  const y0 = pad;
  const x1 = x0 + m(8);
  const y1 = y0 + m(6);
  frame(prims, x0, y0, x1, y1, T_IN);
  const lay = layout('large-room', prims, [{ name: 'X', rects: [[x0, y0, x1, y1]] }]);
  lay.W = Math.ceil(x1 + T_IN + pad);
  lay.H = Math.ceil(y1 + T_IN + pad);
  return lay;
}

// ---------------------------------------------------------------------------
// rendering

/** Transpose a layout (swap x and y): the horizontal-wall twin of every case. */
export function transpose(lay) {
  const sw = (p) => {
    switch (p.t) {
      case 'rect': return { ...p, x0: p.y0, y0: p.x0, x1: p.y1, y1: p.x1 };
      case 'line': return { ...p, x0: p.y0, y0: p.x0, x1: p.y1, y1: p.x1 };
      case 'arc': return { ...p, cx: p.cy, cy: p.cx, a0: Math.PI / 2 - p.a1, a1: Math.PI / 2 - p.a0 };
      case 'ring': return { ...p, cx: p.cy, cy: p.cx };
    }
  };
  return {
    ...lay,
    name: `${lay.name}/T`,
    prims: lay.prims.map(sw),
    rooms: lay.rooms.map((r) => ({ ...r, rects: r.rects.map(([a, b, c, d]) => [b, a, d, c]) })),
    seeds: lay.seeds.map((s) => ({ ...s, x: s.y, y: s.x })),
    W: lay.H,
    H: lay.W,
  };
}

/** Translate a layout by (dx, dy) u and grow the page by pad on the far sides. */
export function shift(lay, dx, dy, pad = 0) {
  const mv = (p) => {
    switch (p.t) {
      case 'rect':
      case 'line': return { ...p, x0: p.x0 + dx, y0: p.y0 + dy, x1: p.x1 + dx, y1: p.y1 + dy };
      default: return { ...p, cx: p.cx + dx, cy: p.cy + dy };
    }
  };
  return {
    ...lay,
    name: `${lay.name}/+${dx},${dy}`,
    prims: lay.prims.map(mv),
    rooms: lay.rooms.map((r) => ({ ...r, rects: r.rects.map(([a, b, c, d]) => [a + dx, b + dy, c + dx, d + dy]) })),
    seeds: lay.seeds.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy })),
    W: lay.W + dx + pad,
    H: lay.H + dy + pad,
  };
}

/**
 * Rasterise at k px per u: RasterPage (RGBA, toPdf/toRaster at 3k px/pt),
 * room truth in px (rects) and seeds in PDF pt. ink: luminance of the ink
 * (0 black; a grey wall pen at 120 still reads as ink at threshold 150).
 */
export function render(lay, k = 1, { ink = 0 } = {}) {
  const W = Math.ceil(lay.W * k);
  const H = Math.ceil(lay.H * k);
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.min(data[i], ink);
  };
  const brush = (x, y, wpx) => {
    const r0 = Math.floor((wpx - 1) / 2);
    const r1 = wpx - 1 - r0;
    const cx = Math.round(x);
    const cy = Math.round(y);
    for (let dy = -r0; dy <= r1; dy++) for (let dx = -r0; dx <= r1; dx++) put(cx + dx, cy + dy);
  };
  for (const p of lay.prims) {
    if (p.t === 'rect') {
      const x0 = Math.round(p.x0 * k);
      const x1 = Math.round(p.x1 * k);
      const y0 = Math.round(p.y0 * k);
      const y1 = Math.round(p.y1 * k);
      for (let y = y0; y < Math.max(y1, y0 + 1); y++) for (let x = x0; x < Math.max(x1, x0 + 1); x++) put(x, y);
    } else if (p.t === 'line') {
      const wpx = Math.max(1, Math.round(p.w * k));
      const n = Math.ceil(Math.hypot(p.x1 - p.x0, p.y1 - p.y0) * k * 2) + 1;
      for (let s = 0; s <= n; s++) brush((p.x0 + ((p.x1 - p.x0) * s) / n) * k, (p.y0 + ((p.y1 - p.y0) * s) / n) * k, wpx);
    } else if (p.t === 'arc' || p.t === 'ring') {
      const wpx = Math.max(1, Math.round(p.w * k));
      const a0 = p.t === 'ring' ? 0 : p.a0;
      const a1 = p.t === 'ring' ? 2 * Math.PI : p.a1;
      const n = Math.ceil((a1 - a0) * p.r * k * 2) + 8;
      for (let s = 0; s <= n; s++) {
        const a = a0 + ((a1 - a0) * s) / n;
        brush((p.cx + p.r * Math.cos(a)) * k, (p.cy + p.r * Math.sin(a)) * k, wpx);
      }
    }
  }
  const s = 3 * k; // px per pt
  const raster = {
    width: W,
    height: H,
    data,
    toPdf: (x, y) => ({ x: x / s, y: (H - y) / s }),
    toRaster: (x, y) => ({ x: x * s, y: H - y * s }),
  };
  const rooms = lay.rooms.map((r) => ({ name: r.name, rects: r.rects.map(([a, b, c, d]) => [Math.round(a * k), Math.round(b * k), Math.round(c * k), Math.round(d * k)]) }));
  const seeds = lay.seeds.map((sd) => ({ room: sd.room, px: [Math.round(sd.x * k), Math.round(sd.y * k)], pt: raster.toPdf(Math.round(sd.x * k), Math.round(sd.y * k)) }));
  return { raster, rooms, seeds, k };
}

/** The same layout as a vector PDF (pdf-lib), 1 u = 1/3 pt; for the production render path. */
export async function pdfBytes(lay) {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const Wpt = lay.W / 3;
  const Hpt = lay.H / 3;
  const page = doc.addPage([Wpt, Hpt]);
  const P = (x, y) => ({ x: x / 3, y: Hpt - y / 3 });
  const BLACK = rgb(0, 0, 0);
  for (const p of lay.prims) {
    if (p.t === 'rect') {
      page.drawRectangle({ x: p.x0 / 3, y: Hpt - p.y1 / 3, width: (p.x1 - p.x0) / 3, height: (p.y1 - p.y0) / 3, color: BLACK });
    } else if (p.t === 'line') {
      page.drawLine({ start: P(p.x0, p.y0), end: P(p.x1, p.y1), thickness: p.w / 3, color: BLACK });
    } else {
      const a0 = p.t === 'ring' ? 0 : p.a0;
      const a1 = p.t === 'ring' ? 2 * Math.PI : p.a1;
      const n = Math.max(8, Math.ceil((a1 - a0) * p.r / 4));
      for (let s = 0; s < n; s++) {
        const u0 = a0 + ((a1 - a0) * s) / n;
        const u1 = a0 + ((a1 - a0) * (s + 1)) / n;
        page.drawLine({ start: P(p.cx + p.r * Math.cos(u0), p.cy + p.r * Math.sin(u0)), end: P(p.cx + p.r * Math.cos(u1), p.cy + p.r * Math.sin(u1)), thickness: p.w / 3, color: BLACK });
      }
    }
  }
  return doc.save();
}

// ---------------------------------------------------------------------------
// the named matrix

const L09 = m(0.9);
/** Door-supported positive layouts (the value gate's positives): every one must split. */
export function positives() {
  const out = [];
  // single swing doors: width, hinge side, swing side, wall convention
  const widths = [m(0.8), L09, m(1.0)];
  const variants = [
    { hinge: 'a', side: -1 }, { hinge: 'b', side: -1 }, { hinge: 'a', side: 1 }, { hinge: 'b', side: 1 },
  ];
  for (const [i, L] of widths.entries()) {
    for (const [j, d] of variants.entries()) {
      if ((i + j) % 2) continue; // a balanced half of the grid: 6 cases
      out.push(twoRooms({ openings: [[m(1), m(1) + L]], doors: [d], name: `two-door-${Math.round(L / M * 100)}-${d.hinge}${d.side > 0 ? '+' : '-'}` }));
    }
  }
  out.push(twoRooms({ t: m(0.2), openings: [[m(1), m(1) + L09]], doors: [{ hinge: 'b', side: 1 }], name: 'two-door-thickwall' }));
  out.push(twoRooms({ t: 2, conv: 'thin', openings: [[m(1), m(1) + L09]], doors: [{ hinge: 'a', side: -1 }], name: 'two-door-thinline' }));
  out.push(twoRooms({ t: m(0.15), conv: 'outline', outerConv: 'outline', openings: [[m(1), m(1) + L09]], doors: [{ hinge: 'a', side: 1 }], name: 'two-door-outline' }));
  out.push(doorWithMark());
  out.push(twoRooms({ openings: [[m(0.5), m(0.5) + L09], [m(2.6), m(2.6) + L09]], doors: [{ hinge: 'a', side: -1 }, { hinge: 'b', side: 1 }], name: 'two-door-cycle' }));
  out.push(threeRoomCycle());
  for (const L of [m(1.2), m(1.5), m(1.8), m(2.4)]) out.push(twoRooms({ hgt: m(4.5), openings: [[m(1), m(1) + L]], doors: [{ double: true, side: -1 }], name: `double-door-${Math.round(L / M * 10)}` }));
  // pantry: a 1.2 x 1.0 m room off a kitchen, 0.7 m door, short flanks
  out.push(twoRooms({ wA: m(4), wB: m(1.2), hgt: m(1.0), openings: [[m(0.15), m(0.85)]], doors: [{ hinge: 'a', side: -1 }], name: 'short-flank-pantry' }));
  out.push(bathRoom());
  out.push(roomCirculation());
  // transposed twins of a few (doors in horizontal walls)
  out.push(transpose(out[0]), transpose(out[9]), transpose(out[11]));
  return out;
}

/**
 * Two rooms and a door whose swing chord is stopped short: a small mark
 * (a door stop, a tick) on the door line near the far jamb. The engine's
 * chord ends on the first ink past 85 % of the radius, so it ends on the
 * mark and the fill leaks past it into the next room: Dynamic Fill alone
 * returns the merged pair, and only the partition pass separates them.
 */
export function doorWithMark() {
  const L = L09;
  const lay = twoRooms({ openings: [[m(1), m(1) + L]], doors: [{ hinge: 'a', side: -1 }], name: 'door-mark-on-line' });
  const xw = O + m(4.5); // the partition wall's room-A face (the swing face)
  const y = O + m(1) + Math.round(0.9 * L);
  lay.prims.push(rect(xw - 1, y, xw + 2, y + 3));
  return lay;
}

/**
 * Door conventions v1 does not support, kept as their own slice so the
 * conservative policy's cost stays visible: the pass must abstain (no split,
 * no wrong split), and each one is a recall miss.
 */
export function unsupported() {
  return [
    // a leaf opened 60 degrees is about as long as its arc and joins it into
    // one curvy piece the swing fit cannot separate: no cue
    twoRooms({ openings: [[m(1), m(1) + L09]], doors: [{ hinge: 'a', side: -1, open: 60 }], name: 'two-door-open60' }),
    // doors in diagonal walls: no rotated portal frame in v1
    rotatedDoor({ deg: 30 }),
    rotatedDoor({ deg: 45 }),
  ];
}

/** Named non-split layouts (the value gate's negatives): none may be split by the pass. */
export function negatives() {
  const out = [];
  for (const legW of [m(1.2), m(2.0), m(3.0)]) out.push(lRoom({ legW }));
  { const t = lRoom({ legW: m(2), conv: 'thin' }); t.name += '-thin'; out.push(t); }
  for (const ow of [m(0.7), m(1.2), m(2.0)]) for (const d of [m(0.4), m(1.0), m(2.0)]) out.push(alcove({ ow, d }));
  out.push(alcove({ ow: m(0.9), d: m(0.6), aw: m(1.6) }));
  for (const wid of [m(1.0), m(1.5)]) out.push(corridor({ shape: 'straight', wid }));
  out.push(corridor({ shape: 'bent' }), corridor({ shape: 'step' }));
  for (const throat of [m(1.2), m(2.4), m(3.2)]) out.push(openPlan({ throat }));
  out.push(openPlan({ throat: m(2.4), island: true }));
  for (const walk of [m(0.8), m(1.2)]) out.push(islandRoom({ walk }));
  out.push(columnGrid(), columnGrid({ cols: 4, rows: 3, size: m(0.3) }));
  out.push(cabinetRoom(), cabinetRoom({ run: m(4.4) }), cabinetRoom({ chair: false }));
  out.push(hatchRoom());
  out.push(windowRoom(), windowRoom({ ww: m(2.6) }));
  out.push(combRoom());
  // cased openings and bare gaps between two rooms: wall-supported, no door
  // cue — the pass must abstain (the information limit, section 1)
  for (const ow of [m(0.9), m(1.3), m(2.0)]) out.push(twoRooms({ openings: [[m(1), m(1) + ow]], doors: [], name: `uncued-${Math.round(ow / M * 10)}` }));
  out.push(twoRooms({ openings: [[m(1), m(1) + m(1.3)]], doors: [], t: m(0.2), name: 'cased-identical-pair' }));
  // transposed twins of every L, alcove and corridor (horizontal openings)
  const n = out.length;
  for (let i = 0; i < n; i++) if (/^(l-room|alcove|corridor|open-plan|uncued)/.test(out[i].name)) out.push(transpose(out[i]));
  return out;
}
