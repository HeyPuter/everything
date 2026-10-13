/**
 * App: the application shell and controller. Owns the open documents
 * (one Editor each, shown as tabs), the tools, commands and keyboard
 * shortcuts, and builds the UI: menu bar, tools panel, document tabs,
 * canvas with rulers, status bar and the panel dock.
 */
import { h, announce } from './lib/dom.js';
import { Emitter } from './lib/emitter.js';
import { Editor } from './editor.js';
import { VDocument } from './model/document.js';
import { CanvasView } from './render/canvas-view.js';
import { CanvasInput } from './input.js';
import { CommandRegistry, IS_MAC, eventKey, normalizeShortcut, formatShortcut } from './commands/registry.js';
import { registerCoreCommands } from './commands/core.js';
import { registerAlignCommands } from './commands/align.js';
import { createMenubar, contextMenu, openMenu, resolveItems } from './ui/menubar.js';
import { MENUS, CONTEXT_MENU } from './ui/menus.js';
import { createToolbar } from './ui/toolbar.js';
import { createDock } from './ui/dock.js';
import { createStatusbar } from './ui/statusbar.js';
import { createRulers } from './ui/rulers.js';
import { icon } from './ui/icons.js';
import { installTooltips, iconButton } from './ui/widgets.js';
import { formDialog, confirmDialog, alertDialog, openDialog } from './ui/dialogs/dialog.js';
import { transformDialog, averageDialog } from './ui/dialogs/transform-dialogs.js';
import { PropertiesPanel } from './ui/panels/properties.js';
import { LayersPanel } from './ui/panels/layers.js';
import { nudge } from './ops/object-ops.js';
import { swapFillStroke, defaultFillStroke, setFocusedPaint } from './ops/paint-ops.js';
import { closePopover } from './ui/popover.js';
import { CORE_TOOLS } from './tools/index.js';
import { applyTheme, THEME_OPTIONS } from './theme.js';
import { defaultLabel } from './model/nodes.js';
import { formatLength } from './lib/units.js';

/** Focusable controls that Enter or Space activate. */
const ACTIVATABLE = 'button, a[href], summary, select, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="treeitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"]';

export class App extends Emitter {
  constructor(root, { prefs, env = 'web', user = null, picture = null, onSignIn = null, onSignOut = null, storage = null } = {}) {
    super();
    this.root = root;
    this.prefs = prefs;
    this.env = env;
    this.user = user;
    this.picture = picture;
    this.onSignIn = onSignIn;
    this.onSignOut = onSignOut;
    this.storage = storage;
    this.editors = [];
    this.editor = null;
    this.toolClasses = new Map();
    this.tools = new Map();
    /** Dynamic submenus feature modules provide by name (see ui/menus.js `source`). */
    this.menuSources = new Map();
    this.toolId = 'selection';
    this.lastSelectionTool = 'selection';
    this.commands = new CommandRegistry(this);
    this.alignTo = 'selection';
    this.alignKey = null;
    this.distributeSpacing = null;
    this.views = new Map(); // editor -> CanvasView
    // Phones start with the panel sheet closed so the canvas is usable.
    this.dockOpen = prefs.get('dockOpen') !== false && !(typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px)').matches);
    this.dialogs = {
      form: (opts) => formDialog(this, opts),
      confirm: confirmDialog,
      alert: alertDialog,
      open: openDialog,
      transform: (kind, args) => transformDialog(this, kind, args),
      average: () => averageDialog(this),
    };
    for (const T of CORE_TOOLS) this.registerTool(T);
    registerCoreCommands(this);
    registerAlignCommands(this);
    this.#registerAppCommands();
    this.panelClasses = [PropertiesPanel, LayersPanel];
  }

  // ---- registration (feature modules call these before start()) ----

  registerTool(ToolClass) {
    this.toolClasses.set(ToolClass.id, ToolClass);
  }

  registerPanel(PanelClass) {
    this.panelClasses.push(PanelClass);
  }

