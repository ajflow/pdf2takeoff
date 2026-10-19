// Line removal pre-pass for the tier-1 scan (scan-cv.ts).
//
// Symbols on P&IDs sit on pipes, doors on floor plans sit in walls, and
// leaders run into tags: binarize such a sheet and the symbol is one
// connected component with the whole line network. This pass takes the ink
// mask and removes long straight runs (horizontal, vertical and optionally
// the two 45 degree diagonals) so compact symbol ink survives on its own.
//
// Everything is keyed off the measured dominant stroke width, not pixel
// constants: pipes on a P&ID are thin, walls on a plan are thick, and both
// get rasterized at whatever scale the host picked.
//
//   1. strokeWidth: the mode of the run-length histogram over ink (a
//      vertical line of thickness w contributes one horizontal run of
//      length w per row, so the mode is the stroke, not the line length).
//   2. lines: every horizontal, vertical or diagonal run of ink at least
//      minRun long (default LINE_RUN_FACTOR x strokeWidth, which is several
//      symbol widths), plus dashed lines (three or more short thin runs in
//      a row or column with small gaps, spanning at least minRun: signal
//      lines on a P&ID, hidden lines on a plan), subtracted from the mask.
//   3. stubs: a line segment shorter than minRun that ends on a removed
//      line (the pipe end between a symbol and a junction, an elbow leg, a
//      leader tail) is a thin run of kept ink touching a removed pixel. It
//      is eaten inward until the ink thickens into a bar, an outline or a
//      glyph. Kept ink straight through the removed line within bridgeGap
//      means the line crossed a symbol stroke (a nick), not a stub.
//   4. restoration: removed pixels bracketed by kept ink within bridgeGap
//      along a row or column come back (the nick across a flange bar, the
//      short pipe between a flange pair), then removed pixels within half
//      a stroke of kept ink come back (diagonal nicks).
//
// Steps 3 and 4 only ever look at pixels next to removed ones, so they run
// over the removed-pixel list, not the sheet: the whole pass is one sweep
// for the runs plus one for the subtraction, a few hundred milliseconds on
// a 30 Mpx sheet. Pure typed-array code. Returns the removed-lines mask too
// so the caller can report what was dropped.

/** Long runs are at least this many stroke widths (pipes, walls, leaders). */
export const LINE_RUN_FACTOR = 30;
/** Removed pixels bracketed by kept ink within this many strokes come back. */
export const BRIDGE_GAP_FACTOR = 4;
/** Stub rounds: each round eats one more leg of an elbow. */
export const STUB_ROUNDS = 4;
/** A dash is at most this many strokes long; three or more in a line are linework. */
export const DASH_MAX_FACTOR = 8;
const DASH_MIN_COUNT = 3;
/** Run lengths above this are not candidates for the stroke width. */
const MAX_STROKE = 64;

export interface LineRemovalOptions {
  /** Dominant stroke width in px; measured from the mask when absent. */
  strokeWidth?: number;
  /** Minimum run length (px) that counts as a line; default LINE_RUN_FACTOR x stroke. */
  minRun?: number;
  /** Also remove long 45 degree diagonal runs (leaders). Default true. */
  diagonals?: boolean;
  /** Restore gaps up to this many px between kept ink; default BRIDGE_GAP_FACTOR x stroke. */
  bridgeGap?: number;
  /** Rounds of stub removal (0 disables). Default STUB_ROUNDS. */
  stubRounds?: number;
}

export interface LineRemovalResult {
  /** Ink mask with the long lines and their stubs removed and symbol nicks restored. */
  cleaned: Uint8Array;
  /** The pixels that were removed (after restoration), 1 = dropped. */
  lines: Uint8Array;
  strokeWidth: number;
  minRun: number;
  /** Pixels finally dropped (lines plus stubs, less restorations). */
  removedPx: number;
  /** Pixels first dropped as line, then put back as symbol ink. */
  restoredPx: number;
  /** Pixels dropped by the stub rounds (short pipe ends, leader tails). */
  stubPx: number;
}

