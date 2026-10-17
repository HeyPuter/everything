/**
 * A shared space: a tree of pages that lives on a collaboration worker
 * (see worker/service.js). Edits are Yjs updates. They are kept locally
 * (memory and IndexedDB) until the worker confirms them, sent in small
 * batches, and merged with everyone else's. Live updates arrive through
 * Puter events on the space's signal key, which names the documents that
 * changed, so only those are fetched; a signal without that detail, or a
 * gap in the signal numbers, fetches every open document, and periodic
 * synchronization covers the rest. The flow follows the Whiteboard app's
 * collaboration session.
 */
import { Y, REMOTE, encodeBase64, decodeBase64 } from './ydoc.js';
import { Space, DOC_ID } from './space.js';
import { memoryCache } from './cache.js';
import { sha256Hex } from '../lib/hash.js';
import { uid } from '../lib/ids.js';

const LOAD = 'load';
const RESET = 'reset';
const FLUSH_DELAY = 500;
const RETRY = [2000, 4000, 8000, 15000, 30000];
const POLL_LIVE = 20000;
const POLL_SLOW = 6000;
const POLL_HIDDEN = 60000;
const HEARTBEAT = 20000;

export class AccessError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class SharedSpace extends Space {
  /**
   * @param request (op, data) => Promise<response>   talks to the worker
   * @param events  puter.events (optional) for live updates
   */
  constructor({ server, room, request, events = null, cache = memoryCache(), user = null, title = '', icon = null, role = 'viewer' }) {
    super({ id: room, kind: 'shared', role });
    this.server = server;
    this.room = room;
    this.requestFn = request;
    this.events = events;
    this.cache = cache;
    this.user = user;
    this.title = title;
    this.icon = icon;
    this.owner = null;
    this.entries = new Map();
    this.assetUrls = new Map();
    this.session = uid(16);
    this.page = null;
    this.roster = [];
    this.failures = 0;
    this.closed = false;
    this.subscription = null;
    // Documents to fetch on the next synchronization (id -> log keys signals named), or all of them.
    this.queued = new Map();
    this.queuedAll = false;
    this.signal = { docs: new Map(), all: false, people: false, seq: null };
  }

  request(op, data = {}) {
    return this.requestFn(op, { room: this.room, ...data });
  }

  cacheKey(id) {
    return `${this.user?.uuid || this.user?.username || 'me'}/room/${this.room}/${id}`;
  }

  /** Joins (with an invitation token when given) and loads the tree. */
  async open({ token } = {}) {
    let joined;
    try {
      joined = await this.request('join', token ? { token } : {});
    } catch (err) {
      // Offline with a local copy: open read from the cache and keep trying.
      if (!err.status && (await this.cache.get(this.cacheKey('tree')))) {
        this.setStatus('offline');
        joined = null;
      } else throw new AccessError(err.message, err.status);
    }
    if (joined) this.applyJoin(joined);
    const entry = await this.load('tree');
    this.tree = entry.doc;
    this.start();
    return this;
  }

  applyJoin(joined) {
    this.setRole(joined.role);
    this.title = joined.title || this.title;
    this.icon = joined.icon ?? this.icon;
    this.owner = joined.owner || null;
    this.ownerUuid = joined.ownerUuid || null;
    this.app = joined.app || null;
    this.settings = joined.settings || null;
    this.eventDescriptor = joined.events || null;
    this.joined = true;
  }

