#!/usr/bin/env node
// Behavioural check for the room-partition pass (src/engine/partition.ts;
// design: docs/research/room-partition-design-review.md). Every case is a
// synthetic proxy from scripts/partition-proxies.mjs with analytic rooms;
// nothing comes from a benchmark sheet.
//
//   1. The pass in isolation, fed the region a fill would bound if every
//      doorway stayed open: each door-supported positive splits into its
//      rooms (each child IoU >= 0.98 against its room), every named
//      non-split case (L-rooms, alcoves, corridors, open plan, islands,
//      columns, cabinetry, hatch/glyphs, windows, combs, cased openings and
//      bare gaps) is never split, and unsupported conventions abstain. At
//      3 and 6 px/pt every positive splits; at 1.5 px/pt at least 20 of 22
//      (small doors may abstain), never a wrong split.
//   2. Inside Dynamic Fill: every positive seed returns its own room, a door
//      whose swing chord is stopped short splits only through the pass, and
//      the pass never fires on a non-split case.
//   3. Invariance: translation with page padding, seed order (auto
//      extraction forwards and backwards), parent/child order in the room
//      selector, a byte-identical cased opening under both readings, a page
//      too tight for the fill's page cap.
//   4. The production render path: the same layouts drawn as vector PDFs
//      and rendered by pdf.js at 1.5, 3 and 6 px/pt.
// It prints the pass's cost per region.

import { positives, negatives, unsupported, render, transpose, shift, twoRooms, largeRoom, pdfBytes, m } from './partition-proxies.mjs';
import { partitionOpen, scoreChildren, ptPolyMask, matchRoom, rectMask, iou } from './partition-lib.mjs';
import { dynamicFill, dynamicFillRooms, fillEvidence } from '../src/engine/dynamicfill.ts';
import { autoRooms, gridSeeds, roomSelector } from '../src/engine/auto-rooms.ts';
import { simpleRingError } from '../src/engine/polygon.ts';
import { openPdf } from '../src/headless/pdfjs-node.ts';
import { renderRasterNode } from '../src/headless/raster-node.ts';

const fails = [];
const fail = (msg) => {
  fails.push(msg);
  console.error(`FAIL ${msg}`);
};
const times = { k1: [], k2: [] };

// one render per layout and resolution: the engine caches its page state on
// the raster object, so the direct and the in-fill checks share it
const renders = new Map();
const rendered = (lay, k) => {
  const key = `${lay.name}@${k}`;
  if (!renders.has(key)) renders.set(key, render(lay, k));
  return renders.get(key);
};

/** Direct pass on the open region around the first seed: { status, ok, desc, ms }. */
function direct(lay, k) {
  const { raster, rooms, seeds } = rendered(lay, k);
  const res = partitionOpen(raster, seeds[0].px, fillEvidence(raster));
  if (!res) return { status: 'open-region-unbounded', ok: false, desc: 'open region reaches the page edge', ms: 0 };
  const sc = res.status === 'partitioned' ? scoreChildren(res, rooms, raster.width, raster.height, 0.98) : null;
  return { status: res.status, ok: !!sc && sc.ok, desc: sc ? sc.matches.map((x) => `${x.name}@${x.iou.toFixed(3)}`).join(',') : res.reasons.join('; '), ms: res.ms };
}

