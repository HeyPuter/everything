// Edit-mesh overlay: vertices, edges (selection, seams, sharp, crease), selected faces,
// face dots and normals — drawn on top of the shaded mesh in each viewport.
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  ShaderMaterial,
  DoubleSide,
  Scene,
  type Camera,
  Color,
} from 'three';
import { app } from '../../app/app';
import { renderContext } from '../../render/context';
import { editMeshObjects, selectMode, active } from './context';
import { exclusionsOf } from './selset';
import { viewportExtensions } from '../../editors/view3d/hooks';
import type { View3D } from '../../editors/view3d/view3d';
import type { MeshData } from '../../data/types';
import { triangulatePoly, polyNormal } from '../../mesh/mesh';

const C = {
  vert: new Color(0, 0, 0),
  vertSel: new Color().setRGB(1.0, 0.478, 0.0).convertSRGBToLinear(),
  edge: new Color(0, 0, 0),
  edgeSel: new Color().setRGB(1.0, 0.6, 0.0).convertSRGBToLinear(),
  edgeModeSel: new Color().setRGB(1.0, 0.847, 0.0).convertSRGBToLinear(),
  seam: new Color().setRGB(0.859, 0.145, 0.071).convertSRGBToLinear(),
  sharp: new Color().setRGB(0.0, 1.0, 1.0).convertSRGBToLinear(),
  crease: new Color().setRGB(0.8, 0.0, 0.6).convertSRGBToLinear(),
  faceSel: new Color().setRGB(1.0, 0.639, 0.0).convertSRGBToLinear(),
  active: new Color(1, 1, 1),
  normal: new Color().setRGB(0.133, 0.867, 0.867).convertSRGBToLinear(),
};

