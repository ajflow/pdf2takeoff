// Scan provider, tier 2: trained symbol detector running fully in-page via
// onnxruntime-web (WASM). The library is dynamically imported, so it is only
// downloaded when a scan actually happens and the model files exist.
//
// To ship a model: drop `symbols.onnx` + `symbols.json` into public/models/
// (see that folder's README). Until then detectorStatus() is false and the
// app transparently uses the tier-1 CV scan.
//
// The user's mental model stays "click one, count them all": the detector
// runs page-wide, then keeps only the class of the detection nearest the
// click, so a click on a downlight returns every downlight, pre-labelled.

import type { Pt } from './state';
import type { ScanHit, ScanResult } from './scan';
import { renderRaster, RASTER_SCALE } from './scan-cv';

const ORT_VERSION = '1.30.0'; // keep in lockstep with package.json
const DEFAULT_SCORE = 0.25;
const DEFAULT_IOU = 0.45;
const MAX_DET = 500;

export class DetectorDown extends Error {}

interface Manifest {
  model: string; // file name inside /models/, e.g. "symbols-yolox-nano.onnx"
  input: number; // square input size, e.g. 416
  classes: string[]; // index -> class name
  score?: number;
  iou?: number;
  // 'yolox-raw': output rows are [x1,y1,x2,y2,obj,cls...] and the score is
  //   obj * cls (official YOLOX export). 'mmdet': scores are already
  //   combined, obj column is ~1.
  head?: 'yolox-raw' | 'mmdet';
}

type Ort = typeof import('onnxruntime-web');

let statusPromise: Promise<boolean> | null = null;
let session: { ort: Ort; s: import('onnxruntime-web').InferenceSession; m: Manifest } | null = null;

export function detectorStatus(): Promise<boolean> {
  statusPromise ??= probe();
  return statusPromise;
}

async function probe(): Promise<boolean> {
  try {
    await getEngine();
    return true;
  } catch (e) {
    // missing manifest/model is the normal, expected state — stay quiet
    if (!(e instanceof DetectorDown)) console.warn('tier-2 detector unavailable', e);
    return false;
  }
}

async function getEngine() {
  if (session) return session;
  const base = import.meta.env.BASE_URL;
  let res: Response;
  try {
    res = await fetch(`${base}models/symbols.json`, { cache: 'no-cache' });
  } catch {
    throw new DetectorDown('offline');
  }
  if (!res.ok) throw new DetectorDown('no manifest');
  const m = (await res.json()) as Manifest;
  if (!m?.model || !Array.isArray(m.classes) || m.classes.length === 0) {
    throw new DetectorDown('bad manifest');
  }
  m.input = m.input || 416;
  m.score = m.score ?? DEFAULT_SCORE;
  m.iou = m.iou ?? DEFAULT_IOU;
  m.head = m.head ?? 'yolox-raw';

  const ort: Ort = await import('onnxruntime-web');
  // no COOP/COEP headers on static hosting -> no SharedArrayBuffer, no threads
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  try {
    const s = await ort.InferenceSession.create(`${base}models/${m.model}`, {
      executionProviders: ['wasm'],
    });
    session = { ort, s, m };
    return session;
  } catch (e) {
    // broken model file: downgrade for the rest of the session
    statusPromise = Promise.resolve(false);
    throw new DetectorDown('session failed');
  }
}

