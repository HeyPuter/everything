// Viewport display options of fluid domains: a single slice through the grid, a color-ramp view of
// a chosen field (as a slice or a volume), cell grid lines on the slice and velocity / force vectors
// (needles, short streamlines or the three MAC components). Drawn on top of the scene like the
// smoke itself; everything is in the domain object's space.
import {
  Scene,
  Mesh,
  PlaneGeometry,
  BoxGeometry,
  ShaderMaterial,
  Data3DTexture,
  DataTexture,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  LinearFilter,
  NearestFilter,
  LineSegments,
  BufferGeometry,
  BufferAttribute,
  LineBasicMaterial,
  Matrix4,
  Vector3,
  DoubleSide,
  BackSide,
  FrontSide,
  type Camera,
} from 'three';
import { app } from '../app/app';
import { viewportExtensions } from '../editors/view3d/hooks';
import { renderContext } from '../render/context';
import { bakeRamp, readRamp, defaultRamp } from '../nodes/curves';
import type { FluidDomainSettings } from './fluid';

import { fluidOverlays, scalarField, sliceAxis, vectorLines, type FluidOverlay } from './fluidoverlay';

// ---------------------------------------------------------------------------
// Drawing

const sliceMaterial = () =>
  new ShaderMaterial({
    uniforms: {
      uTex: { value: null },
      uRamp: { value: null },
      uUseRamp: { value: 0 },
      uColor: { value: new Vector3(0.7, 0.7, 0.7) },
      uRes: { value: new Vector3(1, 1, 1) },
      uAxis: { value: 2 },
      uGrid: { value: 0 },
      uBMin: { value: new Vector3() },
      uBMax: { value: new Vector3() },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp sampler3D;
      uniform sampler3D uTex;
      uniform sampler2D uRamp;
      uniform float uUseRamp, uGrid;
      uniform int uAxis;
      uniform vec3 uColor, uRes, uBMin, uBMax;
      varying vec3 vLocal;
      void main() {
        vec3 uvw = (vLocal - uBMin) / (uBMax - uBMin);
        float v = texture(uTex, clamp(uvw, 0.0, 1.0)).r;
        vec4 c = uUseRamp > 0.5 ? texture(uRamp, vec2(v, 0.5)) : vec4(uColor, v);
        if (uGrid > 0.5) {
          // cell borders on the two in-plane axes
          vec3 cell = uvw * uRes;
          vec3 f = abs(fract(cell) - 0.5);
          vec3 w = fwidth(cell);
          float line = 0.0;
          if (uAxis != 0) line = max(line, 1.0 - smoothstep(0.5 - w.x * 1.2, 0.5, f.x));
          if (uAxis != 1) line = max(line, 1.0 - smoothstep(0.5 - w.y * 1.2, 0.5, f.y));
          if (uAxis != 2) line = max(line, 1.0 - smoothstep(0.5 - w.z * 1.2, 0.5, f.z));
          line = 1.0 - line;
          c = mix(c, vec4(0.0, 0.0, 0.0, 0.6), line * 0.8);
        }
        if (c.a < 0.003) discard;
        gl_FragColor = vec4(c.rgb * c.a, c.a);
      }`,
    premultipliedAlpha: true,
  });

const rampVolumeMaterial = () =>
  new ShaderMaterial({
    uniforms: { uTex: { value: null }, uRamp: { value: null }, uCam: { value: new Vector3() }, uBMin: { value: new Vector3() }, uBMax: { value: new Vector3() }, uDensity: { value: 1 } },
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
      uniform sampler2D uRamp;
      uniform vec3 uCam, uBMin, uBMax;
      uniform float uDensity;
      varying vec3 vLocal;
      void main() {
        vec3 dir = normalize(vLocal - uCam);
        vec3 inv = 1.0 / dir;
        vec3 t0 = (uBMin - uCam) * inv, t1 = (uBMax - uCam) * inv;
        vec3 tmin = min(t0, t1), tmax = max(t0, t1);
        float a = max(max(max(tmin.x, tmin.y), tmin.z), 0.0);
        float b = min(min(tmax.x, tmax.y), tmax.z);
        if (a >= b) discard;
        float stepLen = length(uBMax - uBMin) / 160.0;
        float T = 1.0;
        vec3 col = vec3(0.0);
        for (int i = 0; i < 200; i++) {
          float t = a + (float(i) + 0.5) * stepLen;
          if (t > b || T < 0.01) break;
          vec3 uvw = (uCam + dir * t - uBMin) / (uBMax - uBMin);
          vec4 c = texture(uRamp, vec2(texture(uTex, uvw).r, 0.5));
          float alpha = 1.0 - exp(-c.a * uDensity * stepLen);
          col += T * alpha * c.rgb;
          T *= 1.0 - alpha;
        }
        gl_FragColor = vec4(col, 1.0 - T);
      }`,
  });

interface Entry {
  key: string;
  data: FluidOverlay;
  sig: string;
  tex: Data3DTexture;
  ramp: DataTexture;
  slice: Mesh;
  volume: Mesh;
  vectors: LineSegments;
  vecSig: string;
}

const scene = new Scene();
scene.matrixWorldAutoUpdate = false;
const entries = new Map<string, Entry>();

function fieldBytes(o: FluidOverlay): Uint8Array {
  const s = o.settings;
  const n = o.nx * o.ny * o.nz;
  const out = new Uint8Array(n);
  if (s.use_color_ramp) {
    const f = scalarField(o, s.color_ramp_field ?? (o.liquid ? 'PHI' : 'DENSITY'));
    const sc = s.color_ramp_field_scale ?? 1;
    for (let c = 0; c < n; c++) out[c] = Math.round(Math.max(0, Math.min(1, f[c] * sc)) * 255);
  } else if (o.liquid) {
    const f = scalarField(o, 'PHI');
    for (let c = 0; c < n; c++) out[c] = Math.round(Math.max(0, Math.min(1, f[c])) * 255);
  } else if (o.density) for (let c = 0; c < n; c++) out[c] = o.density[c * 2];
  return out;
}

function rampBytes(s: FluidDomainSettings): Uint8Array {
  const props = (s as unknown as { color_ramp?: Record<string, unknown> }).color_ramp ?? defaultRamp();
  const f = bakeRamp(readRamp(props as never), 256);
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.max(0, Math.min(1, f[i])) * 255);
  return out;
}

