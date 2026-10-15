// Nonlinear Animation editor: per-object tracks with action strips, the active
// action line, strip selection/transform/duplicate/split/mute and a sidebar.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type ModalHandler, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { registerEditor } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { numberField, enumMenu, checkbox, textField, panel, button } from '../ui/widgets';
import type { AnimData, NlaStrip, NlaTrack, ObjectData } from '../data/types';
import { AnimEditor, RULER_H, menuButton, hdrToggle, markerMenu, overMain, roundRect, type SidebarTab } from './animeditor';
import { activeAction, type Channel, type SpaceKind } from './channels';
import { C, drawKey } from './theme';
import { aggregate } from './aggregate';
import { pushDown, makeStrip, newTrack, stripFits, sortStrips, actionRange, ensureAnimData } from './actionops';
import { browseActions } from './actionui';
import { snapFrameTo } from './transformkeys';
import { moveChannelsMenu, previewRangeMenu } from './menus';

export interface StripRef {
  ob: ObjectData;
  ad: AnimData;
  track: NlaTrack;
  strip: NlaStrip;
}

const stripLen = (s: NlaStrip) => s.frame_end - s.frame_start;
const actionLen = (s: NlaStrip) => Math.max(1e-3, s.action_frame_end - s.action_frame_start);
/** Recompute the strip end from action range, scale and repeat. */
export function updateStripEnd(s: NlaStrip) {
  s.frame_end = s.frame_start + actionLen(s) * Math.max(1e-3, s.scale) * Math.max(0.1, s.repeat);
}
/** Recompute scale from the strip extents. */
export function updateStripScale(s: NlaStrip) {
  s.scale = Math.max(1e-3, stripLen(s) / (actionLen(s) * Math.max(0.1, s.repeat)));
}

const BLEND_ITEMS = [
  { value: 'REPLACE', label: 'Replace' },
  { value: 'COMBINE', label: 'Combine' },
  { value: 'ADD', label: 'Add' },
  { value: 'SUBTRACT', label: 'Subtract' },
  { value: 'MULTIPLY', label: 'Multiply' },
];
const EXTRAP_ITEMS = [
  { value: 'HOLD', label: 'Hold' },
  { value: 'HOLD_FORWARD', label: 'Hold Forward' },
  { value: 'NOTHING', label: 'Nothing' },
];

export class NlaEditor extends AnimEditor {
  keymaps = ['Markers', 'Animation Channels', 'NLA Editor', 'Animation'];
  rowH = 24;
  activeStrip: NlaStrip | null = null;

  space(): SpaceKind {
    return 'NLA';
  }

  /** all strips of the listed objects */
  strips(): StripRef[] {
    const out: StripRef[] = [];
    const seen = new Set<string>();
    for (const ch of this.list.rows) {
      if (ch.kind !== 'OBJECT' || !ch.ob?.animation_data || seen.has(ch.ob.id)) continue;
      seen.add(ch.ob.id);
      const ad = ch.ob.animation_data;
      for (const track of ad.nla_tracks) for (const strip of track.strips) out.push({ ob: ch.ob, ad, track, strip });
    }
    return out;
  }

  selectedStrips(includeLocked = false) {
    return this.strips().filter((s) => s.strip.select && (includeLocked || !s.track.lock));
  }

  activeStripRef(): StripRef | null {
    const all = this.strips();
    return all.find((s) => s.strip === this.activeStrip) ?? all.find((s) => s.strip.select) ?? null;
  }

  header(): Child {
    return h(
      'div',
      { class: 'hdr-row' },
      menuButton('View', () => this.viewMenu()),
      menuButton('Select', () => [
        {
          label: 'All',
          op: 'nla.select_all',
          props: { action: 'SELECT' },
          shortcut: 'A',
        },
        {
          label: 'None',
          op: 'nla.select_all',
          props: { action: 'DESELECT' },
          shortcut: 'Alt A',
        },
        {
          label: 'Invert',
          op: 'nla.select_all',
          props: { action: 'INVERT' },
          shortcut: 'Ctrl I',
        },
        { separator: true },
        { label: 'Box Select', op: 'nla.select_box', shortcut: 'B' },
        { label: 'Box Select (Axis Range)', op: 'nla.select_box', props: { axis_range: true }, shortcut: 'Alt B' },
        { separator: true },
        {
          label: 'Before Current Frame',
          op: 'nla.select_leftright',
          props: { mode: 'LEFT' },
          shortcut: '[',
        },
        {
          label: 'After Current Frame',
          op: 'nla.select_leftright',
          props: { mode: 'RIGHT' },
          shortcut: ']',
        },
      ]),
      menuButton('Marker', markerMenu),
      menuButton('Add', () => this.addMenu()),
      menuButton('Track', () => this.trackMenu()),
      menuButton('Strip', () => this.stripMenu()),
      this.tweaking()
        ? h(
            'button',
            {
              key: 'tweak',
              class: { 'hdr-toggle': true, wide: true, on: true },
              'data-tip': 'Stop Tweaking Strip Actions\nReturn to editing the NLA stack (Tab)',
              onclick: () => app.run('nla.tweakmode_exit', {}, { area: this.area }),
            },
            icon('nla'),
            'Tweaking',
          )
        : null,
      h('div', { class: 'hdr-spacer' }),
      hdrToggle(
        'only-sel',
        'restrict_select_off',
        this.onlySelected,
        'Only Show Selected\nOnly include channels relating to selected objects and data',
        () => ((this.onlySelected = !this.onlySelected), this.refresh(), app.changed('ui')),
      ),
      hdrToggle(
        'show-hidden',
        'hide_off',
        this.showHidden,
        'Show Hidden\nInclude channels from objects/bone that are not visible',
        () => ((this.showHidden = !this.showHidden), this.refresh(), app.changed('ui')),
      ),
      this.snapHeader('strips'),
    );
  }

  tweaking() {
    return this.list.rows.some((r) => r.ob?.animation_data?.tweak);
  }

  addMenu(): MenuItem[] {
    return [
      { label: 'Action', submenu: () => actionClipMenu(), shortcut: 'Shift A' },
      { label: 'Transition', op: 'nla.transition_add', shortcut: 'Shift T' },
      { separator: true },
      { label: 'Selected Objects', op: 'nla.selected_objects_add' },
    ];
  }

  trackMenu(): MenuItem[] {
    return [
      { label: 'Add', op: 'nla.tracks_add', shortcut: 'Shift A' },
      { label: 'Add Above Selected', op: 'nla.tracks_add', props: { above_selected: true }, shortcut: 'Shift Ctrl A' },
      { label: 'Delete', op: 'nla.tracks_delete', shortcut: 'X' },
      { separator: true },
      { label: 'Move', submenu: moveChannelsMenu },
      { separator: true },
      { label: 'Remove Empty Animation Data', op: 'anim.channels_clean_empty' },
    ];
  }

