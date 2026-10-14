import { accessChanged, forgetRecords } from "./service.js";
import { hash } from "../src/collaboration/protocol.js";
import { fold, wordContext } from "../src/search-fold.js";
import { validateBoard } from "../src/model.js";
import { canonicalLanguage } from "../src/accessibility/language-tag.js";
import {
  appendRun,
  sliceTextRuns,
  validateTextRuns,
} from "../src/rich-text.js";
import {
  BOARD_ROLES,
  DAY,
  ORG_ROLES,
  SECRETS,
  administers,
  auditCategory,
  emailDomain,
  guestsShutOut,
  inDomains,
  fail,
  listedBoard,
  memberChanges,
  mergePolicy,
  normalizePolicy,
  publicHost,
  teamGrants,
  validEmail,
} from "./org.js";
import { computeReports } from "./reports.js";
import {
  bilingualBody,
  bilingualSubject,
  hookMatches,
  delivered,
  mail,
  sendHook,
  siem,
  slackStatus,
  testSlack,
} from "./delivery.js";

const text = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
function libraryDescription(input) {
  const raw = typeof input.description === "string" ? input.description : "",
    lang = canonicalLanguage(input.descriptionLang);
  try {
    if (input.descriptionLang !== undefined && !lang) throw Error();
    validateTextRuns(raw, input.descriptionRuns);
    if (
      input.descriptionRuns?.some((run) =>
        Object.keys(run.style).some((key) => key !== "lang"),
      )
    )
      throw Error();
  } catch {
    fail(400, "Invalid library description language.");
  }
  const start = raw.length - raw.trimStart().length;
  let end = start + Math.min(raw.trim().length, 500);
  if (
    /[\uD800-\uDBFF]/.test(raw[end - 1] || "") &&
    /[\uDC00-\uDFFF]/.test(raw[end] || "")
  )
    end--;
  const description = raw.slice(start, end),
    runs = [];
  for (const run of sliceTextRuns(input.descriptionRuns, start, end)) {
    const tag = canonicalLanguage(run.style.lang);
    if (tag) appendRun(runs, run.start, run.end, { lang: tag });
  }
  return {
    description,
    ...(description && lang ? { descriptionLang: lang } : {}),
    ...(runs.length ? { descriptionRuns: runs } : {}),
  };
}
function feedbackComment(input) {
  const raw = typeof input.comment === "string" ? input.comment : "",
    lang = canonicalLanguage(input.lang);
  try {
    if (input.lang !== undefined && !lang) throw Error();
    validateTextRuns(raw, input.textRuns);
    if (
      input.textRuns?.some((run) =>
        Object.keys(run.style).some((key) => key !== "lang"),
      )
    )
      throw Error();
  } catch {
    fail(400, "Invalid feedback language.");
  }
  const start = raw.length - raw.trimStart().length;
  let end = start + Math.min(raw.trim().length, 1000);
  if (
    /[\uD800-\uDBFF]/.test(raw[end - 1] || "") &&
    /[\uDC00-\uDFFF]/.test(raw[end] || "")
  )
    end--;
  const comment = raw.slice(start, end),
    runs = [];
  for (const run of sliceTextRuns(input.textRuns, start, end)) {
    const tag = canonicalLanguage(run.style.lang);
    if (tag) appendRun(runs, run.start, run.end, { lang: tag });
  }
  return {
    comment,
    ...(comment && lang ? { lang } : {}),
    ...(runs.length ? { textRuns: runs } : {}),
  };
}
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const id = (value) => {
  if (typeof value !== "string" || !ID.test(value))
    fail(400, "Invalid identifier.");
  return value;
};
const token = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
const short = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const publicUser = (u) => ({
  uuid: u.uuid,
  username: u.username || null,
  email: u.email || null,
  emailVerified: !!u.emailVerified,
  role: u.role,
  status: u.status,
  // Whether someone not signed in yet will arrive active.
  ...(u.status === "pending" ? { active: u.active !== false } : {}),
  license: u.license || (u.role === "guest" ? "guest" : "full"),
  teams: u.teams || [],
  created: u.created || null,
  lastActive: u.lastActive || null,
  source: u.source || null,
  externalId: u.externalId || null,
  // The id SCIM knows them by, so automation using both APIs can match
  // people without comparing addresses.
  scimId: u.scimId || null,
});
export const API_SCOPES = [
  "scim",
  "users:read",
  "users:write",
  "boards:read",
  "boards:write",
  "audit:read",
  "reports:read",
  "webhooks:write",
];
export const WEBHOOK_EVENTS = [
  "*",
  "board",
  "board.created",
  "board.deleted",
  "board.archived",
  "board.transfer",
  "board.visibility",
  "board.role",
  "board.guest",
  "board.comment",
  "board.content",
  "user",
  "user.joined",
  "user.role",
  "user.deactivated",
  "team",
  "scim",
  "scim.user",
  "scim.group",
  "policy",
  "apikey",
  "vote",
];

// An identity provider that manages a person's account also manages their
// address: verifying another one would hide them from its lookups, and its
// deprovisioning would miss them.
function managedAddress(user, email) {
  if (user?.scimManaged && user.email && user.email !== email)
    fail(
      409,
      "Your identity provider manages your email address. Ask your administrator to change it.",
    );
}
// Link a verified email to an account. SCIM may already have provisioned a
// pending record for that address; the account then inherits its role,
// teams, and status, and keeps the SCIM identifier the IdP knows.
export async function linkEmail(org, identity, email, { onDeactivated } = {}) {
  email = email.toLowerCase();
  const emailKey = "org:email:" + (await hash(email));
  const linked = await org.kv.get(emailKey);
  let user = await org.freshUser(identity.uuid);
  managedAddress(user, email);
  const wasActive = !user || user.status === "active";
  if (linked && linked !== identity.uuid) {
    const other = await org.freshUser(linked);
    if (other && other.status !== "pending")
      fail(409, "This email address is already linked to another account.");
    if (other) {
      const isOwner = identity.uuid === (await org.accountOwner()).uuid;
      // Linking never lifts a deactivation or lowers an existing role.
      const rank = ["guest", "member", "admin"];
      const role =
        user && rank.indexOf(user.role) > rank.indexOf(other.role)
          ? user.role
          : other.role;
      user = {
        ...other,
        ...(user || {}),
        uuid: identity.uuid,
        username: identity.username,
        role: isOwner ? "owner" : role,
        // The license follows the role, so a guest who becomes a member
        // is no longer counted or shown as a guest.
        license: isOwner || role !== "guest" ? "full" : "guest",
        teams: [...new Set([...(user?.teams || []), ...(other.teams || [])])],
        // Provisioning can never deactivate the account that owns the worker.
        status: isOwner
          ? "active"
          : user?.status === "deactivated" ||
              (other.active === false &&
                (user?.role !== "admin" || other.inactiveByOwner))
            ? "deactivated"
            : "active",
        scimId: other.scimId,
        externalId: other.externalId,
        source: "scim",
      };
      if (other.scimManaged) {
        // The new provisioned identity owns the SCIM lifecycle. A deleted
        // previous identity must not hide it from its provider; status above
        // still preserves the account's existing deactivation.
        user.scimManaged = true;
        delete user.scimDeleted;
      }
      delete user.active;
      delete user.inactiveByOwner;
      await org.dropUser(other.uuid);
      await movePendingMemberships(org, other.uuid, identity);
      if (other.scimId)
        await org.kv.set("org:scimid:" + other.scimId, user.uuid);
      for (const teamId of user.teams) {
        const unlock = await lockTeam(org, teamId);
        try {
          const team = await org.kv.get("org:team:" + teamId);
          if (team) {
            team.members = [
              ...new Set(
                team.members.map((m) => (m === other.uuid ? user.uuid : m)),
              ),
            ];
            await org.kv.set("org:team:" + teamId, team);
          }
        } finally {
          await unlock();
        }
      }
    }
  }
  if (user) {
    const previous = user.email?.toLowerCase();
    user.email = email;
    user.emailVerified = true;
    await org.saveUser(user);
    // The address this account used before is free for its next owner.
    if (previous && previous !== email) {
      const key = "org:email:" + (await hash(previous));
      if ((await org.kv.get(key)) === user.uuid) await org.kv.del(key);
    }
    if (wasActive && user.status === "deactivated")
      await onDeactivated?.(user.uuid);
  }
  return user;
}
// The accounts a team change names. Members are people the organization
// knows, by account or by the identifier their identity provider uses; an
// unknown identifier would otherwise be kept as a member no one is. Members
// a team already has are taken as they are, and people being removed need
// not still exist.
async function teamMembers(org, ids, known = true, current = []) {
  const kept = new Set(current),
    owner = (await org.accountOwner()).uuid;
  const out = [];
  for (let n = 0; n < ids.length; n += 50)
    out.push(
      ...(await Promise.all(
        ids.slice(n, n + 50).map(async (member) => {
          if (kept.has(member) || member === owner) return member;
          const mapped = await org.kv.get("org:scimid:" + member);
          if (mapped) return mapped;
          if (!known || (await org.user(member))) return member;
          fail(400, `Unknown team member: ${member}.`);
        }),
      )),
    );
  return out;
}
// Record a team's membership change on the people who joined or left it.
// A board filed under the team can give its members a role, so other
// worker instances read people's records again: once for the whole change,
// however many people it names, as an identity provider adding a thousand
// people to a group sends them in one request.
// People are updated 25 at a time, as an identity provider can change
// thousands of members in one request, and the team's claim is renewed as
// they go, so it does not lapse during a long change.
export async function syncTeamMembers(org, teamId, before, after) {
  const prior = new Set(before),
    next = new Set(after);
  const moving = [...new Set([...prior, ...next])].filter(
    (uuid) => prior.has(uuid) !== next.has(uuid),
  );
  let changed = false;
  for (let n = 0; n < moving.length; n += 25) {
    if (n) await org.kv.expire("org:teamclaim:" + teamId, 30).catch(() => {});
    await Promise.all(
      moving.slice(n, n + 25).map(async (uuid) => {
        const user = await org.freshUser(uuid);
        if (!user) return;
        const teams = new Set(user.teams || []);
        if (next.has(uuid)) teams.add(teamId);
        else teams.delete(teamId);
        await org.updateUser(uuid, { teams: [...teams] });
        changed = true;
      }),
    );
  }
  if (changed) await org.accessChanged();
}
// Changes to one team are made one at a time, so two at once both stand:
// requests on this instance wait their turn in order, and instances claim
// the team in storage, waiting while another holds it. The claim lapses on
// its own, so a worker stopped mid-change never blocks the team. A change
// reads the team again once it holds the claim, and calls the returned
// function when done.
const TEAM_CLAIM_WAIT = 100,
  TEAM_CLAIM_TRIES = 150;
