import { hash } from "../src/collaboration/protocol.js";
import {
  deliver,
  retrySiem,
  retryWebhooks,
  sendHeldAlerts,
} from "./delivery.js";
import { purge } from "./retention.js";
import {
  asciiDomain,
  domainProblem,
} from "../src/organization/email-domains.js";
import { sendScheduledReport } from "./reports.js";

// Every deployed worker is one organization. The account that deployed it is
// the organization's account owner; everything below lives in that account's
// app KV (small records) or files (anything large). Secrets never leave the
// worker: clients only learn whether an integration is configured.
export const ORG_ROLES = ["owner", "admin", "member", "guest"];
export const BOARD_ROLES = [
  "owner",
  "facilitator",
  "editor",
  "commenter",
  "viewer",
];
export const CONTENT_ROLES = new Set(["owner", "facilitator", "editor"]);
export const MANAGER_ROLES = new Set(["owner", "facilitator"]);
export const DAY = 86400_000;
export const DEFAULT_POLICY = {
  name: "",
  domains: [],
  domainCapture: false,
  restrictToOrganization: false,
  externalSharing: "guests",
  guestAccess: true,
  guestExpiryDays: 30,
  // The most a guest may do on a board; facilitator leaves guests every
  // role but owner.
  guestRole: "facilitator",
  publicLinks: false,
  membersCanCreate: true,
  defaultVisibility: "private",
  mfaRequired: false,
  ai: { enabled: true, summaries: true, handwriting: true, clustering: true },
  integrations: {
    slack: { enabled: false },
    jira: { enabled: false, site: "", email: "", project: "" },
    google: { enabled: true },
    webhooks: { enabled: false },
    embeds: { enabled: true },
    miro: { enabled: true },
  },
  retention: { auditDays: 365, deletedBoardDays: 30, legalHold: false },
  siem: {
    mode: "none",
    categories: ["admin", "security", "access", "sharing"],
    sentinel: {
      tenantId: "",
      clientId: "",
      endpoint: "",
      dcrId: "",
      stream: "",
    },
    url: "",
  },
  alerts: {
    publicSharing: true,
    guestAccess: true,
    permissionChanges: true,
    policyChanges: true,
    emails: [],
    slack: false,
  },
  reports: { schedule: "none", emails: [] },
};
export const SECRETS = new Set([
  "slack",
  "jira",
  "sentinel",
  "siem-url",
  "siem-token",
]);
// State kept per worker instance (and per account, for tests): the account
// owner, recently read user records, and batched usage statistics.
const INSTANCES = new WeakMap();
export const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
// Access checks run on every request, from records each worker instance
// keeps: a board's metadata and memberships (see BoardService.member), and
// the organization's user records and policy. The board's, or the
// organization's, access stamp is rewritten with a new value after any of
// these change. An instance reads a stamp at most once a CHECK, for all
// requests, and keeps records while it holds the value they were read
// under, up to KEEP, as workers from before stamps do not write them. A
// record read as a new value was first seen may predate the change, so it
// is kept only BRIEF; one read SETTLE later shows it. A stale stamp read
// only keeps records longer, never past KEEP.
const CHECK = 1000,
  SETTLE = 1500,
  BRIEF = 2000;
