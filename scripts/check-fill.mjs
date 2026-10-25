#!/usr/bin/env node
// Behavioural check for the gap-closing Magic Fill. Builds a 300x200
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
// closes once a scale says it is still door-sized. A sixth covers door
// swing arcs (the fill runs to the door line, not the arc), a seventh text
// in a doorway (masked through FillHints.textBoxes, while a box over a wall
// leaves the wall), and an eighth a front door wider than any interior
// doorway: sealed because it faces the page exterior, while an interior
// opening of the same width is judged on what lies behind it (a room is
// cut off, an alcove is kept).
// (merged from main 2026-10-19) // covers splits: by room labels, and with no hints at all by the doorway
// // widths the sheet itself shows (kept only for room-sized cuts).

import { dynamicFill, sheetDoorWidthPx } from '../src/engine/dynamicfill.ts';
import { simpleRingError } from '../src/engine/polygon.ts';

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

// --- sixth sheet: a door swing arc is not a wall ------------------------------
// Room P: 8px filled walls, outer 20..420 x 20..320 (inner 28..412 x 28..312),
// a 90px door in the bottom wall (x 150..239) drawn as an open-door symbol:
// a 1px leaf from the hinge jamb (150, 312) straight up into the room and a
// 1px quarter arc from the leaf tip round to the far jamb (239, 312). At
// 0.01 m/pt the door is 0.9 m. The fill must run to the door line, not stop
// at the arc: inner area 385 x 285 = 109725 less the ~90 leaf pixels.
const W6 = 800;
const H6 = 600;
const px6 = new Uint8ClampedArray(W6 * H6 * 4).fill(255);
const ink6 = (x, y) => {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W6 || y >= H6) return;
  const i = (y * W6 + x) * 4;
  px6[i] = px6[i + 1] = px6[i + 2] = 0;
};
const box6 = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink6(x, y); };
box6(20, 20, 420, 27); box6(20, 20, 27, 320); box6(413, 20, 420, 320);
box6(20, 313, 149, 320); box6(240, 313, 420, 320);
for (let y = 222; y <= 312; y++) ink6(150, y); // leaf, hinge at (150, 312), tip at (150, 222)
for (let k = 0; k <= 600; k++) { // arc of radius 90 about the hinge, from the tip (up) round to the far jamb (right)
  const a = -Math.PI / 2 + (Math.PI / 2) * (k / 600);
  ink6(150 + 90 * Math.cos(a), 312 + 90 * Math.sin(a));
}
const raster6 = { width: W6, height: H6, data: px6, toPdf: (x, y) => ({ x, y: H6 - y }), toRaster: (x, y) => ({ x, y: H6 - y }) };
const at6 = (x, y) => ({ x, y: H6 - y });

// 13. the swing sector (pi/4 x 90^2 = 6362 px, 5.8% of the room) is floor
r = dynamicFill(raster6, at6(300, 150), undefined, { metersPerPt: 0.01 });
if ('error' in r) { console.error('FAIL room P (door swing arc):', r.error); process.exit(1); }
const aP = area(r.points);
console.log(`room P (open-door symbol, leaf and swing arc): area ${aP.toFixed(0)} (ideal ~109635 to the door line; ~103273 if the arc walls off the swing), swings ${r.swings}`);
if (Math.abs(aP - 109635) / 109635 > 0.01) { console.error(`FAIL room P stopped at the swing arc: ${aP}`); process.exit(1); }
if (!r.swings) { console.error('FAIL room P did not report the swing it erased'); process.exit(1); }
// and the same without a scale: the arc is still door-sized in px
r = dynamicFill(raster6, at6(300, 150));
if ('error' in r || Math.abs(area(r.points) - 109635) / 109635 > 0.01) { console.error(`FAIL room P without a scale: ${'error' in r ? r.error : area(r.points)}`); process.exit(1); }