  tweakItems(): MenuItem[] {
    return this.tweaking()
      ? [{ label: 'Stop Tweaking Strip Actions', op: 'nla.tweakmode_exit', shortcut: 'Tab' }]
      : [
          { label: 'Start Editing Stashed Action', op: 'nla.tweakmode_enter', props: { isolate_action: true }, shortcut: 'Shift Tab' },
          { label: 'Start Tweaking Strip Actions (Full Stack)', op: 'nla.tweakmode_enter', props: { use_upper_stack_evaluation: true }, shortcut: 'Tab' },
          { label: 'Start Tweaking Strip Actions (Lower Stack)', op: 'nla.tweakmode_enter', props: { use_upper_stack_evaluation: false } },
        ];
  }

  stripMenu(): MenuItem[] {
    return [
      {
        label: 'Transform',
        submenu: () => [
          { label: 'Move', op: 'nla.transform', props: { mode: 'TRANSLATION' }, shortcut: 'G' },
          { label: 'Scale', op: 'nla.transform', props: { mode: 'RESIZE' }, shortcut: 'S' },
          { separator: true },
          { label: 'Swap', op: 'nla.swap', shortcut: 'Alt F' },
          { separator: true },
          { label: 'Move Up', op: 'nla.move_up', shortcut: 'Page Up' },
          { label: 'Move Down', op: 'nla.move_down', shortcut: 'Page Down' },
        ],
      },
      { label: 'Snap', submenu: snapItems, shortcut: 'Shift S' },
      { separator: true },
      { label: 'Split', op: 'nla.split', shortcut: 'Y' },
      { separator: true },
      { label: 'Duplicate', op: 'nla.duplicate_move', shortcut: 'Alt D' },
      { label: 'Linked Duplicate', op: 'nla.duplicate_linked_move', shortcut: 'Shift D' },
      { label: 'Delete', op: 'nla.delete', shortcut: 'X' },
      { separator: true },
      { label: 'Make Meta', op: 'nla.meta_add', shortcut: 'Ctrl G' },
      { label: 'Remove Meta', op: 'nla.meta_remove', shortcut: 'Ctrl Alt G' },
      { separator: true },
      { label: 'Toggle Muting', op: 'nla.mute_toggle', shortcut: 'H' },
      { separator: true },
      { label: 'Bake Action', op: 'nla.bake' },
      { separator: true },
      { label: 'Apply Scale', op: 'nla.apply_scale', shortcut: 'Ctrl A' },
      { label: 'Clear Scale', op: 'nla.clear_scale', shortcut: 'Alt S' },
      { label: 'Sync Action Length', op: 'nla.action_sync_length' },
      { separator: true },
      { label: 'Make Single User', op: 'nla.make_single_user', shortcut: 'U' },
      { separator: true },
      ...this.tweakItems(),
    ];
  }

  viewMenu(): MenuItem[] {
    return [
      {
        label: 'Sidebar',
        checked: this.showSidebar,
        shortcut: 'N',
        action: () => this.toggleSidebar(),
      },
      {
        label: 'Show Markers',
        checked: this.showMarkers,
        action: () => ((this.showMarkers = !this.showMarkers), this.refresh()),
      },
      { label: 'Show Seconds', checked: this.showSeconds, op: 'anim.show_seconds_toggle', shortcut: 'Ctrl T' },
      { separator: true },
      {
        label: 'Frame Selected',
        op: 'nla.view_selected',
        shortcut: 'Numpad .',
      },
      { label: 'Frame All', op: 'nla.view_all', shortcut: 'Home' },
      { label: 'Frame Scene Range', op: 'anim.scene_range_frame' },
      {
        label: 'Go to Current Frame',
        op: 'nla.view_frame',
        shortcut: 'Numpad 0',
      },
      { separator: true },
      ...previewRangeMenu('nla.previewrange_set'),
      { separator: true },
      {
        label: this.area.screen.maximized === this.area ? 'Back to Previous' : 'Maximize Area',
        op: 'screen.screen_full_area',
        shortcut: 'Ctrl Space',
      },
    ];
  }

  // ---------------------------------------------------------------- channels

  protected rowToggles(ch: Channel): Child {
    if (ch.kind === 'NLA_TRACK' && ch.track && ch.ob) {
      const t = ch.track,
        ad = ch.ob.animation_data!;
      return [
        h(
          'button',
          {
            key: 'mute',
            class: { 'anim-tg': true, off: t.mute },
            'data-tip': 'Mute\nDisable NLA Track evaluation',
            onpointerdown: (e: PointerEvent) => (e.stopPropagation(), e.button === 0 && ((t.mute = !t.mute), app.pushUndo('Toggle Track Mute'), app.changed('doc'))),
          },
          icon(t.mute ? 'checkbox_dehlt' : 'checkbox_hlt'),
        ),
        h(
          'button',
          {
            key: 'lock',
            class: { 'anim-tg': true, on: !!t.lock },
            'data-tip': 'Lock\nNLA Track is locked',
            onpointerdown: (e: PointerEvent) => (e.stopPropagation(), e.button === 0 && ((t.lock = !t.lock), app.pushUndo('Toggle Track Lock'), app.changed('doc'))),
          },
          icon(t.lock ? 'locked' : 'unlocked'),
        ),
        h(
          'button',
          {
            key: 'solo',
            class: { 'anim-tg': true, on: t.is_solo, solo: true },
            'data-tip': 'Solo\nNLA Track is evaluated itself (i.e. active Action and all other NLA Tracks in the same AnimData block are disabled)',
            onpointerdown: (e: PointerEvent) => {
              e.stopPropagation();
              if (e.button !== 0) return;
              const was = t.is_solo;
              for (const o of ad.nla_tracks) o.is_solo = false;
              t.is_solo = !was;
              app.pushUndo('Toggle Solo');
              app.changed('doc');
            },
          },
          icon(t.is_solo ? 'solo_on' : 'solo_off'),
        ),
      ];
    }
    if (ch.kind === 'NLA_ACTION' && ch.ob) {
      const ob = ch.ob;
      if (ob.animation_data?.tweak) return null;
      return ch.action
        ? h(
            'button',
            {
              key: 'push',
              class: 'anim-tg',
              'data-tip': 'Push Down Action\nPush action down onto the top of the NLA stack as a new strip',
              onpointerdown: (e: PointerEvent) => (e.stopPropagation(), e.button === 0 && app.run('nla.action_pushdown', { object: ob.id })),
            },
            icon('nla'),
          )
        : h(
            'button',
            {
              key: 'browse',
              class: 'anim-tg',
              'data-tip': 'Browse Action\nAssign an action to the action line',
              onpointerdown: (e: PointerEvent) => (e.stopPropagation(), e.button === 0 && browseActions(ob, { x: e.clientX, y: e.clientY })),
            },
            icon('action'),
          );
    }
    return null;
  }

