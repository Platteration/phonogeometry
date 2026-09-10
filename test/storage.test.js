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
function fakeDb({ writeFails = false } = {}) {
  const written = new Map();
  return {
    written,
    objectStoreNames: { contains: () => true },
    transaction() {
      const t = {
        objectStore: () => ({
          put: (record) => { written.set(record.id, record); return { result: record.id }; },
          getAll: () => ({ result: Array.from(written.values()) }),
        }),
      };
      // The handlers are attached after this call returns, as they are on a real transaction.
      queueMicrotask(() => {
        if (writeFails) { t.error = new Error('QuotaExceededError'); t.onerror(); }
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
  assert.deepEqual(await store.loadAll(), []);
  await store.deleteShot('shot-1');
  await store.clear();
});

test('saved shots come back oldest first', async () => {
  useIndexedDb(fakeDb());
  const store = new ShotStore();
  await store.saveShot({ ...shot, id: 'b', createdAt: 20 });
  await store.saveShot({ ...shot, id: 'a', createdAt: 10 });
  assert.deepEqual((await store.loadAll()).map((r) => r.id), ['a', 'b']);
});
