import test from "node:test";
import assert from "node:assert/strict";
import { board, item } from "../src/model.js";
import { SharedDocument } from "../src/collaboration/document.js";
import { encode } from "../src/collaboration/protocol.js";
import { adminCall } from "../worker/admin.js";
import { restRoute } from "../worker/api.js";
import { environment, owner, editor, viewer } from "./collaboration-helpers.js";

// A board filed under a team can give the team's members a role, so who
// is on the team, as the console, the REST API, or an identity provider's
// groups say, decides who can open it.
const guest = {
  uuid: "44444444-4444-4444-8444-444444444444",
  username: "Dee",
};
const carol = {
  uuid: "55555555-5555-4555-8555-555555555555",
  username: "Carol",
};
async function setup() {
  const env = environment();
  const boards = env.service,
    org = boards.org;
  const call = (user, input) => adminCall(org, boards, user, input);
  await call(owner, { op: "org.setup", name: "Fabrikam" });
  for (const [person, role] of [
    [editor, "member"],
    [viewer, "member"],
    [carol, "member"],
    [guest, "guest"],
  ]) {
    const { token } = await call(owner, { op: "org.invite", role });
    await call(person, { op: "org.join", token });
  }
  const { team } = await call(owner, {
    op: "teams.create",
    name: "Design",
    members: [editor.uuid, guest.uuid],
  });
  const { team: other } = await call(owner, {
    op: "teams.create",
    name: "Sales",
    members: [carol.uuid],
  });
  return { env, boards, org, call, team, other };
}
async function create(boards, user = owner, extra = {}) {
  const b = board("Roadmap"),
    doc = new SharedDocument();
  b.items = [item("note", 0, 0, { text: "Roadmap" })];
  doc.commit(b);
  await boards.call(user, {
    op: "create",
    room: b.id,
    update: encode(doc.update()),
    ...extra,
  });
  doc.destroy();
  return b.id;
}
const join = async (boards, user, room) =>
  (await boards.call(user, { op: "join", room })).member;
const opens = (boards, user, room) =>
  boards.call(user, { op: "sync", room }).then(
    () => true,
    (error) => {
      if (error.status !== 403) throw error;
      return false;
    },
  );
const settings = (boards, room, change, user = owner) =>
  boards.call(user, { op: "settings", room, ...change });

test("a board gives the members of its team the role chosen for them, and none by default", async () => {
  const { boards, org, team } = await setup();
  const room = await create(boards, owner, { team: team.id });
  // Filing alone gives the team nothing, as on boards from before.
  assert.equal((await org.kv.get(`wb:${room}:meta`)).team, team.id);
  assert.equal(
    (await boards.call(owner, { op: "settings.get", room })).settings.teamRole,
    "none",
  );
  await assert.rejects(join(boards, editor, room), { status: 403 });
  const saved = await settings(boards, room, { teamRole: "editor" });
  assert.equal(saved.settings.teamRole, "editor");
  assert.equal(saved.settings.team, team.id);
  const member = await join(boards, editor, room);
  assert.equal(member.role, "editor");
  assert.equal(member.via, "team");
  assert.equal(await opens(boards, editor, room), true);
  // The board is in their own list, with the role it gave them.
  assert.equal(await org.kv.get(`org:ub:${editor.uuid}:${room}`), "editor");
  // Members of the organization on other teams, and guests on this one,
  // are not let in.
  await assert.rejects(join(boards, carol, room), { status: 403 });
  await assert.rejects(join(boards, guest, room), { status: 403 });
  assert.equal(await org.kv.get(`wb:${room}:member:${guest.uuid}`), null);
  // The members list shows them as able to open the board.
  const { members } = await boards.call(owner, { op: "members", room });
  const listed = members.find((m) => m.uuid === editor.uuid);
  assert.equal(listed.role, "editor");
  assert.equal(listed.inactive, undefined);
  assert.equal((await org.kv.get("org:board:" + room)).memberCount, 2);
});

