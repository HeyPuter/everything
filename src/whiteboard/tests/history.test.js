import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { board, clone, item, validateBoard } from "../src/model.js";
import { SharedDocument } from "../src/collaboration/document.js";
import { decode, encode, hash } from "../src/collaboration/protocol.js";
import { historyVersions } from "../worker/service.js";
import {
  deletedSince,
  recoverDeleted,
  restoreFrame,
  frameRestoreIds,
  restoreObjects,
  sameObject,
  restoreBoard,
} from "../src/history/restore.js";
import { environment, owner, editor, viewer } from "./collaboration-helpers.js";

async function commit(boards, user, room, change) {
  const { doc } = await boards.load(room);
  const before = doc.vector();
  const next = doc.snapshot();
  change(next);
  doc.commit(next);
  const update = doc.update(before);
  doc.destroy();
  return boards.call(user, {
    op: "commit",
    room,
    id: await hash(update),
    update: encode(update),
  });
}

test("history groups edits into versions and rebuilds any earlier state", async () => {
  const env = environment(),
    boards = env.service;
  const b = board("History"),
    doc = new SharedDocument();
  b.items = [item("note", 0, 0, { text: "First" })];
  doc.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  let clock = env.now + 60_000;
  boards.now = () => clock;
  await commit(boards, owner, b.id, (s) => (s.items[0].text = "Second"));
  const secondAt = clock;
  clock += 10 * 60_000;
  await commit(boards, owner, b.id, (s) => (s.items[0].text = "Third"));
  // Listing versions reads the edits' keys, never the edits themselves.
  const read = [];
  const list = boards.list.bind(boards);
  boards.list = (prefix, values = true) => (
    read.push([prefix, values]),
    list(prefix, values)
  );
  const { versions } = await boards.call(owner, {
    op: "history.list",
    room: b.id,
  });
  boards.list = list;
  assert.ok(
    read.every(([prefix, values]) => !prefix.includes(":log:") || !values),
    JSON.stringify(read),
  );
  // Two versions of edits, then the board as it was created.
  assert.equal(versions.length, 3);
  assert.deepEqual(versions[0].authors, ["Alice"]);
  assert.equal(versions[1].at, secondAt);
  assert.equal(versions[2].original, true);
  const { update } = await boards.call(owner, {
    op: "history.state",
    room: b.id,
    at: secondAt,
  });
  const past = new SharedDocument(
    Uint8Array.from(atob(update), (c) => c.charCodeAt(0)),
  );
  assert.equal(past.snapshot().items[0].text, "Second");
  past.destroy();
  const invite = await boards.call(owner, {
    op: "invite",
    room: b.id,
    role: "viewer",
  });
  await boards.call(viewer, { op: "join", room: b.id, token: invite.token });
  // Viewers can read history but cannot record a restoration.
  await boards.call(viewer, { op: "history.list", room: b.id });
  await assert.rejects(
    boards.call(viewer, { op: "history.restored", room: b.id, at: secondAt }),
    {
      status: 403,
    },
  );
  await boards.call(owner, {
    op: "history.restored",
    room: b.id,
    at: secondAt,
    scope: "frame",
    objects: 2,
  });
  const audit = [...env.data]
    .filter(
      ([k, v]) =>
        k.startsWith("org:audit:") && v.action === "board.content.restored",
    )
    .map(([, v]) => v);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.scope, "frame");
  assert.equal(
    historyVersions([
      { at: 1, username: "a" },
      { at: 2, username: "b" },
    ]).length,
    1,
  );
});

test("a board's starting content is a version, even when its first edit removed it", async () => {
  const env = environment(),
    boards = env.service;
  const b = board("Imported"),
    doc = new SharedDocument();
  // Content it began with, as from an import, a template or a copy.
  b.items = Array.from({ length: 5 }, (_, n) =>
    item("note", n * 100, 0, { text: `Imported ${n}` }),
  );
  doc.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  const created = env.now;
  const { token } = await boards.call(owner, {
    op: "invite",
    room: b.id,
    role: "editor",
  });
  await boards.call(editor, { op: "join", room: b.id, token });
  // Cleared in the same millisecond, then edited again later.
  await commit(boards, editor, b.id, (s) => (s.items = []));
  env.now += 10 * 60_000;
  await commit(boards, editor, b.id, (s) =>
    s.items.push(item("note", 0, 0, { text: "New" })),
  );
  // Ownership moving on leaves the creator named.
  await boards.call(owner, { op: "transfer", room: b.id, uuid: editor.uuid });
  const objects = async (at) => {
    const { update } = await boards.call(editor, {
      op: "history.state",
      room: b.id,
      at,
    });
    const then = new SharedDocument(decode(update));
    try {
      return then.snapshot().items.map((i) => i.text);
    } finally {
      then.destroy();
    }
  };
  const { versions, more } = await boards.call(editor, {
    op: "history.list",
    room: b.id,
  });
  assert.equal(more, false);
  assert.deepEqual(
    versions.map((v) => [v.edits, v.original === true]),
    [
      [1, false],
      [1, false],
      [0, true],
    ],
  );
  assert.deepEqual(versions[2], {
    start: created,
    until: created,
    edits: 0,
    authors: ["Alice"],
    at: created,
    original: true,
  });
  // The clearing edit, stamped as the board was created, is listed after
  // it, and the original state has none of it.
  assert.ok(versions[1].at > created);
  assert.deepEqual(await objects(versions[1].at), []);
  assert.deepEqual(await objects(versions[0].at), ["New"]);
  assert.equal((await objects(created)).length, 5);
  // Paging reaches it once, after the versions before it.
  const older = await boards.call(editor, {
    op: "history.list",
    room: b.id,
    before: versions[0].at,
  });
  assert.deepEqual(older.versions, versions.slice(1));
  const none = await boards.call(editor, {
    op: "history.list",
    room: b.id,
    before: created,
  });
  assert.deepEqual(none.versions, []);
});

