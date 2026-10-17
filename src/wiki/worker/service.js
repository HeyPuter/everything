/**
 * The collaboration service behind shared spaces. It runs in a Puter worker
 * on the account of the person who shared the space, so the shared pages
 * live in their storage and count against their quota. The design follows
 * the Whiteboard app's worker (src/whiteboard/worker/service.js), cut down
 * to what a wiki needs.
 *
 * KV keys, all under wk:<room>:
 *   meta                 { owner, ownerName, title, icon, created, visibility, linkRole, deleted }
 *   member:<uuid>        { uuid, username, role, via, joined }
 *   invite:<sha256>      { role, created, expires, createdBy }   (expires on its own)
 *   log:<doc>:<iso>:<id> { id, author, username, at, update | path }   one per saved edit
 *   cp:<doc>             { path, at, prevAt }   the latest checkpoint of a document
 *   cps:<doc>            [{ at, path }]   earlier checkpoints kept as page history
 *   presence:<session>   { session, uuid, username, page, expires }  (expires on its own)
 *   ev:signal            { nonce, seq, docs, keys, session, by }   rewritten on every save, for live updates
 *   seq                  counter numbering the signals, so a client can tell it missed one
 *   handle:<uuid>        an event handle that lets that person watch ev:
 *   assetbytes           bytes of images stored for the space
 *
 * Files, under wiki/shared/<room>/: cp/<doc>-<hash>.txt (checkpoints),
 * updates/<id>.txt (edits too large for KV), assets/<sha256>.txt (images).
 */
import * as Y from 'yjs';
import { DOC, ID, INVITE_ROLES, MAX_INLINE, SESSION_TTL, canManage, canWriteDoc, decode, encode, hash } from '../src/collab/protocol.js';

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const DAY = 24 * 60 * 60 * 1000;
const INVITE_DAYS = 14;
/** Largest edit accepted, in base64 characters. */
const UPDATE_LIMIT = 4_000_000;
/** Largest document kept, in bytes of saved state. */
const DOC_LIMIT = 24_000_000;
const ASSET_CHARS = 15 * 1024 * 1024;
const ASSET_BYTES = 1024 * 1024 * 1024;
/** A checkpoint is written after this many edits... */
const CHECKPOINT_EVERY = 200;
/** ...or when the latest one is this old and there were edits since. */
const CHECKPOINT_AGE = 30 * 60_000;
/** Earlier checkpoints kept for page history. */
const HISTORY_KEPT = 30;
/** A copy read this recently is current enough to answer from. */
const FRESH = 1200;
/** Records can become visible to a listing a little after their time. */
const OVERLAP = 120_000;
/** A copy not refreshed for this long is read again from its checkpoint. */
const RELOAD = 5 * 60_000;
const MAX_ROSTER = 200;
const SESSION = /^[a-z0-9]{8,40}$/;
const LOG_TAIL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[0-9a-f]{16}$/;
/** Log records a sync reads directly per document. */
const MAX_HINTS = 16;

/** Documents this instance has read, by room and document. */
export const DOCS = new Map();
const MAX_DOCS = 200;
let ACCOUNT_OWNER = null;

const id = (value, pattern = ID) => {
  if (typeof value !== 'string' || !pattern.test(value)) fail(400, 'Invalid request.');
  return value;
};

/**
 * The worker's app id, from its own token. Puter's tokens may carry it
 * packed (16 bytes in base64); event subjects need the app-<uuid> form.
 * Same approach as the Whiteboard worker.
 */
