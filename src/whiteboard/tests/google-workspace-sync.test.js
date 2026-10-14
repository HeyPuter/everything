import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MessageChannel, Worker } from "node:worker_threads";
import { adminCall } from "../worker/admin.js";
import { restRoute } from "../worker/api.js";
import { environment, owner } from "./collaboration-helpers.js";

// The Google Workspace sync script runs in Apps Script, whose services are
// synchronous. Here it runs in a worker thread with Google's services
// stubbed, and its requests wait for the organization's SCIM API answering
// in this thread.
const SCRIPT = await readFile(
  new URL("../docs/google-workspace/whiteboard-sync.gs", import.meta.url),
  "utf8",
);
const RUNNER = `
const { workerData, receiveMessageOnPort } = require("node:worker_threads");
const vm = require("node:vm");
const { port, shared, script, directory, properties } = workerData;
const flag = new Int32Array(shared);
const ask = (message) => {
  Atomics.store(flag, 0, 0);
  port.postMessage(message);
  Atomics.wait(flag, 0, 0);
  return receiveMessageOnPort(port).message;
};
const answer = (r) => ({
  getResponseCode: () => r.status,
  getContentText: () => r.text,
});
const page = (list, token, size) => {
  const from = Number(token || 0);
  const rest = list.slice(from, from + size);
  return { rest, next: from + size < list.length ? String(from + size) : undefined };
};
const logs = [];
const context = vm.createContext({
  Logger: { log: (m) => logs.push(String(m)) },
  LockService: {
    getScriptLock: () => ({ tryLock: () => !directory.locked, releaseLock() {} }),
  },
  PropertiesService: {
    getScriptProperties: () => ({ getProperties: () => properties }),
  },
  UrlFetchApp: {
    fetch: (url, params) => answer(ask([{ url, ...params }])[0]),
    fetchAll: (requests) => ask(requests).map(answer),
  },
  AdminDirectory: {
    Users: {
      list: (o) => {
        const unit = /orgUnitPath='([^']*)'/.exec(o.query || "")?.[1];
        const users = directory.users.filter(
          (u) => !unit || u.orgUnitPath === unit || u.orgUnitPath.startsWith(unit + "/"),
        );
        const { rest, next } = page(users, o.pageToken, 2);
        return { users: rest, nextPageToken: next };
      },
    },
    Groups: { get: (address) => directory.groups[address] },
    Members: {
      list: (address, o) => {
        const { rest, next } = page(directory.groups[address].members, o.pageToken, 2);
        return { members: rest, nextPageToken: next };
      },
    },
  },
});
vm.runInContext(script, context);
const summary = context.syncWhiteboard();
port.postMessage({ done: true, summary: JSON.parse(JSON.stringify(summary)), logs });
`;

async function setup() {
  const env = environment();
  const boards = env.service,
    org = boards.org;
  await adminCall(org, boards, owner, { op: "org.setup", name: "Fabrikam" });
  const { key } = await adminCall(org, boards, owner, {
    op: "apikeys.create",
    name: "Google Workspace",
    scopes: ["scim"],
  });
  const scim = async (path) =>
    (
      await restRoute(
        org,
        boards,
        new Request("https://w.puter.work/scim/v2/" + path, {
          headers: { Authorization: `Bearer ${key}` },
        }),
        "GET",
        path.split("?")[0],
        null,
      )
    ).json();
  const requests = [];
  const sync = (directory, extra = {}) =>
    new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      const shared = new SharedArrayBuffer(4);
      const flag = new Int32Array(shared);
      port1.on("message", async (message) => {
        if (message.done) {
          port1.close();
          return resolve(message);
        }
        const answers = [];
        for (const r of message) {
          requests.push(`${r.method.toUpperCase()} ${new URL(r.url).pathname}`);
          const url = new URL(r.url);
          const method = r.method.toUpperCase();
          try {
            const response = await restRoute(
              org,
              boards,
              new Request(url, { method, headers: r.headers }),
              method,
              url.pathname.replace(/^\/scim\/v2\/?/, ""),
              r.payload ? JSON.parse(r.payload) : null,
            );
            answers.push({
              status: response.status,
              text: response.status === 204 ? "" : await response.text(),
            });
          } catch (error) {
            answers.push({
              status: error.status || 500,
              text: JSON.stringify({ detail: error.message }),
            });
          }
        }
        port1.postMessage(answers);
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
      });
      const worker = new Worker(RUNNER, {
        eval: true,
        workerData: {
          port: port2,
          shared,
          script: SCRIPT,
          directory,
          properties: {
            WHITEBOARD_URL: "https://w.puter.work/",
            WHITEBOARD_SCIM_KEY: key,
            GUEST_ORG_UNITS: "/Contractors",
            GROUPS: "design@fabrikam.test",
            ...extra,
          },
        },
        transferList: [port2],
      });
      worker.on("error", reject);
    });
  return { org, boards, scim, sync, requests };
}

