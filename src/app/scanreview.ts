// Review-first scan: a scan proposes, a person decides. Every hit lands as a
// count markup marked 'check' (so it round-trips in the PDF as needing a
// look), and a card over the canvas offers Keep all, Review and Undo.
//
// Doubtful hits, per provider, from what each one's score means:
//   detector (ONNX)  the detector's own confidence: under 0.5 is doubtful
//   vector           exact matches on the drawing's own geometry (score 1):
//                    none are doubtful
//   cv               no per-hit score reaches the app (the template match
//                    keeps its distances to itself): none are doubtful, and
//                    Review steps through every hit instead
// Keep all confirms the hits that aren't doubtful; doubtful ones stay
// 'check' and keep their human-signal ring until someone looks. Dismissing
// the card (Esc, another tool) decides nothing: the plain hits go back to
// unmarked, as scans were before, and the doubtful ones stay flagged.

import { state, emit, subscribe, type Markup } from './state';
import { renderMarkups, scanStyle } from './render';
import { syncUpsertMarkup, syncDeleteMarkup } from './session';
import { pdfToView, viewSize, isTypingTarget } from './viewer';
import type { ScanHit } from '../engine/types';

type Provider = 'cv' | 'detector' | 'vector';

interface Session {
  ids: string[];
  doubtful: Set<string>;
  label: string;
  ms: number;
  /** Review mode: the hits being stepped through, and where we are. */
  review: { ids: string[]; at: number } | null;
}

let session: Session | null = null;
const $ = (id: string) => document.getElementById(id)!;

export function isDoubtful(hit: ScanHit, provider: Provider): boolean {
  return provider === 'detector' && (hit.score ?? 1) < 0.5;
}

const live = (): Markup[] => (session ? state.markups.filter((m) => session!.ids.includes(m.id)) : []);

function update(m: Markup, status: Markup['status']): void {
  m.status = status;
  syncUpsertMarkup(m);
}

/** Open the card for a scan's freshly added hits (markups already in state). */
export function openScanReview(hits: Markup[], doubtful: Set<string>, ms: number, exampleId: string | null): void {
  if (session) dismiss();
  session = { ids: hits.map((m) => m.id), doubtful, label: hits[0]?.label ?? '', ms, review: null };
  scanStyle.quiet = new Set(hits.filter((m) => !doubtful.has(m.id)).map((m) => m.id));
  scanStyle.example = exampleId;
  scanStyle.reviewing = null;
  render();
  renderMarkups();
}

function close(): void {
  session = null;
  scanStyle.quiet.clear();
  scanStyle.example = null;
  scanStyle.reviewing = null;
  $('scanCard').classList.add('hidden');
  renderMarkups();
  emit();
}

function keepAll(): void {
  for (const m of live()) if (!session!.doubtful.has(m.id)) update(m, 'confirmed');
  close();
}

function undo(): void {
  for (const m of live()) syncDeleteMarkup(m.id);
  const ids = new Set(session!.ids);
  state.markups = state.markups.filter((m) => !ids.has(m.id));
  close();
}

/** Decide nothing: plain hits back to unmarked, doubtful ones stay flagged. */
export function dismiss(): void {
  if (!session) return;
  for (const m of live()) if (!session.doubtful.has(m.id) && m.status === 'check') update(m, undefined);
  close();
}

function startReview(): void {
  const s = session!;
  const ids = (s.doubtful.size ? [...s.doubtful] : s.ids).filter((id) => state.markups.some((m) => m.id === id));
  if (!ids.length) return keepAll();
  s.review = { ids, at: 0 };
  show();
}

/** Bring the current hit into view and ring it. */
function show(): void {
  const r = session!.review!;
  const m = state.markups.find((x) => x.id === r.ids[r.at]);
  if (!m) return;
  if (m.page !== state.pageNum) {
    state.pageNum = m.page;
    emit();
  }
  scanStyle.reviewing = m.id;
  const sc = $('scrollContainer');
  const wrap = $('pageWrap');
  // view units are the page at 100%: scale them by the zoom to get pixels
  const v = pdfToView(m.points[0]);
  const k = wrap.clientWidth / (viewSize().w || 1);
  sc.scrollTo({ left: wrap.offsetLeft + v.x * k - sc.clientWidth / 2, top: wrap.offsetTop + v.y * k - sc.clientHeight / 2, behavior: 'smooth' });
  render();
  renderMarkups();
}