const pointMat = (xray: boolean) =>
  new ShaderMaterial({
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z -= 0.00008 * gl_Position.w;
        gl_PointSize = size;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        if (dot(c, c) > 0.25) discard;
        gl_FragColor = vec4(vColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
    depthTest: !xray,
    depthWrite: false,
    transparent: true,
  });

interface Cached {
  key: string;
  group: Group;
}

const cache = new Map<string, Cached>();
const scene = new Scene();
scene.matrixWorldAutoUpdate = false;

function aidKey(me: MeshData) {
  return [me.positions, me.indices, me.select_vert, me.hide_vert, me.seams, me.sharp, me.creases].map((a) => (a ? idOf(a) : 0)).join(',');
}
const ids = new WeakMap<object, number>();
let next = 1;
function idOf(o: object) {
  let i = ids.get(o);
  if (!i) ids.set(o, (i = next++));
  return i;
}

function build(me: MeshData, xray: boolean, ov: { seams: boolean; sharp: boolean; crease: boolean; faceDots: boolean; normals: boolean; normalLen: number; vnormals: boolean }, obId: string): Group {
  const g = new Group();
  g.matrixAutoUpdate = false;
  const P = me.positions;
  const nv = P.length / 3;
  const sel = me.select_vert ?? new Uint8Array(nv);
  const hid = me.hide_vert;
  const mode = selectMode();
  const ex = exclusionsOf(me);
  // faces (selected tint)
  const fpos: number[] = [],
    fcol: number[] = [];
  const tmp: number[] = [];
  const nf = me.offsets.length - 1;
  const dots: number[] = [],
    dotCol: number[] = [],
    dotSize: number[] = [];
  const nrm: number[] = [];
  for (let f = 0; f < nf; f++) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    let all = true,
      hidden = false;
    for (let c = s; c < e; c++) {
      const v = me.indices[c];
      if (!sel[v]) all = false;
      if (hid?.[v]) hidden = true;
    }
    if (hidden) continue;
    if (ex?.faces.has(f)) all = false;
    const isActive = active.objectId === obId && active.kind === 'FACE' && active.index === f;
    const col = isActive ? [1, 1, 1, 0.25] : all ? [C.faceSel.r, C.faceSel.g, C.faceSel.b, mode === 'FACE' ? 0.28 : 0.22] : [1, 1, 1, xray ? 0.04 : 0.012];
    tmp.length = 0;
    triangulatePoly(P, me.indices.subarray(s, e), tmp, 0);
    for (const i of tmp) {
      const v = me.indices[s + i];
      fpos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      fcol.push(...col);
    }
    if (ov.faceDots || ov.normals || (mode === 'FACE' && xray)) {
      let cx = 0,
        cy = 0,
        cz = 0;
      for (let c = s; c < e; c++) {
        const v = me.indices[c];
        cx += P[v * 3];
        cy += P[v * 3 + 1];
        cz += P[v * 3 + 2];
      }
      const k = e - s;
      cx /= k;
      cy /= k;
      cz /= k;
      if (ov.faceDots || (mode === 'FACE' && xray)) {
        dots.push(cx, cy, cz);
        const c = all ? C.vertSel : C.vert;
        dotCol.push(c.r, c.g, c.b);
        dotSize.push(4 * (renderContext?.engine.dpr ?? 1));
      }
      if (ov.normals) {
        const n = polyNormal(P, me.indices.subarray(s, e));
        nrm.push(cx, cy, cz, cx + n[0] * ov.normalLen, cy + n[1] * ov.normalLen, cz + n[2] * ov.normalLen);
      }
    }
  }
  if (fpos.length) {
    const fg = new BufferGeometry();
    fg.setAttribute('position', new Float32BufferAttribute(fpos, 3));
    fg.setAttribute('color', new Float32BufferAttribute(fcol, 4));
    const fm = new Mesh(fg, new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide, depthTest: !xray, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    fm.matrixAutoUpdate = false;
    fm.renderOrder = 1;
    g.add(fm);
  }
  // edges
  const epos: number[] = [],
    ecol: number[] = [];
  const seen = new Set<number>();
  const flagAt = (arr: Uint32Array | Float32Array | undefined, c: number) => (arr ? arr[c] : 0);
  for (let f = 0; f < nf; f++) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    for (let c = s; c < e; c++) {
      const a = me.indices[c],
        b = me.indices[c + 1 < e ? c + 1 : s];
      if (hid?.[a] || hid?.[b]) continue;
      const key = a < b ? a * nv + b : b * nv + a;
      if (seen.has(key)) continue;
      seen.add(key);
      epos.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
      let ca: Color, cb: Color;
      const both = sel[a] && sel[b] && !ex?.edges.has(a < b ? `${a}:${b}` : `${b}:${a}`);
      const isActive = active.objectId === obId && active.kind === 'EDGE' && ((active.edge[0] === a && active.edge[1] === b) || (active.edge[0] === b && active.edge[1] === a));
      if (isActive) ca = cb = C.active;
      else if (mode === 'VERT') {
        ca = sel[a] ? C.edgeSel : C.edge;
        cb = sel[b] ? C.edgeSel : C.edge;
        if (both) ca = cb = C.edgeSel;
      } else ca = cb = both ? (mode === 'EDGE' ? C.edgeModeSel : C.edgeSel) : C.edge;
      if (!both && !isActive) {
        if (ov.seams && flagAt(me.seams, c)) ca = cb = C.seam;
        else if (ov.sharp && flagAt(me.sharp, c)) ca = cb = C.sharp;
        else if (ov.crease && flagAt(me.creases, c) > 0) ca = cb = C.crease;
      }
      ecol.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b);
    }
  }
  if (me.loose_edges)
    for (let i = 0; i < me.loose_edges.length; i += 2) {
      const a = me.loose_edges[i],
        b = me.loose_edges[i + 1];
      if (hid?.[a] || hid?.[b]) continue;
      epos.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
      const ca = sel[a] ? C.edgeSel : C.edge,
        cb = sel[b] ? C.edgeSel : C.edge;
      ecol.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b);
    }
  if (epos.length) {
    const eg = new BufferGeometry();
    eg.setAttribute('position', new Float32BufferAttribute(epos, 3));
    eg.setAttribute('color', new Float32BufferAttribute(ecol, 3));
    const el = new LineSegments(eg, new LineBasicMaterial({ vertexColors: true, depthTest: !xray, transparent: true }));
    el.matrixAutoUpdate = false;
    el.renderOrder = 2;
    g.add(el);
  }
  // vertices
  if (mode === 'VERT') {
    const vpos: number[] = [],
      vcol: number[] = [],
      vsize: number[] = [];
    const dpr = renderContext?.engine.dpr ?? 1;
    for (let v = 0; v < nv; v++) {
      if (hid?.[v]) continue;
      vpos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      const isActive = active.objectId === obId && active.kind === 'VERT' && active.index === v;
      const c = isActive ? C.active : sel[v] ? C.vertSel : C.vert;
      vcol.push(c.r, c.g, c.b);
      vsize.push((sel[v] ? 5.5 : 5) * dpr);
    }
    const vg = new BufferGeometry();
    vg.setAttribute('position', new Float32BufferAttribute(vpos, 3));
    vg.setAttribute('color', new Float32BufferAttribute(vcol, 3));
    vg.setAttribute('size', new Float32BufferAttribute(vsize, 1));
    const pts = new Points(vg, pointMat(xray));
    pts.matrixAutoUpdate = false;
    pts.renderOrder = 3;
    g.add(pts);
  }
  if (dots.length) {
    const dg = new BufferGeometry();
    dg.setAttribute('position', new Float32BufferAttribute(dots, 3));
    dg.setAttribute('color', new Float32BufferAttribute(dotCol, 3));
    dg.setAttribute('size', new Float32BufferAttribute(dotSize, 1));
    const dp = new Points(dg, pointMat(xray));
    dp.matrixAutoUpdate = false;
    dp.renderOrder = 3;
    g.add(dp);
  }
  if (nrm.length) {
    const ng = new BufferGeometry();
    ng.setAttribute('position', new Float32BufferAttribute(nrm, 3));
    const nl = new LineSegments(ng, new LineBasicMaterial({ color: C.normal }));
    nl.matrixAutoUpdate = false;
    g.add(nl);
  }
  return g;
}

