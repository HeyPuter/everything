/**
 * Application controller: open drawings, the active view, panels, files,
 * settings, theme, account and keyboard shortcuts.
 */
import { h, clear, MOD } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { showMenu, closeMenus } from './ui/menu.js';
import { toast, unsavedDialog, confirmDialog, promptDialog } from './ui/dialog.js';
import { installTooltips } from './ui/tooltip.js';
import { buildShell, renderDocTabs, PHONE_GROUPS, REPO_URL } from './ui/shell.js';
import { Ribbon } from './ui/ribbon.js';
import { CommandLine } from './ui/commandline.js';
import { StatusBar } from './ui/statusbar.js';
import { PropertiesPalette } from './ui/properties.js';
import { LayerManager } from './ui/layers.js';
import { BlockLibrary } from './ui/blocks.js';
import { TextEditor } from './ui/textedit.js';
import { hatchTab } from './ui/hatchtab.js';
import * as dialogs from './ui/dialogs.js';
import { Drawing } from './core/drawing.js';
import { sampleDrawing } from './core/sample.js';
import { SpatialIndex } from './core/spatial.js';
import { STANDARD_LINETYPES } from './core/linetypes.js';
import { Camera } from './render/camera.js';
import { Renderer } from './render/renderer.js';
import { Overlay } from './editor/overlay.js';
import { Editor, DEFAULT_SETTINGS, CancelError } from './editor/editor.js';
import { buildRegistry } from './editor/commands/index.js';
import { encodeDrawing, decodeDrawing, fileKind, kindExt, baseName } from './io/native.js';
import { importDxf, exportDxf, exportDwg } from './io/dxf-client.js';
import * as storage from './io/storage.js';
import * as platform from './platform.js';

const SETTINGS_KEY = 'cad.settings';
const THEME_KEY = 'cad.theme';
const DOCK_KEY = 'cad.dock';
const AUTOSAVE_MS = 1500;
/** Settings kept in the user's account (one small key-value record). */
const SETTING_DEFAULTS = { ...DEFAULT_SETTINGS, showUcs: true, showCmdLine: true, trackpadPan: true };
const SYNCED_SETTINGS = Object.keys(SETTING_DEFAULTS);

let docSeq = 0;

class Doc {
  constructor(drawing, name) {
    this.id = `d${Date.now().toString(36)}${(++docSeq).toString(36)}`;
    this.drawing = drawing;
    this.index = new SpatialIndex(drawing);
    this.name = name;
    this.view = null;
    this.viewStack = [];
    this.selection = new Set();
    this.file = null;
    this.isolated = null;
  }
}

export class App {
  constructor(root) {
    this.root = root;
    this.docs = [];
    this.doc = null;
    this.commands = buildRegistry();
    this.settings = { ...SETTING_DEFAULTS, ...loadJSON(SETTINGS_KEY, {}) };
    this.themePref = loadTheme();
    this.clipboard = null;
    this.user = null;
    this.signedIn = false;
    this._autosaveTimers = new Map();
    this._autosaving = new Set();
  }

  // Boot ------------------------------------------------------------------------

