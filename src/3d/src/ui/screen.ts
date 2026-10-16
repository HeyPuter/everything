// Screen layout: a binary split tree of areas, each hosting an editor.
import { h, patch, type Child } from './h';
import './screen.css';
import { icon } from './icons';
import { openMenu, captureMenuItems, type MenuItem } from './menu';
import { app, type ChangeKind, type AreaLike } from '../app/app';
import { prefs } from '../app/prefs';
import { GAP, areaRects, leaves, splitLayout, swapLayout, joinLayout, neighbourOn, removeFromLayout, type Side } from './layout';

export { areaRects, type Side };

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
  /** header region settings (absent: editor defaults) */
  ui?: AreaUi;
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

/** Per-area region settings (header visibility, header side, collapsed menus). */
export interface AreaUi {
  header?: boolean;
  flip?: boolean;
  menus?: boolean;
}

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;

export class Area implements AreaLike {
  id: string;
  type: EditorTypeId;
  el: HTMLElement;
  headerEl: HTMLElement;
  toolHeaderEl: HTMLElement;
  mainEl: HTMLElement;
  editor: Editor;
  rect = { x: 0, y: 0, w: 0, h: 0 };
  /** header region shown */
  showHeader = true;
  /** header drawn at the bottom; undefined follows the editor's default */
  flipHeader?: boolean;
  /** header menus shown expanded (false: collapsed into one menu button) */
  showMenus = true;
  /** how far the header is compacted to fit a narrow area (see fitHeader) */
  headerFit = 0;
  /** area width and header contents the compaction was chosen for */
  private fitKey = '';
  private revealEl: HTMLElement;
  constructor(
    public screen: Screen,
    st: AreaState,
  ) {
    this.id = st.id;
    this.type = st.type;
    if (st.ui) {
      this.showHeader = st.ui.header !== false;
      this.flipHeader = st.ui.flip;
      this.showMenus = st.ui.menus !== false;
    }
    this.el = document.createElement('div');
    this.el.className = 'area';
    this.el.dataset.area = st.id;
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'area-header';
    this.toolHeaderEl = document.createElement('div');
    this.toolHeaderEl.className = 'area-toolheader';
    this.mainEl = document.createElement('div');
    this.mainEl.className = 'area-main';
    this.revealEl = document.createElement('button');
    this.revealEl.className = 'area-header-reveal';
    this.revealEl.dataset.tip = 'Show Header\nBring back the hidden header of this area';
    this.revealEl.setAttribute('aria-label', 'Show Header');
    this.revealEl.addEventListener('click', () => this.setHeaderVisible(true));
    this.el.append(this.headerEl, this.toolHeaderEl, this.mainEl, this.revealEl);
    // corner action zones: drag inwards to split, into a neighbour to join, Ctrl-drag to swap
    for (const c of CORNERS) {
      const z = document.createElement('div');
      z.className = `area-corner ${c}`;
      z.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.screen.cornerGesture(this, e);
      });
      this.el.append(z);
    }
    this.el.addEventListener('pointerenter', () => (app.hoverArea = this));
    this.el.addEventListener('pointerdown', () => {
      app.activeArea = this;
      app.hoverArea = this;
    }, true);
    this.headerEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      e.preventDefault();
      openMenu(this.headerMenu(), { x: e.clientX, y: e.clientY });
    });
    // a header wider than the area scrolls sideways with the wheel
    for (const el of [this.headerEl, this.toolHeaderEl])
      el.addEventListener(
        'wheel',
        (e) => {
          if ((e.target as HTMLElement).closest('input, textarea, .num-field')) return;
          const box = [el, ...el.querySelectorAll<HTMLElement>(':scope > *')].find((x) => x.scrollWidth > x.clientWidth + 1);
          if (!box) return;
          e.preventDefault();
          box.scrollLeft += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        },
        { passive: false },
      );
    // middle-drag pans a header that does not fit its area
    for (const el of [this.headerEl, this.toolHeaderEl])
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 1) return;
        const box = [el, ...el.querySelectorAll<HTMLElement>(':scope > *')].find((x) => x.scrollWidth > x.clientWidth + 1);
        if (!box) return;
        e.preventDefault();
        e.stopPropagation();
        const x0 = e.clientX,
          s0 = box.scrollLeft;
        const move = (ev: PointerEvent) => (box.scrollLeft = s0 - (ev.clientX - x0));
        const up = () => (removeEventListener('pointermove', move, true), removeEventListener('pointerup', up, true));
        addEventListener('pointermove', move, true);
        addEventListener('pointerup', up, true);
      });
    for (const el of [this.headerEl, this.toolHeaderEl]) el.addEventListener('scroll', () => markHeaderScroll(el), { capture: true, passive: true });
    this.toolHeaderEl.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      e.preventDefault();
      openMenu(this.headerMenu(), { x: e.clientX, y: e.clientY });
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
    this.editor = ed;
    this.applyUi();
    return ed;
  }

  /** Header at the bottom of the area (flipped, or the editor's default). */
  get headerAtBottom() {
    // Preferences ▸ Interface ▸ Header Position can override the editors' own defaults
    return this.flipHeader ?? (prefs.header_align === 'NONE' ? !!this.editor?.headerBottom : prefs.header_align === 'BOTTOM');
  }

  applyUi() {
    this.el.classList.toggle('no-header', !this.showHeader);
    this.el.classList.toggle('header-bottom', this.headerAtBottom);
    this.el.classList.toggle('menus-collapsed', !this.showMenus);
    patch(this.revealEl, icon(this.headerAtBottom ? 'triangle_up' : 'triangle_down', 'tiny'));
  }

  private regionsChanged() {
    this.applyUi();
    this.drawHeader();
    this.editor.resize?.();
    app.changed('ui', 'view');
  }

  setHeaderVisible(v: boolean) {
    this.showHeader = v;
    this.regionsChanged();
  }

  flipHeaderSide() {
    this.flipHeader = !this.headerAtBottom;
    this.regionsChanged();
  }

  setMenusShown(v: boolean) {
    this.showMenus = v;
    this.regionsChanged();
  }

  toggleToolHeader() {
    if (!this.editor.toolHeader) return;
    this.editor.showToolHeader = this.editor.showToolHeader === false;
    this.regionsChanged();
  }

  setType(type: EditorTypeId) {
    if (type === this.type) return;
    this.editor.dispose();
    this.type = type;
    this.editor = this.makeEditor();
    this.drawHeader();
    this.editor.update(new Set(['doc', 'ui']));
    this.editor.resize?.();
    app.changed('ui');
  }

  /** View ▸ Area menu: split, maximize, fullscreen, swap, join, close. */
  areaMenu(): MenuItem[] {
    const sc = this.screen;
    const max = sc.maximized === this;
    const run = (op: string, props: Record<string, unknown> = {}) => () => app.run(op, props, { area: this });
    const multi = sc.areas.length > 1 && !sc.maximized;
    return [
      { label: 'Horizontal Split', op: 'screen.area_split', props: { direction: 'HORIZONTAL' }, action: run('screen.area_split', { direction: 'HORIZONTAL' }) },
      { label: 'Vertical Split', op: 'screen.area_split', props: { direction: 'VERTICAL' }, action: run('screen.area_split', { direction: 'VERTICAL' }) },
      { separator: true },
      { label: max && !sc.fullscreen ? 'Back to Previous' : 'Toggle Maximize Area', shortcut: 'Ctrl Space', op: 'screen.screen_full_area', disabled: sc.fullscreen, action: run('screen.screen_full_area') },
      { label: max && sc.fullscreen ? 'Back to Previous' : 'Toggle Fullscreen Area', shortcut: 'Ctrl Alt Space', op: 'screen.screen_full_area', props: { use_hide_panels: true }, disabled: max && !sc.fullscreen, action: run('screen.screen_full_area', { use_hide_panels: true }) },
      { separator: true },
      { label: 'Swap Areas…', op: 'screen.area_swap', disabled: !multi, action: run('screen.area_swap') },
      { label: 'Join Areas…', op: 'screen.area_join', disabled: !multi, action: run('screen.area_join') },
      ...(MAIN_WINDOW_ONLY.has(this.type) ? [] : [{ separator: true }, { label: 'Duplicate Area into New Window', op: 'screen.area_dupli', action: run('screen.area_dupli') } as MenuItem]),
      { separator: true },
      { label: 'Close Area', op: 'screen.area_close', disabled: !multi, action: run('screen.area_close') },
    ];
  }

  /** Right-click menu of the header region. */
  headerMenu(): MenuItem[] {
    const items: MenuItem[] = [{ label: 'Show Header', checked: this.showHeader, action: () => this.setHeaderVisible(!this.showHeader) }];
    if (this.editor.toolHeader) items.push({ label: 'Show Tool Settings', checked: this.editor.showToolHeader !== false, action: () => this.toggleToolHeader() });
    items.push(
      { label: 'Show Menus', checked: this.showMenus, disabled: !this.hasMenus(), action: () => this.setMenusShown(!this.showMenus) },
      { separator: true },
      { label: this.headerAtBottom ? 'Flip to Top' : 'Flip to Bottom', action: () => this.flipHeaderSide() },
      { separator: true },
      ...this.areaMenu(),
    );
    return items;
  }

  private hasMenus() {
    return !!this.headerEl.querySelector('.hdr-menu') || !this.showMenus;
  }

  /** Whether a header button opens a menu (popover buttons such as Playback do not), cached per element. */
  private isMenuButton(b: HTMLElement) {
    let v = menuButtons.get(b);
    if (v === undefined) {
      v = captureMenu(b).length > 0;
      menuButtons.set(b, v);
    }
    return v;
  }

  /** Menus of the header (for the collapsed menu button and menu search). */
  headerMenus(): { label: string; items: () => MenuItem[] }[] {
    return [...this.headerEl.querySelectorAll<HTMLElement>('.hdr-menu')].filter((b) => this.isMenuButton(b)).map((b) => ({ label: b.textContent?.trim() ?? '', items: () => captureMenu(b) }));
  }

  /** Menus folded into the single menu button (by the user, or because the area is too narrow). */
  get menusFolded() {
    return !this.showMenus || this.headerFit >= 2;
  }

  /** Hide the header's menu buttons while the menus are collapsed (popover buttons stay). */
  private applyMenuCollapse() {
    for (const b of this.headerEl.querySelectorAll<HTMLElement>('.hdr-menu')) {
      const hide = this.menusFolded && this.isMenuButton(b);
      if (hide !== (b.style.display === 'none')) b.style.display = hide ? 'none' : '';
    }
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
          openMenu(editorTypeMenu((id) => this.setType(id), this.type, this.screen.floating), e.currentTarget as HTMLElement);
        },
      },
      icon(t?.icon ?? 'view3d'),
      icon('down_arrow_hlt', 'tiny'),
    );
    const collapsed = !this.menusFolded
      ? null
      : h(
          'button',
          {
            key: 'collapsed-menus',
            class: 'hdr-icon hdr-collapsed-menus',
            'data-tip': 'Menus\nThe header menus of this area (Show Menus in the header context menu expands them)',
            'aria-label': 'Menus',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              const menus = this.headerMenus();
              openMenu(menus.length ? menus.map((m) => ({ label: m.label, submenu: m.items })) : [{ label: 'No menus', disabled: true }], e.currentTarget as HTMLElement);
            },
          },
          icon('collapsemenu'),
        );
    patch(this.headerEl, [typeButton, collapsed, this.editor.header()]);
    if (this.menusFolded || this.headerEl.querySelector('.hdr-menu[style*="none"]')) this.applyMenuCollapse();
    this.headerEl.classList.toggle('hdr-compact', this.headerFit >= 1);
    scheduleHeaderFit(this);
    if (this.editor.toolHeader && this.editor.showToolHeader !== false) {
      this.toolHeaderEl.hidden = false;
      patch(this.toolHeaderEl, this.editor.toolHeader());
    } else this.toolHeaderEl.hidden = true;
    this.el.classList.toggle('no-toolheader', this.toolHeaderEl.hidden);
  }

  /** What the header compaction depends on: the area width and the header's contents. */
  private headerFitKey() {
    const row = this.headerEl.lastElementChild;
    return `${Math.round(this.rect.w)}|${this.type}|${row?.childElementCount ?? 0}|${this.headerEl.querySelectorAll('.hdr-menu').length}`;
  }

  /** Start over from the full header when the width or contents changed (a write phase). */
  resetHeaderFit() {
    const key = this.headerFitKey();
    if (key === this.fitKey) return false;
    this.fitKey = key;
    if (this.headerFit === 0) return true;
    this.headerFit = 0;
    this.drawHeader();
    return true;
  }

  /** Whether the header's contents are wider than the area (a read phase). */
  headerOverflows() {
    if (!this.showHeader || this.el.style.display === 'none' || !this.rect.w) return false;
    const over = (x: Element) => x.scrollWidth > x.clientWidth + 1;
    return over(this.headerEl) || [...this.headerEl.children].some(over);
  }

  /**
   * A header that does not fit first drops the text of its labelled dropdowns (their icons stay),
   * then folds its menus into the single menu button; whatever still does not fit scrolls (wheel,
   * middle-drag) with a fade at the clipped edge.
   */
  compactHeader() {
    if (this.headerFit >= 2) return false;
    this.headerFit++;
    this.drawHeader();
    this.fitKey = this.headerFitKey();
    return true;
  }

  serialize(): AreaState {
    const st: AreaState = { id: this.id, type: this.type, state: this.editor.serialize?.() };
    if (!this.showHeader || this.flipHeader !== undefined || !this.showMenus) st.ui = { header: this.showHeader, flip: this.flipHeader, menus: this.showMenus };
    return st;
  }
}

