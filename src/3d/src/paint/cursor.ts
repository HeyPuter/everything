// Brush cursor (circle following the surface) and the radial control (F / Shift F / Ctrl F) used
// to resize the brush, change its strength or the weight interactively.
import { Vector3 } from 'three';
import { h, patch, type VNode } from '../ui/h';
import { app, registerOperators } from '../app/app';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeBrush, isBrushMode, setBrushRadius, setBrushStrength, type BrushMode } from './brushes';
import { meshSession } from './session';
import { brushRadiusPx } from './vgather';
import { cursorState } from './cursorstate';
import { textureActive } from './brushtex';
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
  cursorState.radiusPx = b?.radius ?? 0;
  if (mode === 'SCULPT' || (b && b.use_locked_size === 'SCENE')) {
    const s = meshSession();
    const hit = s?.raycast(v, x, y);
    if (s && hit && mode === 'SCULPT') {
      cursorState.lastFace = hit.face;
      cursorState.lastFaceMesh = s.meshId;
    }
    if (s && b) cursorState.radiusPx = hit ? brushRadiusPx(b, s, v, hit.world) : b.use_locked_size === 'SCENE' ? cursorState.radiusPx : b.radius;
    if (s && hit && b && mode === 'SCULPT') {
      const w = s.world();
      const nWorld = hit.normal.clone().transformDirection(w);
      const r = s.pixelsToLocal(v, hit.world, cursorState.radiusPx) * s.scale();
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
  if (cursorState.radial && v === cursorState.view) return radialVNode();
  return brushCursorVNode(v);
}

/** The radial control's circles and value (editor pixels). */
function radialVNode(): VNode | null {
  const rc = cursorState.radial;
  if (rc) {
    const parts: VNode[] = [];
    if (rc.data === 'angle') {
      parts.push(
        h('circle', { cx: rc.cx, cy: rc.cy, r: RADIAL_FULL, fill: 'none', stroke: 'rgba(255, 255, 255,0.5)', 'stroke-width': 1 }),
        h('path', { d: `M${rc.cx} ${rc.cy}L${rc.cx + Math.cos(rc.value) * RADIAL_FULL} ${rc.cy - Math.sin(rc.value) * RADIAL_FULL}`, stroke: '#ffffff', 'stroke-width': 1.5 }),
      );
    } else if (rc.data === 'size') {
      parts.push(
        h('circle', {
          cx: rc.cx,
          cy: rc.cy,
          r: Math.max(1, rc.value),
          fill: 'rgba(255, 255, 255,0.08)',
          stroke: '#ffffff',
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
          stroke: 'rgba(255, 255, 255,0.5)',
          'stroke-width': 1,
        }),
      );
      parts.push(
        h('circle', {
          cx: rc.cx,
          cy: rc.cy,
          r: Math.max(0.5, rc.value * RADIAL_FULL),
          fill: 'rgba(255, 255, 255,0.18)',
          stroke: '#ffffff',
          'stroke-width': 1.5,
        }),
      );
    }
    const label = rc.data === 'size' ? `${Math.round(rc.value)} px` : rc.data === 'angle' ? `${Math.round((rc.value * 180) / Math.PI)}°` : rc.value.toFixed(3);
    parts.push(
      h(
        'text',
        {
          x: rc.cx,
          y: rc.cy + 4,
          'text-anchor': 'middle',
          fill: '#ffffff',
          'font-size': 12,
          style: 'paint-order:stroke;stroke:#000000;stroke-width:3px',
        },
        label,
      ),
    );
    return h('g', { key: 'paint-radial', class: 'paint-radial' }, ...parts);
  }
  return null;
}

function brushCursorVNode(v: View3D): VNode | null {
  if (!isBrushMode(app.doc.mode) || !cursorState.inside || cursorState.view !== v || app.modal) return null;
  const b = activeBrush();
  if (!b || b.show_cursor === false) return null;
  const x = cursorState.x,
    y = cursorState.y;
  const sub = b.direction === 'SUBTRACT';
  const css = (c: number[]) => `rgba(${c.map((k) => Math.round(k * 255)).join(',')},0.9)`;
  const tint = app.doc.mode === 'SCULPT' ? css(sub ? b.cursor_color_subtract ?? [0.43, 0.55, 1] : b.cursor_color_add ?? [1, 0.47, 0.47]) : 'rgba(255, 255, 255,0.9)';
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
        stroke: 'rgba(0, 0, 0,0.35)',
        'stroke-width': 3,
      }),
      h('path', {
        d,
        fill: 'none',
        stroke: 'rgba(255, 255, 255,0.9)',
        'stroke-width': 1.3,
      }),
      h('path', {
        d: inner,
        fill: 'none',
        stroke: tint,
        'stroke-width': 1,
        opacity: 0.6,
      }),
      h('circle', { cx: x, cy: y, r: 1.5, fill: '#ffffff' }),
    );
  }
  const r = cursorState.radiusPx || b.radius;
  return h(
    'g',
    { key: 'paint-cursor', class: 'paint-cursor', 'pointer-events': 'none' },
    h('circle', {
      cx: x,
      cy: y,
      r,
      fill: 'none',
      stroke: 'rgba(0, 0, 0,0.35)',
      'stroke-width': 3,
    }),
    h('circle', {
      cx: x,
      cy: y,
      r,
      fill: 'none',
      stroke: 'rgba(255, 255, 255,0.9)',
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

/** Where the radial control is drawn: a 3D viewport, or an overlay over another editor. */
interface RadialHost {
  el: HTMLElement;
  local(e: { clientX: number; clientY: number }): { x: number; y: number };
  drawSvg(): void;
  dispose?(): void;
}

/** An SVG overlay over an editor element (the Image Editor) showing the radial control. */
function imageEditorHost(el: HTMLElement): RadialHost {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'paint-radial-overlay');
  svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:5;overflow:visible';
  el.append(svg);
  return {
    el,
    local: (e) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    },
    drawSvg: () => patch(svg, radialVNode()),
    dispose: () => svg.remove(),
  };
}

const RADIAL_FULL = 120;

/** Paint mode whose brush the radial control edits (the Image Editor paints with Texture Paint brushes). */
let radialMode: BrushMode | null = null;
const radialBrush = () => (radialMode ? activeBrush(radialMode) : activeBrush());

function radialGet(data: 'size' | 'strength' | 'weight' | 'angle'): number {
  const b = radialBrush();
  if (data === 'angle') return b?.texture_slot?.angle ?? 0;
  if (data === 'weight') return app.doc.scene.tool_settings.unified_paint.weight;
  if (!b) return 0;
  if (data === 'size') return b.use_locked_size === 'SCENE' && cursorState.radiusPx ? cursorState.radiusPx : b.radius;
  return b.strength;
}

function radialSet(data: 'size' | 'strength' | 'weight' | 'angle', value: number) {
  const b = radialBrush();
  if (data === 'angle') {
    if (b?.texture_slot) b.texture_slot = { ...b.texture_slot, angle: value };
    return;
  }
  if (data === 'weight') app.doc.scene.tool_settings.unified_paint.weight = value;
  else if (b) {
    if (data === 'size') {
      // scene-locked sizes scale their world radius by the same ratio
      if (b.use_locked_size === 'SCENE' && cursorState.radiusPx) {
        b.unprojected_radius = (b.unprojected_radius ?? 0.1) * (value / cursorState.radiusPx);
        cursorState.radiusPx = value;
      } else setBrushRadius(b, value);
    } else setBrushStrength(b, value);
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
          ['angle', 'Texture Angle'],
        ],
      },
    ],
    poll: (ctx) => (isBrushMode(app.doc.mode) && !!activeView3D()) || ctx.area?.type === 'IMAGE_EDITOR',
    invoke: (ctx, p) => {
      const ie = ctx.area?.type === 'IMAGE_EDITOR' ? (ctx.area.editor as { el: HTMLElement }) : null;
      radialMode = ie ? 'TEXTURE_PAINT' : null;
      const v: RadialHost | null = ie ? imageEditorHost(ie.el) : activeView3D();
      if (!v || !radialBrush()) return 'CANCELLED';
      const data = p.data as 'size' | 'strength' | 'weight' | 'angle';
      if (data === 'weight' && app.doc.mode !== 'WEIGHT_PAINT') return 'CANCELLED';
      if (data === 'angle' && !textureActive(radialBrush()!)) {
        app.report('INFO', 'The brush has no texture to rotate');
        return 'CANCELLED';
      }
      const start = radialGet(data);
      const r = v.el.getBoundingClientRect();
      const px = (ctx.event?.x ?? app.pointer.x) - r.left,
        py = (ctx.event?.y ?? app.pointer.y) - r.top;
      const offset = data === 'size' ? start : start * RADIAL_FULL;
      // the 3D views must not draw this control while it runs in another editor
      cursorState.view = ie ? null : (v as View3D);
      cursorState.radial =
        data === 'angle' ? { cx: px - Math.cos(start) * RADIAL_FULL, cy: py + Math.sin(start) * RADIAL_FULL, data, value: start } : { cx: px - offset, cy: py, data, value: start };
      v.drawSvg();
      const update = (e: PointerEvent) => {
        const rc = cursorState.radial;
        if (!rc) return;
        const q = v.local(e);
        cursorState.x = q.x;
        cursorState.y = q.y;
        const d = Math.hypot(q.x - rc.cx, q.y - rc.cy);
        rc.value = data === 'angle' ? Math.atan2(rc.cy - q.y, q.x - rc.cx) : data === 'size' ? Math.max(1, Math.min(2000, Math.round(d))) : Math.max(0, Math.min(1, d / RADIAL_FULL));
        radialSet(data, rc.value);
        v.drawSvg();
        app.changed('ui');
      };
      const done = () => {
        cursorState.radial = null;
        radialMode = null;
        if (ie) v.dispose?.();
        else updateCursor(v as View3D, cursorState.x, cursorState.y);
        app.changed('ui');
      };
      app.startModal({
        label: data === 'size' ? 'Brush Radius' : data === 'strength' ? 'Brush Strength' : data === 'angle' ? 'Texture Angle' : 'Weight',
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
          data === 'angle'
            ? `Texture Angle: ${Math.round(((cursorState.radial?.value ?? start) * 180) / Math.PI)}°`
            : `${data === 'size' ? 'Radius' : data === 'strength' ? 'Strength' : 'Weight'}: ${data === 'size' ? Math.round(cursorState.radial?.value ?? start) : (cursorState.radial?.value ?? start).toFixed(3)}`,
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
      if (b.use_locked_size === 'SCENE') {
        b.unprojected_radius = Math.max(1e-5, (b.unprojected_radius ?? 0.1) * s);
        const v = activeView3D();
        if (v) updateCursor(v, cursorState.x, cursorState.y);
        return;
      }
      let r = b.radius * s;
      // always change by at least one pixel
      if (Math.round(r) === Math.round(b.radius)) r = b.radius + (s > 1 ? 1 : -1);
      setBrushRadius(b, Math.max(1, Math.min(2000, Math.round(r))));
      const v = activeView3D();
      if (v) updateCursor(v, cursorState.x, cursorState.y);
    },
  },
]);

sculptHooks.afterUpdate = (v) => updateCursor(v, cursorState.x, cursorState.y);
