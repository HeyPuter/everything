// Asset previews: small images rendered with the shared renderer (materials on a ball, objects
// and collections framed from a three-quarter view, worlds as a backdrop with a mirror and a
// matte ball) or drawn in 2D (node groups, actions, brushes). Previews are stored in the asset's
// metadata as an image data URL, so they travel with the file and with copies in libraries.
import {
  AmbientLight,
  Box3,
  DataTexture,
  DirectionalLight,
  EquirectangularReflectionMapping,
  FloatType,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderTarget,
  Euler,
  Quaternion,
  type Material,
  type Texture,
} from 'three';
import type { ActionData, BrushData, DocumentData, ID, NodeGroupData, ObjectData, WorldData } from '../data/types';
import type { EvalMesh } from '../eval/types';
import { app } from '../app/app';
import { renderContext } from '../render/context';
import { meshGeometry } from '../render/geometry';
import { viewportMaterial } from '../render/pbr';
import { evaluateWorldForViewport } from '../render/world';
import { evaluateFCurve, fcurveRange } from '../anim/fcurve';
import { collectionObjects } from './importer';
import { blockOf, type AssetTable } from './types';

export const PREVIEW_SIZE = 256;

let target: WebGLRenderTarget | null = null;
let buffer: Uint8Array | null = null;
let canvas: HTMLCanvasElement | null = null;

function encode(c: HTMLCanvasElement): string {
  const webp = c.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png');
}

function canvas2d(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = PREVIEW_SIZE;
  return [c, c.getContext('2d')!];
}

/** Render a scene into an image (transparent background unless the scene has one). */
function renderScene(scene: Scene, camera: PerspectiveCamera): string | undefined {
  const rc = renderContext;
  if (!rc || rc.engine.lost) return undefined;
  const S = PREVIEW_SIZE;
  if (!target) {
    target = new WebGLRenderTarget(S, S, { samples: 4 });
    target.texture.colorSpace = SRGBColorSpace;
    buffer = new Uint8Array(S * S * 4);
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
  }
  const r = rc.engine.renderer;
  const prev = r.getRenderTarget();
  const scissor = r.getScissorTest();
  r.setScissorTest(false);
  r.setRenderTarget(target);
  r.setClearColor(0x000000, 0);
  r.clear(true, true, true);
  r.render(scene, camera);
  r.readRenderTargetPixels(target, 0, 0, S, S, buffer!);
  r.setRenderTarget(prev);
  r.setScissorTest(scissor);
  rc.engine.requestDraw();
  const img = new ImageData(S, S);
  for (let y = 0; y < S; y++) img.data.set(buffer!.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4);
  canvas!.getContext('2d')!.putImageData(img, 0, 0);
  return encode(canvas!);
}

function lights(scene: Scene) {
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(-2, -3, 4);
  scene.add(key);
  const fill = new DirectionalLight(0xffffff, 0.6);
  fill.position.set(3, -1, 1);
  scene.add(fill);
  scene.add(new AmbientLight(0xffffff, 0.15));
  if (renderContext) scene.environment = renderContext.studio();
}

