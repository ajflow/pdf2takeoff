// PDF rendering with pdf.js: document lifecycle, page canvas, zoom/pan, and
// the SVG overlay that carries all markups. The overlay viewBox is the page
// viewport at scale 1, so markup geometry in PDF-point space never changes
// with zoom — only the canvas re-rasterises.

import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { state, emit } from './state';
import { vectorize, type VecPage } from '../engine/vector';
import { parseImagePages, parseScales, PAPER_KEY, SCALE_KEY } from '../engine/inputs';
import { METERS_PER_PT } from '../engine/units';
import { layersToHideForFill, type LayerRole } from '../engine/cad-layers';

/**
 * Where pdf.js finds its WebAssembly decoders (CCITT fax, JBIG2, JPEG 2000:
 * without them a scanned PDF's images come out blank) and the standard-14
 * fonts; both ship with the site under /pdfjs/ (vite.config.ts).
 */
export const PDFJS_ASSET_URLS = {
  wasmUrl: new URL(`${import.meta.env.BASE_URL}pdfjs/wasm/`, location.href).href,
  standardFontDataUrl: new URL(`${import.meta.env.BASE_URL}pdfjs/standard_fonts/`, location.href).href,
};

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export type ViewPt = { x: number; y: number }; // viewport@1 space (top-left origin)

let doc: PDFDocumentProxy | null = null;
let viewport1: PageViewport | null = null;
let renderTask: RenderTask | null = null;
let renderSeq = 0;

let scrollEl: HTMLElement;
let pageEl: HTMLElement;
let canvas: HTMLCanvasElement;
let svg: SVGSVGElement;
export let markupsLayer: SVGGElement;
export let previewLayer: SVGGElement;

export let onFirstRender: (() => void) | null = null;

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const MAX_CANVAS_PIXELS = 2.5e7;

export function initViewer(
  scroll: HTMLElement,
  page: HTMLElement,
  cnv: HTMLCanvasElement,
  overlay: SVGSVGElement,
  ml: SVGGElement,
  pl: SVGGElement,
): void {
  scrollEl = scroll;
  pageEl = page;
  canvas = cnv;
  svg = overlay;
  markupsLayer = ml;
  previewLayer = pl;
  bindWheel();
  bindPan();
}

export function hasDoc(): boolean {
  return doc !== null;
}

/** The loaded document, for engine modules (scan, export) that need their own renders. */
export function getPdfDoc(): PDFDocumentProxy | null {
  return doc;
}

export async function loadPdf(bytes: Uint8Array, name: string): Promise<void> {
  await closePdf();
  state.fileName = name;
  state.fileBytes = bytes;
  state.pageNum = 1;
  state.markups = [];
  state.selectedId = null;
  state.calibrations.clear();
  state.scaleChecks.clear();
  state.focusLabel = null;
  const task = pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_ASSET_URLS });
  doc = await task.promise;
  state.pageCount = doc.numPages;
  // pages that came from images (opened here, or saved from here and reopened)
  const meta = await doc.getMetadata().catch(() => null);
  const custom = (meta?.info as { Custom?: Record<string, unknown> } | undefined)?.Custom;
  state.imagePages = parseImagePages(custom?.[PAPER_KEY]);
  // a DXF knows its units: its pages arrive with their scale set
  for (const [p, s] of parseScales(custom?.[SCALE_KEY])) {
    state.calibrations.set(p, { metersPerPt: METERS_PER_PT * s.ratio, source: `drawing units (${s.unit}${s.assumed ? ', assumed' : ''}) at 1:${s.ratio}` });
  }
  state.zoom = fitWidthZoom();
  emit();
}

export async function closePdf(): Promise<void> {
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {
      /* cancelled */
    }
    renderTask = null;
  }
  if (doc) {
    try {
      await doc.destroy();
    } catch {
      /* already destroyed */
    }
    doc = null;
  }
}