test("team access ends when the person leaves the team, through the console or the identity provider's groups", async () => {
  const { env, boards, org, call, team } = await setup();
  const room = await create(boards, owner, { team: team.id });
  await settings(boards, room, { teamRole: "commenter" });
  await join(boards, editor, room);
  await call(owner, { op: "teams.update", id: team.id, remove: [editor.uuid] });
  assert.equal(await opens(boards, editor, room), false);
  // The members list marks them, and the board stops counting them.
  const { members } = await boards.call(owner, { op: "members", room });
  assert.equal(members.find((m) => m.uuid === editor.uuid).inactive, true);
  // Joining the team again lets them back in.
  await call(owner, { op: "teams.update", id: team.id, add: [editor.uuid] });
  assert.equal(await opens(boards, editor, room), true);
  // A SCIM group change does the same.
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "IdP",
    scopes: ["scim"],
  });
  const scim = (path, method, body) =>
    restRoute(
      org,
      boards,
      new Request(`https://w.puter.work/scim/v2/${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
  const removed = await scim(`Groups/${team.id}`, "PATCH", {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "remove", path: `members[value eq "${editor.uuid}"]` }],
  });
  assert.equal(removed.status, 200);
  assert.equal(await opens(boards, editor, room), false);
  // Other instances of the worker learn of a change from the
  // organization's access stamp, which it renews.
  const before = env.data.get("org:access");
  await scim(`Groups/${team.id}`, "PATCH", {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [
      { op: "add", path: "members", value: [{ value: editor.uuid }] },
    ],
  });
  assert.notEqual(env.data.get("org:access"), before);
  assert.equal(await opens(boards, editor, room), true);
  // Becoming a guest ends it too.
  await call(owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    role: "guest",
  });
  assert.equal(await opens(boards, editor, room), false);
});

test("a group change naming many people renews the organization's access stamp once", async () => {
  const { boards, org, call, team } = await setup();
  const people = Array.from({ length: 300 }, (_, n) => {
    const uuid = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
    return { uuid, role: "member", status: "active", teams: [] };
  });
  for (const person of people) await org.saveUser(person);
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "IdP",
    scopes: ["scim"],
  });
  const set = org.kv.set,
    stamps = [];
  org.kv.set = (key, ...rest) => {
    if (key === "org:access") stamps.push(key);
    return set.call(org.kv, key, ...rest);
  };
  try {
    const response = await restRoute(
      org,
      boards,
      new Request(`https://w.puter.work/scim/v2/Groups/${team.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${key}` },
      }),
      "PATCH",
      `Groups/${team.id}`,
      {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          {
            op: "add",
            path: "members",
            value: people.map((p) => ({ value: p.uuid })),
          },
        ],
      },
    );
    assert.equal(response.status, 200);
  } finally {
    org.kv.set = set;
  }
  assert.equal(stamps.length, 1);
  assert.ok((await org.user(people[299].uuid)).teams.includes(team.id));
});

test("refiling the board, or taking its team's role away, ends team access; a new role applies to those already in", async () => {
  const { boards, org, call, team, other } = await setup();
  const room = await create(boards, owner, { team: team.id });
  await settings(boards, room, { teamRole: "editor" });
  await join(boards, editor, room);
  // A new role applies to people already on the board through the team.
  await settings(boards, room, { teamRole: "viewer" });
  assert.equal(
    (await org.kv.get(`wb:${room}:member:${editor.uuid}`)).role,
    "viewer",
  );
  assert.equal(await org.kv.get(`org:ub:${editor.uuid}:${room}`), "viewer");
  await assert.rejects(
    boards.call(editor, {
      op: "commit",
      room,
      id: "x",
      update: encode(new Uint8Array()),
    }),
    { status: 403 },
  );
  // Filed under another team, the board gives that team the role instead.
  await settings(boards, room, { team: other.id });
  assert.equal(await opens(boards, editor, room), false);
  assert.equal(await org.kv.get(`org:ub:${editor.uuid}:${room}`), null);
  assert.equal((await join(boards, carol, room)).role, "viewer");
  // A role for the team of "none" ends it.
  await settings(boards, room, { teamRole: "none" });
  assert.equal(await opens(boards, carol, room), false);
  // Taking the board out of every team clears its team's role, and a role
  // needs a team to give it.
  await settings(boards, room, { teamRole: "commenter" });
  const cleared = await settings(boards, room, { team: null });
  assert.equal(cleared.settings.teamRole, "none");
  assert.equal((await org.kv.get(`wb:${room}:meta`)).teamRole, null);
  await assert.rejects(settings(boards, room, { teamRole: "editor" }), {
    status: 400,
  });
  await assert.rejects(
    settings(boards, room, { team: team.id, teamRole: "owner" }),
    { status: 400 },
  );
  // People invited by name keep their own access whatever the team.
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "editor",
  });
  await boards.call(viewer, { op: "join", room, token: invite.token });
  await call(owner, { op: "teams.update", id: team.id, add: [viewer.uuid] });
  await settings(boards, room, { team: team.id, teamRole: "viewer" });
  await call(owner, {
    op: "teams.update",
    id: team.id,
    remove: [viewer.uuid],
  });
  assert.equal(await opens(boards, viewer, room), true);
  assert.equal(
    (await org.kv.get(`wb:${room}:member:${viewer.uuid}`)).role,
    "editor",
  );
});

