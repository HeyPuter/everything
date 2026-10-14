import test from "node:test";
import assert from "node:assert/strict";
import { commandEntries, searchCommands } from "../src/commands.js";
import { board, item } from "../src/model.js";
import { setLanguage, t } from "../src/i18n.js";

const find = (entries, id) => entries.find((e) => e.id === id);
test("commands match names, aliases, accents and word order with deterministic ranking", () => {
  const entries = commandEntries({ board: board() });
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
  assert.equal(searchCommands(entries, "text")[0].id, "add:text");
  assert.equal(searchCommands(entries, "post-it")[0].id, "add:note");
  // Familiar commands come before library shapes with similar names.
  assert.equal(searchCommands(entries, "note")[0].id, "add:note");
  assert.notEqual(searchCommands(entries, "table")[0].id, "shape:wf-tablet");
  assert.equal(
    searchCommands(entries, "tablet")[0].id.startsWith("shape:"),
    true,
  );
  assert.equal(searchCommands(entries, "table")[0].id, "table");
  // Partial matches still put familiar commands first.
  assert.equal(searchCommands(entries, "image")[0].id, "image");
  assert.equal(searchCommands(entries, "connector")[0].id, "tool-arrow");
  assert.equal(searchCommands(entries, "pos")[0].id, "add:note");
  // A library shape's exact name still finds it first.
  for (const id of ["shape:document", "shape:cloud", "shape:uml-class"]) {
    const entry = entries.find((e) => e.id === id);
    assert.equal(searchCommands(entries, entry.label)[0].id, id);
  }
  assert.equal(searchCommands(entries, "Décision")[0].id, "shape:diamond");
  assert.ok(
    searchCommands(entries, "horizontal distribute").some(
      (e) => e.id === "arrange:horizontal",
    ),
  );
  assert.deepEqual(searchCommands(entries, "["), searchCommands(entries, ""));
  assert.equal(searchCommands(entries, "does not exist").length, 0);
  // Boards saved to Puter are listed in the library; there is no separate
  // list for a command to open.
  assert.equal(find(entries, "cloud"), undefined);
  assert.equal(searchCommands(entries, "")[0].id, "add:note");
});

test("command availability follows selection, locks, history, capacity and viewer permissions", () => {
  const b = board(),
    a = item("note", 0, 0),
    c = item("rect", 300, 0);
  b.items = [a, c];
  let entries = commandEntries({ board: b });
  assert.match(find(entries, "delete").disabled, /Select/);
  assert.match(find(entries, "move-selection").disabled, /Select/);
  assert.match(find(entries, "filter-selection").disabled, /Select/);
  assert.match(find(entries, "undo").disabled, /Nothing/);
  entries = commandEntries({
    board: b,
    selection: new Set([a.id, c.id]),
    undo: true,
  });
  assert.equal(find(entries, "arrange:left").disabled, "");
  assert.equal(find(entries, "move-selection").disabled, "");
  assert.equal(find(entries, "arrange:connect").disabled, "");
  assert.match(find(entries, "arrange:horizontal").disabled, /three/);
  assert.equal(find(entries, "undo").disabled, "");
  a.locked = true;
  entries = commandEntries({ board: b, selection: new Set([a.id, c.id]) });
  assert.match(find(entries, "arrange:left").disabled, /Unlock/);
  assert.match(find(entries, "move-selection").disabled, /Unlock/);
  assert.equal(find(entries, "lock").disabled, "");
  assert.equal(find(entries, "lock").label, "Unlock selection");
  assert.equal(find(entries, "copy-image").disabled, "");
  assert.equal(
    find(entries, "duplicate").disabled,
    "",
    "Copying locked content is allowed",
  );
  entries = commandEntries({
    board: b,
    selection: new Set([a.id]),
    readOnly: true,
  });
  for (const id of [
    "add:note",
    "delete",
    "format:bold",
    "lock",
    "undo",
    "duplicate",
    "templates",
    "move-selection",
  ])
    assert.match(find(entries, id).disabled, /read-only/, id);
  for (const id of [
    "copy-image",
    "fit",
    "export",
    "board-search",
    "objects",
    "filter-selection",
  ])
    assert.equal(find(entries, id).disabled, "", id);
  b.items = Array.from({ length: 5000 }, (_, n) => item("note", n * 200, 0));
  entries = commandEntries({ board: b, selection: new Set([b.items[0].id]) });
  for (const id of [
    "add:note",
    "shape:diamond",
    "bulk-notes",
    "templates",
    "duplicate",
    "arrange:frame",
  ])
    assert.match(find(entries, id).disabled, /5,000/, id);
});

