// Write markups back into a PDF as standard annotations (Line, PolyLine,
// Polygon, FreeText) so they open in Bluebeam Revu, Acrobat and friends.
// Pure pdf-lib: bytes in, bytes out — works identically in any host.

import { PDFDocument, PDFDict, PDFHexString, PDFName, PDFRef, PDFString, type PDFObject } from 'pdf-lib';
import type { Calibration, Markup, Pt, DrawingAnnotation } from './types.ts';
import { markupLength, markupArea, markupPerimeter, markupVolume, markupAngle } from './geometry.ts';
import { formatLength, formatArea, formatVolume, type DisplayUnit } from './units.ts';
import { resolveCalibration, type Viewport } from './viewports.ts';
import { itemTag } from './inventory.ts';

export const ANNOTATION_AUTHOR = 'pdf2takeoff';
export const DRAWING_ANNOTATION_AUTHOR = 'pdf2takeoff-drawing';

const PRODUCER = 'pdf2takeoff 0.1.0';
const COLOR_HEX: Record<string, [number, number, number]> = {
  length: [225 / 255, 29 / 255, 72 / 255],
  area: [124 / 255, 58 / 255, 237 / 255],
  count: [2 / 255, 132 / 255, 199 / 255],
  perimeter: [13 / 255, 148 / 255, 136 / 255],
  volume: [79 / 255, 70 / 255, 229 / 255],
  angle: [219 / 255, 39 / 255, 119 / 255],
  note: [217 / 255, 119 / 255, 6 / 255],
};

