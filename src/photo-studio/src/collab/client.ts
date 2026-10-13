// One browser's connection to a shared document: joining, synchronizing the
// Yjs state with the room worker, an outbox of local changes kept in browser
// storage until the worker accepts them (so changes made offline are sent
// when the connection returns, even after a reload), content-addressed tile
// uploads and downloads, change notifications, and live peer links for
// presence and low-latency edits. It knows nothing about the editor; see
// features/collab/session.ts for the binding.
import * as Y from 'yjs';
import { call, CollabError } from './api';
import { packAsset, unpackAsset, MAX_CHUNK } from './asset-codec';
import { decode, encode, hash, keyPair, MAX_PEER_UPDATE, verify, type Jwk, type KeyPair, type Role } from './protocol';
import { ORIGIN, SharedProject, documentTiles, type AssetRef, type Prepared } from './shared-project';
import { PeerNetwork, type Ticket } from './peers';
import { writeThread } from './ycomments';
import type { CommentThread } from './comments';
import type { CollabPuter } from './puter-types';
import type { TileIndex } from './tile-index';
import type { Assets } from '../model/assets';
import type { PhotoDocument } from '../model/document';
import type { LocalStore } from '../persistence/local-store';

export type OutboxStores = 'outbox' | 'blobs';
export type Outbox = LocalStore<OutboxStores>;
type OutboxEntry = { room: string; seq: number; update: Uint8Array; assets: string[] };

/** Restored outbox entries are applied with this origin (already queued). */
const RESTORED = { kind: 'restored' };

export type Presence = {
  // Pointer in document pixels, or null when outside the canvas.
  cursor: [number, number] | null;
  tool?: string;
  toolLabel?: string;
  layer?: string;
  layerBounds?: { x: number; y: number; width: number; height: number } | null;
  selection?: { x: number; y: number; width: number; height: number } | null;
  // Center of the view in document pixels and its zoom (for following).
  view?: { x: number; y: number; zoom: number };
};
export type Person = Presence & { session: string; user: string; username: string; role: string; at: number };

export type Status = {
  state: 'connecting' | 'connected' | 'syncing' | 'offline' | 'error' | 'closed';
  pending: number;
  message?: string;
};

const pad = (n: number) => String(n).padStart(12, '0');
const BATCH = 1_500_000;
const PUT_BYTES = 8_000_000;
const GET_BATCH = 24;

