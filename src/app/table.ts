// Markups list (right sidebar): rows per measurement, group totals, and
// CSV / clipboard / Excel export. Serialization math lives in the engine.

import { state, emit, calibrationForMarkup, takeoffData, nextId } from './state';
import {
  groupsOf,
  groupTotal,
  valueParts,
  formatMarkupValue,
  buildMatrix,
  toDelimited,
  xlsxBytes,
} from '../engine/export';
import { defaultLabel } from '../engine/geometry';
import { recordTakeoffHistory } from './tools';
import { formatLength, formatArea, formatVolume } from '../engine/units';
import { exportReport } from './report';
import { syncUpsertMarkup, syncDeleteMarkup, syncClearMarkups } from './session';
import { columnValuesFor } from './columns';
import { isVisibleLayer } from './layers';
import { fileStem } from './inputs';
import { COLORS, scanStyle } from './render';
import { templateById, templateSummary, templateMatrix } from '../engine/templates';

let tbody: HTMLElement;
let totalsEl: HTMLElement;
const expandedIds = new Set<string>();

export function initTable(): void {
  tbody = document.getElementById('markupRows')!;
  totalsEl = document.getElementById('markupTotals')!;
  tbody.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('summary') || target.closest('.markup-details')) {
      const action = target.closest<HTMLElement>('[data-clone-for], [data-add-param-for], [data-add-link-for], [data-remove-param], [data-remove-link]');
      if (!action) return;
      if (action.dataset.cloneFor) {
        const source = state.markups.find((m) => m.id === action.dataset.cloneFor);
        if (source) {
          const clone = structuredClone(source);
          clone.id = nextId('mk');
          clone.label = `${source.label} copy`;
          clone.createdAt = Date.now();
          clone.points = source.points.map((p) => ({ ...p }));
          recordTakeoffHistory();
          state.markups.push(clone);
          syncUpsertMarkup(clone);
          state.selectedId = clone.id;
          expandedIds.add(clone.id);
          emit();
        }
        return;
      }
      if (action.dataset.addParamFor) {
        const m = state.markups.find((x) => x.id === action.dataset.addParamFor);
        if (m) {
          m.parameters ??= {};
          let n = Object.keys(m.parameters).length + 1;
          let key = `Parameter ${n}`;
          while (Object.hasOwn(m.parameters, key)) key = `Parameter ${++n}`;
          m.parameters[key] = '';
          expandedIds.add(m.id);
          syncUpsertMarkup(m);
          emit();
        }
        return;
      }
      if (action.dataset.addLinkFor) {
        const m = state.markups.find((x) => x.id === action.dataset.addLinkFor);
        const targetMarkup = state.markups.find((x) => x.id !== m?.id);
        if (m && targetMarkup) {
          m.links ??= [];
          if (!m.links.some((x) => x.markupId === targetMarkup.id)) {
            m.links.push({ markupId: targetMarkup.id, relation: 'associated' });
            expandedIds.add(m.id);
            syncUpsertMarkup(m);
            emit();
          }
        }
        return;
      }
      if (action.dataset.removeParam !== undefined) {
        const [id, key] = action.dataset.removeParam.split('::');
        const m = state.markups.find((x) => x.id === id);
        if (m?.parameters) {
          delete m.parameters[key];
          if (!Object.keys(m.parameters).length) delete m.parameters;
          syncUpsertMarkup(m);
          emit();
        }
        return;
      }
      if (action.dataset.removeLink !== undefined) {
        const [id, index] = action.dataset.removeLink.split('::');
        const m = state.markups.find((x) => x.id === id);
        if (m?.links) {
          m.links.splice(Number(index), 1);
          syncUpsertMarkup(m);
          emit();
        }
        return;
      }
      return;
    }
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
    const visibility = target.closest('[data-visibility-for]');
    if (visibility) {
      const id = visibility.getAttribute('data-visibility-for')!;
      const m = state.markups.find((x) => x.id === id);
      if (m) {
        m.visible = m.visible === false;
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
  totalsEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.qrow');
    if (!row) return;
    const key = row.dataset.key!;
    state.focusLabel = state.focusLabel === key ? null : key;
    state.selectedId = null;
    // nothing of it on this page: go to the first page that has it
    if (state.focusLabel && !state.markups.some((m) => m.page === state.pageNum && groupKey(m) === key)) {
      const first = state.markups.find((m) => groupKey(m) === key);
      if (first) state.pageNum = first.page;
    }
    emit();
  });
  tbody.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const markupId = input.dataset.timesingFor || input.dataset.signFor || input.dataset.remarksFor ||
      input.dataset.parameterKeyFor || input.dataset.parameterValueFor || input.dataset.linkTargetFor || input.dataset.linkRelationFor;
    if (markupId) {
      const m = state.markups.find((x) => x.id === markupId);
      if (!m) return;
      if (input.dataset.timesingFor) {
        const n = Number(input.value);
        if (!Number.isFinite(n) || n < 0) { input.value = String(m.timesing ?? 1); return; }
        m.timesing = n;
      } else if (input.dataset.signFor) {
        m.sign = input.value === '-1' ? -1 : 1;
      } else if (input.dataset.remarksFor) {
        m.remarks = input.value;
      } else if (input.dataset.parameterKeyFor) {
        const oldKey = input.dataset.parameterKeyFor;
        const value = m.parameters?.[oldKey] ?? '';
        const key = input.value.trim();
        if (!key) { input.value = oldKey; return; }
        if (key !== oldKey && m.parameters) {
          delete m.parameters[oldKey];
          m.parameters[key] = value;
        }
      } else if (input.dataset.parameterValueFor) {
        if (m.parameters) m.parameters[input.dataset.parameterValueFor] = input.value;
      } else if (input.dataset.linkTargetFor) {
        const index = Number(input.dataset.linkIndex);
        if (m.links?.[index]) m.links[index].markupId = input.value;
      } else if (input.dataset.linkRelationFor) {
        const index = Number(input.dataset.linkIndex);
        if (m.links?.[index]) m.links[index].relation = input.value as NonNullable<Markup['links']>[number]['relation'];
      }
      syncUpsertMarkup(m);
      emit();
      return;
    }
    if (input.dataset.colorFor) {
      const m = state.markups.find((x) => x.id === input.dataset.colorFor);
      if (m) {
        m.color = input.value.toLowerCase();
        syncUpsertMarkup(m);
        emit();
      }
      return;
    }
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
  document.getElementById('templateExportBtn')?.addEventListener('click', () => void exportTemplate());
  document.getElementById('templateCopyBtn')?.addEventListener('click', () => void copyTemplate());
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
      <td class="cell-type"><span class="tag tag-${m.type}" title="${m.type}">${typeIcon} <span class="tag-word">${m.type}</span></span><input class="markup-color" type="color" data-color-for="${m.id}" value="${m.color || COLORS[m.type] || '#333333'}" title="Set colour (default is automatic)" aria-label="Colour for ${escapeAttr(m.label)}" /></td>
      <td class="cell-num">p${m.page}</td>
      <td class="cell-measure">${value ? `${escapeHtml(formatMarkupValue(m, calibrationForMarkup(m), state.displayUnit))}` : '<span class="warn">not calibrated</span>'}</td>
      <td class="cell-status"><button data-status-for="${m.id}" class="status-btn st-${m.status ?? 'none'}" title="${m.status === 'check' ? 'Needs checking — click to confirm' : m.status === 'confirmed' ? 'Confirmed — click to clear' : 'Click to mark for checking'}">${m.status === 'check' ? '⚑' : m.status === 'confirmed' ? '✓' : '○'}</button></td>
      <td class="cell-del"><button data-visibility-for="${m.id}" title="${m.visible === false ? 'Show on drawing' : 'Hide on drawing'}">${m.visible === false ? '◉' : '◌'}</button><button data-clone-for="${m.id}" title="Clone measurement">⧉</button><button data-del="${m.id}" title="Delete">✕</button></td>`;
    tbody.appendChild(tr);
    const detail = document.createElement('tr');
    detail.className = 'markup-detail-row';
    detail.innerHTML = `<td colspan="6"><details class="markup-details" data-detail-for="${m.id}" ${expandedIds.has(m.id) ? 'open' : ''}>
      <summary>QS details · timesing, dimensions, remarks and linked take-off</summary>
      <div class="markup-detail-grid">
        <label>Timesing <input type="number" min="0" step="0.01" data-timesing-for="${m.id}" value="${m.timesing ?? 1}"></label>
        <label>Sign <select data-sign-for="${m.id}"><option value="1" ${(m.sign ?? 1) > 0 ? 'selected' : ''}>+ Add</option><option value="-1" ${m.sign === -1 ? 'selected' : ''}>− Deduct</option></select></label>
        <label class="wide">Remarks <input type="text" data-remarks-for="${m.id}" value="${escapeAttr(m.remarks ?? '')}" placeholder="Location, drawing reference, specification…"></label>
      </div>
      <div class="markup-parameters"><b>Dimensions / attributes</b>
        ${Object.entries(m.parameters ?? {}).map(([key, val]) => `<div class="markup-param"><input aria-label="Parameter name" data-parameter-key-for="${m.id}" value="${escapeAttr(key)}"><input aria-label="Parameter value" data-parameter-value-for="${m.id}" value="${escapeAttr(val)}"><button type="button" data-remove-param="${m.id}::${escapeAttr(key)}" title="Remove parameter">×</button></div>`).join('')}
        <button type="button" class="btn quiet" data-add-param-for="${m.id}">+ Add attribute</button>
      </div>
      <div class="markup-links"><b>Linked take-off</b>
        ${(m.links ?? []).map((link, index) => `<div class="markup-link"><select data-link-target-for="${m.id}" data-link-index="${index}">${state.markups.filter((x) => x.id !== m.id).map((x) => `<option value="${x.id}" ${x.id === link.markupId ? 'selected' : ''}>${escapeAttr(x.label)} · p${x.page}</option>`).join('')}</select><select data-link-relation-for="${m.id}" data-link-index="${index}"><option value="associated" ${link.relation === 'associated' ? 'selected' : ''}>Associated</option><option value="deduct" ${link.relation === 'deduct' ? 'selected' : ''}>Deduct from</option><option value="add" ${link.relation === 'add' ? 'selected' : ''}>Add to</option><option value="derive" ${link.relation === 'derive' ? 'selected' : ''}>Derived from</option></select><button type="button" data-remove-link="${m.id}::${index}" title="Remove link">×</button></div>`).join('')}
        <button type="button" class="btn quiet" data-add-link-for="${m.id}" ${state.markups.length < 2 ? 'disabled' : ''}>+ Link to another measurement</button>
        <small>Links identify related take-off entries. They do not change another quantity automatically; use the explicit +/− and timesing fields to control quantities.</small>
      </div>
      <small>Adjusted quantity = measured quantity × timesing × sign. Defaults for older projects are 1 and +.</small>
    </details></td>`;
    tbody.appendChild(detail);
  }
  renderTotals();
}

/** A quantity row's key: one row per label and type, like the exports' groups. */
export const groupKey = (m: { type: string; label: string }): string => `${m.type}|${m.label}`;

/** "12.00 m" -> ["12.00", "m"]; anything else stays whole. */
function splitUnit(text: string): [string, string] {
  const m = /^([-−]?[\d.,]+)\s+(.+)$/.exec(text);
  return m ? [m[1], m[2]] : [text, ''];
}

function renderTotals(): void {
  totalsEl.replaceChildren();
  // notes carry no quantity; they stay in the Markups view
  const gs = groupsOf(state.markups.filter(isVisibleLayer)).filter((g) => g.type !== 'note');
  if (gs.length === 0) {
    totalsEl.innerHTML = `<div class="totals-empty">Quantities appear here as you measure. Set the scale (C), then use Length, Area, Fill or Scan.</div>`;
    return;
  }
  const selected = state.markups.find((m) => m.id === state.selectedId);
  const focus = state.focusLabel ?? (selected ? groupKey(selected) : null);
  for (const g of gs) {
    const { total, uncalibrated } = groupTotal(g, calibrationForMarkup);
    let value = '';
    let unit = '';
    if (g.type === 'count') [value, unit] = [String(total ?? 0), 'ea'];
    else if (g.type === 'angle') value = '—'; // angles don't sum
    else if (total === null) unit = 'not calibrated';
    else if (g.type === 'length' || g.type === 'perimeter') [value, unit] = splitUnit(formatLength(total, state.displayUnit));
    else if (g.type === 'volume') [value, unit] = splitUnit(formatVolume(total, state.displayUnit));
    else [value, unit] = splitUnit(formatArea(total, state.displayUnit));

    // under the label: what needs a person first, then anything else worth knowing
    // flagged for a person: what wears the ring on the drawing (an open scan's plain hits don't)
    const toCheck = g.items.filter((m) => m.status === 'check' && !scanStyle.quiet.has(m.id)).length;
    const pages = new Set(g.items.map((m) => m.page)).size;
    const notes: string[] = [];
    if (uncalibrated && total !== null) notes.push(`${uncalibrated} not calibrated`);
    if (pages > 1) notes.push(`${pages} pages`);
    const sub = toCheck
      ? `<small class="chk">${toCheck} to check${notes.length ? ' · ' + notes.join(' · ') : ''}</small>`
      : notes.length
        ? `<small>${notes.join(' · ')}</small>`
        : '';
    const extras = columnValuesFor(total, g.items.length);

    const key = groupKey(g);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `qrow${focus === key ? ' sel' : ''}`;
    row.dataset.key = key;
    row.setAttribute('aria-pressed', String(state.focusLabel === key));
    row.title = `Show only ${g.label} on the drawing`;
    row.innerHTML =
      `<span class="qrow-dot" style="background:${COLORS[g.type] ?? '#64748b'}"></span>` +
      `<span class="qrow-name"><b>${escapeHtml(g.label)}</b>${sub}</span>` +
      `<span class="qrow-val">${escapeHtml(value)}${unit ? `<em>${escapeHtml(unit)}</em>` : ''}</span>` +
      (extras.length ? `<span class="qrow-extra">${extras.map((x) => `${escapeHtml(x.name)}: ${escapeHtml(x.text)}`).join(' · ')}</span>` : '');
    totalsEl.appendChild(row);
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
  return fileStem(state.fileName) || 'takeoff';
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

/** The loaded trade template's lines in order, with this takeoff's quantities. */
function templateRows() {
  const t = templateById(state.template);
  if (!t) return null;
  return { t, lines: templateSummary(t, state.markups, calibrationForMarkup) };
}

async function exportTemplate(): Promise<void> {
  const rows = templateRows();
  if (!rows) return;
  const title = state.fileName.replace(/\.[a-z0-9]+$/i, '') || 'takeoff';
  download(`${baseName()}-${rows.t.id}-summary.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await xlsxBytes(templateMatrix(rows.t, rows.lines, title)));
}

async function copyTemplate(): Promise<void> {
  const rows = templateRows();
  if (!rows) return;
  try {
    await navigator.clipboard.writeText(rows.lines.map((l) => `${l.label}\t${l.quantity}\t${l.unit}`).join('\n'));
    const btn = document.getElementById('templateCopyBtn')!;
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => (btn.textContent = old), 1200);
  } catch {
    /* clipboard unavailable */
  }
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
