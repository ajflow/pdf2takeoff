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
