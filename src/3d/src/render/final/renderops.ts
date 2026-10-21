// Render settings operators: swap the output dimensions and shutter curve presets.
import { registerOperators } from '../../app/app';
import { shutterCurvePoints, type ShutterShape } from './units';
import './icons';

export const SHUTTER_SHAPES: { value: ShutterShape; label: string; icon: string }[] = [
  { value: 'SMOOTH', label: 'Smooth', icon: 'rs_curve_smooth' },
  { value: 'SPHERE', label: 'Sphere', icon: 'rs_curve_sphere' },
  { value: 'ROOT', label: 'Root', icon: 'rs_curve_root' },
  { value: 'SHARP', label: 'Sharp', icon: 'rs_curve_sharp' },
  { value: 'LINE', label: 'Linear', icon: 'rs_curve_line' },
  { value: 'MAX', label: 'Max', icon: 'rs_curve_max' },
];

registerOperators([
  {
    idname: 'render.swap_dimensions',
    label: 'Swap Dimensions',
    description: 'Exchange the width and height of the output (and the pixel aspect), e.g. to switch between landscape and portrait',
    exec: (ctx) => {
      const r = ctx.doc.scene.render;
      [r.resolution_x, r.resolution_y] = [r.resolution_y, r.resolution_x];
      [r.pixel_aspect_x, r.pixel_aspect_y] = [r.pixel_aspect_y, r.pixel_aspect_x];
      if (r.use_border) {
        [r.border_min_x, r.border_min_y, r.border_max_x, r.border_max_y] = [r.border_min_y ?? 0, r.border_min_x ?? 0, r.border_max_y ?? 1, r.border_max_x ?? 1];
      }
      return 'FINISHED';
    },
  },
  {
    idname: 'render.shutter_curve_preset',
    label: 'Shutter Curve Preset',
    description: 'Set the shape of the shutter curve: how far the shutter is open over the motion blur interval',
    props: [{ id: 'shape', label: 'Mode', type: 'enum', items: SHUTTER_SHAPES.map((s) => [s.value, s.label] as [string, string]), default: 'SMOOTH' }],
    exec: (ctx, p) => {
      const shape = String(p.shape ?? 'SMOOTH') as ShutterShape;
      if (!SHUTTER_SHAPES.some((s) => s.value === shape)) return 'CANCELLED';
      ctx.doc.scene.render.motion_blur_shutter_curve = shutterCurvePoints(shape);
      return 'FINISHED';
    },
  },
]);
