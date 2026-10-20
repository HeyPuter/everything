import { test, expect } from "@playwright/test";

for (const legacy of [false, true]) {
  test(`draft listings avoid loading PPTX payloads with ${legacy ? "an existing" : "a new"} database`, async ({
    page,
  }) => {
    await page.route("https://js.puter.com/v2/", (route) =>
      route.fulfill({ body: "" }),
    );
    await page.route("**/src/main.js*", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "" }),
    );
    await page.goto("/#/home");
    const result = await page.evaluate(async (legacy) => {
      const records = [
        {
          id: "guest",
          owner: "guest",
          name: "Guest draft",
          cloudSaved: false,
          updated: 1,
          bytes: new Uint8Array(1024 * 1024).fill(17),
        },
        {
          id: "other",
          owner: "other-account",
          name: "Other account",
          cloudSaved: false,
          updated: 2,
          bytes: new Uint8Array(1024 * 1024).fill(29),
        },
        {
          id: "saved",
          owner: "guest",
          name: "Already saved",
          cloudSaved: true,
          updated: 3,
          bytes: new Uint8Array(1024 * 1024).fill(43),
        },
      ];
      if (legacy) {
        await new Promise((resolve, reject) => {
          const request = indexedDB.open("presentation-drafts-v1", 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore("drafts", { keyPath: "id" });
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("drafts", "readwrite");
            for (const record of records) tx.objectStore("drafts").put(record);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        });
      }
      const drafts = await import("/src/drafts.js");
      if (!legacy) for (const record of records) await drafts.saveDraft(record);
      // Complete any schema upgrade before measuring ordinary library reads.
      await drafts.getDraft("guest");
      let payloadBytesRead = 0;
      const restore = [];
      for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
        const original = prototype.getAll;
        prototype.getAll = function (...args) {
          const request = original.apply(this, args);
          request.addEventListener("success", () => {
            payloadBytesRead += request.result.reduce(
              (total, record) => total + (record.bytes?.byteLength || 0),
              0,
            );
          });
          return request;
        };
        restore.push(() => (prototype.getAll = original));
      }
      const listed = await drafts.listDrafts("guest");
      restore.forEach((fn) => fn());
      const stored = await drafts.getDraft("guest");
      let failedSaveRejected = false;
      try {
        await drafts.saveDraft({
          ...stored,
          name: "Must not persist",
          bytes: () => {},
        });
      } catch {
        failedSaveRejected = true;
      }
      const afterFailedSave = await drafts.listDrafts("guest");
      await drafts.saveDraft({
        ...stored,
        owner: "other-account",
        name: "Transferred",
      });
      const afterTransfer = await drafts.listDrafts("guest");
      const other = await drafts.listDrafts("other-account");
      await drafts.deleteDraft("guest");
      return {
        payloadBytesRead,
        listed: listed.map(({ id, name }) => ({ id, name })),
        containsPayload: listed.some((record) => "bytes" in record),
        storedLength: stored.bytes.byteLength,
        storedValue: stored.bytes[0],
        failedSaveRejected,
        afterFailedSave: afterFailedSave.map((record) => record.name),
        afterTransfer: afterTransfer.map((record) => record.id),
        otherNames: other.map((record) => record.name).sort(),
        deleted: (await drafts.getDraft("guest")) === undefined,
        otherAfterDelete: (await drafts.listDrafts("other-account")).map(
          (record) => record.id,
        ),
      };
    }, legacy);
    expect(result.payloadBytesRead).toBe(0);
    expect(result.containsPayload).toBe(false);
    expect(result.listed).toEqual([{ id: "guest", name: "Guest draft" }]);
    expect(result.storedLength).toBe(1024 * 1024);
    expect(result.storedValue).toBe(17);
    expect(result.failedSaveRejected).toBe(true);
    expect(result.afterFailedSave).toEqual(["Guest draft"]);
    expect(result.afterTransfer).toEqual([]);
    expect(result.otherNames).toEqual(["Other account", "Transferred"]);
    expect(result.deleted).toBe(true);
    expect(result.otherAfterDelete).toEqual(["other"]);
  });
}

test("linking a first cloud save preserves local data and does not recreate or redirect drafts", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.route("**/src/main.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.goto("/#/home");
  const result = await page.evaluate(async () => {
    const drafts = await import("/src/drafts.js");
    const records = [
      { id: "local", owner: "one", path: null },
      { id: "other-account", owner: "two", path: null },
      { id: "already-linked", owner: "one", path: "/existing.pptx" },
      { id: "deleted", owner: "one", path: null },
    ];
    for (const record of records)
      await drafts.saveDraft({
        ...record,
        name: record.id,
        cloudSaved: false,
        theme: "clay",
        bytes: new Uint8Array([7, 8, 9]),
      });
    await drafts.deleteDraft("deleted");
    const before = await Promise.all(
      records.map(({ id }) => drafts.getDraft(id)),
    );
    for (const { id } of records)
      await drafts.linkCloudFile(id, "one", "/saved (1).pptx", "saved (1)");
    return {
      before,
      after: await Promise.all(records.map(({ id }) => drafts.getDraft(id))),
      summaries: await drafts.listDrafts("one"),
    };
  });
  expect(result.after).toEqual(
    result.before.map((record) =>
      record?.id === "local"
        ? { ...record, path: "/saved (1).pptx", name: "saved (1)" }
        : record,
    ),
  );
  expect(result.summaries.find(({ id }) => id === "local")).toMatchObject({
    path: "/saved (1).pptx",
    name: "saved (1)",
    cloudSaved: false,
  });
  expect(result.summaries.some(({ id }) => id === "deleted")).toBe(false);
  expect(result.summaries.some((record) => "bytes" in record)).toBe(false);
});

