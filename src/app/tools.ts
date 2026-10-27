// Tool state machine: calibrate, length, area, count, and selection.
// Click geometry comes in as SVG overlay events, converted to PDF space.

import { state, emit, nextId, type Pt, type Markup, type ScaleCheck, defaultLabel, distPt, calibrationForMarkup, metersPerPtForRatioOn, ratioOn } from './state';
import { openScanReview, isDoubtful } from './scanreview';
import { eventToView, viewToPdf, isTypingTarget, getPageTextItems, getPageVector, getPageAnnotations, getPdfDoc, getFillLayers } from './viewer';
import { fillMergesRooms, NOT_A_ROOM_NAME } from '../engine/cad-layers';
import { dimensionScale, shxWords, checkAgainstDimensions, type DimensionScale } from '../engine/dimensions';
import { doorBridgesFor } from '../engine/fill-vector';
import { renderMarkups, renderPreview, type PreviewSpec } from './render';
import { compareState } from './compare';
import { scanForSimilar } from '../engine/scan';
import { syncUpsertMarkup, syncDeleteMarkup, syncCalibration } from './session';
import { getActiveLayer, DEFAULT_LAYER } from './layers';
import { PRESET_SCALES as SCALES } from '../engine/units';
import { ocrPage, ocrCorridor } from './ocr';
import { findScaleRatio, nearestDimensionValue, roomLabelPoints, wordsFromTextItem } from '../engine/ocr';
import { scaleVotesFromWords, checkAgainstSheet, doorWidthCheck } from '../engine/scale';
import { dynamicFill, sheetDoorWidthPx, DOOR_CHECK_MAX_PX } from '../engine/dynamicfill';
import { renderRaster } from './raster';
import type { RasterPage } from '../engine/ports';
import { scanDeps } from './adapters';
import { parseLength, toMeters, PRESET_SCALES, METERS_PER_PT, type Unit } from '../engine/units';

export let onStatusHint: ((text: string) => void) | null = null;
export function setStatusHint(fn: (text: string) => void): void {
  onStatusHint = fn;
}

function hint(text: string): void {
  onStatusHint?.(text);
}

/** One-off hint from other modules (library, etc.). */
export function showHint(text: string): void {
  hint(text);
}

const HINTS: Record<string, string> = {
  pan: 'Drag to pan · Ctrl+wheel to zoom · click a markup to select it',
  calibrate: 'Click two ends of a known dimension to calibrate the scale',
  length: 'Click each vertex of the run · double-click or Enter to finish · Esc cancels',
  area: 'Click each corner of the area · double-click or Enter to finish · Esc cancels',
  count: 'Click to place a count mark · each click counts one item',
  perimeter: 'Click each corner of the boundary · double-click or Enter to close · Esc cancels',
  volume: 'Click each corner of the area · double-click or Enter to finish, then enter the depth',
  angle: 'Click the corner vertex, then one point on each ray',
  note: 'Click where the note belongs, then type the text in the list (rename)',
  fill: 'Click inside a room or slab — the fill reads its area off the walls',
  viewport: 'Outline a region drawn at a different scale (e.g. a 1:20 detail), then pick its scale',
  scan: 'Click one instance of a repeated symbol; the scan finds and counts every match on the page',
};

let svg: SVGSVGElement;
let draft: Pt[] = [];
let cursor: Pt | null = null;
let calibFirst: Pt | null = null;
let pendingCalib: { a: Pt; b: Pt } | null = null;

// Modal elements live in index.html
let calibModal: HTMLElement;
let calibDrawnText: HTMLElement;
let calibInput: HTMLInputElement;
let calibUnitSel: HTMLSelectElement;
let calibPresetSel: HTMLSelectElement;

