import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { board, item, clone } from "../src/model.js";
import { createFeatures } from "../src/features.js";
import { language, setLanguage, t } from "../src/i18n.js";
const message =
  "You’re viewing a different board. Return to the original board to use this history, or close this dialog and open history again.";
function fixture(locale, shared = false) {
  const dom = new JSDOM("<body></body>", { url: "https://whiteboard.test" }),
    keys = ["window", "document", "HTMLElement", "Node", "NodeFilter"];
  const globals = Object.fromEntries(
      keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
    ),
    previousLanguage = language;
  for (const k of keys)
    Object.defineProperty(globalThis, k, {
      value: dom.window[k],
      configurable: true,
      writable: true,
    });
  setLanguage(locale);
  const original = board("Original board"),
    other = board("Different board");
  const frame = item("frame", 0, 0, {
      id: "frame",
      text: "Original frame",
      w: 600,
      h: 400,
    }),
    note = item("note", 20, 20, {
      id: "note",
      parentId: "frame",
      text: "Original note",
    }),
    gone = item("note", 700, 0, { id: "gone", text: "Deleted original note" });
  const version = { ...clone(original), items: [frame, note, gone] };
  original.items = [
    clone(frame),
    { ...clone(note), text: "Current note" },
    item("note", 950, 0, { id: "new", text: "Current additional note" }),
  ];
  other.items = [
    item("note", 0, 0, { id: "different", text: "Different board note" }),
  ];
  let current = original,
    writes = 0,
    loads = 0,
    checkpointHandler = async () => {},
    loadHandler = async () => clone(version),
    removedHandler = async () => null,
    removedCalls = [],
    localRows = [
      {
        id: "saved",
        created: 1,
        label: "Original checkpoint",
        board: clone(version),
      },
    ],
    sharedListHandler = async () => ({
      versions: [
        { at: 2, edits: 1, authors: ["Owner"] },
        { at: 1, edits: 1, authors: ["Owner"] },
      ],
    });
  const checkpoints = [],
    toasts = [],
    copies = [],
    audit = [];
  const any = (target) =>
    new Proxy(target, {
      get: (obj, key) => (key in obj ? obj[key] : () => undefined),
    });
  const features = createFeatures(
    any({
      board: () => current,
      modal(_title, html) {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        d.open = true;
        d.close = () => {
          d.open = false;
          d.remove();
        };
        document.body.append(d);
        return d;
      },
      selection: () => new Set(["note"]),
      concealedIn: () => new Set(),
      portableCopy: () => 0,
      canEdit: () => true,
      waitForSaves: async () => {},
      local: {
        revisions: async () => clone(localRows),
        checkpoint: async (b, label) => {
          checkpoints.push({ id: b.id, label });
          return checkpointHandler();
        },
      },
      sharedHistory: () =>
        shared
          ? {
              list: (before) => sharedListHandler(before),
              load: async () => {
                loads++;
                return loadHandler();
              },
              note: (details) => audit.push(details),
              removed: (at, after) => {
                removedCalls.push([at, after]);
                return removedHandler();
              },
            }
          : undefined,
      restore: (b) => {
        writes++;
        current.items = b.items;
        current.title = b.title;
      },
      replaceItems: (items) => {
        writes++;
        current.items = items;
      },
      addBoard: async (b) => copies.push(b),
      refresh() {},
      toast: (m) => toasts.push(m),
    }),
  );
  return {
    dom,
    original,
    other,
    version,
    features,
    toasts,
    copies,
    audit,
    checkpoints,
    writes: () => writes,
    loads: () => loads,
    navigate: (b) => (current = b),
    checkpoint: (fn) => (checkpointHandler = fn),
    load: (fn) => (loadHandler = fn),
    removed: (fn) => (removedHandler = fn),
    removedCalls: () => removedCalls,
    revisions: (rows) => (localRows = rows),
    list: (fn) => (sharedListHandler = fn),
    dialog: () => document.querySelector("dialog"),
    row: () =>
      document
        .querySelector(shared ? '[data-shared="1"]' : '[data-revision="saved"]')
        ?.closest(".revision-row"),
    close() {
      dom.window.close();
      setLanguage(previousLanguage);
      for (const [k, v] of Object.entries(globals)) {
        if (v) Object.defineProperty(globalThis, k, v);
        else delete globalThis[k];
      }
    },
  };
}
async function action(a, operation) {
  const row = a.row();
  if (operation === "whole")
    return row.querySelector("[data-revision],[data-shared]");
  await row
    .querySelector("[data-revision-options],[data-shared-options]")
    .onclick();
  const button = a.dialog().querySelector(`[data-part="${operation}"]`);
  assert.ok(button);
  assert.equal(button.disabled, false);
  return button;
}
for (const locale of ["en", "fr"])
  for (const shared of [false, true])
    for (const operation of ["whole", "objects", "frame", "deleted"])
      for (const phase of [
        "same board",
        "navigated before click",
        "navigated during backup",
      ])
        test(`history ${shared ? "shared" : "local"} ${operation} keeps its board ${phase} in ${locale}`, async () => {
          const a = fixture(locale, shared);
          let release;
          try {
            await a.features.actions.history();
            const button = await action(a, operation);
            const original = JSON.stringify(a.original),
              other = JSON.stringify(a.other);
            if (phase === "navigated before click") a.navigate(a.other);
            if (phase === "navigated during backup")
              a.checkpoint(() => new Promise((resolve) => (release = resolve)));
            const pending = button.onclick();
            if (phase === "navigated during backup") {
              for (let n = 0; n < 20 && !release; n++)
                await new Promise((resolve) => setImmediate(resolve));
              assert.equal(typeof release, "function");
              a.navigate(a.other);
              release();
            }
            await pending;
            assert.equal(
              JSON.stringify(a.other),
              other,
              "An original-board restoration must never modify another board.",
            );
            if (phase === "same board") {
              assert.equal(a.writes(), 1);
              assert.equal(a.checkpoints[0].id, a.original.id);
              assert.equal(a.dialog(), null);
              assert.equal(a.audit.length, shared ? 1 : 0);
              return;
            }
            assert.equal(a.writes(), 0);
            assert.equal(JSON.stringify(a.original), original);
            assert.equal(a.audit.length, 0);
            if (phase === "navigated before click")
              assert.equal(a.checkpoints.length, 0);
            else assert.equal(a.checkpoints[0].id, a.original.id);
            const status = a.dialog().querySelector("#history-status");
            assert.ok(status);
            assert.equal(status.textContent, t(message));
            assert.equal(status.getAttribute("role"), "status");
            // Return to the same object, with its remote edits intact, and retry normally.
            a.navigate(a.original);
            a.checkpoint(async () => {});
            await button.onclick();
            assert.equal(a.writes(), 1);
            assert.equal(a.dialog(), null);
            assert.equal(JSON.stringify(a.other), other);
          } finally {
            release?.();
            a.close();
          }
        });
