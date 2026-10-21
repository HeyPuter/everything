// UV Editor: shows the UVs of the mesh being edited over its texture, with tools (toolbar),
// a sidebar, header menus, selection, transforms and UV sculpting.
import { canvasGrey, canvasTextGrey } from '../../ui/canvastheme';
import { h, patch, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, registerOperators, type ChangeKind } from '../../app/app';
import { registerEditor, type Area, type Editor } from '../../ui/screen';
import { openMenu, openPopover, type MenuItem } from '../../ui/menu';
import { enumMenu, enumRow, panel, numberField, checkbox } from '../../ui/widgets';
import { splitRow } from '../../ui/props';
import { lastOpPanel } from '../../ui/redo';
import type { ImageData } from '../../data/types';
import { imageCanvas } from '../../render/images';
import { isTiled, atlasLayout, tileCell } from '../../render/udim';
import { lastImage } from '../../ops/data';
import { newImageDialog } from '../../render/final/imageeditor';
import type { View2D } from '../../render/final/imageops';
import { UVTopo, selReader, isPinned, faceUVArea, face3DArea } from './uvcore';
import { selGroups, selBounds } from './uvalgo';
import { uvLayers, uvCursor, uvSelectMode, autoImage, uvEditPoll, uvChanged, type UVView } from './uvcontext';
import { shapeSelect, runShapeSelect, elementAt, eventUV } from './uvops-select';
import { layerTopos, pickRadius } from './uvcontext';
import { startUVTransform, uvSnapSettings, type UVPivot } from './uvtransform';
import { uvSculpt } from './uvsculpt';
import { selectMenu, uvMenu, openUVContextMenu } from './uvmenus';
import './uvops-select';
import './uvops-edit';
import './uvexport';
import './uvicons';
import './uvstyle';
import './uvsculpt';
import { drawCustomRegion } from './uvregion';
import { navGizmo2D } from '../../render/final/navgizmo2d';
import type { StitchPreview } from './uvstitch';
import { ANNOTATE_TOOLS, annotatePointerDown, annotateKeyHeld, annotateModeOf, annotationsPanel, drawAnnotations2D, isAnnotateTool, type AnnotateTool, type Annotate2DHost, type Annotation2DOwner } from '../../mask/annotate2d';

export type UVTool = 'select' | 'select_box' | 'select_circle' | 'select_lasso' | 'cursor' | 'move' | 'rotate' | 'scale' | 'transform' | 'rip_region' | 'grab' | 'relax' | 'pinch' | AnnotateTool;

interface ToolDef {
  id: UVTool;
  label: string;
  icon: string;
  description: string;
  group?: 'select' | 'sculpt' | 'annotate';
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
  { id: 'transform', label: 'Transform', icon: 'transform', description: 'Drag inside the selection frame to move, its corners to scale, its sides to scale along one axis, outside it to rotate' },
  null,
  ...ANNOTATE_TOOLS.map((t): ToolDef => ({ id: t.id, label: t.label, icon: t.icon, group: 'annotate', description: t.tip })),
  null,
  { id: 'rip_region', label: 'Rip Region', icon: 'rip', description: 'Drag to tear the selected UVs off their neighbours' },
  null,
  { id: 'grab', label: 'Grab', icon: 'uv_grab', group: 'sculpt', description: 'Drag UVs under the brush' },
  { id: 'relax', label: 'Relax', icon: 'uv_relax', group: 'sculpt', description: 'Smooth out UVs under the brush' },
  { id: 'pinch', label: 'Pinch', icon: 'uv_pinch', group: 'sculpt', description: 'Pull UVs toward the brush center (Ctrl: push away)' },
];

const SELECT_TOOLS = TOOLS.filter((t): t is ToolDef => !!t && t.group === 'select');
const ANNOTATE_UV_TOOLS = TOOLS.filter((t): t is ToolDef => !!t && t.group === 'annotate');
/** tool groups shown as one toolbar slot with variants */
const SLOT_GROUPS: Record<string, ToolDef[]> = { select: SELECT_TOOLS, annotate: ANNOTATE_UV_TOOLS };
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

/** How much each face's UV angles differ from its 3D angles: 0 (none) … 1 (strong). */
function angleStretch(t: UVTopo): Map<number, number> {
  const me = t.me,
    p = me.positions,
    uv = me.uvs;
  const out = new Map<number, number>();
  const ang = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    const la = Math.hypot(ax, ay, az),
      lb = Math.hypot(bx, by, bz);
    if (la < 1e-12 || lb < 1e-12) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb))));
  };
  for (const f of t.faces) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    let sum = 0;
    for (let c = s; c < e; c++) {
      const a = c > s ? c - 1 : e - 1,
        b = c + 1 < e ? c + 1 : s;
      const vi = me.indices[c] * 3,
        va = me.indices[a] * 3,
        vb = me.indices[b] * 3;
      const a3 = ang(p[va] - p[vi], p[va + 1] - p[vi + 1], p[va + 2] - p[vi + 2], p[vb] - p[vi], p[vb + 1] - p[vi + 1], p[vb + 2] - p[vi + 2]);
      const a2 = ang(uv[a * 2] - uv[c * 2], uv[a * 2 + 1] - uv[c * 2 + 1], 0, uv[b * 2] - uv[c * 2], uv[b * 2 + 1] - uv[c * 2 + 1], 0);
      sum += Math.abs(a3 - a2);
    }
    out.set(f, Math.min(1, (sum / (e - s)) / (Math.PI / 4)));
  }
  return out;
}

