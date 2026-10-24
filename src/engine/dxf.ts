// DXF (ASCII) into a vector PDF page at a standard drawing scale. The model
// space is drawn monochrome, as a plot would be: lines, polylines (bulges as
// arcs), circles, arcs, ellipses and splines as true curves, solids filled,
// text and mtext as real text (so the engine reads room names without OCR),
// and blocks expanded through their inserts (doors and fixtures defined
// once, so Scan matches them exactly), dimensions included. Hatches, paper
// space, frozen and off layers are left out.
//
// The drawing's units ($INSUNITS) give its real size; the page is that size
// at the smallest standard ratio that fits an A3 sheet, so a printed ratio and
// the page agree, and the scale goes into the PDF (SCALE_KEY) for the app to
// set without calibrating. Loaded only when a DXF is opened.

import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts, type PDFFont } from 'pdf-lib';
import { SCALE_KEY, type DrawingScale } from './inputs.ts';

const UNITS: Record<number, [string, number]> = {
  1: ['in', 0.0254],
  2: ['ft', 0.3048],
  3: ['mi', 1609.344],
  4: ['mm', 0.001],
  5: ['cm', 0.01],
  6: ['m', 1],
  7: ['km', 1000],
  10: ['yd', 0.9144],
  14: ['dm', 0.1],
};
const RATIOS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000];
const PT_PER_M = 72 / 0.0254;
/** Laid out to fit an A3 sheet, the usual plot: a house comes out at 1:50, a 30 m building at 1:100. */
const SHEET: [number, number] = [0.42, 0.297];
const DEFAULT_LINE_MM = 0.18;
const MAX_DEPTH = 8;

type Pair = [number, string];
type M = [number, number, number, number, number, number]; // a b c d e f
const IDENTITY: M = [1, 0, 0, 1, 0, 0];
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

interface Entity {
  type: string;
  pairs: Pair[];
  /** POLYLINE vertices, INSERT attributes */
  children: Entity[];
}

interface Block {
  base: [number, number];
  entities: Entity[];
}

// --- reading ------------------------------------------------------------------

function pairsOf(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    out.push([code, lines[i + 1].replace(/\r$/, '')]);
  }
  return out;
}

