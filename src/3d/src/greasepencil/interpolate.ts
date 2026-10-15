// Interpolation between keyframes: in-betweens are generated as Breakdown keys whose strokes blend
// the strokes of the surrounding keys (paired by order, resampled to matching point counts).
//   grease_pencil.interpolate           one breakdown on the current frame (modal: drag to bias)
//   grease_pencil.interpolate_sequence  breakdowns on every `step` frames between two keys, eased
import { app, registerOperators, type OpContext, type PropDef } from '../app/app';
import { easeFactor } from '../anim/fcurve';
import { activeView3D } from '../editors/view3d/view3d';
import { gpOf, activeLayer, toStrokes, fromStrokes, setKeyframe, compactDrawings, normalizeDrawing, type GPPoint, type GPStroke } from './data';
import { smoothPoints, lerpPoint, resamplePoints } from './strokeops';
import type { GPDrawing, GPFrame, GPLayer, GreasePencilData } from './types';

// ---------------------------------------------------------------------------
// kernels (pure)

const dist = (a: GPPoint, b: GPPoint) => Math.hypot(a.co[0] - b.co[0], a.co[1] - b.co[1], a.co[2] - b.co[2]);
const lerp = (x: number, y: number, t: number) => x + (y - x) * t;
export { lerpPoint, resamplePoints };