for (const locale of ["en", "fr"])
  for (const shared of [false, true])
    for (const operation of ["checkpoint", "copy"])
      test(`history ${shared ? "shared" : "local"} ${operation} rejects a different board in ${locale}`, async () => {
        const a = fixture(locale, shared);
        try {
          await a.features.actions.history();
          const button =
            operation === "copy"
              ? await action(a, "copy")
              : a.dialog().querySelector("#checkpoint-create");
          const other = JSON.stringify(a.other);
          a.navigate(a.other);
          await button.onclick({ currentTarget: button });
          assert.equal(a.copies.length, 0);
          assert.equal(a.checkpoints.length, 0);
          assert.equal(JSON.stringify(a.other), other);
          assert.equal(
            a.dialog().querySelector("#history-status")?.textContent,
            t(message),
          );
        } finally {
          a.close();
        }
      });
for (const locale of ["en", "fr"])
  for (const operation of ["whole", "options"])
    test(`shared history ${operation} checks its board after loading in ${locale}`, async () => {
      const a = fixture(locale, true);
      let release;
      try {
        await a.features.actions.history();
        const original = JSON.stringify(a.original),
          other = JSON.stringify(a.other);
        a.load(() => new Promise((resolve) => (release = resolve)));
        const button = a
          .row()
          .querySelector(
            operation === "whole" ? "[data-shared]" : "[data-shared-options]",
          );
        const pending = button.onclick();
        assert.equal(typeof release, "function");
        a.navigate(a.other);
        release(clone(a.version));
        await pending;
        assert.equal(a.writes(), 0);
        assert.equal(a.checkpoints.length, 0);
        assert.equal(JSON.stringify(a.original), original);
        assert.equal(JSON.stringify(a.other), other);
        assert.equal(a.dialog().querySelector(".revision-options"), null);
        assert.equal(
          a.dialog().querySelector("#history-status")?.textContent,
          t(message),
        );
      } finally {
        release?.(clone(a.version));
        a.close();
      }
    });

