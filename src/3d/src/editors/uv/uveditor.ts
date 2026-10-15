// UV Editor: shows the UVs of the mesh being edited over its texture, with tools (toolbar),
// a sidebar, header menus, selection, transforms and UV sculpting.
import { h, patch, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, registerOperators, type ChangeKind } from '../../app/app';
import { registerEditor, type Area, type Editor } from '../../ui/screen';
import { openMenu, type MenuItem } from '../../ui/menu';
import { enumMenu, enumRow, panel, numberField, checkbox } from '../../ui/widgets';
import { splitRow } from '../../ui/props';
import { lastOpPanel } from '../../ui/redo';
import type { ImageData } from '../../data/types';
import { imageCanvas } from '../../render/images';
import { lastImage } from '../../ops/data';
import { newImageDialog } from '../../render/final/imageeditor';
import type { View2D } from '../../render/final/imageops';
import { UVTopo, selReader, isPinned, faceUVArea, face3DArea } from './uvcore';
import { selGroups, selBounds } from './uvalgo';
import { uvLayers, uvCursor, uvSelectMode, autoImage, uvEditPoll, uvChanged, type UVView } from './uvcontext';
import { shapeSelect, runShapeSelect, elementAt, eventUV } from './uvops-select';
import { layerTopos, pickRadius } from './uvcontext';
import { startUVTransform, type UVPivot } from './uvtransform';
import { uvSculpt } from './uvsculpt';
import { selectMenu, uvMenu, openUVContextMenu } from './uvmenus';
import './uvops-select';
import './uvops-edit';
import './uvexport';
import './uvicons';
import './uvsculpt';

export type UVTool = 'select' | 'select_box' | 'select_circle' | 'select_lasso' | 'cursor' | 'move' | 'rotate' | 'scale' | 'rip_region' | 'grab' | 'relax' | 'pinch';

interface ToolDef {
  id: UVTool;
  label: string;
  icon: string;
  description: string;
  group?: 'select' | 'sculpt';
  shortcut?: string;
}

const TOOLS: (ToolDef | null)[] = [
  { id: 'select', label: 'Tweak', icon: 'select_tweak', group: 'select', description: 'Select and move by dragging' },
  { id: 'select_box', label: 'Select Box', icon: 'select_box', group: 'select', shortcut: 'W', description: 'Select UVs by dragging a rectangle' },
  { id: 'select_circle', label: 'Select Circle', icon: 'select_circle', group: 'select', description: 'Select UVs by painting with a circle' },
  { id: 'select_lasso', label: 'Select Lasso', icon: 'select_lasso', group: 'select', description: 'Select UVs by drawing an outline' },
  null,
  { id: 'cursor', label: 'Cursor', icon: 'cursor', description: 'Place the 2D cursor, drag to move it' },
  null,
  { id: 'move', label: 'Move', icon: 'transform_move', shortcut: 'G', description: 'Drag to move the selected UVs' },
  { id: 'rotate', label: 'Rotate', icon: 'transform_rotate', shortcut: 'R', description: 'Drag to rotate the selected UVs' },
  { id: 'scale', label: 'Scale', icon: 'transform_scale', shortcut: 'S', description: 'Drag to scale the selected UVs' },
  null,
  { id: 'rip_region', label: 'Rip Region', icon: 'rip', description: 'Drag to tear the selected UVs off their neighbours' },
  null,
  { id: 'grab', label: 'Grab', icon: 'uv_grab', group: 'sculpt', description: 'Drag UVs under the brush' },
  { id: 'relax', label: 'Relax', icon: 'uv_relax', group: 'sculpt', description: 'Smooth out UVs under the brush' },
  { id: 'pinch', label: 'Pinch', icon: 'uv_pinch', group: 'sculpt', description: 'Pull UVs toward the brush center (Ctrl: push away)' },
];

const SELECT_TOOLS = TOOLS.filter((t): t is ToolDef => !!t && t.group === 'select');
const isSculpt = (t: UVTool) => t === 'grab' || t === 'relax' || t === 'pinch';

/** UVs whose 3D/UV area ratio deviates from the mesh average, per face: 0 (none) … 1 (strong). */
function areaStretch(t: UVTopo): Map<number, number> {
  let tu = 0,
    t3 = 0;
  const vals = new Map<number, [number, number]>();
  for (const f of t.faces) {
    const a = Math.abs(faceUVArea(t.me, f)),
      b = face3DArea(t.me, f);
    vals.set(f, [a, b]);
    tu += a;
    t3 += b;
  }
  const out = new Map<number, number>();
  for (const [f, [a, b]] of vals) {
    if (tu <= 0 || t3 <= 0 || b <= 0) {
      out.set(f, 1);
      continue;
    }
    const r = a / tu / (b / t3);
    out.set(f, r <= 0 ? 1 : 1 - Math.min(r, 1 / r));
  }
  return out;
}

