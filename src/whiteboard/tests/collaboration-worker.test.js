import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "vite";
import { createCanvas } from "@napi-rs/canvas";
import { SharedDocument } from "../src/collaboration/document.js";
import { encode, decode, hash } from "../src/collaboration/protocol.js";
import { call, deploy } from "../src/collaboration/api.js";
import { board, item } from "../src/model.js";
import * as Y from "yjs";
import { adminCall } from "../worker/admin.js";
import { KEEP, OrgService } from "../worker/org.js";
import { environment, owner, editor, viewer } from "./collaboration-helpers.js";

const guest = {
  uuid: "44444444-4444-4444-8444-444444444444",
  username: "Dee",
};

test("the shipped worker bundle deploys and exposes authenticated JSON routes", async (t) => {
  const bundle = await build({
    configFile: "vite.worker.config.js",
    logLevel: "silent",
    build: { write: false },
  });
  const code = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(
    (file) => file.type === "chunk" && file.isEntry,
  ).code;
  const routes = new Map(),
    env = environment(),
    puter = env.sdk(owner);
  vm.runInNewContext(code, {
    router: {
      get: (path, handler) => routes.set("GET " + path, handler),
      post: (path, handler) => routes.set("POST " + path, handler),
      custom: (method, path, handler) =>
        routes.set(method + " " + path, handler),
    },
    me: { puter },
    Response,
    Blob,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    crypto,
    btoa,
    atob,
    structuredClone,
    setTimeout,
    clearTimeout,
    fetch,
    AbortSignal,
    console,
  });
  const health = await routes.get("GET /health")();
  assert.equal(health.status, 200);
  const metadata = await health.json();
  assert.equal(metadata.protocol, 1);
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(url, "/worker/whiteboard-worker.js");
    return new Response(code);
  });
  let deployments = 0;
  puter.workers.create = async (name, path) => {
    deployments++;
    assert.equal(env.files.get(path), code);
    return { url: `https://${name}.puter.work` };
  };
  puter.workers.exec = async (url, options) => {
    assert.ok(url.endsWith("/health"));
    assert.equal(options.headers["x-puter-no-auth"], "1");
    assert.equal(options.headers["puter-auth"], undefined);
    return routes.get("GET /health")();
  };
  const server = await deploy(puter);
  const config = await puter.kv.get("whiteboard-collaboration-worker-v1");
  assert.equal(config.server, server);
  assert.equal(config.build, metadata.build);
  assert.equal(config.builtAt, metadata.builtAt);
  assert.equal(await deploy(puter), server);
  assert.equal(deployments, 1, "Reuse the same deployed build");
  const post = (body, user, headers = {}) =>
    routes.get("POST /api")({
      request: new Request("https://worker.puter.work/api", {
        method: "POST",
        headers: {
          ...(user ? { "puter-auth": env.sdk(user).authToken } : {}),
          ...headers,
        },
        body,
      }),
      user: user ? { puter: env.sdk(user) } : null,
    });
  assert.equal((await post("{}", null)).status, 401);
  assert.equal((await post("not JSON", owner)).status, 400);
  puter.workers.exec = async (url, options) =>
    routes.get("POST /api")({
      request: new Request(url, options),
      user: { puter: env.requestor(options.headers["puter-auth"]) },
    });
  const initial = board("Bundled worker");
  initial.items = [item("note", 10, 10, { text: "Actual bundled code" })];
  const doc = new SharedDocument();
  doc.commit(initial);
  const created = await call(puter, "https://worker.puter.work", {
    op: "create",
    room: initial.id,
    update: encode(doc.update()),
  });
  assert.equal(created.room, initial.id);
  const token = [...env.credentials.keys()][0];
  assert.equal(
    (
      await post(JSON.stringify({ op: "sync", room: initial.id }), owner, {
        "puter-auth": token,
      })
    ).status,
    401,
    "A restricted token cannot bypass proof verification on the bundled route",
  );
  assert.equal(
    (await post(JSON.stringify({ op: "sync", room: initial.id }), editor))
      .status,
    403,
  );
  const sync = await post(
    JSON.stringify({ op: "sync", room: initial.id }),
    owner,
  );
  assert.equal(sync.status, 200);
  assert.ok((await sync.json()).update);
  assert.equal(
    (
      await post(
        JSON.stringify({ op: "org.setup", name: "AI validation" }),
        owner,
      )
    ).status,
    200,
  );
  let aiCalls = 0;
  puter.ai = {
    chat: async () => {
      aiCalls++;
      return { message: { content: "Controlled description." } };
    },
  };
  const png = createCanvas(4, 4).toDataURL();
  for (const task of ["describe", "handwriting"]) {
    for (const data of ["AA=", "AAAA=", "A", "===="]) {
      const beforeCalls = aiCalls;
      const response = await post(
        JSON.stringify({
          op: "org.ai",
          task,
          prompt: "Describe the visible content.",
          image: "data:image/png;base64," + data,
        }),
        owner,
      );
      assert.equal(
        response.status,
        400,
        "Malformed image encoding is a client error, not a retryable synchronization failure.",
      );
      assert.equal(
        (await response.json()).message,
        "Choose a PNG, JPEG, or WebP photo.",
      );
      assert.equal(aiCalls, beforeCalls);
      assert.ok(
        ![...env.files.keys()].some((path) =>
          path.startsWith("whiteboard/ai/"),
        ),
      );
    }
    for (const image of [png, png.replace(/=+$/, "")]) {
      const beforeCalls = aiCalls;
      const response = await post(
        JSON.stringify({
          op: "org.ai",
          task,
          prompt: "Describe the visible content.",
          image,
        }),
        owner,
      );
      assert.equal(
        response.status,
        200,
        "Valid padded and unpadded PNG encodings remain supported.",
      );
      assert.equal((await response.json()).text, "Controlled description.");
      assert.equal(aiCalls, beforeCalls + 1);
      assert.ok(
        ![...env.files.keys()].some((path) =>
          path.startsWith("whiteboard/ai/"),
        ),
      );
    }
  }
  doc.destroy();
});

