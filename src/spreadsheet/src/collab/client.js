/**
 * One browser's connection to a shared workbook: joining, loading the latest checkpoint and the log after it,
 * sending this person's changes (kept in the outbox until the room has them, so edits made offline are sent
 * when the connection returns, even after a reload), fetching everyone else's, writing checkpoints, change
 * notifications, presence, and live peer links. The workbook model is in replica.js; this module only moves
 * its changes. Its shape follows Photo Studio's room client (itself from the Whiteboard app).
 */

import { Workbook } from '../core/workbook.js';
import { Replica } from './replica.js';
import { call, CollabError } from './api.js';
import { canEdit, hash, keyPair, MAX_PEER_CHANGE, packState, unpackState, verify } from './protocol.js';
import { PeerNetwork } from './peers.js';
import { sanitizeState } from './server/service.js';

/** Revisions between checkpoints written by an editor's browser. */
const CHECKPOINT_EVERY = 50;
/** And the longest a revision waits for one while people keep editing. */
const CHECKPOINT_IDLE = 60_000;
/** People not heard from for this long are taken off the list. */
const PEOPLE_TTL = 20_000;

export class RoomClient extends EventTarget {
  /**
   * o: { puter, server, room, token?, store (outbox.js), poll (ms without live links), noPeers, toXlsx(wb) → bytes? }
   * Events: 'status', 'people', 'remote' ({ structural }), 'role', 'refused' ({ message }), 'closed' ({ message }).
   */
  constructor(o) {
    super();
    this.o = o;
    this.room = o.room;
    this.role = 'viewer';
    this.user = null;
    this.owner = null;
    this.name = '';
    this.file = null;
    this.roomKey = null;
    this.status = { state: 'connecting', pending: 0 };
    this.people = new Map(); // session → { session, user, username, role, state, at }
    this.roster = [];
    this.session = crypto.randomUUID().replaceAll('-', '');
    this.timers = [];
    this.closed = false;
    this.queue = Promise.resolve();
    this.lastCheckpoint = 0;
    this.lastCheckpointAt = Date.now();
    this.retryDelay = 1000;
  }

  request(input) {
    return call(this.o.puter, this.o.server, { room: this.room, ...input });
  }

  /** Run work on the replica one piece at a time (responses must land in the order of the log). */
  serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  get canEdit() { return canEdit(this.role); }

  /* ---------- Creating, joining and opening ---------- */

  /** Create the room for a workbook (its owner, on their own worker). Returns the room ID. */
  static async create({ puter, server, wb, name, file = null }) {
    const room = crypto.randomUUID().replaceAll('-', '');
    const state = await packState(new Replica(new Workbook(wb.toJSON())).checkpoint());
    await call(puter, server, { op: 'create', room, name, state, file });
    return room;
  }

  /** Join the room and open its workbook: resolves to the Workbook, kept in step with the room from then on. */
  async open() {
    const res = await this.request({ op: 'join', ...(this.o.token ? { token: this.o.token } : {}) });
    this.role = res.role;
    this.user = res.user;
    this.owner = res.owner;
    this.roomKey = res.publicKey;
    this.name = res.name;
    this.file = res.file;
    const saved = await this.o.store.get(this.room);
    const loaded = await this.request({ op: 'load', ...(saved ? { at: saved.rev } : {}) });
    const state = await unpackState(loaded.state);
    this.wb = new Workbook(state);
    this.wb.markClean?.();
    this.replica = new Replica(this.wb, { rev: loaded.rev, readOnly: !this.canEdit });
    this.lastCheckpoint = loaded.rev;
    // Changes this browser made before and never delivered go back on top of the revision they were made on.
    if (saved?.pending?.length && saved.rev >= loaded.rev && this.canEdit) {
      this.replica.receive(loaded.records.filter((r) => r.rev <= saved.rev));
      this.replica.restorePending(saved.pending);
      this.replica.receive(loaded.records.filter((r) => r.rev > saved.rev));
    } else {
      this.replica.receive(loaded.records);
      if (saved) await this.o.store.delete(this.room);
    }
    this.replica.addEventListener('local', () => { this.persist(); this.flush(); });
    this.replica.addEventListener('remote', (e) => this.dispatchEvent(new CustomEvent('remote', { detail: e.detail })));
    this.replica.addEventListener('refused', () => this.dispatchEvent(new CustomEvent('refused', { detail: { message: 'You can view this shared workbook but not change it.' } })));
    this.subscribe(res.events);
    this.timers.push(setInterval(() => { if (!this.connectedPeers() || Date.now() - this.lastSync > 20_000) this.scheduleSync(0); }, this.o.poll ?? 4000));
    this.timers.push(setInterval(() => this.checkIn().catch(() => {}), 15_000));
    this.timers.push(setInterval(() => this.tick(), 2000));
    this.setStatus();
    await this.checkIn().catch(() => {});
    await this.sync().catch((e) => this.failed(e));
    if (this.replica.pending.length) this.flush();
    return this.wb;
  }

