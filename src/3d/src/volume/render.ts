// Volumes in the render engines.
//  - Realtime engine: the packed grids are ray-marched inside their box and lit by the scene
//    lights (Henyey–Greenstein phase, self-shadowing with Render ▸ Volume Shadows), with
//    emission and blackbody light from the object's volume shader.
//  - Path tracer: every volume (volume objects, geometry nodes grids, smoke domains) gets a box
//    mesh with a fog material that tags its index, and its packed data is handed to the volume
//    tracking code in src/render/final/ptvolume.ts, together with the world volume.
import { BackSide, BoxGeometry, Color, FrontSide, Matrix3, Matrix4, Mesh, ShaderMaterial, UniformsLib, UniformsUtils, Vector3, Vector4, type Data3DTexture } from 'three';
import { FogVolumeMaterial } from 'three-gpu-pathtracer';
import { renderSceneHooks, renderVisibleObjects, type RenderScene } from '../render/final/renderscene';
import { ptVolumeSets, MAX_VOLUMES, type PtVolume, type PtWorldVolume } from '../render/final/ptvolume';
import { fxUniforms, volumeFactorUniforms } from '../render/realtime/fxshader';
import { smokeDraw, type SmokeDraw } from '../physics/fluid';
import type { App } from '../app/app';
import type { DocumentData } from '../data/types';
import { packVolume, uvwToObject, type PackedVolume } from './pack';
import { objectVolumeShader } from './look';
import { emptyVolumeShader, volumeShaderOfTree, type VolumeShader } from './shader';
import { volumeOf } from './data';
import { VOLUME_MARCH_GLSL, volumeTexture } from './display';
import { gridsSignature } from './eval';

/** One renderable volume: packed data, shading and placement. */
interface Source {
  key: string;
  objectId: string;
  packed: PackedVolume;
  shader: VolumeShader;
  /** object world matrix × texture-space box */
  matrix: Matrix4;
  clipping: number;
  stepSize: number;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object) => {
  let i = ids.get(o);
  if (!i) ids.set(o, (i = nextId++));
  return i;
};

/** Smoke / fire of a fluid domain as a packed volume (density in R, flame in G). */
const smokeCache = new WeakMap<SmokeDraw, PackedVolume>();
function packSmoke(d: SmokeDraw): PackedVolume {
  let p = smokeCache.get(d);
  if (p) return p;
  const n = d.nx * d.ny * d.nz;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = d.data[i * 2];
    data[i * 4 + 1] = d.data[i * 2 + 1];
  }
  const vs = [(d.bmax[0] - d.bmin[0]) / d.nx, (d.bmax[1] - d.bmin[1]) / d.ny, (d.bmax[2] - d.bmin[2]) / d.nz];
  p = {
    dims: [d.nx, d.ny, d.nz],
    transform: [vs[0], 0, 0, 0, 0, vs[1], 0, 0, 0, 0, vs[2], 0, d.bmin[0] + vs[0] / 2, d.bmin[1] + vs[1] / 2, d.bmin[2] + vs[2] / 2, 1],
    data,
    scale: [1, 1, 0],
    maxDensity: 1,
  };
  smokeCache.set(d, p);
  return p;
}

/** The look of smoke without a volume material: coloured smoke and orange fire from the flame grid. */
function smokeShader(d: SmokeDraw): VolumeShader {
  const s = emptyVolumeShader();
  s.densityScale = 12 * d.thickness;
  s.densityGrid = 'density';
  s.scatter = [...d.color] as [number, number, number];
  s.absorb = d.color.map((c) => Math.max(0.05, 1 - c) * 0.6) as [number, number, number];
  if (d.fire) {
    s.emission = [6, 1.6, 0.25];
    s.emissionGrid = 'flame';
  }
  return s;
}

