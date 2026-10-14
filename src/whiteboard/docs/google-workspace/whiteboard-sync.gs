/**
 * Whiteboard directory sync for Google Workspace.
 *
 * Keeps a Whiteboard organization's people and teams in step with Google
 * Workspace through the organization's SCIM 2.0 API: people are provisioned
 * when they join the directory, renamed and moved between member and guest
 * when Google changes them, deactivated when suspended or removed, and
 * chosen Google groups become teams with the same members.
 *
 * Setup: see README.md in this folder. Run syncWhiteboard() once by hand to
 * authorize it, then add a time-driven trigger (for example every 15
 * minutes).
 */

// Script properties (Project Settings → Script properties).
//   WHITEBOARD_URL       The organization's worker, https://….puter.work
//   WHITEBOARD_SCIM_KEY  An API key with the scim scope
//   USER_QUERY           Optional Admin SDK search, such as
//                        orgUnitPath='/Staff'; every user when empty
//   GUEST_ORG_UNITS      Optional organizational units whose people are
//                        guests, comma separated, such as /Contractors
//   GROUPS               Optional Google group addresses to keep as teams,
//                        comma separated
//   DRY_RUN              "true" logs the changes without making them
//   ALLOW_LARGE_REMOVALS "true" lets one run remove more than a fifth of
//                        the people it provisioned

var SCIM_TYPE = "application/scim+json";
var PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
var EXTERNAL = "google:";
// Requests sent together, and how long a run works before leaving the
// rest to the next one (Apps Script stops a run after six minutes).
var BATCH = 20;
var BUDGET_MS = 4.5 * 60 * 1000;

function syncWhiteboard() {
  // A run started by hand while the trigger's runs could otherwise both
  // create the same people and teams.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log("Another sync is running; this one stops.");
    return null;
  }
  try {
    return sync_(settings_());
  } finally {
    lock.releaseLock();
  }
}

function sync_(config) {
  var started = Date.now();
  var summary = {
    created: 0,
    updated: 0,
    deactivated: 0,
    removed: 0,
    teams: 0,
    conflicts: 0,
    failed: 0,
  };
  var people = googleUsers_(config);
  // A search that matches no one, as when USER_QUERY is mistyped, would
  // otherwise remove everyone the sync provisioned.
  if (!people.length)
    throw new Error(
      "Google Workspace listed no users, so nothing was changed. Check USER_QUERY.",
    );
  var known = scimUsers_(config);
  var byExternal = {},
    byName = {};
  known.forEach(function (u) {
    if (u.externalId) byExternal[u.externalId] = u;
    byName[String(u.userName).toLowerCase()] = u;
  });
  var changes = [],
    seen = {};
  var change = function (kind, method, path, body) {
    changes.push({
      kind: kind,
      request: scimRequest_(config, method, path, body),
    });
  };
  people.forEach(function (person) {
    var externalId = EXTERNAL + person.id;
    seen[externalId] = true;
    var existing = byExternal[externalId];
    if (!existing && byName[person.email]) {
      var holder = byName[person.email];
      // Someone else's record, another Google user's or another tool's,
      // is never taken over by its address; an administrator decides.
      if (holder.externalId && holder.externalId !== externalId) {
        Logger.log(
          person.email +
            " is held by another person in Whiteboard (" +
            holder.externalId +
            "); it was left as it is.",
        );
        summary.conflicts++;
        return;
      }
      existing = holder;
    }
    var wanted = userResource_(person, externalId);
    if (!existing) {
      // Suspended people are not provisioned only to be deactivated.
      if (person.active) change("created", "post", "/Users", wanted);
      return;
    }
    // A suspension goes on its own, first, so a change Whiteboard refuses,
    // such as a new address another person holds, never keeps someone
    // active.
    if (!person.active && existing.active)
      change("deactivated", "patch", "/Users/" + existing.id, {
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: "replace", path: "active", value: false }],
      });
    var operations = changes_(existing, wanted).filter(function (op) {
      return !(op.path === "active" && op.value === false);
    });
    if (operations.length)
      change("updated", "patch", "/Users/" + existing.id, {
        schemas: [PATCH_SCHEMA],
        Operations: operations,
      });
  });
  // People this sync provisioned who left the directory, or its scope, are
  // deleted from Whiteboard's directory: their access ends, and their
  // address can be provisioned for someone new without reaching their
  // account. Anyone provisioned another way is left alone. Unusually many
  // at once wait for ALLOW_LARGE_REMOVALS, in case the directory answered
  // only in part.
  var leaving = known.filter(function (u) {
    return (
      String(u.externalId || "").indexOf(EXTERNAL) === 0 && !seen[u.externalId]
    );
  });
  var provisioned = known.filter(function (u) {
    return String(u.externalId || "").indexOf(EXTERNAL) === 0;
  }).length;
  if (
    leaving.length > Math.max(10, provisioned / 5) &&
    !config.allowLargeRemovals
  ) {
    Logger.log(
      leaving.length +
        " people left the directory or its scope; none were removed. If that is right, set ALLOW_LARGE_REMOVALS to true for one run.",
    );
    summary.conflicts += leaving.length;
  } else
    leaving.forEach(function (u) {
      change("removed", "delete", "/Users/" + u.id);
    });
  var finished = send_(config, changes, started, summary);
  if (finished && config.groups.length) {
    // Group members are matched by the people as Whiteboard now lists them.
    var listed = {};
    scimUsers_(config).forEach(function (u) {
      listed[String(u.userName).toLowerCase()] = u.id;
    });
    var teams = {};
    scimGroups_(config).forEach(function (g) {
      if (g.externalId) teams[g.externalId] = g;
    });
    var groupChanges = [];
    config.groups.forEach(function (address) {
      var group = AdminDirectory.Groups.get(address);
      var unique = {};
      groupMembers_(address).forEach(function (email) {
        if (listed[email]) unique[listed[email]] = true;
      });
      var members = Object.keys(unique).sort();
      var externalId = EXTERNAL + group.id;
      var team = teams[externalId];
      var body = {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: group.name,
        externalId: externalId,
        members: members.map(function (value) {
          return { value: value };
        }),
      };
      if (!team)
        groupChanges.push({
          kind: "teams",
          request: scimRequest_(config, "post", "/Groups", body),
        });
      else if (
        team.displayName !== group.name ||
        JSON.stringify(
          (team.members || [])
            .map(function (m) {
              return m.value;
            })
            .sort(),
        ) !== JSON.stringify(members)
      )
        groupChanges.push({
          kind: "teams",
          request: scimRequest_(config, "put", "/Groups/" + team.id, body),
        });
    });
    finished = send_(config, groupChanges, started, summary);
  }
  Logger.log(
    (config.dryRun ? "Dry run: " : "") +
      JSON.stringify(summary) +
      (finished ? "" : " More changes wait for the next run."),
  );
  return summary;
}