test("content placed where the document never reads it is refused", async () => {
  const env = environment();
  const b = board("Hidden");
  b.items = [item("note", 0, 0, { text: "Hello" })];
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const { token } = await env.service.call(owner, {
    op: "invite",
    room: b.id,
    role: "commenter",
  });
  await env.service.call(editor, { op: "join", room: b.id, token });
  const noteId = b.items[0].id;
  const big = "x".repeat(50_000);
  const attempt = async (user, mutate) => {
    const { update: state } = await env.service.call(user, {
      op: "sync",
      room: b.id,
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, decode(state));
    const vector = Y.encodeStateVector(doc);
    mutate(doc);
    const update = Y.encodeStateAsUpdate(doc, vector);
    doc.destroy();
    return env.service.call(user, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
      vector: encode(vector),
    });
  };
  // A list item integrated into a root map, by a commenter.
  const sequenceUnder = (root) => (doc) => {
    doc.getMap(root);
    const type = doc.share.get(root);
    doc.transact(() => {
      new Y.Item(
        Y.createID(doc.clientID, Y.getState(doc.store, doc.clientID)),
        null,
        null,
        null,
        null,
        type,
        null,
        new Y.ContentString(big),
      ).integrate(doc._transaction, 0);
    });
  };
  for (const root of ["comments", "workshop"])
    await assert.rejects(attempt(editor, sequenceUnder(root)), {
      status: 422,
      message: "Invalid shared document structure.",
    });
  // The same under an object's map and a note's text, by an editor.
  await assert.rejects(
    attempt(owner, (doc) => {
      const type = doc.getMap("items").get(noteId);
      doc.transact(() => {
        new Y.Item(
          Y.createID(doc.clientID, Y.getState(doc.store, doc.clientID)),
          null,
          null,
          null,
          null,
          type,
          null,
          new Y.ContentString(big),
        ).integrate(doc._transaction, 0);
      });
    }),
    { status: 422, message: "Invalid shared document structure." },
  );
  await assert.rejects(
    attempt(owner, (doc) => {
      const text = doc.getMap("items").get(noteId).get("text");
      doc.transact(() => {
        new Y.Item(
          Y.createID(doc.clientID, Y.getState(doc.store, doc.clientID)),
          null,
          null,
          null,
          null,
          text,
          "hidden",
          new Y.ContentAny([big]),
        ).integrate(doc._transaction, 0);
      });
    }),
    { status: 422, message: "Invalid shared document structure." },
  );
  // Content hidden inside an object the same change adds.
  await assert.rejects(
    attempt(owner, (doc) => {
      doc.transact(() => {
        const entry = new Y.Map();
        doc.getMap("items").set("hidden-inside-new", entry);
        entry.set("text", new Y.Text());
        entry.set("z", 1);
        entry.set("geometry", { type: "note", x: 0, y: 0, w: 10, h: 10 });
        new Y.Item(
          Y.createID(doc.clientID, Y.getState(doc.store, doc.clientID)),
          null,
          null,
          null,
          null,
          entry,
          null,
          new Y.ContentString(big),
        ).integrate(doc._transaction, 0);
      });
    }),
    { status: 422, message: "Invalid shared document structure." },
  );
  // The board is as it was, and an ordinary edit still saves.
  const { update: after } = await env.service.call(owner, {
    op: "sync",
    room: b.id,
  });
  assert.ok(after.length < 20_000);
  await attempt(owner, (doc) => {
    doc.getMap("items").get(noteId).get("text").insert(5, "!");
  });
  const { doc } = await env.service.load(b.id);
  assert.equal(doc.snapshot().items[0].text, "Hello!");
  doc.destroy();
});

test("a checkpoint is stamped no earlier than the newest edit it holds", async () => {
  const env = environment();
  const T0 = env.now;
  const b = board("Checkpoint time");
  b.items = [item("note", 0, 0, { text: "v0" })];
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const service = env.service;
  const commit = async (text) => {
    const { update: state } = await service.call(owner, {
      op: "sync",
      room: b.id,
    });
    const doc = new SharedDocument(decode(state));
    const vector = doc.vector(),
      next = doc.snapshot();
    next.items[0].text = text;
    doc.commit(next);
    const update = doc.update(vector);
    doc.destroy();
    return service.call(owner, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
      vector: encode(vector),
    });
  };
  await commit("v1");
  // Ten seconds later a synchronization told of a save lists the log; while
  // it lists, another edit is saved through this instance.
  env.now = T0 + 10_000;
  let release,
    gated = false;
  const gate = new Promise((r) => (release = r));
  const list = service.kv.list;
  service.kv.list = async (options) => {
    if (!gated && options.pattern.startsWith(`wb:${b.id}:log:`)) {
      gated = true;
      await gate;
    }
    return list(options);
  };
  const refresh = service.call(owner, {
    op: "sync",
    room: b.id,
    noticed: true,
    ids: ["not-yet-seen"],
  });
  while (!gated) await new Promise((r) => setTimeout(r, 5));
  env.now = T0 + 20_000;
  await commit("v2");
  release();
  await refresh;
  await new Promise((r) => setTimeout(r, 50));
  service.kv.list = list;
  const checkpoint = await service.kv.get(`wb:${b.id}:cp`);
  assert.ok(checkpoint, "A checkpoint was written");
  assert.ok(
    checkpoint.at >= T0 + 20_000,
    `The checkpoint holding v2 is stamped at or after its save (${checkpoint.at - T0})`,
  );
  // The version as of fifteen seconds in reads v1: v2 was saved at twenty.
  env.now = T0 + 60_000;
  const { update } = await service.call(owner, {
    op: "history.state",
    room: b.id,
    at: T0 + 15_000,
  });
  const version = new SharedDocument(decode(update));
  assert.equal(version.snapshot().items[0].text, "v1");
  version.destroy();
  const { update: latest } = await service.call(owner, {
    op: "history.state",
    room: b.id,
    at: T0 + 30_000,
  });
  const current = new SharedDocument(decode(latest));
  assert.equal(current.snapshot().items[0].text, "v2");
  current.destroy();
});

test("a commit naming many new clients is refused before it writes a record for each", async () => {
  const env = environment();
  const b = board("Amplify");
  b.items = [item("note", 0, 0, { text: "" })];
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const noteId = b.items[0].id;
  const { update: state } = await env.service.call(owner, {
    op: "sync",
    room: b.id,
  });
  const base = decode(state);
  // One character each from N fabricated client IDs, merged into one update.
  const typed = (count, first) => {
    const updates = [];
    for (let k = 0; k < count; k++) {
      const d = new Y.Doc();
      d.clientID = first + k;
      Y.applyUpdate(d, base);
      const vector = Y.encodeStateVector(d);
      d.getMap("items").get(noteId).get("text").insert(0, "x");
      updates.push(Y.encodeStateAsUpdate(d, vector));
      d.destroy();
    }
    return Y.mergeUpdates(updates);
  };
  const commit = async (update) =>
    env.service.call(owner, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
      vector: encode(Y.encodeStateVector(new Y.Doc())),
    });
  let clientSets = 0;
  const set = env.service.kv.set;
  env.service.kv.set = async (key, ...rest) => {
    if (/:client:/.test(key)) clientSets++;
    return set(key, ...rest);
  };
  await assert.rejects(commit(typed(300, 1_000_000)), {
    status: 422,
    message: "This change spans too many editing sessions.",
  });
  assert.equal(clientSets, 0, "No client record was written");
  assert.equal(
    [...env.data.keys()].filter((k) => /:client:/.test(k)).length,
    0,
  );
  // A commit from a few clients, as after reloads, still saves.
  await commit(typed(3, 2_000_000));
  env.service.kv.set = set;
  const { doc } = await env.service.load(b.id);
  assert.equal(doc.snapshot().items[0].text, "xxx");
  doc.destroy();
});

test("a malformed update is refused as the client's mistake, not as a failure to retry", async () => {
  assert.throws(() => decode("a"), {
    message: "Invalid collaboration update.",
  });
  assert.throws(() => decode("abcde"), {
    message: "Invalid collaboration update.",
  });
  const env = environment();
  const b = board("Malformed");
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  for (const update of ["a", "not base64!", "QUJD="])
    await assert.rejects(
      env.service.call(owner, {
        op: "commit",
        room: b.id,
        id: "x",
        update,
        vector: encode(new Uint8Array([0])),
      }),
      { status: 400, message: "Invalid collaboration update." },
    );
});

