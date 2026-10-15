// Base class for the animation editors: a channel region on the left, a canvas
// main region with a frame ruler (scrubbing), markers, preview range shading and
// playhead, an optional sidebar (N) and footer. Subclasses draw their content.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import type { Area, Editor } from '../ui/screen';
import { openMenu, promptText, type MenuItem } from '../ui/menu';
import { textField } from '../ui/widgets';
import type { ObjectData } from '../data/types';
import { View2D, frameStep } from './view2d';
import { C } from './theme';
import { buildChannels, channelSelected, setChannelSelected, channelCurves, isExpanded, setExpanded, channelState, type Channel, type ChannelList, type SpaceKind, type CurveRef } from './channels';
import { setKeySelected } from './keyedit';
import { markerMenu, markerAt, markersLocked } from './markers';

export const RULER_H = 22;
export const MARKER_H = 22;

/** A selectable point in the main region (canvas-local px) for box/circle/lasso selection. */
export interface Selectable {
  x: number;
  y: number;
  selected: boolean;
  set(v: boolean): void;
}

export type Region = 'channels' | 'main' | 'ruler' | 'markers' | 'sidebar' | 'footer';

export interface SidebarTab {
  id: string;
  label: string;
  draw: () => Child;
}

export function menuButton(label: string, items: () => MenuItem[]) {
  return h(
    'button',
    {
      key: `menu-${label}`,
      class: 'hdr-menu',
      onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(items(), e.currentTarget as HTMLElement)),
    },
    label,
  );
}

export function hdrToggle(key: string, ic: string, on: boolean, tip: string, set: () => void) {
  return h(
    'button',
    {
      key,
      class: { 'hdr-toggle': true, on },
      'data-tip': tip,
      onclick: () => set(),
    },
    icon(ic),
  );
}

/** The animation editor under the pointer (for keymap `when` predicates). */
export function hoverEditor(): AnimEditor | null {
  const ed = (app.hoverArea ?? app.activeArea)?.editor;
  return ed instanceof AnimEditor ? ed : null;
}
export const overChannels = () => hoverEditor()?.hover === 'channels';
export const overMain = () => {
  const r = hoverEditor()?.hover;
  return r !== 'channels' && r !== 'sidebar';
};

export abstract class AnimEditor implements Editor {
  el: HTMLElement;
  abstract keymaps: string[];
  view = new View2D();
  scrollY = 0;
  chWidth = 200;
  onlySelected = true;
  showHidden = false;
  search = '';
  showSidebar = false;
  sidebarTab = '';
  autoSnap = true;
  showMarkers = true;
  hover: Region | null = null;
  private _list: ChannelList = { rows: [], curves: [] };
  private listDoc: unknown = null;
  /** Channel list; rebuilt lazily when the document was swapped (undo, Adjust Last Operation). */
  get list(): ChannelList {
    if (this.listDoc !== app.doc) this.rebuild();
    return this._list;
  }
  set list(v: ChannelList) {
    this._list = v;
    this.listDoc = app.doc;
  }
  rowH = 18;
  boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** markers drawn over the bottom of the content instead of in their own row (short editors) */
  compactMarkers = false;
  /** transient overlays drawn over the main region (circle/lasso select, slider tools) */
  overlay: { circle?: { x: number; y: number; r: number }; lasso?: { x: number; y: number }[]; slider?: { label: string; text: string; t: number | null; t0?: number } } | null = null;
  protected canvas: HTMLCanvasElement;
  protected bodyEl: HTMLElement;
  protected chEl: HTMLElement;
  protected chTopEl: HTMLElement;
  protected chRowsEl: HTMLElement;
  protected mainEl: HTMLElement;
  protected sbEl: HTMLElement;
  protected footerEl: HTMLElement;
  protected fitted = false;
  private disposed = false;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'anim-ed';
    this.bodyEl = div('anim-body');
    this.chEl = div('anim-ch');
    this.chTopEl = div('anim-ch-top');
    this.chRowsEl = div('anim-ch-rows');
    const grip = div('anim-ch-grip');
    this.chEl.append(this.chTopEl, this.chRowsEl, grip);
    this.mainEl = div('anim-main');
    this.canvas = document.createElement('canvas');
    this.mainEl.append(this.canvas);
    this.sbEl = div('anim-sb');
    this.footerEl = div('anim-footer area-header');
    this.bodyEl.append(this.chEl, this.mainEl, this.sbEl);
    this.el.append(this.bodyEl, this.footerEl);
    this.restore(state);

