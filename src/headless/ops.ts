// Document operations shared by the CLI and the MCP server: one code path
// for scanning, comparing and annotation reading, whatever drives it.

import { writeFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createCanvas } from '@napi-rs/canvas';
import { renderRasterNode, rasterizeToNode } from './raster-node.ts';
import { imageKindByExt, openAny } from './image-node.ts';
import { RASTER_SCALE, type RasterPage, type ScanDeps } from '../engine/ports.ts';
import { scanForSimilar } from '../engine/scan.ts';
import { cvScan, type TextBox } from '../engine/scan-cv.ts';
import { loadDetectorNode } from './detector-node.ts';
import { ocrRaster, type OcrPageOptions } from './ocr-node.ts';
import { vectorize } from '../engine/vector.ts';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseMarkups, type AnnotationLike } from '../engine/read.ts';
import { blendOverlay } from '../engine/compare.ts';
import { diffMask, maskRegions } from '../engine/diff.ts';
import type { Markup, Pt, ScanResult } from '../engine/types.ts';
import { vectorDiff, textDiff, type VectorDiff, type TextDiff } from '../engine/revdiff.ts';
import { findScaleRatio, roomLabelPoints, wordsFromTextItem, type OcrWord } from '../engine/ocr.ts';
import { metersPerPtForRatio } from '../engine/units.ts';
import { dynamicFill, type FillHints } from '../engine/dynamicfill.ts';
import { doorBridgesFor } from '../engine/fill-vector.ts';

/** Read pdf2takeoff-authored annotations from every page of an open doc. */
export async function readMarkups(doc: PDFDocumentProxy): Promise<Markup[]> {
  const markups: Markup[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const annots = await page.getAnnotations({ intent: 'display' });
    markups.push(...parseMarkups(annots as unknown as AnnotationLike[], p, markups.length));
  }
  return markups;
}

/** The page's vector geometry from its drawing operators. */
export async function vectorDocPage(doc: PDFDocumentProxy, page: number) {
  // hidden CAD layers are skipped, as the renderer skips them
  const layers = await doc.getOptionalContentConfig();
  return vectorize(await (await doc.getPage(page)).getOperatorList(), OPS, { isVisible: (g) => layers.isVisible(g as never) });
}

export interface ScanOptions {
  /** Directory holding symbols.json + the model (see detector-node.ts); default: PDF2TAKEOFF_MODEL_DIR, then public/models/. */
  modelDir?: string;
  /**
   * When the CV scan finds fewer than 2 symbols and the page has no text
   * layer, OCR the render and retry with the words erased from the ink
   * (symbols fused with their tags). Off by default: OCR costs seconds.
   * The text layer is always tried first when the page has one.
   */
  ocrTextMask?: boolean;
}

/** The engine's scan ports bound to an open document: pdf.js vectors and raster, the local ONNX model when one is present. */
export function scanDeps(doc: PDFDocumentProxy, opts: ScanOptions = {}): ScanDeps {
  return {
    renderRaster: (page, scale) => renderRasterNode(doc, page, scale),
    detector: () => loadDetectorNode(opts.modelDir),
    vector: (page) => vectorDocPage(doc, page).catch(() => null),
    // stdout carries JSON (CLI) or the MCP protocol, so recoverable tier failures go to stderr
    warn: (message) => process.stderr.write(`pdf2takeoff: ${message}\n`),
  };
}

/** Padding around a word box before it is erased, as a fraction of the word height (glyph overshoot, anti-aliasing). */
const TEXT_BOX_PAD = 0.15;
/** OCR words below this confidence, or without two alphanumerics, are symbol fragments read as text and are not erased. */
const OCR_MASK_MIN_CONF = 60;

/**
 * Word boxes (PDF points, centre plus length and height, with the baseline
 * angle when known) as axis-aligned raster-px boxes for cvScan's textBoxes.
 * Text-layer words (conf 100) all count; OCR words only when they read
 * like text, so a valve the recogniser took for a letter is not erased.
 */
