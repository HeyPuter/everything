// Keyframe operators for the Dope Sheet (action.*) and Graph Editor (graph.*),
// channel operators (anim.channels_*) and their keymaps.
import { app, registerOperators, type OpContext, type Operator, type PropDef } from '../app/app';
import { addKeys, type KeyItem } from '../app/keymap';
import { openMenu, type MenuItem } from '../ui/menu';
import type { Interpolation, KeyHandleType, Keyframe } from '../data/types';
import { AnimEditor, overChannels, overMain, hoverEditor } from './animeditor';
import { channelState, channelSelected, setChannelSelected, groupKey, setExpanded, isExpanded, shapeKeyPath, type CurveRef } from './channels';
import { keyProperty } from '../anim/keyframes';
import { getValue } from '../data/rna';
import * as K from './keyedit';
import { transformKeys, type KeyTransformHost, type KeyTransformMode } from './transformkeys';
import {
  interpolationMenu,
  handleMenu,
  easingMenu,
  keyTypeMenu,
  extrapolationMenu,
  snapMenu,
  mirrorMenu,
  INTERPOLATION_ITEMS,
  HANDLE_ITEMS,
  EASING_ITEMS,
  EXTRAPOLATION_ITEMS,
  type Prefix,
} from './menus';
import { KEY_TYPES } from './footer';
import { boxRegionSelect } from './selecttools';
import type { EditorTypeId } from '../ui/screen';

/** Interface implemented by the Dope Sheet and the Graph Editor. */
export interface KeyEditor extends AnimEditor {
  prefix: Prefix;
  keyHost(): KeyTransformHost;
  startTransform(mode: KeyTransformMode, start: { x: number; y: number }, releaseConfirm?: boolean, onCancel?: () => void): boolean;
  boxSelect(r: { x0: number; y0: number; x1: number; y1: number }, mode: 'SET' | 'ADD' | 'SUB'): void;
  cursorValue?: number;
  activeCurve?(): CurveRef | null;
  toDispValue?(r: CurveRef, v: number): number;
  fromDispValue?(r: CurveRef, d: number): number;
}

function keyEditor(ctx: OpContext, p: Prefix): KeyEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof AnimEditor && (ed as unknown as { prefix?: string }).prefix === p ? (ed as KeyEditor) : null;
}

const enumItems = (list: [string, string][]): [string, string][] => list;

