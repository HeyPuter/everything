// Document file operations: new, open, save, save as, import and export,
// plus crash recovery of unsaved work in browser storage.

import { defaultName } from '../model/features';
import { allocateId, newDocument, parseDocument, serializeDocument, withUsedBlobs } from '../model/document';
import type { ImportFeature, PartDocument } from '../model/types';
import {
  type Location, EXT, IMPORT_EXTS, clearRecovery, download, isSolidWorksFile, isStepFile, listParts, loadText, locationLabel, newLocation,
  pickCloudFile, pickCloudSave, pickDeviceFile, orphanRecoveries, removeRecovery, safeName, writeRecovery, type FileEntry, deletePart, forgetRecent, rememberRecent,
  onRenamedElsewhere, onSavedElsewhere, sameLocation, type FileVersion, cloudVersion, loadPart, partFileName, readIndexEntry, renameCloudPart, savePart, versionChanged, versionOf,
} from '../platform/files';
import { type PuterFSItem, cloudAvailable, env, isMissing, puter, signIn, storageError } from '../platform/puter';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { confirmDialog, dialogOpen, promptDialog, showDialog, toast } from '../ui/overlay';
import type { App } from './app';
import { sharedWithMe } from './share';

export class FileOps {
  /** Adjacent Save requests share a write until that write starts. */
  private queuedSave: { documentVersion: number; result: Promise<boolean> } | null = null;
  private fileQueue: Promise<void> = Promise.resolve();
  private queuedFileOperations = 0;
  private recoveryTimer = 0;
  /** A recovered copy retained until this tab writes a durable replacement. */
  private recoverySource: string | null = null;
  /** Counts document changes, so a save only clears the edits it wrote. */
  private revision = 0;
  /** Changes only when another document opens, not on edits or undo. */
  private documentVersion = 0;
  private openRequest: AbortController | null = null;
  /** The open part's file, when another tab saved it after this tab opened or saved it. */
  private savedElsewhere: Location | null = null;
  /** The Puter drive file being opened (a launch and a drop of the same file open it once). */
  private openingDrivePath: string | null = null;
  /**
   * The version of the open part's cloud file this tab last opened or saved.
   * Anyone saving the file since (another device, or a person it is shared
   * with) changes it, and saving here then asks before replacing their work.
   */
  private known: { path: string; version: FileVersion } | null = null;

