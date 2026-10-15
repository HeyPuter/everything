// A three.js scene built from the evaluated depsgraph for rendering (Rendered viewport and
// final renders). Unlike the editor's SceneSync it holds only renderable data: meshes with
// their materials, lights (in calibrated units) and the world environment.
import {
  Scene,
  Mesh,
  InstancedMesh,
  Matrix4,
  Vector3,
  Quaternion,
  Sphere,
  Box3,
  PointLight,
  DirectionalLight,
  Color,
  PCFShadowMap,
  type Material,
  type Light,
  type Texture,
  type BufferGeometry,
  type WebGLRenderer,
} from 'three';
import { PhysicalSpotLight, ShapedAreaLight } from 'three-gpu-pathtracer';
import type { App } from '../../app/app';
import type { DocumentData, LightData, ObjectData } from '../../data/types';
import type { EvalMesh } from '../../eval/types';
import { meshGeometry } from '../geometry';
import { viewportMaterial } from '../pbr';
import { materialSlots } from '../../editors/view3d/draw';
import { lightIntensity, areaLightSize } from './units';
import { pathTracerMaterial } from './ptmaterial';
import { worldEnvironment } from './environment';

export interface BuildOptions {
  mode: 'raster' | 'pathtrace';
  /** use render visibility (final render) instead of viewport visibility */
  final: boolean;
  localView?: Set<string> | null;
  useSceneLights?: boolean;
  useSceneWorld?: boolean;
  /** environment used when the scene world is not used (raster: PMREM texture) */
  studio?: { texture: Texture; intensity: number } | null;
  filmTransparent?: boolean;
}

interface Entry {
  meshes: Mesh[];
  light?: Light;
  lightType?: string;
  data?: LightData;
}

/** Objects that take part in final renders (collection exclude / disable-in-renders flags). */
export function renderVisibleObjects(doc: DocumentData): Set<string> {
  const out = new Set<string>();
  const walk = (cid: string) => {
    const c = doc.collections[cid];
    if (!c) return;
    const master = cid === doc.scene.collection;
    if (!master && (c.exclude || c.hide_render)) return;
    for (const id of c.objects) out.add(id);
    for (const ch of c.children) walk(ch);
  };
  walk(doc.scene.collection);
  for (const id of [...out]) if (doc.objects[id]?.hide_render) out.delete(id);
  return out;
}

/** Extra renderable content (e.g. grease pencil strokes) added to the render scene after each build. */
export const renderSceneHooks: ((rs: RenderScene, app: App, o: BuildOptions) => void)[] = [];
/** Adjust a light's colour before it is applied (e.g. the emission of a light node tree). */
export const lightTintHooks: ((la: LightData, color: Color) => void)[] = [];

const tmpM = new Matrix4();
const tmpV = new Vector3();
const tmpQ = new Quaternion();
const tmpS = new Vector3();

export class RenderScene {
  scene = new Scene();
  private entries = new Map<string, Entry>();
  /** bumps when meshes/materials were added, removed or re-assigned */
  structureVersion = 0;
  /** bumps when lights changed */
  lightsVersion = 0;
  envKey = '';
  bounds = new Sphere(new Vector3(), 1);
  mode: BuildOptions['mode'];