  connectedPeers() { return this.peers?.connectedSessions.length ?? 0; }

  async subscribe(events) {
    const on = this.o.puter.events?.onLocal;
    if (!events || !on || this.closed) return;
    const subject = events.handle ? `kv:${events.handle}:${events.key}` : `kv:${events.app}:${events.key}`;
    try {
      // A notice carries no data: it prompts a synchronization and a check-in.
      this.subscription = await this.o.puter.events.onLocal(subject, () => { this.scheduleSync(100); this.soonCheckIn(); }, { includeValue: false });
      if (this.closed) this.subscription.off();
    } catch { /* Polling and peer notices still deliver changes. */ }
  }

  /* ---------- Synchronizing ---------- */

  scheduleSync(delay = 150) {
    if (this.closed || this.syncTimer) return;
    this.syncTimer = setTimeout(() => { this.syncTimer = null; this.sync().catch((e) => this.failed(e)); }, delay);
  }

  /** Fetch the changes the room has and this browser lacks. */
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.serial(async () => {
      for (let round = 0; round < 20 && !this.closed; round++) {
        const res = await this.request({ op: 'sync', since: this.replica.rev });
        this.lastSync = Date.now();
        this.noteRole(res.role);
        this.lastCheckpoint = Math.max(this.lastCheckpoint, res.checkpoint || 0);
        if (res.records.length) { this.replica.receive(res.records); await this.persist(); }
        if (this.replica.rev >= res.head || !res.records.length) break;
      }
      if (this.status.state !== 'error') this.setStatus('connected');
      this.maybeCheckpoint();
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  noteRole(role) {
    if (!role || role === this.role) return;
    this.role = role;
    this.replica.readOnly = !this.canEdit;
    this.dispatchEvent(new CustomEvent('role', { detail: { role } }));
  }

  /** Keep what is pending in the outbox (or clear it once nothing is). */
  async persist() {
    if (!this.replica) return;
    const pending = this.replica.outgoing();
    if (pending.length) await this.o.store.put(this.room, { room: this.room, rev: this.replica.rev, pending, at: Date.now() });
    else await this.o.store.delete(this.room);
    this.setStatus();
  }

  /** Send pending changes (one commit at a time; a refused one is rebased and sent again). */
  flush() {
    if (this.closed) return Promise.resolve();
    if (this.flushing) { this.flushAgain = true; return this.flushing; }
    clearTimeout(this.retryTimer);
    this.flushing = this.serial(async () => {
      for (let round = 0; round < 50 && !this.closed; round++) {
        this.flushAgain = false;
        const changes = this.replica.outgoing();
        if (!changes.length) break;
        if (!this.canEdit) { this.replica.discardPending(); await this.persist(); break; }
        this.setStatus('syncing');
        let res;
        try {
          res = await this.request({ op: 'commit', base: this.replica.rev, changes, session: this.session });
        } catch (error) {
          if (error instanceof CollabError && [400, 403, 413, 422].includes(error.status)) {
            // Refused for good: later changes may build on it, so they go too, and the workbook shows the room's state.
            this.replica.discardPending();
            await this.persist();
            this.dispatchEvent(new CustomEvent('refused', { detail: { message: error.message } }));
            if (error.status === 403) await this.sync().catch(() => {});
            break;
          }
          throw error;
        }
        this.replica.receive(res.records);
        await this.persist();
        if (res.accepted) {
          this.announce(res);
          if (!this.flushAgain && !this.replica.pending.length) break;
        }
      }
      this.retryDelay = 1000;
      this.setStatus('connected');
      this.maybeCheckpoint();
    }).catch((error) => {
      this.failed(error);
      if (!this.closed && !(error instanceof CollabError && [401, 403, 404, 410].includes(error.status))) {
        this.retryTimer = setTimeout(() => this.flush(), this.retryDelay);
        this.retryDelay = Math.min(30_000, this.retryDelay * 2);
      }
    }).finally(() => {
      this.flushing = null;
      if (this.flushAgain && !this.closed) this.flush();
    });
    return this.flushing;
  }

  /** Tell linked peers of an accepted change: small ones travel whole, with the room's receipt. */
  announce(res) {
    if (!this.peers) return;
    const record = res.records.find((r) => r.rev === res.rev);
    const text = record && JSON.stringify(record.changes);
    if (record && text.length <= MAX_PEER_CHANGE) this.peers.broadcast('change', { record, receipt: res.receipt });
    else this.peers.broadcast('committed', { rev: res.rev });
  }

  /** Resolves once everything pending is delivered (or the delivery failed). */
  async settled() {
    while (this.flushing || this.syncing) await (this.flushing || this.syncing).catch(() => {});
  }

  /* ---------- Checkpoints ---------- */

  /**
   * Write a checkpoint when the log has grown, from the editor with the lowest session among those here (so
   * that one browser does it), only while this one has nothing pending (its state is then the room's).
   */
  maybeCheckpoint() {
    if (!this.canEdit || this.replica.pending.length || this.checkpointing) return;
    const due = this.replica.rev - this.lastCheckpoint >= CHECKPOINT_EVERY
      || (this.replica.rev > this.lastCheckpoint && Date.now() - this.lastCheckpointAt > CHECKPOINT_IDLE);
    if (!due) return;
    const editors = [...this.people.values()].filter((p) => canEdit(p.role)).map((p) => p.session);
    if (editors.some((s) => s < this.session)) return;
    this.checkpoint().catch(() => {});
  }

  /** Write a checkpoint now; with `file`, the .xlsx goes with it, for the worker to write over the owner's file. */
  async checkpoint({ file = false } = {}) {
    if (!this.canEdit || this.replica.pending.length) return { ok: false };
    this.checkpointing = true;
    try {
      const rev = this.replica.rev;
      const state = await packState(this.replica.checkpoint());
      let xlsx;
      if (file && this.o.toXlsx) {
        const bytes = new Uint8Array(await (await this.o.toXlsx(this.wb)).arrayBuffer());
        let text = '';
        for (let n = 0; n < bytes.length; n += 8192) text += String.fromCharCode(...bytes.subarray(n, n + 8192));
        xlsx = btoa(text);
      }
      const res = await this.request({ op: 'checkpoint', rev, state, ...(xlsx ? { xlsx } : {}) });
      this.lastCheckpoint = Math.max(this.lastCheckpoint, rev);
      this.lastCheckpointAt = Date.now();
      return res;
    } finally {
      this.checkpointing = false;
    }
  }

  /* ---------- People ---------- */

  soonCheckIn() {
    if (this.closed || this.checkInTimer) return;
    this.checkInTimer = setTimeout(() => { this.checkInTimer = null; this.checkIn().catch(() => {}); }, Math.max(100, 1500 - (Date.now() - (this.lastCheckIn || 0))));
  }

  /** Renew this session's ticket (with where this person is) and learn who is here. */
  checkIn() {
    if (this.closed) return Promise.resolve();
    if (this.checkingIn) return this.checkingIn;
    this.checkingIn = (async () => {
      this.keys ??= await keyPair();
      if (!this.o.noPeers && this.o.puter.peer && !this.peers) {
        this.peers = new PeerNetwork({
          peer: this.o.puter.peer, session: this.session, keys: this.keys, roomKey: this.roomKey, room: this.room,
          receive: (kind, data, ticket) => this.receivePeer(kind, data, ticket),
          changed: () => this.checkIn().catch(() => {}),
          stranger: () => this.soonCheckIn(),
          linked: () => { this.dispatchEvent(new CustomEvent('people')); if (this.presence) this.sendPresence(true); },
        });
        await this.peers.serve().catch(() => {});
      }
      this.lastCheckIn = Date.now();
      const res = await this.request({ op: 'presence', session: this.session, publicKey: this.keys.publicKey, invite: this.peers?.invite ?? null, state: this.presence ?? null });
      if (this.closed) return;
      this.roster = res.roster;
      this.noteRole(res.role);
      this.peers?.update(res.ticket, res.signature, res.roster);
      const here = new Set(res.roster.map((t) => t.session));
      for (const s of [...this.people.keys()]) if (!here.has(s)) this.people.delete(s);
      for (const t of res.roster) {
        if (t.session === this.session) continue;
        const known = this.people.get(t.session);
        // A peer's report is newer than what the worker holds.
        const state = known && known.at > (t.at ?? 0) ? known.state : t.state ?? null;
        this.people.set(t.session, { session: t.session, user: t.user, username: t.username, role: t.role, state, at: Math.max(known?.at ?? 0, t.at ?? Date.now()) });
      }
      this.dispatchEvent(new CustomEvent('people'));
      if (this.status.state === 'offline') this.setStatus('connected');
    })().catch((e) => { this.failed(e); throw e; }).finally(() => { this.checkingIn = null; });
    return this.checkingIn;
  }

  async receivePeer(kind, data, ticket) {
    if (ticket.session === this.session) return false;
    if (kind === 'presence') {
      const state = sanitizeState(data?.state);
      this.people.set(ticket.session, { session: ticket.session, user: ticket.user, username: ticket.username, role: ticket.role, state, at: Date.now() });
      this.dispatchEvent(new CustomEvent('people'));
      return;
    }
    if (kind === 'leave') { this.people.delete(ticket.session); this.dispatchEvent(new CustomEvent('people')); return; }
    if (kind === 'committed') { this.scheduleSync(50); return; }
    if (kind === 'change') {
      // Only changes the room accepted (its receipt names this sender and revision) apply, in the log's order.
      const record = data?.record, receipt = data?.receipt;
      if (!record || !Number.isInteger(record.rev) || !Array.isArray(record.changes) || record.user !== ticket.user || !this.roomKey) return false;
      const ok = await verify(this.roomKey, { room: this.room, rev: record.rev, digest: await hash(JSON.stringify(record.changes)), user: ticket.user }, receipt);
      if (!ok) return false;
      this.serial(async () => {
        if (record.rev === this.replica.rev + 1) { this.replica.receive([record]); await this.persist(); if (this.replica.pending.length) this.flush(); }
        else if (record.rev > this.replica.rev) this.scheduleSync(0);
      }).catch(() => this.scheduleSync(0));
    }
  }

  /** Share where this person is: { sheet, sel: { r1, c1, r2, c2 }, active: { r, c }, editing }. */
  setPresence(state) {
    this.presence = sanitizeState(state);
    this.sendPresence(false);
  }

  sendPresence(now) {
    if (this.closed) return;
    if (this.connectedPeers()) {
      if (this.presenceTimer) return;
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = null;
        this.lastPresenceSent = Date.now();
        if (this.presence) this.peers?.broadcast('presence', { state: this.presence });
      }, now ? 0 : Math.max(0, 50 - (Date.now() - (this.lastPresenceSent || 0))));
    } else if (this.people.size) this.soonCheckIn(); // without live links, presence travels with the check-ins
  }