test("when the organization, a link and the team all admit someone, the highest role does", async () => {
  const { boards, call, team } = await setup();
  await call(owner, {
    op: "org.policy.set",
    policy: { externalSharing: "anyone", publicLinks: true },
  });
  const room = await create(boards, owner, { team: team.id });
  await settings(boards, room, {
    visibility: "organization",
    orgRole: "viewer",
    teamRole: "editor",
  });
  let member = await join(boards, editor, room);
  assert.deepEqual([member.role, member.via], ["editor", "team"]);
  // People not on the team come in through the organization.
  member = await join(boards, carol, room);
  assert.deepEqual([member.role, member.via], ["viewer", "organization"]);
  // Someone who came through the organization takes the team's higher
  // role once they are on it.
  const second = await create(boards, owner, { team: team.id });
  await settings(boards, second, {
    visibility: "link",
    linkRole: "viewer",
  });
  member = await join(boards, editor, second);
  assert.deepEqual([member.role, member.via], ["viewer", "link"]);
  await settings(boards, second, { teamRole: "commenter" });
  member = await join(boards, editor, second);
  assert.deepEqual([member.role, member.via], ["commenter", "team"]);
  // A higher role through the board's visibility wins over the team's.
  const third = await create(boards, owner, { team: team.id });
  await settings(boards, third, {
    visibility: "organization",
    orgRole: "editor",
    teamRole: "viewer",
  });
  member = await join(boards, editor, third);
  assert.deepEqual([member.role, member.via], ["editor", "organization"]);
});

test("only members of the organization who manage the board choose its team's role", async () => {
  const { boards, call, team } = await setup();
  const room = await create(boards, owner, { team: team.id });
  await call(owner, {
    op: "org.policy.set",
    policy: { externalSharing: "anyone" },
  });
  const invite = await boards.call(owner, {
    op: "invite",
    room,
    role: "facilitator",
    guest: true,
  });
  await boards.call(guest, { op: "join", room, token: invite.token });
  await assert.rejects(settings(boards, room, { teamRole: "editor" }, guest), {
    status: 403,
    message:
      "Only members of the organization can change who can open this board.",
  });
  // Saving what is already set is not refused.
  await settings(boards, room, { teamRole: "none" }, guest);
});

