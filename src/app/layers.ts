// Layers: place markups on named layers and toggle visibility — measure one
// trade, hide it, measure the next. Layer names ride inside the PDF comment
// ([layer:Name]) so they survive round-trips; the layer list is derived from
// the takeoff itself.

import { state, emit } from './state';

export const DEFAULT_LAYER = 'Default';

export function layerOf(m: { layer?: string }): string {
  return m.layer ?? DEFAULT_LAYER;
}

/** Distinct layers present in the current takeoff, Default first. */
export function knownLayers(): string[] {
  const set = new Set<string>([DEFAULT_LAYER]);
  for (const m of state.markups) set.add(layerOf(m));
  return [...set];
}

let activeLayer: string = DEFAULT_LAYER;
const hidden = new Set<string>();

export function getActiveLayer(): string {
  return activeLayer;
}

export function isVisibleLayer(m: { layer?: string }): boolean {
  return !hidden.has(layerOf(m));
}

let box: HTMLElement | null = null;

export function initLayers(): void {
  box = document.getElementById('layersBox');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const eye = target.closest('[data-layer-eye]');
    if (eye) {
      const name = eye.getAttribute('data-layer-eye')!;
      if (hidden.has(name)) hidden.delete(name);
      else hidden.add(name);
      renderLayers();
      emit();
      return;
    }
    const pick = target.closest('[data-layer-pick]');
    if (pick) {
      activeLayer = pick.getAttribute('data-layer-pick')!;
      renderLayers();
      emit();
    }
  });
  document.getElementById('layerNewBtn')?.addEventListener('click', () => {
    const input = document.getElementById('layerNewName') as HTMLInputElement;
    const name = input.value.trim();
    if (!name || name === DEFAULT_LAYER) {
      input.classList.add('invalid');
      setTimeout(() => input.classList.remove('invalid'), 600);
      return;
    }
    activeLayer = name;
    input.value = '';
    renderLayers();
    emit();
  });
  (document.getElementById('layerNewName') as HTMLInputElement)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('layerNewBtn')?.click();
  });
  renderLayers();
}

export function renderLayers(): void {
  if (!box) return;
  const list = document.getElementById('layerList')!;
  list.replaceChildren();
  for (const name of knownLayers()) {
    const count = state.markups.filter((m) => layerOf(m) === name).length;
    const row = document.createElement('button');
    row.className = 'layer-row' + (name === activeLayer ? ' active' : '');
    row.dataset.layerPick = name;
    const eye = document.createElement('span');
    eye.className = 'layer-eye' + (hidden.has(name) ? ' off' : '');
    eye.dataset.layerEye = name;
    eye.textContent = hidden.has(name) ? '◌' : '◉';
    eye.title = hidden.has(name) ? 'Show layer' : 'Hide layer';
    row.append(eye, ` ${escapeHtml(name)}`);
    const n = document.createElement('span');
    n.className = 'layer-count';
    n.textContent = String(count);
    row.append(n);
    row.title = `Place new markups on "${name}"`;
    list.appendChild(row);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
