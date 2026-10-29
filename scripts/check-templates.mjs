#!/usr/bin/env node
// Behavioural check for trade takeoff templates (engine/templates.ts): every
// line comes out in the template's order, 0 where nothing was measured;
// labels match ignoring case and spacing; a factor turns wall length into
// paint area; markups on uncalibrated pages are reported, not counted.

import { TAKEOFF_TEMPLATES, templateById, templateSummary, templateMatrix } from '../src/engine/templates.ts';

let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};

const fitout = templateById('fitout');
check('templates: fit-out, electrical and painting exist', ['fitout', 'electrical', 'painting'].every((id) => templateById(id)));
check('templates: ids are unique', new Set(TAKEOFF_TEMPLATES.map((t) => t.id)).size === TAKEOFF_TEMPLATES.length);
check('fit-out: the ten price-sheet lines', fitout.items.length === 10 && fitout.items[0].label === 'Walls');

// 1 pt = 1 m keeps the arithmetic readable
const cal = { metersPerPt: 1, source: 'test' };
let n = 0;
const line = (label, len, page = 1) => ({ id: `m${n++}`, page, type: 'length', label, points: [{ x: 0, y: 0 }, { x: len, y: 0 }], createdAt: 0 });
const box = (label, w, h, page = 1) => ({ id: `m${n++}`, page, type: 'area', label, points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], createdAt: 0 });
const pin = (label, page = 1) => ({ id: `m${n++}`, page, type: 'count', label, points: [{ x: 1, y: 1 }], createdAt: 0 });

const markups = [
  line('Walls', 19.66),
  line('walls ', 11.5), // case and spacing do not split a line
  line('Walls', 1.4),
  box('Ceilings (Plasterboard)', 4, 5),
  pin('Doors (Timber)'),
  pin('Doors (Timber)'),
  pin('Doors (Timber)'),
  pin('Doors (Timber)'),
  line('Feature Wall Paint', 10),
  line('Walls', 5, 2), // page 2 has no scale yet
  pin('Something else'),
];
const lines = templateSummary(fitout, markups, (m) => (m.page === 1 ? cal : undefined));
const by = Object.fromEntries(lines.map((l) => [l.label, l]));
check('summary: one line per template item, in order', lines.map((l) => l.label).join('|') === fitout.items.map((i) => i.label).join('|'));
check('summary: walls total across labels that differ only in case and spacing', by['Walls'].quantity === 32.56, String(by['Walls'].quantity));
check('summary: a markup on an uncalibrated page is reported, not counted', by['Walls'].uncalibrated === 1);
check('summary: ceilings in square metres', by['Ceilings (Plasterboard)'].quantity === 20 && by['Ceilings (Plasterboard)'].unit === 'm²');
check('summary: timber doors counted', by['Doors (Timber)'].quantity === 4 && by['Doors (Timber)'].unit === 'no.');
check('summary: feature paint is wall length x 2.7 m', by['Feature Wall Paint'].quantity === 27 && by['Feature Wall Paint'].unit === 'm²');
check('summary: lines with nothing measured are 0', ['Bulkheads', 'Grid Ceiling', 'Doors (Aluminium)', 'Doors (Frameless)', 'Windows', 'Mirrors'].every((l) => by[l].quantity === 0));
check('summary: a count on the same label but another tool does not land on a length line', templateSummary(fitout, [pin('Walls')], () => cal)[0].quantity === 0);

check('summary: a bracketed detail rolls up into its line (proposed wall runs)', templateSummary(fitout, [line('Walls (half height)', 10), line('Walls (proposed partition)', 5), line('Wallsy', 99)], () => cal)[0].quantity === 15);

const matrix = templateMatrix(fitout, lines, 'Aero Group');
check('sheet: title, header, then every line', matrix[0][0] === 'Commercial fit-out takeoff: Aero Group' && matrix[2].join('|') === 'Item|Quantity|Unit|Note' && matrix.length === 3 + 10);
check('sheet: the uncalibrated markup is noted on its line', String(matrix[3][3]).includes('1 markup not counted'));

if (failed) process.exit(1);
console.log('template checks passed');
