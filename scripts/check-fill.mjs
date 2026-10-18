#!/usr/bin/env node
// Behavioural check for the gap-closing Dynamic Fill. Builds a 300x200
// raster: a room with a 25px door gap in its left wall, plus a fully sealed
// room as the control case, then asserts: the gapped room bounds through the
// gap with area within 12% of ideal, the sealed room is unchanged, and an
// unbounded region still errors. A second 600x400 raster covers what the
// first can't see: an L-shaped room (the trace must follow concave corners,
// not cut across them) and a door in a horizontal wall (row-wise closing).
// A third covers the wall-end gate: a bench line near a wall must not be
// closed onto it, and doors in thick filled walls still bridge. A fourth
// covers label-driven splits, and a fifth bare doorways that never leak:
// two rooms joined by a door-width gap split without labels or a scale, a
// niche stays part of its room, and an opening wider than a door only
// closes once a scale says it is still door-sized.

import { dynamicFill } from '../src/engine/dynamicfill.ts';

const W = 300;
const H = 200;
const px = new Uint8ClampedArray(W * H * 4).fill(255);
const ink = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = px[i + 1] = px[i + 2] = 0;
};
// room A walls (left room): x 20..150, y 20..180, door gap on left wall y 90..114
for (let x = 20; x <= 150; x++) { ink(x, 20); ink(x, 180); }
for (let y = 20; y <= 180; y++) {
  if (y < 90 || y > 114) ink(20, y); // left wall with gap
  ink(150, y);
}
// room B walls (right): x 170..280, y 20..180, sealed
for (let x = 170; x <= 280; x++) { ink(x, 20); ink(x, 180); }
for (let y = 20; y <= 180; y++) { ink(170, y); ink(280, y); }

const raster = {
  width: W,
  height: H,
  data: px,
  toPdf: (x, y) => ({ x, y: H - y }),
  toRaster: (x, y) => ({ x, y: H - y }),
};

const area = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

// 1. room A through the door gap: true inner area = 129 x 159 = 20511
let r = dynamicFill(raster, { x: 85, y: 100 });
if ('error' in r) { console.error('FAIL room A (gap):', r.error); process.exit(1); }
const aA = area(r.points);
console.log(`room A (gapped): ${r.points.length} pts, area ${aA.toFixed(0)} (ideal ~20511)`);

// 2. room B sealed: true inner area = 109 x 159 = 17331
r = dynamicFill(raster, { x: 225, y: 100 });
if ('error' in r) { console.error('FAIL room B (sealed):', r.error); process.exit(1); }
const aB = area(r.points);
console.log(`room B (sealed): ${r.points.length} pts, area ${aB.toFixed(0)} (ideal ~17331)`);

// 2b. a sealed room reports no closed gap, even with a scale that puts the
// doorway rung on the ladder
r = dynamicFill(raster, { x: 225, y: 100 }, undefined, { metersPerPt: 0.0254 / 72 * 100 });
if ('error' in r || r.gapPx !== undefined || r.bridged) { console.error('FAIL sealed room reports a gap:', JSON.stringify(r)); process.exit(1); }
console.log('sealed room: no gap reported');
// and the gapped room reports the gap it closed (25px door)
r = dynamicFill(raster, { x: 85, y: 100 });
if ('error' in r || !(r.gapPx >= 24 && r.gapPx <= 32)) { console.error('FAIL gapped room gap report:', JSON.stringify('error' in r ? r : r.gapPx)); process.exit(1); }
console.log(`gapped room: reports a ${r.gapPx}px gap closed`);

// 3. unbounded: erase room B so the open area exceeds the page fraction cap
for (let y = 0; y < H; y++) for (let x = 165; x < W; x++) {
  const i = (y * W + x) * 4;
  px[i] = px[i + 1] = px[i + 2] = 255;
}
r = dynamicFill(raster, { x: 200, y: 100 });
if (!('error' in r)) { console.error('FAIL unbounded case returned a polygon'); process.exit(1); }
console.log('unbounded: error as expected →', r.error);

const tol = 0.12; // the polygon runs through boundary-pixel centres; 12% headroom
if (Math.abs(aA - 20511) / 20511 > tol) { console.error(`FAIL room A area off: ${aA}`); process.exit(1); }
if (Math.abs(aB - 17331) / 17331 > tol) { console.error(`FAIL room B area off: ${aB}`); process.exit(1); }

