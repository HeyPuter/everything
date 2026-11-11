/**
 * DocService: the collaboration server for shared Vector Studio documents,
 * running as a Puter worker in the owner's account. Everything is stored
 * with the owner's resources (`me.puter`): KV for small records and files
 * for document snapshots and large edits.
 *
 *   vs:<room>:meta              owner, name, room signing keys, closed time
 *   vs:<room>:member:<uuid>     role (owner, editor, commenter, viewer, removed)
 *   vs:<room>:named:<username>  role for a Puter user invited by name
 *   vs:<room>:invite:<hash>     link invitation: role, review link, expiry
 *   vs:<room>:seq               the last edit's sequence number (atomic counter)
 *   vs:<room>:log:<seq>         one edit batch, or a file reference when large
 *   vs:<room>:done:<batch>      sequence of an accepted batch (retries are not applied twice)
 *   vs:<room>:cp                latest checkpoint: { seq, path }
 *   vs:<room>:presence:<sess>   a participant's session: ticket, cursor, selection, view
 *
 * Edits are batches of per-node changes (src/features/collab/ops.js). The
 * sequence number orders them; every client folds them in that order.
 * Viewers cannot commit; commenters may only add comments; comment
 * authorship is checked here, whatever the client shows.
 */
import { ID, INVITE_ROLES, SESSION_TTL, canComment, canEdit, canManage, hash, keyPair, sign } from '../src/features/collab/protocol.js';
import { applyBatch, editsContent, safeBatch, stateFromJSON, stateToJSON, validateBatch } from '../src/features/collab/ops.js';
import { checkCommentOps } from '../src/features/collab/comments.js';

const DAY = 86_400_000;
const INVITE_DAYS = 30;
const CHECKPOINT_EVERY = 200;
const SYNC_PAGE = 200;
const RESET_AFTER = 1000;
const INLINE_RECORD = 60_000;
const MAX_PRESENCE = 64;

// Recent document states per room, so commits and joins need not replay the log.
const STATES = new Map();
const KEEP_STATES = 4;

export const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};

const roomId = (v) => {
  if (typeof v !== 'string' || !ID.test(v)) fail(400, 'Invalid document id.');
  return v;
};

const usernameKey = (v) => {
  const s = String(v || '')
    .trim()
    .replace(/^@/, '');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(s)) fail(400, 'Enter a Puter username.');
  return s.toLowerCase();
};

const bytes = (value) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;

export class DocService {
  constructor(puter, { now = () => Date.now() } = {}) {
    this.puter = puter;
    this.kv = puter.kv;
    this.now = now;
  }

  async owner() {
    if (!this.ownerPromise) this.ownerPromise = this.puter.auth.getUser();
    return this.ownerPromise;
  }

  async readFile(path) {
    return (await this.puter.fs.read(path)).text();
  }

  async writeFile(path, text) {
    await this.puter.fs.write(path, text, { overwrite: true, dedupeName: false, createMissingParents: true });
  }

  /** Several keys in one request, as Puter counts them. */
  async getMany(keys) {
    if (!keys.length) return [];
    if (keys.length === 1) return [await this.kv.get(keys[0])];
    const out = await this.kv.get(keys);
    return Array.isArray(out) ? out : Promise.all(keys.map((k) => this.kv.get(k)));
  }

  async list(prefix) {
    const rows = [];
    let cursor;
    do {
      const page = await this.kv.list({ pattern: `${prefix}*`, returnValues: true, limit: 1000, ...(cursor ? { cursor } : {}) });
      const items = Array.isArray(page) ? page : page?.items || [];
      rows.push(...items);
      cursor = Array.isArray(page) ? null : page?.cursor;
    } while (cursor);
    return rows;
  }