export class UVEditor implements Editor, UVView, View2D {
  el: HTMLElement;
  keymaps = ['UV Editor', 'Image Generic', 'Image', 'Window', 'Screen'];
  canvas: HTMLCanvasElement;
  ui: HTMLElement;
  zoom = 1;
  pan = { x: 0, y: 0 };
  imageId: string | null = null;
  pivot: UVPivot = 'BOUNDING_BOX_CENTER';
  tool: UVTool = 'select_box';
  showToolbar = true;
  showSidebar = false;
  sidebarTab = 'Image';
  showStretch = false;
  /** a running drag drawn as an overlay (box / lasso from tools) */
  private drag: { kind: 'BOX' | 'LASSO'; pts: { x: number; y: number }[] } | null = null;
  private hover: { x: number; y: number } | null = null;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'uv-editor';
    this.el.style.position = 'absolute';
    this.el.style.inset = '0';
    this.el.tabIndex = -1;
    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.ui = document.createElement('div');
    this.ui.className = 'v3d-ui uv-ui';
    this.el.append(this.canvas, this.ui);
    const st = (state ?? {}) as Partial<{ zoom: number; pan: { x: number; y: number }; image: string | null; pivot: UVPivot; tool: UVTool; toolbar: boolean; sidebar: boolean; tab: string; stretch: boolean; mode: string }>;
    if (st.zoom) this.zoom = st.zoom;
    if (st.pan) this.pan = { ...st.pan };
    if (st.image !== undefined) this.imageId = st.image;
    if (st.pivot) this.pivot = st.pivot;
    if (st.tool && TOOLS.some((t) => t?.id === st.tool)) this.tool = st.tool;
    if (st.toolbar !== undefined) this.showToolbar = st.toolbar;
    if (st.sidebar !== undefined) this.showSidebar = st.sidebar;
    if (st.tab) this.sidebarTab = st.tab;
    if (st.stretch) this.showStretch = st.stretch;
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => {
      this.hover = this.local(e);
      if (isSculpt(this.tool)) this.draw();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      if (isSculpt(this.tool)) this.draw();
    });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  // -------------------------------------------------------------------
  // view transform: uv (0..1, v up) → pixels

  scale() {
    return Math.max(1e-6, Math.min(this.el.clientWidth, this.el.clientHeight) * 0.8 * this.zoom);
  }
  toPx(u: number, v: number) {
    const s = this.scale();
    const cx = this.el.clientWidth / 2 + this.pan.x,
      cy = this.el.clientHeight / 2 + this.pan.y;
    return { x: cx + (u - 0.5) * s, y: cy - (v - 0.5) * s };
  }
  toUV(x: number, y: number) {
    const s = this.scale();
    const cx = this.el.clientWidth / 2 + this.pan.x,
      cy = this.el.clientHeight / 2 + this.pan.y;
    return { u: (x - cx) / s + 0.5, v: -(y - cy) / s + 0.5 };
  }
  local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  image(): ImageData | null {
    if (this.imageId) return app.doc.images[this.imageId] ?? null;
    const ob = uvLayers()[0]?.ob ?? app.activeObject;
    return ob && ob.type === 'MESH' ? autoImage(ob) : null;
  }

  setImage(id: string | null) {
    this.imageId = id;
    this.draw();
    this.area.drawHeader();
  }

  shownImage() {
    return this.image();
  }
  showImage(id: string | null) {
    this.setImage(id);
  }
  newImage(anchor?: HTMLElement) {
    newImageDialog(anchor, (id) => this.setImage(id));
  }
  private awaitingOpen: string | null | false = false;
  openImage() {
    this.awaitingOpen = lastImage;
    app.run('image.open', {}, { area: this.area });
  }

  /** Zoom so the screen rectangle fills the view. */
  zoomToRect(x0: number, y0: number, x1: number, y1: number) {
    const a = this.toUV(x0, y1),
      b = this.toUV(x1, y0);
    this.frameRect(a.u, a.v, b.u, b.v);
  }

  /** Zoom keeping the UV point under (x, y) fixed. */
  zoomAt(factor: number, x = this.el.clientWidth / 2, y = this.el.clientHeight / 2) {
    const before = this.toUV(x, y);
    this.zoom = Math.max(0.02, Math.min(400, this.zoom * factor));
    const after = this.toPx(before.u, before.v);
    this.pan.x += x - after.x;
    this.pan.y += y - after.y;
    this.draw();
  }

  /** Zoom so one image pixel covers `ratio` screen pixels. */
  setRatio(ratio: number) {
    const img = this.image();
    const w = img ? img.width : 256;
    const center = this.toUV(this.el.clientWidth / 2, this.el.clientHeight / 2);
    this.zoom = (w * ratio) / (Math.min(this.el.clientWidth, this.el.clientHeight) * 0.8);
    this.centerOn(center.u, center.v);
  }

  centerOn(u: number, v: number) {
    const p = this.toPx(u, v);
    this.pan.x += this.el.clientWidth / 2 - p.x;
    this.pan.y += this.el.clientHeight / 2 - p.y;
    this.draw();
  }

  frameAll(fit = false) {
    // the 0–1 square fills 80% of the view, or (fit) nearly all of it
    this.zoom = fit ? 0.97 / 0.8 : 1;
    this.pan = { x: 0, y: 0 };
    this.draw();
  }

  /** Fit the view to a UV rectangle. */
  frameRect(a: number, b: number, c: number, d: number) {
    const w = Math.max(c - a, 1e-4),
      hh = Math.max(d - b, 1e-4);
    const W = this.el.clientWidth,
      H = this.el.clientHeight;
    const s = Math.min((W * 0.8) / w, (H * 0.8) / hh);
    this.zoom = Math.max(0.02, Math.min(400, s / (Math.min(W, H) * 0.8)));
    this.pan = { x: 0, y: 0 };
    this.centerOn((a + c) / 2, (b + d) / 2);
  }

  frameSelected(): boolean {
    let a = Infinity,
      b = Infinity,
      c = -Infinity,
      d = -Infinity;
    for (const layer of uvLayers()) {
      const t = new UVTopo(layer);
      const bb = selBounds(t, layer.me.uvs as Float32Array, selReader(layer));
      if (!bb) continue;
      a = Math.min(a, bb[0]);
      b = Math.min(b, bb[1]);
      c = Math.max(c, bb[2]);
      d = Math.max(d, bb[3]);
    }
    if (a > c) return false;
    this.frameRect(a, b, c, d);
    return true;
  }

  centerCursor() {
    this.centerOn(uvCursor.u, uvCursor.v);
  }

  cursorToCenter() {
    const c = this.toUV(this.el.clientWidth / 2, this.el.clientHeight / 2);
    uvCursor.u = c.u;
    uvCursor.v = c.v;
    this.draw();
  }

  // -------------------------------------------------------------------
  // header

  header(): Child {
    const ts = app.doc.scene.tool_settings;
    const images = Object.values(app.doc.images).filter((i) => i.source !== 'RENDER');
    const cur = this.imageId ?? '';
    const auto = this.imageId ? null : this.image();
    const mode = uvSelectMode();
    const menus: [string, () => MenuItem[]][] = [
      ['View', () => this.viewMenu()],
      ['Select', selectMenu],
      ['Image', () => this.imageMenu()],
      ['UV', uvMenu],
    ];
    const setTs = <K extends keyof typeof ts>(k: K, v: (typeof ts)[K], label: string) => {
      ts[k] = v;
      app.pushUndo(label);
      app.changed('ui', 'doc');
    };
    return h(
      'div',
      { class: 'hdr-row uv-header' },
      menus.map(([label, fn]) =>
        h(
          'button',
          {
            key: label,
            class: 'hdr-menu',
            onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(fn(), e.currentTarget as HTMLElement)),
            onpointerenter: (e: PointerEvent) => {
              if (document.querySelector('.hdr-menu.menu-open') && !(e.currentTarget as HTMLElement).classList.contains('menu-open')) openMenu(fn(), e.currentTarget as HTMLElement);
            },
          },
          label,
        ),
      ),
      h('div', { class: 'hdr-sep' }),
      h('button', { class: { 'hdr-toggle': true, on: ts.use_uv_select_sync }, 'data-tip': 'UV Sync Selection\nSelect the same mesh elements in the UV editor and the 3D Viewport', onclick: () => setTs('use_uv_select_sync', !ts.use_uv_select_sync, 'UV Sync Selection') }, icon('uv_sync')),
      enumRow(
        'uv-selmode',
        [
          { value: 'VERTEX', label: '', icon: 'snap_vertex', description: 'Vertex\nSelect UV vertices (1)' },
          { value: 'EDGE', label: '', icon: 'snap_edge', description: 'Edge\nSelect UV edges (2)' },
          { value: 'FACE', label: '', icon: 'snap_face', description: 'Face\nSelect UV faces (3)' },
          ...(ts.use_uv_select_sync ? [] : [{ value: 'ISLAND', label: '', icon: 'uv_island', description: 'Island\nSelect whole UV islands (4)' }]),
        ],
        mode,
        (m) => app.run('uv.select_mode', { type: m }, { invoke: false, area: this.area }),
        { iconOnly: true },
      ),
      ts.use_uv_select_sync
        ? null
        : h(
            'div',
            { style: 'width:150px' },
            enumMenu(
              'uv-sticky',
              [
                { value: 'SHARED_LOCATION', label: 'Shared Location', icon: 'sticky_location', description: 'Select UVs at the same place that belong to the same mesh vertex' },
                { value: 'DISABLED', label: 'Disabled', icon: 'sticky_off', description: 'Select only the picked UV' },
                { value: 'SHARED_VERTEX', label: 'Shared Vertex', icon: 'sticky_vertex', description: 'Select every UV of the same mesh vertex, wherever it is' },
              ],
              ts.uv_sticky_select_mode ?? 'SHARED_LOCATION',
              (v) => setTs('uv_sticky_select_mode', v as 'DISABLED', 'Sticky Selection Mode'),
              { tip: 'Sticky Selection Mode\nWhich UVs are selected together with a picked UV' },
            ),
          ),
      h('div', { class: 'hdr-spacer' }),
      h(
        'div',
        { style: 'width:170px' },
        enumMenu(
          'uv-image',
          [{ value: '', label: auto ? `${auto.name} (material)` : 'No Image', icon: 'image' }, ...images.map((i) => ({ value: i.id, label: i.name, icon: 'image' }))],
          cur,
          (v) => this.setImage(v || null),
          { tip: 'Image shown behind the UVs (default: the active material\'s image texture)' },
        ),
      ),
      h('button', { class: 'hdr-toggle uv-new-image', 'data-tip': 'New Image (Alt N)', onclick: (e: MouseEvent) => this.newImage(e.currentTarget as HTMLElement) }, icon('add')),
      h('button', { class: 'hdr-toggle', 'data-tip': 'Open Image (Alt O)', onclick: () => this.openImage() }, icon('file_folder')),
      h('div', { class: 'hdr-sep' }),
      enumMenu(
        'uv-pivot',
        [
          { value: 'BOUNDING_BOX_CENTER', label: 'Bounding Box Center', icon: 'pivot_boundbox' },
          { value: 'CURSOR', label: '2D Cursor', icon: 'pivot_cursor' },
          { value: 'INDIVIDUAL_ORIGINS', label: 'Individual Origins', icon: 'pivot_individual' },
          { value: 'MEDIAN_POINT', label: 'Median Point', icon: 'pivot_median' },
        ],
        this.pivot,
        (v) => ((this.pivot = v as UVPivot), this.area.drawHeader()),
        { iconOnly: true, tip: 'Pivot Point\nCenter for rotating and scaling (.)', title: 'Pivot Point' },
      ),
      h('button', { class: { 'hdr-toggle': true, on: ts.use_proportional_edit }, 'data-tip': 'Proportional Editing (O)\nMove nearby UVs too, with a falloff', onclick: () => setTs('use_proportional_edit', !ts.use_proportional_edit, 'Proportional Editing') }, icon(ts.use_proportional_edit ? 'prop_on' : 'prop_off')),
    );
  }

  viewMenu(): MenuItem[] {
    return [
      { label: 'Toolbar', checked: this.showToolbar, shortcut: 'T', action: () => this.toggleToolbar() },
      { label: 'Sidebar', checked: this.showSidebar, shortcut: 'N', action: () => this.toggleSidebar() },
      { separator: true },
      { label: 'Display Stretch', checked: this.showStretch, action: () => ((this.showStretch = !this.showStretch), this.draw()) },
      { separator: true },
      { label: 'Zoom In', op: 'image.view_zoom_in', shortcut: 'Numpad +' },
      { label: 'Zoom Out', op: 'image.view_zoom_out', shortcut: 'Numpad -' },
      {
        label: 'Fractional Zoom',
        submenu: () =>
          (
            [
              ['Zoom 1:8', 0.125, 'Numpad 8'],
              ['Zoom 1:4', 0.25, 'Numpad 4'],
              ['Zoom 1:2', 0.5, 'Numpad 2'],
              ['Zoom 1:1', 1, 'Numpad 1'],
              ['Zoom 2:1', 2, 'Ctrl Numpad 2'],
              ['Zoom 4:1', 4, 'Ctrl Numpad 4'],
              ['Zoom 8:1', 8, 'Ctrl Numpad 8'],
            ] as [string, number, string][]
          ).map(([label, ratio, shortcut]) => ({ label, op: 'image.view_zoom_ratio', props: { ratio }, shortcut })),
      },
      { separator: true },
      { label: 'Frame Selected', op: 'image.view_selected', shortcut: 'Numpad .' },
      { label: 'Frame All', op: 'image.view_all', props: { fit_view: false }, shortcut: 'Home' },
      { label: 'Frame All Fit', op: 'image.view_all', props: { fit_view: true }, shortcut: 'Shift Home' },
      { label: 'Center View to Cursor', op: 'image.view_center_cursor' },
      { label: 'Cursor to Center View', op: 'image.view_cursor_center', shortcut: 'Shift C' },
      { separator: true },
      { label: 'Area', submenu: () => this.area.areaMenu() },
    ];
  }

  imageMenu(): MenuItem[] {
    const img = this.image();
    return [
      { label: 'New', icon: 'add', shortcut: 'Alt N', action: () => this.newImage() },
      { label: 'Open…', icon: 'file_folder', shortcut: 'Alt O', action: () => this.openImage() },
      ...(img
        ? [
            { label: 'Replace…', op: 'image.replace' },
            { label: 'Reload', op: 'image.reload', shortcut: 'Alt R' },
            { separator: true },
            { label: 'Save', op: 'image.save', shortcut: 'Alt S' },
            { label: 'Save As…', op: 'image.save_as', shortcut: 'Shift Alt S' },
            { label: 'Save a Copy…', op: 'image.save_as', props: { copy: true } },
          ]
        : [{ separator: true }]),
      { label: 'Save All Images', op: 'image.save_all_modified' },
      ...(img
        ? [
            { separator: true },
            {
              label: 'Invert',
              submenu: () => [
                { label: 'Invert Image Colors', op: 'image.invert', props: { invert_r: true, invert_g: true, invert_b: true } },
                { separator: true },
                { label: 'Invert Red Channel', op: 'image.invert', props: { invert_r: true } },
                { label: 'Invert Green Channel', op: 'image.invert', props: { invert_g: true } },
                { label: 'Invert Blue Channel', op: 'image.invert', props: { invert_b: true } },
                { label: 'Invert Alpha Channel', op: 'image.invert', props: { invert_a: true } },
              ],
            },
            { label: 'Resize', op: 'image.resize' },
            {
              label: 'Transform',
              submenu: () => [
                { label: 'Flip Horizontally', op: 'image.flip', props: { use_flip_x: true } },
                { label: 'Flip Vertically', op: 'image.flip', props: { use_flip_y: true } },
                { separator: true },
                { label: 'Rotate 90° Clockwise', op: 'image.rotate_orthogonal', props: { degrees: '90' } },
                { label: 'Rotate 90° Counter-Clockwise', op: 'image.rotate_orthogonal', props: { degrees: '270' } },
                { label: 'Rotate 180°', op: 'image.rotate_orthogonal', props: { degrees: '180' } },
              ],
            },
            { separator: true },
            { label: 'Copy', op: 'image.clipboard_copy' },
          ]
        : []),
      { label: 'Paste', op: 'image.clipboard_paste' },
    ];
  }

  toggleToolbar() {
    this.showToolbar = !this.showToolbar;
    this.drawUI();
  }
  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    this.drawUI();
  }

  setTool(t: UVTool) {
    this.tool = t;
    if (SELECT_TOOLS.some((s) => s.id === t)) this.lastSelect = t;
    this.drawUI();
    this.draw();
  }

  // -------------------------------------------------------------------
  // toolbar and sidebar

  private toolbar(): Child {
    const editing = app.doc.mode === 'EDIT';
    const list = TOOLS.filter((t) => !t || editing || t.id === 'cursor' || t.group === 'select');
    // one slot for the select tools: the active one (or the last used)
    const selSlot = SELECT_TOOLS.find((t) => t.id === this.tool) ?? SELECT_TOOLS.find((t) => t.id === this.lastSelect)!;
    let shownSelect = false;
    const items: Child[] = [];
    list.forEach((t, i) => {
      if (!t) {
        if (items.length) items.push(h('div', { key: `sep${i}`, class: 'tb-sep' }));
        return;
      }
      if (t.group === 'select') {
        if (shownSelect) return;
        shownSelect = true;
        t = selSlot;
      }
      const tool = t;
      const slot = tool.group === 'select';
      items.push(
        h(
          'button',
          {
            key: `tool-${slot ? 'select' : tool.id}`,
            class: { 'tb-tool': true, on: tool.id === this.tool, 'has-alt': slot },
            'data-tool': tool.id,
            'data-tip': `${tool.label}${tool.shortcut ? `\nShortcut: ${tool.shortcut}` : ''}\n${tool.description}`,
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              const alts = () => SELECT_TOOLS.map((s) => ({ label: s.label, icon: s.icon, active: s.id === this.tool, action: () => this.setTool(s.id) }));
              if (slot && (e.button === 2 || e.detail > 1)) {
                openMenu(alts(), e.currentTarget as HTMLElement);
                return;
              }
              this.setTool(tool.id);
              if (slot) {
                const el = e.currentTarget as HTMLElement;
                const timer = setTimeout(() => openMenu(alts(), el), 350);
                const up = () => (clearTimeout(timer), removeEventListener('pointerup', up));
                addEventListener('pointerup', up);
              }
            },
          },
          icon(tool.icon),
        ),
      );
    });
    // trailing separators
    while (items.length && (items[items.length - 1] as { attrs?: { class?: string } })?.attrs?.class === 'tb-sep') items.pop();
    return h('div', { key: 'toolbar', class: 'v3d-toolbar uv-toolbar' }, items);
  }

  private lastSelect: UVTool = 'select_box';

  private sidebar(): Child {
    const tabs = ['Image', 'Tool', 'View'];
    if (!tabs.includes(this.sidebarTab)) this.sidebarTab = 'Image';
    let body: Child[] = [];
    if (this.sidebarTab === 'Image') body = this.imageTab();
    else if (this.sidebarTab === 'Tool') body = this.toolTab();
    else body = this.viewTab();
    return h(
      'div',
      { key: 'sidebar', class: 'v3d-sidebar uv-sidebar' },
      h('div', { class: 'sb-body' }, body),
      h(
        'div',
        { class: 'sb-tabs' },
        tabs.map((t) => h('button', { key: t, class: { 'sb-tab': true, on: t === this.sidebarTab }, onclick: () => ((this.sidebarTab = t), this.drawUI()) }, t)),
      ),
    );
  }

  /** Median of the selected UVs (UV Vertex panel). */
  private selectionMedian(): [number, number] | null {
    let su = 0,
      sv = 0,
      n = 0;
    for (const layer of uvLayers()) {
      const t = new UVTopo(layer);
      for (const corners of selGroups(t, selReader(layer)).values()) {
        su += layer.me.uvs[corners[0] * 2];
        sv += layer.me.uvs[corners[0] * 2 + 1];
        n++;
      }
    }
    return n ? [su / n, sv / n] : null;
  }

  private imageTab(): Child[] {
    const out: Child[] = [];
    const med = app.doc.mode === 'EDIT' ? this.selectionMedian() : null;
    if (med) {
      const img = this.image();
      const px = !!img && this.pixelCoords;
      const k = px ? [img!.width, img!.height] : [1, 1];
      const set = (axis: 0 | 1) => (val: number, final: boolean) => {
        const cur = this.selectionMedian();
        if (!cur) return;
        const d = val / k[axis] - cur[axis];
        moveSelection(axis === 0 ? d : 0, axis === 1 ? d : 0);
        if (final) app.pushUndo('UV Vertex');
      };
      out.push(
        panel('uv-vertex', 'UV Vertex', () => [
          splitRow('X', numberField({ id: 'uv-vx', value: med[0] * k[0], precision: px ? 1 : 4, step: px ? 1 : 0.01, set: set(0) })),
          splitRow('Y', numberField({ id: 'uv-vy', value: med[1] * k[1], precision: px ? 1 : 4, step: px ? 1 : 0.01, set: set(1) })),
          img ? splitRow('', checkbox('uv-px', 'Pixel Coordinates', this.pixelCoords, (v) => ((this.pixelCoords = v), this.drawUI()))) : null,
        ]),
      );
    }
    const img = this.image();
    out.push(
      panel('uv-image', 'Image', () =>
        img
          ? [
              splitRow('Name', h('span', { class: 'ie-value' }, img.name)),
              splitRow('Size', h('span', { class: 'ie-value' }, `${img.width} × ${img.height}`)),
              splitRow('Source', h('span', { class: 'ie-value' }, img.source === 'GENERATED' ? 'Generated' : 'Single Image')),
            ]
          : [h('div', { class: 'sb-empty' }, 'No image: the UVs are shown over a checker grid.')],
      ),
    );
    return out;
  }

  pixelCoords = false;

  private toolTab(): Child[] {
    const t = TOOLS.find((x) => x?.id === this.tool)!;
    const rows: Child[] = [h('div', { class: 'uv-tool-name' }, icon(t.icon), t.label)];
    if (isSculpt(this.tool)) {
      rows.push(
        splitRow('Radius', numberField({ id: 'uv-sc-size', value: uvSculpt.size, int: true, min: 1, max: 500, unit: 'pixel', set: (v) => ((uvSculpt.size = v), this.draw()) })),
        splitRow('Strength', numberField({ id: 'uv-sc-str', value: uvSculpt.strength, min: 0, max: 1, slider: true, unit: 'factor', set: (v) => (uvSculpt.strength = v) })),
        splitRow(
          'Falloff',
          enumMenu(
            'uv-sc-fall',
            ['SMOOTH', 'SPHERE', 'ROOT', 'SHARP', 'LINEAR', 'CONSTANT'].map((f) => ({ value: f, label: f[0] + f.slice(1).toLowerCase() })),
            uvSculpt.falloff,
            (v) => ((uvSculpt.falloff = v), this.drawUI()),
          ),
        ),
        splitRow('', checkbox('uv-sc-lock', 'Lock Borders', uvSculpt.lock_borders, (v) => ((uvSculpt.lock_borders = v), this.drawUI()))),
      );
    } else if (this.tool === 'select_circle') {
      rows.push(splitRow('Radius', numberField({ id: 'uv-circ-r', value: shapeSelect.radius, int: true, min: 2, max: 500, unit: 'pixel', set: (v) => (shapeSelect.radius = v) })));
    }
    const ts = app.doc.scene.tool_settings;
    rows.push(
      panel('uv-opts', 'Options', () => [
        splitRow('', checkbox('uv-opt-prop', 'Proportional Editing', ts.use_proportional_edit, (v) => ((ts.use_proportional_edit = v), app.pushUndo('Proportional Editing'), app.changed('ui')))),
        ts.use_proportional_edit ? splitRow('Size', numberField({ id: 'uv-opt-psize', value: ts.proportional_size, min: 0.0001, max: 100, set: (v) => ((ts.proportional_size = v), app.changed('ui')) })) : null,
      ]),
    );
    return rows;
  }

  private viewTab(): Child[] {
    return [
      panel('uv-cursor', '2D Cursor', () => [
        splitRow('X', numberField({ id: 'uv-cx', value: uvCursor.u, precision: 4, step: 0.01, set: (v) => ((uvCursor.u = v), this.draw()) })),
        splitRow('Y', numberField({ id: 'uv-cy', value: uvCursor.v, precision: 4, step: 0.01, set: (v) => ((uvCursor.v = v), this.draw()) })),
      ]),
      panel('uv-display', 'Display', () => [splitRow('', checkbox('uv-stretch', 'Display Stretch', this.showStretch, (v) => ((this.showStretch = v), this.draw(), this.drawUI())))]),
    ];
  }

  drawUI() {
    patch(this.ui, [this.showToolbar ? this.toolbar() : null, this.showSidebar ? this.sidebar() : null, lastOpPanel(this)]);
  }

  update(kinds?: Set<ChangeKind>) {
    void kinds;
    if (this.awaitingOpen !== false && lastImage && lastImage !== this.awaitingOpen) {
      this.awaitingOpen = false;
      this.setImage(lastImage);
    }
    this.draw();
    this.drawUI();
  }

  // -------------------------------------------------------------------
  // drawing

  draw() {
    const c = this.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = this.el.clientWidth,
      H = this.el.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#303030';
    g.fillRect(0, 0, W, H);
    const t0 = this.toPx(0, 1),
      t1 = this.toPx(1, 0);
    const img = this.image();
    if (img) {
      g.imageSmoothingEnabled = this.scale() / Math.max(1, img.width) < 2;
      g.drawImage(imageCanvas(img), t0.x, t0.y, t1.x - t0.x, t1.y - t0.y);
    } else {
      g.fillStyle = '#3a3a3a';
      g.fillRect(t0.x, t0.y, t1.x - t0.x, t1.y - t0.y);
    }
    this.drawGrid(g, !!img);
    const layers = uvLayers();
    if (!layers.length || layers.every((l) => !l.faces.length)) {
      g.fillStyle = '#888';
      g.font = '12px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText(app.doc.mode === 'EDIT' ? 'Select faces in the 3D Viewport to edit their UVs' : 'Enter Edit Mode on a mesh to edit its UVs', W / 2, 24);
    }
    const mode = uvSelectMode();
    const stretch = this.showStretch ? layers.map((l) => areaStretch(new UVTopo(l))) : null;
    layers.forEach((layer, li) => {
      const me = layer.me;
      const sel = selReader(layer);
      const uv = me.uvs;
      const px = new Float32Array(me.indices.length * 2);
      for (const f of layer.faces)
        for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++) {
          const p = this.toPx(uv[k * 2], uv[k * 2 + 1]);
          px[k * 2] = p.x;
          px[k * 2 + 1] = p.y;
        }
      // faces
      for (const f of layer.faces) {
        const s = me.offsets[f],
          e = me.offsets[f + 1];
        g.beginPath();
        let all = true;
        for (let k = s; k < e; k++) {
          if (k === s) g.moveTo(px[k * 2], px[k * 2 + 1]);
          else g.lineTo(px[k * 2], px[k * 2 + 1]);
          if (!sel(k)) all = false;
        }
        g.closePath();
        if (stretch) {
          const v = stretch[li].get(f) ?? 0;
          g.fillStyle = `hsla(${240 * (1 - v)}, 85%, 50%, 0.55)`;
          g.fill();
        }
        if (all) {
          g.fillStyle = 'rgba(255,133,0,0.22)';
          g.fill();
        } else if (!stretch) {
          g.fillStyle = 'rgba(255,255,255,0.05)';
          g.fill();
        }
      }
      // edges: unselected first, then seams, then selected on top
      const pass = (want: 'plain' | 'seam' | 'sel') => {
        g.beginPath();
        for (const f of layer.faces) {
          const s = me.offsets[f],
            e = me.offsets[f + 1];
          for (let k = s; k < e; k++) {
            const k2 = k + 1 < e ? k + 1 : s;
            const isSel = sel(k) && sel(k2);
            const isSeam = !!me.seams?.[k];
            const kind = isSel ? 'sel' : isSeam ? 'seam' : 'plain';
            if (kind !== want) continue;
            g.moveTo(px[k * 2], px[k * 2 + 1]);
            g.lineTo(px[k2 * 2], px[k2 * 2 + 1]);
          }
        }
        g.strokeStyle = want === 'sel' ? '#ff8500' : want === 'seam' ? '#e0301e' : '#bdbdbd';
        g.lineWidth = want === 'plain' ? 1 : 1.6;
        g.stroke();
      };
      g.lineJoin = 'round';
      pass('plain');
      pass('seam');
      pass('sel');
      // vertices
      if (mode === 'VERTEX' || mode === 'EDGE') {
        const sz = mode === 'VERTEX' ? 4 : 0;
        for (const f of layer.faces)
          for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++) {
            const pinned = isPinned(me, k);
            if (!sz && !pinned) continue;
            g.fillStyle = pinned ? '#ff2020' : sel(k) ? '#ff8500' : '#111';
            const q = pinned ? 6 : sz;
            g.fillRect(px[k * 2] - q / 2, px[k * 2 + 1] - q / 2, q, q);
          }
      } else {
        for (const f of layer.faces) {
          let u = 0,
            v = 0,
            all = true;
          const s = me.offsets[f],
            e = me.offsets[f + 1];
          for (let k = s; k < e; k++) {
            u += px[k * 2] / (e - s);
            v += px[k * 2 + 1] / (e - s);
            if (!sel(k)) all = false;
            if (isPinned(me, k)) {
              g.fillStyle = '#ff2020';
              g.fillRect(px[k * 2] - 3, px[k * 2 + 1] - 3, 6, 6);
            }
          }
          g.fillStyle = all ? '#ff8500' : '#111';
          g.fillRect(u - 2, v - 2, 4, 4);
        }
      }
    });
    this.drawOverlays(g);
  }

  private drawGrid(g: CanvasRenderingContext2D, hasImage: boolean) {
    const s = this.scale();
    // adaptive subdivision: lines 24–96 px apart
    let n = 8;
    while (s / n > 96 && n < 4096) n *= 2;
    while (s / n < 24 && n > 1) n /= 2;
    g.lineWidth = 1;
    g.strokeStyle = hasImage ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.3)';
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = this.toPx(i / n, 0),
        b = this.toPx(i / n, 1);
      g.moveTo(Math.round(a.x) + 0.5, a.y);
      g.lineTo(Math.round(b.x) + 0.5, b.y);
      const c = this.toPx(0, i / n),
        d = this.toPx(1, i / n);
      g.moveTo(c.x, Math.round(c.y) + 0.5);
      g.lineTo(d.x, Math.round(d.y) + 0.5);
    }
    g.stroke();
    const t0 = this.toPx(0, 1),
      t1 = this.toPx(1, 0);
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    g.strokeRect(t0.x, t0.y, t1.x - t0.x, t1.y - t0.y);
  }

  private drawOverlays(g: CanvasRenderingContext2D) {
    // 2D cursor
    const cur = this.toPx(uvCursor.u, uvCursor.v);
    g.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) {
      g.strokeStyle = i % 2 ? '#fff' : '#e00';
      g.beginPath();
      g.arc(cur.x, cur.y, 8, (i * Math.PI) / 4, ((i + 1) * Math.PI) / 4);
      g.stroke();
    }
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cur.x - 12, cur.y);
    g.lineTo(cur.x - 4, cur.y);
    g.moveTo(cur.x + 4, cur.y);
    g.lineTo(cur.x + 12, cur.y);
    g.moveTo(cur.x, cur.y - 12);
    g.lineTo(cur.x, cur.y - 4);
    g.moveTo(cur.x, cur.y + 4);
    g.lineTo(cur.x, cur.y + 12);
    g.stroke();
    // box / lasso / circle selections
    const shape = shapeSelect.kind ? { kind: shapeSelect.kind, pts: shapeSelect.pts } : this.drag;
    g.setLineDash([4, 3]);
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    if (shape?.kind === 'BOX' && shape.pts.length === 2) {
      const [a, b] = shape.pts;
      g.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (shape?.kind === 'LASSO' && shape.pts.length > 1) {
      g.beginPath();
      shape.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fill();
      g.stroke();
    } else if (shape?.kind === 'CIRCLE' && shape.pts.length) {
      g.beginPath();
      g.arc(shape.pts[0].x, shape.pts[0].y, shapeSelect.radius, 0, Math.PI * 2);
      g.stroke();
    }
    g.setLineDash([]);
    // sculpt / circle tool brush
    if (this.hover && (isSculpt(this.tool) || (this.tool === 'select_circle' && !shapeSelect.kind))) {
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.arc(this.hover.x, this.hover.y, isSculpt(this.tool) ? uvSculpt.size : shapeSelect.radius, 0, Math.PI * 2);
      g.stroke();
    }
  }

  // -------------------------------------------------------------------
  // input

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    const trackpad = e.deltaMode === 0 && (Math.abs(e.deltaX) > 0 || !Number.isInteger(e.deltaY));
    if (e.ctrlKey) this.zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
    else if (trackpad) {
      this.pan.x -= e.deltaX;
      this.pan.y -= e.deltaY;
      this.draw();
    } else this.zoomAt(e.deltaY > 0 ? 0.8 : 1.25, p.x, p.y);
  }

  private onDown(e: PointerEvent) {
    this.el.focus({ preventScroll: true });
    if (app.modal) return; // the global modal handlers receive the event
    const p0 = this.local(e);
    if (e.button === 1) {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      let last = p0;
      const zoomDrag = e.ctrlKey;
      const move = (ev: PointerEvent) => {
        const q = this.local(ev);
        if (zoomDrag) this.zoomAt(Math.exp((q.x - last.x - (q.y - last.y)) * 0.01), p0.x, p0.y);
        else {
          this.pan.x += q.x - last.x;
          this.pan.y += q.y - last.y;
          this.draw();
        }
        last = q;
      };
      const up = () => (this.canvas.removeEventListener('pointermove', move), this.canvas.removeEventListener('pointerup', up));
      this.canvas.addEventListener('pointermove', move);
      this.canvas.addEventListener('pointerup', up);
      return;
    }
    if (e.button === 2) {
      if (e.shiftKey) return this.cursorDrag(e);
      openUVContextMenu(e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0) return;
    const event = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
    const area = this.area;
    if (this.tool === 'cursor') return this.cursorDrag(e);
    if (isSculpt(this.tool)) {
      if (!uvEditPoll()) return;
      const op = e.shiftKey ? 'sculpt.uv_sculpt_relax' : this.tool === 'grab' ? 'sculpt.uv_sculpt_grab' : this.tool === 'relax' ? 'sculpt.uv_sculpt_relax' : 'sculpt.uv_sculpt_pinch';
      app.run(op, { use_invert: event.ctrl }, { area, event });
      return;
    }
    if (this.tool === 'select_circle' && !e.altKey) {
      // paint selection while the button is held
      const mode = event.ctrl ? 'SUB' : e.shiftKey ? 'ADD' : 'SET';
      if (mode === 'SET') app.run('uv.select_all', { action: 'DESELECT' }, { invoke: false, area });
      const paint = (ev: { clientX: number; clientY: number }) => {
        const q = this.local(ev);
        const c = this.toUV(q.x, q.y);
        app.run('uv.select_circle', { x: c.u, y: c.v, uv_radius: shapeSelect.radius / this.scale(), mode: mode === 'SUB' ? 'SUB' : 'ADD' }, { invoke: false, area });
      };
      paint(e);
      const move = (ev: PointerEvent) => {
        this.hover = this.local(ev);
        paint(ev);
      };
      const up = () => (removeEventListener('pointermove', move), removeEventListener('pointerup', up));
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return;
    }
    let dragging = false;
    const pts: { x: number; y: number }[] = [p0];
    const lassoDrag = event.ctrl && this.tool !== 'select_box';
    const move = (ev: PointerEvent) => {
      const q = this.local(ev);
      if (!dragging && Math.hypot(q.x - p0.x, q.y - p0.y) > 4) {
        dragging = true;
        if (this.startDrag(e, event)) {
          cleanup();
          return;
        }
      }
      if (!dragging) return;
      if (this.tool === 'select_lasso' || lassoDrag) {
        pts.push(q);
        this.drag = { kind: 'LASSO', pts };
      } else {
        pts[1] = q;
        this.drag = { kind: 'BOX', pts: [p0, q] };
      }
      this.draw();
    };
    const cleanup = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    const up = () => {
      cleanup();
      if (!dragging) {
        this.click(event);
        return;
      }
      const d = this.drag;
      this.drag = null;
      if (!d) return this.draw();
      const mode = d.kind === 'LASSO' && lassoDrag ? (e.shiftKey ? 'SUB' : 'ADD') : e.shiftKey ? 'ADD' : event.ctrl ? 'SUB' : 'SET';
      if (d.kind === 'BOX' && d.pts.length === 2) runShapeSelect(this, 'BOX', d.pts, mode, area);
      else if (d.kind === 'LASSO' && d.pts.length > 2) runShapeSelect(this, 'LASSO', d.pts, mode, area);
      this.draw();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** A drag started: transform tools and tweak start a modal; returns true when handled. */
  private startDrag(e: PointerEvent, event: { x: number; y: number; shift: boolean; ctrl: boolean; alt: boolean }): boolean {
    if (!uvEditPoll()) return false;
    const area = this.area;
    if (this.tool === 'move' || this.tool === 'rotate' || this.tool === 'scale' || this.tool === 'rip_region') {
      if (this.tool === 'rip_region') return app.run('uv.rip_move', { release_confirm: true }, { area, event }) === 'RUNNING_MODAL';
      const op = this.tool === 'move' ? 'uv.translate' : this.tool === 'rotate' ? 'uv.rotate' : 'uv.resize';
      return app.run(op, { release_confirm: true }, { area, event }) === 'RUNNING_MODAL';
    }
    if (this.tool === 'select' && !event.ctrl) {
      // tweak: drag the element under the pointer (selecting it first)
      const loc = this.toUV(this.local(e).x, this.local(e).y);
      const tl = layerTopos();
      const hit = elementAt(tl, loc.u, loc.v, pickRadius(this));
      if (!hit) return false;
      const sel = tl[hit.li].sel;
      if (!hit.corners.every(sel)) app.run('uv.select', { location: [loc.u, loc.v], extend: event.shift }, { invoke: false, area });
      return startUVTransform('TRANSLATE', app.context(area, event), { release_confirm: true }) === 'RUNNING_MODAL';
    }
    return false;
  }

  /** Click with a select or transform tool. */
  private click(event: { x: number; y: number; shift: boolean; ctrl: boolean; alt: boolean }) {
    if (!uvEditPoll()) return;
    const area = this.area;
    const ctx = app.context(area, event);
    const loc = eventUV(ctx);
    if (!loc) return;
    if (event.alt && event.ctrl) app.run('uv.select_edge_ring', { extend: event.shift, location: loc }, { invoke: false, area });
    else if (event.alt) app.run('uv.select_loop', { extend: event.shift, location: loc }, { invoke: false, area });
    else if (event.ctrl) app.run('uv.shortest_path_pick', { location: loc }, { invoke: false, area });
    else app.run('uv.select', { location: loc, toggle: event.shift, deselect_all: !event.shift }, { invoke: false, area });
  }

  private cursorDrag(e: PointerEvent) {
    const set = (ev: { clientX: number; clientY: number }) => {
      const q = this.local(ev);
      const uv = this.toUV(q.x, q.y);
      uvCursor.u = uv.u;
      uvCursor.v = uv.v;
      this.draw();
      this.drawUI();
    };
    set(e);
    const up = () => (removeEventListener('pointermove', set), removeEventListener('pointerup', up));
    addEventListener('pointermove', set);
    addEventListener('pointerup', up);
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && !e.altKey && !e.shiftKey) {
      if (e.code === 'KeyT') return this.toggleToolbar(), true;
      if (e.code === 'KeyN') return this.toggleSidebar(), true;
      if (e.code === 'KeyW') {
        const i = SELECT_TOOLS.findIndex((t) => t.id === this.tool);
        this.setTool(SELECT_TOOLS[(i + 1) % SELECT_TOOLS.length].id);
        return true;
      }
    }
    return false;
  }

  serialize() {
    return { zoom: this.zoom, pan: this.pan, image: this.imageId, pivot: this.pivot, tool: this.tool, toolbar: this.showToolbar, sidebar: this.showSidebar, tab: this.sidebarTab, stretch: this.showStretch };
  }

  resize() {
    this.draw();
  }

  dispose() {}
}

/** Move the selected UVs by an offset (UV Vertex panel). */
function moveSelection(du: number, dv: number) {
  for (const layer of uvLayers()) {
    const t = new UVTopo(layer);
    const uvs = new Float32Array(layer.me.uvs);
    let n = 0;
    for (const corners of selGroups(t, selReader(layer)).values())
      for (const c of corners) {
        uvs[c * 2] += du;
        uvs[c * 2 + 1] += dv;
        n++;
      }
    if (n) layer.me.uvs = uvs;
  }
  uvChanged();
}

// kept for scripts and older keymaps: frame operators of the UV editor
registerOperators([
  {
    idname: 'uv.view_all',
    label: 'Frame All',
    internal: true,
    poll: (ctx) => ctx.area?.type === 'UV',
    exec: (ctx) => void (ctx.area!.editor as UVEditor).frameAll(),
    undo: false,
  },
  {
    idname: 'uv.view_selected',
    label: 'Frame Selected',
    internal: true,
    poll: (ctx) => ctx.area?.type === 'UV',
    exec: (ctx) => ((ctx.area!.editor as UVEditor).frameSelected() ? 'FINISHED' : 'CANCELLED'),
    undo: false,
  },
]);

registerEditor({ id: 'UV', label: 'UV Editor', icon: 'uv_editor', group: 'General', create: (a, state) => new UVEditor(a, state) });
