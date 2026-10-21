// File Browser editor: browse local folders (File System Access API), the browser's own storage
// (origin private file system) or picked files. Multi-selection with mouse, box and keyboard,
// bookmarks and recent folders (kept between sessions), rename / delete / new folder where the
// folder is writable, sorting, filtering, list and thumbnail display modes. Double-click (or
// Enter) opens projects, imports models and loads images and texts.
import { formatDate, prefs } from '../app/prefs';
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type ChangeKind, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, openPie, promptText, type MenuItem } from '../ui/menu';
import { textField, enumRow } from '../ui/widgets';
import { openFile, formats, fileEvents, projectUiState } from '../io/files';
import { encodeDocument } from '../io/native';
import { imageFromFile } from '../ops/imageobjects';
import { newText } from '../data/defaults';
import { registerIcons } from '../ui/icons';
import { kvGet, kvSet } from '../io/session';
import { category as categoryOf, sortEntries, filterEntries, walkIndex, uniqueEntryName, formatSize, moveInList, type Category, type SortBy } from './filebrowser_logic';
import './filebrowser.css';

registerIcons({
  back: '<path class="s" d="M10 3 5 8l5 5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  forward: '<path class="s" d="M6 3l5 5-5 5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  file_parent: '<path class="s" d="M8 13V4M4 7.5 8 3.5l4 4" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  file_refresh: '<path class="s" d="M12.5 6A5 5 0 1 0 13 9.5" fill="none" stroke-width="1.6" stroke-linecap="round"/><path class="f" d="M13.8 2.2v4.6H9.2z"/>',
  listview: '<path class="f" d="M2 3h2v2H2zM6 3h8v2H6zM2 7h2v2H2zM6 7h8v2H6zM2 11h2v2H2zM6 11h8v2H6z"/>',
  hlistview: '<path class="f" d="M2 3h2v2H2zM5 3h3v2H5zM9 3h2v2H9zM12 3h3v2h-3zM2 7h2v2H2zM5 7h3v2H5zM9 7h2v2H9zM12 7h3v2h-3zM2 11h2v2H2zM5 11h3v2H5z"/>',
  imgdisplay: '<path class="f" d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"/>',
  viewzoom: '<circle class="s" cx="7" cy="7" r="4" fill="none" stroke-width="1.6"/><path class="s" d="M10 10l4 4" stroke-width="1.8" stroke-linecap="round"/>',
  file: '<path class="s" d="M4 2h5l3 3v9H4z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><path class="s" d="M9 2v3h3" fill="none" stroke-width="1.1"/>',
  file_blend: '<path class="s" d="M4 2h5l3 3v9H4z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><circle class="f" cx="8" cy="10" r="2.2" fill="#e49b34"/>',
  filebrowser: '<path class="f" d="M2 4h4.5l1.5 1.5h6V13H2z" opacity=".85"/><path d="M2 7h12" stroke="#1a1b1c" stroke-width="1"/>',
  bookmark: '<path class="f" d="M4 2h8v12l-4-3-4 3z"/>',
  newfolder: '<path class="f" d="M1.5 4h4.5l1.5 1.5h5V9h-1.5V7H3v6h6v1.5H1.5z" opacity=".85"/><path class="s" d="M12.5 10v5M10 12.5h5" stroke-width="1.6" stroke-linecap="round"/>',
  storage: '<rect class="s" x="2.5" y="3" width="11" height="4" rx="1" fill="none" stroke-width="1.3"/><rect class="s" x="2.5" y="9" width="11" height="4" rx="1" fill="none" stroke-width="1.3"/><circle class="f" cx="11" cy="5" r=".9"/><circle class="f" cx="11" cy="11" r=".9"/>',
});

interface DirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
  getDirectoryHandle?(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle?(name: string, o?: { create?: boolean }): Promise<FileHandle>;
  removeEntry?(name: string, o?: { recursive?: boolean }): Promise<void>;
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: unknown): Promise<boolean>;
}
interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable?(): Promise<{ write(d: BlobPart): Promise<void>; close(): Promise<void> }>;
  move?(name: string): Promise<void>;
}

interface Item {
  name: string;
  kind: 'dir' | 'file';
  dir?: DirHandle;
  file?: File;
  handle?: FileHandle;
  size?: number;
  mtime?: number;
}

type View = 'LIST_VERTICAL' | 'LIST_HORIZONTAL' | 'THUMBNAIL';
const SIZES: [number, string][] = [
  [48, 'Tiny'],
  [72, 'Small'],
  [96, 'Regular'],
  [144, 'Large'],
];
const CATEGORIES: [Category, string, string][] = [
  ['project', 'Project Files', 'file_blend'],
  ['image', 'Images', 'image'],
  ['model', '3D Models', 'mesh_data'],
  ['text', 'Text Files', 'text'],
  ['other', 'Other Files', 'file'],
];

const modelExts = () => formats.filter((f) => f.import).flatMap((f) => f.extensions.map((x) => x.toLowerCase()));
const category = (name: string) => categoryOf(name, modelExts());
const CAT_ICON: Record<Category, string> = { project: 'file_blend', image: 'image', model: 'mesh_data', text: 'text', other: 'file' };

// ---------------------------------------------------------------------------
// shared state: folders opened this session, bookmarks and recent folders (persisted)

interface Place {
  name: string;
  handle: DirHandle;
}
const roots: DirHandle[] = [];
let bookmarks: Place[] = [];
let recentDirs: Place[] = [];
const recentFiles: File[] = [];
let opfs: DirHandle | null = null;
const browsers = new Set<FileBrowser>();
const redrawAll = () => browsers.forEach((b) => b.draw());

const supportsFolders = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

void (async () => {
  try {
    opfs = ((await navigator.storage?.getDirectory?.()) as unknown as DirHandle) ?? null;
  } catch {
    opfs = null;
  }
  bookmarks = ((await kvGet<Place[]>('fb-bookmarks')) ?? []).filter((p) => p?.handle);
  recentDirs = ((await kvGet<Place[]>('fb-recent')) ?? []).filter((p) => p?.handle);
  redrawAll();
})();

const saveBookmarks = () => void kvSet('fb-bookmarks', bookmarks).catch(() => {});
async function sameEntry(a: DirHandle, b: DirHandle) {
  if (a === b) return true;
  try {
    return !!(await a.isSameEntry?.(b));
  } catch {
    return false;
  }
}
async function rememberDir(d: DirHandle) {
  for (const p of recentDirs) if (await sameEntry(p.handle, d)) recentDirs.splice(recentDirs.indexOf(p), 1);
  recentDirs.unshift({ name: d.name, handle: d });
  recentDirs.splice(10);
  void kvSet('fb-recent', recentDirs).catch(() => {});
}

/** Ask for (and wait on) read or write access to a folder handle restored from storage. */
async function ensurePermission(d: DirHandle, mode: 'read' | 'readwrite') {
  try {
    if (!d.queryPermission) return true;
    if ((await d.queryPermission({ mode })) === 'granted') return true;
    return (await d.requestPermission?.({ mode })) === 'granted';
  } catch {
    return false;
  }
}