test("objects added and removed within one version can still be recovered", async () => {
  const env = environment(),
    boards = env.service;
  // On the hour, so the edits below share a quarter of an hour.
  env.now = Date.parse("2026-03-02T09:00:00Z");
  const b = board("Decisions"),
    doc = new SharedDocument();
  b.items = [item("note", 0, 0, { text: "Seed" })];
  doc.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  for (const [user, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ]) {
    const { token } = await boards.call(owner, {
      op: "invite",
      room: b.id,
      role,
    });
    await boards.call(user, { op: "join", room: b.id, token });
  }
  env.now += 60_000;
  await commit(boards, owner, b.id, (s) => (s.items[0].text = "Seed v1"));
  // Half an hour later, a decision is noted, tagged, and kept for four
  // minutes; meanwhile the facilitator puts up an answer hidden from
  // participants. Both go, with the tag, within the same version.
  env.now += 30 * 60_000;
  const decision = item("note", 100, 0, {
    text: "Decision",
    tagIds: ["urgent"],
  });
  await commit(boards, editor, b.id, (s) => {
    s.tags = [{ id: "urgent", name: "Urgent", color: "#ff0000" }];
    s.items.push(decision);
  });
  env.now += 60_000;
  const answer = item("note", 300, 0, { text: "Answer" });
  await commit(boards, owner, b.id, (s) => {
    s.items.push(answer);
    s.workshop = { settings: { hide: [answer.id] } };
  });
  env.now += 60_000;
  await commit(boards, editor, b.id, (s) => {
    s.items = s.items.filter((i) => i.id !== decision.id);
    delete s.tags;
  });
  env.now += 2 * 60_000;
  await commit(boards, owner, b.id, (s) => {
    s.items = s.items.filter((i) => i.id !== answer.id);
    delete s.workshop;
  });
  const { versions } = await boards.call(owner, {
    op: "history.list",
    room: b.id,
  });
  assert.deepEqual(
    versions.map((v) => v.edits),
    [4, 1, 0],
  );
  // Neither version holds them.
  for (const v of versions) {
    const { update } = await boards.call(owner, {
      op: "history.state",
      room: b.id,
      at: v.at,
    });
    const then = new SharedDocument(decode(update));
    assert.deepEqual(
      then.snapshot().items.map((i) => i.text),
      [v.original ? "Seed" : "Seed v1"],
    );
    then.destroy();
  }
  const removed = (user, after = versions[1].at) =>
    boards.call(user, {
      op: "history.removed",
      room: b.id,
      at: versions[0].at,
      after,
    });
  // Each as it last stood, with the tag it carried.
  const all = await removed(owner);
  const text = (r) => r.items.map((i) => i.text).sort();
  assert.deepEqual(text(all), ["Answer", "Decision"]);
  assert.deepEqual(all.items.find((i) => i.id === decision.id).tagIds, [
    "urgent",
  ]);
  assert.deepEqual(all.tags, [
    { id: "urgent", name: "Urgent", color: "#ff0000" },
  ]);
  // What the workshop hid from participants then stays hidden from them.
  for (const user of [editor, viewer])
    assert.deepEqual(
      (await removed(user)).items.map((i) => i.text),
      ["Decision"],
    );
  // Nothing came and went in the version before, and asking from long
  // before replays no more than a version's quarter of an hour.
  assert.deepEqual(
    (
      await boards.call(owner, {
        op: "history.removed",
        room: b.id,
        at: versions[1].at,
        after: versions[2].at,
      })
    ).items,
    [],
  );
  assert.deepEqual(text(await removed(owner, 0)), ["Answer", "Decision"]);
  await assert.rejects(
    boards.call(owner, {
      op: "history.removed",
      room: b.id,
      at: versions[1].at,
      after: versions[0].at,
    }),
    { status: 400 },
  );
});

test("a restoration report names a time in the board's life, and no more objects than it has held", async () => {
  const env = environment(),
    boards = env.service;
  const b = board("Audit"),
    doc = new SharedDocument();
  b.items = [item("note", 0, 0, { text: "One" })];
  doc.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  const created = env.now;
  env.now += 60_000;
  // Three objects added, then two of them removed: four in all.
  await commit(boards, owner, b.id, (s) =>
    s.items.push(...[1, 2, 3].map((n) => item("note", n * 100, 0))),
  );
  await commit(boards, owner, b.id, (s) => (s.items = s.items.slice(0, 2)));
  const report = (details) => {
    env.now++;
    return boards.call(owner, {
      op: "history.restored",
      room: b.id,
      ...details,
    });
  };
  for (const at of [123, created - 1, env.now + 3600_000, "soon"])
    await assert.rejects(report({ at, scope: "board", objects: 1 }), {
      status: 400,
    });
  await report({ at: created, scope: "board", objects: 99999 });
  await report({ at: null, scope: "deleted", objects: 2 });
  await report({ scope: "objects", objects: -5 });
  const audit = [...env.data]
    .filter(
      ([k, v]) =>
        k.startsWith("org:audit:") && v.action === "board.content.restored",
    )
    .map(([, v]) => v)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((v) => v.details);
  assert.deepEqual(audit, [
    { version: created, scope: "board", objects: 4 },
    { version: null, scope: "deleted", objects: 2 },
    { version: null, scope: "objects", objects: null },
  ]);
});

test("shared history arrives a page at a time so every version can be reached", async () => {
  const env = environment(),
    boards = env.service;
  const b = board("Long history"),
    doc = new SharedDocument();
  b.items = [item("note", 0, 0, { text: "0" })];
  doc.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  // Many edits within one early version, then edits more than five
  // minutes apart, which are separate versions.
  for (let n = 1; n <= 30; n++)
    await commit(boards, owner, b.id, (next) => {
      next.items[0].text = `early ${n}`;
    });
  for (let n = 1; n <= 305; n++) {
    env.now += 6 * 60_000;
    await commit(boards, owner, b.id, (next) => {
      next.items[0].text = String(n);
    });
  }
  const list = boards.kv.list.bind(boards.kv);
  let pages = 0;
  boards.kv.list = async (options) => {
    if (options.pattern?.includes(":log:")) pages++;
    return list(options);
  };
  const first = await boards.call(owner, { op: "history.list", room: b.id });
  const read = pages;
  assert.equal(first.versions.length, 300);
  assert.equal(first.more, true);
  const rest = await boards.call(owner, {
    op: "history.list",
    room: b.id,
    before: first.versions.at(-1).at,
  });
  assert.equal(rest.more, false);
  // The five oldest spaced versions, the early one, and the board as it
  // was created.
  assert.equal(rest.versions.length, 7);
  assert.equal(rest.versions.at(-1).original, true);
  assert.ok(rest.versions.every((v) => v.at < first.versions.at(-1).at));
  // A board from before checkpoints, whose first edits are op: records,
  // still reads only the pages its versions need, not its whole log.
  await boards.kv.set(`wb:${b.id}:op:0`, {
    at: env.now - 2000 * 60_000,
    author: owner.uuid,
    username: owner.username,
  });
  try {
    pages = 0;
    const legacy = await boards.call(owner, {
      op: "history.list",
      room: b.id,
    });
    assert.equal(legacy.versions.length, 300);
    assert.equal(legacy.more, true);
    assert.equal(pages, read, "the legacy record adds no log pages");
  } finally {
    boards.kv.list = list;
  }
});

