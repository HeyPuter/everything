/**
 * Working together on a project kept in the cloud. The project file is
 * the shared copy: saving merges in what others saved since this copy
 * last synchronized (element by element, see core/sync.js) before
 * writing, so nobody overwrites anyone else's work. While the project is
 * open the file is checked every few seconds and others' changes come in
 * automatically.
 */
import { decodeProject, encodeProject } from './native.js';
import { cloudRead, cloudWrite, cloudVersion } from './storage.js';
import { mergeRemote, sameItem } from '../core/sync.js';
import { upgradeDoc } from '../core/template.js';
import { newId } from '../core/doc.js';

const POLL_MS = 8000;
const LOG_LIMIT = 40;

export class SyncManager {
  constructor(app) {
    this.app = app;
    this.base = null;
    this.path = null;
    this.version = null;
    this.timer = 0;
    this.busy = null;
    this.state = 'off';
    this.lastSync = 0;
    this.lastConflicts = [];
    this.listeners = new Set();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.active) this.poll();
    });
  }

  get active() {
    return !!this.base;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setState(state) {
    this.state = state;
    for (const fn of this.listeners) fn(state);
  }

  /**
   * Start tracking the open project. `snapshot` is the item map that the
   * cloud file holds (defaults to the document as it is now).
   */
  attach(snapshot = null, version = null, dirty = false) {
    clearInterval(this.timer);
    const app = this.app;
    const f = app.file;
    const cloud = f?.source === 'cloud' && f.path && typeof puter !== 'undefined';
    this.base = null;
    this.path = cloud ? f.path : null;
    this.version = version;
    this.lastConflicts = [];
    if (!cloud) return this.setState('off');
    const start = (base) => {
      this.base = base;
      this.lastSync = Date.now();
      this.timer = setInterval(() => this.poll(), POLL_MS);
    };
    if (!dirty || snapshot) {
      start(snapshot || new Map(app.doc.items));
      this.setState('synced');
      if (!version) cloudVersion(this.path).then((v) => (this.version ??= v), () => {});
      return;
    }
    // A restored copy with unsaved changes: compare against the cloud file, not against itself.
    const doc = app.doc;
    const path = this.path;
    this.setState('syncing');
    this.run(async () => {
      const v = await cloudVersion(path);
      const remote = upgradeDoc(await decodeProject(await cloudRead(path)));
      if (app.doc !== doc || this.path !== path) return;
      const base = new Map();
      for (const [id, r] of remote.items) {
        const l = doc.items.get(id);
        base.set(id, l && sameItem(l, r) ? l : r);
      }
      this.version = v;
      start(base);
      this.setState('pending');
    }).catch(() => this.setState('offline'));
  }

  detach() {
    clearInterval(this.timer);
    this.base = null;
    this.path = null;
    this.setState('off');
  }

  /** Check whether someone else saved, and bring their changes in. */
  async poll() {
    if (!this.active || this.busy || document.hidden || this.app.doc.inTransaction || this.app.tool?.busy) return;
    if (this.app.settings.autoSync === false) return;
    try {
      const v = await cloudVersion(this.path);
      if (v === this.version) return;
      await this.run(() => this.pull(v));
    } catch {
      this.setState('offline');
    }
  }

  async run(fn) {
    if (this.busy) await this.busy.catch(() => {});
    this.busy = fn();
    try {
      return await this.busy;
    } finally {
      this.busy = null;
    }
  }

  /** Merge the cloud copy into the open document. */
  async pull(knownVersion = null) {
    const app = this.app;
    const doc = app.doc;
    const path = this.path;
    const version = knownVersion || (await cloudVersion(path));
    const remote = upgradeDoc(await decodeProject(await cloudRead(path)));
    if (app.doc !== doc || this.path !== path) return null;
    // Wait for edits in progress to finish before touching the document.
    if (doc.inTransaction) return null;
    const r = mergeRemote(this.base, doc, remote.items);
    // Model changes, not history entries, are what people care about.
    const n = r.incoming.filter(([id, it]) => (it || doc.get(id))?.kind !== 'syncEntry').length;
    if (r.incoming.length) doc.applyRemote(r.incoming, 'Changes from others');
    this.base = r.nextBase;
    this.version = version;
    this.lastSync = Date.now();
    if (r.conflicts.length) this.lastConflicts = r.conflicts;
    this.setState(r.pending ? 'pending' : 'synced');
    if (n) {
      const who = syncLog(remote).at(-1)?.by;
      app.setPrompt(`${who ? `${who} made` : 'Someone made'} ${n} change${n === 1 ? '' : 's'}. The model is up to date.`);
    }
    return r;
  }

  /** Synchronize: bring others' changes in, then save this copy for everyone. */
  async sync({ comment = '', quiet = false } = {}) {
    if (!this.active) return false;
    return this.run(async () => {
      const app = this.app;
      const doc = app.doc;
      this.setState('syncing');
      try {
        this.logSync(comment);
        for (let attempt = 0; attempt < 3; attempt++) {
          const v = await cloudVersion(this.path);
          if (v !== this.version) await this.pull(v);
          if (app.doc !== doc) return false;
          const snapshot = new Map(doc.items);
          const rev = doc.revision;
          const blob = await encodeProject(doc);
          // Someone saved while this copy was being prepared: merge again.
          if ((await cloudVersion(this.path)) !== this.version) continue;
          await cloudWrite(this.path, blob, true);
          doc.markSaved(rev);
          this.base = snapshot;
          this.version = await cloudVersion(this.path).catch(() => null);
          this.lastSync = Date.now();
          this.setState(doc.revision === rev ? 'synced' : 'pending');
          const n = this.lastConflicts.length;
          if (!quiet) app.toast(n ? `Synchronized. ${n} element${n === 1 ? ' was' : 's were'} also changed by someone else; your version was kept.` : 'Synchronized with the shared project.', { kind: 'success' });
          this.lastConflicts = [];
          return true;
        }
        app.toast('Others are saving right now. Try again in a moment.', { kind: 'error' });
        this.setState('pending');
        return false;
      } catch (err) {
        this.setState('offline');
        app.toast(`Could not synchronize: ${err.message || err}`, { kind: 'error' });
        return false;
      }
    });
  }

  /** Throw away local changes and load the shared copy. */
  async reloadLatest() {
    if (!this.active) return;
    await this.run(async () => {
      const app = this.app;
      const doc = app.doc;
      const remote = upgradeDoc(await decodeProject(await cloudRead(this.path)));
      const changes = [];
      for (const [id, it] of remote.items) if (!doc.items.has(id) || JSON.stringify(doc.items.get(id)) !== JSON.stringify(it)) changes.push([id, it]);
      for (const id of doc.items.keys()) if (!remote.items.has(id)) changes.push([id, null]);
      doc.applyRemote(changes, 'Reload latest');
      doc.markSaved();
      this.base = new Map(doc.items);
      this.version = await cloudVersion(this.path).catch(() => null);
      this.lastSync = Date.now();
      this.setState('synced');
      app.toast(changes.length ? `Loaded the latest shared copy (${changes.length} change${changes.length === 1 ? '' : 's'}).` : 'You already have the latest copy.', { kind: 'success' });
    });
  }

  /**
   * Record who synchronized, outside the undo history. Each entry is its own
   * item, so entries written by different people never conflict.
   */
  logSync(comment) {
    const doc = this.app.doc;
    const entry = { id: newId('s'), kind: 'syncEntry', by: this.app.user?.username || 'Someone', at: Date.now(), comment: comment || '' };
    const old = syncLog(doc).slice(0, -(LOG_LIMIT - 1));
    doc.applyRemote([[entry.id, entry], ...old.map((e) => [e.id, null])], 'Synchronize');
  }
}

/** Synchronization history, oldest first. */
export function syncLog(doc) {
  return doc.all('syncEntry').sort((a, b) => a.at - b.at);
}