  async call(user, input) {
    if (!user?.uuid) fail(401, 'Sign in with Puter to continue.');
    if (!input || typeof input !== 'object') fail(400, 'Invalid request.');
    const op = input.op;
    if (op === 'create') return this.create(user, input);
    const room = roomId(input.room);
    if (op === 'join') return this.join(room, user, input);
    const { meta, member } = await this.access(room, user);
    switch (op) {
      case 'sync':
        return this.sync(room, member, input);
      case 'commit':
        return this.commit(room, user, member, input);
      case 'presence':
        return this.presence(room, user, member, meta, input);
      case 'leave':
        return this.leave(room, user, input);
      case 'members':
        return this.members(room, member, meta);
      default:
        break;
    }
    if (!canManage(member.role)) fail(403, 'Only the owner can manage who has access.');
    switch (op) {
      case 'invite':
        return this.invite(room, user, input);
      case 'invite-user':
        return this.inviteUser(room, user, input);
      case 'uninvite-user':
        await this.kv.del(`vs:${room}:named:${usernameKey(input.username)}`);
        return { ok: true };
      case 'role':
        return this.setRole(room, meta, input);
      case 'revoke-invites':
        for (const row of await this.list(`vs:${room}:invite:`)) await this.kv.del(row.key);
        return { ok: true };
      case 'stop':
        return this.stop(room, meta);
      default:
        fail(400, 'Unknown operation.');
    }
    return null;
  }

  // ---- rooms ----

  async create(user, input) {
    const owner = await this.owner();
    if (owner?.uuid !== user.uuid) fail(403, 'Only the server owner can share documents here.');
    const room = roomId(input.room);
    const prefix = `vs:${room}:`;
    if (await this.kv.get(prefix + 'meta')) fail(409, 'This document is already shared.');
    const state = input.state;
    if (!state || typeof state !== 'object' || !state.nodes?.root) fail(422, 'This document could not be shared.');
    const path = `collab/rooms/${room}/cp-0.json`;
    await this.writeFile(path, JSON.stringify({ seq: 0, state }));
    await this.kv.set(prefix + 'cp', { seq: 0, path });
    await this.kv.set(prefix + 'member:' + user.uuid, { uuid: user.uuid, username: user.username, role: 'owner', joined: this.now() });
    await this.kv.set(prefix + 'meta', { owner: user.uuid, ownerName: user.username, name: String(input.name || 'Untitled').slice(0, 200), created: this.now(), keys: await keyPair() }, { disableSharing: true });
    return { room };
  }

  /** The caller's membership; throws when they have no access. */
  async access(room, user) {
    const prefix = `vs:${room}:`;
    const [meta, member] = await this.getMany([prefix + 'meta', prefix + 'member:' + user.uuid]);
    if (!meta) fail(404, 'This shared document no longer exists.');
    if (meta.closed) fail(410, 'The owner stopped sharing this document.');
    if (!member || member.role === 'removed') fail(403, 'You no longer have access to this document.');
    return { meta, member };
  }

  async join(room, user, input) {
    const prefix = `vs:${room}:`;
    const [meta, prior, named] = await this.getMany([prefix + 'meta', prefix + 'member:' + user.uuid, prefix + 'named:' + String(user.username || '').toLowerCase()]);
    if (!meta) fail(404, 'This shared document no longer exists.');
    if (meta.closed) fail(410, 'The owner stopped sharing this document.');
    let member = prior;
    if (prior?.role === 'removed' && !named) fail(403, 'Your access to this document was removed.');
    if (!member || member.role === 'removed') {
      let role = null;
      let review = false;
      if (named && INVITE_ROLES.includes(named.role)) role = named.role;
      if (typeof input.invite === 'string' && input.invite.length <= 200) {
        const invite = await this.kv.get(prefix + 'invite:' + (await hash(input.invite)));
        if (!invite || invite.expires < this.now()) {
          if (!role) fail(403, 'This invitation has expired or was withdrawn.');
        } else if (!role || INVITE_ROLES.indexOf(invite.role) < INVITE_ROLES.indexOf(role)) {
          role = invite.role;
          review = invite.review === true;
        }
      }
      if (!role) fail(403, 'You do not have access to this document. Ask its owner to invite you.');
      member = { uuid: user.uuid, username: user.username, role, joined: this.now(), ...(review ? { review: true } : {}) };
      await this.kv.set(prefix + 'member:' + user.uuid, member);
    } else if (member.username !== user.username) {
      member = { ...member, username: user.username };
      await this.kv.set(prefix + 'member:' + user.uuid, member);
    }
    const { seq, state } = await this.load(room);
    return {
      room,
      role: member.role,
      review: member.review === true,
      owner: { uuid: meta.owner, username: meta.ownerName },
      name: meta.name,
      publicKey: meta.keys.publicKey,
      seq,
      state: stateToJSON(state),
      serverTime: this.now(),
    };
  }

