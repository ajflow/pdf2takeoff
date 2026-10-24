// Markups list (right sidebar): rows per measurement, group totals, and
// CSV / clipboard / Excel export. Serialization math lives in the engine.

import { state, emit, calibrationForMarkup, takeoffData } from './state';
import {
  groupsOf,
  valueParts,
  formatMarkupValue,
  buildMatrix,
  toDelimited,
  xlsxBytes,
} from '../engine/export';
import { defaultLabel, markupLength, markupArea, markupPerimeter, markupVolume } from '../engine/geometry';
import { formatLength, formatArea, formatVolume } from '../engine/units';
import { exportReport } from './report';
import { syncUpsertMarkup, syncDeleteMarkup, syncClearMarkups } from './session';
import { columnValuesFor } from './columns';
import { isVisibleLayer } from './layers';

let tbody: HTMLElement;
let totalsEl: HTMLElement;

export function initTable(): void {
  tbody = document.getElementById('markupRows')!;
  totalsEl = document.getElementById('markupTotals')!;
  tbody.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const st = target.closest('[data-status-for]');
    if (st) {
      const m = state.markups.find((x) => x.id === st.getAttribute('data-status-for'));
      if (m) {
        // cycle none -> check -> confirmed -> none
        m.status = m.status === 'check' ? 'confirmed' : m.status === 'confirmed' ? undefined : 'check';
        syncUpsertMarkup(m);
        emit();
      }
      return;
    }
    const del = target.closest('[data-del]');
    if (del) {
      const id = del.getAttribute('data-del')!;
      state.markups = state.markups.filter((m) => m.id !== id);
      if (state.selectedId === id) state.selectedId = null;
      syncDeleteMarkup(id);
      emit();
      return;
    }
    const row = target.closest('[data-id]') as HTMLElement | null;
    if (row) {
      const id = row.getAttribute('data-id')!;
      const m = state.markups.find((x) => x.id === id);
      if (m) {
        state.selectedId = id;
        if (m.page !== state.pageNum) state.pageNum = m.page;
        emit();
      }
    }
  });
  tbody.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.labelFor) {
      const m = state.markups.find((x) => x.id === input.dataset.labelFor);
      if (m) {
        m.label = input.value.trim() || defaultLabel(m.type);
        syncUpsertMarkup(m);
        emit();
      }
    }
  });

  document.getElementById('exportCsvBtn')?.addEventListener('click', exportCsv);
  document.getElementById('copyTsvBtn')?.addEventListener('click', copyTsv);
  document.getElementById('exportXlsxBtn')?.addEventListener('click', exportXlsx);
  document.getElementById('reportBtn')?.addEventListener('click', () => void exportReport());
  document.getElementById('clearMarkups')?.addEventListener('click', () => {
    if (state.markups.length === 0) return;
    if (!window.confirm(`Remove all ${state.markups.length} measurements in this takeoff?`)) return;
    state.markups = [];
    state.selectedId = null;
    syncClearMarkups();
    emit();
  });

  const search = document.getElementById('listSearch') as HTMLInputElement | null;
  search?.addEventListener('input', () => {
    state.listFilter.text = search.value;
    renderTable();
  });
  document.querySelectorAll<HTMLElement>('[data-status-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.listFilter.status = btn.getAttribute('data-status-filter') as typeof state.listFilter.status;
      syncFilterUi();
      renderTable();
    });
  });
  document.getElementById('listSort')?.addEventListener('change', (e) => {
    state.listFilter.sort = (e.target as HTMLSelectElement).value as typeof state.listFilter.sort;
    renderTable();
  });
  syncFilterUi();
}

function syncFilterUi(): void {
  document.querySelectorAll<HTMLElement>('[data-status-filter]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-status-filter') === state.listFilter.status);
  });
}

function filteredMarkups() {
  const f = state.listFilter;
  const text = f.text.trim().toLowerCase();
  let rows = state.markups.filter(
    (m) =>
      isVisibleLayer(m) &&
      (f.status === 'all' || (f.status === 'none' ? !m.status : m.status === f.status)) &&
      (!text || m.label.toLowerCase().includes(text)),
  );
  if (f.sort === 'label') rows = [...rows].sort((a, b) => a.label.localeCompare(b.label));
  else if (f.sort === 'page') rows = [...rows].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
  return rows;
}

