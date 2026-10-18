import test from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { board, item, validateBoard } from "../src/model.js";
import {
  SharedDocument,
  REPAIR,
  rebase,
} from "../src/collaboration/document.js";
import {
  encode,
  decode,
  hash,
  topology,
  keyPair,
  verify,
  workerURL,
} from "../src/collaboration/protocol.js";
import { CollaborationSession } from "../src/collaboration/session.js";
import { reactionKey } from "../src/facilitation/model.js";

import {
  environment,
  memoryStore,
  owner,
  editor,
  viewer,
} from "./collaboration-helpers.js";

test("rebased editors and saved baselines never share received objects or nested content", () => {
  const before = board("Together");
  const received = {
    ...before,
    items: [item("table", 0, 0, { cells: [["Original"]] })],
  };
  const local = rebase(before, before, received);
  const baseline = rebase(before, before, received);
  local.items[0].color = "#dce5f7";
  local.items[0].cells[0][0] = "Edited";
  assert.equal(baseline.items[0].color, received.items[0].color);
  assert.equal(baseline.items[0].cells[0][0], "Original");
  const document = new SharedDocument();
  try {
    document.commit(received);
    document.commit(rebase(local, baseline, document.snapshot()));
    assert.equal(document.snapshot().items[0].color, "#dce5f7");
    assert.equal(document.snapshot().items[0].cells[0][0], "Edited");
    const next = rebase(local, baseline, received);
    next.items[0].cells[0][0] = "Independent";
    assert.equal(local.items[0].cells[0][0], "Edited");
  } finally {
    document.destroy();
  }
  const pending = {
    ...before,
    items: [item("pen", 0, 0, { points: [[1, 2]] })],
  };
  const next = rebase(pending, before, received);
  next.items.find((i) => i.type === "pen").points[0][0] = 10;
  assert.equal(pending.items[0].points[0][0], 1);
});

function seed() {
  const b = board("Together");
  b.items = [item("note", 0, 0, { text: "Hello" }), item("rect", 300, 0)];
  const doc = new SharedDocument();
  doc.commit(b);
  doc.undo.clear();
  return { b, doc };
}
test("concurrent object properties and text merge despite reordered and duplicate packets; undo stays local", () => {
  const { b, doc } = seed(),
    a = new SharedDocument(doc.update()),
    c = new SharedDocument(doc.update());
  const left = a.snapshot(),
    right = c.snapshot();
  left.items[0].x = 70;
  right.items[0].color = "#ff0000";
  a.commit(left);
  c.commit(right);
  a.text(b.items[0].id, "Hello Alice");
  c.text(b.items[0].id, "Hello Bob");
  const au = a.update(),
    bu = c.update();
  a.apply(bu);
  a.apply(bu);
  c.apply(au);
  assert.deepEqual(a.snapshot(), c.snapshot());
  assert.equal(a.snapshot().items[0].x, 70);
  assert.equal(a.snapshot().items[0].color, "#ff0000");
  assert.match(a.snapshot().items[0].text, /Alice/);
  assert.match(a.snapshot().items[0].text, /Bob/);
  a.undo.undo();
  assert.doesNotMatch(a.snapshot().items[0].text, /Alice/);
  assert.match(a.snapshot().items[0].text, /Bob/);
  a.undo.undo();
  assert.equal(a.snapshot().items[0].x, 0);
  assert.equal(a.snapshot().items[0].color, "#ff0000");
  for (const d of [doc, a, c]) d.destroy();
});
test("simultaneous geometry stays coherent; deletion does not resurrect an edited object", () => {
  const { doc } = seed(),
    a = new SharedDocument(doc.update()),
    b = new SharedDocument(doc.update());
  const x = a.snapshot(),
    y = b.snapshot();
  Object.assign(x.items[0], { x: 10, y: 20 });
  Object.assign(y.items[0], { x: 30, y: 40 });
  a.commit(x);
  b.commit(y);
  const one = a.update(),
    two = b.update();
  a.apply(two);
  b.apply(one);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.ok(
    [
      [10, 20],
      [30, 40],
    ].some(
      ([x, y]) =>
        a.snapshot().items[0].x === x && a.snapshot().items[0].y === y,
    ),
  );
  const next = a.snapshot();
  next.items.shift();
  a.commit(next);
  b.text(y.items[0].id, "Concurrent edit");
  a.apply(b.update());
  b.apply(a.update());
  assert.equal(a.snapshot().items.length, 1);
  assert.deepEqual(a.snapshot(), b.snapshot());
  for (const d of [doc, a, b]) d.destroy();
});
test("remote updates preserve an in-progress local gesture without overwriting unrelated fields", () => {
  const { b, doc } = seed(),
    local = structuredClone(b),
    remote = structuredClone(b);
  local.items[0].x = 100;
  remote.items[1].text = "Remote";
  remote.items[0].color = "#ff0000";
  const next = rebase(local, b, remote);
  assert.equal(next.items[0].x, 100);
  assert.equal(next.items[1].text, "Remote");
  assert.equal(next.items[0].color, "#ff0000");
  doc.destroy();
});
test("rebasing preserves local layer changes and insertion positions without undoing remote-only ordering", () => {
  const before = board("Layers");
  before.items = ["a", "b", "c", "d"].map((id) => item("rect", 0, 0, { id }));
  const local = structuredClone(before),
    remote = structuredClone(before);
  const ids = (b) => b.items.map((i) => i.id);
  local.items = [
    local.items[2],
    local.items[0],
    local.items[1],
    local.items[3],
  ];
  remote.items[0].color = "#ff0000";
  remote.items.splice(3, 0, item("note", 10, 10, { id: "remote" }));
  const next = rebase(local, before, remote);
  assert.deepEqual(ids(next), ["c", "a", "b", "remote", "d"]);
  assert.equal(next.items[1].color, "#ff0000");

  // Deletions cannot resurrect objects, and new local objects retain their layers.
  remote.items = remote.items.filter((i) => i.id !== "b");
  local.items.splice(0, 0, item("arrow", 0, 0, { id: "back" }));
  local.items.splice(2, 0, item("rect", 0, 0, { id: "middle" }));
  local.items.push(item("note", 0, 0, { id: "front" }));
  assert.deepEqual(ids(rebase(local, before, remote)), [
    "back",
    "c",
    "middle",
    "a",
    "remote",
    "d",
    "front",
  ]);

  const unchangedOrder = structuredClone(before);
  unchangedOrder.items[0].x = 120;
  remote.items.reverse();
  const moved = rebase(unchangedOrder, before, remote);
  assert.deepEqual(ids(moved), ids(remote));
  assert.equal(moved.items.find((i) => i.id === "a").x, 120);
});
test("512-participant topology is connected and stays within 61 links, including relay failover", () => {
  const roster = Array.from({ length: 512 }, (_, i) => ({
    session: String(i).padStart(4, "0"),
  }));
  for (const people of [
    roster,
    roster.slice(1),
    roster.filter((_, i) => i % 32 > 1),
  ]) {
    const { edges, relays } = topology(people),
      reached = new Set(),
      todo = [people[0].session];
    while (todo.length) {
      const id = todo.pop();
      if (reached.has(id)) continue;
      reached.add(id);
      todo.push(...edges.get(id));
    }
    assert.equal(reached.size, people.length);
    for (const [id, links] of edges)
      assert.ok(links.size <= (relays.has(id) ? 61 : 2));
  }
});
test("lasting peer groups change only a newcomer's or leaver's links, within the same bounds", async () => {
  const { peerGroup } = await import("../worker/service.js");
  // Sessions join one after another, each given a group by the worker.
  const join = (roster, n) => [
    ...roster,
    {
      session: crypto.randomUUID(),
      topology: 2,
      group: peerGroup(roster),
      since: n,
    },
  ];
  let roster = [];
  for (let n = 0; n < 512; n++) roster = join(roster, n);
  const links = (people) => {
    const all = new Set();
    for (const [a, set] of topology(people).edges)
      for (const b of set) if (a < b) all.add(a + b);
    return all;
  };
  const changed = (a, b) =>
    [...a].filter((e) => !b.has(e)).length +
    [...b].filter((e) => !a.has(e)).length;
  for (const people of [roster, roster.slice(0, 300), roster.slice(1)]) {
    const { edges, relays } = topology(people),
      reached = new Set(),
      todo = [people[0].session];
    while (todo.length) {
      const id = todo.pop();
      if (reached.has(id)) continue;
      reached.add(id);
      todo.push(...edges.get(id));
    }
    assert.equal(reached.size, people.length);
    for (const [id, set] of edges)
      assert.ok(set.size <= (relays.has(id) ? 61 : 2));
  }
  const room = roster.slice(0, 300),
    before = links(room);
  // Someone joining links only to their group's two relays.
  assert.equal(changed(before, links(join(room, 1000))), 2);
  // Someone leaving takes only their own links, unless they relayed.
  const { relays } = topology(room);
  const member = room.findIndex((p) => !relays.has(p.session));
  assert.equal(changed(before, links(room.filter((_, i) => i !== member))), 2);
  const relay = room.findIndex((p) => relays.has(p.session));
  assert.ok(changed(before, links(room.filter((_, i) => i !== relay))) < 100);
  // A roster with anyone lacking a lasting group uses groups in ID order,
  // as clients from before lasting groups do.
  const mixed = room.map((p, i) => (i ? p : { session: p.session }));
  const plain = room.map((p) => ({ session: p.session }));
  assert.deepEqual(
    [...topology(mixed).relays].sort(),
    [...topology(plain).relays].sort(),
  );
});
// Changes every nested value in place, as the editor changes boards it is
// given.
function spoil(value) {
  if (Array.isArray(value)) {
    value.forEach(spoil);
    value.push("spoiled");
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(spoil);
    value.spoiled = true;
  }
}
// Edits made on either of two copies of a board, one keeping its objects as
// read, must project as the board read afresh. The edits replace nested
// values; in deep mode every snapshot is also changed throughout afterwards,
// as the editor changes boards.
function keepsObjects(deep) {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const b = board("Mind map", "mindmap");
  const frame = item("frame", 0, 600, { w: 800, h: 400, text: "Frame" });
  const notes = Array.from({ length: 12 }, (_, n) =>
    item("note", n * 60, 700, { text: `n${n}`, parentId: frame.id }),
  );
  const arrow = item("arrow", 0, 0, {
    w: 10,
    h: 10,
    startId: notes[0].id,
    endId: notes[1].id,
  });
  const table = item("table", 900, 0, {
    w: 300,
    h: 120,
    cells: [
      ["a", "b"],
      ["c", "d"],
    ],
  });
  const pen = item("pen", 0, 300, {
    w: 40,
    h: 20,
    points: [
      [0, 0],
      [20, 10],
      [40, 20],
    ],
  });
  b.items.push(frame, ...notes, arrow, table, pen);
  b.tags = [{ id: "t1", name: "One", color: "#c43b3b" }];
  notes[2].tagIds = ["t1"];
  notes[3].textRuns = [{ start: 0, end: 1, style: { bold: true } }];
  // Kept on the board for the edits below.
  const lasting = new Set([table.id, pen.id, b.items[0].id]);
  const doc = new SharedDocument();
  doc.commit(b);
  // Undo takes back only the edits below.
  doc.undo.clear();
  const other = new SharedDocument(doc.update());
  doc.cacheItems({ deep });
  // Snapshots of both are changed in deep mode, so both keep whole copies.
  if (deep) other.cacheItems({ deep });
  doc.snapshot();
  try {
    for (let step = 0; step < 400; step++) {
      const target = random() < 0.5 ? doc : other,
        next = target.snapshot(),
        pick = () => next.items[Math.floor(random() * next.items.length)],
        find = (test) => next.items.find(test),
        r = random();
      let commit = true;
      if (r < 0.2) {
        const i = pick();
        i.x += 10;
        i.y -= 5;
      } else if (r < 0.3 && next.items.length > 5) {
        const n = Math.floor(random() * next.items.length);
        if (!lasting.has(next.items[n].id)) next.items.splice(n, 1);
      } else if (r < 0.42)
        next.items.push(
          item("note", random() * 500, random() * 500, {
            text: "new",
            ...(random() < 0.5 ? { parentId: frame.id } : {}),
          }),
        );
      else if (r < 0.5) {
        next.tags =
          random() < 0.5
            ? []
            : [{ id: `t${step}`, name: `Tag ${step}`, color: "#56822a" }];
        // Objects can keep references to a removed tag, read as none.
        if (random() < 0.5) for (const i of next.items) delete i.tagIds;
      } else if (r < 0.55) {
        const tag = next.tags?.[0];
        if (tag) pick().tagIds = [tag.id];
      } else if (r < 0.6) pick().text = `edit ${step}`;
      else if (r < 0.65) {
        // Typing reaches only the object's text.
        target.text(pick().id, `typed ${step}`);
        commit = false;
      } else if (r < 0.7) {
        const i = find((i) => i.type === "note" && i.text.length > 1);
        if (i && random() < 0.5)
          i.textRuns = [{ start: 0, end: 1, style: { italic: true } }];
        else if (i) delete i.textRuns;
      } else if (r < 0.75) {
        const t = find((i) => i.type === "table");
        if (t) t.columnWidths = [100 + (step % 50), 200];
      } else if (r < 0.8) {
        const t = find((i) => i.type === "table");
        if (t) t.cells = [[`c${step}`, t.cells[0][1]], t.cells[1]];
      } else if (r < 0.85) {
        const p = find((i) => i.type === "pen");
        if (p) p.points = p.points.map(([x, y]) => [x, (y + step) % 20]);
      } else if (r < 0.9) {
        const node = find((i) => i.mindMap);
        if (node && random() < 0.5) node.x += 20;
        else if (node) node.mindCollapsed = !node.mindCollapsed;
      } else if (r < 0.95 && doc.undo.canUndo()) {
        doc.undo.undo();
        commit = false;
      } else if (r >= 0.95 && doc.undo.canRedo()) {
        doc.undo.redo();
        commit = false;
      }
      if (commit) target.commit(next);
      if (deep) spoil(next);
      doc.apply(other.update(doc.vector()));
      other.apply(doc.update(other.vector()));
      const fresh = new SharedDocument(doc.update()),
        expected = fresh.snapshot();
      fresh.destroy();
      for (const kept of [doc, other]) {
        const seen = kept.snapshot();
        assert.deepEqual(seen, expected, `step ${step}`);
        if (!deep) continue;
        spoil(seen);
        assert.deepEqual(kept.snapshot(), expected, `step ${step}, spoiled`);
      }
    }
  } finally {
    doc.destroy();
    other.destroy();
  }
}
test("a document that keeps its objects as read projects the same as one read afresh", () =>
  keepsObjects(false));
test("a document that keeps whole copies of its objects projects the same as one read afresh however its snapshots are changed", () =>
  keepsObjects(true));