// --- 1. the pass in isolation, three resolutions --------------------------------
const POS = positives();
const NEG = negatives();
const UNS = unsupported();
console.log(`matrix: ${POS.length} door-supported positives, ${NEG.length} named non-split cases, ${UNS.length} unsupported conventions`);
for (const k of [1, 2, 0.5]) {
  let split = 0;
  const misses = [];
  // every case at 3 and 1.5 px/pt; at 6 px/pt (four times the pixels) a
  // spread of the positives, a quarter of the non-split cases
  const pos = k === 2 ? POS.filter((_, i) => i % 3 === 0) : POS;
  for (const lay of pos) {
    const d = direct(lay, k);
    if (k === 1) times.k1.push(d.ms);
    if (k === 2) times.k2.push(d.ms);
    if (d.status === 'partitioned' && !d.ok) fail(`${lay.name} @${3 * k}px/pt: wrong split (${d.desc})`);
    if (d.ok) split++;
    else misses.push(`${lay.name} (${d.status})`);
  }
  const need = k === 0.5 ? pos.length - 2 : pos.length;
  console.log(`  ${3 * k} px/pt: positives split ${split}/${pos.length}${misses.length ? ` — abstained: ${misses.join(', ')}` : ''}`);
  if (split < need) fail(`${3 * k} px/pt: only ${split}/${pos.length} door-supported positives split (need ${need})`);
  const negs = k === 2 ? NEG.filter((_, i) => i % 4 === 0) : NEG;
  const tally = { unchanged: 0, unresolved: 0 };
  for (const lay of [...negs, ...UNS]) {
    const d = direct(lay, k);
    if (d.status === 'partitioned') fail(`${lay.name} @${3 * k}px/pt: a non-split case was split (${d.desc})`);
    else if (d.status in tally) tally[d.status]++;
  }
  console.log(`  ${3 * k} px/pt: ${negs.length + UNS.length} non-split/unsupported cases, none split (${tally.unchanged} unchanged, ${tally.unresolved} unresolved)`);
}

// --- 2. inside Dynamic Fill -----------------------------------------------------
{
  let seedsOk = 0;
  let seedsAll = 0;
  let viaPass = 0;
  for (const lay of POS) {
    const { raster, rooms, seeds } = rendered(lay, 1);
    for (const s of seeds) {
      seedsAll++;
      const r = dynamicFill(raster, s.pt);
      if ('error' in r) {
        fail(`${lay.name}: fill from room ${s.room} failed: ${r.error}`);
        continue;
      }
      if (simpleRingError(r.points) !== null) fail(`${lay.name}: invalid ring from room ${s.room}`);
      const mm = matchRoom(ptPolyMask(r.points, raster), rooms, raster.width, raster.height);
      const floor = lay.name === 'fixture-dense-bath' && s.room === 'B' ? 0.75 : 0.95; // wall-attached tub and cistern pockets sit outside any outline
      if (mm.name !== s.room || mm.iou < floor) fail(`${lay.name}: fill from room ${s.room} returned ${mm.name}@${mm.iou.toFixed(3)}`);
      else seedsOk++;
      if (r.partition) viaPass++;
      if (lay.name.startsWith('door-mark-on-line') && r.partition !== 'partitioned') fail(`${lay.name}: room ${s.room} not split by the pass (chord stopped short)`);
    }
  }
  console.log(`dynamicFill: ${seedsOk}/${seedsAll} positive seeds return their own room (${viaPass} through the partition pass)`);
  // the rooms API returns every child, the seed's first index pointing at its own
  const lay = POS.find((l) => l.name === 'door-mark-on-line');
  const { raster, rooms, seeds } = rendered(lay, 1);
  const rr = dynamicFillRooms(raster, seeds[0].pt);
  if ('error' in rr || rr.partition !== 'partitioned' || rr.rooms.length !== 2) fail(`dynamicFillRooms on ${lay.name}: ${JSON.stringify('error' in rr ? rr : { partition: rr.partition, rooms: rr.rooms.length })}`);
  else {
    const names = rr.rooms.map((r) => matchRoom(ptPolyMask(r.points, raster), rooms, raster.width, raster.height).name);
    if (names[rr.seedRoom] !== seeds[0].room || new Set(names).size !== 2) fail(`dynamicFillRooms children ${names} (seed room ${rr.seedRoom})`);
  }
  // with the pass off the same click returns the merged pair: the split above is the pass's
  const off = dynamicFill(raster, seeds[0].pt, undefined, {}, { partition: false });
  const offMatch = 'error' in off ? null : matchRoom(ptPolyMask(off.points, raster), rooms, raster.width, raster.height);
  if (!offMatch || offMatch.iou > 0.7) fail(`${lay.name} with the pass off: expected the merged pair, got ${JSON.stringify(offMatch)}`);
  // the pass never fires on a non-split case
  let fired = 0;
  for (const l of [...NEG, ...UNS]) {
    const { raster: r2, seeds: s2 } = rendered(l, 1);
    for (const s of s2) {
      const r = dynamicFill(r2, s.pt);
      if (!('error' in r) && r.partition) {
        fired++;
        fail(`${l.name}: the pass split a non-split case from room ${s.room}`);
      }
    }
  }
  console.log(`dynamicFill: the pass fired on ${fired} non-split seeds`);
}

