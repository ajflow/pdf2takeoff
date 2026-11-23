// Named take-off layers. Layer metadata is stored in the .p2t project so
// visibility, ordering, colours and locks survive a save/reopen cycle.

import { state, emit } from './state';

export const DEFAULT_LAYER = 'Default';

type LayerMeta = { name: string; color?: string; locked?: boolean; order?: number };
type LayerState = { activeLayer?: string; hidden?: string[]; layers?: LayerMeta[] };

function cleanName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

let activeLayer = DEFAULT_LAYER;
const hidden = new Set<string>();
const metadata = new Map<string, LayerMeta>([[DEFAULT_LAYER, { name: DEFAULT_LAYER }]]);

export function layerOf(m: { layer?: string }): string {
  return m.layer ?? DEFAULT_LAYER;
}

function ensureLayer(name: string): LayerMeta {
  let item = metadata.get(name);
  if (!item) {
    item = { name };
    metadata.set(name, item);
  }
  return item;
}

export function knownLayers(): string[] {
  const names = new Set<string>([DEFAULT_LAYER, ...metadata.keys()]);
  for (const m of state.markups) names.add(layerOf(m));
  for (const name of names) ensureLayer(name);
  return [...names].sort((a, b) => a === DEFAULT_LAYER ? -1 : b === DEFAULT_LAYER ? 1 : (ensureLayer(a).order ?? 9999) - (ensureLayer(b).order ?? 9999) || a.localeCompare(b));
}

export function getActiveLayer(): string {
  return activeLayer;
}

export function isLockedLayer(name: string): boolean {
  return Boolean(ensureLayer(name).locked);
}

export function layerColor(m: { layer?: string }): string | undefined {
  return ensureLayer(layerOf(m)).color;
}

export function exportLayerState(): LayerState {
  return {
    activeLayer,
    hidden: [...hidden],
    layers: knownLayers().map((name) => ({ ...ensureLayer(name) })),
  };
}

export function importLayerState(value: LayerState | undefined): void {
  activeLayer = value?.activeLayer || DEFAULT_LAYER;
  hidden.clear();
  for (const name of value?.hidden ?? []) if (typeof name === 'string') hidden.add(name);
  metadata.clear();
  metadata.set(DEFAULT_LAYER, { name: DEFAULT_LAYER });
  for (const item of value?.layers ?? []) {
    if (!item || typeof item.name !== 'string' || !item.name.trim()) continue;
    metadata.set(item.name, { name: item.name, color: item.color, locked: Boolean(item.locked), order: item.order });
  }
  for (const m of state.markups) ensureLayer(layerOf(m));
  if (!metadata.has(activeLayer)) activeLayer = DEFAULT_LAYER;
  renderLayers();
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
    const eye = target.closest<HTMLElement>('[data-layer-eye]');
    if (eye) {
      const name = eye.dataset.layerEye!;
      if (hidden.has(name)) hidden.delete(name); else hidden.add(name);
      renderLayers(); emit(); return;
    }
    const lock = target.closest<HTMLElement>('[data-layer-lock]');
    if (lock) {
      const item = ensureLayer(lock.dataset.layerLock!);
      item.locked = !item.locked;
      renderLayers(); emit(); return;
    }
    const move = target.closest<HTMLElement>('[data-layer-move]');
    if (move) {
      const name = move.dataset.layerMove!;
      const names = knownLayers().filter((item) => item !== DEFAULT_LAYER);
      const index = names.indexOf(name);
      const nextIndex = index + Number(move.dataset.direction || 0);
      if (index >= 0 && nextIndex >= 0 && nextIndex < names.length) {
        const a = ensureLayer(name), b = ensureLayer(names[nextIndex]);
        const order = a.order ?? index;
        a.order = b.order ?? nextIndex;
        b.order = order;
        renderLayers(); emit();
      }
      return;
    }
    const rename = target.closest<HTMLElement>('[data-layer-rename]');
    if (rename) {
      const oldName = rename.dataset.layerRename!;
      if (oldName === DEFAULT_LAYER) return;
      const nextName = cleanName(window.prompt('Rename layer', oldName) ?? '');
      if (!nextName || nextName === oldName || nextName === DEFAULT_LAYER || metadata.has(nextName)) return;
      const item = ensureLayer(oldName);
      metadata.delete(oldName);
      item.name = nextName;
      metadata.set(nextName, item);
      for (const m of state.markups) if (layerOf(m) === oldName) m.layer = nextName;
      if (hidden.delete(oldName)) hidden.add(nextName);
      if (activeLayer === oldName) activeLayer = nextName;
      renderLayers(); emit(); return;
    }
    const remove = target.closest<HTMLElement>('[data-layer-delete]');
    if (remove) {
      const name = remove.dataset.layerDelete!;
      if (name === DEFAULT_LAYER) return;
      const count = state.markups.filter((m) => layerOf(m) === name).length;
      if (!window.confirm(count ? `Delete "${name}" and move its ${count} measurement(s) to Default?` : `Delete empty layer "${name}"?`)) return;
      for (const m of state.markups) if (layerOf(m) === name) delete m.layer;
      metadata.delete(name); hidden.delete(name);
      if (activeLayer === name) activeLayer = DEFAULT_LAYER;
      renderLayers(); emit(); return;
    }
    const pick = target.closest<HTMLElement>('[data-layer-pick]');
    if (pick) {
      const name = pick.dataset.layerPick!;
      if (isLockedLayer(name)) return;
      activeLayer = name;
      renderLayers(); emit();
    }
  });
  box.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches('[data-layer-color]')) return;
    const name = input.dataset.layerColor!;
    ensureLayer(name).color = input.value.toLowerCase();
    emit();
  });
  document.getElementById('layerNewBtn')?.addEventListener('click', () => {
    const input = document.getElementById('layerNewName') as HTMLInputElement;
    const name = cleanName(input.value);
    if (!name || name === DEFAULT_LAYER || metadata.has(name)) {
      input.classList.add('invalid');
      setTimeout(() => input.classList.remove('invalid'), 600);
      return;
    }
    metadata.set(name, { name, order: knownLayers().length });
    activeLayer = name;
    input.value = '';
    renderLayers(); emit();
  });
  (document.getElementById('layerNewName') as HTMLInputElement)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('layerNewBtn')?.click();
  });
  renderLayers();
}