test("objects read while a change is being made are read again after it", () => {
  const b = board("Typing");
  b.items.push(item("note", 0, 0, { text: "zero" }));
  const doc = new SharedDocument(),
    id = b.items[0].id,
    read = () => doc.snapshot().items[0].text;
  doc.commit(b);
  doc.cacheItems({ deep: true });
  try {
    doc.doc.transact(() => {
      doc.text(id, "one");
      assert.equal(read(), "one");
      doc.text(id, "two");
      assert.equal(read(), "two");
    });
    assert.equal(read(), "two");
  } finally {
    doc.destroy();
  }
});
test("worker address validation prevents token forwarding to arbitrary hosts", () => {
  assert.equal(
    workerURL("https://whiteboard-test.puter.work"),
    "https://whiteboard-test.puter.work",
  );
  for (const value of [
    "https://evil.test",
    "http://whiteboard.puter.work",
    "https://whiteboard.puter.work.evil.test",
    "https://user:secret@whiteboard.puter.work",
    "https://whiteboard.puter.work/api",
  ])
    assert.throws(() => workerURL(value));
});

test("shared validation rejects structurally invalid text even when its JSON projection looks valid", () => {
  const { b, doc } = seed();
  doc.items
    .get(b.items[0].id)
    .set("text", "Looks like a note, but is not collaborative text");
  assert.throws(() => doc.validate(), /structure/);
  doc.destroy();
});

test("shared validation rejects geometry keys and labels that would change or break objects on every client", () => {
  const { b, doc } = seed();
  const entry = doc.items.get(b.items[0].id),
    geometry = entry.get("geometry");
  try {
    entry.set("geometry", { ...geometry, id: "spoofed" });
    assert.throws(() => doc.validate(), /geometry/);
    entry.set("geometry", { ...geometry, crop: undefined });
    doc.validate();
    entry.set("geometry", geometry);
    for (const [key, value] of [
      ["fileName", 42],
      ["url", 7],
      ["mimeType", {}],
      ["size", -1],
      ["size", "large"],
    ]) {
      entry.set(key, value);
      assert.throws(() => doc.validate(), /invalid object/, key);
      entry.delete(key);
    }
    entry.set("fileName", "notes.txt");
    entry.set("size", 12);
    doc.validate();
  } finally {
    doc.destroy();
  }
});

test("late movement previews cannot overwrite a newer committed action", () => {
  const env = environment(),
    { doc } = seed();
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: "test",
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  session.shared.apply(doc.update());
  const ticket = { session: "remote", user: editor.uuid, role: "editor" };
  const data = {
    cursor: { x: 3, y: 4 },
    selection: [],
    preview: [{ id: "moving", x: 10, y: 10, w: 50, h: 50 }],
  };
  try {
    session.receive("presence", data, ticket, 2);
    session.receive("committed", {}, ticket, 5);
    session.receive("edit", { update: encode(doc.update()) }, ticket, 3);
    session.receive("presence", data, ticket, 4);
    assert.equal(session.people.get("remote").preview.length, 0);
  } finally {
    session.close();
    doc.destroy();
  }
});

test("a finished move stays where it was dropped until its edit arrives", async () => {
  const env = environment(),
    { doc } = seed();
  let activity = 0;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: "test",
    user: owner,
    store: memoryStore(),
    changed() {},
    activity: () => activity++,
    status() {},
  });
  session.shared.apply(doc.update());
  let synchronized = 0;
  session.synchronize = async () => void synchronized++;
  const ticket = { session: "remote", user: editor.uuid, role: "editor" };
  const moving = [{ id: "moving", x: 10, y: 10, w: 50, h: 50 }];
  const presence = (sequence, extra) =>
    session.receive(
      "presence",
      { cursor: { x: 3, y: 4 }, selection: [], preview: [], ...extra },
      ticket,
      sequence,
    );
  const shown = () => session.people.get("remote").preview;
  try {
    presence(1, { preview: moving });
    // Dropped: the gesture ended, and its edit is on its way.
    presence(2, { settling: true });
    assert.deepEqual(shown(), moving);
    presence(3, { settling: true, cursor: { x: 9, y: 9 } });
    assert.deepEqual(shown(), moving, "the cursor moving on keeps it");
    // The unordered presence channel may deliver an older gesture afterward.
    presence(2, { cursor: { x: 1, y: 1 }, preview: [] });
    assert.equal(session.people.get("remote").sequence, 3);
    assert.deepEqual(session.people.get("remote").cursor, { x: 9, y: 9 });
    assert.deepEqual(shown(), moving, "older presence cannot end the preview");
    // The notice that the edit was saved ends it once the board has it.
    session.receive("committed", {}, ticket, 4);
    assert.deepEqual(shown(), moving);
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(synchronized, 1);
    assert.deepEqual(shown(), []);
    assert.ok(activity > 0, "the board is drawn again");
    // A cancelled gesture ends at once.
    presence(5, { preview: moving });
    presence(6);
    assert.deepEqual(shown(), []);
    // And a kept preview that ran out does not come back.
    presence(7, { preview: moving });
    presence(8, { settling: true });
    for (const h of session.people.get("remote").held) h.until = Date.now() - 1;
    presence(9, { settling: true });
    assert.deepEqual(shown(), []);
  } finally {
    session.close();
    doc.destroy();
  }
});