test("a long session without pauses leaves versions inside it to go back to", async () => {
  const env = environment(),
    boards = env.service;
  const b = board("Workshop"),
    doc = new SharedDocument();
  b.items = [item("note", 0, 0, { text: "0" })];
  doc.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  // Two hours of edits, never more than four minutes apart.
  for (let n = 1; n <= 30; n++) {
    env.now += 4 * 60_000;
    await commit(boards, owner, b.id, (next) => {
      next.items[0].text = String(n);
    });
  }
  const { versions } = await boards.call(owner, {
    op: "history.list",
    room: b.id,
  });
  assert.ok(versions.length >= 8, `${versions.length} versions`);
  assert.ok(versions.every((v) => v.until - v.start <= 15 * 60_000));
  // The version before the newest is a state from inside the session.
  const state = await boards.call(owner, {
    op: "history.state",
    room: b.id,
    at: versions[1].at,
  });
  const then = new SharedDocument(decode(state.update));
  const text = Number(then.snapshot().items[0].text);
  then.destroy();
  assert.ok(text > 1 && text < 30, String(text));
});

test("a restoration that would pass the board's size limit is refused whole", () => {
  const kept = Array.from({ length: 4998 }, (_, n) =>
    item("note", n, 0, { text: `k${n}` }),
  );
  const gone = Array.from({ length: 3 }, (_, n) =>
    item("note", n, 100, { text: `g${n}` }),
  );
  const current = { ...board("Now"), items: kept },
    version = { ...board("Then"), items: [...kept, ...gone] };
  assert.throws(() => recoverDeleted(current, version), /5,000 objects/);
  assert.throws(
    () => restoreObjects(current, version, new Set(gone.map((i) => i.id))),
    /5,000 objects/,
  );
  // Two fit.
  const smaller = { ...version, items: [...kept, ...gone.slice(0, 2)] };
  assert.equal(recoverDeleted(current, smaller).count, 2);
});

test("objects, frames, and deleted content restore without touching the rest", () => {
  const frame = item("frame", 0, 0, { w: 400, h: 400, text: "Ideas" });
  const a = item("note", 10, 60, { text: "A", parentId: frame.id });
  const b = item("note", 200, 60, { text: "B", parentId: frame.id });
  const outside = item("note", 600, 0, { text: "Outside" });
  const link = item("arrow", 0, 0, { startId: a.id, endId: outside.id });
  const version = { ...board("V"), items: [frame, a, b, outside, link] };
  const current = {
    ...board("V"),
    items: [
      frame,
      { ...a, text: "A changed" },
      item("note", 300, 300, { text: "New in frame", parentId: frame.id }),
      { ...outside, text: "Outside changed" },
    ],
  };
  const objects = restoreObjects(current, version, new Set([a.id]));
  assert.equal(objects.items.find((i) => i.id === a.id).text, "A");
  assert.equal(
    objects.items.find((i) => i.id === outside.id).text,
    "Outside changed",
  );
  assert.ok(
    objects.items.some((i) => i.id === link.id),
    "connector returns with its end",
  );
  const framed = restoreFrame(current, version, frame.id);
  assert.deepEqual(
    framed.items
      .filter((i) => i.parentId === frame.id)
      .map((i) => i.text)
      .sort(),
    ["A", "B"],
  );
  assert.equal(
    framed.items.find((i) => i.id === outside.id).text,
    "Outside changed",
  );
  assert.deepEqual(
    deletedSince(current, version)
      .map((i) => i.id)
      .sort(),
    [b.id, link.id].sort(),
  );
  const recovered = recoverDeleted(current, version);
  assert.ok(recovered.items.some((i) => i.id === b.id));
  assert.equal(recovered.items.find((i) => i.id === a.id).text, "A changed");
  assert.throws(() => restoreFrame(current, version, "missing"));
  // An object moved into the frame since goes back to where it was.
  const moved = {
    ...current,
    items: [
      ...current.items.filter((i) => i.id !== outside.id),
      { ...outside, x: 20, y: 200, parentId: frame.id },
    ],
  };
  const back = restoreFrame(moved, version, frame.id);
  assert.deepEqual(
    back.items.find((i) => i.id === outside.id),
    outside,
  );
  // Locks are checked on every existing object a frame restore changes,
  // including one that has left the frame since.
  const left = {
    ...current,
    items: current.items.map((i) =>
      i.id === a.id ? { ...i, x: 900, parentId: undefined, locked: true } : i,
    ),
  };
  for (const now of [current, moved, left]) {
    const ids = frameRestoreIds(now, version, frame.id),
      after = new Map(
        restoreFrame(now, version, frame.id).items.map((i) => [i.id, i]),
      );
    for (const i of now.items)
      if (JSON.stringify(after.get(i.id)) !== JSON.stringify(i))
        assert.ok(ids.has(i.id), i.text);
  }
  assert.ok(frameRestoreIds(left, version, frame.id).has(a.id));
  // A connector outside the frame loses its end when an object added to
  // the frame since is removed, so it is in scope too.
  const added = item("note", 50, 300, { text: "Added", parentId: frame.id });
  const arrow = item("arrow", 0, 0, {
    startId: outside.id,
    endId: added.id,
    locked: true,
  });
  const attached = {
    ...current,
    items: [...current.items, added, arrow],
  };
  assert.ok(frameRestoreIds(attached, version, frame.id).has(arrow.id));
});

test("an object is unchanged whatever order its fields are listed in", () => {
  const frame = item("frame", 0, 0, { w: 400, h: 300, text: "F" });
  const note = item("note", 20, 20, {
    text: "Kept",
    parentId: frame.id,
    locked: true,
  });
  const current = { ...board("T"), items: [frame, note] };
  // A shared version lists each object's fields in the document's order.
  const doc = new SharedDocument();
  doc.commit(current);
  const version = doc.snapshot();
  doc.destroy();
  const shared = version.items.find((i) => i.id === note.id);
  assert.notEqual(JSON.stringify(shared), JSON.stringify(note));
  assert.ok(sameObject(shared, note));
  assert.deepEqual([...frameRestoreIds(current, version, frame.id)], []);
  assert.ok(!sameObject(shared, { ...note, text: "Changed" }));
  assert.ok(!sameObject(shared, { ...note, extra: 1 }));
  assert.ok(
    sameObject(
      { ...note, parentId: undefined, a: undefined },
      {
        ...note,
        parentId: undefined,
      },
    ),
  );
  assert.ok(!sameObject({ points: [1, 2] }, { points: [2, 1] }));
});

