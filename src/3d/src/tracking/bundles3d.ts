// Reconstructed tracks ("bundles") and the solved camera path drawn in the 3D viewport, placed by
// the camera that follows the solve (Camera Solver) or by the object that follows an object solve
// (Object Solver). They belong to the overlays (hidden with them and from selection picking).
import { BufferGeometry, Float32BufferAttribute, Group, Line, LineBasicMaterial, Matrix4, Points, PointsMaterial, CanvasTexture, type Scene } from 'three';
import { app } from '../app/app';
import { sceneSyncHooks } from '../render/scene';
import { drawHooks } from '../editors/view3d/draw';
import type { DocumentData, ObjectData } from '../data/types';
import { solverClip } from './solvers';
import { objectNamed } from './reconstruction';
import { tobj, type MovieClipData, type TrackingObjectData } from './types';

interface Entry {
  group: Group;
  points: Points;
  path: Line;
  key: string;
  seen: number;
}

const entries = new Map<string, Entry>();
let frameNo = 0;

let dotTexture: CanvasTexture | null = null;
function dot(): CanvasTexture | null {
  if (dotTexture || typeof document === 'undefined') return dotTexture;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(16, 16, 12, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = '#000000';
  g.stroke();
  dotTexture = new CanvasTexture(cv);
  return dotTexture;
}

/** Tracking data drawn for an object: the clip, which tracking object and how it is placed. */
function source(doc: DocumentData, ob: ObjectData): { clip: MovieClipData; data: TrackingObjectData; camera: boolean } | null {
  for (const c of ob.constraints) {
    if (c.mute || (c.type !== 'CAMERA_SOLVER' && c.type !== 'OBJECT_SOLVER')) continue;
    const clip = solverClip(doc, c);
    if (!clip) continue;
    if (c.type === 'CAMERA_SOLVER') return { clip, data: clip.tracking, camera: true };
    const o = objectNamed(clip, c.object as string);
    if (!o.is_camera) return { clip, data: o.data, camera: false };
  }
  return null;
}

function build(clip: MovieClipData, data: TrackingObjectData, camera: boolean): { points: BufferGeometry; path: BufferGeometry; key: string } {
  const tracks = data.tracks.filter((t) => t.has_bundle && t.bundle && !t.hide);
  const active = tobj(clip) === data ? data.active_track : null;
  const pos = new Float32Array(tracks.length * 3);
  const col = new Float32Array(tracks.length * 3);
  tracks.forEach((t, i) => {
    pos.set(t.bundle!, i * 3);
    const c = t.use_custom_color && !t.select ? t.color : t.name === active && t.select ? [1, 1, 1] : t.select ? [1, 0.63, 0.16] : [0.05, 0.05, 0.05];
    col.set(c, i * 3);
  });
  const points = new BufferGeometry();
  points.setAttribute('position', new Float32BufferAttribute(pos, 3));
  points.setAttribute('color', new Float32BufferAttribute(col, 3));
  // camera path (camera solves only: an object's path lives in its own space)
  const path = new BufferGeometry();
  if (camera && data.reconstruction?.is_valid) {
    const cams = data.reconstruction.cameras;
    const p = new Float32Array(cams.length * 3);
    cams.forEach((cm, i) => p.set([cm.matrix[12], cm.matrix[13], cm.matrix[14]], i * 3));
    path.setAttribute('position', new Float32BufferAttribute(p, 3));
  }
  const key = JSON.stringify([tracks.map((t) => [t.bundle, t.select, t.name === active, t.use_custom_color && t.color]), data.reconstruction?.cameras.length, data.reconstruction?.average_error]);
  return { points, path, key };
}

sceneSyncHooks.push((doc, ev, so) => {
  const src = ev.ob.constraints.length ? source(doc, ev.ob) : null;
  let e = entries.get(ev.id);
  if (!src) {
    if (e) dispose(ev.id, e);
    return;
  }
  const scene = so.root.parent as Scene | null;
  if (!scene) return;
  if (!e) {
    const group = new Group();
    group.matrixAutoUpdate = false;
    const points = new Points(new BufferGeometry(), new PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, map: dot(), alphaTest: 0.5, transparent: false, depthTest: true }));
    const path = new Line(new BufferGeometry(), new LineBasicMaterial({ color: 0x7f7f7f }));
    points.frustumCulled = path.frustumCulled = false;
    group.add(points, path);
    scene.add(group);
    e = { group, points, path, key: '', seen: frameNo };
    entries.set(ev.id, e);
  }
  e.seen = frameNo;
  const b = build(src.clip, src.data, src.camera);
  if (b.key !== e.key) {
    e.points.geometry.dispose();
    e.path.geometry.dispose();
    e.points.geometry = b.points;
    e.path.geometry = b.path;
    e.key = b.key;
  } else {
    b.points.dispose();
    b.path.dispose();
  }
  // camera: the reconstruction space is the camera's own transform; object: the object's world
  const M: Matrix4 = src.camera ? ev.worldBasis : ev.world;
  e.group.matrix.copy(M);
  e.group.matrixWorld.copy(M);
  e.group.visible = ev.visible;
});

function dispose(id: string, e: Entry) {
  e.group.parent?.remove(e.group);
  e.points.geometry.dispose();
  e.path.geometry.dispose();
  entries.delete(id);
}

drawHooks.passes.push((pass, view) => {
  if (!entries.size) return;
  frameNo++;
  for (const [id, e] of entries) if (!app.doc.objects[id]) dispose(id, e);
  const show = pass !== 'ID' && view.overlay.show_overlays && view.overlay.show_extras !== false;
  const prev = [...entries.values()].map((e) => e.group.visible);
  for (const e of entries.values()) e.group.visible = e.group.visible && show;
  return () => [...entries.values()].forEach((e, i) => (e.group.visible = prev[i]));
});