// --- seventh sheet: text in a doorway is not a wall end --------------------
// Rooms Q and R: 20..420 x 20..320 split by a 1px wall at x 220 with a 70px
// doorway between wall ends (y 150..219), as rooms J and K, but a dimension
// string sits in the doorway: five small glyph-like rings of 1px ink. The
// ink breaks the free run between the wall ends into short runs ending on
// glyph ink, which no rung may close, so the fill merges the rooms unless
// the host's text boxes erase the glyphs first.
const W7 = 800;
const H7 = 500;
const px7 = new Uint8ClampedArray(W7 * H7 * 4).fill(255);
const ink7 = (x, y) => {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W7 || y >= H7) return;
  const i = (y * W7 + x) * 4;
  px7[i] = px7[i + 1] = px7[i + 2] = 0;
};
const box7 = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink7(x, y); };
box7(20, 20, 420, 20); box7(20, 320, 420, 320); box7(20, 20, 20, 320); box7(420, 20, 420, 320);
box7(220, 20, 220, 149); box7(220, 220, 220, 320);
for (let g = 0; g < 5; g++) { // "glyphs": rings of radius 4 down the doorway, on the wall line
  const cy = 160 + g * 12;
  for (let k = 0; k < 40; k++) ink7(220 + 4 * Math.cos((k * Math.PI) / 20), cy + 4 * Math.sin((k * Math.PI) / 20));
}
const raster7 = { width: W7, height: H7, data: px7, toPdf: (x, y) => ({ x, y: H7 - y }), toRaster: (x, y) => ({ x, y: H7 - y }) };
const at7 = (x, y) => ({ x, y: H7 - y });

// 14. without the text box the glyph ink stops every rung: Q and R merge
// (399 x 299 = 119301 less the glyph ink); with it, Q alone (199 x 299 = 59501)
r = dynamicFill(raster7, at7(120, 170));
if ('error' in r) { console.error('FAIL room Q (glyphs in the doorway, no text box):', r.error); process.exit(1); }
const aQ0 = area(r.points);
r = dynamicFill(raster7, at7(120, 170), undefined, { textBoxes: [{ x0: 214, y0: 154, x1: 227, y1: 215 }] });
if ('error' in r) { console.error('FAIL room Q (glyphs in the doorway, text box):', r.error); process.exit(1); }
const aQ = area(r.points);
console.log(`room Q (glyphs in the doorway): area ${aQ0.toFixed(0)} without the text box, ${aQ.toFixed(0)} with it (ideal ~59501 alone, ~119301 merged)`);
if (Math.abs(aQ - 59501) / 59501 > 0.01) { console.error(`FAIL room Q not cut from R once the glyphs were masked: ${aQ}`); process.exit(1); }
if (aQ0 < 100000) { console.error(`FAIL room Q check is not failing-first: the doorway closed without the text box (${aQ0})`); process.exit(1); }
// a text box over a wall must not open it: the wall is straight ink and stays
r = dynamicFill(raster7, at7(120, 170), undefined, { textBoxes: [{ x0: 214, y0: 154, x1: 227, y1: 215 }, { x0: 200, y0: 40, x1: 240, y1: 100 }] });
if ('error' in r || Math.abs(area(r.points) - 59501) / 59501 > 0.01) { console.error(`FAIL text box over a wall opened it: ${'error' in r ? r.error : area(r.points)}`); process.exit(1); }

