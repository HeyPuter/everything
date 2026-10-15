// Asset Browser: the File Browser in asset mode. Left: libraries (All, Current File, Essentials,
// user libraries) and the selected library's catalog tree (drop assets on a catalog to file them
// there, drag catalogs to nest them). Middle: the assets as thumbnails or a list, filtered by
// catalog, type and text. Right (N): the active asset's metadata, preview and tags. Assets are
// dragged out into 3D views and node editors, or used with a double-click.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, openPopover, type MenuItem } from '../ui/menu';
import { enumMenu, textField, panel, checkbox } from '../ui/widgets';
import { catalogTree, type CatalogNode } from './catalogs';
import {
  LOCAL,
  ESSENTIALS,
  libraries,
  libraryInfo,
  libraryDoc,
  libraryCatalogs,
  libraryError,
  listAssets,
  onLibrariesChanged,
  loadLibraryIndex,
  setLibraryImportMethod,
  libraryChanged,
  assetRef,
  findAsset,
  libraryRevision,
  libraryIndexReady,
  type AssetEntry,
} from './library';
import { activateAsset } from './ops';
import { renderPreview } from './preview';
import { startAssetDrag, type InternalTarget } from './drop';
import { UNASSIGNED, type AssetBrowserLike, type ImportSetting } from './state';
import { ASSET_TABLES, ASSET_TYPE_INFO, type AssetCatalog, type AssetTable } from './types';
import './browser.css';

export const ALL = 'ALL';

type View = 'THUMBNAIL' | 'LIST_VERTICAL';
export const DISPLAY_SIZES: [string, string, number][] = [
  ['TINY', 'Tiny', 64],
  ['SMALL', 'Small', 96],
  ['NORMAL', 'Medium', 128],
  ['BIG', 'Big', 160],
  ['LARGE', 'Large', 208],
];

const IMPORT_LABELS: Record<ImportSetting, string> = { FOLLOW_PREFS: 'Follow Library', APPEND: 'Append', APPEND_REUSE: 'Append (Reuse Data)' };
const IMPORT_TIPS: Record<ImportSetting, string> = {
  FOLLOW_PREFS: 'Use the import method set for each asset’s library (Library ▸ Default Import Method)',
  APPEND: 'Copy the asset and everything it uses into this file, every time',
  APPEND_REUSE: 'Copy the asset, but reuse data this file already got from the same library (materials, meshes, node groups…)',
};

const browsers = new Set<AssetBrowser>();
onLibrariesChanged(() => browsers.forEach((b) => (b.draw(), b.area.drawHeader())));

