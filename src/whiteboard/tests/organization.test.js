import test from "node:test";
import assert from "node:assert/strict";
import { board, item } from "../src/model.js";
import { SharedDocument } from "../src/collaboration/document.js";
import { encode, hash, keyPair } from "../src/collaboration/protocol.js";
import { adminCall, apiKey, organizationRequest } from "../worker/admin.js";
import {
  restRoute,
  restRequest,
  parseFilter,
  toCSV,
  openAPI,
} from "../worker/api.js";
import { auditCategory, mergePolicy, normalizePolicy } from "../worker/org.js";
import {
  hmac,
  sendHook,
  azureCloud,
  sentinelChunks,
  siem,
  siemRecord,
  unsentAudit,
} from "../worker/delivery.js";
import { reportSummary, sendScheduledReport } from "../worker/reports.js";
import { purge } from "../worker/retention.js";
import { createOrganization, ORG_KEY } from "../src/organization/client.js";
import { normalizeEmbed } from "../src/content/providers.js";
import { environment, owner, editor, viewer } from "./collaboration-helpers.js";

const guest = {
  uuid: "44444444-4444-4444-8444-444444444444",
  username: "Dee",
};
function setup() {
  const env = environment();
  const boards = env.service,
    org = boards.org;
  const sent = [],
    fetched = [];
  org.puter.email = {
    async sendTransactional(message) {
      sent.push(message);
      return { failed: [] };
    },
  };
  org.fetcher = boards.fetcher = async (url, options = {}) => {
    fetched.push({ url: String(url), options });
    if (String(url).includes("/events/kv-handles"))
      return Response.json({ handle: "handle-x" });
    if (String(url).includes("login.microsoftonline.com"))
      return Response.json({ access_token: "entra-token", expires_in: 3600 });
    return new Response("{}", { status: 200 });
  };
  const call = (user, input) => adminCall(org, boards, user, input);
  return { env, boards, org, call, sent, fetched };
}
function createInput(
  title = "Planning",
  items = [item("note", 0, 0, { text: title })],
) {
  const b = board(title),
    doc = new SharedDocument();
  b.items = items;
  doc.commit(b);
  const input = { op: "create", room: b.id, update: encode(doc.update()) };
  doc.destroy();
  return { input, room: b.id };
}
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
async function join(env, user, token) {
  return env.service.call(user, {
    op: "join",
    room: token.room,
    token: token.token,
  });
}

test("policy patches keep known fields, validate addresses, and fill new defaults", () => {
  const policy = mergePolicy(normalizePolicy(), {
    name: "Fabrikam",
    domains: ["fabrikam.test", "@Example.CA"],
    unknown: true,
    ai: { enabled: false, bogus: 1 },
    externalSharing: "anyone",
  });
  assert.deepEqual(policy.domains, ["fabrikam.test", "example.ca"]);
  assert.equal(policy.ai.enabled, false);
  assert.equal(policy.unknown, undefined);
  assert.equal(policy.ai.bogus, undefined);
  assert.throws(() => mergePolicy(policy, { domains: ["not a domain"] }), {
    status: 400,
  });
  assert.throws(
    () => mergePolicy(policy, { siem: { sentinel: { dcrId: "nope" } } }),
    { status: 400 },
  );
  for (const endpoint of [
    "https://evil.example/#.ingest.monitor.azure.com",
    "https://evil.example/?.ingest.monitor.azure.com",
    "https://wb.ingest.monitor.azure.com.evil.example/",
  ])
    assert.throws(
      () => mergePolicy(policy, { siem: { sentinel: { endpoint } } }),
      { status: 400 },
    );
  assert.equal(
    mergePolicy(policy, {
      siem: {
        sentinel: {
          endpoint: "https://wb.canadacentral-1.ingest.monitor.azure.com/",
        },
      },
    }).siem.sentinel.endpoint,
    "https://wb.canadacentral-1.ingest.monitor.azure.com",
  );
  mergePolicy(
    policy,
    JSON.parse('{"integrations":{"__proto__":{"enabled":true}}}'),
  );
  assert.equal({}.enabled, undefined, "policy patches cannot touch prototypes");
  assert.throws(() => mergePolicy(policy, { alerts: { emails: ["x"] } }), {
    status: 400,
  });
  const filled = normalizePolicy({ name: "Old", ai: { enabled: false } });
  assert.equal(filled.ai.enabled, false);
  assert.equal(filled.ai.summaries, true);
  assert.equal(filled.retention.auditDays, 365);
});

test("organization setup, invitations, and members creating boards", async () => {
  const { env, boards, call, org } = setup();
  const { input: early, room: legacy } = createInput("Before organization");
  await boards.call(owner, early);
  await assert.rejects(call(editor, { op: "org.setup", name: "Fabrikam" }), {
    status: 403,
  });
  const info = await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  assert.equal(info.configured, true);
  assert.equal(info.role, "owner");
  // Existing boards are backfilled into the directory.
  assert.equal(
    (await org.kv.get("org:board:" + legacy)).title,
    "Before organization",
  );
  await assert.rejects(call(editor, { op: "org.join" }), { status: 403 });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  const joined = await call(editor, { op: "org.join", token });
  assert.equal(joined.user.role, "member");
  const { input, room } = createInput("Member board");
  await boards.call(editor, input);
  const listed = await call(editor, { op: "org.boards", scope: "mine" });
  assert.deepEqual(
    listed.boards.map((b) => b.title),
    ["Member board"],
  );
  assert.equal(listed.boards[0].role, "owner");
  const all = await call(owner, { op: "org.boards", scope: "all" });
  assert.equal(all.boards.length, 2);
  await assert.rejects(call(editor, { op: "org.boards", scope: "all" }), {
    status: 403,
  });
  // Administrators can govern any board without a membership record.
  const adminView = await boards.call(owner, { op: "join", room });
  assert.equal(adminView.member.role, "owner");
  assert.equal(adminView.member.orgAdmin, true);
  // Unarchiving, as the admin console and board settings ask, is audited
  // as such rather than as restoring a deleted board.
  await boards.call(owner, { op: "archive", room });
  const unarchived = await boards.call(owner, { op: "unarchive", room });
  assert.equal(unarchived.settings.archived, false);
  // Policy can stop members from creating boards.
  await call(owner, {
    op: "org.policy.set",
    policy: { membersCanCreate: false },
  });
  await assert.rejects(boards.call(editor, createInput("Denied").input), {
    status: 403,
  });
  const actions = (await call(owner, { op: "org.audit" })).entries.map(
    (e) => e.action,
  );
  for (const action of [
    "org.created",
    "user.invited",
    "user.joined",
    "board.created",
    "board.archived",
    "board.unarchived",
    "policy.updated",
  ])
    assert.ok(actions.includes(action), action);
  assert.ok(!actions.includes("board.restored"));
  assert.ok(env.data.size > 0);
});

test("roles: commenters discuss without editing, facilitators manage access", async () => {
  const { boards } = setup();
  const { input, room } = createInput();
  await boards.call(owner, input);
  const facilitatorInvite = await boards.call(owner, {
    op: "invite",
    room,
    role: "facilitator",
  });
  await join({ service: boards }, editor, {
    room,
    token: facilitatorInvite.token,
  });
  const commenterInvite = await boards.call(editor, {
    op: "invite",
    room,
    role: "commenter",
  });
  await join({ service: boards }, viewer, {
    room,
    token: commenterInvite.token,
  });
  await assert.rejects(
    boards.call(editor, { op: "invite", room, role: "facilitator" }),
    {
      status: 403,
    },
  );
  await assert.rejects(
    commit(boards, viewer, room, (b) => (b.items[0].text = "Changed")),
    { status: 422 },
  );
  await commit(boards, viewer, room, (b) => {
    b.comments = [
      {
        id: "t1",
        x: 0,
        y: 0,
        resolved: false,
        messages: [
          {
            id: "m1",
            authorId: viewer.uuid,
            authorName: viewer.username,
            text: "Looks good @alice",
            createdAt: 1,
          },
        ],
      },
    ];
  });
  // The mention notifies the owner, whose username is Alice.
  const notes = await adminCall(boards.org, boards, owner, {
    op: "notifications.list",
  });
  assert.equal(notes.unread, 1);
  assert.equal(notes.items[0].type, "mention");
  await adminCall(boards.org, boards, owner, {
    op: "notifications.read",
    all: true,
  });
  assert.equal(
    (await adminCall(boards.org, boards, owner, { op: "notifications.list" }))
      .unread,
    0,
  );
  await boards.call(editor, {
    op: "role",
    room,
    uuid: viewer.uuid,
    role: "viewer",
  });
  await assert.rejects(
    commit(boards, viewer, room, (b) => (b.comments[0].resolved = true)),
    { status: 403 },
  );
});

test("a guest facilitator cannot file the board into the organization's spaces or teams", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const { space } = await call(owner, { op: "spaces.create", name: "Plans" });
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "viewer",
    guest: true,
  });
  await boards.call(guest, { op: "join", room, token });
  await boards.call(owner, {
    op: "role",
    room,
    uuid: guest.uuid,
    role: "facilitator",
  });
  await assert.rejects(
    boards.call(guest, { op: "settings", room, space: space.id }),
    { status: 403 },
  );
  // Nor do they decide who can open it.
  await assert.rejects(
    boards.call(guest, { op: "settings", room, linkRole: "commenter" }),
    { status: 403 },
  );
  const { settings } = await boards.call(owner, { op: "settings.get", room });
  assert.equal(settings.linkRole, "viewer");
  assert.equal(settings.space ?? null, null);
});

test("everyone on a board learns its organization's AI and embed choices as they join and check in", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
    guest: true,
  });
  const joined = await boards.call(guest, { op: "join", room, token });
  assert.deepEqual(joined.features, {
    ai: { enabled: true, summaries: true, handwriting: true, clustering: true },
    integrations: { google: true, embeds: true },
  });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      ai: { enabled: false },
      integrations: { embeds: { enabled: false } },
    },
  });
  const { publicKey } = await keyPair();
  const checked = await boards.call(guest, {
    op: "presence",
    room,
    session: "dee-tab",
    publicKey,
  });
  assert.equal(checked.features.ai.enabled, false);
  assert.deepEqual(checked.features.integrations, {
    google: true,
    embeds: false,
  });
});

test("the worker refuses new embeds the organization has turned off, for members and guests alike", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const embed = (url, x = 0) => {
    const { provider, url: canonical } = normalizeEmbed(url);
    return item("embed", x, 0, { provider, url: canonical, w: 480, h: 320 });
  };
  const kept = embed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const sheet = (id) =>
    `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;
  const table = (sourceUrl, x = 0) =>
    item("table", x, 400, {
      w: 340,
      h: 150,
      cells: [
        ["Name", "Score"],
        ["Ada", "3"],
      ],
      sourceUrl,
    });
  const linked = table(sheet("1AbCdEfGhIjKlMnOpQrStUvWxYz"));
  const { input, room } = createInput("Embeds", [kept, linked]);
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
    guest: true,
  });
  await boards.call(guest, { op: "join", room, token });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      integrations: {
        embeds: { enabled: false },
        google: { enabled: false },
      },
    },
  });
  for (const user of [owner, guest]) {
    for (const [url, message] of [
      ["https://vimeo.com/76979871", /turned off embedded content/],
      [
        "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit",
        /turned off Google Workspace/,
      ],
      ["https://example.org/page", /turned off embedded content/],
    ])
      await assert.rejects(
        commit(boards, user, room, (b) => b.items.push(embed(url, 600))),
        { status: 422, message },
      );
    // A table linked to a Google Sheet is Google content too.
    await assert.rejects(
      commit(boards, user, room, (b) =>
        b.items.push(table(sheet("1ZyXwVuTsRqPoNmLkJiHgFeDcBa"), 600)),
      ),
      { status: 422, message: /turned off Google Workspace/ },
    );
    // Nor may one already there be pointed somewhere new.
    await assert.rejects(
      commit(boards, user, room, (b) => {
        const i = b.items.find((i) => i.id === kept.id);
        Object.assign(i, embed("https://vimeo.com/76979871"), { id: kept.id });
      }),
      { status: 422 },
    );
    await assert.rejects(
      commit(boards, user, room, (b) => {
        b.items.find((i) => i.id === linked.id).sourceUrl = sheet(
          "1ZyXwVuTsRqPoNmLkJiHgFeDcBa",
        );
      }),
      { status: 422 },
    );
  }
  // What is already on the board still moves and changes.
  await commit(boards, guest, room, (b) => {
    b.items.find((i) => i.id === kept.id).x = 40;
    b.items.find((i) => i.id === linked.id).cells[1][1] = "4";
    b.items.push(item("note", 0, 400, { text: "Still editable" }));
  });
  const { doc } = await boards.load(room);
  assert.equal(doc.snapshot().items.find((i) => i.id === kept.id).x, 40);
  doc.destroy();
  // Turning Google back on lets Google embeds in, and only those.
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { google: { enabled: true } } },
  });
  await commit(boards, guest, room, (b) =>
    b.items.push(
      embed(
        "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit",
        600,
      ),
    ),
  );
});

test("a board is never transferred to someone the organization does not know", async () => {
  const { boards, call } = setup();
  const { input, room } = createInput();
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  // They joined before the organization was set up, so it has no record.
  const other = {
    uuid: "66666666-6666-4666-8666-666666666666",
    username: "Outsider",
  };
  await boards.call(other, { op: "join", room, token });
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await assert.rejects(
    boards.call(owner, { op: "transfer", room, uuid: other.uuid }),
    { status: 400 },
  );
  const { settings } = await boards.call(owner, { op: "settings.get", room });
  assert.ok(settings);
});

test("guest policy, visibility, and external sharing controls", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await call(owner, {
    op: "org.policy.set",
    policy: { externalSharing: "none" },
  });
  await assert.rejects(
    join({ service: boards }, guest, { room, token: invite.token }),
    {
      status: 403,
    },
  );
  await call(owner, {
    op: "org.policy.set",
    policy: {
      externalSharing: "guests",
      guestExpiryDays: 1,
      alerts: { emails: ["sec@fabrikam.test"] },
    },
  });
  const joined = await join({ service: boards }, guest, {
    room,
    token: invite.token,
  });
  assert.equal(joined.member.guest, true);
  assert.ok(joined.member.expires > Date.now());
  assert.equal((await org.user(guest.uuid)).role, "guest");
  assert.equal((await org.kv.get("org:board:" + room)).guestCount, 1);
  // Guest access expires.
  boards.now = () => Date.now() + 2 * 86400_000;
  await assert.rejects(boards.call(guest, { op: "sync", room }), {
    status: 403,
  });
  boards.now = Date.now;
  // Public links require the organization to allow them.
  await assert.rejects(
    boards.call(owner, { op: "settings", room, visibility: "link" }),
    {
      status: 403,
    },
  );
  await call(owner, {
    op: "org.policy.set",
    policy: { externalSharing: "anyone", publicLinks: true },
  });
  const settings = await boards.call(owner, {
    op: "settings",
    room,
    visibility: "link",
    linkRole: "commenter",
  });
  assert.equal(settings.settings.visibility, "link");
  // Turning public links off stops the link from admitting outsiders.
  await call(owner, { op: "org.policy.set", policy: { publicLinks: false } });
  const outsider = {
    uuid: "66666666-6666-4666-8666-666666666666",
    username: "Out",
  };
  await assert.rejects(boards.call(outsider, { op: "join", room }), {
    status: 403,
  });
  await call(owner, { op: "org.policy.set", policy: { publicLinks: true } });
  assert.equal(
    (await boards.call(outsider, { op: "join", room })).member.role,
    "commenter",
  );
  const alerts = (await call(owner, { op: "notifications.list" })).items.filter(
    (n) => n.type === "alert",
  );
  assert.ok(alerts.some((n) => n.action === "board.visibility.link"));
  // Organization-wide visibility admits members without an invitation.
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(viewer, { op: "org.join", token });
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
    orgRole: "commenter",
  });
  const member = await boards.call(viewer, { op: "join", room });
  assert.equal(member.member.role, "commenter");
  // Settings report the board's space and team, and saving other settings keeps them.
  const { space } = await call(owner, { op: "spaces.create", name: "Plans" });
  const { team } = await call(owner, { op: "teams.create", name: "Ops" });
  // Only a space and a team that exist can be chosen.
  await assert.rejects(
    boards.call(owner, { op: "settings", room, space: "sp-missing" }),
    { status: 400 },
  );
  await boards.call(owner, {
    op: "settings",
    room,
    space: space.id,
    team: team.id,
  });
  const kept = await boards.call(owner, {
    op: "settings",
    room,
    orgRole: "viewer",
  });
  assert.equal(kept.settings.space, space.id);
  assert.equal(kept.settings.team, team.id);
  const read = await boards.call(owner, { op: "settings.get", room });
  assert.equal(read.settings.orgRole, "viewer");
  assert.equal(read.settings.space, space.id);
  await assert.rejects(boards.call(viewer, { op: "settings.get", room }), {
    status: 403,
  });
  await boards.call(owner, { op: "settings", room, orgRole: "commenter" });
  const visible = await call(viewer, {
    op: "org.boards",
    scope: "organization",
  });
  assert.ok(visible.boards.some((b) => b.room === room));
});

test("deactivation, ownership transfer, archive, delete, legal hold, and retention", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const { input, room } = createInput("Offboarding");
  await boards.call(editor, input);
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  await assert.rejects(boards.call(editor, { op: "sync", room }), {
    status: 403,
  });
  // Boards never go to a guest, whose access would expire.
  const invite = await call(owner, { op: "org.invite", role: "guest" });
  await call(guest, { op: "org.join", token: invite.token });
  await assert.rejects(
    call(owner, {
      op: "org.users.transfer",
      from: editor.uuid,
      to: guest.uuid,
    }),
    { status: 400 },
  );
  assert.equal((await org.kv.get("org:board:" + room)).owner, editor.uuid);
  const moved = await call(owner, {
    op: "org.users.transfer",
    from: editor.uuid,
    to: owner.uuid,
  });
  assert.equal(moved.transferred, 1);
  assert.equal((await org.kv.get("org:board:" + room)).owner, owner.uuid);
  await boards.call(owner, { op: "archive", room });
  assert.ok((await org.kv.get("org:board:" + room)).archived);
  await boards.call(owner, { op: "hold", room, enabled: true });
  await assert.rejects(boards.call(owner, { op: "delete", room }), {
    status: 409,
  });
  await boards.call(owner, { op: "hold", room, enabled: false });
  await boards.call(owner, { op: "delete", room });
  assert.ok((await org.list(`org:ub:`)).some((r) => r.key.endsWith(room)));
  org.now = () => Date.now() + 40 * 86400_000;
  let scanned = false;
  const list = org.kv.list.bind(org.kv);
  org.kv.list = (options) => {
    if (options.pattern === "org:ub:") scanned = true;
    return list(options);
  };
  await purge(org);
  org.kv.list = list;
  assert.equal(scanned, false, "purging a board reads only its own members");
  assert.equal(await org.kv.get("org:board:" + room), null);
  assert.equal(await org.kv.get(`wb:${room}:meta`), null);
  assert.ok(!(await org.list(`org:ub:`)).some((r) => r.key.endsWith(room)));
});

test("REST paths the API description does not list are not found, and unlisted methods are not allowed", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Everything",
    scopes: [
      "audit:read",
      "users:read",
      "users:write",
      "reports:read",
      "webhooks:write",
      "boards:read",
    ],
  });
  const rest = (path, method = "GET") =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path.replace(/^\/v1\/?/, "").split("?")[0],
      null,
    );
  for (const path of [
    "/v1/reports/nonsense",
    "/v1/audit/whatever",
    "/v1/boards/a/b/c",
    "/v1/nothing",
  ])
    await assert.rejects(rest(path), { status: 404 }, path);
  for (const [path, method] of [
    // A team or webhook is changed or deleted, never read on its own.
    ["/v1/teams/does-not-exist", "GET"],
    ["/v1/webhooks/abc", "GET"],
    ["/v1/audit", "POST"],
    ["/v1/users", "DELETE"],
    ["/v1/reports", "PATCH"],
  ])
    await assert.rejects(rest(path, method), { status: 405 }, path);
  // Documented paths still answer.
  assert.ok((await (await rest("/v1/teams")).json()).teams);
  assert.ok((await (await rest("/v1/reports")).json()).users);
  assert.equal((await rest("/v1/reports/users.csv")).status, 200);
  assert.ok((await (await rest("/v1/boards/duplicates")).json()).groups);
});

test("REST API keys, scopes, audit export, reports, and OpenAPI", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await boards.call(owner, createInput("Report me").input);
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "SIEM",
    scopes: ["audit:read"],
  });
  const request = (path, method = "GET", token = key) =>
    new Request("https://w.puter.work" + path, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  const rest = (path, method, token, body) =>
    restRoute(
      org,
      boards,
      request(path, method, token),
      method || "GET",
      path.replace(/^\/(v1|scim\/v2)\/?/, "").split("?")[0],
      body,
    );
  await assert.rejects(rest("/v1/audit", "GET", null), { status: 401 });
  // Reading organization data through the API is itself audited.
  await rest("/v1/audit", "GET", key);
  const reads = (await org.list("org:audit:")).filter(
    (r) => r.value.action === "api.read",
  );
  assert.ok(reads.length >= 1);
  assert.equal(reads.at(-1).value.category, "api");
  await assert.rejects(rest("/v1/users"), { status: 403 });
  const audit = await (await rest("/v1/audit?format=ndjson")).text();
  assert.ok(
    audit
      .split("\n")
      .some((line) => JSON.parse(line).action === "board.created"),
  );
  const { key: admin } = await call(owner, {
    op: "apikeys.create",
    name: "Automation",
    scopes: ["users:read", "boards:read", "reports:read", "boards:write"],
  });
  const report = await (await rest("/v1/reports", "GET", admin)).json();
  assert.equal(report.boards.total, 1);
  const boardsList = await (
    await rest("/v1/boards?query=report", "GET", admin)
  ).json();
  assert.equal(boardsList.boards.length, 1);
  const csv = await (await rest("/v1/reports/boards.csv", "GET", admin)).text();
  // Response.text() drops the byte order mark that helps Excel read UTF-8.
  assert.ok(csv.startsWith("room,title"));
  // Query strings and bodies never choose the operation a key runs.
  const listed = await (
    await rest("/v1/users?op=apikeys.create&name=x", "GET", admin)
  ).json();
  assert.ok(Array.isArray(listed.users));
  const { key: writer } = await call(owner, {
    op: "apikeys.create",
    name: "Teams",
    scopes: ["users:write"],
  });
  const { team } = await call(owner, { op: "teams.create", name: "Ops" });
  const patched = await (
    await rest("/v1/teams/" + team.id, "PATCH", writer, {
      op: "apikeys.create",
      name: "Escalated",
      scopes: ["scim"],
    })
  ).json();
  assert.equal(patched.team.id, team.id);
  assert.equal(patched.key, undefined);
  assert.equal((await call(owner, { op: "apikeys.list" })).keys.length, 3);
  // Webhook deliveries carry audit events, so subscribing needs audit:read.
  const hookBody = { url: "https://hooks.example.ca/x" };
  for (const scopes of [["webhooks:write"], ["webhooks:write", "audit:read"]]) {
    const { key: hooks } = await call(owner, {
      op: "apikeys.create",
      scopes,
    });
    const created = rest("/v1/webhooks", "POST", hooks, hookBody);
    if (scopes.length === 1) await assert.rejects(created, { status: 403 });
    else assert.equal((await created).status, 201);
  }
  const spec = openAPI("https://w.puter.work");
  assert.ok(spec.paths["/scim/v2/Users"]);
  // Every templated path declares its parameters, as OpenAPI 3.1 requires,
  // and operations describe their bodies and the statuses they answer.
  for (const [path, operations] of Object.entries(spec.paths)) {
    const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    assert.deepEqual(
      (operations.parameters || []).map((p) => [p.name, p.in, p.required]),
      names.map((name) => [name, "path", true]),
      path,
    );
    for (const [method, op] of Object.entries(operations)) {
      if (method === "parameters") continue;
      if (["post", "put", "patch"].includes(method))
        assert.ok(op.requestBody, `${method} ${path}`);
    }
  }
  assert.ok(spec.paths["/v1/teams"].post.responses[201]);
  assert.ok(spec.paths["/scim/v2/Users/{id}"].delete.responses[204]);
  assert.ok(spec.paths["/v1/teams/{id}"].delete.responses[200]);
  // REST errors are described with the body they carry.
  assert.deepEqual(spec.components.schemas.Error.required, ["error"]);
  for (const status of [400, 401, 403, 404])
    assert.equal(
      spec.paths["/v1/boards/{room}"].patch.responses[status].content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/Error",
    );
  assert.equal(
    spec.paths["/scim/v2/Users"].get.responses[404],
    undefined,
    "SCIM errors keep SCIM's own format",
  );
  const keys = await call(owner, { op: "apikeys.list" });
  await call(owner, { op: "apikeys.revoke", id: keys.keys[0].id });
  assert.equal((await call(owner, { op: "apikeys.list" })).keys.length, 4);
});

const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

test("SCIM provisioning links pending users by verified email and deactivates them", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Google",
    scopes: ["scim"],
  });
  const scim = (path, method = "GET", body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path.split("?")[0],
      body,
    );
  const created = await (
    await scim("Users", "POST", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "bob@fabrikam.test",
      name: { givenName: "Bob", familyName: "B" },
      externalId: "g-123",
      active: true,
    })
  ).json();
  assert.equal(created.active, true);
  assert.equal(
    created["urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User"]
      .linked,
    false,
  );
  const found = await (
    await scim("Users?filter=userName%20eq%20%22bob@fabrikam.test%22")
  ).json();
  assert.equal(found.totalResults, 1);
  await assert.rejects(
    scim("Users", "POST", { userName: "bob@fabrikam.test" }),
    {
      status: 409,
      scimType: "uniqueness",
    },
  );
  await assert.rejects(scim("Users?filter=userName%20sw%20%22b%22"), {
    status: 400,
    scimType: "invalidFilter",
  });
  const group = await (
    await scim("Groups", "POST", {
      displayName: "Design",
      members: [{ value: created.id }],
    })
  ).json();
  // Bob signs in with Puter and verifies the address.
  await call(editor, { op: "email.start", email: "bob@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  await assert.rejects(
    call(editor, {
      op: "email.confirm",
      code: "000000" === code ? "111111" : "000000",
    }),
    {
      status: 400,
    },
  );
  // Parallel guesses share the five-attempt limit.
  const wrong = code === "000000" ? "111111" : "000000";
  const guesses = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      call(editor, { op: "email.confirm", code: wrong }),
    ),
  );
  assert.equal(
    guesses.filter((g) => g.reason?.status === 429).length,
    6,
    "only five attempts are evaluated",
  );
  await assert.rejects(call(editor, { op: "email.confirm", code }), {
    status: 429,
  });
  await call(editor, { op: "email.start", email: "bob@fabrikam.test" });
  const fresh = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  const confirmed = await call(editor, { op: "email.confirm", code: fresh });
  assert.equal(confirmed.user.role, "member");
  assert.deepEqual(confirmed.user.teams, [group.id]);
  const linked = await (await scim("Users/" + created.id)).json();
  assert.equal(
    linked["urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User"]
      .puterUsername,
    "Bob",
  );
  await scim("Users/" + created.id, "PATCH", {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    // Attributes Entra maps by default are ignored, not refused.
    Operations: [
      { op: "Replace", path: "title", value: "Former designer" },
      { op: "Add", path: 'phoneNumbers[type eq "work"].value', value: "1" },
      { op: "Replace", path: "active", value: "False" },
    ],
  });
  assert.equal((await org.user(editor.uuid)).status, "deactivated");
  // Entra's compliant mode replaces names without a path, with dotted and
  // schema-qualified keys; the RFC form names the whole name object.
  const named = async (Operations) =>
    (
      await (
        await scim("Users/" + created.id, "PATCH", {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations,
        })
      ).json()
    ).name;
  assert.deepEqual(
    await named([
      {
        op: "replace",
        value: {
          displayName: "Bob Builder",
          "name.givenName": "Robert",
          "urn:ietf:params:scim:schemas:core:2.0:User:name.familyName":
            "Builder",
        },
      },
    ]),
    { givenName: "Robert", familyName: "Builder", formatted: "Robert Builder" },
  );
  assert.equal(
    (
      await named([
        { op: "replace", path: "name", value: { givenName: "Bobby" } },
      ])
    ).givenName,
    "Bobby",
  );
  await scim("Groups/" + group.id, "PATCH", {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "remove", path: `members[value eq "${created.id}"]` }],
  });
  assert.deepEqual((await org.kv.get("org:team:" + group.id)).members, []);
  const config = await (await scim("ServiceProviderConfig")).json();
  assert.equal(config.patch.supported, true);
  // Schemas describe each attribute fully (RFC 7643 section 7).
  const schemas = await (await scim("Schemas")).json();
  assert.equal(schemas.totalResults, 3);
  const userSchema = await (
    await scim("Schemas/urn:ietf:params:scim:schemas:core:2.0:User")
  ).json();
  const userName = userSchema.attributes.find((a) => a.name === "userName");
  assert.equal(userName.type, "string");
  assert.equal(userName.required, true);
  assert.equal(userName.uniqueness, "server");
  assert.ok(userSchema.attributes.every((a) => a.type && a.mutability));
  // A deleted account stays deactivated but is gone for the provider,
  // which can provision the same address again.
  await scim("Users/" + created.id, "DELETE");
  assert.equal((await org.user(editor.uuid)).status, "deactivated");
  await assert.rejects(scim("Users/" + created.id), { status: 404 });
  const listed = await (
    await scim("Users?filter=userName%20eq%20%22bob@fabrikam.test%22")
  ).json();
  assert.equal(listed.totalResults, 0);
  const again = await scim("Users", "POST", {
    userName: "bob@fabrikam.test",
    active: true,
  });
  assert.equal(again.status, 201);
  assert.equal(
    again.headers.get("location"),
    `https://w.puter.work/scim/v2/Users/${created.id}`,
  );
  assert.equal((await org.user(editor.uuid)).status, "active");
  // Deleted accounts leave their groups.
  const dan0 = await (
    await scim("Users", "POST", { userName: "dan0@fabrikam.test" })
  ).json();
  const carol = await (
    await scim("Users", "POST", { userName: "carol@fabrikam.test" })
  ).json();
  const team = await (
    await scim("Groups", "POST", {
      displayName: "Research",
      members: [{ value: carol.id }],
    })
  ).json();
  assert.equal(team.members.length, 1);
  const identity = await (
    await scim(`Groups/${team.id}?excludedAttributes=members`)
  ).json();
  assert.equal(identity.displayName, "Research");
  assert.equal(identity.members, undefined);
  // Entra checks membership with a members.value filter.
  const byMember = await (
    await scim(
      `Groups?filter=${encodeURIComponent(`id eq "${team.id}" and members.value eq "${carol.id}"`)}&excludedAttributes=members`,
    )
  ).json();
  assert.equal(byMember.totalResults, 1);
  const notMember = await (
    await scim(
      `Groups?filter=${encodeURIComponent(`members.value eq "${dan0.id}"`)}`,
    )
  ).json();
  assert.equal(notMember.totalResults, 0);
  // A patch without a path changes each attribute it carries.
  const patched = await (
    await scim("Groups/" + team.id, "PATCH", {
      schemas: [PATCH_OP],
      Operations: [
        {
          op: "replace",
          value: {
            displayName: "Research team",
            externalId: "ext-9",
            members: [{ value: carol.id }, { value: dan0.id }],
          },
        },
      ],
    })
  ).json();
  assert.equal(patched.displayName, "Research team");
  assert.equal(patched.externalId, "ext-9");
  assert.equal(patched.members.length, 2);
  await scim("Groups/" + team.id, "PATCH", {
    schemas: [PATCH_OP],
    Operations: [{ op: "remove", path: `members[value eq "${dan0.id}"]` }],
  });
  await scim("Users/" + carol.id, "DELETE");
  assert.deepEqual((await org.kv.get("org:team:" + team.id)).members, []);
  // Removing a role never grants it.
  const dan = await (
    await scim("Users", "POST", { userName: "dan@fabrikam.test" })
  ).json();
  const roleOf = async (Operations) =>
    (
      await (
        await scim("Users/" + dan.id, "PATCH", {
          schemas: [PATCH_OP],
          Operations,
        })
      ).json()
    ).roles[0].value;
  assert.equal(
    await roleOf([
      { op: "remove", path: "roles", value: [{ value: "guest" }] },
    ]),
    "member",
  );
  assert.equal(
    await roleOf([{ op: "add", path: "roles", value: [{ value: "guest" }] }]),
    "guest",
  );
  assert.equal(
    await roleOf([
      { op: "remove", path: "roles", value: [{ value: "member" }] },
    ]),
    "guest",
  );
  assert.equal(
    await roleOf([{ op: "remove", path: 'roles[value eq "guest"]' }]),
    "member",
  );
  // Of the extension, only the role changes it.
  const EXT = "urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User";
  assert.equal(
    await roleOf([{ op: "replace", path: `${EXT}:role`, value: "guest" }]),
    "guest",
  );
  assert.equal(
    await roleOf([{ op: "remove", path: `${EXT}:license` }]),
    "guest",
  );
  assert.equal(
    await roleOf([{ op: "replace", path: EXT, value: { role: "member" } }]),
    "member",
  );
  // Paths may name the core schema in full.
  const qualified = await (
    await scim("Users/" + dan.id, "PATCH", {
      schemas: [PATCH_OP],
      Operations: [
        {
          op: "replace",
          path: "urn:ietf:params:scim:schemas:core:2.0:User:displayName",
          value: "Dan D",
        },
      ],
    })
  ).json();
  assert.equal(qualified.displayName, "Dan D");
  // Provisioning an active account as inactive ends its sessions.
  const reprovisioned = await again.json();
  await scim("Users/" + reprovisioned.id, "DELETE");
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "active",
  });
  const revoked = [];
  const revoke = boards.revokeSessions;
  boards.revokeSessions = async (uuid) => {
    revoked.push(uuid);
    return revoke.call(boards, uuid);
  };
  await scim("Users", "POST", { userName: "bob@fabrikam.test", active: false });
  boards.revokeSessions = revoke;
  assert.equal((await org.user(editor.uuid)).status, "deactivated");
  assert.deepEqual(revoked, [editor.uuid]);
  // Lists page with startIndex and count, and read unusable values as the
  // defaults.
  const groups = await (await scim("Groups")).json();
  assert.equal(groups.totalResults, 2);
  const second = await (await scim("Groups?startIndex=2&count=1")).json();
  assert.equal(second.startIndex, 2);
  assert.equal(second.itemsPerPage, 1);
  assert.equal(second.Resources[0].id, groups.Resources[1].id);
  const users = await (await scim("Users?count=abc")).json();
  assert.equal(users.itemsPerPage, users.totalResults);
  assert.equal(users.Resources.length, users.totalResults);
  assert.deepEqual(parseFilter('userName eq "a@b.ca" and externalId eq "x"'), [
    { attr: "username", value: "a@b.ca" },
    { attr: "externalid", value: "x" },
  ]);
  // "and" inside a quoted value belongs to the value.
  assert.deepEqual(parseFilter('displayName eq "Research and Development"'), [
    { attr: "displayname", value: "Research and Development" },
  ]);
  assert.throws(() => parseFilter('userName eq "a" and'), { status: 400 });
});

test("removing a SCIM group member the worker does not know keeps the others", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Entra",
    scopes: ["scim"],
  });
  const scim = async (path, method = "GET", body) => {
    const res = await restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
    return res.status === 204 ? null : res.json();
  };
  const ann = await scim("Users", "POST", { userName: "ann@fabrikam.test" });
  const ben = await scim("Users", "POST", { userName: "ben@fabrikam.test" });
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    members: [{ value: ann.id }, { value: ben.id }],
  });
  // The provider deletes Ben, then removes him from the group as well.
  await scim("Users/" + ben.id, "DELETE");
  for (const value of [[{ value: ben.id }], { value: "never-provisioned" }])
    await scim("Groups/" + group.id, "PATCH", {
      schemas: [PATCH_OP],
      Operations: [{ op: "remove", path: "members", value }],
    });
  assert.deepEqual((await org.kv.get("org:team:" + group.id)).members, [
    ann.id,
  ]);
  // Without a value, a removal still empties the group.
  await scim("Groups/" + group.id, "PATCH", {
    schemas: [PATCH_OP],
    Operations: [{ op: "remove", path: "members" }],
  });
  assert.deepEqual((await org.kv.get("org:team:" + group.id)).members, []);
});

