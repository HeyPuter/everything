// Grease Pencil viewport / render drawing. Strokes are drawn by a custom shader: segment quads are
// expanded in screen space around their end points and shaded as tapered capsules (round joins and
// caps, per point radius / color / opacity, anti-aliased edges); dots/squares materials draw one
// quad per point; fills are triangles. Depth ordering (default 2D Layers):
//   2D Layers: every stroke (and fill) gets a draw order; fragments write the object's depth minus
//              a tiny step per order, so later strokes draw over earlier ones, overlaps inside one
//              stroke never blend twice, and the object as a whole is still depth tested against
//              the rest of the scene at its origin.
//   3D Location: fragments use their real depth (segment joins resolve to the shared point depth).
import {
  BufferGeometry,
  BufferAttribute,
  Group,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  Matrix4,
  Euler,
  Quaternion,
  DoubleSide,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  DstColorFactor,
  AddEquation,
  ReverseSubtractEquation,
  LessDepth,
  LessEqualDepth,
  AlwaysDepth,
  WebGLRenderTarget,
  UnsignedByteType,
  PlaneGeometry,
  OrthographicCamera,
  Scene,
  Color,
  type Camera,
  type WebGLRenderer,
} from 'three';
import { app } from '../app/app';
import type { DocumentData } from '../data/types';
import type { EvalObject } from '../eval/depsgraph';
import { sceneSyncHooks } from '../render/scene';
import { drawHooks, type DrawView } from '../editors/view3d/draw';
import { renderContext } from '../render/context';
import { renderSceneHooks, renderVisibleObjects } from '../render/final/renderscene';
import { buildStrokeBuffers, type StrokeBuffers, type StrokeStyle } from './geometry';
import { gpOf, frameAt, onionFrames, onionAlpha, slotStyle } from './data';
import type { GPDrawing, GPLayer, GreasePencilData } from './types';

// ---------------------------------------------------------------------------
// shader

