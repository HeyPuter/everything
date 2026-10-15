// Screen layout: a binary split tree of areas, each hosting an editor.
import { h, patch, type Child } from './h';
import { icon } from './icons';
import { openMenu, type MenuItem } from './menu';
import { app, type ChangeKind, type AreaLike } from '../app/app';

export type EditorTypeId =
  | 'VIEW_3D'
  | 'IMAGE_EDITOR'
  | 'UV'
  | 'SHADER'
  | 'GEOMETRY'
  | 'COMPOSITOR'
  | 'TEXTURE_NODES'
  | 'SEQUENCE'
  | 'SEQUENCE_EDITOR'
  | 'CLIP'
  | 'CLIP_EDITOR'
  | 'DOPESHEET'
  | 'TIMELINE'
  | 'GRAPH'
  | 'DRIVERS'
  | 'NLA'
  | 'TEXT'
  | 'CONSOLE'
  | 'INFO'
  | 'OUTLINER'
  | 'PROPERTIES'
  | 'FILE_BROWSER'
  | 'ASSETS'
  | 'SPREADSHEET'
  | 'PREFERENCES';

export interface Editor {
  el: HTMLElement;
  /** header contents (after the editor-type selector) */
  header(): Child;
  update(kinds: Set<ChangeKind>): void;
  resize?(): void;
  dispose(): void;
  keymaps: string[];
  onKey?(e: KeyboardEvent): boolean;
  serialize?(): unknown;
  /** whether the header overlaps the main region (transparent header) */
  overlapHeader?: boolean;
  /** draw the header at the bottom */
  headerBottom?: boolean;
  /** extra tool header row (e.g. 3D view tool settings) */
  toolHeader?(): Child;
  showToolHeader?: boolean;
}

export interface EditorType {
  id: EditorTypeId;
  label: string;
  icon: string;
  group: 'General' | 'Animation' | 'Scripting' | 'Data';
  create(area: Area, state?: unknown): Editor;
  /** available in this build (unimplemented editors are hidden) */
  available?: boolean;
}

export const editorTypes = new Map<EditorTypeId, EditorType>();
export function registerEditor(t: EditorType) {
  editorTypes.set(t.id, t);
}

export interface AreaState {
  id: string;
  type: EditorTypeId;
  state?: unknown;
}

export type LayoutNode = { split: 'h' | 'v'; ratio: number; a: LayoutNode; b: LayoutNode } | { area: AreaState };

/**
 * Re-proportion a layout for a new screen width so that, in every side-by-side
 * split, the narrower side keeps its width in pixels and the wider side (the
 * main editor) takes the difference. Used when the docked assistant takes or
 * gives back room, so side editors such as the Properties keep their size.
 */
export function fitLayoutWidth(n: LayoutNode, oldW: number, newW: number, gap = 2) {
  if ('area' in n || Math.abs(oldW - newW) < 1 || oldW <= gap || newW <= gap) return;
  if (n.split === 'v') {
    fitLayoutWidth(n.a, oldW, newW, gap);
    fitLayoutWidth(n.b, oldW, newW, gap);
    return;
  }
  const aOld = (oldW - gap) * n.ratio;
  const bOld = oldW - gap - aOld;
  const keepB = aOld >= bOld;
  const kept = keepB ? bOld : aOld;
  const grown = newW - gap - kept;
  // When the main side would get too small, fall back to scaling both sides.
  if (grown < (newW - gap) * 0.35) return;
  n.ratio = keepB ? grown / (newW - gap) : kept / (newW - gap);
  if (keepB) fitLayoutWidth(n.a, aOld, grown, gap);
  else fitLayoutWidth(n.b, bOld, grown, gap);
}

