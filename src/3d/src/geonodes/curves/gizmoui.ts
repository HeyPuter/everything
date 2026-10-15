// Viewport handles of the geometry gizmo nodes: drawn on the 3D viewport's SVG overlay for the
// active object, dragging them changes the values linked into the gizmo nodes.
import { Euler, Matrix3, Matrix4, Vector3 } from 'three';
import { h, type VNode } from '../../ui/h';
import { app } from '../../app/app';
import { editModeHooks } from '../../editors/view3d/hooks';
import type { View3D } from '../../editors/view3d/view3d';
import type { ModifierBase, NodeData, NodeTreeData } from '../../data/types';
import { gizmoStates, matrixTargets, valueTargets, type GizmoState, type MatrixTarget, type ValueTarget } from './gizmos';

const COLORS: Record<string, string> = { PRIMARY: '#f5a623', SECONDARY: '#5ac8fa', X: '#ff3352', Y: '#8bdc00', Z: '#2890ff' };
const AXIS = ['#ff3352', '#8bdc00', '#2890ff'];
const GIZMO_TYPES = new Set(['GeometryNodeGizmoLinear', 'GeometryNodeGizmoDial', 'GeometryNodeGizmoTransform']);

interface Live {
  state: GizmoState;
  tree: NodeTreeData;
  mod: ModifierBase;
  world: Matrix4;
  /** world position and orientation of the gizmo */
  pos: Vector3;
  basis: Matrix3;
}

/** Gizmos of the active object's geometry node modifiers. */
function liveGizmos(): Live[] {
  const ob = app.activeObject;
  if (!ob) return [];
  const ev = app.graph.get(ob.id);
  if (!ev || !ev.visible) return [];
  const out: Live[] = [];
  for (const m of ob.modifiers) {
    if (m.type !== 'NODES' || m.show_viewport === false) continue;
    const gid = (m as { node_group?: string | null }).node_group;
    const tree = gid ? app.doc.node_groups[gid]?.tree : undefined;
    if (!tree) continue;
    for (const n of tree.nodes) {
      if (!GIZMO_TYPES.has(n.type) || n.mute) continue;
      const state = gizmoStates.get(`${ob.id}/${m.id}/${n.id}`);
      if (!state) continue;
      const pos = new Vector3(...state.position).applyMatrix4(ev.world);
      const basis = new Matrix3().setFromMatrix4(ev.world);
      if (state.kind === 'TRANSFORM') basis.multiply(new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromEuler(new Euler(...state.rotation, 'XYZ'))));
      out.push({ state, tree, mod: m, world: ev.world, pos, basis });
    }
  }
  return out;
}

const keyOf = (g: Live) => `${g.state.objectId}/${g.state.modifierId}/${g.state.nodeId}`;

/** Unit vector perpendicular to n. */
function perp(n: Vector3) {
  const a = Math.abs(n.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  return a.sub(n.clone().multiplyScalar(a.dot(n))).normalize();
}

function ringPath(v: View3D, center: Vector3, normal: Vector3, radius: number): string {
  const u = perp(normal),
    w = new Vector3().crossVectors(normal, u);
  const pts: string[] = [];
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const s = v.project(
      center
        .clone()
        .addScaledVector(u, Math.cos(a) * radius)
        .addScaledVector(w, Math.sin(a) * radius),
    );
    pts.push(`${k ? 'L' : 'M'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`);
  }
  return pts.join('');
}

/** One draggable handle: a group (hover highlight) of a wide invisible grab stroke and the visible marks. */
const handle = (gizmo: string, ...children: VNode[]) => h('g', { class: 'gz', 'data-gngizmo': gizmo }, children);
const grab = (tag: 'line' | 'path', attrs: Record<string, unknown>, width = 12) => h(tag, { ...attrs, fill: 'none', stroke: 'transparent', 'stroke-width': width, class: 'gz-hit' });

function arrow(v: View3D, from: Vector3, to: Vector3, color: string, style: string, gizmo: string): VNode {
  const a = v.project(from),
    b = v.project(to);
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l = Math.hypot(dx, dy) || 1;
  const ux = dx / l,
    uy = dy / l;
  const line = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  const head =
    style === 'CROSS'
      ? h('path', { d: `M${b.x - 6} ${b.y - 6}L${b.x + 6} ${b.y + 6}M${b.x - 6} ${b.y + 6}L${b.x + 6} ${b.y - 6}`, stroke: color, 'stroke-width': 2.2 })
      : style === 'BOX'
        ? h('rect', { x: b.x - 5, y: b.y - 5, width: 10, height: 10, fill: color })
        : h('path', { d: `M${b.x + ux * 12} ${b.y + uy * 12}L${b.x - uy * 5} ${b.y + ux * 5}L${b.x + uy * 5} ${b.y - ux * 5}Z`, fill: color });
  return handle(gizmo, grab('line', line), h('line', { ...line, stroke: color, 'stroke-width': 2.2, 'stroke-linecap': 'round' }), head);
}

