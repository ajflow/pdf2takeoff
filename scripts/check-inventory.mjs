#!/usr/bin/env node
// Behavioural check for inventory counting (src/engine/inventory.ts): builds
// the proposed item markups in memory (no PDF), counts them under both
// shipped presets and under custom presets spread from AECV_PRESET, and
// asserts the exact hand-computed counts, decision fields, invariants and
// labels. Exits non-zero on any mismatch.

import {
  AECV_PRESET,
  COUNT_FIELDS,
  SCHEDULE_PRESET,
  countItems,
  itemLabel,
  presetById,
} from '../src/engine/inventory.ts';

let failures = 0;
const eq = (what, got, want) => {
  if (Object.is(got, want)) return;
  failures += 1;
  console.error(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// one point each, page 1 unless noted; every item status 'check' except d1 and s1
const base = (id, status, attrs, page = 1) => ({
  id,
  page,
  type: 'count',
  label: '',
  points: [{ x: 10, y: 20 }],
  createdAt: 0,
  status,
  item: attrs,
});
const door = (id, status, attrs, page) => base(id, status, { kind: 'Door', source: 'model', ...attrs }, page);
const win = (id, status, attrs, page) => base(id, status, { kind: 'Window', source: 'model', ...attrs }, page);
const space = (id, status, attrs, page) => base(id, status, { kind: 'Space', source: 'model', ...attrs }, page);

const items = [
  // doors
  door('d1', 'confirmed', { doorType: 'swing', leaves: 1 }),
  door('d2', 'check', { doorType: 'double_swing', leaves: 2 }),
  door('d3', 'check', { doorType: 'sliding', closet: true }),
  door('d4', 'check', { doorType: 'bifold', closet: true }),
  door('d5', 'check', { doorType: 'garage' }),
  door('d6', 'check', { doorType: 'french_glazed', leaves: 2 }),
  door('d7', 'check', { doorType: 'swing', closet: true, leaves: 1 }),
  // windows
  win('w1', 'check', { glazingType: 'unit', group: 'g1' }),
  win('w2', 'check', { glazingType: 'unit', group: 'g1' }),
  win('w3', 'check', { glazingType: 'unit' }),
  win('w4', 'check', { glazingType: 'sliding_glass_door', group: 'g2' }),
  win('w5', 'check', { glazingType: 'other' }),
  win('w6', 'check', { glazingType: 'unit', group: 'g1' }, 2),
  // spaces
  space('s1', 'confirmed', { spaceKind: 'room', roomLabel: 'Bedroom 1', bedroom: true }),
  space('s2', 'check', { spaceKind: 'room', roomLabel: 'Bedroom 2', bedroom: true }),
  space('s3', 'check', { spaceKind: 'open_plan_zone', roomLabel: 'Living' }),
  space('s4', 'check', { spaceKind: 'open_plan_zone', roomLabel: 'Kitchen' }),
  space('s5', 'check', { spaceKind: 'open_plan_zone', roomLabel: 'Dining' }),
  space('s6', 'check', { spaceKind: 'wet', roomLabel: 'Bath', wetKind: 'bathroom' }),
  space('s7', 'check', { spaceKind: 'wet', roomLabel: 'WC', wetKind: 'wc' }),
  space('s8', 'check', { spaceKind: 'wet', roomLabel: 'Powder', wetKind: 'lavatory' }),
  space('s9', 'check', { spaceKind: 'closet', roomLabel: 'WIR' }),
  space('s10', 'check', { spaceKind: 'hallway', roomLabel: 'Hall' }),
  space('s11', 'check', { spaceKind: 'outdoor', roomLabel: 'Deck' }),
  space('s12', 'check', { spaceKind: 'stair', roomLabel: '' }),
  space('s13', 'check', { spaceKind: 'storage_utility', roomLabel: 'Laundry' }),
  space('s14', 'check', { spaceKind: 'open_plan_zone', roomLabel: 'Family' }, 2),
  // noise: no item payload, so no decisions may mention them
  { id: 'noise-length', page: 1, type: 'length', label: 'Wall', points: [{ x: 0, y: 0 }, { x: 9, y: 0 }], createdAt: 0 },
  { id: 'noise-count', page: 1, type: 'count', label: 'Downlight', points: [{ x: 1, y: 1 }], createdAt: 0 },
];

const byId = (res, id) => res.decisions.find((d) => d.id === id);

// counts must equal the summed decisions per field, and a zero count always says why
const checkResult = (tag, res, counts, unconfirmed) => {
  for (const f of COUNT_FIELDS) eq(`${tag} counts.${f}`, res.counts[f], counts[f]);
  eq(`${tag} unconfirmed`, res.unconfirmed, unconfirmed);
  for (const f of COUNT_FIELDS) {
    eq(`${tag} invariant ${f}`, res.decisions.filter((d) => d.field === f).reduce((n, d) => n + d.counted, 0), res.counts[f]);
  }
  for (const d of res.decisions) {
    if (d.counted === 0) eq(`${tag} non-empty reason for ${d.id}`, d.reason.length > 0, true);
  }
};

const aecv = countItems(items, AECV_PRESET);
checkResult('aecv', aecv, { Door: 4, Window: 5, Space: 9, Bedroom: 2, Toilet: 2 }, 15);
eq('aecv: garage door excluded everywhere', byId(aecv, 'd5')?.field ?? null, null);
eq('aecv: french_glazed leaf counts as Window', byId(aecv, 'd6')?.field, 'Window');
eq('aecv: second g1 unit grouped away', byId(aecv, 'w2')?.counted, 0);
eq('aecv: noise markups ignored', aecv.decisions.filter((d) => d.id.startsWith('noise-')).length, 0);

const schedule = countItems(items, SCHEDULE_PRESET);
checkResult('schedule', schedule, { Door: 6, Window: 6, Space: 13, Bedroom: 2, Toilet: 2 }, 23);
eq('schedule: garage door excluded everywhere', byId(schedule, 'd5')?.field ?? null, null);
eq('schedule: french_glazed leaf counts as Door', byId(schedule, 'd6')?.field, 'Door');
eq('schedule: every Window unit counted', byId(schedule, 'w2')?.counted, 1);

// custom presets spread from AECV_PRESET
const twoRooms = [
  space('r1', 'check', { spaceKind: 'room', roomLabel: '' }),
  space('r2', 'check', { spaceKind: 'room', roomLabel: 'Study' }),
];
const requireLabel = { ...AECV_PRESET, space: { ...AECV_PRESET.space, requireLabel: true } };
eq('requireLabel drops the unlabelled room', countItems(twoRooms, requireLabel).counts.Space, 1);
eq('default keeps both rooms', countItems(twoRooms, AECV_PRESET).counts.Space, 2);
const openRoom = [space('r1', 'check', { spaceKind: 'room', roomLabel: 'Atrium', enclosed: false })];
const requireEnclosed = { ...AECV_PRESET, space: { ...AECV_PRESET.space, requireEnclosed: true } };
eq('requireEnclosed drops the open room', countItems(openRoom, requireEnclosed).counts.Space, 0);
eq('default keeps the open room', countItems(openRoom, AECV_PRESET).counts.Space, 1);

eq('presetById finds aecv', presetById('aecv') === AECV_PRESET, true);
eq('presetById finds schedule', presetById('schedule') === SCHEDULE_PRESET, true);
eq('presetById unknown', presetById('nope') === undefined, true);

eq('label double_swing', itemLabel({ kind: 'Door', source: 'model', doorType: 'double_swing' }), 'Door (double swing)');
eq('label unit', itemLabel({ kind: 'Window', source: 'model', glazingType: 'unit' }), 'Window (unit)');
eq('label roomLabel', itemLabel({ kind: 'Space', source: 'model', roomLabel: 'Kitchen' }), 'Space: Kitchen');
eq('label spaceKind', itemLabel({ kind: 'Space', source: 'model', spaceKind: 'storage_utility' }), 'Space (storage utility)');
eq('label door default', itemLabel({ kind: 'Door', source: 'model' }), 'Door (other)');

if (failures > 0) {
  console.error(`inventory check: ${failures} failure(s)`);
  process.exit(1);
}
console.log('PASS: inventory counting matches the hand-computed expectations (both presets, custom flags, decisions, labels)');
