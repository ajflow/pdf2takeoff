// The homepage's moments of wonder, drawn with the shared dither layer, one
// print-and-dither language from top to bottom: Flowtivity ribbons drifting
// behind the hero with ripples where the pointer moves; the living point on
// the hero's Flow Line; the drop zone that answers a dragged file; halftone
// seams wherever the page changes colour; a dithered scroll line under the
// header; the floor-plan vignette playing a takeoff; the steps and the AI
// flow lighting in turn (amber where a person decides); icons assembling,
// cards answering the pointer, code printing, benchmark bars filling to their
// real numbers, FAQ rows sweeping open, buttons shimmering; and a wave at
// the close. Purely decorative (canvases are aria-hidden, every word stays in
// the HTML); loaded after the page is idle; layers run only on screen and
// sleep when quiet; nothing runs under prefers-reduced-motion.

import { DitherLayer, chromeMoment, breath, pointBounds, ease, band, token, reducedMotion, type LivingPoint, type Box } from './dither';

const MINT = '#71e7de';
const DEEP = '#0b5d61';
const AMBER = '#f5c18a';
const AMBER_INK = '#9a5218';
const RIBBON = '#09837e';

/** Run once when the element is mostly on screen. */
function onView(el: Element, fn: () => void, threshold = 0.4): void {
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      fn();
    },
    { threshold },
  );
  io.observe(el);
}

/** A canvas layer placed as the first child of `host`, behind its content. */
function behind(host: HTMLElement, cell: number, fps = 60): DitherLayer {
  const c = document.createElement('canvas');
  c.className = 'fx-dither fx-behind';
  c.setAttribute('aria-hidden', 'true');
  host.prepend(c);
  return new DitherLayer(host, cell, c, fps);
}

/** The living point following the pointer over an element. */
function cursorPoint(host: HTMLElement, layer: DitherLayer, colour: string, amp = 0.28, radius = 54): void {
  const p: LivingPoint = { x: 0, y: 0, R: radius, amp: 0, seed: Math.random() * 6, speed: 0.9 };
  let tx = 0;
  let ty = 0;
  let tAmp = 0;
  layer.set('cursor', {
    colour,
    update() {
      p.x += (tx - p.x) * 0.12;
      p.y += (ty - p.y) * 0.12;
      p.amp += (tAmp - p.amp) * 0.07;
    },
    bounds: () => pointBounds(p),
    field: (x, y, now) => breath(x, y, p, now),
  });
  host.addEventListener('pointermove', (e) => {
    const r = host.getBoundingClientRect();
    tx = e.clientX - r.left;
    ty = e.clientY - r.top;
    if (tAmp === 0) [p.x, p.y] = [tx, ty];
    tAmp = amp;
    layer.wake();
  });
  host.addEventListener('pointerleave', () => {
    tAmp = 0;
    layer.wake();
  });
}

let started = false;

export function initHome(): void {
  if (started || reducedMotion()) return;
  started = true;
  heroRibbons();
  headline();
  flowLine();
  dropZone();
  seams();
  scrollLine();
  vignette();
  steps();
  aiFlow();
  features();
  codePrint();
  benchBars();
  faq();
  buttons();
  closingWave();
}

// --- hero: Flowtivity ribbons behind, ripples where the pointer moves ---------
//
// Cheap by construction: a ribbon's centre line and thickness depend only on
// x, so they are computed once per column per frame and each cell costs one
// lookup and at most one exp. The ribbons drift for the first few seconds and
// while the pointer is over the hero, then settle into a still frame (no CPU
// at all) until the pointer comes back.

