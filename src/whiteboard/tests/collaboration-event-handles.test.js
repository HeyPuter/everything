import test from "node:test";
import assert from "node:assert/strict";
import { board as newBoard } from "../src/model.js";
import { encode } from "../src/collaboration/protocol.js";
import { SharedDocument } from "../src/collaboration/document.js";
import { allowLiveUpdates } from "../src/collaboration/consent.js";
import { environment, owner, editor, viewer } from "./collaboration-helpers.js";

async function shared(refuse) {
  const env = environment();
  const b = newBoard("Workshop");
  const seed = new SharedDocument();
  seed.commit(b);
  await env.service.call(owner, {
    op: "create",
    room: b.id,
    update: encode(seed.update()),
  });
  const { token } = await env.service.call(owner, {
    op: "invite",
    room: b.id,
    role: "editor",
  });
  for (const user of [editor, viewer])
    await env.service.call(user, { op: "join", room: b.id, token });
  const mints = [];
  const answer = env.service.fetcher;
  env.service.fetcher = async (url, options) => {
    if (options.method !== "DELETE")
      mints.push(JSON.parse(options.body).granteeUid);
    if (refuse.code && options.method !== "DELETE")
      return Response.json(
        { message: "Refused", code: refuse.code },
        { status: 403 },
      );
    return answer(url, options);
  };
  const events = (user, extra = {}) =>
    env.service.call(user, { op: "events", room: b.id, ...extra });
  return { env, room: b.id, mints, events };
}

// Without the worker account's consent every mint is refused, and every
// member asked again each time, spending the account's mint budget.
test("a refusal that holds for every member pauses minting until the account consents", async () => {
  const refuse = { code: "events_kv_handle_not_delegated" };
  const { mints, events } = await shared(refuse);
  assert.equal((await events(editor)).events, null);
  await events(viewer);
  await events(editor);
  assert.deepEqual(mints, [editor.uuid]);
  refuse.code = null;
  await events(owner, { consented: true });
  assert.equal((await events(viewer)).events.handle, `handle-${viewer.uuid}`);
});

test("a refusal about one member holds back only them", async () => {
  const refuse = { code: "recipient_not_accepting_shares" };
  const { mints, events } = await shared(refuse);
  await events(editor);
  await events(editor);
  assert.deepEqual(mints, [editor.uuid]);
  refuse.code = null;
  assert.equal((await events(viewer)).events.handle, `handle-${viewer.uuid}`);
});

// The grant was asked for the board's owner, who in an organization is not
// the account the worker runs as: Puter refused it without a prompt, or it
// went to an account whose consent the worker never uses.
test("asks the worker account for the consent, and tells the board", async () => {
  const asked = [],
    sent = [];
  const session = { request: async (op, data) => sent.push({ op, ...data }) };
  const puter = {
    appID: "app-wb",
    perms: { request: async (...a) => (asked.push(a), true) },
  };
  const own = {
    events: { app: "app-wb", key: "wb:r:ev:signal", owner: owner.uuid },
    owner: editor.uuid,
  };
  assert.equal(await allowLiveUpdates(session, puter, own), true);
  assert.deepEqual(asked, [
    ["permission", { permission: `manage:kv-share:${owner.uuid}:app-wb:wb` }],
  ]);
  assert.deepEqual(sent, [{ op: "events", consented: true }]);
  puter.perms.Resource = { KV_SHARE: "kvShare" };
  await allowLiveUpdates(session, puter, own);
  assert.deepEqual(asked.at(-1), [
    "kvShare",
    { prefix: "wb:", access: "watch" },
  ]);
});

test("does not ask anyone but the worker account, or from another app", async () => {
  let asked = 0;
  const session = { request: async () => {} };
  const puter = {
    appID: "app-wb",
    perms: { request: async () => (asked++, true) },
  };
  assert.equal(
    await allowLiveUpdates(session, puter, {
      events: null,
      owner: editor.uuid,
      app: "app-wb",
    }),
    false,
  );
  const own = { events: { app: "app-wb", key: "k", owner: owner.uuid } };
  assert.equal(
    await allowLiveUpdates(session, { ...puter, appID: "app-other" }, own),
    false,
  );
  assert.equal(asked, 0);
});
