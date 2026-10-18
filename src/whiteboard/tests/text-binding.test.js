import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { SharedDocument } from "../src/collaboration/document.js";
import { bindText } from "../src/collaboration/text-binding.js";
import { board, item } from "../src/model.js";

function fixture() {
  const dom = new JSDOM("<textarea></textarea>");
  const input = dom.window.document.querySelector("textarea");
  const shared = new SharedDocument();
  const session = {
    shared,
    readOnly: false,
    closed: false,
    publish: async () => {},
  };
  const b = board("Typing"),
    text = item("text", 0, 0, { text: "Draft" });
  input.value = "Draft";
  b.items.push(text);
  const event = (type) => input.dispatchEvent(new dom.window.Event(type));
  return {
    dom,
    input,
    shared,
    session,
    b,
    text,
    event,
    close() {
      shared.destroy();
      dom.window.close();
    },
  };
}

test("typing before a new shared object exists is replayed when its creation transaction arrives", () => {
  const app = fixture();
  try {
    const updates = [];
    const unbind = bindText(app.session, app.text.id, app.input, (value) =>
      updates.push(value),
    );
    app.input.value = "Typed immediately";
    app.event("input");
    assert.equal(app.shared.items.size, 0);
    app.shared.commit(app.b);
    assert.equal(app.shared.snapshot().items[0].text, "Typed immediately");
    assert.equal(updates.at(-1), "Typed immediately");
    assert.equal(app.input.value, "Typed immediately");
    app.input.value += " and later";
    app.event("input");
    assert.equal(app.shared.snapshot().items[0].text, app.input.value);
    unbind();
  } finally {
    app.close();
  }
});

test("pending text bindings detach without replay after navigation or an editor closes", () => {
  const app = fixture();
  try {
    const unbind = bindText(app.session, app.text.id, app.input, () =>
      assert.fail("Detached binding fired"),
    );
    app.input.value = "Closed draft";
    app.event("input");
    unbind();
    app.shared.commit(app.b);
    assert.equal(app.shared.snapshot().items[0].text, "Draft");
  } finally {
    app.close();
  }
});

test("IME composition survives deferred attachment and merges remote inserts without premature publication", () => {
  const app = fixture();
  const remote = new SharedDocument();
  try {
    const unbind = bindText(app.session, app.text.id, app.input, () => {});
    app.input.value = "Draft local";
    app.event("input");
    app.event("compositionstart");
    app.input.value = "Draft local 日本";
    app.event("input");
    app.shared.commit(app.b);
    assert.equal(app.shared.snapshot().items[0].text, "Draft local");
    remote.apply(app.shared.update());
    remote.text(app.text.id, "Remote Draft local");
    app.shared.apply(remote.update());
    assert.equal(app.input.value, "Draft local 日本");
    app.event("compositionend");
    assert.equal(
      app.shared.snapshot().items[0].text,
      "Remote Draft local 日本",
    );
    assert.equal(app.input.value, "Remote Draft local 日本");
    unbind();
  } finally {
    remote.destroy();
    app.close();
  }
});

test("an already-shared text binds immediately and read-only deferred input cannot change content", () => {
  const app = fixture();
  try {
    app.shared.commit(app.b);
    let unbind = bindText(app.session, app.text.id, app.input, () => {});
    app.input.value = "First input";
    app.event("input");
    assert.equal(app.shared.snapshot().items[0].text, "First input");
    unbind();
    const second = item("text", 0, 100, { text: "Protected" });
    app.b.items.push(second);
    unbind = bindText(app.session, second.id, app.input, () => {});
    app.input.value = "Unsent";
    app.event("input");
    app.session.readOnly = true;
    app.shared.commit(app.b);
    assert.equal(
      app.shared.snapshot().items.find((i) => i.id === second.id).text,
      "Protected",
    );
    unbind();
  } finally {
    app.close();
  }
});

