// Scan provider, tier 1: classic computer vision, no model download.
// Click one instance of a repeated symbol; the host rasterizes the page, and
// this pass binarizes the ink, extracts connected components, and matches
// every component to the clicked one by size, aspect, fill and a normalized
// shape signature. Runs in well under a second per sheet on typed arrays
// alone. Tier 2 (scan-onnx.ts) is a trained detector that slots in behind
// the same ScanResult interface; scan.ts picks whichever is available.
//
// Two things make a plain component match collapse on real sheets, and
// both are handled here:
//   - symbols fused with linework (valves on pipes, doors in walls, tags on
//     leaders): the clicked component is the whole network. The line
//     removal pre-pass (line-removal.ts) strips long straight runs and
//     their stubs first; it runs on demand (`removeLines: 'auto'`, the
//     default) when the clicked component is implausibly large for the
//     sheet's stroke width or the plain pass finds nothing but the clicked
//     symbol itself.
//   - rotated and mirrored siblings (a flange drawn on a vertical pipe, a
//     door swinging the other way): the signature is compared under the 8
//     dihedral transforms (`dihedral: true`, the default). The identity
//     transform is tried first, so a symbol that already matched keeps
//     matching exactly as before.
// After line removal, thin stubs the removal left attached (pipe ends
// shorter than the run threshold, leader tails) are trimmed off the
// bounding box before the signature is taken, so a symbol with a stub on
// its left matches one with a stub on its right. A click on the tag text
// inside an outline symbol (instrument bubble, equipment box) resolves to
// the outline that encloses both the click and the glyph.

import type { Pt } from './types.ts';
import type { RasterPage } from './ports.ts';
import type { ScanResult } from './types.ts';
import { estimateStrokeWidth, removeLines } from './line-removal.ts';

const SIG = 20; // signature grid
const MIN_COMPONENT_PX = 12;
/**
 * Signature distance threshold: sum |a - b| / sum (a + b) over the blurred
 * coverage grids, 0 = identical, 1 = disjoint. Siblings on a rasterized
 * sheet land at 0.05 to 0.15; a symbol that differs by one stroke lands at
 * 0.2 and up.
 */
const MATCH_DIST = 0.15;
const SIZE_BAND = 0.55; // sqrt area ratio bounds (1/x .. x)
const ASPECT_BAND = 0.3; // |log aspect ratio difference|
const FILL_BAND = 0.18;
/** Plain-pass click radius in px (about 3.3 PDF pt at RASTER_SCALE). */
const CLICK_RADIUS = 10;
/** A click inside a hollow symbol reaches this many strokes to the nearest ink. */
const CLICK_REACH = 6;
/** A clicked component wider and taller than this many strokes is linework, not a symbol. */
const LARGE_FACTOR = 20;
/** A clicked component no bigger than this many strokes in both axes is a glyph. */
const GLYPH_FACTOR = 8;
/** Enclosing-outline resolution: the outline may be at most this many times the clicked glyph. */
const ENCLOSE_FACTOR = 8;
/** And at most this many strokes across (keeps room outlines out). */
const ENCLOSE_MAX_STROKES = 40;

export interface CvScanOptions {
  /**
   * Line removal pre-pass. 'auto' (default) runs it when the clicked
   * component is implausibly large relative to the sheet's stroke width
   * (bounding box over LARGE_FACTOR strokes in both axes) or when the plain
   * pass returns a single hit. true always runs it, false never.
   */
  removeLines?: 'auto' | boolean;
  /** Match under the 8 dihedral transforms (rotations and mirrors). Default true. */
  dihedral?: boolean;
  /** Signature distance threshold override (see MATCH_DIST). */
  matchDistance?: number;
}

/** Diagnostics for the line-removal path, surfaced on ScanResult.lineRemoval. */
export interface LineRemovalReport {
  /** Why the pre-pass ran: 'option', 'large-component', 'single-hit', 'no-component'. */
  trigger: string;
  strokeWidth: number;
  minRun: number;
  removedPx: number;
}

/** Raw connected component; `shape` is computed on demand. */
interface Component {
  label: number;
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  shape?: Shape;
}

/** The matched geometry: trimmed bbox, ink centroid, fill and signature. */
interface Shape {
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  fill: number;
  aspect: number;
  sig: Float32Array;
}

interface Pass {
  template?: Component;
  hits: Pt[];
}

