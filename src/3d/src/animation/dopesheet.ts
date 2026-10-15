// Dope Sheet editor (modes: Dope Sheet, Action Editor, Shape Key Editor).
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { registerEditor, type Area } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { numberField, textField, checkbox } from '../ui/widgets';
import { actionRange } from './actionops';
import type { ActionData, Keyframe, ShapeKey, TimelineMarker } from '../data/types';
import { AnimEditor, RULER_H, menuButton, hdrToggle, markerMenu, type Selectable, type SidebarTab } from './animeditor';
import type { Channel, SpaceKind } from './channels';
import { C, drawKey, shapeFor } from './theme';
import { aggregate } from './aggregate';
import { setKeySelected, selectAll, selectColumns, keyBounds } from './keyedit';
import { startKeyTransform, type KeyTransformHost, type KeyTransformMode } from './transformkeys';
import { proportionalOf, proportionalHeader } from './proportional';
import { playbackFooter } from './footer';
import { lassoGesture } from './selecttools';
import { actionSelector } from './actionui';
import { viewMenuCommon, selectMenu, channelMenu, keyMenu } from './menus';

export type DopeSheetMode = 'DOPESHEET' | 'ACTION' | 'SHAPEKEY';

const MODES: {
  value: DopeSheetMode;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: 'DOPESHEET',
    label: 'Dope Sheet',
    icon: 'action',
    description: 'Edit all keyframes in scene',
  },
  {
    value: 'ACTION',
    label: 'Action Editor',
    icon: 'action',
    description: 'Edit keyframes in active object’s Object-level action',
  },
  {
    value: 'SHAPEKEY',
    label: 'Shape Key Editor',
    icon: 'shapekey_data',
    description: 'Edit keyframes in active object’s Shape Keys action',
  },
];

/** Mode list of the header dropdown (modules may append modes, e.g. Grease Pencil). */
export const DOPESHEET_MODES = MODES as { value: string; label: string; icon: string; description: string }[];

export class DopeSheet extends AnimEditor {
  keymaps = ['Markers', 'Animation Channels', 'Dopesheet', 'Animation'];
  prefix = 'action' as const;
  mode: DopeSheetMode = 'DOPESHEET';
  showHandlesInterp = true;
  showSummary = true;
  /** Action Editor: the marker row shows the action's pose markers */
  showPoseMarkers = false;

  constructor(area: Area, state?: unknown) {
    super(area, state);
    const s = (state ?? {}) as Record<string, unknown>;
    if (s.mode === 'ACTION' || s.mode === 'SHAPEKEY' || s.mode === 'DOPESHEET') this.mode = s.mode;
    if (typeof s.showHandlesInterp === 'boolean') this.showHandlesInterp = s.showHandlesInterp;
    if (typeof s.showPoseMarkers === 'boolean') this.showPoseMarkers = s.showPoseMarkers;
  }

  protected serializeExtra() {
    return { mode: this.mode, showHandlesInterp: this.showHandlesInterp, showPoseMarkers: this.showPoseMarkers };
  }

  space(): SpaceKind {
    return this.mode;
  }

  setMode(m: DopeSheetMode) {
    this.mode = m;
    this.scrollY = 0;
    app.changed('ui');
    this.refresh();
  }

