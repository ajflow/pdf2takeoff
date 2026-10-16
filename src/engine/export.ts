// Quantity serialization: markups → matrix → CSV / clipboard / Excel.
// Everything here is pure data transformation; hosts add file delivery.

import * as XLSX from 'xlsx';
import type { Calibration, Markup, MarkupType } from './types.ts';
import type { DisplayUnit } from './units.ts';
import { markupLength, markupArea } from './geometry.ts';
import { formatLength, formatArea } from './units.ts';

export interface TakeoffData {
  markups: Markup[];
  calibrations: Map<number, Calibration>;
  displayUnit: DisplayUnit;
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

export function valueParts(
  m: Markup,
  cal: Calibration | undefined,
  u: DisplayUnit,
): { value: string; unit: string } {
  const base = u === 'ft-in' ? 'ft' : u;
  if (m.type === 'count') return { value: '1', unit: 'each' };
  if (!cal) return { value: '', unit: '' };
  if (m.type === 'length') return { value: String(markupLength(m, cal.metersPerPt)), unit: base };
  return { value: String(markupArea(m, cal.metersPerPt)), unit: `${base}2` };
}

/** Formatted single-markup value ('' when the page isn't calibrated). */
export function formatMarkupValue(m: Markup, cal: Calibration | undefined, u: DisplayUnit): string {
  if (!cal) return '';
  if (m.type === 'count') return '1';
  return m.type === 'length'
    ? formatLength(markupLength(m, cal.metersPerPt), u)
    : formatArea(markupArea(m, cal.metersPerPt), u);
}

/** Items + group totals as a matrix, shared by CSV / clipboard / Excel / report. */
export function buildMatrix(d: TakeoffData): Matrix {
  const rows: Matrix = [['Label', 'Type', 'Page', 'Value', 'Unit']];
  for (const m of d.markups) {
    const { value, unit } = valueParts(m, d.calibrations.get(m.page), d.displayUnit);
    rows.push([m.label, m.type, m.page, value === '' ? '' : Number(value), unit]);
  }
  const gs = groupsOf(d.markups);
  if (gs.length) {
    rows.push([]);
    rows.push(['Group', 'Type', 'Items', 'Total', '']);
    for (const g of gs) {
      const cal = d.calibrations.get(g.items[0].page);
      let total: string | number = '';
      if (g.type === 'count') {
        total = g.items.length;
      } else if (cal) {
        total = g.items.reduce(
          (s, m) => s + (g.type === 'length' ? markupLength(m, cal.metersPerPt) : markupArea(m, cal.metersPerPt)),
          0,
        );
      }
      const unit = g.type === 'count' ? 'each' : valueParts(g.items[0], cal, d.displayUnit).unit;
      rows.push([g.label, g.type, g.items.length, total, unit]);
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
export function xlsxBytes(matrix: Matrix): Uint8Array {
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