/** Every volume to render (visible according to the build options). */
function collect(app: App, visible: (id: string) => boolean): Source[] {
  const doc = app.doc;
  const out: Source[] = [];
  for (const ev of app.graph.objects.values()) {
    const grids = ev.mesh?.volume;
    if (!grids?.length || !visible(ev.id)) continue;
    const shader = objectVolumeShader(doc, ev.ob);
    if (!shader) continue;
    const packed = packVolume(grids, shader, 160 ** 3);
    if (!packed) continue;
    const vo = volumeOf(doc, ev.ob);
    out.push({
      key: `${ev.id}|${gridsSignature(grids)}|${idOf(packed)}`,
      objectId: ev.id,
      packed,
      shader,
      matrix: ev.world.clone().multiply(new Matrix4().fromArray(uvwToObject(packed))),
      clipping: vo?.render.clipping ?? 0,
      stepSize: vo?.render.step_size ?? 0,
    });
  }
  const domains = new Set<string>();
  for (const [k, d] of smokeDraw) {
    const ev = app.graph.get(d.objectId);
    if (!ev || !visible(d.objectId) || domains.has(d.objectId)) continue;
    domains.add(d.objectId);
    const packed = packSmoke(d);
    // a volume material on the domain takes over the default smoke look
    const own = objectVolumeShader(doc, ev.ob);
    const hasMaterial = !!ev.ob.data && (doc.meshes[ev.ob.data]?.materials ?? []).some((m) => !!m);
    const shader = hasMaterial && own ? { ...own, densityGrid: 'density', emissionGrid: own.emissionGrid ? 'flame' : own.emissionGrid } : smokeShader(d);
    out.push({ key: `${k}|${idOf(d)}`, objectId: d.objectId, packed, shader, matrix: ev.world.clone().multiply(new Matrix4().fromArray(uvwToObject(packed))), clipping: 0, stepSize: 0 });
  }
  return out;
}

/** Homogeneous world volume (constant inputs of the world's Volume output). */
export function worldVolumeOf(doc: DocumentData): PtWorldVolume | null {
  const w = doc.scene.world ? doc.worlds[doc.scene.world] : null;
  if (!w || w.use_nodes === false) return null;
  const s = volumeShaderOfTree(w.tree, 'ShaderNodeOutputWorld');
  if (!s || s.densityScale <= 0) return null;
  const k = s.densityScale;
  return { scatter: s.scatter.map((x) => x * k) as [number, number, number], absorb: s.absorb.map((x) => x * k) as [number, number, number], emission: s.emission, anisotropy: s.anisotropy };
}

// ---------------------------------------------------------------------------
// Realtime engine