  async stop(room, meta) {
    const prefix = `vs:${room}:`;
    await this.kv.set(prefix + 'meta', { ...meta, closed: this.now() }, { disableSharing: true });
    for (const row of [...(await this.list(prefix + 'invite:')), ...(await this.list(prefix + 'named:')), ...(await this.list(prefix + 'presence:'))]) await this.kv.del(row.key);
    STATES.delete(room);
    return { ok: true };
  }

  // ---- edits ----

  async record(room, n) {
    const row = await this.kv.get(`vs:${room}:log:${n}`);
    return this.hydrate(row);
  }

  async hydrate(row) {
    if (!row || !row.file) return row;
    return { ...row, batch: JSON.parse(await this.readFile(row.file)), file: undefined };
  }

  /** Records first..last (inclusive), stopping before the first missing one. */
  async records(room, first, last) {
    const out = [];
    for (let n = first; n <= last; n += 100) {
      const keys = [];
      for (let k = n; k <= Math.min(last, n + 99); k++) keys.push(`vs:${room}:log:${k}`);
      const rows = await this.getMany(keys);
      for (const row of rows) {
        if (!row) return { records: out, hole: first + out.length };
        out.push(await this.hydrate(row));
      }
    }
    return { records: out, hole: null };
  }

  /** The current document state: the checkpoint plus every later edit. */
  async load(room) {
    const prefix = `vs:${room}:`;
    const head = Number(await this.kv.get(prefix + 'seq')) || 0;
    let entry = STATES.get(room);
    if (!entry || entry.seq > head) {
      const cp = await this.kv.get(prefix + 'cp');
      if (!cp) fail(404, 'This shared document no longer exists.');
      const data = JSON.parse(await this.readFile(cp.path));
      entry = { seq: data.seq, state: stateFromJSON(data.state), cpSeq: data.seq };
    }
    if (entry.seq < head) {
      const { records } = await this.records(room, entry.seq + 1, head);
      for (const r of records) {
        // Another request may have brought this copy forward meanwhile.
        if (r.seq <= entry.seq) continue;
        if (r.batch) applyBatch(entry.state, safeBatch(r.batch));
        entry.seq = r.seq;
      }
    }
    STATES.delete(room);
    STATES.set(room, entry);
    if (STATES.size > KEEP_STATES) STATES.delete(STATES.keys().next().value);
    return entry;
  }

  async sync(room, member, input) {
    const prefix = `vs:${room}:`;
    const since = Number.isSafeInteger(input.since) && input.since >= 0 ? input.since : 0;
    const head = Number(await this.kv.get(prefix + 'seq')) || 0;
    const base = { head, role: member.role, serverTime: this.now() };
    if (since >= head) return { ...base, records: [] };
    if (head - since > RESET_AFTER) return { ...base, reset: true, records: [] };
    // A sequence number taken by a commit that never finished writing is
    // skipped once a client has waited for it long enough.
    if (Number.isSafeInteger(input.skip) && input.skip === since + 1 && !(await this.kv.get(`${prefix}log:${input.skip}`))) {
      await this.kv.set(`${prefix}log:${input.skip}`, { seq: input.skip, skipped: true, time: this.now() });
    }
    const { records, hole } = await this.records(room, since + 1, Math.min(head, since + SYNC_PAGE));
    return { ...base, records, hole, more: since + records.length < head && hole === null };
  }