function keyOps(p: Prefix): Operator[] {
  const ed = (ctx: OpContext) => keyEditor(ctx, p)!;
  const poll = (ctx: OpContext) => !!keyEditor(ctx, p);
  const pollKeys = (ctx: OpContext) => !!keyEditor(ctx, p) && K.anyKeySelected(keyEditor(ctx, p)!.editCurves(), p === 'graph');
  const curves = (ctx: OpContext) => ed(ctx).editCurves();
  const all = (ctx: OpContext) => ed(ctx).list.curves.filter((r) => p !== 'graph' || !r.fc.hide);
  const markersSel = (ctx: OpContext) => ctx.doc.scene.timeline_markers.filter((m) => m.select).map((m) => m.frame);
  const interpItems: [string, string][] = INTERPOLATION_ITEMS.flatMap((s) => s.items);
  return [
    {
      idname: `${p}.select_all`,
      label: '(De)select All',
      description: 'Toggle selection of all keyframes',
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
      exec: (ctx, pr) => K.selectAll(all(ctx), pr.action as K.SelectAction),
    },
    {
      idname: `${p}.select_box`,
      label: 'Box Select',
      description: 'Select all keyframes within the specified region',
      props: [
        { id: 'axis_range', label: 'Axis Range', type: 'bool', default: false },
        ...(p === 'graph' ? [{ id: 'include_handles', label: 'Include Handles', type: 'bool' as const, default: true }] : []),
        {
          id: 'mode',
          label: 'Mode',
          type: 'enum',
          default: 'SET',
          items: [
            ['SET', 'Set'],
            ['ADD', 'Extend'],
            ['SUB', 'Subtract'],
          ],
        },
        { id: 'xmin', label: 'X Min', type: 'int', default: 0, hidden: true },
        { id: 'xmax', label: 'X Max', type: 'int', default: 0, hidden: true },
        { id: 'ymin', label: 'Y Min', type: 'int', default: 0, hidden: true },
        { id: 'ymax', label: 'Y Max', type: 'int', default: 0, hidden: true },
      ],
      poll,
      invoke: (ctx, pr) => {
        const e = ed(ctx);
        app.startModal({
          label: 'Box Select',
          cursor: 'crosshair',
          header: () => (pr.axis_range ? 'Box Select (Axis Range)' : 'Box Select') + ': drag to select (Shift extends, Ctrl deselects)',
          onPointerDown: (ev) => {
            if (ev.button === 0)
              e.boxGesture(ev, (r, mode) => {
                const m = mode === 'SET' ? (pr.mode as string) : mode;
                app.run(`${p}.select_box`, { ...pr, mode: m, xmin: Math.round(r.x0), xmax: Math.round(r.x1), ymin: Math.round(r.y0), ymax: Math.round(r.y1) }, { area: e.area, invoke: false });
              });
            return 'CANCELLED';
          },
          onKey: (ev) => (ev.key === 'Escape' ? 'CANCELLED' : true),
          cancel: () => {},
        });
        return 'RUNNING_MODAL';
      },
      exec: (ctx, pr) => {
        boxRegionSelect(ed(ctx), { x0: pr.xmin as number, x1: pr.xmax as number, y0: pr.ymin as number, y1: pr.ymax as number }, pr.mode as 'SET', !!pr.axis_range, pr.include_handles !== false);
      },
    },
    {
      idname: `${p}.select_column`,
      label: 'Select All',
      description: 'Select all keyframes on the specified frame(s)',
      props: [
        {
          id: 'mode',
          label: 'Mode',
          type: 'enum',
          default: 'KEYS',
          items: [
            ['KEYS', 'On Selected Keyframes'],
            ['CFRA', 'On Current Frame'],
            ['MARKERS_COLUMN', 'On Selected Markers'],
            ['MARKERS_BETWEEN', 'Between Min/Max Selected Markers'],
          ],
        },
      ],
      poll,
      exec: (ctx, pr) => {
        const c = all(ctx);
        const mode = pr.mode as string;
        if (mode === 'KEYS') K.selectColumns(c, K.selectedFrames(c));
        else if (mode === 'CFRA') K.selectColumns(c, [ctx.doc.scene.frame_current]);
        else if (mode === 'MARKERS_COLUMN') K.selectColumns(c, markersSel(ctx));
        else {
          const m = markersSel(ctx);
          if (m.length < 2) return 'CANCELLED';
          const lo = Math.min(...m),
            hi = Math.max(...m);
          for (const { fc } of c) for (const k of fc.keyframe_points) if (k.co[0] >= lo && k.co[0] <= hi) K.setKeySelected(k, true);
        }
      },
    },
    {
      idname: `${p}.select_leftright`,
      label: 'Select Left/Right',
      description: 'Select keyframes to the left or the right of the current frame',
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
      exec: (ctx, pr) => K.selectLeftRight(all(ctx), pr.mode as 'LEFT', ctx.doc.scene.frame_current, !!pr.extend),
    },
    {
      idname: `${p}.select_more`,
      label: 'Select More',
      description: 'Select keyframes beside already selected ones',
      poll,
      exec: (ctx) => K.selectMoreLess(all(ctx), true),
    },
    {
      idname: `${p}.select_less`,
      label: 'Select Less',
      description: 'Deselect keyframes on ends of selection islands',
      poll,
      exec: (ctx) => K.selectMoreLess(all(ctx), false),
    },
    {
      idname: `${p}.select_linked`,
      label: 'Select Linked',
      description: 'Select keyframes occurring in the same F-Curves as selected ones',
      poll,
      exec: (ctx) => K.selectLinked(all(ctx)),
    },
    {
      idname: `${p}.delete`,
      label: 'Delete Keyframes',
      description: 'Remove all selected keyframes',
      props: [
        {
          id: 'confirm',
          label: 'Confirm',
          type: 'bool',
          default: true,
          hidden: true,
        },
      ],
      poll: pollKeys,
      invoke: (ctx, pr) => {
        if (!pr.confirm) return K.deleteSelected(curves(ctx)) ? 'FINISHED' : 'CANCELLED';
        openMenu(
          [
            {
              label: 'Delete Keyframes',
              action: () => app.run(`${p}.delete`, { confirm: false }, { invoke: false }),
            },
          ],
          { x: app.pointer.x - 60, y: app.pointer.y - 10 },
          { title: 'Delete selected keyframes?' },
        );
        return 'CANCELLED';
      },
      exec: (ctx) => {
        if (!K.deleteSelected(curves(ctx))) return 'CANCELLED';
      },
    },
    {
      idname: `${p}.duplicate_move`,
      label: 'Duplicate',
      description: 'Make a copy of all selected keyframes and move them',
      poll: pollKeys,
      invoke: (ctx) => {
        const e = ed(ctx);
        const c = e.editCurves();
        if (!K.duplicateSelected(c)) return 'CANCELLED';
        const started = e.startTransform(p === 'graph' ? 'TRANSLATION' : 'TIME_TRANSLATE', { ...app.pointer }, false, () => K.finalizeAll(c));
        if (!started) return 'FINISHED';
        return 'RUNNING_MODAL';
      },
      exec: (ctx) => {
        K.duplicateSelected(curves(ctx));
      },
    },
    {
      idname: `${p}.copy`,
      label: 'Copy Keyframes',
      description: 'Copy selected keyframes to the internal clipboard',
      poll: pollKeys,
      undo: false,
      exec: (ctx) => {
        const n = K.copyKeys(curves(ctx));
        if (!n) {
          app.report('ERROR', 'No keyframes copied to the internal clipboard');
          return 'CANCELLED';
        }
      },
    },
    {
      idname: `${p}.paste`,
      label: 'Paste Keyframes',
      description: 'Paste keyframes from the internal clipboard for the selected channels, starting on the current frame',
      props: [
        {
          id: 'offset',
          label: 'Frame Offset',
          type: 'enum',
          default: 'START',
          items: [
            ['START', 'Frame Start'],
            ['END', 'Frame End'],
            ['RELATIVE', 'Frame Relative'],
            ['NONE', 'No Offset'],
          ],
        },
        {
          id: 'merge',
          label: 'Type',
          type: 'enum',
          default: 'MIX',
          items: [
            ['MIX', 'Mix'],
            ['OVER_ALL', 'Overwrite All'],
            ['OVER_RANGE', 'Overwrite Range'],
          ],
        },
        { id: 'flipped', label: 'Flipped', type: 'bool', default: false },
      ],
      poll: (ctx) => poll(ctx) && !!K.keyClipboard,
      exec: (ctx, pr) => {
        const n = K.pasteKeys(curves(ctx), ctx.doc.scene.frame_current, pr.offset as K.PasteOffset, pr.merge as K.PasteMerge, !!pr.flipped);
        if (!n) {
          app.report('ERROR', 'No keyframes pasted (no matching F-Curves)');
          return 'CANCELLED';
        }
      },
    },
    {
      idname: `${p}.interpolation_type`,
      label: 'Set Keyframe Interpolation',
      description: 'Set interpolation mode for the F-Curve segments starting from the selected keyframes',
      props: [
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          default: 'BEZIER',
          items: enumItems(interpItems),
        },
      ],
      poll: pollKeys,
      exec: (ctx, pr) => K.setInterpolation(curves(ctx), pr.type as Interpolation),
    },
    {
      idname: `${p}.handle_type`,
      label: 'Set Keyframe Handle Type',
      description: 'Set type of handle for selected keyframes',
      props: [
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          default: 'AUTO_CLAMPED',
          items: enumItems(HANDLE_ITEMS),
        },
      ],
      poll: pollKeys,
      exec: (ctx, pr) => K.setHandleType(curves(ctx), pr.type as KeyHandleType, p === 'graph'),
    },
    {
      idname: `${p}.easing_type`,
      label: 'Set Keyframe Easing Type',
      description: 'Set easing type for the F-Curve segments starting from the selected keyframes',
      props: [
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          default: 'AUTO',
          items: enumItems(EASING_ITEMS),
        },
      ],
      poll: pollKeys,
      exec: (ctx, pr) => K.setEasing(curves(ctx), pr.type as Keyframe['easing']),
    },
    {
      idname: `${p}.keyframe_type`,
      label: 'Set Keyframe Type',
      description: 'Set type of keyframe for the selected keyframes',
      props: [
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          default: 'KEYFRAME',
          items: enumItems(KEY_TYPES),
        },
      ],
      poll: pollKeys,
      exec: (ctx, pr) => K.setKeyType(curves(ctx), pr.type as Keyframe['type']),
    },
    {
      idname: `${p}.extrapolation_type`,
      label: 'Set F-Curve Extrapolation',
      description: 'Set extrapolation mode for selected F-Curves',
      props: [
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          default: 'CONSTANT',
          items: enumItems(EXTRAPOLATION_ITEMS),
        },
      ],
      poll,
      exec: (ctx, pr) => {
        if (!K.targetCurves(curves(ctx)).length) {
          app.report('WARNING', 'No selected F-Curves or keyframes');
          return 'CANCELLED';
        }
        K.setExtrapolation(curves(ctx), pr.type as K.ExtrapolationMode);
      },
    },
    {
      idname: `${p}.snap`,
      label: 'Snap Keys',
      description: 'Snap selected keyframes to the times specified',
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
            ['VALUE', 'Selection to Cursor Value'],
            ['HORIZONTAL', 'Flatten Handles'],
          ],
        },
      ],
      poll: pollKeys,
      exec: (ctx, pr) => {
        const e = ed(ctx);
        const s = ctx.doc.scene;
        const type = pr.type as K.SnapMode;
        if (type === 'VALUE' && e.fromDispValue) {
          for (const r of curves(ctx))
            K.snapKeys([r], 'VALUE', {
              frame: s.frame_current,
              fps: s.render.fps,
              markers: [],
              cursorValue: e.fromDispValue(r, e.cursorValue ?? 0),
            });
          return;
        }
        K.snapKeys(curves(ctx), type, {
          frame: s.frame_current,
          fps: s.render.fps / (s.render.fps_base || 1),
          markers: s.timeline_markers.map((m) => m.frame),
          cursorValue: e.cursorValue ?? 0,
        });
      },
    },
    {
      idname: `${p}.mirror`,
      label: 'Mirror Keys',
      description: 'Flip selected keyframes over the selected mirror line',
      props: [
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          default: 'CFRA',
          items: [
            ['CFRA', 'By Times Over Current Frame'],
            ['VALUE', 'By Values Over Cursor Value'],
            ['YAXIS', 'By Times Over Zero Time'],
            ['XAXIS', 'By Values Over Zero Value'],
            ['MARKER', 'By Times Over First Selected Marker'],
          ],
        },
      ],
      poll: pollKeys,
      exec: (ctx, pr) => {
        const e = ed(ctx);
        const type = pr.type as K.MirrorMode;
        const marker = markersSel(ctx)[0];
        if (type === 'MARKER' && marker === undefined) {
          app.report('ERROR', 'No selected marker to mirror over');
          return 'CANCELLED';
        }
        if (type === 'VALUE' && e.fromDispValue) {
          for (const r of curves(ctx))
            K.mirrorKeys([r], 'VALUE', {
              frame: ctx.doc.scene.frame_current,
              cursorValue: e.fromDispValue(r, e.cursorValue ?? 0),
            });
          return;
        }
        K.mirrorKeys(curves(ctx), type, {
          frame: ctx.doc.scene.frame_current,
          cursorValue: e.cursorValue ?? 0,
          marker,
        });
      },
    },
    {
      idname: `${p}.keyframe_insert`,
      label: 'Insert Keyframes',
      description: 'Insert keyframes for the specified channels',
      props: [
        {
          id: 'type',
          label: 'Type',
          type: 'enum',
          default: 'ALL',
          items:
            p === 'action'
              ? [
                  ['ALL', 'All Channels'],
                  ['SEL', 'Only Selected Channels'],
                  ['GROUP', 'In Active Group'],
                ]
              : [
                  ['ALL', 'All Channels'],
                  ['SEL', 'Only Selected Channels'],
                  ['ACTIVE', 'Only Active F-Curve'],
                  ['CURSOR_ACTIVE', 'Active Channels at Cursor'],
                  ['CURSOR_SEL', 'Selected Channels at Cursor'],
                ],
        },
      ],
      poll,
      exec: (ctx, pr) => {
        const e = ed(ctx);
        const type = pr.type as string;
        // Shape Key Editor: key blocks without an F-Curve get one
        if (e.space() === 'SHAPEKEY') {
          let created = false;
          for (const row of e.list.rows)
            if (row.kind === 'SHAPEKEY' && row.shapeKey && row.ob && !row.fc && (type !== 'SEL' || channelSelected(row))) {
              keyProperty(ctx.doc, row.ob, shapeKeyPath(row.shapeKey.name));
              created = true;
            }
          if (created) e.rebuild();
        }
        let c = curves(ctx);
        if (type === 'SEL' || type === 'CURSOR_SEL') c = c.filter((r) => r.fc.select);
        else if (type === 'GROUP') c = c.filter((r) => r.fc.group && channelState.selectedGroups.has(groupKey(r.action, r.fc.group)));
        else if (type === 'ACTIVE' || type === 'CURSOR_ACTIVE') {
          const a = e.activeCurve?.();
          c = a ? [a] : [];
        }
        if (!c.length) {
          app.report('ERROR', 'No suitable F-Curves to insert keyframes into');
          return 'CANCELLED';
        }
        const frame = ctx.doc.scene.frame_current;
        const kt = ctx.doc.scene.tool_settings.keyframe_type;
        K.insertKeysAt(c, frame, kt, (r) => {
          const v = getValue(ctx.doc, r.ob, r.fc.data_path, r.fc.array_index);
          return typeof v === 'number' ? v : typeof v === 'boolean' ? +v : undefined;
        });
        if (type.startsWith('CURSOR') && e.fromDispValue) {
          for (const r of c) {
            const k = r.fc.keyframe_points.find((kk) => Math.abs(kk.co[0] - frame) < 1e-3);
            if (k) K.moveKey(k, 0, e.fromDispValue(r, e.cursorValue ?? 0) - k.co[1]);
            K.finalizeCurve(r.fc);
          }
        }
      },
    },
    {
      idname: `${p}.frame_jump`,
      label: p === 'action' ? 'Jump to Keyframes' : 'Jump to Keyframes',
      description: 'Set the current frame to the average frame value of selected keyframes',
      poll: pollKeys,
      undo: false,
      exec: (ctx) => {
        const e = ed(ctx);
        let sx = 0,
          sy = 0,
          n = 0;
        for (const r of e.editCurves())
          for (const k of r.fc.keyframe_points)
            if (k.select_control_point) {
              sx += k.co[0];
              sy += e.toDispValue ? e.toDispValue(r, k.co[1]) : k.co[1];
              n++;
            }
        if (!n) return 'CANCELLED';
        app.setFrame(Math.round(sx / n));
        if (p === 'graph') e.cursorValue = sy / n;
      },
    },
    {
      idname: `${p}.view_all`,
      label: 'Frame All',
      description: 'Reset viewable area to show full keyframe range',
      poll,
      undo: false,
      exec: (ctx) => ed(ctx).viewAll(),
    },
    {
      idname: `${p}.view_selected`,
      label: 'Frame Selected',
      description: 'Reset viewable area to show selected keyframe range',
      poll,
      undo: false,
      exec: (ctx) => ed(ctx).viewSelected(),
    },
    {
      idname: `${p}.view_frame`,
      label: 'Go to Current Frame',
      description: 'Move the view to the current frame',
      poll,
      undo: false,
      exec: (ctx) => ed(ctx).centerCurrentFrame(),
    },
    {
      idname: `${p}.previewrange_set`,
      label: 'Set Preview Range to Selected',
      description: 'Set Preview Range based on extents of selected Keyframes',
      poll: pollKeys,
      exec: (ctx) => {
        const b = K.keyBounds(curves(ctx), true);
        if (!b) return 'CANCELLED';
        const s = ctx.doc.scene;
        s.use_preview_range = true;
        s.frame_preview_start = Math.floor(b.x0);
        s.frame_preview_end = Math.max(Math.ceil(b.x1), Math.floor(b.x0) + 1);
      },
    },
    {
      idname: `${p}.clean`,
      label: 'Clean Keyframes',
      description: 'Simplify F-Curves by removing closely spaced keyframes',
      props: [
        {
          id: 'threshold',
          label: 'Threshold',
          type: 'float',
          default: 0.001,
          min: 0,
          step: 0.001,
          precision: 3,
        },
        { id: 'channels', label: 'Channels', type: 'bool', default: false },
      ],
      poll: pollKeys,
      exec: (ctx, pr) => {
        const c = curves(ctx);
        K.cleanKeys(c, pr.threshold as number);
        if (pr.channels) {
          for (const r of c) {
            const k = r.fc.keyframe_points;
            if (k.length === 1 && Math.abs(k[0].co[1] - K.propertyDefault(r.fc.data_path, r.fc.array_index)) <= (pr.threshold as number) && !r.fc.modifiers.length)
              r.action.fcurves = r.action.fcurves.filter((f) => f !== r.fc);
          }
        }
      },
    },
    {
      idname: `${p}.transform`,
      label: 'Transform',
      description: 'Transform selected keyframes',
      props: [
        {
          id: 'mode',
          label: 'Mode',
          type: 'enum',
          default: p === 'action' ? 'TIME_TRANSLATE' : 'TRANSLATION',
          items:
            p === 'action'
              ? [
                  ['TIME_TRANSLATE', 'Time Translate'],
                  ['TIME_EXTEND', 'Time Extend'],
                  ['TIME_SCALE', 'Time Scale'],
                  ['TIME_SLIDE', 'Time Slide'],
                ]
              : [
                  ['TRANSLATION', 'Translate'],
                  ['ROTATION', 'Rotate'],
                  ['RESIZE', 'Resize'],
                  ['TIME_EXTEND', 'Time Extend'],
                ],
        },
        { id: 'value', label: 'Value', type: 'vec2', default: [0, 0] },
        {
          id: 'constraint',
          label: 'Constraint Axis',
          type: 'enum',
          default: 'NONE',
          items: [
            ['NONE', 'None'],
            ['X', 'X'],
            ['Y', 'Y'],
          ],
          showIf: () => p === 'graph',
        },
        {
          id: 'side',
          label: 'Side',
          type: 'enum',
          default: 'RIGHT',
          items: [
            ['LEFT', 'Left'],
            ['RIGHT', 'Right'],
          ],
          hidden: true,
        },
      ],
      poll: pollKeys,
      invoke: (ctx, pr) => {
        const e = ed(ctx);
        return e.startTransform(pr.mode as KeyTransformMode, { ...app.pointer }) ? 'RUNNING_MODAL' : 'CANCELLED';
      },
      exec: (ctx, pr) => {
        const e = ed(ctx);
        const mode = pr.mode as KeyTransformMode;
        const v = pr.value as [number, number];
        transformKeys(e.keyHost(), {
          mode,
          value: [v[0], mode === 'TIME_SCALE' ? 1 : v[1]],
          constraint: (pr.constraint as 'NONE') ?? 'NONE',
          side: pr.side as 'LEFT',
        });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Channel operators (shared by all animation editors)

function animEd(ctx: OpContext): AnimEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof AnimEditor ? ed : null;
}

/** F-Curves of selected channels (selected curves and curves in selected groups). */
export function selectedChannelCurves(ed: AnimEditor): CurveRef[] {
  return ed.list.curves.filter((r) => r.fc.select || (r.fc.group && channelState.selectedGroups.has(groupKey(r.action, r.fc.group))));
}

const settingProp: PropDef = {
  id: 'type',
  label: 'Type',
  type: 'enum',
  default: 'MUTE',
  items: [
    ['MUTE', 'Mute'],
    ['PROTECT', 'Lock'],
    ['VISIBLE', 'Visibility'],
  ],
};
const settingKey = (t: string) => (t === 'MUTE' ? 'mute' : t === 'PROTECT' ? 'lock' : 'hide') as 'mute' | 'lock' | 'hide';

function settingOp(idname: string, label: string, mode: 'TOGGLE' | 'ENABLE' | 'DISABLE'): Operator {
  return {
    idname,
    label,
    description: `${label} for the selected channels`,
    props: [settingProp],
    poll: (ctx) => !!animEd(ctx),
    exec: (ctx, pr) => {
      const ed = animEd(ctx)!;
      const c = selectedChannelCurves(ed);
      if (!c.length) return 'CANCELLED';
      const key = settingKey(pr.type as string);
      // visibility is stored inverted ("hide")
      const invert = key === 'hide';
      let value: boolean;
      if (mode === 'TOGGLE') value = !c.every((r) => !!r.fc[key] !== invert);
      else value = mode === 'ENABLE';
      for (const r of c) r.fc[key] = invert ? !value : value;
    },
  };
}

const channelOps: Operator[] = [
  {
    idname: 'anim.channels_select_all',
    label: 'Select All',
    description: 'Toggle selection of all animation channels',
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
    poll: (ctx) => !!animEd(ctx),
    exec: (ctx, pr) => {
      const ed = animEd(ctx)!;
      const rows = ed.list.rows.filter((r) => !['SUMMARY', 'OBJECT', 'ACTION', 'DRIVERS', 'NLA_ACTION'].includes(r.kind));
      let act = pr.action as string;
      if (act === 'TOGGLE') act = rows.some(channelSelected) ? 'DESELECT' : 'SELECT';
      for (const r of rows) setChannelSelected(r, act === 'SELECT' ? true : act === 'DESELECT' ? false : !channelSelected(r));
      if (act !== 'INVERT') for (const r of ed.list.curves) r.fc.select = act === 'SELECT';
    },
  },
  {
    idname: 'anim.channels_delete',
    label: 'Delete Channels',
    description: 'Delete all selected animation channels',
    poll: (ctx) => !!animEd(ctx),
    exec: (ctx) => {
      const ed = animEd(ctx)!;
      let n = 0;
      for (const r of selectedChannelCurves(ed)) {
        r.action.fcurves = r.action.fcurves.filter((f) => f !== r.fc);
        n++;
      }
      for (const ch of ed.list.rows) {
        if (ch.kind === 'DRIVER' && ch.ob?.animation_data && channelSelected(ch)) {
          ch.ob.animation_data.drivers = ch.ob.animation_data.drivers.filter((d) => d !== ch.driver);
          channelState.selectedDrivers.delete(ch.key);
          n++;
        }
        if (ch.kind === 'NLA_TRACK' && ch.track?.select && ch.ob?.animation_data) {
          ch.ob.animation_data.nla_tracks = ch.ob.animation_data.nla_tracks.filter((t) => t !== ch.track);
          n++;
        }
      }
      channelState.selectedGroups.clear();
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'anim.channels_group',
    label: 'Group Channels',
    description: 'Add selected F-Curves to a new group',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'New Group' }],
    poll: (ctx) => !!animEd(ctx),
    exec: (ctx, pr) => {
      const c = animEd(ctx)!.list.curves.filter((r) => r.fc.select);
      if (!c.length) return 'CANCELLED';
      for (const r of c) r.fc.group = String(pr.name || 'New Group');
    },
  },
  {
    idname: 'anim.channels_ungroup',
    label: 'Ungroup Channels',
    description: 'Remove selected F-Curves from their current groups',
    poll: (ctx) => !!animEd(ctx),
    exec: (ctx) => {
      const c = selectedChannelCurves(animEd(ctx)!);
      if (!c.length) return 'CANCELLED';
      for (const r of c) r.fc.group = undefined;
      channelState.selectedGroups.clear();
    },
  },
  settingOp('anim.channels_setting_toggle', 'Toggle Channel Setting', 'TOGGLE'),
  settingOp('anim.channels_setting_enable', 'Enable Channel Setting', 'ENABLE'),
  settingOp('anim.channels_setting_disable', 'Disable Channel Setting', 'DISABLE'),
  ...(['expand', 'collapse'] as const).map((which): Operator => ({
    idname: `anim.channels_${which}`,
    label: which === 'expand' ? 'Expand Channels' : 'Collapse Channels',
    description: `${which === 'expand' ? 'Expand (open)' : 'Collapse (close)'} all selected expandable animation channels`,
    props: [{ id: 'all', label: 'All', type: 'bool', default: true }],
    undo: false,
    poll: (ctx) => !!animEd(ctx),
    exec: (ctx, pr) => {
      const ed = animEd(ctx)!;
      // expanding reveals more rows; repeat until stable when expanding everything
      for (let pass = 0; pass < 4; pass++) {
        const rows = ed.list.rows.filter((r) => r.expandable && (pr.all || channelSelected(r)));
        let changed = false;
        for (const r of rows)
          if (isExpanded(r.key, r.kind) !== (which === 'expand')) {
            setExpanded(r.key, which === 'expand');
            changed = true;
          }
        ed.rebuild();
        if (!changed || which === 'collapse' || !pr.all) break;
      }
      ed.refresh();
    },
  })),
  {
    idname: 'anim.previewrange_clear',
    label: 'Clear Preview Range',
    description: 'Clear preview range',
    poll: (ctx) => !!ctx.doc.scene.use_preview_range,
    exec: (ctx) => {
      ctx.doc.scene.use_preview_range = false;
    },
  },
  {
    idname: 'anim.switch_editor',
    label: 'Toggle Editor',
    description: 'Switch between the Dope Sheet and the Graph Editor',
    props: [
      {
        id: 'type',
        label: 'Editor',
        type: 'enum',
        default: 'GRAPH',
        items: [
          ['GRAPH', 'Graph Editor'],
          ['DOPESHEET', 'Dope Sheet'],
        ],
      },
    ],
    undo: false,
    internal: true,
    poll: (ctx) => !!animEd(ctx),
    exec: (ctx, pr) => {
      const old = animEd(ctx)!;
      const area = old.area;
      const { x0, ppf } = old.view;
      area.setType(pr.type as EditorTypeId);
      const ne = area.editor;
      if (ne instanceof AnimEditor) {
        ne.view.x0 = x0;
        ne.view.ppf = ppf;
        (ne as unknown as { fitted: boolean }).fitted = true;
        if (pr.type === 'GRAPH') (ne as unknown as { fitValues?: () => void }).fitValues?.();
        ne.refresh();
      }
    },
  },
  {
    idname: 'anim.region_ui_toggle',
    label: 'Toggle Sidebar',
    description: 'Show or hide the sidebar',
    undo: false,
    internal: true,
    poll: (ctx) => !!animEd(ctx),
    exec: (ctx) => animEd(ctx)!.toggleSidebar(),
  },
];