for (const locale of ["en", "fr"])
  for (const change of ["unchanged", "new checkpoint", "pruned", "empty"])
    test(`local history refresh preserves review controls after ${change} in ${locale}`, async () => {
      const a = fixture(locale, false);
      let release;
      try {
        await a.features.actions.history();
        a.checkpoint(() => new Promise((resolve) => (release = resolve)));
        const create = a.dialog().querySelector("#checkpoint-create");
        create.focus();
        const pending = create.onclick({ currentTarget: create });
        assert.equal(typeof release, "function");
        const copy = await action(a, "copy"),
          options = copy.closest(".revision-options"),
          row = options.previousElementSibling,
          choice = options.querySelector("#restore-frame input");
        choice.checked = false;
        copy.focus();
        const old = {
            id: "saved",
            created: 1,
            label: "Original checkpoint",
            board: clone(a.version),
          },
          fresh = {
            id: "new-checkpoint",
            created: 2,
            label: "New checkpoint",
            board: clone(a.original),
          };
        a.revisions(
          change === "unchanged"
            ? [old]
            : change === "new checkpoint"
              ? [fresh, old]
              : change === "pruned"
                ? [fresh]
                : [],
        );
        release();
        await pending;
        if (change === "pruned" || change === "empty") {
          assert.equal(options.isConnected, false);
          assert.equal(a.dialog().querySelector('[data-part="copy"]'), null);
          assert.equal(
            document.activeElement,
            change === "empty"
              ? a.dialog().querySelector("#checkpoint-label")
              : a
                  .dialog()
                  .querySelector('[data-revision-options="new-checkpoint"]'),
          );
          return;
        }
        assert.equal(options.isConnected, true);
        assert.equal(row.isConnected, true);
        assert.equal(document.activeElement, copy);
        assert.equal(choice.checked, false);
        assert.equal(
          row
            .querySelector("[data-revision-options]")
            .getAttribute("aria-expanded"),
          "true",
        );
        assert.equal(
          a.dialog().querySelectorAll(".revision-row").length,
          change === "new checkpoint" ? 2 : 1,
        );
        if (change === "new checkpoint") {
          a.dialog()
            .querySelector('[data-revision-options="new-checkpoint"]')
            .focus();
          await a
            .dialog()
            .querySelector('[data-revision-options="new-checkpoint"]')
            .onclick();
          assert.equal(
            a.dialog().querySelectorAll(".revision-options").length,
            2,
          );
          assert.equal(options.isConnected, true);
          assert.equal(choice.checked, false);
        }
        // The retained control remains wired to its own version after the refresh.
        await copy.onclick();
        assert.equal(a.copies.length, 1);
        assert.equal(
          a.copies[0].items.find((i) => i.id === "note").text,
          "Original note",
        );
      } finally {
        release?.();
        a.close();
      }
    });
