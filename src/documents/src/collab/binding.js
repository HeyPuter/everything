/**
 * Binds an open CanvasEditor to a shared Yjs document.
 *
 * Local edits: every story transaction the editor runs (typing, commands,
 * Undo) is followed by a write of the difference between the shared document
 * and the editor's model (shared-doc.js), as one Yjs transaction whose origin
 * is this binding. Remote edits: updates from other people are applied to the
 * Yjs document, the model is rebuilt from it (and validated by constructing a
 * TextDocument, which checks tables and blocks), the caret and selection are
 * carried through the change as Yjs relative positions, and the pages are laid
 * out again. Remote edits never enter this person's Undo.
 *
 * Undo and Redo use a Yjs UndoManager that tracks only this binding's
 * transactions: undoing takes back your own change and leaves everyone
 * else's in place.
 *
 * Content that cannot be shared character by character (see
 * unsupportedReason) switches the document to single-editor mode: the person
 * holding the lock edits and their whole model is published as a snapshot;
 * everyone else sees it read-only with a notice, and can take over editing
 * when the holder leaves.
 */
import * as Y from 'yjs';
import { TextDocument } from '../engine/model.js';
import { decodeImage } from '../engine/images.js';
import { readState, writeState, unsupportedReason } from './shared-doc.js';

export const REMOTE = 'remote';
const json = value => JSON.stringify(value);
const HISTORY_ENTRY = Object.freeze({ collab: true });

/** The editor's model as the shared document stores it. */
export function editorState(engine) {
  const body = engine.session.body;
  return {
    paragraphs: body.paragraphs, tables: body.tables, styles: body.styles, stylesEnabled: body.stylesEnabled,
    numbering: body.numbering, pageSettings: body.pageSettings, comments: body.comments, trackChanges: body.trackChanges,
    stories: engine.session.storyEdits,
  };
}

/** Rewrite every string equal to `from` (an asset id) to `to`, in place. */
function renameAsset(value, from, to) {
  if (Array.isArray(value)) { value.forEach((v, i) => { if (v === from) value[i] = to; else if (v && typeof v === 'object') renameAsset(v, from, to); }); return; }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v === from) value[key] = to;
    else if (v && typeof v === 'object' && !(v instanceof Uint8Array)) renameAsset(v, from, to);
  }
}

export class CollabBinding extends EventTarget {
  /**
   * engine: the CanvasEditor. ydoc: the shared document (already holding the
   * room's state). session: { id, name, color } of this person. baseAssets:
   * asset ids the opened file already had (everyone has their bytes).
   */
  constructor({ engine, ydoc, session, baseAssets = [], onApplied = () => {}, onError = () => {} }) {
    super();
    this.engine = engine; this.ydoc = ydoc; this.session = session;
    this.onApplied = onApplied; this.onError = onError;
    this.body = ydoc.getText('body');
    this.meta = ydoc.getMap('meta');
    this.assets = ydoc.getMap('assets');
    this.baseAssets = new Set(baseAssets);
    this.role = 'editor';
    this.pending = false; this.applying = false; this.destroyed = false;
    this.queued = [];
    // The shared body's paragraph encodings while only this binding has written to it (see writeBody).
    this.bodyCache = { body: null };
    this.conflict = null;
    this.undoManager = new Y.UndoManager([this.body, ydoc.getMap('parts'), ydoc.getMap('comments')], { trackedOrigins: new Set([this]), captureTimeout: 600 });
    this.undoManager.on('stack-item-added', e => { e.stackItem.meta.set('selection', this.captureSelection()); });
    // Comments are shared by id, so two people commenting at once must not both take the lowest free one:
    // each takes its ids from a range of its own, still a whole number below 2^31 as DOCX expects.
    engine.session.body.commentIdFloor = 1000 + (ydoc.clientID % 1000000) * 1000;
    this.install();
  }

  /* ---------- Hooks into the editor ---------- */

