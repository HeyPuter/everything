// Outliner: tree of the scene's collections and objects (view layer / scenes), every data-block
// in the file, or unused data. Selection is kept in sync with object selection; collections and
// other elements have their own outliner selection.
import { renameScene, sceneById } from '../scenes/scenes';
import { switchScene } from '../scenes/switch';
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, openPopover, promptText, type MenuItem } from '../ui/menu';
import type { DocumentData, ObjectData } from '../data/types';
import { uniqueName, setActiveCollection, activeCollection } from '../ops/object';
import { applyMatrixToObject, fromMatrix4 } from '../eval/transform';
import { Matrix4, Vector3 } from 'three';
import { surfaceHit } from '../ops/view3d';
import { textField } from '../ui/widgets';
import {
  buildRows,
  defaultFilter,
  allElements,
  childrenMap,
  objectsInside,
  objectHierarchy,
  ancestorCollections,
  descendantCollections,
  type DisplayMode,
  type OutlinerFilter,
  type Row,
  type TreeState,
} from './outliner/tree';
import { moveCollection, moveObjectsToCollection } from './outliner/collections';
import { contextMenuFor, emptyMenu, viewMenu, rowBadgeHooks } from './outliner/menus';
import { filterPopover } from './outliner/filter';
import { setCurrentOutliner } from './outliner/current';
import './outliner/icons';
import './outliner/ops';
import './outliner/outliner.css';

const MODE_ICON: Record<string, string> = {
  EDIT: 'editmode_hlt',
  POSE: 'pose_hlt',
  SCULPT: 'sculptmode_hlt',
  VERTEX_PAINT: 'vpaint_hlt',
  WEIGHT_PAINT: 'wpaint_hlt',
  TEXTURE_PAINT: 'tpaint_hlt',
};

type ColumnId = 'enable' | 'select' | 'hide' | 'viewport' | 'render' | 'holdout' | 'indirect';
const COLUMNS: { id: ColumnId; show: keyof OutlinerFilter }[] = [
  { id: 'enable', show: 'show_restrict_column_enable' },
  { id: 'select', show: 'show_restrict_column_select' },
  { id: 'hide', show: 'show_restrict_column_hide' },
  { id: 'viewport', show: 'show_restrict_column_viewport' },
  { id: 'render', show: 'show_restrict_column_render' },
  { id: 'holdout', show: 'show_restrict_column_holdout' },
  { id: 'indirect', show: 'show_restrict_column_indirect_only' },
];

interface Cell {
  /** "on" means visible / enabled / selectable (the non-restricted state) */
  on: boolean;
  icon: string;
  tip: string;
  set: (on: boolean) => void;
  /** apply to children (Shift+click) */
  recurse?: (on: boolean) => void;
  /** isolate (Ctrl+click) */
  isolate?: () => void;
}

/** Object types whose data can be edited in Edit Mode. */
const EDITABLE = new Set(['MESH', 'CURVE', 'FONT', 'ARMATURE', 'LATTICE']);

/** Row height and list padding (px), used to draw only the visible part of long trees. */
const ROW_H = 22;
const PAD = 2;
const VIRTUAL_MIN = 150;

type DragInfo = { kind: 'objects'; ids: string[] } | { kind: 'collection'; id: string } | { kind: 'material'; id: string; /** data-block table of the dragged row */ table?: string };
type DropZone = 'INTO' | 'BEFORE' | 'AFTER';

const DISPLAY_MODES: [DisplayMode, string, string][] = [
  ['SCENES', 'Scenes', 'scene_data'],
  ['VIEW_LAYER', 'View Layer', 'view_layer'],
  ['BLENDER_FILE', 'Data Blocks', 'file_3d'],
  ['ORPHAN_DATA', 'Unused Data', 'trash'],
];

