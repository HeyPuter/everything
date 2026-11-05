// Document file operations: new, open, save, save as, import and export,
// plus crash recovery of unsaved work in browser storage.

import { defaultName } from '../model/features';
import { newDocument, parseDocument, serializeDocument, withUsedBlobs } from '../model/document';
import type { ImportFeature, PartDocument } from '../model/types';
import {
  type Location, EXT, IMPORT_EXTS, clearRecovery, download, isSolidWorksFile, isStepFile, listParts, loadText, locationLabel, newLocation,
  pickCloudFile, pickCloudSave, pickDeviceFile, orphanRecoveries, removeRecovery, saveText, safeName, writeRecovery, type FileEntry, deletePart, renameCloud, forgetRecent, rememberRecent,
} from '../platform/files';
import { cloudAvailable, env, isMissing, puter, signIn, storageError } from '../platform/puter';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { confirmDialog, promptDialog, showDialog, toast } from '../ui/overlay';
import type { App } from './app';
import { sharedWithMe } from './share';

export class FileOps {
  private saving = false;
  private recoveryTimer = 0;
  /** Counts document changes, so a save only clears the edits it wrote. */
  private revision = 0;

  constructor(private app: App) {
    app.onDocumentChanged = (reason) => {
      if (reason !== 'saved') this.revision++;
      this.scheduleRecovery();
    };
    // A hidden tab can be closed without notice (phones discard background tabs).
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flushRecovery(); });
    window.addEventListener('pagehide', () => this.flushRecovery());
    window.addEventListener('beforeunload', (e) => {
      if (this.app.store.dirty || this.app.panel?.edited) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /** Asks to save or discard unsaved changes. Returns false to abort. */
  async confirmDiscard(action: string): Promise<boolean> {
    // A feature panel with changes not yet applied counts as unsaved work too.
    const panel = this.app.panel?.edited ? this.app.panel : null;
    if (!this.app.store.dirty && !panel) return true;
    const v = await showDialog({
      title: 'Save changes?',
      body: h('p', {}, `"${this.app.store.doc.name}" has unsaved changes${panel ? ` (including ${panel.title}, which is still open)` : ''}. Save them before you ${action}?`),
      buttons: [{ label: 'Cancel', value: 'cancel', left: true }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }],
    });
    if (v === 'save') {
      // Apply the open panel first; a value it refuses keeps everything open.
      if (panel) {
        await this.app.closePanel(true);
        if (this.app.panel) return false;
      }
      return this.save();
    }
    if (v !== 'discard') return false;
    // Discarded on purpose: do not offer it for recovery next time.
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = 0;
    await clearRecovery();
    return true;
  }

  async newPart() {
    if (!(await this.confirmDiscard('start a new part'))) return;
    this.app.newDocument(nextUntitled());
    await clearRecovery();
  }

  /** Save to the current location, or ask where for a new document. */
  async save(): Promise<boolean> {
    if (this.saving) return false;
    const app = this.app;
    if (app.sketchEditor) app.exitSketch(true);
    const doc = app.store.doc;
    this.saving = true;
    try {
      let loc = app.location;
      if (!loc) loc = await newLocation(doc.name, `part-${Date.now().toString(36)}`);
      const text = serializeDocument(doc);
      const revision = this.revision;
      app.location = await saveText(loc, doc.name, text);
      this.markSaved(revision);
      toast({ kind: 'success', message: `Saved to ${locationLabel(app.location)}`, timeout: 2500 });
      if (app.location.type === 'local' && !cloudAvailable()) {
        maybeNudgeSignIn();
      }
      return true;
    } catch (e) {
      // The work is still only in this tab: offer a copy on the device meanwhile.
      toast({ kind: 'error', title: 'Could not save', message: storageError(e), actions: [{ label: 'Download a copy', run: () => void this.exportAs('part') }], timeout: 15000 });
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** After a write: clean, unless the part changed while it was being written. */
  private markSaved(revision: number) {
    const clean = revision === this.revision;
    if (clean) this.app.store.dirty = false;
    this.app.store.emit('saved');
    if (clean) void clearRecovery();
  }

  async saveAs() {
    const app = this.app;
    const name = await promptDialog('Save As', 'Part name', app.store.doc.name, (v) => (v.trim() ? null : 'Enter a name'));
    if (name == null) return;
    const clean = safeName(name);
    const rename = () => app.store.change('Rename part', (doc) => { doc.name = clean; });
    if (cloudAvailable() && puter()?.ui?.showSaveFilePicker) {
      const revision = this.revision;
      // null when the user cancels the picker; undefined when it failed (save to Parts instead).
      const loc = await pickCloudSave(serializeDocument({ ...app.store.doc, name: clean }), clean).catch(() => undefined);
      if (loc === null) return;
      if (loc) {
        const unchanged = revision === this.revision;
        rename();
        app.location = loc;
        rememberRecent({ location: loc, name: clean });
        this.markSaved(unchanged ? this.revision : revision);
        toast({ kind: 'success', message: `Saved to ${locationLabel(loc)}` });
        return;
      }
    }
    rename();
    app.location = null;
    await this.save();
  }

  /** Opens a part from a location (cloud or local). */
  async openLocation(loc: Location, name?: string) {
    let text: string;
    try {
      text = await loadText(loc);
    } catch (e) {
      // Gone (deleted or moved elsewhere): drop it from the recent parts too.
      const missing = isMissing(e);
      if (missing) forgetRecent(loc);
      toast({ kind: 'error', title: 'Could not open the part', message: missing ? `"${name || 'The part'}" no longer exists. It may have been moved or deleted.` : storageError(e) });
      return;
    }
    await this.openPartText(text, loc, name);
  }

  openText(text: string, loc: Location | null, name?: string): boolean {
    const doc = parsePart(text);
    if (doc) this.openDoc(doc, loc, name);
    return !!doc;
  }

  private openDoc(doc: PartDocument, loc: Location | null, name?: string) {
    if (name && !doc.name) doc.name = name;
    this.app.loadDocument(doc, loc);
    if (loc) rememberRecent({ location: loc, name: doc.name });
  }

  /** Reads a part file and, only if it is one, asks about unsaved changes and opens it. */
  private async openPartText(text: string, loc: Location | null, name?: string): Promise<boolean> {
    const doc = parsePart(text);
    if (!doc || !(await this.confirmDiscard('open another part'))) return false;
    this.openDoc(doc, loc, name);
    return true;
  }

  /** Open dialog listing cloud and browser-stored parts. */
  async open() {
    const app = this.app;
    // Parts in this browser stay listed when the cloud cannot be reached.
    let cloudError = '';
    const entries = await listParts((e) => { cloudError = storageError(e); });
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
    const v = await showDialog({ title: 'Open', body, buttons, wide: true, onReady: (c) => { close = c; } });
    if (v === 'open' && chosen) {
      const c = chosen as FileEntry;
      if ((sharedChosen as { readOnly: boolean } | null)?.readOnly) await this.openReadOnlyCopy(c);
      else await this.openLocation(c.location, c.name);
    }
    else if (v === 'device') await this.openFromDevice();
    else if (v === 'browse') {
      const r = await pickCloudFile().catch((e) => { toast({ kind: 'error', message: storageError(e) }); return null; });
      if (r && !tooLarge(r.blob.size, r.fileName)) {
        if (isStepFile(r.fileName)) await this.importStepText(await r.blob.text(), r.fileName);
        else if (isSolidWorksFile(r.fileName)) await this.openSolidWorks(new Uint8Array(await r.blob.arrayBuffer()), r.fileName);
        else await this.openPartText(await r.blob.text(), r.location, r.name);
      }
    }
    void app;
  }

  /** View-only shares open detached: saving makes a copy in the user's own Parts. */
  private async openReadOnlyCopy(e: FileEntry) {
    let text: string;
    try {
      text = await loadText(e.location);
    } catch (err) {
      toast({ kind: 'error', title: 'Could not open the part', message: storageError(err) });
      return;
    }
    // Read and checked first: a file that cannot be opened leaves the current part alone.
    if (!(await this.openPartText(text, null, e.name))) return;
    toast({ message: `"${e.name}" is shared with you as view only. Saving keeps your own copy.`, timeout: 6000 });
  }

  async openFromDevice() {
    const file = await pickDeviceFile(`${EXT},.json,${IMPORT_EXTS.join(',')}`);
    if (!file || tooLarge(file.size, file.name)) return;
    if (isStepFile(file.name)) { await this.importStepText(await file.text(), file.name); return; }
    if (isSolidWorksFile(file.name)) { await this.openSolidWorks(new Uint8Array(await file.arrayBuffer()), file.name); return; }
    if (await this.openPartText(await file.text(), null, file.name.replace(/\.[^.]+$/, ''))) this.app.store.dirty = true;
  }

  /** Imports a STEP or SolidWorks file as a solid feature in the current part. */
  async importStep() {
    const file = await pickDeviceFile(IMPORT_EXTS.join(','));
    if (!file || tooLarge(file.size, file.name)) return;
    if (isSolidWorksFile(file.name)) {
      const step = await this.convertSolidWorks(new Uint8Array(await file.arrayBuffer()), file.name);
      if (step) await this.importStepText(step, file.name);
      return;
    }
    await this.importStepText(await file.text(), file.name);
  }

  /** Opens a SolidWorks part as a new part whose first feature is its solid. */
  async openSolidWorks(data: Uint8Array, fileName: string) {
    const app = this.app;
    // Converted and checked first: a file that cannot be opened leaves the current part alone.
    const step = await this.convertSolidWorks(data, fileName);
    if (!step) return;
    const err = await app.kernel.checkImport(step).catch((e) => (e as Error).message);
    if (err) { toast({ kind: 'error', title: 'Could not open the SolidWorks part', message: err }); return; }
    if (!(await this.confirmDiscard('open another part'))) return;
    const doc = newDocument(safeName(fileName.replace(/\.[^.]+$/, '')) || 'Part1', app.settings.defaultUnits);
    const blobId = `b${Date.now().toString(36)}`;
    doc.blobs[blobId] = step;
    doc.features.push({ id: `f${doc.nextId++}`, name: defaultName(doc, 'import'), type: 'import', format: 'step', blob: blobId, fileName });
    app.loadDocument(doc, null);
    app.store.dirty = true;
    toast({ kind: 'success', message: `Opened ${fileName}. SolidWorks feature history is not included: the part is one solid body to build on.`, timeout: 7000 });
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

  async importStepText(text: string, fileName: string) {
    const app = this.app;
    if (tooLarge(text.length, 'x.step')) return;
    if (!text.trim()) { toast({ kind: 'error', title: 'Import failed', message: `${fileName} is empty.` }); return; }
    const err = await app.kernel.checkImport(text).catch((e) => (e as Error).message);
    if (err) { toast({ kind: 'error', title: 'Import failed', message: err }); return; }
    const blobId = `b${Date.now().toString(36)}`;
    const id = app.store.nextId('f');
    app.store.doc.blobs[blobId] = text;
    const f: ImportFeature = { id, name: defaultName(app.store.doc, 'import'), type: 'import', format: 'step', blob: blobId, fileName };
    app.insertFeature(f);
    setTimeout(() => app.viewport.zoomToFit(), 300);
    toast({ kind: 'success', message: `Imported ${fileName}` });
  }

  async exportAs(format: 'step' | 'stl' | 'part') {
    const app = this.app;
    const name = safeName(app.store.doc.name);
    try {
      if (format === 'part') {
        download(serializeDocument(app.store.doc), `${name}${EXT}`, 'application/json');
        return;
      }
      // The kernel exports the body it built last: a change made just before
      // must be built first, or the file has the old geometry.
      await app.whenBuilt();
      if (!app.bbox) { toast({ kind: 'warning', message: 'There is no geometry to export yet.' }); return; }
      const data = await app.kernel.exportFile(format, Math.max(1, app.settings.quality));
      const blob = new Blob([data as BlobPart], { type: format === 'step' ? 'model/step' : 'model/stl' });

      download(blob, `${name}.${format === 'step' ? 'step' : 'stl'}`);
    } catch (e) {
      toast({ kind: 'error', title: 'Export failed', message: (e as Error).message });
    }
  }

  async rename() {
    const app = this.app;
    const name = await promptDialog('Rename part', 'Part name', app.store.doc.name, (v) => (v.trim() ? null : 'Enter a name'));
    if (name == null) return;
    const clean = safeName(name);
    app.store.change('Rename part', (doc) => { doc.name = clean; });
    const loc = app.location;
    if (loc?.type === 'cloud') {
      try {
        app.location = await renameCloud(loc, clean);
        forgetRecent(loc);
        rememberRecent({ location: app.location, name: clean });
      } catch (e) {
        toast({ kind: 'warning', message: `Renamed in the app, but the file could not be renamed: ${storageError(e)}` });
      }
    }
  }

  // ---------- recovery ----------

  private scheduleRecovery() {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = 0;
    if (!this.app.store.dirty) return;
    this.recoveryTimer = window.setTimeout(() => this.writeRecoveryNow(), 4000);
  }

  private writeRecoveryNow() {
    this.recoveryTimer = 0;
    if (!this.app.store.dirty) return;
    const payload = JSON.stringify({ location: this.app.location, savedAt: Date.now(), doc: withUsedBlobs(this.app.store.doc) });
    void writeRecovery(payload);
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
    for (const { file, text } of await orphanRecoveries()) {
      let data: { location: Location | null; savedAt: number; doc: PartDocument } | null = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      // A blank part is not worth asking about.
      if (!data?.doc?.features?.length && !data?.doc?.variables?.length) { await removeRecovery(file); continue; }
      const when = new Date(data.savedAt).toLocaleString();
      const v = await showDialog({
        title: 'Recover unsaved work?',
        body: h('p', {}, `Parametric found unsaved changes to "${data.doc.name}" from ${when}. Do you want to restore them?`),
        buttons: [{ label: 'Discard', value: 'discard' }, { label: 'Restore', value: 'restore', primary: true }],
      });
      if (v === 'restore') {
        let doc: PartDocument;
        try {
          doc = parseDocument(JSON.stringify(data.doc));
        } catch (e) {
          toast({ kind: 'error', message: (e as Error).message });
          await removeRecovery(file);
          continue;
        }
        this.app.loadDocument(doc, data.location);
        this.app.store.dirty = true;
        this.app.store.emit('restored');
        // This tab now owns the work: its own copy replaces the one left behind.
        await writeRecovery(text);
        await removeRecovery(file);
        return true;
      }
      if (v !== 'discard') return false;
      await removeRecovery(file);
    }
    return false;
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

  /** Files opened from the Puter desktop (double-click / Open With). */
  handleLaunchItems() {
    const ui = puter()?.ui;
    if (!ui?.onLaunchedWithItems) return;
    ui.onLaunchedWithItems(async (items) => {
      const it = items?.[0];
      if (!it) return;
      try {
        const blob = it.read ? await it.read() : await puter()!.fs.read(it.path);
        if (tooLarge(blob.size, it.name)) return;
        if (isSolidWorksFile(it.name)) await this.openSolidWorks(new Uint8Array(await blob.arrayBuffer()), it.name);
        else if (isStepFile(it.name)) await this.importStepText(await blob.text(), it.name);
        else this.openText(await blob.text(), { type: 'cloud', path: it.path }, it.name.replace(/\.[^.]+$/, ''));
      } catch (e) {
        toast({ kind: 'error', title: 'Could not open the file', message: storageError(e) });
      }
    });
  }
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

