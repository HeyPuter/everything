// Trim gestures: cut the volume of a drawn shape (extruded along the view or the surface normal)
// out of the sculpted mesh, add it with a union, or join it as separate geometry.
import { BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Vector3 } from 'three';
import { ADDITION, Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { app } from '../app/app';
import type { MeshData } from '../data/types';
import { buildMesh, type PolyFace } from '../mesh/mesh';
import type { View3D } from '../editors/view3d/view3d';
import { activeMeshData, dropSession, meshSession, type MeshSession } from './session';
import { invalidatePaintAttributes } from './display';
import { faceSetsOf, maxFaceSet } from './fsdata';
import { registerGestureTarget, type Gesture, type Pt } from './gesture';
import { cleanPolygon, closeTJunctions, triangulate2D } from './trimmath';

/** Screen polygon of a gesture (counter-clockwise not guaranteed). */
function gesturePolygon(g: Gesture, v: View3D): Pt[] {
  if (g.kind === 'BOX')
    return [
      { x: g.x0, y: g.y0 },
      { x: g.x1, y: g.y0 },
      { x: g.x1, y: g.y1 },
      { x: g.x0, y: g.y1 },
    ];
  if (g.kind === 'LINE') {
    // a large quad on the active side of the line
    const dx = g.b.x - g.a.x,
      dy = g.b.y - g.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len,
      uy = dy / len;
    const s = g.flip ? -1 : 1;
    const nx = -uy * s,
      ny = ux * s;
    const far = (v.width + v.height) * 2;
    const ext = g.limit ? 0 : far;
    const a = { x: g.a.x - ux * ext, y: g.a.y - uy * ext },
      b = { x: g.b.x + ux * ext, y: g.b.y + uy * ext };
    return [a, b, { x: b.x + nx * far, y: b.y + ny * far }, { x: a.x + nx * far, y: a.y + ny * far }];
  }
  return cleanPolygon(g.pts);
}

/** Depth (along the view direction) range of the mesh. */
function depthRange(s: MeshSession, camPos: Vector3, fwd: Vector3) {
  const w = s.world();
  const p = new Vector3();
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < s.nv; i++) {
    p.fromArray(s.positions, i * 3).applyMatrix4(w);
    const d = p.sub(camPos).dot(fwd);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

/** Closed prism (object space) for the trim shape; returns triangle positions. */
function trimPrism(v: View3D, s: MeshSession, g: Gesture, p: Record<string, unknown>): number[] | null {
  const poly = gesturePolygon(g, v);
  const tris = triangulate2D(poly);
  if (!tris.length) return null;
  const cam = v.camera;
  cam.updateMatrixWorld();
  const camPos = new Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
  const range = depthRange(s, camPos, fwd);
  const span = Math.max(1e-4, range.max - range.min);
  // center of the shape → surface depth under it
  let cx = 0,
    cy = 0;
  for (const q of poly) (cx += q.x), (cy += q.y);
  cx /= poly.length;
  cy /= poly.length;
  const hit = s.raycast(v, cx, cy);
  const surfaceDepth = hit ? hit.world.clone().sub(camPos).dot(fwd) : (range.min + range.max) / 2;
  let near: number, far: number;
  if (p.trim_mode === 'DIFFERENCE' || p.trim_location === 'DEPTH_VOLUME') {
    near = range.min - span * 0.1;
    far = range.max + span * 0.1;
    if (p.trim_mode !== 'DIFFERENCE') {
      near = range.min;
      far = range.max;
    }
  } else {
    near = surfaceDepth - span * 0.1;
    far = (range.min + range.max) / 2;
    if (far <= near) far = near + span * 0.5;
  }
  if (p.use_cursor_depth) {
    const cur = new Vector3(...app.doc.scene.cursor.location);
    const d = cur.sub(camPos).dot(fwd);
    const depth = far - near;
    near = d;
    far = d + depth;
  }
  const inv = s.world().clone().invert();
  const surfaceN = p.trim_orientation === 'SURFACE' && hit ? hit.normal.clone().transformDirection(s.world()).normalize() : null;
  const pointAt = (q: Pt, depth: number) => {
    if (surfaceN && hit) {
      // project the shape onto the plane through the hit point facing along the surface normal
      const r = v.ray(q.x, q.y);
      const t = hit.world.clone().sub(r.origin).dot(surfaceN) / (r.dir.dot(surfaceN) || 1e-9);
      const onPlane = r.origin.clone().addScaledVector(r.dir, t);
      return onPlane.addScaledVector(surfaceN, -(depth - surfaceDepth)).applyMatrix4(inv);
    }
    const r = v.ray(q.x, q.y);
    const along = r.dir.dot(fwd) || 1e-9;
    // orthographic rays start on the camera plane: measure the depth from there
    const base = r.origin.clone().sub(camPos).dot(fwd);
    return r.origin.clone().addScaledVector(r.dir, (depth - base) / along).applyMatrix4(inv);
  };
  const front = poly.map((q) => pointAt(q, near));
  const back = poly.map((q) => pointAt(q, far));
  const out: number[] = [];
  const push = (...vs: Vector3[]) => vs.forEach((x) => out.push(x.x, x.y, x.z));
  // winding: screen triangles are counter-clockwise in screen space (y down) → facing the camera
  for (let i = 0; i < tris.length; i += 3) {
    push(front[tris[i]], front[tris[i + 2]], front[tris[i + 1]]);
    push(back[tris[i]], back[tris[i + 1]], back[tris[i + 2]]);
  }
  let area = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += (poly[j].x - poly[i].x) * (poly[j].y + poly[i].y);
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (area >= 0) push(front[i], front[j], back[j], front[i], back[j], back[i]);
    else push(front[j], front[i], back[i], front[j], back[i], back[j]);
  }
  // make sure the prism faces outward: flip everything if its signed volume is negative
  let vol = 0;
  for (let i = 0; i < out.length; i += 9) {
    const a = new Vector3(out[i], out[i + 1], out[i + 2]),
      b = new Vector3(out[i + 3], out[i + 4], out[i + 5]),
      c = new Vector3(out[i + 6], out[i + 7], out[i + 8]);
    vol += a.dot(b.cross(c));
  }
  if (vol < 0)
    for (let i = 0; i < out.length; i += 9)
      for (let k = 0; k < 3; k++) {
        const t = out[i + 3 + k];
        out[i + 3 + k] = out[i + 6 + k];
        out[i + 6 + k] = t;
      }
  return out;
}

const csg = new Evaluator();
csg.attributes = ['position', 'normal'];
csg.useGroups = true;

function meshBrush(s: MeshSession, me: MeshData): Brush {
  const pos: number[] = [];
  const groups: { start: number; count: number; mat: number }[] = [];
  const nt = s.tris.length / 3;
  // group triangles by material; group index = material slot
  const byMat = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    const m = me.material_index?.[s.triFace[t]] ?? 0;
    let l = byMat.get(m);
    if (!l) byMat.set(m, (l = []));
    l.push(t);
  }
  for (const [m, list] of byMat) {
    const start = pos.length / 3;
    for (const t of list) for (let k = 0; k < 3; k++) pos.push(...Array.from(s.positions.subarray(s.tris[t * 3 + k] * 3, s.tris[t * 3 + k] * 3 + 3)));
    groups.push({ start, count: list.length * 3, mat: m });
  }
  return toBrush(pos, groups);
}

