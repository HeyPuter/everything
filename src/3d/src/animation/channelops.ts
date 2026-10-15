// Channel-region operators shared by the animation editors: reorder (Page Up/Down),
// editability toggle (Tab), clean empty animation data, bake channels, frame selected
// channels, channel filter (Ctrl+F), channel box select (B), plus scene/preview range
// operators (P, Alt+P, Ctrl+Home/End, Frame Scene Range).
import { app, registerOperators, type OpContext, type Operator } from '../app/app';
import { addKeys } from '../app/keymap';
import type { ActionData, FCurve, NlaTrack, ObjectData } from '../data/types';
import { AnimEditor, overChannels, overMain, hoverEditor } from './animeditor';
import { channelState, setChannelSelected, type Channel, type CurveRef } from './channels';
import { selectedChannelCurves } from './keyops';
import { keyBounds } from './keyedit';
import { moveSelected, moveActionChannels, bakeCurve, cleanAnimData, type Dir, type BakeChannelOptions } from './channeledit';

function animEd(ctx: OpContext): AnimEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof AnimEditor ? ed : null;
}
const pollEd = (ctx: OpContext) => !!animEd(ctx);

/** Selected curves' owners, deduplicated. */
function listedActions(ed: AnimEditor): ActionData[] {
  return [...new Set(ed.list.curves.map((r) => r.action))];
}

// ---------------------------------------------------------------------------
// Operators

