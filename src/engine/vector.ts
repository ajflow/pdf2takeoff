// Vector layer: page geometry straight from the PDF's drawing operators
// (patch-plan-2 P16). CAD-exported sheets are vector, so lines, line
// weights and repeated symbol instances are exact here, with no raster
// seams or thresholds. The host hands over pdf.js's operator list
// (page.getOperatorList()) plus its OPS code table; this module walks it
// without importing pdf.js, so it runs identically in the browser and Node.
//
// Coordinates come out in PDF user space (points, origin bottom-left), the
// same frame as markups. Curves are flattened into short segments and
// flagged, so arcs (door swings, symbol circles) stay recognisable.

/** One straight piece of a painted path, in page space. */
export interface VecSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** stroke width in page-space points (0 for fill-only paths) */
  lineWidth: number;
  stroked: boolean;
  filled: boolean;
  dashed: boolean;
  /** piece of a flattened Bezier (arcs, circles) */
  curve: boolean;
  /** index of the painted path this segment belongs to */
  path: number;
  /** Form XObject instance the path was drawn inside (-1 at page level) */
  form: number;
}

export interface VecPage {
  segs: VecSeg[];
  /** painted paths, with their page-space bounding boxes */
  paths: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    segs: [number, number];
    form: number;
    lineWidth: number;
    curve: boolean;
    /** fill colour of a filled path as pdf.js sets it ("#rrggbb"); absent for strokes and pattern fills */
    fill?: string;
  }[];
  /** Form XObject instances drawn on the page */
  forms: number;
  /** optional-content (layer) groups referenced */
  layers: number;
}

/** The pdf.js OPS code table entries this walker uses. */
export interface OpsTable {
  save: number;
  restore: number;
  transform: number;
  setLineWidth: number;
  setDash: number;
  setGState: number;
  constructPath: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  beginMarkedContent: number;
  beginMarkedContentProps: number;
  endMarkedContent: number;
  /** fill colours (pdf.js converts grey, RGB and CMYK fills to this, as a hex string) */
  setFillRGBColor?: number;
  /** pattern and separation fills */
  setFillColorN?: number;
}