export function renderTable(): void {
  tbody.replaceChildren();
  const rows = filteredMarkups();
  if (state.markups.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="empty">No measurements yet; calibrate the scale, then use the Length, Area and Count tools.</td>`;
    tbody.appendChild(tr);
  } else if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="empty">No measurements match the filter.</td>`;
    tbody.appendChild(tr);
  }
  for (const m of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = m.id;
    if (m.id === state.selectedId) tr.classList.add('selected');
    const { value } = valueParts(m, calibrationForMarkup(m), state.displayUnit);
    const typeIcon =
      m.type === 'length' ? '📏' : m.type === 'area' ? '⬡' : m.type === 'count' ? '🔢'
      : m.type === 'perimeter' ? '↻' : m.type === 'volume' ? '◨' : m.type === 'note' ? '💬' : '∠';
    tr.innerHTML = `
      <td class="cell-label"><input data-label-for="${m.id}" value="${escapeAttr(m.label)}" title="Rename" /></td>
      <td class="cell-type"><span class="tag tag-${m.type}">${typeIcon} ${m.type}</span></td>
      <td class="cell-num">p${m.page}</td>
      <td class="cell-measure">${value ? `${escapeHtml(formatMarkupValue(m, calibrationForMarkup(m), state.displayUnit))}` : '<span class="warn">not calibrated</span>'}</td>
      <td class="cell-status"><button data-status-for="${m.id}" class="status-btn st-${m.status ?? 'none'}" title="${m.status === 'check' ? 'Needs checking — click to confirm' : m.status === 'confirmed' ? 'Confirmed — click to clear' : 'Click to mark for checking'}">${m.status === 'check' ? '⚑' : m.status === 'confirmed' ? '✓' : '○'}</button></td>
      <td class="cell-del"><button data-del="${m.id}" title="Delete">✕</button></td>`;
    tbody.appendChild(tr);
  }
  renderTotals();
}

function renderTotals(): void {
  totalsEl.replaceChildren();
  const gs = groupsOf(state.markups.filter(isVisibleLayer));
  if (gs.length === 0) {
    totalsEl.innerHTML = `<div class="totals-empty">Totals appear once you measure something.</div>`;
    return;
  }
  for (const g of gs) {
    const cal = calibrationForMarkup(g.items[0]);
    let text: string;
    if (g.type === 'count') {
      text = `${g.items.length} ×`;
      const extras = columnValuesFor(g.items.length, g.items.length);
      if (extras.length) text += extras.map((x) => ` · ${x.name}: ${x.text}`).join('');
    } else if (g.type === 'angle') {
      text = '—'; // angles don't sum
    } else if (cal) {
      const total = g.items.reduce((s, m) => {
        if (g.type === 'length') return s + markupLength(m, cal.metersPerPt);
        if (g.type === 'perimeter') return s + markupPerimeter(m, cal.metersPerPt);
        if (g.type === 'volume') return s + markupVolume(m, cal.metersPerPt);
        return s + markupArea(m, cal.metersPerPt);
      }, 0);
      if (g.type === 'length' || g.type === 'perimeter') text = formatLength(total, state.displayUnit);
      else if (g.type === 'volume') text = formatVolume(total, state.displayUnit);
      else text = formatArea(total, state.displayUnit);
      const extras = columnValuesFor(typeof total === 'number' ? total : null, g.items.length);
      if (extras.length) text += extras.map((x) => ` · ${x.name}: ${x.text}`).join('');
    } else {
      text = 'not calibrated';
    }
    const div = document.createElement('div');
    div.className = 'total-row';
    div.innerHTML = `<span class="total-label">${escapeHtml(g.label)} <em>(${g.items.length})</em></span><span class="total-value">${text}</span>`;
    totalsEl.appendChild(div);
  }
}

// --- export ---

function download(name: string, mime: string, data: string | Uint8Array): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function baseName(): string {
  return state.fileName.replace(/\.pdf$/i, '') || 'takeoff';
}

function exportCsv(): void {
  if (!state.markups.length) return;
  // UTF-8 BOM so Excel opens the units correctly
  download(`${baseName()}-takeoff.csv`, 'text/csv;charset=utf-8', '\ufeff' + toDelimited(buildMatrix(takeoffData()), ','));
}

/** Export the takeoff as an Excel workbook. Also used by demo mode. */
export async function exportXlsx(): Promise<void> {
  if (!state.markups.length) return;
  download(
    `${baseName()}-takeoff.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await xlsxBytes(buildMatrix(takeoffData())),
  );
}

async function copyTsv(): Promise<void> {
  if (!state.markups.length) return;
  try {
    await navigator.clipboard.writeText(toDelimited(buildMatrix(takeoffData()), '\t'));
    const btn = document.getElementById('copyTsvBtn')!;
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    /* clipboard unavailable */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
