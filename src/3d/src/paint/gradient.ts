// Gradient colors for the Texture Paint brushes: the Paint brush takes its color from a color ramp
// (by pen pressure, or by the distance along the stroke, repeating or clamped), and the Fill brush
// fills with the ramp along a dragged line (linear) or around its start (radial).
import { readRamp, evalRamp, defaultRamp } from '../nodes/curves';
import type { SocketValue } from '../data/types';

export type GradientStrokeMode = 'PRESSURE' | 'SPACING_REPEAT' | 'SPACING_CLAMP';
export type GradientFillMode = 'LINEAR' | 'RADIAL';

export interface GradientSettings {
  color_type?: 'COLOR' | 'GRADIENT';
  /** color ramp (same layout as the Color Ramp node's properties) */
  gradient?: Record<string, SocketValue>;
  gradient_stroke_mode?: GradientStrokeMode;
  /** stroke length (pixels) one pass through the ramp takes */
  grad_spacing?: number;
  gradient_fill_mode?: GradientFillMode;
}

export const usesGradient = (b: GradientSettings | null | undefined) => b?.color_type === 'GRADIENT';

/** The brush's ramp properties (created with a black to white ramp when missing). */
export function gradientProps(b: GradientSettings): Record<string, SocketValue> {
  return (b.gradient ??= defaultRamp());
}

/** Linear RGBA of the ramp at t (0..1). Pure. */
export function gradientAt(b: GradientSettings, t: number): number[] {
  return evalRamp(readRamp(gradientProps(b)), Math.max(0, Math.min(1, t)));
}

/** Ramp position of a dab: pen pressure, or the distance along the stroke. Pure. */
export function strokeGradientT(b: GradientSettings, pressure: number, distance: number): number {
  const mode = b.gradient_stroke_mode ?? 'PRESSURE';
  if (mode === 'PRESSURE') return pressure;
  const sp = Math.max(1, b.grad_spacing ?? 100);
  const t = distance / sp;
  return mode === 'SPACING_REPEAT' ? t - Math.floor(t) : Math.min(1, t);
}

/** Ramp position of a point for a gradient fill from a to b (screen pixels). Pure. */
export function fillGradientT(mode: GradientFillMode, ax: number, ay: number, bx: number, by: number, x: number, y: number): number {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 <= 0) return 0;
  if (mode === 'RADIAL') return Math.min(1, Math.hypot(x - ax, y - ay) / Math.sqrt(l2));
  return Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
}
