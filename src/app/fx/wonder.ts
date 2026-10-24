// The app's wonder layer, drawn with the shared dither. On the sheet
// (#fxCanvas, between the drawing and the markups): the living point follows
// the pointer, focusing on a count marker under it; a drawing develops as it
// opens; a scan's wave reveals its hits as it passes them; a new area floods
// in from its middle; hits that need a person keep breathing in amber. Around
// the sheet, short chrome moments mark state changes: the rail's tool flows
// to the next, the scan card materialises, a kept row sweeps, the scale chip
// shimmers, an export prints. It watches state rather than being called, so
// the tools stay unaware of it. Quiet by default; under
// prefers-reduced-motion nothing is created.

import { state, subscribe, type Markup, type Pt } from '../state';
import { scanStyle, renderMarkups } from '../render';
import { pdfToView, viewSize } from '../viewer';
import { DitherLayer, chromeMoment, breath, pointBounds, ease, band, token, reducedMotion, type LivingPoint, type Box } from './dither';

// the sheet is white in both themes, so its colours are fixed
const INK = '#10243a';
const HALO = '#2fbfb4';
const AMBER = '#b8651f';
const LIVING_TOOLS = new Set(['pan', 'scan', 'count', 'fill']);
const MAX_BREATHING = 40;

export function initWonder(): void {
  if (reducedMotion()) return;
  const wrap = document.getElementById('pageWrap')!;
  const layer = new DitherLayer(wrap, 3, document.getElementById('fxCanvas') as HTMLCanvasElement);
  const zoom = () => wrap.clientWidth / (viewSize().w || 1);
  const at = (p: Pt): [number, number] => {
    const v = pdfToView(p);
    const k = zoom();
    return [v.x * k, v.y * k];
  };
  const onPage = (m: Markup) => m.page === state.pageNum;

  // --- the living point under the pointer ------------------------------------
  const cursor: LivingPoint = { x: 0, y: 0, R: 46, amp: 0, seed: 1.7, speed: 1 };
  let tx = 0;
  let ty = 0;
  let tR = 46;
  let tAmp = 0;
  layer.set('cursor', {
    colour: HALO,
    update() {
      // water, not a reticle: it eases after the pointer and changes size
      cursor.x += (tx - cursor.x) * 0.14;
      cursor.y += (ty - cursor.y) * 0.14;
      cursor.R += (tR - cursor.R) * 0.12;
      cursor.amp += (tAmp - cursor.amp) * 0.08;
    },
    bounds: () => pointBounds(cursor),
    field: (x, y, now) => breath(x, y, cursor, now),
  });
  wrap.addEventListener('pointermove', (e) => {
    const alive = LIVING_TOOLS.has(state.tool) && !document.body.classList.contains('demo');
    if (!alive) {
      tAmp = 0;
      layer.wake();
      return;
    }
    const r = wrap.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let near: [number, number] | null = null;
    let best = 18;
    for (const m of state.markups) {
      if (m.type !== 'count' || !onPage(m)) continue;
      const [x, y] = at(m.points[0]);
      const d = Math.hypot(x - px, y - py);
      if (d < best) {
        best = d;
        near = [x, y];
      }
    }
    if (near) [tx, ty, tR] = [near[0], near[1], 20];
    else [tx, ty, tR] = [px, py, 46];
    tAmp = state.tool === 'pan' ? 0.22 : 0.32;
    layer.wake();
  });
  wrap.addEventListener('pointerleave', () => {
    tAmp = 0;
    layer.wake();
  });

  // --- moments on the sheet ----------------------------------------------------
  const develop = () =>
    layer.play(850, INK, (_x, y, t) => 1.05 - ease(t) * 1.15 + (y / Math.max(1, wrap.clientHeight)) * 0.18 * (1 - t));

  const reveal = (id: string) => {
    if (!scanStyle.hidden.delete(id)) return;
    wrap.querySelector(`#markupsLayer [data-id="${CSS.escape(id)}"]`)?.classList.remove('fx-pending');
  };

  /** A scan's wave from the clicked hit, revealing each hit as it passes. */
  const scanWave = (example: Markup, hits: Markup[]) => {
    const [sx, sy] = at(example.points[0]);
    const centres = hits.map((m) => [m.id, ...at(m.points[0])] as [string, number, number]);
    const reach = Math.max(60, ...centres.map(([, x, y]) => Math.hypot(x - sx, y - sy))) + 50;
    void layer
      .play(
        1000,
        HALO,
        (x, y, t) => {
          const d = Math.hypot(x - sx, y - sy);
          const r = ease(t) * reach;
          return Math.max(band(d, r, 40) * 0.85, d < r ? 0.12 * (1 - t) : 0) * (1 - t * 0.35);
        },
        (t) => {
          const r = ease(t) * reach;
          for (const [id, x, y] of centres) if (Math.hypot(x - sx, y - sy) <= r) reveal(id);
          return [0, 0, wrap.clientWidth, wrap.clientHeight];
        },
      )
      .then(() => hits.forEach((m) => reveal(m.id)));
  };

  /** A new area floods in from its middle, inside its outline, then shows. */
  const flood = (m: Markup) => {
    const pts = m.points.map(at);
    if (pts.length < 3) return reveal(m.id);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    // inside test once per cell, against a mask drawn at the layer's cell size
    const cell = 3;
    const mw = Math.max(1, Math.ceil((x1 - x0) / cell));
    const mh = Math.max(1, Math.ceil((y1 - y0) / cell));
    const mc = document.createElement('canvas');
    mc.width = mw;
    mc.height = mh;
    const g = mc.getContext('2d')!;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo((x - x0) / cell, (y - y0) / cell) : g.moveTo((x - x0) / cell, (y - y0) / cell)));
    g.closePath();
    g.fill();
    const mask = g.getImageData(0, 0, mw, mh).data;
    const inside = (x: number, y: number) => {
      const i = Math.floor((x - x0) / cell);
      const j = Math.floor((y - y0) / cell);
      return i >= 0 && j >= 0 && i < mw && j < mh && mask[(j * mw + i) * 4 + 3] > 127;
    };
    const far = Math.hypot(x1 - x0, y1 - y0);
    void layer
      .play(
        850,
        '#7c3aed', // the area colour, on the white sheet
        (x, y, t) => {
          if (!inside(x, y)) return 0;
          const d = Math.hypot(x - cx, y - cy);
          const r = ease(t) * far;
          return d > r ? 0 : Math.max(band(d, r, 26) * 0.9, 0.22 * (1 - t));
        },
        () => [x0, y0, x1, y1] as Box,
      )
      .then(() => reveal(m.id));
  };

  // --- hits that need a person keep breathing ------------------------------------
  const breathing = new Map<string, LivingPoint>();
  const syncBreathing = () => {
    const flagged = state.markups
      .filter((m) => m.type === 'count' && onPage(m) && m.status === 'check' && !scanStyle.quiet.has(m.id) && !scanStyle.hidden.has(m.id))
      .slice(0, MAX_BREATHING);
    const keep = new Set(flagged.map((m) => m.id));
    for (const id of breathing.keys()) {
      if (!keep.has(id)) {
        breathing.delete(id);
        layer.delete(`flag:${id}`);
      }
    }
    for (const m of flagged) {
      if (breathing.has(m.id)) continue;
      const p: LivingPoint = { x: 0, y: 0, R: 16, amp: 0.55, seed: (breathing.size * 1.37) % 6, speed: 0.8 };
      breathing.set(m.id, p);
      layer.set(`flag:${m.id}`, {
        colour: AMBER,
        update() {
          const live = state.markups.find((x) => x.id === m.id);
          if (live) [p.x, p.y] = at(live.points[0]);
        },
        bounds: () => pointBounds(p),
        field: (x, y, now) => breath(x, y, p, now),
      });
    }
  };

  // --- chrome moments --------------------------------------------------------------
  const rail = document.querySelector<HTMLElement>('.rail')!;
  const railFlow = (from: HTMLElement, to: HTMLElement) => {
    const r = rail.getBoundingClientRect();
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const p0 = [a.left + a.width / 2 - r.left, a.top + a.height / 2 - r.top];
    const p1 = [b.left + b.width / 2 - r.left, b.top + b.height / 2 - r.top];
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (len < 4) return;
    const u = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
    void chromeMoment(rail, 360, token('--action'), (x, y, _w, _h, t) => {
      const e = ease(t);
      const dx = x - (p0[0] + (p1[0] - p0[0]) * e);
      const dy = y - (p0[1] + (p1[1] - p0[1]) * e);
      const along = dx * u[0] + dy * u[1];
      const across = dx * u[1] - dy * u[0];
      return Math.exp(-((along / (14 + 22 * Math.sin(Math.PI * t))) ** 2)) * Math.exp(-((across / 11) ** 2)) * 1.1;
    });
  };

  const card = document.getElementById('scanCard')!;
  new MutationObserver(() => {
    if (card.classList.contains('hidden') || card.dataset.fx) return;
    card.dataset.fx = '1';
    void chromeMoment(card, 380, token('--halo'), (x, _y, w, _h, t) => 1.1 - ease(t) * 1.25 + (1 - x / w) * 0.25 * (1 - t), 3).then(() => delete card.dataset.fx);
  }).observe(card, { attributes: true, attributeFilter: ['class'] });

  const sweep = (el: HTMLElement | null, colour: string, ms = 520) => {
    if (el) void chromeMoment(el, ms, colour, (x, _y, w, _h, t) => band(x / w, ease(t) * 1.3 - 0.15, 0.12) * 0.9);
  };
  const printHead = () => {
    const btn = document.getElementById('exportMenuBtn');
    if (btn) void chromeMoment(btn, 650, token('--on-action'), (x, _y, w, _h, t) => band(x / w, ease(t) * 1.4 - 0.2, 0.1) * 0.75);
  };
  for (const id of ['exportXlsxBtn', 'exportCsvBtn', 'copyTsvBtn', 'reportBtn', 'savePdfBtn']) document.getElementById(id)?.addEventListener('click', printHead);

  // --- watching state ------------------------------------------------------------------
  let lastFile = state.fileName;
  let lastTool = state.tool;
  let lastScale = '';
  let known = new Set(state.markups.map((m) => m.id));
  let statuses = new Map(state.markups.map((m) => [m.id, m.status]));

  subscribe(() => {
    if (document.body.classList.contains('landing')) return;
    const fileChanged = state.fileName !== lastFile;
    if (fileChanged) {
      lastFile = state.fileName;
      if (state.fileName) void develop();
    }

    const fresh = state.markups.filter((m) => !known.has(m.id));
    if (!fileChanged && fresh.length) {
      const example = fresh.find((m) => m.id === scanStyle.example);
      const hidden: Markup[] = [];
      if (example) {
        const hits = fresh.filter((m) => m.type === 'count' && onPage(m));
        hits.forEach((m) => scanStyle.hidden.add(m.id));
        hidden.push(...hits);
        scanWave(example, hits);
      } else if (fresh.length <= 3) {
        for (const m of fresh) {
          if ((m.type === 'area' || m.type === 'volume') && onPage(m)) {
            scanStyle.hidden.add(m.id);
            hidden.push(m);
            flood(m);
          }
        }
      }
      if (hidden.length) renderMarkups(); // same task as the emit: nothing paints in between
    }
    known = new Set(state.markups.map((m) => m.id));

    // a group just kept: sweep its quantity row
    const kept = state.markups.filter((m) => m.status === 'confirmed' && statuses.get(m.id) === 'check');
    if (kept.length >= 2) {
      const key = `${kept[0].type}|${kept[0].label}`;
      requestAnimationFrame(() => sweep(document.querySelector<HTMLElement>(`.qrow[data-key="${CSS.escape(key)}"]`), token('--action')));
    }
    statuses = new Map(state.markups.map((m) => [m.id, m.status]));

    if (state.tool !== lastTool) {
      const from = rail.querySelector<HTMLElement>(`[data-tool="${lastTool}"]`);
      const to = rail.querySelector<HTMLElement>(`[data-tool="${state.tool}"]`);
      lastTool = state.tool;
      if (from && to && getComputedStyle(rail).display !== 'none') railFlow(from, to);
    }

    const cal = state.calibrations.get(state.pageNum);
    const scaleKey = cal ? `${state.pageNum}|${cal.metersPerPt}|${cal.source}` : `${state.pageNum}|`;
    if (scaleKey !== lastScale) {
      const samePage = lastScale.split('|')[0] === String(state.pageNum);
      lastScale = scaleKey;
      if (cal && samePage && !fileChanged) sweep(document.getElementById('scaleBadge'), token('--action'), 600);
    }

    syncBreathing();
  });
}
