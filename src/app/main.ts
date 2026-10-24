// Bootstrap: wire DOM, viewer, tools and table together.

import './styles.css';
import './flowstate.css';
import { state, subscribe, emit } from './state';
import { initViewer, loadPdf, renderPage, fitWidth, setZoom, hasDoc, eventToView, viewToPdf } from './viewer';
import { initTools, setTool, setStatusHint } from './tools';
import { initTable, renderTable } from './table';
import { renderMarkups } from './render';
import { saveAnnotatedPdf, importMarkups } from './pdfio';
import { playDemo, stopDemo } from './demo';
import { exportXlsx } from './table';
import { initPageStrip } from './pagestrip';
import { initLibrary, renderLibrary } from './library';
import { startSession, stopSession, sessionActive, getPeers } from './session';
import { loadPresets, loadColumns } from './persistence';
import { initColumns, renderColumns } from './columns';
import { initLayers, renderLayers } from './layers';
import { scheduleSave, restoreSession } from './persistence';
import {
  compareState,
  initCompare,
  enterCompare,
  exitCompare,
  loadRevision,
  renderCompare,
  setCompareZoom,
  setFit,
  setFade,
  swap as swapRevisions,
  nudge,
} from './compare';
import { calibrationFor, ratioOn, type Pt } from './state';
import { prepareFiles, ACCEPT } from './inputs';
import { formatLength, DISPLAY_UNITS, unitLabel } from '../engine/units';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const scrollEl = $('scrollContainer');
const pageEl = $('pageWrap');
const canvas = $('pdfCanvas') as HTMLCanvasElement;
const overlay = $('overlay') as unknown as SVGSVGElement;
const previewLayer = $('previewLayer') as unknown as SVGGElement;
const markupsLayer = $('markupsLayer') as unknown as SVGGElement;
const dropzone = $('dropzone');
const fileInput = $('fileInput') as HTMLInputElement;

initViewer(scrollEl, pageEl, canvas, overlay, markupsLayer, previewLayer);
initTools(overlay);
initTable();
initCompare(canvas, pageEl);
initPageStrip(document.getElementById('pageStrip')!);
initLibrary();
initColumns();
initLayers();
void loadPresets().then((presets) => {
  state.presets = presets;
  renderLibrary();
});
void loadColumns().then((columns) => {
  state.columns = columns;
  renderColumns();
  emit();
});

// the workspace fills the viewport; keep reloads from restoring a mid-page offset
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// --- status hint ---

setStatusHint((text) => {
  $('toolHint').textContent = text;
});

// --- file opening ---