export class Area implements AreaLike {
  id: string;
  type: EditorTypeId;
  el: HTMLElement;
  headerEl: HTMLElement;
  toolHeaderEl: HTMLElement;
  mainEl: HTMLElement;
  editor: Editor;
  rect = { x: 0, y: 0, w: 0, h: 0 };
  constructor(
    public screen: Screen,
    st: AreaState,
  ) {
    this.id = st.id;
    this.type = st.type;
    this.el = document.createElement('div');
    this.el.className = 'area';
    this.el.dataset.area = st.id;
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'area-header';
    this.toolHeaderEl = document.createElement('div');
    this.toolHeaderEl.className = 'area-toolheader';
    this.mainEl = document.createElement('div');
    this.mainEl.className = 'area-main';
    this.el.append(this.headerEl, this.toolHeaderEl, this.mainEl);
    this.el.addEventListener('pointerenter', () => (app.hoverArea = this));
    this.el.addEventListener('pointerdown', () => {
      app.activeArea = this;
      app.hoverArea = this;
    }, true);
    this.headerEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(this.areaMenu(), { x: e.clientX, y: e.clientY });
    });
    this.editor = this.makeEditor(st.state);
  }

  private makeEditor(state?: unknown): Editor {
    const t = editorTypes.get(this.type) ?? editorTypes.get('VIEW_3D')!;
    this.mainEl.textContent = '';
    const ed = t.create(this, state);
    this.mainEl.append(ed.el);
    this.el.dataset.editor = this.type;
    this.el.classList.toggle('overlap-header', !!ed.overlapHeader);
    this.el.classList.toggle('header-bottom', !!ed.headerBottom);
    return ed;
  }

  setType(type: EditorTypeId) {
    if (type === this.type) return;
    this.editor.dispose();
    this.type = type;
    this.editor = this.makeEditor();
    this.drawHeader();
    this.editor.update(new Set(['doc', 'ui']));
    this.editor.resize?.();
  }

  areaMenu(): MenuItem[] {
    return [
      { label: 'Vertical Split', action: () => this.screen.split(this, 'h') },
      { label: 'Horizontal Split', action: () => this.screen.split(this, 'v') },
      { separator: true },
      { label: this.screen.maximized === this ? 'Back to Previous' : 'Maximize Area', shortcut: 'Ctrl Space', action: () => this.screen.toggleMaximize(this) },
      { label: 'Toggle Fullscreen Area', shortcut: 'Ctrl Alt Space', action: () => this.screen.toggleMaximize(this, true) },
      { separator: true },
      { label: 'Swap Areas', disabled: !this.screen.siblingOf(this), action: () => this.screen.swap(this) },
      {
        label: 'Join Areas',
        description: 'Join this area with its neighbour (the neighbour is removed)',
        disabled: !this.screen.siblingOf(this),
        action: () => {
          const sib = this.screen.siblingOf(this);
          const other = sib && this.screen.areas.find((x) => x.id === sib.id);
          if (other) this.screen.close(other);
        },
      },
      { label: 'Close Area', disabled: this.screen.areas.length <= 1, action: () => this.screen.close(this) },
    ];
  }

  drawHeader() {
    const t = editorTypes.get(this.type);
    const typeButton = h(
      'button',
      {
        class: 'editor-type',
        'data-tip': `Editor Type\nCurrent editor type for this area`,
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(editorTypeMenu((id) => this.setType(id), this.type), e.currentTarget as HTMLElement);
        },
      },
      icon(t?.icon ?? 'view3d'),
      icon('down_arrow_hlt', 'tiny'),
    );
    patch(this.headerEl, [typeButton, this.editor.header()]);
    if (this.editor.toolHeader && this.editor.showToolHeader !== false) {
      this.toolHeaderEl.hidden = false;
      patch(this.toolHeaderEl, this.editor.toolHeader());
    } else this.toolHeaderEl.hidden = true;
  }

  serialize(): AreaState {
    return { id: this.id, type: this.type, state: this.editor.serialize?.() };
  }
}

function editorTypeMenu(set: (id: EditorTypeId) => void, current: EditorTypeId): MenuItem[] {
  const groups: Record<string, EditorType[]> = {};
  for (const t of editorTypes.values()) if (t.available !== false) (groups[t.group] ??= []).push(t);
  const out: MenuItem[] = [];
  for (const g of ['General', 'Animation', 'Scripting', 'Data']) {
    if (!groups[g]) continue;
    if (out.length) out.push({ separator: true });
    out.push({ heading: g });
    for (const t of groups[g]) out.push({ label: t.label, icon: t.icon, active: t.id === current, action: () => set(t.id) });
  }
  return out;
}

let areaCounter = 0;
export const newAreaId = () => `area${++areaCounter}_${Math.random().toString(36).slice(2, 6)}`;