  clickChannel(ch: Channel, extend: boolean) {
    super.clickChannel(ch, extend);
    if (ch.kind === 'NLA_ACTION' && ch.ob && ch.action) {
      // clicking the action line makes its object active (for the Edited Action panel)
      app.activeObject = ch.ob;
      app.changed('select');
      this.sidebarTab = 'action';
    }
  }

  channelContextMenu(): MenuItem[] {
    return [
      { label: 'Track Ordering', submenu: moveChannelsMenu },
      { separator: true },
      { label: 'Add Track', op: 'nla.tracks_add' },
      { label: 'Add Track Above Selected', op: 'nla.tracks_add', props: { above_selected: true } },
      { separator: true },
      { label: 'Delete Tracks', op: 'nla.tracks_delete' },
      { label: 'Remove Empty Animation Data', op: 'anim.channels_clean_empty' },
    ];
  }

  protected mainContextMenu(): MenuItem[] {
    return [
      { heading: 'NLA' },
      ...this.tweakItems(),
      { separator: true },
      { label: 'Duplicate', op: 'nla.duplicate_move', shortcut: 'Alt D' },
      { label: 'Linked Duplicate', op: 'nla.duplicate_linked_move', shortcut: 'Shift D' },
      { separator: true },
      { label: 'Split', op: 'nla.split', shortcut: 'Y' },
      { label: 'Delete', op: 'nla.delete', shortcut: 'X' },
      { separator: true },
      { label: 'Make Meta', op: 'nla.meta_add', shortcut: 'Ctrl G' },
      { label: 'Remove Meta', op: 'nla.meta_remove', shortcut: 'Ctrl Alt G' },
      { separator: true },
      { label: 'Swap', op: 'nla.swap', shortcut: 'Alt F' },
      { separator: true },
      { label: 'Snap', submenu: snapItems },
    ];
  }

  // ---------------------------------------------------------------- drawing