async function openBytes(bytes: Uint8Array, name: string, notes: string[] = []): Promise<void> {
  exitCompare();
  stopSession(); // a new drawing starts a fresh channel
  $('loading').classList.remove('hidden');
  try {
    await loadPdf(bytes, name);
    window.scrollTo(0, 0);
    dropzone.classList.add('hidden');
    let restored = await importMarkups();
    let restoreKind = 'pdf';
    if (!restored) {
      restored = await restoreSession(bytes);
      restoreKind = 'session';
    }
    await renderPage();
    renderMarkups();
    setTool(restored ? 'pan' : 'calibrate');
    $('toolHint').textContent = [
      restored
        ? restoreKind === 'pdf'
          ? `Restored ${restored} markups from this PDF; calibrate the scale to see values`
          : `Restored your last session: ${restored} measurements, scale included`
        : 'Calibrate the scale to start measuring (press C)',
      ...notes,
    ].join(' ');
  } catch (err) {
    $('toolHint').textContent = `Could not open this file: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    $('loading').classList.add('hidden');
    emit();
  }
}

/** Open one or more files: a PDF as it is, images and mixed sets as one document. */
async function openFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  $('loading').classList.remove('hidden');
  try {
    const prepared = await prepareFiles(files);
    if (!prepared.ok) {
      $('toolHint').textContent = prepared.message;
      showMessage(prepared.message);
      return;
    }
    await openBytes(prepared.bytes, prepared.name, prepared.notes);
  } catch (err) {
    const message = `Could not open this file: ${err instanceof Error ? err.message : String(err)}`;
    $('toolHint').textContent = message;
    showMessage(message);
  } finally {
    $('loading').classList.add('hidden');
  }
}

/** On the landing page the status bar is hidden, so say it where the person is looking. */
function showMessage(text: string): void {
  if (!document.body.classList.contains('landing')) return;
  const note = document.getElementById('openNote');
  if (!note) return;
  note.textContent = text;
  note.hidden = false;
}

fileInput.accept = ACCEPT;
fileInput.multiple = true;
fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = '';
  void openFiles(files);
});

// paste a screenshot or a copied image (not while typing in a field)
window.addEventListener('paste', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  void openFiles(files);
});

// every "Open a drawing" button across the landing page and the app topbar
for (const id of ['openBtn', 'openBtnHero', 'openBtnHeroMain', 'openBtnHeader', 'openBtnClose']) {
  document.getElementById(id)?.addEventListener('click', () => fileInput.click());
}

async function openSample(): Promise<void> {
  const resp = await fetch('examples/sample-floor-plan.pdf');
  const buf = await resp.arrayBuffer();
  await openBytes(new Uint8Array(buf), 'sample-floor-plan.pdf');
}

document.getElementById('sampleBtnHero')?.addEventListener('click', () => void openSample());
document.getElementById('sampleBtnClose')?.addEventListener('click', () => void openSample());
document.getElementById('scrollCue')?.addEventListener('click', (e) => {
  e.preventDefault();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('how')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
});

// ?file=/path.pdf — open a same-origin drawing on load (deep links, tests).
// Cross-origin URLs are refused on purpose: the privacy promise is that no
// drawing is ever fetched from somewhere else silently.
void (async () => {
  const file = new URLSearchParams(location.search).get('file');
  if (!file) return;
  if (!/^\/[^/]/.test(file) || file.includes('..')) {
    $('toolHint').textContent = '?file= only accepts same-origin paths like /examples/sample.pdf';
    return;
  }
  try {
    const resp = await fetch(file);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    await openBytes(new Uint8Array(buf), file.split('/').pop() || 'drawing.pdf');
  } catch (err) {
    $('toolHint').textContent = `Could not load ${file}: ${err instanceof Error ? err.message : String(err)}`;
  }
})();

// --- demo mode ---

document.getElementById('demoBtnHero')?.addEventListener('click', () => {
  updateLanding(); // the demo opens a document: leave landing mode now
  void playDemo();
});
document.getElementById('demoBtn')?.addEventListener('click', () => {
  updateLanding();
  void playDemo();
});
document.getElementById('demoXlsx')?.addEventListener('click', () => exportXlsx());
document.getElementById('demoTry')?.addEventListener('click', () => {
  stopDemo();
  updateLanding();
});
document.getElementById('demoReplay')?.addEventListener('click', () => {
  stopDemo();
  updateLanding();
  void playDemo();
});

// --- landing mode ---

// Landing is the marketing page state: no document open, no compare, no demo.
// Toggled in the same places #dropzone/#seo are (the subscribe callback below)
// plus around demo start/stop, which does not always pass through emit().
function updateLanding(): void {
  const landing = !hasDoc() && !compareState.active && !document.body.classList.contains('demo');
  document.body.classList.toggle('landing', landing);
}

// drag & drop anywhere on the page (landing and app alike)
for (const evt of ['dragover', 'dragenter'] as const) {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  });
}
for (const evt of ['dragleave', 'drop'] as const) {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  });
}
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) void openFiles(files);
});

// --- toolbar ---

document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool as typeof state.tool));
});

const unitSel = $('unitSelect') as HTMLSelectElement;
unitSel.replaceChildren(...DISPLAY_UNITS.map((u) => new Option(unitLabel(u), u)));
unitSel.value = state.displayUnit;
unitSel.addEventListener('change', () => {
  state.displayUnit = unitSel.value as typeof state.displayUnit;
  emit();
});

$('zoomIn').addEventListener('click', () => setZoom(state.zoom * 1.25));
$('zoomOut').addEventListener('click', () => setZoom(state.zoom / 1.25));
$('zoomFit').addEventListener('click', () => {
  if (compareState.active && compareState.a) {
    setZoom((scrollEl.clientWidth - 64) / compareState.a.pageW);
  } else {
    fitWidth();
  }
});
$('prevPage').addEventListener('click', () => {
  if (state.pageNum > 1) {
    state.pageNum--;
    emit();
  }
});
$('nextPage').addEventListener('click', () => {
  if (state.pageNum < state.pageCount) {
    state.pageNum++;
    emit();
  }
});
$('savePdfBtn').addEventListener('click', () => void saveAnnotatedPdf());

$('scaleBadge').addEventListener('click', () => setTool('calibrate'));

// --- overlay compare ---

$('sessionBtn').addEventListener('click', () => {
  if (sessionActive()) stopSession();
  else startSession();
});

$('compareBtn').addEventListener('click', async () => {
  if (compareState.active) {
    exitCompare();
    scheduleRender(0);
    return;
  }
  await enterCompare(state.fileBytes ? { bytes: state.fileBytes, name: state.fileName } : null);
  if (!compareState.a) $('cmpPickA').click();
});

function bindCmpPicker(id: 'cmpPickA' | 'cmpPickB', inputId: 'cmpFileA' | 'cmpFileB', slot: 'a' | 'b'): void {
  $(id).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', async () => {
    const input = $(inputId) as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    input.value = '';
    $('loading').classList.remove('hidden');
    try {
      const prepared = await prepareFiles([f]);
      if (!prepared.ok) throw new Error(prepared.message);
      await loadRevision(slot, prepared.bytes, prepared.name);
    } catch (err) {
      $('toolHint').textContent = `Could not open ${f.name}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      $('loading').classList.add('hidden');
    }
  });
}
bindCmpPicker('cmpPickA', 'cmpFileA', 'a');
bindCmpPicker('cmpPickB', 'cmpFileB', 'b');

