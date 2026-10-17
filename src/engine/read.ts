// Read pdf2takeoff-authored annotations back out of a PDF's pages.
// The host supplies each page's annotation objects (as exported by its PDF
// renderer); this parser is tolerant of the str-or-string / typed-array
// shapes PDF libraries hand back, and returns plain Markups.

import type { Markup } from './types.ts';
import { ANNOTATION_AUTHOR } from './annotate.ts';
import { toMeters, type Unit } from './units.ts';

/** A renderer's annotation object, accessed structurally. */
export type AnnotationLike = Record<string, unknown> & { subtype?: string };

const RESTORED = 'Restored';

// Formatted value tails exactly as annotate.ts writes them, anchored at the
// end of Contents: "Label: 12.50 m", "Label: 12.34 m²", "Label: 1.2 m³
// (depth 150 mm)", "Label: 45.0°", "Label: 2'-6\"", "Label: 1". The label is
// everything before the tail, so labels and note text may themselves contain
// colons ("DL: type A", "Check: ceiling height").
const NUM = String.raw`-?\d[\d.,]*`;
const UNIT = String.raw`(?:mm|cm|m|in|ft)`;
const FT_IN = String.raw`\d+(?:\.\d+)?'-\d+(?:\.\d+)?"`;
const LENGTH_TAIL = new RegExp(`: (?:${NUM}\\s*${UNIT}|${FT_IN})$`);
const AREA_TAIL = new RegExp(`: ${NUM}\\s*${UNIT}²$`);
const VOLUME_TAIL = new RegExp(`: ${NUM}\\s*${UNIT}³(?: \\(depth [^)]*\\))?$`);
const ANGLE_TAIL = /: -?\d+(?:\.\d+)?°$/;
const COUNT_TAIL = /: 1$/;

/** Depth as annotate.ts writes it in any display unit — "150 mm", "0.20 m",
 *  "2'-6"" — converted to metres (undefined when unparseable). */
function depthMeters(raw: string): number | undefined {
  const s = raw.trim();
  const su = s.match(/^(-?\d[\d.,]*)\s*(mm|cm|m|in|ft)$/i);
  if (su) {
    const v = parseFloat(su[1].replace(',', '.'));
    return Number.isFinite(v) ? toMeters(v, su[2].toLowerCase() as Unit) : undefined;
  }
  const fi = s.match(/^(-?\d+(?:\.\d+)?)'\s*-?\s*(\d+(?:\.\d+)?)\s*"?$/);
  if (fi) {
    const v = parseFloat(fi[1]) + parseFloat(fi[2]) / 12;
    return Number.isFinite(v) ? toMeters(v, 'ft') : undefined;
  }
  return undefined;
}

/** Label sitting before a value tail, or null when the tail doesn't match. */
function labelBefore(contents: string, tail: RegExp): string | null {
  const m = contents.match(tail);
  if (!m || m.index === undefined) return null;
  return contents.slice(0, m.index).trimEnd() || RESTORED;
}

export function parseMarkups(annots: AnnotationLike[], page: number, startIndex: number): Markup[] {
  const found: Markup[] = [];

  // renderers wrap text in {str} objects and may hand back typed arrays
  const strOf = (v: unknown): string | null =>
    v && typeof v === 'object' && typeof (v as { str?: unknown }).str === 'string'
      ? (v as { str: string }).str
      : null;
  const numsOf = (v: unknown): number[] | null => {
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<number>);
    return null;
  };

  for (const a of annots) {
    const title = strOf(a.titleObj) ?? (typeof a.title === 'string' ? a.title : '');
    if (title !== ANNOTATION_AUTHOR) continue;
    const subtype = String(a.subtype ?? '');
    const contentsRaw = strOf(a.contentsObj) ?? (typeof a.contents === 'string' ? a.contents : '');
    const layerMatch = contentsRaw.match(/\[layer:([^\]]+)\]\s*$/);
    const statusMatch = contentsRaw.match(/\[(check|confirmed)\](?:\s*\[layer:[^\]]+\])?\s*$/);
    const contents = (statusMatch || layerMatch)
      ? contentsRaw.slice(0, (statusMatch ?? layerMatch)!.index!).trimEnd()
      : contentsRaw;

    const toPt = (x: number, y: number): { x: number; y: number } => ({ x, y });
    let points: { x: number; y: number }[] = [];

    const line = numsOf(a.lineCoordinates);
    if (subtype === 'Line' && line && line.length === 4) {
      points = [toPt(line[0], line[1]), toPt(line[2], line[3])];
    } else if (subtype === 'PolyLine' || subtype === 'Polygon') {
      const v = numsOf(a.vertices);
      if (v) for (let i = 0; i + 1 < v.length; i += 2) points.push(toPt(v[i], v[i + 1]));
    } else if (subtype === 'FreeText') {
      const r = numsOf(a.rect);
      if (r && r.length === 4) points = [toPt((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)];
    }

    if (points.length === 0) continue;

    // Type and label come from the value tail, not the first colon: notes and
    // uncalibrated markups carry the label alone, everything else is
    // "label: formatted value". Angles end in °, areas in ², volumes in ³
    // (+ depth), counts are exactly ": 1", lengths/perimeters end in a unit
    // (or ft-in like 2'-6").
    let type: Markup['type'];
    let depth: number | undefined;
    let label = contents || RESTORED;
    if (subtype === 'FreeText') {
      const c = labelBefore(contents, COUNT_TAIL);
      if (c !== null) {
        type = 'count';
        label = c;
      } else {
        type = 'note';
      }
    } else if (subtype === 'Polygon') {
      const v = labelBefore(contents, VOLUME_TAIL);
      const ar = labelBefore(contents, AREA_TAIL);
      const pe = labelBefore(contents, LENGTH_TAIL);
      if (v !== null) {
        type = 'volume';
        label = v;
        const d = contents.match(/\(depth ([^)]*)\)/);
        if (d) depth = depthMeters(d[1]);
      } else if (ar !== null) {
        type = 'area';
        label = ar;
      } else if (pe !== null) {
        type = 'perimeter';
        label = pe;
      } else {
        type = 'area';
      }
    } else if (subtype === 'PolyLine') {
      const ang = labelBefore(contents, ANGLE_TAIL);
      if (ang !== null) {
        type = 'angle';
        label = ang;
      } else {
        type = 'length';
        const l = labelBefore(contents, LENGTH_TAIL);
        if (l !== null) label = l;
      }
    } else {
      type = 'length';
      const l = labelBefore(contents, LENGTH_TAIL);
      if (l !== null) label = l;
    }

    found.push({
      id: `im-${page}-${startIndex + found.length}`,
      page,
      type,
      label,
      points,
      createdAt: Date.now() + startIndex + found.length,
      ...(depth !== undefined ? { depth } : {}),
      ...(statusMatch ? { status: statusMatch[1] as 'check' | 'confirmed' } : {}),
      ...(layerMatch ? { layer: layerMatch[1] } : {}),
    });
  }
  return found;
}
