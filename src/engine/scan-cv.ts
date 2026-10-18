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
//
// The matching stage itself (one pass of `analyse`):
//   1. candidates: every component inside the size and fill bands of the
//      clicked one, scored by its signature distance to the template under
//      the dihedral group. A pair whose raw coverage grids differ by one
//      concentrated one-sided blob (the waist dot of a globe valve against
//      a gate valve, a filled against a hollow triangle) is a look-alike
//      whatever its distance and is rejected (localDifference, LOCAL_MAX):
//      the relative L1 cannot tell a 5 percent dot from rasterization
//      noise, the share of a 3 x 3 block that is one-sided can.
//   2. threshold: `matchDistance: 'auto'` (default) reads the threshold off
//      that distance distribution: siblings cluster near the click and the
//      rest of the sheet sits further out, so the first clear gap after the
//      cluster, clamped into [AUTO_MIN, AUTO_MAX], separates them better
//      than one constant for every sheet. Without a clear gap the constant
//      MATCH_DIST is used.
//   3. expansion (`expand`, default on): hits well inside the threshold
//      become templates themselves and every candidate is rescored against
//      the whole set (minimum distance), for up to EXPAND_ROUNDS rounds or
//      until no new hit appears. Siblings that differ from the clicked one
//      by a stub, a rotation and a shift at once sit just outside its
//      threshold but inside a sibling's. Drift is held in check twice: a
//      template must itself be within the threshold of the clicked symbol,
//      and a round that grows the hit set by more than EXPAND_GROWTH is
//      discarded and ends the expansion.
// `textBoxes` (raster px) erases known text from the ink mask first, so a
// tag printed against a symbol does not fuse with it; the box the click
// lands in is kept.
//
// Tried and dropped (round 2 of the benchmark sweep, Dataset-P&ID sheet
// 134): a second-stage check of the hits within 0.03 of the threshold on a
// 40 x 40 grid at twice the resolution (mask upsampled bilinearly). The
// fine distance ran 0.01 to 0.07 above the coarse one for true siblings and
// look-alikes alike (less blur, more shift noise, and a one-dot difference
// is the same fraction of the ink at any resolution), so it dropped 9 true
// siblings against 7 look-alikes: recall 0.659 to 0.581, exact classes 8
// to 7. A look-alike that differs by one interior dot needs a difference
// measure that is local (one concentrated same-sign blob of difference
// against diffuse edge noise), not a finer grid.

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
 * 0.2 and up. The fallback when the per-sheet threshold finds no gap.
 */
const MATCH_DIST = 0.15;
/** Per-sheet threshold bounds. */
const AUTO_MIN = 0.1;
const AUTO_MAX = 0.2;
/** The sibling cluster must reach at least this far out before a gap after it counts (the click itself is at 0). */
const AUTO_FLOOR = 0.06;
/** The smallest gap in the sorted distances that counts as the edge of the sibling cluster. */
const AUTO_MIN_GAP = 0.03;
/** A gap this wide counts even below AUTO_FLOOR (pixel-identical siblings, then nothing until the look-alikes). */
const AUTO_BIG_GAP = 0.08;
/** The threshold sits at most this far past the cluster's last member, however wide the gap. */
const AUTO_REACH = 0.03;
/** Template expansion: a hit under this fraction of the threshold becomes a template. */
const EXPAND_FRACTION = 0.6;
const EXPAND_ROUNDS = 4;
/** A round that grows the hit set by more than this fraction (and by more than EXPAND_MIN_GROWTH hits) is drift. */
const EXPAND_GROWTH = 0.5;
const EXPAND_MIN_GROWTH = 2;
const MAX_TEMPLATES = 16;
/** Localized difference: a 3 x 3 block needs this much ink (in cells) before its share counts. */
const LOCAL_MIN_MASS = 4;
/** A candidate whose largest block of one-sided difference holds more than this share of the block's ink is a look-alike. */
const LOCAL_MAX = 0.95;
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

/** An axis-aligned box in raster px (x1, y1 exclusive). */
export interface TextBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

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
  /**
   * Signature distance threshold. 'auto' (default) reads it off the sheet's
   * distance distribution, clamped into [AUTO_MIN, AUTO_MAX]; a number
   * fixes it (see MATCH_DIST).
   */
  matchDistance?: 'auto' | number;
  /** Self-expanding templates (confident hits become templates). Default true. */
  expand?: boolean;
  /** Reject look-alikes that differ by one concentrated blob of ink (LOCAL_MAX). Default true. */
  lookAlike?: boolean;
  /**
   * Known text on the page in raster px (text layer words, OCR). Erased
   * from the ink mask before line removal and components, except the box
   * the click lands in.
   */
  textBoxes?: TextBox[];
  /** Diagnostic sink (the distance distribution, expansion rounds). */
  trace?: (event: string, data: Record<string, unknown>) => void;
}

