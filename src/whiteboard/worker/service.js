import { diffUpdate, getState, mergeUpdates, parseUpdateMeta } from "yjs";
import {
  validateCommentChanges,
  commentExcerpt,
  updateCommentAnchors,
  validateCommentGrowth,
  mentions,
} from "../src/comments.js";
import {
  concealment,
  contributionKey,
  workshopSettings,
  validateWorkshopChanges,
  validateWorkshopWrites,
  workshopEvents,
} from "../src/facilitation/model.js";
import { SharedDocument } from "../src/collaboration/document.js";
import { sameJSON } from "../src/same-json.js";
import { ListingQueue } from "./listings.js";
import { oversized, MAX_OBJECTS } from "../src/model.js";
import { providerGroup } from "../src/content/providers.js";
import { assignmentChanges } from "../src/planning/task.js";
import { capturedTaskTitle } from "../src/planning/task-title.js";
import { canonicalLanguage } from "../src/accessibility/language-tag.js";
import { appendRun, sliceTextRuns } from "../src/rich-text.js";
import {
  ASSET,
  ID,
  ROLES,
  SESSION_TTL,
  MAX_UPDATE,
  PEER_GROUP,
  canComment,
  canEditContent,
  canManage,
  decode,
  encode,
  hash,
  keyPair,
  sign,
} from "../src/collaboration/protocol.js";
import {
  AccessStamp,
  BOARD_ROLES,
  DAY,
  OrgService,
  guestRole,
  guestsShutOut,
  keepWritten,
  normalizePolicy,
  readKept,
  standing,
} from "./org.js";

const fail = (status, message) => {
  throw Object.assign(Error(message), { status });
};
const id = (value) => {
  if (typeof value !== "string" || !ID.test(value))
    fail(400, "Invalid identifier.");
  return value;
};
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
// Embeds the board's organization has turned off are not added, nor
// pointed somewhere new; those already on the board stay, as they do for
// the app, which shows them as turned off. A table's source is always a
// Google Sheet, so a table linked to one is a Google embed too.
function validateEmbeds(before, after, features) {
  const kept = new Map(
    before
      .filter((i) => i.type === "embed" || i.sourceUrl)
      .map((i) => [i.id, i]),
  );
  for (const i of after) {
    if (i.type !== "embed" && !i.sourceUrl) continue;
    const was = kept.get(i.id);
    if (
      was &&
      was.url === i.url &&
      was.provider === i.provider &&
      was.sourceUrl === i.sourceUrl
    )
      continue;
    const group = i.sourceUrl ? "google" : providerGroup(i.provider);
    if (group === "google" && !features.integrations.google)
      throw Error(
        "This board’s organization has turned off Google Workspace integrations.",
      );
    if (group === "embeds" && !features.integrations.embeds)
      throw Error("This board’s organization has turned off embedded content.");
  }
}
// What the board's organization allows in the app. People from outside
// it, guests and members of other organizations, follow it on its boards
// as its members do; their own organization's choices apply as well.
const boardFeatures = (policy) => ({
  ai: { ...policy.ai },
  integrations: {
    google: policy.integrations.google?.enabled !== false,
    embeds: policy.integrations.embeds?.enabled !== false,
  },
});
// Records written up to this long before a checkpoint or cached state are
// read again, covering records that became visible late.
const LOG_OVERLAP = 120_000;
// Refreshing a cached state reads a shorter overlap.
const REFRESH_OVERLAP = 15_000;
// A busy board is checkpointed at most this often, unless records build up
// far past the usual count; each checkpoint is a copy of the whole board.
const CHECKPOINT_GAP = 5 * 60_000;
// How long a cached board state is used without checking for new records.
const FRESH = 1500;
// How long after a save's record is written a listing surely shows it, and
// how often a board whose signal shows no save is listed anyway; see
// BoardService.recheck.
const SETTLE = 1500;
// Boards recounted in the request that changed someone's role, and in each
// later batch (see recountBoardsOf).
const RECOUNT_NOW = 20,
  RECOUNT_BATCH = 40;
const BACKSTOP = 60_000;
// The least time between an instance's listings of a board's log made for
// callers told of a save, who wait for the next one meanwhile.
const PACE = 1000;
// Each instance's cached boards; see BoardService.board.
export const DOCS = new Map();
// Boards an instance keeps loaded as documents, most recently used first.
const LIVE = 4;
// The fullest peer group with room for another session, or the first one
// no one is in, so groups stay few and full.
export function peerGroup(present) {
  const sizes = new Map();
  for (const p of present)
    if (p.topology === 2 && Number.isSafeInteger(p.group))
      sizes.set(p.group, (sizes.get(p.group) || 0) + 1);
  let best = null;
  for (const [group, size] of sizes)
    if (
      size < PEER_GROUP &&
      (best === null ||
        size > sizes.get(best) ||
        (size === sizes.get(best) && group < best))
    )
      best = group;
  if (best !== null) return best;
  let group = 0;
  while (sizes.has(group)) group++;
  return group;
}
// Applies saved edits to a loaded board, counting changes so a projection
// of it is reused only while it is current.
function applySaved(doc, update) {
  let changed = false;
  const noted = () => (changed = true);
  doc.doc.on("update", noted);
  try {
    doc.apply(update, "stored");
  } finally {
    doc.doc.off("update", noted);
  }
  if (changed) doc.version = (doc.version || 0) + 1;
}
// The ids of the records a cached copy of a board holds, as far back as a
// caller told of a save could still name it; the oldest give way.
function recent(entry, id) {
  if (typeof id !== "string" || !id) return;
  entry.recent.delete(id);
  entry.recent.add(id);
  if (entry.recent.size > 4096)
    entry.recent.delete(entry.recent.values().next().value);
}
// Each board's metadata and memberships, as this instance read them, and
// each board's access stamp; see AccessStamp in org.js.
const RECORDS = new Map();
const STAMPS = new Map();
// For changes made outside BoardService, such as account linking.
export function forgetRecords(prefix) {
  for (const key of RECORDS.keys())
    if (key.startsWith(prefix)) RECORDS.delete(key);
}
// Has every instance read a board's metadata and memberships again, after
// they change.
export async function accessChanged(kv, room) {
  await kv.set(`wb:${room}:access`, crypto.randomUUID()).catch(() => {
    /* Instances read them again within KEEP anyway. */
  });
}
export const FILES = new Map();
FILES.bytes = 0;
// Holds a file, counting its size, and lets go of the least recently used
// ones past 48 MB.
function keepFile(path, text) {
  const old = FILES.get(path);
  if (old !== undefined) {
    FILES.delete(path);
    FILES.bytes -= old.length;
  }
  FILES.set(path, text);
  FILES.bytes += text.length;
  for (const [key, value] of FILES) {
    if (FILES.bytes <= 48_000_000 || FILES.size <= 1) break;
    FILES.delete(key);
    FILES.bytes -= value.length;
  }
}
// Identical commits in flight in this worker instance share one write.
const COMMITS = new Map();
// Each board's presence tickets by key, as this instance last listed them.
// Check-ins reuse the list for two seconds, so in a large room each costs
// about one write rather than also listing everyone present. After that
// it is kept while the board's roster stamp, written whenever someone
// joins or leaves, is unchanged (as the board's signal is for its edits;
// see BoardService.recheck), until a ticket it holds could lapse: people
// still present renew theirs before then, possibly through another
// instance. Changes made through this instance apply at once.
const PRESENCE = new Map();
const due = (hit, now) => {
  let at = hit.at + SESSION_TTL;
  for (const ticket of hit.rows.values())
    if (ticket?.expires > now) at = Math.min(at, ticket.expires - 5000);
  return at;
};
// Each board's presence being checked or listed by this instance.
const ROSTERS = new Map();
// Each board's member records as last listed; see members().
const MEMBER_LISTS = new Map();
const MEMBERS_FRESH = 5000;
// This instance's listings in flight, by when each began, and those waiting
// their turn. Puter allows a worker five at once on paid plans and three on
// free ones, across all its instances, so each instance runs two. Puter's
// SDK retries a refused request for about twelve seconds before failing,
// so a listing in flight over two seconds, or one refused in the last ten,
// means the worker is out of listings for now: copies are then answered
// from as they are rather than listed again, and a caller waits for a
// refresh at most three seconds.
const LISTS = new ListingQueue();
const STALLED = 2000;
const REFUSED = 10_000;
const PATIENCE = 3000;
const refused = (error) =>
  error?.status === 429 ||
  error?.code === "too_many_requests" ||
  /too many/i.test(String(error?.message ?? error?.error?.message ?? ""));
// Requests made while editing, which wait on nothing else.
const EDITING = new Set([
  "commit",
  "sync",
  "presence",
  "leave",
  "asset.get",
  "asset.put",
]);
// When each board was last read again from its checkpoint to find an edit a
// commit builds on.
const RELOADS = new Map();
// Board event signals being written by this instance; see notify.
const SIGNALS = new Map();
// Who owns each Yjs client ID a board's commits have added content under.
// An owner never changes, so an instance remembers the ones it has read.
const CLIENTS = new Map();
// New Yjs clients one commit may claim; see clientClaims.
const MAX_CLIENT_CLAIMS = 32;
const keepClient = (key, owner) => {
  CLIENTS.delete(key);
  if (CLIENTS.size >= 20_000) CLIENTS.delete(CLIENTS.keys().next().value);
  CLIENTS.set(key, owner);
};
// Records a person can add to the audit log by reporting exports and
// restorations, per board and minute in this instance. Every real action
// stays recorded; a flood from a crafted client is refused.
const REPORTS = new Map();
const REPORT_LIMIT = 20;
// Reading a version replays its edits, several storage requests each, so
// one person browsing versions cannot use up the worker's request quota.
const HISTORY_READ_LIMIT = 60;
// Shared images and files: how many one person adds to a board a minute,
// and how much a board holds in all.
const ASSET_PUTS = 60,
  ASSET_BYTES = 1024 ** 3;
// A digest of the search text this instance last stored for each board.
const INDEXED = new Map();
const INVITE_ROLES = ["facilitator", "editor", "commenter", "viewer"];
// Why a guest cannot be given a role, by the highest role guests may have.
const GUEST_ROLE_LIMITS = {
  editor: "Your organization does not let guests facilitate boards.",
  commenter:
    "Your organization lets guests view and comment on boards, not edit them.",
  viewer: "Your organization lets guests only view boards.",
};
const INVITE_DAYS = 7;
// The largest encoded update a commit carries, as the client's session.js.
const UPDATE_LIMIT = 8_000_000;
// Everything a commenter must not change. Comments and workshop registers
// (votes, poll answers, reactions) are excluded here and checked per author
// by validateCommentChanges and validateWorkshopChanges instead.
// Whether two projections of a board hold the same content, as their JSON
// would say, comparing object by object.
const sameContent = (a, b) =>
  sameJSON(
    [a.title, a.tags || [], a.timer || null, a.planning || null],
    [b.title, b.tags || [], b.timer || null, b.planning || null],
  ) &&
  a.items.length === b.items.length &&
  a.items.every((item, n) => sameJSON(item, b.items[n]));