test("versions after the latest checkpoint are rebuilt from it", async () => {
  const env = environment(),
    boards = env.service;
  env.now = Date.parse("2026-03-01T11:00:00Z");
  const b = board("Checkpointed"),
    doc = new SharedDocument();
  b.items = [item("note", 0, 0, { text: "One" })];
  doc.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  let clock = Date.parse("2026-03-01T12:00:00Z");
  boards.now = () => clock;
  const texts = ["Two", "Three", "Four", "Five"];
  const times = [];
  for (const [n, text] of texts.entries()) {
    clock += 5 * 60_000;
    await commit(boards, owner, b.id, (s) => (s.items[0].text = text));
    times.push(clock);
    if (n === 1) {
      clock += 5 * 60_000;
      const { doc: current } = await boards.load(b.id);
      await boards.checkpoint(b.id, current, clock);
      current.destroy();
    }
  }
  const read = [];
  const cachedFile = boards.cachedFile.bind(boards);
  boards.cachedFile = (path) => (read.push(path), cachedFile(path));
  const at = async (moment) => {
    const { update } = await boards.call(owner, {
      op: "history.state",
      room: b.id,
      at: moment,
    });
    const past = new SharedDocument(
      Uint8Array.from(atob(update), (c) => c.charCodeAt(0)),
    );
    try {
      return past.snapshot().items[0].text;
    } finally {
      past.destroy();
    }
  };
  assert.deepEqual([await at(times[0]), await at(times[1])], ["Two", "Three"]);
  // Earlier versions start from an earlier checkpoint, not the latest.
  const latest = await boards.kv.get(`wb:${b.id}:cp`);
  assert.ok(!read.includes(latest.path));
  read.length = 0;
  assert.deepEqual([await at(times[2]), await at(times[3])], ["Four", "Five"]);
  assert.ok(read.some((path) => path.includes("/checkpoints/")));
});

test("restoring repairs deleted tags, mind map parents, and connectors", () => {
  const mind = (id, parent) =>
    item("note", 0, 0, {
      id,
      mindMap: { parent, direction: "right", auto: true, line: "curved" },
    });
  // A deleted connector between two shapes that still exist comes back.
  const version = board("Then");
  version.tags = [{ id: "t1", name: "Urgent", color: "#ff0000" }];
  version.items = [
    item("rect", 0, 0, { id: "a" }),
    item("rect", 400, 0, { id: "b" }),
    item("arrow", 0, 0, { id: "c", startId: "a", endId: "b", w: 10, h: 10 }),
    item("note", 0, 200, { id: "n", tagIds: ["t1"] }),
    mind("A", null),
    mind("B", "A"),
  ];
  validateBoard(version);
  const current = board("Now");
  current.items = [
    item("rect", 0, 0, { id: "a" }),
    item("rect", 400, 0, { id: "b" }),
    item("note", 0, 0, { id: "A" }),
  ];
  const before = JSON.stringify(current);
  const recovered = recoverDeleted(current, version);
  assert.equal(recovered.count, 3);
  assert.ok(recovered.items.some((i) => i.id === "c"));
  // The tag was deleted since, and A is no longer a mind map node.
  validateBoard({ ...current, items: recovered.items });
  assert.equal(recovered.items.find((i) => i.id === "n").tagIds, undefined);
  assert.equal(recovered.items.find((i) => i.id === "B").mindMap.parent, null);
  // Restoring B under A after A moved under B cannot form a cycle.
  const moved = clone(version);
  moved.items = [mind("A", "B"), mind("B", null)];
  const restored = restoreObjects(moved, version, new Set(["B"]));
  validateBoard({ ...moved, items: restored.items });
  // The loop is broken on the restored object, never on one the person
  // did not restore, such as a locked node that sorts later.
  const locked = clone(version);
  locked.items = [
    mind("A", null),
    { ...mind("Z", "B"), locked: true },
    mind("B", "A"),
  ];
  const then = clone(version);
  then.items = [mind("A", null), mind("Z", "A"), mind("B", "Z")];
  const after = restoreObjects(locked, then, new Set(["B"])).items;
  assert.deepEqual(
    after.find((i) => i.id === "Z"),
    locked.items[1],
  );
  assert.equal(after.find((i) => i.id === "B").mindMap.parent, null);
  assert.equal(
    JSON.stringify(current),
    before,
    "the current board is unchanged",
  );
});

test("the shared version list shows only well-formed versions from the worker", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test/",
  });
  const keys = ["window", "document", "HTMLElement", "Node", "NodeFilter"];
  const previous = keys.map((key) => [key, globalThis[key]]);
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createFeatures } = await import("../src/features.js");
    const b = { id: "b1", version: 1, title: "B", items: [] };
    const api = new Proxy(
      {
        board: () => b,
        modal: (title, content) => {
          const d = document.createElement("dialog");
          d.innerHTML = content;
          document.body.append(d);
          return d;
        },
        waitForSaves: async () => {},
        local: { revisions: async () => [], checkpoint: async () => {} },
        sharedHistory: () => ({
          list: async () => ({
            versions: [
              { at: Date.now(), authors: ["Ada"], edits: 1 },
              {
                at: '1"><img id=attr-inject>',
                authors: ["Mallory"],
                edits: "<img id=pwned>",
              },
            ],
          }),
          load: async () => b,
          note: async () => {},
        }),
        refresh() {},
        toast() {},
      },
      { get: (target, key) => (key in target ? target[key] : () => undefined) },
    );
    await createFeatures(api).actions.history();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(document.querySelector("img"), null);
    assert.equal(
      document.querySelectorAll("#shared-revisions .revision-row").length,
      1,
    );
  } finally {
    for (const [key, value] of previous)
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
  }
});