  start() {
    this.subscribe();
    this.heartbeat();
    this.schedulePoll();
    this.onVisible = () => {
      if (document.visibilityState === 'visible') this.synchronize();
      this.schedulePoll();
    };
    this.onOnline = () => {
      this.synchronize();
      for (const e of this.entries.values()) if (e.pending.length) this.flush(e);
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
  }

  async doc(id) {
    return (this.entries.get(id) || (await this.load(id))).doc;
  }

  hasDoc(id) {
    return this.entries.has(id);
  }

  async load(id) {
    if (!DOC_ID.test(id)) throw new Error(`bad document id ${id}`);
    if (this.entries.has(id)) return this.entries.get(id);
    this.loading ||= new Map();
    if (this.loading.has(id)) return this.loading.get(id);
    const promise = (async () => {
      const doc = new Y.Doc();
      const entry = { id, doc, pending: [], sending: null, timer: 0 };
      const cached = await this.cache.get(this.cacheKey(id));
      if (cached?.state) Y.applyUpdate(doc, cached.state, LOAD);
      if (cached?.pending?.length) entry.pending.push(...cached.pending.map((p) => decodeBase64(p)));
      try {
        const res = await this.request('sync', { docs: { [id]: encodeBase64(Y.encodeStateVector(doc)) } });
        this.afterSync(res);
        const update = res.updates?.[id];
        if (update) Y.applyUpdate(doc, decodeBase64(update), LOAD);
      } catch (err) {
        if (err.status === 403 || err.status === 404) throw new AccessError(err.message, err.status);
        if (!cached?.state) throw err;
        this.setStatus('offline');
      }
      doc.on('update', (update, origin) => this.onUpdate(entry, update, origin));
      this.entries.set(id, entry);
      this.persist(entry);
      if (entry.pending.length) this.scheduleFlush(entry);
      return entry;
    })();
    this.loading.set(id, promise);
    try {
      return await promise;
    } finally {
      this.loading.delete(id);
    }
  }

  onUpdate(entry, update, origin) {
    if (origin === RESET) return;
    if (origin !== REMOTE && origin !== LOAD) {
      if (!this.canWrite(entry.id)) {
        // A change this person may not save must not stay in the document:
        // their later edits would build on it and never be accepted.
        this.resetSoon(entry.id);
        return;
      }
      entry.pending.push(update);
      entry.lastLocal = Date.now();
      this.scheduleFlush(entry);
    }
    this.persistSoon(entry);
  }

  resetSoon(id) {
    clearTimeout(this.resetTimers?.get(id));
    this.resetTimers ||= new Map();
    this.resetTimers.set(id, setTimeout(() => this.resetDoc(id).catch(() => {}), 300));
  }

  /**
   * Replaces a document with the server's copy (after an edit was refused,
   * so nothing built on that edit is lost silently). Views showing it
   * re-open on the 'reset' event.
   */
  async resetDoc(id) {
    const entry = this.entries.get(id);
    if (!entry || this.closed) return;
    const res = await this.request('sync', { docs: { [id]: null } });
    const doc = new Y.Doc();
    if (res.updates?.[id]) Y.applyUpdate(doc, decodeBase64(res.updates[id]), RESET);
    const old = entry.doc;
    entry.doc = doc;
    entry.pending = [];
    doc.on('update', (update, origin) => this.onUpdate(entry, update, origin));
    if (id === 'tree') this.tree = doc;
    this.persist(entry);
    this.emit('reset', id);
    old.destroy();
  }

  canWrite(docId) {
    return docId.endsWith('.c') ? this.canComment : this.canEdit;
  }

  persistSoon(entry) {
    clearTimeout(entry.persistTimer);
    entry.persistTimer = setTimeout(() => this.persist(entry), 250);
  }

  persist(entry) {
    this.cache.set(this.cacheKey(entry.id), { state: Y.encodeStateAsUpdate(entry.doc), pending: entry.pending.map((u) => encodeBase64(u)) });
  }

  scheduleFlush(entry, delay = FLUSH_DELAY) {
    if (this.closed) return;
    this.setStatus('saving');
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.flush(entry).catch(() => {}), delay);
  }

