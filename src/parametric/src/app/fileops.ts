// Document file operations: new, open, save, save as, import and export,
// plus crash recovery of unsaved work in browser storage.

import { defaultName } from '../model/features';
import { newDocument, parseDocument, serializeDocument } from '../model/document';
import type { ImportFeature, PartDocument } from '../model/types';
import {
  type Location, EXT, IMPORT_EXTS, clearRecovery, download, isSolidWorksFile, isStepFile, listParts, loadText, locationLabel, newLocation,
  pickCloudFile, pickCloudSave, pickDeviceFile, readRecovery, saveText, safeName, writeRecovery, type FileEntry, deletePart, renameCloud,
} from '../platform/files';
import { cloudAvailable, puter, signIn, storageError } from '../platform/puter';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { confirmDialog, promptDialog, showDialog, toast } from '../ui/overlay';
import type { App } from './app';
import { sharedWithMe } from './share';

export class FileOps {
  private saving = false;
  private recoveryTimer = 0;

  constructor(private app: App) {
    app.onDocumentChanged = () => this.scheduleRecovery();
    window.addEventListener('beforeunload', (e) => {
      if (this.app.store.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /** Asks to save or discard unsaved changes. Returns false to abort. */
  async confirmDiscard(action: string): Promise<boolean> {
    if (!this.app.store.dirty) return true;
    const v = await showDialog({
      title: 'Save changes?',
      body: h('p', {}, `"${this.app.store.doc.name}" has unsaved changes. Save them before you ${action}?`),
      buttons: [{ label: 'Cancel', value: 'cancel', left: true }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }],
    });
    if (v === 'save') return this.save();
    return v === 'discard';
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
      app.location = await saveText(loc, doc.name, text);
      app.store.dirty = false;
      app.store.emit('saved');
      await clearRecovery();
      toast({ kind: 'success', message: `Saved to ${locationLabel(app.location)}`, timeout: 2500 });
      if (app.location.type === 'local' && !cloudAvailable()) {
        maybeNudgeSignIn();
      }
      return true;
    } catch (e) {
      toast({ kind: 'error', title: 'Could not save', message: storageError(e) });
      return false;
    } finally {
      this.saving = false;
    }
  }

  async saveAs() {
    const app = this.app;
    const name = await promptDialog('Save As', 'Part name', app.store.doc.name, (v) => (v.trim() ? null : 'Enter a name'));
    if (name == null) return;
    app.store.change('Rename part', (doc) => { doc.name = safeName(name); });
    if (cloudAvailable() && puter()?.ui?.showSaveFilePicker) {
      const loc = await pickCloudSave(serializeDocument(app.store.doc), app.store.doc.name).catch(() => null);
      if (loc) {
        app.location = loc;
        app.store.dirty = false;
        app.store.emit('saved');
        toast({ kind: 'success', message: `Saved to ${locationLabel(loc)}` });
        return;
      }
    }
    app.location = null;
    await this.save();
  }

  /** Opens a part from a location (cloud or local). */
  async openLocation(loc: Location, name?: string) {
    if (!(await this.confirmDiscard('open another part'))) return;
    try {
      const text = await loadText(loc);
      this.openText(text, loc, name);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not open the part', message: storageError(e) });
    }
  }

  openText(text: string, loc: Location | null, name?: string): boolean {
    let doc: PartDocument;
    try {
      doc = parseDocument(text);
    } catch (e) {
      toast({ kind: 'error', title: 'Could not open the part', message: (e as Error).message });
      return false;
    }
    if (name && !doc.name) doc.name = name;
    this.app.loadDocument(doc, loc);
    return true;
  }

  /** Open dialog listing cloud and browser-stored parts. */
  async open() {
    const app = this.app;
    let entries: FileEntry[] = [];
    try {
      entries = await listParts();
    } catch (e) {
      toast({ kind: 'error', message: storageError(e) });
    }
    const list = h('div', { class: 'file-list', role: 'list' });
    let chosen: FileEntry | null = null;
    let close: ((v: string | null) => void) | null = null;
    const done = (e: FileEntry) => { chosen = e; close?.('open'); };
    if (!entries.length) list.append(h('p', {}, cloudAvailable() ? 'No saved parts yet.' : 'No parts saved in this browser yet. Sign in to Puter to keep parts in your cloud storage.'));
    for (const e of entries) {
      const b = h('button', { class: 'file-item', type: 'button', role: 'listitem' },
        e.location.type === 'cloud' ? iconCloud() : iconDevice(),
        h('span', { class: 'txt' }, h('span', { class: 'n' }, e.name), h('span', { class: 'meta' }, `${locationLabel(e.location)}  ${e.modified ? new Date(e.modified).toLocaleString() : ''}`)));
      b.addEventListener('click', () => done(e));
      b.addEventListener('contextmenu', async (ev) => {
        ev.preventDefault();
        if (await confirmDialog('Delete part', `Delete "${e.name}"? ${e.location.type === 'cloud' ? 'It will be moved to your Puter Trash.' : 'This cannot be undone.'}`, 'Delete', true)) {
          await deletePart(e.location).catch((err) => toast({ kind: 'error', message: storageError(err) }));
          b.remove();
        }
      });
      list.append(b);
    }
    const body = h('div', {}, list);
    let sharedChosen: { readOnly: boolean } | null = null;
    if (cloudAvailable()) {
      const shared = h('div', { class: 'file-list', role: 'list', 'aria-busy': 'true' }, h('p', { class: 'field-label' }, 'Loading...'));
      body.append(h('h3', { class: 'file-section' }, 'Shared with me'), shared);
      void sharedWithMe().then((items) => {
        shared.removeAttribute('aria-busy');
        shared.replaceChildren();
        if (!items.length) shared.append(h('p', { class: 'field-label' }, 'Nothing has been shared with you yet.'));
        for (const e of items) {
          const readOnly = e.mode === 'read';
          const b = h('button', { class: 'file-item', type: 'button', role: 'listitem' },
            h('span', { 'aria-hidden': 'true', style: { color: 'var(--text-3)' } }, icon('users', 18)),
            h('span', { class: 'txt' }, h('span', { class: 'n' }, e.name), h('span', { class: 'meta' }, [e.owner ? `From ${e.owner}` : '', readOnly ? 'View only' : 'Can edit', e.modified ? new Date(e.modified).toLocaleString() : ''].filter(Boolean).join(' · '))));
          b.addEventListener('click', () => { sharedChosen = { readOnly }; done(e); });
          shared.append(b);
        }
      });
    }
    const buttons: { label: string; value: string; primary?: boolean; left?: boolean }[] = [{ label: 'From device...', value: 'device', left: true }];
    if (cloudAvailable() && puter()?.ui?.showOpenFilePicker) buttons.push({ label: 'Browse Puter...', value: 'browse', left: true });
    buttons.push({ label: 'Cancel', value: 'cancel' });
    const v = await showDialog({ title: 'Open', body: [body, h('p', { class: 'field-label' }, 'Right-click one of your parts to delete it.')], buttons, wide: true, onReady: (c) => { close = c; } });
    if (v === 'open' && chosen) {
      const c = chosen as FileEntry;
      if ((sharedChosen as { readOnly: boolean } | null)?.readOnly) await this.openReadOnlyCopy(c);
      else await this.openLocation(c.location, c.name);
    }
    else if (v === 'device') await this.openFromDevice();
    else if (v === 'browse') {
      const r = await pickCloudFile().catch((e) => { toast({ kind: 'error', message: storageError(e) }); return null; });
      if (r) {
        if (isStepFile(r.fileName)) await this.importStepText(await r.blob.text(), r.fileName);
        else if (isSolidWorksFile(r.fileName)) await this.openSolidWorks(new Uint8Array(await r.blob.arrayBuffer()), r.fileName);
        else if (await this.confirmDiscard('open another part')) this.openText(await r.blob.text(), r.location, r.name);
      }
    }
    void app;
  }

  /** View-only shares open detached: saving makes a copy in the user's own Parts. */
  private async openReadOnlyCopy(e: FileEntry) {
    if (!(await this.confirmDiscard('open another part'))) return;
    try {
      if (!this.openText(await loadText(e.location), null, e.name)) return;
      toast({ message: `"${e.name}" is shared with you as view only. Saving keeps your own copy.`, timeout: 6000 });
    } catch (err) {
      toast({ kind: 'error', title: 'Could not open the part', message: storageError(err) });
    }
  }

  async openFromDevice() {
    const file = await pickDeviceFile(`${EXT},.json,${IMPORT_EXTS.join(',')}`);
    if (!file) return;
    if (isStepFile(file.name)) { await this.importStepText(await file.text(), file.name); return; }
    if (isSolidWorksFile(file.name)) { await this.openSolidWorks(new Uint8Array(await file.arrayBuffer()), file.name); return; }
    const text = await file.text();
    if (!(await this.confirmDiscard('open another part'))) return;
    this.openText(text, null, file.name.replace(/\.[^.]+$/, ''));
    this.app.store.dirty = true;
  }

  /** Imports a STEP or SolidWorks file as a solid feature in the current part. */
  async importStep() {
    const file = await pickDeviceFile(IMPORT_EXTS.join(','));
    if (!file) return;
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
    if (!(await this.confirmDiscard('open another part'))) return;
    const step = await this.convertSolidWorks(data, fileName);
    if (!step) return;
    const err = await app.kernel.checkImport(step).catch((e) => (e as Error).message);
    if (err) { toast({ kind: 'error', title: 'Could not open the SolidWorks part', message: err }); return; }
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
    if (data.length > 200_000_000) { toast({ kind: 'error', message: 'This SolidWorks file is too large to open (200 MB limit).' }); return null; }
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
    if (text.length > 60_000_000) { toast({ kind: 'error', message: 'This STEP file is too large to import (60 MB limit).' }); return; }
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
      } catch (e) {
        toast({ kind: 'warning', message: `Renamed in the app, but the file could not be renamed: ${storageError(e)}` });
      }
    }
  }