const NONE = {
  created: 0,
  updated: 0,
  deactivated: 0,
  removed: 0,
  teams: 0,
  conflicts: 0,
  failed: 0,
};
const person = (id, email, orgUnitPath = "/Staff", extra = {}) => ({
  id,
  primaryEmail: email,
  name: { givenName: email.split("@")[0], familyName: "Example" },
  orgUnitPath,
  suspended: false,
  ...extra,
});

test("the Google Workspace sync provisions people, guests, and teams, and keeps them in step", async () => {
  const { scim, sync, requests } = await setup();
  const directory = {
    users: [
      person("1", "ann@fabrikam.test"),
      person("2", "bob@fabrikam.test"),
      person("3", "cam@fabrikam.test", "/Contractors/East"),
      person("4", "dee@fabrikam.test", "/Staff", { suspended: true }),
    ],
    groups: {
      "design@fabrikam.test": {
        id: "g1",
        name: "Design",
        members: [
          { type: "USER", email: "ann@fabrikam.test" },
          { type: "USER", email: "Cam@fabrikam.test" },
          { type: "GROUP", email: "sub@fabrikam.test" },
        ],
      },
    },
  };
  const first = await sync(directory);
  assert.deepEqual(first.summary, {
    ...NONE,
    created: 3,
    teams: 1,
  });
  const users = async () =>
    Object.fromEntries(
      (await scim("Users")).Resources.map((u) => [
        u.userName,
        `${u.active ? "active" : "inactive"} ${u.roles[0].value} ${u.externalId}`,
      ]),
    );
  assert.deepEqual(await users(), {
    "ann@fabrikam.test": "active member google:1",
    "bob@fabrikam.test": "active member google:2",
    "cam@fabrikam.test": "active guest google:3",
  });
  const team = async () => {
    const [g] = (await scim("Groups")).Resources;
    const names = new Map(
      (await scim("Users")).Resources.map((u) => [u.id, u.userName]),
    );
    return [g.displayName, g.members.map((m) => names.get(m.value)).sort()];
  };
  assert.deepEqual(await team(), [
    "Design",
    ["ann@fabrikam.test", "cam@fabrikam.test"],
  ]);
  // A second run with nothing changed changes nothing.
  const writes = () => requests.filter((r) => !r.startsWith("GET")).length;
  const before = writes();
  const quiet = await sync(directory);
  assert.deepEqual(quiet.summary, NONE);
  assert.equal(writes(), before);
  // Google renames Ann, suspends Bob, makes Cam staff, removes Dee, adds
  // Eve, and changes the group.
  directory.users = [
    person("1", "ann.lee@fabrikam.test", "/Staff", {
      name: { givenName: "Ann", familyName: "Lee" },
    }),
    person("2", "bob@fabrikam.test", "/Staff", { suspended: true }),
    person("3", "cam@fabrikam.test"),
    person("5", "eve@fabrikam.test"),
  ];
  directory.groups["design@fabrikam.test"].members = [
    { type: "USER", email: "ann.lee@fabrikam.test" },
    { type: "USER", email: "eve@fabrikam.test" },
  ];
  const changed = await sync(directory);
  assert.deepEqual(changed.summary, {
    ...NONE,
    created: 1,
    updated: 2,
    deactivated: 1,
    teams: 1,
  });
  assert.deepEqual(await users(), {
    "ann.lee@fabrikam.test": "active member google:1",
    "bob@fabrikam.test": "inactive member google:2",
    "cam@fabrikam.test": "active member google:3",
    "eve@fabrikam.test": "active member google:5",
  });
  assert.deepEqual(await team(), [
    "Design",
    ["ann.lee@fabrikam.test", "eve@fabrikam.test"],
  ]);
  // Someone who leaves the directory is removed, which ends their access;
  // a dry run changes nothing and logs what it would do.
  directory.users = directory.users.filter((u) => u.id !== "3");
  const dry = await sync(directory, { DRY_RUN: "true" });
  assert.equal(dry.summary.removed, 1);
  assert.ok(dry.logs.some((l) => /^DELETE .*\/Users\//.test(l)));
  assert.match((await users())["cam@fabrikam.test"], /^active/);
  const removed = await sync(directory);
  assert.equal(removed.summary.removed, 1);
  assert.equal((await users())["cam@fabrikam.test"], undefined);
});

test("the Google Workspace sync leaves people it did not provision alone and keeps administrators' role", async () => {
  const { org, boards, scim, sync } = await setup();
  // Provisioned by another tool, not in the directory.
  await restRoute(
    org,
    boards,
    new Request("https://w.puter.work/scim/v2/Users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(await adminCall(org, boards, owner, { op: "apikeys.create", name: "Other", scopes: ["scim"] })).key}`,
      },
    }),
    "POST",
    "Users",
    { userName: "contractor@partner.test" },
  );
  const result = await sync(
    {
      users: [person("1", "ann@fabrikam.test")],
      groups: {},
    },
    { GROUPS: "" },
  );
  assert.equal(result.summary.deactivated, 0);
  const listed = (await scim("Users")).Resources.map((u) => [
    u.userName,
    u.active,
  ]);
  assert.deepEqual(listed.sort(), [
    ["ann@fabrikam.test", true],
    ["contractor@partner.test", true],
  ]);
  // An administrator the account owner appointed stays one.
  const ann = (await scim("Users")).Resources.find(
    (u) => u.userName === "ann@fabrikam.test",
  );
  await org.updateUser(ann.id, { role: "admin" }, { access: true });
  const again = await sync(
    { users: [person("1", "ann@fabrikam.test")], groups: {} },
    { GROUPS: "" },
  );
  assert.deepEqual(again.summary, NONE);
  assert.equal((await org.freshUser(ann.id)).role, "admin");
});

