// Quantity serialization: markups → matrix → CSV / clipboard / Excel.
// Everything here is pure data transformation; hosts add file delivery.

import type { Calibration, Markup, MarkupType } from './types.ts';
import type { DisplayUnit } from './units.ts';
import { markupLength, markupArea, markupPerimeter, markupVolume, markupAngle } from './geometry.ts';
import { formatLength, formatArea, formatVolume } from './units.ts';
import { evaluateFormula } from './formula.ts';
import { resolveCalibration, type Viewport } from './viewports.ts';

export interface CustomColumn {
  name: string;
  formula: string; // over vars: value (this row's quantity), count
  unit: string;
}

export interface TakeoffData {
  markups: Markup[];
  calibrations: Map<number, Calibration>;
  displayUnit: DisplayUnit;
  columns?: CustomColumn[];
  viewports?: Viewport[];
}

export type Matrix = (string | number)[][];

export interface Group {
  type: MarkupType;
  label: string;
  items: Markup[];
}

export function groupsOf(markups: Markup[]): Group[] {
  const map = new Map<string, Group>();
  for (const m of markups) {
    const key = `${m.type}|${m.label}`;
    let g = map.get(key);
    if (!g) {
      g = { type: m.type, label: m.label, items: [] };
      map.set(key, g);
    }
    g.items.push(m);
  }
  return [...map.values()];
}

/**
 * A group's total with each markup at its own scale: one label can span
 * pages, or viewports, drawn at different scales. `total` is null when no
 * item can be totalled (angles and notes never are); `uncalibrated` counts
 * the items left out because their page has no scale yet.
 */
export function groupTotal(
  g: Group,
  calFor: (m: Markup) => Calibration | undefined,
): { total: number | null; uncalibrated: number } {
  // Links are user-authored references only. They never change quantities.
  if (g.type === 'count') {
    return { total: g.items.reduce((sum, m) => sum + (m.timesing ?? 1) * (m.sign ?? 1), 0), uncalibrated: 0 };
  }
  if (g.type === 'angle' || g.type === 'note') return { total: null, uncalibrated: 0 };
  let total = 0;
  let counted = 0;
  let uncalibrated = 0;
  for (const m of g.items) {
    const cal = calFor(m);
    if (!cal) {
      uncalibrated++;
      continue;
    }
    counted++;
    const factor = (m.timesing ?? 1) * (m.sign ?? 1);
    if (g.type === 'length') total += markupLength(m, cal.metersPerPt) * factor;
    else if (g.type === 'perimeter') total += markupPerimeter(m, cal.metersPerPt) * factor;
    else if (g.type === 'volume') total += markupVolume(m, cal.metersPerPt) * factor;
    else total += markupArea(m, cal.metersPerPt) * factor;
  }
  return { total: counted ? total : null, uncalibrated };
}

/** Geometry-derived quantity before per-entry timesing/sign adjustments. */
export function baseQuantity(m: Markup, cal: Calibration | undefined): number | null {
  if (m.type === 'note') return null;
  if (m.type === 'count') return 1;
  if (m.type === 'angle') return markupAngle(m);
  if (!cal) return null;
  if (m.type === 'length') return markupLength(m, cal.metersPerPt);
  if (m.type === 'perimeter') return markupPerimeter(m, cal.metersPerPt);
  if (m.type === 'volume') return markupVolume(m, cal.metersPerPt);
  return markupArea(m, cal.metersPerPt);
}

/** Per-entry adjusted quantity = geometry × timesing × sign. */
export function adjustedQuantity(m: Markup, cal: Calibration | undefined): number | null {
  const base = baseQuantity(m, cal);
  return base === null ? null : base * (m.timesing ?? 1) * (m.sign ?? 1);
}

export function valueParts(
  m: Markup,
  cal: Calibration | undefined,
  u: DisplayUnit,
): { value: string; unit: string } {
  const base = u === 'ft-in' ? 'ft' : u;
  const value = adjustedQuantity(m, cal);
  if (m.type === 'note' || value === null) return { value: '', unit: '' };
  if (m.type === 'count') return { value: String(value), unit: 'each' };
  if (m.type === 'angle') return { value: String(value), unit: 'deg' };
  if (m.type === 'length' || m.type === 'perimeter') return { value: String(value), unit: base };
  if (m.type === 'volume') return { value: String(value), unit: `${base}3` };
  return { value: String(value), unit: `${base}2` };
}