test("domain capture joins verified users; SIEM and webhooks deliver signed events", async () => {
  const { boards, call, org, sent, fetched } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      domainCapture: true,
      integrations: { webhooks: { enabled: true } },
      siem: {
        mode: "sentinel",
        sentinel: {
          tenantId: "11111111-2222-3333-4444-555555555555",
          clientId: "11111111-2222-3333-4444-666666666666",
          endpoint: "https://wb-abc.canadacentral-1.ingest.monitor.azure.com",
          dcrId: "dcr-0123456789abcdef0123456789abcdef",
          stream: "Custom-WhiteboardAudit",
        },
      },
    },
    secrets: { sentinel: "entra-secret" },
  });
  const { webhook, secret } = await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/wb",
    events: ["user"],
  });
  await call(viewer, { op: "email.start", email: "cam@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  const result = await call(viewer, { op: "email.confirm", code });
  assert.equal(result.user.role, "member");
  await org.flush();
  const ingest = fetched.find((f) => f.url.includes("/dataCollectionRules/"));
  assert.ok(ingest, "audit events reach Sentinel");
  assert.equal(ingest.options.headers.Authorization, "Bearer entra-token");
  const records = JSON.parse(ingest.options.body);
  assert.ok(records.some((r) => r.Action === "email.verification.sent"));
  const hook = fetched.find((f) => f.url === webhook.url);
  assert.ok(hook, "user.joined reaches the webhook");
  assert.equal(
    hook.options.headers["X-Whiteboard-Signature"],
    "sha256=" + (await hmac(secret, hook.options.body)),
  );
  assert.equal(JSON.parse(hook.options.body).event, "user.joined");
  assert.equal(
    siemRecord({ id: "x", time: "t", actor: {}, target: {} }).EventId,
    "x",
  );
  assert.ok(toCSV([{ a: 'x,"y"' }], ["a"]).includes('"x,""y"""'));
});

test("content activity, search, duplicates, library governance, and AI policy", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Journey", [
    item("note", 0, 0, { text: "Service blueprint for memberships" }),
  ]);
  await boards.call(owner, input);
  await boards.call(owner, createInput("Journey (copy)").input);
  await commit(boards, owner, room, (b) =>
    b.items.push(item("table", 0, 300, { cells: [["a"]] })),
  );
  const activity = await call(owner, { op: "org.board.activity", room });
  assert.ok(activity.entries.some((e) => e.action === "board.content.updated"));
  const found = await call(owner, {
    op: "org.boards",
    scope: "mine",
    query: "memberships",
    content: true,
  });
  assert.deepEqual(
    found.boards.map((b) => b.room),
    [room],
  );
  const typed = await call(owner, {
    op: "org.boards",
    scope: "all",
    type: "table",
  });
  assert.deepEqual(
    typed.boards.map((b) => b.room),
    [room],
  );
  const duplicates = await call(owner, { op: "org.boards.duplicates" });
  assert.ok(duplicates.groups.some((g) => g.reason === "same title"));
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  await call(viewer, { op: "org.join", token });
  const template = JSON.stringify(board("Team template"));
  // Content that is not a valid board is refused for good.
  await assert.rejects(
    call(editor, {
      op: "library.submit",
      name: "Broken",
      board: JSON.stringify({ ...board("Broken"), items: [{ id: "x" }] }),
    }),
    { status: 422 },
  );
  const submitted = await call(editor, {
    op: "library.submit",
    name: "Retro",
    board: template,
  });
  assert.equal(submitted.item.status, "pending");
  assert.equal((await call(viewer, { op: "library.list" })).items.length, 0);
  // The person who shared an item, and administrators, may remove it.
  assert.equal(
    (await call(editor, { op: "library.list" })).items[0].canRemove,
    true,
  );
  await call(owner, { op: "library.approve", id: submitted.item.id });
  assert.equal(
    (await call(viewer, { op: "library.list" })).items[0].canRemove,
    false,
  );
  assert.equal(
    (await call(owner, { op: "library.list" })).items[0].canRemove,
    true,
  );
  const item0 = await call(viewer, {
    op: "library.get",
    id: submitted.item.id,
  });
  assert.equal(JSON.parse(item0.board).title, "Team template");
  await call(owner, {
    op: "org.policy.set",
    policy: { ai: { enabled: false } },
  });
  await assert.rejects(
    call(editor, { op: "org.ai", task: "summarize", prompt: "Hi" }),
    { status: 403 },
  );
  await call(owner, {
    op: "org.policy.set",
    policy: { ai: { enabled: true } },
  });
  org.puter.ai = { chat: async () => ({ message: { content: "Summary" } }) };
  assert.equal(
    (await call(editor, { op: "org.ai", task: "summarize", prompt: "Hi" }))
      .text,
    "Summary",
  );
  const report = await call(owner, { op: "org.reports" });
  assert.equal(report.boards.total, 2);
});

test("content search finds a large board's newest text, alt text, links and tags", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const notes = Array.from({ length: 400 }, (_, n) =>
    item("note", n * 10, 0, {
      text: `Sticky ${n}: discussion point about the onboarding flow`,
    }),
  );
  const { input, room } = createInput("Workshop", notes);
  await boards.call(owner, input);
  await commit(boards, owner, room, (b) => {
    b.tags = [{ id: "tag1", name: "Reconciliation", color: "#f6e7a4" }];
    b.items.push(
      item("note", 0, 500, {
        text: "Accessibility audit owner: Priya",
        tagIds: ["tag1"],
      }),
      item("pen", 0, 700, {
        points: [
          [0, 0],
          [20, 10],
        ],
        alt: "Floor plan of the Ottawa office",
      }),
      item("link", 300, 700, { url: "https://northwind.test/benefits" }),
    );
  });
  const search = async (query) =>
    (
      await call(owner, {
        op: "org.boards",
        scope: "all",
        query,
        content: true,
      })
    ).boards.map((b) => b.room);
  for (const query of [
    "Sticky 10:",
    "Sticky 399",
    "Priya",
    "Ottawa office",
    "northwind.test/benefits",
    "reconciliation",
  ])
    assert.deepEqual(await search(query), [room], query);
});

test("organization search ignores accents and how they are encoded", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Rétrospective de l’équipe", [
    // Typed on a keyboard that sends a letter and its accent apart.
    item("note", 0, 0, { text: "Prochaines e\u0301tapes au cafe\u0301" }),
  ]);
  await boards.call(owner, input);
  await commit(boards, owner, room, (b) => (b.items[0].x += 10));
  const search = async (query) =>
    (
      await call(owner, {
        op: "org.boards",
        scope: "all",
        query,
        content: true,
      })
    ).boards.map((b) => b.room);
  for (const query of [
    "equipe",
    "ÉQUIPE",
    "retrospective",
    "étapes",
    "etapes",
    "caf\u00e9",
  ])
    assert.deepEqual(await search(query), [room], query);
});

test("the worker refuses Miro migrations the organization has turned off", async () => {
  const { boards, call } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { miro: { enabled: false } } },
  });
  const { input, room } = createInput("From Miro");
  await boards.call(owner, input);
  await assert.rejects(
    call(owner, {
      op: "migration.apply",
      room,
      members: [{ email: "bob@fabrikam.test", role: "owner" }],
      source: { boardId: "uXjVabc" },
    }),
    { status: 403, message: "Your organization has turned off Miro imports." },
  );
});

test("migrations preserve owners and roles by email, activating on verification", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  const { input, room } = createInput("From Miro");
  await boards.call(owner, input);
  const result = await call(owner, {
    op: "migration.apply",
    room,
    members: [
      { email: "bob@fabrikam.test", role: "owner", name: "Bob" },
      { email: "cam@fabrikam.test", role: "commenter" },
      { email: "partner@example.org", role: "editor", guest: true },
      { role: "viewer" },
    ],
    source: {
      boardId: "uXjVabc",
      viewLink: "https://miro.com/app/board/uXjVabc=/",
    },
  });
  assert.equal(result.applied.length, 3);
  assert.equal(result.skipped.length, 1);
  const registered = await org.kv.get("org:board:" + room);
  assert.match(registered.owner, /^pending-/);
  assert.equal(registered.source, "miro");
  assert.equal(registered.guestCount, 1);
  await call(editor, { op: "email.start", email: "bob@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  await call(editor, { op: "email.confirm", code });
  const joined = await boards.call(editor, { op: "join", room });
  assert.equal(joined.member.role, "owner");
  assert.equal((await org.kv.get("org:board:" + room)).owner, editor.uuid);
  const mine = await call(editor, { op: "org.boards", scope: "mine" });
  assert.deepEqual(
    mine.boards.map((b) => b.room),
    [room],
  );
});

test("reports include time spent and anonymous ease-of-use feedback", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await org.recordTime(45_000, { flush: true });
  await assert.rejects(call(owner, { op: "feedback.submit", ease: 9 }), {
    status: 400,
  });
  await call(owner, { op: "feedback.submit", ease: 4, comment: "Fast" });
  await call(owner, { op: "feedback.submit", ease: 2 });
  const report = await call(owner, { op: "org.reports", days: 7 });
  assert.equal(report.feedback.responses, 2);
  assert.equal(report.feedback.averageEase, 3);
  // One person's submissions are limited within an hour.
  for (let n = 0; n < 8; n++)
    await call(owner, { op: "feedback.submit", ease: 3 });
  await assert.rejects(call(owner, { op: "feedback.submit", ease: 3 }), {
    status: 429,
  });
  assert.equal(
    (await call(owner, { op: "org.reports", days: 7 })).feedback.responses,
    10,
  );
  assert.deepEqual(report.feedback.distribution, [0, 1, 0, 1, 0]);
  assert.equal(report.feedback.recent[0].comment, "Fast");
  assert.equal(report.feedback.recent[0].uuid, undefined);
  assert.equal(report.usage.minutesPerDay.length, 7);
  // The account owner counts as active once it has used the organization.
  await org.touch(owner);
  const refreshed = await call(owner, { op: "org.reports", days: 7 });
  assert.equal(refreshed.users.activeLast30Days, 1);
  assert.ok(boards);
});

test("verifying a provisioned address keeps a deactivation and a higher role", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await org.saveUser({
    uuid: editor.uuid,
    username: "Bob",
    role: "admin",
    status: "active",
    teams: [],
  });
  // A migration or SCIM leaves a pending member record for another address.
  await boards.org.saveUser({
    uuid: "55555555-5555-4555-8555-555555555555",
    email: "bob.alt@fabrikam.test",
    role: "member",
    status: "pending",
    teams: [],
  });
  await org.kv.set(
    "org:email:" + (await hash("bob.alt@fabrikam.test")),
    "55555555-5555-4555-8555-555555555555",
  );
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  await call(editor, { op: "email.start", email: "bob.alt@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  await call(editor, { op: "email.confirm", code });
  org.forgetUser(editor.uuid);
  const user = await org.user(editor.uuid);
  assert.equal(user.status, "deactivated");
  assert.equal(user.role, "admin");
  assert.equal(await org.role(editor), null);
});

test("a guest who verifies a provisioned member address gets a full license", async () => {
  const { call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await org.saveUser({
    uuid: editor.uuid,
    username: "Bob",
    role: "guest",
    license: "guest",
    status: "active",
    teams: [],
  });
  await org.saveUser({
    uuid: "55555555-5555-4555-8555-555555555555",
    email: "bob@fabrikam.test",
    role: "member",
    status: "pending",
    teams: [],
  });
  await org.kv.set(
    "org:email:" + (await hash("bob@fabrikam.test")),
    "55555555-5555-4555-8555-555555555555",
  );
  await call(editor, { op: "email.start", email: "bob@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  await call(editor, { op: "email.confirm", code });
  org.forgetUser(editor.uuid);
  const user = await org.user(editor.uuid);
  assert.equal(user.role, "member");
  assert.equal(user.license, "full");
  const { users } = await call(owner, { op: "org.users.list" });
  assert.equal(users.find((u) => u.uuid === editor.uuid).license, "full");
});

test("only the account owner changes an administrator's status", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const user of [editor, viewer])
    await org.saveUser({
      uuid: user.uuid,
      username: user.username,
      role: "admin",
      status: "active",
      teams: [],
    });
  await assert.rejects(
    call(editor, {
      op: "org.users.update",
      uuid: viewer.uuid,
      status: "deactivated",
    }),
    { status: 403 },
  );
  const same = await call(editor, {
    op: "org.users.update",
    uuid: viewer.uuid,
    status: "active",
  });
  assert.equal(same.user.status, "active");
  const done = await call(owner, {
    op: "org.users.update",
    uuid: viewer.uuid,
    status: "deactivated",
  });
  assert.equal(done.user.status, "deactivated");
});

test("organization directory data is limited to members", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Budget secretword");
  await boards.call(owner, input);
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  const { token } = await call(owner, { op: "org.invite", role: "guest" });
  await call(guest, { op: "org.join", token });
  for (const user of [guest, viewer]) {
    for (const op of ["teams.list", "spaces.list", "library.list"])
      await assert.rejects(call(user, { op }), { status: 403 });
    const found = await call(user, {
      op: "org.boards",
      scope: "organization",
      query: "secretword",
      content: true,
    });
    assert.equal(found.boards.length, 0);
  }
  await assert.rejects(call(viewer, { op: "feedback.submit", ease: 3 }), {
    status: 403,
  });
  assert.deepEqual(await call(guest, { op: "feedback.submit", ease: 3 }), {
    ok: true,
  });
  assert.ok(Array.isArray((await call(owner, { op: "teams.list" })).teams));
});

test("verifying an email does not make a stranger an organization guest", async () => {
  const { call, org } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  await assert.rejects(
    call(viewer, { op: "email.start", email: "eve@gmail.com" }),
    { status: 403 },
  );
  assert.equal(await org.user(viewer.uuid), null);
  assert.equal(await org.role(viewer), null);
  await assert.rejects(call(viewer, { op: "feedback.submit", ease: 1 }), {
    status: 403,
  });
});

test("deactivated people get no notifications or organization data", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  assert.equal(
    await org.notify(editor.uuid, { type: "mention", text: "secret" }),
    undefined,
  );
  assert.equal((await org.list(`org:notif:${editor.uuid}:`)).length, 0);
  for (const op of ["notifications.list", "org.boards", "library.list"])
    await assert.rejects(call(editor, { op }), { status: 403 });
  assert.equal((await call(editor, { op: "org.info" })).role, null);
});

test("recording activity never rewrites a changed user record", async () => {
  const { call, org, env } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token });
  // Another instance demotes and deactivates the cached administrator.
  await org.kv.set("org:user:" + editor.uuid, {
    ...(await org.kv.get("org:user:" + editor.uuid)),
    role: "member",
    status: "deactivated",
  });
  await org.touch(editor);
  const stored = await org.kv.get("org:user:" + editor.uuid);
  assert.equal(stored.role, "member");
  assert.equal(stored.status, "deactivated");
  const { users } = await call(owner, { op: "org.users.list" });
  assert.equal(users.find((u) => u.uuid === editor.uuid).lastActive, env.now);
});

test("a policy change with an invalid secret saves nothing", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const secrets of [{ bogus: "x" }, { slack: "https://evil.example/" }])
    await assert.rejects(
      call(owner, {
        op: "org.policy.set",
        policy: { publicLinks: true },
        secrets,
      }),
      { status: 400 },
    );
  assert.equal((await org.policy()).publicLinks, false);
  assert.equal(await org.secret("slack"), null);
});

test("Jira status reads only the organization's project", async () => {
  const { boards, call, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  assert.throws(
    () =>
      mergePolicy(normalizePolicy(), {
        integrations: { jira: { project: 'WB" OR project is not EMPTY' } },
      }),
    { status: 400 },
  );
  await call(owner, {
    op: "org.policy.set",
    policy: {
      integrations: {
        jira: {
          enabled: true,
          site: "fabrikam.atlassian.net",
          email: "svc@fabrikam.test",
          project: "wb",
        },
      },
    },
    secrets: { jira: "token" },
  });
  const { input, room } = createInput("Plan");
  await boards.call(owner, input);
  await call(owner, { op: "org.jira.status", room, keys: ["HR-7", "WB-1"] });
  const url = new URL(fetched.at(-1).url);
  assert.equal(
    url.searchParams.get("jql"),
    'project = "WB" AND key in (HR-7,WB-1)',
  );
  // Jira answers in pages of 50 unless asked for more; every page is read.
  const org = boards.org;
  const keys = Array.from({ length: 100 }, (_, n) => `WB-${n + 1}`);
  const pages = [];
  org.fetcher = async (target) => {
    const u = new URL(target);
    pages.push(u.searchParams.get("maxResults"));
    const from = Number(u.searchParams.get("nextPageToken") || 0);
    return Response.json({
      issues: keys.slice(from, from + 50).map((key) => ({
        key,
        fields: { status: { name: "Done" } },
      })),
      ...(from + 50 < keys.length ? { nextPageToken: String(from + 50) } : {}),
    });
  };
  const { issues } = await call(owner, { op: "org.jira.status", room, keys });
  assert.equal(issues.length, 100);
  assert.deepEqual(pages, ["100", "100"]);
});

test("a deactivated account cannot join a board by invitation", async () => {
  const { boards, call, org, env } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await assert.rejects(
    join({ service: boards }, editor, { room, token: invite.token }),
    { status: 403, message: "Your organization account is deactivated." },
  );
  assert.equal(await org.kv.get(`wb:${room}:member:${editor.uuid}`), null);
  assert.equal((await org.kv.get(`org:board:${room}`)).memberCount, 1);
  assert.ok(
    ![...env.data.values()].some(
      (v) =>
        v?.action === "board.guest.joined" ||
        (v?.action === "board.joined" && v.actor?.uuid === editor.uuid),
    ),
  );
});

test("a refused settings change leaves the board's visibility as it was", async () => {
  const { boards, call, org, env } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  await assert.rejects(
    boards.call(owner, {
      op: "settings",
      room,
      visibility: "organization",
      team: "bad team!",
    }),
    { status: 400 },
  );
  assert.equal(
    (await org.kv.get(`wb:${room}:meta`)).visibility ?? "private",
    "private",
  );
  assert.equal((await org.kv.get(`org:board:${room}`)).visibility, "private");
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  assert.equal(
    (await org.kv.get(`wb:${room}:meta`)).visibility,
    "organization",
  );
  assert.equal(
    (await org.kv.get(`org:board:${room}`)).visibility,
    "organization",
  );
  assert.ok(
    [...env.data.values()].some(
      (v) => v?.action === "board.visibility.changed",
    ),
  );
});

test("board guests cannot use the organization's Jira connection", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      externalSharing: "guests",
      integrations: {
        jira: {
          enabled: true,
          site: "fabrikam.atlassian.net",
          email: "svc@fabrikam.test",
          project: "WB",
        },
      },
    },
    secrets: { jira: "token" },
  });
  const { input, room } = createInput("Plan");
  await boards.call(owner, input);
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, guest, { room, token: invite.token });
  const fetched = [];
  org.fetcher = async (url) => {
    fetched.push(url);
    return Response.json({ issues: [], key: "WB-1" });
  };
  for (const request of [
    { op: "org.jira.status", room, keys: ["WB-1"] },
    { op: "org.jira.create", room, issues: [{ item: "i1", summary: "T" }] },
  ])
    await assert.rejects(call(guest, request), {
      status: 403,
      message: "Jira sync is available to organization members.",
    });
  assert.equal(fetched.length, 0);
  // A reply without an issue key is not a created issue.
  org.fetcher = async () => Response.json({});
  const { created } = await call(owner, {
    op: "org.jira.create",
    room,
    issues: [{ item: "i1", summary: "T" }],
  });
  assert.deepEqual(created, [
    { item: "i1", error: "Jira did not accept the request." },
  ]);
  // Jira's own reason for a refusal is passed on.
  org.fetcher = async () =>
    Response.json(
      {
        errorMessages: [],
        errors: { issuetype: "Specify a valid issue type" },
      },
      { status: 400 },
    );
  const refused = await call(owner, {
    op: "org.jira.create",
    room,
    issues: [{ item: "i2", summary: "T" }],
  });
  assert.deepEqual(refused.created, [
    {
      item: "i2",
      error: "Jira did not accept the request.",
      status: 400,
      detail: "Specify a valid issue type",
    },
  ]);
  // Credentials Jira refuses are named as the cause.
  org.fetcher = async () =>
    Response.json({ errorMessages: ["Unauthorized"] }, { status: 401 });
  const denied = await call(owner, {
    op: "org.jira.create",
    room,
    issues: [{ item: "i3", summary: "T" }],
  });
  assert.match(denied.created[0].error, /refused the integration account/);
});

test("sending the same task to Jira from two places at once creates one issue", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      integrations: {
        jira: {
          enabled: true,
          site: "fabrikam.atlassian.net",
          email: "svc@fabrikam.test",
          project: "WB",
        },
      },
    },
    secrets: { jira: "token" },
  });
  const { input, room } = createInput("Plan");
  await boards.call(owner, input);
  let made = 0;
  org.fetcher = async () => {
    made++;
    const key = `WB-${made}`;
    await new Promise((r) => setTimeout(r, 100));
    return Response.json({ key });
  };
  const send = () =>
    call(owner, {
      op: "org.jira.create",
      room,
      issues: [{ item: "task-1", summary: "Build" }],
    });
  const [first, second] = await Promise.all([send(), send()]);
  assert.equal(made, 1);
  assert.equal(first.created[0].key, "WB-1");
  assert.equal(second.created[0].key, "WB-1");
});

test("issues Jira already created are returned when a later one fails", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      integrations: {
        jira: {
          enabled: true,
          site: "fabrikam.atlassian.net",
          email: "svc@fabrikam.test",
          project: "WB",
        },
      },
    },
    secrets: { jira: "token" },
  });
  const { input, room } = createInput("Plan");
  await boards.call(owner, input);
  let n = 0;
  org.fetcher = async () => {
    n++;
    if (n === 3)
      throw Object.assign(Error("timed out"), { name: "TimeoutError" });
    if (n === 4) return Response.json({ errors: {} }, { status: 400 });
    return Response.json({ key: `WB-${n}` });
  };
  const { created } = await call(owner, {
    op: "org.jira.create",
    room,
    issues: [1, 2, 3, 4, 5].map((k) => ({ item: `i${k}`, summary: `T${k}` })),
  });
  assert.deepEqual(
    created.map((c) => c.key || c.error),
    [
      "WB-1",
      "WB-2",
      "Could not reach Jira.",
      "Jira did not accept the request.",
      "WB-5",
    ],
  );
  assert.equal(created[3].status, 400);
});

test("API keys: use never rewrites them and expiry must be valid", async () => {
  const { call, org, env } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { key, record } = await call(owner, {
    op: "apikeys.create",
    name: "IdP",
    scopes: ["scim"],
  });
  const writes = [];
  const set = org.kv.set.bind(org.kv);
  org.kv.set = (k, ...rest) => (writes.push(k), set(k, ...rest));
  await apiKey(org, key, "scim");
  org.kv.set = set;
  assert.ok(writes.every((k) => !k.startsWith("org:apikey:")));
  const { keys } = await call(owner, { op: "apikeys.list" });
  assert.equal(keys.find((k) => k.id === record.id).lastUsed, env.now);
  await call(owner, { op: "apikeys.revoke", id: record.id });
  await assert.rejects(apiKey(org, key, "scim"), { status: 401 });
  for (const days of ["30d", -5, 0, 1.5])
    await assert.rejects(
      call(owner, { op: "apikeys.create", scopes: ["scim"], days }),
      { status: 400 },
    );
  const capped = await call(owner, {
    op: "apikeys.create",
    scopes: ["scim"],
    days: 1000,
  });
  assert.equal(capped.record.expires, env.now + 730 * 86_400_000);
});

test("refused API keys are audited without the key, a bounded number at a time", async () => {
  const { call, org, env } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { key, record } = await call(owner, {
    op: "apikeys.create",
    name: "Reports",
    scopes: ["reports:read"],
    days: 1,
  });
  await assert.rejects(apiKey(org, undefined, "scim"), { status: 401 });
  const made = "wbk_" + "0".repeat(64);
  for (let n = 0; n < 30; n++)
    await assert.rejects(apiKey(org, made, "audit:read"), { status: 401 });
  await assert.rejects(apiKey(org, key, "scim"), { status: 403 });
  const failed = async () =>
    (await call(owner, { op: "org.audit" })).entries.filter(
      (e) => e.action === "auth.apikey.failed",
    );
  const entries = await failed();
  assert.ok(entries.every((e) => e.category === "security"));
  assert.ok(!JSON.stringify(entries).includes(made));
  assert.ok(!JSON.stringify(entries).includes(key));
  // Made-up keys stop being recorded at the limit; known ones still are.
  const unknown = entries.filter((e) => e.details.reason === "unknown");
  assert.equal(unknown.length, 20);
  assert.equal(unknown.filter((e) => e.details.moreNotRecorded).length, 1);
  const known = entries.filter((e) => e.target.id === record.id);
  assert.deepEqual(
    known.map((e) => e.details),
    [{ reason: "scope", scope: "scim" }],
  );
  env.now += 2 * 86_400_000;
  await assert.rejects(apiKey(org, key, "reports:read"), { status: 401 });
  await assert.rejects(apiKey(org, made, "audit:read"), { status: 401 });
  const later = (await failed()).filter((e) => e.at === env.now);
  assert.deepEqual(later.map((e) => e.details.reason).sort(), [
    "expired",
    "unknown",
  ]);
});

test("verifying an address keeps a board removal and a higher role", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const rooms = [];
  for (const title of ["Removed", "Promoted"]) {
    const { input, room } = createInput(title);
    await boards.call(owner, input);
    await boards.call(owner, {
      op: "settings",
      room,
      visibility: "organization",
    });
    await call(owner, {
      op: "migration.apply",
      room,
      members: [{ email: "vic@fabrikam.test", role: "editor" }],
    });
    rooms.push(room);
  }
  const [removed, promoted] = rooms;
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(viewer, { op: "org.join", token });
  for (const room of rooms) await boards.call(viewer, { op: "join", room });
  await boards.call(owner, {
    op: "role",
    room: removed,
    uuid: viewer.uuid,
    role: "removed",
  });
  await boards.call(owner, {
    op: "role",
    room: promoted,
    uuid: viewer.uuid,
    role: "facilitator",
  });
  await call(viewer, { op: "email.start", email: "vic@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  await call(viewer, { op: "email.confirm", code });
  const member = (room) => org.kv.get(`wb:${room}:member:${viewer.uuid}`);
  assert.equal((await member(removed)).role, "removed");
  assert.equal((await member(promoted)).role, "facilitator");
  assert.equal(await org.kv.get(`org:ub:${viewer.uuid}:${removed}`), null);
  assert.equal(
    await org.kv.get(`org:ub:${viewer.uuid}:${promoted}`),
    "facilitator",
  );
  await assert.rejects(boards.call(viewer, { op: "join", room: removed }), {
    status: 403,
  });
});

test("webhook deliveries are always signed, and deleted webhooks get none", async () => {
  const { call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { webhook } = await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/wb",
  });
  const entry = { id: "e1", action: "user.joined", time: "t" };
  // Another instance still lists the webhook after it was deleted.
  await call(owner, { op: "webhooks.delete", id: webhook.id });
  const before = fetched.length;
  await sendHook(org, webhook, entry);
  assert.equal(fetched.length, before, "Nothing is sent");
  // A webhook whose secret is not saved yet is tried again later.
  await org.kv.set("org:webhook:" + webhook.id, webhook);
  await assert.rejects(sendHook(org, webhook, entry));
  assert.equal(fetched.length, before);
});

test("each person's daily activity mark expires; the day's count stays", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  await org.touch(editor);
  const today = new Date(org.now()).toISOString().slice(0, 10);
  assert.equal(
    org.kv.expiries.get(`org:dayuser:${today}:${editor.uuid}`),
    172800,
  );
  assert.equal(org.kv.expiries.has(`org:daycount:${today}`), false);
  assert.equal(await org.kv.get(`org:daycount:${today}`), 1);
});

test("activity before someone joins is not counted and does not hide their activity once they join", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  const today = new Date(org.now()).toISOString().slice(0, 10);
  // The app asks about the organization before accepting the invitation.
  await call(editor, { op: "org.info" });
  await org.touch(editor);
  const stranger = {
    uuid: "55555555-5555-4555-8555-555555555555",
    username: "Eve",
  };
  await org.touch(stranger);
  assert.equal((await org.kv.get(`org:daycount:${today}`)) || 0, 0);
  await call(editor, { op: "org.join", token });
  await org.touch(editor);
  assert.equal(await org.kv.get(`org:daycount:${today}`), 1);
  const { users } = await call(owner, { op: "org.users.list" });
  assert.equal(users.find((u) => u.uuid === editor.uuid).lastActive, org.now());
  const report = await call(owner, { op: "org.reports", days: 7 });
  assert.deepEqual(report.users.inactive, []);
});

test("changes made on another instance are never written over by a cached copy", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  // This instance caches the member as active; another deactivates them.
  assert.equal((await org.user(editor.uuid)).status, "active");
  const stored = await org.kv.get("org:user:" + editor.uuid);
  await org.kv.set("org:user:" + editor.uuid, {
    ...stored,
    status: "deactivated",
  });
  await call(owner, {
    op: "teams.create",
    name: "Design",
    members: [editor.uuid],
  });
  const saved = await org.kv.get("org:user:" + editor.uuid);
  assert.equal(saved.status, "deactivated");
  assert.equal(saved.teams.length, 1);
});

test("a new invitation lets a guest whose access expired back in", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, { op: "org.policy.set", policy: { guestExpiryDays: 1 } });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const first = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
    guest: true,
  });
  await join({ service: boards }, guest, { room, token: first.token });
  const start = Date.now();
  boards.now = org.now = () => start + 2 * 86_400_000;
  await assert.rejects(boards.call(guest, { op: "sync", room }), {
    message: /guest access to this board has expired/,
  });
  // The old invitation cannot renew access; a new one can.
  await assert.rejects(
    join({ service: boards }, guest, { room, token: first.token }),
    { status: 403 },
  );
  const again = await boards.call(owner, {
    op: "invite",
    room,
    role: "viewer",
    guest: true,
  });
  const joined = await join({ service: boards }, guest, {
    room,
    token: again.token,
  });
  assert.equal(joined.member.role, "viewer");
  await boards.call(guest, { op: "sync", room });
  // The renewed access expires again with the policy.
  boards.now = org.now = () => start + 5 * 86_400_000;
  await assert.rejects(boards.call(guest, { op: "sync", room }), {
    status: 403,
  });
});

test("the shared board map accepts only its title and planning settings", async () => {
  const { boards } = setup();
  const { input, room } = createInput();
  await boards.call(owner, input);
  const inv = await boards.call(owner, {
    op: "invite",
    room,
    role: "commenter",
  });
  await boards.call(viewer, { op: "join", room, token: inv.token });
  for (const [user, change] of [
    [viewer, (meta) => meta.set("junk", "x".repeat(100_000))],
    [owner, (meta) => meta.set("planning", ["not", "plain"])],
  ]) {
    const { doc } = await boards.load(room);
    const before = doc.vector();
    change(doc.meta);
    const update = doc.update(before);
    doc.destroy();
    await assert.rejects(
      boards.call(user, {
        op: "commit",
        room,
        id: await hash(update),
        update: encode(update),
      }),
      { status: 422 },
    );
  }
  const { doc } = await boards.load(room);
  assert.deepEqual([...doc.meta.keys()], ["title"]);
  doc.destroy();
});

test("invitations stop working when their creator can no longer manage the board", async () => {
  const { boards } = setup();
  const { input, room } = createInput();
  await boards.call(owner, input);
  const promote = await boards.call(owner, {
    op: "invite",
    room,
    role: "facilitator",
  });
  await join({ service: boards }, editor, { room, token: promote.token });
  const theirs = await boards.call(editor, {
    op: "invite",
    room,
    role: "editor",
  });
  const second = await boards.call(editor, {
    op: "invite",
    room,
    role: "viewer",
  });
  await join({ service: boards }, viewer, { room, token: second.token });
  await boards.call(owner, {
    op: "role",
    room,
    uuid: editor.uuid,
    role: "removed",
  });
  await assert.rejects(
    join({ service: boards }, guest, { room, token: theirs.token }),
    { status: 403, message: /expired or was revoked/ },
  );
  // People who already joined keep their access.
  await boards.call(viewer, { op: "sync", room });
  // The owner's own invitations still work.
  const ownerInvite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, guest, { room, token: ownerInvite.token });
});

test("the administrator running a migration keeps the role they had in Miro", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  await call(owner, { op: "email.start", email: "alice@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  await call(owner, { op: "email.confirm", code });
  const member = (room) => org.kv.get(`wb:${room}:member:${owner.uuid}`);
  for (const [members, expected] of [
    [
      [
        { email: "bob@fabrikam.test", role: "owner", name: "Bob" },
        { email: "alice@fabrikam.test", role: "editor", name: "Alice" },
      ],
      "editor",
    ],
    // Not a member there: governance access only.
    [[{ email: "bob@fabrikam.test", role: "owner", name: "Bob" }], "removed"],
  ]) {
    const { input, room } = createInput("From Miro");
    await boards.call(owner, input);
    await call(owner, { op: "migration.apply", room, members });
    assert.equal((await member(room)).role, expected);
  }
});

test("turning off guest access ends access for guests already on boards", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const inv = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
    guest: true,
  });
  await join({ service: boards }, guest, { room, token: inv.token });
  await boards.call(guest, { op: "sync", room });
  await call(owner, { op: "org.policy.set", policy: { guestAccess: false } });
  org.forgetPolicy();
  await assert.rejects(boards.call(guest, { op: "sync", room }), {
    status: 403,
    message: /does not allow guest access/,
  });
  await boards.call(owner, { op: "sync", room });
  await call(owner, { op: "org.policy.set", policy: { guestAccess: true } });
  org.forgetPolicy();
  await boards.call(guest, { op: "sync", room });
});

test("guest expiry also applies to members made guests later", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, { op: "org.policy.set", policy: { guestExpiryDays: 1 } });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const inv = await boards.call(owner, { op: "invite", room, role: "editor" });
  await join({ service: boards }, editor, { room, token: inv.token });
  const start = Date.now();
  // Months later, the member becomes a guest; their day starts then.
  boards.now = org.now = () => start + 100 * 86_400_000;
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "guest",
  });
  org.forgetUser(editor.uuid);
  await boards.call(editor, { op: "sync", room });
  boards.now = org.now = () => start + 102 * 86_400_000;
  await assert.rejects(boards.call(editor, { op: "sync", room }), {
    status: 403,
    message: /guest access to this board has expired/,
  });
  // Members, and boards before the organization was set up, are unaffected.
  await boards.call(owner, { op: "sync", room });
});

test("an administrator invitation works for one person", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token });
  assert.equal(await org.role(editor), "admin");
  await assert.rejects(call(viewer, { op: "org.join", token }), {
    status: 403,
    message: /already used/,
  });
  assert.equal(await org.role(viewer), null);
  // The person it admitted can follow it again.
  await call(editor, { op: "org.join", token });
  // Member links still admit a whole team.
  const team = await call(owner, { op: "org.invite", role: "member" });
  for (const user of [viewer, guest])
    await call(user, { op: "org.join", token: team.token });
  assert.equal(await org.role(guest), "member");
  // Two people following a new administrator link at the same moment:
  // only one becomes an administrator.
  const admin = await call(owner, { op: "org.invite", role: "admin" });
  const other = {
    uuid: "55555555-5555-4555-8555-555555555555",
    username: "Eve",
  };
  const results = await Promise.allSettled([
    call(viewer, { op: "org.join", token: admin.token }),
    call(other, { op: "org.join", token: admin.token }),
  ]);
  // Either can be first: the hashes each request computes finish in no
  // set order.
  assert.deepEqual(results.map((r) => r.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /already used/,
  );
  const first = results[0].status === "fulfilled";
  assert.equal(await org.role(viewer), first ? "admin" : "member");
  assert.equal(await org.role(other), first ? null : "admin");
});