// --- second sheet: concave room + door in a horizontal wall -----------------
const W2 = 600;
const H2 = 400;
const px2 = new Uint8ClampedArray(W2 * H2 * 4).fill(255);
const ink2 = (x, y) => {
  const i = (y * W2 + x) * 4;
  px2[i] = px2[i + 1] = px2[i + 2] = 0;
};
const seg = (x0, y0, x1, y1) => {
  if (y0 === y1) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) ink2(x, y0);
  else for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) ink2(x0, y);
};
// sealed L: 20..220 x 20..220 minus the top-right 120..220 x 20..120
seg(20, 20, 120, 20); seg(120, 20, 120, 120); seg(120, 120, 220, 120);
seg(220, 120, 220, 220); seg(220, 220, 20, 220); seg(20, 220, 20, 20);
// room C: 300..560 x 40..260 with a 30px door in its bottom wall (x 400..429)
seg(300, 40, 560, 40); seg(300, 40, 300, 260); seg(560, 40, 560, 260);
seg(300, 260, 399, 260); seg(430, 260, 560, 260);
const raster2 = { width: W2, height: H2, data: px2, toPdf: (x, y) => ({ x, y: H2 - y }), toRaster: (x, y) => ({ x, y: H2 - y }) };

// 4. L room: true inner area = 199*199 - 100*100 = 29601
r = dynamicFill(raster2, { x: 60, y: H2 - 180 });
if ('error' in r) { console.error('FAIL L room:', r.error); process.exit(1); }
const aL = area(r.points);
console.log(`L room (concave): ${r.points.length} pts, area ${aL.toFixed(0)} (ideal ~29601)`);
if (Math.abs(aL - 29601) / 29601 > 0.03) { console.error(`FAIL L room area off: ${aL}`); process.exit(1); }

// 5. room C through the door in its bottom wall: true inner area = 259 x 219 = 56721
r = dynamicFill(raster2, { x: 430, y: H2 - 150 });
if ('error' in r) { console.error('FAIL room C (horizontal-wall door):', r.error); process.exit(1); }
const aC = area(r.points);
console.log(`room C (door in horizontal wall): ${r.points.length} pts, area ${aC.toFixed(0)} (ideal ~56721)`);
if (Math.abs(aC - 56721) / 56721 > 0.03) { console.error(`FAIL room C area off: ${aC}`); process.exit(1); }


// --- third sheet: furniture lines near walls, thick walls -------------------
const W3 = 900;
const H3 = 500;
const px3 = new Uint8ClampedArray(W3 * H3 * 4).fill(255);
const ink3 = (x, y) => {
  const i = (y * W3 + x) * 4;
  px3[i] = px3[i + 1] = px3[i + 2] = 0;
};
const box3 = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink3(x, y); };
// room D: thin walls 20..320 x 20..320, 50px door in the left wall (y 120..169),
// a bench line 40px below the top wall from x 70 to 270 (its ends 49px from
// the side walls, inside the closing reach)
box3(20, 20, 320, 20); box3(20, 320, 320, 320); box3(320, 20, 320, 320);
box3(20, 20, 20, 119); box3(20, 170, 20, 320);
box3(70, 60, 270, 60);
// room E: 8px filled walls, outer 400..880 x 20..420 (inner 408..872 x 28..412),
// 40px door in the bottom wall (x 600..639)
box3(400, 20, 880, 27); box3(400, 20, 407, 420); box3(873, 20, 880, 420);
box3(400, 413, 599, 420); box3(640, 413, 880, 420);
const raster3 = { width: W3, height: H3, data: px3, toPdf: (x, y) => ({ x, y: H3 - y }), toRaster: (x, y) => ({ x, y: H3 - y }) };

// 6. room D: the strip behind the bench is floor too; true inner area = 299 x 299 = 89401
r = dynamicFill(raster3, { x: 170, y: H3 - 200 });
if ('error' in r) { console.error('FAIL room D (bench):', r.error); process.exit(1); }
const aD = area(r.points);
console.log(`room D (bench line near a wall): ${r.points.length} pts, area ${aD.toFixed(0)} (ideal ~89401)`);
if (Math.abs(aD - 89401) / 89401 > 0.03) { console.error(`FAIL room D area off (bench strip closed?): ${aD}`); process.exit(1); }

// 7. room E through a door in a thick wall: true inner area = 465 x 385 = 179025
r = dynamicFill(raster3, { x: 640, y: H3 - 200 });
if ('error' in r) { console.error('FAIL room E (thick walls):', r.error); process.exit(1); }
const aE = area(r.points);
console.log(`room E (door in 8px walls): ${r.points.length} pts, area ${aE.toFixed(0)} (ideal ~179025)`);
if (Math.abs(aE - 179025) / 179025 > 0.03) { console.error(`FAIL room E area off: ${aE}`); process.exit(1); }