export class RoomClient {
  readonly project: SharedProject;
  readonly ydoc: Y.Doc;
  role: Role = 'viewer';
  user?: { uuid: string; username: string };
  owner = '';
  name = '';
  roomKey?: Jwk;
  status: Status = { state: 'connecting', pending: 0 };
  people = new Map<string, Person>();
  roster: Ticket[] = [];
  peers?: PeerNetwork;
  readonly session = crypto.randomUUID().replaceAll('-', '');
  private keys?: KeyPair;
  private seq = 0;
  private staged = new Set<string>();
  private staging: Promise<void> = Promise.resolve();
  private flushing?: Promise<void>;
  private flushAgain = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;
  private timers: ReturnType<typeof setInterval>[] = [];
  private syncTimer?: ReturnType<typeof setTimeout>;
  private subscription?: { off(): void };
  private closed = false;
  private uploaded = new Set<string>();
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private lastPresence?: Presence;
  private lastPresenceSent = 0;
  constructor(
    public o: {
      puter: CollabPuter;
      server: string;
      room: string;
      token?: string;
      tiles: TileIndex;
      assets: Assets;
      store: Outbox;
      ydoc?: Y.Doc;
      // A remote change reached the Yjs document.
      onRemote?: () => void;
      onStatus?: () => void;
      onPeople?: () => void;
      // The worker refused a change for good; queued changes were dropped.
      onRefused?: (message: string) => void;
      // Polling interval without live links (ms).
      poll?: number;
      // Disables peer links (tests of the worker path alone).
      noPeers?: boolean;
    },
  ) {
    this.project = new SharedProject(o.tiles, o.ydoc);
    this.ydoc = this.project.ydoc;
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === ORIGIN.remote || origin === RESTORED || this.closed) return;
      this.enqueue(update);
    });
    this.ydoc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.origin === ORIGIN.remote && (tr.changed.size || tr.deleteSet.clients.size)) this.o.onRemote?.();
    });
  }
  private request<T = Record<string, unknown>>(input: Record<string, unknown>) {
    return call<T>(this.o.puter, this.o.server, { room: this.o.room, ...input });
  }
  get canEdit() {
    return this.role === 'owner' || this.role === 'editor';
  }
  get canComment() {
    return this.canEdit || this.role === 'commenter';
  }

  // ----- Creating and joining -----

  /** Upload a document and create its room (owner). Returns the room ID. */
  static async create(
    o: { puter: CollabPuter; server: string; tiles: TileIndex; assets: Assets; doc: PhotoDocument; comments: CommentThread[]; ydoc: Y.Doc },
    progress: (fraction: number) => void = () => {},
  ) {
    const room = crypto.randomUUID().replaceAll('-', '');
    const project = new SharedProject(o.tiles, o.ydoc);
    const prepared = await project.prepare(o.doc, o.assets);
    project.write(null, o.doc, prepared, ORIGIN.untracked);
    o.ydoc.transact(() => {
      for (const t of o.comments) writeThread(o.ydoc, t);
    }, ORIGIN.untracked);
    // Every tile and asset chunk, then the state itself in chunks.
    const uploads: (() => Promise<{ hash: string; data: string }>)[] = [];
    const seen = new Set<string>();
    for (const id of documentTiles(o.doc)) {
      const h = o.tiles.hashOf(id)!;
      if (seen.has(h)) continue;
      seen.add(h);
      uploads.push(async () => ({ hash: h, data: packAsset(o.tiles.store.get(id) as unknown as Uint8Array) }));
    }
    for (const { ref, chunks } of prepared.assets.values())
      ref.chunks.forEach((h, i) => {
        if (seen.has(h)) return;
        seen.add(h);
        uploads.push(async () => ({ hash: h, data: packAsset(new Uint8Array(await chunks[i].arrayBuffer())) }));
      });
    const state = Y.encodeStateAsUpdate(o.ydoc);
    const initial: string[] = [];
    for (let at = 0; at < state.length || at === 0; at += MAX_CHUNK) {
      const part = state.slice(at, at + MAX_CHUNK);
      const h = await hash(part);
      initial.push(h);
      if (!seen.has(h)) {
        seen.add(h);
        uploads.push(async () => ({ hash: h, data: packAsset(part) }));
      }
      if (!state.length) break;
    }
    const send = (assets: { hash: string; data: string }[]) => call(o.puter, o.server, { op: 'asset.put', room, assets });
    let batch: { hash: string; data: string }[] = [],
      size = 0;
    for (let i = 0; i < uploads.length; i++) {
      const a = await uploads[i]();
      if (size + a.data.length > PUT_BYTES && batch.length) {
        await send(batch);
        batch = [];
        size = 0;
      }
      batch.push(a);
      size += a.data.length;
      progress((i + 1) / (uploads.length + 1));
    }
    if (batch.length) await send(batch);
    await call(o.puter, o.server, { op: 'create', room, initial, name: o.doc.name });
    progress(1);
    return room;
  }

  /** Join the room: admission, full state, outbox recovery, live links. */
  async join() {
    const res = await this.request<{ role: Role; user: { uuid: string; username: string }; owner: string; publicKey: Jwk; name: string; events: { app?: string; handle?: string; key: string } | null }>({
      op: 'join',
      ...(this.o.token ? { token: this.o.token } : {}),
    });
    this.role = res.role;
    this.user = res.user;
    this.owner = res.owner;
    this.roomKey = res.publicKey;
    this.name = res.name;
    await this.sync();
    // Changes this browser made earlier and never delivered.
    const queued = await this.queued();
    this.seq = queued.at(-1)?.seq ?? 0;
    if (queued.length) {
      this.ydoc.transact(() => {
        for (const e of queued) Y.applyUpdate(this.ydoc, e.update, RESTORED);
      }, RESTORED);
      this.o.onRemote?.();
    }
    this.setStatus();
    void this.subscribe(res.events);
    this.timers.push(
      setInterval(() => {
        if (!this.connectedPeers() || Date.now() - this.lastSync > 20_000) this.scheduleSync(0);
      }, this.o.poll ?? 4000),
    );
    this.timers.push(setInterval(() => void this.checkIn().catch(() => {}), 30_000));
    this.timers.push(setInterval(() => this.expirePeople(), 2000));
    if (!this.o.noPeers && this.o.puter.peer) await this.checkIn().catch(() => {});
    if (queued.length) this.flush();
  }
  private async queued(): Promise<OutboxEntry[]> {
    return (await this.o.store.all<OutboxEntry>('outbox')).filter((e) => e.room === this.o.room).sort((a, b) => a.seq - b.seq);
  }
  private connectedPeers() {
    return this.peers?.connectedSessions.length ?? 0;
  }

  private async subscribe(events: { app?: string; handle?: string; key: string } | null) {
    if (!events || !this.o.puter.events?.onLocal || this.closed) return;
    const subject = events.handle ? `kv:${events.handle}:${events.key}` : `kv:${events.app}:${events.key}`;
    try {
      // A notice carries no data: it prompts a synchronization (and, as
      // people joining also signal, a check-in for the roster).
      this.subscription = await this.o.puter.events.onLocal(
        subject,
        () => {
          this.scheduleSync(150);
          this.soonCheckIn();
        },
        { includeValue: false },
      );
      if (this.closed) this.subscription.off();
    } catch {
      /* Polling and peer notices still deliver changes. */
    }
  }

  // ----- Synchronizing -----

  private lastSync = 0;
  private syncing?: Promise<void>;
  scheduleSync(delay = 150) {
    if (this.closed || this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      this.sync().catch((e) => this.failed(e));
    }, delay);
  }
  /** Fetch edits the worker has and this browser lacks. */
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const res = await this.request<{ update: string; role: Role }>({ op: 'sync', vector: encode(Y.encodeStateVector(this.ydoc)) });
      this.lastSync = Date.now();
      if (res.role !== this.role) {
        this.role = res.role;
        this.o.onPeople?.();
      }
      Y.applyUpdate(this.ydoc, decode(res.update), ORIGIN.remote);
      if (this.status.state === 'offline' || this.status.state === 'connecting') this.setStatus();
    })().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  // ----- Outbox -----

  /** Keep what a local edit needs uploaded (new tiles, new asset chunks)
   * until the edit is delivered. Call before writing the edit. */
  stage(prepared: Prepared) {
    const items: [string, () => Promise<Uint8Array> | Uint8Array][] = [];
    for (const [id, h] of prepared.tiles) {
      if (this.uploaded.has(h)) continue;
      const bytes = this.o.tiles.store.get(id) as unknown as Uint8Array;
      items.push([h, () => bytes]);
    }
    for (const { ref, chunks } of prepared.assets.values()) ref.chunks.forEach((h, i) => items.push([h, async () => new Uint8Array(await chunks[i].arrayBuffer())]));
    for (const [h] of items) this.staged.add(h);
    if (!items.length) return;
    this.staging = this.staging.then(async () => {
      for (const [h, read] of items) {
        const key = `${this.o.room}:${h}`;
        if (await this.o.store.get('blobs', key)) continue;
        await this.o.store.put('blobs', key, packAsset(await read()));
      }
    });
  }
  private enqueue(update: Uint8Array) {
    const entry: OutboxEntry = { room: this.o.room, seq: ++this.seq, update, assets: [...this.staged] };
    this.staged.clear();
    this.status.pending++;
    this.staging = this.staging.then(() => this.o.store.put('outbox', `${this.o.room}:${pad(entry.seq)}`, entry));
    this.setStatus();
    this.flush();
  }
  /** Deliver queued changes (debounced; one delivery at a time). */
  flush() {
    if (this.closed) return;
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    clearTimeout(this.retryTimer);
    this.flushing = (async () => {
      try {
        do {
          this.flushAgain = false;
          await this.staging;
          await this.deliver();
        } while (this.flushAgain && !this.closed);
        this.retryDelay = 1000;
      } catch (error) {
        this.failed(error);
        if (!this.closed && !(error instanceof CollabError && [401, 403, 404, 410].includes(error.status))) {
          this.retryTimer = setTimeout(() => this.flush(), this.retryDelay);
          this.retryDelay = Math.min(30_000, this.retryDelay * 2);
        }
      }
    })().finally(() => {
      this.flushing = undefined;
      this.setStatus();
    });
  }
  /** Resolves once everything queued so far is delivered (or fails). */
  async settled() {
    await this.staging;
    while (this.flushing) await this.flushing;
  }
  private async deliver() {
    for (;;) {
      const entries = await this.queued();
      this.status.pending = entries.length;
      if (!entries.length) return;
      const batch: OutboxEntry[] = [];
      let size = 0;
      for (const e of entries) {
        if (batch.length && size + e.update.length > BATCH) break;
        batch.push(e);
        size += e.update.length;
      }
      await this.upload(batch.flatMap((e) => e.assets));
      const update = batch.length === 1 ? batch[0].update : Y.mergeUpdates(batch.map((e) => e.update));
      const id = await hash(update);
      const text = encode(update);
      let res: { receipt: string; seq: number };
      try {
        res = await this.request<{ receipt: string; seq: number }>({ op: 'commit', update: text, id });
      } catch (error) {
        if (error instanceof CollabError && error.status === 409) {
          // Edits this one builds on have not reached the worker yet: catch
          // up first. If they never arrive (they were refused), this copy
          // cannot be saved and the editor opens the shared state again.
          if (++this.conflicts >= 4) {
            await this.discard();
            this.o.onRefused?.(error.message);
            return;
          }
          await this.sync();
          throw error;
        }
        if (error instanceof CollabError && [400, 403, 413, 422].includes(error.status)) {
          // Refused for good. Later queued changes may build on it, so they
          // are dropped too, and the editor opens the shared state again.
          await this.discard();
          this.refused = error.message;
          this.o.onRefused?.(error.message);
          return;
        }
        throw error;
      }
      this.conflicts = 0;
      for (const e of batch) await this.o.store.delete('outbox', `${this.o.room}:${pad(e.seq)}`);
      this.status.pending = Math.max(0, entries.length - batch.length);
      if (text.length <= MAX_PEER_UPDATE) void this.peers?.broadcast('edit', { update: text, id, receipt: res.receipt });
      else void this.peers?.broadcast('committed', { seq: res.seq });
    }
  }
  private conflicts = 0;
  /** The last change the worker refused, for the editor to report. */
  refused?: string;
  /** Forget every queued change of this room (and its staged uploads). */
  async discard() {
    for (const e of await this.queued()) {
      await this.o.store.delete('outbox', `${this.o.room}:${pad(e.seq)}`);
      for (const h of e.assets) await this.o.store.delete('blobs', `${this.o.room}:${h}`);
    }
    this.status.pending = 0;
  }
  private async upload(hashes: string[]) {
    let batch: { hash: string; data: string }[] = [],
      size = 0;
    const send = async () => {
      if (!batch.length) return;
      await this.request({ op: 'asset.put', assets: batch });
      for (const a of batch) {
        this.uploaded.add(a.hash);
        await this.o.store.delete('blobs', `${this.o.room}:${a.hash}`);
      }
      batch = [];
      size = 0;
    };
    for (const h of new Set(hashes)) {
      if (this.uploaded.has(h)) continue;
      const data = await this.o.store.get<string>('blobs', `${this.o.room}:${h}`);
      // Already uploaded in an earlier session (its blob was removed then).
      if (!data) continue;
      if (size + data.length > PUT_BYTES) await send();
      batch.push({ hash: h, data });
      size += data.length;
    }
    await send();
  }
  // ----- Assets -----

  /** Download tiles by content hash into the tile store. */
  async fetchTiles(hashes: Iterable<string>) {
    const list = [...new Set(hashes)].filter((h) => !this.o.tiles.tileFor(h));
    let got = 0;
    for (let i = 0; i < list.length; i += GET_BATCH) {
      const res = await this.request<{ assets: Record<string, string> }>({ op: 'asset.get', hashes: list.slice(i, i + GET_BATCH) });
      for (const [h, data] of Object.entries(res.assets)) {
        if (!list.includes(h)) continue;
        // A local blob (not yet uploaded) also satisfies a request.
        this.o.tiles.put(h, await unpackAsset(data, h));
        got++;
      }
    }
    // Tiles staged here but not yet delivered.
    for (const h of list)
      if (!this.o.tiles.tileFor(h)) {
        const data = await this.o.store.get<string>('blobs', `${this.o.room}:${h}`);
        if (data) {
          this.o.tiles.put(h, await unpackAsset(data, h));
          got++;
        }
      }
    return got;
  }
  /** Download an asset (image, embedded project, footage) by its chunks. */
  async fetchAsset(id: string, ref: AssetRef) {
    if (this.o.assets.has(id)) return;
    if (!Array.isArray(ref?.chunks) || ref.chunks.length > 128 || typeof ref.type !== 'string') throw new Error('Invalid shared asset.');
    const parts: Uint8Array[] = [];
    for (const h of ref.chunks) {
      const res = await this.request<{ assets: Record<string, string> }>({ op: 'asset.get', hashes: [h] });
      const data = res.assets[h] ?? (await this.o.store.get<string>('blobs', `${this.o.room}:${h}`));
      if (!data) throw new CollabError('A shared image is not available yet.', 404);
      parts.push(await unpackAsset(data, h));
    }
    if (this.o.assets.has(id)) return;
    await this.o.assets.add(new Blob(parts as BlobPart[], { type: ref.type }), id);
  }

  // ----- People -----

  private checkInTimer?: ReturnType<typeof setTimeout>;
  private lastCheckIn = 0;
  /** Check in shortly (at most every two seconds). */
  soonCheckIn() {
    if (this.closed || this.checkInTimer || !this.peers) return;
    this.checkInTimer = setTimeout(() => {
      this.checkInTimer = undefined;
      void this.checkIn().catch(() => {});
    }, Math.max(100, 2000 - (Date.now() - this.lastCheckIn)));
  }
  private checkingIn?: Promise<void>;
  /** Renew this session's peer ticket and learn who is here. */
  async checkIn() {
    if (this.closed || this.o.noPeers || !this.o.puter.peer) return;
    if (this.checkingIn) return this.checkingIn;
    this.checkingIn = (async () => {
      this.keys ??= await keyPair();
      this.peers ??= new PeerNetwork({
        peer: this.o.puter.peer!,
        session: this.session,
        keys: this.keys,
        roomKey: this.roomKey!,
        room: this.o.room,
        receive: (kind, data, ticket) => this.receive(kind, data, ticket),
        changed: () => void this.checkIn().catch(() => {}),
        stranger: () => this.soonCheckIn(),
        linked: () => {
          this.o.onPeople?.();
          if (this.lastPresence) this.sendPresence(true);
        },
      });
      await this.peers.serve().catch(() => {});
      this.lastCheckIn = Date.now();
      const res = await this.request<{ ticket: Ticket; signature: string; roster: Ticket[]; role: Role }>({ op: 'presence', session: this.session, publicKey: this.keys.publicKey, invite: this.peers.invite });
      if (this.closed) return;
      this.roster = res.roster;
      if (res.role !== this.role) this.role = res.role;
      this.peers.update(res.ticket, res.signature, res.roster);
      for (const s of [...this.people.keys()]) if (!res.roster.some((t) => t.session === s)) this.people.delete(s);
      this.o.onPeople?.();
    })().finally(() => (this.checkingIn = undefined));
    return this.checkingIn;
  }
  private async receive(kind: string, data: unknown, ticket: Ticket) {
    if (ticket.session === this.session) return false;
    if (kind === 'presence' && data && typeof data === 'object') {
      const p = data as Presence;
      this.people.set(ticket.session, { ...sanitizePresence(p), session: ticket.session, user: ticket.user, username: ticket.username, role: ticket.role, at: Date.now() });
      this.o.onPeople?.();
      return;
    }
    if (kind === 'leave') {
      this.people.delete(ticket.session);
      this.o.onPeople?.();
      return;
    }
    if (kind === 'committed') {
      this.scheduleSync(100);
      return;
    }
    if (kind === 'edit') {
      const d = data as { update?: unknown; id?: unknown; receipt?: unknown };
      // Only edits the worker accepted (its receipt names this sender) apply.
      if (typeof d?.update !== 'string' || typeof d.id !== 'string' || !this.roomKey) return false;
      const bytes = decode(d.update, MAX_PEER_UPDATE);
      if ((await hash(bytes)) !== d.id || !(await verify(this.roomKey, { room: this.o.room, id: d.id, user: ticket.user }, d.receipt))) return false;
      Y.applyUpdate(this.ydoc, bytes, ORIGIN.remote);
    }
  }
  private expirePeople() {
    let changed = false;
    for (const [s, p] of this.people)
      if (Date.now() - p.at > 15_000) {
        this.people.delete(s);
        changed = true;
      }
    if (changed) this.o.onPeople?.();
    // A quiet pulse keeps this person's presence alive for others.
    if (this.lastPresence && Date.now() - this.lastPresenceSent > 3000) this.sendPresence(true);
  }
  /** Share this person's pointer, tool, layer, selection and view (throttled). */
  setPresence(p: Presence) {
    this.lastPresence = p;
    this.sendPresence(false);
  }
  private sendPresence(now: boolean) {
    if (!this.peers || this.closed) return;
    const wait = now ? 0 : Math.max(0, 50 - (Date.now() - this.lastPresenceSent));
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      this.lastPresenceSent = Date.now();
      if (this.lastPresence) void this.peers?.broadcast('presence', this.lastPresence);
    }, wait);
  }

  // ----- Status -----

  private failed(error: unknown) {
    if (this.closed) return;
    if (error instanceof CollabError && !error.network) {
      if ([401, 403, 404, 410].includes(error.status)) {
        this.status = { state: 'error', pending: this.status.pending, message: error.message };
        this.o.onStatus?.();
        return;
      }
    }
    if (error instanceof CollabError && error.network) this.status = { state: 'offline', pending: this.status.pending, message: error.message };
    this.o.onStatus?.();
  }
  private setStatus() {
    if (this.closed || this.status.state === 'error') return this.o.onStatus?.();
    const pending = this.status.pending;
    const state = this.status.state === 'offline' && pending ? 'offline' : pending ? 'syncing' : 'connected';
    this.status = { state, pending };
    this.o.onStatus?.();
  }

  /** Leave the room: deliver what is queued (briefly), then close links. */
  async leave() {
    if (this.closed) return;
    await Promise.race([this.settled(), new Promise((r) => setTimeout(r, 3000))]);
    void this.peers?.broadcast('leave', {});
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
    this.status = { state: 'closed', pending: this.status.pending };
  }
}

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
const rect = (r: unknown) => {
  const x = r as { x: number; y: number; width: number; height: number };
  return x && finite(x.x) && finite(x.y) && finite(x.width) && finite(x.height) ? { x: x.x, y: x.y, width: x.width, height: x.height } : null;
};
/** Keep only well-formed presence fields (it comes from other people). */
export function sanitizePresence(p: Presence): Presence {
  const c = p.cursor;
  return {
    cursor: Array.isArray(c) && c.length === 2 && c.every(finite) ? [c[0], c[1]] : null,
    tool: typeof p.tool === 'string' ? p.tool.slice(0, 64) : undefined,
    toolLabel: typeof p.toolLabel === 'string' ? p.toolLabel.slice(0, 64) : undefined,
    layer: typeof p.layer === 'string' ? p.layer.slice(0, 100) : undefined,
    layerBounds: rect(p.layerBounds),
    selection: rect(p.selection),
    view: p.view && finite(p.view.x) && finite(p.view.y) && finite(p.view.zoom) && p.view.zoom > 0 ? { x: p.view.x, y: p.view.y, zoom: Math.min(64, Math.max(0.01, p.view.zoom)) } : undefined,
  };
}