  install() {
    const engine = this.engine, session = engine.session;
    this.originalRun = session.run;
    session.run = (...args) => {
      const result = this.originalRun.apply(session, args);
      if (!this.applying) this.scheduleSync();
      return result;
    };
    engine.travelHistory = direction => this.travel(direction);
    // Undo and Redo of shared documents take back this person's own changes.
    engine.undo = () => this.travel('undo');
    engine.redo = () => this.travel('redo');
    this.originalViewOnly = engine.setViewOnly?.bind(engine);
    if (this.originalViewOnly) engine.setViewOnly = on => this.originalViewOnly(!!on || this.forcedViewOnly());
    // Role and document protection guards both apply: a commenter's guard runs before the document's own.
    let documentGuard = session.guard;
    Object.defineProperty(session, 'guard', {
      configurable: true,
      get: () => (this.roleGuard || documentGuard) ? (before, model, path) => { this.roleGuard?.(before, model, path); documentGuard?.(before, model, path); } : null,
      set: value => { documentGuard = value; },
    });
    this.restoreGuard = () => { delete session.guard; session.guard = documentGuard; };
    this.observer = transaction => this.observe(transaction);
    this.ydoc.on('afterTransaction', this.observer);
    this.mode = this.meta.get('mode') || 'shared';
    this.refreshHistory();
  }

  forcedViewOnly() {
    return this.role === 'viewer' || (this.mode === 'single' && !this.holdsLock());
  }

  /** Apply a role: viewers cannot change anything; commenters only comment (via a protection guard). */
  setRole(role, { commentGuard } = {}) {
    this.role = role;
    this.roleGuard = role === 'commenter' ? commentGuard : null;
    this.enforceViewOnly();
  }

  enforceViewOnly() {
    const engine = this.engine;
    if (!this.originalViewOnly) return;
    if (this.forcedViewOnly()) { if (!engine.viewOnly) this.originalViewOnly(true); }
    else if (engine.viewOnly && this.viewOnlyByUs) this.originalViewOnly(false);
    this.viewOnlyByUs = this.forcedViewOnly();
  }

  /* ---------- Local changes ---------- */

  scheduleSync() {
    if (this.pending || this.destroyed) return;
    this.pending = true;
    queueMicrotask(() => this.flush());
  }

  /** Write local changes now (before a remote update is applied, say). */
  flush() {
    this.pending = false;
    if (this.destroyed || this.applying) return;
    const engine = this.engine;
    if (engine.composition) { this.waitForComposition(); return; }
    if (this.role === 'viewer' || this.forcedViewOnly()) { this.drainQueue(); return; }
    try {
      const state = editorState(engine);
      const reason = unsupportedReason(state);
      if (this.mode === 'single' || reason) this.writeSnapshot(state, reason);
      else {
        this.uploadAssets();
        writeState(this.ydoc, state, this, this.bodyCache);
      }
    } catch (error) { this.bodyCache.body = null; this.onError(error); }
    this.refreshHistory();
    this.drainQueue();
  }

  waitForComposition() {
    if (this.compositionTimer) return;
    this.compositionTimer = setInterval(() => {
      if (this.engine.composition || this.destroyed) return;
      clearInterval(this.compositionTimer); this.compositionTimer = null;
      this.flush();
    }, 50);
  }

  /**
   * New pictures and drawings go into the shared asset map, under an id no one else can be using:
   * `<id>#` holds the asset's description (JSON), `<id>` its bytes when it has any.
   */
  uploadAssets() {
    const engine = this.engine, body = engine.session.body;
    for (const [id, asset] of Object.entries(body.assets || {})) {
      if (!asset || this.baseAssets.has(id) || this.assets.has(`${id}#`)) continue;
      let shared = id;
      if (!id.includes('@')) {
        shared = `${id}@${this.ydoc.clientID.toString(36)}`;
        body.assets[shared] = asset; delete body.assets[id];
        const bitmap = engine.images.get(id);
        if (bitmap) { engine.images.set(shared, bitmap); engine.images.delete(id); }
        for (const model of engine.session.models.values()) { renameAsset(model.paragraphs, id, shared); renameAsset(model.tables, id, shared); if (model !== body && model.assets !== body.assets) renameAsset(model.assets, id, shared); }
      }
      const { bytes, ...rest } = asset;
      let description;
      try { description = json(rest); } catch { continue; }
      this.ydoc.transact(() => { if (bytes) this.assets.set(shared, bytes); this.assets.set(`${shared}#`, description); }, this);
    }
  }

  /* ---------- Single-editor mode ---------- */

  holdsLock() { return this.meta.get('lock')?.session === this.session.id; }

  /** Take the single-editor lock (when it is free or its holder has left). */
  takeLock() {
    this.ydoc.transact(() => {
      this.meta.set('mode', 'single');
      this.meta.set('lock', { session: this.session.id, name: this.session.name, at: Date.now() });
      if (!this.meta.get('snapshot')) this.meta.set('snapshot', json(editorState(this.engine)));
    }, this);
    this.mode = 'single';
    this.enforceViewOnly();
    this.dispatchEvent(new Event('mode'));
  }