registerOperators([...keyOps('action'), ...keyOps('graph'), ...channelOps]);

// ---------------------------------------------------------------------------
// Keymaps

const insertMenu = (p: Prefix) => (): MenuItem[] =>
  p === 'action'
    ? [
        {
          label: 'All Channels',
          op: 'action.keyframe_insert',
          props: { type: 'ALL' },
        },
        {
          label: 'Only Selected Channels',
          op: 'action.keyframe_insert',
          props: { type: 'SEL' },
        },
        {
          label: 'In Active Group',
          op: 'action.keyframe_insert',
          props: { type: 'GROUP' },
        },
      ]
    : [
        {
          label: 'All Channels',
          op: 'graph.keyframe_insert',
          props: { type: 'ALL' },
        },
        {
          label: 'Only Selected Channels',
          op: 'graph.keyframe_insert',
          props: { type: 'SEL' },
        },
        {
          label: 'Only Active F-Curve',
          op: 'graph.keyframe_insert',
          props: { type: 'ACTIVE' },
        },
        { separator: true },
        {
          label: 'Active Channels at Cursor',
          op: 'graph.keyframe_insert',
          props: { type: 'CURSOR_ACTIVE' },
        },
        {
          label: 'Selected Channels at Cursor',
          op: 'graph.keyframe_insert',
          props: { type: 'CURSOR_SEL' },
        },
      ];

