// Markups list (right sidebar): rows per measurement, group totals, and
// CSV / clipboard / Excel export. Serialization math lives in the engine.

import { state, emit, calibrationForMarkup, takeoffData, nextId } from './state';
import {
  groupsOf,
  groupTotal,
  valueParts,
  quantityForMarkup,
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
import { isVisibleLayer, isLockedLayer, layerOf } from './layers';
import { fileStem } from './inputs';
import { COLORS, scanStyle } from './render';
import { templateById, templateSummary, templateMatrix } from '../engine/templates';
import { formulaUsesOnlyVars } from '../engine/formula';

let tbody: HTMLElement;
let totalsEl: HTMLElement;
const expandedIds = new Set<string>();

export function initTable(): void {
  tbody = document.getElementById('markupRows')!;
  totalsEl = document.getElementById('markupTotals')!;
  tbody.addEventListener('toggle', (e) => {
    const details = e.target as HTMLDetailsElement;
    if (details.matches('.markup-details')) {
      const id = details.dataset.detailFor;
      if (id) details.open ? expandedIds.add(id) : expandedIds.delete(id);
    }
  }, true);
  tbody.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const linkedCloneButton = target.closest<HTMLElement>('[data-linked-clone-for]');
    const cloneButton = target.closest<HTMLElement>('[data-clone-for]');
    if (linkedCloneButton) {
      const source = state.markups.find((m) => m.id === linkedCloneButton.dataset.linkedCloneFor);
      if (source && !isLockedLayer(layerOf(source))) {
        const clone = structuredClone(source);
        clone.id = nextId('mk');
        clone.label = `${source.label} linked copy`;
        clone.createdAt = Date.now();
        clone.sourceId = source.sourceId || source.id;
        delete clone.formula;
        delete clone.links;
        const sourceGeometry = source.sourceId ? state.markups.find((item) => item.id === source.sourceId) ?? source : source;
        clone.points = sourceGeometry.points.map((p) => ({ ...p }));
        recordTakeoffHistory();
        state.markups.push(clone);
        syncUpsertMarkup(clone);
        state.selectedId = clone.id;
        expandedIds.add(clone.id);
        emit();
      }
      return;
    }
    if (cloneButton) {
      const source = state.markups.find((m) => m.id === cloneButton.dataset.cloneFor);
      if (source && !isLockedLayer(layerOf(source))) {
        const clone = structuredClone(source);
        clone.id = nextId('mk');
        clone.label = `${source.label} copy`;
        clone.createdAt = Date.now();
        const sourceGeometry = source.sourceId ? state.markups.find((item) => item.id === source.sourceId) ?? source : source;
        clone.points = sourceGeometry.points.map((p) => ({ ...p }));
        delete clone.sourceId;
        recordTakeoffHistory();
        state.markups.push(clone);
        syncUpsertMarkup(clone);
        state.selectedId = clone.id;
        expandedIds.add(clone.id);
        emit();
      }
      return;
    }
    if (target.closest('summary') || target.closest('.markup-details')) {
      const action = target.closest<HTMLElement>('[data-add-param-for], [data-add-link-for], [data-remove-param], [data-remove-link], [data-apply-style-for]');
      if (!action) return;
      if (action.dataset.applyStyleFor) {
        const source = state.markups.find((x) => x.id === action.dataset.applyStyleFor);
        if (source && !isLockedLayer(layerOf(source))) {
          recordTakeoffHistory();
          for (const target of state.markups.filter((x) => x.type === source.type && !isLockedLayer(layerOf(x)))) {
            if (source.color) target.color = source.color; else delete target.color;
            for (const key of ['strokeWidth', 'strokeOpacity', 'fillOpacity', 'lineStyle'] as const) {
              if (source[key] === undefined) delete target[key];
              else target[key] = source[key] as never;
            }
            syncUpsertMarkup(target);
          }
          emit();
        }
        return;
      }
      if (action.dataset.addParamFor) {
        const m = state.markups.find((x) => x.id === action.dataset.addParamFor);
        if (m && !isLockedLayer(layerOf(m))) {
          recordTakeoffHistory();
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
        const targetMarkup = state.markups.find((x) => x.id !== m?.id && !(m?.links ?? []).some((link) => link.markupId === x.id));
        if (m && targetMarkup && !isLockedLayer(layerOf(m))) {
          recordTakeoffHistory();
          m.links ??= [];
          if (!m.links.some((x) => x.markupId === targetMarkup.id)) {
            const used = new Set(m.links.map((link, i) => link.variable || String.fromCharCode(65 + i)));
            let variable = 'A';
            while (used.has(variable) && variable <= 'Z') variable = String.fromCharCode(variable.charCodeAt(0) + 1);
            m.links.push({ markupId: targetMarkup.id, variable, logic: '' });
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
        if (m?.parameters && !isLockedLayer(layerOf(m))) {
          recordTakeoffHistory();
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
        if (m?.links && !isLockedLayer(layerOf(m))) {
          recordTakeoffHistory();
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
      if (m && !isLockedLayer(layerOf(m))) {
        // cycle none -> check -> confirmed -> none
        recordTakeoffHistory();
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
        recordTakeoffHistory();
        m.visible = m.visible === false;
        syncUpsertMarkup(m);
        emit();
      }
      return;
    }
    const del = target.closest('[data-del]');
    if (del) {
      const id = del.getAttribute('data-del')!;
      const targetMarkup = state.markups.find((m) => m.id === id);
      if (!targetMarkup || isLockedLayer(layerOf(targetMarkup))) return;
      recordTakeoffHistory();
      state.markups = state.markups.filter((m) => m.id !== id);
      for (const m of state.markups) {
        if (m.links?.some((link) => link.markupId === id)) {
          m.links = m.links.filter((link) => link.markupId !== id);
          syncUpsertMarkup(m);
        }
      }
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
      input.dataset.parameterKeyFor || input.dataset.parameterValueFor || input.dataset.linkTargetFor || input.dataset.linkLogicFor || input.dataset.linkVariableFor || input.dataset.formulaFor || input.dataset.itemCodeFor || input.dataset.parentFor || input.dataset.strokeWidthFor || input.dataset.strokeOpacityFor || input.dataset.fillOpacityFor || input.dataset.lineStyleFor;
    if (markupId) {
      const m = state.markups.find((x) => x.id === markupId);
      if (!m || isLockedLayer(layerOf(m))) return;
      if (input.dataset.timesingFor) {
        const n = Number(input.value);
        if (!Number.isFinite(n) || n < 0) { input.value = String(m.timesing ?? 1); return; }
        recordTakeoffHistory();
        m.timesing = n;
      } else if (input.dataset.signFor) {
        recordTakeoffHistory();
        m.sign = input.value === '-1' ? -1 : 1;
      } else if (input.dataset.remarksFor) {
        recordTakeoffHistory();
        m.remarks = input.value;
      } else if (input.dataset.parameterKeyFor) {
        const oldKey = input.dataset.parameterKey ?? '';
        const value = m.parameters?.[oldKey] ?? '';
        const key = input.value.trim();
        if (!key) { input.value = oldKey; return; }
        if (key !== oldKey && m.parameters) {
          recordTakeoffHistory();
          delete m.parameters[oldKey];
          m.parameters[key] = value;
        }
      } else if (input.dataset.parameterValueFor) {
        recordTakeoffHistory();
        if (m.parameters) m.parameters[input.dataset.parameterKey ?? ''] = input.value;
      } else if (input.dataset.formulaFor) {
        recordTakeoffHistory();
        const formula = input.value.trim();
        if (formula) m.formula = formula;
        else delete m.formula;
      } else if (input.dataset.itemCodeFor) {
        recordTakeoffHistory();
        m.itemCode = input.value.trim() || undefined;
      } else if (input.dataset.parentFor) {
        const parentId = input.value || undefined;
        let cursor = parentId;
        const seen = new Set([m.id]);
        while (cursor) {
          if (seen.has(cursor)) {
            input.value = m.parentId ?? '';
            return;
          }
          seen.add(cursor);
          cursor = state.markups.find((item) => item.id === cursor)?.parentId;
        }
        recordTakeoffHistory();
        if (parentId) m.parentId = parentId;
        else delete m.parentId;
      } else if (input.dataset.strokeWidthFor || input.dataset.strokeOpacityFor || input.dataset.fillOpacityFor) {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        recordTakeoffHistory();
        if (input.dataset.strokeWidthFor) m.strokeWidth = Math.max(0.25, Math.min(12, value));
        if (input.dataset.strokeOpacityFor) m.strokeOpacity = Math.max(0, Math.min(1, value));
        if (input.dataset.fillOpacityFor) m.fillOpacity = Math.max(0, Math.min(1, value));
      } else if (input.dataset.lineStyleFor) {
        recordTakeoffHistory();
        m.lineStyle = input.value as 'solid' | 'dashed' | 'dotted';
      } else if (input.dataset.linkVariableFor) {
        const index = Number(input.dataset.linkIndex);
        const duplicate = m.links?.some((link, i) => i !== index && (link.variable || String.fromCharCode(65 + i)) === input.value);
        if (duplicate) {
          input.value = m.links?.[index]?.variable || String.fromCharCode(65 + index);
          return;
        }
        recordTakeoffHistory();
        if (m.links?.[index]) m.links[index].variable = input.value;
      } else if (input.dataset.linkTargetFor) {
        recordTakeoffHistory();
        const index = Number(input.dataset.linkIndex);
        if (m.links?.[index]) m.links[index].markupId = input.value;
      } else if (input.dataset.linkLogicFor) {
        recordTakeoffHistory();
        const index = Number(input.dataset.linkIndex);
        if (m.links?.[index]) {
          const logic = input.value.trim();
          if (logic) m.links[index].logic = logic;
          else {
            delete m.links[index].logic;
            delete m.links[index].relation;
            delete m.links[index].note;
          }
        }
      }
      syncUpsertMarkup(m);
      emit();
      return;
    }
    if (input.dataset.colorFor) {
      const m = state.markups.find((x) => x.id === input.dataset.colorFor);
      if (m && !isLockedLayer(layerOf(m))) {
        recordTakeoffHistory();
        m.color = input.value.toLowerCase();
        syncUpsertMarkup(m);
        emit();
      }
      return;
    }
    if (input.dataset.labelFor) {
      const m = state.markups.find((x) => x.id === input.dataset.labelFor);
      if (m && !isLockedLayer(layerOf(m))) {
        recordTakeoffHistory();
        m.label = input.value.trim() || defaultLabel(m.type);
        syncUpsertMarkup(m);
        emit();
      }
    }
  });

  const changeVisibility = (predicate: (m: typeof state.markups[number]) => boolean, visible: boolean) => {
    const affected = state.markups.filter(predicate).filter((m) => (m.visible !== false) !== visible);
    if (!affected.length) return;
    recordTakeoffHistory();
    for (const m of affected) {
      m.visible = visible;
      syncUpsertMarkup(m);
    }
    emit();
  };
  document.getElementById('hideAllMarkupsBtn')?.addEventListener('click', () => {
    changeVisibility(() => true, false);
  });
  document.getElementById('showAllMarkupsBtn')?.addEventListener('click', () => {
    changeVisibility(() => true, true);
  });
  document.getElementById('hideOtherMarkupsBtn')?.addEventListener('click', () => {
    if (!state.selectedId) return;
    changeVisibility((m) => m.id !== state.selectedId, false);
    const selected = state.markups.find((m) => m.id === state.selectedId);
    if (selected && selected.visible === false) {
      recordTakeoffHistory();
      selected.visible = true;
      syncUpsertMarkup(selected);
      emit();
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
    recordTakeoffHistory();
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
    if (locked) tr.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button:not([data-visibility-for])').forEach((control) => { control.disabled = true; });
    tbody.appendChild(tr);
  } else if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="empty">No measurements match the filter.</td>`;
    tbody.appendChild(tr);
  }
  for (const m of rows) {
    const tr = document.createElement('tr');
    const locked = isLockedLayer(layerOf(m));
    tr.dataset.id = m.id;
    if (m.id === state.selectedId) tr.classList.add('selected');
    if (m.visible === false) tr.classList.add('markup-hidden');
    if (m.parentId) tr.classList.add('sub-item');
    const quantity = quantityForMarkup(m, state.markups, calibrationForMarkup);
    const formulaVars = (m.links ?? []).map((link, index) => link.variable || String.fromCharCode(65 + index));
    const formulaValid = !m.formula || formulaUsesOnlyVars(m.formula, formulaVars);
    const { value } = valueParts(m, calibrationForMarkup(m), state.displayUnit, quantity);
    const typeIcon =
      m.type === 'length' ? '📏' : m.type === 'area' ? '⬡' : m.type === 'count' ? '🔢'
      : m.type === 'perimeter' ? '↻' : m.type === 'volume' ? '◨' : m.type === 'note' ? '💬' : '∠';
    tr.innerHTML = `
      <td class="cell-label"><input data-label-for="${m.id}" value="${escapeAttr(m.label)}" title="Rename" /></td>
      <td class="cell-type"><span class="tag tag-${m.type}" title="${m.type}">${typeIcon} <span class="tag-word">${m.type}</span></span><input class="markup-color" type="color" data-color-for="${m.id}" value="${m.color || COLORS[m.type] || '#333333'}" title="Set colour (default is automatic)" aria-label="Colour for ${escapeAttr(m.label)}" /></td>
      <td class="cell-num">p${m.page}</td>
      <td class="cell-measure">${value ? `${escapeHtml(formatMarkupValue(m, calibrationForMarkup(m), state.displayUnit, quantity))}` : '<span class="warn">not calibrated</span>'}</td>
      <td class="cell-status"><button data-status-for="${m.id}" class="status-btn st-${m.status ?? 'none'}" title="${m.status === 'check' ? 'Needs checking — click to confirm' : m.status === 'confirmed' ? 'Confirmed — click to clear' : 'Click to mark for checking'}">${m.status === 'check' ? '⚑' : m.status === 'confirmed' ? '✓' : '○'}</button></td>
      <td class="cell-del"><button data-visibility-for="${m.id}" title="${m.visible === false ? 'Show on drawing' : 'Hide on drawing'}">${m.visible === false ? '◉' : '◌'}</button><button data-clone-for="${m.id}" title="Independent copy">⧉</button><button data-linked-clone-for="${m.id}" title="Linked copy (shares geometry)">↗</button><button data-del="${m.id}" title="Delete">✕</button></td>`;
    tbody.appendChild(tr);
    const detail = document.createElement('tr');
    detail.className = 'markup-detail-row';
    detail.innerHTML = `<td colspan="6"><details class="markup-details" data-detail-for="${m.id}" ${expandedIds.has(m.id) ? 'open' : ''}>
      <summary>QS details · timesing, dimensions, remarks and linked take-off</summary>
      <div class="markup-detail-grid">
        <label>Timesing <input type="number" min="0" step="0.01" data-timesing-for="${m.id}" value="${m.timesing ?? 1}"></label>
        <label>Sign <select data-sign-for="${m.id}"><option value="1" ${(m.sign ?? 1) > 0 ? 'selected' : ''}>+ Add</option><option value="-1" ${m.sign === -1 ? 'selected' : ''}>− Deduct</option></select></label>
        <label class="wide">Remarks <input type="text" data-remarks-for="${m.id}" value="${escapeAttr(m.remarks ?? '')}" placeholder="Location, drawing reference, specification…"></label>
        <label>Item code <input type="text" data-item-code-for="${m.id}" value="${escapeAttr(m.itemCode ?? '')}" placeholder="e.g. 2.1.3"></label>
        <label>Parent item <select data-parent-for="${m.id}"><option value="">No parent (top-level)</option>${state.markups.filter((item) => item.id !== m.id).map((item) => `<option value="${item.id}" ${item.id === m.parentId ? 'selected' : ''}>${escapeAttr(item.itemCode ? item.itemCode + ' · ' + item.label : item.label)} · p${item.page}</option>`).join('')}</select></label>
        <label>Line width <input type="number" min="0.25" max="12" step="0.25" data-stroke-width-for="${m.id}" value="${m.strokeWidth ?? 1.6}"></label>
        <label>Line opacity <input type="number" min="0" max="1" step="0.05" data-stroke-opacity-for="${m.id}" value="${m.strokeOpacity ?? 1}"></label>
        <label>Fill opacity <input type="number" min="0" max="1" step="0.05" data-fill-opacity-for="${m.id}" value="${m.fillOpacity ?? 0.13}"></label>
        <label>Line type <select data-line-style-for="${m.id}"><option value="solid" ${(m.lineStyle ?? 'solid') === 'solid' ? 'selected' : ''}>Solid</option><option value="dashed" ${m.lineStyle === 'dashed' ? 'selected' : ''}>Dashed</option><option value="dotted" ${m.lineStyle === 'dotted' ? 'selected' : ''}>Dotted</option></select></label>
      </div>
      <button type="button" data-apply-style-for="${m.id}">Apply style to all ${m.type} measurements</button>
      <div class="markup-parameters"><b>Dimensions / attributes</b>
        ${Object.entries(m.parameters ?? {}).map(([key, val]) => `<div class="markup-param"><input aria-label="Parameter name" data-parameter-key-for="${m.id}" data-parameter-key="${escapeAttr(key)}" value="${escapeAttr(key)}"><input aria-label="Parameter value" data-parameter-value-for="${m.id}" data-parameter-key="${escapeAttr(key)}" value="${escapeAttr(val)}" placeholder="e.g. 900 mm or 0.9 m"><button type="button" data-remove-param="${m.id}::${escapeAttr(key)}" title="Remove parameter">×</button></div>`).join('')}
        <button type="button" class="btn quiet" data-add-param-for="${m.id}">+ Add attribute</button>
      </div>
      <div class="markup-links"><b>Linked take-off</b>
        ${(m.links ?? []).map((link, index) => `<div class="markup-link"><label class="link-variable">Variable <select data-link-variable-for="${m.id}" data-link-index="${index}">${Array.from({length:26},(_,i)=>String.fromCharCode(65+i)).map((v)=>`<option value="${v}" ${v === (link.variable || String.fromCharCode(65 + index)) ? 'selected' : ''}>${v}</option>`).join('')}</select></label><select data-link-target-for="${m.id}" data-link-index="${index}">${state.markups.filter((x) => x.id !== m.id).map((x) => `<option value="${x.id}" ${x.id === link.markupId ? 'selected' : ''}>${escapeAttr(x.label)} · p${x.page}</option>`).join('')}</select><input type="text" aria-label="Relationship note" data-link-logic-for="${m.id}" data-link-index="${index}" value="${escapeAttr(link.logic ?? link.note ?? link.relation ?? '')}" placeholder="Optional note"><button type="button" data-remove-link="${m.id}::${index}" title="Remove link">×</button></div>`).join('')}
        <label class="wide">Quantity formula <input type="text" class="${m.formula && !formulaValid ? 'invalid' : ''}" data-formula-for="${m.id}" value="${escapeAttr(m.formula ?? '')}" placeholder="A-B-C" title="Use linked measurement variables A, B, C… and + - * / % parentheses"></label>
        <small>Linked values update live. A, B, C… refer to the linked measurements above. Example: A-B-C deducts openings from a wall quantity. Formula cycles or missing links are flagged as unavailable. Use compatible units.</small>
        <button type="button" class="btn quiet" data-add-link-for="${m.id}" ${state.markups.length < 2 || (m.links ?? []).length >= Math.min(26, state.markups.length - 1) ? 'disabled' : ''}>+ Link to another measurement</button>
      </div>
      <small>Adjusted quantity = measured quantity × timesing × sign. Defaults for older projects are 1 and +.</small>
    </details></td>`;
    if (locked) detail.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button').forEach((control) => { control.disabled = true; });
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
    const { total, uncalibrated } = groupTotal(g, calibrationForMarkup, state.markups);
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
