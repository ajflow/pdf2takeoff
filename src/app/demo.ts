// Demo mode: the real app drives itself through a full takeoff on the sample
// drawing — calibrate, measure a wall, take off an area, scan-count symbols —
// then shows the output summary with working export buttons. Not a video:
// every step is the actual engine running.

import {
  state,
  emit,
  nextId,
  type Markup,
  type Pt,
  distPt,
  markupLength,
  markupArea,
} from './state';
import { loadPdf, renderPage } from './viewer';
import { setTool } from './tools';
import { renderMarkups } from './render';
import { exitCompare } from './compare';
import { formatLength, formatArea } from '../engine/units';

let playing = false;
let cancelled = false;

const sleep = (ms: number) =>
  new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      if (cancelled) reject(new Error('demo-cancelled'));
      else resolve();
    }, ms);
  });

// sample-drawing geometry (see scripts/make-sample.mjs)
const M = 28.3465; // pt per metre at 1:100
const px = (v: number) => 60 + v * M;
const py = (v: number) => 90 + v * M;

function caption(step: string, text: string): void {
  document.getElementById('demoStep')!.textContent = step;
  document.getElementById('demoText')!.textContent = text;
  document.getElementById('demoCaption')?.classList.remove('hidden');
}

function hideCaption(): void {
  document.getElementById('demoCaption')?.classList.add('hidden');
}

function addMarkup(m: Markup): void {
  state.markups.push(m);
  state.lastAction = null;
  renderMarkups();
  emit();
  document.querySelector('#markupsLayer > g.markup:last-child')?.classList.add('pop');
}

export async function playDemo(): Promise<void> {
  if (playing) return;
  playing = true;
  cancelled = false;
  exitCompare();
  document.body.classList.add('demo');
  document.getElementById('demoEnd')?.classList.add('hidden');
  hideCaption();
  try {
    caption('1/5', 'Opening a real drawing: a 1:100 floor plan. It renders on your machine; nothing uploads.');
    const resp = await fetch('examples/sample-floor-plan.pdf');
    await loadPdf(new Uint8Array(await resp.arrayBuffer()), 'sample-floor-plan.pdf');
    window.scrollTo(0, 0);
    await renderPage();
    renderMarkups();
    setTool('pan');
    await sleep(1800);

    // --- calibrate on the printed 12.00 m dimension ---
    caption('2/5', 'Calibrate: click both ends of a printed dimension; this one says 12.00 m.');
    const calLine: Markup = {
      id: nextId('demo'),
      page: 1,
      type: 'length',
      label: '12.00 m',
      points: [
        { x: 60, y: 72 },
        { x: 60 + 12 * M, y: 72 },
      ],
      createdAt: Date.now(),
    };
    addMarkup(calLine);
    await sleep(1600);
    state.markups = state.markups.filter((m) => m.id !== calLine.id);
    state.calibrations.set(1, {
      metersPerPt: 12 / distPt(calLine.points[0], calLine.points[1]),
      source: 'measured 12 m (demo)',
    });
    renderMarkups();
    emit();
    await sleep(1200);

    // --- wall length ---
    caption('3/5', 'Measure the external wall with the Length tool: 12.00 m, added to the list automatically.');
    addMarkup({
      id: nextId('demo'),
      page: 1,
      type: 'length',
      label: 'External wall',
      points: [
        { x: 60, y: 90 },
        { x: 60 + 12 * M, y: 90 },
      ],
      createdAt: Date.now(),
    });
    await sleep(2000);

    // --- office area ---
    caption('4/5', 'Outline the office with the Area tool: 4 m × 8 m = 32 m², totalled by label.');
    addMarkup({
      id: nextId('demo'),
      page: 1,
      type: 'area',
      label: 'Office floor',
      points: [
        { x: px(0), y: py(0) },
        { x: px(4), y: py(0) },
        { x: px(4), y: py(8) },
        { x: px(0), y: py(8) },
      ],
      createdAt: Date.now(),
    });
    await sleep(2200);

    // --- scan the downlights ---
    caption('5/5', 'Scan: click one downlight; every match on the sheet is found and counted.');
    const lights: Pt[] = [
      [1, 6.4],
      [2, 6.4],
      [3, 6.4],
      [1.8, 4.4],
      [2.6, 4.4],
      [1, 2.2],
      [2, 2.2],
      [3, 2.2],
    ].map(([cx, cy]) => ({ x: px(cx), y: py(cy) }));
    let i = 0;
    for (const p of lights) {
      addMarkup({
        id: nextId('demo'),
        page: 1,
        type: 'count',
        label: 'Downlight DL-100',
        points: [p],
        createdAt: Date.now() + i++,
      });
      await sleep(i === 1 ? 1000 : 320);
    }
    await sleep(1000);

    // --- results card ---
    buildResults();
    hideCaption();
    document.getElementById('demoEnd')?.classList.remove('hidden');
  } catch {
    hideCaption();
  } finally {
    playing = false;
  }
}

export function stopDemo(): void {
  cancelled = true;
  hideCaption();
  document.getElementById('demoEnd')?.classList.add('hidden');
  document.body.classList.remove('demo');
}

/** The "this is the output" card — the same numbers the Excel export contains. */
function buildResults(): void {
  const cal = state.calibrations.get(1);
  const rows: { label: string; type: string; value: string; count?: number }[] = [];
  const groups = new Map<string, Markup[]>();
  for (const m of state.markups) {
    const key = `${m.type}|${m.label}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  for (const g of groups.values()) {
    const first = g[0];
    let value = '';
    if (cal) {
      if (first.type === 'length') {
        value = formatLength(g.reduce((s, m) => s + markupLength(m, cal.metersPerPt), 0), state.displayUnit);
      } else if (first.type === 'area') {
        value = formatArea(g.reduce((s, m) => s + markupArea(m, cal.metersPerPt), 0), state.displayUnit);
      } else {
        value = `${g.length} ×`;
      }
    }
    rows.push({ label: first.label, type: first.type, value });
  }

  const tbody = document.getElementById('demoResults');
  if (tbody) {
    tbody.innerHTML = rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.label)}</td><td><span class="tag tag-${r.type}">${r.type}</span></td><td class="mono">${r.value}</td></tr>`,
      )
      .join('');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
