// Application shell: layout, documents and tabs, panels, project files,
// account, and the glue between editors, the kernel and the exporters.

import { h, clear, announce, shortcutLabel, isMac } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { createMenubar, setMenuCommands, openMenu } from '../ui/menu.js';
import { toast, installTooltips } from '../ui/toast.js';
import { openDialog, confirmDialog, choiceDialog, promptDialog } from '../ui/dialog.js';
import { Emitter } from '../core/emitter.js';
import { formatLength } from '../core/units.js';
import { CommandRegistry } from './commands.js';
import { KeyHandler } from './keys.js';
import { buildMenus } from './menus.js';
import { registerCommands } from './actions.js';
import { Settings, uiState } from './settings.js';
import { applyTheme, resolvedTheme, currentTheme } from './theme.js';
import * as P from './puter.js';
import { mountUserMenu, userMenuSlot } from './user-menu.js';
import * as storage from './storage.js';
import * as dialogs from './dialogs.js';
import { newComponentDialog, libraryDialog } from './lib-dialogs.js';
import { createExampleProject } from './demo.js';
import { Project, newProjectData, parseProject } from '../model/project.js';
import { runErc } from '../model/erc.js';
import { exportShape } from '../model/netlist.js';
import { LAYERS, copperLayers } from '../model/layers.js';
import { SchEditor } from '../editors/sch-editor.js';
import { PcbEditor } from '../editors/pcb-editor.js';
import { ProjectsPanel } from '../ui/panels/projects.js';
import { ComponentsPanel } from '../ui/panels/components.js';
import { PropertiesPanel } from '../ui/panels/properties.js';
import { MessagesPanel } from '../ui/panels/messages.js';
import { NavigatorPanel } from '../ui/panels/navigator.js';
import { LayersPanel } from '../ui/panels/layers.js';
import { KernelClient } from '../kernel/client.js';
import { textStrokes } from '../render/font.js';
import { UserLibrary } from './user-library.js';
import { LibDoc, LibEditor } from '../editors/lib-editor.js';
import { copyDef } from '../editors/lib-model.js';
import { findComponent } from '../model/library/builtin.js';
import { uid } from '../core/emitter.js';
import { shareDialog } from './share.js';
import { historyDialog, recordVersion } from './history.js';