test("arrangement counts groups, copied frame descendants and locked connected objects correctly", () => {
  const f = item("frame", 0, 0),
    a = item("rect", 0, 0, { parentId: f.id, groupId: "g" }),
    b = item("note", 300, 0, { groupId: "g" }),
    line = item("arrow", 0, 0, { startId: a.id, endId: b.id, locked: true });
  const scene = { ...board(), items: [f, a, b, line] };
  let entries = commandEntries({
    board: scene,
    selection: new Set([a.id, b.id]),
  });
  assert.match(find(entries, "arrange:left").disabled, /two/);
  assert.match(find(entries, "delete").disabled, /Unlock/);
  assert.equal(find(entries, "arrange:ungroup").disabled, "");
  scene.items.push(
    ...Array.from({ length: 4992 }, (_, n) => item("text", n * 300, 1000)),
  );
  entries = commandEntries({ board: scene, selection: new Set([f.id]) });
  assert.equal(
    find(entries, "duplicate").disabled,
    "",
    "Three descendants and their connection exactly fit remaining capacity",
  );
  scene.items.push(item("text", 0, 2000));
  entries = commandEntries({ board: scene, selection: new Set([f.id]) });
  assert.match(find(entries, "duplicate").disabled, /5,000/);
});

test("recent board search preserves authored titles and never accesses board payloads", () => {
  const boards = Array.from({ length: 5000 }, (_, n) => ({
    id: `board-${n}`,
    title: `Research café ${n}`,
    updated: n,
    get items() {
      throw Error("Board contents should not be read");
    },
  }));
  boards[0].deletedAt = 1;
  boards[1].title = "<script>window.bad=true</script>";
  const entries = commandEntries({
    boards,
    recent: ["board-10", "board-20"],
    board: { ...board(), id: "board-30" },
  });
  assert.equal(find(entries, "board:board-0"), undefined);
  assert.equal(find(entries, "board:board-30"), undefined);
  assert.equal(searchCommands(entries, "cafe 4999")[0].boardId, "board-4999");
  assert.equal(
    searchCommands(entries, "").filter((e) => e.boardId)[0].boardId,
    "board-10",
  );
  assert.equal(find(entries, "board:board-1").label, boards[1].title);
  const library = commandEntries({ boards });
  assert.equal(find(library, "add:note"), undefined);
  assert.equal(find(library, "new").disabled, "");
});

test("French commands remain searchable in both languages without translating authored board names", () => {
  const oldDocument = globalThis.document,
    oldStorage = globalThis.localStorage;
  globalThis.document = { documentElement: {} };
  globalThis.localStorage = { setItem() {} };
  try {
    setLanguage("fr");
    const entries = commandEntries({
      board: board(),
      boards: [{ id: "test", title: "Undo" }],
    });
    assert.equal(find(entries, "undo").label, "Annuler");
    assert.equal(searchCommands(entries, "Annuler")[0].id, "undo");
    assert.equal(searchCommands(entries, "sticky note")[0].id, "add:note");
    assert.equal(find(entries, "board:test").label, "Undo");
    assert.ok(
      searchCommands(entries, "note adhesive").some((e) => e.id === "add:note"),
    );
  } finally {
    setLanguage("en");
    globalThis.document = oldDocument;
    globalThis.localStorage = oldStorage;
  }
});