  header(): Child {
    const cur = MODES.find((m) => m.value === this.mode)!;
    const ob = app.activeObject;
    return h(
      'div',
      { class: 'hdr-row' },
      h(
        'button',
        {
          key: 'mode',
          class: 'hdr-mode',
          'data-tip': 'Mode\nEditing context being displayed',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              MODES.map((m) => ({
                label: m.label,
                icon: m.icon,
                active: m.value === this.mode,
                description: m.description,
                action: () => this.setMode(m.value),
              })),
              e.currentTarget as HTMLElement,
            );
          },
        },
        icon(cur.icon),
        cur.label,
        icon('down_arrow_hlt', 'tiny'),
      ),
      menuButton('View', () => this.viewMenu()),
      menuButton('Select', () => selectMenu('action')),
      menuButton('Marker', markerMenu),
      menuButton('Channel', () => channelMenu('action')),
      menuButton('Key', () => keyMenu('action')),
      this.mode === 'ACTION'
        ? menuButton('Action', () => [
            { label: 'New Action', op: 'action.new' },
            { label: 'Unlink Action', op: 'action.unlink' },
            { separator: true },
            { label: 'Push Down Action', op: 'action.push_down' },
            { label: 'Stash Action', op: 'action.stash' },
            { label: 'Stash and Create New', op: 'action.stash_and_create' },
          ])
        : null,
      this.mode === 'ACTION' && ob ? actionSelector(ob) : null,
      h('div', { class: 'hdr-spacer' }),
      this.mode === 'DOPESHEET'
        ? hdrToggle(
            'only-sel',
            'restrict_select_off',
            this.onlySelected,
            'Only Show Selected\nOnly include channels relating to selected objects and data',
            () => ((this.onlySelected = !this.onlySelected), this.refresh(), app.changed('ui')),
          )
        : null,
      this.mode === 'DOPESHEET'
        ? hdrToggle(
            'show-hidden',
            'hide_off',
            this.showHidden,
            'Show Hidden\nInclude channels from objects/bone that are not visible',
            () => ((this.showHidden = !this.showHidden), this.refresh(), app.changed('ui')),
          )
        : null,
      this.snapHeader('keyframes'),
      proportionalHeader('use_proportional_action'),
    );
  }

  private poseMarkerAction(): ActionData | null {
    if (this.mode !== 'ACTION' || !this.showPoseMarkers) return null;
    const id = app.activeObject?.animation_data?.action;
    return id ? (app.doc.actions[id] ?? null) : null;
  }

  markerList() {
    const act = this.poseMarkerAction();
    return act ? (act.pose_markers ??= []) : super.markerList();
  }

  setMarkerList(list: TimelineMarker[]) {
    const act = this.poseMarkerAction();
    if (act) act.pose_markers = list;
    else super.setMarkerList(list);
  }

  protected sidebarTabs(): SidebarTab[] {
    const ob = app.activeObject;
    const act = ob?.animation_data?.action ? app.doc.actions[ob.animation_data.action] : undefined;
    return act ? [{ id: 'action', label: 'Action', draw: () => actionPanel(act) }] : [];
  }

  viewMenu(): MenuItem[] {
    return [
      { label: 'Sidebar', checked: this.showSidebar, shortcut: 'N', action: () => this.toggleSidebar() },
      { separator: true },
      {
        label: 'Show Handles and Interpolation',
        checked: this.showHandlesInterp,
        action: () => ((this.showHandlesInterp = !this.showHandlesInterp), this.draw()),
      },
      {
        label: 'Show Markers',
        checked: this.showMarkers,
        action: () => ((this.showMarkers = !this.showMarkers), this.refresh()),
      },
      ...(this.mode === 'ACTION'
        ? [{ label: 'Show Pose Markers', checked: this.showPoseMarkers, action: () => ((this.showPoseMarkers = !this.showPoseMarkers), this.refresh()) }]
        : []),
      ...viewMenuCommon('action', this),
    ];
  }

  protected footer(): Child | null {
    return playbackFooter();
  }

  // ---------------------------------------------------------------- channels

  protected rowExtra(ch: Channel): Child {
    if (ch.kind !== 'SHAPEKEY' || !ch.shapeKey) return this.valueSlider(ch);
    const sk: ShapeKey = ch.shapeKey;
    return h(
      'span',
      { class: 'anim-ch-slider' },
      numberField({
        id: `sk-${ch.key}`,
        value: sk.value,
        min: sk.slider_min,
        max: sk.slider_max,
        slider: true,
        precision: 3,
        set: (v, final) => {
          sk.value = v;
          app.changed('doc');
          if (final) app.pushUndo('Shape Key Value');
        },
      }),
    );
  }

  protected rowToggles(ch: Channel): Child {
    return this.muteLockToggles(ch);
  }

  channelContextMenu(): MenuItem[] {
    return channelMenu('action');
  }

  protected mainContextMenu(): MenuItem[] {
    return [
      { heading: 'Dope Sheet' },
      { label: 'Copy', op: 'action.copy', shortcut: 'Ctrl C' },
      { label: 'Paste', op: 'action.paste', shortcut: 'Ctrl V' },
      {
        label: 'Paste Flipped',
        op: 'action.paste',
        props: { flipped: true },
        shortcut: 'Shift Ctrl V',
      },
      { separator: true },
      {
        label: 'Keyframe Type',
        submenu: () => keyMenu('action').find((i) => i.label === 'Keyframe Type')!.submenu!(),
      },
      {
        label: 'Handle Type',
        submenu: () => keyMenu('action').find((i) => i.label === 'Handle Type')!.submenu!(),
      },
      {
        label: 'Interpolation Mode',
        submenu: () => keyMenu('action').find((i) => i.label === 'Interpolation Mode')!.submenu!(),
      },
      {
        label: 'Easing Mode',
        submenu: () => keyMenu('action').find((i) => i.label === 'Easing Mode')!.submenu!(),
      },
      { separator: true },
      {
        label: 'Insert Keyframes',
        op: 'action.keyframe_insert',
        shortcut: 'I',
      },
      { label: 'Duplicate', op: 'action.duplicate_move', shortcut: 'Shift D' },
      { label: 'Delete Keyframes', op: 'action.delete', shortcut: 'X' },
      { separator: true },
      {
        label: 'Mirror',
        submenu: () => keyMenu('action').find((i) => i.label === 'Mirror')!.submenu!(),
      },
      {
        label: 'Snap',
        submenu: () => keyMenu('action').find((i) => i.label === 'Snap')!.submenu!(),
      },
    ];
  }

  // ---------------------------------------------------------------- drawing

  protected drawContent(g: CanvasRenderingContext2D, W: number, H: number) {
    const v = this.view;
    const rows = this.list.rows;
    const rh = this.rowH;
    const size = Math.round(rh * 0.62);
    for (let i = 0; i < rows.length; i++) {
      const y = this.rowTop(i);
      if (y > H || y + rh < RULER_H) continue;
      const ch = rows[i];
      g.fillStyle = rowColor(ch);
      g.fillRect(0, y, W, rh - 1);
      if (!ch.curves.length) continue;
      const agg = aggregate(ch.curves.map((r) => r.fc));
      const yc = y + rh / 2;
      const muted = ch.curves.every((r) => r.fc.mute);
      // holds
      for (const s of agg.holds) {
        const x0 = v.fx(s.a),
          x1 = v.fx(s.b);
        if (x1 < 0 || x0 > W) continue;
        g.fillStyle = s.selected ? C.longKeySelected : C.longKey;
        g.fillRect(x0, yc - rh * 0.17, x1 - x0, rh * 0.34);
      }
      if (this.showHandlesInterp)
        for (const s of agg.interps) {
          const x0 = v.fx(s.a),
            x1 = v.fx(s.b);
          if (x1 < 0 || x0 > W) continue;
          g.fillStyle = s.interp === 'LINEAR' ? C.interpLinear : s.interp === 'CONSTANT' ? C.interpConstant : C.interpOther;
          g.globalAlpha = 0.6;
          g.fillRect(x0, yc - 1.5, x1 - x0, 3);
          g.globalAlpha = 1;
        }
      for (const k of agg.keys) {
        const x = v.fx(k.frame);
        if (x < -10 || x > W + 10) continue;
        const shape = this.showHandlesInterp ? shapeFor(k.handle, k.interp) : 'DIAMOND';
        drawKey(g, Math.round(x) + 0.5, Math.round(yc) + 0.5, size, k.type, k.selected, shape, muted ? 0.5 : 1);
      }
    }
  }

  // ---------------------------------------------------------------- picking

  keyAt(x: number, y: number): { ch: Channel; frame: number } | null {
    const i = this.rowAt(y);
    const ch = this.list.rows[i];
    if (!ch || !ch.curves.length) return null;
    let best: number | null = null,
      bd = 8;
    for (const r of ch.curves)
      for (const k of r.fc.keyframe_points) {
        const d = Math.abs(this.view.fx(k.co[0]) - x);
        if (d < bd) {
          bd = d;
          best = k.co[0];
        }
      }
    return best === null ? null : { ch, frame: best };
  }

  private keysAt(ch: Channel, frame: number) {
    const out = [];
    for (const r of ch.curves) for (const k of r.fc.keyframe_points) if (Math.abs(k.co[0] - frame) < 1e-3) out.push(k);
    return out;
  }

  keyHost(): KeyTransformHost {
    return {
      transformCurves: () => this.editCurves(),
      graph: false,
      ppf: () => this.view.ppf,
      ppv: () => 1,
      toDisp: (_fc, v) => v,
      fromDisp: (_fc, d) => d,
      screen: (x) => this.toClient(this.view.fx(x), RULER_H),
      autoSnap: this.autoSnap,
      snapTo: this.snapTo(),
      handlesVisible: () => true,
      proportional: proportionalOf('use_proportional_action'),
    };
  }

  startTransform(mode: KeyTransformMode, start: { x: number; y: number }, releaseConfirm = false, onCancel?: () => void) {
    return startKeyTransform(this.keyHost(), mode, {
      start,
      releaseConfirm,
      redoIdname: 'action.transform',
      onCancel,
    });
  }

  protected mainDown(e: PointerEvent, x: number, y: number) {
    const hit = this.keyAt(x, y);
    const curves = this.list.curves;
    if (e.altKey && (e.ctrlKey || e.metaKey) && hit) {
      // Ctrl+Alt: every key of the channel
      if (!e.shiftKey) selectAll(curves, 'DESELECT');
      for (const r of hit.ch.curves) r.fc.keyframe_points.forEach((k) => setKeySelected(k, true));
      app.pushUndo('Select Channel Keys');
      app.changed('doc');
      return;
    }
    if (e.altKey && hit) {
      selectColumns(curves, [hit.frame], e.shiftKey);
      app.pushUndo('Select Column');
      app.changed('doc');
      return;
    }
    if (hit) {
      const keys = this.keysAt(hit.ch, hit.frame);
      const allSel = keys.every((k) => k.select_control_point);
      if (e.shiftKey) {
        keys.forEach((k) => setKeySelected(k, !allSel));
        app.pushUndo('Select Keyframes');
        app.changed('doc');
        return;
      }
      if (!allSel) {
        selectAll(curves, 'DESELECT');
        keys.forEach((k) => setKeySelected(k, true));
        this.selectKeyChannel(hit.ch);
        app.changed('doc');
      }
      this.clickOrDrag(
        e,
        () => {
          selectAll(curves, 'DESELECT');
          keys.forEach((k) => setKeySelected(k, true));
          this.selectKeyChannel(hit.ch);
          app.pushUndo('Select Keyframes');
          app.changed('doc');
        },
        (start) => {
          if (!allSel) app.pushUndo('Select Keyframes');
          this.startTransform('TIME_TRANSLATE', { x: start.clientX, y: start.clientY }, true);
        },
      );
      return;
    }
    this.clickOrDrag(
      e,
      () => {
        if (!e.shiftKey) {
          selectAll(curves, 'DESELECT');
          app.pushUndo('Deselect Keyframes');
          app.changed('doc');
        }
      },
      (start) => this.boxGesture(start, (r, mode) => this.boxSelect(r, mode)),
    );
  }

  protected onCanvasDown(e: PointerEvent) {
    // Ctrl+right-drag: lasso select (Shift subtracts)
    if (e.button === 2 && (e.ctrlKey || e.metaKey) && this.regionAt(e) === 'main' && !app.modal) {
      e.preventDefault();
      this.clickOrDrag(
        e,
        () => {},
        (start) => lassoGesture(this, start, e.shiftKey ? 'SUB' : 'ADD', true, 'action'),
      );
      return;
    }
    super.onCanvasDown(e);
  }

  private selectKeyChannel(ch: Channel) {
    if (ch.kind !== 'FCURVE' && ch.kind !== 'SHAPEKEY') return;
    this.deselectChannels();
    if (ch.fc) ch.fc.select = true;
  }

  boxSelect(r: { x0: number; y0: number; x1: number; y1: number }, mode: 'SET' | 'ADD' | 'SUB') {
    const curves = this.list.curves;
    if (mode === 'SET') selectAll(curves, 'DESELECT');
    const f0 = this.view.xf(r.x0),
      f1 = this.view.xf(r.x1);
    const i0 = this.rowAt(Math.max(RULER_H, r.y0)),
      i1 = this.rowAt(r.y1);
    for (let i = Math.max(0, i0); i <= i1 && i < this.list.rows.length; i++) {
      for (const ref of this.list.rows[i].curves) for (const k of ref.fc.keyframe_points) if (k.co[0] >= f0 && k.co[0] <= f1) setKeySelected(k, mode !== 'SUB');
    }
    app.pushUndo('Box Select');
    app.changed('doc');
  }

  selectables(): Selectable[] {
    const out: Selectable[] = [];
    const rows = this.list.rows;
    for (let i = 0; i < rows.length; i++) {
      const y = this.rowTop(i) + this.rowH / 2;
      const ch = rows[i];
      const byFrame = new Map<number, { k: Keyframe[] }>();
      for (const r of ch.curves) {
        if (r.fc.lock) continue;
        for (const k of r.fc.keyframe_points) {
          const f = Math.round(k.co[0] * 1000) / 1000;
          let e = byFrame.get(f);
          if (!e) byFrame.set(f, (e = { k: [] }));
          e.k.push(k);
        }
      }
      for (const [f, e] of byFrame)
        out.push({
          x: this.view.fx(f),
          y,
          selected: e.k.every((k) => k.select_control_point),
          set: (v) => e.k.forEach((k) => setKeySelected(k, v)),
        });
    }
    return out;
  }

  viewAll() {
    const b = keyBounds(this.list.curves, false);
    const s = app.doc.scene;
    if (b) this.viewFrameRange(b.x0, b.x1);
    else this.viewFrameRange(s.frame_start, s.frame_end);
  }

  viewSelected() {
    const b = keyBounds(this.list.curves, true);
    if (!b) return this.viewAll();
    this.viewFrameRange(b.x0, b.x1);
    // scroll the first row with a selected key into view
    const i = this.list.rows.findIndex((ch) => ch.curves.some((r) => r.fc.keyframe_points.some((k) => k.select_control_point)));
    if (i >= 0) {
      const top = i * this.rowH;
      const avail = this.contentBottom() - RULER_H;
      if (top < this.scrollY || top > this.scrollY + avail - this.rowH) this.scrollY = Math.max(0, top - avail / 3);
      this.refresh();
    }
  }
}

