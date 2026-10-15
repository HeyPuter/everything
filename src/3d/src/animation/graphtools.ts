// Graph Editor key shaping operators: the blend/ease slider tools (Alt+D), smoothing
// (Alt+S, Alt+O), decimate, bake keys (Shift+Alt+O), Euler filter, equalize handles,
// key/handle selection, click-insert, 2D cursor, F-Modifier clipboard, ghost curves
// and local view.
import { app, registerOperators, type ModalHandler, type OpContext, type Operator, type PropDef } from '../app/app';
import { addKeys } from '../app/keymap';
import type { FCurve, FModifier } from '../data/types';
import { insertKeyframe, evaluateFCurve } from '../anim/fcurve';
import { AnimEditor, overMain } from './animeditor';
import type { CurveRef } from './channels';
import { cloneKey, finalizeCurve, isKeySelected, setKeySelected } from './keyedit';
import * as T from './fcurvetools';
import { GraphEditor, MOD_TYPES, curveId } from './graph';
import { blendMenu, smoothMenu, type Prefix } from './menus';

function graphEd(ctx: OpContext): GraphEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof GraphEditor ? ed : null;
}
/** Dope Sheet or Graph Editor (key editors). */
function keyEd(ctx: OpContext): (AnimEditor & { prefix: Prefix }) | null {
  const ed = ctx.area?.editor;
  return ed instanceof AnimEditor && 'prefix' in ed ? (ed as AnimEditor & { prefix: Prefix }) : null;
}

const anySel = (curves: CurveRef[]) => curves.some((r) => r.fc.keyframe_points.some(isKeySelected));
const pollGraphKeys = (ctx: OpContext) => {
  const ed = graphEd(ctx);
  return !!ed && anySel(ed.editCurves());
};
const pollKeys = (ctx: OpContext) => {
  const ed = keyEd(ctx);
  return !!ed && anySel(ed.editCurves());
};

// ---------------------------------------------------------------------------
// Slider modal

interface SliderSpec {
  label: string;
  idname: string;
  /** property that the slider drives */
  prop: string;
  initial: number;
  /** soft range (the slider readout); overshoot (E) lifts it */
  min: number;
  max: number;
  frames?: boolean;
  props: Record<string, unknown>;
  apply: (value: number, props: Record<string, unknown>) => string[] | void;
}

/** Interactive slider: drag horizontally to set the value, LMB/Enter confirms, RMB/Esc cancels. */
export function startSlider(ed: AnimEditor, spec: SliderSpec): boolean {
  const curves = ed.editCurves().filter((r) => r.fc.keyframe_points.some(isKeySelected));
  if (!curves.length) return false;
  const fcs = [...new Set(curves.map((r) => r.fc))];
  const snap = new Map<FCurve, ReturnType<typeof cloneKey>[]>(fcs.map((fc) => [fc, fc.keyframe_points.map(cloneKey)]));
  const restore = () => {
    for (const [fc, keys] of snap) fc.keyframe_points = keys.map(cloneKey);
  };
  const x0 = app.pointer.x;
  let value = spec.initial;
  let overshoot = false;
  let precise = false;
  let base = spec.initial,
    baseX = x0;
  let numeric = '';
  let warnings: string[] = [];
  const pxPerUnit = spec.frames ? Math.max(1, ed.view.ppf) : 250;
  const clamp = (v: number) => (overshoot || spec.frames ? v : Math.max(spec.min, Math.min(spec.max, v)));
  const fmt = () => (spec.frames ? `${value.toFixed(2)} frames` : `${Math.round(value * 100)}%`);
  const update = (snapStep: boolean) => {
    if (numeric && numeric !== '-' && Number.isFinite(Number(numeric))) value = spec.frames ? Number(numeric) : Number(numeric) / 100;
    else if (snapStep) value = spec.frames ? Math.round(value) : Math.round(value * 10) / 10;
    value = clamp(value);
    restore();
    warnings = (spec.apply(value, spec.props) as string[] | undefined) ?? [];
    ed.overlay = {
      slider: {
        label: spec.label,
        text: fmt() + (numeric ? ` [${numeric}|]` : '') + (overshoot ? ' (overshoot)' : ''),
        t: spec.frames ? null : (value - spec.min) / (spec.max - spec.min),
        t0: spec.min < 0 ? -spec.min / (spec.max - spec.min) : 0,
      },
    };
    app.changed('doc');
  };
  const handler: ModalHandler = {
    label: spec.label,
    cursor: 'ew-resize',
    header: () => `${spec.label}: ${fmt()}`,
    status: () => [
      ['LMB/Enter', 'Confirm'],
      ['RMB/Esc', 'Cancel'],
      ['Ctrl', 'Increments'],
      ['Shift', 'Precision'],
      ...(spec.frames ? [] : ([['E', 'Overshoot']] as [string, string][])),
    ],
    onPointerMove(e) {
      if (e.shiftKey !== precise) {
        precise = e.shiftKey;
        base = value;
        baseX = e.clientX;
      }
      value = base + ((e.clientX - baseX) / pxPerUnit) * (precise ? 0.1 : 1);
      numeric = '';
      update(e.ctrlKey || e.metaKey);
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (e.type !== 'keydown') return true;
      if (e.code === 'KeyE' && !spec.frames) {
        overshoot = !overshoot;
        update(false);
      } else if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !numeric)) {
        numeric += e.key;
        update(false);
      } else if (e.key === 'Backspace') {
        numeric = numeric.slice(0, -1);
        update(false);
      }
      return true;
    },
    cancel() {
      restore();
      ed.overlay = null;
      app.changed('doc');
    },
    finish() {
      ed.overlay = null;
      for (const fc of fcs) finalizeCurve(fc, false);
      for (const w of warnings) app.report('WARNING', w);
      handler.redoOp = { idname: spec.idname, props: { ...spec.props, [spec.prop]: value } };
    },
  };
  app.startModal(handler);
  update(false);
  return true;
}

