import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { item } from "../src/model.js";
import { setLanguage } from "../src/i18n.js";
import { objectRelationships } from "../src/accessibility/object-relationships.js";

test("relationship descriptions preserve meaning, language changes and literal authored content", () => {
  const frame = item("frame", 0, 0, { text: "Review" });
  const root = item("note", 0, 0, {
    text: "<img src=x onerror=alert(1)>",
    lang: "en",
    parentId: frame.id,
    groupId: "first-group",
    mindMap: { parent: null },
  });
  const child = item("note", 0, 0, {
    text: "Bonjour",
    lang: "fr",
    parentId: frame.id,
    groupId: "first-group",
    mindMap: { parent: root.id },
  });
  const line = item("arrow", 0, 0, {
    startId: root.id,
    endId: child.id,
    startCap: "arrow",
    endCap: "none",
  });
  const descriptions = objectRelationships([frame, root, child, line]);
  const dom = new JSDOM(`<div>${descriptions.get(line.id)}</div>`);
  try {
    assert.equal(dom.window.document.querySelector("img"), null);
    assert.match(dom.window.document.body.textContent, /<img src=x/);
    assert.equal(
      dom.window.document.querySelector('[lang="fr"]').textContent,
      "Bonjour",
    );
    assert.match(
      dom.window.document.body.textContent,
      /Start: Arrowhead\. End: None/,
    );
    assert.match(descriptions.get(child.id), /Mind map parent:.*&lt;img/);
    assert.match(descriptions.get(root.id), /In frame:.*Review/);
    assert.match(descriptions.get(root.id), /Group 1: 2 visible objects/);
    assert.match(descriptions.get(frame.id), /Contains: 2 visible objects/);
  } finally {
    dom.window.close();
  }
});

test("relationships only name supplied visible objects and distinguish unattached ends in French", () => {
  const dom = new JSDOM();
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    setLanguage("fr");
    const line = item("arrow", 0, 0, {
      startId: "withheld-secret-id",
      parentId: "withheld-frame-id",
      groupId: "visible-group",
      endCap: "circle",
    });
    const description = objectRelationships([line]).get(line.id);
    assert.match(description, /Objet de départ : Objet masqué/);
    assert.match(description, /Objet d’arrivée : Extrémité libre/);
    assert.match(description, /Groupe 1 : 1 objet visible/);
    assert.ok(!description.includes("withheld"));
    assert.match(description, /Dans le cadre : Objet masqué/);
    assert.match(description, /Fin : Point/);
  } finally {
    setLanguage("en");
    globalThis.document = previous;
    dom.window.close();
  }
});

test("relationships are written only for the objects asked about, naming a frame once", () => {
  const frame = item("frame", 0, 0, { text: "Plan" });
  const notes = Array.from({ length: 1000 }, (_, n) =>
    item("note", n, 0, { text: `Idea ${n}`, parentId: frame.id }),
  );
  const replace = String.prototype.replace;
  let escaped = 0;
  String.prototype.replace = function (...args) {
    escaped++;
    return replace.apply(this, args);
  };
  let descriptions;
  try {
    descriptions = objectRelationships([frame, ...notes]);
    assert.ok(
      escaped < 10,
      `${escaped} strings escaped before any was asked for`,
    );
    assert.match(descriptions.get(notes[0].id), /In frame: Frame: .*Plan/);
    const once = escaped;
    assert.match(descriptions.get(notes[999].id), /In frame: Frame: .*Plan/);
    assert.ok(escaped - once < 5, "the frame's name is not written again");
  } finally {
    String.prototype.replace = replace;
  }
  assert.equal(descriptions.get("missing"), undefined);
});

test("an object says its colour, tags, connections, and open discussions", () => {
  const a = item("note", 0, 0, {
    text: "Alpha",
    color: "#eadcf0",
    tagIds: ["t1", "t2", "gone"],
  });
  const b = item("note", 0, 0, { text: "Beta", color: "#123456" });
  const box = item("rect", 0, 0, { text: "Box", color: "#ffffff" });
  const others = Array.from({ length: 7 }, (_, n) =>
    item("note", 0, 0, { text: `Leaf ${n}` }),
  );
  const lines = [
    item("arrow", 0, 0, { startId: a.id, endId: b.id }),
    item("arrow", 0, 0, { startId: box.id, endId: a.id }),
    ...others.map((o) => item("arrow", 0, 0, { startId: b.id, endId: o.id })),
    // A line with a free end connects nothing.
    item("arrow", 0, 0, { startId: box.id }),
  ];
  const tags = [
    { id: "t1", name: "Urgent <b>", color: "#c43b3b" },
    { id: "t2", name: "Idea", color: "#56822a" },
  ];
  const message = (deleted) => ({
    id: "m",
    authorId: "u",
    authorName: "U",
    text: "Hi",
    createdAt: 1,
    deleted,
  });
  const comments = [
    { id: "c1", anchorId: a.id, resolved: false, messages: [message()] },
    { id: "c2", anchorId: a.id, resolved: false, messages: [message()] },
    { id: "c3", anchorId: a.id, resolved: true, messages: [message()] },
    { id: "c4", anchorId: b.id, resolved: false, messages: [message(true)] },
  ];
  const items = [a, b, box, ...others, ...lines];
  const d = objectRelationships(items, { tags, comments });
  const alpha = d.get(a.id);
  assert.match(
    alpha,
    /^Lilac color\. Tags: <span data-user-content>Urgent &lt;b&gt;<\/span>, <span data-user-content>Idea<\/span>\./,
  );
  assert.match(alpha, /Connects to: .*Beta.*\. Connected from: .*Box.*\./);
  assert.match(alpha, /2 open discussions\./);
  const beta = d.get(b.id);
  // A colour of one's own has no name; a deleted message is no discussion.
  assert.doesNotMatch(beta, /color|discussion/);
  assert.match(beta, /Leaf 4.* and 2 more\./);
  assert.doesNotMatch(beta, /Leaf 5/);
  // A white shape says nothing of its colour.
  assert.doesNotMatch(d.get(box.id), /color/);
  assert.match(d.get(box.id), /^Connects to: .*Alpha.*\.$/);
  // Without the catalog or discussions, only what the objects hold is said.
  assert.doesNotMatch(objectRelationships(items).get(a.id), /Tag|discussion/);
  const dom = new JSDOM();
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    setLanguage("fr");
    const fr = objectRelationships(items, { tags, comments });
    assert.match(fr.get(a.id), /^Couleur lilas\. Étiquettes : /);
    assert.match(fr.get(a.id), /Relié à : .*Relié depuis : /);
    assert.match(fr.get(a.id), /2 discussions ouvertes\./);
    assert.match(fr.get(b.id), / et 2 autres\./);
  } finally {
    setLanguage("en");
    globalThis.document = previous;
    dom.window.close();
  }
});
