/**
 * The application: one open project (document + scene), its open views,
 * the selection, the active tool, panels, settings and file handling.
 */
import { buildShell, buildCube } from './ui/shell.js';
import { Ribbon } from './ui/ribbon.js';
import { contextualPanels, GROUP_EDIT_PANEL } from './ui/ribbon-def.js';
import { PropertiesPanel, pluralLabel } from './ui/properties.js';
import { ProjectBrowser } from './ui/browser.js';
import { installTooltips, hideTooltip, setTooltipMode } from './ui/tooltip.js';
import * as options from './ui/options.js';
import { showMenu, closeMenus } from './ui/menu.js';
import { toast, confirmDialog, promptDialog } from './ui/dialog.js';
import { h, clear, MOD } from './ui/dom.js';
import { icon, KIND_ICON } from './ui/icons.js';
import { COMMANDS, applyShortcuts } from './commands.js';
import { Scene, MODEL_KINDS } from './core/scene.js';
import { createProject, default3DView, upgradeDoc } from './core/template.js';
import { createSampleProject } from './core/sample.js';
import { isView, newId, PLAN_VIEW_KINDS, isPlanView } from './core/doc.js';
import { defaultCrop } from './core/props.js';
import { categoryOf, defaultTypeFor } from './core/catalog.js';
import { describe as describeEl } from './core/props.js';
import { formatArea, formatLength, parseLength } from './core/units.js';
import { temporaryDimensions } from './editor/tempdims.js';
import { drawTempDim } from './views/overlay.js';
import { deleteElements, moveElements, uniqueName, expandGroups } from './core/ops.js';
import { groupable, createGroup, propagateGroup, ungroup } from './core/groups.js';
import { viewGraphics, hiddenByFilters, templateSettings, templateKindOf } from './core/graphics.js';
import { phaseLook, phased } from './core/phases.js';
import { Viewport } from './views/viewport.js';
import { PlanController } from './views/plan.js';
import { ModelController } from './views/model.js';
import { ScheduleController } from './views/schedule.js';
import { SheetController } from './views/sheet.js';
import { SelectTool } from './editor/select.js';
import { SketchTool, createLevel } from './editor/draw.js';
import { FLAG } from './render/gl.js';
import { pointInPolygon as insidePolygon } from './core/geom.js';
import * as dialogs from './ui/dialogs.js';
import * as files from './io/files.js';
import {
  isSignedIn,
  getUser,
  signIn,
  signOut,
  canSignOut,
  whenPuter,
  cachedProfilePicture,
  fetchProfilePicture,
  clearProfilePicture,
  puterAvailable,
} from './platform.js';
import { renderViewbar } from './ui/viewbar.js';
import { renderHome } from './ui/home.js';
import { Settings } from './settings.js';
import { SyncManager } from './io/sync.js';
import { worksharingOn, worksetable, worksets, defaultWorkset, DATUM_KINDS } from './core/worksets.js';
import { setEditingOption, editingOption, optionable, optionLabel, optionSets, optionsOf } from './core/designopts.js';

const PLAN_KINDS = new Set(PLAN_VIEW_KINDS);

export class App {
  constructor(root) {
    this.root = root;
    this.doc = null;
    this.scene = null;
    this.selection = new Set();
    this.hoverId = null;
    this.tool = null;
    this.openViews = [];
    this.activeViewId = null;
    this.controllers = new Map();
    this.viewStates = new Map();
    this.currentTypes = new Map();
    this.toolOpts = new Map();
    this.temp = new Map();
    this.reveal = new Set();
    this.keyBuffer = '';
    this.navMode = null;
    this.clipboard = null;
    this.file = null;
    this.settingsStore = new Settings();
    this.flagsVersion = 0;
    this.sync = new SyncManager(this);
    this.activeWorksetId = null;
  }

  get settings() {
    return this.settingsStore.values;
  }

  get activeView() {
    return this.doc?.get(this.activeViewId) ?? null;
  }

  get vc() {
    return this.controllers.get(this.activeViewId) ?? null;
  }

  // Startup ------------------------------------------------------------------------------