// Header fitting runs once after a batch of header redraws: writes (resets) first, then the
// measurements of every area, then the compaction, so layout is computed as few times as possible.
const fitQueue = new Set<Area>();
let fitting = false;
function scheduleHeaderFit(a: Area) {
  if (fitting) return;
  if (!fitQueue.size) queueMicrotask(runHeaderFit);
  fitQueue.add(a);
}
function runHeaderFit() {
  const areas = [...fitQueue].filter((a) => a.el.isConnected);
  fitQueue.clear();
  fitting = true;
  try {
    for (const a of areas) a.resetHeaderFit();
    for (let pass = 0; pass < 2; pass++) {
      const over = areas.filter((a) => a.headerOverflows());
      if (!over.length) break;
      for (const a of over) a.compactHeader();
    }
    for (const a of areas) for (const el of [a.headerEl, a.toolHeaderEl]) markHeaderScroll(el);
  } finally {
    fitting = false;
  }
}

/** Fade the clipped edges of a scrolled header row. */
function markHeaderScroll(el: HTMLElement) {
  for (const box of [el, ...el.querySelectorAll<HTMLElement>(':scope > *')]) {
    const over = box.scrollWidth > box.clientWidth + 1;
    const l = over && box.scrollLeft > 1;
    const r = over && box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
    if (box.classList.contains('clip-l') !== l) box.classList.toggle('clip-l', l);
    if (box.classList.contains('clip-r') !== r) box.classList.toggle('clip-r', r);
  }
}