  getTool(id) {
    let t = this.tools.get(id);
    if (!t && this.toolClasses.has(id)) {
      t = new (this.toolClasses.get(id))(this);
      this.tools.set(id, t);
    }
    return t;
  }

  get tool() {
    return this.getTool(this.toolId);
  }

  // ---- UI ----

  start() {
    applyTheme(this.prefs.get('theme'));
    this.#buildShell();
    installTooltips(document);
    this.#installKeys();
    window.addEventListener('beforeunload', (e) => {
      // Dev builds skip the prompt so hot reloads never block on a dialog.
      if (this.editors.some((ed) => ed.doc.dirty) && this.env !== 'app' && !import.meta.env?.DEV) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.root.setAttribute('aria-busy', 'false');
    this.refreshChrome();
    this.emit('started');
  }

  #buildShell() {
    this.menubar = createMenubar(this, MENUS);
    const homeBtn = iconButton('home', 'Home', () => this.showHome(), { className: 'home-btn' });
    this.titleEl = h('h1.app-title', 'Vector Studio');
    this.accountEl = h('div.account');
    this.topRight = h('div.topbar-right', this.#themeButton(), this.accountEl);
    // Phones show one Menu button holding every menu, since the bar does not fit.
    this.compactMenuBtn = h(
      'button.btn.small.compact-menu',
      {
        type: 'button',
        'aria-haspopup': 'menu',
        onclick: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const items = MENUS.map((m) => ({ type: 'sub', label: m.label, items: resolveItems(this, m.submenu) }));
          openMenu(this, items, { x: r.left, y: r.bottom + 4, anchor: e.currentTarget, label: 'Menu' });
        },
      },
      icon('ellipsis-vertical', 16),
      'Menu',
    );
    this.topbar = h('header.topbar', homeBtn, this.menubar, this.compactMenuBtn, h('div.topbar-center', this.titleEl), this.topRight);

    this.toolbar = createToolbar(this);
    this.tabsEl = h('div.doc-tabs', { role: 'toolbar', 'aria-label': 'Open documents' });
    this.canvasHost = h('div.canvas-host', { tabindex: '0', role: 'application', 'aria-roledescription': 'vector canvas', 'aria-label': 'Canvas', 'aria-describedby': 'canvas-desc' });
    // What is selected, for screen readers (read with the canvas, announced on keyboard changes).
    this.canvasDesc = h('p#canvas-desc.sr-only', 'No selection');
    this.canvasWrap = h('div.canvas-wrap', this.canvasHost);
    this.rulers = createRulers(this, this.canvasWrap);
    this.isolationBar = h('div.isolation-bar', { hidden: true });
    this.taskbar = h('div.taskbar', { role: 'toolbar', 'aria-label': 'Task bar', hidden: true });
    this.home = h('div.home-host', { hidden: true });
    this.statusbar = createStatusbar(this);
    this.docArea = h('main#main.doc-area', this.tabsEl, this.isolationBar, h('div.canvas-stack', this.canvasWrap, this.taskbar, this.home), this.statusbar.el, this.canvasDesc);
    this.dock = createDock(this);
    for (const P of this.panelClasses) this.dock.register(P);
    this.workspace = h('div.workspace', this.toolbar.el, this.docArea, this.dock.el);
    this.toastHost = h('div.toast-host', { role: 'status', 'aria-live': 'polite' });
    this.root.replaceChildren(this.topbar, this.workspace, this.toastHost);
    this.root.classList.toggle('dock-closed', !this.dockOpen);
    this.root.classList.toggle('no-doc', !this.editor);
    this.input = new CanvasInput(this, this.canvasHost);
    this.dock.start();
    this.renderAccount();
  }

  #themeButton() {
    const btn = iconButton('monitor', 'Theme', (e) => {
      const items = resolveItems(this, THEME_OPTIONS.map((t) => `theme.${t.value}`));
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(this, items, { x: r.left - 120, y: r.bottom + 4, anchor: e.currentTarget, label: 'Theme' });
    });
    this.themeBtn = btn;
    return btn;
  }