function settings_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  var list = function (value) {
    return String(value || "")
      .split(",")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  };
  if (
    !/^https:\/\/[^/]+$/.test(String(p.WHITEBOARD_URL || "").replace(/\/$/, ""))
  )
    throw new Error("Set WHITEBOARD_URL to the organization's worker address.");
  if (!p.WHITEBOARD_SCIM_KEY)
    throw new Error(
      "Set WHITEBOARD_SCIM_KEY to an API key with the scim scope.",
    );
  return {
    url: String(p.WHITEBOARD_URL).replace(/\/$/, "") + "/scim/v2",
    key: p.WHITEBOARD_SCIM_KEY,
    query: p.USER_QUERY || "",
    guestUnits: list(p.GUEST_ORG_UNITS),
    groups: list(p.GROUPS).map(function (g) {
      return g.toLowerCase();
    }),
    dryRun: String(p.DRY_RUN).toLowerCase() === "true",
    allowLargeRemovals: String(p.ALLOW_LARGE_REMOVALS).toLowerCase() === "true",
  };
}

// Directory people in scope, with whether they are active and a guest. A
// unit counts with the units inside it.
function googleUsers_(config) {
  var people = [],
    token;
  do {
    var page = AdminDirectory.Users.list({
      customer: "my_customer",
      maxResults: 500,
      pageToken: token,
      query: config.query || undefined,
      projection: "basic",
    });
    (page.users || []).forEach(function (u) {
      var unit = u.orgUnitPath || "/";
      people.push({
        id: u.id,
        email: String(u.primaryEmail).toLowerCase(),
        givenName: (u.name && u.name.givenName) || "",
        familyName: (u.name && u.name.familyName) || "",
        active: !u.suspended && !u.archived,
        guest: config.guestUnits.some(function (g) {
          return unit === g || unit.indexOf(g.replace(/\/$/, "") + "/") === 0;
        }),
      });
    });
    token = page.nextPageToken;
  } while (token);
  return people;
}

