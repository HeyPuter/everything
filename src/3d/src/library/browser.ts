// Library browser (File ▸ Link… / Append…, relocating libraries and linked data-blocks): a file
// browser over the places project files can come from (Open Recent, this project's libraries,
// Browser Storage, folders opened in the File Browser, a file picked from the computer) that also
// opens project files like folders: a file lists its data-block types, a type lists its
// data-blocks. Several data-blocks (also of different types) can be picked at once.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { checkbox, textField } from '../ui/widgets';
import { openDialog, closeDialog, type DialogHandle } from '../scripting/dialog';
import { recentFiles, recentBytes, kvGet } from '../io/session';
import { pickFile } from '../io/native';
import type { DocumentData, ID } from '../data/types';
import { idTables, tablesOf, libraries, isLinked, linkedId } from './core';
import { rememberFile, listStored, latestBytes, type StoredLibrary } from './store';
import { sourceDoc, formatOf, isLibraryFile } from './runtime';
import type { LibraryData } from './types';
import './icons';
import './library.css';

export type BrowseMode = 'LINK' | 'APPEND' | 'RELOCATE' | 'ID_RELOCATE';

/** Labels and icons of data-block types (tables) inside a library file. */
export const TYPE_INFO: Record<string, [label: string, icon: string]> = {
  actions: ['Actions', 'action'],
  armatures: ['Armatures', 'armature_data'],
  brushes: ['Brushes', 'brush'],
  cameras: ['Cameras', 'camera_data'],
  collections: ['Collections', 'collection'],
  curves: ['Curves', 'curve_data'],
  fonts: ['Fonts', 'font_data'],
  grease_pencils: ['Grease Pencil', 'outliner_data_greasepencil'],
  hair_curves: ['Hair Curves', 'curves_data'],
  images: ['Images', 'image'],
  lattices: ['Lattices', 'outliner_ob_lattice'],
  lights: ['Lights', 'light_data'],
  materials: ['Materials', 'material'],
  meshes: ['Meshes', 'mesh_data'],
  metaballs: ['Metaballs', 'outliner_ob_meta'],
  node_groups: ['Node Groups', 'node_tree'],
  objects: ['Objects', 'object'],
  particles: ['Particle Settings', 'particles'],
  texts: ['Texts', 'text'],
  worlds: ['Worlds', 'world'],
};
export const typeLabel = (t: string) => TYPE_INFO[t]?.[0] ?? t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const typeIcon = (t: string) => TYPE_INFO[t]?.[1] ?? 'file';

interface DirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirHandle | (FileSystemFileHandle & { kind: 'file' })>;
}

/** A library file the browser can open. */
export interface FileRef {
  name: string;
  path: string;
  recentName?: string;
  handle?: FileSystemFileHandle;
  /** a file picked from the computer */
  file?: File;
  /** already stored (a library of this project, or one used before) */
  key?: string;
}

type Loc =
  | { kind: 'recent' }
  | { kind: 'libraries' }
  | { kind: 'dir'; dirs: DirHandle[] }
  | { kind: 'file'; ref: FileRef }
  | { kind: 'category'; ref: FileRef; table: string };

interface Entry {
  key: string;
  kind: 'dir' | 'file' | 'category' | 'item';
  name: string;
  icon: string;
  detail?: string;
  dir?: DirHandle;
  ref?: FileRef;
  table?: string;
  /** this project links the data-block already */
  linked?: boolean;
}

/** What the browser hands back when it is confirmed. */
export interface BrowseResult {
  entry: StoredLibrary;
  doc: DocumentData;
  /** picked data-blocks as table/name */
  items: { table: string; name: string }[];
  options: Record<string, boolean>;
}

export interface BrowseOptions {
  mode: BrowseMode;
  title?: string;
  /** confirm button label */
  confirm?: string;
  /** only data-blocks of this table can be picked (relocating a linked data-block) */
  table?: string;
  /** option checkboxes shown on the side: [key, label, tip] with their starting values */
  options?: [string, string, string][];
  values?: Record<string, boolean>;
  done: (r: BrowseResult) => void;
}