// ---------------------------------------------------------------------------
// Blend tools

interface BlendDef {
  idname: string;
  label: string;
  tool: T.BlendTool;
  description: string;
  /** default property value (scripting / redo) and the neutral slider start */
  def: number;
  start: number;
  range: [number, number];
  extra?: PropDef[];
}

const factorProp = (def: number): PropDef => ({ id: 'factor', label: 'Factor', type: 'float', default: def, softMin: -1, softMax: 2, step: 0.01, precision: 3, subtype: 'factor' });

const BLENDS: BlendDef[] = [
  { idname: 'graph.breakdown', label: 'Breakdown', tool: 'BREAKDOWN', description: 'Move the selected keys to a value between the neighbouring keys', def: 0, start: 0, range: [-1, 1] },
  { idname: 'graph.blend_to_neighbor', label: 'Blend to Neighbor', tool: 'BLEND_TO_NEIGHBOR', description: 'Blend the selected keys towards the key before (negative) or after (positive) them', def: 0, start: 0, range: [-1, 1] },
  { idname: 'graph.blend_to_default', label: 'Blend to Default Value', tool: 'BLEND_TO_DEFAULT', description: 'Blend the selected keys towards the default value of their property', def: 0, start: 0, range: [-1, 1] },
  {
    idname: 'graph.ease',
    label: 'Ease Keyframes',
    tool: 'EASE',
    description: 'Lay the selected keys out on an S-shaped ease between the neighbouring keys',
    def: 0,
    start: 0,
    range: [-1, 1],
    extra: [{ id: 'sharpness', label: 'Sharpness', type: 'float', default: 2, min: 0.001, softMax: 10, step: 0.1 }],
  },
  { idname: 'graph.blend_offset', label: 'Blend Offset Keyframes', tool: 'BLEND_OFFSET', description: 'Shift the selected keys so they line up with the key before (negative) or after (positive) them', def: 0, start: 0, range: [-1, 1] },
  { idname: 'graph.blend_to_ease', label: 'Blend to Ease Keyframes', tool: 'BLEND_TO_EASE', description: 'Blend the selected keys towards an ease-in (negative) or ease-out (positive) curve', def: 0, start: 0, range: [-1, 1] },
  { idname: 'graph.match_slope', label: 'Match Slope', tool: 'MATCH_SLOPE', description: 'Blend the selected keys towards the slope of the keys before (negative) or after (positive) them', def: 0, start: 0, range: [-1, 1] },
  { idname: 'graph.push_pull', label: 'Push Pull Keyframes', tool: 'PUSH_PULL', description: 'Exaggerate (above 100%) or flatten (below 100%) the selected keys relative to the line between their neighbours', def: 1, start: 1, range: [0, 2] },
  {
    idname: 'graph.shear',
    label: 'Shear Keyframes',
    tool: 'SHEAR',
    description: 'Tilt the selected keys, keeping one neighbouring key as the pivot',
    def: 0,
    start: 0,
    range: [-1, 1],
    extra: [
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'FROM_LEFT',
        items: [
          ['FROM_LEFT', 'From Left'],
          ['FROM_RIGHT', 'From Right'],
        ],
      },
    ],
  },
  { idname: 'graph.scale_average', label: 'Scale Average Keyframes', tool: 'SCALE_AVERAGE', description: 'Scale the selected keys towards (below 100%) or away from (above 100%) their average value', def: 1, start: 1, range: [0, 2] },
  {
    idname: 'graph.scale_from_neighbor',
    label: 'Scale from Neighbor',
    tool: 'SCALE_FROM_NEIGHBOR',
    description: 'Scale the selected keys towards the neighbouring key on the chosen side',
    def: 0,
    start: 1,
    range: [-1, 2],
    extra: [
      {
        id: 'anchor',
        label: 'Reference Key',
        type: 'enum',
        default: 'LEFT',
        items: [
          ['LEFT', 'From Left'],
          ['RIGHT', 'From Right'],
        ],
      },
    ],
  },
];

