/**
 * CollabSession: one open shared document. Keeps the editor's document in
 * step with the server and the other participants.
 *
 *   base     the confirmed state: every batch the server has ordered, up
 *            to `seq`, folded with applyBatch()
 *   pending  this browser's batches the server has not ordered yet, in the
 *            order they were made; the document always shows base plus
 *            pending replayed on top (so local edits never wait)
 *
 * Local transactions (including Undo and Redo) become batches; batches
 * from others arrive by synchronizing and are applied with
 * doc.applyRemote(), so they never enter this browser's undo history.
 * When a batch arrives while a local gesture is still open, it is applied
 * as soon as the gesture commits. Pending batches and the last confirmed
 * state are kept on the device (outbox.js), so edits made offline, or
 * before a reload, are sent once the server is reachable again.
 *
 * Presence (cursors, selections, views, follow) travels over direct peer
 * links when available (peers.js) and with periodic server check-ins.
 */
import { Emitter } from '../../lib/emitter.js';
import { uid } from '../../lib/ids.js';
import { Overlay, applyBatch, applyNodeOps, diffNodes, safeBatch, same, stateFromJSON, stateToJSON } from './ops.js';
import { applyCommentOps } from './comments.js';
import { canComment, canEdit, colorFor, keyPair } from './protocol.js';
import { PeerMesh } from './peers.js';
import { outboxKey } from './outbox.js';

const SYNC_MS = 2500;
const SYNC_HIDDEN_MS = 15000;
const PRESENCE_MS = 15000;
const PRESENCE_FALLBACK_MS = 3000;
const PEER_PRESENCE_MS = 50;
const MERGE_MS = 400;
const HOLE_MS = 20000;
const STALE_PRESENCE_MS = 45000;

const REFUSED = new Set([400, 403, 409, 413, 422]);

export class CollabSession extends Emitter {
  /**
   * transport: { call(input) } sends one request to the document's server.
   * user: { uuid, username } of this browser's account.
   */
  constructor({ transport, server, room, user, puter = null, outbox = null, timers = true }) {
    super();
    this.transport = transport;
    this.server = server;
    this.room = room;
    this.user = user;
    this.puter = puter;
    this.outbox = outbox;
    this.timers = timers;
    this.sessionId = uid('ss').replace(/[^A-Za-z0-9_-]/g, '');
    this.base = null;
    this.seq = 0;
    this.pending = [];
    this.role = 'viewer';
    this.review = false;
    this.status = 'connecting';
    this.closed = false;
    this.doc = null;
    this.editor = null;
    this.others = new Map(); // session -> participant
    this.localState = {};
    this.dirtyIds = new Set();
    this.commentsDirty = false;
    this.deferred = false;
    this.backoff = 0;
  }

  get canEdit() {
    return canEdit(this.role);
  }

  get canComment() {
    return canComment(this.role);
  }

  get key() {
    return outboxKey(this.server, this.room, this.user?.uuid);
  }

  // ---- joining ----

  /**
   * Join the room: returns { doc data, name } for building the document.
   * Falls back to this device's copy when the server cannot be reached.
   */
  async join(invite = null) {
    let res;
    try {
      res = await this.transport.call({ op: 'join', room: this.room, ...(invite ? { invite } : {}) });
    } catch (err) {
      const saved = err.offline ? await this.outbox?.get(this.key) : null;
      if (!saved?.state) throw err;
      this.#adopt({ seq: saved.seq, state: saved.state, role: saved.role, review: saved.review, owner: saved.owner, publicKey: saved.publicKey });
      this.pending = saved.pending || [];
      this.setStatus('offline');
      return this.#data();
    }
    this.#adopt(res);
    const saved = await this.outbox?.get(this.key).catch(() => null);
    // Edits not confirmed before the last session ended are sent now; ones
    // the server already ordered are part of the state just received.
    if (saved?.pending?.length) this.pending = saved.pending.filter((b) => !(b.seq && b.seq <= this.seq));
    this.setStatus('live');
    return this.#data();
  }

