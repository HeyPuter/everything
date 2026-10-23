/**
 * The open document: where it lives on Puter, its display name, and whether
 * what is on screen matches what is on disk. The editing engine owns the
 * content; it hands us an `exporter` (async () => Blob) once it is ready, and
 * tells us about every edit through `changed()`.
 *
 * Edits autosave after a short pause. A document that has never been saved
 * gets a file in the app folder the first time it changes, so nothing typed
 * is ever only in memory for long. Inside the Puter desktop it waits for the
 * first Save instead, which asks where the file goes (Puter's Save dialog,
 * which writes it); autosaves and retries never ask. Files opened from
 * outside the app folder (the Puter file picker, "Open with") save back to
 * where they came from.
 *
 * Without a Puter session there is nowhere to write: autosaves wait, and an
 * explicit save fails with SIGN_IN_TO_SAVE so the view can ask for a sign-in.
 *
 * status: 'saved' | 'unsaved' | 'saving' | 'error' | 'offline'
 */

import * as P from './puter.js';
import { session } from './session.js';
import { snapshotIfDue, saveVersion, renameVersions, deleteVersions } from './versions.js';
import { movePublication, unpublishAt } from './publish.js';
import { moveStar } from './starred.js';
import { forgetRoom, moveRoom } from '../collab/room-memory.js';
import { HANWORD_IMPORTABLE, decodeTextFile, importHanword, importKind, toInsertPayload } from './importers.js';
import { rememberMade, forgetMade } from './made.js';

export const AUTOSAVE_MS = 1500;
export const MAX_AUTOSAVE_MS = 30000;
export const RETRY_MS = 8000;
export const UNTITLED = 'Untitled document';
export const SIGN_IN_TO_SAVE = 'Sign in to Puter to save this document';
/** Markdown, HTML, and plain text are read and converted on the main thread; a novel is about a megabyte. */
export const MAX_TEXT_IMPORT_BYTES = 20 * 1024 * 1024;
/** Version snapshots after saves; tests switch them off. */
export const versioning = { enabled: true };
/** A published page following renames and deletions; tests switch it off. */
export const publishing = { enabled: true };

/**
 * Whether leaving the page now could lose work: edits not yet written, or a
 * write still in flight. Used for the browser's "leave site?" prompt.
 */
const AUTOSAVE_KEY = 'documents:autosave';
/** Whether edits save themselves (they do, until AutoSave is turned off on this device). */
export function autosaveEnabled() {
  try { return globalThis.localStorage?.getItem(AUTOSAVE_KEY) !== '0'; } catch { return true; }
}
export function setAutosaveEnabled(on) {
  try { if (on) globalThis.localStorage?.removeItem(AUTOSAVE_KEY); else globalThis.localStorage?.setItem(AUTOSAVE_KEY, '0'); } catch { /* storage unavailable */ }
}

export function needsUnloadWarning(doc) {
  if (!doc) return false;
  return doc.dirty || doc.status === 'saving' || !!doc._saving;
}

/**
 * A file Puter's Save dialog wrote under a name without ".docx" ("Notes", "Plan v1.2") gets it, as a word
 * processor's Save adds it. When that name is taken the file keeps the name the user gave it.
 */
async function withDocxExtension(item) {
  const name = `${P.displayName(item.path)}.docx`;
  const target = `${item.path.slice(0, item.path.lastIndexOf('/') + 1)}${name}`;
  try {
    if (await P.fileExists(target)) return item;
    await P.renameFile(item.path, name);
    return { ...item, path: target, name };
  } catch (e) {
    console.warn('[documents] could not add .docx to the saved file', e);
    return item;
  }
}