test("a board that kept a public link saves its settings after links are turned off", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { publicLinks: true, externalSharing: "anyone" },
  });
  const { input, room } = createInput();
  await boards.call(owner, input);
  await boards.call(owner, { op: "settings", room, visibility: "link" });
  await call(owner, { op: "org.policy.set", policy: { publicLinks: false } });
  org.forgetPolicy();
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "link",
    orgRole: "viewer",
  });
  assert.equal((await org.kv.get(`wb:${room}:meta`)).orgRole, "viewer");
  // Turning a public link on is still refused.
  const other = createInput("Other");
  await boards.call(owner, other.input);
  await assert.rejects(
    boards.call(owner, {
      op: "settings",
      room: other.room,
      visibility: "link",
    }),
    { status: 403 },
  );
});

test("a space name already used is refused, whatever its case", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, { op: "spaces.create", name: "Marketing" });
  for (const name of ["Marketing", "  marketing "])
    await assert.rejects(call(owner, { op: "spaces.create", name }), {
      status: 409,
      message: "A space with this name already exists.",
    });
  await call(owner, { op: "spaces.create", name: "Marketing team" });
  const { spaces } = await call(owner, { op: "spaces.list" });
  assert.deepEqual(spaces.map((s) => s.name).sort(), [
    "Marketing",
    "Marketing team",
  ]);
});

test("searching organization boards finds them by their space's name, not its id", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const filed = createInput("Q3 plan"),
    other = createInput("Hiring");
  await boards.call(owner, filed.input);
  await boards.call(owner, other.input);
  const { space } = await call(owner, {
    op: "spaces.create",
    name: "Marketing",
  });
  await boards.call(owner, {
    op: "settings",
    room: filed.room,
    space: space.id,
  });
  const rooms = async (query) =>
    (await call(owner, { op: "org.boards", scope: "all", query })).boards.map(
      (b) => b.room,
    );
  assert.deepEqual(await rooms("marketing"), [filed.room]);
  assert.deepEqual(await rooms("q3 marketing"), [filed.room]);
  assert.deepEqual(await rooms(space.id.slice(2, 8)), []);
  // A guest, who may not list the spaces, cannot find their names either.
  const { token } = await boards.call(owner, {
    op: "invite",
    room: filed.room,
    role: "viewer",
    guest: true,
  });
  await boards.call(guest, { op: "join", room: filed.room, token });
  await assert.rejects(call(guest, { op: "spaces.list" }), { status: 403 });
  const search = async (query) =>
    (await call(guest, { op: "org.boards", query })).boards.map((b) => b.room);
  assert.deepEqual(await search("q3"), [filed.room]);
  assert.deepEqual(await search("marketing"), []);
});

test("organization boards found by what they hold say where they matched", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const content = createInput("Planning", [
    item("note", 0, 0, { text: "Ship the Quarterly\nRoadmap by June" }),
    item("note", 0, 200, { text: "L’œuvre collective" }),
  ]);
  const named = createInput("Roadmap retro");
  await boards.call(owner, content.input);
  await boards.call(owner, named.input);
  const search = async (query) =>
    Object.fromEntries(
      (
        await call(owner, { op: "org.boards", query, content: true })
      ).boards.map((b) => [b.title, b.snippet]),
    );
  const found = await search("roadmap");
  assert.deepEqual(found["Planning"], {
    before: "Ship the Quarterly ",
    hit: "Roadmap",
    after: " by June\nL’œuvre collective".replace(/\s+/g, " "),
  });
  // A board whose name holds every word says nothing more.
  assert.equal(found["Roadmap retro"], undefined);
  // The words are found as written, accents and ligatures included.
  assert.equal((await search("planning oeuvre"))["Planning"].hit, "œuvre");
  // A title-only search reads no content and says nothing either.
  const titles = await call(owner, { op: "org.boards", query: "roadmap" });
  assert.ok(titles.boards.every((b) => !("snippet" in b)));
});

test("boards named alike but for accents, apostrophes or spacing are found as duplicates", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const titles = [
    "L’Équipe roadmap",
    "l'equipe  roadmap (copie)",
    "L'équipe Roadmap",
    "Other",
  ];
  for (const [n, title] of titles.entries())
    await boards.call(
      owner,
      createInput(title, [item("note", 0, 0, { text: `Note ${n}` })]).input,
    );
  const { groups } = await call(owner, { op: "org.boards.duplicates" });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "same title");
  assert.deepEqual(
    groups[0].boards.map((b) => b.title).sort(),
    titles.slice(0, 3).sort(),
  );
});

test("deleting a space takes its boards out of it", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const filed = createInput("Q3 plan"),
    other = createInput("Hiring");
  await boards.call(owner, filed.input);
  await boards.call(owner, other.input);
  const [{ space: gone }, { space: kept }] = [
    await call(owner, { op: "spaces.create", name: "Marketing" }),
    await call(owner, { op: "spaces.create", name: "Sales" }),
  ];
  await boards.call(owner, {
    op: "settings",
    room: filed.room,
    space: gone.id,
  });
  await boards.call(owner, {
    op: "settings",
    room: other.room,
    space: kept.id,
  });
  await call(owner, { op: "spaces.delete", id: gone.id });
  const spaceOf = async (room) =>
    (await boards.call(owner, { op: "settings.get", room })).settings.space ??
    null;
  assert.equal(await spaceOf(filed.room), null);
  assert.equal(await spaceOf(other.room), kept.id);
  const { boards: listed } = await call(owner, {
    op: "org.boards",
    scope: "all",
  });
  assert.equal(listed.find((b) => b.room === filed.room).space ?? null, null);
  // A delete that fails partway leaves the space to delete again.
  const again = createInput("Retro");
  await boards.call(owner, again.input);
  await boards.call(owner, {
    op: "settings",
    room: again.room,
    space: kept.id,
  });
  const register = org.registerBoard.bind(org);
  org.registerBoard = async (room, patch) => {
    if ("space" in patch && room === again.room) throw Error("Storage busy");
    return register(room, patch);
  };
  await assert.rejects(call(owner, { op: "spaces.delete", id: kept.id }));
  org.registerBoard = register;
  const { spaces } = await call(owner, { op: "spaces.list" });
  assert.deepEqual(
    spaces.map((s) => s.id),
    [kept.id],
  );
  await call(owner, { op: "spaces.delete", id: kept.id });
  assert.equal(await spaceOf(again.room), null);
  const { entries } = await call(owner, { op: "org.audit" });
  assert.equal(
    entries.filter(
      (e) => e.action === "space.deleted" && e.target?.id === kept.id,
    ).length,
    1,
  );
});

test("a search of only spaces reads no board's text", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const title of ["One", "Two"])
    await boards.call(owner, createInput(title).input);
  const read = [];
  const get = org.kv.get.bind(org.kv);
  org.kv.get = (key, ...rest) => {
    for (const k of [key].flat()) if (k.startsWith("org:idx:")) read.push(k);
    return get(key, ...rest);
  };
  try {
    const blank = await call(owner, {
      op: "org.boards",
      query: "   ",
      content: true,
    });
    assert.equal(blank.boards.length, 2);
    assert.deepEqual(read, []);
    // A real search still reads the boards' text.
    const found = await call(owner, {
      op: "org.boards",
      query: "two",
      content: true,
    });
    assert.deepEqual(
      found.boards.map((b) => b.title),
      ["Two"],
    );
    assert.equal(read.length, 2);
  } finally {
    org.kv.get = get;
  }
});

test("marking all notifications read reaches past the newest 200", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const at = Date.now();
  for (let n = 0; n < 650; n++) {
    const id = `${new Date(at - n * 60000).toISOString()}:n${n}`;
    await org.kv.set(`org:notif:${owner.uuid}:${id}`, {
      id,
      at: at - n * 60000,
      type: "mention",
      read: false,
    });
  }
  const unread = async () =>
    (await org.list(`org:notif:${owner.uuid}:`)).filter((r) => !r.value.read)
      .length;
  // A request changes at most 500 and says more are left.
  assert.deepEqual(await call(owner, { op: "notifications.read", all: true }), {
    ok: true,
    more: true,
  });
  assert.equal(await unread(), 150);
  assert.deepEqual(await call(owner, { op: "notifications.read", all: true }), {
    ok: true,
    more: false,
  });
  assert.equal(await unread(), 0);
});

test("creating and deleting spaces is audited", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { space } = await call(owner, { op: "spaces.create", name: "Policy" });
  await call(owner, { op: "spaces.delete", id: space.id });
  const { entries } = await call(owner, { op: "org.audit" });
  const spaces = entries.filter((e) => e.target?.type === "space");
  assert.deepEqual(
    spaces.map((e) => [e.action, e.target.name, e.category]).sort(),
    [
      ["space.created", "Policy", "admin"],
      ["space.deleted", "Policy", "admin"],
    ],
  );
});

test("the board directory pages through matching boards", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const title of ["One", "Two", "Three"]) {
    const { input } = createInput(title);
    await boards.call(owner, input);
  }
  const first = await call(owner, { op: "org.boards", scope: "all", limit: 2 });
  assert.equal(first.boards.length, 2);
  assert.equal(first.total, 3);
  const rest = await call(owner, {
    op: "org.boards",
    scope: "all",
    limit: 2,
    offset: 2,
  });
  assert.equal(rest.boards.length, 1);
  assert.equal(
    new Set([...first.boards, ...rest.boards].map((b) => b.room)).size,
    3,
  );
});

test("security alerts read the administrator list once a minute", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { externalSharing: "anyone", publicLinks: true },
  });
  const { token } = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token });
  const listed = [];
  const list = org.list.bind(org);
  org.list = (prefix, ...rest) => (listed.push(prefix), list(prefix, ...rest));
  for (const title of ["One", "Two"]) {
    const { input, room } = createInput(title);
    await boards.call(owner, input);
    await boards.call(owner, { op: "settings", room, visibility: "link" });
    await org.flush();
  }
  org.list = list;
  assert.equal(listed.filter((p) => p === "org:user:").length, 1);
  const alerts = (
    await call(editor, { op: "notifications.list" })
  ).items.filter(
    (n) => n.type === "alert" && n.action === "board.visibility.link",
  );
  assert.equal(alerts.length, 2, "Administrators still get every alert");
});

test("many guests joining a board raise one alert, then one for the rest", async () => {
  const { env, boards, call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      externalSharing: "anyone",
      publicLinks: true,
      alerts: { emails: ["sec@fabrikam.test"] },
    },
  });
  const { token } = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token });
  const { input, room } = createInput("Workshop");
  await boards.call(owner, input);
  await boards.call(owner, { op: "settings", room, visibility: "link" });
  const guestAlerts = async (user) =>
    (await call(user, { op: "notifications.list" })).items.filter(
      (n) => n.type === "alert" && n.action === "board.guest.joined",
    );
  const mails = () =>
    sent.filter((m) => m.subject.includes("A guest joined a board")).length;
  for (let n = 0; n < 30; n++)
    await boards.call(
      {
        uuid: `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`,
        username: "G" + n,
      },
      { op: "join", room },
    );
  // The first is told of at once; the rest wait for the window to end.
  assert.equal((await guestAlerts(owner)).length, 1);
  assert.equal((await guestAlerts(editor)).length, 1);
  assert.equal(mails(), 1);
  env.now += 11 * 60_000;
  await org.scheduledWork();
  const [summary] = await guestAlerts(owner);
  assert.equal(summary.count, 29);
  assert.match(summary.text, /29 more guests joined a board/);
  assert.equal((await guestAlerts(editor)).length, 2);
  assert.equal(sent.filter((m) => /29 more guests/.test(m.subject)).length, 1);
  // Told of once, by whichever request comes first.
  await org.scheduledWork();
  env.now += 2 * 60_000;
  await org.scheduledWork();
  assert.equal((await guestAlerts(owner)).length, 2);
  // A guest joining later is told of at once again.
  await boards.call(
    { uuid: "bbbbbbbb-bbbb-4bbb-8bbb-999999999999", username: "Late" },
    { op: "join", room },
  );
  assert.equal((await guestAlerts(owner)).length, 3);
});

test("changing a board's default access or filing is audited, and widening a public link alerts", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { externalSharing: "anyone", publicLinks: true },
  });
  const { token } = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const { space } = await call(owner, { op: "spaces.create", name: "Plans" });
  await boards.call(owner, { op: "settings", room, visibility: "link" });
  await boards.call(owner, { op: "settings", room, linkRole: "editor" });
  await boards.call(owner, { op: "settings", room, orgRole: "commenter" });
  await boards.call(owner, { op: "settings", room, linkRole: "viewer" });
  await boards.call(owner, { op: "settings", room, space: space.id });
  // Saving the same values again records nothing.
  await boards.call(owner, {
    op: "settings",
    room,
    linkRole: "viewer",
    orgRole: "commenter",
    space: space.id,
  });
  await org.flush();
  const { entries } = await call(owner, { op: "org.audit" });
  const changes = entries
    .filter((e) => ["board.share.role", "board.filed"].includes(e.action))
    .map((e) => JSON.stringify([e.action, e.category, e.details]))
    .sort();
  // Entries made within the same millisecond have no set order.
  const expected = [
    [
      "board.share.role",
      "sharing",
      { setting: "link", from: "viewer", to: "editor", visibility: "link" },
    ],
    [
      "board.share.role",
      "sharing",
      {
        setting: "organization",
        from: "editor",
        to: "commenter",
        visibility: "link",
      },
    ],
    [
      "board.share.role",
      "sharing",
      { setting: "link", from: "editor", to: "viewer", visibility: "link" },
    ],
    ["board.filed", "admin", { space: space.id, from: null }],
  ];
  assert.deepEqual(changes, expected.map((e) => JSON.stringify(e)).sort());
  // Only giving anyone with the link more access raises an alert.
  const alerts = (
    await call(editor, { op: "notifications.list" })
  ).items.filter((n) => n.type === "alert" && n.action === "board.share.role");
  assert.equal(alerts.length, 1);
  assert.equal(
    alerts[0].label,
    "Anyone with a board’s link was given more access",
  );
});

test("a shorter guest expiry applies to guests who already joined, and a longer one extends no one", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { externalSharing: "guests", guestExpiryDays: 30 },
  });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, guest, { room, token: invite.token });
  const day = 86400_000,
    start = Date.now();
  const on = async (days) => {
    boards.now = () => start + days * day;
    return boards.call(guest, { op: "sync", room }).then(
      () => true,
      (error) => (assert.equal(error.status, 403), false),
    );
  };
  const inactive = async () =>
    (await boards.call(owner, { op: "members", room })).members.find(
      (m) => m.uuid === guest.uuid,
    ).inactive === true;
  try {
    assert.equal(await on(3), true);
    await call(owner, {
      op: "org.policy.set",
      policy: { guestExpiryDays: 1 },
    });
    assert.equal(await on(3), false);
    assert.equal(await inactive(), true);
    // Raising it again gives back no more than the 30 days they joined with.
    await call(owner, {
      op: "org.policy.set",
      policy: { guestExpiryDays: 90 },
    });
    assert.equal(await on(3), true);
    assert.equal(await inactive(), false);
    assert.equal(await on(31), false);
  } finally {
    boards.now = Date.now;
  }
});

test("every ownership transfer goes only to an active member", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const guestLink = await call(owner, { op: "org.invite", role: "guest" });
  await call(guest, { op: "org.join", token: guestLink.token });
  const team = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token: team.token });
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Admin",
    scopes: ["boards:write"],
  });
  const patch = (body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/v1/boards/" + room, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${key}` },
      }),
      "PATCH",
      "boards/" + room,
      body,
    );
  for (const target of [guest, editor])
    await assert.rejects(patch({ owner: target.uuid }), { status: 400 });
  assert.equal((await org.kv.get(`wb:${room}:meta`)).owner, owner.uuid);
  // A refused request changes nothing, even what it asked for before the
  // refused part.
  await assert.rejects(patch({ archived: true, visibility: "bogus" }), {
    status: 400,
  });
  await assert.rejects(patch({ archived: true, owner: guest.uuid }), {
    status: 400,
  });
  assert.ok(!(await org.kv.get(`wb:${room}:meta`)).archived);
  // Refusals that depend on the organization's policy or a hold, too.
  const colleague = await call(owner, { op: "org.invite", role: "member" });
  await call(viewer, { op: "org.join", token: colleague.token });
  await assert.rejects(patch({ owner: viewer.uuid, visibility: "link" }), {
    status: 403,
  });
  await assert.rejects(patch({ legalHold: true, deleted: true }), {
    status: 409,
  });
  await call(owner, {
    op: "org.policy.set",
    policy: { retention: { legalHold: true } },
  });
  await assert.rejects(patch({ archived: true, deleted: true }), {
    status: 409,
  });
  const meta = await org.kv.get(`wb:${room}:meta`);
  assert.equal(meta.owner, owner.uuid);
  assert.ok(!meta.archived && !meta.legalHold && !meta.deleted);
  // A request that releases a board's own hold may delete it.
  await call(owner, {
    op: "org.policy.set",
    policy: { retention: { legalHold: false } },
  });
  await patch({ legalHold: true });
  await patch({ legalHold: false, deleted: true });
  assert.ok((await org.kv.get(`wb:${room}:meta`)).deleted);
});

test("SCIM lookups and group changes read only the people involved", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Entra",
    scopes: ["scim"],
  });
  const scim = (path, method = "GET", body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path.split("?")[0],
      body,
    );
  const people = [];
  for (let n = 0; n < 300; n++)
    people.push(
      await (
        await scim("Users", "POST", { userName: `p${n}@fabrikam.test` })
      ).json(),
    );
  const group = await (
    await scim("Groups", "POST", { displayName: "Team" })
  ).json();
  const listed = [];
  const list = org.list.bind(org);
  org.list = (prefix, ...rest) => (listed.push(prefix), list(prefix, ...rest));
  const found = await (
    await scim(
      `Users?filter=${encodeURIComponent('userName eq "p7@fabrikam.test"')}`,
    )
  ).json();
  const missing = await (
    await scim(
      `Users?filter=${encodeURIComponent('userName eq "new@fabrikam.test"')}`,
    )
  ).json();
  await scim("Groups/" + group.id, "PATCH", {
    schemas: [PATCH_OP],
    Operations: [
      { op: "add", path: "members", value: [{ value: people[3].id }] },
    ],
  });
  const read = await (await scim("Groups/" + group.id)).json();
  org.list = list;
  assert.equal(found.totalResults, 1);
  assert.equal(found.Resources[0].id, people[7].id);
  assert.equal(missing.totalResults, 0);
  assert.deepEqual(read.members, [{ value: people[3].id }]);
  assert.ok(!listed.includes("org:user:"), listed.join());
});

test("SCIM changes reach webhooks and the default SIEM categories", async () => {
  const { boards, call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  const { webhook } = await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/scim",
    events: ["scim"],
  });
  assert.deepEqual(webhook.events, ["scim"]);
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Entra",
    scopes: ["scim"],
  });
  const scim = (path, method, body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
  const user = await (
    await scim("Users", "POST", { userName: "bob@fabrikam.test" })
  ).json();
  await scim("Users/" + user.id, "PATCH", {
    schemas: [PATCH_OP],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  await org.flush();
  const events = fetched
    .filter((f) => f.url === webhook.url)
    .map((f) => JSON.parse(f.options.body).event);
  assert.ok(events.includes("scim.user.updated"), events.join());
  for (const action of ["scim.user.updated", "scim.group.created"])
    assert.equal(auditCategory(action), "admin");
});

test("SCIM role and status changes are recorded and alerted as console changes are", async () => {
  const { call, org, boards } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Google Workspace",
    scopes: ["scim"],
  });
  const patch = (Operations) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/Users/" + editor.uuid, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${key}` },
      }),
      "PATCH",
      "Users/" + editor.uuid,
      { schemas: [PATCH_OP], Operations },
    );
  await patch([{ op: "add", path: "roles", value: [{ value: "guest" }] }]);
  await patch([{ op: "replace", path: "active", value: false }]);
  await patch([{ op: "replace", path: "active", value: true }]);
  // Saving the same role again records no change.
  await patch([{ op: "add", path: "roles", value: [{ value: "guest" }] }]);
  await org.flush();
  const { entries } = await call(owner, { op: "org.audit" });
  const about = (action) =>
    entries
      .filter((e) => e.action === action && e.target.id === editor.uuid)
      .map((e) => e.details);
  assert.deepEqual(about("user.role.changed"), [
    { from: "member", to: "guest", source: "scim" },
  ]);
  assert.deepEqual(about("user.deactivated"), [{ source: "scim" }]);
  assert.deepEqual(about("user.reactivated"), [{ source: "scim" }]);
  assert.ok(
    about("scim.user.updated").some(
      (d) => d.from === "member" && d.role === "guest",
    ),
  );
  const alerts = (await call(owner, { op: "notifications.list" })).items.filter(
    (n) => n.type === "alert" && n.action === "user.role.changed",
  );
  assert.equal(alerts.length, 1);
});

test("SCIM creation and deletion of an existing account are recorded as console changes are", async () => {
  const { call, org, boards } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  await org.saveUser({
    ...(await org.freshUser(editor.uuid)),
    email: "bob@fabrikam.test",
    emailVerified: true,
  });
  const { input, room } = createInput("Bob's board");
  await boards.call(owner, input);
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  await boards.call(editor, { op: "join", room });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Entra",
    scopes: ["scim"],
  });
  const scim = async (path, method, body) => {
    const response = await restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
    return response.status === 204 ? null : response.json();
  };
  const created = await scim("Users", "POST", {
    userName: "bob@fabrikam.test",
    roles: [{ value: "guest" }],
  });
  assert.equal((await org.kv.get("org:board:" + room)).guestCount, 1);
  await scim("Users/" + created.id, "DELETE");
  await scim("Users", "POST", {
    userName: "bob@fabrikam.test",
    roles: [{ value: "member" }],
    active: true,
  });
  await org.flush();
  const { entries } = await call(owner, { op: "org.audit" });
  const about = (action) =>
    entries
      .filter((e) => e.action === action && e.target.id === editor.uuid)
      .map((e) => e.details);
  assert.deepEqual(
    about("user.role.changed")
      .map((d) => `${d.from} to ${d.to} by ${d.source}`)
      .sort(),
    ["guest to member by scim", "member to guest by scim"],
  );
  assert.deepEqual(about("user.deactivated"), [{ source: "scim" }]);
  assert.deepEqual(about("user.reactivated"), [{ source: "scim" }]);
  assert.equal((await org.kv.get("org:board:" + room)).guestCount, 0);
  const alerts = (await call(owner, { op: "notifications.list" })).items.filter(
    (n) => n.type === "alert" && n.action === "user.role.changed",
  );
  assert.equal(alerts.length, 2);
});

test("team changes record who was added and removed, from SCIM and the console", async () => {
  const { call, org, boards } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const user of [editor, viewer]) {
    const { token } = await call(owner, { op: "org.invite", role: "member" });
    await call(user, { op: "org.join", token });
  }
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Google Workspace",
    scopes: ["scim"],
  });
  const scim = async (path, method, body) => {
    const response = await restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
    return response.status === 204 ? null : response.json();
  };
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    members: [{ value: editor.uuid }],
  });
  await scim("Groups/" + group.id, "PATCH", {
    schemas: [PATCH_OP],
    Operations: [
      { op: "add", path: "members", value: [{ value: viewer.uuid }] },
      { op: "remove", path: `members[value eq "${editor.uuid}"]` },
    ],
  });
  await scim("Groups/" + group.id, "DELETE");
  const { team } = await call(owner, {
    op: "teams.create",
    name: "Research",
    members: [editor.uuid, viewer.uuid],
  });
  await call(owner, {
    op: "teams.update",
    id: team.id,
    members: [viewer.uuid],
  });
  await org.flush();
  const { entries } = await call(owner, { op: "org.audit" });
  const details = Object.fromEntries(
    entries
      .filter((e) => /^(scim\.group|team)\./.test(e.action))
      .map((e) => [e.action, e.details]),
  );
  assert.deepEqual(details["scim.group.created"], {
    members: 1,
    added: [editor.uuid],
    removed: [],
  });
  assert.deepEqual(details["scim.group.updated"], {
    members: 1,
    added: [viewer.uuid],
    removed: [editor.uuid],
  });
  assert.deepEqual(details["scim.group.deleted"], {
    members: 0,
    added: [],
    removed: [viewer.uuid],
  });
  assert.deepEqual(details["team.created"], {
    members: 2,
    added: [editor.uuid, viewer.uuid],
    removed: [],
  });
  assert.deepEqual(details["team.updated"], {
    members: 1,
    added: [],
    removed: [editor.uuid],
  });
});

test("security alerts posted to Slack read in both languages", async () => {
  const { call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      integrations: { slack: { enabled: true } },
      alerts: { slack: true, permissionChanges: true },
    },
  });
  await org.kv.set("org:secret:slack", "https://hooks.slack.com/services/A");
  await call(owner, { op: "apikeys.create", name: "Sync", scopes: ["scim"] });
  await org.flush();
  const posts = fetched
    .filter((f) => f.url === "https://hooks.slack.com/services/A")
    .map((f) => JSON.parse(f.options.body).text);
  assert.equal(posts.length, 1);
  const [en, fr] = posts[0].split("\n\n");
  assert.match(en, /^An API key was created: Alice "Sync"/m);
  assert.match(fr, /^Une clé d’API a été créée : Alice « Sync »/m);
  assert.doesNotMatch(fr, /An API key/);
});

test("a migration brings people outside the organization's domains in as guests", async () => {
  const { boards, call, org } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  const { input, room } = createInput("Migrated");
  await boards.call(owner, input);
  // The dialog's domains were left blank, so no one was marked a guest.
  const { applied } = await call(owner, {
    op: "migration.apply",
    room,
    members: [
      { email: "dan@fabrikam.test", role: "owner", guest: false },
      { email: "ana@team.fabrikam.test", role: "editor", guest: false },
      { email: "contractor@vendor.com", role: "editor", guest: false },
    ],
  });
  assert.equal(applied.length, 3);
  const { users } = await call(owner, { op: "org.users.list" });
  const roleOf = (email) => users.find((u) => u.email === email)?.role;
  assert.equal(roleOf("contractor@vendor.com"), "guest");
  assert.equal(roleOf("ana@team.fabrikam.test"), "member");
  assert.equal(roleOf("dan@fabrikam.test"), "member");
  assert.equal((await org.kv.get("org:board:" + room)).guestCount, 1);
});

test("a board whose Miro owner is a guest or deactivated still migrates, run by them as facilitator", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(viewer, { op: "org.join", token });
  await call(viewer, { op: "email.start", email: "left@fabrikam.test" });
  await call(viewer, {
    op: "email.confirm",
    code: /code is (\d{6})/.exec(sent.at(-1).text)[1],
  });
  await call(owner, {
    op: "org.users.update",
    uuid: viewer.uuid,
    status: "deactivated",
  });
  for (const [email, word] of [
    ["consultant@partner.org", "a guest"],
    ["left@fabrikam.test", "deactivated"],
  ]) {
    const { input, room } = createInput("Old board");
    await boards.call(owner, input);
    const result = await call(owner, {
      op: "migration.apply",
      room,
      members: [
        { email, role: "owner" },
        { email: "eve@fabrikam.test", role: "editor" },
      ],
    });
    assert.deepEqual(
      result.applied.map((a) => a.role),
      ["editor", "facilitator"],
    );
    assert.match(result.warnings[0], new RegExp(`${email} is ${word} here`));
    const meta = await org.kv.get(`wb:${room}:meta`);
    assert.equal(meta.owner, owner.uuid, "The administrator keeps it");
  }
});

test("a library item's creator removes it only while still a member", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const b = board("Retro template");
  b.items = [item("note", 0, 0, { text: "Went well" })];
  const submit = async (name) =>
    (
      await call(editor, {
        op: "library.submit",
        name,
        board: JSON.stringify(b),
      })
    ).item;
  const [kept, own] = [await submit("Retro"), await submit("Draft")];
  await call(owner, { op: "library.approve", id: kept.id });
  // A member removes their own item.
  await call(editor, { op: "library.remove", id: own.id });
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "guest",
  });
  await assert.rejects(call(editor, { op: "library.remove", id: kept.id }), {
    status: 403,
  });
  assert.deepEqual(
    (await call(owner, { op: "library.list" })).items.map((i) => i.name),
    ["Retro"],
  );
});

test("members have a limited amount of library content awaiting approval", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const user of [editor, viewer]) {
    const { token } = await call(owner, { op: "org.invite", role: "member" });
    await call(user, { op: "org.join", token });
  }
  const json = JSON.stringify(board("Retro template"));
  const submit = async (user, name) =>
    (await call(user, { op: "library.submit", name, board: json })).item;
  const waiting = (key, createdBy, size) =>
    org.kv.set("org:lib:" + key, {
      id: key,
      status: "pending",
      createdBy,
      ...(size === undefined ? {} : { size }),
    });
  // Many small items, as a migration of boards as templates shares, wait
  // together; each records its size.
  const shared = [];
  for (let n = 0; n < 15; n++) shared.push(await submit(editor, "Retro " + n));
  assert.equal(shared[0].size, json.length);
  // Items saved before sizes were recorded were allowed without a limit
  // and count for nothing, however many wait; Bob's own sized ones fill
  // all but a little of his 250 MB.
  for (let n = 0; n < 100; n++) await waiting("old" + n, editor.uuid);
  await waiting("big", editor.uuid, 250 * 1024 ** 2 - 16 * json.length);
  await submit(editor, "Fits");
  await assert.rejects(submit(editor, "One more"), {
    status: 429,
    message: /awaiting approval have reached 250 MB/,
  });
  // Reviewing makes room for more; administrators share freely.
  await call(owner, { op: "library.approve", id: shared[0].id });
  await submit(editor, "One more");
  for (let n = 0; n < 3; n++) await submit(owner, "Approved " + n);
  // The whole organization's waiting content is limited too.
  await waiting("others", "someone", 1024 ** 3 - 250 * 1024 ** 2);
  await assert.rejects(submit(viewer, "Mine"), {
    status: 429,
    message: /organization's 1 GB limit/,
  });
});

test("duplicate discovery tells boards without text apart by their objects", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const shapes = (title, list) =>
    createInput(
      title,
      list.map(([x, y, w]) => item("rect", x, y, { w })),
    );
  const diagram = [
    [0, 0, 200],
    [400, 0, 200],
  ];
  for (const { input, room } of [
    shapes("Network diagram", diagram),
    shapes("Network diagram v2", diagram),
    shapes("Org chart sketch", [
      [500, 500, 200],
      [40, 40, 300],
    ]),
    shapes("Floor plan", [[100, 100, 200]]),
  ]) {
    await boards.call(owner, input);
    // An edit writes the directory entry, fingerprint included.
    await commit(boards, owner, room, (b) => (b.items[0].y += 10));
  }
  const { groups } = await call(owner, { op: "org.boards.duplicates" });
  assert.deepEqual(
    groups.map((g) => g.boards.map((b) => b.title).sort()),
    [["Network diagram", "Network diagram v2"]],
  );
});

test("boards from one large template that went separate ways are not the same content", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const prompts = Array.from({ length: 200 }, (_, n) =>
    item("note", n * 10, 0, {
      text: `Template prompt ${n}: what went well, what to improve?`,
    }),
  );
  for (const [title, answer] of [
    ["Team A retro", "Team A answer"],
    ["Team B retro", "Team B completely different answer"],
    ["Team C retro", "Team B completely different answer"],
  ]) {
    const { input, room } = createInput(
      title,
      prompts.map((p) => ({ ...p })),
    );
    await boards.call(owner, input);
    await commit(boards, owner, room, (b) =>
      b.items.push(
        ...Array.from({ length: 50 }, (_, n) =>
          item("note", n * 10, 900, { text: `${answer} ${n}` }),
        ),
      ),
    );
  }
  const { groups } = await call(owner, { op: "org.boards.duplicates" });
  assert.deepEqual(
    groups.map((g) => g.boards.map((b) => b.title).sort()),
    [["Team B retro", "Team C retro"]],
  );
});

test("guest counts follow people's current organization role", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const shared = async (title, user) => {
    const { input, room } = createInput(title);
    await boards.call(owner, input);
    const { token } = await boards.call(owner, {
      op: "invite",
      room,
      role: "editor",
    });
    await boards.call(user, { op: "join", room, token });
    return room;
  };
  const partner = await shared("Partner board", guest);
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const internal = await shared("Internal board", editor);
  const counts = async () => [
    (await org.kv.get("org:board:" + partner)).guestCount,
    (await org.kv.get("org:board:" + internal)).guestCount,
  ];
  const withGuests = async () =>
    (await call(owner, { op: "org.boards", scope: "all", guests: true })).boards
      .map((b) => b.title)
      .sort();
  assert.deepEqual(await counts(), [1, 0]);
  // The partner joins the organization; Bob leaves it for a contract.
  await call(owner, {
    op: "org.users.update",
    uuid: guest.uuid,
    role: "member",
  });
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "guest",
  });
  assert.deepEqual(await counts(), [0, 1]);
  assert.deepEqual(await withGuests(), ["Internal board"]);
});

test("failed webhook deliveries are retried without waiting for a new event, and never dropped untried", async () => {
  const { boards, call, org } = setup();
  let down = true;
  const delivered = [];
  org.fetcher = boards.fetcher = async (url, options = {}) => {
    if (String(url).startsWith("https://hooks.example.ca")) {
      if (down) return new Response("", { status: 503 });
      delivered.push(JSON.parse(options.body).event);
      return new Response("");
    }
    if (String(url).includes("/events/kv-handles"))
      return Response.json({ handle: "h" });
    return new Response("{}");
  };
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/a",
    events: ["board"],
  });
  await org.flush();
  const start = Date.now();
  const at = (minutes) =>
    (org.now = boards.now = () => start + minutes * 60_000);
  try {
    at(0);
    const first = createInput("Friday board");
    await boards.call(owner, first.input);
    assert.deepEqual(delivered, []);
    down = false;
    // No new event: someone opening the board's member list is enough.
    at(3);
    await boards.call(owner, { op: "members", room: first.room });
    assert.deepEqual(delivered, ["board.created"]);
    // A failure left alone for more than a day still gets its retry.
    down = true;
    at(10);
    const second = createInput("Monday board");
    await boards.call(owner, second.input);
    down = false;
    at(10 + 25 * 60);
    await org.audit(editor, "board.archived", {
      type: "board",
      id: second.room,
    });
    await org.flush();
    assert.deepEqual(delivered.sort(), [
      "board.archived",
      "board.created",
      "board.created",
    ]);
    assert.equal((await org.list("org:hookq:")).length, 0);
  } finally {
    org.now = boards.now = Date.now;
  }
});

test("a migrated board keeps access everyone in the Miro organization had, and reports wider access", async () => {
  const { boards, call, org } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(viewer, { op: "org.join", token });
  const migrate = async (sharing) => {
    const { input, room } = createInput("Miro board");
    await boards.call(owner, input);
    const { warnings } = await call(owner, {
      op: "migration.apply",
      room,
      members: [{ email: "dan@fabrikam.test", role: "owner" }],
      source: { boardId: "m5", sharing },
    });
    return { room, warnings };
  };
  const shared = await migrate({
    access: "private",
    teamAccess: "edit",
    organizationAccess: "comment",
  });
  const meta = await org.kv.get(`wb:${shared.room}:meta`);
  assert.equal(meta.visibility, "organization");
  assert.equal(meta.orgRole, "commenter");
  // Someone in the organization who was never a Miro board member.
  const joined = await boards.call(viewer, { op: "join", room: shared.room });
  assert.equal(joined.member.role, "commenter");
  assert.deepEqual(shared.warnings, []);
  // Team and link access stay closed, and the log says so.
  const team = await migrate({
    access: "view",
    teamAccess: "edit",
    organizationAccess: "private",
  });
  assert.equal(
    (await org.kv.get(`wb:${team.room}:meta`)).visibility ?? "private",
    "private",
  );
  assert.deepEqual(team.warnings, [
    "In Miro, everyone in the board's team could edit it. Share it with those people here if they still need it.",
    "In Miro, anyone with the link could view it. It is not shared by link here; turn link sharing on if it is still needed.",
  ]);
});

