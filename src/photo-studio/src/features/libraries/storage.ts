// Library storage and sync. The browser keeps the working copy (IndexedDB:
// the index, queued edits and asset blobs); when the user is signed in to
// Puter, the app's own Puter folder holds the shared copy (one JSON index and
// content-addressed asset files) and every sync replays the queued edits on
// the newest index there, writes it with a new revision and reads it back to
// confirm no other writer got in between (retrying when one did). Writes are
// therefore conflict-safe without server-side locking: concurrent edits from
// two tabs or devices both survive.
import { applyOps, emptyIndex, referencedAssets, validIndex, type LibraryIndex, type LibraryOp, type QueuedOp } from './model';

export type LocalState = {
  index: LibraryIndex;
  // Edits not yet written to the cloud copy (oldest first).
  pending: QueuedOp[];
  // Library IDs the cloud copy had at the last sync.
  cloudKnown: string[];
  // Asset hashes known to be stored in the cloud copy.
  uploaded: string[];
  // Edits already written, replayed for a while on every sync: a writer that
  // replaced the index without seeing them (no server-side locking) cannot
  // make them disappear for good.
  recent: (QueuedOp & { sent: number })[];
};
export const emptyLocalState = (): LocalState => ({ index: emptyIndex(), pending: [], cloudKnown: [], uploaded: [], recent: [] });
const MAX_PENDING = 300;
const MAX_RECENT = 200;
const RECENT_MS = 10 * 60_000;

/** Browser-side store. `update` is atomic across tabs. */
export interface LocalLibraryStore {
  read(): Promise<LocalState>;
  update<T>(fn: (s: LocalState) => T): Promise<{ state: LocalState; result: T }>;
  getAsset(hash: string): Promise<Blob | undefined>;
  putAsset(hash: string, blob: Blob): Promise<void>;
}
/** The shared copy (Puter). Reads of a missing index resolve undefined. */
export interface CloudLibraryStore {
  readIndex(): Promise<LibraryIndex | undefined>;
  writeIndex(index: LibraryIndex): Promise<void>;
  readAsset(hash: string): Promise<Blob | undefined>;
  writeAsset(hash: string, blob: Blob): Promise<void>;
}

function normalizeState(v: unknown): LocalState {
  const s = (v && typeof v === 'object' ? v : {}) as Partial<LocalState>;
  return {
    index: validIndex(s.index) ?? emptyIndex(),
    pending: Array.isArray(s.pending) ? s.pending.filter((o) => o && typeof o === 'object' && typeof o.opId === 'string') : [],
    cloudKnown: Array.isArray(s.cloudKnown) ? s.cloudKnown.filter((x) => typeof x === 'string') : [],
    uploaded: Array.isArray(s.uploaded) ? s.uploaded.filter((x) => typeof x === 'string') : [],
    recent: Array.isArray(s.recent) ? s.recent.filter((o) => o && typeof o === 'object' && typeof o.opId === 'string' && Number.isFinite(o.sent)) : [],
  };
}

/** In-memory local store (tests, browsers without IndexedDB). */
export class MemoryLocalStore implements LocalLibraryStore {
  private state = emptyLocalState();
  private assets = new Map<string, Blob>();
  async read() {
    return structuredClone(this.state);
  }
  async update<T>(fn: (s: LocalState) => T) {
    const next = structuredClone(this.state);
    const result = fn(next);
    this.state = normalizeState(next);
    return { state: structuredClone(this.state), result };
  }
  async getAsset(hash: string) {
    return this.assets.get(hash);
  }
  async putAsset(hash: string, blob: Blob) {
    this.assets.set(hash, blob);
  }
}