  protected drawContent(g: CanvasRenderingContext2D, W: number, H: number) {
    const v = this.view;
    const rows = this.list.rows;
    const rh = this.rowH;
    g.font = '11px Inter, system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let i = 0; i < rows.length; i++) {
      const y = this.rowTop(i);
      if (y > H || y + rh < RULER_H) continue;
      const ch = rows[i];
      if (ch.kind === 'OBJECT') {
        g.fillStyle = C.objectRow;
        g.fillRect(0, y, W, rh - 1);
      } else if (ch.kind === 'NLA_ACTION') {
        g.fillStyle = ch.action ? C.nlaActionLine : C.nlaActionLineUnset;
        g.fillRect(0, y, W, rh - 1);
        if (ch.action) {
          const [a, b] = actionRange(ch.action);
          g.fillStyle = 'rgba(255,255,255,0.06)';
          g.fillRect(v.fx(a), y + 2, v.fx(b) - v.fx(a), rh - 5);
          const agg = aggregate(ch.action.fcurves);
          for (const k of agg.keys) {
            const x = v.fx(k.frame);
            if (x < -10 || x > W + 10) continue;
            drawKey(g, Math.round(x) + 0.5, Math.round(y + rh / 2) + 0.5, 9, k.type, false, 'DIAMOND', 0.85);
          }
        }
      } else if (ch.kind === 'NLA_TRACK' && ch.track && ch.ob) {
        const t = ch.track;
        g.fillStyle = t.select ? C.nlaTrackSel : 'rgba(0,0,0,0.12)';
        g.fillRect(0, y, W, rh - 1);
        const ad = ch.ob.animation_data!;
        const soloed = ad.nla_tracks.some((o) => o.is_solo) && !t.is_solo;
        const tw = ad.tweak;
        const tweakStrip = tw ? ad.nla_tracks[tw.track]?.strips[tw.strip] : null;
        // in tweak mode the tracks above the edited one are dimmed unless the full stack is evaluated
        const dim = t.mute || soloed || (!!tw && (ch.trackIndex ?? 0) > tw.track && !tw.upper);
        t.strips.forEach((s, si) => this.drawStrip(g, s, y, rh, dim, t.strips[si + 1], si === 0 && ch.trackIndex === 0, W, s === tweakStrip));
      }
    }
    g.textBaseline = 'alphabetic';
  }

  private drawStrip(g: CanvasRenderingContext2D, s: NlaStrip, y: number, rh: number, dim: boolean, next: NlaStrip | undefined, first: boolean, W: number, tweaked = false) {
    const v = this.view;
    const x0 = v.fx(s.frame_start),
      x1 = v.fx(s.frame_end);
    const top = y + 2,
      hh = rh - 5;
    // extrapolation (hold) regions
    if (!s.mute && s.extrapolation !== 'NOTHING') {
      g.fillStyle = s.select ? 'rgba(255,140,0,0.12)' : 'rgba(255,255,255,0.05)';
      if (s.extrapolation === 'HOLD' && first) g.fillRect(0, top, Math.max(0, x0), hh);
      const endX = next ? v.fx(next.frame_start) : W;
      if (endX > x1) g.fillRect(x1, top, endX - x1, hh);
    }
    if (x1 < 0 || x0 > W) return;
    g.globalAlpha = dim || s.mute ? 0.45 : 1;
    roundRect(g, x0, top, Math.max(2, x1 - x0), hh, 3);
    const base = s.type === 'TRANSITION' ? ['#3c5a78', '#6fa0d8'] : s.type === 'META' ? ['#5a4470', '#a070d0'] : tweaked ? ['#3f7040', '#5fc060'] : ['#594a3a', C.nlaStripSelected];
    g.fillStyle = s.select ? base[1] : base[0];
    g.fill();
    if (s.type === 'TRANSITION') {
      // a diagonal shows the blend from one strip to the next
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.beginPath();
      g.moveTo(x0, top + hh);
      g.lineTo(x1, top);
      g.stroke();
    } else if (s.type === 'META' && s.strips) {
      // inner strip boundaries
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      const k = (s.frame_end - s.frame_start) / Math.max(1e-6, s.action_frame_end - s.action_frame_start);
      for (const c of s.strips.slice(1)) {
        const x = Math.round(v.fx(s.frame_start + (c.frame_start - s.action_frame_start) * k)) + 0.5;
        g.beginPath();
        g.moveTo(x, top + 2);
        g.lineTo(x, top + hh - 2);
        g.stroke();
      }
    }
    g.strokeStyle = s === this.activeStrip ? '#ffffff' : '#000';
    if (s.mute) g.setLineDash([4, 3]);
    g.lineWidth = 1;
    g.stroke();
    g.setLineDash([]);
    // blend in/out ramps
    g.strokeStyle = s.select ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.55)';
    if (s.blend_in > 0) {
      g.beginPath();
      g.moveTo(x0, top + hh);
      g.lineTo(v.fx(s.frame_start + s.blend_in), top);
      g.stroke();
    }
    if (s.blend_out > 0) {
      g.beginPath();
      g.moveTo(v.fx(s.frame_end - s.blend_out), top);
      g.lineTo(x1, top + hh);
      g.stroke();
    }
    // repeat boundaries
    if (s.repeat > 1) {
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      const per = stripLen(s) / s.repeat;
      for (let r = 1; r < s.repeat; r++) {
        const x = Math.round(v.fx(s.frame_start + per * r)) + 0.5;
        g.beginPath();
        g.moveTo(x, top + 2);
        g.lineTo(x, top + hh - 2);
        g.stroke();
      }
    }
    // name
    g.save();
    g.beginPath();
    g.rect(x0 + 2, top, Math.max(0, x1 - x0 - 4), hh);
    g.clip();
    g.fillStyle = s.select ? '#ffffff' : '#e6e6e6';
    g.textAlign = 'left';
    g.fillText(s.name, Math.max(x0, 0) + 5, top + hh / 2 + 1);
    g.restore();
    g.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- picking

  stripAt(x: number, y: number): StripRef | null {
    const ch = this.list.rows[this.rowAt(y)];
    if (!ch || ch.kind !== 'NLA_TRACK' || !ch.track || !ch.ob) return null;
    const f = this.view.xf(x);
    const s = ch.track.strips.find((st) => f >= st.frame_start - 2 / this.view.ppf && f <= st.frame_end + 2 / this.view.ppf);
    return s ? { ob: ch.ob, ad: ch.ob.animation_data!, track: ch.track, strip: s } : null;
  }

  deselectStrips() {
    for (const s of this.strips()) s.strip.select = false;
  }

  protected mainDown(e: PointerEvent, x: number, y: number) {
    const hit = this.stripAt(x, y);
    if (hit) {
      const was = !!hit.strip.select;
      if (e.shiftKey) {
        hit.strip.select = !was;
        if (!was) this.activeStrip = hit.strip;
        app.pushUndo('Select Strip');
        app.changed('doc');
        return;
      }
      if (!was) {
        this.deselectStrips();
        hit.strip.select = true;
      }
      this.activeStrip = hit.strip;
      for (const t of hit.ad.nla_tracks) t.select = t === hit.track;
      app.changed('doc');
      this.clickOrDrag(
        e,
        () => {
          this.deselectStrips();
          hit.strip.select = true;
          app.pushUndo('Select Strip');
          app.changed('doc');
        },
        (start) => {
          if (!was) app.pushUndo('Select Strip');
          this.startTransform('TRANSLATION', { x: start.clientX, y: start.clientY }, true);
        },
      );
      return;
    }
    this.clickOrDrag(
      e,
      () => {
        if (!e.shiftKey) {
          this.deselectStrips();
          app.pushUndo('Deselect Strips');
          app.changed('doc');
        }
      },
      (start) => this.boxGesture(start, (r, mode) => this.boxSelect(r, mode)),
    );
  }

  boxSelect(r: { x0: number; y0: number; x1: number; y1: number }, mode: 'SET' | 'ADD' | 'SUB') {
    if (mode === 'SET') this.deselectStrips();
    const f0 = this.view.xf(r.x0),
      f1 = this.view.xf(r.x1);
    const i0 = this.rowAt(Math.max(RULER_H, r.y0)),
      i1 = this.rowAt(r.y1);
    for (let i = Math.max(0, i0); i <= i1 && i < this.list.rows.length; i++) {
      const t = this.list.rows[i].track;
      if (!t) continue;
      for (const s of t.strips) if (s.frame_end >= f0 && s.frame_start <= f1) s.select = mode !== 'SUB';
    }
    app.pushUndo('Box Select');
    app.changed('doc');
  }

  /** Interactive move (TRANSLATION) or scale (RESIZE) of the selected strips. */
  startTransform(mode: 'TRANSLATION' | 'RESIZE', start: { x: number; y: number }, releaseConfirm = false, onCancel?: () => void): boolean {
    const sel = this.selectedStrips();
    if (!sel.length) return false;
    const orig = sel.map((r) => ({
      s: r.strip,
      a: r.strip.frame_start,
      b: r.strip.frame_end,
      scale: r.strip.scale,
    }));
    const cfra = app.doc.scene.frame_current;
    const pivotX = this.toClient(this.view.fx(cfra), 0).x;
    let snapToggle = false;
    let numeric = '';
    let value = mode === 'RESIZE' ? 1 : 0;
    const apply = (mx: number) => {
      const snap = this.autoSnap !== snapToggle;
      const num = numeric && numeric !== '-' ? Number(numeric) : NaN;
      if (mode === 'TRANSLATION') {
        let d = Number.isFinite(num) ? num : (mx - start.x) / this.view.ppf;
        const st = this.snapTo();
        const perStrip = snap && !Number.isFinite(num) && (st.absolute || st.mode === 'MARKER');
        if (snap && !Number.isFinite(num) && !perStrip) d = st.mode === 'SECOND' ? Math.round(d / st.fps) * st.fps : Math.round(d);
        value = d;
        for (const o of orig) {
          // absolute snapping moves each strip's start onto the snap target
          const dd = perStrip ? snapFrameTo(o.a + d, st) - o.a : d;
          o.s.frame_start = o.a + dd;
          o.s.frame_end = o.b + dd;
        }
      } else {
        const d0 = start.x - pivotX;
        let f = Number.isFinite(num) ? num : Math.abs(d0) < 1 ? 1 : (mx - pivotX) / d0;
        if (!(f > 0.001)) f = 0.001;
        value = f;
        for (const o of orig) {
          let a = cfra + (o.a - cfra) * f,
            b = cfra + (o.b - cfra) * f;
          if (snap) {
            a = Math.round(a);
            b = Math.max(a + 1, Math.round(b));
          }
          o.s.frame_start = a;
          o.s.frame_end = b;
          updateStripScale(o.s);
        }
      }
      app.changed('doc');
    };
    let lastX = start.x;
    const handler: ModalHandler = {
      label: mode === 'TRANSLATION' ? 'Move' : 'Scale',
      cursor: 'ew-resize',
      header: () => (mode === 'TRANSLATION' ? `Delta: ${value.toFixed(2)}` : `Scale: ${value.toFixed(3)}`) + (numeric ? ` [${numeric}|]` : ''),
      status: () => [
        ['LMB', 'Confirm'],
        ['RMB/Esc', 'Cancel'],
        ['Ctrl', 'Toggle Snap'],
      ],
      onPointerMove: (e) => {
        snapToggle = e.ctrlKey || e.metaKey;
        lastX = e.clientX;
        apply(lastX);
      },
      onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
      onPointerUp: (e) => (releaseConfirm && e.button === 0 ? 'FINISHED' : undefined),
      onKey: (e) => {
        if (e.key === 'Escape') return 'CANCELLED';
        if (e.key === 'Enter') return 'FINISHED';
        if (e.type !== 'keydown') return true;
        if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !numeric)) numeric += e.key;
        else if (e.key === 'Backspace') numeric = numeric.slice(0, -1);
        apply(lastX);
        return true;
      },
      cancel: () => {
        for (const o of orig) {
          o.s.frame_start = o.a;
          o.s.frame_end = o.b;
          o.s.scale = o.scale;
        }
        onCancel?.();
      },
      finish: () => {
        resolveOverlaps(sel);
        handler.redoOp = { idname: 'nla.transform', props: { mode, value } };
      },
    };
    app.startModal(handler);
    return true;
  }

  viewAll() {
    let a = Infinity,
      b = -Infinity;
    for (const r of this.strips()) {
      a = Math.min(a, r.strip.frame_start);
      b = Math.max(b, r.strip.frame_end);
    }
    for (const ch of this.list.rows)
      if (ch.kind === 'NLA_ACTION' && ch.action) {
        const [x, y] = actionRange(ch.action);
        a = Math.min(a, x);
        b = Math.max(b, y);
      }
    const s = app.doc.scene;
    if (a === Infinity) this.viewFrameRange(s.frame_start, s.frame_end);
    else this.viewFrameRange(a, b);
  }

  viewSelected() {
    const sel = this.selectedStrips(true);
    if (!sel.length) return this.viewAll();
    this.viewFrameRange(Math.min(...sel.map((r) => r.strip.frame_start)), Math.max(...sel.map((r) => r.strip.frame_end)));
  }

  // ---------------------------------------------------------------- sidebar

  protected sidebarTabs(): SidebarTab[] {
    return [
      { id: 'strip', label: 'Strip', draw: () => this.stripTab() },
      { id: 'action', label: 'Edited Action', draw: () => this.actionTab() },
    ];
  }

  private stripTab(): Child {
    const ref = this.activeStripRef();
    if (!ref) return h('div', { class: 'sb-empty' }, 'No active strip');
    const s = ref.strip;
    const commit = (label: string, f = true) => {
      app.changed('doc');
      if (f) app.pushUndo(label);
    };
    const row = (label: string, c: Child) => h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, label), h('div', { class: 'sr-value' }, c), h('span', { class: 'decorator-space' }));
    const act = app.doc.actions[s.action];
    return [
      panel('nla-strip', 'Active Strip', () => [
        row(
          'Name',
          textField('nla-name', s.name, (v) => v.trim() && ((s.name = v.trim()), commit('Rename Strip'))),
        ),
        row(
          'Extrapolation',
          enumMenu('nla-extrap', EXTRAP_ITEMS, s.extrapolation, (v) => ((s.extrapolation = v as NlaStrip['extrapolation']), commit('Change Extrapolation'))),
        ),
        row(
          'Blending',
          enumMenu('nla-blend', BLEND_ITEMS, s.blend_type, (v) => ((s.blend_type = v as NlaStrip['blend_type']), commit('Change Blending'))),
        ),
        row(
          'Blend In',
          numberField({
            id: 'nla-bin',
            value: s.blend_in,
            min: 0,
            max: stripLen(s) - s.blend_out,
            step: 1,
            precision: 2,
            set: (v, f) => ((s.blend_in = Math.max(0, Math.min(v, stripLen(s) - s.blend_out))), commit('Change Blend In', f)),
          }),
        ),
        row(
          'Out',
          numberField({
            id: 'nla-bout',
            value: s.blend_out,
            min: 0,
            max: stripLen(s) - s.blend_in,
            step: 1,
            precision: 2,
            set: (v, f) => ((s.blend_out = Math.max(0, Math.min(v, stripLen(s) - s.blend_in))), commit('Change Blend Out', f)),
          }),
        ),
        h(
          'div',
          { class: 'split-row check' },
          h('div', { class: 'sr-label' }),
          h(
            'div',
            { class: 'sr-value' },
            checkbox('nla-mute', 'Mute', s.mute, (v) => ((s.mute = v), commit('Toggle Strip Mute'))),
          ),
          h('span'),
        ),
        h('div', { class: 'anim-sb-gap' }),
        row(
          'Frame Start',
          numberField({
            id: 'nla-fs',
            value: s.frame_start,
            precision: 2,
            set: (v, f) => {
              const len = stripLen(s);
              s.frame_start = v;
              s.frame_end = v + len;
              commit('Change Frame Start', f);
              if (f) resolveOverlaps([ref]);
            },
          }),
        ),
        row(
          'End',
          numberField({
            id: 'nla-fe',
            value: s.frame_end,
            precision: 2,
            min: s.frame_start + 0.01,
            set: (v, f) => {
              s.frame_end = Math.max(s.frame_start + 0.01, v);
              updateStripScale(s);
              commit('Change Frame End', f);
            },
          }),
        ),
      ]),
      s.type === 'TRANSITION' || s.type === 'META' ? null : panel('nla-clip', 'Action Clip', () => [
        row(
          'Action',
          h(
            'button',
            {
              class: 'enum-menu',
              onpointerdown: (e: PointerEvent) => (
                e.preventDefault(),
                browseActions(ref.ob, e.currentTarget as HTMLElement, (id) => {
                  s.action = id;
                  const a = app.doc.actions[id];
                  if (a) {
                    [s.action_frame_start, s.action_frame_end] = actionRange(a);
                    updateStripEnd(s);
                  }
                  commit('Change Strip Action');
                })
              ),
            },
            icon('action'),
            h('span', { class: 'em-label' }, act?.name ?? '(missing)'),
            h('span', { class: 'em-arrow' }, icon('down_arrow_hlt')),
          ),
        ),
        row(
          'Frame Start',
          numberField({
            id: 'nla-afs',
            value: s.action_frame_start,
            precision: 2,
            set: (v, f) => ((s.action_frame_start = Math.min(v, s.action_frame_end - 0.01)), updateStripEnd(s), commit('Change Action Start', f)),
          }),
        ),
        row(
          'End',
          numberField({
            id: 'nla-afe',
            value: s.action_frame_end,
            precision: 2,
            set: (v, f) => ((s.action_frame_end = Math.max(v, s.action_frame_start + 0.01)), updateStripEnd(s), commit('Change Action End', f)),
          }),
        ),
        h(
          'div',
          { class: 'anim-sb-btns' },
          button('nla-sync', 'Sync Length', () => app.run('nla.action_sync_length', {}, { area: this.area }), {
            tip: 'Sync Action Length\nUpdate action extents to match the keyframes of the action',
          }),
        ),
        row(
          'Playback Scale',
          numberField({
            id: 'nla-scale',
            value: s.scale,
            min: 0.0001,
            step: 0.1,
            precision: 3,
            set: (v, f) => ((s.scale = Math.max(0.0001, v)), updateStripEnd(s), commit('Change Scale', f)),
          }),
        ),
        row(
          'Repeat',
          numberField({
            id: 'nla-repeat',
            value: s.repeat,
            min: 0.1,
            step: 0.1,
            precision: 3,
            set: (v, f) => ((s.repeat = Math.max(0.1, v)), updateStripEnd(s), commit('Change Repeat', f)),
          }),
        ),
      ]),
      panel(
        'nla-infl',
        'Animated Influence',
        () =>
          row(
            'Influence',
            numberField({
              id: 'nla-influence',
              value: s.influence ?? 1,
              min: 0,
              max: 1,
              slider: true,
              disabled: s.influence === undefined,
              set: (v, f) => ((s.influence = v), commit('Change Influence', f)),
            }),
          ),
        {
          header: checkbox('nla-use-infl', '', s.influence !== undefined, (v) => ((s.influence = v ? 1 : undefined), commit('Toggle Animated Influence'))),
        },
      ),
    ];
  }

  private actionTab(): Child {
    const ob = app.activeObject;
    if (!ob) return h('div', { class: 'sb-empty' }, 'No active object');
    const ad = ob.animation_data;
    const act = activeAction(app.doc, ob);
    const row = (label: string, c: Child) => h('div', { class: 'split-row' }, h('div', { class: 'sr-label' }, label), h('div', { class: 'sr-value' }, c), h('span', { class: 'decorator-space' }));
    return panel('nla-edited', 'Animation Data', () => [
      row(
        'Action',
        h(
          'button',
          {
            class: 'enum-menu',
            onpointerdown: (e: PointerEvent) => (e.preventDefault(), browseActions(ob, e.currentTarget as HTMLElement)),
          },
          icon('action'),
          h('span', { class: 'em-label' }, act?.name ?? 'None'),
          h('span', { class: 'em-arrow' }, icon('down_arrow_hlt')),
        ),
      ),
      h(
        'div',
        { class: 'anim-sb-btns' },
        button('nla-new-act', act ? 'New (Copy)' : 'New', () => app.run('action.new')),
        act ? button('nla-unlink', 'Unlink', () => app.run('action.unlink')) : null,
      ),
      ad
        ? [
            row(
              'Blending',
              enumMenu(
                'nla-ad-blend',
                BLEND_ITEMS,
                ad.action_blend_type ?? 'REPLACE',
                (v) => ((ad.action_blend_type = v as NlaStrip['blend_type']), app.pushUndo('Change Blending'), app.changed('doc')),
              ),
            ),
            row(
              'Influence',
              numberField({
                id: 'nla-ad-infl',
                value: ad.action_influence ?? 1,
                min: 0,
                max: 1,
                slider: true,
                set: (v, f) => ((ad.action_influence = v), app.changed('doc'), f && app.pushUndo('Change Influence')),
              }),
            ),
          ]
        : null,
    ]);
  }
}