async function room(env) {
  const { b, doc } = seed();
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  return b;
}
async function invite(env, b, user, role = "editor") {
  const { token } = await env.service.call(owner, {
    op: "invite",
    room: b.id,
    role,
  });
  await env.service.call(user, { op: "join", room: b.id, token });
  return token;
}
test("peer document updates require a genuine worker receipt for the exact edit", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  env.dropEvents = true;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  let other;
  try {
    await session.start();
    other = new SharedDocument(session.shared.update());
    const vector = other.vector();
    other.text(b.items[0].id, "Accepted text");
    const update = other.update(vector),
      encoded = encode(update);
    const ticket = { session: "remote", user: editor.uuid, role: "editor" };
    await session.receive("edit", { update: encoded }, ticket, 1);
    assert.equal(
      session.shared.snapshot().items[0].text,
      "Hello",
      "Unacknowledged peer edits cannot change the document",
    );
    const accepted = await env.service.call(editor, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encoded,
    });
    await session.receive(
      "edit",
      {
        update: encoded,
        receipt: accepted.receipt,
        receiptProof: accepted.receiptProof,
      },
      ticket,
      2,
    );
    assert.equal(session.shared.snapshot().items[0].text, "Accepted text");
    other.text(b.items[0].id, "Tampered text");
    await session.receive(
      "edit",
      {
        update: encode(other.update(vector)),
        receipt: accepted.receipt,
        receiptProof: accepted.receiptProof,
      },
      ticket,
      3,
    );
    assert.equal(
      session.shared.snapshot().items[0].text,
      "Accepted text",
      "A receipt cannot authorize different update bytes",
    );
  } finally {
    session.close();
    other?.destroy();
  }
});
test("a save whose edit already arrived over a peer link is not read back from the worker", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  env.dropEvents = true;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  let other;
  const syncs = () =>
    env.calls.filter((c) => c.op === "sync" && c.user === owner.uuid).length;
  const ticket = { session: "remote", user: editor.uuid, role: "editor" };
  const settle = () => new Promise((r) => setTimeout(r, 260));
  // A sync that follows the 200 ms check-in delay, waited for rather than
  // timed, so a busy test machine does not fail the test.
  const settled = async (ready) => {
    for (let n = 0; n < 150 && !ready(); n++)
      await new Promise((r) => setTimeout(r, 20));
  };
  try {
    await session.start();
    other = new SharedDocument(session.shared.update());
    const save = async (text) => {
      const vector = other.vector();
      other.text(b.items[0].id, text);
      const update = other.update(vector);
      const { receipt, receiptProof } = await env.service.call(editor, {
        op: "commit",
        room: b.id,
        id: await hash(update),
        update: encode(update),
      });
      return { update: encode(update), receipt, receiptProof };
    };
    const delivered = await save("Over the link");
    const before = syncs();
    await session.receive("edit", delivered, ticket, 1);
    await session.receive("committed", { id: delivered.receipt.id }, ticket, 2);
    await settle();
    assert.equal(syncs(), before);
    assert.equal(session.shared.snapshot().items[0].text, "Over the link");
    // An edit that never arrived, as one too large for a peer packet, is
    // read from the worker.
    const missed = await save("Only on the worker");
    await session.receive("committed", { id: missed.receipt.id }, ticket, 3);
    await settled(
      () =>
        syncs() > before &&
        session.shared.snapshot().items[0].text === "Only on the worker",
    );
    assert.equal(syncs(), before + 1);
    assert.equal(session.shared.snapshot().items[0].text, "Only on the worker");
  } finally {
    session.close();
    other?.destroy();
  }
});
test("a finished move stays shown until an edit that moves it arrives, not just the author's previous one", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  env.dropEvents = true;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  let other;
  const ticket = { session: "remote", user: editor.uuid, role: "editor" };
  const [note, rect] = b.items;
  let sequence = 0;
  const presence = (preview) =>
    session.receive(
      "presence",
      { cursor: { x: 3, y: 4 }, selection: [], preview, settling: true },
      ticket,
      ++sequence,
    );
  const moved = (i, x) => ({
    id: i.id,
    x,
    y: i.y,
    w: i.w,
    h: i.h,
    rotation: 0,
  });
  const shown = () =>
    session.people
      .get("remote")
      .preview.map((i) => i.id)
      .sort();
  const save = async (id, x) => {
    const vector = other.vector(),
      next = other.snapshot();
    next.items.find((i) => i.id === id).x = x;
    other.commit(next);
    const update = other.update(vector);
    const { receipt, receiptProof } = await env.service.call(editor, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    });
    return { update: encode(update), receipt, receiptProof };
  };
  try {
    await session.start();
    other = new SharedDocument(session.shared.update());
    session.synchronize = async () => {};
    // The note is moved and let go, then the shape, before either is saved.
    await presence([moved(note, 500)]);
    await presence([]);
    await presence([moved(rect, 900)]);
    await presence([]);
    assert.deepEqual(shown(), [note.id, rect.id].sort());
    // The note's edit arrives, with its notice: the shape stays where it
    // was let go, as its own edit waits for a later upload.
    const first = await save(note.id, 500);
    await session.receive("edit", first, ticket, ++sequence);
    await session.receive(
      "committed",
      { id: first.receipt.id },
      ticket,
      ++sequence,
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(shown(), [rect.id]);
    // Its own edit then shows it as saved.
    const second = await save(rect.id, 900);
    await session.receive("edit", second, ticket, ++sequence);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(shown(), []);
  } finally {
    session.close();
    other?.destroy();
  }
});
test("a notice whose edit arrives with it, or a failed poll, leaves later polls plain", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  env.dropEvents = true;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  let other;
  const lastSync = () =>
    env.calls.filter((c) => c.op === "sync" && c.user === owner.uuid).at(-1);
  try {
    await session.start();
    other = new SharedDocument(session.shared.update());
    const vector = other.vector();
    other.text(b.items[0].id, "Over the link");
    const update = other.update(vector);
    const { receipt, receiptProof, serverTime } = await env.service.call(
      editor,
      {
        op: "commit",
        room: b.id,
        id: await hash(update),
        update: encode(update),
      },
    );
    const ticket = { session: "remote", user: editor.uuid, role: "editor" };
    // Sent together, the notice is handled while the edit is still being
    // verified.
    await Promise.all([
      session.receive(
        "edit",
        { update: encode(update), receipt, receiptProof },
        ticket,
        1,
      ),
      session.receive(
        "committed",
        { id: receipt.id, at: serverTime },
        ticket,
        2,
      ),
    ]);
    await new Promise((r) => setTimeout(r, 260));
    assert.equal(session.shared.snapshot().items[0].text, "Over the link");
    // Each poll asking for a fresh read would have the worker list the
    // board's log again.
    await session.synchronize();
    assert.equal(lastSync().noticed, undefined);
    assert.equal(lastSync().after, undefined);
    env.offline = true;
    await session.synchronize().catch(() => {});
    env.offline = false;
    await session.synchronize();
    assert.equal(lastSync().noticed, undefined);
  } finally {
    session.close();
    other?.destroy();
  }
});
test("in a large room a relay that reads an edit no peer announced asks the others to read it", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  env.dropEvents = true;
  const make = (user) =>
    new CollaborationSession({
      puter: env.sdk(user),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user,
      store: memoryStore(),
      changed() {},
      activity() {},
      status() {},
    });
  const relay = make(owner),
    member = make(owner);
  const sent = [];
  try {
    await relay.start();
    await member.start();
    relay.peers?.close();
    relay.peers = {
      isRelay: true,
      links: new Map(),
      async broadcast(kind, data) {
        sent.push({ kind, data });
      },
      close() {},
    };
    relay.roster = Array.from({ length: 20 }, (_, n) => ({ session: `s${n}` }));
    // An edit saved without any peer announcing it, as through the API.
    const { update } = await env.service.call(editor, {
      op: "sync",
      room: b.id,
    });
    const doc = new SharedDocument(decode(update)),
      vector = doc.vector();
    doc.text(b.items[0].id, "Saved elsewhere");
    const edit = doc.update(vector);
    doc.destroy();
    await env.service.call(editor, {
      op: "commit",
      room: b.id,
      id: await hash(edit),
      update: encode(edit),
    });
    await relay.synchronize();
    // With the time of its read, so the others' worker instances read the
    // board again too, not a copy from before the edit.
    assert.deepEqual(sent, [
      {
        kind: "committed",
        data: { nudge: true, at: sent[0]?.data.at },
      },
    ]);
    assert.ok(Number.isFinite(sent[0].data.at));
    await relay.synchronize();
    assert.equal(sent.length, 1, "Nothing new, nothing asked");
    // Others read the board when asked.
    const ticket = { session: "relay", user: owner.uuid, role: "owner" };
    await member.receive("committed", sent[0].data, ticket, 1);
    for (
      let n = 0;
      n < 100 && member.shared.snapshot().items[0].text !== "Saved elsewhere";
      n++
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(member.shared.snapshot().items[0].text, "Saved elsewhere");
  } finally {
    relay.close();
    member.close();
  }
});
test("only a relay's request to read the board makes a member synchronize", async () => {
  const env = environment(),
    b = await room(env);
  env.dropEvents = true;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  const syncs = () =>
    env.calls.filter((c) => c.op === "sync" && c.user === owner.uuid).length;
  const settle = () => new Promise((r) => setTimeout(r, 260));
  // A sync that follows the 200 ms check-in delay, waited for rather than
  // timed, so a busy test machine does not fail the test.
  const settled = async (ready) => {
    for (let n = 0; n < 150 && !ready(); n++)
      await new Promise((r) => setTimeout(r, 20));
  };
  try {
    await session.start();
    session.peers?.close();
    session.peers = {
      isRelay: false,
      links: new Map(),
      plan: { relays: new Set(["relay"]) },
      async broadcast() {},
      close() {},
    };
    const before = syncs();
    await session.receive(
      "committed",
      { nudge: true, at: Date.now() },
      { session: "member", user: editor.uuid, role: "editor" },
      1,
    );
    await settle();
    assert.equal(syncs(), before, "A member's request is not a relay's");
    await session.receive(
      "committed",
      { nudge: true, at: Date.now() },
      { session: "relay", user: editor.uuid, role: "editor" },
      1,
    );
    await settled(() => syncs() > before);
    assert.equal(syncs(), before + 1);
  } finally {
    session.close();
  }
});
test("told of a save by a board event, a synchronization names its record and asks again for one its worker instance still lacks", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  const { BoardService: Other } =
    await import("../worker/service.js?instance=lagging");
  const B = new Other(env.service.puter, {
    now: () => Date.now(),
    org: env.service.org,
  });
  env.service.now = () => Date.now();
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  const kv = env.service.puter.kv,
    list = kv.list;
  let hidden = null;
  kv.list = async (...args) => {
    const page = await list.apply(kv, args);
    page.items = page.items.filter(
      (i) => !hidden || !(typeof i === "string" ? i : i.key).endsWith(hidden),
    );
    return page;
  };
  try {
    await session.start();
    const { update } = await env.service.call(editor, {
      op: "sync",
      room: b.id,
    });
    const doc = new SharedDocument(decode(update)),
      vector = doc.vector();
    doc.text(b.items[0].id, "Named");
    const edit = doc.update(vector);
    doc.destroy();
    const id = await hash(edit);
    const named = () =>
      env.calls.filter(
        (c) => c.op === "sync" && c.user === owner.uuid && c.ids?.includes(id),
      );
    // Saved through another instance, whose record this one's listings do
    // not show yet.
    hidden = id;
    await B.call(editor, {
      op: "commit",
      room: b.id,
      id,
      update: encode(edit),
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(named().length, 1, "Asked once, naming the record");
    assert.equal(named()[0].noticed, true);
    assert.equal(session.shared.snapshot().items[0].text, "Hello");
    // Asked again a second later, when the record can be listed.
    hidden = null;
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(named().length, 2, "Asked again");
    assert.equal(session.shared.snapshot().items[0].text, "Named");
    // Nothing missing now, so nothing more is asked.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(named().length, 2);
  } finally {
    kv.list = list;
    session.close();
  }
});
test("a session is ready for edits once synchronized and recording them, before its check-in and first upload", async () => {
  const env = environment(),
    b = await room(env);
  const order = [];
  const call = env.service.call.bind(env.service);
  env.service.call = async (identity, input) => {
    order.push(input.op);
    return call(identity, input);
  };
  let readyAt = null;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
    ready() {
      readyAt = [...order];
      // An edit made at once is recorded and uploaded.
      const next = session.shared.snapshot();
      next.items[0].text = "Early";
      session.shared.commit(next);
    },
  });
  try {
    await session.start();
    assert.deepEqual(
      readyAt,
      ["join", "sync"],
      "Ready right after synchronizing",
    );
    assert.equal(session.pending.size, 0, "The early edit was uploaded");
    const { update } = await call(owner, { op: "sync", room: b.id });
    const doc = new SharedDocument(decode(update));
    assert.equal(doc.snapshot().items[0].text, "Early");
    doc.destroy();
  } finally {
    session.close();
  }
});
test("worker isolates membership, identifies contributors, retries idempotently, and rejects viewers", async () => {
  const env = environment(),
    b = await room(env);
  await assert.rejects(env.service.call(editor, { op: "sync", room: b.id }), {
    status: 403,
  });
  await invite(env, b, editor);
  await invite(env, b, viewer, "viewer");
  const base = await env.service.call(editor, { op: "sync", room: b.id });
  const doc = new SharedDocument(decode(base.update)),
    vector = doc.vector();
  doc.text(b.items[0].id, "Bob wrote this");
  const binary = doc.update(vector),
    update = encode(binary),
    id = await hash(binary);
  const request = { op: "commit", room: b.id, id, update, author: "owner" };
  await assert.rejects(env.service.call(viewer, request), { status: 403 });
  await Promise.all([
    env.service.call(editor, request),
    env.service.call(editor, request),
  ]);
  // Edits are recorded once, under time-ordered log keys.
  const rows = [...env.data].filter(([key]) => key.includes(":log:"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1].author, editor.uuid);
  await assert.rejects(
    env.service.call(editor, {
      op: "role",
      room: b.id,
      uuid: owner.uuid,
      role: "removed",
    }),
    { status: 403 },
  );
  const keys = await keyPair();
  const presence = await env.service.call(editor, {
    op: "presence",
    room: b.id,
    session: "bob-tab",
    publicKey: keys.publicKey,
    invite: "PEER",
  });
  const joined = await env.service.call(editor, { op: "join", room: b.id });
  assert.equal(
    await verify(joined.publicKey, presence.ticket, presence.signature),
    true,
  );
  assert.equal(presence.ticket.username, "Bob");
  await env.service.call(owner, {
    op: "role",
    room: b.id,
    uuid: editor.uuid,
    role: "removed",
  });
  await assert.rejects(env.service.call(editor, request), { status: 403 });
  assert.equal(env.data.has(`wb:${b.id}:presence:bob-tab`), false);
  doc.destroy();
});
test("invitation expiration and revocation do not remove existing members", async () => {
  const env = environment(),
    b = await room(env),
    token = await invite(env, b, editor);
  await env.service.call(owner, { op: "revoke-invite", room: b.id });
  await assert.rejects(
    env.service.call(viewer, { op: "join", room: b.id, token }),
    { status: 403 },
  );
  await env.service.call(editor, { op: "sync", room: b.id });
  assert.equal(
    (await env.service.call(editor, { op: "join", room: b.id, token })).member
      .role,
    "editor",
    "Existing members can reopen the original invitation after revocation",
  );
  const fresh = await env.service.call(owner, { op: "invite", room: b.id });
  env.now += 8 * 86400_000;
  await assert.rejects(
    env.service.call(viewer, { op: "join", room: b.id, token: fresh.token }),
    { status: 403 },
  );
  await env.service.call(owner, {
    op: "role",
    room: b.id,
    uuid: editor.uuid,
    role: "viewer",
  });
  assert.equal(
    (
      await env.service.call(editor, {
        op: "join",
        room: b.id,
        token: fresh.token,
      })
    ).member.role,
    "viewer",
    "Expired invitation links retain the member's current role",
  );
  await env.service.call(owner, {
    op: "role",
    room: b.id,
    uuid: editor.uuid,
    role: "removed",
  });
  for (const linkToken of [undefined, token, fresh.token])
    await assert.rejects(
      env.service.call(editor, { op: "join", room: b.id, token: linkToken }),
      { status: 403 },
    );
});
test("no one can change the owner's access while the board's details still name the previous owner", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  await invite(env, b, viewer, "facilitator");
  // Ownership moved on another worker instance; this one's board details
  // are a moment old and still name the previous owner.
  const key = `wb:${b.id}:member:${editor.uuid}`;
  env.data.set(key, { ...env.data.get(key), role: "owner" });
  await assert.rejects(
    env.service.call(viewer, {
      op: "role",
      room: b.id,
      uuid: editor.uuid,
      role: "removed",
    }),
    { status: 400 },
  );
  assert.equal(env.data.get(key).role, "owner");
});
test("facilitator invitations stop admitting facilitators once their creator no longer owns the board", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  const roomId = b.id;
  await env.service.call(owner, {
    op: "transfer",
    room: roomId,
    uuid: editor.uuid,
  });
  const [facilitator, member] = await Promise.all(
    ["facilitator", "editor"].map((role) =>
      env.service.call(editor, { op: "invite", room: roomId, role }),
    ),
  );
  await env.service.call(editor, {
    op: "transfer",
    room: roomId,
    uuid: owner.uuid,
  });
  await assert.rejects(
    env.service.call(viewer, {
      op: "join",
      room: roomId,
      token: facilitator.token,
    }),
    { status: 403 },
  );
  // Their other invitations still work while they manage the board.
  assert.equal(
    (
      await env.service.call(viewer, {
        op: "join",
        room: roomId,
        token: member.token,
      })
    ).member.role,
    "editor",
  );
});
test("two independent sessions recover missed events and lost acknowledgements across reload", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  const stores = [memoryStore(), memoryStore()],
    states = [],
    statuses = [];
  const make = (user, i) =>
    new CollaborationSession({
      puter: env.sdk(user),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user,
      store: stores[i],
      changed: (b) => {
        states[i] = b;
      },
      activity() {},
      status: (s) => statuses.push(s),
    });
  const a = make(owner, 0),
    c = make(editor, 1);
  try {
    await a.start();
    await c.start();
    env.dropEvents = true;
    const ab = structuredClone(states[0]),
      cb = structuredClone(states[1]);
    ab.items[0].x = 200;
    cb.items[1].text = "Bob's rectangle";
    await Promise.all([a.commit(ab, states[0]), c.commit(cb, states[1])]);
    await Promise.all([a.flush(), c.flush()]);
    await Promise.all([a.synchronize(), c.synchronize()]);
    assert.deepEqual(states[0], states[1]);
    assert.equal(states[0].items[0].x, 200);
    assert.equal(states[0].items[1].text, "Bob's rectangle");
    env.offline = true;
    const offline = structuredClone(states[1]);
    offline.items[0].text = "Saved offline";
    await c.commit(offline, states[1]);
    await assert.rejects(c.flush());
    assert.ok(c.unsaved);
    c.close();
    env.offline = false;
    env.lostAck = true;
    const recovered = make(editor, 1);
    try {
      await assert.rejects(recovered.start());
      assert.ok(recovered.pending.size);
      await recovered.flush();
      await a.synchronize();
      assert.equal(states[0].items[0].text, "Saved offline");
      assert.equal(recovered.unsaved, false);
      assert.equal(
        [...stores[1].rows.values()].filter((r) => r.kind === "update").length,
        0,
      );
    } finally {
      recovered.close();
    }
  } finally {
    a.close();
    c.close();
  }
});
test("more than one batch of offline edits saves after a reload", async () => {
  const env = environment(),
    b = await room(env);
  // IndexedDB returns rows in key order, and keys are content hashes.
  const store = memoryStore(),
    read = store.collaborationRows;
  store.collaborationRows = async (scope) =>
    (await read(scope)).sort((x, y) => (x.id < y.id ? -1 : 1));
  const make = () =>
    new CollaborationSession({
      puter: env.sdk(owner),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user: owner,
      store,
      changed() {},
      activity() {},
      status() {},
    });
  env.dropEvents = true;
  const first = make();
  await first.start();
  env.offline = true;
  for (let n = 1; n <= 200; n++) {
    const before = first.shared.snapshot(),
      next = structuredClone(before);
    next.items[0].x = n;
    await first.commit(next, before);
  }
  await first.queue;
  first.close();
  env.offline = false;
  const reopened = make();
  try {
    await reopened.start();
    await reopened.flush();
    assert.equal(reopened.pending.size, 0);
    const { doc } = await env.service.load(b.id);
    assert.equal(doc.snapshot().items[0].x, 200);
    doc.destroy();
  } finally {
    reopened.close();
  }
});
test("a backlog larger than one upload round continues without waiting for a retry", async () => {
  const env = environment(),
    b = await room(env);
  const make = (store) =>
    new CollaborationSession({
      puter: env.sdk(owner),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user: owner,
      store,
      changed() {},
      activity() {},
      status() {},
    });
  env.dropEvents = true;
  const store = memoryStore(),
    session = make(store);
  await session.start();
  env.offline = true;
  for (let n = 1; n <= 600; n++) {
    const before = session.shared.snapshot(),
      next = structuredClone(before);
    next.items[0].x = n;
    await session.commit(next, before);
  }
  await session.queue;
  clearTimeout(session.flushTimer);
  session.flushTimer = null;
  env.offline = false;
  const delays = [],
    schedule = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...rest) => {
    delays.push(delay);
    return schedule(() => {}, 0, ...rest);
  };
  try {
    await session.flush();
  } finally {
    globalThis.setTimeout = schedule;
  }
  try {
    // Four batches were saved; the rest follows at the usual pace.
    assert.ok(session.pending.size > 0);
    assert.equal(delays.at(-1), session.batchDelay());
    await session.flush();
    assert.equal(session.pending.size, 0);
    const { doc } = await env.service.load(b.id);
    assert.equal(doc.snapshot().items[0].x, 600);
    doc.destroy();
  } finally {
    session.close();
  }
});
test("shared layer changes persist, synchronize, and undo without removing another editor's changes", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  env.dropEvents = true;
  const make = (user) =>
    new CollaborationSession({
      puter: env.sdk(user),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user,
      store: memoryStore(),
      changed() {},
      activity() {},
      status() {},
    });
  const a = make(owner),
    c = make(editor),
    reopened = make(owner);
  const ids = (session) => session.shared.snapshot().items.map((i) => i.id);
  try {
    await a.start();
    await c.start();
    const before = a.shared.snapshot(),
      next = structuredClone(before);
    next.items.reverse();
    c.shared.text(b.items[0].id, "Remote text stays");
    await c.flush();
    await a.commit(next, before);
    assert.deepEqual(
      ids(a),
      [...b.items].reverse().map((i) => i.id),
    );
    await a.flush();
    await c.synchronize();
    assert.deepEqual(ids(c), ids(a));
    await reopened.start();
    assert.deepEqual(ids(reopened), ids(a), "Layer order survives reopening");
    a.shared.undo.undo();
    await a.flush();
    await c.synchronize();
    assert.deepEqual(
      ids(c),
      b.items.map((i) => i.id),
    );
    assert.equal(c.shared.snapshot().items[0].text, "Remote text stays");
    a.shared.undo.redo();
    await a.flush();
    await c.synchronize();
    assert.deepEqual(
      ids(c),
      [...b.items].reverse().map((i) => i.id),
    );
    assert.equal(c.shared.snapshot().items[1].text, "Remote text stays");
  } finally {
    a.close();
    c.close();
    reopened.close();
  }
});