export function wordBoxesToRaster(words: (OcrWord & { angleDeg?: number })[], raster: RasterPage): TextBox[] {
  const out: TextBox[] = [];
  for (const wd of words) {
    if (wd.conf < 100 && (wd.conf < OCR_MASK_MIN_CONF || (wd.text.match(/[0-9A-Za-z]/g) ?? []).length < 2)) continue;
    const a = ((wd.angleDeg ?? 0) * Math.PI) / 180;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const hw = wd.wPt / 2 + wd.hPt * TEXT_BOX_PAD;
    const hh = wd.hPt / 2 + wd.hPt * TEXT_BOX_PAD;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = raster.toRaster(wd.xPt + ux * hw * sa - uy * hh * sb, wd.yPt + uy * hw * sa + ux * hh * sb);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    if (x1 > x0 && y1 > y0) out.push({ x0, y0, x1, y1 });
  }
  return out;
}

/**
 * Scan at a click point (PDF points): vector match on born-digital symbols,
 * then the trained detector when a model is present, else tier-1 CV. When
 * the CV scan comes back with fewer than 2 hits, the page's words (text
 * layer; OCR of the render only with `ocrTextMask`) are erased from the
 * ink and the scan is retried, for symbols fused with their tags; the
 * retry is kept when it finds more.
 */
export async function scanDocAt(doc: PDFDocumentProxy, page: number, at: Pt, opts: ScanOptions = {}): Promise<ScanResult> {
  const deps = scanDeps(doc, opts);
  // keep the render so the retry does not pay for it again
  let rendered: RasterPage | undefined;
  const render = deps.renderRaster;
  deps.renderRaster = async (p, scale) => (rendered = await render(p, scale));
  const first = await scanForSimilar(page, at, deps);
  if ('error' in first || first.provider !== 'cv' || first.hits.length >= 2 || !rendered) return first;
  let words: OcrWord[] = await pageWords(doc, page).catch(() => []);
  if (!words.length && opts.ocrTextMask) words = await ocrRaster(rendered).catch(() => []);
  if (!words.length) return first;
  const textBoxes = wordBoxesToRaster(words, rendered);
  const retry = cvScan(rendered, at, { textBoxes });
  if ('error' in retry || retry.hits.length <= first.hits.length) return first;
  return { ...retry, note: `${retry.note ?? ''} (retried with ${textBoxes.length} text boxes erased)`.trim() };
}

/** A sheet counts as changed above this fraction of changed pixels. */
export const CHANGED_SHEET_FRACTION = 0.0005;
/** Raster px per PDF point used when diffing revisions. */
export const COMPARE_SCALE = 2;

export interface CompareSheetResult {
  page: number;
  widthPt: number;
  heightPt: number;
  changedFraction: number;
  changed: boolean;
  regions: { xPt: number; yPt: number; wPt: number; hPt: number }[];
  /** exact geometry diff when both sheets are vector (born-digital); lists capped, totals full */
  vector?: VectorDiff & { totals: { moved: number; regions: number } };
  /** text-layer diff: printed values changed in place, words added or removed; lists capped, totals full */
  text?: TextDiff & { totals: { changed: number; added: number; removed: number } };
}

/** Text-layer words of a page (empty for scans). */
async function pageWords(doc: PDFDocumentProxy, page: number) {
  const tc = await (await doc.getPage(page)).getTextContent();
  return (tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[]).flatMap((it) =>
    wordsFromTextItem(typeof it.str === 'string' ? it.str : '', it.transform, it.width, it.height),
  );
}

export interface PageWordsResult {
  words: OcrWord[];
  /** where the words came from: the PDF text layer (exact, conf 100) or OCR of the render (recogniser confidence per word) */
  source: 'text-layer' | 'ocr';
}

