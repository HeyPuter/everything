/**
 * Transports carry a shared document's updates and presence between people.
 *
 *   join(handlers)   → { state, role, base?, ... }; handlers: update(bytes),
 *                      presence(roster), role(role), closed(reason), online(bool)
 *   send(update)     → resolves when the room accepted it; throws { status }
 *   presence(state)  → publish this session's presence (fire and forget)
 *   leave()
 *
 * MemoryHub        an in-process room, for unit tests (with roles enforced).
 * BroadcastRoom    rooms between tabs of one browser (BroadcastChannel); the
 *                  playground's local co-editing and the browser tests. No
 *                  server: tabs answer each other's requests for the state.
 * WorkerTransport  a room on the owner's Puter worker (server/service.js).
 */
import * as Y from 'yjs';
import { canComment, canEdit, PRESENCE_TTL, encode, decode } from './protocol.js';

const refused = (status, message) => Object.assign(new Error(message), { status });

/* ---------- In-process hub (tests) ---------- */

export class MemoryHub {
  constructor(initialUpdate, { base = null } = {}) {
    this.doc = new Y.Doc();
    if (initialUpdate) Y.applyUpdate(this.doc, initialUpdate);
    this.base = base;
    this.peers = new Map();
    this.presence = new Map();
    this.paused = false;
    this.backlog = [];
  }
  /** A transport for one person with a role. */
  connect(role = 'editor') {
    const hub = this;
    let me = null;
    return {
      async join(handlers) {
        me = { handlers, role, session: null, online: true };
        hub.peers.set(handlers, me);
        return { state: Y.encodeStateAsUpdate(hub.doc), role, base: hub.base };
      },
      async send(update) {
        if (!me.online) throw refused(0, 'Offline');
        if (!canComment(me.role)) throw refused(403, 'You can only view this shared document.');
        if (!canEdit(me.role)) checkCommentOnly(hub.doc, update);
        Y.applyUpdate(hub.doc, update);
        hub.deliver(() => { for (const peer of hub.peers.values()) if (peer !== me && peer.online) peer.handlers.update(update); });
      },
      presence(state) {
        me.session = state.session;
        hub.presence.set(state.session, state);
        hub.deliver(() => hub.broadcastPresence());
      },
      async leave() { hub.peers.delete(me.handlers); if (me.session) hub.presence.delete(me.session); hub.broadcastPresence(); },
      setOnline(online) { me.online = online; me.handlers.online?.(online); if (online) hub.broadcastPresence(); },
      setRole(next) { me.role = next; me.handlers.role(next); },
    };
  }
  broadcastPresence() {
    const roster = [...this.presence.values()];
    for (const peer of this.peers.values()) if (peer.online) peer.handlers.presence(roster);
  }
  deliver(fn) { if (this.paused) this.backlog.push(fn); else fn(); }
  /** Hold deliveries (to simulate latency), then release them in order. */
  pause() { this.paused = true; }
  resume() { this.paused = false; for (const fn of this.backlog.splice(0)) fn(); }
}

/**
 * Whether an update from a comment-only participant changes only comments:
 * the comments map and comment anchors in the body. Everything else (text,
 * formatting, tables, styles) is refused. Used by the hub and the worker.
 */
export function checkCommentOnly(doc, update) {
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  const strip = ytext => ytext.toDelta().map(op => ({ insert: op.insert, attributes: Object.fromEntries(Object.entries(op.attributes || {}).filter(([k]) => !k.startsWith('m:bookmarks:comment:'))) }));
  const flatten = delta => {
    let out = '';
    for (const op of delta) { const a = JSON.stringify(Object.entries(op.attributes).sort()); for (const ch of String(op.insert)) out += `${ch}\u0001${a}\u0002`; }
    return out;
  };
  const before = flatten(strip(scratch.getText('body'))), parts = JSON.stringify(scratch.getMap('parts').toJSON()), meta = JSON.stringify(scratch.getMap('meta').toJSON());
  // Pictures are bytes and descriptions under their ids: replacing one keeps its id, so any write counts.
  let assets = false;
  scratch.getMap('assets').observe(() => { assets = true; });
  Y.applyUpdate(scratch, update);
  const ok = !assets && before === flatten(strip(scratch.getText('body'))) && parts === JSON.stringify(scratch.getMap('parts').toJSON()) && meta === JSON.stringify(scratch.getMap('meta').toJSON());
  scratch.destroy();
  if (!ok) throw refused(403, 'You can comment on this shared document but not change it.');
}