test("shared media is stored in files and hydrated for export without embedding bytes in KV", async () => {
  const env = environment(),
    b = await room(env),
    store = memoryStore();
  let visible;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store,
    changed: (b) => {
      visible = b;
    },
    activity() {},
    status() {},
  });
  try {
    await session.start();
    const before = structuredClone(visible),
      next = structuredClone(visible);
    next.items.push(
      item("image", 600, 0, { src: "data:image/png;base64,AA==" }),
    );
    await session.commit(next, before);
    await session.flush();
    assert.equal(visible.items.at(-1).src, "data:image/png;base64,AA==");
    assert.ok([...env.files.keys()].some((key) => key.includes("/assets/")));
    const loaded = await env.service.load(b.id);
    assert.match(loaded.doc.snapshot().items.at(-1).src, /^asset:/);
    assert.equal(JSON.stringify([...env.data]).includes("data:image"), false);
    loaded.doc.destroy();
  } finally {
    session.close();
  }
});
test("presence tickets carry only public key coordinates and cap sessions per account", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, viewer, "viewer");
  const keys = await keyPair();
  const padded = { ...keys.publicKey, padding: "x".repeat(100_000) };
  const call = (user, session, publicKey = keys.publicKey) =>
    env.service.call(user, { op: "presence", room: b.id, session, publicKey });
  const first = await call(viewer, "cam-0", padded);
  assert.deepEqual(Object.keys(first.ticket.publicKey).sort(), [
    "crv",
    "kty",
    "x",
    "y",
  ]);
  assert.ok(JSON.stringify(first.roster).length < 2000);
  await assert.rejects(
    call(viewer, "cam-bad", { ...keys.publicKey, x: "short" }),
    { status: 400 },
  );
  for (let n = 1; n < 16; n++) await call(viewer, `cam-${n}`);
  await assert.rejects(call(viewer, "cam-16"), { status: 429 });
  assert.equal(env.data.has(`wb:${b.id}:presence:cam-16`), false);
  // Existing sessions keep renewing, and other participants can still join.
  await call(viewer, "cam-3");
  const alice = await call(owner, "alice-tab");
  assert.equal(alice.roster.length, 17);
  assert.deepEqual(
    alice.roster.map((p) => p.session),
    alice.roster.map((p) => p.session).sort(),
  );
});
test("the worker gives sessions that ask a lasting peer group, filling the fullest first", async () => {
  const env = environment(),
    b = await room(env);
  const { publicKey } = await keyPair();
  const call = (session, topology) =>
    env.service.call(owner, {
      op: "presence",
      room: b.id,
      session,
      publicKey,
      ...(topology ? { topology } : {}),
    });
  // Others already present: group 0 has room for one more, group 1 more.
  const present = (session, group) =>
    env.data.set(`wb:${b.id}:presence:${session}`, {
      room: b.id,
      session,
      user: "user-" + session,
      role: "editor",
      topology: 2,
      group,
      since: 1,
      expires: env.now + 90_000,
    });
  for (let n = 0; n < 31; n++) present(`a${n}`, 0);
  for (let n = 0; n < 10; n++) present(`b${n}`, 1);
  const first = (await call("mine-1", 2)).ticket;
  assert.equal(first.group, 0);
  assert.equal(first.since, env.now);
  assert.equal((await call("mine-2", 2)).ticket.group, 1);
  // A session keeps its group and join time while it checks in.
  env.now += 30_000;
  const again = (await call("mine-1", 2)).ticket;
  assert.equal(again.group, 0);
  assert.equal(again.since, first.since);
  // Clients that do not ask get no group.
  const plain = (await call("old-client")).ticket;
  assert.equal(plain.group, undefined);
  assert.equal(plain.topology, undefined);
});
test("commits rejected by shared validation report a client error", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  const base = await env.service.call(editor, { op: "sync", room: b.id });
  const doc = new SharedDocument(decode(base.update)),
    vector = doc.vector();
  doc.doc.getMap("unsupported").set("value", 1);
  const binary = doc.update(vector);
  await assert.rejects(
    env.service.call(editor, {
      op: "commit",
      room: b.id,
      id: await hash(binary),
      update: encode(binary),
    }),
    { status: 422 },
  );
  doc.destroy();
});
test("simultaneous additions past the object limit leave the board saveable", async () => {
  const env = environment();
  const b = board("Full");
  b.items = Array.from({ length: 4999 }, (_, n) => item("note", n * 10, 0));
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  await invite(env, b, editor);
  const read = async (user) =>
    (await env.service.call(user, { op: "sync", room: b.id })).update;
  const commit = async (user, state, change) => {
    const doc = new SharedDocument(decode(state)),
      vector = doc.vector(),
      next = doc.snapshot();
    change(next);
    doc.commit(next);
    const binary = doc.update(vector);
    doc.destroy();
    return env.service.call(user, {
      op: "commit",
      room: b.id,
      id: await hash(binary),
      update: encode(binary),
    });
  };
  const add = (x) => (next) => next.items.push(item("note", x, 500));
  // Two worker instances each check a commit against a board they read
  // before the other's, and both accept it.
  const { BoardService: Other } =
    await import("../worker/service.js?instance=limit");
  const other = new Other(env.service.puter, {
    now: () => env.now,
    org: env.service.org,
  });
  const [first, second] = [await read(owner), await read(editor)];
  (await other.load(b.id)).doc.destroy();
  await commit(owner, first, add(1));
  const binary = (() => {
    const doc = new SharedDocument(decode(second)),
      vector = doc.vector(),
      next = doc.snapshot();
    add(2)(next);
    doc.commit(next);
    const update = doc.update(vector);
    doc.destroy();
    return update;
  })();
  await other.call(editor, {
    op: "commit",
    room: b.id,
    id: await hash(binary),
    update: encode(binary),
  });
  env.now += 2000;
  const session = new CollaborationSession({
    puter: env.sdk(editor),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: editor,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    // Other edits still save; only adding more is refused.
    await commit(editor, await read(editor), (next) => {
      assert.equal(next.items.length, 5001);
      next.items[0].text = "Still saving";
    });
    await assert.rejects(commit(editor, await read(editor), add(3)), {
      status: 422,
    });
    // Participants still open and synchronize the board.
    await session.start();
    assert.equal(session.shared.snapshot().items.length, 5001);
    assert.equal(session.shared.snapshot().items[0].text, "Still saving");
    await commit(owner, await read(owner), (next) => next.items.pop());
    await session.synchronize();
    assert.equal(session.shared.snapshot().items.length, 5000);
  } finally {
    session.close();
  }
});
test("two people typing into one note past its length limit leave the board saveable", async () => {
  const env = environment();
  const b = board("Long");
  b.items = [
    item("note", 0, 0, { text: "x".repeat(4000) }),
    item("rect", 300, 0),
  ];
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  await invite(env, b, editor);
  const { BoardService: Other } =
    await import("../worker/service.js?instance=text");
  const other = new Other(env.service.puter, {
    now: () => env.now,
    org: env.service.org,
  });
  const read = async (user) =>
    decode((await env.service.call(user, { op: "sync", room: b.id })).update);
  const commit = async (service, user, state, change) => {
    const doc = new SharedDocument(state),
      vector = doc.vector();
    change(doc);
    const binary = doc.update(vector);
    doc.destroy();
    return service.call(user, {
      op: "commit",
      room: b.id,
      id: await hash(binary),
      update: encode(binary),
    });
  };
  const type = (words) => (doc) =>
    doc.text(b.items[0].id, doc.snapshot().items[0].text + words);
  // Each stays within 20,000 characters; together they pass it.
  const [first, second] = [await read(owner), await read(editor)];
  (await other.load(b.id)).doc.destroy();
  await commit(env.service, owner, first, type("a".repeat(15000)));
  await commit(other, editor, second, type("b".repeat(15000)));
  env.now += 2000;
  const state = await read(editor);
  const stored = new SharedDocument(state);
  assert.equal(stored.snapshot().items[0].text.length, 34000);
  stored.destroy();
  // Other edits still save; making the note longer still is refused.
  await commit(env.service, editor, state, (doc) => {
    const next = doc.snapshot();
    next.items[1].x = 400;
    doc.commit(next);
  });
  await assert.rejects(
    commit(env.service, editor, await read(editor), (doc) =>
      doc.items.get(b.items[0].id).get("text").insert(0, "c"),
    ),
    { status: 422 },
  );
  const session = new CollaborationSession({
    puter: env.sdk(editor),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: editor,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    await session.start();
    assert.equal(session.shared.snapshot().items[1].x, 400);
  } finally {
    session.close();
  }
});
test("a legacy table resize concurrent with a structural change remains valid", () => {
  const b = board("Tables");
  b.items = [
    item("table", 0, 0, {
      w: 600,
      h: 180,
      cells: [
        ["One", "Two", "Three"],
        ["A", "B", "C"],
      ],
    }),
  ];
  const base = new SharedDocument();
  base.commit(b);
  base.doc.transact(() =>
    base.items.get(b.items[0].id).set("cells", b.items[0].cells),
  );
  const a = new SharedDocument(base.update()),
    c = new SharedDocument(base.update());
  const resized = a.snapshot();
  resized.items[0].columnWidths = [300, 150, 150];
  a.commit(resized);
  const widened = c.snapshot();
  widened.items[0].cells.forEach((row) => row.push("New"));
  c.commit(widened);
  c.apply(a.update(c.vector()));
  c.validate();
  assert.equal(c.snapshot().items[0].cells[0].length, 4);
  for (const d of [base, a, c]) d.destroy();
});
test("an edit refused for the board's file limit says so rather than a conflict", async () => {
  const env = environment(),
    initial = board("Full");
  initial.items = [item("note", 0, 0, { text: "Hello" })];
  const seedDoc = new SharedDocument();
  seedDoc.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seedDoc.update()),
  });
  seedDoc.destroy();
  let state;
  const reasons = [];
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: initial.id,
    user: owner,
    store: memoryStore(),
    changed: (next) => {
      state = next;
    },
    activity() {},
    status() {},
    rejected: ({ reason } = {}) => reasons.push(reason),
  });
  try {
    await session.start();
    session.scheduleFlush = () => {};
    // The board can hold almost nothing more, and a large edit is kept as
    // a file that counts toward that.
    env.data.set(`wb:${initial.id}:assetbytes`, 1024 ** 3 - 10);
    const next = structuredClone(state);
    for (let k = 0; k < 20; k++)
      next.items.push(
        item("note", k * 300, 300, { text: "x".repeat(19_000) + k }),
      );
    await session.commit(next, state);
    await session.flush();
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /1 GB limit/);
  } finally {
    session.close?.();
  }
});

test("a refused edit is isolated and dropped, and the edits queued after it are made again on the shared state", async () => {
  const env = environment(),
    initial = board("Limits");
  const note = item("note", 0, 0, { text: "Hello" });
  initial.items = [note];
  initial.comments = [
    {
      id: "thread",
      x: 0,
      y: 0,
      resolved: false,
      messages: Array.from({ length: 99 }, (_, n) => ({
        id: `m${n}`,
        authorId: owner.uuid,
        authorName: owner.username,
        text: `Message ${n}`,
        createdAt: n,
      })),
    },
  ];
  const seedDoc = new SharedDocument();
  seedDoc.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seedDoc.update()),
  });
  seedDoc.destroy();
  await invite(env, initial, editor);
  const states = [],
    rejected = [];
  const make = (user, i) =>
    new CollaborationSession({
      puter: env.sdk(user),
      server: "https://whiteboard-test.puter.work",
      room: initial.id,
      user,
      store: memoryStore(),
      changed: (next) => {
        states[i] = next;
      },
      activity() {},
      status() {},
      rejected: () => rejected.push(i),
    });
  const a = make(owner, 0),
    c = make(editor, 1);
  const reply = (state, user, id) => {
    const next = structuredClone(state);
    next.comments[0].messages.push({
      id,
      authorId: user.uuid,
      authorName: user.username,
      text: id,
      createdAt: 500,
    });
    return next;
  };
  try {
    await a.start();
    await c.start();
    env.dropEvents = true;
    // Flush explicitly so a slow run cannot upload rows between the steps.
    a.scheduleFlush = c.scheduleFlush = () => {};
    await a.commit(reply(states[0], owner, "alice"), states[0]);
    await a.flush();
    const renamed = structuredClone(states[1]);
    renamed.items[0].text = "Bob's note";
    await c.commit(renamed, states[1]);
    const replied = reply(renamed, editor, "bob");
    await c.commit(replied, renamed);
    const kept = structuredClone(replied);
    kept.items[0].text = "Saved after the refusal";
    await c.commit(kept, replied);
    // Editing the refused reply goes with it.
    const edited = structuredClone(kept);
    edited.comments[0].messages.at(-1).text = "bob, edited";
    await c.commit(edited, kept);
    assert.equal(c.pending.size, 4);
    const first = c.shared;
    await c.flush();
    await c.flush();
    assert.deepEqual(rejected, [1]);
    assert.equal(c.pending.size, 0);
    // The replacement document gives the editor whole copies, as the first did.
    assert.ok(first.deep && c.shared !== first && c.shared.deep);
    const ids = states[1].comments[0].messages.map((m) => m.id);
    assert.ok(ids.includes("alice") && !ids.includes("bob"));
    // Only the refused reply is lost: the edit queued after it is made again
    // and saved.
    assert.equal(states[1].items[0].text, "Saved after the refusal");
    await a.synchronize();
    assert.equal(states[0].items[0].text, "Saved after the refusal");
    // Later edits save normally.
    const later = structuredClone(states[1]);
    later.items[0].x = 90;
    await c.commit(later, states[1]);
    await c.flush();
    assert.equal(c.pending.size, 0);
    await a.synchronize();
    assert.equal(states[0].items[0].text, "Saved after the refusal");
    assert.equal(states[0].items[0].x, 90);
    assert.equal(states[0].comments[0].messages.length, 100);
  } finally {
    a.close();
    c.close();
  }
});
test("no one can take up the positions of another participant's next edits, so accepted edits are never dropped", async () => {
  const env = environment(),
    initial = board("Together");
  initial.items = [item("note", 0, 0, { text: "Hello" })];
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  await invite(env, initial, viewer, "commenter");
  await invite(env, initial, editor, "editor");
  const commit = async (user, bytes) =>
    env.service.call(user, {
      op: "commit",
      room: initial.id,
      id: await hash(bytes),
      update: encode(bytes),
    });
  const sync = async (user) =>
    decode(
      (await env.service.call(user, { op: "sync", room: initial.id })).update,
    );
  // The editor saves one edit, then makes another that is not saved yet.
  const mine = new SharedDocument(await sync(editor));
  let vector = mine.vector(),
    next = mine.snapshot();
  next.items[0].x = 50;
  mine.commit(next);
  await commit(editor, mine.update(vector));
  env.now += 3000;
  vector = mine.vector();
  next = mine.snapshot();
  next.title = "Renamed";
  mine.commit(next);
  const unsaved = mine.update(vector);
  // A commenter reserves the next clocks of every client the board lists
  // with content nobody sees.
  const varint = (n) => {
    const out = [];
    for (; n > 127; n = Math.floor(n / 128)) out.push(128 | (n & 127));
    return [...out, n];
  };
  const state = Y.decodeStateVector(
    Y.encodeStateVectorFromUpdate(await sync(viewer)),
  );
  const squat = [...varint(state.size)];
  for (const [client, clock] of state)
    squat.push(
      ...varint(1),
      ...varint(client),
      ...varint(clock),
      0,
      ...varint(1_000_000),
    );
  squat.push(...varint(0));
  await assert.rejects(commit(viewer, new Uint8Array(squat)), {
    status: 422,
    message: /another participant's edits/,
  });
  env.now += 3000;
  assert.ok((await commit(editor, unsaved)).receipt);
  const { doc } = await env.service.load(initial.id);
  assert.equal(doc.snapshot().title, "Renamed");
  assert.equal(doc.snapshot().items[0].x, 50);
  doc.destroy();
  // Content under a client ID of the commenter's own is still saved.
  const own = [
    ...varint(1),
    ...varint(1),
    ...varint(0x7ffffff0),
    ...varint(0),
    0,
    ...varint(5),
    ...varint(0),
  ];
  assert.ok((await commit(viewer, new Uint8Array(own))).receipt);
  mine.destroy();
});

