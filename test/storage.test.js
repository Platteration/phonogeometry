// A shot that was not saved has two very different causes, and the interface tells the user
// what to do about it. This browser has no database to write to at all (private browsing,
// site data blocked by policy) is not the same as the write was refused because there is no
// room left: freeing space fixes only the second. The store has to say which one happened,
// so one boolean is not enough.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ShotStore } from '../src/storage.js';

const shot = { id: 'shot-1', createdAt: 5, frames: [{ thumbUrl: 'data:,', width: 2, height: 2 }] };

/** The smallest database that behaves the way storage.js uses one. */
function fakeDb({ writeFails = false, deleteFails = false } = {}) {
  const written = new Map();
  return {
    written,
    objectStoreNames: { contains: () => true },
    transaction() {
      let refused = writeFails;
      const t = {
        objectStore: () => ({
          put: (record) => { written.set(record.id, record); return { result: record.id }; },
          getAll: () => ({ result: Array.from(written.values()) }),
          // A delete can be refused on its own: a store in a read-only state, a blocked
          // upgrade, the browser reclaiming storage in the middle of the transaction.
          delete: (id) => { if (deleteFails) refused = true; else written.delete(id); return { result: undefined }; },
        }),
      };
      // The handlers are attached after this call returns, as they are on a real transaction.
      queueMicrotask(() => {
        if (refused) { t.error = new Error('QuotaExceededError'); t.onerror(); }
        else t.oncomplete();
      });
      return t;
    },
  };
}

function useIndexedDb(db, { openFails = false } = {}) {
  globalThis.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        if (openFails) { req.error = new Error('SecurityError'); req.onerror(); }
        else { req.result = db; req.onsuccess(); }
      });
      return req;
    },
  };
}

afterEach(() => { delete globalThis.indexedDB; });

test('a shot that is written is reported as saved', async () => {
  const db = fakeDb();
  useIndexedDb(db);
  const store = new ShotStore();
  assert.equal(await store.saveShot(shot), 'saved');
  assert.deepEqual(Array.from(db.written.keys()), ['shot-1']);
});

test('a browser with no IndexedDB is not reported as a browser out of room', async () => {
  delete globalThis.indexedDB;
  const store = new ShotStore();
  const outcome = await store.saveShot(shot);
  assert.equal(outcome, 'unavailable');
  // The whole point: this must be distinguishable from a write that was refused, because the
  // two need different advice.
  useIndexedDb(fakeDb({ writeFails: true }));
  assert.notEqual(outcome, await new ShotStore().saveShot(shot));
});

test('a database that cannot be opened is unavailable, not full', async () => {
  useIndexedDb(fakeDb(), { openFails: true });
  assert.equal(await new ShotStore().saveShot(shot), 'unavailable');
});

test('a write the database refuses is reported as a failed write', async () => {
  useIndexedDb(fakeDb({ writeFails: true }));
  assert.equal(await new ShotStore().saveShot(shot), 'failed');
});

test('the other operations still do nothing quietly without a database', async () => {
  delete globalThis.indexedDB;
  const store = new ShotStore();
  assert.deepEqual(await store.loadAll(), { shots: [], expired: 0, unreadable: 0 });
  await store.deleteShot('shot-1');
  await store.clear();
});

test('saved shots come back oldest first', async () => {
  useIndexedDb(fakeDb());
  const store = new ShotStore();
  await store.saveShot({ ...shot, id: 'b', createdAt: Date.now() - 1000 });
  await store.saveShot({ ...shot, id: 'a', createdAt: Date.now() - 2000 });
  assert.deepEqual((await store.loadAll()).shots.map((r) => r.id), ['a', 'b']);
});

