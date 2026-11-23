#!/usr/bin/env node
// Layer metadata round-trip: project save/open must retain active layer,
// visibility, lock state and the layer's default markup colour.

import { state } from '../src/app/state.ts';
import {
  DEFAULT_LAYER, knownLayers, layerOf, isVisibleLayer, isLockedLayer,
  layerColor, exportLayerState, importLayerState,
} from '../src/app/layers.ts';

let failed = false;
const check = (label, ok) => {
  if (!ok) { console.error(`FAIL: ${label}`); failed = true; }
  else console.log(`ok: ${label}`);
};

state.markups = [
  { id: 'a', page: 1, type: 'length', label: 'Wall', points: [], createdAt: 1, layer: 'Architectural' },
  { id: 'b', page: 1, type: 'area', label: 'Slab', points: [], createdAt: 2, layer: 'Structural' },
];
importLayerState({
  activeLayer: 'Architectural',
  hidden: ['Structural'],
  layers: [
    { name: 'Architectural', color: '#e11d48', locked: true, order: 1 },
    { name: 'Structural', color: '#0284c7', locked: false, order: 2 },
  ],
});
check('Default remains the first and undeletable base layer', knownLayers()[0] === DEFAULT_LAYER);
check('active layer is restored from project metadata', exportLayerState().activeLayer === 'Architectural');
check('hidden layer visibility is restored', !isVisibleLayer(state.markups[1]) && isVisibleLayer(state.markups[0]));
check('layer lock state is restored', isLockedLayer('Architectural') && !isLockedLayer('Structural'));
check('layer default colour is restored', layerColor(state.markups[0]) === '#e11d48');

const saved = exportLayerState();
importLayerState(undefined);
importLayerState(saved);
check('layer metadata survives export/import round-trip', isLockedLayer('Architectural') && layerColor(state.markups[0]) === '#e11d48' && !isVisibleLayer(state.markups[1]));
check('markup-to-layer assignment remains unchanged', layerOf(state.markups[0]) === 'Architectural' && layerOf(state.markups[1]) === 'Structural');

if (failed) process.exit(1);
console.log('PASS: layer metadata round-trip');