/** Editors that cannot live in area windows (none at the moment; kept for editors with special needs). */
export const MAIN_WINDOW_ONLY = new Set<EditorTypeId>();

function editorTypeMenu(set: (id: EditorTypeId) => void, current: EditorTypeId, floating = false): MenuItem[] {
  const groups: Record<string, EditorType[]> = {};
  for (const t of editorTypes.values()) if (t.available !== false && !(floating && MAIN_WINDOW_ONLY.has(t.id))) (groups[t.group] ??= []).push(t);
  // the most used editors lead their column
  const lead: EditorTypeId[] = ['VIEW_3D', 'IMAGE_EDITOR', 'UV', 'COMPOSITOR', 'GEOMETRY', 'SHADER', 'SEQUENCE_EDITOR', 'CLIP_EDITOR', 'DOPESHEET', 'TIMELINE', 'GRAPH', 'DRIVERS', 'NLA', 'TEXT', 'CONSOLE', 'INFO', 'OUTLINER', 'PROPERTIES', 'FILE_BROWSER', 'ASSETS', 'SPREADSHEET', 'PREFERENCES'] as EditorTypeId[];
  const rank = (t: EditorType) => (lead.indexOf(t.id) < 0 ? lead.length : lead.indexOf(t.id));
  const out: MenuItem[] = [];
  // one column per group, side by side
  for (const g of ['General', 'Animation', 'Scripting', 'Data']) {
    if (!groups[g]) continue;
    out.push({ heading: g, columnBreak: out.length > 0 });
    for (const t of [...groups[g]].sort((a, b) => rank(a) - rank(b))) out.push({ label: t.label, icon: t.icon, active: t.id === current, action: () => set(t.id) });
  }
  return out;
}