  async start() {
    const shell = buildShell(this);
    this.shell = shell;
    this.root.append(shell.root);
    installTooltips(document);

    this.ribbon = new Ribbon(this);
    shell.root.querySelector('.ribbon-slot').replaceWith(this.ribbon.el);
    this.cmdline = new CommandLine(this);
    shell.canvasWrap.append(this.cmdline.el);
    this.status = new StatusBar(this);
    shell.root.querySelector('.status-slot').replaceWith(this.status.el);
    this.properties = new PropertiesPalette(this);
    this.layers = new LayerManager(this);
    this.blocks = new BlockLibrary(this);
    this.textEditor = new TextEditor(this);

    this.camera = new Camera();
    try {
      this.renderer = new Renderer(shell.glCanvas, this.camera);
    } catch (err) {
      this.fatal('This app needs WebGL2, which this browser or device does not provide. Try a current version of Chrome, Edge, Firefox or Safari.', err);
      return;
    }
    this.overlay = new Overlay(shell.overlay);
    this.editor = new Editor({
      el: shell.overlay,
      renderer: this.renderer,
      camera: this.camera,
      overlay: this.overlay,
      commands: this.commands,
      settings: this.settings,
      app: this,
      ui: this.editorUI(),
    });
    this.editor.editText = (opts) => this.editText(opts);
    this.settings = this.editor.settings;

    this.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    this.observeSize();
    this.bindKeys();
    this.bindDock();
    this.renderPhonebar();
    this.applySettings();

    // Only one tab restores and records the session; others start fresh.
    this.ownsSession = await storage.acquireSessionLock();
    if (this.ownsSession) await this.restoreSession();
    const params = new URLSearchParams(location.search);
    if (params.has('sample')) {
      this.openSample();
      // Open it once, not again on every reload.
      params.delete('sample');
      history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
    }
    if (!this.docs.length) this.newDrawing();
    // Reopen the palettes from last time (desktop only).
    if (this.dockActive && this.dockOpen.has(this.dockActive) && innerWidth >= 1024) this.showDock(this.dockActive);

    this.initAccount();
    this.handleLaunchItems();
    window.addEventListener('beforeunload', (e) => {
      // A recovery copy still being written may not finish before unload.
      const pending = this._autosaveTimers.size > 0 || this._autosaving.size > 0;
      this.flushAutosave();
      // Without working recovery copies, unsaved work would be lost.
      if (this.docs.some((d) => d.drawing.modified) && (pending || !this.ownsSession || this.recoveryFailed)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    // Mobile browsers often skip beforeunload; save recovery copies when hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushAutosave();
    });
    window.addEventListener('pagehide', () => this.flushAutosave());
    this.cmdline.log('Ready. Type a command, or pick a tool from the ribbon. Press F1 for help.', 'muted');
    if (!this.ownsSession) toast('The app is also open in another tab. Drawings in this tab are not kept for recovery, so save your work.', { timeout: 9000 });
  }

  fatal(message, err) {
    console.error(err);
    clear(this.shell.canvasWrap).append(h('div.fatal', { role: 'alert' }, icon('warning', 28), h('p', message)));
  }

  editorUI() {
    return {
      prompt: (text, options, def) => this.cmdline.prompt(text, options, def),
      log: (text, kind) => this.cmdline.log(text, kind),
      coords: (x, y, base) => this.status.setCoords(x, y, base),
      input: () => this.cmdline.value(),
      setInput: (v) => this.cmdline.setValue(v),
      contextMenu: (x, y, items) => this.contextMenu(x, y, items),
      toast: (msg) => toast(msg),
      selectionChanged: () => this.selectionChanged(),
      viewChanged: () => this.viewChanged(),
      commandChanged: (def) => this.commandChanged(def),
      editEntity: (id) => this.editEntity(id),
      chooseBlock: () => this.blocks.choose(),
      showHatchPanel: (st, onChange) => this.showHatchTab(st, onChange),
    };
  }

  // Documents -------------------------------------------------------------------

  nextName() {
    let i = 1;
    const names = new Set(this.docs.map((d) => d.name));
    while (names.has(`Drawing${i}`)) i++;
    return `Drawing${i}`;
  }

  addDoc(drawing, name, file = null, id = null) {
    for (const lt of STANDARD_LINETYPES) if (!drawing.linetypes.has(lt.name)) drawing.linetypes.set(lt.name, { ...lt });
    const doc = new Doc(drawing, name);
    if (id) doc.id = id;
    doc.file = file;
    drawing.on((change) => this.onChange(doc, change));
    this.docs.push(doc);
    this.activate(doc, true);
    this.saveSession();
    return doc;
  }

  newDrawing() {
    const doc = this.addDoc(new Drawing(), this.nextName());
    this.whenSized(() => {
      if (this.doc !== doc) return;
      // An empty A4-landscape-sized area in millimetres.
      this.camera.fit(-10, -10, 290, 200);
      this.editor.viewChanged();
      doc.view = this.camera.state;
    });
    return doc;
  }

  activate(doc, fresh = false) {
    if (this.doc === doc && !fresh) return;
    if (this.doc) this.doc.view = this.camera.state;
    if (this.editor.busy) this.editor.cancelAll();
    this.doc = doc;
    this.renderer.setDrawing(doc.drawing);
    if (doc.view) this.camera.state = doc.view;
    else this.zoomExtentsSoon();
    this.editor.attach(doc);
    this.shell.emptyState.hidden = true;
    this.refreshAll();
    this.saveSession();
  }

  zoomExtentsSoon() {
    this.whenSized(() => {
      this.editor.zoomExtents();
      if (this.doc) this.doc.view = this.camera.state;
    });
  }

  /** Run fn once the canvas has its real size (immediately if it already has). */
  whenSized(fn) {
    if (this.camera.width > 1 && this._sized) requestAnimationFrame(fn);
    else (this._afterSize ||= []).push(fn);
  }

  onChange(doc, change) {
    doc.index.applyChange(change);
    if (doc === this.doc) {
      this.renderer.applyChange(change);
      // Drop deleted objects from the selection.
      let dropped = false;
      for (const id of change.ids) {
        if (doc.selection.has(id) && !doc.drawing.entities.has(id)) {
          doc.selection.delete(id);
          dropped = true;
        }
      }
      if (dropped) this.renderer.setSelection(doc.selection);
      this.editor.refreshGrips();
      this.editor.drawOverlay();
      this.scheduleRefresh(change);
    }
    this.scheduleAutosave(doc);
  }

  scheduleRefresh(change) {
    this._pendingTables = this._pendingTables || !!(change?.tables || change?.header || change?.blocks?.size);
    if (this._refreshRaf) return;
    this._refreshRaf = requestAnimationFrame(() => {
      this._refreshRaf = 0;
      const tables = this._pendingTables;
      this._pendingTables = false;
      this.properties.refresh();
      this.ribbon.refresh();
      this.updateTitle();
      renderDocTabs(this, this.shell.doctabs);
      this.updateUndo();
      if (tables || this.layers.el.isConnected) this.layers.refresh();
      if (tables) this.blocks.refresh();
      this.status.refresh();
    });
  }

  refreshAll() {
    this._pendingTables = true;
    this.scheduleRefresh();
  }

  updateTitle() {
    const d = this.doc;
    if (!d) {
      this.shell.title.textContent = 'CAD';
      document.title = 'CAD';
      return;
    }
    clear(this.shell.title).append(h('span.title-name', d.name));
    if (d.drawing.modified) this.shell.title.append(h('span.title-mod', 'Edited'));
    document.title = `${d.drawing.modified ? '* ' : ''}${d.name} - CAD`;
    try {
      if (platform.puterEnv() === 'app') puter.ui.setWindowTitle?.(`${d.name} - CAD`);
    } catch {
      /* ignore */
    }
  }

  updateUndo() {
    const d = this.doc?.drawing;
    const u = this.shell.undoBtn,
      r = this.shell.redoBtn;
    u.disabled = !d?.canUndo;
    r.disabled = !d?.canRedo;
    u.dataset.tip = d?.undoLabel ? `Undo ${d.undoLabel}` : 'Undo';
    r.dataset.tip = d?.redoLabel ? `Redo ${d.redoLabel}` : 'Redo';
  }

  selectionChanged() {
    this.properties.refresh();
    this.ribbon.refresh();
  }

  viewChanged() {
    if (this.doc) this.doc.view = this.camera.state;
    clearTimeout(this._viewSave);
    this._viewSave = setTimeout(() => this.properties.refresh(), 200);
  }

  commandChanged(def) {
    this.shell.canvasWrap.classList.toggle('in-command', !!def);
    this.shell.phonebar.classList.toggle('in-command', !!def);
  }

  async closeDrawing(arg) {
    const doc = arg instanceof Doc ? arg : this.doc;
    if (!doc || doc._closing) return;
    doc._closing = true;
    try {
      if (doc.drawing.modified) {
        const r = await unsavedDialog(doc.name);
        if (r === null) return;
        if (r === 'save' && !(await this.save(doc))) return;
      }
    } finally {
      doc._closing = false;
    }
    const i = this.docs.indexOf(doc);
    // Already closed while the prompt or save was pending.
    if (i < 0) return;
    this.docs.splice(i, 1);
    clearTimeout(this._autosaveTimers.get(doc.id));
    this._autosaveTimers.delete(doc.id);
    storage.recovery.delete(doc.id);
    if (this.doc === doc) {
      this.doc = null;
      const next = this.docs[Math.min(i, this.docs.length - 1)];
      if (next) this.activate(next);
      else this.showStart();
    }
    renderDocTabs(this, this.shell.doctabs);
    this.saveSession();
  }

  async closeOthers(keep) {
    for (const d of [...this.docs]) if (d !== keep) await this.closeDrawing(d);
  }

  showStart() {
    this.editor.detach();
    this.renderer.setDrawing(new Drawing());
    // Palettes have nothing to show without a drawing.
    for (const id of [...this.dockOpen]) this.closeDock(id);
    const es = this.shell.emptyState;
    es.hidden = false;
    clear(es).append(
      h(
        'div.start',
        h('h2', 'No drawing open'),
        h(
          'div.start-actions',
          h('button.btn.primary', { type: 'button', onClick: () => this.newDrawing() }, icon('file-plus', 16), 'New drawing'),
          h('button.btn', { type: 'button', onClick: () => this.open() }, icon('folder-open', 16), 'Open'),
          h('button.btn', { type: 'button', onClick: () => this.openSample() }, icon('file-text', 16), 'Sample drawing'),
        ),
      ),
    );
    this.updateTitle();
  }

  /** Open the built-in sample drawing in a new tab. */
  openSample() {
    const doc = this.addDoc(sampleDrawing(), 'Sample plate');
    this.zoomExtentsSoon();
    return doc;
  }

  // Autosave and session ----------------------------------------------------------

  scheduleAutosave(doc) {
    clearTimeout(this._autosaveTimers.get(doc.id));
    this._autosaveTimers.set(
      doc.id,
      setTimeout(() => {
        this._autosaveTimers.delete(doc.id);
        this.autosave(doc);
      }, AUTOSAVE_MS),
    );
  }

  autosave(doc) {
    const p = this._autosave(doc);
    this._autosaving.add(p);
    p.finally(() => this._autosaving.delete(p));
    return p;
  }

  async _autosave(doc) {
    if (!this.ownsSession || !this.docs.includes(doc)) return;
    // Read the flag with the data: edits made while encoding belong to the next copy.
    const modified = doc.drawing.modified;
    try {
      const blob = await encodeDrawing(doc.drawing);
      const ok = await storage.recovery.put({
        id: doc.id,
        name: doc.name,
        file: doc.file ? { source: doc.file.source, path: doc.file.path, kind: doc.file.kind, handle: doc.file.handle } : null,
        data: blob,
        view: doc.view,
        modified,
        savedAt: Date.now(),
      });
      if (!ok) throw new Error('Recovery storage is not available');
      this.recoveryFailed = false;
    } catch (err) {
      console.warn('Autosave failed', err);
      if (!this.recoveryFailed) toast('Drawings cannot be kept in this browser for recovery (storage is unavailable or full). Save your work to a file.', { kind: 'error', timeout: 9000 });
      this.recoveryFailed = true;
    }
  }

  /** Write pending recovery copies now; resolves when every copy in progress is written. */
  flushAutosave() {
    for (const [id, t] of this._autosaveTimers) {
      clearTimeout(t);
      const doc = this.docs.find((d) => d.id === id);
      if (doc) this.autosave(doc);
    }
    this._autosaveTimers.clear();
    return Promise.all([...this._autosaving]);
  }

  saveSession() {
    if (!this.ownsSession) return;
    clearTimeout(this._sessionTimer);
    this._sessionTimer = setTimeout(() => {
      storage.recovery.setSession({ docs: this.docs.map((d) => d.id), active: this.doc?.id ?? null });
      // Make sure every open drawing has a recovery copy.
      for (const d of this.docs) if (!d._recorded) {
        d._recorded = true;
        this.autosave(d);
      }
    }, 300);
  }

  async restoreSession() {
    const session = await storage.recovery.getSession();
    if (!session || !session.docs?.length) return;
    const all = await storage.recovery.all();
    const byId = new Map(all.map((r) => [r.id, r]));
    let active = null;
    for (const id of session.docs) {
      const r = byId.get(id);
      if (!r) continue;
      try {
        const data = await decodeDrawing(await r.data.arrayBuffer());
        const drawing = new Drawing(data);
        if (r.modified) drawing.savedRevision = -1;
        const doc = this.addDoc(drawing, r.name, r.file, r.id);
        doc.view = r.view;
        if (r.view) this.camera.state = r.view;
        if (id === session.active) active = doc;
      } catch (err) {
        console.warn('Could not restore a drawing', err);
      }
    }
    // Clean up recovery records that no longer belong to a tab.
    for (const r of all) if (!session.docs.includes(r.id)) storage.recovery.delete(r.id);
    if (active) this.activate(active);
    else if (this.docs.length) this.activate(this.docs.at(-1));
  }

  // Files -----------------------------------------------------------------------------

  async open() {
    if (storage.usePuterPickers()) {
      try {
        const f = await storage.puterOpenPicker();
        if (f) await this.openBuffer(f.buffer, f.name, { source: 'cloud', path: f.path });
      } catch (err) {
        this.fileError('open', err);
      }
      return;
    }
    const choice = await dialogs.openFileDialog(this);
    if (!choice) return;
    try {
      if (choice.source === 'device') {
        const f = await storage.deviceOpen();
        if (f) await this.openBuffer(f.buffer, f.name, { source: 'device', handle: f.handle, path: null });
      } else if (choice.source === 'cloud') {
        const buf = await storage.cloudRead(choice.path);
        await this.openBuffer(buf, choice.name, { source: 'cloud', path: choice.path });
      }
    } catch (err) {
      this.fileError('open', err);
    }
  }

  async openBuffer(buffer, name, file) {
    const kind = fileKind(name);
    if (!kind) {
      toast('Choose a .cad, .dwg or .dxf file.', { kind: 'error' });
      return null;
    }
    const existing = file.path && this.docs.find((d) => d.file?.path === file.path);
    if (existing) {
      this.activate(existing);
      return existing;
    }
    const busy = toast(`Opening ${name}...`, { timeout: 0 });
    try {
      let drawing;
      if (kind === 'native') drawing = new Drawing(await decodeDrawing(buffer));
      else {
        const res = await importDxf(buffer);
        drawing = new Drawing(res.drawing);
        const skipped = Object.entries(res.stats?.skipped || {});
        if (skipped.length) this.cmdline.log(`Some objects were not imported: ${skipped.map(([t, n]) => `${n} ${t}`).join(', ')}.`, 'muted');
        for (const w of (res.warnings || []).slice(0, 5)) this.cmdline.log(w, 'muted');
        if (res.release) this.cmdline.log(`${name} is an AutoCAD ${res.release} drawing (${res.version}).`, 'muted');
      }
      busy.remove();
      const doc = this.addDoc(drawing, baseName(name), { ...file, kind, name });
      // Replace an untouched empty drawing.
      const blank = this.docs.find((d) => d !== doc && !d.file && !d.drawing.entities.size && !d.drawing.modified && !d.drawing.canUndo);
      if (blank) this.closeDrawing(blank);
      this.zoomExtentsSoon();
      if (file.path) storage.addRecent({ name, path: file.path, source: file.source });
      this.cmdline.log(`Opened ${name} (${drawing.entities.size.toLocaleString()} objects)`, 'muted');
      return doc;
    } catch (err) {
      busy.remove();
      this.fileError('open', err);
      return null;
    }
  }

  fileError(what, err) {
    console.error(err);
    const msg = err?.message || String(err);
    toast(`Could not ${what} the file. ${msg}`, { kind: 'error', timeout: 7000 });
  }

  async encode(doc, kind) {
    if (kind === 'dxf') {
      const ext = doc.index.extents();
      const { text, warnings } = await exportDxf(doc.drawing, ext);
      for (const w of (warnings || []).slice(0, 5)) this.cmdline.log(w, 'muted');
      return new Blob([text], { type: 'application/dxf' });
    }
    if (kind === 'dwg') {
      const ext = doc.index.extents();
      const { bytes, warnings } = await exportDwg(doc.drawing, ext);
      for (const w of (warnings || []).slice(0, 5)) this.cmdline.log(w, 'muted');
      return new Blob([bytes], { type: 'image/vnd.dwg' });
    }
    return encodeDrawing(doc.drawing);
  }

  /** Save; returns true when saved. */
  async save(arg) {
    const doc = arg instanceof Doc ? arg : this.doc;
    if (!doc) return false;
    if (!doc.file || (!doc.file.path && !doc.file.handle)) return this.saveAs(doc);
    const kind = doc.file.kind || 'native';
    // Edits made while the file is written stay unsaved.
    const rev = doc.drawing.revision;
    try {
      const blob = await this.encode(doc, kind);
      let downloaded = false;
      if (doc.file.source === 'cloud') {
        if (!(await this.ensureSignedIn('save to your Puter drive'))) return false;
        await storage.cloudWrite(doc.file.path, blob);
      } else {
        const r = await storage.deviceSave(blob, doc.file.name || `${doc.name}${kindExt(kind)}`, doc.file.handle);
        if (!r) return false;
        doc.file.handle = r.handle;
        downloaded = !!r.downloaded;
      }
      this.saved(doc, rev, doc.file.name || doc.name, downloaded);
      return true;
    } catch (err) {
      this.fileError('save', err);
      return false;
    }
  }

  saved(doc, rev, name, downloaded) {
    doc.drawing.markSaved(rev);
    this.refreshAll();
    this.autosave(doc);
    toast(downloaded ? `Downloaded ${name}. Find it in your downloads folder.` : `Saved ${name}`, { kind: 'success' });
  }

  async saveAs(arg) {
    const doc = arg instanceof Doc ? arg : this.doc;
    if (!doc) return false;
    if (storage.usePuterPickers()) {
      const kind = await dialogs.formatChoice(this, doc);
      if (!kind) return false;
      const rev = doc.drawing.revision;
      try {
        const blob = await this.encode(doc, kind);
        // The picker never settles when cancelled, so nothing after it may hold state.
        const item = await storage.puterSavePicker(blob, `${doc.name}${kindExt(kind)}`);
        if (!item) return false;
        doc.file = { source: 'cloud', path: item.path, kind, name: item.name };
        doc.name = baseName(item.name);
        storage.addRecent({ name: item.name, path: item.path, source: 'cloud' });
        this.saved(doc, rev, item.name, false);
        return true;
      } catch (err) {
        this.fileError('save', err);
        return false;
      }
    }
    const target = await dialogs.saveAsDialog(this, doc);
    if (!target) return false;
    const rev = doc.drawing.revision;
    try {
      const blob = await this.encode(doc, target.kind);
      const fileName = `${target.name}${kindExt(target.kind)}`;
      let downloaded = false;
      if (target.source === 'cloud') {
        if (!(await this.ensureSignedIn('save to your Puter drive'))) return false;
        const path = `${storage.CLOUD_DIR}/${fileName}`;
        const same = !!doc.file?.path && (doc.file.path === path || doc.file.path.endsWith(`/${path}`));
        let item;
        try {
          item = await storage.cloudWrite(path, blob, same);
        } catch (err) {
          if (!storage.isExistsError(err)) throw err;
          const ok = await confirmDialog('Replace file?', `"${fileName}" already exists in your drive. Replace it?`, { confirm: 'Replace', danger: true });
          if (!ok) return false;
          item = await storage.cloudWrite(path, blob, true);
        }
        doc.file = { source: 'cloud', path: item?.path || path, kind: target.kind, name: fileName };
        storage.addRecent({ name: fileName, path: doc.file.path, source: 'cloud' });
      } else {
        const r = await storage.deviceSave(blob, fileName, null);
        if (!r) return false;
        doc.file = { source: 'device', handle: r.handle, kind: target.kind, name: r.name, path: null };
        downloaded = !!r.downloaded;
      }
      doc.name = target.name;
      this.saved(doc, rev, fileName, downloaded);
      return true;
    } catch (err) {
      this.fileError('save', err);
      return false;
    }
  }
  async exportDxf() {
    return this.exportAs('dxf');
  }

  async exportDwg() {
    return this.exportAs('dwg');
  }

  /** Download the active drawing as DXF or DWG without changing its file. */
  async exportAs(kind) {
    const doc = this.doc;
    if (!doc) return;
    try {
      const blob = await this.encode(doc, kind);
      await storage.deviceSave(blob, `${doc.name}${kindExt(kind)}`, null);
    } catch (err) {
      this.fileError('export', err);
    }
  }

  exportDialog() {
    return dialogs.exportDialog(this);
  }

  plotDialog() {
    return dialogs.plotDialog(this);
  }

  async importFile() {
    try {
      const f = await storage.deviceOpen();
      if (f) await this.openBuffer(f.buffer, f.name, { source: 'device', handle: f.handle, path: null });
    } catch (err) {
      this.fileError('import', err);
    }
  }

  /** Files opened from the Puter desktop (double click on a .cad, .dwg or .dxf). */
  async handleLaunchItems() {
    if (!(await platform.whenPuter())) return;
    try {
      if (platform.puterEnv() !== 'app') return;
      // Closing the desktop window asks about unsaved drawings first.
      puter.ui.onWindowClose?.(async () => {
        await this.flushAutosave();
        const unsaved = this.docs.filter((d) => d.drawing.modified);
        if (unsaved.length && (!this.ownsSession || this.recoveryFailed)) {
          const ok = await confirmDialog('Close with unsaved drawings?', `${unsaved.length} drawing${unsaved.length === 1 ? ' has' : 's have'} changes that are not saved and will be lost.`, { confirm: 'Close anyway', danger: true });
          if (!ok) return;
        }
        puter.exit();
      });
      const open = async (items) => {
        for (const it of items || []) {
          try {
            const blob = await it.read();
            await this.openBuffer(await blob.arrayBuffer(), it.name, { source: 'cloud', path: it.path });
          } catch (err) {
            this.fileError('open', err);
          }
        }
      };
      puter.ui.onLaunchedWithItems?.(open);
      puter.ui.onItemsOpened?.(open);
    } catch {
      /* not in the desktop */
    }
  }

  // Account -------------------------------------------------------------------------

  async initAccount() {
    this.renderAccount();
    if (!(await platform.whenPuter())) return;
    this.signedIn = await platform.isSignedIn();
    if (this.signedIn) await this.onSignedIn();
    this.renderAccount();
  }

  async onSignedIn() {
    this.user = await platform.getUser();
    this.signedIn = !!this.user;
    this.renderAccount();
    if (this.user) {
      const pic = await platform.fetchProfilePicture(this.user.username);
      if (pic) {
        this.profilePic = pic;
        this.renderAccount();
      }
      this.syncSettingsFromCloud();
    }
  }

  renderAccount() {
    const el = this.shell.account;
    clear(el);
    if (!this.signedIn) {
      el.append(
        h(
          'button.btn.sm.signin',
          {
            type: 'button',
            'aria-label': 'Sign in with Puter',
            'data-tip': 'Sign in with Puter',
            'data-tip-desc': 'Save drawings to your Puter drive and sync settings. Drawing works without an account.',
            onClick: () => this.signIn(),
          },
          icon('log-in', 15),
          h('span', 'Sign in'),
        ),
      );
      return;
    }
    const name = this.user?.username || 'Account';
    const pic = this.profilePic || platform.cachedProfilePicture(name);
    el.append(
      h(
        'button.avatar-btn',
        { type: 'button', 'aria-label': `Account: ${name}`, 'aria-haspopup': 'menu', 'data-tip': name, onClick: (e) => this.accountMenu(e.currentTarget) },
        pic ? h('img.avatar', { src: pic, alt: '' }) : h('span.avatar.initials', name.slice(0, 1).toUpperCase()),
      ),
    );
  }

  accountMenu(anchor) {
    const items = [{ header: `Signed in as ${this.user?.username ?? ''}` }];
    if (platform.canSignOut()) items.push({ label: 'Sign out', icon: 'log-out', action: () => this.signOut() });
    else items.push({ label: 'Signed in through Puter', disabled: true });
    showMenu(anchor, items, { alignRight: true, label: 'Account' });
  }

  async signIn() {
    try {
      await platform.signIn();
      this.signedIn = await platform.isSignedIn();
      if (this.signedIn) {
        await this.onSignedIn();
        toast('Signed in. You can now save drawings to your Puter drive.', { kind: 'success' });
      }
    } catch (err) {
      // Closing the sign-in window is a choice, not an error.
      const code = err?.error ?? err?.code ?? '';
      if (code !== 'auth_window_closed') {
        console.warn(err);
        toast(code === 'popup_blocked' ? 'The sign-in window was blocked. Allow pop-ups for this site and try again.' : 'Could not sign in. Please try again.', { kind: 'error', timeout: 7000 });
      }
    }
    this.renderAccount();
    return this.signedIn;
  }

  async signOut() {
    if (!platform.canSignOut()) return;
    clearTimeout(this._kvTimer);
    platform.signOut();
    platform.clearProfilePicture();
    this.signedIn = false;
    this.user = null;
    this.profilePic = null;
    this.renderAccount();
    toast('Signed out. Open drawings stay on this device.');
  }

  async ensureSignedIn(reason) {
    if (this.signedIn) return true;
    const ok = await confirmDialog('Sign in to continue', `Sign in with Puter to ${reason}. Your drawings stay private to your account.`, { confirm: 'Sign in' });
    if (!ok) return false;
    return this.signIn();
  }

  // Settings ---------------------------------------------------------------------------

  setSetting(key, value) {
    this.settings[key] = value;
    this.applySettings();
    saveJSON(SETTINGS_KEY, this.settings);
    this.pushSettingsToCloud();
  }

  toggleSetting(key) {
    this.setSetting(key, !this.settings[key]);
    const labels = { grid: 'Grid', snap: 'Snap', ortho: 'Ortho', polar: 'Polar tracking', osnap: 'Object snap', otrack: 'Object snap tracking', dyn: 'Dynamic input', lwDisplay: 'Lineweight display' };
    if (labels[key]) this.cmdline.log(`${labels[key]} ${this.settings[key] ? 'on' : 'off'}`, 'muted');
    // Ortho and polar are mutually exclusive.
    if (key === 'ortho' && this.settings.ortho && this.settings.polar) this.setSetting('polar', false);
    if (key === 'polar' && this.settings.polar && this.settings.ortho) this.setSetting('ortho', false);
  }

  applySettings() {
    const s = this.settings;
    this.renderer?.setOptions({ grid: s.grid, lwDisplay: s.lwDisplay, gridSpacing: s.gridSpacing || 10 });
    this.shell?.canvasWrap.classList.toggle('no-cmdline', !s.showCmdLine);
    this.editor?.drawOverlay();
    this.status?.refresh();
    this.ribbon?.refresh();
  }

  async syncSettingsFromCloud() {
    try {
      const saved = await puter.kv.get('settings');
      if (saved && typeof saved === 'object') {
        // The record holds only non-default values, so a missing key means the default.
        for (const k of SYNCED_SETTINGS) this.settings[k] = k in saved ? saved[k] : structuredClone(SETTING_DEFAULTS[k]);
        if (saved.theme) this.setTheme(saved.theme, false);
        this.applySettings();
        saveJSON(SETTINGS_KEY, this.settings);
      }
    } catch {
      /* offline or no KV */
    }
  }

  pushSettingsToCloud() {
    if (!this.signedIn) return;
    clearTimeout(this._kvTimer);
    // One small record, written at most every few seconds.
    this._kvTimer = setTimeout(() => {
      if (!this.signedIn) return;
      // Only what differs from the defaults, so new defaults still reach users.
      const changed = { theme: this.themePref };
      for (const k of SYNCED_SETTINGS) {
        const v = this.settings[k];
        if (JSON.stringify(v) !== JSON.stringify(SETTING_DEFAULTS[k])) changed[k] = v;
      }
      Promise.resolve()
        .then(() => puter.kv.set('settings', changed))
        .catch(() => {});
    }, 4000);
  }

  // Theme --------------------------------------------------------------------------------

  setTheme(pref, sync = true) {
    this.themePref = pref;
    try {
      localStorage.setItem(THEME_KEY, pref);
    } catch {
      /* ignore */
    }
    this.applyTheme();
    if (sync) this.pushSettingsToCloud();
  }

  applyTheme() {
    const root = document.documentElement;
    if (this.themePref === 'system') delete root.dataset.theme;
    else root.dataset.theme = this.themePref;
    const dark = this.themePref === 'dark' || (this.themePref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const cs = getComputedStyle(root);
    const bg = parseCssColor(cs.getPropertyValue('--bg-canvas').trim()) ?? (dark ? [31, 36, 44] : [255, 255, 255]);
    this.renderer?.setTheme({
      bg: bg.map((v) => v / 255),
      fg: dark ? [255, 255, 255] : [0, 0, 0],
      gridMinor: dark ? [1, 1, 1, 0.045] : [0, 0, 0, 0.05],
      gridMajor: dark ? [1, 1, 1, 0.1] : [0, 0, 0, 0.1],
      axisX: dark ? [0.95, 0.42, 0.42, 0.5] : [0.8, 0.2, 0.2, 0.45],
      axisY: dark ? [0.4, 0.85, 0.5, 0.5] : [0.15, 0.6, 0.3, 0.45],
      highlight: dark ? [0.36, 0.6, 1, 1] : [0.12, 0.44, 0.92, 1],
      hover: dark ? [0.36, 0.6, 1, 0.7] : [0.12, 0.44, 0.92, 0.7],
    });
    this.overlay?.readColors();
    this.editor?.drawOverlay();
    // The browser chrome follows the chosen theme, not only the system one.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = cs.getPropertyValue('--bg-app').trim();
    // Thumbnails and swatches are drawn with the text color.
    this.blocks?.refresh();
    if (this.ribbon?.contextual) this.ribbon.renderBody();
    if (this.shell) {
      clear(this.shell.themeBtn).append(icon(this.themePref === 'light' ? 'sun' : this.themePref === 'dark' ? 'moon' : 'monitor', 17));
      this.shell.themeBtn.dataset.tip = `Theme: ${this.themePref[0].toUpperCase()}${this.themePref.slice(1)}`;
    }
    this.ribbon?.refresh();
  }

  themeMenu(anchor) {
    const item = (v, label, ic) => ({ label, icon: ic, checked: this.themePref === v, radio: true, action: () => this.setTheme(v) });
    showMenu(anchor, [item('system', 'System', 'monitor'), item('light', 'Light', 'sun'), item('dark', 'Dark', 'moon')], { label: 'Theme', alignRight: true });
  }

  // Layout -----------------------------------------------------------------------------------

  observeSize() {
    const wrap = this.shell.canvasWrap;
    let last = '';
    const apply = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const key = `${r.width}x${r.height}@${dpr}`;
      if (key === last) return;
      last = key;
      this.renderer.resize(r.width, r.height, dpr);
      this.overlay.resize(r.width, r.height, dpr);
      if (r.width > 1 && r.height > 1) {
        this._sized = true;
        const pending = this._afterSize || [];
        this._afterSize = null;
        for (const fn of pending) fn();
      }
      this.editor.drawOverlay();
      this.editor.viewChanged();
    };
    // Measure now as well: observers do not report while the page is hidden.
    apply();
    new ResizeObserver(apply).observe(wrap);
    window.addEventListener('resize', apply);
    document.addEventListener('visibilitychange', apply);
  }

  layoutChanged() {
    /* the ResizeObserver handles size changes */
  }

  focusCanvas() {
    this.shell.overlay.focus({ preventScroll: true });
  }

  toggleCleanScreen() {
    const on = !document.body.classList.contains('clean-screen');
    document.body.classList.toggle('clean-screen', on);
    this.cmdline.log(on ? 'Clean screen on. Press Ctrl+0 to restore the interface.' : 'Clean screen off', 'muted');
  }

  // Dock (palettes) ---------------------------------------------------------------------------

  bindDock() {
    const s = this.shell;
    const saved = loadJSON(DOCK_KEY, {});
    if (saved.width) s.dock.style.width = `${saved.width}px`;
    let startX = 0,
      startW = 0;
    const onMove = (e) => {
      const w = Math.max(260, Math.min(innerWidth * 0.7, startW + (startX - e.clientX)));
      s.dock.style.width = `${w}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      saveJSON(DOCK_KEY, { ...loadJSON(DOCK_KEY, {}), width: s.dock.offsetWidth });
    };
    s.dockResize.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startW = s.dock.offsetWidth;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    s.dockResize.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const w = Math.max(260, Math.min(innerWidth * 0.7, s.dock.offsetWidth + (e.key === 'ArrowLeft' ? 20 : -20)));
      s.dock.style.width = `${w}px`;
    });
    this.dockPanels = [
      { id: 'properties', label: 'Properties', comp: this.properties },
      { id: 'layers', label: 'Layers', comp: this.layers },
      { id: 'blocks', label: 'Blocks', comp: this.blocks },
    ];
    this.dockOpen = new Set(saved.open || []);
    this.dockActive = saved.active || null;
  }

  /** Show a palette; focus: 'tab' keeps focus on its tab, true moves focus into the palette. */
  showDock(id, focus = false) {
    const s = this.shell;
    const tabFocused = s.dockTabs.contains(document.activeElement);
    this.dockOpen.add(id);
    this.dockActive = id;
    s.dock.hidden = false;
    s.workspace.classList.add('dock-open');
    clear(s.dockTabs);
    const open = this.dockPanels.filter((p) => this.dockOpen.has(p.id));
    for (const [i, p] of open.entries()) {
      const selected = p.id === id;
      s.dockTabs.append(
        h(
          'button.dock-tab',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(selected),
            tabindex: selected ? '0' : '-1',
            title: `${p.label} (Delete closes it)`,
            onClick: () => this.showDock(p.id),
            onKeydown: (e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const next = open[(i + (e.key === 'ArrowRight' ? 1 : -1) + open.length) % open.length];
                this.showDock(next.id, 'tab');
              } else if (e.key === 'Delete') {
                e.preventDefault();
                e.stopPropagation();
                this.closeDock(p.id);
              }
            },
          },
          p.label,
          h(
            'span.dock-tab-x',
            {
              'aria-hidden': 'true',
              onClick: (e) => {
                e.stopPropagation();
                this.closeDock(p.id);
              },
            },
            icon('x', 12),
          ),
        ),
      );
    }
    if (tabFocused || focus === 'tab') s.dockTabs.querySelector('[aria-selected="true"]')?.focus();
    const panel = this.dockPanels.find((p) => p.id === id);
    clear(s.dockBody).append(panel.comp.el);
    s.dock.classList.toggle('wide', id === 'layers');
    panel.comp.render();
    if (focus === true) (panel.comp.el.querySelector('input, select, button:not([disabled])') ?? panel.comp.el).focus?.();
    saveJSON(DOCK_KEY, { ...loadJSON(DOCK_KEY, {}), open: [...this.dockOpen], active: id });
  }

  closeDock(id = this.dockActive) {
    const s = this.shell;
    this.dockOpen.delete(id);
    // Closing a background palette leaves the visible one in place.
    if (id !== this.dockActive && this.dockActive && this.dockOpen.has(this.dockActive)) {
      this.showDock(this.dockActive);
      return;
    }
    const next = [...this.dockOpen].at(-1);
    if (next) this.showDock(next);
    else {
      s.dock.hidden = true;
      s.workspace.classList.remove('dock-open');
      clear(s.dockBody);
      this.dockActive = null;
      saveJSON(DOCK_KEY, { ...loadJSON(DOCK_KEY, {}), open: [], active: null });
      this.focusCanvas();
    }
  }

  togglePanel(id) {
    if (this.dockActive === id && !this.shell.dock.hidden) this.closeDock(id);
    else this.showDock(id, true);
  }

  toggleProperties() {
    this.togglePanel('properties');
  }

  toggleLayers() {
    this.togglePanel('layers');
  }

  toggleBlocks() {
    this.togglePanel('blocks');
  }

  // Phone toolbar ---------------------------------------------------------------------------

  renderPhonebar() {
    const bar = this.shell.phonebar;
    clear(bar);
    for (const g of PHONE_GROUPS) {
      bar.append(
        h(
          'button.pb-btn',
          {
            type: 'button',
            'aria-haspopup': g.cmds ? 'dialog' : null,
            onClick: () => (g.action ? this.run(g.action) : this.toolSheet(g)),
          },
          icon(g.icon, 20),
          h('span', g.label),
        ),
      );
    }
    bar.append(
      h('button.pb-btn.pb-cmd', { type: 'button', onClick: () => this.cmdline.submit() }, icon('check', 20), h('span', 'Enter')),
      h('button.pb-btn.pb-cmd', { type: 'button', onClick: () => this.editor.cancel() }, icon('x', 20), h('span', 'Cancel')),
    );
  }

  toolSheet(group) {
    dialogs.toolSheet(this, group);
  }

  // Commands and properties -------------------------------------------------------------------

  run(name, args) {
    closeMenus();
    this.ribbon.closeFlyout();
    // Drawing commands take input on the canvas; dialogs and palettes manage focus themselves.
    const def = this.editor.find(name);
    if (def && !def.immediate) this.focusCanvas();
    return this.editor.run(name, args);
  }

  undo() {
    const d = this.doc?.drawing;
    if (!d) return;
    if (this.editor.busy) this.editor.cancelAll();
    const label = d.undo();
    this.cmdline.log(label ? `Undo ${label}` : 'Nothing to undo', 'muted');
  }

  redo() {
    const d = this.doc?.drawing;
    if (!d) return;
    const label = d.redo();
    this.cmdline.log(label ? `Redo ${label}` : 'Nothing to redo', 'muted');
  }

  pushView() {
    if (!this.doc) return;
    this.doc.viewStack.push(this.camera.state);
    if (this.doc.viewStack.length > 50) this.doc.viewStack.shift();
  }

  zoomPrevious() {
    const v = this.doc?.viewStack.pop();
    if (!v) return this.cmdline.log('No previous view.', 'muted');
    this.camera.state = v;
    this.editor.viewChanged();
  }

  /** Set a property on the selection, or the current value for new objects. */
  applyProperty(key, value) {
    const doc = this.doc;
    if (!doc) return;
    const d = doc.drawing;
    if (doc.selection.size) {
      d.transaction(`Change ${key}`, () => {
        for (const id of doc.selection) if (d.get(id)) d.update(id, { [key]: value });
      });
    } else {
      const map = { color: 'ccolor', linetype: 'cltype', lineweight: 'clweight', layer: 'clayer' };
      d.transaction(`Current ${key}`, () => d.setHeader({ [map[key]]: value }));
    }
    this.focusCanvas();
  }

  applyStyle(kind, value) {
    const doc = this.doc;
    const d = doc.drawing;
    const ent = kind === 'dimStyle' ? 'dimension' : 'text';
    d.transaction('Change style', () => {
      d.setHeader({ [kind]: value });
      if (doc.selection.size) {
        for (const id of doc.selection) {
          const e = d.get(id);
          if (!e) continue;
          if (kind === 'textHeight' && (e.type === 'text' || e.type === 'mtext')) d.update(id, { h: value });
          else if (kind === 'textStyle' && (e.type === 'text' || e.type === 'mtext')) d.update(id, { style: value });
          else if (kind === 'dimStyle' && (e.type === ent || e.type === 'leader')) d.update(id, { style: value });
        }
      }
    });
  }

  async promptTextHeight() {
    const v = await promptDialog('Text height', 'Height in drawing units', String(this.doc.drawing.header.textHeight), {
      validate: (s) => (Number(s) > 0 ? null : 'Enter a number greater than zero.'),
    });
    if (v) this.applyStyle('textHeight', Number(v));
  }

  setCurrentLayer(name) {
    const d = this.doc.drawing;
    const l = d.layers.get(name);
    if (!l) return;
    d.transaction('Set current layer', () => {
      if (l.frozen) d.setTable('layers', name, { ...l, frozen: false });
      d.setHeader({ clayer: name });
    });
  }

  setLayerProp(name, patch) {
    const d = this.doc.drawing;
    const l = d.layers.get(name);
    if (!l) return;
    if (patch.frozen && name === d.header.clayer) {
      toast('The current layer cannot be frozen.', { kind: 'error' });
      return;
    }
    d.transaction('Layer properties', () => d.setTable('layers', name, { ...l, ...patch }));
  }

  /** Rename a layer everywhere. Returns an error message or null. */
  renameLayer(from, to) {
    const d = this.doc.drawing;
    if (!/^[^<>/\\":;?*|=`]{1,255}$/.test(to)) return 'Layer names cannot contain < > / \\ " : ; ? * | = or `.';
    if (d.layers.has(to)) return `A layer named "${to}" already exists.`;
    const l = d.layers.get(from);
    d.transaction('Rename layer', () => {
      d.setTable('layers', to, { ...l, name: to });
      for (const [id, e] of d.entities) if (e.layer === from) d.update(id, { layer: to });
      for (const b of d.blocks.values()) if (b.entities.some((e) => e.layer === from)) d.setBlock(b.name, { ...b, entities: b.entities.map((e) => (e.layer === from ? { ...e, layer: to } : e)) });
      if (d.header.clayer === from) d.setHeader({ clayer: to });
      d.setTable('layers', from, null);
    });
    return null;
  }