/**
 * Dominant stroke width of an ink mask in px: the mode of the run-length
 * histogram over horizontal and vertical runs. Rows and columns are sampled
 * (every 8th) because the histogram converges long before every pixel is
 * read. Returns at least 1.
 */
export function estimateStrokeWidth(mask: Uint8Array, w: number, h: number): number {
  const hist = new Float64Array(MAX_STROKE + 1);
  const step = 8;
  for (let y = 0; y < h; y += step) {
    const row = y * w;
    let run = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && mask[row + x]) run++;
      else if (run) {
        if (run <= MAX_STROKE) hist[run]++;
        run = 0;
      }
    }
  }
  // vertical runs of the sampled columns, swept row-major so the reads stream
  const cols = Math.ceil(w / step);
  const run = new Int32Array(cols);
  for (let y = 0; y <= h; y++) {
    const row = y * w;
    for (let c = 0; c < cols; c++) {
      if (y < h && mask[row + c * step]) run[c]++;
      else if (run[c]) {
        if (run[c] <= MAX_STROKE) hist[run[c]]++;
        run[c] = 0;
      }
    }
  }
  // the mode, ignoring 1 px runs unless they outnumber everything else
  // combined: anti-aliased edges and JPEG noise shed single pixels around
  // every stroke, a true 1 px drawing has nothing else
  let best = 1;
  let bestN = 0;
  let total = 0;
  for (let n = 2; n <= MAX_STROKE; n++) {
    total += hist[n];
    if (hist[n] > bestN) {
      bestN = hist[n];
      best = n;
    }
  }
  if (hist[1] > total) return 1;
  return bestN ? best : 1;
}

/** A growable Int32 list (pixel indices). */
class IndexList {
  buf = new Int32Array(1 << 16);
  n = 0;
  push(i: number): void {
    if (this.n === this.buf.length) {
      const grown = new Int32Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.n++] = i;
  }
}

/**
 * Remove long straight lines from an ink mask. `mask` is not modified.
 */
