// Markups list (right sidebar): rows per measurement, group totals, and
// CSV / clipboard / Excel export. Serialization math lives in the engine.

import { state, emit, calibrationFor, takeoffData } from './state';
import {
  groupsOf,
  valueParts,
  formatMarkupValue,
  buildMatrix,
  toDelimited,
  xlsxBytes,
} from '../engine/export';
import { defaultLabel, markupLength, markupArea } from '../engine/geometry';
import { formatLength, formatArea } from '../engine/units';
import { exportReport } from './report';

let tbody: HTMLElement;
let totalsEl: HTMLElement;

export function initTable(): void {
  tbody = document.getElementById('markupRows')!;
  totalsEl = document.getElementById('markupTotals')!;
  tbody.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const del = target.closest('[data-del]');
    if (del) {
      const id = del.getAttribute('data-del')!;
      state.markups = state.markups.filter((m) => m.id !== id);
      if (state.selectedId === id) state.selectedId = null;
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
        emit();
      }
    }
  });

  document.getElementById('exportCsvBtn')?.addEventListener('click', exportCsv);
  document.getElementById('copyTsvBtn')?.addEventListener('click', copyTsv);
  document.getElementById('exportXlsxBtn')?.addEventListener('click', exportXlsx);
  document.getElementById('reportBtn')?.addEventListener('click', () => void exportReport());
}

export function renderTable(): void {
  tbody.replaceChildren();
  if (state.markups.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" class="empty">No measurements yet; calibrate the scale, then use the Length, Area and Count tools.</td>`;
    tbody.appendChild(tr);
  }
  for (const m of state.markups) {
    const tr = document.createElement('tr');
    tr.dataset.id = m.id;
    if (m.id === state.selectedId) tr.classList.add('selected');
    const { value } = valueParts(m, calibrationFor(m.page), state.displayUnit);
    const typeIcon = m.type === 'length' ? '📏' : m.type === 'area' ? '⬡' : '🔢';
    tr.innerHTML = `
      <td class="cell-label"><input data-label-for="${m.id}" value="${escapeAttr(m.label)}" title="Rename" /></td>
      <td class="cell-type"><span class="tag tag-${m.type}">${typeIcon} ${m.type}</span></td>
      <td class="cell-num">p${m.page}</td>
      <td class="cell-measure">${value ? `${escapeHtml(formatMarkupValue(m, calibrationFor(m.page), state.displayUnit))}` : '<span class="warn">not calibrated</span>'}</td>
      <td class="cell-del"><button data-del="${m.id}" title="Delete">✕</button></td>`;
    tbody.appendChild(tr);
  }
  renderTotals();
}

function renderTotals(): void {
  totalsEl.replaceChildren();
  const gs = groupsOf(state.markups);
  if (gs.length === 0) {
    totalsEl.innerHTML = `<div class="totals-empty">Totals appear once you measure something.</div>`;
    return;
  }
  for (const g of gs) {
    const cal = calibrationFor(g.items[0].page);
    let text: string;
    if (g.type === 'count') {
      text = `${g.items.length} ×`;
    } else if (cal) {
      const total = g.items.reduce(
        (s, m) => s + (g.type === 'length' ? markupLength(m, cal.metersPerPt) : markupArea(m, cal.metersPerPt)),
        0,
      );
      text = g.type === 'length' ? formatLength(total, state.displayUnit) : formatArea(total, state.displayUnit);
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
export function exportXlsx(): void {
  if (!state.markups.length) return;
  download(
    `${baseName()}-takeoff.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xlsxBytes(buildMatrix(takeoffData())),
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
