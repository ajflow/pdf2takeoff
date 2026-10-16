// Session persistence in IndexedDB, keyed by a fast sampled hash of the file
// bytes. Markups and calibrations survive refreshes and re-opens; the PDF
// itself is never stored or uploaded anywhere.

import { state, type Markup, type Calibration } from './state';
import { fileHash } from '../engine/export';

const DB_NAME = 'pdf2takeoff-sessions';
const STORE = 'sessions';
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
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
        resolve(s.markups.length);
      };
      req.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}