test("participants cannot rewrite content, workshop settings or others' entries with unchanged values, and commenter saves leave content untouched", async () => {
  const env = environment(),
    initial = board("Projected");
  const frame = item("frame", 0, 0, { w: 400, h: 300, text: "Frame" }),
    note = item("note", 20, 20, { text: "Inside", parentId: frame.id });
  initial.items = [frame, note];
  const reaction = reactionKey(editor.uuid, ["o", note.id]);
  initial.workshop = {
    settings: { lock: "open" },
    [reaction]: {
      by: editor.uuid,
      target: ["o", note.id],
      types: ["thumbs"],
      at: 1,
      name: editor.username,
    },
  };
  const seed = new SharedDocument();
  seed.commit(initial);
  // A concurrent frame deletion leaves the note's stored membership behind;
  // snapshots leave it out.
  seed.items.delete(frame.id);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  await invite(env, initial, viewer, "commenter");
  await invite(env, initial, editor, "editor");
  const rewrite = async (user, change) => {
    const { update } = await env.service.call(user, {
      op: "sync",
      room: initial.id,
    });
    const doc = new Y.Doc();
    doc.clientID = 0xfffffff0;
    Y.applyUpdate(doc, decode(update));
    const before = Y.encodeStateVector(doc);
    change(doc);
    const bytes = Y.encodeStateAsUpdate(doc, before);
    doc.destroy();
    return env.service.call(user, {
      op: "commit",
      room: initial.id,
      id: await hash(bytes),
      update: encode(bytes),
    });
  };
  const entry = (doc) => doc.getMap("items").get(note.id);
  await assert.rejects(
    rewrite(viewer, (doc) =>
      entry(doc).set("geometry", structuredClone(entry(doc).get("geometry"))),
    ),
    { status: 422 },
  );
  await assert.rejects(
    rewrite(viewer, (doc) => doc.getMap("board").set("title", "Projected")),
    { status: 422 },
  );
  // Editors are not facilitators: the same holds for workshop settings.
  await assert.rejects(
    rewrite(editor, (doc) =>
      doc.getMap("workshop").set("settings", { lock: "open" }),
    ),
    { status: 422 },
  );
  // Nor other participants' reactions, ballots or attendance.
  await assert.rejects(
    rewrite(viewer, (doc) =>
      doc
        .getMap("workshop")
        .set(reaction, structuredClone(doc.getMap("workshop").get(reaction))),
    ),
    { status: 422 },
  );
  // A commenter's own save writes only the discussion.
  let state;
  const session = new CollaborationSession({
    puter: env.sdk(viewer),
    server: "https://whiteboard-test.puter.work",
    room: initial.id,
    user: viewer,
    store: memoryStore(),
    changed: (next) => (state = next),
    activity() {},
    status() {},
    rejected: () => assert.fail("The comment was refused"),
  });
  try {
    await session.start();
    assert.equal(state.items[0].parentId, undefined);
    const next = structuredClone(state);
    next.comments = [
      {
        id: "thread",
        x: 0,
        y: 0,
        resolved: false,
        messages: [
          {
            id: "m",
            authorId: viewer.uuid,
            authorName: viewer.username,
            text: "A question",
            createdAt: 1,
          },
        ],
      },
    ];
    await session.commit(next, state);
    await session.flush();
    assert.equal(session.pending.size, 0);
  } finally {
    session.close();
  }
  const { doc } = await env.service.load(initial.id);
  try {
    assert.equal(doc.snapshot().comments[0].messages[0].text, "A question");
    assert.equal(doc.items.get(note.id).get("parentId"), frame.id);
  } finally {
    doc.destroy();
  }
});
test("comments stored in another field order or with empty fields do not get other people's saves refused", async () => {
  const env = environment(),
    initial = board("Stored");
  initial.items = [item("note", 0, 0, { text: "Note" })];
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  await invite(env, initial, viewer, "commenter");
  // The commenter writes their own discussion directly, as another client
  // could, with the body's and the pin's fields in another order and an
  // edit date stored as undefined.
  const { update } = await env.service.call(viewer, {
    op: "sync",
    room: initial.id,
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, decode(update));
  const vector = Y.encodeStateVector(doc);
  const thread = new Y.Map(),
    messages = new Y.Map(),
    message = new Y.Map();
  doc.getMap("comments").set("thread", thread);
  thread.set("position", { y: 4, x: 3 });
  thread.set("resolved", false);
  thread.set("messages", messages);
  messages.set("m", message);
  message.set("authorId", viewer.uuid);
  message.set("authorName", viewer.username);
  message.set("createdAt", env.now);
  message.set("editedAt", undefined);
  message.set("text", { textRuns: [], value: "Mine" });
  const bytes = Y.encodeStateAsUpdate(doc, vector);
  doc.destroy();
  await env.service.call(viewer, {
    op: "commit",
    room: initial.id,
    id: await hash(bytes),
    update: encode(bytes),
  });
  let state;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: initial.id,
    user: owner,
    store: memoryStore(),
    changed: (next) => (state = next),
    activity() {},
    status() {},
    rejected: () => assert.fail("The owner's save was refused"),
  });
  try {
    await session.start();
    assert.equal(state.comments[0].messages[0].text, "Mine");
    const next = structuredClone(state);
    next.title = "Renamed";
    await session.commit(next, state);
    await session.flush();
    assert.equal(session.pending.size, 0);
  } finally {
    session.close();
  }
  const { doc: saved } = await env.service.load(initial.id);
  try {
    assert.equal(saved.snapshot().title, "Renamed");
  } finally {
    saved.destroy();
  }
});
test("shared objects, tags and discussions keep one order whatever the device's language", () => {
  const initial = board("Order");
  const a = item("note", 0, 0, { text: "A" }),
    b = item("note", 0, 0, { text: "B" });
  a.id = "aa-note";
  b.id = "ab-note";
  initial.items = [a, b];
  initial.tags = [
    { id: "aa-tag", name: "Idea", color: "#dce5f7" },
    { id: "ab-tag", name: "idea", color: "#dce5f7" },
  ];
  const document = new SharedDocument();
  const compare = String.prototype.localeCompare;
  try {
    document.commit(initial);
    // Both objects get the same layer rank, so their IDs decide.
    for (const id of [a.id, b.id]) document.items.get(id).set("z", 0);
    // Danish sorts "aa" after "ab".
    String.prototype.localeCompare = function (other, ...rest) {
      return compare.call(this, other, "da", ...rest.slice(1));
    };
    const shared = document.snapshot();
    assert.deepEqual(
      shared.items.map((i) => i.id),
      ["aa-note", "ab-note"],
    );
    assert.deepEqual(
      shared.tags.map((t) => t.id),
      ["aa-tag"],
    );
  } finally {
    String.prototype.localeCompare = compare;
    document.destroy();
  }
});
test("a board whose state outgrows a single commit's limit still opens", () => {
  const initial = board("Large");
  initial.items = Array.from({ length: 450 }, (_, n) =>
    item("note", n * 10, 0, { text: String(n).padEnd(20000, " lorem ipsum") }),
  );
  const document = new SharedDocument();
  document.commit(initial);
  const state = encode(document.update());
  document.destroy();
  assert.ok(state.length > 8_000_000);
  const opened = new SharedDocument(decode(state));
  try {
    assert.equal(opened.snapshot().items.length, 450);
  } finally {
    opened.destroy();
  }
  // Commits and peer messages keep their own limits.
  assert.throws(() => decode(state, 8_000_000), /Invalid collaboration update/);
});
test("a failed start releases live channels instead of leaving an unsaved writable session", async () => {
  const env = environment(),
    b = await room(env);
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  const request = session.request.bind(session);
  session.request = (op, data) =>
    op === "sync"
      ? Promise.reject(Error("Network unavailable"))
      : request(op, data);
  await assert.rejects(session.start(), /Network unavailable/);
  assert.equal(session.closed, true);
  // Remote activity can no longer reopen editing on this session.
  session.readOnly = true;
  session.request = request;
  await session.synchronize();
  assert.equal(session.readOnly, true);
});
test("local edits persist outbox rows without rewriting the full snapshot", async () => {
  const env = environment(),
    b = await room(env),
    store = memoryStore();
  const writes = [];
  const put = store.collaborationPut.bind(store);
  store.collaborationPut = async (row) => {
    writes.push(row.kind);
    return put(row);
  };
  let state;
  const make = () =>
    new CollaborationSession({
      puter: env.sdk(owner),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user: owner,
      store,
      changed: (next) => {
        state = next;
      },
      activity() {},
      status() {},
    });
  const session = make();
  try {
    await session.start();
    session.scheduleFlush = () => {};
    writes.length = 0;
    for (let n = 0; n < 5; n++) {
      const next = structuredClone(state);
      next.items[0].text = `Draft ${n}`;
      await session.commit(next, state);
    }
    assert.deepEqual(writes, Array(5).fill("update"));
  } finally {
    session.close();
  }
  // Reopening replays the saved rows over the older snapshot and uploads them.
  const reopened = make();
  try {
    await reopened.start();
    assert.equal(state.items[0].text, "Draft 4");
    assert.equal(reopened.pending.size, 0);
    assert.equal(
      [...store.rows.values()].filter((r) => r.kind === "update").length,
      0,
    );
  } finally {
    reopened.close();
  }
});
test("completed peer actions are remembered for a bounded set of sessions", () => {
  const session = new CollaborationSession({
    puter: {},
    server: "https://whiteboard-test.puter.work",
    room: "bounded",
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  for (let n = 0; n < 600; n++) session.acted(`s${n}`, 1);
  session.acted("s100", 5);
  session.acted("s100", 3);
  assert.equal(session.lastAction.size, 512);
  assert.equal(session.lastAction.get("s100"), 5);
  assert.equal(session.lastAction.has("s0"), false);
  session.close();
});
test("a synchronization requested during another one runs again afterwards", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  const states = [];
  const make = (user, i) =>
    new CollaborationSession({
      puter: env.sdk(user),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user,
      store: memoryStore(),
      changed: (next) => {
        states[i] = next;
      },
      activity() {},
      status() {},
    });
  const a = make(owner, 0),
    c = make(editor, 1);
  try {
    await a.start();
    await c.start();
    env.dropEvents = true;
    let release;
    const request = a.request.bind(a);
    a.request = async (op, data) => {
      const result = await request(op, data);
      if (op === "sync" && !release)
        await new Promise((resolve) => (release = resolve));
      return result;
    };
    const first = a.synchronize();
    while (!release) await new Promise((r) => setTimeout(r, 5));
    // A collaborator's edit lands after the first response was prepared.
    const next = structuredClone(states[1]);
    next.items[0].text = "Arrived meanwhile";
    await c.commit(next, states[1]);
    await c.flush();
    const second = a.synchronize();
    release();
    await Promise.all([first, second]);
    assert.equal(states[0].items[0].text, "Arrived meanwhile");
  } finally {
    a.close();
    c.close();
  }
});
test("an edit made while an upload finishes is sent soon after it, not at the next retry", async () => {
  const env = environment(),
    b = await room(env);
  let state;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed: (next) => (state = next),
    activity() {},
    status() {},
  });
  try {
    await session.start();
    // Showing the upload's result takes a while, as on a large board.
    let slow = false,
      shown = 0,
      saving;
    const publish = session.publish.bind(session);
    session.publish = async () => {
      if (slow && ++shown === 1)
        await (saving = new Promise((r) => setTimeout(r, 150)));
      return publish();
    };
    const commits = () => env.calls.filter((c) => c.op === "commit").length;
    const before = commits();
    const first = structuredClone(state);
    first.title = "First";
    await session.commit(first, state);
    slow = true;
    const upload = session.flush();
    while (!saving) await new Promise((r) => setTimeout(r, 5));
    // A later edit arrives during that save and asks for an upload.
    const second = structuredClone(state);
    second.title = "Second";
    await session.commit(second, state);
    // Its batching delay ends while the upload is still finishing.
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
    await session.flush();
    await upload;
    slow = false;
    assert.equal(commits(), before + 1);
    const deadline = Date.now() + 3000;
    while (session.pending.size && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(commits(), before + 2);
    assert.equal(session.pending.size, 0);
  } finally {
    session.close();
  }
});
test("live positions are sent less often as a room grows", async () => {
  const env = environment(),
    b = await room(env);
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    await session.start();
    let sent = 0;
    session.peers?.close();
    session.peers = {
      links: new Map(),
      async broadcast(kind) {
        if (kind === "presence") sent++;
      },
      close() {},
    };
    const move = async (people) => {
      session.roster = Array.from({ length: people }, (_, n) => ({
        session: `s${n}`,
      }));
      sent = 0;
      const end = Date.now() + 600;
      for (let x = 0; Date.now() < end; x++) {
        session.presence({ cursor: { x, y: 0 }, selection: [] });
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 250));
      return sent;
    };
    assert.ok((await move(4)) >= 10, "25 a second in a small room");
    const large = await move(100);
    assert.ok(large >= 2 && large <= 4, `${large} in a large room`);
  } finally {
    session.close();
  }
});
test("an edit after a quiet spell uploads at once; edits right after it wait for the batch delay", async () => {
  const env = environment(),
    b = await room(env);
  const states = [];
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed: (next) => states.push(next),
    activity() {},
    status() {},
  });
  const commits = () => env.calls.filter((c) => c.op === "commit").length;
  try {
    await session.start();
    // With twenty people uploading, uploads are 2.5 seconds apart.
    session.uploaders = new Map(
      Array.from({ length: 19 }, (_, n) => [`s${n}`, Date.now()]),
    );
    const edit = async (text) => {
      const before = states.at(-1),
        next = structuredClone(before);
      next.items[0].text = text;
      await session.commit(next, before);
    };
    const start = commits();
    await edit("First");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(commits(), start + 1, "uploaded without waiting");
    await edit("Second");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(commits(), start + 1, "waits for the rest of the delay");
    assert.equal(session.pending.size, 1);
  } finally {
    session.close();
  }
});
test("uploads are spaced by how many people are uploading, not how many are present", () => {
  const session = new CollaborationSession({
    puter: {},
    server: "https://whiteboard-test.puter.work",
    room: "test",
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    session.linked = () => true;
    session.roster = Array.from({ length: 300 }, (_, n) => ({
      session: `s${n}`,
    }));
    assert.equal(session.batchDelay(), 400, "a large, quiet room");
    const ticket = (n) => ({ session: `s${n}`, user: `u${n}`, role: "editor" });
    for (let n = 0; n < 9; n++)
      session.receive("committed", { id: `e${n}` }, ticket(n), n + 1);
    assert.equal(session.batchDelay(), 1250, "ten people uploading");
    for (let n = 9; n < 99; n++)
      session.receive("committed", { id: `e${n}` }, ticket(n), n + 1);
    assert.equal(session.batchDelay(), 12_500, "a hundred people uploading");
    for (let n = 99; n < 200; n++)
      session.receive("committed", { id: `e${n}` }, ticket(n), n + 1);
    assert.equal(session.batchDelay(), 15_000, "at most fifteen seconds");
    // Others' uploads are unseen without peer links, and nothing of this
    // device's edits shows before they are saved.
    session.linked = () => false;
    assert.equal(
      session.batchDelay(),
      3000,
      "at most three seconds without peer links",
    );
    session.uploaders.clear();
    assert.equal(session.batchDelay(), 3000);
    session.roster = session.roster.slice(0, 20);
    assert.equal(session.batchDelay(), 625);
  } finally {
    session.close();
  }
});
test("drawings finished in quick succession each stay shown until their own edits arrive", async () => {
  const env = environment(),
    { doc } = seed();
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: "test",
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  session.shared.apply(doc.update());
  const ticket = { session: "remote", user: editor.uuid, role: "editor" };
  const stroke = (y) =>
    item("pen", 0, y, {
      w: 50,
      h: 5,
      points: [
        [0, 0],
        [50, 5],
      ],
    });
  const [first, second, third] = [100, 200, 300].map(stroke);
  const preview = ({ id, x, y, w, h, type, color, points }) => ({
    id,
    x,
    y,
    w,
    h,
    rotation: 0,
    type,
    color,
    points,
  });
  let sequence = 0;
  const presence = (drawing, settling = true) =>
    session.receive(
      "presence",
      {
        cursor: { x: 3, y: 4 },
        selection: [],
        preview: drawing ? [preview(drawing)] : [],
        settling,
      },
      ticket,
      ++sequence,
    );
  const shown = () =>
    session.people
      .get("remote")
      .preview.map((i) => i.id)
      .sort();
  const save = async (drawing) => {
    const next = doc.snapshot();
    next.items.push(drawing);
    doc.commit(next);
    session.shared.apply(doc.update());
    session.showEdit("remote");
    await new Promise((resolve) => setTimeout(resolve, 60));
  };
  try {
    presence(first, false);
    presence(null);
    // The next drawing starts before the first one's edit arrives.
    presence(second);
    assert.deepEqual(shown(), [first.id, second.id].sort());
    presence(null);
    presence(third);
    // The first one's edit shows it as saved; the others stay.
    await save(first);
    assert.deepEqual(shown(), [second.id, third.id].sort());
    // So does the notice of a save while the third is being drawn.
    session.synchronize = async () => {};
    session.receive("committed", { id: "save" }, ticket, ++sequence);
    assert.deepEqual(shown(), [second.id, third.id].sort());
    presence(null);
    await save(second);
    assert.deepEqual(shown(), [third.id]);
    await save(third);
    assert.deepEqual(shown(), []);
  } finally {
    session.close();
    doc.destroy();
  }
});
test("a finished move stays shown while its author is still saving it, and gives way soon after they stop saying so", async () => {
  const env = environment(),
    { doc } = seed();
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: "test",
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  session.shared.apply(doc.update());
  const ticket = { session: "remote", user: editor.uuid, role: "editor" };
  const moving = [{ id: "moving", x: 10, y: 10, w: 50, h: 50 }];
  let sequence = 0;
  const presence = (extra) =>
    session.receive(
      "presence",
      { cursor: { x: 3, y: 4 }, selection: [], preview: [], ...extra },
      ticket,
      ++sequence,
    );
  const real = Date.now;
  let clock = real();
  const wait = (ms) => void (clock += ms);
  // What the editor draws: held objects until their holds end.
  const shown = () =>
    session.people
      .get("remote")
      .held.filter((h) => clock <= h.until)
      .map((h) => h.item);
  const typed = () => {
    const p = session.people.get("remote");
    return p.settling && clock <= p.settleUntil ? p.text : null;
  };
  Date.now = () => clock;
  try {
    // A save that waits its turn, is retried or meets a slow worker. Its
    // author says so once a second, as presence from someone working out
    // of view reaches a large room.
    presence({ preview: moving });
    presence({ settling: true });
    for (let s = 1; s <= 15; s++) {
      wait(1000);
      presence({ settling: true });
      assert.deepEqual(shown(), moving, `still held after ${s} seconds`);
    }
    // Their device went quiet, as when it disconnects: a few seconds more.
    wait(3900);
    assert.deepEqual(shown(), moving);
    wait(200);
    assert.deepEqual(shown(), []);
    // Never more than twenty seconds, whatever they say.
    presence({ preview: moving });
    presence({ settling: true });
    for (let s = 1; s <= 19; s++) {
      wait(1000);
      presence({ settling: true });
    }
    assert.deepEqual(shown(), moving);
    wait(1001);
    presence({ settling: true });
    assert.deepEqual(shown(), []);
    // Older clients say so for a few seconds after the gesture, whatever
    // the save: held for six.
    presence({ preview: moving });
    presence({ settling: true });
    wait(2000);
    presence({ settling: true });
    wait(1000);
    presence({ cursor: { x: 9, y: 9 } });
    wait(2900);
    assert.deepEqual(shown(), moving);
    wait(200);
    assert.deepEqual(shown(), []);
    // Finished typing is kept the same way.
    presence({ editing: "moving", text: "Draft" });
    presence({ settling: true });
    for (let s = 1; s <= 10; s++) {
      wait(1000);
      presence({ settling: true });
    }
    assert.equal(typed(), "Draft");
    wait(4100);
    assert.equal(typed(), null);
  } finally {
    Date.now = real;
    session.close();
    doc.destroy();
  }
});
test("presence says a finished change is settling until its edit is saved, each second, for twenty seconds at most", async () => {
  const env = environment();
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: "test",
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  const sent = [];
  session.peers = {
    broadcast: async (kind, data) => void sent.push(data),
    close() {},
  };
  const real = Date.now;
  let clock = real();
  const wait = (ms) => void (clock += ms);
  const last = () => sent.at(-1).settling;
  Date.now = () => clock;
  try {
    session.latestPresence = { cursor: { x: 1, y: 2 }, selection: [] };
    // A drawing was finished; its edit waits in the outbox.
    session.settle();
    session.sendPresence();
    assert.equal(last(), true);
    session.pending.set("row", { digest: "row" });
    // Repeated each second though nothing else is sent.
    wait(800);
    session.pulsePresence();
    assert.equal(sent.length, 2);
    wait(9000);
    session.pulsePresence();
    assert.equal(last(), true, "still being saved after ten seconds");
    // A gesture cancelled meanwhile is not held, but the drawing still is.
    session.settle(false);
    session.sendPresence();
    assert.equal(last(), false);
    session.sendPresence();
    assert.equal(last(), true);
    // Saved: no longer settling, and nothing more to repeat.
    session.pending.clear();
    wait(1000);
    session.sendPresence();
    assert.equal(last(), false);
    const count = sent.length;
    wait(1000);
    session.pulsePresence();
    assert.equal(sent.length, count);
    // An edit that is never saved stops being announced after twenty
    // seconds.
    session.settle();
    session.pending.set("row", { digest: "row" });
    wait(19_900);
    session.sendPresence();
    assert.equal(last(), true);
    wait(200);
    session.sendPresence();
    assert.equal(last(), false);
  } finally {
    Date.now = real;
    session.pending.clear();
    session.close();
  }
});
test("a selection or open editor keeps being shared while its participant is idle", async () => {
  const env = environment(),
    b = await room(env);
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    await session.start();
    const sent = [];
    session.peers?.close();
    session.peers = {
      links: new Map(),
      async broadcast(kind, data) {
        if (kind === "presence") sent.push(data);
      },
      close() {},
    };
    session.presence({ cursor: null, selection: [], editing: null });
    await new Promise((r) => setTimeout(r, 4300));
    assert.equal(sent.length, 1, "Nothing selected is not repeated");
    session.presence({ cursor: null, selection: ["note"], editing: null });
    await new Promise((r) => setTimeout(r, 6500));
    assert.ok(sent.length >= 3, `Presence updates: ${sent.length}`);
    assert.deepEqual(sent.at(-1).selection, ["note"]);
  } finally {
    session.close();
  }
});
test("someone whose access is removed stops seeing the previous participants", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  const rosters = [];
  const make = (user, activity = () => {}) =>
    new CollaborationSession({
      puter: env.sdk(user),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user,
      store: memoryStore(),
      changed() {},
      activity,
      status() {},
    });
  const a = make(owner),
    c = make(editor, (people, roster) => rosters.push(roster.length));
  try {
    await a.start();
    await c.start();
    await a.heartbeat();
    await c.heartbeat();
    assert.equal(rosters.at(-1), 2);
    await env.service.call(owner, {
      op: "role",
      room: b.id,
      uuid: editor.uuid,
      role: "removed",
    });
    env.now += 5000;
    await assert.rejects(c.heartbeat(), { status: 403 });
    c.failure({ status: 403 });
    assert.equal(rosters.at(-1), 0);
    // The regular presence expiry runs every two seconds.
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal(rosters.at(-1), 0);
  } finally {
    a.close();
    c.close();
  }
});
test("live view counts as unavailable only once others are present without a peer link for ten seconds", () => {
  const env = environment();
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: "test",
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  const link = { connected: true, whiteboardAuthorized: true };
  session.peers = { links: new Map(), close() {} };
  try {
    session.roster = [{ session: session.session }];
    assert.equal(session.liveUnavailable(0), false);
    assert.equal(session.liveUnavailable(60_000), false, "Alone");
    session.roster.push({ session: "other" });
    assert.equal(session.liveUnavailable(100_000), false);
    assert.equal(session.liveUnavailable(109_000), false, "Still connecting");
    assert.equal(session.liveUnavailable(110_000), true);
    session.peers.links.set("other", link);
    assert.equal(session.liveUnavailable(111_000), false, "Linked again");
    // A link dropped for a moment, as while it is dialled again.
    session.peers.links.clear();
    assert.equal(session.liveUnavailable(112_000), false);
    session.peers.links.set("other", link);
    assert.equal(session.liveUnavailable(116_000), false);
    session.peers.links.clear();
    assert.equal(session.liveUnavailable(125_000), false);
    assert.equal(session.liveUnavailable(135_000), true);
    // A link still being set up carries nothing yet.
    session.peers.links.set("other", { connected: true });
    assert.equal(session.liveUnavailable(136_000), true);
    session.roster.pop();
    assert.equal(session.liveUnavailable(137_000), false, "Everyone else left");
  } finally {
    session.close();
  }
});
test("network failures and gateway pages give a message people can act on, keeping the status", async () => {
  const env = environment(),
    b = await room(env);
  const puter = env.sdk(owner);
  const session = new CollaborationSession({
    puter,
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    env.offline = true;
    await assert.rejects(session.request("sync"), (error) => {
      assert.equal(
        error.message,
        "Could not reach the shared board. Check your connection and try again.",
      );
      assert.equal(error.status, undefined);
      return true;
    });
    env.offline = false;
    puter.workers.exec = async () =>
      new Response("<html>Bad gateway</html>", { status: 502 });
    await assert.rejects(session.request("sync"), { status: 502 });
  } finally {
    session.close();
  }
});
test("an invite code renewed during a check-in is published right after it", async () => {
  const env = environment(),
    b = await room(env);
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    await session.start();
    const peers = {
      server: { inviteCode: "first" },
      links: new Map(),
      update() {},
      close() {},
      async broadcast() {},
    };
    session.peers?.close();
    session.peers = peers;
    const published = [];
    let release;
    const request = session.request.bind(session);
    session.request = async (op, data) => {
      if (op === "presence") {
        published.push(data.invite);
        if (published.length === 1)
          await new Promise((resolve) => (release = resolve));
      }
      return request(op, data);
    };
    const first = session.heartbeat();
    while (!release) await new Promise((r) => setTimeout(r, 5));
    // The peer service reconnects with a new code meanwhile.
    peers.server.inviteCode = "second";
    await session.heartbeat();
    release();
    await first;
    const deadline = Date.now() + 2000;
    while (published.length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(published, ["first", "second"]);
    // An unchanged code is not published twice.
    while (session.beating) await new Promise((r) => setTimeout(r, 5));
    const again = session.heartbeat();
    await session.heartbeat();
    await again;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(published.length, 3);
  } finally {
    session.close();
  }
});
test("a failed upload while connecting leaves live features on and uploads once access returns", async () => {
  const env = environment(),
    b = await room(env),
    store = memoryStore();
  let state;
  const make = () =>
    new CollaborationSession({
      puter: env.sdk(owner),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user: owner,
      store,
      changed: (next) => (state = next),
      activity() {},
      status() {},
    });
  const offline = make();
  await offline.start();
  offline.scheduleFlush = () => {};
  env.offline = true;
  const next = structuredClone(state);
  next.title = "Queued offline";
  await offline.commit(next, state);
  offline.close();
  env.offline = false;
  const session = make();
  const request = session.request.bind(session);
  let failures = 0;
  session.request = (op, data) =>
    op === "commit" && !failures++
      ? Promise.reject(Object.assign(Error("Unavailable"), { status: 503 }))
      : request(op, data);
  try {
    await assert.rejects(session.start(), { status: 503 });
    assert.equal(session.connected, true);
    assert.equal(session.pending.size, 1);
    // The editor makes a failed start read-only until a check-in.
    session.readOnly = session.contentReadOnly = true;
    await session.heartbeat();
    const deadline = Date.now() + 3000;
    while (session.pending.size && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(session.pending.size, 0);
    const { doc } = await env.service.load(b.id);
    try {
      assert.equal(doc.snapshot().title, "Queued offline");
    } finally {
      doc.destroy();
    }
  } finally {
    session.close();
  }
});
test("the save status says live the same way after synchronizing and after saving", async () => {
  const env = environment(),
    b = await room(env);
  const statuses = [];
  let state;
  const session = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed: (next) => (state = next),
    activity() {},
    status: (message) => statuses.push(message),
  });
  try {
    await session.start();
    // A large room: no board events, only a peer link.
    session.subscription?.off();
    session.subscription = null;
    const link = { connected: true, whiteboardAuthorized: false };
    session.peers?.close();
    session.peers = {
      links: new Map([["relay", link]]),
      update() {},
      close() {},
      async broadcast() {},
    };
    await session.synchronize();
    assert.equal(statuses.at(-1), "Saved · periodic sync");
    link.whiteboardAuthorized = true;
    await session.synchronize();
    assert.equal(statuses.at(-1), "Saved · live");
    const next = structuredClone(state);
    next.title = "Renamed";
    await session.commit(next, state);
    await session.flush();
    assert.equal(statuses.at(-1), "Saved · live");
    link.whiteboardAuthorized = false;
    const later = structuredClone(state);
    later.title = "Renamed again";
    await session.commit(later, state);
    await session.flush();
    assert.equal(statuses.at(-1), "Saved · periodic sync");
  } finally {
    session.close();
  }
});
test("synchronizing without news neither rewrites the local copy nor redraws, but deletions and access changes do", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  const states = [],
    store = memoryStore();
  let puts = 0;
  const put = store.collaborationPut;
  store.collaborationPut = (row) => {
    if (row.kind === "snapshot") puts++;
    return put(row);
  };
  const changes = [0, 0];
  const make = (user, i, s = memoryStore()) =>
    new CollaborationSession({
      puter: env.sdk(user),
      server: "https://whiteboard-test.puter.work",
      room: b.id,
      user,
      store: s,
      changed: (next) => {
        states[i] = next;
        changes[i]++;
      },
      activity() {},
      status() {},
    });
  const a = make(owner, 0),
    c = make(editor, 1, store);
  try {
    await a.start();
    await c.start();
    env.dropEvents = true;
    const [renders, writes] = [changes[1], puts];
    await c.synchronize();
    await c.synchronize();
    // Nor does a periodic upload with nothing to send.
    await c.flush();
    assert.equal(changes[1], renders);
    assert.equal(puts, writes);
    // A deletion does not change the document's state vector.
    const next = structuredClone(states[0]);
    next.items = [];
    await a.commit(next, states[0]);
    await a.flush();
    await c.synchronize();
    assert.equal(changes[1], renders + 1);
    assert.equal(states[1].items.length, 0);
    assert.equal(puts, writes + 1);
    await env.service.call(owner, {
      op: "role",
      room: b.id,
      uuid: editor.uuid,
      role: "viewer",
    });
    env.now += 5000;
    await c.synchronize();
    assert.equal(c.readOnly, true);
    assert.equal(changes[1], renders + 2);
  } finally {
    a.close();
    c.close();
  }
});
test("a session whose ID another participant took after it lapsed continues under a new one", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor);
  await invite(env, b, viewer, "viewer");
  const session = new CollaborationSession({
    puter: env.sdk(editor),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: editor,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    await session.start();
    const lapsed = session.session;
    // The tab slept past the presence expiry, and someone claimed its ID.
    env.data.delete(`wb:${b.id}:presence:${lapsed}`);
    await env.service.call(viewer, {
      op: "presence",
      room: b.id,
      session: lapsed,
      publicKey: session.keys.publicKey,
    });
    await session.heartbeat();
    assert.notEqual(session.session, lapsed);
    assert.equal(session.readOnly, false);
    assert.ok(session.roster.some((p) => p.session === session.session));
    assert.equal(
      session.roster.find((p) => p.session === lapsed)?.user,
      viewer.uuid,
    );
  } finally {
    session.close();
  }
});
test("a facilitator revoking invitations leaves the owner's facilitator invitations", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, editor, "facilitator");
  const [lead, member] = await Promise.all(
    ["facilitator", "viewer"].map((role) =>
      env.service.call(owner, { op: "invite", room: b.id, role }),
    ),
  );
  await env.service.call(editor, { op: "revoke-invite", room: b.id });
  await assert.rejects(
    env.service.call(viewer, { op: "join", room: b.id, token: member.token }),
    { status: 403 },
  );
  assert.equal(
    (
      await env.service.call(viewer, {
        op: "join",
        room: b.id,
        token: lead.token,
      })
    ).member.role,
    "facilitator",
  );
  // The owner's revocation ends every invitation.
  const again = await env.service.call(owner, {
    op: "invite",
    room: b.id,
    role: "facilitator",
  });
  await env.service.call(owner, { op: "revoke-invite", room: b.id });
  const stranger = {
    uuid: "66666666-6666-4666-8666-666666666666",
    username: "Fay",
  };
  await assert.rejects(
    env.service.call(stranger, { op: "join", room: b.id, token: again.token }),
    { status: 403 },
  );
});
test("reports of exports are capped per person and minute, so no one can flood the audit log", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, viewer, "viewer");
  const exported = () =>
    env.service.call(viewer, {
      op: "export",
      room: b.id,
      format: "png",
      scope: "board",
    });
  for (let n = 0; n < 20; n++) await exported();
  await assert.rejects(exported(), { status: 429 });
  // Others are unaffected, and the allowance returns the next minute.
  await env.service.call(owner, { op: "export", room: b.id, format: "pdf" });
  const now = env.service.now;
  env.service.now = () => now() + 60_000;
  try {
    await exported();
  } finally {
    env.service.now = now;
  }
});