export function cvScan(raster: RasterPage, clicked: Pt, opts: CvScanOptions = {}): ScanResult {
  const w = raster.width;
  const h = raster.height;
  const data = raster.data;
  const mode = opts.removeLines ?? 'auto';
  const dihedral = opts.dihedral ?? true;
  const matchDist = opts.matchDistance ?? MATCH_DIST;

  // ink mask: vector CAD output is high-contrast, a fixed threshold is
  // enough (luminance under 150). One 32-bit load per pixel when the RGBA
  // buffer is aligned, which it is for every canvas host.
  const mask = new Uint8Array(w * h);
  const words = data.byteOffset % 4 === 0 && data.byteLength >= w * h * 4 && LITTLE_ENDIAN ? new Uint32Array(data.buffer, data.byteOffset, w * h) : null;
  if (words) {
    for (let i = 0; i < mask.length; i++) {
      const v = words[i];
      if (v === 0xffffffff) continue; // white paper, the common case
      mask[i] = (v & 255) * 299 + ((v >>> 8) & 255) * 587 + ((v >>> 16) & 255) * 114 < 150000 ? 1 : 0;
    }
  } else {
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      mask[i] = data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114 < 150000 ? 1 : 0;
    }
  }

  // clicked point to raster px, with a tolerance for anti-aliased edges; a
  // click inside a hollow symbol reaches out a few strokes further
  const click = raster.toRaster(clicked.x, clicked.y);
  const px = Math.round(click.x);
  const py = Math.round(click.y);
  const strokeWidth = mode === false ? 1 : estimateStrokeWidth(mask, w, h);
  let clickRadius = CLICK_RADIUS;
  let seed = inkNear(mask, w, h, px, py, clickRadius);
  if (seed < 0 && mode !== false) {
    clickRadius = Math.max(CLICK_RADIUS, CLICK_REACH * strokeWidth);
    seed = inkNear(mask, w, h, px, py, clickRadius);
  }
  if (seed < 0) return { error: 'click directly on a symbol to teach the scan' };

  const labels = new Int32Array(w * h);
  let labelsDirty = false;
  const matcher = { raster, w, h, labels, dihedral, matchDist };

  const finish = (pass: Pass, note: string, report?: LineRemovalReport): ScanResult => {
    if (!pass.template) return { error: 'that symbol is too small or part of a large structure; try a smaller, isolated symbol' };
    // stable numbering: reading order, rows then columns
    const hits = pass.hits.slice().sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
    return {
      hits,
      provider: 'cv',
      templatePx: pass.template.shape?.count ?? pass.template.count,
      note,
      ...(report ? { lineRemoval: report } : {}),
    };
  };

  const withLines = (trigger: string): ScanResult => {
    const lr = removeLines(mask, w, h, { strokeWidth });
    const report: LineRemovalReport = { trigger, strokeWidth, minRun: lr.minRun, removedPx: lr.removedPx };
    if (labelsDirty) labels.fill(0);
    labelsDirty = true;
    const pass = analyse(matcher, lr.cleaned, px, py, Math.max(clickRadius, CLICK_REACH * strokeWidth), strokeWidth, true);
    return finish(pass, `lines removed (stroke ${strokeWidth}px, runs over ${lr.minRun}px, ${lr.removedPx} px dropped)`, report);
  };

  if (mode === true) return withLines('option');

  // auto: a bounded flood from the click tells whether the clicked ink is
  // linework before the whole sheet is labelled
  const large = LARGE_FACTOR * strokeWidth;
  if (mode === 'auto' && floodIsLarge(mask, labels, w, h, seed, large)) return withLines('large-component');

  const plain = analyse(matcher, mask, px, py, clickRadius, strokeWidth, false);
  labelsDirty = true;
  if (mode === false) return finish(plain, 'plain component match');

  // the plain pass cannot have worked when the clicked component is
  // linework, finds only itself, or is glyph-sized (tag text inside an
  // outline that is fused with the linework); retry with the pre-pass and
  // keep whichever pass found more
  const t = plain.template;
  const glyph = GLYPH_FACTOR * strokeWidth;
  let trigger: string | undefined;
  if (!t) trigger = 'no-component';
  else if (t.x1 - t.x0 + 1 > large && t.y1 - t.y0 + 1 > large) trigger = 'large-component';
  else if (plain.hits.length <= 1) trigger = 'single-hit';
  else if (t.x1 - t.x0 + 1 <= glyph && t.y1 - t.y0 + 1 <= glyph) trigger = 'glyph-sized';
  if (!trigger) return finish(plain, 'plain component match');
  const retried = withLines(trigger);
  if (!t) return retried;
  if ('error' in retried || retried.hits.length === 0) return finish(plain, 'plain component match (line removal found nothing better)');
  if (trigger === 'glyph-sized' && (retried.templatePx ?? 0) <= 2 * t.count) {
    return finish(plain, 'plain component match (no enclosing symbol after line removal)');
  }
  if (trigger === 'single-hit' && retried.hits.length <= plain.hits.length) {
    return finish(plain, 'plain component match (line removal found nothing better)');
  }
  return retried;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const NEIGHBOUR_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NEIGHBOUR_DY = [-1, -1, -1, 0, 0, 1, 1, 1];