export class UVEditor implements Editor, UVView, View2D, Annotate2DHost {
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
  stretchType: 'AREA' | 'ANGLE' = 'AREA';
  /** overlay opacity of the UV edges, and whether faces get a fill */
  uvOpacity = 1;
  showFaces = true;
  /** Overlays: master switch, edge style, stretch opacity and the background grid */
  showOverlays = true;
  edgeDisplay: 'OUTLINE' | 'DASH' | 'BLACK' | 'WHITE' = 'OUTLINE';
  /** also draw the UVs of the mesh with its modifiers applied */
  showModifiedEdges = false;
  stretchOpacity = 0.9;
  showGrid = true;
  /** navigation buttons (Ctrl `) */
  showGizmo = true;
  /** UDIM tile grid shown without a tiled image (columns, rows) */
  tileGrid: [number, number] = [1, 1];
  /** transforms land on pixel corners / centres; transforms keep UVs in the 0–1 square */
  pixelRoundMode: 'DISABLED' | 'CORNER' | 'CENTER' = 'DISABLED';
  lockBounds = false;
  /** faces moved by a running Stitch (drawn as a preview) */
  stitchPreview: StitchPreview | null = null;
  /** rectangle being dragged by Set User Region (screen pixels) */
  regionDrag: { x0: number; y0: number; x1: number; y1: number } | null = null;
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
    const st = (state ?? {}) as Partial<{ zoom: number; pan: { x: number; y: number }; image: string | null; pivot: UVPivot; tool: UVTool; toolbar: boolean; sidebar: boolean; tab: string; stretch: boolean; stretchType: string; opacity: number; faces: boolean; mode: string; overlays: boolean; edges: string; stretchOpacity: number; grid: boolean }>;
    if (st.overlays === false) this.showOverlays = false;
    if (st.edges === 'DASH' || st.edges === 'BLACK' || st.edges === 'WHITE') this.edgeDisplay = st.edges;
    if (typeof st.stretchOpacity === 'number') this.stretchOpacity = st.stretchOpacity;
    if (st.grid === false) this.showGrid = false;
    const ex = state as { pixelRound?: string; lockBounds?: boolean; tiles?: [number, number]; modified?: boolean } | undefined;
    if (ex?.modified) this.showModifiedEdges = true;
    if (Array.isArray(ex?.tiles)) this.tileGrid = [Math.max(1, Math.min(10, ex.tiles[0] | 0)), Math.max(1, Math.min(100, ex.tiles[1] | 0))];
    if (ex?.pixelRound === 'CORNER' || ex?.pixelRound === 'CENTER') this.pixelRoundMode = ex.pixelRound;
    if (ex?.lockBounds) this.lockBounds = true;
    if (st.zoom) this.zoom = st.zoom;
    if (st.pan) this.pan = { ...st.pan };
    if (st.image !== undefined) this.imageId = st.image;
    if (st.pivot) this.pivot = st.pivot;
    if (st.tool && TOOLS.some((t) => t?.id === st.tool)) this.tool = st.tool;
    if (st.toolbar !== undefined) this.showToolbar = st.toolbar;
    if (st.sidebar !== undefined) this.showSidebar = st.sidebar;
    if (st.tab) this.sidebarTab = st.tab;
    if (st.stretch) this.showStretch = st.stretch;
    if (st.stretchType === 'ANGLE') this.stretchType = 'ANGLE';
    if (typeof st.opacity === 'number') this.uvOpacity = st.opacity;
    if (st.faces === false) this.showFaces = false;
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => {
      this.hover = this.local(e);
      if (isSculpt(this.tool)) this.draw();
      if (this.tool === 'transform' && !app.modal) {
        const part = this.transformPart(this.hover);
        this.canvas.style.cursor = part === 'MOVE' ? 'move' : part === 'SCALE' ? 'nwse-resize' : part === 'SIDE_X' ? 'ew-resize' : part === 'SIDE_Y' ? 'ns-resize' : part === 'ROTATE' ? 'alias' : '';
      } else if (this.canvas.style.cursor) this.canvas.style.cursor = '';
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

  // 2D annotations (kept on the shown image, else on the scene)
  annToScreen(u: number, v: number): [number, number] {
    const p = this.toPx(u, v);
    return [p.x, p.y];
  }
  annFromClient(clientX: number, clientY: number): [number, number] {
    const q = this.local({ clientX, clientY });
    const uv = this.toUV(q.x, q.y);
    return [uv.u, uv.v];
  }
  annotationOwner(): Annotation2DOwner | null {
    return ((this.image() as unknown as Annotation2DOwner | null) ?? (app.doc.scene as unknown as Annotation2DOwner)) as Annotation2DOwner;
  }

  /** Pan by screen pixels. */
  panBy(dx: number, dy: number) {
    this.pan.x += dx;
    this.pan.y += dy;
    this.draw();
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
      h('button', { class: { 'hdr-toggle': true, on: !!ts.use_snap_uv }, 'data-tip': 'Snap (Shift Tab)\nSnap while moving UVs; hold Ctrl to toggle while transforming', onclick: () => setTs('use_snap_uv', !ts.use_snap_uv, 'Snap') }, icon(ts.use_snap_uv ? 'snap_on' : 'snap_off')),
      h(
        'button',
        {
          class: 'hdr-icondrop uv-snapping',
          'data-tip': 'Snapping\nWhat moving UVs snap to and which transforms snap',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openPopover(e.currentTarget as HTMLElement, () => this.snapPopover(), { width: 250 });
          },
        },
        icon(ts.snap_uv_element === 'VERTEX' ? 'snap_vertex' : 'snap_increment'),
        icon('down_arrow_hlt', 'tiny'),
      ),
      h('button', { class: { 'hdr-toggle': true, on: ts.use_proportional_edit }, 'data-tip': 'Proportional Editing (O)\nMove nearby UVs too, with a falloff', onclick: () => setTs('use_proportional_edit', !ts.use_proportional_edit, 'Proportional Editing') }, icon(ts.use_proportional_edit ? 'prop_on' : 'prop_off')),
      h(
        'button',
        {
          class: 'hdr-icondrop uv-proportional',
          'data-tip': 'Proportional Editing\nFalloff, size and whether only connected UVs follow',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openPopover(e.currentTarget as HTMLElement, () => this.proportionalPopover(), { width: 230 });
          },
        },
        icon('down_arrow_hlt', 'tiny'),
      ),
      h('div', { class: 'hdr-sep' }),
      h(
        'div',
        { class: 'hdr-group', key: 'uv-overlay' },
        h('button', { class: { 'hdr-toggle': true, on: this.showOverlays }, 'data-tip': 'Show Overlays (Shift Alt Z)', onclick: () => this.toggleOverlays() }, icon('overlay')),
        h(
          'button',
          {
            class: 'hdr-icondrop uv-overlays',
            'data-tip': 'Overlays',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openPopover(e.currentTarget as HTMLElement, () => this.overlayPopover(), { width: 250 });
            },
          },
          icon('down_arrow_hlt', 'tiny'),
        ),
      ),
    );
  }

  /** Header ▸ Proportional Editing: connected only, falloff and size. */
  private proportionalPopover(): Child {
    const ts = app.doc.scene.tool_settings;
    const set = (fn: () => void, label: string) => (fn(), app.pushUndo(label), app.changed('ui'));
    return h(
      'div',
      { class: 'pop-panel' },
      h('div', { class: 'pop-title' }, 'Proportional Editing'),
      checkbox('uv-prop-conn', 'Connected Only', !!ts.use_proportional_connected, (v) => set(() => (ts.use_proportional_connected = v), 'Connected Only'), { tip: 'Only UVs of islands with selected UVs follow' }),
      enumMenu(
        'uv-prop-falloff',
        (['SMOOTH', 'SPHERE', 'ROOT', 'INVERSE_SQUARE', 'SHARP', 'LINEAR', 'CONSTANT', 'RANDOM'] as const).map((f) => ({ value: f, label: f === 'INVERSE_SQUARE' ? 'Inverse Square' : f[0] + f.slice(1).toLowerCase() })),
        ts.proportional_edit_falloff,
        (v) => set(() => (ts.proportional_edit_falloff = v as 'SMOOTH'), 'Proportional Falloff'),
      ),
      numberField({ id: 'uv-prop-size', label: 'Size', value: ts.proportional_size, min: 0.0001, max: 100, set: (v, f) => ((ts.proportional_size = v), f && app.pushUndo('Proportional Size'), app.changed('ui')) }),
    );
  }

  /** Header ▸ Snapping: target, base, affected transforms and the rotation step. */
  private snapPopover(): Child {
    const ts = app.doc.scene.tool_settings;
    const sx = uvSnapSettings();
    const set = (fn: () => void, label: string) => (fn(), app.pushUndo(label), app.changed('ui'));
    const rad = (d: number) => (d * Math.PI) / 180;
    return h(
      'div',
      { class: 'pop-panel' },
      h('div', { class: 'pop-title' }, 'Snap Target'),
      enumRow(
        'uv-snap-target',
        [
          { value: 'INCREMENT', label: 'Increment', icon: 'snap_increment', description: 'Snap to steps of the grid' },
          { value: 'VERTEX', label: 'Vertex', icon: 'snap_vertex', description: 'Snap to UV vertices that are not moving' },
        ],
        ts.snap_uv_element ?? 'INCREMENT',
        (v) => set(() => (ts.snap_uv_element = v as 'VERTEX'), 'Snap Target'),
      ),
      h('div', { class: 'pop-title' }, 'Snap Base'),
      enumRow(
        'uv-snap-base',
        [
          { value: 'CLOSEST', label: 'Closest', description: 'The moving UV closest to the target lands on it' },
          { value: 'CENTER', label: 'Center', description: 'The centre of the moving UVs lands on the target' },
          { value: 'MEDIAN', label: 'Median', description: 'The median of the moving UVs lands on the target' },
        ],
        ts.snap_target === 'ACTIVE' ? 'MEDIAN' : ts.snap_target,
        (v) => set(() => (ts.snap_target = v as 'CLOSEST'), 'Snap Base'),
      ),
      h('div', { class: 'pop-title' }, 'Affect'),
      h(
        'div',
        { style: 'display: flex; gap: 4px' },
        checkbox('uv-snap-move', 'Move', sx.use_snap_translate !== false, (v) => set(() => (sx.use_snap_translate = v), 'Snap Affect')),
        checkbox('uv-snap-rot', 'Rotate', sx.use_snap_rotate !== false, (v) => set(() => (sx.use_snap_rotate = v), 'Snap Affect')),
        checkbox('uv-snap-scale', 'Scale', sx.use_snap_scale !== false, (v) => set(() => (sx.use_snap_scale = v), 'Snap Affect')),
      ),
      h('div', { class: 'pop-title' }, 'Rotation Increment'),
      h(
        'div',
        { style: 'display: flex; gap: 4px' },
        numberField({ id: 'uv-snap-ang', value: sx.snap_angle_increment_2d ?? rad(5), min: rad(0.01), max: Math.PI, unit: 'angle', tip: 'Rotation step while snapping', set: (v) => (sx.snap_angle_increment_2d = v) }),
        numberField({ id: 'uv-snap-angp', value: sx.snap_angle_increment_2d_precision ?? rad(1), min: rad(0.01), max: Math.PI, unit: 'angle', tip: 'Rotation step while snapping with Shift held', set: (v) => (sx.snap_angle_increment_2d_precision = v) }),
      ),
    );
  }

  toggleOverlays() {
    this.showOverlays = !this.showOverlays;
    this.draw();
    this.area.drawHeader();
  }

  /** Header ▸ Overlays: guides, UV geometry display and stretch. */
  private overlayPopover(): Child {
    const redraw = () => (this.draw(), this.drawUI(), app.changed('ui'));
    return h(
      'div',
      { class: 'pop-panel' },
      h('div', { class: 'pop-title' }, 'Guides'),
      checkbox('uv-ov-grid', 'Grid', this.showGrid, (v) => ((this.showGrid = v), redraw()), { tip: 'Show the grid over the UV square (it is always shown without an image)' }),
      h(
        'div',
        { style: 'display: flex; gap: 4px' },
        numberField({ id: 'uv-ov-tiles-x', label: 'Tiles X', value: this.tileGrid[0], int: true, min: 1, max: 10, set: (v) => ((this.tileGrid = [v, this.tileGrid[1]]), this.draw()) }),
        numberField({ id: 'uv-ov-tiles-y', label: 'Y', value: this.tileGrid[1], int: true, min: 1, max: 100, set: (v) => ((this.tileGrid = [this.tileGrid[0], v]), this.draw()) }),
      ),
      h('div', { class: 'pop-title' }, 'Geometry'),
      numberField({ id: 'uv-ov-opacity', label: 'UV Opacity', value: this.uvOpacity, min: 0, max: 1, slider: true, unit: 'factor', set: (v) => ((this.uvOpacity = v), this.draw()) }),
      enumRow(
        'uv-ov-edges',
        [
          { value: 'OUTLINE', label: 'Outline', description: 'Light edges with a dark border' },
          { value: 'DASH', label: 'Dash', description: 'Dashed black and white edges' },
          { value: 'BLACK', label: 'Black', description: 'Thin black edges' },
          { value: 'WHITE', label: 'White', description: 'Thin white edges' },
        ],
        this.edgeDisplay,
        (v) => ((this.edgeDisplay = v as 'OUTLINE'), redraw()),
      ),
      checkbox('uv-ov-modified', 'Modified Edges', this.showModifiedEdges, (v) => ((this.showModifiedEdges = v), redraw()), { tip: 'Also show the UVs of the mesh with its modifiers applied' }),
      checkbox('uv-ov-faces', 'Faces', this.showFaces, (v) => ((this.showFaces = v), redraw())),
      h('div', { class: 'pop-title' }, 'UV Stretch'),
      checkbox('uv-ov-stretch', 'Display Stretch', this.showStretch, (v) => ((this.showStretch = v), redraw())),
      enumRow(
        'uv-ov-stype',
        [
          { value: 'ANGLE', label: 'Angle', description: 'Colour faces by how much their UV angles differ from the 3D angles' },
          { value: 'AREA', label: 'Area', description: 'Colour faces by how much their UV area differs from the 3D area' },
        ],
        this.stretchType,
        (v) => ((this.stretchType = v as 'AREA'), redraw()),
      ),
      numberField({ id: 'uv-ov-sop', label: 'Opacity', value: this.stretchOpacity, min: 0, max: 1, slider: true, unit: 'factor', set: (v) => ((this.stretchOpacity = v), this.draw()) }),
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
    if (isAnnotateTool(t)) this.lastAnnotate = t;
    this.drawUI();
    this.draw();
  }

  // -------------------------------------------------------------------
  // toolbar and sidebar

  private toolbar(): Child {
    const editing = app.doc.mode === 'EDIT';
    const list = TOOLS.filter((t) => !t || editing || t.id === 'cursor' || t.group === 'select' || t.group === 'annotate');
    // one slot per tool group (select, annotate): the active tool of the group or the last used
    const shownGroups = new Set<string>();
    const items: Child[] = [];
    list.forEach((t, i) => {
      if (!t) {
        if (items.length && (items[items.length - 1] as { attrs?: { class?: string } })?.attrs?.class !== 'tb-sep') items.push(h('div', { key: `sep${i}`, class: 'tb-sep' }));
        return;
      }
      const group = t.group && SLOT_GROUPS[t.group] ? t.group : null;
      if (group) {
        if (shownGroups.has(group)) return;
        shownGroups.add(group);
        const members = SLOT_GROUPS[group];
        t = members.find((x) => x.id === this.tool) ?? members.find((x) => x.id === (group === 'select' ? this.lastSelect : this.lastAnnotate)) ?? members[0];
      }
      const tool = t;
      const slot = !!group;
      const alternatives = group ? SLOT_GROUPS[group] : [];
      items.push(
        h(
          'button',
          {
            key: `tool-${slot ? tool.group : tool.id}`,
            class: { 'tb-tool': true, on: tool.id === this.tool, 'has-alt': slot },
            'data-tool': tool.id,
            'data-tip': `${tool.label}${tool.shortcut ? `\nShortcut: ${tool.shortcut}` : ''}\n${tool.description}`,
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              const alts = () => alternatives.map((s) => ({ label: s.label, icon: s.icon, active: s.id === this.tool, action: () => this.setTool(s.id) }));
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
  private lastAnnotate: AnnotateTool = 'annotate';

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
        splitRow('', checkbox('uv-sc-all', 'All Islands', uvSculpt.all_islands, (v) => ((uvSculpt.all_islands = v), this.drawUI()), { tip: 'Brush every island; otherwise only the island nearest to where the stroke starts' })),
      );
    } else if (this.tool === 'select_circle') {
      rows.push(splitRow('Radius', numberField({ id: 'uv-circ-r', value: shapeSelect.radius, int: true, min: 2, max: 500, unit: 'pixel', set: (v) => (shapeSelect.radius = v) })));
    }
    if (isAnnotateTool(this.tool)) rows.push(annotationsPanel('uv', this));
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
      panel('uv-display', 'Display', () => [
        splitRow('', checkbox('uv-faces', 'Display Faces', this.showFaces, (v) => ((this.showFaces = v), this.draw(), this.drawUI()))),
        splitRow('UV Opacity', numberField({ id: 'uv-opacity', value: this.uvOpacity, min: 0, max: 1, slider: true, unit: 'factor', set: (v) => ((this.uvOpacity = v), this.draw()) })),
        splitRow('', checkbox('uv-stretch', 'Display Stretch', this.showStretch, (v) => ((this.showStretch = v), this.draw(), this.drawUI()))),
        this.showStretch
          ? splitRow(
              'Type',
              enumRow(
                'uv-stretch-type',
                [
                  { value: 'ANGLE', label: 'Angle' },
                  { value: 'AREA', label: 'Area' },
                ],
                this.stretchType,
                (v) => ((this.stretchType = v as 'AREA'), this.draw(), this.drawUI()),
              ),
            )
          : null,
      ]),
    ];
  }

  drawUI() {
    patch(this.ui, [this.showToolbar ? this.toolbar() : null, this.showSidebar ? this.sidebar() : null, navGizmo2D(this, this.showSidebar ? 270 : 0, this.showGizmo), lastOpPanel(this)]);
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
    g.fillStyle = canvasGrey(0x30);
    g.fillRect(0, 0, W, H);
    const t0 = this.toPx(0, 1),
      t1 = this.toPx(1, 0);
    const img = this.image();
    if (isTiled(img)) this.drawTiles(g, img);
    else if (img) {
      g.imageSmoothingEnabled = this.scale() / Math.max(1, img.width) < 2;
      g.drawImage(imageCanvas(img), t0.x, t0.y, t1.x - t0.x, t1.y - t0.y);
    } else {
      g.fillStyle = canvasGrey(0x3a);
      g.fillRect(t0.x, t0.y, t1.x - t0.x, t1.y - t0.y);
    }
    if (this.showGrid || !img) this.drawGrid(g, !!img);
    const layers = uvLayers();
    if (!layers.length || layers.every((l) => !l.faces.length)) {
      g.fillStyle = canvasTextGrey(0x88);
      g.font = '12px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText(app.doc.mode === 'EDIT' ? 'Select faces in the 3D Viewport to edit their UVs' : 'Enter Edit Mode on a mesh to edit its UVs', W / 2, 24);
    }
    if (this.showOverlays) this.drawUVs(g, layers);
    this.drawOverlays(g);
    if (this.showOverlays) this.drawTransformFrame(g);
    if (this.showOverlays || this.regionDrag) drawCustomRegion(g, (u, v) => this.toPx(u, v), this.regionDrag);
    if (this.showOverlays) drawAnnotations2D(this, g);
    if (this.stitchPreview) this.drawStitchPreview(g, this.stitchPreview);
  }

  /** Stitch preview: where the moved faces end up. */
  private drawStitchPreview(g: CanvasRenderingContext2D, pv: StitchPreview) {
    g.save();
    g.fillStyle = 'rgba(80, 220, 120, 0.25)';
    g.strokeStyle = 'rgba(120, 255, 160, 0.9)';
    g.lineWidth = 1.2;
    for (const poly of pv.polys) {
      g.beginPath();
      for (let i = 0; i < poly.length; i += 2) {
        const p = this.toPx(poly[i], poly[i + 1]);
        if (i) g.lineTo(p.x, p.y);
        else g.moveTo(p.x, p.y);
      }
      g.closePath();
      g.fill();
      g.stroke();
    }
    g.restore();
  }

  /** Modified Edges: UV edges of the evaluated meshes (after modifiers), faint under the editable UVs. */
  private drawModifiedEdges(g: CanvasRenderingContext2D, layers: ReturnType<typeof uvLayers>) {
    g.save();
    g.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    g.lineWidth = 1;
    g.beginPath();
    for (const l of layers) {
      const em = app.graph.get(l.ob.id)?.mesh;
      if (!em?.uvs?.length) continue;
      for (let f = 0; f < em.offsets.length - 1; f++) {
        const s0 = em.offsets[f],
          e0 = em.offsets[f + 1];
        for (let c = s0; c < e0; c++) {
          const p = this.toPx(em.uvs[c * 2], em.uvs[c * 2 + 1]);
          if (c === s0) g.moveTo(p.x, p.y);
          else g.lineTo(p.x, p.y);
        }
        const p0 = this.toPx(em.uvs[s0 * 2], em.uvs[s0 * 2 + 1]);
        g.lineTo(p0.x, p0.y);
      }
    }
    g.stroke();
    g.restore();
  }

  /** UV faces, edges and vertices of the edited meshes (with stretch colours). */
  private drawUVs(g: CanvasRenderingContext2D, layers: ReturnType<typeof uvLayers>) {
    if (this.showModifiedEdges) this.drawModifiedEdges(g, layers);
    const mode = uvSelectMode();
    const stretch = this.showStretch ? layers.map((l) => (this.stretchType === 'ANGLE' ? angleStretch(new UVTopo(l)) : areaStretch(new UVTopo(l)))) : null;
    const SEL = '#ff9a1f';
    const plainColor = this.edgeDisplay === 'BLACK' ? '#000000' : this.edgeDisplay === 'WHITE' ? '#ffffff' : '#c6c7c8';
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
          g.fillStyle = `hsla(${240 * (1 - v)}, 85%, 50%, ${0.6 * this.stretchOpacity})`;
          g.fill();
        }
        if (!this.showFaces) continue;
        if (all) {
          g.fillStyle = 'rgba(255, 154, 31, 0.24)';
          g.fill();
        } else if (!stretch) {
          g.fillStyle = 'rgba(255, 255, 255, 0.1)';
          g.fill();
        }
      }
      // edges: plain, seams, edges with one selected end (a gradient), selected
      const paths = { plain: new Path2D(), seam: new Path2D(), sel: new Path2D() };
      const partial: [number, number, boolean][] = [];
      for (const f of layer.faces) {
        const s = me.offsets[f],
          e = me.offsets[f + 1];
        for (let k = s; k < e; k++) {
          const k2 = k + 1 < e ? k + 1 : s;
          const a = sel(k),
            b = sel(k2);
          const path = a && b ? paths.sel : me.seams?.[k] ? paths.seam : paths.plain;
          path.moveTo(px[k * 2], px[k * 2 + 1]);
          path.lineTo(px[k2 * 2], px[k2 * 2 + 1]);
          if (a !== b && mode === 'VERTEX') partial.push([k, k2, a]);
        }
      }
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.globalAlpha = this.uvOpacity;
      const outline = this.edgeDisplay === 'OUTLINE';
      if (outline) {
        // a dark border under every edge keeps them readable over any image
        g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        g.lineWidth = 3.6;
        for (const p of [paths.plain, paths.seam, paths.sel]) g.stroke(p);
      }
      if (this.edgeDisplay === 'DASH') {
        g.lineWidth = 1;
        g.strokeStyle = '#000000';
        g.stroke(paths.plain);
        g.setLineDash([4, 4]);
        g.strokeStyle = '#ffffff';
        g.stroke(paths.plain);
        g.setLineDash([]);
      } else {
        g.lineWidth = outline ? 1.6 : 1;
        g.strokeStyle = plainColor;
        g.stroke(paths.plain);
      }
      g.lineWidth = outline ? 1.6 : 1.5;
      g.strokeStyle = '#e8432c';
      g.stroke(paths.seam);
      for (const [k, k2, aSel] of partial) {
        const x0 = px[k * 2],
          y0 = px[k * 2 + 1],
          x1 = px[k2 * 2],
          y1 = px[k2 * 2 + 1];
        const gr = g.createLinearGradient(x0, y0, x1, y1);
        gr.addColorStop(0, aSel ? SEL : plainColor);
        gr.addColorStop(1, aSel ? plainColor : SEL);
        g.strokeStyle = gr;
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
      }
      g.strokeStyle = SEL;
      g.stroke(paths.sel);
      g.globalAlpha = 1;
      // vertices (round dots), pinned UVs in red; faces get a centre dot in face mode
      const dot = (x: number, y: number, r: number, color: string) => {
        g.fillStyle = color;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      };
      if (mode === 'VERTEX' || mode === 'EDGE') {
        for (const f of layer.faces)
          for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++) {
            const pinned = isPinned(me, k);
            if (pinned) dot(px[k * 2], px[k * 2 + 1], 3.5, '#fc261b');
            else if (mode === 'VERTEX') dot(px[k * 2], px[k * 2 + 1], 3, sel(k) ? SEL : '#0d0e10');
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
            if (isPinned(me, k)) dot(px[k * 2], px[k * 2 + 1], 3.5, '#fc261b');
          }
          g.fillStyle = all ? SEL : '#0d0e10';
          g.fillRect(u - 2, v - 2, 4, 4);
        }
      }
    });
  }

  /** UDIM images: every tile in its UV square, outlined and numbered. */
  private drawTiles(g: CanvasRenderingContext2D, img: ImageData) {
    const { cols, rows } = atlasLayout(img);
    const a = this.toPx(0, rows),
      b = this.toPx(cols, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(imageCanvas(img), a.x, a.y, b.x - a.x, b.y - a.y);
    g.save();
    g.font = '11px Inter, sans-serif';
    g.textBaseline = 'top';
    for (const t of img.tiles ?? []) {
      const [c, r] = tileCell(t.number);
      const p0 = this.toPx(c, r + 1),
        p1 = this.toPx(c + 1, r);
      g.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      g.strokeRect(Math.round(p0.x) + 0.5, Math.round(p0.y) + 0.5, Math.round(p1.x - p0.x), Math.round(p1.y - p0.y));
      g.fillStyle = 'rgba(255, 255, 255, 0.75)';
      g.fillText(t.label ? `${t.number} ${t.label}` : String(t.number), p0.x + 5, p0.y + 5);
    }
    g.restore();
  }

  /** Spacing of the shown grid (UV units): lines 24–96 px apart. */
  gridStep() {
    const s = this.scale();
    let n = 8;
    while (s / n > 96 && n < 4096) n *= 2;
    while (s / n < 24 && n > 1) n /= 2;
    return 1 / n;
  }

  private drawGrid(g: CanvasRenderingContext2D, hasImage: boolean) {
    const n = Math.round(1 / this.gridStep());
    g.lineWidth = 1;
    g.strokeStyle = hasImage ? 'rgba(0, 0, 0,0.25)' : 'rgba(0, 0, 0,0.3)';
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
    g.strokeStyle = 'rgba(255, 255, 255,0.3)';
    g.strokeRect(t0.x, t0.y, t1.x - t0.x, t1.y - t0.y);
    // more UDIM tiles: their outlines and numbers
    const [cols, rows] = this.tileGrid;
    if (cols * rows > 1 && !isTiled(this.image())) {
      g.save();
      g.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      g.fillStyle = 'rgba(255, 255, 255, 0.45)';
      g.font = '11px Inter, sans-serif';
      g.textBaseline = 'top';
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const a = this.toPx(c, r + 1),
            b = this.toPx(c + 1, r);
          if (c || r) g.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
          g.fillText(String(1001 + c + 10 * r), a.x + 5, a.y + 5);
        }
      g.restore();
    }
  }

  private drawOverlays(g: CanvasRenderingContext2D) {
    // 2D cursor
    const cur = this.toPx(uvCursor.u, uvCursor.v);
    if (!this.showOverlays) cur.x = cur.y = -100;
    g.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) {
      g.strokeStyle = i % 2 ? '#ffffff' : '#ea0f04';
      g.beginPath();
      g.arc(cur.x, cur.y, 8, (i * Math.PI) / 4, ((i + 1) * Math.PI) / 4);
      g.stroke();
    }
    g.strokeStyle = 'rgba(0, 0, 0,0.7)';
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
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1;
    if (shape?.kind === 'BOX' && shape.pts.length === 2) {
      const [a, b] = shape.pts;
      g.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (shape?.kind === 'LASSO' && shape.pts.length > 1) {
      g.beginPath();
      shape.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.fillStyle = 'rgba(255, 255, 255,0.06)';
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
      g.strokeStyle = 'rgba(255, 255, 255,0.8)';
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
    if (annotateKeyHeld() && (e.button === 0 || e.button === 2)) {
      annotatePointerDown(this, e, e.button === 2 ? 'ERASER' : e.altKey ? (e.shiftKey ? 'DRAW_POLY' : 'DRAW_STRAIGHT') : 'DRAW');
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
    if (isAnnotateTool(this.tool)) return void annotatePointerDown(this, e, annotateModeOf(this.tool));
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
    if (this.tool === 'transform') {
      const part = this.transformPart(this.local(e));
      if (!part) return false;
      const props: Record<string, unknown> = { release_confirm: true };
      if (part === 'SIDE_X' || part === 'SIDE_Y') props.constraint_axis = [part === 'SIDE_X', part === 'SIDE_Y'];
      const op = part === 'MOVE' ? 'uv.translate' : part === 'ROTATE' ? 'uv.rotate' : 'uv.resize';
      return app.run(op, props, { area, event }) === 'RUNNING_MODAL';
    }
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

  /** Screen rectangle around the selected UVs (Transform tool frame), or null. */
  selectionFrame(): { x0: number; y0: number; x1: number; y1: number } | null {
    let a = Infinity,
      b = Infinity,
      c = -Infinity,
      d = -Infinity;
    for (const layer of uvLayers()) {
      const bb = selBounds(new UVTopo(layer), layer.me.uvs as Float32Array, selReader(layer));
      if (!bb) continue;
      a = Math.min(a, bb[0]);
      b = Math.min(b, bb[1]);
      c = Math.max(c, bb[2]);
      d = Math.max(d, bb[3]);
    }
    if (a > c) return null;
    const p0 = this.toPx(a, d),
      p1 = this.toPx(c, b);
    // keep a usable frame around a single vertex or a straight line of UVs
    const pad = 10;
    return { x0: Math.min(p0.x, p1.x) - pad, y0: Math.min(p0.y, p1.y) - pad, x1: Math.max(p0.x, p1.x) + pad, y1: Math.max(p0.y, p1.y) + pad };
  }

  /** Which part of the Transform tool frame a point is on. */
  transformPart(q: { x: number; y: number }): 'MOVE' | 'ROTATE' | 'SCALE' | 'SIDE_X' | 'SIDE_Y' | null {
    const f = this.selectionFrame();
    if (!f) return null;
    const near = (x: number, y: number) => Math.abs(q.x - x) <= 7 && Math.abs(q.y - y) <= 7;
    if (near(f.x0, f.y0) || near(f.x1, f.y0) || near(f.x0, f.y1) || near(f.x1, f.y1)) return 'SCALE';
    const mx = (f.x0 + f.x1) / 2,
      my = (f.y0 + f.y1) / 2;
    if (near(f.x0, my) || near(f.x1, my)) return 'SIDE_X';
    if (near(mx, f.y0) || near(mx, f.y1)) return 'SIDE_Y';
    if (q.x >= f.x0 && q.x <= f.x1 && q.y >= f.y0 && q.y <= f.y1) return 'MOVE';
    return 'ROTATE';
  }

  /** Transform tool: the frame around the selection with its handles. */
  private drawTransformFrame(g: CanvasRenderingContext2D) {
    if (this.tool !== 'transform' || app.doc.mode !== 'EDIT' || app.modal) return;
    const f = this.selectionFrame();
    if (!f) return;
    g.save();
    g.setLineDash([5, 4]);
    g.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    g.lineWidth = 1;
    g.strokeRect(Math.round(f.x0) + 0.5, Math.round(f.y0) + 0.5, Math.round(f.x1 - f.x0), Math.round(f.y1 - f.y0));
    g.setLineDash([]);
    const mx = (f.x0 + f.x1) / 2,
      my = (f.y0 + f.y1) / 2;
    const handle = (x: number, y: number, color: string) => {
      g.fillStyle = color;
      g.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      g.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8);
      g.strokeRect(Math.round(x) - 4.5, Math.round(y) - 4.5, 9, 9);
    };
    for (const [x, y] of [[f.x0, f.y0], [f.x1, f.y0], [f.x0, f.y1], [f.x1, f.y1]]) handle(x, y, '#ffffff');
    handle(f.x0, my, '#ff5a5a');
    handle(f.x1, my, '#ff5a5a');
    handle(mx, f.y0, '#8ce36b');
    handle(mx, f.y1, '#8ce36b');
    g.restore();
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
    else if (event.ctrl) app.run('uv.shortest_path_pick', { location: loc, use_fill: event.shift }, { invoke: false, area });
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
    if (e.code === 'KeyZ' && !ctrl && e.altKey && e.shiftKey) return this.toggleOverlays(), true;
    if (e.code === 'Backquote' && ctrl && !e.altKey && !e.shiftKey) return ((this.showGizmo = !this.showGizmo), this.drawUI()), true;
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
    return { modified: this.showModifiedEdges, tiles: this.tileGrid, pixelRound: this.pixelRoundMode, lockBounds: this.lockBounds, zoom: this.zoom, pan: this.pan, image: this.imageId, pivot: this.pivot, tool: this.tool, toolbar: this.showToolbar, sidebar: this.showSidebar, tab: this.sidebarTab, stretch: this.showStretch, stretchType: this.stretchType, opacity: this.uvOpacity, faces: this.showFaces, overlays: this.showOverlays, edges: this.edgeDisplay, stretchOpacity: this.stretchOpacity, grid: this.showGrid };
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