test("reading versions is capped per person and minute, so no one can use up the worker's requests", async () => {
  const env = environment(),
    b = await room(env);
  await invite(env, b, viewer, "viewer");
  const read = (user = viewer) =>
    env.service.call(user, { op: "history.state", room: b.id, at: 0 });
  for (let n = 0; n < 60; n++) await read();
  await assert.rejects(read(), { status: 429 });
  await assert.rejects(
    env.service.call(viewer, { op: "history.list", room: b.id }),
    { status: 429 },
  );
  // Others are unaffected, as is this person's syncing.
  await read(owner);
  await env.service.call(viewer, { op: "sync", room: b.id });
  const now = env.service.now;
  env.service.now = () => now() + 60_000;
  try {
    await read();
  } finally {
    env.service.now = now;
  }
});

test("undoing a deletion a collaborator edited meanwhile brings the object back whole", async () => {
  for (const kind of ["note", "table"]) {
    const initial = board("Undo delete"),
      target = item(
        kind,
        0,
        0,
        kind === "table" ? { cells: [["A", "B"]] } : { text: "Hello" },
      );
    initial.items = [target, item("rect", 300, 0)];
    const seed = new SharedDocument();
    seed.commit(initial);
    const a = new SharedDocument(seed.update()),
      b = new SharedDocument(seed.update());
    seed.destroy();
    const exchange = () => {
      a.apply(b.update(a.vector()));
      b.apply(a.update(b.vector()));
    };
    try {
      // A deletes the object while B moves it (and adds a row to a table).
      const removed = a.snapshot();
      removed.items = removed.items.filter((i) => i.id !== target.id);
      a.commit(removed);
      const moved = b.snapshot(),
        other = moved.items.find((i) => i.id === target.id);
      other.x += 50;
      if (kind === "table") {
        other.cells.push(["", ""]);
        other.h += 40;
      }
      b.commit(moved);
      exchange();
      a.undo.undo();
      exchange();
      for (const doc of [a, b]) {
        doc.validate();
        const back = doc.snapshot().items.find((i) => i.id === target.id);
        assert.equal(back.w, target.w, kind);
        assert.equal(back.h, target.h, kind);
        if (kind === "table") assert.deepEqual(back.cells, [["A", "B"]]);
        else assert.equal(back.text, "Hello");
      }
      assert.deepEqual(a.snapshot(), b.snapshot());
      // Redo deletes it again, and a second undo restores it whole again.
      a.undo.redo();
      assert.equal(
        a.snapshot().items.some((i) => i.id === target.id),
        false,
      );
      a.undo.undo();
      a.validate();
      assert.equal(
        a.snapshot().items.find((i) => i.id === target.id).w,
        target.w,
      );
    } finally {
      a.destroy();
      b.destroy();
    }
  }
});