test("an edit whose file is written slowly still reaches other instances and checkpoints", async () => {
  const env = environment();
  const A = env.service;
  // Other worker instances keep their own cached states.
  const { BoardService: B2 } = await import("../worker/service.js?instance=b");
  const { BoardService: C2 } = await import("../worker/service.js?instance=c");
  const B = new B2(A.puter, { now: () => env.now, org: A.org });
  const C = new C2(A.puter, { now: () => env.now, org: A.org });
  const b = board("T");
  b.items = [item("note", 0, 0, { text: "Hi" })];
  const seed = new SharedDocument();
  seed.commit(b);
  await A.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  (await B.load(b.id)).doc.destroy();
  env.now += 2000;
  // A large edit is stored as a file, and the write takes 22 seconds while
  // instance B keeps refreshing.
  const { doc } = await A.load(b.id);
  const vector = doc.vector(),
    next = doc.snapshot();
  for (let n = 0; n < 16; n++)
    next.items.push(item("note", n * 10, 300, { text: "x".repeat(19000) }));
  doc.commit(next);
  const update = doc.update(vector);
  doc.destroy();
  const write = A.writeFile.bind(A);
  A.writeFile = async (path, value) => {
    for (let t = 0; t < 14; t++) {
      env.now += 1600;
      (await B.load(b.id)).doc.destroy();
    }
    return write(path, value);
  };
  await A.call(owner, {
    op: "commit",
    room: b.id,
    id: await hash(update),
    update: encode(update),
  });
  A.writeFile = write;
  env.now += 1600;
  const seen = (await B.load(b.id)).doc;
  assert.equal(
    seen.snapshot().items.length,
    17,
    "The other instance applies it",
  );
  seen.destroy();
  // Later edits and checkpoints keep it for a fresh instance.
  env.now += 3 * 60_000;
  const { doc: later } = await A.load(b.id);
  const v2 = later.vector(),
    s2 = later.snapshot();
  s2.items[0].text = "later";
  later.commit(s2);
  const u2 = later.update(v2);
  later.destroy();
  await A.call(owner, {
    op: "commit",
    room: b.id,
    id: await hash(u2),
    update: encode(u2),
  });
  env.now += 1600;
  (await B.load(b.id)).doc.destroy();
  env.now += 5 * 60_000;
  const fresh = (await C.load(b.id)).doc;
  assert.equal(fresh.snapshot().items.length, 17);
  fresh.destroy();
});