  renderAccount() {
    const el = this.accountEl;
    if (!el) return;
    el.replaceChildren();
    if (this.user) {
      const avatar = this.picture ? h('img.avatar', { src: this.picture, alt: '' }) : h('span.avatar.initial', (this.user.username || '?')[0].toUpperCase());
      const btn = h('button.account-btn', { type: 'button', 'aria-label': `Account: ${this.user.username}`, 'aria-haspopup': 'menu', 'data-tip': this.user.username }, avatar);
      btn.addEventListener('click', () => {
        const items = [{ type: 'cmd', label: `Signed in as ${this.user.username}`, enabled: false }];
        // Inside the Puter desktop the session belongs to Puter, so there is no sign-out here.
        if (this.env !== 'app' && this.onSignOut) items.push({ type: 'sep' }, { type: 'cmd', label: 'Sign out', enabled: true, run: () => this.onSignOut() });
        const r = btn.getBoundingClientRect();
        openMenu(this, items, { x: r.right - 200, y: r.bottom + 4, anchor: btn, label: 'Account' });
      });
      el.append(btn);
    } else if (this.onSignIn) {
      el.append(h('button.btn.small.signin-btn', { type: 'button', onclick: () => this.onSignIn() }, icon('login', 14), h('span.signin-label', 'Sign in')));
    }
  }

  setUser(user, picture) {
    this.user = user;
    this.picture = picture;
    this.renderAccount();
    this.emit('user');
  }