export async function lockTeam(org, teamId) {
  const turns = (org.instance.teamTurns ??= new Map());
  const before = turns.get(teamId);
  let done;
  const turn = new Promise((resolve) => (done = resolve));
  const queued = (before || Promise.resolve()).then(() => turn);
  turns.set(teamId, queued);
  const finish = () => {
    done();
    if (turns.get(teamId) === queued) turns.delete(teamId);
  };
  await before;
  const claim = "org:teamclaim:" + teamId;
  try {
    for (let n = 0; (await org.kv.incr(claim)) !== 1; n++) {
      if (n >= TEAM_CLAIM_TRIES)
        fail(409, "This team is being changed. Please try again.");
      await new Promise((r) => setTimeout(r, TEAM_CLAIM_WAIT));
    }
    await org.kv.expire(claim, 30).catch(() => {});
  } catch (error) {
    finish();
    throw error;
  }
  return async () => {
    try {
      await org.kv.del(claim);
    } finally {
      finish();
    }
  };
}
// Board access granted to a provisioned or migrated address before its owner
// signed in moves to their account once they verify that address.
async function movePendingMemberships(org, pending, identity) {
  for (const row of await org.list(`org:ub:${pending}:`)) {
    const room = row.key.split(":").at(-1);
    const record = await org.kv.get(`wb:${room}:member:${pending}`);
    if (record) {
      // Access the account already has wins when it is higher, and a board
      // manager's removal stands unless the address owns the board.
      const existing = await org.kv.get(`wb:${room}:member:${identity.uuid}`);
      const keep =
        existing &&
        (existing.role === "removed"
          ? record.role !== "owner"
          : BOARD_ROLES.indexOf(existing.role) <=
            BOARD_ROLES.indexOf(record.role));
      if (!keep)
        await org.kv.set(`wb:${room}:member:${identity.uuid}`, {
          ...record,
          uuid: identity.uuid,
          username: identity.username,
        });
      await org.kv.del(`wb:${room}:member:${pending}`);
      await org.indexMembership(pending, room, null);
      await org.indexMembership(
        identity.uuid,
        room,
        keep ? existing.role : record.role,
      );
    }
    await org.kv.del(row.key);
    const meta = await org.kv.get(`wb:${room}:meta`);
    if (meta?.owner === pending) {
      await org.kv.set(
        `wb:${room}:meta`,
        { ...meta, owner: identity.uuid },
        { disableSharing: true },
      );
      await org.registerBoard(room, {
        owner: identity.uuid,
        ownerName: identity.username,
      });
    }
    forgetRecords(`wb:${room}:`);
    if (record || meta?.owner === pending) await accessChanged(org.kv, room);
  }
}
// Find the account for an address, or create a pending one that becomes a
// real account when someone verifies that address.
export async function accountForEmail(org, email, { name, guest, source }) {
  email = email.toLowerCase();
  const linked = await org.kv.get("org:email:" + (await hash(email)));
  const existing = linked && (await org.user(linked));
  if (existing) return existing;
  const uuid = "pending-" + crypto.randomUUID().replaceAll("-", "");
  const user = {
    uuid,
    scimId: uuid,
    email,
    emailVerified: false,
    displayName: typeof name === "string" ? name.slice(0, 200) : undefined,
    role: guest ? "guest" : "member",
    status: "pending",
    active: true,
    created: org.now(),
    source,
    teams: [],
  };
  await org.saveUser(user);
  await org.kv.set("org:scimid:" + uuid, uuid);
  return user;
}
// Verifying an email creates an organization record, so it is open only to
// people the organization already knows: the owner, existing members and
// board guests, addresses provisioned for them, and its own domains.
// Whether verifying an address could bring this person into the
// organization: anyone who is not already a member, administrator, or the
// owner.
async function joinsByVerifying(org, identity) {
  const role = await org.role(identity);
  return !role || role === "guest";
}
// Verification emails an hour, and wrong codes, for such people across the
// whole organization.
const OUTSIDE_SENDS = 300,
  OUTSIDE_WRONG_CODES = 100;
// An address without its plus tag: cam+x@example.ca and cam@example.ca
// reach the same mailbox.
const baseAddress = (email) => {
  const [local = "", domain = ""] = String(email || "")
    .toLowerCase()
    .split("@");
  return `${local.split("+")[0]}@${domain}`;
};
// Whether an address reaches the mailbox of an account that was
// deactivated, here or by the identity provider, through a plus tag on
// either: that person must not come back in through another spelling.
// The deactivated accounts' addresses are listed once and kept a few
// seconds, so capturing many guests at once lists them once.
async function aliasOfInactive(org, email) {
  const now = org.now();
  let kept = org.instance.inactiveAddresses;
  if (!kept || now - kept.at > 10_000 || now < kept.at) {
    const bases = new Set();
    for (const { value: user } of await org.list("org:user:"))
      if (
        user?.email &&
        (user.status === "deactivated" ||
          (user.status === "pending" && user.active === false))
      )
        bases.add(baseAddress(user.email));
    kept = org.instance.inactiveAddresses = { at: now, bases };
  }
  return kept.bases.has(baseAddress(email));
}
async function requireVerifiable(org, identity, email, { confirmed } = {}) {
  if (await org.user(identity.uuid)) return;
  if ((await org.accountOwner()).uuid === identity.uuid) return;
  const linked = await org.kv.get("org:email:" + (await hash(email)));
  if (linked && (await org.user(linked))?.status === "pending") return;
  const policy = await org.policy();
  if (policy.domainCapture && inDomains(email, policy.domains)) {
    // Checked once the mailbox is proven, so whether an address belongs to
    // a deactivated account is told only to whoever reads its mail.
    if (confirmed && (await aliasOfInactive(org, email)))
      fail(403, "Your organization account is deactivated.");
    return;
  }
  fail(
    403,
    "Use an email address in your organization's domain, or ask an administrator for an invitation.",
  );
}
// A guest who became a member is no longer counted as one on their boards,
// in the directory's guest filter and reports, as after a role change.
async function recountIfJoined(boards, before, user) {
  if (before?.role === "guest" && user?.role && user.role !== "guest")
    await boards?.recountBoardsOf?.(user.uuid).catch(() => {});
}
// A guest who verified an address in the organization's domains before
// capture covered it, as when capture is turned on or the domain added
// later, joins as a member as though they had verified it now. An
// administrator's own choice of guest, or an identity provider's, stays.
const capturable = (user, policy) =>
  user?.role === "guest" &&
  user.status === "active" &&
  !!user.emailVerified &&
  !user.scimManaged &&
  !user.roleChanged &&
  policy.domainCapture &&
  inDomains(user.email, policy.domains);
