import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { board, item } from "../src/model.js";

test("an open connection yields to a schema upgrade from another tab", async () => {
  globalThis.indexedDB = new IDBFactory();
  // Load storage after installing the database so its connection uses it.
  const { local } = await import("../src/storage.js");
  await local.save(board("Kept"));
  const upgraded = await new Promise((resolve, reject) => {
    const request = indexedDB.open("whiteboard-v1", 4);
    const timer = setTimeout(() => reject(Error("Upgrade blocked")), 2000);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  assert.equal(upgraded.version, 4);
  assert.equal(
    await new Promise((resolve) => {
      const request = upgraded
        .transaction("boards")
        .objectStore("boards")
        .getAll();
      request.onsuccess = () => resolve(request.result[0].title);
    }),
    "Kept",
  );
  upgraded.close();
});
test("versions are pruned by their recorded size without re-serializing", async () => {
  // The previous test upgraded its database, which closed this connection.
  globalThis.indexedDB = new IDBFactory();
  const { local } = await import("../src/storage.js");
  const b = board("Large");
  b.items = Array.from({ length: 300 }, (_, n) =>
    item("note", n, 0, { text: "x".repeat(20000) }),
  );
  const stringify = JSON.stringify;
  let large = 0;
  JSON.stringify = (value, ...rest) => {
    const text = stringify(value, ...rest);
    if (text.length > 1_000_000) large++;
    return text;
  };
  try {
    for (let n = 0; n < 6; n++) await local.checkpoint(b, `Edit ${n}`);
  } finally {
    JSON.stringify = stringify;
  }
  // Each new version is measured by walking it, and none written out.
  assert.equal(large, 0, "No version is written out as JSON to be measured");
  const revisions = await local.revisions(b.id);
  // About 12 MB per version keeps four within the 50 MB budget.
  assert.equal(revisions.length, 4);
  assert.ok(revisions.every((r) => r.bytes > 10_000_000));
});

test("versions written within one millisecond keep the order they were made in", async () => {
  globalThis.indexedDB = new IDBFactory();
  const { local } = await import("../src/storage.js");
  const b = board("Fast edits");
  b.items.push(item("note", 0, 0, { text: "v0" }));
  const now = Date.now;
  const fixed = now();
  Date.now = () => fixed;
  try {
    for (let n = 1; n <= 5; n++) {
      b.items[0].text = `v${n}`;
      await local.checkpoint(b, `Edit ${n}`);
    }
  } finally {
    Date.now = now;
  }
  const revisions = (await local.revisions(b.id)).sort(
    (x, y) => y.created - x.created,
  );
  assert.deepEqual(
    revisions.map((r) => r.label),
    ["Edit 5", "Edit 4", "Edit 3", "Edit 2", "Edit 1"],
  );
  assert.equal(new Set(revisions.map((r) => r.created)).size, 5);
  assert.ok(revisions.every((r) => r.created - fixed < 5));
});

test("versions saved with their pictures inline keep working after the upgrade and are pruned as before", async (t) => {
  globalThis.indexedDB = new IDBFactory();
  const b = board("Older photos");
  const src = "data:image/jpeg;base64," + "A".repeat(100_000);
  b.items.push(item("image", 0, 0, { src }));
  let now = Date.UTC(2026, 9, 9, 9, 0);
  t.mock.method(Date, "now", () => (now += 2000));
  // The database as the release before kept it: each version whole.
  const legacy = await new Promise((resolve, reject) => {
    const request = indexedDB.open("whiteboard-v1", 3);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("boards", { keyPath: "id" });
      request.result
        .createObjectStore("revisions", { keyPath: "id" })
        .createIndex("boardId", "boardId");
      request.result.createObjectStore("templates", { keyPath: "id" });
      request.result
        .createObjectStore("collaboration", { keyPath: "id" })
        .createIndex("scope", "scope");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = legacy.transaction("revisions", "readwrite");
    for (let n = 0; n < 20; n++) {
      const revision = {
        id: crypto.randomUUID(),
        boardId: b.id,
        created: (now += 2000),
        label: n ? "Board edit" : "Before the review",
        board: structuredClone(b),
        kept: !n,
      };
      revision.bytes = JSON.stringify(revision).length * 2;
      tx.objectStore("revisions").put(revision);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  legacy.close();
  const { local } = await import("../src/storage.js?legacy=1");
  let revisions = await local.revisions(b.id);
  assert.equal(revisions.length, 20);
  assert.ok(revisions.every((r) => r.board.items[0].src === src));
  for (let n = 0; n < 30; n++) await local.checkpoint(b, "Board edit");
  revisions = await local.revisions(b.id);
  // The older inline versions give way to newer ones like any others; the
  // named one stays.
  assert.equal(revisions.length, 31);
  assert.ok(revisions.some((r) => r.label === "Before the review"));
  assert.ok(revisions.every((r) => r.board.items[0].src === src));
});

test("a tab still running the release before keeps its database open and goes on saving", async (t) => {
  globalThis.indexedDB = new IDBFactory();
  let now = Date.UTC(2026, 9, 9, 9, 0);
  t.mock.method(Date, "now", () => (now += 2000));
  // The release before opens the database at version 3 and lets it go when
  // a newer release asks for a newer version.
  const old = await new Promise((resolve, reject) => {
    const request = indexedDB.open("whiteboard-v1", 3);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("boards", { keyPath: "id" });
      request.result
        .createObjectStore("revisions", { keyPath: "id" })
        .createIndex("boardId", "boardId");
      request.result.createObjectStore("templates", { keyPath: "id" });
      request.result
        .createObjectStore("collaboration", { keyPath: "id" })
        .createIndex("scope", "scope");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let closed = false;
  old.onversionchange = () => {
    old.close();
    closed = true;
  };
  const { local } = await import("../src/storage.js?old-tab=1");
  const b = board("Photos");
  const src = "data:image/jpeg;base64," + "A".repeat(100_000);
  b.items.push(item("image", 0, 0, { src }));
  for (let n = 0; n < 3; n++) await local.checkpoint(b, "Board edit");
  await local.save(b);
  assert.ok(
    (await local.revisions(b.id)).every((r) => r.board.items[0].src === src),
  );
  assert.equal(closed, false, "The older tab's connection stays open");
  // It still saves, and the board's versions it lists are versions only.
  const listed = await new Promise((resolve, reject) => {
    const tx = old.transaction(["boards", "revisions"], "readwrite");
    tx.objectStore("boards").put({ ...b, title: "Saved by the older tab" });
    const read = tx.objectStore("revisions").index("boardId").getAll(b.id);
    tx.oncomplete = () => resolve(read.result);
    tx.onerror = () => reject(tx.error);
  });
  assert.equal(listed.length, 3);
  assert.ok(listed.every((r) => r.boardId === b.id && r.board));
  old.close();
  // As it would be after a reload of the older tab.
  const reopened = await new Promise((resolve, reject) => {
    const request = indexedDB.open("whiteboard-v1", 3);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(reopened.version, 3);
  reopened.close();
});
