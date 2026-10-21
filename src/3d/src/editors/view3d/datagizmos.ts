// Object data gizmos of the active object in Object Mode, drawn on the viewport's SVG overlay:
//  - lights: Look At handle (aims spot / area / sun lights), spot size and blend handles on the
//    cone, a radius handle for point / spot lights, edge handles for the area light size;
//  - cameras: frame corner handle for the focal length (orthographic scale) and, with depth of
//    field, a focus distance handle on the camera axis;
//  - image empties: corner handles that resize the image keeping the opposite corner in place.
// Which ones show is set per viewport in the header's Gizmos popover.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { h, type VNode } from '../../ui/h';
import { app } from '../../app/app';
import { applyMatrixToObject } from '../../eval/transform';
import { editModeHooks } from './hooks';
import { raycastScene } from './navextra';
import { spotBlendAngle } from './lightshapes';
import { imageEmptySize } from '../../render/scene';
import type { View3D } from './view3d';
import type { CameraData, LightData, ObjectData } from '../../data/types';

/** Per-viewport switches of the object data gizmos (stored on the viewport). */
export type DataGizmoSettings = View3D['dataGizmos'];
export function dataGizmoSettings(v: View3D): DataGizmoSettings {
  return v.dataGizmos;
}

const LOOK_AT = '#f4dc3c';
const HANDLE = '#5fd3f5';

const ID = new Matrix4();

function activeTarget(v: View3D): ObjectData | null {
  if (app.doc.mode !== 'OBJECT' || app.modal) return null;
  const ob = app.activeObject;
  if (!ob || !ob.select || !app.graph.get(ob.id)?.visible) return null;
  if (!v.overlay.show_overlays || !v.showGizmos || !dataGizmoSettings(v).activeObject) return null;
  return ob;
}

/** World size of one screen pixel at p. */
function pixel(v: View3D, p: Vector3): number {
  const right = new Vector3(1, 0, 0).applyQuaternion(v.camera.quaternion);
  const a = v.project(p),
    b = v.project(p.clone().add(right));
  return 1 / Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
}

/** Viewport point (CSS px) from a client event. */
function local(v: View3D, e: { clientX: number; clientY: number }) {
  const r = v.el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Point under the pointer on a plane (point + normal), or null when the plane is edge-on. */
function onPlane(v: View3D, x: number, y: number, p: Vector3, n: Vector3): Vector3 | null {
  const { origin, dir } = v.ray(x, y);
  const d = dir.dot(n);
  if (Math.abs(d) < 1e-6) return null;
  const t = p.clone().sub(origin).dot(n) / d;
  return origin.addScaledVector(dir, t);
}

/** Point under the pointer on the plane through p facing the viewer. */
function onViewPlane(v: View3D, x: number, y: number, p: Vector3) {
  const n = new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion);
  return onPlane(v, x, y, p, n) ?? p.clone();
}

function frameOf(ob: ObjectData) {
  const w = app.graph.get(ob.id)?.world ?? ID;
  const pos = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  w.decompose(pos, q, s);
  const ax = (i: number) => new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyQuaternion(q);
  return { world: w, pos, q, scale: s, x: ax(0), y: ax(1), z: ax(2) };
}

/** Write a world matrix back to the object (through its parent). */
function setWorld(ob: ObjectData, world: Matrix4) {
  const parent = ob.parent ? app.graph.get(ob.parent) : undefined;
  const local = parent ? parent.world.clone().multiply(new Matrix4().fromArray(ob.matrix_parent_inverse)).invert().multiply(world) : world;
  applyMatrixToObject(ob, local);
}

// ---------------------------------------------------------------------------
// handle layout (screen positions) per object type

interface Handle {
  id: string;
  /** world position */
  at: Vector3;
  color: string;
  shape?: 'dot' | 'ring' | 'square' | 'cross';
  tip: string;
}

