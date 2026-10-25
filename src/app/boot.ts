// The page's entry point. The homepage needs almost no code of its own, so
// this file runs it: the landing buttons, drag and drop, paste, and the
// homepage's dither moments. The app itself (pdf.js, OCR, the tools, about
// 400 kB) is a separate chunk, loaded the moment someone opens a file, tries
// the sample, starts the demo or drops or pastes a file, and prefetched once
// the page has settled so opening a drawing still feels instant.

import './styles.css';
import './flowstate.css';

type App = typeof import('./main');
let app: Promise<App> | null = null;
const loadApp = (): Promise<App> => (app ??= import('./main'));

const $ = (id: string) => document.getElementById(id);

/** While the app is still on its way, say so on the button that was pressed (a slow phone can take a moment). */
async function busy(target: HTMLElement | (() => HTMLElement | null) | null, run: (a: App) => Promise<void> | void): Promise<void> {
  let restore = () => {};
  const ready = await Promise.race([loadApp().then(() => true), new Promise((r) => setTimeout(() => r(false), 120))]);
  const el = ready ? null : typeof target === 'function' ? target() : target;
  if (el) {
    const label = el.textContent;
    const wasHidden = el.hidden;
    el.textContent = 'Opening…';
    el.hidden = false;
    el.setAttribute('aria-busy', 'true');
    // put back only what we changed: the app may have written its own message meanwhile
    restore = () => {
      el.removeAttribute('aria-busy');
      if (el.textContent !== 'Opening…') return;
      el.textContent = label;
      el.hidden = wasHidden;
    };
  }
  try {
    await run(await loadApp());
  } finally {
    restore();
  }
}
const fileInput = $('fileInput') as HTMLInputElement;
const dropzone = $('dropzone');

// opening files: the picker opens straight away (it needs the click's user
// gesture); the app loads while the person chooses
fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = '';
  if (files.length) void busy(landingNote, (a) => a.openFiles(files));
});

/** The landing page's message line says a dropped or chosen drawing is opening. */
const landingNote = (): HTMLElement | null => (document.body.classList.contains('landing') ? $('openNote') : null);
for (const id of ['openBtn', 'openBtnHero', 'openBtnHeroMain', 'openBtnHeader', 'openBtnClose']) {
  $(id)?.addEventListener('click', () => {
    void loadApp();
    fileInput.click();
  });
}
for (const id of ['sampleBtnHero', 'sampleBtnClose']) $(id)?.addEventListener('click', (e) => void busy(e.currentTarget as HTMLElement, (a) => a.openSample()));
for (const id of ['demoBtnHero', 'demoBtn']) $(id)?.addEventListener('click', (e) => void busy(e.currentTarget as HTMLElement, (a) => a.startDemo()));

$('scrollCue')?.addEventListener('click', (e) => {
  e.preventDefault();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('how')?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
});

// drag and drop anywhere on the page (landing and app alike), and paste a
// screenshot or a copied image (not while typing in a field)
for (const evt of ['dragover', 'dragenter'] as const) {
  addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone?.classList.add('drag');
    void loadApp(); // get ready while the file is still in the air
  });
}
for (const evt of ['dragleave', 'drop'] as const) {
  addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone?.classList.remove('drag');
  });
}
addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) void busy(landingNote, (a) => a.openFiles(files));
});
addEventListener('paste', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  void busy(landingNote, (a) => a.openFiles(files));
});

// a deep link that opens a drawing (?file=/examples/…) needs the app now
if (new URLSearchParams(location.search).has('file')) void loadApp();

// once the page has settled: the homepage's dither moments, then the app in
// the background, behind a pointer heading for a button if that comes first
const idle = (fn: () => void, timeout: number) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, timeout / 2));
idle(() => {
  if (document.body.classList.contains('landing')) void import('./fx/home').then((m) => m.initHome());
}, 2500);
addEventListener('load', () => setTimeout(() => idle(() => void loadApp(), 4000), 2500));
for (const id of ['openBtnHero', 'openBtnHeroMain', 'sampleBtnHero', 'demoBtnHero', 'openBtnHeader']) {
  $(id)?.addEventListener('pointerenter', () => void loadApp(), { once: true });
}

// the landing is live (tests wait on this before clicking)
document.documentElement.dataset.boot = 'ready';
