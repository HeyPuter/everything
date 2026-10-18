/**
 * A person's connection to a shared document: the Yjs document, the outbox of
 * local changes not yet accepted, the roster of who is here, and the
 * transport that carries them (transports.js).
 *
 * Every local change is queued before it is sent and kept (IndexedDB, when
 * the browser has it) until the room accepts it, so changes made offline, or
 * while a request fails, go out when the connection returns, also after a
 * reload of the same room in this browser. Changes the room refuses for good
 * (the person's access changed) are dropped and the person is told.
 *
 * Events: 'status' (detail: { status, pending }), 'presence' (roster),
 * 'role', 'closed' (detail: { reason }), 'refused' (detail: { message }).
 */
import * as Y from 'yjs';
import { REMOTE } from './binding.js';
import { colorFor, randomId, PRESENCE_TTL } from './protocol.js';

const OUTBOX_DB = 'documents-collab';

/** Queued updates per room, in IndexedDB with a memory fallback (private windows, tests). */
export class Outbox {
  constructor(room, session) { this.room = room; this.session = session; this.items = []; this.memory = !globalThis.indexedDB; }
  async db() {
    if (this.memory) return null;
    this.opening ||= new Promise((resolve) => {
      try {
        const request = indexedDB.open(OUTBOX_DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('outbox', { keyPath: 'key' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { this.memory = true; resolve(null); };
      } catch { this.memory = true; resolve(null); }
    });
    return this.opening;
  }
  async run(mode, fn) {
    const db = await this.db(); if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('outbox', mode), store = tx.objectStore('outbox');
        const result = fn(store);
        tx.oncomplete = () => resolve(result?.result ?? null);
        tx.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  /** Updates left from an earlier visit to this room in this browser (any session). */
  async restore() {
    const all = await this.run('readonly', store => store.getAll());
    return (all || []).filter(item => item.room === this.room).sort((a, b) => a.at - b.at || a.seq - b.seq);
  }
  async add(update) {
    const item = { key: `${this.room}:${this.session}:${Date.now()}:${this.items.length}:${Math.random()}`, room: this.room, at: Date.now(), seq: this.items.length, update };
    this.items.push(item);
    await this.run('readwrite', store => store.put(item));
    return item;
  }
  async remove(items) {
    const keys = new Set(items.map(i => i.key));
    this.items = this.items.filter(i => !keys.has(i.key));
    await this.run('readwrite', store => { for (const key of keys) store.delete(key); });
  }
  get size() { return this.items.length; }
}

/** Whether a room refused a change for good, rather than failing to receive it for now. */
const refusedForGood = error => error?.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status);

export class CollabClient extends EventTarget {
  /** transport: see transports.js. user: { id, name }. */
  constructor({ transport, user, room, sendDelay = 40 }) {
    super();
    this.transport = transport; this.room = room;
    this.user = user;
    this.session = randomId(8);
    this.color = colorFor(user.id || user.name || this.session);
    this.ydoc = new Y.Doc();
    this.outbox = new Outbox(room, this.session);
    this.roster = [];
    this.status = 'connecting';
    this.role = null;
    this.binding = null;
    this.sendDelay = sendDelay;
    this.closed = false;
    this.onLocalUpdate = (update, origin) => { if (origin !== REMOTE && origin !== 'initial') this.queue(update); };
    this.ydoc.on('update', this.onLocalUpdate);
  }

  setStatus(status) {
    if (this.status === status && status !== 'online') return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, pending: this.outbox.size } }));
  }

  /** Join the room: load its state, replay this browser's undelivered changes. */
  async connect() {
    const joined = await this.transport.join({
      session: this.session, user: this.user,
      update: update => this.receive(update),
      presence: roster => this.setRoster(roster),
      role: role => { this.role = role; this.dispatchEvent(new CustomEvent('role', { detail: { role } })); },
      closed: reason => this.close(reason),
      online: online => { this.setStatus(online ? 'online' : 'offline'); if (online) this.scheduleSend(0); },
    });
    this.role = joined.role;
    this.info = joined;
    if (joined.state?.length) Y.applyUpdate(this.ydoc, joined.state, 'initial');
    for (const item of await this.outbox.restore()) {
      // Undelivered changes from an earlier visit: applied locally and sent again.
      Y.applyUpdate(this.ydoc, item.update, 'outbox');
      await this.outbox.remove([item]);
    }
    this.setStatus('online');
    return joined;
  }

  /** Another person's change. */
  receive(update) {
    if (this.closed) return;
    if (this.binding) this.binding.receive(update);
    else Y.applyUpdate(this.ydoc, update, REMOTE);
  }

  attach(binding) { this.binding = binding; }

  queue(update) {
    if (this.closed) return;
    this.outbox.add(update);
    this.scheduleSend(this.sendDelay);
  }

  scheduleSend(delay) {
    if (this.sendTimer || this.closed) return;
    this.sendTimer = setTimeout(() => { this.sendTimer = null; this.send(); }, delay);
  }

  async send() {
    if (this.sending || this.closed || !this.outbox.size) return;
    this.sending = true;
    // A room that limits the size of a request takes the queue in batches under it, in order.
    const limit = this.transport.maxUpdate || Infinity, size = item => Math.ceil(item.update.length / 3) * 4;
    const items = [];
    for (let total = 0; items.length < this.outbox.size; items.push(this.outbox.items[items.length])) {
      total += size(this.outbox.items[items.length]);
      if (items.length && total > limit) break;
    }
    try {
      if (items.length === 1 && size(items[0]) > limit) throw Object.assign(new Error('This change is too large to share: pictures over about 5 MB cannot be added to a shared document.'), { status: 413 });
      await this.transport.send(items.length === 1 ? items[0].update : Y.mergeUpdates(items.map(i => i.update)));
      await this.outbox.remove(items);
      this.retry = 0;
      this.setStatus('online');
    } catch (error) {
      if (refusedForGood(error)) {
        // The room will never take this change (access changed, or it is too large or invalid). Everything
        // queued after it builds on it, so the whole queue goes, and this copy starts again from the room's
        // state: changes of its own the room does not have would make every later one fail too.
        await this.outbox.remove([...this.outbox.items]);
        this.dispatchEvent(new CustomEvent('refused', { detail: { message: error.message } }));
        this.reset();
      } else {
        this.setStatus('offline');
        this.retry = Math.min(6, (this.retry || 0) + 1);
        setTimeout(() => this.scheduleSend(0), 500 * 2 ** this.retry);
      }
    } finally {
      this.sending = false;
      if (this.outbox.size && this.status === 'online') this.scheduleSend(this.sendDelay);
      this.dispatchEvent(new CustomEvent('status', { detail: { status: this.status, pending: this.outbox.size } }));
    }
  }

  /** Start again from the room's accepted state, as a new participant of the shared document. */
  reset() {
    const state = this.transport.state?.();
    if (!state || this.closed) return;
    this.ydoc.off('update', this.onLocalUpdate);
    this.ydoc = new Y.Doc();
    Y.applyUpdate(this.ydoc, state, 'initial');
    this.ydoc.on('update', this.onLocalUpdate);
    this.dispatchEvent(new Event('reset'));
  }

  /** Publish this person's caret, selection and name. */
  setPresence(state) {
    if (this.closed) return;
    this.localPresence = { session: this.session, user: this.user.id, name: this.user.name, color: this.color, role: this.role, ...state, at: Date.now() };
    this.transport.presence?.(this.localPresence);
  }

  setRoster(roster) {
    const now = Date.now();
    this.roster = roster.filter(p => p.session !== this.session && (!p.at || now - p.at < PRESENCE_TTL * 2));
    this.dispatchEvent(new CustomEvent('presence', { detail: { roster: this.roster } }));
  }

  /** Everyone here, this person first: { session, name, color, role, me }. */
  people() {
    const me = { session: this.session, user: this.user.id, name: this.user.name, color: this.color, role: this.role, me: true };
    const seen = new Set([this.session]);
    return [me, ...this.roster.filter(p => !seen.has(p.session) && seen.add(p.session))];
  }

  async close(reason = null) {
    if (this.closed) return;
    if (!reason) await this.send().catch(() => {});
    this.closed = true;
    clearTimeout(this.sendTimer);
    try { await this.transport.leave?.(); } catch { /* best effort */ }
    if (reason) this.dispatchEvent(new CustomEvent('closed', { detail: { reason } }));
  }
}