async function capture(org, boards, user) {
  const joined = await joinOrganization(
    org,
    { uuid: user.uuid, username: user.username },
    {},
  ).catch(() => null);
  await recountIfJoined(boards, user, joined);
}
// How many such guests a policy change brings in at once; anyone beyond
// joins the next time they open the organization.
const CAPTURE_BATCH = 200;
async function joinOrganization(org, identity, input) {
  const existing = await org.freshUser(identity.uuid);
  const invite = input.token
    ? await org.kv.get("org:invite:" + (await hash(String(input.token))))
    : null;
  // Members stay as they are, except that an administrator invitation,
  // which only the owner creates, makes a member an administrator. An
  // invitation made before the person's role last changed never undoes
  // that change. An identity provider that manages the account sets its
  // role, so neither a member link nor domain capture makes its guest a
  // member.
  const outdated =
    !!existing?.roleChanged && !(invite?.created > existing.roleChanged);
  const provisioned = !!existing?.scimManaged && invite?.role !== "admin";
  if (
    existing?.status === "active" &&
    (outdated ||
      provisioned ||
      (existing.role !== "guest" &&
        !(invite?.role === "admin" && existing.role === "member")))
  )
    return existing;
  if (existing?.status === "deactivated")
    fail(403, "Your organization account is deactivated.");
  const policy = await org.policy();
  let role = null,
    source = null;
  if (input.token) {
    // Like an API key, an invitation ends with its maker's administration.
    if (
      !invite ||
      invite.revoked ||
      invite.expires < org.now() ||
      (invite.createdBy && !(await administers(org, invite.createdBy)))
    )
      fail(403, "This organization invitation has expired or was revoked.");
    // Member and guest links can be shared with a team; an administrator
    // link makes one person an administrator.
    if (
      invite.role === "admin" &&
      invite.usedBy &&
      invite.usedBy !== identity.uuid
    )
      fail(403, "This administrator invitation was already used.");
    role = invite.role;
    source = "invite";
  } else if (
    existing?.emailVerified &&
    policy.domainCapture &&
    inDomains(existing.email, policy.domains) &&
    !(await aliasOfInactive(org, existing.email))
  ) {
    role = "member";
    source = "domain";
  }
  if (!role)
    fail(
      403,
      "Verify an email address in your organization's domain, or ask an administrator for an invitation.",
    );
  // Two people joining with the same administrator link at once would both
  // pass the check above, so the first to claim it atomically keeps it.
  if (invite?.role === "admin" && source === "invite" && !invite.usedBy) {
    const claim = "org:inviteclaim:" + (await hash(String(input.token)));
    if ((await org.kv.incr(claim)) === 1)
      await org.kv.set(claim + ":by", identity.uuid);
    else if ((await org.kv.get(claim + ":by")) !== identity.uuid)
      fail(403, "This administrator invitation was already used.");
  }
  const user = {
    ...(existing || {}),
    uuid: identity.uuid,
    username: identity.username,
    role,
    status: "active",
    license: role === "guest" ? "guest" : "full",
    created: existing?.created || org.now(),
    source,
    teams: existing?.teams || [],
  };
  await org.saveUser(user);
  if (invite?.role === "admin" && source === "invite" && !invite.usedBy)
    await org.kv.set("org:invite:" + (await hash(String(input.token))), {
      ...invite,
      usedBy: identity.uuid,
      used: org.now(),
    });
  const promoted =
    existing?.status === "active" &&
    existing.role === "member" &&
    role === "admin";
  await org.audit(
    identity,
    promoted ? "user.role.changed" : "user.joined",
    {
      type: "user",
      id: user.uuid,
      name: user.username,
    },
    promoted ? { from: existing.role, to: role, source } : { role, source },
  );
  return user;
}
// Read one record per board, a hundred boards to a request.
async function perBoard(org, prefix, rooms) {
  const rows = [];
  const list = [...rooms];
  for (let n = 0; n < list.length; n += 100) {
    const keys = list.slice(n, n + 100).map((room) => prefix + room);
    rows.push(
      ...(keys.length > 1
        ? await org.kv.get(keys)
        : [await org.kv.get(keys[0])]),
    );
  }
  return rows;
}
// Returns the boards and, when the directory was listed, its size.
async function boardRows(org, rooms, directory) {
  // When the boards are much of the directory, listing it in pages of 200
  // takes far fewer storage requests than reading each board. A person's
  // own boards are usually a small part of it.
  if (directory && rooms.size > 50) {
    const all = (await org.list("org:board:")).map((r) => r.value);
    return {
      rows: all.filter((b) => b && rooms.has(b.room)),
      total: all.length,
    };
  }
  return {
    rows: (await perBoard(org, "org:board:", rooms)).filter(Boolean),
    total: null,
  };
}
// Directory search folds text as every other search does
// (src/search-fold.js), so "equipe" finds "équipe" and "l'equipe" finds
// "L’équipe".
// `names` gives the spaces' and teams' names by id, which a search
// matches as people read them on the cards.
export function filterBoards(
  rows,
  filters = {},
  now = Date.now(),
  names = { spaces: new Map(), teams: new Map() },
) {
  const q = fold(text(filters.query, 200));
  const after = (v) => (v ? Date.parse(v) : null);
  const createdAfter = after(filters.createdAfter),
    createdBefore = after(filters.createdBefore),
    updatedAfter = after(filters.updatedAfter),
    updatedBefore = after(filters.updatedBefore);
  let out = rows.filter((b) => {
    if (!filters.deleted && b.deleted) return false;
    if (filters.deleted && !b.deleted) return false;
    if (filters.archived === false && b.archived) return false;
    if (filters.archived === true && !b.archived) return false;
    if (filters.owner && b.owner !== filters.owner) return false;
    if (filters.team && b.team !== filters.team) return false;
    if (filters.space && b.space !== filters.space) return false;
    if (
      filters.visibility &&
      (b.visibility || "private") !== filters.visibility
    )
      return false;
    if (createdAfter && !(b.created >= createdAfter)) return false;
    if (createdBefore && !(b.created <= createdBefore)) return false;
    const updated = b.lastActivity || b.updated || b.created;
    if (updatedAfter && !(updated >= updatedAfter)) return false;
    if (updatedBefore && !(updated <= updatedBefore)) return false;
    if (filters.activity === "active" && !(updated > now - 30 * DAY))
      return false;
    if (filters.activity === "stale" && !(updated < now - 90 * DAY))
      return false;
    if (filters.activity === "unused" && b.objectCount) return false;
    if (filters.type && !(b.types?.[filters.type] > 0)) return false;
    if (filters.guests && !(b.guestCount > 0)) return false;
    if (q) {
      const hay = fold(
        [
          b.title,
          b.ownerName,
          names.teams.get(b.team),
          names.spaces.get(b.space),
          b.text,
        ]
          .filter(Boolean)
          .join(" "),
      );
      if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
    }
    return true;
  });
  out.sort(boardOrder(filters.sort));
  return out;
}
// The order boards are listed in; boards that tie keep the order of their
// ids, so a page can follow the last board shown.
function boardOrder(sort = "updated") {
  // Names sort as people read them: "Planning 2" before "Planning 10",
  // whatever their case or accents.
  const byName = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  }).compare;
  const byRoom = (a, b) => (a.room > b.room) - (a.room < b.room);
  // By id is the one order editing never changes, so an export read a
  // page at a time neither repeats nor misses a board edited meanwhile.
  return (a, b) =>
    (sort === "room"
      ? 0
      : sort === "title"
        ? byName(String(a.title), String(b.title))
        : sort === "created"
          ? b.created - a.created
          : sort === "size"
            ? (b.objectCount || 0) - (a.objectCount || 0)
            : (b.lastActivity || b.updated || b.created) -
              (a.lastActivity || a.updated || a.created)) || byRoom(a, b);
}
// What a page's last board is sorted by, so the next page can follow it.
const BOARD_CURSOR = [
  "room",
  "title",
  "created",
  "objectCount",
  "lastActivity",
  "updated",
];
function boardCursor(b) {
  return JSON.stringify(Object.fromEntries(BOARD_CURSOR.map((k) => [k, b[k]])));
}
function readBoardCursor(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const b = JSON.parse(value);
    return b && typeof b === "object" && typeof b.room === "string" ? b : null;
  } catch {
    return null;
  }
}
const AUDIT_SCAN = 5000;
// Boards one ownership transfer request moves; see org.users.transfer.
const TRANSFER_BATCH = 25;
async function auditQuery(org, input) {
  const limit = Math.max(1, Math.min(500, Number(input.limit) || 100));
  const now = org.now();
  const to = input.to ? Date.parse(input.to) : now;
  // Without a start, the range is the 30 days up to its end.
  let from = input.from ? Date.parse(input.from) : Math.min(to, now) - 30 * DAY;
  if (!Number.isFinite(to) || !Number.isFinite(from) || from > to)
    fail(400, "Invalid date range.");
  const range = { from, to, now };
  // Days before the oldest record hold nothing; skip them instead of reading
  // one empty day at a time.
  const [oldest] = await org.list("org:audit:", { values: false, limit: 1 });
  if (!oldest) return { entries: [], cursor: null, range };
  const first = Date.parse(
    (oldest.key ?? oldest).slice("org:audit:".length).slice(0, 10),
  );
  if (Number.isFinite(first)) from = Math.max(from, first);
  const cursor = typeof input.cursor === "string" ? input.cursor : null;
  const entries = [];
  // A filter that matches little would otherwise read the whole range in
  // one request; past this many records, the page ends early with a cursor
  // to where it stopped.
  let last = null,
    scanned = 0;
  const visit = ({ value }) => {
    if (cursor && value.id >= cursor) return false;
    if (++scanned > AUDIT_SCAN) {
      stopped = true;
      return true;
    }
    last = value.id;
    if (value.at > to || value.at < from) return false;
    if (input.action && !value.action.startsWith(input.action)) return false;
    if (input.category && value.category !== input.category) return false;
    if (input.actor && value.actor?.uuid !== input.actor) return false;
    if (input.board && value.board !== input.board) return false;
    entries.push(value);
    return entries.length >= limit;
  };
  let stopped = false;
  const day = (at) => new Date(at).toISOString().slice(0, 10);
  // A later page starts where the previous one stopped, reading that day
  // hour by hour, instead of skipping every newer record again.
  const resume = cursor ? Date.parse(cursor.slice(0, 24)) : NaN;
  const top = Number.isFinite(resume)
    ? Math.min(to, now, resume)
    : Math.min(to, now);
  const floor = Date.parse(day(from));
  let at = Date.parse(day(top));
  if (at >= floor && Number.isFinite(resume) && resume <= Math.min(to, now)) {
    for (let hour = new Date(top).getUTCHours(); hour >= 0; hour--) {
      const part = `${day(top)}T${String(hour).padStart(2, "0")}`;
      await org.scan("org:audit:" + part, { reverse: true }, visit);
      if (entries.length >= limit || stopped) break;
    }
    at -= DAY;
  }
  for (; at >= floor && entries.length < limit && !stopped; at -= DAY)
    await org.scan("org:audit:" + day(at), { reverse: true }, visit);
  return {
    entries,
    cursor: entries.length >= limit || stopped ? last : null,
    range,
  };
}
async function listKeys(org) {
  const used = new Map(
    (await org.list("org:apikeyused:")).map(({ key, value }) => [
      key.slice("org:apikeyused:".length),
      value,
    ]),
  );
  return (await org.list("org:apikey:")).map(({ key, value }) => {
    const hash = key.slice("org:apikey:".length);
    return {
      ...value,
      lastUsed: Math.max(value.lastUsed || 0, used.get(hash) || 0) || null,
      hash,
    };
  });
}
// Refused API keys are audited, so a SIEM sees probing and keys still in
// use after they ended. The record names a key the worker knows but holds
// nothing of what was sent; a revoked key is deleted, so it counts as
// unknown. At most AUTH_FAILURES are recorded every ten minutes, so a flood
// of bad keys cannot fill storage, and the last one says so. Known keys have
// their own allowance, so a flood of made-up keys cannot hide an expired key,
// or one whose maker no longer administers, being used.
const AUTH_FAILURES = 20;
async function refuseKey(org, status, message, reason, record, scope) {
  try {
    const window = `${record ? "known" : "unknown"}:${Math.floor(org.now() / 600_000)}`;
    const full = (org.instance.authFailures ??= new Map());
    if (!full.has(window)) {
      const counter = "org:authfail:" + window;
      const count = await org.kv.incr(counter);
      if (count === 1) await org.kv.expire(counter, 1200).catch(() => {});
      if (count >= AUTH_FAILURES) {
        if (full.size > 10) full.clear();
        full.set(window, true);
      }
      if (count <= AUTH_FAILURES)
        await org.audit(
          record
            ? {
                uuid: `apikey-${record.id}`,
                username: `API key: ${record.name}`,
              }
            : { uuid: null, username: "Unknown API key" },
          "auth.apikey.failed",
          record
            ? { type: "apikey", id: record.id, name: record.name }
            : { type: "apikey" },
          {
            reason,
            ...(scope && { scope }),
            ...(count === AUTH_FAILURES && { moreNotRecorded: true }),
          },
        );
    }
  } catch {
    /* Auditing never changes the refusal. */
  }
  fail(status, message);
}
// Authenticate a REST or SCIM request's bearer API key.
export async function apiKey(org, bearer, scope) {
  const invalid = "This API key is invalid, expired, or revoked.";
  // A request without a key is not an attempt to use one.
  if (!bearer) fail(401, "A valid API key is required.");
  if (typeof bearer !== "string" || !/^wbk_[a-f0-9]{64}$/.test(bearer))
    await refuseKey(
      org,
      401,
      "A valid API key is required.",
      "malformed",
      null,
      scope,
    );
  const key = "org:apikey:" + (await hash(bearer));
  const record = await org.kv.get(key);
  if (!record) await refuseKey(org, 401, invalid, "unknown", null, scope);
  if (record.revoked)
    await refuseKey(org, 401, invalid, "revoked", record, scope);
  if (record.expires && record.expires < org.now())
    await refuseKey(org, 401, invalid, "expired", record, scope);
  // A key stops working once the person who made it no longer administers
  // the organization, as when an administrator is deactivated or demoted.
  if (record.createdBy && !(await administers(org, record.createdBy)))
    await refuseKey(org, 401, invalid, "creator", record, scope);
  if (scope && !record.scopes.includes(scope))
    await refuseKey(
      org,
      403,
      `This API key does not have the ${scope} scope.`,
      "scope",
      record,
      scope,
    );
  // Use is recorded apart from the key itself, so a request that finishes
  // after the key is revoked cannot write the key back.
  const digest = key.slice("org:apikey:".length),
    used = org.instance.touched,
    last = used.get("apikey:" + digest);
  if (!last || org.now() - last > 3600_000) {
    used.set("apikey:" + digest, org.now());
    await org.kv.set("org:apikeyused:" + digest, org.now());
  }
  return {
    uuid: `apikey-${record.id}`,
    username: `API key: ${record.name}`,
    apiKey: true,
    scopes: record.scopes,
    createdBy: record.createdBy,
  };
}
async function aiRequest(org, identity, input) {
  const policy = await org.policy();
  const task = input.task;
  const feature = {
    summarize: "summaries",
    cluster: "clustering",
    handwriting: "handwriting",
    generate: "summaries",
    describe: "summaries",
  }[task];
  if (!feature) fail(400, "Unknown AI task.");
  if (!policy.ai.enabled || !policy.ai[feature])
    fail(403, "Your organization has turned off this AI feature.");
  // The organization pays for its AI, so guests, including anyone who
  // opened a public link, use their own Puter AI instead.
  const role = await org.role(identity);
  if (!role || role === "guest")
    fail(403, "AI features are available to organization members.");
  const prompt = text(input.prompt, 60_000);
  if (!prompt) fail(400, "Nothing to send to AI.");
  const options = {
    normalize: true,
    ...(policy.ai.model ? { model: policy.ai.model } : {}),
  };
  let path = null,
    response;
  try {
    if (task === "handwriting" || task === "describe") {
      const image = input.image;
      if (
        typeof image !== "string" ||
        image.length > 12_000_000 ||
        !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)
      )
        fail(400, "Choose a PNG, JPEG, or WebP photo.");
      const [, type, data] = /^data:image\/(\w+);base64,(.*)$/.exec(image);
      let bytes;
      try {
        bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      } catch {
        // The alphabet check above also admits invalid padding. Report it
        // before uploading, rather than returning a server error to retry.
        fail(400, "Choose a PNG, JPEG, or WebP photo.");
      }
      path = `whiteboard/ai/${short()}.${type === "jpeg" ? "jpg" : type}`;
      await org.puter.fs.write(
        path,
        new Blob([bytes], { type: `image/${type}` }),
        {
          createMissingParents: true,
          overwrite: true,
        },
      );
      response = await org.puter.ai.chat(
        [
          {
            role: "user",
            content: [
              { type: "file", puter_path: path },
              { type: "text", text: prompt },
            ],
          },
        ],
        false,
        options,
      );
    } else response = await org.puter.ai.chat(prompt, false, options);
  } finally {
    if (path) org.puter.fs.delete(path).catch(() => {});
  }
  const content = response?.message?.content;
  const output =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c) => c.text || "").join("")
        : String(response?.text || response || "");
  await org.audit(
    identity,
    "ai.used",
    {
      type: "board",
      id:
        typeof input.room === "string" && ID.test(input.room)
          ? input.room
          : null,
    },
    {
      task,
    },
  );
  return { text: output.slice(0, 100_000) };
}
function jiraSummary(value) {
  const title = typeof value === "string" ? value.trim() : "";
  let end = Math.min(250, title.length);
  const previous = title.charCodeAt(end - 1),
    next = title.charCodeAt(end);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  )
    end--;
  return title.slice(0, end);
}