test("remote text typed at the end of a selection or IME replacement stays outside it", () => {
  const app = fixture();
  const remote = new SharedDocument();
  try {
    app.b.items[0].text = app.input.value = "hello world";
    app.shared.commit(app.b);
    remote.apply(app.shared.update());
    const unbind = bindText(app.session, app.text.id, app.input, () => {});
    const receive = (value) => {
      remote.text(app.text.id, value);
      app.shared.apply(remote.update(app.shared.vector()));
    };
    // A selection keeps its extent; replacing it keeps the remote text.
    app.input.setSelectionRange(6, 11);
    receive("hello world!");
    assert.deepEqual(
      [app.input.selectionStart, app.input.selectionEnd],
      [6, 11],
    );
    app.input.setRangeText("there", 6, 11, "end");
    app.event("input");
    assert.equal(app.shared.snapshot().items[0].text, "hello there!");
    // Text inserted at the start of a selection goes before it.
    remote.apply(app.shared.update(remote.vector()));
    app.input.setSelectionRange(6, 11);
    receive("hello >there!");
    assert.deepEqual(
      [app.input.selectionStart, app.input.selectionEnd],
      [7, 12],
    );
    // A caret still moves past text inserted where it stands.
    app.input.setSelectionRange(13, 13);
    receive("hello >there!?");
    assert.deepEqual(
      [app.input.selectionStart, app.input.selectionEnd],
      [14, 14],
    );
    // A composition replacing a selection keeps text added after it.
    app.input.setSelectionRange(7, 12);
    app.event("compositionstart");
    app.input.value = "hello >世界!?";
    receive("hello >there!?.");
    receive("hello >there#!?.");
    app.event("compositionend");
    assert.equal(app.shared.snapshot().items[0].text, "hello >世界#!?.");
    assert.equal(app.input.value, "hello >世界#!?.");
    // A composition inserting at a caret still follows text typed there.
    app.input.setSelectionRange(9, 9);
    app.event("compositionstart");
    app.input.value = "hello >世界語#!?.";
    remote.apply(app.shared.update(remote.vector()));
    receive("hello >世界+#!?.");
    app.event("compositionend");
    assert.equal(app.shared.snapshot().items[0].text, "hello >世界+語#!?.");
    unbind();
  } finally {
    remote.destroy();
    app.close();
  }
});

test("a binding follows its object when another client replaces the object under the same ID", () => {
  const app = fixture();
  const remote = new SharedDocument();
  try {
    app.b.items[0].text = app.input.value = "Plan";
    app.shared.commit(app.b);
    remote.apply(app.shared.update());
    const changes = [];
    const unbind = bindText(app.session, app.text.id, app.input, (value) =>
      changes.push(value),
    );
    const receive = () => app.shared.apply(remote.update(app.shared.vector()));
    // Deleting the object and undoing at once replaces its entry.
    const snapshot = remote.snapshot();
    remote.commit({ ...snapshot, items: [] });
    remote.undo.undo();
    receive();
    assert.equal(app.shared.snapshot().items[0].text, "Plan");
    remote.text(app.text.id, "Plan for Q3");
    receive();
    assert.equal(app.input.value, "Plan for Q3");
    assert.equal(changes.at(-1), "Plan for Q3");
    app.input.value += "!";
    app.event("input");
    assert.equal(app.shared.snapshot().items[0].text, "Plan for Q3!");
    unbind();
    // Detaching also stops following the replaced object.
    remote.apply(app.shared.update(remote.vector()));
    remote.text(app.text.id, "Detached");
    receive();
    assert.equal(app.input.value, "Plan for Q3!");
  } finally {
    remote.destroy();
    app.close();
  }
});