export async function detectorScan(pageNum: number, clicked: Pt): Promise<ScanResult> {
  const engine = await getEngine();
  const { ort, s, m } = engine;

  const { canvas: pageCnv, viewport: vp } = await renderRaster(pageNum, RASTER_SCALE);
  const w = pageCnv.width;
  const h = pageCnv.height;

  // letterbox to the model's square input, white padding
  const S = m.input!;
  const scale = Math.min(S / w, S / h);
  const dw = (S - w * scale) / 2;
  const dh = (S - h * scale) / 2;
  const cnv = document.createElement('canvas');
  cnv.width = S;
  cnv.height = S;
  const ctx = cnv.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(pageCnv, dw, dh, w * scale, h * scale);
  const px = ctx.getImageData(0, 0, S, S).data;

  // HWC RGBA -> CHW RGB floats
  const data = new Float32Array(3 * S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const src = (y * S + x) * 4;
      data[0 * S * S + y * S + x] = px[src] / 255;
      data[1 * S * S + y * S + x] = px[src + 1] / 255;
      data[2 * S * S + y * S + x] = px[src + 2] / 255;
    }
  }

  const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, S, S]) };
  const out = await s.run(feeds);
  const tensor = out[s.outputNames[0]];
  const dims = tensor.dims as number[];
  const arr = tensor.data as Float32Array;

  // YOLOX exports are [1, N, 5+C]; tolerate a transposed [1, 5+C, N]
  const rows = dims[2] >= dims[1] ? dims[1] : dims[2];
  const stride = dims[2] >= dims[1] ? dims[2] : dims[1];
  const rowMajor = dims[2] >= dims[1];
  const nCls = stride - 5;
  const at = (r: number, c: number) => (rowMajor ? arr[r * stride + c] : arr[c * rows + r]);

  interface Det {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    score: number;
    cls: number;
  }
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
    const score = m.head === 'mmdet' ? bestP : obj * bestP;
    if (score < m.score!) continue;
    dets.push({
      x1: at(r, 0),
      y1: at(r, 1),
      x2: at(r, 2),
      y2: at(r, 3),
      score,
      cls: bestC,
    });
  }

  // per-class NMS
  dets.sort((a, b) => b.score - a.score);
  const keep = new Set<number>();
  for (let i = 0; i < dets.length && keep.size < MAX_DET; i++) {
    if (keep.has(i)) continue;
    keep.add(i);
    for (let j = i + 1; j < dets.length; j++) {
      if (keep.has(j) || dets[j].cls !== dets[i].cls) continue;
      const ix1 = Math.max(dets[i].x1, dets[j].x1);
      const iy1 = Math.max(dets[i].y1, dets[j].y1);
      const ix2 = Math.min(dets[i].x2, dets[j].x2);
      const iy2 = Math.min(dets[i].y2, dets[j].y2);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const a1 = (dets[i].x2 - dets[i].x1) * (dets[i].y2 - dets[i].y1);
      const a2 = (dets[j].x2 - dets[j].x1) * (dets[j].y2 - dets[j].y1);
      if (inter / Math.max(1e-6, a1 + a2 - inter) > m.iou!) keep.add(j);
    }
  }

  // letterbox px -> PDF points (viewport transform is uniform for 0/90/180/270)
  const toPdf = (x: number, y: number): Pt => {
    const rx = (x - dw) / scale;
    const ry = (y - dh) / scale;
    const [px2, py2] = vp.convertToPdfPoint(rx, ry);
    return { x: px2, y: py2 };
  };

  const kept = [...keep].map((i) => dets[i]);
  if (kept.length === 0) {
    return { error: 'the detector found no symbols on this sheet; try the classic scan' };
  }

  // class of the detection nearest the click
  let nearest = kept[0];
  let nd = Infinity;
  for (const d of kept) {
    const c = toPdf((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
    const dist = (c.x - clicked.x) ** 2 + (c.y - clicked.y) ** 2;
    if (dist < nd) {
      nd = dist;
      nearest = d;
    }
  }

  const hits: ScanHit[] = kept
    .filter((d) => d.cls === nearest.cls)
    .map((d) => {
      const c = toPdf((d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
      return { x: c.x, y: c.y, label: m.classes[d.cls] ?? `symbol ${d.cls}`, score: d.score };
    });

  // stable numbering: reading order, rows then columns
  hits.sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
  return {
    hits,
    provider: 'detector',
    note: `${m.classes[nearest.cls]} · ${m.model}`,
  };
}