const FRAG = /* glsl */ `
${VOLUME_MARCH_GLSL}
#include <common>
#include <lights_pars_begin>
uniform vec3 uCam, uScatter, uAbsorb, uEmission, uTint, uAmbient;
uniform float uDensity, uSteps, uShadow, uBlackbody, uTempScale, uTempConst, uG, uEmitGrid, uClip;
uniform mat4 uLocalToView, uViewToLocal;
uniform mat3 uUvwToWorld;
uniform vec4 ndFx;
#if NUM_POINT_LIGHTS > 0
uniform float ndLvPoint[ NUM_POINT_LIGHTS ];
#endif
#if NUM_SPOT_LIGHTS > 0
uniform float ndLvSpot[ NUM_SPOT_LIGHTS ];
#endif
#if NUM_DIR_LIGHTS > 0
uniform float ndLvDir[ NUM_DIR_LIGHTS ];
#endif
varying vec3 vUvw;

float hg( float c ) {
  float d = 1.0 + uG * uG - 2.0 * uG * c;
  return ( 1.0 - uG * uG ) / ( 4.0 * PI * d * sqrt( max( d, 1e-6 ) ) );
}

float densityAt( vec3 p ) { return ndVolSample( p ).r; }

vec3 shadowTo( vec3 p, vec3 dirLocal ) {
  if ( uShadow < 0.5 ) return vec3( 1.0 );
  float len = 1.0 / 8.0;
  float od = 0.0;
  for ( int i = 1; i <= 8; i ++ ) od += densityAt( p + dirLocal * len * float( i ) );
  return exp( - ( uScatter + uAbsorb ) * od * uDensity * len * length( uUvwToWorld * dirLocal ) );
}

vec3 bb( float t ) {
  float x = clamp( ( t - 800.0 ) / 5700.0, 0.0, 1.0 );
  return clamp( vec3( 1.0, 0.18 + 0.82 * pow( x, 0.55 ), 0.02 + 0.98 * pow( x, 1.4 ) ), 0.0, 1.0 );
}

vec3 lightAt( vec3 p, vec3 viewDirLocal ) {
  vec3 vp = ( uLocalToView * vec4( p, 1.0 ) ).xyz;
  vec3 vdir = normalize( ( uLocalToView * vec4( viewDirLocal, 0.0 ) ).xyz );
  vec3 sum = vec3( 0.0 );
  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    {
    vec3 ld = directionalLights[ i ].direction;
    vec3 ll = normalize( ( uViewToLocal * vec4( ld, 0.0 ) ).xyz );
    sum += directionalLights[ i ].color * ndLvDir[ i ] * hg( dot( vdir, ld ) ) * shadowTo( p, ll );
    }
  }
  #pragma unroll_loop_end
  #endif
  #if NUM_POINT_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
    {
    vec3 l = pointLights[ i ].position - vp;
    float d = length( l );
    float att = 1.0 / max( d * d, 1e-4 );
    if ( pointLights[ i ].distance > 0.0 ) att *= pow2( saturate( 1.0 - pow4( d / pointLights[ i ].distance ) ) );
    vec3 ld = l / max( d, 1e-6 );
    sum += pointLights[ i ].color * att * ndLvPoint[ i ] * hg( dot( vdir, ld ) ) * shadowTo( p, normalize( ( uViewToLocal * vec4( ld, 0.0 ) ).xyz ) );
    }
  }
  #pragma unroll_loop_end
  #endif
  #if NUM_SPOT_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
    {
    vec3 l = spotLights[ i ].position - vp;
    float d = length( l );
    vec3 ld = l / max( d, 1e-6 );
    float cone = smoothstep( spotLights[ i ].coneCos, spotLights[ i ].penumbraCos, dot( ld, spotLights[ i ].direction ) );
    sum += spotLights[ i ].color * cone / max( d * d, 1e-4 ) * ndLvSpot[ i ] * hg( dot( vdir, ld ) ) * shadowTo( p, normalize( ( uViewToLocal * vec4( ld, 0.0 ) ).xyz ) );
    }
  }
  #pragma unroll_loop_end
  #endif
  return sum + uAmbient;
}

void main() {
  vec3 dir = normalize( vUvw - uCam );
  vec3 inv = 1.0 / dir;
  vec3 t0 = ( vec3( 0.0 ) - uCam ) * inv, t1 = ( vec3( 1.0 ) - uCam ) * inv;
  vec3 tmin = min( t0, t1 ), tmax = max( t0, t1 );
  float a = max( max( max( tmin.x, tmin.y ), tmin.z ), 0.0 );
  float b = min( min( tmax.x, tmax.y ), tmax.z );
  if ( a >= b ) discard;
  float stepLen = max( ( b - a ) / uSteps, 1.0 / 2048.0 );
  float dt = stepLen * length( uUvwToWorld * dir );
  float jitter = fract( 52.9829189 * fract( dot( gl_FragCoord.xy + ndFx.y * vec2( 47.0, 17.0 ), vec2( 0.06711056, 0.00583715 ) ) ) );
  vec3 T = vec3( 1.0 ), col = vec3( 0.0 );
  vec3 ext = uScatter + uAbsorb;
  for ( int i = 0; i < 1024; i ++ ) {
    float t = a + ( float( i ) + jitter ) * stepLen;
    if ( t > b || float( i ) > uSteps * 1.5 ) break;
    vec3 p = uCam + dir * t;
    vec3 s = ndVolSample( p );
    float dens = s.r * uDensity;
    if ( s.r < uClip ) dens = 0.0;
    vec3 trans = exp( - ext * dens * dt );
    vec3 e = uEmission * ( uEmitGrid > 0.5 ? s.g : step( 1e-4, dens ) );
    if ( uBlackbody > 0.0 ) {
      float temp = uTempConst > 0.0 ? uTempConst : s.b * uTempScale;
      if ( temp > 400.0 ) e += uTint * bb( temp ) * uBlackbody * 1.805e-13 * temp * temp * temp * temp;
    }
    if ( dens > 0.0 ) col += T * ( uScatter / max( ext, vec3( 1e-5 ) ) ) * lightAt( p, - dir ) * ( 1.0 - trans );
    col += T * e * dt;
    T *= trans;
    if ( max( T.r, max( T.g, T.b ) ) < 0.004 ) break;
  }
  gl_FragColor = vec4( col, 1.0 - ( T.r + T.g + T.b ) / 3.0 );
}`;

