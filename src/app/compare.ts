// Revision overlay compare: render two revisions of a drawing, align them and
// colour-blend — red appears only in revision A (removed), blue only in
// revision B (added), dark ink in both (unchanged). The Bluebeam-style overlay.

import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { emit } from './state';
import { blendOverlay, type RGBA } from '../engine/compare';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

interface Revision {
  name: string;
  doc: PDFDocumentProxy;
  page: number; // 1-based
  pageW: number; // points
  pageH: number;
}

export const compareState = {
  active: false,
  a: null as Revision | null,
  b: null as Revision | null,
  offsetX: 0, // nudge applied to B, in A-page points (+x right, +y down)
  offsetY: 0,
  fit: true, // scale B's paper to match A's page size
  fadeUnchanged: false, // "changes only": unchanged ink fades to grey
};

let canvas: HTMLCanvasElement;
let pageWrap: HTMLElement;

export function initCompare(cnv: HTMLCanvasElement, wrap: HTMLElement): void {
  canvas = cnv;
  pageWrap = wrap;
}

export async function loadRevision(
  slot: 'a' | 'b',
  bytes: Uint8Array,
  name: string,
): Promise<void> {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const page = 1;
  const p = await doc.getPage(page);
  const vp = p.getViewport({ scale: 1 });
  compareState[slot] = { name, doc, page, pageW: vp.width, pageH: vp.height };
  await renderCompare();
  emit();
}

async function rasterizeTo(
  rev: Revision,
  targetW: number,
  targetH: number,
): Promise<RGBA> {
  const page = await rev.doc.getPage(rev.page);
  const vp1 = page.getViewport({ scale: 1 });
  // "cover" the target box, then stretch-draw so B's page maps onto it exactly
  const scale = Math.max(targetW / vp1.width, targetH / vp1.height);
  const vp = page.getViewport({ scale });
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.round(vp.width));
  tmp.height = Math.max(1, Math.round(vp.height));
  const tctx = tmp.getContext('2d')!;
  await page.render({ canvas: tmp, canvasContext: tctx, viewport: vp }).promise;

  const cnv = document.createElement('canvas');
  cnv.width = Math.max(1, Math.round(targetW));
  cnv.height = Math.max(1, Math.round(targetH));
  const ctx = cnv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(tmp, 0, 0, cnv.width, cnv.height);
  const img = ctx.getImageData(0, 0, cnv.width, cnv.height);
  return { width: cnv.width, height: cnv.height, data: img.data };
}

/** Blend both revisions into the main canvas. `zoom` drives CSS sizing. */
export async function renderCompare(zoom = 1): Promise<void> {
  const { a, b } = compareState;
  if (!a || !b) return;

  // raster scale: keep quality sane regardless of zoom (points → px)
  const rasterScale = Math.min(3, Math.max(1.5, zoom * 2));
  const w = Math.round(a.pageW * rasterScale);
  const h = Math.round(a.pageH * rasterScale);
  const bw = compareState.fit ? w : Math.round(b.pageW * rasterScale);
  const bh = compareState.fit ? h : Math.round(b.pageH * rasterScale);

  const [ra, rb] = await Promise.all([rasterizeTo(a, w, h), rasterizeTo(b, bw, bh)]);

  canvas.width = ra.width;
  canvas.height = ra.height;
  const out = new ImageData(ra.width, ra.height);

  const dxPx = compareState.offsetX * rasterScale;
  const dyPx = compareState.offsetY * rasterScale;

  blendOverlay(ra, rb, dxPx, dyPx, compareState.fadeUnchanged, out.data);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(out, 0, 0);

  pageWrap.style.width = `${a.pageW * zoom}px`;
  pageWrap.style.height = `${a.pageH * zoom}px`;
  canvas.style.width = `${a.pageW * zoom}px`;
  canvas.style.height = `${a.pageH * zoom}px`;
}

export function nudge(dxPt: number, dyPt: number): void {
  compareState.offsetX += dxPt;
  compareState.offsetY += dyPt;
  void renderCompare(currentZoom);
  emit();
}

export function setFit(fit: boolean): void {
  compareState.fit = fit;
  void renderCompare(currentZoom);
  emit();
}

export function setFade(fade: boolean): void {
  compareState.fadeUnchanged = fade;
  void renderCompare(currentZoom);
  emit();
}

export async function setRevPage(slot: 'a' | 'b', page: number): Promise<void> {
  const rev = compareState[slot];
  if (!rev) return;
  if (page < 1 || page > rev.doc.numPages) return;
  rev.page = page;
  const p = await rev.doc.getPage(page);
  const vp = p.getViewport({ scale: 1 });
  rev.pageW = vp.width;
  rev.pageH = vp.height;
  await renderCompare(currentZoom);
  emit();
}

export async function swap(): Promise<void> {
  const { a, b } = compareState;
  if (!a || !b) return;
  compareState.a = b;
  compareState.b = a;
  compareState.offsetX = 0;
  compareState.offsetY = 0;
  await renderCompare(currentZoom);
  emit();
}

export async function enterCompare(defaultA: { bytes: Uint8Array; name: string } | null): Promise<void> {
  compareState.active = true;
  compareState.offsetX = 0;
  compareState.offsetY = 0;
  if (defaultA && !compareState.a) {
    await loadRevision('a', defaultA.bytes, defaultA.name);
  }
  emit();
}

export function exitCompare(): void {
  compareState.active = false;
  emit();
}

// main.ts keeps this in sync so nudges re-render at the live zoom
export let currentZoom = 1;
export function setCompareZoom(z: number): void {
  currentZoom = z;
}