// Direct and nested members of a group who are people, by address.
function groupMembers_(address) {
  var emails = [],
    token;
  do {
    var page = AdminDirectory.Members.list(address, {
      maxResults: 200,
      pageToken: token,
      includeDerivedMembership: true,
    });
    (page.members || []).forEach(function (m) {
      if (m.type === "USER" && m.email) emails.push(m.email.toLowerCase());
    });
    token = page.nextPageToken;
  } while (token);
  return emails;
}

function userResource_(person, externalId) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: person.email,
    externalId: externalId,
    name: { givenName: person.givenName, familyName: person.familyName },
    emails: [{ value: person.email, type: "work", primary: true }],
    active: person.active,
    roles: [{ value: person.guest ? "guest" : "member", primary: true }],
  };
}

// What differs between a listed person and the directory's version.
// Administrators keep their role: SCIM never changes it.
function changes_(existing, wanted) {
  var ops = [];
  var name = existing.name || {};
  if (String(existing.userName).toLowerCase() !== wanted.userName)
    ops.push({ op: "replace", path: "userName", value: wanted.userName });
  if (existing.externalId !== wanted.externalId)
    ops.push({ op: "replace", path: "externalId", value: wanted.externalId });
  if ((name.givenName || "") !== wanted.name.givenName)
    ops.push({
      op: "replace",
      path: "name.givenName",
      value: wanted.name.givenName,
    });
  if ((name.familyName || "") !== wanted.name.familyName)
    ops.push({
      op: "replace",
      path: "name.familyName",
      value: wanted.name.familyName,
    });
  if (existing.active !== wanted.active)
    ops.push({ op: "replace", path: "active", value: wanted.active });
  var role = existing.roles && existing.roles[0] && existing.roles[0].value;
  if (role !== "admin" && role !== "owner" && role !== wanted.roles[0].value)
    ops.push({ op: "replace", path: "roles", value: wanted.roles });
  return ops;
}

function scimUsers_(config) {
  return scimList_(config, "/Users");
}
function scimGroups_(config) {
  return scimList_(config, "/Groups");
}
function scimList_(config, path) {
  var out = [],
    start = 1,
    total;
  do {
    var request = scimRequest_(
      config,
      "get",
      path + "?count=500&startIndex=" + start,
    );
    var page = JSON.parse(
      check_(
        UrlFetchApp.fetch(request.url, {
          method: request.method,
          headers: request.headers,
          muteHttpExceptions: true,
        }),
        path,
      ),
    );
    out = out.concat(page.Resources || []);
    total = page.totalResults || 0;
    start += (page.Resources || []).length;
  } while ((page.Resources || []).length && start <= total);
  return out;
}

function scimRequest_(config, method, path, body) {
  var request = {
    url: config.url + path,
    method: method,
    headers: { Authorization: "Bearer " + config.key },
    muteHttpExceptions: true,
  };
  if (body) {
    request.contentType = SCIM_TYPE;
    request.payload = JSON.stringify(body);
  }
  return request;
}

// Sends changes a batch at a time, within the run's time, counting each
// one Whiteboard accepted by its kind; false when some are left for the
// next run. A dry run counts what it would send.
function send_(config, changes, started, summary) {
  for (var n = 0; n < changes.length; n += BATCH) {
    if (Date.now() - started > BUDGET_MS) return false;
    var batch = changes.slice(n, n + BATCH);
    if (config.dryRun) {
      batch.forEach(function (c) {
        Logger.log(
          c.request.method.toUpperCase() +
            " " +
            c.request.url +
            " " +
            (c.request.payload || ""),
        );
        summary[c.kind]++;
      });
      continue;
    }
    UrlFetchApp.fetchAll(
      batch.map(function (c) {
        return c.request;
      }),
    ).forEach(function (response, i) {
      var request = batch[i].request;
      try {
        check_(response, request.method.toUpperCase() + " " + request.url);
        summary[batch[i].kind]++;
      } catch (error) {
        // One refused change, such as an address another person holds, is
        // logged and the others go ahead.
        Logger.log(error.message + " " + (request.payload || ""));
        summary.failed++;
      }
    });
  }
  return true;
}

function check_(response, what) {
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code >= 200 && code < 300) return text;
  var detail = "";
  try {
    detail = JSON.parse(text).detail || "";
  } catch (e) {}
  throw new Error(what + " answered " + code + (detail ? ": " + detail : "."));
}
