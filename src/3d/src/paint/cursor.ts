// Brush cursor (circle following the surface) and the radial control (F / Shift F / Ctrl F) used
// to resize the brush, change its strength or the weight interactively.
import { Vector3 } from 'three';
import { h, type VNode } from '../ui/h';
import { app, registerOperators } from '../app/app';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeBrush, isBrushMode } from './brushes';
import { meshSession } from './session';
import { cursorState } from './cursorstate';
import { sculptHooks } from './sculpt';

export { cursorState };

/** Update the cursor for a pointer position (raycasts in sculpt mode to orient the ring). */
export function updateCursor(v: View3D, x: number, y: number) {
  cursorState.x = x;
  cursorState.y = y;
  cursorState.inside = true;
  cursorState.view = v;
  cursorState.hit = null;
  const mode = app.doc.mode;
  const b = activeBrush();
  if (mode === 'SCULPT') {
    const s = meshSession();
    const hit = s?.raycast(v, x, y);
    if (s && hit) {
      cursorState.lastFace = hit.face;
      cursorState.lastFaceMesh = s.meshId;
    }
    if (s && hit && b) {
      const w = s.world();
      const nWorld = hit.normal.clone().transformDirection(w);
      const r = s.pixelsToLocal(v, hit.world, b.radius) * s.scale();
      cursorState.hit = { point: hit.world, normal: nWorld, radius: r };
    }
  }
  v.drawSvg();
}