/** Lets the user choose one or more files from the device. */
function pickFiles(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = accept;
    input.addEventListener('change', () => resolve([...(input.files || [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** A project file error in words: JSON syntax errors mean a damaged or foreign file. */
const fileError = (err) =>
  err instanceof SyntaxError ? 'This file is not a Circuits project, or it is damaged.' : err?.message || String(err);

export const REPO_URL = 'https://github.com/heyputer/everything';
const ALPHA_KEY = 'circuits:alpha-notice-seen';
const LAST_KEY = 'circuits:last-project';
const COMPACT = '(max-width: 900px)';

const LEFT_PANELS = ['projects', 'navigator'];
const RIGHT_PANELS = ['properties', 'components', 'layers'];
const PANEL_LABEL = { projects: 'Projects', navigator: 'Navigator', properties: 'Properties', components: 'Components', layers: 'Layers', messages: 'Messages' };

export class App extends Emitter {
  constructor(root, { puterTimeout = 4000 } = {}) {
    super();
    this.root = root;
    this.puterTimeout = puterTimeout;
    this.settings = new Settings();
    this.commands = new CommandRegistry();
    this.kernel = new KernelClient();
    this.userLibrary = new UserLibrary();
    this.userLibrary.on('change', () => this.panels?.components.refresh());
    this.project = null;
    this.location = null;
    this.editors = new Map();
    this._libDocs = new Map();   // component editor documents, keyed 'lib:<id>'
    this.openTabs = [];
    this.activeDocId = null;
    this.clipboard = null;
    this.user = null;
    this.picture = null;
    this.saveState = 'saved';
    this.leftOpen = uiState.get('leftOpen', true);
    this.rightOpen = uiState.get('rightOpen', true);
    this.bottomOpen = false;
    this.leftTab = uiState.get('leftTab', 'projects');
    this.rightTab = uiState.get('rightTab', 'properties');
    this.view3dOpen = false;
    this.compactQuery = window.matchMedia ? window.matchMedia(COMPACT) : { matches: false, addEventListener() {} };
  }

  get activeEditor() { return this.activeDocId ? this.editors.get(this.activeDocId) || null : null; }
  get isCompact() { return this.compactQuery.matches; }
  get locationLabel() { return this.location ? storage.locationLabel(this.location) : ''; }

  toast(msg, opts) { return toast(msg, opts); }

  // ---------- Startup ----------

  async init() {
    applyTheme(this.settings.get('theme'));
    setMenuCommands(this.commands);
    registerCommands(this);
    this.buildLayout();
    this.keys = new KeyHandler(this);
    installTooltips(document);
    this.root.removeAttribute('aria-busy');
    this._wireGlobal();
    this.renderAccount();

    const sdk = await P.loadPuter(this.puterTimeout);
    this.env = P.env();
    // Where the SDK has <puter-user-menu>, it takes the account's place in the title bar.
    this.userMenu = mountUserMenu(this.userMenuEl, {
      signOut: () => this.signOut(),
      signedIn: () => { P.accountChanged(); this._signedIn(); },
      signedOut: () => { P.accountChanged(); this._signedOut(); },
    });
    if (this.userMenu) this.userMenu.parentElement.classList.add('has-user-menu');
    if (sdk && (this.env === 'app' || P.isSignedIn())) await this._loadUser();
    this.renderAccount();
    this.userLibrary.load();

    let opened = false;
    // Launched from the Puter desktop with a file.
    if (sdk?.ui?.onLaunchedWithItems) {
      try {
        sdk.ui.onLaunchedWithItems(async (items) => {
          const item = items?.find((i) => /\.(circuits|json)$/i.test(i.name));
          if (item) await this.openLocation({ type: 'cloud', path: item.path });
        });
      } catch { /* not launched with items */ }
    }
    const last = (() => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; } })();
    if (last && this.settings.get('openOnStart') === 'last' && (last.type === 'local' || P.cloudAvailable())) {
      opened = await this.openLocation(last, { quiet: true });
    }
    if (!opened && !this.project) this.showStart();
    this.showAlphaNotice();
  }

  async _loadUser() {
    this.user = await P.getUser();
    this.picture = this.user ? await P.getProfilePicture() : null;
    if (this.user) this.settings.syncFromCloud().then(() => this.applyPreferences());
  }

  _wireGlobal() {
    this.settings.on('change', ({ key }) => {
      // The button shows the choice (light, dark or system), which can change
      // without the resolved theme changing, so redraw it here as well.
      if (key === 'theme') { applyTheme(this.settings.get('theme')); this.renderThemeButton(); }
      if (key === 'units' || key === 'pcbGrid' || key === 'schGrid') { this.updateStatus(); for (const e of this.editors.values()) { e.requestRender(true); e._updateHud?.(); } this.panels.properties.refresh(); }
      if (key === 'onlineDrc') for (const e of this.editors.values()) e._scheduleDrc?.();
    });
    window.addEventListener('themechange', () => { this.renderThemeButton(); this.panels.components._preview(); });
    window.addEventListener('beforeunload', (e) => {
      const libDirty = [...this._libDocs.values()].some((d) => d.dirty);
      if (this.project?.dirty || libDirty) { this._flushSave(); e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this._flushSave(); });
    this.compactQuery.addEventListener?.('change', () => this.applyDocks());
    // Escape closes an open panel drawer (tablet and phone layouts). Dialogs,
    // menus and fields that use Escape themselves stop or mark the event.
    document.addEventListener('keydown', (e) => {
      const drawer = this._drawerLeft || this._drawerRight;
      if (e.key !== 'Escape' || e.defaultPrevented || !this.isCompact || !drawer) return;
      e.preventDefault();
      this.closeDrawers({ restoreFocus: true });
    });
    window.addEventListener('resize', () => this._clampDocks());
  }

  showAlphaNotice() {
    try { if (localStorage.getItem(ALPHA_KEY)) return; } catch { return; }
    toast('Circuits is in early alpha. Features may change and work could be lost, so please do not rely on it for real boards or important designs yet, and always check fabrication files before ordering.', {
      title: 'Early preview', kind: 'info', timeout: 0, className: 'alpha-notice',
      actions: [{ label: 'Got it', primary: true, run: () => { try { localStorage.setItem(ALPHA_KEY, new Date().toISOString()); } catch { /* storage unavailable */ } } }],
    });
  }

  // ---------- Layout ----------

  buildLayout() {
    const root = this.root;
    clear(root);
    this.menubar = createMenubar();
    this.docTitle = h('div.doc-title', { 'aria-live': 'polite' });
    this.themeBtn = h('button.icon-btn.theme-btn', { type: 'button', 'aria-label': 'Theme', 'data-tip': 'Theme', onClick: () => this._themeMenu() });
    this.accountEl = h('div.account');
    // Filled once the SDK is known, where it has <puter-user-menu> (see user-menu.js).
    this.userMenuEl = userMenuSlot();
    this.saveBadge = h('span.small.muted.phone-hide', { 'aria-live': 'polite', style: { margin: '0 6px', whiteSpace: 'nowrap' } });
    const quick = (cmd, ico, label, extra = '') => h(`button.icon-btn${extra}`, { type: 'button', 'aria-label': label, 'data-tip': label, 'data-kbd': this.commands.get(cmd)?.shortcut || '', onClick: () => this.commands.run(cmd) }, icon(ico, 17));
    const titlebar = h('header.titlebar', { role: 'banner' },
      h('button.icon-btn.mobile-only', { type: 'button', 'aria-label': 'Menu', onClick: (e) => this._mobileMenu(e) }, icon('menu', 20)),
      h('div.app-mark', h('img.logo', { src: './favicon-32.png', alt: '' }), h('span.phone-hide', 'Circuits')),
      h('span.sep.phone-hide'),
      quick('file.new', 'new', 'New project', '.phone-hide'), quick('file.open', 'open', 'Open project', '.phone-hide'), quick('file.save', 'save', 'Save', '.phone-hide'),
      h('span.sep.phone-hide'),
      quick('edit.undo', 'undo', 'Undo'), quick('edit.redo', 'redo', 'Redo'),
      h('button.icon-btn.compact-only.phone-hide', { type: 'button', 'aria-label': 'Project panels', 'data-tip': 'Project panels', onClick: () => this._toggleDrawer('left') }, icon('panel-left', 17)),
      this.docTitle,
      this.saveBadge,
      h('button.icon-btn.compact-only.phone-hide', { type: 'button', 'aria-label': 'Design panels', 'data-tip': 'Properties and components', onClick: () => this._toggleDrawer('right') }, icon('panel-right', 17)),
      h('button.search-box', { type: 'button', 'aria-keyshortcuts': isMac ? 'Meta+K' : 'Control+K', onClick: () => this.commandPalette() }, icon('search', 14), h('span', 'Search commands'), h('kbd', { 'aria-hidden': 'true' }, shortcutLabel('Mod+K'))),
      h('span.alpha-tag', { title: 'Early preview: features may change' }, 'Alpha'),
      this.themeBtn,
      h('a.icon-btn', { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Source code on GitHub (opens in a new tab)', 'data-tip': 'Source code on GitHub' }, icon('github', 17)),
      this.accountEl,
      this.userMenuEl);
    this.renderThemeButton();

    // Panels.
    this.panels = {
      projects: new ProjectsPanel(this),
      navigator: new NavigatorPanel(this),
      properties: new PropertiesPanel(this),
      components: new ComponentsPanel(this),
      layers: new LayersPanel(this),
      messages: new MessagesPanel(this),
    };

    this.leftDock = this._dock('left', LEFT_PANELS, 'Project panels');
    this.rightDock = this._dock('right', RIGHT_PANELS, 'Design panels');
    // No landmark of its own: the Messages panel inside it is the labelled region.
    this.bottomDock = h('div.dock.dock-bottom', { hidden: true }, h('div.resizer', { 'aria-hidden': 'true' }), this.panels.messages.el);
    this._resizer(this.bottomDock.firstChild, 'bottom');

    this.docTabs = h('div.doc-tabs');
    this.editorHost = h('div.editor-host');
    this.center = h('main.center#main', { tabindex: -1 }, this.docTabs, this.editorHost, this.bottomDock);
    this.sideStrip = h('div.side-strip', { role: 'toolbar', 'aria-label': 'Panels', 'aria-orientation': 'vertical' });
    this.scrim = h('div.scrim', { hidden: true, onClick: () => this.closeDrawers({ restoreFocus: true }) });
    this.workspace = h('div.workspace', this.leftDock.el, this.center, this.rightDock.el, this.sideStrip, this.scrim);

    this.status = h('footer.statusbar', { role: 'contentinfo', 'aria-label': 'Status' });
    this.mobileBar = h('div.mobile-bar', { role: 'toolbar', 'aria-label': 'Quick actions' });
    // A region landmark around the phone toolbar, like the status bar it replaces.
    const mobileRegion = h('section.mobile-region', { 'aria-label': 'Quick actions' }, this.mobileBar);
    root.append(titlebar, this.menubar.el, this.workspace, this.status, mobileRegion);
    // The mobile bar replaces the status bar row on phones.
    root.style.gridTemplateRows = '';
    this.refreshMenus();
    this.applyDocks();
    this.updateStatus();
    this.renderMobileBar();
    this.panels.components.refresh();
    this.panels.projects.refresh();
  }

  _dock(side, ids, label) {
    const body = h('div.dock-body');
    const tabs = h('div.dock-tabs', { role: 'tablist', 'aria-label': label });
    const el = h(`aside.dock.dock-${side}`, { 'aria-label': label }, h('div.resizer', { 'aria-hidden': 'true' }), body, tabs);
    this._resizer(el.firstChild, side);
    const dock = { el, body, tabs, ids, side };
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const btns = [...tabs.children];
      const i = btns.indexOf(document.activeElement);
      const next = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
      next.focus();
      next.click();
    });
    return dock;
  }

  _renderDock(dock) {
    const current = dock.side === 'left' ? this.leftTab : this.rightTab;
    const ids = dock.ids.filter((id) => id !== 'layers' || this.activeEditor?.kind === 'pcb');
    const active = ids.includes(current) ? current : ids[0];
    clear(dock.tabs);
    for (const id of ids) {
      dock.tabs.append(h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(id === active), tabindex: id === active ? 0 : -1,
        onClick: () => { if (dock.side === 'left') this.leftTab = id; else this.rightTab = id; uiState.set(`${dock.side}Tab`, id); this._renderDock(dock); },
      }, PANEL_LABEL[id]));
    }
    const panel = this.panels[active];
    if (dock.body.firstChild !== panel.el) dock.body.replaceChildren(panel.el);
    panel.refresh?.();
    if (active === 'components') this.panels.components._preview();
  }

  _resizer(handle, side) {
    handle.addEventListener('pointerdown', (e) => {
      // One drag at a time, with the primary button or a touch.
      if (e.button !== 0 || handle.classList.contains('dragging')) return;
      e.preventDefault();
      handle.setPointerCapture?.(e.pointerId);
      handle.classList.add('dragging');
      const start = { x: e.clientX, y: e.clientY };
      const prop = side === 'left' ? '--dock-left-w' : side === 'right' ? '--dock-right-w' : '--dock-bottom-h';
      const el = side === 'left' ? this.leftDock.el : side === 'right' ? this.rightDock.el : this.bottomDock;
      const startSize = side === 'bottom' ? el.getBoundingClientRect().height : el.getBoundingClientRect().width;
      const move = (ev) => {
        const d = side === 'left' ? ev.clientX - start.x : side === 'right' ? start.x - ev.clientX : start.y - ev.clientY;
        const max = side === 'bottom' ? innerHeight * 0.6 : innerWidth * 0.45;
        const v = Math.max(side === 'bottom' ? 90 : 180, Math.min(max, startSize + d));
        document.documentElement.style.setProperty(prop, `${v}px`);
      };
      // A drag ends on release, and also when the browser takes the pointer
      // away (pointercancel on touch, lost capture), or it would stay stuck.
      const ends = ['pointerup', 'pointercancel', 'lostpointercapture'];
      const up = () => {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        for (const t of ends) handle.removeEventListener(t, up);
        uiState.set(prop, getComputedStyle(document.documentElement).getPropertyValue(prop).trim());
      };
      handle.addEventListener('pointermove', move);
      for (const t of ends) handle.addEventListener(t, up);
    });
    const saved = uiState.get(side === 'left' ? '--dock-left-w' : side === 'right' ? '--dock-right-w' : '--dock-bottom-h', null);
    if (saved) document.documentElement.style.setProperty(side === 'left' ? '--dock-left-w' : side === 'right' ? '--dock-right-w' : '--dock-bottom-h', saved);
  }

  _clampDocks() {
    for (const prop of ['--dock-left-w', '--dock-right-w']) {
      const v = parseFloat(document.documentElement.style.getPropertyValue(prop));
      if (v && v > innerWidth * 0.45) document.documentElement.style.removeProperty(prop);
    }
  }

  applyDocks() {
    const compact = this.isCompact;
    if (compact) {
      // Drawers: closed until asked for.
      this.workspace.classList.toggle('show-left', !!this._drawerLeft);
      this.workspace.classList.toggle('show-right', !!this._drawerRight);
      this.leftDock.el.hidden = false;
      this.rightDock.el.hidden = false;
      this.scrim.hidden = !(this._drawerLeft || this._drawerRight);
    } else {
      this.workspace.classList.remove('show-left', 'show-right');
      this.leftDock.el.hidden = !this.leftOpen;
      this.rightDock.el.hidden = !this.rightOpen;
      this.scrim.hidden = true;
    }
    this._renderDock(this.leftDock);
    this._renderDock(this.rightDock);
    this.bottomDock.hidden = !this.bottomOpen;
    this._renderSideStrip();
  }

  _renderSideStrip() {
    clear(this.sideStrip);
    if (this.rightOpen) { this.sideStrip.hidden = true; return; }
    this.sideStrip.hidden = false;
    for (const id of RIGHT_PANELS) {
      if (id === 'layers' && this.activeEditor?.kind !== 'pcb') continue;
      this.sideStrip.append(h('button', { type: 'button', onClick: () => this.showPanel(id, true) }, PANEL_LABEL[id]));
    }
  }

  isPanelVisible(id) {
    if (LEFT_PANELS.includes(id)) return this.leftOpen && this.leftTab === id;
    if (RIGHT_PANELS.includes(id)) return this.rightOpen && this.rightTab === id;
    return id === 'messages' && this.bottomOpen;
  }

  /** Shows a panel; focusSearch moves focus to its search box (components). */
  showPanel(id, focus = false, focusSearch = false) {
    if (id === 'messages') { this.setBottomDock(true); return; }
    const left = LEFT_PANELS.includes(id);
    if (left) { this.leftTab = id; this.leftOpen = true; uiState.set('leftOpen', true); } else { this.rightTab = id; this.rightOpen = true; uiState.set('rightOpen', true); }
    const wasOpen = left ? this._drawerLeft : this._drawerRight;
    if (this.isCompact) { this._noteDrawerOpener(); this._drawerLeft = left; this._drawerRight = !left; }
    this.applyDocks();
    if (this.isCompact && !focus && !wasOpen) this._focusDrawer(left ? 'left' : 'right');
    if (focus) {
      const panel = this.panels[id];
      const target = focusSearch ? panel.el.querySelector('input[type=search]') : panel.el.querySelector('input, button, [tabindex="0"]');
      requestAnimationFrame(() => target?.focus());
    }
  }

  togglePanel(id) {
    if (this.isPanelVisible(id)) {
      if (LEFT_PANELS.includes(id)) { this.leftOpen = false; uiState.set('leftOpen', false); } else { this.rightOpen = false; uiState.set('rightOpen', false); }
      this.applyDocks();
    } else this.showPanel(id);
  }

  setBottomDock(open) {
    this.bottomOpen = open;
    this.bottomDock.hidden = !open;
    if (open) this.panels.messages.render();
  }

  /**
   * Closes the drawers. Dismissing them (Escape, the scrim) returns focus to
   * the control that opened them; otherwise (a document or part was chosen in
   * them) focus goes to the canvas.
   */
  closeDrawers({ restoreFocus = false } = {}) {
    const wasOpen = this._drawerLeft || this._drawerRight;
    this._drawerLeft = false;
    this._drawerRight = false;
    this.applyDocks();
    const opener = this._drawerOpener;
    this._drawerOpener = null;
    if (restoreFocus && wasOpen && opener?.isConnected && !opener.closest('[hidden]')) opener.focus();
    if (document.activeElement !== opener || !restoreFocus) this.activeEditor?.canvas.focus();
  }

  /** Remembers what had focus before a drawer opened (kept while switching drawers). */
  _noteDrawerOpener() {
    const a = document.activeElement;
    if (this._drawerLeft || this._drawerRight) return;
    this._drawerOpener = a && a !== document.body ? a : null;
  }

  /**
   * Moves focus into an opened drawer, onto its selected panel tab: from
   * there Tab reaches the panel and Escape still closes the drawer (a field
   * would take Escape for itself).
   */
  _focusDrawer(side) {
    const dock = side === 'left' ? this.leftDock : this.rightDock;
    dock.tabs.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
  }

  resetLayout() {
    for (const k of ['--dock-left-w', '--dock-right-w', '--dock-bottom-h']) { document.documentElement.style.removeProperty(k); uiState.set(k, null); }
    this.leftOpen = true; this.rightOpen = true; this.leftTab = 'projects'; this.rightTab = 'properties';
    uiState.set('leftOpen', true); uiState.set('rightOpen', true);
    this.applyDocks();
  }

  refreshMenus() {
    this.menubar.setMenus(buildMenus(this));
  }

  renderThemeButton() {
    clear(this.themeBtn);
    const t = currentTheme();
    this.themeBtn.append(icon(t === 'system' ? 'monitor' : t === 'dark' ? 'moon' : 'sun', 17));
    this.themeBtn.setAttribute('aria-label', `Theme: ${t === 'system' ? 'match system' : t}`);
  }

  _themeMenu() {
    openMenu([{ command: 'theme.system' }, { command: 'theme.light' }, { command: 'theme.dark' }], { anchor: this.themeBtn, label: 'Theme' });
  }

  _mobileMenu(e) {
    const menus = buildMenus(this);
    openMenu(menus.map((m) => ({ label: m.label, items: m.items })), { anchor: e.currentTarget, label: 'Menu' });
  }

  renderMobileBar() {
    const b = this.mobileBar;
    clear(b);
    const btn = (ico, label, run, pressed) => h('button.icon-btn', { type: 'button', 'aria-label': label, 'aria-pressed': pressed === undefined ? null : String(pressed), onClick: run }, icon(ico, 20));
    b.append(
      btn('tree', 'Project', () => this._toggleDrawer('left')),
      btn('package', 'Components', () => this.showPanel('components', true)),
      btn('settings', 'Properties', () => this.showPanel('properties')),
      h('span.grow'),
      btn('undo', 'Undo', () => this.commands.run('edit.undo')),
      btn('redo', 'Redo', () => this.commands.run('edit.redo')),
      btn('fit', 'Fit', () => this.commands.run('view.fit')),
      btn('trash', 'Delete selection', () => this.commands.run('edit.delete')),
      btn('more', 'More', (e) => openMenu(buildMenus(this).map((m) => ({ label: m.label, items: m.items })), { anchor: e.currentTarget, label: 'More' })),
    );
  }

  _toggleDrawer(side) {
    const opening = side === 'left' ? !this._drawerLeft : !this._drawerRight;
    if (opening) this._noteDrawerOpener();
    if (side === 'left') { this._drawerLeft = !this._drawerLeft; this._drawerRight = false; } else { this._drawerRight = !this._drawerRight; this._drawerLeft = false; }
    this.applyDocks();
    if (opening) this._focusDrawer(side);
    else this._drawerOpener = null;
  }

  // ---------- Account ----------

  renderAccount() {
    const el = this.accountEl;
    clear(el);
    // puter.js's user menu holds the account where it renders.
    el.hidden = !!this.userMenu;
    if (this.userMenu) return;
    if (!P.puter()) return;
    if (!this.user) {
      if (this.env === 'app') return;
      el.append(h('button.btn.sm', { type: 'button', onClick: () => this.signIn(), 'data-tip': 'Sign in to save projects to your Puter cloud' }, icon('login', 14), h('span.phone-hide', 'Sign in')));
      return;
    }
    const avatar = this.picture ? h('img.avatar', { src: this.picture, alt: '' }) : h('span.avatar.initial', (this.user.username || '?')[0].toUpperCase());
    const btn = h('button.account-btn', { type: 'button', 'aria-label': `Account: ${this.user.username}`, 'aria-haspopup': 'menu' }, avatar);
    btn.addEventListener('click', () => {
      const items = [{ heading: this.user.username }, { label: 'Preferences', icon: 'settings', run: () => this.preferences() }];
      // Inside the Puter desktop the session belongs to Puter, so there is no sign out here.
      if (this.env !== 'app') items.push({ separator: true }, { label: 'Sign out', icon: 'logout', run: () => this.signOut() });
      openMenu(items, { anchor: btn, label: 'Account' });
    });
    el.append(btn);
  }

  async signIn() {
    try {
      await P.signIn();
      await this._signedIn();
    } catch (err) {
      if (err?.error !== 'auth_window_closed') toast('Sign in did not complete.', { kind: 'info' });
    }
  }

  /** After signing in here, or after puter.js's user menu signed in. */
  async _signedIn() {
    await this._loadUser();
    this.renderAccount();
    this.userLibrary.load();
    toast(`Signed in as ${this.user?.username || 'you'}. New projects are saved to your Puter cloud.`, { kind: 'success' });
    if (this.project && this.location?.type === 'local') {
      toast('This project is stored in this browser only.', {
        title: 'Keep it in your cloud?', timeout: 0,
        actions: [{ label: 'Move to cloud', primary: true, run: () => this.moveToCloud() }, { label: 'Not now' }],
      });
    }
  }

  async signOut() {
    if (this.project?.dirty) await this.save();
    await P.signOut();
    await this._signedOut();
  }

  /** After signing out here, or after puter.js's user menu signed out by itself. */
  async _signedOut() {
    this.user = null;
    this.picture = null;
    this.renderAccount();
    if (this.location?.type === 'cloud') await this.closeProject(true);
    toast('Signed out.');
  }

  async moveToCloud() {
    if (!this.project || !P.cloudAvailable()) return;
    const old = this.location;
    this.location = await storage.newLocation(this.project.name, this.project.id);
    await this.save();
    if (old?.type === 'local' && this.location.type === 'cloud') await storage.deleteProject(old).catch(() => {});
    toast('Project moved to your Puter cloud.', { kind: 'success' });
    this.panels.projects.refresh();
  }

  applyPreferences() {
    applyTheme(this.settings.get('theme'));
    this.renderThemeButton();
    for (const e of this.editors.values()) { e.requestRender(true); e._updateHud?.(); e._scheduleLabels?.(); }
    this.updateStatus();
    this._scheduleAutosave();
  }

  // ---------- Project lifecycle ----------

  setProject(project, location) {
    this._disposeEditors();
    this._unsubProject?.();
    // Check results belong to the project they were run on.
    this.panels.messages.set([], '');
    this.project = project;
    this.location = location;
    this.saveState = project.dirty ? 'dirty' : 'saved';
    // Autosave and version timing belong to one project; start afresh.
    clearTimeout(this._autosaveTimer);
    this._dirtySince = 0;
    this._lastVersionAt = 0;
    this._saveErrorShown = false;
    const offs = [
      project.on('docchange', () => this._onProjectChanged()),
      project.on('meta', () => this._onProjectChanged()),
      project.on('docs', () => { this.renderTabs(); this.panels.projects.refresh(); this.refreshMenus(); }),
      project.on('library', () => { this.panels.components.refresh(); }),
    ];
    this._unsubProject = () => offs.forEach((f) => f());
    try { if (location) localStorage.setItem(LAST_KEY, JSON.stringify(location)); } catch { /* storage unavailable */ }
    const first = project.sheets[0] || project.docs[0];
    this.hideStart();
    if (first) this.openDoc(first.id); else this.showStart();
    this.panels.projects.refresh();
    this.panels.components.refresh();
    this.updateTitle();
    this.emit('project', project);
  }

  _onProjectChanged() {
    if (this.saveState !== 'saving') this.saveState = 'dirty';
    this.updateTitle();
    clearTimeout(this._uiTimer);
    this._uiTimer = setTimeout(() => {
      this.panels.projects.refresh();
      this.renderTabs();
      if (this.isPanelVisible('navigator')) this.panels.navigator.refresh();
      this.panels.properties.refresh();
    }, 120);
    this._scheduleAutosave();
  }

  _scheduleAutosave() {
    clearTimeout(this._autosaveTimer);
    const minutes = Number(this.settings.get('autosaveMinutes'));
    if (!this.project || !this.location || !(minutes > 0) || !this.project.dirty) return;
    // Save shortly after edits pause, and at least every N minutes while editing.
    const now = Date.now();
    this._dirtySince ||= now;
    const maxWait = minutes * 60_000;
    const delay = Math.max(0, Math.min(4000, maxWait - (now - this._dirtySince)));
    this._autosaveTimer = setTimeout(() => this.save({ auto: true }), delay);
  }

  _flushSave() {
    if (this.project?.dirty && this.location && Number(this.settings.get('autosaveMinutes')) > 0) this.save({ auto: true });
  }

  updateTitle() {
    const p = this.project;
    const doc = this.activeEditor?.doc;
    clear(this.docTitle);
    if (!p) { this.docTitle.append('Start'); document.title = 'Circuits'; this.saveBadge.textContent = ''; return; }
    this.docTitle.append(h('strong', p.name), doc ? ` . ${doc.name}` : '');
    document.title = `${doc ? `${doc.name} - ` : ''}${p.name} - Circuits`;
    const state = this.saveState === 'saving' ? 'Saving...' : this.saveState === 'error' ? 'Not saved' : p.dirty ? 'Edited' : this.location ? `Saved${this.location.type === 'local' ? ' in this browser' : ''}` : 'Not saved yet';
    this.saveBadge.textContent = state;
    this.saveBadge.classList.toggle('sev-error', this.saveState === 'error');
  }

  async newProject() {
    if (!(await this._confirmLeave())) return;
    const name = await promptDialog({ title: 'New project', label: 'Project name', value: 'Untitled', confirm: 'Create', validate: (v) => (!v ? 'Enter a name' : null) });
    if (!name) return;
    const project = new Project(newProjectData(name));
    let location = null;
    try { location = await storage.newLocation(name, project.id); } catch (err) { toast(`Could not prepare storage: ${err.message}`, { kind: 'warning' }); }
    this.setProject(project, location);
    if (location) await this.save({ quiet: true });
    announce(`Project ${name} created`);
  }

  async openExample() {
    if (!(await this._confirmLeave())) return;
    const project = createExampleProject();
    project.markSaved();
    // The example is not saved anywhere until the user chooses Save.
    this.setProject(project, null);
    this.saveState = 'dirty';
    this.updateTitle();
    toast('This is an example project. Save it to keep your changes.', { title: 'LED Blinker example', timeout: 6000, actions: [{ label: 'Save', primary: true, run: () => this.save() }] });
  }

  async openLocation(location, { quiet = false } = {}) {
    if (this.project && storage.sameLocation(location, this.location)) return true;
    if (!(await this._confirmLeave())) return false;
    // Opens can overlap (a slow file, then another choice): the last one asked for wins.
    const token = (this._openToken = (this._openToken || 0) + 1);
    // Changes the user has just chosen to discard are not asked about again below.
    const open = this.project;
    const stamp = () => open.docs.map((d) => `${d.id}:${d.store.revision}`).join();
    let discarded = open?.dirty ? stamp() : null;
    const offMeta = open?.on('meta', () => { discarded = null; });
    try {
      const text = await storage.loadText(location);
      const project = parseProject(text);
      if (token !== this._openToken) return false;
      // Edits made to the open project while this one loaded are saved or asked about.
      const edited = this.project?.dirty && !(this.project === open && discarded !== null && discarded === stamp());
      if (edited && (!(await this._confirmLeave()) || token !== this._openToken)) return false;
      project.markSaved();
      this.setProject(project, location);
      storage.rememberRecent({ location, name: project.name });
      return true;
    } catch (err) {
      const why = P.isMissing(err) ? 'the file no longer exists.' : fileError(err);
      if (!quiet) toast(`Could not open the project: ${why}`, { kind: 'error' });
      if (P.isMissing(err)) storage.forgetRecent(location);
      return false;
    } finally {
      offMeta?.();
    }
  }

  async openProjectDialog() { await dialogs.openProjectDialog(this); }

  async openFromCloudPicker() {
    try {
      const picked = await storage.pickCloudFile();
      if (!picked) return;
      if (!(await this._confirmLeave())) return;
      const project = parseProject(picked.text);
      project.markSaved();
      this.setProject(project, picked.location);
      storage.rememberRecent({ location: picked.location, name: project.name });
    } catch (err) { toast(`Could not open the file: ${err.message}`, { kind: 'error' }); }
  }

  async importFromDevice() {
    const files = await pickFiles('.circuits,.json,.kicad_sch,.kicad_pcb,.kicad_pro');
    if (!files.length) return;
    if (files.some((f) => /\.kicad_(sch|pcb|pro)$/i.test(f.name))) { await this.importKicad(files); return; }
    const f = { text: await files[0].text(), name: files[0].name.replace(/\.(circuits|json)$/i, '') };
    let project;
    try {
      project = parseProject(f.text);
    } catch (err) {
      toast(fileError(err), { kind: 'error', title: 'Could not open the file' });
      return;
    }
    if (!(await this._confirmLeave())) return;
    try {
      // Imported projects get a fresh identity and a new storage location, so
      // opening a downloaded copy never overwrites the project it came from.
      project.id = uid('p');
      const location = await storage.newLocation(project.name, project.id).catch(() => null);
      this.setProject(project, location);
      if (location) await this.save({ quiet: true });
      toast(`Opened ${f.name}.`, { kind: 'success' });
    } catch (err) { toast(err.message, { kind: 'error', title: 'Could not open the file' }); }
  }

  /** Imports KiCad schematics and boards as a new project. */
  async importKicad(fileList) {
    const files = fileList || await pickFiles('.kicad_sch,.kicad_pcb,.kicad_pro');
    if (!files.length) return;
    if (!(await this._confirmLeave())) return;
    const t = toast('Importing...', { timeout: 0 });
    try {
      const { importKicad } = await import('../io/kicad/index.js');
      const { project: data, warnings } = await importKicad(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
      const project = parseProject(data);
      const location = await storage.newLocation(project.name, project.id).catch(() => null);
      this.setProject(project, location);
      if (location) await this.save({ quiet: true });
      for (const d of project.boards) this.editors.get(d.id)?.fitAll(false);
      if (warnings.length) {
        this.panels.messages.set(warnings.map((w) => ({ severity: 'warning', message: w })), 'Import');
        this.setBottomDock(true);
      }
      toast(`Imported ${files.length} file${files.length === 1 ? '' : 's'}${warnings.length ? ` with ${warnings.length} note${warnings.length === 1 ? '' : 's'} (see Messages)` : ''}. Run Compile and a design rule check to review the result.`, { kind: 'success', title: 'Import finished', timeout: 8000 });
    } catch (err) {
      toast(err.message || String(err), { kind: 'error', title: 'Import failed' });
    } finally { t.close(); }
  }

  share() { return shareDialog(this); }
  history() { return historyDialog(this); }
  gettingStarted() { dialogs.gettingStartedDialog(this); }

  async save({ auto = false, quiet = false } = {}) {
    const p = this.project;
    if (!p) return false;
    if (!this.location) {
      if (auto) return false;
      try { this.location = await storage.newLocation(p.name, p.id); } catch (err) { toast(err.message, { kind: 'error' }); return false; }
    }
    if (this._saving) {
      if (auto) { this._saveAgain = true; return this._saving; }
      // Asked for by the user: once this write is done, write again what was edited after it began.
      return this._saving.then(() => (this.project === p && p.dirty ? this.save({ quiet }) : !p.dirty));
    }
    clearTimeout(this._autosaveTimer);
    this.saveState = 'saving';
    this.updateTitle();
    const revisions = p.docs.map((d) => d.store.revision);
    // Renames, added or removed documents and library changes do not move a
    // document's revision, so they are watched for separately.
    let metaChanged = false;
    const offMeta = p.on('meta', () => { metaChanged = true; });
    const run = (async () => {
      try {
        const text = JSON.stringify(p.toJSON());
        const location = await storage.saveText(this.location, p.name, text);
        // Only mark saved if nothing changed while writing.
        if (!metaChanged && p.docs.every((d, i) => d.store.revision === revisions[i])) p.markSaved();
        // Another project may have opened while writing: the location, the
        // badge and the timers are its own now.
        if (this.project !== p) { recordVersion(location, p.id, text); return true; }
        this.location = location;
        this.saveState = p.dirty ? 'dirty' : 'saved';
        this._dirtySince = 0;
        this._saveErrorShown = false; // a later failure is a new problem to report
        try { localStorage.setItem(LAST_KEY, JSON.stringify(this.location)); } catch { /* storage unavailable */ }
        if (!auto && !quiet) announce('Project saved');
        // Keep a restorable version (throttled while autosaving).
        recordVersion(this.location, p.id, text, { auto, lastAt: this._lastVersionAt || 0 }).then((at) => { if (this.project === p) this._lastVersionAt = at; });
        return true;
      } catch (err) {
        if (this.project !== p) return false;
        this.saveState = 'error';
        if (!auto || !this._saveErrorShown) {
          this._saveErrorShown = true;
          toast(`${err.message || err}. Download a copy to keep your work safe.`, { kind: 'error', title: 'Could not save', actions: [{ label: 'Download', primary: true, run: () => this.downloadProject() }] });
        }
        return false;
      } finally {
        offMeta();
        this._saving = null;
        this.updateTitle();
        this.renderTabs();
        this.panels.projects.refresh();
        if (this._saveAgain) { this._saveAgain = false; this._scheduleAutosave(); }
      }
    })();
    this._saving = run;
    return run;
  }

  async saveAs() {
    const p = this.project;
    if (!p) return;
    const text = JSON.stringify(p.toJSON());
    if (P.cloudAvailable() && P.puter()?.ui?.showSaveFilePicker) {
      try {
        const loc = await storage.pickCloudSave(text, p.name);
        if (!loc) return;
        this.location = loc;
        p.markSaved();
        this.saveState = 'saved';
        storage.rememberRecent({ location: loc, name: p.name });
        this.updateTitle();
        toast('Saved.', { kind: 'success', timeout: 2000 });
      } catch (err) { toast(`Could not save: ${err.message}`, { kind: 'error' }); }
      return;
    }
    const name = await promptDialog({ title: 'Save a copy', label: 'Project name', value: `${p.name} copy`, confirm: 'Save', validate: (v) => (!v ? 'Enter a name' : null) });
    if (!name) return;
    // Find the new location first: if that fails, the project must stay as
    // it was, or its next save would write the copy over the original.
    const id = `${p.id}-${Date.now().toString(36)}`;
    let location;
    try {
      location = await storage.newLocation(name, id);
    } catch (err) {
      toast(`Could not save a copy: ${err.message}`, { kind: 'error' });
      return;
    }
    p.rename(name);
    p.id = id;
    this.location = location;
    await this.save();
    this.panels.projects.refresh();
  }

  downloadProject() {
    if (!this.project) return;
    storage.download(JSON.stringify(this.project.toJSON(), null, 1), `${storage.safeName(this.project.name)}${storage.EXT}`, 'application/json');
  }

  async renameProject() {
    const p = this.project;
    const name = await promptDialog({ title: 'Rename project', label: 'Project name', value: p.name, validate: (v) => (!v ? 'Enter a name' : null) });
    if (!name || name === p.name) return;
    p.rename(name);
    if (this.location?.type === 'cloud') {
      try { this.location = await storage.renameCloud(this.location, name); } catch (err) { toast(`The file kept its old name: ${err.message}`, { kind: 'warning' }); }
    }
    await this.save({ quiet: true });
    this.panels.projects.refresh();
    this.updateTitle();
  }

  /** Asks before replacing a project with unsaved changes. */
  async _confirmLeave() {
    // Components open in the editor first: saving one changes the project.
    for (const id of [...this._libDocs.keys()]) if (!(await this._confirmCloseLib(id))) return false;
    const p = this.project;
    if (!p || !p.dirty) return true;
    if (this.location) { await this.save({ quiet: true }); if (!p.dirty) return true; }
    const r = await choiceDialog({
      title: 'Unsaved changes',
      message: `${p.name} has changes that are not saved.`,
      choices: [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard changes', value: 'discard', danger: true }, { label: 'Save', value: 'save', primary: true }],
    });
    if (r === 'save') return this.save();
    return r === 'discard';
  }

  async closeProject(force = false) {
    if (!force && !(await this._confirmLeave())) return;
    this._disposeEditors();
    this._unsubProject?.();
    this.project = null;
    this.location = null;
    this.panels.messages.set([], '');
    try { localStorage.removeItem(LAST_KEY); } catch { /* storage unavailable */ }
    this.showStart();
    this.panels.projects.refresh();
    this.updateTitle();
    this.updateStatus();
    this.emit('project', null);
  }

  // ---------- Documents and tabs ----------

  _disposeEditors() {
    this.set3d(false);
    for (const e of this.editors.values()) e.dispose();
    this.editors.clear();
    this._libDocs.clear();
    this.openTabs = [];
    this.activeDocId = null;
    this.renderTabs();
  }

  _createEditor(doc) {
    const ed = doc.kind === 'lib' ? new LibEditor(this, this.project, doc) : doc.kind === 'sch' ? new SchEditor(this, this.project, doc) : new PcbEditor(this, this.project, doc);
    this.editorHost.append(ed.el);
    const props = () => { cancelAnimationFrame(this._propsFrame); this._propsFrame = requestAnimationFrame(() => { this.panels.properties.refresh(); this.updateStatus(); }); };
    ed.on('selection', props);
    ed.on('cursor', () => { if (this.activeEditor === ed) this.updateCursor(); });
    ed.on('tool', () => { if (this.activeEditor === ed) { this.updateActiveBar(); this.updateStatus(); } });
    ed.on('layer', () => { if (this.activeEditor === ed) { this.updateStatus(); if (this.isPanelVisible('layers')) this.panels.layers.refresh(); } });
    ed.on('layers', () => { if (this.isPanelVisible('layers')) this.panels.layers.refresh(); });
    ed.on('connectivity', () => { if (this.activeEditor === ed) { this.updateStatus(); if (this.isPanelVisible('navigator')) this.panels.navigator.refresh(); } });
    ed.on('highlight', () => { if (this.isPanelVisible('navigator')) this.panels.navigator.refresh(); });
    ed.on('drc', () => { if (this.activeEditor === ed) this.updateStatus(); });
    ed.on('pours', () => { if (this.view3dOpen && this.activeEditor === ed) this._update3d(); });
    const offStore = ed.doc.store.on('change', () => { if (this.view3dOpen && this.activeEditor === ed) { clearTimeout(this._3dTimer); this._3dTimer = setTimeout(() => this._update3d(), 300); } });
    // The document outlives the editor (tabs close and reopen), so let go of it.
    const dispose = ed.dispose.bind(ed);
    ed.dispose = () => { offStore(); dispose(); };
    this._buildActiveBar(ed);
    return ed;
  }

  openDoc(id) {
    const doc = this._doc(id);
    if (!doc) return;
    this.hideStart();
    if (!this.openTabs.includes(id)) this.openTabs.push(id);
    let ed = this.editors.get(id);
    // Browsers keep a limited number of WebGL contexts and drop the oldest
    // for good, which leaves that editor's canvas blank: with many documents
    // open, an editor that lost its context is rebuilt when it is shown.
    let view = null;
    if (ed?.renderer?.gl?.isContextLost?.()) { view = { ...ed.renderer.view }; ed.dispose(); this.editors.delete(id); ed = null; }
    if (!ed) { ed = this._createEditor(doc); this.editors.set(id, ed); }
    if (this.view3dOpen && this.activeDocId !== id) this.set3d(false);
    this.activeDocId = id;
    for (const [k, e] of this.editors) e.el.hidden = k !== id;
    this.commands.context = doc.kind;
    this.renderTabs();
    this.refreshMenus();
    this.applyDocks();
    this.updateTitle();
    this.updateStatus();
    this.panels.properties.refresh();
    this.panels.navigator.refresh();
    if (this.isCompact) this.closeDrawers();
    // Size the view now (layout is synchronous) so coordinates are valid at once.
    ed._resize();
    if (view && ed.renderer) { Object.assign(ed.renderer.view, view); ed.onViewChanged(); }
    ed.requestRender(true);
    ed.canvas.focus({ preventScroll: true });
  }

  async closeTab(id, force = false) {
    const i0 = this.openTabs.indexOf(id);
    if (i0 < 0) return;
    if (!force && this._libDocs.has(id)) {
      if (!(await this._confirmCloseLib(id))) return;
      this._libDocs.delete(id);
    }
    const i = this.openTabs.indexOf(id);
    if (i < 0) return;
    this.openTabs.splice(i, 1);
    const ed = this.editors.get(id);
    if (ed) { if (this.view3dOpen && this.activeDocId === id) this.set3d(false); ed.dispose(); this.editors.delete(id); }
    if (this.activeDocId === id) {
      this.activeDocId = null;
      const next = this.openTabs[Math.min(i, this.openTabs.length - 1)];
      if (next) this.openDoc(next);
      else { this.commands.context = null; this.renderTabs(); this.refreshMenus(); this.applyDocks(); this.showStart(); this.updateTitle(); this.updateStatus(); }
    } else this.renderTabs();
  }

  async closeAllTabs() { for (const id of [...this.openTabs]) await this.closeTab(id); }

  cycleTab(d) {
    if (!this.openTabs.length) return;
    const i = this.openTabs.indexOf(this.activeDocId);
    this.openDoc(this.openTabs[(i + d + this.openTabs.length) % this.openTabs.length]);
  }

  removeDoc(id) {
    this.closeTab(id);
    this.project.removeDoc(id);
    // Its check results would otherwise point into whichever document is open.
    const msgs = this.panels.messages;
    if (msgs.items.some((m) => m.docId === id)) { msgs.set(msgs.items.filter((m) => m.docId !== id), msgs.source); this.updateStatus(); }
  }

  addDoc(kind) {
    const doc = kind === 'sch' ? this.project.addSheet() : this.project.addBoard();
    this.openDoc(doc.id);
    return doc;
  }

  renderTabs() {
    clear(this.docTabs);
    const list = h('div.doc-tab-list', { role: 'tablist', 'aria-label': 'Open documents' });
    this.docTabs.append(list);
    for (const id of this.openTabs) {
      const d = this._doc(id);
      if (!d) continue;
      const sel = id === this.activeDocId;
      // The close cross is a pointer shortcut; keyboard users press Delete or Alt+W.
      const tab = h('div.doc-tab', { role: 'tab', 'aria-selected': String(sel), tabindex: sel ? 0 : -1, title: d.kind === 'lib' ? `Component: ${d.name}` : d.name, 'aria-keyshortcuts': 'Delete' },
        icon(d.kind === 'lib' ? 'package' : d.kind === 'sch' ? 'symbol' : 'board', 14), h('span.name', d.name), d.dirty ? h('span.dot', { title: 'Edited' }, h('span.sr-only', ', edited')) : null,
        h('span.close', { 'aria-hidden': 'true', title: `Close ${d.name}`, onClick: (e) => { e.stopPropagation(); this.closeTab(id); } }, icon('x', 12)));
      tab.addEventListener('click', () => this.openDoc(id));
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) this.closeTab(id); });
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openDoc(id); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); this.cycleTab(e.key === 'ArrowRight' ? 1 : -1); this.docTabs.querySelector('[aria-selected="true"]')?.focus(); }
        if (e.key === 'Delete') { e.preventDefault(); this.closeTab(id); }
      });
      list.append(tab);
    }
    if (this.project) {
      this.docTabs.append(h('button.doc-tab', { type: 'button', 'aria-label': 'Open another document', 'data-tip': 'Open a document', onClick: (e) => openMenu([
        ...this.project.docs.map((d) => ({ label: d.name, icon: d.kind === 'sch' ? 'symbol' : 'board', run: () => this.openDoc(d.id) })),
        { separator: true }, { command: 'project.addSheet' }, { command: 'project.addBoard' },
      ], { anchor: e.currentTarget, label: 'Documents' }) }, icon('plus', 14)));
    }
  }

  // ---------- Start page ----------

  showStart() {
    this.hideStart();
    const recent = storage.recentProjects();
    const card = (ico, title, text, run) => h('button.start-card', { type: 'button', onClick: run }, icon(ico, 22), h('strong', title), h('span', text));
    const list = h('ul.recent-list');
    for (const r of recent.slice(0, 8)) {
      const b = h('button', { type: 'button', onClick: () => this.openLocation(r.location) }, icon(r.location.type === 'cloud' ? 'cloud' : 'drive', 16), h('span.grow', r.name), h('span.small.muted', storage.locationLabel(r.location)));
      list.append(h('li', b));
    }
    const signedOut = P.puter() && !P.cloudAvailable();
    this.start = h('div.start-page', { role: 'region', 'aria-label': 'Start' }, h('div.start-inner',
      h('h1', 'Design circuit boards in your browser'),
      h('p.lead', 'Draw schematics, lay out and route boards, pour copper, check design rules and export Gerber files for manufacturing.',
        signedOut ? ' You can work without an account; projects stay in this browser until you sign in.' : ''),
      h('div.start-actions',
        card('new', 'New project', 'A schematic sheet and a board, ready to go', () => this.newProject()),
        card('chip', 'Open the example', 'A 555 LED blinker with its board', () => this.openExample()),
        card('open', 'Open a project', P.cloudAvailable() ? 'From your Puter cloud or this browser' : 'Stored in this browser', () => this.openProjectDialog()),
        card('upload', 'Open a file', 'A .circuits project, or KiCad schematic and board files', () => this.importFromDevice())),
      recent.length ? h('section.start-section', h('h2', 'Recent'), list) : null,
      signedOut ? h('p.muted', { style: { marginTop: '24px' } }, h('button.btn', { type: 'button', onClick: () => this.signIn() }, icon('login', 14), 'Sign in to Puter'), ' to keep projects in your own cloud storage and open them anywhere.') : null));
    this.editorHost.append(this.start);
    this.updateTitle();
  }

  hideStart() { this.start?.remove(); this.start = null; }

  // ---------- Active bar ----------

  _buildActiveBar(ed) {
    // The component editor builds its own bar, which changes with its view.
    if (ed.buildActiveBar) { ed.buildActiveBar(); return; }
    const bar = h('div.activebar', { role: 'toolbar', 'aria-label': ed.kind === 'sch' ? 'Schematic tools' : 'Board tools' });
    const tools = ed.kind === 'sch' ? [
      ['select', 'pointer', 'Select', () => ed.endTool()],
      ['|'],
      ['part', 'part', 'Place part', () => this.showPanel('components', true, true)],
      ['wire', 'wire', 'Wire', () => ed.startTool('wire'), 'Shift+W'],
      ['bus', 'bus', 'Bus', () => ed.startTool('bus')],
      ['label', 'net-label', 'Net label', () => ed.startTool('label')],
      ['power', 'power', 'Power port', () => ed.startTool('power')],
      ['ground', 'ground', 'Ground', () => ed.startTool('ground')],
      ['port', 'port', 'Port', () => ed.startTool('port')],
      ['noerc', 'no-erc', 'No ERC marker', () => ed.startTool('noerc')],
      ['text', 'text', 'Text', () => ed.startTool('text')],
      ['line', 'line-tool', 'Line', () => ed.startTool('line')],
      ['|'],
      ['erc', 'erc', 'Compile and check', () => this.compile()],
    ] : [
      ['select', 'pointer', 'Select', () => ed.endTool()],
      ['|'],
      ['component', 'component', 'Place component', () => this.showPanel('components', true, true)],
      ['route', 'route', 'Interactive routing', () => ed.startTool('route'), 'Shift+W'],
      ['via', 'via', 'Via', () => ed.startTool('via')],
      ['pour', 'pour', 'Polygon pour', () => ed.startTool('pour')],
      ['fill', 'fill', 'Fill', () => ed.startTool('fill')],
      ['keepout', 'keepout', 'Keep-out region', () => ed.startTool('keepout')],
      ['text', 'text', 'Text', () => ed.startTool('text')],
      ['line', 'line-tool', 'Line', () => ed.startTool('line')],
      ['dim', 'dimension', 'Dimension', () => ed.startTool('dim')],
      ['measure', 'measure', 'Measure', () => ed.startTool('measure'), 'Mod+M'],
      ['|'],
      ['drc', 'drc', 'Design rule check', () => this.runDrc()],
      ['3d', 'cube', '3D view', () => this.set3d(!this.view3dOpen), '3'],
    ];
    ed.toolButtons = new Map();
    for (const [id, ico, label, run, kbd] of tools) {
      if (id === '|') { bar.append(h('span.ab-sep', { role: 'separator' })); continue; }
      const btn = h('button.ab-btn', { type: 'button', 'aria-label': label, 'data-tip': label, 'data-kbd': kbd || '', 'aria-pressed': 'false', onClick: () => { run(); this.updateActiveBar(); } }, icon(ico, 18));
      ed.toolButtons.set(id, btn);
      bar.append(btn);
    }
    ed.wrap.append(bar);
    ed.activeBar = bar;
  }

  updateActiveBar() {
    const ed = this.activeEditor;
    if (!ed?.toolButtons) return;
    const name = ed.tool === ed.select ? 'select' : ed.tool?.abId || (ed.tool?.kind === 'gline' ? 'line' : ed.tool?.kind || ed.tool?.name);
    const map = { wire: 'wire', bus: 'bus', 'net label': 'label', 'power port': 'power', 'ground port': 'ground', port: 'port', 'no ERC marker': 'noerc', text: 'text', line: 'line', route: 'route', via: 'via', pour: 'pour', fill: 'fill', keepout: 'keepout', dim: 'dim', measure: 'measure', 'polygon pour': 'pour', 'keep-out': 'keepout', dimension: 'dim' };
    const active = map[name] || name;
    for (const [id, btn] of ed.toolButtons) btn.setAttribute('aria-pressed', String(id === active || (id === '3d' && this.view3dOpen)));
  }

  // ---------- Status bar ----------

  updateCursor() {
    const ed = this.activeEditor;
    if (!ed || !this.coordsCell) return;
    const u = ed.kind === 'sch' || ed.units === 'mil' ? 'mil' : this.settings.get('units');
    const o = ed.kind === 'pcb' ? ed.doc.board.origin || { x: 0, y: 0 } : { x: 0, y: 0 };
    const c = ed.cursor;
    this.coordsCell.textContent = `X: ${formatLength(c.x - o.x, u)}  Y: ${formatLength(c.y - o.y, u)}`;
  }

  updateStatus() {
    const s = this.status;
    clear(s);
    const ed = this.activeEditor;
    const cell = (content, opts = {}) => (opts.onClick ? h('button.cell', { type: 'button', ...opts }, content) : h('span.cell', opts, content));
    this.coordsCell = h('span.cell.coords', { 'aria-hidden': 'true' });
    s.append(this.coordsCell);
    if (ed) {
      this.updateCursor();
      const u = ed.kind === 'sch' || ed.units === 'mil' ? 'mil' : this.settings.get('units');
      s.append(cell(`Grid: ${formatLength(ed.grid, u)}`, { onClick: () => this.commands.run('view.setGrid'), 'data-tip': 'Change the snap grid', 'data-kbd': 'G' }));
      if (ed.kind === 'pcb') {
        s.append(cell([h('span.swatch', { style: { background: ed.layerColor(ed.activeLayer) } }), LAYERS[ed.activeLayer].name], { onClick: () => this.showPanel('layers'), 'data-tip': 'Current layer' }));
        const a = ed._analysis;
        const unrouted = a ? [...a.unrouted.values()].reduce((x, y) => x + y, 0) : 0;
        s.append(cell(unrouted ? `${unrouted} unrouted` : 'Routed', { class: unrouted ? 'sev-warning' : '' }));
        if (ed.violations.length) s.append(cell([icon('error', 13), `${ed.violations.length} rule violation${ed.violations.length === 1 ? '' : 's'}`], { onClick: () => this.runDrc(), class: 'sev-error' }));
      }
      if (ed.selection?.size) s.append(cell(`${ed.selection.size} selected`));
      s.append(cell(this.settings.get('units'), { onClick: () => this.commands.run('view.toggleUnits'), 'data-tip': 'Switch units', 'data-kbd': 'Q' }));
    }
    s.append(h('span.spacer'));
    const msgs = this.panels.messages.items;
    if (msgs.length) {
      const e = msgs.filter((m) => m.severity === 'error').length, w = msgs.length - e;
      s.append(cell([h('span.sev-error', icon('error', 13), e), h('span.sev-warning', icon('warning', 13), w)], { onClick: () => this.setBottomDock(!this.bottomOpen), class: 'msg-count', 'aria-label': `${e} errors, ${w} warnings. Show messages` }));
    }
    s.append(h('span.cell.powered.tablet-hide', 'Built on ', h('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener noreferrer' }, 'Puter')));
    s.append(cell([icon('panel-right', 14), 'Panels'], { onClick: (e) => openMenu([{ command: 'panel.projects' }, { command: 'panel.navigator' }, { command: 'panel.properties' }, { command: 'panel.components' }, { command: 'panel.layers' }, { command: 'panel.messages' }, { separator: true }, { command: 'window.resetLayout' }], { anchor: e.currentTarget, label: 'Panels' }) }));
  }

  // ---------- Editing actions ----------

  undo() { const ed = this.activeEditor; if (ed?.doc.store.undo()) announce(`Undid ${ed.doc.store.redoLabel || 'change'}`); }
  redo() { const ed = this.activeEditor; if (ed?.doc.store.redo()) announce(`Redid ${ed.doc.store.undoLabel || 'change'}`); }

  copy() {
    const clip = this.activeEditor?.copySelection();
    if (!clip) return;
    this.clipboard = clip;
    try { navigator.clipboard?.writeText(JSON.stringify({ circuitsClipboard: 1, ...clip })).catch(() => {}); } catch { /* clipboard unavailable */ }
    announce(`Copied ${clip.objects.length} object${clip.objects.length === 1 ? '' : 's'}`);
  }

  cut() { this.copy(); this.activeEditor?.deleteSelection(); }

  async paste() {
    const ed = this.activeEditor;
    if (!ed) return;
    let clip = this.clipboard;
    try {
      const text = await navigator.clipboard?.readText?.();
      const data = text && text.startsWith('{') ? JSON.parse(text) : null;
      if (data?.circuitsClipboard) clip = data;
    } catch { /* use the in-app clipboard */ }
    if (!clip) { toast('Nothing to paste.'); return; }
    if (!ed.pasteClip(clip)) toast(`That was copied from a ${clip.kind === 'sch' ? 'schematic' : 'board'}; paste it into one.`, { kind: 'info' });
  }

  duplicate() {
    const ed = this.activeEditor;
    const clip = ed?.copySelection();
    if (clip) ed.pasteClip(clip);
  }

  find() { if (this.activeEditor) dialogs.findDialog(this); }
  preferences() { return dialogs.preferencesDialog(this); }
  showShortcuts() { dialogs.shortcutsDialog(this); }
  commandPalette() { dialogs.commandPalette(this); }
  about() { dialogs.aboutDialog(this); }
  manageLibrary() { return libraryDialog(this); }
  newComponent(opts) { return newComponentDialog(this, opts); }

  // ---------- Component editor documents ----------

  /** Any open document: a project sheet or board, or a component being edited. */
  _doc(id) { return this.project?.getDoc(id) || this._libDocs.get(id) || null; }

  /**
   * Opens a component in the graphical editor. copyFrom edits a copy under a
   * new id; built-in components not yet in the project are also copied so the
   * built-in definition is never changed.
   */
  openComponentEditor(compId, { copyFrom = null } = {}) {
    if (!this.project) { toast('Open a project to edit components.', { kind: 'info' }); return null; }
    let def = copyFrom ? null : this.project.library[compId] || this.userLibrary?.all().find((d) => d.id === compId) || null;
    let isNew = false;
    if (!def) {
      const src = copyFrom || findComponent(compId);
      if (!src) return null;
      def = copyDef(src, `user-${uid().slice(-8)}`, `${src.name} copy`);
      isNew = true;
    }
    const id = `lib:${def.id}`;
    if (!this._libDocs.has(id)) this._libDocs.set(id, new LibDoc({ def: structuredClone(def), isNew }));
    this.openDoc(id);
    return this._libDocs.get(id);
  }

  /** Opens an empty component in the editor. */
  newComponentInEditor() {
    if (!this.project) return null;
    const def = { id: `user-${uid().slice(-8)}`, name: 'New component', prefix: 'U', value: '', category: 'Integrated Circuits', params: {}, symbol: { pins: [], graphics: [], designatorPos: { x: 0, y: 2_540_000 * 3 }, valuePos: { x: 0, y: -2_540_000 * 3 } }, footprint: { name: 'New footprint', pads: [], graphics: [] } };
    const id = `lib:${def.id}`;
    this._libDocs.set(id, new LibDoc({ def, isNew: true }));
    this.openDoc(id);
    return this._libDocs.get(id);
  }

  async _confirmCloseLib(id) {
    const d = this._libDocs.get(id);
    if (!d?.dirty) return true;
    const r = await choiceDialog({
      title: 'Unsaved component',
      message: `${d.name} has changes that are not saved to the project library.`,
      choices: [{ label: 'Cancel', value: 'cancel' }, { label: 'Discard changes', value: 'discard', danger: true }, { label: 'Save', value: 'save', primary: true }],
    });
    if (r === 'save') return this.editors.get(id)?.save() ?? true;
    return r === 'discard';
  }

  // ---------- Cross probing ----------

  crossProbePart(obj) {
    const p = this.project;
    const fromSch = obj.t === 'part';
    for (const d of fromSch ? p.boards : p.sheets) {
      const target = [...d.items()].find((o) => o.uid === obj.uid);
      if (target) { this.openDoc(d.id); this.editors.get(d.id).focusObject(target.id); return; }
    }
    toast(fromSch ? `${obj.designator} is not on a board yet. Update the board from the schematic first.` : `${obj.designator} has no matching part in the schematic.`, { kind: 'info' });
  }

  crossProbeNet(net, from) {
    for (const ed of this.editors.values()) if (ed !== from && ed.highlightNet && ed.highlight?.net !== net) ed.highlightNet(net, { quiet: true });
  }

  // ---------- Checks ----------

  compile() {
    const p = this.project;
    if (!p) return;
    const sheets = p.sheetObjects();
    const list = runErc(sheets, p.library, p.netlist()).map((m) => ({ ...m, docId: m.sheetId }));
    this.panels.messages.set(list, 'Electrical rules check');
    this.setBottomDock(true);
    this.updateStatus();
    const e = list.filter((m) => m.severity === 'error').length;
    toast(list.length ? `${e} error${e === 1 ? '' : 's'} and ${list.length - e} warning${list.length - e === 1 ? '' : 's'}.` : 'No electrical problems found.', { kind: e ? 'warning' : 'success', title: 'Compile finished' });
  }

  async runDrc() {
    const ed = this.activeEditor;
    if (ed?.kind !== 'pcb') return;
    const t = toast('Checking design rules...', { timeout: 0 });
    const list = await ed.runDrc();
    t.close();
    if (!list) { toast('The design rule check could not run.', { kind: 'error' }); return; }
    this.panels.messages.set(list.map((m) => ({ ...m, docId: ed.doc.id })), 'Design rule check');
    this.setBottomDock(true);
    this.updateStatus();
    const errors = list.filter((m) => m.severity === 'error').length;
    toast(list.length ? `${errors} error${errors === 1 ? '' : 's'}, ${list.length - errors} warning${list.length - errors === 1 ? '' : 's'}.` : 'No rule violations.', { kind: errors ? 'warning' : 'success', title: 'Design rule check' });
  }

  focusMessage(m) {
    if (m.docId && !this._doc(m.docId)) return;
    if (m.docId) this.openDoc(m.docId);
    const ed = this.activeEditor;
    if (!ed) return;
    if (m.net && ed.highlightNet) ed.highlightNet(m.net);
    ed.focusObject(m.ids?.[0], m.x, m.y);
  }

  async annotate() { await dialogs.annotateDialog(this); }

  async updateBoard() {
    const p = this.project;
    let board = p.boards[0];
    if (!board) board = p.addBoard();
    if (p.boards.length > 1 && this.activeEditor?.kind === 'pcb') board = this.activeEditor.doc;
    const applied = await dialogs.syncDialog(this, board);
    if (applied) { this.openDoc(board.id); this.editors.get(board.id)?.fitAll(); }
  }

  // ---------- Board ----------

  editRules() { return dialogs.rulesDialog(this, this.activeEditor); }
  editLayerStack() { return dialogs.layerStackDialog(this, this.activeEditor); }
  boardSize() { return dialogs.boardSizeDialog(this, this.activeEditor); }
  boardInfo() {
    const ed = this.activeEditor?.kind === 'pcb' ? this.activeEditor : null;
    if (ed) dialogs.boardInfoDialog(this, ed);
    else { const b = this.project.boards[0]; this.openDoc(b.id); dialogs.boardInfoDialog(this, this.editors.get(b.id)); }
  }

  async setCopperLayers(n) {
    const ed = this.activeEditor;
    if (ed?.kind !== 'pcb' || ed.copperCount === n) return;
    const keep = new Set(copperLayers(n));
    const lost = [...ed.doc.items()].filter((o) => o.layer && copperLayers(6).includes(o.layer) && !keep.has(o.layer));
    if (lost.length && !(await confirmDialog({ title: 'Remove inner layers', message: `${lost.length} object${lost.length === 1 ? ' is' : 's are'} on layers that will be removed and will be deleted.`, confirm: 'Remove layers', danger: true }))) return;
    ed.doc.store.transact('Change copper layers', (s) => { s.update('board', { copper: n }); for (const o of lost) s.remove(o.id); });
    if (!keep.has(ed.activeLayer)) ed.setActiveLayer('top');
    ed._renderLayerTabs();
  }

  setOriginAtCursor() {
    const ed = this.activeEditor;
    const c = ed.cursor;
    ed.doc.store.transact('Set origin', (s) => s.update('board', { origin: { x: c.x, y: c.y } }));
    toast(`Origin set to the cursor position.`, { timeout: 2000 });
  }

  async autoroute(nets = null) {
    const ed = this.activeEditor;
    if (ed?.kind !== 'pcb') return;
    if (!Object.keys(ed.doc.nets).length) { toast('The board has no nets. Update it from the schematic first.', { kind: 'info' }); return; }
    await dialogs.autorouteDialog(this, ed, nets);
  }

  async unroute(net) {
    const ed = this.activeEditor;
    if (ed?.kind !== 'pcb') return;
    if (!net && !(await confirmDialog({ title: 'Unroute all', message: 'Remove every track, arc and via on the board? You can undo this.', confirm: 'Unroute all', danger: true }))) return;
    const n = ed.unrouteNet(net);
    toast(n ? `Removed ${n} object${n === 1 ? '' : 's'}.` : 'Nothing to remove.');
  }

  // ---------- 3D ----------

  async set3d(on) {
    const ed = this.activeEditor;
    // Invalidates an open still loading its modules (a quick double press of 3).
    const token = (this._3dToken = (this._3dToken || 0) + 1);
    if (!on || ed?.kind !== 'pcb') {
      if (this.view3dOpen) {
        this.view3d?.viewer.dispose();
        this.view3d?.el.remove();
        if (this.view3d?.editor) { this.view3d.editor.activeBar.hidden = false; this.view3d.editor._updateHud(); }
        this.view3d = null;
        this.view3dOpen = false;
        this.updateActiveBar();
        this.refreshMenus();
        // The 3D view's context may have pushed out the board's own (see openDoc).
        if (ed?.renderer?.gl?.isContextLost?.() && this.activeDocId === ed.doc.id) this.openDoc(ed.doc.id);
        else ed?.canvas.focus();
      }
      return;
    }
    if (this.view3dOpen) return;
    const [{ createViewer3D }, { buildBoardScene }] = await Promise.all([import('../render/viewer3d.js'), import('../render/mesh3d.js')]);
    if (token !== this._3dToken || this.view3dOpen || this.activeEditor !== ed) return;
    const canvas = h('canvas', { tabindex: 0, 'aria-label': `3D view of ${ed.doc.name}. Drag to orbit, right drag to pan, scroll to zoom. Press 2 to return to 2D.` });
    const back = h('button.btn.sm', { type: 'button', onClick: () => this.set3d(false) }, icon('view-2d', 14), '2D view');
    const views = h('div.activebar.view3d-bar', { role: 'toolbar', 'aria-label': '3D view' }, back, h('span.ab-sep'),
      ...[['iso', 'Isometric'], ['top', 'Top'], ['bottom', 'Bottom'], ['front', 'Front']].map(([v, l]) => h('button.btn.sm.ghost', { type: 'button', onClick: () => this.view3d?.viewer.setView(v) }, l)));
    const el = h('div.view3d-wrap', canvas, views);
    ed.wrap.append(el);
    const viewer = createViewer3D(canvas, { theme: resolvedTheme() });
    if (!viewer.supported) {
      el.remove();
      toast('The 3D view needs WebGL2, which is not available here.', { kind: 'error' });
      return;
    }
    this.view3d = { el, viewer, buildBoardScene, textStrokes, editor: ed };
    this.view3dOpen = true;
    // A 2D tool (routing, a half-drawn outline) cannot be used from the 3D view.
    if (ed.tool !== ed.select) ed.setTool(ed.select);
    ed.activeBar.hidden = true;
    ed.hud.hidden = true;
    this._update3d();
    viewer.fit();
    const onTheme = () => viewer.setTheme(resolvedTheme());
    window.addEventListener('themechange', onTheme);
    const origDispose = viewer.dispose.bind(viewer);
    viewer.dispose = () => { window.removeEventListener('themechange', onTheme); origDispose(); };
    canvas.addEventListener('keydown', (e) => { if (e.key === '2' || e.key === 'Escape') { e.preventDefault(); this.set3d(false); } });
    canvas.focus();
    this.updateActiveBar();
    this.refreshMenus();
  }

  _update3d() {
    const ed = this.activeEditor;
    if (!this.view3d || ed?.kind !== 'pcb') return;
    const { viewer, buildBoardScene, textStrokes } = this.view3d;
    viewer.setScene(buildBoardScene(ed.doc.snapshot(), ed.lib, { pourFills: ed.pourFills, textStrokes }));
    viewer.render();
  }

  // ---------- Export and print ----------

  _board() {
    const ed = this.activeEditor;
    if (ed?.kind === 'pcb') return { doc: ed.doc, ed };
    const doc = this.project.boards[0];
    return { doc, ed: doc ? this.editors.get(doc.id) : null };
  }

  async _fills(doc, ed) {
    // The open editor's fills, once they match the board as it is now.
    return (await ed?.currentFills()) || this.kernel.pours(doc.snapshot(), this.project.library);
  }

  async exportFabrication() {
    const { doc, ed } = this._board();
    if (!doc) return;
    const opts = await dialogs.fabricationDialog(this, doc);
    if (!opts) return;
    const t = toast('Preparing fabrication files...', { timeout: 0 });
    try {
      const fills = opts.repour ? await this.kernel.pours(doc.snapshot(), this.project.library) : await this._fills(doc, ed);
      if (opts.drc && ed) {
        const list = await ed.runDrc();
        const errors = (list || []).filter((m) => m.severity === 'error');
        if (errors.length) toast(`The board has ${errors.length} rule error${errors.length === 1 ? '' : 's'}. The files were still created; check the Messages panel before ordering.`, { kind: 'warning', timeout: 9000 });
        if (list) { this.panels.messages.set(list.map((m) => ({ ...m, docId: doc.id })), 'Design rule check'); this.updateStatus(); }
      }
      const { buildFabricationZip } = await import('../io/fabrication.js');
      const nl = exportShape(this.project.netlist(), this.project.sheetObjects(), this.project.library);
      const zip = buildFabricationZip(this.project.toJSON(), doc.id, { pourFills: fills, netlist: nl, untentVias: opts.untentVias, units: this.settings.get('units') });
      storage.download(new Blob([zip], { type: 'application/zip' }), `${storage.safeName(this.project.name)}-${storage.safeName(doc.name.replace(/\.pcb$/i, ''))}-fabrication.zip`);
      toast('Fabrication package downloaded.', { kind: 'success' });
    } catch (err) {
      toast(`Export failed: ${err.message}`, { kind: 'error' });
    } finally { t.close(); }
  }

  async exportGerbers() {
    const { doc, ed } = this._board();
    if (!doc) return;
    const [{ exportGerbers }, { zipSync, strToU8 }] = await Promise.all([import('../io/gerber.js'), import('fflate')]);
    const files = exportGerbers(doc.snapshot(), this.project.library, { pourFills: await this._fills(doc, ed), units: this.settings.get('units') });
    const zip = zipSync(Object.fromEntries(files.map((f) => [f.name, strToU8(f.content)])));
    storage.download(new Blob([zip], { type: 'application/zip' }), `${storage.safeName(doc.name.replace(/\.pcb$/i, ''))}-gerber.zip`);
  }

  async exportDrill() {
    const { doc } = this._board();
    if (!doc) return;
    const { exportDrill } = await import('../io/excellon.js');
    for (const f of exportDrill(doc.snapshot(), this.project.library)) storage.download(f.content, f.name, 'text/plain');
  }

  async exportBom() {
    const { buildBom, toCsv } = await import('../io/bom.js');
    const rows = buildBom(this.project.toJSON());
    storage.download(toCsv(rows), `${storage.safeName(this.project.name)}-bom.csv`, 'text/csv');
  }

  async exportPnp() {
    const { doc } = this._board();
    if (!doc) return;
    const { pickAndPlace, unpopulated } = await import('../io/pnp.js');
    const skip = unpopulated(this.project.toJSON());
    storage.download(pickAndPlace(doc.snapshot(), this.project.library, { skip }), `${storage.safeName(doc.name.replace(/\.pcb$/i, ''))}-pick-and-place.csv`, 'text/csv');
  }

  async exportNetlist() {
    const { formatNetlist } = await import('../io/netlist.js');
    const nl = exportShape(this.project.netlist(), this.project.sheetObjects(), this.project.library);
    storage.download(formatNetlist(nl, { title: this.project.name }), `${storage.safeName(this.project.name)}.net`, 'text/plain');
  }

  /** SVG of a document, drawn by the same scene code as the canvas. */
  async _svgOf(ed, theme = 'print') {
    if (ed.kind === 'sch') {
      const { sheetToSvg } = await import('../io/sch-svg.js');
      const sheets = this.project.sheets;
      const idx = sheets.indexOf(ed.doc);
      return sheetToSvg(ed.doc, this.project.library, {
        theme, junctions: this.project.netlist().sheets.get(ed.doc.id)?.junctions,
        info: { projectName: this.project.name, date: new Date(this.project.modified).toISOString().slice(0, 10), fileName: ed.doc.name, sheetOf: `${idx + 1} of ${sheets.length}` },
      });
    }
    if (ed.kind === 'pcb') {
      const { boardToSvgView } = await import('../io/board-svg.js');
      const layers = [...copperLayers(ed.copperCount), 'topOverlay', 'bottomOverlay', 'mech1', 'multi', 'keepout'].filter((l) => ed.isLayerVisible(l));
      return boardToSvgView(ed.doc, this.project.library, { layers, pourFills: (await ed.currentFills()) || ed.pourFills, colors: this.settings.get('layerColors'), theme: theme === 'print' ? 'light' : theme, active: ed.activeLayer });
    }
    return null;
  }

  async exportSvg() {
    const ed = this.activeEditor;
    if (!ed) return;
    const svg = await this._svgOf(ed, 'light');
    storage.download(svg, `${storage.safeName(ed.doc.name)}.svg`, 'image/svg+xml');
  }

  /** Prints the active document through the browser (also saves as PDF). */
  async print() {
    const ed = this.activeEditor;
    if (!ed) return;
    const svg = await this._svgOf(ed, 'print');
    const frame = h('iframe', { title: 'Print preview', style: { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' } });
    document.body.append(frame);
    const landscape = ed.kind === 'sch' ? ed.doc.sheet.orientation !== 'portrait' : true;
    const docHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(ed.doc.name)}</title><style>@page{size:${landscape ? 'landscape' : 'portrait'};margin:8mm}html,body{margin:0;background:#fff}svg{width:100%;height:auto;max-height:100vh;display:block}</style></head><body>${svg}</body></html>`;
    frame.srcdoc = docHtml;
    frame.addEventListener('load', () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { toast('Printing is blocked in this browser.', { kind: 'error' }); }
      setTimeout(() => frame.remove(), 60_000);
    }, { once: true });
  }
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
