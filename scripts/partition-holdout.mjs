#!/usr/bin/env node
// Seeded random floor plans for the room-partition pass: the design's frozen
// synthetic holdout (docs/research/room-partition-design-review.md, section
// 3 last paragraph and section 6, holdout gate). Each sheet is a grid of 2 to
// 9 rooms; every shared wall gets a junction drawn from a fixed mix:
//
//   door      single swing door (leaf + quarter arc), 0.7-1.0 m      supported
//   double    double swing door, 1.2-1.8 m                            supported
//   door60    single door drawn opened 60 degrees                      unsupported (v1 has no cue for it)
//   uncued    bare door-width gap, no symbol                           hard negative: never cut
//   cased     wider cased opening, no symbol                           hard negative: never cut
//   merged    no wall: the two cells are one room (L-rooms, open plan)
//   wall      solid
//
// independently of wall convention (filled bands, hollow outline walls,
// single thin lines), wall thickness, ink grey, resolution (1.5/3/6 px/pt),
// speckle noise and furniture (glyph text, base cabinets, hatch bands,
// islands, columns, an arc-shaped chair). Nothing comes from a benchmark.
//
// Two splits with seeds reserved before development: `dev` (seeds 7000+i,
// free to look at) and `holdout` (seeds 20261024+i, run once after the pass
// is frozen). Scoring, per group of rooms joined by open junctions:
//   - split decisions: every strip the pass cuts is matched to the junction
//     it lies in; a cut in an uncued/cased opening or outside any junction is
//     a wrong split (precision);
//   - recall: supported doors inside a joined group that the pass cut;
//   - children: each child against the ideal partition (the group cut at its
//     supported doors only), IoU >= 0.95;
//   - end to end: Dynamic Fill from every room seed with the pass on and off,
//     own-room rate (IoU >= 0.9) on rooms whose openings are all supported.
//
//   node --experimental-strip-types scripts/partition-holdout.mjs --split dev --count 40 [--json out.json]

import { writeFileSync } from 'node:fs';
import { rngHelpers } from './bench/draw.mjs';
import { rect, line, arc, ring, wall, door, frame, layout, PAD, T_OUT, m, render } from './partition-proxies.mjs';
import { partitionOpen, ptPolyMask, rectMask, iou, listMask } from './partition-lib.mjs';
import { dynamicFill, fillEvidence } from '../src/engine/dynamicfill.ts';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const SPLIT = arg('split', 'dev');
const COUNT = Number(arg('count', 40));
const FROM = Number(arg('from', 0));
const JSON_OUT = arg('json', null);
const BASE = { dev: 7000, holdout: 20261024 }[SPLIT];
if (BASE === undefined) {
  console.error('--split dev|holdout');
  process.exit(2);
}

const KINDS = [
  ['door', 0.4],
  ['double', 0.08],
  ['door60', 0.04],
  ['uncued', 0.1],
  ['cased', 0.1],
  ['merged', 0.08],
  ['wall', 0.2],
];