function heroRibbons(): void {
  const hero = document.getElementById('dropzone');
  if (!hero) return;
  const CELL = 5;
  const layer = behind(hero, CELL, 24);
  const smooth = (a: number) => (a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a));
  const proof = hero.querySelector<HTMLElement>('.proof');
  let w = 0;
  let h = 0;
  let proofTop = Infinity;
  // a virtual clock that only runs while the ribbons are drifting
  let clock = 0;
  let last = 0;
  let awakeUntil = performance.now() + 6000;
  const ribbons = [
    { colour: DEEP, amp: 0.44, thick: 0.1, speed: 0.7, lift: 0, phase: 0 },
    { colour: MINT, amp: 0.26, thick: 0.04, speed: 1.2, lift: 0.09, phase: 2 },
  ].map((r) => ({ ...r, mid: new Float32Array(0), th: new Float32Array(0) }));
  let maskX = new Float32Array(0);
  let rowMask = new Float32Array(0);
  const paints: { still: boolean }[] = [];

  const frame = (now: number) => {
    const moving = now < awakeUntil;
    if (moving) clock += Math.min(64, now - (last || now));
    last = now;
    for (const p of paints) p.still = !moving;
    const nw = hero.clientWidth;
    const nh = hero.clientHeight;
    const cols = Math.ceil(nw / CELL) + 1;
    const rows = Math.ceil(nh / CELL) + 1;
    if (nw !== w || nh !== h || maskX.length !== cols) {
      [w, h] = [nw, nh];
      proofTop = proof ? proof.getBoundingClientRect().top - hero.getBoundingClientRect().top : Infinity;
      maskX = new Float32Array(cols);
      for (let c = 0; c < cols; c++) maskX[c] = w < 700 ? 0 : smooth(((c + 0.5) * CELL / w - 0.36) / 0.34);
      // per row: under the text on a phone, and never over the proof strip's words
      rowMask = new Float32Array(rows * 2);
      for (let r = 0; r < rows; r++) {
        const y = (r + 0.5) * CELL;
        rowMask[r * 2] = 1 - smooth((y - (proofTop - 40)) / 36);
        rowMask[r * 2 + 1] = smooth((y / h - 0.74) / 0.2);
      }
      for (const r of ribbons) [r.mid, r.th] = [new Float32Array(cols), new Float32Array(cols)];
    }
    const t = clock * 0.0001;
    for (const r of ribbons) {
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) * CELL;
        r.mid[c] = h * (0.98 - r.lift - 0.62 * (x / w)) + h * 0.05 * Math.sin(x / (w * 0.28) + t * 6 * r.speed + r.phase) + h * 0.015 * Math.sin(x / (w * 0.12) - t * 9 * r.speed + r.phase * 2);
        r.th[c] = h * r.thick * (0.8 + 0.2 * Math.sin(x / (w * 0.37) - t * 4 * r.speed + r.phase * 3));
      }
    }
  };
  ribbons.forEach((r, i) => {
    const paint = {
      colour: r.colour,
      still: false,
      update: i === 0 ? frame : undefined,
      field(x: number, y: number) {
        const c = (x / CELL) | 0;
        const row = (y / CELL) | 0;
        const foot = rowMask[row * 2];
        if (!(foot > 0)) return 0;
        const m = foot * Math.max(maskX[c], rowMask[row * 2 + 1]);
        if (m <= 0) return 0;
        const d = (y - r.mid[c]) / r.th[c];
        return d > 2.6 || d < -2.6 ? 0 : r.amp * m * Math.exp(-d * d);
      },
    };
    paints.push(paint);
    layer.set(`ribbon${i}`, paint);
  });

  const ripples: { x: number; y: number; t0: number }[] = [];
  let lastRipple = 0;
  hero.addEventListener('pointermove', (e) => {
    const now = performance.now();
    awakeUntil = now + 3000; // drift while someone is here
    if (now - lastRipple > 160) {
      lastRipple = now;
      const r = hero.getBoundingClientRect();
      ripples.push({ x: e.clientX - r.left, y: e.clientY - r.top, t0: now });
      if (ripples.length > 5) ripples.shift();
    }
    layer.wake();
  });
  layer.set('ripples', {
    colour: MINT,
    update(now) {
      while (ripples.length && now - ripples[0].t0 > 1400) ripples.shift();
    },
    bounds(now) {
      if (!ripples.length) return null;
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const rp of ripples) {
        const r = (now - rp.t0) * 0.16 + 12;
        [x0, y0, x1, y1] = [Math.min(x0, rp.x - r), Math.min(y0, rp.y - r), Math.max(x1, rp.x + r), Math.max(y1, rp.y + r)];
      }
      return [x0, y0, x1, y1];
    },
    field(x, y, now) {
      let v = 0;
      for (const rp of ripples) {
        const a = now - rp.t0;
        const d = Math.hypot(x - rp.x, y - rp.y) - a * 0.16;
        if (d > 14 || d < -14) continue;
        v = Math.max(v, Math.exp(-((d / 6) ** 2)) * (1 - a / 1400) * 0.5);
      }
      return v;
    },
  });
}

/** The headline's accent shimmers once as the page settles. */
function headline(): void {
  const accent = document.querySelector<HTMLElement>('#hero-title .accent');
  if (!accent) return;
  setTimeout(() => void chromeMoment(accent, 1100, MINT, (x, _y, w, _h, t) => band(x / w, ease(t) * 1.4 - 0.2, 0.09) * 0.8, 3), 900);
}

// --- halftone seams wherever the page changes colour ------------------------------