export interface VectorizeOptions {
  /**
   * Visibility of an optional-content group (a CAD layer), as pdf.js's
   * OptionalContentConfig.isVisible answers it. Paths inside hidden groups
   * are skipped, matching what the renderer draws. Omitted: all visible.
   */
  isVisible?(group: unknown): boolean;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Average scale of a matrix, for converting line widths to page space. */
const scaleOf = (m: M): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/** pdf.js DrawOPS codes inside constructPath data. */
const D_MOVE = 0;
const D_LINE = 1;
const D_CURVE = 2;
const D_QUAD = 3;
const D_CLOSE = 4;
/** Segments per flattened Bezier. */
const CURVE_STEPS = 8;

/**
 * Walk an operator list into page-space segments. Tracks the transform
 * stack, line width (including ExtGState LW), dash state, Form XObject
 * nesting and optional-content visibility; paths that are neither stroked
 * nor filled (clips) or that sit on a hidden layer are skipped.
 */
export function vectorize(opList: { fnArray: ArrayLike<number>; argsArray: unknown[] }, OPS: OpsTable, opts: VectorizeOptions = {}): VecPage {
  const segs: VecSeg[] = [];
  const paths: VecPage['paths'] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  let dashed = false;
  let fill: string | undefined = '#000000';
  const stack: { ctm: M; lineWidth: number; dashed: boolean; fill: string | undefined }[] = [];
  const formStack: number[] = [];
  let forms = 0;
  let layers = 0;
  // marked-content stack, as the canvas renderer keeps it: visible unless an
  // enclosing optional-content group is hidden
  const marked: boolean[] = [];
  let hidden = 0;
  const paintKind = (op: number): { stroked: boolean; filled: boolean } | null => {
    if (op === OPS.stroke || op === OPS.closeStroke) return { stroked: true, filled: false };
    if (op === OPS.fill || op === OPS.eoFill) return { stroked: false, filled: true };
    if (op === OPS.fillStroke || op === OPS.eoFillStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke) {
      return { stroked: true, filled: true };
    }
    return null;
  };

  const { fnArray, argsArray } = opList;
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    const args = argsArray[k] as unknown[];
    if (fn === OPS.save) stack.push({ ctm, lineWidth, dashed, fill });
    else if (fn === OPS.restore) {
      const s = stack.pop();
      if (s) ({ ctm, lineWidth, dashed, fill } = s);
    } else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as M);
    else if (OPS.setFillRGBColor !== undefined && fn === OPS.setFillRGBColor) fill = typeof args[0] === 'string' ? (args[0] as string).toLowerCase() : undefined;
    else if (OPS.setFillColorN !== undefined && fn === OPS.setFillColorN) fill = undefined;
    else if (fn === OPS.setLineWidth) lineWidth = Number(args[0]) || 0;
    else if (fn === OPS.setDash) dashed = Array.isArray(args[0]) && (args[0] as unknown[]).length > 0;
    else if (fn === OPS.setGState) {
      for (const [key, value] of (args[0] as [string, unknown][]) ?? []) {
        if (key === 'LW') lineWidth = Number(value) || 0;
        if (key === 'D' && Array.isArray(value)) dashed = Array.isArray(value[0]) && (value[0] as unknown[]).length > 0;
      }
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ctm, lineWidth, dashed, fill });
      const m = args[0] as M | null;
      if (m) ctm = mul(ctm, m);
      formStack.push(forms++);
    } else if (fn === OPS.paintFormXObjectEnd) {
      formStack.pop();
      const s = stack.pop();
      if (s) ({ ctm, lineWidth, dashed, fill } = s);
    } else if (fn === OPS.beginMarkedContent) {
      marked.push(true);
    } else if (fn === OPS.beginMarkedContentProps) {
      let visible = true;
      if (args[0] === 'OC') {
        layers++;
        visible = opts.isVisible ? opts.isVisible(args[1]) : true;
      }
      marked.push(visible);
      if (!visible) hidden++;
    } else if (fn === OPS.endMarkedContent) {
      if (marked.pop() === false) hidden--;
    } else if (fn === OPS.constructPath) {
      if (hidden > 0) continue;
      const kind = paintKind(Number(args[0]));
      if (!kind) continue;
      const data = (args[1] as unknown[] | undefined)?.[0] as ArrayLike<number> | undefined;
      if (!data) continue;
      const first = segs.length;
      const pathIdx = paths.length;
      const form = formStack.length ? formStack[formStack.length - 1] : -1;
      const lw = kind.stroked ? lineWidth * scaleOf(ctm) : 0;
      let cx = 0;
      let cy = 0;
      let sx = 0;
      let sy = 0;
      let anyCurve = false;
      const push = (x1: number, y1: number, x2: number, y2: number, curve: boolean) => {
        const [ax, ay] = apply(ctm, x1, y1);
        const [bx, by] = apply(ctm, x2, y2);
        segs.push({ x1: ax, y1: ay, x2: bx, y2: by, lineWidth: lw, stroked: kind.stroked, filled: kind.filled, dashed, curve, path: pathIdx, form });
      };
      for (let i = 0; i < data.length; ) {
        const op = data[i++];
        if (op === D_MOVE) {
          cx = sx = data[i++];
          cy = sy = data[i++];
        } else if (op === D_LINE) {
          const x = data[i++];
          const y = data[i++];
          push(cx, cy, x, y, false);
          cx = x;
          cy = y;
        } else if (op === D_CURVE || op === D_QUAD) {
          const pts = op === D_CURVE ? [data[i++], data[i++], data[i++], data[i++], data[i++], data[i++]] : [data[i++], data[i++], data[i++], data[i++]];
          let px = cx;
          let py = cy;
          for (let s = 1; s <= CURVE_STEPS; s++) {
            const t = s / CURVE_STEPS;
            const u = 1 - t;
            let x: number;
            let y: number;
            if (op === D_CURVE) {
              x = u * u * u * cx + 3 * u * u * t * pts[0] + 3 * u * t * t * pts[2] + t * t * t * pts[4];
              y = u * u * u * cy + 3 * u * u * t * pts[1] + 3 * u * t * t * pts[3] + t * t * t * pts[5];
            } else {
              x = u * u * cx + 2 * u * t * pts[0] + t * t * pts[2];
              y = u * u * cy + 2 * u * t * pts[1] + t * t * pts[3];
            }
            push(px, py, x, y, true);
            px = x;
            py = y;
          }
          anyCurve = true;
          cx = px;
          cy = py;
        } else if (op === D_CLOSE) {
          if (cx !== sx || cy !== sy) push(cx, cy, sx, sy, false);
          cx = sx;
          cy = sy;
        } else {
          break; // unknown op: stop reading this path rather than misparse it
        }
      }
      if (segs.length === first) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let s = first; s < segs.length; s++) {
        const g = segs[s];
        x0 = Math.min(x0, g.x1, g.x2);
        y0 = Math.min(y0, g.y1, g.y2);
        x1 = Math.max(x1, g.x1, g.x2);
        y1 = Math.max(y1, g.y1, g.y2);
      }
      paths.push({ x0, y0, x1, y1, segs: [first, segs.length], form, lineWidth: lw, curve: anyCurve, ...(kind.filled && fill ? { fill } : {}) });
    }
  }
  return { segs, paths, forms, layers };
}