export function appUid(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(new TextDecoder().decode(decode(part)));
    if (p.app_uid) return p.app_uid;
    if (p.au?.includes("-")) return p.au;
    const b = decode(p.au.replace(/_/g, "/"));
    if (b.length !== 16) return null;
    const h = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
    return `app-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    return null;
  }
}
// How much of a board's text the organization's search holds: well within
// what one storage value takes (the worker stores edits of up to
// MAX_UPDATE bytes as one), even in three-byte characters, while a search
// that reads every board's text stays affordable.
const SEARCH_TEXT = 32_000;
// What the board's own search finds in an object (src/board-search.js).
function searchable(i, tags) {
  return [
    i.text,
    i.alt,
    i.fileName,
    i.url,
    i.objectLink?.url,
    ...new Set((i.textRuns || []).map((r) => r.style?.link).filter(Boolean)),
    ...(i.cells?.flat() || []),
    ...(i.tagIds || []).map((id) => tags.get(id)),
    i.task?.assignee?.name,
    i.task?.jira?.key,
  ]
    .filter(Boolean)
    .join(" ");
}
// Summaries for the organization's board directory and search.
export function boardSummary(board) {
  const types = {};
  const all = [];
  // Search finds only what participants can see: not what the workshop
  // hides, stages, or keeps private.
  const c = concealment(board, "", false),
    concealed = new Set([...c.hidden, ...c.frames, ...c.notes]);
  for (const i of board.items) {
    types[i.type] = (types[i.type] || 0) + 1;
    const value = [i.text, i.fileName, ...(i.cells?.flat() || [])]
      .filter(Boolean)
      .join(" ");
    // Everything, hidden or not, tells boards with the same content apart,
    // so boards that began from one large template and went separate ways
    // are not taken for copies. Only its digest is kept.
    if (value) all.push(value);
  }
  // A board with more text than search holds keeps its newest objects'
  // text, which come last in stacking order, rather than its oldest.
  const tags = new Map((board.tags || []).map((t) => [t.id, t.name]));
  const words = [];
  let length = 0;
  for (let n = board.items.length - 1; n >= 0; n--) {
    if (length >= SEARCH_TEXT) break;
    const i = board.items[n];
    if (concealed.has(i.id)) continue;
    const value = searchable(i, tags);
    if (!value) continue;
    words.push(value.slice(0, SEARCH_TEXT - length));
    length += value.length + 1;
  }
  return {
    title: board.title,
    objectCount: board.items.length,
    types,
    text: words.reverse().join("\n"),
    content: all.join("\n"),
  };
}
// Edits form one version until a pause of five minutes, and a version ends
// with each quarter of an hour by the clock, so a long session leaves
// points to go back to inside it. Where versions split then depends only
// on the edits on either side, not on where the session began, so a page
// of versions is read without reading back to its session's start.
const VERSION_GAP = 5 * 60_000,
  VERSION_SPAN = 15 * 60_000;
const quarter = (at) => Math.floor(at / VERSION_SPAN);
// Group the edit log, oldest first, into versions, newest first.
export function historyVersions(records, gap = VERSION_GAP, limit = 300) {
  const versions = [];
  let current = null;
  for (const r of records) {
    if (
      !current ||
      r.at - current.until > gap ||
      quarter(r.at) !== quarter(current.start)
    ) {
      current = { start: r.at, until: r.at, edits: 0, authors: [] };
      versions.push(current);
    }
    current.until = r.at;
    current.edits++;
    const name = r.username || "Participant";
    if (!current.authors.includes(name) && current.authors.length < 10)
      current.authors.push(name);
  }
  return versions
    .reverse()
    .slice(0, limit)
    .map((v) => ({ ...v, at: v.until }));
}
// The names a message mentions (src/comments.js), shared with the app.
export { mentions };

// How much of a document waits for edits it has not seen: the clocks it
// misses, and the bytes of edits and deletions held back for them.
function pendingSize(store) {
  return {
    missing: store.pendingStructs?.missing.size || 0,
    structs: store.pendingStructs?.update.length || 0,
    deletes: store.pendingDs?.length || 0,
  };
}
export class BoardService {
  constructor(puter, { now = Date.now, fetcher = fetch, org, request } = {}) {
    this.puter = puter;
    this.kv = puter.kv;
    this.now = now;
    this.fetcher = fetcher;
    this.org = org || new OrgService(puter, { now, fetcher, request });
    // The organization's listings take their turn with the boards'.
    this.org.lists ??= (options) => this.listPage(options);
  }
  // One request of a listing, in turn; see LISTS.
  async listPage(options) {
    try {
      return await LISTS.run(
        () => this.kv.list(options),
        () => this.now(),
        (ms) => this.wait(ms),
      );
    } catch (error) {
      if (refused(error)) LISTS.refused = this.now();
      throw error;
    }
  }
  // Whether this instance is out of listings for now; see LISTS.
  short() {
    const now = this.now();
    return (
      now - LISTS.refused < REFUSED ||
      [...LISTS.running].some((turn) => now - turn.at > STALLED)
    );
  }
  // Rows come in key order, or newest first given `reverse`. Given `stop`,
  // listing ends before the first row it accepts, reading `first` rows in
  // its first request.
  async list(prefix, values = true, stop = null, reverse = false, first = 200) {
    let cursor,
      rows = [];
    do {
      const page = await this.listPage({
        pattern: prefix,
        returnValues: values,
        // Puter bills each row a page reads, so a listing that stops early
        // reads small pages; one read in full uses few requests.
        limit: !stop ? 1000 : cursor ? 200 : first,
        ...(reverse ? { reverse: true } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const items = Array.isArray(page) ? page : page.items;
      const end = stop ? items.findIndex(stop) : -1;
      if (end >= 0) {
        rows.push(...items.slice(0, end));
        break;
      }
      rows.push(...items);
      cursor = page.cursor;
    } while (cursor);
    return rows;
  }
  async readFile(path) {
    return (await this.puter.fs.read(path)).text();
  }
  async writeFile(path, value) {
    await this.puter.fs.write(path, value, {
      overwrite: true,
      dedupeName: false,
      createMissingParents: true,
    });
  }
  // Snapshots, checkpoints, and large updates are immutable files, so each
  // worker instance keeps recently used ones in memory instead of rereading.
  async cachedFile(path) {
    const hit = FILES.get(path);
    if (hit !== undefined) {
      FILES.delete(path);
      FILES.set(path, hit);
      return hit;
    }
    const text = await this.readFile(path);
    keepFile(path, text);
    return text;
  }
  async recordUpdate(value) {
    return decode(value.update || (await this.cachedFile(value.path)));
  }
  async applyRecord(doc, value) {
    doc.apply(await this.recordUpdate(value), "stored");
  }
  // Edit records written since a moment. Every record also stays in the
  // log for version history. Keys start with the record's time, so the
  // log is read newest first and reading stops at the first older record,
  // in one listing however long ago the moment was. Given `until`, as for
  // an earlier version, records are read by day from the moment, ending at
  // the first later one. `expect` is about how many records there are,
  // such as the number the previous refresh found.
  async logSince(room, since, until = Infinity, expect = Infinity) {
    const prefix = `wb:${room}:log:`;
    const now = Math.min(this.now(), until);
    const span = now - since;
    const later = until < Infinity ? (r) => r.value?.at > until : null;
    const first = Math.min(200, 20 + Math.ceil(expect * 1.5));
    const from = async (part) =>
      later
        ? (await this.list(part, true, later)).filter(
            (r) => r.value.at >= since,
          )
        : (await this.list(part, true, (r) => r.value?.at < since, true, first))
            .reverse()
            .filter((r) => r.value.at >= since);
    if (!since) return this.list(prefix, true, later);
    if (!later || span > 7 * DAY) return from(prefix);
    // The narrowest ISO time prefix that keeps the number of listings small.
    const [size, step] =
      span <= 10 * 60_000
        ? [16, 60_000]
        : span <= 2 * DAY
          ? [13, 3_600_000]
          : [10, DAY];
    const rows = [];
    let previous = null;
    for (let at = since; ; at += step) {
      const part = new Date(Math.min(at, now)).toISOString().slice(0, size);
      // Only the first prefix holds records from before `since`.
      if (previous === null) rows.push(...(await from(prefix + part)));
      else if (part !== previous)
        for (const row of await this.list(prefix + part, true, later))
          if (row.value.at >= since) rows.push(row);
      previous = part;
      if (at >= now) break;
    }
    return rows;
  }
  // Every record up to a moment, legacy and current, for reconstruction.
  // Edit record keys start with their time, so the log is read only until
  // the first later edit rather than to its end.
  async allRecords(room, until = Infinity) {
    return [
      ...(await this.list(`wb:${room}:op:`)),
      ...(await this.list(`wb:${room}:log:`, true, (r) => r.value?.at > until)),
    ]
      .map((r) => r.value)
      .filter((v) => v && Number.isFinite(v.at))
      .sort((a, b) => a.at - b.at);
  }
  // Reconstruct the shared document as it stood at a moment in time. The edit
  // log is retained, so every earlier state can be rebuilt.
  // A moment after the latest checkpoint starts from it and reads only the
  // records since, like a normal load. An earlier moment starts from the
  // newest checkpoint saved by then, and only a board with none replays
  // its log from the start.
  // One person's calls of a kind in the current minute, refused past the limit.
  perMinute(key, limit) {
    const minute = Math.floor(this.now() / 60000),
      seen = REPORTS.get(key);
    const count = seen?.minute === minute ? seen.count + 1 : 1;
    if (count > limit) fail(429, "Too many requests. Try again in a minute.");
    REPORTS.delete(key);
    REPORTS.set(key, { minute, count });
    if (REPORTS.size > 5000) REPORTS.delete(REPORTS.keys().next().value);
  }
  async loadAt(room, at) {
    const meta = await this.kv.get(`wb:${room}:meta`);
    if (!meta) fail(404, "Board not found.");
    // The moment the board was created, or any before, is its starting
    // content, without edits stamped in that same millisecond or, by a
    // clock running behind, earlier; the version list shows those just
    // after it.
    if (at <= meta.created) {
      const doc = new SharedDocument(
        decode(await this.cachedFile(meta.snapshot)),
      );
      return { doc, meta, count: 0 };
    }
    const latest = await this.kv.get(`wb:${room}:cp`);
    const checkpoint =
      latest && latest.at <= at
        ? latest
        : latest &&
          (
            await this.list(`wb:${room}:cps:`, true, (r) => r.value?.saved > at)
          ).at(-1)?.value;
    const doc = new SharedDocument(
      decode(
        await this.cachedFile(checkpoint ? checkpoint.path : meta.snapshot),
      ),
    );
    const records = (
      checkpoint
        ? (await this.logSince(room, checkpoint.at - LOG_OVERLAP, at)).map(
            (r) => r.value,
          )
        : await this.allRecords(room, at)
    ).filter((v) => v.at <= at);
    for (const value of records) await this.applyRecord(doc, value);
    return { doc, meta, count: records.length };
  }
  // This instance's cached copy of a board: the latest checkpoint plus the
  // edits recorded shortly before it and since, as one encoded update in
  // `state`, followed by the edits this instance saved since in `tail`.
  // Applying an edit twice is harmless, so the overlap covers records that
  // became visible late. Within a second and a half of its last check the
  // copy is used as is; collaborators still receive each other's edits
  // immediately through peers. After that it is checked again (see
  // recheck), and listing the log again reads only the records written
  // since the last listing.
  // A board being edited also stays loaded as a document in `live`, holding
  // the saved state plus any commit still being checked or written.
  // `force` lists the log again at once; `reload` builds the copy again
  // from the latest checkpoint.
  // A caller told of a save (`noticed`) names it by its record ids when it
  // can. A copy holding every one of them has what the caller was told of,
  // whatever its age within the second and a half; otherwise, or when the
  // save is unnamed, the copy is checked again by a check begun after the
  // caller asked. The copy's own time is never compared with another
  // clock's: a save's time as another instance or Puter's event service
  // stamps it says nothing sure about this instance's clock, and a listing
  // begun before a record became visible must not pass for one made after.
  // Only older clients, which give no ids, are judged by the save's time.
  async board(
    room,
    meta,
    {
      force = false,
      reload = false,
      after = 0,
      ids = null,
      noticed = false,
    } = {},
  ) {
    const started = this.now();
    const cached = DOCS.get(room);
    if (cached && cached.snapshot === meta.snapshot) {
      DOCS.delete(room);
      DOCS.set(room, cached);
      // A copy still loading is waited for (see read).
      if (!force && !reload && cached.state) {
        const told = noticed
          ? !ids?.length || ids.some((id) => !cached.recent.has(id))
          : Math.min(after, started) > cached.checked;
        if (
          told ||
          !(started - cached.checked < FRESH && started >= cached.checked)
        )
          await this.recheck(room, meta, cached, told);
        return { entry: DOCS.get(room) || cached, rows: 0 };
      }
    }
    return this.read(room, meta, reload);
  }
  // Every save writes the board's signal after its record, with a value
  // never written before, as older workers' saves do too. So while the
  // signal keeps the value this instance first read at `seen`, every saved
  // record was written before then, and a listing begun SETTLE later, once
  // listings show them, holds them all. A copy listed that late is used
  // without listing the log while the value stays, though at least every
  // BACKSTOP it is listed anyway, in case a save's signal was lost. Callers
  // told of a save wait for a check begun after they asked, which everyone
  // asking meanwhile shares; others use the copy as it is while a check
  // runs.
  async recheck(room, meta, entry, told) {
    const shared = (entry.checks ||= {
      asked: 0,
      done: 0,
      running: null,
      paced: -Infinity,
    });
    const run = () =>
      (shared.running ||= this.check(room, meta, entry, shared, told)
        .then((covers) => {
          shared.done = Math.max(shared.done, covers);
        })
        .finally(() => {
          shared.running = null;
        }));
    if (!told) return shared.running ? undefined : run();
    const mine = ++shared.asked;
    while (shared.done < mine) await run();
  }
  // Returns how many callers had asked when the check began, or when the
  // listing it needed began.
  async check(room, meta, entry, shared, told) {
    let covers = shared.asked;
    const begun = this.now();
    const value = await this.stamp(`wb:${room}:ev:signal`);
    const known = entry.signal;
    // A caller told of a save has the copy listed whatever the signal
    // shows, so a stale read of it never hides a record someone named.
    if (
      !told &&
      value !== undefined &&
      value === known?.value &&
      entry.at >= known.seen + SETTLE &&
      begun - entry.at < BACKSTOP
    ) {
      entry.checked = Math.max(entry.checked, begun);
      return covers;
    }
    if (value !== undefined && value !== known?.value)
      entry.signal = { value, seen: this.now() };
    // Out of listings, the copy is answered from as it is: callers told of
    // a save are told what it lacks, and ask again.
    if (!this.short()) {
      // In a busy room callers told of saves keep coming; whoever asks
      // meanwhile shares the next listing.
      if (told) {
        const wait = Math.min(PACE, shared.paced + PACE - this.now());
        if (wait > 0) await this.wait(wait);
        shared.paced = this.now();
      }
      covers = shared.asked;
      // A listing that fails or is slow, as when Puter refuses it and its
      // SDK tries again, keeps the copy as it is meanwhile.
      if (await this.within(this.read(room, meta), PATIENCE)) return covers;
    }
    entry.checked = Math.max(entry.checked, begun);
    return covers;
  }
  wait(ms, signal) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  // Whether a promise is fulfilled within `ms`.
  async within(promise, ms) {
    const done = new AbortController();
    try {
      return await Promise.race([
        promise.then(
          () => true,
          () => false,
        ),
        this.wait(ms, done.signal).then(() => false),
      ]);
    } finally {
      done.abort();
    }
  }
  // A key's value as last written, or undefined if it cannot be read.
  stamp(key) {
    return this.kv.get(key).then(
      (value) => JSON.stringify(value ?? null),
      () => undefined,
    );
  }
  // Has other instances list who is present on a board again.
  async moved(room) {
    await this.kv.set(`wb:${room}:roster`, crypto.randomUUID()).catch(() => {
      /* They list it before anyone in theirs could lapse anyway. */
    });
  }
  // Lists the log's new records into the cached copy, or loads the board.
  async read(room, meta, reload = false) {
    const started = this.now();
    const cached = DOCS.get(room);
    const usable = cached?.state && cached.snapshot === meta.snapshot;
    if (usable && !reload) return this.fill(room, meta, cached, started);
    // Requests arriving while a board loads share the load.
    if (
      !usable &&
      !reload &&
      cached?.snapshot === meta.snapshot &&
      cached.loading
    )
      return cached.loading;
    const entry = {
      snapshot: meta.snapshot,
      // Records read past the checkpoint, with the time each was saved.
      seen: new Map(),
      recent: new Set(reload && cached?.recent ? cached.recent : []),
      signal: reload ? cached?.signal : undefined,
      checkpoint: undefined,
      tail: reload && cached?.tail ? [...cached.tail] : [],
      live: null,
    };
    // A copy read again from its checkpoint is used in place of the one
    // before only once it is read, and meanwhile takes the edits this
    // instance saves too (see remember). Without a copy to use, it is
    // listed at once, so those edits are kept.
    if (usable) cached.next = entry;
    else {
      DOCS.delete(room);
      DOCS.set(room, entry);
    }
    entry.loading = (async () => {
      try {
        const result = await this.fill(room, meta, entry, started);
        if (usable && DOCS.get(room) === cached) {
          DOCS.delete(room);
          DOCS.set(room, entry);
        }
        return result;
      } catch (error) {
        if (!usable && DOCS.get(room) === entry) DOCS.delete(room);
        throw error;
      } finally {
        if (cached?.next === entry) cached.next = null;
        entry.loading = null;
      }
    })();
    return entry.loading;
  }
  // Reads the log into a copy, from its checkpoint if it has no state yet.
  async fill(room, meta, entry, started) {
    let doc = null,
      since;
    if (entry.state) since = entry.at - REFRESH_OVERLAP;
    else {
      const [checkpoint, signal] = await Promise.all([
        this.kv.get(`wb:${room}:cp`),
        this.stamp(`wb:${room}:ev:signal`),
      ]);
      entry.checkpoint = checkpoint;
      if (signal !== undefined && signal !== entry.signal?.value)
        entry.signal = { value: signal, seen: this.now() };
      doc = new SharedDocument(
        decode(await this.cachedFile(entry.checkpoint?.path || meta.snapshot)),
      );
      // Boards from before checkpoints stored every edit under op: keys; the
      // first checkpoint covers them, so they are only read until then.
      if (!entry.checkpoint)
        for (const { key, value } of await this.list(`wb:${room}:op:`)) {
          await this.applyRecord(doc, value);
          entry.seen.set(key, 0);
        }
      since = entry.checkpoint ? entry.checkpoint.at - LOG_OVERLAP : 0;
    }
    const covered = entry.checkpoint?.at || 0,
      records = [];
    let newest = 0;
    // A refresh reads about as many records as the one before it found.
    const expect = doc ? Infinity : (entry.found ?? Infinity);
    for (const { key, value } of await this.logSince(
      room,
      since,
      Infinity,
      expect,
    )) {
      records.push(await this.recordUpdate(value));
      newest = Math.max(newest, value.at || 0);
      if (value.at > covered && entry.seen.size < 100_000)
        entry.seen.set(key, value.at);
      recent(entry, key.slice(key.lastIndexOf(":") + 1));
    }
    if (doc) {
      // Edits this instance saved while the log was being read are kept.
      for (const update of [...records, ...entry.tail])
        doc.apply(update, "stored");
      entry.state = doc.update();
      entry.tail = [];
      this.keepLive(entry, doc);
    } else {
      if (entry.live)
        for (const update of records) applySaved(entry.live, update);
      // The loaded document holds every saved edit, and compactly.
      if (entry.live && !entry.live.inflight) {
        entry.state = entry.live.update();
        entry.tail = [];
      } else if (records.length)
        entry.state = mergeUpdates([this.durable(entry), ...records]);
    }
    entry.at = Math.max(entry.at || 0, started);
    entry.checked = Math.max(entry.checked || 0, started);
    entry.found = records.length;
    for (const [key, value] of DOCS) {
      if (DOCS.size <= 20) break;
      DOCS.delete(key);
      if (value === entry) DOCS.set(key, value);
    }
    if (await this.checkpointDue(room, entry, started))
      // The copy holds the records just read and the edits saved through
      // this instance while they were read, so the checkpoint is stamped no
      // earlier than the newest of them: a version as of a moment before
      // that must not start from a checkpoint already holding it.
      await this.checkpoint(
        room,
        { update: () => this.durable(entry) },
        Math.max(started, newest, entry.tailAt || 0),
      )
        .then((checkpoint) => {
          entry.checkpoint = checkpoint;
          entry.checkpointAfter = checkpoint.at + CHECKPOINT_GAP;
          entry.seen.clear();
        })
        .catch(() => {});
    return { entry, rows: records.length };
  }
  // Whether to save this copy as the board's checkpoint, once 256 records
  // were read past the last one, or a day has passed (a checkpoint over a
  // week old makes each load read the whole log, so a quiet board's is
  // renewed too). Each instance counts what it read past the checkpoint it
  // knows, so one another instance wrote since is taken up first: otherwise
  // every instance of a busy board saved its own copy of the whole board,
  // and none is ever removed. A busy board is checkpointed at most every
  // five minutes, unless far more records build up, and the latest
  // checkpoint is read only when one could be due.
  async checkpointDue(room, entry, started) {
    const covered = () => entry.checkpoint?.at || 0;
    const due = () =>
      entry.seen.size >= 256 ||
      (entry.seen.size && (!entry.checkpoint || started - covered() > DAY)) ||
      (entry.checkpoint && started - covered() > 6 * DAY);
    const crowded = () => entry.seen.size >= 4096;
    if (!due() || (started < (entry.checkpointAfter || 0) && !crowded()))
      return false;
    const stored = await this.kv.get(`wb:${room}:cp`).catch(() => null);
    if (stored?.at > covered()) {
      entry.checkpoint = stored;
      for (const [key, at] of entry.seen)
        if (!(at > stored.at)) entry.seen.delete(key);
    }
    if (entry.checkpoint) entry.checkpointAfter = covered() + CHECKPOINT_GAP;
    return !!due() && (started >= (entry.checkpointAfter || 0) || crowded());
  }
  // What a caller with this state vector lacks of the board's saved state,
  // from the loaded document unless it holds a commit not yet saved.
  missing(entry, vector) {
    const known = vector ? decode(vector) : undefined;
    if (entry.live && !entry.live.inflight) return entry.live.update(known);
    const state = this.durable(entry);
    return known ? diffUpdate(state, known) : state;
  }
  // The board's saved state as one update.
  durable(entry) {
    if (entry.tail.length) {
      entry.state = mergeUpdates([entry.state, ...entry.tail]);
      entry.tail = [];
    }
    return entry.state;
  }
  // Keeps a board loaded, letting go of the least recently used ones that
  // no commit is using.
  keepLive(entry, doc) {
    doc.cacheItems();
    entry.live = doc;
    let kept = 0;
    for (const other of [...DOCS.values()].reverse())
      if (other.live && ++kept > LIVE && !other.live.inflight)
        other.live = null;
    return doc;
  }
  // The current document, loaded for the caller to change and destroy.
  async load(room, known) {
    const meta = known || (await this.kv.get(`wb:${room}:meta`));
    if (!meta) fail(404, "Board not found.");
    const { entry, rows } = await this.board(room, meta);
    return { doc: new SharedDocument(this.durable(entry)), meta, rows };
  }
  // Whether the board takes, or holds, anonymous contributions: notes added
  // under anonymous input, or anonymous votes and polls.
  async anonymousInput(room, meta) {
    const { entry } = await this.board(room, meta),
      view = entry.live?.view;
    let workshop = view?.board.workshop;
    if (!view) {
      const doc = new SharedDocument(this.durable(entry));
      try {
        workshop = doc.snapshot().workshop;
      } finally {
        doc.destroy();
      }
    }
    return (
      !!workshopSettings({ workshop }).anonymous ||
      Object.values(workshop || {}).some((v) => v?.anonymous === true)
    );
  }
  // A committed edit extends this instance's cached state without a reload.
  remember(room, update, digest, at = 0) {
    const entry = DOCS.get(room);
    for (const copy of [entry, entry?.next]) {
      if (!copy) continue;
      recent(copy, digest);
      copy.tail.push(update);
      // The newest edit a checkpoint of this copy would hold.
      copy.tailAt = Math.max(copy.tailAt || 0, at);
      if (copy.live) applySaved(copy.live, update);
    }
  }
  async checkpoint(room, doc, at) {
    const snapshot = encode(doc.update());
    const path = `whiteboard/shared/${room}/checkpoints/${await hash(snapshot)}.txt`;
    await this.writeFile(path, snapshot);
    keepFile(path, snapshot);
    const checkpoint = { path, at };
    // Every checkpoint is also kept in a list by the time it was saved, so
    // an earlier version starts from the one before it. It holds no edit
    // recorded after that time, and its file stays with the board.
    const saved = this.now();
    await this.kv.set(`wb:${room}:cps:${new Date(saved).toISOString()}`, {
      ...checkpoint,
      saved,
    });
    await this.kv.set(`wb:${room}:cp`, checkpoint);
    return checkpoint;
  }
  // Resolve a caller's effective board role. Organization administrators can
  // govern every board on their worker even without a membership record.
  async member(room, user, write = false, { restoring = false } = {}) {
    // One request can check access more than once; read the records once.
    const key = `${room}|${id(user.uuid)}`;
    this.access ??= new Map();
    if (!this.access.has(key))
      this.access.set(key, this.accessRecords(room, user));
    let meta, member, orgRole, active, policy;
    try {
      [meta, member, orgRole, active, policy] = await this.access.get(key);
    } catch (error) {
      this.access.delete(key);
      throw error;
    }
    if (!active) fail(403, "Your organization account is deactivated.");
    const admin = orgRole === "owner" || orgRole === "admin";
    // A deleted board is gone for everyone but administrators, and its
    // owner bringing it back from the trash.
    if (meta?.deleted && !admin && !(restoring && meta.owner === user.uuid))
      fail(404, "Board not found.");
    let effective = member;
    // An administrator who was already on the board with a lesser role,
    // such as a viewer promoted later, governs it like any other board.
    if (admin && member?.role !== "owner")
      effective = {
        uuid: user.uuid,
        username: user.username,
        role: "owner",
        orgAdmin: true,
      };
    if (!meta || !effective || effective.role === "removed")
      fail(403, "You no longer have access to this board.");
    // Guests are judged by their current organization role, so a guest who
    // has since joined the organization keeps access and a member demoted
    // to guest is treated as one.
    const outsider = (!orgRole || orgRole === "guest") && !admin;
    // Access that came with a public link, or with the board being open to
    // the organization, ends when the board stops being shared that way or
    // the person stops being a member; people invited by name keep theirs.
    // The board's owner keeps it, however they first came to it: an owner
    // record transferred before this was checked can still carry `via`.
    if (!admin && member?.via && meta?.owner !== user.uuid) {
      if (member.via !== (meta?.visibility || "private"))
        fail(403, "You no longer have access to this board.");
      if (member.via === "organization" && outsider)
        fail(
          403,
          "Your organization only allows its own members on this board.",
        );
      if (
        member.via === "link" &&
        member.guest &&
        (!policy.publicLinks || policy.externalSharing !== "anyone")
      )
        fail(403, "Your organization does not allow public board links.");
    }
    if (outsider) {
      const ends = await this.guestEnds(effective, user, orgRole);
      if (ends !== null && ends < this.now())
        fail(403, "Your guest access to this board has expired.");
    }
    // Restricting boards to members, turning off sharing outside the
    // organization, or turning off guest access also ends access for guests
    // who joined before.
    if (outsider) {
      if (policy.restrictToOrganization || policy.externalSharing === "none")
        fail(
          403,
          "Your organization only allows its own members on this board.",
        );
      if (policy.guestAccess === false)
        fail(403, "Your organization does not allow guest access.");
      // A guest acts within the role the organization lets guests have;
      // a board's owner stays its owner.
      if (effective.role !== "owner") {
        const limited = guestRole(effective.role, policy);
        if (limited !== effective.role)
          effective = { ...effective, role: limited };
      }
    }
    if (write) {
      if (
        write === "comment"
          ? !canComment(effective.role)
          : !canEditContent(effective.role)
      )
        fail(403, "This board is read-only.");
      if (meta.archived && !admin)
        fail(403, "This board is archived and read-only.");
    }
    // Archived boards are read-only for everyone but administrators; clients
    // learn this with the role they are given.
    return {
      meta,
      member: effective,
      archived: !!meta.archived && !admin,
      policy,
    };
  }
  // Whether someone on a board is a guest: their organization role when
  // they have one, else how they joined (as from outside the organization).
  async isGuest(record) {
    if (record.orgAdmin) return false;
    const role = await this.org.role(record);
    return role ? role === "guest" : !!record.guest;
  }
  // When a guest's access to a board ends, or null if it does not: the
  // expiry set when they joined, or for someone who became a guest without
  // one (a member made a guest, or a guest a migration added), the
  // organization's guest expiry from when they joined or became a guest.
  // An expiry the organization has since shortened applies to guests who
  // joined before; a longer one does not extend theirs.
  async guestEnds(record, user, orgRole) {
    if (orgRole && orgRole !== "guest") return null;
    if (!record.expires && orgRole !== "guest" && !record.guest) return null;
    const policy = await this.org.accessPolicy();
    if (!policy.guestExpiryDays) return record.expires || null;
    const account = await this.org.user(user.uuid);
    const start = Math.max(record.joined || 0, account?.roleChanged || 0);
    const ends = start ? start + policy.guestExpiryDays * DAY : null;
    return record.expires ? Math.min(record.expires, ends ?? Infinity) : ends;
  }
  // The board's metadata, the caller's membership, their organization role
  // and whether their account is active, read on every request. Each worker
  // instance keeps them under the board's and the organization's access
  // stamps (see AccessStamp), and reads what it cannot use, stamps due
  // included, in one request. Its own changes apply at once.
  async accessRecords(room, user) {
    const owner = await this.org.accountOwner();
    // The role of an API key or the account owner needs no user record.
    const person = !user.apiKey && user.uuid !== owner.uuid;
    const stamp = this.stampOf(room);
    // The organization's policy comes in the same read; what it allows on
    // the board goes back with every join and check-in.
    const [meta, member, orgMeta, account] = await readKept(
      this.kv,
      () => this.now(),
      [
        { key: `wb:${room}:meta`, cache: RECORDS, stamp },
        { key: `wb:${room}:member:${user.uuid}`, cache: RECORDS, stamp },
        this.org.kept("org:meta"),
        ...(person ? [this.org.kept("org:user:" + user.uuid)] : []),
      ],
    );
    // Administrator API keys act as administrators, never as the owner.
    const { role, active } = user.apiKey
      ? { role: "admin", active: true }
      : person
        ? standing(account)
        : { role: "owner", active: true };
    return [meta, member, role, active, normalizePolicy(orgMeta?.policy)];
  }
  // The access records of many boards for one person, read together, so
  // checking each board with member() afterwards reads nothing more. Each
  // board's metadata, membership and access stamp are three keys, so a
  // request reads a few hundred boards. Returns each board's membership.
  async accessMany(rooms, user) {
    const owner = await this.org.accountOwner();
    const person = !user.apiKey && user.uuid !== owner.uuid;
    const members = [];
    for (let n = 0; n < rooms.length; n += 300) {
      const wants = rooms.slice(n, n + 300).flatMap((room) => {
        const stamp = this.stampOf(room);
        return [
          { key: `wb:${room}:meta`, cache: RECORDS, stamp },
          { key: `wb:${room}:member:${user.uuid}`, cache: RECORDS, stamp },
        ];
      });
      const got = await readKept(this.kv, () => this.now(), [
        ...wants,
        this.org.kept("org:meta"),
        ...(person ? [this.org.kept("org:user:" + user.uuid)] : []),
      ]);
      for (let at = 1; at < wants.length; at += 2) members.push(got[at]);
    }
    return members;
  }
  stampOf(room) {
    let stamp = STAMPS.get(room);
    if (!stamp) {
      if (STAMPS.size >= 1000) STAMPS.delete(STAMPS.keys().next().value);
      // Absent records are kept briefly; see setRecord.
      STAMPS.set(room, (stamp = new AccessStamp(`wb:${room}:access`, true)));
    }
    return stamp;
  }
  // Writes a board's metadata or a membership, which applies to this
  // instance at once and to others once they read the board's stamp. A
  // membership `added` where there was none, as when someone joins, leaves
  // the stamp: other instances can only hold it as absent, which they read
  // again within two seconds, and a new stamp would have them read every
  // membership again.
  async setRecord(room, key, value, options, added = false) {
    await this.kv.set(key, value, options);
    // The members listed here take the record written, so it is not
    // listed again for each person joining.
    const listed = MEMBER_LISTS.get(room);
    if (listed && key.startsWith(`wb:${room}:member:`)) {
      listed.rows = listed.rows.then((rows) => [
        ...rows.filter((m) => `wb:${room}:member:${m?.uuid}` !== key),
        value,
      ]);
      // A failed listing is the callers' to handle, not this write's.
      listed.rows.catch(() => {});
    }
    keepWritten(RECORDS, this.stampOf(room), key, value, this.now());
    this.access?.clear();
    if (!added) await accessChanged(this.kv, room);
  }
  // Every commit signals, so the last change in a burst always reaches
  // subscribers; deliveries coalesce over 250 ms anyway. Each caller waits
  // for a write begun after it asked, which callers asking meanwhile share.
  // A saved edit's record id travels in the signal's value, so a subscriber
  // told of it can ask its own worker instance for that very record.
  async notify(room, id = null) {
    const signal = SIGNALS.get(room) || {
      asked: 0,
      done: 0,
      writing: null,
      ids: [],
    };
    SIGNALS.set(room, signal);
    if (id) signal.ids.push(id);
    const mine = ++signal.asked;
    while (signal.done < mine) {
      if (!signal.writing) {
        const covers = signal.asked,
          ids = signal.ids.splice(0, 64);
        signal.writing = this.kv
          .set(`wb:${room}:ev:signal`, {
            nonce: crypto.randomUUID(),
            ...(ids.length ? { ids } : {}),
          })
          .catch(() => {
            /* The edit is already durable; reconciliation also runs without events. */
          })
          .finally(() => {
            signal.done = Math.max(signal.done, covers);
            signal.writing = null;
          });
      }
      await signal.writing;
    }
    if (!signal.writing && signal.done === signal.asked) SIGNALS.delete(room);
  }
  async events(room, user) {
    const uid = appUid(this.puter.authToken);
    if (!uid) return null;
    // Only the worker's own account can watch its app KV directly.
    if (user.uuid === (await this.org.accountOwner()).uuid)
      return { app: uid, key: `wb:${room}:ev:signal`, owner: user.uuid };
    const cache = `wb:${room}:handle:${user.uuid}`;
    let handle = await this.kv.get(cache);
    if (!handle) {
      try {
        const res = await this.fetcher(
          `${this.puter.APIOrigin}/events/kv-handles`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.puter.authToken}`,
            },
            body: JSON.stringify({
              granteeUid: user.uuid,
              prefix: `wb:${room}:ev:`,
            }),
            signal: AbortSignal.timeout(3000),
          },
        );
        const data = await res.json();
        if (res.ok && data.handle) {
          handle = data.handle;
          await this.kv.set(cache, handle);
          // Indexed by person, so ending their access ends it everywhere,
          // including on boards an administrator watches without joining.
          await this.kv.set(`org:uh:${user.uuid}:${room}`, true);
        }
      } catch {
        /* Peer delivery and periodic synchronization remain available. */
      }
    }
    return handle ? { handle, key: "signal" } : null;
  }
  // Ends a person's presence, so they check in again with their new role,
  // and unless they keep access, their live board events.
  async dropHandle(room, target, { events = true } = {}) {
    let dropped = false;
    for (const row of await this.list(`wb:${room}:presence:`))
      if (row.value.user === target) {
        await this.kv.del(row.key);
        PRESENCE.get(room)?.rows.delete(row.key);
        dropped = true;
      }
    if (dropped) await this.moved(room);
    if (!events) return;
    const handle = await this.kv.get(`wb:${room}:handle:${target}`);
    if (handle) {
      const res = await this.fetcher(
        `${this.puter.APIOrigin}/events/kv-handles/${encodeURIComponent(handle)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.puter.authToken}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (res.ok || res.status === 404) {
        await this.kv.del(`wb:${room}:handle:${target}`);
        await this.kv.del(`org:uh:${target}:${room}`);
      }
    }
  }
  // A deactivated account loses live sessions on every board at once.
  // Only boards they hold a live event handle for are visited: access
  // checks already refuse the rest, and a check-in refused that way drops
  // what remains of their presence.
  async revokeSessions(uuid) {
    const rooms = new Set();
    for (const row of await this.org.list(`org:uh:${uuid}:`, { values: false }))
      rooms.add((typeof row === "string" ? row : row.key).split(":").at(-1));
    for (const room of rooms) {
      await this.dropHandle(room, uuid).catch(() => {});
      await this.notify(room);
    }
  }
  // Each board's member records. With `shared`, as for the member list a
  // participant's editor asks for and for comment notifications (which
  // check each recipient's access), a listing is used for every request on
  // this instance within a few seconds: a workshop's participants joining
  // together, and opening its comments, would otherwise list them once
  // each, using up the worker's listing quota. A member record written
  // here is seen at once (see setRecord), one written elsewhere within
  // those seconds. Counts, indexes and notifications that act on
  // membership read it afresh.
  async members(room, { shared = false } = {}) {
    const now = this.now(),
      hit = MEMBER_LISTS.get(room);
    if (shared && hit && now - hit.at < MEMBERS_FRESH && now >= hit.at)
      return [...(await hit.rows)];
    const rows = this.list(`wb:${room}:member:`).then((list) =>
      list.map((r) => r.value),
    );
    const entry = { at: now, rows };
    MEMBER_LISTS.delete(room);
    if (MEMBER_LISTS.size >= 500)
      MEMBER_LISTS.delete(MEMBER_LISTS.keys().next().value);
    MEMBER_LISTS.set(room, entry);
    rows.catch(() => {
      if (MEMBER_LISTS.get(room) === entry) MEMBER_LISTS.delete(room);
    });
    return [...(await rows)];
  }
  // Check-ins arriving together share one check.
  async present(room) {
    const hit = PRESENCE.get(room),
      now = this.now();
    if (hit && now - hit.checked < 2000 && now >= hit.checked) return hit.rows;
    if (ROSTERS.has(room)) return ROSTERS.get(room);
    const running = (async () => {
      const value = await this.stamp(`wb:${room}:roster`);
      const known = hit?.signal;
      // Out of listings, or listing slowly, the list in hand is used.
      if (
        hit &&
        (this.short() ||
          (value !== undefined &&
            value === known?.value &&
            hit.at >= known.seen + SETTLE &&
            now < due(hit, now) &&
            now >= hit.at))
      ) {
        hit.checked = now;
        return hit.rows;
      }
      const signal =
        value !== undefined && value !== known?.value
          ? { value, seen: this.now() }
          : known;
      const at = this.now();
      const listing = this.list(`wb:${room}:presence:`).then((list) => {
        const rows = new Map(list.map((r) => [r.key, r.value]));
        PRESENCE.delete(room);
        if (PRESENCE.size >= 500) PRESENCE.delete(PRESENCE.keys().next().value);
        PRESENCE.set(room, { rows, at, checked: at, signal });
        return rows;
      });
      if (!hit || (await this.within(listing, PATIENCE))) return listing;
      hit.checked = now;
      return hit.rows;
    })().finally(() => ROSTERS.delete(room));
    ROSTERS.set(room, running);
    return running;
  }
  // Changes arriving while a board's members are being counted share one
  // count begun after it, so people joining together list the board's
  // members about twice on an instance, not once each, and every caller
  // still waits for a count that includes their change.
  refreshCounts(room) {
    const counting = (this.org.instance.counting ??= new Map());
    const held = counting.get(room);
    if (held)
      return (held.next ??= held.run
        .catch(() => {})
        .then(() => this.countMembers(room, counting)));
    return this.countMembers(room, counting);
  }
  countMembers(room, counting) {
    const entry = {};
    counting.set(room, entry);
    entry.run = this.recount(room).finally(() => {
      if (counting.get(room) === entry) counting.delete(room);
    });
    return entry.run;
  }
  async recount(room) {
    const members = (await this.members(room)).filter(
      (m) => m.role !== "removed",
    );
    // Guests are those the organization counts as guests now: a guest
    // since made a member is not one, and a member made a guest is. People
    // it has no record of keep how they joined.
    const owner = (await this.org.accountOwner()).uuid;
    const accounts = await this.org.users(members.map((m) => m.uuid));
    // Only people who can still open the board count: not those whose
    // access came with a way of sharing the board no longer has, nor
    // guests whose access has ended. When the guests counted lose access
    // is kept too, so reports leave them out once that time passes.
    const visibility =
      (await this.kv.get(`wb:${room}:meta`))?.visibility || "private";
    const now = this.now();
    let memberCount = 0,
      guestCount = 0;
    const guestEnds = [];
    for (const [n, m] of members.entries()) {
      if (m.via && m.via !== visibility) continue;
      const guest =
        m.uuid !== owner &&
        (accounts[n] ? accounts[n].role === "guest" : !!m.guest);
      const ends = guest
        ? await this.guestEnds(m, m, accounts[n]?.role || null)
        : null;
      if (ends !== null && ends < now) continue;
      memberCount++;
      if (!guest) continue;
      guestCount++;
      if (ends !== null) guestEnds.push(ends);
    }
    await this.org.registerBoard(room, {
      memberCount,
      guestCount,
      // The soonest hundred; later ones are counted until a recount.
      guestEnds: guestEnds.sort((a, b) => a - b).slice(0, 100),
    });
  }
  // Counts again the boards of someone who became, or stopped being, a
  // guest. A few are counted at once and the rest a batch at a time in
  // later requests, so changing the role of someone on hundreds of boards
  // does not spend minutes of the organization's storage budget, and the
  // time of the request that asked, on board statistics. The queue keeps
  // the last board counted per person.
  async recountBoardsOf(uuid) {
    await this.kv.set(`org:recount:${uuid}`, "");
    this.org.instance.recountsDue = 0;
    await this.recountQueued(RECOUNT_NOW);
  }
  async recountQueued(budget = RECOUNT_BATCH) {
    let left = budget;
    for (const { key, value } of await this.org.list("org:recount:")) {
      const uuid = key.slice("org:recount:".length),
        prefix = `org:ub:${uuid}:`;
      const rooms = (await this.org.list(prefix, { values: false }))
        .map((row) => (typeof row === "string" ? row : row.key))
        .map((k) => k.slice(prefix.length))
        .filter((room) => room > (value || ""))
        .sort();
      for (const [n, room] of rooms.entries()) {
        if (left-- <= 0) {
          await this.kv.set(key, n ? rooms[n - 1] : value);
          return true;
        }
        await this.refreshCounts(room);
      }
      await this.kv.del(key);
    }
    return false;
  }
  // Queued recounts run every half minute while this instance knows of
  // some, and every quarter of an hour in case another instance left them.
  async scheduledRecounts() {
    const now = this.now(),
      due = this.org.instance.recountsDue ?? 0;
    if (now < due) return;
    const more = await this.recountQueued().catch(() => true);
    this.org.instance.recountsDue = now + (more ? 30_000 : 15 * 60_000);
  }
  async setMember(room, record, added = false) {
    await this.setRecord(
      room,
      `wb:${room}:member:${record.uuid}`,
      record,
      undefined,
      added,
    );
    await this.org.indexMembership(record.uuid, room, record.role);
  }
  // Create any records the organization layer needs for boards that existed
  // before it: the registry, ownership, and the per-user membership index.
  async backfillRegistry() {
    for (const row of await this.list("wb:", false)) {
      const key = typeof row === "string" ? row : row.key;
      const match = /^wb:([^:]+):meta$/.exec(key);
      if (!match) continue;
      const room = match[1];
      if (await this.kv.get("org:board:" + room)) continue;
      const meta = await this.kv.get(key);
      const members = await this.members(room);
      for (const m of members)
        await this.org.indexMembership(m.uuid, room, m.role);
      let summary = { title: "Untitled board", objectCount: 0, types: {} };
      try {
        const { doc } = await this.load(room);
        try {
          summary = boardSummary(doc.snapshot());
        } finally {
          doc.destroy();
        }
      } catch {
        /* Keep an entry even if the board cannot be read right now. */
      }
      const ownerName = members.find((m) => m.uuid === meta.owner)?.username;
      const { text, content, ...rest } = summary;
      await this.kv.set("org:idx:" + room, text || "");
      await this.org.registerBoard(room, {
        ...rest,
        owner: meta.owner,
        ownerName: ownerName || null,
        created: meta.created,
        updated: meta.created,
        visibility: meta.visibility || "private",
        memberCount: members.filter((m) => m.role !== "removed").length,
        guestCount: members.filter((m) => m.guest).length,
      });
    }
  }
  async transfer(room, actor, target, { admin = false } = {}) {
    id(target);
    const meta = await this.kv.get(`wb:${room}:meta`);
    if (!meta) fail(404, "Board not found.");
    // Retention has begun removing its records, as govern() refuses too.
    if ((await this.kv.get("org:board:" + room))?.purging)
      fail(409, "This board is being permanently deleted.");
    if (!admin) {
      const { member } = await this.member(room, actor);
      if (
        member.role !== "owner" ||
        (member.uuid !== meta.owner && !member.orgAdmin)
      )
        fail(
          403,
          "Only the board owner or an administrator can transfer ownership.",
        );
    }
    if (meta.owner === target) return { ok: true };
    const [previous, next, orgUser] = await Promise.all([
      this.kv.get(`wb:${room}:member:${meta.owner}`),
      this.kv.get(`wb:${room}:member:${target}`),
      this.org.user(target),
    ]);
    const owner = await this.org.accountOwner();
    const username =
      next?.username ||
      orgUser?.username ||
      (target === owner.uuid ? owner.username : null);
    if (!next && !orgUser && target !== owner.uuid)
      fail(404, "Choose someone in your organization.");
    // Boards go to someone who keeps access: never a deactivated account or
    // a guest, whose access to boards can end.
    // Once the organization is set up, that means someone it knows: a
    // member who joined the board before it existed has no record, and a
    // policy keeping boards to members would lock them out of their own.
    const configured = !!(await this.kv.get("org:meta"));
    if (
      target !== owner.uuid &&
      (orgUser?.status === "deactivated" ||
        orgUser?.role === "guest" ||
        (!orgUser && (next?.guest || configured)))
    )
      fail(400, "Choose an active member of your organization.");
    if (previous)
      await this.setMember(room, { ...previous, role: "facilitator" });
    // An owner's access never expires, whatever they had as a guest, and
    // does not depend on how the board is shared, as access that came with
    // the board's visibility does.
    const { expires: _, via: __, ...kept } = next || {};
    await this.setMember(room, {
      uuid: target,
      username: username || target,
      ...kept,
      role: "owner",
      guest: false,
    });
    // A board purged meanwhile is not written back.
    const latest = await this.kv.get(`wb:${room}:meta`);
    if (!latest || (await this.kv.get("org:board:" + room))?.purging)
      fail(409, "This board is being permanently deleted.");
    await this.setRecord(
      room,
      `wb:${room}:meta`,
      { ...latest, owner: target, creator: latest.creator ?? latest.owner },
      { disableSharing: true },
    );
    await this.org.registerBoard(room, { owner: target, ownerName: username });
    // The new owner may have joined the board, or stopped being a guest.
    await this.refreshCounts(room);
    await this.org.audit(
      actor,
      "board.transfer",
      { type: "board", id: room },
      {
        from: meta.owner,
        to: target,
      },
    );
    // The board's Slack channel belongs to whoever managed it before, so its
    // mentions stop going there; the new owner can connect their own.
    if (await this.kv.get("org:boardslack:" + room)) {
      await this.kv.del("org:boardslack:" + room);
      await this.org.audit(
        actor,
        "board.share.slack",
        { type: "board", id: room },
        { connected: false },
      );
    }
    await this.notify(room);
    return { ok: true };
  }
  async call(user, input) {
    if (!user?.uuid) fail(401, "Sign in with Puter to continue.");
    if (!input || bytes(input) > 17_000_000)
      fail(413, "Collaboration request is too large.");
    this.access = new Map();
    // People refused access, such as a deactivated account still polling,
    // do not count as active.
    let refused = false;
    try {
      return await this.dispatch(user, input);
    } catch (error) {
      refused = [401, 403, 404].includes(error.status);
      // Someone whose access ended, as a guest whose invitation lapsed,
      // stops receiving the board's live events too.
      if (
        [403, 404].includes(error.status) &&
        typeof input.room === "string" &&
        ID.test(input.room)
      )
        try {
          // Only when access itself ended: a refused operation, such as a
          // save arriving just after a demotion, leaves it.
          if (
            (await this.kv.get(`wb:${input.room}:handle:${user.uuid}`)) &&
            (await this.member(input.room, user).then(
              () => false,
              () => true,
            ))
          )
            await this.dropHandle(input.room, user.uuid);
        } catch {
          /* The refusal stands either way. */
        }
      throw error;
    } finally {
      if (!refused) await this.org.touch(user);
      if (input?.op !== "commit") await this.writeDueActivity().catch(() => {});
      await this.org.flush();
      // Retention and scheduled reports never hold up saving, synchronizing
      // or checking in.
      if (!EDITING.has(input?.op)) {
        await this.org.scheduledWork().catch(() => {});
        await this.scheduledRecounts();
      }
    }
  }
  // Spaces and teams are the organization's; only its members file boards
  // into them, and only into ones that exist.
  async filing(user, input) {
    const filed = {};
    for (const key of ["team", "space"])
      if (input[key] !== undefined)
        filed[key] = input[key] ? id(input[key]) : null;
    if (Object.keys(filed).length) {
      const role = await this.org.role(user);
      if (!role || role === "guest")
        fail(403, "Only organization members can file boards into spaces.");
      for (const [key, value] of Object.entries(filed))
        if (value && !(await this.kv.get(`org:${key}:${value}`)))
          fail(400, "Choose a space or team that exists.");
    }
    return filed;
  }
  async dispatch(user, input) {
    const room = id(input.room),
      prefix = `wb:${room}:`;
    if (input.op === "create") {
      const accountOwner = await this.org.accountOwner();
      if (user.uuid !== accountOwner.uuid && !(await this.org.canCreate(user)))
        fail(403, "Only the server owner can create boards.");
      const filed = await this.filing(user, input);
      let meta = await this.kv.get(prefix + "meta");
      let created = false;
      // The directory and the audit record keep the same short label, never
      // whatever the request carried.
      const source =
        typeof input.source === "string" ? input.source.slice(0, 40) : null;
      if (!meta) {
        // A board that is not valid is refused for good, not reported as
        // a failure worth retrying.
        let doc, summary;
        try {
          doc = new SharedDocument(decode(input.update));
          summary = boardSummary(doc.validate());
        } catch (error) {
          fail(422, error.message || "This board could not be shared.");
        } finally {
          doc?.destroy();
        }
        if ((await this.kv.incr(prefix + "creation")) !== 1)
          fail(
            409,
            "This board is already being created. Please retry sharing.",
          );
        // The claim is released below, and also lapses on its own, so a
        // worker stopped mid-creation never blocks sharing this board.
        await this.kv.expire(prefix + "creation", 120).catch(() => {});
        try {
          // An earlier attempt may have finished since the first read.
          meta = await this.kv.get(prefix + "meta");
          if (!meta) {
            const policy = await this.org.policy();
            const keys = await keyPair();
            const snapshot = `whiteboard/shared/${room}/initial-${await hash(input.update)}.txt`;
            await this.writeFile(snapshot, input.update);
            meta = {
              owner: user.uuid,
              // Kept through transfers, for the original version's author.
              creator: user.uuid,
              snapshot,
              keys,
              created: this.now(),
              visibility:
                (await this.kv.get("org:meta")) && policy.defaultVisibility
                  ? policy.defaultVisibility
                  : "private",
              orgRole: "editor",
            };
            await this.setRecord(room, prefix + "meta", meta, {
              disableSharing: true,
            });
            created = true;
            const { text, content, ...rest } = summary;
            await this.kv.set("org:idx:" + room, text);
            await this.org.registerBoard(room, {
              ...rest,
              owner: user.uuid,
              ownerName: user.username || null,
              created: meta.created,
              updated: meta.created,
              lastActivity: meta.created,
              visibility: meta.visibility,
              team: filed.team ?? null,
              space: filed.space ?? null,
              source,
              memberCount: 1,
              guestCount: 0,
            });
          }
        } finally {
          await this.kv.del(prefix + "creation");
        }
      }
      if (meta.owner !== user.uuid)
        fail(403, "Only the board owner can finish creating this board.");
      // Repair a partial creation without replacing its snapshot or signing keys.
      if (!(await this.kv.get(prefix + "member:" + user.uuid)))
        await this.setMember(room, {
          uuid: user.uuid,
          username: user.username,
          role: "owner",
        });
      if (created)
        await this.org.audit(
          user,
          "board.created",
          {
            type: "board",
            id: room,
            name: (await this.kv.get("org:board:" + room))?.title,
          },
          { source },
        );
      return { room };
    }
    if (input.op === "join") await this.admit(room, user, input);
    const { meta, member, archived, policy } = await this.member(
      room,
      user,
      false,
      { restoring: input.op === "restore" },
    );
    if (input.op === "join") {
      return {
        room,
        member,
        archived,
        serverTime: this.now(),
        publicKey: meta.keys.publicKey,
        events:
          user.uuid === (await this.org.accountOwner()).uuid
            ? await this.events(room, user)
            : null,
        owner: meta.owner,
        app: appUid(this.puter.authToken),
        // Participants learn only whether the board is archived; who may
        // open it and whether it is under a legal hold are for its managers.
        settings: canManage(member.role)
          ? this.settings(meta)
          : { archived: !!meta.archived },
        features: boardFeatures(policy),
        sharing: await this.sharing(user, policy),
      };
    }
    if (input.op === "events") return { events: await this.events(room, user) };
    if (
      input.op === "invite" ||
      input.op === "invite-status" ||
      input.op === "role" ||
      input.op === "renew" ||
      input.op === "revoke-invite"
    ) {
      if (!canManage(member.role))
        fail(403, "Only the board owner can manage access.");
      // A guest's access starts again from today, as a new invitation would
      // start it, without their having to be sent one.
      if (input.op === "renew")
        return this.renewGuest(room, user, member, input);
      // Whether an invitation this manager made still opens the board with
      // the access it was made for, so the share dialog can show it again
      // rather than make, and audit, a new one each time it opens.
      if (input.op === "invite-status") {
        const row =
          typeof input.token === "string" && input.token.length <= 200
            ? await this.kv.get(prefix + "invite:" + (await hash(input.token)))
            : null;
        return {
          valid:
            !!row &&
            row.expires > this.now() &&
            row.role === input.role &&
            !!row.guest === (input.guest === true) &&
            !!row.membersOnly === (input.membersOnly === true),
        };
      }
      const policy = await this.org.policy();
      if (input.op === "invite") {
        // A role named that no invitation can give, such as owner, is
        // refused rather than quietly made an editor's.
        if (input.role !== undefined && !INVITE_ROLES.includes(input.role))
          fail(400, "Choose a role an invitation can give.");
        const role = input.role ?? "editor";
        if (role === "facilitator" && member.role !== "owner")
          fail(403, "Only the board owner can invite facilitators.");
        const guest = input.guest === true;
        if (guest && (!policy.guestAccess || policy.externalSharing === "none"))
          fail(403, "Your organization does not allow guest access.");
        if (guest && policy.restrictToOrganization)
          fail(
            403,
            "Your organization only allows its own members on this board.",
          );
        // A link can be kept to the organization's own members, so a copy
        // forwarded outside it lets no one in. Boards outside an
        // organization have no members to keep it to.
        const membersOnly =
          input.membersOnly === true && (await this.org.configured());
        const value = crypto.randomUUID() + crypto.randomUUID();
        const expires = this.now() + INVITE_DAYS * DAY;
        // The row leaves storage when the invitation expires, as presence
        // tickets do; joining refuses an expired row meanwhile.
        await this.kv.set(
          prefix + "invite:" + (await hash(value)),
          {
            role,
            guest,
            ...(membersOnly ? { membersOnly } : {}),
            created: this.now(),
            expires,
            createdBy: user.uuid,
          },
          Math.floor(expires / 1000),
        );
        await this.org.audit(
          user,
          "board.invite.created",
          { type: "board", id: room },
          {
            role,
            guest,
            ...(membersOnly ? { membersOnly } : {}),
          },
        );
        return { token: value };
      }
      if (input.op === "revoke-invite") {
        // Facilitators manage the roles below theirs; only the owner's own
        // revocation also ends facilitator invitations.
        for (const row of await this.list(prefix + "invite:"))
          if (member.role === "owner" || row.value?.role !== "facilitator")
            await this.kv.del(row.key);
        await this.org.audit(user, "board.invite.revoked", {
          type: "board",
          id: room,
        });
      } else {
        const target = id(input.uuid);
        if (
          target === meta.owner ||
          ![...INVITE_ROLES, "removed"].includes(input.role)
        )
          fail(400, "Invalid role change.");
        const record = await this.kv.get(prefix + "member:" + target);
        if (!record) fail(404, "Member not found.");
        // The board's details can be a moment old after a transfer made
        // elsewhere; the membership read just now names the owner too.
        if (record.role === "owner") fail(400, "Invalid role change.");
        const guest = await this.isGuest(record);
        // A guest is judged by the role they act with, the one everyone
        // is shown, within the organization's limit for guests.
        const held = guest ? guestRole(record.role, policy) : record.role;
        if (
          member.role !== "owner" &&
          (held === "facilitator" || input.role === "facilitator")
        )
          fail(403, "Only the board owner can change facilitators.");
        if (
          input.role !== "removed" &&
          guestRole(input.role, policy) !== input.role &&
          guest
        )
          fail(403, GUEST_ROLE_LIMITS[policy.guestRole]);
        // A role given by name is kept like an invitation's, whatever the
        // board's sharing becomes.
        const { via, ...named } = record;
        await this.setMember(room, { ...named, role: input.role });
        // The role is already saved; a failed handle cleanup must not skip
        // the audit record or report the change as failed.
        await this.dropHandle(room, target, {
          events: input.role === "removed",
        }).catch(() => {});
        await this.refreshCounts(room);
        await this.org.audit(
          user,
          "board.role.changed",
          {
            type: "board",
            id: room,
            name: record.username,
          },
          { member: target, from: record.role, to: input.role },
        );
      }
      await this.notify(room);
      return { ok: true };
    }
    if (input.op === "settings.get") {
      if (!canManage(member.role))
        fail(
          403,
          "Only the board owner or a facilitator can change board settings.",
        );
      const [record, slack, integrations] = await Promise.all([
        this.kv.get("org:board:" + room),
        this.kv.get("org:boardslack:" + room),
        this.managesIntegrations(meta, user),
      ]);
      return {
        settings: {
          ...this.settings(meta),
          space: record?.space || null,
          team: record?.team || null,
          slack: !!slack,
          integrations,
        },
        sharing: await this.sharing(user, await this.org.accessPolicy()),
      };
    }
    if (input.op === "settings") {
      if (!canManage(member.role))
        fail(
          403,
          "Only the board owner or a facilitator can change board settings.",
        );
      return this.updateSettings(room, user, meta, input);
    }
    if (input.op === "transfer")
      return this.transfer(room, user, id(input.uuid));
    if (
      ["archive", "unarchive", "restore", "delete", "hold"].includes(input.op)
    )
      return this.govern(room, user, meta, member, input);
    // Who owns each of these Yjs clients, the browsers whose edits the
    // board holds: the first account a commit added content under one with
    // owns it for good (see clientClaims), so the client that first wrote an
    // object tells who added it. Read in one request, as Puter counts a get
    // of several keys as one, for clients this instance has not seen.
    if (input.op === "creators") {
      const clients = [
        ...new Set(
          (Array.isArray(input.clients) ? input.clients : []).filter(
            (c) => Number.isSafeInteger(c) && c >= 0,
          ),
        ),
      ].slice(0, 500);
      const keys = clients.map((c) => `wb:${room}:client:${c}`),
        unknown = keys.filter((key) => !CLIENTS.has(key));
      for (let n = 0; n < unknown.length; n += 100) {
        const part = unknown.slice(n, n + 100),
          found =
            part.length > 1
              ? await this.kv.get(part)
              : [await this.kv.get(part[0])];
        part.forEach((key, i) => {
          if (typeof found?.[i] === "string") keepClient(key, found[i]);
        });
      }
      const owners = {};
      clients.forEach((c, n) => {
        const owner = CLIENTS.get(keys[n]);
        if (owner) owners[c] = owner;
      });
      return { owners };
    }
    if (input.op === "members") {
      // Members who can no longer open the board, as when their account is
      // deactivated or their guest access has ended, are marked, so no one
      // is offered them to assign or mention.
      const now = this.now();
      const policy = await this.org.accessPolicy();
      // As the access check judges them: a guest is also shut out while the
      // policy keeps guests off the organization's boards, and a guest who
      // came by a public link once the policy stops allowing those.
      const lapsed = async (m) => {
        if (m.via && m.via !== (meta.visibility || "private")) return true;
        if (m.guest && m.uuid !== meta.owner) {
          if (guestsShutOut(policy)) return true;
          if (
            m.via === "link" &&
            (!policy.publicLinks || policy.externalSharing !== "anyone")
          )
            return true;
        }
        return m.accessEnds !== undefined && m.accessEnds < now;
      };
      const records = await this.members(room, { shared: true });
      // Their records are read together first, so an instance that has
      // read none of them reads them in a request or two, not one each.
      await this.org.users(records.map((m) => m.uuid));
      const members = await Promise.all(
        records.map(async (record) => {
          // Whether someone is a guest is their standing now, not how they
          // joined: a guest made a member is no longer one.
          const m = { ...record };
          if (await this.isGuest(record)) m.guest = true;
          else {
            delete m.guest;
            // Nor does a guest's expiry apply to them any more.
            if ((await this.org.role(record)) && record.guest) delete m.expires;
          }
          // The role a guest acts with, within the organization's limit.
          if (m.guest && m.role !== "owner" && m.role !== "removed")
            m.role = guestRole(m.role, policy);
          // When their access ends, as the access check reckons it, so
          // managers can see it coming and renew it.
          const ends = await this.guestEnds(m, m, await this.org.role(m));
          if (ends !== null) m.accessEnds = ends;
          return m.role !== "removed" &&
            ((await lapsed(m)) ||
              (await this.org.user(m.uuid))?.status === "deactivated")
            ? { ...m, inactive: true }
            : m;
        }),
      );
      // On a board shared with the whole organization, colleagues who have
      // not opened it yet can be mentioned too. Only the organization's own
      // members are shown them, as its directory is theirs.
      if (meta.visibility === "organization" && !meta.deleted) {
        const role = await this.org.role(user);
        if (role && role !== "guest") {
          const known = new Set(records.map((m) => m.uuid));
          const colleagues = (await this.org.activePeople())
            .filter(
              (p) =>
                p.username &&
                p.role &&
                p.role !== "guest" &&
                !known.has(p.uuid),
            )
            .slice(0, 2000)
            .map(({ uuid, username }) => ({ uuid, username }));
          if (colleagues.length) return { members, colleagues };
        }
      }
      return { members };
    }
    if (input.op === "presence") {
      const session = id(input.session),
        coordinate = /^[A-Za-z0-9_-]{43}$/;
      if (
        input.publicKey?.kty !== "EC" ||
        input.publicKey?.crv !== "P-256" ||
        input.publicKey?.d ||
        !coordinate.test(input.publicKey?.x) ||
        !coordinate.test(input.publicKey?.y)
      )
        fail(400, "Invalid peer key.");
      const key = prefix + "presence:" + session,
        rows = await this.present(room);
      // This session's previous ticket, read directly if the list is from
      // before it was written, or before it lapsed when it names someone
      // else.
      let old = rows.get(key) ?? (await this.kv.get(key));
      if (old && old.user !== user.uuid) old = await this.kv.get(key);
      // Someone else took this ID after the session lapsed. That is no loss
      // of access: the caller starts a new session.
      if (old && old.user !== user.uuid)
        fail(409, "Session belongs to another participant.");
      if (old)
        await this.org.recordTime(this.now() - (old.expires - SESSION_TTL));
      // Charge limits before writing so one account cannot fill the roster.
      const others = [...rows.values()].filter(
        (p) => p?.expires > this.now() && p.session !== session,
      );
      if (
        !old &&
        (others.length >= 512 ||
          others.filter((p) => p.user === user.uuid).length >= 16)
      )
        fail(429, "This board has reached its participant limit.");
      const ticket = {
        room,
        session,
        user: user.uuid,
        username: String(user.username || "Participant").slice(0, 80),
        role: member.role,
        ...((await this.isGuest(member)) ? { guest: true } : {}),
        // Only the public coordinates are signed and redistributed.
        publicKey: {
          kty: "EC",
          crv: "P-256",
          x: input.publicKey.x,
          y: input.publicKey.y,
        },
        // A lasting peer group and join time, for clients that ask; see
        // topology in protocol.js. A session keeps both while it checks in.
        ...(input.topology === 2
          ? old?.topology === 2 && Number.isSafeInteger(old.group)
            ? { topology: 2, group: old.group, since: old.since }
            : { topology: 2, group: peerGroup(others), since: this.now() }
          : {}),
        expires: this.now() + SESSION_TTL,
        invite:
          typeof input.invite === "string" ? input.invite.slice(0, 100) : null,
      };
      await this.kv.set(key, ticket, Math.floor(ticket.expires / 1000));
      PRESENCE.get(room)?.rows.set(key, ticket);
      if (!old || old.invite !== ticket.invite)
        await Promise.all([this.moved(room), this.notify(room)]);
      const roster = [...others, ticket].sort((a, b) =>
        a.session < b.session ? -1 : a.session > b.session ? 1 : 0,
      );
      await this.org.recordPeak(room, new Set(roster.map((p) => p.user)).size);
      return {
        ticket,
        signature: await sign(meta.keys.privateKey, ticket),
        roster,
        role: member.role,
        archived,
        features: boardFeatures(policy),
      };
    }
    if (input.op === "leave") {
      const key = prefix + "presence:" + id(input.session),
        entry = await this.kv.get(key);
      if (entry?.user === user.uuid) {
        await this.kv.del(key);
        PRESENCE.get(room)?.rows.delete(key);
        await this.moved(room);
      }
      // Leaving within a minute of editing writes what the minute held back.
      const activity = this.org.instance.activity.get(room);
      if (activity?.editor?.uuid === user.uuid) {
        const { doc } = await this.load(room, meta);
        try {
          await this.writeActivity(
            room,
            activity.editor,
            doc.snapshot(),
            activity,
          ).catch(() => {});
        } finally {
          doc.destroy();
        }
      }
      return { ok: true };
    }
    if (
      input.op === "history.list" ||
      input.op === "history.state" ||
      input.op === "history.removed"
    )
      this.perMinute(`history|${room}|${user.uuid}`, HISTORY_READ_LIMIT);
    if (input.op === "history.list") {
      // Edit records hold the edits themselves, but their keys name the time
      // and author, so only keys are read; names come from the members.
      const names = new Map(
        (await this.list(`${prefix}member:`)).map((r) => [
          r.value.uuid,
          r.value.username,
        ]),
      );
      const before = Number(input.before);
      // The board's starting content is the version at its creation, so
      // edits stamped then, or before by a clock running behind, are shown
      // just after it.
      const born = Number.isFinite(meta.created) ? meta.created : null;
      const after = (at) => (born === null ? at : Math.max(at, born + 1));
      const record = (row) => {
        const parts = (typeof row === "string" ? row : row.key)
          .slice(`${prefix}log:`.length)
          .split(":");
        const author = parts.at(-2);
        return {
          at: after(Date.parse(parts.slice(0, -2).join(":"))),
          author,
          username: names.get(author) || "",
        };
      };
      // Keys are read newest first, a page at a time, until the versions
      // this page shows, and the one after them for `more`, are complete:
      // a version is once an older edit is read before a pause or in an
      // earlier quarter of an hour. Older edits are not read, however long
      // the board's history.
      const legacy = (await this.list(`${prefix}op:`)).map((r) => ({
        at: after(r.value.at),
        author: r.value.author,
        username: r.value.username,
      }));
      // A page with `more` also gives `next`, which the app hands back with
      // the next page's `before` so that page is read from where this one
      // ended rather than from the newest edit. Puter's listing position
      // says nothing sure once records are added or removed, so it is used
      // only if the first key it gives is no older than `before`: nothing
      // older can then have been passed over. Otherwise, or if Puter
      // refuses it, the page is read from the newest edit.
      const resume =
        Number.isFinite(before) &&
        typeof input.cursor === "string" &&
        input.cursor.length <= 4096
          ? input.cursor
          : undefined;
      const read = async (cursor) => {
        const page = await this.listPage({
          pattern: `${prefix}log:`,
          returnValues: false,
          limit: 200,
          reverse: true,
          ...(cursor ? { cursor } : {}),
        });
        return { rows: Array.isArray(page) ? page : page.items, page };
      };
      const logged = [],
        starts = new Map();
      let cursor = resume,
        resumed = resume !== undefined,
        complete = 0,
        session = [],
        start,
        last = null;
      const close = () => {
        const versions = historyVersions(
          session.reverse(),
          undefined,
          Infinity,
        );
        if (versions.length) starts.set(versions[0].at, start);
        complete += versions.filter(
          (v) => !Number.isFinite(before) || v.at < before,
        ).length;
        session = [];
      };
      do {
        let found = resumed ? await read(cursor).catch(() => null) : null;
        if (
          resumed &&
          !(found?.rows.length && record(found.rows[0]).at >= before)
        )
          found = null;
        if (!found) {
          if (resumed) cursor = undefined;
          found = await read(cursor);
        }
        resumed = false;
        const { rows, page } = found;
        for (const row of rows) {
          const r = record(row);
          if (!Number.isFinite(r.at)) continue;
          // A pause, or the quarter of an hour before, closes the version
          // holding the newer edits.
          if (
            last !== null &&
            (last - r.at > VERSION_GAP || quarter(last) !== quarter(r.at))
          )
            close();
          if (!session.length) start = cursor;
          session.push(r);
          last = r.at;
          logged.push(r);
        }
        cursor = page.cursor;
      } while (cursor && complete <= 300);
      // Once the oldest edit is read, the board as it was created comes
      // last, so content that was there from the start, as from an import,
      // a template, or a copy, can be restored even if it was soon removed.
      const creator = meta.creator || meta.owner;
      const original =
        !cursor && born !== null && legacy.length + logged.length > 0
          ? { creator, at: born }
          : null;
      // Administrators can edit without a membership; their names come from
      // their organization records.
      for (const author of new Set([
        ...logged.map((r) => r.author),
        ...(original ? [creator] : []),
      ]))
        if (!names.has(author)) {
          const account = await this.org.user(author).catch(() => null);
          names.set(author, account?.username || "");
          if (
            !names.get(author) &&
            author === (await this.org.accountOwner()).uuid
          )
            names.set(author, (await this.org.accountOwner()).username || "");
        }
      for (const r of logged) r.username = names.get(r.author) || "";
      if (original) original.username = names.get(creator) || "";
      // On a board that takes anonymous notes, votes or answers, who edited
      // when would tell participants who wrote them, so only its owner and
      // facilitators see names; everyone else sees "Participant".
      if (!canManage(member.role) && (await this.anonymousInput(room, meta)))
        for (const r of [...legacy, ...logged, ...(original ? [original] : [])])
          r.username = "";
      const records = [...legacy, ...logged]
        .filter((v) => Number.isFinite(v.at))
        .sort((a, b) => a.at - b.at);
      // Newest first, a page at a time: `before` asks for the versions
      // older than the last one shown.
      const older = [
        ...historyVersions(records, undefined, Infinity),
        ...(original
          ? [
              {
                start: born,
                until: born,
                edits: 0,
                authors: [original.username || "Participant"],
                at: born,
                original: true,
              },
            ]
          : []),
      ].filter((v) => !Number.isFinite(before) || v.at < before);
      const versions = older.slice(0, 300),
        next = older.length > 300 && starts.get(versions.at(-1).at);
      return {
        created: meta.created,
        versions,
        more: older.length > 300,
        ...(next ? { next } : {}),
      };
    }
    if (input.op === "history.state") {
      const at = Number(input.at);
      if (!Number.isFinite(at)) fail(400, "Choose a version.");
      const { doc, count } = await this.loadAt(room, at);
      try {
        return { at, edits: count, update: encode(doc.update()) };
      } finally {
        doc.destroy();
      }
    }
    // Objects that came and went within a version: added, or there at the
    // version before (`after`), and removed by the version's time (`at`),
    // each as it last stood. Neither version holds them, so recovering
    // them needs the edits in between. A version lies within one quarter
    // of an hour, so no more than that is replayed whatever `after` says.
    // Like a version's state, they come as a board's objects for the app
    // to filter; those the workshop hid from this person when they were
    // removed are left out here, since the board then is not sent.
    if (input.op === "history.removed") {
      const at = Number(input.at),
        after = Number(input.after);
      if (!Number.isFinite(at) || !Number.isFinite(after) || after >= at)
        fail(400, "Choose a version.");
      const from = Math.max(after, quarter(at) * VERSION_SPAN - 1);
      const { doc } = await this.loadAt(room, from);
      try {
        const removed = new Map(),
          manager = canManage(member.role);
        let tags = new Map();
        doc.watchRemovals((items, before) => {
          tags = before.tags;
          let hidden = null;
          if (before.workshop) {
            const c = concealment(
              { workshop: before.workshop, items: before.items },
              user.uuid,
              manager,
            );
            hidden = new Set([...c.notes, ...c.frames, ...c.hidden]);
          }
          for (const item of items)
            if (hidden?.has(item.id)) removed.delete(item.id);
            else removed.set(item.id, item);
        });
        const records = [
          ...(await this.list(`wb:${room}:op:`)).map((r) => r.value),
          ...(await this.logSince(room, from + 1, at)).map((r) => r.value),
        ]
          .filter((v) => v && v.at > from && v.at <= at)
          .sort((a, b) => a.at - b.at);
        for (const value of records) await this.applyRecord(doc, value);
        const items = [...removed.values()]
          .filter((i) => !doc.items.has(i.id))
          .sort((a, b) => (a.z || 0) - (b.z || 0) || (a.id < b.id ? -1 : 1));
        const used = new Set(items.flatMap((i) => i.tagIds || []));
        // The tags they carried, as last seen, even ones deleted since.
        return {
          at,
          after: from,
          items,
          tags: [...tags.values()].filter((t) => used.has(t.id)),
        };
      } finally {
        doc.destroy();
      }
    }
    if (input.op === "history.restored" || input.op === "export") {
      this.perMinute(`${room}|${user.uuid}`, REPORT_LIMIT);
    }
    // The app reports a restoration it made, which the audit log records.
    // Its version is a time in the board's life, or none for a version
    // kept on the device; a few seconds' grace covers instances' clocks.
    // Whether the restoration's edit is saved before or after the report,
    // it changes no more objects than the board has ever held, and a
    // version kept on the device no more than a board can hold besides:
    // it can bring back objects deleted before the board was shared.
    if (input.op === "history.restored") {
      await this.member(room, user, true);
      const at = input.at ?? null;
      if (
        at !== null &&
        !(
          Number.isFinite(at) &&
          !(at < meta.created) &&
          at <= this.now() + 5_000
        )
      )
        fail(400, "Choose a version.");
      let objects = null;
      if (Number.isInteger(input.objects) && input.objects >= 0) {
        const { entry } = await this.board(room, meta);
        const doc = entry.live || new SharedDocument(this.durable(entry));
        try {
          objects = Math.min(
            input.objects,
            doc.objectsEver() + (at === null ? MAX_OBJECTS : 0),
          );
        } finally {
          if (doc !== entry.live) doc.destroy();
        }
      }
      await this.org.audit(
        user,
        "board.content.restored",
        { type: "board", id: room },
        {
          version: at,
          scope: ["board", "objects", "frame", "deleted"].includes(input.scope)
            ? input.scope
            : "board",
          objects,
        },
      );
      return { ok: true };
    }
    if (input.op === "export") {
      const format = String(input.format || "").slice(0, 20);
      await this.org.audit(
        user,
        "board.export",
        { type: "board", id: room },
        {
          format,
          scope: String(input.scope || "").slice(0, 20),
        },
      );
      return { ok: true };
    }
    if (input.op === "asset.put" || input.op === "asset.get") {
      if (!/^[a-f0-9]{64}$/.test(input.asset)) fail(400, "Invalid asset.");
      const path = `whiteboard/shared/${room}/assets/${input.asset}.txt`;
      // Assets are content-addressed, so cached copies never go stale.
      if (input.op === "asset.get")
        return { data: await this.cachedFile(path) };
      await this.member(room, user, true);
      this.perMinute(`asset|${room}|${user.uuid}`, ASSET_PUTS);
      if (
        typeof input.data !== "string" ||
        // The same limit the board itself sets for attachments.
        input.data.length > 15 * 1024 * 1024 ||
        !/^data:(image\/(png|jpeg|webp)|application\/octet-stream);base64,[A-Za-z0-9+/=]*$/.test(
          input.data,
        ) ||
        (await hash(input.data)) !== input.asset
      )
        fail(400, "Invalid shared asset.");
      // A board's shared files are capped in all, so one participant, such
      // as a guest, cannot fill its owner's storage.
      const used = `wb:${room}:assetbytes`,
        size = input.data.length;
      if ((await this.kv.incr(used, size)) > ASSET_BYTES) {
        await this.kv.incr(used, -size).catch(() => {});
        fail(
          413,
          "This board has reached its 1 GB limit for images and files.",
        );
      }
      await this.writeFile(path, input.data);
      return { ok: true };
    }
    if (input.op === "sync") {
      // Someone told of a saved change, by a board event or a peer, names
      // its record when they can, and says when it was saved. A copy this
      // instance read before can lack it, as when it was saved through
      // another instance, and nothing would ask for it again until the next
      // poll, so unless the copy holds the named records it is listed again.
      // The first to ask reads it for everyone told of the same save.
      // Records still missing afterwards, as when a listing lags a write,
      // are named back so the caller asks again shortly.
      const ids = Array.isArray(input.ids)
        ? input.ids
            .filter((id) => typeof id === "string" && id.length <= 128)
            .slice(0, 64)
        : [];
      const { entry } = await this.board(room, meta, {
        after: Number.isFinite(input.after) ? input.after : 0,
        ids,
        noticed: input.noticed === true || ids.length > 0,
      });
      // Activity counted within a minute of the last write is written once
      // the minute has passed.
      const activity = this.org.instance.activity.get(room);
      if (activity?.editor && this.now() - activity.at >= 60_000) {
        const doc = new SharedDocument(this.durable(entry));
        try {
          await this.writeActivity(
            room,
            activity.editor,
            doc.snapshot(),
            activity,
          ).catch(() => {});
        } finally {
          doc.destroy();
        }
      }
      return {
        serverTime: this.now(),
        update: encode(this.missing(entry, input.vector)),
        ...(ids.length
          ? { missing: ids.filter((id) => !entry.recent.has(id)) }
          : {}),
        role: member.role,
        archived,
      };
    }
    if (input.op === "commit") {
      await this.member(room, user, "comment");
      let { entry } = await this.board(room, meta);
      // Too large to accept is final, so the client can drop the edit
      // instead of retrying it forever.
      if (
        typeof input.update === "string" &&
        input.update.length > UPDATE_LIMIT
      )
        fail(413, "This change is too large to save.");
      // A malformed update is the client's to drop, not to send again as
      // it would a failure of the worker's.
      let update;
      try {
        update = decode(input.update, UPDATE_LIMIT);
      } catch {
        fail(400, "Invalid collaboration update.");
      }
      const digest = await hash(update);
      if (input.id !== digest) fail(400, "Update checksum does not match.");
      let doc, claims, checked;
      const features = boardFeatures(policy);
      for (let refreshed = false; !checked; refreshed = true) {
        // Another commit checked meanwhile may have failed and let go of
        // the live document while this one waited for its client lookup;
        // the document then holds the refused edit, so a fresh one is read.
        for (let attempt = 0; ; attempt++) {
          doc =
            entry.live ||
            this.keepLive(entry, new SharedDocument(this.durable(entry)));
          claims = await this.clientClaims(prefix, doc.doc.store, update, user);
          if (entry.live === doc || attempt >= 3) break;
        }
        // Until it is saved, the document holds an edit that may yet fail,
        // so synchronizations do not read it, and a failure lets go of it.
        doc.inflight = (doc.inflight || 0) + 1;
        try {
          checked = this.checkCommit(doc, update, user, member.role, features);
        } catch (error) {
          doc.inflight--;
          if (entry.live === doc) entry.live = null;
          // The edits it builds on may have been saved through another
          // instance since this one last read the log; if not, the client
          // retries shortly.
          if (error.status !== 409 || refreshed) throw error;
          // Out of listings, the client tries again shortly.
          if (this.short()) throw error;
          // A record that became visible later than the overlap a refresh
          // reads again would be missed for good, so at most every ten
          // seconds the board is read again from its checkpoint instead.
          const reload =
            this.now() - (RELOADS.get(room) ?? -Infinity) >= 10_000;
          if (reload) {
            RELOADS.delete(room);
            RELOADS.set(room, this.now());
            if (RELOADS.size > 1000)
              RELOADS.delete(RELOADS.keys().next().value);
          }
          // A read that fails or is slow, as when Puter refuses it, has
          // the client send the edit again shortly. Otherwise the commit
          // waits for a listing begun after it, shared and paced like those
          // for callers told of a save, so a burst of commits refused
          // together does not list the log once each.
          const read = this.board(
            room,
            meta,
            reload ? { reload: true } : { noticed: true },
          );
          if (!(await this.within(read, PATIENCE))) throw error;
          ({ entry } = await read);
        }
      }
      const { before, after, written } = checked;
      let fresh,
        savedAt = 0;
      try {
        // Assets already on the board were checked when they were added;
        // only newly referenced ones must be uploaded first.
        const assets = (board) =>
          new Set(
            board.items.flatMap((item) =>
              ["src", "data"]
                .map((key) => ASSET.exec(item[key] || "")?.[1])
                .filter(Boolean),
            ),
          );
        const known = assets(before);
        for (const asset of assets(after))
          if (!known.has(asset))
            try {
              await this.puter.fs.stat(
                `whiteboard/shared/${room}/assets/${asset}.txt`,
              );
            } catch (error) {
              // A file that is not there is refused for good, like an edit
              // that fails a check: the client recovers the rest without it
              // rather than sending the edit again forever.
              if (
                error?.code &&
                !["subject_does_not_exist", "ENOENT", "not_found"].includes(
                  error.code,
                )
              )
                throw error;
              fail(422, "This change adds a file that was not uploaded.");
            }
        await this.claim(claims, user);
        const record = {
          id: digest,
          author: user.uuid,
          username: user.username,
          at: this.now(),
        };
        const flight = `${room}|${user.uuid}|${digest}`;
        fresh = !COMMITS.has(flight);
        if (fresh) {
          if (COMMITS.size > 5000) COMMITS.delete(COMMITS.keys().next().value);
          COMMITS.set(
            flight,
            (async () => {
              if (input.update.length <= MAX_UPDATE)
                record.update = input.update;
              else {
                record.path = `whiteboard/shared/${room}/updates/${digest}.txt`;
                await this.writeFile(record.path, input.update);
              }
              // The record's time is when it becomes visible, not when the
              // commit arrived: a slow file write must not leave it older
              // than the window other instances read again when they
              // refresh, or they would never apply it.
              record.at = savedAt = this.now();
              await this.kv.set(
                `${prefix}log:${new Date(record.at).toISOString()}:${user.uuid}:${digest}`,
                record,
              );
            })().catch((error) => {
              COMMITS.delete(flight);
              throw error;
            }),
          );
        }
        await COMMITS.get(flight);
      } catch (error) {
        if (entry.live === doc) entry.live = null;
        throw error;
      } finally {
        doc.inflight--;
      }
      const receipt = { id: digest, author: user.uuid, room };
      this.remember(room, update, digest, savedAt);
      await this.notify(room, digest);
      if (fresh) await this.recordActivity(room, user, before, after, written);
      return {
        serverTime: this.now(),
        update: encode(this.missing(entry, input.vector)),
        receipt,
        receiptProof: await sign(meta.keys.privateKey, receipt),
        role: member.role,
        archived,
      };
    }
    fail(400, "Unknown collaboration operation.");
  }
  // Applies a commit to a loaded board and checks it, returning the board
  // before and after. Nothing here awaits, so no other request changes the
  // document in between.
  checkCommit(doc, update, user, role, features = null) {
    const store = doc.doc.store;
    const current = doc.view?.version === (doc.version || 0);
    const before = current ? doc.view.board : doc.snapshot(),
      counts = doc.commentCounts(),
      // A commit may not add to a count or lengthen a text over its limit,
      // but the board keeps what simultaneous commits already took past one.
      allowed = { ...doc.counts(), ...oversized(before) },
      pending = pendingSize(store);
    const written = doc.applyTracked(update);
    doc.version = (doc.version || 0) + 1;
    // An update can carry edits or deletions that wait for clocks this
    // state has not seen. They are invisible to every check below and
    // would apply later, for example erasing another person's future
    // edits, so they are refused. A board left waiting by an earlier
    // failure still refuses anything that adds to what it waits for.
    const waiting = pendingSize(store);
    if (
      waiting.missing > pending.missing ||
      waiting.structs > pending.structs ||
      waiting.deletes > pending.deletes
    )
      fail(409, "This change depends on edits that have not arrived yet.");
    let after;
    try {
      const raw = doc.snapshot("shared", false);
      doc.validate(allowed, {
        board: raw,
        items: written.items,
        changes: written.changes,
      });
      after = raw.comments
        ? {
            ...raw,
            comments: updateCommentAnchors(raw.comments, raw.items),
          }
        : raw;
      validateCommentChanges(before.comments, after.comments, user, this.now());
      validateCommentGrowth(counts, doc.commentCounts());
      validateWorkshopWrites(written.workshop, role, user, after.workshop);
      validateWorkshopChanges(before, after, user, role, this.now(), written);
      if (features) validateEmbeds(before.items, after.items, features);
      // Rewriting someone else's comment with its own words changes
      // nothing visible but would win over the author's own edit.
      for (const [thread, ids] of written.messages)
        for (const id of ids) {
          const author = doc.comments
            .get(thread)
            ?.get("messages")
            ?.get(id)
            ?.get?.("authorId");
          if (author !== undefined && author !== user.uuid)
            throw Error("Only the author can edit this comment.");
        }
    } catch (error) {
      // Concurrent edits can cross board limits; retrying this batch
      // only succeeds after the shared state changes.
      fail(422, error.message || "This change was rejected.");
    }
    // Rewriting content with its current values changes nothing
    // visible but still wins over editors' concurrent changes.
    if (
      !canEditContent(role) &&
      ([...written.roots].some(
        (root) => root !== "comments" && root !== "workshop",
      ) ||
        !sameContent(before, after))
    )
      fail(422, "Commenters can add comments but cannot change board content.");
    // The next commit starts from this projection.
    doc.view = { version: doc.version, board: after };
    return { before, after, written };
  }
  // A browser only ever uploads its own edits, made under its own Yjs client
  // IDs. Content added under someone else's ID, even content nobody can see,
  // would occupy the positions their next edits take, so every copy of the
  // board would drop those edits. The first person whose accepted commit adds
  // content under an ID owns it; content under another person's ID is
  // refused. Returns the IDs this commit would claim.
  async clientClaims(prefix, store, update, user) {
    let to;
    try {
      ({ to } = parseUpdateMeta(update));
    } catch {
      fail(400, "Invalid collaboration update.");
    }
    const claims = [];
    for (const [client, clock] of to) {
      if (clock <= getState(store, client)) continue;
      const key = `${prefix}client:${client}`;
      const owner = CLIENTS.get(key) ?? (await this.kv.get(key));
      if (!owner) {
        // Each new client costs a storage write and a record kept for good.
        // A browser's commit comes from one client, or a few after reloads;
        // one naming many more is crafted to make the worker write.
        if (claims.length >= MAX_CLIENT_CLAIMS)
          fail(422, "This change spans too many editing sessions.");
        claims.push(key);
      } else {
        keepClient(key, owner);
        if (owner !== user.uuid)
          fail(422, "This change continues another participant's edits.");
      }
    }
    return claims;
  }
  async claim(claims, user) {
    for (const key of claims) {
      await this.kv.set(key, user.uuid);
      keepClient(key, user.uuid);
    }
  }
  async managesIntegrations(meta, user) {
    if (meta.owner === user.uuid) return true;
    const role = await this.org.role(user);
    return role === "owner" || role === "admin";
  }
  // What the board's own organization lets it be shared with, and whether
  // this person belongs to it, so the share and settings dialogs offer what
  // the board allows rather than what the viewer's own organization does.
  async sharing(user, policy) {
    const organization = await this.org.configured();
    const role = organization ? await this.org.role(user) : null;
    return {
      organization,
      member: !organization || (!!role && role !== "guest"),
      guests:
        !organization ||
        (policy.guestAccess !== false &&
          policy.externalSharing !== "none" &&
          !policy.restrictToOrganization),
      publicLinks:
        !organization ||
        (!!policy.publicLinks && policy.externalSharing === "anyone"),
      guestRole: (organization && policy.guestRole) || "facilitator",
    };
  }
  async renewGuest(room, user, manager, input) {
    const target = id(input.uuid);
    const record = await this.kv.get(`wb:${room}:member:${target}`);
    if (!record || record.role === "removed") fail(404, "Member not found.");
    // Facilitators look after the roles below theirs, as with role changes.
    if (record.role === "owner") fail(400, "Invalid role change.");
    if (!(await this.isGuest(record)))
      fail(400, "Only a guest's access can be renewed.");
    const policy = await this.org.accessPolicy();
    // Judged by the role the guest acts with, as everyone is shown.
    if (
      guestRole(record.role, policy) === "facilitator" &&
      manager.role !== "owner"
    )
      fail(403, "Only the board owner can change facilitators.");
    if (guestsShutOut(policy))
      fail(403, "Your organization does not allow guest access.");
    const now = this.now();
    const next = { ...record, joined: now };
    if (policy.guestExpiryDays)
      next.expires = now + policy.guestExpiryDays * DAY;
    else delete next.expires;
    await this.setMember(room, next);
    await this.refreshCounts(room);
    await this.org.audit(
      user,
      "board.guest.renewed",
      { type: "board", id: room },
      { uuid: target, ...(next.expires ? { until: next.expires } : {}) },
    );
    const ends = await this.guestEnds(next, next, await this.org.role(next));
    return {
      member: { ...next, ...(ends !== null ? { accessEnds: ends } : {}) },
    };
  }
  settings(meta) {
    return {
      visibility: meta.visibility || "private",
      orgRole: meta.orgRole || "editor",
      linkRole: meta.linkRole || "viewer",
      archived: !!meta.archived,
      legalHold: !!meta.legalHold,
    };
  }
  // New membership: an invitation, organization-wide visibility, or a public
  // link, each subject to the organization's external sharing policy.
  async admit(room, user, input) {
    // A deactivated account joins nothing, so no membership, audit record,
    // or guest count is left behind for a later reactivation.
    if (!(await this.org.active(user)))
      fail(403, "Your organization account is deactivated.");
    const prefix = `wb:${room}:`;
    const prior = await this.kv.get(prefix + "member:" + user.uuid);
    // Administrators govern every board, even one they were removed from,
    // as the Miro migration does for the administrator who ran it.
    if (prior?.role === "removed") {
      const orgRole = await this.org.role(user);
      if (orgRole !== "owner" && orgRole !== "admin")
        fail(403, "Your board access was removed.");
      return;
    }
    // Invitation validity controls new membership, not an existing member's
    // access. A guest whose access expired can be let back in by a newer
    // invitation, which starts their guest access again.
    let lapsed = false;
    if (prior && input.token) {
      const ends = await this.guestEnds(prior, user, await this.org.role(user));
      lapsed = ends !== null && ends < this.now();
    }
    // Someone who came in through a public link or the organization, while
    // the board is still shared that way, is already a member; once it is
    // not, they come in again by whatever now admits them.
    // An invitation still counts for someone who came in through the board
    // being shared: it makes them a member by name, with its role if higher.
    if (
      prior &&
      !lapsed &&
      !(prior.via && input.token) &&
      (!prior.via ||
        prior.via === (await this.kv.get(prefix + "meta"))?.visibility)
    )
      return;
    const [meta, orgRole, policy, configured] = await Promise.all([
      this.kv.get(prefix + "meta"),
      this.org.role(user),
      this.org.policy(),
      this.kv.get("org:meta"),
    ]);
    if (!meta) fail(404, "Board not found.");
    if (orgRole === "owner" || orgRole === "admin") return;
    // A deleted board admits no one, so joining it records nothing.
    if (meta.deleted) fail(404, "Board not found.");
    const insider = !!orgRole && orgRole !== "guest";
    let role = null,
      guest = false,
      via = null;
    if (input.token) {
      const invite = await this.kv.get(
        prefix + "invite:" + (await hash(input.token)),
      );
      if (!invite || invite.revoked || invite.expires < this.now())
        fail(403, "This invitation has expired or was revoked.");
      // An invitation stops working once the person who made it could no
      // longer grant its role, as when a facilitator is removed or an owner
      // who invited facilitators hands the board to someone else.
      if (invite.createdBy) {
        const issuer = await this.member(room, {
          uuid: invite.createdBy,
        }).catch(() => null);
        const role = issuer?.member.role;
        if (
          !canManage(role) ||
          (invite.role === "facilitator" && role !== "owner")
        )
          fail(403, "This invitation has expired or was revoked.");
      }
      // An invitation from before the guest joined cannot renew them.
      const created = invite.created ?? invite.expires - INVITE_DAYS * DAY;
      if (lapsed && !(created > (prior.joined || 0)))
        fail(403, "Your guest access to this board has expired.");
      if (invite.membersOnly && configured && !insider)
        fail(
          403,
          "This link is only for members of the organization. Ask the person who shared it for a guest invitation.",
        );
      role = invite.role;
      // Never lower than what the board's sharing already gave them.
      if (
        prior?.via &&
        !lapsed &&
        BOARD_ROLES.indexOf(prior.role) >= 0 &&
        BOARD_ROLES.indexOf(prior.role) < BOARD_ROLES.indexOf(role)
      )
        role = prior.role;
      // On an organization's board, whether someone is a guest is whether
      // they are outside it; a member who opens a guest link is a member.
      guest = configured ? !insider : invite.guest === true;
    } else if (meta.visibility === "organization" && insider) {
      role = meta.orgRole || "editor";
      via = "organization";
    } else if (meta.visibility === "link") {
      role = meta.linkRole || "viewer";
      via = "link";
      guest = !!configured && !insider;
      // Public links stop admitting outsiders once the organization turns
      // them off, like setting a board's visibility to a public link.
      if (guest && (!policy.publicLinks || policy.externalSharing !== "anyone"))
        fail(403, "Your organization does not allow public board links.");
    }
    if (!role) return;
    // A guest's role is kept as the link gave it; every request limits it
    // to what the organization lets guests have (see member()), so raising
    // the limit gives it back.
    if (guest && configured) {
      if (policy.externalSharing === "none" || policy.restrictToOrganization)
        fail(
          403,
          "Your organization only allows its own members on this board.",
        );
      if (!policy.guestAccess)
        fail(403, "Your organization does not allow guest access.");
    }
    const record = {
      uuid: user.uuid,
      username: user.username,
      role,
      ...(via ? { via } : {}),
      ...(guest ? { guest: true } : {}),
      ...(guest && configured && policy.guestExpiryDays
        ? { expires: this.now() + policy.guestExpiryDays * DAY }
        : {}),
      joined: this.now(),
    };
    await this.setMember(room, record, !prior);
    // Instances without this record already treat them as a guest.
    if (guest && configured && !(await this.org.user(user.uuid)))
      await this.org.saveUser(
        {
          uuid: user.uuid,
          username: user.username,
          role: "guest",
          status: "active",
          license: "guest",
          created: this.now(),
          source: "board",
          teams: [],
        },
        true,
      );
    await this.refreshCounts(room);
    await this.org.audit(
      user,
      guest ? "board.guest.joined" : "board.joined",
      { type: "board", id: room },
      { role, via: input.token ? "invitation" : meta.visibility },
    );
  }
  async updateSettings(room, user, meta, input) {
    const policy = await this.org.policy();
    const configured = !!(await this.kv.get("org:meta"));
    // Who can open an organization's board is the organization's to decide:
    // a guest facilitating it manages its participants but cannot open it
    // to the whole organization or to anyone with the link.
    if (
      configured &&
      ["visibility", "orgRole", "linkRole"].some(
        (key) =>
          input[key] !== undefined && input[key] !== this.settings(meta)[key],
      ) &&
      meta.owner !== user.uuid &&
      ["guest", null].includes(await this.org.role(user))
    )
      fail(
        403,
        "Only members of the organization can change who can open this board.",
      );
    if (input.slack !== undefined) {
      // Mentions go to this channel, so only the owner or an administrator
      // chooses it; a facilitator's own channel would outlast their access.
      if (!(await this.managesIntegrations(meta, user)))
        fail(
          403,
          "Only the board owner or an administrator can connect Slack.",
        );
      if (
        input.slack &&
        !/^https:\/\/hooks\.slack\.com\//.test(String(input.slack))
      )
        fail(400, "Enter a Slack incoming webhook URL.");
    }
    const changes = {};
    if (input.visibility !== undefined) {
      if (!["private", "organization", "link"].includes(input.visibility))
        fail(400, "Invalid visibility.");
      // Only turning a public link on is refused; a board that kept one
      // from before the policy changed can still save its other settings.
      if (
        input.visibility === "link" &&
        meta.visibility !== "link" &&
        configured &&
        (!policy.publicLinks || policy.externalSharing !== "anyone")
      )
        fail(403, "Your organization does not allow public board links.");
      changes.visibility = input.visibility;
    }
    for (const key of ["orgRole", "linkRole"])
      if (input[key] !== undefined) {
        if (!["editor", "commenter", "viewer"].includes(input[key]))
          fail(400, "Invalid default role.");
        changes[key] = input[key];
      }
    // Every field is checked before anything is saved, so a refused
    // request never changes the board's visibility on its own.
    const filed = await this.filing(user, input);
    // Only the requested fields change, on the latest copy, so a hold,
    // archive, or transfer made meanwhile is kept.
    const next = {
      ...((await this.kv.get(`wb:${room}:meta`)) || meta),
      ...changes,
    };
    await this.setRecord(room, `wb:${room}:meta`, next, {
      disableSharing: true,
    });
    const patch = { visibility: next.visibility || "private", ...filed };
    const old = Object.keys(filed).length
      ? await this.kv.get("org:board:" + room)
      : null;
    const record = await this.org.registerBoard(room, patch);
    // Access that came with the old way of sharing ends, and access that
    // came with the new one returns, in people's board lists too.
    if ((meta.visibility || "private") !== patch.visibility) {
      await this.refreshCounts(room);
      const came = (await this.members(room)).filter(
        (m) => m.via && m.role !== "removed",
      );
      for (let n = 0; n < came.length; n += 20)
        await Promise.all(
          came
            .slice(n, n + 20)
            .map((m) =>
              this.org.indexMembership(
                m.uuid,
                room,
                m.via === patch.visibility ? m.role : null,
              ),
            ),
        );
    }
    if (input.slack !== undefined) {
      const had = !!(await this.kv.get("org:boardslack:" + room));
      // Who connected it is kept, so the channel stops hearing about the
      // board once they no longer manage it.
      if (input.slack)
        await this.kv.set(
          "org:boardslack:" + room,
          { url: String(input.slack).slice(0, 2048), by: user.uuid },
          {
            disableSharing: true,
          },
        );
      else await this.kv.del("org:boardslack:" + room);
      if (had || input.slack)
        await this.org.audit(
          user,
          "board.share.slack",
          { type: "board", id: room },
          { connected: !!input.slack },
        );
    }
    if ((meta.visibility || "private") !== (next.visibility || "private"))
      await this.org.audit(
        user,
        next.visibility === "link"
          ? "board.visibility.link"
          : "board.visibility.changed",
        { type: "board", id: room },
        { from: meta.visibility || "private", to: next.visibility },
      );
    // The access organization members and link holders get by default.
    for (const [key, setting, initial] of [
      ["orgRole", "organization", "editor"],
      ["linkRole", "link", "viewer"],
    ])
      if ((meta[key] || initial) !== (next[key] || initial))
        await this.org.audit(
          user,
          "board.share.role",
          { type: "board", id: room },
          {
            setting,
            from: meta[key] || initial,
            to: next[key],
            visibility: next.visibility || "private",
          },
        );
    for (const key of ["space", "team"])
      if (filed[key] !== undefined && (old?.[key] || null) !== filed[key])
        await this.org.audit(
          user,
          "board.filed",
          { type: "board", id: room },
          { [key]: filed[key], from: old?.[key] || null },
        );
    await this.notify(room);
    return {
      settings: {
        ...this.settings(next),
        space: record.space || null,
        team: record.team || null,
      },
    };
  }
  async govern(room, user, meta, member, input) {
    const orgRole = await this.org.role(user);
    const admin = orgRole === "owner" || orgRole === "admin";
    if (input.op === "hold" && !admin)
      fail(403, "Only organization administrators can place legal holds.");
    if (!admin && !(member.role === "owner" && meta.owner === user.uuid))
      fail(403, "Only the board owner or an administrator can do this.");
    // Retention has begun removing its records, so it could only come back
    // with part of it missing.
    if ((await this.kv.get("org:board:" + room))?.purging)
      fail(409, "This board is being permanently deleted.");
    if (
      input.op === "delete" &&
      (meta.legalHold ||
        (await this.kv.get("org:board:" + room))?.legalHold ||
        (await this.org.policy()).retention.legalHold)
    )
      fail(409, "This board is under a legal hold and cannot be deleted.");
    // The change applies to the latest copy, so another request's change,
    // such as a legal hold, is kept. A board purged since this request read
    // it is not written back.
    const latest = await this.kv.get(`wb:${room}:meta`);
    if (!latest) fail(404, "Board not found.");
    // Deleting a board already in the trash keeps the time it went there,
    // so repeating the request cannot put off its permanent deletion.
    if (input.op === "delete" && latest.deleted)
      return { settings: this.settings(latest) };
    const next = { ...latest };
    if (input.op === "archive") next.archived = this.now();
    if (input.op === "unarchive") delete next.archived;
    if (input.op === "restore") {
      delete next.archived;
      delete next.deleted;
    }
    if (input.op === "delete") {
      if (next.legalHold)
        fail(409, "This board is under a legal hold and cannot be deleted.");
      next.deleted = this.now();
    }
    if (input.op === "hold") next.legalHold = input.enabled !== false;
    const registry = {
      archived: next.archived || null,
      deleted: next.deleted || null,
      legalHold: !!next.legalHold,
    };
    // A board already in that state, such as one restored twice or
    // archived from two tabs, keeps its record and its time: nothing
    // happened to audit.
    if (
      ["archived", "deleted", "legalHold"].every(
        (key) => !!next[key] === !!latest[key],
      )
    ) {
      await this.org.registerBoard(room, {
        archived: latest.archived || null,
        deleted: latest.deleted || null,
        legalHold: !!latest.legalHold,
      });
      return { settings: this.settings(latest) };
    }
    await this.setRecord(room, `wb:${room}:meta`, next, {
      disableSharing: true,
    });
    await this.org.registerBoard(room, registry);
    await this.org.audit(
      user,
      {
        archive: "board.archived",
        unarchive: "board.unarchived",
        restore: "board.restored",
        delete: "board.deleted",
        hold: next.legalHold ? "board.hold.placed" : "board.hold.released",
      }[input.op],
      { type: "board", id: room },
    );
    await this.notify(room);
    return { settings: this.settings(next) };
  }
  // Counts the objects the commit added, removed, or changed among those it
  // wrote, which are all a commit can change but derived positions.
  async recordActivity(room, user, before, after, written) {
    try {
      const old = new Map(before.items.map((i) => [i.id, i]));
      const now = new Map(after.items.map((i) => [i.id, i]));
      const added = after.items.filter((i) => !old.has(i.id)).length,
        removed = before.items.filter((i) => !now.has(i.id)).length;
      let changed = 0;
      for (const id of written.items)
        if (
          old.has(id) &&
          now.has(id) &&
          JSON.stringify(old.get(id)) !== JSON.stringify(now.get(id))
        )
          changed++;
      // Directory, search index, and content audit records are written at
      // most once a minute per board and worker instance; counts in between
      // are added up. Busy workshops would otherwise spend the worker's
      // storage quota on bookkeeping. A deletion is written at once, with
      // what the minute held before it: counts held in memory go if the
      // instance stops, and a deletion must reach the activity log.
      const activity = this.org.instance.activity;
      const entry = activity.get(room) || {
        at: 0,
        added: 0,
        changed: 0,
        removed: 0,
        editors: new Set(),
      };
      entry.added += added;
      entry.changed += changed;
      entry.removed += removed;
      if (added || changed || removed) entry.editors.add(user.uuid);
      activity.delete(room);
      activity.set(room, entry);
      // An instance keeps the boards edited through it most recently; one
      // let go of has what it held back written first.
      while (activity.size > 1000) {
        const [old, kept] = activity.entries().next().value;
        activity.delete(old);
        if (kept.editor) await this.writeHeldActivity(old, kept, false);
      }
      if (
        this.now() - entry.at >= 60_000 ||
        before.title !== after.title ||
        removed
      )
        await this.writeActivity(room, user, after, entry);
      // Otherwise this instance's first request after the minute writes
      // it, so revealed content becomes findable when the board goes quiet.
      else if (
        added ||
        changed ||
        JSON.stringify(before.workshop?.settings) !==
          JSON.stringify(after.workshop?.settings)
      ) {
        entry.editor = user;
        const instance = this.org.instance;
        instance.activityDue = Math.min(
          instance.activityDue ?? Infinity,
          entry.at + 60_000,
        );
      }
      await this.commentNotifications(room, user, before, after);
      await this.taskAssignments(room, user, before, after);
      for (const { action, details } of workshopEvents(
        before.workshop,
        after.workshop,
      ))
        await this.org.audit(
          user,
          action,
          { type: "board", id: room, name: after.title },
          details,
        );
    } catch {
      /* Activity records never block an acknowledged edit. */
    }
  }
  // Writes what boards edited through this instance held back once their
  // minute has passed, whichever request comes next: the board's own next
  // synchronization may reach another instance, or never come.
  async writeDueActivity() {
    const instance = this.org.instance,
      now = this.now();
    if (!(now >= instance.activityDue)) return;
    // Activity held back while this writes sets its own due time, which is
    // kept: the time is worked out afresh here, not written over it.
    instance.activityDue = Infinity;
    let due = Infinity;
    for (const [room, entry] of [...instance.activity])
      if (!entry.editor) continue;
      else if (now - entry.at >= 60_000)
        await this.writeHeldActivity(room, entry).catch(() => {});
      else due = Math.min(due, entry.at + 60_000);
    instance.activityDue = Math.min(instance.activityDue, due);
  }
  // Writes a board's held-back activity from the board as this instance
  // has it, loading it if `load` and it is not kept. Otherwise, or if it
  // cannot be loaded, only the content audit record is written, and the
  // directory entry and search text follow with the board's next write.
  async writeHeldActivity(room, entry, load = true) {
    const cached = DOCS.get(room);
    let doc = null;
    try {
      if (cached?.state) doc = new SharedDocument(this.durable(cached));
      else if (load) ({ doc } = await this.load(room));
    } catch {
      /* Counted without it. */
    }
    try {
      if (doc)
        return await this.writeActivity(
          room,
          entry.editor,
          doc.snapshot(),
          entry,
        );
      const user = entry.editor;
      entry.editor = null;
      await this.auditActivity(room, user, null, entry);
    } catch {
      /* Activity records never block a request. */
    } finally {
      doc?.destroy();
    }
  }
  // The directory entry, search index, and content audit record of a board,
  // with the edits counted since they were last written.
  async writeActivity(room, user, board, entry) {
    entry.at = this.now();
    entry.editor = null;
    const { text, content, ...summary } = boardSummary(board);
    // Boards with no text at all, such as diagrams of bare shapes, are told
    // apart by their objects' kinds and places; an empty board has none.
    const basis =
      content ||
      board.items
        .map(
          (i) =>
            `${i.type}:${i.shape || ""}:${[i.x, i.y, i.w, i.h].map(Math.round)}`,
        )
        .join("|");
    const fingerprint = basis ? (await hash(basis)).slice(0, 24) : null;
    // The search text often stays the same, as when notes only move, and
    // reading it costs far less than writing it. Text this instance stored
    // last is read back, in case another instance changed it since.
    const key = "org:idx:" + room,
      digest = await hash(text);
    const [, stored] = await Promise.all([
      this.org.registerBoard(room, {
        ...summary,
        fingerprint,
        updated: this.now(),
        lastActivity: this.now(),
        lastEditor: user.uuid,
      }),
      INDEXED.get(room) === digest ? this.kv.get(key) : undefined,
    ]);
    if (stored !== text) await this.kv.set(key, text);
    INDEXED.delete(room);
    if (INDEXED.size >= 1000) INDEXED.delete(INDEXED.keys().next().value);
    INDEXED.set(room, digest);
    await this.auditActivity(room, user, board.title, entry);
  }
  // The content audit record of the edits counted since the last one.
  async auditActivity(room, user, title, entry) {
    const counts = {
      added: entry.added,
      changed: entry.changed,
      removed: entry.removed,
      editors: [...entry.editors].slice(0, 50),
    };
    entry.added = entry.changed = entry.removed = 0;
    entry.editors.clear();
    if (counts.added || counts.changed || counts.removed)
      await this.org.audit(
        user,
        "board.content.updated",
        { type: "board", id: room, name: title },
        counts,
      );
  }
  // Notifications carry the board's title and content, so only people who
  // could open the board now receive them: not guests whose access lapsed
  // or that the organization's policy no longer admits.
  async canOpen(room, person) {
    return this.member(room, {
      uuid: person.uuid,
      username: person.username,
    }).then(
      () => true,
      () => false,
    );
  }
  // A task newly assigned to a board member notifies that member. Free-text
  // assignees on personal boards have no account and are not notified.
  async taskAssignments(room, user, before, after) {
    const changes = assignmentChanges(before, after);
    if (!changes.length) return;
    const members = new Map(
      (await this.members(room))
        .filter((m) => m.role !== "removed")
        .map((m) => [m.uuid, m]),
    );
    // A task the workshop hides from its assignee, such as one in a frame
    // not yet revealed, is not named or counted to them.
    const concealed = new Map();
    const unseen = (member, id) => {
      if (!after.workshop) return false;
      if (!concealed.has(member.uuid)) {
        const c = concealment(after, member.uuid, canManage(member.role));
        concealed.set(
          member.uuid,
          new Set([...c.hidden, ...c.frames, ...c.notes]),
        );
      }
      return concealed.get(member.uuid).has(id);
    };
    // Notes added while the workshop takes anonymous input, or recorded as
    // anonymous, do not name who wrote them in the notification either.
    const earlier = new Set(before.items.map((i) => i.id)),
      anonymous = !!workshopSettings(after).anonymous;
    const unnamed = (id) =>
      !!after.workshop?.[contributionKey(id)]?.anonymous ||
      (anonymous && !earlier.has(id));
    // Each person hears about an edit once, naming its first task and how
    // many more it gave them, so pasting many assigned tasks floods no one.
    const first = new Map(),
      rest = { count: 0, assignees: new Set() },
      probes = new Map();
    let budget = 200;
    for (const [index, { item, assignee }] of changes.entries()) {
      const member = members.get(assignee.id);
      if (!member) continue;
      // Past the first hundred, one edit's assignments still reach their
      // people in their grouped notification and are audited together.
      // Each person's first few are checked against, and recorded as,
      // earlier announcements, so tasks that come back all at once, as
      // after restoring a version, are not announced again; the others
      // count only toward a notification already due.
      if (index >= 100) {
        rest.count++;
        rest.assignees.add(member.uuid);
        if (unseen(member, item.id)) continue;
        const entry = first.get(member.uuid),
          probed = probes.get(member.uuid) || 0;
        if (probed < 10 && budget > 0) {
          probes.set(member.uuid, probed + 1);
          const told = `wb:${room}:assigned:${item.id}`;
          budget--;
          if (!entry && member.uuid !== user.uuid) {
            budget--;
            if ((await this.kv.get(told)) === member.uuid) continue;
          }
          await this.kv.set(
            told,
            member.uuid,
            Math.floor((this.now() + 30 * DAY) / 1000),
          );
        } else if (!entry) continue;
        if (member.uuid === user.uuid) continue;
        if (entry) entry.more++;
        else first.set(member.uuid, { item, more: 0 });
        if (unnamed(item.id)) first.get(member.uuid).anonymous = true;
        continue;
      }
      // A task that comes back with the same assignee, as after undoing
      // its deletion, restoring a version, or cutting and pasting it, was
      // already announced; repeating that must not flood their inbox.
      const told = `wb:${room}:assigned:${item.id}`;
      // Someone who assigns a task to themselves hears nothing, and nor
      // when someone else later brings that task back.
      if (member.uuid === user.uuid)
        await this.kv.set(
          told,
          member.uuid,
          Math.floor((this.now() + 30 * DAY) / 1000),
        );
      else if (
        !unseen(member, item.id) &&
        (await this.kv.get(told)) !== member.uuid
      ) {
        await this.kv.set(
          told,
          member.uuid,
          Math.floor((this.now() + 30 * DAY) / 1000),
        );
        const entry = first.get(member.uuid);
        if (entry) entry.more++;
        else first.set(member.uuid, { item, more: 0 });
        if (unnamed(item.id)) first.get(member.uuid).anonymous = true;
      }
      await this.org.audit(
        user,
        "board.content.task_assigned",
        { type: "board", id: room, name: after.title },
        { item: item.id, assignee: member.uuid },
      );
    }
    if (rest.count)
      await this.org.audit(
        user,
        "board.content.task_assigned",
        { type: "board", id: room, name: after.title },
        {
          count: rest.count,
          assignees: [...rest.assignees].slice(0, 20),
        },
      );
    for (const [uuid, { item, more, anonymous: hide }] of first) {
      if (!(await this.canOpen(room, members.get(uuid)))) continue;
      const captured = capturedTaskTitle(item),
        title = captured.title;
      const others = more ? ` and ${more} more` : "";
      const who = hide ? "A participant" : user.username;
      await this.org.notify(uuid, {
        type: "assignment",
        board: room,
        boardTitle: after.title,
        item: item.id,
        url: await this.org.boardLink(room, item.id),
        ...(hide
          ? { anonymous: true }
          : { actor: { uuid: user.uuid, username: user.username } }),
        subject: `${who} assigned you ${more ? "tasks" : "a task"} on ${after.title}`,
        text: `${who}: ${title}${item.task.due ? ` (due ${item.task.due})` : ""}${others}`,
        // The app words notifications in each person's language.
        ...captured,
        ...(item.task.due ? { due: item.task.due } : {}),
        ...(more ? { more } : {}),
      });
    }
  }
  // Mentions and replies become notifications for the people involved. An
  // edited message notifies only the names the edit added.
  async commentNotifications(room, user, before, after) {
    const known = new Map(
      (before.comments || []).flatMap((t) =>
        t.messages.map((m) => [m.id, m.text]),
      ),
    );
    const added = [];
    for (const thread of after.comments || [])
      for (const message of thread.messages) {
        if (message.deleted) continue;
        if (!known.has(message.id)) {
          added.push({ thread, message });
          continue;
        }
        const was = known.get(message.id);
        if (was === message.text) continue;
        const earlier = new Set(mentions(was));
        const only = new Set(
          mentions(message.text).filter((name) => !earlier.has(name)),
        );
        if (only.size) added.push({ thread, message, only });
      }
    if (!added.length) return;
    const records = await this.members(room, { shared: true }),
      members = records.filter((m) => m.role !== "removed"),
      removed = new Set(
        records.filter((m) => m.role === "removed").map((m) => m.uuid),
      );
    const byName = new Map(
      members.map((m) => [String(m.username || "").toLowerCase(), m]),
    );
    const byId = new Map(members.map((m) => [m.uuid, m]));
    // The organization's owner and administrators open every board without
    // joining it, so they have no member record; mentions and replies reach
    // them as they do members. They are read only for a name or author no
    // member matches.
    let governors;
    const governing = () =>
      (governors ??= (async () => {
        const [owner, admins] = await Promise.all([
          this.org.accountOwner().catch(() => null),
          this.org
            .adminIds()
            .then((ids) => Promise.all(ids.map((uuid) => this.org.user(uuid)))),
        ]);
        return [owner, ...admins].filter((p) => p?.uuid && p.username);
      })().catch(() => []));
    // A board shared with the whole organization admits its members as they
    // first open it, which is when their member record is written; until
    // then a mention reaches them as long as nothing keeps them out. They
    // too are read only for a name no member matches.
    const colleagues = new Set();
    let everyone;
    const colleague = async (name) => {
      everyone ??= (async () => {
        const meta = await this.kv.get(`wb:${room}:meta`);
        if (meta?.visibility !== "organization" || meta.deleted) return [];
        // Only the organization's own members reach colleagues this way,
        // as only they are offered them as mentions.
        const role = await this.org.role(user);
        if (!role || role === "guest") return [];
        return (await this.org.activePeople()).filter(
          (p) =>
            p.username &&
            p.role &&
            p.role !== "guest" &&
            !removed.has(p.uuid) &&
            p.uuid !== user.uuid,
        );
      })().catch(() => []);
      const found = (await everyone).find(
        (p) => p.username.toLowerCase() === name,
      );
      if (found) colleagues.add(found.uuid);
      return found;
    };
    const named = async (name) =>
      byName.get(name) ||
      (await governing()).find((p) => p.username.toLowerCase() === name) ||
      (await colleague(name));
    const author = async (uuid) =>
      byId.get(uuid) || (await governing()).find((p) => p.uuid === uuid);
    // One edit can hold many messages, as when threads are pasted. Only the
    // first few notify anyone or are audited one by one, each person hears
    // about the edit once, and the board's channel gets one post, so no edit
    // can flood anyone. The rest are audited together in one record.
    const notified = new Set();
    const target = { type: "board", id: room, name: after.title };
    const rest = { count: 0, threads: new Set(), mentions: 0 };
    let posted = false;
    for (const [index, { thread, message, only }] of added.entries()) {
      const recipients = new Map(),
        people = new Map();
      for (const name of mentions(message.text)) {
        if (only && !only.has(name)) continue;
        const m = await named(name);
        if (m && m.uuid !== user.uuid) {
          recipients.set(m.uuid, "mention");
          people.set(m.uuid, m);
        }
      }
      for (const prior of only ? [] : thread.messages) {
        if (
          prior.id === message.id ||
          prior.authorId === user.uuid ||
          recipients.has(prior.authorId)
        )
          continue;
        const wrote = await author(prior.authorId);
        if (!wrote) continue;
        recipients.set(wrote.uuid, "reply");
        people.set(wrote.uuid, wrote);
      }
      const excerpt = commentExcerpt(message.text, 280);
      const lang = canonicalLanguage(message.lang),
        runs = [];
      // The notification owns a snapshot, including only the captured text's
      // language ranges. Later edits/deletion must not change its declaration.
      for (const run of sliceTextRuns(message.textRuns, 0, excerpt.length)) {
        const tag = canonicalLanguage(run.style.lang);
        if (tag) appendRun(runs, run.start, run.end, { lang: tag });
      }
      // A reply in a long discussion reaches everyone who wrote in it.
      // Their access is checked and their notifications written twenty at a
      // time, as one at a time a hundred-person discussion kept each reply's
      // save waiting seconds; who is told, and of what, is unchanged.
      const chosen = [];
      for (const [uuid, type] of recipients) {
        if (index >= 20 || notified.has(uuid)) continue;
        notified.add(uuid);
        chosen.push([uuid, type]);
      }
      const reach = [];
      for (let n = 0; n < chosen.length; n += 20)
        reach.push(
          ...(await Promise.all(
            chosen
              .slice(n, n + 20)
              .map(
                ([uuid]) =>
                  colleagues.has(uuid) || this.canOpen(room, people.get(uuid)),
              ),
          )),
        );
      const sends = [];
      for (const [n, [uuid, type]] of chosen.entries()) {
        if (!reach[n]) continue;
        const channel = type === "mention" && !posted;
        posted ||= channel;
        sends.push([uuid, type, channel]);
      }
      const url = sends.length
        ? await this.org.boardLink(room, thread.anchorId, thread.id)
        : null;
      for (let n = 0; n < sends.length; n += 20)
        await Promise.all(
          sends.slice(n, n + 20).map(([uuid, type, channel]) =>
            this.org.notify(uuid, {
              type,
              board: room,
              boardTitle: after.title,
              thread: thread.id,
              item: thread.anchorId || null,
              url,
              actor: { uuid: user.uuid, username: user.username },
              subject:
                type === "mention"
                  ? `${user.username} mentioned you on ${after.title}`
                  : `${user.username} replied on ${after.title}`,
              text: `${user.username}: ${excerpt}`,
              excerpt,
              ...(lang ? { excerptLang: lang } : {}),
              ...(runs.length ? { excerptRuns: runs } : {}),
              channel,
            }),
          ),
        );
      // An edit is not a new comment.
      if (only) continue;
      const mentioned = [...recipients.values()].filter(
        (t) => t === "mention",
      ).length;
      if (index < 20)
        await this.org.audit(user, "board.comment.created", target, {
          thread: thread.id,
          mentions: mentioned,
        });
      else {
        rest.count++;
        rest.threads.add(thread.id);
        rest.mentions += mentioned;
      }
    }
    if (rest.count)
      await this.org.audit(user, "board.comment.created", target, {
        count: rest.count,
        threads: [...rest.threads].slice(0, 20),
        mentions: rest.mentions,
      });
  }
}
export { ROLES };
