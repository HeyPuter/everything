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
  ZeroFactor,
  DstColorFactor,
  AddEquation,
  ReverseSubtractEquation,
  LessDepth,
  LessEqualDepth,
  AlwaysDepth,
  WebGLRenderTarget,
  UnsignedByteType,
  HalfFloatType,
  PlaneGeometry,
  OrthographicCamera,
  Scene,
  Color,
  AlwaysStencilFunc,
  EqualStencilFunc,
  ReplaceStencilOp,
  KeepStencilOp,
  RepeatWrapping,
  ClampToEdgeWrapping,
  type Camera,
  type WebGLRenderer,
  type Texture,
} from 'three';
import { imageTexture } from '../render/images';
import { app } from '../app/app';
import type { DocumentData, ObjectData } from '../data/types';
import type { EvalObject } from '../eval/depsgraph';
import { sceneSyncHooks } from '../render/scene';
import { drawHooks, type DrawView } from '../editors/view3d/draw';
import { renderContext } from '../render/context';
import { renderSceneHooks, renderVisibleObjects } from '../render/final/renderscene';
import { buildStrokeBuffers, type StrokeBuffers, type StrokeStyle } from './geometry';
import { gpOf, frameAt, onionFrames, onionAlpha, slotStyle } from './data';
import { evaluatedDrawing } from './curves';
import type { GPDrawing, GPLayer, GreasePencilData } from './types';
import { activeModifiers, layerFrame, evaluateDrawing, generatorTypes } from './modifiers';
import { applyEffects } from './effectsgl';
import { fadeFactor } from './overlays';
import type { ShaderFx } from './types';

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
attribute vec2 aSU;
uniform vec2 uViewport;
uniform float uRadiusScale;
varying vec2 vPix;
varying vec2 vUV;
flat varying vec2 vS0;
flat varying vec2 vS1;
flat varying vec2 vR;
flat varying vec4 vC0;
flat varying vec4 vC1;
flat varying vec4 vInfo;
flat varying vec2 vZ;
flat varying vec3 vN0;
flat varying vec3 vN1;
flat varying vec3 vTex;
flat varying vec2 vSU;
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
  // stroke textures: segment length and world radii (the distance along the stroke is in aInfo.w)
  vTex = vec3(distance(aP0, aP1), aR.x, aR.y);
  vSU = aSU;
  vC0 = aC0;
  vC1 = aC1;
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c0 = mvp * vec4(aP0, 1.0);
  vPix = vec2(0.0);
  vS0 = vec2(0.0);
  vS1 = vec2(0.0);
  vR = vec2(0.0);
  vZ = vec2(0.5);
  vUV = aN0.xy;
  if (kind == 0) {
    // fills: gradient kind and factor
    vN0 = vec3(0.0, aN0.z, aN0.w);
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
  if (kind == 1 || kind == 2) {
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
  if (kind == 4) {
    // corner join: bevel triangle on the outer side, plus the miter tip when the corner is
    // not sharper than the limit (aN1.w)
    vec4 cn = mvp * vec4(aN1.xyz, 1.0);
    vec2 sp = s1, sc = s0;
    vec2 sn = cn.w > 1e-6 ? (cn.xy / cn.w * 0.5 + 0.5) * uViewport : s0;
    vec2 da = sc - sp, db = sn - sc;
    da = length(da) > 1e-4 ? normalize(da) : vec2(1.0, 0.0);
    db = length(db) > 1e-4 ? normalize(db) : da;
    float turn = da.x * db.y - da.y * db.x;
    vec2 oa = turn > 0.0 ? vec2(da.y, -da.x) : vec2(-da.y, da.x);
    vec2 ob = turn > 0.0 ? vec2(db.y, -db.x) : vec2(-db.y, db.x);
    // half a pixel wider (like the segments' anti-aliased edge) and reaching a pixel into the
    // segments, so no seam shows where they meet
    float r = max(r0, 0.5) + 0.5;
    float theta = acos(clamp(dot(-da, db), -1.0, 1.0));
    int id = int(aCorner.x + 0.5) * 2 + (aCorner.y > 0.0 ? 1 : 0);
    vec2 va = sc + oa * r - da, vb = sc + ob * r + db;
    vec2 tip = vb;
    if (theta >= aN1.w && theta > 0.01) {
      vec2 m = oa + ob;
      float ml = length(m);
      if (ml > 1e-4) tip = sc + m / ml * (r / max(sin(theta * 0.5), 0.05));
    }
    pix = id == 0 ? sc - (oa + ob) * 0.5 : id == 1 ? va : id == 2 ? vb : tip;
    vS0 = sc;
    z = c0.z / c0.w;
    vPix = pix;
    gl_Position = vec4(pix / uViewport * 2.0 - 1.0, clamp(z, -1.0, 1.0), 1.0);
    return;
  }
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
uniform sampler2D uFillTex;
uniform sampler2D uStrokeTex;
/** stroke texture: blend toward the base color, length of a repeat in stroke widths; fill texture clamp */
uniform vec3 uTexParams;
varying vec2 vPix;
varying vec2 vUV;
flat varying vec2 vS0;
flat varying vec2 vS1;
flat varying vec2 vR;
flat varying vec4 vC0;
flat varying vec4 vC1;
flat varying vec4 vInfo;
flat varying vec2 vZ;
flat varying vec3 vN0;
flat varying vec3 vN1;
flat varying vec3 vTex;
flat varying vec2 vSU;
vec4 strokeTexel(vec2 uv, vec4 base) {
  vec4 tc = texture2D(uStrokeTex, uv);
  return vec4(mix(tc.rgb, base.rgb, uTexParams.x), base.a * mix(tc.a, 1.0, uTexParams.x));
}
/** Edge softness: alpha falls from 1 at (1 - softness) of the radius to 0 at the edge. */
float softEdge(float d, float r, float soft) {
  float a = clamp((max(r, 0.5) - d) / max(r * soft, 0.75), 0.0, 1.0);
  return a * a * (3.0 - 2.0 * a);
}
float capsuleSoft(vec2 p, vec2 a, vec2 b, float ra, float rb, float soft) {
  vec2 ab = b - a;
  float L2 = dot(ab, ab);
  float t = L2 > 1e-8 ? clamp(dot(p - a, ab) / L2, 0.0, 1.0) : 0.0;
  return softEdge(length(p - (a + ab * t)), mix(ra, rb, t), soft);
}
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
  float soft = 0.0;
  float softA = 1.0;
  vec4 vC0Tex = vec4(0.0);
  bool useTex = false;
  if (kind == 0) {
    col = vC0;
    if (vN0.y > 2.5) {
      // image texture, blended toward the base color by the mix factor
      vec2 uv = vUV;
      vec4 tc = texture2D(uFillTex, uv);
      if (uTexParams.z > 0.5 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) tc = vec4(0.0);
      col = vec4(mix(tc.rgb, vC0.rgb, vN0.z), vC0.a * mix(tc.a, 1.0, vN0.z));
    } else if (vN0.y > 0.5) {
      // gradient: linear along u, or radial from the center; the factor moves the midpoint
      float g = vN0.y < 1.5 ? vUV.x : length(vUV - 0.5) * 2.0;
      g = clamp(g, 0.0, 1.0);
      float f = clamp(vN0.z, 0.01, 0.99);
      g = g < f ? 0.5 * g / f : 0.5 + 0.5 * (g - f) / (1.0 - f);
      col = mix(vC0, vC1, g);
    }
  } else if (kind == 1) {
    vec2 ab = vS1 - vS0;
    float L2 = dot(ab, ab);
    float tr = L2 > 1e-8 ? dot(vPix - vS0, ab) / L2 : 0.0;
    int flags = int(vInfo.z + 0.5);
    // cut ends (flat caps, cut joints) stop a fraction of a pixel past the end point so the
    // segments meeting there leave no pixel undrawn between them
    float pad = L2 > 1e-8 ? 0.6 / sqrt(L2) : 0.0;
    if ((flags & 1) != 0 && tr < -pad) discard;
    if ((flags & 2) != 0 && tr > 1.0 + pad) discard;
    t = clamp(tr, 0.0, 1.0);
    float r = mix(vR.x, vR.y, t);
    float d = length(vPix - (vS0 + ab * t));
    cov = clamp(max(r, 0.5) + 0.5 - d, 0.0, 1.0) * clamp(r * 2.0, 0.0, 1.0);
    if (cov <= 0.0) discard;
    soft = float(flags >> 4) / 255.0;
    if (soft > 0.0) {
      // the soft field of the joined stroke: the strongest of this segment and its neighbours,
      // so round segment ends do not show through as rings
      softA = softEdge(d, r, soft);
      if (vN0.z > 0.0) softA = max(softA, capsuleSoft(vPix, vN0.xy, vS0, vN0.z, vR.x, soft));
      if (vN1.z > 0.0) softA = max(softA, capsuleSoft(vPix, vS1, vN1.xy, vR.y, vN1.z, soft));
    }
    // a partially covered pixel that a neighbouring segment covers fully is drawn by that one
    // (not across a cut joint: the neighbour stops there too)
    if (cov < 0.999) {
      if (vN0.z > 0.0 && (flags & 1) == 0 && capsuleCov(vPix, vN0.xy, vS0, vN0.z, vR.x) >= 0.999) discard;
      if (vN1.z > 0.0 && (flags & 2) == 0 && capsuleCov(vPix, vS1, vN1.xy, vR.y, vN1.z) >= 0.999) discard;
    }
    col = mix(vC0, vC1, t);
    if ((flags & 4096) != 0) {
      // u along the stroke (precomputed at the segment ends), v across it
      vec2 nrm = L2 > 1e-8 ? vec2(-ab.y, ab.x) / sqrt(L2) : vec2(0.0, 1.0);
      float side = dot(vPix - (vS0 + ab * t), nrm);
      col = strokeTexel(vec2(mix(vSU.x, vSU.y, t), 0.5 + 0.5 * side / max(r, 0.5)), col);
    }
    col.a *= cov;
    zReal = mix(vZ.x, vZ.y, t);
  } else if (kind == 4) {
    col = vC0;
    zReal = vZ.x;
  } else {
    vec2 p = vPix - vS0;
    float r = vR.x;
    float d;
    if (kind == 2) d = length(p);
    else {
      vec2 ab = vS1 - vS0;
      vec2 dir = dot(ab, ab) > 1e-8 ? normalize(ab) : vec2(1.0, 0.0);
      // extra rotation of the square (material rotation, randomness)
      dir = vec2(cos(vSU.x) * dir.x - sin(vSU.x) * dir.y, sin(vSU.x) * dir.x + cos(vSU.x) * dir.y);
      vec2 q = vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x)));
      d = max(abs(q.x), abs(q.y));
    }
    cov = clamp(max(r, 0.5) + 0.5 - d, 0.0, 1.0) * clamp(r * 2.0, 0.0, 1.0);
    if (cov <= 0.0) discard;
    if ((int(vInfo.z + 0.5) & 4096) != 0) {
      if (kind == 2 && (vN0.z > 0.0 || vN1.z > 0.0)) {
        // joint of a textured line: continue the texture of the segments around it
        vec2 jd = vN1.z > 0.0 && vN0.z > 0.0 ? vN1.xy - vN0.xy : vN1.z > 0.0 ? vN1.xy - vS0 : vS0 - vN0.xy;
        jd = dot(jd, jd) > 1e-8 ? normalize(jd) : vec2(1.0, 0.0);
        float rw = max(vTex.y, 1e-6), rp = max(r, 0.5);
        // u at the joint plus the change along the stroke direction (per world unit)
        vC0Tex = strokeTexel(vec2(vSU.x + dot(p, jd) * rw / rp * vSU.y, 0.5 + 0.5 * dot(p, vec2(-jd.y, jd.x)) / rp), vC0);
      } else {
        // textured dots / squares: the image stamped on each point
        vec2 ab2 = vS1 - vS0;
        vec2 dir2 = dot(ab2, ab2) > 1e-8 ? normalize(ab2) : vec2(1.0, 0.0);
        vec2 q2 = kind == 3 ? vec2(dot(p, dir2), dot(p, vec2(-dir2.y, dir2.x))) : p;
        // alignment rotation of the stamped image (Texture Mapping)
        float cr = cos(vSU.x), sr = sin(vSU.x);
        q2 = vec2(cr * q2.x - sr * q2.y, sr * q2.x + cr * q2.y);
        vC0Tex = strokeTexel(0.5 + q2 / (2.0 * max(r, 0.5)), vC0);
      }
      useTex = true;
    }
    soft = float(int(vInfo.z + 0.5) >> 4) / 255.0;
    if (soft > 0.0) {
      softA = softEdge(d, r, soft);
      // a joint of a soft stroke: as strong as the segments on either side
      if (vN0.z > 0.0) softA = max(softA, capsuleSoft(vPix, vN0.xy, vS0, vN0.z, r, soft));
      if (vN1.z > 0.0) softA = max(softA, capsuleSoft(vPix, vS0, vN1.xy, r, vN1.z, soft));
    }
    col = useTex ? vC0Tex : vC0;
    col.a *= cov;
    zReal = vZ.x;
  }
  // soft edges fade the color only: the coverage used for ordering stays the same
  col.a *= softA;
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
      uFillTex: { value: null },
      uStrokeTex: { value: null },
      uTexParams: { value: new Vector3(0, 1, 0) },
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
  if (mode === 'HOLDOUT') {
    // erase: destination × (1 − source alpha), color and alpha alike
    m.blendEquation = m.blendEquationAlpha = AddEquation;
    m.blendSrc = m.blendSrcAlpha = ZeroFactor;
    m.blendDst = m.blendDstAlpha = OneMinusSrcAlphaFactor;
    return;
  }
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
  return `${aid(d.position)}.${aid(d.radius)}.${aid(d.opacity)}.${aid(d.vertex_color)}.${aid(d.offsets)}.${aid(d.cyclic)}.${aid(d.material_index)}.${aid(d.start_cap)}.${aid(d.end_cap)}.${aid(d.fill_color)}.${aid(d.fill_opacity)}.${aid(d.fill_id)}.${aid(d.stroke_type)}.${aid(d.is_fill_guide)}.${aid(d.miter_angle)}.${aid(d.uv_translation)}.${aid(d.uv_rotation)}.${aid(d.uv_scale)}.${aid(d.softness)}.${aid(d.uv_stroke)}`;
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
  g.setAttribute('aSU', new BufferAttribute(b.uv, 2));
  g.setIndex(new BufferAttribute(b.index, 1));
  return g;
}