test("a board private in Miro stays private when new boards start open to the organization", async () => {
  const { boards, call, org } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  await call(owner, {
    op: "org.policy.set",
    policy: { defaultVisibility: "organization" },
  });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(viewer, { op: "org.join", token });
  const { input, room } = createInput("Miro board");
  await boards.call(owner, { ...input, source: "miro" });
  assert.equal(
    (await org.kv.get(`wb:${room}:meta`)).visibility,
    "organization",
  );
  await call(owner, {
    op: "migration.apply",
    room,
    members: [{ email: "dan@fabrikam.test", role: "owner" }],
    source: {
      boardId: "m6",
      sharing: { access: "private", organizationAccess: "private" },
    },
  });
  assert.equal((await org.kv.get(`wb:${room}:meta`)).visibility, "private");
  await assert.rejects(boards.call(viewer, { op: "join", room }), {
    status: 403,
  });
  const listed = await call(viewer, {
    op: "org.boards",
    scope: "organization",
  });
  assert.deepEqual(listed.boards, []);
});

test("migrated boards go into a space named for their Miro team", async () => {
  const { boards, call, org } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  const { space: existing } = await call(owner, {
    op: "spaces.create",
    name: "Design",
  });
  const migrate = async (teamName) => {
    const { input, room } = createInput("Miro board");
    await boards.call(owner, input);
    await call(owner, {
      op: "migration.apply",
      room,
      members: [{ email: "dan@fabrikam.test", role: "owner" }],
      source: { boardId: room, teamId: "t", teamName },
    });
    return (await org.kv.get("org:board:" + room)).space;
  };
  const [a, b, c] = [
    await migrate("Platform"),
    await migrate("Platform"),
    await migrate("design"),
  ];
  assert.ok(a);
  assert.equal(b, a, "one space for the team");
  assert.equal(c, existing.id, "an existing space is used");
  const names = (await org.list("org:space:")).map((r) => r.value.name).sort();
  assert.deepEqual(names, ["Design", "Platform"]);
});

test("comments are board content, exported to a SIEM only when content is", () => {
  assert.equal(auditCategory("board.comment.created"), "content");
  const categories = normalizePolicy().siem.categories;
  assert.ok(!categories.includes(auditCategory("board.comment.created")));
});

test("parallel verification requests share the hourly email limit", async () => {
  const { call, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "guest" });
  await call(guest, { op: "org.join", token });
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, () =>
      call(guest, { op: "email.start", email: "someone@example.org" }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(sent.length, 5);
  await assert.rejects(
    call(guest, { op: "email.start", email: "someone@example.org" }),
    { status: 429 },
  );
});

test("a new board is filed only into a space or team that exists", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { team } = await call(owner, { op: "teams.create", name: "Ops" });
  for (const filing of [{ team: "no-such-team" }, { space: "../../x" }]) {
    const { input, room } = createInput();
    await assert.rejects(boards.call(owner, { ...input, ...filing }), {
      status: 400,
    });
    assert.equal(await org.kv.get("org:board:" + room), null);
  }
  const { input, room } = createInput();
  await boards.call(owner, { ...input, team: team.id });
  const record = await org.kv.get("org:board:" + room);
  assert.equal(record.team, team.id);
  assert.equal(record.space, null);
});

test("verification emails and code guesses for one address are limited across accounts", async () => {
  const { call, sent, env } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const people = [];
  for (let n = 0; n < 5; n++) {
    const person = {
      uuid: `55555555-5555-4555-8555-55555555555${n}`,
      username: `person${n}`,
    };
    const { token } = await call(owner, { op: "org.invite", role: "member" });
    await call(person, { op: "org.join", token });
    people.push(person);
  }
  const email = "target@example.org";
  // Everyone has a code first; then sends at once, counted atomically,
  // fill the address's remaining five.
  for (const person of people) await call(person, { op: "email.start", email });
  const starts = await Promise.allSettled(
    people.flatMap((person) =>
      Array.from({ length: 2 }, () =>
        call(person, { op: "email.start", email }),
      ),
    ),
  );
  assert.equal(starts.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(sent.length, 10);
  // Each account's latest code is guessed wrong five times; together they
  // reach the address's limit, which then refuses even the right code.
  const statuses = [];
  for (const person of people)
    for (let n = 0; n < 5; n++)
      statuses.push(
        await call(person, { op: "email.confirm", code: "x" }).catch(
          (e) => e.status,
        ),
      );
  assert.deepEqual(statuses, [...Array(20).fill(400), ...Array(5).fill(429)]);
  env.now += 3600_000;
  await call(people[0], { op: "email.start", email });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  const { user } = await call(people[0], { op: "email.confirm", code });
  assert.equal(user.email, email);
});

test("changing a verified email frees the previous address", async () => {
  const { call, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const user of [editor, viewer]) {
    const { token } = await call(owner, { op: "org.invite", role: "member" });
    await call(user, { op: "org.join", token });
  }
  const verify = async (user, email) => {
    await call(user, { op: "email.start", email });
    const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
    return call(user, { op: "email.confirm", code });
  };
  await verify(editor, "inbox@fabrikam.test");
  await verify(editor, "bob@fabrikam.test");
  const { user } = await verify(viewer, "inbox@fabrikam.test");
  assert.equal(user.email, "inbox@fabrikam.test");
  await assert.rejects(verify(viewer, "bob@fabrikam.test"), { status: 409 });
});

test("only the board owner or an administrator connects a board to Slack", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "facilitator",
  });
  await join({ service: boards }, editor, { room, token });
  const hook = "https://hooks.slack.com/services/T/B/x";
  // Nobody connects a channel while the organization has Slack off.
  await assert.rejects(
    boards.call(owner, { op: "settings", room, slack: hook }),
    { status: 403, message: "Your organization has turned off Slack." },
  );
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { slack: { enabled: true } } },
  });
  await assert.rejects(
    boards.call(editor, { op: "settings", room, slack: hook }),
    { status: 403 },
  );
  const asFacilitator = await boards.call(editor, {
    op: "settings.get",
    room,
  });
  assert.equal(asFacilitator.settings.integrations, false);
  await boards.call(owner, { op: "settings", room, slack: hook });
  const { settings } = await boards.call(owner, { op: "settings.get", room });
  assert.equal(settings.slack, true);
  assert.equal(settings.integrations, true);
  await boards.call(owner, { op: "settings", room, slack: "" });
  assert.equal(await org.kv.get("org:boardslack:" + room), null);
  const { entries } = await call(owner, {
    op: "org.audit",
    action: "board.share.slack",
  });
  assert.deepEqual(entries.map((e) => e.details.connected).sort(), [
    false,
    true,
  ]);
});

test("the SIEM token is never sent to a new endpoint without being re-entered", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const siem = (url) => ({ siem: { mode: "https", url } });
  await call(owner, {
    op: "org.policy.set",
    policy: siem("https://siem.fabrikam.test/in"),
    secrets: { "siem-token": "secret" },
  });
  // Another path on the same host keeps the token.
  await call(owner, {
    op: "org.policy.set",
    policy: siem("https://siem.fabrikam.test/v2"),
  });
  await assert.rejects(
    call(owner, {
      op: "org.policy.set",
      policy: siem("https://attacker.example/collect"),
    }),
    { status: 400 },
  );
  assert.equal((await org.policy()).siem.url, "https://siem.fabrikam.test/v2");
  await call(owner, {
    op: "org.policy.set",
    policy: siem("https://siem2.fabrikam.test/in"),
    secrets: { "siem-token": "new" },
  });
  assert.equal(await org.secret("siem-token"), "new");
  // A token field that is not text replaces nothing, so it is no new token.
  for (const value of [true, 1, {}])
    await assert.rejects(
      call(owner, {
        op: "org.policy.set",
        policy: siem("https://attacker.example/collect"),
        secrets: { "siem-token": value },
      }),
      { status: 400 },
    );
  assert.equal((await org.policy()).siem.url, "https://siem2.fabrikam.test/in");
  // Clearing the endpoint sends the token nowhere, so it needs no token.
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "none", url: "" } },
  });
  assert.equal((await org.policy()).siem.url, "");
});

test("the SIEM endpoint must be a public internet address", async () => {
  const { call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const url of [
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/in",
    "https://localhost/in",
  ])
    await assert.rejects(
      call(owner, {
        op: "org.policy.set",
        policy: { siem: { mode: "https", url } },
      }),
      { status: 400 },
    );
  // An endpoint saved before this check is refused when sending.
  const meta = await org.kv.get("org:meta");
  meta.policy.siem = {
    ...meta.policy.siem,
    mode: "https",
    url: "https://169.254.169.254/latest/meta-data/",
  };
  await org.kv.set("org:meta", meta);
  await assert.rejects(call(owner, { op: "org.siem.test" }));
  assert.ok(!fetched.some((f) => f.url.includes("169.254")));
});

test("webhooks only go to public internet addresses", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const url of [
    "https://127.0.0.1:8443/admin",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://localhost/",
    "https://api.internal/",
    "https://0x7f.1/",
    // IPv6 addresses carrying a private IPv4 address.
    "https://[2002:7f00:1::]/",
    "https://[2002:a9fe:a9fe::]/",
    "https://[2001:0:4136:e378::]/",
  ])
    await assert.rejects(call(owner, { op: "webhooks.create", url }), {
      status: 400,
    });
  const { webhook } = await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/wb",
  });
  assert.equal(webhook.url, "https://hooks.example.ca/wb");
  await call(owner, {
    op: "webhooks.create",
    url: "https://[2606:4700::1111]/wb",
  });
});

test("CSV exports neutralize spreadsheet formulas", async () => {
  const { toCSV: adminCSV } = await import("../src/organization/admin-ui.js");
  for (const csv of [toCSV, adminCSV]) {
    const out = csv(
      [{ a: '=HYPERLINK("https://x")', b: "@SUM(1)", c: -4, d: "plain" }],
      ["a", "b", "c", "d"],
    );
    assert.equal(
      out.split("\r\n")[1],
      `"'=HYPERLINK(""https://x"")",'@SUM(1),-4,plain`,
    );
    // Where Excel splits cells on semicolons, a formula after one stays
    // inside its quoted cell.
    assert.equal(
      csv([{ a: "Plan;=cmd|' /C calc'!A0" }], ["a"]).split("\r\n")[1],
      `"Plan;=cmd|' /C calc'!A0"`,
    );
  }
});

test("admin CSV exports name computed columns in the header", async () => {
  const { toCSV: adminCSV } = await import("../src/organization/admin-ui.js");
  const out = adminCSV(
    [{ username: "ann", lastActive: 1 }],
    [
      "username",
      [
        "lastActive",
        (u) => u.lastActive && new Date(u.lastActive).toISOString(),
      ],
    ],
  );
  assert.deepEqual(out.slice(1).split("\r\n"), [
    "username,lastActive",
    "ann,1970-01-01T00:00:00.001Z",
  ]);
});

test("the owner verifying an email is not counted as a guest member", async () => {
  const { call, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, { op: "email.start", email: "alice@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  // Email is in both languages, English first.
  assert.match(sent.at(-1).subject, /verification code \/ Votre code/);
  assert.match(
    sent.at(-1).text,
    /\n---\n\nVotre code de vérification est \d{6}/,
  );
  const { info } = await call(owner, { op: "email.confirm", code });
  assert.equal(info.role, "owner");
  assert.equal(info.user.emailVerified, true);
  const { users } = await call(owner, { op: "org.users.list" });
  assert.deepEqual(users, []);
  const report = await call(owner, { op: "org.reports" });
  assert.equal(report.users.total, 1);
  assert.equal(report.users.guests, 0);
});

test("deactivated guests and administrators count as deactivated only", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const [user, role] of [
    [editor, "guest"],
    [viewer, "admin"],
    [guest, "guest"],
  ]) {
    const { token } = await call(owner, { op: "org.invite", role });
    await call(user, { op: "org.join", token });
  }
  for (const user of [editor, viewer])
    await call(owner, {
      op: "org.users.update",
      uuid: user.uuid,
      status: "deactivated",
    });
  const report = await call(owner, { op: "org.reports" });
  assert.equal(report.users.deactivated, 2);
  assert.equal(report.users.guests, 1);
  assert.equal(report.users.admins, 1);
  assert.match(
    reportSummary(report),
    /Users: 2 active, 2 deactivated, 1 guests/,
  );
});

test("a SCIM demotion when provisioning outlasts older invitations", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  await org.saveUser({
    ...(await org.user(editor.uuid)),
    email: "bob@fabrikam.test",
    emailVerified: true,
  });
  await org.kv.set(
    "org:email:" + (await hash("bob@fabrikam.test")),
    editor.uuid,
  );
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Entra",
    scopes: ["scim"],
  });
  let now = Date.now() + 60_000;
  org.now = () => now;
  await restRoute(
    org,
    boards,
    new Request("https://w.puter.work/scim/v2/Users", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    }),
    "POST",
    "Users",
    { userName: "bob@fabrikam.test", roles: [{ value: "guest" }] },
  );
  assert.equal(await org.role(editor), "guest");
  now += 1000;
  await call(editor, { op: "org.join", token });
  assert.equal(await org.role(editor), "guest");
  // Once deleted, the account cannot be put back into groups by its id.
  const send = (method, path, body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
  await send("DELETE", "Users/" + editor.uuid);
  const group = await (
    await send("POST", "Groups", {
      displayName: "Design",
      members: [{ value: editor.uuid }],
    })
  ).json();
  assert.deepEqual(group.members, []);
});

test("SCIM finds the account owner but never deactivates them", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  await call(owner, { op: "email.start", email: "alice@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  await call(owner, { op: "email.confirm", code });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Entra",
    scopes: ["scim"],
  });
  const scim = (path, method = "GET", body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path.split("?")[0],
      body,
    );
  const created = await (
    await scim("Users", "POST", {
      userName: "alice@fabrikam.test",
      active: true,
    })
  ).json();
  assert.equal(created.roles[0].value, "owner");
  // Discovery answers for one resource type, and lists them all.
  assert.equal(
    (await (await scim("ResourceTypes/User")).json()).endpoint,
    "/Users",
  );
  assert.equal((await (await scim("ResourceTypes")).json()).totalResults, 2);
  await assert.rejects(scim("ResourceTypes/Nope"), { status: 404 });
  const found = await (
    await scim("Users?filter=userName%20eq%20%22alice@fabrikam.test%22")
  ).json();
  assert.equal(found.totalResults, 1);
  await assert.rejects(
    scim("Users/" + created.id, "PATCH", {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "active", value: false }],
    }),
    { status: 400, scimType: "mutability" },
  );
  await assert.rejects(scim("Users/" + created.id, "DELETE"), { status: 400 });
  // Names still follow the provider.
  const renamed = await (
    await scim("Users/" + created.id, "PATCH", {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", path: "displayName", value: "Alice A" }],
    })
  ).json();
  assert.equal(renamed.displayName, "Alice A");
  assert.equal(renamed.active, true);
  assert.equal(await org.role(owner), "owner");
});

test("only a SCIM key the account owner created changes an administrator's status", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const user of [editor, viewer]) {
    const { token } = await call(owner, { op: "org.invite", role: "member" });
    await call(user, { op: "org.join", token });
  }
  for (const uuid of [editor.uuid, viewer.uuid])
    await call(owner, { op: "org.users.update", uuid, role: "admin" });
  await call(owner, {
    op: "org.users.update",
    uuid: viewer.uuid,
    role: "member",
  });
  const keyOf = async (by) =>
    (await call(by, { op: "apikeys.create", name: "IdP", scopes: ["scim"] }))
      .key;
  const scim = (key, path, method, body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
  const deactivate = {
    schemas: [PATCH_OP],
    Operations: [{ op: "replace", path: "active", value: false }],
  };
  // Another administrator's key cannot deactivate or delete an administrator.
  const adminKey = await keyOf(editor);
  const other = { uuid: "55555555-5555-4555-8555-555555555555" };
  await org.saveUser({
    uuid: other.uuid,
    username: "Eve",
    role: "admin",
    status: "active",
    teams: [],
  });
  await assert.rejects(
    scim(adminKey, "Users/" + other.uuid, "PATCH", deactivate),
    {
      status: 403,
    },
  );
  await assert.rejects(
    scim(adminKey, "Users/" + other.uuid, "PUT", { active: false }),
    { status: 403 },
  );
  await assert.rejects(scim(adminKey, "Users/" + other.uuid, "DELETE"), {
    status: 403,
  });
  assert.equal((await org.user(other.uuid)).status, "active");
  // Changes that leave the status alone, and members, still sync.
  const renamed = await (
    await scim(adminKey, "Users/" + other.uuid, "PUT", {
      displayName: "Eve A",
      active: true,
    })
  ).json();
  assert.equal(renamed.displayName, "Eve A");
  await scim(adminKey, "Users/" + viewer.uuid, "PATCH", deactivate);
  assert.equal((await org.user(viewer.uuid)).status, "deactivated");
  // The owner's key deprovisions administrators who leave.
  const ownerKey = await keyOf(owner);
  await scim(ownerKey, "Users/" + other.uuid, "PATCH", deactivate);
  assert.equal((await org.user(other.uuid)).status, "deactivated");
  await scim(ownerKey, "Users/" + editor.uuid, "DELETE");
  assert.equal(await org.role(editor), null);
});

test("notification emails are in both languages", async () => {
  const { call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await org.saveUser({
    uuid: editor.uuid,
    username: "Bob",
    role: "member",
    status: "active",
    email: "bob@fabrikam.test",
    emailVerified: true,
    teams: [],
  });
  await org.notify(editor.uuid, {
    type: "assignment",
    board: "room",
    boardTitle: "Sprint",
    actor: { uuid: owner.uuid, username: "Alice" },
    title: "Write the brief",
    due: "2026-10-01",
  });
  await org.flush();
  const message = sent.at(-1);
  assert.equal(
    message.subject,
    "Alice assigned you a task on Sprint / Alice vous a assigné une tâche dans Sprint",
  );
  assert.match(
    message.text,
    /^\(Le français suit\.\)\n\nAlice: Write the brief \(due 2026-10-01\)\n\n---\n\nAlice : Write the brief \(échéance le 2026-10-01\)$/,
  );
  // Several tasks given in one edit arrive as one message.
  for (const more of [1, 4]) {
    await org.notify(editor.uuid, {
      type: "assignment",
      board: "room",
      boardTitle: "Sprint",
      actor: { uuid: owner.uuid, username: "Alice" },
      title: "Write the brief",
      more,
    });
    await org.flush();
  }
  assert.equal(
    sent.at(-1).subject,
    "Alice assigned you tasks on Sprint / Alice vous a assigné des tâches dans Sprint",
  );
  assert.match(sent.at(-2).text, /Write the brief and 1 more\n/);
  assert.match(sent.at(-2).text, /Write the brief et 1 autre$/);
  assert.match(sent.at(-1).text, /Write the brief et 4 autres$/);
  // A long board title leaves room for the French half of the subject.
  await org.notify(editor.uuid, {
    type: "mention",
    board: "room",
    boardTitle: "Q".repeat(150),
    actor: { uuid: owner.uuid, username: "Alice" },
    excerpt: "Look",
  });
  await org.flush();
  assert.match(sent.at(-1).subject, /Alice vous a mentionné dans Q+…$/);
});

test("security alert emails keep each language in its own half", async () => {
  const { call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      alerts: { permissionChanges: true, emails: ["sec@fabrikam.test"] },
    },
  });
  await org.flush();
  sent.length = 0;
  for (const name of ["first", "second"])
    await call(owner, { op: "apikeys.create", name, scopes: ["audit:read"] });
  await org.flush();
  const alert = sent.find((m) => m.subject.startsWith("Whiteboard security"));
  const [english, french] = alert.text.split("\n---\n");
  assert.equal(english.match(/An API key was created/g).length, 2);
  assert.doesNotMatch(english, /clé d’API/);
  assert.equal(french.match(/Une clé d’API a été créée/g).length, 2);
});

test("giving a board a new owner raises a permissions alert, one by one or in bulk", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      alerts: { permissionChanges: true, emails: ["sec@fabrikam.test"] },
    },
  });
  const first = createInput("First"),
    second = createInput("Second");
  await boards.call(editor, first.input);
  await boards.call(editor, second.input);
  await org.flush();
  sent.length = 0;
  await boards.call(editor, {
    op: "transfer",
    room: first.room,
    uuid: owner.uuid,
  });
  await org.flush();
  const alerts = () =>
    sent.filter((m) => m.subject.startsWith("Whiteboard security"));
  assert.equal(alerts().length, 1);
  const [english, french] = alerts()[0].text.split("\n---\n");
  assert.match(english, /A board was given a new owner: Bob/);
  assert.match(french, /Un tableau a un nouveau propriétaire : Bob/);
  const notes = await call(owner, { op: "notifications.list" });
  assert.ok(
    notes.items.some(
      (n) =>
        n.type === "alert" &&
        n.action === "board.transfer" &&
        n.board === first.room,
    ),
  );
  // Handing over everything someone owns alerts too.
  sent.length = 0;
  await call(owner, {
    op: "org.users.transfer",
    from: editor.uuid,
    to: owner.uuid,
  });
  await org.flush();
  assert.match(alerts()[0].text, /A board was given a new owner/);
});

test("audit retention works through a backlog in several batches", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const old = Date.now() - 400 * 86_400_000;
  for (let n = 0; n < 25; n++) {
    const time = new Date(old + n).toISOString();
    await org.kv.set(`org:audit:${time}:${n}`, { id: `${time}:${n}`, time });
  }
  assert.deepEqual(await purge(org, { batch: 10, rounds: 2 }), {
    audit: 20,
    boards: 0,
    more: true,
  });
  const second = await purge(org, { batch: 10, rounds: 2 });
  assert.equal(second.audit, 5);
  assert.equal(second.more, false);
});

test("audit retention keeps up with a busy organization", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const old = Date.now() - 400 * 86_400_000;
  // A day's worth of expired records for an organization that records
  // 30,000 events a day.
  for (let n = 0; n < 1200; n++) {
    const time = new Date(old + n).toISOString();
    await org.kv.set(`org:audit:${time}:${n}`, { id: `${time}:${n}`, time });
  }
  // Requests over one hour work through the backlog. Housekeeping times
  // are kept per worker instance, which other tests share.
  org.caches.purged = 0;
  const start = Date.now();
  for (let minute = 0; minute <= 60; minute++) {
    org.now = () => start + 2 * 3600_000 + minute * 60_000;
    await org.scheduledWork();
  }
  const left = (await org.list("org:audit:")).filter(
    (row) => row.value.time < new Date(old + 1200).toISOString(),
  );
  assert.equal(left.length, 0);
});

test("a large deleted board is purged over several quick runs", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  for (let n = 0; n < 30; n++)
    await org.kv.set(`wb:${room}:log:${String(n).padStart(4, "0")}`, { n });
  await boards.call(owner, { op: "delete", room });
  org.now = () => Date.now() + 40 * 86_400_000;
  let deletes = 0;
  const del = org.kv.del.bind(org.kv);
  org.kv.del = (key) => (deletes++, del(key));
  let runs = 0,
    result;
  do {
    deletes = 0;
    result = await purge(org, { budget: 10 });
    runs++;
    assert.ok(deletes <= 10 + 6, `${deletes} deletions in one run`);
  } while (result.more && runs < 20);
  org.kv.del = del;
  assert.ok(runs > 3, "The board took several runs");
  assert.equal(await org.kv.get("org:board:" + room), null);
  assert.deepEqual(await org.list(`wb:${room}:`), []);
  const purged = (await call(owner, { op: "org.audit" })).entries.filter(
    (e) => e.action === "board.purged",
  );
  assert.equal(purged.length, 1);
});

test("a board being purged can no longer be restored or held", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  for (let n = 0; n < 30; n++)
    await org.kv.set(`wb:${room}:log:${String(n).padStart(4, "0")}`, { n });
  await boards.call(owner, { op: "delete", room });
  const now = Date.now() + 40 * 86_400_000;
  org.now = boards.now = () => now;
  // Only the runs below purge; requests do not run housekeeping meanwhile.
  org.caches.purged = now;
  // The first run removes the board's earliest records and edits.
  assert.equal((await purge(org, { budget: 10 })).more, true);
  for (const op of ["restore", "hold"])
    await assert.rejects(boards.call(owner, { op, room, enabled: true }), {
      status: 409,
      message: "This board is being permanently deleted.",
    });
  const record = await org.kv.get("org:board:" + room);
  assert.ok(record.deleted);
  assert.equal(record.legalHold, false);
  let runs = 0;
  while ((await purge(org, { budget: 10 })).more && runs++ < 20);
  assert.equal(await org.kv.get("org:board:" + room), null);
  // A copy of the board read just before it was purged brings back none of
  // it.
  for (const op of ["restore", "hold"])
    await assert.rejects(boards.call(owner, { op, room, enabled: true }), {
      status: 404,
    });
  assert.equal(await org.kv.get("org:board:" + room), null);
  assert.deepEqual(await org.list(`wb:${room}:`), []);
});

test("deleting a board again keeps the time it went to the trash", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const start = Date.now();
  org.now = boards.now = () => start;
  await boards.call(owner, { op: "delete", room });
  org.now = boards.now = () => start + 29 * 86_400_000;
  await boards.call(owner, { op: "delete", room });
  assert.equal((await org.kv.get("org:board:" + room)).deleted, start);
  assert.equal((await org.kv.get(`wb:${room}:meta`)).deleted, start);
  const deletions = (await call(owner, { op: "org.audit" })).entries.filter(
    (e) => e.action === "board.deleted",
  );
  assert.equal(deletions.length, 1);
  // The retention period still counts from the first deletion.
  org.now = boards.now = () => start + 40 * 86_400_000;
  org.caches.purged = org.now();
  await purge(org);
  assert.equal(await org.kv.get("org:board:" + room), null);
});

test("a hold or restore made during a purge run keeps the board", async () => {
  for (const op of ["hold", "restore"]) {
    const { boards, call, org } = setup();
    await call(owner, { op: "org.setup", name: "Fabrikam" });
    const { input, room } = createInput("Evidence");
    await boards.call(owner, input);
    await boards.call(owner, { op: "delete", room });
    const now = Date.now() + 40 * 86_400_000;
    org.now = boards.now = () => now;
    org.caches.purged = now;
    // The request lands after the run has read the board directory.
    const list = org.kv.list.bind(org.kv);
    let fired = false;
    org.kv.list = async (options) => {
      if (!fired && options.pattern === "org:audit:") {
        fired = true;
        await boards.call(owner, { op, room, enabled: true });
      }
      return list(options);
    };
    assert.equal((await purge(org)).boards, 0);
    org.kv.list = list;
    const record = await org.kv.get("org:board:" + room);
    assert.ok(record, op);
    assert.ok(!record.purging, op);
    assert.ok(await org.kv.get(`wb:${room}:meta`), op);
    // The board is not stuck being purged.
    await boards.call(owner, { op: "archive", room });
  }
});

test("board settings and governance keep changes made meanwhile", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  // A copy of the board's metadata read before the hold was placed.
  const stale = await org.kv.get(`wb:${room}:meta`);
  await boards.call(owner, { op: "hold", room, enabled: true });
  await boards.updateSettings(room, owner, stale, {
    visibility: "organization",
  });
  const meta = await org.kv.get(`wb:${room}:meta`);
  assert.equal(meta.legalHold, true);
  assert.equal(meta.visibility, "organization");
  const member = await org.kv.get(`wb:${room}:member:${owner.uuid}`);
  await assert.rejects(
    boards.govern(room, owner, stale, member, { op: "delete" }),
    { status: 409 },
  );
});

test("organization board lists read many boards in a few requests", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (let n = 0; n < 450; n++) {
    const room = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await org.registerBoard(room, {
      title: `Board ${n}`,
      visibility: "organization",
      owner: owner.uuid,
    });
    // One match early and one past the first 400 boards.
    await org.kv.set(
      "org:idx:" + room,
      n === 7 || n === 440 ? "needle text" : "other",
    );
  }
  let requests = 0;
  const { get, list } = org.kv;
  org.kv.get = (...args) => (requests++, get.apply(org.kv, args));
  org.kv.list = (...args) => (requests++, list.apply(org.kv, args));
  const { boards } = await call(owner, {
    op: "org.boards",
    scope: "organization",
    limit: 1000,
  });
  assert.equal(boards.length, 450);
  const found = await call(owner, {
    op: "org.boards",
    scope: "organization",
    query: "needle",
    content: true,
  });
  assert.deepEqual(found.boards.map((b) => b.title).sort(), [
    "Board 440",
    "Board 7",
  ]);
  // The test store pages 3 rows at a time; reading each board would take
  // well over 1,000 requests here.
  assert.ok(requests < 1000, `${requests} requests`);
  // A person's own boards are read one by one, not by listing everything.
  for (let n = 0; n < 60; n++) {
    const room = `00000000-0000-4000-8000-${String(n * 7).padStart(12, "0")}`;
    await org.kv.set(`org:ub:${editor.uuid}:${room}`, "editor");
    await org.kv.set(`wb:${room}:meta`, { owner: owner.uuid });
    await org.kv.set(`wb:${room}:member:${editor.uuid}`, {
      uuid: editor.uuid,
      role: "editor",
    });
  }
  const listed = [];
  org.kv.list = (options) => (
    listed.push(options.pattern),
    list.call(org.kv, options)
  );
  const mine = await call(editor, {
    op: "org.boards",
    scope: "mine",
    query: "needle",
    content: true,
  });
  assert.deepEqual(
    mine.boards.map((b) => b.title),
    ["Board 7"],
  );
  assert.ok(!listed.some((p) => /^org:(board|idx):/.test(p)), listed.join());
  org.kv.get = get;
  org.kv.list = list;
});

test("reports count every inactive member and only active accounts", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (let n = 0; n < 510; n++)
    await org.saveUser({
      uuid: `member-${n}`,
      username: `m${n}`,
      role: "member",
      status: "active",
      teams: [],
    });
  await org.saveUser({
    uuid: "gone",
    username: "gone",
    role: "member",
    status: "deactivated",
    lastActive: org.now(),
    teams: [],
  });
  const report = await call(owner, { op: "org.reports" });
  assert.equal(report.users.inactiveCount, 510);
  assert.equal(report.users.inactive.length, 510);
  assert.equal(report.users.activeLast30Days, 0, "deactivated not counted");
});

test("the inactive users export lists everyone past the report's first 5,000", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (let n = 0; n < 5003; n++)
    await org.saveUser({
      uuid: `member-${n}`,
      username: `m${n}`,
      role: "member",
      status: "active",
      teams: [],
    });
  const report = await call(owner, { op: "org.reports" });
  assert.equal(report.users.inactiveCount, 5003);
  assert.equal(report.users.inactive.length, 5000);
  const all = await call(owner, { op: "org.reports", allInactive: true });
  assert.equal(all.users.inactive.length, 5003);
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Reports",
    scopes: ["reports:read"],
  });
  const res = await restRoute(
    org,
    boards,
    new Request("https://w.puter.work/v1/reports/users.csv", {
      headers: { Authorization: `Bearer ${key}` },
    }),
    "GET",
    "reports/users.csv",
  );
  const lines = (await res.text()).trim().split("\n");
  assert.equal(lines.length, 5004, "a header and every inactive person");
});

test("the report email averages daily active users over full days", () => {
  const day = (value) => ({ date: "2026-09-01", value });
  const text = reportSummary({
    generated: Date.parse("2026-09-08T01:00:00Z"),
    days: 7,
    users: {
      active: 1,
      deactivated: 0,
      guests: 0,
      activeLast30Days: 1,
      inactive: [],
    },
    usage: { dailyActiveUsers: [...Array(6).fill(day(70)), day(1)] },
    boards: { total: 0, activeLast30Days: 0, stale: 0, empty: 0 },
    sharing: { organizationVisible: 0, publicLinks: 0, withGuests: 0 },
    sessions: { largest: [] },
  });
  assert.match(text, /Average daily active users \(6 full days\): 70/);
});

test("a scheduled report that fails to send is tried again", async () => {
  const { call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { reports: { schedule: "weekly", emails: ["ops@fabrikam.test"] } },
  });
  const send = org.puter.email.sendTransactional;
  org.puter.email.sendTransactional = async () => {
    throw Error("Mail service unavailable");
  };
  await assert.rejects(sendScheduledReport(org));
  org.puter.email.sendTransactional = send;
  assert.equal(await sendScheduledReport(org), true);
  assert.match(sent.at(-1).subject || JSON.stringify(sent.at(-1)), /weekly/);
  assert.match(sent.at(-1).subject, /Rapport hebdomadaire/);
  assert.match(sent.at(-1).text, /Rapport de l’organisation Whiteboard/);
});

test("a scheduled report needs at least one recipient", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await assert.rejects(
    call(owner, {
      op: "org.policy.set",
      policy: { reports: { schedule: "monthly", emails: [] } },
    }),
    { status: 400, message: /at least one recipient/ },
  );
  const { policy } = await call(owner, { op: "org.policy.get" });
  assert.equal(policy.reports.schedule, "none");
  // Turning the schedule off needs no recipients.
  await call(owner, {
    op: "org.policy.set",
    policy: { reports: { schedule: "none", emails: [] } },
  });
});

test("two worker instances send a scheduled report once", async () => {
  const { OrgService } = await import("../worker/org.js");
  const { call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { reports: { schedule: "weekly", emails: ["ops@fabrikam.test"] } },
  });
  const before = sent.length;
  const results = await Promise.all([
    sendScheduledReport(new OrgService(org.puter)),
    sendScheduledReport(new OrgService(org.puter)),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(sent.length, before + 1);
});

test("restricting boards to members ends access for guests who joined", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
    guest: true,
  });
  await boards.call(guest, { op: "join", room, token });
  await boards.call(guest, { op: "sync", room });
  await call(owner, {
    op: "org.policy.set",
    policy: { restrictToOrganization: true },
  });
  await assert.rejects(boards.call(guest, { op: "sync", room }), {
    status: 403,
  });
  // A guest who joins the organization is a member, whatever the board
  // recorded when they first joined, and a member made a guest is not.
  await call(owner, {
    op: "org.users.update",
    uuid: guest.uuid,
    role: "member",
  });
  await boards.call(guest, { op: "sync", room });
  await call(owner, {
    op: "org.users.update",
    uuid: guest.uuid,
    role: "guest",
  });
  await assert.rejects(boards.call(guest, { op: "sync", room }), {
    status: 403,
  });
});

test("a SIEM test always delivers a siem.test record", async () => {
  const { call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "https", url: "https://siem.fabrikam.test/in" } },
  });
  // Events are still waiting to be exported.
  await call(owner, { op: "org.siem.test" });
  const posted = fetched.filter(
    (f) => f.url === "https://siem.fabrikam.test/in",
  );
  const actions = JSON.parse(posted.at(-1).options.body).events.map(
    (e) => e.Action ?? e.action,
  );
  assert.ok(actions.includes("siem.test"), actions.join());
});

test("a SIEM test needs a destination", async () => {
  const { call, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await assert.rejects(call(owner, { op: "org.siem.test" }), {
    message: /Choose a SIEM destination/,
  });
  assert.equal(fetched.length, 0);
});

test("audit events an export missed reach the SIEM without another audited change", async () => {
  const { env, boards, call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      siem: {
        mode: "https",
        url: "https://siem.fabrikam.test/in",
        categories: ["admin", "security", "access", "sharing", "content"],
      },
    },
  });
  const { input, room } = createInput("Board");
  await boards.call(owner, input);
  await org.flush();
  const exported = () =>
    fetched
      .filter((f) => f.url === "https://siem.fabrikam.test/in")
      .flatMap((f) => JSON.parse(f.options.body).events.map((e) => e.Action));
  // A content event just after an export waits for the interval to pass.
  await org.audit(owner, "board.export", { type: "board", id: room });
  await org.flush();
  assert.ok(!exported().includes("board.export"));
  env.now += 15_000;
  await boards.call(owner, { op: "members", room });
  assert.ok(exported().includes("board.export"), exported().join());
  // A sharing, role, or administration change goes at once.
  await call(owner, { op: "org.invite", role: "member" });
  await org.flush();
  assert.ok(exported().includes("user.invited"), exported().join());
  // One the SIEM refused is sent again once it recovers.
  let down = true;
  const base = org.fetcher;
  org.fetcher = boards.fetcher = (url, options) =>
    down && String(url).startsWith("https://siem.fabrikam.test")
      ? Promise.resolve(new Response("busy", { status: 503 }))
      : base(url, options);
  env.now += 15_000;
  await call(owner, { op: "org.invite", role: "admin" });
  await org.flush();
  assert.match((await org.kv.get("org:siem:status")).lastError, /503/);
  down = false;
  env.now += 15_000;
  await boards.call(owner, { op: "members", room });
  assert.equal(exported().filter((a) => a === "user.invited").length, 2);
});