/**
 * Words of a page with OCR as the fallback: the text layer when it has
 * words (born-digital sheets), else OCR of the page render (scans, raster
 * imports). `ocr` true forces OCR, false forbids it. `raster` supplies an
 * already rendered page, or an image with no PDF behind it (then pass doc
 * as null). `region` (PDF points) narrows the OCR, not the text layer.
 */
export async function pageWordsWithOcr(
  doc: PDFDocumentProxy | null,
  page: number,
  raster?: RasterPage,
  opts: { ocr?: boolean; region?: OcrPageOptions['region']; rotations?: number[] } = {},
): Promise<PageWordsResult> {
  const layer = doc && opts.ocr !== true ? await pageWords(doc, page).catch(() => []) : [];
  if (layer.length && opts.ocr !== true) return { words: layer, source: 'text-layer' };
  if (opts.ocr === false || (!doc && !raster)) return { words: layer, source: 'text-layer' };
  const r = raster ?? (await renderRasterNode(doc!, page, RASTER_SCALE));
  const words = await ocrRaster(r, { region: opts.region, rotations: opts.rotations });
  return { words, source: 'ocr' };
}

/** A word's box in raster px (its baseline may be rotated), padded by a pixel, for FillHints.textBoxes. */
function wordBox(raster: RasterPage, wd: OcrWord & { angleDeg?: number }): NonNullable<FillHints['textBoxes']>[number] {
  const a = ((wd.angleDeg ?? 0) * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const hw = wd.wPt / 2;
  const hh = wd.hPt / 2;
  const pts = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([s, t]) => raster.toRaster(wd.xPt + ux * s - uy * t, wd.yPt + uy * s + ux * t));
  return {
    x0: Math.floor(Math.min(...pts.map((p) => p.x))) - 1,
    y0: Math.floor(Math.min(...pts.map((p) => p.y))) - 1,
    x1: Math.ceil(Math.max(...pts.map((p) => p.x))) + 1,
    y1: Math.ceil(Math.max(...pts.map((p) => p.y))) + 1,
  };
}

/**
 * Everything Dynamic Fill takes from a sheet besides the click point: room
 * label centres and word boxes from the text layer (the glyphs inside the
 * boxes are masked out of the fill boundary, so a label or dimension
 * string touching a wall makes no false neck), vector doorway bridges, the
 * scale when known, and with `ocr` the OCR words' boxes too (scans and
 * raster imports have no text layer). One call per sheet; the hints are
 * reusable across clicks on it.
 */
export async function fillHintsFor(doc: PDFDocumentProxy, page: number, raster: RasterPage, opts: { metersPerPt?: number; ocr?: boolean } = {}): Promise<FillHints> {
  const [tc, vec] = await Promise.all([doc.getPage(page).then((pg) => pg.getTextContent()), vectorDocPage(doc, page).catch(() => null)]);
  const items = tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[];
  const words: (OcrWord & { angleDeg?: number })[] = items.flatMap((it) => wordsFromTextItem(typeof it.str === 'string' ? it.str : '', it.transform, it.width, it.height));
  if (opts.ocr) words.push(...(await ocrRaster(raster).catch(() => [] as OcrWord[])));
  return {
    labels: roomLabelPoints(items),
    textBoxes: words.map((wd) => wordBox(raster, wd)),
    ...(vec ? { bridges: doorBridgesFor(vec, opts.metersPerPt) } : {}),
    ...(opts.metersPerPt ? { metersPerPt: opts.metersPerPt } : {}),
  };
}

/** Keep diff listings readable: the first n entries (totals are reported beside them). */
function capList<T>(list: T[], n = 40): T[] {
  return list.slice(0, n);
}

export interface CompareSummary {
  comparedSheets: number;
  changedSheets: number[];
  summary: { changed: number; unchanged: number; onlyInA: number; onlyInB: number };
  sheets: CompareSheetResult[];
}