function blendOptions(p: Record<string, unknown>): T.BlendOptions {
  return { sharpness: p.sharpness as number, direction: p.direction as 'FROM_LEFT', anchor: p.anchor as 'LEFT' };
}

const blendOps: Operator[] = BLENDS.map((b) => ({
  idname: b.idname,
  label: b.label,
  description: b.description,
  props: [factorProp(b.def), ...(b.extra ?? [])],
  poll: pollGraphKeys,
  invoke: (ctx, p) => {
    const ed = graphEd(ctx)!;
    return startSlider(ed, {
      label: b.label,
      idname: b.idname,
      prop: 'factor',
      initial: b.start,
      min: b.range[0],
      max: b.range[1],
      props: p,
      apply: (v, pr) => T.applyBlend(ed.editCurves(), b.tool, v, blendOptions(pr)),
    })
      ? 'RUNNING_MODAL'
      : 'CANCELLED';
  },
  exec: (ctx, p) => {
    const ed = graphEd(ctx)!;
    const w = T.applyBlend(ed.editCurves(), b.tool, p.factor as number, blendOptions(p));
    for (const m of w) app.report('WARNING', m);
    for (const r of ed.editCurves()) if (r.fc.keyframe_points.some(isKeySelected)) finalizeCurve(r.fc, false);
  },
}));

const timeOffsetOp: Operator = {
  idname: 'graph.time_offset',
  label: 'Time Offset Keyframes',
  description: 'Shift the curve under the selected keys in time, keeping the keys on their frames',
  props: [{ id: 'frame_offset', label: 'Frame Offset', type: 'float', default: 0, step: 0.1, precision: 2 }],
  poll: pollGraphKeys,
  invoke: (ctx, p) => {
    const ed = graphEd(ctx)!;
    return startSlider(ed, {
      label: 'Time Offset',
      idname: 'graph.time_offset',
      prop: 'frame_offset',
      initial: 0,
      min: -1e9,
      max: 1e9,
      frames: true,
      props: p,
      apply: (v) => T.applyBlend(ed.editCurves(), 'TIME_OFFSET', v),
    })
      ? 'RUNNING_MODAL'
      : 'CANCELLED';
  },
  exec: (ctx, p) => {
    T.applyBlend(graphEd(ctx)!.editCurves(), 'TIME_OFFSET', p.frame_offset as number);
  },
};

// ---------------------------------------------------------------------------
// Smoothing / density / misc key tools

const curvesOf = (ctx: OpContext) => keyEd(ctx)!.editCurves();

