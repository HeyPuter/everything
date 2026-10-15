// Viewport display of particles: halo/point particles as round sized points and
// hair strands as line segments, drawn depth-tested after the scene pass.
import {
  Scene,
  Points,
  LineSegments,
  BufferGeometry,
  BufferAttribute,
  ShaderMaterial,
  LineBasicMaterial,
  Color,
  Vector4,
  Matrix4,
  Mesh,
  BoxGeometry,
  Data3DTexture,
  RGFormat,
  UnsignedByteType,
  LinearFilter,
  Vector3,
  FrontSide,
  BackSide,
  type Camera,
} from 'three';
import { app } from '../app/app';
import { viewportExtensions } from '../editors/view3d/hooks';
import { renderContext } from '../render/context';
import { particleDraw, type ParticleDraw } from './particles';
import { smokeDraw, type SmokeDraw } from './fluid';

const pointMaterial = () =>
  new ShaderMaterial({
    uniforms: { uColor: { value: new Color(1, 1, 1) }, uHalfH: { value: 400 } },
    vertexShader: /* glsl */ `
      attribute float psize;
      uniform float uHalfH;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(psize * projectionMatrix[1][1] * uHalfH / max(gl_Position.w, 1e-4), 2.0, 64.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        if (dot(d, d) > 0.25) discard;
        gl_FragColor = vec4(uColor, 1.0);
      }`,
  });

interface Entry {
  data: ParticleDraw;
  obj: Points | LineSegments;
}

const scene = new Scene();
scene.matrixWorldAutoUpdate = false;
const entries = new Map<string, Entry>();

/** Particle draw data a mode wants hidden (e.g. hair being edited in Particle Edit mode). */
export const particleDrawFilter: ((key: string, d: ParticleDraw) => boolean)[] = [];
const vp = new Vector4();

function build(d: ParticleDraw): Points | LineSegments {
  const g = new BufferGeometry();
  if (d.points) {
    g.setAttribute('position', new BufferAttribute(d.points, 3));
    g.setAttribute('psize', new BufferAttribute(d.sizes ?? new Float32Array(d.points.length / 3).fill(0.05), 1));
    const p = new Points(g, pointMaterial());
    p.frustumCulled = false;
    return p;
  }
  g.setAttribute('position', new BufferAttribute(d.lines ?? new Float32Array(0), 3));
  const l = new LineSegments(g, new LineBasicMaterial({ color: 0xffffff }));
  l.frustumCulled = false;
  return l;
}

function sync(localView: Set<string> | null) {
  const seen = new Set<string>();
  for (const [key, d] of particleDraw) {
    const ev = app.graph.get(d.objectId);
    if (!ev || !ev.visible || (localView && !localView.has(d.objectId))) continue;
    if (particleDrawFilter.some((f) => !f(key, d))) continue;
    seen.add(key);
    let e = entries.get(key);
    if (!e || e.data !== d) {
      if (e) {
        scene.remove(e.obj);
        e.obj.geometry.dispose();
        (e.obj.material as ShaderMaterial).dispose();
      }
      e = { data: d, obj: build(d) };
      entries.set(key, e);
      scene.add(e.obj);
    }
    e.obj.visible = true;
    e.obj.matrixAutoUpdate = false;
    if (d.space === 'LOCAL') e.obj.matrixWorld.copy(ev.world);
    else e.obj.matrixWorld.copy(IDENT);
    const c = new Color().setRGB(d.color[0], d.color[1], d.color[2]);
    if (e.obj instanceof Points) (e.obj.material as ShaderMaterial).uniforms.uColor.value.copy(c);
    else (e.obj.material as LineBasicMaterial).color.copy(c);
  }
  for (const [key, e] of entries)
    if (!seen.has(key)) {
      if (!particleDraw.has(key) || particleDraw.get(key) !== e.data) {
        scene.remove(e.obj);
        e.obj.geometry.dispose();
        (e.obj.material as ShaderMaterial).dispose();
        entries.delete(key);
      } else e.obj.visible = false;
    }
}

const IDENT = new Matrix4();

// ---------------------------------------------------------------------------
// Smoke / fire volumes: ray-marched 3D textures inside the domain box