// --- fourth sheet: label-driven splits must cut off a room, not an alcove ----
const W4 = 700;
const H4 = 400;
const px4 = new Uint8ClampedArray(W4 * H4 * 4).fill(255);
const box4 = (x0, y0, x1, y1) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W4 + x) * 4;
    px4[i] = px4[i + 1] = px4[i + 2] = 0;
  }
};
// room F: 20..320 x 20..320 with a 40 x 60 px wardrobe alcove off its right
// wall (x 320..360, y 120..180), open to the room through a 60px gap between
// wall ends; a note sits in the alcove, the room name in the room
box4(20, 20, 320, 20); box4(20, 320, 320, 320); box4(20, 20, 20, 320);
box4(320, 20, 320, 120); box4(320, 180, 320, 320);
box4(320, 120, 360, 120); box4(320, 180, 360, 180); box4(360, 120, 360, 180);
// rooms G and H: 400..680 x 20..320 split by a wall at x 540 with a 40px door between wall ends
box4(400, 20, 680, 20); box4(400, 320, 680, 320); box4(400, 20, 400, 320); box4(680, 20, 680, 320);
box4(540, 20, 540, 150); box4(540, 191, 540, 320);
const raster4 = { width: W4, height: H4, data: px4, toPdf: (x, y) => ({ x, y: H4 - y }), toRaster: (x, y) => ({ x, y: H4 - y }) };
const at4 = (x, y) => ({ x, y: H4 - y });

// 8. a note in the alcove must not shave the alcove off: room + alcove ≈ 299*299 + 39*59 = 91702
r = dynamicFill(raster4, at4(170, 200), undefined, { labels: [at4(170, 170), at4(340, 150)] });
if ('error' in r) { console.error('FAIL room F (alcove note):', r.error); process.exit(1); }
const aF = area(r.points);
console.log(`room F (note in an alcove): area ${aF.toFixed(0)} (ideal ~91702 with the alcove)`);
if (Math.abs(aF - 91702) / 91702 > 0.03) { console.error(`FAIL room F lost its alcove: ${aF}`); process.exit(1); }

// 9. two labelled rooms joined by a door still split: room G = 139 x 299 = 41561
r = dynamicFill(raster4, at4(470, 200), undefined, { labels: [at4(470, 170), at4(610, 170)] });
if ('error' in r) { console.error('FAIL room G (labelled split):', r.error); process.exit(1); }
const aG = area(r.points);
console.log(`room G (labelled rooms joined by a door): area ${aG.toFixed(0)} (ideal ~41561)`);
if (Math.abs(aG - 41561) / 41561 > 0.03) { console.error(`FAIL room G not split: ${aG}`); process.exit(1); }

// --- ink-edge area: the outline runs along the ink face, not through the
// centres of the last free pixels (which inset every wall by half a pixel
// and undercount a room by half its perimeter). On clean pixel rooms the
// area must be exact to well under 1%.
for (const [label, got, ideal] of [['room A', aA, 20511], ['room B', aB, 17331], ['L room', aL, 29601], ['room E', aE, 179025]]) {
  if (Math.abs(got - ideal) / ideal > 0.005) { console.error(`FAIL ink-edge area ${label}: ${got} vs ${ideal} (${(100 * (got - ideal) / ideal).toFixed(2)}%)`); process.exit(1); }
}
console.log('ink-edge area: sealed, gapped, concave and thick-wall rooms exact to 0.5%');

