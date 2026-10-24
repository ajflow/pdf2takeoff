// The homepage's moments of wonder, drawn with the shared dither layer:
// the living point on the hero's Flow Line, the drop zone that answers a
// dragged file, the floor-plan vignette playing a takeoff as it scrolls in,
// the How it works steps lighting in turn, and a drifting wave at the close.
// Purely decorative (canvases are aria-hidden, every word stays in the HTML);
// loaded after the page is idle; nothing runs under prefers-reduced-motion.

import { DitherLayer, breath, pointBounds, ease, band, token, reducedMotion, type LivingPoint, type Box } from './dither';

let started = false;

export function initHome(): void {
  if (started || reducedMotion()) return;
  started = true;
  flowLine();
  dropZone();
  vignette();
  steps();
  closingWave();
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
  const layer = new DitherLayer(section, 4);
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