export const KEEP = 30_000;
export class AccessStamp {
  // Given `absent`, a record read as absent is kept only BRIEF, so adding
  // one needs no new stamp.
  constructor(key, absent = false) {
    this.key = key;
    this.absent = absent;
    this.gen = null;
    this.checked = -Infinity;
    // The read in flight, which requests arriving meanwhile wait for.
    this.reading = null;
  }
  due(now) {
    return !(now - this.checked < CHECK && now >= this.checked);
  }
  // A value read by a request begun at `at` and answered at `done`.
  saw(value, at, done) {
    const text = JSON.stringify(value ?? null);
    if (text !== this.gen?.value) this.gen = { value: text, seen: done };
    this.checked = Math.max(this.checked, at);
  }
  usable(entry, now) {
    if (!entry || now < entry.at) return false;
    // What this instance wrote, it uses at once.
    if (entry.wrote && now - entry.at < SETTLE) return true;
    const settled =
      entry.at >= entry.gen?.seen + SETTLE &&
      !(this.absent && entry.value == null);
    return (
      !!entry.gen &&
      entry.gen === this.gen &&
      now - entry.at < (settled ? KEEP : BRIEF)
    );
  }
}
// Reads records kept under access stamps, and each stamp due, in one
// request for everything an instance cannot use: Puter counts a get of
// several keys as one request. Each want names a key, the Map keeping what
// was read of it, and its stamp. Records a changed stamp leaves unusable
// are read again in a second request.
export async function readKept(kv, now, wants) {
  const stamps = [...new Set(wants.map((w) => w.stamp))];
  // Requests arriving together share a stamp's read: until one is under
  // way, nothing here waits before starting it.
  const pending = stamps.map((s) => s.reading).filter(Boolean);
  if (pending.length) await Promise.all(pending);
  const values = new Map();
  const read = async (keys, due) => {
    const at = now(),
      all = [...due.map((s) => s.key), ...keys];
    let done;
    const reading = new Promise((resolve) => (done = resolve));
    for (const s of due) s.reading = reading;
    try {
      const got = all.length > 1 ? await kv.get(all) : [await kv.get(all[0])];
      const answered = now();
      due.forEach((s, n) => s.saw(got[n], at, answered));
      keys.forEach((key, n) => values.set(key, got[due.length + n] ?? null));
      for (const { key, cache, stamp } of wants) {
        const old = cache.get(key);
        // A read begun before this instance wrote the record is older.
        if (!keys.includes(key) || (old?.wrote && old.at > at)) continue;
        if (cache.size >= 5000) cache.clear();
        cache.set(key, { value: values.get(key), at, gen: stamp.gen });
      }
    } finally {
      for (const s of due) if (s.reading === reading) s.reading = null;
      done();
    }
  };
  const usable = (w, at) => w.stamp.usable(w.cache.get(w.key), at);
  const at = now(),
    due = stamps.filter((s) => s.due(at));
  // What is usable now may not be once a stamp due is read.
  const missing = new Set(
    wants.filter((w) => !usable(w, at)).map((w) => w.key),
  );
  if (due.length || missing.size) await read([...missing], due);
  const later = now(),
    stale = new Set();
  for (const w of wants)
    if (values.has(w.key)) continue;
    else if (usable(w, later)) values.set(w.key, w.cache.get(w.key).value);
    else stale.add(w.key);
  if (stale.size) await read([...stale], []);
  return wants.map(({ key }) => structuredClone(values.get(key)));
}
// What an instance wrote under an access stamp, which it uses at once.
export function keepWritten(cache, stamp, key, value, at) {
  if (cache.size >= 5000) cache.clear();
  cache.set(key, {
    value: structuredClone(value),
    at,
    gen: stamp.gen,
    wrote: true,
  });
}
// An organization role, or null for someone with no relationship to the
// organization yet, and whether the account is active, from a user record.
export const standing = (user) => ({
  role: user?.status === "active" ? user.role : null,
  active: !user || user.status === "active",
});
const text = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const bool = (value, fallback) =>
  typeof value === "boolean" ? value : fallback;
// The top-level domain may be an internationalized one in punycode.
const EMAIL =
  /^[^\s@<>()[\]\\,;:"]{1,64}@([a-z0-9-]+\.)+([a-z]{2,}|xn--[a-z0-9-]+)$/i;
export const validEmail = (value) =>
  typeof value === "string" && value.length <= 254 && EMAIL.test(value);
export const emailDomain = (value) =>
  validEmail(value) ? value.split("@")[1].toLowerCase() : "";
// Whether an address belongs to the organization's email domains. A
// subdomain is part of its domain (hr.example.ca is in example.ca), the same
// rule domain capture, verification, and migrations follow.
export const inDomains = (email, domains = []) => {
  const domain = emailDomain(email);
  return (
    !!domain && domains.some((d) => domain === d || domain.endsWith(`.${d}`))
  );
};
const httpsURL = (value) => {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error();
    return url.href.slice(0, 2048);
  } catch {
    fail(400, "Enter a valid HTTPS address.");
  }
};
const day = (at) => new Date(at).toISOString().slice(0, 10);
const rand = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
// How many audit and notification records a worker instance keeps for
// retry while storage refuses writes.
const UNSAVED_LIMIT = 1000;

