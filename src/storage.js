// Persists captured shots in IndexedDB so a tab reload (common on phones under memory
// pressure) does not lose a scan in progress. Falls back to memory-only when unavailable.

const DB_NAME = 'phonogeometry';
const STORE = 'shots';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export class ShotStore {
  constructor() { this.dbPromise = openDb().catch(() => null); }

  /** Resolves true when the shot is safely stored, false when it is not: the caller says so. */
  async saveShot(shot) {
    const db = await this.dbPromise;
    if (!db) return false;
    const record = { id: shot.id, createdAt: shot.createdAt || Date.now(), frames: shot.frames.map((f) => ({ ...f, thumbUrl: f.thumbUrl })) };
    try {
      await tx(db, 'readwrite', (s) => s.put(record));
      return true;
    } catch {
      return false; // quota or serialisation failure: the shot stays in memory only
    }
  }

  async deleteShot(id) {
    const db = await this.dbPromise;
    if (!db) return;
    try { await tx(db, 'readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
  }

  async clear() {
    const db = await this.dbPromise;
    if (!db) return;
    try { await tx(db, 'readwrite', (s) => s.clear()); } catch { /* ignore */ }
  }

  async loadAll() {
    const db = await this.dbPromise;
    if (!db) return [];
    try {
      const all = await tx(db, 'readonly', (s) => s.getAll());
      return (all || []).sort((a, b) => a.createdAt - b.createdAt);
    } catch { return []; }
  }
}