  colorDialog(initial, opts) {
    return dialogs.colorDialog(this, initial, opts);
  }

  editEntity(id) {
    const e = this.doc.drawing.get(id);
    if (!e) return;
    if (e.type === 'text' || e.type === 'mtext' || (e.type === 'leader' && e.text !== undefined)) {
      this.editor.run({
        name: 'TEXTEDIT',
        label: 'Edit text',
        noRepeat: true,
        run: async (ed) => {
          const key = e.type === 'leader' ? 'text' : 'value';
          ed.renderer.setHidden(new Set([id]));
          const pos = e.type === 'leader' ? { x: e.pts.at(-2), y: e.pts.at(-1) } : { x: e.x, y: e.y };
          const v = await ed.editText({ anchor: pos, height: e.h, rot: e.rot || 0, multiline: e.type === 'mtext', width: e.width, initial: e[key], onChange: (val) => ed.renderer.setPreview([{ ...e, [key]: val }]) });
          ed.renderer.setHidden(new Set());
          if (v !== null && v !== e[key]) ed.commit('Edit text', () => (v ? ed.drawing.update(id, { [key]: v }) : ed.drawing.remove(id)));
        },
      });
      return;
    }
    this.editor.setSelection([id]);
    this.showDock('properties');
  }

  /** In-place text editing, cancellable through the editor. */
  editText(opts) {
    const ed = this.editor;
    return new Promise((resolve, reject) => {
      let handle;
      const req = {
        kind: 'text',
        prompt: opts.multiline ? 'Type the text. Press Ctrl+Enter to finish.' : 'Type the text. Press Enter to finish.',
        opts: {},
        options: [],
        resolve,
        reject: (err) => {
          handle?.close();
          reject(err);
        },
      };
      ed.request = req;
      this.cmdline.prompt(req.prompt, []);
      handle = this.textEditor.open({
        ...opts,
        onDone: (value) => {
          if (ed.request === req) ed.request = null;
          if (value === null) reject(new CancelError());
          else resolve(value);
        },
      });
    });
  }