  setDockOpen(open) {
    this.dockOpen = open;
    if (!(typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px)').matches)) this.prefs.set('dockOpen', open);
    this.root.classList.toggle('dock-closed', !open);
    this.statusbar?.refresh();
    if (open) this.dock.update();
  }

  openPanel(id) {
    if (!this.dock.panels.has(id)) return;
    if (!this.dockOpen) this.setDockOpen(true);
    this.dock.openPanel(id);
  }

  showContextMenu(x, y) {
    contextMenu(this, CONTEXT_MENU, x, y, 'Canvas context menu');
  }

  showMenuAt(anchor, spec, label) {
    const r = anchor.getBoundingClientRect();
    openMenu(this, resolveItems(this, spec), { x: r.left, y: r.bottom + 4, anchor, label });
  }

  setCanvasCursor(c) {
    if (!this.canvasHost) return;
    this.canvasHost.style.cursor = c && c.startsWith('var(') ? c : c || 'default';
  }

  setStatusHint(text) {
    this.statusbar?.setHint(text);
  }

  notify(message, { error = false, polite = false, timeout = 3200 } = {}) {
    if (!this.toastHost) return;
    if (polite) {
      announce(message);
      return;
    }
    const t = h(`div.toast${error ? '.error' : ''}`, message);
    this.toastHost.append(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, timeout);
  }

  /** A short spoken description of the selection: "Rectangle selected, 20 by 10 pt". */
  describeSelection(editor = this.editor) {
    if (!editor) return '';
    const ids = editor.topSelection();
    if (!ids.length) return 'No selection';
    if (ids.length > 1) return `${ids.length} objects selected`;
    const node = editor.doc.get(ids[0]);
    let name = defaultLabel(node).replace(/^<(.*)>$/, '$1');
    if (node.type === 'text' && !node.name) name = `Text "${name}"`;
    const b = editor.selectionBounds();
    const units = editor.doc.root.units || 'pt';
    const size = b ? `, ${formatLength(b.w, units)} by ${formatLength(b.h, units)}` : '';
    return `${name} selected${size}`;
  }

  #describeTimer = 0;

  #scheduleDescribe(editor) {
    clearTimeout(this.#describeTimer);
    this.#describeTimer = setTimeout(() => {
      if (editor !== this.editor || !this.canvasDesc) return;
      const text = this.describeSelection(editor);
      if (text === this.canvasDesc.textContent) return;
      this.canvasDesc.textContent = text;
      // Speak it while working on the canvas (panels convey their own state).
      if (document.activeElement === this.canvasHost) announce(text);
    }, 250);
  }

  // ---- documents ----

  /** Open a document in a new tab and make it active. */
  addDocument(doc, { file = null, activate = true } = {}) {
    const editor = new Editor(doc, { file, prefs: this.prefs });
    editor.style = { ...editor.style };
    this.editors.push(editor);
    editor.on('selection', () => {
      this.#onEditorEvent(editor);
      this.#scheduleDescribe(editor);
    });
    editor.on('doc-change', (e) => this.#onEditorEvent(editor, e));
    editor.on('style', () => this.#onEditorEvent(editor));
    editor.on('view', () => this.#onViewEvent(editor));
    editor.on('artboard', () => this.#onEditorEvent(editor));
    editor.on('active-layer', () => this.#onEditorEvent(editor));
    editor.on('isolation', () => this.#onEditorEvent(editor));
    editor.on('view-options', () => this.#onEditorEvent(editor));
    doc.on('history', () => this.renderTabs());
    doc.on('saved', () => this.renderTabs());
    if (activate) this.activate(editor);
    else this.renderTabs();
    return editor;
  }

  newDocument(opts = {}) {
    // Only unnamed documents use up an "Untitled-N" number.
    const name = opts.name || `Untitled-${this.#untitledCounter()}`;
    const doc = VDocument.create({ ...opts, name });
    return this.addDocument(doc);
  }

  #untitledCounter() {
    this.untitled = (this.untitled || 0) + 1;
    return this.untitled;
  }

  activate(editor) {
    // activate(null) after the last tab closed must still show the home screen.
    if (this.editor === editor && editor) return;
    this.tool?.commit?.();
    const prevView = this.editor && this.views.get(this.editor);
    if (prevView) prevView.host.hidden = true;
    this.editor = editor;
    if (editor) {
      let view = this.views.get(editor);
      if (!view) {
        const host = h('div.view-host');
        this.canvasHost.append(host);
        view = new CanvasView(host, editor, { theme: this.prefs.get('theme') });
        this.views.set(editor, view);
      }
      view.host.hidden = false;
      view.resize();
      view.invalidate();
      editor.tool = this.tool;
      this.home.hidden = true;
    } else if (this.prefs.get('showStartScreen') !== false) this.showHome();
    this.root.classList.toggle('no-doc', !editor);
    if (editor) this.#scheduleDescribe(editor);
    this.refreshChrome();
    this.tool?.activate?.();
    this.emit('active-editor', editor);
  }

  async closeDocument(editor = this.editor, { force = false } = {}) {
    if (!editor) return true;
    if (!force && editor.doc.dirty) {
      const save = await openDialog({
        title: 'Vector Studio',
        body: h('p.dialog-message', `Save changes to "${editor.name}" before closing?`),
        buttons: [
          { label: "Don't Save", value: 'discard', left: true },
          { label: 'Cancel', value: null },
          { label: 'Save', value: 'save', primary: true },
        ],
      });
      if (!save) return false;
      if (save === 'save') {
        const ok = await this.commands.run('file.save', { editor });
        if (!ok) return false;
      }
    }
    const i = this.editors.indexOf(editor);
    this.editors.splice(i, 1);
    this.views.get(editor)?.destroy();
    this.views.get(editor)?.host.remove();
    this.views.delete(editor);
    if (this.editor === editor) {
      this.editor = null;
      this.activate(this.editors[Math.min(i, this.editors.length - 1)] || null);
    } else this.renderTabs();
    this.emit('closed', editor);
    return true;
  }

  showHome() {
    this.home.hidden = false;
    this.emit('show-home');
    this.renderHome?.(this.home);
  }

  renderTabs() {
    const tabs = this.editors.map((ed) => {
      const active = ed === this.editor;
      const zoom = Math.round(ed.view.zoom * 100 * 100) / 100;
      const label = `${ed.name}${ed.doc.dirty ? '*' : ''} @ ${zoom}% (${ed.doc.root.colorMode === 'CMYK' ? 'CMYK' : 'RGB'}/${ed.viewOptions.mode === 'outline' ? 'Outline' : 'Preview'})`;
      // Close button before the title.
      const tab = h(
        'div.doc-tab',
        h('button.icon-btn.doc-tab-close', { type: 'button', 'aria-label': `Close ${ed.name}`, 'data-tip': `Close (${formatShortcut('Mod+W')})`, onclick: () => this.closeDocument(ed) }, icon('x', 12)),
        h('button.doc-tab-btn', { type: 'button', 'aria-current': active ? 'true' : null, title: label, onclick: () => this.activate(ed) }, label),
      );
      tab.classList.toggle('active', active);
      return tab;
    });
    this.tabsEl.replaceChildren(...tabs);
    this.tabsEl.hidden = !this.editors.length;
    // Keep the active tab in view when the tabs overflow.
    const at = tabs[this.editors.indexOf(this.editor)];
    if (at && this.tabsEl.scrollWidth > this.tabsEl.clientWidth) {
      const left = at.offsetLeft - this.tabsEl.offsetLeft;
      const right = left + at.offsetWidth;
      if (left < this.tabsEl.scrollLeft) this.tabsEl.scrollLeft = left;
      else if (right > this.tabsEl.scrollLeft + this.tabsEl.clientWidth) this.tabsEl.scrollLeft = right - this.tabsEl.clientWidth;
    }
    if (this.editor) document.title = `${this.editor.name}${this.editor.doc.dirty ? '*' : ''} - Vector Studio`;
    else document.title = 'Vector Studio';
  }

  refreshChrome() {
    this.renderTabs();
    this.toolbar?.refreshTool();
    this.toolbar?.refreshPaint();
    this.statusbar?.refresh();
    this.rulers?.refresh();
    this.dock?.update();
    this.#renderIsolation();
    this.emit('chrome');
  }

  #renderIsolation() {
    const ed = this.editor;
    const on = Boolean(ed?.isolation);
    this.isolationBar.hidden = !on;
    if (!on) return;
    const g = ed.doc.get(ed.isolation);
    this.isolationBar.replaceChildren(
      h('button.icon-btn', { type: 'button', 'aria-label': 'Exit Isolation Mode', 'data-tip': 'Exit Isolation Mode (Esc)', onclick: () => this.commands.run('object.exitIsolation') }, icon('chevron-left', 14)),
      h('span', `${ed.doc.layerOf(ed.isolation)?.name || 'Layer'} › ${g ? defaultLabel(g) : '<Group>'}`),
    );
  }

  #pending = false;

  #onEditorEvent(editor) {
    if (editor !== this.editor) return;
    // Coalesce chrome refreshes into one frame; during a drag (open
    // transaction) at most a few per second so the canvas gets the frames.
    if (this.#pending) return;
    this.#pending = true;
    const run = () => {
      this.#pending = false;
      // The app may be gone by then (its page was replaced).
      if (!this.root.isConnected || !this.root.ownerDocument.defaultView) return;
      this.refreshChrome();
    };
    if (editor.doc.tx) setTimeout(run, 120);
    else requestAnimationFrame(run);
  }

  #onViewEvent(editor) {
    if (editor !== this.editor) return;
    this.statusbar.refresh();
    this.rulers.refresh();
    if (!this.tabTimer) {
      this.tabTimer = setTimeout(() => {
        this.tabTimer = 0;
        // The app may be gone by then (its page was replaced).
        if (!this.root.isConnected || !this.root.ownerDocument.defaultView) return;
        this.renderTabs();
      }, 200);
    }
    this.emit('view');
  }

  // ---- tools ----

  setTool(id) {
    if (!this.toolClasses.has(id)) return;
    closePopover();
    const prev = this.tool;
    if (prev && prev.id !== id) {
      prev.commit?.();
      prev.deactivate?.();
    }
    this.toolId = id;
    if (['selection', 'direct-selection', 'group-selection'].includes(id)) this.lastSelectionTool = id;
    const t = this.tool;
    if (this.editor) {
      this.editor.tool = t;
      this.editor.hover = null;
      t.activate?.();
      this.editor.emit('overlay');
    }
    this.toolbar.refreshTool();
    this.statusbar.refresh();
    this.emit('tool', id);
  }

  /** Document point for a raw pointer event (used for coalesced pen samples). */
  eventToDoc(e) {
    const r = (this.views.get(this.editor)?.host || this.canvasHost).getBoundingClientRect();
    return this.editor.view.toDoc(e.clientX - r.left, e.clientY - r.top);
  }

  // ---- keyboard ----

  #installKeys() {
    const toolKeys = new Map();
    for (const [id, T] of this.toolClasses) if (T.shortcut) toolKeys.set(normalizeShortcut(T.shortcut), id);
    this.toolKeys = toolKeys;

    document.addEventListener('keydown', (e) => this.#keydown(e));
    document.addEventListener('keyup', (e) => this.#keyup(e));
    window.addEventListener('blur', () => {
      this.input?.setTempTool(null);
      this.input && (this.input.spaceDown = false);
    });
  }

  #isTyping(e) {
    const t = e.target;
    if (!t || !t.tagName) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === 'TEXTAREA') return true;
    if (t.tagName === 'SELECT') return true;
    if (t.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'range'].includes(t.type);
    return false;
  }

  #keydown(e) {
    if (e.defaultPrevented) return;
    if (document.querySelector('dialog[open]')) return;
    const typing = this.#isTyping(e);
    const ed = this.editor;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    // Text editing on canvas takes every key it wants.
    if (ed?.textEdit && this.tool?.onKeyDown?.(e)) {
      e.preventDefault();
      return;
    }
    if (typing) return;
    // Enter and Space activate the focused button, tab, menu item or option:
    // they are not canvas shortcuts there (Space would start the Hand tool).
    if ((e.key === 'Enter' || e.key === ' ') && !e.metaKey && !e.ctrlKey && !e.altKey && e.target?.closest?.(ACTIVATABLE)) return;
    // Command shortcuts.
    const cmd = this.commands.match(e);
    if (cmd) {
      // Let the tool claim Enter/Escape/Delete first (e.g. finishing a pen path, removing a pin),
      // and any key it asks for (letters that change a shape while it is being drawn).
      if (!((['Enter', 'Escape', 'Delete', 'Backspace'].includes(e.key) || this.tool?.claimsKey?.(e)) && this.tool?.onKeyDown?.(e))) {
        e.preventDefault();
        this.commands.run(cmd);
      } else e.preventDefault();
      return;
    }
    if (!ed) {
      return;
    }
    // Tool-specific keys.
    if (this.input?.tempTool?.onKeyDown?.(e) || this.tool?.onKeyDown?.(e)) {
      e.preventDefault();
      return;
    }
    // Space: temporary Hand (Cmd+Space zoom in, Alt+Cmd+Space zoom out).
    if (e.code === 'Space') {
      e.preventDefault();
      if (!this.input.spaceDown) {
        this.input.spaceDown = true;
        const t = mod ? this.getTool('zoom') : this.getTool('hand');
        this.input.setTempTool(t);
        if (mod && e.altKey) this.setCanvasCursor('zoom-out');
      }
      return;
    }
    // Holding Cmd/Ctrl: temporary selection tool.
    if ((e.key === 'Meta' && IS_MAC) || (e.key === 'Control' && !IS_MAC)) {
      if (!['selection', 'direct-selection', 'group-selection'].includes(this.toolId) && !this.input.spaceDown) {
        this.input.setTempTool(this.getTool(this.lastSelectionTool));
      }
      return;
    }
    if (mod) return;
    // Arrow nudges.
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && ed.selection.size) {
      e.preventDefault();
      const inc = this.prefs.get('keyboardIncrement') * (e.shiftKey ? 10 : 1);
      const [dx, dy] = arrows[e.key];
      nudge(ed, dx * inc, dy * inc, { copy: e.altKey });
      return;
    }
    if (e.key === 'Escape') {
      closePopover();
      if (ed.isolation) {
        this.commands.run('object.exitIsolation');
        return;
      }
      this.tool?.cancel?.();
      return;
    }
    if (e.key === 'Tab' && e.target === this.canvasHost && !this.#keyboardFocused(this.canvasHost)) {
      // Only on a canvas focused by clicking it: from the page, or a canvas
      // reached with the keyboard, Tab keeps moving focus so keyboard users
      // are never trapped. Tab hides and shows panels; Shift+Tab hides
      // panels except the tools.
      e.preventDefault();
      this.root.classList.toggle(e.shiftKey ? 'hide-dock' : 'hide-panels');
      return;
    }
    // Paint shortcuts.
    const k = eventKey(e);
    if (k === 'x' && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) swapFillStroke(ed);
      else {
        ed.focusPaint = ed.focusPaint === 'fill' ? 'stroke' : 'fill';
        ed.emit('style');
      }
      return;
    }
    if (k === 'd' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      defaultFillStroke(ed);
      return;
    }
    // Comma and period work with or without Shift (the keys are labeled < and >).
    if ((k === ',' || k === '.' || (k === '/' && !e.shiftKey)) && !e.altKey) {
      e.preventDefault();
      setFocusedPaint(ed, k === ',' ? 'color' : k === '.' ? 'gradient' : 'none');
      return;
    }
    // Tool shortcuts.
    const sc = [e.altKey ? 'alt' : '', e.shiftKey ? 'shift' : '', k].filter(Boolean).join('+');
    const toolId = this.toolKeys.get(sc);
    if (toolId) {
      e.preventDefault();
      this.setTool(toolId);
    }
  }

  #keyboardFocused(el) {
    try {
      return el.matches(':focus-visible');
    } catch {
      return false;
    }
  }

  #keyup(e) {
    if (e.code === 'Space' && this.input?.spaceDown) {
      this.input.spaceDown = false;
      this.input.setTempTool(null);
      this.tool?.status?.();
      return;
    }
    if (((e.key === 'Meta' && IS_MAC) || (e.key === 'Control' && !IS_MAC)) && this.input?.tempTool && !this.input.spaceDown) {
      this.input.setTempTool(null);
      this.tool?.status?.();
      this.tool?.activate?.();
    }
  }

  // ---- app-level commands ----

  #registerAppCommands() {
    const c = this.commands;
    c.register([
      { id: 'file.new', label: 'New...', shortcut: 'Mod+N', run: (a) => (a.newDocumentDialog ? a.newDocumentDialog() : a.newDocument()) },
      { id: 'file.close', label: 'Close', shortcut: 'Mod+W', enabled: (a) => Boolean(a.editor), run: (a) => a.closeDocument() },
      {
        id: 'file.closeAll',
        label: 'Close All',
        shortcut: 'Alt+Mod+W',
        enabled: (a) => a.editors.length > 0,
        run: async (a) => {
          for (const ed of [...a.editors]) if (!(await a.closeDocument(ed))) return;
        },
      },
      { id: 'window.toggleDock', label: (a) => (a.dockOpen ? 'Hide Panels' : 'Show Panels'), run: (a) => a.setDockOpen(!a.dockOpen) },
      {
        id: 'window.resetWorkspace',
        label: 'Reset Standard',
        run: (a) => {
          a.setDockOpen(true);
          a.root.classList.remove('hide-panels', 'hide-dock');
          a.dock.closeFlyout(false);
          a.dock.showTab('properties');
        },
      },
      {
        id: 'window.screenMode',
        label: 'Change Screen Mode',
        shortcut: 'F',
        run: () => {
          if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
          else document.exitFullscreen?.();
        },
      },
      ...THEME_OPTIONS.map(({ value: t, label }) => ({
        id: `theme.${t}`,
        label,
        checked: (a) => a.prefs.get('theme') === t,
        run: (a) => {
          a.prefs.set('theme', t);
          applyTheme(t);
          for (const v of a.views.values()) v.refreshColors();
          a.rulers.refresh();
        },
      })),
      { id: 'help.shortcuts', label: 'Keyboard Shortcuts', shortcut: 'Alt+Shift+Mod+K', run: (a) => a.showShortcuts() },
      { id: 'edit.keyboardShortcuts', label: 'Keyboard Shortcuts...', run: (a) => a.showShortcuts() },
      {
        id: 'help.about',
        label: 'About Vector Studio',
        run: (a) =>
          a.dialogs.open({
            title: 'About Vector Studio',
            body: h(
              'div.about',
              h('p', 'Vector Studio is a free, open-source vector illustration editor. Your files are stored in your own Puter cloud.'),
              h('p', h('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Powered by Puter')),
            ),
            buttons: [{ label: 'OK', value: true, primary: true }],
          }),
      },
    ]);
    // Panels.
    const panelCmd = (id, title) => ({
      id: `panel.${id}`,
      label: title,
      checked: (a) => a.dock?.isOpen(id),
      enabled: (a) => a.dock?.panels.has(id),
      run: (a) => a.openPanel(id),
    });
    this.on('started', () => {
      for (const [id, p] of this.dock.panels) {
        const title = p.constructor.title;
        if (!this.commands.get(`panel.${id}`)) this.commands.register({ ...panelCmd(id, title), shortcut: p.constructor.shortcut || undefined });
      }
    });
  }

  showShortcuts() {
    const rows = [];
    for (const [, T] of this.toolClasses) if (T.shortcut) rows.push([T.label, formatShortcut(T.shortcut), 'Tools']);
    for (const [id, cmd] of this.commands.commands) {
      if (!cmd.shortcut) continue;
      rows.push([this.commands.label(id), formatShortcut([].concat(cmd.shortcut)[0]), id.split('.')[0]]);
    }
    rows.push(['Pan (temporary Hand)', 'Space', 'Navigation'], ['Swap Fill and Stroke', formatShortcut('Shift+X'), 'Paint'], ['Toggle Fill and Stroke', 'X', 'Paint'], ['Default Fill and Stroke', 'D', 'Paint'], ['Color / Gradient / None', ', . /', 'Paint'], ['Nudge (10x with Shift)', '← ↑ → ↓', 'Object'], ['Hide panels', 'Tab', 'Window']);
    const filter = h('input.shortcut-search', { type: 'search', placeholder: 'Search shortcuts', 'aria-label': 'Search shortcuts' });
    const tbody = h('tbody');
    const render = () => {
      const q = filter.value.toLowerCase();
      tbody.replaceChildren(...rows.filter((r) => !q || r[0].toLowerCase().includes(q) || r[1].toLowerCase().includes(q)).map((r) => h('tr', h('td', r[0]), h('td', h('kbd', r[1])), h('td.muted', r[2]))));
    };
    filter.addEventListener('input', render);
    render();
    return openDialog({
      title: 'Keyboard Shortcuts',
      className: 'wide',
      body: h('div.shortcuts', filter, h('div.shortcut-table-wrap', { tabindex: '0', role: 'region', 'aria-label': 'Shortcuts' }, h('table.shortcut-table', h('thead', h('tr', h('th', 'Command'), h('th', 'Shortcut'), h('th', 'Group'))), tbody))),
      buttons: [{ label: 'Close', value: true, primary: true }],
    });
  }
}
