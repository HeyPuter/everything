import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { board, item } from "../src/model.js";
import { createMindMapUI } from "../src/mind-map-ui.js";
import { setLanguage, language, translateUI } from "../src/i18n.js";

function setup() {
  const dom = new JSDOM('<canvas tabindex="0"></canvas>', {
    url: "https://whiteboard.test",
  });
  const globals = Object.fromEntries(
    ["document", "localStorage", "NodeFilter"].map((key) => [
      key,
      globalThis[key],
    ]),
  );
  for (const key of Object.keys(globals)) globalThis[key] = dom.window[key];
  const previousLanguage = language;
  setLanguage("en");
  const b = board("Mind map languages");
  const node = (text, extra = {}) =>
    item("rect", 0, 0, {
      text,
      w: 200,
      h: 80,
      mindMap: {
        parent: null,
        direction: "right",
        auto: false,
        line: "curved",
      },
      ...extra,
    });
  const root = node("Root"),
    source = node("Move me", { mindMap: { ...root.mindMap, parent: root.id } }),
    french = node("Bonjour à tous.", { lang: "fr-CA" }),
    mixed = node('Hello. Bonjour à tous. <img src="bad">', {
      lang: "en-CA",
      textRuns: [{ start: 7, end: 22, style: { lang: "fr" } }],
    }),
    empty = node("", { lang: "fr" });
  b.items = [root, source, french, mixed, empty];
  const selected = new Set([source.id]);
  let writes = 0;
  const ui = createMindMapUI({
    board: () => b,
    source: () => source,
    finish() {},
    canEdit: () => true,
    mutate(fn) {
      fn();
      writes++;
    },
    select(ids) {
      selected.clear();
      for (const id of ids) selected.add(id);
    },
    focus() {},
    reveal() {},
    toast(message) {
      throw Error(message);
    },
    modal(title, html, configure) {
      const d = dom.window.document.createElement("dialog");
      d.innerHTML = `<h2>${title}</h2>${html}`;
      d.close = () => d.remove();
      dom.window.document.body.append(d);
      configure(d);
      translateUI(d);
      return d;
    },
  });
  return {
    doc: dom.window.document,
    w: dom.window,
    b,
    source,
    french,
    mixed,
    empty,
    ui,
    writes: () => writes,
    close() {
      setLanguage(previousLanguage);
      dom.window.close();
      for (const [key, value] of Object.entries(globals)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

test("mind-map parent choices preserve whole-node and passage languages while moving the branch", () => {
  const a = setup();
  try {
    a.ui.moveDialog();
    const french = a.doc.querySelector(`[data-mind-parent="${a.french.id}"]`);
    assert.equal(
      french.querySelector('[lang="fr-CA"]').textContent,
      "Bonjour à tous.",
    );
    const mixed = a.doc.querySelector(`[data-mind-parent="${a.mixed.id}"]`);
    assert.equal(
      mixed.querySelector('[lang="en-CA"]').textContent,
      a.mixed.text,
    );
    assert.equal(
      mixed.querySelector('[lang="fr"]').textContent,
      "Bonjour à tous.",
    );
    assert.equal(mixed.querySelector("img"), null);
    assert.equal(
      a.doc.querySelector(`[data-mind-parent="${a.empty.id}"] [lang]`),
      null,
    );
    const search = a.doc.querySelector("#mind-parent-search");
    search.value = "Bonjour";
    search.dispatchEvent(new a.w.Event("input"));
    assert.equal(a.doc.querySelectorAll("[data-mind-parent]").length, 2);
    a.doc.querySelector(`[data-mind-parent="${a.french.id}"]`).click();
    assert.equal(a.source.mindMap.parent, a.french.id);
    assert.equal(a.writes(), 1);
    assert.equal(a.french.lang, "fr-CA");
    assert.deepEqual(a.mixed.textRuns, [
      { start: 7, end: 22, style: { lang: "fr" } },
    ]);
    assert.equal(a.doc.querySelector("dialog"), null);
  } finally {
    a.close();
  }
});

test("a branch moved to a mind map in another frame joins that frame", () => {
  const dom = new JSDOM("<body></body>", { url: "https://whiteboard.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const b = board("Mind map frames");
    const node = (text, x, parent, extra = {}) =>
      item("rect", x, 250, {
        text,
        w: 200,
        h: 76,
        mindMap: { parent, direction: "right", auto: true, line: "curved" },
        ...extra,
      });
    const one = item("frame", 0, 0, { w: 900, h: 600, text: "One" }),
      two = item("frame", 1200, 0, { w: 900, h: 600, text: "Two" }),
      rootOne = node("Root one", 100, null, { parentId: one.id }),
      rootTwo = node("Root two", 1300, null, { parentId: two.id }),
      child = node("Child", 380, rootOne.id, { parentId: one.id, order: 1 }),
      grandchild = node("Grandchild", 660, child.id, {
        parentId: one.id,
        order: 1,
      });
    b.items = [one, two, rootOne, rootTwo, child, grandchild];
    const ui = createMindMapUI({
      board: () => b,
      source: () => child,
      finish() {},
      canEdit: () => true,
      mutate: (fn) => fn(),
      select() {},
      focus() {},
      reveal() {},
      toast(message) {
        throw Error(message);
      },
      modal(title, html, configure) {
        const d = dom.window.document.createElement("dialog");
        d.innerHTML = html;
        d.close = () => d.remove();
        dom.window.document.body.append(d);
        configure(d);
        return d;
      },
    });
    ui.moveDialog();
    dom.window.document
      .querySelector(`[data-mind-parent="${rootTwo.id}"]`)
      .click();
    assert.equal(child.mindMap.parent, rootTwo.id);
    assert.ok(child.x > two.x);
    assert.equal(child.parentId, two.id);
    assert.equal(grandchild.parentId, two.id);
    assert.equal(rootOne.parentId, one.id);
  } finally {
    dom.window.close();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("French parent controls keep tagged English text and translated empty-node names", () => {
  const a = setup();
  try {
    setLanguage("fr");
    a.ui.moveDialog();
    const mixed = a.doc.querySelector(`[data-mind-parent="${a.mixed.id}"]`);
    assert.equal(
      mixed.querySelector('[lang="en-CA"]').textContent,
      a.mixed.text,
    );
    assert.equal(
      mixed.querySelector('[lang="fr"]').textContent,
      "Bonjour à tous.",
    );
    const empty = a.doc.querySelector(`[data-mind-parent="${a.empty.id}"]`);
    assert.equal(empty.textContent, "Nœud sans titre");
    assert.equal(empty.querySelector("[lang]"), null);
    assert.equal(a.writes(), 0);
  } finally {
    a.close();
  }
});

test("new mind-map labels capture their generating language independently of parent declarations", () => {
  const dom = new JSDOM("<body></body>", { url: "https://whiteboard.test" });
  const previousLanguage = language;
  const globals = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
  };
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  const b = board("Generated mind map labels");
  let selected;
  const ui = createMindMapUI({
    board: () => b,
    source: () => b.items.find((i) => i.id === selected),
    center: () => ({ x: 0, y: 0 }),
    finish() {},
    canEdit: () => true,
    mutate: (fn) => fn(),
    select: (ids) => {
      selected = [...ids][0];
    },
    reveal() {},
    edit() {},
    focus() {},
    toast(message) {
      throw Error(message);
    },
  });
  try {
    setLanguage("en");
    ui.create();
    const root = b.items.find((i) => i.id === selected);
    assert.equal(root.text, "Central idea");
    assert.equal(root.lang, "en");
    root.lang = "de-DE";
    root.textRuns = [
      { start: 0, end: root.text.length, style: { lang: "es" } },
    ];
    const declared = structuredClone({
      text: root.text,
      lang: root.lang,
      textRuns: root.textRuns,
    });
    ui.add(false, "left");
    const child = b.items.find((i) => i.id === selected);
    assert.equal(child.text, "New idea");
    assert.equal(child.lang, "en");
    assert.equal(child.textRuns, undefined);
    assert.equal(child.mindMap.parent, root.id);
    assert.equal(child.mindMap.direction, "left");
    setLanguage("fr");
    ui.add(true);
    const sibling = b.items.find((i) => i.id === selected);
    assert.equal(sibling.text, "Nouvelle idée");
    assert.equal(sibling.lang, "fr");
    assert.equal(sibling.textRuns, undefined);
    assert.equal(sibling.mindMap.parent, root.id);
    assert.equal(child.lang, "en");
    assert.deepEqual(
      { text: root.text, lang: root.lang, textRuns: root.textRuns },
      declared,
    );
    ui.create();
    const frenchRoot = b.items.find((i) => i.id === selected);
    assert.equal(frenchRoot.text, "Idée centrale");
    assert.equal(frenchRoot.lang, "fr");
    delete frenchRoot.lang;
    frenchRoot.text = "Existing untagged content";
    ui.add();
    assert.equal(b.items.find((i) => i.id === selected).lang, "fr");
    assert.equal(frenchRoot.lang, undefined);
    assert.equal(frenchRoot.text, "Existing untagged content");
  } finally {
    setLanguage(previousLanguage);
    dom.window.close();
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("a root's branches reorder and make room only on their own side", async () => {
  const { applyMindLayout } = await import("../src/mind-map.js");
  const dom = new JSDOM('<canvas tabindex="0"></canvas>', {
    url: "https://whiteboard.test",
  });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const node = (text, mindMap, extra = {}) =>
      item("rect", 0, 0, {
        text,
        w: 200,
        h: 80,
        mindMap: {
          parent: null,
          direction: "right",
          auto: true,
          line: "curved",
          ...mindMap,
        },
        ...extra,
      });
    const b = board("Sides");
    const root = node("Root", {}, { w: 220, h: 90 });
    const a = node("A right", { parent: root.id }, { order: 1 });
    const left = node(
      "B left",
      { parent: root.id, direction: "left" },
      { order: 2 },
    );
    const c = node("C right", { parent: root.id }, { order: 3 });
    b.items = [root, a, left, c];
    applyMindLayout(b.items, root.id);
    let source = c,
      writes = 0;
    const ui = createMindMapUI({
      board: () => b,
      source: () => source,
      finish() {},
      canEdit: () => true,
      mutate(fn) {
        fn();
        writes++;
      },
      select() {},
      focus() {},
      reveal() {},
      edit() {},
      draw() {},
      toast(message) {
        throw Error(message);
      },
      modal() {},
    });
    const right = () =>
      b.items
        .filter(
          (i) =>
            i.mindMap.parent === root.id && i.mindMap.direction === "right",
        )
        .sort((x, y) => x.y - y.y)
        .map((i) => i.text);
    assert.deepEqual(right(), ["A right", "C right"]);
    ui.reorder(-1);
    assert.deepEqual(right(), ["C right", "A right"]);
    assert.equal(writes, 1);
    // The last branch on its side moves no further, past the other side.
    source = b.items.find((i) => i.text === "A right");
    ui.reorder(1);
    assert.deepEqual(right(), ["C right", "A right"]);
    assert.equal(writes, 1);
    // In a manual layout, a branch below the root goes under the root,
    // not past the branches to its right.
    root.mindMap.auto = false;
    source = root;
    ui.add(false, "down");
    const below = b.items.find(
      (i) => i.mindMap.parent === root.id && i.mindMap.direction === "down",
    );
    assert.equal(below.x + below.w / 2, root.x + root.w / 2);
    assert.ok(below.y > root.y + root.h);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
    dom.window.close();
  }
});
