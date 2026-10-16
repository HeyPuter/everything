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
  FogExp2,
  PCFShadowMap,
  type Material,
  type Light,
  type Texture,
  type BufferGeometry,
  type WebGLRenderer,
} from 'three';
import { PhysicalSpotLight, ShapedAreaLight } from 'three-gpu-pathtracer';
import type { App } from '../../app/app';
import { backgroundSetRoots } from '../../scenes/sets';
import type { DocumentData, LightData, ObjectData } from '../../data/types';
import type { EvalMesh } from '../../eval/types';
import { meshGeometry } from '../geometry';
import { viewportMaterial } from '../pbr';
import { materialSlots } from '../../editors/view3d/draw';
import { lightIntensity, areaLightSize } from './units';
import { pathTracerMaterial } from './ptmaterial';
import { worldEnvironment } from './environment';
import { installLightInfluence } from '../realtime/lightinfluence';
import { shadowSettings, lightShadowOptions, lightRange, worldSunOptions } from '../realtime/settings';
import { jitteredLightMatrix, lightShadowMapSize } from '../realtime/shadows';
import { castsShadow, transparentShadowMaterials } from '../realtime/materialfx';
import { splitWorldSun, worldAtResolution } from '../realtime/worldsun';
import { worldVolume, fogTransmittance, envAverage } from '../realtime/worldvolume';
import { fxUniforms } from '../realtime/fxshader';

const envAverages = new Map<string, [number, number, number]>();
function envAverageCached(env: { key: string; texture: { image: unknown } }): [number, number, number] {
  let a = envAverages.get(env.key);
  if (!a) {
    const img = env.texture.image as { data?: Float32Array; width: number; height: number };
    a = img.data instanceof Float32Array ? envAverage(img.data, img.width, img.height) : [0, 0, 0];
    if (envAverages.size > 8) envAverages.clear();
    envAverages.set(env.key, a);
  }
  return a;
}

/** Entry id of the sun light extracted from the world. */
const WORLD_SUN = '__world_sun__';

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
  /** multiplier of lamp intensities (realtime Light Paths ▸ Direct Light) */
  lightScale?: number;
  /** multiplier of world lighting (realtime Light Paths ▸ Indirect Light) */
  envScale?: number;
  /** view layer filter: leave surfaces out of the render */
  hideSurfaces?: boolean;
  /** light group renders: only these lights (object ids) light the scene */
  lightFilter?: (id: string) => boolean;
}

interface Entry {
  meshes: Mesh[];
  light?: Light;
  lightType?: string;
  data?: LightData;
  /** light matrix before shadow jitter */
  base?: Matrix4;
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
  for (const set of backgroundSetRoots(doc)) {
    for (const id of set.objects) out.add(id);
    for (const ch of set.children) walk(ch);
  }
  for (const id of [...out]) if (doc.objects[id]?.hide_render) out.delete(id);
  return out;
}

/** Opaque per-build state of the view layer visibility / light linking hooks. */
export type RenderVisState = object;
/**
 * View layer render visibility (holdout, indirect only) and light linking, provided by the
 * scenes module: `prepare` runs once per build, `materials` picks the materials of each mesh.
 */
