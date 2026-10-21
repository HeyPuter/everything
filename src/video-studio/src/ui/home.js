/**
 * Home screen: a sidebar (Home, Templates, Trash, account and storage) and
 * three views. Home starts projects (blank by aspect ratio, from media, from
 * a template, from a project file or from a script with AI) and lists recent
 * projects with search, sort, grid or list view, rename, duplicate, export
 * and delete. Deleting
 * moves a project to the Trash, where it can be restored or deleted for good
 * (and is purged automatically after TRASH_DAYS).
 */
import { createElement, LayoutTemplate, ArchiveRestore, PackageOpen } from 'lucide';
import { h, announce } from '../lib/dom.js';
import { icon, appIcon } from '../lib/icons.js';
import { clock } from '../lib/time.js';
import { RATIOS } from '../model/project.js';
import { TEMPLATES } from '../model/templates.js';
import { TRASH_DAYS } from '../storage/library.js';
import { exportProjectBundle, importProjectBundle, downloadBlob, BUNDLE_ACCEPT } from '../storage/bundle.js';
import { createProjectFromTemplate } from '../storage/template-project.js';
import { showMenu, menuButton } from './menu.js';
import { confirmDialog, promptDialog, toast, installTooltips, openDialog } from './dialog.js';
import { accountButton } from './topbar.js';
import { prefs, setPref } from './prefs.js';
import { templateCard, templatesView, openTemplateDialog } from './home-templates.js';
import { TemplatePreview } from './template-preview.js';

const DAY = 24 * 60 * 60 * 1000;
/** "a, b, c and 2 more" for toasts. */
const fewNames = (list) => `${list.slice(0, 3).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`;
const QUICK_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '21:9'];
const VIEWS = [
  { id: 'home', label: 'Home', icon: () => icon('home', 18) },
  { id: 'templates', label: 'Templates', icon: () => lucide(LayoutTemplate, 18) },
  { id: 'trash', label: 'Trash', icon: () => icon('trash', 18) },
];

function lucide(node, size = 16) {
  const el = createElement(node);
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  el.classList.add('icon');
  return el;
}

