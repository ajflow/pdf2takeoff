// Tier-2 scan host adapter: loads the trained symbol detector running fully
// in-page via onnxruntime-web (WASM) when /models/ carries symbols.json + the
// model file, and wraps it in the engine's DetectorSession port. The library
// is dynamically imported, so it is only downloaded when a scan actually
// happens and the model files exist.
//
// To ship a model: drop `symbols.onnx` + `symbols.json` into public/models/
// (see that folder's README). Until then detectorStatus() resolves null and
// the engine transparently uses the tier-1 CV scan.

import type { DetectorSession } from '../engine/ports';

const ORT_VERSION = '1.30.0'; // keep in lockstep with package.json
const DEFAULT_SCORE = 0.25;
const DEFAULT_IOU = 0.45;

interface Manifest {
  model: string; // file name inside /models/, e.g. "symbols-yolox-nano.onnx"
  input: number; // square input size, e.g. 416
  classes: string[]; // index -> class name
  score?: number;
  iou?: number;
  // 'yolox-raw': output rows are [x1,y1,x2,y2,obj,cls...] and the score is
  //   obj * cls (official YOLOX export). 'mmdet': scores are already combined,
  //   obj column is ~1.
  head?: 'yolox-raw' | 'mmdet';
  // Tiled inference (see specs/detector-tiling.md): pxPerPt is the effective
  //   pixels-per-point at model input the model was trained for. Absent ⇒
  //   whole-page letterbox (v1 behavior).
  tile?: { pxPerPt: number; overlapPx: number };
}

type Ort = typeof import('onnxruntime-web');

/** Expected unavailability (no/broken model) — probe stays quiet about these. */
class Unavailable extends Error {}

let statusPromise: Promise<DetectorSession | null> | null = null;
let session: DetectorSession | null = null;

export function detectorStatus(): Promise<DetectorSession | null> {
  statusPromise ??= probe();
  return statusPromise;
}

async function probe(): Promise<DetectorSession | null> {
  try {
    return await getEngine();
  } catch (e) {
    // missing manifest/model is the normal, expected state — stay quiet
    if (!(e instanceof Unavailable)) console.warn('tier-2 detector unavailable', e);
    return null;
  }
}

async function getEngine(): Promise<DetectorSession> {
  if (session) return session;
  const base = import.meta.env.BASE_URL;
  let res: Response;
  try {
    res = await fetch(`${base}models/symbols.json`, { cache: 'no-cache' });
  } catch {
    throw new Unavailable('offline');
  }
  if (!res.ok) throw new Unavailable('no manifest');
  const m = (await res.json()) as Manifest;
  if (!m?.model || !Array.isArray(m.classes) || m.classes.length === 0) {
    throw new Unavailable('bad manifest');
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
    // absolute model URLs are allowed for CORS-enabled hosts (e.g. a
    // raw.githubusercontent.com model branch); relative names stay same-origin
    const modelUrl = /^https?:\/\//.test(m.model) ? m.model : `${base}models/${m.model}`;
    const s = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
    });
    session = {
      inputSize: m.input,
      classes: m.classes,
      score: m.score,
      iou: m.iou,
      head: m.head,
      modelName: m.model,
      tile: m.tile && m.tile.pxPerPt > 0 ? { pxPerPt: m.tile.pxPerPt, overlapPx: m.tile.overlapPx ?? 0 } : undefined,
      run: async (input, size) => {
        const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) };
        const out = await s.run(feeds);
        const tensor = out[s.outputNames[0]];
        return { data: tensor.data as Float32Array, dims: tensor.dims as number[] };
      },
    };
    return session;
  } catch {
    // broken model file: downgrade for the rest of the session
    statusPromise = Promise.resolve(null);
    throw new Unavailable('session failed');
  }
}
