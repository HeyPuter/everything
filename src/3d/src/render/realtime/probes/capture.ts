// Light probe rendering for the realtime engine.
// - Sphere probes capture a cubemap of the scene at the probe (when added, moved or re-baked); meshes
//   inside a probe's influence use it instead of the world for reflections (with optional parallax).
// - Plane probes render the scene mirrored about the plane every sample; surfaces lying on the plane
//   reflect that image.
// - Volume probes hold a grid of baked irradiance (spherical harmonics) that lights surfaces inside.
import {
  Box3,
  CubeCamera,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  Plane,
  RGBAFormat,
  ShaderChunk,
  Sphere,
  Uniform,
  Vector3,
  Vector4,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { LightProbeGridWebGL } from 'three/examples/jsm/lighting/LightProbeGridWebGL.js';
import { renderContext } from '../../context';
import { fxUniforms } from '../fxshader';
import type { LightProbeSettings } from '../types';

export interface ProbeEntry {
  id: string;
  probe: LightProbeSettings;
  world: Matrix4;
  /** objects excluded from the probe's captures */
  hidden: Set<string>;
}

/** Probes of a render scene (set when the scene is built). */
export function sceneProbeEntries(scene: Scene): ProbeEntry[] {
  return (scene.userData.probes as ProbeEntry[] | undefined) ?? [];
}

// ---------------------------------------------------------------------------
// caches (GPU data lives for the session; documents remember that a bake exists)

interface SphereCache {
  key: string;
  env: WebGLRenderTarget;
}
interface GridCache {
  grid: LightProbeGridWebGL;
  intensity: number;
  replaceWorld: boolean;
}
const spheres = new Map<string, SphereCache>();
const grids = new Map<string, GridCache>();

/** Settings that require a new capture when they change. */
export function captureKey(e: Pick<ProbeEntry, 'probe' | 'world'>, resolution: number): string {
  const rest: Record<string, unknown> = { ...e.probe };
  for (const k of ['show_influence', 'show_clip', 'show_parallax', 'show_data', 'data_display_size', 'baked']) delete rest[k];
  const baked = e.probe.baked;
  return `${resolution}|${baked?.time ?? 0}|${e.world.elements.map((v) => v.toFixed(5)).join(',')}|${JSON.stringify(rest)}`;
}

export function setProbeCache(id: string, c: { grid?: LightProbeGridWebGL; sphere?: SphereCache }) {
  if (c.grid) grids.set(id, { grid: c.grid, intensity: 1, replaceWorld: false });
  if (c.sphere) spheres.set(id, c.sphere);
}

export function hasProbeCache(id: string) {
  return spheres.has(id) || grids.has(id);
}

export function freeProbeCache(id: string) {
  const s = spheres.get(id);
  if (s) {
    s.env.dispose();
    spheres.delete(id);
  }
  const g = grids.get(id);
  if (g) {
    g.grid.removeFromParent();
    g.grid.dispose();
    grids.delete(id);
  }
}

// ---------------------------------------------------------------------------
// capture helpers

/** Hide the objects a probe must not see; returns a restore function. */
function hideFor(scene: Scene, hidden: Set<string>): () => void {
  if (!hidden.size) return () => {};
  const changed: Object3D[] = [];
  scene.traverse((o) => {
    if (o.visible && hidden.has(o.userData.id as string)) {
      o.visible = false;
      changed.push(o);
    }
  });
  return () => changed.forEach((o) => (o.visible = true));
}

function withCleanState<T>(renderer: WebGLRenderer, fn: () => T): T {
  const target = renderer.getRenderTarget();
  const scissor = renderer.getScissorTest();
  const tm = renderer.toneMapping;
  const u = fxUniforms;
  const fx = u.ndFx.value.x,
    pl = u.ndPl.value.x,
    plTex = u.ndPlTex.value,
    ssTex = u.ndSsTex.value;
  renderer.setScissorTest(false);
  renderer.toneMapping = 0;
  // captures see neither traced effects nor planar reflections (and never sample their own target)
  u.ndFx.value.x = 0;
  u.ndPl.value.x = 0;
  u.ndPlTex.value = null;
  u.ndSsTex.value = null;
  try {
    return fn();
  } finally {
    u.ndFx.value.x = fx;
    u.ndPl.value.x = pl;
    u.ndPlTex.value = plTex;
    u.ndSsTex.value = ssTex;
    renderer.toneMapping = tm;
    renderer.setRenderTarget(target);
    renderer.setScissorTest(scissor);
  }
}

/** Capture a sphere probe's cubemap and pre-filter it for glossy lookups. */
export function captureSphere(renderer: WebGLRenderer, scene: Scene, e: ProbeEntry, resolution: number): WebGLRenderTarget | null {
  const pmrem = renderContext?.engine.pmrem;
  if (!pmrem) return null;
  return withCleanState(renderer, () => {
    const rt = new WebGLCubeRenderTarget(resolution, { type: HalfFloatType, generateMipmaps: false });
    const cam = new CubeCamera(Math.max(1e-4, e.probe.clip_start), Math.max(e.probe.clip_start + 1e-3, e.probe.clip_end), rt);
    cam.position.setFromMatrixPosition(e.world);
    cam.updateMatrixWorld(true);
    const restore = hideFor(scene, e.hidden);
    try {
      cam.update(renderer, scene);
    } finally {
      restore();
    }
    const env = pmrem.fromCubemap(rt.texture);
    rt.dispose();
    return env;
  });
}

/** World-space box of a volume probe (its unit cube transformed by the object). */
export function volumeBox(world: Matrix4): Box3 {
  return new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)).applyMatrix4(world);
}