  async commit(room, user, member, input) {
    const prefix = `vs:${room}:`;
    if (!canComment(member.role)) fail(403, 'This document is view only for you.');
    const batch = validateBatch(input.batch);
    if (bytes(batch) > 16_000_000) fail(413, 'This change is too large to share.');
    if (editsContent(batch) && !canEdit(member.role)) fail(403, 'You can comment on this document but not edit it.');
    const done = await this.kv.get(prefix + 'done:' + batch.id);
    if (Number.isSafeInteger(done)) return { seq: done, duplicate: true };
    if (batch.comments?.length) {
      const { state } = await this.load(room);
      checkCommentOps(state.comments, batch.comments, user, member.role);
    }
    const seq = await this.kv.incr(prefix + 'seq');
    const session = typeof input.session === 'string' ? input.session.slice(0, 100) : null;
    let row = { seq, batch, by: { uuid: user.uuid, username: user.username }, session, time: this.now() };
    const text = JSON.stringify(batch);
    if (text.length > INLINE_RECORD) {
      const path = `collab/rooms/${room}/r-${seq}.json`;
      await this.writeFile(path, text);
      row = { ...row, batch: undefined, file: path };
    }
    await this.kv.set(prefix + 'log:' + seq, row);
    await this.kv.set(prefix + 'done:' + batch.id, seq, Math.floor((this.now() + 7 * DAY) / 1000));
    const entry = STATES.get(room);
    if (entry && entry.seq === seq - 1) {
      applyBatch(entry.state, batch);
      entry.seq = seq;
    }
    await this.checkpoint(room, seq).catch(() => {});
    return { seq };
  }

  /** Write a new checkpoint every CHECKPOINT_EVERY edits, so joining stays quick. */
  async checkpoint(room, seq) {
    if (seq % CHECKPOINT_EVERY !== 0) return;
    const entry = await this.load(room);
    if (entry.seq < seq) return;
    const path = `collab/rooms/${room}/cp-${entry.seq}.json`;
    await this.writeFile(path, JSON.stringify({ seq: entry.seq, state: stateToJSON(entry.state) }));
    await this.kv.set(`vs:${room}:cp`, { seq: entry.seq, path });
  }

  // ---- presence ----

  async presence(room, user, member, meta, input) {
    const prefix = `vs:${room}:`;
    const session = roomId(input.session);
    const coordinate = /^[A-Za-z0-9_-]{43}$/;
    const pk = input.publicKey;
    if (pk?.kty !== 'EC' || pk.crv !== 'P-256' || pk.d || !coordinate.test(pk.x) || !coordinate.test(pk.y)) fail(400, 'Invalid peer key.');
    const key = prefix + 'presence:' + session;
    const rows = (await this.list(prefix + 'presence:')).map((r) => r.value).filter((p) => p && p.expires > this.now());
    const old = rows.find((p) => p.session === session);
    if (old && old.user !== user.uuid) fail(409, 'Session belongs to another participant.');
    if (!old && rows.length >= MAX_PRESENCE) fail(429, 'This document has reached its participant limit.');
    const ticket = {
      room,
      session,
      user: user.uuid,
      username: String(user.username || 'Participant').slice(0, 80),
      role: member.role,
      publicKey: { kty: 'EC', crv: 'P-256', x: pk.x, y: pk.y },
      expires: this.now() + SESSION_TTL,
    };
    const entry = { ...ticket, invite: typeof input.invite === 'string' ? input.invite.slice(0, 100) : null, state: cleanState(input.state), review: member.review === true };
    await this.kv.set(key, entry, Math.floor(ticket.expires / 1000));
    const roster = [...rows.filter((p) => p.session !== session), entry].sort((a, b) => (a.session < b.session ? -1 : 1));
    return { ticket, signature: await sign(meta.keys.privateKey, ticket), roster, role: member.role, serverTime: this.now() };
  }

