// Tool state machine: calibrate, length, area, count, and selection.
// Click geometry comes in as SVG overlay events, converted to PDF space.

import { state, emit, nextId, type Pt, type Markup, type ScaleCheck, defaultLabel, distPt, calibrationForMarkup, freezeMarkupCalibration, metersPerPtForRatioOn, ratioOn } from './state';
import { openScanReview, isDoubtful } from './scanreview';
import { eventToView, viewToPdf, pdfToView, isTypingTarget, getPageTextItems, getPageVector, getPageAnnotations, getPdfDoc, getFillLayers, previewLayer } from './viewer';
import type { VecSeg } from '../engine/vector';
import { fillMergesRooms, NOT_A_ROOM_NAME } from '../engine/cad-layers';
import { dimensionScale, shxWords, checkAgainstDimensions, type DimensionScale } from '../engine/dimensions';
import { doorBridgesFor } from '../engine/fill-vector';
import { renderMarkups, renderPreview, type PreviewSpec } from './render';
import { compareState } from './compare';
import { scanForSimilar } from '../engine/scan';
import { syncUpsertMarkup, syncDeleteMarkup, syncCalibration } from './session';
import { getActiveLayer, DEFAULT_LAYER, isLockedLayer, layerOf } from './layers';
import { PRESET_SCALES as SCALES } from '../engine/units';
import { ocrPage, ocrCorridor } from './ocr';
import { findScaleRatio, nearestDimensionValue, roomLabelPoints, wordsFromTextItem } from '../engine/ocr';
import { scaleVotesFromWords, checkAgainstSheet, doorWidthCheck } from '../engine/scale';
import { dynamicFill, sheetDoorWidthPx, DOOR_CHECK_MAX_PX } from '../engine/dynamicfill';
import { renderRaster } from './raster';
import type { RasterPage } from '../engine/ports';
import { scanDeps } from './adapters';
import { parseLength, toMeters, formatLength, PRESET_SCALES, METERS_PER_PT, type Unit } from '../engine/units';

export let onStatusHint: ((text: string) => void) | null = null;
export function setStatusHint(fn: (text: string) => void): void {
  onStatusHint = fn;
}

function hint(text: string): void {
  onStatusHint?.(text);
}

type HistorySnapshot = {
  markups: Markup[];
  annotations: import('../engine/types').DrawingAnnotation[];
  calibrations: Map<number, import('./state').Calibration>;
  viewports: import('../engine/viewports').Viewport[];
};
const undoStack: HistorySnapshot[] = [];
const redoStack: HistorySnapshot[] = [];
const HISTORY_LIMIT = 100;

function snapshotTakeoff(): HistorySnapshot {
  return {
    markups: structuredClone(state.markups),
    annotations: structuredClone(state.annotations),
    calibrations: new Map([...state.calibrations].map(([page, cal]) => [page, { ...cal }])),
    viewports: structuredClone(state.viewports),
  };
}
export function recordTakeoffHistory(): void {
  recordHistory();
}

/** A new or closed project starts with an empty undo/redo history. */
export function clearTakeoffHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  state.lastAction = null;
  updateHistoryButtons();
}

function recordHistory(): void {
  undoStack.push(snapshotTakeoff());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}
function updateHistoryButtons(): void {
  const undo = document.getElementById('undoBtn') as HTMLButtonElement | null;
  const redo = document.getElementById('redoBtn') as HTMLButtonElement | null;
  if (undo) undo.disabled = undoStack.length === 0;
  if (redo) redo.disabled = redoStack.length === 0;
}
function restoreHistory(target: HistorySnapshot): void {
  const previous = new Map(state.markups.map((m) => [m.id, m]));
  const next = new Map(target.markups.map((m) => [m.id, m]));
  for (const id of previous.keys()) if (!next.has(id)) syncDeleteMarkup(id);
  state.markups = structuredClone(target.markups);
  state.annotations = structuredClone(target.annotations);
  for (const m of state.markups) syncUpsertMarkup(m);
  const pages = new Set([...state.calibrations.keys(), ...target.calibrations.keys()]);
  state.calibrations = new Map([...target.calibrations].map(([p, c]) => [p, { ...c }]));
  for (const page of pages) syncCalibration(page, state.calibrations.get(page) ?? null);
  state.viewports = structuredClone(target.viewports);
  state.lastAction = null;
  state.selectedId = null;
  renderMarkups();
  emit();
  updateHistoryButtons();
}
function undoTakeoff(): void {
  const previous = undoStack.pop();
  if (!previous) { hint('Nothing to undo'); return; }
  redoStack.push(snapshotTakeoff());
  restoreHistory(previous);
  hint('Undo');
}
function redoTakeoff(): void {
  const next = redoStack.pop();
  if (!next) { hint('Nothing to redo'); return; }
  undoStack.push(snapshotTakeoff());
  restoreHistory(next);
  hint('Redo');
}

/** One-off hint from other modules (library, etc.). */
export function showHint(text: string): void {
  hint(text);
}