/** Strips that overlap others in their track move to the track above (created when needed). */
export function resolveOverlaps(refs: StripRef[]) {
  for (const r of refs) {
    const { ad, strip } = r;
    let track = ad.nla_tracks.find((t) => t.strips.includes(strip));
    if (!track) continue;
    sortStrips(track);
    if (stripFits(track, strip.frame_start, strip.frame_end, strip)) continue;
    track.strips = track.strips.filter((s) => s !== strip);
    let idx = ad.nla_tracks.indexOf(track) + 1;
    while (idx < ad.nla_tracks.length && (ad.nla_tracks[idx].lock || !stripFits(ad.nla_tracks[idx], strip.frame_start, strip.frame_end))) idx++;
    if (idx >= ad.nla_tracks.length) {
      track = newTrack(ad);
      ad.nla_tracks.push(track);
    } else track = ad.nla_tracks[idx];
    track.strips.push(strip);
    sortStrips(track);
  }
}

function snapItems(): MenuItem[] {
  return [
    { label: 'Selection to Current Frame', op: 'nla.snap', props: { type: 'CFRA' } },
    { label: 'Selection to Nearest Frame', op: 'nla.snap', props: { type: 'NEAREST_FRAME' } },
    { label: 'Selection to Nearest Second', op: 'nla.snap', props: { type: 'NEAREST_SECOND' } },
    { label: 'Selection to Nearest Marker', op: 'nla.snap', props: { type: 'NEAREST_MARKER' } },
  ];
}

