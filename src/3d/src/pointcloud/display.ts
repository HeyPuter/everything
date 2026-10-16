// Viewport display of points (point cloud objects and geometry nodes point output): each point is
// drawn as a sphere of its radius through an instanced mesh, so Solid / Material Preview shading,
// outlines and picking work like for meshes. Point Cloud Edit Mode adds the point centres coloured
// by selection.
import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, InstancedMesh, Points, ShaderMaterial, Group, type Material } from 'three';
import { app } from '../app/app';
import { sceneSyncHooks, type SyncedObject } from '../render/scene';
import { drawHooks } from '../editors/view3d/draw';
import type { EvalMesh } from '../eval/types';
import { pointCloudOf, selection } from './data';
import { isPointMesh, pointMatrices, sphereGeometry } from './spheres';
export { isPointMesh };

interface Entry {
  mesh: EvalMesh;
  im: InstancedMesh;
  edit: Points;
  editKey: string;
  so: SyncedObject;
}
const entries = new Map<string, Entry>();

const EDIT_VS = /* glsl */ `
uniform float uSize;
varying vec3 vColor;
void main() { vColor = color; gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z -= 0.001 * gl_Position.w; }`;
const EDIT_FS = /* glsl */ `
varying vec3 vColor;
void main() { vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; gl_FragColor = vec4(vColor, 1.0); }`;

const SEL = new Color(1, 0.48, 0).convertSRGBToLinear(),
  UNSEL = new Color(0.02, 0.02, 0.02);

function dispose(id: string, e: Entry) {
  e.im.removeFromParent();
  e.im.dispose();
  e.edit.removeFromParent();
  e.edit.geometry.dispose();
  entries.delete(id);
}

const inPointEdit = (id: string) => app.doc.mode === 'EDIT' && app.activeObject?.id === id && app.activeObject.type === 'POINTCLOUD';

let lastRevision = -1;
sceneSyncHooks.push((doc, ev, so) => {
  if (lastRevision !== app.revision) {
    lastRevision = app.revision;
    for (const [id, e] of entries) if (!isPointMesh(app.graph.get(id)?.mesh)) dispose(id, e);
  }
  const m = ev.mesh;
  if (!isPointMesh(m)) return;
  let e = entries.get(ev.id);
  const n = m.positions.length / 3;
  if (e && (e.mesh !== m || e.im.count !== n || e.im.geometry !== sphereGeometry(n))) {
    if (e.im.count !== n || e.im.geometry !== sphereGeometry(n)) {
      e.im.removeFromParent();
      e.im.dispose();
      e.im = newInstanced(ev.id, n);
    }
    e.mesh = m;
    pointMatrices(m.positions, m.pointRadius, e.im);
  }
  if (!e) {
    const im = newInstanced(ev.id, n);
    pointMatrices(m.positions, m.pointRadius, im);
    const edit = new Points(new BufferGeometry(), new ShaderMaterial({ vertexColors: true, vertexShader: EDIT_VS, fragmentShader: EDIT_FS, uniforms: { uSize: { value: 5 * (globalThis.devicePixelRatio || 1) } } }));
    edit.matrixAutoUpdate = false;
    edit.visible = false;
    e = { mesh: m, im, edit, editKey: '', so };
    entries.set(ev.id, e);
  }
  e.so = so;
  // the spheres join the object's instance group so shading, outlines and picking apply
  if (!so.instances) {
    const g = new Group();
    g.matrixAutoUpdate = false;
    so.instances = g;
    so.root.add(g);
  }
  if (e.im.parent !== so.instances) so.instances.add(e.im);
  if (e.edit.parent !== so.root) so.root.add(e.edit);
  syncEdit(e, ev.id);
});

function newInstanced(id: string, n: number) {
  const im = new InstancedMesh(sphereGeometry(n), undefined as unknown as Material, n);
  im.userData.id = id;
  im.userData.instanced = true;
  im.userData.pointSpheres = true;
  im.castShadow = true;
  im.receiveShadow = true;
  return im;
}

function syncEdit(e: Entry, id: string) {
  if (!inPointEdit(id)) {
    e.editKey = '';
    return;
  }
  const pc = pointCloudOf(app.doc, app.activeObject);
  if (!pc) return;
  const selAttr = pc.attributes.find((a) => a.name === '.selection');
  const key = `${idOf(pc.positions)}:${idOf(selAttr?.data ?? null)}`;
  if (key === e.editKey) return;
  e.editKey = key;
  const sel = selection(pc);
  const n = sel.length;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = sel[i] ? SEL : UNSEL;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pc.positions, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  e.edit.geometry.dispose();
  e.edit.geometry = g;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(a: object | null): number {
  if (!a) return 0;
  let i = ids.get(a);
  if (!i) ids.set(a, (i = nextId++));
  return i;
}

drawHooks.passes.push((pass) => {
  if (!entries.size) return;
  const restore: (() => void)[] = [];
  for (const [id, e] of entries) {
    const pts = e.so.points;
    // the loose-point dots of the evaluated mesh are replaced by the spheres
    if (pts) {
      const v = pts.visible;
      pts.visible = false;
      restore.push(() => (pts.visible = v));
    }
    const ev = e.edit.visible;
    e.edit.visible = pass === 'OVERLAY' && !!e.editKey && inPointEdit(id);
    restore.push(() => (e.edit.visible = ev));
  }
  return () => restore.forEach((f) => f());
});

/** Objects drawn as spheres (for tests). */
export function sphereObjects(): string[] {
  return [...entries.keys()];
}
