// Scan provider, tier 2: decode + geometry half of a trained symbol detector.
// The host loads the ONNX model (see DetectorSession in ports.ts) and supplies
// the rasterized page; this module does the deterministic parts — preprocessing
// (whole-page letterbox, or square windows when the manifest declares tiling),
// output decoding, per-class NMS, and mapping detections back to PDF points —
// so browser and Node runs produce identical results.
//
// The user's mental model stays "click one, count them all": the detector
// runs page-wide, then keeps only the class of the detection nearest the
// click, so a click on a downlight returns every downlight, pre-labelled.

import { RASTER_SCALE } from './ports.ts';
import type { Pt, ScanHit, ScanResult } from './types.ts';
import type { DetectorSession, RasterPage } from './ports.ts';

/** Hits returned for the clicked class; more sets `truncated` on the result. */
const MAX_HITS = 2000;
/**
 * Safety valve on windows that actually run (blank ones are skipped): a
 * broken tile config must not loop the page into oblivion. An A0 sheet at
 * 3 px/pt with 416 px windows is about 513 windows before skipping.
 */
const MAX_WINDOWS = 4096;
/** Largest symbol assumed when the manifest does not say (PDF pt, ~10.6 mm). */
const DEFAULT_MAX_SYMBOL_PT = 30;
/** Boxes this close (raster px) to an interior tile edge count as cut off. */
const EDGE_EPS = 2;
/** Cross-tile merge threshold on intersection over the smaller box. */
const CROSS_IOS = 0.5;

/** A square tile of the raster, raster px, top-left origin. */
interface Win {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/**
 * Letterbox a raster (or a tile of it) into the model's square input
 * (white padding) and pack it as CHW RGB floats in [0,1]. Pure bilinear
 * resampling — no canvas — so every environment produces bit-identical
 * inputs. Returns the inverse transform (input px → raster px) so decoded
 * boxes can be mapped back through the same geometry.
 */
function letterboxCHW(
  r: RasterPage,
  S: number,
  win?: Win,
): { input: Float32Array; scale: number; dw: number; dh: number; ox: number; oy: number } {
  const ox = win?.x0 ?? 0;
  const oy = win?.y0 ?? 0;
  const ww = win?.w ?? r.width;
  const wh = win?.h ?? r.height;
  const scale = Math.min(S / ww, S / wh);
  const dw = (S - ww * scale) / 2;
  const dh = (S - wh * scale) / 2;
  const input = new Float32Array(3 * S * S);
  const src = r.data;
  const sw = r.width;
  const sh = r.height;
  const sample = (fx: number, fy: number, ch: number): number => {
    // bilinear with clamped weights; anything outside the page area is white
    if (fx < -0.5 || fy < -0.5 || fx > sw - 0.5 || fy > sh - 0.5) return 255;
    const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const x1 = Math.min(sw - 1, x0 + 1);
    const y1 = Math.min(sh - 1, y0 + 1);
    const tx = Math.min(1, Math.max(0, fx - x0));
    const ty = Math.min(1, Math.max(0, fy - y0));
    const i00 = (y0 * sw + x0) * 4 + ch;
    const i10 = (y0 * sw + x1) * 4 + ch;
    const i01 = (y1 * sw + x0) * 4 + ch;
    const i11 = (y1 * sw + x1) * 4 + ch;
    const top = src[i00] + (src[i10] - src[i00]) * tx;
    const bot = src[i01] + (src[i11] - src[i01]) * tx;
    return top + (bot - top) * ty;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = (x - dw) / scale + ox;
      const fy = (y - dh) / scale + oy;
      const i0 = y * S + x;
      input[i0] = sample(fx, fy, 0) / 255;
      input[S * S + i0] = sample(fx, fy, 1) / 255;
      input[2 * S * S + i0] = sample(fx, fy, 2) / 255;
    }
  }
  return { input, scale, dw, dh, ox, oy };
}

/**
 * Tile grid for tiled inference. The tile side W is chosen so the
 * resample to inputSize lands the manifest's pxPerPt at model input — the
 * scale the model was trained for. Positions are spaced evenly with at
 * least the requested overlap, and the final tile is edge-aligned so the
 * sheet border is never cut off. The overlap is raised to 1.25x the largest
 * symbol so every symbol lies whole, clear of interior edges, in at least
 * one tile; that is what makes dropping edge-cut boxes safe.
 */