const volumeMaterial = () =>
  new ShaderMaterial({
    uniforms: {
      uTex: { value: null },
      uCam: { value: new Vector3() },
      uBMin: { value: new Vector3() },
      uBMax: { value: new Vector3() },
      uColor: { value: new Color() },
      uDensity: { value: 1 },
      uFire: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp sampler3D;
      uniform sampler3D uTex;
      uniform vec3 uCam, uBMin, uBMax, uColor;
      uniform float uDensity, uFire;
      varying vec3 vLocal;
      void main() {
        vec3 dir = normalize(vLocal - uCam);
        vec3 inv = 1.0 / dir;
        vec3 t0 = (uBMin - uCam) * inv, t1 = (uBMax - uCam) * inv;
        vec3 tmin = min(t0, t1), tmax = max(t0, t1);
        float a = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
        float b = min(min(tmax.x, tmax.y), tmax.z);
        if (a >= b) discard;
        vec3 size = uBMax - uBMin;
        float stepLen = length(size) / 160.0;
        float T = 1.0;
        vec3 col = vec3(0.0);
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        for (int i = 0; i < 200; i++) {
          float t = a + (float(i) + jitter) * stepLen;
          if (t > b || T < 0.01) break;
          vec3 uvw = (uCam + dir * t - uBMin) / size;
          vec2 s = texture(uTex, uvw).rg;
          float alpha = 1.0 - exp(-s.r * uDensity * stepLen);
          // cheap self shadowing: denser smoke above is darker below
          float shade = 0.55 + 0.45 * (1.0 - texture(uTex, uvw + vec3(0.0, 0.0, 0.06)).r);
          col += T * alpha * uColor * shade;
          float e = s.g * uFire;
          // flame emission: dark red → orange → yellow with intensity
          col += T * vec3(1.0, 0.18 + 0.6 * e * e, 0.02 + 0.25 * e * e * e) * e * stepLen * 14.0;
          T *= 1.0 - alpha;
        }
        gl_FragColor = vec4(col, 1.0 - T);
      }`,
  });

interface VolumeEntry {
  data: SmokeDraw;
  mesh: Mesh;
  tex: Data3DTexture;
}
const volumes = new Map<string, VolumeEntry>();
const _cam = new Vector3();

function syncVolumes(localView: Set<string> | null, camera: Camera) {
  const seen = new Set<string>();
  for (const [key, d] of smokeDraw) {
    const ev = app.graph.get(d.objectId);
    if (!ev || !ev.visible || (localView && !localView.has(d.objectId))) continue;
    seen.add(key);
    let e = volumes.get(key);
    if (e && (e.data.nx !== d.nx || e.data.ny !== d.ny || e.data.nz !== d.nz || e.data.bmin.join() !== d.bmin.join() || e.data.bmax.join() !== d.bmax.join())) {
      scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.tex.dispose();
      volumes.delete(key);
      e = undefined;
    }
    if (!e) {
      const sx = d.bmax[0] - d.bmin[0],
        sy = d.bmax[1] - d.bmin[1],
        sz = d.bmax[2] - d.bmin[2];
      const geo = new BoxGeometry(sx, sy, sz).translate((d.bmin[0] + d.bmax[0]) / 2, (d.bmin[1] + d.bmax[1]) / 2, (d.bmin[2] + d.bmax[2]) / 2);
      const tex = new Data3DTexture(d.data, d.nx, d.ny, d.nz);
      tex.format = RGFormat;
      tex.type = UnsignedByteType;
      tex.minFilter = tex.magFilter = LinearFilter;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      const mesh = new Mesh(geo, volumeMaterial());
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      e = { data: d, mesh, tex };
      volumes.set(key, e);
      scene.add(mesh);
    } else if (e.data !== d) {
      e.tex.image.data = d.data;
      e.tex.needsUpdate = true;
      e.data = d;
    }
    const mat = e.mesh.material as ShaderMaterial;
    const u = mat.uniforms;
    u.uTex.value = e.tex;
    u.uBMin.value.set(...d.bmin);
    u.uBMax.value.set(...d.bmax);
    u.uColor.value.setRGB(...d.color);
    // density scale in local units (thickness 1 ≈ opaque after ~0.3 m of full density)
    const sc = new Vector3().setFromMatrixScale(ev.world);
    u.uDensity.value = 12 * d.thickness * ((sc.x + sc.y + sc.z) / 3);
    u.uFire.value = d.fire ? 1 : 0;
    e.mesh.matrixWorld.copy(ev.world);
    // camera in local space; inside the box draw back faces without depth test
    _cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(ev.world.clone().invert());
    u.uCam.value.copy(_cam);
    const inside = _cam.x > d.bmin[0] && _cam.x < d.bmax[0] && _cam.y > d.bmin[1] && _cam.y < d.bmax[1] && _cam.z > d.bmin[2] && _cam.z < d.bmax[2];
    mat.side = inside ? BackSide : FrontSide;
    mat.depthTest = !inside;
    e.mesh.visible = true;
  }
  for (const [key, e] of volumes)
    if (!seen.has(key)) {
      if (!smokeDraw.has(key)) {
        scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.tex.dispose();
        (e.mesh.material as ShaderMaterial).dispose();
        volumes.delete(key);
      } else e.mesh.visible = false;
    }
}

viewportExtensions.push((v) => {
  const draw = (_s: Scene, camera: Camera) => {
    if (!particleDraw.size && !entries.size && !smokeDraw.size && !volumes.size) return;
    const r = renderContext?.engine.renderer;
    if (!r) return;
    sync(v.localView);
    syncVolumes(v.localView, camera);
    if (!scene.children.some((c) => c.visible)) return;
    r.getCurrentViewport(vp);
    for (const c of scene.children) if (c instanceof Points) (c.material as ShaderMaterial).uniforms.uHalfH.value = vp.w / 2;
    r.render(scene, camera);
  };
  v.extraOverlays.push(draw);
  return () => {
    const i = v.extraOverlays.indexOf(draw);
    if (i >= 0) v.extraOverlays.splice(i, 1);
  };
});