  async leave(room, user, input) {
    const key = `vs:${room}:presence:${roomId(input.session)}`;
    const row = await this.kv.get(key);
    if (row?.user === user.uuid) await this.kv.del(key);
    return { ok: true };
  }

  // ---- access ----

  async members(room, member, meta) {
    const prefix = `vs:${room}:`;
    const members = (await this.list(prefix + 'member:'))
      .map((r) => r.value)
      .filter((m) => m && m.role !== 'removed')
      .map(({ uuid, username, role, review }) => ({ uuid, username, role, ...(review ? { review: true } : {}) }));
    const out = { members, owner: { uuid: meta.owner, username: meta.ownerName } };
    if (canManage(member.role)) {
      out.named = (await this.list(prefix + 'named:')).map((r) => r.value).filter(Boolean);
      out.invites = (await this.list(prefix + 'invite:')).map((r) => r.value).filter((v) => v && v.expires > this.now()).map(({ role, review, expires }) => ({ role, review: !!review, expires }));
    }
    return out;
  }

  async invite(room, user, input) {
    const role = input.role ?? 'editor';
    if (!INVITE_ROLES.includes(role)) fail(400, 'Choose a role an invitation can give.');
    const review = input.review === true;
    if (review && role !== 'commenter') fail(400, 'Review links let people comment.');
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const expires = this.now() + INVITE_DAYS * DAY;
    await this.kv.set(`vs:${room}:invite:${await hash(token)}`, { role, review, created: this.now(), expires, by: user.uuid }, Math.floor(expires / 1000));
    return { token, expires };
  }

  async inviteUser(room, user, input) {
    const prefix = `vs:${room}:`;
    const name = usernameKey(input.username);
    const role = input.role ?? 'editor';
    if (!INVITE_ROLES.includes(role)) fail(400, 'Choose a role an invitation can give.');
    if (name === String(user.username || '').toLowerCase()) fail(400, 'You already own this document.');
    // Someone already a member gets the new role at once.
    const existing = (await this.list(prefix + 'member:')).map((r) => r.value).find((m) => m && String(m.username).toLowerCase() === name);
    if (existing?.role === 'owner') fail(400, 'That person owns this document.');
    if (existing) await this.kv.set(prefix + 'member:' + existing.uuid, { ...existing, role });
    await this.kv.set(prefix + 'named:' + name, { username: String(input.username).trim().replace(/^@/, ''), role, by: user.uuid, created: this.now() });
    return { ok: true, member: Boolean(existing) };
  }

  async setRole(room, meta, input) {
    const prefix = `vs:${room}:`;
    const uuid = roomId(input.uuid);
    if (uuid === meta.owner || ![...INVITE_ROLES, 'removed'].includes(input.role)) fail(400, 'Invalid role change.');
    const record = await this.kv.get(prefix + 'member:' + uuid);
    if (!record) fail(404, 'That person is not a member.');
    await this.kv.set(prefix + 'member:' + uuid, { ...record, role: input.role, review: input.role === 'commenter' ? record.review : undefined });
    if (input.role === 'removed') await this.kv.del(prefix + 'named:' + String(record.username).toLowerCase());
    return { ok: true };
  }
}

/** Presence state a client may publish: cursor, selection, view, follow target. */
export function cleanState(s) {
  if (!s || typeof s !== 'object') return {};
  const num = (v) => (Number.isFinite(v) ? v : null);
  const out = {};
  if (s.cursor && num(s.cursor.x) !== null && num(s.cursor.y) !== null) out.cursor = { x: s.cursor.x, y: s.cursor.y };
  if (Array.isArray(s.selection)) out.selection = s.selection.filter((id) => typeof id === 'string' && ID.test(id)).slice(0, 100);
  if (s.view && ['x', 'y', 'w', 'h'].every((k) => num(s.view[k]) !== null)) out.view = { x: s.view.x, y: s.view.y, w: s.view.w, h: s.view.h };
  if (typeof s.following === 'string' && ID.test(s.following)) out.following = s.following;
  if (s.commenting === true) out.commenting = true;
  return out;
}