  tick() {
    let changed = false;
    for (const [s, p] of this.people) if (Date.now() - p.at > (this.connectedPeers() ? PEOPLE_TTL : 120_000)) { this.people.delete(s); changed = true; }
    if (changed) this.dispatchEvent(new CustomEvent('people'));
    // A quiet pulse keeps this person's presence alive for linked peers; without links, others are asked for often.
    if (this.connectedPeers()) { if (this.presence && Date.now() - (this.lastPresenceSent || 0) > 3000) this.sendPresence(true); }
    else if (this.people.size && Date.now() - (this.lastCheckIn || 0) > 3000) this.checkIn().catch(() => {});
    this.maybeCheckpoint();
  }

  /* ---------- Status ---------- */

  failed(error) {
    if (this.closed) return;
    if (error instanceof CollabError && !error.network && [401, 403, 404, 410].includes(error.status)) {
      this.status = { state: 'error', pending: this.replica?.pending.length ?? 0, message: error.message };
      this.dispatchEvent(new CustomEvent('status'));
      if (error.status === 410 || error.status === 404 || error.status === 403) this.dispatchEvent(new CustomEvent('closed', { detail: { message: error.message } }));
      return;
    }
    this.status = { state: 'offline', pending: this.replica?.pending.length ?? 0, message: error?.message || 'Offline' };
    this.dispatchEvent(new CustomEvent('status'));
  }