test("restoring part of a version leaves out what is hidden from the person", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test/",
  });
  const keys = ["window", "document", "HTMLElement", "Node", "NodeFilter"];
  const previous = keys.map((key) => [key, globalThis[key]]);
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createFeatures } = await import("../src/features.js");
    const ideas = item("frame", 0, 0, { id: "ideas", w: 700, h: 400 });
    const shown = item("note", 30, 60, { id: "shown", parentId: "ideas" });
    const secret = item("note", 300, 60, { id: "secret", parentId: "ideas" });
    const answers = item("frame", 900, 0, { id: "answers", w: 400, h: 300 });
    const version = {
      ...board("W"),
      items: [ideas, shown, secret, answers],
      workshop: { settings: { hide: ["secret", "answers"] } },
    };
    const current = { ...board("W"), id: version.id, items: [ideas] };
    let replaced = null;
    const api = new Proxy(
      {
        board: () => current,
        modal: (title, content) => {
          const d = document.createElement("dialog");
          d.innerHTML = content;
          document.body.append(d);
          return d;
        },
        waitForSaves: async () => {},
        local: { revisions: async () => [], checkpoint: async () => {} },
        sharedHistory: () => ({
          list: async () => ({
            versions: [
              { at: 2, authors: ["Ada"], edits: 1 },
              { at: 1, authors: ["Ada"], edits: 1 },
            ],
          }),
          load: async () => clone(version),
          note: async () => {},
        }),
        concealedIn: (b) => new Set(b.workshop?.settings?.hide || []),
        selection: () => new Set(),
        canEdit: () => true,
        replaceItems: (items) => (replaced = items),
        refresh() {},
        toast() {},
      },
      { get: (target, key) => (key in target ? target[key] : () => undefined) },
    );
    await createFeatures(api).actions.history();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    document.querySelector('[data-shared-options="1"]').click();
    await tick();
    const recover = document.querySelector('[data-part="deleted"]');
    assert.match(recover.textContent, /\(1\)/, "Only the visible note");
    recover.click();
    await tick();
    assert.deepEqual(replaced.map((i) => i.id).sort(), ["ideas", "shown"]);
    // Restoring the whole version leaves the hidden objects out too.
    let restored = null;
    api.restore = (b) => (restored = b);
    await createFeatures(api).actions.history();
    await tick();
    document.querySelector('[data-shared="1"]').click();
    await tick();
    assert.deepEqual(restored.items.map((i) => i.id).sort(), [
      "ideas",
      "shown",
    ]);
  } finally {
    for (const [key, value] of previous)
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
  }
});

test("deleted objects can be recovered one by one, with the lines that join them", async () => {
  const a = item("note", 0, 0, { id: "a", text: "Keep deleted" }),
    b = item("note", 300, 0, { id: "b", text: "Bring back" }),
    c = item("note", 600, 0, { id: "c", text: "Also back" }),
    line = item("arrow", 0, 0, { id: "l", startId: "b", endId: "c" });
  const version = { ...board("V"), items: [a, b, c, line] };
  const current = { ...board("V"), id: version.id, items: [] };
  assert.deepEqual(
    recoverDeleted(current, version, new Set(["b", "c"]))
      .items.map((i) => i.id)
      .sort(),
    ["b", "c", "l"],
  );
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test/",
  });
  const keys = ["window", "document", "HTMLElement", "Node", "NodeFilter"];
  const previous = keys.map((key) => [key, globalThis[key]]);
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createFeatures } = await import("../src/features.js");
    let replaced = null;
    const api = new Proxy(
      {
        board: () => current,
        modal: (title, content) => {
          const d = document.createElement("dialog");
          d.innerHTML = content;
          document.body.append(d);
          return d;
        },
        waitForSaves: async () => {},
        local: { revisions: async () => [], checkpoint: async () => {} },
        sharedHistory: () => ({
          list: async () => ({
            versions: [
              { at: 2, authors: ["Ada"], edits: 1 },
              { at: 1, authors: ["Ada"], edits: 1 },
            ],
          }),
          load: async () => clone(version),
          note: async () => {},
        }),
        concealedIn: () => new Set(),
        selection: () => new Set(),
        canEdit: () => true,
        replaceItems: (items) => (replaced = items),
        refresh() {},
        toast() {},
      },
      { get: (target, key) => (key in target ? target[key] : () => undefined) },
    );
    await createFeatures(api).actions.history();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    document.querySelector('[data-shared-options="1"]').click();
    await tick();
    const recover = document.querySelector('[data-part="deleted"]');
    // The line comes back with the notes it joins, so it is not a choice.
    const choices = [...document.querySelectorAll(".deleted-choices input")];
    assert.deepEqual(
      choices.map((input) => [input.value, input.checked]),
      [
        ["a", true],
        ["b", true],
        ["c", true],
      ],
    );
    assert.match(recover.textContent, /\(3\)/);
    choices[0].click();
    assert.match(recover.textContent, /\(2\)/);
    recover.click();
    await tick();
    assert.deepEqual(replaced.map((i) => i.id).sort(), ["b", "c", "l"]);
    // Unchecking everything leaves nothing to recover.
    document.body.replaceChildren();
    await createFeatures(api).actions.history();
    await tick();
    document.querySelector('[data-shared-options="1"]').click();
    await tick();
    for (const input of document.querySelectorAll(".deleted-choices input"))
      input.click();
    assert.equal(
      document.querySelector('[data-part="deleted"]').disabled,
      true,
    );
  } finally {
    for (const [key, value] of previous)
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
  }
});

test("restoring a frame keeps the objects the person may not see", () => {
  const frame = item("frame", 0, 0, { id: "f", w: 400, h: 300 });
  const hidden = item("note", 20, 20, { id: "h", parentId: "f" });
  const version = { ...board("V"), items: [clone(frame)] };
  const current = { ...board("V"), items: [frame, hidden] };
  const { items } = restoreFrame(current, version, "f", new Set(["h"]));
  assert.deepEqual(items.map((i) => i.id).sort(), ["f", "h"]);
});

test("restoring a whole version drops links to hidden objects deleted since", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://whiteboard.test/",
  });
  const keys = ["window", "document", "HTMLElement", "Node", "NodeFilter"];
  const previous = keys.map((key) => [key, globalThis[key]]);
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createFeatures } = await import("../src/features.js");
    const mind = (id, parent, extra) =>
      item("note", 0, 0, {
        id,
        mindMap: { parent, direction: "right", auto: true, line: "curved" },
        ...extra,
      });
    // The hidden frame and note were deleted after this version, but the
    // version's visible objects still point at them.
    const version = {
      ...board("W"),
      items: [
        item("frame", 0, 0, { id: "answers", w: 700, h: 400 }),
        mind("secret", null),
        mind("shown", "secret", { parentId: "answers" }),
        item("rect", 400, 0, { id: "box" }),
        item("arrow", 0, 0, {
          id: "link",
          startId: "box",
          endId: "secret",
          w: 10,
          h: 10,
        }),
      ],
      workshop: { settings: { hide: ["answers", "secret"] } },
    };
    validateBoard(version);
    const current = { ...board("W"), id: version.id, items: [] };
    let restored = null;
    const toasts = [];
    const api = new Proxy(
      {
        board: () => current,
        modal: (title, content) => {
          const d = document.createElement("dialog");
          d.innerHTML = content;
          d.close = () => d.remove();
          document.body.append(d);
          return d;
        },
        waitForSaves: async () => {},
        local: { revisions: async () => [], checkpoint: async () => {} },
        sharedHistory: () => ({
          list: async () => ({
            versions: [
              { at: 2, authors: ["Ada"], edits: 1 },
              { at: 1, authors: ["Ada"], edits: 1 },
            ],
          }),
          load: async () => clone(version),
          note: async () => {},
        }),
        concealedIn: (b) => new Set(b.workshop?.settings?.hide || []),
        selection: () => new Set(),
        canEdit: () => true,
        // Like the editor, restoring checks the board first.
        restore: (b) => (restored = validateBoard(b)),
        refresh() {},
        toast: (message) => toasts.push(message),
      },
      { get: (target, key) => (key in target ? target[key] : () => undefined) },
    );
    await createFeatures(api).actions.history();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    await tick();
    document.querySelector('[data-shared="1"]').click();
    await tick();
    assert.deepEqual(toasts, ["Version restored."]);
    const byId = new Map(restored.items.map((i) => [i.id, i]));
    assert.deepEqual([...byId.keys()].sort(), ["box", "link", "shown"]);
    assert.equal(byId.get("shown").parentId, undefined);
    assert.equal(byId.get("shown").mindMap.parent, null);
    assert.equal(byId.get("link").startId, "box");
    assert.equal(byId.get("link").endId, undefined);
  } finally {
    for (const [key, value] of previous)
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
  }
});