/** One random sheet: layout, junctions, rooms (cells united by merged junctions), resolution and noise. */
export function sheet(seed) {
  const R = rngHelpers(seed);
  const { rand, randInt, pick, rng } = R;
  const weighted = (table) => {
    let u = rng() * table.reduce((s, [, p]) => s + p, 0);
    for (const [v, p] of table) if ((u -= p) <= 0) return v;
    return table[table.length - 1][0];
  };
  let rows = randInt(1, 3);
  let cols = randInt(2, 3);
  const conv = weighted([['filled', 0.7], ['outline', 0.15], ['thin', 0.15]]);
  const t = conv === 'thin' ? 2 : m(pick(conv === 'outline' ? [0.12, 0.15, 0.2] : [0.1, 0.12, 0.15, 0.2]));
  const tOut = conv === 'thin' ? 3 : T_OUT;
  const widths = Array.from({ length: cols }, () => m(rand(2.4, 5.0)));
  const heights = Array.from({ length: rows }, () => m(rand(2.4, 4.5)));
  const O = PAD;
  const xs = [O];
  for (let c = 1; c < cols; c++) xs.push(xs[c - 1] + widths[c - 1] + t);
  const ys = [O];
  for (let r = 1; r < rows; r++) ys.push(ys[r - 1] + heights[r - 1] + t);
  const X1 = xs[cols - 1] + widths[cols - 1];
  const Y1 = ys[rows - 1] + heights[rows - 1];
  const prims = [];
  frame(prims, O, O, X1, Y1, tOut, [], conv === 'outline' ? 'outline' : 'filled');
  const cell = (r, c) => r * cols + c;
  const cellRect = (r, c) => [xs[c], ys[r], xs[c] + widths[c], ys[r] + heights[r]];
  const junctions = [];
  const sideOpen = new Set(); // `${cell}:${side}` with an opening (no cabinets/hatch there)
  const flank = m(0.15);
  const addJunction = (axis, c0, segA, segB, a, b) => {
    let kind = weighted(KINDS);
    const span = segB - segA;
    let L;
    if (kind === 'merged') L = span;
    else if (kind === 'wall') L = 0;
    else {
      const range = { door: [0.7, 1.0], door60: [0.7, 1.0], double: [1.2, 1.8], uncued: [0.8, 1.2], cased: [1.2, 2.2] }[kind];
      L = m(rand(range[0], range[1]));
      if (L > span - 2 * flank) {
        kind = 'wall';
        L = 0;
      }
    }
    const o0 = kind === 'merged' ? segA : kind === 'wall' ? 0 : Math.round(rand(segA + flank, segB - flank - L));
    const j = { kind, axis, c0, t, o0, o1: o0 + L, a, b };
    if (kind === 'door' || kind === 'door60' || kind === 'double') {
      j.opts = { hinge: pick(['a', 'b']), side: pick([-1, 1]), open: kind === 'door60' ? 60 : 90, double: kind === 'double' };
    }
    junctions.push(j);
    if (kind !== 'wall') {
      sideOpen.add(`${a}:${axis === 'y' ? 'right' : 'bottom'}`);
      sideOpen.add(`${b}:${axis === 'y' ? 'left' : 'top'}`);
    }
    return kind === 'wall' ? null : [o0, o0 + L];
  };
  // vertical interior walls, full height, an opening per row
  for (let c = 0; c + 1 < cols; c++) {
    const xw = xs[c] + widths[c];
    const openings = [];
    for (let r = 0; r < rows; r++) {
      const o = addJunction('y', xw, ys[r], ys[r] + heights[r], cell(r, c), cell(r, c + 1));
      if (o) openings.push(o);
    }
    wall(prims, 'y', xw, O, Y1, t, openings, conv === 'outline' ? 'outline' : 'filled');
  }
  // horizontal interior walls, full width, an opening per column
  for (let r = 0; r + 1 < rows; r++) {
    const yw = ys[r] + heights[r];
    const openings = [];
    for (let c = 0; c < cols; c++) {
      const o = addJunction('x', yw, xs[c], xs[c] + widths[c], cell(r, c), cell(r + 1, c));
      if (o) openings.push(o);
    }
    wall(prims, 'x', yw, O, X1, t, openings, conv === 'outline' ? 'outline' : 'filled');
  }
  for (const j of junctions) if (j.opts) door(prims, j.axis, j.c0, j.t, j.o0, j.o1, j.opts);
  // furniture and clutter, per cell, kept off the walls that have openings
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [x0, y0, x1, y1] = cellRect(r, c);
      const w = x1 - x0;
      const h = y1 - y0;
      const id = cell(r, c);
      if (rng() < 0.25) for (let g = 0; g < randInt(4, 8); g++) prims.push(ring(x0 + 0.35 * w + g * m(0.12), y0 + 0.45 * h, m(0.04)));
      if (rng() < 0.15 && !sideOpen.has(`${id}:top`) && w > m(1.5)) {
        const run = Math.min(w - m(0.6), m(rand(1.2, 3.6)));
        prims.push(line(x0 + m(0.3), y0 + m(0.6), x0 + m(0.3) + run, y0 + m(0.6), 2), line(x0 + m(0.3), y0, x0 + m(0.3), y0 + m(0.6), 2), line(x0 + m(0.3) + run, y0, x0 + m(0.3) + run, y0 + m(0.6), 2));
      }
      if (rng() < 0.1 && !sideOpen.has(`${id}:left`)) for (let y = y0; y < y1 - m(0.3); y += m(0.12)) prims.push(line(x0, y + m(0.3), x0 + m(0.3), y, 1));
      if (rng() < 0.1 && w >= m(3) && h >= m(3)) {
        const [ix0, iy0, ix1, iy1] = [x0 + 0.45 * w, y0 + 0.2 * h, x0 + 0.85 * w, y0 + 0.5 * h];
        prims.push(line(ix0, iy0, ix1, iy0, 2), line(ix1, iy0, ix1, iy1, 2), line(ix1, iy1, ix0, iy1, 2), line(ix0, iy1, ix0, iy0, 2));
      }
      if (rng() < 0.08) for (const fx of [0.6, 0.8]) prims.push(rect(x0 + fx * w - m(0.15), y0 + 0.35 * h - m(0.15), x0 + fx * w + m(0.15), y0 + 0.35 * h + m(0.15)));
      if (rng() < 0.08) {
        const cx = x0 + 0.65 * w;
        const cy = y0 + 0.7 * h;
        prims.push(arc(cx, cy, m(0.45), Math.PI, 1.5 * Math.PI, 1), line(cx - m(0.1), cy, cx + m(0.1), cy, 2));
      }
    }
  }
  // rooms: cells united through merged junctions; the removed wall segment belongs to the room
  const parent = Array.from({ length: rows * cols }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const j of junctions) if (j.kind === 'merged') parent[find(j.a)] = find(j.b);
  const roomOf = new Map();
  const rooms = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const root = find(cell(r, c));
      if (!roomOf.has(root)) {
        roomOf.set(root, rooms.length);
        const [x0, y0, x1, y1] = cellRect(r, c);
        rooms.push({ name: `R${rooms.length}`, rects: [], cells: [], seeds: [[x0 + 0.25 * (x1 - x0), y0 + 0.75 * (y1 - y0)]] });
      }
      const room = rooms[roomOf.get(root)];
      room.rects.push(cellRect(r, c));
      room.cells.push(cell(r, c));
    }
  }
  for (const j of junctions) {
    if (j.kind !== 'merged') continue;
    rooms[roomOf.get(find(j.a))].rects.push(j.axis === 'y' ? [j.c0, j.o0, j.c0 + t, j.o1] : [j.o0, j.c0, j.o1, j.c0 + t]);
  }
  const roomIdx = (cellId) => roomOf.get(find(cellId));
  const lay = layout(`${SPLIT}-${seed}`, prims, rooms.map((r) => ({ name: r.name, rects: r.rects, seeds: r.seeds })));
  return {
    lay,
    junctions: junctions.filter((j) => j.kind !== 'merged' && j.kind !== 'wall').map((j) => ({ ...j, ra: roomIdx(j.a), rb: roomIdx(j.b) })),
    rooms,
    conv,
    t,
    ink: randInt(0, 110),
    k: weighted([[1, 0.6], [0.5, 0.2], [2, 0.2]]),
    speckle: rng() < 0.15,
    noiseSeed: randInt(1, 1e9),
  };
}