$('cmpSwap').addEventListener('click', () => void swapRevisions());
($('cmpFit') as HTMLInputElement).addEventListener('change', (e) => setFit((e.target as HTMLInputElement).checked));
($('cmpFade') as HTMLInputElement).addEventListener('change', (e) => setFade((e.target as HTMLInputElement).checked));
document.querySelectorAll<HTMLButtonElement>('[data-nudge]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const [dx, dy] = btn.dataset.nudge!.split(',').map(Number);
    nudge(dx, dy);
  });
});
$('cmpClose').addEventListener('click', () => {
  exitCompare();
  scheduleRender(0);
});

// --- live cursor readout in real units ---

overlay.addEventListener('pointermove', (e) => {
  if (!hasDoc()) return;
  const v = eventToView(e);
  if (!v) return;
  const p: Pt = viewToPdf(v);
  const cal = calibrationFor(state.pageNum);
  $('cursorPos').textContent = cal
    ? `${formatLength(p.x * cal.metersPerPt, state.displayUnit)} →, ${formatLength(p.y * cal.metersPerPt, state.displayUnit)} ↑`
    : `${p.x.toFixed(0)}, ${p.y.toFixed(0)} pt`;
});

// --- react to state changes ---

let lastPage = 0;
let lastZoom = 0;
let lastFile = '';
let renderTimer: number | undefined;

