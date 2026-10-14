import { DAY, administers, publicHost } from "./org.js";
import { commentExcerpt } from "../src/comments.js";
import { hash } from "../src/collaboration/protocol.js";
// Outbound delivery for organization events: SIEM export, signed webhooks,
// security alerts, and notification email. Every function here is best effort
// and bounded; the caller has already made the change durable.
// Board-level activity worth surfacing to administrators immediately.
export const ALERTS = {
  "board.visibility.link": "publicSharing",
  "board.guest.joined": "guestAccess",
  "board.role.changed": "permissionChanges",
  "board.transfer": "permissionChanges",
  "user.role.changed": "permissionChanges",
  "apikey.created": "permissionChanges",
  "policy.updated": "policyChanges",
};
const RANK = { viewer: 0, commenter: 1, editor: 2 };
// The alert an audit event raises, if any. Giving anyone with a board's
// public link more access is public sharing too.
export function alertKind(e) {
  if (e.action === "board.share.role")
    return e.details?.setting === "link" &&
      e.details.visibility === "link" &&
      RANK[e.details.to] > RANK[e.details.from]
      ? "publicSharing"
      : null;
  return ALERTS[e.action] || null;
}
const TIMEOUT = 5000;
const tokens = new Map();
const signal = () => AbortSignal.timeout(TIMEOUT);
const ALERT_TEXT = {
  "board.visibility.link": "A board was opened to anyone with the link",
  "board.guest.joined": "A guest joined a board",
  "board.role.changed": "Board permissions changed",
  "board.transfer": "A board was given a new owner",
  "user.role.changed": "An organization role changed",
  "apikey.created": "An API key was created",
  "policy.updated": "Organization policy changed",
  "board.share.role": "Anyone with a board’s link was given more access",
};
const ALERT_TEXT_FR = {
  "board.visibility.link":
    "Un tableau a été ouvert à toute personne ayant le lien",
  "board.guest.joined": "Un invité s’est joint à un tableau",
  "board.role.changed": "Les autorisations d’un tableau ont changé",
  "board.transfer": "Un tableau a un nouveau propriétaire",
  "user.role.changed": "Un rôle dans l’organisation a changé",
  "apikey.created": "Une clé d’API a été créée",
  "policy.updated": "La politique de l’organisation a changé",
  "board.share.role":
    "Toute personne ayant le lien d’un tableau a obtenu plus d’accès",
};
// Email goes out in both languages, English first; the worker does not know
// each reader's language.
export const bilingualSubject = (en, fr) => `${en} / ${fr}`;
// A chat post in both languages, English first, as email is.
const bilingualPost = (en, fr) => `${en}\n\n${fr}`;
export const bilingualBody = (en, fr) =>
  `(Le français suit.)\n\n${en}\n\n---\n\n${fr}`;
