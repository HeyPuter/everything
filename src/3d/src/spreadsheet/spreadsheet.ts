// Spreadsheet editor: attribute values of the active (or pinned) object's evaluated, original or
// viewer geometry. Data set region (components, domains, nested instances, Grease Pencil layers)
// on the left, a virtualized table in the middle and row filters / columns in the sidebar.
// Columns can be resized, fitted, reordered, hidden and sorted; cells can be selected and copied.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type ChangeKind, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { linearToSrgb, checkbox, numberField, enumMenu, textField, button, colorSwatch, panel } from '../ui/widgets';
import type { Domain } from '../geonodes/types';
import { componentOf, geometryAt, referenceName, resolveSource, selectedRows, tableColumns, tableSize, viewerActiveFor, type Column, type ComponentKey, type EvalState, type Source, type TableId } from './data';
import { cellValues, filterOps, filterRows, newRowFilter, sortRows, toTSV, type RowFilter, type SortSpec } from './filter';
import { resultListeners } from '../geonodes/results';
import { registerIcons } from '../ui/icons';
import type { GeometrySet } from '../geonodes/geometry';

const ROW_H = 20;

registerIcons({
  // a 4×4 grid of dots in brackets
  ss_matrix: '<path class="s" d="M3.5 2.5h-1.5v11h1.5M12.5 2.5h1.5v11h-1.5" fill="none" stroke-width="1.2"/><path class="f" d="M4.5 4h1.6v1.6H4.5zM7.2 4h1.6v1.6H7.2zM9.9 4h1.6v1.6H9.9zM4.5 7.2h1.6v1.6H4.5zM7.2 7.2h1.6v1.6H7.2zM9.9 7.2h1.6v1.6H9.9zM4.5 10.4h1.6V12H4.5zM7.2 10.4h1.6V12H7.2zM9.9 10.4h1.6V12H9.9z"/>',
});
const MIN_COL_W = 40;

interface DomainEntry {
  key: ComponentKey;
  domain: Domain | 'LAYER';
  label: string;
  icon: string;
}

const COMPONENTS: { label: string; icon: string; key: ComponentKey; domains: DomainEntry[] }[] = [
  {
    label: 'Mesh',
    icon: 'mesh_data',
    key: 'MESH',
    domains: [
      { key: 'MESH', domain: 'POINT', label: 'Vertex', icon: 'ss_vertex' },
      { key: 'MESH', domain: 'EDGE', label: 'Edge', icon: 'ss_edge' },
      { key: 'MESH', domain: 'FACE', label: 'Face', icon: 'ss_face' },
      { key: 'MESH', domain: 'CORNER', label: 'Face Corner', icon: 'ss_corner' },
    ],
  },
  {
    label: 'Curve',
    icon: 'curve_data',
    key: 'CURVES',
    domains: [
      { key: 'CURVES', domain: 'POINT', label: 'Control Point', icon: 'ss_control_point' },
      { key: 'CURVES', domain: 'CURVE', label: 'Spline', icon: 'ss_spline' },
    ],
  },
  {
    label: 'Grease Pencil',
    icon: 'outliner_ob_greasepencil',
    key: 'GREASE_PENCIL',
    domains: [{ key: 'GREASE_PENCIL', domain: 'LAYER', label: 'Layer', icon: 'outliner_data_gp_layer' }],
  },
  {
    label: 'Point Cloud',
    icon: 'outliner_ob_pointcloud',
    key: 'POINTS',
    domains: [{ key: 'POINTS', domain: 'POINT', label: 'Point', icon: 'ss_point' }],
  },
];