const HINTS: Record<string, string> = {
  pan: 'Select mode · click a markup to select it · drag nodes to refine · double-click a segment to insert a node · drag the sheet to pan · wheel to zoom',
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
  'annot-line': 'Drag to draw a non-measurement line',
  'annot-arrow': 'Drag to draw a non-measurement arrow',
  'annot-rectangle': 'Drag to draw a rectangle annotation',
  'annot-ellipse': 'Drag to draw an ellipse annotation',
  'annot-highlight': 'Drag to highlight a drawing region',
  'annot-cloud': 'Drag to draw a revision cloud',
  'annot-text': 'Click to place a text annotation',
};

let svg: SVGSVGElement;
let loupeRoot: HTMLElement | null = null;
let loupeViewport: HTMLElement | null = null;
let loupeRaster: HTMLCanvasElement | null = null;
let loupeContent: HTMLElement | null = null;
let loupeEnabled = false;
let loupePointer = { x: 0, y: 0, valid: false };
let loupeOffset = { x: 28, y: 28 };
let loupeDragging = false;
let loupeDragStart = { x: 0, y: 0, offsetX: 28, offsetY: 28 };
let loupeFrame = 0;
let loupePending = { x: 0, y: 0 };
const LOUPE_MAGNIFICATION = 2.5;
let draft: Pt[] = [];
let selectedVertex: { markupId: string; index: number } | null = null;
let cursor: Pt | null = null;
let calibFirst: Pt | null = null;
let pendingCalib: { a: Pt; b: Pt } | null = null;

// Modal elements live in index.html
let calibModal: HTMLElement;
let calibDrawnText: HTMLElement;
let calibInput: HTMLInputElement;
let calibUnitSel: HTMLSelectElement;
let calibPresetSel: HTMLSelectElement;

let snapEnabled = true;
let snapPage = 0;
let snapSegments: VecSeg[] = [];
let snapGrid = new Map<string, VecSeg[]>();
let longSnapSegments: VecSeg[] = [];
let snapPromise: Promise<VecSeg[]> | null = null;
const SNAP_GRID_SIZE = 128;
const snapCellKey = (x: number, y: number) => `${x},${y}`;
let snapPoint: { x: number; y: number; kind: string } | null = null;

async function loadSnapSegments(page: number): Promise<VecSeg[]> {
  if (snapPage === page && snapSegments.length) return snapSegments;
  if (snapPromise && snapPage === page) return snapPromise;
  snapPage = page;
  snapPromise = getPageVector(page).then((vec) => {
    const segs = vec?.segs ?? [];
    // A safety ceiling avoids making pointer interaction unresponsive on unusually
    // complex vector sheets. No geometry is changed or discarded from the PDF.
    const usable = segs.length <= 250000 ? segs : [];
    if (snapPage === page) {
      snapSegments = usable;
      snapGrid = new Map();
      longSnapSegments = [];
      for (const seg of usable) {
        const x0 = Math.floor(Math.min(seg.x1, seg.x2) / SNAP_GRID_SIZE);
        const x1 = Math.floor(Math.max(seg.x1, seg.x2) / SNAP_GRID_SIZE);
        const y0 = Math.floor(Math.min(seg.y1, seg.y2) / SNAP_GRID_SIZE);
        const y1 = Math.floor(Math.max(seg.y1, seg.y2) / SNAP_GRID_SIZE);
        const cells = (x1 - x0 + 1) * (y1 - y0 + 1);
        if (cells > 64) {
          longSnapSegments.push(seg);
          continue;
        }
        for (let gx = x0; gx <= x1; gx++) {
          for (let gy = y0; gy <= y1; gy++) {
            const key = snapCellKey(gx, gy);
            const bucket = snapGrid.get(key);
            if (bucket) bucket.push(seg);
            else snapGrid.set(key, [seg]);
          }
        }
      }
    }
    return usable;
  }).catch(() => {
    if (snapPage === page) {
      snapSegments = [];
      snapGrid.clear();
      longSnapSegments = [];
    }
    return [];
  });
  return snapPromise;
}

function projectToSegment(p: Pt, s: VecSeg): { point: Pt; distance: number } {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2)) : 0;
  const point = { x: s.x1 + t * dx, y: s.y1 + t * dy };
  return { point, distance: Math.hypot(p.x - point.x, p.y - point.y) };
}

function segmentIntersection(a: VecSeg, b: VecSeg): Pt | null {
  const rx = a.x2 - a.x1, ry = a.y2 - a.y1;
  const sx = b.x2 - b.x1, sy = b.y2 - b.y1;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = b.x1 - a.x1, qy = b.y1 - a.y1;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x1 + t * rx, y: a.y1 + t * ry };
}

