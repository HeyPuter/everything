// The page's library service: the repository (IndexedDB working copy plus
// the Puter copy while signed in), the current index for the panel, sync
// scheduling and change notices between tabs (BroadcastChannel, with a
// storage event as the fallback).
import { sha256Hex } from '../../model/provenance';
import { MemoryLocalStore, IndexedDbLibraryStore, LibraryRepository, PuterLibraryCloud, type CloudLibraryStore, type SyncStatus } from './storage';
import { emptyIndex, findItem, newId, uniqueName, type Library, type LibraryIndex, type LibraryItem, type LibraryOp } from './model';

type Listener = () => void;
const CHANNEL = 'photo-studio-libraries';
const PING_KEY = 'photo-studio-libraries-changed';

let cloudStore: CloudLibraryStore | undefined;
/** The Puter copy while signed in (the app's own folder). */
function cloud(): CloudLibraryStore | undefined {
  const p = (window as unknown as { puter?: { auth?: { isSignedIn?: () => boolean }; fs?: { read?: unknown; write?: unknown } } }).puter;
  try {
    if (!p?.auth?.isSignedIn?.() || typeof p.fs?.read !== 'function' || typeof p.fs?.write !== 'function') return undefined;
  } catch {
    return undefined;
  }
  cloudStore ??= new PuterLibraryCloud(p.fs as ConstructorParameters<typeof PuterLibraryCloud>[0]);
  return cloudStore;
}

/** A copy of an item with a new ID and times (no placement history). */
function fresh(item: LibraryItem, at: string): LibraryItem {
  const { moved: _moved, ...rest } = structuredClone(item);
  return { ...rest, id: newId(), created: at, modified: at };
}

