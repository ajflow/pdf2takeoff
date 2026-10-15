// Page filmstrip: thumbnails along the bottom of the workspace with per-page
// calibration status. Thumbs render lazily in a background queue so a 100-page
// set doesn't stall the viewer.

import { state, subscribe, emit, calibrationFor } from './state';
import { getPdfDoc } from './viewer';

let strip: HTMLElement;
let lastFileKey = '';
const thumbs = new Map<number, string>(); // page -> dataURL
let queue: number[] = [];
let running = false;

export function initPageStrip(el: HTMLElement): void {
  strip = el;
  strip.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-page]');
    if (!btn) return;
    const p = Number(btn.dataset.page);
    if (p >= 1 && p <= state.pageCount && p !== state.pageNum) {
      state.pageNum = p;
      emit(); // main's subscription re-renders the page
    }
  });
  subscribe(render);
  render();
}

function render(): void {
  if (!strip) return;
  const fileKey = `${state.fileName}:${state.pageCount}`;
  const newDoc = fileKey !== lastFileKey;
  if (newDoc) {
    lastFileKey = fileKey;
    thumbs.clear();
    queue = [];
  }
  strip.classList.toggle('hidden', state.pageCount === 0);
  strip.replaceChildren();
  for (let p = 1; p <= state.pageCount; p++) {
    const btn = document.createElement('button');
    btn.className = 'page-thumb' + (p === state.pageNum ? ' active' : '');
    btn.dataset.page = String(p);
    const img = document.createElement('img');
    img.alt = `Page ${p}`;
    const existing = thumbs.get(p);
    if (existing) img.src = existing;
    else img.className = 'pending';
    const num = document.createElement('span');
    num.className = 'page-thumb-num';
    num.textContent = String(p);
    btn.appendChild(img);
    btn.appendChild(num);
    if (calibrationFor(p)) {
      const dot = document.createElement('i');
      dot.className = 'calib-dot';
      dot.title = 'Calibrated';
      btn.appendChild(dot);
    }
    strip.appendChild(btn);
    if (!existing && !queue.includes(p)) queue.push(p);
  }
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const doc = getPdfDoc();
    while (queue.length && doc) {
      const p = queue.shift()!;
      if (thumbs.has(p)) continue;
      const page = await doc.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = 104 / vp1.width;
      const vp = page.getViewport({ scale });
      const cnv = document.createElement('canvas');
      cnv.width = Math.max(1, Math.round(vp.width));
      cnv.height = Math.max(1, Math.round(vp.height));
      const ctx = cnv.getContext('2d')!;
      await page.render({ canvas: cnv, canvasContext: ctx, viewport: vp }).promise;
      const url = cnv.toDataURL('image/jpeg', 0.72);
      thumbs.set(p, url);
      const img = strip.querySelector<HTMLImageElement>(`[data-page="${p}"] img`);
      if (img) {
        img.src = url;
        img.className = '';
      }
    }
  } catch {
    /* doc closed mid-queue */
  } finally {
    running = false;
  }
}