export function renderLayers(): void {
  if (!box) return;
  const list = document.getElementById('layerList');
  if (!list) return;
  list.replaceChildren();
  for (const name of knownLayers()) {
    const meta = ensureLayer(name);
    const count = state.markups.filter((m) => layerOf(m) === name).length;
    const row = document.createElement('div');
    row.className = 'layer-row' + (name === activeLayer ? ' active' : '') + (meta.locked ? ' locked' : '');
    const pick = document.createElement('button');
    pick.type = 'button'; pick.className = 'layer-pick'; pick.dataset.layerPick = name;
    pick.disabled = Boolean(meta.locked);
    pick.textContent = name;
    pick.title = meta.locked ? 'Layer is locked' : `Set "${name}" as the active layer`;
    const eye = document.createElement('button');
    eye.type = 'button'; eye.className = 'layer-action'; eye.dataset.layerEye = name;
    eye.textContent = hidden.has(name) ? '◌' : '◉';
    eye.title = hidden.has(name) ? 'Show layer' : 'Hide layer';
    const color = document.createElement('input');
    color.type = 'color'; color.className = 'layer-color'; color.dataset.layerColor = name;
    color.value = meta.color || '#64748b'; color.title = 'Default markup colour for this layer';
    const lock = document.createElement('button');
    lock.type = 'button'; lock.className = 'layer-action'; lock.dataset.layerLock = name;
    lock.textContent = meta.locked ? '🔒' : '🔓'; lock.title = meta.locked ? 'Unlock layer' : 'Lock layer';
    const rename = document.createElement('button');
    rename.type = 'button'; rename.className = 'layer-action'; rename.dataset.layerRename = name;
    rename.textContent = '✎'; rename.title = 'Rename layer'; rename.disabled = name === DEFAULT_LAYER;
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'layer-action danger'; del.dataset.layerDelete = name;
    del.textContent = '×'; del.title = 'Delete layer'; del.disabled = name === DEFAULT_LAYER;
    const up = document.createElement('button');
    up.type = 'button'; up.className = 'layer-action'; up.dataset.layerMove = name; up.dataset.direction = '-1';
    up.textContent = '↑'; up.title = 'Move layer up'; up.disabled = name === DEFAULT_LAYER || knownLayers().filter((item) => item !== DEFAULT_LAYER)[0] === name;
    const down = document.createElement('button');
    down.type = 'button'; down.className = 'layer-action'; down.dataset.layerMove = name; down.dataset.direction = '1';
    down.textContent = '↓'; down.title = 'Move layer down'; down.disabled = name === DEFAULT_LAYER || knownLayers().filter((item) => item !== DEFAULT_LAYER).at(-1) === name;
    const n = document.createElement('span'); n.className = 'layer-count'; n.textContent = String(count);
    row.append(eye, pick, color, lock, up, down, rename, del, n);
    list.appendChild(row);
  }
}