/** Diagnostics for the line-removal path, surfaced on ScanResult.lineRemoval. */
export interface LineRemovalReport {
  /** Why the pre-pass ran: 'option', 'large-component', 'single-hit', 'no-component'. */
  trigger: string;
  strokeWidth: number;
  minRun: number;
  removedPx: number;
}

type CvReport = NonNullable<Extract<ScanResult, { hits: unknown }>['cv']>;

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
  /** The unblurred coverage grid the signature was made from. */
  raw: Float32Array;
}

/** A component inside the template's size and fill bands, with its best distance so far. */
interface Candidate {
  c: Component;
  s: Shape;
  /** Minimum signature distance over the template set. */
  d: number;
  /** Distance to the clicked template alone (the drift guard). */
  d0: number;
  /** Index of the template that gave `d`. */
  via: number;
  /** Smallest localized difference to the clicked template over its variants (diagnostic). */
  local: number;
}

interface Variant {
  sig: Float32Array;
  raw: Float32Array;
  aspect: number;
}

interface Pass {
  template?: Component;
  hits: Pt[];
  report?: CvReport;
}

export function cvScan(raster: RasterPage, clicked: Pt, opts: CvScanOptions = {}): ScanResult {
  const w = raster.width;
  const h = raster.height;
  const data = raster.data;
  const mode = opts.removeLines ?? 'auto';
  const dihedral = opts.dihedral ?? true;
  const matchDist = opts.matchDistance ?? 'auto';

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

  // known text goes first, so it neither fuses with symbols nor shapes the
  // stroke width; the box the click lands in stays (the click may be on a
  // tag inside an outline symbol, which the enclosing-outline rule handles)
  let textBoxesMasked = 0;
  if (opts.textBoxes) {
    for (const b of opts.textBoxes) {
      const x0 = Math.max(0, Math.floor(b.x0));
      const y0 = Math.max(0, Math.floor(b.y0));
      const x1 = Math.min(w, Math.ceil(b.x1));
      const y1 = Math.min(h, Math.ceil(b.y1));
      if (x1 <= x0 || y1 <= y0) continue;
      if (px >= x0 && px < x1 && py >= y0 && py < y1) continue;
      for (let y = y0; y < y1; y++) mask.fill(0, y * w + x0, y * w + x1);
      textBoxesMasked++;
    }
  }

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
  const matcher: Matcher = {
    raster,
    w,
    h,
    labels,
    dihedral,
    matchDist,
    expand: opts.expand ?? true,
    lookAlike: opts.lookAlike ?? true,
    trace: opts.trace,
  };

  const finish = (pass: Pass, note: string, report?: LineRemovalReport): ScanResult => {
    if (!pass.template) return { error: 'that symbol is too small or part of a large structure; try a smaller, isolated symbol' };
    // stable numbering: reading order, rows then columns
    const hits = pass.hits.slice().sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
    const cv = pass.report;
    if (cv && textBoxesMasked) cv.textBoxesMasked = textBoxesMasked;
    return {
      hits,
      provider: 'cv',
      templatePx: pass.template.shape?.count ?? pass.template.count,
      note,
      ...(report ? { lineRemoval: report } : {}),
      ...(cv ? { cv } : {}),
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
  matchDist: 'auto' | number;
  expand: boolean;
  lookAlike: boolean;
  trace?: CvScanOptions['trace'];
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

  // 1. candidates: every component inside the template's size and fill
  // bands, scored against the clicked signature under the dihedral group
  // (identity first, so an exact match stays an exact match)
  const ts = shapeOf(template, labels, w, trimStroke);
  const tArea = (ts.x1 - ts.x0 + 1) * (ts.y1 - ts.y0 + 1);
  const minCount = ts.count * SIZE_BAND * SIZE_BAND;
  // trimming only removes ink, and stubs can triple a count before it
  const maxCount0 = (ts.count / (SIZE_BAND * SIZE_BAND)) * (trim ? 3 : 1);
  const cands: Candidate[] = [];
  for (const c of comps) {
    if (c.count < minCount || c.count > maxCount0) continue;
    if ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1) > 64 * tArea) continue;
    const s = shapeOf(c, labels, w, trimStroke);
    const sizeRatio = Math.sqrt(ts.count / s.count);
    if (sizeRatio < SIZE_BAND || sizeRatio > 1 / SIZE_BAND) continue;
    if (Math.abs(ts.fill - s.fill) > FILL_BAND) continue;
    cands.push({ c, s, d: 1, d0: 1, via: 0, local: 1 });
  }
  const templates: Component[] = [template];
  score(cands, variantsOf(ts, m.dihedral), 0, m.lookAlike);
  for (const k of cands) k.d0 = k.d;

  // 2. the threshold, read off the distribution when asked to
  let thr: number;
  let source: CvReport['thresholdSource'];
  if (typeof m.matchDist === 'number') {
    thr = m.matchDist;
    source = 'option';
  } else {
    const auto = autoThreshold(cands.filter((k) => k.c !== template).map((k) => k.d0));
    thr = auto ?? MATCH_DIST;
    source = auto === null ? 'default' : 'auto';
  }
  m.trace?.('distances', {
    threshold: thr,
    source,
    distances: cands.map((k) => Math.round(k.d0 * 1000) / 1000).sort((a, b) => a - b),
    cands: cands.map((k) => ({ d: Math.round(k.d0 * 1000) / 1000, local: Math.round(k.local * 1000) / 1000, ...m.raster.toPdf(k.s.cx, k.s.cy) })),
  });

  // 3. expansion: confident hits become templates, candidates are rescored
  // against the set (minimum distance), until nothing new turns up
  let hits = cands.filter((k) => k.d <= thr);
  let rounds = 0;
  let stopped: string | undefined;
  if (m.expand) {
    const used = new Set<Component>([template]);
    for (let round = 1; round <= EXPAND_ROUNDS && templates.length < MAX_TEMPLATES; round++) {
      const fresh = hits
        .filter((k) => !used.has(k.c) && k.d < EXPAND_FRACTION * thr && k.d0 <= thr)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_TEMPLATES - templates.length);
      if (!fresh.length) break;
      const before = cands.map((k) => k.d);
      const beforeVia = cands.map((k) => k.via);
      for (const k of fresh) {
        used.add(k.c);
        templates.push(k.c);
        score(cands, variantsOf(k.s, m.dihedral), templates.length - 1, m.lookAlike);
      }
      const grown = cands.filter((k) => k.d <= thr);
      const added = grown.length - hits.length;
      if (added > Math.max(EXPAND_MIN_GROWTH, hits.length * EXPAND_GROWTH)) {
        // drift: the new templates reached into another class; undo the round
        cands.forEach((k, i) => {
          k.d = before[i];
          k.via = beforeVia[i];
        });
        templates.length -= fresh.length;
        stopped = `round ${round} grew the hits from ${hits.length} to ${grown.length}, discarded`;
        m.trace?.('expansion', { round, templates: templates.length + fresh.length, hits: grown.length, discarded: true });
        break;
      }
      rounds = round;
      m.trace?.('expansion', { round, templates: templates.length, hits: grown.length, added });
      if (added === 0) break;
      hits = grown;
    }
  }

  const report: CvReport = {
    matchDistance: Math.round(thr * 1000) / 1000,
    thresholdSource: source,
    candidates: cands.length,
    expansionRounds: rounds,
    templates: templates.length,
    ...(stopped ? { expansionStopped: stopped } : {}),
  };
  return { template, hits: hits.map((k) => m.raster.toPdf(k.s.cx, k.s.cy)), report };
}