// These are photographs of rooms and of people on a device that gets lent and handed on. The
// store exists so a tab that reloads mid-scan does not lose one, which is a matter of hours.
test('a scan older than the restore window is deleted rather than restored', async () => {
  const db = fakeDb();
  useIndexedDb(db);
  const store = new ShotStore();
  const hour = 60 * 60 * 1000;
  await store.saveShot({ ...shot, id: 'yesterday', createdAt: Date.now() - 25 * hour });
  await store.saveShot({ ...shot, id: 'this-morning', createdAt: Date.now() - 2 * hour });
  // saveShot stamps every record it writes, so a record with no timestamp is one that was
  // written by an older version or tampered with. Put it in behind the store's back.
  db.written.set('undated', { id: 'undated', frames: shot.frames });

  const loaded = await store.loadAll();
  assert.deepEqual(loaded.shots.map((r) => r.id), ['this-morning']);
  // Left out of the restore *and* gone from the database: one without the other is the worst
  // of both. A record with no timestamp to judge goes with them.
  assert.deepEqual(Array.from(db.written.keys()), ['this-morning']);
  // And the count comes back, because somebody has to be told: the user whose photographs
  // these were sees an empty screen otherwise, which is what a bug looks like.
  assert.equal(loaded.expired, 2);
});

test('a deletion nobody survived is still counted', async () => {
  // The case that matters most is the one where nothing is left to restore.
  const db = fakeDb();
  useIndexedDb(db);
  const store = new ShotStore();
  await store.saveShot({ ...shot, id: 'gone', createdAt: Date.now() - 40 * 60 * 60 * 1000 });
  assert.deepEqual(await store.loadAll(), { shots: [], expired: 1, unreadable: 0 });
});

test('a record the database refuses to delete is kept where it can still be got rid of', async () => {
  // "Not offered back to the user but still on the disk" is the worst of both, and it is what
  // a swallowed delete produces: the record is invisible to the interface, so Clear — the way
  // the README says to delete these photographs — is never given the chance.
  const db = fakeDb({ deleteFails: true });
  useIndexedDb(db);
  const store = new ShotStore();
  db.written.set('stuck', { id: 'stuck', createdAt: Date.now() - 30 * 60 * 60 * 1000, frames: shot.frames });
  db.written.set('today', { id: 'today', createdAt: Date.now() - 60 * 1000, frames: shot.frames });

  const loaded = await store.loadAll();
  assert.deepEqual(loaded.shots.map((r) => r.id), ['stuck', 'today']);
  assert.equal(loaded.expired, 0, 'nothing was deleted, so nothing may be reported as deleted');
  assert.equal(await store.deleteShot('stuck'), false, 'and a refused delete says so');
});

// The database is the origin's. On a GitHub Pages project site the origin is shared with every
// other app the account publishes, so a record this app did not write is possible, and one whose
// frames were not a list stopped the shot list from drawing on every launch, with every capture
// after it saved but never shown.
test('a record that is not a shot the app can show is left out and counted, and stays on the disk', async () => {
  const db = fakeDb();
  useIndexedDb(db);
  const store = new ShotStore();
  const now = Date.now();
  db.written.set('good', { ...shot, id: 'good', createdAt: now - 2000 });
  db.written.set('frames-null', { id: 'frames-null', createdAt: now, frames: null });
  db.written.set('frames-object', { id: 'frames-object', createdAt: now, frames: { 0: shot.frames[0], length: 1 } });
  db.written.set('frames-empty', { id: 'frames-empty', createdAt: now, frames: [null, 7, 'x', [shot.frames[0]]] });
  db.written.set('mixed', { id: 'mixed', createdAt: now - 1000, frames: [null, shot.frames[0], 3] });

  const loaded = await store.loadAll();
  assert.deepEqual(loaded.shots.map((r) => r.id), ['good', 'mixed']);
  assert.deepEqual(loaded.shots[1].frames, [shot.frames[0]], 'what is not a frame is dropped from a shot that has one');
  assert.equal(loaded.unreadable, 3);
  assert.equal(loaded.expired, 0);
  // Left out, not deleted: the day rule and Clear apply to it as to any other record.
  assert.deepEqual(Array.from(db.written.keys()).sort(), ['frames-empty', 'frames-null', 'frames-object', 'good', 'mixed']);
});

test('an unreadable record past the restore window is deleted with the rest, and counted with them', async () => {
  const db = fakeDb();
  useIndexedDb(db);
  const store = new ShotStore();
  db.written.set('old-junk', { id: 'old-junk', createdAt: Date.now() - 30 * 60 * 60 * 1000, frames: null });
  assert.deepEqual(await store.loadAll(), { shots: [], expired: 1, unreadable: 0 });
  assert.equal(db.written.size, 0);
});
