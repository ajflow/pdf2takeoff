// Draws markups and tool previews into the SVG overlay. Geometry is stored in
// PDF space; converted to the viewBox (viewport@1) here. Sizes are paper-space
// points, so markups look like printed PDF annotations at any zoom.

import { state, type Markup, type Pt, calibrationFor, defaultLabel } from './state';
import { markupsLayer, previewLayer, pdfToView } from './viewer';
import { formatMarkupValue } from '../engine/export';
import { formatLength, formatArea } from '../engine/units';
import { markupAngle } from '../engine/geometry';
import { isVisibleLayer } from './layers';

const NS = 'http://www.w3.org/2000/svg';

export const COLORS: Record<string, string> = {
  length: '#e11d48',
  area: '#7c3aed',
  count: '#0284c7',
  perimeter: '#0d9488',
  volume: '#4f46e5',
  angle: '#db2777',
  note: '#d97706',
  calibrate: '#d97706',
};

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function labelText(m: Markup): string {
  const value = formatMarkupValue(m, calibrationFor(m.page), state.displayUnit) || '-';
  return m.label === defaultLabel(m.type) ? value : `${m.label}: ${value}`;
}

function addLabel(g: SVGGElement, text: string, at: Pt): void {
  const t = el('text', {
    x: at.x,
    y: at.y - 8,
    'text-anchor': 'middle',
    'font-size': 8,
    'paint-order': 'stroke',
    stroke: '#ffffff',
    'stroke-width': 2.6,
    'stroke-linejoin': 'round',
    fill: '#111827',
    'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    'font-weight': '600',
  });
  t.textContent = text;
  g.appendChild(t);
}

function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** Count numbers run per label per page in creation order, like Bluebeam. */
export function countNumberFor(m: Markup): number {
  const same = state.markups
    .filter((o) => o.type === 'count' && o.label === m.label && o.page === m.page)
    .sort((a, b) => a.createdAt - b.createdAt);
  return same.findIndex((o) => o.id === m.id) + 1;
}

export function renderMarkups(): void {
  markupsLayer.replaceChildren();
  const page = state.pageNum;
  for (const m of state.markups.filter((x) => x.page === page && isVisibleLayer(x))) {
    markupsLayer.appendChild(renderMarkup(m));
  }
}

/** Vertex dots; selected markups get a fat invisible hit-target per vertex for dragging. */
function addVertices(g: SVGGElement, pts: { x: number; y: number }[], color: string, selected: boolean): void {
  pts.forEach((p, i) => {
    if (selected) {
      const h = el('g', { class: 'vtx', 'data-idx': i });
      h.appendChild(el('circle', { cx: p.x, cy: p.y, r: 6.5, fill: 'transparent', 'pointer-events': 'all' }));
      h.appendChild(
        el('circle', { cx: p.x, cy: p.y, r: 2.6, fill: color, stroke: '#ffffff', 'stroke-width': 0.9 }),
      );
      g.appendChild(h);
    } else {
      g.appendChild(el('circle', { cx: p.x, cy: p.y, r: 1.8, fill: color }));
    }
  });
}