export function initTools(overlay: SVGSVGElement): void {
  svg = overlay;
  calibModal = document.getElementById('calibModal')!;
  calibDrawnText = document.getElementById('calibDrawn')!;
  calibInput = document.getElementById('calibLength') as HTMLInputElement;
  calibUnitSel = document.getElementById('calibUnit') as HTMLSelectElement;
  calibPresetSel = document.getElementById('calibPreset') as HTMLSelectElement;

  calibPresetSel.replaceChildren(new Option('Or pick a standard scale…', ''));
  for (const p of PRESET_SCALES) calibPresetSel.add(new Option(p.label, String(p.ratio)));

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerleave', () => {
    cursor = null;
    refreshPreview();
  });
  svg.addEventListener('dblclick', onDoubleClick);
  window.addEventListener('keydown', onKeyDown);

  document.getElementById('calibCancel')?.addEventListener('click', closeCalibModal);
  document.getElementById('calibApply')?.addEventListener('click', applyCalibration);
  document.getElementById('depthCancel')?.addEventListener('click', closeDepthModal);
  document.getElementById('vpCancel')?.addEventListener('click', closeVpModal);
  document.getElementById('vpApply')?.addEventListener('click', applyViewport);
  document.getElementById('vpModal')?.addEventListener('pointerdown', (e) => {
    if (e.target === document.getElementById('vpModal')) closeVpModal();
  });
  document.getElementById('depthApply')?.addEventListener('click', applyDepth);
  document.getElementById('depthModal')?.addEventListener('pointerdown', (e) => {
    if (e.target === document.getElementById('depthModal')) closeDepthModal();
  });
  document.getElementById('depthInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyDepth();
    if (e.key === 'Escape') closeDepthModal();
  });
  calibModal.addEventListener('pointerdown', (e) => {
    if (e.target === calibModal) closeCalibModal();
  });
  calibInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCalibration();
  });
  document.getElementById('ocrReadBtn')?.addEventListener('click', () => void runOcrRead());

  calibPresetSel.addEventListener('change', () => {
    const ratio = parseFloat(calibPresetSel.value);
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const label = calibPresetSel.selectedOptions[0]?.label ?? `1:${ratio}`;
    if (!applyRatioToPages(ratio, `preset ${label}`)) {
      calibPresetSel.value = '';
      hint(NO_PAPER_HINT);
      return;
    }
    closeCalibModal();
    renderMarkups();
    emit();
    hint('Scale set · press L for length, A for area, N to count');
    void checkRatioAgainstDimensions(state.pageNum, ratio);
  });
}

export function setTool(tool: typeof state.tool): void {
  state.tool = tool;
  // manual tool switching drops an active preset unless the type still matches;
  // a count preset survives the scan tool so scan hits come out pre-labelled
  if (
    state.activePreset &&
    state.activePreset.type !== tool &&
    !(tool === 'scan' && state.activePreset.type === 'count')
  ) {
    state.activePreset = null;
  }
  draft = [];
  calibFirst = null;
  pendingCalib = null;
  svg.classList.toggle('drawing', tool !== 'pan');
  svg.style.cursor =
    tool === 'pan' ? 'grab' : tool === 'count' ? 'copy' : tool === 'scan' ? 'zoom-in' : 'crosshair';
  renderPreview(null);
  hint(HINTS[tool] ?? '');
  emit();
}

function eventToPdf(e: PointerEvent | MouseEvent): Pt | null {
  const v = eventToView(e);
  if (!v) return null;
  return viewToPdf(v);
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  if (e.target instanceof Element && e.target.closest('[data-id]') && state.tool === 'pan') {
    const g = e.target.closest('[data-id]')!;
    const id = g.getAttribute('data-id')!;
    const m = state.markups.find((x) => x.id === id);
    if (m) {
      state.selectedId = id;
      renderMarkups();
      emit();
      if (m.page === state.pageNum) {
        const vtx = e.target.closest('.vtx');
        beginDrag(m, vtx ? Number(vtx.getAttribute('data-idx')) : null, e);
      }
    }
    return;
  }
  const p = eventToPdf(e);
  if (!p) return;

  switch (state.tool) {
    case 'calibrate': {
      if (!calibFirst) {
        calibFirst = p;
        hint('Now click the other end of the known dimension');
      } else {
        pendingCalib = { a: calibFirst, b: p };
        calibFirst = null;
        openCalibModal();
      }
      refreshPreview();
      break;
    }
    case 'length':
    case 'area':
    case 'perimeter':
    case 'volume':
    case 'viewport':
      draft.push(p);
      refreshPreview();
      break;
    case 'angle':
      draft.push(p);
      if (draft.length === 3) finishDraft(); // vertex + two rays
      refreshPreview();
      break;
    case 'count': {
      const m: Markup = {
        id: nextId('mk'),
        page: state.pageNum,
        type: 'count',
        layer: getActiveLayer() !== DEFAULT_LAYER ? getActiveLayer() : undefined,
        label: state.activePreset?.type === 'count' ? state.activePreset.label : defaultLabel('count'),
        points: [p],
        createdAt: Date.now(),
      };
      state.markups.push(m);
      state.lastAction = null;
      syncUpsertMarkup(m);
      renderMarkups();
      emit();
      break;
    }
    case 'note': {
      const note: Markup = {
        id: nextId('mk'),
        page: state.pageNum,
        type: 'note',
        layer: getActiveLayer() !== DEFAULT_LAYER ? getActiveLayer() : undefined,
        label: state.activePreset?.type === 'note' ? state.activePreset.label : 'Note',
        points: [p],
        createdAt: Date.now(),
      };
      state.markups.push(note);
      state.lastAction = null;
      syncUpsertMarkup(note);
      renderMarkups();
      emit();
      hint('Note placed · type its text in the Label column of the list');
      break;
    }
    case 'fill':
      void runFill(p);
      break;
    case 'scan':
      void runScan(p);
      break;
    case 'pan':
      state.selectedId = null;
      renderMarkups();
      emit();
      break;
  }
}