export class Outliner implements Editor {
  el: HTMLElement;
  keymaps = ['Outliner', 'Window', 'Screen'];
  list: HTMLElement;
  private hint: HTMLElement;
  private boxEl: HTMLElement;
  displayMode: DisplayMode = 'VIEW_LAYER';
  filter: OutlinerFilter = defaultFilter();
  search = '';
  /** explicit open / closed state of tree elements */
  open = new Map<string, boolean>();
  /** selected element keys (collections and other non-object elements; objects too when sync is off) */
  sel = new Set<string>();
  /** active element (walk cursor) */
  activeKey: string | null = null;
  rows: Row[] = [];
  renaming: string | null = null;
  private drag: DragInfo | null = null;
  private toggleDrag: { col: ColumnId; on: boolean; done: Set<string> } | null = null;
  private openDrag: { open: boolean; done: Set<string> } | null = null;
  /** pending click on an already selected item (applied on release when no drag started) */
  private pendingClick: { row: Row; ctrl: boolean; shift: boolean } | null = null;
  private scrollQueued = false;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'outliner';
    this.list = document.createElement('div');
    this.list.className = 'ol-list';
    this.list.tabIndex = -1;
    this.hint = document.createElement('div');
    this.hint.className = 'ol-drop-hint';
    this.hint.hidden = true;
    this.boxEl = document.createElement('div');
    this.boxEl.className = 'ol-box';
    this.boxEl.hidden = true;
    this.el.append(this.list, this.hint, this.boxEl);
    // state from a saved layout or a workspace template: { displayMode, filter, open }
    const st = state as { displayMode?: DisplayMode; mode?: DisplayMode; filter?: Partial<OutlinerFilter>; open?: [string, boolean][] } | undefined;
    const mode = st?.displayMode ?? st?.mode;
    if (mode && DISPLAY_MODES.some(([m]) => m === mode)) this.displayMode = mode;
    if (Array.isArray(st?.open)) for (const [k, v] of st.open) if (typeof k === 'string') this.open.set(k, !!v);
    if (st?.filter) Object.assign(this.filter, st.filter);
    this.list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!(e.target as HTMLElement).closest('.ol-row')) openMenu(emptyMenu(this), { x: e.clientX, y: e.clientY });
    });
    this.list.addEventListener('pointerdown', (e) => this.onListDown(e));
    // long trees only draw the rows in view: redraw when scrolled
    this.list.addEventListener('scroll', () => {
      if (this.rows.length < VIRTUAL_MIN || this.scrollQueued) return;
      this.scrollQueued = true;
      requestAnimationFrame(() => {
        this.scrollQueued = false;
        this.update();
      });
    });
    this.el.addEventListener('pointerenter', () => setCurrentOutliner(this));
    this.list.addEventListener('dragover', (e) => {
      if (this.drag && !(e.target as HTMLElement).closest('.ol-row')) this.setHint(null);
    });
    setCurrentOutliner(this);
  }

  // ---------------------------------------------------------------------------
  // header

  header(): Child {
    const dm = DISPLAY_MODES.find(([m]) => m === this.displayMode)!;
    const viewLayer = this.displayMode === 'VIEW_LAYER' || this.displayMode === 'SCENES';
    return h(
      'div',
      { class: 'hdr-row' },
      h(
        'button',
        {
          class: 'hdr-icondrop ol-display-mode',
          'data-tip': `Display Mode\nType of information to display: ${dm[1]}`,
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              DISPLAY_MODES.map(([v, l, i]) => ({
                label: l,
                icon: i,
                active: this.displayMode === v,
                action: () => this.setDisplayMode(v),
              })),
              e.currentTarget as HTMLElement,
              { title: 'Display Mode' },
            );
          },
        },
        icon(dm[2]),
        icon('down_arrow_hlt', 'tiny'),
      ),
      h(
        'div',
        { class: 'hdr-search' },
        textField('ol-search', this.search, (v) => this.setSearch(v), {
          placeholder: 'Search',
          icon: 'search',
          live: true,
          className: 'ol-search',
        }),
      ),
      viewLayer
        ? h(
            'button',
            {
              class: {
                'hdr-toggle': true,
                'ol-filter-btn': true,
                on: this.filterActive(),
              },
              'data-tip': 'Filter\nRestriction columns, sorting, and which elements are shown',
              onpointerdown: (e: PointerEvent) => {
                e.preventDefault();
                openPopover(e.currentTarget as HTMLElement, () => filterPopover(this), { width: 250, className: 'ol-filter-pop' });
              },
            },
            icon('filter'),
            icon('down_arrow_hlt', 'tiny'),
          )
        : null,
      viewLayer
        ? h(
            'button',
            {
              class: 'hdr-toggle',
              'data-tip': 'New Collection\nAdd a new collection inside the selected collection',
              onclick: () => app.run('outliner.collection_new', { nested: true }),
            },
            icon('collection_new'),
          )
        : null,
      this.displayMode === 'ORPHAN_DATA'
        ? h(
            'button',
            {
              class: 'btn ol-purge',
              'data-tip': 'Purge\nRemove every data-block without users',
              onclick: () => app.run('outliner.orphans_purge'),
            },
            'Purge',
          )
        : null,
    );
  }

  /** true when the filter popover hides something (shown as a highlighted button) */
  private filterActive() {
    const f = this.filter;
    return (
      !f.use_filter_collection ||
      !f.use_filter_object ||
      f.filter_state !== 'ALL' ||
      !f.use_filter_object_content ||
      !f.use_filter_children ||
      [
        f.use_filter_object_mesh,
        f.use_filter_object_armature,
        f.use_filter_object_empty,
        f.use_filter_object_light,
        f.use_filter_object_camera,
        f.use_filter_object_grease_pencil,
        f.use_filter_object_others,
      ].some((x) => !x)
    );
  }

  setDisplayMode(m: DisplayMode) {
    this.displayMode = m;
    this.sel.clear();
    this.activeKey = null;
    this.redraw();
  }

  setSearch(v: string) {
    this.search = v;
    this.update();
  }

  focusSearch() {
    const input = this.area.headerEl.querySelector('.ol-search input') as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }

  redraw() {
    this.update();
    this.area.drawHeader();
  }

  // ---------------------------------------------------------------------------
  // tree state

  treeState(): TreeState {
    return {
      mode: this.displayMode,
      filter: this.filter,
      search: this.search,
      open: this.open,
    };
  }

  setOpen(ekey: string, v: boolean) {
    this.open.set(ekey, v);
  }

  allElements() {
    return allElements(app.doc, this.treeState(), {
      visible: (id) => app.isVisible(id),
      selectable: (id) => app.isSelectable(id),
    });
  }

  isSelected(r: Row): boolean {
    if (r.kind === 'object' && r.ob && this.filter.use_sync_select) return !!app.doc.objects[r.ob.id]?.select;
    return this.sel.has(r.ekey);
  }

  setSelected(r: Row, v: boolean) {
    if (r.kind === 'object' && r.ob && this.filter.use_sync_select) {
      const ob = app.doc.objects[r.ob.id];
      if (ob) ob.select = v && !ob.hide;
      if (!v) this.sel.delete(r.ekey);
      return;
    }
    if (v) this.sel.add(r.ekey);
    else this.sel.delete(r.ekey);
  }

  deselectAll() {
    this.sel.clear();
    if (this.filter.use_sync_select) for (const o of Object.values(app.doc.objects)) o.select = false;
  }

  isActive(r: Row): boolean {
    if (r.kind === 'object' && r.ob) return app.doc.scene.active_object === r.ob.id && (this.activeKey === null || this.activeKey === r.ekey || !this.activeKey.startsWith('c:'));
    return this.activeKey === r.ekey;
  }

  /** index of the walk cursor in the current rows */
  cursorIndex(): number {
    let i = this.activeKey ? this.rows.findIndex((r) => r.ekey === this.activeKey) : -1;
    if (i < 0 && app.doc.scene.active_object) i = this.rows.findIndex((r) => r.kind === 'object' && r.ob?.id === app.doc.scene.active_object);
    return i;
  }

  /** Selected elements of a kind, with the clicked/active one first. */
  selectedRows(kind?: Row['kind']): Row[] {
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const r of this.rows) if ((!kind || r.kind === kind) && this.isSelected(r) && !seen.has(r.ekey)) (seen.add(r.ekey), out.push(r));
    return out;
  }

  selectedCollections(): string[] {
    const ids = this.selectedRows('collection')
      .map((r) => r.id!)
      .filter((id) => id !== app.doc.scene.collection);
    // collections selected in the data-block list
    for (const k of this.sel) if (k.startsWith('id:collections:')) ids.push(k.slice('id:collections:'.length));
    return [...new Set(ids)].filter((id) => app.doc.collections[id]);
  }

  /** Make an element active: objects become the active object, collections the active collection. */
  activate(r: Row) {
    const doc = app.doc;
    this.activeKey = r.ekey;
    if (r.kind === 'collection' && r.id) {
      setActiveCollection(r.id);
      return;
    }
    const ob = r.ob ? doc.objects[r.ob.id] : undefined;
    if (!ob) return;
    if (r.kind === 'object') {
      doc.scene.active_object = ob.id;
      return;
    }
    // sub-elements activate their object and show the matching properties tab
    if (this.filter.use_sync_select) ob.select = !ob.hide;
    doc.scene.active_object = ob.id;
    if (r.kind === 'material' && r.id) {
      const slots = (doc.meshes[ob.data ?? ''] ?? doc.curves[ob.data ?? ''])?.materials ?? [];
      const i = slots.indexOf(r.id);
      const oi = ob.object_materials?.indexOf(r.id) ?? -1;
      if (i >= 0 || oi >= 0) ob.active_material_index = i >= 0 ? i : oi;
    }
    const tab =
      r.kind === 'material'
        ? 'MATERIAL'
        : r.kind === 'modifier' || r.kind === 'modifiers'
          ? 'MODIFIER'
          : r.kind === 'constraint' || r.kind === 'constraints'
            ? 'CONSTRAINT'
            : r.kind === 'data' || r.kind === 'vgroup' || r.kind === 'vgroups'
              ? 'DATA'
              : null;
    if (tab) (window as unknown as { __propertiesTab?: string }).__propertiesTab = tab;
  }

  private selectionSignature() {
    const doc = app.doc;
    let s = `${doc.scene.active_object}|`;
    for (const id of doc.object_order) if (doc.objects[id]?.select) s += `${id},`;
    return s;
  }

  /** Apply a selection change; pushes an undo step when the object selection changed. */
  commitSelection(before: string) {
    if (this.selectionSignature() !== before) app.pushUndo('Outliner Selection');
    app.changed('select', 'doc');
  }

  /** Click selection of a row (item_activate). */
  clickRow(r: Row, opts: { ctrl?: boolean; shift?: boolean; recurse?: boolean } = {}) {
    const doc = app.doc;
    const before = this.selectionSignature();
    if (r.ob && (r.kind === 'object' || (this.displayMode !== 'BLENDER_FILE' && this.displayMode !== 'ORPHAN_DATA'))) this.prepareModeSwitch(r.ob);
    // clicking another scene makes it the active scene
    if (r.kind === 'scene' && r.id && r.id !== doc.scene.id && sceneById(doc, r.id)) {
      switchScene(r.id);
      return;
    }
    const selectable = (x: Row) => x.kind !== 'group' && x.kind !== 'file' && x.kind !== 'scene' && !(x.kind === 'collection' && x.id === doc.scene.collection && !opts.ctrl);
    if (opts.shift) {
      const a = this.cursorIndex();
      const b = this.rows.findIndex((x) => x.key === r.key);
      if (!opts.ctrl) this.deselectAll();
      if (a >= 0 && b >= 0)
        for (const x of this.rows.slice(Math.min(a, b), Math.max(a, b) + 1))
          if (selectable(x)) this.setSelected(x, true);
          else this.setSelected(r, true);
      if (a < 0) this.activate(r);
    } else if (opts.ctrl) {
      const sel = this.isSelected(r);
      const act = this.isActive(r);
      if (sel && act) {
        this.setSelected(r, false);
        this.activeKey = null;
      } else {
        this.setSelected(r, true);
        this.activate(r);
      }
    } else {
      this.deselectAll();
      this.setSelected(r, true);
      this.activate(r);
    }
    if (opts.recurse) this.selectInside(r, true);
    this.commitSelection(before);
    // clicking an object's data toggles edit mode on it
    if (r.kind === 'data' && r.ob && !opts.ctrl && !opts.shift && EDITABLE.has(r.ob.type) && this.displayMode !== 'BLENDER_FILE') {
      const doc = app.doc;
      if (doc.scene.active_object === r.ob.id) app.run('object.mode_set', { mode: doc.mode === 'EDIT' ? 'OBJECT' : 'EDIT' });
    }
  }

  /** Select (or deselect) everything inside a collection or below an object. */
  selectInside(r: Row, v: boolean) {
    const doc = app.doc;
    if (r.kind === 'collection' && r.id) {
      for (const id of objectsInside(doc, r.id)) if (doc.objects[id] && !doc.objects[id].hide) doc.objects[id].select = v;
      for (const c of descendantCollections(doc, r.id)) v ? this.sel.add(`c:${c}`) : this.sel.delete(`c:${c}`);
    } else if (r.kind === 'object' && r.ob) for (const id of objectHierarchy(doc, r.ob.id)) if (!doc.objects[id].hide) doc.objects[id].select = v;
  }

  /** Clicking another object while in an edit/paint mode leaves the mode, or transfers it. */
  private prepareModeSwitch(ob: ObjectData) {
    const doc = app.doc;
    if (doc.mode === 'OBJECT' || doc.scene.active_object === ob.id) return;
    if (doc.mode === 'POSE' && ob.type !== 'ARMATURE') return;
    app.run('object.mode_set', { mode: 'OBJECT' });
  }

  /** Mode column: move the current mode to another object (Ctrl adds it to multi-object editing). */
  modeTransfer(ob: ObjectData, add: boolean) {
    const doc = app.doc;
    const mode = doc.mode;
    const act = app.activeObject;
    if (mode === 'OBJECT' || !act) return;
    const multi = mode === 'EDIT' || mode === 'POSE';
    if (add && multi && ob.id === act.id) return;
    app.run('object.mode_set', { mode: 'OBJECT' });
    if (add && multi) {
      const inMode = ob.select;
      ob.select = !inMode;
    } else {
      for (const o of Object.values(doc.objects)) o.select = false;
      ob.select = true;
      doc.scene.active_object = ob.id;
    }
    act.select = true;
    if (!add || !multi) act.select = act.id === ob.id;
    app.run('object.mode_set', { mode });
    app.changed('select', 'mode', 'doc');
  }

  // ---------------------------------------------------------------------------
  // expansion

  toggleOpen(r: Row, recursive: boolean, value = !r.expanded) {
    this.setOpen(r.ekey, value);
    // Shift: open/close every element below this row as well (also currently hidden ones)
    if (recursive) for (const k of this.collectBelow(r)) this.setOpen(k, value);
    this.update();
  }

  /** Element keys of the whole subtree below a row, regardless of expansion. */
  private collectBelow(r: Row): string[] {
    const keys: string[] = [];
    const all = allElements(app.doc, { ...this.treeState(), search: '' });
    let inside = false,
      depth = -1;
    for (const e of all) {
      if (e.ekey === r.ekey) {
        inside = true;
        depth = e.depth;
        continue;
      }
      if (inside) {
        if (e.depth <= depth) break;
        if (e.hasKids) keys.push(e.ekey);
      }
    }
    return keys;
  }

  // ---------------------------------------------------------------------------
  // drawing

  update(kinds?: Set<ChangeKind>) {
    void kinds;
    const doc = app.doc;
    setCurrentOutliner(this.el.isConnected ? this : null, true);
    this.rows = buildRows(doc, this.treeState(), {
      visible: (id) => app.isVisible(id),
      selectable: (id) => app.isSelectable(id),
    });
    const actCol = activeCollection(doc);
    const showModes = this.filter.show_mode_column && doc.mode !== 'OBJECT' && (this.displayMode === 'VIEW_LAYER' || this.displayMode === 'SCENES');
    const act = app.activeObject;
    const editIds = new Set(
      doc.mode === 'EDIT' || doc.mode === 'POSE'
        ? [
            act?.id,
            ...app
              .selectedObjects()
              .filter((o) => o.type === act?.type)
              .map((o) => o.id),
          ]
        : [act?.id],
    );
    const cols = this.displayMode === 'VIEW_LAYER' || this.displayMode === 'SCENES' ? COLUMNS.filter((c) => this.filter[c.show]) : [];
    const idModes = this.displayMode === 'BLENDER_FILE' || this.displayMode === 'ORPHAN_DATA';
    const hiddenCols = this.hiddenCollections(doc);
    const total = this.rows.length;
    let first = 0,
      last = total;
    if (total >= VIRTUAL_MIN) {
      const top = this.list.scrollTop,
        height = this.list.clientHeight || 800;
      first = Math.max(0, Math.floor((top - PAD) / ROW_H) - 15);
      last = Math.min(total, Math.ceil((top + height) / ROW_H) + 15);
      // a row being renamed that scrolled away stops renaming
      const ri = this.renaming ? this.rows.findIndex((r) => r.key === this.renaming) : -1;
      if (ri >= 0 && (ri < first || ri >= last)) this.renaming = null;
    }
    patch(this.list, [
      first > 0 ? h('div', { key: '#top', class: 'ol-spacer-row', style: { height: `${first * ROW_H}px` } }) : null,
      this.rows.slice(first, last).map((r, k) => {
        const i = first + k;
        const ob = r.ob;
        const selected = this.isSelected(r);
        const active = this.isActive(r);
        const colActive = r.kind === 'collection' && r.id === actCol && !idModes;
        const hidden = r.kind === 'object' && ob && !idModes ? !app.isVisible(ob.id) : r.kind === 'collection' && r.id ? hiddenCols.has(r.id) : false;
        const ctag = r.collection && r.collection.color_tag && r.collection.color_tag !== 'NONE' ? `ct-${r.collection.color_tag}` : '';
        return h(
          'div',
          {
            key: r.key,
            'data-key': r.key,
            class: {
              'ol-row': true,
              alt: i % 2 === 1,
              selected,
              active,
              'col-active': colActive,
              dim: !!hidden,
              indirect: !!r.indirect,
              match: !!r.match,
              editmode: !!(active && r.kind === 'object' && doc.mode !== 'OBJECT'),
            },
            style: { '--depth': String(r.depth) },
            onpointerdown: (e: PointerEvent) => this.onRowDown(e, r),
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              if (!this.isSelected(r) || !this.isActive(r)) {
                if (!this.isSelected(r)) this.clickRow(r);
                else this.activeKey = r.ekey;
              }
              openMenu(contextMenuFor(this, r), { x: e.clientX, y: e.clientY });
            },
            ondragover: (e: DragEvent) => this.onDragOver(e, r),
            ondragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-into', 'drop-before', 'drop-after'),
            ondrop: (e: DragEvent) => {
              e.preventDefault();
              const el = e.currentTarget as HTMLElement;
              const zone: DropZone = el.classList.contains('drop-before') ? 'BEFORE' : el.classList.contains('drop-after') ? 'AFTER' : 'INTO';
              el.classList.remove('drop-into', 'drop-before', 'drop-after');
              this.onDrop(r, zone, e.ctrlKey || e.metaKey, e.shiftKey);
            },
          },
          showModes ? this.modeCell(r, editIds) : null,
          h('span', { class: 'ol-indent' }),
          r.expandable
            ? h(
                'button',
                {
                  class: 'ol-arrow',
                  tabindex: '-1',
                  'aria-label': r.expanded ? 'Collapse' : 'Expand',
                  onpointerdown: (e: PointerEvent) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (e.button !== 0) return;
                    this.openDrag = {
                      open: !r.expanded,
                      done: new Set([r.ekey]),
                    };
                    addEventListener('pointerup', () => (this.openDrag = null), { once: true });
                    this.toggleOpen(r, e.shiftKey);
                  },
                  onpointerenter: () => {
                    const d = this.openDrag;
                    if (!d || d.done.has(r.ekey)) return;
                    d.done.add(r.ekey);
                    if (r.expanded !== d.open) this.toggleOpen(r, false, d.open);
                  },
                },
                icon(r.expanded ? 'disclosure_tri_down' : 'disclosure_tri_right'),
              )
            : h('span', { class: 'ol-arrow-space' }),
          h(
            'span',
            {
              class: 'ol-item',
              draggable: this.isDraggable(r) ? 'true' : 'false',
              ondragstart: (e: DragEvent) => this.onDragStart(e, r),
              ondragend: () => {
                this.drag = null;
                viewportDrag = null;
                this.setHint(null);
              },
              ondblclick: (e: MouseEvent) => {
                if ((e.target as HTMLElement).closest('.ol-icon'))
                  this.clickRow(r, {
                    ctrl: e.ctrlKey || e.metaKey,
                    shift: e.shiftKey,
                    recurse: true,
                  });
                else this.startRename(r.key);
              },
            },
            h('span', { class: `ol-icon ${ctag}` }, icon(r.icon)),
            this.renaming === r.key
              ? h('input', {
                  class: 'ol-rename',
                  value: r.label,
                  ref: (el: HTMLInputElement) =>
                    requestAnimationFrame(() => {
                      el.focus();
                      el.select();
                    }),
                  onpointerdown: (e: PointerEvent) => e.stopPropagation(),
                  onkeydown: (e: KeyboardEvent) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') this.rename(r, (e.target as HTMLInputElement).value);
                    if (e.key === 'Escape') {
                      this.renaming = null;
                      this.update();
                    }
                  },
                  onblur: (e: FocusEvent) => this.renaming === r.key && this.rename(r, (e.target as HTMLInputElement).value),
                })
              : h('span', { class: 'ol-name' }, r.label),
            rowBadgeHooks.map((f) => f(r)),
            r.count !== undefined ? h('span', { class: 'ol-count', 'data-tip': `${r.count} data-block${r.count === 1 ? '' : 's'}` }, String(r.count)) : null,
          ),
          r.chips?.length
            ? h(
                'span',
                { class: 'ol-chips' },
                r.chips.map((c) => h('span', { class: 'ol-chip', key: c.icon }, icon(c.icon), c.count > 1 ? h('span', { class: 'ol-chip-n' }, String(c.count)) : null)),
              )
            : null,
          h('span', { class: 'ol-spacer' }),
          idModes && r.users !== undefined ? this.userCells(r) : null,
          cols.length
            ? h(
                'span',
                { class: 'ol-toggles' },
                cols.map((c) => this.toggleCell(r, c.id)),
              )
            : null,
        );
      }),
      last < total ? h('div', { key: '#bottom', class: 'ol-spacer-row', style: { height: `${(total - last) * ROW_H}px` } }) : null,
    ]);
  }

  /** Scroll so that row `i` is visible ('nearest') or centered. */
  scrollToRow(i: number, block: 'nearest' | 'center' = 'nearest') {
    const l = this.list;
    const top = PAD + i * ROW_H;
    if (block === 'center') l.scrollTop = Math.max(0, top - l.clientHeight / 2 + ROW_H / 2);
    else if (top < l.scrollTop) l.scrollTop = top;
    else if (top + ROW_H > l.scrollTop + l.clientHeight) l.scrollTop = top + ROW_H - l.clientHeight;
    if (this.rows.length >= VIRTUAL_MIN) this.update();
  }

  /** Collections hidden in the viewport through themselves or a parent. */
  private hiddenCollections(doc: DocumentData): Set<string> {
    const out = new Set<string>();
    const walk = (id: string, hidden: boolean, depth: number) => {
      const c = doc.collections[id];
      if (!c || depth > 64) return;
      const isMaster = id === doc.scene.collection;
      const h2 = hidden || (!isMaster && (c.hide || c.exclude || c.hide_viewport));
      if (h2) out.add(id);
      for (const ch of c.children) walk(ch, h2, depth + 1);
    };
    walk(doc.scene.collection, false, 0);
    return out;
  }

  private modeCell(r: Row, editIds: Set<string | undefined>): Child {
    const doc = app.doc;
    const act = app.activeObject;
    const ob = r.ob;
    if (r.kind !== 'object' || !ob || !act || ob.type !== act.type || (doc.mode === 'POSE' && ob.type !== 'ARMATURE')) return h('span', { class: 'ol-mode' });
    const inMode = editIds.has(ob.id);
    return h(
      'button',
      {
        class: { 'ol-mode': true, on: inMode },
        tabindex: '-1',
        'data-tip': inMode
          ? 'Remove from the current mode (Ctrl+click), or click another object to switch to it'
          : 'Switch the current mode to this object\nCtrl+click to add it to multi-object editing',
        onpointerdown: (e: PointerEvent) => {
          e.stopPropagation();
          e.preventDefault();
          this.modeTransfer(ob, e.ctrlKey || e.metaKey);
        },
      },
      icon(inMode ? (MODE_ICON[doc.mode] ?? 'object_datamode') : 'dot'),
    );
  }

  private userCells(r: Row): Child {
    const table = r.table;
    const rec = table ? (app.doc as unknown as Record<string, Record<string, { use_fake_user?: boolean }>>)[table]?.[r.id ?? ''] : undefined;
    const canFake = !!rec && table !== 'objects' && table !== 'collections';
    return h(
      'span',
      { class: 'ol-users' },
      h(
        'span',
        {
          class: 'ol-user-count',
          'data-tip': 'Number of users of this data-block',
        },
        String(r.users ?? 0),
      ),
      canFake
        ? h(
            'button',
            {
              class: { 'ol-toggle': true, off: !r.fakeUser },
              'data-tip': 'Fake User\nKeep this data-block in the file even without users',
              onpointerdown: (e: PointerEvent) => {
                e.stopPropagation();
                e.preventDefault();
                rec!.use_fake_user = !rec!.use_fake_user;
                app.pushUndo(rec!.use_fake_user ? 'Add Fake User' : 'Clear Fake User');
                app.changed('doc');
              },
            },
            icon(r.fakeUser ? 'fake_user_on' : 'fake_user_off'),
          )
        : h('span', { class: 'ol-toggle-space' }),
    );
  }

  // ---------------------------------------------------------------------------
  // restriction columns

  private cell(r: Row, col: ColumnId): Cell | null {
    const doc = app.doc;
    const push = (label: string) => {
      app.pushUndo(label);
      app.changed('doc', 'select');
    };
    if (r.kind === 'collection' && r.collection && r.id !== doc.scene.collection) {
      const c = r.collection;
      const id = c.id;
      const flag = {
        enable: 'exclude',
        select: 'hide_select',
        hide: 'hide',
        viewport: 'hide_viewport',
        render: 'hide_render',
        holdout: 'holdout',
        indirect: 'indirect_only',
      }[col] as 'exclude';
      const inverted = col === 'holdout' || col === 'indirect';
      const raw = !!(c as unknown as Record<string, boolean>)[flag];
      const on = inverted ? raw : !raw;
      const setFlag = (cid: string, v: boolean) => {
        const cc = doc.collections[cid];
        if (cc) (cc as unknown as Record<string, boolean>)[flag] = inverted ? v : !v;
      };
      const icons: Record<ColumnId, [string, string, string]> = {
        enable: ['checkbox_hlt', 'checkbox_dehlt', 'Exclude from View Layer'],
        select: ['restrict_select_off', 'restrict_select_on', 'Disable Selection'],
        hide: ['hide_off', 'hide_on', 'Hide in Viewport\nCtrl+click to isolate, Shift+click to include children'],
        viewport: ['restrict_view_off', 'restrict_view_on', 'Disable in Viewports'],
        render: ['restrict_render_off', 'restrict_render_on', 'Disable in Renders'],
        holdout: ['holdout_on', 'holdout_off', 'Holdout\nMask out objects in this collection from the render'],
        indirect: ['indirect_only_on', 'indirect_only_off', 'Indirect Only\nObjects only contribute to the scene indirectly (reflections, shadows)'],
      };
      const [onIc, offIc, tip] = icons[col];
      return {
        on,
        icon: on ? onIc : offIc,
        tip,
        set: (v) => {
          setFlag(id, v);
          if (col === 'hide' && !v) for (const o of objectsInside(doc, id)) if (!app.isVisible(o)) doc.objects[o].select = false;
          push('Collection Visibility');
        },
        recurse: (v) => {
          for (const cid of [id, ...descendantCollections(doc, id)]) setFlag(cid, v);
          if (col !== 'enable' && col !== 'holdout' && col !== 'indirect')
            for (const oid of objectsInside(doc, id)) {
              const o = doc.objects[oid];
              const okey = {
                select: 'hide_select',
                hide: 'hide',
                viewport: 'hide_viewport',
                render: 'hide_render',
              }[col] as 'hide';
              o[okey] = !v;
              if (col === 'hide' && !v) o.select = false;
            }
          push('Collection Visibility');
        },
        isolate: () => {
          const keep = new Set([id, ...ancestorCollections(doc, id), ...descendantCollections(doc, id)]);
          for (const cc of Object.values(doc.collections)) if (cc.id !== doc.scene.collection) setFlag(cc.id, inverted ? cc.id === id : keep.has(cc.id));
          push('Isolate Collection');
        },
      };
    }
    if (r.kind === 'object' && r.ob && (col === 'select' || col === 'hide' || col === 'viewport' || col === 'render')) {
      const ob = doc.objects[r.ob.id];
      if (!ob) return null;
      const key = (
        {
          select: 'hide_select',
          hide: 'hide',
          viewport: 'hide_viewport',
          render: 'hide_render',
        } as const
      )[col];
      const icons = {
        select: ['restrict_select_off', 'restrict_select_on', 'Disable Selection'],
        hide: ['hide_off', 'hide_on', 'Hide in Viewport (H)\nCtrl+click to isolate, Shift+click to include children'],
        viewport: ['restrict_view_off', 'restrict_view_on', 'Disable in Viewports'],
        render: ['restrict_render_off', 'restrict_render_on', 'Disable in Renders'],
      }[col];
      const apply = (o: ObjectData, v: boolean) => {
        o[key] = !v;
        if (!v && (key === 'hide' || key === 'hide_viewport' || key === 'hide_select')) o.select = false;
      };
      return {
        on: !ob[key],
        icon: !ob[key] ? icons[0] : icons[1],
        tip: icons[2],
        set: (v) => {
          apply(ob, v);
          push('Object Visibility');
        },
        recurse: (v) => {
          for (const id of objectHierarchy(doc, ob.id)) apply(doc.objects[id], v);
          push('Object Visibility');
        },
        isolate: () => {
          for (const o of Object.values(doc.objects)) apply(o, o.id === ob.id);
          push('Isolate Object');
        },
      };
    }
    if (r.kind === 'modifier' && r.ob && r.id && (col === 'viewport' || col === 'render')) {
      const ob = doc.objects[r.ob.id];
      const md = ob?.modifiers.find((m) => m.id === r.id);
      if (!md) return null;
      const key = col === 'viewport' ? 'show_viewport' : 'show_render';
      const on = (md as unknown as Record<string, boolean>)[key] !== false;
      return {
        on,
        icon: col === 'viewport' ? (on ? 'restrict_view_off' : 'restrict_view_on') : on ? 'restrict_render_off' : 'restrict_render_on',
        tip: col === 'viewport' ? 'Display modifier in viewport' : 'Use modifier during render',
        set: (v) => {
          (md as unknown as Record<string, boolean>)[key] = v;
          push('Toggle Modifier');
        },
      };
    }
    return null;
  }

  private toggleCell(r: Row, col: ColumnId): Child {
    const c = this.cell(r, col);
    if (!c) return h('span', { class: 'ol-toggle-space', key: col });
    return h(
      'button',
      {
        key: col,
        class: { 'ol-toggle': true, off: !c.on, [`col-${col}`]: true },
        'data-tip': c.tip,
        'aria-pressed': c.on ? 'true' : 'false',
        onpointerdown: (e: PointerEvent) => {
          e.stopPropagation();
          e.preventDefault();
          if (e.button !== 0) return;
          if ((e.ctrlKey || e.metaKey) && c.isolate) return c.isolate();
          if (e.shiftKey && c.recurse) return c.recurse(!c.on);
          const v = !c.on;
          this.toggleDrag = { col, on: v, done: new Set([r.key]) };
          addEventListener('pointerup', () => (this.toggleDrag = null), {
            once: true,
          });
          c.set(v);
        },
        onpointerenter: () => {
          const d = this.toggleDrag;
          if (!d || d.col !== col || d.done.has(r.key)) return;
          d.done.add(r.key);
          const cur = this.cell(r, col);
          if (cur && cur.on !== d.on) cur.set(d.on);
        },
      },
      icon(c.icon),
    );
  }

  // ---------------------------------------------------------------------------
  // pointer interaction

  private onRowDown(e: PointerEvent, r: Row) {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.ol-toggle, .ol-arrow, .ol-mode, input')) return;
    if (this.renaming && this.renaming !== r.key) this.renaming = null;
    const ctrl = e.ctrlKey || e.metaKey;
    if (t.closest('.ol-item')) {
      // pressing an item: select now unless it's already selected (then wait: it may start a drag)
      if (this.isSelected(r) && !ctrl && !e.shiftKey) {
        this.pendingClick = { row: r, ctrl, shift: e.shiftKey };
        const up = () => {
          removeEventListener('pointerup', up, true);
          const p = this.pendingClick;
          this.pendingClick = null;
          if (p && !this.drag) this.clickRow(p.row, { ctrl: p.ctrl, shift: p.shift });
        };
        addEventListener('pointerup', up, true);
      } else this.clickRow(r, { ctrl, shift: e.shiftKey });
      return;
    }
    // empty part of a row: click selects, dragging starts a box selection
    e.preventDefault();
    this.trackBox(e, () => this.clickRow(r, { ctrl, shift: e.shiftKey }));
  }

  private onListDown(e: PointerEvent) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.ol-row')) return;
    e.preventDefault();
    this.trackBox(e, () => {
      if (this.renaming) {
        this.renaming = null;
        this.update();
      }
      const before = this.selectionSignature();
      this.deselectAll();
      this.activeKey = null;
      this.commitSelection(before);
    });
  }

  /** Track a press: on release without moving `click` runs, dragging draws a selection box. */
  private trackBox(e: PointerEvent, click: () => void, forced?: 'SET' | 'ADD' | 'SUB', done?: (r: 'FINISHED' | 'CANCELLED') => void) {
    const x0 = e.clientX,
      y0 = e.clientY;
    let moved = false;
    const mode = forced ?? (e.ctrlKey || e.metaKey ? 'SUB' : e.shiftKey ? 'ADD' : 'SET');
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      this.drawBox(x0, y0, ev.clientX, ev.clientY);
    };
    const finish = (ev: PointerEvent | null) => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('keydown', key, true);
      this.boxEl.hidden = true;
      if (!ev) return done?.('CANCELLED');
      if (!moved) click();
      else this.boxSelect(Math.min(y0, ev.clientY), Math.max(y0, ev.clientY), mode);
      done?.('FINISHED');
    };
    const up = (ev: PointerEvent) => finish(ev);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        finish(null);
      }
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
    addEventListener('keydown', key, true);
  }

  private drawBox(x0: number, y0: number, x1: number, y1: number) {
    const r = this.el.getBoundingClientRect();
    Object.assign(this.boxEl.style, {
      left: `${Math.min(x0, x1) - r.left}px`,
      top: `${Math.min(y0, y1) - r.top}px`,
      width: `${Math.abs(x1 - x0)}px`,
      height: `${Math.abs(y1 - y0)}px`,
    });
    this.boxEl.hidden = false;
  }

  /** Box select the rows that overlap the vertical range [top, bottom] (client coordinates). */
  boxSelect(top: number, bottom: number, mode: 'SET' | 'ADD' | 'SUB') {
    const before = this.selectionSignature();
    if (mode === 'SET') this.deselectAll();
    // rows are a fixed height, so the range maps directly to row indices (also for rows not drawn)
    const lr = this.list.getBoundingClientRect();
    const y0 = top - lr.top + this.list.scrollTop - PAD,
      y1 = bottom - lr.top + this.list.scrollTop - PAD;
    const i0 = Math.max(0, Math.floor(y0 / ROW_H)),
      i1 = Math.min(this.rows.length - 1, Math.floor(y1 / ROW_H));
    let first: Row | null = null;
    for (let i = i0; i <= i1; i++) {
      const r = this.rows[i];
      if (!r || r.kind === 'group' || r.kind === 'file' || r.kind === 'scene' || (r.kind === 'collection' && r.id === app.doc.scene.collection)) continue;
      this.setSelected(r, mode !== 'SUB');
      first ??= r;
    }
    if (mode !== 'SUB' && first && !this.selectedRows().some((r) => this.isActive(r))) this.activate(first);
    this.commitSelection(before);
  }

  /** Interactive box select started from the keyboard (B): drag a box in the outliner. */
  startBoxSelect() {
    app.startModal({
      label: 'Box Select',
      cursor: 'crosshair',
      header: () => 'Box Select: drag over rows (Shift extend, Ctrl subtract), Esc to cancel',
      onPointerDown: (e) => {
        if (e.button !== 0) return 'CANCELLED';
        const inside = this.list.contains(e.target as Node);
        if (!inside) return 'CANCELLED';
        const mode = e.ctrlKey || e.metaKey ? 'SUB' : e.shiftKey ? 'ADD' : 'SET';
        // hand over to the box tracker, which ends the modal on release
        queueMicrotask(() => this.trackBox(e, () => this.boxSelect(e.clientY, e.clientY, mode), mode));
        return 'FINISHED';
      },
      onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : undefined),
      cancel: () => {},
    });
  }

  // ---------------------------------------------------------------------------
  // drag and drop

  private isDraggable(r: Row) {
    if (r.kind === 'object') return true;
    if (r.kind === 'collection') return r.id !== app.doc.scene.collection && this.displayMode !== 'BLENDER_FILE' && this.displayMode !== 'ORPHAN_DATA';
    return r.kind === 'material' || (r.kind === 'id' && r.table === 'materials');
  }

  private onDragStart(e: DragEvent, r: Row) {
    if (r.kind === 'object' && r.ob) {
      const ids = this.isSelected(r) && this.filter.use_sync_select ? app.doc.object_order.filter((id) => app.doc.objects[id]?.select) : [r.ob.id];
      this.drag = {
        kind: 'objects',
        ids: ids.includes(r.ob.id) ? ids : [r.ob.id],
      };
    } else if (r.kind === 'collection' && r.id) this.drag = { kind: 'collection', id: r.id };
    else if (r.id) this.drag = { kind: 'material', id: r.id, table: r.kind === 'material' ? 'materials' : r.table };
    e.dataTransfer?.setData('text/plain', r.label);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
    viewportDrag = this.drag;
  }

  private dropAction(r: Row, zone: DropZone, ctrl: boolean, shift: boolean): string | null {
    const d = this.drag;
    const doc = app.doc;
    if (!d) return null;
    if (d.kind === 'objects') {
      if (r.kind === 'collection' && r.id && this.displayMode !== 'BLENDER_FILE') {
        const parented = d.ids.some((id) => doc.objects[id]?.parent);
        return ctrl ? 'Link to collection' : parented && !shift ? 'Move to collection and clear parent (Ctrl to link, Shift to keep parent)' : 'Move to collection (Ctrl to link)';
      }
      if (r.kind === 'object' && r.ob && !d.ids.includes(r.ob.id)) return 'Drop to set parent';
      return null;
    }
    if (d.kind === 'collection') {
      if (r.kind !== 'collection' || !r.id || r.id === d.id) return null;
      if (zone !== 'INTO' && r.id === doc.scene.collection) return null;
      return zone === 'INTO' ? 'Move inside collection' : zone === 'BEFORE' ? 'Move before collection' : 'Move after collection';
    }
    if (d.kind === 'material' && r.kind === 'object' && r.ob && (r.ob.type === 'MESH' || r.ob.type === 'CURVE' || r.ob.type === 'FONT')) return 'Drop material on object';
    return null;
  }

  private onDragOver(e: DragEvent, r: Row) {
    if (!this.drag) return;
    const el = e.currentTarget as HTMLElement;
    let zone: DropZone = 'INTO';
    if (this.drag.kind === 'collection' && r.kind === 'collection') {
      const b = el.getBoundingClientRect();
      const f = (e.clientY - b.top) / b.height;
      zone = f < 0.3 ? 'BEFORE' : f > 0.7 && !r.expanded ? 'AFTER' : 'INTO';
    }
    const action = this.dropAction(r, zone, e.ctrlKey || e.metaKey, e.shiftKey);
    el.classList.remove('drop-into', 'drop-before', 'drop-after');
    if (!action) {
      this.setHint(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? 'copy' : 'move';
    el.classList.add(zone === 'INTO' ? 'drop-into' : zone === 'BEFORE' ? 'drop-before' : 'drop-after');
    this.setHint(action, e.clientX, e.clientY);
  }

  private setHint(text: string | null, x = 0, y = 0) {
    if (!text) {
      this.hint.hidden = true;
      return;
    }
    const r = this.el.getBoundingClientRect();
    this.hint.textContent = text;
    this.hint.hidden = false;
    this.hint.style.left = `${Math.min(x - r.left + 14, r.width - 40)}px`;
    this.hint.style.top = `${y - r.top + 16}px`;
  }

  private onDrop(r: Row, zone: DropZone, ctrl: boolean, shift: boolean) {
    const doc = app.doc;
    const d = this.drag;
    const action = this.dropAction(r, zone, ctrl, shift);
    this.drag = null;
    this.setHint(null);
    if (!d || !action) return;
    if (d.kind === 'objects' && r.kind === 'collection' && r.id) {
      if (!ctrl && !shift) this.clearParentKeepTransform(d.ids.filter((id) => !d.ids.includes(doc.objects[id]?.parent ?? '')));
      moveObjectsToCollection(doc, d.ids, r.id, ctrl);
      app.pushUndo(ctrl ? 'Link to Collection' : 'Move to Collection');
    } else if (d.kind === 'objects' && r.kind === 'object' && r.ob) {
      const parent = r.ob;
      const pw = app.graph.get(parent.id)?.world.clone() ?? new Matrix4();
      const parentCols = Object.values(doc.collections)
        .filter((c) => c.objects.includes(parent.id))
        .map((c) => c.id);
      let n = 0;
      for (const id of d.ids) {
        if (id === parent.id) continue;
        const ob = doc.objects[id];
        if (!ob) continue;
        let q: string | null = parent.id,
          cycle = false;
        while (q) {
          if (q === id) cycle = true;
          q = doc.objects[q]?.parent ?? null;
        }
        if (cycle) continue;
        const w = app.graph.get(id)?.world.clone() ?? new Matrix4();
        ob.parent = parent.id;
        ob.parent_type = 'OBJECT';
        ob.matrix_parent_inverse = fromMatrix4(new Matrix4());
        applyMatrixToObject(ob, pw.clone().invert().multiply(w));
        // children follow the parent into its collection when they were not sharing one
        const shared = parentCols.some((c) => doc.collections[c].objects.includes(id));
        if (!shared && parentCols.length && this.displayMode !== 'BLENDER_FILE')
          moveObjectsToCollection(doc, [id], r.parentCollection && parentCols.includes(r.parentCollection) ? r.parentCollection : parentCols[0], false);
        n++;
      }
      if (!n) return;
      app.pushUndo('Drop to Set Parent');
    } else if (d.kind === 'collection' && r.kind === 'collection' && r.id) {
      if (!moveCollection(doc, d.id, r.id, zone)) {
        app.report('WARNING', 'Cannot move a collection inside itself');
        return;
      }
      app.pushUndo('Move Collection');
    } else if (d.kind === 'material' && r.kind === 'object' && r.ob) {
      app.run('outliner.material_drop', { object: r.ob.id, material: d.id }, { invoke: false });
      return;
    }
    app.changed('doc', 'select');
  }

  private clearParentKeepTransform(ids: string[]) {
    const doc = app.doc;
    for (const id of ids) {
      const ob = doc.objects[id];
      if (!ob?.parent) continue;
      const w = app.graph.get(id)?.world;
      ob.parent = null;
      ob.matrix_parent_inverse = fromMatrix4(new Matrix4());
      if (w) applyMatrixToObject(ob, w);
    }
  }

  // ---------------------------------------------------------------------------
  // rename

  /** Start renaming a row (by row key), or the active element when no key is given. */
  startRename(key?: string) {
    if (!key) {
      const i = this.cursorIndex();
      key = i >= 0 ? this.rows[i].key : undefined;
    }
    const r = key ? this.rows.find((x) => x.key === key) : undefined;
    if (!r || !this.canRename(r)) return false;
    this.scrollToRow(this.rows.indexOf(r));
    this.renaming = r.key;
    this.update();
    return true;
  }

  canRename(r: Row) {
    if (r.kind === 'collection') return r.id !== app.doc.scene.collection;
    return r.kind !== 'group' && r.kind !== 'file' && r.kind !== 'modifiers' && r.kind !== 'constraints' && r.kind !== 'vgroups';
  }

  rename(r: Row, name: string) {
    this.renaming = null;
    const doc = app.doc;
    name = name.trim();
    if (name && name !== r.label) {
      const tables = doc as unknown as Record<string, Record<string, { name: string }>>;
      if (r.kind === 'object' && r.ob) doc.objects[r.ob.id].name = uniqueName(doc, name);
      else if (r.kind === 'collection' && r.collection) doc.collections[r.collection.id].name = uniqueName(doc, name, 'collections');
      else if (r.kind === 'scene') renameScene(doc, sceneById(doc, r.id) ?? doc.scene, name);
      else if (r.kind === 'modifier' && r.ob) {
        const m = doc.objects[r.ob.id]?.modifiers.find((x) => x.id === r.id);
        if (m) m.name = name;
      } else if (r.kind === 'constraint' && r.ob) {
        const c = doc.objects[r.ob.id]?.constraints.find((x) => x.id === r.id);
        if (c) c.name = name;
      } else if (r.kind === 'vgroup' && r.ob?.data) {
        const g = doc.meshes[r.ob.data]?.vertex_groups?.find((x) => x.name === r.label);
        if (g) g.name = name;
      } else if (r.table && r.id) {
        const t = tables[r.table];
        if (t?.[r.id])
          t[r.id].name = ['objects', 'meshes', 'materials', 'collections', 'curves', 'lights', 'cameras', 'armatures', 'actions', 'images', 'node_groups', 'texts'].includes(r.table)
            ? uniqueName(doc, name, r.table as 'meshes')
            : name;
      }
      app.pushUndo('Rename');
    }
    app.changed('doc');
    this.update();
  }

  // ---------------------------------------------------------------------------
  // view operations

  /** Open the parents of the active element and scroll it into view. */
  showActive() {
    const doc = app.doc;
    const act = doc.scene.active_object;
    let ekey: string | null = null;
    if (act && doc.objects[act] && !(this.activeKey?.startsWith('c:') ?? false)) {
      ekey = `o:${act}`;
      const cols = Object.values(doc.collections).filter((c) => c.objects.includes(act));
      for (const c of cols) for (const a of [...ancestorCollections(doc, c.id), c.id]) this.setOpen(`c:${a}`, true);
      let p = doc.objects[act].parent;
      while (p && doc.objects[p]) {
        this.setOpen(`o:${p}`, true);
        for (const c of Object.values(doc.collections).filter((cc) => cc.objects.includes(p!))) for (const a of [...ancestorCollections(doc, c.id), c.id]) this.setOpen(`c:${a}`, true);
        p = doc.objects[p].parent;
      }
      if (this.displayMode === 'BLENDER_FILE') {
        this.setOpen('file', true);
        this.setOpen('g:objects', true);
        ekey = `id:objects:${act}`;
      }
    } else {
      const cid = this.activeKey?.startsWith('c:') ? this.activeKey.slice(2) : activeCollection(doc);
      ekey = `c:${cid}`;
      for (const a of ancestorCollections(doc, cid)) this.setOpen(`c:${a}`, true);
    }
    this.setOpen('scene', true);
    this.update();
    const i = this.rows.findIndex((r) => r.ekey === ekey);
    if (i >= 0) {
      this.activeKey = this.rows[i].ekey;
      this.scrollToRow(i, 'center');
    }
  }

  /** Open collections and objects with children; close everything else. */
  showHierarchy() {
    const kids = childrenMap(app.doc);
    for (const e of this.allElements()) {
      if (!e.hasKids) continue;
      if (e.kind === 'collection' || e.kind === 'scene' || e.kind === 'file') this.setOpen(e.ekey, true);
      else if (e.kind === 'object') this.setOpen(e.ekey, kids.has(e.ekey.slice(2)));
      else this.setOpen(e.ekey, false);
    }
    this.update();
    this.list.scrollTop = 0;
  }

  /** Expand (or collapse) one more level of the tree. */
  showOneLevel(open: boolean) {
    const els = this.allElements().filter((e) => e.hasKids && e.parentOpen);
    if (open) {
      const closed = els.filter((e) => !e.open);
      if (!closed.length) return;
      const d = Math.min(...closed.map((e) => e.depth));
      for (const e of closed) if (e.depth === d) this.setOpen(e.ekey, true);
    } else {
      const opened = els.filter((e) => e.open);
      if (!opened.length) return;
      const d = Math.max(...opened.map((e) => e.depth));
      if (d === 0 && opened.length && this.displayMode !== 'VIEW_LAYER') return;
      for (const e of opened) if (e.depth === d) this.setOpen(e.ekey, false);
    }
    this.update();
  }

  /** Expand everything, or collapse everything when all is open. */
  expandedToggle() {
    const els = this.allElements().filter((e) => e.hasKids);
    const anyClosed = els.some((e) => !e.open && e.depth > 0);
    for (const e of els) if (e.depth > 0 || anyClosed) this.setOpen(e.ekey, anyClosed);
    this.update();
  }

  scrollPage(up: boolean) {
    this.list.scrollTop += (up ? -1 : 1) * Math.max(22, this.list.clientHeight - 22);
  }

  /** Keyboard walk: move the active element, expand or collapse with Left / Right. */
  walk(direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', extend: boolean, toggleAll: boolean) {
    if (!this.rows.length) return;
    let i = this.cursorIndex();
    const cur = i >= 0 ? this.rows[i] : null;
    if (direction === 'LEFT' || direction === 'RIGHT') {
      if (!cur) return;
      const openIt = direction === 'RIGHT';
      if (cur.expandable && cur.expanded !== openIt) {
        this.toggleOpen(cur, toggleAll, openIt);
        return;
      }
      if (toggleAll && cur.expandable) {
        this.toggleOpen(cur, true, openIt);
        return;
      }
      // Left on a closed row walks to its parent; Right on an open row walks to its first child
      const target = openIt ? (cur.expanded ? this.rows[i + 1] : null) : this.rows.find((r) => r.key === cur.parentKey);
      if (target) this.walkTo(target, false);
      return;
    }
    if (i < 0) i = direction === 'DOWN' ? -1 : this.rows.length;
    let j = i + (direction === 'DOWN' ? 1 : -1);
    while (j >= 0 && j < this.rows.length && (this.rows[j].kind === 'group' || this.rows[j].kind === 'file')) j += direction === 'DOWN' ? 1 : -1;
    const target = this.rows[j];
    if (!target) return;
    if (extend && cur && this.isSelected(target) && this.isSelected(cur)) this.setSelected(cur, false);
    this.walkTo(target, extend);
  }

  private walkTo(target: Row, extend: boolean) {
    const before = this.selectionSignature();
    if (target.ob) this.prepareModeSwitch(target.ob);
    if (!extend) this.deselectAll();
    if (target.kind !== 'collection' || target.id !== app.doc.scene.collection) this.setSelected(target, true);
    this.activate(target);
    this.commitSelection(before);
    requestAnimationFrame(() => {
      const i = this.rows.findIndex((r) => r.key === target.key);
      if (i >= 0) this.scrollToRow(i);
    });
  }

  selectAll(action: 'SELECT' | 'DESELECT' | 'INVERT' | 'TOGGLE') {
    const before = this.selectionSignature();
    const rows = this.rows.filter((r) => r.kind !== 'group' && r.kind !== 'file' && r.kind !== 'scene' && !(r.kind === 'collection' && r.id === app.doc.scene.collection));
    if (action === 'TOGGLE') action = rows.some((r) => this.isSelected(r)) ? 'DESELECT' : 'SELECT';
    if (action === 'DESELECT') this.deselectAll();
    else if (action === 'SELECT') {
      for (const r of rows) this.setSelected(r, true);
      // objects inside collapsed rows count too
      if (this.filter.use_sync_select && this.displayMode !== 'ORPHAN_DATA') for (const id of app.doc.object_order) if (app.isVisible(id) && app.isSelectable(id)) app.doc.objects[id].select = true;
    } else {
      const states = rows.map((r) => [r, this.isSelected(r)] as const);
      const done = new Set<string>();
      for (const [r, s] of states) {
        if (done.has(r.ekey)) continue;
        done.add(r.ekey);
        this.setSelected(r, !s);
      }
    }
    this.commitSelection(before);
  }

  serialize() {
    return { displayMode: this.displayMode, filter: { ...this.filter }, open: [...this.open].slice(-500) };
  }

  dispose() {
    setCurrentOutliner(null, false, this);
  }
}

// ---------------------------------------------------------------------------
// dropping outliner items into the 3D viewport: collections become instances, materials go
// onto the object under the pointer

let viewportDrag: DragInfo | null = null;

/** The outliner item being dragged (for drop targets in other editors), cleared once dropped. */
export function outlinerDrag(clear = false): DragInfo | null {
  const d = viewportDrag;
  if (clear) viewportDrag = null;
  return d;
}

function viewportAt(e: DragEvent): { el: HTMLElement; pick(x: number, y: number, r?: number): { id: string } | null; unproject(x: number, y: number, d: Vector3): Vector3 } | null {
  const target = e.target as HTMLElement | null;
  if (!target?.closest?.('.view3d')) return null;
  const area = app.hoverArea as { type?: string; editor?: unknown } | null;
  if (area?.type !== 'VIEW_3D') return null;
  return area.editor as never;
}

addEventListener('dragover', (e) => {
  const d = viewportDrag;
  if (!d || (d.kind !== 'collection' && d.kind !== 'material') || (d.kind === 'material' && d.table && d.table !== 'materials') || !viewportAt(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

addEventListener('drop', (e) => {
  const d = viewportDrag;
  const v = d ? viewportAt(e) : null;
  if (!d || !v) return;
  e.preventDefault();
  viewportDrag = null;
  const r = v.el.getBoundingClientRect();
  const x = e.clientX - r.left,
    y = e.clientY - r.top;
  if (d.kind === 'collection') {
    if (app.doc.mode !== 'OBJECT') return;
    const p = surfaceHit(v as never, x, y) ?? v.unproject(x, y, new Vector3(...app.doc.scene.cursor.location));
    app.run('object.collection_instance_add', { collection: d.id, location: [p.x, p.y, p.z] }, { invoke: false });
  } else if (d.kind === 'material') {
    const hit = v.pick(x, y, 4);
    if (hit) app.run('outliner.material_drop', { object: hit.id, material: d.id }, { invoke: false });
    else app.report('WARNING', 'Drop the material on an object');
  }
});

registerEditor({
  id: 'OUTLINER',
  label: 'Outliner',
  icon: 'outliner',
  group: 'Data',
  create: (area, state) => new Outliner(area, state),
});

export { promptText, viewMenu };
