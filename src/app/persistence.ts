// Session persistence in IndexedDB, keyed by a fast sampled hash of the file
// bytes. Markups and calibrations survive refreshes and re-opens; the PDF
// itself is never stored or uploaded anywhere.

import { state, type Markup, type Calibration, type ToolPreset } from './state';
import type { CustomColumn } from '../engine/export';
import type { Viewport } from '../engine/viewports';
import { fileHash } from '../engine/export';

const DB_NAME = 'pdf2takeoff-sessions';
const STORE = 'sessions';
const PRESET_STORE = 'presets';
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        // guard BOTH stores: re-creating an existing one throws inside the
        // upgrade transaction and silently kills all persistence
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        if (!req.result.objectStoreNames.contains(PRESET_STORE)) {
          req.result.createObjectStore(PRESET_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null); // private mode / blocked storage
    }
  });
  return dbPromise;
}

interface StoredSession {
  markups: Markup[];
  calibrations: [number, Calibration][];
  viewports?: Viewport[];
  savedAt: number;
}

let saveTimer: number | undefined;

/** Debounced autosave — call on any state change while a document is open. */
export function scheduleSave(): void {
  if (!state.fileBytes) return;
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), 700);
}

async function save(): Promise<void> {
  const db = await openDb();
  if (!db || !state.fileBytes) return;
  const session: StoredSession = {
    markups: state.markups,
    calibrations: [...state.calibrations],
    viewports: state.viewports,
    savedAt: Date.now(),
  };
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(session, fileHash(state.fileBytes));
  } catch {
    /* storage full or unavailable */
  }
}

/** Restore a previous session for these exact bytes. Returns markups restored. */
export async function restoreSession(bytes: Uint8Array): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(fileHash(bytes));
      req.onsuccess = () => {
        const s = req.result as StoredSession | undefined;
        if (!s || !Array.isArray(s.markups) || s.markups.length === 0) {
          resolve(0);
          return;
        }
        state.markups = s.markups;
        state.calibrations = new Map(s.calibrations ?? []);
        state.viewports = Array.isArray(s.viewports) ? s.viewports : [];
        resolve(s.markups.length);
      };
      req.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

// --- tool library (global, not per-file) ---

const PRESET_KEY = 'default';

export async function savePresets(presets: ToolPreset[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(PRESET_STORE, 'readwrite');
    tx.objectStore(PRESET_STORE).put(presets, PRESET_KEY);
  } catch {
    /* storage unavailable */
  }
}

export async function loadPresets(): Promise<ToolPreset[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db.transaction(PRESET_STORE, 'readonly').objectStore(PRESET_STORE).get(PRESET_KEY);
      req.onsuccess = () => {
        const list = req.result as ToolPreset[] | undefined;
        resolve(Array.isArray(list) ? list.filter((p) => p && typeof p.label === 'string') : []);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

const COLUMN_KEY = 'columns';

export async function saveColumns(columns: CustomColumn[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(PRESET_STORE, 'readwrite');
    tx.objectStore(PRESET_STORE).put(columns, COLUMN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export async function loadColumns(): Promise<CustomColumn[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db.transaction(PRESET_STORE, 'readonly').objectStore(PRESET_STORE).get(COLUMN_KEY);
      req.onsuccess = () => {
        const list = req.result as CustomColumn[] | undefined;
        resolve(Array.isArray(list) ? list.filter((c) => c && typeof c.formula === 'string') : []);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}