const toolOps: Operator[] = [
  {
    idname: 'graph.smooth',
    label: 'Smooth Keys',
    description: 'Even out the values of the selected keys with a moving average (the outer keys of each run stay)',
    poll: pollGraphKeys,
    exec: (ctx) => {
      if (!T.smoothKeys(curvesOf(ctx))) {
        app.report('WARNING', 'Select at least three consecutive keys to smooth');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'graph.gaussian_smooth',
    label: 'Gaussian Smooth',
    description: 'Smooth the selected keys with a Gaussian filter over the surrounding frames',
    props: [
      { id: 'factor', label: 'Factor', type: 'float', default: 1, min: 0, softMax: 1, step: 0.01, subtype: 'factor' },
      { id: 'sigma', label: 'Sigma', type: 'float', default: 0.33, min: 0.001, softMax: 1, step: 0.01, precision: 3 },
      { id: 'filter_width', label: 'Filter Width', type: 'int', default: 6, min: 1, max: 64 },
    ],
    poll: pollGraphKeys,
    invoke: (ctx, p) => {
      const ed = graphEd(ctx)!;
      return startSlider(ed, {
        label: 'Gaussian Smooth',
        idname: 'graph.gaussian_smooth',
        prop: 'factor',
        initial: 0,
        min: 0,
        max: 1,
        props: p,
        apply: (v, pr) => void T.gaussianSmooth(ed.editCurves(), v, pr.sigma as number, pr.filter_width as number),
      })
        ? 'RUNNING_MODAL'
        : 'CANCELLED';
    },
    exec: (ctx, p) => {
      T.gaussianSmooth(curvesOf(ctx), p.factor as number, p.sigma as number, p.filter_width as number);
    },
  },
  {
    idname: 'graph.butterworth_smooth',
    label: 'Butterworth Smooth',
    description: 'Remove high-frequency jitter from the selected keys with a low-pass filter that keeps the overall motion',
    props: [
      { id: 'cutoff_frequency', label: 'Frequency Cutoff (Hz)', type: 'float', default: 3, min: 0, softMax: 24, step: 0.1 },
      { id: 'filter_order', label: 'Filter Order', type: 'int', default: 4, min: 1, max: 32 },
      { id: 'samples_per_frame', label: 'Samples per Frame', type: 'int', default: 1, min: 1, max: 64 },
      { id: 'blend', label: 'Blend', type: 'float', default: 1, min: 0, softMax: 1, step: 0.01, subtype: 'factor' },
      { id: 'blend_in_out', label: 'Blend In/Out', type: 'int', default: 1, min: 0 },
    ],
    poll: pollGraphKeys,
    invoke: (ctx, p) => {
      const ed = graphEd(ctx)!;
      const opts = (pr: Record<string, unknown>, blend: number) => ({
        cutoff: pr.cutoff_frequency as number,
        order: pr.filter_order as number,
        samplesPerFrame: pr.samples_per_frame as number,
        blend,
        blendInOut: pr.blend_in_out as number,
        fps: app.doc.scene.render.fps / (app.doc.scene.render.fps_base || 1),
      });
      return startSlider(ed, {
        label: 'Butterworth Smooth',
        idname: 'graph.butterworth_smooth',
        prop: 'blend',
        initial: 0,
        min: 0,
        max: 1,
        props: p,
        apply: (v, pr) => void T.butterworthSmooth(ed.editCurves(), opts(pr, v)),
      })
        ? 'RUNNING_MODAL'
        : 'CANCELLED';
    },
    exec: (ctx, p) => {
      const s = ctx.doc.scene;
      T.butterworthSmooth(curvesOf(ctx), {
        cutoff: p.cutoff_frequency as number,
        order: p.filter_order as number,
        samplesPerFrame: p.samples_per_frame as number,
        blend: p.blend as number,
        blendInOut: p.blend_in_out as number,
        fps: s.render.fps / (s.render.fps_base || 1),
      });
    },
  },
  {
    idname: 'graph.decimate',
    label: 'Decimate Keyframes',
    description: 'Remove the selected keys that matter least to the shape of the curve',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'RATIO',
        items: [
          ['RATIO', 'Ratio', 'Remove a fraction of the selected keys'],
          ['ERROR', 'Error Margin', 'Remove keys while the curve stays within the margin'],
        ],
      },
      { id: 'factor', label: 'Remove', type: 'float', default: 1 / 3, min: 0, max: 1, step: 0.01, subtype: 'factor', showIf: (p) => p.mode === 'RATIO' },
      { id: 'remove_error_margin', label: 'Max Error Margin', type: 'float', default: 0, min: 0, step: 0.01, precision: 3, showIf: (p) => p.mode === 'ERROR' },
    ],
    poll: pollGraphKeys,
    invoke: (ctx, p) => {
      const ed = graphEd(ctx)!;
      if (p.mode !== 'RATIO') {
        T.decimateKeys(ed.editCurves(), 'ERROR', p.factor as number, p.remove_error_margin as number);
        return 'FINISHED';
      }
      return startSlider(ed, {
        label: 'Decimate Keyframes',
        idname: 'graph.decimate',
        prop: 'factor',
        initial: 0,
        min: 0,
        max: 1,
        props: p,
        apply: (v) => void T.decimateKeys(ed.editCurves(), 'RATIO', v),
      })
        ? 'RUNNING_MODAL'
        : 'CANCELLED';
    },
    exec: (ctx, p) => {
      T.decimateKeys(curvesOf(ctx), p.mode as 'RATIO', p.factor as number, p.remove_error_margin as number);
    },
  },
  ...(['graph', 'action'] as const).map(
    (pre): Operator => ({
      idname: `${pre}.bake_keys`,
      label: 'Bake Keyframes',
      description: 'Add a key on every frame between the first and last selected key of each curve',
      poll: (ctx) => pollKeys(ctx) && keyEd(ctx)!.prefix === pre,
      exec: (ctx) => {
        if (!T.bakeKeys(curvesOf(ctx))) return 'CANCELLED';
      },
    }),
  ),
  {
    idname: 'graph.euler_filter',
    label: 'Discontinuity (Euler) Filter',
    description: 'Fix sudden jumps of a full turn in Euler rotation curves (selected curves, or curves with selected keys)',
    poll: (ctx) => !!keyEd(ctx),
    exec: (ctx) => {
      const c = keyEd(ctx)!.editCurves().filter((r) => r.fc.select || r.fc.keyframe_points.some(isKeySelected));
      if (!T.eulerCurves(c).length) {
        app.report('ERROR', 'No Euler rotation F-Curves selected');
        return 'CANCELLED';
      }
      const n = T.eulerFilter(c);
      app.report('INFO', n ? `Filtered ${n} F-Curve${n === 1 ? '' : 's'}` : 'No discontinuities found');
    },
  },
  {
    idname: 'graph.equalize_handles',
    label: 'Equalize Handles',
    description: 'Give the handles of the selected keys the same length (optionally flat)',
    props: [
      {
        id: 'side',
        label: 'Side',
        type: 'enum',
        default: 'LEFT',
        items: [
          ['LEFT', 'Left'],
          ['RIGHT', 'Right'],
          ['BOTH', 'Both'],
        ],
      },
      { id: 'handle_length', label: 'Handle Length', type: 'float', default: 5, min: 0.1, step: 0.1 },
      { id: 'flatten', label: 'Flatten', type: 'bool', default: false },
    ],
    poll: pollGraphKeys,
    exec: (ctx, p) => {
      T.equalizeHandles(curvesOf(ctx), p.side as 'LEFT', p.handle_length as number, !!p.flatten);
    },
  },
  {
    idname: 'graph.select_key_handles',
    label: 'Select Key / Handles',
    description: 'For keys with anything selected, change which of the key point and its handles are selected',
    props: [
      { id: 'left_handle_action', label: 'Left Handle', type: 'enum', default: 'SELECT', items: selActs() },
      { id: 'right_handle_action', label: 'Right Handle', type: 'enum', default: 'SELECT', items: selActs() },
      { id: 'key_action', label: 'Key', type: 'enum', default: 'KEEP', items: selActs() },
    ],
    poll: (ctx) => !!graphEd(ctx),
    exec: (ctx, p) => {
      if (!T.selectKeyHandles(graphEd(ctx)!.visibleCurves(), p.left_handle_action as 'KEEP', p.right_handle_action as 'KEEP', p.key_action as 'KEEP')) return 'CANCELLED';
    },
  },
];