    this.canvas.addEventListener('pointerdown', (e) => this.onCanvasDown(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), {
      passive: false,
    });
    this.canvas.addEventListener('dblclick', (e) => {
      if (this.regionAt(e) === 'markers') {
        if (app.doc.scene.timeline_markers.some((m) => m.select)) app.run('marker.rename', {}, { area: this.area });
        return;
      }
      this.onCanvasDblClick(e);
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.mainEl.addEventListener('pointermove', (e) => (this.hover = this.regionAt(e)));
    this.chEl.addEventListener('pointermove', () => (this.hover = 'channels'));
    this.sbEl.addEventListener('pointermove', () => (this.hover = 'sidebar'));
    this.footerEl.addEventListener('pointermove', () => (this.hover = 'footer'));
    this.chRowsEl.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.scrollBy(e.deltaY);
      },
      { passive: false },
    );
    this.chRowsEl.addEventListener('pointerdown', (e) => {
      if (e.target === this.chRowsEl || (e.target as HTMLElement).classList.contains('anim-ch-inner')) {
        if (e.button === 0 && !app.modal) {
          const x0 = e.clientX,
            y0 = e.clientY;
          const move = (ev: PointerEvent) => {
            if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
            cleanup();
            this.channelBoxGesture(e, (a, b, up) =>
              app.run('anim.channels_select_box', { ymin: a, ymax: b, extend: e.shiftKey || up.shiftKey, deselect: e.ctrlKey || e.metaKey }, { area: this.area, invoke: false }),
            );
          };
          const up = () => {
            cleanup();
            if (e.shiftKey) return;
            this.deselectChannels();
            app.pushUndo('Deselect Channels');
            app.changed('doc');
          };
          const cleanup = () => {
            removeEventListener('pointermove', move);
            removeEventListener('pointerup', up);
          };
          addEventListener('pointermove', move);
          addEventListener('pointerup', up);
        }
      }
      if (e.button === 1) this.dragScroll(e);
    });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const x0 = e.clientX,
        w0 = this.chWidth;
      const move = (ev: PointerEvent) => {
        this.chWidth = Math.max(80, Math.min(600, w0 + ev.clientX - x0));
        this.layout();
        this.refresh();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    new ResizeObserver(() => !this.disposed && this.refresh()).observe(this.mainEl);
    this.layout();
  }

  // ---------------------------------------------------------------- abstract

  abstract space(): SpaceKind;
  abstract header(): Child;
  /** draw the main region content (between ruler and markers) */
  protected abstract drawContent(g: CanvasRenderingContext2D, W: number, H: number): void;
  /** LMB in the main region (not ruler/markers); coordinates are canvas-local */
  protected abstract mainDown(e: PointerEvent, x: number, y: number): void;
  /** frame range used by View All */
  abstract viewAll(): void;
  abstract viewSelected(): void;

  protected sidebarTabs(): SidebarTab[] {
    return [];
  }
  protected footer(): Child | null {
    return null;
  }
  /** row prefix widgets (Graph Editor eye/color) */
  protected rowPrefix(_ch: Channel, _i: number): Child {
    return null;
  }
  /** row toggles on the right */
  protected rowToggles(_ch: Channel): Child {
    return null;
  }
  protected rowExtra(_ch: Channel): Child {
    return null;
  }
  protected mainContextMenu(): MenuItem[] | null {
    return null;
  }
  channelContextMenu(): MenuItem[] {
    return [];
  }
  protected onCanvasDblClick(_e: MouseEvent) {}
  /** selectable points for shaped (box/circle/lasso) selection */
  selectables(_includeHandles = true): Selectable[] {
    return [];
  }
  /** whether vertical pan scrolls channel rows (true) or pans the value axis */
  protected rowScroll = true;
  /** wheel zoom over the main region */
  protected wheelZoom(factor: number, x: number, _y: number) {
    this.view.zoomX(factor, x);
  }

  // ---------------------------------------------------------------- state

  serialize(): unknown {
    return {
      onlySelected: this.onlySelected,
      showHidden: this.showHidden,
      chWidth: this.chWidth,
      showSidebar: this.showSidebar,
      sidebarTab: this.sidebarTab,
      autoSnap: this.autoSnap,
      showMarkers: this.showMarkers,
      view: {
        x0: this.view.x0,
        ppf: this.view.ppf,
        y0: this.view.y0,
        ppv: this.view.ppv,
      },
      scrollY: this.scrollY,
      ...this.serializeExtra(),
    };
  }
  protected serializeExtra(): Record<string, unknown> {
    return {};
  }
  protected restore(state: unknown) {
    const s = (state ?? {}) as Record<string, unknown>;
    if (typeof s.onlySelected === 'boolean') this.onlySelected = s.onlySelected;
    if (typeof s.showHidden === 'boolean') this.showHidden = s.showHidden;
    if (typeof s.chWidth === 'number') this.chWidth = s.chWidth;
    if (typeof s.showSidebar === 'boolean') this.showSidebar = s.showSidebar;
    if (typeof s.sidebarTab === 'string') this.sidebarTab = s.sidebarTab;
    if (typeof s.autoSnap === 'boolean') this.autoSnap = s.autoSnap;
    if (typeof s.showMarkers === 'boolean') this.showMarkers = s.showMarkers;
    if (typeof s.scrollY === 'number') this.scrollY = s.scrollY;
    const v = s.view as Record<string, number> | undefined;
    if (v && typeof v.x0 === 'number') {
      Object.assign(this.view, { x0: v.x0, ppf: v.ppf, y0: v.y0, ppv: v.ppv });
      this.fitted = true;
    }
  }