function seams(): void {
  const sections = [document.getElementById('dropzone'), ...document.querySelectorAll<HTMLElement>('#seo > section')].filter(Boolean) as HTMLElement[];
  const bg = (el: HTMLElement) => getComputedStyle(el).backgroundColor;
  for (let i = 1; i < sections.length; i++) {
    const above = bg(sections[i - 1]);
    const below = bg(sections[i]);
    if (above === below || above === 'rgba(0, 0, 0, 0)') continue;
    const seam = document.createElement('div');
    seam.className = 'fx-seam';
    seam.setAttribute('aria-hidden', 'true');
    sections[i].prepend(seam);
    const layer = new DitherLayer(seam, 4, undefined, 24);
    const phase = i * 1.7;
    layer.set('edge', {
      colour: above,
      field(x, y, now) {
        const h = seam.clientHeight;
        const t = now * 0.0003;
        // the colour above dissolves into the one below along a slow wave
        const edge = h * (0.46 + 0.14 * Math.sin(x / 210 + t + phase) + 0.06 * Math.sin(x / 73 - t * 1.6 + phase));
        return Math.min(1, Math.max(0, 1 - (y - edge) / (h * 0.36)));
      },
    });
  }
}

// --- a dithered scroll line under the header ----------------------------------------

function scrollLine(): void {
  const header = document.getElementById('siteHeader');
  if (!header) return;
  const line = document.createElement('div');
  line.className = 'fx-scroll';
  line.setAttribute('aria-hidden', 'true');
  header.append(line);
  const layer = new DitherLayer(line, 2);
  let progress = 0;
  layer.set('progress', {
    colour: MINT,
    still: true,
    bounds: () => (progress > 0.002 ? [0, 0, line.clientWidth * progress + 12, line.clientHeight] : null),
    field(x) {
      const head = line.clientWidth * progress;
      if (x > head + 10) return 0;
      // a halftone trail that thickens towards the head
      return x > head ? band(x, head, 5) : 0.25 + 0.75 * (x / Math.max(1, head)) ** 2;
    },
  });
  const update = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    progress = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
    layer.wake();
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
}

// --- AI and accuracy: the point walks the flow, amber where a person decides ---------

function aiFlow(): void {
  const section = document.getElementById('ai');
  const list = section?.querySelector<HTMLElement>('.flow-list');
  const dots = [...(list?.querySelectorAll<HTMLElement>('.dot') ?? [])];
  if (!section || !list || dots.length < 2) return;
  const layer = behind(section, 3);
  cursorPoint(section, layer, MINT, 0.16, 60);
  const at = (el: HTMLElement): [number, number] => {
    const s = section.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return [r.left - s.left + r.width / 2, r.top - s.top + r.height / 2];
  };
  const figures = [...section.querySelectorAll<HTMLElement>('.figure .num')];
  onView(list, async () => {
    figures.forEach((f, i) => setTimeout(() => void chromeMoment(f, 900, MINT, (x, _y, w, _h, t) => band(x / w, ease(t) * 1.4 - 0.2, 0.12) * 0.85, 3), 200 + i * 350));
    for (let i = 0; i < dots.length; i++) {
      const flagged = i >= dots.length - 2; // "arrives flagged" and "you confirm"
      const colour = flagged ? AMBER : MINT;
      const [cx, cy] = at(dots[i]);
      if (i > 0) {
        const [px, py] = at(dots[i - 1]);
        await layer.play(
          520,
          colour,
          (x, y, t) => {
            const hx = px + (cx - px) * ease(t);
            const hy = py + (cy - py) * ease(t);
            return Math.max(Math.exp(-((Math.hypot(x - hx, y - hy) / 9) ** 2)), band(x, cx, 3) * (y > py && y < hy ? 0.45 : 0));
          },
          () => [Math.min(px, cx) - 20, Math.min(py, cy) - 20, Math.max(px, cx) + 20, Math.max(py, cy) + 20] as Box,
        );
      }
      dots[i].classList.add('lit');
      void layer.play(
        600,
        colour,
        (x, y, t) => band(Math.hypot(x - cx, y - cy), 18 + ease(t) * 26, 6) * (1 - t),
        () => [cx - 60, cy - 60, cx + 60, cy + 60] as Box,
      );
    }
    // the last step is a person's: it keeps breathing in amber
    const p: LivingPoint = { x: 0, y: 0, R: 26, amp: 0.5, seed: 2.2, speed: 0.7 };
    layer.set('person', {
      colour: AMBER,
      update() {
        [p.x, p.y] = at(dots[dots.length - 1]);
      },
      bounds: () => pointBounds(p),
      field: (x, y, now) => breath(x, y, p, now),
    });
  });
}