export class Screen {
  el: HTMLElement;
  areas: Area[] = [];
  layout!: LayoutNode;
  maximized: Area | null = null;
  /** Width the docked assistant takes from the screen; layouts are fitted to it as they load. */
  dock = 0;
  private saved: LayoutNode | null = null;
  private dividers: HTMLElement[] = [];
  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'screen';
    container.append(this.el);
    new ResizeObserver(() => this.relayout()).observe(this.el);
  }

  load(layout: LayoutNode) {
    for (const a of this.areas) {
      a.editor.dispose();
      a.el.remove();
    }
    this.areas = [];
    this.maximized = null;
    this.saved = null;
    // A layout made for another dock width (or none) gives or takes the difference from its main editors.
    const madeFor = (layout as { dock?: number }).dock ?? 0;
    if (madeFor !== this.dock) fitLayoutWidth(layout, this.el.clientWidth + this.dock - madeFor, this.el.clientWidth);
    this.layout = layout;
    this.walk(layout, (st) => this.areas.push(new Area(this, st)));
    for (const a of this.areas) this.el.append(a.el);
    this.relayout();
    for (const a of this.areas) a.drawHeader();
  }

  private walk(n: LayoutNode, fn: (a: AreaState) => void) {
    if ('area' in n) fn(n.area);
    else {
      this.walk(n.a, fn);
      this.walk(n.b, fn);
    }
  }

  serialize(): LayoutNode {
    if (!this.layout) return { area: { id: newAreaId(), type: 'VIEW_3D' } };
    const ser = (n: LayoutNode): LayoutNode => {
      if ('area' in n) {
        const a = this.areas.find((x) => x.id === n.area.id);
        return { area: a ? a.serialize() : n.area };
      }
      return { split: n.split, ratio: n.ratio, a: ser(n.a), b: ser(n.b) };
    };
    const out = ser(this.saved ?? this.layout);
    if (this.dock) (out as { dock?: number }).dock = this.dock;
    return out;
  }

  /** The docked assistant now takes `dock` pixels; the screen went from `oldW` to its current width. */
  setDock(dock: number, oldW: number) {
    const newW = this.el.clientWidth;
    for (const n of [this.layout, this.saved]) if (n) fitLayoutWidth(n, oldW, newW);
    this.dock = dock;
    this.relayout();
  }

  relayout() {
    if (!this.layout) return;
    const W = this.el.clientWidth,
      H = this.el.clientHeight;
    this.dividers.forEach((d) => d.remove());
    this.dividers = [];
    const GAP = 2;
    const place = (n: LayoutNode, x: number, y: number, w: number, hgt: number) => {
      if ('area' in n) {
        const a = this.areas.find((ar) => ar.id === n.area.id);
        if (!a) return;
        a.rect = { x, y, w, h: hgt };
        Object.assign(a.el.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, hgt)}px`, display: '' });
        return;
      }
      if (n.split === 'h') {
        const wa = Math.round((w - GAP) * n.ratio);
        place(n.a, x, y, wa, hgt);
        place(n.b, x + wa + GAP, y, w - wa - GAP, hgt);
        this.addDivider(n, 'h', x + wa, y, GAP, hgt, x, w);
      } else {
        const ha = Math.round((hgt - GAP) * n.ratio);
        place(n.a, x, y, w, ha);
        place(n.b, x, y + ha + GAP, w, hgt - ha - GAP);
        this.addDivider(n, 'v', x, y + ha, w, GAP, y, hgt);
      }
    };
    const root = this.maximized ? { area: { id: this.maximized.id, type: this.maximized.type } } : this.layout;
    for (const a of this.areas) a.el.style.display = this.maximized && a !== this.maximized ? 'none' : '';
    place(root, 0, 0, W, H);
    for (const a of this.areas) a.editor.resize?.();
  }

  private addDivider(n: Extract<LayoutNode, { split: string }>, dir: 'h' | 'v', x: number, y: number, w: number, hgt: number, start: number, size: number) {
    const d = document.createElement('div');
    d.className = `divider ${dir}`;
    Object.assign(d.style, { left: `${x - (dir === 'h' ? 2 : 0)}px`, top: `${y - (dir === 'v' ? 2 : 0)}px`, width: `${dir === 'h' ? w + 4 : w}px`, height: `${dir === 'v' ? hgt + 4 : hgt}px` });
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const pos = dir === 'h' ? ev.clientX - this.el.getBoundingClientRect().left : ev.clientY - this.el.getBoundingClientRect().top;
        n.ratio = Math.max(0.03, Math.min(0.97, (pos - start) / size));
        this.relayout();
      };
      const up = () => {
        d.removeEventListener('pointermove', move);
        d.removeEventListener('pointerup', up);
      };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', up);
    });
    d.addEventListener('dblclick', () => {
      n.ratio = 0.5;
      this.relayout();
    });
    this.el.append(d);
    this.dividers.push(d);
  }

  private findParent(id: string, n: LayoutNode = this.layout, parent: Extract<LayoutNode, { split: string }> | null = null): { node: LayoutNode; parent: Extract<LayoutNode, { split: string }> | null } | null {
    if ('area' in n) return n.area.id === id ? { node: n, parent } : null;
    return this.findParent(id, n.a, n) ?? this.findParent(id, n.b, n);
  }

  siblingOf(a: Area) {
    const f = this.findParent(a.id);
    if (!f?.parent) return null;
    const other = f.parent.a === f.node ? f.parent.b : f.parent.a;
    return 'area' in other ? other.area : null;
  }

  split(a: Area, dir: 'h' | 'v') {
    if (this.maximized) this.toggleMaximize(this.maximized);
    const f = this.findParent(a.id);
    if (!f) return;
    const st: AreaState = { id: newAreaId(), type: a.type };
    const nn: LayoutNode = { split: dir, ratio: 0.5, a: { area: a.serialize() }, b: { area: st } };
    if (!f.parent) this.layout = nn;
    else if (f.parent.a === f.node) f.parent.a = nn;
    else f.parent.b = nn;
    const area = new Area(this, st);
    this.areas.push(area);
    this.el.append(area.el);
    this.relayout();
    area.drawHeader();
    area.editor.update(new Set(['doc', 'ui']));
  }

  close(a: Area) {
    const f = this.findParent(a.id);
    if (!f?.parent || this.areas.length <= 1) return;
    const other = f.parent.a === f.node ? f.parent.b : f.parent.a;
    const gp = this.findParentOfSplit(f.parent);
    if (!gp) this.layout = other;
    else if (gp.a === f.parent) gp.a = other;
    else gp.b = other;
    a.editor.dispose();
    a.el.remove();
    this.areas = this.areas.filter((x) => x !== a);
    this.relayout();
  }

  private findParentOfSplit(target: LayoutNode, n: LayoutNode = this.layout): Extract<LayoutNode, { split: string }> | null {
    if ('area' in n) return null;
    if (n.a === target || n.b === target) return n;
    return this.findParentOfSplit(target, n.a) ?? this.findParentOfSplit(target, n.b);
  }

  swap(a: Area) {
    const f = this.findParent(a.id);
    if (!f?.parent) return;
    const p = f.parent;
    [p.a, p.b] = [p.b, p.a];
    this.relayout();
  }

  toggleMaximize(a: Area, fullscreen = false) {
    if (this.maximized) {
      this.maximized = null;
      this.el.classList.remove('fullscreen');
    } else {
      this.maximized = a;
      this.el.classList.toggle('fullscreen', fullscreen);
    }
    this.relayout();
    a.drawHeader();
  }

  update(kinds: Set<ChangeKind>) {
    for (const a of this.areas) {
      if (this.maximized && a !== this.maximized) continue;
      a.editor.update(kinds);
      a.drawHeader();
    }
  }

  areaAt(x: number, y: number): Area | null {
    const r = this.el.getBoundingClientRect();
    for (const a of this.areas) {
      if (a.el.style.display === 'none') continue;
      const ax = r.left + a.rect.x,
        ay = r.top + a.rect.y;
      if (x >= ax && x < ax + a.rect.w && y >= ay && y < ay + a.rect.h) return a;
    }
    return null;
  }

  findArea(type: EditorTypeId) {
    return this.areas.find((a) => a.type === type);
  }
}

// ---------------------------------------------------------------------------
// Workspaces

export interface Workspace {
  name: string;
  layout: LayoutNode;
  mode?: 'OBJECT' | 'EDIT' | 'SCULPT' | 'TEXTURE_PAINT' | 'POSE' | 'WEIGHT_PAINT' | 'VERTEX_PAINT' | 'PAINT_GREASE_PENCIL';
}

export const A = (type: EditorTypeId, state?: unknown): LayoutNode => ({ area: { id: newAreaId(), type, state } });
export const H = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ split: 'h', ratio, a, b });
export const V = (ratio: number, a: LayoutNode, b: LayoutNode): LayoutNode => ({ split: 'v', ratio, a, b });

/** Right-hand dock: outliner above properties (default proportions). */
export const dock = (tab?: string) => V(0.18, A('OUTLINER'), A('PROPERTIES', tab ? { tab } : undefined));

/**
 * Workspace templates offered by the "+" button next to the workspace tabs (grouped in the
 * Add Workspace menu: General, 2D Animation, Sculpting, VFX, Video Editing).
 * Modules register extra templates with registerWorkspaceTemplate().
 */
export const workspaceTemplates: { category: string; create: () => Workspace }[] = [];
export function registerWorkspaceTemplate(category: string, create: () => Workspace) {
  workspaceTemplates.push({ category, create });
}

export function defaultWorkspaces(): Workspace[] {
  // each workspace opens the Properties editor on the tab its task needs most
  const sculptView = { shading: 'SOLID', matcap: true, nav: { distance: 7 }, overlay: { show_floor: false, show_axis_x: false, show_axis_y: false, show_stats: true } };
  return [
    { name: 'Layout', layout: H(0.822, V(0.925, A('VIEW_3D'), A('TIMELINE')), dock()) },
    { name: 'Modeling', layout: H(0.822, A('VIEW_3D'), dock('MODIFIER')), mode: 'EDIT' },
    { name: 'Sculpting', layout: H(0.822, A('VIEW_3D', sculptView), dock('TOOL')), mode: 'SCULPT' },
    { name: 'UV Editing', layout: H(0.822, H(0.5, A('UV'), A('VIEW_3D')), dock('DATA')), mode: 'EDIT' },
    { name: 'Texture Paint', layout: H(0.822, H(0.5, A('IMAGE_EDITOR'), A('VIEW_3D', { shading: 'MATERIAL' })), dock('TOOL')), mode: 'TEXTURE_PAINT' },
    { name: 'Shading', layout: H(0.822, H(0.16, V(0.5, A('FILE_BROWSER'), A('IMAGE_EDITOR')), V(0.5, A('VIEW_3D', { shading: 'MATERIAL' }), A('SHADER'))), dock('WORLD')) },
    { name: 'Animation', layout: H(0.822, V(0.58, H(0.35, A('VIEW_3D', { camera: true }), A('VIEW_3D')), A('DOPESHEET')), V(0.18, A('OUTLINER'), A('PROPERTIES'))) },
    { name: 'Rendering', layout: H(0.822, V(0.925, A('IMAGE_EDITOR', { render: true, sidebar: true }), A('TIMELINE')), A('PROPERTIES', { tab: 'RENDER' })) },
    { name: 'Compositing', layout: H(0.822, V(0.92, V(0.48, A('IMAGE_EDITOR', { render: true }), A('COMPOSITOR')), A('TIMELINE')), A('PROPERTIES', { tab: 'OUTPUT' })) },
    { name: 'Geometry Nodes', layout: H(0.822, V(0.92, V(0.48, H(0.42, A('SPREADSHEET'), A('VIEW_3D')), A('GEOMETRY')), A('TIMELINE')), dock('MODIFIER')) },
    { name: 'Scripting', layout: H(0.822, H(0.36, V(0.38, A('VIEW_3D'), V(0.7, A('CONSOLE'), A('INFO'))), A('TEXT')), V(0.18, A('OUTLINER'), V(0.3, A('OUTLINER', { displayMode: 'BLENDER_FILE' }), A('PROPERTIES', { tab: 'RENDER' })))) },
  ];
}

for (const ws of defaultWorkspaces()) registerWorkspaceTemplate('General', () => defaultWorkspaces().find((w) => w.name === ws.name)!);
