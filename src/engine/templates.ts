// Takeoff templates: a trade's price sheet as an ordered list of line items.
// Loading one adds a labelled tool preset per line, so every markup lands on
// the right line as it is measured; the summary then lists every line in
// the sheet's own order, 0 where nothing was measured, ready to paste
// straight into an estimating spreadsheet's quantity column.

import type { Calibration, Markup, MarkupType } from './types.ts';
import { groupsOf, groupTotal, type Matrix } from './export.ts';

export interface TemplateItem {
  /** the price sheet's own wording, used as the markup label */
  label: string;
  /** the tool that measures it */
  type: MarkupType;
  /** the unit the summary reports in */
  unit: string;
  /** multiplies the measured total (a wall-paint line measured as length × wall height) */
  factor?: number;
  /** how the line is measured, when it is not obvious */
  note?: string;
}

export interface TakeoffTemplate {
  id: string;
  name: string;
  description: string;
  items: TemplateItem[];
}

export const TAKEOFF_TEMPLATES: readonly TakeoffTemplate[] = [
  {
    id: 'fitout',
    name: 'Commercial fit-out',
    description: 'Partition walls, ceilings, bulkheads, doors by type, windows, mirrors and feature paint',
    items: [
      { label: 'Walls', type: 'length', unit: 'm', note: 'new partition walls, lineal metres' },
      { label: 'Ceilings (Plasterboard)', type: 'area', unit: 'm²' },
      { label: 'Bulkheads', type: 'area', unit: 'm²' },
      { label: 'Grid Ceiling', type: 'area', unit: 'm²' },
      { label: 'Doors (Timber)', type: 'count', unit: 'no.' },
      { label: 'Doors (Aluminium)', type: 'count', unit: 'no.' },
      { label: 'Doors (Frameless)', type: 'count', unit: 'no.' },
      { label: 'Windows', type: 'length', unit: 'm' },
      { label: 'Mirrors', type: 'area', unit: 'm²' },
      { label: 'Feature Wall Paint', type: 'length', unit: 'm²', factor: 2.7, note: 'wall length × 2.7 m height' },
    ],
  },
  {
    id: 'electrical',
    name: 'Electrical',
    description: 'Light fittings, power and data points, switches, smoke alarms and cable runs',
    items: [
      { label: 'Downlights', type: 'count', unit: 'no.' },
      { label: 'Light fittings (other)', type: 'count', unit: 'no.' },
      { label: 'GPOs (double)', type: 'count', unit: 'no.' },
      { label: 'GPOs (single)', type: 'count', unit: 'no.' },
      { label: 'Switches', type: 'count', unit: 'no.' },
      { label: 'Data points', type: 'count', unit: 'no.' },
      { label: 'Smoke alarms', type: 'count', unit: 'no.' },
      { label: 'Exhaust fans', type: 'count', unit: 'no.' },
      { label: 'Cable runs', type: 'length', unit: 'm' },
    ],
  },
  {
    id: 'painting',
    name: 'Painting',
    description: 'Wall and ceiling paint, doors, frames and skirting',
    items: [
      { label: 'Wall paint', type: 'length', unit: 'm²', factor: 2.7, note: 'wall length × 2.7 m height' },
      { label: 'Ceiling paint', type: 'area', unit: 'm²' },
      { label: 'Doors (paint both faces)', type: 'count', unit: 'no.' },
      { label: 'Door frames', type: 'count', unit: 'no.' },
      { label: 'Skirting', type: 'length', unit: 'm' },
    ],
  },
];

export function templateById(id: string | null | undefined): TakeoffTemplate | undefined {
  return TAKEOFF_TEMPLATES.find((t) => t.id === id);
}

export interface TemplateLine {
  label: string;
  quantity: number;
  unit: string;
  /** markups on this line left out because their page has no scale yet */
  uncalibrated: number;
  note?: string;
}

/**
 * Every line of the template, in its order, totalled from the markups that
 * carry its label and tool (labels match ignoring case and spacing). Lines
 * nothing was measured for come out 0, which is a real answer on a price
 * sheet. Each markup is totalled at its own scale.
 */
export function templateSummary(t: TakeoffTemplate, markups: Markup[], calFor: (m: Markup) => Calibration | undefined): TemplateLine[] {
  const key = (type: MarkupType, label: string) => `${type}|${label.trim().replace(/\s+/g, ' ').toLowerCase()}`;
  // labels that differ only in case or spacing are one line: their groups add up
  const totals = new Map<string, { total: number; uncalibrated: number }>();
  for (const g of groupsOf(markups)) {
    const k = key(g.type, g.label);
    const { total, uncalibrated } = groupTotal(g, calFor);
    const acc = totals.get(k) ?? { total: 0, uncalibrated: 0 };
    acc.total += total ?? 0;
    acc.uncalibrated += uncalibrated;
    totals.set(k, acc);
  }
  return t.items.map((item) => {
    const { total, uncalibrated } = totals.get(key(item.type, item.label)) ?? { total: 0, uncalibrated: 0 };
    const quantity = Math.round(total * (item.factor ?? 1) * 100) / 100;
    return { label: item.label, quantity, unit: item.unit, uncalibrated, ...(item.note ? { note: item.note } : {}) };
  });
}

/** The summary as a sheet: one row per line, in the template's order. */
export function templateMatrix(t: TakeoffTemplate, lines: TemplateLine[], title: string): Matrix {
  const rows: Matrix = [[`${t.name} takeoff: ${title}`], [], ['Item', 'Quantity', 'Unit', 'Note']];
  for (const l of lines) {
    const notes = [l.note, l.uncalibrated ? `${l.uncalibrated} markup${l.uncalibrated === 1 ? '' : 's'} not counted: page not calibrated` : ''].filter(Boolean).join('; ');
    rows.push([l.label, l.quantity, l.unit, notes]);
  }
  return rows;
}
