// Central application state with a tiny subscribe/emit store. Measurement
// math and data types live in the engine (src/engine); this module re-exports
// them so UI modules have one familiar import site.

import type { DisplayUnit } from '../engine/units';
import type { Calibration, Markup, MarkupType, Pt } from '../engine/types';
import type { Viewport } from '../engine/viewports';
import { resolveCalibration } from '../engine/viewports';
import { paperFactor } from '../engine/inputs';
import { metersPerPtForRatio, ratioForMetersPerPt } from '../engine/units';
import type { CustomColumn, TakeoffData } from '../engine/export';

export type { Calibration, Markup, MarkupType, Pt };
export { markupLength, markupArea, distPt, defaultLabel, nextId } from '../engine/geometry';

export type ToolId = 'pan' | 'calibrate' | 'viewport' | 'length' | 'area' | 'count' | 'perimeter' | 'volume' | 'angle' | 'note' | 'fill' | 'scan';

export interface ToolPreset {
  type: MarkupType;
  label: string;
}

/** What the sheet says about a page's scale once it is set (Flow State scale chip). */
export interface ScaleCheck {
  status: 'agrees' | 'disagrees' | 'doors-ok' | 'doors-bad';
  /** The explanation to show when the check disagrees. */
  message?: string;
}

export interface AppState {
  fileName: string;
  fileBytes: Uint8Array | null; // original bytes, kept for save-with-annotations
  pageCount: number;
  pageNum: number; // 1-based
  zoom: number;
  fit: 'width' | null;
  displayUnit: DisplayUnit;
  tool: ToolId;
  calibrations: Map<number, Calibration>;
  /** Pages that came from an image, with the scan resolution it stated (0 = paper size unknown). */
  imagePages: Map<number, number>;
  /** Per page: whether the printed scale or the doorways agree with the calibration. */
  scaleChecks: Map<number, ScaleCheck>;
  /** The quantity row selected in the panel: its markups stay bright, the rest fade. */
  focusLabel: string | null;
  markups: Markup[];
  selectedId: string | null;
  /** last reversible action, so Ctrl+Z can restore a drag before falling back to delete-newest */
  lastAction: { kind: 'move'; id: string; before: Pt[] } | null;
  presets: ToolPreset[];
  activePreset: ToolPreset | null;
  columns: CustomColumn[];
  viewports: Viewport[];
  listFilter: {
    status: 'all' | 'none' | 'check' | 'confirmed';
    text: string;
    sort: 'added' | 'label' | 'page';
  };
}

export const state: AppState = {
  fileName: '',
  fileBytes: null,
  pageCount: 0,
  pageNum: 1,
  zoom: 1,
  fit: 'width',
  displayUnit: 'm',
  tool: 'pan',
  calibrations: new Map(),
  imagePages: new Map(),
  scaleChecks: new Map(),
  focusLabel: null,
  markups: [],
  selectedId: null,
  lastAction: null,
  presets: [],
  activePreset: null,
  columns: [],
  viewports: [],
  listFilter: { status: 'all', text: '', sort: 'added' },
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(): void {
  for (const fn of listeners) fn();
}

/**
 * Metres per page point for a printed ratio (1:100) on a page, or null when
 * the page came from an image that doesn't say how big its paper was: a
 * ratio needs the paper size, so those pages are calibrated from a dimension.
 */
export function metersPerPtForRatioOn(page: number, ratio: number): number | null {
  const f = paperFactor(state.imagePages, page);
  return f === null ? null : metersPerPtForRatio(ratio) * f;
}

/** The printed ratio a scale amounts to on a page, or null when its paper size is unknown. */
export function ratioOn(page: number, metersPerPt: number): number | null {
  const f = paperFactor(state.imagePages, page);
  return f === null ? null : ratioForMetersPerPt(metersPerPt) / f;
}

export function calibrationFor(page: number): Calibration | undefined {
  return state.calibrations.get(page);
}

/** Calibration for a markup, honouring viewports (per-region scales). */
export function calibrationForMarkup(m: Markup): Calibration | undefined {
  return resolveCalibration(m, state.calibrations, state.viewports);
}

/** Everything the engine needs to serialize this session's takeoff. */
export function takeoffData(): TakeoffData {
  return {
    markups: state.markups,
    calibrations: state.calibrations,
    displayUnit: state.displayUnit,
    columns: state.columns,
    viewports: state.viewports,
  };
}