function actionClipMenu(): MenuItem[] {
  const acts = Object.values(app.doc.actions).sort((a, b) => a.name.localeCompare(b.name));
  if (!acts.length) return [{ label: 'No actions available', disabled: true }];
  return acts.map((a) => ({
    label: a.name,
    icon: 'action',
    op: 'nla.actionclip_add',
    props: { action: a.id },
  }));
}

// ---------------------------------------------------------------------------
// Operators

function nlaEd(ctx: OpContext): NlaEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof NlaEditor ? ed : null;
}
const poll = (ctx: OpContext) => !!nlaEd(ctx);
const pollSel = (ctx: OpContext) => !!nlaEd(ctx)?.selectedStrips().length;

registerOperators([
  {
    idname: 'nla.select_all',
    label: '(De)select All',
    description: 'Select or deselect all NLA-Strips',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['TOGGLE', 'Toggle'],
          ['SELECT', 'Select'],
          ['DESELECT', 'Deselect'],
          ['INVERT', 'Invert'],
        ],
      },
    ],
    poll,
    exec: (ctx, p) => {
      const all = nlaEd(ctx)!.strips();
      let a = p.action as string;
      if (a === 'TOGGLE') a = all.some((r) => r.strip.select) ? 'DESELECT' : 'SELECT';
      for (const r of all) r.strip.select = a === 'SELECT' ? true : a === 'DESELECT' ? false : !r.strip.select;
    },
  },
  {
    idname: 'nla.select_box',
    label: 'Box Select',
    description: 'Use box selection to grab NLA-Strips',
    props: [{ id: 'axis_range', label: 'Axis Range', type: 'bool', default: false }],
    poll,
    undo: false,
    invoke: (ctx, p) => {
      const ed = nlaEd(ctx)!;
      app.startModal({
        label: 'Box Select',
        cursor: 'crosshair',
        onPointerDown: (e) => {
          if (e.button === 0) ed.boxGesture(e, (r, mode) => ed.boxSelect(p.axis_range ? { ...r, y0: RULER_H, y1: 1e6 } : r, mode === 'SET' ? 'ADD' : 'SUB'));
          return 'CANCELLED';
        },
        onKey: (e) => (e.key === 'Escape' ? 'CANCELLED' : true),
        cancel: () => {},
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'nla.select_leftright',
    label: 'Select Left/Right',
    description: 'Select strips to the left or the right of the current frame',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'LEFT',
        items: [
          ['LEFT', 'Before Current Frame'],
          ['RIGHT', 'After Current Frame'],
        ],
      },
      { id: 'extend', label: 'Extend Select', type: 'bool', default: false },
    ],
    poll,
    exec: (ctx, p) => {
      const f = ctx.doc.scene.frame_current;
      for (const r of nlaEd(ctx)!.strips()) {
        const hit = p.mode === 'LEFT' ? r.strip.frame_start <= f : r.strip.frame_end >= f;
        if (hit) r.strip.select = true;
        else if (!p.extend) r.strip.select = false;
      }
    },
  },
  {
    idname: 'nla.transform',
    label: 'Transform Strips',
    description: 'Move or scale the selected strips',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'TRANSLATION',
        items: [
          ['TRANSLATION', 'Move'],
          ['RESIZE', 'Scale'],
        ],
      },
      { id: 'value', label: 'Value', type: 'float', default: 0 },
    ],
    poll: pollSel,
    invoke: (ctx, p) => (nlaEd(ctx)!.startTransform(p.mode as 'TRANSLATION', { ...app.pointer }) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (ctx, p) => {
      const ed = nlaEd(ctx)!;
      const sel = ed.selectedStrips();
      const v = p.value as number;
      const c = ctx.doc.scene.frame_current;
      for (const r of sel) {
        if (p.mode === 'TRANSLATION') {
          r.strip.frame_start += v;
          r.strip.frame_end += v;
        } else if (v > 0) {
          r.strip.frame_start = c + (r.strip.frame_start - c) * v;
          r.strip.frame_end = c + (r.strip.frame_end - c) * v;
          updateStripScale(r.strip);
        }
      }
      resolveOverlaps(sel);
    },
  },
  {
    idname: 'nla.delete',
    label: 'Delete Strips',
    description: 'Delete selected strips',
    poll: pollSel,
    exec: (ctx) => {
      for (const r of nlaEd(ctx)!.selectedStrips()) r.track.strips = r.track.strips.filter((s) => s !== r.strip);
    },
  },
  {
    idname: 'nla.mute_toggle',
    label: 'Toggle Muting',
    description: 'Mute or un-mute selected strips',
    poll: pollSel,
    exec: (ctx) => {
      for (const r of nlaEd(ctx)!.selectedStrips()) r.strip.mute = !r.strip.mute;
    },
  },
  {
    idname: 'nla.split',
    label: 'Split Strips',
    description: 'Split selected strips at the current frame',
    poll: pollSel,
    exec: (ctx) => {
      const f = ctx.doc.scene.frame_current;
      let n = 0;
      let repeated = 0;
      for (const r of nlaEd(ctx)!.selectedStrips()) {
        const s = r.strip;
        if (f <= s.frame_start || f >= s.frame_end) continue;
        if (Math.abs(s.repeat - 1) > 1e-6) {
          repeated++;
          continue;
        }
        const t = (f - s.frame_start) / stripLen(s);
        const actSplit = s.action_frame_start + actionLen(s) * t;
        const b: NlaStrip = {
          ...s,
          frame_start: f,
          action_frame_start: actSplit,
          blend_in: 0,
          extrapolation: 'HOLD_FORWARD',
        };
        s.frame_end = f;
        s.blend_out = 0;
        s.action_frame_end = actSplit;
        r.track.strips.push(b);
        sortStrips(r.track);
        n++;
      }
      if (repeated) app.report('WARNING', 'Strips with repeats cannot be split; clear the repeat first');
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'nla.actionclip_add',
    label: 'Add Action Strip',
    description: 'Add an Action-Clip strip (i.e. an NLA Strip referencing an Action) to the active track',
    props: [{ id: 'action', label: 'Action', type: 'string', default: '' }],
    poll: (ctx) => poll(ctx) && Object.keys(ctx.doc.actions).length > 0,
    invoke: (ctx, p) => {
      if (p.action) return addActionClip(ctx, p.action as string);
      openMenu(actionClipMenu(), { x: app.pointer.x, y: app.pointer.y }, { title: 'Add Action Strip' });
      return 'CANCELLED';
    },
    exec: (ctx, p) => addActionClip(ctx, p.action as string),
  },
  {
    idname: 'nla.action_pushdown',
    label: 'Push Down Action',
    description: 'Push action down onto the top of the NLA stack as a new strip',
    props: [
      {
        id: 'object',
        label: 'Object',
        type: 'string',
        default: '',
        hidden: true,
      },
    ],
    poll: (ctx) => poll(ctx),
    exec: (ctx, p) => {
      const ob = (p.object ? ctx.doc.objects[p.object as string] : undefined) ?? app.activeObject;
      if (!ob || !pushDown(ctx.doc, ob)) return 'CANCELLED';
    },
  },
  {
    idname: 'nla.tracks_add',
    label: 'Add Tracks',
    description: 'Add NLA-Tracks above/after the selected tracks',
    props: [
      {
        id: 'above_selected',
        label: 'Above Selected',
        type: 'bool',
        default: false,
      },
    ],
    poll,
    exec: (ctx, p) => {
      const ed = nlaEd(ctx)!;
      let n = 0;
      const obs = new Set<ObjectData>();
      for (const ch of ed.list.rows) if (ch.ob && (ch.kind === 'OBJECT' || ch.kind === 'NLA_TRACK')) obs.add(ch.ob);
      if (!obs.size && app.activeObject) obs.add(app.activeObject);
      for (const ob of obs) {
        const ad = ensureAnimData(ob);
        if (p.above_selected) {
          for (let i = ad.nla_tracks.length - 1; i >= 0; i--)
            if (ad.nla_tracks[i].select) {
              ad.nla_tracks.splice(i + 1, 0, newTrack(ad));
              n++;
            }
        } else if (ob === app.activeObject || ob.select) {
          ad.nla_tracks.push(newTrack(ad));
          n++;
        }
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'nla.tracks_delete',
    label: 'Delete Tracks',
    description: 'Delete selected NLA-Tracks and the strips they contain',
    poll: (ctx) => !!nlaEd(ctx)?.list.rows.some((r) => r.kind === 'NLA_TRACK' && r.track?.select),
    exec: (ctx) => {
      for (const ch of nlaEd(ctx)!.list.rows)
        if (ch.kind === 'NLA_TRACK' && ch.track?.select && ch.ob?.animation_data) ch.ob.animation_data.nla_tracks = ch.ob.animation_data.nla_tracks.filter((t) => t !== ch.track);
    },
  },
  {
    idname: 'nla.clear_scale',
    label: 'Clear Scale',
    description: 'Reset scaling of selected strips',
    poll: pollSel,
    exec: (ctx) => {
      for (const r of nlaEd(ctx)!.selectedStrips()) {
        r.strip.scale = 1;
        updateStripEnd(r.strip);
      }
    },
  },
  {
    idname: 'nla.action_sync_length',
    label: 'Sync Action Length',
    description: 'Synchronize the length of the referenced Action with the length used in the strip',
    poll: pollSel,
    exec: (ctx) => {
      for (const r of nlaEd(ctx)!.selectedStrips()) {
        const a = ctx.doc.actions[r.strip.action];
        if (!a) continue;
        [r.strip.action_frame_start, r.strip.action_frame_end] = actionRange({
          ...a,
          frame_range: undefined,
        });
        updateStripEnd(r.strip);
      }
    },
  },
  {
    idname: 'nla.snap',
    label: 'Snap Strips',
    description: 'Move start of strips to specified time',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'CFRA',
        items: [
          ['CFRA', 'Selection to Current Frame'],
          ['NEAREST_FRAME', 'Selection to Nearest Frame'],
          ['NEAREST_SECOND', 'Selection to Nearest Second'],
          ['NEAREST_MARKER', 'Selection to Nearest Marker'],
        ],
      },
    ],
    poll: pollSel,
    exec: (ctx, p) => {
      const s = ctx.doc.scene;
      const fps = s.render.fps / (s.render.fps_base || 1);
      const markers = s.timeline_markers.map((m) => m.frame);
      const sel = nlaEd(ctx)!.selectedStrips();
      for (const r of sel) {
        const a = r.strip.frame_start;
        let t = a;
        if (p.type === 'CFRA') t = s.frame_current;
        else if (p.type === 'NEAREST_FRAME') t = Math.round(a);
        else if (p.type === 'NEAREST_SECOND') t = Math.round(a / fps) * fps;
        else if (markers.length) t = markers.reduce((x, y) => (Math.abs(y - a) < Math.abs(x - a) ? y : x));
        r.strip.frame_end += t - a;
        r.strip.frame_start = t;
      }
      resolveOverlaps(sel);
    },
  },
  {
    idname: 'nla.view_all',
    label: 'Frame All',
    description: 'Reset viewable area to show full strips range',
    poll,
    undo: false,
    exec: (ctx) => nlaEd(ctx)!.viewAll(),
  },
  {
    idname: 'nla.view_selected',
    label: 'Frame Selected',
    description: 'Reset viewable area to show selected strips range',
    poll,
    undo: false,
    exec: (ctx) => nlaEd(ctx)!.viewSelected(),
  },
  {
    idname: 'nla.view_frame',
    label: 'Go to Current Frame',
    description: 'Move the view to the current frame',
    poll,
    undo: false,
    exec: (ctx) => nlaEd(ctx)!.centerCurrentFrame(),
  },
]);