function dispose(g: Group) {
  g.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as { dispose?: () => void } | undefined;
    mat?.dispose?.();
  });
}

export function drawEditOverlay(v: View3D, camera: Camera) {
  if (app.doc.mode !== 'EDIT') return;
  const r = renderContext?.engine.renderer;
  if (!r) return;
  const xray = v.shading.type === 'WIREFRAME' ? v.shading.show_xray_wireframe : v.shading.show_xray;
  const o = v.overlay;
  const ov = { seams: o.show_edge_seams, sharp: o.show_edge_sharp, crease: o.show_edge_crease, faceDots: o.show_face_center, normals: o.show_face_normals, normalLen: o.normals_length, vnormals: o.show_vertex_normals };
  scene.clear();
  const live = new Set<string>();
  for (const { ob, me } of editMeshObjects()) {
    const key = `${aidKey(me)}|${xray}|${selectMode()}|${JSON.stringify(ov)}|${active.objectId}:${active.kind}:${active.index}:${active.edge.join('-')}`;
    const ck = `${ob.id}|${v.area.id}`;
    live.add(ck);
    let c = cache.get(ck);
    if (!c || c.key !== key) {
      if (c) dispose(c.group);
      c = { key, group: build(me, xray, ov, ob.id) };
      cache.set(ck, c);
    }
    const ev = app.graph.get(ob.id);
    if (ev) c.group.matrix.copy(ev.world);
    if (v.localView && !v.localView.has(ob.id)) continue;
    scene.add(c.group);
  }
  for (const [k, c] of cache)
    if (!live.has(k) && k.endsWith(`|${v.area.id}`)) {
      dispose(c.group);
      cache.delete(k);
    }
  if (!scene.children.length) return;
  scene.updateMatrixWorld(true);
  r.render(scene, camera);
  scene.clear();
}

viewportExtensions.push((v) => {
  const fn = (_s: Scene, camera: Camera) => drawEditOverlay(v, camera);
  v.extraOverlays.push(fn);
  return () => {
    v.extraOverlays = v.extraOverlays.filter((f) => f !== fn);
  };
});