test("an edit building on one saved through another instance is accepted at once", async () => {
  const env = environment();
  const A = env.service;
  const { BoardService: Other } =
    await import("../worker/service.js?instance=behind");
  const B = new Other(A.puter, { now: () => env.now, org: A.org });
  const b = board("Behind");
  b.items = [item("note", 0, 0, { text: "Hi" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await A.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  // B's cached board predates the first edit and stays fresh, as no time
  // passes.
  await B.call(owner, { op: "sync", room: b.id });
  const encodeEdit = async (state, change) => {
    const vector = state.vector(),
      next = state.snapshot();
    change(next);
    state.commit(next);
    const update = state.update(vector);
    return {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    };
  };
  const added = item("note", 200, 0, { text: "New" });
  await A.call(owner, await encodeEdit(doc, (next) => next.items.push(added)));
  await B.call(
    owner,
    await encodeEdit(doc, (next) => (next.items[1].text = "Edited")),
  );
  const texts = async () => {
    const { update } = await B.call(owner, { op: "sync", room: b.id });
    const state = new SharedDocument(decode(update));
    try {
      return state.snapshot().items.map((i) => i.text);
    } finally {
      state.destroy();
    }
  };
  assert.deepEqual(await texts(), ["Hi", "Edited"]);
  // Later commits through B start from the reloaded board.
  await B.call(
    owner,
    await encodeEdit(doc, (next) => (next.items[0].text = "Again")),
  );
  assert.deepEqual(await texts(), ["Again", "Edited"]);
  // An edit building on one never saved anywhere is still refused, and
  // nothing of it is synchronized.
  const unsaved = new SharedDocument(doc.update());
  await encodeEdit(unsaved, (next) =>
    next.items.push(item("note", 400, 0, { text: "Unsaved" })),
  );
  const dependent = await encodeEdit(
    unsaved,
    (next) => (next.items[2].text = "Depends"),
  );
  for (const service of [B, A])
    await assert.rejects(service.call(owner, dependent), { status: 409 });
  assert.deepEqual(await texts(), ["Again", "Edited"]);
  unsaved.destroy();
  doc.destroy();
});

test("a synchronization after a change saved through another instance reads it, even within a fresh copy", async () => {
  const env = environment();
  const A = env.service;
  const { BoardService: Other } =
    await import("../worker/service.js?instance=told");
  const B = new Other(A.puter, { now: () => env.now, org: A.org });
  const b = board("Told");
  b.items = [item("note", 0, 0, { text: "Hi" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await A.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  // A participant on A has the board, and A's copy of it is fresh.
  const { update: initial } = await A.call(owner, { op: "sync", room: b.id });
  const seen = new SharedDocument(decode(initial));
  env.now += 1000;
  const vector = doc.vector(),
    next = doc.snapshot();
  next.items.push(item("pen", 40, 40, { points: [[0, 0]], w: 0, h: 0 }));
  doc.commit(next);
  const update = doc.update(vector);
  const saved = await B.call(owner, {
    op: "commit",
    room: b.id,
    id: await hash(update),
    update: encode(update),
  });
  const types = async (input) => {
    const { update } = await A.call(owner, {
      op: "sync",
      room: b.id,
      vector: encode(seen.vector()),
      ...input,
    });
    seen.apply(decode(update));
    return seen.snapshot().items.map((i) => i.type);
  };
  // An ordinary poll may still be answered from A's copy for a moment.
  assert.deepEqual(await types({}), ["note"]);
  // Told of the save, by a board event or a peer, it is read at once.
  assert.deepEqual(await types({ after: saved.serverTime }), ["note", "pen"]);
  // Others told of the same save share that read.
  const list = A.puter.kv.list;
  let lists = 0;
  A.puter.kv.list = (...args) => (lists++, list.apply(A.puter.kv, args));
  try {
    await A.call(owner, {
      op: "sync",
      room: b.id,
      vector: encode(seen.vector()),
      after: saved.serverTime,
    });
  } finally {
    A.puter.kv.list = list;
  }
  assert.equal(lists, 0);
  seen.destroy();
  doc.destroy();
});

test("a synchronization naming a save made through another instance reads it whatever the instances' clocks say, and names what a lagging listing still lacks", async () => {
  const env = environment();
  const A = env.service;
  const { BoardService: Other } =
    await import("../worker/service.js?instance=named");
  // B's clock runs two seconds behind A's.
  const B = new Other(A.puter, { now: () => env.now - 2000, org: A.org });
  const b = board("Named");
  b.items = [item("note", 0, 0, { text: "Hi" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await A.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  // A participant on A has the board, and A's copy of it is fresh.
  const { update: initial } = await A.call(owner, { op: "sync", room: b.id });
  const seen = new SharedDocument(decode(initial));
  env.now += 500;
  const commit = async (type) => {
    const vector = doc.vector(),
      next = doc.snapshot();
    next.items.push(item(type, 40, 40, { points: [[0, 0]], w: 0, h: 0 }));
    doc.commit(next);
    const update = doc.update(vector),
      id = await hash(update);
    const saved = await B.call(owner, {
      op: "commit",
      room: b.id,
      id,
      update: encode(update),
    });
    return { id, at: saved.serverTime };
  };
  const list = A.puter.kv.list;
  let lists = 0,
    hidden = null;
  A.puter.kv.list = async (...args) => {
    lists++;
    const page = await list.apply(A.puter.kv, args);
    page.items = page.items.filter(
      (i) => !hidden || !(typeof i === "string" ? i : i.key).endsWith(hidden),
    );
    return page;
  };
  const sync = async (input) => {
    const result = await A.call(owner, {
      op: "sync",
      room: b.id,
      vector: encode(seen.vector()),
      ...input,
    });
    seen.apply(decode(result.update));
    return {
      types: seen.snapshot().items.map((i) => i.type),
      missing: result.missing,
    };
  };
  try {
    const pen = await commit("pen");
    // By B's clock the save predates A's copy, so its time alone leaves the
    // copy answering without it.
    assert.ok(pen.at < env.now - 500);
    assert.deepEqual(await sync({ after: pen.at }), {
      types: ["note"],
      missing: undefined,
    });
    // Named, it is read whatever the clocks say.
    assert.deepEqual(await sync({ ids: [pen.id] }), {
      types: ["note", "pen"],
      missing: [],
    });
    // Everyone else told of it is answered from the copy.
    const listed = lists;
    assert.deepEqual(await sync({ ids: [pen.id] }), {
      types: ["note", "pen"],
      missing: [],
    });
    assert.equal(lists, listed);
    // A record a listing does not show yet is named back, and read once it
    // does.
    const arrow = await commit("arrow");
    hidden = arrow.id;
    assert.deepEqual(await sync({ ids: [arrow.id] }), {
      types: ["note", "pen"],
      missing: [arrow.id],
    });
    hidden = null;
    assert.deepEqual(await sync({ ids: [arrow.id] }), {
      types: ["note", "pen", "arrow"],
      missing: [],
    });
    // Told of an unnamed save, callers share a listing begun after they
    // asked: three asking at once cost at most two.
    let listings = 0;
    const logSince = A.logSince;
    A.logSince = function (...args) {
      listings++;
      return logSince.apply(this, args);
    };
    try {
      await Promise.all([1, 2, 3].map(() => sync({ noticed: true })));
    } finally {
      A.logSince = logSince;
    }
    assert.ok(listings >= 1 && listings <= 2, `${listings} listings`);
  } finally {
    A.puter.kv.list = list;
    seen.destroy();
    doc.destroy();
  }
});

test("an instance answers from its copy while the board's signal is unchanged, only once a listing begun after the signal settled holds every save", async () => {
  const env = environment();
  const A = env.service;
  const { BoardService: Other } =
    await import("../worker/service.js?instance=settled");
  // B's clock runs two seconds behind A's.
  const B = new Other(A.puter, { now: () => env.now - 2000, org: A.org });
  // Listings show a write only 600 ms after it.
  const kv = A.puter.kv,
    shown = new Map(),
    set = kv.set,
    list = kv.list;
  let lost = false;
  kv.set = async (key, ...args) => {
    if (lost && key.endsWith(":ev:signal")) {
      lost = false;
      throw Error("Too many requests.");
    }
    if (!shown.has(key)) shown.set(key, env.now + 600);
    return set.call(kv, key, ...args);
  };
  kv.list = async (options) => {
    const page = await list.call(kv, options);
    page.items = page.items.filter(
      (i) => (shown.get(typeof i === "string" ? i : i.key) ?? 0) <= env.now,
    );
    return page;
  };
  const b = board("Settled");
  b.items = [item("note", 0, 0, { text: "Hi" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await A.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  const seen = new SharedDocument();
  let listings = 0;
  const logSince = A.logSince;
  A.logSince = function (...args) {
    listings++;
    return logSince.apply(this, args);
  };
  const types = async (input = {}) => {
    env.now += 1600;
    const before = listings;
    const result = await A.call(owner, {
      op: "sync",
      room: b.id,
      vector: encode(seen.vector()),
      ...input,
    });
    seen.apply(decode(result.update));
    return {
      types: seen.snapshot().items.map((i) => i.type),
      listed: listings > before,
      ...(result.missing ? { missing: result.missing } : {}),
    };
  };
  const save = async (type) => {
    const vector = doc.vector(),
      next = doc.snapshot();
    next.items.push(item(type, 40, 40, { points: [[0, 0]], w: 0, h: 0 }));
    doc.commit(next);
    const update = doc.update(vector),
      id = await hash(update);
    await B.call(owner, {
      op: "commit",
      room: b.id,
      id,
      update: encode(update),
    });
    return id;
  };
  try {
    await types();
    await types();
    assert.deepEqual(await types(), { types: ["note"], listed: false });
    // Saved through B just before A's next check, whose listing does not
    // show it yet. The listing after that does, though the signal has not
    // changed since.
    env.now += 1400;
    await save("pen");
    env.now -= 1400;
    assert.deepEqual(await types(), { types: ["note"], listed: true });
    assert.deepEqual(await types(), { types: ["note", "pen"], listed: true });
    assert.deepEqual(await types(), { types: ["note", "pen"], listed: false });
    // A save whose signal is lost is read as soon as someone names it,
    // whatever the signal shows, and otherwise within a minute.
    lost = true;
    const arrow = await save("arrow");
    assert.deepEqual(await types(), { types: ["note", "pen"], listed: false });
    assert.deepEqual(await types({ ids: [arrow] }), {
      types: ["note", "pen", "arrow"],
      listed: true,
      missing: [],
    });
    lost = true;
    await save("pen");
    assert.deepEqual(await types(), {
      types: ["note", "pen", "arrow"],
      listed: false,
    });
    env.now += 60_000;
    assert.deepEqual(await types(), {
      types: ["note", "pen", "arrow", "pen"],
      listed: true,
    });
  } finally {
    kv.set = set;
    kv.list = list;
    A.logSince = logSince;
    seen.destroy();
    doc.destroy();
  }
});

test("an instance runs two listings at once and queues the rest", async () => {
  const env = environment();
  const { BoardService } = await import("../worker/service.js?instance=turns");
  const service = new BoardService(env.service.puter, {
    now: () => env.now,
    org: env.service.org,
  });
  const kv = env.service.puter.kv,
    list = kv.list,
    waiting = [];
  let running = 0,
    most = 0;
  kv.list = async (options) => {
    most = Math.max(most, ++running);
    await new Promise((resolve) => waiting.push(resolve));
    running--;
    return list.call(kv, options);
  };
  try {
    let finished = false;
    const all = Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((room) => service.members(room)),
    ).finally(() => {
      finished = true;
    });
    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      waiting.shift()?.();
    }
    assert.equal((await all).length, 6);
    assert.equal(most, 2);
  } finally {
    kv.list = list;
  }
});

// Two instances of a board's worker, the first with a copy of the board, and
// a save made through the second that the first has not listed.
async function unlisted(name) {
  const env = environment();
  const instance = async (label) =>
    new (
      await import(`../worker/service.js?instance=${name}-${label}`)
    ).BoardService(env.service.puter, {
      now: () => env.now,
      org: env.service.org,
    });
  const A = await instance("a"),
    B = await instance("b");
  const b = board("Refused");
  b.items = [item("note", 0, 0, { text: "Hi" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await A.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  await A.call(owner, { op: "sync", room: b.id });
  env.now += 2000;
  const edit = async (change) => {
    const vector = doc.vector(),
      next = doc.snapshot();
    change(next);
    doc.commit(next);
    const update = doc.update(vector);
    return {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    };
  };
  const saved = await edit((next) =>
    next.items.push(item("pen", 40, 40, { points: [[0, 0]], w: 0, h: 0 })),
  );
  await B.call(owner, saved);
  const sync = (input = {}) =>
    A.call(owner, { op: "sync", room: b.id, ...input });
  const kv = env.service.puter.kv,
    list = kv.list;
  const lists = { count: 0 };
  return { env, A, b, doc, edit, saved, sync, kv, list, lists };
}

test("when Puter refuses listings, synchronizations answer from the cached copy, naming what it lacks, and commits building on it are retried", async () => {
  const { env, A, doc, edit, saved, sync, kv, list, lists } =
    await unlisted("refused");
  let refuse = true;
  kv.list = async (options) => {
    lists.count++;
    if (refuse)
      throw {
        error: "Too many requests.",
        message: "Too many requests.",
        code: "too_many_requests",
      };
    return list.call(kv, options);
  };
  try {
    const ids = [saved.id];
    assert.deepEqual((await sync({ ids })).missing, ids);
    assert.equal(lists.count, 1);
    // Others are answered from the copy without asking Puter again.
    env.now += 1000;
    assert.deepEqual((await sync({ ids })).missing, ids);
    assert.equal((await sync({ noticed: true })).role, "owner");
    assert.equal(lists.count, 1);
    // A save building on the one the copy lacks is to be sent again.
    const next = await edit((board) => (board.items[1].color = "#ff0000"));
    await assert.rejects(A.call(owner, next), { status: 409 });
    assert.equal(lists.count, 1);
    // Ten seconds later Puter is asked again.
    env.now += 10_000;
    refuse = false;
    assert.deepEqual((await sync({ ids })).missing, []);
    await A.call(owner, next);
  } finally {
    kv.list = list;
    doc.destroy();
  }
});

test("a listing Puter is slow to answer holds a synchronization three seconds at most, and others not at all", async () => {
  const { env, sync, saved, doc, kv, list, lists } = await unlisted("stalled");
  let release;
  const stalled = new Promise((resolve) => (release = resolve));
  kv.list = async (options) => {
    lists.count++;
    await stalled;
    return list.call(kv, options);
  };
  try {
    const ids = [saved.id];
    const started = Date.now();
    assert.deepEqual((await sync({ ids })).missing, ids);
    const waited = Date.now() - started;
    assert.ok(waited >= 2900 && waited < 4500, `${waited} ms`);
    env.now += 2500;
    const again = Date.now();
    assert.deepEqual((await sync({ ids })).missing, ids);
    assert.ok(Date.now() - again < 500);
    assert.equal(lists.count, 1);
    // Once it is answered, the copy has the save.
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    env.now += 2000;
    assert.deepEqual((await sync({ ids })).missing, []);
  } finally {
    release();
    kv.list = list;
    doc.destroy();
  }
});

test("an edit building on a record another instance's refresh missed is still accepted", async () => {
  const env = environment();
  const A = env.service;
  // An instance whose clock runs a minute behind writes records that look
  // older than the window B reads again when it refreshes.
  const { BoardService: Slow } =
    await import("../worker/service.js?instance=slow-clock");
  const { BoardService: Other } =
    await import("../worker/service.js?instance=missed");
  const slow = new Slow(A.puter, { now: () => env.now - 60_000, org: A.org });
  const B = new Other(A.puter, { now: () => env.now, org: A.org });
  const b = board("Missed");
  b.items = [item("note", 0, 0, { text: "Hi" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await A.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  await B.call(owner, { op: "sync", room: b.id });
  const edit = async (change) => {
    const vector = doc.vector(),
      next = doc.snapshot();
    change(next);
    doc.commit(next);
    const update = doc.update(vector);
    return {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    };
  };
  await slow.call(
    owner,
    await edit((next) =>
      next.items.push(item("note", 200, 0, { text: "New" })),
    ),
  );
  env.now += 5000;
  // B's refresh misses the record, and reading the board again from its
  // checkpoint finds it.
  await B.call(owner, await edit((next) => (next.items[1].text = "Edited")));
  const { update } = await B.call(owner, { op: "sync", room: b.id });
  const state = new SharedDocument(decode(update));
  assert.deepEqual(
    state.snapshot().items.map((i) => i.text),
    ["Hi", "Edited"],
  );
  state.destroy();
  doc.destroy();
});

test("the worker's file cache counts checkpoints and stays within its limit", async () => {
  const { BoardService, FILES } = await import("../worker/service.js");
  const { environment } = await import("./collaboration-helpers.js");
  const { SharedDocument } = await import("../src/collaboration/document.js");
  const { board, item } = await import("../src/model.js");
  const env = environment();
  const service = new BoardService(env.service.puter, { now: () => env.now });
  const b = board("Big");
  b.items = Array.from({ length: 50 }, (_, n) =>
    item("note", n * 10, 0, { text: "x".repeat(19000) }),
  );
  const doc = new SharedDocument();
  doc.commit(b);
  for (let n = 0; n < 60; n++) {
    const next = doc.snapshot();
    next.items[0].text = `v${n}`;
    doc.commit(next);
    await service.checkpoint(`room-${n % 3}`, doc, env.now);
  }
  for (let n = 0; n < 20; n++) {
    const path = `whiteboard/shared/x/f${n}.txt`;
    env.files.set(path, "y".repeat(1_500_000));
    await service.cachedFile(path);
  }
  const held = [...FILES.values()].reduce((sum, v) => sum + v.length, 0);
  assert.equal(FILES.bytes, held);
  assert.ok(held <= 48_000_000, `${held}`);
  doc.destroy();
});

test("a quiet board's checkpoint is renewed so loads stop reading its whole log", async () => {
  const { BoardService, DOCS } = await import("../worker/service.js");
  const { environment, owner } = await import("./collaboration-helpers.js");
  const { SharedDocument } = await import("../src/collaboration/document.js");
  const { encode, hash } = await import("../src/collaboration/protocol.js");
  const { board, item } = await import("../src/model.js");
  const env = environment();
  const puter = env.service.puter;
  const service = new BoardService(puter, { now: () => env.now });
  const b = board("Quiet");
  b.items = [item("note", 0, 0, { text: "start" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  for (let n = 0; n < 30; n++) {
    env.now += 2000;
    const vector = doc.vector(),
      next = doc.snapshot();
    next.items[0].text = `edit ${n}`;
    doc.commit(next);
    const update = doc.update(vector);
    await service.call(owner, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    });
  }
  // A later load checkpoints every edit; then the board goes quiet.
  env.now += 2 * 86_400_000;
  DOCS.clear();
  await service.call(owner, { op: "sync", room: b.id });
  env.now += 8 * 86_400_000;
  const list = puter.kv.list;
  let rows = 0;
  puter.kv.list = async (options) => {
    const page = await list(options);
    if (String(options?.pattern || "").includes(":log:"))
      rows += page.items.length;
    return page;
  };
  const coldSync = async () => {
    DOCS.clear();
    rows = 0;
    const { update } = await service.call(owner, { op: "sync", room: b.id });
    return { rows, update };
  };
  const renewed = env.data.get(`wb:${b.id}:cp`).at;
  // Every edit is older than the checkpoint, so even the first load after a
  // week reads only the newest page of the log, and renews the checkpoint.
  const first = await coldSync();
  assert.ok(first.rows < 5, `${first.rows} log records read`);
  assert.ok(env.data.get(`wb:${b.id}:cp`).at > renewed);
  const second = await coldSync();
  assert.ok(second.rows < 5, `${second.rows} log records read again`);
  const state = new SharedDocument(
    (await import("../src/collaboration/protocol.js")).decode(second.update),
  );
  assert.equal(state.snapshot().items[0].text, "edit 29");
  state.destroy();
  doc.destroy();
});

test("an old version reads the edit log only up to its moment", async () => {
  const { BoardService } = await import("../worker/service.js");
  const env = environment();
  const puter = env.service.puter;
  const service = new BoardService(puter, { now: () => env.now });
  const b = board("Old");
  b.items = [item("note", 0, 0, { text: "start" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  const times = [];
  for (let n = 0; n < 40; n++) {
    env.now += 60_000;
    const vector = doc.vector(),
      next = doc.snapshot();
    next.items[0].text = `edit ${n}`;
    doc.commit(next);
    const update = doc.update(vector);
    await service.call(owner, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    });
    times.push(env.now);
  }
  await service.checkpoint(b.id, doc, env.now);
  const list = puter.kv.list;
  let rows = 0;
  puter.kv.list = async (options) => {
    const page = await list(options);
    if (String(options?.pattern || "").includes(":log:"))
      rows += page.items.length;
    return page;
  };
  // Versions before the checkpoint replay the log from the start, reading
  // at most a page past their last edit.
  for (const n of [0, 4, 38]) {
    rows = 0;
    const { doc: past, count } = await service.loadAt(b.id, times[n]);
    assert.equal(past.snapshot().items[0].text, `edit ${n}`);
    assert.equal(count, n + 1);
    assert.ok(rows <= n + 4, `${rows} log records read`);
    past.destroy();
  }
  puter.kv.list = list;
  doc.destroy();
});

test("an old version starts from the checkpoint before it", async () => {
  const { BoardService } = await import("../worker/service.js");
  const env = environment();
  const puter = env.service.puter;
  const service = new BoardService(puter, { now: () => env.now });
  const b = board("Old");
  b.items = [item("note", 0, 0, { text: "start" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  const times = [];
  for (let n = 0; n < 60; n++) {
    env.now += 600_000;
    const vector = doc.vector(),
      next = doc.snapshot();
    next.items[0].text = `edit ${n}`;
    doc.commit(next);
    const update = doc.update(vector);
    await service.call(owner, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    });
    times.push(env.now);
    if (n === 19 || n === 39) await service.checkpoint(b.id, doc, env.now);
  }
  await service.checkpoint(b.id, doc, env.now);
  for (const [n, at] of times.entries()) {
    const { doc: past } = await service.loadAt(b.id, at);
    assert.equal(past.snapshot().items[0].text, `edit ${n}`);
    past.destroy();
  }
  const list = puter.kv.list;
  let rows = 0;
  puter.kv.list = async (options) => {
    const page = await list(options);
    if (String(options?.pattern || "").includes(":log:"))
      rows += page.items.length;
    return page;
  };
  // Each reads the edits since the checkpoint before it, and a few more
  // from the hour that checkpoint was saved in.
  for (const [n, from] of [
    [19, 19],
    [25, 19],
    [45, 39],
    [58, 39],
  ]) {
    rows = 0;
    const { doc: past } = await service.loadAt(b.id, times[n]);
    assert.equal(past.snapshot().items[0].text, `edit ${n}`);
    assert.ok(rows <= n - from + 10, `${rows} log records read`);
    past.destroy();
  }
  puter.kv.list = list;
  doc.destroy();
});

test("an edit saved while another request reads the board stays in the instance's cached state", async () => {
  const { BoardService } = await import("../worker/service.js");
  const env = environment();
  const puter = env.service.puter;
  const service = new BoardService(puter, { now: () => env.now });
  const b = board("Busy");
  b.items = [item("note", 0, 0, { text: "start" })];
  const doc = new SharedDocument();
  doc.commit(b);
  await service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
  });
  (await service.load(b.id)).doc.destroy();
  env.now += 2000;
  // A synchronization starts reading the edit log and is slow to finish.
  const list = puter.kv.list;
  let paused, resume;
  const reached = new Promise((resolve) => (paused = resolve));
  puter.kv.list = async (options) => {
    const page = await list(options);
    if (String(options?.pattern || "").includes(":log:") && !resume) {
      const gate = new Promise((resolve) => (resume = resolve));
      paused();
      await gate;
    }
    return page;
  };
  const slow = service.load(b.id);
  await reached;
  // Meanwhile this instance saves an edit.
  const vector = doc.vector(),
    next = doc.snapshot();
  next.items[0].text = "saved";
  doc.commit(next);
  const update = doc.update(vector);
  await new BoardService(puter, { now: () => env.now }).call(owner, {
    op: "commit",
    room: b.id,
    id: await hash(update),
    update: encode(update),
  });
  resume();
  (await slow).doc.destroy();
  puter.kv.list = list;
  const { doc: cached } = await service.load(b.id);
  assert.equal(cached.snapshot().items[0].text, "saved");
  cached.destroy();
  doc.destroy();
});

test("sharing a board the worker cannot accept is refused for good, not retried", async () => {
  const env = environment();
  const invalid = new SharedDocument();
  invalid.items.set("bad", new (await import("yjs")).Map());
  for (const update of ["not base64!", encode(invalid.update())])
    await assert.rejects(
      env.service.call(owner, { op: "create", room: "refused", update }),
      (error) => error.status === 422,
    );
  invalid.destroy();
  // Nothing was created, so a valid board can still be shared there.
  const b = board("Valid"),
    doc = new SharedDocument();
  doc.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: "refused",
    update: encode(doc.update()),
  });
  doc.destroy();
});

test("a synchronization read from the cached state brings what loading the board would", async () => {
  const env = environment();
  const b = board("Cached");
  b.items = Array.from({ length: 30 }, (_, n) =>
    item("note", n * 10, 0, { text: "Note " + n }),
  );
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  // A participant who has seen only the board as it was created.
  const vector = seed.vector();
  for (let n = 0; n < 4; n++) {
    const { update } = await env.service.call(owner, {
      op: "sync",
      room: b.id,
    });
    const doc = new SharedDocument(decode(update)),
      known = doc.vector(),
      next = doc.snapshot();
    next.items[n].text = "Edited " + n;
    next.items.splice(10 + n, 1);
    next.items.push(item("rect", n * 100, 900));
    doc.commit(next);
    const edit = doc.update(known);
    doc.destroy();
    await env.service.call(owner, {
      op: "commit",
      room: b.id,
      id: await hash(edit),
      update: encode(edit),
    });
  }
  const { doc: loaded } = await env.service.load(b.id);
  for (const request of [{ vector: encode(vector) }, {}]) {
    const { update } = await env.service.call(owner, {
      op: "sync",
      room: b.id,
      ...request,
    });
    const doc = new SharedDocument(request.vector ? seed.update() : undefined);
    doc.apply(decode(update));
    assert.deepEqual(doc.snapshot(), loaded.snapshot());
    doc.destroy();
  }
  loaded.destroy();
  seed.destroy();
});

test("commits saved together share board event signals, each after its own save", async () => {
  const env = environment(),
    service = env.service;
  const signals = [];
  const set = service.kv.set.bind(service.kv);
  service.kv.set = async (key, value) => {
    if (key.endsWith(":ev:signal")) {
      const write = { asked: [...asked] };
      signals.push(write);
      await new Promise((r) => setTimeout(r, 20));
    }
    return set(key, value);
  };
  const asked = [];
  const notify = (n) => {
    asked.push(n);
    return service.notify("room").then(() => n);
  };
  await Promise.all(Array.from({ length: 10 }, (_, n) => notify(n)));
  assert.equal(signals.length, 2);
  // A save signalled while a write is under way gets a write begun after it.
  const first = notify("first");
  await new Promise((r) => setTimeout(r, 5));
  await Promise.all([first, notify("second")]);
  assert.equal(signals.length, 4);
  assert.ok(signals.at(-1).asked.includes("second"));
});

test("retention work never runs inside a save, synchronization or check-in", async () => {
  const env = environment(),
    service = env.service;
  const b = board("Busy");
  const seed = new SharedDocument();
  seed.commit(b);
  await service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  let runs = 0;
  service.org.scheduledWork = async () => void runs++;
  runs = 0;
  await service.call(owner, { op: "sync", room: b.id });
  assert.equal(runs, 0);
  await service.call(owner, { op: "members", room: b.id });
  assert.equal(runs, 1);
});

// Two instances of an account's worker, each keeping its own records, with
// a board on it.
async function instances(name) {
  const env = environment();
  const A = env.service;
  const { BoardService } = await import(
    `../worker/service.js?instance=access-${name}`
  );
  const puter = { ...A.puter };
  const B = new BoardService(puter, {
    now: () => env.now,
    org: new OrgService(puter, { now: () => env.now }),
  });
  const b = board("Access");
  b.items = [item("note", 0, 0, { text: "Hi" })];
  const seed = new SharedDocument();
  seed.commit(b);
  await A.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const join = async (user, options = {}) => {
    const { token } = await A.call(owner, {
      op: "invite",
      room: b.id,
      role: "editor",
      ...options,
    });
    await A.call(user, { op: "join", room: b.id, token });
  };
  const admin = (identity, input) => adminCall(A.org, A, identity, input);
  return { env, A, B, room: b.id, join, admin };
}

// A board's content activity log, as its owner reads it: added, changed
// and removed counts, oldest first, and an editor's commits through A.
async function activityLog(name) {
  const setup = await instances(name);
  const { env, A, room } = setup;
  const log = () =>
    [...env.data]
      .filter(([k]) => k.startsWith(`org:bact:${room}:`))
      .map(([, v]) => v)
      .filter((v) => v.action === "board.content.updated")
      .sort((a, b) => a.at - b.at)
      .map(({ details: d }) => [d.added, d.changed, d.removed]);
  const commit = async (change, target = room) => {
    const { doc } = await A.load(target);
    const before = doc.vector(),
      next = doc.snapshot();
    change(next);
    doc.commit(next);
    const update = doc.update(before);
    doc.destroy();
    return A.call(owner, {
      op: "commit",
      room: target,
      id: await hash(update),
      update: encode(update),
    });
  };
  return { ...setup, log, commit };
}

test("the activity log keeps every deletion, and edits a minute held back, whichever instance is asked next", async () => {
  const { env, A, B, room, log, commit } = await activityLog("deletions");
  env.now += 5 * 60_000;
  await commit((b) => {
    for (let n = 0; n < 19; n++) b.items.push(item("note", n * 100, 200));
  });
  assert.deepEqual(log(), [[19, 0, 0]]);
  // Within the minute, a change waits; a mass deletion is written at once,
  // with it.
  env.now += 20_000;
  await commit((b) => (b.items[0].text = "Tweak"));
  assert.deepEqual(log(), [[19, 0, 0]]);
  env.now += 20_000;
  await commit((b) => (b.items = b.items.slice(0, 1)));
  assert.deepEqual(log(), [
    [19, 0, 0],
    [0, 1, 19],
  ]);
  // A note added just after waits for the minute. Leaving through another
  // instance cannot write it, but whatever A is asked next does.
  env.now += 10_000;
  await commit((b) => b.items.push(item("note", 0, 400)));
  env.now += 60_000;
  await B.call(owner, { op: "leave", room, session: "s1" });
  assert.equal(log().length, 2);
  await A.call(owner, { op: "members", room });
  assert.deepEqual(log().at(-1), [1, 0, 0]);
});

test("an instance editing many boards writes a board's held-back activity before letting it go", async () => {
  const { env, A, room, log, commit } = await activityLog("eviction");
  env.now += 5 * 60_000;
  await commit((b) => b.items.push(item("note", 0, 200)));
  env.now += 10_000;
  await commit((b) => b.items.push(item("note", 0, 400)));
  assert.deepEqual(log(), [[1, 0, 0]]);
  // A thousand other boards edited through this instance since.
  const activity = A.org.instance.activity;
  for (let n = 0; n < 1000; n++)
    activity.set(`other${n}`, {
      at: env.now,
      added: 0,
      changed: 0,
      removed: 0,
      editors: new Set(),
    });
  const other = board("Other"),
    seed = new SharedDocument();
  seed.commit(other);
  await A.call(owner, {
    op: "create",
    room: other.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  await commit((b) => b.items.push(item("note", 0, 0)), other.id);
  assert.ok(!activity.has(room));
  assert.deepEqual(log(), [
    [1, 0, 0],
    [1, 0, 0],
  ]);
});

test("removing or demoting someone through one instance applies on another within a second", async () => {
  const { env, A, B, room, join } = await instances("revoke");
  await join(editor);
  const doc = new SharedDocument(
    decode((await B.call(editor, { op: "sync", room })).update),
  );
  const edit = async (text) => {
    const vector = doc.vector(),
      next = doc.snapshot();
    next.items[0].text = text;
    doc.commit(next);
    const update = doc.update(vector);
    return B.call(editor, {
      op: "commit",
      room,
      id: await hash(update),
      update: encode(update),
    });
  };
  // B keeps the editor's records, longer than the two seconds it once did.
  env.now += 2000;
  await edit("Kept");
  env.now += 2500;
  await edit("Still kept");
  await A.call(owner, { op: "role", room, uuid: editor.uuid, role: "viewer" });
  env.now += 1000;
  await assert.rejects(edit("Demoted"), { status: 403, message: /read-only/ });
  await A.call(owner, { op: "role", room, uuid: editor.uuid, role: "removed" });
  env.now += 1000;
  await assert.rejects(B.call(editor, { op: "sync", room }), {
    status: 403,
    message: /no longer have access/,
  });
  doc.destroy();
});

test("deactivating someone or changing the organization's policy through one instance applies on another within a second", async () => {
  const { env, B, room, join, admin } = await instances("organization");
  await admin(owner, { op: "org.setup", name: "CDS" });
  const { token } = await admin(owner, { op: "org.invite", role: "member" });
  await admin(editor, { op: "org.join", token });
  await join(editor);
  await join(guest, { guest: true });
  const sync = (user) => B.call(user, { op: "sync", room });
  for (const wait of [0, 2000, 500]) {
    env.now += wait;
    await sync(editor);
    await sync(guest);
  }
  await admin(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  await admin(owner, {
    op: "org.policy.set",
    policy: { guestAccess: false },
  });
  env.now += 1000;
  await assert.rejects(sync(editor), { status: 403, message: /deactivated/ });
  await assert.rejects(sync(guest), {
    status: 403,
    message: /does not allow guest access/,
  });
});

test("a change made through a worker from before access stamps, which writes none, applies within the backstop", async () => {
  const { env, B, room, join, admin } = await instances("older");
  await admin(owner, { op: "org.setup", name: "CDS" });
  const { token } = await admin(owner, { op: "org.invite", role: "member" });
  await admin(editor, { op: "org.join", token });
  await join(editor);
  await join(viewer, { role: "viewer" });
  const sync = (user) => B.call(user, { op: "sync", room });
  for (const wait of [0, 2000]) {
    env.now += wait;
    await sync(editor);
    await sync(viewer);
  }
  const changed = env.now,
    member = `wb:${room}:member:${viewer.uuid}`,
    account = `org:user:${editor.uuid}`;
  env.data.set(member, { ...env.data.get(member), role: "removed" });
  env.data.set(account, { ...env.data.get(account), status: "deactivated" });
  // Instances keep what they read while the stamps are unchanged...
  env.now += 5000;
  await sync(editor);
  await sync(viewer);
  // ...for no longer than the backstop.
  env.now = changed + KEEP;
  await assert.rejects(sync(editor), { status: 403, message: /deactivated/ });
  await assert.rejects(sync(viewer), { status: 403 });
});

test("a guest's access ends when it expires, while an instance keeps their records", async () => {
  const { env, B, room, join, admin } = await instances("expiry");
  await admin(owner, { op: "org.setup", name: "CDS" });
  await admin(owner, { op: "org.policy.set", policy: { guestExpiryDays: 1 } });
  await join(guest, { guest: true });
  const { expires } = env.data.get(`wb:${room}:member:${guest.uuid}`);
  env.now = expires - 3000;
  await B.call(guest, { op: "sync", room });
  env.now += 2000;
  await B.call(guest, { op: "sync", room });
  env.now += 2000;
  await assert.rejects(B.call(guest, { op: "sync", room }), {
    status: 403,
    message: /guest access to this board has expired/,
  });
});

test("someone joining leaves the board's access stamp, and an instance that refused them lets them in within two seconds", async () => {
  const { env, B, room, join } = await instances("join");
  await assert.rejects(B.call(viewer, { op: "sync", room }), { status: 403 });
  const stamp = env.data.get(`wb:${room}:access`);
  await join(viewer, { role: "viewer" });
  // Every instance would otherwise read everyone's membership again.
  assert.equal(env.data.get(`wb:${room}:access`), stamp);
  env.now += 2000;
  await B.call(viewer, { op: "sync", room });
});

test("the worker tells which account owns the browser sessions that added objects", async () => {
  const env = environment();
  const b = board("Who added");
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  seed.destroy();
  const { token } = await env.service.call(owner, {
    op: "invite",
    room: b.id,
    role: "editor",
  });
  await env.service.call(editor, { op: "join", room: b.id, token });
  const add = async (user, text) => {
    const { update: state } = await env.service.call(user, {
      op: "sync",
      room: b.id,
    });
    const doc = new SharedDocument(decode(state));
    const before = doc.vector(),
      next = doc.snapshot(b.id),
      note = item("note", 0, 0, { text });
    next.items.push(note);
    doc.commit(next);
    const update = doc.update(before);
    await env.service.call(user, {
      op: "commit",
      room: b.id,
      id: await hash(update),
      update: encode(update),
    });
    const client = doc.creator(note.id);
    doc.destroy();
    return client;
  };
  const alice = await add(owner, "Mine"),
    bob = await add(editor, "Bob's");
  assert.notEqual(alice, bob);
  const { owners } = await env.service.call(editor, {
    op: "creators",
    room: b.id,
    clients: [alice, bob, 123456789, -1, "x", alice],
  });
  assert.deepEqual(owners, { [alice]: owner.uuid, [bob]: editor.uuid });
  // Only people who can open the board may ask.
  await assert.rejects(
    env.service.call(guest, { op: "creators", room: b.id, clients: [bob] }),
  );
});

test("a busy board is checkpointed once across instances, at most every five minutes", async () => {
  const { BoardService } = await import("../worker/service.js");
  const now = Date.UTC(2026, 9, 13, 12);
  const minute = 60_000;
  const records = (from, count) =>
    new Map(
      Array.from({ length: count }, (_, n) => [
        `wb:room:log:${n}`,
        from + n * 10,
      ]),
    );
  const due = (entry, stored = null) =>
    BoardService.prototype.checkpointDue.call(
      { kv: { get: async () => stored } },
      "room",
      entry,
      now,
    );
  // A board without a checkpoint gets one.
  assert.equal(await due({ seen: records(now - minute, 1) }), true);
  // 300 records past this instance's checkpoint, but another instance
  // checkpointed after 200 of them: its checkpoint is taken up instead.
  const entry = {
    checkpoint: { at: now - 10 * minute, path: "old" },
    seen: records(now - 6 * minute, 300),
  };
  const stored = { at: now - 6 * minute + 1995, path: "newer" };
  assert.equal(await due(entry, stored), false);
  assert.equal(entry.checkpoint, stored);
  assert.equal(entry.seen.size, 100);
  // 256 records within five minutes of the last checkpoint wait for it.
  const recent = {
    checkpoint: { at: now - 2 * minute, path: "recent" },
    seen: records(now - 2 * minute + 1, 300),
  };
  assert.equal(await due(recent, recent.checkpoint), false);
  // Five minutes on, or with far more records, one is written.
  assert.equal(
    await due({
      checkpoint: { at: now - 6 * minute, path: "older" },
      seen: records(now - 6 * minute + 1, 300),
    }),
    true,
  );
  assert.equal(
    await due({
      checkpoint: { at: now - 2 * minute, path: "recent" },
      seen: records(now - 2 * minute + 1, 5000),
    }),
    true,
  );
});

test("a loaded board's whole state is encoded once until it changes", () => {
  const b = board("Encoded");
  b.items = [item("note", 0, 0, { text: "One" })];
  const seed = new SharedDocument();
  seed.commit(b);
  const live = new SharedDocument(seed.update());
  live.cacheItems();
  const first = live.update();
  assert.equal(live.update(), first, "kept while unchanged");
  assert.deepEqual(first, Y.encodeStateAsUpdate(live.doc));
  // A change from elsewhere, and one made here, encode it again.
  const other = new SharedDocument(seed.update());
  const before = other.vector(),
    next = other.snapshot();
  next.items[0].text = "Two";
  other.commit(next);
  live.apply(other.update(before));
  const second = live.update();
  assert.notEqual(second, first);
  assert.equal(new SharedDocument(second).snapshot().items[0].text, "Two");
  const mine = live.snapshot();
  mine.items[0].text = "Three";
  live.commit(mine);
  assert.equal(
    new SharedDocument(live.update()).snapshot().items[0].text,
    "Three",
  );
  // Asked for what a vector lacks, it encodes just that.
  assert.ok(live.update(other.vector()).length < live.update().length);
});