  setStatus(state) {
    if (this.closed) return;
    const pending = this.replica?.pending.length ?? 0;
    const next = state ?? (this.status.state === 'offline' || this.status.state === 'error' ? this.status.state : pending ? 'syncing' : 'connected');
    const resolved = next === 'connected' && pending ? 'syncing' : next;
    if (this.status.state === resolved && this.status.pending === pending) return;
    this.status = { state: resolved, pending };
    this.dispatchEvent(new CustomEvent('status'));
  }

  /** The connection came back (or the tab became visible): catch up and send. */
  resume() {
    if (this.closed) return;
    this.sync().then(() => this.flush()).catch((e) => this.failed(e));
    this.checkIn().catch(() => {});
  }

  /* ---------- Leaving ---------- */

  /** Leave the room: deliver what is pending (briefly), then close links. */
  async leave() {
    if (this.closed) return;
    await Promise.race([this.settled(), new Promise((r) => setTimeout(r, 3000))]);
    this.peers?.broadcast('leave', {});
    this.close();
    await this.request({ op: 'leave', session: this.session }).catch(() => {});
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.syncTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.presenceTimer);
    clearTimeout(this.checkInTimer);
    this.subscription?.off();
    this.peers?.close();
    this.replica?.detach();
    this.status = { state: 'closed', pending: this.replica?.pending.length ?? 0 };
  }
}