function addActionClip(ctx: OpContext, actionId: string) {
  const ed = nlaEd(ctx);
  const act = ctx.doc.actions[actionId];
  if (!ed || !act) return 'CANCELLED' as const;
  // target: selected tracks, else the active object's top track (or a new one)
  const targets = ed.list.rows.filter((r) => r.kind === 'NLA_TRACK' && r.track?.select && !r.track.lock);
  const cfra = ctx.doc.scene.frame_current;
  const place = (ob: ObjectData, track: NlaTrack | null) => {
    const ad = ensureAnimData(ob);
    const strip = makeStrip(act, cfra, ad.nla_tracks.every((t) => !t.strips.length) ? 'HOLD' : 'HOLD_FORWARD');
    let t = track;
    if (!t || !stripFits(t, strip.frame_start, strip.frame_end)) {
      t = newTrack(ad);
      const at = track ? ad.nla_tracks.indexOf(track) + 1 : ad.nla_tracks.length;
      ad.nla_tracks.splice(at, 0, t);
    }
    for (const o of ad.nla_tracks) for (const s of o.strips) s.select = false;
    t.strips.push(strip);
    sortStrips(t);
    ed.activeStrip = strip;
  };
  if (targets.length) for (const r of targets) place(r.ob!, r.track!);
  else {
    const ob = app.activeObject;
    if (!ob) {
      app.report('ERROR', 'No active track(s) to add strip to, select an existing track or add one before trying again');
      return 'CANCELLED' as const;
    }
    const ad = ensureAnimData(ob);
    place(ob, ad.nla_tracks[ad.nla_tracks.length - 1] ?? null);
  }
  return 'FINISHED' as const;
}