function build(key: string, o: FluidOverlay): Entry {
  const tex = new Data3DTexture(new Uint8Array(o.nx * o.ny * o.nz), o.nx, o.ny, o.nz);
  tex.format = RedFormat;
  tex.type = UnsignedByteType;
  tex.unpackAlignment = 1;
  const ramp = new DataTexture(new Uint8Array(256 * 4), 256, 1, RGBAFormat, UnsignedByteType);
  ramp.minFilter = ramp.magFilter = LinearFilter;
  const slice = new Mesh(new PlaneGeometry(1, 1), sliceMaterial());
  const sx = o.bmax[0] - o.bmin[0],
    sy = o.bmax[1] - o.bmin[1],
    sz = o.bmax[2] - o.bmin[2];
  const volume = new Mesh(new BoxGeometry(sx, sy, sz).translate((o.bmin[0] + o.bmax[0]) / 2, (o.bmin[1] + o.bmax[1]) / 2, (o.bmin[2] + o.bmax[2]) / 2), rampVolumeMaterial());
  const vectors = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ vertexColors: true }));
  for (const m of [slice, volume, vectors]) {
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    m.renderOrder = 6;
    scene.add(m);
  }
  return { key, data: o, sig: '', tex, ramp, slice, volume, vectors, vecSig: '' };
}

function dispose(e: Entry) {
  for (const m of [e.slice, e.volume, e.vectors]) {
    scene.remove(m);
    m.geometry.dispose();
    (m.material as ShaderMaterial).dispose();
  }
  e.tex.dispose();
  e.ramp.dispose();
}

const _cam = new Vector3(),
  _dir = new Vector3();