const vert = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aP1;
attribute vec2 aR;
attribute vec4 aC0;
attribute vec4 aC1;
attribute vec2 aCorner;
attribute vec4 aInfo;
attribute vec4 aN0;
attribute vec4 aN1;
uniform vec2 uViewport;
uniform float uRadiusScale;
varying vec2 vPix;
flat varying vec2 vS0;
flat varying vec2 vS1;
flat varying vec2 vR;
flat varying vec4 vC0;
flat varying vec4 vC1;
flat varying vec4 vInfo;
flat varying vec2 vZ;
flat varying vec3 vN0;
flat varying vec3 vN1;
vec3 screenNbr(mat4 mvp, vec4 n, float k) {
  if (n.w <= 0.0) return vec3(0.0);
  vec4 c = mvp * vec4(n.xyz, 1.0);
  if (c.w <= 1e-6) return vec3(0.0);
  return vec3((c.xy / c.w * 0.5 + 0.5) * uViewport, n.w * k / c.w);
}
void main() {
  int kind = int(aInfo.x + 0.5);
  vInfo = aInfo;
  vN0 = vec3(0.0);
  vN1 = vec3(0.0);
  vC0 = aC0;
  vC1 = aC1;
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c0 = mvp * vec4(aP0, 1.0);
  vPix = vec2(0.0);
  vS0 = vec2(0.0);
  vS1 = vec2(0.0);
  vR = vec2(0.0);
  vZ = vec2(0.5);
  if (kind == 0) {
    gl_Position = c0;
    return;
  }
  vec4 c1 = mvp * vec4(aP1, 1.0);
  if (c0.w <= 1e-6 || c1.w <= 1e-6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 s0 = (c0.xy / c0.w * 0.5 + 0.5) * uViewport;
  vec2 s1 = (c1.xy / c1.w * 0.5 + 0.5) * uViewport;
  float k = projectionMatrix[1][1] * 0.5 * uViewport.y * uRadiusScale;
  float r0 = aR.x * k / c0.w;
  float r1 = aR.y * k / c1.w;
  vS0 = s0;
  vS1 = (int(aInfo.z + 0.5) & 8) != 0 ? s0 + vec2(1.0, 0.0) : s1;
  vR = vec2(r0, r1);
  if (kind == 1) {
    vN0 = screenNbr(mvp, aN0, k);
    vN1 = screenNbr(mvp, aN1, k);
  }
  vZ = vec2(c0.z / c0.w, c1.z / c1.w) * 0.5 + 0.5;
  vec2 d = s1 - s0;
  float L = length(d);
  vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 pix;
  float z;
  if (kind >= 2) {
    float R = max(r0, 0.5) * (kind == 3 ? 1.42 : 1.0) + 1.5;
    pix = s0 + vec2(aCorner.x * 2.0 - 1.0, aCorner.y) * R;
    z = c0.z / c0.w;
  } else {
    float R = max(max(r0, r1), 0.5) + 1.5;
    pix = (aCorner.x < 0.5 ? s0 - dir * R : s1 + dir * R) + nrm * aCorner.y * R;
    z = aCorner.x < 0.5 ? c0.z / c0.w : c1.z / c1.w;
  }
  vPix = pix;
  gl_Position = vec4(pix / uViewport * 2.0 - 1.0, clamp(z, -1.0, 1.0), 1.0);
}
`;

const frag = /* glsl */ `
uniform float uOpacity;
uniform vec4 uTint;
uniform vec4 uOnion;
uniform vec3 uLight;
uniform int uDepthMode;
uniform float uBaseDepth;
uniform float uOrderBase;
uniform float uOrderEps;
uniform vec4 uIdColor;
varying vec2 vPix;
flat varying vec2 vS0;
flat varying vec2 vS1;
flat varying vec2 vR;
flat varying vec4 vC0;
flat varying vec4 vC1;
flat varying vec4 vInfo;
flat varying vec2 vZ;
flat varying vec3 vN0;
flat varying vec3 vN1;
float capsuleCov(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 ab = b - a;
  float L2 = dot(ab, ab);
  float t = L2 > 1e-8 ? clamp(dot(p - a, ab) / L2, 0.0, 1.0) : 0.0;
  float r = mix(ra, rb, t);
  return clamp(max(r, 0.5) + 0.5 - length(p - (a + ab * t)), 0.0, 1.0);
}
void main() {
  int kind = int(vInfo.x + 0.5);
  vec4 col;
  float t = 0.0;
  float cov = 1.0;
  float zReal = gl_FragCoord.z;
  if (kind == 0) {
    col = vC0;
  } else if (kind == 1) {
    vec2 ab = vS1 - vS0;
    float L2 = dot(ab, ab);
    float tr = L2 > 1e-8 ? dot(vPix - vS0, ab) / L2 : 0.0;
    int flags = int(vInfo.z + 0.5);
    if ((flags & 1) != 0 && tr < 0.0) discard;
    if ((flags & 2) != 0 && tr > 1.0) discard;
    t = clamp(tr, 0.0, 1.0);
    float r = mix(vR.x, vR.y, t);
    float d = length(vPix - (vS0 + ab * t));
    cov = clamp(max(r, 0.5) + 0.5 - d, 0.0, 1.0) * clamp(r * 2.0, 0.0, 1.0);
    if (cov <= 0.0) discard;
    // a partially covered pixel that a neighbouring segment covers fully is drawn by that one
    if (cov < 0.999) {
      if (vN0.z > 0.0 && capsuleCov(vPix, vN0.xy, vS0, vN0.z, vR.x) >= 0.999) discard;
      if (vN1.z > 0.0 && capsuleCov(vPix, vS1, vN1.xy, vR.y, vN1.z) >= 0.999) discard;
    }
    col = mix(vC0, vC1, t);
    col.a *= cov;
    zReal = mix(vZ.x, vZ.y, t);
  } else {
    vec2 p = vPix - vS0;
    float r = vR.x;
    float d;
    if (kind == 2) d = length(p);
    else {
      vec2 ab = vS1 - vS0;
      vec2 dir = dot(ab, ab) > 1e-8 ? normalize(ab) : vec2(1.0, 0.0);
      vec2 q = vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x)));
      d = max(abs(q.x), abs(q.y));
    }
    cov = clamp(max(r, 0.5) + 0.5 - d, 0.0, 1.0) * clamp(r * 2.0, 0.0, 1.0);
    if (cov <= 0.0) discard;
    col = vC0;
    col.a *= cov;
    zReal = vZ.x;
  }
  col.rgb = mix(col.rgb, uTint.rgb, uTint.a);
  col.rgb = mix(col.rgb, uOnion.rgb, uOnion.a);
  col.rgb *= uLight;
  col.a *= uOpacity;
  // ordered depth: 8 steps per draw order; partially covered (anti-aliased edge) pixels sit
  // slightly behind fully covered ones so the next segment of the same stroke can cover them,
  // while equal coverage is rejected (no double blending inside a stroke)
  gl_FragDepth = uDepthMode == 0 ? uBaseDepth - ((uOrderBase + vInfo.y) * 8.0 + floor(cov * 7.0 + 0.5)) * uOrderEps : zReal;