  showHatchTab(st, onChange) {
    if (!st) {
      this.ribbon.setContextual(null);
      return;
    }
    this.ribbon.setContextual(hatchTab(this, st, onChange));
  }

  contextMenu(x, y, items) {
    if (items) return showMenu({ x, y }, items, { label: 'Context menu' });
    const sel = this.doc?.selection.size;
    const last = this.editor.lastCommand ? this.commands.get(this.editor.lastCommand) : null;
    const c = (name, extra = {}) => {
      const d = this.commands.get(name);
      return { label: d.label, icon: d.icon, action: () => this.run(name), ...extra };
    };
    const list = [];
    if (last) list.push({ label: `Repeat ${last.label}`, icon: last.icon, shortcut: 'Enter', action: () => this.run(last.name) });
    if (sel) {
      list.push({ separator: true }, c('ERASE', { shortcut: 'Del' }), c('MOVE'), c('COPY'), c('SCALE'), c('ROTATE'), c('MIRROR'));
      list.push({ separator: true }, c('CUTCLIP', { shortcut: `${MOD}+X` }), c('COPYCLIP', { shortcut: `${MOD}+C` }), c('COPYBASE'));
      list.push(
        { separator: true },
        { label: 'Draw order', icon: 'draw-order', submenu: [{ label: 'Bring to front', action: () => this.run('DRAWORDER', { where: 'front' }) }, { label: 'Send to back', action: () => this.run('DRAWORDER', { where: 'back' }) }] },
        c('SELECTSIMILAR'),
        { label: 'Deselect all', action: () => this.editor.clearSelection(), shortcut: 'Esc' },
        { separator: true },
        { label: 'Properties', icon: 'sliders', shortcut: `${MOD}+1`, action: () => this.showDock('properties') },
      );
    } else {
      list.push(
        { separator: true },
        { label: 'Undo', icon: 'undo', shortcut: `${MOD}+Z`, disabled: !this.doc?.drawing.canUndo, action: () => this.undo() },
        { label: 'Redo', icon: 'redo', shortcut: `${MOD}+Y`, disabled: !this.doc?.drawing.canRedo, action: () => this.redo() },
        { separator: true },
        c('PASTECLIP', { shortcut: `${MOD}+V` }),
        c('SELECTALL', { shortcut: `${MOD}+A` }),
        c('QSELECT'),
        { separator: true },
        { label: 'Pan', icon: 'pan', action: () => this.run('PAN') },
        { label: 'Zoom extents', icon: 'zoom-extents', action: () => this.editor.zoomExtents() },
        { separator: true },
        { label: 'Settings', icon: 'settings', action: () => this.run('OPTIONS') },
      );
    }
    showMenu({ x, y }, list, { label: 'Context menu' });
  }