/** Formatted single-markup adjusted value ('' when the page isn't calibrated). */
export function formatMarkupValue(m: Markup, cal: Calibration | undefined, u: DisplayUnit): string {
  const value = adjustedQuantity(m, cal);
  if (m.type === 'note' || value === null) return '';
  if (m.type === 'angle') return `${value.toFixed(1)}°`;
  if (m.type === 'count') return String(value);
  if (m.type === 'perimeter' || m.type === 'length') return formatLength(value, u);
  if (m.type === 'volume') return formatVolume(value, u);
  return formatArea(value, u);
}

/** Items + group totals as a matrix, shared by CSV / clipboard / Excel / report. */
export function buildMatrix(d: TakeoffData): Matrix {
  const cols = d.columns ?? [];
  const header = ['Label', 'Type', 'Page', 'Value', 'Unit', 'Timesing', 'Sign', 'Base quantity', 'Adjusted quantity', 'Parameters', 'Remarks', 'Links', 'Status', 'Layer', ...cols.map((c) => c.name)];
  const rows: Matrix = [header];
  const round = (n: number) => Math.round(n * 10000) / 10000;
  for (const m of d.markups) {
    const cal = m.calibration ?? resolveCalibration(m, d.calibrations, d.viewports);
    const { value, unit } = valueParts(m, cal, d.displayUnit);
    const base = baseQuantity(m, cal);
    const adjusted = adjustedQuantity(m, cal);
    const numeric = adjusted;
    const extras = cols.map((c) => {
      const out = evaluateFormula(c.formula, { value: numeric ?? 0, count: 1 });
      return out === null ? 'ERR' : round(out);
    });
    const params = Object.entries(m.parameters ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ');
    const links = (m.links ?? []).map((link) => {
      const target = d.markups.find((item) => item.id === link.markupId);
      return `${link.logic?.trim() || link.note?.trim() || link.relation?.trim() || 'Linked to'}: ${target?.label ?? link.markupId}`;
    }).join('; ');
    rows.push([
      m.label, m.type, m.page, value === '' ? '' : Number(value), unit,
      m.timesing ?? 1, (m.sign ?? 1) > 0 ? '+' : '−',
      base === null ? '' : round(base), adjusted === null ? '' : round(adjusted),
      params, m.remarks ?? '', links, m.status ?? '', m.layer ?? '', ...extras,
    ]);
  }
  const gs = groupsOf(d.markups);
  if (gs.length) {
    rows.push([]);
    rows.push(['Group', 'Type', 'Items', 'Total', 'Unit', '', '', '', '', '', '', '', 'Status', 'Layer', ...cols.map((col) => col.name)]);
    for (const g of gs) {
      const calFor = (m: Markup) => m.calibration ?? resolveCalibration(m, d.calibrations, d.viewports);
      const cal = calFor(g.items[0]);
      // each item at its own scale; a group with any unscaled item has no honest total
      const sum = groupTotal(g, calFor);
      const total: string | number = sum.total !== null && !sum.uncalibrated ? sum.total : '';
      const unit = g.type === 'count' ? 'each' : valueParts(g.items[0], cal, d.displayUnit).unit;
      const confirmed = g.items.filter((m) => m.status === 'confirmed').length;
      const numeric = typeof total === 'number' ? total : null;
      const extras = cols.map((c) => {
        const out = evaluateFormula(c.formula, { value: numeric ?? 0, count: g.items.length });
        return out === null ? 'ERR' : round(out);
      });
      rows.push([g.label, g.type, g.items.length, total, unit, '', '', '', '', '', '', '', confirmed ? `${confirmed}/${g.items.length} confirmed` : '', '', ...extras]);
    }
  }
  return rows;
}

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toDelimited(matrix: Matrix, sep: string): string {
  return matrix.map((row) => row.map((c) => csvEscape(String(c))).join(sep)).join('\n');
}

/** One-sheet workbook ("Takeoff") as xlsx bytes. */
export async function xlsxBytes(matrix: Matrix): Promise<Uint8Array> {
  // lazy: loading xlsx costs about 53 ms, and most runs never export
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  ws['!cols'] = [{ wch: 24 }, { wch: 8 }, { wch: 6 }, { wch: 12 }, { wch: 8 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Takeoff');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Uint8Array(out);
}

/** FNV-1a over a sampled stride of the bytes — fast on 100 MB files. */
export function fileHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  const stride = Math.max(1, Math.floor(bytes.length / 65536));
  for (let i = 0; i < bytes.length; i += stride) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${bytes.length.toString(36)}-${h.toString(36)}`;
}