/** Index of the nearest ink pixel within Chebyshev radius r of (px, py), or -1. */
function inkNear(mask: Uint8Array, w: number, h: number, px: number, py: number, r: number): number {
  for (let d = 0; d <= r; d++) {
    for (let dy = -d; dy <= d; dy++) {
      const y = py + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -d; dx <= d; dx++) {
        if (Math.abs(dy) !== d && Math.abs(dx) !== d) continue;
        const x = px + dx;
        if (x < 0 || x >= w) continue;
        if (mask[y * w + x]) return y * w + x;
      }
    }
  }
  return -1;
}

/**
 * Flood from `seed` and stop as soon as the component's bounding box
 * exceeds `large` in both axes (true) or the fill runs out (false). Marks
 * `labels` with -1 on the way and clears them again.
 */
function floodIsLarge(mask: Uint8Array, labels: Int32Array, w: number, h: number, seed: number, large: number): boolean {
  let stack = new Int32Array(1 << 14);
  let seen = new Int32Array(1 << 14);
  let sp = 0;
  let visited = 0;
  stack[sp++] = seed;
  labels[seed] = -1;
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  let result = false;
  while (sp) {
    const idx = stack[--sp];
    if (visited === seen.length) {
      const grown = new Int32Array(seen.length * 2);
      grown.set(seen);
      seen = grown;
    }
    seen[visited++] = idx;
    const y = (idx / w) | 0;
    const x = idx - y * w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (x1 - x0 + 1 > large && y1 - y0 + 1 > large) {
      result = true;
      break;
    }
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const nidx = ny * w + nx;
        if (mask[nidx] && !labels[nidx]) {
          labels[nidx] = -1;
          if (sp === stack.length) {
            const grown = new Int32Array(stack.length * 2);
            grown.set(stack);
            stack = grown;
          }
          stack[sp++] = nidx;
        }
      }
    }
  }
  for (let i = 0; i < visited; i++) labels[seen[i]] = 0;
  for (let i = 0; i < sp; i++) labels[stack[i]] = 0;
  return result;
}

interface Matcher {
  raster: RasterPage;
  w: number;
  h: number;
  labels: Int32Array;
  dihedral: boolean;
  matchDist: number;
}

/**
 * One matching pass over an ink mask: connected components, click
 * resolution, template signature, dihedral match. `trim` enables
 * thin-appendage trimming keyed to the stroke width (line-removal path).
 */