// Board content edits and API reads come in bursts; the other categories,
// such as a sharing, role, or security change, are few and are what a SIEM
// watches for.
const BURSTS = new Set(["content", "api"]);
export async function deliver(org, policy, events, notifications) {
  // Bursts are exported at most every few seconds per worker instance; the
  // cursor picks up anything written meanwhile, and retrySiem sends it if
  // no other audited change comes along. Any other exported event goes at
  // once, with whatever is waiting, so the last change before the
  // organization goes quiet is not held until it is next used.
  const exporting = policy.siem.mode !== "none";
  const exportNow =
    exporting &&
    (org.now() - org.instance.siem >= org.siemInterval ||
      events.some(
        (e) =>
          !BURSTS.has(e.category) &&
          policy.siem.categories.includes(e.category),
      ));
  if (exporting && !exportNow && events.length) org.instance.siemBacklog = true;
  await Promise.allSettled([
    exportNow ? exportAudit(org, policy) : null,
    webhooks(org, policy, events),
    alerts(org, policy, events),
    notificationMail(org, notifications),
    boardSlack(org, policy, notifications),
  ]);
}
// Microsoft Sentinel and other SIEM tools ingest a normalized flat record.
export function siemRecord(entry) {
  return {
    TimeGenerated: entry.time,
    EventId: entry.id,
    Category: entry.category,
    Action: entry.action,
    ActorId: entry.actor?.uuid || "",
    ActorName: entry.actor?.username || "",
    TargetType: entry.target?.type || "",
    TargetId: entry.target?.id || "",
    TargetName: entry.target?.name || "",
    BoardId: entry.board || "",
    SourceIp: entry.ip || "",
    UserAgent: entry.userAgent || "",
    Details: entry.details || {},
  };
}
// Read audit records written after the stored cursor, so records written by
// other worker instances are exported too. Records are read by the narrowest
// time prefix that keeps listings few: a recent cursor rereads at most the
// minute it falls in, not the whole day.
export async function unsentAudit(org, cursor, limit = 500, skip = null) {
  const now = org.now() + 1000;
  const resume = cursor ? Date.parse(cursor.slice(0, 24)) : NaN;
  const start = Number.isFinite(resume) ? resume : now - DAY;
  const span = now - start;
  const [size, step] =
    span <= 10 * 60_000
      ? [16, 60_000]
      : span <= 2 * DAY
        ? [13, 3_600_000]
        : [10, DAY];
  const rows = [];
  let previous = null;
  for (let at = start; rows.length < limit; at += step) {
    const part = new Date(Math.min(at, now)).toISOString().slice(0, size);
    if (part !== previous)
      await org.scan("org:audit:" + part, {}, (row) => {
        const id = row.key.slice("org:audit:".length);
        if ((!cursor || id > cursor) && !skip?.has(id)) rows.push(row.value);
        return rows.length >= limit;
      });
    previous = part;
    if (at >= now) break;
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}
// An audit record's id is its time, taken before it is written, so a record
// can land after a later one was exported. Each export rereads the minute
// before its cursor and skips the records it already sent. At most
// SIEM_RECENT sent ids are kept; once a burst fills them, the reread starts
// at the oldest id kept, so ids it forgot are never sent again and cannot
// fill every batch and hold the cursor in place.
const SIEM_OVERLAP = 60_000;
const SIEM_RECENT = 2000;
const overlapStart = (id) =>
  new Date(Date.parse(id.slice(0, 24)) - SIEM_OVERLAP).toISOString();
export async function siem(org, policy, { force = false } = {}) {
  const mode = policy.siem.mode;
  if (mode === "none") return { sent: 0 };
  const [cursor, recent] = await Promise.all([
    org.kv.get("org:siem:cursor"),
    org.kv.get("org:siem:recent"),
  ]);
  // A cursor saved before recent records were kept resumes after itself.
  const sent = new Set(recent || []);
  const from =
    cursor && recent
      ? recent.length >= SIEM_RECENT && recent[0] > overlapStart(cursor)
        ? recent[0]
        : overlapStart(cursor)
      : cursor;
  const rows = await unsentAudit(org, from, 500, sent);
  if (!rows.length && !force) return { sent: 0 };
  const categories = new Set(policy.siem.categories);
  const records = rows
    .filter((r) => categories.has(r.category))
    .map(siemRecord);
  const status = (await org.kv.get("org:siem:status")) || { sent: 0 };
  try {
    if (records.length || force) {
      // A test always includes its own record, after any waiting events.
      const batch = [
        ...records,
        ...(force
          ? [
              siemRecord({
                id: `${new Date(org.now()).toISOString()}:test`,
                time: new Date(org.now()).toISOString(),
                category: "admin",
                action: "siem.test",
                actor: { username: "system" },
              }),
            ]
          : []),
      ];
      if (mode === "sentinel") await sentinel(org, policy, batch);
      else await https(org, policy, batch);
      status.sent += batch.length;
    }
    if (rows.length) {
      const next = [cursor, rows.at(-1).id].filter(Boolean).sort().at(-1);
      const start = overlapStart(next);
      await org.kv.set(
        "org:siem:recent",
        [...sent, ...rows.map((r) => r.id)]
          .filter((id) => id > start)
          .sort()
          .slice(-SIEM_RECENT),
      );
      await org.kv.set("org:siem:cursor", next);
    } else if (cursor && !recent) await org.kv.set("org:siem:recent", []);
    status.lastSuccess = org.now();
    status.lastError = null;
    await org.kv.set("org:siem:status", status);
    return { sent: records.length, more: rows.length >= 500 };
  } catch (error) {
    status.lastError = String(error.message || error).slice(0, 300);
    status.lastErrorAt = org.now();
    await org.kv.set("org:siem:status", status);
    if (force) throw error;
    return { sent: 0, error: status.lastError };
  }
}
// Sends waiting audit records and notes whether any are left: ones that
// failed to send, or more than one batch holds.
async function exportAudit(org, policy) {
  org.instance.siem = org.now();
  const result = await siem(org, policy).catch((error) => ({ error }));
  org.instance.siemBacklog = !!(result.error || result.more);
}
// Audit records an export did not send, because they came within the export
// interval or the SIEM was unreachable, are sent even when no new audited
// change comes to send them along: as soon as the interval allows while this
// instance knows of some, and every quarter of an hour in case another
// instance left them.
export async function retrySiem(org) {
  const now = org.now(),
    wait = org.instance.siemBacklog ? org.siemInterval : 15 * 60_000;
  if (now - org.instance.siem < wait) return;
  org.instance.siem = now;
  const policy = await org.policy();
  if (policy.siem.mode !== "none") await exportAudit(org, policy);
}
// Azure Government and Azure China have their own sign-in and ingestion
// audience; the endpoint says which cloud a workspace is in.
const AZURE_CLOUDS = {
  com: { login: "login.microsoftonline.com", audience: "monitor.azure.com" },
  us: { login: "login.microsoftonline.us", audience: "monitor.azure.us" },
  cn: { login: "login.chinacloudapi.cn", audience: "monitor.azure.cn" },
};
export const azureCloud = (endpoint) =>
  AZURE_CLOUDS[new URL(endpoint).hostname.split(".").at(-1)] ||
  AZURE_CLOUDS.com;
async function sentinelToken(org, config) {
  const secret = await org.secret("sentinel");
  if (!secret) throw Error("Add the Sentinel client secret.");
  // Tokens are kept per secret, so a replaced secret is tried at once,
  // and a mistyped one fails its test rather than an hour later.
  const key = `${config.tenantId}|${config.clientId}|${await hash(secret)}`;
  const cached = tokens.get(key);
  if (cached && cached.expires > org.now() + 60_000) return cached.token;
  const { login, audience } = azureCloud(config.endpoint);
  const res = await org.fetcher(
    `https://${login}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: secret,
        scope: `https://${audience}//.default`,
        grant_type: "client_credentials",
      }),
      signal: signal(),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token)
    throw Error(
      `Microsoft Entra sign-in failed (${res.status}): ${data.error || "no token"}`,
    );
  if (tokens.size >= 100) tokens.delete(tokens.keys().next().value);
  tokens.set(key, {
    token: data.access_token,
    expires: org.now() + (Number(data.expires_in) || 3000) * 1000,
  });
  return data.access_token;
}
// Azure Monitor Logs Ingestion API, the documented path into Sentinel tables.
async function sentinel(org, policy, records) {
  const config = policy.siem.sentinel;
  if (
    !config.tenantId ||
    !config.clientId ||
    !config.endpoint ||
    !config.dcrId ||
    !config.stream
  )
    throw Error("Complete the Sentinel connection settings.");
  const token = await sentinelToken(org, config);
  for (const chunk of sentinelChunks(records)) {
    const res = await org.fetcher(
      `${config.endpoint}/dataCollectionRules/${encodeURIComponent(config.dcrId)}/streams/${encodeURIComponent(config.stream)}?api-version=2023-01-01`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: chunk,
        signal: signal(),
      },
    );
    if (!res.ok) throw Error(`Sentinel ingestion failed (${res.status}).`);
  }
}
// The ingestion API refuses a call over 1 MB, and a refused batch would be
// sent again at every export, holding back everything after it. Records go
// in calls kept under that by their encoded size, as a large group sync's
// member lists can make them several kilobytes each; a record too large to
// send alone keeps its fields but not its details.
const SENTINEL_BYTES = 1_000_000 - 50_000;
const encoder = new TextEncoder();
export function sentinelChunks(records) {
  const chunks = [];
  let parts = [],
    size = 2;
  for (const record of records) {
    let json = JSON.stringify(record);
    let bytes = encoder.encode(json).length;
    if (bytes + 2 > SENTINEL_BYTES) {
      json = JSON.stringify({
        ...record,
        Details: { truncated: true, bytes },
      });
      bytes = encoder.encode(json).length;
    }
    if (parts.length && size + bytes + 1 > SENTINEL_BYTES) {
      chunks.push(`[${parts.join(",")}]`);
      parts = [];
      size = 2;
    }
    parts.push(json);
    size += bytes + 1;
  }
  if (parts.length) chunks.push(`[${parts.join(",")}]`);
  return chunks;
}
async function https(org, policy, records) {
  if (!policy.siem.url) throw Error("Add the SIEM HTTPS endpoint.");
  // Endpoints saved before private addresses were refused are checked here.
  if (!publicHost(new URL(policy.siem.url).hostname))
    throw Error("The SIEM endpoint must use a public internet address.");
  const token = await org.secret("siem-token");
  const res = await org.fetcher(policy.siem.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ source: "whiteboard", events: records }),
    redirect: "error",
    signal: signal(),
  });
  if (!res.ok) throw Error(`SIEM endpoint returned ${res.status}.`);
}
export async function hmac(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(sig)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export const hookMatches = (hook, action) =>
  hook.events.includes("*") ||
  hook.events.some((e) => action === e || action.startsWith(e + "."));
export async function sendHook(org, hook, entry) {
  if (!publicHost(new URL(hook.url).hostname))
    throw Error("Webhooks must use a public internet address.");
  const secret = await org.kv.get("org:hooksecret:" + hook.id);
  // Every webhook has a secret, so none means it was deleted, which another
  // instance may not know yet; deliveries are always signed.
  if (!secret) {
    if (!(await org.kv.get("org:webhook:" + hook.id))) return;
    throw Error("The webhook secret is not available yet.");
  }
  const body = JSON.stringify({
    id: entry.id,
    event: entry.action,
    created: entry.time,
    data: entry,
  });
  const res = await org.fetcher(hook.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Whiteboard-Webhooks/1",
      "X-Whiteboard-Event": entry.action,
      "X-Whiteboard-Delivery": entry.id,
      "X-Whiteboard-Signature": "sha256=" + (await hmac(secret, body)),
    },
    body,
    signal: signal(),
    redirect: "error",
  });
  if (!res.ok) throw Error(`Webhook returned ${res.status}.`);
}
// Like an API key, a webhook ends with its maker's administration. One made
// with an API key belongs to the administrator who made that key; an older
// one that does not record them is traced through the key, if it remains.
async function activeHooks(org) {
  const hooks = (await org.list("org:webhook:")).map((r) => r.value);
  let keys = null;
  const current = async (maker) => {
    if (!maker) return true;
    if (maker.startsWith("apikey-")) {
      keys ??= org
        .list("org:apikey:")
        .then((rows) => new Map(rows.map(({ value }) => [value.id, value])));
      const key = (await keys).get(maker.slice("apikey-".length));
      if (!key) return false;
      if (!key.createdBy) return true;
      maker = key.createdBy;
    }
    return administers(org, maker);
  };
  const kept = await Promise.all(
    hooks.map((h) => current(h.admin || h.createdBy)),
  );
  return hooks.filter((_, n) => kept[n]);
}
async function webhooks(org, policy, events) {
  if (!policy.integrations.webhooks.enabled) return;
  // The subscription list is cached for a minute per worker instance.
  const cache = org.instance.hooks;
  const hooks =
    cache && org.now() - cache.at < 60_000
      ? cache.list
      : await activeHooks(org);
  if (!cache || cache.list !== hooks)
    org.instance.hooks = { list: hooks, at: org.now() };
  const now = org.now();
  // Deliveries run in parallel, so a slow receiver adds its timeout once per
  // request rather than once per event. One request sends at most 20; the
  // rest wait in the retry queue, which later requests send a few at a
  // time, so an edit with thousands of comments never opens thousands of
  // connections. Each carries its id and time.
  const queue = (hook, entry, attempts = 1, next = now + 60_000) => {
    org.instance.hookBacklog = true;
    return org.kv.set(`org:hookq:${hook.id}:${entry.id}`, {
      hook: hook.id,
      entry,
      attempts,
      next,
    });
  };
  // A receiver that just failed is not sent to again for half a minute; its
  // events wait in the queue. Without this, one that stops answering adds
  // its timeout to every request that records something, rather than to
  // one request every half minute on this instance.
  const down = (org.instance.hooksDown ??= new Map());
  const resting = (hook) => now - (down.get(hook.id) ?? -Infinity) < 30_000;
  const sent = (hook) => down.delete(hook.id);
  const failed = (hook) => down.set(hook.id, org.now());
  const jobs = hooks
    .filter((h) => h.enabled)
    .flatMap((hook) =>
      events
        .filter((e) => hookMatches(hook, e.action))
        .map((entry) => [hook, entry]),
    );
  const sending = Promise.all(
    jobs.map(([hook, entry], n) =>
      n < 20 && !resting(hook)
        ? sendHook(org, hook, entry).then(
            () => sent(hook),
            () => (failed(hook), queue(hook, entry)),
          )
        : queue(hook, entry, 0, now),
    ),
  );
  // Retry earlier failures with exponential backoff, a few per webhook so an
  // unreachable receiver never holds up the others. A receiver that has been
  // failing for a day loses the queued events it has had a retry for; an
  // event not tried again since it failed, as when nothing ran for a day,
  // gets that retry first. Retries run alongside the new sends, so a
  // receiver that does not answer delays a request once.
  const stale = new Date(now - DAY).toISOString();
  let backlog = false;
  const retrying = Promise.all(
    hooks
      .filter((h) => h.enabled)
      .map(async (hook) => {
        if (resting(hook)) {
          backlog = true;
          return;
        }
        const prefix = `org:hookq:${hook.id}:`;
        // Events still backing off come first in the queue; looking past
        // them finds ones that are due, such as those a burst left waiting.
        let queued = await org.list(prefix, { limit: 100 });
        if (queued[0] && queued[0].key.slice(prefix.length) < stale) {
          let untried = false;
          for (const row of await org.list(prefix)) {
            if (row.key.slice(prefix.length) >= stale) continue;
            if (row.value?.attempts >= 2) await org.kv.del(row.key);
            else untried = true;
          }
          if (!untried) return;
          queued = await org.list(prefix, { limit: 100 });
        }
        if (queued.length) backlog = true;
        const retry = async ({ key, value }) => {
          try {
            await sendHook(org, hook, value.entry);
            sent(hook);
            await org.kv.del(key);
            return true;
          } catch (error) {
            failed(hook);
            // Six attempts in all: the first send and five retries.
            if (value.attempts >= 5) await org.kv.del(key);
            else
              await org.kv.set(key, {
                ...value,
                attempts: value.attempts + 1,
                next: now + 60_000 * 2 ** value.attempts,
                error: String(error.message).slice(0, 200),
              });
          }
        };
        const due = queued
          .filter(({ value }) => value.next <= now)
          .slice(0, 10);
        // A receiver that failed before is tried with one event first.
        if (down.has(hook.id) && due.length && !(await retry(due.shift())))
          return;
        await Promise.all(due.map(retry));
      }),
  );
  await Promise.all([sending, retrying]);
  if (!backlog && !jobs.length) org.instance.hookBacklog = false;
}
// Failed deliveries are tried again even when no new event comes to send
// them along: every minute while this instance knows of some, and every
// quarter of an hour in case another instance left them.
export async function retryWebhooks(org) {
  const now = org.now(),
    wait = org.instance.hookBacklog ? 60_000 : 15 * 60_000;
  if (now - (org.instance.hooksRetried || 0) < wait) return;
  org.instance.hooksRetried = now;
  const policy = await org.policy();
  if (policy.integrations.webhooks.enabled) await webhooks(org, policy, []);
}
export async function slack(org, url, text) {
  if (!url || !/^https:\/\/hooks\.slack\.com\//.test(url)) return;
  await org.fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Slack reads <...> as links and mentions such as <!channel>; text
    // people wrote is escaped so it shows as written.
    body: JSON.stringify({
      text: text
        .slice(0, 3000)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
    }),
    signal: signal(),
  });
}
// Sends through whichever method this runtime's SDK has: sendTransactional
// now, send before it. Answers Puter's result ({ failed, suppressed }), or
// null when the runtime cannot send mail at all.
export async function mail(org, to, subject, body) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const email = org.puter.email;
  const send =
    typeof email?.sendTransactional === "function"
      ? (message) => email.sendTransactional(message)
      : typeof email?.send === "function"
        ? (message) => email.send(message)
        : null;
  if (!recipients.length || !send) return null;
  return (
    (await send({
      to: recipients.slice(0, 10),
      subject: subject.slice(0, 200),
      text: body,
    })) || {}
  );
}
// Whether Puter accepted a message for this address: a runtime without
// mail, or an address it reports as failed or suppressed, received nothing.
export const delivered = (result, address) =>
  !!result &&
  ![...(result.failed || []), ...(result.suppressed || [])].includes(address);