test("typing projects the whole board once typing pauses, and at once when editing ends", async () => {
  const app = fixture();
  try {
    app.shared.commit(app.b);
    let publishes = 0;
    app.session.publish = async () => void publishes++;
    const changes = [];
    const unbind = bindText(app.session, app.text.id, app.input, (value) =>
      changes.push(value),
    );
    for (const letter of "abcde") {
      app.input.value += letter;
      app.event("input");
    }
    // The editor hears every change at once; the board waits.
    assert.equal(changes.at(-1), "Draftabcde");
    assert.equal(app.shared.snapshot().items[0].text, "Draftabcde");
    assert.equal(publishes, 0);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(publishes, 1);
    // Continuous typing still projects about once a second.
    const started = Date.now();
    while (Date.now() - started < 1100) {
      app.input.value += "x";
      app.event("input");
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(publishes >= 2, `Projections while typing: ${publishes}`);
    const before = publishes;
    app.input.value += "!";
    app.event("input");
    unbind();
    assert.equal(publishes, before + 1);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(publishes, before + 1);
  } finally {
    app.close();
  }
});

test("an editor bound again after a refused save shows the shared text and leaves the new document alone when unbound", () => {
  const dom = new JSDOM("<textarea></textarea>");
  const input = dom.window.document.querySelector("textarea");
  const b = board("Refused"),
    t = item("text", 0, 0, { text: "Agreed" });
  b.items = [t];
  const server = new SharedDocument();
  server.commit(b);
  const session = {
    shared: new SharedDocument(server.update()),
    readOnly: false,
    closed: false,
    publish: async () => {},
  };
  input.value = "Agreed";
  let unbind = bindText(session, t.id, input, () => {});
  input.value = "Agreed, refused words";
  input.dispatchEvent(new dom.window.Event("input"));
  // The worker refused the save: the session reloads the shared state.
  const previous = session.shared;
  session.shared = new SharedDocument(server.update());
  session.shared.undo.captureTimeout = 500;
  unbind();
  // Unbinding from the old document leaves the new one alone.
  assert.equal(session.shared.undo.captureTimeout, 500);
  previous.destroy();
  unbind = bindText(session, t.id, input, () => {}, { reload: true });
  assert.equal(input.value, "Agreed");
  input.value = "Agreed!";
  input.dispatchEvent(new dom.window.Event("input"));
  assert.equal(session.shared.snapshot().items[0].text, "Agreed!");
  unbind();
  session.shared.destroy();
  server.destroy();
  dom.window.close();
});

test("keys pressed while a refused save replaces the document are made again on the new one", () => {
  const dom = new JSDOM("<textarea></textarea>");
  const input = dom.window.document.querySelector("textarea");
  const b = board("Refused"),
    t = item("text", 0, 0, { text: "Agreed" });
  b.items = [t];
  const server = new SharedDocument();
  server.commit(b);
  const session = {
    shared: new SharedDocument(server.update()),
    readOnly: false,
    closed: false,
    publish: async () => {},
  };
  const type = (value) => {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new dom.window.Event("input"));
  };
  input.value = "Agreed";
  let unbind = bindText(session, t.id, input, () => {});
  type("Agreed, refused words");
  // The worker refused the save: the session replaces its document, and
  // the editor is bound to it only once the recovery has finished.
  const previous = session.shared;
  session.shared = new SharedDocument(server.update());
  previous.destroy();
  type("Agreed, refused words!");
  type("Agreed, refused words!!");
  const stranded = unbind();
  unbind = bindText(session, t.id, input, () => {}, {
    reload: true,
    stranded,
  });
  assert.equal(input.value, "Agreed!!");
  assert.equal(session.shared.snapshot().items[0].text, "Agreed!!");
  assert.equal(input.selectionStart, "Agreed!!".length);
  assert.equal(unbind(), undefined, "Nothing typed is left over");
  session.shared.destroy();
  server.destroy();
  dom.window.close();
});

test("typing in a shared text already over 20,000 characters keeps its end", () => {
  const app = fixture();
  try {
    const long = "a".repeat(20500) + "TAIL";
    app.text.text = long;
    app.shared.commit(app.b);
    app.shared.text(app.text.id, long.slice(1));
    const saved = app.shared.snapshot().items[0].text;
    assert.equal(saved.length, long.length - 1);
    assert.ok(saved.endsWith("TAIL"));
    // It is never made longer than it was.
    app.shared.text(app.text.id, "b".repeat(30000));
    assert.equal(app.shared.snapshot().items[0].text.length, 20503);
  } finally {
    app.close();
  }
});
