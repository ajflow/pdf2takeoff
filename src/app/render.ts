// Draws markups and tool previews into the SVG overlay. Geometry is stored in
// PDF space; converted to the viewBox (viewport@1) here. Sizes are paper-space
// points, so markups look like printed PDF annotations at any zoom.

import { state, type Markup, type Pt, calibrationForMarkup, defaultLabel, ratioOn } from './state';
import { markupsLayer, previewLayer, pdfToView } from './viewer';
import { formatMarkupValue } from '../engine/export';
import { formatLength, formatArea } from '../engine/units';
import { markupAngle } from '../engine/geometry';
import { isVisibleLayer, layerColor } from './layers';
import { ratioForMetersPerPt } from '../engine/units';

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
  // The SVG viewBox is scaled with the page zoom. Keep visible annotation
  // strokes in screen pixels so measurement lines do not become oversized
  // when zooming in or disappear when zooming out. Geometry remains in PDF
  // coordinates; this affects presentation only.
  if ('stroke-width' in attrs && attrs.stroke !== 'transparent') {
    node.setAttribute('vector-effect', 'non-scaling-stroke');
  }
  return node;
}

function labelText(m: Markup): string {
  const value = formatMarkupValue(m, calibrationForMarkup(m), state.displayUnit) || '-';
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
/**
 * Scan-review styling, driven by the review card: hits of the open scan that
 * aren't doubtful (drawn plainly although they are still 'check'), the hit
 * that was clicked (a halo) and the hit under review (a ring).
 */
export const scanStyle = { quiet: new Set<string>(), example: null as string | null, reviewing: null as string | null, hidden: new Set<string>() };
const HUMAN = '#9a5218'; // a person decides
const HALO = '#4fd0c6';

export function countNumberFor(m: Markup): number {
  const same = state.markups
    .filter((o) => o.type === 'count' && o.label === m.label && o.page === m.page)
    .sort((a, b) => a.createdAt - b.createdAt);
  return same.findIndex((o) => o.id === m.id) + 1;
}

export function renderMarkups(): void {
  const annotationLayer = document.getElementById('annotationLayer') as SVGGElement | null;
  if (annotationLayer) {
    annotationLayer.replaceChildren();
    for (const annotation of state.annotations.filter((item) => item.page === state.pageNum)) {
      annotationLayer.appendChild(renderDrawingAnnotation(annotation));
    }
  }
  markupsLayer.replaceChildren();
  // a selected quantity row keeps its markups bright and fades the rest
  markupsLayer.classList.toggle('focusing', state.focusLabel !== null);
  const page = state.pageNum;
  for (const v of state.viewports.filter((x) => x.page === page)) {
    markupsLayer.appendChild(renderViewport(v));
  }
  for (const m of state.markups.filter((x) => x.page === page && x.visible !== false && isVisibleLayer(x))) {
    markupsLayer.appendChild(renderMarkup(m));
  }
}

function renderDrawingAnnotation(annotation: import('../engine/types').DrawingAnnotation): SVGGElement {
  const pts = annotation.points.map(pdfToView);
  const color = annotation.color || '#e11d48';
  const width = Math.max(0.5, Math.min(16, annotation.strokeWidth ?? 2));
  const opacity = Math.max(0, Math.min(1, annotation.opacity ?? 0.9));
  const fillOpacity = Math.max(0, Math.min(1, annotation.fillOpacity ?? 0.16));
  const dash = annotation.lineStyle === 'dashed' ? '7 4' : annotation.lineStyle === 'dotted' ? '1 4' : undefined;
  const g = el('g', { class: `drawing-annotation annotation-${annotation.kind}${state.selectedAnnotationId === annotation.id ? ' selected' : ''}`, 'data-annotation-id': annotation.id, opacity });
  const a = pts[0] ?? { x: 0, y: 0 };
  const b = pts[1] ?? a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.max(1, Math.abs(b.x - a.x)), h = Math.max(1, Math.abs(b.y - a.y));
  const stroke = { stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...(dash ? { 'stroke-dasharray': dash } : {}) };
  if (annotation.kind === 'line' || annotation.kind === 'arrow') {
    g.appendChild(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, fill: 'none', ...stroke }));
    if (annotation.kind === 'arrow') {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const size = Math.max(7, width * 4);
      const p1 = { x: b.x - size * Math.cos(angle - Math.PI / 6), y: b.y - size * Math.sin(angle - Math.PI / 6) };
      const p2 = { x: b.x - size * Math.cos(angle + Math.PI / 6), y: b.y - size * Math.sin(angle + Math.PI / 6) };
      g.appendChild(el('polygon', { points: `${b.x},${b.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`, fill: color }));
    }
  } else if (annotation.kind === 'rectangle' || annotation.kind === 'highlight' || annotation.kind === 'cloud') {
    if (annotation.kind === 'cloud') {
      const r = Math.min(12, Math.max(5, Math.min(w, h) / 8));
      let d = `M ${x + r} ${y}`;
      for (let px = x + r; px < x + w - r; px += r * 2) d += ` Q ${px + r} ${y - r * .55} ${Math.min(x + w - r, px + r * 2)} ${y}`;
      d += ` L ${x + w} ${y + r}`;
      for (let py = y + r; py < y + h - r; py += r * 2) d += ` Q ${x + w + r * .55} ${py + r} ${x + w} ${Math.min(y + h - r, py + r * 2)}`;
      d += ` L ${x + w - r} ${y + h}`;
      for (let px = x + w - r; px > x + r; px -= r * 2) d += ` Q ${px - r} ${y + h + r * .55} ${Math.max(x + r, px - r * 2)} ${y + h}`;
      d += ` L ${x} ${y + h - r}`;
      for (let py = y + h - r; py > y + r; py -= r * 2) d += ` Q ${x - r * .55} ${py - r} ${x} ${Math.max(y + r, py - r * 2)}`;
      d += ' Z';
      g.appendChild(el('path', { d, fill: 'none', ...stroke }));
    } else {
      g.appendChild(el('rect', { x, y, width: w, height: h, fill: annotation.kind === 'highlight' ? color : 'none', 'fill-opacity': annotation.kind === 'highlight' ? fillOpacity : 0, ...stroke }));
    }
  } else if (annotation.kind === 'ellipse') {
    g.appendChild(el('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, fill: 'none', ...stroke }));
  } else if (annotation.kind === 'text') {
    const text = el('text', { x: a.x, y: a.y, fill: color, 'font-size': 12, 'font-weight': 600, 'paint-order': 'stroke', stroke: '#ffffff', 'stroke-width': 3, 'stroke-linejoin': 'round' });
    text.textContent = annotation.text ?? '';
    g.appendChild(text);
  }
  return g;
}

function renderViewport(v: { points: Pt[]; metersPerPt: number; source: string }): SVGGElement {
  const pts = v.points.map(pdfToView);
  const g = el('g', { class: 'viewport' });
  g.appendChild(
    el('polygon', {
      points: pts.map((p) => `${p.x},${p.y}`).join(' '),
      fill: '#d97706',
      'fill-opacity': 0.04,
      stroke: '#d97706',
      'stroke-width': 1,
      'stroke-dasharray': '5 3',
    }),
  );
  const c = centroid(pts);
  const label = el('text', {
    x: c.x, y: c.y - 6, 'text-anchor': 'middle', 'font-size': 8, fill: '#b45309',
    'paint-order': 'stroke', stroke: '#ffffff', 'stroke-width': 2.4, 'stroke-linejoin': 'round',
    'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
  });
  const ratio = ratioOn(state.pageNum, v.metersPerPt) ?? ratioForMetersPerPt(v.metersPerPt);
  label.textContent = ` viewport 1:${Math.abs(ratio - Math.round(ratio)) < 0.5 ? Math.round(ratio) : ratio.toFixed(1)} `;
  g.appendChild(label);
  return g;
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
  const color = m.color || layerColor(m) || COLORS[m.type] || '#333';
  const strokeWidth = Math.max(0.25, Math.min(12, m.strokeWidth ?? 1.6));
  const strokeOpacity = Math.max(0, Math.min(1, m.strokeOpacity ?? 1));
  const fillOpacity = Math.max(0, Math.min(1, m.fillOpacity ?? 0.13));
  const dash = m.lineStyle === 'dashed' ? '6 3' : m.lineStyle === 'dotted' ? '1 3' : undefined;
  const selected = m.id === state.selectedId;
  const focus = state.focusLabel === `${m.type}|${m.label}`;
  const g = el('g', {
    class: `markup m-${m.type}${selected ? ' selected' : ''}${focus ? ' focus' : ''}${scanStyle.hidden.has(m.id) ? ' fx-pending' : ''}`,
    'data-id': m.id,
  });
  const title = el('title');
  title.textContent = labelText(m);
  g.appendChild(title);
  const geometrySource = m.sourceId ? state.markups.find((item) => item.id === m.sourceId) : undefined;
  const pts = (geometrySource?.points ?? m.points).map(pdfToView);

  if (m.type === 'length') {
    g.appendChild(
      el('polyline', {
        points: pts.map((p) => `${p.x},${p.y}`).join(' '),
        fill: 'none',
        stroke: color,
        'stroke-width': selected ? strokeWidth * 1.5 : strokeWidth,
        'stroke-opacity': strokeOpacity,
        ...(dash ? { 'stroke-dasharray': dash } : {}),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
    addVertices(g, pts, color, selected);
    const mid = pts[Math.max(0, pts.length - 2)] ?? pts[0];
    const end = pts[pts.length - 1] ?? mid;
    // a line too short on screen to carry its label (dozens of proposed wall
    // runs) shows it only when selected; the hover tooltip always has it
    const text = labelText(m);
    const onScreen = pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
    if (selected || onScreen >= text.length * 3.5) addLabel(g, text, { x: (mid.x + end.x) / 2, y: (mid.y + end.y) / 2 });
  } else if (m.type === 'area' || m.type === 'volume') {
    g.appendChild(
      el('polygon', {
        points: pts.map((p) => `${p.x},${p.y}`).join(' '),
        fill: color,
        'fill-opacity': selected ? Math.min(1, Math.max(fillOpacity, 0.22)) : fillOpacity,
        stroke: color,
        'stroke-width': selected ? strokeWidth * 1.5 : strokeWidth,
        'stroke-opacity': strokeOpacity,
        'stroke-linejoin': 'round',
        ...(m.type === 'volume' && !m.lineStyle ? { 'stroke-dasharray': '6 2' } : dash ? { 'stroke-dasharray': dash } : {}),
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
        'stroke-width': selected ? strokeWidth * 1.5 : strokeWidth,
        'stroke-opacity': strokeOpacity,
        'stroke-linejoin': 'round',
        ...(dash ? { 'stroke-dasharray': dash } : {}),
      }),
    );
    addVertices(g, pts, color, selected);
    addLabel(g, labelText(m), centroid(pts));
  } else if (m.type === 'angle') {
    const [v, a, b] = pts;
    for (const ray of [a, b]) {
      if (!ray) continue;
      g.appendChild(
        el('line', { x1: v.x, y1: v.y, x2: ray.x, y2: ray.y, stroke: color, 'stroke-width': selected ? strokeWidth * 1.5 : strokeWidth, 'stroke-opacity': strokeOpacity, ...(dash ? { 'stroke-dasharray': dash } : {}) }),
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
    // needs checking: white with the human-signal ring, until a person decides
    const flagged = m.status === 'check' && !scanStyle.quiet.has(m.id);
    if (scanStyle.reviewing === m.id) g.appendChild(el('circle', { cx: p.x, cy: p.y, r: 14, fill: 'none', stroke: HUMAN, 'stroke-width': 2.5 }));
    if (scanStyle.example === m.id) g.appendChild(el('circle', { cx: p.x, cy: p.y, r: 11.5, fill: 'none', stroke: HALO, 'stroke-width': 2, opacity: 0.8 }));
    g.appendChild(
      el(
        'circle',
        flagged
          ? { cx: p.x, cy: p.y, r: selected ? 8.5 : 7, fill: '#ffffff', stroke: HUMAN, 'stroke-width': 1.8 }
          : { cx: p.x, cy: p.y, r: selected ? 8.5 : 7, fill: color, 'fill-opacity': 0.92 },
      ),
    );
    const t = el('text', {
      x: p.x,
      y: p.y + 0.5,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': 8,
      'font-weight': '700',
      fill: flagged ? HUMAN : '#ffffff',
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
    });
    t.textContent = String(num);
    g.appendChild(t);
  }

  // Unselected markups get a forgiving screen-space hit target. This makes
  // thin take-off lines selectable without changing their stored PDF points.
  // Selected markups keep their vertex handles on top for precise editing.
  if (!selected) {
    const hitRadius = 12 / Math.max(0.05, state.zoom);
    if (m.type === 'count' || m.type === 'note') {
      const p = pts[0];
      g.appendChild(el('circle', {
        cx: p.x, cy: p.y, r: hitRadius, fill: 'transparent',
        'pointer-events': 'all',
      }));
    } else if (m.type === 'angle') {
      for (const end of [pts[1], pts[2]]) {
        if (end) g.appendChild(el('line', {
          x1: pts[0].x, y1: pts[0].y, x2: end.x, y2: end.y,
          stroke: 'transparent', 'stroke-width': hitRadius,
          'stroke-linecap': 'round', 'pointer-events': 'stroke',
        }));
      }
    } else {
      const closed = m.type === 'area' || m.type === 'volume' || m.type === 'perimeter';
      g.appendChild(el(closed ? 'polygon' : 'polyline', {
        points: pts.map((p) => `${p.x},${p.y}`).join(' '),
        fill: closed ? 'transparent' : 'none',
        stroke: 'transparent', 'stroke-width': hitRadius,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'pointer-events': closed ? 'all' : 'stroke',
      }));
    }
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
    const cal = spec.kind === 'calibrate' ? undefined : calibrationForMarkup({ id: 'preview', page: state.pageNum, type: spec.kind, label: '', points: chain, createdAt: 0 });
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
