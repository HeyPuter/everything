/**
 * The room worker: a Puter Worker the workbook's owner deploys to their own account. For each shared workbook
 * it keeps, in the owner's key-value store and files, the ordered log of changes, checkpoints of the whole
 * workbook, memberships, invitations and presence tickets, and it checks every request: membership, role
 * (viewers never change anything), the shape of every change, and the order of the log (a change is accepted
 * only on top of the latest one, so everyone applies the same changes in the same order). Its design follows
 * the Whiteboard app's board service in this repository.
 */

import { canEdit, canManage, decode, hash, ID, INVITE_ROLES, keyPair, MAX_STATE, SESSION_TTL, sign, unpackState } from '../protocol.js';
import { MAX_BATCH, MAX_CHANGE, OpError, validateChange } from '../ops.js';

export const INVITE_DAYS = 7;
const DAY = 86_400_000;
/** Changes larger than this are kept in a file, with the log record pointing at it. */
const INLINE = 100_000;
/** A log position someone claimed but never wrote is given up after this long. */
const HOLE_AFTER = 20_000;
/** Records kept in memory per room. */
const CACHE = 2000;
const MAX_XLSX = 16_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/**
 * How long a refused event-handle mint is not tried again. Every mint, refused or not, spends the owner's budget
 * of 60 a minute. These hold for every member: the owner's consent (cleared at once when the owner grants it),
 * the platform, this worker's token, and the owner's account.
 */
const SERVER_BACKOFF = {
  events_kv_handle_not_delegated: 10 * MINUTE,
  events_disabled: 6 * HOUR,
  events_kv_handles_disabled: 6 * HOUR,
  events_kv_handle_owner_only: 6 * HOUR,
  events_kv_handle_outside_namespace: 6 * HOUR,
  events_kv_handle_limit_reached: HOUR,
  account_is_not_verified: HOUR,
};
/** These hold for one member of one workbook; anything else, a network failure included, waits the default. */
const MEMBER_BACKOFF = {
  recipient_not_accepting_shares: 6 * HOUR,
  events_kv_handle_requires_account: 6 * HOUR,
  invalid_kv_share_prefix: 6 * HOUR,
  too_many_requests: 2 * MINUTE,
};
const DEFAULT_BACKOFF = 5 * MINUTE;
/** Not a room's key (a room id has no `~`): set while handle mints are refused for every member. */
const EVENTS_OFF = 'ss:~events-off';
/** Handles taken back in one request; mints and revokes share the 60-a-minute budget. */
const REVOKE_MAX = 20;
/**
 * How often the owner's opening of a workbook also looks through the handles this worker minted for ones nothing
 * uses any more, and how much of the list one look reads. Set while a look is not due; the next page to read.
 */
const SWEEP_EVERY = 6 * HOUR;
const SWEEP_PAGES = 5;
const SWEEP_DUE = 'ss:~sweep-due';
const SWEEP_CURSOR = 'ss:~sweep-cursor';
/** A handle this new may not be in its member's record yet. */
const SWEEP_SPARE = 10 * MINUTE;

export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
const id = (v) => (typeof v === 'string' && ID.test(v) ? v : fail(400, 'Invalid identifier.'));
const pad = (n) => String(n).padStart(12, '0');