  writeSnapshot(state, reason) {
    if (this.mode !== 'single') {
      // A change the shared text cannot hold: this person takes the document over.
      this.takeLock();
      this.dispatchEvent(new CustomEvent('single', { detail: { reason, mine: true } }));
    }
    if (!this.holdsLock()) return;
    if (!reason) {
      // Back to content everyone can edit together: publish it as shared text again.
      this.ydoc.transact(() => {
        writeState(this.ydoc, state, this);
        this.bodyCache.body = null;
        this.meta.set('mode', 'shared'); this.meta.delete('lock'); this.meta.delete('snapshot');
      }, this);
      this.mode = 'shared';
      this.enforceViewOnly();
      this.dispatchEvent(new Event('mode'));
      return;
    }
    const text = json(state);
    if (this.meta.get('snapshot') !== text) this.ydoc.transact(() => this.meta.set('snapshot', text), this);
  }

  /** Give up the lock (leaving, or handing over). */
  releaseLock() {
    if (!this.holdsLock()) return;
    this.ydoc.transact(() => this.meta.delete('lock'), this);
  }

  /* ---------- Remote changes ---------- */

  /** Apply an update from someone else. */
  receive(update) {
    if (this.destroyed) return;
    if (this.engine.composition || this.applying) { this.queued.push(update); this.waitForComposition(); return; }
    // Local edits go first, so the shared document matches the model the diff is taken from.
    if (this.pending) this.flush();
    this.remoteSelection = this.captureSelection();
    Y.applyUpdate(this.ydoc, update, REMOTE);
    this.remoteSelection = null;
  }

  drainQueue() {
    if (!this.queued.length || this.engine.composition) return;
    const updates = this.queued.splice(0);
    this.remoteSelection = this.captureSelection();
    Y.applyUpdate(this.ydoc, Y.mergeUpdates(updates), REMOTE);
    this.remoteSelection = null;
  }

  observe(transaction) {
    if (transaction.origin === this || this.destroyed) return;
    this.bodyCache.body = null;
    if (!transaction.changed.size && !transaction.deleteSet.clients.size) return;
    this.apply(transaction.origin === this.undoManager ? this.undoSelection : this.remoteSelection);
  }