/** A camera looking at a box from the front-left, above. */
function frameCamera(box: Box3): PerspectiveCamera {
  const cam = new PerspectiveCamera(30, 1, 0.01, 1000);
  cam.up.set(0, 0, 1);
  const center = box.getCenter(new Vector3());
  const radius = Math.max(1e-3, box.getSize(new Vector3()).length() / 2);
  const dir = new Vector3(-0.55, -1, 0.62).normalize();
  const dist = (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.02;
  cam.position.copy(center).addScaledVector(dir, dist);
  cam.near = Math.max(0.001, dist - radius * 2);
  cam.far = dist + radius * 2;
  cam.lookAt(center);
  cam.updateProjectionMatrix();
  return cam;
}

function materialPreview(doc: DocumentData, id: ID): string | undefined {
  if (!renderContext) return undefined;
  const scene = new Scene();
  lights(scene);
  const ball = new Mesh(new SphereGeometry(0.9, 64, 40), viewportMaterial(doc, id));
  ball.rotation.x = Math.PI / 2;
  scene.add(ball);
  const cam = new PerspectiveCamera(30, 1, 0.1, 10);
  cam.up.set(0, 0, 1);
  cam.position.set(0, -3.55, 0.55);
  cam.lookAt(0, 0, 0);
  const url = renderScene(scene, cam);
  ball.geometry.dispose();
  return url;
}

function localMatrix(ob: ObjectData): Matrix4 {
  const q = new Quaternion();
  if (ob.rotation_mode === 'QUATERNION') q.set(ob.rotation_quaternion[1], ob.rotation_quaternion[2], ob.rotation_quaternion[3], ob.rotation_quaternion[0]);
  else if (ob.rotation_mode === 'AXIS_ANGLE') q.setFromAxisAngle(new Vector3(ob.rotation_axis_angle[1], ob.rotation_axis_angle[2], ob.rotation_axis_angle[3]).normalize(), ob.rotation_axis_angle[0]);
  else q.setFromEuler(new Euler(ob.rotation_euler[0], ob.rotation_euler[1], ob.rotation_euler[2], ob.rotation_mode as 'XYZ'));
  const loc = new Vector3(...ob.location).add(new Vector3(...(ob.delta_location ?? [0, 0, 0])));
  return new Matrix4().compose(loc, q, new Vector3(...ob.scale));
}

/** World matrix of an object of a document that is not evaluated (libraries). */
function staticWorld(doc: DocumentData, ob: ObjectData, depth = 0): Matrix4 {
  const m = localMatrix(ob);
  const parent = ob.parent ? doc.objects[ob.parent] : undefined;
  if (!parent || depth > 32) return m;
  return staticWorld(doc, parent, depth + 1).multiply(new Matrix4().fromArray(ob.matrix_parent_inverse)).multiply(m);
}

function slots(doc: DocumentData, ob: ObjectData): (string | null)[] {
  const data = ob.data ? ((doc.meshes[ob.data] ?? doc.curves?.[ob.data]) as { materials?: (string | null)[] } | undefined) : undefined;
  const base = data?.materials ?? [];
  if (!ob.object_materials) return base;
  return base.map((m, i) => (ob.material_slots_link?.[i] === 'OBJECT' ? ob.object_materials![i] ?? null : m));
}

/** Meshes of objects (evaluated when the document is the open file). */
function objectsPreview(doc: DocumentData, ids: ID[], offset?: Matrix4): string | undefined {
  if (!renderContext) return undefined;
  const scene = new Scene();
  lights(scene);
  const box = new Box3();
  let any = false;
  const live = doc === app?.doc;
  if (live) app.flush();
  for (const id of ids) {
    const ob = doc.objects[id];
    if (!ob || ob.hide_render) continue;
    let mesh: EvalMesh | undefined;
    let world: Matrix4;
    if (live) {
      const ev = app.graph.get(id);
      mesh = ev?.mesh;
      world = ev?.world.clone() ?? new Matrix4();
    } else {
      mesh = ob.type === 'MESH' && ob.data ? (doc.meshes[ob.data] as unknown as EvalMesh) : undefined;
      world = staticWorld(doc, ob);
    }
    if (!mesh || !mesh.indices?.length) continue;
    if (offset) world.premultiply(offset);
    const info = meshGeometry(mesh);
    const groups = info.geometry.groups;
    const count = Math.max(1, ...groups.map((g) => (g.materialIndex ?? 0) + 1));
    const sl = slots(doc, ob);
    const mats: Material[] = [];
    for (let s = 0; s < count; s++) mats.push(viewportMaterial(doc, sl[s] ?? null));
    const m = new Mesh(info.geometry, mats.length === 1 ? mats[0] : mats);
    m.matrixAutoUpdate = false;
    m.matrix.copy(world);
    m.matrixWorld.copy(world);
    scene.add(m);
    info.geometry.computeBoundingBox();
    box.union(info.geometry.boundingBox!.clone().applyMatrix4(world));
    any = true;
  }
  if (!any) return undefined;
  return renderScene(scene, frameCamera(box));
}

function skyTexture(top: number[], horizon: number[], ground: number[]): DataTexture {
  const w = 64,
    h = 32,
    data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const t = 1 - (y + 0.5) / h;
    const elev = (t - 0.5) * Math.PI;
    for (let x = 0; x < w; x++) {
      const k = elev >= 0 ? Math.pow(Math.sin(elev), 0.5) : Math.min(1, -elev * 4);
      const to = elev >= 0 ? top : ground;
      const c = horizon.map((v, j) => v + (to[j] - v) * k);
      data.set([c[0], c[1], c[2], 1], (y * w + x) * 4);
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat, FloatType);
  tex.colorSpace = LinearSRGBColorSpace;
  tex.mapping = EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

function worldPreview(doc: DocumentData, w: WorldData): string | undefined {
  const rc = renderContext;
  if (!rc) return undefined;
  const ev = evaluateWorldForViewport(doc, w);
  let equirect: Texture;
  let own = true;
  if (ev.kind === 'texture') {
    equirect = ev.texture;
    equirect.mapping = EquirectangularReflectionMapping;
    own = false;
  } else if (ev.kind === 'sky') equirect = skyTexture(ev.top, ev.horizon, ev.ground);
  else equirect = skyTexture(ev.color, ev.color, ev.color);
  const env = rc.engine.pmrem.fromEquirectangular(equirect).texture;
  const scene = new Scene();
  scene.background = equirect;
  scene.environment = env;
  const geo = new SphereGeometry(0.55, 48, 32);
  const chrome = new Mesh(geo, new MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.04 }));
  chrome.position.set(-0.6, 0, 0);
  const matte = new Mesh(geo, new MeshStandardMaterial({ color: 0xcccccc, metalness: 0, roughness: 0.9 }));
  matte.position.set(0.6, 0, 0);
  scene.add(chrome, matte);
  const cam = new PerspectiveCamera(40, 1, 0.1, 100);
  cam.up.set(0, 0, 1);
  cam.position.set(0, -3.4, 0.7);
  cam.lookAt(0, 0, 0.1);
  const url = renderScene(scene, cam);
  geo.dispose();
  (chrome.material as Material).dispose();
  (matte.material as Material).dispose();
  env.dispose();
  if (own) equirect.dispose();
  return url;
}