export class Doc extends EventTarget {
  constructor({ name = UNTITLED, path = null, uid = null, blob = null, dirty = false, template = null, pendingImport = null, importInfo = null, modified = null } = {}) {
    super();
    this.name = name;
    this.path = path;
    /** The file's id on the drive, which names the version history of a file outside the app folder; null when unknown. */
    this.uid = uid;
    /** The file's time stamp as this window last saw it (from writing it, or given at opening); null when unknown. Another window's write changes it. */
    this._remoteModified = modified ?? null;
    /** Template id to lay out once the engine is ready (new documents only). */
    this.template = template;
    /** Imported text content ({ value, type }) to build once the engine is ready. */
    this.pendingImport = pendingImport;
    this.importInfo = importInfo;
    /** The file's bytes as opened, for the engine to read; let go once the engine has them, since every later export comes from the engine. */
    this.blob = blob;
    /** Size of the last known bytes, for the details dialog. */
    this.size = blob?.size ?? null;
    this.status = 'saved';
    this.error = null;
    this.lastSaved = null;
    this.version = 0;
    this.savedVersion = 0;
    this.exporter = null;
    this._ready = null;
    /** When the newest version snapshot was taken: ms, null for none, undefined until read. */
    this.lastVersionAt = undefined;
    this._timer = null;
    this._saving = null;
    this._snapshotting = null;
    this._deleted = false;
    this._closed = false;
    if (dirty || template || pendingImport) { this.version = 1; this.status = 'unsaved'; }
  }

  /** "Report" for Documents/Report.docx; the file name for others. */
  static nameFor(path) {
    return P.stripExtension(P.displayName(path));
  }

  get dirty() {
    return this.version !== this.savedVersion;
  }

  get fileName() {
    return P.ensureDocx(this.name);
  }

  /** Editable .docx target; other extensions are saved as a fresh .docx. */
  get isDocxPath() {
    // A file the user named in Puter's Save dialog is the document's own, whatever its name ends with.
    return !!this.path && (/\.docx$/i.test(this.path) || this.path === this._placedAs);
  }

  /** Wire the engine's export function. Fires a pending first save for imports. */
  attach(exporter, { ready = null, busy = null } = {}) {
    if (this._deleted) return;
    this.exporter = exporter;
    /** Whether the editor cannot export just now (text still being composed with an IME): autosaves wait for it. */
    this._busy = busy;
    // The engine holds its own copy of the opened file: this one would only keep megabytes alive for the document's lifetime.
    this.size = this.blob?.size ?? this.size;
    this.blob = null;
    this._ready = ready ? Promise.resolve(ready) : null;
    // Saves and exports still receive an initialization failure; observe it
    // here as well in case the user has not asked to export yet.
    this._ready?.catch(() => {});
    if (this.dirty && this.autosave) this._schedule(this.autosaveDelay);
  }

  /** Nothing on screen is worth saving (a file the engine could not open, a reopen): no edits pending, and the status says so. */
  discardEdits() {
    this.savedVersion = this.version;
    this._setStatus('saved');
  }

  /** The editor has closed: no autosave or retry may run from here on. */
  destroy() {
    clearTimeout(this._timer);
    this._timer = null;
    this._closed = true;
  }

  /** A clean, saved document has nothing left to retry: a failed copy or restore must not leave the "Not saved" pill on it. */
  _settled() {
    if (this.status === 'error') this._setStatus('saved');
  }