// --- features: icons assemble, cards answer the pointer -------------------------------

function features(): void {
  const cards = [...document.querySelectorAll<HTMLElement>('#seo .features .feature')];
  if (!cards.length) return;
  for (const card of cards) {
    const layer = behind(card, 3);
    cursorPoint(card, layer, RIBBON, 0.13, 40);
  }
  onView(
    cards[0].parentElement!,
    () =>
      cards.forEach((card, i) => {
        const icon = card.querySelector<SVGElement>('svg');
        if (!icon) return;
        icon.style.opacity = '0';
        setTimeout(() => {
          const cr = card.getBoundingClientRect();
          const ir = icon.getBoundingClientRect();
          const [ix, iy, iw, ih] = [ir.left - cr.left, ir.top - cr.top, ir.width, ir.height];
          icon.style.transition = 'opacity .5s ease .25s';
          icon.style.opacity = '';
          void chromeMoment(card, 750, RIBBON, (x, y, _w, _h, t) => {
            if (x < ix - 6 || x > ix + iw + 6 || y < iy - 6 || y > iy + ih + 6) return 0;
            return 1.05 - ease(t) * 1.2 + 0.2 * Math.sin(x * 0.9 + y * 1.3) * (1 - t);
          });
        }, i * 110);
      }),
    0.25,
  );
}

// --- agents: a print head runs along the code ---------------------------------------------

function codePrint(): void {
  const blocks = [...document.querySelectorAll<HTMLElement>('#agents .code')];
  blocks.forEach((b, i) =>
    onView(b, () => setTimeout(() => void chromeMoment(b, 1200, MINT, (x, y, w, h, t) => {
      // line by line, like a printer: the head sweeps each 1.7em row in turn
      const rowH = parseFloat(getComputedStyle(b).lineHeight) || 24;
      const rows = Math.max(1, Math.round(h / rowH));
      const row = Math.floor(y / rowH);
      const local = t * rows - row;
      if (local < 0 || local > 1) return 0;
      return band(x / w, ease(local) * 1.2 - 0.1, 0.05) * 0.85;
    }, 2), i * 300), 0.6),
  );
}

// --- benchmarks: halftone bars fill to the real numbers ---------------------------------------

function benchBars(): void {
  const rows = [...document.querySelectorAll<HTMLTableRowElement>('#benchmarks table.bench tbody tr')];
  const value = (text: string | undefined): { v: number; pct: boolean } | null => {
    const m = /(\d+(?:\.\d+)?)\s*(%)?/.exec(text ?? '');
    if (!m) return null;
    const n = parseFloat(m[1]);
    return m[2] ? { v: n / 100, pct: true } : n <= 1 ? { v: n, pct: false } : null;
  };
  for (const row of rows) {
    const ours = value(row.cells[2]?.querySelector('b')?.textContent ?? undefined);
    if (!ours) continue;
    const theirs = value(row.cells[3]?.querySelector('b')?.textContent ?? undefined);
    const compare = theirs && theirs.pct === ours.pct ? theirs.v : null;
    const bar = document.createElement('span');
    bar.className = 'fx-bar';
    bar.setAttribute('aria-hidden', 'true');
    row.cells[2].querySelector('b')!.after(bar);
    const layer = new DitherLayer(bar, 2);
    let fill = 0;
    layer.set('track', {
      colour: RIBBON,
      still: true,
      field(x) {
        const w = bar.clientWidth;
        const head = w * ours.v * fill;
        if (x <= head) return x > head - 5 ? 1 : 0.62; // a solid head on a halftone body
        return 0.07;
      },
    });
    if (compare !== null) {
      layer.set('compare', {
        colour: AMBER_INK,
        still: true,
        bounds: () => [bar.clientWidth * compare - 2, 0, bar.clientWidth * compare + 2, bar.clientHeight],
        field: (x) => (Math.abs(x - bar.clientWidth * compare) <= 1.5 ? 1 : 0),
      });
    }
    onView(row, () => {
      const t0 = performance.now();
      const grow = (now: number) => {
        fill = ease(Math.min(1, (now - t0) / 1100));
        layer.wake();
        if (fill < 1) requestAnimationFrame(grow);
      };
      requestAnimationFrame(grow);
    }, 0.6);
  }
}

// --- FAQ: a row sweeps as it opens ------------------------------------------------------------------