export class FileBrowser implements Editor {
  el: HTMLElement;
  keymaps = ['File Browser', 'Window', 'Screen'];
  private side: HTMLElement;
  private main: HTMLElement;
  private boxEl: HTMLElement;
  path: DirHandle[] = [];
  items: Item[] = [];
  private loose: File[] = [];
  view: View = 'THUMBNAIL';
  thumbSize = 96;
  sortBy: SortBy = 'ALPHA';
  sortReverse = false;
  filter = '';
  /** defaults from Preferences ▸ Save & Load ▸ File Browser */
  showHidden = prefs.show_hidden_files_datablocks;
  /** only show files of these categories (null: all files) */
  categories: Set<Category> | null = prefs.use_filter_files ? new Set(['project', 'image', 'model', 'text']) : null;
  showSidebar = true;
  selected = new Set<string>();
  active: string | null = null;
  private thumbs = new Map<string, string>();
  private history: DirHandle[][] = [];
  private future: DirHandle[][] = [];
  private status = '';
  private focusFilter = false;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    const st = (state ?? {}) as Partial<{ view: string; size: number; sort: SortBy; reverse: boolean; hidden: boolean; sidebar: boolean; categories: Category[] | null }>;
    if (st.view === 'LIST' || st.view === 'LIST_VERTICAL') this.view = 'LIST_VERTICAL';
    else if (st.view === 'LIST_HORIZONTAL' || st.view === 'THUMBNAIL') this.view = st.view;
    if (st.size) this.thumbSize = st.size;
    if (st.sort) this.sortBy = st.sort;
    this.sortReverse = !!st.reverse;
    this.showHidden = !!st.hidden;
    if (st.sidebar !== undefined) this.showSidebar = st.sidebar;
    if (st.categories !== undefined) this.categories = st.categories ? new Set(st.categories) : null;
    this.el = document.createElement('div');
    this.el.className = 'file-browser';
    this.side = document.createElement('div');
    this.side.className = 'fb-side';
    this.main = document.createElement('div');
    this.main.className = 'fb-main';
    this.main.tabIndex = -1;
    this.boxEl = document.createElement('div');
    this.boxEl.className = 'fb-box';
    this.el.append(this.side, this.main);
    this.main.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        if (this.boxPending) {
          // B: this drag is a box selection even when it starts on an item
          this.boxPending = false;
          e.preventDefault();
          e.stopPropagation();
          return this.boxSelect(e, true);
        }
        if (!(e.target as HTMLElement).closest('.fb-item, button')) this.boxSelect(e);
      },
      true,
    );
    this.main.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const it = (e.target as HTMLElement).closest<HTMLElement>('.fb-item');
      if (it?.dataset.name && !this.selected.has(it.dataset.name)) this.selectOnly(it.dataset.name);
      openMenu(this.contextMenu(), { x: e.clientX, y: e.clientY }, { title: 'Files' });
    });
    browsers.add(this);
    if (roots.length) void this.enter([roots[0]], false);
    else this.draw();
  }

  serialize() {
    return { view: this.view, size: this.thumbSize, sort: this.sortBy, reverse: this.sortReverse, hidden: this.showHidden, sidebar: this.showSidebar, categories: this.categories ? [...this.categories] : null };
  }

  get dir(): DirHandle | null {
    return this.path[this.path.length - 1] ?? null;
  }

  // ---------------------------------------------------------------------
  // header and menus

  header(): Child {
    const nav = (ic: string, tip: string, on: boolean, fn: () => void) => h('button', { key: tip, class: 'hdr-icon', 'data-tip': tip, 'aria-label': tip.split('\n')[0], disabled: !on, onclick: fn }, icon(ic));
    const menu = (label: string, items: () => MenuItem[]) => h('button', { key: label, class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(items(), e.currentTarget as HTMLElement)) }, label);
    return h(
      'div',
      { class: 'hdr-row' },
      menu('View', () => this.viewMenu()),
      menu('Select', () => this.selectMenu()),
      nav('back', 'Back\nPrevious folder (Alt ←, Backspace)', this.history.length > 0, () => this.back()),
      nav('forward', 'Forward\nNext folder (Alt →, Shift Backspace)', this.future.length > 0, () => this.forward()),
      nav('file_parent', 'Parent Directory\n(P, Alt ↑)', this.path.length > 1, () => this.parent()),
      nav('file_refresh', 'Refresh\nRe-read the folder (R)', this.path.length > 0, () => this.refresh()),
      nav('newfolder', 'Create New Directory\n(I)', !!this.dir?.getDirectoryHandle, () => void this.newFolder()),
      h('button', { class: 'fb-path', 'data-tip': `${this.pathLabel()}\nClick to type a folder path (Ctrl L)`, disabled: !this.path.length, onclick: () => app.run('file.edit_directory_path', {}, { area: this.area }) }, this.pathLabel()),
      h('div', { class: 'hdr-spacer' }),
      enumRow(
        'fb-view',
        [
          { value: 'LIST_VERTICAL', label: '', icon: 'listview', description: 'Vertical List' },
          { value: 'LIST_HORIZONTAL', label: '', icon: 'hlistview', description: 'Horizontal List' },
          { value: 'THUMBNAIL', label: '', icon: 'imgdisplay', description: 'Thumbnails' },
        ],
        this.view,
        (v) => this.setView(v as View),
        { iconOnly: true },
      ),
      h('div', {
        key: 'filter',
        class: 'fb-filter-wrap',
        ref: (el: HTMLElement) => {
          if (this.focusFilter) {
            this.focusFilter = false;
            requestAnimationFrame(() => el.querySelector('input')?.focus());
          }
        },
      }, textField('fb-filter', this.filter, (v) => ((this.filter = v), this.draw()), { placeholder: 'Filter (e.g. *.png)', icon: 'viewzoom', live: true, className: 'fb-filter' })),
    );
  }

  private pathLabel() {
    return this.path.length ? this.path.map((d) => d.name || 'Browser Storage').join(' / ') : this.loose.length ? 'Added files' : supportsFolders ? 'No folder opened' : 'Added files';
  }

  viewMenu(): MenuItem[] {
    return [
      { label: 'Vertical List', active: this.view === 'LIST_VERTICAL', action: () => this.setView('LIST_VERTICAL') },
      { label: 'Horizontal List', active: this.view === 'LIST_HORIZONTAL', action: () => this.setView('LIST_HORIZONTAL') },
      { label: 'Thumbnails', active: this.view === 'THUMBNAIL', action: () => this.setView('THUMBNAIL') },
      { label: 'Display Size', disabled: this.view !== 'THUMBNAIL', submenu: () => SIZES.map(([px, l]) => ({ label: l, active: this.thumbSize === px, action: () => ((this.thumbSize = px), this.draw()) })) },
      { separator: true },
      {
        label: 'Sort By',
        submenu: () => [
          ...(['ALPHA', 'EXTENSION', 'TIME', 'SIZE'] as SortBy[]).map((s) => ({ label: { ALPHA: 'Name', EXTENSION: 'Extension', TIME: 'Modified Date', SIZE: 'Size' }[s], active: this.sortBy === s, action: () => this.setSort(s) })),
          { separator: true },
          { label: 'Reverse Sorting', checked: this.sortReverse, action: () => ((this.sortReverse = !this.sortReverse), this.draw()) },
        ],
      },
      {
        label: 'Filter',
        submenu: () => [
          { label: 'Filter Files', checked: !!this.categories, action: () => ((this.categories = this.categories ? null : new Set(['project', 'image', 'model', 'text'])), this.draw()) },
          { separator: true },
          ...CATEGORIES.map(([c, l, ic]) => ({
            label: l,
            icon: ic,
            checked: !this.categories || this.categories.has(c),
            disabled: !this.categories,
            keepOpen: true,
            action: () => {
              if (!this.categories) return;
              if (this.categories.has(c)) this.categories.delete(c);
              else this.categories.add(c);
              this.draw();
            },
          })),
        ],
      },
      { label: 'Show Hidden', shortcut: 'H', checked: this.showHidden, op: 'file.hidden_toggle' },
      { separator: true },
      { label: 'Sidebar', shortcut: 'T', checked: this.showSidebar, op: 'file.sidebar_toggle' },
      { separator: true },
      { label: 'Browse Assets', icon: 'asset_browser', action: () => this.area.setType('ASSETS') },
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

  contextMenu(): MenuItem[] {
    const one = this.selection();
    const first = one[0];
    const writable = !!this.dir?.removeEntry;
    return [
      { label: first?.kind === 'dir' ? 'Open Folder' : first && category(first.name) === 'model' ? 'Import' : 'Open', shortcut: 'Enter', disabled: !first, op: 'file.execute' },
      ...(one.length === 1 && first?.kind === 'file' && /\.(p3d|blend\d*)$/i.test(first.name) ? [{ label: 'Link…', icon: 'link', disabled: !app.poll('wm.link'), action: () => this.linkFrom(first, true) }, { label: 'Append…', icon: 'append_blend', disabled: !app.poll('wm.append'), action: () => this.linkFrom(first, false) }] : []),
      { separator: true },
      { label: 'Rename…', shortcut: 'F2', disabled: one.length !== 1 || !writable, op: 'file.rename' },
      { label: 'Delete', shortcut: 'X', disabled: !one.length || !writable, op: 'file.delete' },
      { label: 'New Folder', shortcut: 'I', disabled: !this.dir?.getDirectoryHandle, op: 'file.directory_new' },
      { label: 'Save Project Here…', icon: 'file_3d', disabled: !this.dir?.getDirectoryHandle, op: 'file.save_project_here' },
      { separator: true },
      { label: 'Add Bookmark', shortcut: 'Ctrl B', disabled: !this.dir, op: 'file.bookmark_add' },
      { label: 'Refresh', shortcut: 'R', disabled: !this.dir, op: 'file.refresh' },
      { separator: true },
      { label: 'Select All', shortcut: 'A', op: 'file.select_all', props: { action: 'SELECT' } },
    ];
  }

  /** Link or append data-blocks from a project file of this folder (opens the library browser in it). */
  private linkFrom(it: Item, link: boolean) {
    const path = [...this.path.map((d) => d.name || 'Browser Storage'), it.name].join('/');
    void import('../library/ops').then((m) => m.browseFile(link, { name: it.name, path, handle: it.handle as unknown as FileSystemFileHandle | undefined, file: it.file }));
  }

  setView(v: View) {
    this.view = v;
    if (v === 'LIST_VERTICAL' && this.items.some((i) => i.kind === 'file' && i.mtime === undefined)) void this.loadDetails();
    this.draw();
    this.area.drawHeader();
  }

  /** Column titles of the vertical list; clicking one sorts by it (again: reverses). */
  private columnHeader(): Child {
    const col = (by: SortBy, label: string, cls: string) =>
      h(
        'button',
        {
          key: `col-${by}`,
          class: { 'fb-col': true, [cls]: true, on: this.sortBy === by },
          'data-sort': by,
          'data-tip': `Sort by ${label}\nClick again to reverse the order`,
          onclick: () => app.run('file.sort_column_ui_context', { column: by }, { area: this.area }),
        },
        label,
        this.sortBy === by ? icon(this.sortReverse ? 'triangle_up' : 'triangle_down', 'tiny') : null,
      );
    return h('div', { key: 'fb-cols', class: 'fb-cols' }, col('ALPHA', 'Name', 'fb-col-name'), col('SIZE', 'Size', 'fb-col-size'), col('TIME', 'Date Modified', 'fb-col-date'));
  }

  /** Sort by a column: a new column sorts ascending, the current one flips the order. */
  sortColumn(by: SortBy) {
    if (this.sortBy === by) this.sortReverse = !this.sortReverse;
    else {
      this.sortReverse = false;
      this.setSort(by);
      return;
    }
    this.draw();
  }

  /** The item at a client point. */
  itemAt(x: number, y: number): Item | null {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.fb-item');
    if (!el || !this.main.contains(el)) return null;
    return this.shown().find((i) => i.name === el.dataset.name) ?? null;
  }

  /** Select the item at a client point (extend toggles, fill selects the range from the active one). */
  selectAt(x: number, y: number, o: { extend?: boolean; fill?: boolean; open?: boolean; deselectAll?: boolean }) {
    const it = this.itemAt(x, y);
    if (!it) {
      if (o.deselectAll) {
        this.selected.clear();
        this.draw();
      }
      return false;
    }
    this.click(it, { shiftKey: !!o.fill, ctrlKey: !!o.extend && !o.fill, metaKey: false } as MouseEvent);
    if (o.open) void this.activate(it);
    return true;
  }

  /** Open the item at a client point (double click). */
  executeAt(x: number, y: number) {
    const it = this.itemAt(x, y);
    if (!it) return false;
    this.selectOnly(it.name);
    void this.activate(it);
    return true;
  }

  setSort(s: SortBy) {
    this.sortBy = s;
    if ((s === 'TIME' || s === 'SIZE') && this.items.some((i) => i.kind === 'file' && i.mtime === undefined)) void this.loadDetails();
    this.draw();
  }

  update(kinds: Set<ChangeKind>) {
    if (kinds.has('ui')) this.draw();
  }

  dispose() {
    browsers.delete(this);
    for (const u of this.thumbs.values()) if (u) URL.revokeObjectURL(u);
  }

  // ---------------------------------------------------------------------
  // navigation

  async openFolder() {
    try {
      const dir = (await (window as unknown as { showDirectoryPicker: (o?: unknown) => Promise<DirHandle> }).showDirectoryPicker({ mode: 'read' })) as DirHandle;
      await this.openRoot(dir);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') app.report('ERROR', `Cannot open folder: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Browse a folder handle as a new root (also used for bookmarks and browser storage). */
  async openRoot(dir: DirHandle) {
    // the browser's own storage has an empty name and its own Places entry
    if (dir.name !== '') {
      let known = false;
      for (const r of roots) if (await sameEntry(r, dir)) known = true;
      if (!known) roots.push(dir);
      void rememberDir(dir);
    }
    await this.enter([dir]);
  }

  private pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      this.loose.push(...Array.from(input.files ?? []));
      this.path = [];
      this.items = this.loose.map((f) => ({ name: f.name, kind: 'file' as const, file: f, size: f.size, mtime: f.lastModified }));
      this.selected.clear();
      this.draw();
      this.area.drawHeader();
    };
    input.click();
  }

  async enter(path: DirHandle[], record = true) {
    if (record && this.path.length) {
      this.history.push(this.path);
      this.future = [];
    }
    const dir = path[path.length - 1];
    if (!(await ensurePermission(dir, 'read'))) {
      app.report('WARNING', `No permission to read "${dir.name}"`);
      return;
    }
    this.path = path;
    this.status = 'Reading folder…';
    this.draw();
    const items: Item[] = [];
    try {
      for await (const entry of dir.values()) items.push(entry.kind === 'directory' ? { name: entry.name, kind: 'dir', dir: entry } : { name: entry.name, kind: 'file', handle: entry as FileHandle });
    } catch (e) {
      app.report('ERROR', `Cannot read folder: ${e instanceof Error ? e.message : e}`);
    }
    this.items = items;
    this.status = '';
    this.selected.clear();
    this.active = null;
    this.draw();
    this.area.drawHeader();
    if (this.view === 'LIST_VERTICAL' || this.sortBy === 'TIME' || this.sortBy === 'SIZE') void this.loadDetails();
  }

  /** Read sizes and dates of the files in the folder (in the background). */
  private async loadDetails() {
    const items = this.items;
    const files = items.filter((i) => i.kind === 'file' && i.mtime === undefined).slice(0, 3000);
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(
        files.slice(i, i + 64).map(async (it) => {
          const f = await this.fileOf(it);
          if (f) ((it.size = f.size), (it.mtime = f.lastModified));
        }),
      );
      if (this.items !== items) return;
      this.draw();
    }
  }

  refresh() {
    if (this.path.length) void this.enter(this.path, false);
  }

  parent() {
    if (this.path.length > 1) void this.enter(this.path.slice(0, -1));
  }

  back() {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(this.path);
    void this.enter(prev, false);
  }

  forward() {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.path);
    void this.enter(next, false);
  }

  private async fileOf(it: Item): Promise<File | null> {
    if (it.file) return it.file;
    if (it.handle) {
      try {
        it.file = await it.handle.getFile();
        return it.file;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Double-click / Enter: open projects, import models, load images and texts, enter folders. */
  async activate(it: Item) {
    if (it.kind === 'dir' && it.dir) return this.enter([...this.path, it.dir]);
    const file = await this.fileOf(it);
    if (!file) return;
    if (!recentFiles.includes(file)) recentFiles.unshift(file);
    recentFiles.splice(12);
    const cat = category(file.name);
    if (cat === 'project') {
      await openFile(file, 'open');
      // a project opened from a writable folder is saved back in place
      const h = it.handle;
      if (h?.createWritable && app.filename === file.name && file.name.toLowerCase().endsWith('.p3d')) fileEvents.saveTarget = { name: file.name, write: (bytes) => writeFile(h, bytes) };
    }
    else if (cat === 'model') await openFile(file, 'import');
    else if (cat === 'image') {
      const img = await imageFromFile(file);
      app.doc.images[img.id] = img;
      app.pushUndo('Load Image');
      app.changed('doc');
      app.report('INFO', `Loaded image "${img.name}" (assign it in an Image Texture node or image field)`);
    } else if (cat === 'text') {
      const body = await file.text();
      const tx = newText(file.name, body, /\.py$/i.test(file.name) ? 'python' : /\.m?js$/i.test(file.name) ? 'javascript' : 'text');
      app.doc.texts[tx.id] = tx;
      app.pushUndo('Open Text');
      app.changed('doc');
      app.report('INFO', `Opened "${file.name}" as a text data-block`);
    } else app.report('WARNING', `"${file.name}" is not a supported file type`);
    this.draw();
  }

  /** Open the selected items (folders: the first one). */
  execute() {
    const sel = this.selection();
    const dir = sel.find((i) => i.kind === 'dir');
    if (dir) return void this.activate(dir);
    for (const it of sel) void this.activate(it);
  }

  // ---------------------------------------------------------------------
  // selection

  /** Items as shown (filtered and sorted). */
  shown(): Item[] {
    const list = filterEntries(this.items, { text: this.filter, showHidden: this.showHidden, categories: this.categories, modelExts: modelExts() });
    return sortEntries(list, this.sortBy, this.sortReverse);
  }

  selection(): Item[] {
    return this.shown().filter((i) => this.selected.has(i.name));
  }

  selectOnly(name: string) {
    this.selected = new Set([name]);
    this.active = name;
    this.draw();
  }

  private click(it: Item, e: MouseEvent) {
    const list = this.shown();
    if (e.shiftKey && this.active) {
      const a = list.findIndex((x) => x.name === this.active),
        b = list.findIndex((x) => x.name === it.name);
      if (!(e.ctrlKey || e.metaKey)) this.selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (list[i]) this.selected.add(list[i].name);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(it.name)) this.selected.delete(it.name);
      else this.selected.add(it.name);
      this.active = it.name;
    } else {
      this.selected = new Set([it.name]);
      this.active = it.name;
    }
    this.draw();
  }

  selectAll(action: 'SELECT' | 'DESELECT' | 'INVERT' | 'TOGGLE') {
    const list = this.shown();
    const any = list.some((i) => this.selected.has(i.name));
    const next = new Set<string>();
    for (const i of list) {
      const on = action === 'SELECT' ? true : action === 'DESELECT' ? false : action === 'INVERT' ? !this.selected.has(i.name) : !any;
      if (on) next.add(i.name);
    }
    this.selected = next;
    this.draw();
  }

  /** Arrow keys: move the active item (Shift extends, Ctrl+Shift fills the range). */
  walk(dir: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', extend: boolean, fill: boolean) {
    const list = this.shown();
    const els = [...this.main.querySelectorAll<HTMLElement>('.fb-item')];
    let cols = 1,
      rows = 1;
    if (els.length > 1) {
      const top = els[0].offsetTop,
        left = els[0].offsetLeft;
      cols = Math.max(1, els.findIndex((e) => e.offsetTop !== top));
      if (cols < 1 || els.every((e) => e.offsetTop === top)) cols = els.length;
      rows = Math.max(1, els.findIndex((e) => e.offsetLeft !== left));
      if (els.every((e) => e.offsetLeft === left)) rows = els.length;
    }
    const flow = this.view === 'LIST_HORIZONTAL' ? 'column' : 'row';
    const i = list.findIndex((x) => x.name === this.active);
    const j = walkIndex(i, list.length, dir, this.view === 'LIST_VERTICAL' ? 1 : cols, flow, rows);
    if (j < 0) return;
    const name = list[j].name;
    if (fill && i >= 0) for (let k = Math.min(i, j); k <= Math.max(i, j); k++) this.selected.add(list[k].name);
    else if (extend) this.selected.add(name);
    else this.selected = new Set([name]);
    this.active = name;
    this.draw();
    this.main.querySelector<HTMLElement>(`.fb-item[data-name="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** B: the next drag in the file list draws a selection box */
  boxPending = false;

  /** Scroll the active (or first selected) item into view. */
  viewSelected() {
    const name = this.active ?? this.selection()[0]?.name;
    if (name) this.main.querySelector<HTMLElement>(`.fb-item[data-name="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'center', inline: 'center' });
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
      // the click that follows the release must not reselect the item under the pointer
      const swallow = (ev: Event) => ev.stopPropagation();
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
      const x0 = Math.min(sx, e.clientX),
        x1 = Math.max(sx, e.clientX),
        y0 = Math.min(sy, e.clientY),
        y1 = Math.max(sy, e.clientY);
      if (mode === 'SET') this.selected.clear();
      for (const el of this.main.querySelectorAll<HTMLElement>('.fb-item')) {
        const r = el.getBoundingClientRect();
        if (r.right < x0 || r.left > x1 || r.bottom < y0 || r.top > y1) continue;
        const n = el.dataset.name!;
        if (mode === 'SUB') this.selected.delete(n);
        else this.selected.add(n);
      }
      this.draw();
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  }

  // ---------------------------------------------------------------------
  // file operations

  private async writable(): Promise<DirHandle | null> {
    const d = this.dir;
    if (!d?.getDirectoryHandle) return null;
    if (!(await ensurePermission(d, 'readwrite'))) {
      app.report('WARNING', `No permission to change "${d.name}"`);
      return null;
    }
    return d;
  }

  async newFolder(name?: string): Promise<string | null> {
    const d = await this.writable();
    if (!d) return null;
    const n = name ?? uniqueEntryName('New Folder', this.items.map((i) => i.name));
    try {
      await d.getDirectoryHandle!(n, { create: true });
    } catch (e) {
      app.report('ERROR', `Cannot create the folder: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    await this.enter(this.path, false);
    this.selectOnly(n);
    return n;
  }

  async deleteSelected(): Promise<number> {
    const d = await this.writable();
    const sel = this.selection();
    if (!d?.removeEntry || !sel.length) return 0;
    let n = 0;
    for (const it of sel) {
      try {
        await d.removeEntry(it.name, { recursive: true });
        n++;
      } catch (e) {
        app.report('ERROR', `Cannot delete "${it.name}": ${e instanceof Error ? e.message : e}`);
      }
    }
    await this.enter(this.path, false);
    if (n) app.report('INFO', `Deleted ${n} item${n === 1 ? '' : 's'}`);
    return n;
  }

  /** Rename a file or folder (files are copied when the handle cannot be moved). */
  async rename(it: Item, to: string): Promise<boolean> {
    const d = await this.writable();
    if (!d || !to || to === it.name) return false;
    if (/[/\\]/.test(to) || this.items.some((x) => x.name.toLowerCase() === to.toLowerCase() && x !== it)) {
      app.report('ERROR', `Cannot rename to "${to}": the name is invalid or taken`);
      return false;
    }
    try {
      const h = (it.kind === 'dir' ? it.dir : it.handle) as unknown as { move?: (n: string) => Promise<void> };
      if (h?.move) await h.move(to);
      else if (it.kind === 'file') {
        const f = await this.fileOf(it);
        const nh = await d.getFileHandle!(to, { create: true });
        const w = await nh.createWritable!();
        await w.write(f!);
        await w.close();
        await d.removeEntry!(it.name);
      } else {
        // no native move: copy the folder tree under the new name, then remove the old one
        await copyFolder(it.dir!, d, to);
        await d.removeEntry!(it.name, { recursive: true });
      }
    } catch (e) {
      app.report('ERROR', `Cannot rename "${it.name}": ${e instanceof Error ? e.message : e}`);
      return false;
    }
    await this.enter(this.path, false);
    this.selectOnly(to);
    return true;
  }

  promptRename() {
    const it = this.selection()[0];
    if (!it) return;
    promptText(`Rename ${it.kind === 'dir' ? 'Folder' : 'File'}`, it.name, (n) => n && void this.rename(it, n));
  }

  /** Save the current project into this folder (and keep saving there with Ctrl S). */
  async saveProjectHere(name = app.filename) {
    const d = await this.writable();
    if (!d) return false;
    if (!name.toLowerCase().endsWith('.p3d')) name = `${name.replace(/\.[^.]+$/, '')}.p3d`;
    try {
      const h = await d.getFileHandle!(name, { create: true });
      await writeFile(h, encodeDocument(app.doc, { ui: projectUiState.save() }));
      app.filename = name;
      app.dirty = false;
      fileEvents.saveTarget = { name, write: (bytes) => writeFile(h, bytes) };
      app.report('INFO', `Saved "${name}" in ${d.name || 'Browser Storage'}`);
    } catch (e) {
      app.report('ERROR', `Cannot save here: ${e instanceof Error ? e.message : e}`);
      return false;
    }
    await this.enter(this.path, false);
    this.selectOnly(name);
    return true;
  }

  async addBookmark() {
    const d = this.dir;
    if (!d) return;
    for (const b of bookmarks) if (await sameEntry(b.handle, d)) return app.report('INFO', `"${d.name}" is already bookmarked`);
    bookmarks.push({ name: d.name || 'Browser Storage', handle: d });
    saveBookmarks();
    redrawAll();
  }

  /** Go to a folder typed as a path ("textures/wood", "../other"); offers to create missing ones. */
  async goToPath(text: string) {
    if (!this.path.length) return false;
    const parts = text.split(/[\\/]+/).filter(Boolean);
    let path = [...this.path];
    // an absolute path starts with the root's name
    if (parts.length && parts[0] === (this.path[0].name || 'Browser Storage')) {
      path = [this.path[0]];
      parts.shift();
    }
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === '.') continue;
      if (p === '..') {
        if (path.length > 1) path.pop();
        continue;
      }
      const cur = path[path.length - 1];
      try {
        path.push(await cur.getDirectoryHandle!(p));
      } catch {
        const rest = parts.slice(i);
        openMenu([{ heading: `"${rest.join('/')}" does not exist` }, { label: 'Create New Directory', icon: 'newfolder', action: () => void this.createPath(path, rest) }], { x: app.pointer.x, y: app.pointer.y });
        return false;
      }
    }
    await this.enter(path);
    return true;
  }

  private async createPath(base: DirHandle[], parts: string[]) {
    if (!(await ensurePermission(base[base.length - 1], 'readwrite'))) return;
    const path = [...base];
    try {
      for (const p of parts) path.push(await path[path.length - 1].getDirectoryHandle!(p, { create: true }));
    } catch (e) {
      app.report('ERROR', `Cannot create the folder: ${e instanceof Error ? e.message : e}`);
      return;
    }
    await this.enter(path);
  }

  editPath() {
    const cur = this.path.map((d) => d.name || 'Browser Storage').join('/');
    promptText('Directory', cur, (v) => v && void this.goToPath(v));
  }

  startFilter() {
    this.focusFilter = true;
    this.area.drawHeader();
  }

  toggleHidden() {
    this.showHidden = !this.showHidden;
    this.draw();
  }

  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    this.draw();
  }

  viewPie() {
    openPie(
      'View',
      [
        { label: 'Vertical List', icon: 'listview', active: this.view === 'LIST_VERTICAL', action: () => this.setView('LIST_VERTICAL') },
        { label: 'Thumbnails', icon: 'imgdisplay', active: this.view === 'THUMBNAIL', action: () => this.setView('THUMBNAIL') },
        { label: 'Horizontal List', icon: 'hlistview', active: this.view === 'LIST_HORIZONTAL', action: () => this.setView('LIST_HORIZONTAL') },
        null,
        null,
        null,
        null,
        null,
      ],
      app.pointer.x,
      app.pointer.y,
      'Backquote',
    );
  }

  // ---------------------------------------------------------------------
  // drawing

  private thumb(it: Item) {
    const key = `${this.path.map((p) => p.name).join('/')}/${it.name}`;
    const url = this.thumbs.get(key);
    if (url) return url;
    if (this.view !== 'THUMBNAIL' || category(it.name) !== 'image') return null;
    if (this.thumbs.has(key)) return null;
    this.thumbs.set(key, '');
    void this.fileOf(it).then((f) => {
      if (!f) return;
      this.thumbs.set(key, URL.createObjectURL(f));
      this.draw();
    });
    return null;
  }

  private placeItem(p: Place, kind: 'bookmark' | 'recent'): Child {
    const on = this.path[0] === p.handle;
    return h(
      'button',
      {
        key: `${kind}:${p.name}:${bookmarks.indexOf(p)}:${recentDirs.indexOf(p)}`,
        class: { 'fb-side-item': true, on, active: kind === 'bookmark' && bookmarks.indexOf(p) === activeBookmark },
        'data-tip': p.name,
        onclick: () => {
          if (kind === 'bookmark') activeBookmark = bookmarks.indexOf(p);
          void this.openRoot(p.handle);
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(kind === 'bookmark' ? bookmarkMenu(p) : recentMenu(), { x: e.clientX, y: e.clientY });
        },
      },
      icon(kind === 'bookmark' ? 'bookmark' : 'file_folder'),
      h('span', null, p.name),
    );
  }

  draw() {
    this.el.classList.toggle('no-sidebar', !this.showSidebar);
    const side: Child[] = [
      h('div', { class: 'fb-side-title' }, 'Places'),
      opfs ? h('button', { key: 'opfs', class: { 'fb-side-item': true, on: this.path[0]?.name === '' }, 'data-tip': 'Browser Storage\nFiles kept by this browser for this site (always writable)', onclick: () => void this.openRoot(opfs!) }, icon('storage'), h('span', null, 'Browser Storage')) : null,
      ...roots.map((r) => h('button', { key: `root:${r.name}`, class: { 'fb-side-item': true, on: this.path[0] === r }, onclick: () => void this.enter([r]) }, icon('file_folder'), h('span', null, r.name))),
      supportsFolders ? h('button', { key: 'open', class: 'fb-side-item fb-add', onclick: () => void this.openFolder() }, icon('add'), h('span', null, 'Open Folder…')) : null,
      h('button', { key: 'add', class: 'fb-side-item fb-add', onclick: () => this.pickFiles() }, icon('add'), h('span', null, 'Add Files…')),
      h('div', { class: 'fb-side-title' }, 'Bookmarks'),
      bookmarks.length ? bookmarks.map((p) => this.placeItem(p, 'bookmark')) : h('div', { class: 'fb-empty-small' }, 'Ctrl B bookmarks a folder'),
      recentDirs.length ? h('div', { class: 'fb-side-title' }, 'Recent') : null,
      ...recentDirs.map((p) => this.placeItem(p, 'recent')),
      recentFiles.length ? h('div', { class: 'fb-side-title' }, 'Recent Files') : null,
      ...recentFiles.map((f, i) => h('button', { key: `rf${i}`, class: 'fb-side-item', 'data-tip': `${f.name}\nDouble-click to open again`, ondblclick: () => void this.activate({ name: f.name, kind: 'file', file: f }) }, icon(CAT_ICON[category(f.name)]), h('span', null, f.name))),
    ];
    patch(this.side, side);
    const shown = this.shown();
    let body: Child;
    if (!this.items.length && !this.status && !this.path.length)
      body = h(
        'div',
        { class: 'fb-empty' },
        h('p', null, supportsFolders ? 'Open a folder to browse your files, or use Browser Storage. Double-click a file to open a project, import a model, or load an image or text.' : 'Add files to browse them, or use Browser Storage. Double-click a file to open a project, import a model, or load an image or text.'),
        h('div', { class: 'fb-empty-actions' }, supportsFolders ? h('button', { class: 'btn', onclick: () => void this.openFolder() }, 'Open Folder…') : null, opfs ? h('button', { class: 'btn', onclick: () => void this.openRoot(opfs!) }, 'Browser Storage') : null, h('button', { class: 'btn', onclick: () => this.pickFiles() }, 'Add Files…')),
      );
    else {
      const cls = this.view === 'LIST_VERTICAL' ? 'list' : this.view === 'LIST_HORIZONTAL' ? 'hlist' : 'grid';
      body = h(
        'div',
        { class: `fb-items ${cls}`, role: 'listbox', 'aria-multiselectable': 'true', style: { '--fb-thumb': `${this.thumbSize}px` } },
        this.view === 'LIST_VERTICAL' && shown.length ? this.columnHeader() : null,
        this.status ? h('div', { class: 'fb-empty-small' }, this.status) : null,
        !this.status && !shown.length ? h('div', { class: 'fb-empty-small' }, this.items.length ? 'No files match the filter' : 'This folder is empty') : null,
        shown.map((it) => {
          const cat = it.kind === 'dir' ? null : category(it.name);
          const url = it.kind === 'file' ? this.thumb(it) : null;
          const sel = this.selected.has(it.name);
          return h(
            'div',
            {
              key: it.name,
              class: { 'fb-item': true, on: sel, active: this.active === it.name },
              'data-name': it.name,
              role: 'option',
              'aria-selected': sel ? 'true' : 'false',
              title: it.name,
              draggable: cat === 'image' ? 'true' : 'false',
              onclick: (e: MouseEvent) => this.click(it, e),
              ondblclick: () => void this.activate(it),
              ondragstart: (e: DragEvent) => {
                // dragging an image file into other editors (drop targets read text/uri-list or files)
                void this.fileOf(it);
                if (it.file) e.dataTransfer?.items.add(it.file);
                e.dataTransfer?.setData('text/plain', it.name);
              },
            },
            url ? h('img', { class: 'fb-thumb', src: url, alt: '' }) : h('div', { class: 'fb-icon' }, icon(it.kind === 'dir' ? 'file_folder' : CAT_ICON[cat!])),
            h('span', { class: 'fb-name' }, it.name),
            this.view === 'LIST_VERTICAL' ? h('span', { class: 'fb-size' }, it.kind === 'file' ? formatSize(it.size) : '') : null,
            this.view === 'LIST_VERTICAL' ? h('span', { class: 'fb-date' }, it.mtime ? formatDate(it.mtime) : '') : null,
          );
        }),
      );
    }
    patch(this.main, [body]);
  }
}

async function writeFile(h: FileHandle, bytes: Uint8Array) {
  const w = await h.createWritable!();
  await w.write(bytes as Uint8Array<ArrayBuffer>);
  await w.close();
}

/** Copy folder `src` (recursively) into `parent` as `name`. */
async function copyFolder(src: DirHandle, parent: DirHandle, name: string) {
  const dst = await parent.getDirectoryHandle!(name, { create: true });
  for await (const e of src.values()) {
    if (e.kind === 'directory') await copyFolder(e, dst, e.name);
    else {
      const f = await (e as FileHandle).getFile();
      const w = await (await dst.getFileHandle!(e.name, { create: true })).createWritable!();
      await w.write(f);
      await w.close();
    }
  }
}

/** Bookmark the bookmark operators act on (clicked last). */
let activeBookmark = -1;

function bookmarkMenu(p: Place): MenuItem[] {
  activeBookmark = bookmarks.indexOf(p);
  const i = activeBookmark;
  return [
    { label: 'Delete Bookmark', icon: 'x', op: 'file.bookmark_delete', props: { index: i } },
    { separator: true },
    { label: 'Move to Top', icon: 'tria_left_bar', op: 'file.bookmark_move', props: { direction: 'TOP' }, disabled: i === 0 },
    { label: 'Move Up', icon: 'triangle_up', op: 'file.bookmark_move', props: { direction: 'UP' }, disabled: i === 0 },
    { label: 'Move Down', icon: 'triangle_down', op: 'file.bookmark_move', props: { direction: 'DOWN' }, disabled: i === bookmarks.length - 1 },
    { label: 'Move to Bottom', icon: 'tria_right_bar', op: 'file.bookmark_move', props: { direction: 'BOTTOM' }, disabled: i === bookmarks.length - 1 },
    { separator: true },
    { label: 'Cleanup Bookmarks', op: 'file.bookmark_cleanup' },
  ];
}

function recentMenu(): MenuItem[] {
  return [{ label: 'Clear Recent Items', icon: 'trash', op: 'file.reset_recent' }];
}

// ---------------------------------------------------------------------------
// operators & keymap

const fbOf = (ctx: OpContext) => (ctx.area?.type === 'FILE_BROWSER' ? (ctx.area.editor as FileBrowser) : null);
const withDir = (ctx: OpContext) => !!fbOf(ctx)?.dir;
const DIRS: [string, string][] = [
  ['UP', 'Up'],
  ['DOWN', 'Down'],
  ['LEFT', 'Left'],
  ['RIGHT', 'Right'],
];

registerOperators([
  {
    idname: 'file.select_all',
    label: '(De)select All Files',
    description: 'Select or deselect all files',
    undo: false,
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: (ctx) => !!fbOf(ctx),
    exec: (ctx, p) => fbOf(ctx)!.selectAll(p.action as 'SELECT'),
  },
  {
    idname: 'file.select_walk',
    label: 'Walk Select',
    description: 'Move the selection with the arrow keys',
    undo: false,
    props: [
      { id: 'direction', label: 'Direction', type: 'enum', default: 'DOWN', items: DIRS },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'fill', label: 'Fill', type: 'bool', default: false },
    ],
    poll: (ctx) => !!fbOf(ctx),
    exec: (ctx, p) => fbOf(ctx)!.walk(p.direction as 'UP', !!p.extend, !!p.fill),
  },
  { idname: 'file.execute', label: 'Open Selected', description: 'Open the selected files or enter the selected folder', undo: false, poll: (ctx) => !!fbOf(ctx)?.selection().length, exec: (ctx) => fbOf(ctx)!.execute() },
  { idname: 'file.parent', label: 'Parent Directory', description: 'Go to the parent folder', undo: false, poll: (ctx) => (fbOf(ctx)?.path.length ?? 0) > 1, exec: (ctx) => fbOf(ctx)!.parent() },
  { idname: 'file.previous', label: 'Previous Folder', description: 'Go back to the previous folder', undo: false, poll: (ctx) => !!fbOf(ctx), exec: (ctx) => fbOf(ctx)!.back() },
  { idname: 'file.next', label: 'Next Folder', description: 'Go forward to the next folder', undo: false, poll: (ctx) => !!fbOf(ctx), exec: (ctx) => fbOf(ctx)!.forward() },
  { idname: 'file.refresh', label: 'Refresh File List', description: 'Read the folder again', undo: false, poll: withDir, exec: (ctx) => fbOf(ctx)!.refresh() },
  {
    idname: 'file.directory_new',
    label: 'Create New Directory',
    description: 'Create a folder in the current folder',
    undo: false,
    props: [{ id: 'directory', label: 'Name', type: 'string', default: '' }],
    poll: (ctx) => !!fbOf(ctx)?.dir?.getDirectoryHandle,
    exec: (ctx, p) => void fbOf(ctx)!.newFolder(String(p.directory || '') || undefined),
  },
  {
    idname: 'file.rename',
    label: 'Rename File or Folder',
    description: 'Rename the selected file or folder',
    undo: false,
    props: [{ id: 'new_name', label: 'New Name', type: 'string', default: '' }],
    poll: (ctx) => !!fbOf(ctx)?.dir?.removeEntry && fbOf(ctx)!.selection().length === 1,
    exec: (ctx, p) => {
      const fb = fbOf(ctx)!;
      if (!p.new_name) return void fb.promptRename();
      void fb.rename(fb.selection()[0], String(p.new_name));
    },
  },
  {
    idname: 'file.delete',
    label: 'Delete Selected Files',
    description: 'Delete the selected files and folders from disk',
    undo: false,
    props: [{ id: 'confirm', label: 'Confirm', type: 'bool', default: true, hidden: true }],
    poll: (ctx) => !!fbOf(ctx)?.dir?.removeEntry && fbOf(ctx)!.selection().length > 0,
    exec: (ctx, p) => {
      const fb = fbOf(ctx)!;
      const n = fb.selection().length;
      if (p.confirm) {
        openMenu([{ heading: `Delete ${n} item${n === 1 ? '' : 's'} from disk?` }, { label: 'Delete', icon: 'trash', action: () => app.run('file.delete', { confirm: false }, { area: ctx.area }) }], { x: app.pointer.x, y: app.pointer.y });
        return 'CANCELLED';
      }
      void fb.deleteSelected();
    },
  },
  {
    idname: 'file.save_project_here',
    label: 'Save Project Here',
    description: 'Save the project into the folder shown in the File Browser; Save then keeps updating that file',
    undo: false,
    props: [{ id: 'filename', label: 'File Name', type: 'string', default: '' }],
    poll: (ctx) => !!fbOf(ctx)?.dir?.getDirectoryHandle,
    invoke: (ctx, p) => {
      const fb = fbOf(ctx)!;
      if (p.filename) return void fb.saveProjectHere(String(p.filename));
      promptText('Save Project Here', app.filename, (n) => n && void fb.saveProjectHere(n));
      return 'CANCELLED';
    },
    exec: (ctx, p) => void fbOf(ctx)!.saveProjectHere(String(p.filename || '') || undefined),
  },
  {
    idname: 'file.bookmark_delete',
    label: 'Delete Bookmark',
    description: 'Remove a bookmark (index -1: the active one)',
    undo: false,
    props: [{ id: 'index', label: 'Index', type: 'int', default: -1, min: -1 }],
    poll: () => bookmarks.length > 0,
    exec: (_ctx, p) => {
      const i = Number(p.index) >= 0 ? Number(p.index) : activeBookmark;
      if (i < 0 || i >= bookmarks.length) return 'CANCELLED';
      bookmarks.splice(i, 1);
      activeBookmark = Math.min(activeBookmark, bookmarks.length - 1);
      saveBookmarks();
      redrawAll();
    },
  },
  {
    idname: 'file.bookmark_move',
    label: 'Move Bookmark',
    description: 'Move the active bookmark up, down, to the top or to the bottom of the list',
    undo: false,
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'UP', items: [['TOP', 'Top', 'Top of the list'], ['UP', 'Up'], ['DOWN', 'Down'], ['BOTTOM', 'Bottom', 'Bottom of the list']] }],
    poll: () => activeBookmark >= 0 && activeBookmark < bookmarks.length,
    exec: (_ctx, p) => {
      activeBookmark = moveInList(bookmarks, activeBookmark, p.direction as 'UP');
      saveBookmarks();
      redrawAll();
    },
  },
  {
    idname: 'file.bookmark_cleanup',
    label: 'Cleanup Bookmarks',
    description: 'Remove bookmarks of folders that are gone or bookmarked twice',
    undo: false,
    poll: () => bookmarks.length > 0,
    exec: () => {
      void (async () => {
        const keep: Place[] = [];
        for (const b of bookmarks) {
          let dup = false;
          for (const k of keep) if (await sameEntry(k.handle, b.handle)) dup = true;
          let gone = false;
          try {
            // a folder that was deleted fails to list
            const it = b.handle.values()[Symbol.asyncIterator]();
            await it.next();
          } catch (e) {
            gone = (e as Error)?.name === 'NotFoundError';
          }
          if (!dup && !gone) keep.push(b);
        }
        const n = bookmarks.length - keep.length;
        bookmarks = keep;
        activeBookmark = Math.min(activeBookmark, bookmarks.length - 1);
        saveBookmarks();
        redrawAll();
        app.report('INFO', n ? `Removed ${n} bookmark${n === 1 ? '' : 's'}` : 'All bookmarks are valid');
      })();
    },
  },
  {
    idname: 'file.select_bookmark',
    label: 'Select Directory',
    description: 'Go to a bookmarked or recent folder by name',
    undo: false,
    props: [{ id: 'dir', label: 'Directory', type: 'string', default: '' }],
    poll: (ctx) => !!fbOf(ctx),
    exec: (ctx, p) => {
      const name = String(p.dir);
      const place = bookmarks.find((b) => b.name === name) ?? recentDirs.find((b) => b.name === name);
      const root = place?.handle ?? roots.find((r) => r.name === name) ?? (name === 'Browser Storage' ? opfs : null);
      if (!root) {
        app.report('WARNING', `No bookmark named "${name}"`);
        return 'CANCELLED';
      }
      if (place && bookmarks.includes(place)) activeBookmark = bookmarks.indexOf(place);
      void fbOf(ctx)!.openRoot(root);
    },
  },
  { idname: 'file.hidedot', label: 'Toggle Hide Dot Files', description: 'Show or hide files and folders whose name starts with a dot', undo: false, poll: (ctx) => !!fbOf(ctx), exec: (ctx) => fbOf(ctx)!.toggleHidden() },
  {
    idname: 'file.sort_column_ui_context',
    label: 'Sort from Column',
    description: 'Sort the files by a column of the list; the current column reverses the order',
    undo: false,
    props: [{ id: 'column', label: 'Column', type: 'enum', default: 'ALPHA', items: [['ALPHA', 'Name'], ['EXTENSION', 'Extension'], ['TIME', 'Modified Date'], ['SIZE', 'Size']] }],
    poll: (ctx) => !!fbOf(ctx),
    exec: (ctx, p) => fbOf(ctx)!.sortColumn(p.column as SortBy),
  },
  {
    idname: 'file.select',
    label: 'Select',
    description: 'Select the file under the pointer (extend toggles, fill selects a range, open opens it)',
    undo: false,
    props: [
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'fill', label: 'Fill', type: 'bool', default: false },
      { id: 'open', label: 'Open', type: 'bool', default: true },
      { id: 'deselect_all', label: 'Deselect On Nothing', type: 'bool', default: false },
      { id: 'mouse_x', label: 'Mouse X', type: 'int', default: 0, hidden: true },
      { id: 'mouse_y', label: 'Mouse Y', type: 'int', default: 0, hidden: true },
    ],
    poll: (ctx) => !!fbOf(ctx),
    exec: (ctx, p) => {
      const pt = p.mouse_x || p.mouse_y ? { x: Number(p.mouse_x), y: Number(p.mouse_y) } : (ctx.event ?? app.pointer);
      return fbOf(ctx)!.selectAt(pt.x, pt.y, { extend: !!p.extend, fill: !!p.fill, open: !!p.open, deselectAll: !!p.deselect_all }) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'file.mouse_execute',
    label: 'Execute File',
    description: 'Open the file under the pointer (or enter the folder)',
    undo: false,
    poll: (ctx) => !!fbOf(ctx),
    exec: (ctx) => {
      const pt = ctx.event ?? app.pointer;
      return fbOf(ctx)!.executeAt(pt.x, pt.y) ? 'FINISHED' : 'CANCELLED';
    },
  },
  { idname: 'file.bookmark_add', label: 'Add Bookmark', description: 'Bookmark the current folder', undo: false, poll: withDir, exec: (ctx) => void fbOf(ctx)!.addBookmark() },
  {
    idname: 'file.reset_recent',
    label: 'Clear Recent Items',
    description: 'Forget the recently visited folders',
    undo: false,
    exec: () => {
      recentDirs = [];
      recentFiles.length = 0;
      void kvSet('fb-recent', recentDirs).catch(() => {});
      redrawAll();
    },
  },
  { idname: 'file.edit_directory_path', label: 'Edit Directory Path', description: 'Type the folder to go to (relative paths and .. work)', undo: false, poll: withDir, exec: (ctx) => fbOf(ctx)!.editPath() },
  { idname: 'file.select_box', label: 'Box Select', description: 'Drag a box over files to select them (Shift adds, Ctrl removes)', undo: false, poll: (ctx) => !!fbOf(ctx), exec: (ctx) => void (fbOf(ctx)!.boxPending = true) },
  { idname: 'file.view_selected', label: 'Frame Selected', description: 'Scroll the selected file into view', undo: false, poll: (ctx) => !!fbOf(ctx)?.selection().length, exec: (ctx) => fbOf(ctx)!.viewSelected() },
  { idname: 'file.start_filter', label: 'Filter', description: 'Type to filter the files', undo: false, poll: (ctx) => !!fbOf(ctx), exec: (ctx) => fbOf(ctx)!.startFilter() },
  { idname: 'file.hidden_toggle', label: 'Show Hidden', description: 'Show files and folders whose name starts with a dot', undo: false, poll: (ctx) => !!fbOf(ctx), exec: (ctx) => fbOf(ctx)!.toggleHidden() },
  { idname: 'file.sidebar_toggle', label: 'Toggle Sidebar', description: 'Show or hide the places sidebar', undo: false, poll: (ctx) => !!fbOf(ctx), exec: (ctx) => fbOf(ctx)!.toggleSidebar() },
  { idname: 'file.view_pie', label: 'View Pie', description: 'Pick the display mode', undo: false, internal: true, poll: (ctx) => !!fbOf(ctx), exec: (ctx) => fbOf(ctx)!.viewPie() },
  {
    idname: 'file.context_menu',
    label: 'File Context Menu',
    undo: false,
    internal: true,
    poll: (ctx) => !!fbOf(ctx),
    exec: (ctx) => void openMenu(fbOf(ctx)!.contextMenu(), { x: app.pointer.x, y: app.pointer.y }, { title: 'Files' }),
  },
]);

addKeys('File Browser', [
  ...DIRS.flatMap(([d]) => [
    { key: `${d}_ARROW`, op: 'file.select_walk', props: { direction: d } },
    { key: `${d}_ARROW`, shift: true, op: 'file.select_walk', props: { direction: d, extend: true } },
    { key: `${d}_ARROW`, shift: true, ctrl: true, op: 'file.select_walk', props: { direction: d, extend: true, fill: true } },
  ]),
  { key: 'RET', op: 'file.execute' },
  { key: 'NUMPAD_ENTER', op: 'file.execute' },
  { key: 'A', op: 'file.select_all', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'file.select_all', props: { action: 'DESELECT' } },
  { key: 'I', ctrl: true, op: 'file.select_all', props: { action: 'INVERT' } },
  { key: 'UP_ARROW', alt: true, op: 'file.parent' },
  { key: 'P', op: 'file.parent' },
  { key: 'LEFT_ARROW', alt: true, op: 'file.previous' },
  { key: 'RIGHT_ARROW', alt: true, op: 'file.next' },
  { key: 'BACK_SPACE', op: 'file.previous' },
  { key: 'BACK_SPACE', shift: true, op: 'file.next' },
  { key: 'R', op: 'file.refresh' },
  { key: 'H', op: 'file.hidden_toggle' },
  { key: 'I', op: 'file.directory_new' },
  { key: 'F2', op: 'file.rename' },
  { key: 'X', op: 'file.delete' },
  { key: 'DEL', op: 'file.delete' },
  { key: 'B', ctrl: true, op: 'file.bookmark_add' },
  { key: 'F', ctrl: true, op: 'file.start_filter' },
  { key: 'L', ctrl: true, op: 'file.edit_directory_path' },
  { key: 'B', op: 'file.select_box' },
  { key: 'NUMPAD_PERIOD', op: 'file.view_selected' },
  { key: 'T', op: 'file.sidebar_toggle' },
  { key: 'ACCENT_GRAVE', op: 'file.view_pie' },
  { key: 'W', op: 'file.context_menu' },
]);

registerEditor({ id: 'FILE_BROWSER', label: 'File Browser', icon: 'filebrowser', group: 'Data', create: (a, s) => new FileBrowser(a, s) });