test("style commands explain compatibility and protect locked or read-only destinations", () => {
  const source = item("note", 0, 0),
    image = item("image", 300, 0),
    b = { ...board(), items: [source, image] };
  const state = { board: b, selection: new Set([source.id]) };
  let entries = commandEntries(state);
  assert.equal(find(entries, "copy-style").disabled, "");
  assert.match(find(entries, "paste-style").disabled, /Copy a style/);
  const copiedStyle = { version: 1, text: { fontSize: 28 } };
  entries = commandEntries({ ...state, copiedStyle });
  assert.equal(find(entries, "paste-style").disabled, "");
  entries = commandEntries({ ...state, copiedStyle, readOnly: true });
  assert.equal(find(entries, "copy-style").disabled, "");
  assert.match(find(entries, "paste-style").disabled, /read-only/);
  source.locked = true;
  entries = commandEntries({ ...state, copiedStyle });
  assert.equal(find(entries, "copy-style").disabled, "");
  assert.match(find(entries, "paste-style").disabled, /Unlock/);
  entries = commandEntries({
    ...state,
    copiedStyle,
    selection: new Set([image.id]),
  });
  assert.match(find(entries, "copy-style").disabled, /copyable/);
  assert.match(find(entries, "paste-style").disabled, /does not apply/);
});

test("a translation context tells apart words with several meanings", () => {
  const oldDocument = globalThis.document,
    oldStorage = globalThis.localStorage;
  globalThis.document = { documentElement: {} };
  globalThis.localStorage = { setItem() {} };
  try {
    setLanguage("fr");
    assert.equal(t("Open"), "Ouvert");
    assert.equal(t("Open", "action"), "Ouvrir");
    assert.equal(t("Top", "results"), "Premiers");
    assert.equal(t("Reply", "notification"), "Réponse");
    assert.equal(t("Mention", "notification"), "Mention");
    setLanguage("en");
    assert.equal(t("Open", "action"), "Open");
  } finally {
    setLanguage("en");
    globalThis.document = oldDocument;
    globalThis.localStorage = oldStorage;
  }
});

test("commenters can add comments from the command palette", () => {
  const b = board();
  b.items = [item("note", 0, 0)];
  const entry = (options) =>
    commandEntries({
      board: b,
      selection: new Set([b.items[0].id]),
      ...options,
    }).find((e) => e.id === "add-comment");
  assert.equal(entry({ readOnly: true, commentReadOnly: false }).disabled, "");
  assert.match(entry({ readOnly: true }).disabled, /read-only/);
  // Content commands stay unavailable to them.
  assert.match(
    commandEntries({ board: b, readOnly: true, commentReadOnly: false }).find(
      (e) => e.id === "add:note",
    ).disabled,
    /read-only/,
  );
});

test("bold, italic and font commands apply to a selected table, unlike the other text styles", () => {
  const b = board();
  const table = item("table", 0, 0, { cells: [["A"]] });
  b.items = [table];
  const entries = commandEntries({ board: b, selection: new Set([table.id]) });
  for (const id of ["format:bold", "format:italic", "font:eb-garamond"])
    assert.equal(find(entries, id).disabled, "", id);
  for (const id of ["format:underline", "format:strike", "text-link"])
    assert.notEqual(find(entries, id).disabled, "", id);
});

test("frames are offered by name after every command when nothing is typed", () => {
  const frames = [
    item("frame", 0, 0, { text: "Ideas", order: 0 }),
    item("frame", 900, 0, { text: "", order: 1 }),
  ];
  const entries = commandEntries({ board: board(), frames });
  const listed = searchCommands(entries, "");
  assert.deepEqual(
    listed.slice(-2).map((e) => e.frameId),
    frames.map((f) => f.id),
  );
  assert.equal(searchCommands(entries, "ideas")[0].frameId, frames[0].id);
  assert.equal(searchCommands(entries, "frame 2")[0].frameId, frames[1].id);
  // A command named as typed still comes before a frame named alike.
  const named = commandEntries({
    board: board(),
    frames: [item("frame", 0, 0, { text: "Undo", order: 0 })],
  });
  assert.equal(searchCommands(named, "undo")[0].id, "undo");
});