const num = (e: Entity, code: number, fallback = 0): number => {
  const p = e.pairs.find(([c]) => c === code);
  const v = p ? parseFloat(p[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const str = (e: Entity, code: number, fallback = ''): string => e.pairs.find(([c]) => c === code)?.[1] ?? fallback;
const all = (e: Entity, code: number): number[] => e.pairs.filter(([c]) => c === code).map(([, v]) => parseFloat(v));

/** Split a section's pairs into entities at each code-0 marker, nesting VERTEX/ATTRIB until SEQEND. */
function entitiesOf(pairs: Pair[]): Entity[] {
  const out: Entity[] = [];
  let current: Entity | null = null;
  let parent: Entity | null = null;
  for (const [code, value] of pairs) {
    if (code === 0) {
      const type = value.trim();
      if (type === 'SEQEND') {
        parent = null;
        current = null;
        continue;
      }
      current = { type, pairs: [], children: [] };
      if (parent && (type === 'VERTEX' || type === 'ATTRIB')) parent.children.push(current);
      else {
        parent = null;
        out.push(current);
        // a POLYLINE always has vertices; an INSERT has attributes when 66 is 1 (known after its pairs)
        if (type === 'POLYLINE' || type === 'INSERT') parent = current;
      }
      continue;
    }
    current?.pairs.push([code, value]);
  }
  return out;
}

function sections(pairs: Pair[]): Map<string, Pair[]> {
  const out = new Map<string, Pair[]>();
  let name: string | null = null;
  let body: Pair[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0 && value.trim() === 'SECTION' && pairs[i + 1]?.[0] === 2) {
      name = pairs[i + 1][1].trim();
      body = [];
      i++;
    } else if (code === 0 && value.trim() === 'ENDSEC') {
      if (name) out.set(name, body);
      name = null;
    } else if (name) body.push(pairs[i]);
  }
  return out;
}

function headerVar(header: Pair[], name: string, code: number): number | null {
  const i = header.findIndex(([c, v]) => c === 9 && v.trim() === name);
  if (i < 0) return null;
  for (let j = i + 1; j < header.length && header[j][0] !== 9; j++) if (header[j][0] === code) return parseFloat(header[j][1]);
  return null;
}

// --- geometry -------------------------------------------------------------------

/** A path in model units: move/line/cubic segments. */
type Seg = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];
interface Path {
  segs: Seg[];
  width: number; // lineweight in mm on paper
  fill?: boolean;
}
interface Text {
  x: number;
  y: number;
  /** text height and rotation, already through any insert's transform */
  h: number;
  rot: number;
  lines: string[];
  /** 0 left, 0.5 centre, 1 right; 0 baseline-bottom, 0.5 middle, 1 top (of the first line) */
  ax: number;
  ay: number;
}

/**
 * Cubic segments for an elliptical arc (radii rx, ry, rotated by rot) about
 * (cx, cy) from angle a0 to a1, mapped through m. a1 below a0 runs clockwise.
 */
function arcSegs(m: M, cx: number, cy: number, rx: number, ry: number, rot: number, a0: number, a1: number, move: boolean): Seg[] {
  const segs: Seg[] = [];
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
  const d = (a1 - a0) / n;
  const k = (4 / 3) * Math.tan(d / 4);
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const at = (a: number, s = 1): [number, number] => {
    const ex = rx * Math.cos(a) * s;
    const ey = ry * Math.sin(a) * s;
    return [cx + ex * cr - ey * sr, cy + ex * sr + ey * cr];
  };
  const tan = (a: number): [number, number] => {
    const ex = -rx * Math.sin(a);
    const ey = ry * Math.cos(a);
    return [ex * cr - ey * sr, ex * sr + ey * cr];
  };
  const p0 = apply(m, ...at(a0));
  if (move) segs.push(['M', ...p0]);
  for (let i = 0; i < n; i++) {
    const s = a0 + i * d;
    const e = s + d;
    const [sx, sy] = at(s);
    const [ex, ey] = at(e);
    const [tsx, tsy] = tan(s);
    const [tex, tey] = tan(e);
    const c1 = apply(m, sx + k * tsx, sy + k * tsy);
    const c2 = apply(m, ex - k * tex, ey - k * tey);
    const p = apply(m, ex, ey);
    segs.push(['C', ...c1, ...c2, ...p]);
  }
  return segs;
}

/** Points of a B-spline (degree p, knots, control points, weights) sampled along its span. */
function splinePoints(deg: number, knots: number[], ctrl: [number, number][], weights: number[]): [number, number][] {
  const n = ctrl.length;
  if (n < 2 || knots.length !== n + deg + 1) return ctrl;
  const lo = knots[deg];
  const hi = knots[n];
  const samples = Math.min(400, Math.max(16, n * 8));
  const out: [number, number][] = [];
  for (let s = 0; s <= samples; s++) {
    const t = s === samples ? hi - 1e-9 * (hi - lo) : lo + ((hi - lo) * s) / samples;
    let k = deg;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d: [number, number, number][] = [];
    for (let j = 0; j <= deg; j++) {
      const i = k - deg + j;
      const w = weights[i] ?? 1;
      d.push([ctrl[i][0] * w, ctrl[i][1] * w, w]);
    }
    for (let r = 1; r <= deg; r++) {
      for (let j = deg; j >= r; j--) {
        const i = k - deg + j;
        const den = knots[i + deg - r + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        for (let c = 0; c < 3; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
      }
    }
    out.push([d[deg][0] / d[deg][2], d[deg][1] / d[deg][2]]);
  }
  return out;
}

/** MTEXT formatting codes out, paragraphs split. */
function mtextLines(raw: string): string[] {
  const s = raw
    .replace(/\\P/g, '\n')
    .replace(/\\[\\{}]/g, (m) => m[1]) // escaped braces and backslash
    .replace(/\\[ACcFfHQTWp][^;]*;/g, '') // colour, font, height, oblique, tracking, width, paragraph
    .replace(/\\[LlOoKk]/g, '') // under/over/strike toggles
    .replace(/\\S([^;]*);/g, (_, x: string) => x.replace(/[#^]/, '/')) // stacked fractions
    .replace(/\\~/g, ' ')
    .replace(/[{}]/g, '');
  return s.split('\n').map((l) => l.trim());
}

/** %%c %%d %%p and \U+XXXX in TEXT values. */
function textValue(raw: string): string {
  return raw
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[uUoO]/g, '')
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

class Drawing {
  paths: Path[] = [];
  texts: Text[] = [];
  private blocks: Map<string, Block>;
  private hiddenLayers: Set<string>;
  private layerWidth: Map<string, number>;
  constructor(blocks: Map<string, Block>, hiddenLayers: Set<string>, layerWidth: Map<string, number>) {
    this.blocks = blocks;
    this.hiddenLayers = hiddenLayers;
    this.layerWidth = layerWidth;
  }

  private width(e: Entity, inherited: number): number {
    const w = num(e, 370, -1);
    if (w > 0) return w / 100;
    if (w === -2) return inherited; // by block
    return this.layerWidth.get(str(e, 8, '0')) ?? inherited;
  }

  draw(entities: Entity[], m: M, depth: number, inheritedLayer: string, inheritedWidth: number): void {
    for (const e of entities) {
      if (num(e, 67) === 1) continue; // paper space
      const layer = str(e, 8, '0');
      const effective = layer === '0' ? inheritedLayer : layer;
      if (this.hiddenLayers.has(effective)) continue;
      const w = this.width(e, inheritedWidth);
      try {
        this.entity(e, m, depth, effective, w);
      } catch {
        /* a malformed entity is skipped, not fatal */
      }
    }
  }

  private line(m: M, pts: [number, number][], closed: boolean, w: number): void {
    if (pts.length < 2) return;
    const segs: Seg[] = [['M', ...apply(m, ...pts[0])]];
    for (let i = 1; i < pts.length; i++) segs.push(['L', ...apply(m, ...pts[i])]);
    if (closed) segs.push(['Z']);
    this.paths.push({ segs, width: w });
  }

  private entity(e: Entity, m: M, depth: number, layer: string, w: number): void {
    switch (e.type) {
      case 'LINE':
        this.line(m, [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]], false, w);
        break;
      case 'LWPOLYLINE': {
        const xs = all(e, 10);
        const ys = all(e, 20);
        // bulges follow their vertex; a vertex without one has 0
        const bulges: number[] = [];
        let vi = -1;
        for (const [c, v] of e.pairs) {
          if (c === 10) bulges[++vi] = 0;
          else if (c === 42 && vi >= 0) bulges[vi] = parseFloat(v) || 0;
        }
        this.bulged(m, xs.map((x, i) => [x, ys[i]] as [number, number]), bulges, (num(e, 70) & 1) === 1, w);
        break;
      }
      case 'POLYLINE': {
        const flags = num(e, 70);
        if (flags & (16 | 64)) break; // 3D meshes and polyface meshes
        const vs = e.children.filter((c) => c.type === 'VERTEX' && !(num(c, 70) & 16));
        this.bulged(m, vs.map((v) => [num(v, 10), num(v, 20)] as [number, number]), vs.map((v) => num(v, 42)), (flags & 1) === 1, w);
        break;
      }
      case 'CIRCLE': {
        const r = num(e, 40);
        if (r > 0) this.paths.push({ segs: [...arcSegs(m, num(e, 10), num(e, 20), r, r, 0, 0, 2 * Math.PI, true), ['Z']], width: w });
        break;
      }
      case 'ARC': {
        const r = num(e, 40);
        const a0 = (num(e, 50) * Math.PI) / 180;
        let a1 = (num(e, 51) * Math.PI) / 180;
        while (a1 <= a0) a1 += 2 * Math.PI;
        if (r > 0) this.paths.push({ segs: arcSegs(m, num(e, 10), num(e, 20), r, r, 0, a0, a1, true), width: w });
        break;
      }
      case 'ELLIPSE': {
        const mx = num(e, 11);
        const my = num(e, 21);
        const rx = Math.hypot(mx, my);
        const ry = rx * num(e, 40, 1);
        const t0 = num(e, 41, 0);
        let t1 = num(e, 42, 2 * Math.PI);
        while (t1 <= t0) t1 += 2 * Math.PI;
        if (rx > 0) this.paths.push({ segs: arcSegs(m, num(e, 10), num(e, 20), rx, ry, Math.atan2(my, mx), t0, t1, true), width: w });
        break;
      }
      case 'SPLINE': {
        const fit = all(e, 11).map((x, i) => [x, all(e, 21)[i]] as [number, number]);
        const ctrl = all(e, 10).map((x, i) => [x, all(e, 20)[i]] as [number, number]);
        const pts = ctrl.length >= 2 ? splinePoints(num(e, 71, 3), all(e, 40), ctrl, all(e, 41)) : fit;
        this.line(m, pts, (num(e, 70) & 1) === 1, w);
        break;
      }
      case 'SOLID':
      case 'TRACE': {
        // corners in the order 1, 2, 4, 3
        const c = [10, 11, 13, 12].map((k) => apply(m, num(e, k), num(e, k + 10)));
        this.paths.push({ segs: [['M', ...c[0]], ['L', ...c[1]], ['L', ...c[2]], ['L', ...c[3]], ['Z']], width: w, fill: true });
        break;
      }
      case 'TEXT':
      case 'ATTRIB': {
        if (e.type === 'ATTRIB' && num(e, 70) & 1) break; // invisible attribute
        const h = num(e, 40, 2.5);
        const ha = num(e, 72);
        const va = num(e, 73);
        const aligned = ha !== 0 || va !== 0;
        const x = aligned ? num(e, 11) : num(e, 10);
        const y = aligned ? num(e, 21) : num(e, 20);
        const text = textValue(str(e, 1));
        if (text.trim()) this.text(m, x, y, h, num(e, 50), [text], ha === 1 || ha === 4 ? 0.5 : ha === 2 ? 1 : 0, va === 3 ? 1 : va === 2 ? 0.5 : 0);
        break;
      }
      case 'MTEXT': {
        const h = num(e, 40, 2.5);
        const raw = e.pairs.filter(([c]) => c === 3).map(([, v]) => v).join('') + str(e, 1);
        const att = num(e, 71, 1); // 1..9: top/middle/bottom x left/centre/right
        const dx = num(e, 11, NaN);
        const rot = Number.isFinite(dx) ? (Math.atan2(num(e, 21), dx) * 180) / Math.PI : num(e, 50);
        const lines = mtextLines(raw).filter((l, i, a) => l || i < a.length - 1);
        if (lines.some((l) => l)) this.text(m, num(e, 10), num(e, 20), h, rot, lines, [0, 0.5, 1][(att - 1) % 3], [1, 0.5, 0][Math.floor((att - 1) / 3)]);
        break;
      }
      case 'INSERT':
      case 'DIMENSION': {
        if (depth >= MAX_DEPTH) break;
        const block = this.blocks.get(str(e, 2));
        if (!block) break;
        if (e.type === 'DIMENSION') {
          this.draw(block.entities, m, depth + 1, layer, w); // dimension blocks are drawn in place
          break;
        }
        const sx = num(e, 41, 1);
        const sy = num(e, 42, 1);
        const rot = (num(e, 50) * Math.PI) / 180;
        const cols = Math.max(1, num(e, 70, 1));
        const rows = Math.max(1, num(e, 71, 1));
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const ox = c * num(e, 44);
            const oy = r * num(e, 45);
            const cr = Math.cos(rot);
            const sr = Math.sin(rot);
            // translate(insert) · rotate · scale · translate(grid offset − base)
            const local: M = mul(mul([cr, sr, -sr, cr, num(e, 10), num(e, 20)], [sx, 0, 0, sy, 0, 0]), [1, 0, 0, 1, ox - block.base[0], oy - block.base[1]]);
            this.draw(block.entities, mul(m, local), depth + 1, layer, w);
          }
        }
        for (const a of e.children) this.entity(a, m, depth, layer, w); // attributes are in world space
        break;
      }
      default:
        break; // HATCH, POINT, 3DFACE, IMAGE, VIEWPORT and the rest are left out
    }
  }

  private bulged(m: M, pts: [number, number][], bulges: number[], closed: boolean, w: number): void {
    if (pts.length < 2) return;
    const segs: Seg[] = [['M', ...apply(m, ...pts[0])]];
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const bulge = bulges[i] ?? 0;
      if (Math.abs(bulge) < 1e-9) {
        segs.push(['L', ...apply(m, ...b)]);
        continue;
      }
      // a bulge is tan(θ/4) of the arc's included angle, positive counter-clockwise
      const theta = 4 * Math.atan(bulge);
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (chord < 1e-12) continue;
      const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const off = r * Math.cos(Math.abs(theta) / 2) * Math.sign(bulge);
      const nx = -(b[1] - a[1]) / chord;
      const ny = (b[0] - a[0]) / chord;
      const cx = mid[0] + nx * off;
      const cy = mid[1] + ny * off;
      const a0 = Math.atan2(a[1] - cy, a[0] - cx);
      segs.push(...arcSegs(m, cx, cy, r, r, 0, a0, a0 + theta, false));
    }
    if (closed) segs.push(['Z']);
    this.paths.push({ segs, width: w });
  }

  private text(m: M, x: number, y: number, h: number, rotDeg: number, lines: string[], ax: number, ay: number): void {
    const [px, py] = apply(m, x, y);
    // height and angle through the transform (uniform scale assumed for text)
    const [ux, uy] = [m[0], m[1]];
    const s = Math.hypot(ux, uy) || 1;
    const rot = rotDeg + (Math.atan2(uy, ux) * 180) / Math.PI;
    this.texts.push({ x: px, y: py, h: h * s, rot, lines, ax, ay });
  }
}

// --- writing --------------------------------------------------------------------

const fmt = (v: number) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(3).replace(/\.?0+$/, ''));

// the engine's lib has no DOM types; TextDecoder exists in every runtime it targets
declare const TextDecoder: new (label?: string, options?: { fatal?: boolean }) => { decode(bytes: Uint8Array): string };

/** DXF bytes as text: UTF-8 (AutoCAD 2007 on), else the Windows code page older files use. */
export function dxfText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Append the DXF as one page of `out`; returns the scale it was laid out at. */
export async function addDxfPage(out: PDFDocument, text: string, fontCache: { font?: PDFFont }): Promise<DrawingScale> {
  const pairs = pairsOf(text);
  const secs = sections(pairs);
  const header = secs.get('HEADER') ?? [];

  // layers: frozen (70 bit 1) or off (negative colour) are hidden; lineweights
  const hidden = new Set<string>();
  const layerWidth = new Map<string, number>();
  for (const t of entitiesOf(secs.get('TABLES') ?? []).filter((x) => x.type === 'LAYER')) {
    const name = str(t, 2);
    if (num(t, 70) & 1 || num(t, 62) < 0) hidden.add(name);
    const lw = num(t, 370, -3);
    if (lw > 0) layerWidth.set(name, lw / 100);
  }

  const blocks = new Map<string, Block>();
  {
    let cur: { name: string; base: [number, number]; body: Pair[] } | null = null;
    for (const [code, value] of secs.get('BLOCKS') ?? []) {
      if (code === 0 && value.trim() === 'BLOCK') cur = { name: '', base: [0, 0], body: [] };
      else if (code === 0 && value.trim() === 'ENDBLK') {
        if (cur) blocks.set(cur.name, { base: cur.base, entities: entitiesOf(cur.body) });
        cur = null;
      } else if (cur) {
        // the block's own header pairs come before its first entity
        const started = cur.body.some(([c]) => c === 0);
        if (!started && code === 2) cur.name = value.trim();
        else if (!started && code === 10) cur.base[0] = parseFloat(value);
        else if (!started && code === 20) cur.base[1] = parseFloat(value);
        else if (started || code === 0) cur.body.push([code, value]);
      }
    }
  }

  const drawing = new Drawing(blocks, hidden, layerWidth);
  drawing.draw(entitiesOf(secs.get('ENTITIES') ?? []), IDENTITY, 0, '0', DEFAULT_LINE_MM);
  if (!drawing.paths.length && !drawing.texts.length) throw new Error('this DXF has nothing to draw in model space');

  // extents of what was drawn (the header's are often stale)
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const p of drawing.paths) for (const s of p.segs) for (let i = 1; i + 1 < s.length; i += 2) grow(s[i] as number, s[i + 1] as number);
  for (const t of drawing.texts) grow(t.x, t.y);
  const w = Math.max(x1 - x0, 1e-9);
  const h = Math.max(y1 - y0, 1e-9);

  // units: as stated, else read off the size of a building (mm for thousands, m for tens)
  const stated = UNITS[headerVar(header, '$INSUNITS', 70) ?? 0];
  let unit: [string, number];
  let assumed = false;
  if (stated) unit = stated;
  else {
    assumed = true;
    const big = Math.max(w, h);
    unit = big >= 1000 ? UNITS[4] : big >= 2 ? UNITS[6] : UNITS[4];
  }
  const [wm, hm] = [w * unit[1], h * unit[1]];
  const fits = (r: number) => {
    const [a, b] = [Math.max(wm, hm) / r, Math.min(wm, hm) / r];
    return a <= SHEET[0] && b <= SHEET[1];
  };
  const ratio = RATIOS.find(fits) ?? RATIOS[RATIOS.length - 1];

  // the page: the drawing at 1:ratio with a 4% margin; model units -> points
  const k = (unit[1] / ratio) * PT_PER_M;
  const margin = 0.04 * Math.max(w, h);
  const pageW = (w + 2 * margin) * k;
  const pageH = (h + 2 * margin) * k;
  const page = out.addPage([pageW, pageH]);
  const X = (x: number) => fmt((x - x0 + margin) * k);
  const Y = (y: number) => fmt((y - y0 + margin) * k);

  const ops: string[] = ['q', '0 0 0 RG', '0 0 0 rg', '1 J', '1 j'];
  let lastW = -1;
  for (const p of drawing.paths) {
    const lw = (p.width / 25.4) * 72;
    if (lw !== lastW) {
      ops.push(`${fmt(lw)} w`);
      lastW = lw;
    }
    const parts: string[] = [];
    for (const s of p.segs) {
      if (s[0] === 'M') parts.push(`${X(s[1])} ${Y(s[2])} m`);
      else if (s[0] === 'L') parts.push(`${X(s[1])} ${Y(s[2])} l`);
      else if (s[0] === 'C') parts.push(`${X(s[1])} ${Y(s[2])} ${X(s[3])} ${Y(s[4])} ${X(s[5])} ${Y(s[6])} c`);
      else parts.push('h');
    }
    parts.push(p.fill ? 'f' : 'S');
    ops.push(parts.join(' '));
  }
  ops.push('Q');

  if (drawing.texts.length) {
    const font = (fontCache.font ??= await out.embedFont(StandardFonts.Helvetica));
    const name = page.node.newFontDictionary('F', font.ref);
    const charset = new Set(font.getCharacterSet());
    const safe = (s: string) => [...s].map((c) => (charset.has(c.codePointAt(0)!) ? c : '?')).join('');
    for (const t of drawing.texts) {
      const size = t.h * k;
      if (!(size > 0.2)) continue;
      const r = (t.rot * Math.PI) / 180;
      const [c, sn] = [Math.cos(r), Math.sin(r)];
      t.lines.forEach((line, i) => {
        const textLine = safe(line);
        if (!textLine) return;
        const width = font.widthOfTextAtSize(textLine, size);
        // anchor: ax along the line, ay against the first line's cap height; later lines step down
        const dx = -t.ax * width;
        const dy = -t.ay * size * 0.72 - i * size * 1.4;
        const tx = (t.x - x0 + margin) * k + dx * c - dy * sn;
        const ty = (t.y - y0 + margin) * k + dx * sn + dy * c;
        ops.push(`BT ${name.toString()} ${fmt(size)} Tf ${fmt(c)} ${fmt(sn)} ${fmt(-sn)} ${fmt(c)} ${fmt(tx)} ${fmt(ty)} Tm ${font.encodeText(textLine).toString()} Tj ET`);
      });
    }
  }
  const stream = out.context.flateStream(ops.join('\n'));
  page.node.addContentStream(out.context.register(stream));
  return { ratio, unit: unit[0], assumed };
}

/** Record each DXF page's scale in the info dictionary (SCALE_KEY). */
export function writeScales(out: PDFDocument, scales: Map<number, DrawingScale>): void {
  const existing = out.context.lookup(out.context.trailerInfo.Info);
  const info = existing instanceof PDFDict ? existing : out.context.obj({});
  if (!(existing instanceof PDFDict)) out.context.trailerInfo.Info = out.context.register(info);
  info.set(PDFName.of(SCALE_KEY), PDFString.of(JSON.stringify(Object.fromEntries(scales))));
}