function styleKey(styles: (StrokeStyle | null)[]) {
  return styles.map((s) => (s ? `${+s.stroke}${+s.fill}${s.mode}${s.alignment ?? ''}${s.color.join(',')}|${s.fillColor.join(',')}|${s.gradient ? JSON.stringify(s.gradient) : ''}|${+!!s.holdoutStroke}${+!!s.holdoutFill}|${s.fillTex ? JSON.stringify(s.fillTex) : ''}|${s.strokeTex ? JSON.stringify(s.strokeTex) : ''}|${s.placement ? JSON.stringify(s.placement) : ''}|${s.alignRotation ?? 0}|${s.random ? JSON.stringify(s.random) : ''}` : '-')).join(';');
}

function cachedGeometry(d0: GPDrawing, styles: (StrokeStyle | null)[], radiusOffset: number, holdout = false, guides = false, slots?: { key: string; test: (k: number) => boolean }): CachedGeo {
  // smooth strokes (Bézier, NURBS, Catmull-Rom) draw their evaluated poly lines
  const d = evaluatedDrawing(d0);
  const key = `${drawingKey(d)}#${styleKey(styles)}#${radiusOffset}#${+holdout}#${+guides}#${slots?.key ?? ''}`;
  let c = geoCache.get(key);
  if (!c) {
    const b = buildStrokeBuffers(d, styles, 0, radiusOffset, holdout, guides, slots?.test);
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
      gradient:
        st.fill_style === 'GRADIENT'
          ? {
              type: st.gradient_type ?? 'LINEAR',
              mix: [...(st.mix_color ?? [1, 1, 1, 1])] as [number, number, number, number],
              factor: st.mix_factor ?? 0.5,
              flip: !!st.flip,
              offset: [...(st.texture_offset ?? [0, 0])] as [number, number],
              angle: st.texture_angle ?? 0,
              scale: [...(st.texture_scale ?? [1, 1])] as [number, number],
            }
          : undefined,
      holdoutStroke: !!st.use_stroke_holdout,
      holdoutFill: !!st.use_fill_holdout,
      fillTex:
        !ghost && st.fill_style === 'TEXTURE' && st.fill_image && doc.images[st.fill_image]
          ? { image: st.fill_image, mix: st.mix_factor ?? 0, clamp: !!st.texture_clamp, offset: [...(st.texture_offset ?? [0, 0])] as [number, number], angle: st.texture_angle ?? 0, scale: [...(st.texture_scale ?? [1, 1])] as [number, number] }
          : undefined,
      strokeTex: !ghost && st.stroke_style === 'TEXTURE' && st.stroke_image && doc.images[st.stroke_image] ? { image: st.stroke_image, mix: st.mix_stroke_factor ?? 0, uvFactor: st.pixel_size ?? 1 } : undefined,
      placement: st.mode !== 'LINE' && st.placement_mode ? { mode: st.placement_mode, count: st.placement_count ?? 1, spacing: st.placement_radius_spacing ?? 100, density: st.placement_density ?? 10 } : undefined,
      alignRotation: st.alignment_rotation ?? 0,
      random:
        st.mode !== 'LINE' && st.use_randomization
          ? { size: st.random_size_factor ?? 0, strength: st.random_strength_factor ?? 0, rotation: st.random_rotation_factor ?? 0, hue: st.random_hue_factor ?? 0, sat: st.random_saturation_factor ?? 0, val: st.random_value_factor ?? 0, scale: st.random_noise_scale ?? 1 }
          : undefined,
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
    holdout?: boolean;
    maskPass?: boolean;
    idMat?: ShaderMaterial;
    inFront?: boolean;
    mode3D?: boolean;
    rootless?: boolean;
    /** layer blend mode combined in a pass of its own */
    combine?: 'HARDLIGHT' | 'DIVIDE';
  };
}