/** Lower every candidate's distance by its best match against one template's variants. */
function score(cands: Candidate[], variants: Variant[], index: number, lookAlike: boolean): void {
  for (const k of cands) {
    for (const v of variants) {
      if (Math.abs(Math.log(v.aspect / k.s.aspect)) > ASPECT_BAND) continue;
      const d = sigDistance(v.sig, k.s.sig);
      if (d >= k.d) continue;
      // the look-alike test: a one-sided blob of difference (a dot one has
      // and the other lacks) rejects the pair whatever the distance
      const local = localDifference(v.raw, k.s.raw, SIG);
      if (index === 0 && local < k.local) k.local = local;
      if (lookAlike && local > LOCAL_MAX) continue;
      k.d = d;
      k.via = index;
    }
  }
}

/**
 * Per-sheet threshold from the distances of the other candidates to the
 * clicked symbol (the click itself, at 0, is left out). Siblings sit
 * nearest; the first gap of at least AUTO_MIN_GAP after a member beyond
 * AUTO_FLOOR (or of at least AUTO_BIG_GAP after a nearer one: identical
 * renders sit at 0) marks the edge of their cluster, and the threshold
 * goes just past that member (half way into the gap, at most AUTO_REACH),
 * clamped into [AUTO_MIN, AUTO_MAX]. The widest gap is not used: on a
 * sheet whose look-alike classes run into each other the widest gap is
 * noise further out, and a threshold there lets the look-alikes in. Null
 * when no member under AUTO_MAX is followed by such a gap (continuous
 * distribution, or nothing near the click), so the caller keeps its
 * constant.
 */