  _setStatus(status, error = null) {
    if (this.status === status && this.error === error) return;
    this.status = status;
    this.error = error;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, error } }));
  }

  _schedule(ms) {
    // Signing in later saves the pending edits; the view asks for it.
    if (this._closed || session.signedOut) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save({ auto: true }).catch(() => {}), ms);
  }

  /**
   * In a shared document one client writes the file (the owner's elected tab); the others leave
   * saving to it: their edits reach the file through the room, so they are never "unsaved" here.
   */
  setSaving(on, { takeOver = false } = {}) {
    if (this.writes === !!on) return;
    // Taking over from the room's tab that wrote the file: its writes reached this copy through the room, so its
    // time stamp on the file is no change from another window.
    if (on && takeOver && this.writes === false) this._remoteModified = null;
    this.writes = !!on;
    if (!this.writes) { clearTimeout(this._timer); this._timer = null; this.savedVersion = this.version; this._setStatus('saved'); }
  }

  /** The engine reports an edit. */
  changed() {
    // After the editor has closed (a content error, a reopen) nothing from it may be saved over the file.
    if (this._deleted || this._closed) return;
    this.version += 1;
    if (this.writes === false) { this.savedVersion = this.version; return; }
    this._setStatus('unsaved');
    if (this.exporter && this.autosave) this._schedule(this.autosaveDelay);
  }

  /** AutoSave (on unless turned off in the title bar): edits save themselves; off, they wait for Save. */
  get autosave() { return autosaveEnabled(); }
  setAutosave(on) {
    setAutosaveEnabled(on);
    if (on && this.dirty && this.exporter) this._schedule(0);
    else if (!on && !this._saving) { clearTimeout(this._timer); this._timer = null; }
  }

  /**
   * The pause after the last edit before an autosave. Exporting and uploading a long document with
   * pictures takes seconds; saving it again a second and a half later would keep the engine exporting
   * and the connection uploading while the user types. The pause grows with the last save's duration.
   */
  get autosaveDelay() {
    return Math.min(MAX_AUTOSAVE_MS, Math.max(AUTOSAVE_MS, 3 * (this._lastSaveMs || 0)));
  }

  /** Finish all pending edits before leaving the editor; failures keep it open. Resolves false when the Save dialog was cancelled. */
  async flush() {
    while (this.dirty || this._saving) {
      // A clean document only waits for the operation holding the lock (a
      // rename, say); saving it again could turn a clean .dotx into a copy.
      if (!this.dirty) { try { await this._saving; } catch { /* that operation reported its own failure */ } continue; }
      if (await this.save()) continue;
      // Nowhere was chosen for the file: nothing went wrong, and leaving asks what to do with the document.
      if (this.exporter && this._needsPlace()) return false;
      throw new Error('The document is still opening. Try again in a moment');
    }
    return true;
  }

  /**
   * Save now. Resolves true when the file was written. `now` (with `auto`): the page is going to the
   * background, where the usual pause may never end, so edits made during a save in flight go right after it.
   */
  async save({ auto = false, now = false } = {}) {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._deleted || this.writes === false) return true;
    if (this._closed) return false;
    // With AutoSave off only Save writes: not the page going to the background, a reconnection, a sign-in or a retry.
    if (auto && !this.autosave) return false;
    while (this._saving) {
      try {
        await this._saving;
      } catch (e) {
        // A delete, rename or restore holding the file failed: its own dialog reported that, and this save still has to run.
        if (!auto && this._lockHolder !== 'save') continue;
        if (!auto) throw e;
        // A manual save can fail while this autosave waits for the file lock.
        // Keep the pending edits eligible for retry, unless the editor failed
        // to initialize and cannot safely export its content.
        try { await this._ready; } catch { return false; }
        if (!this._deleted && this.dirty && this.exporter) this._schedule(RETRY_MS);
        return false;
      }
      if (this._deleted) return true;
      if (!this.dirty && this.path) { this._settled(); return true; }
      // Edits landed during that save. An autosave waits for the usual pause
      // rather than writing twice in a row; an explicit save goes now.
      if (auto && !now) { this._schedule(this.autosaveDelay); return false; }
    }
    // Nothing to write, a clean template included: saving one again would only make a copy of it.
    if (!this.dirty && this.path) { this._settled(); return true; }
    if (!this.exporter) return false;
    // A pause inside an IME composition is not a failed save: try again after the usual pause.
    if (auto && this._busy?.()) { this._schedule(AUTOSAVE_MS); return false; }
    if (session.signedOut) {
      if (auto) return false;
      throw new Error(SIGN_IN_TO_SAVE);
    }
    // A new file inside the Puter desktop goes where the user puts it. Only Save asks; an autosave or a retry
    // writes nothing until then, since a dialog nobody asked for would come up in the middle of the typing.
    if (this._needsPlace()) return auto ? false : !!await this._placeFile(this.fileName, { copy: !!this.path, first: true });
    // The save that held the file may have planned another for these edits: this is it.
    clearTimeout(this._timer);
    this._timer = null;
    this._lockHolder = 'save';
    this._saving = this._doSave(auto).finally(() => { this._saving = null; });
    return this._saving;
  }

  async _doSave(auto) {
    let initialized = !this._ready;
    this._setStatus('saving');
    try {
      if (this._ready) await this._ready;
      initialized = true;
      // The pace follows the export and upload alone: the wait for an import's layout is not save time.
      const started = Date.now();
      const version = this.version;
      let target = this.path;
      if (!this.path || !this.isDocxPath) {
        // First save, or a non-docx source: pick a fresh name in the folder, the document's own (a rename before this save counts).
        const base = this.name;
        const fileName = await P.uniqueName(P.ensureDocx(base));
        target = `${P.FOLDER}/${fileName}`;
      }
      // The check for another window's hand on the file runs while the export does.
      const [blob, conflict] = await Promise.all([this.exporter(), target === this.path ? this._conflictWith(target) : null]);
      if (conflict) throw conflict;
      if (target !== this.path) {
        const created = await P.createFileWithMetadata(target, blob);
        target = created.path;
        this._remoteModified = created.modified;
        // A new file under the name of one that was shared and deleted is not that document: it must not rejoin its room.
        await forgetRoom(target);
      }
      else this._remoteModified = (await P.writeFile(target, blob))?.modified ?? null;
      // A failed export or write must not advertise a file that does not exist,
      // or make a clean document's next save short-circuit as already saved.
      if (target !== this.path) {
        // A template or other non-docx source stays where it was: the new file is a copy of it.
        const copy = !!this.path;
        this.path = target;
        this.uid = null; // a new file, in the app folder, whose history goes by its name
        this.name = Doc.nameFor(target);
        this._emitPath({ copy });
      }
      this.size = blob?.size ?? this.size;
      this.lastSaved = Date.now();
      this._lastSaveMs = this.lastSaved - started;
      this._snapshot(blob);
      // Edits that landed while the write was in flight keep the doc dirty.
      this.savedVersion = version;
      this._setStatus(this.dirty ? 'unsaved' : 'saved');
      if (this.dirty && this.autosave) this._schedule(this.autosaveDelay);
      return true;
    } catch (e) {
      console.error(e);
      // The editor closed this document meanwhile (an import whose layout failed): nothing is left to retry, and the pill must not say "Not saved".
      if (this._closed) return false;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      this._setStatus(offline ? 'offline' : 'error', e?.message || String(e));
      if (!auto) throw e;
      // Try again later; a transient failure should not lose the edit. Offline,
      // nothing can succeed until the connection is back, and the app saves then.
      // A file another window took over is not retried on its own: the same answer would come back every time.
      if (initialized && !offline && !e?.conflict) this._schedule(RETRY_MS);
      return false;
    }
  }

  /**
   * Whether the file changed hands since this window last saw it: moved,
   * renamed or deleted in another window (writing would bring it back or fork
   * it), or written by another window (writing would throw their work away).
   * Checked only once the file's time stamp is known; a check that itself
   * fails (the network, a storage without stat) leaves the save to proceed.
   */
  async _conflictWith(path) {
    if (this._remoteModified == null) return null;
    let stat;
    try { stat = await P.statFile(path); } catch { return null; }
    const conflict = (message) => Object.assign(new Error(message), { conflict: true });
    if (stat === null) return conflict('This file was moved or deleted in another window. Use Save a copy to keep your changes');
    if (stat.modified != null && String(stat.modified) !== String(this._remoteModified)) return conflict('This document was changed in another window. Use Save a copy to keep your changes, or reopen it to see theirs');
    return null;
  }

  /** Leave a version snapshot when one is due. Never affects the save status. */
  _snapshot(blob) {
    if (!versioning.enabled || !this.path || this._snapshotting) return;
    this._snapshotting = snapshotIfDue(this.path, blob, this.lastVersionAt, { meta: this.versionMeta?.(), uid: this.uid })
      .then((t) => { this.lastVersionAt = t; })
      .catch((e) => { console.warn('[documents] version snapshot failed', e); })
      .finally(() => { this._snapshotting = null; });
  }

  /** Snapshot the current content now (saving first when needed). Resolves the version or null. */
  async saveVersionNow(meta = {}) {
    if (this.dirty || !this.path) await this.save();
    return this._withFileLock(async () => {
      if (!this.path) return null;
      if (this._snapshotting) await this._snapshotting;
      const v = await saveVersion(this.path, await this.toBlob(), { meta: { ...this.versionMeta?.(), ...meta }, uid: this.uid });
      if (v) this.lastVersionAt = v.time;
      return v;
    });
  }

  /** Restore under the file lock, preserving current content and any newer edits. */
  async restoreVersion(versionPath, { stillWanted = () => true } = {}) {
    return this._withFileLock(async () => {
      if (this._deleted || !this.path) throw new Error('This document is no longer open');
      const path = this.path, version = this.version;
      const checkCurrent = () => {
        if (!stillWanted()) throw new Error('Restoration cancelled');
        if (this.version !== version) throw new Error('The document changed while preparing to restore. Your edits are kept; try restoring again.');
      };
      clearTimeout(this._timer);
      this._timer = null;
      let wrote = false;
      try {
        checkCurrent();
        // Read before the recovery snapshot can trim the selected history entry.
        const restored = await P.readFile(versionPath);
        // Another window's newer save must not be written over, as autosave and rename refuse to.
        const conflict = await this._conflictWith(path);
        if (conflict) throw conflict;
        if (this._snapshotting) await this._snapshotting;
        const current = await this.toBlob();
        checkCurrent();
        const recovery = await saveVersion(path, current, { uid: this.uid });
        if (!recovery) throw new Error('Could not keep a recovery version');
        this.lastVersionAt = recovery.time;
        checkCurrent();
        this._setStatus('saving');
        wrote = true;
        // This is our own write. Edits made while it is in flight must compare
        // against its new timestamp when autosave resumes.
        this._remoteModified = (await P.writeFile(path, restored))?.modified ?? null;
        // Edits made during the write stay dirty and autosave over the restored
        // bytes. Never reload over them or advertise them as already saved.
        if (this.version !== version) checkCurrent();
        this.size = restored?.size ?? this.size;
        this.savedVersion = version;
        this.lastSaved = Date.now();
        this._setStatus('saved');
        return path;
      } catch (e) {
        // A failure before the write leaves the file as it was: a clean document is still saved, not "Not saved".
        if (!wrote && !this.dirty) this._settled(); else this._setStatus('error', e?.message || String(e));
        throw e;
      } finally {
        clearTimeout(this._timer);
        this._timer = null;
        if (this.dirty && this.exporter) this._schedule(AUTOSAVE_MS);
      }
    });
  }

  _emitPath({ copy = false } = {}) {
    this.dispatchEvent(new CustomEvent('path', { detail: { path: this.path, name: this.name, copy } }));
  }

  /** Path changes share the save lock so no write can finish at an obsolete path. */
  async _withFileLock(operation) {
    while (this._saving) {
      try { await this._saving; } catch { /* A failed save must still allow recovery with Save a copy. */ }
    }
    this._lockHolder = 'operation';
    this._saving = operation().finally(() => { this._saving = null; });
    return this._saving;
  }

  /** Rename the file (and the document). Resolves null or an error message. */
  async rename(newName, { stillWanted = () => true } = {}) {
    return this._withFileLock(() => this._rename(newName, stillWanted));
  }

  async _rename(newName, stillWanted) {
    const cancelled = () => this._closed || !stillWanted();
    if (cancelled()) return 'Renaming cancelled';
    if (this._deleted) return 'This document has been deleted';
    const clean = P.documentStem(newName);
    if (!clean) return 'Enter a name';
    if (clean === this.name) return null;
    // A template being edited becomes a .docx copy at its first save: the name goes to that copy, not to the template file.
    if (!this.path || (!this.isDocxPath && this.dirty)) {
      // The first save would quietly become "Taken 2" if that name is in use;
      // say so now instead. Without a session there is nothing to check yet,
      // and a Save dialog asks about the name in the folder the user chose.
      if (!session.signedOut && !P.asksWhereToSave()) {
        try { if (await P.fileExists(`${P.FOLDER}/${clean}.docx`)) return 'A file with that name already exists'; }
        catch { /* the save will pick a free name if the folder cannot be read */ }
      }
      if (cancelled()) return 'Renaming cancelled';
      this.name = clean;
      // Naming a blank document is an edit too: autosave it and protect the
      // new name when leaving before the first write has finished.
      this.changed();
      this._emitPath();
      return null;
    }
    // A path with no folder part (a file at the root) renames in place; a dot in a folder's name is not an extension.
    const slash = this.path.lastIndexOf('/');
    const dir = slash >= 0 ? this.path.slice(0, slash + 1) : '';
    // A file with no extension keeps having none.
    const dot = this.path.lastIndexOf('.');
    const ext = this.isDocxPath ? '.docx' : dot > slash ? this.path.slice(dot) : '';
    const target = `${dir}${clean}${ext}`;
    try {
      const [exists, conflict] = await Promise.all([P.fileExists(target), this._conflictWith(this.path)]);
      if (exists) return 'A file with that name already exists';
      // A fresh rename timestamp must not bless content changed by another
      // window as the version currently open in this editor.
      if (conflict) return conflict.message;
      if (this._snapshotting) await this._snapshotting;
      if (cancelled()) return 'Renaming cancelled';
      this._remoteModified = (await P.renameFile(this.path, `${clean}${ext}`))?.modified ?? null;
    } catch (e) {
      return P.isNotFound(e) ? 'That file no longer exists' : (e?.message || 'Could not rename the file');
    }
    // The star on the home screen follows the file, as a rename there does; left behind, the next listing drops it.
    moveStar(this.path, target);
    forgetMade(this.path, target);
    await moveRoom(this.path, target);
    if (versioning.enabled) await renameVersions(this.path, target);
    // A published page stays up under its address; its record follows the
    // file in the background, since the rename itself is already done.
    if (publishing.enabled) movePublication(this.path, target).catch((e) => console.warn('[documents] the published page could not follow the rename', e));
    this.path = target;
    this.name = clean;
    this._emitPath();
    return null;
  }

  /**
   * Whether saving has to make a new file through Puter's Save dialog: inside the Puter desktop, a document
   * with no file of its own, or a template or other non-docx source whose edits go to a fresh .docx.
   */
  _needsPlace() {
    return (!this.path || !this.isDocxPath) && P.asksWhereToSave();
  }

  /** Whether edits are waiting for a first Save to ask where they go: nothing writes them until then, autosave included. */
  get waitsForPlace() {
    return this.dirty && !!this.exporter && this.writes !== false && !this._deleted && this._needsPlace();
  }

  /** Whether Puter's Save dialog is open for this document, so a save waiting on it is waiting on the user. */
  get choosingPlace() {
    return !!this._choosing;
  }

  /**
   * Puter's Save dialog for the document as it stands, suggesting `suggestedName`. The desktop writes the file,
   * and the document lives there from then on, as after a first save (`first`: a version snapshot is due) or
   * Save a copy (`copy`: the file it was opened from stays as it was). Resolves the file, or null when the user
   * cancels and nothing changes.
   *
   * The dialog holds no lock: it can stay open as long as the user likes, or never answer, and the file's
   * other operations must not wait on it. Taking the new path does, so no write in flight lands at the old one.
   */
  _placeFile(suggestedName, { copy = false, first = false } = {}) {
    // One dialog at a time: a second Save pressed before the desktop covers the window answers with the first.
    if (this._choosing) return this._choosing;
    const choosing = (async () => {
      while (this._saving) {
        try { await this._saving; } catch { /* that operation reported its own failure */ }
      }
      let version, blob, item;
      try {
        if (this._ready) await this._ready;
        version = this.version;
        // A document open read-only has no exporter: its copy is the file's own bytes, untouched.
        blob = await this.toBlob();
        item = await P.saveFileAs(blob, suggestedName);
      } catch (e) {
        this._setStatus('error', e?.message || String(e));
        throw e;
      }
      if (!item || this._deleted) return null;
      // Puter's dialog keeps the name as typed. Without the extension ("Notes") the file would count as a source to
      // copy from, as a template does: nothing would autosave to it, and every Save would ask again.
      if (!/\.docx$/i.test(item.path)) item = await withDocxExtension(item);
      // The dialog answers with a path from the home folder (~/Desktop/Report.docx) and no time stamp. The file
      // as the drive has it gives the spelling the home screen's listing uses, so its star, room and reading
      // position stay with it there, and the time stamp that arms the check for another window's writes.
      const st = await P.statFile(item.path).catch(() => null);
      const path = st?.path?.startsWith('/') && P.displayName(st.path) === P.displayName(item.path) ? st.path : item.path;
      if (this._deleted) return null;
      // Listed on the home screen with the app folder's own documents, though it was saved elsewhere.
      rememberMade({ path, uid: st?.uid || st?.id || item.uid || null });
      await this._withFileLock(async () => {
        // A new file under the name of one that was shared and deleted is not that document: it must not rejoin its room.
        await forgetRoom(path);
        this._remoteModified = st?.modified ?? item.modified ?? null;
        this.path = path;
        this._placedAs = path;
        this.uid = st?.uid || st?.id || item.uid || null;
        this.name = Doc.nameFor(path);
        this.size = blob?.size ?? this.size;
        this.lastSaved = Date.now();
        this.lastVersionAt = undefined;
        this.savedVersion = version;
        this._emitPath({ copy });
        if (first) this._snapshot(blob);
        // Edits made while the dialog was open keep the doc dirty, and now have a file to autosave to.
        this._setStatus(this.dirty ? 'unsaved' : 'saved');
        if (this.dirty && this.autosave) this._schedule(this.autosaveDelay);
      });
      return item;
    })().finally(() => { if (this._choosing === choosing) this._choosing = null; });
    this._choosing = choosing;
    return choosing;
  }

  /**
   * Save a copy where the user chooses (Puter's Save dialog, suggesting "<name> copy.docx") and switch to it.
   * Resolves null when saved, '' when the user cancelled (there is nothing to say), or why it failed.
   */
  async saveCopy({ stillWanted = () => true } = {}) {
    if (this._closed || !stillWanted()) return 'Saving a copy cancelled';
    if (this._deleted) return 'This document has been deleted';
    try {
      return await this._placeFile(`${P.documentStem(this.name) || UNTITLED} copy.docx`, { copy: true }) ? null : '';
    } catch (e) {
      return e?.message || 'Could not save';
    }
  }

  /** Save a copy under a new name in the app folder and switch to it. Without Puter's Save dialog, Save a copy asks for the name alone. */
  async saveAs(newName, { stillWanted = () => true } = {}) {
    return this._withFileLock(() => this._saveAs(newName, stillWanted));
  }

  async _saveAs(newName, stillWanted) {
    const cancelled = () => this._closed || !stillWanted();
    if (cancelled()) return 'Saving a copy cancelled';
    if (this._deleted) return 'This document has been deleted';
    const clean = P.documentStem(newName);
    if (!clean) return 'Enter a name';
    const target = `${P.FOLDER}/${clean}.docx`;
    try {
      if (await P.fileExists(target)) return 'A file with that name already exists';
      if (this._snapshotting) await this._snapshotting;
      if (cancelled()) return 'Saving a copy cancelled';
      clearTimeout(this._timer);
      this._timer = null;
      this._setStatus('saving');
      const version = this.version;
      const blob = await this.toBlob();
      if (cancelled()) {
        // Exporting has not changed the cloud file. Restore the original
        // document's save status when its copy is cancelled before uploading.
        this._setStatus(this.dirty ? 'unsaved' : 'saved');
        return 'Saving a copy cancelled';
      }
      this._remoteModified = (await P.writeFile(target, blob, { overwrite: false }))?.modified ?? null;
      await forgetRoom(target);
      this.size = blob?.size ?? this.size;
      this.path = target;
      this.uid = null;
      this.name = clean;
      this.lastSaved = Date.now();
      this.lastVersionAt = undefined;
      this.savedVersion = version;
      this._setStatus(this.dirty ? 'unsaved' : 'saved');
      this._emitPath({ copy: true });
      return null;
    } catch (e) {
      if (cancelled()) {
        this._setStatus(this.dirty ? 'unsaved' : 'saved');
        return 'Saving a copy cancelled';
      }
      this._setStatus('error', e?.message);
      return e?.message || 'Could not save';
    } finally {
      if (this.dirty && this.exporter) this._schedule(AUTOSAVE_MS);
    }
  }

  /** Current bytes: a fresh export when the engine is attached, else the last known blob. */
  async toBlob() {
    if (this._ready) await this._ready;
    if (this.exporter) return this.exporter();
    if (this.blob) return this.blob;
    throw new Error('Nothing to export yet');
  }

  /** Delete after outstanding writes and snapshots finish, so none can recreate the file. */
  async remove() {
    return this._withFileLock(async () => {
      if (!this.path) return;
      const path = this.path, uid = this.uid;
      clearTimeout(this._timer);
      this._timer = null;
      try {
        if (this._snapshotting) await this._snapshotting;
        // A file another window already removed is as deleted as this one wants it; the next edit must not recreate it.
        try { await P.deleteFile(path); } catch (e) { if (!P.isNotFound(e)) throw e; }
        this._deleted = true;
        this.exporter = null;
        this.path = null;
        this.savedVersion = this.version;
        this._setStatus('saved');
        if (versioning.enabled) await deleteVersions(path, { uid });
        forgetMade(path);
        await forgetRoom(path);
        // Nothing is left to update the page from; a page nobody can take down must not stay online.
        if (publishing.enabled) unpublishAt(path).catch((e) => console.warn('[documents] the published page could not be taken down', e));
      } finally {
        if (!this._deleted && this.dirty && this.exporter) this._schedule(AUTOSAVE_MS);
      }
    });
  }

  /* ---------- Constructors ---------- */

  static async fromPath(path) {
    // Arm conflict detection before the first edit, including a file deleted
    // after opening. Metadata and bytes load together; a storage that cannot
    // stat must still allow reading the document.
    const [stat, blob] = await Promise.all([
      /\.docx$/i.test(path) ? P.statFile(path).catch(() => null) : null,
      P.readFile(path), P.prepareDocumentPaths(),
    ]);
    if (HANWORD_IMPORTABLE.test(path)) return Doc.fromImportFile(new File([blob], P.displayName(path)));
    return new Doc({ name: Doc.nameFor(path), path, uid: stat?.uid || stat?.id || null, blob, modified: stat?.modified });
  }

  /** Convert before opening: Hanword originals always become fresh DOCX copies. */
  static async fromImportFile(file) {
    if (HANWORD_IMPORTABLE.test(file.name)) {
      const { blob, format, warnings } = await importHanword(file);
      return new Doc({ name: P.stripExtension(file.name) || UNTITLED, blob, dirty: true,
        importInfo: { format, sourceName: file.name, warnings } });
    }
    const kind = importKind(file.name, file.type);
    if (kind) {
      if (file.size > MAX_TEXT_IMPORT_BYTES) throw new Error('This file is too large to import as text. Files up to 20 MB can be imported');
      return Doc.fromTextImport(P.stripExtension(file.name), toInsertPayload(decodeTextFile(await file.arrayBuffer(), kind), kind));
    }
    return Doc.fromBrowserFile(file);
  }

  /** From a browser File (device import). Saved as a new file once the engine is ready. */
  static fromBrowserFile(file) {
    return new Doc({ name: P.stripExtension(file.name) || UNTITLED, path: null, blob: file, dirty: true });
  }

  /** A new document that starts as a copy of a template file of the user's own. */
  static async fromTemplateFile(path) {
    const blob = await P.readFile(path);
    if (HANWORD_IMPORTABLE.test(path)) return Doc.fromImportFile(new File([blob], P.displayName(path)));
    return new Doc({ name: Doc.nameFor(path), path: null, blob, dirty: true });
  }

  /** A new document whose content comes from an imported text file (Markdown, HTML, plain text). */
  static fromTextImport(name, payload) {
    return new Doc({ name: P.sanitizeName(name) || UNTITLED, pendingImport: payload });
  }

  /** A new document, optionally from a template (which also names it). */
  static blank({ template = null, name = null } = {}) {
    return new Doc({ name: name || UNTITLED, template });
  }
}