interface GPSynced {
  id: string;
  scene: Scene;
  group: Group;
  meshes: GPMesh[];
  /** stencil passes for layer masks */
  maskMeshes: Mesh[];
  mode3D: boolean;
  inFront: boolean;
  /** some layer is masked (needs the offscreen image with a stencil buffer) */
  masked: boolean;
}

const synced = new Map<string, GPSynced>();

/** Parent transforms of layers (object space), refreshed on every sync of their object. */
const layerParents = new WeakMap<GPLayer, Matrix4>();

/** Layer space → object space: the layer's own transform, after its parent's when it has one. */
export function layerMatrix(l: GPLayer): Matrix4 {
  const m = new Matrix4().compose(new Vector3(...l.translation), new Quaternion().setFromEuler(new Euler(l.rotation[0], l.rotation[1], l.rotation[2], 'XYZ')), new Vector3(...l.scale));
  const p = l.parent ? layerParents.get(l) : undefined;
  return p ? p.clone().multiply(m) : m;
}

/** World matrix a layer parent target has (an object, or one of its pose bones). */
export function parentWorld(l: GPLayer): Matrix4 | null {
  const ev = l.parent ? app.graph.get(l.parent) : undefined;
  if (!ev) return null;
  const w = ev.world.clone();
  if (l.parent_type === 'BONE' && l.parent_bone && ev.pose) {
    const b = ev.pose.bones.get(l.parent_bone);
    if (b) w.multiply(b.pose);
  }
  return w;
}

