// ⌘K / Ctrl+K: one search over every tool, the file and export actions, the
// panel views, the units and the takeoff's own labels (choosing a label
// selects its quantity row, so its markups light up on the drawing).

import { state, emit, type ToolId } from './state';
import { setTool } from './tools';
import { groupKey } from './table';
import { hasDoc, fitWidth, setZoom } from './viewer';
import { showView, closeMenus } from './chrome';

interface Command {
  title: string;
  group: string;
  key?: string;
  run: () => void;
}

const TOOLS: [ToolId, string, string][] = [
  ['pan', 'Pan', 'V'],
  ['calibrate', 'Set scale', 'C'],
  ['viewport', 'Viewport (a region at another scale)', 'W'],
  ['length', 'Length', 'L'],
  ['area', 'Area', 'A'],
  ['fill', 'Fill a room', 'D'],
  ['perimeter', 'Perimeter', 'P'],
  ['volume', 'Volume', 'O'],
  ['angle', 'Angle', 'G'],
  ['count', 'Count', 'N'],
  ['scan', 'Scan (count every match)', 'S'],
  ['note', 'Note', 'T'],
];

const click = (id: string) => () => (document.getElementById(id) as HTMLButtonElement | null)?.click();

function commands(): Command[] {
  const open = hasDoc();
  const list: Command[] = [];
  if (open) for (const [tool, title, key] of TOOLS) list.push({ title, key, group: 'Tool', run: () => setTool(tool) });
  list.push({ title: 'Open a drawing', group: 'File', run: click('openBtn') });
  if (open) {
    list.push(
      { title: 'Export to Excel', group: 'Export', run: click('exportXlsxBtn') },
      { title: 'Export CSV', group: 'Export', run: click('exportCsvBtn') },
      { title: 'Copy for a spreadsheet', group: 'Export', run: click('copyTsvBtn') },
      { title: 'Printable report', group: 'Export', run: click('reportBtn') },
      { title: 'Save into the PDF', group: 'Export', run: click('savePdfBtn') },
      { title: 'Fit width', key: 'F', group: 'View', run: fitWidth },
      { title: 'Zoom in', key: '+', group: 'View', run: () => setZoom(state.zoom * 1.25) },
      { title: 'Zoom out', key: '−', group: 'View', run: () => setZoom(state.zoom / 1.25) },
      { title: 'Show quantities', group: 'Panel', run: () => showView('tabQty') },
      { title: 'Show markups list', group: 'Panel', run: () => showView('tabMarkups') },
      { title: 'Show tool library, columns and layers', group: 'Panel', run: () => showView('tabLibrary') },
      { title: 'Live session', group: 'Share', run: click('sessionBtn') },
    );
    const units = document.getElementById('unitSelect') as HTMLSelectElement | null;
    for (const o of units ? [...units.options] : []) {
      list.push({
        title: `Units: ${o.textContent}`,
        group: 'Units',
        run: () => {
          units!.value = o.value;
          units!.dispatchEvent(new Event('change'));
        },
      });
    }
  }
  list.push({ title: 'Compare two revisions', group: 'File', run: click('compareBtn') }, { title: 'Watch the demo', group: 'Help', run: click('demoBtn') });
  // the takeoff's own labels, one per quantity row
  const seen = new Set<string>();
  for (const m of state.markups) {
    const key = groupKey(m);
    if (seen.has(key) || m.type === 'note') continue;
    seen.add(key);
    const n = state.markups.filter((x) => groupKey(x) === key).length;
    list.push({
      title: m.label,
      key: `${n} ${m.type}`,
      group: 'Markups',
      run: () => {
        showView('tabQty');
        state.focusLabel = key;
        state.selectedId = null;
        if (!state.markups.some((x) => x.page === state.pageNum && groupKey(x) === key)) state.pageNum = m.page;
        emit();
      },
    });
  }
  return list;
}

/** Subsequence match, scored: word starts and runs count most, shorter titles win ties. */
function score(title: string, query: string): number {
  if (!query) return 1;
  const t = title.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  let at = -1;
  let total = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return 0;
    const wordStart = next === 0 || /[\s(:,-]/.test(t[next - 1]);
    run = next === at + 1 ? run + 1 : 0;
    total += 1 + (wordStart ? 3 : 0) + run * 2;
    at = next;
  }
  if (t.startsWith(q)) total += 6;
  return total - title.length * 0.01;
}

let dialog: HTMLElement;
let input: HTMLInputElement;
let listEl: HTMLElement;
let shown: Command[] = [];
let active = 0;
let returnFocus: HTMLElement | null = null;

function render(): void {
  const q = input.value;
  shown = commands()
    .map((c) => ({ c, s: score(c.title, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.c);
  active = Math.min(active, Math.max(0, shown.length - 1));
  listEl.replaceChildren(
    ...shown.map((c, i) => {
      const row = document.createElement('div');
      row.className = 'cmdk-item';
      row.id = `cmdk-opt-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === active));
      const title = document.createElement('span');
      title.className = 't';
      title.textContent = c.title;
      const group = document.createElement('span');
      group.className = 'g';
      group.textContent = c.group;
      row.append(title, group);
      if (c.key) {
        const k = document.createElement('kbd');
        k.textContent = c.key;
        row.append(k);
      }
      row.addEventListener('mousemove', () => {
        if (active !== i) {
          active = i;
          mark();
        }
      });
      row.addEventListener('click', () => runAt(i));
      return row;
    }),
  );
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'cmdk-empty';
    empty.textContent = 'Nothing matches. Try a tool name, an export, or one of your labels.';
    listEl.append(empty);
  }
  mark();
}

function mark(): void {
  [...listEl.querySelectorAll('.cmdk-item')].forEach((el, i) => el.setAttribute('aria-selected', String(i === active)));
  if (shown.length) {
    input.setAttribute('aria-activedescendant', `cmdk-opt-${active}`);
    document.getElementById(`cmdk-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function runAt(i: number): void {
  const c = shown[i];
  if (!c) return;
  close(false);
  c.run();
}

export function openCmdk(): void {
  if (!dialog.classList.contains('hidden')) return;
  closeMenus();
  returnFocus = document.activeElement as HTMLElement | null;
  input.value = '';
  active = 0;
  dialog.classList.remove('hidden');
  render();
  input.focus();
}

function close(refocus = true): void {
  dialog.classList.add('hidden');
  if (refocus) returnFocus?.focus();
}

export function initCmdk(): void {
  dialog = document.createElement('div');
  dialog.id = 'cmdk';
  dialog.className = 'hidden';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Search tools and markups');
  dialog.innerHTML = `
    <div class="cmdk-card">
      <div class="cmdk-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></svg>
        <input id="cmdkInput" type="text" role="combobox" aria-expanded="true" aria-controls="cmdkList" aria-autocomplete="list" aria-label="Search tools, actions and markups" placeholder="Search tools, actions and markups" autocomplete="off" spellcheck="false" />
      </div>
      <div class="cmdk-list" id="cmdkList" role="listbox" aria-label="Results"></div>
      <div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>
    </div>`;
  document.body.append(dialog);
  input = dialog.querySelector('input')!;
  listEl = dialog.querySelector('.cmdk-list')!;

  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
    e.stopPropagation(); // typing here is not a tool shortcut
  });
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) close();
  });
  document.getElementById('cmdkBtn')?.addEventListener('click', openCmdk);
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k' && !document.body.classList.contains('landing')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (dialog.classList.contains('hidden')) openCmdk();
        else close();
      }
    },
    true,
  );
}