class LibraryService {
  index: LibraryIndex = emptyIndex();
  loaded = false;
  private repo: LibraryRepository;
  private listeners = new Set<Listener>();
  private channel?: BroadcastChannel;
  private syncTimer = 0;
  private loading?: Promise<void>;
  constructor() {
    const local = typeof indexedDB !== 'undefined' ? new IndexedDbLibraryStore() : new MemoryLocalStore();
    this.repo = new LibraryRepository(local, cloud, undefined, () => this.emit());
  }
  get status(): SyncStatus {
    return this.repo.status;
  }
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of [...this.listeners]) fn();
  }
  /** Load the working copy once, then sync and listen for other tabs. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        this.index = await this.repo.index();
      } catch {
        // Storage refused (private mode): keep working in memory for this page.
        this.repo = new LibraryRepository(new MemoryLocalStore(), cloud, undefined, () => this.emit());
      }
      this.loaded = true;
      this.listen();
      this.emit();
      void this.sync();
    })();
    return this.loading;
  }
  private listen() {
    const reload = () => void this.reloadLocal();
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = reload;
    } catch {
      /* Older browsers: the storage event below. */
    }
    window.addEventListener('storage', (ev) => {
      if (ev.key === PING_KEY) reload();
    });
    window.addEventListener('focus', () => this.scheduleSync(300));
    window.addEventListener('online', () => this.scheduleSync(300));
  }
  private async reloadLocal() {
    this.index = await this.repo.index();
    this.emit();
  }
  private notifyTabs() {
    try {
      this.channel?.postMessage({ type: 'changed' });
      if (!this.channel) localStorage.setItem(PING_KEY, String(Date.now()));
    } catch {
      /* Other tabs pick changes up on focus. */
    }
  }
  scheduleSync(ms = 800) {
    clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => void this.sync(), ms);
  }
  async sync() {
    const before = JSON.stringify(this.index);
    this.index = await this.repo.sync();
    if (JSON.stringify(this.index) !== before) this.notifyTabs();
    this.emit();
  }
  /** Apply edits, show them at once and sync shortly after. */
  async apply(...ops: LibraryOp[]) {
    await this.load();
    this.index = await this.repo.apply(ops);
    this.emit();
    this.notifyTabs();
    this.scheduleSync();
  }
  async addAsset(blob: Blob): Promise<string> {
    const hash = await sha256Hex(blob);
    await this.repo.putAsset(hash, blob);
    return hash;
  }
  readAsset(hash: string) {
    return this.repo.readAsset(hash);
  }
  library(id: string | undefined): Library | undefined {
    return this.index.libraries.find((l) => l.id === id);
  }
  item(id: string | undefined) {
    return id ? findItem(this.index, id) : undefined;
  }

  // ----- Edits -----
  async createLibrary(name: string): Promise<Library> {
    const at = new Date().toISOString();
    const library: Library = { id: newId(), name: uniqueName(name, this.index.libraries.map((l) => l.name)), created: at, modified: at, items: [] };
    await this.apply({ op: 'create-library', library });
    return library;
  }
  renameLibrary(id: string, name: string) {
    return this.apply({ op: 'rename-library', id, name: name.trim().slice(0, 256) || 'Untitled', at: new Date().toISOString() });
  }
  deleteLibrary(id: string) {
    return this.apply({ op: 'delete-library', id, at: new Date().toISOString() });
  }
  async duplicateLibrary(id: string): Promise<Library | undefined> {
    const src = this.library(id);
    if (!src) return;
    const at = new Date().toISOString();
    const library: Library = { id: newId(), name: uniqueName(`${src.name} copy`, this.index.libraries.map((l) => l.name)), created: at, modified: at, items: src.items.map((i) => fresh(i, at)) };
    await this.apply({ op: 'create-library', library });
    return library;
  }
  moveLibrary(id: string, before?: string) {
    return this.apply({ op: 'move-library', id, before, at: new Date().toISOString() });
  }
  /** Add an item; `content`/`thumb` blobs become content-addressed assets. */
  async addItem(libraryId: string, item: Pick<LibraryItem, 'type' | 'name' | 'data'>, blobs: Record<string, Blob> = {}): Promise<LibraryItem> {
    const assets: Record<string, string> = {};
    for (const [role, blob] of Object.entries(blobs)) assets[role] = await this.addAsset(blob);
    const at = new Date().toISOString();
    const lib = this.library(libraryId);
    const full: LibraryItem = { id: newId(), type: item.type, name: uniqueName(item.name, lib?.items.filter((i) => i.type === item.type).map((i) => i.name) ?? []), created: at, modified: at, data: item.data, ...(Object.keys(assets).length ? { assets } : {}) };
    await this.apply({ op: 'put-item', library: libraryId, item: full });
    return full;
  }
  /** Replace an item's content (keeps its ID: linked placements update). */
  async updateItem(itemId: string, patch: Partial<Pick<LibraryItem, 'name' | 'data'>>, blobs?: Record<string, Blob>) {
    const found = this.item(itemId);
    if (!found) return;
    const assets = { ...(found.item.assets ?? {}) };
    for (const [role, blob] of Object.entries(blobs ?? {})) assets[role] = await this.addAsset(blob);
    const next: LibraryItem = { ...found.item, ...patch, modified: new Date().toISOString(), ...(Object.keys(assets).length ? { assets } : {}) };
    await this.apply({ op: 'put-item', library: found.library.id, item: next });
  }
  renameItem(itemId: string, name: string) {
    return this.updateItem(itemId, { name: name.trim().slice(0, 256) || 'Untitled' });
  }
  deleteItem(itemId: string) {
    const found = this.item(itemId);
    if (!found) return Promise.resolve();
    return this.apply({ op: 'delete-item', library: found.library.id, id: itemId, at: new Date().toISOString() });
  }
  moveItem(itemId: string, toLibrary: string, before?: string) {
    const found = this.item(itemId);
    if (!found) return Promise.resolve();
    return this.apply({ op: 'move-item', from: found.library.id, to: toLibrary, id: itemId, before, at: new Date().toISOString() });
  }
  async duplicateItem(itemId: string) {
    const found = this.item(itemId);
    if (!found) return;
    const at = new Date().toISOString();
    const lib = found.library;
    const at2 = lib.items.indexOf(found.item);
    const copy: LibraryItem = { ...fresh(found.item, at), name: uniqueName(`${found.item.name} copy`, lib.items.map((i) => i.name)) };
    await this.apply({ op: 'put-item', library: lib.id, item: copy, before: lib.items[at2 + 1]?.id });
    return copy;
  }
}

let service: LibraryService | undefined;
/** The page's library service (created on first use). */
export function libraries(): LibraryService {
  service ??= new LibraryService();
  return service;
}