#ifdef ID_PASS
  if (col.a < 0.25) discard;
  gl_FragColor = uIdColor;
#else
  if (col.a <= 0.002) discard;
  gl_FragColor = vec4(col.rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * col.a, col.a);
#endif
}
`;

/** Depth step per order sub-level: 1.5 quanta of a 24-bit depth buffer. */
const ORDER_EPS = 1.5 / (1 << 24);

function makeMaterial(idPass: boolean): ShaderMaterial {
  const m = new ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uViewport: { value: new Vector2(1, 1) },
      uRadiusScale: { value: 1 },
      uOpacity: { value: 1 },
      uTint: { value: new Vector4(0, 0, 0, 0) },
      uOnion: { value: new Vector4(0, 0, 0, 0) },
      uLight: { value: new Vector3(1, 1, 1) },
      uDepthMode: { value: 0 },
      uBaseDepth: { value: 1 },
      uOrderBase: { value: 0 },
      uOrderEps: { value: ORDER_EPS },
      uIdColor: { value: new Vector4() },
    },
    defines: idPass ? { ID_PASS: 1 } : {},
    side: DoubleSide,
    transparent: !idPass,
    depthTest: true,
    depthWrite: true,
    depthFunc: LessDepth,
  });
  if (!idPass) {
    m.blending = CustomBlending;
    setBlend(m, 'REGULAR');
  }
  return m;
}

function setBlend(m: ShaderMaterial, mode: string) {
  m.blendEquation = mode === 'SUBTRACT' ? ReverseSubtractEquation : AddEquation;
  m.blendEquationAlpha = AddEquation;
  m.blendSrc = mode === 'MULTIPLY' ? DstColorFactor : OneFactor;
  m.blendDst = mode === 'ADD' || mode === 'SUBTRACT' ? OneFactor : OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = OneFactor;
  m.blendDstAlpha = OneMinusSrcAlphaFactor;
}

// ---------------------------------------------------------------------------
// geometry cache (keyed by the identity of the drawing's typed arrays and the material styles)

let arrayIds = new WeakMap<object, number>(),
  nextArrayId = 1;
function aid(a: object | undefined): number {
  if (!a) return 0;
  let id = arrayIds.get(a);
  if (!id) arrayIds.set(a, (id = nextArrayId++));
  return id;
}
export function resetArrayIds() {
  arrayIds = new WeakMap();
}

export function drawingKey(d: GPDrawing) {
  return `${aid(d.position)}.${aid(d.radius)}.${aid(d.opacity)}.${aid(d.vertex_color)}.${aid(d.offsets)}.${aid(d.cyclic)}.${aid(d.material_index)}.${aid(d.start_cap)}.${aid(d.end_cap)}.${aid(d.fill_color)}.${aid(d.fill_opacity)}.${aid(d.fill_id)}`;
}

interface CachedGeo {
  geo: BufferGeometry;
  orders: number;
  used: number;
}
const geoCache = new Map<string, CachedGeo>();
let syncTick = 0;

export function geometryFromBuffers(b: StrokeBuffers): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('aP0', new BufferAttribute(b.p0, 3));
  // three needs a 'position' attribute for bounds / draw range; reuse p0
  g.setAttribute('position', g.getAttribute('aP0'));
  g.setAttribute('aP1', new BufferAttribute(b.p1, 3));
  g.setAttribute('aR', new BufferAttribute(b.radius, 2));
  g.setAttribute('aC0', new BufferAttribute(b.c0, 4));
  g.setAttribute('aC1', new BufferAttribute(b.c1, 4));
  g.setAttribute('aCorner', new BufferAttribute(b.corner, 2));
  g.setAttribute('aInfo', new BufferAttribute(b.info, 4));
  g.setAttribute('aN0', new BufferAttribute(b.nbr0, 4));
  g.setAttribute('aN1', new BufferAttribute(b.nbr1, 4));
  g.setIndex(new BufferAttribute(b.index, 1));
  return g;
}

function styleKey(styles: (StrokeStyle | null)[]) {
  return styles.map((s) => (s ? `${+s.stroke}${+s.fill}${s.mode}${s.alignment ?? ''}${s.color.join(',')}|${s.fillColor.join(',')}` : '-')).join(';');
}

function cachedGeometry(d: GPDrawing, styles: (StrokeStyle | null)[], radiusOffset: number): CachedGeo {
  const key = `${drawingKey(d)}#${styleKey(styles)}#${radiusOffset}`;
  let c = geoCache.get(key);
  if (!c) {
    const b = buildStrokeBuffers(d, styles, 0, radiusOffset);
    c = { geo: geometryFromBuffers(b), orders: b.orderEnd, used: syncTick };
    geoCache.set(key, c);
  }
  c.used = syncTick;
  return c;
}

