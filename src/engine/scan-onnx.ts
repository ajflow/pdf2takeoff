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

const MAX_DET = 500;
/** Safety valve: a broken tile config must not loop the page into oblivion. */
const MAX_WINDOWS = 512;

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
 * sheet border is never cut off.
 */
function tileWindows(
  r: RasterPage,
  S: number,
  tile: { pxPerPt: number; overlapPx: number },
): Win[] {
  // the raster arrives at RASTER_SCALE px/pt (see scan.ts / ops.ts)
  const W = Math.max(64, Math.round((S * RASTER_SCALE) / tile.pxPerPt));
  const overlap = Math.min(W - 1, Math.max(0, tile.overlapPx));
  const stride = Math.max(1, W - overlap);
  const axis = (len: number): number[] => {
    if (len <= W) return [0];
    const n = Math.ceil((len - W) / stride) + 1;
    const step = (len - W) / (n - 1);
    return Array.from({ length: n }, (_, i) => Math.round(i * step));
  };
  const wins: Win[] = [];
  for (const y of axis(r.height)) for (const x of axis(r.width)) wins.push({ x0: x, y0: y, w: W, h: W });
  return wins;
}

interface Det {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  cls: number;
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

/** Per-class NMS, best-score first, capped at MAX_DET detections. */
function nmsPerClass(dets: Det[], iou: number): Det[] {
  dets.sort((a, b) => b.score - a.score);
  const suppressed = new Set<number>();
  const kept: Det[] = [];
  for (let i = 0; i < dets.length && kept.length < MAX_DET; i++) {
    if (suppressed.has(i)) continue;
    kept.push(dets[i]);
    for (let j = i + 1; j < dets.length; j++) {
      if (suppressed.has(j) || dets[j].cls !== dets[i].cls) continue;
      const ix1 = Math.max(dets[i].x1, dets[j].x1);
      const iy1 = Math.max(dets[i].y1, dets[j].y1);
      const ix2 = Math.min(dets[i].x2, dets[j].x2);
      const iy2 = Math.min(dets[i].y2, dets[j].y2);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const a1 = (dets[i].x2 - dets[i].x1) * (dets[i].y2 - dets[i].y1);
      const a2 = (dets[j].x2 - dets[j].x1) * (dets[j].y2 - dets[j].y1);
      if (inter / Math.max(1e-6, a1 + a2 - inter) > iou) suppressed.add(j);
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
  const windows = det.tile ? tileWindows(raster, S, det.tile) : [undefined];
  if (windows.length > MAX_WINDOWS) {
    throw new Error(`tile config yields ${windows.length} windows (max ${MAX_WINDOWS})`);
  }

  // collect detections from every tile, mapped into raster px so boxes
  // from different windows share one coordinate space before NMS
  const dets: Det[] = [];
  for (const win of windows) {
    const { input, scale, dw, dh, ox, oy } = letterboxCHW(raster, S, win);
    const { data: arr, dims } = await det.run(input, S);
    for (const d of decodeRows(arr, dims, det)) {
      dets.push({
        x1: (d.x1 - dw) / scale + ox,
        y1: (d.y1 - dh) / scale + oy,
        x2: (d.x2 - dw) / scale + ox,
        y2: (d.y2 - dh) / scale + oy,
        score: d.score,
        cls: d.cls,
      });
    }
  }

  const kept = nmsPerClass(dets, det.iou);
  if (kept.length === 0) {
    return { error: 'the detector found no symbols on this sheet; try the classic scan' };
  }

  // class of the detection nearest the click
  let nearest = kept[0];
  let nd = Infinity;
  for (const d of kept) {
    const c = raster.toPdf((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
    const dist = (c.x - clicked.x) ** 2 + (c.y - clicked.y) ** 2;
    if (dist < nd) {
      nd = dist;
      nearest = d;
    }
  }

  const hits: ScanHit[] = kept
    .filter((d) => d.cls === nearest.cls)
    .map((d) => {
      const c = raster.toPdf((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
      return { x: c.x, y: c.y, label: det.classes[d.cls] ?? `symbol ${d.cls}`, score: d.score };
    });

  // stable numbering: reading order, rows then columns
  hits.sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
  return {
    hits,
    provider: 'detector',
    note: `${det.classes[nearest.cls]} · ${det.modelName}`,
  };
}