function selActs(): [string, string][] {
  return [
    ['SELECT', 'Select'],
    ['DESELECT', 'Deselect'],
    ['KEEP', 'Keep'],
  ];
}

// ---------------------------------------------------------------------------
// Cursor / click insert

const cursorOps: Operator[] = [
  {
    idname: 'graph.cursor_set',
    label: 'Set Cursor',
    description: 'Place the playhead and 2D cursor value at the mouse position (drag to keep moving it)',
    props: [
      { id: 'frame', label: 'Frame', type: 'float', default: 0 },
      { id: 'value', label: 'Value', type: 'float', default: 0 },
    ],
    undo: false,
    poll: (ctx) => !!graphEd(ctx),
    invoke: (ctx) => {
      const ed = graphEd(ctx)!;
      const set = (cx: number, cy: number) => {
        const p = ed.local({ clientX: cx, clientY: cy });
        app.run('graph.cursor_set', { frame: ed.view.xf(p.x), value: ed.cursorValueAt(p.y) }, { area: ed.area, invoke: false });
      };
      set(app.pointer.x, app.pointer.y);
      const move = (e: PointerEvent) => set(e.clientX, e.clientY);
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const ed = graphEd(ctx)!;
      app.setFrame(Math.round(p.frame as number));
      ed.cursorValue = p.value as number;
      ed.draw();
    },
  },
  {
    idname: 'graph.click_insert',
    label: 'Click-Insert Keyframes',
    description: 'Insert a key on the active F-Curve at the clicked frame and value',
    props: [
      { id: 'frame', label: 'Frame', type: 'float', default: 1 },
      { id: 'value', label: 'Value', type: 'float', default: 1 },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: (ctx) => !!graphEd(ctx)?.activeCurve(),
    exec: (ctx, p) => {
      const ed = graphEd(ctx)!;
      const r = ed.activeCurve();
      if (!r || r.fc.lock) {
        app.report('WARNING', 'No active F-Curve to add a keyframe to');
        return 'CANCELLED';
      }
      if (!p.extend) for (const c of ed.editCurves()) c.fc.keyframe_points.forEach((k) => setKeySelected(k, false));
      const k = insertKeyframe(r.fc, p.frame as number, ed.fromDisp(r.fc, p.value as number), { type: ctx.doc.scene.tool_settings.keyframe_type });
      setKeySelected(k, true);
      finalizeCurve(r.fc);
    },
  },
];

// ---------------------------------------------------------------------------
// F-Modifier clipboard

let modClipboard: FModifier[] | null = null;

const modifierOps: Operator[] = [
  {
    idname: 'graph.fmodifier_copy',
    label: 'Copy F-Modifiers',
    description: 'Copy the modifiers of the active F-Curve',
    undo: false,
    poll: (ctx) => !!graphEd(ctx)?.activeCurve()?.fc.modifiers.length,
    exec: (ctx) => {
      modClipboard = structuredClone(graphEd(ctx)!.activeCurve()!.fc.modifiers);
    },
  },
  {
    idname: 'graph.fmodifier_paste',
    label: 'Paste F-Modifiers',
    description: 'Add copied modifiers to the selected F-Curves',
    props: [
      { id: 'only_active', label: 'Only Active', type: 'bool', default: false },
      { id: 'replace', label: 'Replace Existing', type: 'bool', default: false },
    ],
    poll: (ctx) => !!graphEd(ctx) && !!modClipboard,
    exec: (ctx, p) => {
      const ed = graphEd(ctx)!;
      const targets = p.only_active ? [ed.activeCurve()].filter((r): r is CurveRef => !!r) : ed.editCurves().filter((r) => r.fc.select);
      if (!targets.length) return 'CANCELLED';
      for (const r of targets) {
        if (p.replace) r.fc.modifiers = [];
        for (const m of structuredClone(modClipboard!)) {
          if (m.type === 'CYCLES' && r.fc.modifiers.some((o) => o.type === 'CYCLES')) continue;
          r.fc.modifiers.push(m);
        }
      }
    },
  },
  {
    idname: 'graph.fmodifier_delete',
    label: 'Delete F-Curve Modifiers',
    description: 'Remove modifiers from the selected F-Curves',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'ALL',
        items: [
          ['ALL', 'All', 'Remove every modifier'],
          ['FIRST', 'First', 'Remove the first modifier of each curve'],
          ['TYPE', 'Type', 'Remove modifiers of one type'],
        ],
      },
      { id: 'type', label: 'Type', type: 'enum', default: 'GENERATOR', items: MOD_TYPES, showIf: (p) => p.mode === 'TYPE' },
    ],
    poll: (ctx) => !!graphEd(ctx)?.editCurves().some((r) => r.fc.select && r.fc.modifiers.length),
    exec: (ctx, p) => {
      let n = 0;
      for (const r of graphEd(ctx)!.editCurves()) {
        if (!r.fc.select || !r.fc.modifiers.length) continue;
        const before = r.fc.modifiers.length;
        if (p.mode === 'ALL') r.fc.modifiers = [];
        else if (p.mode === 'FIRST') r.fc.modifiers = r.fc.modifiers.slice(1);
        else r.fc.modifiers = r.fc.modifiers.filter((m) => m.type !== p.type);
        n += before - r.fc.modifiers.length;
      }
      if (!n) return 'CANCELLED';
    },
  },
];