// --- eighth sheet: a wide front door, judged by where it leads -------------
// Rooms S and T: 20..520 x 20..320 inside a sealed outline, split by a wall
// at x 270 with a 160px opening between wall ends (y 80..239). S has a 160px
// front door in its left wall (y 80..239) to the page exterior and a 190 x
// 60 px alcove off its bottom wall (x 45..234, y 320..380). At 0.01 m/pt the
// openings are 1.6 and 1.9 m: wider than a door, so a fill from S runs off
// the page and no rung up to 1.3 m may cut S from T. The leak rung (2 m)
// closes all three gaps; then only the front door, which faces the
// exterior, stays sealed and the interior openings are judged on their
// own, each at its own width: T is a room and is cut off, the alcove
// (1.1 m2) is floor and stays.
const W8 = 1000;
const H8 = 600;
const px8 = new Uint8ClampedArray(W8 * H8 * 4).fill(255);
const O8 = 120; // margin: runs from the page edge shorter than a rung close, so the outline keeps clear of the edge
const box8 = (x0, y0, x1, y1) => {
  x0 += O8; x1 += O8; y0 += O8; y1 += O8;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W8 + x) * 4;
    px8[i] = px8[i + 1] = px8[i + 2] = 0;
  }
};
box8(20, 20, 520, 20); box8(520, 20, 520, 320); box8(235, 320, 520, 320);
box8(20, 20, 20, 79); box8(20, 240, 20, 320); box8(20, 320, 44, 320);
box8(270, 20, 270, 79); box8(270, 240, 270, 320);
box8(45, 320, 45, 380); box8(45, 380, 235, 380); box8(235, 320, 235, 380);
const raster8 = { width: W8, height: H8, data: px8, toPdf: (x, y) => ({ x, y: H8 - y }), toRaster: (x, y) => ({ x, y: H8 - y }) };
const at8 = (x, y) => ({ x: x + O8, y: H8 - y - O8 });

// 15. S with its alcove: 249 x 299 + 189 x 59 = 74451 + 11151 = 85602 (S and T merged would be 160053)
r = dynamicFill(raster8, at8(150, 170), undefined, { metersPerPt: 0.01 });
if ('error' in r) { console.error('FAIL room S (1.6 m front door):', r.error); process.exit(1); }
const aS = area(r.points);
console.log(`room S (1.6 m front door, 1.6 m opening to T, 1.9 m alcove): area ${aS.toFixed(0)} (ideal ~85602 with the alcove, without T), gapPx ${r.gapPx}`);
if (Math.abs(aS - 85602) / 85602 > 0.01) { console.error(`FAIL room S: ${aS} (T merged in, or the alcove cut off)`); process.exit(1); }
// 16. T alone through the same opening: 249 x 299 = 74451
r = dynamicFill(raster8, at8(400, 170), undefined, { metersPerPt: 0.01 });
if ('error' in r) { console.error('FAIL room T (behind the 1.6 m opening):', r.error); process.exit(1); }
const aT = area(r.points);
console.log(`room T (1.6 m opening to S): area ${aT.toFixed(0)} (ideal ~74451)`);
if (Math.abs(aT - 74451) / 74451 > 0.01) { console.error(`FAIL room T: ${aT}`); process.exit(1); }
// without a scale the 160px gaps are wider than any unscaled rung — but this
// sheet shows TWO of them at the same width, and the merged engine's sheet
// door-width rule (PR #3) takes agreeing wall-end gaps as the sheet's own
// doorway width: the fill bounds at that rule with the same area the scale
// produces, and says it read the width off the sheet
r = dynamicFill(raster8, at8(150, 170));
if ('error' in r) { console.error(`FAIL room S without a scale (sheet door width should bound it): ${r.error}`); process.exit(1); }
const aSnoscale = area(r.points);
if (Math.abs(aSnoscale - aS) / aS > 0.01 || r.doorSource !== 'sheet') { console.error(`FAIL room S without a scale: area ${aSnoscale.toFixed(0)} (want ~${aS.toFixed(0)}), doorSource ${r.doorSource}`); process.exit(1); }