function toBrush(pos: number[], groups: { start: number; count: number; mat: number }[]): Brush {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.mat);
  const n = Math.max(1, ...groups.map((x) => x.mat + 1));
  const b = new Brush(
    g,
    Array.from({ length: n }, () => new MeshBasicMaterial()),
  );
  b.updateMatrixWorld(true);
  return b;
}

/** Weld triangles into polygon faces; `tag(t)` gives the material slot of each triangle. */
function weld(pos: ArrayLike<number>, triCount: number, tag: (t: number) => number) {
  const map = new Map<string, number>();
  const P: number[] = [];
  const q = (x: number) => Math.round(x * 1e5);
  const vid = (i: number) => {
    const k = `${q(pos[i * 3])},${q(pos[i * 3 + 1])},${q(pos[i * 3 + 2])}`;
    let id = map.get(k);
    if (id === undefined) {
      id = P.length / 3;
      P.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      map.set(k, id);
    }
    return id;
  };
  const faces: PolyFace[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = vid(t * 3),
      b = vid(t * 3 + 1),
      c = vid(t * 3 + 2);
    if (a === b || b === c || a === c) continue;
    faces.push({ verts: [a, b, c], material: tag(t) });
  }
  closeTJunctions(P, faces);
  return { positions: P, faces };
}