test("recovered objects return to their place in the stacking order", () => {
  const bg = item("rect", 0, 0, { id: "bg", w: 800, h: 600 });
  const n1 = item("note", 50, 50, { id: "n1", text: "A" });
  const n2 = item("note", 300, 50, { id: "n2", text: "B" });
  const top = item("note", 600, 50, { id: "top", text: "C" });
  const version = { ...board("B"), items: [bg, n1, n2, top] };
  const current = { ...version, items: [n1, n2] };
  const order = (items) => items.map((i) => i.id).join(" ");
  // A background deleted from under notes comes back under them, and an
  // object that was on top comes back on top.
  assert.equal(order(recoverDeleted(current, version).items), "bg n1 n2 top");
  assert.equal(
    order(restoreObjects(current, version, new Set(["bg"])).items),
    "bg n1 n2",
  );
  // Objects the board still has keep their current order.
  const reordered = { ...version, items: [n2, n1] };
  assert.equal(order(recoverDeleted(reordered, version).items), "bg n2 n1 top");
  // Restoring a frame puts its deleted background back under its notes.
  const frame = item("frame", -10, -10, { id: "f", w: 900, h: 700 });
  const inside = (i) => ({ ...i, parentId: "f" });
  const framed = { ...board("F"), items: [frame, inside(bg), inside(n1)] };
  assert.equal(
    order(
      restoreFrame({ ...framed, items: [frame, inside(n1)] }, framed, "f")
        .items,
    ),
    "f bg n1",
  );
});

test("restoring a whole version leaves what is hidden from the person restoring as it is now", () => {
  const frame = item("frame", 0, 0, { id: "answers", w: 800, h: 600 }),
    shown = item("note", 900, 0, { id: "shown", text: "Old" }),
    answer = item("note", 10, 10, {
      id: "a1",
      text: "old answer",
      parentId: "answers",
      tagIds: ["t1"],
    });
  const version = { ...board("Quiz"), items: [frame, shown, answer], tags: [] };
  const current = {
    ...version,
    items: [
      frame,
      { ...answer, text: "final answer" },
      item("note", 20, 20, { id: "a2", text: "new", parentId: "answers" }),
      { ...shown, text: "New" },
    ],
    tags: [{ id: "t1", name: "Key", color: "#dce5f7" }],
  };
  const gone = item("note", 0, 0, { id: "gone", text: "hidden then" });
  version.items.push(gone);
  const hidden = new Set(["a1", "a2", "gone"]);
  const restored = restoreBoard(current, version, hidden);
  assert.deepEqual(
    restored.items.map((i) => i.id),
    ["answers", "a1", "a2", "shown"],
    "hidden objects keep their place; one hidden then and gone stays gone",
  );
  const byId = new Map(restored.items.map((i) => [i.id, i]));
  assert.equal(byId.get("a1").text, "final answer");
  assert.deepEqual(byId.get("a1").tagIds, ["t1"]);
  assert.deepEqual(
    restored.tags.map((t) => t.id),
    ["t1"],
  );
  assert.equal(byId.get("shown").text, "Old", "visible objects are restored");
  validateBoard(restored);
  // Nothing hidden: the version as it was.
  assert.deepEqual(
    restoreBoard(current, version).items.map((i) => i.id),
    ["answers", "shown", "a1", "gone"],
  );
});