export function removeLines(mask: Uint8Array, w: number, h: number, opts: LineRemovalOptions = {}): LineRemovalResult {
  const strokeWidth = Math.max(1, opts.strokeWidth ?? estimateStrokeWidth(mask, w, h));
  const minRun = Math.max(3, Math.round(opts.minRun ?? LINE_RUN_FACTOR * strokeWidth));
  const bridgeGap = Math.max(1, Math.round(opts.bridgeGap ?? BRIDGE_GAP_FACTOR * strokeWidth));
  const stubRounds = opts.stubRounds ?? STUB_ROUNDS;
  const diagonals = opts.diagonals ?? true;
  const n = w * h;
  const lines = new Uint8Array(n);
  const thin = strokeWidth + Math.floor(strokeWidth / 2) + 1;
  const dashMax = DASH_MAX_FACTOR * strokeWidth;

  // 1. long runs in one ink-driven sweep. Blank 4-pixel groups are skipped
  // through a 32-bit view, and each tracker (the row run, one open run per
  // column, one per diagonal x - y and x + y) only ever sees ink: a run
  // continues when the previous pixel along it was the last ink seen there,
  // otherwise the old run closes and a new one opens. Nothing is paid for
  // the 97% of the sheet that is paper.
  {
    const vStart = new Int32Array(w).fill(-1);
    const vLast = new Int32Array(w).fill(-2);
    const aStart = diagonals ? new Int32Array(w + h).fill(-1) : null; // index x - y + h
    const aLast = diagonals ? new Int32Array(w + h).fill(-2) : null;
    const bStart = diagonals ? new Int32Array(w + h).fill(-1) : null; // index x + y
    const bLast = diagonals ? new Int32Array(w + h).fill(-2) : null;
    let hStart = -1;
    let hLast = -2;
    // dash chains: short thin runs with small gaps along a row or column
    // (a stroke crossing the dash, such as a stub meeting it, may thicken
    // up to one stroke's worth of its pixels)
    const dashThinH = (a: number, b: number): boolean => {
      const y = (a / w) | 0;
      let thick = 0;
      for (let i = a; i <= b; i++) {
        let t = 1;
        for (let yy = y - 1; yy >= 0 && t <= thin && mask[i + (yy - y) * w]; yy--) t++;
        for (let yy = y + 1; yy < h && t <= thin && mask[i + (yy - y) * w]; yy++) t++;
        if (t > thin && ++thick > thin) return false;
      }
      return true;
    };
    const dashThinV = (x: number, y0: number, y1: number): boolean => {
      let thick = 0;
      for (let y = y0; y <= y1; y++) {
        const row = y * w;
        let t = 1;
        for (let xx = x - 1; xx >= 0 && t <= thin && mask[row + xx]; xx--) t++;
        for (let xx = x + 1; xx < w && t <= thin && mask[row + xx]; xx++) t++;
        if (t > thin && ++thick > thin) return false;
      }
      return true;
    };
    let chStart = -1; // row chain: first index, last index, run count
    let chEnd = -1;
    let chCount = 0;
    const flushChainH = (): void => {
      if (chCount >= DASH_MIN_COUNT && chEnd - chStart + 1 >= minRun) {
        for (let i = chStart; i <= chEnd; i++) if (mask[i]) lines[i] = 1;
      }
      chStart = -1;
      chEnd = -1;
      chCount = 0;
    };
    const closeH = (): void => {
      const len = hLast - hStart + 1;
      if (len >= minRun) {
        lines.fill(1, hStart, hLast + 1);
        flushChainH();
        return;
      }
      const dash = len <= dashMax && dashThinH(hStart, hLast);
      if (dash && chCount && ((chEnd / w) | 0) === ((hStart / w) | 0) && hStart - chEnd - 1 <= dashMax) {
        chEnd = hLast;
        chCount++;
        return;
      }
      flushChainH();
      if (dash) {
        chStart = hStart;
        chEnd = hLast;
        chCount = 1;
      }
    };
    const cStart = new Int32Array(w).fill(-1); // column chains
    const cEnd = new Int32Array(w).fill(-1);
    const cCount = new Int32Array(w);
    const flushChainV = (x: number): void => {
      if (cCount[x] >= DASH_MIN_COUNT && cEnd[x] - cStart[x] + 1 >= minRun) {
        for (let yy = cStart[x]; yy <= cEnd[x]; yy++) if (mask[yy * w + x]) lines[yy * w + x] = 1;
      }
      cStart[x] = -1;
      cEnd[x] = -1;
      cCount[x] = 0;
    };
    const closeV = (x: number): void => {
      const len = vLast[x] - vStart[x] + 1;
      if (len >= minRun) {
        for (let yy = vStart[x]; yy <= vLast[x]; yy++) lines[yy * w + x] = 1;
        flushChainV(x);
        return;
      }
      const dash = len <= dashMax && dashThinV(x, vStart[x], vLast[x]);
      if (dash && cCount[x] && vStart[x] - cEnd[x] - 1 <= dashMax) {
        cEnd[x] = vLast[x];
        cCount[x]++;
        return;
      }
      flushChainV(x);
      if (dash) {
        cStart[x] = vStart[x];
        cEnd[x] = vLast[x];
        cCount[x] = 1;
      }
    };
    const closeA = (a: number): void => {
      const y0 = aStart![a];
      const len = aLast![a] - y0 + 1;
      if (len >= minRun) for (let k = 0, x0 = a - h + y0; k < len; k++) lines[(y0 + k) * w + x0 + k] = 1;
    };
    const closeB = (b: number): void => {
      const y0 = bStart![b];
      const len = bLast![b] - y0 + 1;
      if (len >= minRun) for (let k = 0, x0 = b - y0; k < len; k++) lines[(y0 + k) * w + x0 - k] = 1;
    };
    const visit = (i: number): void => {
      const y = (i / w) | 0;
      const x = i - y * w;
      if (hLast !== i - 1 || x === 0) {
        if (hStart >= 0) closeH();
        hStart = i;
      }
      hLast = i;
      if (vLast[x] !== y - 1) {
        if (vStart[x] >= 0) closeV(x);
        vStart[x] = y;
      }
      vLast[x] = y;
      if (aStart && aLast && bStart && bLast) {
        const a = x - y + h;
        if (aLast[a] !== y - 1) {
          if (aStart[a] >= 0) closeA(a);
          aStart[a] = y;
        }
        aLast[a] = y;
        const b = x + y;
        if (bLast[b] !== y - 1) {
          if (bStart[b] >= 0) closeB(b);
          bStart[b] = y;
        }
        bLast[b] = y;
      }
    };
    const groups = mask.byteOffset % 4 === 0 ? new Uint32Array(mask.buffer, mask.byteOffset, n >> 2) : null;
    if (groups) {
      for (let g = 0; g < groups.length; g++) {
        if (!groups[g]) continue;
        const i = g << 2;
        if (mask[i]) visit(i);
        if (mask[i + 1]) visit(i + 1);
        if (mask[i + 2]) visit(i + 2);
        if (mask[i + 3]) visit(i + 3);
      }
      for (let i = groups.length << 2; i < n; i++) if (mask[i]) visit(i);
    } else {
      for (let i = 0; i < n; i++) if (mask[i]) visit(i);
    }
    if (hStart >= 0) closeH();
    flushChainH();
    for (let x = 0; x < w; x++) {
      if (vStart[x] >= 0) closeV(x);
      flushChainV(x);
    }
    if (aStart && bStart) {
      for (let d = 0; d < w + h; d++) {
        if (aStart[d] >= 0) closeA(d);
        if (bStart[d] >= 0) closeB(d);
      }
    }
  }

  // 2. subtract, keeping the list of removed pixels for the local steps
  const cleaned = new Uint8Array(n);
  const removed = new IndexList();
  {
    const groups = mask.byteOffset % 4 === 0 ? new Uint32Array(mask.buffer, mask.byteOffset, n >> 2) : null;
    const take = (i: number): void => {
      if (lines[i]) removed.push(i);
      else cleaned[i] = 1;
    };
    if (groups) {
      for (let g = 0; g < groups.length; g++) {
        if (!groups[g]) continue;
        const i = g << 2;
        if (mask[i]) take(i);
        if (mask[i + 1]) take(i + 1);
        if (mask[i + 2]) take(i + 2);
        if (mask[i + 3]) take(i + 3);
      }
      for (let i = groups.length << 2; i < n; i++) if (mask[i]) take(i);
    } else {
      for (let i = 0; i < n; i++) if (mask[i]) take(i);
    }
  }
  const linePx = removed.n;

  // 3. stubs
  let stubPx = 0;
  if (stubRounds > 0) {
    // ink thickness across the run direction at a pixel, capped at thin + 1
    const thickV = (x: number, y: number): number => {
      let t = 1;
      for (let yy = y - 1; yy >= 0 && t <= thin && cleaned[yy * w + x]; yy--) t++;
      for (let yy = y + 1; yy < h && t <= thin && cleaned[yy * w + x]; yy++) t++;
      return t;
    };
    const thickH = (x: number, y: number): number => {
      const row = y * w;
      let t = 1;
      for (let xx = x - 1; xx >= 0 && t <= thin && cleaned[row + xx]; xx--) t++;
      for (let xx = x + 1; xx < w && t <= thin && cleaned[row + xx]; xx++) t++;
      return t;
    };
    // kept ink straight on through the removed pixels within bridgeGap:
    // the line crossed this ink (a nick), so the run is not a stub
    const through = (x: number, y: number, dx: number, dy: number): boolean => {
      for (let k = 1; k <= bridgeGap; k++) {
        const xx = x + dx * k;
        const yy = y + dy * k;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) return false;
        const j = yy * w + xx;
        if (cleaned[j]) return true;
        if (!lines[j]) return false;
      }
      return false;
    };
    // eat kept ink from (x, y) stepping (dx, dy) while it stays thin
    const eat = (x: number, y: number, dx: number, dy: number, out: IndexList): void => {
      for (let count = 0; count < minRun; count++) {
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const j = y * w + x;
        if (!cleaned[j]) break;
        if ((dx ? thickV(x, y) : thickH(x, y)) > thin) break;
        cleaned[j] = 0;
        lines[j] = 1;
        out.push(j);
        x += dx;
        y += dy;
      }
    };
    let work = removed;
    for (let round = 0; round < stubRounds && work.n; round++) {
      const next = new IndexList();
      for (let k = 0; k < work.n; k++) {
        const i = work.buf[k];
        const y = (i / w) | 0;
        const x = i - y * w;
        if (x + 1 < w && cleaned[i + 1] && !through(x, y, -1, 0)) eat(x + 1, y, 1, 0, next);
        if (x > 0 && cleaned[i - 1] && !through(x, y, 1, 0)) eat(x - 1, y, -1, 0, next);
        if (y + 1 < h && cleaned[i + w] && !through(x, y, 0, -1)) eat(x, y + 1, 0, 1, next);
        if (y > 0 && cleaned[i - w] && !through(x, y, 0, 1)) eat(x, y - 1, 0, -1, next);
      }
      stubPx += next.n;
      work = next;
    }
  }

  // 4a. gap fill along rows and columns: a removed run bracketed on both
  // sides by kept ink within bridgeGap is symbol ink the line passed through
  let restoredPx = 0;
  const bridge = (x: number, y: number, dx: number, dy: number): void => {
    // (x, y) is removed and the pixel behind it is kept; walk forward
    let len = 0;
    let xx = x;
    let yy = y;
    for (;;) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) return;
      const j = yy * w + xx;
      if (cleaned[j]) break;
      if (!lines[j]) return;
      if (++len > bridgeGap) return;
      xx += dx;
      yy += dy;
    }
    for (let k = 0; k < len; k++) {
      const j = (y + dy * k) * w + x + dx * k;
      cleaned[j] = 1;
      lines[j] = 0;
      restoredPx++;
    }
  };
  for (let k = 0; k < linePx; k++) {
    const i = removed.buf[k];
    if (cleaned[i]) continue;
    const y = (i / w) | 0;
    const x = i - y * w;
    if (x > 0 && cleaned[i - 1]) bridge(x, y, 1, 0);
    if (y > 0 && cleaned[i - w]) bridge(x, y, 0, 1);
  }

  // 4b. removed pixels within half a stroke (Chebyshev) of kept ink come
  // back: closes the diagonal nicks the 1-D fill misses. Decided against
  // a snapshot (collected first, applied after), otherwise each restored
  // pixel would pull in the next one along the whole pipe. Stub pixels are
  // excluded, they sit next to the symbol by construction.
  const r = Math.max(1, Math.ceil(strokeWidth / 2));
  const back = new IndexList();
  for (let k = 0; k < linePx; k++) {
    const i = removed.buf[k];
    if (cleaned[i]) continue;
    const y = (i / w) | 0;
    const x = i - y * w;
    let near = false;
    for (let dy = -r; dy <= r && !near; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      const row = yy * w;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        if (cleaned[row + xx]) {
          near = true;
          break;
        }
      }
    }
    if (near) back.push(i);
  }
  for (let k = 0; k < back.n; k++) {
    cleaned[back.buf[k]] = 1;
    lines[back.buf[k]] = 0;
  }
  restoredPx += back.n;

  return { cleaned, lines, strokeWidth, minRun, removedPx: linePx + stubPx - restoredPx, restoredPx, stubPx };
}
