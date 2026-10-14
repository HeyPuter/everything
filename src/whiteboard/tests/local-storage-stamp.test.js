import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { board } from "../src/model.js";
function controlledLibraryRenameStorage() {
  const indexedDB = new IDBFactory(),
    open = indexedDB.open.bind(indexedDB);
  let armed = false,
    entered,
    callbacks = [],
    released = false,
    reached;
  indexedDB.open = (...args) => {
    const request = open(...args);
    request.addEventListener("success", () => {
      const db = request.result,
        transaction = db.transaction.bind(db);
      db.transaction = (...args) => {
        const tx = transaction(...args);
        if (armed && args[0] === "boards" && args[1] === "readwrite") {
          armed = false;
          for (const key of ["oncomplete", "onerror", "onabort"]) {
            let handler;
            Object.defineProperty(tx, key, {
              configurable: true,
              get: () => handler,
              set: (callback) => {
                handler = (event) => {
                  const run = () => callback.call(tx, event);
                  if (released) run();
                  else {
                    callbacks.push(run);
                    entered();
                  }
                };
              },
            });
          }
        }
        return tx;
      };
    });
    return request;
  };
  return {
    indexedDB,
    hold() {
      armed = true;
      released = false;
      callbacks = [];
      reached = new Promise((resolve) => (entered = resolve));
      return reached;
    },
    release() {
      armed = false;
      released = true;
      const pending = callbacks;
      callbacks = [];
      for (const run of pending) run();
    },
  };
}
for (const first of [false, true])
  for (const mode of ["immutable", "edited", "foreign"])
    test(`storage uses the actual written stamp on ${first ? "first" : "later"} saves with ${mode} input`, async () => {
      const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
        storage = controlledLibraryRenameStorage();
      globalThis.indexedDB = storage.indexedDB;
      let pending, db;
      try {
        const { local } = await import(
          "../src/storage.js?review-stamp-matrix=" + first + "-" + mode
        );
        const value = board("Initial");
        value.updated = 100;
        if (!first) await local.save(value);
        value.title = "Sent";
        value.updated = 200;
        const reached = storage.hold();
        pending = local.save(value);
        await reached;
        db = await new Promise((resolve, reject) => {
          const r = storage.indexedDB.open("whiteboard-v1", 3);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const read = () =>
          new Promise((resolve, reject) => {
            const tx = db.transaction("boards", "readonly"),
              r = tx.objectStore("boards").get(value.id);
            tx.oncomplete = () => resolve(r.result);
            tx.onerror = () => reject(tx.error);
          });
        assert.equal((await read()).updated, 200);
        if (mode !== "immutable") {
          value.title = "Edited while completion queued";
          value.updated = 300;
        }
        if (mode === "foreign") {
          const other = await import(
            "../src/storage.js?review-stamp-foreign=" + first
          );
          const latest = await other.local.get(value.id);
          latest.title = "Actual other tab";
          latest.updated = 400;
          await other.local.save(latest);
        }
        storage.release();
        await pending;
        pending = null;
        if (mode === "immutable") {
          value.title = "Next edit";
          value.updated = 300;
        }
        if (mode === "foreign") {
          await assert.rejects(local.save(value), { name: "StaleBoardError" });
          const saved = await read();
          assert.equal(saved.title, "Actual other tab");
          assert.equal(saved.updated, 400);
        } else {
          await assert.doesNotReject(local.save(value));
          const saved = await read();
          assert.equal(saved.title, value.title);
          assert.equal(saved.updated, 300);
          value.title = "Third write";
          value.updated = 500;
          await local.save(value);
          assert.equal((await read()).updated, 500);
        }
      } finally {
        storage.release();
        await pending;
        db?.close();
        if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
        else delete globalThis.indexedDB;
      }
    });
