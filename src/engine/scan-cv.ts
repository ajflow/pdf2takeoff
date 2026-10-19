// Scan provider, tier 1: classic computer vision, no model download.
// Click one instance of a repeated symbol; the host rasterizes the page, and
// this pass binarizes the ink, extracts connected components, and matches
// every component to the clicked one by size, aspect, fill and a normalized
// shape signature. Runs in well under a second per sheet on typed arrays
// alone. Tier 2 (scan-onnx.ts) is a trained detector that slots in behind
// the same ScanResult interface; scan.ts picks whichever is available.

import type { Pt } from './types.ts';
import type { RasterPage } from './ports.ts';
import type { ScanResult } from './types.ts';

const SIG = 20; // signature grid
const MIN_COMPONENT_PX = 12;
const MATCH_DIST = 0.16; // signature L1 distance threshold (0 = identical)
const SIZE_BAND = 0.55; // sqrt area ratio bounds (1/x .. x)
const ASPECT_BAND = 0.3; // |log aspect ratio difference|
const FILL_BAND = 0.18;

interface Component {
  label: number;
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  fill: number;
  sig: Float32Array;
}

/** Opt-in instrumentation for the detector-accuracy bench (evals/bench-detector.mjs):
 *  every component the scan considered, tagged with the first match gate it
 *  failed — so a miss can say *why* it was missed. No behaviour change when
 *  absent. */
export interface CvTrace {
  /** components dropped by the size bounds before matching began */
  dropped: Array<{ cx: number; cy: number; count: number; reason: 'too-small' | 'too-large' }>;
  /** every component that reached matching, with its outcome */
  components: Array<{
    cx: number; cy: number; count: number;
    x0: number; y0: number; x1: number; y1: number;
    status: 'hit' | 'size' | 'aspect' | 'fill' | 'signature';
  }>;
}

export function cvScan(raster: RasterPage, clicked: Pt, trace?: CvTrace): ScanResult {
  const w = raster.width;
  const h = raster.height;
  const data = raster.data;

  // ink mask — vector CAD output is high-contrast, a fixed threshold is enough
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const lum = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    mask[i] = lum < 150 ? 1 : 0;
  }

  // clicked point → raster px (with a small tolerance for anti-aliased edges)
  const click = raster.toRaster(clicked.x, clicked.y);
  const px = Math.round(click.x);
  const py = Math.round(click.y);
  let clickedLabel = 0;
  if (px >= 0 && py >= 0 && px < w && py < h) {
    // ring search up to ~3.3 PDF pt so a click anywhere inside a symbol
    // (not just exactly on a stroke) still teaches the scan
    for (let r = 0; r <= 10 && !clickedLabel; r++) {
      for (let dy = -r; dy <= r && !clickedLabel; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (mask[y * w + x]) {
            clickedLabel = -1; // marker: ink found, label assigned after pass
            break;
          }
        }
      }
    }
  }
  if (!clickedLabel) return { error: 'click directly on a symbol to teach the scan' };

  // connected components, 8-connectivity, iterative flood fill
  const labels = new Int32Array(w * h);
  const comps: Component[] = [];
  const stack: number[] = [];
  let nextLabel = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = ++nextLabel;
    stack.length = 0;
    stack.push(start);
    labels[start] = id;
    let count = 0;
    let sx = 0;
    let sy = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const y = (idx / w) | 0;
      const x = idx - y * w;
      count++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const nidx = ny * w + nx;
          if (mask[nidx] && !labels[nidx]) {
            labels[nidx] = id;
            stack.push(nidx);
          }
        }
      }
    }
    if (count < MIN_COMPONENT_PX || count > (w * h) / 16) {
      trace?.dropped.push({
        cx: sx / count, cy: sy / count, count,
        reason: count < MIN_COMPONENT_PX ? 'too-small' : 'too-large',
      });
      continue;
    }
    comps.push(makeComponent(id, count, x0, y0, x1, y1, sx / count, sy / count, labels, w));
  }

  // resolve the clicked component (first ink pixel at/around the click)
  let template: Component | undefined;
  if (px >= 0 && py >= 0 && px < w && py < h) {
    outer: for (let r = 0; r <= 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const l = labels[y * w + x];
          if (l) {
            template = comps.find((c) => c.label === l);
            break outer;
          }
        }
      }
    }
  }
  if (!template)
    return {
      error: 'that symbol is too small or part of a large structure; try a smaller, isolated symbol',
    };

  // match every component against the template; the first gate a component
  // fails is its trace status (gate order: size → aspect → fill → signature)
  const aspectT = (template.x1 - template.x0 + 1) / (template.y1 - template.y0 + 1);
  const hits: Pt[] = [];
  for (const c of comps) {
    const status: CvTrace['components'][number]['status'] = (() => {
      const sizeRatio = Math.sqrt(template.count / c.count);
      if (sizeRatio < SIZE_BAND || sizeRatio > 1 / SIZE_BAND) return 'size';
      const aspectC = (c.x1 - c.x0 + 1) / (c.y1 - c.y0 + 1);
      if (Math.abs(Math.log(aspectT / aspectC)) > ASPECT_BAND) return 'aspect';
      if (Math.abs(template.fill - c.fill) > FILL_BAND) return 'fill';
      return 'signature'; // proven below unless the distance passes
    })();
    if (status === 'signature') {
      let d = 0;
      for (let i = 0; i < template.sig.length; i++) d += Math.abs(template.sig[i] - c.sig[i]);
      if (d <= MATCH_DIST) {
        hits.push(raster.toPdf(c.cx, c.cy));
        trace?.components.push({ cx: c.cx, cy: c.cy, count: c.count, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, status: 'hit' });
        continue;
      }
    }
    trace?.components.push({ cx: c.cx, cy: c.cy, count: c.count, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, status });
  }

  // stable numbering: reading order, rows then columns
  hits.sort((a, b) => (Math.abs(b.y - a.y) > 8 ? b.y - a.y : a.x - b.x));
  return { hits, provider: 'cv', templatePx: template.count };
}

function makeComponent(
  label: number,
  count: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  labels: Int32Array,
  w: number,
): Component {
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  // shape signature: ink coverage downsampled to a SIG x SIG grid over the bbox
  const sig = new Float32Array(SIG * SIG);
  const cellW = bw / SIG;
  const cellH = bh / SIG;
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    const gy = Math.min(SIG - 1, Math.floor((y - y0) / cellH));
    for (let x = x0; x <= x1; x++) {
      if (labels[row + x] === label) {
        const gx = Math.min(SIG - 1, Math.floor((x - x0) / cellW));
        sig[gy * SIG + gx] += 1;
      }
    }
  }
  const perCell = cellW * cellH;
  for (let i = 0; i < sig.length; i++) sig[i] = Math.min(1, sig[i] / perCell);
  return { label, count, x0, y0, x1, y1, cx, cy, fill: count / (bw * bh), sig };
}