test("audit events an export missed reach the SIEM through organization and API requests too", async () => {
  const { env, boards, call, org, fetched } = setup();
  org.now = () => env.now;
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "https", url: "https://siem.fabrikam.test/in" } },
  });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Reports",
    scopes: ["reports:read"],
  });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      siem: {
        mode: "https",
        url: "https://siem.fabrikam.test/in",
        categories: ["admin", "security", "access", "sharing", "content"],
      },
    },
  });
  await org.flush();
  const exports = () =>
    fetched
      .filter((f) => f.url === "https://siem.fabrikam.test/in")
      .flatMap((f) => JSON.parse(f.options.body).events)
      .filter((e) => e.Action === "board.export")
      .map((e) => e.Details.format);
  const ask = (input) => organizationRequest(org, boards, owner, input);
  const exported = async (format) => {
    await org.audit(
      owner,
      "board.export",
      { type: "board", id: "b" },
      { format },
    );
    await org.flush();
  };
  // A content event just after an export waits for the interval to pass,
  // then goes out with the next request to the console.
  env.now += 15_000;
  await exported("pdf");
  env.now += 2_000;
  await exported("png");
  assert.deepEqual(exports(), ["pdf"]);
  env.now += 15_000;
  await ask({ op: "org.info" });
  assert.deepEqual(exports(), ["pdf", "png"]);
  // Likewise through the REST API.
  env.now += 15_000;
  await exported("svg");
  env.now += 2_000;
  await exported("pptx");
  assert.deepEqual(exports(), ["pdf", "png", "svg"]);
  env.now += 15_000;
  await restRequest(
    org,
    boards,
    new Request("https://w.puter.work/v1/reports", {
      headers: { Authorization: `Bearer ${key}` },
    }),
    "GET",
    "reports",
    null,
  );
  assert.deepEqual(exports(), ["pdf", "png", "svg", "pptx"]);
});

test("an administrator invitation promotes an existing member", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const member = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token: member.token });
  const admin = await call(owner, { op: "org.invite", role: "admin" });
  const { user } = await call(editor, { op: "org.join", token: admin.token });
  assert.equal(user.role, "admin");
  assert.equal(await org.role(editor), "admin");
  const changes = (await org.list("org:audit:")).filter(
    (r) => r.value.action === "user.role.changed",
  );
  assert.deepEqual(changes.at(-1).value.details, {
    from: "member",
    to: "admin",
    source: "invite",
  });
  // A member invitation leaves an administrator as they are.
  await call(editor, { op: "org.join", token: member.token });
  assert.equal(await org.role(editor), "admin");
  // Reusing an invitation never undoes a later role change.
  let now = Date.now() + 60_000;
  org.now = () => now;
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "member",
  });
  await call(editor, { op: "org.join", token: admin.token });
  assert.equal(await org.role(editor), "member");
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "guest",
  });
  await call(editor, { op: "org.join", token: member.token });
  assert.equal(await org.role(editor), "guest");
  // A newer invitation still applies.
  now += 1000;
  const again = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token: again.token });
  assert.equal(await org.role(editor), "admin");
});

test("audit export and search reach every record of a busy day", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const day = "2026-01-15";
  for (let n = 0; n < 5010; n++) {
    const id = `${day}T00:00:${String(n % 60).padStart(2, "0")}.000Z:${String(n).padStart(6, "0")}`;
    await org.kv.set("org:audit:" + id, {
      id,
      at: Date.parse(day),
      action: "board.joined",
      category: "board",
    });
  }
  org.now = () => Date.parse(day + "T12:00:00Z");
  const all = await unsentAudit(org, null, 6000);
  const cursor = all[4999].id;
  assert.equal((await unsentAudit(org, cursor)).length, 10);
  const oldest = await call(owner, {
    op: "org.audit",
    from: day,
    to: day + "T23:59:59.999Z",
    cursor: all[10].id,
    limit: 500,
  });
  assert.deepEqual(
    oldest.entries.map((e) => e.id),
    all
      .slice(0, 10)
      .map((e) => e.id)
      .reverse(),
  );
});

test("audit export and paging read little beyond the records they return", async () => {
  const { call, org, env } = setup();
  env.now = Date.parse("2026-09-26T00:00:01Z");
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (let n = 0; n < 1500; n++) {
    env.now += 20_000;
    await org.audit(owner, "team.updated", { type: "team", id: "t" });
  }
  org.pending.length = 0;
  let read = 0;
  const list = org.kv.list.bind(org.kv);
  org.kv.list = async (options) => {
    const page = await list(options);
    if (options.pattern.startsWith("org:audit:2")) read += page.items.length;
    return page;
  };
  const all = await unsentAudit(org, null, 2000);
  read = 0;
  assert.equal((await unsentAudit(org, all.at(-2).id)).length, 1);
  assert.ok(read < 20, `${read} rows read to export one record`);
  read = 0;
  let cursor = null,
    total = 0;
  do {
    const page = await call(owner, { op: "org.audit", limit: 100, cursor });
    total += page.entries.length;
    cursor = page.cursor;
  } while (cursor);
  assert.equal(total, 1501);
  assert.ok(read < total * 3, `${read} rows read for ${total} records`);
});

test("audit searches skip days before the oldest record", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  let lists = 0;
  const list = org.kv.list.bind(org.kv);
  org.kv.list = (options) => (lists++, list(options));
  const result = await call(owner, { op: "org.audit", from: "1970-01-01" });
  assert.ok(result.entries.some((e) => e.action === "org.created"));
  assert.ok(lists < 10, `${lists} list requests`);
});

test("webhook deliveries run in parallel and failures are retried", async () => {
  const { boards, call, org } = setup();
  let failing = true,
    inFlight = 0,
    overlapped = false,
    release;
  const sentTo = [],
    held = new Promise((resolve) => (release = resolve));
  org.fetcher = boards.fetcher = async (url, options) => {
    if (String(url).startsWith("https://hooks.example.ca/")) {
      sentTo.push(JSON.parse(options.body).event);
      inFlight++;
      if (inFlight > 1) {
        overlapped = true;
        release();
      }
      await held;
      inFlight--;
      return new Response("{}", { status: failing ? 500 : 200 });
    }
    return new Response("{}", { status: 200 });
  };
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/a",
  });
  // A serial implementation must still settle so the overlap assertion can
  // fail. This timer is cleanup, not a performance threshold.
  const unblock = setTimeout(release, 5000);
  try {
    await boards.call(owner, createInput().input);
  } finally {
    clearTimeout(unblock);
    release();
  }
  assert.ok(sentTo.length > 1, "board creation sends several events");
  assert.equal(
    overlapped,
    true,
    "another delivery starts before the first settles",
  );
  const queued = await org.list("org:hookq:");
  assert.equal(queued.length, sentTo.length);
  failing = false;
  org.now = () => Date.now() + 120_000;
  await org.audit(owner, "user.joined", { type: "user", id: owner.uuid });
  await org.flush();
  assert.equal((await org.list("org:hookq:")).length, 0);
});

test("queued webhook events that are due are sent before ones still backing off", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/a",
  });
  await org.flush();
  let failing = true,
    sent = 0;
  org.fetcher = async () => {
    sent++;
    return new Response("", { status: failing ? 503 : 200 });
  };
  let at = Date.now();
  org.now = () => at;
  // A burst while the receiver is down: the first sends fail and back off,
  // the rest wait in the queue to be sent.
  for (let n = 0; n < 40; n++) {
    at += 1;
    await org.audit(owner, "team.updated", { type: "team", id: `t${n}` });
  }
  await org.flush();
  const waiting = (await org.list("org:hookq:")).filter(
    (row) => row.value.next <= at,
  ).length;
  assert.ok(waiting > 0);
  // The receiver recovers; the next request half a minute later sends the
  // events that are due, although failed ones still backing off come first
  // in the queue.
  failing = false;
  sent = 0;
  at += 30_000;
  await org.audit(owner, "team.updated", { type: "team", id: "later" });
  await org.flush();
  assert.equal(sent - 1, Math.min(10, waiting));
});

test("an unreachable webhook never blocks retries to the others", async () => {
  const { call, org } = setup();
  let upFails = true;
  const delivered = [];
  org.fetcher = async (url, options) => {
    if (String(url) === "https://down.example.ca/")
      return new Response("", { status: 503 });
    if (String(url) === "https://up.example.ca/") {
      if (upFails) return new Response("", { status: 500 });
      delivered.push(JSON.parse(options.body).data.target.id);
    }
    return new Response("{}", { status: 200 });
  };
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  // The unreachable receiver sorts first and builds a long queue.
  // Every webhook has a signing secret, as webhooks.create saves.
  const hook = async (id, url) => {
    await org.kv.set("org:hooksecret:" + id, "whsec_test");
    await org.kv.set("org:webhook:" + id, {
      id,
      url,
      events: ["user"],
      enabled: true,
    });
  };
  await hook("0000000000000000", "https://down.example.ca/");
  for (let n = 0; n < 25; n++)
    await org.audit(owner, "user.joined", { type: "user", id: "d" + n });
  await org.flush();
  await hook("ffffffffffffffff", "https://up.example.ca/");
  org.instance.hooks = null;
  await org.audit(owner, "user.joined", { type: "user", id: "early" });
  await org.flush();
  upFails = false;
  const start = Date.now();
  org.now = () => start + 120_000;
  await org.audit(owner, "user.joined", { type: "user", id: "late" });
  await org.flush();
  assert.deepEqual(delivered.sort(), ["early", "late"]);
  await call(owner, { op: "webhooks.delete", id: "0000000000000000" });
  assert.equal((await org.list("org:hookq:")).length, 0);
});

test("a receiver that stops answering delays one request, not every one", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/a",
    events: ["team"],
  });
  let up = false,
    sends = 0;
  const delivered = [];
  org.fetcher = async (url, options) => {
    if (!String(url).startsWith("https://hooks.example.ca/"))
      return new Response("{}");
    sends++;
    if (!up) return new Response("", { status: 504 });
    delivered.push(JSON.parse(options.body).data.target.id);
    return new Response("{}");
  };
  let at = Date.now();
  org.now = () => at;
  await org.audit(owner, "team.created", { type: "team", id: "t0" });
  await org.flush();
  assert.equal(sends, 1);
  // Requests in the next half minute queue their events without waiting.
  for (let n = 1; n <= 5; n++) {
    at += 1000;
    await org.audit(owner, "team.created", { type: "team", id: "t" + n });
    await org.flush();
  }
  assert.equal(sends, 1);
  // Then one request tries again, and once the receiver answers, the queued
  // events follow.
  up = true;
  at += 30_000;
  await org.audit(owner, "team.created", { type: "team", id: "t6" });
  await org.flush();
  at += 1000;
  await org.audit(owner, "team.created", { type: "team", id: "t7" });
  await org.flush();
  assert.deepEqual(delivered.sort(), [
    "t1",
    "t2",
    "t3",
    "t4",
    "t5",
    "t6",
    "t7",
  ]);
  at += 120_000;
  await org.audit(owner, "team.created", { type: "team", id: "t8" });
  await org.flush();
  assert.ok(delivered.includes("t0"));
  assert.equal((await org.list("org:hookq:")).length, 0);
});

test("a failing webhook is tried six times in all", async () => {
  const { call, org } = setup();
  let sends = 0;
  org.fetcher = async (url) => {
    if (String(url) === "https://down.example.ca/") {
      sends++;
      return new Response("", { status: 503 });
    }
    return new Response("{}", { status: 200 });
  };
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  await org.kv.set("org:hooksecret:0000000000000000", "whsec_test");
  await org.kv.set("org:webhook:0000000000000000", {
    id: "0000000000000000",
    url: "https://down.example.ca/",
    events: ["team"],
    enabled: true,
  });
  org.instance.hooks = null;
  const start = Date.now();
  await org.audit(owner, "team.created", { type: "team", id: "t" });
  await org.flush();
  for (let hour = 1; hour <= 10; hour++) {
    org.now = () => start + hour * 3600_000;
    await org.audit(owner, "user.joined", { type: "user", id: "u" + hour });
    await org.flush();
  }
  assert.equal(sends, 6);
  assert.equal((await org.list("org:hookq:")).length, 0);
});

test("a webhook that stays down keeps about a day of events, and requests read only a little of them", async () => {
  const { call, org } = setup();
  org.fetcher = async (url) =>
    new Response("", {
      status: String(url) === "https://down.example.ca/" ? 503 : 200,
    });
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  await org.kv.set("org:hooksecret:0000000000000000", "whsec_test");
  await org.kv.set("org:webhook:0000000000000000", {
    id: "0000000000000000",
    url: "https://down.example.ca/",
    events: ["team"],
    enabled: true,
  });
  org.instance.hooks = null;
  let at = Date.now(),
    read = 0;
  org.now = () => at;
  const page = org.page.bind(org);
  org.page = async (options) => {
    const rows = await page(options);
    if (options.pattern.startsWith("org:hookq:"))
      read += (Array.isArray(rows) ? rows : rows.items).length;
    return rows;
  };
  // An event every five minutes for two days, the receiver down throughout.
  for (let n = 0; n < 576; n++) {
    at += 5 * 60_000;
    read = 0;
    await org.audit(owner, "team.updated", { type: "team", id: "t" + n });
    await org.flush();
  }
  const last = read;
  const queued = await org.list("org:hookq:");
  const oldest = queued[0].value.entry.at;
  assert.ok(
    at - oldest < 86_400_000 + 15 * 60_000,
    `${(at - oldest) / 3600_000} h`,
  );
  assert.ok(queued.length < 300, `${queued.length}`);
  // The last request read the start of the queue and the events that had
  // just turned a day old, not all of it.
  assert.ok(last < 250, `${last}`);
});

test("changing a team rewrites only the people who joined or left it", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const members = [];
  for (let n = 0; n < 40; n++) {
    const uuid = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
    members.push(uuid);
    await org.saveUser({ uuid, role: "member", status: "active", teams: [] });
  }
  const { team } = await call(owner, {
    op: "teams.create",
    name: "Big",
    members: members.slice(0, 39),
  });
  let writes = 0;
  const set = org.kv.set.bind(org.kv);
  org.kv.set = (...args) => (writes++, set(...args));
  await call(owner, { op: "teams.update", id: team.id, members });
  org.kv.set = set;
  assert.ok(writes < 10, `${writes} writes`);
  org.forgetUser(members[39]);
  assert.deepEqual((await org.user(members[39])).teams, [team.id]);
  await call(owner, {
    op: "teams.update",
    id: team.id,
    members: members.slice(1),
  });
  org.forgetUser(members[0]);
  assert.deepEqual((await org.user(members[0])).teams, []);
});

test("a team change naming who joins and leaves keeps members added meanwhile", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const people = ["a", "b", "c", "d"].map(
    (n) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
  );
  for (const uuid of people)
    await org.saveUser({ uuid, role: "member", status: "active", teams: [] });
  const { team } = await call(owner, {
    op: "teams.create",
    name: "Design",
    members: people.slice(0, 2),
  });
  // SCIM adds c after an administrator opened the team; that
  // administrator then adds d and removes a.
  await call(owner, {
    op: "teams.update",
    id: team.id,
    members: people.slice(0, 3),
  });
  const { team: saved } = await call(owner, {
    op: "teams.update",
    id: team.id,
    add: [people[3]],
    remove: [people[0]],
  });
  assert.deepEqual(saved.members.sort(), people.slice(1).sort());
  assert.equal(saved.name, "Design");
  org.forgetUser(people[0]);
  org.forgetUser(people[3]);
  assert.deepEqual((await org.user(people[0])).teams, []);
  assert.deepEqual((await org.user(people[3])).teams, [team.id]);
});

// A person who has opened many organization boards, as seeded directly.
function seedBoards(env, person, count) {
  const rooms = [];
  for (let n = 0; n < count; n++) {
    const room = "room" + String(n).padStart(4, "0");
    rooms.push(room);
    env.data.set(`wb:${room}:meta`, {
      owner: owner.uuid,
      visibility: "organization",
      created: env.now,
      keys: {},
    });
    env.data.set("org:board:" + room, {
      room,
      title: "B" + n,
      owner: owner.uuid,
      visibility: "organization",
      created: env.now,
    });
    env.data.set(`wb:${room}:member:${person.uuid}`, {
      uuid: person.uuid,
      username: person.username,
      role: "editor",
      via: "organization",
    });
    env.data.set(`org:ub:${person.uuid}:${room}`, "editor");
  }
  return rooms;
}
// Storage requests by kind. The test store lists 3 rows a page, so listings
// are left out.
function countRequests(kv) {
  const counts = { total: 0 };
  for (const name of ["get", "set", "del", "update", "incr"]) {
    const original = kv[name].bind(kv);
    counts[name] = 0;
    kv[name] = (...args) => (counts.total++, counts[name]++, original(...args));
  }
  return counts;
}

test("making someone on hundreds of boards a guest recounts their boards in batches", async () => {
  const { env, call, org, boards } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await org.saveUser({
    ...editor,
    role: "member",
    status: "active",
    teams: [],
  });
  const rooms = seedBoards(env, editor, 300);
  const counts = countRequests(org.kv);
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "guest",
  });
  assert.ok(counts.update <= 25, `${counts.update} boards recounted`);
  assert.ok(counts.total < 120, `${counts.total} storage requests`);
  const guests = async () =>
    (await org.list("org:board:")).filter((r) => r.value.guestCount === 1)
      .length;
  const first = await guests();
  assert.ok(first > 0 && first < rooms.length);
  // Later requests count the rest, a batch at a time.
  let at = Date.now();
  boards.now = org.now = () => at;
  for (let n = 0; n < 20 && (await guests()) < rooms.length; n++) {
    at += 31_000;
    await organizationRequest(org, boards, owner, { op: "org.info" });
  }
  assert.equal(await guests(), rooms.length);
  assert.equal((await org.list("org:recount:")).length, 0);
});

test("deactivating someone on hundreds of boards ends only their live sessions", async () => {
  const { env, call, org, boards } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await org.saveUser({
    ...editor,
    role: "member",
    status: "active",
    teams: [],
  });
  const rooms = seedBoards(env, editor, 300);
  const revoked = [];
  boards.fetcher = async (url, options) => {
    if (options?.method === "DELETE")
      revoked.push(String(url).split("/").at(-1));
    return new Response("{}");
  };
  for (const room of rooms.slice(0, 2)) {
    await org.kv.set(`org:uh:${editor.uuid}:${room}`, true);
    await org.kv.set(`wb:${room}:handle:${editor.uuid}`, `handle-${room}`);
    await org.kv.set(`wb:${room}:presence:session`, { user: editor.uuid });
  }
  const counts = countRequests(org.kv);
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  assert.ok(counts.total < 60, `${counts.total} storage requests`);
  assert.deepEqual(revoked.sort(), ["handle-room0000", "handle-room0001"]);
  for (const room of rooms.slice(0, 2))
    assert.equal(await org.kv.get(`wb:${room}:presence:session`), null);
});

test("a role and status change is recorded and ends sessions even if counting boards fails", async () => {
  const { env, call, org, boards } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await org.saveUser({
    ...editor,
    role: "member",
    status: "active",
    teams: [],
  });
  const { input, room } = createInput("Plan");
  await boards.call(owner, input);
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  await boards.call(editor, { op: "join", room });
  await boards.call(editor, { op: "events", room });
  assert.ok(await org.kv.get(`wb:${room}:handle:${editor.uuid}`));
  // Listing a board's members is refused, as under load.
  const list = org.kv.list.bind(org.kv);
  org.kv.list = async (options) => {
    if (/^wb:.*:member:$/.test(options.pattern))
      throw Object.assign(Error("Too many requests"), { status: 429 });
    return list(options);
  };
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "guest",
    status: "deactivated",
  });
  org.kv.list = list;
  const actions = [...env.data.entries()]
    .filter(([key]) => key.startsWith("org:audit:"))
    .map(([, value]) => value.action);
  assert.ok(actions.includes("user.role.changed"));
  assert.ok(actions.includes("user.deactivated"));
  assert.equal(await org.kv.get(`wb:${room}:handle:${editor.uuid}`), null);
});

test("a board made private leaves the lists of members who came with organization sharing", async () => {
  const { call, org, boards } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await org.saveUser({
    ...editor,
    role: "member",
    status: "active",
    teams: [],
  });
  const { input, room } = createInput("Reorg plan");
  await boards.call(owner, input);
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  await boards.call(editor, { op: "join", room });
  const listed = async () =>
    (await call(editor, { op: "org.boards", scope: "mine" })).boards.some(
      (b) => b.room === room,
    );
  assert.equal(await listed(), true);
  await boards.call(owner, { op: "settings", room, visibility: "private" });
  await assert.rejects(boards.call(editor, { op: "join", room }));
  assert.equal(await listed(), false);
  const shared = await call(editor, {
    op: "org.boards",
    scope: "organization",
  });
  assert.ok(!shared.boards.some((b) => b.room === room));
  // Sharing it with the organization again brings it back.
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  assert.equal(await listed(), true);
});

test("content search matches words across a board's title and text, ignoring accents", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (let n = 0; n < 80; n++) {
    const room = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await org.registerBoard(room, {
      title: n === 3 ? "Roadmap" : `Board ${n}`,
      visibility: "organization",
      owner: owner.uuid,
    });
    await org.kv.set(
      "org:idx:" + room,
      n === 3 || n === 5 ? "Notes de l’Équipe produit" : "other text",
    );
  }
  for (const scope of ["organization", "all"]) {
    const found = await call(owner, {
      op: "org.boards",
      scope,
      query: "roadmap equipe",
      content: true,
    });
    assert.deepEqual(
      found.boards.map((b) => b.title),
      ["Roadmap"],
    );
    assert.equal(found.boards[0].text, undefined);
  }
});

test("shared images and files are capped per board and per person each minute", async () => {
  const { env, boards } = setup();
  const { input, room } = createInput("Media");
  await boards.call(owner, input);
  const put = async (n) => {
    const data = "data:image/png;base64," + btoa("image " + n);
    return boards.call(owner, {
      op: "asset.put",
      room,
      asset: await hash(data),
      data,
    });
  };
  await put(0);
  const used = env.data.get(`wb:${room}:assetbytes`);
  assert.ok(used > 0);
  // A board at its limit takes nothing more, and counts nothing for it.
  env.data.set(`wb:${room}:assetbytes`, 1024 ** 3 - 10);
  await assert.rejects(put(1), (error) => error.status === 413);
  assert.equal(env.data.get(`wb:${room}:assetbytes`), 1024 ** 3 - 10);
  env.data.set(`wb:${room}:assetbytes`, used);
  // Sixty a minute from one person, the refused one included.
  for (let n = 2; n < 60; n++) await put(n);
  await assert.rejects(put(60), (error) => error.status === 429);
});

test("large edits kept as files count toward the board's file limit", async () => {
  const { env, boards } = setup();
  const { input, room } = createInput("Media");
  await boards.call(owner, input);
  const text = "x".repeat(19_000);
  const add = (n) =>
    commit(boards, owner, room, (b) => {
      for (let k = 0; k < 20; k++)
        b.items.push(item("note", k * 300, n * 300, { text: text + n }));
    });
  const files = () =>
    [...env.files.keys()].filter((p) => p.includes(`/${room}/updates/`)).length;
  await add(0);
  assert.equal(files(), 1);
  const used = env.data.get(`wb:${room}:assetbytes`);
  assert.ok(used > 240_000);
  // A board at its limit keeps no more of them, and counts nothing for one.
  env.data.set(`wb:${room}:assetbytes`, 1024 ** 3 - 10);
  await assert.rejects(add(1), (error) => error.status === 413);
  assert.equal(env.data.get(`wb:${room}:assetbytes`), 1024 ** 3 - 10);
  assert.equal(files(), 1);
  assert.equal((await boards.load(room)).doc.snapshot().items.length, 21);
});

test("a large edit sent again after a failure counts toward the board's limit once", async () => {
  const { env, boards } = setup();
  const { input, room } = createInput("Media");
  await boards.call(owner, input);
  const { doc } = await boards.load(room);
  const before = doc.vector(),
    next = doc.snapshot();
  for (let k = 0; k < 20; k++)
    next.items.push(item("note", k * 300, 0, { text: "x".repeat(19_000) + k }));
  doc.commit(next);
  const update = doc.update(before);
  doc.destroy();
  const edit = {
    op: "commit",
    room,
    id: await hash(update),
    update: encode(update),
  };
  // The edit's file is written, then its record is not.
  const set = boards.puter.kv.set;
  let failed = false;
  boards.puter.kv.set = async function (key, ...rest) {
    if (!failed && key.includes(":log:")) {
      failed = true;
      throw Object.assign(Error("Busy"), { code: "too_many_requests" });
    }
    return set.call(this, key, ...rest);
  };
  await assert.rejects(boards.call(owner, edit));
  await boards.call(owner, edit);
  assert.equal(env.data.get(`wb:${room}:assetbytes`), edit.update.length);
  boards.puter.kv.set = set;
  // A file write that lands although its answer is lost stays counted.
  const { doc: again } = await boards.load(room);
  const from = again.vector(),
    more = again.snapshot();
  for (let k = 0; k < 20; k++)
    more.items.push(
      item("note", k * 300, 600, { text: "y".repeat(19_000) + k }),
    );
  again.commit(more);
  const second = again.update(from);
  again.destroy();
  const landed = {
    op: "commit",
    room,
    id: await hash(second),
    update: encode(second),
  };
  const write = boards.puter.fs.write;
  let lost = false;
  boards.puter.fs.write = async function (path, ...rest) {
    const result = await write.call(this, path, ...rest);
    if (!lost && path.includes("/updates/")) {
      lost = true;
      throw Error("Connection reset");
    }
    return result;
  };
  await assert.rejects(boards.call(owner, landed));
  await boards.call(owner, landed);
  assert.equal(
    env.data.get(`wb:${room}:assetbytes`),
    edit.update.length + landed.update.length,
  );
});

test("uploading the same file again counts it toward the board's limit once", async () => {
  const { env, boards } = setup();
  const { input, room } = createInput("Media");
  await boards.call(owner, input);
  const data = "data:image/png;base64," + btoa("image ".repeat(500));
  const asset = await hash(data);
  for (let n = 0; n < 3; n++)
    await boards.call(owner, { op: "asset.put", room, asset, data });
  assert.equal(env.data.get(`wb:${room}:assetbytes`), data.length);
  assert.equal(
    (await boards.call(owner, { op: "asset.get", room, asset })).data,
    data,
  );
});

test("moving someone's boards to a new owner goes a batch per request", async () => {
  const { call, org, boards } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await org.saveUser({
    ...editor,
    role: "member",
    status: "active",
    teams: [],
  });
  const rooms = [];
  for (let n = 0; n < 60; n++) {
    const { input, room } = createInput("Board " + n);
    await boards.call(owner, input);
    rooms.push(room);
  }
  // One board cannot move; later batches go past it.
  const transfer = boards.transfer.bind(boards);
  boards.transfer = (room, ...rest) =>
    room === [...rooms].sort()[3]
      ? Promise.reject(Object.assign(Error("Busy"), { status: 409 }))
      : transfer(room, ...rest);
  let after = null,
    requests = 0,
    transferred = 0;
  do {
    const moved = await call(owner, {
      op: "org.users.transfer",
      from: owner.uuid,
      to: editor.uuid,
      ...(after ? { after } : {}),
    });
    assert.ok(moved.transferred <= 25);
    transferred += moved.transferred;
    after = moved.next;
    requests++;
  } while (after && requests < 10);
  assert.equal(requests, 3);
  assert.equal(transferred, 59);
  const owned = (await org.list("org:board:")).filter(
    (r) => r.value.owner === editor.uuid,
  );
  assert.equal(owned.length, 59);
});

test("joining or verifying an address during a deactivation keeps the account deactivated", async () => {
  const { call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token: guestLink } = await call(owner, {
    op: "org.invite",
    role: "guest",
  });
  await call(guest, { op: "org.join", token: guestLink });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  // An administrator deactivates the guest just after the guest's own
  // request has read their record, and before it saves.
  const fresh = org.freshUser.bind(org);
  const during = (step) => {
    let armed = true;
    org.freshUser = async (uuid) => {
      const user = await fresh(uuid);
      if (armed && new Error().stack.includes(step)) {
        armed = false;
        await call(owner, {
          op: "org.users.update",
          uuid: guest.uuid,
          status: "deactivated",
        });
      }
      return user;
    };
  };
  during("joinOrganization");
  await assert.rejects(
    call(guest, { op: "org.join", token }),
    (error) => error.status === 403,
  );
  assert.equal((await fresh(guest.uuid)).status, "deactivated");
  assert.equal((await fresh(guest.uuid)).role, "guest");

  await call(owner, {
    op: "org.users.update",
    uuid: guest.uuid,
    status: "active",
  });
  org.freshUser = fresh;
  await call(guest, { op: "email.start", email: "dee@example.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  during("linkEmail");
  await call(guest, { op: "email.confirm", code });
  org.freshUser = fresh;
  const saved = await fresh(guest.uuid);
  assert.equal(saved.status, "deactivated");
  assert.equal(saved.email, "dee@example.test");
});

test("a team change or preference save during a deactivation keeps the account deactivated", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const x = "aaaaaaaa-aaaa-4aaa-8aaa-00000000000e";
  await org.saveUser({
    uuid: x,
    username: "Xavier",
    role: "member",
    status: "active",
    teams: [],
  });
  const { team } = await call(owner, { op: "teams.create", name: "Design" });
  // Each write below pauses right after reading X's record while an
  // administrator deactivates X, then resumes.
  const get = org.kv.get.bind(org.kv);
  for (const write of [
    () => call(owner, { op: "teams.update", id: team.id, add: [x] }),
    () =>
      call(
        { uuid: x, username: "Xavier" },
        { op: "prefs.set", emailNotifications: false },
      ),
  ]) {
    await org.saveUser({ ...(await org.freshUser(x)), status: "active" });
    let release,
      reached,
      armed = true;
    const gate = new Promise((r) => (release = r));
    const paused = new Promise((r) => (reached = r));
    org.kv.get = async (key) => {
      const value = await get(key);
      if (armed && [key].flat().includes("org:user:" + x)) {
        armed = false;
        reached();
        await gate;
      }
      return value;
    };
    const pending = write();
    await paused;
    org.kv.get = get;
    await call(owner, {
      op: "org.users.update",
      uuid: x,
      status: "deactivated",
    });
    release();
    await pending;
    org.forgetUser(x);
    assert.equal((await org.user(x)).status, "deactivated");
  }
  const saved = await org.user(x);
  assert.deepEqual(saved.teams, [team.id]);
  assert.equal(saved.prefs.emailNotifications, false);
  // A team can give access to the boards filed under it, so leaving one
  // renews the access stamp, once for the whole change.
  const before = await org.kv.get("org:access");
  const set = org.kv.set,
    stamped = [];
  org.kv.set = (key, ...rest) => {
    if (key === "org:access") stamped.push(key);
    return set.call(org.kv, key, ...rest);
  };
  try {
    await call(owner, { op: "teams.update", id: team.id, remove: [x] });
  } finally {
    org.kv.set = set;
  }
  assert.notEqual(await org.kv.get("org:access"), before);
  assert.equal(stamped.length, 1);
});

test("concurrent team changes keep every member", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const people = ["a", "b", "c", "d"].map(
    (n) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
  );
  for (const uuid of people)
    await org.saveUser({ uuid, role: "member", status: "active", teams: [] });
  const { team } = await call(owner, { op: "teams.create", name: "T" });
  await Promise.all(
    people.map((uuid) =>
      call(owner, { op: "teams.update", id: team.id, add: [uuid] }),
    ),
  );
  const saved = await org.kv.get("org:team:" + team.id);
  assert.deepEqual(saved.members.sort(), people);
  await Promise.all(
    people
      .slice(0, 2)
      .map((uuid) =>
        call(owner, { op: "teams.update", id: team.id, remove: [uuid] }),
      ),
  );
  assert.deepEqual(
    (await org.kv.get("org:team:" + team.id)).members.sort(),
    people.slice(2),
  );
  for (const uuid of people) {
    org.forgetUser(uuid);
    assert.deepEqual(
      (await org.user(uuid)).teams,
      people.indexOf(uuid) < 2 ? [] : [team.id],
    );
  }
});

test("a role change is audited even when live event cleanup fails", async () => {
  const { env, boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join(env, editor, { room, token: invite.token });
  await boards.call(editor, { op: "events", room });
  const fetcher = boards.fetcher;
  boards.fetcher = async (url, options = {}) => {
    if (options.method === "DELETE") throw Error("Timed out");
    return fetcher(url, options);
  };
  await boards.call(owner, {
    op: "role",
    room,
    uuid: editor.uuid,
    role: "removed",
  });
  const actions = (await org.list("org:audit:")).map((r) => r.value.action);
  assert.ok(actions.includes("board.role.changed"));
});

test("an interrupted organization setup registers earlier boards when retried", async () => {
  const { env, boards, call, org } = setup();
  const { input, room } = createInput("Old board");
  await boards.call(owner, input);
  await env.data.delete("org:board:" + room);
  const backfill = boards.backfillRegistry.bind(boards);
  boards.backfillRegistry = async () => {
    throw Error("Worker time limit");
  };
  await assert.rejects(call(owner, { op: "org.setup", name: "Fabrikam" }));
  boards.backfillRegistry = backfill;
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  assert.equal((await org.kv.get("org:board:" + room))?.title, "Old board");
});

test("unarchiving a board through the API keeps it deleted", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Archive me");
  await boards.call(owner, input);
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Boards",
    scopes: ["boards:write"],
  });
  const patch = (body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/v1/boards/" + room, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${key}` },
      }),
      "PATCH",
      "boards/" + room,
      body,
    );
  await patch({ archived: true });
  assert.ok((await org.kv.get("org:board:" + room)).archived);
  await boards.call(owner, { op: "delete", room });
  await patch({ archived: false });
  const record = await org.kv.get("org:board:" + room);
  assert.equal(record.archived, null);
  assert.ok(record.deleted, "the board stays deleted");
  await patch({ deleted: false });
  assert.equal((await org.kv.get("org:board:" + room)).deleted, null);
  // Keeping a board out of the trash leaves an archive in place.
  await patch({ archived: true, deleted: false });
  assert.ok((await org.kv.get("org:board:" + room)).archived);
  await patch({ deleted: false });
  assert.ok((await org.kv.get("org:board:" + room)).archived);
  // A board restored and archived at once ends up archived.
  await boards.call(owner, { op: "delete", room });
  await patch({ archived: true, deleted: false });
  const both = await org.kv.get("org:board:" + room);
  assert.ok(both.archived);
  assert.equal(both.deleted, null);
});

test("joining a deleted board records no membership", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { externalSharing: "anyone", publicLinks: true },
  });
  const { input, room } = createInput();
  await boards.call(owner, input);
  await boards.call(owner, { op: "settings", room, visibility: "link" });
  await boards.call(owner, { op: "delete", room });
  await assert.rejects(boards.call(guest, { op: "join", room }), {
    status: 404,
  });
  assert.equal(await org.kv.get(`wb:${room}:member:${guest.uuid}`), null);
  assert.equal(await org.user(guest.uuid), null);
});

test("switching to an unreachable organization keeps the current one", async () => {
  const saved = new Map();
  const puter = {
    kv: {
      get: async (key) => saved.get(key),
      set: async (key, value) => saved.set(key, value),
    },
  };
  const organization = createOrganization({
    puter: () => puter,
    call: async (_puter, server) => {
      if (server.includes("broken")) throw Error("Unreachable");
      return { configured: true, name: "Fabrikam", role: "member" };
    },
    deploy: async () => {},
  });
  await organization.use("https://fabrikam.puter.work");
  await assert.rejects(organization.use("https://broken.puter.work"));
  assert.equal(organization.server, "https://fabrikam.puter.work");
  assert.equal(organization.info.name, "Fabrikam");
  assert.equal(saved.get(ORG_KEY).server, "https://fabrikam.puter.work");
});

