// Persists captured shots in IndexedDB so a tab reload (common on phones under memory
// pressure) does not lose a scan in progress. Falls back to memory-only when unavailable.

const DB_NAME = 'phonogeometry';
const STORE = 'shots';
// What is stored here is photographs of rooms and of people, kept so a reload does not lose a
// scan in progress. That is a matter of hours, so a scan older than this is deleted on the next
// read rather than restored: the phone gets lent, handed on and picked up by somebody else.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

  /**
   * Resolves 'saved', or why it was not: 'unavailable' when this browser has no database to
   * write to at all (private browsing, site data blocked by policy), 'failed' when there is
   * one and the write itself was refused (no room left). The caller tells the user, and the
   * two need different advice: freeing space does nothing for the first.
   */
  async saveShot(shot) {
    const db = await this.dbPromise;
    if (!db) return 'unavailable';
    const record = { id: shot.id, createdAt: shot.createdAt || Date.now(), frames: shot.frames.map((f) => ({ ...f, thumbUrl: f.thumbUrl })) };
    try {
      await tx(db, 'readwrite', (s) => s.put(record));
      return 'saved';
    } catch {
      return 'failed'; // quota or serialisation failure: the shot stays in memory only
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

  /**
   * The shots worth restoring, oldest first. Anything past MAX_AGE_MS is deleted here as well
   * as left out: a record that is not offered back to the user but stays on the disk is the
   * worst of both, and a photograph with no createdAt to judge is treated as old.
   */
  async loadAll() {
    const db = await this.dbPromise;
    if (!db) return [];
    try {
      const all = await tx(db, 'readonly', (s) => s.getAll());
      const cutoff = Date.now() - MAX_AGE_MS;
      const fresh = [];
      for (const r of all || []) {
        if (r.createdAt >= cutoff) fresh.push(r);
        else await this.deleteShot(r.id);
      }
      return fresh.sort((a, b) => a.createdAt - b.createdAt);
    } catch { return []; }
  }
}