  async start() {
    this.settingsStore.load();
    this.applyPreferences();
    this.applyTheme();
    this.shell = buildShell(this);
    this.ribbon = new Ribbon(this);
    this.shell.root.querySelector('.ribbon-slot').replaceWith(this.ribbon.el);
    this.root.append(this.shell.root);
    buildCube(this, this.shell.cubeInner, this.shell.viewcube);
    installTooltips(document);
    this.props = new PropertiesPanel(this, this.shell.propsBody);
    this.browser = new ProjectBrowser(this, this.shell.browserBody, this.shell.browserSearch);
    this.viewport = new Viewport(this, this.shell.canvasWrap, this.shell.glCanvas, this.shell.overlay);
    this.bindKeys();
    this.bindDock();
    this.sync.on(() => this.renderCollab());
    this.buildPhonebar();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    window.addEventListener('beforeunload', (e) => {
      if (this.doc?.modified && this.file?.source !== 'local') {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.renderAccount();
    const params = new URLSearchParams(location.search);
    const recovered = params.has('sample') ? false : await files.recover(this);
    if (params.has('sample')) this.openSample();
    else if (!recovered) this.showHome();
    whenPuter().then(async (ok) => {
      if (!ok) return;
      this.renderAccount();
      await this.settingsStore.syncFromCloud();
      this.applyPreferences();
      this.ribbon.renderBody();
      this.applyTheme();
      files.handleLaunchItems(this);
    });
  }

  fatal(message, err) {
    console.error(err);
    toast(message, { kind: 'error', timeout: 0 });
  }

  toast(msg, opts) {
    return toast(msg, opts);
  }

  // Document --------------------------------------------------------------------------------

  setDoc(doc, file = null) {
    this.cancelTool(true);
    for (const c of this.controllers.values()) c.dispose?.();
    this.controllers.clear();
    this.viewStates.clear();
    this.scene?.dispose();
    this.viewport.r3.clear();
    this.viewport.r3.origin = [0, 0, 0];
    this.originSet = false;
    upgradeDoc(doc);
    this.groupEdit = null;
    // New model elements belong to the phase of the view they are drawn in.
    doc.addHooks = [
      (item) => (!item.phaseId && phased(item) && this.activeView?.phaseId ? { phaseId: this.activeView.phaseId } : null),
      // ...and to the active workset of whoever draws them.
      // ...and to the design option being edited.
      (item) => (!item.optionId && editingOption() && doc.has(editingOption()) && optionable(doc, item) ? { optionId: editingOption() } : null),
      (item) => (!item.worksetId && worksharingOn(doc) && worksetable(doc, item) ? { worksetId: DATUM_KINDS.has(item.kind) ? worksets(doc).find((w) => w.shared)?.id ?? this.activeWorkset()?.id : this.activeWorkset()?.id } : null),
    ];
    this.doc = doc;
    this.file = file;
    this.docId = file?.recoveryId || newId('doc');
    this.scene = new Scene(doc);
    this.selection.clear();
    this.hoverId = null;
    this.temp.clear();
    this.reveal.clear();
    this.modelVersion = -1;
    this.currentTypes.clear();
    this.openViews = [];
    this.activeViewId = null;
    doc.on((ev) => this.docChanged(ev));
    const start = doc.get(doc.get('project')?.startViewId);
    const first = (isView(start) ? start : null) || doc.all('plan').sort((a, b) => (doc.get(a.levelId)?.elevation ?? 0) - (doc.get(b.levelId)?.elevation ?? 0))[0] || doc.all('view3d')[0];
    if (first) this.openView(first.id);
    this.renderBrowser();
    this.updateTitle();
    this.props.render();
    this.ribbon.refresh();
    this.setPrompt('Ready');
    files.scheduleRecovery(this);
    this.activeWorksetId = null;
    setEditingOption(null);
    this.sync.attach(null, null, doc.modified);
    this.renderCollab();
  }

  // Collaboration --------------------------------------------------------------------------------

  activeWorkset() {
    const w = this.doc?.get(this.activeWorksetId);
    return w?.kind === 'workset' ? w : defaultWorkset(this.doc);
  }

  setActiveWorkset(id) {
    this.activeWorksetId = id;
    this.renderCollab();
  }

  /** Edit a design option (null: the main model). Every view shows the option being edited. */
  editOption(id) {
    setEditingOption(id && this.doc.has(id) ? id : null);
    this.scene.version++;
    this.flagsVersion++;
    this.renderCollab();
    this.ribbon.refresh();
    this.requestRender();
    this.setPrompt(id ? `Editing ${optionLabel(this.doc, id)}. New elements go into this option.` : 'Editing the main model.');
  }

  /** Synchronizing needs the project in the cloud; offer to put it there. */
  async requireShared() {
    if (this.sync.active) return true;
    const ok = await confirmDialog('Save to Puter first', 'Working together needs the project in your Puter cloud storage. Save it there now? You can then share it with Share Project.', { confirm: 'Save to Puter' });
    if (ok) await this.saveAs();
    return this.sync.active;
  }

  /** Status bar: synchronization state and the active workset. */
  renderCollab() {
    const sb = this.shell?.syncBtn;
    if (!sb || !this.doc) return;
    const st = this.sync.state;
    sb.hidden = st === 'off';
    const label = { synced: 'Up to date', pending: 'Changes to share', syncing: 'Synchronizing...', offline: 'Offline' }[st] || '';
    clear(sb);
    sb.append(icon(st === 'offline' ? 'cloud-off' : st === 'syncing' ? 'refresh' : 'cloud', 14), h('span', label));
    sb.dataset.state = st;
    sb.setAttribute('data-tip-desc', st === 'pending' ? 'Click to synchronize: bring in others\' changes and share yours' : 'Changes others save appear automatically. Click to synchronize now.');
    const opt = this.shell.optSelect;
    const sets = optionSets(this.doc);
    opt.parentElement.hidden = !sets.length;
    if (sets.length) {
      clear(opt);
      opt.append(h('option', { value: '' }, 'Main Model'));
      for (const set of sets) opt.append(h('optgroup', { label: set.name }, optionsOf(this.doc, set.id).map((o) => h('option', { value: o.id }, `${o.name}${o.primary ? ' (primary)' : ''}`))));
      opt.value = editingOption() && this.doc.has(editingOption()) ? editingOption() : '';
      opt.parentElement.classList.toggle('active', !!opt.value);
    }
    const ws = this.shell.wsSelect;
    const on = worksharingOn(this.doc);
    ws.parentElement.hidden = !on;
    if (on) {
      clear(ws);
      for (const w of worksets(this.doc)) ws.append(h('option', { value: w.id }, w.name));
      ws.value = this.activeWorkset()?.id ?? '';
    }
  }

  docChanged(ev) {
    if (!ev.preview && this.sync.active && !ev.remote && this.sync.state === 'synced') this.sync.setState('pending');
    if (!ev.preview && [...ev.ids].some((id) => ['workset', 'optionSet', 'designOption'].includes(this.doc.get(id)?.kind) || !this.doc.has(id))) this.renderCollab();
    // Selection may refer to deleted items.
    let selChanged = false;
    for (const id of [...this.selection])
      if (!this.doc.has(id)) {
        this.selection.delete(id);
        selChanged = true;
      }
    // Views closed when deleted.
    for (const id of [...this.openViews]) if (!this.doc.has(id)) this.closeView(id, true);
    if (!ev.preview) {
      this.scene.prune();
      this.renderBrowser();
      this.props.render();
      this.ribbon.refresh();
      this.updateTitle();
      this.renderViewbar();
      files.scheduleRecovery(this);
    }
    if (selChanged) this.selectionChanged();
    this.flagsVersion++;
    this.requestRender();
  }

  undo() {
    if (this.tool && !(this.tool instanceof SelectTool)) this.cancelTool();
    const label = this.doc.undo();
    if (label) this.setPrompt(`Undid: ${label}`);
  }

  redo() {
    const label = this.doc.redo();
    if (label) this.setPrompt(`Redid: ${label}`);
  }

  /** Run fn in a transaction; errors become a toast. Returns fn's result. */
  commit(label, fn) {
    try {
      return this.doc.transact(label, fn);
    } catch (err) {
      console.error(err);
      toast(`Could not complete "${label}": ${err.message || err}`, { kind: 'error' });
      return undefined;
    }
  }

  // Views -----------------------------------------------------------------------------------

  controllerFor(view) {
    let c = this.controllers.get(view.id);
    if (c) return c;
    if (PLAN_KINDS.has(view.kind) || view.kind === 'drafting' || view.kind === 'legend') c = new PlanController(this, view);
    else if (view.kind === 'view3d' || view.kind === 'elevation' || view.kind === 'section') c = new ModelController(this, view);
    else if (view.kind === 'schedule') c = new ScheduleController(this, view);
    else if (view.kind === 'sheet') c = new SheetController(this, view);
    else return null;
    this.controllers.set(view.id, c);
    return c;
  }

  openView(id) {
    const view = this.doc.get(id);
    if (!view || !isView(view)) return;
    if (!this.openViews.includes(id)) this.openViews.push(id);
    this.activateView(id);
  }

  activateView(id) {
    const view = this.doc.get(id);
    if (!view) return;
    const prev = this.vc;
    if (this.tool && !(this.tool instanceof SelectTool)) {
      const kinds = this.tool.viewKinds;
      if (kinds && !kinds.includes(view.kind)) this.cancelTool(true);
    }
    this.activeViewId = id;
    const c = this.controllerFor(view);
    if (prev && prev !== c) prev.deactivate?.();
    const graphical = !!c?.graphical;
    this.shell.domView.hidden = graphical;
    this.viewport.setController(graphical ? c : null);
    if (!graphical) {
      this.shell.viewcube.hidden = true;
      c?.mount(this.shell.domView);
    }
    this.renderNav();
    this.renderTabs();
    this.renderViewbar();
    this.renderBrowser();
    this.props.render();
    this.updateTitle();
    this.flagsVersion++;
    this.requestRender();
    this.ribbon.refresh();
  }

  closeView(id, silent = false) {
    const i = this.openViews.indexOf(id);
    if (i < 0) return;
    this.openViews.splice(i, 1);
    const c = this.controllers.get(id);
    if (c) {
      c.deactivate?.();
      c.dispose?.();
      this.controllers.delete(id);
    }
    if (this.activeViewId === id) {
      const next = this.openViews[Math.min(i, this.openViews.length - 1)];
      if (next) this.activateView(next);
      else {
        this.activeViewId = null;
        this.viewport.setController(null);
        this.showHome(true);
      }
    } else if (!silent) this.renderTabs();
    this.renderTabs();
  }

  closeInactiveViews() {
    for (const id of [...this.openViews]) if (id !== this.activeViewId) this.closeView(id, true);
    this.renderTabs();
  }

  cycleView(dir) {
    if (this.openViews.length < 2) return;
    const i = this.openViews.indexOf(this.activeViewId);
    this.activateView(this.openViews[(i + dir + this.openViews.length) % this.openViews.length]);
  }

  selectViewInBrowser(view) {
    // A single click on a view shows its properties without opening it.
    this.browserViewSel = view.id;
  }

  renderTabs() {
    const el = this.shell.vtabs;
    clear(el);
    this.openViews.forEach((id, i) => {
      const v = this.doc?.get(id);
      if (!v) return;
      const active = id === this.activeViewId;
      el.append(
        h(
          `div.vtab${active ? '.active' : ''}`,
          { role: 'presentation' },
          h(
            'button.vtab-btn',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': String(active),
              tabindex: active ? '0' : '-1',
              title: v.name,
              onClick: () => this.activateView(id),
              onAuxclick: (e) => e.button === 1 && this.closeView(id),
              onKeydown: (e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  const j = (i + (e.key === 'ArrowRight' ? 1 : -1) + this.openViews.length) % this.openViews.length;
                  this.activateView(this.openViews[j]);
                  requestAnimationFrame(() => el.querySelector('.vtab.active .vtab-btn')?.focus());
                } else if (e.key === 'Delete') {
                  e.preventDefault();
                  e.stopPropagation();
                  this.closeView(id);
                }
              },
              onContextmenu: (e) => {
                e.preventDefault();
                showMenu({ x: e.clientX, y: e.clientY }, [
                  { label: 'Close', icon: 'x', action: () => this.closeView(id) },
                  { label: 'Close Inactive Views', icon: 'closeHidden', action: () => this.closeInactiveViews() },
                ]);
              },
            },
            icon(KIND_ICON[v.kind] || 'file', 14),
            h('span.vtab-name', this.viewName(v)),
          ),
          h('button.icon-btn.sm.vtab-close', { type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: `Close ${v.name}`, onClick: () => this.closeView(id) }, icon('x', 13)),
        ),
      );
    });
    el.querySelector('.vtab.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  renderNav() {
    const nav = this.shell.nav;
    clear(nav);
    const c = this.vc;
    nav.hidden = !c?.graphical;
    if (!c?.graphical) return;
    nav.classList.toggle('plan', !c.is3D);
    const btn = (cmd, label, ic, onClick) => h('button.icon-btn', { type: 'button', 'aria-label': label, 'data-tip': label, onClick }, icon(ic, 17));
    nav.append(
      btn('zoomFit', 'Zoom to fit', 'zoomFit', () => this.zoomFit()),
      btn('zoomIn', 'Zoom in', 'zoom-in', () => c.zoomBy(1.5)),
      btn('zoomOut', 'Zoom out', 'zoom-out', () => c.zoomBy(1 / 1.5)),
      btn('zoomRegion', 'Zoom in region', 'zoomRegion', () => this.run('zoomRegion')),
    );
    const panBtn = btn('navPan', 'Pan with the left button or one finger', 'hand', () => this.setNavMode(this.navMode === 'pan' ? null : 'pan'));
    panBtn.setAttribute('aria-pressed', String(this.navMode === 'pan'));
    nav.append(panBtn);
    if (c.is3D) {
      const orbitBtn = btn('navOrbit', 'Orbit with the left button', 'orbit', () => this.setNavMode(this.navMode === 'orbit' ? null : 'orbit'));
      orbitBtn.setAttribute('aria-pressed', String(this.navMode === 'orbit'));
      nav.append(orbitBtn);
    }
  }

  setNavMode(m) {
    this.navMode = m;
    this.renderNav();
    this.setPrompt(m === 'pan' ? 'Pan mode: drag to pan. Click the hand again to leave.' : m === 'orbit' ? 'Orbit mode: drag to orbit. Click the button again to leave.' : 'Ready');
  }

  renderViewbar() {
    renderViewbar(this);
    this.renderBanner();
  }

  renderBanner() {
    const b = this.shell.banner;
    const t = this.temp.get(this.activeViewId);
    const reveal = this.reveal.has(this.activeViewId);
    clear(b);
    const ge = this.groupEdit;
    b.hidden = !t && !reveal && !ge;
    if (ge) {
      const type = this.doc.get(this.doc.get(ge.groupId)?.typeId);
      b.append(
        h('span', `Editing group: ${type?.name || 'Group'}`),
        h('button.btn.sm.primary', { type: 'button', onClick: () => this.finishGroupEdit(true) }, 'Finish'),
        h('button.btn.sm', { type: 'button', onClick: () => this.finishGroupEdit(false) }, 'Cancel'),
      );
    } else if (t) b.append(h('span', t.mode === 'isolate' ? 'Temporary isolate' : 'Temporary hide'), h('button.btn.sm', { type: 'button', onClick: () => this.temporary('reset') }, 'Reset'));
    else if (reveal) b.append(h('span', 'Revealing hidden elements'), h('button.btn.sm', { type: 'button', onClick: () => this.toggleReveal() }, 'Close'));
  }

  zoomFit() {
    const c = this.vc;
    if (!c) return;
    if (c.is2D) c.zoomExtents();
    else c.zoomExtents?.();
    this.viewChanged();
  }

  viewChanged() {
    const c = this.vc;
    if (c?.cam) this.viewStates.set(this.activeViewId, structuredClone(c.cam));
    this.updateCoords();
  }

  orient3D(yaw, pitch, fit = false) {
    const c = this.vc;
    if (c?.is3D) c.orient(yaw, pitch, fit);
  }

  open3D() {
    let v = this.doc.all('view3d')[0];
    if (!v) {
      v = default3DView();
      this.commit('3D view', () => this.doc.add(v));
    }
    this.openView(v.id);
  }

  new3DView() {
    const names = this.doc.all('view3d').map((v) => v.name);
    const v = { ...default3DView(uniqueName(names, '3D View 2')) };
    this.commit('New 3D view', () => this.doc.add(v));
    this.openView(v.id);
  }

  duplicateView(id, { detailing = false } = {}) {
    const v = this.doc.get(id || this.activeViewId);
    if (!v || !isView(v) || v.kind === 'schedule' || v.kind === 'sheet') return this.toast('Choose a plan, 3D view or section to duplicate.', { kind: 'error' });
    const names = this.doc.filter((x) => isView(x)).map((x) => x.name);
    const { id: _id, ...rest } = v;
    void _id;
    let copy;
    this.commit(detailing ? 'Duplicate view with detailing' : 'Duplicate view', () => {
      copy = this.doc.add({ ...rest, id: newId('v'), name: uniqueName(names, `${v.name} Copy 1`) });
      if (!detailing) return;
      for (const el of this.doc.filter((x) => x.viewId === v.id && x.kind !== 'viewport')) {
        const { id: _eid, ...er } = el;
        void _eid;
        this.doc.add({ ...er, viewId: copy.id });
      }
    });
    if (copy) this.openView(copy.id);
  }

  /** Place a raster image (PNG, JPEG, SVG...) in the active 2D view, to trace over or show. */
  importImage() {
    const v = this.activeView;
    const c = this.vc;
    if (!v || !c?.is2D || v.kind === 'sheet') return this.toast('Open a plan, drafting view or legend to place an image.', { kind: 'error' });
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml', hidden: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      if (file.size > 12e6) return this.toast('That image is larger than 12 MB. Please use a smaller one.', { kind: 'error' });
      const reader = new FileReader();
      reader.onload = () => {
        const src = String(reader.result);
        const img = new Image();
        img.onload = () => {
          // Half the visible width, centred in the view.
          const viewW = this.viewport.width / c.cam.zoom;
          const w = viewW * 0.5;
          const hh = (w * img.naturalHeight) / Math.max(1, img.naturalWidth);
          const at = [c.cam.cx - w / 2, c.cam.cy - hh / 2];
          let el;
          this.commit('Import image', () => (el = this.doc.add({ kind: 'image', viewId: v.id, at, w, h: hh, rotation: 0, opacity: 1, src, name: file.name })));
          this.select([el.id]);
          this.setPrompt('Image placed. Drag it to move, and drag its corner to scale it.');
        };
        img.onerror = () => this.toast('That file could not be read as an image.', { kind: 'error' });
        img.src = src;
      };
      reader.readAsDataURL(file);
    });
    document.body.append(input);
    input.click();
  }

