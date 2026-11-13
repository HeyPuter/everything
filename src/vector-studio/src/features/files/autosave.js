/**
 * Autosave for crash recovery: every few minutes (and whenever the page is
 * hidden) dirty documents are written to a recovery store, the app's Puter
 * folder when signed in and this browser's private file system otherwise.
 * On startup, copies left behind by a session that is no longer running
 * are offered for recovery. Copies are removed when a document is saved or
 * closed without saving.
 *
 * Storage writes started while the page closes may never finish (seen in
 * Chromium), so when the page is hidden or closed the copies about to be
 * written are also kept in localStorage, which is written at once; the next
 * start writes back any that are newer than the stored copy.
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { serializeDocument, parseDocument, toBytes, documentData, canCompress, gzip, FileFormatError } from './format.js';
import { RecoveryStore, recoverableEntries, newerSnapshot, recoveryTime } from './recovery.js';
import { puterBackend, opfsBackend, opfsAvailable } from './backends.js';
import { relativeTime } from './naming.js';
import { handleStore } from './handles.js';

const CHANNEL = 'vector-studio-recovery';
/** localStorage key prefix for copies kept at page close (see the top comment): `<prefix><recovery id>`. */
const STASH = 'vs-recovery-unwritten:';
/** Leave room in localStorage (about 5M characters) for preferences: larger documents rely on the regular write. */
const STASH_LIMIT = 2_500_000;
// Only known content errors establish damage. Compatibility, I/O, and editor
// failures must leave the backup available to a working app/browser later.
const DAMAGED_CODES = new Set(['invalid', 'empty', 'damaged', 'format', 'svg']);

const sameRevisions = (a, b) => a?.revision === b.revision && a?.commentsRevision === b.commentsRevision;
const sameFile = (a, b) => a === b || (a && b && a.kind === b.kind && a.path === b.path && a.name === b.name && a.handleId === b.handleId);
const sameBackup = (snapshot, doc, file) => sameRevisions(snapshot, doc) && sameFile(snapshot.file, file);
const fileInfo = (file) => file ? { kind: file.kind, path: file.path || null, name: file.name || null, handleId: file.handleId || null } : null;

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function encodeText(text) {
  const bytes = new TextEncoder().encode(text);
  return canCompress() ? gzip(bytes) : bytes;
}

export class Autosaver {
  constructor(app, { store = null, session = uid('s') } = {}) {
    this.app = app;
    this.session = session;
    this.fixedStore = store;
    this.storeKey = null;
    this.cached = null;
    this.recovered = new WeakMap(); // document -> original snapshot and store, until safely superseded
    this.saved = new WeakMap(); // document -> revisions and file association last backed up
    this.discarded = new WeakMap(); // document -> token invalidating captures from before Save/Close
    this.pending = new WeakMap(); // document -> revisions and association of the pending replacement
    this.watched = new WeakSet(); // documents whose saved event removes their copy
    this.stashed = new Map(); // recovery id -> revisions, association and capture sequence kept at page close
    this.sequence = 0; // capture order within this session; document revisions can go backward on Undo
    this.timer = 0;
    this.busy = null;
    this.channel = null;
  }

  /** The recovery store for the current sign-in state (null when nothing can persist). */
  get store() {
    if (this.fixedStore) return this.fixedStore;
    const puter = this.app.puter;
    const cloud = Boolean(puter?.fs && (this.app.env === 'app' || this.app.user));
    const local = opfsAvailable();
    const key = `${cloud}:${local}`;
    if (key !== this.storeKey) {
      this.storeKey = key;
      const backends = [];
      if (cloud) backends.push(puterBackend(puter, ''));
      if (local) backends.push(opfsBackend('vector-studio'));
      this.cached = backends.length ? new RecoveryStore(backends) : null;
    }
    return this.cached;
  }

  get enabled() {
    return this.app.prefs.get('autosaveEnabled') !== false;
  }

  get intervalMs() {
    const m = Number(this.app.prefs.get('autosaveMinutes'));
    return (Number.isFinite(m) && m >= 0.5 ? Math.min(m, 60) : 2) * 60 * 1000;
  }