// Notification mail goes out while the edit that caused it waits for its
// acknowledgement, so a slow mail service delays saving only so long.
const NOTIFICATION_MAIL_WAIT = 5000;
// An alert's heading; one for several events counted together says how
// many.
function alertLabel(entry, french = false) {
  if (entry.count > 0)
    return french
      ? entry.count === 1
        ? "1 autre invité s’est joint à un tableau"
        : `${entry.count} autres invités se sont joints à un tableau`
      : entry.count === 1
        ? "1 more guest joined a board"
        : `${entry.count} more guests joined a board`;
  return (french ? ALERT_TEXT_FR : ALERT_TEXT)[entry.action] || entry.action;
}
function describe(entry, french = false) {
  const who = entry.actor?.username || (french ? "Quelqu’un" : "Someone");
  const name = entry.target?.name;
  const what = name ? (french ? ` « ${name} »` : ` "${name}"`) : "";
  const label = alertLabel(entry, french);
  return entry.count > 0
    ? `${label}${french ? " :" : ":"}${what || " —"} (${entry.time})`
    : `${label}${french ? " :" : ":"} ${who}${what} (${entry.time})`;
}
// Guests joining a board in numbers would each alert every administrator
// and send mail. The first in each window is told of at once; the rest are
// counted, in storage so every instance counts them, and told of together
// in one alert once the window ends (see sendHeldAlerts).
const HELD_ALERTS = new Set(["board.guest.joined"]);
const ALERT_WINDOW = 10 * 60_000;
async function sendsNow(org, entry) {
  if (!HELD_ALERTS.has(entry.action) || !entry.board) return true;
  const window = Math.floor(org.now() / ALERT_WINDOW),
    at = `${entry.action}:${entry.board}:${window}`;
  try {
    const count = await org.kv.incr("org:alertcount:" + at);
    if (count === 1) {
      await org.kv
        .expire("org:alertcount:" + at, (2 * ALERT_WINDOW) / 1000)
        .catch(() => {});
      return true;
    }
    // The count stays until the rest are told of.
    if (count === 2) {
      await org.kv.expire("org:alertcount:" + at, 7 * 86400).catch(() => {});
      await org.kv.set("org:alerthold:" + at, {
        action: entry.action,
        board: entry.board,
        window,
        ...(entry.target ? { target: entry.target } : {}),
      });
    }
    return false;
  } catch {
    // Unable to count, the alert goes out rather than being lost.
    return true;
  }
}
// Tells of the events held back in windows that have ended, each window's
// in one alert. Each instance looks at most once a minute, and only one
// sends each.
export async function sendHeldAlerts(org) {
  const now = org.now();
  if (now - (org.instance.alertsHeld || 0) < 60_000) return;
  org.instance.alertsHeld = now;
  const policy = await org.policy();
  if (![...HELD_ALERTS].some((action) => policy.alerts[ALERTS[action]])) return;
  const ready = [];
  for (const { key, value } of await org.list("org:alerthold:", {
    limit: 100,
  })) {
    if (!value || (value.window + 1) * ALERT_WINDOW > now) continue;
    const at = key.slice("org:alerthold:".length);
    if ((await org.kv.incr("org:alertsent:" + at)) !== 1) continue;
    await org.kv.expire("org:alertsent:" + at, 86400).catch(() => {});
    const count = await org.kv.get("org:alertcount:" + at);
    await org.kv.del("org:alerthold:" + at);
    await org.kv.del("org:alertcount:" + at);
    if (count > 1)
      ready.push({
        action: value.action,
        board: value.board,
        target: value.target,
        count: count - 1,
        time: new Date(now).toISOString(),
      });
  }
  if (ready.length) await sendAlerts(org, policy, ready);
}
async function alerts(org, policy, events) {
  const matching = [];
  for (const e of events)
    if (alertKind(e) && policy.alerts[alertKind(e)] && (await sendsNow(org, e)))
      matching.push(e);
  if (matching.length) await sendAlerts(org, policy, matching);
}
async function sendAlerts(org, policy, matching) {
  const lines = matching.map((e) => describe(e)).join("\n");
  const admins = [
    ...new Set([(await org.accountOwner()).uuid, ...(await org.adminIds())]),
  ];
  // Each administrator is told at once rather than one after another.
  for (const entry of matching)
    await Promise.allSettled(
      admins.map((uuid) =>
        org.notify(uuid, {
          type: "alert",
          action: entry.action,
          board: entry.board,
          text: describe(entry),
          // The app words the alert in each person's language.
          label: ALERT_TEXT[entry.action] || entry.action,
          ...(entry.count > 0 ? { count: entry.count } : {}),
          who: entry.actor?.username || null,
          ...(entry.target?.name ? { target: entry.target.name } : {}),
        }),
      ),
    );
  await Promise.allSettled([
    mail(
      org,
      policy.alerts.emails,
      bilingualSubject(
        `Whiteboard security alert: ${alertLabel(matching[0])}`,
        `Alerte de sécurité Whiteboard : ${alertLabel(matching[0], true)}`,
      ),
      bilingualBody(
        `${lines}\n\nReview the audit log in Organization settings.`,
        `${matching.map((e) => describe(e, true)).join("\n")}\n\nConsultez le journal d’audit dans les paramètres de l’organisation.`,
      ),
    ),
    policy.alerts.slack && policy.integrations.slack.enabled
      ? org
          .secret("slack")
          .then((url) =>
            slack(
              org,
              url,
              bilingualPost(
                lines,
                matching.map((e) => describe(e, true)).join("\n"),
              ),
            ),
          )
      : null,
  ]);
}
// A notification in both languages, from the parts it carries.
function notificationWords(entry) {
  // Long board titles are shortened so both halves of the subject fit.
  const title = entry.boardTitle || "";
  // An anonymous contribution names no one, in either language.
  const who = entry.anonymous ? "A participant" : entry.actor?.username || "",
    whoFr = entry.anonymous ? "Un participant" : who,
    board =
      title.length > 60 ? `${commentExcerpt(title, 59).trimEnd()}…` : title;
  const subjects = {
    mention: [
      `${who} mentioned you on ${board}`,
      `${whoFr} vous a mentionné dans ${board}`,
    ],
    reply: [`${who} replied on ${board}`, `${whoFr} a répondu dans ${board}`],
    assignment: entry.more
      ? [
          `${who} assigned you tasks on ${board}`,
          `${whoFr} vous a assigné des tâches dans ${board}`,
        ]
      : [
          `${who} assigned you a task on ${board}`,
          `${whoFr} vous a assigné une tâche dans ${board}`,
        ],
  }[entry.type];
  const more = entry.more > 0 ? entry.more : 0;
  const text =
    entry.type === "assignment" && typeof entry.title === "string"
      ? [
          `${who}: ${entry.title}${entry.due ? ` (due ${entry.due})` : ""}${more ? ` and ${more} more` : ""}`,
          `${whoFr} : ${entry.title === "Untitled task" ? "Tâche sans titre" : entry.title}${entry.due ? ` (échéance le ${entry.due})` : ""}${more ? ` et ${more} ${more === 1 ? "autre" : "autres"}` : ""}`,
        ]
      : typeof entry.excerpt === "string"
        ? [`${who}: ${entry.excerpt}`, `${whoFr} : ${entry.excerpt}`]
        : [entry.text || "", entry.text || ""];
  const fallback = [
    entry.subject || "You have a new Whiteboard notification",
    "Vous avez une nouvelle notification Whiteboard",
  ];
  const [subjectEn, subjectFr] = who && subjects ? subjects : fallback;
  return {
    en: { subject: subjectEn, text: text[0] },
    fr: { subject: subjectFr, text: text[1] },
  };
}
// Each person's mail is sent at once rather than one after another.
async function notificationMail(org, notifications) {
  await Promise.allSettled(
    notifications.map(async ({ uuid, entry }) => {
      if (!["mention", "reply", "assignment"].includes(entry.type)) return;
      const user = await org.user(uuid);
      if (!user?.email || !user.emailVerified) return;
      if (user.prefs?.emailNotifications === false) return;
      const { en, fr } = notificationWords(entry);
      const link = (label) => (entry.url ? `\n\n${label}${entry.url}` : "");
      let timer;
      await Promise.race([
        mail(
          org,
          user.email,
          bilingualSubject(en.subject, fr.subject),
          bilingualBody(
            `${en.text}${link("Open the board: ")}`,
            `${fr.text}${link("Ouvrir le tableau : ")}`,
          ),
        ),
        new Promise(
          (resolve) => (timer = setTimeout(resolve, NOTIFICATION_MAIL_WAIT)),
        ),
      ]).finally(() => clearTimeout(timer));
    }),
  );
}
// Whoever connected a board's channel still owns the board and can use
// the organization, or administers it.
async function connectorManages(org, room, uuid) {
  if (await administers(org, uuid)) return true;
  const meta = await org.kv.get(`wb:${room}:meta`);
  return meta?.owner === uuid && !!(await org.role({ uuid }));
}
async function boardSlack(org, policy, notifications) {
  if (!policy.integrations.slack.enabled) return;
  const seen = new Set();
  for (const { entry } of notifications) {
    if (!entry.board || !entry.channel || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const key = "org:boardslack:" + entry.board,
      value = await org.kv.get(key);
    // Channels connected before the connector was recorded are plain URLs.
    const url = typeof value === "string" ? value : value?.url;
    if (!url) continue;
    if (value?.by && !(await connectorManages(org, entry.board, value.by))) {
      await org.kv.del(key);
      continue;
    }
    // The channel is told which board, in both languages, with a link to
    // it once the app's address is known.
    const title = entry.boardTitle,
      who = entry.actor?.username;
    const post =
      title && who && typeof entry.excerpt === "string"
        ? bilingualPost(
            `${who} commented on ${title}: ${entry.excerpt}`,
            `${who} a commenté dans ${title} : ${entry.excerpt}`,
          )
        : entry.text || "";
    await slack(org, url, post + (entry.url ? `\n\n${entry.url}` : "")).catch(
      () => {},
    );
  }
}