let areaCounter = 0;
export const newAreaId = () => `area${++areaCounter}_${Math.random().toString(36).slice(2, 6)}`;

/** A copy of an area's state for a new area (same editor and view settings). */
export function cloneAreaState(a: Area): AreaState {
  let state: unknown;
  try {
    state = structuredClone(a.editor.serialize?.());
  } catch {
    state = undefined;
  }
  return { id: newAreaId(), type: a.type, state };
}

type Gesture = 'split' | 'join' | 'swap';

export class Screen {
  el: HTMLElement;
  areas: Area[] = [];
  layout!: LayoutNode;
  maximized: Area | null = null;
  /** the maximized area also hides its header and side regions */
  fullscreen = false;
  /** Width the docked assistant takes from the screen; layouts are fitted to it as they load. */
  dock = 0;
  /** a screen inside an area window (no 3D views: they draw into the main window's canvas) */
  floating = false;
  /** set by the area window module: duplicate an area into a floating window at a point */
  static duplicateHook: ((a: Area, at: { x: number; y: number }) => void) | null = null;
  private dividers: HTMLElement[] = [];
  private exitEl: HTMLElement;
  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'screen';
    container.append(this.el);
    this.exitEl = document.createElement('button');
    this.exitEl.className = 'screen-fs-exit';
    this.exitEl.dataset.tip = 'Back to Previous\nLeave the fullscreen area (Ctrl Alt Space)';
    this.exitEl.setAttribute('aria-label', 'Back to Previous');
    patch(this.exitEl, icon('fullscreen_exit'));
    this.exitEl.addEventListener('click', () => this.maximized && this.toggleMaximize(this.maximized));
    new ResizeObserver(() => this.relayout()).observe(this.el);
  }

  load(layout: LayoutNode) {
    for (const a of this.areas) {
      a.editor.dispose();
      a.el.remove();
    }
    this.areas = [];
    this.maximized = null;
    this.fullscreen = false;
    this.el.classList.remove('fullscreen');
    // A layout made for another dock width (or none) gives or takes the difference from its main editors.
    const madeFor = (layout as { dock?: number }).dock ?? 0;
    if (madeFor !== this.dock) fitLayoutWidth(layout, this.el.clientWidth + this.dock - madeFor, this.el.clientWidth);
    this.layout = layout;
    for (const st of leaves(layout)) this.areas.push(new Area(this, st));
    for (const a of this.areas) this.el.append(a.el);
    this.relayout();
    for (const a of this.areas) a.drawHeader();
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
    const out = ser(this.layout);
    if (this.dock) (out as { dock?: number }).dock = this.dock;
    return out;
  }

  /** The docked assistant now takes `dock` pixels; the screen went from `oldW` to its current width. */
  setDock(dock: number, oldW: number) {
    const newW = this.el.clientWidth;
    if (this.layout) fitLayoutWidth(this.layout, oldW, newW);
    this.dock = dock;
    this.relayout();
  }

  /** Screen size used for layout computations. */
  get size() {
    return { w: this.el.clientWidth, h: this.el.clientHeight };
  }

  relayout() {
    if (!this.layout) return;
    const W = this.el.clientWidth,
      H = this.el.clientHeight;
    this.dividers.forEach((d) => d.remove());
    this.dividers = [];
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
    for (const a of this.areas) {
      a.el.style.display = this.maximized && a !== this.maximized ? 'none' : '';
      a.el.classList.toggle('fullscreen-area', this.fullscreen && a === this.maximized);
    }
    place(root, 0, 0, W, H);
    if (this.fullscreen && this.maximized) this.el.append(this.exitEl);
    else this.exitEl.remove();
    for (const a of this.areas) a.editor.resize?.();
  }

  private addDivider(n: Extract<LayoutNode, { split: string }>, dir: 'h' | 'v', x: number, y: number, w: number, hgt: number, start: number, size: number) {
    const d = document.createElement('div');
    d.className = `divider ${dir}`;
    Object.assign(d.style, { left: `${x - (dir === 'h' ? 2 : 0)}px`, top: `${y - (dir === 'v' ? 2 : 0)}px`, width: `${dir === 'h' ? w + 4 : w}px`, height: `${dir === 'v' ? hgt + 4 : hgt}px` });
    d.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const pos = dir === 'h' ? ev.clientX - this.el.getBoundingClientRect().left : ev.clientY - this.el.getBoundingClientRect().top;
        let r = (pos - start) / Math.max(1, size - GAP);
        // Ctrl snaps to common proportions
        if (ev.ctrlKey || ev.metaKey) r = snapRatio(r);
        // keep a header's height (or a narrow column) on both sides
        const minFrac = Math.min(0.45, 26 / Math.max(1, size - GAP));
        n.ratio = Math.max(minFrac, Math.min(1 - minFrac, r));
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
    d.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(this.areaOptions(dir, e.clientX, e.clientY), { x: e.clientX, y: e.clientY }, { title: 'Area Options' });
    });
    this.el.append(d);
    this.dividers.push(d);
  }

  /** Area Options (right-click on an edge between areas): split, join towards a side, swap. */
  areaOptions(dir: 'h' | 'v', x: number, y: number): MenuItem[] {
    const before = dir === 'h' ? this.areaAt(x - 4, y) : this.areaAt(x, y - 4);
    const after = dir === 'h' ? this.areaAt(x + 4, y) : this.areaAt(x, y + 4);
    const target = this.areaAt(x, y) ?? before ?? after;
    const items: MenuItem[] = [
      { label: 'Vertical Split', disabled: !target, action: () => target && this.interactiveSplit(target, 'h') },
      { label: 'Horizontal Split', disabled: !target, action: () => target && this.interactiveSplit(target, 'v') },
      { separator: true },
    ];
    if (before && after) {
      const [lb, la] = dir === 'h' ? ['Join Left', 'Join Right'] : ['Join Up', 'Join Down'];
      items.push(
        { label: lb, description: `The ${dir === 'h' ? 'right' : 'lower'} area grows over the ${dir === 'h' ? 'left' : 'upper'} one`, disabled: !this.canJoin(after, before), action: () => this.join(after, before) },
        { label: la, description: `The ${dir === 'h' ? 'left' : 'upper'} area grows over the ${dir === 'h' ? 'right' : 'lower'} one`, disabled: !this.canJoin(before, after), action: () => this.join(before, after) },
        { separator: true },
        { label: 'Swap Areas', action: () => this.swapAreas(before, after) },
      );
    }
    return items;
  }

  siblingOf(a: Area) {
    const find = (n: LayoutNode): AreaState | null => {
      if ('area' in n) return null;
      if ('area' in n.a && n.a.area.id === a.id) return 'area' in n.b ? n.b.area : null;
      if ('area' in n.b && n.b.area.id === a.id) return 'area' in n.a ? n.a.area : null;
      return find(n.a) ?? find(n.b);
    };
    return this.layout ? find(this.layout) : null;
  }

  private exitMaximized() {
    if (this.maximized) this.toggleMaximize(this.maximized);
  }

  /** Split area `a`: 'h' puts the halves side by side, 'v' stacks them. Returns the new area. */
  split(a: Area, dir: 'h' | 'v', ratio = 0.5): Area | null {
    this.exitMaximized();
    if (!this.areas.includes(a)) return null;
    const st = cloneAreaState(a);
    this.layout = splitLayout(this.layout, a.id, dir, ratio, st);
    const area = new Area(this, st);
    this.areas.push(area);
    this.el.append(area.el);
    this.relayout();
    area.drawHeader();
    area.editor.update(new Set(['doc', 'ui']));
    app.changed('ui', 'view');
    return area;
  }

  canJoin(keep: Area, remove: Area) {
    const { w, h } = this.size;
    return !this.maximized && !!joinLayout(this.layout, keep.id, remove.id, w, h);
  }

  /** `keep` grows over its neighbour `remove` (they must share a whole edge). */
  join(keep: Area, remove: Area): boolean {
    this.exitMaximized();
    const { w, h } = this.size;
    const next = joinLayout(this.layout, keep.id, remove.id, w, h);
    if (!next) {
      app.report('WARNING', 'Only areas that share a whole edge can be joined');
      return false;
    }
    // keep the serialized state of the remaining areas in the new tree
    this.layout = next;
    this.disposeArea(remove);
    this.relayout();
    app.changed('ui', 'view');
    return true;
  }

  /** Exchange the places (and sizes) of two areas. */
  swapAreas(a: Area, b: Area) {
    if (a === b) return;
    this.exitMaximized();
    this.layout = swapLayout(this.layout, a.id, b.id);
    this.relayout();
    for (const x of [a, b]) x.drawHeader();
    app.changed('ui', 'view');
  }

  /** Neighbour sharing the whole `side` edge of area `a`. */
  neighbour(a: Area, side: Side): Area | null {
    const { w, h } = this.size;
    const id = neighbourOn(this.layout, a.id, side, w, h);
    return id ? (this.areas.find((x) => x.id === id) ?? null) : null;
  }

  close(a: Area) {
    if (this.areas.length <= 1) return;
    this.exitMaximized();
    const next = removeFromLayout(this.layout, a.id);
    if (!next) return;
    this.layout = next;
    this.disposeArea(a);
    this.relayout();
    app.changed('ui', 'view');
  }

  private disposeArea(a: Area) {
    a.editor.dispose();
    a.el.remove();
    this.areas = this.areas.filter((x) => x !== a);
    if (app.hoverArea === a) app.hoverArea = null;
    if (app.activeArea === a) app.activeArea = this.areas[0] ?? null;
  }

  /** @deprecated use swapAreas; swaps area `a` with its sibling subtree */
  swap(a: Area) {
    const sib = this.siblingOf(a);
    const other = sib && this.areas.find((x) => x.id === sib.id);
    if (other) this.swapAreas(a, other);
  }

  toggleMaximize(a: Area, fullscreen = false) {
    if (this.maximized) {
      this.maximized = null;
      this.fullscreen = false;
    } else {
      this.maximized = a;
      this.fullscreen = fullscreen;
    }
    this.el.classList.toggle('fullscreen', this.fullscreen);
    this.relayout();
    a.drawHeader();
    app.changed('ui', 'view');
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

  // -------------------------------------------------------------------------------------------
  // interactive area editing (split line following the pointer, join / swap target picking)

  private overlay(): { el: HTMLElement; line: HTMLElement; box: HTMLElement; label: HTMLElement; dispose: () => void } {
    const el = document.createElement('div');
    el.className = 'screen-gesture';
    const line = document.createElement('div');
    line.className = 'sg-line';
    const box = document.createElement('div');
    box.className = 'sg-box';
    const label = document.createElement('div');
    label.className = 'sg-label';
    el.append(line, box, label);
    document.body.append(el);
    return { el, line, box, label, dispose: () => el.remove() };
  }

  private clientRect(a: Area) {
    const r = this.el.getBoundingClientRect();
    return { x: r.left + a.rect.x, y: r.top + a.rect.y, w: a.rect.w, h: a.rect.h };
  }

  /**
   * Run a pointer gesture over the screen. `move` draws the preview and returns the action to run
   * on click/release (null: nothing to do). Esc or right click cancels.
   */
  private gesture(opts: { releaseConfirms: boolean; move: (e: PointerEvent, o: ReturnType<Screen['overlay']>) => (() => void) | null; hint: string }) {
    const o = this.overlay();
    let action: (() => void) | null = null;
    let last: PointerEvent | null = null;
    const update = (e: PointerEvent) => {
      last = e;
      action = opts.move(e, o);
    };
    const end = (run: boolean) => {
      removeEventListener('pointermove', onMove, true);
      removeEventListener('pointerdown', onDown, true);
      removeEventListener('pointerup', onUp, true);
      removeEventListener('keydown', onKey, true);
      removeEventListener('keyup', onKeyUp, true);
      o.dispose();
      document.body.classList.remove('screen-gesture-active');
      if (run && action) action();
    };
    const onMove = (e: PointerEvent) => {
      e.stopPropagation();
      update(e);
    };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 2) end(false);
      else if (!opts.releaseConfirms && e.button === 0) {
        update(e);
        end(true);
      }
    };
    const onUp = (e: PointerEvent) => {
      e.stopPropagation();
      if (opts.releaseConfirms && e.button === 0) {
        update(e);
        end(true);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') end(false);
      else if (e.key === 'Enter') end(true);
      else if (last) update(new PointerEvent('pointermove', { clientX: last.clientX, clientY: last.clientY, ctrlKey: e.ctrlKey || e.key === 'Control', metaKey: e.metaKey, shiftKey: e.shiftKey }));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (last) update(new PointerEvent('pointermove', { clientX: last.clientX, clientY: last.clientY, ctrlKey: e.ctrlKey && e.key !== 'Control', metaKey: e.metaKey && e.key !== 'Meta', shiftKey: e.shiftKey }));
    };
    addEventListener('pointermove', onMove, true);
    addEventListener('pointerdown', onDown, true);
    addEventListener('pointerup', onUp, true);
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', onKeyUp, true);
    document.body.classList.add('screen-gesture-active');
    o.label.textContent = opts.hint;
    update(new PointerEvent('pointermove', { clientX: app.pointer.x, clientY: app.pointer.y }));
  }

  private drawSplit(o: ReturnType<Screen['overlay']>, a: Area, dir: 'h' | 'v', x: number, y: number): number {
    const r = this.clientRect(a);
    const ratio = Math.max(0.05, Math.min(0.95, dir === 'h' ? (x - r.x) / r.w : (y - r.y) / r.h));
    o.box.style.display = 'none';
    Object.assign(o.line.style, dir === 'h' ? { display: '', left: `${r.x + r.w * ratio - 1}px`, top: `${r.y}px`, width: '2px', height: `${r.h}px` } : { display: '', left: `${r.x}px`, top: `${r.y + r.h * ratio - 1}px`, width: `${r.w}px`, height: '2px' });
    return ratio;
  }

  private drawTarget(o: ReturnType<Screen['overlay']>, a: Area, kind: 'join' | 'swap' | 'none') {
    const r = this.clientRect(a);
    o.line.style.display = 'none';
    Object.assign(o.box.style, { display: '', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    o.box.className = `sg-box ${kind}`;
  }

  /** Split with a line that follows the pointer over any area; click to place it. */
  interactiveSplit(_from: Area, dir: 'h' | 'v') {
    this.exitMaximized();
    this.gesture({
      releaseConfirms: false,
      hint: `${dir === 'h' ? 'Vertical' : 'Horizontal'} Split: click to place the edge, Esc to cancel`,
      move: (e, o) => {
        const a = this.areaAt(e.clientX, e.clientY);
        if (!a) {
          o.line.style.display = 'none';
          return null;
        }
        const ratio = this.drawSplit(o, a, dir, e.clientX, e.clientY);
        return () => this.split(a, dir, ratio);
      },
    });
  }

  /** Pick a second area with the pointer to swap with or to join into `a`. */
  interactivePick(a: Area, kind: 'swap' | 'join') {
    this.exitMaximized();
    this.gesture({
      releaseConfirms: false,
      hint: kind === 'swap' ? 'Swap Areas: click the area to swap with, Esc to cancel' : 'Join Areas: click a neighbouring area to remove it, Esc to cancel',
      move: (e, o) => {
        const b = this.areaAt(e.clientX, e.clientY);
        if (!b || b === a) {
          o.box.style.display = 'none';
          return null;
        }
        if (kind === 'swap') {
          this.drawTarget(o, b, 'swap');
          return () => this.swapAreas(a, b);
        }
        const ok = this.canJoin(a, b);
        this.drawTarget(o, b, ok ? 'join' : 'none');
        return ok ? () => this.join(a, b) : null;
      },
    });
  }

  /** Drag from an area corner: inwards splits, into a neighbour joins (it is removed), Ctrl swaps. */
  cornerGesture(a: Area, down: PointerEvent) {
    if (this.maximized) return;
    const sx = down.clientX,
      sy = down.clientY;
    let mode: Gesture | null = null;
    let dir: 'h' | 'v' = 'h';
    this.gesture({
      releaseConfirms: true,
      hint: 'Drag into the area to split it, into a neighbour to join, hold Ctrl to swap, Shift for a new window',
      move: (e, o) => {
        const dx = e.clientX - sx,
          dy = e.clientY - sy;
        o.line.style.display = o.box.style.display = 'none';
        if (!mode && Math.hypot(dx, dy) < 6) return null;
        const over = this.areaAt(e.clientX, e.clientY);
        if (e.shiftKey && Screen.duplicateHook && !MAIN_WINDOW_ONLY.has(a.type)) {
          // Shift: tear the area off into a window
          mode = 'split';
          o.label.textContent = 'Release to show the area in a new window';
          return () => Screen.duplicateHook?.(a, { x: e.clientX, y: e.clientY });
        }
        if (!over) return null;
        if (e.ctrlKey || e.metaKey) {
          mode = 'swap';
          if (over === a) return null;
          this.drawTarget(o, over, 'swap');
          return () => this.swapAreas(a, over);
        }
        if (over === a) {
          // the split direction is fixed by the first clear drag direction
          if (mode !== 'split') {
            mode = 'split';
            dir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
          }
          const ratio = this.drawSplit(o, a, dir, e.clientX, e.clientY);
          return () => this.split(a, dir, ratio);
        }
        mode = 'join';
        const ok = this.canJoin(a, over);
        this.drawTarget(o, over, ok ? 'join' : 'none');
        return ok ? () => this.join(a, over) : null;
      },
    });
  }
}

/** Ctrl-drag of an edge snaps to these proportions. */
export function snapRatio(r: number) {
  const marks = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];
  let best = r;
  let d = 0.04;
  for (const m of marks) if (Math.abs(m - r) < d) ((d = Math.abs(m - r)), (best = m));
  return best;
}