// --- fifth sheet: bare door gaps that never leak (P13) ------------------------
const W5 = 900;
const H5 = 500;
const px5 = new Uint8ClampedArray(W5 * H5 * 4).fill(255);
const box5 = (x0, y0, x1, y1) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W5 + x) * 4;
    px5[i] = px5[i + 1] = px5[i + 2] = 0;
  }
};
// rooms J and K: 20..420 x 20..320 inside a sealed outline, split by a wall at
// x 220 with a 70px bare doorway between wall ends (y 150..219), no leaf, no
// labels, no scale: the fill never leaks, so only the room-sized cut rule
// can separate them
box5(20, 20, 420, 20); box5(20, 320, 420, 320); box5(20, 20, 20, 320); box5(420, 20, 420, 320);
box5(220, 20, 220, 149); box5(220, 220, 220, 320);
// room L: 500..880 x 20..320 with a 1.2 m2-ish niche (60 x 80 px) off its
// right wall, open through a 60px gap between wall ends: a niche is floor
box5(500, 20, 820, 20); box5(500, 320, 820, 320); box5(500, 20, 500, 320);
box5(820, 20, 820, 130); box5(820, 190, 820, 320);
box5(820, 130, 880, 130); box5(820, 190, 880, 190); box5(880, 130, 880, 190);
// rooms M and N: 20..420 x 350..490, split by a wall at x 220 whose two
// stubs leave a 110px opening between wall ends (y 365..474): wider than any
// unscaled rung, so without a scale the two stay one region; a scale that
// makes the opening 1.2 m cuts it as a wide doorway, one that makes it
// 1.5 m leaves it open
box5(20, 350, 420, 350); box5(20, 490, 420, 490); box5(20, 350, 20, 490); box5(420, 350, 420, 490);
box5(220, 350, 220, 364); box5(220, 475, 220, 490);
const raster5 = { width: W5, height: H5, data: px5, toPdf: (x, y) => ({ x, y: H5 - y }), toRaster: (x, y) => ({ x, y: H5 - y }) };
const at5 = (x, y) => ({ x, y: H5 - y });

// 10. room J alone: 199 x 299 = 59501 (the merged pair would be 399 x 299 = 119301)
r = dynamicFill(raster5, at5(120, 170));
if ('error' in r) { console.error('FAIL room J (bare doorway, no hints):', r.error); process.exit(1); }
const aJ = area(r.points);
console.log(`room J (bare 70px doorway, no leak, no hints): area ${aJ.toFixed(0)} (ideal ~59501), gapPx ${r.gapPx}`);
if (Math.abs(aJ - 59501) / 59501 > 0.01) { console.error(`FAIL room J not cut from K at the doorway: ${aJ}`); process.exit(1); }
if (!(r.gapPx >= 70 && r.gapPx <= 72)) { console.error(`FAIL room J gap report: ${r.gapPx}`); process.exit(1); }

// 11. room L keeps its niche: 319 x 299 + 59 x 59 = 95381 + 3481 = 98862
r = dynamicFill(raster5, at5(660, 170));
if ('error' in r) { console.error('FAIL room L (niche):', r.error); process.exit(1); }
const aLn = area(r.points);
console.log(`room L (niche through a 60px gap): area ${aLn.toFixed(0)} (ideal ~98862 with the niche)`);
if (Math.abs(aLn - 98862) / 98862 > 0.01) { console.error(`FAIL room L lost its niche: ${aLn}`); process.exit(1); }

// 12. a 110px opening is wider than the unscaled ladder closes: rooms M and N
// stay one region (399 x 139 = 55461); at a scale where 110 px is 1.2 m the
// wide-doorway rung cuts them (199 x 139 = 27661); at 1.5 m it does not
r = dynamicFill(raster5, at5(120, 420));
if ('error' in r) { console.error('FAIL room M (wide opening, no scale):', r.error); process.exit(1); }
const aM = area(r.points);
console.log(`room M (110px opening, no scale): area ${aM.toFixed(0)} (ideal ~55461, stays merged)`);
if (Math.abs(aM - 55461) / 55461 > 0.01) { console.error(`FAIL room M unexpectedly cut or leaked: ${aM}`); process.exit(1); }
r = dynamicFill(raster5, at5(120, 420), undefined, { metersPerPt: 1.2 / 110 });
if ('error' in r) { console.error('FAIL room M (wide opening, 1.2 m):', r.error); process.exit(1); }
const aMs = area(r.points);
console.log(`room M (110px opening = 1.2 m): area ${aMs.toFixed(0)} (ideal ~27661, cut at the wide doorway)`);
if (Math.abs(aMs - 27661) / 27661 > 0.01) { console.error(`FAIL room M not cut at the wide doorway: ${aMs}`); process.exit(1); }
r = dynamicFill(raster5, at5(120, 420), undefined, { metersPerPt: 1.5 / 110 });
if ('error' in r) { console.error('FAIL room M (wide opening, 1.5 m):', r.error); process.exit(1); }
const aMw = area(r.points);
console.log(`room M (110px opening = 1.5 m): area ${aMw.toFixed(0)} (ideal ~55461, an opening, not a door)`);
if (Math.abs(aMw - 55461) / 55461 > 0.01) { console.error(`FAIL room M cut at a 1.5 m opening: ${aMw}`); process.exit(1); }

console.log('PASS: gap rooms bound with area within tolerance; sealed, concave, bench, thick-wall and labelled rooms traced; bare doorways cut without a leak; unbounded errors');