const DIALOG = 'library-browser';
const sep = '\u0000';

let opfsRoot: DirHandle | null | undefined;
async function browserStorage(): Promise<DirHandle | null> {
  if (opfsRoot !== undefined) return opfsRoot;
  try {
    opfsRoot = ((await navigator.storage?.getDirectory?.()) as unknown as DirHandle) ?? null;
  } catch {
    opfsRoot = null;
  }
  return opfsRoot;
}

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

class LibraryBrowser {
  stack: Loc[] = [];
  entries: Entry[] = [];
  sel = new Set<string>();
  anchor: string | null = null;
  filter = '';
  status = '';
  /** the opened file (file and category levels) */
  open: { ref: FileRef; entry: StoredLibrary; doc: DocumentData } | null = null;
  /** picked data-blocks across types: table + sep + name */
  picks = new Set<string>();
  values: Record<string, boolean>;
  places: { label: string; icon: string; loc: () => Promise<Loc | null>; tip: string }[] = [];
  dlg!: DialogHandle;
  private token = 0;

  constructor(public o: BrowseOptions) {
    this.values = { ...(o.values ?? {}) };
  }

  get loc(): Loc | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  redraw() {
    this.dlg?.redraw();
  }

  async init(start?: Loc) {
    const opfs = await browserStorage();
    const bookmarks = ((await kvGet<{ name: string; handle: DirHandle }[]>('fb-bookmarks')) ?? []).filter((p) => p?.handle);
    const folders = ((await kvGet<{ name: string; handle: DirHandle }[]>('fb-recent')) ?? []).filter((p) => p?.handle);
    this.places = [
      { label: 'Recent Projects', icon: 'file_3d', tip: 'Projects you opened or saved recently (linked files update when you save them again)', loc: async () => ({ kind: 'recent' }) },
      { label: 'Linked Libraries', icon: 'libraries', tip: 'Files this project links from, and files you linked from before', loc: async () => ({ kind: 'libraries' }) },
      ...(opfs ? [{ label: 'Browser Storage', icon: 'storage', tip: 'Files kept by this browser for this site', loc: async () => ({ kind: 'dir' as const, dirs: [opfs] }) }] : []),
      ...[...bookmarks, ...folders.filter((f) => !bookmarks.some((b) => b.name === f.name))].slice(0, 8).map((p) => ({
        label: p.name,
        icon: 'file_folder',
        tip: `Folder "${p.name}" (opened in the File Browser)`,
        loc: async () => {
          const h2 = p.handle as DirHandle & { queryPermission?(o: object): Promise<string>; requestPermission?(o: object): Promise<string> };
          try {
            if ((await h2.queryPermission?.({ mode: 'read' })) !== 'granted' && (await h2.requestPermission?.({ mode: 'read' })) !== 'granted') return null;
          } catch {
            return null;
          }
          return { kind: 'dir' as const, dirs: [p.handle] };
        },
      })),
    ];
    const libs = Object.values(libraries(app.doc));
    await this.go(start ?? (libs.length && this.o.mode !== 'APPEND' ? { kind: 'libraries' } : { kind: 'recent' }), true);
  }

  // ---------------------------------------------------------------------------
  // navigation

  async go(loc: Loc, reset = false) {
    if (reset) this.stack = [];
    this.stack.push(loc);
    await this.load();
  }

  async up() {
    if (this.stack.length < 2) return;
    this.stack.pop();
    await this.load();
  }

  async jump(i: number) {
    this.stack.length = i + 1;
    await this.load();
  }

  private async load() {
    const loc = this.loc;
    const t = ++this.token;
    this.sel.clear();
    this.anchor = null;
    this.filter = '';
    this.status = 'Reading…';
    this.redraw();
    let entries: Entry[] = [];
    try {
      entries = loc ? await this.read(loc) : [];
      this.status = '';
    } catch (e) {
      this.status = e instanceof Error ? e.message : String(e);
    }
    if (t !== this.token) return;
    this.entries = entries;
    if (loc?.kind === 'category') for (const e of entries) if (this.picks.has(`${loc.table}${sep}${e.name}`)) this.sel.add(e.key);
    this.redraw();
  }