test("organization administrators on a board hear of mentions and replies", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const [user, role] of [
    [editor, "member"],
    [viewer, "admin"],
  ]) {
    const { token } = await call(owner, { op: "org.invite", role });
    await call(user, { op: "org.join", token });
  }
  const { input, room } = createInput("Sprint retro");
  await boards.call(editor, input);
  const { token } = await boards.call(editor, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, viewer, { room, token });
  const say = (user, id, text) =>
    commit(boards, user, room, (b) => {
      b.comments ||= [];
      const message = {
        id,
        authorId: user.uuid,
        authorName: user.username,
        text,
        createdAt: b.comments.length + 1,
      };
      if (b.comments.length) b.comments[0].messages.push(message);
      else
        b.comments.push({
          id: "t1",
          x: 0,
          y: 0,
          resolved: false,
          messages: [message],
        });
    });
  const types = async (user) =>
    (await call(user, { op: "notifications.list" })).items
      .filter((n) => n.board === room)
      .map((n) => n.type)
      .sort();
  await say(editor, "m1", "@cam can you approve?");
  assert.deepEqual(await types(viewer), ["mention"]);
  await say(viewer, "m2", "Approved.");
  assert.deepEqual(await types(editor), ["reply"]);
  await say(editor, "m3", "Thanks!");
  assert.deepEqual(await types(viewer), ["mention", "reply"]);
});

test("a reply in a long discussion notifies everyone who wrote in it without one write after another", async () => {
  const { boards } = setup();
  const { input, room } = createInput("Workshop");
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  const people = Array.from({ length: 30 }, (_, n) => ({
    uuid: `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
    username: `Person${n}`,
  }));
  for (const person of people)
    await boards.call(person, { op: "join", room, token });
  const say = (user, n) =>
    commit(boards, user, room, (b) => {
      const message = {
        id: `m${n}`,
        authorId: user.uuid,
        authorName: user.username,
        text: `Point ${n}`,
        createdAt: n + 1,
      };
      if (b.comments?.length) b.comments[0].messages.push(message);
      else
        b.comments = [
          { id: "t1", x: 0, y: 0, resolved: false, messages: [message] },
        ];
    });
  for (const [n, person] of people.slice(0, 29).entries()) await say(person, n);
  // Each notification takes a moment to store, as Puter's storage does.
  const notify = boards.org.notify.bind(boards.org);
  const told = [];
  let writing = 0,
    most = 0;
  boards.org.notify = async (uuid, notice) => {
    most = Math.max(most, ++writing);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      told.push([uuid, notice.type]);
      return await notify(uuid, notice);
    } finally {
      writing--;
    }
  };
  await say(people[29], 29);
  assert.deepEqual(
    told.map(([uuid]) => uuid).sort(),
    people
      .slice(0, 29)
      .map((p) => p.uuid)
      .sort(),
  );
  assert.ok(told.every(([, type]) => type === "reply"));
  assert.ok(most > 1, "Notifications are written together");
});

test("a board shared with the organization notifies colleagues mentioned before they open it", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const user of [editor, viewer]) {
    const { token } = await call(owner, { op: "org.invite", role: "member" });
    await call(user, { op: "org.join", token });
  }
  const { input, room } = createInput("Roadmap");
  await boards.call(editor, input);
  let n = 0;
  const say = (text) =>
    commit(boards, editor, room, (b) => {
      b.comments ||= [];
      n++;
      b.comments.push({
        id: `t${n}`,
        x: 0,
        y: 0,
        resolved: false,
        messages: [
          {
            id: `m${n}`,
            authorId: editor.uuid,
            authorName: editor.username,
            text,
            createdAt: n,
          },
        ],
      });
    });
  const mentions = async () =>
    (await call(viewer, { op: "notifications.list" })).items.filter(
      (x) => x.board === room && x.type === "mention",
    ).length;
  // A private board admits only the people invited to it.
  await say("@cam can you review?");
  assert.equal(await mentions(), 0);
  await boards.call(editor, {
    op: "settings",
    room,
    visibility: "organization",
  });
  // Cam has not opened the board, so there is no member record yet.
  await say("@cam can you review now?");
  assert.equal(await mentions(), 1);
  assert.equal(await boards.canOpen(room, viewer), false);
  // A guest on the board, who is not offered the organization's members,
  // cannot reach them by guessing a name either.
  const guest = {
    uuid: "44444444-4444-4444-8444-444444444444",
    username: "Dee",
  };
  const { token } = await boards.call(editor, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, guest, { room, token });
  await commit(boards, guest, room, (b) => {
    b.comments.push({
      id: "guest",
      x: 0,
      y: 0,
      resolved: false,
      messages: [
        {
          id: "guest-1",
          authorId: guest.uuid,
          authorName: guest.username,
          text: "@cam hello",
          createdAt: 99,
        },
      ],
    });
  });
  assert.equal(await mentions(), 1);
  // Someone removed from the board is not told about it.
  await join({ service: boards }, viewer, { room });
  assert.equal(await boards.canOpen(room, viewer), true);
  await boards.call(editor, {
    op: "role",
    room,
    uuid: viewer.uuid,
    role: "removed",
  });
  await say("@cam one more thing");
  assert.equal(await mentions(), 1);
});

test("colleagues who have not opened an organization-wide board are offered for mentions", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const user of [editor, viewer]) {
    const { token } = await call(owner, { op: "org.invite", role: "member" });
    await call(user, { op: "org.join", token });
  }
  const { input, room } = createInput("Roadmap");
  await boards.call(editor, input);
  const offered = async (user) =>
    ((await boards.call(user, { op: "members", room })).colleagues || []).map(
      (p) => p.username,
    );
  // A private board offers only its members.
  assert.deepEqual(await offered(editor), []);
  await boards.call(editor, {
    op: "settings",
    room,
    visibility: "organization",
  });
  assert.deepEqual(await offered(editor), [viewer.username]);
  // Once Cam opens the board, Cam is a member and no longer a colleague.
  await join({ service: boards }, viewer, { room });
  assert.deepEqual(await offered(editor), []);
});

test("editing a comment to name someone new notifies only them", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Sprint retro");
  await boards.call(owner, input);
  for (const user of [editor, viewer]) {
    const { token } = await boards.call(owner, {
      op: "invite",
      room,
      role: "editor",
    });
    await join({ service: boards }, user, { room, token });
  }
  const write = (text, editedAt) =>
    commit(boards, editor, room, (b) => {
      b.comments = [
        {
          id: "t1",
          x: 0,
          y: 0,
          resolved: false,
          messages: [
            {
              id: "m1",
              authorId: editor.uuid,
              authorName: editor.username,
              text,
              createdAt: 1,
              ...(editedAt ? { editedAt } : {}),
            },
          ],
        },
      ];
    });
  const mentions = async (user) =>
    (await call(user, { op: "notifications.list" })).items.filter(
      (n) => n.type === "mention",
    ).length;
  await write("@alice can you check this?");
  assert.equal(await mentions(owner), 1);
  await write("@alice and @cam can you check this?", 2);
  assert.equal(await mentions(viewer), 1);
  assert.equal(await mentions(owner), 1);
  // Fixing a typo names no one new.
  await write("@alice and @cam, can you check this?", 3);
  assert.equal(await mentions(viewer), 1);
  assert.equal(await mentions(owner), 1);
});

test("taking a name out of a comment and putting it back notifies them once", async () => {
  const { env, boards, call, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await env.service.org.updateUser(owner.uuid, {
    uuid: owner.uuid,
    email: "alice@fabrikam.test",
    emailVerified: true,
  });
  const { input, room } = createInput("Sprint retro");
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, editor, { room, token });
  const write = (text) =>
    commit(boards, editor, room, (b) => {
      b.comments = [
        {
          id: "t1",
          x: 0,
          y: 0,
          resolved: false,
          messages: [
            {
              id: "m1",
              authorId: editor.uuid,
              authorName: editor.username,
              text,
              createdAt: 1,
            },
          ],
        },
      ];
    });
  await write("can you check this?");
  for (let n = 0; n < 6; n++) {
    env.now += 1000;
    await write(n % 2 ? `check ${n}` : `@alice check ${n}`);
  }
  const notes = (await call(owner, { op: "notifications.list" })).items;
  assert.equal(notes.filter((n) => n.type === "mention").length, 1);
  assert.equal(
    sent.filter((m) => m.subject.includes("mentioned you")).length,
    1,
  );
});

test("a mention added to a reply reaches someone already told of the reply", async () => {
  const { env, boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Sprint retro");
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, editor, { room, token });
  const first = {
    id: "m0",
    authorId: owner.uuid,
    authorName: owner.username,
    text: "first",
    createdAt: 0,
  };
  await commit(boards, owner, room, (b) => {
    b.comments = [{ id: "t1", x: 0, y: 0, resolved: false, messages: [first] }];
  });
  const reply = (text) =>
    commit(boards, editor, room, (b) => {
      b.comments[0].messages = [
        first,
        {
          id: "m1",
          authorId: editor.uuid,
          authorName: editor.username,
          text,
          createdAt: 1,
        },
      ];
    });
  env.now += 1000;
  await reply("looks good");
  env.now += 1000;
  await reply("@alice can you check the numbers?");
  const types = (await call(owner, { op: "notifications.list" })).items
    .map((n) => n.type)
    .filter((type) => ["mention", "reply"].includes(type))
    .sort();
  assert.deepEqual(types, ["mention", "reply"]);
});

test("notification mail and board channel posts link to the board in the app", async () => {
  const { boards, call, org, sent, fetched } = setup();
  const from = (origin) => {
    org.request = new Request("https://fabrikam-wb.puter.work/api", {
      method: "POST",
      headers: { origin },
    });
  };
  // Only the owner's or an administrator's app address is used.
  from("https://whiteboard.fabrikam.test");
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { slack: { enabled: true } } },
  });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  from("https://attacker.example");
  await call(editor, { op: "org.info" });
  from("https://whiteboard.fabrikam.test");
  const note = item("note", 0, 0, { text: "Budget" });
  const { input, room } = createInput("Sprint retro", [note]);
  await boards.call(owner, input);
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, editor, { room, token: invite.token });
  const hook = "https://hooks.slack.com/services/T/B/x";
  await boards.call(owner, { op: "settings", room, slack: hook });
  await call(owner, { op: "email.start", email: "alice@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  await call(owner, { op: "email.confirm", code });
  await commit(boards, editor, room, (b) => {
    b.comments = [
      {
        id: "t1",
        anchorId: note.id,
        x: 0,
        y: 0,
        dx: 0,
        dy: 0,
        resolved: false,
        messages: [
          {
            id: "m1",
            authorId: editor.uuid,
            authorName: editor.username,
            text: "@alice please review",
            createdAt: 1,
          },
        ],
      },
    ];
  });
  await org.flush();
  // The link opens the discussion, not only the object it is pinned to.
  const link = `https://whiteboard.fabrikam.test/#server=https%3A%2F%2Ffabrikam-wb.puter.work&board=${room}&object=${note.id}&thread=t1`;
  const mail = sent.find((m) => m.subject.includes("mentioned you"));
  assert.ok(mail.text.includes(`Open the board: ${link}`), mail.text);
  assert.ok(mail.text.includes(`Ouvrir le tableau : ${link}`), mail.text);
  const post = JSON.parse(
    fetched.find((f) => f.url === hook).options.body,
  ).text;
  assert.ok(post.startsWith("Bob commented on Sprint retro: "), post);
  assert.ok(post.includes("Bob a commenté dans Sprint retro : "), post);
  assert.ok(post.endsWith(link.replaceAll("&", "&amp;")), post);
});

test("one edit notifies each person once and posts to the board's Slack once", async () => {
  const { boards, call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { slack: { enabled: true } } },
  });
  const { input, room } = createInput();
  await boards.call(owner, input);
  for (const user of [editor, viewer]) {
    const { token } = await boards.call(owner, {
      op: "invite",
      room,
      role: "editor",
    });
    await join({ service: boards }, user, { room, token });
  }
  const hook = "https://hooks.slack.com/services/T/B/x";
  await boards.call(owner, { op: "settings", room, slack: hook });
  const posts = () =>
    fetched
      .filter((f) => f.url === hook)
      .map((f) => JSON.parse(f.options.body).text);
  const message = (id, text) => ({
    id,
    authorId: editor.uuid,
    authorName: editor.username,
    text,
    createdAt: 1,
  });
  // A pasted pile of threads that all mention Alice.
  await commit(boards, editor, room, (b) => {
    b.comments = Array.from({ length: 300 }, (_, n) => ({
      id: "t" + n,
      x: 0,
      y: 0,
      resolved: false,
      messages: [message("m" + n, `Look @alice ${n}`)],
    }));
  });
  await org.flush();
  const notes = await adminCall(org, boards, owner, {
    op: "notifications.list",
  });
  assert.deepEqual(
    notes.items.filter((n) => n.type === "mention").map((n) => n.text),
    ["Bob: Look @alice 0"],
  );
  assert.equal(posts().length, 1);
  // Two people mentioned in one comment still means one channel post, and
  // Slack codes in the text show as written instead of pinging everyone.
  await commit(boards, editor, room, (b) => {
    b.comments[0].messages.push(
      message("x1", "@alice and @cam <!channel> see <https://x.ca|here> & go"),
    );
  });
  await org.flush();
  assert.equal(posts().length, 2);
  const said =
    "@alice and @cam &lt;!channel&gt; see &lt;https://x.ca|here&gt; &amp; go";
  assert.equal(
    posts()[1],
    `Bob commented on Planning: ${said}\n\nBob a commenté dans Planning : ${said}`,
  );
  // The first messages of an edit are audited one by one and the rest in
  // one record that counts them, so every message is still accounted for.
  const audits = (await org.list("org:audit:"))
    .map((r) => r.value)
    .filter((r) => r.action === "board.comment.created");
  assert.equal(audits.length, 22);
  assert.equal(
    audits.reduce((sum, r) => sum + (r.details.count ?? 1), 0),
    301,
  );
  const folded = audits.find((r) => r.details.count);
  assert.equal(folded.details.count, 280);
  assert.equal(folded.details.threads.length, 20);
  assert.equal(folded.details.mentions, 280);
});

test("board content search finds only boards the person can still open", async () => {
  const { boards, org, call } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  await call(owner, { op: "org.policy.set", policy: { guestExpiryDays: 1 } });
  const { token: memberToken } = await call(owner, {
    op: "org.invite",
    role: "member",
  });
  await call(editor, { op: "org.join", token: memberToken });
  await call(viewer, {
    op: "org.join",
    token: (await call(owner, { op: "org.invite", role: "member" })).token,
  });
  const secret = createInput("Merger", [
    item("note", 0, 0, { text: "acquire contoso" }),
  ]);
  await boards.call(owner, secret.input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room: secret.room,
    guest: true,
    role: "viewer",
  });
  await boards.call(guest, { op: "join", room: secret.room, token });
  const reorg = createInput("Reorg", [
    item("note", 0, 0, { text: "team alpha changes" }),
  ]);
  await boards.call(owner, reorg.input);
  await boards.call(owner, {
    op: "settings",
    room: reorg.room,
    visibility: "organization",
  });
  await boards.call(editor, { op: "join", room: reorg.room });
  const search = async (user, query, scope = "organization") =>
    (await call(user, { op: "org.boards", scope, query, content: true }))
      .boards;
  // People with access, including members who have not opened a board
  // shared with the organization, find it by its content.
  assert.equal((await search(guest, "contoso", "mine")).length, 1);
  assert.equal((await search(editor, "alpha")).length, 1);
  assert.equal((await search(viewer, "alpha")).length, 1);
  // A removed member no longer does.
  await boards.call(owner, {
    op: "role",
    room: reorg.room,
    uuid: editor.uuid,
    role: "removed",
  });
  assert.deepEqual(await search(editor, "alpha"), []);
  assert.equal((await search(viewer, "alpha")).length, 1);
  // Neither does a guest whose access expired.
  const start = Date.now();
  boards.now = org.now = () => start + 3 * 86400_000;
  assert.deepEqual(await search(guest, "contoso", "mine"), []);
  assert.equal((await search(owner, "contoso", "all")).length, 1);
});

test("a member's content search reads only the index of boards they can see", async () => {
  const { org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(editor, {
    op: "org.join",
    token: (await call(owner, { op: "org.invite", role: "member" })).token,
  });
  const room = (n) => `b${String(n).padStart(20, "0")}`;
  for (let n = 0; n < 400; n++) {
    const visible = n < 60;
    await org.kv.set("org:board:" + room(n), {
      room: room(n),
      title: `Board ${n}`,
      visibility: visible ? "organization" : "private",
      created: 1,
    });
    await org.kv.set("org:idx:" + room(n), visible ? "roadmap" : "secret");
    if (visible) await org.kv.set("org:visible:" + room(n), 1);
  }
  const patterns = [];
  const list = org.kv.list.bind(org.kv);
  org.kv.list = (options) => (patterns.push(options.pattern), list(options));
  const { boards: found } = await call(editor, {
    op: "org.boards",
    scope: "organization",
    query: "roadmap",
    content: true,
  });
  assert.equal(found.length, 60);
  assert.ok(!patterns.includes("org:idx:"), patterns.join());
  // Boards that are much of the directory still read the index in pages.
  patterns.length = 0;
  await call(owner, {
    op: "org.boards",
    scope: "all",
    query: "roadmap",
    content: true,
  });
  assert.ok(patterns.includes("org:idx:"));
});

test("a member's content search checks access to many boards in a few requests", async () => {
  const { env, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(editor, {
    op: "org.join",
    token: (await call(owner, { op: "org.invite", role: "member" })).token,
  });
  const room = (n) => `access${String(n).padStart(16, "0")}`;
  for (let n = 0; n < 300; n++) {
    env.data.set(`wb:${room(n)}:meta`, {
      owner: owner.uuid,
      visibility: "organization",
      created: 1,
    });
    env.data.set("org:board:" + room(n), {
      room: room(n),
      title: `Board ${n}`,
      visibility: "organization",
      created: 1,
    });
    env.data.set("org:idx:" + room(n), "roadmap");
    env.data.set("org:visible:" + room(n), 1);
  }
  // Removed from one board, and a member of another.
  env.data.set(`wb:${room(1)}:member:${editor.uuid}`, {
    uuid: editor.uuid,
    role: "removed",
  });
  env.data.set(`wb:${room(2)}:member:${editor.uuid}`, {
    uuid: editor.uuid,
    role: "viewer",
  });
  let gets = 0;
  const get = org.kv.get.bind(org.kv);
  org.kv.get = (key) => (gets++, get(key));
  const { boards: found, total } = await call(editor, {
    op: "org.boards",
    scope: "organization",
    query: "roadmap",
    content: true,
    limit: 1000,
  });
  org.kv.get = get;
  assert.equal(total, 299);
  assert.ok(!found.some((b) => b.room === room(1)));
  assert.ok(found.some((b) => b.room === room(2)));
  assert.ok(gets <= 15, `${gets} reads`);
});

test("the next page of boards follows the last one shown, however activity reorders them", async () => {
  const { env, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const room = (n) => `paging${String(n).padStart(14, "0")}`;
  const touch = (n, at) =>
    env.data.set("org:board:" + room(n), {
      room: room(n),
      title: `Board ${n}`,
      visibility: "private",
      created: 1,
      lastActivity: at,
    });
  // Two boards share a time, so ties keep one order too.
  for (let n = 0; n < 6; n++) touch(n, 1000 - (n === 3 ? 10 : n * 10));
  const page = (input) =>
    call(owner, { op: "org.boards", scope: "all", limit: 2, ...input });
  const first = await page({});
  assert.deepEqual(
    first.boards.map((b) => b.room),
    [room(0), room(1)],
  );
  assert.equal(typeof first.next, "string");
  // A board further down is edited, and moves to the top.
  touch(5, 5000);
  const second = await page({ after: first.next });
  assert.deepEqual(
    second.boards.map((b) => b.room),
    [room(3), room(2)],
  );
  assert.equal(second.total, 6);
  const third = await page({ after: second.next });
  assert.deepEqual(
    third.boards.map((b) => b.room),
    [room(4)],
  );
  assert.equal(third.next, null);
  // A cursor that does not parse starts from the first page.
  assert.equal((await page({ after: "{" })).boards[0].room, room(5));
});

test("the SIEM export sends a record written late, and each record once", async () => {
  const { call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "https", url: "https://siem.fabrikam.test/in" } },
  });
  const policy = await org.policy();
  await siem(org, policy);
  fetched.length = 0;
  let now = Date.now();
  org.now = () => now;
  // One request takes its record's time, then writes it after another
  // request's later record was exported.
  const { set } = org.kv;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  org.kv.set = async (key, value, ...rest) => {
    if (value?.action === "policy.slow") await held;
    return set.call(org.kv, key, value, ...rest);
  };
  const slow = org.audit(owner, "policy.slow", { type: "organization" });
  now += 5;
  await org.audit(owner, "policy.fast", { type: "organization" });
  now += 5;
  await siem(org, policy);
  release();
  await slow;
  now += 20_000;
  await siem(org, policy);
  now += 20_000;
  await siem(org, policy);
  const exported = fetched.flatMap((f) =>
    JSON.parse(f.options.body).events.map((e) => e.Action ?? e.action),
  );
  assert.deepEqual(exported, ["policy.fast", "policy.slow"]);
});

test("an audit record that storage refused is written by the next audit write or flush, in order", async () => {
  const { org } = setup();
  const { set } = org.kv;
  let refuse = null;
  org.kv.set = async (key, ...rest) => {
    if (refuse && key.startsWith(refuse))
      throw new Error("storage unavailable");
    return set.call(org.kv, key, ...rest);
  };
  refuse = "org:audit:";
  const first = await org.audit(owner, "policy.first", {
    type: "organization",
  });
  assert.ok(!(await org.kv.get("org:audit:" + first.id)));
  assert.deepEqual(org.pending, []);
  // The next write stores the refused record before its own, so delivery
  // and the log see them in order.
  refuse = null;
  const second = await org.audit(owner, "policy.second", {
    type: "organization",
  });
  assert.equal(
    (await org.kv.get("org:audit:" + first.id)).action,
    "policy.first",
  );
  assert.equal(
    (await org.kv.get("org:audit:" + second.id)).action,
    "policy.second",
  );
  assert.deepEqual(
    org.pending.map((e) => e.action),
    ["policy.first", "policy.second"],
  );
  await org.flush();
  // A board's activity record refused after its audit record was stored is
  // the only write made again, and the flush that follows makes it.
  refuse = "org:bact:";
  const third = await org.audit(owner, "board.renamed", {
    type: "board",
    id: "room-1",
  });
  assert.equal(
    (await org.kv.get("org:audit:" + third.id)).action,
    "board.renamed",
  );
  assert.ok(!(await org.kv.get(`org:bact:room-1:${third.id}`)));
  assert.deepEqual(org.pending, []);
  refuse = null;
  let audits = 0;
  org.kv.set = async (key, ...rest) => {
    if (key.startsWith("org:audit:")) audits++;
    return set.call(org.kv, key, ...rest);
  };
  await org.flush();
  assert.equal(audits, 0);
  assert.equal(
    (await org.kv.get(`org:bact:room-1:${third.id}`)).action,
    "board.renamed",
  );
  assert.deepEqual(org.instance.unsaved, []);
  // A notification storage refused is kept the same way, and does not
  // stop the audit record written after it.
  org.kv.set = async (key, ...rest) => {
    if (key.startsWith("org:notif:")) throw new Error("storage unavailable");
    return set.call(org.kv, key, ...rest);
  };
  const note = await org.notify(editor.uuid, {
    type: "assignment",
    board: "room-1",
    subject: "A task",
  });
  const fourth = await org.audit(owner, "policy.fourth", {
    type: "organization",
  });
  assert.ok(!(await org.kv.get(`org:notif:${editor.uuid}:${note.id}`)));
  assert.equal(
    (await org.kv.get("org:audit:" + fourth.id)).action,
    "policy.fourth",
  );
  org.kv.set = set;
  await org.flush();
  assert.equal(
    (await org.kv.get(`org:notif:${editor.uuid}:${note.id}`)).subject,
    "A task",
  );
  assert.deepEqual(org.instance.unsaved, []);
});

test("the SIEM export moves past a burst larger than the ids it remembers", async () => {
  const { call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "https", url: "https://siem.fabrikam.test/in" } },
  });
  const policy = await org.policy();
  let now = Date.now();
  org.now = () => now;
  await siem(org, policy);
  now += 1000;
  for (let n = 0; n < 2500; n++)
    await org.audit(owner, "policy.burst", { type: "organization" });
  now += 1000;
  await org.audit(owner, "policy.after", { type: "organization" });
  fetched.length = 0;
  for (let round = 0; round < 8; round++) {
    now += 11_000;
    await siem(org, policy);
  }
  const exported = fetched.flatMap((f) =>
    JSON.parse(f.options.body).events.map((e) => e.EventId),
  );
  assert.equal(new Set(exported).size, exported.length);
  assert.equal(exported.length, 2501);
  const last = fetched.at(-1);
  assert.equal(
    JSON.parse(last.options.body).events.at(-1).Action,
    "policy.after",
  );
});

test("an address provisioned inactive deactivates an administrator only by the owner's key", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  for (const user of [editor, viewer]) {
    const { token } = await call(owner, { op: "org.invite", role: "admin" });
    await call(user, { op: "org.join", token });
  }
  const keyOf = async (by) =>
    (await call(by, { op: "apikeys.create", name: "IdP", scopes: ["scim"] }))
      .key;
  const provision = (key, email) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/Users", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
      }),
      "POST",
      "Users",
      { userName: email, active: false },
    );
  const verify = async (user, email) => {
    await call(user, { op: "email.start", email });
    const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
    return (await call(user, { op: "email.confirm", code })).user;
  };
  // Another administrator's key cannot deactivate Bob this way.
  await provision(await keyOf(viewer), "bob@fabrikam.test");
  const bob = await verify(editor, "bob@fabrikam.test");
  assert.equal(bob.role, "admin");
  assert.equal(bob.status, "active");
  // The owner's key can, as it can deactivate an administrator directly.
  await provision(await keyOf(owner), "cam@fabrikam.test");
  const cam = await verify(viewer, "cam@fabrikam.test");
  assert.equal(cam.status, "deactivated");
  assert.equal(cam.inactiveByOwner, undefined);
});

test("a SCIM patch with an operation that is not an object is refused as invalid", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "IdP",
    scopes: ["scim"],
  });
  const scim = (path, method, body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
  const user = await (
    await scim("Users", "POST", { userName: "pat@example.ca" })
  ).json();
  const group = await (
    await scim("Groups", "POST", { displayName: "Design" })
  ).json();
  for (const path of ["Users/" + user.id, "Groups/" + group.id])
    for (const op of [null, 7, "replace"])
      await assert.rejects(
        scim(path, "PATCH", {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [op],
        }),
        (e) => e.status === 400 && e.scimType === "invalidSyntax",
      );
});

test("a SCIM role given on its own rather than in a list is read as one", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "IdP",
    scopes: ["scim"],
  });
  const scim = async (path, method, body) =>
    (
      await restRoute(
        org,
        boards,
        new Request("https://w.puter.work/scim/v2/" + path, {
          method,
          headers: { Authorization: `Bearer ${key}` },
        }),
        method,
        path,
        body,
      )
    ).json();
  const roleOf = (user) => user.roles[0].value;
  const a = await scim("Users", "POST", {
    userName: "a@example.ca",
    roles: "guest",
  });
  assert.equal(roleOf(a), "guest");
  const b = await scim("Users", "POST", {
    userName: "b@example.ca",
    roles: { value: "guest" },
  });
  assert.equal(roleOf(b), "guest");
  const c = await scim("Users", "POST", {
    userName: "c@example.ca",
    roles: [null, 7],
  });
  assert.equal(roleOf(c), "member");
  const patch = (user, operation) =>
    scim("Users/" + user.id, "PATCH", {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", ...operation }],
    });
  assert.equal(
    roleOf(await patch(a, { value: { roles: { value: "member" } } })),
    "member",
  );
  assert.equal(roleOf(await patch(a, { value: { roles: "guest" } })), "guest");
  assert.equal(
    roleOf(await patch(a, { path: "roles", value: { value: "member" } })),
    "member",
  );
  assert.equal(
    roleOf(await patch(a, { path: "roles", value: "guest" })),
    "guest",
  );
});

test("only the owner's key turns a pending administrator on or off", async () => {
  const { boards, call, org, sent } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  const { token } = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token });
  const keyOf = async (by) =>
    (await call(by, { op: "apikeys.create", name: "IdP", scopes: ["scim"] }))
      .key;
  const [ownerKey, adminKey] = [await keyOf(owner), await keyOf(editor)];
  const scim = (key, path, method, body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/scim/v2/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
  const active = (value) => ({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "active", value }],
  });
  const pat = await (
    await scim(ownerKey, "Users", "POST", { userName: "pat@fabrikam.test" })
  ).json();
  await call(owner, { op: "org.users.update", uuid: pat.id, role: "admin" });
  await scim(ownerKey, "Users/" + pat.id, "PATCH", active(false));
  const refused = (key, method, body) =>
    assert.rejects(
      scim(key, "Users/" + pat.id, method, body),
      (e) => e.status === 403,
    );
  await refused(adminKey, "PATCH", active(true));
  await refused(adminKey, "PUT", { active: true });
  // Turning Pat off again, by the owner's key, is refused to the other key.
  await scim(ownerKey, "Users/" + pat.id, "PATCH", active(true));
  await refused(adminKey, "PATCH", active(false));
  await scim(ownerKey, "Users/" + pat.id, "PATCH", active(false));
  // Other changes from the administrator's key still apply.
  const renamed = await (
    await scim(adminKey, "Users/" + pat.id, "PUT", { displayName: "Pat" })
  ).json();
  assert.equal(renamed.active, false);
  // Pat stays inactive once they sign in.
  await call(viewer, { op: "email.start", email: "pat@fabrikam.test" });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  const linked = (await call(viewer, { op: "email.confirm", code })).user;
  assert.equal(linked.status, "deactivated");
});

test("an administrator already on a board with a lesser role governs it", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const user of [editor, viewer]) {
    const { token } = await call(owner, { op: "org.invite", role: "member" });
    await call(user, { op: "org.join", token });
  }
  const { input, room } = createInput("Plan");
  await boards.call(editor, input);
  const invite = await boards.call(editor, {
    op: "invite",
    room,
    role: "viewer",
  });
  await boards.call(viewer, { op: "join", room, token: invite.token });
  assert.equal(
    (await boards.call(viewer, { op: "join", room })).member.role,
    "viewer",
  );
  await call(owner, {
    op: "org.users.update",
    uuid: viewer.uuid,
    role: "admin",
  });
  const joined = await boards.call(viewer, { op: "join", room });
  assert.equal(joined.member.role, "owner");
  await boards.call(viewer, { op: "settings.get", room });
  // The board's own owner keeps their membership as it is.
  assert.equal(
    (await boards.call(editor, { op: "join", room })).member.role,
    "owner",
  );
});

test("people refused access are not counted as active", async () => {
  const { env, boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const today = new Date(env.now).toISOString().slice(0, 10);
  const count = () => env.data.get("org:daycount:" + today) || 0;
  const before = count();
  const stranger = {
    uuid: "55555555-5555-4555-8555-555555555555",
    username: "Eve",
  };
  for (const user of [editor, viewer, stranger])
    await assert.rejects(boards.call(user, { op: "sync", room }), {
      status: 403,
    });
  await assert.rejects(call(editor, { op: "org.users.list" }), {
    status: 403,
  });
  assert.equal(count(), before);
  // Someone who opens the board is.
  await boards.call(owner, { op: "sync", room });
  assert.ok(count() >= before);
});

test("guests who can no longer open a board leave its guest count", async () => {
  const { env, boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      externalSharing: "anyone",
      publicLinks: true,
      guestExpiryDays: 30,
    },
  });
  const { token: member } = await call(owner, {
    op: "org.invite",
    role: "member",
  });
  await call(editor, { op: "org.join", token: member });
  const { input, room } = createInput("Shared");
  await boards.call(editor, input);
  const { token } = await boards.call(editor, {
    op: "invite",
    room,
    role: "editor",
    guest: true,
  });
  await boards.call(guest, { op: "join", room, token });
  await boards.call(editor, { op: "settings", room, visibility: "link" });
  const visitor = {
    uuid: "55555555-5555-4555-8555-555555555555",
    username: "Eve",
  };
  await boards.call(visitor, { op: "join", room });
  const sharing = async () =>
    (await call(owner, { op: "org.reports" })).sharing;
  const listed = async () =>
    (await call(owner, { op: "org.boards", scope: "all", guests: true }))
      .boards;
  assert.equal((await sharing()).guestMemberships, 2);
  // Making the board private ends the access that came with its link.
  await boards.call(editor, { op: "settings", room, visibility: "private" });
  await assert.rejects(boards.call(visitor, { op: "sync", room }), {
    status: 403,
  });
  assert.equal((await sharing()).guestMemberships, 1);
  assert.equal((await listed())[0].guestCount, 1);
  // Sharing it by link again brings that access back.
  await boards.call(editor, { op: "settings", room, visibility: "link" });
  assert.equal((await sharing()).guestMemberships, 2);
  await boards.call(editor, { op: "settings", room, visibility: "private" });
  // Once the invited guest's access expires, nobody is counted, though
  // nothing recounted the board.
  env.now += 31 * 86_400_000;
  await assert.rejects(boards.call(guest, { op: "sync", room }), {
    status: 403,
  });
  const after = await sharing();
  assert.equal(after.guestMemberships, 0);
  assert.equal(after.withGuests, 0);
  assert.deepEqual(await listed(), []);
});

test("audit records name a webhook by its origin, never its token", async () => {
  const { call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "https", url: "https://siem.fabrikam.test/in" } },
  });
  const url = "https://hooks.zapier.com/hooks/catch/123/SECRETTOKEN/";
  const { webhook } = await call(owner, {
    op: "webhooks.create",
    url,
    events: ["*"],
  });
  await call(owner, { op: "webhooks.delete", id: webhook.id });
  await org.flush();
  const records = (await org.list("org:audit:"))
    .map((r) => r.value)
    .filter((e) => e.action.startsWith("webhook."));
  assert.deepEqual(records.map((e) => [e.action, e.target.name]).sort(), [
    ["webhook.created", "https://hooks.zapier.com/…"],
    ["webhook.deleted", "https://hooks.zapier.com/…"],
  ]);
  for (const f of fetched)
    assert.ok(!String(f.options.body).includes("SECRETTOKEN"));
});

test("transferring a board to someone new to it updates its member count", async () => {
  const { boards, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const { input, room } = createInput();
  await boards.call(editor, input);
  assert.equal((await org.kv.get("org:board:" + room)).memberCount, 1);
  await boards.call(editor, { op: "transfer", room, uuid: owner.uuid });
  assert.equal((await org.kv.get("org:board:" + room)).memberCount, 2);
});

test("a transferred board stops posting to its previous owner's Slack", async () => {
  const { boards, org, call, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { slack: { enabled: true } } },
  });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const { input, room } = createInput();
  await boards.call(editor, input);
  const hook = "https://hooks.slack.com/services/T/B/bob";
  await boards.call(editor, { op: "settings", room, slack: hook });
  await boards.call(editor, { op: "transfer", room, uuid: owner.uuid });
  const { settings } = await boards.call(owner, { op: "settings.get", room });
  assert.equal(settings.slack, false);
  const audits = (await org.list("org:audit:"))
    .map((r) => r.value)
    .filter((r) => r.action === "board.share.slack");
  // Both can share a millisecond, so their order is not checked.
  assert.deepEqual(audits.map((r) => r.details.connected).sort(), [
    false,
    true,
  ]);
  await commit(boards, owner, room, (b) => {
    b.comments = [
      {
        id: "t",
        x: 0,
        y: 0,
        resolved: false,
        messages: [
          {
            id: "m",
            authorId: owner.uuid,
            authorName: owner.username,
            text: "@bob the plan is final",
            createdAt: 1,
          },
        ],
      },
    ];
  });
  await org.flush();
  assert.equal(fetched.filter((f) => f.url === hook).length, 0);
});