// --- ninth sheet: a curved wall is not a door swing ---------------------------
// Room U: 8px filled walls on three sides, and across the bottom gap a thin
// 1px semicircular partition (radius 100 about (220, 313)) bulging INTO the
// room — a curved wall/apse a thin-line drawing would show. A small curvy
// furniture ring sits 4 px from the arc's centre, so the old hinge gate
// ("any ink near the centre") read the curve as a 1 m door swing: the arc
// was erased and chorded and the bulge silently re-entered the room. A real
// swing pivots on line ink of its own (jamb or leaf), never on a curvy blob
// alone.
const W9 = 800;
const H9 = 600;
const px9 = new Uint8ClampedArray(W9 * H9 * 4).fill(255);
const ink9 = (x, y) => {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W9 || y >= H9) return;
  const i = (y * W9 + x) * 4;
  px9[i] = px9[i + 1] = px9[i + 2] = 0;
};
const box9 = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink9(x, y); };
box9(20, 20, 419, 27); box9(20, 20, 27, 320); box9(412, 20, 419, 320);
box9(20, 313, 119, 320); box9(320, 313, 419, 320);
for (let k = 0; k <= 900; k++) { // the curve: semicircle of radius 100 bulging up from y=313
  const a = Math.PI + Math.PI * (k / 900);
  ink9(220 + 100 * Math.cos(a), 313 + 100 * Math.sin(a));
}
for (let k = 0; k < 64; k++) { // furniture: a 6px ring 4px off the arc centre
  const a = (2 * Math.PI * k) / 64;
  ink9(224 + 3 * Math.cos(a), 309 + 3 * Math.sin(a));
}
const raster9 = { width: W9, height: H9, data: px9, toPdf: (x, y) => ({ x, y: H9 - y }), toRaster: (x, y) => ({ x, y: H9 - y }) };
const at9 = (x, y) => ({ x, y: H9 - y });

// 17. U with its curved partition: 384 x 285 = 109440 less the half-disc
// pi*100^2/2 = 15708 -> 93732 (the arc erased and chorded off as a swing
// would read ~109440, the bulge back in the room)
r = dynamicFill(raster9, at9(220, 150), undefined, { metersPerPt: 0.01 });
if ('error' in r) { console.error('FAIL room U (curved wall):', r.error); process.exit(1); }
const aU = area(r.points);
console.log(`room U (curved wall, curvy furniture by its centre): area ${aU.toFixed(0)} (ideal ~93732 with the curve; ~109440 if the arc were chorded off), swings ${r.swings}`);
if (Math.abs(aU - 93732) / 93732 > 0.01) { console.error(`FAIL room U lost the curve to a phantom swing: ${aU}`); process.exit(1); }
if (r.swings) { console.error(`FAIL room U reported ${r.swings} swing(s) on a curved wall`); process.exit(1); }

// --- merged from main (PR #3): the no-hints doorway rule and slot decoys ---
// 10. no hints at all (a scan before calibration): the sheet shows two
// doorway widths (the 40px door and the 60px alcove opening; the gaps
// between the two boxes face the sheet edge). Tried narrowest first, the
// 40px width cuts a room-sized part off the G+H fill, so room G stands alone
r = dynamicFill(raster4, at4(470, 200));
if ('error' in r) { console.error('FAIL room G (no hints):', r.error); process.exit(1); }
const aG2 = area(r.points);
console.log(`room G (no hints, sheet door width): area ${aG2.toFixed(0)} (ideal ~41561), door rule ${r.doorSource} ${r.doorPx}px`);
if (Math.abs(aG2 - 41561) / 41561 > 0.03) { console.error(`FAIL room G not split without hints: ${aG2}`); process.exit(1); }
if (r.doorSource !== 'sheet') { console.error(`FAIL room G: expected the sheet door width to be reported, got ${JSON.stringify({ doorPx: r.doorPx, doorSource: r.doorSource })}`); process.exit(1); }

// 11. the same sheet, no hints, click in room F: neither doorway width may
// shave the alcove off (closing its opening is not a room-sized cut)
r = dynamicFill(raster4, at4(170, 200));
if ('error' in r) { console.error('FAIL room F (no hints):', r.error); process.exit(1); }
const aF2 = area(r.points);
console.log(`room F (no hints, alcove kept): area ${aF2.toFixed(0)} (ideal ~91702 with the alcove)`);
if (Math.abs(aF2 - 91702) / 91702 > 0.03) { console.error(`FAIL room F lost its alcove without hints: ${aF2}`); process.exit(1); }
if (r.doorSource !== undefined) { console.error(`FAIL room F: no doorway rule should apply, got ${JSON.stringify({ doorPx: r.doorPx, doorSource: r.doorSource })}`); process.exit(1); }