/** Compact element counts (3.6K, 1.2M). */
export const shortCount = (n: number) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`);

/** Default width of a column by type. */
export function defaultColumnWidth(c: Column): number {
  switch (c.type) {
    case 'STRING':
      return 140;
    case 'BOOLEAN':
      return 70;
    case 'INT':
    case 'INT8':
      return 80;
    case 'INT2':
      return 110;
    case 'FLOAT':
      return 90;
    case 'FLOAT2':
      return 150;
    case 'FLOAT_COLOR':
      return 260;
    case 'FLOAT4X4':
      return 110;
    default:
      return 210;
  }
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(s: string) {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    if (measureCtx) measureCtx.font = '11px Inter, system-ui, sans-serif';
  }
  return measureCtx ? measureCtx.measureText(s).width : s.length * 6.5;
}

const sameTable = (a: TableId, b: TableId) => a.key === b.key && a.domain === b.domain && a.layer === b.layer && a.path.join('/') === b.path.join('/');

interface CellSel {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export class SpreadsheetEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Spreadsheet Generic'];
  state: EvalState = 'EVALUATED';
  table: TableId = { path: [], key: 'MESH', domain: 'POINT' };
  selectedOnly = false;
  showLeft = true;
  showSidebar = false;
  internal = false;
  pinned: string | null = null;
  useFilter = true;
  filters: RowFilter[] = [];
  sort: SortSpec | null = null;
  widths: Record<string, number> = {};
  /** column order by name (columns not listed follow in their natural order) */
  order: string[] = [];
  hidden: string[] = [];
  /** expanded instance nodes of the data set tree (path keys) */
  expanded = new Set<string>(['i:']);
  sel: CellSel | null = null;

  private left: HTMLElement;
  private main: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private spacer: HTMLElement;
  private rowsEl: HTMLElement;
  private footer: HTMLElement;
  private side: HTMLElement;
  private src: Source | null = null;
  private geo: GeometrySet | null = null;
  /** all columns of the table and the visible ones in display order */
  private allCols: Column[] = [];
  cols: Column[] = [];
  /** displayed row → element index */
  rows: Int32Array = new Int32Array(0);
  private total = 0;
  private rowsKey = '';
  private wasViewer = false;
  private raf = 0;
  private unsub: () => void;
  private dragging = false;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    const st = (state ?? {}) as Partial<{
      state: EvalState;
      table: TableId;
      key: ComponentKey;
      domain: Domain;
      selectedOnly: boolean;
      showLeft: boolean;
      showSidebar: boolean;
      internal: boolean;
      pinned: string | null;
      useFilter: boolean;
      filters: RowFilter[];
      sort: SortSpec | null;
      widths: Record<string, number>;
      order: string[];
      hidden: string[];
    }>;
    if (st.state) this.state = st.state;
    if (st.table) this.table = { ...st.table, path: [...(st.table.path ?? [])] };
    else if (st.key) this.table = { path: [], key: st.key, domain: st.domain ?? 'POINT' };
    if (st.selectedOnly) this.selectedOnly = true;
    if (st.showLeft === false) this.showLeft = false;
    if (st.showSidebar) this.showSidebar = true;
    if (st.internal) this.internal = true;
    if (st.pinned) this.pinned = st.pinned;
    if (st.useFilter === false) this.useFilter = false;
    if (Array.isArray(st.filters)) this.filters = st.filters.map((f) => ({ ...newRowFilter(), ...f }));
    if (st.sort) this.sort = st.sort;
    if (st.widths) this.widths = { ...st.widths };
    if (st.order) this.order = [...st.order];
    if (st.hidden) this.hidden = [...st.hidden];
    const div = (cls: string) => {
      const d = document.createElement('div');
      d.className = cls;
      return d;
    };
    this.el = div('ss-editor');
    this.el.tabIndex = -1;
    this.left = div('ss-left');
    this.main = div('ss-main');
    this.head = div('ss-head');
    this.body = div('ss-body');
    this.spacer = div('ss-spacer');
    this.rowsEl = div('ss-rows');
    this.body.append(this.spacer, this.rowsEl);
    this.footer = div('ss-footer');
    this.side = div('ss-side');
    this.main.append(this.head, this.body, this.footer);
    this.el.append(this.left, this.main, this.side);
    this.body.addEventListener('scroll', () => {
      this.head.scrollLeft = this.body.scrollLeft;
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.renderRows());
    });
    this.rowsEl.addEventListener('pointerdown', (e) => this.cellDown(e));
    this.rowsEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(this.cellMenu(), { x: e.clientX, y: e.clientY });
    });
    new ResizeObserver(() => this.renderRows()).observe(this.body);
    // refresh when geometry nodes re-evaluate (viewer changes etc.)
    const listener = () => {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.refresh());
    };
    resultListeners.add(listener);
    this.unsub = () => resultListeners.delete(listener);
    this.refresh();
  }

  // ------------------------------------------------------------------------- header

  header(): Child {
    const menu = (label: string, items: () => MenuItem[]) =>
      h(
        'button',
        {
          class: 'hdr-menu',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(items(), e.currentTarget as HTMLElement);
          },
        },
        label,
      );
    const src = this.src;
    const viewer = viewerActiveFor(src?.ob ?? app.activeObject);
    const states: [EvalState, string, string, string][] = [
      ['EVALUATED', 'Evaluated', 'modifier', 'Data of the object after its modifiers'],
      ['ORIGINAL', 'Original', 'object_datamode', 'Data of the object without modifiers'],
      ['VIEWER_NODE', 'Viewer Node', 'hide_off', 'Data shown by the active Viewer node'],
    ];
    const cur = states.find((x) => x[0] === this.state) ?? states[0];
    return h(
      'div',
      { class: 'hdr-row ss-header' },
      menu('View', () => this.viewMenu()),
      h(
        'button',
        {
          class: 'hdr-menu ss-state',
          'data-tip': 'Object Evaluation State\nWhich state of the object the table shows',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              states.map(([v, label, ic, description]) => ({
                label,
                icon: ic,
                description,
                active: v === this.state,
                disabled: v === 'VIEWER_NODE' && !viewer,
                action: () => {
                  this.state = v;
                  this.refresh();
                  app.changed('ui');
                },
              })),
              e.currentTarget as HTMLElement,
              { title: 'Object Evaluation State' },
            );
          },
        },
        icon(cur[2]),
        cur[1],
        icon('down_arrow_hlt', 'tiny'),
      ),
      h(
        'div',
        { class: 'ss-crumbs' },
        (src?.crumbs ?? []).map(([ic, name], i) => [
          i ? h('span', { key: `s${i}`, class: 'ss-crumb-sep' }, icon('right_arrow')) : null,
          h('span', { key: `c${i}`, class: 'ss-crumb' }, icon(ic), name),
        ]),
        this.table.path.map((ri, i) => {
          const g = this.src ? geometryAt(this.src.geo, this.table.path.slice(0, i)) : null;
          return [h('span', { key: `ps${i}`, class: 'ss-crumb-sep' }, icon('right_arrow')), h('span', { key: `p${i}`, class: 'ss-crumb' }, icon('ss_instance'), referenceName(g?.instances?.references[ri], ri))];
        }),
      ),
      h('div', { class: 'hdr-spacer' }),
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: !!this.pinned },
          'data-tip': this.pinned ? `Unpin\nFollow the active object again (pinned: ${app.doc.objects[this.pinned]?.name ?? '?'})` : 'Pin\nKeep showing this object when the active object changes',
          onclick: () => app.run('spreadsheet.toggle_pin', {}, { area: this.area }),
        },
        icon(this.pinned ? 'pinned' : 'unpinned'),
      ),
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: this.selectedOnly },
          'data-tip': 'Selected Only\nOnly include rows of selected elements (Edit Mode)',
          onclick: () => {
            this.selectedOnly = !this.selectedOnly;
            this.refresh();
            app.changed('ui');
          },
        },
        icon('restrict_select_off'),
      ),
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: this.useFilter && this.filters.some((f) => f.enabled) },
          'data-tip': `Use Filter\nApply the row filters of the sidebar${this.filters.length ? ` (${this.filters.filter((f) => f.enabled).length} enabled)` : ''}`,
          onclick: () => {
            this.useFilter = !this.useFilter;
            if (this.useFilter && !this.filters.length) this.showSidebar = true;
            this.refresh();
            app.changed('ui');
          },
        },
        icon('filter'),
      ),
    );
  }

  viewMenu(): MenuItem[] {
    return [
      { label: 'Data Set Region', checked: this.showLeft, shortcut: 'T', action: () => this.toggleLeft() },
      { label: 'Sidebar', checked: this.showSidebar, shortcut: 'N', action: () => this.toggleSidebar() },
      { separator: true },
      { label: 'Internal Attributes', checked: this.internal, description: 'Also list attributes whose names start with a dot', action: () => ((this.internal = !this.internal), this.refresh(), app.changed('ui')) },
      { label: 'Show All Columns', disabled: !this.hidden.length, action: () => ((this.hidden = []), this.refresh()) },
      { label: 'Reset Column Layout', description: 'Default widths and order', action: () => ((this.widths = {}), (this.order = []), (this.hidden = []), this.refresh()) },
      { separator: true },
      { label: 'Copy', shortcut: 'Ctrl C', op: 'spreadsheet.copy_cells' },
      { label: 'Select All', shortcut: 'Ctrl A', op: 'spreadsheet.select_all' },
      { separator: true },
      { label: 'Area', submenu: () => this.area.areaMenu() },
    ];
  }

  toggleLeft() {
    this.showLeft = !this.showLeft;
    this.refresh();
    app.changed('ui');
  }

  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    this.refresh();
    app.changed('ui');
  }

  update(kinds: Set<ChangeKind>) {
    if (this.dragging) return;
    if (kinds.has('doc') || kinds.has('select') || kinds.has('frame') || kinds.has('mode') || kinds.has('geometry') || kinds.has('ui')) this.refresh();
  }

  resize() {
    this.renderRows();
  }

  // ------------------------------------------------------------------------- data

  /** Rebuild the data set list, the columns and the displayed rows. */
  refresh() {
    const ob = (this.pinned ? app.doc.objects[this.pinned] : null) ?? app.activeObject;
    if (this.pinned && !app.doc.objects[this.pinned]) this.pinned = null;
    const viewer = viewerActiveFor(ob);
    // activating a viewer switches the spreadsheet to its data
    if (viewer && !this.wasViewer) this.state = 'VIEWER_NODE';
    if (!viewer && this.state === 'VIEWER_NODE') this.state = 'EVALUATED';
    this.wasViewer = viewer;
    this.src = resolveSource(this.state, this.pinned);
    let g = this.src ? geometryAt(this.src.geo, this.table.path) : null;
    if (!g && this.src) {
      this.table = { path: [], key: this.table.key, domain: this.table.domain };
      g = this.src.geo;
    }
    this.geo = g;
    this.left.hidden = !this.showLeft;
    this.side.hidden = !this.showSidebar;
    patch(this.left, this.src ? this.treeRows(this.src.geo, [], 0) : [h('div', { class: 'ss-empty' }, 'No active object')]);
    this.allCols = g ? tableColumns(g, this.table, this.internal) : [];
    this.cols = this.displayColumns();
    this.updateRows();
    this.renderHead();
    if (this.showSidebar) patch(this.side, this.sidebar());
    const filtered = this.rows.length !== this.total;
    patch(this.footer, [
      h('span', { key: 'r' }, filtered ? `Rows: ${this.rows.length.toLocaleString()} / ${this.total.toLocaleString()}` : `Rows: ${this.total.toLocaleString()}`),
      h('span', { key: 's1', class: 'ss-sep' }, '|'),
      h('span', { key: 'c' }, `Columns: ${this.cols.length}${this.hidden.length && this.allCols.some((c) => this.hidden.includes(c.name)) ? ` (${this.allCols.length - this.cols.length} hidden)` : ''}`),
      this.sel ? [h('span', { key: 's2', class: 'ss-sep' }, '|'), h('span', { key: 'sel' }, `Selected: ${Math.abs(this.sel.r1 - this.sel.r0) + 1} × ${Math.abs(this.sel.c1 - this.sel.c0) + 1}`)] : null,
    ]);
    this.renderRows();
  }

  /** Visible columns in display order. */
  private displayColumns(): Column[] {
    const vis = this.allCols.filter((c) => !this.hidden.includes(c.name));
    const pos = (c: Column) => {
      const i = this.order.indexOf(c.name);
      return i < 0 ? this.order.length + this.allCols.indexOf(c) : i;
    };
    return vis.sort((a, b) => pos(a) - pos(b));
  }

  /** Displayed rows: selection (Edit Mode), then filters, then sorting; cached on their inputs. */
  private updateRows() {
    const g = this.geo;
    const n = g ? tableSize(g, this.table) : 0;
    this.total = n;
    const base = this.selectedOnly && this.src ? selectedRows(this.src, this.table) : null;
    const filters = this.useFilter ? this.filters.filter((f) => f.enabled) : [];
    const sortCol = this.sort ? this.allCols.find((c) => c.name === this.sort!.column) : undefined;
    const key = JSON.stringify([n, this.table, filters, sortCol ? this.sort : null, this.allCols.map((c) => c.name)]);
    // the column arrays and the selection decide too: compare by identity
    const ids = [this.allCols.map((c) => c.data), base];
    if (key === this.rowsKey && sameIds(ids, this.rowsIds)) return;
    this.rowsKey = key;
    this.rowsIds = ids;
    let rows = filterRows(this.allCols, n, filters, base);
    if (sortCol && this.sort) rows = sortRows(rows, sortCol, this.sort);
    this.rows = rows;
    if (this.sel && (this.sel.r0 >= rows.length || this.sel.r1 >= rows.length)) this.sel = null;
  }
  private rowsIds: unknown[] = [];

  /** Rows (data set tree) for a geometry and its nested instances. */
  private treeRows(g: GeometrySet, path: number[], depth: number): Child[] {
    const out: Child[] = [];
    const pk = path.join('/');
    for (const comp of COMPONENTS) {
      const c = componentOf(g, comp.key);
      // nested geometry lists only the components it has
      if (depth > 0 && !c) continue;
      if (comp.key === 'GREASE_PENCIL' && !c && depth === 0 && !g.greasePencil) continue;
      out.push(h('div', { key: `h-${pk}-${comp.key}`, class: 'ss-left-head', style: { paddingLeft: `${6 + depth * 12}px` } }, icon(comp.icon), comp.label));
      for (const d of comp.domains) {
        const t: TableId = { path, key: d.key, domain: d.domain };
        out.push(this.leftRow(t, d.label, d.icon, tableSize(g, t), depth + 1));
      }
      // Grease Pencil layers with their strokes
      if (comp.key === 'GREASE_PENCIL' && g.greasePencil)
        g.greasePencil.layers.forEach((l, li) => {
          const lk = `l:${pk}:${li}`;
          const open = this.expanded.has(lk);
          out.push(this.expander(lk, open, l.name, 'outliner_data_gp_layer', depth + 1));
          if (open) {
            out.push(this.leftRow({ path, key: 'CURVES', domain: 'POINT', layer: li }, 'Control Point', 'ss_control_point', l.curves.pointCount, depth + 2));
            out.push(this.leftRow({ path, key: 'CURVES', domain: 'CURVE', layer: li }, 'Stroke', 'ss_spline', l.curves.curveCount, depth + 2));
          }
        });
    }
    const inst = g.instances;
    const ik = `i:${pk}`;
    const n = inst?.count ?? 0;
    const open = this.expanded.has(ik);
    out.push(
      this.leftRow({ path, key: 'INSTANCES', domain: 'INSTANCE' }, 'Instances', 'ss_instance', n, depth, inst?.references.length ? { key: ik, open } : undefined),
    );
    if (inst && open)
      inst.references.forEach((ref, ri) => {
        const rk = `r:${pk}/${ri}`;
        const ropen = this.expanded.has(rk);
        const hasGeo = !ref.geometry.isEmpty();
        out.push(this.expander(rk, ropen, referenceName(ref, ri), ref.type === 'OBJECT' ? 'object' : ref.type === 'COLLECTION' ? 'collection' : 'ss_instance', depth + 1, !hasGeo));
        if (ropen && hasGeo) out.push(...this.treeRows(ref.geometry, [...path, ri], depth + 2));
      });
    return out;
  }

  private expander(key: string, open: boolean, label: string, ic: string, depth: number, empty = false): Child {
    return h(
      'div',
      {
        key,
        class: { 'ss-left-row': true, 'ss-left-node': true, empty },
        style: { paddingLeft: `${6 + depth * 12}px` },
        onclick: () => {
          if (empty) return;
          if (open) this.expanded.delete(key);
          else this.expanded.add(key);
          this.refresh();
        },
      },
      h('span', { class: 'ss-tri' }, empty ? null : icon(open ? 'disclosure_tri_down' : 'disclosure_tri_right')),
      icon(ic),
      h('span', { class: 'ss-left-label' }, label),
    );
  }

  private leftRow(t: TableId, label: string, ic: string, n: number, depth: number, exp?: { key: string; open: boolean }): Child {
    const active = sameTable(this.table, t);
    return h(
      'div',
      {
        key: `${t.path.join('/')}:${t.key}:${t.domain}:${t.layer ?? ''}`,
        class: { 'ss-left-row': true, active, empty: !n },
        style: { paddingLeft: `${6 + depth * 12}px` },
        'data-table': `${t.key}:${t.domain}`,
        onclick: () => this.setTable(t),
      },
      exp
        ? h(
            'span',
            {
              class: 'ss-tri',
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                if (exp.open) this.expanded.delete(exp.key);
                else this.expanded.add(exp.key);
                this.refresh();
              },
            },
            icon(exp.open ? 'disclosure_tri_down' : 'disclosure_tri_right'),
          )
        : h('span', { class: 'ss-tri' }),
      icon(ic),
      h('span', { class: 'ss-left-label' }, label),
      h('span', { class: 'ss-left-count', 'data-tip': n.toLocaleString() }, shortCount(n)),
    );
  }

  setTable(t: TableId) {
    this.table = { ...t, path: [...t.path] };
    this.body.scrollTop = 0;
    this.sel = null;
    this.refresh();
    app.changed('ui');
  }

  // ------------------------------------------------------------------------- columns

  colWidth(c: Column) {
    return Math.max(MIN_COL_W, this.widths[c.name] ?? defaultColumnWidth(c));
  }

  private indexWidth() {
    return Math.max(44, String(Math.max(0, this.total - 1)).length * 8 + 22);
  }

  /** Width that fits a column's header and the values of (a sample of) its rows. */
  fitWidth(c: Column): number {
    let w = textWidth(c.name) + 34;
    const rows = this.rows;
    const step = rows.length > 4000 ? Math.ceil(rows.length / 4000) : 1;
    const per = new Array<number>(c.comps).fill(0);
    for (let r = 0; r < rows.length; r += step) {
      const vals = cellValues(c, rows[r]);
      vals.forEach((s, k) => (per[k] = Math.max(per[k] ?? 0, textWidth(s))));
    }
    if (c.type === 'FLOAT4X4') return 110;
    let cw = per.reduce((s, x) => s + Math.max(x, c.type === 'STRING' ? 0 : 18), 0) + (per.length - 1) * 10 + 20;
    if (c.type === 'FLOAT_COLOR') cw += 30;
    if (c.type === 'BOOLEAN') cw = 50;
    w = Math.max(w, cw);
    return Math.min(600, Math.ceil(w));
  }

  fitColumn(name: string) {
    const c = this.allCols.find((x) => x.name === name);
    if (!c) return false;
    this.widths[name] = this.fitWidth(c);
    this.refresh();
    return true;
  }

  /** Move a column before another (or to the end when `before` is null). */
  moveColumn(name: string, before: string | null) {
    const names = this.cols.map((c) => c.name);
    const from = names.indexOf(name);
    if (from < 0) return;
    names.splice(from, 1);
    const to = before ? names.indexOf(before) : names.length;
    names.splice(to < 0 ? names.length : to, 0, name);
    // keep hidden columns' relative places by appending them after
    this.order = [...names, ...this.order.filter((n) => !names.includes(n))];
    this.refresh();
  }

  setSort(name: string, dir: 1 | -1 | 0, comp = 0) {
    this.sort = dir ? { column: name, dir, comp } : null;
    this.sel = null;
    this.refresh();
    app.changed('ui');
  }

  private renderHead() {
    const idxW = this.indexWidth();
    patch(this.head, [
      h('div', { key: '#', class: 'ss-hcell ss-idx', style: { width: `${idxW}px` } }, ''),
      ...this.cols.map((c, ci) => {
        const sorted = this.sort?.column === c.name ? this.sort : null;
        return h(
          'div',
          {
            key: `h:${c.name}`,
            class: { 'ss-hcell': true, virtual: !!c.virtual, sorted: !!sorted },
            style: { width: `${this.colWidth(c)}px` },
            'data-col': c.name,
            'data-tip': `${c.name}${c.virtual ? ' (computed)' : ''}\n${typeLabel(c)}. Click to sort, drag to move, drag the edge to resize`,
            onpointerdown: (e: PointerEvent) => this.headerDown(e, c, ci),
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              openMenu(this.columnMenu(c), { x: e.clientX, y: e.clientY });
            },
          },
          h('span', { class: 'ss-hlabel' }, c.name),
          sorted ? h('span', { class: 'ss-sort' }, icon(sorted.dir > 0 ? 'triangle_up' : 'triangle_down'), sorted.comp !== 0 && c.comps > 1 ? (sorted.comp < 0 ? 'len' : 'xyzw'[sorted.comp]) : null) : null,
          h('span', {
            class: 'ss-resize',
            ondblclick: (e: MouseEvent) => {
              e.stopPropagation();
              app.run('spreadsheet.fit_column', { column: c.name }, { area: this.area });
            },
          }),
        );
      }),
    ]);
    const total = idxW + this.cols.reduce((s, c) => s + this.colWidth(c), 0);
    this.spacer.style.height = `${this.rows.length * ROW_H}px`;
    this.spacer.style.width = `${total}px`;
  }

  private headerDown(e: PointerEvent, c: Column, ci: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    const cell = e.currentTarget as HTMLElement;
    const resize = (e.target as HTMLElement).classList.contains('ss-resize');
    const x0 = e.clientX;
    const w0 = this.colWidth(c);
    let moved = false;
    let marker: HTMLElement | null = null;
    let target: string | null | undefined;
    this.dragging = true;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      if (resize) {
        this.widths[c.name] = Math.max(MIN_COL_W, Math.round(w0 + dx));
        this.renderHead();
        this.renderRows();
        return;
      }
      // reorder: find the gap under the pointer
      const cells = [...this.head.querySelectorAll<HTMLElement>('.ss-hcell[data-col]')];
      let before: string | null = null;
      let gapX = cells.length ? cells[cells.length - 1].getBoundingClientRect().right : 0;
      for (const el of cells) {
        const r = el.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          before = el.dataset.col!;
          gapX = r.left;
          break;
        }
      }
      target = before;
      cell.classList.add('dragging');
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'ss-drop';
        this.main.append(marker);
      }
      const mr = this.main.getBoundingClientRect();
      marker.style.left = `${gapX - mr.left - 1}px`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      this.dragging = false;
      marker?.remove();
      cell.classList.remove('dragging');
      if (resize) {
        if (moved) this.refresh();
        return;
      }
      if (moved) {
        if (target !== undefined && target !== c.name) this.moveColumn(c.name, target);
        return;
      }
      // click: sort ascending → descending → off
      const s = this.sort?.column === c.name ? this.sort : null;
      if (!s) this.setSort(c.name, 1);
      else if (s.dir > 0) this.setSort(c.name, -1, s.comp);
      else this.setSort(c.name, 0);
      void ci;
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  private columnMenu(c: Column): MenuItem[] {
    const items: MenuItem[] = [
      { heading: c.name },
      { label: 'Sort Ascending', icon: 'triangle_up', action: () => this.setSort(c.name, 1) },
      { label: 'Sort Descending', icon: 'triangle_down', action: () => this.setSort(c.name, -1) },
    ];
    if (c.comps > 1 && c.type !== 'FLOAT4X4' && c.type !== 'STRING') {
      const names = c.type === 'FLOAT_COLOR' ? ['Red', 'Green', 'Blue', 'Alpha'] : ['X', 'Y', 'Z', 'W'];
      items.push({
        label: 'Sort By',
        submenu: () => [
          ...names.slice(0, c.comps).map((n, k) => ({ label: n, active: this.sort?.column === c.name && this.sort.comp === k, action: () => this.setSort(c.name, this.sort?.column === c.name ? this.sort.dir : 1, k) })),
          { label: 'Length', active: this.sort?.column === c.name && this.sort.comp < 0, action: () => this.setSort(c.name, this.sort?.column === c.name ? this.sort.dir : 1, -1) },
        ],
      });
    }
    items.push(
      { label: 'Clear Sorting', disabled: !this.sort, action: () => this.setSort('', 0) },
      { separator: true },
      { label: 'Fit Width', shortcut: 'Double-click edge', op: 'spreadsheet.fit_column', props: { column: c.name } },
      { label: 'Hide Column', icon: 'hide_on', action: () => ((this.hidden = [...this.hidden, c.name]), this.refresh()) },
      { label: 'Show All Columns', disabled: !this.hidden.length, action: () => ((this.hidden = []), this.refresh()) },
      { separator: true },
      { label: 'Add Row Filter', icon: 'filter', op: 'spreadsheet.add_row_filter_rule', props: { column: c.name } },
      { label: 'Copy Column', action: () => this.copyText(toTSV([c], this.rows, { header: true }), `${this.rows.length} values`) },
    );
    return items;
  }

  // ------------------------------------------------------------------------- cells

  private cell(c: Column, i: number, ci: number, r: number): Child {
    const w = this.colWidth(c);
    const d = c.data;
    let content: Child;
    if (c.type === 'STRING') content = h('span', { class: 'ss-str' }, (d as string[])[i] ?? '');
    else if (c.type === 'BOOLEAN') content = h('span', { class: { 'ss-bool': true, on: !!(d as Uint8Array)[i] } }, icon((d as Uint8Array)[i] ? 'checkbox_hlt' : 'checkbox_dehlt'));
    else if (c.type === 'FLOAT4X4') {
      const m = (d as Float32Array).subarray(i * 16, i * 16 + 16);
      const rows = [0, 1, 2, 3].map((rr) => [0, 1, 2, 3].map((cc) => m[cc * 4 + rr].toFixed(3).padStart(8)).join(' ')).join('\n');
      content = h('span', { class: 'ss-mat', 'data-tip': `4×4 Matrix\n${rows}` }, icon('ss_matrix'), '4×4');
    } else {
      const vals = cellValues(c, i);
      if (c.type === 'FLOAT_COLOR') {
        const a = d as Float32Array;
        const css = `rgba(${[0, 1, 2].map((k) => Math.round(Math.max(0, Math.min(1, linearToSrgb(a[i * 4 + k]))) * 255)).join(',')},${Math.max(0, Math.min(1, a[i * 4 + 3] ?? 1))})`;
        content = [h('span', { key: 'sw', class: 'ss-swatch', style: { background: css } }), ...vals.map((v, k) => h('span', { key: String(k), class: 'ss-num' }, v))];
      } else content = vals.map((v, k) => h('span', { key: String(k), class: 'ss-num' }, v));
    }
    const s = this.sel;
    const selected = !!s && r >= Math.min(s.r0, s.r1) && r <= Math.max(s.r0, s.r1) && ci >= Math.min(s.c0, s.c1) && ci <= Math.max(s.c0, s.c1);
    return h('div', { class: { 'ss-cell': true, sel: selected, [`t-${c.type.toLowerCase()}`]: true }, style: { width: `${w}px` }, 'data-c': String(ci) }, content);
  }

  renderRows() {
    const H = this.body.clientHeight || 400;
    const n = this.rows.length;
    const first = Math.max(0, Math.floor(this.body.scrollTop / ROW_H) - 2);
    const last = Math.min(n, Math.ceil((this.body.scrollTop + H) / ROW_H) + 2);
    const idxW = this.indexWidth();
    const s = this.sel;
    const out: Child[] = [];
    for (let r = first; r < last; r++) {
      const i = this.rows[r];
      const rowSel = !!s && s.c0 === -1 && r >= Math.min(s.r0, s.r1) && r <= Math.max(s.r0, s.r1);
      out.push(
        h(
          'div',
          { key: String(r), class: { 'ss-row': true, odd: r % 2 === 1, sel: rowSel }, style: { top: `${r * ROW_H}px` }, 'data-r': String(r) },
          h('div', { class: 'ss-cell ss-idx', style: { width: `${idxW}px` }, 'data-c': '-1' }, String(i)),
          this.cols.map((c, ci) => this.cell(c, i, ci, r)),
        ),
      );
    }
    patch(this.rowsEl, out);
  }

  /** Cell under a pointer event: display row and column (-1 for the index column). */
  private cellAt(e: { clientX: number; clientY: number }): { r: number; c: number } | null {
    const br = this.body.getBoundingClientRect();
    const y = e.clientY - br.top + this.body.scrollTop;
    const r = Math.floor(y / ROW_H);
    if (r < 0 || r >= this.rows.length) return null;
    let x = e.clientX - br.left + this.body.scrollLeft - this.indexWidth();
    if (x < 0) return { r, c: -1 };
    for (let ci = 0; ci < this.cols.length; ci++) {
      x -= this.colWidth(this.cols[ci]);
      if (x < 0) return { r, c: ci };
    }
    return { r, c: this.cols.length - 1 };
  }

  private cellDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const at = this.cellAt(e);
    if (!at) return;
    e.preventDefault();
    this.el.focus({ preventScroll: true });
    const lastC = Math.max(0, this.cols.length - 1);
    // index column: whole rows
    const rowMode = at.c < 0;
    const anchor = e.shiftKey && this.sel ? { r: this.sel.r0, c: this.sel.c0 } : at;
    const apply = (to: { r: number; c: number }) => {
      this.sel = rowMode || (e.shiftKey && this.sel?.c0 === -1) ? { r0: anchor.r, r1: to.r, c0: -1, c1: lastC } : { r0: anchor.r, r1: to.r, c0: anchor.c, c1: Math.max(0, to.c) };
      if (this.sel.c0 === -1 && !rowMode && !e.shiftKey) this.sel.c0 = 0;
      this.renderRows();
    };
    apply(at);
    this.refreshFooter();
    const move = (ev: PointerEvent) => {
      const to = this.cellAt(ev);
      if (to) apply(to);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      this.refreshFooter();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  private refreshFooter() {
    // the footer shows the selection size
    this.refresh();
  }

  /** Selected block as columns + rows (whole table when nothing is selected). */
  selection(): { cols: Column[]; rows: Int32Array; whole: boolean } {
    const s = this.sel;
    if (!s) return { cols: this.cols, rows: this.rows, whole: true };
    const r0 = Math.min(s.r0, s.r1),
      r1 = Math.max(s.r0, s.r1);
    const c0 = s.c0 < 0 ? 0 : Math.min(s.c0, s.c1),
      c1 = s.c0 < 0 ? this.cols.length - 1 : Math.max(s.c0, s.c1);
    return { cols: this.cols.slice(c0, c1 + 1), rows: this.rows.subarray(r0, r1 + 1), whole: s.c0 < 0 };
  }

  copyText(text: string, what: string) {
    lastCopied = text;
    try {
      void navigator.clipboard?.writeText(text).catch(() => {});
    } catch {
      // the text is kept in lastCopied for tests and the app
    }
    app.report('INFO', `Copied ${what}`);
  }

  copySelection(header = false) {
    const sel = this.selection();
    if (!sel.rows.length || !sel.cols.length) return false;
    this.copyText(toTSV(sel.cols, sel.rows, { header: header || sel.whole, index: sel.whole }), `${sel.rows.length} row${sel.rows.length === 1 ? '' : 's'}`);
    return true;
  }

  private cellMenu(): MenuItem[] {
    return [
      { label: 'Copy', shortcut: 'Ctrl C', op: 'spreadsheet.copy_cells' },
      { label: 'Copy with Headers', op: 'spreadsheet.copy_cells', props: { header: true } },
      { separator: true },
      { label: 'Select All', shortcut: 'Ctrl A', op: 'spreadsheet.select_all' },
      { label: 'Deselect', disabled: !this.sel, action: () => ((this.sel = null), this.refresh()) },
    ];
  }

  // ------------------------------------------------------------------------- sidebar

  private sidebar(): Child {
    const cols = this.allCols;
    return h(
      'div',
      { class: 'ss-side-body' },
      panel(
        'ss-filters',
        'Filter Rules',
        () => [
          this.filters.map((f, i) => this.filterBox(f, i, cols)),
          button('ss-add-filter', [icon('add'), 'Add Row Filter'], () => app.run('spreadsheet.add_row_filter_rule', {}, { area: this.area }), {
            tip: 'Add Row Filter\nAdd a rule that hides rows whose value does not match',
          }),
        ],
        {
          header: checkbox('ss-use-filter', '', this.useFilter, (v) => ((this.useFilter = v), this.refresh(), app.changed('ui')), { tip: 'Use Filter\nApply the filter rules' }),
        },
      ),
      panel('ss-columns', 'Columns', () => [
        cols.map((c) =>
          h(
            'div',
            { key: c.name, class: 'ss-colrow' },
            checkbox(`ss-colvis-${c.name}`, c.name, !this.hidden.includes(c.name), (v) => {
              this.hidden = v ? this.hidden.filter((n) => n !== c.name) : [...this.hidden, c.name];
              this.refresh();
            }),
            h('span', { class: 'ss-coltype' }, typeLabel(c)),
          ),
        ),
        cols.length ? null : h('div', { class: 'ss-empty' }, 'No columns'),
      ]),
    );
  }

  private filterBox(f: RowFilter, i: number, cols: Column[]): Child {
    const c = cols.find((x) => x.name === f.column);
    const id = `ss-f${i}`;
    const set = () => {
      this.refresh();
      app.changed('ui');
    };
    const colItems = cols.map((x) => ({ value: x.name, label: x.name, description: typeLabel(x) }));
    if (f.column && !c) colItems.push({ value: f.column, label: f.column, description: 'Not in this table' });
    let value: Child = null;
    if (c) {
      const ops = filterOps(c);
      if (!ops.includes(f.operation)) f.operation = 'EQUAL';
      const opRow = ops.length > 1 ? row('Operation', enumMenu(`${id}-op`, ops.map((o) => ({ value: o, label: o === 'EQUAL' ? 'Equal To' : o === 'GREATER' ? 'Greater Than' : 'Less Than' })), f.operation, (v) => ((f.operation = v as RowFilter['operation']), set()))) : null;
      const num = (k: number, label: string, opts: { int?: boolean; angle?: boolean } = {}) =>
        numberField({
          id: `${id}-v${k}`,
          label,
          value: f.value[k] ?? 0,
          int: opts.int,
          unit: opts.angle ? 'angle' : 'none',
          precision: 3,
          set: (v) => {
            f.value[k] = v;
            set();
          },
        });
      const isFloat = c.type === 'FLOAT' || c.type === 'FLOAT2' || c.type === 'FLOAT_VECTOR' || c.type === 'FLOAT_COLOR' || c.type === 'QUATERNION';
      let fields: Child;
      if (c.type === 'STRING') fields = row('Value', textField(`${id}-text`, f.text, (v) => ((f.text = v), set()), { placeholder: 'Text or pattern (* ?)', live: true }));
      else if (c.type === 'BOOLEAN') fields = row('', checkbox(`${id}-bool`, 'Value', f.bool, (v) => ((f.bool = v), set())));
      else if (c.type === 'FLOAT_COLOR')
        fields = row(
          'Value',
          colorSwatch(`${id}-col`, [f.value[0] ?? 0, f.value[1] ?? 0, f.value[2] ?? 0, f.value[3] ?? 1], (v) => {
            f.value = [...v];
            set();
          }, { alpha: true }),
        );
      else if (c.comps === 1) fields = row('Value', num(0, '', { int: c.type === 'INT' || c.type === 'INT8' }));
      else {
        const names = ['X', 'Y', 'Z', 'W'];
        fields = h('div', { class: 'ss-fvec' }, Array.from({ length: c.comps }, (_, k) => row(k ? '' : 'Value', num(k, names[k], { int: c.type === 'INT2', angle: c.type === 'QUATERNION' }))));
      }
      const thr = isFloat && f.operation === 'EQUAL' ? row('Threshold', numberField({ id: `${id}-thr`, value: f.threshold, min: 0, precision: 4, step: 0.01, set: (v) => ((f.threshold = v), set()) })) : null;
      value = [opRow, fields, thr];
    } else if (f.column) value = h('div', { class: 'ss-fmissing' }, icon('info_small'), 'This table has no column with that name');
    else value = h('div', { class: 'ss-fmissing' }, 'Choose a column');
    return h(
      'div',
      { key: `f${i}`, class: { 'ss-filter': true, off: !f.enabled, missing: !!f.column && !c } },
      h(
        'div',
        { class: 'ss-filter-hdr' },
        h(
          'span',
          {
            class: 'ss-tri',
            onclick: () => ((f.expanded = !f.expanded), set()),
          },
          icon(f.expanded ? 'disclosure_tri_down' : 'disclosure_tri_right'),
        ),
        checkbox(`${id}-on`, '', f.enabled, (v) => ((f.enabled = v), set()), { tip: 'Enabled' }),
        enumMenu(`${id}-col`, colItems, f.column, (v) => ((f.column = v), set()), { className: 'ss-fcol', title: 'Column' }),
        h('button', { class: 'anim-tg', 'data-tip': 'Remove Row Filter', onclick: () => app.run('spreadsheet.remove_row_filter_rule', { index: i }, { area: this.area }) }, icon('x')),
      ),
      f.expanded ? h('div', { class: 'ss-filter-body' }, value) : null,
    );
  }

  // ------------------------------------------------------------------------- state

  serialize() {
    return {
      state: this.state,
      table: this.table,
      selectedOnly: this.selectedOnly,
      showLeft: this.showLeft,
      showSidebar: this.showSidebar,
      internal: this.internal,
      pinned: this.pinned,
      useFilter: this.useFilter,
      filters: this.filters,
      sort: this.sort,
      widths: this.widths,
      order: this.order,
      hidden: this.hidden,
    };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.unsub();
  }
}

/** Last text copied from a spreadsheet (also put on the system clipboard). */
export let lastCopied = '';

function sameIds(a: unknown[], b: unknown[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((v, k) => v !== y[k])) return false;
    } else if (x !== y) return false;
  }
  return true;
}

const TYPE_LABELS: Record<string, string> = {
  FLOAT: 'Float',
  INT: 'Integer',
  INT8: '8-Bit Integer',
  INT2: '2D Integer Vector',
  BOOLEAN: 'Boolean',
  FLOAT_VECTOR: 'Vector',
  FLOAT2: '2D Vector',
  FLOAT_COLOR: 'Color',
  QUATERNION: 'Rotation',
  STRING: 'Text',
  FLOAT4X4: '4×4 Matrix',
};
const typeLabel = (c: Column) => TYPE_LABELS[c.type] ?? c.type;

function row(label: string, c: Child): Child {
  return h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, label), h('div', { class: 'sr-value' }, c), h('span'));
}

// ---------------------------------------------------------------------------
// Operators and keymap

function ssEd(ctx: OpContext): SpreadsheetEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof SpreadsheetEditor ? ed : null;
}

const DOMAINS: [string, string][] = [
  ['POINT', 'Point'],
  ['EDGE', 'Edge'],
  ['FACE', 'Face'],
  ['CORNER', 'Face Corner'],
  ['CURVE', 'Spline'],
  ['INSTANCE', 'Instance'],
  ['LAYER', 'Layer'],
];

registerOperators([
  {
    idname: 'spreadsheet.toggle_pin',
    label: 'Toggle Pin',
    description: 'Keep showing the current object, or follow the active object again',
    undo: false,
    poll: (ctx) => !!ssEd(ctx),
    exec: (ctx) => {
      const ed = ssEd(ctx)!;
      if (ed.pinned) ed.pinned = null;
      else {
        const ob = app.activeObject;
        if (!ob) return 'CANCELLED';
        ed.pinned = ob.id;
      }
      ed.refresh();
      app.changed('ui');
    },
  },
  {
    idname: 'spreadsheet.add_row_filter_rule',
    label: 'Add Row Filter',
    description: 'Add a filter rule (for a column) to the spreadsheet',
    props: [{ id: 'column', label: 'Column', type: 'string', default: '' }],
    undo: false,
    poll: (ctx) => !!ssEd(ctx),
    exec: (ctx, p) => {
      const ed = ssEd(ctx)!;
      const column = (p.column as string) || ed.cols[0]?.name || '';
      const f = newRowFilter(column);
      const c = ed.cols.find((x) => x.name === column);
      if (c && c.type === 'FLOAT_COLOR') f.value = [1, 1, 1, 1];
      ed.filters.push(f);
      ed.useFilter = true;
      ed.showSidebar = true;
      ed.refresh();
      app.changed('ui');
    },
  },
  {
    idname: 'spreadsheet.remove_row_filter_rule',
    label: 'Remove Row Filter',
    description: 'Remove a filter rule from the spreadsheet',
    props: [{ id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    undo: false,
    poll: (ctx) => !!ssEd(ctx)?.filters.length,
    exec: (ctx, p) => {
      const ed = ssEd(ctx)!;
      const i = p.index as number;
      if (i < 0 || i >= ed.filters.length) return 'CANCELLED';
      ed.filters.splice(i, 1);
      ed.refresh();
      app.changed('ui');
    },
  },
  {
    idname: 'spreadsheet.change_spreadsheet_data_source',
    label: 'Change Data Source',
    description: 'Show another component and domain of the geometry',
    props: [
      {
        id: 'component_type',
        label: 'Component',
        type: 'enum',
        default: 'MESH',
        items: [
          ['MESH', 'Mesh'],
          ['CURVE', 'Curve'],
          ['POINTCLOUD', 'Point Cloud'],
          ['INSTANCES', 'Instances'],
          ['GREASEPENCIL', 'Grease Pencil'],
        ],
      },
      { id: 'attribute_domain_type', label: 'Domain', type: 'enum', default: 'POINT', items: DOMAINS },
    ],
    undo: false,
    poll: (ctx) => !!ssEd(ctx),
    exec: (ctx, p) => {
      const map: Record<string, ComponentKey> = { MESH: 'MESH', CURVE: 'CURVES', POINTCLOUD: 'POINTS', INSTANCES: 'INSTANCES', GREASEPENCIL: 'GREASE_PENCIL' };
      const key = map[p.component_type as string] ?? 'MESH';
      const domain = (key === 'INSTANCES' ? 'INSTANCE' : key === 'GREASE_PENCIL' ? 'LAYER' : p.attribute_domain_type) as TableId['domain'];
      ssEd(ctx)!.setTable({ path: [], key, domain });
    },
  },
  {
    idname: 'spreadsheet.fit_column',
    label: 'Fit Column',
    description: 'Make a column just wide enough for its values',
    props: [{ id: 'column', label: 'Column', type: 'string', default: '' }],
    undo: false,
    poll: (ctx) => !!ssEd(ctx),
    exec: (ctx, p) => {
      const ed = ssEd(ctx)!;
      const names = p.column ? [p.column as string] : ed.cols.map((c) => c.name);
      let ok = false;
      for (const n of names) ok = ed.fitColumn(n) || ok;
      return ok ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'spreadsheet.copy_cells',
    label: 'Copy Cells',
    description: 'Copy the selected cells (or the whole table) as tab-separated text',
    props: [{ id: 'header', label: 'With Headers', type: 'bool', default: false }],
    undo: false,
    poll: (ctx) => !!ssEd(ctx)?.cols.length,
    exec: (ctx, p) => (ssEd(ctx)!.copySelection(!!p.header) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'spreadsheet.select_all',
    label: 'Select All Cells',
    description: 'Select every row of the table',
    undo: false,
    poll: (ctx) => !!ssEd(ctx)?.rows.length,
    exec: (ctx) => {
      const ed = ssEd(ctx)!;
      ed.sel = { r0: 0, r1: ed.rows.length - 1, c0: -1, c1: ed.cols.length - 1 };
      ed.refresh();
    },
  },
]);

const hoverSs = () => {
  const ed = app.hoverArea?.editor;
  return ed instanceof SpreadsheetEditor ? ed : null;
};

addKeys('Spreadsheet Generic', [
  { key: 'N', action: () => hoverSs()?.toggleSidebar() },
  { key: 'T', action: () => hoverSs()?.toggleLeft() },
  { key: 'C', ctrl: true, op: 'spreadsheet.copy_cells' },
  { key: 'C', ctrl: true, shift: true, op: 'spreadsheet.copy_cells', props: { header: true } },
  { key: 'A', ctrl: true, op: 'spreadsheet.select_all' },
  { key: 'ESC', action: () => hoverSs()?.sel && ((hoverSs()!.sel = null), hoverSs()!.refresh()), when: () => !!hoverSs()?.sel },
]);

registerEditor({
  id: 'SPREADSHEET',
  label: 'Spreadsheet',
  icon: 'spreadsheet',
  group: 'Data',
  create: (a, s) => new SpreadsheetEditor(a, s),
});