test("undoing a change made at the same moment as a collaborator's keeps the property", () => {
  const initial = board("Same property"),
    note = item("note", 0, 0, { text: "Hi", color: "#f6e7a4" }),
    table = item("table", 0, 300, { cells: [["A", "B"]] });
  initial.items = [note, table];
  for (let attempt = 0; attempt < 8; attempt++) {
    const seed = new SharedDocument();
    seed.commit(initial);
    const a = new SharedDocument(seed.update()),
      b = new SharedDocument(seed.update());
    seed.destroy();
    const exchange = () => {
      a.apply(b.update(a.vector()));
      b.apply(a.update(b.vector()));
    };
    const change = (doc, color, dx) => {
      const next = doc.snapshot();
      const n = next.items.find((i) => i.id === note.id),
        t = next.items.find((i) => i.id === table.id);
      n.color = color;
      n.x += dx;
      t.cells.push(["", ""]);
      t.h += 40;
      doc.commit(next);
    };
    try {
      change(a, "#dce5f7", 50);
      change(b, "#d8f0df", 90);
      exchange();
      const winner = a.snapshot().items[0].color === "#dce5f7" ? a : b;
      const won = structuredClone(winner.snapshot().items);
      winner.undo.undo();
      exchange();
      for (const doc of [a, b]) {
        doc.validate();
        const [n, t] = doc.snapshot().items;
        assert.equal(n.color, "#f6e7a4");
        assert.equal(n.x, 0);
        assert.deepEqual(t.cells, [["A", "B"]]);
        assert.equal(t.h, table.h);
      }
      assert.deepEqual(a.snapshot(), b.snapshot());
      // Redo brings back the undone change, and undo removes it again.
      winner.undo.redo();
      assert.deepEqual(winner.snapshot().items, won);
      winner.undo.undo();
      winner.validate();
      assert.equal(winner.snapshot().items[0].color, "#f6e7a4");
      assert.deepEqual(winner.snapshot().items[1].cells, [["A", "B"]]);
      // A collaborator's later change stays when the other undoes.
      const loser = winner === a ? b : a;
      exchange();
      winner.undo.redo();
      exchange();
      const later = loser.snapshot();
      later.items[0].color = "#f5d7c9";
      loser.commit(later);
      exchange();
      winner.undo.undo();
      exchange();
      assert.equal(winner.snapshot().items[0].color, "#f5d7c9");
      assert.equal(winner.snapshot().items[0].x, 0);
    } finally {
      a.destroy();
      b.destroy();
    }
  }
});

