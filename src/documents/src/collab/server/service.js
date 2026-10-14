/**
 * The room service: what the owner's Puter worker runs for shared documents.
 * It keeps each room's Yjs edit log, memberships, invitations, presence and
 * the document the room started from in the owner's key-value store and
 * files, and checks every request: membership, and role (viewers cannot
 * commit; commenters can change only comments).
 *
 * The design follows the Whiteboard and Photo Studio room workers in this
 * repository; the service takes its Puter (`me.puter` in the worker, a fake in
 * tests and in the dev server) as a parameter.
 *
 * KV layout (room = a random id):
 *   doc:<room>:meta                 owner, name, created, closed?, base file, schema
 *   doc:<room>:member:<uuid>        { uuid, username, role, joined }
 *   doc:<room>:invite:<sha256>      invitation link: { role, expires, createdBy }
 *   doc:<room>:named:<username>     invitation by Puter username: { role, expires }
 *   doc:<room>:seq, doc:<room>:log:<n>   numbered accepted updates
 *   doc:<room>:cp                   checkpoint { seq, path } every 100 updates
 *   doc:<room>:presence:<session>   presence entry (expires)
 */
import * as Y from 'yjs';
import { canComment, canEdit, canManage, decode, encode, hash, ID, INVITE_ROLES, MAX_UPDATE, MAX_BASE_BYTES, PRESENCE_TTL } from '../protocol.js';
import { checkCommentOnly } from '../transports.js';

export const INVITE_DAYS = 7;
const DAY = 86_400_000;
const CHECKPOINT_EVERY = 100;
const INLINE_UPDATE = 100_000;
const ROOTS = new Set(['body', 'parts', 'comments', 'assets', 'meta']);

export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const id = value => { if (typeof value !== 'string' || !ID.test(value)) fail(400, 'Invalid identifier.'); return value; };
const pad = n => String(n).padStart(12, '0');

// Rooms loaded by this worker instance, refreshed from the log on each use.
const ROOMS = new Map();
const LOCKS = new WeakMap();

export class RoomService {
  constructor(puter, { now = Date.now, rooms = ROOMS } = {}) {
    this.puter = puter; this.kv = puter.kv; this.fs = puter.fs; this.now = now; this.rooms = rooms;
  }
  owner() { return (this.accountOwner ||= this.puter.auth.getUser()); }
  path(room, name) { return `documents-collab/${room}/${name}`; }
  async readText(path) { return (await this.fs.read(path)).text(); }
  async writeText(path, text) { await this.fs.write(path, text, { overwrite: true, dedupeName: false, createMissingParents: true }); }
  async list(prefix) {
    const out = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
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
    const meta = await this.kv.get(`doc:${room}:meta`);
    if (!meta) fail(404, 'This shared document does not exist.');
    if (meta.closed) fail(410, 'The owner stopped sharing this document.');
    return meta;
  }
  async member(room, user) {
    const meta = await this.meta(room);
    const m = await this.kv.get(`doc:${room}:member:${user.uuid}`);
    if (!m || m.role === 'removed') fail(403, 'You do not have access to this shared document.');
    return { meta, member: m };
  }
  /** Admit someone opening the document: a member, an invitation link, or an invitation by username. */
  async admit(room, user, token) {
    const meta = await this.meta(room);
    const prior = await this.kv.get(`doc:${room}:member:${user.uuid}`);
    if (prior?.role === 'removed') fail(403, 'Your access to this shared document was removed.');
    if (prior) return;
    let role = null;
    if (typeof token === 'string' && token) {
      if (token.length > 200) fail(400, 'Invalid invitation.');
      const invite = await this.kv.get(`doc:${room}:invite:${await hash(token)}`);
      if (!invite || invite.expires < this.now()) fail(403, 'This invitation has expired or was revoked.');
      role = invite.role;
    } else {
      const named = await this.kv.get(`doc:${room}:named:${user.username.toLowerCase()}`);
      if (named && named.expires >= this.now()) role = named.role;
    }
    if (!role) fail(403, 'Ask the owner for an invitation to this shared document.');
    if (user.uuid === meta.owner) role = 'owner';
    await this.kv.set(`doc:${room}:member:${user.uuid}`, { uuid: user.uuid, username: user.username, role, joined: this.now() });
  }

  /* ---------- State ---------- */