// ---------------------------------------------------------------------------
// Ghost curves / local view (view state of the editor, not undoable)

const viewOps: Operator[] = [
  {
    idname: 'graph.ghost_curves_create',
    label: 'Create Ghost Curves',
    description: 'Keep a faded snapshot of the visible curves for reference while editing',
    undo: false,
    poll: (ctx) => !!graphEd(ctx)?.visibleCurves().length,
    exec: (ctx) => {
      const ed = graphEd(ctx)!;
      const W = ed.view.width || 800;
      const a = ed.view.xf(-W),
        b = ed.view.xf(2 * W);
      const step = Math.max(0.25, (b - a) / 1200);
      ed.ghosts = ed.visibleCurves().map((r) => {
        const pts: number[] = [];
        for (let f = a; f <= b; f += step) pts.push(f, evaluateFCurve(r.fc, f));
        return { fc: r.fc, pts };
      });
      ed.draw();
    },
  },
  {
    idname: 'graph.ghost_curves_clear',
    label: 'Clear Ghost Curves',
    description: 'Remove the ghost curve snapshot',
    undo: false,
    poll: (ctx) => !!graphEd(ctx)?.ghosts.length,
    exec: (ctx) => {
      const ed = graphEd(ctx)!;
      ed.ghosts = [];
      ed.draw();
    },
  },
  {
    idname: 'graph.local_view',
    label: 'Local View',
    description: 'Show only the selected curves (toggle)',
    props: [{ id: 'frame_selected', label: 'Frame Selected', type: 'bool', default: true }],
    undo: false,
    poll: (ctx) => !!graphEd(ctx),
    exec: (ctx, p) => {
      const ed = graphEd(ctx)!;
      if (ed.localView) {
        ed.localView = null;
        ed.refresh();
        if (p.frame_selected) ed.viewSelected();
        return;
      }
      const ids = ed.visibleCurves().filter((r) => r.fc.select || r.fc.keyframe_points.some(isKeySelected)).map(curveId);
      if (!ids.length) {
        app.report('WARNING', 'Select some curves or keys to view locally');
        return 'CANCELLED';
      }
      ed.localView = new Set(ids);
      ed.refresh();
      if (p.frame_selected) ed.viewSelected();
    },
  },
];

registerOperators([...blendOps, timeOffsetOp, ...toolOps, ...cursorOps, ...modifierOps, ...viewOps]);

addKeys('Graph Editor', [
  { key: 'D', alt: true, menu: blendMenu, menuTitle: 'Blend' },
  { key: 'S', alt: true, menu: smoothMenu, menuTitle: 'Smooth' },
  { key: 'O', alt: true, op: 'graph.smooth', when: overMain },
  { key: 'O', alt: true, shift: true, op: 'graph.bake_keys', when: overMain },
  { key: 'M', shift: true, ctrl: true, menu: () => MOD_TYPES.map(([v, l]) => ({ label: l, op: 'graph.fmodifier_add', props: { type: v, only_active: false } })), menuTitle: 'Add F-Curve Modifier' },
  { key: 'SLASH', op: 'graph.local_view' },
  { key: 'NUMPAD_SLASH', op: 'graph.local_view' },
]);
addKeys('Dopesheet', [{ key: 'O', alt: true, shift: true, op: 'action.bake_keys', when: overMain }]);