function faq(): void {
  for (const d of document.querySelectorAll<HTMLDetailsElement>('#faq details')) {
    d.addEventListener('toggle', () => {
      const summary = d.querySelector<HTMLElement>('summary');
      if (d.open && summary) void chromeMoment(summary, 620, RIBBON, (x, _y, w, _h, t) => band(x / w, ease(t) * 1.3 - 0.15, 0.08) * 0.7, 2);
    });
  }
}

// --- buttons shimmer when the pointer arrives ---------------------------------------------------------

function buttons(): void {
  const busy = new WeakSet<HTMLElement>();
  for (const b of document.querySelectorAll<HTMLElement>('body.landing .btn-primary, body.landing .btn-outline')) {
    b.addEventListener('pointerenter', () => {
      if (busy.has(b)) return;
      busy.add(b);
      const colour = b.classList.contains('btn-primary') ? '#0a192f' : MINT;
      void chromeMoment(b, 560, colour, (x, _y, w, _h, t) => band(x / w, ease(t) * 1.4 - 0.2, 0.07) * 0.55, 2).then(() => setTimeout(() => busy.delete(b), 400));
    });
  }
}

/** Map an SVG's viewBox units to its host's CSS pixels (the SVG scales uniformly). */
function viewBoxMapper(svg: SVGSVGElement, host: HTMLElement) {
  const vb = svg.viewBox.baseVal;
  return () => {
    const s = svg.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const k = s.width / vb.width;
    return { k, ox: s.left - h.left, oy: s.top - h.top };
  };
}

// --- hero: the point on the Flow Line ------------------------------------------

function flowLine(): void {
  const svg = document.querySelector<SVGSVGElement>('#dropzone svg.flowline');
  const host = svg?.parentElement;
  const hero = document.getElementById('dropzone');
  if (!svg || !host || !hero) return;
  const [wave, dim] = svg.querySelectorAll('path');
  if (!wave || !dim) return;
  const layer = new DitherLayer(host, 3);
  const map = viewBoxMapper(svg, host);
  const mint = token('--fs-mint');

  // the line as x -> y samples in viewBox units: the wave, then the dimension
  const total = wave.getTotalLength();
  const samples: [number, number][] = [];
  for (let i = 0; i <= 160; i++) {
    const p = wave.getPointAtLength((total * i) / 160);
    samples.push([p.x, p.y]);
  }
  const JUNCTION = samples[samples.length - 1];
  samples.push([1240, JUNCTION[1]]);
  const yAt = (x: number): number => {
    if (x <= samples[0][0]) return samples[0][1];
    for (let i = 1; i < samples.length; i++) {
      const [x1, y1] = samples[i];
      if (x <= x1) {
        const [x0, y0] = samples[i - 1];
        return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-6, x1 - x0);
      }
    }
    return samples[samples.length - 1][1];
  };

  // the point rests where the wave becomes the dimension; it follows the
  // pointer along the line while the pointer is over the hero
  let vx = JUNCTION[0];
  let target = JUNCTION[0];
  let lastVx = vx;
  const point: LivingPoint = { x: 0, y: 0, R: 16, amp: 0, seed: 1.7, speed: 1 };
  let ampTarget = 0;
  layer.set('point', {
    colour: mint,
    update() {
      vx += (target - vx) * 0.08;
      const moving = Math.min(1, Math.abs(vx - lastVx) / 6);
      lastVx = vx;
      const { k, ox, oy } = map();
      point.x = ox + vx * k;
      point.y = oy + yAt(vx) * k;
      point.R += (16 + 10 * moving - point.R) * 0.12; // stretches as it travels: water, not a reticle
      point.amp += (ampTarget - point.amp) * 0.06;
    },
    bounds: () => pointBounds(point),
    field: (x, y, now) => breath(x, y, point, now),
  });

  hero.addEventListener('pointermove', (e) => {
    const s = svg.getBoundingClientRect();
    target = Math.max(0, Math.min(1240, ((e.clientX - s.left) / s.width) * 1280));
    layer.wake();
  });
  hero.addEventListener('pointerleave', () => {
    target = JUNCTION[0];
    layer.wake();
  });

  // on load: a comet draws along the wave and settles into the point
  const comet = (t: number) => {
    const head = ease(t) * total;
    const { k, ox, oy } = map();
    const trail: [number, number, number][] = [];
    for (let i = 0; i < 14; i++) {
      const at = head - i * 18;
      if (at < 0) break;
      const p = wave.getPointAtLength(at);
      trail.push([ox + p.x * k, oy + p.y * k, (1 - i / 14) * (1 - t * 0.4)]);
    }
    return trail;
  };
  let trail: [number, number, number][] = [];
  setTimeout(() => {
    void layer
      .play(
        1500,
        mint,
        (x, y) => {
          let v = 0;
          for (const [cx, cy, a] of trail) v = Math.max(v, a * Math.exp(-((Math.hypot(x - cx, y - cy) / 9) ** 2)));
          return v;
        },
        (t) => {
          trail = comet(t);
          if (!trail.length) return null;
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          for (const [x, y] of trail) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
          }
          return [x0 - 24, y0 - 24, x1 + 24, y1 + 24];
        },
      )
      .then(() => {
        ampTarget = 0.6;
        layer.wake();
      });
  }, 500);
}