// per-page caches for the open document (geometry and text never change
// while it is open); keyed by the document so a new load starts fresh
type TextItems = { str?: string; transform?: number[]; width?: number; height?: number }[];
const vectorCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<VecPage>>>();
const textCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextItems>>>();
const cleanVectorCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<VecPage>>>();

/** pdf.js's layer (optional-content) configuration. */
export type LayerConfig = Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>;
const fillLayerCache = new WeakMap<PDFDocumentProxy, Promise<{ config: LayerConfig; hidden: { name: string; role: LayerRole }[] } | null>>();

/**
 * The document's layers with Magic Fill's clutter hidden (furniture, finish
 * hatching, annotation, services, structure above; see cad-layers.ts). Null
 * when the document has no such layers. What the person sees is unchanged:
 * only the fill renders with this.
 */
export function getFillLayers(): Promise<{ config: LayerConfig; hidden: { name: string; role: LayerRole }[] } | null> {
  const d = doc;
  if (!d) return Promise.resolve(null);
  let p = fillLayerCache.get(d);
  if (!p) {
    p = d
      .getOptionalContentConfig()
      .then((config) => {
        const groups = [...(config as unknown as Iterable<[string, { name: string | null }]>)].map(([id, g]) => ({ id, name: g.name }));
        const hide = layersToHideForFill(groups);
        if (!hide.length) return null;
        for (const h of hide) config.setVisibility(h.id, false);
        return { config, hidden: hide.map(({ name, role }) => ({ name, role })) };
      })
      .catch(() => null);
    fillLayerCache.set(d, p);
  }
  return p;
}
function cached<T>(store: WeakMap<PDFDocumentProxy, Map<number, Promise<T>>>, d: PDFDocumentProxy, pageNum: number, make: () => Promise<T>): Promise<T> {
  let byPage = store.get(d);
  if (!byPage) store.set(d, (byPage = new Map()));
  let p = byPage.get(pageNum);
  if (!p) {
    p = make();
    p.catch(() => byPage!.delete(pageNum)); // don't cache failures
    byPage.set(pageNum, p);
  }
  return p;
}

/**
 * The page's vector geometry from its drawing operators (null before a
 * document loads). `clean`: as Magic Fill sees it, without the clutter layers.
 */
export async function getPageVector(pageNum: number, clean = false): Promise<VecPage | null> {
  const d = doc;
  if (!d) return null;
  return cached(clean ? cleanVectorCache : vectorCache, d, pageNum, async () => {
    const fill = clean ? await getFillLayers() : null;
    const [page, layers] = await Promise.all([d.getPage(pageNum), fill ? fill.config : d.getOptionalContentConfig()]);
    return vectorize(await page.getOperatorList(), pdfjsLib.OPS, { isVisible: (g) => layers.isVisible(g as never) });
  });
}

/** The page's text-layer items (empty for scans or before a document loads). */
export async function getPageTextItems(pageNum: number): Promise<TextItems> {
  const d = doc;
  if (!d) return [];
  return cached(textCache, d, pageNum, async () => (await (await d.getPage(pageNum)).getTextContent()).items as TextItems);
}

/** Load annotations written by pdf2takeoff (or any tool) back into the state. */
export async function getPageAnnotations(pageNum: number) {
  if (!doc) return [];
  const page = await doc.getPage(pageNum);
  return page.getAnnotations({ intent: 'display' });
}

export async function renderPage(): Promise<void> {
  if (!doc) return;
  const mySeq = ++renderSeq;
  if (renderTask) {
    try {
      renderTask.cancel();
    } catch {
      /* cancelled */
    }
    renderTask = null;
  }
  const page = await doc.getPage(state.pageNum);
  if (mySeq !== renderSeq) return; // superseded
  viewport1 = page.getViewport({ scale: 1 });

  // SVG overlay geometry is zoom-independent; size only changes with the page.
  svg.setAttribute('viewBox', `0 0 ${viewport1.width} ${viewport1.height}`);

  applyLayoutSize();
  await paintCanvas(page, mySeq);
}

function fitWidthZoom(): number {
  if (!viewport1) return 1;
  const available = scrollEl.clientWidth - 64;
  return clampZoom(available / viewport1.width);
}