export async function compareDocs(
  docA: PDFDocumentProxy,
  docB: PDFDocumentProxy,
  opts: { png?: string; threshold?: number } = {},
): Promise<CompareSummary> {
  const threshold = opts.threshold ?? 24;
  const sheets: CompareSheetResult[] = [];
  const changedSheets: number[] = [];
  const pairs = Math.min(docA.numPages, docB.numPages);

  for (let p = 1; p <= pairs; p++) {
    const pageA = await docA.getPage(p);
    const vp1 = pageA.getViewport({ scale: 1 });
    const w = Math.max(1, Math.round(vp1.width * COMPARE_SCALE));
    const h = Math.max(1, Math.round(vp1.height * COMPARE_SCALE));
    const ra = await rasterizeToNode(docA, p, w, h);
    const rb = await rasterizeToNode(docB, p, w, h);
    const { mask, changedPx } = diffMask(ra, rb, { threshold });
    const fraction = changedPx / Math.max(1, w * h);
    const changed = fraction > CHANGED_SHEET_FRACTION;
    const regions = changed
      ? maskRegions(mask, w, h, 16 * COMPARE_SCALE).map((r) => ({
          xPt: Math.round(r.x / COMPARE_SCALE),
          yPt: Math.round(r.y / COMPARE_SCALE),
          wPt: Math.round(r.w / COMPARE_SCALE),
          hPt: Math.round(r.h / COMPARE_SCALE),
        }))
      : [];
    // born-digital sheets: say exactly what changed, not just where pixels differ
    const [va, vb] = await Promise.all([vectorDocPage(docA, p).catch(() => null), vectorDocPage(docB, p).catch(() => null)]);
    const vector = va && vb && va.segs.length && vb.segs.length ? vectorDiff(va, vb) : undefined;
    const [wa, wb] = await Promise.all([pageWords(docA, p).catch(() => []), pageWords(docB, p).catch(() => [])]);
    const text = wa.length || wb.length ? textDiff(wa, wb) : undefined;
    sheets.push({
      page: p,
      widthPt: Math.round(vp1.width),
      heightPt: Math.round(vp1.height),
      changedFraction: Math.round(fraction * 10000) / 10000,
      changed,
      regions,
      ...(vector
        ? { vector: { ...vector, moved: capList(vector.moved), regions: capList(vector.regions), totals: { moved: vector.moved.length, regions: vector.regions.length } } }
        : {}),
      ...(text
        ? {
            text: {
              changed: capList(text.changed),
              added: capList(text.added),
              removed: capList(text.removed),
              totals: { changed: text.changed.length, added: text.added.length, removed: text.removed.length },
            },
          }
        : {}),
    });
    if (changed) changedSheets.push(p);

    if (opts.png && changedSheets.length === 1) {
      const out = new Uint8ClampedArray(ra.width * ra.height * 4);
      blendOverlay(ra, rb, 0, 0, false, out);
      const cnv = createCanvas(ra.width, ra.height);
      const ctx = cnv.getContext('2d');
      const img = ctx.createImageData(ra.width, ra.height);
      img.data.set(out);
      ctx.putImageData(img, 0, 0);
      writeFileSync(opts.png, cnv.toBuffer('image/png'));
    }
  }

  return {
    comparedSheets: pairs,
    changedSheets,
    summary: {
      changed: changedSheets.length,
      unchanged: pairs - changedSheets.length,
      onlyInA: docA.numPages > pairs ? docA.numPages - pairs : 0,
      onlyInB: docB.numPages > pairs ? docB.numPages - pairs : 0,
    },
    sheets,
  };
}

// --- quantity delta: re-run a saved takeoff on the next revision ---

export interface QuantityDelta {
  counts: { page: number; label: string; a: number; b: number; delta: number }[];
  areas: { page: number; label: string; aPt2: number; bPt2: number | null; changePct: number | null; note?: string }[];
  notReMeasured: { type: string; markups: number }[];
}