const settingsMenu = (op: string) => (): MenuItem[] => {
  const graph = hoverEditor()?.space() === 'GRAPH';
  const items: MenuItem[] = [
    { label: 'Mute', op, props: { type: 'MUTE' } },
    { label: 'Lock', op, props: { type: 'PROTECT' } },
  ];
  if (graph) items.push({ label: 'Visibility', op, props: { type: 'VISIBLE' } });
  return items;
};

addKeys('Animation Channels', [
  {
    key: 'A',
    op: 'anim.channels_select_all',
    props: { action: 'SELECT' },
    when: overChannels,
  },
  {
    key: 'A',
    alt: true,
    op: 'anim.channels_select_all',
    props: { action: 'DESELECT' },
    when: overChannels,
  },
  {
    key: 'I',
    ctrl: true,
    op: 'anim.channels_select_all',
    props: { action: 'INVERT' },
    when: overChannels,
  },
  { key: 'X', op: 'anim.channels_delete', when: overChannels },
  { key: 'DEL', op: 'anim.channels_delete', when: overChannels },
  { key: 'G', ctrl: true, op: 'anim.channels_group', when: overChannels },
  {
    key: 'G',
    ctrl: true,
    alt: true,
    op: 'anim.channels_ungroup',
    when: overChannels,
  },
  {
    key: 'W',
    shift: true,
    menu: settingsMenu('anim.channels_setting_toggle'),
    menuTitle: 'Toggle Channel Setting',
    when: overChannels,
  },
  {
    key: 'W',
    shift: true,
    ctrl: true,
    menu: settingsMenu('anim.channels_setting_enable'),
    menuTitle: 'Enable Channel Setting',
    when: overChannels,
  },
  {
    key: 'W',
    alt: true,
    menu: settingsMenu('anim.channels_setting_disable'),
    menuTitle: 'Disable Channel Setting',
    when: overChannels,
  },
  {
    key: 'NUMPAD_PLUS',
    op: 'anim.channels_expand',
    props: { all: false },
    when: overChannels,
  },
  {
    key: 'NUMPAD_MINUS',
    op: 'anim.channels_collapse',
    props: { all: false },
    when: overChannels,
  },
  {
    key: 'NUMPAD_PLUS',
    ctrl: true,
    op: 'anim.channels_expand',
    props: { all: true },
    when: overChannels,
  },
  {
    key: 'NUMPAD_MINUS',
    ctrl: true,
    op: 'anim.channels_collapse',
    props: { all: true },
    when: overChannels,
  },
]);

