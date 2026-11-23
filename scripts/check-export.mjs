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

// A measurement's creation-time calibration wins over later page or viewport edits.
const frozen = { ...wall('frozen', 1), calibration: { metersPerPt: METERS_PER_PT * 25, source: 'viewport 1:25' } };
const changedScales = new Map([[1, { metersPerPt: METERS_PER_PT * 200, source: 'preset 1:200' }]]);
const frozenData = { markups: [frozen], calibrations: changedScales, viewports: [{ id: 'vp1', page: 1, points: [{ x: -10, y: -10 }, { x: 200, y: -10 }, { x: 200, y: 10 }, { x: -10, y: 10 }], metersPerPt: METERS_PER_PT * 10, source: 'viewport 1:10' }], displayUnit: 'm' };
const frozenMatrix = buildMatrix(frozenData);
const frozenGroup = frozenMatrix.slice(frozenMatrix.findIndex((r) => r[0] === 'Group') + 1).find((r) => r[0] === 'External wall');
const frozenExpected = 100 * METERS_PER_PT * 25;
check('a measurement retains its creation-time scale after page and viewport scales change', frozenGroup && near(frozenGroup[3], frozenExpected), `got ${frozenGroup?.[3]}, want ${frozenExpected}`);

const counts = { markups: [1, 2, 3].map((p) => ({ id: `n${p}`, page: p, type: 'count', label: 'Downlight', points: [{ x: 1, y: 1 }], createdAt: p })), calibrations: new Map(), displayUnit: 'm' };
const m3 = buildMatrix(counts);
const g3 = m3.slice(m3.findIndex((r) => r[0] === 'Group') + 1).find((r) => r[0] === 'Downlight');
check('counts total without any scale', g3 && g3[3] === 3);


const adjustedWalls = {
  markups: [
    { ...wall('t1', 1), timesing: 2, sign: 1 },
    { ...wall('t2', 2), timesing: 1, sign: -1 },
  ],
  calibrations,
  displayUnit: 'm',
};
const adjustedExpected = 2 * 100 * METERS_PER_PT * 100 - 100 * METERS_PER_PT * 50;
const adjustedMatrix = buildMatrix(adjustedWalls);
const adjustedGroup = adjustedMatrix.slice(adjustedMatrix.findIndex((r) => r[0] === 'Group') + 1).find((r) => r[0] === 'External wall');
check('per-entry timesing and negative deductions are applied to group totals', adjustedGroup && near(adjustedGroup[3], adjustedExpected), `got ${adjustedGroup?.[3]}, want ${adjustedExpected}`);
check('measurement exports include QS adjustment and attribute columns', ['Timesing', 'Sign', 'Base quantity', 'Adjusted quantity', 'Parameters', 'Remarks', 'Links'].every((h) => adjustedMatrix[0].includes(h)));

const linkedPage = 4;
const linkedCalibrations = new Map([[linkedPage, { metersPerPt: 0.01, source: 'test' }]]);
const door = {
  id: 'door-01', page: linkedPage, type: 'count', label: 'D01 timber door',
  points: [{ x: 10, y: 10 }], createdAt: 1,
  parameters: { Width: '900 mm', Height: '2100 mm' },
  links: [
    { markupId: 'paint-wall', logic: 'Deduct opening area from wall finish' },
    { markupId: 'skirting-run', logic: 'Deduct opening width from skirting' },
  ],
};
const paintWall = {
  id: 'paint-wall', page: linkedPage, type: 'area', label: 'Internal wall paint',
  points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }], createdAt: 2,
};
const skirting = {
  id: 'skirting-run', page: linkedPage, type: 'length', label: 'Skirting',
  points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], createdAt: 3,
};
const linkedMarkups = [door, paintWall, skirting];
const linkedCalFor = (m) => linkedCalibrations.get(m.page);
const linkedGroups = groupsOf(linkedMarkups);
const paintTotal = groupTotal(linkedGroups.find((g) => g.label === 'Internal wall paint'), linkedCalFor);
const skirtingTotal = groupTotal(linkedGroups.find((g) => g.label === 'Skirting'), linkedCalFor);
check('user-authored links do not automatically deduct from wall paint quantities', near(paintTotal.total, 100), JSON.stringify(paintTotal));
check('user-authored links do not automatically deduct from skirting quantities', near(skirtingTotal.total, 10), JSON.stringify(skirtingTotal));
const linkedExport = buildMatrix({ markups: linkedMarkups, calibrations: linkedCalibrations, displayUnit: 'm' });
const doorRow = linkedExport.find((r) => r[0] === 'D01 timber door');
check('user-authored link logic is retained in the export as descriptive text', doorRow && String(doorRow[11]).includes('Deduct opening area'));

if (failed) process.exit(1);
console.log('PASS: export group totals (per-item scales, unscaled items, counts)');
