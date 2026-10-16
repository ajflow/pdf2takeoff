// Read pdf2takeoff-authored annotations back out of a PDF's pages.
// The host supplies each page's annotation objects (as exported by its PDF
// renderer); this parser is tolerant of the str-or-string / typed-array
// shapes PDF libraries hand back, and returns plain Markups.

import type { Markup } from './types.ts';
import { ANNOTATION_AUTHOR } from './annotate.ts';
import { parseLength, toMeters, type Unit } from './units.ts';

/** A renderer's annotation object, accessed structurally. */
export type AnnotationLike = Record<string, unknown> & { subtype?: string };

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
    const label = contents.includes(':') ? contents.split(':')[0].trim() : contents || 'Restored';

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

    // Our writer encodes the value in Contents, so the unit suffix tells the
    // type back: ² = area, ³ (+ depth note) = volume, ° = angle, a bare
    // value on a Polygon = perimeter. Uncalibrated comments carry no value
    // and degrade to the geometry's base type.
    let type: Markup['type'];
    let depth: number | undefined;
    if (subtype === 'FreeText') {
      type = /: 1$/.test(contents) ? 'count' : 'note';
    } else if (subtype === 'Polygon') {
      if (contents.includes('³')) {
        type = 'volume';
        const d = contents.match(/\(depth ([^)]+?)\s*(m|ft)\)/);
        if (d) {
          const parsed = parseLength(d[1], d[2] as Unit);
          if (parsed != null) depth = toMeters(parsed, d[2] as Unit);
        }
      } else if (contents.includes('²')) {
        type = 'area';
      } else if (contents.includes(':')) {
        type = 'perimeter';
      } else {
        type = 'area';
      }
    } else if (subtype === 'PolyLine' && contents.includes('°')) {
      type = 'angle';
    } else {
      type = 'length';
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
