// Viewport display of volume grids (volume objects and geometry nodes output): the density is
// ray-marched inside the grid box in Solid and Material Preview shading. Solid shading shows grey
// smoke lit by a head light; Material Preview uses the object's volume shader (scattering colour,
// absorption, emission, blackbody). Viewport Display settings: density, interpolation and slicing.
import { BackSide, BoxGeometry, Color, Data3DTexture, FrontSide, LinearFilter, Matrix3, Matrix4, Mesh, NearestFilter, RGBAFormat, ShaderMaterial, UnsignedByteType, Vector3, Vector4 } from 'three';
import { app } from '../app/app';
import { sceneSyncHooks, type SyncedObject } from '../render/scene';
import { drawHooks } from '../editors/view3d/draw';
import type { DocumentData, ObjectData } from '../data/types';
import { packVolume, uvwToObject, type PackedVolume } from './pack';
import { objectVolumeShader } from './look';
import { defaultVolumeShader, type VolumeShader } from './shader';
import { volumeOf } from './data';
import type { VolumeGrid } from './types';

export const VOLUME_MARCH_GLSL = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uTex;
uniform vec3 uTexSize;
uniform vec4 uScale;
uniform int uCubic;
// cubic B-spline filtering from 8 linear fetches
vec4 ndVolTex( vec3 uvw ) {
  if ( uCubic == 0 ) return texture( uTex, uvw );
  vec3 coord = uvw * uTexSize - 0.5;
  vec3 f = fract( coord );
  vec3 i = coord - f;
  vec3 f2 = f * f, f3 = f2 * f;
  vec3 w0 = ( 1.0 - 3.0 * f + 3.0 * f2 - f3 ) / 6.0;
  vec3 w1 = ( 4.0 - 6.0 * f2 + 3.0 * f3 ) / 6.0;
  vec3 w2 = ( 1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3 ) / 6.0;
  vec3 w3 = f3 / 6.0;
  vec3 g0 = w0 + w1, g1 = w2 + w3;
  vec3 h0 = ( i - 1.0 + w1 / g0 + 0.5 ) / uTexSize;
  vec3 h1 = ( i + 1.0 + w3 / g1 + 0.5 ) / uTexSize;
  vec4 a = mix( texture( uTex, vec3( h1.x, h0.y, h0.z ) ), texture( uTex, vec3( h0.x, h0.y, h0.z ) ), g0.x );
  vec4 b = mix( texture( uTex, vec3( h1.x, h1.y, h0.z ) ), texture( uTex, vec3( h0.x, h1.y, h0.z ) ), g0.x );
  vec4 c = mix( texture( uTex, vec3( h1.x, h0.y, h1.z ) ), texture( uTex, vec3( h0.x, h0.y, h1.z ) ), g0.x );
  vec4 d = mix( texture( uTex, vec3( h1.x, h1.y, h1.z ) ), texture( uTex, vec3( h0.x, h1.y, h1.z ) ), g0.x );
  return mix( mix( d, c, g0.y ), mix( b, a, g0.y ), g0.z );
}
// density, emission and temperature values at a texture coordinate
vec3 ndVolSample( vec3 uvw ) {
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) return vec3( 0.0 );
  return ndVolTex( uvw ).rgb * uScale.rgb;
}
`;

const FRAG = /* glsl */ `
${VOLUME_MARCH_GLSL}
uniform vec3 uCam;
uniform vec3 uLight;
uniform vec3 uScatter, uAbsorb, uEmission, uTint;
uniform float uDensity, uSteps, uBlackbody, uTempScale, uTempConst, uLit;
uniform vec4 uSlice; // axis (0..2, -1 off), depth, -, -
uniform mat3 uUvwToWorld;
uniform vec3 uAmbient;
varying vec3 vUvw;

vec3 ndBlackbody( float t );

vec3 emissionAt( vec3 s ) {
  vec3 e = uEmission * ( uEmission.r + uEmission.g + uEmission.b > 0.0 && uScale.g > 0.0 ? s.g : 1.0 );
  if ( uBlackbody > 0.0 ) {
    float T = uTempConst > 0.0 ? uTempConst : s.b * uTempScale;
    if ( T > 400.0 ) e += uTint * ndBlackbody( T ) * uBlackbody * pow( T / 1000.0, 4.0 ) * 1.8;
  }
  return e;
}

