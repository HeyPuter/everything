// Smoke and fire of fluid domains in the realtime engine: the density grid is ray-marched inside
// the domain box and lit by the scene's lights (each scaled by its Volume Scatter factor), with
// optional self-shadowing (Render ▸ Sampling ▸ Shadows ▸ Volume Shadows). The domain object's own
// surface is not rendered.
import { BackSide, BoxGeometry, Color, Data3DTexture, FrontSide, LinearFilter, Matrix4, Mesh, RGFormat, ShaderMaterial, UniformsLib, UniformsUtils, UnsignedByteType, Vector3, type Scene } from 'three';
import { renderSceneHooks, type RenderScene } from '../final/renderscene';
import { smokeDraw, type SmokeDraw } from '../../physics/fluid';
import { fxUniforms, volumeFactorUniforms } from './fxshader';

const FRAG = /* glsl */ `
precision highp sampler3D;
#include <common>
#include <lights_pars_begin>
uniform sampler3D uTex;
uniform vec3 uCam, uBMin, uBMax, uColor, uAmbient;
uniform float uDensity, uFire, uSteps, uShadow;
uniform mat4 uLocalToView;
uniform mat4 uViewToLocal;
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
varying vec3 vLocal;

float densityAt( vec3 p ) {
  vec3 uvw = ( p - uBMin ) / ( uBMax - uBMin );
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) return 0.0;
  return texture( uTex, uvw ).r;
}

// transmittance from a local point towards a light direction (local space)
float shadowTo( vec3 p, vec3 dirLocal ) {
  if ( uShadow < 0.5 ) return 1.0;
  float len = length( uBMax - uBMin ) / 8.0;
  float od = 0.0;
  for ( int i = 1; i <= 8; i ++ ) od += densityAt( p + dirLocal * len * float( i ) ) * uDensity * len;
  return exp( - od );
}

vec3 lightAt( vec3 p ) {
  vec3 vp = ( uLocalToView * vec4( p, 1.0 ) ).xyz;
  vec3 sum = vec3( 0.0 );
  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    vec3 ld = normalize( ( uViewToLocal * vec4( directionalLights[ i ].direction, 0.0 ) ).xyz );
    sum += directionalLights[ i ].color * ndLvDir[ i ] * shadowTo( p, ld );
  }
  #pragma unroll_loop_end
  #endif
  #if NUM_POINT_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
    vec3 l = pointLights[ i ].position - vp;
    float d = length( l );
    float att = 1.0 / max( d * d, 1e-4 );
    if ( pointLights[ i ].distance > 0.0 ) att *= pow2( saturate( 1.0 - pow4( d / pointLights[ i ].distance ) ) );
    vec3 ld = normalize( ( uViewToLocal * vec4( l, 0.0 ) ).xyz );
    sum += pointLights[ i ].color * att * ndLvPoint[ i ] * shadowTo( p, ld );
  }
  #pragma unroll_loop_end
  #endif
  #if NUM_SPOT_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
    vec3 l = spotLights[ i ].position - vp;
    float d = length( l );
    float c = dot( normalize( l ), spotLights[ i ].direction );
    float cone = smoothstep( spotLights[ i ].coneCos, spotLights[ i ].penumbraCos, c );
    vec3 ld = normalize( ( uViewToLocal * vec4( l, 0.0 ) ).xyz );
    sum += spotLights[ i ].color * cone / max( d * d, 1e-4 ) * ndLvSpot[ i ] * shadowTo( p, ld );
  }
  #pragma unroll_loop_end
  #endif
  // scattering of a dense volume behaves close to a diffuse surface
  return sum * RECIPROCAL_PI + uAmbient;
}

void main() {
  vec3 dir = normalize( vLocal - uCam );
  vec3 inv = 1.0 / dir;
  vec3 t0 = ( uBMin - uCam ) * inv, t1 = ( uBMax - uCam ) * inv;
  vec3 tmin = min( t0, t1 ), tmax = max( t0, t1 );
  float a = max( max( max( tmin.x, tmin.y ), tmin.z ), 0.0 );
  float b = min( min( tmax.x, tmax.y ), tmax.z );
  if ( a >= b ) discard;
  float stepLen = length( uBMax - uBMin ) / uSteps;
  float T = 1.0;
  vec3 col = vec3( 0.0 );
  float jitter = fract( 52.9829189 * fract( dot( gl_FragCoord.xy + ndFx.y * vec2( 47.0, 17.0 ), vec2( 0.06711056, 0.00583715 ) ) ) );
  for ( int i = 0; i < 512; i ++ ) {
    float t = a + ( float( i ) + jitter ) * stepLen;
    if ( float( i ) >= uSteps * 2.0 || t > b || T < 0.005 ) break;
    vec3 p = uCam + dir * t;
    vec3 uvw = ( p - uBMin ) / ( uBMax - uBMin );
    vec2 s = texture( uTex, uvw ).rg;
    float alpha = 1.0 - exp( - s.r * uDensity * stepLen );
    if ( alpha > 1e-4 ) col += T * alpha * uColor * lightAt( p );
    float e = s.g * uFire;
    col += T * vec3( 1.0, 0.18 + 0.6 * e * e, 0.02 + 0.25 * e * e * e ) * e * stepLen * 14.0;
    T *= 1.0 - alpha;
  }
  gl_FragColor = vec4( col, 1.0 - T );
}`;

const VERT = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

function volumeMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    lights: true,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    uniforms: UniformsUtils.merge([
      UniformsLib.lights,
      {
        uTex: { value: null },
        uCam: { value: new Vector3() },
        uBMin: { value: new Vector3() },
        uBMax: { value: new Vector3() },
        uColor: { value: new Color() },
        uAmbient: { value: new Color() },
        uDensity: { value: 1 },
        uFire: { value: 1 },
        uSteps: { value: 64 },
        uShadow: { value: 0 },
        uLocalToView: { value: new Matrix4() },
        uViewToLocal: { value: new Matrix4() },
      },
    ]),
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}

interface VolumeObject {
  data: SmokeDraw;
  mesh: Mesh;
  tex: Data3DTexture;
  mat: ShaderMaterial;
}

function sync(rs: RenderScene, scene: Scene, steps: number, shadow: boolean, ambient: Color, visible: (id: string) => boolean) {
  const cache: Map<string, VolumeObject> = (scene.userData.smoke ??= new Map());
  const seen = new Set<string>();
  for (const [key, d] of smokeDraw) {
    if (!visible(d.objectId)) continue;
    seen.add(key);
    let v = cache.get(key);
    if (v && (v.data.nx !== d.nx || v.data.ny !== d.ny || v.data.nz !== d.nz)) {
      scene.remove(v.mesh);
      v.tex.dispose();
      v.mesh.geometry.dispose();
      v.mat.dispose();
      cache.delete(key);
      v = undefined;
    }
    if (!v) {
      const tex = new Data3DTexture(d.data, d.nx, d.ny, d.nz);
      tex.format = RGFormat;
      tex.type = UnsignedByteType;
      tex.minFilter = tex.magFilter = LinearFilter;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      const mat = volumeMaterial();
      Object.assign(mat.uniforms, volumeFactorUniforms, { ndFx: fxUniforms.ndFx });
      const mesh = new Mesh(new BoxGeometry(1, 1, 1), mat);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 5;
      mesh.castShadow = false;
      mesh.userData.smokeOf = d.objectId;
      v = { data: d, mesh, tex, mat };
      cache.set(key, v);
      scene.add(mesh);
    } else if (v.data !== d) {
      v.tex.image.data = d.data;
      v.tex.needsUpdate = true;
      v.data = d;
    }
    const u = v.mat.uniforms;
    u.uTex.value = v.tex;
    u.uBMin.value.set(...d.bmin);
    u.uBMax.value.set(...d.bmax);
    u.uColor.value.setRGB(...d.color);
    u.uFire.value = d.fire ? 1 : 0;
    u.uSteps.value = steps;
    u.uShadow.value = shadow ? 1 : 0;
    u.uAmbient.value.copy(ambient);
    // the box spans the grid bounds in the domain's local space
    const size = new Vector3(d.bmax[0] - d.bmin[0], d.bmax[1] - d.bmin[1], d.bmax[2] - d.bmin[2]);
    const center = new Vector3((d.bmin[0] + d.bmax[0]) / 2, (d.bmin[1] + d.bmax[1]) / 2, (d.bmin[2] + d.bmax[2]) / 2);
    v.mesh.geometry.dispose();
    v.mesh.geometry = new BoxGeometry(size.x, size.y, size.z).translate(center.x, center.y, center.z);
  }
  for (const [key, v] of cache)
    if (!seen.has(key)) {
      scene.remove(v.mesh);
      v.tex.dispose();
      v.mesh.geometry.dispose();
      v.mat.dispose();
      cache.delete(key);
    }
}

renderSceneHooks.push((rs, app, o) => {
  if (o.mode !== 'raster') return;
  const doc = app.doc;
  const r = doc.scene.render;
  const steps = Math.max(1, Math.min(256, Math.round(r.volumetric_samples ?? 64)));
  const world = doc.scene.world ? doc.worlds[doc.scene.world] : null;
  const ambient = new Color(...(world?.color ?? [0.05, 0.05, 0.05])).multiplyScalar(0.5);
  const domains = new Set([...smokeDraw.values()].map((d) => d.objectId));
  const visible = (id: string) => !!app.graph.get(id)?.visible && (!o.localView || o.localView.has(id));
  sync(rs, rs.scene, steps, !!r.use_volumetric_shadows, ambient, visible);
  // domain objects are drawn as their smoke only; volumes follow their domain each build
  for (const c of rs.scene.children) {
    const id = c.userData.id as string | undefined;
    if (id && domains.has(id) && (c as Mesh).isMesh) c.visible = false;
    const sm = c.userData.smokeOf as string | undefined;
    if (sm) {
      const ev = app.graph.get(sm);
      if (ev) {
        c.matrix.copy(ev.world);
        c.updateMatrixWorld(true);
        // thickness 1 ≈ opaque after ~0.3 m of full density
        const sc = new Vector3().setFromMatrixScale(ev.world);
        const d = [...smokeDraw.values()].find((x) => x.objectId === sm);
        ((c as Mesh).material as ShaderMaterial).uniforms.uDensity.value = 12 * (d?.thickness ?? 1) * ((sc.x + sc.y + sc.z) / 3);
      }
      const mesh = c as Mesh;
      mesh.onBeforeRender = (_r, _s, camera) => {
        const u = (mesh.material as ShaderMaterial).uniforms;
        const toView = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
        u.uLocalToView.value.copy(toView);
        u.uViewToLocal.value.copy(toView).invert();
        const cam = new Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(mesh.matrixWorld.clone().invert());
        u.uCam.value.copy(cam);
        const bmin = u.uBMin.value as Vector3,
          bmax = u.uBMax.value as Vector3;
        const inside = cam.x > bmin.x && cam.x < bmax.x && cam.y > bmin.y && cam.y < bmax.y && cam.z > bmin.z && cam.z < bmax.z;
        const m = mesh.material as ShaderMaterial;
        m.side = inside ? BackSide : FrontSide;
        m.depthTest = !inside;
      };
    }
  }
});