function decide(keep: boolean): void {
  const s = session!;
  const r = s.review!;
  const id = r.ids[r.at];
  const m = state.markups.find((x) => x.id === id);
  if (m) {
    if (keep) update(m, 'confirmed');
    else {
      state.markups = state.markups.filter((x) => x.id !== id);
      syncDeleteMarkup(id);
      s.ids = s.ids.filter((x) => x !== id);
    }
  }
  s.doubtful.delete(id);
  r.ids.splice(r.at, 1);
  if (!r.ids.length) return keepAll(); // everything looked at: the rest are kept
  r.at = Math.min(r.at, r.ids.length - 1);
  emit();
  show();
}

function move(step: number): void {
  const r = session!.review!;
  r.at = (r.at + step + r.ids.length) % r.ids.length;
  show();
}

function endReview(): void {
  session!.review = null;
  scanStyle.reviewing = null;
  render();
  renderMarkups();
}

function render(): void {
  const s = session!;
  const n = live().length;
  $('scanCard').classList.remove('hidden');
  $('scanCount').textContent = String(n);
  $('scanLabel').textContent = s.label;
  const doubt = [...s.doubtful].filter((id) => s.ids.includes(id)).length;
  const chk = $('scanCheck');
  chk.classList.toggle('hidden', !doubt || !!s.review);
  chk.querySelector('span')!.textContent = `${doubt} to check`;
  if (s.review) {
    $('scanMeta').textContent = `Checking ${s.review.at + 1} of ${s.review.ids.length}: Enter keeps, Delete removes`;
    $('scanUndo').textContent = 'Done';
    $('scanReview').textContent = 'Remove';
    $('scanKeep').textContent = 'Keep';
  } else {
    $('scanMeta').textContent = `found in ${s.ms} ms`;
    $('scanUndo').textContent = 'Undo';
    $('scanReview').textContent = 'Review';
    $('scanKeep').textContent = 'Keep all';
  }
}

function rename(label: string): void {
  const s = session!;
  const next = label.trim();
  if (!next || next === s.label) return;
  s.label = next;
  for (const m of live()) {
    m.label = next;
    syncUpsertMarkup(m);
  }
  emit();
}

export function initScanReview(): void {
  $('scanKeep').addEventListener('click', () => (session?.review ? decide(true) : keepAll()));
  $('scanReview').addEventListener('click', () => (session?.review ? decide(false) : startReview()));
  $('scanUndo').addEventListener('click', () => (session?.review ? endReview() : undo()));

  // click the label to rename every hit of this scan
  const label = $('scanLabel');
  const input = $('scanLabelInput') as HTMLInputElement;
  const finish = (commit: boolean) => {
    if (input.classList.contains('hidden')) return;
    if (commit) rename(input.value);
    input.classList.add('hidden');
    label.classList.remove('hidden');
    if (session) render();
  };
  label.addEventListener('click', () => {
    input.value = session?.label ?? '';
    label.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
    input.select();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));

  // the card's keys, ahead of the tools' (capture), only while it is open
  window.addEventListener(
    'keydown',
    (e) => {
      if (!session || isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      let handled = true;
      if (session.review) {
        if (k === 'Enter') decide(true);
        else if (k === 'Delete' || k === 'Backspace') decide(false);
        else if (k === 'ArrowRight' || k === 'ArrowDown') move(1);
        else if (k === 'ArrowLeft' || k === 'ArrowUp') move(-1);
        else if (k === 'Escape') endReview();
        else handled = false;
      } else if (k === 'Enter') keepAll();
      else if (k === 'r' || k === 'R') startReview();
      else if (k === 'Escape') dismiss();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  // the card follows the takeoff: hits removed elsewhere, or a tool picked
  subscribe(() => {
    if (!session) return;
    if (!live().length) close();
    else if (state.tool !== 'pan' && state.tool !== 'scan') dismiss();
  });
}