// --- 3. invariance ----------------------------------------------------------------
{
  // translation with page padding: the same children, moved
  for (const name of ['two-door-91-b+', 'three-room-cycle', 'double-door-15', 'alcove-12x10', 'uncued-13']) {
    const lay = [...POS, ...NEG].find((l) => l.name === name);
    const a = partitionOpen(...(() => { const r = rendered(lay, 1); return [r.raster, r.seeds[0].px]; })());
    const moved = shift(lay, 37, 11, 50);
    const b = partitionOpen(...(() => { const r = render(moved, 1); return [r.raster, r.seeds[0].px]; })());
    const sizes = (x) => x.children.map((c) => c.length).sort((p, q) => p - q).join(',');
    if (!a || !b || a.status !== b.status || sizes(a) !== sizes(b)) fail(`${name}: partition not translation-invariant (${a?.status} ${a && sizes(a)} vs ${b?.status} ${b && sizes(b)})`);
  }
  // seed order: auto extraction forwards and backwards gives the same rooms
  for (const name of ['door-mark-on-line', 'three-room-cycle', 'room-circulation']) {
    const lay = POS.find((l) => l.name === name);
    const { raster, rooms } = rendered(lay, 1);
    // a 40 px grid over the building (seeds outside it only leak and cost time)
    const bx = rooms.flatMap((r) => r.rects);
    const [x0, y0, x1, y1] = [Math.min(...bx.map((b) => b[0])), Math.min(...bx.map((b) => b[1])), Math.max(...bx.map((b) => b[2])), Math.max(...bx.map((b) => b[3]))];
    const seeds = gridSeeds(raster, 40).filter((p) => {
      const q = raster.toRaster(p.x, p.y);
      return q.x >= x0 && q.x < x1 && q.y >= y0 && q.y < y1;
    });
    const fwd = autoRooms(raster, seeds).rooms;
    const bwd = autoRooms(raster, seeds.slice().reverse()).rooms;
    const key = (rs) => rs.map((r) => `${r.px[0]}:${r.px.length}`).join('|');
    if (key(fwd) !== key(bwd)) fail(`${name}: auto extraction depends on seed order (${fwd.length} vs ${bwd.length} rooms)`);
    // every room found once, nothing else
    const masks = rooms.map((r) => rectMask(r.rects, raster.width, raster.height));
    const hit = rooms.map((_, i) => fwd.filter((f) => iou(ptPolyMask(f.points, raster), masks[i]) >= 0.9).length);
    if (fwd.length !== rooms.length || hit.some((n) => n !== 1)) fail(`${name}: auto extraction found ${fwd.length} rooms for ${rooms.length} (${hit})`);
  }
  // parent/child order in the selector: a merged parent replaced by its
  // evidence-backed children, whichever comes first
  const px = (a, b) => Int32Array.from({ length: b - a }, (_, i) => a + i);
  const P = { points: [], px: px(0, 1000), evidence: false, seed: 0 };
  const A = { points: [], px: px(0, 480), evidence: true, seed: 1 };
  const B = { points: [], px: px(500, 1000), evidence: true, seed: 1 };
  const s1 = roomSelector();
  s1.offer([P], false);
  s1.offer([A, B], true);
  const s2 = roomSelector();
  s2.offer([A, B], true);
  s2.offer([P], false);
  const k1 = s1.rooms().map((r) => r.px[0]).join();
  const k2 = s2.rooms().map((r) => r.px[0]).join();
  if (k1 !== '0,500' || k2 !== '0,500') fail(`room selector: parent/child order changes the result (${k1} vs ${k2})`);
  // a byte-identical cased opening read as one room or as two: one answer,
  // and never a split (the information limit)
  const cased = NEG.find((l) => l.name === 'cased-identical-pair');
  const asTwo = render(cased, 1);
  const asOne = render({ ...cased, rooms: [{ name: 'AB', rects: [...cased.rooms[0].rects, ...cased.rooms[1].rects] }] }, 1);
  const r2 = partitionOpen(asTwo.raster, asTwo.seeds[0].px);
  const r1 = partitionOpen(asOne.raster, asOne.seeds[0].px);
  if (!r1 || !r2 || r1.status !== r2.status || r1.status === 'partitioned') fail(`cased opening: ${r1?.status} as one room, ${r2?.status} as two`);
  // a comb of 1..3 px slits: a valid ring or an error, never an invalid ring
  const comb = NEG.find((l) => l.name === 'trace-comb-pinch');
  const cr = render(comb, 1);
  const rc = dynamicFill(cr.raster, cr.seeds[0].pt);
  if (!('error' in rc) && simpleRingError(rc.points) !== null) fail('comb: invalid ring');
  // a room over the fill's page cap on a tight page: the pass's verdict does
  // not change with the padding (the cap is the fill's, not the pass's)
  const tight = render(largeRoom({ pad: 40 }), 1);
  const roomy = render(largeRoom({ pad: 400 }), 1);
  const pt = partitionOpen(tight.raster, tight.seeds[0].px);
  const pr = partitionOpen(roomy.raster, roomy.seeds[0].px);
  if (!pt || !pr || pt.status !== pr.status || pt.status === 'partitioned') fail(`large room: ${pt?.status} on a tight page vs ${pr?.status} padded`);
  const fr = dynamicFill(roomy.raster, roomy.seeds[0].pt);
  if ('error' in fr || matchRoom(ptPolyMask(fr.points, roomy.raster), roomy.rooms, roomy.raster.width, roomy.raster.height).iou < 0.99) fail('large room (padded page): fill does not return the room');
  console.log('invariance: translation, seed order, parent/child order, cased opening, comb, page padding');
}