// --- the drop zone answers the pointer and a dragged file -----------------------

function dropZone(): void {
  const zone = document.querySelector<HTMLElement>('#dropzone .drop-zone');
  if (!zone) return;
  const layer = new DitherLayer(zone, 3);
  const mint = token('--fs-mint');
  const title = zone.querySelector('strong');
  const original = title?.textContent ?? '';
  const p: LivingPoint = { x: 0, y: 0, R: 60, amp: 0, seed: 3.1, speed: 0.8 };
  let tx = 0;
  let ty = 0;
  let ampTarget = 0;
  let dragging = false;
  layer.set('cursor', {
    colour: mint,
    update() {
      p.x += (tx - p.x) * 0.14;
      p.y += (ty - p.y) * 0.14;
      p.R += ((dragging ? 150 : 60) - p.R) * 0.1;
      p.amp += (ampTarget - p.amp) * 0.08;
    },
    bounds: () => pointBounds(p),
    field: (x, y, now) => breath(x, y, p, now),
  });
  const follow = (e: PointerEvent | DragEvent) => {
    const r = zone.getBoundingClientRect();
    tx = e.clientX - r.left;
    ty = e.clientY - r.top;
    layer.wake();
  };
  zone.addEventListener('pointerenter', (e) => {
    const r = zone.getBoundingClientRect();
    p.x = tx = e.clientX - r.left;
    p.y = ty = e.clientY - r.top;
    ampTarget = 0.22;
    layer.wake();
  });
  zone.addEventListener('pointermove', follow);
  zone.addEventListener('pointerleave', () => {
    if (!dragging) ampTarget = 0;
    layer.wake();
  });

  // a file dragged anywhere over the page: the zone wells up and says so
  const setDragging = (on: boolean) => {
    if (dragging === on) return;
    dragging = on;
    ampTarget = on ? 0.5 : 0;
    if (!on) {
      const r = zone.getBoundingClientRect();
      tx = r.width / 2;
      ty = r.height / 2;
    }
    if (title) title.textContent = on ? 'Drop to open it' : original;
    layer.wake();
  };
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!document.body.classList.contains('landing') || !e.dataTransfer?.types.includes('Files')) return;
    depth++;
    const r = zone.getBoundingClientRect();
    if (!dragging) {
      p.x = tx = r.width / 2;
      p.y = ty = r.height / 2;
    }
    setDragging(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!dragging) return;
    const r = zone.getBoundingClientRect();
    // inside the zone the field follows the file; outside it waits in the middle
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) follow(e);
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) setDragging(false);
  });
  window.addEventListener('drop', () => {
    depth = 0;
    if (!dragging) return;
    const w = zone.clientWidth;
    const h = zone.clientHeight;
    const cx = p.x;
    const cy = p.y;
    const far = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    void layer.play(500, mint, (x, y, t) => {
      const d = Math.hypot(x - cx, y - cy);
      const r = ease(t) * far;
      return d > r ? 0 : Math.max(band(d, r, 30) * 0.9, 0.3 * (1 - t));
    });
    setDragging(false);
  });
}

// --- the vignette plays a takeoff as it scrolls in -------------------------------