const VERT = /* glsl */ `
varying vec3 vUvw;
void main() {
  vUvw = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

function rasterMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    lights: true,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.lights,
      {
        uTex: { value: null },
        uTexSize: { value: new Vector3(1, 1, 1) },
        uScale: { value: new Vector4(1, 1, 1, 1) },
        uCubic: { value: 0 },
        uCam: { value: new Vector3() },
        uScatter: { value: new Color() },
        uAbsorb: { value: new Color() },
        uEmission: { value: new Color() },
        uTint: { value: new Color(1, 1, 1) },
        uAmbient: { value: new Color() },
        uDensity: { value: 1 },
        uSteps: { value: 96 },
        uShadow: { value: 0 },
        uBlackbody: { value: 0 },
        uTempScale: { value: 0 },
        uTempConst: { value: 0 },
        uG: { value: 0 },
        uEmitGrid: { value: 0 },
        uClip: { value: 0 },
        uLocalToView: { value: new Matrix4() },
        uViewToLocal: { value: new Matrix4() },
        uUvwToWorld: { value: new Matrix3() },
      },
    ]),
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}

interface RasterEntry {
  mesh: Mesh;
  mat: ShaderMaterial;
  tex: Data3DTexture;
  packed: PackedVolume;
}

interface SceneState {
  raster: Map<string, RasterEntry>;
  fog: Mesh[];
}
const states = new WeakMap<RenderScene, SceneState>();

const unitBox = () => new BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);

function syncRaster(rs: RenderScene, app: App, sources: Source[], st: SceneState) {
  const doc = app.doc;
  const r = doc.scene.render;
  const steps = Math.max(16, Math.min(256, Math.round(r.volumetric_samples ?? 64) * 2));
  const world = doc.scene.world ? doc.worlds[doc.scene.world] : null;
  const ambient = new Color(...(world?.color ?? [0.05, 0.05, 0.05])).multiplyScalar(0.5);
  const seen = new Set<string>();
  for (const s of sources) {
    seen.add(s.objectId);
    let e = st.raster.get(s.objectId);
    if (e && e.packed !== s.packed) {
      e.tex.dispose();
      e.tex = volumeTexture(s.packed);
      e.packed = s.packed;
    }
    if (!e) {
      const mat = rasterMaterial();
      Object.assign(mat.uniforms, volumeFactorUniforms, { ndFx: fxUniforms.ndFx });
      const mesh = new Mesh(unitBox(), mat);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 5;
      mesh.castShadow = false;
      mesh.userData.noDepth = true;
      e = { mesh, mat, tex: volumeTexture(s.packed), packed: s.packed };
      st.raster.set(s.objectId, e);
      rs.scene.add(mesh);
    }
    const u = e.mat.uniforms;
    const sh = s.shader;
    u.uTex.value = e.tex;
    u.uTexSize.value.set(...s.packed.dims);
    (u.uScale.value as Vector4).set(s.packed.scale[0], s.packed.scale[1], s.packed.scale[2], 1);
    u.uScatter.value.setRGB(...sh.scatter);
    u.uAbsorb.value.setRGB(...sh.absorb);
    u.uEmission.value.setRGB(...sh.emission);
    u.uTint.value.setRGB(...sh.blackbodyTint);
    u.uAmbient.value.copy(ambient);
    u.uDensity.value = sh.densityScale;
    u.uSteps.value = steps;
    u.uShadow.value = r.use_volumetric_shadows ? 1 : 0;
    u.uBlackbody.value = sh.blackbodyIntensity;
    const tg = !!sh.temperatureGrid && s.packed.scale[2] > 0;
    u.uTempScale.value = tg ? sh.temperature : 0;
    u.uTempConst.value = tg ? 0 : sh.temperature;
    u.uG.value = sh.anisotropy;
    u.uEmitGrid.value = sh.emissionGrid && s.packed.scale[1] > 0 ? 1 : 0;
    u.uClip.value = s.packed.scale[0] > 0 ? s.clipping / s.packed.scale[0] : 0;
    e.mesh.matrix.copy(s.matrix);
    e.mesh.matrixWorld.copy(s.matrix);
    const mesh = e.mesh;
    mesh.onBeforeRender = (_r, _s, camera) => {
      const toView = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
      u.uLocalToView.value.copy(toView);
      u.uViewToLocal.value.copy(toView).invert();
      (u.uUvwToWorld.value as Matrix3).setFromMatrix4(mesh.matrixWorld);
      const cam = new Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(mesh.matrixWorld.clone().invert());
      u.uCam.value.copy(cam);
      const inside = cam.x > 0 && cam.x < 1 && cam.y > 0 && cam.y < 1 && cam.z > 0 && cam.z < 1;
      e!.mat.side = inside ? BackSide : FrontSide;
      e!.mat.depthTest = !inside;
    };
  }
  for (const [id, e] of st.raster)
    if (!seen.has(id)) {
      rs.scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mat.dispose();
      e.tex.dispose();
      st.raster.delete(id);
    }
}

function clearRaster(rs: RenderScene, st: SceneState) {
  for (const e of st.raster.values()) {
    rs.scene.remove(e.mesh);
    e.mesh.geometry.dispose();
    e.mat.dispose();
    e.tex.dispose();
  }
  st.raster.clear();
}

// ---------------------------------------------------------------------------
// Path tracer

let warned = false;

function syncPathTracer(rs: RenderScene, app: App, sources: Source[], st: SceneState) {
  const list = sources.slice(0, MAX_VOLUMES);
  // fog boxes: one per volume, tagged with its index
  while (st.fog.length > list.length) {
    const m = st.fog.pop()!;
    rs.scene.remove(m);
    (m.material as FogVolumeMaterial).dispose();
    rs.structureVersion++;
  }
  const volumes: PtVolume[] = [];
  list.forEach((s, i) => {
    let m = st.fog[i];
    if (!m) {
      const mat = new FogVolumeMaterial({ color: 0xffffff });
      // only the path tracer sees the box (not the raster preview shown while it compiles)
      mat.visible = false;
      mat.emissive.setRGB(0, 0, 0);
      m = new Mesh(unitBox(), mat);
      m.matrixAutoUpdate = false;
      m.userData.volumeBox = true;
      st.fog[i] = m;
      rs.scene.add(m);
      rs.structureVersion++;
    }
    const mat = m.material as FogVolumeMaterial & { density: number };
    mat.emissiveIntensity = -(i + 1);
    mat.density = 1;
    m.matrix.copy(s.matrix);
    m.matrixWorld.copy(s.matrix);
    const corner = new Vector3(1, 1, 1).applyMatrix4(s.matrix).sub(new Vector3(0, 0, 0).applyMatrix4(s.matrix));
    volumes.push({ key: s.key, packed: s.packed, shader: s.shader, worldToUvw: s.matrix.clone().invert(), diagonal: corner.length(), clipping: s.clipping });
  });
  if (sources.length > MAX_VOLUMES && !warned) {
    warned = true;
    app.report('WARNING', `Only the first ${MAX_VOLUMES} volumes are path traced`);
  }
  const world = worldVolumeOf(app.doc);
  const key = volumes.map((v) => `${v.key}|${v.worldToUvw.elements.map((x) => x.toFixed(5)).join(',')}|${JSON.stringify(v.shader)}`).join(';');
  ptVolumeSets.set(rs.scene, { volumes, world, key });
}

function clearPathTracer(rs: RenderScene, st: SceneState) {
  for (const m of st.fog) {
    rs.scene.remove(m);
    (m.material as FogVolumeMaterial).dispose();
    rs.structureVersion++;
  }
  st.fog = [];
  ptVolumeSets.delete(rs.scene);
}

renderSceneHooks.push((rs, app, o) => {
  let st = states.get(rs);
  if (!st) states.set(rs, (st = { raster: new Map(), fog: [] }));
  const renderable = o.final ? renderVisibleObjects(app.doc) : null;
  const visible = (id: string) => {
    const ev = app.graph.get(id);
    if (!ev) return false;
    return renderable ? renderable.has(id) : ev.visible && !ev.ob.hide_render && (!o.localView || o.localView.has(id));
  };
  const sources = o.hideSurfaces ? [] : collect(app, visible);
  if (o.mode === 'raster') {
    clearPathTracer(rs, st);
    // smoke domains are drawn by the realtime engine's own smoke pass
    syncRaster(
      rs,
      app,
      sources.filter((s) => ![...smokeDraw.values()].some((d) => d.objectId === s.objectId)),
      st,
    );
  } else {
    clearRaster(rs, st);
    syncPathTracer(rs, app, sources, st);
    // smoke domain objects show only their smoke
    const domains = new Set([...smokeDraw.values()].map((d) => d.objectId));
    for (const c of rs.scene.children) if (c.userData.id && domains.has(c.userData.id as string) && (c as Mesh).isMesh) c.visible = false;
  }
});