export function appUid(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(new TextDecoder().decode(decode(part + '==='.slice((part.length + 3) % 4))));
    if (p.app_uid) return p.app_uid;
    if (typeof p.au === 'string' && p.au.includes('-')) return p.au;
    const b = decode(p.au.replace(/_/g, '/').replace(/-/g, '+') + '==='.slice((p.au.length + 3) % 4));
    if (b.length !== 16) return null;
    const h = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `app-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    return null;
  }
}

/** What someone shares of where they are: a sheet, a selection, and whether they are typing in a cell. */
export function sanitizeState(s) {
  if (!s || typeof s !== 'object') return null;
  const int = (n, max) => (Number.isInteger(n) && n >= 0 && n <= max ? n : null);
  const range = (r) => {
    if (!r || typeof r !== 'object') return null;
    const out = { r1: int(r.r1, 1048575), c1: int(r.c1, 16383), r2: int(r.r2, 1048575), c2: int(r.c2, 16383) };
    return Object.values(out).every((v) => v != null) && out.r2 >= out.r1 && out.c2 >= out.c1 ? out : null;
  };
  const sheet = typeof s.sheet === 'string' && s.sheet.length <= 100 ? s.sheet : null;
  if (!sheet) return null;
  const sel = range(s.sel);
  const active = s.active && int(s.active.r, 1048575) != null && int(s.active.c, 16383) != null ? { r: s.active.r, c: s.active.c } : null;
  return { sheet, sel, active, editing: s.editing === true };
}

// Rooms loaded by this worker instance: the head of the log and its recent records.
const ROOMS = new Map();
// Commits in progress per room (per set of loaded rooms), taken one at a time.
const COMMITS = new WeakMap();

export class RoomService {
  /** `puter` is the worker owner's Puter (`me.puter`, or a test fake). */
  constructor(puter, { now = Date.now, fetcher = (...a) => fetch(...a), rooms = ROOMS } = {}) {
    this.puter = puter;
    this.kv = puter.kv;
    this.fs = puter.fs;
    this.now = now;
    this.fetcher = fetcher;
    this.rooms = rooms;
  }

  owner() {
    this.accountOwner ??= this.puter.auth.getUser();
    return this.accountOwner;
  }
  path(room, name) { return `spreadsheet/shared/${room}/${name}`; }
  async readText(path) { return (await this.fs.read(path)).text(); }
  async writeText(path, text) { await this.fs.write(path, text, { overwrite: true, dedupeName: false, createMissingParents: true }); }

  async list(prefix) {
    const out = [];
    let cursor;
    for (let page = 0; page < 200; page++) {
      const res = await this.kv.list({ pattern: prefix, returnValues: true, limit: 1000, ...(cursor ? { cursor } : {}) });
      const items = Array.isArray(res) ? res : res.items;
      for (const it of items) if (typeof it === 'object') out.push(it);
      cursor = Array.isArray(res) ? undefined : res.cursor;
      if (!cursor) break;
    }
    return out;
  }

  /* ---------- Access ---------- */

  async meta(room) {
    const meta = await this.kv.get(`ss:${room}:meta`);
    if (!meta) fail(404, 'This shared workbook does not exist.');
    if (meta.closed) fail(410, 'The owner stopped sharing this workbook.');
    return meta;
  }

  async member(room, user) {
    const meta = await this.meta(room);
    const m = await this.kv.get(`ss:${room}:member:${user.uuid}`);
    if (!m || m.role === 'removed') fail(403, 'You do not have access to this shared workbook.');
    if (m.expires && m.expires < this.now()) fail(403, 'Your access to this shared workbook has expired.');
    return { meta, member: m };
  }

  async setMember(room, m) { await this.kv.set(`ss:${room}:member:${m.uuid}`, m); }

  /**
   * Admit someone opening the workbook: an existing member, an invitation link, or an invitation by username.
   * An invitation never changes an existing membership (its role or expiry are the owner's decision), and an
   * expired or revoked link does not stop a current member.
   */
  async admit(room, user, token) {
    const meta = await this.meta(room);
    const prior = await this.kv.get(`ss:${room}:member:${user.uuid}`);
    if (prior?.role === 'removed') fail(403, 'Your access to this shared workbook was removed.');
    if (prior) return;
    let role = null;
    if (typeof token === 'string' && token) {
      if (token.length > 200) fail(400, 'Invalid invitation.');
      const invite = await this.kv.get(`ss:${room}:invite:${await hash(token)}`);
      if (!invite || invite.expires < this.now()) fail(403, 'This invitation has expired or was revoked.');
      role = invite.role;
    } else {
      const named = await this.kv.get(`ss:${room}:named:${user.username.toLowerCase()}`);
      if (named && named.expires >= this.now()) role = named.role;
    }
    if (user.uuid === meta.owner) role = 'owner';
    if (!role) fail(403, 'Ask the owner for an invitation to this shared workbook.');
    await this.setMember(room, { uuid: user.uuid, username: user.username, role, joined: this.now() });
    await this.notify(room);
  }

  /* ---------- The log ---------- */

  async readRecord(room, rev) {
    const stored = await this.kv.get(`ss:${room}:log:${pad(rev)}`);
    if (!stored) return null;
    if (stored.file) return { ...stored, file: undefined, changes: JSON.parse(await this.readText(stored.file)) };
    return stored;
  }

  /**
   * This instance's view of a room, brought up to the latest record anyone wrote. One refresh reads a thousand
   * records at most; an instance just started reads on until it reaches `need`, the revision a browser says it has.
   */
  async load(room, need = 0) {
    let entry = this.rooms.get(room);
    if (!entry) {
      const cp = await this.kv.get(`ss:${room}:cp`);
      entry = { head: cp?.rev ?? 0, base: cp?.rev ?? 0, records: new Map(), holes: new Map() };
      this.rooms.set(room, entry);
      if (this.rooms.size > 16) { const [oldest] = this.rooms.keys(); if (oldest !== room) this.rooms.delete(oldest); }
    }
    for (let head = -1; head !== entry.head;) {
      head = entry.head;
      await this.refresh(room, entry);
      if (entry.head >= need) break;
    }
    return entry;
  }

  async refresh(room, entry) {
    for (let n = 0; n < 1000; n++) {
      const rev = entry.head + 1;
      const record = await this.readRecord(room, rev);
      if (!record) {
        // Claimed but not written yet (a commit in progress elsewhere), or never written (a commit that
        // failed half way): given up for good once it is old, so the room does not stop.
        const claimed = await this.kv.get(`ss:${room}:claim:${pad(rev)}`);
        if (!claimed) return;
        const seen = entry.holes.get(rev) ?? this.now();
        entry.holes.set(rev, seen);
        if (this.now() - seen < HOLE_AFTER) return;
        const empty = { rev, user: null, at: this.now(), changes: [] };
        await this.kv.set(`ss:${room}:log:${pad(rev)}`, empty);
        entry.holes.delete(rev);
        this.keep(entry, empty);
        continue;
      }
      entry.holes.delete(rev);
      this.keep(entry, record);
    }
  }

  keep(entry, record) {
    entry.records.set(record.rev, record);
    entry.head = Math.max(entry.head, record.rev);
    if (entry.records.size > CACHE) entry.records.delete(entry.records.keys().next().value);
  }

  /** The records after revision `since`, up to `limit`. */
  async since(room, entry, since, limit = 500) {
    const out = [];
    for (let rev = since + 1; rev <= entry.head && out.length < limit; rev++) {
      const record = entry.records.get(rev) ?? (await this.readRecord(room, rev));
      if (!record) break;
      out.push(record);
    }
    return out;
  }

  async notify(room, rev) {
    await this.kv.set(`ss:${room}:ev:signal`, { nonce: crypto.randomUUID(), ...(rev ? { rev } : {}) }).catch(() => {});
  }

  /**
   * How a member hears of changes: the owner watches the room's signal key directly, everyone else through a
   * handle on it minted for them. `consented` comes from the owner's browser once they allow sharing it.
   */
  async events(room, user, { consented = false } = {}) {
    const uid = appUid(this.puter.authToken);
    if (!uid) return null;
    if (user.uuid === (await this.owner()).uuid) {
      if (consented) await this.kv.del(EVENTS_OFF).catch(() => {});
      await this.sweepHandles().catch(() => {});
      return { app: uid, key: `ss:${room}:ev:signal` };
    }
    const cache = `ss:${room}:handle:${user.uuid}`;
    let handle = await this.kv.get(cache);
    if (!handle && this.puter.APIOrigin) handle = await this.mint(room, user);
    return handle ? { handle, key: 'signal' } : null;
  }

  /** Mint a member's handle, unless a recent refusal still holds; a refusal is remembered (see SERVER_BACKOFF). */
  async mint(room, user) {
    const wait = `ss:${room}:nohandle:${user.uuid}`;
    const [off, held] = await Promise.all([this.kv.get(EVENTS_OFF), this.kv.get(wait)]);
    if (off || held) return null;
    let code = 'network';
    try {
      const res = await this.fetcher(`${this.puter.APIOrigin}/events/kv-handles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.puter.authToken}` },
        body: JSON.stringify({ granteeUid: user.uuid, prefix: `ss:${room}:ev:` }),
        signal: AbortSignal.timeout(3000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.handle) {
        await this.kv.set(`ss:${room}:handle:${user.uuid}`, data.handle);
        return data.handle;
      }
      code = data?.code;
    } catch { /* Peer notices and periodic synchronization still deliver changes. */ }
    const until = (ms) => Math.ceil((this.now() + ms) / 1000);
    if (SERVER_BACKOFF[code]) await this.kv.set(EVENTS_OFF, { code }, until(SERVER_BACKOFF[code])).catch(() => {});
    else await this.kv.set(wait, { code }, until(MEMBER_BACKOFF[code] ?? DEFAULT_BACKOFF)).catch(() => {});
    return null;
  }

  /** Take back a member's handle. */
  async dropHandle(room, uuid) {
    const key = `ss:${room}:handle:${uuid}`;
    const handle = await this.kv.get(key);
    if (handle && (await this.revokeHandle(handle))) await this.kv.del(key);
  }

  /** Revoke a handle at Puter; true once it is gone, as one Puter no longer knows already is. */
  async revokeHandle(handle) {
    if (!this.puter.APIOrigin) return false;
    const res = await this.fetcher(`${this.puter.APIOrigin}/events/kv-handles/${encodeURIComponent(handle)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.puter.authToken}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    return !!res && (res.ok || res.status === 404);
  }

  /**
   * Take back handles nothing uses any more: ones on a closed or deleted room, ones whose member left or whose
   * access expired, and ones no member's record names, such as those removals forgot before removals revoked them.
   * Puter lists them oldest first; a look reads a few pages and carries on from there next time.
   */
  async sweepHandles() {
    if (!this.puter.APIOrigin || (await this.kv.get(SWEEP_DUE))) return;
    await this.kv.set(SWEEP_DUE, true, Math.ceil((this.now() + SWEEP_EVERY) / 1000));
    let cursor = (await this.kv.get(SWEEP_CURSOR)) || undefined;
    const rooms = new Map();
    let revoked = 0;
    for (let page = 0; page < SWEEP_PAGES && revoked < REVOKE_MAX; page++) {
      const query = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) });
      const res = await this.fetcher(`${this.puter.APIOrigin}/events/kv-handles?${query}`, {
        headers: { Authorization: `Bearer ${this.puter.authToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const data = await res.json();
      for (const item of data.items ?? []) {
        const room = /^ss:([^:]+):ev:$/.exec(item.prefix ?? '')?.[1];
        if (!room || item.revokedAt || item.createdAt * 1000 > this.now() - SWEEP_SPARE) continue;
        if (!rooms.has(room)) rooms.set(room, await this.handleUsers(room));
        const used = rooms.get(room).get(item.handle);
        if (used?.live) continue;
        if (used) await this.dropHandle(room, used.uuid).catch(() => {});
        else await this.revokeHandle(item.handle);
        if (++revoked >= REVOKE_MAX) break;
      }
      cursor = data.cursor;
      if (!cursor) break;
    }
    // A look that reached the end starts from the beginning next time.
    await this.kv.set(SWEEP_CURSOR, cursor ?? null);
  }

  /** A room's handles by id: whose they are, and whether that member may still hear of changes. */
  async handleUsers(room) {
    const out = new Map();
    const meta = await this.kv.get(`ss:${room}:meta`);
    const prefix = `ss:${room}:handle:`;
    for (const row of await this.list(prefix)) {
      const uuid = row.key.slice(prefix.length);
      const m = meta && !meta.closed ? await this.kv.get(`ss:${room}:member:${uuid}`) : null;
      out.set(row.value, { uuid, live: !!m && m.role !== 'removed' && !(m.expires && m.expires < this.now()) });
    }
    return out;
  }

  /* ---------- Requests ---------- */

  async call(user, input) {
    if (!user?.uuid) fail(401, 'Sign in with Puter to continue.');
    if (!input || typeof input !== 'object') fail(400, 'Invalid request.');
    const room = id(input.room);
    const op = input.op;
    if (op === 'create') return this.create(room, user, input);
    if (op === 'join') await this.admit(room, user, input.token);
    const { meta, member } = await this.member(room, user);
    switch (op) {
      case 'join': {
        const entry = await this.load(room);
        return {
          room, name: meta.name, role: member.role, user: { uuid: user.uuid, username: user.username }, owner: meta.owner,
          publicKey: meta.keys.publicKey, head: entry.head, serverTime: this.now(), events: await this.events(room, user),
          file: member.role === 'owner' ? meta.file ?? null : null,
        };
      }
      case 'load': {
        // The latest checkpoint, or with `at`, the latest at or before it (a browser bringing back changes made on that revision).
        let cp = await this.kv.get(`ss:${room}:cp`);
        if (Number.isInteger(input.at) && cp && cp.rev > input.at) {
          const older = ((await this.kv.get(`ss:${room}:cps`)) || []).filter((c) => c.rev <= input.at);
          cp = older.length ? older[older.length - 1] : null;
        }
        const state = await this.readText(cp?.path ?? meta.initial);
        const entry = await this.load(room);
        const records = await this.since(room, entry, cp?.rev ?? 0, 5000);
        return { rev: cp?.rev ?? 0, state, records, head: entry.head, role: member.role };
      }
      case 'events':
        return { events: await this.events(room, user, { consented: input.consented === true }) };
      case 'sync': {
        const since = input.since;
        if (!Number.isInteger(since) || since < 0) fail(400, 'Invalid revision.');
        const entry = await this.load(room, since);
        if (since > entry.head) fail(409, 'This copy is ahead of the shared workbook. Open it again.');
        const records = await this.since(room, entry, since);
        const cp = await this.kv.get(`ss:${room}:cp`);
        return { records, head: entry.head, role: member.role, checkpoint: cp?.rev ?? 0, serverTime: this.now() };
      }
      case 'commit':
        return this.serial(room, () => this.commit(room, meta, user, member, input));
      case 'checkpoint':
        return this.checkpoint(room, meta, member, input);
      case 'presence':
        return this.presence(room, meta, user, member, input);
      case 'leave': {
        const key = `ss:${room}:presence:${id(input.session)}`;
        const ticket = await this.kv.get(key);
        if (ticket?.user === user.uuid) { await this.kv.del(key); await this.notify(room); }
        return { ok: true };
      }
      case 'members': {
        const rows = await this.list(`ss:${room}:member:`);
        const members = rows.map((r) => r.value).filter((m) => m.role !== 'removed')
          .map((m) => ({ uuid: m.uuid, username: m.username, role: m.role, ...(canManage(member.role) ? { joined: m.joined, expires: m.expires ?? null } : {}) }));
        if (!canManage(member.role)) return { members };
        const prefix = `ss:${room}:named:`;
        const named = (await this.list(prefix)).map((r) => ({ username: r.key.slice(prefix.length), ...r.value })).filter((n) => n.expires >= this.now());
        const invites = (await this.list(`ss:${room}:invite:`)).map((r) => r.value).filter((i) => i.expires >= this.now());
        return { members, named: named.map((n) => ({ username: n.username, role: n.role, expires: n.expires })), invites: invites.length };
      }
      case 'invite':
      case 'invite-user':
      case 'revoke-invites':
      case 'role':
      case 'stop':
        if (!canManage(member.role)) fail(403, 'Only the owner can manage who has access.');
        return this.manage(room, meta, user, input);
    }
    fail(400, 'Unknown request.');
  }

  /** Run commits of one room one after another (on this instance; the log's claims order them across instances). */
  serial(room, fn) {
    let locks = COMMITS.get(this.rooms);
    if (!locks) COMMITS.set(this.rooms, (locks = new Map()));
    const run = (locks.get(room) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    locks.set(room, tail);
    tail.then(() => { if (locks.get(room) === tail) locks.delete(room); });
    return run;
  }

  async create(room, user, input) {
    if (user.uuid !== (await this.owner()).uuid) fail(403, 'Only the owner of this collaboration server can share workbooks on it.');
    const prefix = `ss:${room}:`;
    const existing = await this.kv.get(prefix + 'meta');
    if (existing) {
      if (existing.owner !== user.uuid) fail(403, 'Only the owner can finish sharing this workbook.');
      return { room };
    }
    await this.checkState(input.state);
    const initial = this.path(room, 'initial.txt');
    await this.writeText(initial, input.state);
    const file = input.file && typeof input.file.path === 'string' && input.file.path.length <= 1024
      ? { path: input.file.path, uid: typeof input.file.uid === 'string' ? input.file.uid.slice(0, 200) : null } : null;
    const meta = {
      owner: user.uuid,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 200) : 'Untitled spreadsheet',
      created: this.now(), keys: await keyPair(), initial, file,
    };
    await this.kv.set(prefix + 'meta', meta);
    await this.setMember(room, { uuid: user.uuid, username: user.username, role: 'owner', joined: this.now() });
    return { room };
  }

  /** A packed workbook state must unpack to a workbook. */
  async checkState(state) {
    if (typeof state !== 'string' || !state || state.length > MAX_STATE) fail(413, 'This workbook is too large to edit together.');
    let book;
    try { book = await unpackState(state); } catch { fail(422, 'This workbook could not be shared.'); }
    if (!book || typeof book !== 'object' || !Array.isArray(book.sheets) || !book.sheets.length) fail(422, 'This workbook could not be shared.');
  }

  async commit(room, meta, user, member, input) {
    if (!canEdit(member.role)) fail(403, 'You can view this shared workbook but not change it.');
    const changes = input.changes;
    if (!Array.isArray(changes) || !changes.length || changes.length > MAX_BATCH) fail(400, 'Invalid change.');
    const text = JSON.stringify(changes);
    if (text.length > MAX_CHANGE) fail(413, 'This change is too large to save.');
    try { for (const ch of changes) validateChange(ch); } catch (e) { fail(400, e instanceof OpError ? e.message : 'Invalid change.'); }
    const base = input.base;
    const entry = await this.load(room, Number.isInteger(base) ? base : 0);
    if (!Number.isInteger(base) || base < 0 || base > entry.head) fail(409, 'This copy is ahead of the shared workbook. Open it again.');
    // Someone else's change came first: the browser rebases its changes on it and sends them again.
    if (base < entry.head) return { accepted: false, head: entry.head, records: await this.since(room, entry, base) };
    const rev = base + 1;
    // Claiming the position is atomic, across worker instances too: whoever gets it first owns it.
    if ((await this.kv.incr(`ss:${room}:claim:${pad(rev)}`)) !== 1) {
      await this.refresh(room, entry);
      return { accepted: false, head: entry.head, records: await this.since(room, entry, base) };
    }
    const record = {
      rev, user: user.uuid, username: String(user.username || '').slice(0, 80),
      session: typeof input.session === 'string' ? input.session.slice(0, 100) : null, at: this.now(), changes,
    };
    try {
      const stored = text.length > INLINE ? { ...record, changes: undefined, file: this.path(room, `log/${pad(rev)}.json`) } : record;
      if (stored.file) await this.writeText(stored.file, text);
      await this.kv.set(`ss:${room}:log:${pad(rev)}`, stored);
    } catch (error) {
      this.rooms.delete(room);
      throw error;
    }
    this.keep(entry, record);
    await this.notify(room, rev);
    const receipt = await sign(meta.keys.privateKey, { room, rev, digest: await hash(text), user: user.uuid });
    return { accepted: true, rev, head: entry.head, records: await this.since(room, entry, base), receipt };
  }

  /**
   * A checkpoint: the whole workbook at a revision, written by an editor's browser (it holds the state the log
   * leads to; the worker does not run the spreadsheet). Joining starts from the latest checkpoint. With it may
   * come the workbook as an .xlsx file, written over the owner's file so it opens anywhere.
   */
  async checkpoint(room, meta, member, input) {
    if (!canEdit(member.role)) fail(403, 'You can view this shared workbook but not change it.');
    const rev = input.rev;
    const entry = await this.load(room, Number.isInteger(rev) ? rev : 0);
    if (!Number.isInteger(rev) || rev < 0 || rev > entry.head) fail(400, 'Invalid revision.');
    const cp = await this.kv.get(`ss:${room}:cp`);
    let saved = false;
    if (!cp || rev > cp.rev) {
      await this.checkState(input.state);
      const path = this.path(room, `cp-${pad(rev)}.txt`);
      await this.writeText(path, input.state);
      const latest = await this.kv.get(`ss:${room}:cp`);
      if (!latest || rev > latest.rev) {
        await this.kv.set(`ss:${room}:cp`, { rev, path, at: this.now() });
        const history = [...((await this.kv.get(`ss:${room}:cps`)) || []).filter((c) => c.rev < rev), { rev, path }];
        await this.kv.set(`ss:${room}:cps`, history.slice(-50));
        // A checkpoint off the list is read by nothing any more: its file goes, or the owner's drive keeps a copy of
        // the whole workbook for every minute anyone spent editing it.
        for (const old of history.slice(0, -50)) await this.fs.delete(old.path).catch(() => {});
      }
      saved = true;
    }
    let wrote = false;
    // The owner's file, renamed or moved since sharing started: its owner says where it is now, and it is written there.
    const moved = member.role === 'owner' && input.file && typeof input.file.path === 'string' && input.file.path && input.file.path.length <= 1024 && input.file.path !== meta.file?.path;
    if (moved && typeof input.xlsx === 'string') {
      const latest = await this.kv.get(`ss:${room}:meta`);
      if (latest && !latest.closed) {
        meta = { ...latest, file: { path: input.file.path, uid: typeof input.file.uid === 'string' ? input.file.uid.slice(0, 200) : null } };
        await this.kv.set(`ss:${room}:meta`, meta);
      }
    }
    if (typeof input.xlsx === 'string' && meta.file?.path) {
      if (input.xlsx.length > MAX_XLSX) fail(413, 'This workbook is too large to save.');
      const bytes = decode(input.xlsx, MAX_XLSX);
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail(400, 'Invalid workbook file.');
      const written = await this.kv.get(`ss:${room}:file`);
      if (!written || rev > written.rev || (written.path && written.path !== meta.file.path)) {
        try {
          await this.fs.write(meta.file.path, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), { overwrite: true, dedupeName: false });
          await this.kv.set(`ss:${room}:file`, { rev, at: this.now(), path: meta.file.path });
          wrote = true;
        } catch { /* The owner's browser writes the file when it next opens the workbook. */ }
      }
    }
    return { ok: true, saved, wrote };
  }

  async presence(room, meta, user, member, input) {
    const session = id(input.session);
    const key = input.publicKey ?? {};
    const coordinate = /^[A-Za-z0-9_-]{43}$/;
    if (key.kty !== 'EC' || key.crv !== 'P-256' || key.d || !coordinate.test(key.x ?? '') || !coordinate.test(key.y ?? '')) fail(400, 'Invalid peer key.');
    const prefix = `ss:${room}:presence:`;
    const rows = (await this.list(prefix)).map((r) => r.value).filter((t) => t.expires > this.now());
    const old = rows.find((t) => t.session === session);
    if (old && old.user !== user.uuid) fail(409, 'Session belongs to another participant.');
    const others = rows.filter((t) => t.session !== session);
    if (!old && (others.length >= 256 || others.filter((t) => t.user === user.uuid).length >= 16)) fail(429, 'This shared workbook has reached its participant limit.');
    const ticket = {
      room, session, user: user.uuid, username: String(user.username || 'Participant').slice(0, 80), role: member.role,
      publicKey: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, expires: this.now() + SESSION_TTL,
      invite: typeof input.invite === 'string' ? input.invite.slice(0, 100) : null,
    };
    const state = sanitizeState(input.state);
    await this.kv.set(prefix + session, { ...ticket, state, at: this.now() }, Math.floor(ticket.expires / 1000));
    if (!old || old.invite !== ticket.invite) await this.notify(room);
    const roster = [...others, { ...ticket, state, at: this.now() }].sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
    return { ticket, signature: await sign(meta.keys.privateKey, ticket), roster, role: member.role, serverTime: this.now() };
  }

  async manage(room, meta, user, input) {
    const prefix = `ss:${room}:`;
    const days = Number.isFinite(input.days) ? Math.min(30, Math.max(1, Math.round(input.days))) : INVITE_DAYS;
    if (input.op === 'invite') {
      const role = input.role ?? 'editor';
      if (!INVITE_ROLES.includes(role)) fail(400, 'Choose a role an invitation can give.');
      const token = crypto.randomUUID() + crypto.randomUUID();
      const expires = this.now() + days * DAY;
      await this.kv.set(`${prefix}invite:${await hash(token)}`, { role, created: this.now(), expires, createdBy: user.uuid }, Math.floor(expires / 1000));
      return { token, expires };
    }
    if (input.op === 'invite-user') {
      const name = typeof input.username === 'string' ? input.username.trim().replace(/^@/, '') : '';
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) fail(400, 'Enter a Puter username.');
      const role = input.role ?? 'editor';
      if (!INVITE_ROLES.includes(role)) fail(400, 'Choose a role an invitation can give.');
      const expires = this.now() + days * DAY;
      await this.kv.set(`${prefix}named:${name.toLowerCase()}`, { role, created: this.now(), expires, createdBy: user.uuid }, Math.floor(expires / 1000));
      // Someone already a member gets the role at once.
      for (const row of await this.list(`${prefix}member:`)) {
        const m = row.value;
        if (m.username.toLowerCase() === name.toLowerCase() && m.role !== 'owner') await this.setMember(room, { ...m, role });
      }
      await this.notify(room);
      return { ok: true, expires };
    }
    if (input.op === 'revoke-invites') {
      for (const row of [...(await this.list(`${prefix}invite:`)), ...(await this.list(`${prefix}named:`))]) await this.kv.del(row.key);
      return { ok: true };
    }
    if (input.op === 'stop') {
      await this.kv.set(`${prefix}meta`, { ...meta, closed: this.now() });
      this.rooms.delete(room);
      await this.notify(room);
      // After the notice, so everyone still watching hears the room closed.
      const handles = (await this.list(`${prefix}handle:`)).slice(0, REVOKE_MAX);
      await Promise.all(handles.map((row) => this.dropHandle(room, row.key.slice(`${prefix}handle:`.length)).catch(() => {})));
      return { ok: true };
    }
    // Role changes, removal and access expiry.
    const target = id(input.uuid);
    if (target === meta.owner) fail(400, 'The owner keeps their access.');
    const record = await this.kv.get(`${prefix}member:${target}`);
    if (!record) fail(404, 'Member not found.');
    const role = input.role === undefined ? record.role : input.role;
    if (role !== 'removed' && !INVITE_ROLES.includes(role)) fail(400, 'Invalid role.');
    const expires = input.expires === undefined ? record.expires : input.expires === null ? null : Number(input.expires);
    if (expires != null && !(Number.isFinite(expires) && expires > 0)) fail(400, 'Invalid expiry.');
    await this.setMember(room, { ...record, role, expires: expires ?? null });
    // Their live sessions end; they check in again with the new role.
    for (const row of await this.list(`${prefix}presence:`)) if (row.value.user === target) await this.kv.del(row.key);
    await this.notify(room);
    if (role === 'removed') await this.dropHandle(room, target).catch(() => {});
    return { ok: true };
  }
}