test("linking a first cloud save keeps the file's baseline", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.route("**/src/main.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.goto("/#/home");
  const result = await page.evaluate(async () => {
    const drafts = await import("/src/drafts.js");
    await drafts.saveDraft({
      id: "linked",
      owner: "one",
      name: "Untitled",
      path: null,
      cloudSaved: false,
      uid: null,
      remoteModified: null,
      remoteSize: null,
      theme: "clay",
      bytes: new Uint8Array([7, 8, 9]),
    });
    await drafts.linkCloudFile("linked", "one", "/Deck.pptx", "Deck", {
      uid: "uid-1",
      remoteModified: 1000,
      remoteSize: 3,
      cloudSaved: true,
    });
    const stored = await drafts.getDraft("linked");
    await drafts.deleteDraft("linked");
    return stored;
  });
  expect(result).toMatchObject({
    path: "/Deck.pptx",
    name: "Deck",
    uid: "uid-1",
    remoteModified: 1000,
    remoteSize: 3,
    cloudSaved: true,
  });
  expect([...Object.values(result.bytes)]).toEqual([7, 8, 9]);
});

for (const operation of ["detach", "rename"]) {
  test(`${operation} cloud metadata preserves drafts and isolates accounts and paths`, async ({
    page,
  }) => {
    await page.route("https://js.puter.com/v2/", (route) =>
      route.fulfill({ body: "" }),
    );
    await page.route("**/src/main.js*", (route) =>
      route.fulfill({ contentType: "application/javascript", body: "" }),
    );
    await page.goto("/#/home");
    const result = await page.evaluate(async (operation) => {
      const drafts = await import("/src/drafts.js");
      const records = [
        {
          id: "unsaved",
          owner: "one",
          path: "/deleted.pptx",
          cloudSaved: false,
        },
        { id: "saved", owner: "one", path: "/deleted.pptx", cloudSaved: true },
        {
          id: "other-path",
          owner: "one",
          path: "/retained.pptx",
          cloudSaved: false,
        },
        {
          id: "other-owner",
          owner: "two",
          path: "/deleted.pptx",
          cloudSaved: false,
        },
        { id: "local", owner: "one", path: null, cloudSaved: false },
      ];
      for (const record of records)
        await drafts.saveDraft({
          ...record,
          name: record.id,
          theme: "clay",
          bytes: new Uint8Array([1, 2, 3]),
        });
      const before = await Promise.all(
        records.map((record) => drafts.getDraft(record.id)),
      );
      if (operation === "detach")
        await drafts.detachCloudFile("one", "/deleted.pptx");
      else
        await drafts.renameCloudFile(
          "one",
          "/deleted.pptx",
          "/renamed.pptx",
          "Renamed",
        );
      const after = await Promise.all(
        records.map((record) => drafts.getDraft(record.id)),
      );
      const summaries = await drafts.listDrafts("one");
      return { before, after, summaries };
    }, operation);
    const changes =
      operation === "detach"
        ? { path: null }
        : { path: "/renamed.pptx", name: "Renamed" };
    expect(result.after).toEqual(
      result.before.map((record) => ({
        ...record,
        ...(record.owner === "one" && record.path === "/deleted.pptx"
          ? changes
          : {}),
      })),
    );
    expect(
      result.summaries.find((record) => record.id === "unsaved"),
    ).toMatchObject(changes);
    expect(result.summaries.some((record) => record.id === "saved")).toBe(
      false,
    );
    expect(result.summaries.some((record) => "bytes" in record)).toBe(false);
  });
}

test("the library reports an older tab blocking the drafts database instead of loading forever", async ({
  page,
  context,
}) => {
  // An older build keeps the version 1 database open without closing on
  // versionchange, which blocks this build's schema upgrade.
  const older = await context.newPage();
  await older.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({ body: "" }),
  );
  await older.route("**/src/main.js*", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await older.goto("/#/home");
  await older.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("presentation-drafts-v1", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("drafts", { keyPath: "id" });
        request.onsuccess = () => {
          window.__db = request.result;
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  await page.route("https://js.puter.com/v2/", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.goto("/#/home");
  await expect(page.locator(".error-row")).toContainText(
    "older Presentation tab is open",
  );
  await older.close();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your next story starts here" }),
  ).toBeVisible();
  await expect(page.locator(".error-row")).toHaveCount(0);
});
