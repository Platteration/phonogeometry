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

/**
 * A stored shot in the shape the app reads, or null when the record cannot be one.
 *
 * The database belongs to the origin, not to this app, and on a GitHub Pages project site the
 * origin is shared with every other app the account publishes: a page there writes this store as
 * easily as this one does. One record whose `frames` was not a list, or held something that is
 * not an object, stopped the shot list from drawing on every launch: the count stayed at 0, Build
 * stayed off, and every capture after it said "Capture failed" (an import failed silently) while
 * still saving the photograph it had just taken, so the visitor kept shooting into a list they
 * could not see, with nothing pointing at Clear. The fields inside a frame are not checked here: a photo the browser
 * cannot decode already costs only that frame at build time (decodeForWorker in app.js), the
 * label is only ever set as text, and the thumbnail is an <img> source the site's policy limits
 * to this site and data: URLs.
 */
export function cleanShot(record) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(record) || !Array.isArray(record.frames)) return null;
  const frames = record.frames.filter(isObject);
  return frames.length ? { id: record.id, createdAt: record.createdAt, frames } : null;
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

  /**
   * Resolves true when the record is gone. A refused delete — a store in a read-only state, a
   * blocked upgrade, the browser reclaiming storage mid-transaction — is reported rather than
   * swallowed, because loadAll decides what to do about it: a record dropped from the restore
   * *and* left on the disk is the worst of both, and is reachable by nothing afterwards.
   */
  async deleteShot(id) {
    const db = await this.dbPromise;
    if (!db) return false;
    try { await tx(db, 'readwrite', (s) => s.delete(id)); return true; } catch { return false; }
  }

  async clear() {
    const db = await this.dbPromise;
    if (!db) return;
    try { await tx(db, 'readwrite', (s) => s.clear()); } catch { /* ignore */ }
  }

  /**
   * Resolves `{shots, expired, unreadable}`: the shots worth restoring, oldest first, how many
   * were deleted for being older than MAX_AGE_MS, and how many were left out because they are
   * not a shot the app can show (cleanShot). A photograph with no createdAt to judge is treated
   * as old. An unreadable record is left on the disk, not deleted: it goes the way every record
   * goes, when it is a day old or when the visitor presses Clear, and the caller says it was
   * left out.
   *
   * Anything past MAX_AGE_MS is deleted here as well as left out: a record that is not offered
   * back to the user but stays on the disk is the worst of both. The count comes back so the
   * caller can say so — the person whose photographs were deleted is the one person who cannot
   * tell that from a bug, since all they are shown is an empty screen.
   *
   * A delete the database refuses is not counted, and its record is kept in `shots`: it is
   * still on the disk, so leaving it out of the list would hide it from the only interface
   * that could delete it.
   */
  async loadAll() {
    const db = await this.dbPromise;
    if (!db) return { shots: [], expired: 0, unreadable: 0 };
    try {
      const all = await tx(db, 'readonly', (s) => s.getAll());
      const cutoff = Date.now() - MAX_AGE_MS;
      const shots = [];
      let expired = 0;
      let unreadable = 0;
      for (const r of all || []) {
        if (!(r?.createdAt >= cutoff) && await this.deleteShot(r?.id)) { expired++; continue; }
        const shot = cleanShot(r);
        if (shot) shots.push(shot); else unreadable++;
      }
      return { shots: shots.sort((a, b) => a.createdAt - b.createdAt), expired, unreadable };
    } catch { return { shots: [], expired: 0, unreadable: 0 }; }
  }
}
