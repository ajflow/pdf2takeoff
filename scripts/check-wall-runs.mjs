#!/usr/bin/env node
// Behavioural check for wall runs read off CAD wall layers
// (engine/wall-runs.ts): centrelines of straight and curved pieces,
// triangle-pair fills joined back, corner squares counted (columns not),
// the legend read from a column of swatches (a lighter tint and an outlined
// white box included), legend swatches never counted, and which classes
// are proposed under which labels.

import { centreline, pairTriangles, readWallLegend, legendFor, wallRuns, wallLabel, classesToPropose } from '../src/engine/wall-runs.ts';

let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// a vector page built from filled outlines and stroked boxes
function page(shapes) {
  const segs = [];
  const paths = [];
  for (const { ring, fill, stroke } of shapes) {
    const first = segs.length;
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      segs.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, lineWidth: stroke ? 0.3 : 0, stroked: !!stroke, filled: !!fill, dashed: false, curve: false, path: paths.length, form: -1 });
    });
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    paths.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), segs: [first, segs.length], form: -1, lineWidth: 0, curve: false, ...(fill ? { fill } : {}) });
  }
  return { segs, paths, forms: 0, layers: 0 };
}
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const word = (text, xPt, yPt) => ({ text, conf: 100, xPt, yPt, wPt: text.length * 4, hPt: 5, angleDeg: 0 });

// straight piece: 100 long, 3 thick
{
  const p = centreline(rect(0, 0, 100, 3));
  check('straight piece: centreline along the long axis', p && near(p.lengthPt, 100) && near(p.thicknessPt, 3) && near(p.points[0].y, 1.5), JSON.stringify(p));
}
// curved piece: a quarter-ring of mean radius 50, 4 thick
{
  const outer = [];
  const inner = [];
  for (let k = 0; k <= 12; k++) {
    const a = (Math.PI / 2) * (k / 12);
    outer.push({ x: 52 * Math.cos(a), y: 52 * Math.sin(a) });
    inner.push({ x: 48 * Math.cos(a), y: 48 * Math.sin(a) });
  }
  const p = centreline([...outer, ...inner.reverse()]);
  check('curved piece: centreline follows the curve (quarter of 2·π·50 ≈ 78.5)', p && near(p.lengthPt, 78.5, 0.02), p && p.lengthPt.toFixed(2));
}
// a blob thicker than half its length is not a wall
check('column-like shape: not a wall piece', centreline(rect(0, 0, 10, 8)) === null);
// triangle pairs joined back
{
  const q = pairTriangles([
    [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 3 }],
    [{ x: 0, y: 0 }, { x: 60, y: 3 }, { x: 0, y: 3 }],
  ]);
  check('triangle pair: joined into one four-sided piece', q.length === 1 && q[0].length === 4 && near(centreline(q[0]).lengthPt, 60), JSON.stringify(q));
}

// a sheet: legend column top right, walls in three shades, a junction square, a column
const shapes = [
  // legend swatches (stacked, same left edge and width)
  { ring: rect(500, 300, 20, 5), fill: '#404040' },
  { ring: rect(500, 290, 20, 5), fill: '#bfbfbf' }, // a tint lighter than the walls it names
  { ring: rect(500, 280, 20, 5), stroke: true }, // outlined: a white swatch
  // proposed partitions (#9f9f9f): 80 and 40 long, 3 thick, meeting at a 3x3 square
  { ring: rect(0, 0, 80, 3), fill: '#9f9f9f' },
  { ring: rect(80, 0, 3, 3), fill: '#9f9f9f' },
  { ring: rect(80, 3, 3, 40), fill: '#9f9f9f' },
  // a column in the same shade: 9x9, too big for a junction
  { ring: rect(200, 200, 9, 9), fill: '#9f9f9f' },
  // half height (white): 30 long, 2 thick
  { ring: rect(0, 100, 30, 2), fill: '#ffffff' },
  // existing (dark): 120 long, 4 thick
  { ring: rect(0, 150, 120, 4), fill: '#404040' },
];
const vec = page(shapes);
const words = [word('EXISTING', 538, 302.5), word('PARTITION', 576, 302.5), word('PROPOSED', 538, 292.5), word('PARTITION', 576, 292.5), word('HALF', 530, 282.5), word('HEIGHT', 556, 282.5), word('EXISTING', 300, 50)];
const legend = readWallLegend(words, vec);
check('legend: three entries from the swatch column, the stray word ignored', legend.map((e) => e.name).join('|') === 'EXISTING PARTITION|PROPOSED PARTITION|HALF HEIGHT', JSON.stringify(legend));
check('legend: an outlined swatch reads as white', legend.find((e) => e.name === 'HALF HEIGHT')?.fill === '#ffffff');
check('legend: a wall grey matches its lighter swatch', legendFor('#9f9f9f', legend)?.name === 'PROPOSED PARTITION');
check('legend: a colour is never matched by shade', legendFor('#ffaaaa', legend) === undefined);

const classes = wallRuns(vec, legend);
const byName = Object.fromEntries(classes.map((c) => [c.name, c]));
check('runs: existing 120 long', near(byName['EXISTING PARTITION']?.lengthPt, 120) && byName['EXISTING PARTITION'].kind === 'existing');
check('runs: proposed 80 + 40 + the 3 junction square, the column left out', near(byName['PROPOSED PARTITION']?.lengthPt, 123) && byName['PROPOSED PARTITION'].skipped === 1, JSON.stringify(byName['PROPOSED PARTITION'] && { len: byName['PROPOSED PARTITION'].lengthPt, skipped: byName['PROPOSED PARTITION'].skipped }));
check('runs: half height 30 long, counted as new', near(byName['HALF HEIGHT']?.lengthPt, 30) && byName['HALF HEIGHT'].kind === 'new');
check('runs: the legend swatches are not counted as walls', classes.every((c) => c.pieces.every((p) => p.points.every((q) => q.x < 400))));

check('labels: "Walls (proposed partition)", existing kept apart', wallLabel(byName['PROPOSED PARTITION']) === 'Walls (proposed partition)' && wallLabel(byName['EXISTING PARTITION']) === 'Existing walls (existing partition)');
check('propose: new walls only by default', classesToPropose(classes).map((c) => c.name).sort().join('|') === 'HALF HEIGHT|PROPOSED PARTITION');
check('propose: all adds existing', classesToPropose(classes, 'all').length === 3);
{
  const bare = classesToPropose(wallRuns(vec, []));
  check('propose: no legend means every unnamed shade, for the person to sort out', bare.length >= 3 && bare.every((c) => c.kind === 'unknown'), String(bare.length));
}

if (failed) process.exit(1);
console.log('wall run checks passed');
