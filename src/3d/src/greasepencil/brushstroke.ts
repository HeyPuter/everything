// The stroke operators of the paint modes (grease_pencil.brush_stroke, sculpt_paint,
// vertex_brush_stroke, weight_brush_stroke). Pointer input reaches the same brush code through the
// viewport; these operators make strokes scriptable: `stroke` is a list of elements with `mouse`
// (viewport pixels from the top left) or `location` (world xyz), and an optional `pressure`.
import { Vector3 } from 'three';
import { app, registerOperators, type PropDef } from '../app/app';
import { activeTools } from '../app/prefs';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { gpOf } from './data';
import { startDraw, startErase, startTint, doFill } from './paint';
import { startSculpt, startClone } from './sculpt';
import { startVertexPaint } from './vertexpaint';
import { startWeightPaint } from './weightpaint';
import { withReplay, fakePointer, type ReplaySample } from './strokereplay';

/** Samples (viewport pixels) of a `stroke` property. */
export function strokeSamples(v: View3D, list: unknown): ReplaySample[] {
  const out: ReplaySample[] = [];
  if (!Array.isArray(list)) return out;
  const p = new Vector3();
  for (const el of list) {
    const e = el as { mouse?: number[]; location?: number[]; pressure?: number };
    const pressure = typeof e.pressure === 'number' ? e.pressure : 1;
    if (Array.isArray(e.mouse) && e.mouse.length >= 2) out.push({ x: +e.mouse[0], y: +e.mouse[1], pressure });
    else if (Array.isArray(e.location) && e.location.length >= 3) {
      const s = v.project(p.set(+e.location[0], +e.location[1], +e.location[2]));
      out.push({ x: s.x, y: s.y, pressure });
    }
  }
  return out;
}

const STROKE_PROPS: PropDef[] = [
  { id: 'stroke', label: 'Stroke', type: 'string', default: [], hidden: true },
  {
    id: 'mode',
    label: 'Stroke Mode',
    type: 'enum',
    default: 'NORMAL',
    items: [
      ['NORMAL', 'Regular', 'Apply the brush normally'],
      ['INVERT', 'Invert', 'Invert the action of the brush'],
    ],
  },
  {
    id: 'brush_toggle',
    label: 'Temporary Brush Toggle',
    type: 'enum',
    default: 'None',
    items: [
      ['None', 'None', 'Use the active brush'],
      ['SMOOTH', 'Smooth', 'Use the smooth brush for this stroke'],
      ['ERASE', 'Erase', 'Use the eraser for this stroke'],
      ['MASK', 'Mask', 'Use the mask brush for this stroke'],
    ],
  },
  { id: 'pen_flip', label: 'Pen Flip', type: 'bool', default: false, hidden: true },
];

const inMode = (mode: string) => () => app.doc.mode === mode && !!gpOf(app.doc, app.activeObject) && !!activeView3D();

/** Replay a scripted stroke through `start` (called with a stand-in event at the first sample). */
function replay(p: Record<string, unknown>, start: (v: View3D, e: PointerEvent, invert: boolean) => void) {
  const v = activeView3D();
  if (!v) return 'CANCELLED' as const;
  const samples = strokeSamples(v, p.stroke);
  if (!samples.length) {
    app.report('ERROR', 'The stroke has no points');
    return 'CANCELLED' as const;
  }
  const invert = p.mode === 'INVERT' || !!p.pen_flip;
  withReplay(samples, () => start(v, fakePointer(v, samples[0].x, samples[0].y, { ctrl: invert }), invert));
  app.changed('doc');
  return 'FINISHED' as const;
}

registerOperators([
  {
    idname: 'grease_pencil.brush_stroke',
    label: 'Grease Pencil Draw',
    description: 'Draw, erase or tint along a stroke with the active Draw Mode tool',
    props: STROKE_PROPS,
    poll: inMode('PAINT_GREASE_PENCIL'),
    undo: false,
    exec: (_c, p) =>
      replay(p, (v, e, invert) => {
        const tool = activeTools.PAINT_GREASE_PENCIL ?? 'builtin.brush.Draw';
        if (p.brush_toggle === 'ERASE' || tool === 'builtin.brush.Erase' || (invert && tool === 'builtin.brush.Draw')) startErase(v, e);
        else if (p.brush_toggle === 'SMOOTH') startSculpt(v, e, 'builtin.brush.Smooth');
        else if (tool === 'builtin.brush.Tint') startTint(v, e);
        else if (tool === 'builtin.brush.Fill') {
          const r = v.el.getBoundingClientRect();
          doFill(v, e.clientX - r.left, e.clientY - r.top, invert);
        } else startDraw(v, e);
      }),
  },
  {
    idname: 'grease_pencil.sculpt_paint',
    label: 'Grease Pencil Sculpt',
    description: 'Sculpt the strokes along a stroke with the active Sculpt Mode brush',
    props: STROKE_PROPS,
    poll: inMode('SCULPT_GREASE_PENCIL'),
    undo: false,
    exec: (_c, p) =>
      replay(p, (v, e) => {
        if (p.brush_toggle === 'SMOOTH') startSculpt(v, e, 'builtin.brush.Smooth');
        else if (activeTools.SCULPT_GREASE_PENCIL === 'builtin.brush.Clone') startClone(v, e);
        else startSculpt(v, e);
      }),
  },
  {
    idname: 'grease_pencil.vertex_brush_stroke',
    label: 'Grease Pencil Paint Vertex',
    description: 'Paint vertex colors along a stroke with the active Vertex Paint brush',
    props: STROKE_PROPS,
    poll: inMode('VERTEX_GREASE_PENCIL'),
    undo: false,
    exec: (_c, p) => replay(p, (v, e) => startVertexPaint(v, e)),
  },
  {
    idname: 'grease_pencil.weight_brush_stroke',
    label: 'Grease Pencil Paint Weight',
    description: 'Paint weights along a stroke with the active Weight Paint brush',
    props: STROKE_PROPS,
    poll: inMode('WEIGHT_GREASE_PENCIL'),
    undo: false,
    exec: (_c, p) => replay(p, (v, e) => startWeightPaint(v, e)),
  },
]);