vec3 ndBlackbody( float t ) {
  // smooth fit of a black body's normalised colour (800–12000 K)
  float x = clamp( ( t - 800.0 ) / 5700.0, 0.0, 1.0 );
  return clamp( vec3( 1.0, 0.18 + 0.82 * pow( x, 0.55 ), 0.02 + 0.98 * pow( x, 1.4 ) ), 0.0, 1.0 );
}

float shadow( vec3 p, float stepLen ) {
  if ( uLit < 0.5 ) return 1.0;
  float od = 0.0;
  for ( int i = 1; i <= 6; i ++ ) od += ndVolSample( p + uLight * stepLen * 2.0 * float( i ) ).r;
  return exp( - od * uDensity * stepLen * 2.0 * length( uUvwToWorld * uLight ) );
}

void main() {
  vec3 dir = normalize( vUvw - uCam );
  vec3 inv = 1.0 / dir;
  vec3 t0 = ( vec3( 0.0 ) - uCam ) * inv, t1 = ( vec3( 1.0 ) - uCam ) * inv;
  vec3 tmin = min( t0, t1 ), tmax = max( t0, t1 );
  float a = max( max( max( tmin.x, tmin.y ), tmin.z ), 0.0 );
  float b = min( min( tmax.x, tmax.y ), tmax.z );
  if ( a >= b ) discard;
  float worldPerUnit = length( uUvwToWorld * dir );
  vec3 ext = uScatter + uAbsorb;
  float extAvg = max( ( ext.r + ext.g + ext.b ) / 3.0, 1e-4 );
  if ( uSlice.x >= 0.0 ) {
    // a single slice through the grid
    int ax = int( uSlice.x );
    float c = ax == 0 ? uCam.x : ax == 1 ? uCam.y : uCam.z;
    float d = ax == 0 ? dir.x : ax == 1 ? dir.y : dir.z;
    if ( abs( d ) < 1e-6 ) discard;
    float t = ( uSlice.y - c ) / d;
    if ( t < a || t > b ) discard;
    vec3 s = ndVolSample( uCam + dir * t );
    float alpha = 1.0 - exp( - s.r * uDensity * extAvg * 2.0 );
    vec3 col = ( uLit > 0.5 ? uScatter / extAvg : vec3( 0.8 ) ) * alpha + emissionAt( s ) * 0.1;
    gl_FragColor = vec4( col, alpha );
    return;
  }
  float stepLen = ( b - a ) / uSteps;
  stepLen = max( stepLen, 1.0 / 2048.0 );
  float jitter = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
  vec3 T = vec3( 1.0 );
  vec3 col = vec3( 0.0 );
  float dt = stepLen * worldPerUnit;
  for ( int i = 0; i < 1024; i ++ ) {
    float t = a + ( float( i ) + jitter ) * stepLen;
    if ( t > b || float( i ) > uSteps * 1.5 ) break;
    vec3 p = uCam + dir * t;
    vec3 s = ndVolSample( p );
    float dens = s.r * uDensity;
    vec3 sigT = dens * ext;
    vec3 trans = exp( - sigT * dt );
    // in-scattered light: head light (shadowed) plus ambient
    vec3 albedo = uScatter / max( ext, vec3( 1e-4 ) );
    vec3 L = albedo * ( uAmbient + vec3( 1.0 ) * shadow( p, stepLen ) );
    col += T * ( L * ( 1.0 - trans ) + emissionAt( s ) * dt );
    T *= trans;
    if ( max( T.r, max( T.g, T.b ) ) < 0.004 ) break;
  }
  float alpha = 1.0 - ( T.r + T.g + T.b ) / 3.0;
  gl_FragColor = vec4( col, alpha );
}`;

const VERT = /* glsl */ `
varying vec3 vUvw;
void main() {
  vUvw = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

function marchMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    uniforms: {
      uTex: { value: null },
      uTexSize: { value: new Vector3(1, 1, 1) },
      uScale: { value: new Vector4(1, 1, 1, 1) },
      uCubic: { value: 0 },
      uCam: { value: new Vector3() },
      uLight: { value: new Vector3(0, 0, 1) },
      uScatter: { value: new Color(0.5, 0.5, 0.5) },
      uAbsorb: { value: new Color(0.5, 0.5, 0.5) },
      uEmission: { value: new Color(0, 0, 0) },
      uTint: { value: new Color(1, 1, 1) },
      uDensity: { value: 1 },
      uSteps: { value: 96 },
      uBlackbody: { value: 0 },
      uTempScale: { value: 1 },
      uTempConst: { value: 0 },
      uLit: { value: 1 },
      uSlice: { value: new Vector4(-1, 0.5, 0, 0) },
      uUvwToWorld: { value: new Matrix3() },
      uAmbient: { value: new Color(0.35, 0.35, 0.38) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}

/** A Data3DTexture holding a packed volume (RGBA8). */
export function volumeTexture(p: PackedVolume, interpolation: 'LINEAR' | 'CUBIC' | 'CLOSEST' = 'LINEAR'): Data3DTexture {
  const tex = new Data3DTexture(p.data, p.dims[0], p.dims[1], p.dims[2]);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = tex.magFilter = interpolation === 'CLOSEST' ? NearestFilter : LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

interface Entry {
  mesh: Mesh;
  mat: ShaderMaterial;
  tex: Data3DTexture | null;
  packed: PackedVolume | null;
  grids: VolumeGrid[] | null;
  shader: VolumeShader | null;
  interp: string;
  so: SyncedObject | null;
}

const entries = new Map<string, Entry>();

function dispose(id: string, e: Entry) {
  e.mesh.removeFromParent();
  e.mesh.geometry.dispose();
  e.mat.dispose();
  e.tex?.dispose();
  entries.delete(id);
}

/** Display settings of the volume an object shows (volume objects have their own). */
function displayOf(doc: DocumentData, ob: ObjectData) {
  return volumeOf(doc, ob)?.display ?? null;
}

let lastRevision = -1;
sceneSyncHooks.push((doc, ev, so) => {
  if (lastRevision !== app.revision) {
    lastRevision = app.revision;
    for (const [id, e] of entries) if (!app.graph.get(id)?.mesh?.volume?.length) dispose(id, e);
  }
  const grids = ev.mesh?.volume;
  if (!grids?.length) return;
  let e = entries.get(ev.id);
  if (!e) {
    const mat = marchMaterial();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5), mat);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 4;
    mesh.userData.volumeOf = ev.id;
    e = { mesh, mat, tex: null, packed: null, grids: null, shader: null, interp: '', so: null };
    entries.set(ev.id, e);
  }
  e.so = so;
  if (e.mesh.parent !== so.root) so.root.add(e.mesh);
  const shader = objectVolumeShader(doc, ev.ob) ?? defaultVolumeShader();
  const interp = displayOf(doc, ev.ob)?.interpolation_method ?? 'LINEAR';
  if (e.grids !== grids || e.shader?.densityGrid !== shader.densityGrid || e.shader?.emissionGrid !== shader.emissionGrid || e.shader?.temperatureGrid !== shader.temperatureGrid || e.interp !== interp) {
    const packed = packVolume(grids, shader);
    e.tex?.dispose();
    e.tex = packed ? volumeTexture(packed, interp) : null;
    e.packed = packed;
    e.grids = grids;
    e.interp = interp;
    if (packed) e.mesh.matrix.fromArray(uvwToObject(packed));
  }
  e.shader = shader;
});

function updateUniforms(e: Entry, ob: ObjectData, material: boolean) {
  const u = e.mat.uniforms;
  const p = e.packed!;
  const doc = app.doc;
  const disp = displayOf(doc, ob);
  const s = material ? (e.shader ?? defaultVolumeShader()) : defaultVolumeShader();
  u.uTex.value = e.tex;
  u.uTexSize.value.set(p.dims[0], p.dims[1], p.dims[2]);
  (u.uScale.value as Vector4).set(p.scale[0], p.scale[1], p.scale[2], 1);
  u.uCubic.value = disp?.interpolation_method === 'CUBIC' ? 1 : 0;
  u.uDensity.value = (disp?.density ?? 1) * s.densityScale;
  u.uScatter.value.setRGB(...s.scatter);
  u.uAbsorb.value.setRGB(...s.absorb);
  u.uEmission.value.setRGB(...(material ? s.emission : ([0, 0, 0] as [number, number, number])));
  u.uBlackbody.value = material ? s.blackbodyIntensity : 0;
  u.uTint.value.setRGB(...s.blackbodyTint);
  const tempGrid = !!s.temperatureGrid && p.scale[2] > 0;
  u.uTempScale.value = tempGrid ? s.temperature : 0;
  u.uTempConst.value = tempGrid ? 0 : s.temperature;
  u.uLit.value = 1;
  const steps = Math.max(24, Math.min(256, Math.round(Math.max(...p.dims) * 1.2)));
  u.uSteps.value = steps;
}

drawHooks.passes.push((pass, view, camera) => {
  if (!entries.size) return;
  const restore: (() => void)[] = [];
  const sh = view.shading;
  const show = pass === 'SCENE' && (sh.type === 'SOLID' || sh.type === 'MATERIAL');
  for (const [id, e] of entries) {
    const v = e.mesh.visible;
    restore.push(() => (e.mesh.visible = v));
    const ev = app.graph.get(id);
    // the wire's corner points are not drawn (except for the Points wireframe)
    const pts = e.so?.points;
    if (pts && pass !== 'SCENE' && displayOf(app.doc, ev?.ob ?? ({} as ObjectData))?.wireframe_type !== 'POINTS' && ev?.mesh?.looseEdges?.length) {
      const pv = pts.visible;
      pts.visible = false;
      restore.push(() => (pts.visible = pv));
    }
    if (!show || !ev || !e.packed || !e.tex) {
      e.mesh.visible = false;
      continue;
    }
    const ob = ev.ob;
    e.mesh.visible = ev.visible && ob.display_type !== 'WIRE' && ob.display_type !== 'BOUNDS';
    if (!e.mesh.visible) continue;
    updateUniforms(e, ob, sh.type === 'MATERIAL');
    const disp = displayOf(app.doc, ob);
    const mesh = e.mesh;
    mesh.onBeforeRender = (_r, _s, cam) => {
      const u = e.mat.uniforms;
      const inv = mesh.matrixWorld.clone().invert();
      const camPos = new Vector3().setFromMatrixPosition(cam.matrixWorld);
      const c = camPos.clone().applyMatrix4(inv);
      u.uCam.value.copy(c);
      // head light from the upper left of the view, in texture space
      const ld = new Vector3(-0.35, 0.55, 1).normalize().transformDirection(cam.matrixWorld);
      const l3 = new Matrix4().copy(inv);
      l3.setPosition(0, 0, 0);
      (u.uLight.value as Vector3).copy(ld.applyMatrix4(l3).normalize());
      (u.uUvwToWorld.value as Matrix3).setFromMatrix4(mesh.matrixWorld);
      const inside = c.x > 0 && c.x < 1 && c.y > 0 && c.y < 1 && c.z > 0 && c.z < 1;
      e.mat.side = inside ? BackSide : FrontSide;
      e.mat.depthTest = !inside;
      // slicing: a plane across the chosen (or most view-facing) axis
      if (disp?.use_slice) {
        let axis = disp.slice_axis === 'X' ? 0 : disp.slice_axis === 'Y' ? 1 : disp.slice_axis === 'Z' ? 2 : -1;
        if (axis < 0) {
          const vd = new Vector3(0, 0, -1).transformDirection(cam.matrixWorld).applyMatrix4(l3);
          const a = [Math.abs(vd.x), Math.abs(vd.y), Math.abs(vd.z)];
          axis = a.indexOf(Math.max(...a));
        }
        (u.uSlice.value as Vector4).set(axis, disp.slice_depth, 0, 0);
      } else (u.uSlice.value as Vector4).set(-1, 0.5, 0, 0);
    };
  }
  void camera;
  return () => restore.forEach((f) => f());
});

/** Objects whose volume is displayed (for tests). */
export function displayedVolumes(): string[] {
  return [...entries.keys()].filter((id) => !!entries.get(id)?.packed);
}