// ---------------------------------------------------------------------------
// 2D previews

const TREE_COLORS: Record<string, [string, string]> = {
  GEOMETRY: ['#1f6f63', '#5ad1b8'],
  SHADER: ['#5b3a7a', '#c89bf0'],
  COMPOSITOR: ['#7a5a1f', '#f0c35a'],
};

function nodeGroupPreview(g: NodeGroupData): string {
  const [c, x] = canvas2d();
  const S = PREVIEW_SIZE;
  const [dark, light] = TREE_COLORS[g.tree.type] ?? TREE_COLORS.SHADER;
  const ins = (g.tree.interface ?? []).filter((i) => i.in_out === 'INPUT');
  const outs = (g.tree.interface ?? []).filter((i) => i.in_out === 'OUTPUT');
  // a node card with its sockets
  const w = S * 0.62,
    left = (S - w) / 2;
  const rows = Math.max(ins.length + outs.length, 2);
  const rowH = Math.min(26, (S * 0.62) / rows);
  const hdr = 34;
  const h = hdr + rows * rowH + 14;
  const top = (S - h) / 2;
  x.fillStyle = 'rgba(0,0,0,.35)';
  x.beginPath();
  x.roundRect(left + 4, top + 6, w, h, 12);
  x.fill();
  x.fillStyle = '#3a3a3a';
  x.beginPath();
  x.roundRect(left, top, w, h, 12);
  x.fill();
  x.fillStyle = dark;
  x.beginPath();
  x.roundRect(left, top, w, hdr, [12, 12, 0, 0]);
  x.fill();
  // the group's initials in the header
  x.fillStyle = '#fff';
  x.font = `600 ${Math.round(hdr * 0.5)}px system-ui, sans-serif`;
  x.textBaseline = 'middle';
  const initials = g.name.split(/\s+/).map((s) => s[0]).join('').slice(0, 3).toUpperCase();
  x.fillText(initials, left + 14, top + hdr / 2 + 1);
  const sock = (sx: number, sy: number, col: string) => {
    x.fillStyle = col;
    x.beginPath();
    x.arc(sx, sy, 6, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = '#111';
    x.lineWidth = 1.5;
    x.stroke();
  };
  const sockColor = (t: string) => (/Geometry/.test(t) ? '#00d6a3' : /Color/.test(t) ? '#c7c729' : /Vector/.test(t) ? '#6363c7' : /Shader/.test(t) ? '#63c763' : /Int|Bool/.test(t) ? '#598c5c' : '#a1a1a1');
  let y = top + hdr + rowH / 2 + 6;
  for (const o of outs) {
    sock(left + w, y, sockColor(o.socket_type));
    x.fillStyle = '#ccc';
    x.fillRect(left + w * 0.45, y - 2, w * 0.4, 4);
    y += rowH;
  }
  for (const i of ins) {
    sock(left, y, sockColor(i.socket_type));
    x.fillStyle = '#aaa';
    x.fillRect(left + 16, y - 2, w * 0.45, 4);
    y += rowH;
  }
  // accent line under the header
  x.fillStyle = light;
  x.fillRect(left, top + hdr - 2, w, 2);
  return encode(c);
}

function actionPreview(a: ActionData): string {
  const [c, x] = canvas2d();
  const S = PREVIEW_SIZE;
  x.fillStyle = '#2b2b2b';
  x.beginPath();
  x.roundRect(8, 8, S - 16, S - 16, 14);
  x.fill();
  const curves = a.fcurves.filter((f) => f.keyframe_points.length);
  if (!curves.length) return encode(c);
  let f0 = Infinity,
    f1 = -Infinity;
  for (const f of curves) {
    const [a0, a1] = fcurveRange(f);
    f0 = Math.min(f0, a0);
    f1 = Math.max(f1, a1);
  }
  if (f1 <= f0) f1 = f0 + 1;
  const colors = ['#e8584f', '#7fd34e', '#4f8fe8', '#e8c34f', '#c35ae8', '#4fd8e8'];
  const pad = 32;
  curves.slice(0, 12).forEach((f, i) => {
    const n = 64;
    const vals: number[] = [];
    for (let k = 0; k <= n; k++) vals.push(evaluateFCurve(f, f0 + ((f1 - f0) * k) / n));
    const lo = Math.min(...vals),
      hi = Math.max(...vals);
    const span = hi - lo || 1;
    x.strokeStyle = colors[(f.array_index + i) % colors.length];
    x.lineWidth = 4;
    x.lineCap = 'round';
    x.beginPath();
    vals.forEach((v, k) => {
      const px = pad + ((S - 2 * pad) * k) / n;
      const py = S - pad - ((S - 2 * pad) * (v - lo)) / span;
      if (k) x.lineTo(px, py);
      else x.moveTo(px, py);
    });
    x.stroke();
  });
  return encode(c);
}

function brushPreview(b: BrushData): string {
  const [c, x] = canvas2d();
  const S = PREVIEW_SIZE;
  const col = b.color ? `rgb(${b.color.map((v) => Math.round(Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2) * 255)).join(',')})` : '#d8d8d8';
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.42);
  const hard = Math.max(0, Math.min(0.95, b.hardness ?? 0.3));
  g.addColorStop(0, col);
  g.addColorStop(hard, col);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.beginPath();
  x.arc(S / 2, S / 2, S * 0.42, 0, Math.PI * 2);
  x.fill();
  // a stroke across the dab
  x.strokeStyle = 'rgba(255,255,255,.55)';
  x.lineWidth = 6;
  x.lineCap = 'round';
  x.beginPath();
  x.moveTo(S * 0.18, S * 0.7);
  x.bezierCurveTo(S * 0.4, S * 0.35, S * 0.6, S * 0.85, S * 0.82, S * 0.3);
  x.stroke();
  return encode(c);
}

