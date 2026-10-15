// Write markups back into the PDF as standard annotations (Line, PolyLine,
// Polygon, FreeText) so they open in Bluebeam, Acrobat and friends, and read
// pdf2takeoff annotations back out when a file is reopened.

import { PDFDocument, PDFName, PDFString, type PDFObject } from 'pdf-lib';
import { state, type Markup, type Pt, markupLength, markupArea, calibrationFor } from './state';
import { getPageAnnotations } from './viewer';
import { formatLength, formatArea } from './units';

const AUTHOR = 'pdf2takeoff';
const COLOR_HEX: Record<string, [number, number, number]> = {
  length: [225 / 255, 29 / 255, 72 / 255],
  area: [124 / 255, 58 / 255, 237 / 255],
  count: [2 / 255, 132 / 255, 199 / 255],
};

function pdfDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}+00'00'`;
}

function contentsFor(m: Markup): string {
  const cal = calibrationFor(m.page);
  if (!cal) return m.label;
  const v =
    m.type === 'length'
      ? formatLength(markupLength(m, cal.metersPerPt), state.displayUnit)
      : m.type === 'area'
        ? formatArea(markupArea(m, cal.metersPerPt), state.displayUnit)
        : '1';
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

export async function saveAnnotatedPdf(): Promise<void> {
  if (!state.fileBytes || state.markups.length === 0) return;
  const pdfDoc = await PDFDocument.load(state.fileBytes.slice());
  pdfDoc.setProducer('pdf2takeoff 0.1.0');
  pdfDoc.setModificationDate(new Date());

  const pages = pdfDoc.getPages();
  const { context } = pdfDoc;

  const addAnnot = (pageIndex: number, dict: Record<string, string | number | number[] | PDFObject>) => {
    const page = pages[pageIndex];
    const annots = page.node.Annots() ?? context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
    const ref = context.register(context.obj(dict));
    annots.push(ref);
  };

  const common = (m: Markup) => ({
    Type: PDFName.of('Annot'),
    T: PDFString.of(AUTHOR),
    Contents: PDFString.of(contentsFor(m)),
    M: PDFString.of(pdfDate()),
    C: COLOR_HEX[m.type],
    CA: 1,
    F: 4, // print
  });

  for (const m of state.markups) {
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
        IC: COLOR_HEX.length,
      });
    } else if (m.type === 'length') {
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('PolyLine'),
        Rect: bbox(m.points, 4),
        Vertices: flat,
        IC: COLOR_HEX.length,
      });
    } else if (m.type === 'area') {
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('Polygon'),
        Rect: bbox(m.points, 4),
        Vertices: flat,
        IC: COLOR_HEX.area,
      });
    } else {
      const [x, y] = [m.points[0].x, m.points[0].y];
      addAnnot(pi, {
        ...common(m),
        Subtype: PDFName.of('FreeText'),
        Rect: [x - 14, y - 9, x + 14, y + 9],
        DA: PDFString.of('/Helv 9 Tf 1 g'),
        Q: 1,
        C: COLOR_HEX.count,
        IC: COLOR_HEX.count,
      });
    }
  }

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = state.fileName.replace(/\.pdf$/i, '') + '-markups.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Read pdf2takeoff-authored annotations from the open document into state. */
export async function importMarkups(): Promise<number> {
  const found: Markup[] = [];

  // pdf.js wraps text in {str} objects and may hand back typed arrays
  const strOf = (v: unknown): string | null =>
    v && typeof v === 'object' && typeof (v as { str?: unknown }).str === 'string'
      ? (v as { str: string }).str
      : null;
  const numsOf = (v: unknown): number[] | null => {
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<number>);
    return null;
  };

  for (let p = 1; p <= state.pageCount; p++) {
    let annots: Awaited<ReturnType<typeof getPageAnnotations>> = [];
    try {
      annots = await getPageAnnotations(p);
    } catch {
      continue;
    }
    for (const a of annots as Array<Record<string, unknown> & { subtype?: string }>) {
      const title = strOf(a.titleObj) ?? (typeof a.title === 'string' ? a.title : '');
      if (title !== AUTHOR) continue;
      const subtype = String(a.subtype ?? '');
      const contents = strOf(a.contentsObj) ?? (typeof a.contents === 'string' ? a.contents : '');
      const label = contents.includes(':') ? contents.split(':')[0].trim() : contents || 'Restored';

      const toPt = (x: number, y: number): Pt => ({ x, y });
      let points: Pt[] = [];

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
      found.push({
        id: `im-${p}-${found.length}`,
        page: p,
        type: subtype === 'Polygon' ? 'area' : subtype === 'FreeText' ? 'count' : 'length',
        label,
        points,
        createdAt: Date.now() + found.length,
      });
    }
  }
  if (found.length) {
    state.markups = found;
  }
  return found.length;
}
