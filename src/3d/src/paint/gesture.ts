// Screen-space gestures for Sculpt Mode (box, lasso, line and polyline): interactive drawing,
// hit tests against projected vertices / face centers and the registration of the gesture
// operators of each target (mask, hide, face set, trim, line project).
import { Vector3 } from 'three';
import { app, registerOperators, type PropDef } from '../app/app';
import { gestureFromProps, gestureTest, propsFromGesture, shapeProps, type Gesture, type GestureShape, type Pt } from './gshape';
import { h, type VNode } from '../ui/h';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { meshSession, type MeshSession } from './session';
import { projectVertices } from './vgather';
import { sculptPoll } from './facesetops';

export * from './gshape';

// ---------------------------------------------------------------------------
// hit tests on the active mesh

export interface GestureHits {
  s: MeshSession;
  /** screen x, y, ndc z per vertex */
  proj: Float32Array;
  inside: (x: number, y: number) => boolean;
  view: View3D;
}

export function gestureHits(v: View3D, g: Gesture): GestureHits | null {
  const s = meshSession();
  if (!s) return null;
  return { s, proj: projectVertices(s, v), inside: gestureTest(g), view: v };
}

/** Vertex facing the viewer (for the "front faces only" option). */
export function frontFacing(gh: GestureHits): (vi: number) => boolean {
  const s = gh.s;
  const cam = gh.view.camera;
  const inv = s.world().clone().invert();
  const camLocal = new Vector3().setFromMatrixPosition(cam.matrixWorld).applyMatrix4(inv);
  const ortho = (cam as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
  const dir = new Vector3(0, 0, -1).transformDirection(cam.matrixWorld).transformDirection(inv);
  return (vi) => {
    const P = s.positions,
      N = s.vn;
    let tx: number, ty: number, tz: number;
    if (ortho) {
      tx = -dir.x;
      ty = -dir.y;
      tz = -dir.z;
    } else {
      tx = camLocal.x - P[vi * 3];
      ty = camLocal.y - P[vi * 3 + 1];
      tz = camLocal.z - P[vi * 3 + 2];
    }
    return N[vi * 3] * tx + N[vi * 3 + 1] * ty + N[vi * 3 + 2] * tz > 0;
  };
}

/** Vertices inside the gesture (visible ones only). */
export function vertsInside(gh: GestureHits, frontOnly = false): Uint8Array {
  const { s, proj, inside } = gh;
  const out = new Uint8Array(s.nv);
  const ff = frontOnly ? frontFacing(gh) : null;
  const hid = s.hiddenV;
  for (let i = 0; i < s.nv; i++) {
    const z = proj[i * 3 + 2];
    if (z < -1 || z > 1 || hid?.[i]) continue;
    if (!inside(proj[i * 3], proj[i * 3 + 1])) continue;
    if (ff && !ff(i)) continue;
    out[i] = 1;
  }
  return out;
}

/** Faces whose (projected) center lies inside the gesture (visible ones only). */
export function facesInside(gh: GestureHits, frontOnly = false): Uint8Array {
  const { s, proj, inside } = gh;
  const out = new Uint8Array(s.nf);
  const ff = frontOnly ? frontFacing(gh) : null;
  const hf = s.hiddenF;
  for (let f = 0; f < s.nf; f++) {
    if (hf?.[f]) continue;
    const a = s.offsets[f],
      b = s.offsets[f + 1];
    let x = 0,
      y = 0,
      ok = true,
      front = !ff;
    for (let c = a; c < b; c++) {
      const vi = s.indices[c];
      const z = proj[vi * 3 + 2];
      if (z < -1 || z > 1) ok = false;
      x += proj[vi * 3];
      y += proj[vi * 3 + 1];
      if (ff && ff(vi)) front = true;
    }
    if (!ok || !front) continue;
    if (inside(x / (b - a), y / (b - a))) out[f] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// interactive drawing

const draw = {
  view: null as View3D | null,
  g: null as Gesture | null,
  /** polyline: current pointer position (rubber band segment) */
  hover: null as Pt | null,
};

function pathD(pts: Pt[], close: boolean) {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('') + (close ? 'Z' : '');
}

editModeHooks.svg.push((v) => {
  const g = draw.g;
  if (!g || draw.view !== v) return null;
  const outline = (d: string, fill: string) => [
    h('path', { d, fill, stroke: '#000', 'stroke-width': 1 }),
    h('path', { d, fill: 'none', stroke: '#fff', 'stroke-width': 1, 'stroke-dasharray': '4 3' }),
  ];
  let parts: VNode[] = [];
  if (g.kind === 'BOX') {
    const x = Math.min(g.x0, g.x1),
      y = Math.min(g.y0, g.y1),
      w = Math.abs(g.x1 - g.x0),
      hh = Math.abs(g.y1 - g.y0);
    parts = outline(`M${x} ${y}h${w}v${hh}h${-w}Z`, 'rgba(255,255,255,0.06)') as VNode[];
  } else if (g.kind === 'LINE') {
    const dx = g.b.x - g.a.x,
      dy = g.b.y - g.a.y;
    const len = Math.hypot(dx, dy) || 1;
    // shade the affected side
    const s = g.flip ? -1 : 1;
    const nx = (-dy / len) * s,
      ny = (dx / len) * s;
    const far = 4000;
    const ext = g.limit ? 0 : far;
    const ax = g.a.x - (dx / len) * ext,
      ay = g.a.y - (dy / len) * ext,
      bx = g.b.x + (dx / len) * ext,
      by = g.b.y + (dy / len) * ext;
    parts = [
      h('path', { d: `M${ax} ${ay}L${bx} ${by}L${bx + nx * far} ${by + ny * far}L${ax + nx * far} ${ay + ny * far}Z`, fill: 'rgba(255,255,255,0.07)', stroke: 'none' }) as VNode,
      ...(outline(`M${g.a.x} ${g.a.y}L${g.b.x} ${g.b.y}`, 'none') as VNode[]),
      h('path', { d: `M${(g.a.x + g.b.x) / 2} ${(g.a.y + g.b.y) / 2}l${nx * 14} ${ny * 14}`, stroke: '#fff', 'stroke-width': 1.5 }) as VNode,
    ];
  } else {
    const pts = draw.hover && g.kind === 'POLYLINE' ? [...g.pts, draw.hover] : g.pts;
    parts = outline(pathD(pts, g.kind === 'LASSO'), 'rgba(255,255,255,0.06)') as VNode[];
    if (g.kind === 'POLYLINE' && g.pts.length)
      parts.push(h('circle', { cx: g.pts[0].x, cy: g.pts[0].y, r: 5, fill: 'none', stroke: '#fff', 'stroke-width': 1 }) as VNode);
  }
  return h('g', { key: 'paint-gesture' }, ...parts) as VNode;
});

/** The gesture being drawn (for tests / other modules). */
export function currentGesture(): Gesture | null {
  return draw.g;
}

export interface GestureRun {
  op: string;
  kind: GestureShape;
  /** extra operator props (target settings) */
  props?: Record<string, unknown>;
  /** extra props applied when Ctrl is held at the start (e.g. unmask) */
  ctrlProps?: Record<string, unknown>;
  label: string;
}

/**
 * Draw a gesture interactively, then run `op` with the shape props. `start` is the pointer event
 * that began the gesture (tools); without it the first click starts it (menu / shortcut).
 */
export function startGesture(v: View3D, run: GestureRun, start?: PointerEvent): boolean {
  if (app.modal) return false;
  draw.view = v;
  draw.g = null;
  draw.hover = null;
  let extra: Record<string, unknown> = { ...(run.props ?? {}) };
  let pressed = false;
  let done = false;
  let lastClick = 0;
  let moveLine = false;
  const begin = (e: PointerEvent) => {
    const p = v.local(e);
    if ((e.ctrlKey || e.metaKey) && run.ctrlProps) extra = { ...extra, ...run.ctrlProps };
    pressed = true;
    if (run.kind === 'BOX') draw.g = { kind: 'BOX', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    else if (run.kind === 'LASSO') draw.g = { kind: 'LASSO', pts: [p] };
    else if (run.kind === 'LINE') draw.g = { kind: 'LINE', a: p, b: { ...p }, flip: false, limit: false };
    else {
      draw.g = { kind: 'POLYLINE', pts: [p] };
      pressed = false;
    }
    v.drawSvg();
  };
  const finishPolyline = () => {
    const g = draw.g;
    if (g?.kind !== 'POLYLINE' || g.pts.length < 3) return 'CANCELLED' as const;
    done = true;
    return 'CANCELLED' as const;
  };
  app.startModal({
    label: run.label,
    cursor: 'crosshair',
    onPointerDown: (e) => {
      if (e.button === 2) return 'CANCELLED';
      if (e.button !== 0) return;
      if (run.kind === 'POLYLINE' && draw.g?.kind === 'POLYLINE') {
        const p = v.local(e);
        const g = draw.g;
        const first = g.pts[0];
        const now = performance.now();
        // close on the first point or by double-clicking
        if ((g.pts.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) < 8) || now - lastClick < 300) {
          lastClick = 0;
          return finishPolyline();
        }
        lastClick = now;
        g.pts.push(p);
        v.drawSvg();
        return;
      }
      if (!draw.g) begin(e);
    },
    onPointerMove: (e) => {
      const p = v.local(e);
      const g = draw.g;
      if (!g) return;
      if (g.kind === 'POLYLINE') {
        draw.hover = p;
      } else if (!pressed) return;
      else if (g.kind === 'BOX') {
        g.x1 = p.x;
        g.y1 = p.y;
      } else if (g.kind === 'LASSO') {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 2) g.pts.push(p);
      } else if (g.kind === 'LINE') {
        if (moveLine) {
          g.a.x += p.x - g.b.x;
          g.a.y += p.y - g.b.y;
        }
        g.b.x = p.x;
        g.b.y = p.y;
      }
      v.drawSvg();
    },
    onPointerUp: () => {
      if (!pressed || !draw.g || draw.g.kind === 'POLYLINE') return;
      pressed = false;
      done = true;
      return 'CANCELLED';
    },
    onKey: (e) => {
      const g = draw.g;
      if (e.type === 'keyup') {
        if (e.key === ' ' || e.code === 'Space') moveLine = false;
        return true;
      }
      if (e.key === 'Escape') return 'CANCELLED';
      if (g?.kind === 'POLYLINE') {
        if (e.key === 'Enter') return finishPolyline();
        if (e.key === 'Backspace' && g.pts.length > 1) {
          g.pts.pop();
          v.drawSvg();
        }
      }
      if (g?.kind === 'LINE') {
        if (e.key === 'f' || e.key === 'F') {
          g.flip = !g.flip;
          v.drawSvg();
        }
        if (e.key === 'Alt') {
          g.limit = !g.limit;
          v.drawSvg();
        }
        if (e.key === ' ' || e.code === 'Space') moveLine = true;
      }
      return true;
    },
    cancel: () => {
      const g = draw.g;
      draw.g = null;
      draw.hover = null;
      v.drawSvg();
      if (!done || !g) return;
      const props = { ...extra, ...propsFromGesture(g) };
      if (!gestureFromProps(run.kind, props)) return;
      app.run(run.op, props, { invoke: false });
    },
    header: () =>
      run.kind === 'POLYLINE'
        ? `${run.label}: click to add points, click the first point / double-click / Enter to apply, Backspace removes a point, Esc cancels`
        : run.kind === 'LINE'
          ? `${run.label}: drag to draw the line, F flips the side, Alt limits to the segment, Space moves the line`
          : `${run.label}: drag to draw, Esc cancels`,
  });
  if (start) begin(start);
  return true;
}

// ---------------------------------------------------------------------------
// operator registration

export interface GestureTarget {
  /** operator id per shape */
  ops: Partial<Record<GestureShape, string>>;
  label: Partial<Record<GestureShape, string>>;
  description: string;
  props: PropDef[];
  /** applied with the gesture; return 'CANCELLED' when nothing changed */
  apply(v: View3D, g: Gesture, p: Record<string, unknown>): 'CANCELLED' | void;
  ctrlProps?: Record<string, unknown>;
}

export function registerGestureTarget(t: GestureTarget) {
  for (const kind of Object.keys(t.ops) as GestureShape[]) {
    const idname = t.ops[kind]!;
    registerOperators([
      {
        idname,
        label: t.label[kind]!,
        description: t.description,
        props: [...shapeProps(kind), ...t.props],
        poll: () => sculptPoll() && !!activeView3D(),
        invoke: (_ctx, p) => {
          const v = activeView3D()!;
          const { ...rest } = p;
          for (const d of shapeProps(kind)) if (d.hidden) delete rest[d.id];
          return startGesture(v, { op: idname, kind, props: rest, ctrlProps: t.ctrlProps, label: t.label[kind]! }) ? 'RUNNING_MODAL' : 'CANCELLED';
        },
        exec: (_ctx, p) => {
          const v = activeView3D();
          const g = gestureFromProps(kind, p);
          if (!v || !g) return 'CANCELLED';
          return t.apply(v, g, p);
        },
      },
    ]);
  }
}