/** Essentials (read-only, in memory) get previews rendered on demand, one per frame. */
const previewQueue: AssetEntry[] = [];
let previewScheduled = false;
function queuePreview(e: AssetEntry) {
  if (previewQueue.some((q) => q.library === e.library && q.id === e.id)) return;
  previewQueue.push(e);
  if (previewScheduled) return;
  previewScheduled = true;
  const step = () => {
    const next = previewQueue.shift();
    if (!next) {
      previewScheduled = false;
      return;
    }
    const doc = libraryDoc(next.library);
    const meta = next.block.asset_data;
    if (doc && meta && !meta.preview) {
      const url = renderPreview(doc, next.table, next.id);
      // remember that there is nothing to show so it is not tried again
      meta.preview = url ?? '';
      browsers.forEach((b) => b.draw());
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Path of an asset's catalog in its library ('' when it has none). */
function catalogPathOf(e: AssetEntry): string {
  const id = e.block.asset_data?.catalog_id;
  if (!id) return '';
  return libraryCatalogs(e.library).find((c) => c.id === id)?.path ?? '';
}

export class AssetBrowser implements Editor, AssetBrowserLike {
  el: HTMLElement;
  keymaps = ['Asset Browser', 'File Browser', 'Window', 'Screen'];
  private side: HTMLElement;
  private main: HTMLElement;
  private details: HTMLElement;
  private boxEl: HTMLElement;
  library = LOCAL;
  catalogPath: string | null = null;
  importMethod: ImportSetting = 'FOLLOW_PREFS';
  instanceCollections = false;
  view: View = 'THUMBNAIL';
  size = 'SMALL';
  filter = '';
  types = new Set<AssetTable>(ASSET_TABLES);
  showSidebar = true;
  showDetails = true;
  collapsed = new Set<string>();
  selected = new Set<string>();
  active: string | null = null;
  boxPending = false;
  private focusFilter = false;
  private renaming: string | null = null;
  private renamingCatalog: string | null = null;
  private lastRevision = -1;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    const st = (state ?? {}) as Partial<{ library: string; catalog: string | null; view: View; size: string; types: AssetTable[]; sidebar: boolean; details: boolean; method: ImportSetting; instance: boolean; collapsed: string[]; filter: string }>;
    if (st.library) this.library = st.library;
    if (st.catalog !== undefined) this.catalogPath = st.catalog;
    if (st.view === 'LIST_VERTICAL' || st.view === 'THUMBNAIL') this.view = st.view;
    if (st.size && DISPLAY_SIZES.some(([k]) => k === st.size)) this.size = st.size;
    if (st.types) this.types = new Set(st.types.filter((t) => (ASSET_TABLES as readonly string[]).includes(t)));
    if (st.sidebar !== undefined) this.showSidebar = st.sidebar;
    if (st.details !== undefined) this.showDetails = st.details;
    if (st.method) this.importMethod = st.method;
    if (st.instance !== undefined) this.instanceCollections = st.instance;
    if (st.collapsed) this.collapsed = new Set(st.collapsed);
    if (st.filter) this.filter = st.filter;
    this.el = document.createElement('div');
    this.el.className = 'asset-browser';
    this.side = document.createElement('div');
    this.side.className = 'ab-side';
    this.main = document.createElement('div');
    this.main.className = 'ab-main';
    this.main.tabIndex = -1;
    this.details = document.createElement('div');
    this.details.className = 'ab-details';
    this.boxEl = document.createElement('div');
    this.boxEl.className = 'fb-box ab-box';
    this.el.append(this.side, this.main, this.details);
    this.main.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        if (this.boxPending) {
          this.boxPending = false;
          e.preventDefault();
          e.stopPropagation();
          return this.boxSelect(e, true);
        }
        if (!(e.target as HTMLElement).closest('.ab-item, button, input')) this.boxSelect(e);
      },
      true,
    );
    this.main.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const it = (e.target as HTMLElement).closest<HTMLElement>('.ab-item');
      if (it?.dataset.ref && !this.selected.has(it.dataset.ref)) this.selectOnly(it.dataset.ref);
      openMenu(this.contextMenu(), { x: e.clientX, y: e.clientY }, { title: 'Assets' });
    });
    browsers.add(this);
    void loadLibraryIndex();
    this.draw();
  }

  serialize() {
    return { library: this.library, catalog: this.catalogPath, view: this.view, size: this.size, types: [...this.types], sidebar: this.showSidebar, details: this.showDetails, method: this.importMethod, instance: this.instanceCollections, collapsed: [...this.collapsed], filter: this.filter };
  }

  dispose() {
    browsers.delete(this);
  }

  update(kinds: Set<ChangeKind>) {
    if (kinds.has('doc') || kinds.has('ui') || this.lastRevision !== libraryRevision) this.draw();
  }

  // ---------------------------------------------------------------------
  // data

  private libraryIds(): string[] {
    return this.library === ALL ? libraries().map((l) => l.id) : [this.library];
  }

  /** Catalogs of the shown library (all libraries: merged by path). */
  catalogs(): AssetCatalog[] {
    if (this.library !== ALL) return libraryCatalogs(this.library);
    const byPath = new Map<string, AssetCatalog>();
    for (const id of this.libraryIds()) for (const c of libraryCatalogs(id)) if (!byPath.has(c.path)) byPath.set(c.path, { id: c.path, path: c.path });
    return [...byPath.values()];
  }

  allAssets(): AssetEntry[] {
    return this.libraryIds().flatMap((id) => listAssets(id));
  }

  /** The assets as shown: filtered by catalog, type and text, sorted by name. */
  shown(): AssetEntry[] {
    const text = this.filter.trim().toLowerCase();
    const cat = this.catalogPath;
    return this.allAssets()
      .filter((e) => this.types.has(e.table))
      .filter((e) => {
        if (cat === null) return true;
        const p = catalogPathOf(e);
        if (cat === UNASSIGNED) return !p;
        return p === cat || p.startsWith(`${cat}/`);
      })
      .filter((e) => {
        if (!text) return true;
        const m = e.block.asset_data!;
        return e.block.name.toLowerCase().includes(text) || m.tags.some((t) => t.toLowerCase().includes(text)) || m.description.toLowerCase().includes(text);
      })
      .sort((a, b) => a.block.name.localeCompare(b.block.name, undefined, { numeric: true, sensitivity: 'base' }) || a.table.localeCompare(b.table));
  }

  selection(): AssetEntry[] {
    return this.shown().filter((e) => this.selected.has(assetRef(e)));
  }

  activeAsset(): AssetEntry | null {
    return this.active ? findAsset(this.active) : null;
  }

  setLibrary(id: string) {
    this.library = id;
    this.catalogPath = null;
    this.selected.clear();
    this.active = null;
    this.draw();
    this.area.drawHeader();
  }

  private editable(e: AssetEntry | null) {
    return !!e && !!libraryInfo(e.library)?.editable;
  }

  // ---------------------------------------------------------------------
  // header & menus

  header(): Child {
    const menu = (label: string, items: () => MenuItem[]) => h('button', { key: label, class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(items(), e.currentTarget as HTMLElement)) }, label);
    const libs = [{ value: ALL, label: 'All Libraries', icon: 'asset_library' }, ...libraries().map((l) => ({ value: l.id, label: l.name, icon: l.kind === 'LOCAL' ? 'file_3d' : l.kind === 'ESSENTIALS' ? 'asset_essentials' : 'asset_library' }))];
    const external = this.library !== LOCAL;
    const typesOn = this.types.size === ASSET_TABLES.length;
    return h(
      'div',
      { class: 'hdr-row' },
      menu('View', () => this.viewMenu()),
      menu('Select', () => this.selectMenu()),
      menu('Library', () => this.libraryMenu()),
      menu('Catalog', () => this.catalogMenu()),
      menu('Asset', () => this.assetMenu()),
      enumMenu('ab-lib', libs, this.library, (v) => this.setLibrary(v), { tip: 'Asset Library\nThe library whose assets are shown', className: 'ab-lib-menu' }),
      external
        ? h(
            'button',
            {
              key: 'import',
              class: 'enum-menu ab-import-menu',
              'data-tip': 'Import Settings\nHow assets from other libraries are brought into this file',
              onclick: (e: MouseEvent) => this.importPopover(e.currentTarget as HTMLElement),
            },
            h('span', { class: 'em-label' }, IMPORT_LABELS[this.importMethod]),
            h('span', { class: 'em-arrow' }, icon('down_arrow_hlt')),
          )
        : null,
      h('div', { class: 'hdr-spacer' }),
      h(
        'div',
        {
          key: 'filter',
          class: 'fb-filter-wrap',
          ref: (el: HTMLElement) => {
            if (this.focusFilter) {
              this.focusFilter = false;
              requestAnimationFrame(() => el.querySelector('input')?.focus());
            }
          },
        },
        textField('ab-filter', this.filter, (v) => ((this.filter = v), this.draw()), { placeholder: 'Search names and tags', icon: 'viewzoom', live: true, className: 'fb-filter ab-filter' }),
      ),
      h(
        'button',
        {
          key: 'types',
          class: { 'hdr-icon': true, 'ab-types-btn': true, on: !typesOn },
          'data-tip': 'Filter\nChoose the asset types to show',
          'aria-label': 'Filter',
          onclick: (e: MouseEvent) => this.typesPopover(e.currentTarget as HTMLElement),
        },
        icon('filter'),
      ),
      h(
        'button',
        { key: 'display', class: 'hdr-icon', 'data-tip': 'Display Settings\nList or thumbnails and their size', 'aria-label': 'Display Settings', onclick: (e: MouseEvent) => this.displayPopover(e.currentTarget as HTMLElement) },
        icon(this.view === 'THUMBNAIL' ? 'imgdisplay' : 'listview'),
      ),
    );
  }

  private typesPopover(anchor: HTMLElement) {
    const pop = openPopover(
      anchor,
      () =>
        h(
          'div',
          { class: 'ab-pop' },
          h('div', { class: 'ab-pop-title' }, 'Filter by Type'),
          ASSET_TABLES.map((t) =>
            h(
              'div',
              { key: t, class: 'ab-pop-row' },
              checkbox(`ab-type-${t}`, ASSET_TYPE_INFO[t].plural, this.types.has(t), (v) => {
                if (v) this.types.add(t);
                else this.types.delete(t);
                this.draw();
                this.area.drawHeader();
                pop.redraw();
              }),
            ),
          ),
          h('div', { class: 'ab-pop-actions' }, h('button', { class: 'btn', onclick: () => ((this.types = new Set(ASSET_TABLES)), this.draw(), this.area.drawHeader(), pop.redraw()) }, 'Show All')),
        ),
      { width: 200 },
    );
  }

  private importPopover(anchor: HTMLElement) {
    const pop = openPopover(
      anchor,
      () =>
        h(
          'div',
          { class: 'ab-pop' },
          h('div', { class: 'ab-pop-title' }, 'Import Method'),
          (Object.keys(IMPORT_LABELS) as ImportSetting[]).map((m) =>
            h(
              'button',
              {
                key: m,
                class: { 'ab-pop-radio': true, on: this.importMethod === m },
                'data-tip': IMPORT_TIPS[m],
                onclick: () => {
                  this.importMethod = m;
                  this.area.drawHeader();
                  pop.redraw();
                },
              },
              IMPORT_LABELS[m],
            ),
          ),
          h('div', { class: 'ab-pop-title' }, 'Collections'),
          h('div', { class: 'ab-pop-row' }, checkbox('ab-instance', 'Instance Collections', this.instanceCollections, (v) => ((this.instanceCollections = v), pop.redraw()))),
        ),
      { width: 220 },
    );
  }

  private displayPopover(anchor: HTMLElement) {
    const pop = openPopover(
      anchor,
      () =>
        h(
          'div',
          { class: 'ab-pop' },
          h('div', { class: 'ab-pop-title' }, 'Display Settings'),
          h(
            'div',
            { class: 'ab-pop-row' },
            enumMenu('ab-view', [{ value: 'THUMBNAIL', label: 'Thumbnails', icon: 'imgdisplay' }, { value: 'LIST_VERTICAL', label: 'List', icon: 'listview' }], this.view, (v) => (this.setView(v as View), pop.redraw())),
          ),
          h(
            'div',
            { class: 'ab-pop-row' },
            h('span', { class: 'ab-pop-label' }, 'Size'),
            enumMenu('ab-size', DISPLAY_SIZES.map(([value, label]) => ({ value, label })), this.size, (v) => ((this.size = v), this.draw(), pop.redraw())),
          ),
        ),
      { width: 220 },
    );
  }

  setView(v: View) {
    this.view = v;
    this.draw();
    this.area.drawHeader();
  }

  viewMenu(): MenuItem[] {
    return [
      { label: 'Thumbnails', active: this.view === 'THUMBNAIL', action: () => this.setView('THUMBNAIL') },
      { label: 'List', active: this.view === 'LIST_VERTICAL', action: () => this.setView('LIST_VERTICAL') },
      { label: 'Display Size', submenu: () => DISPLAY_SIZES.map(([k, l]) => ({ label: l, active: this.size === k, action: () => ((this.size = k), this.draw()) })) },
      { separator: true },
      { label: 'Sidebar', shortcut: 'T', checked: this.showSidebar, op: 'file.sidebar_toggle' },
      { label: 'Asset Details', shortcut: 'N', checked: this.showDetails, op: 'asset.details_toggle' },
      { separator: true },
      { label: 'Browse Files', icon: 'filebrowser', action: () => this.area.setType('FILE_BROWSER') },
      { separator: true },
      { label: 'Area', submenu: () => this.area.areaMenu() },
    ];
  }

  selectMenu(): MenuItem[] {
    return [
      { label: 'All', shortcut: 'A', op: 'file.select_all', props: { action: 'SELECT' } },
      { label: 'None', shortcut: 'Alt A', op: 'file.select_all', props: { action: 'DESELECT' } },
      { label: 'Invert', shortcut: 'Ctrl I', op: 'file.select_all', props: { action: 'INVERT' } },
      { separator: true },
      { label: 'Box Select', shortcut: 'B', op: 'file.select_box' },
    ];
  }

  libraryMenu(): MenuItem[] {
    return [
      { label: 'Refresh', shortcut: 'R', op: 'asset.library_refresh' },
      { separator: true },
      { label: 'New Library…', icon: 'add', op: 'asset.library_new' },
      { label: 'Import Library…', icon: 'import', op: 'asset.library_import' },
      { label: 'Export Library…', icon: 'export', op: 'asset.library_export' },
      { separator: true },
      { label: 'Rename Library…', op: 'asset.library_rename' },
      { label: 'Delete Library…', icon: 'trash', op: 'asset.library_remove' },
      ...(libraryInfo(this.library)?.kind === 'USER'
        ? [
            { separator: true },
            {
              label: 'Default Import Method',
              submenu: (): MenuItem[] =>
                (['APPEND', 'APPEND_REUSE'] as const).map((m) => ({ label: m === 'APPEND' ? 'Append' : 'Append (Reuse Data)', active: libraryInfo(this.library)?.import_method === m, action: () => setLibraryImportMethod(this.library, m) })),
            },
          ]
        : []),
    ];
  }

  catalogMenu(): MenuItem[] {
    const user = libraryInfo(this.library)?.kind === 'USER';
    return [
      ...(user
        ? [
            { label: 'Undo', shortcut: 'Ctrl Z', op: 'asset.catalog_undo' },
            { label: 'Redo', shortcut: 'Shift Ctrl Z', op: 'asset.catalog_redo' },
            { separator: true },
            { label: 'Save Catalogs', op: 'asset.catalogs_save' },
          ]
        : []),
      { label: 'New Catalog', icon: 'add', op: 'asset.catalog_new', props: { parent_path: this.catalogPath && this.catalogPath !== UNASSIGNED ? this.catalogPath : '' } },
    ];
  }

  assetMenu(): MenuItem[] {
    const sel = this.selection();
    const act = this.activeAsset();
    const local = sel.some((e) => e.library === LOCAL);
    return [
      { label: 'Use Asset', shortcut: 'Enter', op: 'asset.activate', disabled: !act },
      { separator: true },
      { label: 'Rename…', shortcut: 'F2', disabled: !this.editable(act), action: () => this.startRename() },
      { label: 'Clear Asset', op: 'asset.clear', disabled: !local },
      { label: 'Clear Asset (Set Fake User)', op: 'asset.clear', props: { set_fake_user: true }, disabled: !local },
      { separator: true },
      { label: 'Copy to Library…', icon: 'asset_library', op: 'asset.bundle_install' },
      { label: 'Remove from Library', icon: 'trash', op: 'asset.library_remove_assets' },
      { label: 'Open Library File', icon: 'file_3d', op: 'asset.open_containing_blend_file' },
      { separator: true },
      { label: 'Create Pose Asset…', op: 'poselib.create_pose_asset' },
    ];
  }

  contextMenu(): MenuItem[] {
    const act = this.activeAsset();
    const sel = this.selection();
    const local = sel.some((e) => e.library === LOCAL);
    const user = sel.some((e) => libraryInfo(e.library)?.kind === 'USER');
    const items: MenuItem[] = [];
    if (act) items.push({ label: 'Use Asset', shortcut: 'Enter', op: 'asset.activate' });
    if (act && this.editable(act)) items.push({ label: 'Rename…', shortcut: 'F2', action: () => this.startRename() });
    if (local) items.push({ separator: true }, { label: 'Clear Asset', op: 'asset.clear' }, { label: 'Clear Asset (Set Fake User)', op: 'asset.clear', props: { set_fake_user: true } });
    if (sel.length) items.push({ label: 'Copy to Library…', icon: 'asset_library', op: 'asset.bundle_install' });
    if (user) items.push({ separator: true }, { label: 'Remove from Library', icon: 'trash', op: 'asset.library_remove_assets' });
    if (act && act.library !== LOCAL) items.push({ label: 'Open Library File', icon: 'file_3d', op: 'asset.open_containing_blend_file' });
    if (act && this.editable(act) && this.catalogs().length) items.push({ separator: true }, { label: 'Move to Catalog', submenu: () => this.catalogPickMenu() });
    items.push({ separator: true }, { label: 'Refresh', shortcut: 'R', op: 'asset.library_refresh' }, { label: 'Select All', shortcut: 'A', op: 'file.select_all', props: { action: 'SELECT' } });
    return items;
  }

  private catalogPickMenu(): MenuItem[] {
    const out: MenuItem[] = [{ label: 'Unassigned', action: () => app.run('asset.catalog_assign', { catalog_id: '' }, { area: this.area }) }, { separator: true }];
    const walk = (nodes: CatalogNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ label: `${'   '.repeat(depth)}${n.name}`, icon: 'asset_catalog', action: () => app.run('asset.catalog_assign', { catalog_id: n.id }, { area: this.area }) });
        walk(n.children, depth + 1);
      }
    };
    walk(catalogTree(this.catalogs()), 0);
    return out;
  }

  // ---------------------------------------------------------------------
  // selection

  selectOnly(ref: string) {
    this.selected = new Set([ref]);
    this.active = ref;
    this.draw();
  }

  private click(e: AssetEntry, ev: MouseEvent) {
    const ref = assetRef(e);
    const list = this.shown().map(assetRef);
    if (ev.shiftKey && this.active) {
      const a = list.indexOf(this.active),
        b = list.indexOf(ref);
      if (!(ev.ctrlKey || ev.metaKey)) this.selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (list[i]) this.selected.add(list[i]);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (this.selected.has(ref)) this.selected.delete(ref);
      else this.selected.add(ref);
    } else this.selected = new Set([ref]);
    this.active = ref;
    this.draw();
  }

  selectAll(action: 'SELECT' | 'DESELECT' | 'INVERT' | 'TOGGLE') {
    const list = this.shown().map(assetRef);
    const any = list.some((r) => this.selected.has(r));
    const next = new Set<string>();
    for (const r of list) {
      const on = action === 'SELECT' ? true : action === 'DESELECT' ? false : action === 'INVERT' ? !this.selected.has(r) : !any;
      if (on) next.add(r);
    }
    this.selected = next;
    if (this.active && !next.has(this.active)) this.active = [...next][0] ?? null;
    this.draw();
  }

  walk(dir: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', extend: boolean, fill: boolean) {
    const list = this.shown().map(assetRef);
    if (!list.length) return;
    const els = [...this.main.querySelectorAll<HTMLElement>('.ab-item')];
    let cols = 1;
    if (this.view === 'THUMBNAIL' && els.length > 1) {
      const top = els[0].offsetTop;
      const i = els.findIndex((x) => x.offsetTop !== top);
      cols = i < 0 ? els.length : Math.max(1, i);
    }
    const i = this.active ? list.indexOf(this.active) : -1;
    const step = dir === 'LEFT' ? -1 : dir === 'RIGHT' ? 1 : dir === 'UP' ? -cols : cols;
    const j = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + step));
    const ref = list[j];
    if (fill && i >= 0) for (let k = Math.min(i, j); k <= Math.max(i, j); k++) this.selected.add(list[k]);
    else if (extend) this.selected.add(ref);
    else this.selected = new Set([ref]);
    this.active = ref;
    this.draw();
    this.itemEl(ref)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private itemEl(ref: string) {
    return this.main.querySelector<HTMLElement>(`.ab-item[data-ref="${CSS.escape(ref)}"]`);
  }

  viewSelected() {
    const ref = this.active ?? [...this.selected][0];
    if (ref) this.itemEl(ref)?.scrollIntoView({ block: 'center', inline: 'center' });
  }

  startFilter() {
    this.focusFilter = true;
    this.area.drawHeader();
  }

  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    this.draw();
  }

  toggleDetails() {
    this.showDetails = !this.showDetails;
    this.draw();
  }

  /** F2: rename the active asset in place. */
  startRename() {
    const e = this.activeAsset();
    if (!e || !this.editable(e)) return;
    this.renaming = assetRef(e);
    this.draw();
  }

  private finishRename(e: AssetEntry, name: string) {
    this.renaming = null;
    const n = name.trim();
    if (n && n !== e.block.name) {
      const doc = libraryDoc(e.library);
      const tab = doc ? (doc as unknown as Record<string, Record<string, { name: string }>>)[e.table] : undefined;
      const taken = new Set(Object.values(tab ?? {}).filter((b) => b !== e.block).map((b) => b.name));
      let nn = n;
      for (let i = 1; taken.has(nn); i++) nn = `${n}.${String(i).padStart(3, '0')}`;
      e.block.name = nn;
      this.committed(e.library, 'Rename Asset');
    }
    this.draw();
  }

  private boxSelect(down: PointerEvent, always = false) {
    const sx = down.clientX,
      sy = down.clientY;
    const mode = down.shiftKey ? 'ADD' : down.ctrlKey || down.metaKey ? 'SUB' : 'SET';
    let dragging = always;
    if (always) this.main.append(this.boxEl);
    const move = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
      if (!this.boxEl.isConnected) this.main.append(this.boxEl);
      dragging = true;
      const r = this.main.getBoundingClientRect();
      Object.assign(this.boxEl.style, { display: 'block', left: `${Math.min(sx, e.clientX) - r.left + this.main.scrollLeft}px`, top: `${Math.min(sy, e.clientY) - r.top + this.main.scrollTop}px`, width: `${Math.abs(e.clientX - sx)}px`, height: `${Math.abs(e.clientY - sy)}px` });
    };
    const up = (e: PointerEvent) => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      this.boxEl.style.display = 'none';
      this.boxEl.remove();
      if (!dragging) {
        if (mode === 'SET') {
          this.selected.clear();
          this.active = null;
          this.draw();
        }
        return;
      }
      const swallow = (ev: Event) => ev.stopPropagation();
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
      const x0 = Math.min(sx, e.clientX),
        x1 = Math.max(sx, e.clientX),
        y0 = Math.min(sy, e.clientY),
        y1 = Math.max(sy, e.clientY);
      if (mode === 'SET') this.selected.clear();
      for (const el of this.main.querySelectorAll<HTMLElement>('.ab-item')) {
        const r = el.getBoundingClientRect();
        if (r.right < x0 || r.left > x1 || r.bottom < y0 || r.top > y1) continue;
        const ref = el.dataset.ref!;
        if (mode === 'SUB') this.selected.delete(ref);
        else {
          this.selected.add(ref);
          this.active ??= ref;
        }
      }
      this.draw();
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  }

  // ---------------------------------------------------------------------
  // metadata editing

  /** An edit of a library's data was made directly: undo step (current file) or save (user library). */
  private committed(library: string, label: string) {
    if (library === LOCAL) {
      app.pushUndo(label);
      app.changed('doc');
    } else libraryChanged(library);
  }

  private setMeta(e: AssetEntry, key: 'description' | 'author' | 'license' | 'copyright', v: string) {
    const m = e.block.asset_data!;
    if (m[key] === v) return;
    m[key] = v;
    this.committed(e.library, 'Edit Asset Metadata');
  }

  private setTag(e: AssetEntry, i: number, v: string) {
    const m = e.block.asset_data!;
    const n = v.trim();
    if (!n || m.tags[i] === n) return this.draw();
    m.tags = m.tags.map((t, k) => (k === i ? n : t));
    this.committed(e.library, 'Rename Asset Tag');
  }

  // ---------------------------------------------------------------------
  // drawing

  private internalTarget(): InternalTarget {
    return {
      hint: (el) => {
        const row = el.closest<HTMLElement>('.ab-cat[data-cat-id]');
        if (!row || !this.el.contains(row)) return null;
        if (!libraryInfo(this.library)?.editable) return null;
        const id = row.dataset.catId!;
        return id ? `Move to “${row.dataset.catName}”` : 'Remove from catalog';
      },
      drop: (el, refs) => {
        const row = el.closest<HTMLElement>('.ab-cat[data-cat-id]');
        if (!row) return false;
        return app.run('asset.catalog_assign', { catalog_id: row.dataset.catId, assets: refs.join(',') }, { area: this.area }) === 'FINISHED';
      },
    };
  }

  private itemPointerDown(e: AssetEntry, ev: PointerEvent) {
    if (ev.button !== 0) return;
    const ref = assetRef(e);
    const refs = this.selected.has(ref) ? [ref, ...[...this.selected].filter((r) => r !== ref)] : [ref];
    startAssetDrag(ev, { refs, importMethod: this.importMethod, instanceCollections: this.instanceCollections }, this.internalTarget());
  }

  private catalogRows(): Child[] {
    const editable = !!libraryInfo(this.library)?.editable && this.library !== ALL;
    const cats = this.catalogs();
    const rows: Child[] = [];
    const counts = new Map<string, number>();
    let unassigned = 0;
    const all = this.allAssets().filter((e) => this.types.has(e.table));
    for (const e of all) {
      const p = catalogPathOf(e);
      if (!p) unassigned++;
      else
        for (let q = p; q; q = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : '') counts.set(q, (counts.get(q) ?? 0) + 1);
    }
    const row = (key: string, path: string | null, name: string, depth: number, ic: string, count: number, node?: CatalogNode) => {
      const on = this.catalogPath === path;
      const hasKids = !!node?.children.length;
      const open = !!node && !this.collapsed.has(node.path);
      return h(
        'div',
        {
          key,
          class: { 'ab-cat': true, on },
          style: { paddingLeft: `${6 + depth * 14}px` },
          'data-cat-id': node ? node.id : path === UNASSIGNED ? '' : undefined,
          'data-cat-name': name,
          'data-cat-path': path ?? '',
          draggable: 'false',
          onclick: () => {
            this.catalogPath = path;
            this.draw();
          },
          ondblclick: node && editable ? () => ((this.renamingCatalog = node.id), this.draw()) : undefined,
          oncontextmenu: (ev: MouseEvent) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (!editable) return;
            const items: MenuItem[] = [{ label: 'New Catalog', icon: 'add', op: 'asset.catalog_new', props: { parent_path: node?.path ?? '' } }];
            if (node)
              items.push(
                { label: 'Rename', shortcut: 'Double-click', action: () => ((this.renamingCatalog = node.id), this.draw()) },
                { separator: true },
                { label: 'Delete Catalog', icon: 'trash', op: 'asset.catalog_delete', props: { catalog_id: node.id } },
              );
            openMenu(items, { x: ev.clientX, y: ev.clientY }, { title: node ? name : 'Catalogs' });
          },
          onpointerdown: node && editable ? (ev: PointerEvent) => this.catalogDrag(ev, node) : undefined,
        },
        hasKids
          ? h('button', { class: 'ab-cat-arrow', onclick: (ev: MouseEvent) => (ev.stopPropagation(), open ? this.collapsed.add(node!.path) : this.collapsed.delete(node!.path), this.draw()) }, icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right'))
          : h('span', { class: 'ab-cat-arrow' }),
        icon(ic),
        node && this.renamingCatalog === node.id
          ? h('input', {
              class: 'ab-cat-rename',
              value: node.name,
              spellcheck: 'false',
              ref: (el: HTMLInputElement) => requestAnimationFrame(() => (el.focus(), el.select())),
              onkeydown: (ev: KeyboardEvent) => {
                ev.stopPropagation();
                if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
                if (ev.key === 'Escape') ((this.renamingCatalog = null), this.draw());
              },
              onblur: (ev: FocusEvent) => {
                const v = (ev.target as HTMLInputElement).value;
                if (this.renamingCatalog !== node.id) return;
                this.renamingCatalog = null;
                if (v.trim() && v !== node.name) app.run('asset.catalog_rename', { catalog_id: node.id, name: v }, { area: this.area });
                this.draw();
              },
              onclick: (ev: MouseEvent) => ev.stopPropagation(),
            })
          : h('span', { class: 'ab-cat-name' }, name),
        count ? h('span', { class: 'ab-cat-count' }, String(count)) : null,
      );
    };
    rows.push(row('all', null, 'All', 0, 'asset_catalog_all', all.length));
    const walk = (nodes: CatalogNode[], depth: number) => {
      for (const n of nodes) {
        rows.push(row(`c:${n.id}`, n.path, n.name, depth, 'asset_catalog', counts.get(n.path) ?? 0, n));
        if (!this.collapsed.has(n.path)) walk(n.children, depth + 1);
      }
    };
    walk(catalogTree(cats), 1);
    rows.push(row('unassigned', UNASSIGNED, 'Unassigned', 0, 'asset_catalog_none', unassigned));
    return rows;
  }

  /** Drag a catalog onto another to nest it (or onto "All" to move it to the top level). */
  private catalogDrag(down: PointerEvent, node: CatalogNode) {
    if (down.button !== 0 || (down.target as HTMLElement).closest('button, input')) return;
    const sx = down.clientX,
      sy = down.clientY;
    let dragging = false;
    let over: HTMLElement | null = null;
    const move = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
      dragging = true;
      over?.classList.remove('drop-into');
      over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.ab-cat') ?? null;
      if (over && this.side.contains(over)) over.classList.add('drop-into');
      else over = null;
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      over?.classList.remove('drop-into');
      if (!dragging || !over) return;
      const swallow = (ev: Event) => ev.stopPropagation();
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
      const target = over.dataset.catId;
      // "All" (no id attribute) moves the catalog to the top level
      if (target === node.id) return;
      app.run('asset.catalog_move', { catalog_id: node.id, parent_id: target ?? '' }, { area: this.area });
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  }

  private sideBar(): Child[] {
    const editable = !!libraryInfo(this.library)?.editable && this.library !== ALL;
    const libItem = (id: string, name: string, ic: string, tip: string) =>
      h(
        'button',
        {
          key: `lib:${id}`,
          class: { 'ab-lib': true, on: this.library === id },
          'data-lib': id,
          'data-tip': tip,
          onclick: () => this.setLibrary(id),
        },
        icon(ic),
        h('span', null, name),
      );
    return [
      h('div', { key: 'lt', class: 'ab-side-title' }, h('span', null, 'Libraries'), h('button', { class: 'ab-side-add', 'data-tip': 'New Library\nCreate an asset library kept in this browser', 'aria-label': 'New Library', onclick: () => app.run('asset.library_new', {}, { area: this.area }) }, icon('add'))),
      libItem(ALL, 'All Libraries', 'asset_library', 'All Libraries\nAssets of every library'),
      ...libraries().map((l) => libItem(l.id, l.name, l.kind === 'LOCAL' ? 'file_3d' : l.kind === 'ESSENTIALS' ? 'asset_essentials' : 'asset_library', l.kind === 'LOCAL' ? 'Current File\nAssets marked in this file' : l.kind === 'ESSENTIALS' ? 'Essentials\nBuilt-in assets' : `${l.name}\nUser library kept in this browser`)),
      h(
        'div',
        { key: 'ct', class: 'ab-side-title' },
        h('span', null, 'Catalogs'),
        editable ? h('button', { class: 'ab-side-add', 'data-tip': 'New Catalog', 'aria-label': 'New Catalog', onclick: () => app.run('asset.catalog_new', { parent_path: this.catalogPath && this.catalogPath !== UNASSIGNED ? this.catalogPath : '' }, { area: this.area }) }, icon('add')) : null,
      ),
      h('div', { key: 'cats', class: 'ab-cats' }, this.catalogRows()),
    ];
  }

  private itemView(e: AssetEntry): Child {
    const ref = assetRef(e);
    const m = e.block.asset_data!;
    if (m.preview === undefined && e.library === ESSENTIALS) queuePreview(e);
    const sel = this.selected.has(ref);
    const info = ASSET_TYPE_INFO[e.table];
    const libName = libraryInfo(e.library)?.name ?? e.library;
    const tip = [e.block.name, `${info.label} · ${libName}${catalogPathOf(e) ? ` · ${catalogPathOf(e)}` : ''}`, m.description].filter(Boolean).join('\n');
    return h(
      'div',
      {
        key: ref,
        class: { 'ab-item': true, on: sel, active: this.active === ref },
        'data-ref': ref,
        'data-name': e.block.name,
        role: 'option',
        'aria-selected': sel ? 'true' : 'false',
        'data-tip': tip,
        onpointerdown: (ev: PointerEvent) => this.itemPointerDown(e, ev),
        onclick: (ev: MouseEvent) => this.click(e, ev),
        ondblclick: () => activateAsset(this, e.library, e.table, e.id),
      },
      h(
        'div',
        { class: 'ab-thumb' },
        m.preview ? h('img', { src: m.preview, alt: '', draggable: 'false' }) : icon(info.icon),
        this.view === 'THUMBNAIL' ? h('span', { class: 'ab-type-badge', 'data-tip': info.label }, icon(info.icon)) : null,
      ),
      this.renaming === ref
        ? h('input', {
            class: 'ab-rename',
            value: e.block.name,
            spellcheck: 'false',
            ref: (el: HTMLInputElement) => requestAnimationFrame(() => (el.focus(), el.select())),
            onpointerdown: (ev: PointerEvent) => ev.stopPropagation(),
            onclick: (ev: MouseEvent) => ev.stopPropagation(),
            onkeydown: (ev: KeyboardEvent) => {
              ev.stopPropagation();
              if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
              if (ev.key === 'Escape') ((this.renaming = null), this.draw());
            },
            onblur: (ev: FocusEvent) => this.renaming === ref && this.finishRename(e, (ev.target as HTMLInputElement).value),
          })
        : h('span', { class: 'ab-name' }, e.block.name),
      this.view === 'LIST_VERTICAL' ? h('span', { class: 'ab-col' }, info.label) : null,
      this.view === 'LIST_VERTICAL' ? h('span', { class: 'ab-col ab-col-cat' }, catalogPathOf(e) || '—') : null,
      this.view === 'LIST_VERTICAL' && this.library === ALL ? h('span', { class: 'ab-col' }, libName) : null,
    );
  }

  private detailsPanel(): Child {
    const e = this.activeAsset();
    if (!e) return h('div', { class: 'ab-details-empty' }, 'Select an asset to see its details');
    const m = e.block.asset_data!;
    const editable = this.editable(e);
    const lib = libraryInfo(e.library);
    const field = (key: 'description' | 'author' | 'license' | 'copyright', label: string) =>
      h(
        'div',
        { key, class: 'ab-field' },
        h('label', { class: 'ab-field-label' }, label),
        editable
          ? key === 'description'
            ? h('textarea', {
                class: 'ab-desc',
                rows: 3,
                value: m.description,
                spellcheck: 'false',
                'data-field': key,
                onkeydown: (ev: KeyboardEvent) => ev.stopPropagation(),
                onchange: (ev: Event) => this.setMeta(e, key, (ev.target as HTMLTextAreaElement).value),
              })
            : h('label', { class: 'text-field' }, h('input', { value: m[key], spellcheck: 'false', 'data-field': key, onkeydown: (ev: KeyboardEvent) => (ev.stopPropagation(), ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()), onchange: (ev: Event) => this.setMeta(e, key, (ev.target as HTMLInputElement).value) }))
          : h('div', { class: 'ab-field-ro' }, m[key] || '—'),
      );
    const info = ASSET_TYPE_INFO[e.table];
    return [
      panel('ab-meta', 'Asset Metadata', () => [
        h(
          'div',
          { class: 'ab-field' },
          h('label', { class: 'ab-field-label' }, 'Name'),
          editable
            ? h('label', { class: 'text-field' }, icon(info.icon), h('input', { value: e.block.name, spellcheck: 'false', 'data-field': 'name', onkeydown: (ev: KeyboardEvent) => (ev.stopPropagation(), ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()), onchange: (ev: Event) => this.finishRename(e, (ev.target as HTMLInputElement).value) }))
            : h('div', { class: 'ab-field-ro' }, icon(info.icon), e.block.name),
        ),
        h('div', { class: 'ab-field' }, h('label', { class: 'ab-field-label' }, 'Source'), h('div', { class: 'ab-field-ro' }, lib?.name ?? e.library, e.library !== LOCAL && lib?.kind === 'USER' ? ' (user library)' : '')),
        h('div', { class: 'ab-field' }, h('label', { class: 'ab-field-label' }, 'Catalog'), h('div', { class: 'ab-field-ro' }, catalogPathOf(e) || 'Unassigned')),
        field('description', 'Description'),
        field('license', 'License'),
        field('copyright', 'Copyright'),
        field('author', 'Author'),
      ]),
      panel('ab-preview', 'Preview', () => [
        h('div', { class: 'ab-preview-box' }, m.preview ? h('img', { src: m.preview, alt: `Preview of ${e.block.name}` }) : icon(info.icon)),
        editable
          ? h(
              'div',
              { class: 'ab-preview-actions' },
              h('button', { class: 'btn', 'data-tip': 'Load Custom Preview\nUse an image file as the preview', onclick: () => app.run('ed.lib_id_load_custom_preview', {}, { area: this.area }) }, icon('file_image'), 'Load'),
              h('button', { class: 'btn', 'data-tip': 'Generate Preview\nRender a new preview of the asset', onclick: () => app.run('ed.lib_id_generate_preview', {}, { area: this.area }) }, icon('render'), 'Generate'),
              h(
                'button',
                {
                  class: 'btn ab-preview-more',
                  'data-tip': 'Preview',
                  'aria-label': 'Preview options',
                  onpointerdown: (ev: PointerEvent) => {
                    ev.preventDefault();
                    openMenu(
                      [
                        { label: 'Render Active Object', op: 'ed.lib_id_generate_preview_from_object' },
                        { separator: true },
                        { label: 'Remove Preview', icon: 'x', op: 'ed.lib_id_remove_preview' },
                        { label: 'Capture Screenshot Preview', op: 'asset.screenshot_preview' },
                      ],
                      ev.currentTarget as HTMLElement,
                    );
                  },
                },
                icon('down_arrow_hlt'),
              ),
            )
          : null,
      ]),
      panel('ab-tags', 'Tags', () => [
        h(
          'div',
          { class: 'ab-tags' },
          m.tags.length
            ? m.tags.map((t, i) =>
                h(
                  'div',
                  { key: `${i}:${t}`, class: 'ab-tag' },
                  icon('asset_tag'),
                  editable
                    ? h('input', { value: t, spellcheck: 'false', 'data-tag': String(i), onkeydown: (ev: KeyboardEvent) => (ev.stopPropagation(), ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()), onchange: (ev: Event) => this.setTag(e, i, (ev.target as HTMLInputElement).value) })
                    : h('span', null, t),
                  editable ? h('button', { class: 'ab-tag-x', 'data-tip': 'Remove Tag', 'aria-label': `Remove tag ${t}`, onclick: () => app.run('asset.tag_remove', { index: i }, { area: this.area }) }, icon('x')) : null,
                ),
              )
            : h('div', { class: 'ab-details-empty' }, 'No tags'),
        ),
        editable ? h('button', { class: 'btn ab-tag-add', onclick: () => app.run('asset.tag_add', {}, { area: this.area }) }, icon('add'), 'Add Tag') : null,
      ]),
    ];
  }

  draw() {
    this.lastRevision = libraryRevision;
    // a library that was deleted (or never existed) falls back to the current file
    if (this.library !== ALL && libraryIndexReady() && !libraryInfo(this.library)) {
      this.library = LOCAL;
      this.catalogPath = null;
    }
    this.el.classList.toggle('no-sidebar', !this.showSidebar);
    this.el.classList.toggle('no-details', !this.showDetails);
    if (this.showSidebar) patch(this.side, this.sideBar());
    const doc = libraryDoc(this.library === ALL ? LOCAL : this.library);
    const err = this.library !== ALL ? libraryError(this.library) : undefined;
    const shown = this.shown();
    // forget selections of assets that went away
    if (this.active && !findAsset(this.active)) this.active = null;
    for (const r of [...this.selected]) if (!findAsset(r)) this.selected.delete(r);
    const px = DISPLAY_SIZES.find(([k]) => k === this.size)?.[2] ?? 96;
    let body: Child;
    if (err) body = h('div', { class: 'fb-empty' }, `This library cannot be read: ${err}`);
    else if (!doc && this.library !== ALL) body = h('div', { class: 'fb-empty-small' }, 'Loading library…');
    else if (!shown.length) body = h('div', { class: 'fb-empty ab-empty' }, this.emptyText());
    else
      body = h(
        'div',
        { class: `ab-items ${this.view === 'THUMBNAIL' ? 'grid' : 'list'}`, role: 'listbox', 'aria-multiselectable': 'true', style: { '--ab-size': `${px}px` } },
        shown.map((e) => this.itemView(e)),
      );
    patch(this.main, [body]);
    if (this.showDetails) patch(this.details, [h('div', { class: 'ab-details-inner' }, this.detailsPanel())]);
  }

  private emptyText(): string {
    const total = this.allAssets().length;
    if (total) return 'No assets match the filters.';
    if (this.library === LOCAL) return 'This file has no assets yet. Mark objects, materials, node groups, worlds or actions as assets (right-click them in the Outliner, or Object ▸ Asset ▸ Mark as Asset) to see them here.';
    if (libraryInfo(this.library)?.kind === 'USER') return 'This library is empty. Copy assets of the current file into it with Asset ▸ Copy to Library.';
    return 'No assets.';
  }
}

registerEditor({ id: 'ASSETS', label: 'Asset Browser', icon: 'asset_browser', group: 'Data', create: (a, s) => new AssetBrowser(a, s) });

/** Test hook / the asset browser shown in an area. */
export function assetBrowsers(): AssetBrowser[] {
  return [...browsers];
}