/** Update the parent transforms of an object's layers (object space: own⁻¹ · parent · parent inverse). */
export function updateLayerParents(gp: GreasePencilData, obWorld: Matrix4) {
  const inv = obWorld.clone().invert();
  for (const l of gp.layers) {
    const pw = l.parent ? parentWorld(l) : null;
    if (!pw) {
      layerParents.delete(l);
      continue;
    }
    const pinv = l.parent_inverse ? new Matrix4().fromArray(l.parent_inverse) : new Matrix4();
    layerParents.set(l, inv.clone().multiply(pw).multiply(pinv));
  }
}

/** Modes that show onion skins (while drawing/editing). */
const ONION_MODES = new Set(['PAINT_GREASE_PENCIL', 'EDIT', 'SCULPT_GREASE_PENCIL']);

export const gpDisplay = {
  /** default of the per-viewport overlay toggle (overlay.use_gpencil_onion_skin) */
  onionDefault: true,
};

/** Onion skins are built for the active object in the drawing modes, and for every object in Object Mode (views filter them). */
function wantOnion(doc: DocumentData, obId: string) {
  if (app.playing) return false;
  return doc.mode === 'OBJECT' || (doc.scene.active_object === obId && ONION_MODES.has(doc.mode));
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
  /** holdout strokes / fills of the layer: they erase what is under them */
  holdout?: boolean;
  /** layer masks: geometry of the mask layers (inverted ones cut away) */
  masks?: { geo: BufferGeometry; layer: GPLayer; invert: boolean }[];
  geo: BufferGeometry;
  orderBase: number;
  layer: GPLayer;
  layerIndex: number;
  onion: boolean;
  onionColor: [number, number, number, number];
  alpha: number;
  /** a textured material's own pass */
  tex?: StrokeStyle;
}

/** Styles without image textures (passes that do not bind them: holdouts, masks). */
const untextured = (styles: (StrokeStyle | null)[]) => styles.map((st) => (st && (st.fillTex || st.strokeTex) ? { ...st, fillTex: undefined, strokeTex: undefined } : st));

/** Replace a drawing for display (e.g. weight colors in Weight Paint); null keeps it. */
export const drawingDisplayHooks: ((ob: ObjectData, gp: GreasePencilData, d: GPDrawing) => GPDrawing | null)[] = [];