async function verifyEmail(org, boards, identity, email) {
  const sent = [];
  org.puter.email = {
    async sendTransactional(message) {
      sent.push(message);
      return { failed: [] };
    },
  };
  await adminCall(org, boards, identity, { op: "email.start", email });
  const code = /code is (\d{6})/.exec(sent.at(-1).text)[1];
  return adminCall(org, boards, identity, { op: "email.confirm", code });
}
const bob = { uuid: "77777777-7777-4777-8777-777777777777", username: "bob" };
const noGroups = { GROUPS: "" };

test("an address Google gives to someone new never brings back its former owner's account", async () => {
  const { org, boards, sync } = await setup();
  const directory = { users: [person("2", "bob@fabrikam.test")], groups: {} };
  await sync(directory, noGroups);
  await verifyEmail(org, boards, bob, "bob@fabrikam.test");
  assert.equal(await org.active(bob), true);
  directory.users = [person("8", "ann@fabrikam.test")];
  assert.equal((await sync(directory, noGroups)).summary.removed, 1);
  assert.equal(await org.active(bob), false);
  // The address goes to a new hire, another Google user.
  directory.users.push(person("9", "bob@fabrikam.test"));
  const hired = await sync(directory, noGroups);
  assert.equal(hired.summary.created, 1);
  assert.equal(await org.active(bob), false);
  const newcomer = {
    uuid: "88888888-8888-4888-8888-888888888888",
    username: "robert",
  };
  await verifyEmail(org, boards, newcomer, "bob@fabrikam.test");
  assert.equal(await org.role(newcomer), "member");
  assert.equal(await org.active(bob), false);
});