const STATE_KEY = 'local';
/** IndexedDB local store: database "photo-studio-libraries". */
export class IndexedDbLibraryStore implements LocalLibraryStore {
  private db?: Promise<IDBDatabase>;
  constructor(private name = 'photo-studio-libraries') {}
  private open() {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => {
        for (const s of ['state', 'assets']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error('Browser storage is unavailable.'));
      r.onblocked = () => reject(new Error('Browser storage is busy in another tab.'));
    });
    return this.db;
  }
  private async tx<T>(store: string, mode: IDBTransactionMode, body: (s: IDBObjectStore, done: (v: T) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      let value: T;
      body(t.objectStore(store), (v) => (value = v));
      t.oncomplete = () => resolve(value);
      t.onerror = () => reject(t.error ?? new Error('Browser storage failed.'));
      t.onabort = () => reject(t.error ?? new Error('Browser storage failed.'));
    });
  }
  async read() {
    return this.tx<LocalState>('state', 'readonly', (s, done) => {
      const r = s.get(STATE_KEY);
      r.onsuccess = () => done(normalizeState(r.result));
    });
  }
  async update<T>(fn: (s: LocalState) => T) {
    return this.tx<{ state: LocalState; result: T }>('state', 'readwrite', (s, done) => {
      const r = s.get(STATE_KEY);
      r.onsuccess = () => {
        const state = normalizeState(r.result);
        const result = fn(state);
        const next = normalizeState(state);
        s.put(next, STATE_KEY);
        done({ state: next, result });
      };
    });
  }
  async getAsset(hash: string) {
    return this.tx<Blob | undefined>('assets', 'readonly', (s, done) => {
      const r = s.get(hash);
      r.onsuccess = () => done(r.result instanceof Blob ? r.result : undefined);
    });
  }
  async putAsset(hash: string, blob: Blob) {
    await this.tx<void>('assets', 'readwrite', (s, done) => {
      s.put(blob, hash);
      done();
    });
  }
}

// ----- Puter -----
type PuterFs = {
  read(path: string): Promise<Blob>;
  write(path: string, data: Blob | string, options?: Record<string, unknown>): Promise<unknown>;
};
/** Puter calls never settle in some failure modes (and in tests); give up after a while. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out.`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
const notFound = (e: unknown) => {
  const x = e as { code?: string; message?: string } | undefined;
  return x?.code === 'subject_does_not_exist' || /does not exist|not found|no such/i.test(String(x?.message ?? e));
};
/** The cloud copy in the app's own Puter folder: relative paths resolve to
 * the app's data directory. */
