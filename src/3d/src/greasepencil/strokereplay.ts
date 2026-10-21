// Brush strokes of the Grease Pencil modes run through `gpRunStroke`: live pointer input goes to
// the shared stroke driver, while a scripted stroke (the `stroke` list of grease_pencil.brush_stroke,
// sculpt_paint, vertex_brush_stroke, weight_brush_stroke) is replayed synchronously as dabs.
import { runStroke, type StrokeHandler } from '../paint/stroke';
import type { View3D } from '../editors/view3d/view3d';

export interface ReplaySample {
  /** viewport pixels (from the top left) */
  x: number;
  y: number;
  pressure: number;
}

let pending: ReplaySample[] | null = null;

/** Run `start` (which begins a stroke) with the samples replayed instead of live pointer input. */
export function withReplay(samples: ReplaySample[], start: () => void) {
  pending = samples;
  try {
    start();
  } finally {
    pending = null;
  }
}

/** Dabs along the samples, spaced like a live stroke (`spacing` percent of the radius; 0 = one per sample). */
export function replayDabs(samples: ReplaySample[], spacing: number, radiusPx: number): ReplaySample[] {
  if (!samples.length) return [];
  const out: ReplaySample[] = [samples[0]];
  if (spacing <= 0) return samples.slice();
  const step = Math.max(1, (radiusPx * spacing) / 100);
  let last = samples[0];
  for (let i = 1; i < samples.length; i++) {
    const q = samples[i];
    const dx = q.x - last.x,
      dy = q.y - last.y;
    const len = Math.hypot(dx, dy);
    if (len < step) continue;
    const n = Math.min(500, Math.floor(len / step));
    for (let k = 1; k <= n; k++) {
      const t = (k * step) / len;
      out.push({ x: last.x + dx * t, y: last.y + dy * t, pressure: last.pressure + (q.pressure - last.pressure) * t });
    }
    const t = (n * step) / len;
    last = { x: last.x + dx * t, y: last.y + dy * t, pressure: q.pressure };
  }
  return out;
}

export function gpRunStroke(v: View3D, e: PointerEvent, handler: StrokeHandler) {
  const samples = pending;
  if (!samples) return runStroke(v, e, handler);
  pending = null;
  const dabs = replayDabs(samples, handler.spacing(), handler.radiusPx());
  dabs.forEach((s, i) => handler.dab({ x: s.x, y: s.y, pressure: s.pressure, first: i === 0, sizeFactor: s.pressure }));
  handler.update?.();
  handler.end();
}

/** A stand-in pointer event at viewport pixel (x, y) for starting a replayed stroke. */
export function fakePointer(v: View3D, x: number, y: number, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): PointerEvent {
  const r = v.el.getBoundingClientRect();
  return {
    clientX: r.left + x,
    clientY: r.top + y,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: false,
    button: 0,
    pointerId: -1,
    pointerType: 'mouse',
    pressure: 1,
  } as unknown as PointerEvent;
}
