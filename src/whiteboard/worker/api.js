import { hash } from "../src/collaboration/protocol.js";
import { adminCall, apiKey, lockTeam, syncTeamMembers } from "./admin.js";
import {
  fail,
  listedBoard,
  memberChanges,
  readKept,
  validEmail,
} from "./org.js";
import { computeReports } from "./reports.js";

const CORE = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const EXT = "urn:ietf:params:scim:schemas:extension:whiteboard:2.0:User";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const SCIM_TYPE = { "Content-Type": "application/scim+json" };
const json = (body, status = 200, headers = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
// Created resources name their address in Location (RFC 7644 3.3).
const scim = (body, status = 200, location = body?.meta?.location) =>
  json(body, status, {
    ...SCIM_TYPE,
    ...(status === 201 && location ? { Location: location } : {}),
  });
// A SCIM error with the scimType RFC 7644 section 3.12 names for it.
const refuse = (status, message, scimType) => {
  throw Object.assign(Error(message), { status, scimType });
};
const truthy = (v) =>
  v === true || (typeof v === "string" && v.toLowerCase() === "true");
const bearer = (request) =>
  /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "")?.[1];
// Text that spreadsheets would evaluate as a formula gets an apostrophe
// prefix (OWASP CSV injection guidance).
const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // Semicolons split cells where Excel uses them as the list separator.
  return /[",;\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export const toCSV = (rows, columns) =>
  "﻿" +
  [
    columns.join(","),
    ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(",")),
  ].join("\r\n");

