// Document operations shared by the CLI and the MCP server: one code path
// for scanning, comparing and annotation reading, whatever drives it.

import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createCanvas } from '@napi-rs/canvas';
import { renderRasterNode, rasterizeToNode } from './raster-node.ts';
import { openPdf } from './pdfjs-node.ts';
import { RASTER_SCALE } from '../engine/ports.ts';
import { cvScan } from '../engine/scan-cv.ts';
import { vectorScan } from '../engine/scan-vector.ts';
import { vectorize } from '../engine/vector.ts';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseMarkups, type AnnotationLike } from '../engine/read.ts';
import { blendOverlay } from '../engine/compare.ts';
import { diffMask, maskRegions } from '../engine/diff.ts';
import type { Markup, Pt } from '../engine/types.ts';
import { vectorDiff, textDiff, type VectorDiff, type TextDiff } from '../engine/revdiff.ts';
import { findScaleRatio, roomLabelPoints, wordsFromTextItem } from '../engine/ocr.ts';
import { metersPerPtForRatio } from '../engine/units.ts';
import { dynamicFill } from '../engine/dynamicfill.ts';
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

/** Scan at a click point (PDF points): vector match on born-digital symbols, else tier-1 CV. */
export async function scanDocAt(doc: PDFDocumentProxy, page: number, at: Pt) {
  const vec = await vectorDocPage(doc, page).catch(() => null);
  const byVector = vec ? vectorScan(vec, at) : null;
  if (byVector) return byVector;
  const raster = await renderRasterNode(doc, page, RASTER_SCALE);
  return cvScan(raster, at);
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
  /** exact geometry diff when both sheets are vector (born-digital) */
  vector?: VectorDiff;
  /** text-layer diff: printed values changed in place, words added or removed */
  text?: TextDiff;
}

/** Text-layer words of a page (empty for scans). */
async function pageWords(doc: PDFDocumentProxy, page: number) {
  const tc = await (await doc.getPage(page)).getTextContent();
  return (tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[]).flatMap((it) =>
    wordsFromTextItem(typeof it.str === 'string' ? it.str : '', it.transform, it.width, it.height),
  );
}

/** Keep diff listings readable: first n entries plus a count of the rest. */
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
      ...(vector ? { vector: { ...vector, moved: capList(vector.moved), regions: capList(vector.regions) } } : {}),
      ...(text ? { text: { changed: capList(text.changed), added: capList(text.added), removed: capList(text.removed) } } : {}),
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
  for (const m of markups.filter((x) => x.type === 'area')) {
    const aPt2 = polyAreaPt2(m.points);
    if (m.page > docB.numPages) {
      areas.push({ page: m.page, label: m.label, aPt2, bPt2: null, changePct: null, note: 'sheet missing in B' });
      continue;
    }
    const c = interiorPoint(m.points);
    const metersPerPt = (await sheetMetersPerPt(docB, m.page)) ?? (await sheetMetersPerPt(docA, m.page));
    const raster = await renderRasterNode(docB, m.page, RASTER_SCALE);
    const items = (await (await docB.getPage(m.page)).getTextContent()).items as { str?: string; transform?: number[]; width?: number; height?: number }[];
    const bridges = doorBridgesFor(await vectorDocPage(docB, m.page), metersPerPt);
    const r = dynamicFill(raster, c, undefined, { labels: roomLabelPoints(items), bridges, ...(metersPerPt ? { metersPerPt } : {}) });
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

function listPdfs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.pdf')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

export interface FolderPairResult {
  sheet: string; // basename
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

/** Recursively pair PDFs across two revision folders by filename and diff every pair. */
export async function compareFolders(
  dirA: string,
  dirB: string,
  opts: { pngDir?: string; threshold?: number } = {},
): Promise<FolderCompareResult> {
  const byBase = (dir: string) => {
    const map = new Map<string, string[]>();
    for (const f of listPdfs(dir)) {
      const key = basename(f);
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
    const docA = await openPdf(new Uint8Array(readFileSync(fa!)));
    const docB = await openPdf(new Uint8Array(readFileSync(fb!)));
    const result = await compareDocs(docA, docB, {
      threshold: opts.threshold,
      ...(opts.pngDir ? { png: join(opts.pngDir, `${sheet.replace(/\.pdf$/i, '')}-overlay.png`) } : {}),
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
export async function scanDocAllPages(doc: PDFDocumentProxy, at: Pt) {
  const pages: { page: number; count: number }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    try {
      const result = await scanDocAt(doc, p, at);
      pages.push({ page: p, count: 'error' in result ? 0 : result.hits.length });
    } catch {
      pages.push({ page: p, count: 0 });
    }
  }
  return { pages, total: pages.reduce((s, x) => s + x.count, 0) };
}