const menuButtons = new WeakMap<HTMLElement, boolean>();

/** Items of a header menu button, collected without opening it. */
function captureMenu(btn: HTMLElement): MenuItem[] {
  return captureMenuItems(() => btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })));
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
  // look development: the studio HDRI shows (blurred) behind the scene, with the preview spheres
  const lookdevView = { shading: { type: 'MATERIAL', studio_hdri: 'sky', studiolight_background_alpha: 1, studiolight_background_blur: 0.5 }, overlay: { show_look_dev: true }, toolbar: false };
  const sculptView = { shading: 'SOLID', matcap: true, nav: { distance: 7 }, overlay: { show_floor: false, show_axis_x: false, show_axis_y: false, show_stats: true } };
  return [
    { name: 'Layout', layout: H(0.822, V(0.925, A('VIEW_3D'), A('TIMELINE')), dock()) },
    { name: 'Modeling', layout: H(0.822, A('VIEW_3D'), dock('MODIFIER')), mode: 'EDIT' },
    { name: 'Sculpting', layout: H(0.822, A('VIEW_3D', sculptView), dock('TOOL')), mode: 'SCULPT' },
    { name: 'UV Editing', layout: H(0.822, H(0.5, A('UV'), A('VIEW_3D')), dock('DATA')), mode: 'EDIT' },
    { name: 'Texture Paint', layout: H(0.822, H(0.5, A('IMAGE_EDITOR'), A('VIEW_3D', { shading: 'MATERIAL' })), dock('TOOL')), mode: 'TEXTURE_PAINT' },
    { name: 'Shading', layout: H(0.822, H(0.16, V(0.5, A('FILE_BROWSER'), A('IMAGE_EDITOR')), V(0.5, A('VIEW_3D', lookdevView), A('SHADER', { toolbar: false }))), dock('WORLD')) },
    { name: 'Animation', layout: H(0.822, V(0.58, H(0.35, A('VIEW_3D', { camera: true, toolbar: false }), A('VIEW_3D', { toolbar: false })), A('DOPESHEET')), V(0.18, A('OUTLINER'), A('PROPERTIES'))) },
    { name: 'Rendering', layout: H(0.822, V(0.925, A('IMAGE_EDITOR', { render: true, sidebar: true }), A('TIMELINE')), A('PROPERTIES', { tab: 'RENDER' })) },
    { name: 'Compositing', layout: H(0.822, V(0.92, V(0.48, A('IMAGE_EDITOR', { render: true }), A('COMPOSITOR', { sidebar: true })), A('TIMELINE')), A('PROPERTIES', { tab: 'OUTPUT' })) },
    { name: 'Geometry Nodes', layout: H(0.822, V(0.92, V(0.48, H(0.42, A('SPREADSHEET'), A('VIEW_3D')), A('GEOMETRY', { toolbar: false })), A('TIMELINE')), dock('MODIFIER')) },
    { name: 'Scripting', layout: H(0.822, H(0.36, V(0.38, A('VIEW_3D', { toolbar: false }), V(0.7, A('CONSOLE'), A('INFO'))), A('TEXT')), V(0.18, A('OUTLINER'), V(0.3, A('OUTLINER', { displayMode: 'BLENDER_FILE' }), A('PROPERTIES', { tab: 'RENDER' })))) },
  ];
}

for (const ws of defaultWorkspaces()) registerWorkspaceTemplate('General', () => defaultWorkspaces().find((w) => w.name === ws.name)!);