/** Run the trim on the active mesh. */
function applyTrim(v: View3D, g: Gesture, p: Record<string, unknown>): 'CANCELLED' | void {
  const am = activeMeshData();
  const s = meshSession();
  if (!am || !s) return 'CANCELLED';
  const { me } = am;
  const prism = trimPrism(v, s, g, p);
  if (!prism) return 'CANCELLED';
  const smooth = me.smooth?.[0] ?? 0;
  const oldSets = faceSetsOf(me);
  const newSet = maxFaceSet(oldSets) + 1;
  // trim faces use a marker slot above all material slots
  const marker = Math.max(1, me.materials.length, ...Array.from(me.material_index ?? [0])) + 1;
  let positions: number[], faces: PolyFace[];
  if (p.trim_mode === 'JOIN') {
    const existing: number[] = [];
    for (let t = 0; t < s.tris.length / 3; t++) for (let k = 0; k < 3; k++) existing.push(...Array.from(s.positions.subarray(s.tris[t * 3 + k] * 3, s.tris[t * 3 + k] * 3 + 3)));
    const nt0 = existing.length / 9;
    const all = existing.concat(prism);
    const w = weld(all, all.length / 9, (t) => (t < nt0 ? me.material_index?.[s.triFace[t]] ?? 0 : marker));
    positions = w.positions;
    faces = w.faces;
  } else {
    const a = meshBrush(s, me);
    const b = toBrush(prism, [{ start: 0, count: prism.length / 3, mat: marker }]);
    let res: Brush;
    try {
      res = csg.evaluate(a, b, p.trim_mode === 'UNION' ? ADDITION : SUBTRACTION) as Brush;
    } catch (e) {
      app.report('ERROR', `Trim failed: ${e instanceof Error ? e.message : String(e)}`);
      return 'CANCELLED';
    }
    const rg = res.geometry;
    const rp = rg.getAttribute('position');
    const triMat = new Int32Array(Math.ceil((rg.index ? rg.index.count : rp.count) / 3));
    // csg groups index the materials array (the second brush's material is appended after the first's)
    const mats = res.material as MeshBasicMaterial[];
    const matSlot = new Map<MeshBasicMaterial, number>();
    (a.material as MeshBasicMaterial[]).forEach((m, i) => matSlot.set(m, i));
    (b.material as MeshBasicMaterial[]).forEach((m) => matSlot.set(m, marker));
    for (const gr of rg.groups) for (let t = gr.start / 3; t < (gr.start + gr.count) / 3; t++) triMat[t] = matSlot.get(mats[gr.materialIndex ?? 0]) ?? 0;
    const flat: number[] = [];
    const count = rg.index ? rg.index.count : rp.count;
    for (let i = 0; i < count; i++) {
      const vi = rg.index ? rg.index.getX(i) : i;
      flat.push(rp.getX(vi), rp.getY(vi), rp.getZ(vi));
    }
    const w = weld(flat, count / 3, (t) => triMat[t]);
    positions = w.positions;
    faces = w.faces;
  }
  if (!faces.length) {
    app.report('WARNING', 'Trim removed the whole mesh');
    return 'CANCELLED';
  }
  // face sets: original faces keep the set of the nearest original… simplest: trim faces get a new set
  const fs = new Int32Array(faces.length);
  for (let f = 0; f < faces.length; f++) {
    const isTrim = faces[f].material === marker;
    fs[f] = isTrim ? newSet : 1;
    if (isTrim) faces[f].material = 0;
    faces[f].smooth = !!smooth;
  }
  const arrays = buildMesh(positions, faces);
  const nv = arrays.positions.length / 3;
  Object.assign(me, arrays);
  me.seams = undefined;
  me.sharp = undefined;
  me.creases = undefined;
  me.weights = me.weights.map(() => new Float32Array(nv));
  me.sculpt_mask = undefined;
  me.sculpt_face_set = fs;
  me.color_attributes = [];
  me.active_color_index = 0;
  me.shape_keys = [];
  me.active_shape_key_index = 0;
  me.select_vert = undefined;
  me.hide_vert = undefined;
  me.hide_poly = undefined;
  me.loose_edges = undefined;
  me.uv_select = undefined;
  dropSession();
  invalidatePaintAttributes();
  app.changed('geometry');
}

registerGestureTarget({
  ops: { BOX: 'sculpt.trim_box_gesture', LASSO: 'sculpt.trim_lasso_gesture', LINE: 'sculpt.trim_line_gesture', POLYLINE: 'sculpt.trim_polyline_gesture' },
  label: { BOX: 'Trim Box Gesture', LASSO: 'Trim Lasso Gesture', LINE: 'Trim Line Gesture', POLYLINE: 'Trim Polyline Gesture' },
  description: 'Cut the volume of the drawn shape out of the mesh, or add it to the mesh',
  props: [
    {
      id: 'trim_mode',
      label: 'Trim Mode',
      type: 'enum',
      default: 'DIFFERENCE',
      items: [
        ['DIFFERENCE', 'Difference', 'Cut the shape out of the mesh'],
        ['UNION', 'Union', 'Merge the shape into the mesh'],
        ['JOIN', 'Join', 'Add the shape as separate geometry'],
      ],
    },
    {
      id: 'trim_orientation',
      label: 'Shape Orientation',
      type: 'enum',
      default: 'VIEW',
      items: [
        ['VIEW', 'View', 'Extrude the shape along the view'],
        ['SURFACE', 'Surface', 'Extrude the shape along the surface normal under it'],
      ],
    },
    {
      id: 'trim_location',
      label: 'Shape Location',
      type: 'enum',
      default: 'DEPTH_SURFACE',
      items: [
        ['DEPTH_SURFACE', 'Surface', 'Start the shape at the surface under it'],
        ['DEPTH_VOLUME', 'Volume', 'Make the shape as deep as the mesh'],
      ],
    },
    { id: 'use_cursor_depth', label: 'Use Cursor for Depth', type: 'bool', default: false },
  ],
  apply: applyTrim,
});