// Parse the SCIM filter forms identity providers send when matching users
// and groups: `attribute eq "value"`, optionally joined with `and`.
// Clauses are read one at a time, so "and" inside a quoted value, as in
// displayName eq "Research and Development", stays part of the value.
export function parseFilter(filter) {
  if (!filter) return [];
  const clause =
    /\s*([A-Za-z][A-Za-z0-9_.:-]*(?:\s*\[\s*type\s+eq\s+"work"\s*\])?(?:\.[A-Za-z][A-Za-z0-9_-]*)?)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*(and\s+|$)/iy;
  const out = [];
  let m;
  clause.lastIndex = 0;
  while (clause.lastIndex < filter.length && (m = clause.exec(filter))) {
    let value;
    try {
      value = JSON.parse(`"${m[2]}"`);
    } catch {
      refuse(400, "Invalid SCIM filter string.", "invalidFilter");
    }
    out.push({
      attr: m[1]
        .replace(/\[\s*type\s+eq\s+"work"\s*\]/i, "")
        .replace(/\s+/g, "")
        .toLowerCase(),
      value,
    });
    if (!m[3]) break;
  }
  if (!out.length || clause.lastIndex !== filter.length)
    refuse(400, "Unsupported SCIM filter.", "invalidFilter");
  return out;
}
function resourceFilters(filter, attributes, schema) {
  const filters = parseFilter(filter).map((f) => ({
    ...f,
    attr: unqualified(f.attr, schema),
  }));
  if (filters.some(({ attr }) => !attributes.includes(attr)))
    refuse(400, "Unsupported SCIM filter attribute.", "invalidFilter");
  return filters;
}
// One page of a SCIM list. Missing or unreadable startIndex and count
// fall back to the first page of 100, as RFC 7644 section 3.4.2.4 allows.
function listWindow(url, rows) {
  const number = (name, fallback) => {
    const raw = url.searchParams.get(name);
    const value = raw === null || raw === "" ? NaN : Math.floor(Number(raw));
    return Number.isFinite(value) ? value : fallback;
  };
  const start = Math.max(1, number("startIndex", 1));
  const count = Math.max(0, Math.min(500, number("count", 100)));
  const page = rows.slice(start - 1, start - 1 + count);
  return { start, page };
}
function listPage(url, rows, resource) {
  const { start, page } = listWindow(url, rows);
  return scim({
    schemas: [LIST],
    totalResults: rows.length,
    startIndex: start,
    itemsPerPage: page.length,
    Resources: page.map(resource),
  });
}
// Patch paths may name the core schema in full (RFC 7644 section 3.10), as
// in urn:ietf:params:scim:schemas:core:2.0:User:active.
function unqualified(path, schema) {
  const text = String(path || "");
  return text.toLowerCase().startsWith(schema.toLowerCase() + ":")
    ? text.slice(schema.length + 1)
    : text;
}
// RFC 7644 section 3.9 applies response selection to reads and mutations.
// Compile selectors once and cache each field decision, so a large member
// array does not repeatedly compare every selector for every member.
function resourceSelection(url, schema) {
  const params = url.searchParams;
  const included = params.has("attributes");
  const excluded = params.has("excludedAttributes");
  if (included && excluded)
    refuse(
      400,
      "Use attributes or excludedAttributes, not both.",
      "invalidSyntax",
    );
  if (!included && !excluded)
    return { wanted: () => true, mayInclude: () => true, project: (r) => r };
  const paths = (name) =>
    [...new Set(params.getAll(name).flatMap((s) => s.split(",")))]
      .map((raw) => {
        const path = unqualified(raw.trim(), schema).toLowerCase();
        const ext = EXT.toLowerCase();
        return path.startsWith(ext + ":")
          ? ext + "." + path.slice(ext.length + 1)
          : path;
      })
      .filter(Boolean);
  const include = paths("attributes"),
    exclude = paths("excludedAttributes");
  const matches = (path, selector) =>
    path === selector || path.startsWith(selector + ".");
  const decisions = new Map();
  const wanted = (path) => {
    if (!decisions.has(path))
      decisions.set(
        path,
        (!included || include.some((s) => matches(path, s))) &&
          !exclude.some((s) => matches(path, s)),
      );
    return decisions.get(path);
  };
  const possible = new Map();
  const mayInclude = (path) => {
    if (!possible.has(path))
      possible.set(
        path,
        !path ||
          (!exclude.some((s) => matches(path, s)) &&
            (!included ||
              include.some((s) => matches(path, s) || matches(s, path)))),
      );
    return possible.get(path);
  };
  const select = (value, path) => {
    if (!mayInclude(path)) return undefined;
    if (Array.isArray(value)) return value.map((v) => select(v, path) ?? {});
    if (!value || typeof value !== "object")
      return wanted(path) ? value : undefined;
    const entries = Object.entries(value).flatMap(([key, v]) => {
      const chosen = select(
        v,
        path ? path + "." + key.toLowerCase() : key.toLowerCase(),
      );
      return chosen === undefined ? [] : [[key, chosen]];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  return {
    wanted,
    mayInclude,
    project: (resource) => ({
      ...select(resource, ""),
      schemas: resource.schemas,
      ...(resource.id === undefined ? {} : { id: resource.id }),
    }),
  };
}
const INPUT_NAMES = new Map(
  [
    "schemas",
    "Operations",
    "op",
    "path",
    "value",
    "userName",
    "displayName",
    "externalId",
    "active",
    "name",
    "givenName",
    "familyName",
    "roles",
    "primary",
    "emails",
    "type",
    "members",
    "role",
    EXT,
  ].map((name) => [name.toLowerCase(), name]),
);
// SCIM attribute names are case insensitive (RFC 7643 section 2.1).
// Only visit the supported schema's bounded complex fields, rather than
// recursively traversing arbitrary provider-specific JSON. fromEntries
// keeps prototype-named keys as inert own properties.
function inputObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const seen = new Set();
  return Object.fromEntries(
    Object.entries(value).map(([raw, v]) => {
      const key = INPUT_NAMES.get(raw.toLowerCase()) || raw;
      if (seen.has(key))
        refuse(400, "Repeated SCIM attribute name.", "invalidSyntax");
      seen.add(key);
      return [key, v];
    }),
  );
}
const inputComplex = (value) =>
  Array.isArray(value) ? value.map(inputObject) : inputObject(value);
function inputResource(value) {
  const body = inputObject(value);
  if (body && typeof body === "object" && !Array.isArray(body))
    for (const [key, v] of Object.entries(body)) {
      const path = unqualified(key, CORE).toLowerCase();
      if (
        ["name", "roles", "emails", "members", EXT.toLowerCase()].includes(path)
      )
        body[key] = inputComplex(v);
    }
  return body;
}
function scimInput(method, value) {
  const body = inputResource(value);
  if (method === "PATCH" && Array.isArray(body?.Operations))
    body.Operations = body.Operations.map((raw) => {
      const op = inputObject(raw);
      if (op && typeof op === "object" && !Array.isArray(op)) {
        const path =
          typeof op.path === "string"
            ? unqualified(op.path, CORE).toLowerCase()
            : "";
        if (!path) op.value = inputResource(op.value);
        else if (
          ["name", "members", EXT.toLowerCase()].includes(path) ||
          /^roles(?:[.\[]|$)/.test(path)
        )
          op.value = inputComplex(op.value);
      }
      return op;
    });
  return body;
}
const userDisplayName = (u) =>
  u.displayName || u.username || u.email || u.scimId || u.uuid;
function userResource(u, base) {
  const scimId = u.scimId || u.uuid;
  const email = u.email || null;
  return {
    schemas: [CORE, EXT],
    id: scimId,
    ...(u.externalId ? { externalId: u.externalId } : {}),
    userName: email || u.username || scimId,
    displayName: userDisplayName(u),
    name: {
      givenName: u.givenName || "",
      familyName: u.familyName || "",
      formatted:
        [u.givenName, u.familyName].filter(Boolean).join(" ") ||
        u.displayName ||
        u.username ||
        "",
    },
    emails: email ? [{ value: email, type: "work", primary: true }] : [],
    active: u.status === "pending" ? u.active !== false : u.status === "active",
    groups: (u.teams || []).map((value) => ({ value })),
    roles: [{ value: u.role, primary: true }],
    [EXT]: {
      role: u.role,
      license: u.license || (u.role === "guest" ? "guest" : "full"),
      puterUsername: u.status === "pending" ? null : u.username || null,
      linked: u.status !== "pending",
    },
    meta: {
      resourceType: "User",
      created: new Date(u.created || 0).toISOString(),
      lastModified: new Date(u.modified || u.created || 0).toISOString(),
      location: `${base}/scim/v2/Users/${scimId}`,
    },
  };
}
function groupResource(t, base, scimIds = new Map(), members = true) {
  return {
    schemas: [GROUP],
    id: t.id,
    ...(t.externalId ? { externalId: t.externalId } : {}),
    displayName: t.name,
    ...(members
      ? {
          members: t.members.map((uuid) => ({
            value: scimIds.get(uuid) || uuid,
          })),
        }
      : {}),
    meta: {
      resourceType: "Group",
      created: new Date(t.created || 0).toISOString(),
      lastModified: new Date(t.modified || t.created || 0).toISOString(),
      location: `${base}/scim/v2/Groups/${t.id}`,
    },
  };
}
// Accounts deleted through SCIM stay deactivated in the organization, but
// the identity provider no longer sees them.
async function findUser(org, scimId) {
  const mapped = await org.kv.get("org:scimid:" + scimId);
  const user = await org.freshUser(mapped || scimId);
  return user && !user.scimDeleted ? user : null;
}
// Roles come as a list, but a single role, written as its value or as one
// role object, is read the same way, as a patch of the roles path is.
function roleFrom(body, fallback = "member") {
  const ext = body?.[EXT]?.role;
  const roles = [body?.roles ?? []]
    .flat()
    .map((r) => (r && typeof r === "object" ? r : { value: r }));
  const role = ext || roles.find((r) => r.primary)?.value || roles[0]?.value;
  const canonical = typeof role === "string" ? role.toLowerCase() : role;
  return ["member", "guest"].includes(canonical) ? canonical : fallback;
}
// Apply SCIM attributes to a stored user. Admin rights are never granted from
// the identity provider; the account owner appoints administrators.
function applyAttributes(user, body) {
  if (
    body.active !== undefined &&
    typeof body.active !== "boolean" &&
    !(typeof body.active === "string" && /^(true|false)$/i.test(body.active))
  )
    refuse(400, "active must be true or false.", "invalidValue");
  if (body.externalId !== undefined)
    user.externalId = String(body.externalId || "").slice(0, 200) || null;
  if (body.displayName !== undefined)
    user.displayName = String(body.displayName || "").slice(0, 200);
  if (body.name) {
    if (body.name.givenName !== undefined)
      user.givenName = String(body.name.givenName || "").slice(0, 100);
    if (body.name.familyName !== undefined)
      user.familyName = String(body.name.familyName || "").slice(0, 100);
  }
  if (body.roles !== undefined || body[EXT]?.role !== undefined) {
    if (user.role !== "admin") {
      user.role = roleFrom(body, user.role);
      user.license = user.role === "guest" ? "guest" : "full";
    }
  }
  if (body.active !== undefined) {
    const active = truthy(body.active);
    if (user.status === "pending") user.active = active;
    else user.status = active ? "active" : "deactivated";
  }
}
// The address an identity provider gives a person: their userName, or else
// their primary (or work) email. Lowercased; undefined when not given.
function scimEmail(body) {
  const emails = Array.isArray(body?.emails) ? body.emails : [];
  const email =
    emails.find((e) => e?.primary === true) ||
    emails.find((e) => e?.type === "work") ||
    emails[0];
  const value = body?.userName ?? email?.value;
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}
// Moves a person to the address their identity provider now uses, so later
// lookups by userName, verification of the new address, and deactivation
// still reach the same record.
async function renameUser(org, user, email) {
  if (email === undefined || email === user.email) return false;
  if (!validEmail(email))
    refuse(400, "userName must be the user's email address.", "invalidValue");
  const key = "org:email:" + (await hash(email));
  const holder = await org.kv.get(key);
  if (holder && holder !== user.uuid)
    refuse(409, "A user with this userName already exists.", "uniqueness");
  if (user.email) {
    const old = "org:email:" + (await hash(user.email));
    if ((await org.kv.get(old)) === user.uuid) await org.kv.del(old);
  }
  await org.kv.set(key, user.uuid);
  user.email = email;
  return true;
}
// A path-less PATCH value may name attributes by their full schema name or
// as dotted sub-attributes, as Microsoft Entra ID sends them:
// { "name.givenName": "Ann", "urn:…:core:2.0:User:active": false }.
function patchValue(value) {
  const known = new Map(
    ["displayName", "externalId", "active", "roles", "name"].map((k) => [
      k.toLowerCase(),
      k,
    ]),
  );
  // Unknown JSON keys must stay data; __proto__ must not supply inherited
  // attributes such as active or roles to applyAttributes.
  const out = Object.create(null);
  for (const [raw, v] of Object.entries(value)) {
    const key = unqualified(raw, CORE);
    const [head, sub] = key.split(".");
    const name = known.get(head.toLowerCase());
    if (!name) out[key] = v;
    else if (name === "name" && sub) {
      const field = { givenname: "givenName", familyname: "familyName" }[
        sub.toLowerCase()
      ];
      if (field) (out.name = { ...out.name })[field] = v;
    } else if (name === "name" && v && typeof v === "object")
      out.name = { ...out.name, ...v };
    else if (name !== "name") out[name] = v;
  }
  return out;
}
// Validate the entire patch before applying any operation. A malformed
// request must not turn an unknown operation into a successful change.
function patchOperations(body) {
  if (
    !Array.isArray(body?.schemas) ||
    !body.schemas.includes(PATCH) ||
    !Array.isArray(body.Operations) ||
    !body.Operations.length
  )
    refuse(400, "Send a SCIM PatchOp request.", "invalidSyntax");
  for (const op of body.Operations) {
    if (
      !op ||
      typeof op !== "object" ||
      Array.isArray(op) ||
      typeof op.op !== "string" ||
      !["add", "replace", "remove"].includes(op.op.toLowerCase())
    )
      refuse(400, "Unsupported patch operation.", "invalidSyntax");
    if (op.path !== undefined && typeof op.path !== "string")
      refuse(400, "A patch path must be a string.", "invalidPath");
    if (op.op.toLowerCase() === "remove") {
      if (!op.path)
        refuse(400, "A remove operation needs a path.", "invalidPath");
    } else {
      if (op.value === undefined)
        refuse(400, "A patch operation needs a value.", "invalidValue");
      if (
        !op.path &&
        (!op.value || typeof op.value !== "object" || Array.isArray(op.value))
      )
        refuse(
          400,
          "A patch without a path needs an object value.",
          "invalidValue",
        );
    }
  }
  return body.Operations;
}
const OWNER_FIXED = "The account owner stays active and keeps the owner role.";
async function scimUsers(org, boards, identity, method, id, body, url, base) {
  const selection = resourceSelection(url, CORE);
  // The account owner can be provisioned like anyone, so providers can
  // match them, but is always active and always the owner.
  const ownerId = (await org.accountOwner()).uuid;
  const view = (u) =>
    selection.project(
      userResource(
        u.uuid === ownerId
          ? { ...u, role: "owner", status: "active", license: "full" }
          : u,
        base,
      ),
    );
  const keepOwner = (user, status, role) => {
    if (user.uuid !== ownerId) return;
    if (user.status === "deactivated" && status !== "deactivated")
      refuse(400, OWNER_FIXED, "mutability");
    user.status = status;
    user.role = role;
  };
  // As in the admin console, only the account owner changes whether an
  // administrator is active, so only a key the owner created can.
  const ownerKey = identity.createdBy === ownerId;
  // A pending record keeps its status while SCIM turns it on and off, so
  // whether it is active counts as a change too.
  const keepAdmin = (user, status, role, active) => {
    if (
      role === "admin" &&
      !ownerKey &&
      (user.status !== status ||
        (status === "pending" &&
          (user.active !== false) !== (active !== false)))
    )
      refuse(403, "Only the account owner can change an administrator.");
    // A record provisioned inactive before its person signs in deactivates
    // an administrator it is later linked to only if the owner's key made
    // it inactive.
    if (user.status !== "pending") return;
    if (user.active !== false) delete user.inactiveByOwner;
    else if (ownerKey) user.inactiveByOwner = true;
  };
  // The same events the admin console records, so alerts, webhooks and SIEM
  // queries see a change whichever way it was made, and board guest counts
  // follow a change to or from guest.
  const recordChange = async (user, status, role) => {
    const target = {
      type: "user",
      id: user.uuid,
      name: user.username || user.email,
    };
    if (user.role !== role)
      await org.audit(identity, "user.role.changed", target, {
        from: role,
        to: user.role,
        source: "scim",
      });
    if (
      user.status !== status &&
      ["active", "deactivated"].includes(user.status)
    )
      await org.audit(
        identity,
        user.status === "deactivated" ? "user.deactivated" : "user.reactivated",
        target,
        { source: "scim" },
      );
    // Last, so a refusal while counting leaves the change recorded.
    if ((user.role === "guest") !== (role === "guest"))
      await boards.recountBoardsOf(user.uuid).catch(() => {});
  };
  if (method === "GET" && !id) {
    const filters = resourceFilters(
      url.searchParams.get("filter"),
      ["username", "emails.value", "emails", "externalid", "id", "displayname"],
      CORE,
    );
    // Providers look people up one at a time by userName or id before
    // creating them; those are read from their indexes, not by listing the
    // whole directory for each person.
    const byEmail = filters.find((f) =>
        ["username", "emails.value", "emails"].includes(f.attr),
      ),
      byId = filters.find((f) => f.attr === "id");
    let users;
    if (byEmail || byId) {
      const uuid = byEmail
        ? await org.kv.get(
            "org:email:" + (await hash(byEmail.value.toLowerCase())),
          )
        : null;
      const found = byEmail
        ? uuid && (await org.freshUser(uuid))
        : await findUser(org, byId.value);
      users = found && !found.scimDeleted ? [found] : [];
    } else {
      const ownerRecord = await org.user(ownerId);
      users = [
        ...(await org.members()),
        ...(ownerRecord ? [ownerRecord] : []),
      ].filter((u) => !u.scimDeleted);
    }
    let rows = users.filter((u) =>
      filters.every(({ attr, value }) => {
        const v = value.toLowerCase();
        if (attr === "username" || attr === "emails.value" || attr === "emails")
          return (
            (u.email || "").toLowerCase() === v ||
            (!u.email && (u.username || "").toLowerCase() === v)
          );
        if (attr === "externalid") return (u.externalId || "") === value;
        if (attr === "id") return (u.scimId || u.uuid) === value;
        if (attr === "displayname")
          return userDisplayName(u).toLowerCase() === v;
        refuse(400, "Unsupported SCIM filter attribute.", "invalidFilter");
      }),
    );
    return listPage(url, rows, view);
  }
  if (method === "POST" && !id) {
    const email = String(
      body?.userName || body?.emails?.[0]?.value || "",
    ).toLowerCase();
    if (!validEmail(email))
      refuse(400, "userName must be the user's email address.", "invalidValue");
    const emailKey = "org:email:" + (await hash(email));
    const linked = await org.kv.get(emailKey);
    let user = linked ? await org.freshUser(linked) : null;
    if (user?.scimManaged)
      refuse(409, "A user with this userName already exists.", "uniqueness");
    // An address the provider deleted may now be someone else's, as when a
    // shared or former colleague's address is given to a new hire. When the
    // provider's identifier says it is another person, the deleted account
    // keeps its deactivation and the address starts a new pending record,
    // which whoever proves the mailbox links.
    if (
      user?.scimDeleted &&
      user.externalId &&
      body?.externalId != null &&
      String(body.externalId) !== user.externalId
    )
      user = null;
    if (!user) {
      // Never derived from the address: one given up, by a rename or a
      // deletion, must not lead back to the record that held it.
      const pendingId = "pending-" + crypto.randomUUID().replaceAll("-", "");
      user = {
        uuid: pendingId,
        scimId: pendingId,
        email,
        emailVerified: false,
        role: roleFrom(body),
        status: "pending",
        active: true,
        created: org.now(),
        source: "scim",
        teams: [],
      };
    }
    const was = user.status,
      wasRole = user.role,
      wasActive = user.active;
    user.scimManaged = true;
    delete user.scimDeleted;
    user.scimId ||= user.uuid;
    user.modified = org.now();
    applyAttributes(user, body);
    keepOwner(user, was, wasRole);
    keepAdmin(user, was, wasRole, wasActive);
    if (was && was !== "pending" && user.role !== wasRole)
      user.roleChanged = user.modified;
    await org.saveUser(user);
    await org.kv.set("org:scimid:" + user.scimId, user.uuid);
    // Provisioning an existing account as inactive ends its sessions, as
    // deactivating it does.
    if (was === "active" && user.status === "deactivated")
      await boards.revokeSessions(user.uuid);
    await org.audit(
      identity,
      "scim.user.created",
      { type: "user", id: user.uuid, name: email },
      {
        linked: user.status !== "pending",
      },
    );
    await recordChange(user, was, wasRole);
    return scim(
      view(user),
      201,
      `${base}/scim/v2/Users/${user.scimId || user.uuid}`,
    );
  }
  const user = id && (await findUser(org, id));
  if (!user) fail(404, "User not found.");
  if (method === "GET") return scim(view(user));
  const before = user.status,
    role = user.role,
    active = user.active;
  if (method === "DELETE") {
    if (user.uuid === ownerId) refuse(400, OWNER_FIXED, "mutability");
    if (role === "admin" && !ownerKey)
      refuse(403, "Only the account owner can change an administrator.");
    // Groups would otherwise list a member the provider cannot read.
    for (const teamId of user.teams || []) {
      const unlock = await lockTeam(org, teamId);
      try {
        const team = await org.kv.get("org:team:" + teamId);
        if (!team?.members?.includes(user.uuid)) continue;
        team.members = team.members.filter((uuid) => uuid !== user.uuid);
        team.modified = org.now();
        await org.kv.set("org:team:" + teamId, team);
      } finally {
        await unlock();
      }
    }
    user.teams = [];
    if (user.status === "pending") {
      await org.dropUser(user.uuid);
      await org.kv.del("org:scimid:" + user.scimId);
      if (user.email) await org.kv.del("org:email:" + (await hash(user.email)));
    } else {
      user.status = "deactivated";
      user.modified = org.now();
      user.scimDeleted = true;
      delete user.scimManaged;
      await org.saveUser(user);
      await org.kv.del("org:scimid:" + user.scimId);
      await boards.revokeSessions(user.uuid);
    }
    await org.audit(identity, "scim.user.deleted", {
      type: "user",
      id: user.uuid,
      name: user.email,
    });
    await recordChange(user, before, role);
    return new Response(null, { status: 204 });
  }
  let renamed;
  if (method === "PUT") {
    applyAttributes(user, body || {});
    renamed = scimEmail(body);
  } else if (method === "PATCH") {
    for (const op of patchOperations(body)) {
      const kind = String(op?.op || "").toLowerCase();
      const path = unqualified(op.path, CORE);
      const roleFilter =
        /^roles\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\](?:\.value)?$/i.exec(
          path,
        );
      const rolePath = /^roles(?:\.value)?$/i.test(path) || !!roleFilter;
      let named;
      if (roleFilter)
        try {
          named = parseFilter(`value eq "${roleFilter[1]}"`)[0].value;
        } catch {
          refuse(400, "Invalid role filter in patch path.", "invalidPath");
        }
      if (
        kind === "replace" &&
        named !== undefined &&
        named.toLowerCase() !== (user.uuid === ownerId ? "owner" : user.role)
      )
        refuse(400, "The role filter has no matching value.", "noTarget");
      if (
        kind !== "remove" &&
        (/^userName$/i.test(path) || /^emails(\[.*\])?(\.value)?$/i.test(path))
      ) {
        // userName wins over an email changed in the same request.
        const value = /^userName$/i.test(path)
          ? scimEmail({ userName: op.value })
          : scimEmail({
              emails: [op.value]
                .flat()
                .map((e) => (e && typeof e === "object" ? e : { value: e })),
            });
        if (/^userName$/i.test(path) || renamed === undefined) renamed = value;
      } else if (!path && op.value && typeof op.value === "object") {
        applyAttributes(user, patchValue(op.value));
        const value = scimEmail(
          Object.fromEntries(
            Object.entries(op.value).map(([k, v]) => [unqualified(k, CORE), v]),
          ),
        );
        if (value !== undefined) renamed = value;
      } else if (/^name$/i.test(path) && kind === "remove")
        applyAttributes(user, { name: { givenName: "", familyName: "" } });
      else if (/^name$/i.test(path) && op.value && typeof op.value === "object")
        applyAttributes(user, patchValue({ name: op.value }));
      else if (/^active$/i.test(path))
        applyAttributes(user, { active: kind === "remove" ? false : op.value });
      else if (/^name\.givenName$/i.test(path))
        applyAttributes(user, {
          name: { givenName: kind === "remove" ? "" : op.value },
        });
      else if (/^name\.familyName$/i.test(path))
        applyAttributes(user, {
          name: { familyName: kind === "remove" ? "" : op.value },
        });
      else if (/^displayName$/i.test(path))
        applyAttributes(user, {
          displayName: kind === "remove" ? "" : op.value,
        });
      else if (/^externalId$/i.test(path))
        applyAttributes(user, {
          externalId: kind === "remove" ? "" : op.value,
        });
      else if (rolePath && kind === "remove") {
        // Removing the person's role, or every role, returns them to the
        // default member role; removing another role changes nothing.
        const removed =
          named !== undefined
            ? [named]
            : op.value === undefined
              ? null
              : [op.value].flat().map((r) => r?.value ?? r);
        if (
          !removed ||
          removed.some(
            (role) =>
              typeof role === "string" && role.toLowerCase() === user.role,
          )
        )
          applyAttributes(user, { roles: [{ value: "member" }] });
      } else if (rolePath) applyAttributes(user, { roles: op.value ?? [] });
      // Of the extension, only the role can change; the rest is read-only.
      else if (
        path.toLowerCase() === EXT.toLowerCase() ||
        path.toLowerCase() === `${EXT}:role`.toLowerCase()
      )
        applyAttributes(user, {
          [EXT]: {
            role:
              kind === "remove"
                ? "member"
                : path.toLowerCase() === EXT.toLowerCase()
                  ? op.value?.role
                  : op.value,
          },
        });
      /* Other attributes (such as title or phone numbers that identity
         providers map by default) are not kept; like POST and PUT, a patch
         ignores them rather than failing the operations it can apply. */
    }
  } else fail(405, "Method not allowed.");
  keepOwner(user, before, role);
  keepAdmin(user, before, role, active);
  const previousEmail = user.email;
  const emailChanged = await renameUser(org, user, renamed);
  user.modified = org.now();
  if (user.role !== role) user.roleChanged = user.modified;
  await org.saveUser(user);
  if (before === "active" && user.status === "deactivated")
    await boards.revokeSessions(user.uuid);
  await org.audit(
    identity,
    "scim.user.updated",
    { type: "user", id: user.uuid, name: user.email },
    {
      status: user.status,
      role: user.role,
      ...(user.role !== role && { from: role }),
      ...(emailChanged && { emailFrom: previousEmail, email: user.email }),
    },
  );
  await recordChange(user, before, role);
  return scim(view(user));
}
async function scimGroups(org, identity, method, id, body, url, base) {
  const selection = resourceSelection(url, GROUP);
  // Member reads share access-validated caches and use bounded batches;
  // the organization's unrelated people are never scanned.
  const accounts = new Map();
  const account = async (uuid) => {
    if (!accounts.has(uuid)) accounts.set(uuid, org.user(uuid));
    return accounts.get(uuid);
  };
  const known = async (teams) => {
    const uuids = new Set(teams.flatMap((t) => t.members || []));
    const missing = [...uuids].filter((u) => !accounts.has(u));
    if (missing.length > 1)
      for (let at = 0; at < missing.length; at += 1000) {
        const batch = missing.slice(at, at + 1000);
        const users = await readKept(
          org.kv,
          () => org.now(),
          batch.map((uuid) => org.kept("org:user:" + uuid)),
        );
        batch.forEach((uuid, i) => accounts.set(uuid, users[i]));
      }
    const ids = new Map();
    for (const uuid of uuids) {
      const u = await account(uuid);
      ids.set(uuid, u?.scimId || uuid);
    }
    return ids;
  };
  // Accounts deleted through SCIM cannot join groups again.
  const identifiers = new Map();
  const uuidFor = (value) => {
    if (!identifiers.has(value))
      identifiers.set(
        value,
        (async () => {
          const uuid =
            (await org.kv.get("org:scimid:" + value)) ||
            ((await account(value)) ? value : null);
          return uuid && !(await account(uuid))?.scimDeleted ? uuid : null;
        })(),
      );
    return identifiers.get(value);
  };
  // The team is saved first, then the people who joined or left it.
  const save = async (team, members) => {
    members = [...new Set(members)];
    const before = team.members || [];
    team.members = members;
    team.modified = org.now();
    await org.kv.set("org:team:" + team.id, team);
    await syncTeamMembers(org, team.id, before, members);
  };
  const resolve = async (list = []) => {
    // SCIM treats null as unassigned. Other collection shapes and members
    // without string identifiers are invalid rather than server failures.
    list ??= [];
    if (
      !Array.isArray(list) ||
      list.some(
        (m) =>
          !m ||
          typeof m !== "object" ||
          Array.isArray(m) ||
          typeof m.value !== "string" ||
          !m.value,
      )
    )
      refuse(
        400,
        "members must contain member objects with string values.",
        "invalidValue",
      );
    return (await Promise.all(list.map((m) => uuidFor(m.value)))).filter(
      Boolean,
    );
  };
  // Providers leave out members when they only need a group's identity,
  // as Entra does for each group it checks.
  const needsMembers = selection.wanted("members.value");
  const shown = (t, ids) =>
    selection.project(
      groupResource(t, base, ids, selection.mayInclude("members")),
    );
  if (method === "GET" && !id) {
    const filters = resourceFilters(
      url.searchParams.get("filter"),
      ["displayname", "externalid", "id", "members.value"],
      GROUP,
    );
    // Providers check membership with members.value, as Entra does.
    const memberOf = new Map();
    for (const { attr, value } of filters)
      if (attr === "members.value") memberOf.set(value, await uuidFor(value));
    const teams = (await org.list("org:team:"))
      .map((r) => r.value)
      .filter((t) =>
        filters.every(({ attr, value }) =>
          attr === "displayname"
            ? t.name.toLowerCase() === value.toLowerCase()
            : attr === "externalid"
              ? t.externalId === value
              : attr === "id"
                ? t.id === value
                : attr === "members.value"
                  ? t.members.includes(memberOf.get(value))
                  : refuse(
                      400,
                      "Unsupported SCIM filter attribute.",
                      "invalidFilter",
                    ),
        ),
      );
    const ids = needsMembers
      ? await known(listWindow(url, teams).page)
      : new Map();
    return listPage(url, teams, (t) => shown(t, ids));
  }
  if (method === "POST" && !id) {
    const name = String(body?.displayName || "")
      .trim()
      .slice(0, 120);
    if (!name) refuse(400, "displayName is required.", "invalidValue");
    const team = {
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      name,
      externalId: body.externalId
        ? String(body.externalId).slice(0, 200)
        : null,
      created: org.now(),
      members: [],
    };
    await save(team, await resolve(body.members));
    await org.audit(
      identity,
      "scim.group.created",
      { type: "team", id: team.id, name },
      memberChanges([], team.members),
    );
    return scim(
      shown(team, needsMembers ? await known([team]) : new Map()),
      201,
      `${base}/scim/v2/Groups/${team.id}`,
    );
  }
  // A change reads the group once it holds it, so changes at once all stand.
  const unlock = id && method !== "GET" ? await lockTeam(org, id) : null;
  try {
    const team = id && (await org.kv.get("org:team:" + id));
    if (!team) fail(404, "Group not found.");
    if (method === "GET")
      return scim(shown(team, needsMembers ? await known([team]) : new Map()));
    if (method === "DELETE") {
      const had = team.members;
      await save(team, []);
      await org.kv.del("org:team:" + team.id);
      await org.audit(
        identity,
        "scim.group.deleted",
        { type: "team", id: team.id, name: team.name },
        memberChanges(had, []),
      );
      return new Response(null, { status: 204 });
    }
    let members = [...team.members];
    const had = [...team.members];
    const externalId = (value) => String(value || "").slice(0, 200) || null;
    if (method === "PUT") {
      team.name = String(body?.displayName || team.name).slice(0, 120);
      if (body?.externalId !== undefined)
        team.externalId = externalId(body.externalId);
      members = await resolve(body?.members);
    } else if (method === "PATCH") {
      const operations = patchOperations(body);
      // One attribute change; `given` says a path named it, so an unknown
      // one is refused rather than ignored.
      const apply = async (kind, path, value, given) => {
        const filtered =
          /^members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i.exec(path);
        if (/^displayName$/i.test(path)) {
          if (kind !== "remove")
            team.name = String(value || team.name).slice(0, 120);
        } else if (/^externalId$/i.test(path))
          team.externalId = kind === "remove" ? null : externalId(value);
        else if (filtered && kind === "remove") {
          let value;
          try {
            value = parseFilter(`value eq "${filtered[1]}"`)[0].value;
          } catch {
            refuse(400, "Invalid member filter in patch path.", "invalidPath");
          }
          const uuid = await uuidFor(value);
          members = members.filter((m) => m !== uuid);
        } else if (/^members$/i.test(path)) {
          const named = Array.isArray(value) ? value : value ? [value] : [];
          const list = await resolve(named);
          if (kind === "add") members = [...new Set([...members, ...list])];
          else if (kind === "replace") members = list;
          // Only a removal that names no one empties the group; naming only
          // people the worker does not know, such as a deleted account,
          // removes nobody.
          else if (kind === "remove")
            members = named.length
              ? members.filter((m) => !list.includes(m))
              : [];
        } else if (given)
          refuse(400, `Unsupported patch path: ${path}`, "invalidPath");
      };
      for (const op of operations) {
        const kind = String(op.op || "").toLowerCase();
        const path = unqualified(op.path, GROUP);
        if (path) await apply(kind, path, op.value, true);
        // Without a path, each attribute of the value is changed in turn.
        else if (op.value && typeof op.value === "object")
          for (const [key, value] of Object.entries(op.value))
            await apply(kind, unqualified(key, GROUP), value, false);
        else
          refuse(
            400,
            "A patch without a path needs an object value.",
            "invalidValue",
          );
      }
    } else fail(405, "Method not allowed.");
    await save(team, members);
    await org.audit(
      identity,
      "scim.group.updated",
      { type: "team", id: team.id, name: team.name },
      memberChanges(had, team.members),
    );
    return scim(shown(team, needsMembers ? await known([team]) : new Map()));
  } finally {
    await unlock?.();
  }
}
const SERVICE_CONFIG = (base) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: `${base}/v1/openapi.json`,
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 500 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "API key",
      description:
        "An organization API key with the scim scope, sent as a bearer token.",
      primary: true,
    },
  ],
});
const RESOURCE_TYPES = [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: CORE,
    schemaExtensions: [{ schema: EXT, required: false }],
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: GROUP,
  },
];
// Attribute definitions as RFC 7643 section 7 describes them.
const attribute = (name, type, extra = {}) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});
const readOnly = { mutability: "readOnly" };
const SCHEMA_DEFINITIONS = [
  {
    id: CORE,
    name: "User",
    description: "A person in the organization.",
    attributes: [
      attribute("userName", "string", {
        required: true,
        uniqueness: "server",
        description: "The person's work email address.",
      }),
      attribute("name", "complex", {
        subAttributes: [
          attribute("givenName", "string"),
          attribute("familyName", "string"),
          attribute("formatted", "string", readOnly),
        ],
      }),
      attribute("displayName", "string"),
      attribute("emails", "complex", {
        multiValued: true,
        subAttributes: [
          attribute("value", "string"),
          attribute("type", "string", { canonicalValues: ["work"] }),
          attribute("primary", "boolean"),
        ],
      }),
      attribute("active", "boolean"),
      attribute("externalId", "string", { caseExact: true }),
      attribute("roles", "complex", {
        multiValued: true,
        subAttributes: [
          attribute("value", "string", {
            canonicalValues: ["member", "guest"],
          }),
          attribute("primary", "boolean"),
        ],
      }),
      attribute("groups", "complex", {
        multiValued: true,
        ...readOnly,
        subAttributes: [attribute("value", "string", readOnly)],
      }),
    ],
  },
  {
    id: GROUP,
    name: "Group",
    description: "A team in the organization.",
    attributes: [
      attribute("displayName", "string", { required: true }),
      attribute("members", "complex", {
        multiValued: true,
        subAttributes: [attribute("value", "string")],
      }),
      attribute("externalId", "string", { caseExact: true }),
    ],
  },
  {
    id: EXT,
    name: "WhiteboardUser",
    description: "Whiteboard access for a person.",
    attributes: [
      attribute("role", "string", { canonicalValues: ["member", "guest"] }),
      attribute("license", "string", readOnly),
      attribute("puterUsername", "string", readOnly),
      attribute("linked", "boolean", readOnly),
    ],
  },
];
const SCHEMAS = (base) =>
  SCHEMA_DEFINITIONS.map((schema) => ({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    ...schema,
    meta: {
      resourceType: "Schema",
      location: `${base}/scim/v2/Schemas/${schema.id}`,
    },
  }));