  constructor(mode: BuildOptions['mode']) {
    this.mode = mode;
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** Bring the scene up to date with the app's evaluated depsgraph. */
  build(app: App, o: BuildOptions) {
    const doc = app.doc;
    this.mode = o.mode;
    const renderable = o.final ? renderVisibleObjects(doc) : null;
    const seen = new Set<string>();
    let structure = false,
      lights = false;
    const box = new Box3();
    for (const ev of app.graph.objects.values()) {
      const ob = ev.ob;
      const visible = renderable ? renderable.has(ev.id) : ev.visible && !ob.hide_render && (!o.localView || o.localView.has(ev.id));
      if (!visible) continue;
      if (ob.type === 'LIGHT') {
        if (o.useSceneLights === false || !ob.data || !doc.lights[ob.data]) continue;
        seen.add(ev.id);
        let e = this.entries.get(ev.id);
        if (!e) this.entries.set(ev.id, (e = { meshes: [] }));
        if (this.syncLight(doc.lights[ob.data], ev.world, e)) lights = true;
        continue;
      }
      if (!ev.mesh || !ev.mesh.indices.length) continue;
      seen.add(ev.id);
      let e = this.entries.get(ev.id);
      if (!e) this.entries.set(ev.id, (e = { meshes: [] }));
      if (this.syncMeshes(app, doc, ob, ev.mesh, ev.world, e)) structure = true;
      for (const m of e.meshes) {
        const g = m.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        const s = (m instanceof InstancedMesh && m.boundingSphere ? m.boundingSphere : g.boundingSphere!).clone().applyMatrix4(m.matrix);
        box.expandByPoint(tmpV.copy(s.center).addScalar(s.radius));
        box.expandByPoint(tmpV.copy(s.center).addScalar(-s.radius));
      }
    }
    for (const [id, e] of this.entries)
      if (!seen.has(id)) {
        for (const m of e.meshes) this.scene.remove(m);
        if (e.meshes.length) structure = true;
        if (e.light) {
          this.scene.remove(e.light);
          e.light.dispose();
          lights = true;
        }
        this.entries.delete(id);
      }
    if (!box.isEmpty()) box.getBoundingSphere(this.bounds);
    else this.bounds.set(new Vector3(), 1);
    this.fitSunShadows(doc);
    this.syncEnvironment(doc, o);
    for (const hk of renderSceneHooks) hk(this, app, o);
    this.scene.updateMatrixWorld(true);
    if (structure) this.structureVersion++;
    if (lights) this.lightsVersion++;
  }

  private syncMeshes(app: App, doc: DocumentData, ob: ObjectData, mesh: EvalMesh, world: Matrix4, e: Entry): boolean {
    let changed = false;
    const geo = meshGeometry(mesh).geometry;
    const slots = materialSlots(doc, ob);
    const matFor = (g: BufferGeometry): Material[] => {
      const n = Math.max(1, ...g.groups.map((gr) => (gr.materialIndex ?? 0) + 1));
      const out: Material[] = [];
      for (let s = 0; s < n; s++) {
        const vm = viewportMaterial(doc, slots[s] ?? null);
        out.push(this.mode === 'pathtrace' ? pathTracerMaterial(vm) : vm);
      }
      return out;
    };
    const wanted: { geo: BufferGeometry; matrix: Matrix4; instanced?: Matrix4[] }[] = [{ geo, matrix: world }];
    const inst = mesh.instances;
    if (inst?.length) {
      const groups = new Map<BufferGeometry, Matrix4[]>();
      for (const it of inst) {
        let g: BufferGeometry | null = null;
        if (it.mesh) g = meshGeometry(it.mesh).geometry;
        else if (it.objectId) {
          const src = app.graph.get(it.objectId);
          if (src?.mesh) g = meshGeometry(src.mesh).geometry;
        }
        if (!g) continue;
        let list = groups.get(g);
        if (!list) groups.set(g, (list = []));
        list.push(world.clone().multiply(new Matrix4().fromArray(it.matrix)));
      }
      for (const [g, mats] of groups) {
        if (this.mode === 'raster') wanted.push({ geo: g, matrix: new Matrix4(), instanced: mats });
        else for (const m of mats) wanted.push({ geo: g, matrix: m });
      }
    }
    // reuse mesh objects positionally so the path tracer can detect unchanged geometry
    while (e.meshes.length > wanted.length) {
      this.scene.remove(e.meshes.pop()!);
      changed = true;
    }
    wanted.forEach((w, i) => {
      let m = e.meshes[i];
      const needInstanced = !!w.instanced;
      if (m && (m instanceof InstancedMesh) !== needInstanced) {
        this.scene.remove(m);
        m = undefined as unknown as Mesh;
      }
      if (m && w.instanced && (m as InstancedMesh).count !== w.instanced.length) {
        this.scene.remove(m);
        m = undefined as unknown as Mesh;
      }
      if (!m) {
        m = w.instanced ? new InstancedMesh(w.geo, undefined, w.instanced.length) : new Mesh(w.geo);
        m.matrixAutoUpdate = false;
        m.userData.id = ob.id;
        e.meshes[i] = m;
        this.scene.add(m);
        changed = true;
      }
      if (m.geometry !== w.geo) {
        m.geometry = w.geo;
        changed = true;
      }
      if (w.instanced) {
        const im = m as InstancedMesh;
        w.instanced.forEach((mm, k) => im.setMatrixAt(k, mm));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
      }
      m.matrix.copy(w.matrix);
      const mats = matFor(w.geo);
      const cur = Array.isArray(m.material) ? m.material : [m.material];
      const next = m instanceof InstancedMesh ? [mats[0]] : mats;
      if (cur.length !== next.length || cur.some((c, k) => c !== next[k])) {
        m.material = next.length === 1 ? next[0] : next;
        changed = true;
      }
      m.castShadow = ob.visible_shadow !== false;
      m.receiveShadow = true;
    });
    return changed;
  }

  private syncLight(la: LightData, world: Matrix4, e: Entry): boolean {
    let changed = false;
    e.data = la;
    if (e.light && e.lightType !== la.type) {
      this.scene.remove(e.light);
      e.light.dispose();
      e.light = undefined;
    }
    if (!e.light) {
      let L: Light;
      if (la.type === 'POINT') L = new PointLight();
      else if (la.type === 'SUN') L = new DirectionalLight();
      else if (la.type === 'SPOT') L = new PhysicalSpotLight();
      else L = new ShapedAreaLight();
      L.matrixAutoUpdate = false;
      const t = (L as DirectionalLight).target;
      if (t) {
        t.matrixAutoUpdate = false;
        t.matrix.makeTranslation(0, 0, -1);
        L.add(t);
      }
      this.scene.add(L);
      e.light = L;
      e.lightType = la.type;
      changed = true;
    }
    const L = e.light;
    world.decompose(tmpV, tmpQ, tmpS);
    tmpM.compose(tmpV, tmpQ, new Vector3(1, 1, 1));
    if (!L.matrix.equals(tmpM)) changed = true;
    L.matrix.copy(tmpM);
    const color = new Color(la.color[0], la.color[1], la.color[2]);
    for (const hk of lightTintHooks) hk(la, color);
    const intensity = lightIntensity(la);
    if (!L.color.equals(color) || L.intensity !== intensity) changed = true;
    L.color.copy(color);
    L.intensity = intensity;
    if (L instanceof PointLight) {
      L.distance = 0;
      L.decay = 2;
    } else if (L instanceof PhysicalSpotLight) {
      const angle = Math.min(Math.PI / 2 - 1e-3, la.spot_size / 2);
      const radius = Math.max(0, la.shadow_soft_size);
      if (L.angle !== angle || L.penumbra !== la.spot_blend || L.radius !== radius) changed = true;
      L.angle = angle;
      L.penumbra = Math.min(1, Math.max(0, la.spot_blend));
      L.decay = 2;
      L.distance = 0;
      L.radius = radius;
    } else if (L instanceof ShapedAreaLight) {
      const [w, h] = areaLightSize(la);
      const sw = w * Math.abs(tmpS.x),
        sh = h * Math.abs(tmpS.y);
      const circ = la.shape === 'DISK' || la.shape === 'ELLIPSE';
      if (L.width !== sw || L.height !== sh || L.isCircular !== circ) changed = true;
      L.isCircular = circ;
      // the raster approximation of round lights is a square of equal area
      const k = circ && this.mode === 'raster' ? Math.sqrt(Math.PI / 4) : 1;
      L.width = sw * k;
      L.height = sh * k;
    }
    if (!(L instanceof ShapedAreaLight)) {
      L.castShadow = la.use_shadow;
      const shadow = (L as PointLight).shadow;
      if (shadow) {
        shadow.bias = -(la.shadow_buffer_bias ?? 1) * 0.0004;
        shadow.normalBias = 0.02;
      }
    }
    return changed;
  }

  /** Configure shadow map resolutions from the render settings. */
  configureShadows(renderer: WebGLRenderer, doc: DocumentData) {
    const r = doc.scene.render;
    const cube = Number(r.shadow_cube_size) || 512;
    const cascade = Number(r.shadow_cascade_size) || 1024;
    // percentage-closer filtering; the kernel radius follows the light size for soft shadows
    const type = PCFShadowMap;
    if (renderer.shadowMap.type !== type) {
      renderer.shadowMap.type = type;
      this.scene.traverse((o) => {
        const m = (o as Mesh).material;
        if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true));
      });
    }
    renderer.shadowMap.enabled = true;
    for (const e of this.entries.values()) {
      const L = e.light as PointLight | undefined;
      if (!L?.shadow) continue;
      const la = e.data;
      L.shadow.radius = !r.use_soft_shadows || !la ? 1 : L instanceof DirectionalLight ? 1 + la.angle * 250 : 1 + la.shadow_soft_size * 20;
      const size = L instanceof DirectionalLight ? cascade * 2 : cube * 2;
      if (L.shadow.mapSize.x !== size) {
        L.shadow.mapSize.set(size, size);
        L.shadow.map?.dispose();
        L.shadow.map = null;
      }
    }
  }

  /** Sun shadow cameras cover the scene bounds. */
  private fitSunShadows(_doc: DocumentData) {
    const b = this.bounds;
    for (const e of this.entries.values()) {
      const L = e.light;
      if (!(L instanceof DirectionalLight)) continue;
      const r = Math.max(0.5, b.radius);
      const dir = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(L.matrix));
      // place the light behind the scene along its direction; target 1 unit ahead
      const pos = b.center.clone().addScaledVector(dir, -r * 2);
      const rot = new Quaternion().setFromRotationMatrix(L.matrix);
      L.matrix.compose(pos, rot, new Vector3(1, 1, 1));
      const cam = L.shadow.camera;
      cam.left = cam.bottom = -r;
      cam.right = cam.top = r;
      cam.near = 0.01;
      cam.far = r * 4;
      cam.updateProjectionMatrix();
    }
  }

  private syncEnvironment(doc: DocumentData, o: BuildOptions) {
    const s = this.scene;
    const useWorld = o.useSceneWorld !== false;
    const env = useWorld ? worldEnvironment(doc) : null;
    s.environmentIntensity = 1;
    s.backgroundIntensity = 1;
    if (env) {
      this.envKey = env.key;
      s.environment = env.texture;
      s.background = o.filmTransparent ? null : env.color ?? env.texture;
    } else if (!useWorld && o.studio) {
      this.envKey = `studio${o.studio.intensity}`;
      s.environment = o.studio.texture;
      s.environmentIntensity = o.studio.intensity;
      s.background = o.filmTransparent ? null : new Color(0.05, 0.05, 0.05);
    } else {
      this.envKey = 'none';
      s.environment = null;
      s.background = o.filmTransparent ? null : new Color(0, 0, 0);
    }
  }

  dispose() {
    for (const e of this.entries.values()) {
      for (const m of e.meshes) this.scene.remove(m);
      e.light?.dispose();
    }
    this.entries.clear();
  }
}