  #adopt(res) {
    this.base = stateFromJSON(res.state);
    this.seq = res.seq || 0;
    this.role = res.role || 'viewer';
    this.review = Boolean(res.review);
    this.owner = res.owner || null;
    this.roomKey = res.publicKey || null;
    this.joinInfo = res;
  }

  /** Document data: the confirmed state with pending batches replayed. */
  #data() {
    const state = { nodes: new Overlay(this.base.nodes), assets: new Map(this.base.assets), comments: this.base.comments };
    for (const b of this.pending) applyBatch(state, b);
    const nodes = {};
    for (const [id, n] of this.base.nodes) nodes[id] = n;
    for (const [id, n] of state.nodes.own) {
      if (n === undefined) delete nodes[id];
      else nodes[id] = n;
    }
    return { nodes, assets: Object.fromEntries(state.assets), comments: state.comments };
  }

  /** Create the room from an open personal document (the owner sharing it). */
  async create(doc, name) {
    const state = { nodes: new Map(doc.nodes), assets: new Map(doc.assets), comments: doc.comments };
    await this.transport.call({ op: 'create', room: this.room, name, state: stateToJSON(state) });
    this.base = state;
    this.seq = 0;
    this.role = 'owner';
    const res = await this.transport.call({ op: 'join', room: this.room });
    this.roomKey = res.publicKey;
    this.owner = res.owner;
    this.seq = res.seq;
    this.joinInfo = res;
    this.setStatus('live');
  }

  /** Start keeping `editor`'s document in step. */
  bind(editor) {
    this.editor = editor;
    this.doc = editor.doc;
    const doc = this.doc;
    this.unbind = [
      doc.on('transaction', (e) => this.#local(e)),
      doc.on('change', (e) => {
        if (e.commit && !doc.tx && this.deferred) this.#reconcile();
      }),
    ];
    if (this.timers) {
      this.#scheduleSync(0);
      this.#schedulePresence(0);
      this.onOnline = () => {
        this.backoff = 0;
        this.#send();
        this.#scheduleSync(0);
      };
      this.onVisible = () => {
        if (document.visibilityState === 'visible') this.#scheduleSync(0);
      };
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onVisible);
    }
    if (this.pending.length) this.#send();
    this.#persist();
  }

  setStatus(status, detail = null) {
    if (this.status === status && this.statusDetail === detail) return;
    this.status = status;
    this.statusDetail = detail;
    this.emit('status', status);
  }

  // ---- local changes ----

  #local({ before, after }) {
    if (this.closed) return;
    const nodes = diffNodes(before, after);
    if (!nodes.length) return;
    const assets = {};
    for (const op of nodes) {
      const ref = op.put?.asset ?? op.set?.asset;
      if (typeof ref === 'string' && !this.base.assets.has(ref) && this.doc.assets.has(ref)) assets[ref] = this.doc.assets.get(ref);
    }
    this.#enqueue({ nodes, ...(Object.keys(assets).length ? { assets } : {}) });
  }

  /** Apply comment ops here and send them (comments never enter undo). */
  comment(ops) {
    if (!this.canComment) throw Object.assign(new Error('You cannot comment on this document.'), { expected: true });
    this.doc.setComments(applyCommentOps(this.doc.comments, ops));
    this.#enqueue({ comments: ops });
  }

  #enqueue(part) {
    const last = this.pending[this.pending.length - 1];
    // Quick successive changes travel as one batch.
    if (last && !last.sent && Date.now() - last.made < MERGE_MS) {
      if (part.nodes) last.nodes = [...(last.nodes || []), ...part.nodes];
      if (part.assets) last.assets = { ...last.assets, ...part.assets };
      if (part.comments) last.comments = [...(last.comments || []), ...part.comments];
    } else this.pending.push({ id: uid('b').replace(/[^A-Za-z0-9_-]/g, '') + Math.random().toString(36).slice(2, 8), made: Date.now(), ...part });
    this.#persist();
    clearTimeout(this.sendTimer);
    if (this.timers) this.sendTimer = setTimeout(() => this.#send(), MERGE_MS);
    else this.#send();
    this.emit('pending', this.pending.length);
  }

  /** Send pending batches one at a time, in order. */
  async #send() {
    if (this.sending || this.closed) return this.sending;
    this.sending = (async () => {
      while (!this.closed) {
        const batch = this.pending.find((b) => !b.seq);
        if (!batch) break;
        batch.sent = true;
        const { made, sent, seq, ...wire } = batch;
        try {
          const res = await this.transport.call({ op: 'commit', room: this.room, session: this.sessionId, batch: wire });
          batch.seq = res.seq;
          this.backoff = 0;
          if (this.status !== 'live') this.setStatus('live');
          if (res.seq <= this.seq) this.#drop(batch);
          this.peers?.broadcast('committed', { seq: res.seq });
          this.#persist();
        } catch (err) {
          if (err.status === 410 || err.status === 404) {
            this.#ended(err.message);
            break;
          }
          if (REFUSED.has(err.status)) {
            this.#reject(batch, err);
            continue;
          }
          // The server may have taken the batch before the reply was lost, so it stays marked as
          // sent: later edits go in a new batch instead of one the server would skip as a retry.
          this.setStatus('offline');
          this.backoff = Math.min(30000, (this.backoff || 1000) * 2);
          if (this.timers) {
            clearTimeout(this.sendTimer);
            this.sendTimer = setTimeout(() => this.#send(), this.backoff);
          }
          break;
        }
      }
      this.sending = null;
      if (this.pending.every((b) => b.seq)) this.#syncSoon();
    })();
    return this.sending;
  }

  #drop(batch) {
    const i = this.pending.indexOf(batch);
    if (i >= 0) this.pending.splice(i, 1);
    this.#maybeSaved();
  }

  /** The server refused a batch for good: undo its effect here and say why. */
  #reject(batch, err) {
    this.#drop(batch);
    for (const op of batch.nodes || []) this.dirtyIds.add(op.id);
    if (batch.comments?.length) this.commentsDirty = true;
    this.#reconcile(true);
    this.#persist();
    this.emit('rejected', err);
  }

  #maybeSaved() {
    if (!this.pending.length && this.doc && !this.doc.tx) this.doc.markSaved();
    this.emit('pending', this.pending.length);
  }

  // ---- receiving ----

  #syncSoon() {
    if (this.timers) this.#scheduleSync(0);
    else this.sync();
  }

  #scheduleSync(ms) {
    if (this.closed) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(async () => {
      await this.sync().catch(() => {});
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      this.#scheduleSync(this.status === 'offline' ? Math.max(SYNC_MS, this.backoff || 5000) : hidden ? SYNC_HIDDEN_MS : SYNC_MS);
    }, ms);
  }

  /** Fetch and apply batches ordered since `seq`. */
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        for (let page = 0; page < 20 && !this.closed; page++) {
          const skip = this.hole && this.hole.seq === this.seq + 1 && Date.now() - this.hole.since > HOLE_MS ? this.hole.seq : undefined;
          const res = await this.transport.call({ op: 'sync', room: this.room, since: this.seq, ...(skip ? { skip } : {}) });
          if (this.status === 'offline' || this.status === 'connecting') this.setStatus('live');
          if (res.role && res.role !== this.role) this.setRole(res.role);
          if (res.reset) {
            await this.rejoin();
            return;
          }
          for (const r of res.records || []) this.#receive(r);
          if (res.hole != null && !res.records?.length) {
            if (this.hole?.seq !== res.hole) this.hole = { seq: res.hole, since: Date.now() };
          } else this.hole = null;
          if (!res.more) break;
        }
        this.#reconcile();
        // Batches the server took whose records were read are confirmed.
        if (this.pending.some((b) => !b.seq)) this.#send();
      } catch (err) {
        if (err.status === 410 || err.status === 404) this.#ended(err.message);
        else if (err.status === 403) this.#ended(err.message, 'removed');
        else this.setStatus('offline');
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  #receive(record) {
    if (record.seq !== this.seq + 1) return;
    this.seq = record.seq;
    if (record.skipped || !record.batch) return;
    const mine = this.pending.find((b) => b.id === record.batch.id);
    // Changes that would break the document (let through by an older server) are left out.
    const changed = applyBatch(this.base, safeBatch(record.batch));
    for (const id of changed) this.dirtyIds.add(id);
    if (record.batch.comments?.length) {
      this.commentsDirty = true;
      if (!mine) this.emit('remote-comments', { ops: record.batch.comments, by: record.by });
    }
    if (mine) this.#drop(mine);
    else if (record.batch.nodes?.length) this.emit('remote-edit', record.by);
  }

  /** Make the document show base + pending (after receiving or a refusal). */
  #reconcile(force = false) {
    const doc = this.doc;
    if (!doc || !this.base) return;
    if (doc.tx) {
      this.deferred = true;
      return;
    }
    this.deferred = false;
    if (!this.dirtyIds.size && !this.commentsDirty && !force) return;
    const nodes = new Overlay(this.base.nodes);
    let comments = this.base.comments;
    for (const b of this.pending) {
      if (b.nodes?.length) applyNodeOps(nodes, b.nodes);
      if (b.comments?.length) comments = applyCommentOps(comments, b.comments);
    }
    const ids = new Set(this.dirtyIds);
    for (const id of nodes.own.keys()) ids.add(id);
    const changes = new Map();
    for (const id of ids) {
      let want = nodes.get(id);
      const have = doc.nodes.get(id);
      if (want === have) continue;
      if (want !== undefined && have !== undefined) {
        // Values from the server are copies: keep the shown objects for
        // fields that did not change, so only real changes count as remote
        // (and undo history keeps its own values for the rest).
        want = shareFields(have, want);
        if (want === have) continue;
      }
      changes.set(id, want);
    }
    for (const [id, a] of this.base.assets) if (!doc.assets.has(id)) doc.assets.set(id, a);
    this.dirtyIds.clear();
    if (changes.size) doc.applyRemote(changes);
    if (this.commentsDirty || force) {
      this.commentsDirty = false;
      if (!same(comments, doc.comments)) doc.setComments(comments, { remote: true });
    }
    this.#maybeSaved();
    this.#persistSoon();
  }

  /** Start over from the server's current state (after a long absence). */
  async rejoin() {
    const res = await this.transport.call({ op: 'join', room: this.room });
    this.#adopt(res);
    this.pending = this.pending.filter((b) => !(b.seq && b.seq <= this.seq));
    for (const id of this.base.nodes.keys()) this.dirtyIds.add(id);
    for (const id of this.doc?.nodes.keys() || []) this.dirtyIds.add(id);
    this.commentsDirty = true;
    this.#reconcile();
    this.emit('role', this.role);
  }

  setRole(role) {
    if (role === this.role) return;
    const prev = this.role;
    this.role = role;
    this.emit('role', role, prev);
  }

  #ended(message, kind = 'closed') {
    if (this.ended) return;
    this.ended = kind;
    this.setStatus('ended', message);
    this.emit('ended', { kind, message });
    this.close({ leave: false });
  }

  // ---- device copy ----

  #persistSoon() {
    if (!this.outbox) return;
    clearTimeout(this.persistTimer);
    if (this.timers) this.persistTimer = setTimeout(() => this.#persist(), 3000);
    else this.#persist();
  }

  #persist() {
    if (!this.outbox || !this.base || this.ended) return;
    clearTimeout(this.persistTimer);
    const pending = this.pending.map(({ made, sent, ...b }) => b);
    const value = { seq: this.seq, state: stateToJSON(this.base), pending, role: this.role, review: this.review, owner: this.owner, publicKey: this.roomKey, saved: Date.now() };
    this.persisting = Promise.resolve(this.outbox.put(this.key, value)).catch(() => {});
    return this.persisting;
  }

  // ---- presence ----

  /** Update this participant's published state (cursor, selection, view, following). */
  setLocalState(patch) {
    this.localState = { ...this.localState, ...patch };
    if (this.peers?.linked().length) {
      if (!this.peerTimer) {
        this.peerTimer = setTimeout(() => {
          this.peerTimer = 0;
          this.peers?.broadcast('presence', this.localState);
        }, PEER_PRESENCE_MS);
      }
    } else if (this.timers && !this.fallbackTimer && this.others.size) {
      // Without peer links, others see changes at the next (sooner) check-in.
      this.fallbackTimer = setTimeout(() => {
        this.fallbackTimer = 0;
        this.checkIn().catch(() => {});
      }, PRESENCE_FALLBACK_MS);
    }
  }

  #schedulePresence(ms) {
    if (this.closed) return;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(async () => {
      await this.checkIn().catch(() => {});
      this.#schedulePresence(PRESENCE_MS);
    }, ms);
  }

  async checkIn() {
    if (this.closed) return;
    if (!this.sessionKeys) this.sessionKeys = await keyPair();
    if (!this.peers && this.puter?.peer?.serve && this.roomKey) {
      this.peers = new PeerMesh({
        puter: this.puter,
        session: this.sessionId,
        keys: this.sessionKeys,
        roomKey: this.roomKey,
        room: this.room,
        receive: (kind, data, ticket) => this.#peerPacket(kind, data, ticket),
        changed: () => this.emit('presence'),
      });
      await this.peers.serve();
    }
    const res = await this.transport.call({ op: 'presence', room: this.room, session: this.sessionId, publicKey: this.sessionKeys.publicKey, invite: this.peers?.invite || null, state: this.localState });
    if (this.closed) return;
    if (res.role && res.role !== this.role) this.setRole(res.role);
    const now = Date.now();
    const seen = new Set();
    for (const p of res.roster || []) {
      if (p.session === this.sessionId) continue;
      seen.add(p.session);
      const cur = this.others.get(p.session);
      // Fresher peer state wins over the server's copy.
      const state = cur && cur.source === 'peer' && now - cur.seen < PRESENCE_MS ? cur.state : p.state || {};
      this.others.set(p.session, { session: p.session, uuid: p.user, username: p.username, role: p.role, review: p.review, color: colorFor(p.user), state, seen: cur?.source === 'peer' ? cur.seen : now, source: cur?.source === 'peer' ? 'peer' : 'server' });
    }
    for (const id of [...this.others.keys()]) if (!seen.has(id)) this.others.delete(id);
    this.peers?.update(res.ticket, res.signature, res.roster || []);
    this.emit('presence');
  }

  #peerPacket(kind, data, ticket) {
    if (ticket.room !== this.room) return;
    if (kind === 'committed') {
      if (Number.isSafeInteger(data?.seq) && data.seq > this.seq) this.#syncSoon();
      return;
    }
    if (kind === 'left') {
      // The link closed; the server roster decides whether they are gone.
      return;
    }
    if (kind === 'presence') {
      const cur = this.others.get(ticket.session);
      this.others.set(ticket.session, { session: ticket.session, uuid: ticket.user, username: ticket.username, role: ticket.role, review: cur?.review, color: colorFor(ticket.user), state: sanitizeState(data), seen: Date.now(), source: 'peer' });
      this.emit('presence', ticket.session);
    }
  }

  /** Other participants, one entry per account (their most recent session). */
  participants() {
    const now = Date.now();
    const byUser = new Map();
    for (const p of this.others.values()) {
      if (now - p.seen > STALE_PRESENCE_MS && p.source === 'peer') continue;
      const cur = byUser.get(p.uuid);
      if (!cur || p.seen > cur.seen) byUser.set(p.uuid, p);
    }
    return [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username));
  }

  // ---- ending ----

  /** Stop synchronizing (closing the document); unsent edits stay on the device. */
  close({ leave = true } = {}) {
    if (this.closed) return;
    this.closed = true;
    for (const t of [this.syncTimer, this.presenceTimer, this.sendTimer, this.persistTimer, this.peerTimer, this.fallbackTimer]) clearTimeout(t);
    if (this.onOnline) window.removeEventListener('online', this.onOnline);
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
    for (const off of this.unbind || []) off();
    this.peers?.close();
    this.peers = null;
    if (!this.ended) this.#persist();
    else this.outbox?.delete(this.key)?.catch?.(() => {});
    if (leave) this.transport.call({ op: 'leave', room: this.room, session: this.sessionId }).catch(() => {});
    this.emit('closed');
  }
}

/** `next` reusing `prev`'s field values where they are equal; `prev` itself when nothing differs. */
function shareFields(prev, next) {
  const keys = Object.keys(next);
  let differs = keys.length !== Object.keys(prev).length;
  const out = {};
  for (const k of keys) {
    if (same(prev[k], next[k])) out[k] = prev[k];
    else {
      out[k] = next[k];
      differs = true;
    }
  }
  return differs ? out : prev;
}

/** Presence state received from a peer, limited to known fields. */
export function sanitizeState(s) {
  if (!s || typeof s !== 'object') return {};
  const num = (v) => Number.isFinite(v);
  const out = {};
  if (s.cursor && num(s.cursor.x) && num(s.cursor.y)) out.cursor = { x: s.cursor.x, y: s.cursor.y };
  if (Array.isArray(s.selection)) out.selection = s.selection.filter((id) => typeof id === 'string' && id.length < 121).slice(0, 100);
  if (s.view && ['x', 'y', 'w', 'h'].every((k) => num(s.view[k]))) out.view = { x: s.view.x, y: s.view.y, w: s.view.w, h: s.view.h };
  if (typeof s.following === 'string' && s.following.length < 101) out.following = s.following;
  if (s.commenting === true) out.commenting = true;
  return out;
}