function lightHandles(v: View3D, ob: ObjectData, la: LightData, s: DataGizmoSettings): { handles: Handle[]; extras: VNode[] } {
  const f = frameOf(ob);
  const px = pixel(v, f.pos);
  const down = f.z.clone().negate();
  const handles: Handle[] = [];
  const extras: VNode[] = [];
  const viewDir = new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion);
  // a direction across the light axis that reads well on screen
  let side = new Vector3().crossVectors(down, viewDir);
  if (side.lengthSq() < 1e-8) side = f.x.clone();
  side.normalize();
  if (s.light_look_at && la.type !== 'POINT') {
    const at = f.pos.clone().addScaledVector(down, 105 * px);
    const p0 = v.project(f.pos),
      p1 = v.project(at);
    extras.push(h('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: LOOK_AT, 'stroke-width': 1, opacity: 0.5 }));
    handles.push({ id: 'look_at', at, color: LOOK_AT, tip: 'Look At: drag to aim the light' });
  }
  if (s.light_size) {
    if (la.type === 'SPOT') {
      const d = 75 * px;
      const half = Math.min(Math.PI / 2 - 0.01, la.spot_size / 2);
      const base = f.pos.clone().addScaledVector(down, d);
      handles.push({ id: 'spot_size', at: base.clone().addScaledVector(side, d * Math.tan(half)), color: HANDLE, tip: 'Spot Size: drag to widen or narrow the cone' });
      if (la.spot_size > 0.02) handles.push({ id: 'spot_blend', at: base.clone().addScaledVector(side, -d * Math.tan(spotBlendAngle(la.spot_size, la.spot_blend))), color: HANDLE, shape: 'square', tip: 'Spot Blend: drag to soften the cone edge' });
      const a = v.project(base.clone().addScaledVector(side, d * Math.tan(half))),
        b = v.project(base.clone().addScaledVector(side, -d * Math.tan(half))),
        o = v.project(f.pos);
      extras.push(h('path', { d: `M${a.x} ${a.y}L${o.x} ${o.y}L${b.x} ${b.y}`, fill: 'none', stroke: HANDLE, 'stroke-width': 1, opacity: 0.45 }));
    }
    if (la.type === 'POINT' || la.type === 'SPOT') {
      const scale = Math.max(f.scale.x, f.scale.y, f.scale.z);
      const r = Math.max(la.shadow_soft_size * scale, 16 * px);
      const up = new Vector3(0, 1, 0).applyQuaternion(v.camera.quaternion);
      const right = new Vector3(1, 0, 0).applyQuaternion(v.camera.quaternion);
      handles.push({ id: 'radius', at: f.pos.clone().addScaledVector(right.add(up).normalize(), r), color: HANDLE, shape: 'ring', tip: 'Radius: drag to change the light size' });
    }
    if (la.type === 'AREA') {
      const rect = la.shape === 'RECTANGLE' || la.shape === 'ELLIPSE';
      const sx = (la.size / 2) * f.scale.x,
        sy = ((rect ? la.size_y : la.size) / 2) * f.scale.y;
      handles.push({ id: 'area_x', at: f.pos.clone().addScaledVector(f.x, sx), color: HANDLE, shape: 'square', tip: rect ? 'Size X: drag to resize' : 'Size: drag to resize' });
      if (rect) handles.push({ id: 'area_y', at: f.pos.clone().addScaledVector(f.y, sy), color: HANDLE, shape: 'square', tip: 'Size Y: drag to resize' });
    }
  }
  return { handles, extras };
}

/** Camera frame half sizes at the display distance (matches the drawn frame). */
function cameraFrameHalf(ca: CameraData) {
  const r = app.doc.scene.render;
  const aspect = (r.resolution_x * r.pixel_aspect_x) / (r.resolution_y * r.pixel_aspect_y);
  const d = ca.display_size;
  if (ca.type === 'ORTHO') {
    let w = ca.ortho_scale / 2,
      hh = w / aspect;
    if (aspect < 1) {
      hh = ca.ortho_scale / 2;
      w = hh * aspect;
    }
    return { w, h: hh, d, aspect };
  }
  const vertical = ca.sensor_fit === 'VERTICAL' || (ca.sensor_fit === 'AUTO' && aspect < 1);
  const sensor = ca.sensor_fit === 'VERTICAL' ? ca.sensor_height : ca.sensor_width;
  const half = (sensor / 2 / ca.lens) * d;
  return vertical ? { w: half * aspect, h: half, d, aspect } : { w: half, h: half / aspect, d, aspect };
}

function cameraHandles(v: View3D, ob: ObjectData, ca: CameraData, s: DataGizmoSettings): { handles: Handle[]; extras: VNode[] } {
  const f = frameOf(ob);
  const handles: Handle[] = [];
  const extras: VNode[] = [];
  if (s.camera_lens) {
    const { w, h: hh, d } = cameraFrameHalf(ca);
    const corner = new Vector3(w, hh, -d).applyMatrix4(f.world);
    handles.push({ id: 'lens', at: corner, color: HANDLE, shape: 'square', tip: ca.type === 'ORTHO' ? 'Orthographic Scale: drag to resize the view' : 'Focal Length: drag to zoom the lens' });
  }
  if (s.camera_focus_distance && ca.dof?.use_dof && !ca.dof.focus_object) {
    const at = f.pos.clone().addScaledVector(f.z, -ca.dof.focus_distance * 1);
    const p0 = v.project(f.pos),
      p1 = v.project(at);
    if (p1.z < 1) extras.push(h('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: HANDLE, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.6 }));
    handles.push({ id: 'focus', at, color: HANDLE, shape: 'cross', tip: 'Focus Distance: drag along the camera axis' });
  }
  return { handles, extras };
}

function imageCorners(ob: ObjectData) {
  const img = ob.data ? app.doc.images[ob.data] : undefined;
  const [w, hh] = imageEmptySize(ob, img);
  const off = ob.empty_image_offset ?? [-0.5, -0.5];
  const x0 = off[0] * w,
    y0 = off[1] * hh;
  return { w, h: hh, corners: [new Vector3(x0, y0, 0), new Vector3(x0 + w, y0, 0), new Vector3(x0 + w, y0 + hh, 0), new Vector3(x0, y0 + hh, 0)] };
}

function emptyHandles(ob: ObjectData, s: DataGizmoSettings): { handles: Handle[]; extras: VNode[] } {
  if (!s.empty_image || ob.empty_display_type !== 'IMAGE') return { handles: [], extras: [] };
  const f = frameOf(ob);
  const { corners } = imageCorners(ob);
  return { handles: corners.map((c, i) => ({ id: `image:${i}`, at: c.clone().applyMatrix4(f.world), color: HANDLE, shape: 'square' as const, tip: 'Image Size: drag to resize (the opposite corner stays)' })), extras: [] };
}

function handlesFor(v: View3D, ob: ObjectData) {
  const s = dataGizmoSettings(v);
  if (ob.type === 'LIGHT' && ob.data && app.doc.lights[ob.data]) return lightHandles(v, ob, app.doc.lights[ob.data], s);
  if (ob.type === 'CAMERA' && ob.data && app.doc.cameras[ob.data]) return cameraHandles(v, ob, app.doc.cameras[ob.data], s);
  if (ob.type === 'EMPTY') return emptyHandles(ob, s);
  return { handles: [], extras: [] };
}

function drawHandle(v: View3D, hd: Handle): VNode | null {
  const p = v.project(hd.at);
  if (p.z > 1 || p.z < -1) return null;
  const common = { 'data-ogz': hd.id, class: 'gz ogz', 'data-tip': hd.tip };
  switch (hd.shape) {
    case 'ring':
      return h('circle', { ...common, cx: p.x, cy: p.y, r: 5, fill: 'transparent', stroke: hd.color, 'stroke-width': 2 });
    case 'square':
      return h('rect', { ...common, x: p.x - 4, y: p.y - 4, width: 8, height: 8, fill: hd.color });
    case 'cross':
      return h('g', common, h('circle', { cx: p.x, cy: p.y, r: 8, fill: 'transparent' }), h('path', { d: `M${p.x - 6} ${p.y}H${p.x + 6}M${p.x} ${p.y - 6}V${p.y + 6}`, stroke: hd.color, 'stroke-width': 2 }));
    default:
      return h('circle', { ...common, cx: p.x, cy: p.y, r: 5, fill: hd.color });
  }
}

editModeHooks.svg.push((v) => {
  const ob = activeTarget(v);
  if (!ob) return null;
  const { handles, extras } = handlesFor(v, ob);
  if (!handles.length) return null;
  return h('g', { class: 'data-gizmos' }, ...extras, ...handles.map((hd) => drawHandle(v, hd)));
});

// ---------------------------------------------------------------------------
// dragging

/** Snapshot of the values a drag may change, for cancelling. */
function snapshot(ob: ObjectData) {
  const data = ob.type === 'LIGHT' && ob.data ? app.doc.lights[ob.data] : ob.type === 'CAMERA' && ob.data ? app.doc.cameras[ob.data] : null;
  return {
    ob: { location: [...ob.location], rotation_euler: [...ob.rotation_euler], rotation_quaternion: [...ob.rotation_quaternion], rotation_axis_angle: [...ob.rotation_axis_angle], scale: [...ob.scale], empty_display_size: ob.empty_display_size, empty_image_offset: ob.empty_image_offset ? [...ob.empty_image_offset] : undefined },
    data: data ? structuredClone(data) : null,
  };
}

function restore(ob: ObjectData, snap: ReturnType<typeof snapshot>) {
  Object.assign(ob, structuredClone(snap.ob));
  if (snap.data) {
    const table = ob.type === 'LIGHT' ? app.doc.lights : app.doc.cameras;
    if (ob.data) Object.assign(table[ob.data] as object, structuredClone(snap.data));
  }
}

/** Apply the drag of handle `id` to the pointer at (x, y). Exported for tests. */
export function dragHandle(v: View3D, ob: ObjectData, id: string, x: number, y: number, start: { look: Vector3 | null }) {
  const f = frameOf(ob);
  const down = f.z.clone().negate();
  if (ob.type === 'LIGHT' && ob.data) {
    const la = app.doc.lights[ob.data];
    if (id === 'look_at') {
      // aim at the surface under the pointer, else at the point on the view plane through the handle
      const { origin, dir } = v.ray(x, y);
      const hit = raycastScene(origin, dir, 1e5, (oid) => oid === ob.id);
      const target = hit ? hit.point : onViewPlane(v, x, y, start.look ?? f.pos.clone().addScaledVector(down, 1));
      if (target.distanceTo(f.pos) < 1e-6) return;
      // keep the light's up vector as close as possible to its current one
      const up = Math.abs(f.y.dot(target.clone().sub(f.pos).normalize())) > 0.999 ? f.x : f.y;
      const rot = new Matrix4().lookAt(f.pos, target, up);
      const q = new Quaternion().setFromRotationMatrix(rot);
      setWorld(ob, new Matrix4().compose(f.pos, q, f.scale));
    } else if (id === 'spot_size' || id === 'spot_blend') {
      const viewN = new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion);
      // plane containing the light axis that faces the viewer as much as possible
      let n = new Vector3().crossVectors(down, new Vector3().crossVectors(viewN, down));
      if (n.lengthSq() < 1e-8) n = f.x.clone();
      const p = onPlane(v, x, y, f.pos, n.normalize());
      if (!p) return;
      const rel = p.sub(f.pos);
      const along = Math.max(1e-6, rel.dot(down));
      const across = rel.addScaledVector(down, -rel.dot(down)).length();
      const ang = Math.atan2(across, along);
      if (id === 'spot_size') la.spot_size = Math.min(Math.PI, Math.max((1 * Math.PI) / 180, ang * 2));
      else {
        const c = Math.cos(la.spot_size / 2);
        const inner = Math.min(la.spot_size / 2, ang);
        la.spot_blend = Math.max(0, Math.min(1, (Math.cos(inner) - c) / Math.max(1e-6, 1 - c)));
      }
    } else if (id === 'radius') {
      const p = onViewPlane(v, x, y, f.pos);
      const scale = Math.max(f.scale.x, f.scale.y, f.scale.z) || 1;
      la.shadow_soft_size = Math.max(0, p.distanceTo(f.pos) / scale);
    } else if (id === 'area_x' || id === 'area_y') {
      const p = onPlane(v, x, y, f.pos, f.z);
      if (!p) return;
      const l = p.clone().applyMatrix4(f.world.clone().invert());
      const rect = la.shape === 'RECTANGLE' || la.shape === 'ELLIPSE';
      if (id === 'area_x') la.size = Math.max(0.001, Math.abs(l.x) * 2);
      else if (rect) la.size_y = Math.max(0.001, Math.abs(l.y) * 2);
    }
  } else if (ob.type === 'CAMERA' && ob.data) {
    const ca = app.doc.cameras[ob.data];
    if (id === 'lens') {
      const { d, aspect, w: w0, h: h0 } = cameraFrameHalf(ca);
      const p = onPlane(v, x, y, new Vector3(0, 0, -d).applyMatrix4(f.world), f.z);
      if (!p) return;
      const l = p.applyMatrix4(f.world.clone().invert());
      // keep the frame's aspect: the dragged corner sets the larger of the two half sizes
      const k = Math.max(Math.abs(l.x) / Math.max(1e-6, w0), Math.abs(l.y) / Math.max(1e-6, h0));
      if (!(k > 1e-4)) return;
      if (ca.type === 'ORTHO') ca.ortho_scale = Math.max(0.001, ca.ortho_scale * k);
      else ca.lens = Math.max(1, Math.min(5000, ca.lens / k));
      void aspect;
    } else if (id === 'focus') {
      // closest point on the camera axis to the pointer ray
      const { origin, dir } = v.ray(x, y);
      const a = f.z.clone().negate();
      const w = f.pos.clone().sub(origin);
      const b = a.dot(dir),
        dd = a.dot(w),
        e = dir.dot(w);
      const den = 1 - b * b;
      if (Math.abs(den) < 1e-6) return;
      const t = (b * e - dd) / den;
      ca.dof.focus_distance = Math.max(0, t);
    }
  } else if (ob.type === 'EMPTY' && id.startsWith('image:')) {
    const i = Number(id.slice(6));
    const p = onPlane(v, x, y, f.pos, f.z);
    if (!p) return;
    const l = p.applyMatrix4(f.world.clone().invert());
    const { w, h: hh, corners } = imageCorners(ob);
    const opp = corners[(i + 2) % 4];
    const nw = Math.abs(l.x - opp.x),
      nh = Math.abs(l.y - opp.y);
    // uniform: the image keeps its aspect, the larger stretch wins
    const k = Math.max(nw / Math.max(1e-6, w), nh / Math.max(1e-6, hh));
    if (!(k > 1e-4)) return;
    const s1 = ob.empty_display_size * k;
    const W = w * k,
      H = hh * k;
    // the opposite corner stays where it is
    const x0 = i === 1 || i === 2 ? opp.x : opp.x - W;
    const y0 = i === 2 || i === 3 ? opp.y : opp.y - H;
    ob.empty_display_size = s1;
    ob.empty_image_offset = [x0 / W, y0 / H];
  }
}

const LABELS: Record<string, string> = {
  look_at: 'Light Look At',
  spot_size: 'Spot Size',
  spot_blend: 'Spot Blend',
  radius: 'Light Radius',
  area_x: 'Area Light Size',
  area_y: 'Area Light Size',
  lens: 'Camera Lens',
  focus: 'Focus Distance',
};

function headerFor(ob: ObjectData, id: string): string {
  if (ob.type === 'LIGHT' && ob.data) {
    const la = app.doc.lights[ob.data];
    if (id === 'spot_size') return `Spot Size: ${((la.spot_size * 180) / Math.PI).toFixed(1)}°`;
    if (id === 'spot_blend') return `Spot Blend: ${la.spot_blend.toFixed(3)}`;
    if (id === 'radius') return `Radius: ${la.shadow_soft_size.toFixed(3)} m`;
    if (id.startsWith('area')) return `Size: ${la.size.toFixed(3)} m × ${la.size_y.toFixed(3)} m`;
    return 'Look At: point at a surface';
  }
  if (ob.type === 'CAMERA' && ob.data) {
    const ca = app.doc.cameras[ob.data];
    if (id === 'focus') return `Focus Distance: ${ca.dof.focus_distance.toFixed(3)} m`;
    return ca.type === 'ORTHO' ? `Orthographic Scale: ${ca.ortho_scale.toFixed(3)}` : `Focal Length: ${ca.lens.toFixed(1)} mm`;
  }
  return `Image Size: ${ob.empty_display_size.toFixed(3)}`;
}

editModeHooks.pointer.push((v, e) => {
  const el = (e.target as Element).closest?.('[data-ogz]');
  if (!el || e.button !== 0) return false;
  const ob = activeTarget(v);
  if (!ob) return false;
  const id = el.getAttribute('data-ogz')!;
  e.preventDefault();
  e.stopPropagation();
  const snap = snapshot(ob);
  const f = frameOf(ob);
  const start = { look: id === 'look_at' ? f.pos.clone().addScaledVector(f.z, -105 * pixel(v, f.pos)) : null };
  const apply = (ev: { clientX: number; clientY: number }) => {
    const p = local(v, ev);
    dragHandle(v, ob, id, p.x, p.y, start);
    app.changed('doc');
  };
  app.startModal({
    label: LABELS[id] ?? 'Image Empty Size',
    header: () => headerFor(ob, id),
    onPointerMove: (ev) => apply(ev),
    onPointerUp: (ev) => (ev.button === 0 ? 'FINISHED' : undefined),
    onPointerDown: (ev) => (ev.button === 2 ? 'CANCELLED' : ev.button === 0 ? 'FINISHED' : undefined),
    onKey: (ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.key === 'Escape') return 'CANCELLED';
      if (ev.key === 'Enter') return 'FINISHED';
      return true;
    },
    cancel: () => {
      restore(ob, snap);
      app.changed('doc');
    },
  });
  return true;
});