/** Everything drawn for a GP object at the current frame (onion skins first, then layers bottom→top). */
export function objectEntries(doc: DocumentData, gp: GreasePencilData, frame: number, onion: boolean, ob?: ObjectData, render = false): Entry[] {
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
  const mods = ob ? activeModifiers(ob, render) : [];
  const obWorld = ob ? (app.graph.get(ob.id)?.world ?? new Matrix4()) : new Matrix4();
  gp.layers.forEach((layer, li) => {
    if (layer.hide) return;
    const shownFrame = ob && mods.length ? layerFrame(ob, { layer, layerIndex: li, doc, gp }, frame, mods) : frame;
    const fr = frameAt(layer, shownFrame);
    let d = fr ? gp.drawings[fr.drawing] : undefined;
    if (!d || (d.offsets.length < 2 && !mods.some((m) => generatorTypes.has(m.type)))) return;
    if (ob && mods.length) {
      d = evaluatedDrawing(d);
      const k = layer.frames.indexOf(fr!);
      const prev = k > 0 ? gp.drawings[layer.frames[k - 1].drawing] : undefined;
      d = evaluateDrawing(d, { doc, ob, gp, layer, layerIndex: li, frame: shownFrame, keyFrame: fr!.frame_number, nextKeyFrame: layer.frames[k + 1]?.frame_number ?? null, prevStrokeCount: prev ? prev.offsets.length - 1 : 0, world: obWorld.clone().multiply(layerMatrix(layer)) }, mods);
      if (d.offsets.length < 2) return;
    }
    if (ob) for (const hk of drawingDisplayHooks) d = hk(ob, gp, d) ?? d;
    // textured materials draw in passes of their own (each binds its images), in the same order
    const texSlots = styles.map((st, k) => (st && (st.fillTex || st.strokeTex) ? k : -1)).filter((k) => k >= 0);
    const c = cachedGeometry(d, styles, layer.radius_offset, false, !render, texSlots.length ? { key: `plain:${texSlots.join(',')}`, test: (k) => !texSlots.includes(k) } : undefined);
    const masks = layer.use_masks ? maskGeometry(gp, layer, frame, styles) : undefined;
    entries.push({
      masks,
      geo: c.geo,
      orderBase: order,
      layer,
      layerIndex: li,
      onion: false,
      onionColor: [0, 0, 0, 0],
      alpha: 1,
    });
    for (const k of texSlots) {
      const tc = cachedGeometry(d, styles, layer.radius_offset, false, !render, { key: `tex:${k}`, test: (x) => x === k });
      entries.push({ masks, geo: tc.geo, orderBase: order, layer, layerIndex: li, onion: false, onionColor: [0, 0, 0, 0], alpha: 1, tex: styles[k]! });
    }
    if (styles.some((st) => st?.holdoutStroke || st?.holdoutFill)) {
      // drawn right after the layer with the same draw orders: strokes above a holdout stay
      const hc = cachedGeometry(d, untextured(styles), layer.radius_offset, true);
      entries.push({ holdout: true, masks, geo: hc.geo, orderBase: order, layer, layerIndex: li, onion: false, onionColor: [0, 0, 0, 0], alpha: 1 });
    }
    order += c.orders;
  });
  return entries;
}

/** Geometry of the layers masking `layer` at a frame (the mask list's own hide toggles apply). */
function maskGeometry(gp: GreasePencilData, layer: GPLayer, frame: number, styles: (StrokeStyle | null)[]): Entry['masks'] {
  const out: NonNullable<Entry['masks']> = [];
  for (const mk of layer.mask_layers ?? []) {
    if (mk.hide) continue;
    const ml = gp.layers.find((l) => l.name === mk.name);
    if (!ml || ml === layer) continue;
    const fr = frameAt(ml, frame);
    const d = fr ? gp.drawings[fr.drawing] : undefined;
    // an empty mask hides the layer completely (or nothing, inverted)
    out.push({ geo: d && d.offsets.length > 1 ? cachedGeometry(d, untextured(styles), ml.radius_offset).geo : new BufferGeometry(), layer: ml, invert: mk.invert });
  }
  return out.length ? out : undefined;
}