function snapPdfPoint(p: Pt): { point: Pt; kind: string } | null {
  if (!snapEnabled || !snapSegments.length) return null;
  const tolerance = 10 / Math.max(0.05, state.zoom);
  const tol2 = tolerance * tolerance;
  const best: { current: { point: Pt; kind: string; d2: number } | null } = { current: null };
  const nearby: VecSeg[] = [];
  const candidates = new Set<VecSeg>(longSnapSegments);
  const gx0 = Math.floor((p.x - tolerance) / SNAP_GRID_SIZE);
  const gx1 = Math.floor((p.x + tolerance) / SNAP_GRID_SIZE);
  const gy0 = Math.floor((p.y - tolerance) / SNAP_GRID_SIZE);
  const gy1 = Math.floor((p.y + tolerance) / SNAP_GRID_SIZE);
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      for (const seg of snapGrid.get(snapCellKey(gx, gy)) ?? []) candidates.add(seg);
    }
  }
  const offer = (point: Pt, kind: string) => {
    const dx = point.x - p.x, dy = point.y - p.y, d2 = dx * dx + dy * dy;
    if (d2 <= tol2 && (!best.current || d2 < best.current.d2)) best.current = { point, kind, d2 };
  };
  for (const s of candidates) {
    const a = { x: s.x1, y: s.y1 }, b = { x: s.x2, y: s.y2 };
    offer(a, 'Endpoint'); offer(b, 'Endpoint');
    offer({ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }, 'Midpoint');
    const projected = projectToSegment(p, s);
    if (projected.distance <= tolerance * 1.5) {
      if (nearby.length < 48) nearby.push(s);
      offer(projected.point, 'Nearest');
    }
  }
  // Intersections are tested only among segments already close to the cursor,
  // rather than comparing every pair on the entire drawing.
  const local = nearby.slice(0, 48);
  for (let i = 0; i < local.length; i++) {
    for (let j = i + 1; j < local.length; j++) {
      const hit = segmentIntersection(local[i], local[j]);
      if (hit) offer(hit, 'Intersection');
    }
  }
  return best.current ? { point: best.current.point, kind: best.current.kind } : null;
}

function updateSnapToggle(): void {
  const button = document.getElementById('snapToggle');
  if (!button) return;
  button.classList.toggle('active', snapEnabled);
  button.setAttribute('aria-pressed', String(snapEnabled));
  button.title = snapEnabled ? 'Object snapping on' : 'Object snapping off';
}

function drawSnapMarker(): void {
  if (!snapPoint) return;
  // Convert PDF coordinates through the shared viewer transform.
  const p = pdfToView(snapPoint);
  const ns = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(ns, 'g');
  const invZoom = 1 / Math.max(0.05, state.zoom);
  g.setAttribute('class', 'snap-marker');
  g.setAttribute('transform', `translate(${p.x} ${p.y})`);
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('r', String(3.5 * invZoom)); c.setAttribute('fill', '#ffffff');
  c.setAttribute('stroke', '#00a6a0'); c.setAttribute('stroke-width', String(1.6 * invZoom));
  const h = document.createElementNS(ns, 'path');
  h.setAttribute('d', `M${-5.5 * invZoom} 0H${5.5 * invZoom}M0 ${-5.5 * invZoom}V${5.5 * invZoom}`); h.setAttribute('stroke', '#00a6a0'); h.setAttribute('stroke-width', String(invZoom));
  const label = document.createElementNS(ns, 'text');
  label.setAttribute('x', String(9 * invZoom)); label.setAttribute('y', String(-8 * invZoom));
  label.setAttribute('font-size', String(7 * invZoom)); label.setAttribute('font-weight', '700');
  label.setAttribute('fill', '#007f79'); label.setAttribute('stroke', '#ffffff');
  label.setAttribute('stroke-width', String(2.5 * invZoom)); label.setAttribute('paint-order', 'stroke');
  label.textContent = snapPoint.kind === 'Endpoint' ? 'END' : snapPoint.kind === 'Midpoint' ? 'MID' : snapPoint.kind === 'Intersection' ? 'INT' : 'NEAR';
  g.append(c,h,label); previewLayer.appendChild(g);
}

function positionLoupe(): void {
  if (!loupeRoot || !loupePointer.valid) return;
  const width = loupeRoot.offsetWidth || 360;
  const height = loupeRoot.offsetHeight || 252;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, loupePointer.x + loupeOffset.x));
  const top = Math.max(8, Math.min(window.innerHeight - height - 8, loupePointer.y + loupeOffset.y));
  loupeRoot.style.left = `${left}px`;
  loupeRoot.style.top = `${top}px`;
}