function analyse(m: Matcher, mask: Uint8Array, px: number, py: number, clickRadius: number, stroke: number, trim: boolean): Pass {
  const { w, h, labels } = m;
  const trimStroke = trim ? stroke : 0;
  // connected components, 8-connectivity, iterative flood fill
  const comps: Component[] = [];
  const byLabel = new Map<number, Component>();
  let stack = new Int32Array(1 << 16);
  let nextLabel = 0;
  const maxCount = (w * h) / 16;
  const offsets = new Int32Array(8);
  for (let k = 0; k < 8; k++) offsets[k] = NEIGHBOUR_DY[k] * w + NEIGHBOUR_DX[k];
  // the outer scan skips blank 4-pixel groups through a 32-bit view (the
  // masks are allocated here, so they are aligned; the fallback is for any
  // other buffer)
  const words = mask.byteOffset % 4 === 0 ? new Uint32Array(mask.buffer, mask.byteOffset, mask.length >> 2) : null;
  const wordEnd = words ? words.length << 2 : 0;
  let group = 0;
  for (let start = 0; start < mask.length; start++) {
    if (words && start < wordEnd && (start & 3) === 0) {
      // jump over blank groups
      group = start >> 2;
      while (group < words.length && !words[group]) group++;
      start = group << 2;
      if (start >= mask.length) break;
    }
    if (!mask[start] || labels[start]) continue;
    const id = ++nextLabel;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let count = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (sp) {
      const idx = stack[--sp];
      const y = (idx / w) | 0;
      const x = idx - y * w;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const interior = x > 0 && y > 0 && x < w - 1 && y < h - 1;
      for (let k = 0; k < 8; k++) {
        // interior pixels (all but the border) need no bounds checks
        if (!interior) {
          const nx = x + NEIGHBOUR_DX[k];
          const ny = y + NEIGHBOUR_DY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        }
        const nidx = idx + offsets[k];
        if (mask[nidx] && !labels[nidx]) {
          labels[nidx] = id;
          if (sp === stack.length) {
            const grown = new Int32Array(stack.length * 2);
            grown.set(stack);
            stack = grown;
          }
          stack[sp++] = nidx;
        }
      }
    }
    if (count < MIN_COMPONENT_PX || count > maxCount) continue;
    const c: Component = { label: id, count, x0, y0, x1, y1 };
    comps.push(c);
    byLabel.set(id, c);
  }

  // resolve the clicked component (first ink pixel at/around the click)
  let template: Component | undefined;
  outer: for (let r = 0; r <= clickRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const y = py + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dy) !== r && Math.abs(dx) !== r) continue;
        const x = px + dx;
        if (x < 0 || x >= w) continue;
        const l = labels[y * w + x];
        if (l) {
          template = byLabel.get(l);
          if (template) break outer;
        }
      }
    }
  }
  if (!template) return { hits: [] };

  // a click on the tag text inside an outline symbol lands on a glyph; the
  // smallest outline enclosing both the click and the glyph is the symbol
  {
    const cw = template.x1 - template.x0 + 1;
    const ch = template.y1 - template.y0 + 1;
    const maxDim = Math.min(ENCLOSE_FACTOR * Math.max(cw, ch), ENCLOSE_MAX_STROKES * Math.max(stroke, 1));
    const pad = Math.max(stroke, 1);
    let best: Component | undefined;
    let bestArea = 0;
    for (const c of comps) {
      if (c === template || c.count < 3 * template.count) continue;
      if (px < c.x0 || px > c.x1 || py < c.y0 || py > c.y1) continue;
      if (c.x0 >= template.x0 - pad || c.x1 <= template.x1 + pad || c.y0 >= template.y0 - pad || c.y1 <= template.y1 + pad) continue;
      if ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1) > 4 * maxDim * maxDim) continue;
      // measured on the trimmed shape, so a stub still attached does not disqualify it
      const s = shapeOf(c, labels, w, trimStroke);
      const ew = s.x1 - s.x0 + 1;
      const eh = s.y1 - s.y0 + 1;
      if (ew > maxDim || eh > maxDim || s.fill > 0.35) continue;
      if (best && ew * eh >= bestArea) continue;
      best = c;
      bestArea = ew * eh;
    }
    if (best) template = best;
  }

  // match every component against the template, under the dihedral group
  // when enabled (identity first, so an exact match stays an exact match)
  const ts = shapeOf(template, labels, w, trimStroke);
  const variants = m.dihedral ? dihedralVariants(ts) : [{ sig: ts.sig, aspect: ts.aspect }];
  const tArea = (ts.x1 - ts.x0 + 1) * (ts.y1 - ts.y0 + 1);
  const minCount = ts.count * SIZE_BAND * SIZE_BAND;
  // trimming only removes ink, and stubs can triple a count before it
  const maxCount0 = (ts.count / (SIZE_BAND * SIZE_BAND)) * (trim ? 3 : 1);
  const hits: Pt[] = [];
  for (const c of comps) {
    if (c.count < minCount || c.count > maxCount0) continue;
    if ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1) > 64 * tArea) continue;
    const s = shapeOf(c, labels, w, trimStroke);
    const sizeRatio = Math.sqrt(ts.count / s.count);
    if (sizeRatio < SIZE_BAND || sizeRatio > 1 / SIZE_BAND) continue;
    if (Math.abs(ts.fill - s.fill) > FILL_BAND) continue;
    let matched = false;
    for (const v of variants) {
      if (Math.abs(Math.log(v.aspect / s.aspect)) > ASPECT_BAND) continue;
      if (sigDistance(v.sig, s.sig) <= m.matchDist) {
        matched = true;
        break;
      }
    }
    if (matched) hits.push(m.raster.toPdf(s.cx, s.cy));
  }
  return { template, hits };
}