const SUPPORTED = new Set(['door', 'double']);

/**
 * Components (masks) of a region with the given doors' wall-band rectangles
 * removed; components under 1% of the region (slivers at the cut) are
 * dropped.
 */
function idealComponents(reg, doors, W, H, S) {
  const { region, box, count } = reg;
  const cut = new Uint8Array(W * H);
  for (const j of doors) {
    const [x0, y0, x1, y1] = j.axis === 'y' ? [S(j.c0), S(j.o0), S(j.c0 + j.t), S(j.o1)] : [S(j.o0), S(j.c0), S(j.o1), S(j.c0 + j.t)];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cut[y * W + x] = 1;
  }
  const label = new Int32Array(W * H);
  const comps = [];
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const s = y * W + x;
      if (!region[s] || cut[s] || label[s]) continue;
      const id = comps.length + 1;
      const px = [s];
      label[s] = id;
      for (let q = 0; q < px.length; q++) {
        const i = px[q];
        for (const j of [i - 1, i + 1, i - W, i + W]) {
          if (region[j] && !cut[j] && !label[j]) {
            label[j] = id;
            px.push(j);
          }
        }
      }
      if (px.length >= 0.01 * count) {
        const mk = new Uint8Array(W * H);
        for (const i of px) mk[i] = 1;
        comps.push(mk);
      }
    }
  }
  return comps;
}