  appMenu(anchor) {
    const recent = storage.recentFiles();
    const items = [
      { label: 'New', icon: 'file-plus', shortcut: `${MOD}+N`, action: () => this.run('NEW') },
      { label: 'Open...', icon: 'folder-open', shortcut: `${MOD}+O`, action: () => this.run('OPEN') },
      { label: 'Open sample drawing', icon: 'file-text', action: () => this.openSample() },
      recent.length
        ? {
            label: 'Recent',
            icon: 'history',
            submenu: recent.map((r) => ({ label: r.name, icon: r.source === 'cloud' ? 'cloud' : 'file', action: () => this.openRecent(r) })),
          }
        : null,
      { label: 'Save', icon: 'save', shortcut: `${MOD}+S`, action: () => this.run('SAVE') },
      { label: 'Save as...', icon: 'save-all', shortcut: `${MOD}+Shift+S`, action: () => this.run('SAVEAS') },
      { separator: true },
      { label: 'Import DXF or DWG...', icon: 'upload', action: () => this.run('IMPORT') },
      { label: 'Export...', icon: 'download', action: () => this.run('EXPORT') },
      { label: 'Plot...', icon: 'printer', shortcut: `${MOD}+P`, action: () => this.run('PLOT') },
      { separator: true },
      { label: 'Drawing units...', icon: 'units', action: () => this.run('UNITS') },
      { label: 'Purge unused...', icon: 'trash', action: () => this.run('PURGE') },
      { label: 'Settings...', icon: 'settings', action: () => this.run('OPTIONS') },
      { separator: true },
      { label: 'Keyboard shortcuts', icon: 'keyboard', action: () => this.shortcuts() },
      { label: 'Help', icon: 'help', shortcut: 'F1', action: () => this.help() },
      { label: 'Source code on GitHub', icon: 'github', action: () => window.open(REPO_URL, '_blank', 'noopener') },
      { separator: true },
      { label: 'Close drawing', icon: 'x', action: () => this.closeDrawing() },
    ];
    showMenu(anchor, items, { label: 'Application menu' });
  }