  constructor(private app: App) {
    app.onDocumentChanged = (reason) => {
      if (reason === 'load') {
        this.documentVersion++;
        this.openRequest?.abort();
        this.savedElsewhere = null;
        this.known = null;
      }
      if (reason !== 'saved') this.revision++;
      this.scheduleRecovery();
    };
    // A hidden tab can be closed without notice (phones discard background tabs).
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flushRecovery(); });
    window.addEventListener('pagehide', () => this.flushRecovery());
    onSavedElsewhere((loc) => {
      if (!sameLocation(loc, app.location) || sameLocation(loc, this.savedElsewhere)) return;
      this.savedElsewhere = loc;
      const name = app.store.doc.name;
      toast({
        kind: 'warning',
        message: `"${name}" was saved in another tab. ${app.store.dirty ? 'Saving here replaces that version.' : 'Reopen it to see those changes.'}`,
        actions: [{ label: 'Reopen', run: () => void this.openLocation(loc, name) }],
        timeout: 12000,
      });
    });
    // Another tab renamed the open part's file: save to the new file, under the new name.
    onRenamedElsewhere((from, to, name) => {
      if (sameLocation(from, this.savedElsewhere)) this.savedElsewhere = to;
      if (!sameLocation(from, app.location)) return;
      this.setLocation(to, this.known && from.type === 'cloud' && this.known.path === from.path ? this.known.version : null);
      if (app.store.doc.name !== name) app.store.change('Rename part', (doc) => { doc.name = name; });
      toast({ message: `This part was renamed to "${name}" in another tab.`, timeout: 6000 });
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.app.store.dirty || this.app.panel?.edited) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.bindDrop();
  }

  /**
   * Files dropped on the app open as a part. Files dragged in from a Puter
   * folder window arrive as a drop event the SDK dispatches, with the drive
   * entries in its detail and no dataTransfer. (The assistant panel takes its
   * own drops as attachments.)
   */
  private bindDrop() {
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = dialogOpen() ? 'none' : 'copy';
    });
    window.addEventListener('drop', (e) => {
      const items = (e as unknown as CustomEvent<{ items?: unknown }>).detail?.items;
      if (!e.dataTransfer && Array.isArray(items)) {
        e.preventDefault();
        if (!dialogOpen()) void this.openDriveItems(items);
        return;
      }
      if (!hasFiles(e)) return;
      e.preventDefault();
      // Not behind a dialog that is waiting for an answer.
      if (!dialogOpen()) void this.openDroppedFiles([...e.dataTransfer!.files]);
    });
  }

  /** Files dropped from this device: the first one Parametric opens, as From device does. */
  async openDroppedFiles(files: File[]) {
    const file = this.pickOne(files.map((f) => ({ item: f, name: f.name })))?.item;
    if (!file) return;
    const signal = this.beginOpen();
    if (await this.openBlob(file, file.name, null, signal)) this.app.store.dirty = true;
  }

  /**
   * Opens entries of the Puter drive: launch items (double click or Open with
   * on the desktop) and files dragged in from a desktop folder window. A part
   * opens where it lives, so Save writes back to the same file. Folders and
   * files Parametric does not open are not read.
   */
  async openDriveItems(given: unknown) {
    const all = (Array.isArray(given) ? given : [given]).filter((it): it is PuterFSItem => !!it && typeof it === 'object');
    const files = all.filter((it) => typeof it.path === 'string' && !!it.path && !isDriveFolder(it));
    if (!files.length) {
      if (all.some(isDriveFolder)) toast({ message: 'Folders cannot be opened. Open a part inside the folder instead.' });
      return;
    }
    const picked = this.pickOne(files.map((f) => ({ item: f, name: f.name || f.path.replace(/\/+$/, '').split('/').pop() || f.path })));
    if (!picked) return;
    const { item: it, name } = picked;
    const loc: Location = { type: 'cloud', path: it.path };
    if (sameLocation(loc, this.app.location)) {
      toast({ message: `"${this.app.store.doc.name}" is already open.` });
      return;
    }
    if (this.openingDrivePath === it.path) return;
    if (typeof it.size === 'number' && tooLarge(it.size, name)) return;
    const signal = this.beginOpen();
    this.openingDrivePath = it.path;
    try {
      // The version is asked first, so a save landing meanwhile counts as a change.
      const version = versionOf(it) ? Promise.resolve(versionOf(it)) : cloudVersion(it.path);
      // Launch items can read themselves; dropped entries are plain records.
      const blob = it.read ? await it.read() : await puter()!.fs.read(it.path);
      if (!signal.aborted) await this.openBlob(blob, name, loc, signal, (await version) ?? null);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not open the file', message: isMissing(e) ? `"${name}" no longer exists. It may have been moved or deleted.` : storageError(e) });
    } finally {
      if (this.openingDrivePath === it.path) this.openingDrivePath = null;
    }
  }

  /**
   * The first file Parametric can open, after saying which files it leaves out:
   * ones it does not open, and the rest when several are given (one part is open at a time).
   */
  private pickOne<T>(files: { item: T; name: string }[]): { item: T; name: string } | null {
    const openable = files.filter((f) => canOpen(f.name));
    const other = files.filter((f) => !canOpen(f.name));
    if (other.length) {
      const what = other.length === 1 ? `${other[0].name} is not a file Parametric opens.` : `${other.length} of these files are not files Parametric opens.`;
      toast({ kind: openable.length ? 'warning' : 'error', message: `${what} Choose a part (${EXT}), a STEP file (.step, .stp) or a SolidWorks part (.sldprt).`, timeout: 8000 });
    }
    if (!openable.length) return null;
    if (openable.length > 1) toast({ message: `Parametric opens one part at a time, so only ${openable[0].name} is opened.`, timeout: 8000 });
    return openable[0];
  }

  /** A later file operation must not be overwritten by an earlier completion. */
  private fileOperation<T>(operation: () => Promise<T>): Promise<T> {
    // Rename and Save As separate Save requests into distinct ordered writes.
    this.queuedSave = null;
    const waiting = this.queuedFileOperations++ > 0;
    const dismiss = waiting ? toast({ message: 'Waiting for the current file operation…', timeout: 0 }) : null;
    const result = this.fileQueue.then(async () => {
      dismiss?.();
      try {
        return await operation();
      } finally {
        this.queuedFileOperations--;
      }
    });
    this.fileQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Asks to save or discard unsaved changes. Returns false to abort. */
  async confirmDiscard(action: string, signal = this.app.documentSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const documentVersion = this.documentVersion;
    // A feature panel with changes not yet applied counts as unsaved work too.
    const panel = this.app.panel?.edited ? this.app.panel : null;
    if (!this.app.store.dirty && !panel) return true;
    const v = await showDialog({
      title: 'Save changes?', signal,
      body: h('p', {}, `"${this.app.store.doc.name}" has unsaved changes${panel ? ` (including ${panel.title}, which is still open)` : ''}. Save them before you ${action}?`),
      buttons: [{ label: 'Cancel', value: 'cancel', left: true }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }],
    });
    if (documentVersion !== this.documentVersion || signal.aborted) return false;
    if (v === 'save') {
      // Apply the open panel first; a value it refuses keeps everything open.
      if (panel) {
        await this.app.closePanel(true);
        if (this.app.panel || documentVersion !== this.documentVersion || signal.aborted) return false;
      }
      if (!(await this.save()) || documentVersion !== this.documentVersion || signal.aborted) return false;
      // A successful write can still leave newer edits unsaved.
      if (this.app.store.dirty || this.app.panel?.edited) {
        toast({ kind: 'warning', message: 'More changes were made while saving. They are still open and unsaved.' });
        return false;
      }
      return true;
    }
    if (v !== 'discard') return false;
    // Discarded on purpose: do not offer it for recovery next time.
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = 0;
    await this.clearRecoveryCopies();
    return documentVersion === this.documentVersion && !signal.aborted;
  }

  async newPart() {
    if (!(await this.confirmDiscard('start a new part'))) return;
    this.app.newDocument(nextUntitled());
    await this.clearRecoveryCopies();
  }

  /** Save to the current location, or ask where for a new document. */
  async save(): Promise<boolean> {
    const app = this.app;
    if (app.sketchEditor) app.exitSketch(true);
    const documentVersion = this.documentVersion;
    if (this.queuedSave?.documentVersion === documentVersion) return this.queuedSave.result;
    const result: Promise<boolean> = this.fileOperation(async () => {
      if (this.queuedSave?.result === result) this.queuedSave = null;
      if (documentVersion !== this.documentVersion) return false;
      let loc = app.location;
      let isNew = !loc;
      if (!loc) loc = await newLocation(app.store.doc.name);
      if (documentVersion !== this.documentVersion) return false;
      const conflict = isNew ? null : await this.savedSince(loc);
      if (documentVersion !== this.documentVersion) return false;
      if (conflict) {
        const choice = await showDialog({
          title: 'Replace the saved part?', signal: app.documentSignal,
          body: h('p', {}, `"${app.store.doc.name}" was saved ${conflict === 'tab' ? 'in another tab' : 'elsewhere (on another device, or by someone it is shared with)'} after you opened it here. Replace that version with yours, or keep both by saving yours as a copy?`),
          buttons: [{ label: 'Cancel', value: 'cancel', left: true }, { label: 'Save as a copy', value: 'copy' }, { label: 'Replace', value: 'replace', danger: true }],
        });
        if (documentVersion !== this.documentVersion || (choice !== 'replace' && choice !== 'copy')) return false;
        if (choice === 'copy') {
          loc = await newLocation(app.store.doc.name);
          isNew = true;
          if (documentVersion !== this.documentVersion) return false;
        }
      }
      // Undo replaces the document object while destination lookup is pending.
      const doc = app.store.doc;
      const text = serializeDocument(doc);
      const revision = this.revision;
      const { location: saved, version } = await savePart(loc, doc.name, text, isNew);
      // The write may finish after New/Open. It belongs to the old part.
      if (documentVersion !== this.documentVersion) return true;
      this.setLocation(saved, version);
      if (sameLocation(loc, this.savedElsewhere)) this.savedElsewhere = null;
      // A new cloud file can get a free name of its own: the part takes it.
      const fileName = isNew ? partFileName(saved) : '';
      const unchanged = revision === this.revision;
      if (fileName && fileName !== app.store.doc.name) app.store.change('Rename part', (d) => { d.name = fileName; });
      this.markSaved(unchanged ? this.revision : revision);
      toast({ kind: 'success', message: `Saved to ${locationLabel(app.location)}`, timeout: 2500 });
      if (saved.type === 'local' && !cloudAvailable()) {
        maybeNudgeSignIn();
      }
      return true;
    }).catch((e) => {
      // The work is still only in this tab: offer a copy on the device meanwhile.
      toast({ kind: 'error', title: 'Could not save', message: storageError(e), actions: [{ label: 'Download a copy', run: () => void this.exportAs('part') }], timeout: 15000 });
      return false;
    });
    this.queuedSave = { documentVersion, result };
    return result;
  }

  /** Where the open part now lives, and the version of its cloud file written or read there. */
  private setLocation(loc: Location, version: FileVersion | null) {
    this.app.location = loc;
    this.known = loc.type === 'cloud' && version ? { path: loc.path, version } : null;
  }

  /**
   * Whether the part's file was saved by someone else since this tab opened or
   * saved it: 'tab' for another tab of this browser, 'elsewhere' for another
   * device or person. A file that cannot be checked (offline, say) is saved as usual.
   */
  private async savedSince(loc: Location): Promise<'tab' | 'elsewhere' | null> {
    if (sameLocation(loc, this.savedElsewhere)) return 'tab';
    const known = this.known;
    if (loc.type !== 'cloud' || known?.path !== loc.path) return null;
    const now = await cloudVersion(loc.path);
    return now && versionChanged(now, known.version) ? 'elsewhere' : null;
  }

  /** After a write: clean, unless the part changed while it was being written. */
  private markSaved(revision: number) {
    const clean = revision === this.revision;
    if (clean) this.app.store.dirty = false;
    this.app.store.emit('saved');
    if (clean) void this.clearRecoveryCopies();
  }

  async saveAs() {
    const app = this.app;
    const documentVersion = this.documentVersion;
    // Puter's save dialog asks for the name itself, starting from the part's.
    const picker = cloudAvailable() && !!puter()?.ui?.showSaveFilePicker;
    const name = picker ? app.store.doc.name : await promptDialog('Save As', 'Part name', app.store.doc.name, (v) => (v.trim() ? null : 'Enter a name'), app.documentSignal);
    if (name == null || documentVersion !== this.documentVersion) return;
    return this.fileOperation(async () => {
      if (documentVersion !== this.documentVersion) return;
      // Finish the sketch before either save path captures the document, so
      // its discard snapshot cannot later restore the pre-save name/content.
      if (app.sketchEditor) app.exitSketch(true);
      const clean = safeName(name);
      const rename = (to: string) => app.store.change('Rename part', (doc) => { doc.name = to; });
      if (picker && cloudAvailable()) {
        const revision = this.revision;
        // null when the user cancels the picker; undefined when it failed (save to Parts instead).
        const picked = await pickCloudSave(serializeDocument({ ...app.store.doc, name: clean }), clean).catch(() => undefined);
        // The name can be changed in the picker: the part takes its file's
        // name, as it will when the file is opened.
        const fileName = picked ? partFileName(picked.location) || clean : clean;
        if (picked) rememberRecent({ location: picked.location, name: fileName });
        if (picked === null || documentVersion !== this.documentVersion) return;
        if (picked) {
          const unchanged = revision === this.revision;
          rename(fileName);
          this.setLocation(picked.location, picked.version);
          this.markSaved(unchanged ? this.revision : revision);
          toast({ kind: 'success', message: `Saved to ${locationLabel(picked.location)}` });
          return;
        }
      }
      try {
        const loc = await newLocation(clean);
        if (documentVersion !== this.documentVersion) return;
        const revision = this.revision;
        const { location: saved, version } = await savePart(loc, clean, serializeDocument({ ...app.store.doc, name: clean }), true);
        if (documentVersion !== this.documentVersion) return;
        const unchanged = revision === this.revision;
        rename(partFileName(saved) || clean);
        this.setLocation(saved, version);
        this.markSaved(unchanged ? this.revision : revision);
        toast({ kind: 'success', message: `Saved to ${locationLabel(saved)}`, timeout: 2500 });
        if (saved.type === 'local' && !cloudAvailable()) maybeNudgeSignIn();
      } catch (e) {
        toast({ kind: 'error', title: 'Could not save', message: storageError(e), actions: [{ label: 'Download a copy', run: () => void this.exportAs('part') }], timeout: 15000 });
      }
    });
  }

  /** Each new Open choice supersedes earlier reads, pickers and confirmations. */
  private beginOpen(): AbortSignal {
    this.openRequest?.abort();
    this.openRequest = new AbortController();
    return this.openRequest.signal;
  }

  /** Opens a part from a location (cloud or local). */
  async openLocation(loc: Location, name?: string, signal = this.beginOpen(), size?: number | null) {
    // A size the listing gave is checked before the file is downloaded.
    if (typeof size === 'number' && tooLarge(size, `x${EXT}`)) return;
    let read: { text: string; version: FileVersion | null };
    // A large part or a slow connection: say what is happening.
    let reading: (() => void) | null = null;
    const slow = setTimeout(() => { reading = toast({ message: `Opening "${name || 'the part'}"...`, timeout: 0 }); }, 600);
    try {
      read = await loadPart(loc);
    } catch (e) {
      // Gone (deleted or moved elsewhere): drop it from the recent parts too.
      const missing = isMissing(e);
      if (missing) forgetRecent(loc);
      toast({ kind: 'error', title: 'Could not open the part', message: missing ? `"${name || 'The part'}" no longer exists. It may have been moved or deleted.` : storageError(e) });
      return;
    } finally {
      clearTimeout(slow);
      (reading as (() => void) | null)?.();
    }
    if (!signal.aborted) await this.openPartText(read.text, loc, name, signal, read.version);
  }

  openText(text: string, loc: Location | null, name?: string): boolean {
    const doc = parsePart(text);
    if (doc) this.openDoc(doc, loc, name);
    return !!doc;
  }

  private openDoc(doc: PartDocument, loc: Location | null, name?: string, version: FileVersion | null = null) {
    // A cloud file renamed outside Parametric (on the Puter desktop, say) opens
    // under its file's name, as the Open dialog lists it and Rename renames it.
    const fileName = loc ? partFileName(loc) : '';
    if (fileName) doc.name = fileName;
    else if (name && !doc.name) doc.name = name;
    this.app.loadDocument(doc, loc);
    if (loc) this.setLocation(loc, version);
    if (loc) rememberRecent({ location: loc, name: doc.name });
  }

  /** Reads a part file and, only if it is one, asks about unsaved changes and opens it. */
  private async openPartText(text: string, loc: Location | null, name: string | undefined, signal: AbortSignal, version: FileVersion | null = null): Promise<boolean> {
    const doc = parsePart(text);
    if (!doc || !(await this.confirmDiscard('open another part', signal)) || signal.aborted) return false;
    this.openDoc(doc, loc, name, version);
    return true;
  }

  /** Open dialog listing cloud and browser-stored parts. */
  async open() {
    const signal = this.beginOpen();
    // Parts in this browser stay listed when the cloud cannot be reached.
    let cloudError = '';
    // A slow connection can hold the dialog back for a while: say why nothing opens yet.
    let loaded: (() => void) | null = null;
    const slow = setTimeout(() => { loaded = toast({ message: 'Loading your parts...', timeout: 0 }); }, 400);
    const entries = await listParts((e) => { cloudError = storageError(e); });
    clearTimeout(slow);
    (loaded as (() => void) | null)?.();
    if (signal.aborted) return;
    // A list role needs list items, so the empty message is shown without it.
    const list = h('div', { class: 'file-list', role: 'list' });
    const showEmpty = () => {
      list.removeAttribute('role');
      list.replaceChildren(h('p', {}, cloudError ? 'No parts saved in this browser.' : cloudAvailable() ? 'No saved parts yet.' : 'No parts saved in this browser yet. Sign in to Puter to keep parts in your cloud storage.'));
    };
    let chosen: FileEntry | null = null;
    let close: ((v: string | null) => void) | null = null;
    const done = (e: FileEntry) => { chosen = e; close?.('open'); };
    if (!entries.length) showEmpty();
    for (const e of entries) {
      const b = h('button', { class: 'file-item', type: 'button' },
        e.location.type === 'cloud' ? iconCloud() : iconDevice(),
        h('span', { class: 'txt' }, h('span', { class: 'n' }, e.name), h('span', { class: 'meta' }, `${locationLabel(e.location)}  ${e.modified ? new Date(e.modified).toLocaleString() : ''}`)));
      const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${e.name}`, title: 'Delete' }, icon('trash', 16));
      const row = h('div', { class: 'file-row', role: 'listitem' }, b, del);
      const remove = async () => {
        if (!(await confirmDialog('Delete part', `Delete "${e.name}"? ${e.location.type === 'cloud' ? 'It will be moved to your Puter Trash.' : 'This cannot be undone.'}`, 'Delete', true))) return;
        try {
          await deletePart(e.location);
          row.remove();
          if (!list.childElementCount) showEmpty();
        } catch (err) {
          toast({ kind: 'error', title: 'Could not delete the part', message: storageError(err) });
        }
      };
      b.addEventListener('click', () => done(e));
      b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); void remove(); });
      del.addEventListener('click', () => void remove());
      list.append(row);
    }
    const body = h('div', {}, cloudError ? h('p', { role: 'alert' }, `Your cloud parts could not be listed: ${cloudError}`) : null, list);
    let sharedChosen: { readOnly: boolean } | null = null;
    if (cloudAvailable()) {
      const shared = h('div', { class: 'file-list', role: 'list', 'aria-busy': 'true' }, h('p', { class: 'field-label' }, 'Loading...'));
      body.append(h('h3', { class: 'file-section' }, 'Shared with me'), shared);
      void sharedWithMe().catch((e) => e as Error).then((items) => {
        shared.removeAttribute('aria-busy');
        shared.replaceChildren();
        if (!Array.isArray(items)) {
          shared.removeAttribute('role');
          shared.append(h('p', { role: 'alert' }, `Could not load the parts shared with you: ${storageError(items)}`));
          return;
        }
        if (!items.length) {
          shared.removeAttribute('role');
          shared.append(h('p', { class: 'field-label' }, 'Nothing has been shared with you yet.'));
        }
        for (const e of items) {
          const readOnly = e.mode === 'read';
          const b = h('button', { class: 'file-item', type: 'button' },
            h('span', { 'aria-hidden': 'true', style: { color: 'var(--text-3)' } }, icon('users', 18)),
            h('span', { class: 'txt' }, h('span', { class: 'n' }, e.name), h('span', { class: 'meta' }, [e.owner ? `From ${e.owner}` : '', readOnly ? 'View only' : 'Can edit', e.modified ? new Date(e.modified).toLocaleString() : ''].filter(Boolean).join(' · '))));
          b.addEventListener('click', () => { sharedChosen = { readOnly }; done(e); });
          shared.append(h('div', { class: 'file-row', role: 'listitem' }, b));
        }
      });
    }
    const buttons: { label: string; value: string; primary?: boolean; left?: boolean }[] = [{ label: 'From device...', value: 'device', left: true }];
    if (cloudAvailable() && puter()?.ui?.showOpenFilePicker) buttons.push({ label: 'Browse Puter...', value: 'browse', left: true });
    buttons.push({ label: 'Cancel', value: 'cancel' });
    const v = await showDialog({ title: 'Open', signal, body, buttons, wide: true, onReady: (c) => { close = c; } });
    if (signal.aborted) return;
    if (v === 'open' && chosen) {
      const c = chosen as FileEntry;
      if ((sharedChosen as { readOnly: boolean } | null)?.readOnly) await this.openReadOnlyCopy(c, signal);
      else await this.openLocation(c.location, c.name, signal, c.size);
    }
    else if (v === 'device') await this.openFromDevice(signal);
    else if (v === 'browse') {
      const r = await pickCloudFile().catch((e) => { toast({ kind: 'error', message: storageError(e) }); return null; });
      if (r) await this.openBlob(r.blob, r.fileName, r.location, signal, r.version);
    }
  }

  /** View-only shares open detached: saving makes a copy in the user's own Parts. */
  private async openReadOnlyCopy(e: FileEntry, signal: AbortSignal) {
    let text: string;
    try {
      text = await loadText(e.location);
    } catch (err) {
      toast({ kind: 'error', title: 'Could not open the part', message: storageError(err) });
      return;
    }
    // Read and checked first: a file that cannot be opened leaves the current part alone.
    if (signal.aborted || !(await this.openPartText(text, null, e.name, signal))) return;
    toast({ message: `"${e.name}" is shared with you as view only. Saving keeps your own copy.`, timeout: 6000 });
  }

  async openFromDevice(signal = this.beginOpen()) {
    const file = await pickDeviceFile(`${EXT},.json,${IMPORT_EXTS.join(',')}`);
    if (file && await this.openBlob(file, file.name, null, signal)) this.app.store.dirty = true;
  }

  /** A delayed picker or file read must not act on a replacement document. */
  private async openBlob(blob: Blob, fileName: string, loc: Location | null, signal: AbortSignal, version: FileVersion | null = null): Promise<boolean> {
    if (signal.aborted || tooLarge(blob.size, fileName)) return false;
    if (isSolidWorksFile(fileName)) {
      const data = new Uint8Array(await blob.arrayBuffer());
      if (!signal.aborted) await this.openSolidWorks(data, fileName, signal);
      return false;
    }
    const text = await blob.text();
    if (signal.aborted) return false;
    if (isStepFile(fileName)) { await this.openStep(text, fileName, signal); return false; }
    return this.openPartText(text, loc, fileName.replace(/\.[^.]+$/, ''), signal, version);
  }

  /** Imports a STEP or SolidWorks file as a solid feature in the current part. */
  async importStep() {
    const documentVersion = this.documentVersion;
    const file = await pickDeviceFile(IMPORT_EXTS.join(','));
    if (!file || documentVersion !== this.documentVersion || tooLarge(file.size, file.name)) return;
    if (isSolidWorksFile(file.name)) {
      const step = await this.convertSolidWorks(new Uint8Array(await file.arrayBuffer()), file.name);
      if (step && documentVersion === this.documentVersion) await this.importStepText(step, file.name);
      return;
    }
    const text = await file.text();
    if (documentVersion === this.documentVersion) await this.importStepText(text, file.name);
  }

  /** Opens a SolidWorks part as a new part whose first feature is its solid. */
  async openSolidWorks(data: Uint8Array, fileName: string, signal = this.beginOpen()) {
    const step = await this.convertSolidWorks(data, fileName);
    if (step && !signal.aborted) await this.openStep(step, fileName, signal);
  }

  /** Opens a STEP model (or a converted SolidWorks part) as a new part whose first feature is its solid. */
  private async openStep(step: string, fileName: string, signal: AbortSignal) {
    const app = this.app;
    const solidWorks = isSolidWorksFile(fileName);
    // Checked first: a file that cannot be opened leaves the current part alone.
    if (!step.trim()) { toast({ kind: 'error', title: 'Could not open the file', message: `${fileName} is empty.` }); return; }
    const err = await app.kernel.checkImport(step).catch((e) => (e as Error).message);
    if (signal.aborted) return;
    if (err) { toast({ kind: 'error', title: solidWorks ? 'Could not open the SolidWorks part' : 'Could not open the STEP file', message: err }); return; }
    if (!(await this.confirmDiscard('open another part', signal)) || signal.aborted) return;
    const doc = newDocument(safeName(fileName.replace(/\.[^.]+$/, '')) || 'Part1', app.settings.defaultUnits);
    const blobId = newBlobId(doc);
    doc.blobs[blobId] = step;
    doc.features.push({ id: allocateId(doc), name: defaultName(doc, 'import'), type: 'import', format: 'step', blob: blobId, fileName });
    app.loadDocument(doc, null);
    app.store.dirty = true;
    toast({ kind: 'success', message: solidWorks ? `Opened ${fileName}. SolidWorks feature history is not included: the part is one solid body to build on.` : `Opened ${fileName} as a new part.`, timeout: solidWorks ? 7000 : undefined });
  }

  /** Converts a SolidWorks part to STEP in the geometry worker; null after reporting a failure. */
  private async convertSolidWorks(data: Uint8Array, fileName: string): Promise<string | null> {
    if (tooLarge(data.length, fileName)) return null;
    const done = toast({ message: `Reading ${fileName}...`, timeout: 0 });
    try {
      const r = await this.app.kernel.convertSolidWorks(data, fileName);
      if (r.skipped) {
        toast({ kind: 'warning', message: `${r.skipped} ${r.skipped === 1 ? 'face' : 'faces'} of ${fileName} could not be converted, so the body may not be a closed solid.`, timeout: 9000 });
      }
      return r.step;
    } catch (e) {
      toast({ kind: 'error', title: 'Could not open the SolidWorks file', message: (e as Error).message });
      return null;
    } finally {
      done();
    }
  }

  async importStepText(text: string, fileName: string, signal = this.app.documentSignal) {
    const app = this.app;
    const documentVersion = this.documentVersion;
    if (tooLarge(text.length, 'x.step')) return;
    if (!text.trim()) { toast({ kind: 'error', title: 'Import failed', message: `${fileName} is empty.` }); return; }
    const err = await app.kernel.checkImport(text).catch((e) => (e as Error).message);
    if (documentVersion !== this.documentVersion || signal.aborted) return;
    if (err) { toast({ kind: 'error', title: 'Import failed', message: err }); return; }
    // Finish an open sketch first, as feature commands do: discarding its
    // changes later would otherwise take the imported body with them.
    if (app.sketchEditor) app.exitSketch(true);
    const blobId = newBlobId(app.store.doc);
    const id = app.store.nextId('f');
    app.store.doc.blobs[blobId] = text;
    const f: ImportFeature = { id, name: defaultName(app.store.doc, 'import'), type: 'import', format: 'step', blob: blobId, fileName };
    app.insertFeature(f);
    setTimeout(() => { if (documentVersion === this.documentVersion) app.viewport.zoomToFit(); }, 300);
    toast({ kind: 'success', message: `Imported ${fileName}` });
  }

  async exportAs(format: 'step' | 'stl' | 'part') {
    const app = this.app;
    const documentVersion = this.documentVersion;
    const name = safeName(app.store.doc.name);
    try {
      if (format === 'part') {
        download(serializeDocument(app.store.doc), `${name}${EXT}`, 'application/json');
        return;
      }
      // Editing a sketch or a feature shows the model rolled back to before
      // it, and the kernel exports what it shows. Finish the sketch as Save
      // does; an open feature may still have values it would refuse.
      if (app.panel?.editingId) {
        toast({ kind: 'warning', message: `Close ${app.panel.title} before exporting: the part is rolled back to the feature being edited.` });
        return;
      }
      if (app.sketchEditor) app.exitSketch(true);
      // The kernel exports the body it built last: a change made just before
      // must be built first, or the file has the old geometry.
      await app.whenBuilt();
      if (documentVersion !== this.documentVersion) return;
      if (!app.bbox) { toast({ kind: 'warning', message: 'There is no geometry to export yet.' }); return; }
      const data = await app.kernel.exportFile(format, Math.max(1, app.settings.quality));
      if (documentVersion !== this.documentVersion) return;
      const blob = new Blob([data as BlobPart], { type: format === 'step' ? 'model/step' : 'model/stl' });

      download(blob, `${name}.${format === 'step' ? 'step' : 'stl'}`);
    } catch (e) {
      if (documentVersion === this.documentVersion) toast({ kind: 'error', title: 'Export failed', message: (e as Error).message });
    }
  }

  async rename() {
    const app = this.app;
    const documentVersion = this.documentVersion;
    const name = await promptDialog('Rename part', 'Part name', app.store.doc.name, (v) => (v.trim() ? null : 'Enter a name'), app.documentSignal);
    if (name == null || documentVersion !== this.documentVersion) return;
    return this.fileOperation(async () => {
      if (documentVersion !== this.documentVersion) return;
      // As for Save As: discarding an open sketch's changes later would
      // otherwise restore the old name, while the file keeps the new one.
      if (app.sketchEditor) app.exitSketch(true);
      const clean = safeName(name);
      app.store.change('Rename part', (doc) => { doc.name = clean; });
      const loc = app.location;
      // A file that already has the name is left alone (Enter in an unchanged Rename box).
      if (loc?.type === 'cloud' && loc.path.split('/').pop() !== `${clean}${EXT}`) {
        try {
          const { location: renamed, version } = await renameCloudPart(loc, clean);
          if (documentVersion === this.documentVersion) {
            // The file's version as renamed, or the one known before when the rename did not say.
            const known = this.known?.path === loc.path ? this.known.version : null;
            this.setLocation(renamed, version ?? known);
          }
          forgetRecent(loc);
          rememberRecent({ location: renamed, name: clean });
        } catch (e) {
          toast({ kind: 'warning', message: `Renamed in the app, but the file could not be renamed: ${storageError(e)}` });
        }
      }
    });
  }

  // ---------- recovery ----------

  private async writeRecoveryCopy(text: string) {
    const source = this.recoverySource;
    if (!(await writeRecovery(text))) return;
    if (source) {
      await removeRecovery(source);
      if (this.recoverySource === source) this.recoverySource = null;
    }
  }

  /** Saved or explicitly discarded work no longer needs either backup. */
  private async clearRecoveryCopies() {
    const source = this.recoverySource;
    this.recoverySource = null;
    await clearRecovery();
    if (source) await removeRecovery(source);
  }

  private scheduleRecovery() {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = 0;
    if (!this.app.store.dirty) return;
    this.recoveryTimer = window.setTimeout(() => this.writeRecoveryNow(), 4000);
  }

  private writeRecoveryNow() {
    this.recoveryTimer = 0;
    if (!this.app.store.dirty) return;
    const location = this.app.location;
    // The file's version these changes were made on: a later save of it is told apart on restore.
    const version = location?.type === 'cloud' && this.known?.path === location.path ? this.known.version : null;
    const payload = JSON.stringify({ location, version, savedAt: Date.now(), doc: withUsedBlobs(this.app.store.doc) });
    void this.writeRecoveryCopy(payload);
  }

  /** Writes a pending recovery copy now: the tab is being hidden and may not come back (phones). */
  private flushRecovery() {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.writeRecoveryNow();
    }
  }

  /**
   * Offers to restore unsaved work left by tabs that are no longer open.
   * Closing the question keeps the copy for next time; only Discard deletes it.
   */
  async checkRecovery(): Promise<boolean> {
    if (this.app.store.dirty || this.app.panel?.edited) return false;
    const controller = new AbortController();
    const stopWatching = this.app.store.on((reason) => { if (reason !== 'saved') controller.abort(); });
    const canRecover = () => !controller.signal.aborted && !this.app.store.dirty && !this.app.panel?.edited;
    try {
      for (const { file, text } of await orphanRecoveries()) {
        if (!canRecover()) return false;
        let data: { location: Location | null; version?: FileVersion | null; savedAt: number; doc: PartDocument } | null = null;
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
        // Recovery copies contain unsaved work. An empty model can still hold
        // drawing notes, part properties, or an intentional deletion of geometry.
        if (!data?.doc) { await removeRecovery(file); continue; }
        const when = new Date(data.savedAt).toLocaleString();
        // Saved again since (in another tab, on another device): restoring over
        // that version would lose it, so the changes come back as a copy.
        const newer = await this.savedAfter(data.location, data.version ?? null, data.savedAt);
        if (!canRecover()) return false;
        const v = await showDialog({
          title: 'Recover unsaved work?', signal: controller.signal,
          body: h('p', {}, `Parametric found unsaved changes to "${data.doc.name}" from ${when}. ${newer ? 'The part was saved again after these changes, so they are restored as a new, unsaved copy and that saved version stays as it is. ' : ''}Do you want to restore them?`),
          buttons: [{ label: 'Discard', value: 'discard' }, { label: 'Restore', value: 'restore', primary: true }],
        });
        if (!canRecover()) return false;
        if (v === 'restore') {
          let doc: PartDocument;
          try {
            doc = parseDocument(JSON.stringify(data.doc));
          } catch (e) {
            toast({ kind: 'error', message: (e as Error).message });
            await removeRecovery(file);
            continue;
          }
          stopWatching();
          const location = newer ? null : validLocation(data.location);
          this.app.loadDocument(doc, location);
          // Saving then asks before replacing a version saved after the one these changes were made on.
          if (location?.type === 'cloud' && data.version && versionOf(data.version)) this.known = { path: location.path, version: data.version };
          this.app.store.dirty = true;
          this.app.store.emit('restored');
          this.recoverySource = file;
          await this.writeRecoveryCopy(text);
          return true;
        }
        if (v !== 'discard') return false;
        await removeRecovery(file);
      }
      return false;
    } finally {
      stopWatching();
    }
  }

  /** Whether a part's file was saved after a recovery copy of it was made (false when that cannot be told). */
  private async savedAfter(loc: Location | null, version: FileVersion | null, savedAt: number): Promise<boolean> {
    loc = validLocation(loc);
    if (!loc) return false;
    if (loc.type === 'local') return (readIndexEntry(loc.id)?.modified ?? 0) > savedAt;
    const now = await cloudVersion(loc.path);
    if (!now) return false;
    // Copies made before versions were recorded compare times (the server's clock against this one's).
    return version && versionOf(version) ? versionChanged(now, version) : now.modified > savedAt;
  }

  /**
   * Inside the Puter desktop the window's close button removes the app without
   * a beforeunload prompt; with a close handler the app closes itself, after
   * asking about unsaved changes.
   */
  handleWindowClose() {
    const p = puter();
    if (env() !== 'app' || !p?.ui?.onWindowClose || typeof p.exit !== 'function') return;
    let asking = false;
    p.ui.onWindowClose(async () => {
      if (asking) return;
      asking = true;
      try {
        if (await this.confirmDiscard('close Parametric')) p.exit!();
      } finally {
        asking = false;
      }
    });
  }

  /** Files opened from the Puter desktop (double click or Open with), in a desktop window or a browser tab it opened. */
  handleLaunchItems() {
    const ui = puter()?.ui;
    if (!ui?.onLaunchedWithItems) return;
    try {
      ui.onLaunchedWithItems((items) => this.openDriveItems(items));
    } catch {
      /* an SDK without launch items */
    }
  }
}

/** A location read back from storage, or null when it is not one. */
function validLocation(loc: unknown): Location | null {
  const l = loc as { type?: unknown; path?: unknown; id?: unknown } | null;
  if (l?.type === 'cloud' && typeof l.path === 'string' && l.path) return { type: 'cloud', path: l.path };
  if (l?.type === 'local' && typeof l.id === 'string' && l.id) return { type: 'local', id: l.id };
  return null;
}

/** File data is immutable: a new import must never reuse an existing key. */
function newBlobId(doc: PartDocument): string {
  let id: string;
  do {
    id = `b${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;
  } while (Object.hasOwn(doc.blobs, id));
  return id;
}

const STEP_LIMIT = 60_000_000;
const SOLIDWORKS_LIMIT = 200_000_000;
/**
 * A part file: room for several imported STEP models (their text is most of
 * a large part, and cheap to read). Past this, reading the file can take the
 * tab's memory (a file of many small objects needs about 20 times its size),
 * and past about 500 MB the browser cannot hold it as text at all.
 */
const PART_LIMIT = 200_000_000;

/** Checked before a file is read into memory: true after reporting that it is too large. */
function tooLarge(size: number, fileName: string): boolean {
  const step = isStepFile(fileName);
  const solidWorks = isSolidWorksFile(fileName);
  if (size <= (step ? STEP_LIMIT : solidWorks ? SOLIDWORKS_LIMIT : PART_LIMIT)) return false;
  toast({ kind: 'error', message: step ? 'This STEP file is too large to import (60 MB limit).' : solidWorks ? 'This SolidWorks file is too large to open (200 MB limit).' : 'This file is too large to open as a part (200 MB limit).' });
  return true;
}

const OPENS = [EXT, '.json', ...IMPORT_EXTS];
/** A file Parametric opens: a part, or a STEP or SolidWorks model. */
const canOpen = (name: string) => OPENS.some((ext) => name.toLowerCase().endsWith(ext));
const isDriveFolder = (it: PuterFSItem) => {
  const d = it as PuterFSItem & { isDirectory?: boolean; fsentry_is_dir?: boolean };
  return !!(d.is_dir || d.isDir || d.isDirectory || d.fsentry_is_dir);
};

/** The part in a file's text, or null after reporting why it is not one. */
function parsePart(text: string): PartDocument | null {
  try {
    return parseDocument(text);
  } catch (e) {
    toast({ kind: 'error', title: 'Could not open the part', message: (e as Error).message });
    return null;
  }
}

let untitled = 1;
function nextUntitled(): string {
  return `Part${++untitled}`;
}

const iconCloud = () => h('span', { 'aria-hidden': 'true', style: { color: 'var(--accent)' } }, icon('cloud', 18));
const iconDevice = () => h('span', { 'aria-hidden': 'true', style: { color: 'var(--text-3)' } }, icon('device', 18));

let nudged = false;
function maybeNudgeSignIn() {
  if (nudged || !puter()) return;
  nudged = true;
  toast({
    message: 'Saved in this browser only. Sign in to Puter to keep your parts in the cloud and open them anywhere.',
    actions: [{ label: 'Sign in', primary: true, run: () => void signIn().catch((e) => toast({ kind: 'error', message: (e as Error).message })) }],
    timeout: 9000,
  });
}