function dialRadius(v: View3D, g: Live) {
  // screen-space dials keep their size on screen; others scale with the object
  if (g.state.screenSpace) return v.nav.pixelSize(g.pos) * 40 * g.state.radius;
  const s = new Vector3().setFromMatrixScale(g.world);
  return (g.state.radius * (s.x + s.y + s.z)) / 3;
}

function drawGizmo(v: View3D, g: Live): VNode[] {
  const key = keyOf(g);
  const col = COLORS[g.state.color] ?? COLORS.PRIMARY;
  const size = v.nav.pixelSize(g.pos) * 70;
  if (v.project(g.pos).z > 1) return [];
  if (g.state.kind === 'LINEAR') {
    const dir = new Vector3(...g.state.axis).applyMatrix3(g.basis);
    if (dir.lengthSq() < 1e-12) return [];
    dir.normalize();
    return [arrow(v, g.pos, g.pos.clone().addScaledVector(dir, size), col, g.state.drawStyle, `${key}|lin`)];
  }
  if (g.state.kind === 'DIAL') {
    const up = new Vector3(...g.state.axis).applyMatrix3(g.basis);
    if (up.lengthSq() < 1e-12) return [];
    const d = ringPath(v, g.pos, up.normalize(), dialRadius(v, g));
    return [handle(`${key}|dial`, grab('path', { d }), h('path', { d, fill: 'none', stroke: col, 'stroke-width': 2.6 }))];
  }
  const parts: VNode[] = [];
  const axes = [0, 1, 2].map((i) => new Vector3().setFromMatrix3Column(g.basis, i).normalize());
  const u = g.state.use;
  axes.forEach((ax, i) => {
    if (!u.rotate[i]) return;
    const d = ringPath(v, g.pos, ax, size * 0.9);
    parts.push(handle(`${key}|r:${i}`, grab('path', { d }, 10), h('path', { d, fill: 'none', stroke: AXIS[i], 'stroke-width': 2 })));
  });
  axes.forEach((ax, i) => {
    if (u.translate[i]) parts.push(arrow(v, g.pos.clone().addScaledVector(ax, size * 0.2), g.pos.clone().addScaledVector(ax, size * 1.15), AXIS[i], 'ARROW', `${key}|t:${i}`));
    if (u.scale[i]) {
      const p = v.project(g.pos.clone().addScaledVector(ax, size * 0.6));
      parts.push(handle(`${key}|s:${i}`, h('rect', { x: p.x - 5, y: p.y - 5, width: 10, height: 10, fill: AXIS[i] })));
    }
  });
  return parts;
}

editModeHooks.svg.push((v: View3D) => {
  if (!v.overlay.show_overlays || !v.showGizmos || app.modal) return null;
  const list = liveGizmos();
  if (!list.length) return null;
  return h(
    'g',
    { class: 'gn-gizmos' },
    list.flatMap((g) => drawGizmo(v, g)),
  );
});

// ---------------------------------------------------------------------------
// Dragging

/** Parameter along a world line closest to the view ray under the mouse. */
function lineParam(v: View3D, x: number, y: number, origin: Vector3, dir: Vector3): number | null {
  const r = v.ray(x, y);
  const w0 = origin.clone().sub(r.origin);
  const a = dir.dot(dir),
    b = dir.dot(r.dir),
    c = r.dir.dot(r.dir),
    d = dir.dot(w0),
    e = r.dir.dot(w0);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-10) return null;
  return (b * e - c * d) / den;
}

/** Angle of the mouse around an axis through center (in the plane of the axis). */
function planeAngle(v: View3D, x: number, y: number, center: Vector3, axis: Vector3): number | null {
  const r = v.ray(x, y);
  const den = r.dir.dot(axis);
  const u = perp(axis),
    w = new Vector3().crossVectors(axis, u);
  let p: Vector3;
  if (Math.abs(den) > 1e-4) p = r.origin.clone().addScaledVector(r.dir, center.clone().sub(r.origin).dot(axis) / den);
  else return null;
  const d = p.sub(center);
  return Math.atan2(d.dot(w), d.dot(u));
}

function rotationAbout(axis: Vector3, angle: number, pivot: Vector3): Matrix4 {
  const m = new Matrix4().makeRotationAxis(axis, angle);
  return new Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(m)
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}

/** Live document data of a gizmo: its tree, modifier and node looked up by id at the time of use. */
function liveTarget(key: string) {
  const [objectId, modifierId, nodeId] = key.split('/');
  const ob = app.doc.objects[objectId];
  const mod = ob?.modifiers.find((m) => m.id === modifierId);
  const gid = (mod as { node_group?: string | null } | undefined)?.node_group;
  const tree = gid ? app.doc.node_groups[gid]?.tree : undefined;
  const node = tree?.nodes.find((n) => n.id === nodeId);
  return mod && tree && node ? { mod, tree, node } : null;
}