const untilRefresh = async (fn) => {
  for (let n = 0; n < 100 && !fn(); n++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fn());
};
for (const locale of ["en", "fr"])
  for (const phase of ["moved focus", "pending options", "older button"])
    test(`shared history refresh preserves ${phase} while loading older versions in ${locale}`, async () => {
      const a = fixture(locale, true);
      let releasePage, releaseVersion;
      try {
        a.list(async (before) =>
          before === undefined
            ? {
                versions: [
                  { at: 2, edits: 1, authors: ["Owner"] },
                  { at: 1, edits: 1, authors: ["Owner"] },
                ],
                more: true,
              }
            : new Promise((resolve) => (releasePage = resolve)),
        );
        await a.features.actions.history();
        const row = a.row(),
          button = row.querySelector("[data-shared-options]");
        let pendingOptions, copy, options, choice;
        if (phase === "pending options") {
          a.load(() => new Promise((resolve) => (releaseVersion = resolve)));
          button.focus();
          pendingOptions = button.onclick();
          assert.equal(typeof releaseVersion, "function");
        } else {
          copy = await action(a, "copy");
          options = copy.closest(".revision-options");
          choice = options.querySelector("#restore-frame input");
          choice.checked = false;
        }
        const older = a.dialog().querySelector("#shared-older");
        older.focus();
        older.onclick();
        assert.equal(typeof releasePage, "function");
        if (phase === "moved focus") copy.focus();
        releasePage({
          versions: [{ at: 0, edits: 1, authors: ["Owner"] }],
          more: false,
        });
        await untilRefresh(() => a.dialog().querySelector('[data-shared="0"]'));
        assert.equal(row.isConnected, true);
        if (phase === "pending options") {
          assert.equal(button.disabled, true);
          releaseVersion(clone(a.version));
          await pendingOptions;
          assert.equal(button.disabled, false);
          copy = a.dialog().querySelector('[data-part="copy"]');
          assert.ok(copy);
          options = copy.closest(".revision-options");
        } else {
          assert.equal(options.isConnected, true);
          assert.equal(choice.checked, false);
          assert.equal(
            document.activeElement,
            phase === "moved focus"
              ? copy
              : a.dialog().querySelector('[data-shared="0"]'),
          );
        }
        assert.equal(
          a.dialog().querySelectorAll("#shared-revisions .revision-row").length,
          3,
        );
        assert.equal(
          row
            .querySelector("[data-shared-options]")
            .getAttribute("aria-expanded"),
          "true",
        );
        await copy.onclick();
        assert.equal(a.copies.length, 1);
        assert.equal(
          a.copies[0].items.find((i) => i.id === "note").text,
          "Original note",
        );
      } finally {
        releasePage?.({ versions: [], more: false });
        releaseVersion?.(clone(a.version));
        a.close();
      }
    });
for (const locale of ["en", "fr"])
  for (const shared of [false, true])
    for (const first of ["whole", "objects", "frame", "deleted"])
      test(`pending history ${first} prevents a competing restore in ${shared ? "shared" : "local"} ${locale}`, async () => {
        const a = fixture(locale, shared);
        let release;
        let pending;
        try {
          await a.features.actions.history();
          const firstButton = await action(a, first);
          const row = a.row();
          if (!row.nextElementSibling?.classList.contains("revision-options"))
            await row
              .querySelector("[data-revision-options],[data-shared-options]")
              .onclick();
          const secondButton =
            first === "deleted"
              ? row.querySelector("[data-revision],[data-shared]")
              : row.nextElementSibling.querySelector('[data-part="deleted"]');
          let checkpointCalls = 0;
          a.checkpoint(() =>
            ++checkpointCalls === 1
              ? new Promise((resolve) => (release = resolve))
              : Promise.resolve(),
          );
          pending = firstButton.onclick();
          for (let n = 0; n < 10 && !release; n++)
            await new Promise((resolve) => setTimeout(resolve, 0));
          assert.equal(typeof release, "function");
          secondButton.click();
          for (let n = 0; n < 10; n++)
            await new Promise((resolve) => setTimeout(resolve, 0));
          const during = {
            checkpoints: a.checkpoints.length,
            writes: a.writes(),
            secondDisabled: secondButton.disabled,
          };
          release();
          release = null;
          await pending;
          pending = null;

          assert.equal(
            checkpointCalls,
            1,
            "A pending restoration prevents another restoration from starting.",
          );
          assert.equal(
            a.writes(),
            1,
            "Only the requested restoration applies.",
          );
          assert.equal(a.audit.length, shared ? 1 : 0);
        } finally {
          release?.();
          await pending;
          a.close();
        }
      });

for (const locale of ["en", "fr"])
  for (const shared of [false, true])
    for (const operation of ["whole", "objects", "frame", "deleted"])
      test(`history ${operation} releases controls after a failed backup in ${shared ? "shared" : "local"} ${locale}`, async () => {
        const a = fixture(locale, shared);
        try {
          await a.features.actions.history();
          const button = await action(a, operation);
          button.focus();
          const choices = [...a.dialog().querySelectorAll("button,input")].map(
            (control) => ({ control, disabled: control.disabled }),
          );
          a.checkpoint(() => Promise.reject(Error("Backup unavailable")));
          await button.onclick();
          assert.equal(a.writes(), 0);
          assert.equal(a.dialog().open, true);
          assert.equal(document.activeElement, button);
          for (const { control, disabled } of choices)
            assert.equal(
              control.disabled,
              disabled,
              "Restore failure preserves each original enabled state.",
            );
          a.checkpoint(() => Promise.resolve());
          await button.onclick();
          assert.equal(a.writes(), 1);
          assert.equal(a.dialog(), null);
          assert.equal(a.audit.length, shared ? 1 : 0);
        } finally {
          a.close();
        }
      });