function tileWindows(
  r: RasterPage,
  S: number,
  tile: { pxPerPt: number; overlapPx: number; maxSymbolPt?: number },
): { wins: Win[]; edgeSafe: boolean } {
  // the raster arrives at RASTER_SCALE px/pt (see scan.ts / ops.ts)
  const W = Math.max(64, Math.round((S * RASTER_SCALE) / tile.pxPerPt));
  const symbolPx = (tile.maxSymbolPt ?? DEFAULT_MAX_SYMBOL_PT) * RASTER_SCALE;
  const needed = Math.ceil(1.25 * symbolPx + 2 * EDGE_EPS);
  // the manifest's own overlap is honoured up to W - 1; the automatic raise
  // stops at half a tile so the tile count stays sane
  const overlap = Math.min(W - 1, Math.max(0, tile.overlapPx, Math.min(needed, Math.floor(W / 2))));
  const stride = Math.max(1, W - overlap);
  const axis = (len: number): number[] => {
    if (len <= W) return [0];
    const n = Math.ceil((len - W) / stride) + 1;
    const step = (len - W) / (n - 1);
    return Array.from({ length: n }, (_, i) => Math.round(i * step));
  };
  const wins: Win[] = [];
  for (const y of axis(r.height)) for (const x of axis(r.width)) wins.push({ x0: x, y0: y, w: W, h: W });
  // dropping edge-cut boxes is only safe when every symbol fits whole in some tile
  return { wins, edgeSafe: overlap >= needed };
}

interface Det {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  cls: number;
  /** index of the tile the detection came from */
  win?: number;
}

/** True when a tile holds no ink at all (sampled every other pixel). */
function blankWindow(r: RasterPage, win: Win): boolean {
  const x1 = Math.min(r.width, win.x0 + win.w);
  const y1 = Math.min(r.height, win.y0 + win.h);
  const d = r.data;
  for (let y = win.y0; y < y1; y += 2) {
    for (let x = win.x0, i = (y * r.width + x) * 4; x < x1; x += 2, i += 8) {
      if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) return false;
    }
  }
  return true;
}

/**
 * A box touching an interior tile edge (one shared with a neighbour, not
 * the sheet border) is a cut-off fragment of a symbol that a neighbouring
 * tile sees whole, given tileWindows' overlap rule.
 */
function touchesInteriorEdge(d: Det, win: Win, r: RasterPage): boolean {
  const right = win.x0 + win.w;
  const bottom = win.y0 + win.h;
  return (
    (win.x0 > 0 && d.x1 <= win.x0 + EDGE_EPS) ||
    (win.y0 > 0 && d.y1 <= win.y0 + EDGE_EPS) ||
    (right < r.width && d.x2 >= right - EDGE_EPS) ||
    (bottom < r.height && d.y2 >= bottom - EDGE_EPS)
  );
}

/** Decode raw output rows [x1,y1,x2,y2,obj,cls...] into score-filtered Dets. */
function decodeRows(arr: Float32Array, dims: number[], det: DetectorSession): Det[] {
  // Rows are [x1,y1,x2,y2,obj,cls...] in [1, N, 5+C] (or a transposed
  // [1, 5+C, N]). Anchor the row width to the manifest's class count —
  // picking it by "larger dim" misorients [1, N, 5+C] whenever N > 5+C.
  const rowW = 5 + det.classes.length;
  const stride = dims.includes(rowW) ? rowW : Math.max(dims[1] ?? 0, dims[2] ?? 1);
  const rows = Math.floor(arr.length / stride);
  const rowMajor = dims[dims.length - 1] === stride;
  const nCls = stride - 5;
  const at = (r: number, c: number) => (rowMajor ? arr[r * stride + c] : arr[c * rows + r]);
  const dets: Det[] = [];
  for (let r = 0; r < rows; r++) {
    const obj = at(r, 4);
    let bestC = -1;
    let bestP = 0;
    for (let c = 0; c < nCls; c++) {
      const p = at(r, 5 + c);
      if (p > bestP) {
        bestP = p;
        bestC = c;
      }
    }
    const score = det.head === 'mmdet' ? bestP : obj * bestP;
    if (score < det.score) continue;
    dets.push({ x1: at(r, 0), y1: at(r, 1), x2: at(r, 2), y2: at(r, 3), score, cls: bestC });
  }
  return dets;
}

/**
 * Per-class greedy suppression, best score first. Boxes from the same tile
 * use IoU (so neighbouring symbols in a row survive); boxes from different
 * windows also merge when either covers half the other (intersection over
 * the smaller box, as SAHI does), which collapses a truncated duplicate
 * into the whole one.
 */