  private async read(loc: Loc): Promise<Entry[]> {
    switch (loc.kind) {
      case 'recent':
        return recentFiles()
          .filter((r) => isLibraryFile(r.name))
          .map((r) => ({ key: `r:${r.name}`, kind: 'file' as const, name: r.name, icon: 'file_3d', detail: ago(r.time), ref: { name: r.name, path: `Recent/${r.name}`, recentName: r.name } }));
      case 'libraries': {
        const own = Object.values(libraries(app.doc));
        const stored = await listStored();
        const out: Entry[] = own.map((l) => ({ key: `l:${l.id}`, kind: 'file' as const, name: l.name, icon: l.is_missing ? 'library_data_broken' : 'library_data_direct', detail: 'linked by this project', ref: { name: l.name, path: l.filepath, key: l.source.key } }));
        for (const s of stored) if (!own.some((l) => l.source.key === s.key)) out.push({ key: `s:${s.key}`, kind: 'file', name: s.name, icon: 'file_3d', detail: `used ${ago(s.time)}`, ref: { name: s.name, path: s.path, key: s.key, recentName: s.recentName, handle: s.handle } });
        return out;
      }
      case 'dir': {
        const dir = loc.dirs[loc.dirs.length - 1];
        const out: Entry[] = [];
        for await (const e of dir.values()) {
          if (e.name.startsWith('.')) continue;
          if (e.kind === 'directory') out.push({ key: `d:${e.name}`, kind: 'dir', name: e.name, icon: 'file_folder', dir: e as DirHandle });
          else if (isLibraryFile(e.name)) out.push({ key: `f:${e.name}`, kind: 'file', name: e.name, icon: formatOf(e.name) === 'blend' ? 'file_blend' : 'file_3d', ref: { name: e.name, path: [...loc.dirs.map((d) => d.name || 'Browser Storage'), e.name].join('/'), handle: e as FileSystemFileHandle } });
        }
        return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1));
      }
      case 'file': {
        const { doc } = await this.openFile(loc.ref);
        const master = doc.scene.collection;
        const t = tablesOf(doc);
        return idTables(doc)
          .map((table) => [table, Object.values(t[table] ?? {}).filter((x) => x.id !== master).length] as const)
          .filter(([table, n]) => n > 0 && (!this.o.table || table === this.o.table))
          .sort((a, b) => (a[0] === 'objects' ? -1 : b[0] === 'objects' ? 1 : a[0] === 'collections' ? -1 : b[0] === 'collections' ? 1 : typeLabel(a[0]).localeCompare(typeLabel(b[0]))))
          .map(([table, n]) => ({ key: `c:${table}`, kind: 'category' as const, name: typeLabel(table), icon: typeIcon(table), detail: String(n), table }));
      }
      case 'category': {
        const { doc, entry } = await this.openFile(loc.ref);
        const master = doc.scene.collection;
        const lib = Object.values(libraries(app.doc)).find((l) => l.source.key === entry.key);
        const mine = tablesOf(app.doc)[loc.table] ?? {};
        return Object.values(tablesOf(doc)[loc.table] ?? {})
          .filter((x) => x.id !== master && !isLinked(x))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          .map((x) => ({ key: `i:${x.id}`, kind: 'item' as const, name: x.name, icon: typeIcon(loc.table), table: loc.table, linked: !!lib && !!mine[linkedId(lib.id, x.id)] }));
      }
    }
  }

  /** Read, store and decode a library file (once per browser session). */
  private async openFile(ref: FileRef): Promise<{ entry: StoredLibrary; doc: DocumentData }> {
    if (this.open && this.open.ref.path === ref.path && this.open.ref.name === ref.name) return this.open;
    let entry: StoredLibrary | null = null;
    if (ref.key) entry = (await latestBytes(ref.key, true))?.entry ?? null;
    if (!entry) {
      let bytes: Uint8Array | null = null;
      if (ref.recentName) bytes = await recentBytes(ref.recentName);
      else if (ref.handle) bytes = new Uint8Array(await (await ref.handle.getFile()).arrayBuffer());
      else if (ref.file) bytes = new Uint8Array(await ref.file.arrayBuffer());
      if (!bytes) {
        const lib = Object.values(libraries(app.doc)).find((l) => l.source.key === ref.key);
        if (lib?.packed_file?.length) bytes = lib.packed_file;
      }
      if (!bytes) throw new Error(`"${ref.name}" is not available in this browser`);
      entry = await rememberFile(ref.name, bytes, { recentName: ref.recentName, handle: ref.handle, path: ref.path });
    }
    const doc = await sourceDoc(entry.key, entry.bytes, formatOf(ref.name), entry);
    this.open = { ref, entry, doc };
    return this.open;
  }

  async chooseFile() {
    const file = await pickFile('.p3d,.blend');
    if (!file) return;
    if (!isLibraryFile(file.name)) {
      app.report('WARNING', `"${file.name}" is not a project file`);
      return;
    }
    await this.go({ kind: 'file', ref: { name: file.name, path: file.name, file } }, true);
  }

  // ---------------------------------------------------------------------------
  // selection and confirming

  private visible(): Entry[] {
    const f = this.filter.trim().toLowerCase();
    return f ? this.entries.filter((e) => e.name.toLowerCase().includes(f)) : this.entries;
  }

  private syncPicks() {
    const loc = this.loc;
    if (loc?.kind !== 'category') return;
    for (const e of this.entries) {
      const k = `${loc.table}${sep}${e.name}`;
      if (this.sel.has(e.key)) this.picks.add(k);
      else this.picks.delete(k);
    }
  }

  click(e: Entry, ev: MouseEvent) {
    const list = this.visible();
    const single = this.o.mode === 'ID_RELOCATE' || e.kind !== 'item';
    if (ev.shiftKey && this.anchor && !single) {
      const a = list.findIndex((x) => x.key === this.anchor),
        b = list.indexOf(e);
      if (!(ev.ctrlKey || ev.metaKey)) this.sel.clear();
      for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) this.sel.add(x.key);
    } else if ((ev.ctrlKey || ev.metaKey) && !single) {
      if (this.sel.has(e.key)) this.sel.delete(e.key);
      else this.sel.add(e.key);
      this.anchor = e.key;
    } else {
      if (e.kind === 'item' && this.o.mode !== 'ID_RELOCATE' && this.sel.size === 1 && this.sel.has(e.key)) this.sel.clear();
      else {
        this.sel.clear();
        this.sel.add(e.key);
      }
      this.anchor = e.key;
    }
    this.syncPicks();
    this.redraw();
  }

  async activate(e: Entry) {
    if (e.kind === 'dir' && e.dir && this.loc?.kind === 'dir') await this.go({ kind: 'dir', dirs: [...this.loc.dirs, e.dir] });
    else if (e.kind === 'file' && e.ref) {
      if (this.o.mode === 'RELOCATE') {
        this.sel = new Set([e.key]);
        await this.confirm();
      } else await this.go({ kind: 'file', ref: e.ref });
    } else if (e.kind === 'category' && e.table && this.loc?.kind === 'file') await this.go({ kind: 'category', ref: this.loc.ref, table: e.table });
    else if (e.kind === 'item') {
      this.sel.add(e.key);
      this.syncPicks();
      await this.confirm();
    }
  }

  pickedItems(): { table: string; name: string }[] {
    return [...this.picks].map((k) => {
      const [table, name] = k.split(sep);
      return { table, name };
    });
  }

  canConfirm(): boolean {
    if (this.o.mode === 'RELOCATE') return (this.loc?.kind === 'file' && !!this.open) || [...this.sel].some((k) => this.entries.find((e) => e.key === k)?.kind === 'file');
    return this.picks.size > 0;
  }

  async confirm() {
    if (!this.canConfirm()) return;
    try {
      if (this.o.mode === 'RELOCATE' && this.loc?.kind !== 'file') {
        const e = this.entries.find((x) => this.sel.has(x.key) && x.kind === 'file');
        if (!e?.ref) return;
        await this.openFile(e.ref);
      }
      const open = this.open!;
      const r: BrowseResult = { entry: open.entry, doc: open.doc, items: this.pickedItems(), options: { ...this.values } };
      closeDialog(DIALOG);
      this.o.done(r);
    } catch (err) {
      this.status = err instanceof Error ? err.message : String(err);
      this.redraw();
    }
  }

  // ---------------------------------------------------------------------------
  // drawing

  private crumbs(): Child {
    const parts: { label: string; i: number }[] = [];
    this.stack.forEach((l, i) => {
      if (l.kind === 'recent') parts.push({ label: 'Recent Projects', i });
      else if (l.kind === 'libraries') parts.push({ label: 'Linked Libraries', i });
      else if (l.kind === 'dir') parts.push({ label: l.dirs[l.dirs.length - 1].name || 'Browser Storage', i });
      else if (l.kind === 'file') parts.push({ label: l.ref.name, i });
      else parts.push({ label: typeLabel(l.table), i });
    });
    return h(
      'div',
      { class: 'lb-crumbs' },
      parts.map((p, k) => [k ? h('span', { class: 'lb-crumb-sep', key: `s${k}` }, '›') : null, h('button', { key: `c${k}`, class: { 'lb-crumb': true, on: k === parts.length - 1 }, onclick: () => void this.jump(p.i) }, p.label)]),
    );
  }

  private side(): Child {
    const cur = this.stack[0];
    const curLabel = cur?.kind === 'recent' ? 'Recent Projects' : cur?.kind === 'libraries' ? 'Linked Libraries' : cur?.kind === 'dir' ? cur.dirs[0].name || 'Browser Storage' : '';
    return h(
      'div',
      { class: 'fb-side lb-side' },
      h('div', { class: 'fb-side-title' }, 'Places'),
      this.places.map((p) =>
        h(
          'button',
          {
            key: p.label,
            class: { 'fb-side-item': true, on: p.label === curLabel },
            'data-tip': p.tip,
            onclick: async () => {
              const loc = await p.loc();
              if (loc) await this.go(loc, true);
              else app.report('WARNING', `No access to "${p.label}"`);
            },
          },
          icon(p.icon),
          h('span', null, p.label),
        ),
      ),
      h('button', { key: 'pick', class: 'fb-side-item fb-add', 'data-tip': 'Choose a project file (.p3d or .blend) from your computer', onclick: () => void this.chooseFile() }, icon('file_folder'), h('span', null, 'Choose File…')),
    );
  }

  private list(): Child {
    const list = this.visible();
    const loc = this.loc;
    if (!list.length)
      return h(
        'div',
        { class: 'lb-empty' },
        this.status ||
          (loc?.kind === 'recent'
            ? 'No recent projects yet. Projects you open or save appear here; use Choose File… to link from a file on your computer.'
            : loc?.kind === 'libraries'
              ? 'This project does not link any files yet.'
              : loc?.kind === 'dir'
                ? 'No project files in this folder.'
                : 'Nothing to show.'),
      );
    return h(
      'div',
      { class: 'lb-list', role: 'listbox', 'aria-multiselectable': 'true' },
      list.map((e) =>
        h(
          'div',
          {
            key: e.key,
            class: { 'lb-row': true, on: this.sel.has(e.key), linked: !!e.linked },
            role: 'option',
            'aria-selected': this.sel.has(e.key) ? 'true' : 'false',
            'data-kind': e.kind,
            onclick: (ev: MouseEvent) => this.click(e, ev),
            ondblclick: () => void this.activate(e),
          },
          icon(e.icon),
          h('span', { class: 'lb-name' }, e.name),
          e.linked ? h('span', { class: 'lb-badge', 'data-tip': 'Already linked by this project' }, icon('id_linked')) : null,
          e.kind === 'file' || e.kind === 'category' || e.kind === 'dir' ? h('span', { class: 'lb-detail' }, e.detail ?? '', h('span', { class: 'lb-chev' }, icon('disclosure_tri_right'))) : null,
        ),
      ),
    );
  }

  private optionsPanel(): Child {
    const opts = this.o.options ?? [];
    if (!opts.length) return null;
    return h(
      'div',
      { class: 'lb-opts' },
      h('div', { class: 'fb-side-title' }, 'Options'),
      opts.map(([k, label, tip]) => h('div', { key: k, class: 'lb-opt', 'data-tip': tip }, checkbox(`lb-${k}`, label, !!this.values[k], (v) => ((this.values[k] = v), this.redraw())))),
    );
  }

  body(): Child {
    const loc = this.loc;
    const n = this.picks.size;
    const primary = this.o.confirm ?? (this.o.mode === 'LINK' ? 'Link' : this.o.mode === 'APPEND' ? 'Append' : 'Relocate');
    const summary =
      this.o.mode === 'RELOCATE'
        ? this.open && loc?.kind !== 'recent' && loc?.kind !== 'libraries' && loc?.kind !== 'dir'
          ? this.open.ref.path
          : 'Pick the file to use instead'
        : n
          ? this.pickedItems()
              .slice(0, 4)
              .map((x) => x.name)
              .join(', ') + (n > 4 ? ` and ${n - 4} more` : '')
          : loc?.kind === 'category'
            ? 'Click data-blocks to pick them (Ctrl and Shift add more)'
            : 'Open a project file, then a data-block type';
    return h(
      'div',
      {
        class: 'lb',
        tabindex: '-1',
        onkeydown: (e: KeyboardEvent) => {
          if ((e.target as HTMLElement).closest('input')) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            const one = this.entries.find((x) => this.sel.has(x.key));
            if (one && one.kind !== 'item') void this.activate(one);
            else void this.confirm();
          } else if (e.key === 'Backspace') {
            e.preventDefault();
            void this.up();
          }
        },
      },
      h(
        'div',
        { class: 'lb-bar' },
        h('button', { class: 'hdr-icon', 'data-tip': 'Parent\nGo up one level (Backspace)', 'aria-label': 'Parent', disabled: this.stack.length < 2, onclick: () => void this.up() }, icon('file_parent')),
        this.crumbs(),
        h('div', { class: 'lb-filter' }, textField('lb-filter', this.filter, (v) => ((this.filter = v), this.redraw()), { placeholder: 'Filter', icon: 'viewzoom', live: true })),
      ),
      h('div', { class: 'lb-main' }, this.side(), h('div', { class: 'lb-center' }, this.list(), this.status && this.entries.length ? h('div', { class: 'lb-status' }, this.status) : null), this.optionsPanel()),
      h(
        'div',
        { class: 'lb-foot' },
        h('div', { class: 'lb-summary', 'data-tip': summary }, n && this.o.mode !== 'RELOCATE' ? h('span', { class: 'lb-count' }, String(n)) : null, h('span', null, summary)),
        n && this.o.mode !== 'RELOCATE' ? h('button', { class: 'btn', 'data-tip': 'Forget the picked data-blocks', onclick: () => (this.picks.clear(), this.sel.clear(), this.redraw()) }, 'Clear') : null,
        h('button', { class: 'btn', onclick: () => closeDialog(DIALOG) }, 'Cancel'),
        h('button', { class: 'btn primary lb-go', disabled: !this.canConfirm(), onclick: () => void this.confirm() }, primary),
      ),
    );
  }
}

/** Open the library browser; `done` runs when the user confirms. */
export function openLibraryBrowser(o: BrowseOptions, at?: FileRef): LibraryBrowser {
  closeDialog(DIALOG);
  const b = new LibraryBrowser(o);
  b.dlg = openDialog({ id: DIALOG, title: o.title ?? (o.mode === 'LINK' ? 'Link' : o.mode === 'APPEND' ? 'Append' : 'Relocate'), width: 820, height: 520, className: 'library-browser', body: () => b.body() });
  void b.init(at ? { kind: 'file', ref: at } : undefined);
  return b;
}

export type { LibraryBrowser, LibraryData, ID };
