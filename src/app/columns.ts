// Custom columns editor: named formulas over each row/group quantity
// (value, count) — waste factors, rates — shown in the totals panel and
// written into every export. Persisted globally like tool presets.

import { state, emit } from './state';
import { saveColumns } from './persistence';
import { formulaUsesOnlyVars } from '../engine/formula';
import { evaluateFormula } from '../engine/formula';


let box: HTMLElement | null = null;

export function initColumns(): void {
  box = document.getElementById('columnsBox');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.id === 'columnAdd') addRow();
    const del = target.closest('[data-del-col]');
    if (del) {
      state.columns.splice(Number(del.getAttribute('data-del-col')), 1);
      void saveColumns(state.columns);
      renderColumns();
      emit();
    }
  });
  box.addEventListener('change', () => syncFromInputs());
  renderColumns();
}

function addRow(): void {
  state.columns.push({ name: '', formula: '', unit: '' });
  renderColumns();
  const inputs = box!.querySelectorAll<HTMLInputElement>('.col-name');
  inputs[inputs.length - 1]?.focus();
}

function syncFromInputs(): void {
  const rows = [...box!.querySelectorAll('.col-row')];
  state.columns = rows.map((row, i) => ({
    name: (row.querySelector('.col-name') as HTMLInputElement).value.trim() || `Column ${i + 1}`,
    formula: (row.querySelector('.col-formula') as HTMLInputElement).value.trim(),
    unit: (row.querySelector('.col-unit') as HTMLInputElement).value.trim(),
  }));
  void saveColumns(state.columns);
  emit();
}

export function renderColumns(): void {
  if (!box) return;
  const rows = document.getElementById('columnRows')!;
  rows.replaceChildren();
  state.columns.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'col-row';
    const valid = formulaUsesOnlyVars(c.formula, ['value', 'count']);
    div.innerHTML = `
      <input class="col-name" placeholder="Name (e.g. Waste +10%)" value="${escapeAttr(c.name)}" />
      <input class="col-formula ${c.formula && !valid ? 'invalid' : ''}" placeholder="value * 1.1" value="${escapeAttr(c.formula)}" title="Vars: value (the quantity), count" />
      <input class="col-unit" placeholder="unit" value="${escapeAttr(c.unit)}" />
      <button class="preset-del" data-del-col="${i}" title="Remove column">✕</button>`;
    rows.appendChild(div);
  });
}

/** Computed custom values for one group, for the totals panel. */
export function columnValuesFor(value: number | null, count: number): { name: string; text: string }[] {
  return state.columns.map((c) => {
    const out = evaluateFormula(c.formula, { value: value ?? 0, count });
    const num = out === null ? null : Math.round(out * 100) / 100;
    return { name: c.name || '—', text: num === null ? 'ERR' : `${num}${c.unit ? ' ' + c.unit : ''}` };
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
