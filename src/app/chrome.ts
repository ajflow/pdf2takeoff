// The Flow State chrome around the drawing: the top bar's menus, the panel's
// three views, the hint pill (every hint() and status message lands in
// #toolHint; the pill shows it, then fades) and the scale chip, which says
// whether to trust the scale.

import { state, calibrationFor, ratioOn } from './state';

const $ = (id: string) => document.getElementById(id)!;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// --- menus ---------------------------------------------------------------------

const closers: (() => void)[] = [];

export function closeMenus(): void {
  for (const close of closers) close();
}

function bindMenu(buttonId: string, menuId: string): void {
  const button = $(buttonId);
  const menu = $(menuId);
  const items = () => [...menu.querySelectorAll<HTMLElement>('button.menu-item, .menu-field select')].filter((el) => !(el as HTMLButtonElement).disabled);
  const close = (refocus = false) => {
    if (menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  };
  const open = () => {
    closeMenus();
    // proxy items (the top bar's Export) mirror their real buttons
    menu.querySelectorAll<HTMLButtonElement>('[data-proxy]').forEach((item) => {
      item.disabled = (document.getElementById(item.dataset.proxy!) as HTMLButtonElement | null)?.disabled ?? false;
    });
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  };
  closers.push(() => close());
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) open();
    else close();
  });
  // an item's own handler runs first, then the menu closes
  menu.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button.menu-item')) close();
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if ((document.activeElement as HTMLElement)?.tagName === 'SELECT') return;
      e.preventDefault();
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target as Node)) close();
  });
}

// --- the panel's views ------------------------------------------------------------

const TABS: [string, string][] = [
  ['tabQty', 'viewQty'],
  ['tabMarkups', 'viewMarkups'],
  ['tabLibrary', 'viewLibrary'],
];

export function showView(tabId: 'tabQty' | 'tabMarkups' | 'tabLibrary'): void {
  for (const [tab, view] of TABS) {
    const on = tab === tabId;
    $(tab).setAttribute('aria-selected', String(on));
    $(tab).tabIndex = on ? 0 : -1;
    ($(view) as HTMLElement).hidden = !on;
  }
}

function bindTabs(): void {
  TABS.forEach(([tab], i) => {
    $(tab).addEventListener('click', () => showView(tab as 'tabQty'));
    $(tab).addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0];
      showView(next as 'tabQty');
      $(next).focus();
    });
  });
}

// --- the hint pill ------------------------------------------------------------------

function bindHintPill(): void {
  const text = $('toolHint');
  const pill = $('hintPill');
  let timer = 0;
  const show = () => {
    const t = text.textContent?.trim() ?? '';
    window.clearTimeout(timer);
    if (!t) {
      pill.classList.remove('show');
      return;
    }
    pill.classList.add('show');
    timer = window.setTimeout(() => pill.classList.remove('show'), t.length > 80 ? 7000 : 4000);
  };
  new MutationObserver(show).observe(text, { childList: true, characterData: true, subtree: true });
}

export function initChrome(): void {
  bindMenu('moreBtn', 'moreMenu');
  bindMenu('exportMenuBtn', 'exportMenu');
  bindMenu('exportMoreBtn', 'exportMoreMenu');
  document.querySelectorAll<HTMLButtonElement>('[data-proxy]').forEach((item) => {
    item.addEventListener('click', () => document.getElementById(item.dataset.proxy!)?.click());
  });
  bindTabs();
  bindHintPill();
  // the shortcut hint follows the platform
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('cmdkKey').textContent = 'Ctrl K';
}

// --- the scale chip ---------------------------------------------------------------------

const TICK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
const ALERT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>';

/** Where a calibration came from, in the words an estimator would use. */
function sourceText(source: string): string {
  if (/\(sheet\)$/.test(source)) return 'from title block';
  if (/^drawing units/.test(source)) return /assumed/.test(source) ? 'units assumed' : 'from drawing units';
  if (/^measured |demo/.test(source)) return 'from a dimension';
  if (/^preset /.test(source)) return 'set by hand';
  if (/^printed dimensions/.test(source)) return 'from dimensions';
  return 'set';
}

export function renderScaleChip(open: boolean): void {
  const chip = $('scaleBadge');
  chip.className = 'scale-chip';
  if (!open) {
    chip.classList.add('idle');
    chip.textContent = 'Scale';
    chip.removeAttribute('title');
    return;
  }
  const page = state.pageNum;
  const cal = calibrationFor(page);
  if (!cal) {
    chip.classList.add('unset');
    chip.innerHTML = 'Set scale <kbd>C</kbd>';
    chip.title = 'No scale on this page yet: click (or press C), then click both ends of a dimension you know';
    return;
  }
  const ratio = ratioOn(page, cal.metersPerPt);
  const pretty = ratio === null ? 'Scale set' : Math.abs(ratio - Math.round(ratio)) < 0.5 ? `1:${Math.round(ratio)}` : `1:${ratio.toFixed(0)}*`;
  const check = state.scaleChecks.get(page);
  let src = sourceText(cal.source);
  let icon = '';
  if (check?.status === 'agrees') {
    src = 'matches title block';
    icon = TICK;
  } else if (check?.status === 'doors-ok') {
    src = 'doors check out';
    icon = TICK;
  } else if (check?.status === 'dims-ok') {
    src = 'dimensions check out';
    icon = TICK;
  } else if (check) {
    chip.classList.add('warn');
    src = 'check scale';
    icon = ALERT;
  }
  chip.innerHTML = `${icon}<b>${esc(pretty)}</b><span class="src">${esc(src)}</span>`;
  chip.title = check?.message ?? `Scale ${pretty}, ${src}. Click to set it again.`;
}