async function jira(org, identity, input, boards) {
  const policy = await org.policy();
  const config = policy.integrations.jira;
  if (!config.enabled || !config.site || !config.email || !config.project)
    fail(403, "Jira is not set up for your organization.");
  const secret = await org.secret("jira");
  if (!secret) fail(403, "Jira is not set up for your organization.");
  // The connection reads and creates issues with the organization's
  // credentials, so board guests from outside it cannot use it.
  const role = await org.role(identity);
  if (!role || role === "guest")
    fail(403, "Jira sync is available to organization members.");
  const room = id(input.room);
  await boards.member(room, identity, true);
  const auth = "Basic " + btoa(`${config.email}:${secret}`);
  const base = `https://${config.site}`;
  if (input.op === "org.jira.status") {
    const keys = (Array.isArray(input.keys) ? input.keys : [])
      .filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k))
      .slice(0, 100);
    if (!keys.length) return { issues: [] };
    if (!/^[A-Z][A-Z0-9_]+$/.test(config.project))
      fail(403, "Jira is not set up for your organization.");
    // Board editors can read only the organization's project, not every
    // issue the integration account can see. Jira refuses a whole search
    // that names an issue it no longer has; the issues its refusal names
    // are left out and the rest searched again.
    let asked = keys;
    const found = [];
    for (let attempt = 0; asked.length && attempt < 5; attempt++) {
      const jql = `project = "${config.project}" AND key in (${asked.join(",")})`;
      // Jira answers in pages; every page is read.
      let token = null,
        gone = null;
      found.length = 0;
      do {
        const query = new URLSearchParams({
          jql,
          fields: "status,assignee,duedate,summary",
          maxResults: "100",
          ...(token ? { nextPageToken: token } : {}),
        });
        const res = await org.fetcher(
          `${base}/rest/api/3/search/jql?${query}`,
          {
            headers: { Authorization: auth, Accept: "application/json" },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const named =
            res.status === 400
              ? asked.filter((key) =>
                  (data.errorMessages || []).some(
                    (m) => typeof m === "string" && m.includes(`'${key}'`),
                  ),
                )
              : [];
          if (named.length) {
            gone = new Set(named);
            break;
          }
          // Jira's own reason goes back beside the message, as for
          // creation, so the person or an administrator can fix it.
          const reason = jiraReason(data);
          throw Object.assign(
            Error(
              [401, 403].includes(res.status)
                ? "Jira refused the integration account. Check its email and API token in Organization settings."
                : "Jira did not accept the request.",
            ),
            { status: 502, ...(reason ? { detail: reason } : {}) },
          );
        }
        const data = await res.json();
        found.push(...(data.issues || []));
        token = data.nextPageToken || null;
      } while (token && found.length < asked.length);
      if (!gone) break;
      asked = asked.filter((key) => !gone.has(key));
    }
    return {
      issues: found.map((i) => ({
        key: i.key,
        summary: i.fields?.summary || "",
        status: i.fields?.status?.name || "",
        category: i.fields?.status?.statusCategory?.key || "",
        assignee: i.fields?.assignee?.displayName || "",
        due: i.fields?.duedate || "",
        url: `${base}/browse/${i.key}`,
      })),
    };
  }
  const issues = (Array.isArray(input.issues) ? input.issues : []).slice(0, 50);
  if (!issues.length) fail(400, "Select items to send to Jira.");
  const created = [];
  // Each issue is created on its own, so one that fails, or a slow Jira,
  // never loses the ones already created; the rest wait for another send.
  const started = Date.now();
  for (const issue of issues) {
    if (Date.now() - started > 25_000) {
      created.push({
        item: issue.item || null,
        error: "Jira took too long. Send to Jira again to create the rest.",
      });
      continue;
    }
    // Two people sending the same task at once make one issue: the first
    // request claims it, and the other gets that issue back.
    const item =
      typeof issue.item === "string" && /^[\w-]{1,100}$/.test(issue.item)
        ? issue.item
        : null;
    const madeKey = item && `wb:${room}:jira:${item}`;
    if (madeKey) {
      let made = await org.kv.get(madeKey);
      if (!made && (await org.kv.incr(madeKey + ":claim")) !== 1)
        for (let n = 0; n < 20 && !made; n++) {
          await new Promise((r) => setTimeout(r, 250));
          made = await org.kv.get(madeKey);
        }
      else await org.kv.expire(madeKey + ":claim", 60).catch(() => {});
      if (made?.key) {
        created.push({
          item,
          key: made.key,
          url: `${base}/browse/${made.key}`,
        });
        continue;
      }
    }
    const summary = jiraSummary(issue.summary) || "Whiteboard item";
    const description = text(issue.description, 20000);
    let res;
    try {
      res = await org.fetcher(`${base}/rest/api/3/issue`, {
        method: "POST",
        headers: {
          Authorization: auth,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fields: {
            project: { key: config.project },
            summary,
            issuetype: { name: text(issue.type, 50) || "Task" },
            ...(description
              ? {
                  description: {
                    type: "doc",
                    version: 1,
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: description }],
                      },
                    ],
                  },
                }
              : {}),
            ...(/^\d{4}-\d{2}-\d{2}$/.test(issue.due || "")
              ? { duedate: issue.due }
              : {}),
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      created.push({
        item: issue.item || null,
        error: "Could not reach Jira.",
      });
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      created.push({
        item: issue.item || null,
        error: [401, 403].includes(res.status)
          ? "Jira refused the integration account. Check its email and API token in Organization settings."
          : "Jira did not accept the request.",
        status: res.status,
        // Jira's own reason, such as an issue type the project lacks or a
        // required field, so the person or an administrator can fix it.
        ...(jiraReason(data) ? { detail: jiraReason(data) } : {}),
      });
    else if (typeof data.key !== "string" || !data.key)
      created.push({
        item: issue.item || null,
        error: "Jira did not accept the request.",
      });
    else {
      if (madeKey)
        await org.kv.set(
          madeKey,
          { key: data.key },
          Math.floor((org.now() + 10 * 60_000) / 1000),
        );
      created.push({
        item: issue.item || null,
        key: data.key,
        url: `${base}/browse/${data.key}`,
      });
    }
  }
  await org.audit(
    identity,
    "board.content.jira",
    { type: "board", id: room },
    {
      created: created.filter((c) => c.key).length,
    },
  );
  return { created };
}