/**
 * A point inside a polygon, also when it is concave (an L-shaped room's
 * vertex mean can fall outside it): the middle of the widest inside span on
 * a horizontal line through the vertex mean, else through mid-height.
 */
function interiorPoint(points: Pt[]): Pt {
  const mean = { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
  const ys = points.map((p) => p.y);
  for (const y of [mean.y, (Math.min(...ys) + Math.max(...ys)) / 2, mean.y + 0.25 * (Math.max(...ys) - mean.y), mean.y - 0.25 * (mean.y - Math.min(...ys))]) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    let best: Pt | null = null;
    let width = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > width) {
        width = xs[i + 1] - xs[i];
        best = { x: (xs[i] + xs[i + 1]) / 2, y };
      }
    }
    if (best) return best;
  }
  return mean;
}

/** The sheet's printed scale (text layer), as metres per PDF point. */
async function sheetMetersPerPt(doc: PDFDocumentProxy, page: number): Promise<number | undefined> {
  const hit = findScaleRatio(await pageWords(doc, page).catch(() => []), 'text layer');
  return hit ? metersPerPtForRatio(hit.ratio) : undefined;
}

function polyAreaPt2(points: Pt[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Re-run the pdf2takeoff markups saved in revision A on revision B: each
 * counted symbol type is re-scanned on B from its first instance, each area
 * is re-filled on B from a point inside it (Dynamic Fill with labels, vector
 * doorway bridges and the sheet's printed scale, so doorways close as they
 * did in A). Lengths and other drawn measures can't be re-derived from a
 * point, so they are listed as not re-measured.
 */
export async function quantityDelta(docA: PDFDocumentProxy, docB: PDFDocumentProxy): Promise<QuantityDelta> {
  const markups = await readMarkups(docA);
  const counts: QuantityDelta['counts'] = [];
  const areas: QuantityDelta['areas'] = [];
  const other = new Map<string, number>();
  const groups = new Map<string, Markup[]>();
  for (const m of markups) {
    if (m.type === 'count') {
      const k = `${m.page}\u0000${m.label}`;
      const g = groups.get(k);
      if (g) g.push(m);
      else groups.set(k, [m]);
    } else if (m.type !== 'area') {
      other.set(m.type, (other.get(m.type) ?? 0) + 1);
    }
  }
  for (const g of groups.values()) {
    const { page, label } = g[0];
    let b = 0;
    if (page <= docB.numPages) {
      const r = await scanDocAt(docB, page, g[0].points[0]).catch(() => null);
      b = r && !('error' in r) ? r.hits.length : 0;
    }
    counts.push({ page, label, a: g.length, b, delta: b - g.length });
  }
  // everything a re-fill needs from a B sheet, prepared once per sheet
  const sheets = new Map<number, Promise<FillHints & { raster: Awaited<ReturnType<typeof renderRasterNode>> }>>();
  const sheet = (page: number) => {
    let s = sheets.get(page);
    if (!s) {
      s = (async () => {
        const [raster, mppB, mppA] = await Promise.all([renderRasterNode(docB, page, RASTER_SCALE), sheetMetersPerPt(docB, page), sheetMetersPerPt(docA, page)]);
        return { raster, ...(await fillHintsFor(docB, page, raster, { metersPerPt: mppB ?? mppA })) };
      })();
      sheets.set(page, s);
    }
    return s;
  };
  for (const m of markups.filter((x) => x.type === 'area')) {
    const aPt2 = polyAreaPt2(m.points);
    if (m.page > docB.numPages) {
      areas.push({ page: m.page, label: m.label, aPt2, bPt2: null, changePct: null, note: 'sheet missing in B' });
      continue;
    }
    const { raster, ...hints } = await sheet(m.page);
    const r = dynamicFill(raster, interiorPoint(m.points), undefined, hints);
    if ('error' in r) {
      areas.push({ page: m.page, label: m.label, aPt2, bPt2: null, changePct: null, note: r.error });
      continue;
    }
    const bPt2 = polyAreaPt2(r.points);
    areas.push({ page: m.page, label: m.label, aPt2: Math.round(aPt2), bPt2: Math.round(bPt2), changePct: Math.round(((bPt2 - aPt2) / aPt2) * 1000) / 10 });
  }
  return { counts, areas, notReMeasured: [...other.entries()].map(([type, n]) => ({ type, markups: n })) };
}

// --- batch compare across folders ---

/** PDFs and PNG / JPG scans under a folder, recursively. */
function listDrawings(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.pdf') || imageKindByExt(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** The sheet a file stands for: its basename without the .pdf / .png / .jpg extension, so a scan pairs with the PDF of the same sheet. */
export function sheetStem(file: string): string {
  return basename(file).replace(/\.(pdf|png|jpe?g)$/i, '');
}

export interface FolderPairResult {
  sheet: string; // file stem (basename without extension)
  aPages: number;
  bPages: number;
  changedSheets: number[];
  summary: { changed: number; unchanged: number; onlyInA: number; onlyInB: number };
}

export interface FolderCompareResult {
  a: string;
  b: string;
  pairs: FolderPairResult[];
  addedInB: string[]; // sheets only in the newer set
  removedFromA: string[]; // sheets only in the older set
  totals: { pairs: number; changed: number; unchanged: number };
  notes: string[];
}

/** Recursively pair PDFs and images across two revision folders by file stem and diff every pair. */
export async function compareFolders(
  dirA: string,
  dirB: string,
  opts: { pngDir?: string; threshold?: number } = {},
): Promise<FolderCompareResult> {
  const byBase = (dir: string) => {
    const map = new Map<string, string[]>();
    for (const f of listDrawings(dir)) {
      const key = sheetStem(f);
      map.set(key, [...(map.get(key) ?? []), f]);
    }
    return map;
  };
  const a = byBase(dirA);
  const b = byBase(dirB);
  const notes: string[] = [];
  for (const [side, map] of [
    ['a', a],
    ['b', b],
  ] as const) {
    for (const [key, files] of map) {
      if (files.length > 1) notes.push(`${side}: ${files.length} files share the name "${key}"; using the first (${files[0]})`);
    }
  }

  const pairs: FolderPairResult[] = [];
  let changed = 0;
  let unchanged = 0;
  for (const sheet of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const fa = a.get(sheet)?.[0];
    const fb = b.get(sheet)?.[0];
    if (fa && !fb) continue; // handled by removedFromA below
    if (!fa && fb) continue;
    const { doc: docA } = await openAny(fa!);
    const { doc: docB } = await openAny(fb!);
    const result = await compareDocs(docA, docB, {
      threshold: opts.threshold,
      ...(opts.pngDir ? { png: join(opts.pngDir, `${sheet}-overlay.png`) } : {}),
    });
    pairs.push({
      sheet,
      aPages: docA.numPages,
      bPages: docB.numPages,
      changedSheets: result.changedSheets,
      summary: result.summary,
    });
    if (result.summary.changed > 0) changed++;
    else unchanged++;
  }

  return {
    a: dirA,
    b: dirB,
    pairs,
    addedInB: [...b.keys()].filter((k) => !a.has(k)).sort(),
    removedFromA: [...a.keys()].filter((k) => !b.has(k)).sort(),
    totals: { pairs: pairs.length, changed, unchanged },
    notes,
  };
}

/** Scan a symbol across every page; pages without it count 0. */
export async function scanDocAllPages(doc: PDFDocumentProxy, at: Pt, opts: ScanOptions = {}) {
  const pages: { page: number; count: number }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const result = await scanDocAt(doc, p, at, opts);
      pages.push({ page: p, count: 'error' in result ? 0 : result.hits.length });
    } catch {
      pages.push({ page: p, count: 0 });
    }
  }
  return { pages, total: pages.reduce((s, x) => s + x.count, 0) };
}