const overMarkers = () => hoverEditor()?.hover === 'markers';
addKeys('Animation', [
  { key: 'P', alt: true, op: 'anim.previewrange_clear' },
  { key: 'M', op: 'marker.add' },
  { key: 'B', ctrl: true, op: 'marker.camera_bind' },
]);
addKeys('Markers', [
  { key: 'F2', op: 'marker.rename', when: overMarkers },
  { key: 'G', op: 'marker.move', when: overMarkers },
  { key: 'D', shift: true, op: 'marker.duplicate', when: overMarkers },
  { key: 'X', op: 'marker.delete', when: overMarkers },
  { key: 'DEL', op: 'marker.delete', props: { confirm: false }, when: overMarkers },
  { key: 'A', op: 'marker.select_all', props: { action: 'SELECT' }, when: overMarkers },
  { key: 'A', alt: true, op: 'marker.select_all', props: { action: 'DESELECT' }, when: overMarkers },
  { key: 'I', ctrl: true, op: 'marker.select_all', props: { action: 'INVERT' }, when: overMarkers },
  { key: 'B', op: 'marker.select_box', when: overMarkers },
  { key: 'LEFT_BRACKET', op: 'marker.select_leftright', props: { mode: 'LEFT' }, when: overMarkers },
  { key: 'RIGHT_BRACKET', op: 'marker.select_leftright', props: { mode: 'RIGHT' }, when: overMarkers },
]);