  newFlatView(kind) {
    return dialogs.newFlatViewDialog(this, kind);
  }

  toggleCrop(key) {
    const v = this.activeView;
    if (!v || !isPlanView(v)) return this.toast('Crop regions are for plan views.', { kind: 'error' });
    const on = !v[key];
    this.commit(key === 'cropOn' ? 'Crop view' : 'Show crop region', () => this.doc.update(v.id, { [key]: on, ...(on && !v.crop ? { crop: defaultCrop(this, v) } : {}) }));
    this.renderViewbar();
  }

  /** The level new elements go on: the plan's level, else the first level. */
  activeLevelId() {
    const v = this.activeView;
    if (v?.levelId) return v.levelId;
    return this.lastLevelId && this.doc.has(this.lastLevelId) ? this.lastLevelId : this.doc.levels()[0]?.id;
  }

  requirePlan() {
    const v = this.activeView;
    if (v && PLAN_KINDS.has(v.kind)) return true;
    const plan = this.doc.all('plan').find((p) => p.levelId === this.activeLevelId()) || this.doc.all('plan')[0];
    if (plan) {
      this.openView(plan.id);
      this.toast(`Switched to ${plan.name}: this tool works in floor plans.`);
      return true;
    }
    return false;
  }

  // Model sync for 3D ------------------------------------------------------------------------------

  syncModel() {
    if (this.modelVersion === this.scene.version) return;
    const r3 = this.viewport.r3;
    const keep = new Set();
    for (const k of MODEL_KINDS)
      for (const el of this.doc.all(k)) {
        const m = this.scene.mesh(el);
        if (!m) continue;
        keep.add(el.id);
        r3.set(el.id, this.scene.indexOf(el.id), m);
      }
    r3.retain(keep);
    if (!this.originSet) {
      const b = r3.bounds();
      if (b) {
        // Keep vertex coordinates small near the model for float precision.
        r3.origin = [Math.round((b.min[0] + b.max[0]) / 2e4) * 1e4, Math.round((b.min[1] + b.max[1]) / 2e4) * 1e4, 0];
        for (const c of r3.chunks) c.dirty = true;
        this.originSet = true;
      }
    }
    this.modelVersion = this.scene.version;
  }

  requestRender() {
    this.viewport?.requestRender();
  }

  // Selection and highlight ----------------------------------------------------------------------------

  select(ids, mode = 'replace') {
    const before = [...this.selection].join();
    if (mode === 'replace') this.selection = new Set(ids);
    else if (mode === 'add') ids.forEach((id) => this.selection.add(id));
    else if (mode === 'remove') ids.forEach((id) => this.selection.delete(id));
    if ([...this.selection].join() !== before) this.selectionChanged();
  }

  selectionChanged() {
    this.props.filter = null;
    this.flagsVersion++;
    this.props.render();
    this.updateContextual();
    this.updateSelInfo();
    this.ribbon.refresh();
    if (this.tool instanceof SelectTool || !this.tool) this.setPrompt(this.tool?.prompt || 'Ready');
    this.requestRender();
  }

  refreshSelection() {
    this.props.render();
    this.requestRender();
  }

  updateContextual() {
    if (this.tool && !(this.tool instanceof SelectTool)) {
      this.ribbon.setContextual({ id: `tool-${this.tool.constructor.name}`, label: `Modify | ${this.tool.title}`, panels: contextualPanels([]).slice(1, 2) });
      return;
    }
    const sel = [...this.selection].map((id) => this.doc.get(id)).filter(Boolean);
    const groupPanel = this.groupEdit ? [GROUP_EDIT_PANEL] : [];
    if (!sel.length) return this.ribbon.setContextual(this.groupEdit ? { id: 'ctx-groupedit', label: 'Modify | Edit Group', panels: groupPanel } : null);
    const kinds = [...new Set(sel.map((e) => e.kind))];
    const label = kinds.length === 1 ? pluralLabel(kinds[0]) : 'Multi-Select';
    this.ribbon.setContextual({ id: `ctx-${kinds.length === 1 ? kinds[0] : 'multi'}`, label: `Modify | ${label}`, panels: [...groupPanel, ...contextualPanels(kinds)] });
  }

  updateSelInfo() {
    const n = this.selection.size;
    const el = this.shell.selInfo;
    el.hidden = !n;
    el.replaceChildren(icon('filter', 13), h('span', `${n} selected`));
  }

