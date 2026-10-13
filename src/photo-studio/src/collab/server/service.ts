// The room worker: a Puter Worker the document owner deploys to their own
// account. It keeps each shared document's Yjs edit log, memberships,
// invitations, presence tickets and content-addressed tiles in the owner's
// key-value store and files, and checks every request: membership, role
// (viewers cannot commit; commenters can only change comments), comment
// authorship, and the integrity of uploaded tiles.
// The design follows the Whiteboard app's board service in this repository.
import * as Y from 'yjs';
import { canComment, canEdit, canManage, decode, encode, hash, ID, HASH, INVITE_ROLES, keyPair, MAX_UPDATE, SESSION_TTL, sign, type KeyPair } from '../protocol';
import { unpackAsset, MAX_CHUNK } from '../asset-codec';
import { readThreads } from '../ycomments';
import { checkCommentChange, validateComments } from '../comments';

export type Identity = { uuid: string; username: string };
type Meta = { owner: string; name: string; created: number; keys: KeyPair; initial: string[]; closed?: number };
type Member = { uuid: string; username: string; role: string; joined: number; expires?: number | null };
type Invite = { role: string; review: boolean; created: number; expires: number; createdBy: string };
type LogRecord = { user: string; id: string; at: number; update?: string; file?: string };

/** The parts of Puter a worker uses (`me.puter` or a test fake). */
export interface WorkerPuter {
  APIOrigin?: string;
  authToken?: string;
  auth: { getUser(): Promise<{ uuid: string; username: string }> };
  kv: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown, expireAt?: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
    incr(key: string, amount?: number): Promise<number>;
    list(options: { pattern: string; returnValues?: boolean; limit?: number; cursor?: string }): Promise<{ items: (string | { key: string; value: unknown })[]; cursor?: string } | (string | { key: string; value: unknown })[]>;
  };
  fs: {
    write(path: string, data: string, options?: Record<string, unknown>): Promise<unknown>;
    read(path: string): Promise<Blob>;
    stat(path: string): Promise<unknown>;
  };
}

export const INVITE_DAYS = 7;
const DAY = 86_400_000;
const CHECKPOINT_EVERY = 100;
const INLINE_UPDATE = 100_000;
const ROOM_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const ROLES_ALLOWED = new Set(['doc', 'layers', 'assets', 'meta']);

export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const id = (v: unknown) => {
  if (typeof v !== 'string' || !ID.test(v)) fail(400, 'Invalid identifier.');
  return v;
};
const pad = (n: number) => String(n).padStart(12, '0');