/** Sidebar panel for the active action: name, fake user and manual frame range. */
function actionPanel(act: ActionData): Child {
  const row = (label: string, c: Child) => h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, label), h('div', { class: 'sr-value' }, c), h('span'));
  const commit = (label: string, final = true) => (app.changed('doc'), final && app.pushUndo(label));
  const manual = !!act.frame_range;
  const [a, b] = actionRange(act);
  return h(
    'div',
    { class: 'anim-sb-panel' },
    h('div', { class: 'anim-sb-title' }, 'Action'),
    row('Name', textField('ds-act-name', act.name, (v) => v && ((act.name = v), commit('Rename Action')))),
    h('div', { class: 'split-row check' }, h('div', { class: 'sr-label' }), h('div', { class: 'sr-value' }, checkbox('ds-act-fake', 'Fake User', !!act.use_fake_user, (v) => ((act.use_fake_user = v), commit('Fake User')))), h('span')),
    h('div', { class: 'split-row check' }, h('div', { class: 'sr-label' }), h('div', { class: 'sr-value' }, checkbox('ds-act-range', 'Manual Frame Range', manual, (v) => ((act.frame_range = v ? [a, b] : undefined), commit('Manual Frame Range')))), h('span')),
    manual
      ? [
          row('Start', numberField({ id: 'ds-act-fs', value: act.frame_range![0], precision: 2, set: (v, f) => ((act.frame_range = [v, Math.max(v + 1, act.frame_range![1])]), commit('Action Frame Range', f)) })),
          row('End', numberField({ id: 'ds-act-fe', value: act.frame_range![1], precision: 2, set: (v, f) => ((act.frame_range = [Math.min(act.frame_range![0], v - 1), v]), commit('Action Frame Range', f)) })),
        ]
      : null,
  );
}

function rowColor(ch: Channel) {
  switch (ch.kind) {
    case 'SUMMARY':
      return C.summary;
    case 'OBJECT':
      return C.objectRow;
    case 'ACTION':
      return C.actionRow;
    case 'GROUP':
      return ch.ob && ch.action ? C.groupRow : C.groupRow;
    default:
      return ch.fc?.select ? C.channelRowSel : C.channelRow;
  }
}

registerEditor({
  id: 'DOPESHEET',
  label: 'Dope Sheet',
  icon: 'action',
  group: 'Animation',
  create: (a, s) => new DopeSheet(a, s),
});