subscribe(() => {
  // toolbar active state
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === state.tool);
    btn.disabled = (btn.dataset.tool !== 'pan' && !hasDoc()) || compareState.active;
  });

  // live session UI
  $('sessionBtn').classList.toggle('active', sessionActive());
  $('sessionBtn').textContent = sessionActive() ? 'Live ✓' : 'Live';
  const peersEl = $('sessionPeers');
  const live = getPeers();
  peersEl.classList.toggle('hidden', !sessionActive() || live.length === 0);
  peersEl.replaceChildren(
    ...live.map((p) => {
      const chip = document.createElement('span');
      chip.className = 'peer-chip';
      chip.textContent = '';
      chip.append(p.name + ' ');
      const pg = document.createElement('span');
      pg.className = 'pg';
      pg.textContent = 'p' + p.page;
      chip.append(pg);
      return chip;
    }),
  );

  // compare mode UI
  $('compareBar').classList.toggle('hidden', !compareState.active);
  $('compareBtn').classList.toggle('active', compareState.active);
  overlay.style.display = compareState.active ? 'none' : '';
  dropzone.classList.toggle('hidden', compareState.active || hasDoc());
  // the AEO content is for the landing state; once a drawing is open the
  // tool is the whole page (scrollers were running into marketing below)
  $('seo')?.classList.toggle('hidden', hasDoc() || compareState.active);
  updateLanding();
  if (compareState.active) {
    $('cmpAName').textContent = compareState.a?.name ?? '-';
    $('cmpBName').textContent = compareState.b?.name ?? '-';
    $('cmpOffset').textContent = `B offset ${compareState.offsetX}, ${compareState.offsetY} pt`;
    $('toolHint').textContent = compareState.b
      ? 'Overlay compare: red was removed, blue was added; nudge B to align the sheets'
      : 'Choose revision A and revision B to compare';
  }

  // viewer reaction
  if (state.fileName !== lastFile) {
    lastFile = state.fileName;
    lastPage = state.pageNum;
    lastZoom = state.zoom;
    scheduleRender(0);
  } else if (state.pageNum !== lastPage) {
    lastPage = state.pageNum;
    scheduleRender(0);
  } else if (state.zoom !== lastZoom) {
    lastZoom = state.zoom;
    scheduleRender(160);
  }

  // nav / zoom readouts
  const nav = $('pageIndicator');
  nav.textContent = hasDoc() ? `${state.pageNum} / ${state.pageCount}` : '- / -';
  $('zoomIndicator').textContent = `${Math.round(state.zoom * 100)}%`;

  // scale badge
  const cal = calibrationFor(state.pageNum);
  const badge = $('scaleBadge');
  if (!hasDoc()) {
    badge.textContent = 'Scale';
    badge.classList.remove('ok');
  } else if (cal) {
    // an image page without a paper size has a real scale but no printed ratio
    const ratio = ratioOn(state.pageNum, cal.metersPerPt);
    const pretty = ratio === null ? 'set' : Math.abs(ratio - Math.round(ratio)) < 0.5 ? `1:${Math.round(ratio)}` : `1:${ratio.toFixed(0)}*`;
    badge.textContent = `Scale ${pretty}`;
    badge.classList.add('ok');
  } else {
    badge.textContent = 'Scale: not calibrated';
    badge.classList.remove('ok');
  }

  $('fileIndicator').textContent = state.fileName;

  renderMarkups();
  renderTable();
  renderLayers(); // counts + active layer follow the takeoff
  renderLibrary(); // active-chip highlight follows tool/preset changes
  scheduleSave(); // debounced persistence of markups + calibrations
});

function scheduleRender(delayMs: number): void {
  if (renderTimer) window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    window.scrollTo(0, 0); // keep the workspace anchored while the tool is in use
    if (compareState.active) {
      setCompareZoom(state.zoom);
      void renderCompare(state.zoom);
    } else {
      void renderPage();
    }
  }, delayMs);
}

// --- misc keyboard: zoom, page nav, fit ---

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  if (!hasDoc()) return;
  switch (e.key) {
    case '+':
    case '=':
      setZoom(state.zoom * 1.25);
      break;
    case '-':
      setZoom(state.zoom / 1.25);
      break;
    case 'f':
      fitWidth();
      break;
    case 'ArrowLeft':
    case 'PageUp':
      if (state.pageNum > 1) {
        state.pageNum--;
        emit();
      }
      break;
    case 'ArrowRight':
    case 'PageDown':
      if (state.pageNum < state.pageCount) {
        state.pageNum++;
        emit();
      }
      break;
  }
});

setTool('pan');
$('toolHint').textContent = 'Open a PDF drawing to begin, or drop one anywhere in this window';
emit();
