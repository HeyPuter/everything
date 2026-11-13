// Document versions and crash-recovery records kept in browser storage.
// Versions are whole .photo projects keyed by the document ID; recovery
// records hold the latest unsaved state of each open document.
import { localStore, type LocalStore } from './local-store';

export type VersionKind = 'auto' | 'save' | 'named';
export type VersionEntry = {
  id: string;
  docId: string;
  docName: string;
  name: string;
  kind: VersionKind;
  time: number;
  size: number;
  width: number;
  height: number;
  thumb?: Blob;
};

export class VersionStore {
  constructor(private store: LocalStore = localStore()) {}
  /** Store a version. Automatic and on-save versions beyond `keep` for the
   * document are removed oldest first; named versions are never pruned. */
  async add(entry: Omit<VersionEntry, 'id' | 'time' | 'size'> & { time?: number }, project: Blob, keep = 30): Promise<VersionEntry> {
    const full: VersionEntry = { ...entry, id: crypto.randomUUID(), time: entry.time ?? Date.now(), size: project.size };
    // The project and its entry are written together: a failed write (browser
    // storage full) must not leave a project that no version lists, taking up
    // space nothing can free.
    if (this.store.putAll)
      await this.store.putAll([
        { store: 'blobs', key: full.id, value: project },
        { store: 'versions', key: full.id, value: full },
      ]);
    else {
      await this.store.put('blobs', full.id, project);
      try {
        await this.store.put('versions', full.id, full);
      } catch (error) {
        await this.store.delete('blobs', full.id).catch(() => {});
        throw error;
      }
    }
    const automatic = (await this.list(full.docId)).filter((v) => v.kind !== 'named');
    for (const old of automatic.slice(Math.max(1, keep))) await this.remove(old.id);
    return full;
  }
  /** Versions of a document, newest first. */
  async list(docId: string): Promise<VersionEntry[]> {
    const all = await this.store.all<VersionEntry>('versions');
    return all.filter((v) => v.docId === docId).sort((a, b) => b.time - a.time);
  }
  /** Every stored version, newest first. */
  async listAll(): Promise<VersionEntry[]> {
    return (await this.store.all<VersionEntry>('versions')).sort((a, b) => b.time - a.time);
  }
  async get(id: string) {
    return this.store.get<VersionEntry>('versions', id);
  }
  async project(id: string): Promise<Blob | undefined> {
    return this.store.get<Blob>('blobs', id);
  }
  async rename(id: string, name: string) {
    const v = await this.get(id);
    if (!v) return;
    await this.store.put('versions', id, { ...v, name, kind: 'named' as const });
  }
  async remove(id: string) {
    await this.store.delete('versions', id);
    await this.store.delete('blobs', id);
  }
}

export type RecoveryRecord = {
  // The open document (session) the record belongs to.
  sessionId: string;
  // The page instance that wrote it; live instances' records are not offered.
  instance: string;
  docId: string;
  name: string;
  fileName?: string;
  path?: string;
  time: number;
  project: Blob;
  thumb?: Blob;
  // An unchanged ancestor is kept so an unsaved contents tab can reconnect.
  clean?: boolean;
  parent?: { sessionId: string; contents?: string; layerId: string; name: string; parentName: string };
};

export class RecoveryStore {
  constructor(private store: LocalStore = localStore()) {}
  async save(r: RecoveryRecord) {
    await this.store.put('recovery', r.sessionId, r);
  }
  async remove(sessionId: string) {
    await this.store.delete('recovery', sessionId);
  }
  async list(): Promise<RecoveryRecord[]> {
    return (await this.store.all<RecoveryRecord>('recovery')).sort((a, b) => b.time - a.time);
  }
  /** Records left by instances that are no longer running. */
  async orphaned(beats: Record<string, number>, now = Date.now(), ttl = 60_000): Promise<RecoveryRecord[]> {
    return (await this.list()).filter((r) => !(r.instance in beats) || now - beats[r.instance] > ttl);
  }
}

/** Live page instances from their heartbeat map, dropping stale entries. */
export function liveInstances(beats: Record<string, number>, now = Date.now(), ttl = 60_000): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(beats)) if (typeof t === 'number' && now - t <= ttl) out[k] = t;
  return out;
}

/** Short relative time for version lists ("just now", "5 min ago", a date). */
export function relativeTime(time: number, now = Date.now()): string {
  const s = Math.round((now - time) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(time).toLocaleDateString();
}