/* ---------- Tabs of one browser ---------- */

/**
 * A room between tabs of this browser. The tab that shares holds the state
 * and the base document; tabs that join ask everyone for what they lack.
 * Roles come from the link and are enforced by each tab's editor (there is no
 * server to enforce them): this transport is for evaluating co-editing
 * locally and for tests, not for sharing with other people.
 */
export class BroadcastRoom {
  constructor(room, { role = 'editor', initial = null, base = null, name = null } = {}) {
    this.room = room; this.role = role; this.initial = initial; this.base = base; this.name = name;
    this.peers = new Map();
  }
  async join(handlers) {
    this.handlers = handlers;
    this.session = handlers.session;
    this.doc = new Y.Doc();
    if (this.initial) Y.applyUpdate(this.doc, this.initial);
    this.channel = new BroadcastChannel(`documents-collab:${this.room}`);
    this.channel.onmessage = e => this.message(e.data);
    if (!this.initial) {
      // Ask the tabs already in the room for the state and the document it started from.
      const answer = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Nobody is sharing this document in this browser now. Open it from the tab that shared it.')), 4000);
        this.waiting = data => { clearTimeout(timer); resolve(data); };
        this.post({ type: 'hello', vector: encode(Y.encodeStateVector(this.doc)), wantBase: true });
      });
      Y.applyUpdate(this.doc, decode(answer.update));
      this.base = answer.base ? decode(answer.base) : null;
      this.name = answer.name || this.name;
    }
    this.heartbeat = setInterval(() => { if (this.lastPresence) this.presence(this.lastPresence); this.expire(); }, PRESENCE_TTL / 4);
    return { state: Y.encodeStateAsUpdate(this.doc), role: this.role, base: this.base, name: this.name };
  }
  post(message) { this.channel?.postMessage({ ...message, from: this.session, room: this.room }); }
  message(data) {
    if (!data || data.room !== this.room || data.from === this.session) return;
    if (data.type === 'hello') {
      this.post({ type: 'state', to: data.from, update: encode(Y.encodeStateAsUpdate(this.doc, decode(data.vector))), base: data.wantBase && this.base ? encode(this.base) : null, name: this.name });
      if (this.lastPresence) this.presence(this.lastPresence);
    } else if (data.type === 'state' && data.to === this.session) {
      if (this.waiting) { const waiting = this.waiting; this.waiting = null; waiting(data); }
      else { const update = decode(data.update); Y.applyUpdate(this.doc, update); this.handlers.update(update); }
    } else if (data.type === 'update') {
      const update = decode(data.update);
      Y.applyUpdate(this.doc, update);
      this.handlers.update(update);
    } else if (data.type === 'presence') {
      this.peers.set(data.from, { ...data.state, seen: Date.now() });
      this.emitRoster();
    } else if (data.type === 'bye') {
      this.peers.delete(data.from); this.emitRoster();
    } else if (data.type === 'closed') {
      this.handlers.closed('The person who shared this document stopped sharing it.');
    }
  }
  expire() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers) if (now - peer.seen > PRESENCE_TTL) { this.peers.delete(id); changed = true; }
    if (changed) this.emitRoster();
  }
  emitRoster() { this.handlers.presence([...this.peers.values()].map(({ seen, ...p }) => p)); }
  async send(update) {
    if (!canComment(this.role)) throw refused(403, 'You can only view this shared document.');
    if (!canEdit(this.role)) checkCommentOnly(this.doc, update);
    Y.applyUpdate(this.doc, update);
    this.post({ type: 'update', update: encode(update) });
  }
  presence(state) { this.lastPresence = state; this.post({ type: 'presence', state }); }
  /** Sharing stopped: the other tabs keep their copies and stop receiving changes. */
  stop() { this.post({ type: 'closed' }); }
  async leave() {
    this.post({ type: 'bye' });
    clearInterval(this.heartbeat);
    this.channel?.close(); this.channel = null;
  }
}