  async load(room) {
    let entry = this.rooms.get(room);
    if (!entry) {
      const doc = new Y.Doc();
      const cp = await this.kv.get(`doc:${room}:cp`);
      if (cp) Y.applyUpdate(doc, decode(await this.readText(cp.path)));
      entry = { doc, seq: cp?.seq ?? 0 };
      this.rooms.set(room, entry);
      if (this.rooms.size > 16) { const [oldest] = this.rooms.keys(); if (oldest !== room) { this.rooms.get(oldest).doc.destroy(); this.rooms.delete(oldest); } }
    }
    const last = Number((await this.kv.get(`doc:${room}:seq`)) ?? 0);
    for (let n = entry.seq + 1; n <= last; n++) {
      const record = await this.kv.get(`doc:${room}:log:${pad(n)}`);
      if (!record) break; // numbered by a commit still being written elsewhere
      Y.applyUpdate(entry.doc, decode(record.file ? await this.readText(record.file) : record.update), 'log');
      entry.seq = n;
    }
    return entry;
  }
  serial(room, fn) {
    let locks = LOCKS.get(this.rooms);
    if (!locks) LOCKS.set(this.rooms, locks = new Map());
    const run = (locks.get(room) || Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    locks.set(room, tail);
    tail.then(() => { if (locks.get(room) === tail) locks.delete(room); });
    return run;
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
      case 'join': return { room, name: meta.name, role: member.role, user: { uuid: user.uuid, username: user.username }, owner: meta.owner, ownerName: meta.ownerName, serverTime: this.now() };
      case 'sync': return this.sync(room, user, member, input);
      case 'commit': return this.serial(room, () => this.commit(room, member, input));
      case 'base': return { base: await this.readText(meta.base) };
      case 'leave': {
        const key = `doc:${room}:presence:${id(input.session)}`;
        const entry = await this.kv.get(key);
        if (entry?.user === user.uuid) await this.kv.del(key);
        return { ok: true };
      }
      case 'members': return this.members(room, member);
      case 'invite': case 'invite-user': case 'revoke-invites': case 'role': case 'stop':
        if (!canManage(member.role)) fail(403, 'Only the owner can manage access.');
        return this.manage(room, meta, user, input);
    }
    fail(400, 'Unknown request.');
  }

  async create(room, user, input) {
    if (user.uuid !== (await this.owner()).uuid) fail(403, 'Only the owner of this collaboration server can share documents on it.');
    const existing = await this.kv.get(`doc:${room}:meta`);
    if (existing) { if (existing.owner !== user.uuid) fail(403, 'Only the owner can finish sharing this document.'); return { room }; }
    if (typeof input.base !== 'string' || input.base.length > MAX_BASE_BYTES * 1.4) fail(413, 'This document is too large to share for live editing.');
    let initial;
    try { initial = decode(input.initial, MAX_UPDATE); } catch { fail(400, 'Invalid initial document.'); }
    const doc = new Y.Doc();
    try { Y.applyUpdate(doc, initial); if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('incomplete'); }
    catch { fail(422, 'This document could not be shared.'); }
    finally { doc.destroy(); }
    const base = this.path(room, 'base.txt'), cp = this.path(room, `cp-${pad(0)}.txt`);
    await this.writeText(base, input.base);
    await this.writeText(cp, input.initial);
    await this.kv.set(`doc:${room}:cp`, { seq: 0, path: cp });
    await this.kv.set(`doc:${room}:meta`, { owner: user.uuid, ownerName: user.username, name: typeof input.name === 'string' ? input.name.slice(0, 200) : 'Untitled document', created: this.now(), base, schema: 1 });
    await this.kv.set(`doc:${room}:member:${user.uuid}`, { uuid: user.uuid, username: user.username, role: 'owner', joined: this.now() });
    return { room };
  }

  async sync(room, user, member, input) {
    const entry = await this.load(room);
    let vector;
    try { vector = typeof input.vector === 'string' && input.vector ? decode(input.vector, 1_000_000) : undefined; } catch { fail(400, 'Invalid state vector.'); }
    let update;
    try { update = Y.encodeStateAsUpdate(entry.doc, vector); } catch { fail(400, 'Invalid state vector.'); }
    const prefix = `doc:${room}:presence:`;
    const p = input.presence;
    if (p && typeof p === 'object' && ID.test(String(p.session || ''))) {
      const text = JSON.stringify(p);
      if (text.length < 4000) {
        const existing = await this.kv.get(prefix + p.session);
        if (existing && existing.user !== user.uuid) fail(409, 'Session belongs to another participant.');
        await this.kv.set(prefix + p.session, { ...p, user: user.uuid, name: String(user.username).slice(0, 80), role: member.role, at: this.now(), expires: this.now() + PRESENCE_TTL }, Math.floor((this.now() + PRESENCE_TTL) / 1000));
      }
    }
    const roster = (await this.list(prefix)).map(r => r.value).filter(v => v && v.expires > this.now()).map(({ expires, ...rest }) => rest);
    return { update: encode(update), seq: entry.seq, role: member.role, roster, serverTime: this.now() };
  }