// A REST or SCIM request as the worker answers it: its audit records are
// written, then waiting work goes out as after an organization request.
export async function restRequest(org, boards, request, method, path, body) {
  try {
    return await restRoute(org, boards, request, method, path, body);
  } finally {
    await org.flush();
    await org.scheduledWork().catch(() => {});
    await boards?.scheduledRecounts?.();
  }
}
export async function restRoute(org, boards, request, method, path, body) {
  const url = new URL(request.url);
  const base = url.origin;
  const parts = path.split("/").filter(Boolean);
  if (url.pathname.startsWith("/scim/v2")) {
    const identity = await apiKey(org, bearer(request), "scim");
    const [resource, id] = parts;
    if (parts.length > 2 || (resource === "ServiceProviderConfig" && id))
      fail(404, "Unknown SCIM resource.");
    if (
      ["ServiceProviderConfig", "ResourceTypes", "Schemas"].includes(resource)
    ) {
      if (method !== "GET") fail(405, "Method not allowed.");
    } else if (["Users", "Groups"].includes(resource)) {
      const allowed = id ? ["GET", "PUT", "PATCH", "DELETE"] : ["GET", "POST"];
      if (!allowed.includes(method)) fail(405, "Method not allowed.");
      if (
        ["POST", "PUT", "PATCH"].includes(method) &&
        (!body || typeof body !== "object" || Array.isArray(body))
      )
        refuse(400, "Send a JSON resource object.", "invalidSyntax");
      if (["POST", "PUT", "PATCH"].includes(method))
        body = scimInput(method, body);
      if (method === "GET")
        await org.audit(
          identity,
          "api.read",
          { type: "api", name: url.pathname.slice(0, 200) },
          { scope: "scim" },
        );
    }
    if (resource === "ServiceProviderConfig")
      return scim(
        resourceSelection(
          url,
          "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
        ).project(SERVICE_CONFIG(base)),
      );
    if (resource === "ResourceTypes") {
      const { project } = resourceSelection(
        url,
        "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
      );
      if (id) {
        const type = RESOURCE_TYPES.find((r) => r.id === id);
        if (!type) fail(404, "Unknown SCIM resource type.");
        return scim(project(type));
      }
      return scim({
        schemas: [LIST],
        totalResults: RESOURCE_TYPES.length,
        startIndex: 1,
        itemsPerPage: RESOURCE_TYPES.length,
        Resources: RESOURCE_TYPES.map(project),
      });
    }
    if (resource === "Schemas") {
      const { project } = resourceSelection(
        url,
        "urn:ietf:params:scim:schemas:core:2.0:Schema",
      );
      const schemas = SCHEMAS(base);
      if (id) {
        const schema = schemas.find((s) => s.id === id);
        if (!schema) fail(404, "Unknown SCIM schema.");
        return scim(project(schema));
      }
      return scim({
        schemas: [LIST],
        totalResults: schemas.length,
        startIndex: 1,
        itemsPerPage: schemas.length,
        Resources: schemas.map(project),
      });
    }
    if (resource === "Users")
      return scimUsers(org, boards, identity, method, id, body, url, base);
    if (resource === "Groups")
      return scimGroups(org, identity, method, id, body, url, base);
    fail(404, "Unknown SCIM resource.");
  }
  if (method === "GET" && path === "openapi.json") return json(openAPI(base));
  // Only the paths the API description documents are answered, each with
  // the methods it lists, so a mistyped path is not read as its parent.
  const allowed = documentedMethods(parts);
  if (!allowed) fail(404, "Unknown API endpoint.");
  if (!allowed.has(method.toLowerCase())) fail(405, "Method not allowed.");
  // Changes made through the API record their own actions; reads of
  // organization data are recorded here, once per request.
  let recorded = false;
  const need = async (scope) => {
    const identity = await apiKey(org, bearer(request), scope);
    if (method === "GET" && !recorded) {
      recorded = true;
      await org.audit(
        identity,
        "api.read",
        { type: "api", name: url.pathname.slice(0, 200) },
        { scope },
      );
    }
    return identity;
  };
  const call = (identity, input) => adminCall(org, boards, identity, input);
  const q = Object.fromEntries(url.searchParams);
  const [resource, id, sub] = parts;
  if (resource === "audit" && method === "GET") {
    const identity = await need("audit:read");
    const result = await call(identity, {
      ...q,
      op: "org.audit",
      limit: q.limit ? Number(q.limit) : 500,
    });
    if (q.format === "ndjson")
      return new Response(
        result.entries.map((e) => JSON.stringify(e)).join("\n"),
        {
          headers: {
            "Content-Type": "application/x-ndjson",
            ...(result.cursor ? { "X-Next-Cursor": result.cursor } : {}),
          },
        },
      );
    return json(result);
  }
  if (resource === "users") {
    if (method === "GET") {
      const identity = await need("users:read");
      const { users, owner } = await call(identity, {
        op: "org.users.list",
        query: q.query,
        role: q.role,
        status: q.status,
      });
      if (id) {
        const user = users.find((u) => u.uuid === id);
        if (!user) fail(404, "User not found.");
        return json({ user });
      }
      if (q.format === "csv")
        return new Response(
          toCSV(users, [
            "uuid",
            "username",
            "email",
            "role",
            "status",
            "license",
            "created",
            "lastActive",
            "source",
          ]),
          {
            headers: { "Content-Type": "text/csv; charset=utf-8" },
          },
        );
      return json({ owner, users });
    }
    if (method === "PATCH" && id) {
      const identity = await need("users:write");
      return json(
        await call(identity, {
          op: "org.users.update",
          uuid: id,
          role: body?.role,
          status: body?.status,
        }),
      );
    }
  }
  if (resource === "teams") {
    if (method === "GET")
      return json(await call(await need("users:read"), { op: "teams.list" }));
    const identity = await need("users:write");
    if (method === "POST")
      return json(
        await call(identity, {
          op: "teams.create",
          name: body?.name,
          members: body?.members || [],
        }),
        201,
      );
    if (method === "PATCH" && id)
      return json(
        await call(identity, {
          op: "teams.update",
          id,
          name: body?.name,
          members: body?.members,
        }),
      );
    if (method === "DELETE" && id)
      return json(await call(identity, { op: "teams.delete", id }));
  }
  if (resource === "boards") {
    if (method === "GET" && id === "duplicates")
      return json(
        await call(await need("boards:read"), { op: "org.boards.duplicates" }),
      );
    if (method === "GET" && !id) {
      const identity = await need("boards:read");
      const filters = {
        ...q,
        archived: q.archived === undefined ? undefined : q.archived === "true",
        deleted: q.deleted === "true",
        guests: q.guests === "true",
      };
      return json(
        await call(identity, { ...filters, op: "org.boards", scope: "all" }),
      );
    }
    if (method === "GET" && id && sub === "activity")
      return json(
        await call(await need("audit:read"), {
          op: "org.board.activity",
          room: id,
          ...(q.cursor ? { cursor: q.cursor } : {}),
          ...(q.limit ? { limit: Number(q.limit) } : {}),
        }),
      );
    if (method === "GET" && id) {
      await need("boards:read");
      const board = await org.kv.get("org:board:" + id);
      if (!board) fail(404, "Board not found.");
      return json({
        board: listedBoard(board, org.now(), await org.policy()),
        members: await boards.members(id),
      });
    }
    if (method === "PATCH" && id) {
      const identity = await need("boards:write");
      // The changes that can be refused go first, so a refused request
      // leaves the board as it was.
      if (
        body?.visibility !== undefined &&
        !["private", "organization", "link"].includes(body.visibility)
      )
        fail(400, "Invalid visibility.");
      const [meta, policy] = await Promise.all([
        org.kv.get(`wb:${id}:meta`),
        org.policy(),
      ]);
      if (!meta) fail(404, "Board not found.");
      if (
        body?.visibility === "link" &&
        meta.visibility !== "link" &&
        (!policy.publicLinks || policy.externalSharing !== "anyone")
      )
        fail(403, "Your organization does not allow public board links.");
      const held =
        body?.legalHold !== undefined
          ? !!body.legalHold
          : !!(
              meta.legalHold || (await org.kv.get("org:board:" + id))?.legalHold
            );
      if (body?.deleted === true && (held || policy.retention.legalHold))
        fail(409, "This board is under a legal hold and cannot be deleted.");
      if (body?.owner)
        await boards.transfer(id, identity, body.owner, { admin: true });
      if (body?.visibility)
        await boards.call(identity, {
          op: "settings",
          room: id,
          visibility: body.visibility,
        });
      // Restoring from the trash also unarchives, so it goes before an
      // archive asked for in the same request, and only for a deleted board.
      if (body?.deleted === false && meta.deleted)
        await boards.call(identity, { op: "restore", room: id });
      for (const [key, op] of [
        ["archived", body?.archived ? "archive" : "unarchive"],
        ["legalHold", "hold"],
      ])
        if (body?.[key] !== undefined)
          await boards.call(identity, { op, room: id, enabled: !!body[key] });
      if (body?.deleted === true)
        await boards.call(identity, { op: "delete", room: id });
      return json({ board: await org.kv.get("org:board:" + id) });
    }
  }
  if (resource === "reports" && method === "GET") {
    await need("reports:read");
    const report = await computeReports(org, {
      days: q.days,
      allInactive: id === "users.csv",
    });
    if (id === "users.csv")
      return new Response(
        toCSV(report.users.inactive, [
          "uuid",
          "username",
          "email",
          "lastActive",
        ]),
        { headers: { "Content-Type": "text/csv; charset=utf-8" } },
      );
    if (id === "boards.csv") {
      const policy = await org.policy();
      const rows = (await org.list("org:board:")).map((r) =>
        listedBoard(r.value, org.now(), policy),
      );
      return new Response(
        toCSV(rows, [
          "room",
          "title",
          "owner",
          "ownerName",
          "created",
          "lastActivity",
          "objectCount",
          "visibility",
          "memberCount",
          "guestCount",
          "peakParticipants",
          "archived",
          "deleted",
        ]),
        { headers: { "Content-Type": "text/csv; charset=utf-8" } },
      );
    }
    return json(report);
  }
  if (resource === "webhooks") {
    const identity = await need("webhooks:write");
    if (method === "GET")
      return json(await call(identity, { op: "webhooks.list" }));
    // Deliveries carry full audit events, so subscribing needs audit access.
    if (method === "POST") {
      await need("audit:read");
      return json(
        await call(identity, {
          op: "webhooks.create",
          url: body?.url,
          events: body?.events,
        }),
        201,
      );
    }
    if (method === "DELETE" && id)
      return json(await call(identity, { op: "webhooks.delete", id }));
  }
  fail(404, "Unknown API endpoint.");
}
// The methods the API description lists for a /v1 path's segments, or null
// for a path it does not document. A named segment, such as {id}, matches
// any one segment.
let documented = null;
function documentedMethods(parts) {
  documented ??= Object.entries(openAPI("").paths)
    .filter(([path]) => path.startsWith("/v1/"))
    .map(([path, operations]) => ({
      segments: path.slice(4).split("/"),
      methods: Object.keys(operations).filter((m) => m !== "parameters"),
    }));
  const methods = new Set();
  for (const route of documented)
    if (
      route.segments.length === parts.length &&
      route.segments.every((s, n) => s.startsWith("{") || s === parts[n])
    )
      route.methods.forEach((m) => methods.add(m));
  return methods.size ? methods : null;
}
// A compact OpenAPI 3.1 description so CDS can automate against the API.
// Declares what every operation shares: parameters named in its path,
// request bodies, and the success status each answers with.
function completePaths(paths) {
  for (const [path, operations] of Object.entries(paths)) {
    const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (names.length)
      operations.parameters = names.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    const scimPath = path.startsWith("/scim/");
    for (const [method, operation] of Object.entries(operations)) {
      if (method === "parameters") continue;
      // For code generators, such as getV1UsersUuid.
      operation.operationId =
        method +
        path.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) =>
          c ? c.toUpperCase() : "",
        );
      if (["post", "put", "patch"].includes(method))
        operation.requestBody = {
          required: true,
          content: {
            [scimPath ? "application/scim+json" : "application/json"]: {
              schema: { type: "object" },
            },
          },
        };
      const created = method === "post",
        removed = method === "delete" && scimPath;
      if (created || removed) {
        const { 200: _, ...rest } = operation.responses;
        operation.responses = created
          ? { 201: { description: "Created" }, ...rest }
          : { 204: { description: "Deleted" }, ...rest };
      }
      // REST errors answer {"error": "..."}; SCIM ones use SCIM's own error.
      if (!scimPath)
        for (const [status, description] of [
          [400, "Invalid request"],
          [401, "Missing or invalid API key"],
          [403, "Missing scope, or not allowed"],
          [404, "Not found"],
        ])
          operation.responses[status] = {
            description:
              operation.responses[status]?.description || description,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          };
    }
  }
  return paths;
}
export function openAPI(base) {
  const secured = (scope, summary, extra = {}) => ({
    summary,
    security: [{ apiKey: [scope] }],
    responses: {
      200: { description: "OK" },
      401: { description: "Missing or invalid API key" },
      403: { description: "Missing scope" },
    },
    ...extra,
  });
  const query = (...names) => ({
    parameters: names.map((name) => ({
      name,
      in: "query",
      schema: { type: "string" },
    })),
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "Whiteboard organization API",
      version: "1.0.0",
      description:
        "Administrative REST API and SCIM 2.0 provisioning for a Whiteboard organization. Create API keys in Organization settings, then send them as bearer tokens. SCIM base URL: " +
        `${base}/scim/v2`,
    },
    servers: [{ url: base }],
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        },
      },
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "Organization API key (wbk_...)",
        },
      },
    },
    paths: completePaths({
      "/v1/audit": {
        get: secured(
          "audit:read",
          "Audit log events, newest first. Use format=ndjson for SIEM ingestion and cursor for paging. A request reads a bounded number of records, so a filtered page can hold fewer events than the limit, or none, while a cursor remains; keep paging until it is null.",
          query(
            "from",
            "to",
            "action",
            "category",
            "actor",
            "board",
            "limit",
            "cursor",
            "format",
          ),
        ),
      },
      "/v1/users": {
        get: secured(
          "users:read",
          "Organization users. format=csv exports a spreadsheet.",
          query("role", "status", "query", "format"),
        ),
      },
      "/v1/users/{uuid}": {
        get: secured("users:read", "One user"),
        patch: secured(
          "users:write",
          "Change role (member, guest) or status (active, deactivated)",
        ),
      },
      "/v1/teams": {
        get: secured("users:read", "Teams"),
        post: secured("users:write", "Create a team"),
      },
      "/v1/teams/{id}": {
        patch: secured("users:write", "Rename or change members"),
        delete: secured("users:write", "Delete a team"),
      },
      "/v1/boards": {
        get: secured(
          "boards:read",
          "Board directory with filters",
          query(
            "query",
            "owner",
            "team",
            "space",
            "visibility",
            "createdAfter",
            "createdBefore",
            "updatedAfter",
            "updatedBefore",
            "activity",
            "type",
            "archived",
            "deleted",
            "guests",
            "sort",
            "limit",
            "offset",
          ),
        ),
      },
      "/v1/boards/duplicates": {
        get: secured("boards:read", "Boards that look duplicated"),
      },
      "/v1/boards/{room}": {
        get: secured("boards:read", "Board metadata and members"),
        patch: secured(
          "boards:write",
          "Transfer ownership, archive, restore, delete, legal hold, or visibility",
        ),
      },
      "/v1/boards/{room}/activity": {
        get: secured(
          "audit:read",
          "Board-level activity log, newest first. Pass the returned cursor for older events until it is null.",
          query("limit", "cursor"),
        ),
      },
      "/v1/reports": {
        get: secured(
          "reports:read",
          "Adoption, usage, sharing, and session reports",
          query("days"),
        ),
      },
      "/v1/reports/users.csv": {
        get: secured("reports:read", "Inactive users as CSV"),
      },
      "/v1/reports/boards.csv": {
        get: secured("reports:read", "All boards as CSV"),
      },
      "/v1/webhooks": {
        get: secured("webhooks:write", "Webhook subscriptions"),
        post: {
          ...secured(
            "webhooks:write",
            "Subscribe an HTTPS endpoint to events; deliveries carry X-Whiteboard-Signature (HMAC SHA-256). Also requires audit:read.",
          ),
          security: [{ apiKey: ["webhooks:write", "audit:read"] }],
        },
      },
      "/v1/webhooks/{id}": {
        delete: secured("webhooks:write", "Remove a webhook"),
      },
      "/scim/v2/Users": {
        get: secured(
          "scim",
          "SCIM users (filter userName, externalId, emails.value)",
        ),
        post: secured("scim", "Provision a user by email"),
      },
      "/scim/v2/Users/{id}": {
        get: secured("scim", "SCIM user"),
        put: secured("scim", "Replace"),
        patch: secured("scim", "PatchOp, including active=false to deactivate"),
        delete: secured("scim", "Deprovision"),
      },
      "/scim/v2/Groups": {
        get: secured("scim", "SCIM groups (teams)"),
        post: secured("scim", "Create a group"),
      },
      "/scim/v2/Groups/{id}": {
        get: secured("scim", "SCIM group"),
        put: secured("scim", "Replace"),
        patch: secured("scim", "Add or remove members"),
        delete: secured("scim", "Delete"),
      },
    }),
  };
}