  // ---------- recovery ----------

  private scheduleRecovery() {
    clearTimeout(this.recoveryTimer);
    if (!this.app.store.dirty) return;
    this.recoveryTimer = window.setTimeout(() => {
      const payload = JSON.stringify({ location: this.app.location, savedAt: Date.now(), doc: this.app.store.doc });
      void writeRecovery(payload);
    }, 4000);
  }

  /** Offers to restore unsaved work from a previous session. */
  async checkRecovery(): Promise<boolean> {
    const text = await readRecovery();
    if (!text) return false;
    let data: { location: Location | null; savedAt: number; doc: PartDocument } | null = null;
    try {
      data = JSON.parse(text);
    } catch {
      await clearRecovery();
      return false;
    }
    if (!data?.doc?.features?.length) { await clearRecovery(); return false; }
    const when = new Date(data.savedAt).toLocaleString();
    const v = await showDialog({
      title: 'Recover unsaved work?',
      body: h('p', {}, `Parametric found unsaved changes to "${data.doc.name}" from ${when}. Do you want to restore them?`),
      buttons: [{ label: 'Discard', value: 'discard' }, { label: 'Restore', value: 'restore', primary: true }],
    });
    if (v === 'restore') {
      try {
        const doc = parseDocument(JSON.stringify(data.doc));
        this.app.loadDocument(doc, data.location);
        this.app.store.dirty = true;
        this.app.store.emit('restored');
        return true;
      } catch (e) {
        toast({ kind: 'error', message: (e as Error).message });
      }
    }
    await clearRecovery();
    return false;
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
        if (isSolidWorksFile(it.name)) await this.openSolidWorks(new Uint8Array(await blob.arrayBuffer()), it.name);
        else if (isStepFile(it.name)) await this.importStepText(await blob.text(), it.name);
        else this.openText(await blob.text(), { type: 'cloud', path: it.path }, it.name.replace(/\.[^.]+$/, ''));
      } catch (e) {
        toast({ kind: 'error', title: 'Could not open the file', message: storageError(e) });
      }
    });
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