function pruneCache() {
  if (geoCache.size < 64) return;
  for (const [k, c] of geoCache)
    if (syncTick - c.used > 2) {
      c.geo.dispose();
      geoCache.delete(k);
    }
}

export function materialStyles(doc: DocumentData, gp: GreasePencilData, ghost = false): (StrokeStyle | null)[] {
  const n = Math.max(1, gp.materials.length);
  const out: (StrokeStyle | null)[] = [];
  for (let i = 0; i < n; i++) {
    const st = slotStyle(doc, gp, i);
    if (!st || st.hide || (ghost && !st.ghost)) {
      out.push(st ? null : DEFAULT_STYLE);
      continue;
    }
    out.push({
      stroke: st.show_stroke,
      fill: st.show_fill,
      color: [...st.color],
      fillColor: [...st.fill_color],
      mode: st.mode,
      alignment: st.alignment_mode,
    });
  }
  return out;
}
const DEFAULT_STYLE: StrokeStyle = {
  stroke: true,
  fill: false,
  color: [0, 0, 0, 1],
  fillColor: [0.5, 0.5, 0.5, 1],
  mode: 'LINE',
};

// ---------------------------------------------------------------------------
// per object content: every GP object owns a small scene (not part of the synced editor scene);
// the viewport pass hooks draw it after the scene pass.

interface GPMesh extends Mesh {
  material: ShaderMaterial;
  userData: {
    id: string;
    onion: boolean;
    layer: number;
    gpencil: true;
    idMat?: ShaderMaterial;
    inFront?: boolean;
    mode3D?: boolean;
    rootless?: boolean;
  };
}

interface GPSynced {
  id: string;
  scene: Scene;
  group: Group;
  meshes: GPMesh[];
  mode3D: boolean;
  inFront: boolean;
}

const synced = new Map<string, GPSynced>();

export function layerMatrix(l: GPLayer): Matrix4 {
  return new Matrix4().compose(new Vector3(...l.translation), new Quaternion().setFromEuler(new Euler(l.rotation[0], l.rotation[1], l.rotation[2], 'XYZ')), new Vector3(...l.scale));
}

/** Modes that show onion skins (while drawing/editing). */
const ONION_MODES = new Set(['PAINT_GREASE_PENCIL', 'EDIT', 'SCULPT_GREASE_PENCIL']);

export const gpDisplay = {
  /** default of the per-viewport overlay toggle (overlay.use_gpencil_onion_skin) */
  onionDefault: true,
};