  get filter() {
    return {
      onlySelected: this.onlySelected,
      showHidden: this.showHidden,
      search: this.search,
      isVisible: (ob: ObjectData) => app.isVisible(ob.id),
      activeObject: app.activeObject,
    };
  }

  /** Editable curves in scope (unlocked; visible-only in the Graph Editor). */
  editCurves(): CurveRef[] {
    return this.list.curves.filter((r) => !r.fc.lock);
  }

  rebuild() {
    this.list = buildChannels(app.doc, this.space(), this.filter);
  }

  // ---------------------------------------------------------------- Editor

  update(_kinds?: Set<ChangeKind>) {
    this.refresh();
  }

  resize() {
    this.refresh();
  }

  dispose() {
    this.disposed = true;
  }

  layout() {
    this.chEl.style.width = `${this.chWidth}px`;
    this.sbEl.hidden = !this.showSidebar || !this.sidebarTabs().length;
  }

  refresh() {
    if (this.disposed) return;
    this.rebuild();
    this.layout();
    this.clampScroll();
    this.drawChannels();
    this.draw();
    this.drawSidebar();
    const f = this.footer();
    this.footerEl.hidden = !f;
    if (f) patch(this.footerEl, f);
  }

  // ---------------------------------------------------------------- geometry

  get mainW() {
    return this.mainEl.clientWidth;
  }
  get mainH() {
    return this.mainEl.clientHeight;
  }
  markersVisible() {
    return this.showMarkers && app.doc.scene.timeline_markers.length > 0;
  }
  /** bottom of the content region (top of the markers row) */
  contentBottom() {
    return this.mainH - (this.markersVisible() && !this.compactMarkers ? MARKER_H : 0);
  }
  rowTop(i: number) {
    return RULER_H + i * this.rowH - this.scrollY;
  }
  rowAt(y: number): number {
    if (y < RULER_H) return -1;
    return Math.floor((y - RULER_H + this.scrollY) / this.rowH);
  }
  regionAt(e: PointerEvent | MouseEvent): Region {
    const r = this.canvas.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (y < RULER_H) return 'ruler';
    if (this.markersVisible() && y > r.height - (this.compactMarkers ? 12 : MARKER_H)) return 'markers';
    return 'main';
  }
  local(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  toClient(x: number, y: number) {
    const r = this.canvas.getBoundingClientRect();
    return { x: x + r.left, y: y + r.top };
  }

  scrollBy(dy: number) {
    this.scrollY += dy;
    this.clampScroll();
    this.drawChannels();
    this.draw();
  }
  clampScroll() {
    const total = this.list.rows.length * this.rowH;
    const avail = Math.max(0, this.contentBottom() - RULER_H);
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, total - avail + this.rowH)));
  }

  // ---------------------------------------------------------------- channels

  deselectChannels() {
    for (const r of this.list.curves) r.fc.select = false;
    channelState.selectedGroups.clear();
    channelState.selectedDrivers.clear();
    channelState.selectedShapeKeys.clear();
    for (const ch of this.list.rows) if (ch.kind === 'NLA_TRACK' && ch.track) ch.track.select = false;
  }

  /** Channel row under a client y coordinate. */
  channelAtClient(clientY: number): Channel | null {
    const r = this.chRowsEl.getBoundingClientRect();
    const i = Math.floor((clientY - r.top + this.scrollY) / this.rowH);
    return this.list.rows[i] ?? null;
  }

  /** Channel rows overlapping a client y range. */
  channelRowsBetween(y0: number, y1: number): Channel[] {
    const r = this.chRowsEl.getBoundingClientRect();
    const a = Math.floor((Math.min(y0, y1) - r.top + this.scrollY) / this.rowH),
      b = Math.floor((Math.max(y0, y1) - r.top + this.scrollY) / this.rowH);
    return this.list.rows.slice(Math.max(0, a), Math.max(0, b + 1));
  }

  focusSearch() {
    const inp = this.chTopEl.querySelector('input');
    if (inp) {
      inp.focus();
      inp.select();
    }
  }

  /** Vertical drag over the channel list; `done` gets the client y range. */
  channelBoxGesture(e: { clientX: number; clientY: number }, done: (y0: number, y1: number, ev: PointerEvent) => void) {
    const y0 = e.clientY;
    const box = div('anim-ch-box');
    const r = this.chEl.getBoundingClientRect();
    box.style.cssText = `position:absolute;left:0;right:0;top:${y0 - r.top}px;height:0;border:1px dashed rgba(255,255,255,0.8);background:rgba(255,255,255,0.06);pointer-events:none;z-index:3`;
    this.chEl.append(box);
    const move = (ev: PointerEvent) => {
      const a = Math.min(y0, ev.clientY),
        b = Math.max(y0, ev.clientY);
      box.style.top = `${a - r.top}px`;
      box.style.height = `${b - a}px`;
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      box.remove();
      done(Math.min(y0, ev.clientY), Math.max(y0, ev.clientY), ev);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** Click on a channel name: select it (Shift toggles). */
  clickChannel(ch: Channel, extend: boolean) {
    if (ch.kind === 'SUMMARY') {
      if (!extend) this.deselectChannels();
      return;
    }
    if (ch.kind === 'OBJECT' && ch.ob) {
      if (!extend) for (const o of Object.values(app.doc.objects)) o.select = false;
      ch.ob.select = extend ? !ch.ob.select : true;
      if (ch.ob.select) app.activeObject = ch.ob;
      app.changed('select');
      return;
    }
    if (ch.kind === 'ACTION' || ch.kind === 'DRIVERS' || ch.kind === 'NLA_ACTION') return;
    const was = channelSelected(ch);
    if (!extend) this.deselectChannels();
    setChannelSelected(ch, extend ? !was : true);
    if (ch.kind === 'FCURVE' || ch.kind === 'SHAPEKEY') this.onActiveCurve(ch);
  }

  /** hook: the active F-Curve changed */
  protected onActiveCurve(_ch: Channel) {}

  renameChannel(ch: Channel) {
    let current = '';
    let apply: ((v: string) => void) | null = null;
    if (ch.kind === 'OBJECT' && ch.ob) {
      const ob = ch.ob;
      current = ob.name;
      apply = (v) => (ob.name = v);
    } else if (ch.kind === 'ACTION' && ch.action) {
      const a = ch.action;
      current = a.name;
      apply = (v) => (a.name = v);
    } else if (ch.kind === 'NLA_ACTION' && ch.action) {
      const a = ch.action;
      current = a.name;
      apply = (v) => (a.name = v);
    } else if (ch.kind === 'GROUP' && ch.action && ch.group) {
      const a = ch.action,
        old = ch.group;
      current = old;
      apply = (v) => {
        for (const fc of a.fcurves) if (fc.group === old) fc.group = v;
      };
    } else if (ch.kind === 'NLA_TRACK' && ch.track) {
      const t = ch.track;
      current = t.name;
      apply = (v) => (t.name = v);
    } else if (ch.kind === 'SHAPEKEY' && ch.shapeKey && ch.ob) {
      const sk = ch.shapeKey,
        ob = ch.ob,
        fc = ch.fc;
      current = sk.name;
      apply = (v) => {
        sk.name = v;
        if (fc) fc.data_path = `data.shape_keys.key_blocks["${v.replace(/"/g, '\\"')}"].value`;
        void ob;
      };
    }
    if (!apply) return;
    const doApply = apply;
    promptText('Rename', current, (v) => {
      if (!v) return;
      doApply(v);
      app.pushUndo('Rename Channel');
      app.changed('doc');
    });
  }

  /** Select all keys of a channel (double-click). */
  selectChannelKeys(ch: Channel, extend: boolean) {
    if (!extend) for (const r of this.list.curves) r.fc.keyframe_points.forEach((k) => setKeySelected(k, false));
    for (const r of ch.curves) r.fc.keyframe_points.forEach((k) => setKeySelected(k, true));
  }

  toggleSetting(ch: Channel, setting: 'mute' | 'lock' | 'hide') {
    const fcs = channelCurves(ch);
    if (!fcs.length) return;
    const allOn = fcs.every((f) => !!f[setting]);
    for (const f of fcs) f[setting] = !allOn;
    app.pushUndo(setting === 'mute' ? 'Toggle Mute' : setting === 'lock' ? 'Toggle Lock' : 'Toggle Visibility');
    app.changed('doc');
  }

  private lastClicked: string | null = null;

  /** Whether a channel can be renamed in place. */
  canRename(ch: Channel) {
    return ['OBJECT', 'ACTION', 'NLA_ACTION', 'GROUP', 'NLA_TRACK', 'SHAPEKEY'].includes(ch.kind) && (ch.kind !== 'ACTION' && ch.kind !== 'NLA_ACTION' ? true : !!ch.action);
  }

  protected channelDown(e: PointerEvent, ch: Channel) {
    if ((e.target as HTMLElement).closest('.anim-tg, .num-field, input, .anim-exp')) return;
    if (e.button === 1 && e.altKey) {
      e.preventDefault();
      app.run('anim.channel_view_pick', {}, { area: this.area, event: { x: e.clientX, y: e.clientY } });
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      if (!channelSelected(ch)) {
        this.clickChannel(ch, false);
        app.changed('doc');
      }
      const items = this.channelContextMenu();
      if (items.length) openMenu(items, { x: e.clientX, y: e.clientY });
      return;
    }
    if (e.button !== 0) return;
    if (e.shiftKey && !(e.ctrlKey || e.metaKey) && this.lastClicked) {
      // Shift: select the range from the last clicked channel
      const rows = this.list.rows;
      const a = rows.findIndex((r) => r.key === this.lastClicked),
        b = rows.indexOf(ch);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!['SUMMARY', 'ACTION', 'DRIVERS', 'NLA_ACTION'].includes(rows[i].kind)) setChannelSelected(rows[i], true);
        app.pushUndo('Select Channels');
        app.changed('doc');
        return;
      }
    }
    // Ctrl (or Shift without an anchor) toggles the channel in the selection
    this.clickChannel(ch, e.shiftKey || e.ctrlKey || e.metaKey);
    this.lastClicked = ch.key;
    app.pushUndo('Click Channel');
    app.changed('doc');
  }

  /** Double-click: rename channels that have a name, otherwise select the channel's keys. */
  protected channelDblClick(e: MouseEvent, ch: Channel) {
    if ((e.target as HTMLElement).closest('.anim-tg, .num-field, input, .anim-exp')) return;
    if (this.canRename(ch) && !e.shiftKey) {
      this.renameChannel(ch);
      return;
    }
    this.selectChannelKeys(ch, e.shiftKey);
    app.pushUndo('Select Channel Keyframes');
    app.changed('doc');
  }

  drawChannels() {
    patch(
      this.chTopEl,
      textField('anim-search', this.search, (v) => ((this.search = v), this.refresh()), {
        placeholder: 'Search',
        icon: 'search',
        live: true,
        className: 'anim-search',
      }),
    );
    const rows = this.list.rows;
    const total = rows.length * this.rowH;
    patch(
      this.chRowsEl,
      h(
        'div',
        {
          class: 'anim-ch-inner',
          style: {
            height: `${total + 40}px`,
            transform: `translateY(${-this.scrollY}px)`,
          },
        },
        rows.map((ch, i) => {
          const sel = channelSelected(ch);
          return h(
            'div',
            {
              key: ch.key,
              class: {
                'anim-ch-row': true,
                [`k-${ch.kind.toLowerCase()}`]: true,
                sel,
                muted: ch.kind === 'FCURVE' && !!ch.fc?.mute,
              },
              style: {
                top: `${i * this.rowH}px`,
                height: `${this.rowH}px`,
                paddingLeft: `${4 + ch.depth * 14}px`,
              },
              onpointerdown: (e: PointerEvent) => this.channelDown(e, ch),
              ondblclick: (e: MouseEvent) => this.channelDblClick(e, ch),
            },
            ch.expandable
              ? h(
                  'span',
                  {
                    class: 'anim-exp',
                    onpointerdown: (e: PointerEvent) => {
                      e.stopPropagation();
                      if (e.button !== 0) return;
                      setExpanded(ch.key, !isExpanded(ch.key, ch.kind));
                      this.refresh();
                    },
                  },
                  icon(ch.expanded ? 'disclosure_tri_down' : 'disclosure_tri_right'),
                )
              : h('span', { class: 'anim-exp-space' }),
            this.rowPrefix(ch, i),
            ch.icon ? icon(ch.icon) : null,
            h('span', { class: 'anim-ch-name' }, ch.label),
            this.rowExtra(ch),
            h('span', { class: 'anim-ch-tgs' }, this.rowToggles(ch)),
          );
        }),
      ),
    );
  }

  /** standard mute/lock toggles */
  protected muteLockToggles(ch: Channel): Child {
    if (!['GROUP', 'FCURVE', 'SHAPEKEY'].includes(ch.kind)) return null;
    const fcs = channelCurves(ch);
    if (!fcs.length) return null;
    const muted = fcs.every((f) => f.mute);
    const locked = fcs.every((f) => f.lock);
    return [
      h(
        'button',
        {
          key: 'mute',
          class: { 'anim-tg': true, off: muted },
          'data-tip': 'Mute\nDoes F-Curve contribute to result',
          onpointerdown: (e: PointerEvent) => (e.stopPropagation(), e.button === 0 && this.toggleSetting(ch, 'mute')),
        },
        icon(muted ? 'checkbox_dehlt' : 'checkbox_hlt'),
      ),
      h(
        'button',
        {
          key: 'lock',
          class: { 'anim-tg': true, on: locked },
          'data-tip': 'Lock\nF-Curve can not be edited',
          onpointerdown: (e: PointerEvent) => (e.stopPropagation(), e.button === 0 && this.toggleSetting(ch, 'lock')),
        },
        icon(locked ? 'locked' : 'unlocked'),
      ),
    ];
  }

  drawSidebar() {
    const tabs = this.sidebarTabs();
    if (!this.showSidebar || !tabs.length) {
      this.sbEl.hidden = true;
      return;
    }
    this.sbEl.hidden = false;
    if (!tabs.some((t) => t.id === this.sidebarTab)) this.sidebarTab = tabs[0].id;
    const tab = tabs.find((t) => t.id === this.sidebarTab)!;
    patch(this.sbEl, [
      h('div', { key: 'body', class: 'sb-body' }, tab.draw()),
      h(
        'div',
        { key: 'tabs', class: 'sb-tabs' },
        tabs.map((t) =>
          h(
            'button',
            {
              key: t.id,
              class: { 'sb-tab': true, on: t.id === this.sidebarTab },
              onclick: () => ((this.sidebarTab = t.id), this.drawSidebar()),
            },
            t.label,
          ),
        ),
      ),
    ]);
  }

  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    this.layout();
    this.refresh();
  }

  // ---------------------------------------------------------------- drawing

  protected fitInitial(W: number) {
    const s = app.doc.scene;
    this.view.width = W;
    this.view.fitX(s.frame_start, s.frame_end, 40);
  }

  draw() {
    const c = this.canvas;
    const W = this.mainW,
      H = this.mainH;
    if (!W || !H) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    this.view.width = W;
    this.view.height = Math.max(1, this.contentBottom() - RULER_H);
    if (!this.fitted) {
      this.fitInitial(W);
      this.fitted = true;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.back;
    g.fillRect(0, 0, W, H);
    this.drawRanges(g, W, H);
    this.drawFrameGrid(g, W, H);
    g.save();
    g.beginPath();
    g.rect(0, RULER_H, W, this.contentBottom() - RULER_H);
    g.clip();
    this.drawContent(g, W, H);
    g.restore();
    this.drawMarkers(g, W, H);
    this.drawPlayheadLine(g, H);
    this.drawRuler(g, W);
    if (this.boxRect) {
      const b = this.boxRect;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.setLineDash([4, 3]);
      g.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.setLineDash([]);
    }
    if (this.overlay) this.drawOverlay(g, W);
  }

  protected drawOverlay(g: CanvasRenderingContext2D, W: number) {
    const o = this.overlay!;
    g.save();
    if (o.circle) {
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.arc(o.circle.x, o.circle.y, o.circle.r, 0, Math.PI * 2);
      g.stroke();
    }
    if (o.lasso && o.lasso.length > 1) {
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.setLineDash([4, 3]);
      g.beginPath();
      o.lasso.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.fill();
      g.stroke();
    }
    g.setLineDash([]);
    if (o.slider) {
      // slider readout centred at the top of the content region
      const w = Math.min(320, W - 20),
        x = (W - w) / 2,
        y = RULER_H + 8,
        hh = 22;
      g.fillStyle = 'rgba(30,30,30,0.9)';
      roundRect(g, x, y, w, hh, 5);
      g.fill();
      if (o.slider.t !== null) {
        const t = Math.max(0, Math.min(1, o.slider.t)),
          t0 = o.slider.t0 ?? 0;
        g.fillStyle = 'rgba(80,130,220,0.55)';
        const a = Math.min(t, t0),
          b = Math.max(t, t0);
        roundRect(g, x + 2 + (w - 4) * a, y + 2, Math.max(0, (w - 4) * (b - a)), hh - 4, 3);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(Math.round(x + w / 2) + 0.5, y + 3, 1, hh - 6);
      }
      g.fillStyle = '#e8e8e8';
      g.font = '12px Inter, system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(`${o.slider.label}: ${o.slider.text}`, W / 2, y + hh / 2 + 1);
      g.textBaseline = 'alphabetic';
    }
    g.restore();
  }

  protected drawRanges(g: CanvasRenderingContext2D, W: number, H: number) {
    const s = app.doc.scene,
      v = this.view;
    const a = v.fx(s.frame_start),
      b = v.fx(s.frame_end);
    g.fillStyle = C.outOfRange;
    if (a > 0) g.fillRect(0, RULER_H, Math.min(W, a), H);
    if (b < W) g.fillRect(Math.max(0, b), RULER_H, W - b, H);
    if (s.use_preview_range) {
      const pa = v.fx(s.frame_preview_start ?? s.frame_start),
        pb = v.fx(s.frame_preview_end ?? s.frame_end);
      g.fillStyle = C.previewRange;
      if (pa > 0) g.fillRect(0, RULER_H, Math.min(W, pa), H);
      if (pb < W) g.fillRect(Math.max(0, pb), RULER_H, W - pb, H);
    }
  }

  protected drawFrameGrid(g: CanvasRenderingContext2D, W: number, H: number) {
    const v = this.view;
    const step = frameStep(v.ppf, app.doc.scene.render.fps);
    const first = Math.floor(v.xf(0) / step) * step;
    g.lineWidth = 1;
    for (let f = first; v.fx(f) < W + 1; f += step) {
      const x = Math.round(v.fx(f)) + 0.5;
      g.strokeStyle = C.grid;
      g.beginPath();
      g.moveTo(x, RULER_H);
      g.lineTo(x, H);
      g.stroke();
      // half-step minor line
      const xm = Math.round(v.fx(f + step / 2)) + 0.5;
      if (step >= 2 && v.ppf * step > 60) {
        g.strokeStyle = C.gridMinor;
        g.beginPath();
        g.moveTo(xm, RULER_H);
        g.lineTo(xm, H);
        g.stroke();
      }
    }
  }

  protected drawRuler(g: CanvasRenderingContext2D, W: number) {
    const v = this.view,
      s = app.doc.scene;
    g.fillStyle = C.rulerBack;
    g.fillRect(0, 0, W, RULER_H);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(0, RULER_H - 1, W, 1);
    const step = frameStep(v.ppf, s.render.fps);
    const first = Math.floor(v.xf(0) / step) * step;
    g.font = '11px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = C.rulerText;
    // playhead box (labels under it are skipped)
    const px = Math.round(v.fx(s.frame_current));
    const label = String(s.frame_current);
    const tw = Math.max(24, g.measureText(label).width + 12);
    for (let f = first; v.fx(f) < W + 30; f += step) {
      const x = Math.round(v.fx(f));
      const lw = g.measureText(String(f)).width;
      if (Math.abs(x - px) < tw / 2 + lw / 2 + 2) continue;
      g.fillText(String(f), x, RULER_H / 2 + 1);
    }
    g.fillStyle = C.playhead;
    roundRect(g, px - tw / 2, 2, tw, RULER_H - 4, 4);
    g.fill();
    g.fillStyle = C.playheadText;
    g.fillText(label, px, RULER_H / 2 + 1);
    g.textBaseline = 'alphabetic';
  }

  protected drawPlayheadLine(g: CanvasRenderingContext2D, H: number) {
    const px = Math.round(this.view.fx(app.doc.scene.frame_current)) + 0.5;
    g.strokeStyle = C.playhead;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px, RULER_H);
    g.lineTo(px, H);
    g.stroke();
    g.lineWidth = 1;
  }

  protected drawMarkers(g: CanvasRenderingContext2D, W: number, H: number) {
    if (!this.markersVisible()) return;
    if (this.compactMarkers) return this.drawCompactMarkers(g, W, H);
    const top = H - MARKER_H;
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, top, W, MARKER_H);
    g.font = '11px Inter, system-ui, sans-serif';
    g.textAlign = 'left';
    for (const m of app.doc.scene.timeline_markers) {
      const x = Math.round(this.view.fx(m.frame)) + 0.5;
      if (x < -100 || x > W + 10) continue;
      g.strokeStyle = m.select ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, RULER_H);
      g.lineTo(x, top + 4);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = m.select ? C.markerSelected : C.marker;
      g.beginPath();
      g.moveTo(x, top + 15);
      g.lineTo(x - 5, top + 8);
      g.lineTo(x - 5, top + 4);
      g.lineTo(x + 5, top + 4);
      g.lineTo(x + 5, top + 8);
      g.closePath();
      g.fill();
      g.fillStyle = m.select ? '#fff' : '#bbb';
      g.fillText(m.name, x + 8, top + 14);
    }
  }

  /** Small markers along the bottom edge (no separate row). */
  protected drawCompactMarkers(g: CanvasRenderingContext2D, W: number, H: number) {
    g.font = '10px Inter, system-ui, sans-serif';
    g.textAlign = 'left';
    for (const m of app.doc.scene.timeline_markers) {
      const x = Math.round(this.view.fx(m.frame)) + 0.5;
      if (x < -100 || x > W + 10) continue;
      g.strokeStyle = m.select ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, RULER_H);
      g.lineTo(x, H - 9);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = m.select ? C.markerSelected : C.marker;
      g.beginPath();
      g.moveTo(x, H - 2);
      g.lineTo(x - 4, H - 8);
      g.lineTo(x + 4, H - 8);
      g.closePath();
      g.fill();
      g.fillStyle = m.select ? '#fff' : '#bbb';
      g.fillText(m.name, x + 6, H - 2);
    }
  }

  // ---------------------------------------------------------------- input

  protected onCanvasDown(e: PointerEvent) {
    if (app.modal) return;
    const { x, y } = this.local(e);
    const region = this.regionAt(e);
    if (e.button === 1) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.dragZoom(e);
      else this.dragPan(e);
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      if (region === 'markers') {
        openMenu(markerMenu(), { x: e.clientX, y: e.clientY });
        return;
      }
      const items = this.mainContextMenu();
      if (items) openMenu(items, { x: e.clientX, y: e.clientY });
      return;
    }
    if (e.button !== 0) return;
    if (region === 'ruler') return this.scrub(e);
    if (region === 'markers') return this.markerDown(e, x);
    this.mainDown(e, x, y);
  }

  scrub(e: PointerEvent) {
    const set = (ev: PointerEvent) => {
      const f = Math.round(this.view.xf(this.local(ev).x));
      if (f !== app.doc.scene.frame_current) app.setFrame(f);
    };
    set(e);
    const up = () => {
      removeEventListener('pointermove', set);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', set);
    addEventListener('pointerup', up);
  }

  protected markerDown(e: PointerEvent, x: number) {
    if (markersLocked()) return;
    const list = app.doc.scene.timeline_markers;
    const best = markerAt(this.view.xf(x), this.view.ppf);
    if (!best) {
      // empty marker row: click deselects, drag box-selects markers
      this.clickOrDrag(
        e,
        () => {
          if (e.shiftKey) return;
          list.forEach((m) => (m.select = false));
          app.pushUndo('Select Markers');
          app.changed('ui');
          this.draw();
        },
        (start) =>
          this.boxGesture(start, (r, mode) => app.run('marker.select_box', { mode, xmin: this.view.xf(r.x0), xmax: this.view.xf(r.x1) }, { area: this.area, invoke: false })),
      );
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: select and make the marker's camera active
      app.run('marker.select', { frame: best.frame, extend: e.shiftKey, camera: true }, { area: this.area, invoke: false });
      return;
    }
    if (e.shiftKey) best.select = !best.select;
    else if (!best.select) {
      list.forEach((m) => (m.select = false));
      best.select = true;
    }
    this.draw();
    const sel = list.filter((m) => m.select);
    const orig = sel.map((m) => m.frame);
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const df = Math.round((ev.clientX - x0) / this.view.ppf);
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (!moved) return;
      sel.forEach((m, i) => (m.frame = orig[i] + df));
      app.changed('ui');
      this.draw();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!moved && !e.shiftKey) {
        list.forEach((m) => (m.select = m === best));
      }
      app.pushUndo(moved ? 'Move Markers' : 'Select Marker');
      app.changed('doc');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  protected dragPan(e: PointerEvent) {
    let lx = e.clientX,
      ly = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - lx,
        dy = ev.clientY - ly;
      lx = ev.clientX;
      ly = ev.clientY;
      this.view.panPx(dx, this.rowScroll ? 0 : dy);
      if (this.rowScroll) this.scrollBy(-dy);
      else this.draw();
      this.afterViewChange();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  protected dragZoom(e: PointerEvent) {
    const { x: ax, y: ay } = this.local(e);
    let lx = e.clientX,
      ly = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - lx,
        dy = ev.clientY - ly;
      lx = ev.clientX;
      ly = ev.clientY;
      this.view.zoomX(Math.exp(dx * 0.01), ax);
      if (!this.rowScroll) this.view.zoomY(Math.exp(-dy * 0.01), ay - RULER_H);
      this.draw();
      this.afterViewChange();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  protected dragScroll(e: PointerEvent) {
    let ly = e.clientY;
    const move = (ev: PointerEvent) => {
      this.scrollBy(ly - ev.clientY);
      ly = ev.clientY;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  protected onWheel(e: WheelEvent) {
    e.preventDefault();
    if (app.modal) {
      app.modal.onWheel?.(e);
      return;
    }
    const { x, y } = this.local(e);
    const dx = e.deltaX,
      dy = e.deltaY;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+wheel scrolls horizontally
      this.view.panPx(-(dy || dx), 0);
    } else if (e.shiftKey) {
      if (this.rowScroll) this.scrollBy(dy || dx);
      else this.view.panPx(0, -(dy || dx));
    } else if (Math.abs(dx) > Math.abs(dy)) {
      this.view.panPx(-dx, 0);
    } else {
      const k = Math.exp(-dy * 0.0025);
      this.wheelZoom(k, x, y - RULER_H);
    }
    this.draw();
    this.afterViewChange();
  }

  /** hook after pan/zoom (e.g. redraw overlays) */
  protected afterViewChange() {}

  /** Generic box gesture in the main region. `done` gets canvas-local rect and modifier mode. */
  boxGesture(
    e: { clientX: number; clientY: number },
    done: (r: { x0: number; y0: number; x1: number; y1: number }, mode: 'SET' | 'ADD' | 'SUB') => void,
    startNow = true,
    mode0?: 'SET' | 'ADD' | 'SUB',
  ) {
    const p0 = this.local(e);
    this.boxRect = startNow ? { x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y } : null;
    let mode = mode0 ?? 'SET';
    const move = (ev: PointerEvent) => {
      const p = this.local(ev);
      if (!this.boxRect) return;
      this.boxRect.x1 = p.x;
      this.boxRect.y1 = p.y;
      this.draw();
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      const r = this.boxRect;
      this.boxRect = null;
      if (!mode0) mode = ev.shiftKey ? 'ADD' : ev.ctrlKey || ev.metaKey ? 'SUB' : 'SET';
      if (r)
        done(
          {
            x0: Math.min(r.x0, r.x1),
            y0: Math.min(r.y0, r.y1),
            x1: Math.max(r.x0, r.x1),
            y1: Math.max(r.y0, r.y1),
          },
          mode,
        );
      this.draw();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** Drag threshold helper: calls `onDrag` once the pointer moved, else `onClick` on release. */
  protected clickOrDrag(e: PointerEvent, onClick: () => void, onDrag: (start: PointerEvent) => void) {
    const x0 = e.clientX,
      y0 = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (dragging) return;
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) {
        dragging = true;
        cleanup();
        onDrag(e);
      }
    };
    const up = () => {
      cleanup();
      if (!dragging) onClick();
    };
    const cleanup = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  centerCurrentFrame() {
    this.view.centerOnFrame(app.doc.scene.frame_current);
    this.draw();
  }

  viewFrameRange(a: number, b: number) {
    this.view.width = this.mainW;
    this.view.fitX(a, b, 40);
    this.draw();
  }
}

function div(cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + hh, r);
  g.arcTo(x + w, y + hh, x, y + hh, r);
  g.arcTo(x, y + hh, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export { markerMenu };
