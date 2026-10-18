// Tier-2 scan host adapter for Node: the headless twin of src/app/onnx-detector.ts.
// Loads `symbols.json` + the model file from a local directory and wraps an
// onnxruntime-web session (its Node entry runs the WASM backend without a
// browser, so no extra dependency is installed) in the engine's
// DetectorSession port. The CLI, the MCP server and the benches all reach the
// detector through scanDocAt in ops.ts, which calls loadDetectorNode().
//
// Where the model comes from, first match wins:
//   1. an explicit directory (`pdf2takeoff scan --model <dir>`, MCP `model_dir`)
//   2. the PDF2TAKEOFF_MODEL_DIR environment variable
//   3. public/models/ in this checkout, only when it actually holds the model
// A manifest whose `model` is an http(s) URL (the browser's CORS-enabled
// release branch) is read as "<dir>/<basename of the URL>": the CLI makes no
// network calls, so the binary has to be on disk. With no model anywhere the
// loader resolves null and the engine runs the tier-1 CV scan, unchanged.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DetectorSession } from '../engine/ports.ts';

export const MODEL_DIR_ENV = 'PDF2TAKEOFF_MODEL_DIR';
export const MANIFEST_NAME = 'symbols.json';
const DEFAULT_SCORE = 0.25;
const DEFAULT_IOU = 0.45;
const DEFAULT_INPUT = 416;
/** public/models/ relative to this file (src/headless/). */
const DEFAULT_MODEL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'models');

interface Manifest {
  model: string;
  input?: number;
  classes: string[];
  score?: number;
  iou?: number;
  head?: 'yolox-raw' | 'mmdet';
  tile?: { pxPerPt: number; overlapPx?: number; maxSymbolPt?: number };
}

export interface ModelLocation {
  dir: string;
  manifest: string;
  model: string;
  /** which rule picked the directory */
  source: 'explicit' | 'env' | 'default';
}

/** The directory a --model argument names: a file path (manifest or .onnx) means its folder. */
function asDir(path: string): string {
  const p = resolve(path);
  if (existsSync(p) && statSync(p).isFile()) return dirname(p);
  if (!existsSync(p) && /\.(json|onnx)$/i.test(extname(p))) return dirname(p);
  return p;
}

function readManifest(dir: string): Manifest | null {
  const file = join(dir, MANIFEST_NAME);
  if (!existsSync(file)) return null;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (!m || typeof m.model !== 'string' || !Array.isArray(m.classes) || m.classes.length === 0) {
    throw new Error(`${file}: manifest needs "model" and a non-empty "classes" list`);
  }
  return m;
}

/** Path of the model binary a manifest names, local to its directory. */
function modelPath(dir: string, m: Manifest): string {
  const name = /^https?:\/\//i.test(m.model) ? basename(new URL(m.model).pathname) : m.model;
  return resolve(dir, name);
}

/**
 * Find a model directory. An explicit directory or PDF2TAKEOFF_MODEL_DIR that
 * lacks the files is an error (the user asked for a model); the default
 * directory is silently skipped when it holds only the manifest.
 */
export function locateModel(explicitDir?: string): ModelLocation | null {
  const env = process.env[MODEL_DIR_ENV];
  const candidates: { dir: string; source: ModelLocation['source'] }[] = [];
  if (explicitDir) candidates.push({ dir: asDir(explicitDir), source: 'explicit' });
  else if (env) candidates.push({ dir: asDir(env), source: 'env' });
  else candidates.push({ dir: DEFAULT_MODEL_DIR, source: 'default' });
  for (const c of candidates) {
    const m = readManifest(c.dir);
    const model = m ? modelPath(c.dir, m) : join(c.dir, 'symbols.onnx');
    const ok = m !== null && existsSync(model);
    if (ok) return { dir: c.dir, manifest: join(c.dir, MANIFEST_NAME), model, source: c.source };
    if (c.source !== 'default') {
      const why = m ? `model file ${model} is missing` : `no ${MANIFEST_NAME} in ${c.dir}`;
      throw new Error(`${c.source === 'env' ? MODEL_DIR_ENV : '--model'}: ${why}`);
    }
  }
  return null;
}

const sessions = new Map<string, Promise<DetectorSession | null>>();

/**
 * Load the detector for a model directory (see locateModel). Sessions are
 * cached per directory, so a multi-page scan or a bench loads the model once.
 * Resolves null when no model is present.
 */
export function loadDetectorNode(explicitDir?: string): Promise<DetectorSession | null> {
  const loc = locateModel(explicitDir);
  if (!loc) return Promise.resolve(null);
  let s = sessions.get(loc.model);
  if (!s) {
    s = createSession(loc).catch((err) => {
      sessions.delete(loc.model);
      throw err;
    });
    sessions.set(loc.model, s);
  }
  return s;
}

async function createSession(loc: ModelLocation): Promise<DetectorSession> {
  const m = readManifest(loc.dir)!;
  const ort = await import('onnxruntime-web');
  // the Node entry of onnxruntime-web runs the WASM backend in-process; keep
  // it single threaded and un-proxied like the browser adapter so the two
  // environments stay bit-identical
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const bytes = new Uint8Array(readFileSync(loc.model));
  const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  const input = s.inputNames[0];
  const output = s.outputNames[0];
  if (!input || !output) throw new Error(`${loc.model}: model has no input or output`);
  return {
    inputSize: m.input || DEFAULT_INPUT,
    classes: m.classes,
    score: m.score ?? DEFAULT_SCORE,
    iou: m.iou ?? DEFAULT_IOU,
    head: m.head ?? 'yolox-raw',
    modelName: basename(loc.model),
    tile:
      m.tile && m.tile.pxPerPt > 0
        ? {
            pxPerPt: m.tile.pxPerPt,
            overlapPx: m.tile.overlapPx ?? 0,
            ...(m.tile.maxSymbolPt && m.tile.maxSymbolPt > 0 ? { maxSymbolPt: m.tile.maxSymbolPt } : {}),
          }
        : undefined,
    run: async (data, size) => {
      const out = await s.run({ [input]: new ort.Tensor('float32', data, [1, 3, size, size]) });
      const t = out[output];
      return { data: t.data as Float32Array, dims: t.dims as number[] };
    },
  };
}