function colorFromHex(hex: string | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function pdfDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}+00'00'`;
}

function contentsFor(m: Markup, calibrations: Map<number, Calibration>, displayUnit: DisplayUnit, viewports: Viewport[] = []): string {
  const tags = [
    // item attributes first: read.ts strips status and layer from the end, then the item tag
    ...(m.type === 'count' && m.item ? [itemTag(m.item)] : []),
    ...(m.status ? [`[${m.status}]`] : []),
    ...(m.layer ? [`[layer:${m.layer}]`] : []),
  ];
  const body = contentsBody(m, resolveCalibration(m, calibrations, viewports), displayUnit);
  return tags.length ? `${body} ${tags.join(' ')}` : body;
}

function contentsBody(m: Markup, cal: Calibration | undefined, displayUnit: DisplayUnit): string {
  // angles are scale-free — they never need calibration
  if (m.type === 'angle') return `${m.label}: ${markupAngle(m).toFixed(1)}°`;
  if (m.type === 'note') return m.label; // the note IS the text
  if (!cal) return m.type === 'count' ? `${m.label}: 1` : m.label;
  if (m.type === 'count') return `${m.label}: 1`;
  let v: string;
  if (m.type === 'perimeter') {
    v = formatLength(markupPerimeter(m, cal.metersPerPt), displayUnit);
  } else if (m.type === 'volume') {
    // depth rides along in the comment so round-trips (and humans in Revu) see it
    const vol = formatVolume(markupVolume(m, cal.metersPerPt), displayUnit);
    return `${m.label}: ${vol} (depth ${formatLength(m.depth ?? 0, displayUnit)})`;
  } else if (m.type === 'length') {
    v = formatLength(markupLength(m, cal.metersPerPt), displayUnit);
  } else {
    v = formatArea(markupArea(m, cal.metersPerPt), displayUnit);
  }
  return `${m.label}: ${v}`;
}

function bbox(points: Pt[], pad: number): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export interface AnnotateOptions {
  bytes: Uint8Array;
  markups: Markup[];
  calibrations: Map<number, Calibration>;
  displayUnit: DisplayUnit;
  viewports?: Viewport[];
  annotations?: DrawingAnnotation[];
}

/** Return a copy of the PDF with one standard annotation per markup. */
export async function buildAnnotatedPdf(opts: AnnotateOptions): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(opts.bytes.slice());
  pdfDoc.setProducer(PRODUCER);
  pdfDoc.setModificationDate(new Date());

  const pages = pdfDoc.getPages();
  const { context } = pdfDoc;

  // The bytes being loaded may already be a previous pdf2takeoff save
  // (re-open → edit → save). Drop our old annotations so this save replaces
  // them instead of stacking duplicates — and so deletions stay deleted.
  // Our annotations are single self-contained dicts (no appearance streams
  // or popups), so deleting the object itself keeps re-saves from growing.
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const entries = annots.asArray();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const dict = context.lookup(entry);
      if (!(dict instanceof PDFDict)) continue;
      const t = dict.get(PDFName.of('T'));
      const author = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : null;
      if (author !== ANNOTATION_AUTHOR && author !== DRAWING_ANNOTATION_AUTHOR) continue;
      annots.remove(i);
      if (entry instanceof PDFRef) context.delete(entry);
    }
  }

  const addAnnot = (pageIndex: number, dict: Record<string, string | number | number[] | PDFObject>) => {
    const page = pages[pageIndex];
    const annots = page.node.Annots() ?? context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
    const ref = context.register(context.obj(dict));
    annots.push(ref);
  };

  const markupColor = (m: Markup) => colorFromHex(m.color, COLOR_HEX[m.type]);
  const common = (m: Markup) => ({
    Type: PDFName.of('Annot'),
    T: PDFString.of(ANNOTATION_AUTHOR),
    Contents: PDFString.of(contentsFor(m, opts.calibrations, opts.displayUnit, opts.viewports)),
    M: PDFString.of(pdfDate()),
    C: markupColor(m),
    CA: m.strokeOpacity ?? 1,
    BS: context.obj({
      W: m.strokeWidth ?? 1.6,
      S: PDFName.of(m.lineStyle && m.lineStyle !== 'solid' ? 'D' : 'S'),
      ...(m.lineStyle === 'dashed' ? { D: [6, 3] } : m.lineStyle === 'dotted' ? { D: [1, 3] } : {}),
    }),
    F: 4,
  });

  for (const m of opts.markups) {
    const pi = m.page - 1;
    if (pi < 0 || pi >= pages.length) continue;
    const flat: number[] = [];
    for (const p of m.points) flat.push(p.x, p.y);

    if (m.type === 'length' && m.points.length === 2) {
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('Line'),
        Rect: bbox(m.points, 4),
        L: flat,
        IC: markupColor(m),
      });
    } else if (m.type === 'length' || m.type === 'angle') {
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('PolyLine'),
        Rect: bbox(m.points, 4),
        Vertices: flat,
        IC: markupColor(m),
      });
    } else if (m.type === 'area' || m.type === 'perimeter' || m.type === 'volume') {
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('Polygon'),
        Rect: bbox(m.points, 4),
        Vertices: flat,
        IC: COLOR_HEX[m.type],
      });
    } else {
      // count and note share FreeText; counts always carry ': 1' so the
      // reader can tell them apart on round-trip
      const [x, y] = [m.points[0].x, m.points[0].y];
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('FreeText'),
        Rect: [x - 14, y - 9, x + 14, y + 9],
        DA: PDFString.of('/Helv 9 Tf 1 g'),
        Q: 1,
        C: markupColor(m),
        IC: markupColor(m),
      });
    }
  }


  for (const annotation of opts.annotations ?? []) {
    const pi = annotation.page - 1;
    if (pi < 0 || pi >= pages.length || !annotation.points.length) continue;
    const pts = annotation.points;
    const flat: number[] = [];
    for (const p of pts) flat.push(p.x, p.y);
    const color = colorFromHex(annotation.color, [225 / 255, 29 / 255, 72 / 255]);
    const [x0, y0, x1, y1] = pts.length > 1
      ? bbox(pts, Math.max(2, annotation.strokeWidth ?? 2))
      : [pts[0].x - 4, pts[0].y - 4, pts[0].x + 180, pts[0].y + 22];
    const commonDrawing = {
      Type: PDFName.of('Annot'),
      T: PDFString.of(DRAWING_ANNOTATION_AUTHOR),
      Contents: PDFString.of(annotation.text ?? `${annotation.kind} annotation`),
      M: PDFString.of(pdfDate()),
      C: color,
      CA: annotation.opacity ?? 0.9,
      F: 4,
      BS: context.obj({
        W: annotation.strokeWidth ?? 2,
        S: PDFName.of(annotation.lineStyle && annotation.lineStyle !== 'solid' ? 'D' : 'S'),
        ...(annotation.lineStyle === 'dashed' ? { D: [7, 4] } : annotation.lineStyle === 'dotted' ? { D: [1, 4] } : {}),
      }),
    };
    if (annotation.kind === 'line' || annotation.kind === 'arrow') {
      if (pts.length < 2) continue;
      addAnnot(pi, {
        ...commonDrawing,
        Subtype: PDFName.of('Line'),
        Rect: [x0, y0, x1, y1],
        L: flat,
        ...(annotation.kind === 'arrow' ? { LE: context.obj([PDFName.of('None'), PDFName.of('ClosedArrow')]) } : {}),
      });
    } else if (annotation.kind === 'rectangle' || annotation.kind === 'highlight') {
      addAnnot(pi, {
        ...commonDrawing,
        Subtype: PDFName.of('Square'),
        Rect: [x0, y0, x1, y1],
        IC: color,
        ...(annotation.kind === 'highlight' ? { CA: annotation.fillOpacity ?? 0.2 } : {}),
      });
    } else if (annotation.kind === 'ellipse') {
      addAnnot(pi, { ...commonDrawing, Subtype: PDFName.of('Circle'), Rect: [x0, y0, x1, y1] });
    } else if (annotation.kind === 'cloud') {
      const corners = [pts[0], { x: pts[1]?.x ?? pts[0].x, y: pts[0].y }, pts[1] ?? pts[0], { x: pts[0].x, y: pts[1]?.y ?? pts[0].y }];
      const vertices = corners.flatMap((p) => [p.x, p.y]);
      addAnnot(pi, {
        ...commonDrawing,
        Subtype: PDFName.of('Polygon'),
        Rect: [x0, y0, x1, y1],
        Vertices: vertices,
        BE: context.obj({ S: PDFName.of('C'), I: 1 }),
      });
    } else if (annotation.kind === 'text') {
      addAnnot(pi, {
        ...commonDrawing,
        Subtype: PDFName.of('FreeText'),
        Rect: [x0, y0, x1, y1],
        DA: PDFString.of('/Helv 12 Tf 1 0 0 rg'),
        Q: 0,
      });
    }
  }

  return pdfDoc.save();
}