// Merge an untrusted policy patch onto the current policy field by field.
// Unknown keys are dropped, so clients cannot store arbitrary data here.
export function mergePolicy(current, patch = {}) {
  const p = structuredClone(current);
  if ("name" in patch) p.name = text(patch.name, 120);
  if (Array.isArray(patch.domains)) {
    const domains = patch.domains
      .map((d) => asciiDomain(text(d, 253)))
      .filter(Boolean);
    // A public mail domain already listed can stay, so an organization
    // that had one can still save its other settings.
    const problem = domainProblem(domains, current.domains);
    if (problem?.reason === "invalid" || domains.length > 50)
      fail(400, "Enter valid email domains, such as example.ca.");
    if (problem?.reason === "public")
      fail(
        400,
        "Public email domains such as gmail.com cannot be the organization's: anyone can have an address there.",
      );
    if (problem)
      fail(
        400,
        "A domain anyone can register under, such as co.uk, cannot be the organization's. Enter its own domain.",
      );
    p.domains = [...new Set(domains)];
  }
  for (const key of [
    "domainCapture",
    "restrictToOrganization",
    "guestAccess",
    "publicLinks",
    "membersCanCreate",
    "mfaRequired",
  ])
    if (key in patch) p[key] = bool(patch[key], p[key]);
  if (["none", "guests", "anyone"].includes(patch.externalSharing))
    p.externalSharing = patch.externalSharing;
  if (["private", "organization"].includes(patch.defaultVisibility))
    p.defaultVisibility = patch.defaultVisibility;
  if (
    ["facilitator", "editor", "commenter", "viewer"].includes(patch.guestRole)
  )
    p.guestRole = patch.guestRole;
  if (Number.isInteger(patch.guestExpiryDays))
    p.guestExpiryDays = Math.max(0, Math.min(365, patch.guestExpiryDays));
  if (patch.ai && typeof patch.ai === "object")
    for (const key of ["enabled", "summaries", "handwriting", "clustering"])
      if (key in patch.ai) p.ai[key] = bool(patch.ai[key], p.ai[key]);
  if (patch.integrations && typeof patch.integrations === "object")
    for (const [name, value] of Object.entries(patch.integrations)) {
      if (
        !Object.hasOwn(p.integrations, name) ||
        !value ||
        typeof value !== "object"
      )
        continue;
      if ("enabled" in value)
        p.integrations[name].enabled = bool(
          value.enabled,
          p.integrations[name].enabled,
        );
      if (name === "jira") {
        if ("site" in value) {
          const site = text(value.site, 253).toLowerCase();
          if (site && !/^[a-z0-9-]+\.atlassian\.net$/.test(site))
            fail(
              400,
              "Enter your Jira Cloud site, such as team.atlassian.net.",
            );
          p.integrations.jira.site = site;
        }
        if ("email" in value) {
          if (value.email && !validEmail(value.email))
            fail(400, "Enter a valid email address.");
          p.integrations.jira.email = text(value.email, 254);
        }
        if ("project" in value) {
          const project = text(value.project, 20).toUpperCase();
          if (project && !/^[A-Z][A-Z0-9_]+$/.test(project))
            fail(400, "Enter a Jira project key, such as OPS.");
          p.integrations.jira.project = project;
        }
      }
    }
  if (patch.retention && typeof patch.retention === "object") {
    const r = patch.retention;
    if (Number.isInteger(r.auditDays))
      p.retention.auditDays = Math.max(30, Math.min(3650, r.auditDays));
    if (Number.isInteger(r.deletedBoardDays))
      p.retention.deletedBoardDays = Math.max(
        1,
        Math.min(3650, r.deletedBoardDays),
      );
    if ("legalHold" in r)
      p.retention.legalHold = bool(r.legalHold, p.retention.legalHold);
  }
  if (patch.siem && typeof patch.siem === "object") {
    const s = patch.siem;
    if (["none", "sentinel", "https"].includes(s.mode)) p.siem.mode = s.mode;
    if (Array.isArray(s.categories))
      p.siem.categories = s.categories.filter((c) =>
        ["admin", "security", "access", "sharing", "content", "api"].includes(
          c,
        ),
      );
    if (s.sentinel && typeof s.sentinel === "object") {
      const z = s.sentinel,
        guid = /^[0-9a-f-]{36}$/i;
      if ("tenantId" in z) {
        if (z.tenantId && !guid.test(z.tenantId))
          fail(400, "Enter the Microsoft Entra tenant ID.");
        p.siem.sentinel.tenantId = text(z.tenantId, 36);
      }
      if ("clientId" in z) {
        if (z.clientId && !guid.test(z.clientId))
          fail(400, "Enter the application (client) ID.");
        p.siem.sentinel.clientId = text(z.clientId, 36);
      }
      if ("endpoint" in z) {
        const endpoint = httpsURL(text(z.endpoint, 2048));
        const url = endpoint && new URL(endpoint);
        // The Entra token is only ever sent to an Azure ingestion host.
        if (
          url &&
          (!/\.ingest\.monitor\.azure\.(com|us|cn)$/.test(url.hostname) ||
            url.port ||
            url.pathname !== "/" ||
            url.search ||
            url.hash)
        )
          fail(400, "Enter the data collection endpoint logs ingestion URL.");
        p.siem.sentinel.endpoint = url ? url.origin : "";
      }
      if ("dcrId" in z) {
        if (z.dcrId && !/^dcr-[0-9a-f]{32}$/i.test(z.dcrId))
          fail(400, "Enter the data collection rule immutable ID.");
        p.siem.sentinel.dcrId = text(z.dcrId, 36);
      }
      if ("stream" in z) {
        if (z.stream && !/^Custom-[A-Za-z0-9_]{1,100}$/.test(z.stream))
          fail(400, "Enter the stream name, such as Custom-WhiteboardAudit.");
        p.siem.sentinel.stream = text(z.stream, 107);
      }
    }
    if ("url" in s) {
      const url = httpsURL(text(s.url, 2048));
      if (url && !publicHost(new URL(url).hostname))
        fail(400, "The SIEM endpoint must use a public internet address.");
      p.siem.url = url;
    }
  }
  if (patch.alerts && typeof patch.alerts === "object") {
    const a = patch.alerts;
    for (const key of [
      "publicSharing",
      "guestAccess",
      "permissionChanges",
      "policyChanges",
      "slack",
    ])
      if (key in a) p.alerts[key] = bool(a[key], p.alerts[key]);
    if (Array.isArray(a.emails)) {
      if (a.emails.length > 10 || a.emails.some((e) => !validEmail(e)))
        fail(400, "Enter up to ten valid alert email addresses.");
      p.alerts.emails = a.emails.map((e) => e.toLowerCase());
    }
  }
  if (patch.reports && typeof patch.reports === "object") {
    const r = patch.reports;
    if (["none", "weekly", "monthly"].includes(r.schedule))
      p.reports.schedule = r.schedule;
    if (Array.isArray(r.emails)) {
      if (r.emails.length > 10 || r.emails.some((e) => !validEmail(e)))
        fail(400, "Enter up to ten valid report email addresses.");
      p.reports.emails = r.emails.map((e) => e.toLowerCase());
    }
    // A schedule with nobody to send to would never send anything.
    if (p.reports.schedule !== "none" && !p.reports.emails.length)
      fail(400, "Enter at least one recipient for scheduled reports.");
  }
  return p;
}
// A guest's board role within what the policy lets guests have: the
// highest role for guests, or their own if lower. The stored role is kept,
// so raising the limit gives it back.
export function guestRole(role, policy) {
  const limit = policy?.guestRole || "facilitator";
  return BOARD_ROLES.indexOf(role) >= 0 &&
    BOARD_ROLES.indexOf(role) < BOARD_ROLES.indexOf(limit)
    ? limit
    : role;
}
// Whether the policy keeps every guest off the organization's boards, as
// board access checks refuse them then.
export const guestsShutOut = (policy) =>
  !!policy &&
  (!!policy.restrictToOrganization ||
    policy.externalSharing === "none" ||
    policy.guestAccess === false);