function evaluate(sh) {
  const { lay, junctions, rooms, k } = sh;
  const { raster, rooms: truth, seeds } = render(lay, k, { ink: sh.ink });
  const W = raster.width;
  const H = raster.height;
  if (sh.speckle) {
    const R = rngHelpers(sh.noiseSeed);
    const n = Math.round(W * H * 0.0002);
    for (let i = 0; i < n; i++) {
      const p = (Math.floor(R.rng() * H) * W + Math.floor(R.rng() * W)) * 4;
      raster.data[p] = raster.data[p + 1] = raster.data[p + 2] = R.randInt(0, 90);
    }
  }
  const ev = fillEvidence(raster);
  const out = { name: lay.name, k, conv: sh.conv, cuts: 0, cutsOk: 0, cutsWrong: 0, cutsUnsupported: 0, supported: 0, supportedCut: 0, groups: 0, groupsIdealSplit: 0, groupsOk: 0, groupsCoarser: 0, groupsWrong: 0, hardNegGroups: 0, hardNegSplit: 0, wellPosed: 0, ownOn: 0, ownOff: 0, passFired: 0, unresolved: 0, wrong: [] };
  // nudge a seed off ink
  const seedPx = (room) => {
    const [sx, sy] = seeds.find((s) => s.room === room.name).px;
    for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = sx + dx;
      const y = sy + dy;
      const p = (y * W + x) * 4;
      if (raster.data[p] > 200) return [x, y];
    }
    return [sx, sy];
  };
  const S = (v) => Math.round(v * k);
  // groups of rooms joined by open junctions
  const parent = rooms.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const j of junctions) parent[find(j.ra)] = find(j.rb);
  const groups = new Map();
  rooms.forEach((_, i) => {
    const g = find(i);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });
  const masks = truth.map((r) => rectMask(r.rects, W, H));
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    out.groups++;
    const inGroup = junctions.filter((j) => members.includes(j.ra));
    const res = partitionOpen(raster, seedPx(rooms[members[0]]), ev);
    if (!res) continue;
    if (res.status === 'unresolved') out.unresolved++;
    // ideal partition: the region cut at exactly its supported doors (the
    // true wall-band rectangle of each), labelled. Connectivity comes from
    // the drawing itself: a door60's arc is never erased, so its symbol
    // seals that doorway with real ink, as the fill sees it
    const comps = idealComponents(res.region, inGroup.filter((j) => SUPPORTED.has(j.kind)), W, H, S);
    const idealSplit = comps.length >= 2;
    if (idealSplit) out.groupsIdealSplit++;
    else out.hardNegGroups++;
    // match every cut strip to the junction it lies in
    const cutJ = new Set();
    for (const p of res.portals) {
      if (p.verdict !== 'cut') continue;
      out.cuts++;
      const axis = p.axis === 'row' ? 'x' : 'y';
      const hit = inGroup.find((j) => j.axis === axis && Math.min(p.b, S(j.o1) + 3) - Math.max(p.a, S(j.o0) - 3) >= 0.5 * (p.b - p.a) && p.p0 >= S(j.c0) - 3 && p.p1 <= S(j.c0 + j.t) + 3);
      if (hit && SUPPORTED.has(hit.kind)) {
        out.cutsOk++;
        cutJ.add(hit);
      } else if (hit && hit.kind === 'door60') out.cutsUnsupported++;
      else {
        out.cutsWrong++;
        out.wrong.push(`${lay.name}: cut in ${hit ? hit.kind : 'no junction'} at ${p.axis} ${p.a}-${p.b} band ${p.p0}-${p.p1}`);
      }
    }
    // recall over the supported doors whose cut is needed: the rooms either
    // side end in different ideal components (a door beside an uncued
    // opening between the same rooms is rightly left as redundant)
    const compOf = (room) => {
      const [x, y] = seedPx(rooms[room]);
      return comps.findIndex((c) => c[y * W + x]);
    };
    for (const j of inGroup) if (SUPPORTED.has(j.kind)) {
      const ca = compOf(j.ra);
      const cb = compOf(j.rb);
      if (ca < 0 || cb < 0 || ca === cb) continue;
      out.supported++;
      if (cutJ.has(j)) out.supportedCut++;
    }
    if (res.status === 'partitioned') {
      if (!idealSplit) out.hardNegSplit++;
      // children against the ideal components: exact (one child per
      // component, IoU >= 0.95), coarser (every component lies, 95% or more,
      // inside one child: a missed door, not a wrong cut) or wrong
      const cms = res.children.map((ch) => listMask(ch, W, H));
      let exact = cms.length === comps.length;
      const used = new Set();
      for (const cm of cms) {
        let best = -1;
        let bv = 0;
        comps.forEach((c, ci) => {
          const v = iou(cm, c);
          if (v > bv) {
            bv = v;
            best = ci;
          }
        });
        if (bv < 0.95 || used.has(best)) exact = false;
        used.add(best);
      }
      const nested = comps.every((c) => {
        let n = 0;
        for (let q = 0; q < c.length; q++) n += c[q];
        return cms.some((cm) => {
          let inside = 0;
          for (let q = 0; q < c.length; q++) if (c[q] && cm[q]) inside++;
          return inside >= 0.95 * n;
        });
      });
      if (exact) out.groupsOk++;
      else if (nested) out.groupsCoarser++;
      else {
        out.groupsWrong++;
        out.wrong.push(`${lay.name}: a child cuts through an ideal component (${res.children.length} children vs ${comps.length})`);
      }
    }
  }
  // end to end: Dynamic Fill from every room, pass on and off
  rooms.forEach((room, i) => {
    const js = junctions.filter((j) => j.ra === i || j.rb === i);
    if (!js.every((j) => SUPPORTED.has(j.kind))) return;
    out.wellPosed++;
    const [x, y] = seedPx(room);
    const pt = raster.toPdf(x, y);
    for (const on of [true, false]) {
      const r = dynamicFill(raster, pt, undefined, {}, { partition: on });
      if ('error' in r) continue;
      if (on && r.partition) out.passFired++;
      if (iou(ptPolyMask(r.points, raster), masks[i]) >= 0.9) on ? out.ownOn++ : out.ownOff++;
    }
  });
  return out;
}