for (const locale of ["en", "fr"])
  test(`shared version loading blocks competing actions and releases after failure in ${locale}`, async () => {
    const a = fixture(locale, true);
    let reject, pending;
    try {
      await a.features.actions.history();
      const restore = await action(a, "whole"),
        options = a.row().querySelector("[data-shared-options]"),
        current = a.dialog().querySelector('[data-shared="2"]');
      restore.focus();
      const loadPending = new Promise((resolve, no) => (reject = no));
      a.load(() => loadPending);
      pending = restore.onclick();
      assert.equal(typeof reject, "function");
      options.click();
      a.dialog().querySelector("#checkpoint-create").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(a.loads(), 1);
      assert.equal(a.checkpoints.length, 0);
      assert.equal(a.dialog().querySelector(".revision-options"), null);
      assert.equal(options.disabled, true);
      reject(Error("Network unavailable"));
      reject = null;
      await pending;
      pending = null;
      assert.equal(a.writes(), 0);
      assert.equal(restore.disabled, false);
      assert.equal(options.disabled, false);
      assert.equal(current.disabled, true);
      assert.equal(document.activeElement, restore);
      a.load(() => Promise.resolve(clone(a.version)));
      await options.onclick();
      assert.ok(a.dialog().querySelector('[data-part="copy"]'));
      await restore.onclick();
      assert.equal(a.writes(), 1);
    } finally {
      reject?.(Error("Test cleanup"));
      await pending;
      a.close();
    }
  });

for (const locale of ["en", "fr"])
  for (const refresh of ["options", "older page", "checkpoint"])
    test(`history ${refresh} completed during restore keeps new controls blocked and permits retry in ${locale}`, async () => {
      const shared = refresh !== "checkpoint",
        a = fixture(locale, shared);
      let releaseRefresh, rejectBackup, refreshPending, restorePending;
      const settle = async (fn) => {
        for (let n = 0; n < 30 && !fn(); n++)
          await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(fn());
      };
      try {
        if (refresh === "older page")
          a.list((before) =>
            before === undefined
              ? Promise.resolve({
                  versions: [
                    { at: 2, edits: 1, authors: ["Owner"] },
                    { at: 1, edits: 1, authors: ["Owner"] },
                  ],
                  more: true,
                })
              : new Promise(
                  (resolve) =>
                    (releaseRefresh = () =>
                      resolve({
                        versions: [{ at: 0, edits: 1, authors: ["Owner"] }],
                        more: false,
                      })),
                ),
          );
        await a.features.actions.history();
        const restore = await action(a, "whole"),
          create = a.dialog().querySelector("#checkpoint-create");
        if (refresh === "options") {
          let n = 0;
          a.load(() =>
            ++n === 1
              ? new Promise(
                  (resolve) =>
                    (releaseRefresh = () => resolve(clone(a.version))),
                )
              : Promise.resolve(clone(a.version)),
          );
          const more = a.row().querySelector("[data-shared-options]");
          more.focus();
          refreshPending = more.onclick();
          a.checkpoint(
            () => new Promise((resolve, reject) => (rejectBackup = reject)),
          );
        } else if (refresh === "older page") {
          a.dialog().querySelector("#shared-older").click();
          a.checkpoint(
            () => new Promise((resolve, reject) => (rejectBackup = reject)),
          );
        } else {
          let n = 0;
          a.checkpoint(() =>
            ++n === 1
              ? new Promise((resolve) => (releaseRefresh = resolve))
              : new Promise((resolve, reject) => (rejectBackup = reject)),
          );
          refreshPending = create.onclick({ currentTarget: create });
          a.revisions([
            {
              id: "fresh",
              created: 2,
              label: "Fresh checkpoint",
              board: clone(a.original),
            },
            {
              id: "saved",
              created: 1,
              label: "Original checkpoint",
              board: clone(a.version),
            },
          ]);
        }
        await settle(() => releaseRefresh);
        restore.focus();
        restorePending = restore.onclick();
        await settle(() => rejectBackup);
        releaseRefresh();
        releaseRefresh = null;
        await refreshPending;
        refreshPending = null;
        await settle(() =>
          refresh === "options"
            ? a.dialog().querySelector(".revision-options")
            : refresh === "older page"
              ? a.dialog().querySelector('[data-shared="0"]')
              : a.dialog().querySelector('[data-revision="fresh"]'),
        );
        assert.ok(
          [
            ...a
              .dialog()
              .querySelectorAll(
                ".revision-list button,.revision-list input,#checkpoint-create",
              ),
          ].every((control) => control.disabled),
          "History controls arriving during a restore remain disabled.",
        );
        assert.equal(a.writes(), 0);
        rejectBackup(Error("Temporary backup failure"));
        rejectBackup = null;
        await restorePending;
        restorePending = null;
        assert.equal(
          document.activeElement,
          restore,
          "The initiating Restore button regains keyboard focus after failure.",
        );
        assert.equal(create.disabled, false);
        assert.equal(restore.disabled, false);
        assert.equal(
          shared
            ? a.dialog().querySelector('[data-shared="2"]').disabled
            : false,
          shared,
        );
        a.checkpoint(() => Promise.resolve());
        a.load(() => Promise.resolve(clone(a.version)));
        await restore.onclick();
        assert.equal(a.writes(), 1);
      } finally {
        releaseRefresh?.();
        rejectBackup?.(Error("Test cleanup"));
        await refreshPending;
        await restorePending;
        a.close();
      }
    });