test("keys and invitations stop working when their administrator leaves", async () => {
  const { boards, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token: adminInvite } = await call(owner, {
    op: "org.invite",
    role: "admin",
  });
  await call(editor, { op: "org.join", token: adminInvite });
  const { key } = await call(editor, {
    op: "apikeys.create",
    name: "Sync",
    scopes: ["users:read"],
  });
  const { token } = await call(editor, { op: "org.invite", role: "member" });
  const users = () =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/v1/users", {
        headers: { Authorization: `Bearer ${key}` },
      }),
      "GET",
      "users",
    );
  assert.equal((await users()).status, 200);
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  org.forgetUser?.(editor.uuid);
  await assert.rejects(users(), { status: 401 });
  await assert.rejects(call(viewer, { op: "org.join", token }), {
    status: 403,
    message: /expired or was revoked/,
  });
  // Reactivated, what they made works again.
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "active",
  });
  org.forgetUser?.(editor.uuid);
  assert.equal((await users()).status, 200);
  await call(viewer, { op: "org.join", token });
  assert.equal(await org.role(viewer), "member");
});

test("webhooks stop receiving events when their administrator leaves", async () => {
  const { boards, org, call, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  const { token } = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token });
  await call(editor, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/made-in-settings",
  });
  // One made through the REST API with the administrator's key.
  const { key, record } = await call(editor, {
    op: "apikeys.create",
    name: "Automation",
    scopes: ["webhooks:write", "audit:read"],
  });
  const created = await restRoute(
    org,
    boards,
    new Request("https://w.puter.work/v1/webhooks", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    }),
    "POST",
    "webhooks",
    { url: "https://hooks.example.ca/made-with-key" },
  );
  assert.equal(created.status, 201);
  await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/owner",
  });
  const start = Date.now();
  let at = start;
  org.now = boards.now = () => at;
  const received = async () => {
    // The webhook list is kept for a minute, so each round starts past it.
    at += 120_000;
    fetched.length = 0;
    await org.audit(owner, "user.joined", { type: "user", id: owner.uuid });
    await org.flush();
    return fetched
      .filter(
        (f) =>
          f.url.startsWith("https://hooks.example.ca/") &&
          JSON.parse(f.options.body).event === "user.joined",
      )
      .map((f) => f.url)
      .sort();
  };
  await org.flush();
  assert.deepEqual(await received(), [
    "https://hooks.example.ca/made-in-settings",
    "https://hooks.example.ca/made-with-key",
    "https://hooks.example.ca/owner",
  ]);
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  org.forgetUser(editor.uuid);
  assert.deepEqual(await received(), ["https://hooks.example.ca/owner"]);
  // Deliveries waiting to be retried are not sent either.
  const hooks = (await org.list("org:webhook:")).map((r) => r.value);
  for (const hook of hooks)
    await org.kv.set(`org:hookq:${hook.id}:${new Date(at).toISOString()}`, {
      hook: hook.id,
      entry: { id: "queued", action: "user.joined", time: "t" },
      attempts: 1,
      next: at,
    });
  assert.deepEqual(await received(), [
    "https://hooks.example.ca/owner",
    "https://hooks.example.ca/owner",
  ]);
  // Reactivated, what they made works again.
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "active",
  });
  org.forgetUser(editor.uuid);
  assert.equal((await received()).length, 5);
  // One made with a key belongs to the key's administrator, so it keeps
  // working when the key is rotated.
  await call(owner, { op: "apikeys.revoke", id: record.id });
  assert.deepEqual(await received(), [
    "https://hooks.example.ca/made-in-settings",
    "https://hooks.example.ca/made-with-key",
    "https://hooks.example.ca/owner",
  ]);
});

test("one request with many events sends a bounded number of webhooks at once", async () => {
  const { boards, call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/wb",
    events: ["*"],
  });
  const { input, room } = createInput();
  await boards.call(owner, input);
  await org.flush();
  fetched.length = 0;
  for (let n = 0; n < 60; n++)
    await org.audit(owner, "board.content.updated", {
      type: "board",
      id: room,
    });
  await org.flush();
  // Every event is audited, but one request sends only a few webhooks;
  // the rest wait in the queue for later requests.
  const sent = () =>
    fetched.filter((f) => f.url === "https://hooks.example.ca/wb").length;
  assert.ok(sent() < 40, `${sent()}`);
  assert.ok((await org.list("org:hookq:")).length > 20);
  // Later requests with events of their own send what is waiting.
  for (let n = 0; n < 8; n++) {
    await call(owner, { op: "org.invite", role: "member" });
    await org.flush();
  }
  assert.ok(sent() >= 60, `${sent()}`);
});

test("the organization's AI is for its members, not guests", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "guest" });
  await call(guest, { op: "org.join", token });
  await assert.rejects(
    call(guest, { op: "org.ai", task: "summarize", prompt: "x" }),
    { status: 403, message: /organization members/ },
  );
});

test("AI use is recorded only on boards the person can open, and limited each minute", async () => {
  const { env, boards, call, org } = setup();
  org.puter.ai = { chat: async () => ({ message: { content: "ok" } }) };
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const { input, room } = createInput("Confidential");
  await boards.call(owner, input);
  const ask = (room) =>
    call(editor, { op: "org.ai", task: "summarize", prompt: "x", room });
  const used = async () =>
    (await call(owner, { op: "org.board.activity", room })).entries.filter(
      (e) => e.action === "ai.used",
    ).length;
  // Bob cannot open the private board, so his request writes nothing there.
  assert.equal((await ask(room)).text, "ok");
  assert.equal(await used(), 0);
  // Once invited, his use shows on it.
  const { token: link } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await boards.call(editor, { op: "join", room, token: link });
  await ask(room);
  assert.equal(await used(), 1);
  // Twenty a minute, counted in a minute no other test uses.
  env.now = (Math.floor(env.now / 60_000) + 7) * 60_000;
  for (let n = 0; n < 20; n++) await ask(room);
  await assert.rejects(ask(room), { status: 429 });
  env.now += 60_000;
  await ask(room);
});

test("an invitation that fails to join keeps the organization already in use", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://wb.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const { organizationLink } = await import("../src/organization/client.js");
    const A = setup(),
      B = setup();
    const bOwner = {
      uuid: "99999999-9999-4999-8999-999999999999",
      username: "Zed",
    };
    B.org.puter.auth.getUser = async () => bOwner;
    await A.call(owner, { op: "org.setup", name: "Org A" });
    const { token: joinA } = await A.call(owner, {
      op: "org.invite",
      role: "member",
    });
    await A.call(editor, { op: "org.join", token: joinA });
    await B.call(bOwner, { op: "org.setup", name: "Org B" });
    const { token: expired } = await B.call(bOwner, {
      op: "org.invite",
      role: "member",
      days: 1,
    });
    B.org.now = () => Date.now() + 3 * 86_400_000;
    const servers = { "https://a.puter.work": A, "https://b.puter.work": B };
    const saved = new Map();
    const org = createOrganization({
      puter: () => ({
        auth: { isSignedIn: () => true },
        kv: {
          get: async (k) => saved.get(k),
          set: async (k, v) => saved.set(k, v),
        },
      }),
      call: async (_p, server, input) => servers[server].call(editor, input),
      deploy: async () => {},
    });
    await org.use("https://a.puter.work");
    const home = createOrganizationHome({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        d.close = () => d.remove();
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    home.joinDialog(
      organizationLink("https://b.puter.work", expired, "https://wb.test/"),
    );
    const submit = async () => {
      document
        .querySelector("#org-join")
        .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
    };
    await submit();
    await submit();
    assert.equal(org.server, "https://a.puter.work");
    assert.equal(org.info.role, "member");
    assert.deepEqual(saved.get(ORG_KEY), { server: "https://a.puter.work" });
    assert.match(
      document.querySelector("#org-join-status").textContent,
      /expired or was revoked/,
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("organization names with dollar signs show as written before joining", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://wb.test",
  });
  const keys = ["document", "HTMLElement", "Node", "Event"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createOrganizationHome } =
      await import("../src/organization/home-ui.js");
    const { organizationLink } = await import("../src/organization/client.js");
    const org = {
      server: "https://a.puter.work",
      info: { name: "Old $' Co" },
      preview: async (server) => ({ server, info: { name: "New $$ $& Co" } }),
    };
    const home = createOrganizationHome({
      org,
      modal: (title, html, ready) => {
        const d = document.createElement("dialog");
        d.innerHTML = html;
        d.close = () => d.remove();
        document.body.append(d);
        ready?.(d);
        return d;
      },
      toast() {},
      icon: () => "",
      async openShared() {},
    });
    home.joinDialog(
      organizationLink("https://b.puter.work", "token", "https://wb.test/"),
    );
    document
      .querySelector("#org-join")
      .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      document.querySelector("#org-join-status").textContent,
      "Join New $$ $& Co at b.puter.work? This replaces Old $' Co as your organization.",
    );
  } finally {
    for (const key of keys) delete globalThis[key];
  }
});

test("signing out forgets the organization on the page, not the account's choice", async () => {
  const saved = new Map();
  const org = createOrganization({
    puter: () => ({
      auth: { isSignedIn: () => true },
      kv: {
        get: async (k) => saved.get(k),
        set: async (k, v) => saved.set(k, v),
      },
    }),
    call: async () => ({ name: "Fabrikam", role: "admin", user: {} }),
    deploy: async () => {},
  });
  const changes = [];
  org.onChange(() => changes.push(org.server));
  await org.use("https://a.puter.work");
  assert.equal(org.isAdmin, true);
  org.reset();
  assert.equal(org.server, null);
  assert.equal(org.info, null);
  assert.equal(org.isAdmin, false);
  assert.deepEqual(changes, ["https://a.puter.work", null]);
  assert.deepEqual(saved.get(ORG_KEY), { server: "https://a.puter.work" });
});

test("guest invitations are not made when boards are for members only", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { restrictToOrganization: true },
  });
  const info = await call(owner, { op: "org.info" });
  assert.equal(info.policy.restrictToOrganization, true);
  const { input, room } = createInput();
  await boards.call(owner, input);
  await assert.rejects(
    boards.call(owner, { op: "invite", room, guest: true, role: "viewer" }),
    { status: 403, message: /only allows its own members/ },
  );
  // Invitations for members still work.
  await boards.call(owner, { op: "invite", room, role: "viewer" });
});

test("a board on legal hold keeps its activity log past audit retention", async () => {
  const { boards, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { retention: { auditDays: 30 } },
  });
  const held = createInput("Held"),
    other = createInput("Other");
  for (const { input } of [held, other]) await boards.call(owner, input);
  await boards.call(owner, { op: "hold", room: held.room, enabled: true });
  const start = Date.now();
  org.now = () => start + 40 * 86_400_000;
  await purge(org);
  const activity = async (room) =>
    (await call(owner, { op: "org.board.activity", room })).entries.map(
      (e) => e.action,
    );
  assert.ok((await activity(held.room)).includes("board.hold.placed"));
  assert.deepEqual(await activity(other.room), []);
});

test("a board's creation audit keeps only a short source label", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const forged = createInput("Forged"),
    imported = createInput("Imported");
  await boards.call(owner, {
    ...forged.input,
    source: { via: "x".repeat(5000), approvedBy: "security" },
  });
  await boards.call(owner, { ...imported.input, source: "miro" });
  const created = (await call(owner, { op: "org.audit" })).entries.filter(
    (e) => e.action === "board.created",
  );
  const source = (room) =>
    created.find((e) => e.target.id === room).details.source;
  assert.equal(source(forged.room), null);
  assert.equal(source(imported.room), "miro");
});

test("a board's kept activity follows audit retention once its hold ends", async () => {
  const { boards, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { retention: { auditDays: 30 } },
  });
  const { input, room } = createInput("Held");
  await boards.call(owner, input);
  await boards.call(owner, { op: "hold", room, enabled: true });
  const start = Date.now();
  org.now = () => start + 40 * 86_400_000;
  await purge(org);
  await boards.call(owner, { op: "hold", room, enabled: false });
  org.now = () => start + 60 * 86_400_000;
  await purge(org);
  const { entries } = await call(owner, { op: "org.board.activity", room });
  // Only the release, made within the retention period, is left.
  assert.deepEqual(
    entries.map((e) => e.action),
    ["board.hold.released"],
  );
});

test("an administrator removed from a board still opens it", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Governed");
  await boards.call(owner, input);
  const invitation = await boards.call(owner, {
    op: "invite",
    room,
    role: "viewer",
  });
  await boards.call(editor, { op: "join", room, token: invitation.token });
  await boards.call(owner, {
    op: "role",
    room,
    uuid: editor.uuid,
    role: "removed",
  });
  // Removed, then made an administrator, as the Miro migration leaves the
  // administrator who ran it.
  const { token } = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token });
  const joined = await boards.call(editor, { op: "join", room });
  assert.equal(joined.member.role, "owner");
  // Removal still keeps other members out.
  await boards.call(viewer, { op: "join", room, token: invitation.token });
  await boards.call(owner, {
    op: "role",
    room,
    uuid: viewer.uuid,
    role: "removed",
  });
  await assert.rejects(
    boards.call(viewer, { op: "join", room, token: invitation.token }),
    { status: 403 },
  );
});

test("a directory update running alongside a visibility change never republishes the board", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Secret plans");
  await boards.call(owner, input);
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  assert.equal(await org.kv.get("org:visible:" + room), 1);
  // A commit's activity update reads the directory record, and the board is
  // made private before it writes.
  const get = org.kv.get.bind(org.kv);
  let paused = false;
  org.kv.get = async (key) => {
    const value = await get(key);
    if (
      !paused &&
      key === "org:board:" + room &&
      new Error().stack.includes("recordActivity")
    ) {
      paused = true;
      await boards.call(owner, { op: "settings", room, visibility: "private" });
    }
    return value;
  };
  try {
    await commit(boards, owner, room, (b) =>
      b.items.push(item("note", 10, 10, { text: "More" })),
    );
  } finally {
    org.kv.get = get;
  }
  assert.ok(paused, "The update ran alongside the change");
  assert.equal((await org.kv.get("org:board:" + room)).visibility, "private");
  assert.equal(await org.kv.get("org:visible:" + room), null);
});

test("people whose board access lapsed get no notifications carrying its content", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, { op: "org.policy.set", policy: { guestExpiryDays: 1 } });
  const { token: memberToken } = await call(owner, {
    op: "org.invite",
    role: "member",
  });
  await call(editor, { op: "org.join", token: memberToken });
  const { input, room } = createInput("Secret merger");
  await boards.call(owner, input);
  for (const [user, guestInvite] of [
    [guest, true],
    [editor, false],
  ]) {
    const { token } = await boards.call(owner, {
      op: "invite",
      room,
      role: "editor",
      guest: guestInvite,
    });
    await boards.call(user, { op: "join", room, token });
  }
  const start = Date.now();
  boards.now = org.now = () => start + 2 * 86_400_000;
  await assert.rejects(boards.call(guest, { op: "sync", room }), {
    status: 403,
  });
  await commit(boards, owner, room, (b) => {
    b.comments = [
      {
        id: "t1",
        x: 0,
        y: 0,
        resolved: false,
        messages: [
          {
            id: "m1",
            authorId: owner.uuid,
            authorName: owner.username,
            text: "@dee @bob confidential: acquire contoso",
            createdAt: 1,
          },
        ],
      },
    ];
    for (const person of [guest, editor])
      b.items.push(
        item("note", 0, 0, {
          text: `Task for ${person.username}`,
          task: {
            assignee: { id: person.uuid, name: person.username },
            start: null,
            due: null,
            status: "todo",
          },
        }),
      );
  });
  const list = async (user) =>
    (await call(user, { op: "notifications.list" })).items.map((n) => n.type);
  assert.deepEqual(await list(guest), []);
  assert.deepEqual((await list(editor)).sort(), ["assignment", "mention"]);
});

test("saving a comment sends its notification mail at once, not one after another", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Plan");
  await boards.call(owner, input);
  const people = [
    editor,
    viewer,
    { uuid: "55555555-5555-4555-8555-555555555555", username: "Eve" },
  ];
  for (const user of people) {
    const { token } = await boards.call(owner, {
      op: "invite",
      room,
      role: "editor",
    });
    await boards.call(user, { op: "join", room, token });
    await org.kv.set("org:user:" + user.uuid, {
      uuid: user.uuid,
      username: user.username,
      email: `${user.username.toLowerCase()}@fabrikam.test`,
      emailVerified: true,
      status: "active",
      role: "member",
    });
    org.forgetUser(user.uuid);
  }
  const sent = [];
  org.puter.email = {
    sendTransactional: (message) =>
      new Promise((resolve) =>
        setTimeout(() => {
          sent.push(message.to[0]);
          resolve({ failed: [] });
        }, 400),
      ),
  };
  const started = Date.now();
  await commit(boards, owner, room, (b) => {
    b.comments = [
      {
        id: "t1",
        x: 0,
        y: 0,
        resolved: false,
        messages: [
          {
            id: "m1",
            authorId: owner.uuid,
            authorName: owner.username,
            text: "@bob @cam @eve please review",
            createdAt: 1,
          },
        ],
      },
    ];
  });
  assert.equal(sent.length, 3);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test("an assignment email names an untitled task in French too", async () => {
  const { newTask } = await import("../src/planning/task.js");
  const { boards, call, org, sent } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Sprint", [
    item("note", 0, 0, { text: "" }),
  ]);
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await boards.call(editor, { op: "join", room, token });
  await org.kv.set("org:user:" + editor.uuid, {
    uuid: editor.uuid,
    username: editor.username,
    email: "bob@fabrikam.test",
    emailVerified: true,
    status: "active",
    role: "member",
  });
  org.forgetUser(editor.uuid);
  await commit(boards, owner, room, (b) => {
    b.items[0].task = {
      ...newTask(),
      assignee: { id: editor.uuid, name: "Bob" },
    };
  });
  await org.flush();
  const mail = JSON.stringify(sent.at(-1));
  assert.match(mail, /Untitled task/);
  assert.match(mail, /Tâche sans titre/);
});

test("a board's Slack channel stops hearing about it once whoever connected it no longer manages it", async () => {
  const { boards, call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { slack: { enabled: true } } },
  });
  const { token: adminToken } = await call(owner, {
    op: "org.invite",
    role: "admin",
  });
  await call(editor, { op: "org.join", token: adminToken });
  const { input, room } = createInput("Budget");
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await boards.call(viewer, { op: "join", room, token });
  // An administrator connects their own channel to someone else's board.
  const hook = "https://hooks.slack.com/services/T/B/admins-own";
  await boards.call(editor, { op: "settings", room, slack: hook });
  const mention = (id, text) =>
    commit(boards, viewer, room, (b) => {
      b.comments = [
        ...(b.comments || []),
        {
          id,
          x: 0,
          y: 0,
          resolved: false,
          messages: [
            {
              id: "m-" + id,
              authorId: viewer.uuid,
              authorName: viewer.username,
              text,
              createdAt: Date.now(),
            },
          ],
        },
      ];
    });
  const posts = () => fetched.filter((f) => f.url === hook).length;
  await mention("t1", "@alice first");
  await org.flush();
  assert.equal(posts(), 1);
  // They stop being an administrator.
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "member",
  });
  await mention("t2", "@alice the salary numbers");
  await org.flush();
  assert.equal(posts(), 1);
  assert.equal(await org.kv.get("org:boardslack:" + room), null);
});

test("a board's Slack channel hears about a mention even when the first person mentioned is deactivated", async () => {
  const { boards, call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { slack: { enabled: true } } },
  });
  const { input, room } = createInput("Plan");
  await boards.call(owner, input);
  for (const user of [editor, viewer]) {
    const { token } = await boards.call(owner, {
      op: "invite",
      room,
      role: "editor",
    });
    await boards.call(user, { op: "join", room, token });
  }
  await org.kv.set(
    "org:boardslack:" + room,
    "https://hooks.slack.com/services/X",
  );
  await org.kv.set("org:user:" + editor.uuid, {
    uuid: editor.uuid,
    username: editor.username,
    status: "deactivated",
    role: "member",
  });
  org.forgetUser(editor.uuid);
  await commit(boards, owner, room, (b) => {
    b.comments = [
      {
        id: "t1",
        x: 0,
        y: 0,
        resolved: false,
        messages: [
          {
            id: "m1",
            authorId: owner.uuid,
            authorName: owner.username,
            text: "@bob @cam please review",
            createdAt: 1,
          },
        ],
      },
    ];
  });
  assert.equal(
    fetched.filter((f) => f.url.includes("hooks.slack.com")).length,
    1,
  );
});

test("the directory lists only boards a guest can still open, never the trash to members, and keeps managers' details to administrators", async () => {
  const { boards, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, { op: "org.policy.set", policy: { guestExpiryDays: 1 } });
  for (const user of [editor, viewer])
    await call(user, {
      op: "org.join",
      token: (await call(owner, { op: "org.invite", role: "member" })).token,
    });
  const kickoff = createInput("Kickoff");
  await boards.call(owner, kickoff.input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room: kickoff.room,
    guest: true,
    role: "viewer",
  });
  await boards.call(guest, { op: "join", room: kickoff.room, token });
  const titles = async (user, input = {}) =>
    (
      await call(user, { op: "org.boards", scope: "mine", ...input })
    ).boards.map((b) => b.title);
  assert.deepEqual(await titles(guest), ["Kickoff"]);
  // Once the guest's access expires, the board, renamed since, is not listed.
  const start = Date.now();
  boards.now = org.now = () => start + 3 * 86400_000;
  await commit(boards, owner, kickoff.room, (x) => {
    x.title = "Layoffs Q4";
  });
  assert.deepEqual(await titles(guest), []);
  assert.deepEqual(await titles(guest, { query: "layoffs" }), []);
  boards.now = org.now = () => Date.now();
  // Details for managers stay with administrators.
  const held = createInput("Board");
  await boards.call(owner, held.input);
  await boards.call(owner, {
    op: "settings",
    room: held.room,
    visibility: "organization",
    orgRole: "commenter",
  });
  await boards.call(owner, { op: "hold", room: held.room, enabled: true });
  await boards.call(viewer, { op: "join", room: held.room });
  const row = (
    await call(viewer, { op: "org.boards", scope: "organization" })
  ).boards.find((b) => b.room === held.room);
  assert.equal(row.title, "Board");
  for (const key of ["legalHold", "lastEditor", "fingerprint"])
    assert.equal(row[key], undefined, key);
  const all = (await call(owner, { op: "org.boards", scope: "all" })).boards;
  assert.equal(all.find((b) => b.room === held.room).legalHold, true);
  // A member's boards in the trash are not listed to them.
  const gone = createInput("Gone");
  await boards.call(owner, gone.input);
  const invite = await boards.call(owner, {
    op: "invite",
    room: gone.room,
    role: "editor",
  });
  await boards.call(editor, {
    op: "join",
    room: gone.room,
    token: invite.token,
  });
  await boards.call(owner, { op: "delete", room: gone.room });
  assert.deepEqual(await titles(editor, { deleted: true }), []);
});

test("content removed within a minute of the last index write leaves the search index at once, and stays out after a synchronization or leave", async () => {
  const { boards, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(editor, {
    op: "org.join",
    token: (await call(owner, { op: "org.invite", role: "member" })).token,
  });
  const search = async () =>
    (
      await call(editor, {
        op: "org.boards",
        scope: "organization",
        query: "salary",
        content: true,
      })
    ).boards.length;
  for (const via of ["sync", "leave"]) {
    const b = createInput("Budget", [item("note", 0, 0, { text: "hello" })]);
    await boards.call(owner, b.input);
    await boards.call(owner, {
      op: "settings",
      room: b.room,
      visibility: "organization",
    });
    let now = Date.now();
    boards.now = org.now = () => now;
    await commit(boards, owner, b.room, (x) =>
      x.items.push(item("note", 5, 5, { text: "salary cuts for Bob" })),
    );
    now += 10_000;
    await commit(boards, owner, b.room, (x) => {
      x.items = x.items.filter((i) => !String(i.text).includes("salary"));
    });
    // A deletion is written at once rather than held back for the minute.
    assert.equal(await search(), 0, `${via}: written at once`);
    if (via === "sync") {
      now += 61_000;
      await boards.call(owner, { op: "sync", room: b.room });
    } else
      await boards.call(owner, {
        op: "leave",
        room: b.room,
        session: crypto.randomUUID(),
      });
    assert.equal(await search(), 0, via);
    boards.now = org.now = () => Date.now();
  }
});

test("content search leaves out what the workshop hides until it is revealed", async () => {
  const { boards, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(editor, {
    op: "org.join",
    token: (await call(owner, { op: "org.invite", role: "member" })).token,
  });
  const frame = item("frame", 0, 0, { text: "Answers", w: 400, h: 400 });
  const b = createInput("Quiz", [
    frame,
    item("note", 10, 10, { text: "answer is paris", parentId: frame.id }),
  ]);
  await boards.call(owner, b.input);
  await boards.call(owner, {
    op: "settings",
    room: b.room,
    visibility: "organization",
    orgRole: "editor",
  });
  const settings = (hide) => (x) => {
    x.workshop = {
      ...(x.workshop || {}),
      settings: { lock: "open", private: null, anonymous: false, hide },
    };
  };
  let now = Date.now();
  boards.now = org.now = () => now;
  await commit(boards, owner, b.room, settings([frame.id]));
  await boards.call(editor, { op: "join", room: b.room });
  const search = async () =>
    (
      await call(editor, {
        op: "org.boards",
        scope: "mine",
        query: "paris",
        content: true,
      })
    ).boards.length;
  assert.equal(await search(), 0);
  now += 5_000;
  await commit(boards, owner, b.room, settings([]));
  now += 61_000;
  await boards.call(owner, { op: "sync", room: b.room });
  assert.equal(await search(), 1, "revealed content is found");
  boards.now = org.now = () => Date.now();
});

test("live event handles end with the access they were given for", async () => {
  const { destroyBoard } = await import("../worker/retention.js");
  const { boards, org, call, fetched } = setup();
  const revoked = () =>
    fetched
      .filter((f) => f.options.method === "DELETE")
      .map((f) => f.url.split("/").at(-1));
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, { op: "org.policy.set", policy: { guestExpiryDays: 1 } });
  await call(editor, {
    op: "org.join",
    token: (await call(owner, { op: "org.invite", role: "admin" })).token,
  });
  // An administrator watching a board they never joined, then deactivated.
  const watched = createInput("Private HR");
  await boards.call(owner, watched.input);
  await boards.call(editor, { op: "events", room: watched.room });
  assert.ok(await org.kv.get(`wb:${watched.room}:handle:${editor.uuid}`));
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  assert.equal(revoked().length, 1);
  assert.equal(
    await org.kv.get(`wb:${watched.room}:handle:${editor.uuid}`),
    null,
  );
  // A refused operation by someone who keeps access leaves it.
  const team = createInput("Team");
  await boards.call(owner, team.input);
  const member = await boards.call(owner, {
    op: "invite",
    room: team.room,
    role: "editor",
  });
  await boards.call(viewer, {
    op: "join",
    room: team.room,
    token: member.token,
  });
  await boards.call(viewer, { op: "events", room: team.room });
  await assert.rejects(
    boards.call(viewer, { op: "settings.get", room: team.room }),
    {
      status: 403,
    },
  );
  assert.equal(revoked().length, 1, "an ordinary refusal");
  assert.ok(await org.kv.get(`wb:${team.room}:handle:${viewer.uuid}`));
  // A guest whose access lapsed, once refused.
  const kickoff = createInput("Kickoff");
  await boards.call(owner, kickoff.input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room: kickoff.room,
    guest: true,
    role: "viewer",
  });
  await boards.call(guest, { op: "join", room: kickoff.room, token });
  await boards.call(guest, { op: "events", room: kickoff.room });
  const start = Date.now();
  boards.now = org.now = () => start + 3 * 86400_000;
  await assert.rejects(boards.call(guest, { op: "sync", room: kickoff.room }), {
    status: 403,
  });
  assert.equal(revoked().length, 2);
  assert.equal(
    await org.kv.get(`wb:${kickoff.room}:handle:${guest.uuid}`),
    null,
  );
  boards.now = org.now = () => Date.now();
  // A purged board's handles are revoked, not only forgotten.
  const temp = createInput("Temp");
  await boards.call(owner, temp.input);
  const invite = await boards.call(owner, {
    op: "invite",
    room: temp.room,
    role: "editor",
  });
  await boards.call(viewer, {
    op: "join",
    room: temp.room,
    token: invite.token,
  });
  await boards.call(viewer, { op: "events", room: temp.room });
  await boards.call(owner, { op: "delete", room: temp.room });
  await destroyBoard(org, temp.room);
  assert.equal(revoked().length, 3);
  assert.equal(await org.kv.get(`org:uh:${viewer.uuid}:${temp.room}`), null);
});

test("boards whose text is all hidden keep content fingerprints of their own", async () => {
  const { boards, org, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const rooms = [];
  for (const text of ["answer is paris", "answer is rome"]) {
    const frame = item("frame", 0, 0, { text: "Answers", w: 400, h: 400 });
    const b = createInput("Quiz", [
      frame,
      item("note", 10, 10, { text, parentId: frame.id }),
    ]);
    await boards.call(owner, b.input);
    let now = Date.now();
    boards.now = org.now = () => (now += 61_000);
    await commit(boards, owner, b.room, (x) => {
      x.workshop = {
        settings: {
          lock: "open",
          private: null,
          anonymous: false,
          hide: [frame.id],
        },
      };
      x.items[1].text += ".";
    });
    rooms.push(b.room);
  }
  boards.now = org.now = () => Date.now();
  const records = await Promise.all(
    rooms.map((room) => org.kv.get("org:board:" + room)),
  );
  assert.ok(records.every((r) => r.fingerprint && !("content" in r)));
  assert.notEqual(records[0].fingerprint, records[1].fingerprint);
  assert.equal(await org.kv.get("org:idx:" + rooms[0]), "");
});

test("feedback stores validated language snapshots with trimmed text and keeps anonymous reports", async () => {
  const env = environment(),
    org = env.service.org;
  const call = (input) => adminCall(org, env.service, owner, input);
  await call({ op: "org.setup", name: "Feedback metadata audit" });
  const text = "Start. Veuillez faciliter la navigation. End.";
  const frenchStart = text.indexOf("Veuillez"),
    frenchEnd = text.indexOf(" End.");
  await call({
    op: "feedback.submit",
    ease: 4,
    comment: "  " + text + "  ",
    lang: "en-ca",
    textRuns: [
      { start: frenchStart + 2, end: frenchEnd + 2, style: { lang: "fr-ca" } },
    ],
    context: "help",
  });
  const saved = [...env.data]
    .filter(([key]) => key.startsWith("org:feedback:"))
    .map(([, value]) => value)[0];
  assert.equal(saved.comment, text);
  assert.equal(saved.lang, "en-CA");
  assert.deepEqual(saved.textRuns, [
    { start: frenchStart, end: frenchEnd, style: { lang: "fr-CA" } },
  ]);
  const report = await call({ op: "org.reports", days: 30 });
  assert.equal(report.feedback.recent[0].lang, "en-CA");
  assert.deepEqual(report.feedback.recent[0].textRuns, saved.textRuns);
  assert.equal(report.feedback.recent[0].uuid, undefined);
  assert.equal(saved.uuid, undefined);
  for (const metadata of [
    { lang: "bad tag" },
    { textRuns: [{ start: 0, end: 999, style: { lang: "fr" } }] },
    { textRuns: [{ start: 0, end: 3, style: { bold: true } }] },
    { textRuns: [{ start: 0, end: 3, style: { lang: "bad tag" } }] },
  ])
    await assert.rejects(
      call({ op: "feedback.submit", ease: 3, comment: "Hello", ...metadata }),
      { status: 400 },
    );
  await call({ op: "feedback.submit", ease: 5, comment: "Legacy" });
  const legacy = [...env.data].filter(
    ([key, value]) =>
      key.startsWith("org:feedback:") && value.comment === "Legacy",
  )[0][1];
  assert.equal(legacy.lang, undefined);
  assert.equal(legacy.textRuns, undefined);
});

test("feedback language ranges are clipped safely at the comment limit and blank ratings discard tags", async () => {
  const { call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const comment = "a".repeat(999) + "😀 suite";
  await call(owner, {
    op: "feedback.submit",
    ease: 3,
    comment,
    lang: "en",
    textRuns: [{ start: 995, end: comment.length, style: { lang: "fr" } }],
  });
  const record = (await org.list("org:feedback:")).map((r) => r.value)[0];
  assert.equal(record.comment, "a".repeat(999));
  assert.deepEqual(record.textRuns, [
    { start: 995, end: 999, style: { lang: "fr" } },
  ]);
  await assert.rejects(
    call(owner, {
      op: "feedback.submit",
      ease: 3,
      comment: "😀",
      textRuns: [{ start: 1, end: 2, style: { lang: "fr" } }],
    }),
    { status: 400 },
  );
  await call(owner, {
    op: "feedback.submit",
    ease: 5,
    comment: "   ",
    lang: "fr",
    textRuns: [{ start: 0, end: 3, style: { lang: "fr" } }],
  });
  const blank = (await org.list("org:feedback:"))
    .map((r) => r.value)
    .find((r) => !r.comment);
  assert.equal(blank.lang, undefined);
  assert.equal(blank.textRuns, undefined);
  const report = await call(owner, { op: "org.reports", days: 30 });
  assert.equal(report.feedback.responses, 2);
  assert.equal(report.feedback.recent.length, 1);
  assert.deepEqual(report.feedback.recent[0].textRuns, record.textRuns);
});

for (const length of [248, 249, 250])
  test(`Jira worker sends a complete Unicode summary at ${length} characters`, async () => {
    const { boards, call, org } = setup();
    await call(owner, { op: "org.setup", name: "Unicode tasks" });
    await call(owner, {
      op: "org.policy.set",
      policy: {
        integrations: {
          jira: {
            enabled: true,
            site: "fabrikam.atlassian.net",
            email: "svc@example.com",
            project: "WB",
          },
        },
      },
      secrets: { jira: "test-token" },
    });
    const { input, room } = createInput("Unicode task");
    await boards.call(owner, input);
    let payload;
    org.fetcher = async (url, options) => {
      assert.equal(
        String(url),
        "https://fabrikam.atlassian.net/rest/api/3/issue",
      );
      payload = JSON.parse(options.body);
      return Response.json({ key: "WB-1" });
    };
    const original = "Q".repeat(length) + "😀";
    const result = await call(owner, {
      op: "org.jira.create",
      room,
      issues: [
        { item: "unicode-task", summary: original, description: "Original 😀" },
      ],
    });
    assert.equal(result.created[0].key, "WB-1");
    assert.equal(
      payload.fields.summary,
      "Q".repeat(length) + (length === 248 ? "😀" : ""),
    );
    assert.equal(payload.fields.summary.isWellFormed(), true);
    assert.equal(
      payload.fields.description.content[0].content[0].text,
      "Original 😀",
    );
  });

test("an audit search with only an end date covers the 30 days before it", async () => {
  const { call, org, env } = setup();
  env.now = Date.parse("2026-06-01T12:00:00Z");
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  env.now = Date.parse("2026-06-10T12:00:00Z");
  await org.audit(owner, "team.updated", { type: "team", id: "t" });
  env.now = Date.parse("2026-09-01T12:00:00Z");
  const old = await call(owner, { op: "org.audit", to: "2026-06-20" });
  assert.deepEqual(
    old.entries.map((e) => e.action),
    ["team.updated", "org.created"],
  );
  const early = await call(owner, { op: "org.audit", to: "2026-07-20" });
  assert.deepEqual(early.entries, []);
  const recent = await call(owner, { op: "org.audit" });
  assert.deepEqual(recent.entries, []);
});

test("only the account owner moves the boards of an administrator or of the owner", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const admin = await call(owner, { op: "org.invite", role: "admin" });
  await call(editor, { op: "org.join", token: admin.token });
  const second = await call(owner, { op: "org.invite", role: "admin" });
  await call(viewer, { op: "org.join", token: second.token });
  const mine = createInput("Owner's board");
  await boards.call(owner, mine.input);
  const theirs = createInput("Second admin's board");
  await boards.call(viewer, theirs.input);
  // An administrator cannot take the owner's boards, nor another
  // administrator's, as they cannot change administrators either.
  for (const from of [owner.uuid, viewer.uuid])
    await assert.rejects(
      call(editor, { op: "org.users.transfer", from, to: editor.uuid }),
      { status: 403 },
    );
  // Nor one board at a time.
  for (const room of [mine.room, theirs.room])
    await assert.rejects(
      boards.call(editor, { op: "transfer", room, uuid: editor.uuid }),
      { status: 403, message: /Only the account owner/ },
    );
  // Nor an administrator's API key.
  const { key } = await call(editor, {
    op: "apikeys.create",
    name: "Admin",
    scopes: ["boards:write"],
  });
  await assert.rejects(
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/v1/boards/" + mine.room, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${key}` },
      }),
      "PATCH",
      "boards/" + mine.room,
      { owner: editor.uuid },
    ),
    { status: 403 },
  );
  assert.equal((await org.kv.get("org:board:" + mine.room)).owner, owner.uuid);
  assert.equal(
    (await org.kv.get("org:board:" + theirs.room)).owner,
    viewer.uuid,
  );
  // An administrator still hands on their own board.
  const own = createInput("First admin's board");
  await boards.call(editor, own.input);
  await boards.call(editor, {
    op: "transfer",
    room: own.room,
    uuid: owner.uuid,
  });
  assert.equal((await org.kv.get("org:board:" + own.room)).owner, owner.uuid);
  // The account owner still can.
  const moved = await call(owner, {
    op: "org.users.transfer",
    from: viewer.uuid,
    to: editor.uuid,
  });
  assert.equal(moved.transferred, 1);
  assert.equal(
    (await org.kv.get("org:board:" + theirs.room)).owner,
    editor.uuid,
  );
});

