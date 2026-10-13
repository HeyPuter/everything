import { newDocument, findLayer, allLayers, type PhotoDocument, type Layer } from './model/document';
import { ImageEngine } from './engine/engine';
import { Renderer } from './renderer/renderer';
import { FreeTransform } from './ui/transform';
import { selectedRoots, visibleRows } from './model/layers';
import { layerLock, type LockOperation } from './model/locks';
import { DocumentSession } from './app/session';
import { appShell } from './app/shell';
import { MenuBar } from './app/menubar';
import { Toolbar } from './app/toolbar';
import { Dock } from './app/dock';
import { bindCanvas, type CanvasPointer } from './app/pointer';
import { commands, findCommand, overlays, tools, type Tool } from './app/registry';
import { brushSizeStep, eventShortcut, platformShortcut } from './app/shortcuts';
import { watchOptionTips } from './app/option-tips';
import { svg } from './app/icons';
import { startIdleWork } from './app/lazy';
import { emitActivity } from './app/activity';
import { rulerTicks, rulerUnitScale } from './ui/rulers';
import { DocumentView, WindowManager } from './app/views';
import { applyAffine, centerPoint, fitZoom, invertAffine, panToCenter, stageTransform, viewMatrix, zoomAround } from './app/view-transform';
import { commitPixelResample, commitPixelTranslation, pixelTransformKind, syncPixelTransform } from './model/pixel-layer';
import { installFeatures } from './features';
import { followLinkedMasks } from './model/links';
import { bakeTextScale } from './model/text-layer';
import type { ColorControls } from './ui/color';
import type { History } from './history/history';
import type { Assets } from './model/assets';
import { loadPreferences, PREFERENCES_KEY, type Preferences } from './model/preferences';

const modeLabels: Record<string, string> = { rgb: 'RGB', grayscale: 'Gray', cmyk: 'CMYK', lab: 'Lab', indexed: 'Index', bitmap: 'Bitmap', duotone: 'Duotone', multichannel: 'Multichannel' };
const modeLabel = (doc: PhotoDocument) => modeLabels[doc.mode ?? 'rgb'] ?? 'RGB';

export type { Preferences } from './model/preferences';