const totals = {};
const lines = [];
const t0 = performance.now();
for (let i = FROM; i < FROM + COUNT; i++) {
  const sh = sheet(BASE + i);
  const r = evaluate(sh);
  for (const [key, v] of Object.entries(r)) if (typeof v === 'number' && key !== 'k') totals[key] = (totals[key] ?? 0) + v;
  totals.wrongList = [...(totals.wrongList ?? []), ...r.wrong];
  lines.push(r);
  console.log(`${r.name} @${3 * r.k}px/pt ${r.conv}: cuts ${r.cutsOk}/${r.cuts} ok${r.cutsWrong ? ` WRONG ${r.cutsWrong}` : ''}, supported doors cut ${r.supportedCut}/${r.supported}, groups ok ${r.groupsOk}/${r.groupsIdealSplit}${r.groupsWrong ? ` WRONG ${r.groupsWrong}` : ''}, own room ${r.ownOn}/${r.wellPosed} on vs ${r.ownOff} off`);
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : 'n/a');
const summary = {
  split: SPLIT,
  sheets: COUNT,
  seeds: [BASE + FROM, BASE + FROM + COUNT - 1],
  splitDecisions: { cuts: totals.cuts, correct: totals.cutsOk, wrong: totals.cutsWrong, unsupportedDoor: totals.cutsUnsupported, precision: totals.cuts ? totals.cutsOk / totals.cuts : null },
  recallSupportedDoors: { doors: totals.supported, cut: totals.supportedCut, recall: totals.supported ? totals.supportedCut / totals.supported : null },
  groups: { joined: totals.groups, idealSplit: totals.groupsIdealSplit, childrenExact: totals.groupsOk, childrenCoarser: totals.groupsCoarser ?? 0, childrenWrong: totals.groupsWrong, hardNegative: totals.hardNegGroups, hardNegativeSplit: totals.hardNegSplit, unresolved: totals.unresolved },
  endToEnd: { wellPosedRooms: totals.wellPosed, ownRoomPassOn: totals.ownOn, ownRoomPassOff: totals.ownOff, passFired: totals.passFired },
  wrong: totals.wrongList,
  seconds: Math.round((performance.now() - t0) / 1000),
};
console.log(`\n${SPLIT}: ${COUNT} sheets in ${summary.seconds} s`);
console.log(`split decisions: ${totals.cutsOk}/${totals.cuts} correct (precision ${pct(totals.cutsOk, totals.cuts)}%), ${totals.cutsWrong} wrong`);
console.log(`supported doors in joined groups cut: ${totals.supportedCut}/${totals.supported} (recall ${pct(totals.supportedCut, totals.supported)}%)`);
console.log(`groups: ${totals.groupsOk}/${totals.groupsIdealSplit} split into the ideal children, ${totals.groupsCoarser ?? 0} coarser (a door missed), ${totals.groupsWrong} wrong; hard-negative groups ${totals.hardNegGroups}, split ${totals.hardNegSplit}; unresolved ${totals.unresolved}`);
console.log(`end to end: own room ${totals.ownOn}/${totals.wellPosed} with the pass vs ${totals.ownOff}/${totals.wellPosed} without (pass fired ${totals.passFired})`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, sheets: lines.map(({ wrong, ...r }) => r) }, null, 2) + '\n');
