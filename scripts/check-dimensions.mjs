#!/usr/bin/env node
// Behavioural check for the printed-dimension scale witness (engine/dimensions.ts):
// a sheet whose title block says 1:100 but whose dimensions are drawn at 1:50
// is caught; dimension lines that stop short of their ticks are measured
// tick to tick; level tags, stray numbers and too few dimensions do not vote;
// Acrobat's SHX text comments read as words.

import { parseDimensionMm, shxWords, dimensionScale, checkAgainstDimensions } from '../src/engine/dimensions.ts';
import { METERS_PER_PT } from '../src/engine/units.ts';

let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};

const seg = (x1, y1, x2, y2, o = {}) => ({ x1, y1, x2, y2, lineWidth: 0.25, stroked: true, filled: false, dashed: false, curve: false, path: 0, form: -1, ...o });
const page = (segs) => ({ segs, paths: [], forms: 0, layers: 0 });
const word = (text, xPt, yPt, angleDeg = 0) => ({ text, conf: 100, xPt, yPt, wPt: text.length * 4, hPt: 6, angleDeg });

/**
 * A horizontal dimension of `mm` at `ratio`, starting at x, on line y, its
 * value printed above. `short` stops the line that many pt short of each
 * tick (some CAD exports do); `ticks: false` leaves the ends open.
 */
function dim(mm, ratio, x, y, { short = 0, ticks = true } = {}) {
  const len = mm / 1000 / ratio / METERS_PER_PT;
  const segs = [seg(x + short, y, x + len - short, y)];
  if (ticks) segs.push(seg(x - 2, y - 2, x + 2, y + 2), seg(x + len - 2, y - 2, x + len + 2, y + 2));
  return { segs, words: [word(String(mm), x + len / 2, y + 5)] };
}
function sheet(parts) {
  return { vec: page(parts.flatMap((p) => p.segs)), words: parts.flatMap((p) => p.words) };
}

// parsing
check('parse: plain millimetres', parseDimensionMm('3570') === 3.57);
check('parse: thousands separator', parseDimensionMm('6,223') === 6.223);
check('parse: too short to measure', parseDimensionMm('90') === null);
check('parse: not a dimension', [ '1:100', 'C0259', '12.5', '07', '100000' ].every((t) => parseDimensionMm(t) === null));

// a sheet labelled 1:100 but drawn at 1:50
{
  const s = sheet([dim(3520, 50, 100, 700), dim(3570, 50, 320, 700), dim(6480, 50, 100, 650), dim(2700, 50, 100, 600), dim(1840, 50, 300, 600)]);
  const d = dimensionScale(s.words, s.vec);
  check('1:50 sheet: dimensions agree on 1:50', d.ratio === 50 && d.support === 5, JSON.stringify({ ratio: d.ratio, support: d.support, total: d.total }));
  const c = checkAgainstDimensions(100, d, 100);
  check('1:50 sheet: 1:100 disagrees', c.status === 'disagrees' && c.drawnRatio === 50);
  check('1:50 sheet: the message says lengths come out 2x too long and blames the title block', /2× too long/.test(c.message ?? '') && /title block's 1:100 looks wrong/.test(c.message ?? ''), c.message);
  check('1:50 sheet: 1:50 agrees', checkAgainstDimensions(50, d, 100).status === 'agrees');
  check('1:50 sheet: a 1:25 scale makes lengths 2x too short', /2× too short/.test(checkAgainstDimensions(25, d).message ?? ''), checkAgainstDimensions(25, d).message);
}

// dimension lines that stop short of their ticks are measured tick to tick
{
  const s = sheet([dim(3520, 50, 100, 700, { short: 8.5 }), dim(1840, 50, 320, 700, { short: 8.5 }), dim(850, 50, 100, 650, { short: 8.5 }), dim(6480, 50, 100, 600, { short: 8.5 })]);
  const d = dimensionScale(s.words, s.vec);
  check('short lines: still 1:50, measured between the ticks', d.ratio === 50 && d.support === 4, JSON.stringify(d.votes.map((v) => Math.round(v.ratio))));
}

// level tags: different values on lines of the same length do not vote
{
  const tag = (mm, x) => ({ segs: [seg(x, 300, x + 33, 300), seg(x - 2, 298, x + 2, 302), seg(x + 31, 298, x + 35, 302)], words: [word(String(mm), x + 16, 305)] });
  const s = sheet([tag(2930, 100), tag(3000, 200), tag(3870, 300), tag(4660, 400)]);
  const d = dimensionScale(s.words, s.vec);
  check('level tags: no votes', d.votes.length === 0 && d.ratio === undefined, JSON.stringify(d.votes.map((v) => v.source)));
}

// a number over a line with open ends (a stray label over a wall) does not vote
{
  const s = sheet([dim(3520, 50, 100, 700, { ticks: false }), dim(3570, 50, 320, 700, { ticks: false }), dim(2700, 50, 100, 600, { ticks: false })]);
  check('open-ended lines: no votes', dimensionScale(s.words, s.vec).votes.length === 0);
}

// too few dimensions to call
{
  const s = sheet([dim(3520, 50, 100, 700), dim(3570, 50, 320, 700)]);
  const d = dimensionScale(s.words, s.vec);
  check('two dimensions: no verdict', d.ratio === undefined && checkAgainstDimensions(100, d, 100).status === 'unknown');
}

// viewports at two scales split the vote: no verdict
{
  const s = sheet([dim(3520, 50, 100, 700), dim(3570, 50, 320, 700), dim(2700, 50, 100, 650), dim(3520, 100, 100, 500), dim(3570, 100, 320, 500), dim(2700, 100, 100, 450)]);
  check('split viewports: no verdict', dimensionScale(s.words, s.vec).ratio === undefined);
}

// turned (vertical) dimensions
{
  const vdim = (mm, x, y) => {
    const len = mm / 1000 / 50 / METERS_PER_PT;
    return { segs: [seg(x, y, x, y + len), seg(x - 2, y - 2, x + 2, y + 2), seg(x - 2, y + len - 2, x + 2, y + len + 2)], words: [word(String(mm), x - 5, y + len / 2, 90)] };
  };
  const s = sheet([vdim(2085, 800, 100), vdim(4855, 800, 300), vdim(2805, 830, 100)]);
  check('vertical dimensions: 1:50', dimensionScale(s.words, s.vec).ratio === 50);
}

// Acrobat SHX text comments as words
{
  const w = shxWords([
    { rect: [683, 790, 713, 805], contentsObj: { str: '3570' }, titleObj: { str: 'AutoCAD SHX Text' } },
    { rect: [812, 124, 826, 154], contentsObj: { str: '2085' }, titleObj: { str: 'AutoCAD SHX Text' } },
    { rect: [10, 10, 40, 20], contentsObj: { str: '3570' }, titleObj: { str: 'Someone' } },
  ]);
  check('SHX comments: only Acrobat SHX text, upright and turned', w.length === 2 && w[0].angleDeg === 0 && w[1].angleDeg === 90 && w[0].xPt === 698 && w[1].wPt === 30, JSON.stringify(w));
}

if (failed) process.exit(1);
console.log('dimension checks passed');