function relTime(ts, now = Date.now()) {
  const d = now - ts;
  const m = Math.round(d / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Days left before a trashed project is deleted for good. */
export function daysLeft(deletedAt, now = Date.now()) {
  return Math.max(0, Math.ceil((deletedAt + TRASH_DAYS * DAY - now) / DAY));
}

function ratioGlyph(id, max = 18) {
  const r = RATIOS.find((x) => x.id === id);
  const w = r ? r.w : 16;
  const hh = r ? r.h : 9;
  const k = max / Math.max(w, hh);
  return h('span.ratio-glyph', { style: { width: `${Math.round(w * k)}px`, height: `${Math.round(hh * k)}px` } });
}

function viewFromHash() {
  const m = /^#(templates|trash)$/.exec(location.hash);
  return m ? m[1] : 'home';
}

export class Home {
  constructor(root, { library, account, onOpen, onCreate, onImportFiles }) {
    this.root = root;
    this.library = library;
    this.account = account;
    this.onOpen = onOpen;
    this.onCreate = onCreate;
    this.onImportFiles = onImportFiles;
    this.query = '';
    this.projects = [];
    this.trash = [];
    this.loaded = false;
    this.coverUrls = new Map();
    this.view = viewFromHash();
    this.onHash = () => {
      const v = viewFromHash();
      if (v !== this.view) this.show(v, { push: false });
    };
    window.addEventListener('hashchange', this.onHash);
    this.render();
    this.load();
  }

  async load() {
    this.loaded = false;
    this.renderView();
    try {
      // Projects past their time in the Trash go for good when the home screen opens.
      const purged = await this.library.purgeTrash().catch(() => []);
      if (purged.length) announce(`${purged.length} project${purged.length === 1 ? '' : 's'} removed from the Trash after ${TRASH_DAYS} days`);
      this.projects = await this.library.listProjects();
      this.trash = await this.library.listTrash();
    } catch (err) {
      console.error(err);
      this.loadError = true;
      this.loaded = true;
      this.renderView();
      return;
    }
    this.loadError = false;
    this.loaded = true;
    this.renderView();
    this.refreshUsage();
  }

  async refreshLists() {
    this.projects = await this.library.listProjects();
    this.trash = await this.library.listTrash();
    this.renderView();
    this.refreshUsage();
  }

  /* Shell ---------------------------------------------------------------------- */

  render() {
    this.importInput = h('input', { type: 'file', multiple: true, accept: 'video/*,audio/*,image/*', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    this.importInput.addEventListener('change', () => {
      const files = [...this.importInput.files];
      this.importInput.value = '';
      if (files.length) this.onImportFiles(files);
    });
    this.bundleInput = h('input', { type: 'file', accept: BUNDLE_ACCEPT, multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    this.bundleInput.addEventListener('change', () => {
      const files = [...this.bundleInput.files];
      this.bundleInput.value = '';
      this.importBundles(files);
    });

    this.nav = h('nav.home-nav', { 'aria-label': 'Home sections' });
    this.usageEl = h('p.storage-usage');
    const backend = this.library.backend.kind;
    const where = backend === 'puter'
      ? [icon('cloudCheck', 16), 'Saved to your Puter cloud']
      : backend === 'local'
        ? [icon('drive', 16), 'Saved in this browser only']
        : [icon('alert', 16), 'Not saved: temporary storage'];
    const user = this.account?.user;
    const signIn = !user && this.account?.onSignIn
      ? h('button.btn.small.primary.block', { type: 'button', onclick: () => this.account.onSignIn() }, icon('cloud', 14), 'Sign in to save to Puter')
      : null;
    const accountRow = h('div.side-account', accountButton(this.account || {}), h('span.side-user', user?.username || 'Guest'));
    const storage = h('div.side-storage', h('p.storage-where', ...where), this.usageEl, signIn);
    this.side = h('aside.home-side',
      h('div.side-brand', appIcon(26), h('span.brand-name', 'Video Studio')),
      this.nav,
      h('div.side-spacer'),
      storage,
      accountRow,
    );
    // On phones the storage note moves under the content.
    this.mobileStorage = h('div.home-mobile-storage', h('p.storage-where', ...where.map((n) => (typeof n === 'string' ? n : n.cloneNode(true)))), h('p.storage-usage'));
    this.content = h('div.home-content');
    this.mainEl = h('main#main.home-main', { tabindex: '-1' }, this.content, this.mobileStorage,
      h('footer.home-footer', h('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Powered by Puter')),
      this.importInput, this.bundleInput);
    this.dropHint = h('div.home-drop', { 'aria-hidden': 'true' }, h('div.home-drop-box', icon('import', 28), h('strong', 'Drop to start'), h('span', 'Media opens in a new project. Project files are added to your projects.')));
    const page = h('div.home', this.side, this.mainEl, this.dropHint);
    this.installDrop(page);
    this.root.replaceChildren(page);
    this.root.removeAttribute('aria-busy');
    installTooltips(page);
    this.renderNav();
  }

  renderNav() {
    this.nav.replaceChildren(...VIEWS.map((v) => {
      const count = v.id === 'trash' && this.trash.length ? h('span.nav-count', { 'aria-label': `${this.trash.length} in the Trash` }, String(this.trash.length)) : null;
      const a = h('a.nav-item', { href: v.id === 'home' ? '#' : `#${v.id}`, 'aria-current': v.id === this.view ? 'page' : null }, v.icon(), h('span.nav-label', v.label), count);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this.show(v.id);
      });
      return a;
    }));
  }

  show(view, { push = true } = {}) {
    this.view = view;
    if (push) history.replaceState(null, '', view === 'home' ? `${location.pathname}${location.search}` : `#${view}`);
    this.query = '';
    this.renderNav();
    this.renderView();
    this.mainEl.scrollTop = 0;
    this.mainEl.focus({ preventScroll: true });
  }

  renderView() {
    this.renderNav();
    const titles = { home: 'Video Studio', templates: 'Templates', trash: 'Trash' };
    document.title = this.view === 'home' ? 'Video Studio' : `${titles[this.view]} - Video Studio`;
    this.grid = null;
    if (this.view === 'templates') {
      this.content.replaceChildren(templatesView({ onChoose: (t) => this.chooseTemplate(t) }));
      return;
    }
    if (this.view === 'trash') {
      this.content.replaceChildren(this.trashView());
      return;
    }
    this.content.replaceChildren(this.homeView());
  }

  /* Home view ------------------------------------------------------------------- */

  homeView() {
    const banner = h('button.new-banner', { type: 'button' },
      h('span.new-banner-icon', icon('plus', 26)),
      h('span.new-banner-text', h('strong', 'New project'), h('span', 'Start with an empty timeline. Its shape follows the first clip you add.')));
    banner.addEventListener('click', () => this.onCreate({ ratio: 'original' }));

    const importCard = h('button.quick-card.wide', { type: 'button' },
      h('span.quick-icon', icon('import', 20)),
      h('span.quick-text', h('strong', 'Import and edit'), h('span', 'Open media in a new project')));
    importCard.addEventListener('click', () => this.importInput.click());
    const fileCard = h('button.quick-card.wide', { type: 'button' },
      h('span.quick-icon', lucide(PackageOpen, 20)),
      h('span.quick-text', h('strong', 'Open project file'), h('span', 'Restore a project exported from Video Studio')));
    fileCard.addEventListener('click', () => this.bundleInput.click());
    const tplCard = h('button.quick-card.wide', { type: 'button' },
      h('span.quick-icon', lucide(LayoutTemplate, 20)),
      h('span.quick-text', h('strong', 'Browse templates'), h('span', `${TEMPLATES.length} ready-made projects to make your own`)));
    tplCard.addEventListener('click', () => this.show('templates'));
    const scriptCard = h('button.quick-card.wide', { type: 'button' },
      h('span.quick-icon', icon('script', 20)),
      h('span.quick-text', h('strong', 'Script to video'), h('span', 'Turn a script or a topic into a narrated video with AI')));
    scriptCard.addEventListener('click', () => this.scriptToVideo());
    const ratios = QUICK_RATIOS.map((id) => {
      const r = RATIOS.find((x) => x.id === id);
      const b = h('button.quick-card.ratio', { type: 'button', 'aria-label': `New ${r.label} project, ${r.hint}` },
        h('span.quick-glyph', ratioGlyph(r.id, 22)),
        h('span.quick-text', h('strong', r.label), h('span', r.hint)));
      b.addEventListener('click', () => this.onCreate({ ratio: r.id }));
      return b;
    });

    const strip = h('div.tpl-strip', { role: 'list', 'aria-label': 'Featured templates' },
      TEMPLATES.slice(0, 6).map((t) => h('div.tpl-item', { role: 'listitem' }, templateCard(t, { onChoose: (x) => this.chooseTemplate(x) }))));
    const allTemplates = h('a.section-link', { href: '#templates' }, 'See all', icon('chevronRight', 14));
    allTemplates.addEventListener('click', (e) => {
      e.preventDefault();
      this.show('templates');
    });

    const search = h('input.input.home-search', { type: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects', value: this.query });
    search.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.renderGrid();
    });
    const sortBtn = h('button.btn.small.ghost', { type: 'button' }, icon('list', 14), h('span.sort-label', 'Sort'));
    menuButton(sortBtn, () => {
      const s = prefs().homeSort;
      return [
        { label: 'Last modified', checked: s === 'modified', radio: true, onSelect: () => this.setSort('modified') },
        { label: 'Date created', checked: s === 'created', radio: true, onSelect: () => this.setSort('created') },
        { label: 'Name', checked: s === 'name', radio: true, onSelect: () => this.setSort('name') },
      ];
    }, { align: 'end', label: 'Sort projects' });
    const viewBtn = h('button.icon-btn', { type: 'button' });
    const syncView = () => {
      const grid = prefs().homeView !== 'list';
      viewBtn.replaceChildren(icon(grid ? 'list' : 'grid', 16));
      viewBtn.setAttribute('aria-label', grid ? 'Show as list' : 'Show as grid');
      viewBtn.setAttribute('data-tip', grid ? 'List view' : 'Grid view');
    };
    viewBtn.addEventListener('click', () => {
      setPref('homeView', prefs().homeView === 'list' ? 'grid' : 'list');
      syncView();
      this.renderGrid();
    });
    syncView();
    const moreBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'More project actions', 'data-tip': 'More' }, icon('more', 16));
    menuButton(moreBtn, () => [
      { label: 'Open project file...', icon: 'folderOpen', onSelect: () => this.bundleInput.click() },
      { label: 'Import media...', icon: 'import', onSelect: () => this.importInput.click() },
      'separator',
      { label: `Trash${this.trash.length ? ` (${this.trash.length})` : ''}`, icon: 'trash', onSelect: () => this.show('trash') },
    ], { align: 'end', label: 'More project actions' });

    this.grid = h('div.project-grid', { role: 'list', 'aria-label': 'Projects' });
    this.count = h('span.home-count');
    const section = h('div.home-view',
      h('h1.sr-only', 'Video Studio'),
      h('section.home-start', { 'aria-label': 'Start a project' },
        banner,
        h('div.quick-row', { role: 'group', 'aria-label': 'Quick start' }, importCard, fileCard, tplCard, scriptCard),
        h('div.ratio-group', { role: 'group', 'aria-labelledby': 'ratio-h' }, h('h2#ratio-h.group-label', 'Blank project by shape'), h('div.ratio-grid', ratios))),
      h('section.home-section', { 'aria-labelledby': 'tpl-strip-h' },
        h('div.section-head', h('h2#tpl-strip-h', 'Start from a template'), allTemplates),
        strip),
      h('section.home-section', { 'aria-labelledby': 'projects-h' },
        h('div.section-head', h('h2#projects-h', 'Recent projects ', this.count), h('div.section-tools', h('div.search-wrap', icon('search', 14), search), sortBtn, viewBtn, moreBtn)),
        this.grid));
    this.renderGrid();
    return section;
  }

  setSort(s) {
    setPref('homeSort', s);
    this.renderGrid();
  }

  sorted() {
    const s = prefs().homeSort;
    const list = this.projects.filter((p) => !this.query || p.name.toLowerCase().includes(this.query));
    if (s === 'name') return list.sort((a, b) => a.name.localeCompare(b.name));
    if (s === 'created') return list.sort((a, b) => (b.created || 0) - (a.created || 0));
    return list.sort((a, b) => b.modified - a.modified);
  }

  renderGrid() {
    if (!this.grid) return;
    if (!this.loaded) {
      this.grid.replaceChildren(h('div.home-loading', { role: 'status' }, h('div.spinner'), 'Loading projects...'));
      return;
    }
    if (this.loadError) {
      this.grid.replaceChildren(h('div.home-empty', icon('cloudOff', 28), h('p', "Couldn't load your projects."), h('button.btn', { type: 'button', onclick: () => this.load() }, 'Try again')));
      return;
    }
    const list = this.sorted();
    const asList = prefs().homeView === 'list';
    this.grid.classList.toggle('as-list', asList);
    this.count.textContent = this.projects.length ? `(${this.projects.length})` : '';
    if (!list.length) {
      this.grid.replaceChildren(h('div.home-empty', { role: 'listitem' }, icon('clapper', 28), h('p', this.query ? 'No projects match your search.' : 'No projects yet. Start one above, or pick a template.')));
      return;
    }
    this.grid.replaceChildren(...list.map((p) => this.card(p)));
  }

  cover(p) {
    const cover = h('div.project-cover', h('span.cover-fallback', icon('film', 22)));
    this.loadCover(p.id, cover);
    return cover;
  }

  card(p) {
    const cover = this.cover(p);
    const open = h('button.project-open', { type: 'button', 'aria-label': `Open ${p.name}, ${clock(p.duration || 0)}, edited ${relTime(p.modified)}` }, cover,
      h('span.project-meta', h('span.project-title', p.name), h('span.project-sub', `${clock(p.duration || 0)}  ·  ${relTime(p.modified)}`)));
    open.addEventListener('click', () => this.onOpen(p.id));
    const more = h('button.icon-btn.project-more', { type: 'button', 'aria-label': `More actions for ${p.name}` }, icon('more', 16));
    const items = () => [
      { label: 'Open', icon: 'folderOpen', onSelect: () => this.onOpen(p.id) },
      { label: 'Rename', icon: 'pencil', onSelect: () => this.rename(p) },
      { label: 'Duplicate', icon: 'copy', onSelect: () => this.duplicate(p) },
      { label: 'Export project file', icon: 'download', onSelect: () => this.exportBundle(p) },
      'separator',
      { label: 'Move to Trash', icon: 'trash', danger: true, onSelect: () => this.remove(p) },
    ];
    menuButton(more, items, { align: 'end', label: p.name });
    const li = h('div.project-card', { role: 'listitem' }, open, more);
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu({ x: e.clientX, y: e.clientY }, items(), { label: p.name });
    });
    return li;
  }

  async loadCover(id, el) {
    let url = this.coverUrls.get(id);
    if (!url) {
      const blob = await this.library.coverBlob(id);
      if (!blob) return;
      url = URL.createObjectURL(blob);
      this.coverUrls.set(id, url);
    }
    el.replaceChildren(h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' }));
  }

  async rename(p) {
    const name = await promptDialog({ title: 'Rename project', label: 'Project name', value: p.name, confirm: 'Rename' });
    if (!name || name === p.name) return;
    try {
      await this.library.renameProject(p.id, name);
      await this.refreshLists();
      announce(`Renamed to ${name}`);
    } catch {
      toast("Couldn't rename the project.", { kind: 'error' });
    }
  }

  async duplicate(p) {
    try {
      await this.library.duplicateProject(p.id);
      await this.refreshLists();
      toast(`Duplicated ${p.name}`, { kind: 'success' });
    } catch {
      toast("Couldn't duplicate the project.", { kind: 'error' });
    }
  }

  async remove(p) {
    try {
      await this.library.trashProject(p.id);
      await this.refreshLists();
      toast(`${p.name} moved to the Trash`, {
        kind: 'success',
        duration: 6000,
        action: { label: 'Undo', onClick: () => this.restore(p, { quiet: true }) },
      });
    } catch {
      toast("Couldn't move the project to the Trash.", { kind: 'error' });
    }
  }

  /* Templates ------------------------------------------------------------------- */

  chooseTemplate(tpl) {
    openTemplateDialog(tpl, {
      onUse: async (t, { onProgress }) => {
        const project = await createProjectFromTemplate(this.library, t, { onProgress });
        await this.saveTemplateCover(t, project.id).catch(() => {});
        const slots = Object.values(project.assets).some((a) => a.kind === 'image' && /placeholder/i.test(a.name));
        if (slots) toast('Tip: select a placeholder clip and use Replace clip to put in your own media.', { duration: 9000 });
        this.onOpen(project.id);
      },
    });
  }

  /** Script to video: the new project opens when it is ready. */
  async scriptToVideo() {
    const m = await import('./script-video.js');
    const env = { library: this.library, account: this.account };
    if (!m.aiReady(env)) {
      m.needAiDialog(this.account, 'Script to video');
      return;
    }
    m.openScriptDialog(env, { onProject: (id) => this.onOpen(id) });
  }

  /** A first cover from the template preview (the editor replaces it after editing). */
  async saveTemplateCover(tpl, id) {
    const pv = new TemplatePreview(tpl, { width: 480 });
    await pv.ready();
    const blob = await new Promise((r) => (pv.canvas.toBlob ? pv.canvas.toBlob(r, 'image/jpeg', 0.85) : r(null)));
    if (blob) await this.library.saveCover(id, blob);
  }

  /* Trash view ------------------------------------------------------------------ */

  trashView() {
    const empty = h('button.btn.small', { type: 'button', disabled: !this.trash.length }, icon('trash', 14), 'Empty Trash');
    empty.addEventListener('click', () => this.emptyTrash());
    const list = h('div.project-grid.trash-grid', { role: 'list', 'aria-label': 'Projects in the Trash' });
    if (!this.loaded) list.append(h('div.home-loading', { role: 'status' }, h('div.spinner'), 'Loading...'));
    else if (!this.trash.length) list.append(h('div.home-empty', { role: 'listitem' }, icon('trash', 28), h('p', 'The Trash is empty.')));
    else list.append(...this.trash.map((p) => this.trashCard(p)));
    return h('section.home-section', { 'aria-labelledby': 'trash-h' },
      h('div.section-head',
        h('div', h('h1#trash-h.view-title', 'Trash'), h('p.view-sub', `Projects in the Trash are deleted for good after ${TRASH_DAYS} days. Media files stay in your storage.`)),
        h('div.section-tools', empty)),
      list);
  }

  trashCard(p) {
    const left = daysLeft(p.deletedAt);
    const restore = h('button.btn.small', { type: 'button', 'aria-label': `Restore ${p.name}` }, lucide(ArchiveRestore, 14), 'Restore');
    restore.addEventListener('click', () => this.restore(p));
    const del = h('button.btn.small.ghost.danger-text', { type: 'button', 'aria-label': `Delete ${p.name} forever` }, 'Delete forever');
    del.addEventListener('click', () => this.deleteForever(p));
    const items = () => [
      { label: 'Restore', icon: 'undo', onSelect: () => this.restore(p) },
      { label: 'Export project file', icon: 'download', onSelect: () => this.exportBundle(p) },
      'separator',
      { label: 'Delete forever', icon: 'trash', danger: true, onSelect: () => this.deleteForever(p) },
    ];
    const li = h('div.project-card.trashed', { role: 'listitem' },
      h('div.project-open.static', this.cover(p),
        h('span.project-meta', h('span.project-title', p.name), h('span.project-sub', `Deleted ${relTime(p.deletedAt)}  ·  ${left} day${left === 1 ? '' : 's'} left`))),
      h('div.trash-actions', restore, del));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu({ x: e.clientX, y: e.clientY }, items(), { label: p.name });
    });
    return li;
  }

  async restore(p, { quiet = false } = {}) {
    try {
      await this.library.restoreProject(p.id);
      await this.refreshLists();
      if (quiet) announce(`${p.name} restored`);
      else toast(`${p.name} restored`, { kind: 'success', action: { label: 'Open', onClick: () => this.onOpen(p.id) } });
    } catch {
      toast("Couldn't restore the project.", { kind: 'error' });
    }
  }

  async deleteForever(p) {
    const ok = await confirmDialog({ title: 'Delete forever?', message: `${p.name} will be deleted permanently. This can't be undone.`, confirm: 'Delete forever', danger: true });
    if (!ok) return;
    try {
      await this.library.deleteProject(p.id);
      await this.refreshLists();
      announce(`${p.name} deleted`);
    } catch {
      toast("Couldn't delete the project.", { kind: 'error' });
    }
  }

  async emptyTrash() {
    const n = this.trash.length;
    if (!n) return;
    const ok = await confirmDialog({ title: 'Empty the Trash?', message: `${n} project${n === 1 ? '' : 's'} will be deleted permanently. This can't be undone.`, confirm: 'Empty Trash', danger: true });
    if (!ok) return;
    try {
      await this.library.emptyTrash();
    } catch {
      toast("Couldn't empty the Trash.", { kind: 'error' });
    }
    await this.refreshLists().catch(() => {});
    announce('Trash emptied');
  }

  /* Project files ------------------------------------------------------------------ */

  progress(title, text) {
    const bar = h('progress.home-progress', { max: 1, value: 0 });
    const label = h('p.dialog-text', text);
    const d = openDialog({ title, body: h('div', label, bar), className: 'small', closeOnBackdrop: false });
    return {
      set(done, total, msg) {
        bar.max = Math.max(1, total);
        bar.value = done;
        if (msg) label.textContent = msg;
      },
      close: () => d.close(),
    };
  }

  async exportBundle(p) {
    const pr = this.progress('Export project file', `Packing ${p.name}...`);
    let res;
    try {
      res = await exportProjectBundle(this.library, p.id, {
        onProgress: ({ done, total, name }) => pr.set(done, total, name ? `Packing ${name}...` : 'Finishing...'),
      });
    } catch (err) {
      console.error(err);
      pr.close();
      toast(err?.message || "Couldn't export the project.", { kind: 'error' });
      return;
    }
    pr.close();
    if (res.missing.length) toast(`${res.missing.length} file${res.missing.length === 1 ? ' was' : 's were'} missing and left out: ${fewNames(res.missing)}`, { kind: 'error' });
    this.deliver(res);
  }

  /** Download the file, or offer to save it to Puter when signed in. */
  deliver({ blob, fileName }) {
    const canSave = this.library.backend.kind === 'puter' && typeof puter !== 'undefined';
    if (!canSave) {
      downloadBlob(blob, fileName);
      toast(`Downloaded ${fileName}`, { kind: 'success' });
      return;
    }
    const status = h('p.dialog-text', { role: 'status' }, `${fileName} (${formatSize(blob.size)})`);
    const dl = h('button.btn', { type: 'button' }, icon('download', 16), 'Download');
    const save = h('button.btn.primary', { type: 'button' }, icon('cloud', 16), 'Save to Puter');
    const d = openDialog({ title: 'Project file ready', body: status, actions: [dl, save], className: 'small' });
    dl.addEventListener('click', () => {
      downloadBlob(blob, fileName);
      d.close();
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        let item;
        if (puter.ui?.showSaveFilePicker) item = await puter.ui.showSaveFilePicker(blob, fileName);
        else {
          const user = this.account?.user || (await puter.auth.getUser());
          item = await puter.fs.write(`/${user.username}/Documents/${fileName}`, blob, { dedupeName: true, createMissingParents: true, overwrite: false });
        }
        toast(`Saved to ${item?.path || item?.name || 'Puter'}`, { kind: 'success' });
        d.close();
      } catch (err) {
        toast(`Could not save to Puter: ${err?.message || err}`, { kind: 'error' });
        save.disabled = false;
      }
    });
  }

  async importBundles(files) {
    let last = null;
    for (const file of files) {
      const pr = this.progress('Open project file', `Reading ${file.name}...`);
      try {
        const { project, missing } = await importProjectBundle(this.library, file, {
          onProgress: ({ done, total, name }) => pr.set(done, total, name ? `Adding ${name}...` : 'Saving...'),
        });
        last = project;
        pr.close();
        if (missing.length) toast(`${project.name}: ${missing.length} file${missing.length === 1 ? ' is' : 's are'} not in the project file: ${fewNames(missing)}`, { kind: 'error' });
      } catch (err) {
        pr.close();
        toast(`${file.name}: ${err?.message || "Couldn't open this project file."}`, { kind: 'error' });
      }
    }
    if (!last) return;
    if (this.view !== 'home') this.show('home');
    await this.refreshLists();
    const p = last;
    toast(`Added ${p.name}`, { kind: 'success', action: { label: 'Open', onClick: () => this.onOpen(p.id) } });
  }

  /* Drag and drop ------------------------------------------------------------------ */

  installDrop(page) {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    page.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      page.classList.add('dropping');
    });
    page.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    page.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) page.classList.remove('dropping');
    });
    page.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      page.classList.remove('dropping');
      const files = [...e.dataTransfer.files];
      const bundles = files.filter((f) => /\.zip$/i.test(f.name));
      const media = files.filter((f) => !bundles.includes(f));
      if (bundles.length) this.importBundles(bundles);
      else if (media.length) this.onImportFiles(media);
    });
  }

  /* Storage readout ---------------------------------------------------------------- */

  async refreshUsage() {
    let text = '';
    try {
      const u = await this.library.storageUsage();
      const parts = [`${u.projects} project${u.projects === 1 ? '' : 's'}`];
      let bytes = u.mediaBytes;
      if (bytes === null && this.library.backend.kind === 'local' && navigator.storage?.estimate) {
        bytes = (await navigator.storage.estimate().catch(() => null))?.usage ?? null;
      }
      if (u.mediaBytes !== null) parts.push(`${formatSize(bytes)} of media`);
      else if (bytes !== null) parts.push(`${formatSize(bytes)} used`);
      if (u.trashed) parts.push(`${u.trashed} in Trash`);
      text = parts.join('  ·  ');
    } catch {
      text = '';
    }
    for (const el of [this.usageEl, this.mobileStorage.querySelector('.storage-usage')]) el.textContent = text;
  }

  dispose() {
    window.removeEventListener('hashchange', this.onHash);
    for (const u of this.coverUrls.values()) URL.revokeObjectURL(u);
  }
}