/** Render a preview for a data-block of `doc`; undefined when it has nothing to show (or no renderer). */
export function renderPreview(doc: DocumentData, table: AssetTable, id: ID, fromObject?: ID): string | undefined {
  try {
    if (fromObject) return objectsPreview(doc, [fromObject, ...childrenOf(doc, fromObject)]);
    const b = blockOf(doc, table, id);
    if (!b) return undefined;
    switch (table) {
      case 'materials':
        return materialPreview(doc, id);
      case 'objects':
        return objectsPreview(doc, [id, ...childrenOf(doc, id)]);
      case 'collections': {
        const col = doc.collections[id];
        const off = col?.instance_offset ? new Matrix4().makeTranslation(-col.instance_offset[0], -col.instance_offset[1], -col.instance_offset[2]) : undefined;
        return objectsPreview(doc, collectionObjects(doc, id), off);
      }
      case 'worlds':
        return worldPreview(doc, b as unknown as WorldData);
      case 'node_groups':
        return nodeGroupPreview(b as unknown as NodeGroupData);
      case 'actions':
        return actionPreview(b as unknown as ActionData);
      case 'brushes':
        return brushPreview(b as unknown as BrushData);
    }
  } catch (e) {
    console.warn('Asset preview failed', e);
  }
  return undefined;
}

function childrenOf(doc: DocumentData, id: ID, depth = 0): ID[] {
  if (depth > 32) return [];
  const kids = Object.values(doc.objects).filter((o) => o.parent === id).map((o) => o.id);
  return [...kids, ...kids.flatMap((k) => childrenOf(doc, k, depth + 1))];
}

/** Fit an image into a square preview. */
export function previewFromCanvas(src: CanvasImageSource & { width: number; height: number }): string {
  const [c, x] = canvas2d();
  const S = PREVIEW_SIZE;
  const k = Math.min(S / src.width, S / src.height);
  const w = src.width * k,
    h = src.height * k;
  x.drawImage(src, (S - w) / 2, (S - h) / 2, w, h);
  return encode(c);
}

/** Scale an image file to a square preview (Load Custom Preview). */
export async function previewFromFile(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  const [c, x] = canvas2d();
  const S = PREVIEW_SIZE;
  const k = Math.min(S / bmp.width, S / bmp.height);
  const w = bmp.width * k,
    h = bmp.height * k;
  x.drawImage(bmp, (S - w) / 2, (S - h) / 2, w, h);
  bmp.close();
  return encode(c);
}
