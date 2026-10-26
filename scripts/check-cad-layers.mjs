#!/usr/bin/env node
// Behavioural check for CAD layer roles (engine/cad-layers.ts): which layers
// Magic Fill leaves out of its render (furniture, finish hatching,
// annotation, services, structure above) and which always stay (walls,
// doors, glazing, anything unrecognised), plain names and US National CAD
// Standard codes alike; and the merged-rooms test that sends a fill back
// to every layer.

import { layerRole, layersToHideForFill, fillMergesRooms, NOT_A_ROOM_NAME } from '../src/engine/cad-layers.ts';

let failed = false;
const check = (label, cond, detail = '') => {
  if (!cond) {
    console.error(`FAIL: ${label} ${detail}`);
    failed = true;
  } else console.log(`ok: ${label}`);
};

const roles = [
  // ArchiCAD-style names
  ['805 A Furniture|Loose', 'furniture'],
  ['800 A Furniture|Joinery', 'furniture'],
  ['220 A Wall_Internal ', 'structure'],
  ['210 A Wall_External', 'structure'],
  ['230 A Floor', 'finish'],
  ['000 A Area', 'finish'],
  ['000 A Text (Room Names)', 'annotation'],
  ['000 A Dimension', 'annotation'],
  ['600 A Electrical|Lighting', 'services'],
  ['600 A Hydraulic', 'services'],
  ['Railings', 'structure'],
  ['010 A Line', 'other'],
  // AutoCAD xref names
  ['C0259_XR_Ground|I-FURN', 'furniture'],
  ['C0259_XR_Ground|Q-SPCQ', 'furniture'],
  ['C0259_XR_Ground|Outdoor furniture', 'furniture'], // "Outdoor" is not a door
  ['C0259_XR_Ground|Struct_Above', 'overhead'],
  ['C0259_XR_Ground|Glazing', 'structure'],
  ['C0259_XR_Ground|Floor_Coverings_001', 'finish'],
  ['C0259_XR_Ground|Plan_002', 'other'],
  ['0', 'other'],
  // National CAD Standard codes
  ['A-WALL-FULL', 'structure'],
  ['A-DOOR', 'structure'],
  ['I-WALL', 'structure'],
  ['A-FLOR-PATT', 'finish'],
  ['A-ANNO-DIMS', 'annotation'],
  ['E-LITE', 'services'],
  ['M-HVAC-DUCT', 'services'],
  ['Doors', 'structure'],
  ['Bulkhead outline', 'overhead'],
];
for (const [name, want] of roles) {
  const got = layerRole(name);
  check(`role: ${name} -> ${want}`, got === want, `got ${got}`);
}

const hidden = layersToHideForFill([
  { id: '1', name: '220 A Wall_Internal' },
  { id: '2', name: '805 A Furniture|Loose' },
  { id: '3', name: 'C0259_XR_Ground|Plan_002' },
  { id: '4', name: 'C0259_XR_Ground|Struct_Above' },
  { id: '5', name: null },
]);
check('hide for fill: furniture and structure above only', hidden.map((h) => h.id).join(',') === '2,4', JSON.stringify(hidden));
check('hide for fill: nothing when no clutter layers', layersToHideForFill([{ id: '1', name: 'A-WALL' }, { id: '2', name: '0' }]).length === 0);

const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
check('merged rooms: two names inside', fillMergesRooms(square, [{ x: 2, y: 2 }, { x: 8, y: 8 }]));
check('merged rooms: one name inside, one outside', !fillMergesRooms(square, [{ x: 2, y: 2 }, { x: 20, y: 8 }]));
check('room names: finish and construction notes are not room names', ['VINYL PLANK', 'EXISTING CEILING RETAINED', 'REFER TO DETAIL', 'WALL TO BE FINISHED TO MATCH'].every((t) => NOT_A_ROOM_NAME.test(t)));
check('room names: short names are', ['OFFICE 1', 'BOARDROOM', 'STAFF ROOM', 'RECEPTION', 'COLD ROOM'].every((t) => !NOT_A_ROOM_NAME.test(t)));

if (failed) process.exit(1);
console.log('cad layer checks passed');