export function fitWidth(): void {
  if (!viewport1) return;
  state.zoom = fitWidthZoom();
  emit();
}

export function setZoom(z: number): void {
  state.zoom = clampZoom(z);
  emit();
}

export function zoomAt(clientX: number, clientY: number, factor: number): void {
  const cr = scrollEl.getBoundingClientRect();
  const cx = clientX - cr.left;
  const cy = clientY - cr.top;
  const z2 = clampZoom(state.zoom * factor);
  if (z2 === state.zoom) return;
  const ratio = z2 / state.zoom;
  const contentX = scrollEl.scrollLeft + cx;
  const contentY = scrollEl.scrollTop + cy;
  state.zoom = z2;
  previewResize();
  scrollEl.scrollLeft = contentX * ratio - cx;
  scrollEl.scrollTop = contentY * ratio - cy;
  emit();
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function applyLayoutSize(): void {
  if (!viewport1) return;
  const w = viewport1.width * state.zoom;
  const h = viewport1.height * state.zoom;
  pageEl.style.width = `${w}px`;
  pageEl.style.height = `${h}px`;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}

/** Immediately stretch existing raster to the new zoom so interaction feels live,
 *  then the debounced render re-rasterises crisply. */
function previewResize(): void {
  applyLayoutSize();
}

async function paintCanvas(page: pdfjsLib.PDFPageProxy, mySeq: number): Promise<void> {
  const viewport = page.getViewport({ scale: state.zoom });
  let dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = viewport.width * dpr;
  const py = viewport.height * dpr;
  if (px * py > MAX_CANVAS_PIXELS) {
    dpr = Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
  }
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  applyLayoutSize();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    renderTask = page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    });
    await renderTask.promise;
  } catch {
    return; // cancelled or superseded
  }
  if (mySeq === renderSeq && onFirstRender) {
    onFirstRender();
    onFirstRender = null;
  }
  renderTask = null;
}

export function viewSize(): { w: number; h: number } {
  return viewport1 ? { w: viewport1.width, h: viewport1.height } : { w: 0, h: 0 };
}

/** Event position → viewport@1 coordinates (the SVG viewBox space). */
export function eventToView(e: { clientX: number; clientY: number }): ViewPt | null {
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((e.clientX - rect.left) / rect.width) * (viewport1?.width ?? 0),
    y: ((e.clientY - rect.top) / rect.height) * (viewport1?.height ?? 0),
  };
}

export function viewToPdf(v: ViewPt) {
  if (!viewport1) return { x: 0, y: 0 };
  const [x, y] = viewport1.convertToPdfPoint(v.x, v.y);
  return { x, y };
}

export function pdfToView(p: { x: number; y: number }): ViewPt {
  if (!viewport1) return { x: 0, y: 0 };
  const [x, y] = viewport1.convertToViewportPoint(p.x, p.y);
  return { x, y };
}

// --- interaction: wheel zoom, drag pan ---

function bindWheel(): void {
  scrollEl.addEventListener(
    'wheel',
    (e) => {
      if (!doc) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.01);
        zoomAt(e.clientX, e.clientY, factor);
      }
      // plain wheel/touchpad scrolls the container natively
    },
    { passive: false },
  );
}

let spaceDown = false;

function bindPan(): void {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTypingTarget(e.target)) spaceDown = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceDown = false;
  });

  svg.addEventListener('pointerdown', (e) => {
    if (!doc) return;
    const wantPan = e.button === 1 || spaceDown || state.tool === 'pan';
    if (!wantPan) return;
    // clicking a markup selects/drags it — don't also pan the canvas
    if (state.tool === 'pan' && e.target instanceof Element && e.target.closest('[data-id]')) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev: PointerEvent) => {
      scrollEl.scrollLeft -= ev.clientX - lastX;
      scrollEl.scrollTop -= ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
    };
    const up = () => {
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
      svg.removeEventListener('pointercancel', up);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
  });
}

export function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
  );
}
