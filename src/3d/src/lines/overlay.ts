// Mesh Edit Mode overlay of edge / face marks for line rendering (shown while lines are enabled
// for renders; toggled in the Mesh Edit Mode overlays popover).
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Scene, type Camera } from 'three';
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { checkbox, panel } from '../ui/widgets';
import { renderContext } from '../render/context';
import { triangulatePoly } from '../mesh/mesh';
import { viewportExtensions } from '../editors/view3d/hooks';
import { editOverlayHooks } from '../editors/view3d/header';
import { editMeshObjects } from '../modes/editmesh/context';
import type { View3D } from '../editors/view3d/view3d';
import type { MeshData } from '../data/types';

type OverlayExt = { show_freestyle_edge_marks?: boolean; show_freestyle_face_marks?: boolean };

const edgeColor = new Color().setRGB(0.5, 1, 0.5).convertSRGBToLinear();
const faceColor = new Color().setRGB(0.5, 1, 0.5).convertSRGBToLinear();
const edgeMat = new LineBasicMaterial({ color: edgeColor, transparent: true, depthWrite: false });
const faceMat = new MeshBasicMaterial({ color: faceColor, transparent: true, opacity: 0.18, depthWrite: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });

const cache = new WeakMap<MeshData, { key: string; group: Group }>();
const ids = new WeakMap<object, number>();
let next = 1;
const idOf = (o: object | undefined) => {
  if (!o) return 0;
  let i = ids.get(o);
  if (!i) ids.set(o, (i = next++));
  return i;
};

function build(me: MeshData, edges: boolean, faces: boolean): Group {
  const g = new Group();
  g.matrixAutoUpdate = false;
  const P = me.positions;
  const hid = me.hide_vert;
  if (edges && me.freestyle_edge) {
    const pos: number[] = [];
    for (let f = 0; f < me.offsets.length - 1; f++) {
      const s = me.offsets[f],
        e = me.offsets[f + 1];
      for (let c = s; c < e; c++) {
        if (!me.freestyle_edge[c]) continue;
        const a = me.indices[c],
          b = me.indices[c + 1 < e ? c + 1 : s];
        if (hid?.[a] || hid?.[b]) continue;
        pos.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
      }
    }
    if (pos.length) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      const l = new LineSegments(geo, edgeMat);
      l.matrixAutoUpdate = false;
      l.renderOrder = 4;
      g.add(l);
    }
  }
  if (faces && me.freestyle_face) {
    const pos: number[] = [];
    const tmp: number[] = [];
    for (let f = 0; f < me.offsets.length - 1; f++) {
      if (!me.freestyle_face[f]) continue;
      const s = me.offsets[f],
        e = me.offsets[f + 1];
      tmp.length = 0;
      triangulatePoly(P, me.indices.subarray(s, e), tmp, 0);
      for (const i of tmp) {
        const v = me.indices[s + i];
        pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      }
    }
    if (pos.length) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      const m = new Mesh(geo, faceMat);
      m.matrixAutoUpdate = false;
      m.renderOrder = 4;
      g.add(m);
    }
  }
  return g;
}

const scene = new Scene();
scene.matrixWorldAutoUpdate = false;

function draw(v: View3D, camera: Camera) {
  if (app.doc.mode !== 'EDIT' || !app.doc.scene.render.use_freestyle || !v.overlay.show_overlays) return;
  const o = v.overlay as typeof v.overlay & OverlayExt;
  const edges = o.show_freestyle_edge_marks !== false,
    faces = o.show_freestyle_face_marks !== false;
  if (!edges && !faces) return;
  const r = renderContext?.engine.renderer;
  if (!r) return;
  scene.clear();
  for (const { ob, me } of editMeshObjects()) {
    if (!me.freestyle_edge && !me.freestyle_face) continue;
    const key = `${idOf(me.positions)}|${idOf(me.indices)}|${idOf(me.freestyle_edge)}|${idOf(me.freestyle_face)}|${idOf(me.hide_vert)}|${edges}|${faces}`;
    let c = cache.get(me);
    if (!c || c.key !== key) {
      c?.group.traverse((x) => (x as Mesh).geometry?.dispose());
      c = { key, group: build(me, edges, faces) };
      cache.set(me, c);
    }
    const ev = app.graph.get(ob.id);
    if (ev) c.group.matrix.copy(ev.world);
    if (v.localView && !v.localView.has(ob.id)) continue;
    scene.add(c.group);
  }
  if (!scene.children.length) return;
  scene.updateMatrixWorld(true);
  r.render(scene, camera);
}

viewportExtensions.push((v) => {
  const fn = (_s: Scene, camera: Camera) => draw(v, camera);
  v.extraOverlays.push(fn);
  return () => {
    const i = v.extraOverlays.indexOf(fn);
    if (i >= 0) v.extraOverlays.splice(i, 1);
  };
});

// Mesh Edit Mode overlays ▸ Freestyle
editOverlayHooks.push((v: View3D): Child => {
  if (!app.doc.scene.render.use_freestyle || app.activeObject?.type !== 'MESH') return null;
  const o = v.overlay as typeof v.overlay & OverlayExt;
  const set = (k: keyof OverlayExt) => (x: boolean) => {
    o[k] = x;
    app.changed('ui');
  };
  return panel('ov-mesh-freestyle', 'Freestyle', () => [h('div', { class: 'pop-grid' }, checkbox('o-fs-edge', 'Edge Marks', o.show_freestyle_edge_marks !== false, set('show_freestyle_edge_marks')), checkbox('o-fs-face', 'Face Marks', o.show_freestyle_face_marks !== false, set('show_freestyle_face_marks')))], { sub: true });
});