for (const locale of ["en", "fr"])
  for (const shared of [false, true])
    test(`a reopened history dialog waits for the original restoration in ${shared ? "shared" : "local"} ${locale}`, async () => {
      const a = fixture(locale, shared);
      let release, pending;
      try {
        await a.features.actions.history();
        const first = await action(a, "whole");
        let n = 0;
        a.checkpoint(() =>
          ++n === 1
            ? new Promise((resolve) => (release = resolve))
            : Promise.resolve(),
        );
        pending = first.onclick();
        for (let i = 0; i < 20 && !release; i++)
          await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(typeof release, "function");
        a.dialog().close();
        await a.features.actions.history();
        const second = a.row().querySelector("[data-revision],[data-shared]");
        second.click();
        for (let i = 0; i < 10; i++)
          await new Promise((resolve) => setTimeout(resolve, 0));
        const during = {
          writes: a.writes(),
          backups: a.checkpoints.length,
          disabled: second.disabled,
        };
        release();
        release = null;
        await pending;
        pending = null;

        assert.equal(during.writes, 0);
        assert.equal(during.backups, 1);
        assert.equal(during.disabled, true);
        assert.equal(a.writes(), 1);
        assert.equal(second.disabled, false);
        await second.onclick();
        assert.equal(
          a.writes(),
          2,
          "Restoring again is available once the original operation finishes.",
        );
      } finally {
        release?.();
        await pending;
        a.close();
      }
    });

test("objects added and deleted again within a shared version can be recovered", async () => {
  const a = fixture("en", true);
  try {
    a.removed(async () => ({
      items: [item("note", 1200, 0, { id: "brief", text: "Brief note" })],
      tags: [],
    }));
    await a.features.actions.history();
    await a.row().querySelector("[data-shared-options]").onclick();
    // The oldest listed version's edits began when the board did.
    assert.deepEqual(a.removedCalls(), [[1, 0]]);
    const recover = a.dialog().querySelector('[data-part="deleted"]');
    assert.match(recover.textContent, /\(2\)/);
    assert.ok(
      a.dialog().querySelector('.deleted-choices input[value="brief"]'),
    );
    await recover.onclick();
    assert.ok(a.original.items.some((i) => i.id === "brief"));
    assert.ok(a.original.items.some((i) => i.id === "gone"));
  } finally {
    a.close();
  }
});

test("a shared restoration reports how many objects it changed", async () => {
  const a = fixture("en", true);
  try {
    // The version differs from the board in one note's text only.
    a.load(async () => ({
      ...clone(a.original),
      items: a.original.items.map((i) =>
        i.id === "note" ? { ...clone(i), text: "Earlier note" } : clone(i),
      ),
    }));
    await a.features.actions.history();
    await a.row().querySelector("[data-shared]").onclick();
    assert.equal(a.audit.at(-1).objects, 1);
    assert.equal(a.audit.at(-1).scope, "board");
  } finally {
    a.close();
  }
});