  async flush(entry) {
    if (entry.sending) {
      entry.again = true;
      return entry.sending;
    }
    if (!entry.pending.length) return;
    entry.sending = (async () => {
      const count = entry.pending.length;
      const merged = count === 1 ? entry.pending[0] : Y.mergeUpdates(entry.pending.slice(0, count));
      try {
        const res = await this.request('commit', {
          doc: entry.id,
          update: encodeBase64(merged),
          id: await sha256Hex(merged),
          vector: encodeBase64(Y.encodeStateVector(entry.doc)),
          session: this.session,
        });
        entry.pending.splice(0, count);
        this.failures = 0;
        if (res.role) this.setRole(res.role);
        if (res.update) Y.applyUpdate(entry.doc, decodeBase64(res.update), REMOTE);
        this.persist(entry);
      } catch (err) {
        if (err.status === 403 || err.status === 413 || err.status === 400 || err.status === 422) {
          // The worker will refuse these again. Go back to the server's copy
          // (edits made after the refused one depend on it) and tell the caller.
          entry.pending.splice(0, count);
          this.emit('refused', err);
          if (err.status === 403) this.rejoin();
          this.refused = err;
          await this.resetDoc(entry.id).catch(() => {});
          throw err;
        } else {
          this.failures++;
          this.setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error', err.message);
          const delay = RETRY[Math.min(this.failures - 1, RETRY.length - 1)];
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => this.flush(entry).catch(() => {}), delay);
          throw err;
        }
      } finally {
        entry.sending = null;
      }
      if (entry.again || entry.pending.length) {
        entry.again = false;
        if (entry.pending.length) this.scheduleFlush(entry, 0);
      }
      this.updateStatus();
    })();
    return entry.sending;
  }

  updateStatus() {
    const busy = [...this.entries.values()].some((e) => e.pending.length || e.sending);
    this.setStatus(busy ? 'saving' : 'saved');
  }

  afterSync(res) {
    if (res?.role) this.setRole(res.role);
    if (res?.title !== undefined && res.title !== this.title) {
      this.title = res.title;
      this.emit('meta');
    }
  }

  /**
   * Reads what others saved, into the given open documents (a Map of id to
   * the log keys signals named for it), or into every open document.
   * Calls made while one runs are merged into the next round.
   */
  async synchronize(only = null) {
    if (this.closed) return;
    if (only) for (const [id, keys] of only) this.queue(id, keys);
    else this.queuedAll = true;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      while (!this.closed && (this.queuedAll || this.queued.size)) {
        const all = this.queuedAll;
        const hints = this.queued;
        this.queuedAll = false;
        this.queued = new Map();
        if (!(await this.syncRound(all ? null : [...hints.keys()], hints))) break;
      }
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  /** Adds a document to the next round, with log keys named for it (a key, or a list or set of them). */
  queue(id, keys = null) {
    const set = this.queued.get(id) || new Set();
    for (const k of typeof keys === 'string' ? [keys] : keys || []) if (typeof k === 'string') set.add(k);
    this.queued.set(id, set);
  }

  /** One synchronization request per 40 documents. Returns false when it failed. */
  async syncRound(ids, hints) {
    if (!ids) this.evict();
    const list = (ids || [...this.entries.keys()]).filter((id) => this.entries.has(id));
    if (!list.length) return true;
    try {
      // The worker answers up to 40 documents per request.
      for (let i = 0; i < list.length; i += 40) {
        const docs = {};
        const keys = {};
        for (const id of list.slice(i, i + 40)) {
          const e = this.entries.get(id);
          if (!e) continue;
          docs[id] = encodeBase64(Y.encodeStateVector(e.doc));
          // The worker reads up to 16 named records per document.
          if (hints.get(id)?.size) keys[id] = [...hints.get(id)].slice(-16);
        }
        const res = await this.request('sync', { docs, ...(Object.keys(keys).length ? { keys } : {}) });
        this.afterSync(res);
        for (const [id, update] of Object.entries(res.updates || {})) {
          const e = this.entries.get(id);
          if (e && update) Y.applyUpdate(e.doc, decodeBase64(update), REMOTE);
        }
      }
      if (this.status === 'offline' || this.status === 'error') this.updateStatus();
      return true;
    } catch (err) {
      if (err.status === 403 || err.status === 404) this.lost(err);
      else this.setStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error', err.message);
      return false;
    }
  }

  schedulePoll() {
    if (this.closed) return;
    clearTimeout(this.pollTimer);
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const delay = hidden ? POLL_HIDDEN : this.subscription ? POLL_LIVE : POLL_SLOW;
    this.pollTimer = setTimeout(async () => {
      await this.synchronize();
      this.schedulePoll();
    }, delay);
  }

  async rejoin() {
    try {
      this.applyJoin(await this.request('join'));
    } catch (err) {
      if (err.status === 403 || err.status === 404) this.lost(err);
    }
  }

  lost(err) {
    if (this.closed) return;
    this.setRole('viewer');
    this.emit('lost', new AccessError(err.message, err.status));
  }

  /* ---------- live updates and presence ---------- */

  async subscribe() {
    const d = this.eventDescriptor;
    if (this.closed || this.subscription || !d || !this.events?.onLocal) return;
    const subject = d.handle ? `kv:${d.handle}:${d.key}` : `kv:${d.app}:${d.key}`;
    try {
      let sub = null;
      let failed = false;
      sub = await this.events.onLocal(
        subject,
        (payload) => {
          if (!this.closed && !failed) this.onSignal(payload?.event?.value);
        },
        {
          includeValue: true,
          onError: () => {
            failed = true;
            if (this.subscription === sub) this.subscription = null;
            sub?.off?.();
            this.schedulePoll();
          },
        },
      );
      if (this.closed || failed) sub.off?.();
      else {
        this.subscription = sub;
        this.schedulePoll();
      }
    } catch {
      /* periodic synchronization keeps working */
    }
  }

  /** Notes what a live signal says changed; acts on a short batch of them. */
  onSignal(value) {
    const sig = this.signal;
    const docs = value?.docs;
    // This tab's own saves come back with the commit's answer already.
    const own = !!value?.session && value.session === this.session && !!value.by && value.by === this.user?.uuid;
    if (!Array.isArray(docs) || docs.length >= 32) sig.all = true;
    else if (!docs.length) sig.people = true;
    else if (!own) {
      for (const d of docs) {
        if (typeof d !== 'string') continue;
        const keys = sig.docs.get(d) || new Set();
        const key = value.keys?.[d];
        if (typeof key === 'string') keys.add(key);
        sig.docs.set(d, keys);
      }
    }
    if (Number.isInteger(value?.seq)) {
      // A skipped number is a signal that never arrived: its documents are
      // unknown. So are those of signals sent before the first one seen here.
      if (sig.seq === null || value.seq > sig.seq + 1) sig.all = true;
      if (sig.seq === null || value.seq > sig.seq) sig.seq = value.seq;
    } else {
      // An older worker does not number its signals, so a missed one would
      // go unnoticed: read everything, as clients did before.
      sig.all = true;
    }
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      const { all, docs: changed, people } = sig;
      sig.all = false;
      sig.people = false;
      sig.docs = new Map();
      if (all) {
        // One round for everything, still reading the named edits directly.
        for (const [id, keys] of changed) this.queue(id, keys);
        this.synchronize();
      } else if (changed.size) this.synchronize(changed);
      if (people) this.heartbeatSoon();
    }, 150);
  }

  heartbeatSoon() {
    if (this.beatTimer2) return;
    const wait = Math.max(0, (this.lastBeat || 0) + 4000 - Date.now());
    this.beatTimer2 = setTimeout(() => {
      this.beatTimer2 = null;
      this.heartbeat();
    }, wait);
  }

  async heartbeat(changed = false) {
    if (this.closed) return;
    clearTimeout(this.beatTimer);
    this.lastBeat = Date.now();
    try {
      const res = await this.request('presence', { session: this.session, page: this.page, changed });
      this.roster = (res.roster || []).filter((p) => p.session !== this.session);
      if (res.role) this.setRole(res.role);
      this.emit('presence', this.roster);
    } catch (err) {
      if (err.status === 403 || err.status === 404) this.lost(err);
    }
    if (!this.closed) this.beatTimer = setTimeout(() => this.heartbeat(), HEARTBEAT);
  }

  /** Tells others which page this person is looking at. */
  setPage(page) {
    if (this.page === page) return;
    this.page = page;
    this.heartbeat(true);
  }

  /* ---------- whole documents ---------- */

  async putDoc(id, state) {
    const entry = await this.load(id);
    Y.applyUpdate(entry.doc, state, 'import');
    await this.flush(entry);
    if (entry.pending.length) throw new Error('A page could not be saved to the shared space. Try again.');
  }

  async docState(id) {
    return Y.encodeStateAsUpdate(await this.doc(id));
  }

  async deleteDocs(ids, { purge = true } = {}) {
    // Once the tree no longer lists them, the worker wipes their edits too.
    if (purge && ids.length && this.canEdit) {
      await this.flushAll();
      this.request('purge', { pages: ids }).catch(() => {});
    }
    for (const id of ids) {
      for (const docId of [id, `${id}.c`]) {
        const e = this.entries.get(docId);
        if (e) {
          clearTimeout(e.timer);
          e.doc.destroy();
          this.entries.delete(docId);
        }
        await this.cache.del(this.cacheKey(docId));
      }
    }
  }

  async flushAll() {
    await Promise.allSettled([...this.entries.values()].map((e) => (e.pending.length || e.sending ? e.sending || this.flush(e) : null)));
  }

  /** Saves everything, and fails if anything was refused or is still unsent. */
  async ensureSaved() {
    this.refused = null;
    for (const e of this.entries.values()) {
      if (e.sending) await e.sending.catch(() => {});
      if (e.pending.length) await this.flush(e);
    }
    if (this.refused) throw this.refused;
    if (this.hasUnsaved()) throw new Error('Some changes could not be saved yet. Check your connection and try again.');
  }

  /** Documents not shown and fully saved stop being synchronized. */
  evict() {
    // A handful of documents costs nothing to keep; past that, drop the
    // ones nobody is looking at (search indexing reads many pages).
    if (this.entries.size <= 24) return;
    for (const [id, e] of this.entries) {
      // Something edited here in the last minutes is in use, held or not.
      if (this.isHeld(id) || e.pending.length || e.sending || Date.now() - (e.lastLocal || 0) < 5 * 60_000) continue;
      clearTimeout(e.timer);
      clearTimeout(e.persistTimer);
      this.persist(e);
      e.doc.destroy();
      this.entries.delete(id);
    }
  }

  hasUnsaved() {
    return [...this.entries.values()].some((e) => e.pending.length || e.sending);
  }

  /* ---------- page history ---------- */

  async listVersions(pageId) {
    const { versions } = await this.request('history.list', { doc: pageId });
    return versions.sort((a, b) => b.at - a.at);
  }

  async versionState(pageId, version) {
    const { state } = await this.request('history.get', { doc: pageId, at: version.at });
    return decodeBase64(state);
  }

  /* ---------- images ---------- */

  async putAsset(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await sha256Hex(bytes);
    const type = /^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(blob.type) ? blob.type : 'application/octet-stream';
    const data = `data:${type};base64,${encodeBase64(bytes)}`;
    await this.request('asset.put', { asset: hash, data });
    this.assetUrls.set(hash, Promise.resolve(URL.createObjectURL(new Blob([bytes], { type }))));
    return hash;
  }

  async assetBlob(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const key = this.cacheKey(`asset:${hash}`);
    let data = (await this.cache.get(key))?.data;
    if (!data) {
      data = (await this.request('asset.get', { asset: hash })).data;
      this.cache.set(key, { data });
    }
    const m = /^data:([^;]+);base64,(.*)$/.exec(data || '');
    return m ? new Blob([decodeBase64(m[2])], { type: m[1] }) : null;
  }

  assetUrl(hash) {
    if (!this.assetUrls.has(hash)) {
      const p = this.assetBlob(hash).then((b) => (b ? URL.createObjectURL(b) : null));
      p.catch(() => this.assetUrls.delete(hash));
      this.assetUrls.set(hash, p);
    }
    return this.assetUrls.get(hash);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.beatTimer);
    clearTimeout(this.beatTimer2);
    clearTimeout(this.eventTimer);
    for (const e of this.entries.values()) {
      clearTimeout(e.timer);
      clearTimeout(e.persistTimer);
    }
    this.subscription?.off?.();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    this.request('leave', { session: this.session }).catch(() => {});
  }
}