/** Bake a volume probe's irradiance grid from the scene. */
export function bakeVolume(renderer: WebGLRenderer, scene: Scene, e: ProbeEntry): LightProbeGridWebGL {
  return withCleanState(renderer, () => {
    const p = e.probe;
    const b = volumeBox(e.world);
    const size = b.getSize(new Vector3());
    const grid = new LightProbeGridWebGL(Math.max(1e-3, size.x), Math.max(1e-3, size.y), Math.max(1e-3, size.z), clampRes(p.resolution_x), clampRes(p.resolution_y), clampRes(p.resolution_z));
    b.getCenter(grid.position);
    grid.updateMatrixWorld(true);
    const bg = scene.background;
    if (!p.capture_world) scene.background = null;
    const restore = hideFor(scene, e.hidden);
    try {
      grid.bake(renderer, scene, { cubemapSize: 16, near: Math.max(1e-4, p.clip_start), far: Math.max(p.clip_start + 1e-3, p.capture_distance ?? 20), bounces: p.capture_indirect === false ? 0 : 1 });
    } finally {
      restore();
      scene.background = bg;
    }
    return grid;
  });
}

const clampRes = (n: number | undefined) => Math.max(1, Math.min(64, Math.round(n ?? 4)));

// ---------------------------------------------------------------------------
// planar reflections

const planarCam = new PerspectiveCamera();
let planarRT: WebGLRenderTarget | null = null;
const tmpN = new Vector3(),
  tmpP = new Vector3(),
  tmpC = new Vector3(),
  tmpT = new Vector3(),
  tmpUp = new Vector3();
const clipPlane = new Plane();
const q4 = new Vector4(),
  c4 = new Vector4();

/** Plane (world normal and origin) of a plane probe. */
export function probePlane(world: Matrix4): { normal: Vector3; origin: Vector3 } {
  // the plane normal is the object's Z axis corrected for non-uniform scale (normal matrix)
  const nm = new Matrix4().copy(world).invert().transpose();
  return { normal: new Vector3(0, 0, 1).transformDirection(nm), origin: new Vector3().setFromMatrixPosition(world) };
}

/**
 * Render the mirrored scene for a plane probe seen from `camera`; arms the planar uniforms.
 * Returns false when the camera is behind the plane.
 */