function ringPath(v: View3D, c: Vector3, n: Vector3, r: number): string {
  const u = Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1).cross(n).normalize() : new Vector3(1, 0, 0).cross(n).normalize();
  const w = n.clone().cross(u).normalize();
  let d = '';
  const p = new Vector3();
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    p.copy(c)
      .addScaledVector(u, Math.cos(t) * r)
      .addScaledVector(w, Math.sin(t) * r);
    const s = v.project(p);
    d += `${i ? 'L' : 'M'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
  }
  return d + 'Z';
}

function cursorSvg(v: View3D): VNode | null {
  const rc = cursorState.radial;
  if (rc && v === cursorState.view) {
    const parts: VNode[] = [];
    if (rc.data === 'size') {
      parts.push(
        h('circle', {
          cx: rc.cx,
          cy: rc.cy,
          r: Math.max(1, rc.value),
          fill: 'rgba(255,255,255,0.08)',
          stroke: '#fff',
          'stroke-width': 1.5,
        }),
      );
    } else {
      parts.push(
        h('circle', {
          cx: rc.cx,
          cy: rc.cy,
          r: RADIAL_FULL,
          fill: 'none',
          stroke: 'rgba(255,255,255,0.5)',
          'stroke-width': 1,
        }),
      );
      parts.push(
        h('circle', {
          cx: rc.cx,
          cy: rc.cy,
          r: Math.max(0.5, rc.value * RADIAL_FULL),
          fill: 'rgba(255,255,255,0.18)',
          stroke: '#fff',
          'stroke-width': 1.5,
        }),
      );
    }
    const label = rc.data === 'size' ? `${Math.round(rc.value)} px` : rc.value.toFixed(3);
    parts.push(
      h(
        'text',
        {
          x: rc.cx,
          y: rc.cy + 4,
          'text-anchor': 'middle',
          fill: '#fff',
          'font-size': 12,
          style: 'paint-order:stroke;stroke:#000;stroke-width:3px',
        },
        label,
      ),
    );
    return h('g', { key: 'paint-radial', class: 'paint-radial' }, ...parts);
  }
  if (!isBrushMode(app.doc.mode) || !cursorState.inside || cursorState.view !== v || app.modal) return null;
  const b = activeBrush();
  if (!b) return null;
  const x = cursorState.x,
    y = cursorState.y;
  const sub = b.direction === 'SUBTRACT';
  const tint = app.doc.mode === 'SCULPT' ? (sub ? 'rgba(110,140,255,0.9)' : 'rgba(255,120,120,0.9)') : 'rgba(255,255,255,0.9)';
  const hit = cursorState.hit;
  if (hit && app.doc.mode === 'SCULPT') {
    const d = ringPath(v, hit.point, hit.normal, hit.radius);
    const inner = ringPath(v, hit.point, hit.normal, hit.radius * Math.max(0.05, Math.min(1, b.strength)) * 0.999);
    return h(
      'g',
      { key: 'paint-cursor', class: 'paint-cursor', 'pointer-events': 'none' },
      h('path', {
        d,
        fill: 'none',
        stroke: 'rgba(0,0,0,0.35)',
        'stroke-width': 3,
      }),
      h('path', {
        d,
        fill: 'none',
        stroke: 'rgba(255,255,255,0.9)',
        'stroke-width': 1.3,
      }),
      h('path', {
        d: inner,
        fill: 'none',
        stroke: tint,
        'stroke-width': 1,
        opacity: 0.6,
      }),
      h('circle', { cx: x, cy: y, r: 1.5, fill: '#fff' }),
    );
  }
  const r = b.radius;
  return h(
    'g',
    { key: 'paint-cursor', class: 'paint-cursor', 'pointer-events': 'none' },
    h('circle', {
      cx: x,
      cy: y,
      r,
      fill: 'none',
      stroke: 'rgba(0,0,0,0.35)',
      'stroke-width': 3,
    }),
    h('circle', {
      cx: x,
      cy: y,
      r,
      fill: 'none',
      stroke: 'rgba(255,255,255,0.9)',
      'stroke-width': 1.3,
    }),
    app.doc.mode === 'SCULPT'
      ? h('circle', {
          cx: x,
          cy: y,
          r: r * Math.max(0.05, Math.min(1, b.strength)),
          fill: 'none',
          stroke: tint,
          'stroke-width': 1,
          opacity: 0.6,
        })
      : null,
  );
}

editModeHooks.svg.push(cursorSvg);

// ---------------------------------------------------------------------------
// Radial control

const RADIAL_FULL = 120;

function radialGet(data: 'size' | 'strength' | 'weight'): number {
  const b = activeBrush();
  if (data === 'weight') return app.doc.scene.tool_settings.unified_paint.weight;
  if (!b) return 0;
  return data === 'size' ? b.radius : b.strength;
}

function radialSet(data: 'size' | 'strength' | 'weight', value: number) {
  const b = activeBrush();
  if (data === 'weight') app.doc.scene.tool_settings.unified_paint.weight = value;
  else if (b) {
    if (data === 'size') b.radius = value;
    else b.strength = value;
  }
}

registerOperators([
  {
    idname: 'wm.radial_control',
    label: 'Radial Control',
    props: [
      {
        id: 'data',
        label: 'Data',
        type: 'enum',
        default: 'size',
        items: [
          ['size', 'Radius'],
          ['strength', 'Strength'],
          ['weight', 'Weight'],
        ],
      },
    ],
    poll: () => isBrushMode(app.doc.mode) && !!activeView3D(),
    invoke: (ctx, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const data = p.data as 'size' | 'strength' | 'weight';
      if (data === 'weight' && app.doc.mode !== 'WEIGHT_PAINT') return 'CANCELLED';
      const start = radialGet(data);
      const r = v.el.getBoundingClientRect();
      const px = (ctx.event?.x ?? app.pointer.x) - r.left,
        py = (ctx.event?.y ?? app.pointer.y) - r.top;
      const offset = data === 'size' ? start : start * RADIAL_FULL;
      cursorState.view = v;
      cursorState.radial = { cx: px - offset, cy: py, data, value: start };
      v.drawSvg();
      const update = (e: PointerEvent) => {
        const rc = cursorState.radial;
        if (!rc) return;
        const q = v.local(e);
        cursorState.x = q.x;
        cursorState.y = q.y;
        const d = Math.hypot(q.x - rc.cx, q.y - rc.cy);
        rc.value = data === 'size' ? Math.max(1, Math.min(2000, Math.round(d))) : Math.max(0, Math.min(1, d / RADIAL_FULL));
        radialSet(data, rc.value);
        v.drawSvg();
        app.changed('ui');
      };
      const done = () => {
        cursorState.radial = null;
        updateCursor(v, cursorState.x, cursorState.y);
        app.changed('ui');
      };
      app.startModal({
        label: data === 'size' ? 'Brush Radius' : data === 'strength' ? 'Brush Strength' : 'Weight',
        onPointerMove: update,
        onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : 'CANCELLED'),
        onKey: (e) => {
          if (e.type !== 'keydown') return true;
          if (e.key === 'Escape') return 'CANCELLED';
          if (e.key === 'Enter' || e.key === ' ') return 'FINISHED';
          return true;
        },
        cancel: () => {
          radialSet(data, start);
          done();
        },
        finish: done,
        header: () =>
          `${data === 'size' ? 'Radius' : data === 'strength' ? 'Strength' : 'Weight'}: ${data === 'size' ? Math.round(cursorState.radial?.value ?? start) : (cursorState.radial?.value ?? start).toFixed(3)}`,
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'brush.scale_size',
    label: 'Scale Sculpt/Paint Brush Size',
    props: [{ id: 'scalar', label: 'Scalar', type: 'float', default: 1 }],
    undo: false,
    poll: () => isBrushMode(app.doc.mode) && !!activeBrush(),
    exec: (_ctx, p) => {
      const b = activeBrush()!;
      const s = p.scalar as number;
      let r = b.radius * s;
      // always change by at least one pixel
      if (Math.round(r) === Math.round(b.radius)) r = b.radius + (s > 1 ? 1 : -1);
      b.radius = Math.max(1, Math.min(2000, Math.round(r)));
      const v = activeView3D();
      if (v) updateCursor(v, cursorState.x, cursorState.y);
    },
  },
]);

sculptHooks.afterUpdate = (v) => updateCursor(v, cursorState.x, cursorState.y);