function keyEditorKeys(p: Prefix, name: string) {
  const items: KeyItem[] = [
    {
      key: 'A',
      op: `${p}.select_all`,
      props: { action: 'SELECT' },
      when: overMain,
    },
    {
      key: 'A',
      alt: true,
      op: `${p}.select_all`,
      props: { action: 'DESELECT' },
      when: overMain,
    },
    {
      key: 'I',
      ctrl: true,
      op: `${p}.select_all`,
      props: { action: 'INVERT' },
      when: overMain,
    },
    { key: 'B', op: `${p}.select_box`, when: overMain },
    { key: 'K', op: `${p}.select_column`, props: { mode: 'KEYS' } },
    { key: 'K', ctrl: true, op: `${p}.select_column`, props: { mode: 'CFRA' } },
    {
      key: 'K',
      shift: true,
      op: `${p}.select_column`,
      props: { mode: 'MARKERS_COLUMN' },
    },
    {
      key: 'K',
      alt: true,
      op: `${p}.select_column`,
      props: { mode: 'MARKERS_BETWEEN' },
    },
    {
      key: 'LEFT_BRACKET',
      op: `${p}.select_leftright`,
      props: { mode: 'LEFT' },
    },
    {
      key: 'RIGHT_BRACKET',
      op: `${p}.select_leftright`,
      props: { mode: 'RIGHT' },
    },
    { key: 'NUMPAD_PLUS', ctrl: true, op: `${p}.select_more`, when: overMain },
    { key: 'NUMPAD_MINUS', ctrl: true, op: `${p}.select_less`, when: overMain },
    { key: 'L', ctrl: true, op: `${p}.select_linked` },
    {
      key: 'E',
      op: `${p}.transform`,
      props: { mode: 'TIME_EXTEND' },
      when: overMain,
    },
    {
      key: 'T',
      menu: () => interpolationMenu(p),
      menuTitle: 'Set Keyframe Interpolation',
    },
    {
      key: 'V',
      menu: () => handleMenu(p),
      menuTitle: 'Set Keyframe Handle Type',
    },
    {
      key: 'E',
      ctrl: true,
      menu: () => easingMenu(p),
      menuTitle: 'Set Keyframe Easing Type',
    },
    {
      key: 'E',
      shift: true,
      menu: () => extrapolationMenu(p),
      menuTitle: 'Set F-Curve Extrapolation',
    },
    { key: 'X', op: `${p}.delete`, when: overMain },
    {
      key: 'DEL',
      op: `${p}.delete`,
      props: { confirm: false },
      when: overMain,
    },
    { key: 'D', shift: true, op: `${p}.duplicate_move`, when: overMain },
    { key: 'C', ctrl: true, op: `${p}.copy` },
    { key: 'V', ctrl: true, op: `${p}.paste` },
    {
      key: 'V',
      ctrl: true,
      shift: true,
      op: `${p}.paste`,
      props: { flipped: true },
    },
    { key: 'I', menu: insertMenu(p), menuTitle: 'Insert Keyframes' },
    { key: 'M', ctrl: true, menu: () => mirrorMenu(p), menuTitle: 'Mirror' },
    { key: 'S', shift: true, menu: () => snapMenu(p), menuTitle: 'Snap' },
    { key: 'G', ctrl: true, op: `${p}.frame_jump`, when: overMain },
    { key: 'HOME', op: `${p}.view_all` },
    { key: 'NUMPAD_PERIOD', op: `${p}.view_selected` },
    { key: 'NUMPAD_0', op: `${p}.view_frame` },
    { key: 'P', ctrl: true, alt: true, op: `${p}.previewrange_set` },
    {
      key: 'TAB',
      ctrl: true,
      op: 'anim.switch_editor',
      props: { type: p === 'action' ? 'GRAPH' : 'DOPESHEET' },
    },
  ];
  if (p === 'action') {
    items.push(
      {
        key: 'G',
        op: 'action.transform',
        props: { mode: 'TIME_TRANSLATE' },
        when: overMain,
      },
      {
        key: 'S',
        op: 'action.transform',
        props: { mode: 'TIME_SCALE' },
        when: overMain,
      },
      {
        key: 'R',
        menu: () => keyTypeMenu('action'),
        menuTitle: 'Set Keyframe Type',
      },
      { key: 'N', op: 'anim.region_ui_toggle' },
    );
  } else {
    items.push(
      {
        key: 'G',
        op: 'graph.transform',
        props: { mode: 'TRANSLATION' },
        when: overMain,
      },
      {
        key: 'R',
        op: 'graph.transform',
        props: { mode: 'ROTATION' },
        when: overMain,
      },
      {
        key: 'S',
        op: 'graph.transform',
        props: { mode: 'RESIZE' },
        when: overMain,
      },
      { key: 'H', op: 'graph.hide' },
      { key: 'H', shift: true, op: 'graph.hide', props: { unselected: true } },
      { key: 'H', alt: true, op: 'graph.reveal' },
      { key: 'H', ctrl: true, op: 'graph.toggle_handles' },
      { key: 'N', op: 'anim.region_ui_toggle' },
      { key: 'L', op: 'graph.select_linked_pick', when: overMain },
      {
        key: 'L',
        shift: true,
        op: 'graph.select_linked_pick',
        props: { deselect: true },
        when: overMain,
      },
    );
  }
  addKeys(name, items);
}

keyEditorKeys('action', 'Dopesheet');
keyEditorKeys('graph', 'Graph Editor');