export class PuterLibraryCloud implements CloudLibraryStore {
  constructor(
    private fs: PuterFs,
    private root = 'libraries',
    private timeout = 20_000,
  ) {}
  private async readPath(path: string): Promise<Blob | undefined> {
    try {
      return await withTimeout(this.fs.read(path), this.timeout, 'Reading from Puter');
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  }
  async readIndex() {
    const blob = await this.readPath(`${this.root}/index.json`);
    if (!blob) return undefined;
    let v: unknown;
    try {
      v = JSON.parse(await blob.text());
    } catch {
      throw new Error('The library index on Puter is damaged.');
    }
    const index = validIndex(v);
    if (!index) throw new Error('The library index on Puter was written by a newer version.');
    return index;
  }
  async writeIndex(index: LibraryIndex) {
    const blob = new Blob([JSON.stringify(index)], { type: 'application/json' });
    await withTimeout(this.fs.write(`${this.root}/index.json`, blob, { overwrite: true, createMissingParents: true }), this.timeout, 'Writing to Puter');
  }
  readAsset(hash: string) {
    return this.readPath(`${this.root}/assets/${hash}`);
  }
  async writeAsset(hash: string, blob: Blob) {
    await withTimeout(this.fs.write(`${this.root}/assets/${hash}`, blob, { overwrite: true, createMissingParents: true }), this.timeout * 3, 'Uploading to Puter');
  }
}

export type SyncState = 'local' | 'syncing' | 'synced' | 'offline' | 'error';
export type SyncStatus = { state: SyncState; message: string; at?: number };

const sameContent = (a: LibraryIndex, b: LibraryIndex) => JSON.stringify({ ...a, revision: 0, writer: '' }) === JSON.stringify({ ...b, revision: 0, writer: '' });

/** Working copy plus optional cloud copy, with queued edits and sync. */
export class LibraryRepository {
  status: SyncStatus = { state: 'local', message: 'Saved in this browser' };
  private syncing?: Promise<LibraryIndex>;
  constructor(
    public local: LocalLibraryStore,
    // The cloud copy while signed in; undefined keeps libraries in this browser.
    private cloud: () => CloudLibraryStore | undefined,
    private writerId: string = crypto.randomUUID(),
    private onStatus: (s: SyncStatus) => void = () => {},
  ) {}
  private setStatus(state: SyncState, message: string) {
    this.status = { state, message, at: Date.now() };
    this.onStatus(this.status);
  }
  async index() {
    return (await this.local.read()).index;
  }
  /** Apply edits to the working copy and queue them for the cloud copy. */
  async apply(ops: LibraryOp[]): Promise<LibraryIndex> {
    const queued = ops.map((o) => ({ ...o, opId: crypto.randomUUID() }) as QueuedOp);
    const { state } = await this.local.update((s) => {
      s.index = applyOps(s.index, ops);
      s.pending.push(...queued);
      if (s.pending.length > MAX_PENDING) s.pending.splice(0, s.pending.length - MAX_PENDING);
    });
    return state.index;
  }
  async putAsset(hash: string, blob: Blob) {
    if (!(await this.local.getAsset(hash))) await this.local.putAsset(hash, blob);
  }
  /** Asset bytes: the working copy, else the cloud copy (then kept locally). */
  async readAsset(hash: string): Promise<Blob | undefined> {
    const own = await this.local.getAsset(hash);
    if (own) return own;
    const cloud = this.cloud();
    // Unreachable cloud copy: fail at once rather than wait for a timeout.
    if (!cloud || this.status.state === 'offline') return undefined;
    const blob = await cloud.readAsset(hash);
    if (blob) await this.local.putAsset(hash, blob);
    return blob;
  }
  /** Write queued edits to the cloud copy and take in edits made elsewhere.
   * Without a cloud copy the working copy is the only one. */
  sync(): Promise<LibraryIndex> {
    this.syncing ??= this.runSync().finally(() => (this.syncing = undefined));
    return this.syncing;
  }
  private async runSync(): Promise<LibraryIndex> {
    const cloud = this.cloud();
    if (!cloud) {
      const { state } = await this.local.update((s) => {
        // Nothing to send edits to; they are already in the working copy.
        s.pending = [];
      });
      this.setStatus('local', 'Saved in this browser');
      return state.index;
    }
    this.setStatus('syncing', 'Syncing with Puter…');
    try {
      for (let attempt = 0; ; attempt++) {
        const remote = (await cloud.readIndex()) ?? emptyIndex();
        const local = await this.local.read();
        const sent = new Set(local.pending.map((o) => o.opId));
        const now = Date.now();
        const recent = local.recent.filter((o) => now - o.sent < RECENT_MS);
        let next = applyOps(remote, [...recent, ...local.pending]);
        // Libraries made here that the cloud copy never had (made while
        // signed out, or beyond the queue's length) are added.
        for (const lib of local.index.libraries)
          if (!next.libraries.some((l) => l.id === lib.id) && !next.deleted[lib.id] && !local.cloudKnown.includes(lib.id)) next.libraries.push(structuredClone(lib));
        // Content first, so the index never names a missing asset.
        const uploaded = new Set(local.uploaded);
        for (const h of referencedAssets(next)) {
          if (uploaded.has(h)) continue;
          const blob = await this.local.getAsset(h);
          if (blob) await cloud.writeAsset(h, blob);
          uploaded.add(h);
        }
        if (!sameContent(next, remote)) {
          // Narrow the window for a lost update: start over if the index
          // changed while assets uploaded.
          if (((await cloud.readIndex())?.writer ?? '') !== (remote.writer ?? '') && attempt < 4) continue;
          const nonce = `${this.writerId}:${crypto.randomUUID()}`;
          next = { ...next, revision: remote.revision + 1, writer: nonce };
          await cloud.writeIndex(next);
          const check = await cloud.readIndex();
          if (check?.writer !== nonce) {
            // Another writer replaced the index between our read and write:
            // replay on theirs.
            if (attempt < 4) continue;
            throw new Error('Libraries changed elsewhere too often to sync; try again.');
          }
        } else next = remote;
        const { state } = await this.local.update((s) => {
          s.recent = [...recent, ...s.pending.filter((o) => sent.has(o.opId)).map((o) => ({ ...o, sent: now }))].slice(-MAX_RECENT);
          s.pending = s.pending.filter((o) => !sent.has(o.opId));
          s.index = applyOps(next, s.pending);
          s.cloudKnown = next.libraries.map((l) => l.id);
          const keep = referencedAssets(next);
          s.uploaded = [...uploaded].filter((h) => keep.has(h));
        });
        this.setStatus('synced', 'Synced with Puter');
        return state.index;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      this.setStatus(offline || /timed out/.test(msg) ? 'offline' : 'error', offline ? 'Offline — changes are kept in this browser' : `Not synced: ${msg}`);
      return (await this.local.read()).index;
    }
  }
}