  async openRecent(r) {
    if (r.source === 'cloud') {
      if (!(await this.ensureSignedIn('open files from your Puter drive'))) return;
      try {
        await this.openBuffer(await storage.cloudRead(r.path), r.name, { source: 'cloud', path: r.path });
      } catch (err) {
        // Forget it only when the file is gone, not on a network hiccup.
        if (storage.isNotFoundError(err)) storage.removeRecent(r.path);
        this.fileError('open', err);
      }
    }
  }

  commandPalette() {
    return dialogs.commandPalette(this);
  }

  // Dialog commands ---------------------------------------------------------------------

  unitsDialog() {
    return dialogs.unitsDialog(this);
  }
  settingsDialog() {
    return dialogs.settingsDialog(this);
  }
  draftingDialog() {
    return dialogs.draftingDialog(this);
  }
  textStylesDialog() {
    return dialogs.textStylesDialog(this);
  }
  dimStylesDialog() {
    return dialogs.dimStylesDialog(this);
  }
  linetypesDialog() {
    return dialogs.linetypesDialog(this);
  }
  quickSelect() {
    return dialogs.quickSelectDialog(this);
  }
  purge() {
    return dialogs.purgeDialog(this);
  }
  help() {
    return dialogs.helpDialog(this);
  }
  shortcuts() {
    return dialogs.shortcutsDialog(this);
  }
  async ltscalePrompt() {
    const d = this.doc.drawing;
    const v = await this.editor.getNumber('Global linetype scale', { default: d.header.ltscale, min: 1e-6 });
    if (Number.isFinite(v) && v > 0) d.transaction('Linetype scale', () => d.setHeader({ ltscale: v }));
  }

