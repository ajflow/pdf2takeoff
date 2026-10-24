#!/usr/bin/env node
// Behavioural check for export group totals (engine/export.ts): a label that
// spans pages drawn at different scales totals each markup at its own scale
// (it used to apply the first item's scale to the whole group), a group with
// an unscaled item has no total rather than a wrong one, and the panel's
// groupTotal agrees with the exported matrix.

import { buildMatrix, groupTotal, groupsOf } from '../src/engine/export.ts';
import { METERS_PER_PT } from '../src/engine/units.ts';

let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

// 100 pt long walls on page 1 (1:100) and page 2 (1:50), and one on page 3 (no scale)
const wall = (id, page) => ({ id, page, type: 'length', label: 'External wall', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], createdAt: 1 });
const calibrations = new Map([
  [1, { metersPerPt: METERS_PER_PT * 100, source: 'preset 1:100' }],
  [2, { metersPerPt: METERS_PER_PT * 50, source: 'preset 1:50' }],
]);
const expected = 100 * METERS_PER_PT * 100 + 100 * METERS_PER_PT * 50;

const twoScales = { markups: [wall('a', 1), wall('b', 2)], calibrations, displayUnit: 'm' };
const matrix = buildMatrix(twoScales);
const group = matrix.slice(matrix.findIndex((r) => r[0] === 'Group') + 1).find((r) => r[0] === 'External wall');
check('a label across 1:100 and 1:50 pages totals each wall at its own scale', group && near(group[3], expected), `got ${group?.[3]}, want ${expected}`);
const calFor = (m) => calibrations.get(m.page);
const [g] = groupsOf(twoScales.markups);
check('the panel total (groupTotal) matches the export', near(groupTotal(g, calFor).total, expected) && groupTotal(g, calFor).uncalibrated === 0);

const withUnscaled = { markups: [wall('a', 1), wall('b', 2), wall('c', 3)], calibrations, displayUnit: 'm' };
const m2 = buildMatrix(withUnscaled);
const g2 = m2.slice(m2.findIndex((r) => r[0] === 'Group') + 1).find((r) => r[0] === 'External wall');
check('a group with an unscaled item exports no total rather than a wrong one', g2 && g2[3] === '', `got ${JSON.stringify(g2)}`);
const t2 = groupTotal(groupsOf(withUnscaled.markups)[0], calFor);
check('groupTotal reports the scaled part and counts the unscaled item', near(t2.total, expected) && t2.uncalibrated === 1, JSON.stringify(t2));

const counts = { markups: [1, 2, 3].map((p) => ({ id: `n${p}`, page: p, type: 'count', label: 'Downlight', points: [{ x: 1, y: 1 }], createdAt: p })), calibrations: new Map(), displayUnit: 'm' };
const m3 = buildMatrix(counts);
const g3 = m3.slice(m3.findIndex((r) => r[0] === 'Group') + 1).find((r) => r[0] === 'Downlight');
check('counts total without any scale', g3 && g3[3] === 3);

if (failed) process.exit(1);
console.log('PASS: export group totals (per-item scales, unscaled items, counts)');