function wantOnion(doc: DocumentData, obId: string) {
  return doc.scene.active_object === obId && ONION_MODES.has(doc.mode) && !app.playing;
}

const tmpV = new Vector3();
const tmpV4 = new Vector4();

function onBeforeRender(this: GPMesh, renderer: WebGLRenderer, _scene: Scene, camera: Camera) {
  renderer.getCurrentViewport(tmpV4);
  const mats = [this.material, this.userData.idMat].filter(Boolean) as ShaderMaterial[];
  const e = this.matrixWorld.elements;
  const sc = (Math.hypot(e[0], e[1], e[2]) + Math.hypot(e[4], e[5], e[6]) + Math.hypot(e[8], e[9], e[10])) / 3;
  for (const m of mats) {
    const u = m.uniforms;
    u.uViewport.value.set(Math.max(1, tmpV4.z), Math.max(1, tmpV4.w));
    u.uRadiusScale.value = sc;
    u.uDepthMode.value = this.userData.mode3D ? 1 : 0;
    if (this.userData.rootless) {
      // drawn straight into a render scene: order below the object's own depth
      tmpV.setFromMatrixPosition(this.matrixWorld).project(camera);
      u.uBaseDepth.value = this.userData.inFront ? 0.02 : Math.min(1, Math.max(0, tmpV.z * 0.5 + 0.5));
    } else u.uBaseDepth.value = 1 - ORDER_EPS;
  }
}

function newGPMesh(id: string): GPMesh {
  const m = new Mesh(new BufferGeometry(), makeMaterial(false)) as unknown as GPMesh;
  m.matrixAutoUpdate = false;
  m.frustumCulled = false;
  m.userData = { id, onion: false, layer: 0, gpencil: true };
  m.onBeforeRender = onBeforeRender as unknown as Mesh['onBeforeRender'];
  return m;
}

interface Entry {
  geo: BufferGeometry;
  orderBase: number;
  layer: GPLayer;
  layerIndex: number;
  onion: boolean;
  onionColor: [number, number, number, number];
  alpha: number;
}

/** Everything drawn for a GP object at the current frame (onion skins first, then layers bottom→top). */
export function objectEntries(doc: DocumentData, gp: GreasePencilData, frame: number, onion: boolean): Entry[] {
  const entries: Entry[] = [];
  let order = 0;
  const styles = materialStyles(doc, gp);
  const ghostStyles = onion ? materialStyles(doc, gp, true) : styles;
  if (onion) {
    const range = { start: doc.scene.frame_start, end: doc.scene.frame_end };
    gp.layers.forEach((layer, li) => {
      if (layer.hide || !layer.use_onion_skinning) return;
      const list = onionFrames(gp, layer, frame, range);
      const maxB = Math.max(1, ...list.filter((o) => o.side < 0).map((o) => o.distance)),
        maxA = Math.max(1, ...list.filter((o) => o.side > 0).map((o) => o.distance));
      for (const o of list) {
        const d = gp.drawings[o.frame.drawing];
        if (!d || d.offsets.length < 2) continue;
        const c = cachedGeometry(d, ghostStyles, layer.radius_offset);
        const col = o.side < 0 ? gp.before_color : gp.after_color;
        entries.push({
          geo: c.geo,
          orderBase: order,
          layer,
          layerIndex: li,
          onion: true,
          onionColor: [col[0], col[1], col[2], gp.use_ghost_custom_colors ? 1 : 0],
          alpha: onionAlpha(gp, o, o.side < 0 ? maxB : maxA),
        });
        order += c.orders;
      }
    });
  }
  gp.layers.forEach((layer, li) => {
    if (layer.hide) return;
    const fr = frameAt(layer, frame);
    const d = fr ? gp.drawings[fr.drawing] : undefined;
    if (!d || d.offsets.length < 2) return;
    const c = cachedGeometry(d, styles, layer.radius_offset);
    entries.push({
      geo: c.geo,
      orderBase: order,
      layer,
      layerIndex: li,
      onion: false,
      onionColor: [0, 0, 0, 0],
      alpha: 1,
    });
    order += c.orders;
  });
  return entries;
}

