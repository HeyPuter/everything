import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { adminCall } from "../worker/admin.js";
import { restRoute } from "../worker/api.js";
import { environment, owner, editor, viewer } from "./collaboration-helpers.js";

const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

async function setup() {
  const env = environment();
  const boards = env.service;
  const org = boards.org;
  await adminCall(org, boards, owner, { op: "org.setup", name: "SCIM" });
  const { key } = await adminCall(org, boards, owner, {
    op: "apikeys.create",
    name: "IdP",
    scopes: ["scim"],
  });
  const request = (path, method = "GET", body) =>
    restRoute(
      org,
      boards,
      new Request(`https://w.puter.work/scim/v2/${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      }),
      method,
      path.split("?")[0],
      body,
    );
  const scim = async (...args) => (await request(...args)).json();
  return { env, org, boards, key, request, scim };
}

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

test("SCIM rejects malformed patches without changing users or groups", async () => {
  const { env, scim, request } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    members: [{ value: user.id }],
  });
  for (const [path, first] of [
    [
      `Users/${user.id}`,
      { op: "replace", path: "displayName", value: "Changed" },
    ],
    [
      `Groups/${group.id}`,
      { op: "replace", path: "displayName", value: "Changed" },
    ],
  ]) {
    const before = await scim(path);
    for (const body of [
      { Operations: [first] },
      { schemas: PATCH, Operations: [first] },
      { schemas: [PATCH], Operations: [] },
      {
        schemas: [PATCH],
        Operations: [
          first,
          { op: "delete", path: "displayName", value: "Bad" },
        ],
      },
      {
        schemas: [PATCH],
        Operations: [first, { op: "remove", value: { displayName: "Bad" } }],
      },
      {
        schemas: [PATCH],
        Operations: [first, { op: "replace", path: 3, value: "Bad" }],
      },
      {
        schemas: [PATCH],
        Operations: [first, { op: "replace", path: "displayName" }],
      },
      { schemas: [PATCH], Operations: [first, { op: "replace", value: [] }] },
    ]) {
      const audits = [...env.data.keys()].filter((k) =>
        k.startsWith("org:audit:"),
      ).length;
      await assert.rejects(request(path, "PATCH", body), { status: 400 });
      assert.equal(
        [...env.data.keys()].filter((k) => k.startsWith("org:audit:")).length,
        audits,
      );
      // The verification GET is itself audited; the refused PATCH is not.
      assert.deepEqual(await scim(path), before);
    }
    const changed = await scim(path, "PATCH", {
      schemas: [PATCH],
      Operations: [{ ...first, op: "RePlAcE" }],
    });
    assert.equal(changed.displayName, "Changed");
  }
});

test("invalid SCIM active values never deactivate an account", async () => {
  const { org, scim, request } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const record = await org.freshUser(user.id);
  await org.saveUser({ ...record, status: "active" });
  const path = `Users/${user.id}`;
  const before = await scim(path);
  for (const active of [null, 0, 1, [], {}, "yes", "flase", ""]) {
    for (const [method, body] of [
      ["PUT", { active }],
      [
        "PATCH",
        {
          schemas: [PATCH],
          Operations: [{ op: "replace", path: "active", value: active }],
        },
      ],
      ["POST", { userName: "new@example.ca", active }],
    ]) {
      await assert.rejects(
        request(method === "POST" ? "Users" : path, method, body),
        {
          status: 400,
          scimType: "invalidValue",
        },
      );
      assert.deepEqual(await scim(path), before);
      assert.equal(
        (await scim('Users?filter=userName eq "new@example.ca"')).totalResults,
        0,
      );
    }
  }
  for (const active of [false, "FALSE", true, "TRUE"]) {
    const changed = await scim(path, "PATCH", {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "active", value: active }],
    });
    assert.equal(changed.active, active === true || active === "TRUE");
  }
});

test("SCIM group pagination resolves members only on the requested page", async () => {
  const { org, scim } = await setup();
  for (let n = 0; n < 30; n++) {
    await org.saveUser({
      uuid: `user-${n}`,
      scimId: `scim-${n}`,
      status: "active",
      teams: [],
    });
    await org.kv.set(`org:team:team-${String(n).padStart(2, "0")}`, {
      id: `team-${n}`,
      name: `Team ${n}`,
      members: [`user-${n}`],
    });
  }
  const read = org.user.bind(org);
  let reads = [];
  org.user = async (uuid) => {
    reads.push(uuid);
    return read(uuid);
  };
  const page = await scim("Groups?startIndex=12&count=1");
  assert.equal(page.totalResults, 30);
  assert.equal(page.startIndex, 12);
  assert.equal(page.itemsPerPage, 1);
  assert.deepEqual(page.Resources[0].members, [{ value: "scim-11" }]);
  assert.deepEqual(reads, ["user-11"]);
  for (const query of [
    "count=0",
    "startIndex=100",
    "count=1&excludedAttributes=members",
  ]) {
    reads = [];
    await scim(`Groups?${query}`);
    assert.deepEqual(reads, []);
  }
});

test("unsupported SCIM filters are rejected even when no rows match", async () => {
  const { scim, request } = await setup();
  for (const resource of ["Users", "Groups"]) {
    await assert.rejects(
      request(`${resource}?filter=${encodeURIComponent('unknown eq "x"')}`),
      {
        status: 400,
        scimType: "invalidFilter",
      },
    );
    if (resource === "Users")
      await scim(resource, "POST", { userName: "pat@example.ca" });
    else await scim(resource, "POST", { displayName: "Design" });
    const absent =
      resource === "Users"
        ? 'userName eq "absent@example.ca"'
        : 'displayName eq "absent"';
    for (const filter of [
      `${absent} and unknown eq "x"`,
      `id eq "absent" and unknown eq "x"`,
    ])
      await assert.rejects(
        request(`${resource}?filter=${encodeURIComponent(filter)}`),
        {
          status: 400,
          scimType: "invalidFilter",
        },
      );
    assert.equal(
      (await scim(`${resource}?filter=${encodeURIComponent(absent)}`))
        .totalResults,
      0,
    );
  }
});

test("malformed SCIM group members return a client error and preserve membership", async () => {
  const { scim, request } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    members: [{ value: user.id }],
  });
  const path = `Groups/${group.id}`;
  for (const members of [
    "bad",
    {},
    [null],
    [3],
    ["bad"],
    [{}],
    [{ value: {} }],
  ]) {
    for (const [target, method, body] of [
      ["Groups", "POST", { displayName: "Bad", members }],
      [path, "PUT", { displayName: "Changed", members }],
      [
        path,
        "PATCH",
        {
          schemas: [PATCH],
          Operations: [{ op: "replace", path: "members", value: members }],
        },
      ],
    ]) {
      await assert.rejects(request(target, method, body), {
        status: 400,
        scimType: "invalidValue",
      });
      assert.deepEqual(await scim(path), group);
      assert.equal((await scim("Groups")).totalResults, 1);
    }
  }
  const cleared = await scim(path, "PUT", {
    displayName: "Design",
    members: null,
  });
  assert.deepEqual(cleared.members, []);
});

test("SCIM rejects unsupported route suffixes and endpoint methods", async () => {
  const { scim, request } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const group = await scim("Groups", "POST", { displayName: "Design" });
  for (const [resource, record] of [
    ["Users", user],
    ["Groups", group],
  ]) {
    const path = `${resource}/${record.id}`;
    await assert.rejects(request(`${path}/members`, "DELETE"), { status: 404 });
    assert.deepEqual(await scim(path), record);
    for (const method of ["PUT", "PATCH", "DELETE"])
      await assert.rejects(request(resource, method, {}), { status: 405 });
    await assert.rejects(request(path, "POST", {}), { status: 405 });
  }
  for (const resource of [
    "ServiceProviderConfig",
    "ResourceTypes",
    "Schemas",
  ]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      await assert.rejects(request(resource, method, {}), { status: 405 });
    await assert.rejects(request(`${resource}/unknown/extra`), { status: 404 });
    assert.equal((await request(resource)).status, 200);
  }
  await assert.rejects(request("ServiceProviderConfig/unknown"), {
    status: 404,
  });
});

test("removing a SCIM user's name clears its subattributes", async () => {
  const { scim } = await setup();
  const user = await scim("Users", "POST", {
    userName: "pat@example.ca",
    name: { givenName: "Pat", familyName: "Smith" },
  });
  for (const path of [
    "name",
    "urn:ietf:params:scim:schemas:core:2.0:User:name",
  ]) {
    await scim(`Users/${user.id}`, "PATCH", {
      schemas: [PATCH],
      Operations: [
        {
          op: "replace",
          path: "name",
          value: { givenName: "Pat", familyName: "Smith" },
        },
      ],
    });
    const changed = await scim(`Users/${user.id}`, "PATCH", {
      schemas: [PATCH],
      Operations: [{ op: "remove", path }],
    });
    assert.equal(changed.name.givenName, "");
    assert.equal(changed.name.familyName, "");
    assert.equal(changed.userName, user.userName);
    assert.equal(changed.active, true);
    const read = await scim(`Users/${user.id}`);
    assert.deepEqual(read, changed);
  }
});

test("the shipped SCIM worker applies mutations safely and returns SCIM errors", async () => {
  const { env, key } = await setup();
  const routes = new Map();
  vm.runInNewContext(
    await readFile(
      new URL("../public/worker/whiteboard-worker.js", import.meta.url),
      "utf8",
    ),
    {
      router: {
        get: (path, handler) => routes.set(`GET ${path}`, handler),
        post: (path, handler) => routes.set(`POST ${path}`, handler),
        custom: (method, path, handler) =>
          routes.set(`${method} ${path}`, handler),
      },
      me: { puter: env.sdk(owner) },
      Response,
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
    },
  );
  const send = (path, method = "GET", body) =>
    routes.get(`${method} /scim/v2/*path`)({
      request: new Request(`https://w.puter.work/scim/v2/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/scim+json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      params: { path: path.split("?")[0] },
    });
  const created = await send("Users", "POST", {
    userName: "pat@example.ca",
    name: { givenName: "Pat", familyName: "Smith" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("content-type"), "application/scim+json");
  const user = await created.json();
  const path = `Users/${user.id}`;
  const selected = await send(`${path}?attributes=userName`);
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), {
    schemas: user.schemas,
    id: user.id,
    userName: "pat@example.ca",
  });
  const removed = await send(path, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "remove", path: "name" }],
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).name.givenName, "");
  for (const [target, method, body, status, type] of [
    [`${path}/members`, "DELETE", undefined, 404, undefined],
    [path, "PUT", { active: null }, 400, "invalidValue"],
    [path, "PATCH", { schemas: [PATCH], Operations: [] }, 400, "invalidSyntax"],
    [
      `${path}?attributes=id&excludedAttributes=displayName`,
      "GET",
      undefined,
      400,
      "invalidSyntax",
    ],
    [
      "Groups",
      "POST",
      { displayName: "Bad", members: [null] },
      400,
      "invalidValue",
    ],
    [
      "Users?filter=unknown%20eq%20%22x%22",
      "GET",
      undefined,
      400,
      "invalidFilter",
    ],
  ]) {
    const result = await send(target, method, body);
    assert.equal(result.status, status);
    assert.equal(result.headers.get("content-type"), "application/scim+json");
    const error = await result.json();
    assert.deepEqual(error.schemas, [
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
    assert.equal(error.status, String(status));
    assert.equal(error.scimType, type);
    assert.equal((await (await send(path)).json()).active, true);
  }
  await send(path, "PUT", { active: false, roles: "guest" });
  const injected = await send(path, "PATCH", {
    schemas: [PATCH],
    Operations: [
      {
        op: "replace",
        value: JSON.parse('{"__proto__":{"active":true,"roles":"member"}}'),
      },
    ],
  });
  assert.equal(injected.status, 200);
  const protectedUser = await injected.json();
  assert.equal(protectedUser.active, false);
  assert.equal(protectedUser.roles[0].value, "guest");
});

test("non-object SCIM replacement bodies cannot clear group membership", async () => {
  const { scim, request } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    members: [{ value: user.id }],
  });
  for (const [resource, record] of [
    ["Groups", group],
    ["Users", user],
  ]) {
    const path = `${resource}/${record.id}`;
    const before = await scim(path);
    for (const body of [null, undefined, [], "bad", "", 3, false]) {
      await assert.rejects(request(path, "PUT", body), {
        status: 400,
        scimType: "invalidSyntax",
      });
      assert.deepEqual(await scim(path), before);
    }
  }
});

test("SCIM equality filters decode JSON string escapes", async () => {
  const { scim, request } = await setup();
  const externalId = 'id-\n\t"\\é';
  for (const [resource, body] of [
    ["Users", { userName: "pat@example.ca", externalId }],
    ["Groups", { displayName: "Design", externalId }],
  ]) {
    const created = await scim(resource, "POST", body);
    const literal = JSON.stringify(externalId).replace("é", "\\u00e9");
    const found = await scim(
      `${resource}?filter=${encodeURIComponent(`externalId eq ${literal}`)}`,
    );
    assert.equal(found.totalResults, 1);
    assert.equal(found.Resources[0].id, created.id);
    for (const literal of [
      String.raw`"bad\q"`,
      '"raw\nline"',
      String.raw`"bad\uZZZZ"`,
    ])
      await assert.rejects(
        request(
          `${resource}?filter=${encodeURIComponent(`externalId eq ${literal}`)}`,
        ),
        {
          status: 400,
          scimType: "invalidFilter",
        },
      );
  }
  const user = await scim(
    `Users?filter=${encodeURIComponent(String.raw`userName eq "p\u0061t@example.ca"`)}`,
  );
  assert.equal(user.totalResults, 1);
});

test("SCIM group creation stores each member once", async () => {
  const { org, scim } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const members = [{ value: user.id }, { value: user.id }, { value: user.id }];
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    members,
  });
  assert.deepEqual(group.members, [{ value: user.id }]);
  assert.deepEqual((await org.kv.get(`org:team:${group.id}`)).members, [
    user.id,
  ]);
  assert.deepEqual((await scim(`Users/${user.id}`)).groups, [
    { value: group.id },
  ]);
  assert.deepEqual((await scim(`Groups/${group.id}`)).members, [
    { value: user.id },
  ]);
  const replaced = await scim(`Groups/${group.id}`, "PUT", {
    displayName: "Design",
    members,
  });
  assert.deepEqual(replaced.members, [{ value: user.id }]);
});

test("SCIM filters accept attributes qualified by their resource schema", async () => {
  const { org, scim, request } = await setup();
  const user = await scim("Users", "POST", {
    userName: "pat@example.ca",
    externalId: "id-user",
  });
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    externalId: "id-group",
    members: [{ value: user.id }],
  });
  for (const [resource, schema, attributes, created] of [
    [
      "Users",
      "urn:ietf:params:scim:schemas:core:2.0:User",
      [
        ["userName", "pat@example.ca"],
        ["emails.value", "pat@example.ca"],
        ["id", user.id],
        ["externalId", "id-user"],
      ],
      user,
    ],
    [
      "Groups",
      "urn:ietf:params:scim:schemas:core:2.0:Group",
      [
        ["displayName", "Design"],
        ["id", group.id],
        ["members.value", user.id],
      ],
      group,
    ],
  ]) {
    for (const [attr, value] of attributes) {
      const filter = `${schema}:${attr} eq ${JSON.stringify(value)}`;
      const found = await scim(
        `${resource}?filter=${encodeURIComponent(filter)}`,
      );
      assert.equal(found.totalResults, 1);
      assert.equal(found.Resources[0].id, created.id);
    }
    await assert.rejects(
      request(
        `${resource}?filter=${encodeURIComponent(`urn:example:other:2.0:User:id eq "x"`)}`,
      ),
      {
        status: 400,
        scimType: "invalidFilter",
      },
    );
  }
  const list = org.list.bind(org);
  org.list = async (pattern, ...args) => {
    assert.notEqual(
      pattern,
      "org:user:",
      "qualified email lookups must retain their index",
    );
    return list(pattern, ...args);
  };
  assert.equal(
    (
      await scim(
        `Users?filter=${encodeURIComponent('URN:IETF:PARAMS:SCIM:SCHEMAS:CORE:2.0:USER:USERNAME eq "PAT@EXAMPLE.CA"')}`,
      )
    ).totalResults,
    1,
  );
});

test("unrelated SCIM patch paths cannot promote a guest through roles", async () => {
  const { scim } = await setup();
  const user = await scim("Users", "POST", {
    userName: "pat@example.ca",
    roles: "guest",
  });
  const path = `Users/${user.id}`;
  for (const target of [
    "rolesExtra",
    "roles.invalid",
    "roles.primary",
    'roles[value eq "guest"]suffix',
  ]) {
    for (const op of ["remove", "replace", "add"]) {
      const result = await scim(path, "PATCH", {
        schemas: [PATCH],
        Operations: [
          { op, path: target, ...(op === "remove" ? {} : { value: "member" }) },
        ],
      });
      assert.equal(result.roles[0].value, "guest");
      assert.equal(
        result["urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User"]
          .license,
        "guest",
      );
      assert.equal((await scim(path)).roles[0].value, "guest");
    }
  }
  const changed = await scim(path, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: "roles.value", value: "member" }],
  });
  assert.equal(changed.roles[0].value, "member");
});

test("prototype-named SCIM attributes cannot inject access changes", async () => {
  const { scim } = await setup();
  const user = await scim("Users", "POST", {
    userName: "pat@example.ca",
    roles: "guest",
    active: false,
  });
  const path = `Users/${user.id}`;
  const value = JSON.parse(
    '{"__proto__":{"active":true,"roles":[{"value":"member"}],"displayName":"Injected"},"name.givenName":"Pat"}',
  );
  const changed = await scim(path, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", value }],
  });
  assert.equal(changed.active, false);
  assert.equal(changed.roles[0].value, "guest");
  assert.equal(changed.displayName, user.displayName);
  assert.equal(changed.name.givenName, "Pat");
  const read = await scim(path);
  assert.deepEqual(read, changed);
  assert.equal({}.active, undefined);
});

test("SCIM displayName filters match the default shown in user resources", async () => {
  const { scim } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  assert.equal(user.displayName, user.userName);
  const find = async (displayName) =>
    scim(
      `Users?filter=${encodeURIComponent(`displayName eq ${JSON.stringify(displayName)}`)}`,
    );
  assert.equal((await find(user.displayName)).Resources[0]?.id, user.id);
  const named = await scim(`Users/${user.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: "displayName", value: "Pat Smith" }],
  });
  assert.equal(
    (await find(named.displayName.toUpperCase())).Resources[0]?.id,
    user.id,
  );
  assert.equal((await find(user.userName)).totalResults, 0);
  const reset = await scim(`Users/${user.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "remove", path: "displayName" }],
  });
  assert.equal((await find(reset.displayName)).Resources[0]?.id, user.id);
});

test("linking an inactive SCIM identity revokes existing live sessions", async () => {
  const { org, boards, scim } = await setup();
  await org.saveUser({
    ...editor,
    role: "member",
    status: "active",
    teams: [],
  });
  const pending = await scim("Users", "POST", {
    userName: "pat@example.ca",
    active: false,
  });
  const revoked = [];
  boards.fetcher = async (url, options) => {
    if (options.method === "DELETE")
      revoked.push(String(url).split("/").at(-1));
    return new Response("{}", { status: 200 });
  };
  for (const room of ["room-a", "room-b"]) {
    await org.kv.set(`org:uh:${editor.uuid}:${room}`, true);
    await org.kv.set(`wb:${room}:handle:${editor.uuid}`, `handle-${room}`);
    await org.kv.set(`wb:${room}:presence:session`, { user: editor.uuid });
  }
  const linked = await verifyEmail(org, boards, editor, pending.userName);
  assert.equal(linked.info.user.status, "deactivated");
  assert.equal((await scim(`Users/${pending.id}`)).active, false);
  for (const room of ["room-a", "room-b"]) {
    assert.equal(await org.kv.get(`wb:${room}:handle:${editor.uuid}`), null);
    assert.equal(await org.kv.get(`org:uh:${editor.uuid}:${room}`), null);
    assert.equal(await org.kv.get(`wb:${room}:presence:session`), null);
  }
  assert.deepEqual(revoked.sort(), ["handle-room-a", "handle-room-b"]);
});

test("linking an inactive SCIM identity keeps the account owner active", async () => {
  const { org, boards, scim } = await setup();
  const pending = await scim("Users", "POST", {
    userName: "alice@example.ca",
    active: false,
    roles: "guest",
  });
  let revoked = 0;
  boards.revokeSessions = async () => {
    revoked++;
  };
  const linked = await verifyEmail(org, boards, owner, pending.userName);
  assert.equal(linked.info.role, "owner");
  assert.equal(linked.info.user.status, "active");
  assert.equal((await org.freshUser(owner.uuid)).role, "owner");
  assert.equal((await org.freshUser(owner.uuid)).license, "full");
  assert.equal(revoked, 0);
  const found = await scim(`Users/${pending.id}`);
  assert.equal(found.active, true);
  assert.equal(found.roles[0].value, "owner");
  assert.equal(
    found["urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User"].license,
    "full",
  );
});

test("SCIM member removal paths parse whitespace and escaped identifiers", async () => {
  const { org, scim, request } = await setup();
  const ann = await scim("Users", "POST", { userName: "ann@example.ca" });
  const ben = await scim("Users", "POST", { userName: "ben@example.ca" });
  const members = [{ value: ann.id }, { value: ben.id }];
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    members,
  });
  const path = `Groups/${group.id}`;
  for (const target of [
    `members[value  eq   "${ann.id}"]`,
    `MEMBERS[ VALUE EQ "${ann.id}" ]`,
    `urn:ietf:params:scim:schemas:core:2.0:Group:members[value eq "\\u0070${ann.id.slice(1)}"]`,
  ]) {
    await scim(path, "PATCH", {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: "members", value: members }],
    });
    const removed = await scim(path, "PATCH", {
      schemas: [PATCH],
      Operations: [{ op: "remove", path: target }],
    });
    assert.deepEqual(removed.members, [{ value: ben.id }]);
    assert.deepEqual((await org.freshUser(ann.id)).teams, []);
    assert.deepEqual((await org.freshUser(ben.id)).teams, [group.id]);
  }
  const before = await scim(path);
  await assert.rejects(
    request(path, "PATCH", {
      schemas: [PATCH],
      Operations: [
        { op: "replace", path: "displayName", value: "Changed" },
        { op: "remove", path: String.raw`members[value eq "bad\q"]` },
      ],
    }),
    { status: 400, scimType: "invalidPath" },
  );
  assert.deepEqual(await scim(path), before);
});

test("large SCIM groups read only their members in bounded batches", async () => {
  const { org, scim } = await setup();
  const count = 1001;
  for (let n = 0; n < 1400; n++)
    await org.kv.set(`org:user:person-${n}`, {
      uuid: `person-${n}`,
      scimId: `remote-${n}`,
      status: "active",
      role: "member",
      teams: [],
    });
  await org.kv.set("org:team:large", {
    id: "large",
    name: "Large",
    members: Array.from({ length: count }, (_, n) => `person-${n}`),
  });
  const list = org.list.bind(org);
  org.list = async (pattern, ...args) => {
    assert.notEqual(
      pattern,
      "org:user:",
      "group reads must not scan unrelated people",
    );
    return list(pattern, ...args);
  };
  const get = org.kv.get.bind(org.kv);
  const batches = [];
  org.kv.get = async (key) => {
    const people = [key].flat().filter((k) => k.startsWith("org:user:"));
    if (people.length) batches.push(people);
    return get(key);
  };
  const group = await scim("Groups/large");
  assert.deepEqual(
    group.members,
    Array.from({ length: count }, (_, n) => ({ value: `remote-${n}` })),
  );
  assert.equal(batches.length, 2, "1,001 cold members need two reads");
  assert.ok(batches.every((b) => b.length <= 1000));
  assert.deepEqual(
    new Set(batches.flat()),
    new Set(Array.from({ length: count }, (_, n) => `org:user:person-${n}`)),
  );
  await org.kv.set("org:team:medium", {
    id: "medium",
    name: "Medium",
    members: Array.from({ length: 201 }, (_, n) => `person-${n}`),
  });
  for (let n = 0; n < 201; n++) org.forgetUser(`person-${n}`);
  batches.length = 0;
  assert.equal((await scim("Groups/medium")).members.length, 201);
  assert.equal(batches.length, 1, "201 cold members need one read");
  await org.saveUser({
    ...(await org.freshUser("person-5")),
    scimId: "linked-5",
  });
  assert.equal((await scim("Groups/large")).members[5].value, "linked-5");
  batches.length = 0;
  const excluded = await scim("Groups/large?excludedAttributes=members");
  assert.equal(Object.hasOwn(excluded, "members"), false);
  assert.deepEqual(batches, []);
});

test("SCIM group operations resolve repeated identifiers once per request", async () => {
  const { org, scim } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const reads = [];
  const get = org.kv.get.bind(org.kv);
  org.kv.get = async (key) => {
    reads.push(...[key].flat().filter((k) => k.startsWith("org:scimid:")));
    return get(key);
  };
  const members = Array.from({ length: 100 }, () => ({ value: user.id }));
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    members,
  });
  assert.deepEqual(group.members, [{ value: user.id }]);
  assert.deepEqual(reads, [`org:scimid:${user.id}`]);
  reads.length = 0;
  const changed = await scim(`Groups/${group.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [
      { op: "remove", path: "members", value: members },
      { op: "add", path: "members", value: members },
    ],
  });
  assert.deepEqual(changed.members, [{ value: user.id }]);
  assert.deepEqual(reads, [`org:scimid:${user.id}`]);
});

test("SCIM role values are case insensitive on creation and updates", async () => {
  const { scim } = await setup();
  const extension =
    "urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User";
  const guest = await scim("Users", "POST", {
    userName: "guest@example.ca",
    roles: [{ value: "GUEST", primary: true }],
  });
  assert.equal(guest.roles[0].value, "guest");
  assert.equal(guest[extension].license, "guest");
  const member = await scim("Users", "POST", {
    userName: "member@example.ca",
  });
  const changed = await scim(`Users/${member.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: `${extension}:role`, value: "GuEsT" }],
  });
  assert.equal(changed.roles[0].value, "guest");
  const removed = await scim(`Users/${member.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "remove", path: 'roles[value eq "GUEST"]' }],
  });
  assert.equal(removed.roles[0].value, "member");
  const replaced = await scim(`Users/${member.id}`, "PUT", {
    userName: "member@example.ca",
    roles: "GUEST",
  });
  assert.equal(replaced.roles[0].value, "guest");
  const protectedRole = await scim(`Users/${member.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: "roles", value: "ADMIN" }],
  });
  assert.equal(protectedRole.roles[0].value, "guest");
});

test("SCIM resource and patch attributes accept mixed casing", async () => {
  const { scim } = await setup();
  const extension =
    "urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User";
  const user = await scim("Users", "POST", {
    USERNAME: "pat@example.ca",
    DISPLAYNAME: "Pat",
    NAME: { GIVENNAME: "Pat", FAMILYNAME: "Smith" },
    ACTIVE: false,
    EXTERNALID: "idp-pat",
    ROLES: [{ VALUE: "guest", PRIMARY: true }],
  });
  assert.equal(user.active, false);
  assert.equal(user.displayName, "Pat");
  assert.equal(user.name.givenName, "Pat");
  assert.equal(user.name.familyName, "Smith");
  assert.equal(user.externalId, "idp-pat");
  assert.equal(user.roles[0].value, "guest");
  const changed = await scim(`Users/${user.id}`, "PATCH", {
    SCHEMAS: [PATCH],
    OPERATIONS: [
      { OP: "replace", PATH: "NAME", VALUE: { GIVENNAME: "Patricia" } },
      { OP: "replace", VALUE: { ACTIVE: true, DISPLAYNAME: "Patricia" } },
      {
        OP: "replace",
        PATH: extension.toUpperCase(),
        VALUE: { ROLE: "member" },
      },
    ],
  });
  assert.equal(changed.active, true);
  assert.equal(changed.name.givenName, "Patricia");
  assert.equal(changed.roles[0].value, "member");
  const replaced = await scim(`Users/${user.id}`, "PUT", {
    USERNAME: "pat@example.ca",
    [extension.toUpperCase()]: { ROLE: "guest" },
  });
  assert.equal(replaced.roles[0].value, "guest");
  const group = await scim("Groups", "POST", {
    DISPLAYNAME: "Design",
    MEMBERS: [{ VALUE: user.id }],
  });
  assert.equal(group.displayName, "Design");
  assert.deepEqual(group.members, [{ value: user.id }]);
  const cleared = await scim(`Groups/${group.id}`, "PATCH", {
    SCHEMAS: [PATCH],
    OPERATIONS: [
      { OP: "remove", PATH: "members", VALUE: [{ VALUE: user.id }] },
    ],
  });
  assert.deepEqual(cleared.members, []);
  const groupReplaced = await scim(`Groups/${group.id}`, "PUT", {
    DISPLAYNAME: "New Design",
    MEMBERS: [{ VALUE: user.id }],
  });
  assert.deepEqual(groupReplaced.members, [{ value: user.id }]);
});

test("SCIM attribute normalization rejects aliases atomically and preserves path validation", async () => {
  const { request, scim } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const path = `Users/${user.id}`;
  const before = await scim(path);
  for (const body of [
    { active: false, ACTIVE: true },
    { name: { givenName: "Pat", GIVENNAME: "Other" } },
  ]) {
    await assert.rejects(request(path, "PUT", body), {
      status: 400,
      scimType: "invalidSyntax",
    });
    assert.deepEqual(await scim(path), before);
  }
  await assert.rejects(
    request(path, "PATCH", {
      schemas: [PATCH],
      Operations: [
        { op: "replace", path: "active", value: false },
        {
          op: "replace",
          path: "name",
          value: { givenName: "Pat", GIVENNAME: "Other" },
        },
      ],
    }),
    { status: 400, scimType: "invalidSyntax" },
  );
  assert.deepEqual(await scim(path), before);
  await assert.rejects(
    request(path, "PATCH", {
      schemas: [PATCH],
      Operations: [{ op: "replace", path: { toString: false }, value: "Pat" }],
    }),
    { status: 400, scimType: "invalidPath" },
  );
});

test("SCIM role value-filter paths decode JSON escapes and reject invalid strings", async () => {
  const { scim, request } = await setup();
  const user = await scim("Users", "POST", {
    userName: "pat@example.ca",
    roles: "guest",
  });
  const path = `Users/${user.id}`;
  const changed = await scim(path, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "remove", path: 'roles[ VALUE EQ "g\\u0075est" ]' }],
  });
  assert.equal(changed.roles[0].value, "member");
  const before = await scim(path);
  await assert.rejects(
    request(path, "PATCH", {
      schemas: [PATCH],
      Operations: [
        { op: "replace", path: "active", value: false },
        { op: "remove", path: 'roles[value eq "m\\qember"]' },
      ],
    }),
    { status: 400, scimType: "invalidPath" },
  );
  assert.deepEqual(await scim(path), before);
});

test("SCIM role replacement only changes a matching value-filter target", async () => {
  const { scim, request } = await setup();
  const user = await scim("Users", "POST", {
    userName: "pat@example.ca",
    roles: "guest",
  });
  const path = `Users/${user.id}`;
  const before = await scim(path);
  await assert.rejects(
    request(path, "PATCH", {
      schemas: [PATCH],
      Operations: [
        { op: "replace", path: "displayName", value: "Changed" },
        {
          op: "replace",
          path: 'roles[value eq "member"].value',
          value: "member",
        },
      ],
    }),
    { status: 400, scimType: "noTarget" },
  );
  assert.deepEqual(await scim(path), before);
  const changed = await scim(path, "PATCH", {
    schemas: [PATCH],
    Operations: [
      { op: "replace", path: 'roles[value eq "GUEST"].value', value: "member" },
    ],
  });
  assert.equal(changed.roles[0].value, "member");
});

test("linking a new SCIM identity clears the previous identity's deletion marker", async () => {
  const { org, boards, scim, request } = await setup();
  const first = await scim("Users", "POST", { userName: "pat@example.ca" });
  await verifyEmail(org, boards, editor, "pat@example.ca");
  await request(`Users/${first.id}`, "DELETE");
  assert.equal((await org.freshUser(editor.uuid)).scimDeleted, true);
  const next = await scim("Users", "POST", { userName: "pat.work@example.ca" });
  assert.notEqual(next.id, first.id);
  await verifyEmail(org, boards, editor, "pat.work@example.ca");
  const linked = await scim(`Users/${next.id}`);
  assert.equal(linked.id, next.id);
  assert.equal(linked.active, false);
  assert.equal(linked.userName, "pat.work@example.ca");
  const listed = await scim("Users");
  assert.equal(listed.Resources.filter((u) => u.id === next.id).length, 1);
  await assert.rejects(request(`Users/${first.id}`), { status: 404 });
  const restored = await scim(`Users/${next.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: "active", value: true }],
  });
  assert.equal(restored.active, true);
});

test("SCIM projections include requested subattributes and always retain schemas and id", async () => {
  const { scim } = await setup();
  const core = "urn:ietf:params:scim:schemas:core:2.0:User";
  const extension =
    "urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User";
  const user = await scim("Users", "POST", {
    userName: "pat@example.ca",
    name: { givenName: "Pat", familyName: "Smith" },
  });
  const selected = await scim(`Users/${user.id}?attributes=userName`);
  assert.deepEqual(selected, {
    schemas: user.schemas,
    id: user.id,
    userName: user.userName,
  });
  const partial = await scim(
    `Users/${user.id}?attributes=${encodeURIComponent(`${core.toUpperCase()}:NAME.GIVENNAME,emails.value,${extension.toUpperCase()}:ROLE`)}`,
  );
  assert.deepEqual(partial, {
    schemas: user.schemas,
    id: user.id,
    name: { givenName: "Pat" },
    emails: [{ value: "pat@example.ca" }],
    [extension]: { role: "member" },
  });
  const excluded = await scim(
    `Users/${user.id}?excludedAttributes=${encodeURIComponent(`id,schemas,emails,name.familyName,${extension}:linked`)}`,
  );
  assert.equal(excluded.id, user.id);
  assert.deepEqual(excluded.schemas, user.schemas);
  assert.equal("emails" in excluded, false);
  assert.equal("familyName" in excluded.name, false);
  assert.equal("linked" in excluded[extension], false);
  assert.equal(excluded.name.givenName, "Pat");
  const list = await scim(
    `Users?filter=${encodeURIComponent('userName eq "pat@example.ca"')}&attributes=userName`,
  );
  assert.equal(list.totalResults, 1);
  assert.equal(list.itemsPerPage, 1);
  assert.deepEqual(list.Resources, [selected]);
});

test("SCIM group projections avoid unrequested member reads", async () => {
  const { org, scim } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const group = await scim("Groups", "POST", {
    displayName: "Design",
    members: [{ value: user.id }],
  });
  let userReads = 0;
  const get = org.kv.get.bind(org.kv);
  org.kv.get = async (key) => {
    userReads += [key].flat().filter((k) => k.startsWith("org:user:")).length;
    return get(key);
  };
  for (const path of [
    `Groups/${group.id}?attributes=displayName`,
    "Groups?attributes=displayName",
    `Groups/${group.id}?excludedAttributes=urn:ietf:params:scim:schemas:core:2.0:Group:members`,
  ]) {
    const response = await scim(path);
    const shown = response.Resources?.[0] || response;
    assert.equal("members" in shown, false);
    assert.equal(shown.displayName, "Design");
  }
  assert.equal(userReads, 0);
  const partial = await scim(
    `Groups/${group.id}?excludedAttributes=members.value`,
  );
  assert.deepEqual(partial.members, [{}]);
  assert.equal(userReads, 0);
  const included = await scim(`Groups/${group.id}?attributes=members.value`);
  assert.deepEqual(included.members, [{ value: user.id }]);
  assert.equal("displayName" in included, false);
});

test("SCIM mutation projections preserve Location and persisted resource data", async () => {
  const { request, scim } = await setup();
  for (const [resource, body] of [
    ["Users", { userName: "pat@example.ca" }],
    ["Groups", { displayName: "Design" }],
  ]) {
    const response = await request(`${resource}?attributes=id`, "POST", body);
    const created = await response.json();
    assert.equal(response.status, 201);
    assert.equal(
      response.headers.get("Location"),
      `https://w.puter.work/scim/v2/${resource}/${created.id}`,
    );
    assert.deepEqual(Object.keys(created).sort(), ["id", "schemas"]);
    const changed = await scim(
      `${resource}/${created.id}?attributes=displayName`,
      "PATCH",
      {
        schemas: [PATCH],
        Operations: [{ op: "replace", path: "displayName", value: "Changed" }],
      },
    );
    assert.deepEqual(changed, {
      schemas: created.schemas,
      id: created.id,
      displayName: "Changed",
    });
    assert.equal(
      (await scim(`${resource}/${created.id}`)).displayName,
      "Changed",
    );
    const replaced = await scim(
      `${resource}/${created.id}?attributes=displayName`,
      "PUT",
      {
        ...body,
        displayName: "Replaced",
      },
    );
    assert.deepEqual(replaced, {
      schemas: created.schemas,
      id: created.id,
      displayName: "Replaced",
    });
  }
});

test("SCIM rejects simultaneous inclusion and exclusion before mutation", async () => {
  const { request, scim } = await setup();
  const user = await scim("Users", "POST", { userName: "pat@example.ca" });
  const before = await scim(`Users/${user.id}`);
  await assert.rejects(
    request(
      `Users/${user.id}?attributes=id&excludedAttributes=displayName`,
      "PATCH",
      {
        schemas: [PATCH],
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    ),
    { status: 400, scimType: "invalidSyntax" },
  );
  assert.deepEqual(await scim(`Users/${user.id}`), before);
});

test("SCIM discovery resources honor response projection", async () => {
  const { scim } = await setup();
  for (const resource of ["ResourceTypes", "Schemas"]) {
    const listed = await scim(`${resource}?attributes=id`);
    assert.ok(listed.Resources.length > 0);
    for (const item of listed.Resources)
      assert.deepEqual(Object.keys(item).sort(), ["id", "schemas"]);
  }
  const config = await scim("ServiceProviderConfig?attributes=patch.supported");
  assert.deepEqual(config, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
  });
});

test("a guest role the identity provider set survives domain capture and member links", async () => {
  const { env, org, boards, scim } = await setup();
  await adminCall(org, boards, owner, {
    op: "org.policy.set",
    policy: { domains: ["fabrikam.test"], domainCapture: true },
  });
  const { token } = await adminCall(org, boards, owner, {
    op: "org.invite",
    role: "member",
    days: 30,
  });
  env.now += 1000;
  const user = await scim("Users", "POST", {
    userName: "contractor@fabrikam.test",
    roles: [{ value: "guest", primary: true }],
  });
  const verified = await verifyEmail(
    org,
    boards,
    editor,
    "contractor@fabrikam.test",
  );
  assert.equal(verified.user.role, "guest");
  env.now += 1000;
  const joined = await adminCall(org, boards, editor, {
    op: "org.join",
    token,
  });
  assert.equal(joined.user.role, "guest");
  assert.equal((await scim(`Users/${user.id}`)).roles[0].value, "guest");
  // The provider remains free to make them a member.
  await scim(`Users/${user.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [
      { op: "replace", path: "roles", value: [{ value: "member" }] },
    ],
  });
  assert.equal((await org.freshUser(editor.uuid)).role, "member");
});

test("an identity provider renaming a person moves their record to the new address", async () => {
  const { org, boards, scim, request } = await setup();
  const ids = [];
  // PUT, path-less PATCH, and the paths Entra ID and Okta send.
  for (const [n, change] of [
    [0, (id) => ["PUT", { userName: "a.new@example.ca", roles: ["guest"] }]],
    [
      1,
      () => [
        "PATCH",
        {
          schemas: [PATCH],
          Operations: [
            { op: "replace", value: { userName: "b.new@example.ca" } },
          ],
        },
      ],
    ],
    [
      2,
      () => [
        "PATCH",
        {
          schemas: [PATCH],
          Operations: [
            {
              op: "replace",
              path: 'emails[type eq "work"].value',
              value: "c.new@example.ca",
            },
          ],
        },
      ],
    ],
  ]) {
    const letter = "abc"[n];
    const user = await scim("Users", "POST", {
      userName: `${letter}.old@example.ca`,
      roles: ["guest"],
    });
    ids.push(user.id);
    const [method, body] = change(user.id);
    const res = await request(`Users/${user.id}`, method, body);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).userName, `${letter}.new@example.ca`);
    const found = await scim(
      `Users?filter=${encodeURIComponent(`userName eq "${letter}.new@example.ca"`)}`,
    );
    assert.equal(found.totalResults, 1);
    assert.equal(
      (
        await scim(
          `Users?filter=${encodeURIComponent(`userName eq "${letter}.old@example.ca"`)}`,
        )
      ).totalResults,
      0,
    );
  }
  // Verifying the new address links the same record, and the provider's
  // deactivation then reaches the account.
  await verifyEmail(org, boards, editor, "a.new@example.ca");
  const linked = await org.user(editor.uuid);
  assert.equal(linked.role, "guest");
  assert.equal(linked.scimManaged, true);
  await request(`Users/${ids[0]}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.equal((await org.freshUser(editor.uuid)).status, "deactivated");
  // An address someone else has is refused.
  await assert.rejects(
    request(`Users/${ids[1]}`, "PUT", { userName: "c.new@example.ca" }),
    { status: 409, scimType: "uniqueness" },
  );
});

test("concurrent SCIM group changes keep every member", async () => {
  const { scim, org } = await setup();
  const users = [];
  for (let n = 0; n < 5; n++)
    users.push(await scim("Users", "POST", { userName: `u${n}@example.ca` }));
  const group = await scim("Groups", "POST", { displayName: "Eng" });
  await Promise.all(
    users.map((u) =>
      scim(`Groups/${group.id}`, "PATCH", {
        schemas: [PATCH],
        Operations: [{ op: "add", path: "members", value: [{ value: u.id }] }],
      }),
    ),
  );
  assert.equal((await scim(`Groups/${group.id}`)).members.length, 5);
  // Removals at once leave both people out, and their records agree.
  await Promise.all(
    users.slice(0, 2).map((u) =>
      scim(`Groups/${group.id}`, "PATCH", {
        schemas: [PATCH],
        Operations: [{ op: "remove", path: `members[value eq "${u.id}"]` }],
      }),
    ),
  );
  const team = await org.kv.get("org:team:" + group.id);
  assert.equal(team.members.length, 3);
  for (const u of users) {
    const groups = (await scim(`Users/${u.id}`)).groups || [];
    assert.equal(groups.length, users.indexOf(u) < 2 ? 0 : 1, u.id);
  }
  assert.equal(await org.kv.get("org:teamclaim:" + group.id), null);
});

test("an address given up by a rename never leads back to the record that held it", async () => {
  const { org, boards, scim, request } = await setup();
  const ann = await scim("Users", "POST", {
    userName: "ann@example.ca",
    externalId: "idp-ann",
  });
  await verifyEmail(org, boards, editor, "ann@example.ca");
  await scim(`Users/${ann.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [
      { op: "replace", path: "userName", value: "ann.lee@example.ca" },
    ],
  });
  const annette = await scim("Users", "POST", {
    userName: "ann@example.ca",
    externalId: "idp-annette",
  });
  assert.notEqual(annette.id, ann.id);
  assert.equal((await scim(`Users/${ann.id}`)).userName, "ann.lee@example.ca");
  // Offboarding Ann reaches her account, not the newcomer's record.
  await scim(`Users/${ann.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.equal(await org.active(editor), false);
  assert.equal((await scim(`Users/${annette.id}`)).active, true);
  assert.equal((await request(`Users/${annette.id}`)).status, 200);
});

test("an address the provider deleted and gives to someone else stays with the deactivated account's successor", async () => {
  const { org, boards, scim, request } = await setup();
  const former = await scim("Users", "POST", {
    userName: "sales@example.ca",
    externalId: "idp-111",
  });
  await verifyEmail(org, boards, editor, "sales@example.ca");
  await request(`Users/${former.id}`, "DELETE");
  const hire = await scim("Users", "POST", {
    userName: "sales@example.ca",
    externalId: "idp-999",
  });
  assert.notEqual(hire.id, former.id);
  assert.equal(
    hire["urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User"].linked,
    false,
  );
  assert.equal(await org.active(editor), false);
  assert.equal(await org.role(editor), null);
  const newcomer = {
    uuid: "33333333-3333-4333-8333-333333333333",
    username: "newcomer",
  };
  await verifyEmail(org, boards, newcomer, "sales@example.ca");
  assert.equal(await org.role(newcomer), "member");
  assert.equal(await org.active(editor), false);
  // The same person, named by the provider's identifier, is linked again.
  const again = await setup();
  const kept = await again.scim("Users", "POST", {
    userName: "pat@example.ca",
    externalId: "idp-pat",
  });
  await verifyEmail(again.org, again.boards, editor, "pat@example.ca");
  await again.request(`Users/${kept.id}`, "DELETE");
  const rehired = await again.scim("Users", "POST", {
    userName: "pat@example.ca",
    externalId: "idp-pat",
  });
  assert.equal(
    rehired["urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User"]
      .linked,
    true,
  );
});

test("a provisioned person cannot verify an address their identity provider does not manage", async () => {
  const { org, boards, scim } = await setup();
  const bob = await scim("Users", "POST", { userName: "bob@example.ca" });
  await verifyEmail(org, boards, editor, "bob@example.ca");
  await assert.rejects(
    verifyEmail(org, boards, editor, "bob.private@example.org"),
    { status: 409, message: /identity provider manages your email/ },
  );
  const found = await scim(
    `Users?filter=${encodeURIComponent('userName eq "bob@example.ca"')}`,
  );
  assert.equal(found.totalResults, 1);
  assert.equal(found.Resources[0].id, bob.id);
  // The address the provider set can still be verified again.
  await verifyEmail(org, boards, editor, "bob@example.ca");
});

test("a SCIM change written while the console deactivates someone keeps the deactivation", async () => {
  const { org, boards, scim } = await setup();
  const pat = await scim("Users", "POST", { userName: "pat@example.ca" });
  await verifyEmail(org, boards, editor, "pat@example.ca");
  // The provider's request reads Pat's record, then the console
  // deactivates Pat before the request writes its change.
  const read = org.freshUser.bind(org);
  let resume;
  org.freshUser = async (uuid) => {
    const user = await read(uuid);
    if (uuid === editor.uuid && !resume) {
      org.freshUser = read;
      await new Promise((r) => (resume = r));
    }
    return user;
  };
  const patched = scim(`Users/${pat.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: "name.givenName", value: "Pat" }],
  });
  while (!resume) await new Promise((r) => setTimeout(r, 1));
  await adminCall(org, boards, owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "deactivated",
  });
  resume();
  await patched;
  const stored = await org.freshUser(editor.uuid);
  assert.equal(stored.status, "deactivated");
  assert.equal(stored.givenName, "Pat");
});

test("REST team changes add and remove members one at a time, and only people the organization knows", async () => {
  const { org, boards, scim } = await setup();
  const { key } = await adminCall(org, boards, owner, {
    op: "apikeys.create",
    name: "Sync",
    scopes: ["users:read", "users:write"],
  });
  const rest = async (path, method = "GET", body) => {
    const response = await restRoute(
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
    return response.json();
  };
  const pat = await scim("Users", "POST", { userName: "pat@example.ca" });
  await verifyEmail(org, boards, editor, "pat@example.ca");
  const sam = await scim("Users", "POST", { userName: "sam@example.ca" });
  await assert.rejects(
    rest("teams", "POST", { name: "Ops", members: ["nobody"] }),
    {
      status: 400,
    },
  );
  const { team } = await rest("teams", "POST", { name: "Ops", members: [] });
  // An identity provider's id names the account it was linked to.
  const added = await rest("teams/" + team.id, "PATCH", { add: [pat.id] });
  assert.deepEqual(added.team.members, [editor.uuid]);
  const both = await rest("teams/" + team.id, "PATCH", { add: [sam.id] });
  assert.deepEqual(both.team.members, [editor.uuid, sam.id]);
  const left = await rest("teams/" + team.id, "PATCH", { remove: [pat.id] });
  assert.deepEqual(left.team.members, [sam.id]);
  assert.deepEqual((await org.freshUser(editor.uuid)).teams, []);
  await assert.rejects(
    rest("teams/" + team.id, "PATCH", { add: ["not-a-user"] }),
    { status: 400 },
  );
  assert.deepEqual((await org.kv.get("org:team:" + team.id)).members, [sam.id]);
});

test("someone an administrator reactivates after the identity provider deleted them is listed to it again", async () => {
  const { org, boards, scim, request } = await setup();
  const pat = await scim("Users", "POST", { userName: "pat@example.ca" });
  await verifyEmail(org, boards, editor, "pat@example.ca");
  await request(`Users/${pat.id}`, "DELETE");
  await assert.rejects(request(`Users/${pat.id}`), { status: 404 });
  await adminCall(org, boards, owner, {
    op: "org.users.update",
    uuid: editor.uuid,
    status: "active",
  });
  assert.equal(await org.active(editor), true);
  const found = await scim(`Users/${pat.id}`);
  assert.equal(found.active, true);
  assert.equal(found.userName, "pat@example.ca");
  const listed = await scim(
    `Users?filter=${encodeURIComponent('userName eq "pat@example.ca"')}`,
  );
  assert.equal(listed.totalResults, 1);
  // Its deprovisioning reaches them again.
  await scim(`Users/${pat.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: "active", value: false }],
  });
  assert.equal(await org.active(editor), false);
});

test("an API key the account owner made can deactivate an administrator through the REST API, as through SCIM", async () => {
  const { org, boards } = await setup();
  const { token } = await adminCall(org, boards, owner, {
    op: "org.invite",
    role: "admin",
  });
  await adminCall(org, boards, editor, { op: "org.join", token });
  assert.equal(await org.role(editor), "admin");
  const users = async (creator) => {
    const { key } = await adminCall(org, boards, creator, {
      op: "apikeys.create",
      name: "Offboarding",
      scopes: ["users:write"],
    });
    return (status) =>
      restRoute(
        org,
        boards,
        new Request(`https://w.puter.work/v1/users/${editor.uuid}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${key}` },
        }),
        "PATCH",
        `users/${editor.uuid}`,
        { status },
      );
  };
  const ownerKey = await users(owner);
  assert.equal((await ownerKey("deactivated")).status, 200);
  assert.equal(await org.active(editor), false);
  assert.equal((await ownerKey("active")).status, 200);
  assert.equal(await org.active(editor), true);
  // A key an administrator made still cannot, nor can any key appoint one.
  const viewerAdmin = { uuid: viewer.uuid, username: viewer.username };
  const second = await adminCall(org, boards, owner, {
    op: "org.invite",
    role: "admin",
  });
  await adminCall(org, boards, viewerAdmin, {
    op: "org.join",
    token: second.token,
  });
  const adminKey = await users(viewerAdmin);
  await assert.rejects(adminKey("deactivated"), { status: 403 });
  assert.equal(await org.role(editor), "admin");
});

test("SCIM reads a user's address as identity providers send it", async () => {
  const { scim } = await setup();
  // The primary address, wherever it is in the list, trimmed.
  const sam = await scim("Users", "POST", {
    emails: [
      { value: "sam@gmail.com", type: "home" },
      { value: " Sam@Example.ca ", type: "work", primary: true },
    ],
  });
  assert.equal(sam.userName, "sam@example.ca");
  const trimmed = await scim("Users", "POST", { userName: " Kim@Example.ca " });
  assert.equal(trimmed.userName, "kim@example.ca");
  // Microsoft Entra ID's path-less patch names the work address by path.
  const pat = await scim("Users", "POST", { userName: "pat@example.ca" });
  const patched = await scim(`Users/${pat.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [
      {
        op: "Replace",
        value: {
          'emails[type eq "work"].value': "pat.lee@example.ca",
          "name.givenName": "Pat",
        },
      },
    ],
  });
  assert.equal(patched.userName, "pat.lee@example.ca");
  assert.equal(patched.name.givenName, "Pat");
});

test('SCIM takes a primary flag sent as the string "False" as not primary', async () => {
  const { scim } = await setup();
  const user = await scim("Users", "POST", {
    userName: "pat@example.ca",
    roles: [
      { value: "member", primary: "False" },
      { value: "guest", primary: "True" },
    ],
  });
  assert.equal(user.roles[0].value, "guest");
  const sam = await scim("Users", "POST", {
    emails: [
      { value: "sam@gmail.com", primary: "False" },
      { value: "sam@example.ca", primary: "true" },
    ],
  });
  assert.equal(sam.userName, "sam@example.ca");
});

test("SCIM endpoints the service does not offer answer 501 Not Implemented", async () => {
  const { request, scim } = await setup();
  for (const [path, method] of [
    ["Me", "GET"],
    ["Bulk", "POST"],
    [".search", "POST"],
  ])
    await assert.rejects(request(path, method, {}), { status: 501 });
  const config = await scim("ServiceProviderConfig");
  assert.equal(config.bulk.supported, false);
  await assert.rejects(request("Nothing"), { status: 404 });
});

test("people from outside who only joined a board are not listed to the identity provider, and REST users carry their SCIM id", async () => {
  const { org, boards, scim } = await setup();
  const pat = await scim("Users", "POST", { userName: "pat@example.ca" });
  // As a board admits an outside guest.
  await org.saveUser(
    {
      uuid: "55555555-5555-4555-8555-555555555555",
      username: "outsider",
      role: "guest",
      status: "active",
      license: "guest",
      created: org.now(),
      source: "board",
      teams: [],
    },
    true,
  );
  const all = await scim("Users");
  assert.deepEqual(
    all.Resources.map((u) => u.userName),
    ["pat@example.ca"],
  );
  await assert.rejects(scim("Users/55555555-5555-4555-8555-555555555555"), {
    status: 404,
  });
  const { key: reader } = await adminCall(org, boards, owner, {
    op: "apikeys.create",
    name: "Directory",
    scopes: ["users:read"],
  });
  const response = await restRoute(
    org,
    boards,
    new Request("https://w.puter.work/v1/users", {
      headers: { Authorization: `Bearer ${reader}` },
    }),
    "GET",
    "users",
    null,
  );
  const { users } = await response.json();
  assert.equal(users.find((u) => u.email === "pat@example.ca").scimId, pat.id);
  // REST still lists the guest, for administrators.
  assert.ok(users.some((u) => u.username === "outsider"));
});

test("a large group change updates its members in parallel and keeps the team's claim", async () => {
  const { org, scim } = await setup();
  const people = [];
  for (let n = 0; n < 120; n++)
    people.push(
      (await scim("Users", "POST", { userName: `p${n}@example.ca` })).id,
    );
  const group = await scim("Groups", "POST", { displayName: "Everyone" });
  const read = org.freshUser.bind(org);
  let reading = 0,
    most = 0;
  org.freshUser = async (uuid) => {
    most = Math.max(most, ++reading);
    await new Promise((r) => setTimeout(r, 1));
    try {
      return await read(uuid);
    } finally {
      reading--;
    }
  };
  const renewed = [];
  const expire = org.kv.expire.bind(org.kv);
  org.kv.expire = (key, seconds) => {
    if (key.startsWith("org:teamclaim:")) renewed.push(seconds);
    return expire(key, seconds);
  };
  await scim(`Groups/${group.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [
      { op: "add", path: "members", value: people.map((value) => ({ value })) },
    ],
  });
  org.freshUser = read;
  assert.ok(most > 1 && most <= 25, `${most}`);
  // Taken once, then renewed after each of the first four batches.
  assert.ok(renewed.length >= 5, `${renewed.length}`);
  for (const id of people)
    assert.deepEqual((await org.freshUser(id)).teams, [group.id]);
});

test("an address the identity provider deleted its user for can be renamed to", async () => {
  const { org, boards, scim, request } = await setup();
  const bob = await scim("Users", "POST", { userName: "bob@example.ca" });
  await verifyEmail(org, boards, editor, "bob@example.ca");
  await request(`Users/${bob.id}`, "DELETE");
  const ann = await scim("Users", "POST", { userName: "ann@example.ca" });
  const renamed = await scim(`Users/${ann.id}`, "PATCH", {
    schemas: [PATCH],
    Operations: [{ op: "replace", path: "userName", value: "bob@example.ca" }],
  });
  assert.equal(renamed.userName, "bob@example.ca");
  assert.equal(await org.active(editor), false);
  // Someone not deleted still keeps theirs: Ann now holds it.
  const kim = await scim("Users", "POST", { userName: "kim@example.ca" });
  await assert.rejects(
    request(`Users/${kim.id}`, "PATCH", {
      schemas: [PATCH],
      Operations: [
        { op: "replace", path: "userName", value: "bob@example.ca" },
      ],
    }),
    { status: 409 },
  );
});