test("opening an earlier version as a copy leaves out what is hidden from this person now", async () => {
  const dom = new JSDOM(
    "<!doctype html><body><canvas id=canvas></canvas></body>",
    { url: "https://whiteboard.test/" },
  );
  const keys = ["window", "document", "HTMLElement", "Node", "NodeFilter"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createFeatures } = await import("../src/features.js");
    const { createFacilitationUI } = await import("../src/facilitation/ui.js");
    const answers = item("frame", 900, 0, { id: "answers", w: 400, h: 300 });
    const answer = item("note", 920, 20, {
      id: "a1",
      parentId: "answers",
      text: "THE ANSWER",
    });
    const shown = item("note", 0, 0, { id: "shown", text: "Warm-up" });
    // Before the facilitator hid the answers.
    const version = validateBoard({
      ...board("W"),
      items: [answers, answer, shown],
    });
    const current = validateBoard({
      ...version,
      items: clone(version.items),
      workshop: { settings: { hide: ["answers"] } },
    });
    const any = (target) =>
      new Proxy(target, {
        get: (t, k) => (k in t ? t[k] : () => undefined),
      });
    const facilitation = createFacilitationUI(
      any({
        board: () => current,
        identity: () => ({ id: "participant", name: "P" }),
        role: () => "editor",
        canParticipate: () => true,
        now: () => Date.now(),
      }),
    );
    let added = null;
    const toasts = [];
    const api = any({
      board: () => current,
      modal: (title, html) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        d.close = () => d.remove();
        document.body.append(d);
        return d;
      },
      waitForSaves: async () => {},
      local: { revisions: async () => [], checkpoint: async () => {} },
      sharedHistory: () => ({
        list: async () => ({
          versions: [
            { at: 2, authors: ["F"], edits: 1 },
            { at: 1, authors: ["F"], edits: 1 },
          ],
        }),
        load: async () => clone(version),
        note: async () => {},
      }),
      concealedIn: (b) => facilitation.concealedIn(b),
      portableCopy: (c) => facilitation.portableCopy(c),
      selection: () => new Set(),
      canEdit: () => true,
      addBoard: async (b) => (added = b),
      refresh() {},
      toast: (m) => toasts.push(m),
    });
    await createFeatures(api).actions.history();
    const tick = () => new Promise((r) => setTimeout(r, 20));
    await tick();
    document.querySelector('[data-shared-options="1"]').click();
    await tick();
    document.querySelector('[data-part="copy"]').click();
    await tick();
    assert.deepEqual(
      added.items.map((i) => i.id),
      ["shown"],
    );
    assert.match(toasts.at(-1), /hidden from you was left out/);
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("listing a long shared history reads only as far back as the page shown", async () => {
  const env = environment();
  env.now = Date.parse("2025-12-31T00:00:00Z");
  const b = board("Long");
  b.items = [item("note", 0, 0)];
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  // Bursts of edits, some minutes apart, as in a long workshop series.
  let t = Date.parse("2026-01-01T00:00:00Z"),
    state = 7;
  const random = () =>
    (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const all = [];
  for (let n = 0; n < 8000; n++) {
    t += random() < 0.2 ? 6 * 60_000 + random() * 3e6 : random() * 200_000;
    const iso = new Date(Math.round(t)).toISOString();
    env.data.set(
      `wb:${b.id}:log:${iso}:${owner.uuid}:${n.toString(16).padStart(64, "0")}`,
      { at: t, author: owner.uuid, update: "" },
    );
    all.push({ at: Date.parse(iso), author: owner.uuid, username: "Alice" });
  }
  // Pages of 200 keys, as the platform returns them.
  const keys = [...env.data.keys()].sort();
  let lists = 0;
  env.service.kv.list = async ({
    pattern,
    cursor,
    limit,
    reverse,
    returnValues,
  }) => {
    lists++;
    const p = pattern.replace(/\*$/, "");
    let found = keys.filter((k) => k.startsWith(p));
    if (reverse) found = found.reverse();
    const at = Number(cursor || 0),
      end = at + limit;
    return {
      items: found
        .slice(at, end)
        .map((key) =>
          returnValues
            ? { key, value: structuredClone(env.data.get(key)) }
            : key,
        ),
      cursor: end < found.length ? String(end) : undefined,
    };
  };
  const expected = [
    ...historyVersions(all, undefined, Infinity),
    {
      start: env.now,
      until: env.now,
      edits: 0,
      authors: ["Alice"],
      at: env.now,
      original: true,
    },
  ];
  const shown = [];
  let before,
    first = 0;
  for (let page = 0; page < 20; page++) {
    lists = 0;
    const r = await env.service.call(owner, {
      op: "history.list",
      room: b.id,
      ...(before ? { before } : {}),
    });
    if (!page) first = lists;
    shown.push(...r.versions);
    before = r.versions.at(-1)?.at;
    if (!r.more) break;
  }
  assert.deepEqual(shown, expected, "every version, as before");
  assert.ok(expected.length > 300);
  // Not the whole log: the first page's versions are among the newest.
  assert.ok(
    first * 200 < all.length / 2,
    `the first page read ${first} pages of keys`,
  );
});

test("listing a history of long working sessions reads only as far back as the page shown", async () => {
  const env = environment();
  env.now = Date.parse("2025-12-31T00:00:00Z");
  const b = board("Workshops");
  b.items = [item("note", 0, 0)];
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  // Thirty days of eight-hour sessions with a save every minute: each
  // session holds about 32 versions, so 300 come from the newest ten.
  const all = [];
  let n = 0;
  for (let day = 0; day < 30; day++) {
    const start = Date.parse("2026-01-01T09:00:00Z") + day * 86_400_000;
    for (let minute = 0; minute < 480; minute++) {
      const iso = new Date(start + minute * 60_000).toISOString();
      env.data.set(
        `wb:${b.id}:log:${iso}:${owner.uuid}:${(n++).toString(16).padStart(64, "0")}`,
        { at: Date.parse(iso), author: owner.uuid, update: "" },
      );
      all.push({ at: Date.parse(iso), author: owner.uuid, username: "Alice" });
    }
  }
  const keys = [...env.data.keys()].sort();
  let read = 0;
  env.service.kv.list = async ({
    pattern,
    cursor,
    limit,
    reverse,
    returnValues,
  }) => {
    let found = keys.filter((k) => k.startsWith(pattern.replace(/\*$/, "")));
    if (reverse) found = found.reverse();
    const at = Number(cursor || 0),
      end = at + limit;
    const items = found
      .slice(at, end)
      .map((key) =>
        returnValues ? { key, value: structuredClone(env.data.get(key)) } : key,
      );
    if (pattern.includes(":log:")) read += items.length;
    return { items, cursor: end < found.length ? String(end) : undefined };
  };
  const expected = [
    ...historyVersions(all, undefined, Infinity),
    {
      start: env.now,
      until: env.now,
      edits: 0,
      authors: ["Alice"],
      at: env.now,
      original: true,
    },
  ];
  const shown = [];
  let before,
    first = 0;
  for (let page = 0; page < 10; page++) {
    read = 0;
    const r = await env.service.call(owner, {
      op: "history.list",
      room: b.id,
      ...(before ? { before } : {}),
    });
    if (!page) first = read;
    shown.push(...r.versions);
    before = r.versions.at(-1)?.at;
    if (!r.more) break;
  }
  assert.deepEqual(shown, expected, "every version, as before");
  assert.ok(first < all.length / 2, `the first page read ${first} keys`);
});

test("each page of a history with no pauses reads about what it shows", async () => {
  const env = environment();
  env.now = Date.parse("2025-12-31T00:00:00Z");
  const b = board("Busy");
  b.items = [item("note", 0, 0)];
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  // A save every two minutes for four weeks, never pausing for five.
  const all = [];
  let t = Date.parse("2026-01-01T00:00:00Z");
  const add = (n) => {
    const iso = new Date(t).toISOString();
    env.data.set(
      `wb:${b.id}:log:${iso}:${owner.uuid}:${n.toString(16).padStart(64, "0")}`,
      { at: t, author: owner.uuid, update: "" },
    );
    all.push({ at: t, author: owner.uuid, username: "Alice" });
    t += 120_000;
  };
  for (let n = 0; n < 20_000; n++) add(n);
  // Puter's listing position, here an offset from the newest key, which
  // records added or removed since move.
  let keys;
  const sorted = () => (keys = [...env.data.keys()].sort());
  sorted();
  let lists = 0;
  env.service.kv.list = async ({
    pattern,
    cursor,
    limit,
    reverse,
    returnValues,
  }) => {
    const p = pattern.replace(/\*$/, "");
    if (p.includes(":log:")) lists++;
    let found = keys.filter((k) => k.startsWith(p));
    if (reverse) found = found.reverse();
    const at = Number(cursor || 0),
      end = at + limit;
    return {
      items: found
        .slice(at, end)
        .map((key) =>
          returnValues
            ? { key, value: structuredClone(env.data.get(key)) }
            : key,
        ),
      cursor: end < found.length ? String(end) : undefined,
    };
  };
  const original = {
    start: env.now,
    until: env.now,
    edits: 0,
    authors: ["Alice"],
    at: env.now,
    original: true,
  };
  const pages = async (expected, changes = () => {}) => {
    const shown = [],
      read = [];
    let before, next;
    for (let page = 0; page < 20; page++) {
      lists = 0;
      const r = await env.service.call(owner, {
        op: "history.list",
        room: b.id,
        ...(before ? { before, cursor: next } : {}),
      });
      read.push(lists);
      shown.push(...r.versions);
      before = r.versions.at(-1)?.at;
      next = r.next;
      if (!r.more) break;
      changes(page);
    }
    assert.deepEqual(shown, expected, "every version once, in order");
    return read;
  };
  const expected = [...historyVersions(all, undefined, Infinity), original];
  // Versions end with each quarter of an hour, so a page stops reading at
  // the version after the 300 it shows, and the next starts where it
  // ended: 300 versions of seven or eight saves are about 12 requests.
  const read = await pages(expected);
  assert.ok(read.length >= 9, `${read.length} pages`);
  assert.ok(
    read.every((n) => n <= 13),
    `requests per page: ${read}`,
  );
  // Saves arriving between pages move the position on; nothing is shown
  // twice.
  let now = [...historyVersions(all, undefined, Infinity), original];
  await pages(now, (page) => {
    if (page) return;
    for (let n = 0; n < 3; n++) add(20_000 + n);
    sorted();
  });
  // Records going, as when a board's newest edits are removed, move it
  // back past older records; it is then not used, and that page is read
  // from the newest edit rather than passing them over.
  now = [...historyVersions(all, undefined, Infinity), original];
  const reread = await pages(now, (page) => {
    if (page) return;
    for (const key of keys.filter((k) => k.includes(":log:")).slice(-400))
      env.data.delete(key);
    sorted();
  });
  assert.ok(reread[1] > read[1], `requests per page: ${reread}`);
});

test("restoring a board breaks a mind map loop on a restored object, not a kept one", async () => {
  const { restoreBoard } = await import("../src/history/restore.js");
  const mind = (id, parent) =>
    item("note", 0, 0, {
      id,
      text: id,
      mindMap: { parent, direction: "right", auto: true, line: "curved" },
    });
  const version = {
    ...board("Version"),
    items: [mind("root", null), mind("a", "z"), mind("z", "root")],
  };
  const current = {
    ...version,
    items: [mind("root", null), mind("z", "a"), mind("a", "root")],
  };
  // z is hidden from the person restoring, so it stays as it is now.
  const restored = restoreBoard(current, version, new Set(["z"]));
  validateBoard(restored);
  const node = (id) => restored.items.find((i) => i.id === id);
  assert.equal(node("z").mindMap.parent, "a");
  assert.equal(node("a").mindMap.parent, null);
});

test("restoring objects counts the objects it repairs, so their locks apply", async () => {
  const { objectRestoreIds } = await import("../src/history/restore.js");
  const node = (parent) => ({
    parent,
    direction: "right",
    auto: true,
    line: "curved",
  });
  const current = {
    ...board("Now"),
    items: [
      item("note", 0, 0, { id: "x", text: "Root", mindMap: node(null) }),
      item("note", 0, 0, {
        id: "y",
        text: "Locked child",
        locked: true,
        mindMap: node("x"),
      }),
      item("note", 300, 0, { id: "z", text: "Unrelated" }),
    ],
  };
  // Then, x was a plain note, so restoring it detaches y from it.
  const version = {
    ...board("Then"),
    items: [
      item("note", 0, 0, { id: "x", text: "Root" }),
      item("note", 0, 0, { id: "y", text: "Locked child" }),
    ],
  };
  assert.deepEqual(
    [...objectRestoreIds(current, version, new Set(["x"]))].sort(),
    ["x", "y"],
  );
});

test("version history names no one to participants on a board that takes anonymous input", async () => {
  const env = environment(),
    boards = env.service;
  const b = board("Retro"),
    doc = new SharedDocument();
  b.items = [item("note", 0, 0, { text: "Prompt" })];
  doc.commit(b);
  await boards.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  doc.destroy();
  for (const [user, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ]) {
    const { token } = await boards.call(owner, {
      op: "invite",
      room: b.id,
      role,
    });
    await boards.call(user, { op: "join", room: b.id, token });
  }
  let clock = env.now + 60_000;
  boards.now = () => clock;
  const authors = async (user) =>
    (await boards.call(user, { op: "history.list", room: b.id })).versions
      .flatMap((v) => v.authors)
      .sort();
  await commit(boards, editor, b.id, (s) =>
    s.items.push(item("note", 300, 0, { text: "Named idea" })),
  );
  // Alice created the board.
  assert.deepEqual(await authors(viewer), ["Alice", "Bob"]);
  clock += 10 * 60_000;
  await commit(boards, owner, b.id, (s) => {
    s.workshop = { settings: { anonymous: true } };
  });
  clock += 10 * 60_000;
  await commit(boards, editor, b.id, (s) =>
    s.items.push(item("note", 600, 0, { text: "Our manager micromanages" })),
  );
  // Participants see no names, for this edit or any other.
  for (const user of [viewer, editor])
    assert.deepEqual(await authors(user), [
      "Participant",
      "Participant",
      "Participant",
      "Participant",
    ]);
  // The owner, who runs the workshop, still does.
  assert.deepEqual(await authors(owner), ["Alice", "Alice", "Bob", "Bob"]);
});

test("a version's changes since are the objects deleted, changed and added since", async () => {
  const { versionChanges } = await import("../src/history/preview.js");
  const a = item("note", 0, 0, { text: "Kept" }),
    b = item("note", 200, 0, { text: "Changed" }),
    c = item("note", 400, 0, { text: "Deleted" }),
    d = item("note", 600, 0, { text: "Added" });
  const changes = versionChanges(
    [{ ...a }, { ...b, text: "Changed since" }, d],
    [a, b, c],
  );
  assert.deepEqual([...changes.removed], [c.id]);
  assert.deepEqual([...changes.changed], [b.id]);
  assert.equal(changes.added, 1);
});