/** Drag a whole markup, or one vertex when vtxIdx is given. Live value updates. */
function beginDrag(m: import('./state').Markup, vtxIdx: number | null, e: PointerEvent): void {
  const start = eventToPdf(e);
  if (!start) return;
  const before = m.points.map((p) => ({ ...p }));
  state.lastAction = { kind: 'move', id: m.id, before };
  const move = (ev: PointerEvent) => {
    const cur = eventToPdf(ev);
    if (!cur) return;
    if (vtxIdx != null && vtxIdx >= 0 && vtxIdx < m.points.length) {
      m.points[vtxIdx] = cur;
    } else {
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      m.points = before.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    renderMarkups();
    syncUpsertMarkup(m);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    renderMarkups();
    emit();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function onPointerMove(e: PointerEvent): void {
  if (state.tool === 'pan') return;
  cursor = eventToPdf(e);
  refreshPreview();
}

function onDoubleClick(e: MouseEvent): void {
  const p = eventToPdf(e);
  if (!p) return;
  if (state.tool === 'length' || state.tool === 'area' || state.tool === 'perimeter' || state.tool === 'volume' || state.tool === 'viewport') {
    // the second click of a double-click registers as a duplicate vertex
    if (draft.length >= 2 && distPt(draft[draft.length - 1], draft[draft.length - 2]) < 1) {
      draft.pop();
    }
    finishDraft();
  }
}

// The last page raster the fill used. The fill caches its page-wide state on
// the raster (dynamicfill), so reusing it for the next fill on the same page
// skips that work too; a new document or page just misses the cache.
let fillRaster: { doc: unknown; page: number; clean: boolean; raster: RasterPage } | null = null;

async function runFill(p: Pt): Promise<void> {
  hint('Filling…');
  const t0 = performance.now();
  try {
    // room labels, the scale at the click and vector doorway bridges let the
    // fill stop at doorways; page text and geometry are cached per page
    const doc = getPdfDoc();
    const page = state.pageNum;
    const [items, fillLayers] = await Promise.all([getPageTextItems(page).catch(() => []), getFillLayers()]);
    const labels = roomLabelPoints(items);
    const clickCal = calibrationForMarkup({ id: '', page, type: 'area', label: '', points: [p], createdAt: 0 });
    // CAD layers drawn over the floor (furniture, finish hatching, notes,
    // services, structure above) are left out of the fill's own render, so
    // they cannot stop it short of the walls; what you see is unchanged
    const fillOn = async (clean: boolean) => {
      const cached = fillRaster && fillRaster.doc === doc && fillRaster.page === page && fillRaster.clean === clean;
      const raster = cached ? fillRaster!.raster : await renderRaster(page, 3, clean ? fillLayers?.config : undefined);
      fillRaster = { doc, page, clean, raster };
      const vec = await getPageVector(page, clean).catch(() => null);
      const bridges = vec ? doorBridgesFor(vec, clickCal?.metersPerPt) : [];
      return dynamicFill(raster, p, undefined, { labels, bridges, ...(clickCal ? { metersPerPt: clickCal.metersPerPt } : {}) });
    };
    let result = await fillOn(!!fillLayers);
    // leaving those layers out can lose a door swing or jamb they carried:
    // when the fill then takes in two named rooms (or fails), fill on every layer
    if (fillLayers && ('error' in result || fillMergesRooms(result.points, roomLabelPoints(items, NOT_A_ROOM_NAME)))) {
      const full = await fillOn(false);
      if (!('error' in full) || 'error' in result) result = full;
    }
    if ('error' in result) {
      hint(result.error);
      return;
    }
    const m: Markup = {
      id: nextId('mk'),
      page: state.pageNum,
      type: 'area',
      layer: getActiveLayer() !== DEFAULT_LAYER ? getActiveLayer() : undefined,
      label: state.activePreset?.type === 'area' ? state.activePreset.label : 'Filled area',
      points: result.points,
      createdAt: Date.now(),
    };
    state.markups.push(m);
    state.lastAction = null;
    syncUpsertMarkup(m);
    setTool('pan');
    renderMarkups();
    emit();
    const cal = state.calibrations.get(state.pageNum);
    // say why the fill stopped where it did, so the polygon can be trusted or overridden
    const why: string[] = [];
    if (result.gapPx) {
      const gapPt = result.gapPx / 3; // rendered at 3 px/pt
      why.push(`closed a ${cal ? `${(gapPt * cal.metersPerPt).toFixed(2)} m` : `${gapPt.toFixed(0)} pt`} gap`);
    }
    if (result.bridged) why.push('vector doorway bridged');
    if (result.doorSource === 'sheet') why.push('door width read from this sheet');
    const because = why.length ? ` · ${why.join(', ')}` : '';
    if (cal) {
      hint(`Fill area added (${Math.round(performance.now() - t0)} ms)${because} · drag vertices to adjust`);
    } else {
      hint(`Fill area added${because} · calibrate the scale to see its value`);
    }
  } catch (err) {
    hint(`Fill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runScan(p: Pt): Promise<void> {
  const t0 = performance.now();
  const result = await scanForSimilar(state.pageNum, p, scanDeps);
  if ('error' in result) {
    hint(result.error);
    return;
  }
  const ms = Math.round(performance.now() - t0);
  const hits = result.hits;
  if (hits.length < 2) {
    hint(
      result.provider === 'detector'
        ? 'Detector found fewer than 2 symbols; click directly on a symbol type you want counted'
        : 'No repeats found; click a smaller, isolated symbol that repeats on the page',
    );
    return;
  }
  const fallbackLabel = state.activePreset?.type === 'count' ? state.activePreset.label : 'Scanned symbol';
  // review first: every hit is proposed as 'check' and the card asks a person
  const added: Markup[] = [];
  const doubtful = new Set<string>();
  let example: string | null = null;
  let nearest = Infinity;
  for (const hit of hits) {
    const scanned: Markup = {
      id: nextId('mk'),
      page: state.pageNum,
      type: 'count',
      layer: getActiveLayer() !== DEFAULT_LAYER ? getActiveLayer() : undefined,
      label: hit.label ?? fallbackLabel,
      points: [{ x: hit.x, y: hit.y }],
      createdAt: Date.now(),
      status: 'check',
    };
    state.markups.push(scanned);
    syncUpsertMarkup(scanned);
    added.push(scanned);
    if (isDoubtful(hit, result.provider)) doubtful.add(scanned.id);
    const d = Math.hypot(hit.x - p.x, hit.y - p.y);
    if (d < nearest) {
      nearest = d;
      example = scanned.id; // the one that was clicked gets the halo
    }
  }
  state.lastAction = null;
  setTool('pan');
  openScanReview(added, doubtful, ms, example);
  renderMarkups();
  emit();
  if ((hits[0].label ?? fallbackLabel) === 'Scanned symbol') hint(`Scan found ${hits.length} matches in ${ms} ms; click "Scanned symbol" on the card to name them`);
}

function finishDraft(): void {
  const min =
    state.tool === 'area' || state.tool === 'perimeter' || state.tool === 'volume' || state.tool === 'viewport' ? 3 : 2;
  if (state.tool === 'angle') {
    if (draft.length === 3) pushDraftMarkup('angle');
  } else if (draft.length >= min) {
    if (state.tool === 'volume') {
      pendingVolume = [...draft];
      draft = [];
      openDepthModal();
    } else if (state.tool === 'viewport') {
      pendingViewport = [...draft];
      draft = [];
      openVpModal();
    } else {
      pushDraftMarkup(state.tool as 'length' | 'area' | 'perimeter');
    }
  }
  draft = [];
  renderPreview(null);
  renderMarkups();
  emit();
}

function pushDraftMarkup(type: 'length' | 'area' | 'perimeter' | 'volume' | 'angle', depth?: number): void {
  state.markups.push({
    id: nextId('mk'),
    page: state.pageNum,
    type,
    label: state.activePreset?.type === type ? state.activePreset.label : defaultLabel(type),
    points: [...draft],
    createdAt: Date.now(),
    ...(depth !== undefined ? { depth } : {}),
    ...(getActiveLayer() !== DEFAULT_LAYER ? { layer: getActiveLayer() } : {}),
  });
  state.lastAction = null;
  syncUpsertMarkup(state.markups[state.markups.length - 1]);
}

function refreshPreview(): void {
  let spec: PreviewSpec | null = null;
  if (state.tool === 'viewport') {
    if (draft.length > 0) spec = { kind: 'area', points: draft, cursor };
  } else if (state.tool === 'length' || state.tool === 'area' || state.tool === 'perimeter' || state.tool === 'volume' || state.tool === 'angle') {
    if (draft.length > 0) spec = { kind: state.tool, points: draft, cursor };
  } else if (state.tool === 'calibrate' && calibFirst) {
    spec = { kind: 'calibrate', points: [calibFirst], cursor };
  }
  renderPreview(spec);
}

// --- calibration modal ---

function openCalibModal(): void {
  if (!pendingCalib) return;
  const paperMm = distPt(pendingCalib.a, pendingCalib.b) * (25.4 / 72);
  calibDrawnText.textContent = `You drew ${paperMm.toFixed(1)} mm on paper.`;
  calibInput.value = '';
  calibPresetSel.value = '';
  calibModal.classList.remove('hidden');
  calibUnitSel.value = state.displayUnit === 'ft-in' ? 'ft' : (state.displayUnit as Unit);
  calibInput.focus();
}

function closeCalibModal(): void {
  calibModal.classList.add('hidden');
  pendingCalib = null;
}

/** The pages a scale applies to: the current one, or every page when "all pages" is checked. */
function scalePages(): number[] {
  const all = (document.getElementById('calibAllPages') as HTMLInputElement | null)?.checked;
  return all ? Array.from({ length: state.pageCount }, (_, i) => i + 1) : [state.pageNum];
}

/** Set the scale on the current page, or every page when "all pages" is checked. */
function applyScaleToPages(metersPerPt: number, source: string): void {
  for (const p of scalePages()) {
    state.calibrations.set(p, { metersPerPt, source });
    state.scaleChecks.delete(p); // a new scale needs checking afresh
    syncCalibration(p, { metersPerPt, source });
  }
}

const NO_PAPER_HINT =
  "This page is an image that doesn't say how big its paper was, so a ratio like 1:100 can't be used. Click both ends of a dimension you know and type its length.";

/**
 * Set a printed ratio (1:100) on the current page or every page. Each page
 * converts it through its own paper size; image pages without one are
 * skipped. False when the current page is one of those (nothing applied there).
 */
function applyRatioToPages(ratio: number, source: string): boolean {
  let current = false;
  for (const p of scalePages()) {
    const metersPerPt = metersPerPtForRatioOn(p, ratio);
    if (metersPerPt === null) continue;
    state.calibrations.set(p, { metersPerPt, source });
    state.scaleChecks.delete(p);
    syncCalibration(p, { metersPerPt, source });
    if (p === state.pageNum) current = true;
  }
  return current;
}

// --- volume depth modal ---

let pendingVolume: Pt[] | null = null;
let depthModal: HTMLElement;
let depthInput: HTMLInputElement;
let depthUnitSel: HTMLSelectElement;

function openDepthModal(): void {
  depthModal = document.getElementById('depthModal')!;
  depthInput = document.getElementById('depthInput') as HTMLInputElement;
  depthUnitSel = document.getElementById('depthUnit') as HTMLSelectElement;
  depthInput.value = '';
  depthUnitSel.value = state.displayUnit === 'ft-in' ? 'ft' : (state.displayUnit as Unit);
  depthModal.classList.remove('hidden');
  depthInput.focus();
}

function closeDepthModal(): void {
  depthModal.classList.add('hidden');
  pendingVolume = null;
}

function applyDepth(): void {
  if (!pendingVolume) return closeDepthModal();
  const unit = depthUnitSel.value as Unit;
  const value = parseLength(depthInput.value, unit);
  if (value == null) {
    depthInput.classList.add('invalid');
    setTimeout(() => depthInput.classList.remove('invalid'), 600);
    return;
  }
  const depth = toMeters(value, unit);
  const points = pendingVolume;
  pendingVolume = null;
  depthModal.classList.add('hidden');
  draft = points; // reuse pushDraftMarkup against the stashed polygon
  pushDraftMarkup('volume', depth);
  draft = [];
  setTool('pan');
  hint('Volume added · switch units any time in the toolbar');
}

/** OCR the sheet and either apply a title-block ratio or pre-fill the clicked dimension's value. */
async function runOcrRead(): Promise<void> {
  const btn = document.getElementById('ocrReadBtn') as HTMLButtonElement;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading… (first run fetches the OCR pack)';
  try {
    // with a clicked dimension, a rotated corridor crop along it is the most
    // direct read: upright text, no line work, a fraction of the area to scan
    if (pendingCalib) {
      const corridor = await ocrCorridor(state.pageNum, pendingCalib.a, pendingCalib.b);
      const dim = nearestDimensionValue(corridor, pendingCalib.a, pendingCalib.b);
      if (dim) {
        calibInput.value = String(dim.value);
        calibUnitSel.value = dim.unit;
        calibInput.classList.remove('invalid');
        hint(`Read "${dim.text}" next to your dimension — check it, then Apply scale`);
        return;
      }
    }

    const words = await ocrPage(state.pageNum);
    const scaleHit = findScaleRatio(words);

    // with a clicked dimension, its printed label is the most direct answer
    if (pendingCalib) {
      const dim = nearestDimensionValue(words, pendingCalib.a, pendingCalib.b);
      if (dim) {
        calibInput.value = String(dim.value);
        calibUnitSel.value = dim.unit;
        calibInput.classList.remove('invalid');
        hint(`Read "${dim.text}" next to your dimension — check it, then Apply scale`);
        return;
      }
    }
    // the sheet's printed dimensions outvote a title block they clearly disagree with
    const witness = await dimensionWitness(state.pageNum);
    const titleWrong = scaleHit && witness ? checkAgainstDimensions(scaleHit.ratio, witness.dims, scaleHit.ratio).status === 'disagrees' : false;
    const drawn = witness?.dims.ratio;
    if (drawn !== undefined && (!scaleHit || titleWrong)) {
      if (applyRatioToPages(drawn, `printed dimensions 1:${drawn} (${witness!.dims.support} of ${witness!.dims.total} agree)`)) {
        const note = scaleHit ? `The title block says 1:${scaleHit.ratio}, but this sheet's printed dimensions are drawn at 1:${drawn}.` : undefined;
        state.scaleChecks.set(state.pageNum, { status: 'dims-ok', message: note });
        closeCalibModal();
        renderMarkups();
        emit();
        hint(`Scale 1:${drawn} read from the sheet's printed dimensions${note ? `. ${note}` : ''} · press L to measure`);
        return;
      }
    }
    if (scaleHit) {
      if (!applyRatioToPages(scaleHit.ratio, `${scaleHit.source} (sheet)`)) {
        hint(`The sheet says 1:${scaleHit.ratio}, but this page is an image without a paper size. Click both ends of a dimension you know and type its length.`);
        return;
      }
      closeCalibModal();
      renderMarkups();
      emit();
      hint(`Scale 1:${scaleHit.ratio} read from the sheet · press L to measure`);
      void checkRatioAgainstDimensions(state.pageNum, scaleHit.ratio);
      return;
    }
    hint('Could not read a scale or dimension from this sheet — type the length manually');
  } catch {
    hint('OCR failed — the first run needs internet to fetch the language pack');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// --- viewport scale modal ---

let pendingViewport: Pt[] | null = null;
let vpModal: HTMLElement;
let vpPresetSel: HTMLSelectElement;

function openVpModal(): void {
  vpModal = document.getElementById('vpModal')!;
  vpPresetSel = document.getElementById('vpPreset') as HTMLSelectElement;
  vpPresetSel.replaceChildren(new Option('Pick the region\'s scale…', ''));
  for (const p of SCALES) vpPresetSel.add(new Option(p.label, String(p.ratio)));
  vpModal.classList.remove('hidden');
  vpPresetSel.focus();
}

function closeVpModal(): void {
  vpModal.classList.add('hidden');
  pendingViewport = null;
}

function applyViewport(): void {
  if (!pendingViewport) return closeVpModal();
  const ratio = parseFloat(vpPresetSel.value);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    vpPresetSel.classList.add('invalid');
    setTimeout(() => vpPresetSel.classList.remove('invalid'), 600);
    return;
  }
  const label = vpPresetSel.selectedOptions[0]?.label ?? `1:${Math.round(ratio)}`;
  const metersPerPt = metersPerPtForRatioOn(state.pageNum, ratio);
  if (metersPerPt === null) {
    hint(NO_PAPER_HINT);
    return;
  }
  state.viewports.push({
    id: nextId('vp'),
    page: state.pageNum,
    points: pendingViewport.map((p) => ({ ...p })),
    metersPerPt,
    source: `viewport ${label}`,
  });
  pendingViewport = null;
  vpModal.classList.add('hidden');
  setTool('pan');
  renderMarkups();
  emit();
  hint(`Viewport ${label} set · measurements inside it use this scale`);
}

function applyCalibration(): void {
  if (!pendingCalib) return closeCalibModal();
  const unit = calibUnitSel.value as Unit;
  const value = parseLength(calibInput.value, unit);
  if (value == null) {
    calibInput.classList.add('invalid');
    setTimeout(() => calibInput.classList.remove('invalid'), 600);
    return;
  }
  const ptDist = distPt(pendingCalib.a, pendingCalib.b);
  const meters = toMeters(value, unit);
  const metersPerPt = meters / ptDist;
  applyScaleToPages(metersPerPt, `measured ${calibInput.value.trim()} ${unit}`);
  closeCalibModal();
  renderMarkups();
  emit();
  hint('Scale set · press L for length, A for area, N to count');
  void warnIfSheetDisagrees(state.pageNum, metersPerPt);
}

/** The sheet's printed dimensions as a scale witness, with the words read (CAD sheets; null on images). */
async function dimensionWitness(page: number): Promise<{ dims: DimensionScale; printed?: number } | null> {
  try {
    const [items, annots, vec] = await Promise.all([getPageTextItems(page), getPageAnnotations(page), getPageVector(page)]);
    if (!vec || !vec.segs.length) return null;
    const words = [...items.flatMap((it) => wordsFromTextItem(it.str ?? '', it.transform, it.width, it.height)), ...shxWords(annots as never)];
    return { dims: dimensionScale(words, vec), printed: findScaleRatio(words)?.ratio };
  } catch {
    return null;
  }
}

/** After a printed ratio is set (a preset, the title block): do the sheet's own dimensions agree? */
async function checkRatioAgainstDimensions(page: number, ratio: number): Promise<void> {
  const metersPerPt = state.calibrations.get(page)?.metersPerPt;
  const witness = await dimensionWitness(page);
  if (!witness || state.calibrations.get(page)?.metersPerPt !== metersPerPt) return;
  const d = checkAgainstDimensions(ratio, witness.dims, witness.printed);
  if (d.status === 'unknown') return;
  state.scaleChecks.set(page, d.status === 'agrees' ? { status: 'dims-ok' } : { status: 'disagrees', message: d.message });
  emit();
  if (d.status === 'disagrees') hint(d.message!);
}

/**
 * Compare a measured scale with the sheet's printed dimensions, its printed
 * scale, and its own doorways (which should measure like doors); hint on a
 * mismatch.
 */
async function warnIfSheetDisagrees(page: number, metersPerPt: number): Promise<void> {
  const items = await getPageTextItems(page).catch(() => []);
  const words = items.flatMap((it) => wordsFromTextItem(it.str ?? '', it.transform, it.width, it.height));
  const { votes, nts } = scaleVotesFromWords(words, 'text layer');
  // the printed ratio needs the paper size; an image page without one skips
  // straight to the doorway check, which only needs pixels and metres
  const paperRatio = ratioOn(page, metersPerPt);
  const measured = paperRatio ?? metersPerPt / METERS_PER_PT;
  const c: ReturnType<typeof checkAgainstSheet> = paperRatio === null ? { status: 'none' } : checkAgainstSheet(measured, votes, nts);
  // what the check found also drives the scale chip (unless the scale changed meanwhile)
  const record = (check: ScaleCheck | null) => {
    if (state.calibrations.get(page)?.metersPerPt !== metersPerPt) return;
    if (check) state.scaleChecks.set(page, check);
    else state.scaleChecks.delete(page);
    emit();
  };
  // the sheet's printed dimensions are the strongest witness on a CAD sheet:
  // they can show the title block, not the clicked dimension, is wrong
  const witness = paperRatio === null ? null : await dimensionWitness(page);
  if (witness) {
    const d = checkAgainstDimensions(measured, witness.dims, c.sheetRatio);
    if (d.status === 'agrees') {
      const note = c.status === 'disagrees' && c.sheetRatio !== undefined ? `Your scale matches this sheet's printed dimensions (1:${d.drawnRatio}). The title block's 1:${Math.round(c.sheetRatio)} is wrong for this sheet.` : undefined;
      record({ status: 'dims-ok', message: note });
      if (note) hint(note);
      return;
    }
    if (d.status === 'disagrees') {
      record({ status: 'disagrees', message: d.message });
      hint(d.message!);
      return;
    }
  }
  if (c.status === 'disagrees' && c.sheetRatio !== undefined) {
    const why = c.likely ? `, likely ${c.likely}` : '';
    const message = `Scale set to about 1:${Math.round(measured)}, but the sheet says 1:${Math.round(c.sheetRatio)}${why}. Check the dimension you used.`;
    record({ status: 'disagrees', message });
    hint(message);
    return;
  }
  if (c.status === 'agrees') {
    record({ status: 'agrees' }); // the printed scale is the stronger witness
    return;
  }
  // no printed scale to lean on (scans): do the doors come out door-sized?
  // (sheets larger than A1 are not checked: the pass would take seconds, so
  // the size is read from the page before anything is rendered)
  const doc = getPdfDoc();
  if (!doc) return;
  const vp = (await doc.getPage(page)).getViewport({ scale: 3 });
  if (vp.width * vp.height > DOOR_CHECK_MAX_PX) return;
  const raster = await renderRaster(page, 3).catch(() => null);
  if (!raster) return;
  const doors = doorWidthCheck(metersPerPt, sheetDoorWidthPx(raster), 3);
  if (!doors) return;
  if (doors.status === 'plausible') {
    record({ status: 'doors-ok' });
    return;
  }
  const why = doors.likely ? `, likely ${doors.likely}` : '';
  const message = `Scale set to about 1:${Math.round(measured)}, which makes this sheet's doorways ${doors.impliedDoorM.toFixed(2)} m wide${why}. Check the dimension you used.`;
  record({ status: 'doors-bad', message });
  hint(message);
}

// --- keyboard ---

function onKeyDown(e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return;
  const depthM = document.getElementById('depthModal');
  const vpM = document.getElementById('vpModal');
  if (!calibModal.classList.contains('hidden') || !depthM?.classList.contains('hidden') || !vpM?.classList.contains('hidden')) {
    if (e.key === 'Escape') {
      closeCalibModal();
      closeDepthModal();
    }
    return;
  }

  const toolKeys: Record<string, typeof state.tool> = {
    v: 'pan',
    c: 'calibrate',
    l: 'length',
    a: 'area',
    n: 'count',
    p: 'perimeter',
    o: 'volume',
    g: 'angle',
    t: 'note',
    d: 'fill',
    w: 'viewport',
    s: 'scan',
  };
  const k = e.key.toLowerCase();

  if (k === 'escape') {
    if (draft.length || calibFirst) {
      draft = [];
      calibFirst = null;
      renderPreview(null);
      hint(HINTS[state.tool]);
    } else if (state.selectedId) {
      state.selectedId = null;
      renderMarkups();
      emit();
    }
    return;
  }
  if (k === 'enter') {
    if (draft.length) finishDraft();
    return;
  }
  if (k === 'backspace') {
    if (draft.length) {
      draft.pop();
      refreshPreview();
      return; // don't delete a selected markup while drawing
    }
  }
  if ((k === 'delete' || k === 'backspace') && state.selectedId) {
    const deleted = state.selectedId;
    state.markups = state.markups.filter((m) => m.id !== state.selectedId);
    state.selectedId = null;
    if (deleted) syncDeleteMarkup(deleted);
    renderMarkups();
    emit();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && k === 'z') {
    e.preventDefault();
    if (draft.length) {
      draft.pop();
      refreshPreview();
    } else if (state.lastAction?.kind === 'move') {
      const moved = state.markups.find((x) => x.id === state.lastAction!.id);
      if (moved) {
        moved.points = state.lastAction.before;
        state.lastAction = null;
        syncUpsertMarkup(moved);
        renderMarkups();
        emit();
        return;
      }
    }
    if (state.markups.length) {
      const newest = state.markups.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      state.markups = state.markups.filter((m) => m.id !== newest.id);
      if (state.selectedId === newest.id) state.selectedId = null;
      syncDeleteMarkup(newest.id);
      renderMarkups();
      emit();
    }
    return;
  }
  if (toolKeys[k] && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (compareState.active && k !== 'v') return; // measuring is paused during compare
    setTool(toolKeys[k]);
  }
}