export function appUid(token: string | undefined) {
  try {
    const part = token!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(new TextDecoder().decode(decode(part + '==='.slice((part.length + 3) % 4))));
    if (p.app_uid) return p.app_uid as string;
    if (typeof p.au === 'string' && p.au.includes('-')) return p.au;
    const b = decode(p.au.replace(/_/g, '/').replace(/-/g, '+') + '==='.slice((p.au.length + 3) % 4));
    if (b.length !== 16) return null;
    const h = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `app-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    return null;
  }
}

/** The name of the top-level shared type a Yjs type belongs to. */
function rootName(doc: Y.Doc, type: Y.AbstractType<unknown>) {
  let t: Y.AbstractType<unknown> = type;
  while (t._item) t = t._item.parent as Y.AbstractType<unknown>;
  for (const [name, v] of doc.share) if (v === t) return name;
  return '';
}

// `doc` holds only what the log holds (accepted edits): synchronization
// reads it and checkpoints are written from it. `check` is a copy a commit is
// tried on first; it is discarded when it took a refused change.
type Room = { doc: Y.Doc; seq: number; holes: Map<number, number>; loaded: number; check?: Y.Doc };
// Rooms loaded by this worker instance, refreshed from the log on each use.
const ROOMS = new Map<string, Room>();
// Commits in progress per room (per set of loaded rooms), taken one at a time.
const COMMITS = new WeakMap<Map<string, Room>, Map<string, Promise<unknown>>>();

export class RoomService {
  kv: WorkerPuter['kv'];
  fs: WorkerPuter['fs'];
  now: () => number;
  fetcher: typeof fetch;
  constructor(
    public puter: WorkerPuter,
    options: { now?: () => number; fetcher?: typeof fetch; rooms?: Map<string, Room> } = {},
  ) {
    this.kv = puter.kv;
    this.fs = puter.fs;
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? ((...a) => fetch(...a));
    this.rooms = options.rooms ?? ROOMS;
  }
  rooms: Map<string, Room>;
  private accountOwner?: Promise<{ uuid: string; username: string }>;
  owner() {
    this.accountOwner ??= this.puter.auth.getUser();
    return this.accountOwner;
  }
  private path(room: string, name: string) {
    return `photo-studio/shared/${room}/${name}`;
  }
  async readText(path: string) {
    return (await this.fs.read(path)).text();
  }
  async writeText(path: string, text: string) {
    await this.fs.write(path, text, { overwrite: true, dedupeName: false, createMissingParents: true });
  }
  private async list(prefix: string) {
    const out: { key: string; value: unknown }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const res = await this.kv.list({ pattern: prefix, returnValues: true, limit: 1000, ...(cursor ? { cursor } : {}) });
      const items = Array.isArray(res) ? res : res.items;
      for (const it of items) if (typeof it === 'object') out.push(it);
      cursor = Array.isArray(res) ? undefined : res.cursor;
      if (!cursor) break;
    }
    return out;
  }

  // ----- Access -----

  async meta(room: string) {
    const meta = (await this.kv.get(`ps:${room}:meta`)) as Meta | null;
    if (!meta) fail(404, 'This shared document does not exist.');
    if (meta.closed) fail(410, 'The owner stopped sharing this document.');
    return meta;
  }
  async member(room: string, user: Identity) {
    const meta = await this.meta(room);
    const m = (await this.kv.get(`ps:${room}:member:${user.uuid}`)) as Member | null;
    if (!m || m.role === 'removed') fail(403, 'You do not have access to this shared document.');
    if (m.expires && m.expires < this.now()) fail(403, 'Your access to this shared document has expired.');
    return { meta, member: m };
  }
  private async setMember(room: string, m: Member) {
    await this.kv.set(`ps:${room}:member:${m.uuid}`, m);
  }
  /** Admit someone opening the document: an existing member, an invitation
   * link, or an invitation by username. An existing membership is the
   * owner's decision: an invitation never changes its role or its expiry
   * (membership checks then apply as usual), and an expired or revoked link
   * does not stop a current member. */
  async admit(room: string, user: Identity, token: unknown) {
    const meta = await this.meta(room);
    const prior = (await this.kv.get(`ps:${room}:member:${user.uuid}`)) as Member | null;
    if (prior?.role === 'removed') fail(403, 'Your access to this shared document was removed.');
    if (prior) return;
    let role: string | null = null;
    if (typeof token === 'string' && token) {
      if (token.length > 200) fail(400, 'Invalid invitation.');
      const invite = (await this.kv.get(`ps:${room}:invite:${await hash(token)}`)) as Invite | null;
      if (!invite || invite.expires < this.now()) fail(403, 'This invitation has expired or was revoked.');
      role = invite.role;
    } else {
      const named = (await this.kv.get(`ps:${room}:named:${user.username.toLowerCase()}`)) as Invite | null;
      if (named && named.expires >= this.now()) role = named.role;
    }
    if (!role) fail(403, 'Ask the owner for an invitation to this shared document.');
    if (user.uuid === meta.owner) role = 'owner';
    await this.setMember(room, { uuid: user.uuid, username: user.username, role, joined: this.now() });
    await this.notify(room);
  }

  // ----- Document state -----

  private async readUpdate(record: LogRecord) {
    return decode(record.file ? await this.readText(record.file) : record.update);
  }
  async load(room: string, meta: Meta): Promise<Room> {
    let entry = this.rooms.get(room);
    if (!entry) {
      const doc = new Y.Doc();
      const cp = (await this.kv.get(`ps:${room}:cp`)) as { seq: number; path: string } | null;
      if (cp) Y.applyUpdate(doc, decode(await this.readText(cp.path)));
      else Y.applyUpdate(doc, await this.readInitial(room, meta.initial));
      entry = { doc, seq: cp?.seq ?? 0, holes: new Map(), loaded: this.now() };
      this.rooms.set(room, entry);
      if (this.rooms.size > 8) {
        const [oldest] = this.rooms.keys();
        if (oldest !== room) this.drop(oldest!);
      }
    }
    await this.refresh(room, entry);
    return entry;
  }
  private drop(room: string) {
    const entry = this.rooms.get(room);
    entry?.doc.destroy();
    entry?.check?.destroy();
    this.rooms.delete(room);
  }
  /** Run commits of one room one after another. */
  private serial<T>(room: string, fn: () => Promise<T>): Promise<T> {
    let locks = COMMITS.get(this.rooms);
    if (!locks) COMMITS.set(this.rooms, (locks = new Map()));
    const run = (locks.get(room) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    locks.set(room, tail);
    void tail.then(() => {
      if (locks.get(room) === tail) locks.delete(room);
    });
    return run;
  }
  /** The copy a commit is tried on, brought up to the accepted state. */
  private checkCopy(entry: Room) {
    if (!entry.check) {
      entry.check = new Y.Doc();
      Y.applyUpdate(entry.check, Y.encodeStateAsUpdate(entry.doc));
    } else Y.applyUpdate(entry.check, Y.encodeStateAsUpdate(entry.doc, Y.encodeStateVector(entry.check)));
    return entry.check;
  }
  /** Apply log records written since this instance last read the room. */
  async refresh(room: string, entry: Room) {
    const last = Number((await this.kv.get(`ps:${room}:seq`)) ?? 0);
    for (let n = entry.seq + 1; n <= last; n++) {
      const record = (await this.kv.get(`ps:${room}:log:${pad(n)}`)) as LogRecord | null;
      if (!record) {
        // Numbered but not written yet (a commit in progress elsewhere), or
        // never written (a failed commit): skipped once it is old.
        const seen = entry.holes.get(n) ?? this.now();
        entry.holes.set(n, seen);
        if (this.now() - seen < 20_000) break;
        entry.holes.delete(n);
        entry.seq = n;
        continue;
      }
      entry.holes.delete(n);
      Y.applyUpdate(entry.doc, await this.readUpdate(record), 'log');
      entry.seq = n;
    }
  }
  private async readAsset(room: string, h: string) {
    return unpackAsset(await this.readText(this.path(room, `assets/${h}.txt`)), h, MAX_CHUNK);
  }
  /** The initial state: one Yjs update stored as consecutive chunks. */
  private async readInitial(room: string, hashes: string[]) {
    const parts = [];
    for (const h of hashes) parts.push(await this.readAsset(room, h));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  async notify(room: string, seq?: number) {
    await this.kv.set(`ps:${room}:ev:signal`, { nonce: crypto.randomUUID(), ...(seq ? { seq } : {}) }).catch(() => {});
  }
  async events(room: string, user: Identity) {
    const uid = appUid(this.puter.authToken);
    if (!uid) return null;
    if (user.uuid === (await this.owner()).uuid) return { app: uid, key: `ps:${room}:ev:signal` };
    const cache = `ps:${room}:handle:${user.uuid}`;
    let handle = (await this.kv.get(cache)) as string | null;
    if (!handle && this.puter.APIOrigin) {
      try {
        const res = await this.fetcher(`${this.puter.APIOrigin}/events/kv-handles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.puter.authToken}` },
          body: JSON.stringify({ granteeUid: user.uuid, prefix: `ps:${room}:ev:` }),
          signal: AbortSignal.timeout(3000),
        });
        const data = (await res.json()) as { handle?: string };
        if (res.ok && data.handle) {
          handle = data.handle;
          await this.kv.set(cache, handle);
        }
      } catch {
        /* Peer notices and periodic synchronization still deliver edits. */
      }
    }
    return handle ? { handle, key: 'signal' } : null;
  }

  // ----- Requests -----

  async call(user: Identity, input: Record<string, unknown>) {
    if (!user?.uuid) fail(401, 'Sign in with Puter to continue.');
    if (!input || typeof input !== 'object') fail(400, 'Invalid request.');
    const room = id(input.room),
      prefix = `ps:${room}:`;
    const op = input.op;
    if (op === 'create') return this.create(room, user, input);
    // The owner uploads a document's tiles before creating its room.
    if (op === 'asset.put' && !(await this.kv.get(prefix + 'meta'))) {
      if (user.uuid !== (await this.owner()).uuid) fail(404, 'This shared document does not exist.');
      return this.putAssets(room, { role: 'owner' } as Member, input);
    }
    if (op === 'join') await this.admit(room, user, input.token);
    const { meta, member } = await this.member(room, user);
    switch (op) {
      case 'join': {
        const entry = await this.load(room, meta);
        return {
          room,
          name: meta.name,
          role: member.role,
          user: { uuid: user.uuid, username: user.username },
          owner: meta.owner,
          publicKey: meta.keys.publicKey,
          seq: entry.seq,
          serverTime: this.now(),
          events: await this.events(room, user),
        };
      }
      case 'events':
        return { events: await this.events(room, user) };
      case 'sync': {
        const entry = await this.load(room, meta);
        const vector = typeof input.vector === 'string' && input.vector ? decode(input.vector, 1_000_000) : undefined;
        let update: Uint8Array;
        try {
          update = Y.encodeStateAsUpdate(entry.doc, vector);
        } catch {
          fail(400, 'Invalid state vector.');
        }
        return { update: encode(update), seq: entry.seq, role: member.role, serverTime: this.now() };
      }
      case 'commit':
        return this.serial(room, () => this.commit(room, meta, user, member, input));
      case 'asset.put':
        return this.putAssets(room, member, input);
      case 'asset.get':
        return this.getAssets(room, input);
      case 'presence':
        return this.presence(room, meta, user, member, input);
      case 'leave': {
        const key = prefix + 'presence:' + id(input.session);
        const ticket = (await this.kv.get(key)) as { user: string } | null;
        if (ticket?.user === user.uuid) {
          await this.kv.del(key);
          await this.notify(room);
        }
        return { ok: true };
      }
      case 'members': {
        const rows = await this.list(prefix + 'member:');
        const members = rows
          .map((r) => r.value as Member)
          .filter((m) => m.role !== 'removed')
          .map((m) => ({ uuid: m.uuid, username: m.username, role: m.role, ...(canManage(member.role) ? { joined: m.joined, expires: m.expires ?? null } : {}) }));
        if (!canManage(member.role)) return { members };
        const named = (await this.list(prefix + 'named:')).map((r) => ({ username: r.key.slice((prefix + 'named:').length), ...(r.value as Invite) })).filter((n) => n.expires >= this.now());
        const invites = (await this.list(prefix + 'invite:')).map((r) => r.value as Invite).filter((i) => i.expires >= this.now());
        return { members, named: named.map((n) => ({ username: n.username, role: n.role, expires: n.expires })), invites: invites.length };
      }
      case 'invite':
      case 'invite-user':
      case 'revoke-invites':
      case 'role':
      case 'stop':
        if (!canManage(member.role)) fail(403, 'Only the owner can manage access.');
        return this.manage(room, meta, user, input);
    }
    fail(400, 'Unknown request.');
  }

  private async create(room: string, user: Identity, input: Record<string, unknown>) {
    if (user.uuid !== (await this.owner()).uuid) fail(403, 'Only the owner of this collaboration server can share documents on it.');
    const prefix = `ps:${room}:`;
    const existing = (await this.kv.get(prefix + 'meta')) as Meta | null;
    if (existing) {
      if (existing.owner !== user.uuid) fail(403, 'Only the owner can finish sharing this document.');
      return { room };
    }
    const initial = Array.isArray(input.initial) ? input.initial : [];
    if (!initial.length || initial.length > 64 || !initial.every((h) => typeof h === 'string' && HASH.test(h))) fail(400, 'Invalid initial document.');
    // The initial state must load as a Yjs document whose comments are valid.
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, await this.readInitial(room, initial as string[]));
      if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Incomplete');
      validateComments(readThreads(doc));
    } catch {
      fail(422, 'This document could not be shared.');
    } finally {
      doc.destroy();
    }
    const meta: Meta = {
      owner: user.uuid,
      name: typeof input.name === 'string' ? input.name.slice(0, 200) : 'Untitled',
      created: this.now(),
      keys: await keyPair(),
      initial: initial as string[],
    };
    await this.kv.set(prefix + 'meta', meta);
    await this.setMember(room, { uuid: user.uuid, username: user.username, role: 'owner', joined: this.now() });
    return { room };
  }

  private async commit(room: string, meta: Meta, user: Identity, member: Member, input: Record<string, unknown>) {
    if (!canComment(member.role)) fail(403, 'You can only view this shared document.');
    if (typeof input.update === 'string' && input.update.length > MAX_UPDATE) fail(413, 'This change is too large to save.');
    let update: Uint8Array;
    try {
      update = decode(input.update, MAX_UPDATE);
    } catch {
      fail(400, 'Invalid change.');
    }
    const digest = await hash(update);
    if (input.id !== digest) fail(400, 'The change does not match its checksum.');
    const entry = await this.load(room, meta);
    // The change is tried on a copy; the loaded document (what others read and
    // checkpoints are made of) receives it only once it is accepted and logged.
    const doc = this.checkCopy(entry);
    const before = readThreads(doc);
    const roots = new Set<string>();
    let changed = false;
    const watch = (tr: Y.Transaction) => {
      for (const type of tr.changed.keys()) roots.add(rootName(doc, type as Y.AbstractType<unknown>));
      if (tr.changed.size || tr.deleteSet.clients.size) changed = true;
    };
    const reject = (status: number, message: string): never => {
      // The copy holds the refused change: it is made again for the next commit.
      doc.destroy();
      if (entry.check === doc) entry.check = undefined;
      fail(status, message);
    };
    doc.on('afterTransaction', watch);
    try {
      Y.applyUpdate(doc, update, 'commit');
    } catch {
      reject(400, 'Invalid change.');
    } finally {
      doc.off('afterTransaction', watch);
    }
    if (doc.store.pendingStructs || doc.store.pendingDs) reject(409, 'This change builds on edits the server has not received. Synchronize and try again.');
    for (const r of roots) {
      if (r === 'comments') continue;
      if (!ROLES_ALLOWED.has(r)) reject(400, 'Invalid change.');
      if (!canEdit(member.role)) reject(403, 'You can comment on this shared document but not change it.');
    }
    if (roots.has('comments')) {
      let after;
      try {
        after = readThreads(doc);
      } catch {
        reject(400, 'Invalid comment.');
      }
      const problem = checkCommentChange(before, after!, user, member.role);
      if (problem) reject(403, problem);
    }
    const receipt = await sign(meta.keys.privateKey, { room, id: digest, user: user.uuid });
    if (!changed) return { receipt, seq: entry.seq, id: digest };
    try {
      const seq = await this.kv.incr(`ps:${room}:seq`);
      const record: LogRecord = { user: user.uuid, id: digest, at: this.now() };
      const text = input.update as string;
      if (text.length > INLINE_UPDATE) {
        record.file = this.path(room, `log/${pad(seq)}-${digest.slice(0, 16)}.txt`);
        await this.writeText(record.file, text);
      } else record.update = text;
      await this.kv.set(`ps:${room}:log:${pad(seq)}`, record);
      Y.applyUpdate(entry.doc, update, 'log');
      // The loaded copy now matches the log up to here (when nothing is missing before it).
      if (entry.seq === seq - 1) entry.seq = seq;
      if (seq % CHECKPOINT_EVERY === 0 && entry.seq === seq) {
        const path = this.path(room, `cp-${pad(seq)}.txt`);
        await this.writeText(path, encode(Y.encodeStateAsUpdate(entry.doc)));
        await this.kv.set(`ps:${room}:cp`, { seq, path });
      }
      await this.notify(room, seq);
      return { receipt, seq, id: digest };
    } catch (error) {
      this.drop(room);
      throw error;
    }
  }

  private async putAssets(room: string, member: Member, input: Record<string, unknown>) {
    if (!canEdit(member.role)) fail(403, canComment(member.role) ? 'You can comment on this shared document but not change it.' : 'You can only view this shared document.');
    const list = input.assets;
    if (!Array.isArray(list) || list.length > 256) fail(400, 'Invalid assets.');
    let total = 0;
    for (const a of list as { hash: string; data: string }[]) {
      if (!a || typeof a.hash !== 'string' || !HASH.test(a.hash) || typeof a.data !== 'string') fail(400, 'Invalid asset.');
      total += a.data.length;
    }
    if (total > 16_000_000) fail(413, 'Send fewer assets at once.');
    const used = `ps:${room}:assetbytes`;
    for (const a of list as { hash: string; data: string }[]) {
      const path = this.path(room, `assets/${a.hash}.txt`);
      // Content-addressed: a stored asset is never replaced.
      if (await this.fs.stat(path).then(() => true, () => false)) continue;
      try {
        await unpackAsset(a.data, a.hash);
      } catch {
        fail(400, 'An uploaded tile does not match its checksum.');
      }
      if ((await this.kv.incr(used, a.data.length)) > ROOM_ASSET_BYTES) {
        await this.kv.incr(used, -a.data.length).catch(() => {});
        fail(413, 'This shared document has reached its 2 GB storage limit.');
      }
      await this.writeText(path, a.data);
    }
    return { ok: true };
  }
  private async getAssets(room: string, input: Record<string, unknown>) {
    const list = input.hashes;
    if (!Array.isArray(list) || list.length > 64 || !list.every((h) => typeof h === 'string' && HASH.test(h))) fail(400, 'Invalid assets.');
    const assets: Record<string, string> = {};
    let total = 0;
    for (const h of list as string[]) {
      if (total > 12_000_000) break;
      try {
        const data = await this.readText(this.path(room, `assets/${h}.txt`));
        assets[h] = data;
        total += data.length;
      } catch {
        /* Missing: the client asks again later. */
      }
    }
    return { assets };
  }

  private async presence(room: string, meta: Meta, user: Identity, member: Member, input: Record<string, unknown>) {
    const session = id(input.session);
    const key = (input.publicKey ?? {}) as JsonWebKey;
    const coordinate = /^[A-Za-z0-9_-]{43}$/;
    if (key.kty !== 'EC' || key.crv !== 'P-256' || key.d || !coordinate.test(key.x ?? '') || !coordinate.test(key.y ?? '')) fail(400, 'Invalid peer key.');
    const prefix = `ps:${room}:presence:`;
    const rows = (await this.list(prefix)).map((r) => r.value as { session: string; user: string; expires: number } & Record<string, unknown>).filter((t) => t.expires > this.now());
    const old = rows.find((t) => t.session === session);
    if (old && old.user !== user.uuid) fail(409, 'Session belongs to another participant.');
    const others = rows.filter((t) => t.session !== session);
    if (!old && (others.length >= 256 || others.filter((t) => t.user === user.uuid).length >= 16)) fail(429, 'This shared document has reached its participant limit.');
    const ticket = {
      room,
      session,
      user: user.uuid,
      username: String(user.username || 'Participant').slice(0, 80),
      role: member.role,
      publicKey: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y },
      expires: this.now() + SESSION_TTL,
      invite: typeof input.invite === 'string' ? input.invite.slice(0, 100) : null,
    };
    await this.kv.set(prefix + session, ticket, Math.floor(ticket.expires / 1000));
    if (!old || old.invite !== ticket.invite) await this.notify(room);
    const roster = [...others, ticket].sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
    return { ticket, signature: await sign(meta.keys.privateKey, ticket), roster, role: member.role, serverTime: this.now() };
  }

  private async manage(room: string, meta: Meta, user: Identity, input: Record<string, unknown>) {
    const prefix = `ps:${room}:`;
    const days = Number.isFinite(input.days) ? Math.min(30, Math.max(1, Math.round(input.days as number))) : INVITE_DAYS;
    if (input.op === 'invite') {
      const role = (input.role ?? 'editor') as string;
      if (!INVITE_ROLES.includes(role as never)) fail(400, 'Choose a role an invitation can give.');
      const review = input.review === true;
      if (review && role === 'editor') fail(400, 'Review links give comment or view access.');
      const token = crypto.randomUUID() + crypto.randomUUID();
      const expires = this.now() + days * DAY;
      await this.kv.set(prefix + 'invite:' + (await hash(token)), { role, review, created: this.now(), expires, createdBy: user.uuid } satisfies Invite, Math.floor(expires / 1000));
      return { token, expires };
    }
    if (input.op === 'invite-user') {
      const name = typeof input.username === 'string' ? input.username.trim().replace(/^@/, '') : '';
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) fail(400, 'Enter a Puter username.');
      const role = (input.role ?? 'editor') as string;
      if (!INVITE_ROLES.includes(role as never)) fail(400, 'Choose a role an invitation can give.');
      const expires = this.now() + days * DAY;
      await this.kv.set(prefix + 'named:' + name.toLowerCase(), { role, review: false, created: this.now(), expires, createdBy: user.uuid } satisfies Invite, Math.floor(expires / 1000));
      // Someone already a member gets the role at once.
      for (const row of await this.list(prefix + 'member:')) {
        const m = row.value as Member;
        if (m.username.toLowerCase() === name.toLowerCase() && m.role !== 'owner') await this.setMember(room, { ...m, role: role as string });
      }
      await this.notify(room);
      return { ok: true, expires };
    }
    if (input.op === 'revoke-invites') {
      for (const row of [...(await this.list(prefix + 'invite:')), ...(await this.list(prefix + 'named:'))]) await this.kv.del(row.key);
      return { ok: true };
    }
    if (input.op === 'stop') {
      await this.kv.set(prefix + 'meta', { ...meta, closed: this.now() });
      this.drop(room);
      await this.notify(room);
      return { ok: true };
    }
    // Role changes, removal and access expiry.
    const target = id(input.uuid);
    if (target === meta.owner) fail(400, 'The owner keeps their access.');
    const record = (await this.kv.get(prefix + 'member:' + target)) as Member | null;
    if (!record) fail(404, 'Member not found.');
    const role = input.role === undefined ? record.role : input.role;
    if (role !== 'removed' && !INVITE_ROLES.includes(role as never)) fail(400, 'Invalid role.');
    const expires = input.expires === undefined ? record.expires : input.expires === null ? null : Number(input.expires);
    if (expires !== null && expires !== undefined && !(Number.isFinite(expires) && expires > 0)) fail(400, 'Invalid expiry.');
    await this.setMember(room, { ...record, role: role as string, expires: expires ?? null });
    // Their live session ends; they check in again with the new role.
    for (const row of await this.list(prefix + 'presence:')) if ((row.value as { user: string }).user === target) await this.kv.del(row.key);
    if (role === 'removed') await this.kv.del(prefix + 'handle:' + target).catch(() => {});
    await this.notify(room);
    return { ok: true };
  }
}