function nmsPerClass(dets: Det[], iou: number): Det[] {
  const areaOf = (d: Det) => (d.x2 - d.x1) * (d.y2 - d.y1);
  // best score first; on ties the larger box leads, so a whole symbol
  // anchors the merge rather than a fragment of it
  dets.sort((a, b) => b.score - a.score || areaOf(b) - areaOf(a));
  const suppressed = new Uint8Array(dets.length);
  const kept: Det[] = [];
  for (let i = 0; i < dets.length; i++) {
    if (suppressed[i]) continue;
    const a = { ...dets[i] };
    kept.push(a);
    // across tiles the kept box grows to the union of what it absorbs (as
    // SAHI's merge does), and the pass repeats while it grows, so every
    // fragment of a symbol cut by tiles in both directions meets it
    for (let grew = true; grew; ) {
      grew = false;
      for (let j = i + 1; j < dets.length; j++) {
        const b = dets[j];
        if (suppressed[j] || b.cls !== a.cls) continue;
        const ix1 = Math.max(a.x1, b.x1);
        const iy1 = Math.max(a.y1, b.y1);
        const ix2 = Math.min(a.x2, b.x2);
        const iy2 = Math.min(a.y2, b.y2);
        const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
        if (inter === 0) continue;
        const a1 = areaOf(a);
        const a2 = areaOf(b);
        const sameObject = inter / Math.max(1e-6, a1 + a2 - inter) > iou;
        const crossTile = a.win !== b.win;
        if (!sameObject && !(crossTile && inter / Math.max(1e-6, Math.min(a1, a2)) > CROSS_IOS)) continue;
        suppressed[j] = 1;
        if (!crossTile) continue;
        if (b.x1 < a.x1 || b.y1 < a.y1 || b.x2 > a.x2 || b.y2 > a.y2) grew = true;
        a.x1 = Math.min(a.x1, b.x1);
        a.y1 = Math.min(a.y1, b.y1);
        a.x2 = Math.max(a.x2, b.x2);
        a.y2 = Math.max(a.y2, b.y2);
      }
    }
  }
  return kept;
}

export async function detectorScan(
  raster: RasterPage,
  clicked: Pt,
  det: DetectorSession,
): Promise<ScanResult> {
  const S = det.inputSize;
  const grid = det.tile ? tileWindows(raster, S, det.tile) : null;
  const all = grid ? grid.wins : [undefined];
  const windows = det.tile ? all.filter((w) => w && !blankWindow(raster, w)) : all;
  if (windows.length > MAX_WINDOWS) {
    throw new Error(`tile config yields ${windows.length} non-blank tiles (max ${MAX_WINDOWS})`);
  }

  // collect detections from every tile, mapped into raster px so boxes
  // from different windows share one coordinate space before suppression;
  // boxes cut off by an interior tile edge are dropped here
  const dets: Det[] = [];
  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi];
    const { input, scale, dw, dh, ox, oy } = letterboxCHW(raster, S, win);
    const { data: arr, dims } = await det.run(input, S);
    for (const d of decodeRows(arr, dims, det)) {
      const m: Det = {
        x1: (d.x1 - dw) / scale + ox,
        y1: (d.y1 - dh) / scale + oy,
        x2: (d.x2 - dw) / scale + ox,
        y2: (d.y2 - dh) / scale + oy,
        score: d.score,
        cls: d.cls,
        win: wi,
      };
      // with too little overlap for that guarantee, keep fragments and let
      // the cross-tile merge collapse them instead
      if (win && grid?.edgeSafe && touchesInteriorEdge(m, win, raster)) continue;
      dets.push(m);
    }
  }
  if (dets.length === 0) {
    return { error: 'the detector found no symbols on this sheet; try the classic scan' };
  }

  // class of the detection nearest the click, chosen before any suppression
  // or cap so a busy sheet of other symbols can't crowd it out
  let nearest = dets[0];
  let nd = Infinity;
  for (const d of dets) {
    const c = raster.toPdf((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
    const dist = (c.x - clicked.x) ** 2 + (c.y - clicked.y) ** 2;
    if (dist < nd) {
      nd = dist;
      nearest = d;
    }
  }

  const kept = nmsPerClass(
    dets.filter((d) => d.cls === nearest.cls),
    det.iou,
  );
  const truncated = kept.length > MAX_HITS;
  const hits: ScanHit[] = kept.slice(0, MAX_HITS).map((d) => {
    const c = raster.toPdf((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
    return { x: c.x, y: c.y, label: det.classes[d.cls] ?? `symbol ${d.cls}`, score: d.score };
  });

  // stable numbering: reading order, rows then columns
  hits.sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
  return {
    hits,
    provider: 'detector',
    note: `${det.classes[nearest.cls]} · ${det.modelName}${truncated ? ` · first ${MAX_HITS} of ${kept.length}, count truncated` : ''}`,
    ...(truncated ? { truncated: true } : {}),
  };
}
