// Takeoff spec loading (YAML) for the annotate command. H4 extends this
// with scan classes and exports; H2 supports explicit geometry.

import { load } from 'js-yaml';
import { PRESET_SCALES, metersPerPtForRatio } from '../engine/units.ts';
import type { MarkupType } from '../engine/types.ts';

export interface SpecMarkup {
  type: MarkupType;
  label?: string;
  page?: number; // 1-based, default 1
  points: [number, number][]; // PDF points
}

export interface TakeoffSpec {
  output?: string;
  unit?: string; // DisplayUnit
  scale?: string; // "1:100" or a PRESET_SCALES label
  markups: SpecMarkup[];
}

export interface SpecCount {
  label: string;
  page?: number; // 1-based, default 1
  /** teach the scan from one instance, PDF points (pre-model path) */
  at: [number, number];
  /** ONNX class name — activates automatically once a model ships */
  class?: string;
}

export type SpecExportFormat = 'csv' | 'xlsx' | 'annotated-pdf' | 'summary';

export interface SpecExport {
  format: SpecExportFormat;
  out: string;
}

export interface RunSpec {
  source: string;
  scale?: string;
  unit?: string;
  counts: SpecCount[];
  exports: SpecExport[];
}

export function parseRunSpec(text: string, source: string): RunSpec {
  let doc: unknown;
  try {
    doc = load(text);
  } catch (e) {
    throw new Error(`${source}: invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof doc !== 'object' || doc === null) throw new Error(`${source}: spec must be a YAML mapping`);
  const spec = doc as Partial<RunSpec>;
  if (typeof spec.source !== 'string' || !spec.source) throw new Error(`${source}: "source" (path to the PDF) is required`);
  if (spec.scale !== undefined && typeof spec.scale !== 'string') throw new Error(`${source}: "scale" must be a string like "1:100"`);
  if (!Array.isArray(spec.counts) || spec.counts.length === 0) throw new Error(`${source}: "counts" needs at least one entry`);
  spec.counts.forEach((c, i) => {
    if (c == null || typeof c !== 'object') throw new Error(`${source}: counts[${i}] must be a mapping`);
    if (typeof c.label !== 'string' || !c.label) throw new Error(`${source}: counts[${i}].label is required`);
    if (!Array.isArray(c.at) || c.at.length !== 2 || !c.at.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`${source}: counts[${i}].at must be [x, y] in PDF points (run "info" then "scan" once to find a symbol)`);
    }
    if (c.page != null && (!Number.isInteger(c.page) || c.page < 1)) throw new Error(`${source}: counts[${i}].page must be a positive integer`);
  });
  if (!Array.isArray(spec.exports) || spec.exports.length === 0) throw new Error(`${source}: "exports" needs at least one entry`);
  spec.exports.forEach((e, i) => {
    if (e == null || typeof e !== 'object') throw new Error(`${source}: exports[${i}] must be a mapping`);
    if (!['csv', 'xlsx', 'annotated-pdf', 'summary'].includes(e.format)) {
      throw new Error(`${source}: exports[${i}].format must be csv, xlsx, annotated-pdf or summary`);
    }
    if (typeof e.out !== 'string' || !e.out) throw new Error(`${source}: exports[${i}].out is required`);
  });
  return spec as RunSpec;
}

export function parseSpec(text: string, source: string): TakeoffSpec {
  let doc: unknown;
  try {
    doc = load(text);
  } catch (e) {
    throw new Error(`${source}: invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof doc !== 'object' || doc === null) throw new Error(`${source}: spec must be a YAML mapping`);
  const spec = doc as Partial<TakeoffSpec>;
  if (!Array.isArray(spec.markups) || spec.markups.length === 0) {
    throw new Error(`${source}: spec needs a non-empty "markups" list`);
  }
  spec.markups.forEach((m, i) => {
    if (m == null || typeof m !== 'object') throw new Error(`${source}: markups[${i}] must be a mapping`);
    if (m.type !== 'length' && m.type !== 'area' && m.type !== 'count') {
      throw new Error(`${source}: markups[${i}].type must be length, area or count`);
    }
    if (!Array.isArray(m.points) || m.points.length === 0) {
      throw new Error(`${source}: markups[${i}].points must be a list of [x, y] pairs`);
    }
    if (m.type !== 'count' && m.points.length < 2) {
      throw new Error(`${source}: markups[${i}]: ${m.type} needs at least 2 points`);
    }
    if (m.type === 'count' && m.points.length !== 1) {
      throw new Error(`${source}: markups[${i}]: count needs exactly 1 point`);
    }
    m.points.forEach((p, j) => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        throw new Error(`${source}: markups[${i}].points[${j}] must be [x, y] numbers`);
      }
    });
    if (m.page != null && (!Number.isInteger(m.page) || m.page < 1)) {
      throw new Error(`${source}: markups[${i}].page must be a positive integer`);
    }
  });
  return spec as TakeoffSpec;
}

/** "1:100" → metres/point; also accepts preset labels like 1/4" = 1'-0". */
export function parseScaleSpec(s: string): number {
  const preset = PRESET_SCALES.find((p) => p.label === s.trim());
  if (preset) return metersPerPtForRatio(preset.ratio);
  const m = s.trim().match(/^1:(\d+(?:\.\d+)?)$/);
  if (m) return metersPerPtForRatio(parseFloat(m[1]));
  throw new Error(`cannot parse scale "${s}" — use a ratio like 1:100 or a preset label`);
}
