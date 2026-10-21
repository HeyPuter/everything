import { h, announce, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { matchShortcut, modKey, shortcutLabel } from '../lib/platform.js';
import { SECTION_COLORS } from '../data/colors.js';
import { PageEditor } from '../editor/page-editor.js';
import { queryFormat, FONTS, SIZES, setFontName, setFontSize, DEFAULT_SIZE } from '../editor/format.js';
import { activeTags, tagStylesheet } from '../editor/tag-edit.js';
import { tableHtml } from '../editor/table.js';
import { insertHtml } from '../editor/format.js';
import { buildCommands, buildGalleries } from './commands.js';
import { RIBBON_TABS, fileMenu } from './ribbon-def.js';
import { Ribbon } from './ribbon.js';
import { Nav } from './nav.js';
import { openMenu, closeAllMenus, isMenuOpen } from './menu.js';
import { promptText, confirmDialog } from './dialog.js';
import { toast } from './toast.js';
import { installTooltips, hideTooltip } from './tooltip.js';
import { prefs, setPref, onThemeChange } from './prefs.js';
import * as features from './features.js';
import { SearchPanel, RecentPanel } from './panels.js';
import { TaskPanes } from './task-panes.js';
import { FindBar } from './find.js';
import { Dictation } from './dictation.js';
import { createAi } from './assist.js';
import { KeyTips } from './keytips.js';

/**
 * The application controller: owns navigation state and wires the store,
 * the navigation panes, the ribbon and the page editor together.
 */
export class App {
  constructor(root, { store, user, env = 'web', onSignOut, readOnlyView = false }) {
    this.root = root;
    this.store = store;
    this.user = user;
    this.env = env;
    this.onSignOut = onSignOut;
    this.readOnlyView = readOnlyView;
    const p = prefs();
    this.state = {
      notebookId: null,
      sectionId: null,
      pageId: null,
      railView: 'notebooks',
      navVisible: p.navVisible,
      pagesVisible: p.pagesVisible,
      fullPage: false,
    };
    this.format = { editable: false };
    this.activeTags = new Set();
    this.taskPaneKind = null;
    this.painter = null;
    this.recorder = null;
    this.unlocked = new Set();
    this.commands = buildCommands();
    this.galleries = buildGalleries();
    this.dictation = new Dictation(this);
    this.ai = createAi(this);
    this.installTagStyles();
    this.build();
    this.bindStore();
    this.bindKeys();
    this.keytips = new KeyTips(this);
    installTooltips(document);
    this.removeThemeListener = onThemeChange(() => this.themeChanged());
  }

  // ------------------------------------------------------------ shell

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    (this.disposers ||= []).push(() => target.removeEventListener(type, fn, opts));
  }

  /** Removes global listeners (used when the app is torn down, as in tests). */
  destroy() {
    for (const d of this.disposers || []) d();
    this.disposers = [];
    this.editor.destroy();
    this.removeThemeListener?.();
    document.getElementById('tag-styles')?.remove();
  }

  installTagStyles() {
    const style = document.createElement('style');
    style.id = 'tag-styles';
    style.textContent = tagStylesheet();
    document.head.append(style);
  }

  build() {
    const root = this.root;
    root.replaceChildren();
    root.removeAttribute('aria-busy');

    // Title bar
    this.undoBtn = this.chromeButton('undo');
    this.redoBtn = this.chromeButton('redo');
    const moreBtn = h('button.icon-btn.desktop-only', { type: 'button', 'aria-label': 'More commands', 'data-tip': 'More commands' }, icon('more', 18));
    moreBtn.addEventListener('click', () => {
      if (moreBtn._menuJustClosed) return;
      openMenu(moreBtn, fileMenu(this), { label: 'More commands' });
    });
    this.mobileBack = h('button.icon-btn.mobile-only.mobile-back', { type: 'button', 'aria-label': 'Back', onclick: () => this.setMobileView(this.root.dataset.mobileView === 'page' ? 'pages' : 'sections') }, icon('chevLeft', 22));
    this.titleText = h('div.titlebar-title', { 'aria-live': 'off' }, 'Notes');
    this.syncBtn = h('button.icon-btn.sync-btn', { type: 'button', 'aria-label': 'All changes saved', 'data-tip': 'All changes saved', 'data-status': 'saved', onclick: () => this.syncNow() }, icon('cloudCheck', 18));
    this.shareBtn = h('button.share-btn', { type: 'button', 'data-tip': 'Share', 'aria-label': 'Share', onclick: () => this.runCommand('share') }, icon('share', 16), h('span', 'Share'));
    this.mobileMore = h('button.icon-btn.mobile-only', { type: 'button', 'aria-label': 'More commands' }, icon('more', 20));
    this.mobileMore.addEventListener('click', () => {
      if (this.mobileMore._menuJustClosed) return;
      openMenu(this.mobileMore, [...fileMenu(this), { type: 'sep' }, ...this.accountItems()], { label: 'More commands', align: 'end' });
    });
    this.titlebar = h('header.titlebar', { role: 'banner' },
      h('div.titlebar-start',
        this.mobileBack,
        h('div.app-mark', h('img', { src: './favicon.svg', alt: '' }), h('span', 'Notes')),
        h('span.desktop-only', { style: { display: 'contents' } }, this.undoBtn, this.redoBtn, moreBtn),
      ),
      this.titleText,
      h('div.titlebar-end', this.syncBtn, this.shareBtn, this.mobileMore),
    );

    // Ribbon
    this.ribbon = new Ribbon(this, { tabs: RIBBON_TABS, commands: this.commands, galleries: this.galleries });
    this.fileBtn = h('button.ribbon-tab.file-tab', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, 'File');
    this.fileBtn.addEventListener('click', () => {
      if (this.fileBtn._menuJustClosed) return;
      openMenu(this.fileBtn, fileMenu(this), { label: 'File' });
    });
    this.ribbon.tabList.before(this.fileBtn);

    // Workspace
    this.rail = h('nav.rail', { 'aria-label': 'Views' });
    this.railButtons = {
      notebooks: this.railButton('notebooks', 'Notebooks', 'notebooks'),
      search: this.railButton('search', 'Search', 'search', 'Mod+E'),
      recent: this.railButton('recent', 'Recent Notes', 'recent'),
    };
    this.avatar = h('button.avatar-btn', { type: 'button', 'aria-label': 'Account', 'data-tip': this.user?.username || 'Account', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, this.initials());
    this.avatar.addEventListener('click', () => {
      if (this.avatar._menuJustClosed) return;
      const r = this.avatar.getBoundingClientRect();
      openMenu({ x: r.right + 6, y: r.bottom }, this.accountItems(), { label: 'Account' });
    });
    this.rail.append(...Object.values(this.railButtons), h('span.rail-spacer'), this.avatar);

    this.nav = new Nav(this);
    this.search = new SearchPanel(this);
    this.recent = new RecentPanel(this);
    this.pageHeading = h('h1.sr-only', 'Notes');
    this.canvasCol = h('div.canvas-col', this.pageHeading);
    this.editor = new PageEditor({ store: this.store, host: this.canvasCol });
    this.editor.ink.inkToShape = Boolean(prefs().inkToShape);
    this.bindEditor();
    this.find = new FindBar(this);
    this.exitFullBtn = h('button.btn.exit-full', { type: 'button', hidden: true, onclick: () => this.toggleFullPage() }, icon('exitFullPage', 16), 'Exit Full Page View');
    this.canvasCol.append(this.exitFullBtn);
    this.taskPanes = new TaskPanes(this);
    this.main = h('main.main', { id: 'main' }, this.canvasCol, this.taskPanes.el);
    this.workspace = h('div.workspace', this.rail, this.nav.el, this.search.el, this.recent.el, this.main);

    this.bottomBar = h('nav.bottom-bar', { 'aria-label': 'Bottom navigation' },
      this.bottomButton('notebooks', 'Notebooks', 'notebooks'),
      this.bottomButton('search', 'Search', 'search'),
      this.bottomButton('recent', 'Recent', 'recent'),
    );

    root.append(this.titlebar, this.ribbon.el, this.workspace, this.bottomBar);
    this.applyLayout();
    this.setMobileView('sections');
    this.listen(window, 'resize', debounce(() => this.applyLayout(), 150));
    this.updateSync(this.store.status);
    this.loadAvatar();
  }

  chromeButton(id) {
    const c = this.commands.get(id);
    const b = h('button.icon-btn', { type: 'button', 'aria-label': c.label, 'data-tip': c.label, 'data-tip-key': c.key }, icon(c.icon, 18));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => this.runCommand(id));
    return b;
  }

  railButton(view, label, ic, key) {
    const b = h('button.rail-btn', { type: 'button', 'aria-label': label, 'data-tip': label, 'data-tip-key': key || null, 'aria-pressed': 'false' }, icon(ic, 20));
    b.addEventListener('click', () => {
      if (view === 'notebooks' && this.state.railView === 'notebooks') this.toggleNav();
      else this.setRailView(view, { focus: view === 'search' });
    });
    return b;
  }

  bottomButton(view, label, ic) {
    const b = h('button', { type: 'button', 'aria-pressed': 'false', dataset: { view } }, icon(ic, 22), label);
    b.addEventListener('click', () => {
      this.setRailView(view, { focus: view === 'search' });
      if (view === 'notebooks') this.setMobileView('sections');
    });
    return b;
  }

  initials() {
    const name = this.user?.username || '';
    return name ? name.slice(0, 2).toUpperCase() : icon('user', 18);
  }

  async loadAvatar() {
    if (!this.user || typeof puter === 'undefined' || !puter.auth?.getProfilePicture) return;
    try {
      const pic = await puter.auth.getProfilePicture();
      if (pic) this.avatar.replaceChildren(h('img', { src: pic, alt: '' }));
    } catch {
      /* initials stay */
    }
  }

  accountItems() {
    const items = [];
    if (this.user) items.push({ type: 'header', label: this.user.username });
    items.push(
      { label: 'Theme', icon: this.commands.get('theme').dynamicIcon(), submenu: () => this.commands.get('theme').menu(this) },
      { label: 'Keyboard Shortcuts', icon: 'keyboard', run: () => this.runCommand('shortcuts') },
      { label: 'About Notes', icon: 'info', run: () => this.runCommand('about') },
    );
    if (this.env !== 'app' && this.onSignOut) {
      items.push({ type: 'sep' }, { label: 'Sign Out', icon: 'logout', run: () => this.signOut() });
    }
    return items;
  }

  async signOut() {
    if (this.store.hasUnsaved()) await this.store.flush().catch(() => {});
    this.onSignOut?.();
  }

  applyLayout() {
    const { navVisible, pagesVisible, railView, fullPage } = this.state;
    // Phones show one level at a time, so pane toggles from a wider window don't apply.
    const phone = this.isPhone();
    this.nav.el.hidden = railView !== 'notebooks' || (!navVisible && !phone);
    this.nav.pagesPane.hidden = !pagesVisible && !phone;
    this.search.el.hidden = railView !== 'search';
    this.recent.el.hidden = railView !== 'recent';
    for (const [view, b] of Object.entries(this.railButtons)) {
      b.setAttribute('aria-pressed', String(view === railView && (view !== 'notebooks' || navVisible)));
    }
    for (const b of this.bottomBar.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === railView));
    this.root.classList.toggle('full-page', fullPage);
    this.exitFullBtn.hidden = !fullPage;
    requestAnimationFrame(() => this.editor.layout());
  }

  /** Phone layout shows one level at a time: sections, pages or the page. */
  setMobileView(view) {
    if (view !== 'page' && this.state.fullPage) {
      this.state.fullPage = false;
      this.applyLayout();
    }
    this.root.dataset.mobileView = view;
    this.mobileBack.setAttribute('aria-label', view === 'page' ? 'Back to pages' : 'Back to sections');
    if (view === 'page') this.titleText.textContent = this.currentTitle();
    else if (view === 'pages') this.titleText.textContent = this.store.section(this.state.sectionId)?.name || 'Pages';
    else this.titleText.textContent = this.store.notebook(this.state.notebookId)?.name || 'Notes';
    if (window.innerWidth > 760) this.updateTitle();
  }

  isPhone() {
    return window.innerWidth <= 760;
  }

  setRailView(view, { focus = false } = {}) {
    if (view !== 'notebooks' && view !== this.state.railView) this.sideOpener = document.activeElement;
    this.state.railView = view;
    if (view === 'notebooks') this.state.navVisible = true;
    this.applyLayout();
    if (view === 'search') {
      this.search.show();
      if (focus) this.search.focus();
    } else if (view === 'recent') this.recent.render();
    if (this.isPhone()) this.root.dataset.mobileView = view === 'notebooks' ? 'sections' : 'sections';
    this.ribbon.refresh();
  }

  /** Closes Search or Recent Notes and puts focus back where it was before. */
  closeSidePanel() {
    const view = this.state.railView;
    const opener = this.sideOpener;
    this.sideOpener = null;
    this.setRailView('notebooks');
    if (opener && this.editor.scroller.contains(opener) && this.editor.restoreRange()) return;
    if (opener?.isConnected && opener !== document.body && opener.offsetParent !== null) opener.focus();
    else this.railButtons[view]?.focus();
  }

  toggleNav() {
    if (this.state.railView !== 'notebooks') {
      this.state.railView = 'notebooks';
      this.state.navVisible = true;
    } else this.state.navVisible = !this.state.navVisible;
    setPref('navVisible', this.state.navVisible);
    this.applyLayout();
    this.ribbon.refresh();
  }

  togglePages() {
    this.state.pagesVisible = !this.state.pagesVisible;
    setPref('pagesVisible', this.state.pagesVisible);
    this.applyLayout();
  }

  toggleFullPage() {
    this.state.fullPage = !this.state.fullPage;
    this.applyLayout();
    this.ribbon.refresh();
    announce(this.state.fullPage ? 'Full page view' : 'Normal view');
  }

  themeChanged() {
    this.editor.applyBackground();
    this.renderNav();
    this.ribbon.refresh();
  }

  // ------------------------------------------------------------ store wiring

  bindStore() {
    this.store.on('change', (e) => {
      if (e.type === 'page-title') return;
      this.renderNav();
    });
    this.store.on('status', (s) => this.updateSync(s));
    this.store.on('assets-renamed', ({ id, map }) => {
      if (this.editor.page?.id === id) this.editor.renameAssets(map);
    });
    this.store.on('page-replaced', async ({ id }) => {
      if (id === this.state.pageId) await this.editor.open(await this.store.loadPage(id));
    });
    this.listen(window, 'beforeunload', (e) => {
      this.editor.flush();
      if (this.store.hasUnsaved()) {
        this.store.flush();
        e.preventDefault();
        e.returnValue = '';
      }
    });
    // A link pasted into this tab's address bar (or Back/Forward between
    // such links) only changes the hash, so follow it here too.
    this.listen(window, 'hashchange', () => this.followHash());
    this.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.editor.flush();
        this.store.flush();
      } else this.refreshFromCloud();
    });
    // Switching between visible windows (or Puter app windows) changes
    // focus, not visibility.
    this.listen(window, 'focus', () => this.refreshFromCloud());
    this.refreshFromCloud = debounce(async () => {
      try {
        if (await this.store.refresh()) this.ensureSelection();
        const id = this.state.pageId;
        if (id && !this.editor.dirty.size && !this.editor.commitSoon.pending() && (await this.store.refreshPage(id))) toast('This page was updated on another device.');
      } catch {
        /* offline */
      }
    }, 1500);
  }

  updateSync(status) {
    const map = {
      saved: ['cloudCheck', 'All changes saved'],
      pending: ['cloud', 'Changes not yet saved'],
      saving: ['sync', 'Saving changes...'],
      error: ['cloudAlert', "Can't save right now. Your changes are kept and will be retried."],
    };
    const [ic, label] = map[status] || map.saved;
    this.syncBtn.replaceChildren(icon(ic, 18));
    this.syncBtn.dataset.status = status;
    this.syncBtn.setAttribute('aria-label', `${label.replace(/\.+$/, '')}. Sync now`);
    this.syncBtn.dataset.tip = label;
  }

  async syncNow() {
    this.editor.flush();
    try {
      await this.store.flush();
      await this.store.refresh();
      toast(this.store.status === 'error' ? "Some changes couldn't be saved yet. Retrying." : 'All changes saved', { kind: this.store.status === 'error' ? 'error' : 'info' });
    } catch {
      toast("Couldn't reach your cloud storage. Changes will be retried.", { kind: 'error' });
    }
  }

  // ------------------------------------------------------------ navigation

  async start() {
    const p = prefs();
    const lastPage = p.lastPage && this.store.findPage(p.lastPage);
    if (location.hash.startsWith('#page=')) {
      const id = location.hash.slice(6);
      if (this.store.findPage(id)) return this.openPage(id, { focus: false });
    }
    if (location.hash.startsWith('#section=')) {
      const id = location.hash.slice(9);
      if (this.store.section(id)) return this.selectSection(id, { focus: false });
    }
    if (lastPage) return this.openPage(lastPage.meta.id, { focus: false });
    this.ensureSelection();
  }

  /** Opens the page or section a #page= or #section= link names. */
  followHash() {
    const hash = location.hash;
    if (hash.startsWith('#page=')) {
      const id = hash.slice(6);
      if (id === this.state.pageId) return;
      if (this.store.findPage(id)) this.openPage(id);
      else toast("That page isn't available. It may have been deleted.", { kind: 'error' });
    } else if (hash.startsWith('#section=')) {
      const id = hash.slice(9);
      if (this.store.section(id)) this.selectSection(id, { focus: false });
      else toast("That section isn't available. It may have been deleted.", { kind: 'error' });
    }
  }

  /** Makes sure a notebook, section and (if possible) page are selected. */
  ensureSelection() {
    const s = this.store;
    let nb = s.notebook(this.state.notebookId) || s.notebook(prefs().lastNotebook) || s.notebooks[0];
    if (!nb) {
      this.state.notebookId = null;
      this.renderNav();
      this.showEmpty();
      return;
    }
    this.state.notebookId = nb.id;
    const sections = [...s.sectionsOf(nb)];
    let section = s.section(this.state.sectionId);
    if (!section || !sections.includes(section)) section = sections[0] || null;
    this.state.sectionId = section?.id || null;
    if (section && !(section.locked && !this.isUnlocked(section.id))) {
      const meta = section.pages.find((m) => m.id === this.state.pageId) || section.pages.find((m) => m.id === prefs().sectionPages[section.id]) || section.pages[0];
      if (meta) {
        if (meta.id !== this.state.pageId || !this.editor.page) return this.openPage(meta.id, { focus: false });
      } else {
        this.state.pageId = null;
        this.showEmpty();
      }
    } else {
      this.state.pageId = null;
      this.showEmpty(section?.locked ? 'locked' : undefined);
    }
    this.renderNav();
  }

  renderNav() {
    this.nav.renderSections();
    this.nav.renderPages();
    if (this.state.railView === 'recent') this.recent.render();
    else if (this.state.railView === 'search') this.search.syncScope();
    this.updateTitle();
  }

  currentTitle() {
    const f = this.state.pageId && this.store.findPage(this.state.pageId);
    return f ? f.meta.title?.trim() || 'Untitled Page' : 'Notes';
  }

  updateTitle() {
    const title = this.currentTitle();
    const nb = this.store.notebook(this.state.notebookId);
    document.title = this.state.pageId ? `${title} - Notes` : 'Notes';
    this.pageHeading.textContent = this.state.pageId ? title : 'Notes';
    if (!this.isPhone()) this.titleText.textContent = nb ? `${title}${this.state.pageId ? ' - ' : ''}${this.state.pageId ? nb.name : ''}` : 'Notes';
    else if (this.root.dataset.mobileView === 'page') this.titleText.textContent = title;
  }

  selectNotebook(id) {
    this.flushEditor();
    this.state.notebookId = id;
    this.state.sectionId = null;
    this.state.pageId = null;
    setPref('lastNotebook', id);
    this.ensureSelection();
    if (this.isPhone()) this.setMobileView('sections');
  }

  /** unlock: false selects a locked section without asking for its password; the page offers Unlock. */
  async selectSection(id, { focus = true, unlock = true } = {}) {
    const f = this.store.findNode(id);
    if (!f || f.node.type !== 'section') return;
    if (unlock && f.node.locked && !this.isUnlocked(id)) {
      const ok = await features.unlockSection(this, f.node);
      if (!ok) return;
    }
    this.flushEditor();
    this.state.notebookId = f.notebook.id;
    this.state.sectionId = id;
    this.state.pageId = null;
    setPref('lastSection', id);
    this.ensureSelection();
    if (this.isPhone()) this.setMobileView('pages');
    if (focus && !this.isPhone()) this.nav.focusRow(id);
  }

  async openPage(id, { focus = false, find } = {}) {
    const f = this.store.findPage(id);
    if (!f) return;
    if (f.section.locked && !this.isUnlocked(f.section.id)) {
      const ok = await features.unlockSection(this, f.section);
      if (!ok) return;
    }
    this.flushEditor();
    this.state.notebookId = f.notebook.id;
    this.state.sectionId = f.section.id;
    this.state.pageId = id;
    setPref('lastPage', id);
    setPref('lastNotebook', f.notebook.id);
    const sp = { ...prefs().sectionPages, [f.section.id]: id };
    setPref('sectionPages', sp);
    if (location.hash !== `#page=${id}`) history.replaceState(null, '', `#page=${id}`);
    this.renderNav();
    // With no page on screen (an empty or error state), that state stays
    // until the page arrives rather than showing a stale page.
    if (this.editor.page) this.showCanvas();
    // Until the page arrives, the page still on screen takes no input: it is
    // no longer the selected page.
    this.editor.scroller.toggleAttribute('inert', true);
    let failure = null;
    const page = await this.store.loadPage(id).catch((err) => {
      console.error(err);
      failure = err;
      return null;
    });
    // A newer selection owns the canvas now.
    if (this.state.pageId !== id) return;
    this.editor.scroller.toggleAttribute('inert', false);
    if (!page) {
      // A file that is there but can't be parsed won't load on a retry.
      const damaged = failure instanceof SyntaxError;
      toast(damaged ? "Couldn't open this page: its file is damaged." : "Couldn't open this page. Check your connection and try again.", { kind: 'error' });
      this.showEmpty(damaged ? 'damaged' : 'load-error');
      if (this.isPhone()) this.setMobileView('page');
      return;
    }
    this.showCanvas();
    this.editor.setSurface(prefs().surface === 'light' ? 'light' : 'auto');
    await this.editor.open(page);
    this.editor.setZoom(prefs().zoom || 1);
    this.find.pageChanged();
    this.taskPanes.pageChanged();
    if (this.isPhone()) {
      if (this.state.railView !== 'notebooks') {
        this.state.railView = 'notebooks';
        this.applyLayout();
      }
      this.setMobileView('page');
    }
    if (focus) {
      if (!page.title && !page.outlines.length) this.editor.titleEl.focus();
      else this.editor.focusFirstOutline();
    }
    if (find) this.find.open(find);
    this.updateFormatState();
  }

  flushEditor() {
    this.editor.flush();
  }

  showCanvas() {
    this.canvasCol.querySelector('.canvas-empty')?.remove();
    this.editor.scroller.hidden = false;
  }

  showEmpty(kind) {
    this.editor.flush();
    this.editor.page = null;
    this.editor.scroller.hidden = true;
    this.editor.scroller.toggleAttribute('inert', false);
    this.canvasCol.querySelector('.canvas-empty')?.remove();
    const section = this.store.section(this.state.sectionId);
    let body;
    if (kind === 'load-error' || kind === 'damaged') {
      // The selected page couldn't be loaded; the list keeps it selected.
      const id = this.state.pageId;
      body = kind === 'damaged'
        ? h('div', icon('cloudOff', 32), h('h2', "This page can't be opened"), h('p', 'Its file is damaged.'))
        : h('div', icon('cloudOff', 32), h('h2', "Couldn't open this page"), h('p', 'Check your connection and try again.'), h('button.btn.primary', { type: 'button', onclick: () => id && this.openPage(id, { focus: true }) }, 'Try again'));
    } else if (kind === 'locked') {
      body = h('div', icon('lock', 32), h('h2', 'This section is password protected'), h('p', 'Enter its password to see its pages.'), h('button.btn.primary', { type: 'button', onclick: () => section && this.selectSection(section.id) }, 'Unlock'));
    } else if (!this.store.notebook(this.state.notebookId)) {
      body = h('div', icon('notebook', 32), h('h2', 'No notebooks yet'), h('p', 'Add a notebook to start writing.'), h('button.btn.primary', { type: 'button', onclick: () => this.newNotebook() }, 'Add notebook'));
    } else if (!section) {
      body = h('div', icon('notebook', 32), h('h2', 'No sections yet'), h('p', 'Add a section to start writing.'), h('button.btn.primary', { type: 'button', onclick: () => this.newSection() }, 'Add section'));
    } else {
      body = h('div', icon('newPage', 32), h('h2', 'No pages in this section'), h('p', 'Add a page to start writing.'), h('button.btn.primary', { type: 'button', onclick: () => this.newPage() }, 'Add page'));
    }
    this.canvasCol.append(h('div.canvas-empty', body));
    this.updateFormatState();
    this.updateTitle();
  }

  stepPage(dir) {
    const section = this.store.section(this.state.sectionId);
    if (!section) return;
    // Follow the page list as shown: its sort order, without the subpages
    // of collapsed pages.
    const ids = [...this.nav.pagesList.querySelectorAll('.row')].map((r) => r.dataset.id);
    const next = ids[ids.indexOf(this.state.pageId) + dir];
    if (next) this.openPage(next);
  }

  isUnlocked(id) {
    return this.store.keys.has(id);
  }

  /** Locks a protected section and closes its page if it is open. */
  async lockSection(id) {
    if (this.state.sectionId === id) {
      this.editor.flush();
      this.showEmpty('locked');
      this.state.pageId = null;
    }
    await this.store.lockSection(id);
    this.unlocked.delete(id);
    this.renderNav();
  }

  async lockAll() {
    const ids = [...this.store.keys.keys()];
    if (!ids.length) {
      toast('There are no unlocked protected sections.');
      return;
    }
    for (const id of ids) await this.lockSection(id);
    toast('Protected sections locked');
  }

  /** Protected sections lock again after ten minutes without activity. */
  touchProtected() {
    clearTimeout(this.lockTimer);
    if (!this.store.keys.size) return;
    this.lockTimer = setTimeout(() => {
      if (this.store.keys.size) this.lockAll();
    }, 10 * 60 * 1000);
  }

  // ------------------------------------------------------------ create / delete

  newPage({ sub = false, outlines, title = '' } = {}) {
    const section = this.store.section(this.state.sectionId);
    if (section && this.store.isLocked(section.id)) {
      features.unlockSection(this, section).then((ok) => ok && this.newPage({ sub, outlines, title }));
      return null;
    }
    if (!section) {
      if (!this.store.notebook(this.state.notebookId)) return this.newNotebook();
      const s = this.store.createSection(this.state.notebookId);
      this.state.sectionId = s.id;
      return this.newPage({ sub, outlines, title });
    }
    let index = section.pages.length;
    let level = 0;
    const cur = section.pages.findIndex((p) => p.id === this.state.pageId);
    if (cur >= 0) {
      const [, end] = this.store.pageGroup(section, cur);
      index = sub ? cur + 1 : end;
      level = sub ? Math.min(2, (section.pages[cur].level || 0) + 1) : section.pages[cur].level || 0;
    }
    const meta = this.store.createPage(section.id, { index, level, title, outlines, rules: prefs().defaultRules || null });
    this.openPage(meta.id, { focus: true });
    announce(sub ? 'New subpage added' : 'New page added');
    return meta;
  }

  newSection() {
    const nb = this.store.notebook(this.state.notebookId);
    if (!nb) return this.newNotebook();
    // A new section goes after the current one, in the same group.
    const f = this.state.sectionId && this.store.findNode(this.state.sectionId);
    const parentId = f?.parent?.id || null;
    const index = f ? f.index + 1 : undefined;
    const section = this.store.createSection(nb.id, { parentId, index });
    const meta = this.store.createPage(section.id, { rules: prefs().defaultRules || null });
    this.state.sectionId = section.id;
    this.openPage(meta.id);
    requestAnimationFrame(() => {
      const row = this.nav.sectionsList.querySelector(`.row[data-id="${section.id}"]`);
      if (row) this.nav.rename(row, section.name, (v) => this.store.renameNode(section.id, v));
    });
    return section;
  }

  async newSectionGroup() {
    const nb = this.store.notebook(this.state.notebookId);
    if (!nb) return;
    const name = await promptText({ title: 'New Section Group', label: 'Section group name', value: 'New Section Group' });
    if (!name) return;
    this.store.createGroup(nb.id, { name });
  }

  async newNotebook() {
    const name = await promptText({ title: 'New Notebook', label: 'Notebook name', value: '', placeholder: 'My Notebook', okLabel: 'Create' });
    if (!name) return;
    const nb = this.store.createNotebook(name);
    const s = this.store.createSection(nb.id, { name: 'New Section 1' });
    const meta = this.store.createPage(s.id);
    this.openPage(meta.id, { focus: true });
  }

  renamePage(id, title) {
    if (id === this.state.pageId && this.editor.page) {
      this.editor.titleEl.textContent = title;
      this.editor.commit();
    } else {
      this.store.loadPage(id).then((page) => {
        page.title = title;
        this.store.pageChanged(page, { title });
        this.renderNav();
      }, (err) => {
        console.error(err);
        toast("Couldn't rename the page. Check your connection and try again.", { kind: 'error' });
        this.renderNav();
      });
    }
  }

  deletePage(id) {
    const f = this.store.findPage(id);
    if (!f) return;
    const section = f.section;
    const index = f.index;
    this.editor.flush();
    const entry = this.store.deletePage(id);
    if (!entry) return;
    if (entry.pages.some((p) => p.id === this.state.pageId)) {
      const next = section.pages[Math.min(index, section.pages.length - 1)];
      this.state.pageId = null;
      if (next) this.openPage(next.id);
      else this.showEmpty();
    }
    toast(`Page "${f.meta.title || 'Untitled Page'}" moved to Deleted Notes`, { action: { label: 'Undo', run: () => this.restoreTrash(entry.id) } });
  }

  async deleteSection(id) {
    const f = this.store.findNode(id);
    if (!f) return;
    const kind = f.node.type === 'group' ? 'section group' : 'section';
    const ok = await confirmDialog({ title: `Delete ${kind}?`, message: `"${f.node.name}" and its pages will be moved to Deleted Notes. You can restore it from there for ${60} days.`, okLabel: 'Delete', danger: true });
    if (!ok) return;
    this.editor.flush();
    const entry = this.store.deleteNode(id);
    if (this.state.sectionId === id || (f.node.type === 'group' && !this.store.section(this.state.sectionId))) {
      this.state.sectionId = null;
      this.state.pageId = null;
    }
    this.ensureSelection();
    toast(`"${f.node.name}" moved to Deleted Notes`, { action: { label: 'Undo', run: () => this.restoreTrash(entry.id) } });
  }

  async deleteNotebook(id) {
    const nb = this.store.notebook(id);
    if (!nb) return;
    const ok = await confirmDialog({ title: 'Delete notebook?', message: `"${nb.name}" will be moved to Deleted Notes. You can restore it from there for 60 days.`, okLabel: 'Delete', danger: true });
    if (!ok) return;
    const entry = this.store.deleteNotebook(id);
    if (this.state.notebookId === id) {
      this.state.notebookId = null;
      this.state.sectionId = null;
      this.state.pageId = null;
    }
    this.ensureSelection();
    toast(`"${nb.name}" moved to Deleted Notes`, { action: { label: 'Undo', run: () => this.restoreTrash(entry.id) } });
  }

  async restoreTrash(trashId) {
    if (!(await this.store.openTrash(trashId))) {
      toast('Unlock the protected section first to restore this page.', { kind: 'error' });
      return false;
    }
    const kind = this.store.trash.find((t) => t.id === trashId)?.kind;
    const r = this.store.restore(trashId);
    if (!r) {
      // Nothing was restored: the section it goes back to is locked, or
      // there is no notebook left to put it in.
      toast(kind === 'page' && this.store.notebooks.length ? 'Unlock the protected section first to restore this page.' : "Couldn't restore this. Create a notebook first, then try again.", { kind: 'error' });
      return false;
    }
    if (r.pageId) this.openPage(r.pageId);
    else if (r?.sectionId) this.selectSection(r.sectionId, { focus: false });
    else if (r?.notebookId) this.selectNotebook(r.notebookId);
    else this.ensureSelection();
    announce('Restored');
    return true;
  }

  setPageLevel(delta) {
    if (!this.state.pageId) return;
    if (!this.store.setPageLevel(this.state.pageId, delta)) announce(delta > 0 ? "Can't make this page a subpage here" : 'Already a top-level page');
    else announce(delta > 0 ? 'Made subpage' : 'Promoted subpage');
  }

  /** Alt+Shift+Up/Down in the panes. */
  moveByKeyboard(kind, id, dir) {
    if (kind === 'page') {
      const f = this.store.findPage(id);
      if (!f) return;
      const pages = f.section.pages;
      const [start, end] = this.store.pageGroup(f.section, f.index);
      if (dir < 0) {
        if (start === 0) return;
        let target = start - 1;
        while (target > 0 && (pages[target].level || 0) > (f.meta.level || 0)) target--;
        this.store.movePage(id, { sectionId: f.section.id, index: target });
      } else {
        if (end >= pages.length) return;
        const [, nextEnd] = this.store.pageGroup(f.section, end);
        this.store.movePage(id, { sectionId: f.section.id, index: nextEnd });
      }
    } else {
      const f = this.store.findNode(id);
      if (!f) return;
      const index = f.index + dir;
      if (index < 0 || index >= f.list.length) return;
      this.store.moveNode(id, { notebookId: f.notebook.id, parentId: f.parent?.id || null, index: dir > 0 ? index + 1 : index });
    }
    requestAnimationFrame(() => this.nav.focusRow(id));
    announce(dir < 0 ? 'Moved up' : 'Moved down');
  }

  /** Drag-and-drop result from the panes. */
  drop(drag, target, listKind) {
    if (drag.kind === 'page') {
      if (target.into) {
        if (this.store.isLocked(target.into)) {
          toast('Unlock that section before moving pages into it.', { kind: 'error' });
          return;
        }
        if (this.store.movePage(drag.id, { sectionId: target.into, level: 0 })) {
          toast('Page moved');
          // When the open page moved (or went along as a subpage), follow
          // it to its new section, as Move or Copy does.
          const f = this.state.pageId && this.store.findPage(this.state.pageId);
          if (f && f.section.id !== this.state.sectionId) this.openPage(f.meta.id);
        }
        return;
      }
      const section = this.store.section(this.state.sectionId);
      if (!section) return;
      let index = target.end ? section.pages.length : section.pages.findIndex((p) => p.id === target.id);
      if (index < 0) return;
      if (!target.before && !target.end) {
        // After a row means after its subpage group when collapsed.
        const meta = section.pages[index];
        index = meta.collapsed ? this.store.pageGroup(section, index)[1] : index + 1;
      }
      const prevLevel = index > 0 ? section.pages[index - 1]?.level || 0 : -1;
      const level = Math.min(target.level ?? 0, prevLevel + 1);
      this.store.movePage(drag.id, { sectionId: section.id, index, level: Math.max(0, level) });
    } else if (drag.kind === 'section' && listKind === 'section') {
      if (target.into) {
        this.store.moveNode(drag.id, { notebookId: this.state.notebookId, parentId: target.into, index: 0 });
        return;
      }
      const nb = this.store.notebook(this.state.notebookId);
      if (target.end) {
        this.store.moveNode(drag.id, { notebookId: nb.id, parentId: null });
        return;
      }
      const f = this.store.findNode(target.id);
      if (!f) return;
      this.store.moveNode(drag.id, { notebookId: f.notebook.id, parentId: f.parent?.id || null, index: target.before ? f.index : f.index + 1 });
    }
  }

  // ------------------------------------------------------------ menus

  openNotebookMenu(anchor) {
    const current = this.state.notebookId;
    openMenu(anchor, [
      { type: 'header', label: 'Notebooks' },
      ...this.store.notebooks.map((nb) => ({ label: nb.name, radio: true, checked: nb.id === current, swatch: this.nav.colorOf(nb.color), run: () => this.selectNotebook(nb.id) })),
      { type: 'sep' },
      { label: 'Add Notebook', icon: 'plus', run: () => this.newNotebook() },
      { label: 'Notebook Settings', icon: 'notebook', disabled: !current, submenu: () => this.notebookItems(this.store.notebook(current)) },
    ], { label: 'Notebooks' });
  }

  notebookItems(nb) {
    if (!nb) return [];
    const index = this.store.notebooks.indexOf(nb);
    return [
      { label: 'Rename Notebook...', icon: 'penLine', run: async () => {
        const name = await promptText({ title: 'Rename Notebook', label: 'Notebook name', value: nb.name, okLabel: 'Rename' });
        if (name) this.store.renameNotebook(nb.id, name);
      } },
      { label: 'Notebook Color', icon: 'palette', submenu: () => SECTION_COLORS.map((c) => ({ label: c.label, swatch: this.nav.colorOf(c.id), radio: true, checked: nb.color === c.id, run: () => this.store.setNotebookColor(nb.id, c.id) })) },
      { label: 'Move Up', icon: 'up', disabled: index <= 0, run: () => this.store.moveNotebook(nb.id, index - 1) },
      { label: 'Move Down', icon: 'down', disabled: index >= this.store.notebooks.length - 1, run: () => this.store.moveNotebook(nb.id, index + 1) },
      { label: 'Export Notebook Backup', icon: 'download', run: () => features.exportNotebook(this, nb.id) },
      { type: 'sep' },
      { label: 'Delete Notebook', icon: 'trash', danger: true, run: () => this.deleteNotebook(nb.id) },
    ];
  }

  sectionMenu(node, point) {
    if (node.type === 'group') {
      openMenu(point, [
        { label: 'Rename', icon: 'penLine', shortcut: 'F2', run: () => this.renameRow(node.id, node.name) },
        { label: node.collapsed ? 'Expand' : 'Collapse', icon: node.collapsed ? 'expand' : 'collapse', run: () => this.store.toggleGroup(node.id) },
        { type: 'sep' },
        { label: 'New Section', icon: 'newSection', run: () => {
          const s = this.store.createSection(this.state.notebookId, { parentId: node.id });
          this.store.createPage(s.id);
          this.selectSection(s.id);
        } },
        { label: 'New Section Group', icon: 'sectionGroup', run: () => this.store.createGroup(this.state.notebookId, { parentId: node.id }) },
        { label: 'Move or Copy...', icon: 'folderOpen', run: () => this.moveDialog('group', node.id) },
        { type: 'sep' },
        { label: 'Delete', icon: 'trash', danger: true, run: () => this.nav.refocusAfter('section', this.deleteSection(node.id)) },
      ], { label: node.name });
      return;
    }
    openMenu(point, [
      { label: 'Rename', icon: 'penLine', shortcut: 'F2', run: () => this.renameRow(node.id, node.name) },
      { label: 'Section Color', icon: 'palette', submenu: () => SECTION_COLORS.map((c) => ({ label: c.label, swatch: this.nav.colorOf(c.id), radio: true, checked: node.color === c.id, run: () => this.store.setSectionColor(node.id, c.id) })) },
      { label: 'Move or Copy...', icon: 'folderOpen', run: () => this.moveDialog('section', node.id) },
      { label: 'Copy Link to Section', icon: 'link', run: () => this.copyLink('section', node.id) },
      { label: node.locked ? 'Password Protection...' : 'Password Protect This Section...', icon: 'lock', run: () => features.passwordDialog(this, node) },
      { label: 'Lock Section', icon: 'lock', hidden: !(node.locked && this.isUnlocked(node.id)), run: () => this.lockSection(node.id) },
      { label: 'Export Section', icon: 'download', run: () => features.exportSection(this, node.id) },
      { type: 'sep' },
      { label: 'New Section', icon: 'newSection', run: () => this.newSection() },
      { label: 'New Section Group', icon: 'sectionGroup', run: () => this.newSectionGroup() },
      { type: 'sep' },
      { label: 'Delete', icon: 'trash', danger: true, shortcut: 'Delete', run: () => this.nav.refocusAfter('section', this.deleteSection(node.id)) },
    ], { label: node.name });
  }

  renameRow(id, value) {
    const row = this.nav.el.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) this.nav.rename(row, value, (v) => this.store.renameNode(id, v));
  }

  pageMenu(meta, point) {
    const f = this.store.findPage(meta.id);
    if (!f) return;
    const level = meta.level || 0;
    openMenu(point, [
      { label: 'New Page', icon: 'newPage', run: () => { this.state.pageId = meta.id; this.newPage(); } },
      { label: 'New Subpage', icon: 'subpage', run: () => { this.state.pageId = meta.id; this.newPage({ sub: true }); } },
      { type: 'sep' },
      { label: 'Rename', icon: 'penLine', shortcut: 'F2', run: () => {
        const row = this.nav.pagesList.querySelector(`.row[data-id="${CSS.escape(meta.id)}"]`);
        if (row) this.nav.rename(row, meta.title || '', (v) => this.renamePage(meta.id, v), true);
      } },
      { label: 'Make Subpage', icon: 'subpage', shortcut: 'Mod+Alt+BracketRight', disabled: f.index === 0 || level >= 2, run: () => this.store.setPageLevel(meta.id, 1) },
      { label: 'Promote Subpage', icon: 'promote', shortcut: 'Mod+Alt+BracketLeft', disabled: level === 0, run: () => this.store.setPageLevel(meta.id, -1) },
      { label: meta.collapsed ? 'Expand Subpages' : 'Collapse Subpages', icon: meta.collapsed ? 'expand' : 'collapse', disabled: !(f.section.pages[f.index + 1] && (f.section.pages[f.index + 1].level || 0) > level), run: () => this.store.togglePageCollapsed(meta.id) },
      { type: 'sep' },
      { label: 'Move or Copy...', icon: 'folderOpen', run: () => this.moveDialog('page', meta.id) },
      { label: 'Duplicate Page', icon: 'copy', run: async () => {
        const m = await this.store.copyPage(meta.id).catch((err) => {
          console.error(err);
          toast(`Couldn't duplicate "${meta.title || 'Untitled Page'}". Check your connection and try again.`, { kind: 'error' });
        });
        if (m) this.openPage(m.id);
      } },
      { label: 'Copy Link to Page', icon: 'link', run: () => this.copyLink('page', meta.id) },
      { type: 'sep' },
      { label: 'Delete Page', icon: 'trash', danger: true, shortcut: 'Delete', run: () => this.nav.refocusAfter('page', this.deletePage(meta.id)) },
    ], { label: meta.title || 'Untitled Page' });
  }

  // ------------------------------------------------------------ editor wiring

  bindEditor() {
    const ed = this.editor;
    ed.on('selection', () => this.updateFormatSoon());
    ed.on('change', () => {
      this.updateTitle();
      this.updateFormatSoon();
    });
    ed.on('insert-failed', ({ file, err }) => toast(`Couldn't insert ${file.name || 'the file'}: ${err?.message || 'upload failed'}`, { kind: 'error' }));
    ed.on('title-input', (title) => {
      if (this.state.pageId) this.nav.updatePageTitle(this.state.pageId, title);
    });
    ed.on('navigate', ({ kind, id }) => {
      if (kind === 'page') {
        if (this.store.findPage(id)) this.openPage(id);
        else toast("That page isn't available. It may have been deleted.", { kind: 'error' });
      } else if (this.store.section(id)) this.selectSection(id);
      else toast("That section isn't available. It may have been deleted.", { kind: 'error' });
    });
    ed.on('open-file', (data) => features.openAttachment(this, data));
    ed.on('edit-math', (span) => this.equationDialog(span));
    ed.on('edit-date', () => features.pageDateDialog(this));
    ed.on('zoom', (z) => {
      setPref('zoom', z);
      this.refreshCombos();
    });
    this.updateFormatSoon = debounce(() => this.updateFormatState(), 60);
    ed.scroller.addEventListener('mouseup', () => {
      if (this.painter) setTimeout(() => this.applyFormatPainter(), 0);
    });
    ed.scroller.addEventListener('contextmenu', (e) => features.canvasContextMenu(this, e));
  }

  updateFormatState() {
    // Typing in Tell Me or the Font boxes moves the selection out of the
    // note, but their commands act on the note's last caret, so the ribbon
    // keeps describing that caret while it is still on the page.
    const last = this.editor.lastRange?.commonAncestorContainer;
    const inRibbon = this.ribbon.el.contains(document.activeElement) && this.format?.editable && last?.isConnected && this.editor.scroller.contains(last);
    if (!inRibbon) {
      this.format = this.editor.page ? queryFormat() : { editable: false };
      if (this.format.editable && !this.editor.scroller.contains(this.format.root)) this.format = { editable: false };
      this.activeTags = this.format.inBody ? activeTags() : new Set();
      this.ribbon.setContextual(this.format.inTable ? 'table' : null);
    }
    this.ribbon.refresh();
    this.undoBtn.disabled = !this.commands.get('undo').enabled(this);
    this.redoBtn.disabled = !this.commands.get('redo').enabled(this);
  }

  setTool(tool, opts) {
    this.editor.ink.setTool(tool, opts);
    this.ribbon.refresh();
    announce(`${{ type: 'Type', lasso: 'Lasso Select', eraser: 'Eraser', pen: 'Pen', shape: 'Shape', space: 'Insert Space' }[tool] || tool} tool`);
  }

  /**
   * Picks a pen. With ink selected, the pick restyles that ink instead
   * (only what `changes` names; a whole pen by default) and becomes the
   * pen for what's drawn next, keeping the selection.
   */
  setPen(pen, changes = { color: pen.color, width: pen.width, highlighter: Boolean(pen.highlighter) }) {
    const ink = this.editor.ink;
    if (ink.selected.size && !this.editor.readOnly) {
      ink.pen = { ...pen };
      ink.recolor(changes);
      this.ribbon.refresh();
      announce('Selected ink changed');
      return;
    }
    this.setTool('pen', { pen });
  }

  setPageColor(color) {
    this.editor.page.color = color;
    this.editor.applyBackground();
    this.editor.changed();
    this.ribbon.refresh();
  }

  setRules(rules) {
    this.editor.page.rules = rules;
    this.editor.applyBackground();
    this.editor.changed();
  }

  switchBackground() {
    const next = this.editor.surface === 'light' ? 'auto' : 'light';
    setPref('surface', next);
    this.editor.setSurface(next);
    this.ribbon.refresh();
  }

  newWindow() {
    const url = `${location.pathname}${location.search}#page=${this.state.pageId}`;
    window.open(url, '_blank', 'noopener');
  }

  // ------------------------------------------------------------ combos

  buildCombo(kind, ribbon) {
    const isName = kind === 'fontName';
    const listId = `combo-${kind}`;
    const input = h('input', { type: 'text', 'aria-label': isName ? 'Font' : 'Font Size', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', 'aria-controls': listId, spellcheck: 'false', autocomplete: 'off' });
    const btn = h('button', { type: 'button', tabindex: '-1', 'aria-label': isName ? 'Font list' : 'Font size list' }, icon('chevDown', 12));
    const wrap = h('div.rb-combo', { style: { width: isName ? '128px' : '52px' } }, input, btn);
    const apply = (value) => {
      this.editor.restoreRange();
      if (isName) {
        const f = FONTS.find((x) => x.label.toLowerCase() === String(value).toLowerCase());
        setFontName(f ? f.value : value);
      } else {
        const n = parseFloat(value);
        if (n >= 1 && n <= 400) setFontSize(n);
      }
      this.editor.rememberRange();
      this.editor.markActiveDirty();
      this.updateFormatState();
    };
    const openList = () => {
      const items = isName
        ? FONTS.map((f) => ({ label: f.label, radio: true, checked: this.format.fontName === f.label, run: () => apply(f.label) }))
        : SIZES.map((s) => ({ label: String(s), radio: true, checked: this.format.fontSize === s, run: () => apply(s) }));
      // Escape goes back to the box, or to the note when the arrow opened the list.
      openMenu(wrap, items, { label: isName ? 'Fonts' : 'Font sizes', className: isName ? 'font-menu' : 'size-menu' });
    };
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', openList);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply(input.value);
        this.editor.restoreRange();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.editor.restoreRange();
      } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        openList();
      }
    });
    input.addEventListener('focus', () => input.select());
    this.combos ||= [];
    this.combos.push({ kind, input });
    void ribbon;
    return wrap;
  }

  refreshCombos() {
    for (const c of this.combos || []) {
      if (document.activeElement === c.input) continue;
      c.input.disabled = !this.format.inBody && !this.format.editable;
      if (c.kind === 'fontName') c.input.value = this.format.editable ? this.format.fontName : '';
      else c.input.value = this.format.editable ? String(this.format.fontSize || DEFAULT_SIZE) : '';
    }
  }

  // ------------------------------------------------------------ Tell Me

  buildTellMe() {
    const input = h('input', { type: 'search', placeholder: 'Tell me', 'aria-label': 'Tell me what you want to do', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false' });
    this.tellMeInput = input;
    const wrap = h('div.tell-me', icon('tellMe', 14), input);
    let menu = null;
    const show = () => {
      const q = input.value.trim().toLowerCase();
      menu?.close(false);
      if (!q) return;
      const seen = new Set();
      const matches = [...this.commands.values()].filter((c) => {
        if (c.hidden?.(this) || seen.has(c.label)) return false;
        const hit = c.label.toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q);
        if (hit) seen.add(c.label);
        return hit;
      }).slice(0, 10);
      const items = matches.length
        ? matches.map((c) => ({ label: c.label, icon: c.icon, shortcut: c.key, disabled: c.enabled ? !c.enabled(this) : false, submenu: c.menu && !c.run ? () => c.menu(this) : undefined, run: c.run ? () => { input.value = ''; this.editor.restoreRange(); this.runCommand(c.id); } : undefined }))
        : [{ label: `No commands match "${input.value}"`, disabled: true }];
      // Escape from the results goes back to the box, not the page body.
      menu = openMenu(wrap, items, { label: 'Commands', onClose: () => input.setAttribute('aria-expanded', 'false') });
      input.setAttribute('aria-expanded', 'true');
      input.focus();
    };
    const showSoon = debounce(show, 120);
    input.addEventListener('input', showSoon);
    // The results may still be for what was typed before the last keys.
    const showNow = () => {
      if (!showSoon.pending() && menu?.el.isConnected) return;
      showSoon.cancel();
      show();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        showNow();
        menu?.el.querySelector('[role^="menuitem"]')?.focus();
      } else if (e.key === 'Escape') {
        showSoon.cancel();
        input.value = '';
        closeAllMenus();
        this.editor.restoreRange();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        showNow();
        menu?.el.querySelector('[role^="menuitem"]:not([aria-disabled="true"])')?.click();
      }
    });
    return wrap;
  }

  focusTellMe() {
    if (this.isPhone()) return;
    this.tellMeInput.focus();
  }

  // ------------------------------------------------------------ commands & keys

  runCommand(id, arg) {
    const c = this.commands.get(id);
    if (!c) return;
    this.updateFormatSoon?.cancel?.();
    this.format = this.editor.page ? queryFormat() : { editable: false };
    if (this.format.editable && !this.editor.scroller.contains(this.format.root)) this.format = { editable: false };
    if (c.enabled && !c.enabled(this, arg)) return;
    hideTooltip();
    this.ribbon?.el.classList.remove('peek');
    try {
      const result = c.run ? c.run(this, arg) : null;
      if (result?.catch) result.catch((err) => this.reportError(err));
    } catch (err) {
      this.reportError(err);
    }
    this.updateFormatSoon?.();
  }

  reportError(err) {
    console.error(err);
    toast(err?.message ? `Something went wrong: ${err.message}` : 'Something went wrong.', { kind: 'error' });
  }

  bindKeys() {
    const shortcutCommands = [...this.commands.values()].filter((c) => c.key && !['paste', 'cut', 'copy', 'undo', 'redo'].includes(c.id));
    this.listen(document, 'pointerdown', () => this.store.keys.size && this.touchProtected(), true);
    this.listen(document, 'keydown', (e) => {
      if (this.store.keys.size) this.touchProtected();
      if (e.defaultPrevented) return;
      if (isMenuOpen() && e.key !== 'Escape') return;
      if (document.querySelector('dialog[open], .reader')) return;
      if (e.key === 'F6') {
        e.preventDefault();
        this.cycleRegions(e.shiftKey ? -1 : 1);
        return;
      }
      const inField = e.target.closest?.('input, textarea, select');
      for (const c of shortcutCommands) {
        if (!matchShortcut(e, c.key)) continue;
        // Plain typing keys stay in form fields.
        if (inField && !modKey(e) && !e.key.startsWith('F')) continue;
        if (inField && ['bold', 'italic', 'underline', 'alignLeft', 'alignRight', 'alignCenter'].includes(c.id)) continue;
        // A shortcut whose command can't run now keeps its browser meaning.
        this.format = this.editor.page ? queryFormat() : { editable: false };
        if (this.format.editable && !this.editor.scroller.contains(this.format.root)) this.format = { editable: false };
        if (c.enabled && !c.enabled(this)) return;
        e.preventDefault();
        this.runCommand(c.id);
        return;
      }
      if (e.key === 'Escape') this.ribbon.closePeek();
      // Escape in a box or list (Search, Tell Me, a pane's options) belongs
      // to that control; it doesn't also reset the pen or the view.
      if (e.key === 'Escape' && !inField) {
        if (this.state.fullPage && !e.target.closest?.('.outline-body')) this.toggleFullPage();
        if (this.painter) this.toggleFormatPainter(false);
        if (this.editor.ink.tool !== 'type' && !e.target.closest?.('.outline-body')) this.setTool('type');
      }
    });
  }

  /** F6 moves between the main regions (ribbon, panes, search, page, task pane). */
  cycleRegions(dir) {
    const regions = [
      () => this.ribbon.tabList.querySelector('[aria-selected="true"]'),
      () => (this.nav.el.hidden ? null : this.nav.sectionsList.querySelector('.row[tabindex="0"]') || this.nav.nbButton),
      () => (this.nav.el.hidden || this.nav.pagesPane.hidden ? null : this.nav.pagesList.querySelector('.row[tabindex="0"]')),
      () => (this.search.el.hidden ? null : this.search.input),
      () => (this.recent.el.hidden ? null : this.recent.el.querySelector('.result')),
      () => (this.editor.page ? this.editor.outlinesEl.querySelector('.outline-body') || this.editor.titleEl : null),
      () => (this.taskPanes.el.hidden ? null : this.taskPanes.el.querySelector('button, input, select')),
    ];
    const targets = regions.map((f) => f()).filter((el) => el && el.offsetParent !== null);
    const i = targets.findIndex((el) => el.contains(document.activeElement) || el === document.activeElement || el.closest('.sections-pane, .pages-pane, .ribbon, .side-panel, .task-pane, .canvas-scroll')?.contains(document.activeElement));
    const next = targets[(i + dir + targets.length) % targets.length];
    next?.focus();
  }

  // ------------------------------------------------------------ clipboard & painter

  clipboard(kind) {
    if (!this.editor.restoreRange()) return;
    const ok = document.execCommand(kind);
    if (!ok) toast(`Use ${shortcutLabel(kind === 'cut' ? 'Mod+X' : 'Mod+C')} to ${kind}.`);
  }

  async paste() {
    this.editor.ensureCaret();
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            this.editor.restoreRange();
            await this.editor.insertImage(new File([blob], `pasted.${imageType.split('/')[1]}`, { type: imageType }));
            return;
          }
          if (item.types.includes('text/html') || item.types.includes('text/plain')) {
            const dt = new DataTransfer();
            if (item.types.includes('text/html')) dt.setData('text/html', await (await item.getType('text/html')).text());
            if (item.types.includes('text/plain')) dt.setData('text/plain', await (await item.getType('text/plain')).text());
            this.editor.restoreRange();
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            document.activeElement.dispatchEvent(ev);
            return;
          }
        }
      }
      throw new Error('no clipboard access');
    } catch {
      toast(`Press ${shortcutLabel('Mod+V')} to paste. Your browser blocks pasting from a button.`);
    }
  }

  toggleFormatPainter(force) {
    const on = force ?? !this.painter;
    if (!on) {
      this.painter = null;
      this.editor.scroller.style.cursor = '';
      this.ribbon.refresh();
      return;
    }
    this.editor.restoreRange();
    const f = queryFormat();
    if (!f.editable) return;
    const anchor = window.getSelection().anchorNode;
    const el = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
    const cs = el ? getComputedStyle(el) : null;
    this.painter = { bold: f.bold, italic: f.italic, underline: f.underline, strike: f.strike, color: cs?.color, background: findBackground(el), fontSize: f.fontSize, fontFamily: el?.closest('[style*="font-family"]')?.style.fontFamily || '' };
    this.editor.scroller.style.cursor = 'copy';
    this.ribbon.refresh();
    announce('Format Painter on. Select text to apply the formatting.');
  }

  applyFormatPainter() {
    const p = this.painter;
    const sel = window.getSelection();
    if (!p || !sel || sel.isCollapsed) return;
    const cur = queryFormat();
    if (!cur.inBody) return;
    const toggle = (cmd, want, have) => {
      if (Boolean(want) !== Boolean(have)) document.execCommand(cmd);
    };
    document.execCommand('styleWithCSS', false, false);
    toggle('bold', p.bold, cur.bold);
    toggle('italic', p.italic, cur.italic);
    toggle('underline', p.underline, cur.underline);
    toggle('strikeThrough', p.strike, cur.strike);
    document.execCommand('styleWithCSS', false, true);
    if (p.color) document.execCommand('foreColor', false, p.color);
    if (p.background) document.execCommand('hiliteColor', false, p.background);
    setFontSize(p.fontSize);
    if (p.fontFamily) setFontName(p.fontFamily);
    this.editor.markActiveDirty();
    this.toggleFormatPainter(false);
  }

  // ------------------------------------------------------------ feature entry points

  copyLink(kind, id) {
    const url = `${location.origin}${location.pathname}${location.search}#${kind}=${id}`;
    navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => toast("Couldn't copy the link."));
  }

  tablePicker(close) {
    return features.tablePicker((rows, cols) => {
      close();
      this.insertTable(rows, cols);
    });
  }

  insertTable(rows, cols) {
    this.editor.ensureCaret();
    insertHtml(tableHtml(rows, cols));
    this.editor.markActiveDirty();
    // Put the caret in the first cell.
    const range = window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null;
    const node = range?.startContainer;
    const body = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.outline-body');
    const tables = body ? [...body.querySelectorAll('table')] : [];
    const t = tables.find((tb) => tb.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) || tables.at(-1);
    const cell = t?.querySelector('td');
    if (cell) {
      const r = document.createRange();
      r.selectNodeContents(cell);
      r.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(r);
    }
    this.updateFormatState();
  }

  insertTableDialog() {
    return features.insertTableDialog(this);
  }

  pickFiles(opts) {
    return features.pickFiles(this, opts);
  }

  /** Puter's own file picker, when the SDK provides one. */
  cloudPicker() {
    return typeof puter !== 'undefined' && typeof puter.ui?.showOpenFilePicker === 'function' ? puter.ui.showOpenFilePicker.bind(puter.ui) : null;
  }

  pickFromCloud(opts) {
    return features.pickFromCloud(this, opts);
  }

  insertPrintout(file) {
    return features.insertPrintout(this, file);
  }

  insertScreenshot() {
    return features.insertScreenshot(this);
  }

  linkDialog() {
    return features.linkDialog(this);
  }

  equationDialog(span) {
    return features.equationDialog(this, span);
  }

  record(kind) {
    return features.record(this, kind);
  }

  templatesDialog() {
    return features.templatesDialog(this);
  }

  moveDialog(kind, id) {
    return features.moveDialog(this, kind, id);
  }

  openReader() {
    return features.openReader(this);
  }

  openDeletedNotes() {
    return features.deletedNotesDialog(this);
  }

  toggleTaskPane(kind) {
    this.taskPanes.toggle(kind);
    this.ribbon.refresh();
  }

  emailPage() {
    return features.emailPage(this);
  }

  exportPage(format) {
    return features.exportPage(this, format);
  }

  exportSection() {
    return features.exportSection(this, this.state.sectionId);
  }

  exportNotebook() {
    return features.exportNotebook(this, this.state.notebookId);
  }

  importFiles() {
    return features.importFiles(this);
  }

  shareDialog() {
    return features.shareDialog(this);
  }

  shortcutsDialog() {
    return features.shortcutsDialog(this);
  }

  aboutDialog() {
    return features.aboutDialog(this);
  }

  helpDialog() {
    return features.helpDialog(this);
  }
}

function findBackground(el) {
  for (let n = el; n && !n.classList?.contains('outline-body'); n = n.parentElement) {
    const bg = n.style?.backgroundColor;
    if (bg) return bg;
  }
  return null;
}
