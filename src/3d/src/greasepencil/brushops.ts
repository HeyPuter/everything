// Generic brush operators extended to the Grease Pencil modes: [ / ] brush size, X swap brush
// colors, Shift X sample the screen color, and the screen color sampler they share.
import { app, operators, onAppReady, type OpContext, type Operator } from '../app/app';
import { activeTools } from '../app/prefs';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { renderContext } from '../render/context';
import { gpOf, gpBrush, srgbToLinear } from './data';

const inGPPaint = () => !!gpOf(app.doc, app.activeObject) && (app.doc.mode === 'PAINT_GREASE_PENCIL' || app.doc.mode === 'SCULPT_GREASE_PENCIL' || app.doc.mode === 'VERTEX_GREASE_PENCIL' || app.doc.mode === 'WEIGHT_GREASE_PENCIL');

/** Linear RGB of the rendered viewport pixel at viewport coordinates (x, y). */
export function screenColor(v: View3D, x: number, y: number): [number, number, number] | null {
  const engine = renderContext?.engine;
  if (!engine || engine.lost) return null;
  engine.drawAll();
  const base = engine.canvas.getBoundingClientRect();
  const r = v.el.getBoundingClientRect();
  const sx = engine.canvas.width / base.width,
    sy = engine.canvas.height / base.height;
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(engine.canvas, Math.round((r.left - base.left + x) * sx), Math.round((r.top - base.top + y) * sy), 1, 1, 0, 0, 1, 1);
  const px = g.getImageData(0, 0, 1, 1).data;
  return [srgbToLinear(px[0] / 255), srgbToLinear(px[1] / 255), srgbToLinear(px[2] / 255)];
}

/** Extend a registered operator: in grease pencil paint modes use `poll`/`exec`, elsewhere the original. */
function extend(idname: string, o: { exec: NonNullable<Operator['exec']> }) {
  const base = operators.get(idname);
  if (!base) return;
  const basePoll = base.poll,
    baseExec = base.exec;
  base.poll = (ctx: OpContext) => (inGPPaint() ? true : !basePoll || basePoll(ctx));
  base.exec = (ctx, p) => (inGPPaint() ? o.exec(ctx, p) : baseExec?.(ctx, p));
}

// other modules register these operators: extend them once everything is loaded
onAppReady(() => {
  extend('brush.scale_size', {
    exec: (_c, p) => {
      const b = gpBrush(app.doc, activeTools[app.doc.mode] ?? '');
      const s = p.scalar as number;
      let r = b.size * s;
      if (Math.round(r) === Math.round(b.size)) r = b.size + (s > 1 ? 1 : -1);
      b.size = Math.max(1, Math.min(2000, Math.round(r)));
      app.changed('ui');
      activeView3D()?.drawSvg();
    },
  });

  extend('paint.brush_colors_flip', {
    exec: () => {
      const b = gpBrush(app.doc, activeTools[app.doc.mode] === 'builtin.brush.Tint' ? 'builtin.brush.Tint' : 'builtin.brush.Draw');
      const c = b.color ?? [0.5, 0.5, 0.5];
      b.color = b.secondary_color ?? [1, 1, 1];
      b.secondary_color = c;
      app.changed('ui');
    },
  });

  extend('paint.sample_color', {
    exec: (ctx) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const col = screenColor(v, (ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top);
      if (!col) return 'CANCELLED';
      const tool = activeTools[app.doc.mode];
      const b = gpBrush(app.doc, tool === 'builtin.brush.Tint' || tool === 'builtin.brush.Fill' ? tool : 'builtin.brush.Draw');
      b.color = col;
      // a sampled color only shows when the brush paints with its own color
      if (b.color_mode !== undefined) b.color_mode = 'VERTEXCOLOR';
      app.changed('ui');
    },
  });
});