const ops: Operator[] = [
  {
    idname: 'anim.channels_move',
    label: 'Move Channels',
    description: 'Reorder the selected channels (F-Curves within their group, groups within their action, NLA tracks within their object)',
    props: [
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'DOWN',
        items: [
          ['TOP', 'To Top'],
          ['UP', 'Up'],
          ['DOWN', 'Down'],
          ['BOTTOM', 'To Bottom'],
        ],
      },
    ],
    poll: pollEd,
    exec: (ctx, p) => {
      const ed = animEd(ctx)!;
      const dir = p.direction as Dir;
      let changed = false;
      if (ed.space() === 'NLA') {
        // tracks are listed top-down from the last one: "up" means a higher index
        const flip: Record<Dir, Dir> = { TOP: 'BOTTOM', UP: 'DOWN', DOWN: 'UP', BOTTOM: 'TOP' };
        const obs = new Set(ed.list.rows.filter((r) => r.kind === 'NLA_TRACK' && r.ob).map((r) => r.ob!));
        for (const ob of obs) {
          const ad = ob.animation_data!;
          const tracks: NlaTrack[] = [...ad.nla_tracks];
          if (moveSelected(tracks, (t) => !!t.select, flip[dir])) {
            ad.nla_tracks = tracks;
            changed = true;
          }
        }
      } else for (const a of listedActions(ed)) if (moveActionChannels(a, dir, channelState.selectedGroups)) changed = true;
      if (!changed) return 'CANCELLED';
    },
  },
  {
    idname: 'anim.channels_editable_toggle',
    label: 'Toggle Channel Editability',
    description: 'Lock or unlock the selected channels against editing (or toggle muting)',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['TOGGLE', 'Toggle'],
          ['DISABLE', 'Disable'],
          ['ENABLE', 'Enable'],
          ['INVERT', 'Invert'],
        ],
      },
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'PROTECT',
        items: [
          ['PROTECT', 'Protect'],
          ['MUTE', 'Mute'],
        ],
      },
    ],
    poll: pollEd,
    exec: (ctx, p) => {
      const ed = animEd(ctx)!;
      const key = p.type === 'MUTE' ? 'mute' : 'lock';
      const c = selectedChannelCurves(ed);
      if (!c.length) return 'CANCELLED';
      const mode = p.mode as string;
      const on = mode === 'TOGGLE' ? !c.every((r) => !!r.fc[key]) : mode === 'ENABLE';
      for (const r of c) r.fc[key] = mode === 'INVERT' ? !r.fc[key] : on;
    },
  },
  {
    idname: 'anim.channels_clean_empty',
    label: 'Remove Empty Animation Data',
    description: 'Remove empty actions, empty NLA tracks and animation data that animates nothing from the listed objects',
    poll: pollEd,
    exec: (ctx) => {
      const ed = animEd(ctx)!;
      const obs = new Set<ObjectData>();
      for (const r of ed.list.rows) if (r.ob) obs.add(r.ob);
      let n = 0;
      for (const ob of obs) if (cleanAnimData(ob, ctx.doc.actions)) n++;
      if (!n) {
        app.report('INFO', 'No empty animation data found');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'anim.channels_bake',
    label: 'Bake Channels',
    description: 'Replace the keys of the selected F-Curves with a key on every step of a frame range',
    props: [
      { id: 'use_scene_range', label: 'Use Scene Range', type: 'bool', default: true },
      { id: 'range', label: 'Frame Range', type: 'vec2', default: [0, 0], showIf: (p) => !p.use_scene_range },
      { id: 'step', label: 'Frame Step', type: 'float', default: 1, min: 0.01, step: 0.5 },
      { id: 'remove_outside_range', label: 'Remove Outside Range', type: 'bool', default: false },
      {
        id: 'interpolation_type',
        label: 'Interpolation Type',
        type: 'enum',
        default: 'BEZIER',
        items: [
          ['BEZIER', 'Bézier'],
          ['LIN', 'Linear'],
          ['CONST', 'Constant'],
        ],
      },
      { id: 'bake_modifiers', label: 'Bake Modifiers', type: 'bool', default: true },
    ],
    poll: (ctx) => !!animEd(ctx) && selectedChannelCurves(animEd(ctx)!).length > 0,
    exec: (ctx, p) => {
      const s = ctx.doc.scene;
      const scene = s.use_preview_range ? [s.frame_preview_start ?? s.frame_start, s.frame_preview_end ?? s.frame_end] : [s.frame_start, s.frame_end];
      const [a, b] = p.use_scene_range ? scene : (p.range as [number, number]);
      if (b < a) return 'CANCELLED';
      const interp = { BEZIER: 'BEZIER', LIN: 'LINEAR', CONST: 'CONSTANT' }[p.interpolation_type as string] as BakeChannelOptions['interpolation'];
      const seen = new Set<FCurve>();
      for (const r of selectedChannelCurves(animEd(ctx)!)) {
        if (r.fc.lock || seen.has(r.fc)) continue;
        seen.add(r.fc);
        bakeCurve(r.fc, { start: a, end: b, step: p.step as number, removeOutside: !!p.remove_outside_range, interpolation: interp, bakeModifiers: !!p.bake_modifiers });
      }
      if (!seen.size) return 'CANCELLED';
    },
  },
  {
    idname: 'anim.channels_view_selected',
    label: 'Frame Selected Channels',
    description: 'Fit the view to the keys of the selected channels',
    props: [
      { id: 'include_handles', label: 'Include Handles', type: 'bool', default: true },
      { id: 'use_preview_range', label: 'Use Preview Range', type: 'bool', default: true },
    ],
    undo: false,
    poll: pollEd,
    exec: (ctx, p) => {
      const ed = animEd(ctx)!;
      const c = selectedChannelCurves(ed);
      if (!c.length) return 'CANCELLED';
      frameCurves(ed, c, !!p.include_handles, !!p.use_preview_range);
    },
  },
  {
    idname: 'anim.channel_view_pick',
    label: 'Frame Channel Under Cursor',
    description: 'Fit the view to the keys of the channel under the mouse',
    props: [
      { id: 'include_handles', label: 'Include Handles', type: 'bool', default: true },
      { id: 'use_preview_range', label: 'Use Preview Range', type: 'bool', default: true },
    ],
    undo: false,
    internal: true,
    poll: pollEd,
    exec: (ctx, p) => {
      const ed = animEd(ctx)!;
      const ch = ed.channelAtClient(ctx.event?.y ?? app.pointer.y);
      if (!ch || !ch.curves.length) return 'CANCELLED';
      frameCurves(ed, ch.curves, !!p.include_handles, !!p.use_preview_range);
    },
  },
  {
    idname: 'anim.channels_click',
    label: 'Mouse Click on Channels',
    description: 'Select the channel under the mouse (Ctrl toggles, Shift extends to a range)',
    props: [
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'extend_range', label: 'Extend Range', type: 'bool', default: false },
    ],
    poll: pollEd,
    exec: (ctx, p) => {
      const ed = animEd(ctx)!;
      const ch = ed.channelAtClient(ctx.event?.y ?? app.pointer.y);
      if (!ch) return 'CANCELLED';
      ed.clickChannel(ch, !!p.extend || !!p.extend_range);
    },
  },
  {
    idname: 'anim.channels_rename',
    label: 'Rename Channel',
    description: 'Rename the channel under the mouse',
    undo: false,
    poll: pollEd,
    invoke: (ctx) => {
      const ed = animEd(ctx)!;
      const ch = ed.channelAtClient(ctx.event?.y ?? app.pointer.y);
      if (!ch || !ed.canRename(ch)) return 'CANCELLED';
      ed.renameChannel(ch);
      return 'CANCELLED';
    },
  },
  {
    idname: 'anim.channel_select_keys',
    label: 'Select Channel Keyframes',
    description: 'Select all keyframes of the channel under the mouse',
    props: [{ id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: pollEd,
    exec: (ctx, p) => {
      const ed = animEd(ctx)!;
      const ch = ed.channelAtClient(ctx.event?.y ?? app.pointer.y);
      if (!ch?.curves.length) return 'CANCELLED';
      ed.selectChannelKeys(ch, !!p.extend);
    },
  },
  {
    idname: 'anim.channels_select_filter',
    label: 'Filter Channels',
    description: 'Type in the channel search field to filter the list',
    undo: false,
    poll: pollEd,
    exec: (ctx) => {
      animEd(ctx)!.focusSearch();
    },
  },
  {
    idname: 'anim.channels_select_box',
    label: 'Box Select',
    description: 'Select channels by dragging a box over the channel list',
    props: [
      { id: 'ymin', label: 'Y Min', type: 'int', default: 0, hidden: true },
      { id: 'ymax', label: 'Y Max', type: 'int', default: 0, hidden: true },
      { id: 'deselect', label: 'Deselect', type: 'bool', default: false },
      { id: 'extend', label: 'Extend', type: 'bool', default: true },
    ],
    poll: pollEd,
    invoke: (ctx, p) => {
      const ed = animEd(ctx)!;
      app.startModal({
        label: 'Box Select',
        cursor: 'crosshair',
        header: () => 'Box Select: drag over the channels',
        onPointerDown: (e) => {
          if (e.button === 0) ed.channelBoxGesture(e, (y0, y1, ev) => app.run('anim.channels_select_box', { ...p, ymin: y0, ymax: y1, deselect: ev.ctrlKey || ev.metaKey, extend: !!p.extend || ev.shiftKey }, { area: ed.area, invoke: false }));
          return 'CANCELLED';
        },
        onKey: (e) => (e.key === 'Escape' ? 'CANCELLED' : true),
        cancel: () => {},
      });
      return 'RUNNING_MODAL';
    },
    exec: (ctx, p) => {
      const ed = animEd(ctx)!;
      const rows = ed.channelRowsBetween(p.ymin as number, p.ymax as number);
      if (!p.extend && !p.deselect) ed.deselectChannels();
      for (const ch of rows) if (selectableChannel(ch)) setChannelSelected(ch, !p.deselect);
    },
  },
  // ---- scene / preview range
  {
    idname: 'anim.previewrange_set',
    label: 'Set Preview Range',
    description: 'Drag horizontally to choose the frames played back (preview range)',
    props: [
      { id: 'xmin', label: 'Start', type: 'int', default: 0 },
      { id: 'xmax', label: 'End', type: 'int', default: 0 },
    ],
    poll: (ctx) => !!animEd(ctx) || ctx.area?.type === 'TIMELINE',
    invoke: (ctx, p) => {
      const ed = animEd(ctx);
      const frameAt = (cx: number) => (ed ? Math.round(ed.view.xf(ed.local({ clientX: cx, clientY: 0 }).x)) : app.doc.scene.frame_current);
      app.startModal({
        label: 'Set Preview Range',
        cursor: 'col-resize',
        header: () => 'Set Preview Range: drag across the frames to play back',
        onPointerDown: (e) => {
          if (e.button !== 0) return 'CANCELLED';
          const a = frameAt(e.clientX);
          const up = (ev: PointerEvent) => {
            removeEventListener('pointerup', up);
            const b = frameAt(ev.clientX);
            app.run('anim.previewrange_set', { ...p, xmin: Math.min(a, b), xmax: Math.max(a, b) }, { area: ctx.area, invoke: false });
          };
          addEventListener('pointerup', up);
          return 'CANCELLED';
        },
        onKey: (e) => (e.key === 'Escape' ? 'CANCELLED' : true),
        cancel: () => {},
      });
      return 'RUNNING_MODAL';
    },
    exec: (ctx, p) => {
      const s = ctx.doc.scene;
      const a = p.xmin as number,
        b = p.xmax as number;
      s.use_preview_range = true;
      s.frame_preview_start = Math.min(a, b);
      s.frame_preview_end = Math.max(Math.min(a, b) + 1, Math.max(a, b));
    },
  },
  {
    idname: 'anim.start_frame_set',
    label: 'Set Start Frame',
    description: 'Make the current frame the start of the scene (or preview) range',
    exec: (ctx) => {
      const s = ctx.doc.scene;
      const f = s.frame_current;
      if (s.use_preview_range) {
        s.frame_preview_start = f;
        if ((s.frame_preview_end ?? f) < f) s.frame_preview_end = f;
      } else {
        s.frame_start = f;
        if (s.frame_end < f) s.frame_end = f;
      }
    },
  },
  {
    idname: 'anim.end_frame_set',
    label: 'Set End Frame',
    description: 'Make the current frame the end of the scene (or preview) range',
    exec: (ctx) => {
      const s = ctx.doc.scene;
      const f = s.frame_current;
      if (s.use_preview_range) {
        s.frame_preview_end = f;
        if ((s.frame_preview_start ?? f) > f) s.frame_preview_start = f;
      } else {
        s.frame_end = f;
        if (s.frame_start > f) s.frame_start = f;
      }
    },
  },
  {
    idname: 'anim.show_seconds_toggle',
    label: 'Show Seconds',
    description: 'Show timing in seconds (seconds+frames) instead of frames',
    undo: false,
    internal: true,
    poll: pollEd,
    exec: (ctx) => {
      const ed = animEd(ctx)!;
      ed.showSeconds = !ed.showSeconds;
      ed.draw();
      app.changed('ui');
    },
  },
  {
    idname: 'anim.scene_range_frame',
    label: 'Frame Scene/Preview Range',
    description: 'Fit the view to the scene frame range (or the preview range when it is active)',
    undo: false,
    poll: pollEd,
    exec: (ctx) => {
      const s = ctx.doc.scene;
      const [a, b] = s.use_preview_range ? [s.frame_preview_start ?? s.frame_start, s.frame_preview_end ?? s.frame_end] : [s.frame_start, s.frame_end];
      animEd(ctx)!.viewFrameRange(a, b);
    },
  },
];

const selectableChannel = (ch: Channel) => !['SUMMARY', 'ACTION', 'DRIVERS', 'NLA_ACTION'].includes(ch.kind);

/** Fit an editor to a set of curves (values too in the Graph Editor). */
export function frameCurves(ed: AnimEditor, curves: CurveRef[], includeHandles: boolean, usePreview: boolean) {
  const b = keyBounds(curves, false, includeHandles);
  if (!b) return;
  const s = app.doc.scene;
  if (usePreview && s.use_preview_range) {
    b.x0 = Math.max(b.x0, s.frame_preview_start ?? b.x0);
    b.x1 = Math.min(b.x1, s.frame_preview_end ?? b.x1);
  }
  const fit = (ed as unknown as { fitBounds?: (bb: typeof b, c: CurveRef[]) => void }).fitBounds;
  if (fit) fit.call(ed, b, curves);
  else ed.viewFrameRange(b.x0, b.x1);
}

registerOperators(ops);

addKeys('Animation Channels', [
  { key: 'PAGE_UP', op: 'anim.channels_move', props: { direction: 'UP' }, when: overChannels },
  { key: 'PAGE_DOWN', op: 'anim.channels_move', props: { direction: 'DOWN' }, when: overChannels },
  { key: 'PAGE_UP', shift: true, op: 'anim.channels_move', props: { direction: 'TOP' }, when: overChannels },
  { key: 'PAGE_DOWN', shift: true, op: 'anim.channels_move', props: { direction: 'BOTTOM' }, when: overChannels },
  { key: 'TAB', op: 'anim.channels_editable_toggle', when: () => !!hoverEditor() && hoverEditor()!.space() !== 'NLA' },
  { key: 'F', ctrl: true, op: 'anim.channels_select_filter' },
  { key: 'B', op: 'anim.channels_select_box', when: overChannels },
  { key: 'NUMPAD_PERIOD', op: 'anim.channels_view_selected', when: overChannels },
]);

addKeys('Animation', [
  { key: 'P', op: 'anim.previewrange_set', when: overMain },
  { key: 'T', ctrl: true, op: 'anim.show_seconds_toggle' },
  { key: 'HOME', ctrl: true, op: 'anim.start_frame_set' },
  { key: 'END', ctrl: true, op: 'anim.end_frame_set' },
]);