// 12 and 13. Exploded CAD text, hatching and schedule grids leave two-ended
// slots between collinear strokes. Two rooms side by side, the wall between
// them a row of long strokes broken by slots of a given width (pre-split
// dashes, as CAD exporters emit); this raster is 1 px per pt.
const slotSheet = (slotPx) => {
  const W5 = 800; // the pair of rooms must stay under the page's unbounded cap (40%)
  const H5 = 600;
  const px5 = new Uint8ClampedArray(W5 * H5 * 4).fill(255);
  const box5 = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * W5 + x) * 4; px5[i] = px5[i + 1] = px5[i + 2] = 0; } };
  box5(20, 20, 380, 20); box5(20, 280, 380, 280); box5(20, 20, 20, 280); box5(380, 20, 380, 280);
  for (let y = 21; y < 280; y += 50 + slotPx) box5(200, y, 200, Math.min(y + 49, 279));
  return { width: W5, height: H5, data: px5, toPdf: (x, y) => ({ x, y: H5 - y }), toRaster: (x, y) => ({ x, y: H5 - y }) };
};
// 12. 4 px slots are below the fill's own floor (MIN_DOOR_PT): a no-hints fill
// must not adopt them as a sheet door width (it would split the pair at a
// 4 px "door"); it returns the merged pair, with no door rule claimed
{
  const r5 = dynamicFill(slotSheet(4), { x: 100, y: 600 - 150 });
  if ('error' in r5) { console.error('FAIL 4 px slots: fill errored:', r5.error); process.exit(1); }
  const a5 = area(r5.points);
  console.log(`4 px slots: no-hints fill ${a5.toFixed(0)} (merged pair ~${359 * 259}), door rule ${r5.doorSource ?? 'none'}`);
  if (r5.doorSource !== undefined || Math.abs(a5 - 359 * 259) / (359 * 259) > 0.03) { console.error(`FAIL 4 px slots adopted as a door width: ${JSON.stringify({ doorSource: r5.doorSource, doorPx: r5.doorPx, a5 })}`); process.exit(1); }
}
// 13. 10 px slots (a schedule grid on a real Revit sheet) pass the fill's
// floor, but the scale CHECK must not warn on them (MIN_DOOR_CHECK_PT, 14 pt)
{
  const dp10 = sheetDoorWidthPx(slotSheet(10));
  console.log(`10 px slots: sheet door width for the scale check ${dp10}px (expect 0)`);
  if (dp10 !== 0) { console.error(`FAIL schedule-grid slots would raise a scale warning: ${dp10}px`); process.exit(1); }
  // and a 40 px doorway on the same sheet is reported
  const dp40 = sheetDoorWidthPx(slotSheet(40));
  console.log(`40 px doorways: sheet door width for the scale check ${dp40}px (expect 40)`);
  if (dp40 < 38 || dp40 > 42) { console.error(`FAIL door-sized slots not reported: ${dp40}px`); process.exit(1); }
}

// A ring that revisits a non-adjacent vertex is two lobes touching at one
// point. Area and proper-crossing checks alone accept it, but downstream
// polygon repair can turn the single fill into multiple scored instances.
{
  const touching = [
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
    { x: 0, y: 0 }, { x: -4, y: 0 }, { x: -4, y: -4 }, { x: 0, y: -4 },
  ];
  const reason = simpleRingError(touching);
  if (!reason || !/repeated vertex|self-intersecting/.test(reason)) {
    console.error(`FAIL touching two-lobe ring accepted: ${reason}`);
    process.exit(1);
  }
  console.log(`invalid ring rejected: ${reason}`);
}

console.log('PASS: gap rooms bound with area within tolerance; valid simple rings returned; doorway and opening cases classified');