/** Relative L1 distance between coverage grids: 0 identical, 1 disjoint. */
function sigDistance(a: Float32Array, b: Float32Array): number {
  let d = 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    d += Math.abs(a[i] - b[i]);
    s += a[i] + b[i];
  }
  return s > 0 ? d / s : 1;
}

/**
 * The template signature under the 8 dihedral transforms: identity, three
 * rotations, two mirrors and the two diagonal flips. Transforms that swap
 * the axes carry the inverted aspect ratio.
 */
function dihedralVariants(t: Shape): { sig: Float32Array; aspect: number }[] {
  const a = t.aspect;
  const s = t.sig;
  const n = SIG;
  const make = (f: (i: number, j: number) => number, swap: boolean) => {
    const out = new Float32Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = s[f(i, j)];
    return { sig: out, aspect: swap ? 1 / a : a };
  };
  const m = n - 1;
  return [
    { sig: s, aspect: a },
    make((i, j) => (m - i) * n + (m - j), false), // rotate 180
    make((i, j) => i * n + (m - j), false), // mirror left-right
    make((i, j) => (m - i) * n + j, false), // mirror top-bottom
    make((i, j) => (m - j) * n + i, true), // rotate 90
    make((i, j) => j * n + (m - i), true), // rotate 270
    make((i, j) => j * n + i, true), // transpose
    make((i, j) => (m - j) * n + (m - i), true), // anti-transpose
  ];
}

/**
 * The component's matched geometry, computed once. With `trimStroke` > 0,
 * thin appendages are trimmed first: columns (rows) at the bbox edges whose
 * ink is no thicker than a stroke and a half are pipe stubs or leader
 * tails, not the symbol. An outline crossed twice is two strokes, so it
 * stays; a bar or a dash is thin everywhere and is left whole.
 */
function shapeOf(c: Component, labels: Int32Array, w: number, trimStroke: number): Shape {
  if (c.shape) return c.shape;
  const label = c.label;
  let { x0, y0, x1, y1 } = c;
  if (trimStroke > 0) {
    const thin = trimStroke + Math.floor(trimStroke / 2);
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const cols = new Int32Array(bw);
    const rows = new Int32Array(bh);
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        if (labels[row + x] === label) {
          cols[x - x0]++;
          rows[y - y0]++;
        }
      }
    }
    let coreCols = false;
    let coreRows = false;
    for (let i = 0; i < bw && !coreCols; i++) if (cols[i] > 2 * thin) coreCols = true;
    for (let i = 0; i < bh && !coreRows; i++) if (rows[i] > 2 * thin) coreRows = true;
    if (coreCols) {
      while (x0 < x1 && cols[x0 - c.x0] <= thin) x0++;
      while (x1 > x0 && cols[x1 - c.x0] <= thin) x1--;
    }
    if (coreRows) {
      while (y0 < y1 && rows[y0 - c.y0] <= thin) y0++;
      while (y1 > y0 && rows[y1 - c.y0] <= thin) y1--;
    }
  }
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // shape signature: ink coverage downsampled to a SIG x SIG grid over the
  // (trimmed) bbox, then box-blurred so a one-cell shift costs little
  const raw = new Float32Array(SIG * SIG);
  const cellW = bw / SIG;
  const cellH = bh / SIG;
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    const gy = Math.min(SIG - 1, Math.floor((y - y0) / cellH));
    for (let x = x0; x <= x1; x++) {
      if (labels[row + x] === label) {
        count++;
        sx += x;
        sy += y;
        const gx = Math.min(SIG - 1, Math.floor((x - x0) / cellW));
        raw[gy * SIG + gx] += 1;
      }
    }
  }
  const perCell = cellW * cellH;
  for (let i = 0; i < raw.length; i++) raw[i] = Math.min(1, raw[i] / perCell);
  const sig = new Float32Array(SIG * SIG);
  for (let i = 0; i < SIG; i++) {
    for (let j = 0; j < SIG; j++) {
      let s = 0;
      let k = 0;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= SIG) continue;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= SIG) continue;
          s += raw[ii * SIG + jj];
          k++;
        }
      }
      sig[i * SIG + j] = s / k;
    }
  }
  if (count === 0) count = 1;
  c.shape = { count, x0, y0, x1, y1, cx: sx / count, cy: sy / count, fill: count / (bw * bh), aspect: bw / bh, sig };
  return c.shape;
}