  async commit(room, member, input) {
    if (!canComment(member.role)) fail(403, 'You can only view this shared document.');
    if (typeof input.update !== 'string' || input.update.length > MAX_UPDATE) fail(413, 'This change is too large to save.');
    let update;
    try { update = decode(input.update, MAX_UPDATE); } catch { fail(400, 'Invalid change.'); }
    const entry = await this.load(room);
    // Try the change on a copy: only accepted changes reach the loaded document and the log.
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(entry.doc));
    const roots = new Set();
    scratch.on('afterTransaction', tr => { for (const type of tr.changed.keys()) { let t = type; while (t._item) t = t._item.parent; for (const [name, v] of scratch.share) if (v === t) roots.add(name); } });
    try { Y.applyUpdate(scratch, update); } catch { scratch.destroy(); fail(400, 'Invalid change.'); }
    const missing = !!(scratch.store.pendingStructs || scratch.store.pendingDs);
    scratch.destroy();
    if (missing) fail(409, 'This change builds on edits the server has not received. Synchronize and try again.');
    for (const root of roots) if (!ROOTS.has(root)) fail(400, 'Invalid change.');
    if (!canEdit(member.role)) checkCommentOnly(entry.doc, update);
    const seq = await this.kv.incr(`doc:${room}:seq`);
    const record = { user: member.uuid, at: this.now() };
    if (input.update.length > INLINE_UPDATE) { record.file = this.path(room, `log/${pad(seq)}.txt`); await this.writeText(record.file, input.update); }
    else record.update = input.update;
    await this.kv.set(`doc:${room}:log:${pad(seq)}`, record);
    Y.applyUpdate(entry.doc, update, 'log');
    if (entry.seq === seq - 1) entry.seq = seq;
    if (seq % CHECKPOINT_EVERY === 0 && entry.seq === seq) {
      const path = this.path(room, `cp-${pad(seq)}.txt`);
      await this.writeText(path, encode(Y.encodeStateAsUpdate(entry.doc)));
      await this.kv.set(`doc:${room}:cp`, { seq, path });
    }
    return { seq };
  }

  async members(room, member) {
    const prefix = `doc:${room}:`;
    const members = (await this.list(`${prefix}member:`)).map(r => r.value).filter(m => m && m.role !== 'removed').map(m => ({ uuid: m.uuid, username: m.username, role: m.role }));
    if (!canManage(member.role)) return { members };
    const named = (await this.list(`${prefix}named:`)).map(r => ({ username: r.key.slice(`${prefix}named:`.length), ...r.value })).filter(n => n.expires >= this.now());
    const invites = (await this.list(`${prefix}invite:`)).map(r => r.value).filter(i => i.expires >= this.now());
    return { members, named: named.map(n => ({ username: n.username, role: n.role, expires: n.expires })), invites: invites.length };
  }

  async manage(room, meta, user, input) {
    const prefix = `doc:${room}:`;
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
        if (row.value.username.toLowerCase() === name.toLowerCase() && row.value.role !== 'owner') await this.kv.set(row.key, { ...row.value, role });
      }
      return { ok: true, expires };
    }
    if (input.op === 'revoke-invites') {
      for (const row of [...await this.list(`${prefix}invite:`), ...await this.list(`${prefix}named:`)]) await this.kv.del(row.key);
      return { ok: true };
    }
    if (input.op === 'stop') {
      await this.kv.set(`${prefix}meta`, { ...meta, closed: this.now() });
      this.rooms.get(room)?.doc.destroy(); this.rooms.delete(room);
      return { ok: true };
    }
    // Role changes and removal.
    const target = id(input.uuid);
    if (target === meta.owner) fail(400, 'The owner keeps their access.');
    const record = await this.kv.get(`${prefix}member:${target}`);
    if (!record) fail(404, 'Member not found.');
    const role = input.role;
    if (role !== 'removed' && !INVITE_ROLES.includes(role)) fail(400, 'Invalid role.');
    await this.kv.set(`${prefix}member:${target}`, { ...record, role });
    for (const row of await this.list(`${prefix}presence:`)) if (row.value?.user === target) await this.kv.del(row.key);
    return { ok: true };
  }
}