  start() {
    this.schedule();
    this.app.prefs.on('change', ({ key }) => {
      if (key === 'autosaveEnabled' || key === 'autosaveMinutes') this.schedule();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush({ hiding: true });
    });
    window.addEventListener('pagehide', () => this.flush({ hiding: true }));
    // Closing one window of a document that another still shows keeps its copy.
    this.app.on('closed', (editor) => {
      if (!this.app.editors.some((e) => e.doc === editor.doc)) this.discard(editor);
    });
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e) => {
        if (e.data?.type === 'ping') this.channel.postMessage({ type: 'pong', session: this.session });
      };
    } catch {
      this.channel = null;
    }
  }

  schedule() {
    clearInterval(this.timer);
    this.timer = 0;
    if (this.enabled) this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  /** A document's recovery copy id, shared by every window showing it. */
  recoveryId(editor) {
    const doc = editor.doc;
    if (!doc.recoveryId) doc.recoveryId = editor.recoveryId || uid('r');
    editor.recoveryId = doc.recoveryId;
    return doc.recoveryId;
  }

  /**
   * Write recovery copies of every dirty document that changed since its
   * last copy. When the page is being hidden or closed (`hiding`), they are
   * also kept in localStorage at once (see the top comment).
   */
  flush({ hiding = false } = {}) {
    const texts = hiding ? this.#stash() : null;
    if (this.busy) return this.busy;
    this.busy = this.#flush(texts).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  #needsBackup(editor) {
    const doc = editor.doc;
    if (!doc.dirty || doc.tx) return false;
    const saved = this.saved.get(doc);
    const pending = this.pending.get(doc);
    const stashed = this.stashed.get(doc.recoveryId);
    const file = fileInfo(editor.file);
    // Undo/Redo or Save As may return to a backed-up state while another
    // snapshot is about to replace it, including a different file association.
    return !sameBackup(saved, doc, file) ||
      (pending && !sameBackup(pending, doc, file)) || (stashed && !sameBackup(stashed, doc, file));
  }

  /** Documents whose recovery copy is out of date: one window each. */
  #changed() {
    const seen = new Set();
    return this.app.editors.filter((editor) => {
      const doc = editor.doc;
      if (seen.has(doc)) return false;
      seen.add(doc);
      return this.#needsBackup(editor);
    });
  }

  /** Keep the copies about to be written in localStorage. Returns editor -> { text, rev, commentsRevision, sequence } for the regular write. */
  #stash() {
    const texts = new Map();
    const ls = storage();
    if (!ls || !this.store || !this.enabled) return texts;
    let room = STASH_LIMIT;
    for (const editor of this.#changed()) {
      const doc = editor.doc;
      const id = this.recoveryId(editor);
      const key = STASH + id;
      try {
        const text = JSON.stringify(documentData(doc));
        const sequence = ++this.sequence;
        texts.set(editor, { text, rev: doc.revision, commentsRevision: doc.commentsRevision, sequence });
        room -= text.length;
        if (room < 0) throw new Error('Too large to keep in localStorage');
        const meta = { id, ...this.#entry(editor), revision: doc.revision, commentsRevision: doc.commentsRevision, session: this.session, sequence, saved: Date.now() };
        ls.setItem(key, `${JSON.stringify(meta)}\n${text}`);
        this.stashed.set(id, { revision: doc.revision, commentsRevision: doc.commentsRevision, file: meta.file, sequence });
      } catch {
        // Over the quota: an older copy kept here would replace the newer one being written.
        this.#unstash(id);
      }
    }
    return texts;
  }

  #unstash(id, sequence = Infinity) {
    if (!this.stashed.has(id) && sequence !== Infinity) return;
    if (this.stashed.get(id)?.sequence > sequence) return;
    this.stashed.delete(id);
    try {
      storage()?.removeItem(STASH + id);
    } catch {
      // Best effort.
    }
  }

  #entry(editor) {
    return { name: editor.name, file: fileInfo(editor.file) };
  }

  async #flush(texts = null) {
    const store = this.store;
    if (!store || !this.enabled) return 0;
    let n = 0;
    for (const editor of this.#changed()) {
      const doc = editor.doc;
      // Earlier documents may have awaited slow storage since this list was
      // built. Recheck the current window and backup state before serialization:
      // Undo/Redo may have restored the backup, or a gesture may have started.
      const open = this.app.editors.find((e) => e.doc === doc);
      if (!open || !this.#needsBackup(open)) continue;
      const discardToken = this.discarded.get(doc);
      const rev = doc.revision;
      const commentsRevision = doc.commentsRevision;
      const snapshot = { revision: rev, commentsRevision, file: fileInfo(open.file) };
      this.pending.set(doc, snapshot);
      try {
        const kept = texts?.get(editor);
        const reuse = kept?.rev === rev && kept.commentsRevision === commentsRevision;
        const sequence = reuse ? kept.sequence : ++this.sequence;
        const data = reuse ? await encodeText(kept.text) : await serializeDocument(doc);
        // Save/Close invalidates this capture even if Undo or another edit has
        // already made the same document dirty again while encoding finished.
        const current = this.app.editors.find((e) => e.doc === doc);
        if (this.discarded.get(doc) !== discardToken || !doc.dirty || !current) continue;
        // A closed window no longer receives Save As updates from its companion.
        const id = this.recoveryId(current);
        const entry = this.#entry(current);
        snapshot.file = entry.file;
        await store.put(id, { ...entry, data, revision: rev, commentsRevision, sequence, session: this.session });
        // Its queued discard owns this completed write. Do not claim the
        // deleted copy still covers Undo or clear a newer page-close stash.
        if (this.discarded.get(doc) !== discardToken) continue;
        this.saved.set(doc, snapshot);
        this.#watchShared(doc);
        this.#unstash(id, sequence);
        await this.#discardRecoveredSource(doc);
        n++;
      } catch (err) {
        console.warn('Autosave failed', err);
      } finally {
        this.pending.delete(doc);
      }
    }
    return n;
  }

  /**
   * A shared document counts as saved when the server has every edit (not
   * through Save, which removes the copy itself): its copy goes then.
   */
  #watchShared(doc) {
    if (this.watched.has(doc)) return;
    this.watched.add(doc);
    doc.on('saved', () => {
      const ed = this.app.editors.find((e) => e.doc === doc);
      if (ed?.file?.kind === 'shared' && !doc.dirty) this.discard(ed);
    });
  }

  async #discardRecoveredSource(doc) {
    const source = this.recovered.get(doc);
    if (!source) return;
    try {
      // A different app may have replaced the original since we opened it.
      // Cleanup authorizes only the snapshot this document actually recovered.
      if (await source.store.remove(source.entry.id, { expected: source.entry, superseded: true }) !== false) this.recovered.delete(doc);
    } catch {
      // Keep the source available for cleanup after another backup or discard.
    }
  }

  /** Forget a document's recovery copy (saved, or closed without saving). */
  async discard(editor) {
    if (!editor) return;
    if (editor.doc) this.discarded.set(editor.doc, Symbol());
    this.saved.delete(editor.doc);
    const source = this.recovered.get(editor.doc);
    if (source) source.discarded = true;
    const id = editor.doc?.recoveryId || editor.recoveryId;
    if (!id) return;
    this.#unstash(id);
    try {
      await this.store?.remove(id);
    } catch {
      // Best effort.
    }
    await this.#discardRecoveredSource(editor.doc);
  }

  /** Sessions still running in other tabs of this browser. */
  liveSessions(wait = 250) {
    return new Promise((resolve) => {
      const live = new Set();
      let ch;
      try {
        ch = new BroadcastChannel(CHANNEL);
      } catch {
        resolve(live);
        return;
      }
      ch.onmessage = (e) => {
        if (e.data?.type === 'pong' && e.data.session) live.add(e.data.session);
      };
      ch.postMessage({ type: 'ping' });
      setTimeout(() => {
        ch.close();
        resolve(live);
      }, wait);
    });
  }

  /** Offer to recover documents left by a session that ended without saving. */
  async offerRecovery() {
    const store = this.store;
    if (!store) return [];
    let entries;
    try {
      const live = await this.liveSessions();
      await this.#restoreStashes(store, live);
      entries = recoverableEntries(await store.list(), live, this.session);
    } catch {
      return [];
    }
    if (!entries.length) return [];
    const checks = entries.map((e) => h('input', { type: 'checkbox', checked: true, id: `rec-${e.id}` }));
    const list = h(
      'ul.files-recover-list',
      entries.map((e, i) =>
        h(
          'li',
          checks[i],
          h('label', { for: `rec-${e.id}` }, h('span.files-recover-name', e.name || 'Untitled'), h('span.muted', ` ${e.file?.path ? e.file.path.replace(/^\/[^/]+\//, '') : 'Not saved yet'} · ${relativeTime(recoveryTime(e.saved)) || 'Unknown time'}`)),
        ),
      ),
    );
    const choice = await openDialog({
      title: 'Recover Documents',
      body: h('div.files-recover', h('p.dialog-message', 'Vector Studio did not close normally. These documents had unsaved changes that can be recovered:'), list),
      buttons: [
        { label: 'Discard', value: 'discard', left: true, danger: true },
        { label: 'Not Now', value: null },
        { label: 'Recover', value: 'recover', primary: true },
      ],
    });
    if (!choice) return [];
    // Unsaved work is only thrown away once the user confirms it; otherwise it is offered again next time.
    const unwanted = entries.filter((e, i) => choice === 'discard' || !checks[i].checked);
    const discard = unwanted.length && (await confirmDiscard(unwanted));
    const opened = [];
    const kept = [];
    const reasons = new Set();
    const notRemoved = [];
    const damaged = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (choice === 'recover' && checks[i].checked) {
        let ed = null;
        try {
          ed = await this.recover(e);
        } catch (err) {
          // An unavailable reader or editor does not establish damaged bytes.
          kept.push(e.name || 'Untitled');
          if (err instanceof FileFormatError) reasons.add(err.message);
          continue;
        }
        if (ed) opened.push(ed);
        else {
          if (await store.remove(e.id, { expected: e }) === false) notRemoved.push(e.name || 'Untitled');
          else damaged.push(e.name || 'Untitled');
        }
      } else if (discard && await store.remove(e.id, { expected: e }) === false) notRemoved.push(e.name || 'Untitled');
    }
    if (opened.length) this.app.notify(`Recovered ${opened.length} document${opened.length === 1 ? '' : 's'}. Save to keep the changes.`);
    if (damaged.length) this.app.notify(`${damaged.map((n) => `"${n}"`).join(', ')} could not be recovered: the recovery copy is damaged.`, { error: true, timeout: 8000 });
    if (kept.length) this.app.notify(`${kept.map((n) => `"${n}"`).join(', ')} could not be recovered right now. ${reasons.size ? [...reasons].join(' ') + ' ' : ''}The recovery ${kept.length === 1 ? 'copy was' : 'copies were'} kept for the next recovery attempt.`, { error: true, timeout: 8000 });
    if (notRemoved.length) this.app.notify(`Recovery data for ${notRemoved.map((n) => `"${n}"`).join(', ')} was kept because it changed or could not be removed. Try again.`, { error: true, timeout: 8000 });
    return opened;
  }

  /**
   * Write back the copies a closed page kept in localStorage (see #stash)
   * when they are newer than the stored ones, then forget them. Copies of
   * sessions still running in other tabs are theirs to write.
   */
  async #restoreStashes(store, live) {
    const ls = storage();
    if (!ls) return;
    const keys = [];
    try {
      for (let i = 0; i < ls.length; i++) if (ls.key(i)?.startsWith(STASH)) keys.push(ls.key(i));
    } catch {
      return;
    }
    if (!keys.length) return;
    const stored = new Map((await store.list()).map((e) => [e.id, e]));
    for (const key of keys) {
      let raw = null;
      let meta = null;
      try {
        raw = ls.getItem(key);
        meta = JSON.parse(raw.slice(0, raw.indexOf('\n')));
      } catch {
        meta = null;
      }
      if (!meta || typeof meta.id !== 'string' || key !== STASH + meta.id) {
        ls.removeItem(key);
        continue;
      }
      if (meta.session === this.session || live.has(meta.session)) continue;
      const prev = stored.get(meta.id);
      try {
        // Compare capture order, independent of Undo/Redo and wall-clock changes.
        const newer = !prev || newerSnapshot(meta, prev);
        if (newer) {
          const data = await encodeText(raw.slice(raw.indexOf('\n') + 1));
          await store.put(meta.id, { name: meta.name, file: meta.file, data, revision: meta.revision, commentsRevision: meta.commentsRevision, sequence: meta.sequence, session: meta.session, saved: meta.saved });
        }
        ls.removeItem(key);
      } catch (err) {
        // Kept to write back next time.
        console.warn('Could not restore a recovery copy', err);
      }
    }
  }

  /**
   * Open a recovery copy. Resolves the editor, or null when the copy is gone
   * or damaged; throws when it could not be read right now.
   */
  async recover(entry) {
    const store = this.store;
    const blob = await store.read(entry);
    if (!blob) return null;
    let doc, data;
    try {
      data = await toBytes(blob);
      ({ doc } = await parseDocument(data));
    } catch (err) {
      if (!(err instanceof FileFormatError) || !DAMAGED_CODES.has(err.code)) throw err;
      console.warn('Recovery failed', err);
      return null;
    }
    // Recovered work is unsaved until the user saves it.
    doc.savedRevision = -1;
    let file = null;
    const f = entry.file;
    if (f?.kind === 'puter' && f.path) file = { kind: 'puter', path: f.path, name: f.name };
    else if (f?.kind === 'local' && f.handleId) {
      const handle = await handleStore.get(f.handleId);
      if (handle) file = { kind: 'local', name: f.name, handle, handleId: f.handleId };
    }
    // Unsaved recovered work is marked in its name so it is not mistaken for the saved file.
    if (!file) file = { kind: 'import', format: 'native', name: `${f?.name || entry.name || 'Untitled'} [Recovered]` };
    // Decoding and handle lookup can outlive the selected backup. Do not open
    // work that another writer replaced while these readers were running.
    if (!await store.isCurrent(entry)) throw new Error('The recovery copy changed while opening. Try recovery again.');
    // Capture the revisions of the bytes we read before editor-opening hooks
    // can change the document, save it, or close it.
    const revision = doc.revision, commentsRevision = doc.commentsRevision;
    // The baseline retains the original recovery metadata. Track later changes
    // against the association used to open this editor (possibly an import).
    const location = fileInfo(file);
    const source = { store, entry, discarded: false };
    // Every recovered document owns its next backup. Other tabs/devices can
    // recover the same source and then edit, save, or discard independently.
    doc.recoveryId = uid('r');
    this.recovered.set(doc, source);
    const editor = this.app.addDocument(doc, { file });
    editor.recoveryId = doc.recoveryId;
    this.app.renderTabs();
    if (source.discarded) return editor;
    try {
      // Preserve the selected bytes under this document's own id before
      // retiring the source. Even an unchanged recovered document needs its
      // own backup if another instance saves or discards its recovered copy.
      await store.put(doc.recoveryId, { name: entry.name, file: entry.file, data,
        revision, commentsRevision, sequence: ++this.sequence, session: this.session });
      if (!source.discarded) {
        this.saved.set(doc, { revision, commentsRevision, file: location });
        this.#watchShared(doc);
      }
      await this.#discardRecoveredSource(doc);
    } catch {
      // Readable backups remain recoverable when storage cannot accept writes.
      // The source stays until a later autosave succeeds or this copy is discarded.
    }
    return editor;
  }
}

/** Ask before discarding recovery copies; resolves true to discard, false to keep them for next time. */
async function confirmDiscard(entries) {
  const names = entries.map((e) => `"${e.name || 'Untitled'}"`);
  const one = entries.length === 1;
  const what = one ? names[0] : names.length <= 3 ? `${names.length} documents (${names.join(', ')})` : `${names.length} documents`;
  const choice = await openDialog({
    title: one ? 'Discard Recovered Document' : 'Discard Recovered Documents',
    body: h('p.dialog-message', `Discard ${what}? ${one ? 'Its' : 'Their'} unsaved changes will be lost. Keep ${one ? 'it' : 'them'} to be offered again the next time Vector Studio starts.`),
    buttons: [
      { label: 'Discard', value: 'discard', danger: true, left: true },
      { label: 'Keep for Later', value: 'keep', primary: true },
    ],
  });
  return choice === 'discard';
}