function renderMarkup(m: Markup): SVGGElement {
  const color = COLORS[m.type] ?? '#333';
  const selected = m.id === state.selectedId;
  const g = el('g', {
    class: `markup m-${m.type}${selected ? ' selected' : ''}`,
    'data-id': m.id,
  });
  const title = el('title');
  title.textContent = labelText(m);
  g.appendChild(title);
  const pts = m.points.map(pdfToView);

  if (m.type === 'length') {
    g.appendChild(
      el('polyline', {
        points: pts.map((p) => `${p.x},${p.y}`).join(' '),
        fill: 'none',
        stroke: color,
        'stroke-width': selected ? 2.4 : 1.6,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
    addVertices(g, pts, color, selected);
    const mid = pts[Math.max(0, pts.length - 2)] ?? pts[0];
    const end = pts[pts.length - 1] ?? mid;
    addLabel(g, labelText(m), { x: (mid.x + end.x) / 2, y: (mid.y + end.y) / 2 });
  } else if (m.type === 'area' || m.type === 'volume') {
    g.appendChild(
      el('polygon', {
        points: pts.map((p) => `${p.x},${p.y}`).join(' '),
        fill: color,
        'fill-opacity': selected ? 0.22 : 0.13,
        stroke: color,
        'stroke-width': selected ? 2.4 : 1.6,
        'stroke-linejoin': 'round',
        ...(m.type === 'volume' ? { 'stroke-dasharray': '6 2' } : {}),
      }),
    );
    addVertices(g, pts, color, selected);
    addLabel(g, labelText(m), centroid(pts));
  } else if (m.type === 'perimeter') {
    g.appendChild(
      el('polygon', {
        points: pts.map((p) => `${p.x},${p.y}`).join(' '),
        fill: 'none',
        stroke: color,
        'stroke-width': selected ? 2.4 : 1.6,
        'stroke-linejoin': 'round',
      }),
    );
    addVertices(g, pts, color, selected);
    addLabel(g, labelText(m), centroid(pts));
  } else if (m.type === 'angle') {
    const [v, a, b] = pts;
    for (const ray of [a, b]) {
      if (!ray) continue;
      g.appendChild(
        el('line', { x1: v.x, y1: v.y, x2: ray.x, y2: ray.y, stroke: color, 'stroke-width': selected ? 2.4 : 1.6 }),
      );
    }
    addVertices(g, pts, color, selected);
    addLabel(g, labelText(m), { x: v.x, y: v.y - 8 });
  } else if (m.type === 'note') {
    const p = pts[0];
    const g2 = el('g', {});
    const text = m.label.length > 60 ? m.label.slice(0, 57) + '…' : m.label;
    g2.appendChild(el('circle', { cx: p.x, cy: p.y, r: selected ? 8 : 7, fill: color, 'fill-opacity': 0.92 }));
    const num = el('text', { x: p.x, y: p.y + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 8, 'font-weight': '700', fill: '#ffffff' });
    num.textContent = '✎';
    g2.appendChild(num);
    const label = el('text', {
      x: p.x + 11, y: p.y + 3, 'font-size': 8, fill: '#111827',
      'paint-order': 'stroke', stroke: '#ffffff', 'stroke-width': 2.4, 'stroke-linejoin': 'round',
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    });
    label.textContent = text;
    g2.appendChild(label);
    g.appendChild(g2);
  } else {
    // count marker
    const p = pts[0];
    const num = countNumberFor(m);
    g.appendChild(el('circle', { cx: p.x, cy: p.y, r: selected ? 8.5 : 7, fill: color, 'fill-opacity': 0.92 }));
    const t = el('text', {
      x: p.x,
      y: p.y + 0.5,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': 8,
      'font-weight': '700',
      fill: '#ffffff',
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    });
    t.textContent = String(num);
    g.appendChild(t);
  }
  return g;
}

// --- in-progress preview ---

export interface PreviewSpec {
  kind: 'length' | 'area' | 'perimeter' | 'volume' | 'angle' | 'calibrate';
  points: Pt[]; // PDF space
  cursor: Pt | null;
}

export function renderPreview(spec: PreviewSpec | null): void {
  previewLayer.replaceChildren();
  if (!spec || spec.points.length === 0) return;
  const color = spec.kind === 'calibrate' ? COLORS.calibrate : COLORS[spec.kind];
  const g = el('g', { class: 'preview' });
  const pts = spec.points.map(pdfToView);
  const cur = spec.cursor ? pdfToView(spec.cursor) : null;
  const chain = cur ? [...pts, cur] : pts;

  if (spec.kind === 'area' || spec.kind === 'volume' || spec.kind === 'perimeter') {
    g.appendChild(
      el('polygon', {
        points: chain.map((p) => `${p.x},${p.y}`).join(' '),
        fill: spec.kind === 'perimeter' ? 'none' : color,
        'fill-opacity': 0.1,
        stroke: color,
        'stroke-width': 1.4,
        'stroke-dasharray': '4 2',
      }),
    );
  } else {
    g.appendChild(
      el('polyline', {
        points: chain.map((p) => `${p.x},${p.y}`).join(' '),
        fill: 'none',
        stroke: color,
        'stroke-width': 1.4,
        'stroke-dasharray': '4 2',
      }),
    );
  }
  for (const p of pts) {
    g.appendChild(el('circle', { cx: p.x, cy: p.y, r: 2.2, fill: color }));
  }

  // live measurement readout follows the cursor
  if (cur) {
    const cal = calibrationFor(state.pageNum);
    let text = '';
    if (spec.kind === 'calibrate') {
      // no factor yet — show raw paper distance so the user can sanity-check
      let totalPt = 0;
      for (let i = 1; i < chain.length; i++) totalPt += Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
      text = `${(totalPt * (25.4 / 72)).toFixed(1)} mm on paper`;
    } else if (spec.kind === 'angle') {
      // scale-free: live degrees as soon as vertex + one ray exist
      if (spec.points.length >= 2) {
        const poly = spec.points.length >= 3 ? spec.points : [spec.points[0], spec.points[1], spec.cursor!];
        text = `${markupAngle({ points: poly } as Markup).toFixed(1)}°`;
      }
    } else if (cal) {
      const toM = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y) * cal.metersPerPt;
      if (spec.kind === 'area' || spec.kind === 'volume') {
        const poly = [...spec.points, spec.cursor!];
        let sum = 0;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % poly.length];
          sum += a.x * b.y - b.x * a.y;
        }
        text = `${formatArea(Math.abs(sum / 2) * cal.metersPerPt ** 2, state.displayUnit)}${spec.kind === 'volume' ? ' × d' : ''}`;
      } else if (spec.kind === 'perimeter') {
        const poly = [...spec.points, spec.cursor!];
        let total = 0;
        for (let i = 0; i < poly.length; i++) total += toM(poly[i], poly[(i + 1) % poly.length]);
        text = formatLength(total, state.displayUnit);
      } else {
        let total = 0;
        for (let i = 1; i < chain.length; i++) total += toM(chain[i - 1], chain[i]);
        text = formatLength(total, state.displayUnit);
      }
    }
    addLabel(g, text, cur);
  }
  previewLayer.appendChild(g);
}
