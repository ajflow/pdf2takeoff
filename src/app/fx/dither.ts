// Flow State "wonder" layer: one ordered (Bayer) dither drawn on a canvas
// over an element. A paint is a field from 0 to 1 over the element's CSS
// pixels; a cell lights when the strongest paint beats its Bayer threshold, in
// that paint's colour. Paints come in two kinds: lasting ones (the living
// point, a drifting wave) and moments (a short burst that resolves, then
// calls back). The layer runs only while its element is on screen, the tab
// is visible and something is drawing; under prefers-reduced-motion nothing
// runs at all and callers show the finished state.

const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const BAYER = Float32Array.from(BAYER_8, (v) => (v + 0.5) / 64);

export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const ease = (t: number): number => 1 - Math.pow(1 - t, 3);
export const band = (u: number, at: number, width: number): number => Math.exp(-(((u - at) / width) ** 2));

/** A CSS colour from a custom property on :root (tokens live there). */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#71e7de';
}

/** x0, y0, x1, y1 in the layer's CSS pixels. */
export type Box = [number, number, number, number];

export interface Paint {
  colour: string;
  /** Time-independent: drawn once, then the layer sleeps until wake() (a scroll, a resize). */
  still?: boolean;
  /** Once per frame, before any cell is evaluated (easing, following the pointer). */
  update?(now: number): void;
  /** Where the paint can be non-zero this frame; null draws nothing. Omitted: the whole layer. */
  bounds?(now: number): Box | null;
  field(x: number, y: number, now: number): number;
}

/**
 * The living point: a breathing field whose edge wobbles on layered sines so
 * it never repeats, with rings drifting outward like the Flowtivity wave.
 */
export interface LivingPoint {
  x: number;
  y: number;
  R: number;
  amp: number;
  seed: number;
  speed: number;
}

export function breath(x: number, y: number, p: LivingPoint, now: number): number {
  const dx = x - p.x;
  const dy = y - p.y;
  const d = Math.hypot(dx, dy);
  if (d > p.R * 2.4 || p.amp <= 0) return 0;
  const a = Math.atan2(dy, dx);
  const s = p.seed;
  const r =
    p.R *
    (1 +
      0.11 * Math.sin(3 * a + now * 0.0009 * p.speed + s) +
      0.07 * Math.sin(5 * a - now * 0.0014 * p.speed + s * 2) +
      0.13 * Math.sin(now * 0.0011 * p.speed + s * 3));
  const rings = 0.5 + 0.5 * Math.sin((d - now * 0.028 * p.speed) / 8.5);
  return p.amp * Math.exp(-((d / r) ** 2) * 1.5) * (0.5 + 0.5 * rings);
}

export function pointBounds(p: LivingPoint): Box | null {
  if (p.amp <= 0.01) return null;
  const r = p.R * 2.4;
  return [p.x - r, p.y - r, p.x + r, p.y + r];
}

interface Moment {
  colour: string;
  t0: number;
  ms: number;
  fn: (x: number, y: number, t: number) => number;
  bounds?: (t: number) => Box | null;
  done?: () => void;
}

/**
 * A chrome moment: a short dither burst over an element (a button, a row, the
 * rail) on a state change. `fn(x, y, w, h, t)` in the element's CSS pixels,
 * t from 0 to 1; the overlay canvas removes itself when the moment ends.
 */
