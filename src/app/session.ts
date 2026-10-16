// Live sessions, phase 4a: conflict-free shared markups and calibrations
// between viewers of the same drawing — any tabs/windows of this browser —
// built on a Yjs CRDT synced over BroadcastChannel. Phase 4b swaps the
// transport for a Cloudflare Durable Object relay to cross machines; the
// merge logic and every hook below stay identical.
//
// Model: Y.Map "markups" holds each markup as a SINGLE JSON leaf keyed by id
// (every edit replaces the value whole, so one observer covers add, edit and
// delete with per-markup last-write-wins — the right granularity for
// takeoffs), and Y.Map "calibrations" maps page -> JSON. Presence rides on
// plain channel messages with a 30 s liveness window.

import * as Y from 'yjs';
import { state, emit, nextId } from './state';
import { fileHash } from '../engine/export';
import type { Calibration, Markup, MarkupType, Pt } from '../engine/types';

let doc: Y.Doc | null = null;
let channel: BroadcastChannel | null = null;
let marker: string | null = null;
let heartbeat: number | undefined;

interface Peer {
  name: string;
  page: number;
  at: number;
}
const peers = new Map<string, Peer>();

export function sessionActive(): boolean {
  return doc !== null;
}

export function getPeers(): Peer[] {
  const now = Date.now();
  return [...peers.entries()].filter(([, p]) => now - p.at < 30000).map(([id, p]) => ({ ...p, name: p.name || id }));
}

export function peerLabel(): string {
  return marker ? marker.slice(-4).toUpperCase() : '';
}

function post(msg: unknown): void {
  try {
    channel?.postMessage(msg);
  } catch {
    /* channel closed */
  }
}

function isValidMarkup(v: unknown): v is Markup {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<Markup>;
  return typeof m.id === 'string' && typeof m.type === 'string' && Array.isArray(m.points);
}

function rebuildFromDoc(): void {
  const d = doc;
  if (!d) return;
  const list: Markup[] = [];
  d.getMap('markups').forEach((v) => {
    if (isValidMarkup(v)) list.push(v);
  });
  list.sort((a, b) => a.createdAt - b.createdAt);
  state.markups = list;

  const calibs = new Map<number, Calibration>();
  d.getMap('calibrations').forEach((v, k) => {
    if (v && typeof v === 'object' && typeof (v as Calibration).metersPerPt === 'number') {
      calibs.set(Number(k), v as Calibration);
    }
  });
  state.calibrations = calibs;
  emit();
}

// --- sync hooks (no-ops when no session is running) ---

export function syncUpsertMarkup(m: Markup): void {
  const d = doc;
  if (!d) return;
  const value: Markup = {
    id: m.id,
    page: m.page,
    type: m.type as MarkupType,
    label: m.label,
    points: m.points.map((p): Pt => ({ x: p.x, y: p.y })),
    createdAt: m.createdAt,
    ...(m.depth !== undefined ? { depth: m.depth } : {}),
    ...(m.status !== undefined ? { status: m.status } : {}),
  };
  d.getMap<Markup>('markups').set(m.id, value);
}

export function syncDeleteMarkup(id: string): void {
  doc?.getMap('markups').delete(id);
}

export function syncClearMarkups(): void {
  const d = doc;
  if (!d) return;
  d.transact(() => d.getMap('markups').clear());
}

export function syncCalibration(page: number, cal: Calibration | null): void {
  if (!doc) return;
  const map = doc.getMap('calibrations');
  if (cal) map.set(String(page), { metersPerPt: cal.metersPerPt, source: cal.source });
  else map.delete(String(page));
}

// --- presence ---

function announce(): void {
  if (!channel || !marker) return;
  post({ t: 'p', from: marker, p: { name: peerLabel(), page: state.pageNum } });
}

// --- lifecycle ---

export function startSession(): void {
  if (doc || !state.fileBytes) return;
  doc = new Y.Doc();
  marker = nextId('peer');
  peers.clear();

  // seed with this viewer's current takeoff (identical content merges to itself)
  doc.transact(() => {
    for (const m of state.markups) syncUpsertMarkup(m);
    for (const [page, cal] of state.calibrations) syncCalibration(page, cal);
  });

  channel = new BroadcastChannel(`pdf2takeoff-live:${fileHash(state.fileBytes)}`);
  channel.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { t?: string; from?: string; u?: unknown; p?: { name: string; page: number } };
    if (!msg || !doc || msg.from === marker) return;
    if (msg.t === 'hello') {
      const d = doc;
      post({ t: 'u', from: marker, u: Y.encodeStateAsUpdate(d) });
      announce();
      return;
    }
    if (msg.t === 'bye') {
      peers.delete(msg.from!);
      emit();
      return;
    }
    if (msg.t === 'p' && msg.from) {
      peers.set(msg.from, { name: msg.p?.name ?? msg.from, page: msg.p?.page ?? 1, at: Date.now() });
      emit();
      return;
    }
    if (msg.t === 'u' && msg.u instanceof Uint8Array) {
      Y.applyUpdate(doc, msg.u, 'remote');
    }
  };

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return; // already broadcast by its sender
    post({ t: 'u', from: marker, u: update });
  });
  doc.getMap('markups').observeDeep(() => rebuildFromDoc());
  doc.getMap('calibrations').observeDeep(() => rebuildFromDoc());

  announce();
  post({ t: 'hello', from: marker });
  heartbeat = window.setInterval(announce, 10000);
  emit();
}

export function stopSession(): void {
  if (heartbeat) window.clearInterval(heartbeat);
  heartbeat = undefined;
  if (channel) {
    post({ t: 'bye', from: marker });
    channel.close();
  }
  channel = null;
  doc?.destroy();
  doc = null;
  marker = null;
  peers.clear();
  emit();
}