const stencilQuadGeo = new PlaneGeometry(2, 2);
function stencilMaterial(kind: 'CLEAR' | 'MASK', ref: number): ShaderMaterial {
  const m = kind === 'MASK' ? makeMaterial(false) : new ShaderMaterial({ vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }' });
  m.colorWrite = false;
  m.depthWrite = false;
  m.depthTest = false;
  m.stencilWrite = true;
  m.stencilFunc = AlwaysStencilFunc;
  m.stencilRef = ref;
  m.stencilZPass = ReplaceStencilOp;
  m.stencilZFail = ReplaceStencilOp;
  m.stencilFail = ReplaceStencilOp;
  return m;
}

/** Stencil passes in front of a masked layer: reset, then positive masks write 1, inverted ones 0. */
function syncMasks(s: GPSynced, e: Entry, order: { n: number }, used: { n: number }, mode3D: boolean) {
  const masks = e.masks!;
  const anyPositive = masks.some((x) => !x.invert);
  const take = (kind: 'CLEAR' | 'MASK', ref: number): Mesh => {
    let m = s.maskMeshes[used.n];
    if (!m || (m.userData.kind as string) !== `${kind}${ref}`) {
      if (m) m.removeFromParent();
      m = kind === 'CLEAR' ? new Mesh(stencilQuadGeo, stencilMaterial('CLEAR', ref)) : newGPMesh(s.id);
      if (kind === 'MASK') m.material = stencilMaterial('MASK', ref);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.userData = { ...(m.userData ?? {}), kind: `${kind}${ref}`, id: s.id, gpencil: true, maskPass: true };
      s.maskMeshes[used.n] = m;
      s.group.add(m);
    }
    used.n++;
    m.visible = true;
    m.renderOrder = order.n++;
    return m;
  };
  take('CLEAR', anyPositive ? 0 : 1);
  for (const pass of [false, true])
    for (const mk of masks) {
      if (mk.invert !== pass) continue;
      const m = take('MASK', mk.invert ? 0 : 1) as GPMesh;
      m.geometry = mk.geo;
      m.userData.mode3D = mode3D;
      m.userData.onion = false;
      m.matrix.copy(layerMatrix(mk.layer));
      const u = m.material.uniforms;
      u.uOpacity.value = 1;
      u.uOrderBase.value = e.orderBase;
    }
}

/** An image as a texture for strokes / fills: repeating (or clamped), sharing the image's pixels. */
const texClones = new WeakMap<Texture, { rep?: Texture; clamp?: Texture; v: number }>();
function gpTexture(imageId: string, clamp: boolean): Texture | null {
  const img = app.doc.images[imageId];
  if (!img) return null;
  const base = imageTexture(img);
  let e = texClones.get(base);
  // new pixels in the image: copy again
  if (!e || e.v !== base.version) texClones.set(base, (e = { v: base.version }));
  const k = clamp ? 'clamp' : 'rep';
  let t = e[k];
  if (!t) {
    t = base.clone();
    t.wrapS = t.wrapT = clamp ? ClampToEdgeWrapping : RepeatWrapping;
    t.needsUpdate = true;
    e[k] = t;
  }
  return t;
}

function applyEntry(m: GPMesh, e: Entry, ob: { show_in_front: boolean }, mode3D: boolean) {
  m.geometry = e.geo;
  const u = m.material.uniforms;
  u.uOpacity.value = e.layer.opacity * e.alpha;
  u.uTint.value.set(e.layer.tint_color[0], e.layer.tint_color[1], e.layer.tint_color[2], e.layer.tint_factor);
  u.uOnion.value.set(...e.onionColor);
  u.uOrderBase.value = e.orderBase;
  u.uFillTex.value = e.tex?.fillTex ? gpTexture(e.tex.fillTex.image, e.tex.fillTex.clamp) : null;
  u.uStrokeTex.value = e.tex?.strokeTex ? gpTexture(e.tex.strokeTex.image, false) : null;
  u.uTexParams.value.set(e.tex?.strokeTex?.mix ?? 0, e.tex?.strokeTex?.uvFactor ?? 1, e.tex?.fillTex?.clamp ? 1 : 0);
  const blendMode = e.onion ? 'REGULAR' : e.holdout ? 'HOLDOUT' : e.layer.blend_mode;
  // hard light and divide read what lies below: drawn alone, then combined (renderObjectScene)
  m.userData.combine = blendMode === 'HARDLIGHT' || blendMode === 'DIVIDE' ? blendMode : undefined;
  setBlend(m.material, m.userData.combine ? 'REGULAR' : blendMode);
  m.material.depthWrite = !e.holdout;
  m.userData.holdout = !!e.holdout;
  m.userData.onion = e.onion;
  m.userData.layer = e.layerIndex;
  m.userData.inFront = ob.show_in_front;
  m.userData.mode3D = mode3D;
  m.matrix.copy(layerMatrix(e.layer));
  m.visible = true;
  // masked layers draw only where the stencil passes left a 1
  const masked = !!e.masks?.length;
  m.material.stencilWrite = masked;
  m.material.stencilFunc = EqualStencilFunc;
  m.material.stencilRef = 1;
  m.material.stencilZPass = KeepStencilOp;
  m.material.stencilZFail = KeepStencilOp;
  m.material.stencilFail = KeepStencilOp;
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
    s = { id: ev.id, scene, group, meshes: [], maskMeshes: [], mode3D: false, inFront: false, masked: false };
    synced.set(ev.id, s);
  }
  s.mode3D = gp.stroke_depth_order === '3D';
  s.inFront = ev.ob.show_in_front;
  s.group.matrix.copy(ev.world);
  updateLayerParents(gp, ev.world);
  fillSynced(s, objectEntries(doc, gp, doc.scene.frame_current, wantOnion(doc, ev.id), ev.ob), ev.ob);
}