test("transferring a person's boards includes the ones in the trash", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const kept = createInput("Kept");
  await boards.call(editor, kept.input);
  const trashed = createInput("Trashed");
  await boards.call(editor, trashed.input);
  await boards.call(editor, { op: "delete", room: trashed.room });
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  const moved = await call(owner, {
    op: "org.users.transfer",
    from: editor.uuid,
    to: owner.uuid,
  });
  assert.equal(moved.transferred, 2);
  // Boards given to their own owner do not move, and say so.
  const same = await call(owner, {
    op: "org.users.transfer",
    from: owner.uuid,
    to: owner.uuid,
  });
  assert.equal(same.transferred, 0);
  // Restoring it later gives it back to the new owner, not to the person
  // who left.
  await boards.call(owner, { op: "restore", room: trashed.room });
  const record = await org.kv.get("org:board:" + trashed.room);
  assert.equal(record.owner, owner.uuid);
  assert.ok(!record.deleted);
});

test("possible duplicates ignore unnamed boards and list the largest sets first", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const titles = [
    ...Array(4).fill("Untitled board"),
    ...Array(2).fill("Tableau sans titre"),
    "Retro",
    "Retro (copy)",
    "Plan",
    "Plan (copie)",
    "plan (copy) (copy)",
  ];
  for (const title of titles)
    await boards.call(owner, createInput(title).input);
  const { groups } = await call(owner, { op: "org.boards.duplicates" });
  // Every board nobody named shares the default name: no sign of a copy.
  assert.deepEqual(
    groups.map((g) => [g.reason, g.count, g.boards.length]),
    [
      ["same title", 3, 3],
      ["same title", 2, 2],
    ],
  );
  assert.deepEqual(
    groups.map((g) => g.boards[0].title.toLowerCase().slice(0, 4)),
    ["plan", "retr"],
  );
});

test("board activity carries the category and target the console shows", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Activity");
  await boards.call(owner, input);
  await boards.call(owner, { op: "archive", room });
  // A record kept before activity stored its category still gets one.
  await org.kv.set(`org:bact:${room}:0000`, {
    id: "0000",
    at: 1,
    action: "board.visibility.link",
    actor: { username: "alice" },
  });
  const { entries } = await call(owner, { op: "org.board.activity", room });
  const archived = entries.find((e) => e.action === "board.archived");
  assert.equal(archived.category, "admin");
  assert.equal(archived.target.id, room);
  assert.equal(entries.find((e) => e.id === "0000").category, "sharing");
});

test("deleting a webhook records its endpoint, and only when there was one", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { webhook } = await call(owner, {
    op: "webhooks.create",
    url: "https://hooks.example.ca/wb",
  });
  await call(owner, { op: "webhooks.delete", id: webhook.id });
  // Again, as a second tab or a retry would.
  await call(owner, { op: "webhooks.delete", id: webhook.id });
  const { entries } = await call(owner, { op: "org.audit" });
  const deleted = entries.filter((e) => e.action === "webhook.deleted");
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].target.name, "https://hooks.example.ca/…");
});

test("governing a board already in that state records nothing", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Twice");
  await boards.call(owner, input);
  await boards.call(owner, { op: "archive", room });
  const archived = (await org.kv.get(`wb:${room}:meta`)).archived;
  org.now = () => Date.now() + 60_000;
  // From a second tab, or a list that had not reloaded yet.
  await boards.call(owner, { op: "archive", room });
  assert.equal((await org.kv.get(`wb:${room}:meta`)).archived, archived);
  await boards.call(owner, { op: "unarchive", room });
  await boards.call(owner, { op: "unarchive", room });
  await boards.call(owner, { op: "restore", room });
  await boards.call(owner, { op: "hold", room, enabled: false });
  const { entries } = await call(owner, { op: "org.audit" });
  assert.deepEqual(
    entries
      .map((e) => e.action)
      .filter((a) => /^board\.(archived|unarchived|restored|hold)/.test(a)),
    ["board.unarchived", "board.archived"],
  );
});

test("team audit records name the team as saved", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { team } = await call(owner, { op: "teams.create", name: " Design " });
  const renamed = await call(owner, {
    op: "teams.update",
    id: team.id,
    name: "   ",
  });
  assert.equal(renamed.team.name, "Design");
  await call(owner, { op: "teams.delete", id: team.id });
  const { entries } = await call(owner, { op: "org.audit" });
  assert.deepEqual(
    entries
      .filter((e) => e.action.startsWith("team."))
      .map((e) => [e.action, e.target.name])
      .sort(),
    [
      ["team.created", "Design"],
      ["team.deleted", "Design"],
      ["team.updated", "Design"],
    ],
  );
});

test("a policy change records which settings changed, from what to what", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { retention: { legalHold: true } },
  });
  await call(owner, {
    op: "org.policy.set",
    policy: { retention: { legalHold: false, auditDays: 30 } },
    // A value that is not text or null writes nothing.
    secrets: { slack: null, jira: 5 },
  });
  const records = (await call(owner, { op: "org.audit" })).entries
    .filter((e) => e.action === "policy.updated")
    .map((e) => e.details)
    .sort((a, b) => a.changed.length - b.changed.length);
  assert.deepEqual(records, [
    {
      changed: ["retention.legalHold"],
      from: { "retention.legalHold": false },
      to: { "retention.legalHold": true },
      secretsChanged: [],
    },
    {
      changed: ["retention.auditDays", "retention.legalHold"],
      from: { "retention.auditDays": 365, "retention.legalHold": true },
      to: { "retention.auditDays": 30, "retention.legalHold": false },
      secretsChanged: ["slack"],
    },
  ]);
});

test("transferring boards leaves one being purged to retention", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const kept = createInput("Kept");
  await boards.call(editor, kept.input);
  const purging = createInput("Purging");
  await boards.call(editor, purging.input);
  await boards.call(editor, { op: "delete", room: purging.room });
  await org.registerBoard(purging.room, { purging: Date.now() });
  const moved = await call(owner, {
    op: "org.users.transfer",
    from: editor.uuid,
    to: owner.uuid,
  });
  assert.equal(moved.transferred, 1);
  assert.equal((await org.kv.get("org:board:" + kept.room)).owner, owner.uuid);
  assert.equal(
    (await org.kv.get(`wb:${purging.room}:meta`)).owner,
    editor.uuid,
  );
  // Nor does a single transfer write back a board retention is removing.
  await assert.rejects(
    boards.transfer(purging.room, owner, owner.uuid, { admin: true }),
    { status: 409 },
  );
});

test("a policy change records an endpoint's origin, never its path or query", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      siem: {
        mode: "https",
        url: "https://ingest.example.ca/hook/abc?sig=SECRET123",
      },
    },
  });
  const record = (await call(owner, { op: "org.audit" })).entries.find(
    (e) => e.action === "policy.updated",
  );
  assert.equal(record.details.to["siem.url"], "https://ingest.example.ca/…");
  assert.equal(record.details.to["siem.mode"], "https");
  assert.ok(!JSON.stringify(record).includes("SECRET123"));
});

test("access through a public link or the organization ends when the board stops being shared that way", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      publicLinks: true,
      externalSharing: "anyone",
      guestExpiryDays: 0,
    },
  });
  const { token: memberLink } = await call(owner, {
    op: "org.invite",
    role: "member",
  });
  await call(editor, { op: "org.join", token: memberLink });
  const { input, room } = createInput();
  await boards.call(owner, input);
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "link",
    linkRole: "editor",
  });
  // A stranger opens the public link; a viewer is invited by name.
  await boards.call(guest, { op: "join", room });
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "viewer",
  });
  await boards.call(viewer, { op: "join", room, token: invite.token });
  await boards.call(owner, { op: "settings", room, visibility: "private" });
  await assert.rejects(boards.call(guest, { op: "sync", room }), {
    status: 403,
  });
  await assert.rejects(boards.call(guest, { op: "join", room }), {
    status: 403,
  });
  await boards.call(viewer, { op: "sync", room });
  const { members } = await boards.call(owner, { op: "members", room });
  assert.equal(members.find((m) => m.uuid === guest.uuid).inactive, true);
  // Sharing the link again lets them back in.
  await boards.call(owner, { op: "settings", room, visibility: "link" });
  await boards.call(guest, { op: "join", room });
  await boards.call(guest, { op: "sync", room });
  // So does an invitation, while the board is not shared by link.
  await boards.call(owner, { op: "settings", room, visibility: "private" });
  const named = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await boards.call(guest, { op: "join", room, token: named.token });
  await boards.call(guest, { op: "sync", room });
  // Turning public links off for the organization ends a link guest's
  // access, as it stops new ones.
  await boards.call(owner, { op: "settings", room, visibility: "link" });
  const other = {
    uuid: "55555555-5555-4555-8555-555555555555",
    username: "Eve",
  };
  await boards.call(other, { op: "join", room });
  await call(owner, {
    op: "org.policy.set",
    policy: { publicLinks: false, externalSharing: "guests" },
  });
  org.forgetPolicy();
  await assert.rejects(boards.call(other, { op: "sync", room }), {
    status: 403,
    message: /public board links/,
  });
  await boards.call(guest, { op: "sync", room });
  // A role given by name is kept like an invitation's.
  await call(owner, {
    op: "org.policy.set",
    policy: { publicLinks: true, externalSharing: "anyone" },
  });
  org.forgetPolicy();
  await boards.call(owner, {
    op: "role",
    room,
    uuid: other.uuid,
    role: "commenter",
  });
  await boards.call(owner, { op: "settings", room, visibility: "private" });
  await boards.call(other, { op: "sync", room });
  // A member who came in because the board was open to the organization
  // loses it when they become a guest, or when the board is made private.
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  await boards.call(editor, { op: "join", room });
  await boards.call(editor, { op: "sync", room });
  await boards.call(owner, { op: "settings", room, visibility: "private" });
  await assert.rejects(boards.call(editor, { op: "sync", room }), {
    status: 403,
  });
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  await boards.call(editor, { op: "sync", room });
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "guest",
  });
  org.forgetUser(editor.uuid);
  await assert.rejects(boards.call(editor, { op: "sync", room }), {
    status: 403,
    message: /own members/,
  });
});

test("a board transferred to someone who came through its visibility stays theirs when sharing changes", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const { input, room } = createInput("Org board");
  await boards.call(owner, input);
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  await boards.call(editor, { op: "join", room });
  await boards.call(owner, { op: "transfer", room, uuid: editor.uuid });
  const record = await boards.kv.get(`wb:${room}:member:${editor.uuid}`);
  assert.equal(record.role, "owner");
  assert.equal(record.via, undefined);
  await boards.call(editor, { op: "settings", room, visibility: "private" });
  assert.equal(
    (await boards.call(editor, { op: "join", room })).member.role,
    "owner",
  );
  // An owner record saved with `via` before transfers dropped it.
  await boards.setMember(room, { ...record, via: "organization" });
  assert.equal(
    (await boards.call(editor, { op: "join", room })).member.role,
    "owner",
  );
  await boards.call(editor, {
    op: "settings",
    room,
    visibility: "organization",
  });
});

test("webhooks subscribe to any audit action or prefix, and other event names are refused", async () => {
  const { call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { webhooks: { enabled: true } } },
  });
  const create = (events) =>
    call(owner, {
      op: "webhooks.create",
      url: "https://receiver.example.com/hook",
      events,
    });
  for (const events of [
    ["board.guest.joined"],
    ["auth.apikey.failed", "board.share.role"],
    ["board"],
    ["*"],
  ])
    assert.deepEqual((await create(events)).webhook.events, events);
  assert.deepEqual((await create(undefined)).webhook.events, ["*"]);
  for (const events of [["Board.Created"], ["board created"], [""], [42]])
    await assert.rejects(create(events), { status: 400 });
});

test("an administrator deactivates someone migrated or provisioned before they sign in", async () => {
  const { boards, call, sent } = setup();
  await call(owner, {
    op: "org.setup",
    name: "Fabrikam",
    domains: ["fabrikam.test"],
  });
  const { input, room } = createInput("Migrated");
  await boards.call(owner, input);
  await call(owner, {
    op: "migration.apply",
    room,
    members: [{ email: "former.staff@fabrikam.test", role: "editor" }],
  });
  const pending = (await call(owner, { op: "org.users.list" })).users.find(
    (u) => u.email === "former.staff@fabrikam.test",
  );
  assert.equal(pending.active, true);
  const { user } = await call(owner, {
    op: "org.users.update",
    uuid: pending.uuid,
    status: "deactivated",
  });
  assert.equal(user.status, "pending");
  assert.equal(user.active, false);
  // Whoever verifies the address arrives deactivated.
  await call(editor, {
    op: "email.start",
    email: "former.staff@fabrikam.test",
  });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  const linked = await call(editor, { op: "email.confirm", code });
  assert.equal(linked.user.status, "deactivated");
  await assert.rejects(boards.call(editor, { op: "join", room }), {
    status: 403,
  });
});

test("a board's activity log pages back through every event", async () => {
  const { env, boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput("Busy board");
  await boards.call(owner, input);
  for (let n = 0; n < 650; n++) {
    env.now += 1000;
    await org.audit(
      owner,
      "board.comment.created",
      { type: "board", id: room },
      { n },
    );
  }
  await org.flush();
  const first = await call(owner, { op: "org.board.activity", room });
  assert.equal(first.entries.length, 500);
  assert.equal(first.entries[0].details.n, 649);
  assert.ok(first.cursor);
  const rest = await call(owner, {
    op: "org.board.activity",
    room,
    cursor: first.cursor,
  });
  assert.equal(rest.cursor, null);
  const seen = [...first.entries, ...rest.entries]
    .map((e) => e.details?.n)
    .filter((n) => n !== undefined);
  assert.equal(seen.length, 650);
  assert.equal(new Set(seen).size, 650);
  assert.equal(seen.at(-1), 0);
});

test("a guest the organization makes a member is no longer shown or ticketed as a guest", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, guest, { room, token: invite.token });
  const listed = async () =>
    (await boards.call(owner, { op: "members", room })).members.find(
      (m) => m.uuid === guest.uuid,
    );
  assert.equal((await listed()).guest, true);
  await call(owner, {
    op: "org.users.update",
    uuid: guest.uuid,
    role: "member",
  });
  org.forgetUser(guest.uuid);
  const member = await listed();
  assert.equal(member.guest, undefined);
  assert.equal(member.expires, undefined);
  // And back: a member made a guest is shown as one.
  await call(owner, {
    op: "org.users.update",
    uuid: guest.uuid,
    role: "guest",
  });
  org.forgetUser(guest.uuid);
  assert.equal((await listed()).guest, true);
});

test("an invitation makes someone who came through organization sharing a member by name, never with less", async () => {
  const { boards, call } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const { token } = await call(owner, { op: "org.invite", role: "member" });
  await call(editor, { op: "org.join", token });
  const { input, room } = createInput();
  await boards.call(owner, input);
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
    orgRole: "viewer",
  });
  assert.equal(
    (await boards.call(editor, { op: "join", room })).member.via,
    "organization",
  );
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  const joined = await boards.call(editor, {
    op: "join",
    room,
    token: invite.token,
  });
  assert.equal(joined.member.role, "editor");
  assert.equal(joined.member.via, undefined);
  // Invited by name, they keep the board when it stops being shared.
  await boards.call(owner, { op: "settings", room, visibility: "private" });
  assert.equal(
    (await boards.call(editor, { op: "join", room })).member.role,
    "editor",
  );
  // A viewer invitation does not take away what organization sharing gave.
  const second = createInput("Second");
  await boards.call(owner, second.input);
  await boards.call(owner, {
    op: "settings",
    room: second.room,
    visibility: "organization",
    orgRole: "editor",
  });
  await boards.call(editor, { op: "join", room: second.room });
  const viewing = await boards.call(owner, {
    op: "invite",
    room: second.room,
    role: "viewer",
  });
  assert.equal(
    (
      await boards.call(editor, {
        op: "join",
        room: second.room,
        token: viewing.token,
      })
    ).member.role,
    "editor",
  );
});

test("Sentinel calls stay under the ingestion API's 1 MB limit, so a large batch cannot block the export", async () => {
  const { env, call, org, fetched } = setup();
  const sizes = [];
  const base = org.fetcher;
  org.fetcher = async (url, options) => {
    if (String(url).includes("/dataCollectionRules/")) {
      const bytes = new TextEncoder().encode(options.body).length;
      sizes.push(bytes);
      if (bytes > 1_000_000) return new Response("{}", { status: 413 });
    }
    return base(url, options);
  };
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      siem: {
        mode: "sentinel",
        sentinel: {
          tenantId: "11111111-2222-3333-4444-555555555555",
          clientId: "11111111-2222-3333-4444-666666666666",
          endpoint: "https://wb-abc.canadacentral-1.ingest.monitor.azure.com",
          dcrId: "dcr-0123456789abcdef0123456789abcdef",
          stream: "Custom-WhiteboardAudit",
        },
      },
    },
    secrets: { sentinel: "entra-secret" },
  });
  await org.flush();
  // A group sync whose records each list hundreds of members.
  const members = (n) =>
    Array.from(
      { length: 100 },
      (_, i) =>
        `aaaaaaaa-bbbb-4ccc-8ddd-${String(n * 1000 + i).padStart(12, "0")}`,
    );
  for (let n = 0; n < 200; n++) {
    await org.audit(
      owner,
      "team.updated",
      { type: "team", id: "t" + n, name: "Team " + n },
      { added: members(n), removed: members(n + 500) },
    );
    env.now += 20;
  }
  await org.audit(owner, "board.visibility.link", { type: "board", id: "b" });
  org.pending.length = 0;
  env.now += 60_000;
  const result = await siem(org, await org.policy());
  assert.equal(result.error, undefined);
  assert.ok(result.sent >= 201);
  assert.ok(sizes.length > 1 && sizes.every((b) => b <= 1_000_000), sizes);
  const sent = fetched
    .filter((f) => f.url.includes("/dataCollectionRules/"))
    .flatMap((f) => JSON.parse(f.options.body).map((r) => r.Action));
  assert.ok(sent.includes("board.visibility.link"));
  // A record too large to send alone goes without its details.
  const [chunk] = sentinelChunks([
    siemRecord({
      id: "x",
      time: new Date(0).toISOString(),
      action: "team.updated",
      details: { members: "m".repeat(2_000_000) },
    }),
  ]);
  const [record] = JSON.parse(chunk);
  assert.equal(record.Action, "team.updated");
  assert.equal(record.Details.truncated, true);
  assert.ok(new TextEncoder().encode(chunk).length < 1_000_000);
});

test("a replaced Sentinel client secret is used at once, so a wrong one fails its test", async () => {
  const { call, org } = setup();
  const base = org.fetcher;
  org.fetcher = async (url, options) =>
    String(url).includes("login.microsoftonline.com") &&
    options.body.get("client_secret") !== "right-secret"
      ? Response.json({ error: "invalid_client" }, { status: 401 })
      : base(url, options);
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  const sentinel = (secret) =>
    call(owner, {
      op: "org.policy.set",
      policy: {
        siem: {
          mode: "sentinel",
          sentinel: {
            tenantId: "11111111-2222-3333-4444-555555555555",
            clientId: "11111111-2222-3333-4444-777777777777",
            endpoint: "https://wb-abc.canadacentral-1.ingest.monitor.azure.com",
            dcrId: "dcr-0123456789abcdef0123456789abcdef",
            stream: "Custom-WhiteboardAudit",
          },
        },
      },
      secrets: { sentinel: secret },
    });
  await sentinel("right-secret");
  assert.equal((await call(owner, { op: "org.siem.test" })).sent >= 1, true);
  await sentinel("wrong-secret");
  await assert.rejects(call(owner, { op: "org.siem.test" }), /invalid_client/);
});

test("Sentinel signs in to the Azure cloud its ingestion endpoint belongs to", async () => {
  const { call, org, fetched } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      siem: {
        mode: "sentinel",
        sentinel: {
          tenantId: "11111111-2222-3333-4444-555555555555",
          clientId: "11111111-2222-3333-4444-888888888888",
          endpoint: "https://wb-abc.usgovvirginia-1.ingest.monitor.azure.us",
          dcrId: "dcr-0123456789abcdef0123456789abcdef",
          stream: "Custom-WhiteboardAudit",
        },
      },
    },
    secrets: { sentinel: "entra-secret" },
  });
  const base = org.fetcher;
  org.fetcher = (url, options) =>
    String(url).startsWith("https://login.microsoftonline.us/")
      ? (fetched.push({ url: String(url), options }),
        Response.json({ access_token: "gov-token", expires_in: 3600 }))
      : base(url, options);
  await call(owner, { op: "org.siem.test" });
  const logins = fetched.filter((f) => f.url.includes("/oauth2/v2.0/token"));
  assert.deepEqual(
    logins.map((f) => [new URL(f.url).host, f.options.body.get("scope")]),
    [["login.microsoftonline.us", "https://monitor.azure.us//.default"]],
  );
  assert.equal(
    fetched.find((f) => f.url.includes("/dataCollectionRules/")).options.headers
      .Authorization,
    "Bearer gov-token",
  );
  assert.deepEqual(
    azureCloud("https://x.chinanorth3-1.ingest.monitor.azure.cn"),
    {
      login: "login.chinacloudapi.cn",
      audience: "monitor.azure.cn",
    },
  );
  assert.equal(
    azureCloud("https://x.canadacentral-1.ingest.monitor.azure.com").audience,
    "monitor.azure.com",
  );
});

test("a Slack channel that stops taking posts says so where it is set up, and a test post checks it", async () => {
  const { boards, call, org, fetched } = setup();
  const refused = new Set();
  const base = org.fetcher;
  org.fetcher = boards.fetcher = async (url, options) =>
    refused.has(String(url))
      ? (fetched.push({ url: String(url), options }),
        new Response("channel_is_archived", { status: 410 }))
      : base(url, options);
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await assert.rejects(call(owner, { op: "org.slack.test" }), {
    status: 400,
  });
  const alerts = "https://hooks.slack.com/services/T/B/alerts";
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { slack: { enabled: true } } },
    secrets: { slack: alerts },
  });
  assert.equal((await call(owner, { op: "org.policy.get" })).slack, null);
  await call(owner, { op: "org.slack.test" });
  const test = fetched.filter((f) => f.url === alerts).at(-1);
  assert.match(JSON.parse(test.options.body).text, /can post to this channel/);
  assert.ok((await call(owner, { op: "org.policy.get" })).slack.lastSuccess);
  refused.add(alerts);
  await assert.rejects(call(owner, { op: "org.slack.test" }), {
    status: 502,
    message: "Slack refused the message (410): channel_is_archived",
  });
  const failed = (await call(owner, { op: "org.policy.get" })).slack;
  assert.equal(
    failed.lastError,
    "Slack refused the message (410): channel_is_archived",
  );
  // A new address starts clean.
  await call(owner, {
    op: "org.policy.set",
    policy: {},
    secrets: { slack: "https://hooks.slack.com/services/T/B/new" },
  });
  assert.equal((await call(owner, { op: "org.policy.get" })).slack, null);
  // A board's own channel: its owner sees why its mentions stopped.
  const { input, room } = createInput();
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, editor, { room, token });
  const channel = "https://hooks.slack.com/services/T/B/board";
  refused.add(channel);
  await boards.call(owner, { op: "settings", room, slack: channel });
  await commit(boards, editor, room, (b) => {
    b.comments = [
      {
        id: "t1",
        x: 0,
        y: 0,
        resolved: false,
        messages: [
          {
            id: "m1",
            authorId: editor.uuid,
            authorName: editor.username,
            text: "@alice please look",
            createdAt: 1,
          },
        ],
      },
    ];
  });
  await org.flush();
  assert.ok(fetched.some((f) => f.url === channel));
  const { settings } = await boards.call(owner, { op: "settings.get", room });
  assert.equal(
    settings.slackError,
    "Slack refused the message (410): channel_is_archived",
  );
  await boards.call(owner, {
    op: "settings",
    room,
    slack: "https://hooks.slack.com/services/T/B/board-2",
  });
  const again = await boards.call(owner, { op: "settings.get", room });
  assert.equal(again.settings.slackError, undefined);
  assert.equal(again.settings.slack, true);
});

test("a refused Jira status request carries Jira's own reason", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      integrations: {
        jira: {
          enabled: true,
          site: "fabrikam.atlassian.net",
          email: "svc@fabrikam.test",
          project: "WB",
        },
      },
    },
    secrets: { jira: "token" },
  });
  const { input, room } = createInput("Plan");
  await boards.call(owner, input);
  org.fetcher = async () =>
    Response.json(
      {
        errorMessages: [
          "The value 'WB' does not exist for the field 'project'.",
        ],
      },
      { status: 400 },
    );
  await assert.rejects(
    call(owner, { op: "org.jira.status", room, keys: ["WB-1"] }),
    {
      status: 502,
      message: "Jira did not accept the request.",
      detail: "The value 'WB' does not exist for the field 'project'.",
    },
  );
  org.fetcher = async () => new Response("", { status: 401 });
  await assert.rejects(
    call(owner, { op: "org.jira.status", room, keys: ["WB-1"] }),
    { status: 502, message: /Check its email and API token/ },
  );
});

test("the REST board directory searches content only when asked, and pages with the cursor it documents", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const title of ["Plan", "Retro", "Roadmap"]) {
    const { input } = createInput(title, [
      item("note", 0, 0, { text: "Budget review" }),
    ]);
    await boards.call(owner, input);
  }
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Directory",
    scopes: ["boards:read"],
  });
  const get = async (query) =>
    (
      await restRoute(
        org,
        boards,
        new Request("https://w.puter.work/v1/boards?" + query, {
          headers: { Authorization: `Bearer ${key}` },
        }),
        "GET",
        "boards",
        null,
      )
    ).json();
  assert.equal((await get("query=budget&content=false")).total, 0);
  assert.equal((await get("query=budget&content=true")).total, 3);
  const first = await get("limit=2&sort=title");
  assert.ok(first.next);
  const second = await get(
    `limit=2&sort=title&after=${encodeURIComponent(first.next)}`,
  );
  assert.deepEqual(
    [...first.boards, ...second.boards].map((b) => b.title),
    ["Plan", "Retro", "Roadmap"],
  );
  const spec = openAPI("https://w.puter.work");
  const names = spec.paths["/v1/boards"].get.parameters.map((p) => p.name);
  assert.ok(names.includes("after") && names.includes("content"));
});

test("people joining a board in a burst are exported to the SIEM together, and what waits goes with the next request", async () => {
  const { env, boards, call, org, fetched } = setup();
  org.now = () => env.now;
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "https", url: "https://siem.fabrikam.test/in" } },
  });
  const { input, room } = createInput("Workshop");
  await boards.call(owner, input);
  await boards.call(owner, {
    op: "settings",
    room,
    visibility: "organization",
  });
  await org.flush();
  const posts = () =>
    fetched.filter((f) => f.url === "https://siem.fabrikam.test/in");
  const exported = () =>
    posts().flatMap((f) =>
      JSON.parse(f.options.body).events.map((e) => e.Action),
    );
  env.now += 15_000;
  const before = posts().length;
  // Thirty members open the board within three seconds.
  for (let n = 0; n < 30; n++) {
    const person = {
      uuid: `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`,
      username: "member" + n,
    };
    await org.saveUser({
      ...person,
      role: "member",
      status: "active",
      license: "full",
      created: env.now,
      teams: [],
    });
    await boards.call(person, { op: "join", room });
    env.now += 100;
  }
  assert.ok(posts().length - before <= 1, `${posts().length - before}`);
  const joins = () => exported().filter((a) => a === "board.joined").length;
  assert.ok(joins() < 30);
  // The rest go with the next request once the interval has passed, of
  // whatever kind, such as a synchronization that audits nothing.
  env.now += 15_000;
  await org.flush();
  assert.equal(joins(), 30);
  // A change to what someone may do on a board goes at once.
  await org.audit(owner, "board.role.changed", { type: "board", id: room });
  await org.flush();
  assert.equal(exported().at(-1), "board.role.changed");
});

test("requests at the same moment export each audit record to the SIEM once", async () => {
  const { env, boards, call, org, fetched } = setup();
  org.now = () => env.now;
  const base = org.fetcher;
  org.fetcher = boards.fetcher = async (url, options) => {
    if (String(url).startsWith("https://siem.fabrikam.test"))
      await new Promise((r) => setTimeout(r, 20));
    return base(url, options);
  };
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "https", url: "https://siem.fabrikam.test/in" } },
  });
  await org.flush();
  env.now += 15_000;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      organizationRequest(org, boards, owner, {
        op: "org.invite",
        role: "member",
      }),
    ),
  );
  const ids = fetched
    .filter((f) => f.url === "https://siem.fabrikam.test/in")
    .flatMap((f) => JSON.parse(f.options.body).events)
    .filter((e) => e.Action === "user.invited")
    .map((e) => e.EventId);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
});

test("while the SIEM is unreachable, urgent events wait out the export interval instead of each request waiting on it", async () => {
  const { env, boards, call, org } = setup();
  org.now = () => env.now;
  let calls = 0;
  const base = org.fetcher;
  org.fetcher = boards.fetcher = async (url, options) => {
    if (String(url).startsWith("https://siem.fabrikam.test")) {
      calls++;
      throw Object.assign(Error("timed out"), { name: "TimeoutError" });
    }
    return base(url, options);
  };
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "https", url: "https://siem.fabrikam.test/in" } },
  });
  await org.flush();
  const first = calls;
  for (let n = 0; n < 3; n++) {
    env.now += 1000;
    await organizationRequest(org, boards, owner, {
      op: "org.invite",
      role: "member",
    });
  }
  assert.equal(calls, first);
  env.now += 15_000;
  await organizationRequest(org, boards, owner, { op: "org.info" });
  assert.equal(calls, first + 1);
});

test("only events the SIEM exports, and not AI use or provisioning, keep an export waiting or send one at once", async () => {
  const { env, call, org, fetched } = setup();
  org.now = () => env.now;
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { siem: { mode: "https", url: "https://siem.fabrikam.test/in" } },
  });
  await org.flush();
  const posts = () =>
    fetched.filter((f) => f.url === "https://siem.fabrikam.test/in").length;
  env.now += 1000;
  // Board content is not among the exported categories by default.
  await org.audit(owner, "board.export", { type: "board", id: "b" });
  await org.flush();
  assert.equal(org.instance.siemBacklog, false);
  const before = posts();
  for (const action of ["ai.used", "scim.user.created", "user.joined"]) {
    await org.audit(owner, action, { type: "user", id: "u" });
    await org.flush();
  }
  assert.equal(posts(), before);
  assert.equal(org.instance.siemBacklog, true);
});

test("a passing Slack failure is reported but does not tell the board's owner to set the channel up again", async () => {
  const { boards, call, org } = setup();
  let answer = () => new Response("ok");
  const base = org.fetcher;
  org.fetcher = boards.fetcher = async (url, options) =>
    String(url).startsWith("https://hooks.slack.com/services/T/B/board")
      ? answer()
      : base(url, options);
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: { integrations: { slack: { enabled: true } } },
    secrets: { slack: "https://hooks.slack.com/services/T/B/board-alerts" },
  });
  const { input, room } = createInput();
  await boards.call(owner, input);
  const { token } = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await join({ service: boards }, editor, { room, token });
  await boards.call(owner, {
    op: "settings",
    room,
    slack: "https://hooks.slack.com/services/T/B/board",
  });
  let n = 0;
  const mention = () =>
    commit(boards, editor, room, (b) => {
      n++;
      b.comments = [
        {
          id: "t" + n,
          x: 0,
          y: 0,
          resolved: false,
          messages: [
            {
              id: "m" + n,
              authorId: editor.uuid,
              authorName: editor.username,
              text: `@alice look ${n}`,
              createdAt: n,
            },
          ],
        },
      ];
    }).then(() => org.flush());
  const writes = [];
  const set = org.kv.set.bind(org.kv);
  org.kv.set = (key, ...rest) => {
    if (String(key).startsWith("org:slackstatus:")) writes.push(key);
    return set(key, ...rest);
  };
  await mention();
  await mention();
  // A post that went through is recorded once, not for every mention.
  assert.equal(writes.length, 1);
  answer = () => {
    throw Object.assign(Error("The operation timed out."), {
      name: "TimeoutError",
    });
  };
  await mention();
  const status = await org.kv.get("org:slackstatus:board:" + room);
  assert.equal(status.lastError, "Could not reach Slack.");
  let { settings } = await boards.call(owner, { op: "settings.get", room });
  assert.equal(settings.slackError, undefined);
  answer = () => new Response("rate_limited", { status: 429 });
  await mention();
  ({ settings } = await boards.call(owner, { op: "settings.get", room }));
  assert.equal(settings.slackError, undefined);
  answer = () => new Response("no_service", { status: 404 });
  await mention();
  ({ settings } = await boards.call(owner, { op: "settings.get", room }));
  assert.equal(
    settings.slackError,
    "Slack refused the message (404): no_service",
  );
});

test("a Jira status refresh leaves out issues Jira no longer has rather than failing", async () => {
  const { boards, call, org } = setup();
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  await call(owner, {
    op: "org.policy.set",
    policy: {
      integrations: {
        jira: {
          enabled: true,
          site: "fabrikam.atlassian.net",
          email: "svc@fabrikam.test",
          project: "WB",
        },
      },
    },
    secrets: { jira: "token" },
  });
  const { input, room } = createInput("Plan");
  await boards.call(owner, input);
  const asked = [];
  org.fetcher = async (target) => {
    const jql = new URL(target).searchParams.get("jql");
    asked.push(jql);
    // As Jira answers a search naming an issue that was deleted.
    if (jql.includes("WB-9"))
      return Response.json(
        {
          errorMessages: [
            "An issue with key 'WB-9' does not exist for field 'key'.",
          ],
        },
        { status: 400 },
      );
    return Response.json({
      issues: ["WB-1", "WB-2"].map((key) => ({
        key,
        fields: { status: { name: "Done", statusCategory: { key: "done" } } },
      })),
    });
  };
  const { issues } = await call(owner, {
    op: "org.jira.status",
    room,
    keys: ["WB-1", "WB-9", "WB-2"],
  });
  assert.deepEqual(
    issues.map((i) => i.key),
    ["WB-1", "WB-2"],
  );
  assert.equal(asked.length, 2);
  assert.ok(!asked[1].includes("WB-9"));
});