export function chromeMoment(
  el: HTMLElement,
  ms: number,
  colour: string,
  fn: (x: number, y: number, w: number, h: number, t: number) => number,
  cell = 2,
): Promise<void> {
  if (reducedMotion() || !el.isConnected) return Promise.resolve();
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  const c = document.createElement('canvas');
  c.className = 'fx-moment';
  c.setAttribute('aria-hidden', 'true');
  el.append(c);
  const g = c.getContext('2d')!;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const w = el.clientWidth;
      const h = el.clientHeight;
      const dpr = Math.min(2, devicePixelRatio || 1);
      if (c.width !== Math.round(w * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const px = cell * dpr;
      const cols = Math.ceil(w / cell);
      const rows = Math.ceil(h / cell);
      g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = colour;
      g.beginPath();
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          if (fn((i + 0.5) * cell, (j + 0.5) * cell, w, h, t) > BAYER[(j & 7) * 8 + (i & 7)]) g.rect(Math.round(i * px), Math.round(j * px), Math.ceil(px), Math.ceil(px));
        }
      }
      g.fill();
      if (t < 1) requestAnimationFrame(step);
      else {
        c.remove();
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

export class DitherLayer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private paints = new Map<string, Paint>();
  private moments = new Set<Moment>();
  private visible = false;
  private raf = 0;
  private observer: IntersectionObserver;

  private lastDraw = 0;
  /** `canvas`: draw into an existing canvas (placed by the page) instead of appending one; `fps` caps ambient layers. */
  constructor(
    readonly host: HTMLElement,
    private cell = 3,
    canvas?: HTMLCanvasElement,
    private fps = 60,
  ) {
    if (canvas) this.canvas = canvas;
    else {
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'fx-dither';
      this.canvas.setAttribute('aria-hidden', 'true');
      host.append(this.canvas);
    }
    this.ctx = this.canvas.getContext('2d')!;
    this.observer = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      this.kick();
    });
    this.observer.observe(host);
    document.addEventListener('visibilitychange', () => this.kick());
  }

  set(id: string, paint: Paint): void {
    this.paints.set(id, paint);
    this.kick();
  }

  delete(id: string): void {
    this.paints.delete(id);
    this.kick();
  }

  has(id: string): boolean {
    return this.paints.has(id);
  }

  /** A moment: `fn(x, y, t)` with t running 0 to 1 over `ms`; resolves when it ends. */
  play(ms: number, colour: string, fn: Moment['fn'], bounds?: Moment['bounds']): Promise<void> {
    return new Promise((resolve) => {
      this.moments.add({ colour, t0: performance.now(), ms, fn, bounds, done: resolve });
      this.kick();
    });
  }

  /** Start drawing again after input (a paint that went quiet stops the loop). */
  wake(): void {
    this.kick();
  }

  private kick(): void {
    if (this.raf || !this.visible || document.hidden) return;
    if (!this.paints.size && !this.moments.size) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    // ambient layers skip frames to stay cheap (moments always run at full rate)
    if (this.fps < 60 && !this.moments.size && now - this.lastDraw < 1000 / this.fps - 2) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    this.lastDraw = now;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const step = this.cell; // CSS px per cell
    const cols = Math.ceil(w / step);
    const rows = Math.ceil(h / step);
    const best = new Float32Array(cols * rows);
    const pick = new Uint8Array(cols * rows);
    const colours: string[] = [];
    let ux0 = cols;
    let uy0 = rows;
    let ux1 = -1;
    let uy1 = -1;

    const paint = (field: (x: number, y: number) => number, box: Box | null | undefined, colour: string) => {
      const b = box ?? [0, 0, w, h];
      const i0 = Math.max(0, Math.floor(b[0] / step));
      const j0 = Math.max(0, Math.floor(b[1] / step));
      const i1 = Math.min(cols - 1, Math.ceil(b[2] / step));
      const j1 = Math.min(rows - 1, Math.ceil(b[3] / step));
      if (i1 < i0 || j1 < j0) return;
      let k = colours.indexOf(colour);
      if (k < 0) k = colours.push(colour) - 1;
      for (let j = j0; j <= j1; j++) {
        const y = (j + 0.5) * step;
        for (let i = i0; i <= i1; i++) {
          const v = field((i + 0.5) * step, y);
          const n = j * cols + i;
          if (v > best[n]) {
            best[n] = v;
            pick[n] = k;
          }
        }
      }
      ux0 = Math.min(ux0, i0);
      uy0 = Math.min(uy0, j0);
      ux1 = Math.max(ux1, i1);
      uy1 = Math.max(uy1, j1);
    };

    let moving = false;
    for (const p of this.paints.values()) {
      p.update?.(now);
      const box = p.bounds ? p.bounds(now) : undefined;
      if (box === null) continue;
      if (!p.still) moving = true;
      paint((x, y) => p.field(x, y, now), box, p.colour);
    }
    const ended: Moment[] = [];
    for (const m of this.moments) {
      const t = Math.min(1, (now - m.t0) / m.ms);
      const box = m.bounds ? m.bounds(t) : undefined;
      if (box !== null) paint((x, y) => m.fn(x, y, t), box, m.colour);
      if (t >= 1) ended.push(m);
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, cw, ch);
    const px = step * dpr;
    for (let k = 0; k < colours.length; k++) {
      ctx.fillStyle = colours[k];
      ctx.beginPath();
      for (let j = uy0; j <= uy1; j++) {
        for (let i = ux0; i <= ux1; i++) {
          const n = j * cols + i;
          if (pick[n] === k && best[n] > BAYER[(j & 7) * 8 + (i & 7)]) ctx.rect(Math.round(i * px), Math.round(j * px), Math.ceil(px), Math.ceil(px));
        }
      }
      ctx.fill();
    }
    for (const m of ended) {
      this.moments.delete(m);
      m.done?.();
    }
    // keep going while anything moving drew or a moment plays; quiet and still paints wait for wake()
    if ((ux1 >= 0 && moving) || this.moments.size) this.kick();
  };
}