export function renderPlanar(renderer: WebGLRenderer, scene: Scene, camera: Camera, W: number, H: number, e: ProbeEntry): boolean {
  const { normal, origin } = probePlane(e.world);
  tmpN.copy(normal);
  tmpC.setFromMatrixPosition(camera.matrixWorld);
  if (tmpC.clone().sub(origin).dot(tmpN) <= 0) return false;
  const cam = camera as PerspectiveCamera;
  // mirrored camera: position, look-at target and up reflected about the plane
  tmpP.copy(origin).sub(tmpC).reflect(tmpN).negate().add(origin);
  const fwd = new Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
  tmpT.copy(tmpC).add(fwd);
  tmpT.copy(origin).sub(tmpT).reflect(tmpN).negate().add(origin);
  tmpUp.set(0, 1, 0).transformDirection(cam.matrixWorld).reflect(tmpN);
  planarCam.position.copy(tmpP);
  planarCam.up.copy(tmpUp);
  planarCam.lookAt(tmpT);
  planarCam.updateMatrixWorld(true);
  planarCam.matrixWorldInverse.copy(planarCam.matrixWorld).invert();
  planarCam.projectionMatrix.copy(cam.projectionMatrix);
  planarCam.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
  // texture matrix: world → mirrored image coordinates
  const tm = fxUniforms.ndPlTexMat.value;
  tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  tm.multiply(planarCam.projectionMatrix).multiply(planarCam.matrixWorldInverse);
  // oblique near plane: nothing below the mirror is drawn
  // the clip plane sits just above the mirror so the surface carrying the probe is not drawn
  clipPlane.setFromNormalAndCoplanarPoint(tmpN, origin.clone().addScaledVector(tmpN, Math.max(1e-3, e.probe.clip_start)));
  clipPlane.applyMatrix4(planarCam.matrixWorldInverse);
  c4.set(clipPlane.normal.x, clipPlane.normal.y, clipPlane.normal.z, clipPlane.constant);
  const pm = planarCam.projectionMatrix.elements;
  q4.set((Math.sign(c4.x) + pm[8]) / pm[0], (Math.sign(c4.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
  c4.multiplyScalar(2 / c4.dot(q4));
  pm[2] = c4.x;
  pm[6] = c4.y;
  pm[10] = c4.z + 1;
  pm[14] = c4.w;
  const w = Math.max(1, Math.round(W / 2)),
    h = Math.max(1, Math.round(H / 2));
  if (!planarRT) planarRT = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, generateMipmaps: true });
  else if (planarRT.width !== w || planarRT.height !== h) planarRT.setSize(w, h);
  withCleanState(renderer, () => {
    const restore = hideFor(scene, e.hidden);
    try {
      renderer.setRenderTarget(planarRT);
      renderer.clear(true, true, true);
      renderer.render(scene, planarCam);
    } finally {
      restore();
    }
  });
  const u = fxUniforms;
  u.ndPlTex.value = planarRT.texture;
  u.ndPlLocal.value.copy(e.world).invert();
  u.ndPlN.value.set(tmpN.x, tmpN.y, tmpN.z, tmpN.dot(origin));
  u.ndPl.value.set(1, Math.max(1e-4, e.probe.influence_distance), Math.min(1, Math.max(0, e.probe.falloff)), Math.floor(Math.log2(Math.max(w, h))));
  return true;
}

// ---------------------------------------------------------------------------
// sphere probe material variants (per-object environment with parallax correction)

const PARALLAX = /* glsl */ `
uniform vec4 ndPx;
uniform mat4 ndPxM;
uniform mat4 ndPxMi;
vec3 ndParallax( vec3 R ) {
  if ( ndPx.w < 0.5 ) return R;
  vec3 wp = ( ( vec4( - vViewPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
  vec3 lp = ( ndPxM * vec4( wp, 1.0 ) ).xyz;
  vec3 ld = normalize( ( ndPxM * vec4( R, 0.0 ) ).xyz );
  float t;
  if ( ndPx.w < 1.5 ) {
    float b = dot( lp, ld ), c = dot( lp, lp ) - 1.0, h = b * b - c;
    if ( h < 0.0 ) return R;
    t = - b + sqrt( h );
  } else {
    vec3 ta = ( vec3( 1.0 ) - lp ) / ld, tb = ( vec3( - 1.0 ) - lp ) / ld;
    vec3 tm = max( ta, tb );
    t = min( min( tm.x, tm.y ), tm.z );
  }
  if ( t <= 0.0 ) return R;
  vec3 hit = ( ndPxMi * vec4( lp + ld * t, 1.0 ) ).xyz;
  return normalize( hit - ndPx.xyz );
}
`;

const envPars = ShaderChunk.envmap_physical_pars_fragment.replace(/(reflectVec = transformDirectionByInverseViewMatrix\( reflectVec, viewMatrix \);)/, '$1\n\t\t\treflectVec = ndParallax( reflectVec );');

interface Variant {
  version: number;
  env: Texture;
  mat: Material;
  uniforms: { ndPx: Uniform<Vector4>; ndPxM: Uniform<Matrix4>; ndPxMi: Uniform<Matrix4> };
}
const variants = new WeakMap<Material, Map<string, Variant>>();

function probeVariant(base: Material, id: string, env: Texture): Variant {
  let byProbe = variants.get(base);
  if (!byProbe) variants.set(base, (byProbe = new Map()));
  const hit = byProbe.get(id);
  if (hit && hit.version === base.version && hit.env === env) return hit;
  hit?.mat.dispose();
  const mat = base.clone() as Material & { envMap?: Texture | null; defines?: Record<string, unknown>; uniformsGroups?: unknown[] };
  const src = base as Material & { defines?: Record<string, unknown>; uniformsGroups?: unknown[] };
  mat.defines = { ...(src.defines ?? {}) };
  mat.envMap = env;
  if (src.uniformsGroups) mat.uniformsGroups = src.uniformsGroups;
  mat.onBeforeRender = base.onBeforeRender;
  mat.userData = base.userData;
  const uniforms = { ndPx: new Uniform(new Vector4()), ndPxM: new Uniform(new Matrix4()), ndPxMi: new Uniform(new Matrix4()) };
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, r: WebGLRenderer) => {
    base.onBeforeCompile(shader, r);
    shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>', `${PARALLAX}\n${envPars}`);
    Object.assign(shader.uniforms, uniforms);
  };
  const baseKey = base.customProgramCacheKey.bind(base);
  mat.customProgramCacheKey = () => `${baseKey()}|probe`;
  const v: Variant = { version: base.version, env, mat, uniforms };
  byProbe.set(id, v);
  return v;
}