function vignette(): void {
  const figure = document.querySelector<HTMLElement>('#seo .vignette .sheet');
  const svg = figure?.querySelector('svg');
  if (!figure || !svg) return;
  const fill = svg.querySelector<SVGElement>('#vgFill');
  const area = svg.querySelector<SVGElement>('#vgArea');
  const length = svg.querySelector<SVGElement>('#vgLength');
  const hits = [...svg.querySelectorAll<SVGGElement>('.vg-hit')];
  const check = svg.querySelector<SVGElement>('#vgCheck');
  const titleBlock = svg.querySelector<SVGElement>('#vgTitle');
  const rows = [...document.querySelectorAll<HTMLElement>('#seo .vignette .qty-row')];
  if (!fill || !length || !hits.length || !check || !titleBlock) return;

  const show = (el: Element, on: boolean) => {
    const s = (el as SVGElement | HTMLElement).style;
    s.transition = 'opacity .35s ease';
    s.opacity = on ? '' : el instanceof HTMLElement ? '.28' : '0';
  };
  // only hide what the sequence will reveal once it can actually run
  const hideAll = () => {
    for (const el of [fill, length, check, ...hits, ...(area ? [area] : [])]) show(el, false);
    for (const r of rows) show(r, false);
  };

  const layer = new DitherLayer(figure, 3);
  const map = viewBoxMapper(svg, figure);
  const at = (vx: number, vy: number) => {
    const { k, ox, oy } = map();
    return [ox + vx * k, oy + vy * k, k] as const;
  };
  const ink = 'rgb(16 36 58)';
  const teal = token('--fs-ribbon-700');
  const amber = token('--fs-human');

  // hover: the cursor field, focusing tightly on a count marker under it
  const cursor: LivingPoint = { x: 0, y: 0, R: 44, amp: 0, seed: 1.1, speed: 1 };
  let ctx = 0;
  let cty = 0;
  let cR = 44;
  let cAmp = 0;
  layer.set('cursor', {
    colour: teal,
    update() {
      cursor.x += (ctx - cursor.x) * 0.14;
      cursor.y += (cty - cursor.y) * 0.14;
      cursor.R += (cR - cursor.R) * 0.12;
      cursor.amp += (cAmp - cursor.amp) * 0.08;
    },
    bounds: () => pointBounds(cursor),
    field: (x, y, now) => breath(x, y, cursor, now),
  });
  svg.addEventListener('pointermove', (e) => {
    const r = figure.getBoundingClientRect();
    const { k, ox, oy } = map();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const near = hits.find((g) => Math.hypot(Number(g.dataset.x) * k + ox - px, Number(g.dataset.y) * k + oy - py) < 20 * k);
    if (near) {
      ctx = Number(near.dataset.x) * k + ox;
      cty = Number(near.dataset.y) * k + oy;
      cR = 20 * k;
    } else {
      ctx = px;
      cty = py;
      cR = 44 * k;
    }
    cAmp = 0.3;
    layer.wake();
  });
  svg.addEventListener('pointerleave', () => {
    cAmp = 0;
    layer.wake();
  });

  const run = async () => {
    hideAll();
    const H = () => figure.clientHeight;
    // 1. the sheet develops out of noise
    await layer.play(800, ink, (_x, y, t) => 1.05 - ease(t) * 1.15 + (y / Math.max(1, H())) * 0.18 * (1 - t));
    // 2. the engine reads the title block: a quick, tight breath where it reads
    const [tbx, tby, k] = at(648, 362);
    const think: LivingPoint = { x: tbx, y: tby, R: 46 * k, amp: 0.55, seed: 2.3, speed: 2.4 };
    layer.set('think', { colour: teal, bounds: () => pointBounds(think), field: (x, y, now) => breath(x, y, think, now) });
    await new Promise((r) => setTimeout(r, 900));
    layer.delete('think');
    titleBlock.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 260 });
    // 3. the wall is measured: a comet along the dimension line
    const [lx0, ly] = at(80, 50);
    const [lx1] = at(600, 50);
    await layer.play(
      700,
      teal,
      (x, y, t) => {
        const head = lx0 + (lx1 - lx0) * ease(t);
        if (x > head + 12) return 0;
        return band(y, ly, 5 * k) * Math.max(band(x, head, 14 * k), x <= head ? 0.55 * (1 - t * 0.6) : 0);
      },
      () => [lx0 - 20, ly - 20, lx1 + 20, ly + 20] as Box,
    );
    show(length, true);
    if (rows[0]) show(rows[0], true);
    // 4. the office fills with its area
    const [rx0, ry0] = at(84, 96);
    const [rx1, ry1] = at(312, 312);
    const [fx, fy] = at(198, 204);
    const far = Math.hypot(rx1 - rx0, ry1 - ry0);
    await layer.play(
      850,
      teal,
      (x, y, t) => {
        if (x < rx0 || x > rx1 || y < ry0 || y > ry1) return 0;
        const d = Math.hypot(x - fx, y - fy);
        const r = ease(t) * far;
        return d > r ? 0 : Math.max(band(d, r, 30 * k) * 0.9, 0.22 * (1 - t));
      },
      () => [rx0, ry0, rx1, ry1] as Box,
    );
    show(fill, true);
    if (area) show(area, true);
    if (rows[1]) show(rows[1], true);
    // 5. one click on a downlight: a scan wave reveals every match as it passes
    const [sx, sy] = at(198, 140);
    const centres = hits.map((g) => at(Number(g.dataset.x), Number(g.dataset.y)));
    const reach = Math.max(...centres.map(([x, y]) => Math.hypot(x - sx, y - sy))) + 60 * k;
    const shown = new Set<number>();
    await layer.play(
      1000,
      teal,
      (x, y, t) => {
        const d = Math.hypot(x - sx, y - sy);
        const r = ease(t) * reach;
        return Math.max(band(d, r, 46 * k) * 0.85, d < r ? 0.12 * (1 - t) : 0) * (1 - t * 0.35);
      },
      (t) => {
        // once per frame: reveal each marker as the wavefront passes it
        const r = ease(t) * reach;
        centres.forEach(([cx, cy], i) => {
          if (!shown.has(i) && Math.hypot(cx - sx, cy - sy) <= r) {
            shown.add(i);
            show(hits[i], true);
          }
        });
        return [0, 0, figure.clientWidth, figure.clientHeight];
      },
    );
    hits.forEach((g) => show(g, true));
    show(check, true);
    if (rows[2]) show(rows[2], true);
    // the match that needs a person keeps breathing, in amber
    const flagged = hits.find((g) => g.classList.contains('vg-flag'));
    if (flagged) {
      const p: LivingPoint = { x: 0, y: 0, R: 20, amp: 0.6, seed: 4.1, speed: 0.8 };
      layer.set('check', {
        colour: amber,
        update() {
          const [x, y, kk] = at(Number(flagged.dataset.x), Number(flagged.dataset.y));
          p.x = x;
          p.y = y;
          p.R = 22 * kk;
        },
        bounds: () => pointBounds(p),
        field: (x, y, now) => breath(x, y, p, now),
      });
    }
  };

  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      void run();
    },
    { threshold: 0.45 },
  );
  io.observe(figure);
}