// The guests a board's registry record counts who can still open it, as
// recorded guest access ends without anything recounting the board, and
// none while the policy keeps guests out.
export function currentGuests(board, now, policy) {
  if (guestsShutOut(policy)) return 0;
  const ended = (board.guestEnds || []).filter((at) => at < now).length;
  return Math.max(0, (board.guestCount || 0) - ended);
}
// A board's registry record as listings show it, with the guests who can
// still open it.
export function listedBoard(board, now, policy) {
  const { guestEnds: _, ...rest } = board;
  return { ...rest, guestCount: currentGuests(board, now, policy) };
}
// Fill in fields added after a policy was first saved.
export function normalizePolicy(stored) {
  const p = structuredClone(DEFAULT_POLICY);
  if (!stored) return p;
  for (const [key, value] of Object.entries(stored))
    if (key in p)
      p[key] =
        value && typeof value === "object" && !Array.isArray(value)
          ? deepFill(p[key], value)
          : value;
  return p;
}
function deepFill(base, value) {
  const out = structuredClone(base);
  for (const [key, v] of Object.entries(value))
    out[key] =
      v && typeof v === "object" && !Array.isArray(v) && base[key]
        ? deepFill(base[key], v)
        : v;
  return out;
}
const AUDIT_CATEGORY = {
  "org.": "admin",
  "policy.": "admin",
  "user.": "admin",
  "team.": "admin",
  "space.": "admin",
  // People and groups an identity provider changes are administration,
  // like the same changes made in the console.
  "scim.user.": "admin",
  "scim.group.": "admin",
  "apikey.": "security",
  "auth.": "security",
  "email.": "security",
  "board.access": "access",
  "board.joined": "access",
  "board.guest": "access",
  "board.role": "access",
  "board.invite": "sharing",
  "board.visibility": "sharing",
  "board.share": "sharing",
  "board.transfer": "admin",
  "board.content": "content",
  "board.comment": "content",
  "board.export": "content",
  "vote.": "content",
  "poll.": "content",
  "workshop.": "content",
  "api.": "api",
  "scim.": "api",
};
// Who a team change added and removed, for its audit record: up to 100 of
// each by ID, with how many more there were.
export function memberChanges(before = [], after = []) {
  const had = new Set(before),
    has = new Set(after),
    added = after.filter((m) => !had.has(m)),
    removed = before.filter((m) => !has.has(m));
  return {
    members: after.length,
    added: added.slice(0, 100),
    removed: removed.slice(0, 100),
    ...(added.length > 100 && { moreAdded: added.length - 100 }),
    ...(removed.length > 100 && { moreRemoved: removed.length - 100 }),
  };
}
export function auditCategory(action) {
  for (const [prefix, category] of Object.entries(AUDIT_CATEGORY))
    if (action.startsWith(prefix)) return category;
  return "admin";
}

// Whether a person still administers the organization, as keys,
// invitations, and webhooks they made require.
export const administers = async (org, uuid) =>
  ["owner", "admin"].includes(await org.role({ uuid }));