export function autoThreshold(distances: number[]): number | null {
  const xs = distances.slice().sort((a, b) => a - b);
  for (let i = 0; i < xs.length; i++) {
    const lo = xs[i];
    if (lo > AUTO_MAX) break;
    const hi = i + 1 < xs.length ? xs[i + 1] : 1;
    const gap = hi - lo;
    if (gap < (lo < AUTO_FLOOR ? AUTO_BIG_GAP : AUTO_MIN_GAP)) continue;
    return Math.min(AUTO_MAX, Math.max(AUTO_MIN, lo + Math.min(gap / 2, AUTO_REACH)));
  }
  return null;
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
 * Localized difference between two raw coverage grids: the largest share
 * of the ink in any 3 x 3 block that is in one grid and not the other.
 * A missing interior dot is one same-sign blob (share near 1); a shifted
 * edge is a plus stripe beside a minus stripe (share near 0), so this
 * tells a look-alike from a sibling where the relative L1 cannot. Blocks
 * with less than LOCAL_MIN_MASS cells of ink are skipped (stray pixels).
 */
function localDifference(a: Float32Array, b: Float32Array, n: number): number {
  let best = 0;
  for (let i = 0; i + 3 <= n; i++) {
    for (let j = 0; j + 3 <= n; j++) {
      let d = 0;
      let s = 0;
      for (let ii = 0; ii < 3; ii++) {
        for (let jj = 0; jj < 3; jj++) {
          const k = (i + ii) * n + j + jj;
          d += a[k] - b[k];
          s += a[k] + b[k];
        }
      }
      if (s < LOCAL_MIN_MASS) continue;
      const r = Math.abs(d) / s;
      if (r > best) best = r;
    }
  }
  return best;
}

/** The template's signature variants: the identity alone, or the 8 dihedral transforms. */
function variantsOf(t: { sig: Float32Array; raw: Float32Array; aspect: number }, dihedral: boolean, n = SIG): Variant[] {
  return dihedral ? dihedralVariants(t, n) : [{ sig: t.sig, raw: t.raw, aspect: t.aspect }];
}

/**
 * The template signature under the 8 dihedral transforms: identity, three
 * rotations, two mirrors and the two diagonal flips. Transforms that swap
 * the axes carry the inverted aspect ratio.
 */
function dihedralVariants(t: { sig: Float32Array; raw: Float32Array; aspect: number }, n: number): Variant[] {
  const a = t.aspect;
  const make = (f: (i: number, j: number) => number, swap: boolean) => {
    const sig = new Float32Array(n * n);
    const raw = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        sig[i * n + j] = t.sig[f(i, j)];
        raw[i * n + j] = t.raw[f(i, j)];
      }
    }
    return { sig, raw, aspect: swap ? 1 / a : a };
  };
  const m = n - 1;
  return [
    { sig: t.sig, raw: t.raw, aspect: a },
    make((i, j) => (m - i) * n + (m - j), false), // rotate 180
    make((i, j) => i * n + (m - j), false), // mirror left-right
    make((i, j) => (m - i) * n + j, false), // mirror top-bottom
    make((i, j) => (m - j) * n + i, true), // rotate 90
    make((i, j) => j * n + (m - i), true), // rotate 270
    make((i, j) => j * n + i, true), // transpose
    make((i, j) => (m - j) * n + (m - i), true), // anti-transpose
  ];
}

/** The coverage grid box-blurred, so a one-cell shift costs little. */
function blurredSig(raw: Float32Array, n: number): Float32Array {
  const sig = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      let k = 0;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= n) continue;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= n) continue;
          s += raw[ii * n + jj];
          k++;
        }
      }
      sig[i * n + j] = s / k;
    }
  }
  return sig;
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
  const sig = blurredSig(raw, SIG);
  if (count === 0) count = 1;
  c.shape = { count, x0, y0, x1, y1, cx: sx / count, cy: sy / count, fill: count / (bw * bh), aspect: bw / bh, sig, raw };
  return c.shape;
}
