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

var SCIM_TYPE = "application/scim+json";
var PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
var EXTERNAL = "google:";
// Requests sent together, and how long a run works before leaving the
// rest to the next one (Apps Script stops a run after six minutes).
var BATCH = 20;
var BUDGET_MS = 4.5 * 60 * 1000;

function syncWhiteboard() {
  var config = settings_();
  var started = Date.now();
  var summary = { created: 0, updated: 0, deactivated: 0, teams: 0 };
  var people = googleUsers_(config);
  var known = scimUsers_(config);
  var byExternal = {},
    byName = {};
  known.forEach(function (u) {
    if (u.externalId) byExternal[u.externalId] = u;
    byName[String(u.userName).toLowerCase()] = u;
  });
  var requests = [],
    seen = {};
  people.forEach(function (person) {
    var externalId = EXTERNAL + person.id;
    seen[externalId] = true;
    var existing = byExternal[externalId] || byName[person.email];
    var wanted = userResource_(person, externalId);
    if (!existing) {
      // Suspended people are not provisioned only to be deactivated.
      if (!person.active) return;
      requests.push(scimRequest_(config, "post", "/Users", wanted));
      summary.created++;
      return;
    }
    var operations = changes_(existing, wanted);
    if (!operations.length) return;
    requests.push(
      scimRequest_(config, "patch", "/Users/" + existing.id, {
        schemas: [PATCH_SCHEMA],
        Operations: operations,
      }),
    );
    if (!person.active && existing.active) summary.deactivated++;
    else summary.updated++;
  });
  // People this sync provisioned who left the directory, or its scope, lose
  // access; anyone provisioned another way is left alone.
  known.forEach(function (u) {
    if (
      u.active &&
      String(u.externalId || "").indexOf(EXTERNAL) === 0 &&
      !seen[u.externalId]
    ) {
      requests.push(
        scimRequest_(config, "patch", "/Users/" + u.id, {
          schemas: [PATCH_SCHEMA],
          Operations: [{ op: "replace", path: "active", value: false }],
        }),
      );
      summary.deactivated++;
    }
  });
  var finished = send_(config, requests, started);
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
    var groupRequests = [];
    config.groups.forEach(function (address) {
      var group = AdminDirectory.Groups.get(address);
      var members = groupMembers_(address)
        .map(function (email) {
          return listed[email];
        })
        .filter(Boolean)
        .sort();
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
        groupRequests.push(scimRequest_(config, "post", "/Groups", body));
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
        groupRequests.push(
          scimRequest_(config, "put", "/Groups/" + team.id, body),
        );
      else return;
      summary.teams++;
    });
    finished = send_(config, groupRequests, started);
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

// Sends changes a batch at a time, within the run's time; false when some
// are left for the next run.
function send_(config, requests, started) {
  for (var n = 0; n < requests.length; n += BATCH) {
    if (Date.now() - started > BUDGET_MS) return false;
    var batch = requests.slice(n, n + BATCH);
    if (config.dryRun) {
      batch.forEach(function (r) {
        Logger.log(
          r.method.toUpperCase() + " " + r.url + " " + (r.payload || ""),
        );
      });
      continue;
    }
    UrlFetchApp.fetchAll(batch).forEach(function (response, i) {
      try {
        check_(response, batch[i].method.toUpperCase() + " " + batch[i].url);
      } catch (error) {
        // One refused change, such as an address another person holds, is
        // logged and the others go ahead.
        Logger.log(error.message + " " + (batch[i].payload || ""));
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