// Webhooks go to services on the public internet: local names and private,
// loopback, or link-local addresses written as the host are refused. A
// worker cannot resolve names, so a public name that points at a private
// address is not caught here.
export function publicHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    // Global unicast IPv6 only (2000::/3), without the documentation range
    // or the 6to4 and Teredo ranges, which carry an IPv4 address that can
    // be a private one.
    const ip = host.slice(1, -1);
    return (
      /^[23][0-9a-f]{0,3}:/.test(ip) &&
      !/^2001:0{0,3}db8:/.test(ip) &&
      !/^2002:/.test(ip) &&
      !/^2001:(0{0,4}):/.test(ip)
    );
  }
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && Number(v4[3]) === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    host.includes(".") &&
    !/(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/.test(host)
  );
}
export class OrgService {
  constructor(puter, { now = Date.now, fetcher = fetch, request } = {}) {
    this.puter = puter;
    this.kv = puter.kv;
    this.now = now;
    this.fetcher = fetcher;
    this.request = request;
    this.pending = [];
    this.caches = OrgService.caches ??= {
      touched: new Map(),
      purged: 0,
      reported: 0,
    };
    if (!INSTANCES.has(puter))
      INSTANCES.set(puter, {
        owner: null,
        touched: new Map(),
        // User records and the organization's metadata, read for access
        // checks under the organization's access stamp.
        records: new Map(),
        stamp: new AccessStamp("org:access"),
        time: { seconds: 0, since: 0 },
        activity: new Map(),
        hooks: null,
        siem: 0,
        siemBacklog: false,
        // Audit and notification records whose storage write failed,
        // written again before the next such write and on each flush,
        // oldest first.
        unsaved: [],
      });
    this.instance = INSTANCES.get(puter);
    this.siemInterval = 10_000;
  }
  // One request of a listing, taking its turn with the boards' listings
  // when a board service shares this one.
  page(options) {
    return this.lists ? this.lists(options) : this.kv.list(options);
  }
  async list(
    prefix,
    { values = true, limit = Infinity, reverse = false } = {},
  ) {
    let cursor,
      rows = [];
    do {
      const page = await this.page({
        pattern: prefix,
        returnValues: values,
        limit: Math.min(1000, limit - rows.length),
        ...(reverse ? { reverse: true } : {}),
        ...(cursor ? { cursor } : {}),
      });
      rows.push(...(Array.isArray(page) ? page : page.items));
      cursor = page.cursor;
    } while (cursor && rows.length < limit);
    return rows;
  }
  // Visits rows page by page, stopping once `visit` returns true.
  async scan(prefix, { values = true, reverse = false } = {}, visit) {
    let cursor;
    do {
      const page = await this.page({
        pattern: prefix,
        returnValues: values,
        limit: 200,
        ...(reverse ? { reverse: true } : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const row of Array.isArray(page) ? page : page.items)
        if (visit(row)) return;
      cursor = page.cursor;
    } while (cursor);
  }
  async accountOwner() {
    const instance = this.instance;
    instance.owner ??= this.puter.auth.getUser().then(
      (u) => ({ uuid: u.uuid, username: u.username }),
      (error) => {
        instance.owner = null;
        throw error;
      },
    );
    return instance.owner;
  }
  async policy() {
    return normalizePolicy((await this.kv.get("org:meta"))?.policy);
  }
  // Board access checks run on every request, so they keep the policy as
  // they do user records.
  async accessPolicy() {
    const [meta] = await readKept(this.kv, () => this.now(), [
      this.kept("org:meta"),
    ]);
    return normalizePolicy(meta?.policy);
  }
  // Whether the organization is set up, read as access checks read it.
  async configured() {
    const [meta] = await readKept(this.kv, () => this.now(), [
      this.kept("org:meta"),
    ]);
    return !!meta;
  }
  forgetPolicy() {
    this.instance.records.delete("org:meta");
  }
  async saveMeta(meta) {
    await this.kv.set("org:meta", meta);
    this.wrote("org:meta", meta);
    await this.accessChanged();
  }
  // Has other instances read user records and the policy again.
  async accessChanged() {
    await this.kv.set("org:access", crypto.randomUUID()).catch(() => {
      /* They do within KEEP anyway. */
    });
  }
  wrote(key, value) {
    keepWritten(
      this.instance.records,
      this.instance.stamp,
      key,
      value,
      this.now(),
    );
  }
  async meta() {
    const meta = await this.kv.get("org:meta");
    return meta ? { ...meta, policy: normalizePolicy(meta.policy) } : null;
  }
  async secret(name) {
    return (await this.kv.get("org:secret:" + name)) || null;
  }
  async setSecret(name, value) {
    if (!SECRETS.has(name)) fail(400, "Unknown integration secret.");
    if (value == null || value === "") await this.kv.del("org:secret:" + name);
    else
      await this.kv.set("org:secret:" + name, value, { disableSharing: true });
  }
  // User records are read for every request, so an instance keeps them;
  // see AccessStamp.
  async user(uuid) {
    return (
      await readKept(this.kv, () => this.now(), [this.kept("org:user:" + uuid)])
    )[0];
  }
  // Several people's records, read together a thousand to a request, as
  // SCIM reads them; they are kept as user() keeps them.
  async users(uuids) {
    const records = [];
    for (let n = 0; n < uuids.length; n += 1000)
      records.push(
        ...(await readKept(
          this.kv,
          () => this.now(),
          uuids.slice(n, n + 1000).map((uuid) => this.kept("org:user:" + uuid)),
        )),
      );
    return records;
  }
  // How readKept reads one of these records, so an access check can read a
  // user record along with the board's.
  kept(key) {
    return { key, cache: this.instance.records, stamp: this.instance.stamp };
  }
  forgetUser(uuid) {
    this.instance.records.delete("org:user:" + uuid);
  }
  async dropUser(uuid) {
    await this.kv.del("org:user:" + uuid);
    this.wrote("org:user:" + uuid, null);
    await this.accessChanged();
  }
  // A record about to be changed and saved is read again, so a change made
  // on another instance, such as a deactivation, is never written over with
  // this instance's cached copy.
  async freshUser(uuid) {
    this.forgetUser(uuid);
    return this.user(uuid);
  }
  // The organization role of an authenticated identity, or null for someone
  // with no relationship to this organization yet.
  async role(identity) {
    // Administrator API keys act as administrators, never as the owner.
    if (identity.apiKey) return "admin";
    const owner = await this.accountOwner();
    if (identity.uuid === owner.uuid) return "owner";
    return standing(await this.user(identity.uuid)).role;
  }
  // Notification mail and chat posts link to boards in the app. The worker
  // learns the app's address from the browser requests of the
  // organization's owner and administrators, never from anyone else's,
  // whose requests could name any site.
  async rememberApp(identity) {
    const origin = this.request?.headers.get("origin");
    if (!origin || identity.apiKey || this.instance.app === origin) return;
    try {
      if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
        return;
    } catch {
      return;
    }
    const role = await this.role(identity);
    if (role !== "owner" && role !== "admin") return;
    if ((await this.kv.get("org:app")) !== origin)
      await this.kv.set("org:app", origin);
    this.instance.app = origin;
  }
  // The address that opens a board in the app, at one object or discussion
  // if given, or null while the app's address is not known.
  async boardLink(room, object, thread) {
    if (!this.request) return null;
    const app = await this.kv.get("org:app").catch(() => null);
    if (!app) return null;
    const url = new URL(app);
    url.hash = new URLSearchParams({
      server: new URL(this.request.url).origin,
      board: room,
      ...(object ? { object } : {}),
      ...(thread ? { thread } : {}),
    }).toString();
    return url.href;
  }
  async active(identity) {
    if (identity.apiKey) return true;
    const owner = await this.accountOwner();
    if (identity.uuid === owner.uuid) return true;
    return standing(await this.user(identity.uuid)).active;
  }
  async requireAdmin(identity) {
    const role = await this.role(identity);
    if (role !== "owner" && role !== "admin")
      fail(403, "Only organization administrators can do this.");
    return role;
  }
  // Active people with their role, read once a minute per instance rather
  // than listing every person for each alert or mention. Saving anyone here
  // reads them again.
  async activePeople() {
    const hit = this.instance.people;
    if (hit && this.now() - hit.at < 60_000 && this.now() >= hit.at)
      return hit.list;
    const list = (await this.list("org:user:"))
      .map((r) => r.value)
      .filter((u) => u?.uuid && u.status === "active")
      .map(({ uuid, username, role }) => ({ uuid, username, role }));
    this.instance.people = { list, at: this.now() };
    return list;
  }
  async adminIds() {
    return (await this.activePeople())
      .filter((u) => u.role === "admin")
      .map((u) => u.uuid);
  }
  // A guest's record `added` as they first join changes no access check
  // (see BoardService.admit), so it leaves the organization's stamp.
  async saveUser(user, added = false) {
    this.instance.people = null;
    this.instance.inactiveAddresses = null;
    this.instance.touched.delete(user.uuid);
    await this.kv.set("org:user:" + user.uuid, user);
    this.wrote("org:user:" + user.uuid, user);
    if (!added) await this.accessChanged();
    if (user.email)
      await this.kv.set("org:email:" + (await hash(user.email)), user.uuid);
  }
  // Write only the given fields of a member's record, so a change another
  // request saved meanwhile, such as a deactivation, is not written over
  // with an older copy of the rest. Fields no access check reads (teams,
  // preferences, the username) leave the organization's stamp alone.
  async updateUser(uuid, patch, { access = false } = {}) {
    const key = "org:user:" + uuid;
    let next;
    if (typeof this.kv.update === "function")
      next = await this.kv.update(
        key,
        Object.fromEntries(
          Object.entries(patch).map(([field, value]) => [
            `["${field}"]`,
            value ?? null,
          ]),
        ),
      );
    else {
      next = { ...((await this.kv.get(key)) || { uuid }), ...patch };
      await this.kv.set(key, next);
    }
    this.instance.people = null;
    this.instance.inactiveAddresses = null;
    this.instance.touched.delete(uuid);
    this.wrote(key, next);
    if (access) await this.accessChanged();
    return next;
  }
  // Record activity at most once per hour per user per worker instance.
  // Only the account owner and people with a record count: someone who
  // has not joined yet, as when the app asks about the organization before
  // they accept an invitation, is not counted, and is looked up again a
  // minute later or as soon as their record is saved, so the requests they
  // make once they join are recorded.
  async touch(identity) {
    if (identity.apiKey) return;
    const now = this.now(),
      key = identity.uuid,
      last = this.instance.touched.get(key);
    if (last && now - last < 3600_000 && day(last) === day(now)) return;
    try {
      const isOwner = key === (await this.accountOwner()).uuid;
      const user = isOwner ? null : await this.user(key);
      if (this.instance.touched.size > 5000) this.instance.touched.clear();
      if (!isOwner && !user) {
        this.instance.touched.set(key, now - 3600_000 + 60_000);
        return;
      }
      this.instance.touched.set(key, now);
      const daily = `org:dayuser:${day(now)}:${key}`;
      const first = await this.kv.incr(daily);
      if (first === 1) {
        await this.kv.incr(`org:daycount:${day(now)}`);
        // Only the day's count is kept; each person's mark for it is not.
        await this.kv.expire(daily, 2 * 86400).catch(() => {});
      }
      if (isOwner)
        // The account owner is not a member; keep its activity apart.
        await this.kv.set("org:owner:lastActive", now);
      else {
        // Activity has its own key: writing back this instance's cached copy
        // of the record could undo a role or status change made elsewhere.
        await this.kv.set("org:seen:" + key, now);
        if (identity.username && user.username !== identity.username) {
          if (await this.kv.get("org:user:" + key))
            await this.updateUser(key, { username: identity.username });
          this.instance.touched.set(key, now);
        }
      }
    } catch {
      /* Usage statistics never block collaboration. */
    }
  }
  // Member records. The account owner may have one too, holding only its
  // verified email and preferences; it is never listed as a member.
  async members() {
    const owner = (await this.accountOwner()).uuid;
    return (await this.list("org:user:"))
      .map((r) => r.value)
      .filter((u) => u.uuid !== owner);
  }
  // User records with their latest recorded activity.
  async withActivity(users) {
    const seen = new Map(
      (await this.list("org:seen:")).map((r) => [
        r.key.slice("org:seen:".length),
        Number(r.value) || 0,
      ]),
    );
    return users.map((u) =>
      (seen.get(u.uuid) || 0) > (u.lastActive || 0)
        ? { ...u, lastActive: seen.get(u.uuid) }
        : u,
    );
  }
  async audit(actor, action, target = {}, details = {}) {
    const at = this.now(),
      iso = new Date(at).toISOString(),
      entry = {
        id: `${iso}:${rand()}`,
        at,
        time: iso,
        category: auditCategory(action),
        action,
        actor: actor
          ? { uuid: actor.uuid || null, username: actor.username || null }
          : { uuid: null, username: "system" },
        target: {
          type: target.type || null,
          id: target.id || null,
          name:
            typeof target.name === "string" ? target.name.slice(0, 200) : null,
        },
        board: target.board || (target.type === "board" ? target.id : null),
        details,
        ip:
          this.request?.headers.get("cf-connecting-ip") ||
          this.request?.headers.get("x-forwarded-for")?.split(",")[0] ||
          null,
        userAgent:
          this.request?.headers.get("user-agent")?.slice(0, 300) || null,
      };
    await this.store({ kind: "audit", entry, stored: false, activity: false });
    return entry;
  }
  // Writes an audit or notification record, after any that storage refused
  // earlier so the log keeps their order, and hands it on to delivery. A
  // record storage refuses waits for the next write or flush instead of
  // being lost.
  async store(record) {
    await this.retryUnsaved();
    if (!(await this.write(record))) this.queueUnsaved(record);
  }
  // Each write that succeeded is remembered, so a retry writes only what is
  // missing: an audit record has, for a board, its activity record too.
  async write(record) {
    const { entry } = record;
    try {
      if (record.kind === "notification") {
        await this.kv.set(
          `org:notif:${record.uuid}:${entry.id}`,
          entry,
          record.expires,
        );
        this.pendingNotifications ??= [];
        this.pendingNotifications.push({ uuid: record.uuid, entry });
        return true;
      }
      if (!record.stored) {
        await this.kv.set("org:audit:" + entry.id, entry);
        record.stored = true;
      }
      if (entry.board && !record.activity) {
        await this.kv.set(`org:bact:${entry.board}:${entry.id}`, {
          id: entry.id,
          at: entry.at,
          category: entry.category,
          action: entry.action,
          actor: entry.actor,
          target: entry.target,
          details: entry.details,
        });
        record.activity = true;
      }
      this.pending.push(entry);
      return true;
    } catch {
      return false;
    }
  }
  queueUnsaved(record) {
    const queue = (this.instance.unsaved ??= []);
    queue.push(record);
    // A long outage keeps the newest records rather than growing without
    // bound; the oldest are the ones most likely already reported.
    if (queue.length > UNSAVED_LIMIT)
      queue.splice(0, queue.length - UNSAVED_LIMIT);
  }
  // Writes queued records again, oldest first, and stops at the first write
  // storage still refuses.
  async retryUnsaved(limit = 25) {
    // Requests share this queue. Only one may drain it: two writers retrying
    // its head together would both shift, discarding the following record.
    const retry = (this.instance.retryingUnsaved ??= Promise.resolve().then(
      async () => {
        const queue = (this.instance.unsaved ??= []);
        for (let n = 0; n < limit && queue.length; n++) {
          if (!(await this.write(queue[0]))) return false;
          queue.shift();
        }
        return true;
      },
    ));
    try {
      return await retry;
    } finally {
      if (this.instance.retryingUnsaved === retry)
        this.instance.retryingUnsaved = null;
    }
  }
  async registerBoard(room, patch) {
    const key = "org:board:" + room,
      existing = await this.kv.get(key);
    let next;
    // Activity, counts and settings update the same record at once. Writing
    // only the patched fields keeps one request from restoring what another
    // just changed, such as making a private board visible again.
    if (existing && typeof this.kv.update === "function")
      next = await this.kv.update(
        key,
        Object.fromEntries(
          Object.entries(patch).map(([field, value]) => [
            `["${field}"]`,
            value ?? null,
          ]),
        ),
      );
    else {
      next = { ...(existing || { room, created: this.now() }), ...patch, room };
      await this.kv.set(key, next);
    }
    if (!existing || "visibility" in patch || "deleted" in patch) {
      if (next.visibility === "organization" && !next.deleted)
        await this.kv.set("org:visible:" + room, 1);
      else await this.kv.del("org:visible:" + room);
    }
    return next;
  }
  // Largest simultaneous session per board and per day, for capacity reports.
  async recordPeak(room, count) {
    const peaks = (this.caches.peaks ??= new Map()),
      today = day(this.now()),
      key = `${room}|${today}`;
    if ((peaks.get(key) || 0) >= count) return;
    if (peaks.size > 5000) peaks.clear();
    peaks.set(key, count);
    try {
      if (count > (Number(await this.kv.get("org:peak:" + today)) || 0))
        await this.kv.set(
          "org:peak:" + today,
          count,
          Math.floor((this.now() + 400 * DAY) / 1000),
        );
      const board = await this.kv.get("org:board:" + room);
      if (board && (board.peakParticipants || 0) < count)
        await this.registerBoard(room, {
          peakParticipants: count,
          peakAt: this.now(),
        });
    } catch {
      /* Usage statistics never block collaboration. */
    }
  }
  // Time spent on boards, from presence heartbeats (at most a minute each).
  // Seconds accumulate in memory and are written at most once a minute.
  async recordTime(ms, { flush = false } = {}) {
    const seconds = Math.round(Math.min(60_000, ms) / 1000);
    const time = this.instance.time;
    if (seconds > 0) time.seconds += seconds;
    time.since ||= this.now();
    if (!time.seconds || (!flush && this.now() - time.since < 60_000)) return;
    const amount = time.seconds;
    time.seconds = 0;
    time.since = this.now();
    try {
      await this.kv.incr(`org:time:${day(this.now())}`, amount);
    } catch {
      time.seconds += amount;
    }
  }
  async indexMembership(uuid, room, role) {
    if (role && role !== "removed")
      await this.kv.set(`org:ub:${uuid}:${room}`, role);
    else await this.kv.del(`org:ub:${uuid}:${room}`);
  }
  async notify(uuid, notification) {
    if (!uuid) return;
    // Deactivated people receive nothing, in the app or by email.
    if ((await this.user(uuid))?.status === "deactivated") return;
    const at = this.now(),
      iso = new Date(at).toISOString(),
      entry = {
        id: `${iso}:${rand()}`,
        at,
        read: false,
        ...notification,
      };
    await this.store({
      kind: "notification",
      uuid,
      entry,
      expires: Math.floor((at + 90 * DAY) / 1000),
    });
    return entry;
  }
  // Delivery that can happen after the response is decided: SIEM, webhooks,
  // alerts, email, and retention housekeeping. Nothing here can fail a request.
  async flush() {
    await this.retryUnsaved();
    const events = this.pending.splice(0);
    const notifications = (this.pendingNotifications || []).splice(0);
    if (!events.length && !notifications.length) return;
    let policy;
    try {
      policy = await this.policy();
    } catch {
      return;
    }
    await deliver(this, policy, events, notifications).catch(() => {});
  }
  async info(identity) {
    const [meta, owner, role] = await Promise.all([
      this.meta(),
      this.accountOwner(),
      this.role(identity),
    ]);
    const policy = meta?.policy || normalizePolicy();
    const user = await this.user(identity.uuid);
    return {
      configured: !!meta,
      name: policy.name || null,
      role,
      owner: owner.uuid,
      user: user
        ? {
            email: user.email || null,
            emailVerified: !!user.emailVerified,
            status: user.status,
            teams: user.teams || [],
            prefs: user.prefs || {},
          }
        : null,
      // The subset of policy clients need to shape their interface.
      policy: {
        ai: policy.ai,
        integrations: Object.fromEntries(
          Object.entries(policy.integrations).map(([k, v]) => [
            k,
            { enabled: !!v.enabled },
          ]),
        ),
        externalSharing: policy.externalSharing,
        guestAccess: policy.guestAccess,
        guestRole: policy.guestRole,
        restrictToOrganization: policy.restrictToOrganization,
        publicLinks: policy.publicLinks,
        membersCanCreate: policy.membersCanCreate,
        defaultVisibility: policy.defaultVisibility,
        domains: policy.domains,
        domainCapture: policy.domainCapture,
      },
    };
  }
  // Whether this identity may create boards on the organization's worker.
  async canCreate(identity) {
    const role = await this.role(identity);
    if (role === "owner" || role === "admin") return true;
    if (role !== "member") return false;
    return (await this.policy()).membersCanCreate;
  }
  async scheduledWork() {
    const now = this.now();
    if (now - this.caches.purged > 3600_000) {
      this.caches.purged = now;
      // Each run runs inside someone's request, so it removes a bounded
      // number of records; a backlog is worked through every minute, which
      // keeps up with about 144,000 records a day.
      const { more } = await purge(this, { budget: 100 }).catch(() => ({}));
      if (more) this.caches.purged = now - 3600_000 + 60_000;
    }
    if (now - this.caches.reported > 3600_000) {
      this.caches.reported = now;
      await sendScheduledReport(this).catch(() => {});
    }
    await retryWebhooks(this).catch(() => {});
    await retrySiem(this).catch(() => {});
    await sendHeldAlerts(this).catch(() => {});
  }
}