  setHover(id) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.flagsVersion++;
    const el = id ? this.doc.get(id) : null;
    if (el && (this.tool instanceof SelectTool || !this.tool)) this.setPrompt(this.describe(el));
    else if (!id && (this.tool instanceof SelectTool || !this.tool)) this.setPrompt(this.tool?.prompt || 'Ready');
    this.requestRender();
  }

  /** Flags for an element in the active view: selection, hover, hidden, isolate. */
  flagsOf(id) {
    if (typeof id === 'string' && id.startsWith('u:')) return FLAG.dim;
    let f = 0;
    if (this.selection.has(id)) f |= FLAG.selected;
    if (this.hoverId === id) f |= FLAG.hover;
    const view = this.activeView;
    const gid = this.doc?.get(id)?.groupId;
    if (gid) {
      if (this.selection.has(gid)) f |= FLAG.selected;
      if (this.hoverId === gid) f |= FLAG.hover;
    }
    if (this.groupEdit && gid !== this.groupEdit.groupId && groupable(this.doc.get(id))) f |= FLAG.dim;
    if (view) {
      const el = this.doc.get(id);
      const reveal = this.reveal.has(view.id);
      if (el && this.hiddenInView(view, el)) f |= reveal ? FLAG.halftone : FLAG.hidden;
      else if (el && (view.overrides || view.filters?.length) && viewGraphics(this.doc, view, el).halftone) f |= FLAG.halftone;
      if (el && this.phaseCount > 1 && phased(el)) {
        const look = phaseLook(this.doc, view, el);
        if (look === 'hidden') f |= reveal ? FLAG.halftone : FLAG.hidden;
        else if (look === 'halftone' || look === 'dashed') f |= FLAG.halftone;
      }
      const t = this.temp.get(view.id);
      if (t) {
        const inSet = t.ids.has(id) || (el?.hostId && t.ids.has(el.hostId));
        if ((t.mode === 'hide' && inSet) || (t.mode === 'isolate' && !inSet && !(el?.kind === 'level' || el?.kind === 'grid'))) f |= reveal ? FLAG.halftone : FLAG.hidden;
      }
      if (el && this.tool?.dimOthers && !this.tool.dimOthers.has(id)) f |= FLAG.dim;
    }
    return f;
  }

  hiddenInView(view, el) {
    if (view.hiddenIds?.includes(el.id)) return true;
    if (el.groupId && view.hiddenIds?.includes(el.groupId)) return true;
    const cat = categoryOf(el, this.doc);
    if (cat && view.hiddenCats?.includes(cat)) return true;
    if (el.hostId) {
      const host = this.doc.get(el.hostId);
      if (host && view.hiddenIds?.includes(host.id)) return true;
    }
    return hiddenByFilters(this.doc, view, el);
  }

  /** Refresh the per-element state texture before drawing. */
  updateStateFlags() {
    const key = `${this.flagsVersion}|${this.activeViewId}|${this.scene?.version}`;
    if (this.flagsKey === key) return;
    this.flagsKey = key;
    this.phaseCount = this.doc?.count('phase') ?? 0;
    const entries = [];
    const scene = this.scene;
    if (!scene) return;
    for (let i = 0; i < scene.ids.length; i++) {
      const id = scene.ids[i];
      const f = this.flagsOf(id);
      if (f) entries.push([i + 1, f]);
    }
    this.viewport.state.setAll(entries);
  }

  selectAllInView() {
    const c = this.vc;
    if (!c?.graphical) return;
    let ids = [];
    if (c.is2D) {
      c.sync();
      ids = [...c.layer.items.keys()].filter((id) => !(this.flagsOf(id) & FLAG.hidden));
    } else ids = [...this.viewport.r3.items.keys()].filter((id) => !(this.flagsOf(id) & FLAG.hidden));
    this.select(ids);
  }

  selectSimilar(scope = 'view') {
    const first = this.doc.get([...this.selection][0]);
    if (!first) return;
    const match = (el) => el.kind === first.kind && (first.typeId ? el.typeId === first.typeId : true);
    let ids = this.doc.filter(match).map((e) => e.id);
    if (scope === 'view' && this.vc?.is2D) {
      this.vc.sync();
      ids = ids.filter((id) => this.vc.layer.items.has(id));
    }
    this.select(ids);
    this.setPrompt(`${ids.length} selected.`);
  }

  selectInstancesOfType(typeId) {
    this.select(this.doc.filter((e) => e.typeId === typeId).map((e) => e.id));
  }

  // Groups ---------------------------------------------------------------------------------------

  /** What a click on elements selects: a member's group, unless that group is being edited. */
  pickTargets(ids) {
    const out = [];
    for (const id of ids) {
      const el = this.doc.get(id);
      let t = id;
      if (this.groupEdit) {
        // While a group is edited, only its members (and annotations) can be picked.
        if (groupable(el) && el.groupId !== this.groupEdit.groupId) continue;
      } else if (el?.groupId && this.doc.has(el.groupId)) t = el.groupId;
      // Selection options in the status bar.
      const target = this.doc.get(t);
      if (target?.pinned && this.settings.selectPinned === false) continue;
      if (this.settings.selectLinks === false && target?.kind === 'link') continue;
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }

  async createGroup() {
    const ids = [...this.selection];
    if (!ids.length) return this.toast('Select the elements to group first.', { kind: 'error' });
    const names = this.doc.all('groupType').map((t) => t.name);
    const name = await promptDialog('Create Model Group', 'Group name', uniqueName(names, `Group ${names.length + 1}`), { okLabel: 'Create', validate: (v) => (!v ? 'Enter a name.' : names.includes(v) ? 'A group with this name exists.' : null) });
    if (!name) return;
    let g = null;
    this.commit('Create group', () => (g = createGroup(this.doc, ids, { name, levelId: this.activeLevelId() })));
    if (!g) return this.toast('None of the selected elements can be grouped (views, levels, grids and annotations cannot).', { kind: 'error' });
    this.select([g.id]);
    this.setPrompt(`Created ${name}. Place more copies with Place Group, and edit them all at once with Edit Group.`);
  }

  startGroupEdit(groupId) {
    const g = this.doc.get(groupId || [...this.selection][0]);
    if (g?.kind !== 'group') return this.toast('Select a model group to edit.', { kind: 'error' });
    this.cancelTool(true);
    this.groupEdit = { groupId: g.id, undoDepth: this.doc.undoStack.length };
    this.doc.addDefaults = { fields: { groupId: g.id }, accept: (it) => groupable(it) && !it.groupId };
    this.select([]);
    this.flagsVersion++;
    this.updateContextual();
    this.renderBanner();
    this.requestRender();
    this.setPrompt('Editing the group: change its members, add or remove elements, then click Finish.');
  }

  finishGroupEdit(keep = true) {
    const ge = this.groupEdit;
    if (!ge) return;
    this.doc.addDefaults = null;
    this.groupEdit = null;
    this.cancelTool(true);
    if (!keep) {
      while (this.doc.undoStack.length > ge.undoDepth && this.doc.canUndo) this.doc.undo();
    } else if (this.doc.has(ge.groupId)) {
      let n = 0;
      this.commit('Finish group', () => (n = propagateGroup(this.doc, ge.groupId)));
      if (n) this.toast(`Updated ${n} other instance${n === 1 ? '' : 's'} of the group.`, { kind: 'success' });
    }
    this.select(this.doc.has(ge.groupId) ? [ge.groupId] : []);
    this.flagsVersion++;
    this.updateContextual();
    this.renderBanner();
    this.requestRender();
  }

  ungroupSelection() {
    const groups = [...this.selection].filter((id) => this.doc.get(id)?.kind === 'group');
    if (!groups.length) return this.toast('Select a model group.', { kind: 'error' });
    const members = groups.flatMap((g) => this.doc.filter((el) => el.groupId === g).map((el) => el.id));
    this.commit('Ungroup', () => groups.forEach((g) => ungroup(this.doc, g)));
    this.select(members);
  }

  viewName(v) {
    return v.kind === 'sheet' ? `${v.number || ''} - ${v.name}` : v.name;
  }

  describe(el) {
    return describeEl(this.doc, el);
  }

  formatArea(v) {
    return formatArea(v, this.doc.units);
  }

  nudge(d) {
    const ids = [...this.selection];
    this.commit('Nudge', () => moveElements(this.doc, ids, d));
  }

  // Tools ------------------------------------------------------------------------------------

  commandDef(name) {
    return COMMANDS[name];
  }

  run(name, args) {
    const d = COMMANDS[name];
    if (!d) return;
    if (d.enabled && !d.enabled(this)) {
      if (name === 'move' || name === 'copy' || name === 'rotate' || name === 'mirrorPick' || name === 'mirrorDraw' || name === 'array') this.toast('Select elements first.', { kind: 'error' });
      return;
    }
    closeMenus();
    hideTooltip();
    this.lastCommand = name;
    try {
      d.run(this, args);
    } catch (err) {
      console.error(err);
      this.toast(`Something went wrong: ${err.message}`, { kind: 'error' });
    }
    this.ribbon.refresh();
  }

  isCommandActive(cmd) {
    if (cmd === 'thinLines') return !!this.settings.thinLines;
    if (cmd === 'workPlaneGrid') return !!this.settings.workPlaneGrid;
    if (cmd === 'cropView') return !!this.activeView?.cropOn;
    if (cmd === 'cropShow') return !!this.activeView?.cropShow;
    if (cmd === 'roomFill') return !!this.activeView?.roomFill;
    if (cmd === 'revealHidden') return this.reveal.has(this.activeViewId);
    if (cmd === 'sectionBox') return !!this.activeView?.sectionBox;
    if (cmd === 'modify') return !this.tool || this.tool instanceof SelectTool;
    const toggle = COMMANDS[cmd]?.toggle;
    if (toggle) return !!toggle(this);
    if (this.tool && this.tool.commandName === cmd) return true;
    return null;
  }

  startTool(Cls, opts = {}) {
    if (!this.doc) return;
    const probe = new Cls(this, opts);
    const kinds = probe.viewKinds;
    if (kinds && !kinds.includes(this.activeView?.kind)) {
      if (kinds.includes('plan')) {
        if (!this.requirePlan()) return;
      } else {
        const v = this.doc.filter((x) => kinds.includes(x.kind))[0];
        if (!v) return this.toast(`Open a ${kinds.join(' or ')} view to use ${probe.title}.`, { kind: 'error' });
        this.openView(v.id);
        this.toast(`Switched to ${v.name}.`);
      }
    }
    this.setTool(probe, this.lastCommand);
  }

  setTool(tool, commandName = null) {
    if (this.tool) {
      if (this.doc?.inTransaction) this.doc.rollback();
      this.tool.stop?.();
    }
    this.tool = tool;
    if (tool) tool.commandName = commandName;
    if (tool && !(tool instanceof SelectTool) && commandName) this.lastToolCommand = commandName;
    const ok = tool?.start?.();
    if (ok === false) return;
    this.shell.canvasWrap.style.cursor = tool && !(tool instanceof SelectTool) ? 'crosshair' : '';
    this.renderOptions();
    this.updateContextual();
    this.props.render();
    this.setPrompt(tool?.prompt || 'Ready');
    this.ribbon.refresh();
    this.requestRender();
    if (tool && !(tool instanceof SelectTool)) this.viewport.overlay.focus({ preventScroll: true });
  }

  cancelTool(silent = false) {
    if (!this.selectTool) this.selectTool = new SelectTool(this);
    if (this.tool === this.selectTool && silent) return;
    this.setTool(this.selectTool);
    this.selectTool.start();
    if (!silent) this.setPrompt('Ready');
  }

  toolNeedsTouch() {
    return this.tool && !(this.tool instanceof SelectTool);
  }

  toolEvent(type, ev) {
    if (!this.doc) return;
    if (!this.tool) this.cancelTool(true);
    const t = this.tool;
    if (ev) this.lastPointer = ev;
    if (type === 'move') this.updateCoords(ev);
    try {
      if (type === 'down') t.down(ev);
      else if (type === 'move') t.move(ev);
      else if (type === 'up') t.up?.(ev);
      else if (type === 'dblclick') t.dblclick?.(ev);
      else if (type === 'leave') {
        t.leave?.();
        if (t instanceof SelectTool) this.setHover(null);
      }
    } catch (err) {
      console.error(err);
    }
    if (type === 'down' || type === 'up') {
      this.ribbon.refresh();
      this.shell.undoBtn.disabled = !this.doc.canUndo;
    }
  }

  renderOptions() {
    const bar = this.shell.optionsbar;
    clear(bar);
    const t = this.tool;
    if (!t || t instanceof SelectTool) return;
    const opts = t.options?.();
    bar.append(h('span.ob-title', icon(KIND_ICON[t.placingKind] || 'modify', 13), t.title));
    if (opts) for (const o of [].concat(opts)) if (o) bar.append(o);
  }

  setPrompt(text) {
    if (this.shell) this.shell.prompt.textContent = text || '';
  }

  updateCoords(ev) {
    const c = this.vc;
    const el = this.shell.coords;
    if (!ev?.p || !c?.is2D) {
      if (!c?.is2D) el.textContent = '';
      return;
    }
    const u = this.doc.units;
    el.textContent = `X ${formatLength(ev.p[0], u)}   Y ${formatLength(ev.p[1], u)}`;
  }

  /** Remembered options per tool. */
  toolOptions(key, defaults) {
    if (!this.toolOpts.has(key)) this.toolOpts.set(key, { ...defaults });
    const o = this.toolOpts.get(key);
    for (const k in defaults) if (!(k in o)) o[k] = defaults[k];
    return o;
  }

  currentType(kind) {
    const id = this.currentTypes.get(kind);
    return defaultTypeFor(this.doc, kind, id);
  }

  setCurrentType(kind, typeId) {
    this.currentTypes.set(kind, typeId);
  }

  placeType(type, kind) {
    this.setCurrentType(kind, type.id);
    const cmd = { wall: 'wall', door: 'door', window: 'window', floor: 'floor', roof: 'roof', ceiling: 'ceiling', column: 'column', beam: 'beam', stair: 'stair', ramp: 'ramp', railing: 'railing', component: 'component', group: 'groupPlace', footing: 'footing', wallFooting: 'wallFooting', brace: 'brace', duct: 'duct', pipe: 'pipe', cableTray: 'cableTray', conduit: 'conduit' }[kind];
    if (cmd) this.run(cmd);
  }

  showTypeProperties(type, kind) {
    this.setCurrentType(kind, type.id);
  }

  // Elements -----------------------------------------------------------------------------------

  editElement(id, ev) {
    const el = this.doc.get(id);
    if (!el) return;
    if (el.kind === 'section' || el.kind === 'elevation' || isView(el)) return this.openView(el.id);
    if (el.kind === 'group') return this.startGroupEdit(el.id);
    if (el.kind === 'floor' || el.kind === 'roof' || el.kind === 'ceiling' || el.kind === 'railing') {
      this.select([id]);
      return this.editBoundary();
    }
    if (el.kind === 'text') return this.editText(el, ev);
    if (el.kind === 'level') {
      const plan = this.doc.all('plan').find((p) => p.levelId === el.id);
      if (plan) return this.openView(plan.id);
    }
    if (el.typeId) return this.editTypeDialog(this.doc.get(el.typeId));
  }

  editText(el, ev) {
    const t = this.tool instanceof SelectTool ? this.tool : null;
    if (!t) return;
    t.openInput(ev.x, ev.y, {
      label: 'Edit text',
      multiline: true,
      value: el.text,
      onSubmit: (v) => {
        if (v.trim()) this.commit('Edit text', () => this.doc.update(el.id, { text: v }));
        return true;
      },
    });
  }

  editBoundary() {
    const el = this.doc.get([...this.selection][0]);
    if (!el || !['floor', 'roof', 'ceiling', 'railing'].includes(el.kind)) return this.toast('Select a floor, roof, ceiling or railing.', { kind: 'error' });
    if (!this.requirePlan()) return;
    this.select([]);
    this.setTool(new SketchTool(this, { kind: el.kind, editId: el.id }), 'editBoundary');
    this.toast('Redraw the boundary, then click Finish. Tip: to adjust a few corners, select the element and drag its vertex grips instead.');
  }

  /** Attach (or detach) the tops of the selected walls to the roof above each. */
  attachTop(attach) {
    const doc = this.doc;
    const walls = [...this.selection].map((id) => doc.get(id)).filter((el) => el?.kind === 'wall');
    if (!walls.length) return this.toast('Select walls first.', { kind: 'error' });
    let n = 0;
    this.commit(attach ? 'Attach top' : 'Detach top', () => {
      for (const w of walls) {
        if (!attach) {
          if (w.attachTopId) {
            doc.update(w.id, { attachTopId: null });
            n++;
          }
          continue;
        }
        const m = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
        const baseZ = (doc.get(w.levelId)?.elevation ?? 0) + (+w.baseOffset || 0);
        const roof = doc
          .all('roof')
          .filter((r) => (doc.get(r.levelId)?.elevation ?? 0) + (+r.baseOffset || 0) > baseZ && insidePolygon(m, r.boundary))
          .sort((a, b) => (doc.get(a.levelId)?.elevation ?? 0) - (doc.get(b.levelId)?.elevation ?? 0))[0];
        if (!roof) continue;
        doc.update(w.id, { attachTopId: roof.id });
        n++;
      }
    });
    if (attach) this.toast(n ? `Attached ${n} wall${n === 1 ? '' : 's'} to the roof.` : 'No roof was found above the selected walls.', { kind: n ? 'success' : 'error' });
  }

  flipSelection() {
    this.commit('Flip', () => {
      for (const id of this.selection) {
        const el = this.doc.get(id);
        if (el?.kind === 'wall') this.doc.update(id, { flipped: !el.flipped });
        else if (el?.kind === 'door' || el?.kind === 'window') this.doc.update(id, { flipFacing: !el.flipFacing });
        else if (el?.kind === 'section') this.doc.update(id, { flip: !el.flip });
      }
    });
  }

  renameItem(id) {
    const it = this.doc.get(id);
    if (!it) return;
    promptDialog('Rename', 'Name', it.name || '', { validate: (v) => (!v ? 'Enter a name.' : null) }).then((name) => {
      if (name && name !== it.name) this.commit('Rename', () => this.doc.update(id, { name }));
    });
  }

  async deleteItem(id) {
    const it = this.doc.get(id);
    if (!it) return;
    if (it.kind.endsWith('Type')) {
      const used = this.doc.filter((e) => e.typeId === id).length;
      if (this.doc.all(it.kind).length <= 1) return this.toast('A category needs at least one type.', { kind: 'error' });
      if (used) {
        const ok = await confirmDialog('Delete type', `${used} element${used === 1 ? ' uses' : 's use'} this type and will also be deleted.`, { confirm: 'Delete', danger: true });
        if (!ok) return;
      }
      this.commit('Delete type', () => deleteElements(this.doc, [id, ...this.doc.filter((e) => e.typeId === id).map((e) => e.id)]));
      return;
    }
    if (isView(it)) {
      const ok = await confirmDialog('Delete view', `Delete "${it.name}"? Annotations drawn in it are deleted too.`, { confirm: 'Delete', danger: true });
      if (!ok) return;
    }
    this.commit('Delete', () => deleteElements(this.doc, [id]));
  }

  duplicateType(t) {
    const names = this.doc.all(t.kind).map((x) => x.name);
    const { id: _id, ...rest } = t;
    void _id;
    let copy;
    this.commit('Duplicate type', () => (copy = this.doc.add({ ...rest, name: uniqueName(names, `${t.name} 2`) })));
    if (copy) this.editTypeDialog(copy);
  }

  levelCommand() {
    const v = this.activeView;
    if (v && (v.kind === 'elevation' || v.kind === 'section')) return this.run('levelInElevation');
    dialogs.addLevelDialog(this).then((r) => {
      if (r) createLevel(this, r.elevation, r.name);
    });
  }

  toggleViewProp(key) {
    const v = this.activeView;
    if (!v) return;
    this.commit('View', () => this.doc.update(v.id, { [key]: !v[key] }));
  }

  hideInView(what) {
    const v = this.activeView;
    if (!v || !this.selection.size) return;
    const sel = [...this.selection].map((id) => this.doc.get(id)).filter(Boolean);
    if (what === 'category') {
      const cats = new Set([...(v.hiddenCats || []), ...sel.map((e) => categoryOf(e, this.doc)).filter(Boolean)]);
      this.commit('Hide category', () => this.doc.update(v.id, { hiddenCats: [...cats] }));
    } else {
      const ids = new Set([...(v.hiddenIds || []), ...sel.map((e) => e.id)]);
      this.commit('Hide in view', () => this.doc.update(v.id, { hiddenIds: [...ids] }));
    }
    this.select([]);
    this.setPrompt('Hidden in this view. Use Reveal Hidden Elements to show and unhide them.');
  }

  unhideSelected() {
    const v = this.activeView;
    if (!v) return;
    const sel = new Set(this.selection);
    const cats = new Set([...this.selection].map((id) => categoryOf(this.doc.get(id), this.doc)));
    this.commit('Unhide', () => this.doc.update(v.id, { hiddenIds: (v.hiddenIds || []).filter((id) => !sel.has(id)), hiddenCats: (v.hiddenCats || []).filter((c) => !cats.has(c)) }));
  }

  temporary(mode) {
    const id = this.activeViewId;
    if (mode === 'reset') this.temp.delete(id);
    else {
      if (!this.selection.size) return;
      this.temp.set(id, { mode, ids: new Set(this.selection) });
      this.select([]);
    }
    this.flagsVersion++;
    this.renderViewbar();
    this.requestRender();
  }

  toggleReveal() {
    const id = this.activeViewId;
    if (this.reveal.has(id)) this.reveal.delete(id);
    else this.reveal.add(id);
    this.flagsVersion++;
    this.renderViewbar();
    this.ribbon.refresh();
    this.requestRender();
  }

  toggleSectionBox() {
    const v = this.activeView;
    if (v?.kind !== 'view3d') return this.toast('Open a 3D view to use the section box.', { kind: 'error' });
    if (v.sectionBox) this.commit('Section box', () => this.doc.update(v.id, { sectionBox: null }));
    else {
      this.syncModel();
      const ids = this.selection.size ? this.selection : null;
      const b = this.viewport.r3.bounds(ids);
      if (!b) return;
      const pad = 300;
      this.commit('Section box', () => this.doc.update(v.id, { sectionBox: { min: b.min.map((x) => x - pad), max: b.max.map((x) => x + pad) } }));
    }
    this.renderViewbar();
  }

  toggleSetting(key) {
    this.settingsStore.set(key, !this.settings[key]);
    this.ribbon.refresh();
    this.renderViewbar();
    this.requestRender();
  }

  toggleSnaps() {
    const s = { ...this.settings.snaps, enabled: this.settings.snaps.enabled === false };
    this.settingsStore.set('snaps', s);
    this.shell.snapBtn.setAttribute('aria-pressed', String(s.enabled !== false));
    this.setPrompt(s.enabled !== false ? 'Snaps on' : 'Snaps off');
  }

  togglePane(which) {
    const dock = this.shell.dock;
    const phone = matchMedia('(max-width: 760px)').matches;
    if (phone) {
      const open = dock.classList.contains('phone-open') && dock.classList.contains(`phone-${which}`);
      dock.classList.remove('phone-open', 'phone-props', 'phone-browser');
      if (!open) dock.classList.add('phone-open', `phone-${which}`);
      this.renderPhonebar();
      return;
    }
    const cls = which === 'props' ? 'props-hidden' : 'browser-hidden';
    const other = which === 'props' ? 'browser-hidden' : 'props-hidden';
    if (dock.classList.contains(cls)) dock.classList.remove(cls);
    else if (dock.classList.contains(other)) {
      // Hiding the last pane hides the whole dock.
      this.shell.main.classList.toggle('dock-hidden');
    } else dock.classList.add(cls);
    this.settingsStore.set('dockState', { props: !dock.classList.contains('props-hidden'), browser: !dock.classList.contains('browser-hidden'), hidden: this.shell.main.classList.contains('dock-hidden') });
  }

  // Context menu ----------------------------------------------------------------------------------

  contextMenu(ev) {
    const c = this.vc;
    if (!c) return;
    let hit = null;
    if (c.hitTest) hit = c.hitTest(ev.x, ev.y)[0] ?? null;
    if (hit && !this.selection.has(hit)) this.select([hit]);
    const sel = this.selection.size;
    const items = [];
    if (this.tool && !(this.tool instanceof SelectTool)) items.push({ label: 'Cancel', icon: 'x', action: () => this.cancelTool() });
    if (this.lastToolCommand) items.push({ label: `Repeat ${COMMANDS[this.lastToolCommand]?.label}`, icon: COMMANDS[this.lastToolCommand]?.icon, action: () => this.run(this.lastToolCommand) });
    if (items.length) items.push({ separator: true });
    if (sel) {
      items.push(
        { label: 'Select All Instances in View', icon: 'pointer', action: () => this.selectSimilar('view') },
        { label: 'Select All Instances in Project', icon: 'pointer', action: () => this.selectSimilar('project') },
        { separator: true },
        { label: 'Move', icon: 'move', shortcut: 'MV', action: () => this.run('move') },
        { label: 'Copy', icon: 'copyEl', shortcut: 'CO', action: () => this.run('copy') },
        { label: 'Rotate', icon: 'rotate', shortcut: 'RO', action: () => this.run('rotate') },
        { label: 'Mirror', icon: 'mirror', shortcut: 'MM', action: () => this.run('mirrorPick') },
        { separator: true },
        { label: 'Hide in View', icon: 'hideEl', submenu: [
          { label: 'Elements', action: () => this.hideInView('element') },
          { label: 'Category', action: () => this.hideInView('category') },
        ] },
        { label: 'Override Graphics in View...', icon: 'wsDisplay', shortcut: 'OG', action: () => this.run('overrideEl') },
        { label: 'Isolate Temporarily', icon: 'isolate', shortcut: 'HI', action: () => this.temporary('isolate') },
        this.reveal.has(this.activeViewId) ? { label: 'Unhide in View', icon: 'eye', action: () => this.unhideSelected() } : null,
        { separator: true },
        { label: 'Edit Type', icon: 'types', action: () => this.editTypeDialog() },
        { label: 'Delete', icon: 'trash', shortcut: 'Del', action: () => this.run('delete') },
      );
    } else {
      items.push(
        { label: 'Zoom to Fit', icon: 'zoomFit', shortcut: 'ZF', action: () => this.zoomFit() },
        { label: 'Zoom in Region', icon: 'zoomRegion', shortcut: 'ZR', action: () => this.run('zoomRegion') },
        this.clipboard ? { label: 'Paste', icon: 'paste', shortcut: `${MOD}+V`, action: () => this.paste() } : null,
        { label: 'Select All in View', icon: 'pointer', shortcut: `${MOD}+A`, action: () => this.selectAllInView() },
        { separator: true },
        { label: 'View Properties', icon: 'sliders', action: () => this.togglePane('props') },
      );
    }
    showMenu({ x: ev.original.clientX, y: ev.original.clientY }, items.filter(Boolean), { label: 'Context menu' });
  }

  // Clipboard ------------------------------------------------------------------------------------

  copyToClipboard(cut = false) {
    const ids = [...expandGroups(this.doc, this.selection)];
    const items = ids.map((id) => this.doc.get(id)).filter((el) => el && !isView(el) && el.kind !== 'level' && el.id !== 'project');
    if (!items.length) return;
    // Hosted elements of copied walls come along.
    const set = new Set(items.map((e) => e.id));
    for (const k of ['door', 'window', 'opening']) for (const el of this.doc.all(k)) if (set.has(el.hostId) && !set.has(el.id)) items.push(el);
    this.clipboard = { items: structuredClone(items), levelId: this.activeLevelId(), viewId: this.activeViewId };
    if (cut) {
      this.commit('Cut', () => deleteElements(this.doc, ids));
      this.select([]);
    }
    this.setPrompt(`${cut ? 'Cut' : 'Copied'} ${items.length} element${items.length === 1 ? '' : 's'}. Paste places them in the same position on the active level.`);
    this.ribbon.refresh();
  }

  /** Paste onto several levels: the clipboard's model elements, aligned with where they were copied. */
  pasteToLevels() {
    const cb = this.clipboard;
    if (!cb) return this.toast('Copy elements first.', { kind: 'error' });
    dialogs.chooseLevelsDialog(this, 'Paste Aligned to Selected Levels', 'Paste').then((levels) => {
      if (!levels?.length) return;
      const all = [];
      for (const l of levels) all.push(...this.paste(l.id, true));
      this.select(all);
      this.setPrompt(`Pasted on ${levels.length} level${levels.length === 1 ? '' : 's'}.`);
    });
  }

  /** Start placing another element like the selected one (same kind and type). */
  createSimilar() {
    const el = this.doc.get([...this.selection][0]);
    if (!el) return this.toast('Select an element first.', { kind: 'error' });
    const type = this.doc.get(el.typeId);
    if (type) return this.placeType(type, el.kind === 'column' ? 'column' : el.kind);
    const byKind = { room: 'room', grid: 'grid', level: 'level', text: 'text', dimension: 'dimension', detailLine: 'detailLine', region: 'region', roomSeparator: 'roomSeparator', refPlane: 'refPlane', modelLine: 'modelLine', area: 'area', areaBoundary: 'areaBoundary', revisionCloud: 'revisionCloud', insulation: 'insulation', detailItem: 'detailItem', detailArc: 'detailArc', spot: 'spotElevation', symbol: 'symbol', tag: 'tag', section: 'section', elevation: 'elevation' };
    const cmd = byKind[el.kind];
    if (!cmd) return this.toast('There is no tool for this kind of element.', { kind: 'error' });
    if (el.kind === 'detailLine' || el.kind === 'modelLine') this.toolOptions(el.kind, {}).style = el.style;
    if (el.kind === 'detailItem') Object.assign(this.toolOptions('detailItem', {}), { family: el.family });
    if (el.kind === 'symbol') Object.assign(this.toolOptions('symbol', {}), { family: el.family });
    this.run(cmd);
  }

  selectionFilterDialog() {
    return dialogs.selectionFilterDialog(this);
  }

  paste(toLevelId = null, quiet = false) {
    const cb = this.clipboard;
    if (!cb) return [];
    const levelId = toLevelId || this.activeLevelId();
    const targetView = this.activeViewId;
    const ids = [];
    this.commit('Paste', () => {
      const map = new Map();
      for (const it of cb.items) {
        if (it.hostId && cb.items.some((x) => x.id === it.hostId)) continue;
        if (it.hostId && !this.doc.has(it.hostId)) continue;
        // Pasting to other levels takes the model, not the annotations of the copied view.
        if (toLevelId && it.viewId) continue;
        const { id, ...rest } = it;
        const patch = {};
        if (rest.levelId && levelId) patch.levelId = levelId;
        if (rest.viewId) patch.viewId = targetView;
        if (rest.topLevelId && rest.levelId !== levelId) {
          const above = this.doc.levelAbove(levelId);
          patch.topLevelId = above?.id ?? null;
        }
        const n = this.doc.add({ ...rest, ...patch });
        map.set(id, n.id);
        ids.push(n.id);
      }
      for (const it of cb.items) {
        if (!it.hostId || !map.has(it.hostId)) continue;
        const { id, ...rest } = it;
        const n = this.doc.add({ ...rest, hostId: map.get(it.hostId) });
        map.set(id, n.id);
        ids.push(n.id);
      }
      // Pasted members belong to the pasted copy of their group.
      for (const it of cb.items) if (it.groupId && map.has(it.id)) this.doc.update(map.get(it.id), { groupId: map.get(it.groupId) ?? this.doc.addDefaults?.fields?.groupId ?? null });
    });
    if (quiet) return ids;
    this.select(ids);
    this.setPrompt(`Pasted ${ids.length} element${ids.length === 1 ? '' : 's'}. Use Move (MV) to position them.`);
    return ids;
  }

  // Keyboard ----------------------------------------------------------------------------------

  bindKeys() {
    document.addEventListener('keydown', (e) => this.keydown(e));
  }

  keydown(e) {
    const tgt = e.target;
    const typing = tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt instanceof HTMLSelectElement || tgt?.isContentEditable;
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    // Global accelerators work everywhere except in text fields.
    if (mod && !e.altKey) {
      const k = key.toLowerCase();
      const map = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: e.shiftKey ? 'saveAs' : 'save', o: 'open', n: 'new', p: 'print', k: 'search' };
      if (!typing) Object.assign(map, { c: 'copyClip', x: 'cutClip', v: 'paste', a: 'selectAll' });
      if (k === 'tab') {
        e.preventDefault();
        return this.cycleView(e.shiftKey ? -1 : 1);
      }
      if (map[k] && (!typing || ['s', 'o', 'n', 'p', 'k'].includes(k))) {
        e.preventDefault();
        return this.run(map[k]);
      }
      return;
    }
    if (key === 'F1') {
      e.preventDefault();
      return this.run('help');
    }
    if (typing || !this.doc) return;
    if (tgt?.closest?.('.tree, .rb-tabs, .vtabs, .menu')) {
      if (key !== 'Escape') return;
    }
    if (this.tool?.key?.(e)) return;
    if (key === 'Escape') {
      e.preventDefault();
      this.keyBuffer = '';
      if (this.navMode) return this.setNavMode(null);
      if (this.tool && !(this.tool instanceof SelectTool)) {
        if (this.tool.cancel()) this.cancelTool();
        else this.setPrompt(this.tool.prompt);
        this.requestRender();
        return;
      }
      return;
    }
    if (key === 'Delete' || (key === 'Backspace' && this.selection.size)) {
      e.preventDefault();
      return this.run('delete');
    }
    if (key === 'Enter' && this.lastToolCommand && (!this.tool || this.tool instanceof SelectTool)) {
      e.preventDefault();
      return this.run(this.lastToolCommand);
    }
    // Two-letter shortcuts.
    if (/^[a-z]$/i.test(key) && !e.altKey) {
      this.keyBuffer = (this.keyBuffer + key.toUpperCase()).slice(-2);
      clearTimeout(this.keyTimer);
      this.keyTimer = setTimeout(() => (this.keyBuffer = ''), 1500);
      this.setPrompt(`Shortcut: ${this.keyBuffer}`);
      if (this.keyBuffer.length === 2) {
        const name = Object.keys(COMMANDS).find((n) => COMMANDS[n].keys === this.keyBuffer);
        this.keyBuffer = '';
        if (name) {
          e.preventDefault();
          return this.run(name);
        }
        this.setPrompt('No command has that shortcut. Press F1 for the list.');
      }
    }
  }

  // Panels ----------------------------------------------------------------------------------------

  renderBrowser() {
    this.browser?.render();
    const t = this.shell?.root.querySelector('#browser-title');
    if (t) t.textContent = this.doc ? `Project Browser - ${this.file?.name || this.doc.project.name}` : 'Project Browser';
  }

  updateTitle() {
    const t = this.shell.title;
    clear(t);
    if (!this.doc) {
      t.append(h('span.title-name', 'Building Design'));
      document.title = 'Building Design';
      return;
    }
    const name = this.file?.name || this.doc.project.name || 'Untitled';
    t.append(h('span.title-name', name));
    if (this.doc.modified) t.append(h('span.title-dot', { 'aria-label': 'Unsaved changes', role: 'img' }));
    const v = this.activeView;
    if (v) t.append(h('span.title-view', `- ${this.viewName(v)}`));
    document.title = `${this.doc.modified ? '* ' : ''}${name} - Building Design`;
    this.shell.undoBtn.disabled = !this.doc.canUndo;
    this.shell.redoBtn.disabled = !this.doc.canRedo;
  }

  bindDock() {
    const s = this.settings.dockState;
    if (s) {
      this.shell.dock.classList.toggle('props-hidden', s.props === false);
      this.shell.dock.classList.toggle('browser-hidden', s.browser === false);
      this.shell.main.classList.toggle('dock-hidden', !!s.hidden);
    }
    const w = this.settings.dockWidth;
    if (w) this.shell.root.style.setProperty('--dock-w', `${w}px`);
    const ph = this.settings.propsHeight;
    if (ph) this.shell.dock.style.setProperty('--props-h', `${ph}%`);
    const drag = (el, onMove, onEnd) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const move = (ev) => onMove(ev);
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          onEnd?.();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      });
    };
    drag(
      this.shell.dockResize,
      (ev) => {
        const r = this.shell.main.getBoundingClientRect();
        const w2 = Math.max(200, Math.min(560, ev.clientX - r.left));
        this.shell.root.style.setProperty('--dock-w', `${w2}px`);
        this.shell.dockResize.setAttribute('aria-valuenow', String(Math.round(w2)));
        this.dockW = w2;
      },
      () => this.dockW && this.settingsStore.set('dockWidth', this.dockW),
    );
    drag(
      this.shell.dockSplit,
      (ev) => {
        const r = this.shell.dock.getBoundingClientRect();
        const p = Math.max(15, Math.min(85, ((ev.clientY - r.top) / r.height) * 100));
        this.shell.dock.style.setProperty('--props-h', `${p}%`);
        this.shell.dockSplit.setAttribute('aria-valuenow', String(Math.round(p)));
        this.propsH = p;
      },
      () => this.propsH && this.settingsStore.set('propsHeight', this.propsH),
    );
    const keyResize = (el, prop, step, min, max, unit, save) =>
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        e.stopPropagation();
        const target = prop === '--dock-w' ? this.shell.root : this.shell.dock;
        const cur = parseFloat(getComputedStyle(target).getPropertyValue(prop)) || (prop === '--dock-w' ? 290 : 52);
        const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -step : step;
        const v = Math.max(min, Math.min(max, cur + d));
        target.style.setProperty(prop, `${v}${unit}`);
        el.setAttribute('aria-valuenow', String(Math.round(v)));
        this.settingsStore.set(save, v);
      });
    keyResize(this.shell.dockResize, '--dock-w', 16, 200, 560, 'px', 'dockWidth');
    keyResize(this.shell.dockSplit, '--props-h', 4, 15, 85, '%', 'propsHeight');
  }

  buildPhonebar() {
    this.renderPhonebar();
  }

  renderPhonebar() {
    const bar = this.shell.phonebar;
    clear(bar);
    const dock = this.shell.dock;
    const btn = (label, ic, action, pressed) => h('button.pb-btn', { type: 'button', 'aria-pressed': pressed == null ? null : String(pressed), onClick: action }, icon(ic, 20), h('span', label));
    bar.append(
      btn('Tools', 'wall', () => dialogs.toolsSheet(this)),
      btn('Views', 'layers', () => this.togglePane('browser'), dock.classList.contains('phone-browser') && dock.classList.contains('phone-open')),
      btn('Properties', 'sliders', () => this.togglePane('props'), dock.classList.contains('phone-props') && dock.classList.contains('phone-open')),
      btn('Undo', 'undo', () => this.run('undo')),
      btn('Modify', 'modify', () => dialogs.modifySheet(this)),
    );
  }

  // Selection overlay (temporary dimensions and room reference) -----------------------------------------

  drawSelectionOverlay(ctx, vc, vp) {
    this.tempDims = [];
    if (!vc?.is2D || this.selection.size !== 1 || !(this.tool instanceof SelectTool) || this.tool.drag?.started) return;
    const el = this.doc.get([...this.selection][0]);
    if (!el || el.pinned) return;
    for (const d of temporaryDimensions(this.doc, el)) {
      const rect = drawTempDim(ctx, vc.modelToScreen(d.a), vc.modelToScreen(d.b), formatLength(d.value, this.doc.units), vp.theme.selCss, vp.theme, d.offsetPx ?? 18);
      if (rect) this.tempDims.push({ ...d, rect });
    }
  }

  /** A click on a temporary dimension's value opens it for editing. */
  tempDimAt(x, y) {
    return (this.tempDims || []).find((d) => x >= d.rect.x && x <= d.rect.x + d.rect.w && y >= d.rect.y && y <= d.rect.y + d.rect.h) ?? null;
  }

  editTempDim(d, ev) {
    this.tool.openInput(ev.x, ev.y, {
      label: 'Distance',
      value: formatLength(d.value, this.doc.units),
      onSubmit: (v) => {
        const mm = parseLength(v, this.doc.units);
        if (!Number.isFinite(mm) || mm < 0) return false;
        this.commit('Edit dimension', () => d.apply(this.doc, mm));
        return true;
      },
    });
  }

  // Theme ----------------------------------------------------------------------------------------

  get themePref() {
    return this.settings.theme || 'system';
  }

  applyTheme() {
    const t = this.themePref;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem('bd.theme', t);
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => this.viewport?.readTheme());
  }

  setTheme(value) {
    this.settingsStore.set('theme', value || 'system');
    this.applyTheme();
    this.ribbon?.refresh();
  }

  themeMenu(anchor) {
    const cur = this.themePref;
    showMenu(
      anchor,
      [
        { label: 'System', icon: 'monitor', checked: cur === 'system', radio: true, action: () => this.setTheme('system') },
        { label: 'Light', icon: 'sun-l', checked: cur === 'light', radio: true, action: () => this.setTheme('light') },
        { label: 'Dark', icon: 'moon', checked: cur === 'dark', radio: true, action: () => this.setTheme('dark') },
      ],
      { label: 'Theme' },
    );
  }

  // Account ----------------------------------------------------------------------------------------

  async renderAccount() {
    const el = this.shell.account;
    const seq = (this.accountSeq = (this.accountSeq || 0) + 1);
    if (!puterAvailable()) return clear(el);
    const signed = await isSignedIn();
    if (seq !== this.accountSeq) return;
    clear(el);
    if (!signed) {
      el.append(h('button.btn.sm', { type: 'button', onClick: () => this.signIn() }, icon('log-in', 14), h('span.hide-phone', 'Sign in')));
      return;
    }
    const user = await getUser();
    if (seq !== this.accountSeq) return;
    this.user = user;
    const name = user?.username || 'Account';
    const pic = cachedProfilePicture(name);
    const avatar = pic ? h('img.avatar', { src: pic, alt: '' }) : h('span.avatar.initials', name.slice(0, 1).toUpperCase());
    const btn = h('button.avatar-btn', { type: 'button', 'aria-label': `Account: ${name}`, 'aria-haspopup': 'menu', 'data-tip': name, onClick: (e) => this.accountMenu(e.currentTarget) }, avatar);
    el.append(btn);
    fetchProfilePicture(name).then((url) => {
      if (url && url !== pic) btn.replaceChildren(h('img.avatar', { src: url, alt: '' }));
    });
  }

  accountMenu(anchor) {
    const items = [{ header: this.user?.username || 'Signed in' }, { label: 'Open from Puter', icon: 'cloud', action: () => this.openDialog('cloud') }, { label: 'Shared With Me', icon: 'users', action: () => this.openDialog('shared') }];
    if (canSignOut()) items.push({ separator: true }, { label: 'Sign out', icon: 'log-out', action: () => this.signOut() });
    showMenu(anchor, items, { alignRight: true, label: 'Account' });
  }

  async signIn() {
    try {
      await signIn();
      await this.renderAccount();
      await this.settingsStore.syncFromCloud();
      this.applyPreferences();
      this.ribbon.renderBody();
      this.applyTheme();
      return true;
    } catch {
      this.toast('Sign-in was cancelled.');
      return false;
    }
  }

  signOut() {
    signOut();
    clearProfilePicture();
    this.user = null;
    this.renderAccount();
  }

  // Menus -------------------------------------------------------------------------------------------

  selectionOptionsMenu(anchor) {
    const flip = (k) => this.settingsStore.set(k, this.settings[k] === false);
    showMenu(anchor, [
      { label: 'Select Pinned Elements', checked: this.settings.selectPinned !== false, action: () => flip('selectPinned') },
      { label: 'Drag Elements When Selecting', checked: this.settings.dragOnSelect !== false, action: () => flip('dragOnSelect') },
      { separator: true },
      { label: 'Options...', icon: 'settings', action: () => this.run('options') },
    ], { label: 'Selection options' });
  }

  appMenu(anchor) {
    const recent = files.recentFiles().slice(0, 6);
    showMenu(
      anchor,
      [
        { label: 'New Project...', icon: 'file-plus', shortcut: `${MOD}+N`, action: () => this.run('new') },
        { label: 'Open...', icon: 'folder-open', shortcut: `${MOD}+O`, action: () => this.run('open') },
        recent.length ? { label: 'Recent', icon: 'history', submenu: recent.map((r) => ({ label: r.name, icon: r.source === 'cloud' ? 'cloud' : 'device', action: () => files.openRecent(this, r) })) } : null,
        { separator: true },
        { label: 'Save', icon: 'save', shortcut: `${MOD}+S`, action: () => this.run('save') },
        { label: 'Save As...', icon: 'save-all', action: () => this.run('saveAs') },
        { label: 'Export...', icon: 'download', action: () => this.run('export') },
        { label: 'Print or Export PDF...', icon: 'printer', shortcut: `${MOD}+P`, action: () => this.run('print') },
        { separator: true },
        { label: 'Share Project...', icon: 'share', action: () => this.run('share') },
        { label: 'Project Information...', icon: 'info', action: () => this.run('projectInfo') },
        { separator: true },
        { label: 'Home', icon: 'house', action: () => this.showHome() },
        { label: 'Options...', icon: 'settings', action: () => this.run('options') },
        { label: 'Keyboard Shortcuts...', icon: 'keyboard', action: () => this.run('shortcuts') },
        { label: 'About Building Design', icon: 'info', action: () => this.run('about') },
      ].filter(Boolean),
      { label: 'File', className: 'app-menu' },
    );
  }

  commandPalette() {
    dialogs.commandPalette(this);
  }

  // Home --------------------------------------------------------------------------------------------

  showHome(keepDoc = false) {
    void keepDoc;
    this.viewport.setController(null);
    this.shell.viewcube.hidden = true;
    this.shell.nav.hidden = true;
    this.shell.domView.hidden = false;
    this.activeHome = true;
    renderHome(this, this.shell.domView);
    if (!this.doc) {
      clear(this.shell.vtabs);
      this.updateTitle();
    }
  }

  newProject(system) {
    const doc = createProject({ system });
    this.setDoc(doc, null);
    this.toast(`New ${system === 'imperial' ? 'imperial' : 'metric'} project. Start with Wall (WA) in the Architecture tab.`);
  }

  openSample() {
    const doc = createSampleProject({ system: this.settings.units === 'imperial' ? 'imperial' : 'metric' });
    this.setDoc(doc, null);
  }

  /** Starts a new or sample project after offering to save unsaved changes. */
  async startProject(kind) {
    if (!(await files.confirmDiscard(this))) return false;
    if (kind === 'sample') this.openSample();
    else this.newProject(kind);
    return true;
  }

  // Files and dialogs (implemented in io/files.js and ui/dialogs.js) ------------------------------------

  newProjectDialog() {
    return dialogs.newProjectDialog(this);
  }
  openDialog(tab) {
    return files.openDialog(this, tab);
  }
  save() {
    return files.save(this);
  }
  saveAs() {
    return files.saveAs(this);
  }
  exportDialog(format) {
    return dialogs.exportDialog(this, format);
  }
  shareDialog() {
    return dialogs.shareDialog(this);
  }
  editTypeDialog(type) {
    const t = type || this.doc.get(this.doc.get([...this.selection][0])?.typeId) || (this.tool?.placingKind ? this.currentType(this.tool.placingKind) : null);
    if (!t) return this.toast('Select an element with a type, or choose a type in the Project Browser.', { kind: 'error' });
    return dialogs.typeDialog(this, t);
  }
  visibilityDialog() {
    return dialogs.visibilityDialog(this);
  }
  projectInfoDialog() {
    return dialogs.projectInfoDialog(this);
  }
  unitsDialog() {
    return dialogs.unitsDialog(this);
  }
  materialsDialog() {
    return dialogs.materialsDialog(this);
  }
  levelsDialog() {
    return dialogs.levelsDialog(this);
  }
  typesDialog() {
    return dialogs.typesDialog(this);
  }
  snapsDialog() {
    return dialogs.snapsDialog(this);
  }
  purgeDialog() {
    return dialogs.purgeDialog(this);
  }
  shortcutsDialog() {
    return options.shortcutsDialog(this);
  }

  optionsDialog() {
    return options.optionsDialog(this);
  }

  /** Open a plan of the elements' level, select them and zoom to them. */
  showElements(ids) {
    const live = ids.filter((id) => this.doc.has(id));
    const first = this.doc.get(live[0]);
    const plan = first?.levelId && this.doc.all('plan').find((p) => p.levelId === first.levelId && !p.calloutOf);
    if (plan && this.activeView?.levelId !== first.levelId) this.openView(plan.id);
    this.select(live);
    this.vc?.zoomExtents?.(true, new Set(live));
  }

  elementOverrideDialog() {
    return dialogs.elementOverrideDialog(this);
  }

  /** User preferences that live outside the settings object. */
  applyPreferences() {
    applyShortcuts(this.settings.shortcuts || {});
    setTooltipMode(this.settings.tooltips);
  }
  helpDialog() {
    return dialogs.helpDialog(this);
  }
  aboutDialog() {
    return dialogs.aboutDialog(this);
  }
  planViewDialog() {
    return dialogs.planViewDialog(this);
  }
  areaPlanDialog() {
    return dialogs.areaPlanDialog(this);
  }
  revisionsDialog() {
    return dialogs.revisionsDialog(this);
  }
  filtersDialog() {
    return dialogs.filtersDialog(this);
  }
  templatesDialog() {
    return dialogs.templatesDialog(this);
  }
  startingViewDialog() {
    return dialogs.startingViewDialog(this);
  }

  async templateFromView() {
    const v = this.activeView;
    if (!v || !['plan', 'areaPlan', 'ceilingPlan', 'view3d', 'elevation', 'section'].includes(v.kind)) return this.toast('Open a plan, 3D view, elevation or section first.', { kind: 'error' });
    const names = this.doc.all('viewTemplate').map((t) => t.name);
    const name = await promptDialog('New View Template', 'Template name', uniqueName(names, `${v.name} Template`), { okLabel: 'Create', validate: (x) => (!x ? 'Enter a name.' : names.includes(x) ? 'A template with this name exists.' : null) });
    if (!name) return;
    this.commit('New view template', () => this.doc.add({ kind: 'viewTemplate', name, viewKind: templateKindOf(v.kind), settings: templateSettings(v) }));
    this.toast(`Created the view template "${name}". Assign it to views in their properties, or in View Templates.`, { kind: 'success' });
  }
  findReplaceDialog() {
    return dialogs.findReplaceDialog(this);
  }
  newScheduleDialog(category) {
    return dialogs.newScheduleDialog(this, category);
  }
  newSheet() {
    return dialogs.newSheet(this);
  }
  placeViewDialog(viewId) {
    return dialogs.placeViewDialog(this, viewId);
  }
  exportSchedule(id) {
    return files.exportScheduleCSV(this, id);
  }
  importDXF() {
    return files.importDXF(this);
  }
  scheduleFieldsDialog(id) {
    return dialogs.scheduleFieldsDialog(this, id);
  }
  scheduleFilterDialog(id) {
    return dialogs.scheduleFilterDialog(this, id);
  }
}