test("redoing an addition a collaborator edited meanwhile brings the object back whole", () => {
  const seed = new SharedDocument();
  seed.commit(board("Redo add"));
  const a = new SharedDocument(seed.update()),
    b = new SharedDocument(seed.update());
  seed.destroy();
  const exchange = () => {
    a.apply(b.update(a.vector()));
    b.apply(a.update(b.vector()));
  };
  try {
    const added = a.snapshot(),
      note = item("note", 0, 0, { text: "Idea" });
    added.items.push(note);
    a.commit(added);
    exchange();
    // A undoes adding the note while B moves it.
    a.undo.undo();
    const moved = b.snapshot();
    moved.items[0].x = 200;
    b.commit(moved);
    exchange();
    a.undo.redo();
    exchange();
    for (const doc of [a, b]) {
      doc.validate();
      const back = doc.snapshot().items[0];
      assert.equal(back.id, note.id);
      assert.equal(back.x, 0);
      assert.equal(back.w, note.w);
      assert.equal(back.text, "Idea");
    }
    assert.deepEqual(a.snapshot(), b.snapshot());
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("repairs made outside undo history are saved like edits", async () => {
  const env = environment(),
    b = await room(env);
  const a = new CollaborationSession({
    puter: env.sdk(owner),
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    await a.start();
    a.shared.doc.transact(() => a.shared.meta.set("title", "Repaired"), REPAIR);
    assert.equal(a.shared.undo.undoStack.length, 0);
    await a.queue;
    await a.flush();
    const { doc } = await env.service.load(b.id);
    assert.equal(doc.snapshot().title, "Repaired");
    doc.destroy();
  } finally {
    a.close();
  }
});

test("a slow reply does not put the shared clock out of step with the server", async () => {
  const env = environment(),
    b = await room(env);
  env.service.now = () => Date.now();
  const puter = env.sdk(owner),
    exec = puter.workers.exec;
  let slow = false;
  puter.workers.exec = async (url, options) => {
    const response = await exec(url, options);
    // The server read its clock, then the reply took long to arrive, as
    // when a large board is sent back.
    if (slow) await new Promise((r) => setTimeout(r, 1500));
    return response;
  };
  const session = new CollaborationSession({
    puter,
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    await session.start();
    assert.ok(Math.abs(session.now() - Date.now()) < 300);
    slow = true;
    await session.synchronize();
    slow = false;
    assert.ok(
      Math.abs(session.now() - Date.now()) < 300,
      `${session.now() - Date.now()} ms`,
    );
  } finally {
    session.close();
  }
});

test("joining tells participants only whether the board is archived, and managers its settings", async () => {
  const env = environment(),
    b = await room(env);
  const { token } = await env.service.call(owner, {
    op: "invite",
    room: b.id,
    role: "viewer",
  });
  const joined = await env.service.call(viewer, {
    op: "join",
    room: b.id,
    token,
  });
  assert.deepEqual(joined.settings, { archived: false });
  const managed = await env.service.call(owner, { op: "join", room: b.id });
  assert.equal(managed.settings.visibility, "private");
  assert.equal(managed.settings.legalHold, false);
});

test("reorders made at once by two people both take effect", () => {
  const initial = board("Layers");
  initial.items = ["a", "b", "c", "d", "e"].map((id) =>
    item("rect", 0, 0, { id }),
  );
  const pair = () => {
    const seed = new SharedDocument();
    seed.commit(initial);
    const docs = [
      new SharedDocument(seed.update()),
      new SharedDocument(seed.update()),
    ];
    seed.destroy();
    return docs;
  };
  const exchange = (a, b) => {
    a.apply(b.update(a.vector()));
    b.apply(a.update(b.vector()));
  };
  const order = (doc) =>
    doc
      .snapshot()
      .items.map((i) => i.id)
      .join("");
  let [a, b] = pair();
  // One brings a to the front while the other sends e to the back.
  let next = a.snapshot();
  next.items.push(next.items.shift());
  a.commit(next);
  next = b.snapshot();
  next.items.unshift(next.items.pop());
  b.commit(next);
  exchange(a, b);
  assert.equal(order(a), "ebcda");
  assert.equal(order(b), "ebcda");
  a.destroy();
  b.destroy();
  // A reorder leaves an object someone else added where they put it.
  [a, b] = pair();
  next = a.snapshot();
  next.items.push(next.items.shift());
  a.commit(next);
  next = b.snapshot();
  next.items.splice(3, 0, item("note", 0, 0, { id: "N" }));
  b.commit(next);
  exchange(a, b);
  assert.equal(order(a), "bcNdea");
  assert.equal(order(b), "bcNdea");
  a.destroy();
  b.destroy();
  // Moving objects into the same gap again and again stays in order.
  [a] = pair();
  for (let n = 0; n < 80; n++) {
    next = a.snapshot();
    const moved = next.items.splice(n % 2 ? 4 : 0, 1)[0];
    next.items.splice(2, 0, moved);
    a.commit(next);
    assert.deepEqual(
      a.snapshot().items.map((i) => i.id),
      next.items.map((i) => i.id),
    );
  }
  a.destroy();
});

test("formatting changed while someone types keeps to the same words", () => {
  const initial = board("Formatting"),
    note = item("note", 0, 0, {
      text: "Hello world",
      textRuns: [{ start: 0, end: 5, style: { bold: true, italic: true } }],
    });
  initial.items = [note];
  const mine = new SharedDocument();
  mine.commit(initial);
  const theirs = new SharedDocument(mine.update());
  try {
    const before = mine.snapshot();
    // Bold is removed from the note here...
    const local = structuredClone(before);
    local.items[0].textRuns = [{ start: 0, end: 5, style: { italic: true } }];
    // ...while someone types at its start.
    theirs.text(note.id, "Big Hello world");
    mine.apply(theirs.update(mine.vector()));
    const next = rebase(local, before, mine.snapshot());
    assert.equal(next.items[0].text, "Big Hello world");
    assert.deepEqual(next.items[0].textRuns, [
      { start: 4, end: 9, style: { italic: true } },
    ]);
    mine.commit(next);
    theirs.apply(mine.update(theirs.vector()));
    assert.deepEqual(
      theirs.snapshot().items[0].textRuns,
      next.items[0].textRuns,
    );
  } finally {
    mine.destroy();
    theirs.destroy();
  }
});

test("the shared clock catches up after the device sleeps", async () => {
  const env = environment(),
    b = await room(env);
  let slept = 0;
  env.service.now = () => Date.now() + slept;
  const puter = env.sdk(owner),
    exec = puter.workers.exec;
  // The reply after waking is no quicker than the first ones.
  puter.workers.exec = async (url, options) => {
    const response = await exec(url, options);
    if (slept) await new Promise((r) => setTimeout(r, 300));
    return response;
  };
  const session = new CollaborationSession({
    puter,
    server: "https://whiteboard-test.puter.work",
    room: b.id,
    user: owner,
    store: memoryStore(),
    changed() {},
    activity() {},
    status() {},
  });
  try {
    await session.start();
    // A minute of sleep that the page's monotonic clock did not count.
    slept = 60_000;
    await session.synchronize();
    assert.ok(
      Math.abs(session.now() - (Date.now() + slept)) < 1000,
      `${session.now() - (Date.now() + slept)} ms`,
    );
  } finally {
    session.close();
  }
});

test("undoing a deletion a collaborator reordered or moved meanwhile keeps its rank and table sizes", async () => {
  const { resizeTableTracks } = await import("../src/table-layout.js");
  const { reorderItems } = await import("../src/scene.js");
  const pull = (x, y) => x.apply(y.update(x.vector()));
  const sync = (a, b) => {
    pull(a, b);
    pull(b, a);
  };
  const valid = (a, b) => {
    a.validate();
    const worker = new SharedDocument(b.update());
    pull(worker, a);
    worker.validate();
    worker.destroy();
  };
  const pair = (items) => {
    const base = new SharedDocument();
    base.commit({ ...board("Same moment"), items });
    const a = new SharedDocument(base.update()),
      b = new SharedDocument(base.update());
    base.destroy();
    return [a, b];
  };
  // Undoing a deletion brought to front meanwhile keeps a layer rank.
  let [a, b] = pair(
    ["n1", "n2", "n3"].map((id, n) => item("note", n * 50, 0, { id })),
  );
  let s = a.snapshot();
  s.items = s.items.filter((i) => i.id !== "n1");
  a.commit(s);
  s = b.snapshot();
  s.items = reorderItems(s.items, new Set(["n1"]), "front");
  b.commit(s);
  sync(a, b);
  a.undo.undo();
  assert.ok(Number.isFinite(a.items.get("n1").get("z")));
  valid(a, b);
  a.destroy();
  b.destroy();
  // Undoing the deletion of a resized table moved meanwhile.
  [a, b] = pair([]);
  s = a.snapshot();
  s.items = [
    item("table", 0, 0, {
      id: "t1",
      w: 360,
      h: 120,
      cells: [
        ["a", "b", "c"],
        ["", "", ""],
      ],
    }),
  ];
  a.commit(s);
  s = a.snapshot();
  Object.assign(s.items[0], resizeTableTracks(s.items[0], "column", [1], 163));
  a.commit(s);
  pull(b, a);
  s = a.snapshot();
  s.items = [];
  a.commit(s);
  s = b.snapshot();
  s.items[0].x += 50;
  b.commit(s);
  sync(a, b);
  a.undo.undo();
  assert.equal(a.snapshot().items[0].cells[0][0], "a");
  valid(a, b);
  a.destroy();
  b.destroy();
});

test("undo and redo around a collaborator's change at the same moment leave every object whole", async () => {
  const { resizeTableTracks } = await import("../src/table-layout.js");
  const { reorderItems } = await import("../src/scene.js");
  const pull = (x, y) => x.apply(y.update(x.vector()));
  const sync = (a, b) => {
    pull(a, b);
    pull(b, a);
  };
  // What the worker would hold: both clients' edits together.
  const valid = (a, b) => {
    a.validate();
    const worker = new SharedDocument(b.update());
    pull(worker, a);
    worker.validate();
    worker.destroy();
  };
  const pair = (items, ids, extra = {}) => {
    const initial = { ...board("Same moment"), items, ...extra };
    const base = new SharedDocument();
    base.commit(initial);
    const a = new SharedDocument(base.update()),
      b = new SharedDocument(base.update());
    base.destroy();
    if (ids) [a.doc.clientID, b.doc.clientID] = ids;
    return [a, b];
  };
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    // Two undos over a concurrent move, the values Yjs has merged.
    let [a, b] = pair([item("note", 0, 0, { id: "n1" })], ids);
    const move = (d, dx) => {
      const s = d.snapshot();
      s.items[0].x += dx;
      d.commit(s);
    };
    move(a, 10);
    pull(b, a);
    move(a, 20);
    move(b, 5);
    sync(a, b);
    move(a, 30);
    a.undo.undo();
    a.undo.undo();
    assert.ok(a.items.get("n1").get("geometry"), `${ids}: geometry kept`);
    valid(a, b);
    a.destroy();
    b.destroy();
    // Redo after a concurrent resize while undone.
    [a, b] = pair([item("note", 0, 0, { id: "n1" })], ids);
    let s = a.snapshot();
    s.items[0].x = 100;
    a.commit(s);
    sync(a, b);
    a.undo.undo();
    s = b.snapshot();
    s.items[0].w = 300;
    b.commit(s);
    sync(a, b);
    a.undo.redo();
    assert.equal(a.snapshot().items[0].x, 100, `${ids}: redone`);
    valid(a, b);
    a.destroy();
    b.destroy();
    // Redo of a tag and title change edited meanwhile.
    [a, b] = pair([item("note", 0, 0, { id: "n1", tagIds: ["t1"] })], ids, {
      tags: [{ id: "t1", name: "Bug", color: "#c43b3b" }],
    });
    s = a.snapshot();
    s.tags[0].name = "Defect";
    s.title = "Plan v2";
    a.commit(s);
    sync(a, b);
    a.undo.undo();
    s = b.snapshot();
    s.tags[0].color = "#365dc4";
    s.title = "Plan v3";
    b.commit(s);
    sync(a, b);
    a.undo.redo();
    const snap = a.snapshot();
    assert.equal(snap.tags.length, 1, `${ids}: tag kept`);
    assert.deepEqual(snap.items[0].tagIds, ["t1"]);
    assert.notEqual(snap.title, "Untitled board");
    valid(a, b);
    a.destroy();
    b.destroy();
  }
  // Redoing a table's addition after rows were added meanwhile.
  let [a, b] = pair([]);
  let s = a.snapshot();
  s.items = [
    item("table", 0, 0, {
      id: "t1",
      w: 240,
      h: 80,
      cells: [
        ["a", "b"],
        ["c", "d"],
      ],
    }),
  ];
  a.commit(s);
  pull(b, a);
  s = b.snapshot();
  s.items[0].cells.push(["", ""]);
  s.items[0].h = 120;
  b.commit(s);
  pull(a, b);
  s = b.snapshot();
  s.items[0].cells.push(["e", "f"]);
  s.items[0].h = 160;
  b.commit(s);
  a.undo.undo();
  sync(a, b);
  a.undo.redo();
  assert.ok(a.snapshot().items[0].cells.length >= 2);
  valid(a, b);
  a.destroy();
  b.destroy();
});

test("an undo tried on a copy that keeps deleted content matches the real undo", () => {
  const shared = new SharedDocument();
  shared.commit({
    ...board("Copy"),
    items: [item("note", 100, 100, { id: "n1", text: "mine" })],
  });
  shared.undo.clear();
  const moved = shared.snapshot();
  moved.items[0].x += 250;
  shared.commit(moved);
  const trial = new SharedDocument(shared.update(), { gc: false });
  try {
    trial.undo.undoStack.push(shared.undo.undoStack.at(-1));
    trial.undo.undo();
    shared.undo.undo();
    assert.deepEqual(trial.snapshot().items, shared.snapshot().items);
    assert.equal(trial.snapshot().items[0].x, 100);
  } finally {
    trial.destroy();
    shared.destroy();
  }
});

test("concurrent re-pointing of one embed to two providers merges into a valid board", async () => {
  const b = board("Embeds");
  b.items = [
    item("embed", 0, 0, {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
      text: "Video",
      w: 480,
      h: 300,
      color: "#ffffff",
    }),
  ];
  const seed = new SharedDocument();
  seed.commit(b);
  const a = new SharedDocument(seed.update()),
    c = new SharedDocument(seed.update());
  try {
    // Only the URL changes on one side, so the other side's provider could
    // otherwise win the merge together with this side's URL.
    a.doc.clientID = 2000;
    c.doc.clientID = 1000;
    const sa = a.snapshot();
    Object.assign(sa.items[0], {
      url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      provider: "youtube",
    });
    a.commit(sa);
    const sc = c.snapshot();
    Object.assign(sc.items[0], {
      url: "https://vimeo.com/123456789",
      provider: "vimeo",
    });
    c.commit(sc);
    a.apply(c.update(a.vector()));
    c.apply(a.update(c.vector()));
    for (const doc of [a, c]) {
      const merged = doc.snapshot();
      validateBoard(merged);
      assert.equal(
        merged.items[0].url,
        "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      );
      assert.equal(merged.items[0].provider, "youtube");
    }
  } finally {
    a.destroy();
    c.destroy();
    seed.destroy();
  }
});

test("a shared board's undo history keeps 80 steps and lets go of what older ones erased", () => {
  const shared = new SharedDocument();
  const size = () => encode(shared.update()).length;
  const cycle = (n) => {
    const drawn = shared.snapshot();
    drawn.items.push(
      item("pen", 0, 0, {
        id: "stroke" + n,
        points: Array.from({ length: 300 }, (_, k) => [k, n]),
        w: 300,
        h: 100,
      }),
    );
    shared.commit(drawn);
    const erased = shared.snapshot();
    erased.items = [];
    shared.commit(erased);
  };
  // Draw a stroke and erase it, again and again, as in a long session.
  for (let n = 0; n < 100; n++) cycle(n);
  const after100 = size();
  for (let n = 100; n < 400; n++) cycle(n);
  assert.equal(shared.undo.undoStack.length, 80);
  assert.ok(
    size() < after100 * 1.2,
    `${size()} bytes after 400, ${after100} after 100`,
  );
  // The kept steps still undo: the newest erasure brings its stroke back.
  shared.undo.undo();
  assert.deepEqual(
    shared.snapshot().items.map((i) => i.id),
    ["stroke399"],
  );
  for (let n = 1; n < 80; n++) shared.undo.undo();
  assert.equal(shared.undo.canUndo(), false);
  validateBoard(shared.snapshot());
  shared.destroy();
});

test("someone turned away by a full board is told so, keeps saving, and checks in less often", async () => {
  const env = environment();
  env.service.now = () => Date.now();
  env.dropEvents = true;
  const initial = board("Full");
  initial.items = [item("note", 0, 0, { text: "Hello" })];
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const make = (status = () => {}) =>
    new CollaborationSession({
      puter: env.sdk(owner),
      server: "https://whiteboard-test.puter.work",
      room: initial.id,
      user: owner,
      store: memoryStore(),
      changed() {},
      activity() {},
      status,
    });
  // One account's sixteen sessions stand in for the board's 512 people:
  // both limits are refused the same way.
  const sessions = [];
  for (let n = 0; n < 16; n++) {
    const session = make();
    await session.start();
    sessions.push(session);
  }
  const statuses = [];
  const timers = [];
  const setTimer = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    timers.push(ms);
    return setTimer(fn, ms, ...rest);
  };
  const extra = make((text) => statuses.push(text));
  try {
    await extra.start();
  } finally {
    globalThis.setTimeout = setTimer;
  }
  try {
    assert.equal(statuses.at(-1), "Saved · board full, no live presence");
    assert.ok(!statuses.some((text) => /Offline/.test(text)));
    assert.ok(timers.some((ms) => ms >= 60_000 && ms <= 90_000));
    assert.ok(!timers.some((ms) => ms >= 8000 && ms <= 12_000));
  } finally {
    for (const session of [...sessions, extra]) session.close();
  }
});

test("a save whose edits already arrived, over a peer link or as one's own, is not read again", async () => {
  const { createPeerHub } = await import("./peer-hub.js");
  const env = environment();
  const initial = board("Small room");
  initial.items = [item("note", 0, 0, { text: "Hello" })];
  const seed = new SharedDocument();
  seed.commit(initial);
  await env.service.call(owner, {
    op: "create",
    room: initial.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const { token } = await env.service.call(owner, {
    op: "invite",
    room: initial.id,
    role: "editor",
  });
  await env.service.call(editor, { op: "join", room: initial.id, token });
  const hub = createPeerHub();
  const make = (user) => {
    const box = {};
    const session = new CollaborationSession({
      puter: { ...env.sdk(user), peer: hub.peer },
      server: "https://whiteboard-test.puter.work",
      room: initial.id,
      user,
      store: memoryStore(),
      changed: (state) => (box.state = state),
      activity() {},
      status() {},
    });
    session.box = box;
    return session;
  };
  const a = make(owner),
    c = make(editor);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await a.start();
    await c.start();
    // Peer links connect at a later check-in, some seconds in.
    for (let n = 0; n < 3000 && !(a.linked() && c.linked()); n++)
      await wait(10);
    assert.ok(a.linked() && c.linked());
    await wait(1500);
    const syncs = (user) =>
      env.calls.filter((x) => x.op === "sync" && x.user === user.uuid).length;
    const before = { a: syncs(owner), c: syncs(editor) };
    for (let n = 1; n <= 5; n++) {
      const previous = c.box.state,
        next = structuredClone(previous);
      next.items[0].x = n * 10;
      await c.commit(next, previous);
      await c.flushed();
      await wait(400);
    }
    for (let n = 0; n < 200 && a.box.state.items[0].x !== 50; n++)
      await wait(10);
    await wait(300);
    assert.equal(a.box.state.items[0].x, 50);
    assert.equal(syncs(owner) - before.a, 0, "the other person reads nothing");
    assert.equal(syncs(editor) - before.c, 0, "the author reads nothing");
  } finally {
    a.close();
    c.close();
  }
});