// The settings that differ between two policies, as dotted paths such as
// "retention.legalHold".
function changedSettings(before, after, prefix = "") {
  const out = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [a, b] = [before[key], after[key]];
    const nested = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (nested(a) && nested(b))
      out.push(...changedSettings(a, b, prefix + key + "."));
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(prefix + key);
  }
  return out;
}
// The reason Jira gives for refusing a request, from its errorMessages and
// per-field errors.
function jiraReason(data) {
  const messages = [
    ...(Array.isArray(data?.errorMessages) ? data.errorMessages : []),
    ...(data?.errors && typeof data.errors === "object"
      ? Object.values(data.errors)
      : []),
  ].filter((m) => typeof m === "string" && m.trim());
  return text(messages.join(" "), 300);
}
// An endpoint's address as audit records name it. It can carry a token in
// its path or query, and audit records go on to webhooks and the SIEM: only
// its origin is recorded.
function endpointShown(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.origin + (url.href.length > url.origin.length + 1 ? "/…" : "");
  } catch {
    return "…";
  }
}
// The names the app gives a board nobody named, in English and French.
const DEFAULT_TITLES = new Set(["untitled board", "tableau sans titre"]);
// An organization request as the worker answers it. Activity is recorded
// unless access was refused, and once its audit records are written, work
// that was waiting goes out as it does after a board request that saves
// nothing: SIEM records an earlier export left for its interval, webhook
// retries, retention, and scheduled reports.
export async function organizationRequest(org, boards, identity, input) {
  let refused = false;
  try {
    return await adminCall(org, boards, identity, input);
  } catch (error) {
    refused = [401, 403, 404].includes(error.status);
    throw error;
  } finally {
    if (!refused) await org.touch(identity);
    await org.flush();
    await org.scheduledWork().catch(() => {});
    await boards?.scheduledRecounts?.();
  }
}
export async function adminCall(org, boards, identity, input) {
  const op = input.op;
  const admin = () => org.requireAdmin(identity);
  // Organization directory data is for members, not guests or strangers.
  const member = async () => {
    const role = await org.role(identity);
    if (!role || role === "guest")
      fail(403, "Only organization members can do this.");
    return role;
  };
  await org.rememberApp(identity).catch(() => {});
  if (op === "org.info") {
    const user = await org.user(identity.uuid);
    if (user?.role === "guest" && capturable(user, await org.policy()))
      await capture(org, boards, user);
    return org.info(identity);
  }
  // A deactivated account keeps only what it needs to see its status and
  // verify an address; linking an address never lifts the deactivation.
  if (
    !["email.start", "email.confirm"].includes(op) &&
    !(await org.active(identity))
  )
    fail(403, "Your organization account is deactivated.");
  if (op === "org.setup") {
    const owner = await org.accountOwner();
    if (identity.uuid !== owner.uuid)
      fail(403, "Only the account owner can set up the organization.");
    let meta = await org.kv.get("org:meta");
    if (!meta) {
      const policy = mergePolicy(normalizePolicy(), {
        name: input.name,
        domains: input.domains || [],
      });
      meta = { created: org.now(), owner: owner.uuid, policy };
      // Register earlier boards first: the backfill skips boards already
      // registered, so an interrupted setup resumes where it stopped.
      await boards.backfillRegistry();
      await org.saveMeta(meta);
      await org.audit(identity, "org.created", {
        type: "organization",
        name: policy.name,
      });
    }
    return org.info(identity);
  }
  if (op === "org.join") {
    const before = await org.freshUser(identity.uuid);
    const user = await joinOrganization(org, identity, input);
    await recountIfJoined(boards, before, user);
    return { user: publicUser(user), info: await org.info(identity) };
  }
  if (op === "email.start") {
    const email = text(input.email, 254).toLowerCase();
    if (!validEmail(email)) fail(400, "Enter a valid email address.");
    managedAddress(await org.freshUser(identity.uuid), email);
    // Whether another account holds the address is said only once its code
    // proves the mailbox is theirs: told before, anyone could ask about any
    // address in the domains.
    await requireVerifiable(org, identity, email);
    const key = "org:verify:" + identity.uuid;
    const prior = await org.kv.get(key);
    const window = prior && prior.window > org.now() - 3600_000 ? prior : null;
    if (window && window.sent >= 5)
      fail(429, "Too many verification emails. Try again in an hour.");
    // Parallel requests all read the same count above, so each hour's
    // sends are also counted atomically.
    const hour = `org:verify-sent:${identity.uuid}:${Math.floor(org.now() / 3600_000)}`;
    const sends = await org.kv.incr(hour);
    if (sends === 1) await org.kv.expire(hour, 7200).catch(() => {});
    if (sends > 5)
      fail(429, "Too many verification emails. Try again in an hour.");
    // Counted per address too, so many accounts cannot flood one inbox.
    const address = await hash(email),
      addressSends = `org:verify-address-sent:${address}:${Math.floor(org.now() / 3600_000)}`;
    const toAddress = await org.kv.incr(addressSends);
    if (toAddress === 1)
      await org.kv.expire(addressSends, 7200).catch(() => {});
    if (toAddress > 10)
      fail(429, "Too many verification emails. Try again in an hour.");
    // Anyone outside the organization, with any address in its domains,
    // could otherwise have codes sent from many accounts at the owner's
    // expense; the whole organization's are counted too.
    if (await joinsByVerifying(org, identity)) {
      const all = `org:verify-outside-sent:${Math.floor(org.now() / 3600_000)}`;
      const total = await org.kv.incr(all);
      if (total === 1) await org.kv.expire(all, 7200).catch(() => {});
      if (total > OUTSIDE_SENDS)
        fail(429, "Too many verification emails. Try again in an hour.");
    }
    const code = String(
      crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000,
    ).padStart(6, "0");
    await org.kv.del("org:verify-tries:" + identity.uuid);
    await org.kv.set(
      key,
      {
        email,
        code: await hash(`${identity.uuid}:${code}`),
        expires: org.now() + 15 * 60_000,
        window: window?.window || org.now(),
        sent: (window?.sent || 0) + 1,
      },
      { disableSharing: true },
    );
    // Saying a code was sent when none was would leave the person
    // waiting for it and spending their sends on retries.
    let sent = false;
    try {
      const result = await mail(
        org,
        email,
        bilingualSubject(
          "Your Whiteboard verification code",
          "Votre code de vérification Whiteboard",
        ),
        bilingualBody(
          `Your verification code is ${code}. It expires in 15 minutes.\n\nIf you did not request this, ignore this message.`,
          `Votre code de vérification est ${code}. Il expire dans 15 minutes.\n\nSi vous n’avez pas fait cette demande, ignorez ce message.`,
        ),
      );
      sent = delivered(result, email);
    } catch {
      // Refused below, as for an address Puter did not deliver to.
    }
    if (!sent)
      fail(
        502,
        "The verification email could not be sent. Ask your administrator to check the organization's Puter plan.",
      );
    await org.audit(
      identity,
      "email.verification.sent",
      { type: "user", id: identity.uuid },
      {
        domain: emailDomain(email),
      },
    );
    return { sent: true };
  }
  if (op === "email.confirm") {
    const key = "org:verify:" + identity.uuid;
    const pending = await org.kv.get(key);
    if (!pending || pending.expires < org.now())
      fail(400, "This code expired. Request a new one.");
    // Counted atomically, so parallel guesses cannot exceed the limit.
    const tries = "org:verify-tries:" + identity.uuid;
    if ((await org.kv.incr(tries)) > 5)
      fail(429, "Too many attempts. Request a new code.");
    // Each new code allows five more tries, so guesses at one address are
    // also limited across every account, keeping its codes out of reach.
    const guesses = `org:verify-address-tries:${await hash(pending.email)}:${Math.floor(org.now() / 3600_000)}`;
    const guessed = await org.kv.incr(guesses);
    if (guessed === 1) await org.kv.expire(guesses, 7200).catch(() => {});
    if (guessed > 20) fail(429, "Too many attempts. Try again in an hour.");
    // Wrong codes from people a code would bring into the organization are
    // counted across it as well: each guess is one in a million, but many
    // accounts guessing at invented addresses would otherwise be limited
    // only by how many accounts they made.
    // Once that many are wrong, only accounts that guessed wrong this hour
    // are held back, so a few accounts guessing cannot keep everyone else,
    // such as a new colleague with the right code, from joining.
    const hour = Math.floor(org.now() / 3600_000);
    const outside =
      (await joinsByVerifying(org, identity)) &&
      `org:verify-outside-wrong:${hour}`;
    const mine = `org:verify-wrong:${identity.uuid}:${hour}`;
    if (
      outside &&
      Number(await org.kv.get(outside)) >= OUTSIDE_WRONG_CODES &&
      Number(await org.kv.get(mine)) > 0
    )
      fail(429, "Too many attempts. Try again in an hour.");
    if (
      (await hash(`${identity.uuid}:${text(input.code, 10)}`)) !== pending.code
    ) {
      if (outside) {
        if ((await org.kv.incr(outside)) === 1)
          await org.kv.expire(outside, 7200).catch(() => {});
        if ((await org.kv.incr(mine)) === 1)
          await org.kv.expire(mine, 7200).catch(() => {});
      }
      fail(400, "That code is not correct.");
    }
    await org.kv.del(key);
    await org.kv.del(tries);
    const before = await org.freshUser(identity.uuid);
    let deactivated = false;
    let user = await linkEmail(org, identity, pending.email, {
      onDeactivated: () => {
        deactivated = true;
      },
    });
    if (!user) {
      await requireVerifiable(org, identity, pending.email, {
        confirmed: true,
      });
      const isOwner = (await org.accountOwner()).uuid === identity.uuid;
      user = {
        uuid: identity.uuid,
        username: identity.username,
        email: pending.email,
        emailVerified: true,
        // The owner's record only holds its email; its role is implicit.
        ...(isOwner ? {} : { role: "guest", license: "guest" }),
        status: "active",
        created: org.now(),
        source: "email",
        teams: [],
      };
      await org.saveUser(user);
    }
    await org.audit(
      identity,
      "email.verified",
      { type: "user", id: identity.uuid },
      {
        domain: emailDomain(pending.email),
      },
    );
    if (deactivated) await boards.revokeSessions(identity.uuid);
    const policy = await org.policy();
    if (
      policy.domainCapture &&
      inDomains(pending.email, policy.domains) &&
      (user.role === "guest" || !user.role) &&
      user.status === "active"
    )
      user = await joinOrganization(org, identity, {});
    // Linking a provisioned address can make a guest a member as well.
    await recountIfJoined(boards, before, user);
    return { user: publicUser(user), info: await org.info(identity) };
  }
  if (op === "notifications.list") {
    const rows = await org.list(`org:notif:${identity.uuid}:`, {
      reverse: true,
      limit: Math.min(200, Number(input.limit) || 50),
    });
    const items = rows.map((r) => r.value);
    return { items, unread: items.filter((n) => !n.read).length };
  }
  if (op === "notifications.read") {
    const ids = input.all ? null : new Set((input.ids || []).slice(0, 200));
    // Chosen notifications are among the newest shown; reading all goes
    // through every one kept, up to 500 changes a request, and says when
    // more are left so the app asks again.
    const unread = (
      await org.list(`org:notif:${identity.uuid}:`, {
        reverse: true,
        ...(ids ? { limit: 200 } : {}),
      })
    ).filter(({ value }) => !value.read && (!ids || ids.has(value.id)));
    const now = unread.slice(0, 500);
    for (let n = 0; n < now.length; n += 25)
      await Promise.all(
        now
          .slice(n, n + 25)
          .map(({ key, value }) =>
            org.kv.set(
              key,
              { ...value, read: true },
              Math.floor((value.at + 90 * DAY) / 1000),
            ),
          ),
      );
    return { ok: true, more: unread.length > now.length };
  }
  if (op === "prefs.set") {
    const user = await org.freshUser(identity.uuid);
    if (!user) fail(404, "Join the organization to save preferences.");
    const prefs = {
      ...(user.prefs || {}),
      ...("emailNotifications" in input
        ? { emailNotifications: !!input.emailNotifications }
        : {}),
    };
    await org.updateUser(user.uuid, { prefs });
    return { prefs };
  }
  if (op === "org.boards") {
    const scope = input.scope || "mine";
    let rows,
      total = null;
    if (scope === "all") {
      await admin();
      rows = (await org.list("org:board:")).map((r) => r.value);
      total = rows.length;
    } else {
      const mine = new Map(
        (await org.list(`org:ub:${identity.uuid}:`)).map((r) => [
          r.key.split(":").at(-1),
          r.value,
        ]),
      );
      const rooms = new Set(mine.keys());
      const role = scope === "organization" && (await org.role(identity));
      if (role && role !== "guest") {
        for (const row of await org.list("org:visible:", { values: false }))
          rooms.add(
            (typeof row === "string" ? row : row.key).split(":").at(-1),
          );
        // So are the boards that give the person's teams a role.
        for (const team of (await org.user(identity.uuid))?.teams || [])
          for (const row of await org.list(`org:teamboard:${team}:`, {
            values: false,
          }))
            rooms.add(
              (typeof row === "string" ? row : row.key).split(":").at(-1),
            );
      }
      const found = await boardRows(org, rooms, scope !== "mine");
      total = found.total;
      rows = found.rows.map((b) => ({
        ...b,
        role: mine.get(b.room) || null,
      }));
    }
    // A search of only spaces searches for nothing: it reads no board's
    // text and checks no access beyond what listing does.
    const searching = !!text(input.query, 200) && !!input.content;
    if (searching) {
      // Each board keeps only the searched words its text holds, which is
      // all the matching below needs, rather than up to 32 KB of text per
      // board for the whole request.
      const words = fold(text(input.query, 200)).split(/\s+/).filter(Boolean);
      // A board found by what it holds rather than by its name also keeps
      // the words around the first searched word its name lacks, so its
      // card can say where the board matched.
      const titles = new Map(rows.map((b) => [b.room, fold(String(b.title))]));
      const found = (content, room) => {
        const hay = fold(content || ""),
          held = words.filter((word) => hay.includes(word)),
          title = titles.get(room),
          word = title !== undefined && held.find((w) => !title.includes(w)),
          around = word && wordContext(content, word, hay.indexOf(word));
        return {
          text: held.join(" "),
          snippet: around
            ? Object.fromEntries(
                Object.entries(around).map(([k, v]) => [
                  k,
                  v.replace(/\s+/g, " "),
                ]),
              )
            : null,
        };
      };
      // Every board's content is searched: when the boards are much of the
      // directory the index is read in pages, others read their own
      // entries, so a few boards never read every board's text.
      if (total && rows.length > 50 && rows.length * 4 >= total) {
        const index = new Map();
        let cursor;
        do {
          const page = await org.page({
            pattern: "org:idx:",
            returnValues: true,
            limit: 1000,
            ...(cursor ? { cursor } : {}),
          });
          for (const r of Array.isArray(page) ? page : page.items) {
            const room = r.key.slice("org:idx:".length);
            index.set(room, found(r.value, room));
          }
          cursor = page.cursor;
        } while (cursor);
        for (const b of rows)
          Object.assign(b, index.get(b.room) || { text: "", snippet: null });
      } else {
        const texts = await perBoard(
          org,
          "org:idx:",
          rows.map((b) => b.room),
        );
        rows.forEach((b, n) => Object.assign(b, found(texts[n], b.room)));
      }
    }
    const role = await org.role(identity);
    const insider = !!role && role !== "guest",
      administers = role === "owner" || role === "admin";
    // Only administrators see boards in the trash.
    const policy = await org.policy();
    // A member's search finds boards by the names of their space and team.
    // Those names are member data, which guests are not told, so their
    // searches do not match them.
    const named = async (prefix) =>
      new Map(
        text(input.query, 200) && insider
          ? (await org.list(prefix))
              .filter((r) => r.value)
              .map((r) => [r.value.id, r.value.name])
          : [],
      );
    let matched = filterBoards(
      rows.map((b) => listedBoard(b, org.now(), policy)),
      administers ? input : { ...input, deleted: false },
      org.now(),
      { spaces: await named("org:space:"), teams: await named("org:team:") },
    );
    // Matching a board's content tells what is on it, so a person whose
    // access ended (removed, an expired guest, or guests turned off) finds
    // only the boards they can still open. Guests see only those at all,
    // even by title. Administrators open every board. Members can still
    // join boards shared with the organization that they have not opened
    // yet.
    // Members can also join boards that give their team a role, unless a
    // manager removed them; someone whose access came with how a board was
    // shared comes in again the way it is shared now. Someone who has left
    // a board's team can still be listed with the role it gave them, so
    // those boards are checked as for a search.
    // Each batch's access records are read together first, so checking
    // each board reads nothing more.
    const account = administers ? null : await org.user(identity.uuid);
    const canOpen = (b, member) =>
      boards.member(b.room, identity).then(
        () => true,
        () =>
          insider &&
          ((b.visibility === "organization" && !member) ||
            (teamGrants(b, account) && (!member || !!member.via))),
      );
    const doubtful = (b) =>
      b.teamRole !== "none" && b.role && !teamGrants(b, account);
    const checked = administers
      ? []
      : searching || !insider
        ? matched
        : matched.filter(doubtful);
    if (checked.length) {
      const shut = new Set();
      for (let n = 0; n < checked.length; n += 300) {
        const batch = checked.slice(n, n + 300);
        const members = await boards.accessMany(
          batch.map((b) => b.room),
          identity,
        );
        const open = await Promise.all(
          batch.map((b, i) => canOpen(b, members[i])),
        );
        batch.forEach((b, i) => open[i] || shut.add(b));
      }
      matched = matched.filter((b) => !shut.has(b));
    }
    // A page of the matching boards, with how many matched in all. A page
    // can follow the last board shown (`after`, the `next` of the page
    // before), so a board edited meanwhile, which moves to the top in
    // order of activity, does not shift the rest into a page shown again.
    const offset = Math.max(0, Math.floor(Number(input.offset) || 0)),
      limit = Math.max(
        1,
        Math.min(1000, Math.floor(Number(input.limit)) || 200),
      );
    const last = readBoardCursor(input.after);
    const order = boardOrder(input.sort);
    const rest = last ? matched.filter((b) => order(b, last) > 0) : matched;
    const start = last ? 0 : offset;
    const boardsOut = rest.slice(start, start + limit);
    const next =
      rest.length > start + limit ? boardCursor(boardsOut.at(-1)) : null;
    for (const b of boardsOut) {
      delete b.text;
      if (!b.snippet) delete b.snippet;
      // Legal holds, who edited last, and a digest of the content are for
      // the board's administrators, as the board itself tells only its
      // managers.
      if (!administers)
        for (const key of ["legalHold", "lastEditor", "fingerprint", "purging"])
          delete b[key];
    }
    return { boards: boardsOut, total: matched.length, offset, next };
  }
  if (op === "org.boards.duplicates") {
    await admin();
    const rows = (await org.list("org:board:"))
      .map((r) => r.value)
      .filter((b) => !b.deleted);
    const groups = new Map();
    for (const b of rows) {
      // A copy's suffix, in either language, does not make a new name, nor
      // do case, accents, apostrophes or spacing, as in a search; a board
      // nobody named shares its default name with every other one, so that
      // name is no sign of a duplicate.
      const title = fold(String(b.title || ""))
        .trim()
        .replace(/\s+/g, " ")
        .replace(/(\s*\((copy|copie)\))+$/, "");
      const keys = [
        b.fingerprint && b.objectCount ? "content:" + b.fingerprint : null,
        title && !DEFAULT_TITLES.has(title) ? "title:" + title : null,
      ].filter(Boolean);
      for (const key of keys) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(b);
      }
    }
    // The largest sets first, each listing its first fifty boards with how
    // many it holds in all.
    return {
      groups: [...groups]
        .filter(([, list]) => list.length > 1)
        .sort(([, a], [, b]) => b.length - a.length)
        .map(([key, list]) => ({
          reason: key.startsWith("content:") ? "same content" : "same title",
          count: list.length,
          boards: list.slice(0, 50).map((b) => ({
            room: b.room,
            title: b.title,
            owner: b.owner,
            ownerName: b.ownerName,
            objectCount: b.objectCount || 0,
            lastActivity: b.lastActivity || b.created,
          })),
        }))
        .slice(0, 200),
    };
  }
  if (op === "library.list") {
    const role = await member();
    const rows = (await org.list("org:lib:")).map((r) => r.value);
    const isAdmin = role === "owner" || role === "admin";
    return {
      items: rows
        .filter(
          (i) =>
            i.status === "approved" || isAdmin || i.createdBy === identity.uuid,
        )
        // Administrators and the person who shared an item may remove it.
        .map((i) => ({
          ...i,
          canRemove: isAdmin || i.createdBy === identity.uuid,
        })),
      canPublish: isAdmin,
    };
  }
  if (op === "library.get") {
    const item = await org.kv.get("org:lib:" + id(input.id));
    const role = await member();
    if (!item) fail(404, "Library item not found.");
    if (
      item.status !== "approved" &&
      role !== "owner" &&
      role !== "admin" &&
      item.createdBy !== identity.uuid
    )
      fail(403, "This item is awaiting approval.");
    return { item, board: await (await org.puter.fs.read(item.file)).text() };
  }
  if (op === "library.submit") {
    const role = await org.role(identity);
    if (!role || role === "guest")
      fail(403, "Only organization members can share library content.");
    if (typeof input.board !== "string" || input.board.length > 12_000_000)
      fail(413, "This content is too large for the library.");
    // Content the library cannot hold is refused for good, not reported as
    // a failure worth retrying.
    try {
      validateBoard(JSON.parse(input.board));
    } catch (error) {
      fail(422, error.message || "This change was rejected.");
    }
    // Validate language before writing the template or creating a record.
    const description = libraryDescription(input);
    const itemId = short();
    const file = `whiteboard/library/${itemId}.json`;
    await org.puter.fs.write(file, input.board, {
      createMissingParents: true,
      overwrite: true,
    });
    const isAdmin = role === "owner" || role === "admin";
    const item = {
      id: itemId,
      name: text(input.name, 120) || "Untitled",
      ...description,
      category: text(input.category, 60) || "General",
      kind: input.kind === "component" ? "component" : "template",
      status: isAdmin ? "approved" : "pending",
      createdBy: identity.uuid,
      createdByName: identity.username,
      created: org.now(),
      file,
    };
    await org.kv.set("org:lib:" + itemId, item);
    await org.audit(
      identity,
      "library.submitted",
      { type: "library", id: itemId, name: item.name },
      {
        status: item.status,
      },
    );
    return { item };
  }
  if (op === "library.approve" || op === "library.remove") {
    const item = await org.kv.get("org:lib:" + id(input.id));
    if (!item) fail(404, "Library item not found.");
    // Creators remove their own items while they are still members.
    if (op === "library.remove")
      await (item.createdBy === identity.uuid ? member() : admin());
    if (op === "library.approve") await admin();
    if (op === "library.remove") {
      await org.kv.del("org:lib:" + item.id);
      await org.puter.fs.delete(item.file).catch(() => {});
    } else
      await org.kv.set("org:lib:" + item.id, {
        ...item,
        status: "approved",
        approvedBy: identity.uuid,
        approved: org.now(),
      });
    await org.audit(
      identity,
      op === "library.approve" ? "library.approved" : "library.removed",
      {
        type: "library",
        id: item.id,
        name: item.name,
      },
    );
    return { ok: true };
  }
  if (op === "spaces.list") {
    await member();
    return { spaces: (await org.list("org:space:")).map((r) => r.value) };
  }
  if (op === "spaces.create" || op === "spaces.delete") {
    const role = await org.role(identity);
    if (!role || role === "guest")
      fail(403, "Only organization members can manage spaces.");
    if (op === "spaces.delete") {
      await admin();
      const spaceId = id(input.id);
      const space = await org.kv.get("org:space:" + spaceId);
      // Its boards are in no space now, rather than in one nobody can see,
      // choose or search by name. They are taken out first, so a delete
      // that fails partway leaves the space listed to delete again.
      for (const r of await org.list("org:board:"))
        if (r.value?.space === spaceId)
          await org.registerBoard(r.value.room, { space: null });
      await org.kv.del("org:space:" + spaceId);
      if (space)
        await org.audit(identity, "space.deleted", {
          type: "space",
          id: spaceId,
          name: space.name,
        });
      return { ok: true };
    }
    const name = text(input.name, 80) || "Untitled space";
    // Two spaces with one name cannot be told apart where boards are filed
    // or filtered, so a name already used, in any case, is refused.
    const taken = (await org.list("org:space:")).some(
      (r) => r.value?.name?.trim().toLowerCase() === name.toLowerCase(),
    );
    if (taken) fail(409, "A space with this name already exists.");
    const space = {
      id: short(),
      name,
      team: input.team ? id(input.team) : null,
      created: org.now(),
      createdBy: identity.uuid,
    };
    await org.kv.set("org:space:" + space.id, space);
    await org.audit(identity, "space.created", {
      type: "space",
      id: space.id,
      name: space.name,
    });
    return { space };
  }
  if (op === "feedback.submit") {
    const ease = Number(input.ease);
    if (!Number.isInteger(ease) || ease < 1 || ease > 5)
      fail(400, "Choose a rating from 1 to 5.");
    const role = await org.role(identity);
    if (!role) fail(403, "Only people in the organization can send feedback.");
    const at = org.now(),
      iso = new Date(at).toISOString();
    // A few submissions an hour is plenty for one person; each hour's are
    // counted atomically, as parallel requests would all read one count.
    const hour = `org:feedback-sent:${identity.uuid}:${Math.floor(at / 3600_000)}`;
    const sends = await org.kv.incr(hour);
    if (sends === 1) await org.kv.expire(hour, 7200).catch(() => {});
    if (sends > 10)
      fail(429, "Too much feedback at once. Try again in an hour.");
    // No account identifier is stored with the rating and authored comment.
    await org.kv.set(
      `org:feedback:${iso}:${short()}`,
      {
        at,
        ease,
        role,
        ...feedbackComment(input),
        context: text(input.context, 40) || null,
      },
      Math.floor((at + 400 * DAY) / 1000),
    );
    return { ok: true };
  }
  if (op === "teams.list") {
    await member();
    return { teams: (await org.list("org:team:")).map((r) => r.value) };
  }
  if (op === "org.ai") return aiRequest(org, identity, input);
  if (op === "org.jira.create" || op === "org.jira.status")
    return jira(org, identity, input, boards);

  // Everything below is administration.
  const role = await admin();
  if (op === "org.policy.get") {
    const meta = await org.meta();
    const secrets = {};
    for (const name of ["slack", "jira", "sentinel", "siem-token"])
      secrets[name] = !!(await org.secret(name));
    return {
      policy: meta?.policy || normalizePolicy(),
      secrets,
      siem: (await org.kv.get("org:siem:status")) || null,
      slack: await slackStatus(org, null, await org.secret("slack")),
      owner: await org.accountOwner(),
      platform: {
        saml: false,
        scim: true,
        mfaSignal: false,
        note: "SAML single sign-on is provided by the Puter account platform. Puter enforces multifactor authentication at sign-in.",
      },
    };
  }
  if (op === "org.policy.set") {
    const meta = (await org.kv.get("org:meta")) || {
      created: org.now(),
      owner: (await org.accountOwner()).uuid,
    };
    const before = normalizePolicy(meta.policy);
    const policy = mergePolicy(before, input.policy || {});
    if (policy.ai.model !== undefined) delete policy.ai.model;
    if (typeof input.policy?.ai?.model === "string")
      policy.ai.model = text(input.policy.ai.model, 100);
    else if (before.ai.model) policy.ai.model = before.ai.model;
    if (policy.mfaRequired && !before.mfaRequired)
      fail(
        400,
        "Puter enforces multifactor authentication at sign-in, so there is nothing to turn on here.",
      );
    const secrets =
      input.secrets && typeof input.secrets === "object" ? input.secrets : {};
    // Every secret is checked before anything is saved, so a rejected
    // request never leaves a policy change behind without an audit record.
    for (const [name, value] of Object.entries(secrets)) {
      if (!SECRETS.has(name)) fail(400, "Unknown integration secret.");
      if (
        name === "slack" &&
        typeof value === "string" &&
        value &&
        !/^https:\/\/hooks\.slack\.com\//.test(value)
      )
        fail(400, "Enter a Slack incoming webhook URL.");
    }
    // The stored bearer token only ever goes to the endpoint it was entered
    // for; moving the endpoint elsewhere needs the token again. Clearing the
    // endpoint sends the token nowhere. A value that is not text changes
    // nothing below, so it does not count as entering the token again.
    const origin = (url) => (url ? new URL(url).origin : "");
    if (
      policy.siem.url &&
      origin(policy.siem.url) !== origin(before.siem.url) &&
      typeof secrets["siem-token"] !== "string" &&
      secrets["siem-token"] !== null &&
      (await org.secret("siem-token"))
    )
      fail(400, "Enter the bearer token again for the new endpoint.");
    meta.policy = policy;
    await org.saveMeta(meta);
    for (const [name, value] of Object.entries(secrets)) {
      if (value !== null && typeof value !== "string") continue;
      await org.setSecret(name, value ? value.slice(0, 4096) : null);
    }
    // The record says which settings changed, and from what to what, so
    // releasing a legal hold reads differently from shortening retention.
    // Secrets are named, never shown, and only those actually written.
    const changed = changedSettings(before, policy);
    const at = (object, path) =>
      endpointShown(
        path.split(".").reduce((value, key) => value?.[key], object),
      );
    await org.audit(
      identity,
      "policy.updated",
      { type: "organization", name: policy.name },
      {
        changed,
        from: Object.fromEntries(changed.map((p) => [p, at(before, p)])),
        to: Object.fromEntries(changed.map((p) => [p, at(policy, p)])),
        secretsChanged: Object.keys(secrets).filter(
          (name) => secrets[name] === null || typeof secrets[name] === "string",
        ),
      },
    );
    if (
      policy.domainCapture &&
      (!before.domainCapture ||
        policy.domains.some((d) => !before.domains.includes(d)))
    ) {
      const guests = (await org.list("org:user:"))
        .map((row) => row.value)
        .filter((user) => capturable(user, policy));
      for (const user of guests.slice(0, CAPTURE_BATCH))
        await capture(org, boards, user);
    }
    return { policy };
  }
  if (op === "org.users.list") {
    const rows = (await org.withActivity(await org.members())).map(publicUser);
    const owner = await org.accountOwner();
    const q = text(input.query, 100).toLowerCase();
    return {
      owner,
      users: rows.filter(
        (u) =>
          (!input.role || u.role === input.role) &&
          (!input.status || u.status === input.status) &&
          (!q ||
            [u.username, u.email]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(q)),
      ),
    };
  }
  if (op === "org.users.update") {
    const uuid = id(input.uuid);
    const owner = await org.accountOwner();
    if (uuid === owner.uuid)
      fail(400, "The account owner's role cannot change.");
    const user = await org.freshUser(uuid);
    if (!user) fail(404, "User not found.");
    const original = { ...user };
    const before = {
      role: user.role,
      status: user.status,
      active: user.active !== false,
    };
    if (input.role !== undefined) {
      if (!ORG_ROLES.includes(input.role) || input.role === "owner")
        fail(400, "Invalid organization role.");
      if (input.role === "admin" && role !== "owner")
        fail(403, "Only the account owner can appoint administrators.");
      if (user.role === "admin" && role !== "owner")
        fail(403, "Only the account owner can change an administrator.");
      if (user.role !== input.role) user.roleChanged = org.now();
      user.role = input.role;
      user.license = input.role === "guest" ? "guest" : "full";
    }
    if (input.status !== undefined) {
      if (!["active", "deactivated"].includes(input.status))
        fail(400, "Invalid account status.");
      // Someone provisioned or migrated who has not signed in yet keeps
      // the pending status; deactivating them means they arrive
      // deactivated, as SCIM does it.
      const pending = user.status === "pending";
      const current = pending
        ? before.active
          ? "active"
          : "deactivated"
        : user.status;
      // An API key the account owner made acts for the owner here, as it
      // does over SCIM, so offboarding automation reaches administrators
      // too; it still never appoints one.
      const ownerKey = !!identity.apiKey && identity.createdBy === owner.uuid;
      if (
        before.role === "admin" &&
        role !== "owner" &&
        !ownerKey &&
        input.status !== current
      )
        fail(403, "Only the account owner can change an administrator.");
      if (!pending) {
        user.status = input.status;
        // Someone the identity provider deleted and an administrator lets
        // back in is listed to it again, so its lookups and deprovisioning
        // still reach them.
        // An address the provider has since given to someone else stays
        // theirs: the account is listed again only while it still holds
        // its address, so no two listed people share a userName.
        if (
          input.status === "active" &&
          user.scimDeleted &&
          (!user.email ||
            (await org.kv.get("org:email:" + (await hash(user.email)))) ===
              uuid)
        ) {
          delete user.scimDeleted;
          if (user.scimId) await org.kv.set("org:scimid:" + user.scimId, uuid);
        }
      } else if (input.status === "active") {
        user.active = true;
        delete user.inactiveByOwner;
      } else {
        user.active = false;
        if (role === "owner" || ownerKey) user.inactiveByOwner = true;
      }
    }
    // Only what this request changed is written, so a team change or a
    // preference saved meanwhile is kept.
    const changed = Object.fromEntries(
      [
        "role",
        "license",
        "roleChanged",
        "status",
        "active",
        "inactiveByOwner",
        "scimDeleted",
      ]
        .filter((field) => user[field] !== original[field])
        .map((field) => [field, user[field]]),
    );
    if (Object.keys(changed).length)
      await org.updateUser(uuid, changed, { access: true });
    if (before.role !== user.role)
      await org.audit(
        identity,
        "user.role.changed",
        { type: "user", id: uuid, name: user.username },
        {
          from: before.role,
          to: user.role,
        },
      );
    if (before.status !== user.status) {
      await org.audit(
        identity,
        user.status === "deactivated" ? "user.deactivated" : "user.reactivated",
        { type: "user", id: uuid, name: user.username },
      );
      if (user.status === "deactivated") await boards.revokeSessions(uuid);
    } else if (
      user.status === "pending" &&
      before.active !== (user.active !== false)
    )
      await org.audit(
        identity,
        user.active === false ? "user.deactivated" : "user.reactivated",
        { type: "user", id: uuid, name: user.email },
        { pending: true },
      );
    // Board statistics come last: a refusal while counting must not leave
    // the change above unrecorded, or a deactivated person's sessions live.
    if ((before.role === "guest") !== (user.role === "guest"))
      await boards.recountBoardsOf(uuid).catch(() => {});
    return { user: publicUser(user) };
  }
  if (op === "migration.apply") {
    // The organization's Miro import setting holds here too, not only in
    // the app that offers the migration.
    if ((await org.policy()).integrations.miro?.enabled === false)
      fail(403, "Your organization has turned off Miro imports.");
    // Preserve a migrated board's ownership and permissions by email.
    const room = id(input.room);
    const meta = await org.kv.get(`wb:${room}:meta`);
    if (!meta) fail(404, "Board not found.");
    const members = (Array.isArray(input.members) ? input.members : []).slice(
      0,
      2000,
    );
    const applied = [],
      skipped = [],
      roles = new Map();
    let guests = 0;
    // Whoever is outside the organization's own domains comes in as a
    // guest, whatever the migration was told; subdomains count as inside.
    const { domains } = await org.policy();
    const outside = (email) => domains.length > 0 && !inDomains(email, domains);
    let owner = null;
    for (const m of members) {
      const email = text(m.email, 254).toLowerCase();
      if (!validEmail(email)) {
        skipped.push({ email: m.email || null, reason: "missing email" });
        continue;
      }
      const guest = !!m.guest || outside(email);
      const user = await accountForEmail(org, email, {
        name: m.name,
        guest,
        source: "migration",
      });
      const role = [
        "owner",
        "facilitator",
        "editor",
        "commenter",
        "viewer",
      ].includes(m.role)
        ? m.role
        : "viewer";
      if (role === "owner") {
        owner = user;
        continue;
      }
      await boards.setMember(room, {
        uuid: user.uuid,
        username: user.username || user.displayName || email,
        role,
        ...(guest ? { guest: true } : {}),
        joined: org.now(),
        source: "migration",
      });
      roles.set(user.uuid, role);
      applied.push({ email, role, pending: user.status === "pending" });
      // Counted as guests here by the organization's record: someone the
      // migration calls a guest who is a member here is not one.
      if (user.role === "guest") guests++;
    }
    const warnings = [];
    // Guests keep their place on the board, which they take up as soon as
    // the policy admits guests; until then the log says why they cannot.
    if (guests && guestsShutOut(await org.policy()))
      warnings.push(
        `${guests} ${guests === 1 ? "guest from Miro was" : "guests from Miro were"} added, but your organization does not admit guests now, so they cannot open this board until its policy does.`,
      );
    // Boards belong to active members. A Miro owner who is a guest here, or
    // whose account is deactivated, keeps running the board as facilitator,
    // and the administrator migrating it keeps ownership until it is handed
    // to a member.
    if (
      owner &&
      (owner.role === "guest" || owner.status === "deactivated") &&
      owner.uuid !== (await org.accountOwner()).uuid
    ) {
      await boards.setMember(room, {
        uuid: owner.uuid,
        username: owner.username || owner.displayName || owner.email,
        role: "facilitator",
        ...(owner.role === "guest" ? { guest: true } : {}),
        joined: org.now(),
        source: "migration",
      });
      applied.push({
        email: owner.email,
        role: "facilitator",
        pending: owner.status === "pending",
      });
      warnings.push(
        `The Miro owner ${owner.email} is ${owner.role === "guest" ? "a guest" : "deactivated"} here, so they are a facilitator and ownership stays with you until you transfer it to a member.`,
      );
      owner = null;
    }
    if (owner) {
      if (!(await org.kv.get(`wb:${room}:member:${owner.uuid}`)))
        await boards.setMember(room, {
          uuid: owner.uuid,
          username: owner.username || owner.displayName || owner.email,
          role: "facilitator",
        });
      await boards.transfer(room, identity, owner.uuid, { admin: true });
      applied.push({
        email: owner.email,
        role: "owner",
        pending: owner.status === "pending",
      });
      // The administrator running the migration keeps governance access
      // without appearing as a participant the source board never had; one
      // who was a member there keeps that board role.
      const self = await org.kv.get(`wb:${room}:member:${identity.uuid}`);
      if (self && self.uuid !== owner.uuid)
        await boards.setMember(room, {
          ...self,
          role: roles.get(identity.uuid) || "removed",
        });
    }
    // Who could open the board in Miro without being invited. Access for
    // everyone in the Miro organization carries over; team and public link
    // access would reach more people here, so they are only reported.
    const sharing =
      input.source && typeof input.source === "object"
        ? input.source.sharing || {}
        : {};
    const ROLE = { view: "viewer", comment: "commenter", edit: "editor" },
      VERB = { view: "view", comment: "comment on", edit: "edit" };
    if (ROLE[sharing.organizationAccess])
      await boards.updateSettings(
        room,
        identity,
        (await org.kv.get(`wb:${room}:meta`)) || meta,
        {
          visibility: "organization",
          orgRole: ROLE[sharing.organizationAccess],
        },
      );
    // A board Miro kept from the organization stays with the people it was
    // shared with, whatever visibility new boards here start with.
    else if (
      "organizationAccess" in sharing &&
      ((await org.kv.get(`wb:${room}:meta`)) || meta).visibility ===
        "organization"
    )
      await boards.updateSettings(
        room,
        identity,
        (await org.kv.get(`wb:${room}:meta`)) || meta,
        { visibility: "private" },
      );
    if (ROLE[sharing.teamAccess] && !ROLE[sharing.organizationAccess])
      warnings.push(
        `In Miro, everyone in the board's team could ${VERB[sharing.teamAccess]} it. Share it with those people here if they still need it.`,
      );
    if (ROLE[sharing.access])
      warnings.push(
        `In Miro, anyone with the link could ${VERB[sharing.access]} it. It is not shared by link here; turn link sharing on if it is still needed.`,
      );
    // A Miro team holds boards as a space does here: the board goes into
    // the space of that name, made the first time it is needed.
    const teamName =
      input.source && typeof input.source === "object"
        ? text(input.source.teamName, 80)
        : "";
    if (teamName) {
      let space = (await org.list("org:space:"))
        .map((r) => r.value)
        .find((s) => s?.name?.toLowerCase() === teamName.toLowerCase());
      if (!space) {
        space = {
          id: short(),
          name: teamName,
          team: null,
          created: org.now(),
          createdBy: identity.uuid,
        };
        await org.kv.set("org:space:" + space.id, space);
        await org.audit(
          identity,
          "space.created",
          { type: "space", id: space.id, name: space.name },
          { source: "migration" },
        );
      }
      await boards.updateSettings(
        room,
        identity,
        (await org.kv.get(`wb:${room}:meta`)) || meta,
        { space: space.id },
      );
    }
    if (input.source && typeof input.source === "object")
      await org.registerBoard(room, {
        source: "miro",
        sourceId: text(input.source.boardId, 100) || null,
        sourceLink: text(input.source.viewLink, 500) || null,
      });
    await boards.refreshCounts(room);
    await org.audit(
      identity,
      "board.migrated",
      { type: "board", id: room },
      {
        members: applied.length,
        skipped: skipped.length,
        owner: owner?.email || null,
      },
    );
    return { applied, skipped, warnings };
  }
  if (op === "org.users.transfer") {
    const from = id(input.from),
      to = id(input.to);
    const ownerId = (await org.accountOwner()).uuid;
    // Only the account owner moves an administrator's boards, or their
    // own, as only they change administrators.
    if (
      role !== "owner" &&
      (from === ownerId || (await org.freshUser(from))?.role === "admin")
    )
      fail(403, "Only the account owner can change an administrator.");
    // Boards go to someone who can keep them: the account owner or an active
    // member, never a guest whose access expires.
    const next = await org.freshUser(to);
    if (
      to !== ownerId &&
      (!next || next.status !== "active" || next.role === "guest")
    )
      fail(400, "Choose an active member of your organization.");
    // Boards given to the person who owns them do not move.
    if (from === to) return { transferred: 0 };
    const rooms = (await org.list("org:board:"))
      .map((r) => r.value)
      .filter((b) => b.owner === from && !b.purging)
      .map((b) => b.room);
    // Retention may start purging a trashed board meanwhile: such a board
    // is left to it, and the others still move. Moving a board takes a few
    // dozen storage requests, so one request moves a batch and says how
    // many remain; the console asks again until none do.
    // `after` is the last board the previous batch looked at, so one that
    // could not move is not tried again.
    const after = typeof input.after === "string" ? input.after : "";
    const left = rooms.filter((room) => room > after).sort(),
      batch = left.slice(0, TRANSFER_BATCH);
    let transferred = 0;
    for (const room of batch) {
      const record = await org.kv.get("org:board:" + room);
      if (!record || record.purging || record.owner !== from) continue;
      try {
        await boards.transfer(room, identity, to, { admin: true });
        transferred++;
      } catch (error) {
        if (error.status !== 404 && error.status !== 409) throw error;
      }
    }
    const remaining = left.length - batch.length;
    return {
      transferred,
      remaining,
      next: remaining ? batch.at(-1) : null,
    };
  }
  if (op === "org.invite") {
    const inviteRole = ["member", "admin", "guest"].includes(input.role)
      ? input.role
      : "member";
    if (inviteRole === "admin" && role !== "owner")
      fail(403, "Only the account owner can invite administrators.");
    const value = token();
    const days = Math.max(1, Math.min(90, Number(input.days) || 14));
    await org.kv.set("org:invite:" + (await hash(value)), {
      role: inviteRole,
      expires: org.now() + days * DAY,
      created: org.now(),
      createdBy: identity.uuid,
    });
    await org.audit(
      identity,
      "user.invited",
      { type: "organization" },
      { role: inviteRole, days },
    );
    return { token: value, expires: org.now() + days * DAY };
  }
  if (op === "org.invite.revoke") {
    for (const row of await org.list("org:invite:")) await org.kv.del(row.key);
    await org.audit(identity, "user.invites.revoked", { type: "organization" });
    return { ok: true };
  }
  if (op === "teams.create" || op === "teams.update" || op === "teams.delete") {
    const teamId = op === "teams.create" ? short() : id(input.id);
    const unlock = await lockTeam(org, teamId);
    try {
      const existing = await org.kv.get("org:team:" + teamId);
      if (op !== "teams.create" && !existing) fail(404, "Team not found.");
      // A change can name only who joins (`add`) and who leaves (`remove`),
      // so it keeps members someone else added since the editor loaded; a
      // full `members` list replaces them all, as before.
      const changing =
        op === "teams.update" &&
        !Array.isArray(input.members) &&
        (Array.isArray(input.add) || Array.isArray(input.remove));
      const leaving = new Set(
        changing && Array.isArray(input.remove)
          ? await teamMembers(org, input.remove.map(id), false)
          : [],
      );
      const members =
        op === "teams.delete"
          ? []
          : changing
            ? [
                ...new Set([
                  ...existing.members.filter((uuid) => !leaving.has(uuid)),
                  ...(Array.isArray(input.add)
                    ? await teamMembers(org, input.add.map(id))
                    : []),
                ]),
              ].slice(0, 5000)
            : Array.isArray(input.members)
              ? [
                  ...new Set(
                    await teamMembers(
                      org,
                      input.members.map(id),
                      true,
                      existing?.members,
                    ),
                  ),
                ].slice(0, 5000)
              : existing?.members || [];
      // The record names the team as saved, not as typed: a blank name
      // keeps the one it had.
      const name =
        op === "teams.delete"
          ? existing.name
          : text(input.name, 120) || existing?.name || "Untitled team";
      // The team is saved first, then the people who joined or left it.
      if (op === "teams.delete") await org.kv.del("org:team:" + teamId);
      else
        await org.kv.set("org:team:" + teamId, {
          ...(existing || { id: teamId, created: org.now() }),
          name,
          members,
        });
      await syncTeamMembers(org, teamId, existing?.members || [], members);
      await org.audit(
        identity,
        `team.${op.split(".")[1]}d`,
        { type: "team", id: teamId, name },
        memberChanges(existing?.members || [], members),
      );
      return { team: await org.kv.get("org:team:" + teamId) };
    } finally {
      await unlock();
    }
  }
  if (op === "org.audit") return auditQuery(org, input);
  if (op === "org.board.activity") {
    // Newest first, a page at a time: `cursor` from one answer asks for
    // the events before it, until it comes back null.
    const limit = Math.max(1, Math.min(1000, Number(input.limit) || 500));
    let cursor =
        typeof input.cursor === "string" && input.cursor.length <= 4096
          ? input.cursor
          : undefined,
      rows = [];
    do {
      const page = await org.page({
        pattern: `org:bact:${id(input.room)}:`,
        returnValues: true,
        limit: limit - rows.length,
        reverse: true,
        ...(cursor ? { cursor } : {}),
      });
      rows.push(...(Array.isArray(page) ? page : page.items));
      cursor = page.cursor;
    } while (cursor && rows.length < limit);
    return {
      // Activity recorded before it kept its category gets it from its
      // action, as the audit log does.
      entries: rows.map((r) => ({
        category: auditCategory(r.value.action),
        ...r.value,
      })),
      cursor: cursor || null,
    };
  }
  if (op === "org.reports") return computeReports(org, input);
  if (op === "apikeys.list")
    return {
      keys: (await listKeys(org)).map(({ hash: _, ...k }) => k),
      scopes: API_SCOPES,
    };
  if (op === "apikeys.create") {
    const scopes = (Array.isArray(input.scopes) ? input.scopes : []).filter(
      (s) => API_SCOPES.includes(s),
    );
    if (!scopes.length) fail(400, "Choose at least one scope.");
    const days = input.days ?? null;
    if (days !== null && !(Number.isInteger(days) && days >= 1))
      fail(400, "Choose a whole number of days for the key to expire.");
    const value = "wbk_" + token();
    const record = {
      id: short(),
      name: text(input.name, 80) || "API key",
      scopes,
      created: org.now(),
      createdBy: identity.uuid,
      expires: days ? org.now() + Math.min(730, days) * DAY : null,
      prefix: value.slice(0, 12),
      lastUsed: null,
    };
    await org.kv.set("org:apikey:" + (await hash(value)), record, {
      disableSharing: true,
    });
    await org.audit(
      identity,
      "apikey.created",
      { type: "apikey", id: record.id, name: record.name },
      {
        scopes,
      },
    );
    return { key: value, record };
  }
  if (op === "apikeys.revoke") {
    const match = (await listKeys(org)).find((k) => k.id === input.id);
    if (!match) fail(404, "API key not found.");
    await org.kv.del("org:apikey:" + match.hash);
    await org.kv.del("org:apikeyused:" + match.hash);
    await org.audit(identity, "apikey.revoked", {
      type: "apikey",
      id: match.id,
      name: match.name,
    });
    return { ok: true };
  }
  if (op === "webhooks.list")
    return {
      webhooks: (await org.list("org:webhook:")).map((r) => r.value),
      events: WEBHOOK_EVENTS,
      pending: (await org.list("org:hookq:", { limit: 100 })).length,
    };
  if (op === "webhooks.create") {
    let url;
    try {
      url = new URL(input.url);
      if (url.protocol !== "https:" || url.username || url.password)
        throw Error();
    } catch {
      fail(400, "Enter a valid HTTPS webhook URL.");
    }
    if (!publicHost(url.hostname))
      fail(400, "Webhooks must use a public internet address.");
    // Any audit action or prefix of one, as the documentation says; a
    // list that names something else is refused rather than widened.
    const asked = Array.isArray(input.events) ? input.events : ["*"];
    if (
      asked.length > 50 ||
      asked.some(
        (e) =>
          e !== "*" &&
          !(
            typeof e === "string" &&
            e.length <= 80 &&
            /^[a-z]+(\.[a-z]+)*$/.test(e)
          ),
      )
    )
      fail(
        400,
        "Choose events by audit action or prefix, such as board or user.role, or * for every event.",
      );
    const events = [...new Set(asked)];
    const hook = {
      id: short(),
      url: url.href,
      events: events.length ? events : ["*"],
      enabled: true,
      created: org.now(),
      createdBy: identity.uuid,
      // A webhook made with an API key belongs to the administrator who made
      // the key, so it outlives the key being rotated.
      ...(identity.apiKey && identity.createdBy
        ? { admin: identity.createdBy }
        : {}),
    };
    const secret = "whsec_" + token();
    // The secret is saved first, so every delivery can be signed.
    await org.kv.set("org:hooksecret:" + hook.id, secret, {
      disableSharing: true,
    });
    await org.kv.set("org:webhook:" + hook.id, hook);
    org.instance.hooks = null;
    await org.audit(
      identity,
      "webhook.created",
      { type: "webhook", id: hook.id, name: endpointShown(hook.url) },
      {
        events: hook.events,
      },
    );
    return { webhook: hook, secret };
  }
  if (op === "webhooks.delete") {
    const hookId = id(input.id);
    const hook = await org.kv.get("org:webhook:" + hookId);
    await org.kv.del("org:webhook:" + hookId);
    org.instance.hooks = null;
    await org.kv.del("org:hooksecret:" + hookId);
    for (const row of await org.list(`org:hookq:${hookId}:`, {
      values: false,
    }))
      await org.kv.del(typeof row === "string" ? row : row.key);
    // Deleting a webhook already gone changes nothing to record; a real
    // deletion names its endpoint, as its creation did.
    if (hook)
      await org.audit(identity, "webhook.deleted", {
        type: "webhook",
        id: hookId,
        name: endpointShown(hook.url),
      });
    return { ok: true };
  }
  if (op === "webhooks.test") {
    const hook = await org.kv.get("org:webhook:" + id(input.id));
    if (!hook) fail(404, "Webhook not found.");
    const iso = new Date(org.now()).toISOString();
    const entry = {
      id: `${iso}:test`,
      at: org.now(),
      time: iso,
      category: "admin",
      action: "webhook.test",
      actor: { uuid: identity.uuid, username: identity.username },
      target: { type: "webhook", id: hook.id },
      details: {},
    };
    try {
      await sendHook(org, hook, entry);
      return { ok: true, matches: hookMatches(hook, "board.created") };
    } catch (error) {
      fail(502, error.message || "The webhook test failed.");
    }
  }
  if (op === "org.slack.test") {
    const url = await org.secret("slack");
    if (!url) fail(400, "Enter a Slack incoming webhook URL.");
    try {
      await testSlack(org, url);
      return { ok: true };
    } catch (error) {
      fail(
        502,
        /^Slack refused the message/.test(error.message || "")
          ? error.message
          : "Could not reach Slack.",
      );
    }
  }
  if (op === "org.siem.test") {
    const policy = await org.policy();
    if (policy.siem.mode === "none")
      fail(400, "Choose a SIEM destination to send a test event.");
    try {
      return await siem(org, policy, { force: true });
    } catch (error) {
      fail(502, error.message || "The SIEM test failed.");
    }
  }
  fail(400, "Unknown organization operation.");
}