export const renderVisHooks: {
  prepare?: (doc: DocumentData, mode: BuildOptions['mode'], objects: string[], lights: string[]) => RenderVisState | null;
  materials?: (st: RenderVisState, obId: string, mats: Material[], mesh: Mesh) => Material[];
  reset?: (mesh: Mesh) => void;
  /** after each build (also without state: clears what an earlier build set up) */
  finish?: (st: RenderVisState | null, scene: Scene) => void;
} = {};

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
  /** view layer visibility / light linking state of the last build */
  vis: RenderVisState | null = null;
  private lightScale = 1;
  private lightThreshold = 0;

  constructor(mode: BuildOptions['mode']) {
    this.mode = mode;
    this.scene.matrixWorldAutoUpdate = false;
    installLightInfluence(this.scene);
  }

  /** Bring the scene up to date with the app's evaluated depsgraph. */
  build(app: App, o: BuildOptions) {
    const doc = app.doc;
    this.mode = o.mode;
    this.lightScale = Math.max(0, o.lightScale ?? 1);
    this.lightThreshold = o.mode === 'raster' ? shadowSettings(doc.scene.render).threshold : 0;
    const renderable = o.final ? renderVisibleObjects(doc) : null;
    // holdout / indirect only / light linking of the visible objects
    const visIds: string[] = [],
      lightIds: string[] = [];
    if (renderVisHooks.prepare) {
      for (const ev of app.graph.objects.values()) {
        const visible = renderable ? renderable.has(ev.id) : ev.visible && !ev.ob.hide_render && (!o.localView || o.localView.has(ev.id));
        if (visible) (ev.ob.type === 'LIGHT' ? lightIds : visIds).push(ev.id);
      }
    }
    this.vis = renderVisHooks.prepare?.(doc, o.mode, visIds, lightIds) ?? null;
    const seen = new Set<string>();
    let structure = false,
      lights = false;
    const box = new Box3();
    for (const ev of app.graph.objects.values()) {
      const ob = ev.ob;
      const visible = renderable ? renderable.has(ev.id) : ev.visible && !ob.hide_render && (!o.localView || o.localView.has(ev.id));
      if (!visible) continue;
      if (ob.type === 'LIGHT') {
        if (o.useSceneLights === false || !ob.data || !doc.lights[ob.data] || (o.lightFilter && !o.lightFilter(ev.id))) continue;
        seen.add(ev.id);
        let e = this.entries.get(ev.id);
        if (!e) this.entries.set(ev.id, (e = { meshes: [] }));
        if (this.syncLight(doc.lights[ob.data], ev.world, e)) lights = true;
        e.light!.userData.obId = ev.id;
        continue;
      }
      if (!ev.mesh || !ev.mesh.indices.length || o.hideSurfaces) continue;
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
      if (!seen.has(id) && id !== WORLD_SUN) {
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
    this.syncEnvironment(doc, o);
    if (this.syncWorldSun(doc, o)) lights = true;
    this.fitSunShadows(doc);
    for (const hk of renderSceneHooks) hk(this, app, o);
    renderVisHooks.finish?.(this.vis, this.scene);
    for (const e of this.entries.values()) if (e.light) (e.base ??= new Matrix4()).copy(e.light.matrix);
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
      let mats = matFor(w.geo);
      renderVisHooks.reset?.(m);
      if (this.vis && renderVisHooks.materials) mats = renderVisHooks.materials(this.vis, ob.id, mats, m);
      const cur = Array.isArray(m.material) ? m.material : [m.material];
      const next = m instanceof InstancedMesh ? [mats[0]] : mats;
      if (cur.length !== next.length || cur.some((c, k) => c !== next[k])) {
        m.material = next.length === 1 ? next[0] : next;
        changed = true;
      }
      // Shadow Mode: None on every slot casts nothing; Transparent dithers the shadow by alpha
      const slotMats = slots.map((id) => (id ? doc.materials[id] : undefined));
      m.castShadow = ob.visible_shadow !== false && (!slotMats.length || slotMats.some(castsShadow));
      const ts = this.mode === 'raster' && next.length === 1 ? transparentShadowMaterials(next[0], slotMats[0]) : undefined;
      m.customDepthMaterial = ts?.depth;
      m.customDistanceMaterial = ts?.distance;
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
    const intensity = lightIntensity(la) * this.lightScale;
    if (!L.color.equals(color) || L.intensity !== intensity) changed = true;
    L.color.copy(color);
    L.intensity = intensity;
    L.userData.influence = [la.diffuse_factor ?? 1, la.specular_factor ?? 1, la.volume_factor ?? 1];
    // realtime: Custom Distance fades the light out at the cutoff distance; otherwise the light
    // reaches as far as it is brighter than the render's light threshold
    const cutoff = this.mode !== 'raster' ? 0 : la.use_custom_distance ? Math.max(0, la.cutoff_distance ?? 40) : la.type === 'SUN' || la.type === 'AREA' ? 0 : lightRange(intensity, this.lightThreshold);
    if ((L as PointLight).distance !== undefined && (L as PointLight).distance !== cutoff && L.type !== 'DirectionalLight') changed = true;
    if (L instanceof PointLight) {
      L.distance = cutoff;
      L.decay = 2;
    } else if (L instanceof PhysicalSpotLight) {
      const angle = Math.min(Math.PI / 2 - 1e-3, la.spot_size / 2);
      const radius = Math.max(0, la.shadow_soft_size);
      if (L.angle !== angle || L.penumbra !== la.spot_blend || L.radius !== radius) changed = true;
      L.angle = angle;
      L.penumbra = Math.min(1, Math.max(0, la.spot_blend));
      L.decay = 2;
      L.distance = cutoff;
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

  /** Configure shadow maps (resolution, filtering) from the render and light settings. */
  configureShadows(renderer: WebGLRenderer, doc: DocumentData) {
    const r = doc.scene.render;
    const ss = shadowSettings(r);
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
    renderer.shadowMap.enabled = ss.enabled;
    const b = this.bounds;
    for (const e of this.entries.values()) {
      const L = e.light as PointLight | undefined;
      if (!L?.shadow) continue;
      const la = e.data;
      const opts = la ? lightShadowOptions(la) : null;
      const sun = L instanceof DirectionalLight;
      const spot = L instanceof PhysicalSpotLight;
      const soft = !r.use_soft_shadows || !la ? 1 : sun ? 1 + la.angle * 250 : 1 + la.shadow_soft_size * 20;
      // jittered lights get their softness from the moving light: keep only the overblur
      const jitter = !!opts?.jitter && (this.jitterFinal || ss.jitterViewport);
      const radius = jitter ? 1 + (soft - 1) * (opts!.overblur / 100) : soft;
      L.shadow.radius = Math.max(0.5, radius * (opts?.filter ?? 1));
      tmpV.setFromMatrixPosition(e.base ?? L.matrix);
      const dist = Math.max(0.1, tmpV.distanceTo(b.center));
      const half = spot ? Math.tan(Math.min(Math.PI / 2 - 1e-3, (la?.spot_size ?? 1) / 2)) : 1;
      const size = lightShadowMapSize({
        kind: sun ? 'sun' : spot ? 'spot' : 'point',
        coverage: sun ? 2 * b.radius : 2 * (dist + b.radius) * half,
        unitCoverage: sun ? 2 * b.radius : 2 * half,
        limit: opts?.limit ?? 0,
        absolute: !!opts?.absolute,
        budget: sun ? cascade : cube,
        scale: ss.scale,
      });
      // keep the normal offset above one texel of the map to avoid shadow acne
      L.shadow.normalBias = Math.max(0.02, ((sun ? 3 : 1.5) * (sun ? 2 * b.radius : 2 * dist * half)) / size);
      if (L.shadow.mapSize.x !== size) {
        L.shadow.mapSize.set(size, size);
        L.shadow.map?.dispose();
        L.shadow.map = null;
      }
    }
  }

  /** Final renders always jitter soft shadows of lights with Jitter on; the viewport only on request. */
  jitterFinal = false;

  /**
   * Move jittering lights for accumulation sample `i` (call before each sample). Sample 0 and
   * lights without jitter keep their position.
   */
  jitterShadows(doc: DocumentData, i: number) {
    const viewportJitter = shadowSettings(doc.scene.render).jitterViewport;
    let moved = false;
    for (const e of this.entries.values()) {
      const L = e.light;
      if (!L || !e.base || !e.data || (L as PointLight).shadow === undefined) continue;
      const la = e.data;
      const on = !!la.use_shadow_jitter && la.use_shadow && (this.jitterFinal || viewportJitter) && i > 0;
      if (!on) {
        if (!L.matrix.equals(e.base)) {
          L.matrix.copy(e.base);
          moved = true;
        }
        continue;
      }
      const kind = L instanceof DirectionalLight ? 'sun' : L instanceof PhysicalSpotLight ? 'spot' : 'point';
      jitteredLightMatrix(e.base, kind, Math.max(0, la.shadow_soft_size), la.angle, i, this.bounds.center, L.matrix);
      moved = true;
    }
    if (moved) this.scene.updateMatrixWorld(true);
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

  /**
   * Realtime: world light above the world's Sun Threshold becomes a sun light (with shadows)
   * and is removed from the environment lighting. Returns true when the lights changed.
   */
  private syncWorldSun(doc: DocumentData, o: BuildOptions): boolean {
    const world = doc.scene.world ? doc.worlds[doc.scene.world] : null;
    const opts = worldSunOptions(world);
    const env = this.mode === 'raster' && o.useSceneWorld !== false && opts.threshold > 0 ? worldEnvironment(doc) : null;
    const split = env && !env.color ? splitWorldSun(env, opts.threshold) : null;
    const prev = this.entries.get(WORLD_SUN);
    if (!split) {
      if (!prev) return false;
      if (prev.light) {
        this.scene.remove(prev.light);
        prev.light.dispose();
      }
      this.entries.delete(WORLD_SUN);
      return true;
    }
    this.scene.environment = split.texture;
    this.envKey += '|sun';
    const m = Math.max(...split.irradiance, 1e-6);
    const la: LightData = {
      id: WORLD_SUN,
      name: 'World Sun',
      type: 'SUN',
      color: [split.irradiance[0] / m, split.irradiance[1] / m, split.irradiance[2] / m],
      energy: m,
      shadow_soft_size: 0,
      angle: opts.angle,
      spot_size: 0,
      spot_blend: 0,
      show_cone: false,
      shape: 'SQUARE',
      size: 0,
      size_y: 0,
      use_shadow: opts.shadow,
      diffuse_factor: 1,
      specular_factor: 1,
      volume_factor: 1,
      use_shadow_jitter: opts.jitter,
      shadow_jitter_overblur: opts.overblur,
      shadow_filter_radius: opts.filter,
      shadow_maximum_resolution: opts.limit,
    };
    let e = prev;
    if (!e) this.entries.set(WORLD_SUN, (e = { meshes: [] }));
    const d = new Vector3(...split.direction);
    const up = Math.abs(d.z) > 0.99 ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
    const world4 = new Matrix4().lookAt(d, new Vector3(), up);
    return this.syncLight(la, world4, e);
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
    const k = Math.max(0, o.envScale ?? 1);
    if (k !== 1) {
      s.environmentIntensity *= k;
      this.envKey += `*${k}`;
    }
    // World ▸ Settings ▸ Light Probe ▸ Resolution: detail of the world's lighting
    const world = doc.scene.world ? doc.worlds[doc.scene.world] : null;
    if (env && this.mode === 'raster' && s.environment === env.texture && world?.probe_resolution) {
      const t = worldAtResolution(env, Number(world.probe_resolution));
      if (t !== env.texture) {
        s.environment = t;
        this.envKey += `|res${world.probe_resolution}`;
      }
    }
    this.syncWorldVolume(doc, o, env);
  }

  /** Realtime: the world's Volume shader as fog lit by the world and sun lamps. */
  private syncWorldVolume(doc: DocumentData, o: BuildOptions, env: ReturnType<typeof worldEnvironment>) {
    const s = this.scene;
    const world = doc.scene.world ? doc.worlds[doc.scene.world] : null;
    const vol = this.mode === 'raster' && o.useSceneWorld !== false ? worldVolume(world) : null;
    if (!vol || vol.density <= 0) {
      s.fog = null;
      return;
    }
    // light scattered towards the camera: the world's average radiance plus sun lamps
    const amb = env ? envAverageCached(env) : [0, 0, 0];
    const light = [amb[0], amb[1], amb[2]];
    for (const e of this.entries.values())
      if (e.light instanceof DirectionalLight && e.data) {
        const E = e.light.intensity * (e.data.volume_factor ?? 1) / (4 * Math.PI);
        light[0] += e.light.color.r * E;
        light[1] += e.light.color.g * E;
        light[2] += e.light.color.b * E;
      }
    const color = new Color(vol.albedo[0] * light[0], vol.albedo[1] * light[1], vol.albedo[2] * light[2]);
    if (s.fog instanceof FogExp2) {
      s.fog.color.copy(color);
      s.fog.density = vol.density;
    } else s.fog = new FogExp2(color, vol.density);
    const r = doc.scene.render;
    const custom = !!r.use_volume_custom_range;
    fxUniforms.ndFogRange.value.set(custom ? Math.max(0, r.volumetric_start ?? 0.1) : 0, custom ? Math.max(0, r.volumetric_end ?? 100) : 1e9, 0, 0);
    // a flat background sees the medium over its whole depth
    if (s.background instanceof Color) {
      const T = custom ? fogTransmittance(vol.density, (r.volumetric_end ?? 100) - (r.volumetric_start ?? 0.1)) : 0;
      s.background = s.background.clone().lerp(color, 1 - T);
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