/** True when the second stroke runs the other way round (its ends are closer swapped). */
export function shouldFlip(a: GPPoint[], b: GPPoint[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const a0 = a[0],
    a1 = a[a.length - 1],
    b0 = b[0],
    b1 = b[b.length - 1];
  return dist(a0, b1) + dist(a1, b0) < dist(a0, b0) + dist(a1, b1);
}

export type FlipMode = 'NONE' | 'FLIP' | 'AUTO';

/** Blend stroke `a` toward `b` by `t` (stroke attributes come from `a`). */
export function interpolateStroke(a: GPStroke, b: GPStroke, t: number, flip: FlipMode = 'AUTO'): GPStroke {
  let bp = b.points;
  if (flip === 'FLIP' || (flip === 'AUTO' && !a.cyclic && !b.cyclic && shouldFlip(a.points, bp))) bp = bp.slice().reverse();
  let ap = a.points;
  if (ap.length !== bp.length) {
    const n = Math.max(ap.length, bp.length);
    if (ap.length !== n) ap = resamplePoints(ap, n, a.cyclic);
    if (bp.length !== n) bp = resamplePoints(bp, n, b.cyclic);
  }
  const fill: GPStroke['fill_color'] = [0, 1, 2, 3].map((k) => lerp(a.fill_color[k], b.fill_color[k], t)) as GPStroke['fill_color'];
  return {
    ...a,
    points: ap.map((p, i) => ({ ...lerpPoint(p, bp[i], t), select: false })),
    fill_color: fill,
    fill_opacity: lerp(a.fill_opacity, b.fill_opacity, t),
  };
}

export interface InterpolateOptions {
  flip?: FlipMode;
  /** pair only strokes with selected points */
  onlySelected?: boolean;
  smoothSteps?: number;
  smoothFactor?: number;
}

/** The in-between drawing at factor `t` (0 = `from`, 1 = `to`), or null when no strokes pair up. */
export function interpolateDrawing(from: GPDrawing, to: GPDrawing, t: number, o: InterpolateOptions = {}): GPDrawing | null {
  const pick = (d: GPDrawing) => {
    const ss = toStrokes(normalizeDrawing(d));
    return o.onlySelected ? ss.filter((s) => s.points.some((p) => p.select)) : ss;
  };
  const A = pick(from),
    B = pick(to);
  const n = Math.min(A.length, B.length);
  if (!n) return null;
  const out: GPStroke[] = [];
  for (let i = 0; i < n; i++) {
    const s = interpolateStroke(A[i], B[i], t, o.flip ?? 'AUTO');
    if (o.smoothFactor && o.smoothFactor > 0 && s.points.length > 2)
      s.points = smoothPoints(s.points, Math.min(1, o.smoothFactor * 0.5), o.smoothSteps ?? 1, s.cyclic, { position: true, radius: false, opacity: false });
    out.push(s);
  }
  return fromStrokes(out);
}

/** Keys around `frame`: the last one at or before (`strictBefore`: before) and the first one after. */
export function surroundingKeys(layer: GPLayer, frame: number, excludeBreakdowns: boolean, strictBefore: boolean): { prev: GPFrame | null; next: GPFrame | null } {
  let prev: GPFrame | null = null,
    next: GPFrame | null = null;
  for (const f of layer.frames) {
    if (excludeBreakdowns && f.keyframe_type === 'BREAKDOWN') continue;
    if (strictBefore ? f.frame_number < frame : f.frame_number <= frame) prev = f;
    else if (f.frame_number > frame && !next) next = f;
  }
  return { prev, next };
}

export interface SequenceOptions extends InterpolateOptions {
  step: number;
  type: string;
  easing: string;
  back?: number;
  amplitude?: number;
  period?: number;
  excludeBreakdowns?: boolean;
}

/** Write a breakdown at `frame` (replacing a breakdown there; never a regular key). */
function putBreakdown(gp: GreasePencilData, layer: GPLayer, frame: number, d: GPDrawing): boolean {
  const at = layer.frames.find((f) => f.frame_number === frame);
  if (at && at.keyframe_type !== 'BREAKDOWN') return false;
  setKeyframe(gp, layer, frame, d, 'BREAKDOWN');
  return true;
}

/** Fill the frames between the keys around `frame` with interpolated breakdowns; returns the count. */
export function interpolateSequence(gp: GreasePencilData, layer: GPLayer, frame: number, o: SequenceOptions): number {
  const { prev, next } = surroundingKeys(layer, frame, !!o.excludeBreakdowns, false);
  if (!prev || !next) return 0;
  const a = gp.drawings[prev.drawing],
    b = gp.drawings[next.drawing];
  if (!a || !b) return 0;
  const span = next.frame_number - prev.frame_number;
  let made = 0;
  for (let f = prev.frame_number + Math.max(1, o.step); f < next.frame_number; f += Math.max(1, o.step)) {
    const lin = (f - prev.frame_number) / span;
    const t = o.type === 'LINEAR' ? lin : easeFactor(o.type, o.easing, lin, o);
    const d = interpolateDrawing(a, b, t, o);
    if (d && putBreakdown(gp, layer, f, d)) made++;
  }
  return made;
}

/** One breakdown at `frame` between the keys before and after it; returns false when impossible. */
export function interpolateAt(gp: GreasePencilData, layer: GPLayer, frame: number, shift: number, o: InterpolateOptions & { excludeBreakdowns?: boolean }): boolean {
  const { prev, next } = surroundingKeys(layer, frame, !!o.excludeBreakdowns, true);
  if (!prev || !next) return false;
  const a = gp.drawings[prev.drawing],
    b = gp.drawings[next.drawing];
  if (!a || !b) return false;
  const t = (frame - prev.frame_number) / (next.frame_number - prev.frame_number) + shift;
  const d = interpolateDrawing(a, b, t, o);
  return !!d && putBreakdown(gp, layer, frame, d);
}

// ---------------------------------------------------------------------------
// operators

const pollInterp = (ctx: OpContext) => {
  const m = ctx.doc.mode;
  return !!gpOf(ctx.doc, app.activeObject) && (m === 'PAINT_GREASE_PENCIL' || m === 'EDIT' || m === 'SCULPT_GREASE_PENCIL');
};

function targetLayers(gp: GreasePencilData, which: unknown): GPLayer[] {
  const list = which === 'ALL' ? gp.layers : [activeLayer(gp)].filter((l): l is GPLayer => !!l);
  return list.filter((l) => !l.lock && !l.hide);
}

const commonProps: PropDef[] = [
  {
    id: 'layers',
    label: 'Layer',
    type: 'enum',
    default: 'ACTIVE',
    items: [
      ['ACTIVE', 'Active', 'Interpolate the active layer only'],
      ['ALL', 'All Layers', 'Interpolate every editable layer'],
    ],
  },
  { id: 'exclude_breakdowns', label: 'Exclude Breakdowns', type: 'bool', default: false },
  { id: 'use_selection', label: 'Only Selected', type: 'bool', default: false },
  {
    id: 'flip',
    label: 'Flip Mode',
    type: 'enum',
    default: 'AUTO',
    items: [
      ['NONE', 'No Flip', 'Pair the strokes as drawn'],
      ['FLIP', 'Flip', 'Reverse the direction of the target strokes'],
      ['AUTO', 'Automatic', 'Reverse a target stroke when it runs the other way'],
    ],
  },
  { id: 'smooth_steps', label: 'Iterations', type: 'int', default: 1, min: 1, max: 3 },
  { id: 'smooth_factor', label: 'Smooth', type: 'float', default: 0, min: 0, max: 2, subtype: 'factor' },
];

const optionsOf = (p: Record<string, unknown>): InterpolateOptions & { excludeBreakdowns: boolean } => ({
  flip: p.flip as FlipMode,
  onlySelected: !!p.use_selection,
  smoothSteps: p.smooth_steps as number,
  smoothFactor: p.smooth_factor as number,
  excludeBreakdowns: !!p.exclude_breakdowns,
});

function runInterpolate(ctx: OpContext, p: Record<string, unknown>): boolean {
  const gp = gpOf(ctx.doc, app.activeObject)!;
  const frame = ctx.doc.scene.frame_current;
  let ok = false;
  for (const l of targetLayers(gp, p.layers)) ok = interpolateAt(gp, l, frame, p.shift as number, optionsOf(p)) || ok;
  return ok;
}

const EASE_TYPES: [string, string, string?][] = [
  ['LINEAR', 'Linear', 'Even spacing between the keys'],
  ['SINE', 'Sinusoidal'],
  ['QUAD', 'Quadratic'],
  ['CUBIC', 'Cubic'],
  ['QUART', 'Quartic'],
  ['QUINT', 'Quintic'],
  ['EXPO', 'Exponential'],
  ['CIRC', 'Circular'],
  ['BACK', 'Back', 'Overshoot and settle'],
  ['BOUNCE', 'Bounce'],
  ['ELASTIC', 'Elastic'],
];

registerOperators([
  {
    idname: 'grease_pencil.interpolate',
    label: 'Grease Pencil Interpolation',
    description: 'Create an in-between breakdown on the current frame from the keys before and after it (drag to bias it toward either key)',
    props: [
      { id: 'shift', label: 'Shift', type: 'float', default: 0, min: -1, max: 1, subtype: 'factor' },
      ...commonProps,
      // started by a click-drag (Interpolate tool): releasing the button confirms
      { id: 'release_confirm', label: 'Confirm on Release', type: 'bool', default: false, hidden: true },
    ],
    poll: pollInterp,
    exec: (ctx, p) => {
      if (!runInterpolate(ctx, p)) {
        app.report('ERROR', 'Interpolation needs strokes on keyframes before and after the current frame');
        return 'CANCELLED';
      }
      compactDrawings(gpOf(ctx.doc, app.activeObject)!);
    },
    invoke: (ctx, p) => {
      const gp = gpOf(ctx.doc, app.activeObject)!;
      const saved = { frames: gp.layers.map((l) => l.frames.map((f) => ({ ...f }))), drawings: gp.drawings.slice() };
      const restore = () => {
        gp.layers.forEach((l, i) => (l.frames = saved.frames[i].map((f) => ({ ...f }))));
        gp.drawings = saved.drawings.slice();
      };
      let shift = (p.shift as number) ?? 0;
      const apply = () => {
        restore();
        const ok = runInterpolate(ctx, { ...p, shift });
        app.changed('doc');
        return ok;
      };
      if (!apply()) {
        restore();
        app.report('ERROR', 'Interpolation needs strokes on keyframes before and after the current frame');
        return 'CANCELLED';
      }
      const v = activeView3D();
      const width = Math.max(200, v?.el.clientWidth ?? 800);
      const x0 = ctx.event?.x ?? app.pointer.x;
      const handler = {
        label: 'Grease Pencil Interpolation',
        cursor: 'ew-resize',
        redoOp: { idname: 'grease_pencil.interpolate', props: { ...p, shift } },
        onPointerMove: (e: PointerEvent) => {
          shift = Math.max(-1, Math.min(1, (e.clientX - x0) / (width / 2)));
          apply();
        },
        onWheel: (e: WheelEvent) => {
          shift = Math.max(-1, Math.min(1, shift + (e.deltaY < 0 ? 0.01 : -0.01)));
          apply();
        },
        onPointerDown: (e: PointerEvent) => (e.button === 2 ? 'CANCELLED' : 'FINISHED'),
        onPointerUp: (e: PointerEvent) => (e.button === 0 && p.release_confirm ? 'FINISHED' : undefined),
        onKey: (e: KeyboardEvent) => {
          if (e.type !== 'keydown') return true;
          if (e.key === 'Escape') return 'CANCELLED';
          if (e.key === 'Enter') return 'FINISHED';
          return true;
        },
        cancel: () => {
          restore();
          app.changed('doc');
        },
        finish: () => {
          handler.redoOp = { idname: 'grease_pencil.interpolate', props: { ...p, shift } };
          compactDrawings(gp);
        },
        header: () => `Interpolation: shift ${Math.round(shift * 100)}% (move the mouse or scroll; click / Enter to confirm, Esc to cancel)`,
      };
      app.startModal(handler as Parameters<typeof app.startModal>[0]);
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'grease_pencil.interpolate_sequence',
    label: 'Interpolate Sequence',
    description: 'Fill the frames between the keys around the current frame with interpolated breakdowns',
    props: [
      { id: 'step', label: 'Step', type: 'int', default: 1, min: 1, max: 1000 },
      ...commonProps,
      { id: 'type', label: 'Type', type: 'enum', default: 'LINEAR', items: EASE_TYPES },
      {
        id: 'easing',
        label: 'Easing',
        type: 'enum',
        default: 'EASE_IN',
        items: [
          ['AUTO', 'Automatic Easing'],
          ['EASE_IN', 'Ease In'],
          ['EASE_OUT', 'Ease Out'],
          ['EASE_IN_OUT', 'Ease In and Out'],
        ],
        showIf: (p) => p.type !== 'LINEAR',
      },
      { id: 'back', label: 'Back', type: 'float', default: 1.702, min: 0, max: 10, showIf: (p) => p.type === 'BACK' },
      { id: 'amplitude', label: 'Amplitude', type: 'float', default: 0.15, min: 0, max: 10, showIf: (p) => p.type === 'ELASTIC' },
      { id: 'period', label: 'Period', type: 'float', default: 0.15, min: -10, max: 10, showIf: (p) => p.type === 'ELASTIC' },
    ],
    poll: pollInterp,
    exec: (ctx, p) => {
      const gp = gpOf(ctx.doc, app.activeObject)!;
      const frame = ctx.doc.scene.frame_current;
      let made = 0;
      for (const l of targetLayers(gp, p.layers))
        made += interpolateSequence(gp, l, frame, {
          ...optionsOf(p),
          step: p.step as number,
          type: p.type as string,
          easing: p.easing as string,
          back: p.back as number,
          amplitude: p.amplitude as number,
          period: p.period as number,
        });
      if (!made) {
        app.report('ERROR', 'Interpolation needs strokes on keyframes before and after the current frame');
        return 'CANCELLED';
      }
      compactDrawings(gp);
    },
  },
  {
    idname: 'grease_pencil.delete_breakdown',
    label: 'Delete Breakdown Frames',
    description: 'Remove every breakdown key of the unlocked layers',
    poll: (ctx) => !!gpOf(ctx.doc, app.activeObject),
    exec: (ctx) => {
      const gp = gpOf(ctx.doc, app.activeObject)!;
      let n = 0;
      for (const l of gp.layers) {
        if (l.lock) continue;
        const before = l.frames.length;
        l.frames = l.frames.filter((f) => f.keyframe_type !== 'BREAKDOWN');
        n += before - l.frames.length;
      }
      if (!n) return 'CANCELLED';
      compactDrawings(gp);
    },
  },
]);