/** Influence of a sphere probe at a world point (0 outside, 1 well inside). */
export function sphereInfluence(p: LightProbeSettings, worldInverse: Matrix4, point: Vector3): number {
  const l = point.clone().applyMatrix4(worldInverse);
  const r = Math.max(1e-6, p.influence_distance);
  const d = p.influence_type === 'BOX' ? Math.max(Math.abs(l.x), Math.abs(l.y), Math.abs(l.z)) : l.length();
  if (d >= r) return 0;
  const inner = r * (1 - Math.min(1, Math.max(0, p.falloff)));
  return d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-6, r - inner);
}

// ---------------------------------------------------------------------------
// per-render setup

const sphereTmp = new Sphere();

/**
 * Prepare probes for rendering `scene` from `camera`: captures missing sphere probes, re-bakes
 * volume grids lost with a reload, renders the planar probe and switches meshes inside sphere
 * probes to their probe's environment. Returns a function restoring the scene's materials.
 */
export function beginProbes(renderer: WebGLRenderer, scene: Scene, camera: Camera, W: number, H: number, resolution: number): () => void {
  const u = fxUniforms;
  u.ndPl.value.x = 0;
  const list = sceneProbeEntries(scene);
  for (const v of u.ndVolMin.value) v.set(0, 0, 0, 0);
  for (const v of u.ndVolMax.value) v.set(0, 0, 0, 0);
  if (!list.length) return () => {};
  // volumes: (re)bake grids that exist in the document but not on the GPU, then attach them
  let vi = 0;
  for (const e of list) {
    if (e.probe.type !== 'VOLUME' || !e.probe.baked) continue;
    let g = grids.get(e.id);
    if (!g) {
      g = { grid: bakeVolume(renderer, scene, e), intensity: 1, replaceWorld: false };
      g.grid.userData.probeId = e.id;
      grids.set(e.id, g);
    }
    g.intensity = Math.max(0, e.probe.intensity ?? 1);
    g.replaceWorld = !!e.probe.capture_world;
    if (g.grid.parent !== scene) scene.add(g.grid);
    if (vi < 4) {
      const bb = g.grid.boundingBox;
      u.ndVolMin.value[vi].set(bb.min.x, bb.min.y, bb.min.z, g.intensity);
      u.ndVolMax.value[vi].set(bb.max.x, bb.max.y, bb.max.z, g.replaceWorld ? 1 : 0);
      vi++;
    }
  }
  // spheres: capture when new or changed
  const sphereList: { e: ProbeEntry; env: Texture; inv: Matrix4 }[] = [];
  for (const e of list) {
    if (e.probe.type !== 'SPHERE') continue;
    const key = captureKey(e, resolution);
    let s = spheres.get(e.id);
    if (!s || s.key !== key) {
      const env = captureSphere(renderer, scene, e, resolution);
      if (!env) continue;
      s?.env.dispose();
      s = { key, env };
      spheres.set(e.id, s);
    }
    sphereList.push({ e, env: s.env.texture, inv: e.world.clone().invert() });
  }
  // planar: the nearest plane probe the camera looks down on
  const camPos = new Vector3().setFromMatrixPosition(camera.matrixWorld);
  const planes = list.filter((e) => e.probe.type === 'PLANE').sort((a, b) => new Vector3().setFromMatrixPosition(a.world).distanceTo(camPos) - new Vector3().setFromMatrixPosition(b.world).distanceTo(camPos));
  for (const e of planes) if (renderPlanar(renderer, scene, camera, W, H, e)) break;
  if (!sphereList.length) return () => {};
  // meshes take the environment of the sphere probe that influences them most
  const swapped: [Mesh, Material | Material[]][] = [];
  scene.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.visible || !m.geometry) return;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    sphereTmp.copy(m.geometry.boundingSphere!).applyMatrix4(m.matrixWorld);
    let best: (typeof sphereList)[number] | null = null,
      bw = 0.5;
    for (const s of sphereList) {
      const w = sphereInfluence(s.e.probe, s.inv, sphereTmp.center);
      if (w > bw) {
        bw = w;
        best = s;
      }
    }
    if (!best) return;
    const b = best;
    const apply = (base: Material) => {
      if (!(base as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) return base;
      const v = probeVariant(base, b.e.id, b.env);
      const p = b.e.probe;
      const center = new Vector3().setFromMatrixPosition(b.e.world);
      const r = p.use_custom_parallax ? Math.max(1e-4, p.parallax_distance ?? p.influence_distance) : Math.max(1e-4, p.influence_distance);
      const shape = p.use_custom_parallax ? p.parallax_type : p.influence_type;
      v.uniforms.ndPx.value.set(center.x, center.y, center.z, shape === 'BOX' ? 2 : 1);
      v.uniforms.ndPxMi.value.copy(b.e.world).multiply(new Matrix4().makeScale(r, r, r));
      v.uniforms.ndPxM.value.copy(v.uniforms.ndPxMi.value).invert();
      return v.mat;
    };
    swapped.push([m, m.material]);
    m.material = Array.isArray(m.material) ? m.material.map(apply) : apply(m.material);
  });
  return () => {
    for (const [m, mat] of swapped) m.material = mat;
  };
}

/** Probes in the scene that use realtime captures (for status / tests). */
export function probeCacheInfo() {
  return { spheres: [...spheres.keys()], volumes: [...grids.keys()] };
}

/** Drop GPU data of probes no longer in any document (e.g. after a file load). */
export function pruneProbeCaches(keep: Set<string>) {
  for (const id of [...spheres.keys(), ...grids.keys()]) if (!keep.has(id)) freeProbeCache(id);
}