// --- How it works: the steps light in turn ----------------------------------------

function steps(): void {
  const list = document.querySelector<HTMLElement>('#how .steps');
  const items = [...(list?.querySelectorAll<HTMLElement>('.step') ?? [])];
  if (!list || !items.length) return;
  const layer = new DitherLayer(list, 3);
  const teal = token('--fs-ribbon-700');
  const node = (el: HTMLElement): [number, number] => {
    const l = list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return [r.left - l.left + 8, r.top - l.top + 8]; // the 1rem dot at each step's top left
  };
  const run = async () => {
    for (const [i, el] of items.entries()) {
      const [cx, cy] = node(el);
      void layer.play(
        700,
        teal,
        (x, y, t) => {
          const d = Math.hypot(x - cx, y - cy);
          return band(d, ease(t) * 34, 7) * (1 - t) * 0.95 + (d < 9 ? 0.5 * (1 - t) : 0);
        },
        // up and along the line only: the step's number sits just below the dot
        () => [cx - 48, cy - 40, cx + 48, cy + 14] as Box,
      );
      setTimeout(() => el.classList.add('lit'), 180);
      if (i < items.length - 1) await new Promise((r) => setTimeout(r, 380));
    }
    // the last step keeps a quiet breath: the takeoff is ready to go
    const last = items[items.length - 1];
    const p: LivingPoint = { x: 0, y: 0, R: 18, amp: 0.45, seed: 5.3, speed: 0.7 };
    layer.set('rest', {
      colour: teal,
      update() {
        [p.x, p.y] = node(last);
      },
      bounds: () => pointBounds(p),
      field: (x, y, now) => breath(x, y, p, now),
    });
  };
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      void run();
    },
    { threshold: 0.6 },
  );
  io.observe(list);
}

// --- the close: a Flowtivity wave drifting along the bottom -------------------------

function closingWave(): void {
  const section = document.querySelector<HTMLElement>('#seo .closing');
  if (!section) return;
  const layer = new DitherLayer(section, 4, undefined, 30);
  cursorPoint(section, layer, MINT, 0.24, 64);
  const mint = token('--fs-mint');
  layer.set('wave', {
    colour: mint,
    bounds: () => {
      const h = section.clientHeight;
      return [0, h - 120, section.clientWidth, h];
    },
    field(x, y, now) {
      const h = section.clientHeight;
      const t = now * 0.00025;
      const mid = h - 58 + 16 * Math.sin(x / 210 + t * 2.1) + 9 * Math.sin(x / 97 - t * 3.3);
      const thick = 16 + 10 * Math.sin(x / 330 + t * 1.3);
      return 0.55 * band(y, mid, thick) * (0.65 + 0.35 * Math.sin(x / 140 - t * 4));
    },
  });
}