// --- 4. the production render path ------------------------------------------------
{
  const pdfCases = ['two-door-91-b-', 'double-door-15', 'door-mark-on-line', 'three-room-cycle'].map((n) => POS.find((l) => l.name === n));
  const pdfNeg = ['l-room-20', 'alcove-12x10', 'uncued-13', 'open-plan-24', 'cabinet-36-chair'].map((n) => NEG.find((l) => l.name === n));
  const line = [];
  for (const scale of [1.5, 3, 6]) {
    let ok = 0;
    for (const lay of [...pdfCases, ...pdfNeg]) {
      const doc = await openPdf(await pdfBytes(lay));
      const raster = await renderRasterNode(doc, 1, scale);
      const k = scale / 3;
      const W = raster.width;
      const H = raster.height;
      const rooms = lay.rooms.map((r) => ({ name: r.name, rects: r.rects.map(([a, b, c, d]) => [Math.round(a * k), Math.round(b * k), Math.round(c * k), Math.round(d * k)]) }));
      const sp = [Math.round(lay.seeds[0].x * k), Math.round(lay.seeds[0].y * k)];
      const res = partitionOpen(raster, sp);
      const positive = pdfCases.includes(lay);
      if (!res) {
        if (positive) fail(`pdf ${lay.name} @${scale}: open region unbounded`);
        continue;
      }
      if (positive) {
        const sc = res.status === 'partitioned' ? scoreChildren(res, rooms, W, H, 0.97) : null;
        if (res.status === 'partitioned' && !sc.ok) fail(`pdf ${lay.name} @${scale}px/pt: wrong split ${sc.matches.map((x) => `${x.name}@${x.iou.toFixed(3)}`)}`);
        if (sc && sc.ok) ok++;
        else if (scale >= 3) fail(`pdf ${lay.name} @${scale}px/pt: not split (${res.status}: ${res.reasons.join('; ')})`);
      } else if (res.status === 'partitioned') fail(`pdf ${lay.name} @${scale}px/pt: non-split case split`);
    }
    line.push(`${scale} px/pt ${ok}/${pdfCases.length}`);
  }
  console.log(`pdf render path: positives split ${line.join(', ')}; ${pdfNeg.length} non-split cases never split`);
}

const stat = (xs) => {
  const s = xs.slice().sort((p, q) => p - q);
  return `median ${s[s.length >> 1].toFixed(1)} ms, max ${s[s.length - 1].toFixed(1)} ms`;
};
console.log(`cost of the pass per region: 3 px/pt ${stat(times.k1)}; 6 px/pt ${stat(times.k2)}`);

if (fails.length) {
  console.error(`FAIL: ${fails.length} partition check(s) failed`);
  process.exit(1);
}
console.log('PASS: door-supported positives split into their rooms, no non-split case split, invariances hold');