/** Fill an object's private scene with meshes for its entries (and the mask stencil passes). */
function fillSynced(s: GPSynced, entries: Entry[], ob: ObjectData, viewport = true) {
  while (s.meshes.length < entries.length) {
    const m = newGPMesh(s.id);
    s.meshes.push(m);
    s.group.add(m);
  }
  const order = { n: 0 },
    used = { n: 0 };
  s.masked = entries.some((e) => !!e.masks?.length || !!e.holdout || (!e.onion && (e.layer.blend_mode === 'HARDLIGHT' || e.layer.blend_mode === 'DIVIDE')));
  s.meshes.forEach((m, i) => {
    const e = entries[i];
    if (!e) {
      m.visible = false;
      return;
    }
    if (e.masks?.length) syncMasks(s, e, order, used, s.mode3D);
    applyEntry(m, e, ob, s.mode3D);
    if (viewport && !e.onion && !e.holdout) m.material.uniforms.uOpacity.value *= fadeFactor(s.id, e.layerIndex, gpOf(app.doc, ob)?.active_layer_index ?? -1);
    m.renderOrder = order.n++;
  });
  for (let i = used.n; i < s.maskMeshes.length; i++) s.maskMeshes[i].visible = false;
  s.group.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// layer blend modes that read the image below (hard light, divide)

let combineDest: WebGLRenderTarget | null = null,
  combineLayer: WebGLRenderTarget | null = null;
const combineCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
const copyMat = new ShaderMaterial({
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D tColor; varying vec2 vUv; void main() { gl_FragColor = texture2D(tColor, vUv); }',
  uniforms: { tColor: { value: null } },
  depthTest: false,
  depthWrite: false,
  blending: CustomBlending,
  blendSrc: OneFactor,
  blendDst: ZeroFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: ZeroFactor,
});
const combineMat = new ShaderMaterial({
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDest;
    uniform sampler2D tSrc;
    uniform int uMode;
    varying vec2 vUv;
    void main() {
      vec4 d = texture2D(tDest, vUv);
      vec4 s = texture2D(tSrc, vUv);
      if (s.a <= 0.0) { gl_FragColor = d; return; }
      vec3 sc = s.rgb / s.a;
      vec3 base = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
      vec3 b;
      if (uMode == 0) b = mix(2.0 * base * sc, 1.0 - 2.0 * (1.0 - base) * (1.0 - sc), step(0.5, sc));
      else b = clamp(base / max(sc, vec3(1e-4)), 0.0, 1.0);
      // over nothing the layer shows as it is
      vec3 c = mix(sc, b, d.a);
      gl_FragColor = vec4(c * s.a + d.rgb * (1.0 - s.a), s.a + d.a * (1.0 - s.a));
    }`,
  uniforms: { tDest: { value: null }, tSrc: { value: null }, uMode: { value: 0 } },
  depthTest: false,
  depthWrite: false,
  blending: CustomBlending,
  blendSrc: OneFactor,
  blendDst: ZeroFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: ZeroFactor,
});
const combineQuad = new Mesh(new PlaneGeometry(2, 2), copyMat);
combineQuad.frustumCulled = false;
const combineScene = new Scene();
combineScene.add(combineQuad);

/**
 * Draw a GP object's meshes into `target` (already cleared). Layers blending by hard light or
 * divide are drawn into an image of their own and combined with what the layers below left.
 */
function renderObjectScene(r: WebGLRenderer, s: GPSynced, camera: Camera, target: WebGLRenderTarget) {
  const special = s.meshes.filter((m) => m.visible && m.userData.combine).sort((a, b) => a.renderOrder - b.renderOrder);
  if (!special.length) {
    r.render(s.scene, camera);
    return;
  }
  const all: Mesh[] = [...s.meshes, ...s.maskMeshes].filter((m) => m.visible);
  const W = target.width,
    H = target.height;
  combineDest ??= new WebGLRenderTarget(W, H, { type: target.texture.type });
  combineLayer ??= new WebGLRenderTarget(W, H, { samples: 4, depthBuffer: true, stencilBuffer: true, type: target.texture.type });
  if (combineDest.width !== W || combineDest.height !== H) combineDest.setSize(W, H);
  if (combineLayer.width !== W || combineLayer.height !== H) combineLayer.setSize(W, H);
  const show = (fn: (m: Mesh) => boolean) => all.forEach((m) => (m.visible = fn(m)));
  let lo = -Infinity;
  for (const sp of special) {
    // the layers below
    show((m) => m !== sp && m.renderOrder > lo && m.renderOrder < sp.renderOrder);
    r.setRenderTarget(target);
    r.render(s.scene, camera);
    // a copy of them, the layer alone, then both combined
    combineQuad.material = copyMat;
    copyMat.uniforms.tColor.value = target.texture;
    r.setRenderTarget(combineDest);
    r.render(combineScene, combineCam);
    // (with the stencil passes of its masks)
    show((m) => m === sp || (s.maskMeshes.includes(m) && m.renderOrder > lo && m.renderOrder < sp.renderOrder));
    r.setRenderTarget(combineLayer);
    r.clear(true, true, true);
    r.render(s.scene, camera);
    combineQuad.material = combineMat;
    combineMat.uniforms.tDest.value = combineDest.texture;
    combineMat.uniforms.tSrc.value = combineLayer.texture;
    combineMat.uniforms.uMode.value = sp.userData.combine === 'DIVIDE' ? 1 : 0;
    r.setRenderTarget(target);
    r.render(combineScene, combineCam);
    lo = sp.renderOrder;
  }
  show((m) => m.renderOrder > lo);
  r.setRenderTarget(target);
  r.render(s.scene, camera);
  all.forEach((m) => (m.visible = true));
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
/** Composites an object image (premultiplied) into the scene at a given depth. */
function makeComposite(): ShaderMaterial {
  return new ShaderMaterial({
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
}
const compositeMat = makeComposite();
const compositeQuad = new Mesh(new PlaneGeometry(2, 2), compositeMat);
compositeQuad.frustumCulled = false;
const compositeScene = new Scene();
compositeScene.add(compositeQuad);
const compositeCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

// stroke colors are rendered linear (no tone mapping) into the offscreen target; the composite
// applies the view transform once
for (const m of [compositeMat]) m.toneMapped = true;

/** Visual effects shown in the viewport for an object. */
function viewportEffects(id: string): ShaderFx[] {
  return (app.doc.objects[id]?.shader_effects ?? []).filter((f) => f.show_viewport);
}

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
  const activeOnly = !!(view.overlay as { use_gpencil_onion_skin_active_object?: boolean }).use_gpencil_onion_skin_active_object;
  for (const s of list) {
    const hidden: GPMesh[] = [];
    if (!onion || (activeOnly && s.id !== app.doc.scene.active_object))
      for (const m of s.meshes)
        if (m.userData.onion && m.visible) {
          m.visible = false;
          hidden.push(m);
        }
    const fx = viewportEffects(s.id);
    if (s.mode3D && !fx.length && !s.masked) {
      // real depth, straight into the framebuffer
      r.render(s.scene, camera);
    } else {
      if (!rt)
        rt = new WebGLRenderTarget(W, H, {
          samples: 4,
          depthBuffer: true,
          stencilBuffer: true,
          type: UnsignedByteType,
        });
      if (rt.width !== W || rt.height !== H) rt.setSize(W, H);
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
      renderObjectScene(r, s, camera, rt);
      r.setRenderTarget(prevTarget);
      let tex: Texture = rt.texture;
      if (fx.length) {
        tmpV.setFromMatrixPosition(s.group.matrixWorld).project(camera);
        const origin = new Vector2((tmpV.x * 0.5 + 0.5) * W, (tmpV.y * 0.5 + 0.5) * H);
        tex = applyEffects(r, rt.texture, W, H, fx, {
          origin,
          scale: 1,
          objectOrigin: (id) => {
            const ev = app.graph.get(id);
            if (!ev) return null;
            tmpV.setFromMatrixPosition(ev.world).project(camera);
            return new Vector2((tmpV.x * 0.5 + 0.5) * W, (tmpV.y * 0.5 + 0.5) * H);
          },
        });
      }
      compositeMat.uniforms.tColor.value = tex;
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
      if (m.userData.onion || m.userData.holdout || m.userData.maskPass) {
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

// objects with visual effects or masked layers render through their own image (see finalImage)
const finalImages = new WeakMap<object, Map<string, FinalImage>>();

interface FinalImage {
  s: GPSynced;
  proxy: Mesh;
  mat: ShaderMaterial;
}

let finalRT: WebGLRenderTarget | null = null;

function finalImage(rs: { scene: Scene }, id: string, map: Map<string, FinalImage>): FinalImage {
  let f = map.get(id);
  if (f) return f;
  const scene = new Scene();
  scene.matrixWorldAutoUpdate = false;
  const group = new Group();
  group.matrixAutoUpdate = false;
  scene.add(group);
  const mat = makeComposite();
  mat.toneMapped = true;
  const proxy = new Mesh(new PlaneGeometry(2, 2), mat);
  proxy.frustumCulled = false;
  proxy.matrixAutoUpdate = false;
  const s: GPSynced = { id, scene, group, meshes: [], maskMeshes: [], mode3D: false, inFront: false, masked: false };
  f = { s, proxy, mat };
  // the object's strokes are drawn into an image (stencil masks, effects) right before the quad shows it
  proxy.onBeforeRender = (renderer: WebGLRenderer, _sc: Scene, camera: Camera) => {
    const prev = renderer.getRenderTarget();
    const size = prev ? new Vector2(prev.width, prev.height) : renderer.getDrawingBufferSize(new Vector2());
    const W = Math.max(1, size.x),
      H = Math.max(1, size.y);
    if (!finalRT) finalRT = new WebGLRenderTarget(W, H, { samples: 4, depthBuffer: true, stencilBuffer: true, type: HalfFloatType });
    if (finalRT.width !== W || finalRT.height !== H) finalRT.setSize(W, H);
    const clear = renderer.getClearColor(new Color()),
      alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(finalRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderObjectScene(renderer, s, camera, finalRT);
    let tex: Texture = finalRT.texture;
    const fx = (app.doc.objects[id]?.shader_effects ?? []).filter((x) => x.show_render);
    tmpV.setFromMatrixPosition(s.group.matrixWorld).project(camera);
    const depth = Math.min(1, Math.max(0, tmpV.z * 0.5 + 0.5));
    if (fx.length) {
      const origin = new Vector2((tmpV.x * 0.5 + 0.5) * W, (tmpV.y * 0.5 + 0.5) * H);
      tex = applyEffects(renderer, finalRT.texture, W, H, fx, {
        origin,
        scale: 1,
        objectOrigin: (oid) => {
          const ev = app.graph.get(oid);
          if (!ev) return null;
          const q = new Vector3().setFromMatrixPosition(ev.world).project(camera);
          return new Vector2((q.x * 0.5 + 0.5) * W, (q.y * 0.5 + 0.5) * H);
        },
      });
    }
    renderer.setRenderTarget(prev);
    renderer.setClearColor(clear, alpha);
    mat.uniforms.tColor.value = tex;
    mat.uniforms.uDepth.value = s.inFront ? 0 : depth;
    mat.depthFunc = s.inFront ? AlwaysDepth : LessEqualDepth;
  };
  map.set(id, f);
  rs.scene.add(proxy);
  return f;
}

renderSceneHooks.push((rs, appRef, o) => {
  let byOb = renderMeshes.get(rs);
  if (!byOb) renderMeshes.set(rs, (byOb = new Map()));
  let images = finalImages.get(rs);
  if (!images) finalImages.set(rs, (images = new Map()));
  const doc = appRef.doc;
  const seen = new Set<string>();
  const seenImages = new Set<string>();
  if (o.mode === 'raster') {
    const renderable = o.final ? renderVisibleObjects(doc) : null;
    for (const ev of appRef.graph.objects.values()) {
      const gp = gpOf(doc, ev.ob);
      if (!gp) continue;
      const visible = renderable ? renderable.has(ev.id) : ev.visible && !ev.ob.hide_render;
      if (!visible || (o.localView && !o.localView.has(ev.id))) continue;
      updateLayerParents(gp, ev.world);
      const entries = objectEntries(doc, gp, doc.scene.frame_current, false, ev.ob, !!o.final);
      if ((ev.ob.shader_effects ?? []).some((f) => f.show_render) || entries.some((e) => e.masks?.length || e.holdout)) {
        const f = finalImage(rs, ev.id, images);
        f.s.mode3D = gp.stroke_depth_order === '3D';
        f.s.inFront = ev.ob.show_in_front;
        f.s.group.matrix.copy(ev.world);
        fillSynced(f.s, entries, ev.ob, false);
        f.proxy.renderOrder = 1000;
        f.proxy.visible = true;
        seenImages.add(ev.id);
        continue;
      }
      seen.add(ev.id);
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
  for (const [id, f] of images)
    if (!seenImages.has(id)) {
      rs.scene.remove(f.proxy);
      images.delete(id);
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
  const b = buildStrokeBuffers(evaluatedDrawing(d), materialStyles(app.doc, gp), 0, layer?.radius_offset ?? 0, false, true);
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