/** Copy the live page canvas and SVG overlay into a movable, magnified window. */
function refreshLoupe(clientX: number, clientY: number): void {
  if (!loupeEnabled || !loupeRoot || !loupeContent || !loupeViewport) return;
  const page = svg.parentElement;
  const sourceCanvas = document.getElementById('pdfCanvas') as HTMLCanvasElement | null;
  if (!page || !sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) return;
  const rect = page.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const width = page.clientWidth;
  const height = page.clientHeight;
  if (x < 0 || y < 0 || x > width || y > height || !width || !height) return;
  loupePointer = { x: clientX, y: clientY, valid: true };

  const viewWidth = loupeViewport.clientWidth;
  const viewHeight = loupeViewport.clientHeight;
  if (!loupeRaster || !viewWidth || !viewHeight) return;
  const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const outputWidth = Math.round(viewWidth * outputScale);
  const outputHeight = Math.round(viewHeight * outputScale);
  if (loupeRaster.width !== outputWidth || loupeRaster.height !== outputHeight) {
    loupeRaster.width = outputWidth;
    loupeRaster.height = outputHeight;
  }
  const context = loupeRaster.getContext('2d');
  if (context) {
    context.clearRect(0, 0, outputWidth, outputHeight);
    const sourceX = x * sourceCanvas.width / width;
    const sourceY = y * sourceCanvas.height / height;
    const cropWidth = viewWidth / LOUPE_MAGNIFICATION * sourceCanvas.width / width;
    const cropHeight = viewHeight / LOUPE_MAGNIFICATION * sourceCanvas.height / height;
    const sx = sourceX - cropWidth / 2;
    const sy = sourceY - cropHeight / 2;
    context.filter = getComputedStyle(sourceCanvas).filter;
    context.drawImage(sourceCanvas, sx, sy, cropWidth, cropHeight, 0, 0, outputWidth, outputHeight);
    const fxSource = document.getElementById('fxCanvas') as HTMLCanvasElement | null;
    if (fxSource && fxSource.width && fxSource.height) {
      const fxX = x * fxSource.width / width;
      const fxY = y * fxSource.height / height;
      const fxW = viewWidth / LOUPE_MAGNIFICATION * fxSource.width / width;
      const fxH = viewHeight / LOUPE_MAGNIFICATION * fxSource.height / height;
      context.filter = 'none';
      context.drawImage(fxSource, fxX - fxW / 2, fxY - fxH / 2, fxW, fxH, 0, 0, outputWidth, outputHeight);
    }
    context.filter = 'none';
  }

  let overlayCopy = loupeContent.querySelector<SVGSVGElement>('svg[data-loupe-overlay]');
  if (!overlayCopy) {
    overlayCopy = svg.cloneNode(false) as SVGSVGElement;
    overlayCopy.removeAttribute('id');
    overlayCopy.dataset.loupeOverlay = 'true';
    loupeContent.appendChild(overlayCopy);
  }
  overlayCopy.setAttribute('viewBox', svg.getAttribute('viewBox') ?? `0 0 ${width} ${height}`);
  overlayCopy.setAttribute('preserveAspectRatio', svg.getAttribute('preserveAspectRatio') ?? 'none');
  overlayCopy.setAttribute('class', svg.getAttribute('class') ?? '');
  overlayCopy.innerHTML = svg.innerHTML;
  overlayCopy.style.width = `${width}px`;
  overlayCopy.style.height = `${height}px`;

  loupeContent.style.width = `${width}px`;
  loupeContent.style.height = `${height}px`;
  const centerX = loupeViewport.clientWidth / 2;
  const centerY = loupeViewport.clientHeight / 2;
  const tx = centerX - x * LOUPE_MAGNIFICATION;
  const ty = centerY - y * LOUPE_MAGNIFICATION;
  loupeContent.style.transform = `translate(${tx}px, ${ty}px) scale(${LOUPE_MAGNIFICATION})`;
  loupeRoot.classList.remove('hidden');
  positionLoupe();
}

