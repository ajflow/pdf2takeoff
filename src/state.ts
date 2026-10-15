// Central application state with a tiny subscribe/emit store.

export type Pt = { x: number; y: number };

export type ToolId = 'pan' | 'calibrate' | 'length' | 'area' | 'count' | 'scan';

export type MarkupType = 'length' | 'area' | 'count';

export interface Markup {
  id: string;
  page: number; // 1-based
  type: MarkupType;
  label: string;
  points: Pt[]; // PDF user space (origin bottom-left)
  createdAt: number;
}

export interface Calibration {
  metersPerPt: number;
  source: string; // e.g. 'measured 12.00 m' or 'preset 1:100'
}

export interface AppState {
  fileName: string;
  fileBytes: Uint8Array | null; // original bytes, kept for save-with-annotations
  pageCount: number;
  pageNum: number; // 1-based
  zoom: number;
  fit: 'width' | null;
  displayUnit: import('./units').DisplayUnit;
  tool: ToolId;
  calibrations: Map<number, Calibration>;
  markups: Markup[];
  selectedId: string | null;
  /** last reversible action, so Ctrl+Z can restore a drag before falling back to delete-newest */
  lastAction: { kind: 'move'; id: string; before: Pt[] } | null;
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
  markups: [],
  selectedId: null,
  lastAction: null,
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

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function calibrationFor(page: number): Calibration | undefined {
  return state.calibrations.get(page);
}

/** Length of a markup's geometry in metres, or null if the page isn't calibrated. */
export function markupLength(m: Markup, metersPerPt: number): number {
  let total = 0;
  for (let i = 1; i < m.points.length; i++) {
    total += distPt(m.points[i - 1], m.points[i]);
  }
  return total * metersPerPt;
}

export function markupArea(m: Markup, metersPerPt: number): number {
  const pts = m.points;
  const n = pts.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  const areaPt = Math.abs(sum) / 2;
  const mPerPt = metersPerPt;
  return areaPt * mPerPt * mPerPt;
}

export function distPt(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function defaultLabel(type: MarkupType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