export function appUid(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(new TextDecoder().decode(decode(part.padEnd(Math.ceil(part.length / 4) * 4, '='))));
    if (claims.app_uid) return claims.app_uid;
    if (typeof claims.au !== 'string') return null;
    if (claims.au.includes('-') && claims.au.startsWith('app-')) return claims.au;
    const packed = claims.au.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = decode(packed.padEnd(Math.ceil(packed.length / 4) * 4, '='));
    if (bytes.length !== 16) return null;
    const hex = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `app-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

function keep(key, entry) {
  DOCS.delete(key);
  DOCS.set(key, entry);
  while (DOCS.size > MAX_DOCS) {
    const [oldKey, old] = DOCS.entries().next().value;
    DOCS.delete(oldKey);
    old.ydoc.destroy();
  }
}

/**
 * A comments document as plain data for checkComments. Messages note
 * whether they are Y.Maps, and threads that are not a Y.Map holding a
 * Y.Array of messages carry no fields, so swapping a value for a plain
 * lookalike counts as a change.
 */
export function commentState(ydoc) {
  const out = {};
  for (const [id, t] of ydoc.getMap('threads').entries()) {
    const messages = t instanceof Y.Map ? t.get('messages') : null;
    if (!(messages instanceof Y.Array)) {
      out[id] = { invalid: true };
      continue;
    }
    out[id] = {
      ...t.toJSON(),
      messages: messages.toArray().map((m) => (m instanceof Y.Map ? { ...m.toJSON(), $map: true } : m && typeof m === 'object' ? { ...m, $map: false } : m)),
    };
  }
  return out;
}

/** Whether everything an update adds or deletes took effect, instead of waiting on edits this copy lacks. */
function integrated(ydoc, bytes) {
  const sv = Y.decodeStateVector(Y.encodeStateVector(ydoc));
  for (const [client, clock] of Y.parseUpdateMeta(bytes).to) if ((sv.get(client) || 0) < clock) return false;
  for (const [client, ranges] of Y.decodeUpdate(bytes).ds.clients) for (const r of ranges) if ((sv.get(client) || 0) < r.clock + r.len) return false;
  return true;
}

/** Copies of each message by id (older versions could leave several). */
function copiesById(messages) {
  const out = new Map();
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (!out.has(m.id)) out.set(m.id, []);
    out.get(m.id).push(m);
  }
  return out;
}

const sameCopies = (a, b) => JSON.stringify(a.map((m) => JSON.stringify(m)).sort()) === JSON.stringify(b.map((m) => JSON.stringify(m)).sort());

/**
 * Comments carry who wrote them, and only the worker can vouch for that:
 * a change may add messages and threads in the caller's own name, edit or
 * delete their own messages, and resolve threads they started (anyone who
 * can edit may resolve any thread, and the owner may delete any message).
 */
export function checkComments(before, after, user, role) {
  const me = user.username;
  const deny = () => fail(403, 'Comments can only be added or changed in your own name.');
  const isEditor = role === 'owner' || role === 'editor';
  for (const [id, t] of Object.entries(after)) {
    const old = before[id];
    const messages = Array.isArray(t?.messages) ? t.messages : [];
    if (!old) {
      if (t.by !== me) deny();
      for (const m of messages) if (m?.by !== me) deny();
      continue;
    }
    for (const field of ['block', 'quote', 'created', 'by', 'invalid']) if (JSON.stringify(old[field]) !== JSON.stringify(t[field])) deny();
    if (!!old.resolved !== !!t.resolved && !(isEditor || old.by === me || messages.length > (old.messages || []).length)) deny();
    const was = copiesById(Array.isArray(old.messages) ? old.messages : []);
    const now = copiesById(messages);
    for (const [mid, copies] of now) {
      const prev = was.get(mid);
      if (!prev) {
        if (copies.some((m) => m.by !== me)) deny();
        continue;
      }
      if (sameCopies(prev, copies)) continue;
      const authors = new Set(prev.map((m) => m.by));
      if (copies.some((m) => !authors.has(m.by) || !prev.some((p) => p.at === m.at))) deny();
      const mine = authors.size === 1 && authors.has(me);
      if (!mine && !(role === 'owner' && copies.every((m) => m.deleted))) deny();
    }
    // A message leaves its thread only when its author or the owner removes it.
    for (const [mid, prev] of was) if (!now.has(mid) && role !== 'owner' && prev.some((m) => m.by !== me)) deny();
  }
  for (const [id, t] of Object.entries(before)) {
    if (after[id]) continue;
    // A thread disappears when its last message is deleted.
    const left = (t?.messages || []).filter((m) => m && !m.deleted);
    if (left.length && !(role === 'owner' || left.every((m) => m.by === me))) deny();
  }
}

export class WikiService {
  constructor(puter, { now = Date.now, fetcher = fetch } = {}) {
    this.puter = puter;
    this.kv = puter.kv;
    this.now = now;
    this.fetcher = fetcher;
  }

  async accountOwner() {
    if (!ACCOUNT_OWNER || ACCOUNT_OWNER.token !== this.puter.authToken) {
      const user = await this.puter.auth.getUser();
      ACCOUNT_OWNER = { token: this.puter.authToken, uuid: user.uuid, username: user.username };
    }
    return ACCOUNT_OWNER;
  }

  async list(prefix, { stop = null, reverse = false } = {}) {
    let cursor;
    const rows = [];
    do {
      const page = await this.kv.list({ pattern: prefix, returnValues: true, limit: stop ? 100 : 1000, ...(reverse ? { reverse: true } : {}), ...(cursor ? { cursor } : {}) });
      const items = Array.isArray(page) ? page : page?.items || [];
      const end = stop ? items.findIndex(stop) : -1;
      if (end >= 0) {
        rows.push(...items.slice(0, end));
        break;
      }
      rows.push(...items);
      cursor = Array.isArray(page) ? null : page?.cursor;
    } while (cursor);
    return rows;
  }

  async readFile(path) {
    return (await this.puter.fs.read(path)).text();
  }

  async writeFile(path, text) {
    await this.puter.fs.write(path, text, { overwrite: true, dedupeName: false, createMissingParents: true });
  }

  async recordBytes(value) {
    return decode(value.update ?? (await this.readFile(value.path)));
  }

  /* ---------- documents ---------- */

  async load(room, doc) {
    const key = `${room}|${doc}`;
    const now = this.now();
    let entry = DOCS.get(key);
    const prefix = `wk:${room}:log:${doc}:`;
    if (!entry || now - entry.listedAt > RELOAD) {
      if (entry) entry.ydoc.destroy();
      entry = { ydoc: new Y.Doc(), seen: new Set(), retry: new Map(), listedAt: now, count: 0, cp: null };
      const cp = await this.kv.get(`wk:${room}:cp:${doc}`);
      if (cp?.path) {
        Y.applyUpdate(entry.ydoc, decode(await this.readFile(cp.path)));
        entry.cp = cp;
      }
      const since = cp ? cp.at - OVERLAP : 0;
      const rows = await this.list(prefix, { stop: (r) => r.value?.at < since, reverse: true });
      for (const row of rows.reverse()) await this.applyRow(entry, row);
      entry.count = rows.filter((r) => !cp || r.value.at > cp.at).length;
      keep(key, entry);
      return entry;
    }
    for (const row of [...entry.retry.values()]) await this.applyRow(entry, row, true);
    if (now - entry.listedAt > FRESH) {
      const since = entry.listedAt - OVERLAP;
      entry.listedAt = now;
      const rows = await this.list(prefix, { stop: (r) => r.value?.at < since, reverse: true });
      for (const row of rows.reverse()) if (!entry.seen.has(row.key)) await this.applyRow(entry, row, true);
    }
    keep(key, entry);
    return entry;
  }

  async applyRow(entry, row, counted = false) {
    if (entry.seen.has(row.key) || !row.value) return;
    let bytes;
    try {
      bytes = await this.recordBytes(row.value);
    } catch (error) {
      const missing = ['subject_does_not_exist', 'ENOENT', 'not_found'].includes(error?.code);
      if (!missing) {
        // Read it again next time; until then this copy must not become a
        // checkpoint, or the edit would be lost for everyone.
        entry.retry.set(row.key, row);
        return;
      }
      bytes = null;
    }
    entry.seen.add(row.key);
    entry.retry.delete(row.key);
    if (bytes) {
      try {
        Y.applyUpdate(entry.ydoc, bytes);
      } catch {
        /* a malformed record is skipped; the rest still loads */
      }
    }
    if (counted) entry.count++;
  }

  async checkpoint(room, doc, entry) {
    if (entry.retry.size) return;
    // Another instance may have checkpointed since this copy was read and
    // dropped records this copy never listed; its checkpoint holds them.
    const latest = await this.kv.get(`wk:${room}:cp:${doc}`);
    if (latest?.path && latest.at !== entry.cp?.at) {
      Y.applyUpdate(entry.ydoc, decode(await this.readFile(latest.path)));
      entry.cp = latest;
    }
    const state = encode(Y.encodeStateAsUpdate(entry.ydoc));
    const path = `wiki/shared/${room}/cp/${doc}-${(await hash(state)).slice(0, 24)}.txt`;
    await this.writeFile(path, state);
    const prev = entry.cp;
    const cp = { path, at: this.now(), prevAt: prev?.at ?? 0 };
    await this.kv.set(`wk:${room}:cp:${doc}`, cp);
    entry.cp = cp;
    entry.count = 0;
    // Records older than the previous checkpoint are inside both; drop them.
    if (prev?.at) {
      const cutoff = prev.at - OVERLAP;
      const old = await this.list(`wk:${room}:log:${doc}:`).catch(() => []);
      for (const row of old) {
        if (row.value?.at < cutoff) {
          await this.kv.del(row.key).catch(() => {});
          if (row.value.path) await this.puter.fs.delete(row.value.path).catch(() => {});
        }
      }
    }
    // The previous checkpoint stays as a version in the page's history.
    if (prev?.path && prev.path !== path) {
      const history = (await this.kv.get(`wk:${room}:cps:${doc}`)) || [];
      history.unshift({ at: prev.at, path: prev.path });
      for (const dropped of history.splice(HISTORY_KEPT)) await this.puter.fs.delete(dropped.path).catch(() => {});
      await this.kv.set(`wk:${room}:cps:${doc}`, history);
    }
  }

  /* ---------- access ---------- */

  async access(room, user) {
    const [meta, member] = await this.kv.get([`wk:${room}:meta`, `wk:${room}:member:${user.uuid}`]);
    if (!meta || meta.deleted) fail(404, 'This space was deleted or the link is wrong.');
    if (!member || member.role === 'removed') fail(403, 'You do not have access to this space.');
    // People who came in through the public link have whatever the link
    // gives now, and lose access when it is turned off.
    if (member.via === 'link') {
      if (meta.visibility !== 'link') fail(403, 'You do not have access to this space.');
      return { meta, member: { ...member, role: meta.linkRole || 'viewer' } };
    }
    return { meta, member };
  }

  async admit(room, user, token) {
    const [meta, prior] = await this.kv.get([`wk:${room}:meta`, `wk:${room}:member:${user.uuid}`]);
    if (!meta || meta.deleted) fail(404, 'This space was deleted or the link is wrong.');
    const linkOn = meta.visibility === 'link';
    if (prior && prior.role !== 'removed' && !token && !(prior.via === 'link' && !linkOn)) return;
    if (prior && prior.role !== 'removed' && token && prior.via !== 'link') return;
    let role = null;
    let via = null;
    if (token) {
      const invite = typeof token === 'string' && token.length <= 200 ? await this.kv.get(`wk:${room}:invite:${await hash(token)}`) : null;
      if (!invite || invite.expires < this.now()) fail(403, 'This invitation has expired or was revoked. Ask for a new link.');
      // Someone removed comes back only with an invitation made after that.
      if (prior?.role === 'removed' && !(invite.created > (prior.removed || 0))) fail(403, 'Your access to this space was removed.');
      role = invite.role;
      via = 'invite';
      // Never lower than what the public link gives right now.
      if (prior?.via === 'link' && linkOn && INVITE_ROLES.indexOf(meta.linkRole || 'viewer') < INVITE_ROLES.indexOf(role)) role = meta.linkRole || 'viewer';
    } else if (prior?.role === 'removed') {
      fail(403, 'Your access to this space was removed.');
    } else if (linkOn) {
      role = meta.linkRole || 'viewer';
      via = 'link';
    }
    if (!role) fail(403, 'You do not have access to this space. Ask its owner to share it with you.');
    await this.kv.set(`wk:${room}:member:${user.uuid}`, { uuid: user.uuid, username: user.username, role, via, joined: this.now() });
  }

  /* ---------- live updates ---------- */

  /**
   * Tells everyone watching the space that something changed. docs lists
   * the documents saved (empty: people or settings changed), keys the log
   * record of each, so a client can fetch exactly that edit, and session
   * and by (the account) who saved it, so their own tab can skip it.
   */
  async notify(room, docs = [], { keys = null, session = null, by = null, seq = null } = {}) {
    try {
      seq ??= await this.kv.incr(`wk:${room}:seq`);
      await this.kv.set(`wk:${room}:ev:signal`, { nonce: crypto.randomUUID(), seq, docs: docs.slice(0, 32), ...(keys ? { keys } : {}), ...(session ? { session, by } : {}) });
    } catch {
      /* the edit is saved; clients also poll */
    }
  }

  async events(room, user) {
    const app = appUid(this.puter.authToken);
    if (!app) return null;
    if (user.uuid === (await this.accountOwner()).uuid) return { app, key: `wk:${room}:ev:signal` };
    const cache = `wk:${room}:handle:${user.uuid}`;
    let handle = await this.kv.get(cache);
    if (!handle) {
      try {
        const res = await this.fetcher(`${this.puter.APIOrigin}/events/kv-handles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.puter.authToken}` },
          body: JSON.stringify({ granteeUid: user.uuid, prefix: `wk:${room}:ev:` }),
          signal: AbortSignal.timeout(3000),
        });
        const data = await res.json();
        if (res.ok && data.handle) {
          handle = data.handle;
          await this.kv.set(cache, handle);
        }
      } catch {
        /* polling keeps working without events */
      }
    }
    return handle ? { handle, key: 'signal' } : null;
  }

  async dropHandle(room, target) {
    for (const row of await this.list(`wk:${room}:presence:`)) if (row.value?.uuid === target) await this.kv.del(row.key);
    const handle = await this.kv.get(`wk:${room}:handle:${target}`);
    if (!handle) return;
    const res = await this.fetcher(`${this.puter.APIOrigin}/events/kv-handles/${encodeURIComponent(handle)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.puter.authToken}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (res && (res.ok || res.status === 404)) await this.kv.del(`wk:${room}:handle:${target}`);
  }

  settings(meta) {
    return { visibility: meta.visibility || 'private', linkRole: meta.linkRole || 'viewer' };
  }

  /* ---------- requests ---------- */

  async call(user, input) {
    if (!input || typeof input !== 'object') fail(400, 'Invalid request.');
    const room = id(input.room);
    const prefix = `wk:${room}:`;

    if (input.op === 'create') {
      const owner = await this.accountOwner();
      if (user.uuid !== owner.uuid) fail(403, 'Only the owner of this server can create spaces.');
      const docs = input.docs && typeof input.docs === 'object' ? Object.entries(input.docs) : [];
      if (!docs.length || docs.length > 2000 || !input.docs.tree) fail(400, 'A space needs its pages.');
      const existing = await this.kv.get(prefix + 'meta');
      if (existing) {
        if (existing.owner !== user.uuid) fail(409, 'This space already exists.');
        return { room };
      }
      if ((await this.kv.incr(prefix + 'creation')) !== 1) fail(409, 'This space is already being created. Try again.');
      await this.kv.expire(prefix + 'creation', 120).catch(() => {});
      try {
        for (const [docId, state] of docs) {
          id(docId, DOC);
          const bytes = decode(state, UPDATE_LIMIT * 4);
          try {
            Y.decodeUpdate(bytes);
          } catch {
            fail(422, 'A page could not be shared.');
          }
          const path = `wiki/shared/${room}/cp/${docId}-${(await hash(state)).slice(0, 24)}.txt`;
          await this.writeFile(path, state);
          await this.kv.set(`${prefix}cp:${docId}`, { path, at: this.now(), prevAt: 0 });
        }
        await this.kv.set(prefix + `member:${user.uuid}`, { uuid: user.uuid, username: user.username, role: 'owner', joined: this.now() });
        await this.kv.set(prefix + 'meta', {
          owner: user.uuid,
          ownerName: user.username,
          title: String(input.title || '').slice(0, 200),
          icon: input.icon && typeof input.icon === 'object' ? { name: String(input.icon.name || '').slice(0, 40), color: String(input.icon.color || '').slice(0, 20) } : null,
          created: this.now(),
          visibility: 'private',
          linkRole: 'viewer',
        });
      } finally {
        await this.kv.del(prefix + 'creation').catch(() => {});
      }
      return { room };
    }

    if (input.op === 'join') await this.admit(room, user, input.token);
    const { meta, member } = await this.access(room, user);
    const role = member.role;

    if (input.op === 'join') {
      return {
        room,
        role,
        owner: meta.ownerName,
        title: meta.title || '',
        icon: meta.icon || null,
        events: await this.events(room, user),
        app: appUid(this.puter.authToken),
        ownerUuid: meta.owner,
        settings: canManage(role) ? this.settings(meta) : null,
        serverTime: this.now(),
      };
    }

    if (input.op === 'events') return { events: await this.events(room, user) };

    if (input.op === 'sync') {
      const wanted = input.docs && typeof input.docs === 'object' ? Object.entries(input.docs).slice(0, 40) : [];
      const hints = input.keys && typeof input.keys === 'object' ? input.keys : {};
      const updates = {};
      for (const [docId, vector] of wanted) {
        id(docId, DOC);
        const entry = await this.load(room, docId);
        // Signals named these edits: read their records directly, since this
        // instance's copy may predate them and a listing may not show them yet.
        const logPrefix = `${prefix}log:${docId}:`;
        const named = Object.hasOwn(hints, docId) ? [hints[docId]].flat().slice(0, 64) : [];
        const fresh = [...new Set(named.filter((k) => typeof k === 'string' && k.startsWith(logPrefix) && LOG_TAIL.test(k.slice(logPrefix.length)) && !entry.seen.has(k)))].sort().slice(-MAX_HINTS);
        if (fresh.length) {
          const values = await this.kv.get(fresh).catch(() => []);
          for (let i = 0; i < fresh.length; i++) if (values?.[i]) await this.applyRow(entry, { key: fresh[i], value: values[i] }, true);
        }
        const sv = vector ? decode(vector, 100_000) : undefined;
        updates[docId] = encode(sv ? Y.encodeStateAsUpdate(entry.ydoc, sv) : Y.encodeStateAsUpdate(entry.ydoc));
      }
      return { updates, role, title: meta.title || '', serverTime: this.now() };
    }

    if (input.op === 'commit') {
      const docId = id(input.doc, DOC);
      if (!canWriteDoc(role, docId)) fail(403, role === 'viewer' ? 'You can view this space but not change it.' : 'You can comment in this space but not change its pages.');
      if (typeof input.update !== 'string' || input.update.length > UPDATE_LIMIT) fail(413, 'This change is too large to save.');
      let bytes;
      try {
        bytes = decode(input.update, UPDATE_LIMIT);
        Y.decodeUpdate(bytes);
      } catch {
        fail(400, 'Invalid collaboration update.');
      }
      const digest = await hash(bytes);
      if (input.id !== digest) fail(400, 'Update checksum does not match.');
      let entry = await this.load(room, docId);
      // Comments: people may add and change only their own messages.
      if (docId.endsWith('.c')) {
        const attempt = () => {
          const trial = new Y.Doc();
          Y.applyUpdate(trial, Y.encodeStateAsUpdate(entry.ydoc));
          const before = commentState(trial);
          Y.applyUpdate(trial, bytes);
          const result = { before, after: commentState(trial), complete: integrated(trial, bytes) };
          trial.destroy();
          return result;
        };
        let trial = attempt();
        // Part of the edit builds on something this copy lacks, so its effect
        // cannot be checked: read the document again, or have the client retry.
        if (!trial.complete) {
          DOCS.delete(`${room}|${docId}`);
          entry = await this.load(room, docId);
          trial = attempt();
        }
        if (!trial.complete) fail(409, 'This comment depends on changes that are still arriving. Try again.');
        checkComments(trial.before, trial.after, user, role);
      }
      Y.applyUpdate(entry.ydoc, bytes);
      if (Y.encodeStateAsUpdate(entry.ydoc).length > DOC_LIMIT) {
        // Read it again without the refused edit.
        DOCS.delete(`${room}|${docId}`);
        fail(413, 'This page has grown too large to save more changes.');
      }
      const at = this.now();
      const record = { id: digest, author: user.uuid, username: user.username, at };
      if (input.update.length <= MAX_INLINE) record.update = input.update;
      else {
        record.path = `wiki/shared/${room}/updates/${digest}.txt`;
        await this.writeFile(record.path, input.update);
      }
      const key = `${prefix}log:${docId}:${new Date(at).toISOString()}:${digest.slice(0, 16)}`;
      // The signal's number is taken while the record is written; the signal
      // itself goes out after, so a client reading the record finds it.
      const [, seq] = await Promise.all([this.kv.set(key, record), this.kv.incr(`${prefix}seq`).catch(() => null)]);
      entry.seen.add(key);
      entry.count++;
      await this.notify(room, [docId], { keys: { [docId]: key }, session: typeof input.session === 'string' && SESSION.test(input.session) ? input.session : null, by: user.uuid, seq });
      if (entry.count >= CHECKPOINT_EVERY || (entry.cp && this.now() - entry.cp.at > CHECKPOINT_AGE)) await this.checkpoint(room, docId, entry).catch(() => {});
      const sv = input.vector ? decode(input.vector, 100_000) : null;
      return { update: sv ? encode(Y.encodeStateAsUpdate(entry.ydoc, sv)) : null, role, serverTime: this.now() };
    }

    if (input.op === 'purge') {
      if (!canWriteDoc(role, 'tree')) fail(403, 'You can view this space but not change it.');
      const ids = Array.isArray(input.pages) ? input.pages.slice(0, 500).map((x) => id(x, /^[a-z0-9]{1,40}$/)) : [];
      // Only pages already gone from the space's tree can be wiped.
      const tree = await this.load(room, 'tree');
      const pages = tree.ydoc.getMap('pages');
      for (const page of ids) {
        if (pages.has(page)) fail(409, 'Delete the page before removing its history.');
        for (const doc of [page, `${page}.c`]) {
          for (const row of await this.list(`${prefix}log:${doc}:`).catch(() => [])) {
            await this.kv.del(row.key).catch(() => {});
            if (row.value?.path) await this.puter.fs.delete(row.value.path).catch(() => {});
          }
          const [cp, history] = await this.kv.get([`${prefix}cp:${doc}`, `${prefix}cps:${doc}`]);
          for (const v of [cp, ...(history || [])]) if (v?.path) await this.puter.fs.delete(v.path).catch(() => {});
          await this.kv.del(`${prefix}cp:${doc}`).catch(() => {});
          await this.kv.del(`${prefix}cps:${doc}`).catch(() => {});
          DOCS.delete(`${room}|${doc}`);
        }
      }
      return { ok: true };
    }

    if (input.op === 'history.list') {
      const docId = id(input.doc, DOC);
      const [cp, history] = await this.kv.get([`${prefix}cp:${docId}`, `${prefix}cps:${docId}`]);
      const versions = [...(cp ? [{ at: cp.at }] : []), ...(history || []).map((v) => ({ at: v.at }))];
      return { versions };
    }

    if (input.op === 'history.get') {
      const docId = id(input.doc, DOC);
      const [cp, history] = await this.kv.get([`${prefix}cp:${docId}`, `${prefix}cps:${docId}`]);
      const found = [cp, ...(history || [])].find((v) => v && v.at === input.at);
      if (!found) fail(404, 'This version is no longer available.');
      return { state: await this.readFile(found.path) };
    }

    if (input.op === 'presence') {
      const session = id(input.session, /^[a-z0-9]{8,40}$/);
      const page = typeof input.page === 'string' && /^[a-z0-9]{1,40}$/.test(input.page) ? input.page : null;
      const now = this.now();
      const ticket = { session, uuid: user.uuid, username: String(user.username || 'Someone').slice(0, 80), page, role, expires: now + SESSION_TTL };
      await this.kv.set(`${prefix}presence:${session}`, ticket, Math.floor(ticket.expires / 1000));
      const roster = (await this.list(`${prefix}presence:`))
        .map((r) => r.value)
        .filter((p) => p && p.expires > now && p.session !== session)
        .slice(0, MAX_ROSTER);
      roster.push(ticket);
      if (input.changed) await this.notify(room, []);
      return { roster: roster.map(({ session: s, uuid, username, page: pg }) => ({ session: s, uuid, username, page: pg })), role };
    }

    if (input.op === 'leave') {
      const key = `${prefix}presence:${id(input.session, /^[a-z0-9]{8,40}$/)}`;
      const ticket = await this.kv.get(key);
      if (ticket?.uuid === user.uuid) {
        await this.kv.del(key);
        await this.notify(room, []);
      }
      return { ok: true };
    }

    if (input.op === 'meta') {
      if (!canWriteDoc(role, 'tree')) fail(403, 'You can view this space but not change it.');
      const next = { ...meta };
      if (typeof input.title === 'string') next.title = input.title.slice(0, 200);
      if (input.icon === null || (input.icon && typeof input.icon === 'object')) next.icon = input.icon ? { name: String(input.icon.name || '').slice(0, 40), color: String(input.icon.color || '').slice(0, 20) } : null;
      await this.kv.set(prefix + 'meta', next);
      return { ok: true };
    }

    if (input.op === 'asset.get') {
      const asset = id(input.asset, /^[a-f0-9]{64}$/);
      try {
        return { data: await this.readFile(`wiki/shared/${room}/assets/${asset}.txt`) };
      } catch {
        fail(404, 'This image is not available.');
      }
    }

    if (input.op === 'asset.put') {
      if (!canWriteDoc(role, 'tree')) fail(403, 'You can view this space but not change it.');
      const asset = id(input.asset, /^[a-f0-9]{64}$/);
      const data = input.data;
      const m = typeof data === 'string' && data.length <= ASSET_CHARS ? /^data:(image\/(png|jpeg|gif|webp|svg\+xml|avif)|application\/octet-stream);base64,([A-Za-z0-9+/=]*)$/.exec(data) : null;
      if (!m || (await hash(decode(m[3]))) !== asset) fail(400, 'Invalid image.');
      const path = `wiki/shared/${room}/assets/${asset}.txt`;
      const exists = await this.puter.fs.stat(path).then(() => true, () => false);
      if (!exists) {
        const used = `${prefix}assetbytes`;
        if ((await this.kv.incr(used, data.length)) > ASSET_BYTES) {
          await this.kv.incr(used, -data.length).catch(() => {});
          fail(413, 'This space has reached its 1 GB limit for images.');
        }
        await this.writeFile(path, data);
      }
      return { ok: true };
    }

    if (input.op === 'forget') {
      if (role === 'owner') fail(400, 'The owner cannot leave their own space. Delete it instead.');
      await this.kv.del(`${prefix}member:${user.uuid}`);
      await this.dropHandle(room, user.uuid).catch(() => {});
      return { ok: true };
    }

    // Everything below manages the space.
    if (!canManage(role)) fail(403, 'Only the owner of this space can manage who has access.');

    if (input.op === 'invite') {
      const inviteRole = INVITE_ROLES.includes(input.role) ? input.role : 'editor';
      const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      const expires = this.now() + INVITE_DAYS * DAY;
      await this.kv.set(`${prefix}invite:${await hash(token)}`, { role: inviteRole, created: this.now(), expires, createdBy: user.uuid }, Math.floor(expires / 1000));
      return { token, expires };
    }

    if (input.op === 'invite-status') {
      const row = typeof input.token === 'string' && input.token.length <= 200 ? await this.kv.get(`${prefix}invite:${await hash(input.token)}`) : null;
      return { valid: !!row && row.expires > this.now() && row.role === input.role, expires: row?.expires ?? null };
    }

    if (input.op === 'revoke-invites') {
      for (const row of await this.list(`${prefix}invite:`)) await this.kv.del(row.key);
      return { ok: true };
    }

    if (input.op === 'members') {
      const rows = await this.list(`${prefix}member:`);
      const members = rows
        .map((r) => r.value)
        .filter((m) => m && m.role !== 'removed' && !(m.via === 'link' && meta.visibility !== 'link'))
        .map(({ uuid, username, role: r, via, joined }) => ({ uuid, username, role: r, via: via || null, joined: joined || null }));
      return { members, settings: this.settings(meta) };
    }

    if (input.op === 'role') {
      const target = id(input.uuid, /^[0-9a-f-]{36}$/i);
      if (target === meta.owner || ![...INVITE_ROLES, 'removed'].includes(input.role)) fail(400, 'Invalid role change.');
      const record = await this.kv.get(`${prefix}member:${target}`);
      if (!record) fail(404, 'This person is not in the space.');
      const { via, removed, ...named } = record;
      await this.kv.set(`${prefix}member:${target}`, { ...named, role: input.role, ...(input.role === 'removed' ? { removed: this.now() } : {}) });
      if (input.role === 'removed') await this.dropHandle(room, target).catch(() => {});
      await this.notify(room, []);
      return { ok: true };
    }

    if (input.op === 'settings') {
      const next = { ...meta };
      if (['private', 'link'].includes(input.visibility)) next.visibility = input.visibility;
      if (INVITE_ROLES.includes(input.linkRole)) next.linkRole = input.linkRole;
      await this.kv.set(prefix + 'meta', next);
      return { settings: this.settings(next) };
    }

    if (input.op === 'delete') {
      await this.kv.set(prefix + 'meta', { ...meta, deleted: this.now() });
      await this.notify(room, []);
      return { ok: true };
    }

    fail(400, 'Unknown request.');
  }
}