function setLoupeEnabled(enabled: boolean): void {
  loupeEnabled = enabled;
  const button = document.getElementById('loupeToggle');
  button?.classList.toggle('active', enabled);
  button?.setAttribute('aria-pressed', String(enabled));
  if (!enabled) loupeRoot?.classList.add('hidden');
  else {
    hint('Precision loupe enabled · move over the drawing; drag its title bar to reposition it');
    if (loupePointer.valid) refreshLoupe(loupePointer.x, loupePointer.y);
  }
}

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
  document.getElementById('undoBtn')?.addEventListener('click', undoTakeoff);
  document.getElementById('redoBtn')?.addEventListener('click', redoTakeoff);
  updateHistoryButtons();
  document.getElementById('snapToggle')?.addEventListener('click', () => {
    snapEnabled = !snapEnabled;
    snapPoint = null;
    updateSnapToggle();
    hint(snapEnabled ? 'Object snapping enabled' : 'Object snapping disabled');
    refreshPreview();
  });
  updateSnapToggle();
  loupeRoot = document.getElementById('loupeWindow');
  loupeViewport = document.getElementById('loupeViewport');
  loupeContent = document.getElementById('loupeContent');
  loupeRaster = document.getElementById('loupeRaster') as HTMLCanvasElement | null;
  for (const id of ['annotationColor', 'annotationWidth', 'annotationOpacity', 'annotationLineStyle']) {
    document.getElementById(id)?.addEventListener('change', () => {
      const annotation = state.annotations.find((item) => item.id === state.selectedAnnotationId);
      if (!annotation) return;
      recordHistory();
      if (id === 'annotationColor') annotation.color = (document.getElementById(id) as HTMLInputElement).value;
      if (id === 'annotationWidth') annotation.strokeWidth = Math.max(0.5, Math.min(16, Number((document.getElementById(id) as HTMLInputElement).value) || 2));
      if (id === 'annotationOpacity') annotation.opacity = Math.max(0, Math.min(1, Number((document.getElementById(id) as HTMLInputElement).value) || 0));
      if (id === 'annotationLineStyle') annotation.lineStyle = (document.getElementById(id) as HTMLSelectElement).value as 'solid' | 'dashed' | 'dotted';
      renderMarkups();
      emit();
    });
  }
  document.getElementById('loupeToggle')?.addEventListener('click', () => setLoupeEnabled(!loupeEnabled));
  document.getElementById('loupeClose')?.addEventListener('click', () => setLoupeEnabled(false));
  const loupeHeader = document.getElementById('loupeHeader');
  loupeHeader?.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    loupeDragging = true;
    loupeDragStart = { x: event.clientX, y: event.clientY, offsetX: loupeOffset.x, offsetY: loupeOffset.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  window.addEventListener('pointermove', (event) => {
    if (!loupeDragging) return;
    loupeOffset = {
      x: loupeDragStart.offsetX + event.clientX - loupeDragStart.x,
      y: loupeDragStart.offsetY + event.clientY - loupeDragStart.y,
    };
    positionLoupe();
  });
  window.addEventListener('pointerup', () => { loupeDragging = false; });
  svg.addEventListener('pointermove', onPointerMove);
  // Track the pointer independently of the active tool. The loupe must also
  // work in Select mode and should appear immediately if toggled while the
  // pointer is already over the sheet. Drawing into its raster is capped at
  // one update per animation frame to avoid competing with pointer feedback.
  window.addEventListener('pointermove', (event) => {
    if (loupeDragging) {
      positionLoupe();
      return;
    }
    const rect = svg.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) {
      if (loupeRoot && event.target instanceof Node && loupeRoot.contains(event.target)) return;
      if (loupeEnabled) {
        loupePointer.valid = false;
        loupeRoot?.classList.add('hidden');
      }
      return;
    }
    loupePointer = { x: event.clientX, y: event.clientY, valid: true };
    if (!loupeEnabled || loupeFrame) return;
    loupePending = { x: event.clientX, y: event.clientY };
    loupeFrame = requestAnimationFrame(() => {
      loupeFrame = 0;
      refreshLoupe(loupePending.x, loupePending.y);
    });
  });
  svg.addEventListener('pointerleave', (event) => {
    cursor = null;
    refreshPreview();
    if (loupeEnabled && !(event.relatedTarget instanceof Node && loupeRoot?.contains(event.relatedTarget))) {
      loupeRoot?.classList.add('hidden');
    }
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
  if (['length', 'area', 'count', 'perimeter', 'volume', 'angle', 'note', 'fill', 'scan'].includes(tool) && isLockedLayer(getActiveLayer())) {
    hint('The active layer is locked · choose or unlock another layer before measuring');
    return;
  }
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



function beginAnnotationDrag(annotation: import('../engine/types').DrawingAnnotation, event: PointerEvent): void {
  const start = eventToPdf(event);
  if (!start) return;
  const before = annotation.points.map((point) => ({ ...point }));
  recordHistory();
  try { svg.setPointerCapture(event.pointerId); } catch { /* pointer may already be captured */ }
  const move = (ev: PointerEvent) => {
    const current = eventToPdf(ev);
    if (!current) return;
    const dx = current.x - start.x, dy = current.y - start.y;
    annotation.points = before.map((point) => ({ x: point.x + dx, y: point.y + dy }));
    renderMarkups();
  };
  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    renderMarkups();
    emit();
    try { if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish, { once: true });
  window.addEventListener('pointercancel', finish, { once: true });
}

function beginDrawingAnnotation(kind: import('../engine/types').DrawingAnnotationKind, start: Pt, event: PointerEvent): void {
  const color = (document.getElementById('annotationColor') as HTMLInputElement | null)?.value || '#e11d48';
  const width = Number((document.getElementById('annotationWidth') as HTMLInputElement | null)?.value || 2);
  const opacity = Number((document.getElementById('annotationOpacity') as HTMLInputElement | null)?.value || 0.9);
  const lineStyle = ((document.getElementById('annotationLineStyle') as HTMLSelectElement | null)?.value || 'solid') as 'solid' | 'dashed' | 'dotted';
  const make = (end: Pt) => {
    recordHistory();
    const id = nextId('an');
    state.annotations.push({
      id, page: state.pageNum, kind, points: [start, end], color,
      strokeWidth: Math.max(0.5, Math.min(16, width)),
      opacity: Math.max(0, Math.min(1, opacity)),
      fillOpacity: 0.2, lineStyle,
    });
    state.selectedAnnotationId = id;
    emit();
    hint(`${kind} annotation added · excluded from quantities`);
  };
  try { svg.setPointerCapture(event.pointerId); } catch { /* pointer may already be captured */ }
  const update = (ev: PointerEvent) => {
    const end = eventToPdf(ev);
    if (!end) return;
    const a = pdfToView(start), b = pdfToView(end);
    previewLayer.replaceChildren();
    const shape = document.createElementNS('http://www.w3.org/2000/svg', kind === 'ellipse' ? 'ellipse' : kind === 'rectangle' || kind === 'highlight' || kind === 'cloud' ? 'rect' : 'line');
    if (shape.tagName === 'line') {
      shape.setAttribute('x1', String(a.x)); shape.setAttribute('y1', String(a.y));
      shape.setAttribute('x2', String(b.x)); shape.setAttribute('y2', String(b.y));
    } else if (shape.tagName === 'ellipse') {
      shape.setAttribute('cx', String((a.x+b.x)/2)); shape.setAttribute('cy', String((a.y+b.y)/2));
      shape.setAttribute('rx', String(Math.abs(b.x-a.x)/2)); shape.setAttribute('ry', String(Math.abs(b.y-a.y)/2));
    } else {
      shape.setAttribute('x', String(Math.min(a.x,b.x))); shape.setAttribute('y', String(Math.min(a.y,b.y)));
      shape.setAttribute('width', String(Math.max(1,Math.abs(b.x-a.x)))); shape.setAttribute('height', String(Math.max(1,Math.abs(b.y-a.y))));
    }
    shape.setAttribute('fill', kind === 'highlight' ? color : 'none');
    shape.setAttribute('fill-opacity', kind === 'highlight' ? '0.2' : '0');
    shape.setAttribute('stroke', color); shape.setAttribute('stroke-width', String(width));
    if (lineStyle === 'dashed') shape.setAttribute('stroke-dasharray', '7 4');
    if (lineStyle === 'dotted') shape.setAttribute('stroke-dasharray', '1 4');
    previewLayer.appendChild(shape);
  };
  const finish = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', update);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    const end = eventToPdf(ev);
    previewLayer.replaceChildren();
    if (end && Math.hypot(end.x-start.x, end.y-start.y) > 2) make(end);
    try { if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  const cancel = () => {
    window.removeEventListener('pointermove', update);
    window.removeEventListener('pointerup', finish);
    previewLayer.replaceChildren();
  };
  window.addEventListener('pointermove', update);
  window.addEventListener('pointerup', finish, { once: true });
  window.addEventListener('pointercancel', cancel, { once: true });
}

async function onPointerDown(e: PointerEvent): Promise<void> {
  if (e.button !== 0) return;
  if (state.tool === 'pan' && e.target instanceof Element) {
    const annotationGroup = e.target.closest<SVGGElement>('[data-annotation-id]');
    const annotationId = annotationGroup?.getAttribute('data-annotation-id');
    const annotation = annotationId ? state.annotations.find((item) => item.id === annotationId) : undefined;
    if (annotation) {
      state.selectedAnnotationId = annotation.id;
      state.selectedId = null;
      const colorInput = document.getElementById('annotationColor') as HTMLInputElement | null;
      const widthInput = document.getElementById('annotationWidth') as HTMLInputElement | null;
      const opacityInput = document.getElementById('annotationOpacity') as HTMLInputElement | null;
      const lineInput = document.getElementById('annotationLineStyle') as HTMLSelectElement | null;
      if (colorInput) colorInput.value = annotation.color || '#e11d48';
      if (widthInput) widthInput.value = String(annotation.strokeWidth ?? 2);
      if (opacityInput) opacityInput.value = String(annotation.opacity ?? 0.9);
      if (lineInput) lineInput.value = annotation.lineStyle || 'solid';
      renderMarkups();
      emit();
      beginAnnotationDrag(annotation, e);
      return;
    }
  }
  if (state.tool.startsWith('annot-')) {
    e.preventDefault();
    const point = eventToPdf(e);
    if (!point) return;
    const kind = state.tool.slice(6) as import('../engine/types').DrawingAnnotationKind;
    if (kind === 'text') {
      const text = window.prompt('Annotation text');
      if (text?.trim()) {
        recordHistory();
        const annotationId = nextId('an');
        state.annotations.push({
          id: annotationId, page: state.pageNum, kind, points: [point], text: text.trim(),
          color: (document.getElementById('annotationColor') as HTMLInputElement | null)?.value || '#e11d48',
          strokeWidth: 2, opacity: 1,
        });
        state.selectedAnnotationId = annotationId;
        emit();
      }
    } else beginDrawingAnnotation(kind, point, e);
    return;
  }
  if (e.target instanceof Element && e.target.closest('[data-id]') && state.tool === 'pan') {
    const g = e.target.closest('[data-id]')!;
    const id = g.getAttribute('data-id')!;
    const m = state.markups.find((x) => x.id === id);
    if (m) {
      state.selectedId = id;
      state.selectedAnnotationId = null;
      renderMarkups();
      emit();
      if (m.page === state.pageNum) {
        const vtx = e.target.closest('.vtx');
        const vertexIndex = vtx ? Number(vtx.getAttribute('data-idx')) : null;
        selectedVertex = vertexIndex === null ? null : { markupId: m.id, index: vertexIndex };
        beginDrag(m, vertexIndex, e);
      }
    }
    return;
  }
  let p = eventToPdf(e);
  if (!p) return;
  if (['length', 'area', 'count', 'perimeter', 'volume', 'angle', 'note', 'fill', 'scan'].includes(state.tool) && isLockedLayer(getActiveLayer())) {
    hint('The active layer is locked · unlock it or choose another layer before measuring');
    return;
  }
  if (snapEnabled && ['calibrate','length','area','perimeter','volume','viewport','angle'].includes(state.tool)) {
    await loadSnapSegments(state.pageNum);
    if (!snapSegments.length) hint('No vector geometry is available for snapping on this page; use manual clicks on this scanned/image sheet.');
    // Use the original pointer position after the async geometry load.
    const raw = eventToPdf(e);
    if (raw) p = raw;
    const snapped = snapPdfPoint(p);
    snapPoint = snapped ? { ...snapped.point, kind: snapped.kind } : null;
    if (snapped) p = snapped.point;
  }

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
      recordHistory();
      state.markups.push(m);
      state.lastAction = null;
      syncUpsertMarkup(m);
      renderMarkups();
      emit();
      break;
    }
    case 'note': {
      const annotationText = window.prompt('Text annotation', state.activePreset?.type === 'note' ? state.activePreset.label : '');
      if (annotationText === null) break;
      const note: Markup = {
        id: nextId('mk'),
        page: state.pageNum,
        type: 'note',
        layer: getActiveLayer() !== DEFAULT_LAYER ? getActiveLayer() : undefined,
        label: annotationText.trim() || 'Note',
        points: [p],
        createdAt: Date.now(),
      };
      recordHistory();
      state.markups.push(note);
      state.lastAction = null;
      syncUpsertMarkup(note);
      renderMarkups();
      emit();
      hint('Text annotation placed · select it to move, or edit its text in the Markups list');
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
      state.selectedAnnotationId = null;
      renderMarkups();
      emit();
      break;
  }
}

/** Drag a whole markup, or one vertex when vtxIdx is given. Live value updates. */
function beginDrag(m: import('./state').Markup, vtxIdx: number | null, e: PointerEvent): void {
  if (isLockedLayer(layerOf(m))) { hint('This measurement is on a locked layer · unlock it before editing'); return; }
  const start = eventToPdf(e);
  if (!start) return;
  const geometry = m.sourceId ? state.markups.find((item) => item.id === m.sourceId) ?? m : m;
  const before = geometry.points.map((p) => ({ ...p }));
  recordHistory();
  state.lastAction = { kind: 'move', id: geometry.id, before };
  if (vtxIdx !== null) void loadSnapSegments(m.page);
  const move = (ev: PointerEvent) => {
    let cur = eventToPdf(ev);
    if (!cur) return;
    if (vtxIdx != null && vtxIdx >= 0 && vtxIdx < geometry.points.length) {
      if (snapEnabled) {
        const snapped = snapPdfPoint(cur);
        if (snapped) cur = snapped.point;
      }
      geometry.points[vtxIdx] = cur;
    } else {
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      geometry.points = before.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    renderMarkups();
    syncUpsertMarkup(geometry);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    renderMarkups();
    emit();
    if (vtxIdx !== null && geometry.points[vtxIdx]) {
      const point = geometry.points[vtxIdx];
      const closed = m.type === 'area' || m.type === 'perimeter' || m.type === 'volume';
      const adjacent = [vtxIdx - 1, vtxIdx].filter((index) => index >= 0 && index < (closed ? geometry.points.length : geometry.points.length - 1));
      const cal = calibrationForMarkup(m);
      const lengths = cal ? adjacent.map((index) => formatLength(distPt(geometry.points[index], geometry.points[(index + 1) % geometry.points.length]) * cal.metersPerPt, state.displayUnit)) : [];
      hint(`Vertex ${vtxIdx + 1} · X ${point.x.toFixed(2)} pt · Y ${point.y.toFixed(2)} pt${lengths.length ? ` · adjacent: ${lengths.join(' / ')}` : ''}`);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function onPointerMove(e: PointerEvent): void {
  if (state.tool === 'pan') return;
  const raw = eventToPdf(e);
  if (!raw) return;
  if (snapEnabled && ['calibrate','length','area','perimeter','volume','viewport','angle'].includes(state.tool)) {
    if (snapPage !== state.pageNum || (!snapSegments.length && !snapPromise)) void loadSnapSegments(state.pageNum);
    const snapped = snapPdfPoint(raw);
    snapPoint = snapped ? { ...snapped.point, kind: snapped.kind } : null;
    cursor = snapped?.point ?? raw;
  } else {
    snapPoint = null;
    cursor = raw;
  }
  refreshPreview();
}

function onDoubleClick(e: MouseEvent): void {
  const p = eventToPdf(e);
  if (!p) return;

  // In pan/select mode, double-click a measurement segment to insert a
  // vertex at its nearest point. The new node is stored in PDF coordinates,
  // exactly like the original vertices, and can immediately be dragged.
  if (state.tool === 'pan' && e.target instanceof Element) {
    const group = e.target.closest<SVGGElement>('.markup[data-id]');
    const id = group?.getAttribute('data-id');
    const markup = id ? state.markups.find((m) => m.id === id && m.page === state.pageNum) : undefined;
    const geometry = markup?.sourceId ? state.markups.find((m) => m.id === markup.sourceId) ?? markup : markup;
    if (markup && geometry && ['length', 'area', 'perimeter', 'volume'].includes(markup.type) && geometry.points.length >= 2) {
      const points = geometry.points;
      const closed = markup.type === 'area' || markup.type === 'perimeter' || markup.type === 'volume';
      let best: { index: number; point: Pt; distance: number } | null = null;
      const segmentCount = closed ? points.length : points.length - 1;
      for (let i = 0; i < segmentCount; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
        const q = { x: a.x + t * dx, y: a.y + t * dy };
        const distance = Math.hypot(p.x - q.x, p.y - q.y);
        if (!best || distance < best.distance) best = { index: i, point: q, distance };
      }
      if (best && best.distance <= 12 / Math.max(0.05, state.zoom)) {
        const before = points.map((point) => ({ ...point }));
        recordHistory();
        state.lastAction = { kind: 'move', id: markup.id, before };
        geometry.points.splice(best.index + 1, 0, best.point);
        selectedVertex = { markupId: markup.id, index: best.index + 1 };
        state.selectedId = markup.id;
        syncUpsertMarkup(geometry);
        renderMarkups();
        emit();
        e.preventDefault();
        e.stopPropagation();
        hint('Vertex inserted · drag the new node to adjust the measurement');
        return;
      }
    }
  }

  if (state.tool === 'length' || state.tool === 'area' || state.tool === 'perimeter' || state.tool === 'volume' || state.tool === 'viewport') {
    // Both pointerdowns have already been processed by the time the
    // browser dispatches dblclick. The second click is the duplicate end
    // vertex, even when sub-pixel rounding makes its PDF coordinates differ.
    if (draft.length) draft.pop();
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
      ...(clickCal ? { calibration: { metersPerPt: clickCal.metersPerPt, source: clickCal.source } } : {}),
    };
    recordHistory();
    state.markups.push(m);
    state.lastAction = null;
    syncUpsertMarkup(m);
    setTool('pan');
    renderMarkups();
    emit();
    const cal = clickCal;
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
  recordHistory();
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
  if (isLockedLayer(getActiveLayer())) { hint('The active layer is locked · measurement was not added'); return; }
  const markup: Markup = {
    id: nextId('mk'),
    page: state.pageNum,
    type,
    label: state.activePreset?.type === type ? state.activePreset.label : defaultLabel(type),
    points: [...draft],
    createdAt: Date.now(),
    ...(depth !== undefined ? { depth } : {}),
    ...(getActiveLayer() !== DEFAULT_LAYER ? { layer: getActiveLayer() } : {}),
  };
  freezeMarkupCalibration(markup);
  recordHistory();
  state.markups.push(markup);
  state.lastAction = null;
  syncUpsertMarkup(markup);
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
  drawSnapMarker();
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
  const ptDist = distPt(pendingCalib.a, pendingCalib.b);
  if (value == null || !Number.isFinite(value) || value <= 0 || !Number.isFinite(ptDist) || ptDist <= 0) {
    calibInput.classList.add('invalid');
    calibInput.focus();
    setTimeout(() => calibInput.classList.remove('invalid'), 600);
    hint('Enter a real-world length greater than zero before applying the scale');
    return;
  }
  const meters = toMeters(value, unit);
  const metersPerPt = meters / ptDist;
  if (!Number.isFinite(metersPerPt) || metersPerPt <= 0) {
    calibInput.classList.add('invalid');
    calibInput.focus();
    setTimeout(() => calibInput.classList.remove('invalid'), 600);
    hint('The calibration could not be calculated. Check the length and redraw the dimension.');
    return;
  }
  recordHistory();
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
      if (state.tool !== 'pan') setTool('pan');
      hint('Measurement cancelled · Select mode');
    } else if (state.tool !== 'pan') {
      setTool('pan');
      if (state.selectedId) {
        state.selectedId = null;
        renderMarkups();
        emit();
      }
      hint('Select mode · choose a markup to edit, or drag the sheet to pan');
    } else if (state.selectedId || state.selectedAnnotationId) {
      state.selectedId = null;
      state.selectedAnnotationId = null;
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
  if ((k === 'delete' || k === 'backspace') && selectedVertex) {
    const vertex = selectedVertex;
    const selectedMarkup = state.markups.find((m) => m.id === vertex.markupId);
    const geometry = selectedMarkup?.sourceId ? state.markups.find((m) => m.id === selectedMarkup.sourceId) ?? selectedMarkup : selectedMarkup;
    if (!selectedMarkup || !geometry) { selectedVertex = null; }
    else {
      if (isLockedLayer(layerOf(selectedMarkup))) { hint('This measurement is on a locked layer · unlock it before editing'); return; }
      const minimum = selectedMarkup.type === 'length' ? 2 : 3;
      if (geometry.points.length <= minimum) { hint(`This measurement needs at least ${minimum} vertices`); return; }
      if (vertex.index < 0 || vertex.index >= geometry.points.length) { selectedVertex = null; return; }
      recordHistory();
      geometry.points.splice(vertex.index, 1);
      selectedVertex = null;
      state.lastAction = null;
      syncUpsertMarkup(geometry);
      renderMarkups();
      emit();
      hint('Vertex deleted · measurement quantity recalculated');
      return;
    }
  }
  if ((k === 'delete' || k === 'backspace') && state.selectedAnnotationId) {
    recordHistory();
    state.annotations = state.annotations.filter((item) => item.id !== state.selectedAnnotationId);
    state.selectedAnnotationId = null;
    renderMarkups();
    emit();
    return;
  }
  if ((k === 'delete' || k === 'backspace') && state.selectedId) {
    const deleted = state.selectedId;
    recordHistory();
    state.markups = state.markups.filter((m) => m.id !== state.selectedId);
    state.selectedId = null;
    if (deleted) syncDeleteMarkup(deleted);
    renderMarkups();
    emit();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (k === 'y' || (k === 'z' && e.shiftKey))) {
    e.preventDefault();
    redoTakeoff();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && k === 'z') {
    e.preventDefault();
    if (draft.length) {
      draft.pop();
      refreshPreview();
    } else {
      undoTakeoff();
    }
    return;
  }
  if (toolKeys[k] && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (compareState.active && k !== 'v') return; // measuring is paused during compare
    setTool(toolKeys[k]);
  }
}