/* ---------- The owner's Puter worker ---------- */

/**
 * A room on a Puter worker (server/service.js). Changes are committed with a
 * request each; others' changes and the roster arrive with synchronization
 * requests, every second while others are here and every few seconds when
 * alone, and at once after a commit.
 */
export class WorkerTransport {
  /** call(op, input) performs a signed request (api.js). */
  constructor({ call, room, token = null }) { this.call = call; this.room = room; this.token = token; this.vector = null; }
  async join(handlers) {
    this.handlers = handlers;
    this.session = handlers.session;
    const joined = await this.call('join', { room: this.room, token: this.token });
    const synced = await this.call('sync', { room: this.room });
    this.doc = new Y.Doc();
    const state = decode(synced.update);
    Y.applyUpdate(this.doc, state);
    this.role = joined.role;
    this.schedule(300);
    return { ...joined, state, role: joined.role };
  }
  schedule(delay) {
    clearTimeout(this.timer);
    if (this.left) return;
    this.timer = setTimeout(() => this.poll(), delay);
  }
  async poll() {
    try {
      const vector = encode(Y.encodeStateVector(this.doc));
      const res = await this.call('sync', { room: this.room, vector, presence: this.lastPresence || null });
      if (this.offline) { this.offline = false; this.handlers.online?.(true); }
      if (res.role && res.role !== this.role) { this.role = res.role; this.handlers.role(res.role); }
      const update = decode(res.update || '');
      if (update.length > 2) {
        // Every answer repeats the room's deletions, which a state vector does not record: pass the update on
        // only when it inserted or deleted something this copy did not have, deletions alone included.
        let changed = false;
        const onUpdate = () => { changed = true; };
        this.doc.on('update', onUpdate);
        try { Y.applyUpdate(this.doc, update); } finally { this.doc.off('update', onUpdate); }
        if (changed) this.handlers.update(update);
      }
      if (res.roster) {
        // The worker stamps presence with its own clock; the client ages it by this computer's.
        const skew = Number.isFinite(res.serverTime) ? Date.now() - res.serverTime : 0;
        this.handlers.presence(res.roster.map(p => (Number.isFinite(p.at) ? { ...p, at: p.at + skew } : p)));
      }
      this.schedule(res.roster?.some(p => p.session !== this.session) ? 1000 : 3000);
    } catch (error) {
      if (error.status === 403 || error.status === 404 || error.status === 410) { this.left = true; this.handlers.closed(error.message); return; }
      if (!this.offline) { this.offline = true; this.handlers.online?.(false); }
      this.schedule(5000);
    }
  }
  async send(update) {
    await this.call('commit', { room: this.room, update: encode(update) });
    Y.applyUpdate(this.doc, update);
    this.schedule(50);
  }
  presence(state) {
    this.lastPresence = state;
    // Presence rides on the next synchronization; a moved caret asks for one soon.
    if (!this.presenceSoon) { this.presenceSoon = true; setTimeout(() => { this.presenceSoon = false; this.schedule(0); }, 400); }
  }
  async leave() {
    this.left = true; clearTimeout(this.timer);
    await this.call('leave', { room: this.room, session: this.session }).catch(() => {});
  }
}