  captureSelection() {
    const engine = this.engine;
    if (engine.session.path !== null) return null;
    const { anchor, focus } = engine.session.body.selection;
    return { anchor: this.relative(anchor), focus: this.relative(focus) };
  }
  relative(index, assoc = -1) {
    return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.body, Math.min(index, this.body.length), assoc));
  }
  absolute(position) {
    if (!position) return null;
    try { return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position), this.ydoc)?.index ?? null; }
    catch { return null; }
  }

  /** Rebuild the model from the shared document and show it. */
  apply(selection = null) {
    const engine = this.engine;
    this.mode = this.meta.get('mode') || 'shared';
    this.enforceViewOnly();
    let state;
    try {
      state = this.mode === 'single' ? JSON.parse(this.meta.get('snapshot') || 'null') : readState(this.ydoc);
      if (!state) return;
    } catch (error) { this.onError(error); return; }
    const session = engine.session, body = session.body;
    const before = selection;
    // Pictures first: the paragraphs that show them may arrive in the same update.
    this.applyAssets();
    let fresh;
    try {
      fresh = new TextDocument(state.paragraphs, state.pageSettings, state.numbering, state.stylesEnabled ? state.styles : undefined, state.tables, body.assets, { comments: state.comments, trackChanges: state.trackChanges ?? body.trackChanges });
    } catch (error) {
      // Concurrent structural edits (two people restructuring one table) merged into something the
      // editor cannot show. Keep the last good state; an editor writes it back over the shared one.
      this.conflict = error;
      this.dispatchEvent(new CustomEvent('conflict', { detail: { error } }));
      return;
    }
    this.conflict = null;
    this.applying = true;
    try {
      const oldStyles = body.styles, oldNumbering = body.numbering;
      for (const key of ['paragraphs', 'tables', 'styles', 'stylesEnabled', 'numbering', 'pageSettings', 'comments']) body[key] = fresh[key];
      if (state.trackChanges !== undefined) body.trackChanges = fresh.trackChanges;
      for (const key of Object.keys(fresh)) if (/^has[A-Z]/.test(key) && typeof fresh[key] === 'boolean') body[key] = fresh[key];
      body.revision++;
      this.applyStories(state.stories || {});
      session.publish(body, { styles: oldStyles, numbering: oldNumbering });
      if (session.path === null) {
        const length = body.text.length;
        const anchor = this.absolute(before?.anchor), focus = this.absolute(before?.focus);
        if (anchor !== null && focus !== null) body.select(Math.min(anchor, length), Math.min(focus, length));
        else body.select(Math.min(body.selection.anchor, length), Math.min(body.selection.focus, length));
      }
      session.revision++;
      engine.relayout();
      engine.paint();
      engine.syncInput?.();
    } catch (error) { this.onError(error); }
    finally { this.applying = false; }
    this.refreshHistory();
    this.onApplied();
  }

  applyStories(stories) {
    const session = this.engine.session;
    for (const [path, story] of Object.entries(stories)) {
      const model = session.models.get(path);
      if (model) {
        if (json(model.paragraphs) === json(story.paragraphs) && json(model.tables) === json(story.tables || [])) continue;
        model.paragraphs = structuredClone(story.paragraphs); model.tables = structuredClone(story.tables || []);
        const length = model.text.length;
        model.select(Math.min(model.selection.anchor, length), Math.min(model.selection.focus, length));
        model.revision++;
      } else if (session.definition?.stories?.[path]) {
        const fresh = new TextDocument(story.paragraphs, session.body.pageSettings, session.body.numbering, session.body.styles, story.tables || [], session.body.assets);
        fresh.assets = session.body.assets;
        session.models.set(path, fresh);
      }
    }
  }

  /** Pictures and drawings others added: they join the model, and pictures are decoded for painting. */
  applyAssets() {
    const engine = this.engine, assets = engine.session.body.assets;
    for (const [key, description] of this.assets.entries()) {
      if (!key.endsWith('#')) continue;
      const id = key.slice(0, -1);
      if (assets[id]) continue;
      let rest = {};
      try { rest = JSON.parse(description); } catch { continue; }
      const bytes = this.assets.get(id);
      assets[id] = bytes ? { ...rest, bytes } : rest;
      if (!bytes) continue;
      decodeImage(assets[id]).then(bitmap => {
        if (this.destroyed || engine.destroyed) { bitmap.close?.(); return; }
        engine.images.set(id, bitmap); engine.relayout(); engine.paint();
      }).catch(error => this.onError(new Error(`A picture someone added could not be shown: ${error.message}`)));
    }
  }

  /* ---------- Undo ---------- */

  travel(direction) {
    const engine = this.engine;
    if (engine.readOnly || engine.viewOnly || engine.composition) return;
    this.flush();
    const manager = this.undoManager;
    const stack = direction === 'undo' ? manager.undoStack : manager.redoStack;
    const item = stack.at(-1);
    this.undoSelection = item?.meta.get('selection') || this.captureSelection();
    const done = direction === 'undo' ? manager.undo() : manager.redo();
    this.undoSelection = null;
    if (done) { engine.onChange?.(); this.refreshHistory(); }
    engine.focus?.();
  }

  /** The editor's Undo and Redo buttons read the session's history: mirror this person's own stacks there. */
  refreshHistory() {
    const session = this.engine.session;
    session.history = this.undoManager.undoStack.map(() => HISTORY_ENTRY);
    session.future = this.undoManager.redoStack.map(() => HISTORY_ENTRY);
  }

  /* ---------- Presence ---------- */

  /** Where this person's caret and selection are, as positions that survive edits. */
  localPresence() {
    const engine = this.engine;
    if (engine.session.path !== null) return { story: engine.session.path };
    return this.captureSelection();
  }

  /** A remote person's selection as model positions, or null. */
  resolve(presence) {
    if (!presence?.anchor) return null;
    const anchor = this.absolute(presence.anchor), focus = this.absolute(presence.focus);
    if (anchor === null || focus === null) return null;
    const length = this.engine.session.body.text.length;
    return { anchor: Math.min(anchor, length), focus: Math.min(focus, length) };
  }

  destroy() {
    if (this.destroyed) return;
    this.flush();
    this.releaseLock();
    this.destroyed = true;
    clearInterval(this.compositionTimer);
    this.ydoc.off('afterTransaction', this.observer);
    this.undoManager.destroy();
    const engine = this.engine;
    delete engine.session.body.commentIdFloor;
    delete engine.session.run;
    delete engine.travelHistory;
    delete engine.undo; delete engine.redo;
    if (this.originalViewOnly) delete engine.setViewOnly;
    this.restoreGuard?.();
    engine.session.history = []; engine.session.future = [];
  }
}