addKeys('NLA Editor', [
  {
    key: 'A',
    op: 'nla.select_all',
    props: { action: 'SELECT' },
    when: overMain,
  },
  {
    key: 'A',
    alt: true,
    op: 'nla.select_all',
    props: { action: 'DESELECT' },
    when: overMain,
  },
  {
    key: 'I',
    ctrl: true,
    op: 'nla.select_all',
    props: { action: 'INVERT' },
    when: overMain,
  },
  { key: 'B', op: 'nla.select_box', when: overMain },
  { key: 'B', alt: true, op: 'nla.select_box', props: { axis_range: true }, when: overMain },
  { key: 'LEFT_BRACKET', op: 'nla.select_leftright', props: { mode: 'LEFT' } },
  {
    key: 'RIGHT_BRACKET',
    op: 'nla.select_leftright',
    props: { mode: 'RIGHT' },
  },
  {
    key: 'G',
    op: 'nla.transform',
    props: { mode: 'TRANSLATION' },
    when: overMain,
  },
  { key: 'S', op: 'nla.transform', props: { mode: 'RESIZE' }, when: overMain },
  { key: 'D', shift: true, op: 'nla.duplicate_linked_move', when: overMain },
  { key: 'X', op: 'nla.delete', when: overMain },
  { key: 'DEL', op: 'nla.delete', when: overMain },
  { key: 'H', op: 'nla.mute_toggle' },
  { key: 'Y', op: 'nla.split' },
  { key: 'A', shift: true, op: 'nla.actionclip_add' },
  { key: 'S', alt: true, op: 'nla.clear_scale' },
  { key: 'S', shift: true, menu: snapItems, menuTitle: 'Snap' },
  { key: 'HOME', op: 'nla.view_all' },
  { key: 'NUMPAD_PERIOD', op: 'nla.view_selected' },
  { key: 'NUMPAD_0', op: 'nla.view_frame' },
  { key: 'N', op: 'anim.region_ui_toggle' },
]);

registerEditor({
  id: 'NLA',
  label: 'Nonlinear Animation',
  icon: 'nla',
  group: 'Animation',
  create: (a, s) => new NlaEditor(a, s),
});
