// Spreadsheet editor: attribute values of the active object's evaluated (or original / viewer)
// geometry, one table per component domain, with virtual scrolling for large meshes.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { linearToSrgb } from '../ui/widgets';
import type { Domain } from '../geonodes/types';
import { columnsOf, componentOf, resolveSource, selectedRows, viewerActiveFor, type Column, type ComponentKey, type EvalState, type Source } from './data';
import { resultListeners } from '../geonodes/results';

const ROW_H = 20;

interface DomainEntry {
  key: ComponentKey;
  domain: Domain;
  label: string;
  icon: string;
}

const TREE: {
  label: string;
  icon: string;
  key: ComponentKey;
  domains: DomainEntry[];
}[] = [
  {
    label: 'Mesh',
    icon: 'mesh_data',
    key: 'MESH',
    domains: [
      { key: 'MESH', domain: 'POINT', label: 'Vertex', icon: 'ss_vertex' },
      { key: 'MESH', domain: 'EDGE', label: 'Edge', icon: 'ss_edge' },
      { key: 'MESH', domain: 'FACE', label: 'Face', icon: 'ss_face' },
      {
        key: 'MESH',
        domain: 'CORNER',
        label: 'Face Corner',
        icon: 'ss_corner',
      },
    ],
  },
  {
    label: 'Curve',
    icon: 'curve_data',
    key: 'CURVES',
    domains: [
      {
        key: 'CURVES',
        domain: 'POINT',
        label: 'Control Point',
        icon: 'ss_control_point',
      },
      { key: 'CURVES', domain: 'CURVE', label: 'Spline', icon: 'ss_spline' },
    ],
  },
  {
    label: 'Point Cloud',
    icon: 'outliner_ob_pointcloud',
    key: 'POINTS',
    domains: [{ key: 'POINTS', domain: 'POINT', label: 'Point', icon: 'ss_point' }],
  },
  { label: 'Instances', icon: 'ss_instance', key: 'INSTANCES', domains: [] },
];