function applyEntry(m: GPMesh, e: Entry, ob: { show_in_front: boolean }, mode3D: boolean) {
  m.geometry = e.geo;
  const u = m.material.uniforms;
  u.uOpacity.value = e.layer.opacity * e.alpha;
  u.uTint.value.set(e.layer.tint_color[0], e.layer.tint_color[1], e.layer.tint_color[2], e.layer.tint_factor);
  u.uOnion.value.set(...e.onionColor);
  u.uOrderBase.value = e.orderBase;
  setBlend(m.material, e.onion ? 'REGULAR' : e.layer.blend_mode);
  m.userData.onion = e.onion;
  m.userData.layer = e.layerIndex;
  m.userData.inFront = ob.show_in_front;
  m.userData.mode3D = mode3D;
  m.matrix.copy(layerMatrix(e.layer));
  m.visible = true;
}

function syncObject(doc: DocumentData, ev: EvalObject) {
  const gp = gpOf(doc, ev.ob);
  let s = synced.get(ev.id);
  if (!gp) {
    if (s) synced.delete(ev.id);
    return;
  }
  if (!s) {
    const scene = new Scene();
    scene.matrixWorldAutoUpdate = false;
    const group = new Group();
    group.matrixAutoUpdate = false;
    scene.add(group);
    s = { id: ev.id, scene, group, meshes: [], mode3D: false, inFront: false };
    synced.set(ev.id, s);
  }
  s.mode3D = gp.stroke_depth_order === '3D';
  s.inFront = ev.ob.show_in_front;
  s.group.matrix.copy(ev.world);
  const entries = objectEntries(doc, gp, doc.scene.frame_current, wantOnion(doc, ev.id));
  while (s.meshes.length < entries.length) {
    const m = newGPMesh(ev.id);
    s.meshes.push(m);
    s.group.add(m);
  }
  s.meshes.forEach((m, i) => {
    const e = entries[i];
    if (!e) {
      m.visible = false;
      return;
    }
    applyEntry(m, e, ev.ob, s!.mode3D);
    m.renderOrder = i;
  });
  s.group.updateMatrixWorld(true);
}

let lastTick = -1;
sceneSyncHooks.push((doc, ev) => {
  if (lastTick !== app.revision) {
    // once per sync: drop deleted objects and stale geometry
    lastTick = app.revision;
    syncTick++;
    for (const id of [...synced.keys()]) if (!app.graph.get(id)) synced.delete(id);
    pruneCache();
  }
  syncObject(doc, ev);
});

// ---------------------------------------------------------------------------
// viewport passes