  // Keyboard ------------------------------------------------------------------------------

  bindKeys() {
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.editor.shiftDown = false;
    });
  }

  onKey(e) {
    if (e.key === 'Shift') this.editor.shiftDown = true;
    const t = e.target;
    const inCmd = t === this.cmdline.input;
    const typing = !inCmd && t instanceof HTMLElement && (t.matches('input, textarea, select, [contenteditable]') || t.closest('dialog, .menu, .text-editor'));
    if (document.querySelector('dialog[open]')) return;
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (mod && !e.altKey) {
      const map = {
        z: e.shiftKey ? () => this.redo() : () => this.undo(),
        y: () => this.redo(),
        c: e.shiftKey ? () => this.run('COPYBASE') : () => this.run('COPYCLIP'),
        x: () => this.run('CUTCLIP'),
        v: () => this.run('PASTECLIP'),
        a: () => this.run('SELECTALL'),
        s: e.shiftKey ? () => this.run('SAVEAS') : () => this.run('SAVE'),
        o: () => this.run('OPEN'),
        n: () => this.run('NEW'),
        p: () => this.run('PLOT'),
        k: () => this.commandPalette(),
        1: () => this.toggleProperties(),
        9: () => this.setSetting('showCmdLine', !this.settings.showCmdLine),
        0: () => this.toggleCleanScreen(),
      };
      if (inCmd && (k === 'c' || k === 'x' || k === 'v' || k === 'a') && this.cmdline.value()) return;
      const fn = map[k];
      if (fn) {
        e.preventDefault();
        fn();
      }
      return;
    }
    const fkeys = { F1: () => this.help(), F2: () => this.cmdline.toggleHistory(), F3: () => this.toggleSetting('osnap'), F7: () => this.toggleSetting('grid'), F8: () => this.toggleSetting('ortho'), F9: () => this.toggleSetting('snap'), F10: () => this.toggleSetting('polar'), F11: () => this.toggleSetting('otrack'), F12: () => this.toggleSetting('dyn') };
    if (fkeys[e.key]) {
      e.preventDefault();
      fkeys[e.key]();
      return;
    }
    if (inCmd) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cmdline.setValue('');
      if (this.ribbon.flyoutOpen) this.ribbon.closeFlyout();
      else this.editor.cancel();
      return;
    }
    if (e.key === 'Delete' && !this.editor.busy && this.doc?.selection.size) {
      e.preventDefault();
      this.run('ERASE');
      return;
    }
    const onCanvas = t === document.body || t === this.shell.overlay;
    if ((e.key === 'Enter' || (e.key === ' ' && this.editor.spaceSubmits)) && onCanvas) {
      e.preventDefault();
      this.cmdline.submit();
      return;
    }
    if (t === this.shell.overlay && !e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const step = e.shiftKey ? 200 : 60;
      const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
      const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
      this.camera.panBy(dx, dy);
      this.editor.viewChanged();
      return;
    }
    // AltGr (Ctrl+Alt on Windows) types characters such as @ on many layouts.
    const altGr = e.getModifierState?.('AltGraph');
    if (e.key.length === 1 && (!e.altKey || altGr) && (t === document.body || t === this.shell.overlay || t.closest?.('.canvas-wrap, .ribbon, .statusbar, .titlebar, .docbar'))) {
      if (t instanceof HTMLButtonElement && e.key === ' ') return;
      e.preventDefault();
      this.cmdline.type(e.key);
    }
  }
}

// Helpers ---------------------------------------------------------------------------------

function loadJSON(key, def) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? def;
  } catch {
    return def;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function loadTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function parseCssColor(s) {
  const m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const r = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(s);
  return r ? [Number(r[1]), Number(r[2]), Number(r[3])] : null;
}