/** Compact element counts (3.6K, 1.2M). */
export const shortCount = (n: number) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`);

const fmt = (v: number) => {
  if (!Number.isFinite(v)) return String(v);
  const s = v.toFixed(3);
  return s === '-0.000' ? '0.000' : s;
};

function columnWidth(c: Column): number {
  if (c.type === 'STRING') return 140;
  if (c.type === 'BOOLEAN') return 70;
  if (c.type === 'INT' || c.type === 'INT8') return 80;
  if (c.type === 'INT2') return 110;
  if (c.type === 'FLOAT') return 90;
  if (c.type === 'FLOAT2') return 150;
  if (c.type === 'FLOAT_COLOR') return 230;
  return 210;
}

export class SpreadsheetEditor implements Editor {
  el: HTMLElement;
  keymaps = ['Spreadsheet'];
  state: EvalState = 'EVALUATED';
  key: ComponentKey = 'MESH';
  domain: Domain = 'POINT';
  selectedOnly = false;
  showLeft = true;
  private left: HTMLElement;
  private main: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private spacer: HTMLElement;
  private rowsEl: HTMLElement;
  private footer: HTMLElement;
  private src: Source | null = null;
  private cols: Column[] = [];
  private rows: Int32Array | null = null;
  private rowCount = 0;
  private wasViewer = false;
  private raf = 0;
  private unsub: () => void;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    const st = (state ?? {}) as {
      state?: EvalState;
      key?: ComponentKey;
      domain?: Domain;
      selectedOnly?: boolean;
      showLeft?: boolean;
    };
    if (st.state) this.state = st.state;
    if (st.key) this.key = st.key;
    if (st.domain) this.domain = st.domain;
    if (st.selectedOnly) this.selectedOnly = true;
    if (st.showLeft === false) this.showLeft = false;
    this.el = document.createElement('div');
    this.el.className = 'ss-editor';
    this.el.tabIndex = -1;
    this.left = document.createElement('div');
    this.left.className = 'ss-left';
    this.main = document.createElement('div');
    this.main.className = 'ss-main';
    this.head = document.createElement('div');
    this.head.className = 'ss-head';
    this.body = document.createElement('div');
    this.body.className = 'ss-body';
    this.spacer = document.createElement('div');
    this.spacer.className = 'ss-spacer';
    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'ss-rows';
    this.body.append(this.spacer, this.rowsEl);
    this.footer = document.createElement('div');
    this.footer.className = 'ss-footer';
    this.main.append(this.head, this.body, this.footer);
    this.el.append(this.left, this.main);
    this.body.addEventListener('scroll', () => {
      this.head.scrollLeft = this.body.scrollLeft;
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.renderRows());
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

  // -------------------------------------------------------------------------

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
    const viewer = viewerActiveFor(app.activeObject);
    return h(
      'div',
      { class: 'hdr-row ss-header' },
      menu('View', () => [
        {
          label: 'Data Set Region',
          checked: this.showLeft,
          action: () => ((this.showLeft = !this.showLeft), this.refresh()),
        },
        { separator: true },
        { label: 'Area', submenu: () => this.area.areaMenu() },
      ]),
      (() => {
        const states: [EvalState, string, string, string][] = [
          ['EVALUATED', 'Evaluated', 'modifier', 'Use data from fully or partially evaluated object'],
          ['ORIGINAL', 'Original', 'object_datamode', 'Use data from original object without any modifiers applied'],
          ['VIEWER_NODE', 'Viewer Node', 'hide_off', 'Use intermediate data from viewer node'],
        ];
        const cur = states.find((x) => x[0] === this.state) ?? states[0];
        return h(
          'button',
          {
            class: 'hdr-menu ss-state',
            'data-tip': 'Object Evaluation State',
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
        );
      })(),
      h(
        'div',
        { class: 'ss-crumbs' },
        (src?.crumbs ?? []).map(([ic, name], i) => [
          i ? h('span', { key: `s${i}`, class: 'ss-crumb-sep' }, icon('right_arrow')) : null,
          h('span', { key: `c${i}`, class: 'ss-crumb' }, icon(ic), name),
        ]),
      ),
      h('div', { class: 'hdr-spacer' }),
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: this.selectedOnly },
          'data-tip': 'Selected Only\nOnly include rows that correspond to selected elements (Edit Mode)',
          onclick: () => {
            this.selectedOnly = !this.selectedOnly;
            this.refresh();
            app.changed('ui');
          },
        },
        icon('restrict_select_off'),
      ),
    );
  }

  update(kinds: Set<ChangeKind>) {
    if (kinds.has('doc') || kinds.has('select') || kinds.has('frame') || kinds.has('mode') || kinds.has('geometry') || kinds.has('ui')) this.refresh();
  }

  resize() {
    this.renderRows();
  }

  /** Rebuild the data set list and the table columns. */
  refresh() {
    const viewer = viewerActiveFor(app.activeObject);
    // activating a viewer switches the spreadsheet to its data
    if (viewer && !this.wasViewer) this.state = 'VIEWER_NODE';
    if (!viewer && this.state === 'VIEWER_NODE') this.state = 'EVALUATED';
    this.wasViewer = viewer;
    this.src = resolveSource(this.state);
    const g = this.src?.geo;
    this.left.hidden = !this.showLeft;
    // left: components and domains with element counts
    const items: Child[] = [];
    for (const t of TREE) {
      const comp = g ? componentOf(g, t.key) : undefined;
      if (t.key === 'INSTANCES') {
        const n = comp?.domainSize('INSTANCE') ?? 0;
        items.push(
          this.leftRow(
            {
              key: 'INSTANCES',
              domain: 'INSTANCE',
              label: t.label,
              icon: t.icon,
            },
            n,
            false,
          ),
        );
        continue;
      }
      items.push(h('div', { key: `h-${t.key}`, class: 'ss-left-head' }, icon(t.icon), t.label));
      for (const d of t.domains) items.push(this.leftRow(d, comp?.domainSize(d.domain) ?? 0, true));
    }
    patch(this.left, items);
    // table
    const comp = g ? componentOf(g, this.key) : undefined;
    this.cols = comp ? columnsOf(comp, this.domain) : [];
    const n = comp ? comp.domainSize(this.domain) : 0;
    this.rows = this.selectedOnly && this.src ? selectedRows(this.src, this.key, this.domain) : null;
    this.rowCount = this.rows ? this.rows.length : n;
    const idxW = this.indexWidth();
    patch(this.head, [
      h('div', { class: 'ss-hcell ss-idx', style: { width: `${idxW}px` } }, ''),
      ...this.cols.map((c, i) =>
        h(
          'div',
          {
            key: `${c.name}:${i}`,
            class: { 'ss-hcell': true, virtual: !!c.virtual },
            style: { width: `${columnWidth(c)}px` },
            'data-tip': c.virtual ? `${c.name} (computed)` : c.name,
          },
          c.name,
        ),
      ),
    ]);
    const total = idxW + this.cols.reduce((s, c) => s + columnWidth(c), 0);
    this.spacer.style.height = `${this.rowCount * ROW_H}px`;
    this.spacer.style.width = `${total}px`;
    patch(this.footer, [h('span', null, `Rows: ${this.rowCount.toLocaleString()}`), h('span', { class: 'ss-sep' }, '|'), h('span', null, `Columns: ${this.cols.length}`)]);
    this.renderRows();
  }

  private leftRow(d: DomainEntry, n: number, indent: boolean): Child {
    const active = this.key === d.key && this.domain === d.domain;
    return h(
      'div',
      {
        key: `${d.key}:${d.domain}`,
        class: { 'ss-left-row': true, active, empty: !n, indent },
        onclick: () => {
          this.key = d.key;
          this.domain = d.domain;
          this.body.scrollTop = 0;
          this.refresh();
          app.changed('ui');
        },
      },
      icon(d.icon),
      h('span', { class: 'ss-left-label' }, d.label),
      h('span', { class: 'ss-left-count', 'data-tip': n.toLocaleString() }, shortCount(n)),
    );
  }

  private indexWidth() {
    return Math.max(40, String(Math.max(0, this.rowCount - 1)).length * 8 + 18);
  }

  private cell(c: Column, i: number): Child {
    const w = columnWidth(c);
    const d = c.data;
    let content: Child;
    if (c.type === 'STRING') content = h('span', { class: 'ss-str' }, (d as string[])[i] ?? '');
    else if (c.type === 'BOOLEAN') content = h('span', { class: { 'ss-bool': true, on: !!(d as Uint8Array)[i] } }, icon((d as Uint8Array)[i] ? 'checkbox_hlt' : 'checkbox_dehlt'));
    else if (c.type === 'INT' || c.type === 'INT8') content = h('span', { class: 'ss-num' }, String((d as Int32Array)[i]));
    else if (c.type === 'INT2') content = [h('span', { class: 'ss-num' }, String((d as Int32Array)[i * 2])), h('span', { class: 'ss-num' }, String((d as Int32Array)[i * 2 + 1]))];
    else if (c.comps === 1) content = h('span', { class: 'ss-num' }, fmt((d as Float32Array)[i]));
    else {
      const vals = Array.from((d as Float32Array).subarray(i * c.comps, i * c.comps + c.comps));
      if (c.type === 'FLOAT_COLOR') {
        const css = `rgb(${vals
          .slice(0, 3)
          .map((x) => Math.round(Math.max(0, Math.min(1, linearToSrgb(x))) * 255))
          .join(',')})`;
        content = [h('span', { class: 'ss-swatch', style: { background: css } }), ...vals.map((v, k) => h('span', { key: String(k), class: 'ss-num' }, fmt(v)))];
      } else content = vals.map((v, k) => h('span', { key: String(k), class: 'ss-num' }, c.type === 'QUATERNION' ? `${fmt((v * 180) / Math.PI)}°` : fmt(v)));
    }
    return h('div', { class: 'ss-cell', style: { width: `${w}px` } }, content);
  }

  renderRows() {
    const H = this.body.clientHeight;
    const first = Math.max(0, Math.floor(this.body.scrollTop / ROW_H) - 2);
    const last = Math.min(this.rowCount, Math.ceil((this.body.scrollTop + H) / ROW_H) + 2);
    const idxW = this.indexWidth();
    const rows: Child[] = [];
    for (let r = first; r < last; r++) {
      const i = this.rows ? this.rows[r] : r;
      rows.push(
        h(
          'div',
          {
            key: String(r),
            class: { 'ss-row': true, odd: r % 2 === 1 },
            style: { top: `${r * ROW_H}px` },
          },
          h('div', { class: 'ss-cell ss-idx', style: { width: `${idxW}px` } }, String(i)),
          this.cols.map((c) => this.cell(c, i)),
        ),
      );
    }
    patch(this.rowsEl, rows);
  }

  serialize() {
    return {
      state: this.state,
      key: this.key,
      domain: this.domain,
      selectedOnly: this.selectedOnly,
      showLeft: this.showLeft,
    };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.unsub();
  }
}

registerEditor({
  id: 'SPREADSHEET',
  label: 'Spreadsheet',
  icon: 'spreadsheet',
  group: 'Data',
  create: (a, s) => new SpreadsheetEditor(a, s),
});