test("a suspension goes through even when Google renames the person to an address Whiteboard refuses", async () => {
  const { org, scim, sync } = await setup();
  await sync(
    {
      users: [
        person("1", "ann@fabrikam.test"),
        person("2", "kim@fabrikam.test"),
      ],
      groups: {},
    },
    noGroups,
  );
  // Kim's address belongs to someone provisioned another way meanwhile;
  // Google moves Ann to it and suspends her.
  const kim = (await scim("Users")).Resources.find(
    (u) => u.userName === "kim@fabrikam.test",
  );
  await org.updateUser(kim.id, { externalId: "other-tool:5" });
  const result = await sync(
    {
      users: [
        person("1", "kim@fabrikam.test", "/Staff", { suspended: true }),
        person("3", "lee@fabrikam.test"),
      ],
      groups: {},
    },
    noGroups,
  );
  assert.equal(result.summary.deactivated, 1);
  assert.equal(result.summary.failed, 1);
  const ann = (await scim("Users")).Resources.find(
    (u) => u.externalId === "google:1",
  );
  assert.equal(ann.active, false);
  assert.equal(ann.userName, "ann@fabrikam.test");
});

test("the Google Workspace sync stops rather than remove everyone when the directory answers with no one or few", async () => {
  const { scim, sync } = await setup();
  const users = Array.from({ length: 30 }, (_, n) =>
    person(String(n), `p${n}@fabrikam.test`),
  );
  await sync({ users, groups: {} }, noGroups);
  await assert.rejects(
    sync(
      { users, groups: {} },
      { ...noGroups, USER_QUERY: "orgUnitPath='/Nobody'" },
    ),
    /listed no users/,
  );
  // Twenty of thirty gone at once is held until confirmed.
  const held = await sync({ users: users.slice(0, 10), groups: {} }, noGroups);
  assert.equal(held.summary.removed, 0);
  assert.equal(held.summary.conflicts, 20);
  assert.equal((await scim("Users")).totalResults, 30);
  const confirmed = await sync(
    { users: users.slice(0, 10), groups: {} },
    { ...noGroups, ALLOW_LARGE_REMOVALS: "true" },
  );
  assert.equal(confirmed.summary.removed, 20);
  assert.equal((await scim("Users")).totalResults, 10);
});

test("the Google Workspace sync leaves another tool's person with the same address alone, counts group members once, and does not run twice at once", async () => {
  const { org, scim, sync, requests } = await setup();
  await sync(
    { users: [person("1", "ann@fabrikam.test")], groups: {} },
    noGroups,
  );
  const ann = (await scim("Users")).Resources[0];
  await org.updateUser(ann.id, { externalId: "okta:42" });
  const conflict = await sync(
    { users: [person("1", "ann@fabrikam.test", "/Contractors")], groups: {} },
    noGroups,
  );
  assert.equal(conflict.summary.conflicts, 1);
  const kept = await scim(`Users/${ann.id}`);
  assert.equal(kept.externalId, "okta:42");
  assert.equal(kept.roles[0].value, "member");
  // A person in a group twice, directly and through a nested group.
  const directory = {
    users: [person("2", "bo@fabrikam.test")],
    groups: {
      "design@fabrikam.test": {
        id: "g1",
        name: "Design",
        members: [
          { type: "USER", email: "bo@fabrikam.test" },
          { type: "USER", email: "bo@fabrikam.test" },
        ],
      },
    },
  };
  await sync(directory, { ALLOW_LARGE_REMOVALS: "true" });
  const writes = () => requests.filter((r) => !r.startsWith("GET")).length;
  const before = writes();
  await sync(directory);
  assert.equal(writes(), before);
  directory.locked = true;
  const skipped = await sync(directory);
  assert.equal(skipped.summary, null);
  assert.ok(skipped.logs.some((l) => /Another sync is running/.test(l)));
});