export class Editor {
  engine = new ImageEngine();
  renderer!: Renderer;
  sessions: DocumentSession[] = [];
  // Windows onto documents, in tab order; a document can have several.
  views: DocumentView[] = [];
  activeView!: DocumentView;
  windows: WindowManager;
  private viewUse = 0;
  autoSelect = true;
  tool = 'move';
  color = '#000000';
  background = '#ffffff';
  colorControls?: ColorControls;
  transform: FreeTransform;
  // A feature-owned modal edit (advanced transform, crop) that finishes before
  // any other edit and supplies the document shown on the canvas meanwhile.
  modal?: { document?: PhotoDocument; apply(): void; cancel(): void };
  menubar!: MenuBar;
  toolbar!: Toolbar;
  dock!: Dock;
  preferences: Preferences;
  // Shared tool settings; features extend this bag with their own keys.
  settings: Record<string, unknown> = {};
  brushSize = 30;
  maskSoftness = 0.5;
  maskOpacity = 1;
  tolerance = 32;
  busy = false;
  toolBusy = false;
  private toastTimer = 0;
  private renderFrame = 0;
  private lastDoc?: PhotoDocument;
  private updateHooks: ((e: Editor) => void)[] = [];
  // Run on every new history state after pixel layers are normalized, with the
  // previous state (frame animation records edits this way).
  documentHooks: ((doc: PhotoDocument, before: PhotoDocument) => void)[] = [];
  constructor(public root: HTMLElement) {
    appShell(root);
    this.preferences = readPreferences();
    this.windows = new WindowManager(this);
    this.session = this.newSession();
    this.transform = new FreeTransform(this);
    if (matchMedia('(max-width:760px)').matches) root.classList.add('panels-hidden');
  }
  // ----- Sessions -----
  newSession(doc = newDocument()) {
    const s = new DocumentSession(doc);
    s.history.limit = this.preferences.historyStates;
    s.history.nonLinear = () => this.preferences.nonLinearHistory;
    s.history.normalize = (d, before) => {
      followLinkedMasks(before, d, s.assets.tiles);
      this.normalizePixelLayers(d, s.assets);
      for (const hook of this.documentHooks) hook(d, before);
    };
    this.sessions.push(s);
    this.views.push(new DocumentView(s));
    return s;
  }
  /** The active document; assigning switches to its most recent window. */
  get session(): DocumentSession {
    return this.activeView.session;
  }
  set session(s: DocumentSession) {
    this.setActiveView(this.viewsOf(s).at(-1) ?? this.addView(s));
  }
  /** Windows of a document, least recently used first. */
  viewsOf(s: DocumentSession) {
    return this.views.filter((v) => v.session === s).sort((a, b) => a.used - b.used);
  }
  /** Another window onto a document, placed after its existing windows. */
  addView(s: DocumentSession, from?: DocumentView) {
    const v = new DocumentView(s);
    if (from) Object.assign(v, { zoom: from.zoom, pan: { ...from.pan }, rotation: from.rotation, flip: from.flip });
    const last = this.views.map((x) => x.session).lastIndexOf(s);
    this.views.splice(last < 0 ? this.views.length : last + 1, 0, v);
    return v;
  }
  private setActiveView(v: DocumentView) {
    v.used = ++this.viewUse;
    const changed = v !== this.activeView;
    this.activeView = v;
    if (changed && this.windows?.multi) this.windows.layout();
  }
  /** Make a window active: it receives input and hosts the live canvas. */
  async activateView(v: DocumentView) {
    if (v === this.activeView || !this.views.includes(v)) return;
    this.transform.apply();
    this.activeTool?.deactivate?.(this);
    this.setActiveView(v);
    this.activeTool?.activate?.(this);
    this.view();
    this.update();
  }
  /** Close one window; the last window of a document closes the document. */
  async closeView(v: DocumentView) {
    const siblings = this.views.filter((x) => x.session === v.session);
    if (siblings.length < 2) return this.closeSession(v.session);
    const i = this.views.indexOf(v);
    this.views.splice(i, 1);
    if (v === this.activeView) this.setActiveView(this.viewsOf(v.session).at(-1)!);
    this.windows.refresh();
    this.update();
    return true;
  }
  /** Horizontal display stretch of a document's pixels (pixel aspect correction). */
  viewAspect(s = this.session) {
    const a = s.doc.pixelAspect;
    return a && a !== 1 && this.preferences.aspectCorrection !== false ? a : 1;
  }
  get history(): History {
    return this.session.history;
  }
  get assets(): Assets {
    return this.session.assets;
  }
  set assets(a: Assets) {
    this.session.assets = a;
  }
  get storage() {
    return this.session.storage;
  }
  get selectedIds() {
    return this.session.selectedIds;
  }
  set selectedIds(ids: Set<string>) {
    this.session.selectedIds = ids;
  }
  get collapsedGroups() {
    return this.session.collapsedGroups;
  }
  get zoom() {
    return this.activeView.zoom;
  }
  set zoom(z: number) {
    this.activeView.zoom = z;
  }
  get pan() {
    return this.activeView.pan;
  }
  set pan(p: { x: number; y: number }) {
    this.activeView.pan = p;
  }
  get rotation() {
    return this.activeView.rotation;
  }
  get hasDocument() {
    return this.session.hasDocument;
  }
  set hasDocument(v: boolean) {
    this.session.hasDocument = v;
  }
  get saved() {
    return this.session.saved;
  }
  set saved(d: PhotoDocument | undefined) {
    this.session.saved = d;
  }
  get maskTarget() {
    return this.session.maskTarget;
  }
  set maskTarget(id: string) {
    this.session.maskTarget = id;
  }
  async switchSession(s: DocumentSession) {
    if (s === this.session) return;
    await this.activateView(this.viewsOf(s).at(-1) ?? this.addView(s));
  }
  // Called after a document tab closes (features drop state tied to it).
  closeHooks: ((s: DocumentSession) => void)[] = [];
  // Called after a document is saved (the project blob written).
  saveHooks: ((s: DocumentSession, project: Blob) => void)[] = [];
  async closeSession(s: DocumentSession, force = false) {
    if (!force && s.closeHandler) {
      if (!(await s.closeHandler())) return false;
    } else if (!force && s.dirty) {
      const { formDialog } = await import('./ui/dialog');
      if (!(await formDialog(`Close “${s.doc.name}”?`, [], 'Close without saving', 'Unsaved changes will be lost.'))) return false;
    }
    if (s === this.session) {
      this.transform.cancel();
      this.modal?.cancel();
    }
    const i = this.sessions.indexOf(s);
    const active = s === this.session;
    this.sessions.splice(i, 1);
    this.views = this.views.filter((v) => v.session !== s);
    await this.renderer?.settle();
    s.dispose();
    for (const hook of this.closeHooks) hook(s);
    if (!this.sessions.length) this.newSession();
    if (active || !this.views.includes(this.activeView)) this.session = this.sessions[Math.max(0, i - 1)] ?? this.sessions[0];
    this.windows.refresh();
    this.fit();
    this.update();
    return true;
  }
  /** Session for a newly opened document: reuse an untouched empty workspace. */
  sessionForOpen() {
    if (!this.session.hasDocument && !this.session.history.canUndo) return this.session;
    const s = this.newSession();
    this.session = s;
    // Workspace → Open documents as tabs (off: new documents float).
    if (!this.preferences.openAsTabs && this.windows.kind === 'tabs') this.windows.float(this.viewsOf(s));
    return s;
  }
  // ----- Layer selection -----
  get selected() {
    return [...this.selectedIds].at(-1) ?? '';
  }
  set selected(id: string) {
    this.selectLayers(id ? [id] : []);
  }
  get selectedLayers() {
    return selectedRoots(this.doc.layers, this.selectedIds);
  }
  selectLayers(ids: string[]) {
    if (ids.length !== 1 || ids[0] !== this.maskTarget) this.maskTarget = '';
    this.session.selectedIds = new Set(ids);
    this.session.selections.set(this.doc, ids);
  }
  selectLayer(id: string, toggle = false, range = false) {
    this.maskTarget = '';
    this.transform.apply();
    const reveal = (layers: Layer[]): boolean =>
      layers.some((l) => {
        if (l.id === id) return true;
        if (!reveal(l.children)) return false;
        this.collapsedGroups.delete(l.id);
        return true;
      });
    reveal(this.doc.layers);
    const rows = visibleRows(this.doc.layers, this.collapsedGroups).map((l) => l.id);
    if (range && rows.includes(this.session.selectionAnchor)) {
      const a = rows.indexOf(this.session.selectionAnchor),
        b = rows.indexOf(id);
      const selection = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
      this.selectLayers(toggle ? [...this.selectedIds, ...selection] : selection);
    } else {
      const ids = new Set(toggle ? this.selectedIds : []);
      if (toggle && ids.has(id)) ids.delete(id);
      else ids.add(id);
      this.selectLayers([...ids]);
      this.session.selectionAnchor = id;
    }
    this.update();
  }
  restoreSelection() {
    this.selectLayers(this.session.selections.get(this.doc) ?? [...this.selectedIds]);
    this.update();
  }
  get editingMask() {
    return this.selectedIds.size === 1 && this.maskTarget === this.selected;
  }
  get doc() {
    return this.history.document;
  }
  get layer() {
    return findLayer(this.doc.layers, this.selected);
  }
  get dirty() {
    return this.hasDocument && (this.doc !== this.saved || this.session.unsavedExtras || this.transform.changed);
  }
  get activeTool() {
    return tools.get(this.tool);
  }
  el<T extends HTMLElement = HTMLElement>(selector: string) {
    return this.root.querySelector<T>(selector)!;
  }
  onUpdate(hook: (e: Editor) => void) {
    this.updateHooks.push(hook);
  }
  private readyHooks: ((e: Editor) => void)[] = [];
  /** Run once the compositor exists (immediately if it already does). */
  whenReady(hook: (e: Editor) => void) {
    if (this.renderer) hook(this);
    else this.readyHooks.push(hook);
  }
  // ----- Startup -----
  async start() {
    installFeatures(this);
    this.menubar = new MenuBar(this, this.el('.menubar'));
    this.toolbar = new Toolbar(this, this.el('.toolbar'));
    this.dock = new Dock(this, this.el('.dock'));
    this.dock.registerCommands();
    this.bind();
    this.transform.bind();
    bindCanvas(this);
    this.dock.render();
    performance.mark('photo-studio:shell');
    this.renderer = await Renderer.create(this.el<HTMLCanvasElement>('#canvas'), this.engine, this.preferences.gpuBackend);
    if (this.preferences.gpuBackend === 'webgpu' && !/webgpu/i.test(this.renderer.name)) this.message('WebGPU is not available in this browser; using WebGL2.');
    this.renderer.frameListeners.add((canvas, doc) => this.windows.frame(canvas, doc));
    for (const hook of this.readyHooks.splice(0)) hook(this);
    this.windows.kind = this.preferences.windowLayout ?? 'tabs';
    this.windows.layout();
    this.el('#engine-status').textContent = this.renderer.name;
    await this.engine.ready();
    this.setTool(this.tool);
    this.fit();
    this.update();
    this.el('#canvas').addEventListener('renderer-notice', (e) => this.message((e as CustomEvent<string>).detail));
    this.el('#canvas').addEventListener('renderer-lost', (e) => this.message((e as CustomEvent<string>).detail));
    performance.mark('photo-studio:ready');
    startIdleWork();
  }
  message(text: string) {
    this.el('#status').textContent = text;
    const toast = this.el('#toast');
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (toast.hidden = true), 5500);
  }
  async run(task: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.root.setAttribute('aria-busy', 'true');
    try {
      await task();
    } catch (error) {
      // Messages for the user are plain Errors; anything else is a bug and
      // keeps its stack in the console.
      if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError) console.error(error);
      this.message(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.root.removeAttribute('aria-busy');
    }
  }
  /** Let the user work while a task waits on something that may never answer
   * (a Puter picker that was dismissed); later steps run through `run` again. */
  release() {
    this.busy = false;
    this.root.removeAttribute('aria-busy');
  }
  /** Run a registered command by ID (menus, shortcuts, buttons, actions). */
  async runCommand(id: string, arg?: unknown) {
    const c = findCommand(id);
    if (!c) {
      this.message(`Unknown command: ${id}`);
      return;
    }
    if (c.enabled && !c.enabled(this)) return;
    // Saving and exporting read the document directly; commit a pending
    // transform first so the file matches what is on screen.
    if (id.startsWith('file.') && !this.toolBusy) {
      this.transform.apply();
      this.modal?.apply();
    }
    this.recorder?.(id, arg);
    const outer = this.currentCommand;
    this.currentCommand = this.lastCommand = id;
    try {
      await this.run(async () => {
        await c.run(this, arg);
        emitActivity({ kind: 'command', id: c.id, arg });
      });
    } finally {
      this.currentCommand = outer;
    }
  }
  // The command running now, and the last one run (provenance attributes
  // history steps to them).
  currentCommand?: string;
  lastCommand?: string;
  // The Actions panel installs a recorder while recording.
  recorder?: (id: string, arg?: unknown) => void;
  command(label: string, edit: (doc: PhotoDocument) => void, opts: { coalesce?: boolean } = {}) {
    this.transform.apply();
    this.modal?.apply();
    this.session.selections.set(this.doc, [...this.selectedIds]);
    const before = this.doc;
    this.history.execute(label, edit, opts.coalesce);
    if (this.doc !== before) {
      this.hasDocument = true;
      this.collectGarbage();
    }
    this.update();
  }
  private gcCounter = 0;
  collectGarbage(extra: Iterable<string> = []) {
    // Tile cleanup walks every reachable state; amortize it over several edits.
    if (++this.gcCounter % 8 && this.assets.tiles.size < 4096) return;
    this.session.collectTiles(extra);
  }
  editLayer(label: string, edit: (l: Layer) => void, operation: LockOperation = 'all') {
    if (!this.layer) return;
    if (this.selectedIds.size > 1) {
      this.message('Select a single layer for this adjustment.');
      return;
    }
    if (layerLock(this.doc.layers, this.selected, operation)) {
      this.message('Unlock this layer to edit it.');
      return;
    }
    this.command(label, (d) => {
      const l = findLayer(d.layers, this.selected);
      if (l) edit(l);
    });
  }
  /** Bake pending pixel-layer moves (origin shift) and transforms (resample). */
  normalizePixelLayers(doc: PhotoDocument, assets: Assets) {
    for (const l of allLayers(doc.layers)) {
      if (l.textData) bakeTextScale(l);
      if (l.kind !== 'pixel' || !l.pixels) continue;
      const kind = pixelTransformKind(l);
      if (kind === 'translate') commitPixelTranslation(l);
      else if (kind === 'resample') commitPixelResample(l, assets.tiles, doc);
      else if (!l.pixels.bounds) syncPixelTransform(l, doc);
    }
  }
  async render(doc = this.doc) {
    if (!this.renderer) return;
    await this.renderer.render(doc, this.assets);
    // Startup measurements (docs/performance.md) look for the first document frame.
    if (this.hasDocument && !this.firstFrame) {
      this.firstFrame = true;
      performance.mark('photo-studio:first-document');
    }
  }
  private firstFrame = false;
  preview(doc: PhotoDocument) {
    this.lastDoc = doc;
    if (this.renderFrame) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      const d = this.lastDoc;
      if (d) void this.render(d).catch((e) => this.message(String(e)));
    });
  }
  /** Document shown on canvas: an active transform's draft or the current state. */
  get displayDoc() {
    return this.transform.document ?? this.modal?.document ?? this.doc;
  }
  update() {
    const display = this.displayDoc;
    const ids = [...this.selectedIds].filter((id) => findLayer(this.doc.layers, id));
    this.selectLayers(ids.length || !this.selectedIds.size ? ids : this.doc.layers.slice(-1).map((l) => l.id));
    if (this.editingMask && this.layer && !this.layer.maskGrid && !this.layer.pixelMask && !this.layer.mask && !this.layer.maskAsset && !this.layer.maskStrokes)
      this.maskTarget = '';
    const depth = this.doc.bitsPerChannel ?? 8;
    this.el('#tab-size').textContent = `${this.doc.width} × ${this.doc.height} px`;
    this.el('.canvas-color-mode').textContent = `${this.colorModeLabel} / ${depth}`;
    this.el('#empty').hidden = this.hasDocument;
    this.root.classList.toggle('no-document', !this.hasDocument);
    this.windows.renderTabs();
    this.options();
    this.toolbar?.render();
    this.syncColorChips();
    this.view();
    this.overlay();
    this.dock?.update();
    for (const hook of this.updateHooks) hook(this);
    this.preview(display);
  }
  get colorModeLabel() {
    return modeLabel(this.doc);
  }
  // Extra text for document tabs (for example the color feature's proof name).
  tabBadges: ((s: DocumentSession) => string)[] = [];
  options() {
    const tool = this.activeTool;
    this.el('#tool-name').textContent = tool?.label ?? '';
    this.el('#tool-icon').innerHTML = tool ? svg(tool.icon, 18) : '';
    const el = this.el('#tool-options');
    let html = '';
    if (this.transform.active)
      html = `<span class="transform-label">Free Transform</span><label class="transform-setting"><input id="transform-proportions" type="checkbox" ${this.transform.shared || this.transform.proportional ? 'checked' : ''} ${this.transform.shared ? 'disabled' : ''}>Proportions</label><label class="transform-setting"><input id="transform-snap" type="checkbox" ${this.transform.snapping ? 'checked' : ''}>Snap</label><button data-command="edit.transform-cancel" class="icon-button" title="Cancel transform (Escape)" aria-label="Cancel">${svg('ban', 16)}</button><button data-command="edit.transform-commit" class="icon-button transform-apply" title="Commit transform (Enter)" aria-label="Apply">${svg('check', 16)}</button>`;
    else html = tool?.options?.(this) ?? '';
    el.innerHTML = html;
    if (!this.transform.active) tool?.bindOptions?.({ e: this, el });
    this.el('#viewport').dataset.tool = this.tool;
    this.el('#viewport').style.cursor = this.cursorFor ? this.cursorFor(tool) : (tool?.cursor?.(this) ?? '');
  }
  // The viewport cursor for a tool (Preferences → Cursors).
  cursorFor?: (tool: Tool | undefined) => string;
  setTool(id: string) {
    if (!tools.has(id)) return;
    if (this.transform.dragging && !this.transform.active) this.transform.cancel();
    if (id !== this.tool) this.transform.apply();
    this.activeTool?.deactivate?.(this);
    this.tool = id;
    this.toolbar?.select(id);
    this.activeTool?.activate?.(this);
    this.options();
    this.toolbar?.render();
    this.overlay();
    // Tool-dependent panels (brush settings, character) follow the active tool.
    this.dock?.update();
    emitActivity({ kind: 'tool', id });
  }
  // ----- Colors -----
  setForeground(hex: string) {
    this.color = hex;
    this.colorControls?.sync(hex);
    this.el<HTMLInputElement>('#foreground').value = hex;
    this.syncColorChips();
    this.dock?.update();
  }
  setBackground(hex: string) {
    this.background = hex;
    this.syncColorChips();
    this.dock?.update();
  }
  private syncColorChips() {
    this.el('.fg-chip').style.background = this.color;
    this.el('.bg-chip').style.background = this.background;
  }
  // ----- View -----
  /** Size of the active window's image area in CSS pixels. */
  viewportSize() {
    const r = this.el('#viewport').getBoundingClientRect();
    return { width: r.width || 800, height: r.height || 600 };
  }
  fit(view = this.activeView) {
    const size = view === this.activeView ? this.viewportSize() : this.windows.viewportSize(view);
    const doc = view.session.doc;
    view.zoom = fitZoom({ rotation: view.rotation, aspect: this.viewAspect(view.session) }, doc, size);
    view.pan = { x: 0, y: 0 };
    this.view();
    this.overlay();
  }
  zoomAt(z: number, vx?: number, vy?: number) {
    const next = zoomAround(this.activeView.state(), z, this.viewportSize(), vx, vy);
    this.zoom = next.zoom;
    this.pan = next.pan;
    this.view();
    this.overlay();
    this.windows.renderTabs();
  }
  private zoomAnimation = 0;
  /** Zoom from a command or a click: animated (General → Animated zoom), and
   * resizing a floating window to the image (Zoom resizes floating windows).
   * With `centerOn`, that document point moves to the window center. */
  zoomBy(z: number, vx?: number, vy?: number, centerOn?: [number, number]) {
    cancelAnimationFrame(this.zoomAnimation);
    const target = Math.max(0.01, Math.min(64, z));
    const from = this.zoom,
      c0 = centerPoint(this.activeView.state(this.viewAspect()), this.doc);
    const apply = (k: number) => {
      const zoom = from * (target / from) ** k;
      if (!centerOn) return this.zoomAt(zoom, vx, vy);
      const c: [number, number] = [c0[0] + (centerOn[0] - c0[0]) * k, c0[1] + (centerOn[1] - c0[1]) * k];
      this.zoom = zoom;
      this.pan = panToCenter(this.activeView.state(this.viewAspect()), this.doc, c[0], c[1]);
      this.view();
      this.overlay();
      this.windows.renderTabs();
    };
    const done = () => {
      if (this.preferences.zoomResizesWindows && this.activeView.floating) this.windows.fitFloating(this.activeView);
    };
    if (!this.preferences.animatedZoom || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      apply(1);
      return done();
    }
    const start = performance.now(),
      duration = 150;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      apply(1 - (1 - t) ** 3);
      if (t < 1) this.zoomAnimation = requestAnimationFrame(step);
      else done();
    };
    this.zoomAnimation = requestAnimationFrame(step);
  }
  /** Document → viewport-local matrix of the active window. */
  viewMatrix() {
    return viewMatrix(this.activeView.state(this.viewAspect()), this.doc, this.viewportSize());
  }
  /** Document coordinates of a client point. */
  docPoint(clientX: number, clientY: number): [number, number] {
    const rect = this.el('#viewport').getBoundingClientRect();
    const m = this.viewMatrix(),
      x = clientX - rect.left,
      y = clientY - rect.top;
    // Unrotated views divide directly, so whole pixels stay exact.
    if (!m[1] && !m[2]) return [(x - m[4]) / m[0], (y - m[5]) / m[3]];
    return applyAffine(invertAffine(m), x, y);
  }
  /** Client coordinates of a document point. */
  clientPoint(x: number, y: number): [number, number] {
    const rect = this.el('#viewport').getBoundingClientRect();
    const [px, py] = applyAffine(this.viewMatrix(), x, y);
    return [rect.left + px, rect.top + py];
  }
  /** Tools → Overscroll off: keep the image inside the window (centered
   * along an axis where it is smaller than the window). */
  private clampPan() {
    const size = this.viewportSize(),
      m = this.viewMatrix(),
      W = this.doc.width,
      H = this.doc.height;
    const pts = [applyAffine(m, 0, 0), applyAffine(m, W, 0), applyAffine(m, 0, H), applyAffine(m, W, H)];
    const fit = (lo: number, hi: number, span: number) => (hi - lo <= span ? (span - (hi - lo)) / 2 - lo : lo > 0 ? -lo : hi < span ? span - hi : 0);
    const dx = fit(Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0])), size.width);
    const dy = fit(Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1])), size.height);
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) this.pan = { x: this.pan.x + dx, y: this.pan.y + dy };
  }
  view() {
    if (!this.preferences.overscroll && this.hasDocument) this.clampPan();
    const stage = this.el('#stage');
    stage.style.width = `${this.doc.width}px`;
    stage.style.height = `${this.doc.height}px`;
    const aspect = this.viewAspect();
    stage.style.transform = stageTransform(this.activeView.state(aspect));
    // Nearest-neighbour magnification shows individual pixels when zoomed in.
    stage.classList.toggle('pixelated', this.zoom * Math.min(1, aspect) >= 2);
    this.root.classList.toggle('view-rotated', !!this.rotation || this.activeView.flip);
    const zoomField = this.el<HTMLInputElement>('#zoom-label');
    if (document.activeElement !== zoomField) zoomField.value = `${Math.round(this.zoom * 1000) / 10}%`;
    const zoomTab = this.root.querySelector('#tab-zoom');
    if (zoomTab) zoomTab.textContent = `@ ${Math.round(this.zoom * 100)}%`;
    const viewport = this.el('#viewport');
    this.root.classList.toggle('rulers-hidden', !this.preferences.showRulers);
    if (this.preferences.showRulers) {
      const unit = rulerUnitScale(this.doc, this.preferences.rulerUnits);
      setMarkup(this.el('#ruler-x'), rulerTicks(viewport.clientWidth, viewport.clientWidth / 2 + this.pan.x - (this.doc.width * this.zoom * aspect) / 2, this.zoom * aspect, false, unit.x));
      setMarkup(this.el('#ruler-y'), rulerTicks(viewport.clientHeight, viewport.clientHeight / 2 + this.pan.y - (this.doc.height * this.zoom) / 2, this.zoom, true, unit.y));
    }
    this.screenOverlay();
    for (const hook of this.viewHooks) hook(this);
  }
  // Called after the view changes (zoom, scroll, rotation, window size).
  viewHooks: ((e: Editor) => void)[] = [];
  overlay(doc = this.displayDoc) {
    const svgEl = this.root.querySelector<SVGSVGElement>('#overlay')!;
    svgEl.setAttribute('viewBox', `0 0 ${doc.width} ${doc.height}`);
    let html = '';
    for (const draw of overlays.values()) {
      try {
        html += draw(this);
      } catch (error) {
        console.error(error);
      }
    }
    html += this.activeTool?.overlay?.(this) ?? '';
    html += this.transform.overlay(doc);
    setMarkup(svgEl, html);
  }
  // Screen-space overlay (fixed pixel sizes regardless of zoom): brush cursors.
  screenOverlayContent = '';
  screenOverlay() {
    const el = this.root.querySelector<SVGSVGElement>('#screen-overlay');
    if (el) setMarkup(el, this.screenOverlayContent);
  }
  pointerInfo?: CanvasPointer;
  updatePointerInfo(p: CanvasPointer | undefined) {
    this.pointerInfo = p;
    const el = this.el('#pointer-info');
    el.textContent = p ? `X ${Math.floor(p.x)}  Y ${Math.floor(p.y)}` : '';
    for (const hook of this.pointerHooks) hook(this, p);
  }
  pointerHooks: ((e: Editor, p: CanvasPointer | undefined) => void)[] = [];
  // Run after preferences change (features/preferences applies them).
  preferenceHooks: ((e: Editor) => void)[] = [];
  savePreferences() {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(this.preferences));
    } catch {
      /* Optional. */
    }
  }
  /** Save and apply changed preferences. */
  preferencesChanged() {
    this.savePreferences();
    for (const hook of this.preferenceHooks) hook(this);
    this.update();
  }
  // ----- Input -----
  private bind() {
    watchOptionTips(this.el('#tool-options'));
    this.root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const close = target.closest<HTMLElement>('[data-close-view]');
      if (close) {
        const v = this.views.find((x) => x.id === close.dataset.closeView);
        if (v) void this.closeView(v);
        e.stopPropagation();
        return;
      }
      const tab = target.closest<HTMLElement>('[data-view]');
      if (tab) {
        const v = this.views.find((x) => x.id === tab.dataset.view);
        if (v) void this.activateView(v);
        return;
      }
      if (this.busy) return;
      const cmd = target.closest<HTMLElement>('[data-command]');
      if (cmd && !target.closest('.menubar,.context-menu') && !(cmd as HTMLButtonElement).disabled) {
        void this.runCommand(cmd.dataset.command!, cmd.dataset.arg);
        return;
      }
    });
    this.root.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'transform-proportions') this.transform.proportional = t.checked;
      if (t.id === 'transform-snap') this.transform.snapping = t.checked;
      if (t.id === 'theme') this.setTheme(t.value);
    });
    this.el<HTMLInputElement>('#foreground').addEventListener('input', (e) => this.setForeground((e.target as HTMLInputElement).value));
    this.el<HTMLInputElement>('#file-input').onchange = (e) => {
      const input = e.target as HTMLInputElement;
      const files = Array.from(input.files ?? []);
      input.value = '';
      void this.run(async () => {
        const { openFile } = await import('./features/files/open');
        for (const file of files) await openFile(this, file, file.name);
      });
    };
    const viewport = this.el('#viewport');
    const workspace = this.el('.workspace');
    workspace.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      // Load the decoders while a file is dragged over the workspace.
      import('./features/files/open').catch(() => {});
      e.preventDefault();
      viewport.classList.add('dragover');
    });
    workspace.addEventListener('dragleave', () => viewport.classList.remove('dragover'));
    workspace.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      viewport.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files);
      // Dropping onto the canvas places files into the open document.
      const place = this.hasDocument && !!(e.target as HTMLElement).closest('#viewport');
      void this.run(async () => {
        const { openFile } = await import('./features/files/open');
        for (const f of files) await openFile(this, f, f.name, place);
      });
    });
    viewport.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void import('./app/menubar').then(({ showContextMenu }) => showContextMenu(this, e.clientX, e.clientY, this.canvasContextMenu()));
    });
    document.addEventListener('keydown', (e) => this.keyDown(e));
    // Window resizes, panel changes and document window layouts all resize the viewport.
    new ResizeObserver(() => {
      this.view();
      this.overlay();
    }).observe(viewport);
    window.addEventListener('beforeunload', (e) => {
      if (import.meta.env.DEV) return;
      if (this.sessions.some((s) => s.dirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.setTheme(this.preferences.theme);
  }
  canvasContextMenu() {
    const items: string[] = [];
    if (this.doc.selectionMask || this.doc.selection)
      items.push('select.deselect', 'select.inverse', 'select.modify-feather', 'select.mask-refine', '-', 'select.save', 'edit.via-copy', 'layer.via-copy', 'layer.via-cut', '-', 'edit.fill', 'edit.stroke', 'edit.context-fill', '-', 'edit.free-transform', 'select.transform-selection');
    else items.push('select.all', 'select.reselect', '-', 'layer.new', 'layer.duplicate', '-', 'edit.free-transform', 'layer.merge-down', 'layer.flatten');
    return items;
  }
  setTheme(theme: string) {
    if (!['dark', 'medium', 'light', 'system'].includes(theme)) return;
    document.documentElement.dataset.theme = theme;
    this.el<HTMLSelectElement>('#theme').value = theme;
    if (this.preferences.theme === theme) return;
    this.preferences.theme = theme as Preferences['theme'];
    this.preferencesChanged();
  }
  private keyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (this.menubar?.isOpen && target.closest('.menubar')) return;
    if (this.transform.active && target.matches('#transform-proportions,#transform-snap') && ['Enter', 'Escape'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'Escape') this.transform.cancel();
      else this.transform.apply();
      this.el('#viewport').focus({ preventScroll: true });
      return;
    }
    const typing = !!target.closest('input,textarea,select,[contenteditable="true"],[role="slider"]');
    if (target.closest('dialog')) return;
    const shortcut = eventShortcut(e);
    // Modified shortcuts work while typing in numeric fields; bare keys never do.
    if (typing && (!shortcut.startsWith('Mod+') || target.closest('textarea,[contenteditable="true"]'))) return;
    if (this.busy) return;
    if (this.activeTool?.keyDown?.(this, e)) {
      e.preventDefault();
      return;
    }
    if ((this.transform.active || this.transform.dragging) && (e.key === 'Escape' || (e.key === 'Enter' && !target.closest('button')))) {
      e.preventDefault();
      if (e.key === 'Escape') this.transform.cancel();
      else this.transform.apply();
      return;
    }
    if (this.tool === 'move' && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.startsWith('Arrow')) {
      e.preventDefault();
      if (!this.transform.dragging) {
        const step = e.shiftKey ? 10 : 1;
        this.transform.nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      }
      return;
    }
    const matches = [...commands.values()].filter((c) => {
      const list = Array.isArray(c.shortcut) ? c.shortcut : c.shortcut ? [c.shortcut] : [];
      return list.some((s) => platformShortcut(s) === shortcut);
    });
    if (matches.length) {
      e.preventDefault();
      // A shortcut shared by commands for different situations runs the one that applies.
      const c = matches.find((m) => !m.enabled || m.enabled(this)) ?? matches[0];
      void this.runCommand(c.id);
      return;
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[A-Z]$/.test(shortcut.replace('Shift+', '')) && this.toolbar.shortcut(shortcut.replace('Shift+', ''), e.shiftKey)) {
      e.preventDefault();
      return;
    }
    // [ and ] change the brush size of brush-like tools, with Shift the hardness.
    const brush = this.activeTool?.brush;
    if (brush && !e.metaKey && !e.ctrlKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      e.preventDefault();
      const up = e.code === 'BracketRight';
      const b = brush.get(this);
      if (e.shiftKey) brush.set(this, { hardness: Math.max(0, Math.min(1, b.hardness + (up ? 0.25 : -0.25))) });
      else brush.set(this, { size: brushSizeStep(b.size, up) });
      return;
    }
    // Number keys set the opacity of painting tools or the selected layers:
    // 1–9 for 10–90%, 0 for 100%, two digits typed quickly for an exact value.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && /^Digit\d$/.test(e.code)) {
      const n = Number(e.code.slice(5));
      const now = performance.now();
      const quick = this.digit && now - this.digit.at < 700;
      const percent = quick ? this.digit!.n * 10 + n : n === 0 ? 100 : n * 10;
      this.digit = quick ? undefined : { n, at: now };
      const hook = this.settings.numberKey as ((value: number, shift: boolean) => boolean) | undefined;
      if (hook) {
        if (hook(percent / 100, e.shiftKey)) e.preventDefault();
      } else if (!e.shiftKey && this.hasDocument && this.selectedIds.size) {
        e.preventDefault();
        void this.runCommand('layer.set-opacity', percent / 100);
      }
    }
  }
  // The last number key, for two-digit opacity values.
  private digit?: { n: number; at: number };
}

// Markup last written by setMarkup, per element. Most updates redraw rulers
// and overlays with identical markup; skipping those avoids re-parsing SVG.
const markup = new WeakMap<Element, string>();
function setMarkup(el: Element, html: string) {
  if (markup.get(el) === html) return;
  markup.set(el, html);
  el.innerHTML = html;
}

/** Stored preferences, upgraded from older storage keys. */
function readPreferences(): Preferences {
  const get = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const prefs = loadPreferences(get(PREFERENCES_KEY), { theme: get('photo-theme'), fontPreview: get('photo-studio-font-preview-size') });
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
    localStorage.removeItem('photo-theme');
    localStorage.removeItem('photo-studio-font-preview-size');
  } catch {
    /* Preferences are optional. */
  }
  return prefs;
}