let rt: WebGLRenderTarget | null = null;
const compositeMat = new ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor;
    uniform float uDepth;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tColor, vUv);
      if (c.a < 0.002) discard;
      gl_FragColor = vec4(c.rgb / c.a, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      gl_FragColor = vec4(gl_FragColor.rgb * c.a, c.a);
      gl_FragDepth = uDepth;
    }
  `,
  uniforms: { tColor: { value: null }, uDepth: { value: 1 } },
  depthTest: true,
  depthWrite: true,
  transparent: true,
  blending: CustomBlending,
  blendSrc: OneFactor,
  blendDst: OneMinusSrcAlphaFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: OneMinusSrcAlphaFactor,
});
const compositeQuad = new Mesh(new PlaneGeometry(2, 2), compositeMat);
compositeQuad.frustumCulled = false;
const compositeScene = new Scene();
compositeScene.add(compositeQuad);
const compositeCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

// stroke colors are rendered linear (no tone mapping) into the offscreen target; the composite
// applies the view transform once
for (const m of [compositeMat]) m.toneMapped = true;

function visibleObjects(view: DrawView): GPSynced[] {
  const sync = renderContext?.sync;
  const out: GPSynced[] = [];
  for (const s of synced.values()) {
    const so = sync?.objects.get(s.id);
    if (!so || !so.root.visible) continue;
    if (view.hiddenTypes?.has('GREASEPENCIL')) continue;
    out.push(s);
  }
  return out;
}

function originDepth(s: GPSynced, camera: Camera) {
  tmpV.setFromMatrixPosition(s.group.matrixWorld).project(camera);
  return tmpV.z * 0.5 + 0.5;
}

function showOnion(view: DrawView) {
  return (view.overlay as { use_gpencil_onion_skin?: boolean }).use_gpencil_onion_skin ?? gpDisplay.onionDefault;
}

/** Draw all visible GP objects into the current framebuffer (far objects first). */
function drawObjects(view: DrawView, camera: Camera) {
  const ctx = renderContext;
  if (!ctx) return;
  const r = ctx.engine.renderer;
  const list = visibleObjects(view);
  if (!list.length) return;
  const onion = showOnion(view);
  const depths = new Map(list.map((s) => [s, originDepth(s, camera)]));
  list.sort((a, b) => depths.get(b)! - depths.get(a)!);
  const vp = r.getCurrentViewport(new Vector4());
  const W = Math.max(1, vp.z),
    H = Math.max(1, vp.w);
  const prevTarget = r.getRenderTarget();
  const prevClear = r.getClearColor(new Color()),
    prevAlpha = r.getClearAlpha();
  const prevShadow = r.shadowMap.autoUpdate;
  r.shadowMap.autoUpdate = false;
  for (const s of list) {
    const hidden: GPMesh[] = [];
    if (!onion)
      for (const m of s.meshes)
        if (m.userData.onion && m.visible) {
          m.visible = false;
          hidden.push(m);
        }
    if (s.mode3D) {
      // real depth, straight into the framebuffer
      r.render(s.scene, camera);
    } else {
      if (!rt)
        rt = new WebGLRenderTarget(W, H, {
          samples: 4,
          depthBuffer: true,
          type: UnsignedByteType,
        });
      if (rt.width !== W || rt.height !== H) rt.setSize(W, H);
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      r.render(s.scene, camera);
      r.setRenderTarget(prevTarget);
      compositeMat.uniforms.tColor.value = rt.texture;
      compositeMat.uniforms.uDepth.value = s.inFront ? 0 : Math.min(1, Math.max(0, depths.get(s)!));
      compositeMat.depthFunc = s.inFront ? AlwaysDepth : LessEqualDepth;
      r.render(compositeScene, compositeCam);
    }
    for (const m of hidden) m.visible = true;
  }
  r.setClearColor(prevClear, prevAlpha);
  r.shadowMap.autoUpdate = prevShadow;
}

/** Object ids for picking / selection outlines. */
function drawIds(view: DrawView, camera: Camera) {
  const ctx = renderContext;
  if (!ctx) return;
  const r = ctx.engine.renderer;
  for (const s of visibleObjects(view)) {
    const ev = app.graph.get(s.id);
    if (!ev?.selectable || view.unselectableTypes?.has('GREASEPENCIL')) continue;
    const idx = ctx.sync.objectIndex(s.id) + 1;
    const saved: [GPMesh, boolean, ShaderMaterial][] = [];
    const base = s.inFront ? 0.02 : originDepth(s, camera);
    for (const m of s.meshes) {
      saved.push([m, m.visible, m.material]);
      if (m.userData.onion) {
        m.visible = false;
        continue;
      }
      const idm = (m.userData.idMat ??= makeMaterial(true));
      idm.uniforms.uIdColor.value.set((idx & 255) / 255, ((idx >> 8) & 255) / 255, ((idx >> 16) & 255) / 255, 1);
      idm.uniforms.uOrderBase.value = m.material.uniforms.uOrderBase.value;
      idm.uniforms.uOpacity.value = m.material.uniforms.uOpacity.value;
      m.material = idm;
      m.userData.rootless = !s.mode3D; // order below the object's own depth inside the ID buffer
    }
    r.render(s.scene, camera);
    for (const [m, v, mat] of saved) {
      m.visible = v;
      m.material = mat;
      m.userData.rootless = false;
    }
    void base;
  }
}

let sceneDrawn = false;

drawHooks.passes.push((pass, view, camera) => {
  if (!synced.size) return;
  if (pass === 'SCENE') {
    sceneDrawn = true;
    return () => drawObjects(view, camera);
  }
  if (pass === 'OVERLAY') {
    // when the render engine drew the scene (Rendered shading) the strokes are drawn here
    const drawn = sceneDrawn;
    sceneDrawn = false;
    if (drawn) return;
    return () => drawObjects(view, camera);
  }
  return () => drawIds(view, camera);
});

// ---------------------------------------------------------------------------
// final renders (raster engine): strokes are added to the render scene

const renderMeshes = new WeakMap<object, Map<string, GPMesh[]>>();

renderSceneHooks.push((rs, appRef, o) => {
  let byOb = renderMeshes.get(rs);
  if (!byOb) renderMeshes.set(rs, (byOb = new Map()));
  const doc = appRef.doc;
  const seen = new Set<string>();
  if (o.mode === 'raster') {
    const renderable = o.final ? renderVisibleObjects(doc) : null;
    for (const ev of appRef.graph.objects.values()) {
      const gp = gpOf(doc, ev.ob);
      if (!gp) continue;
      const visible = renderable ? renderable.has(ev.id) : ev.visible && !ev.ob.hide_render;
      if (!visible || (o.localView && !o.localView.has(ev.id))) continue;
      seen.add(ev.id);
      const entries = objectEntries(doc, gp, doc.scene.frame_current, false);
      let list = byOb.get(ev.id);
      if (!list) byOb.set(ev.id, (list = []));
      while (list.length < entries.length) {
        const m = newGPMesh(ev.id);
        m.userData.rootless = true;
        list.push(m);
        rs.scene.add(m);
      }
      list.forEach((m, i) => {
        if (!entries[i]) {
          m.visible = false;
          return;
        }
        applyEntry(m, entries[i], ev.ob, gp.stroke_depth_order === '3D');
        m.matrix.premultiply(ev.world);
        m.matrixWorld.copy(m.matrix);
        m.renderOrder = 1000 + i;
      });
    }
  }
  for (const [id, list] of byOb)
    if (!seen.has(id)) {
      for (const m of list) rs.scene.remove(m);
      byOb.delete(id);
    }
});

/** Ids of objects with grease pencil content synced for drawing (tests / debugging). */
export function syncedObjectIds() {
  return [...synced.keys()];
}

// ---------------------------------------------------------------------------
// live stroke preview (drawn inside the object's own pass, on top of its strokes)

let preview: { obId: string; mesh: GPMesh } | null = null;

/** Show (or clear with null) an in-progress stroke drawing for an object/layer. */
export function setStrokePreview(obId: string | null, d: GPDrawing | null, layer?: GPLayer | null) {
  const s = obId ? synced.get(obId) : undefined;
  if (preview && (!s || !d || preview.obId !== obId)) {
    preview.mesh.removeFromParent();
    preview.mesh.geometry.dispose();
    if (!d || !s) preview = null;
  }
  if (!s || !d) {
    renderContext?.engine.requestDraw();
    return;
  }
  if (!preview) preview = { obId: s.id, mesh: newGPMesh(s.id) };
  const gp = gpOf(app.doc, app.doc.objects[s.id]);
  if (!gp) return;
  const b = buildStrokeBuffers(d, materialStyles(app.doc, gp), 0, layer?.radius_offset ?? 0);
  preview.mesh.geometry.dispose();
  preview.mesh.geometry = geometryFromBuffers(b);
  const u = preview.mesh.material.uniforms;
  u.uOpacity.value = layer?.opacity ?? 1;
  u.uOrderBase.value = 200000;
  preview.mesh.userData.mode3D = s.mode3D;
  preview.mesh.matrix.copy(layer ? layerMatrix(layer) : new Matrix4());
  if (preview.mesh.parent !== s.group) s.group.add(preview.mesh);
  preview.mesh.updateMatrixWorld(true);
  preview.mesh.visible = true;
  renderContext?.engine.requestDraw();
}

// no selection outline on the object being drawn / sculpted
drawHooks.skipOutline.push((ob) => (app.doc.mode === 'PAINT_GREASE_PENCIL' || app.doc.mode === 'SCULPT_GREASE_PENCIL') && app.doc.scene.active_object === ob.id);