function sync(localView: Set<string> | null, camera: Camera) {
  const seen = new Set<string>();
  for (const [key, o] of fluidOverlays) {
    const ev = app.graph.get(o.objectId);
    if (!ev || !ev.visible || (localView && !localView.has(o.objectId))) continue;
    seen.add(key);
    let e = entries.get(key);
    if (e && (e.data.nx !== o.nx || e.data.ny !== o.ny || e.data.nz !== o.nz || e.data.bmin.join() !== o.bmin.join() || e.data.bmax.join() !== o.bmax.join())) {
      dispose(e);
      entries.delete(key);
      e = undefined;
    }
    if (!e) {
      e = build(key, o);
      entries.set(key, e);
    }
    const s = o.settings;
    const sig = [s.use_color_ramp, s.color_ramp_field, s.color_ramp_field_scale, JSON.stringify((s as unknown as { color_ramp?: unknown }).color_ramp ?? null)].join('|');
    if (e.data !== o || e.sig !== sig) {
      e.tex.image.data = fieldBytes(o);
      e.tex.needsUpdate = true;
      (e.ramp.image.data as Uint8Array).set(rampBytes(s));
      e.ramp.needsUpdate = true;
      e.data = o;
      e.sig = sig;
    }
    const closest = s.display_interpolation === 'CLOSEST';
    const filter = closest ? NearestFilter : LinearFilter;
    if (e.tex.minFilter !== filter) {
      e.tex.minFilter = e.tex.magFilter = filter;
      e.tex.needsUpdate = true;
    }
    // camera direction in the domain's space picks the automatic slice axis
    const inv = ev.world.clone().invert();
    _cam.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
    camera.getWorldDirection(_dir);
    _dir.transformDirection(inv);
    const axis = sliceAxis(s, _dir);
    const depth = Math.max(0, Math.min(1, s.slice_depth ?? 0.5));
    // slice plane
    const sm = e.slice.material as ShaderMaterial;
    e.slice.visible = !!s.use_slice;
    if (e.slice.visible) {
      const size = [o.bmax[0] - o.bmin[0], o.bmax[1] - o.bmin[1], o.bmax[2] - o.bmin[2]];
      const mid = [(o.bmin[0] + o.bmax[0]) / 2, (o.bmin[1] + o.bmax[1]) / 2, (o.bmin[2] + o.bmax[2]) / 2];
      const dims = [o.nx, o.ny, o.nz];
      // snap to the middle of a cell layer so the slice shows whole cells
      const layer = Math.min(dims[axis] - 1, Math.floor(depth * dims[axis]));
      mid[axis] = o.bmin[axis] + ((layer + 0.5) / dims[axis]) * size[axis];
      const place = new Matrix4();
      if (axis === 2) place.makeScale(size[0], size[1], 1).setPosition(mid[0], mid[1], mid[2]);
      else if (axis === 0) place.makeRotationY(Math.PI / 2).scale(new Vector3(size[2], size[1], 1)).setPosition(mid[0], mid[1], mid[2]);
      else place.makeRotationX(Math.PI / 2).scale(new Vector3(size[0], size[2], 1)).setPosition(mid[0], mid[1], mid[2]);
      e.slice.matrixWorld.multiplyMatrices(ev.world, place);
      sm.uniforms.uTex.value = e.tex;
      sm.uniforms.uRamp.value = e.ramp;
      sm.uniforms.uUseRamp.value = s.use_color_ramp ? 1 : 0;
      sm.uniforms.uColor.value.set(...o.color);
      sm.uniforms.uRes.value.set(o.nx, o.ny, o.nz);
      sm.uniforms.uAxis.value = axis;
      sm.uniforms.uGrid.value = s.show_gridlines ? 1 : 0;
      sm.uniforms.uBMin.value.set(...o.bmin);
      sm.uniforms.uBMax.value.set(...o.bmax);
    }
    // color ramp volume (when not slicing)
    e.volume.visible = !!s.use_color_ramp && !s.use_slice;
    if (e.volume.visible) {
      const vm = e.volume.material as ShaderMaterial;
      vm.uniforms.uTex.value = e.tex;
      vm.uniforms.uRamp.value = e.ramp;
      vm.uniforms.uBMin.value.set(...o.bmin);
      vm.uniforms.uBMax.value.set(...o.bmax);
      const sc = new Vector3().setFromMatrixScale(ev.world);
      vm.uniforms.uDensity.value = 12 * (s.display_thickness ?? 1) * ((sc.x + sc.y + sc.z) / 3);
      vm.uniforms.uCam.value.copy(_cam);
      const inside = _cam.x > o.bmin[0] && _cam.x < o.bmax[0] && _cam.y > o.bmin[1] && _cam.y < o.bmax[1] && _cam.z > o.bmin[2] && _cam.z < o.bmax[2];
      vm.side = inside ? BackSide : FrontSide;
      vm.depthTest = !inside;
      e.volume.matrixWorld.copy(ev.world);
    }
    // vectors
    e.vectors.visible = !!s.show_velocity;
    if (e.vectors.visible) {
      const vsig = [o === e.data ? '' : 'x', s.vector_display_type, s.vector_field, s.vector_scale, s.vector_scale_with_magnitude, s.vector_show_mac_x, s.vector_show_mac_y, s.vector_show_mac_z, s.use_slice ? `${axis}:${depth}` : 'all'].join('|');
      if (vsig !== e.vecSig || e.vectors.userData.data !== o) {
        const L = vectorLines(o, s.use_slice ? axis : null, depth);
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(L.pos, 3));
        g.setAttribute('color', new BufferAttribute(L.col, 3));
        e.vectors.geometry.dispose();
        e.vectors.geometry = g;
        e.vectors.userData.data = o;
        e.vecSig = vsig;
      }
      e.vectors.matrixWorld.copy(ev.world);
    }
  }
  for (const [key, e] of entries)
    if (!seen.has(key)) {
      dispose(e);
      entries.delete(key);
    }
}

viewportExtensions.push((v) => {
  const draw = (_s: Scene, camera: Camera) => {
    if (!fluidOverlays.size && !entries.size) return;
    const r = renderContext?.engine.renderer;
    if (!r) return;
    sync(v.localView, camera);
    if (!scene.children.some((c) => c.visible)) return;
    r.render(scene, camera);
  };
  v.extraOverlays.push(draw);
  return () => {
    const i = v.extraOverlays.indexOf(draw);
    if (i >= 0) v.extraOverlays.splice(i, 1);
  };
});