test("the directory shows people the boards their team can open, and the REST API sets and reports the team's role", async () => {
  const { boards, org, call, team } = await setup();
  const room = await create(boards, owner, { team: team.id });
  const listed = async (user, input = {}) => {
    // Each request has its own service, which checks access afresh.
    boards.access = new Map();
    return (
      await call(user, { op: "org.boards", scope: "organization", ...input })
    ).boards.map((b) => b.room);
  };
  assert.deepEqual(await listed(editor), []);
  const { key } = await call(owner, {
    op: "apikeys.create",
    name: "Automation",
    scopes: ["boards:read", "boards:write"],
  });
  const rest = (method, path, body) =>
    restRoute(
      org,
      boards,
      new Request("https://w.puter.work/v1/" + path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path,
      body,
    );
  await assert.rejects(rest("PATCH", "boards/" + room, { teamRole: "all" }), {
    status: 400,
  });
  const patched = await (
    await rest("PATCH", "boards/" + room, { teamRole: "commenter" })
  ).json();
  assert.equal(patched.board.teamRole, "commenter");
  const read = await (await rest("GET", "boards/" + room)).json();
  assert.equal(read.board.teamRole, "commenter");
  const all = await (await rest("GET", "boards")).json();
  assert.equal(all.boards.find((b) => b.room === room).teamRole, "commenter");
  // Unfiled boards give no team a role.
  const unfiled = await create(boards);
  await assert.rejects(
    rest("PATCH", "boards/" + unfiled, { teamRole: "editor" }),
    { status: 400 },
  );
  // A team member finds it before opening it, by name or by what it holds;
  // others do not.
  assert.deepEqual(await listed(editor), [room]);
  assert.deepEqual(await listed(editor, { query: "roadmap", content: true }), [
    room,
  ]);
  assert.deepEqual(await listed(carol), []);
  assert.deepEqual(await listed(guest), []);
  await join(boards, editor, room);
  // Once they leave the team, it is no longer listed for them, though the
  // role it gave them is still in their own list.
  await call(owner, { op: "teams.update", id: team.id, remove: [editor.uuid] });
  assert.equal(await org.kv.get(`org:ub:${editor.uuid}:${room}`), "commenter");
  assert.deepEqual(await listed(editor), []);
  assert.deepEqual(await listed(editor, { scope: "mine" }), []);
  // Nor is a board in the trash.
  await call(owner, { op: "teams.update", id: team.id, add: [editor.uuid] });
  assert.deepEqual(await listed(editor), [room]);
  await boards.call(owner, { op: "delete", room });
  assert.equal(await org.kv.get(`org:teamboard:${team.id}:${room}`), null);
});

test("joining through a team and changing a team's role are audited", async () => {
  const { boards, org, call, team, other } = await setup();
  const room = await create(boards, owner, { team: team.id });
  await settings(boards, room, { teamRole: "editor" });
  await join(boards, editor, room);
  await settings(boards, room, { team: other.id });
  await settings(boards, room, { team: null });
  await org.flush();
  const { entries } = await call(owner, { op: "org.audit" });
  const roles = entries
    .filter((e) => e.action === "board.share.role")
    .map((e) => e.details);
  assert.deepEqual(
    roles.sort((a, b) => a.from.localeCompare(b.from)),
    [
      { setting: "team", from: "editor", to: "none", team: null },
      { setting: "team", from: "none", to: "editor", team: team.id },
    ],
  );
  const joined = entries.find(
    (e) => e.action === "board.joined" && e.actor?.uuid === editor.uuid,
  );
  assert.deepEqual(joined.details, { role: "editor", via: "team" });
});

test("board settings offer a role for the team's members once the board has a team", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    url: "https://whiteboard.test",
  });
  const keys = ["document", "localStorage", "NodeFilter", "HTMLElement"];
  for (const key of keys) globalThis[key] = dom.window[key];
  try {
    const { createBoardAccess } =
      await import("../src/organization/board-access.js");
    const { setLanguage } = await import("../src/i18n.js");
    const sent = [];
    const s = {
      role: "owner",
      server: "https://whiteboard-abc.puter.work",
      settings: {
        visibility: "private",
        orgRole: "editor",
        linkRole: "viewer",
        teamRole: "none",
        team: null,
      },
      request: async (op, input) => {
        if (op === "settings") {
          sent.push(input);
          const next = { ...s.settings, ...input };
          // As the server does, a board without a team gives none a role.
          if (!next.team) next.teamRole = "none";
          return { settings: next };
        }
        return op === "members"
          ? { members: [] }
          : op === "settings.get"
            ? { settings: s.settings }
            : {};
      },
    };
    let d;
    const access = createBoardAccess({
      org: {
        server: s.server,
        isMember: true,
        info: { configured: true },
        policy: () => null,
        allows: () => false,
        request: async (op) =>
          op === "spaces.list"
            ? { spaces: [] }
            : { teams: [{ id: "t1", name: "Design" }] },
      },
      session: () => s,
      board: () => ({ items: [] }),
      modal: (title, html, ready) => {
        d = document.createElement("dialog");
        d.innerHTML = html;
        document.body.append(d);
        ready(d);
        return d;
      },
      toast() {},
      icon: () => "",
    });
    await access.settings();
    const role = d.querySelector("#bs-team-role"),
      team = d.querySelector("#bs-team");
    const save = async () => {
      d.querySelector("#board-settings").dispatchEvent(
        new dom.window.Event("submit", { cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 20));
    };
    // Labelled, explained, and unavailable until a team is chosen.
    assert.equal(
      role.closest("label").firstChild.textContent,
      "Role for team members",
    );
    assert.equal(
      [...role.options].map((o) => o.textContent).join(", "),
      "No access, Can edit, Can comment, Can view",
    );
    assert.ok(
      d.querySelector("#" + role.getAttribute("aria-describedby")).textContent,
    );
    assert.equal(role.disabled, true);
    team.value = "t1";
    team.dispatchEvent(new dom.window.Event("change"));
    assert.equal(role.disabled, false);
    role.value = "commenter";
    await save();
    assert.deepEqual(sent, [{ team: "t1", teamRole: "commenter" }]);
    // Saving something else does not send it again.
    d.querySelector("#bs-link-role").value = "commenter";
    await save();
    assert.deepEqual(sent.at(-1), { linkRole: "commenter" });
    // Taking the board out of its team takes the role away with it.
    team.value = "";
    team.dispatchEvent(new dom.window.Event("change"));
    assert.equal(role.disabled, true);
    assert.equal(role.value, "none");
    await save();
    assert.deepEqual(sent.at(-1), { team: null, teamRole: "none" });
    // In Canadian French.
    d.remove();
    setLanguage("fr");
    try {
      await access.settings();
      assert.equal(
        d.querySelector("#bs-team-role").closest("label").firstChild
          .textContent,
        "Rôle des membres de l’équipe",
      );
      assert.equal(
        d.querySelector('#bs-team-role option[value="none"]').textContent,
        "Aucun accès",
      );
    } finally {
      setLanguage("en");
    }
  } finally {
    for (const key of keys) delete globalThis[key];
    dom.window.close();
  }
});