editModeHooks.pointer.push((v: View3D, e: PointerEvent) => {
  if (!(e.target as Element | null)?.closest?.('[data-gngizmo]')) return false;
  // every handle under the pointer, topmost first: overlapping gizmos without anything to edit
  // let the click through to the next one
  const hits = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(e.clientX, e.clientY) : [e.target as Element];
  const ids: string[] = [];
  for (const h0 of hits) {
    const id = h0.closest?.('[data-gngizmo]')?.getAttribute('data-gngizmo');
    if (id && !ids.includes(id)) ids.push(id);
  }
  const live = liveGizmos();
  let picked: { g: Live; part: string; node: NodeData; values: ValueTarget[]; mats: MatrixTarget[] } | null = null;
  for (const id of ids) {
    const [key, part] = id.split('|');
    const g = live.find((x) => keyOf(x) === key);
    const t = liveTarget(key);
    if (!g || !t) continue;
    const values = g.state.kind === 'TRANSFORM' ? [] : valueTargets(app.doc, t.tree, t.mod, t.node);
    const mats = g.state.kind === 'TRANSFORM' ? matrixTargets(t.tree, t.mod, t.node) : [];
    if (values.length || mats.length) {
      picked = { g, part, node: t.node, values, mats };
      break;
    }
  }
  e.preventDefault();
  e.stopPropagation();
  if (!picked) {
    app.report('INFO', 'Link a Value node or a modifier input into the gizmo to edit it');
    return true;
  }
  const { g, part, values, mats } = picked;
  const startVals = values.map((t) => t.get());
  const startMats = mats.map((t) => t.get());
  const s0 = v.local(e);
  // drag setup per handle
  let update: (x: number, y: number) => void = () => {};
  const setValues = (delta: number) =>
    values.forEach((t, i) => {
      const nv = startVals[i] + t.factor * delta;
      t.set(t.integer ? Math.round(nv) : nv);
    });
  const setMats = (fn: (m: Matrix4) => Matrix4) =>
    mats.forEach((t, i) => {
      const m = new Matrix4().fromArray(startMats[i]);
      t.set(fn(m).toArray());
    });
  const kind = part.split(':')[0];
  const axisIndex = Number(part.split(':')[1] ?? 0);
  if (kind === 'lin' || kind === 't') {
    const localDir =
      kind === 'lin'
        ? new Vector3(...g.state.axis).normalize()
        : new Vector3().setFromMatrix3Column(new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromEuler(new Euler(...g.state.rotation, 'XYZ'))), axisIndex);
    const worldDir = localDir.clone().applyMatrix3(new Matrix3().setFromMatrix4(g.world));
    const scale = worldDir.length() || 1;
    worldDir.normalize();
    const t0 = lineParam(v, s0.x, s0.y, g.pos, worldDir) ?? 0;
    update = (x, y) => {
      const t = lineParam(v, x, y, g.pos, worldDir);
      if (t === null) return;
      const local = (t - t0) / scale;
      if (kind === 'lin') setValues(local);
      else setMats((m) => new Matrix4().makeTranslation(localDir.x * local, localDir.y * local, localDir.z * local).multiply(m));
    };
  } else if (kind === 'dial' || kind === 'r') {
    const localAxis =
      kind === 'dial'
        ? new Vector3(...g.state.axis).normalize()
        : new Vector3().setFromMatrix3Column(new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromEuler(new Euler(...g.state.rotation, 'XYZ'))), axisIndex);
    const worldAxis = localAxis.clone().applyMatrix3(new Matrix3().setFromMatrix4(g.world).invert().transpose()).normalize();
    let prev = planeAngle(v, s0.x, s0.y, g.pos, worldAxis) ?? 0;
    let total = 0;
    update = (x, y) => {
      const a = planeAngle(v, x, y, g.pos, worldAxis);
      if (a === null) return;
      let d = a - prev;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      prev = a;
      total += d;
      if (kind === 'dial') setValues(total);
      else {
        const pivot = new Vector3(...g.state.position);
        setMats((m) => rotationAbout(localAxis, total, pivot).multiply(m));
      }
    };
  } else if (kind === 's') {
    const center = v.project(g.pos);
    const d0 = Math.max(1, Math.hypot(s0.x - center.x, s0.y - center.y));
    update = (x, y) => {
      const f = Math.hypot(x - center.x, y - center.y) / d0;
      setMats((m) => {
        const sc = new Vector3(1, 1, 1).setComponent(axisIndex, f);
        return m.clone().multiply(new Matrix4().makeScale(sc.x, sc.y, sc.z));
      });
    };
  }
  const move = (ev: PointerEvent) => {
    const p = v.local(ev);
    update(p.x, p.y);
    app.changed('doc');
  };
  const finish = (cancel: boolean) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('keydown', onKey, true);
    if (cancel) {
      values.forEach((t, i) => t.set(startVals[i]));
      mats.forEach((t, i) => t.set(startMats[i]));
      app.changed('doc');
    } else app.pushUndo('Gizmo');
  };
  const up = () => finish(false);
  const onKey = (ke: KeyboardEvent) => {
    if (ke.key === 'Escape') {
      ke.preventDefault();
      ke.stopPropagation();
      finish(true);
    }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('keydown', onKey, true);
  return true;
});

export {};
