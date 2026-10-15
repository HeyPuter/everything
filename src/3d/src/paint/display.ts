// Viewport display for sculpt/paint modes: mask overlay, weight heat map, vertex colors and the
// paint texture on the active object, driven by per-corner attributes on the synced geometry.
import { BufferAttribute, Color, Vector3, DoubleSide, FrontSide, ShaderMaterial, type BufferGeometry, type Material, type Texture } from 'three';
import { STUDIO_GLSL, studioUniforms } from '../render/studiolights';
import { app } from '../app/app';
import type { MeshData } from '../data/types';
import { drawHooks } from '../editors/view3d/draw';
import type { SyncedObject } from '../render/scene';
import { imageTexture } from '../render/images';
import { isBrushMode } from './brushes';
import type { MeshSession } from './session';
import { faceSetColor, faceSetsOf, activeHiddenFaces, paintFilter } from './fsdata';
import { meshGeometry } from '../render/geometry';

const vert = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldNormal;
  varying vec4 vColor;
  varying float vMask;
  varying float vWeight;
  varying vec2 vUv;
  varying vec3 vFset;
  #ifdef USE_FSET
  attribute vec3 paintFaceSet;
  #endif
  #ifdef USE_VCOLOR
  attribute vec4 color;
  #endif
  #ifdef USE_MASK
  attribute float paintMask;
  #endif
  #ifdef USE_WEIGHT
  attribute float paintWeight;
  #endif
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    #ifdef USE_VCOLOR
    vColor = color;
    #else
    vColor = vec4(1.0);
    #endif
    #ifdef USE_MASK
    vMask = paintMask;
    #else
    vMask = 0.0;
    #endif
    #ifdef USE_WEIGHT
    vWeight = paintWeight;
    #else
    vWeight = 0.0;
    #endif
    #ifdef USE_FSET
    vFset = paintFaceSet;
    #else
    vFset = vec3(1.0);
    #endif
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;

/** Overlay colours shared by all sculpt / paint display materials (Preferences ▸ Editing). */
export const paintDisplaySettings = { maskColor: new Color(0, 0, 0), weightRamp: [new Vector3(0, 0, 1), new Vector3(0, 1, 1), new Vector3(0, 1, 0), new Vector3(1, 1, 0), new Vector3(1, 0, 0)] };

const frag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uSpecular;
  uniform int uLighting;
  uniform float uMaskOpacity;
  uniform vec3 uMaskColor;
  ${STUDIO_GLSL}
  uniform float uWeightOpacity;
  uniform float uFsetOpacity;
  uniform sampler2D uMap;
  varying vec3 vFset;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldNormal;
  varying vec4 vColor;
  varying float vMask;
  varying float vWeight;
  varying vec2 vUv;
  uniform vec3 uWeightRamp[5];
  vec3 heat(float w) {
    w = clamp(w, 0.0, 1.0);
    if (w < 0.25) return mix(uWeightRamp[0], uWeightRamp[1], w / 0.25);
    if (w < 0.5) return mix(uWeightRamp[1], uWeightRamp[2], (w - 0.25) / 0.25);
    if (w < 0.75) return mix(uWeightRamp[2], uWeightRamp[3], (w - 0.5) / 0.25);
    return mix(uWeightRamp[3], uWeightRamp[4], (w - 0.75) / 0.25);
  }
  void main() {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 base = uColor * vColor.rgb;
    #ifdef USE_MAP
    base *= texture2D(uMap, vUv).rgb;
    #endif
    #ifdef USE_FSET
    base *= mix(vec3(1.0), pow(vFset, vec3(2.2)), uFsetOpacity);
    #endif
    #ifdef USE_WEIGHT
    // heat map colors are display values: convert to linear for the sRGB output transform
    vec3 hc = heat(vWeight);
    hc = pow(hc, vec3(2.2));
    base = mix(base, hc, uWeightOpacity);
    #endif
    vec3 col;
    if (uLighting == 1) {
      col = base;
    } else if (uLighting == 2 && uMatcapOn == 1) {
      col = matcapLighting(base, n);
    } else if (uLighting == 2) {
      vec3 l1 = normalize(vec3(-0.4, 0.6, 0.7));
      float d = max(dot(n, l1), 0.0);
      float rim = pow(1.0 - max(n.z, 0.0), 2.0);
      col = base * (0.25 + 0.75 * d) + vec3(0.25) * rim + vec3(0.25) * pow(max(dot(reflect(-l1, n), vec3(0.0, 0.0, 1.0)), 0.0), 18.0);
    } else if (uStudioCustom == 1) {
      col = studioLighting(base, n, normalize(-vViewPos), uSpecular);
    } else {
      vec3 v = normalize(-vViewPos);
      vec3 L1 = normalize(vec3(-0.45, 0.55, 0.70));
      vec3 L2 = normalize(vec3(0.75, 0.20, 0.45));
      vec3 L3 = normalize(vec3(0.10, -0.85, 0.20));
      float hemi = 0.5 + 0.5 * normalize(vWorldNormal).z;
      vec3 diffuse = base * (0.72 * max(dot(n, L1), 0.0) + 0.28 * max(dot(n, L2), 0.0) + 0.12 * max(dot(n, L3), 0.0) + mix(0.12, 0.26, hemi));
      float spec = pow(max(dot(n, normalize(L1 + v)), 0.0), 40.0) * 0.18 * uSpecular;
      col = diffuse + vec3(spec);
    }
    #ifdef USE_MASK
    col = mix(col, uMaskColor, clamp(vMask, 0.0, 1.0) * uMaskOpacity * 0.85);
    #endif
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

interface PaintMatOpts {
  color: [number, number, number];
  lighting: 'STUDIO' | 'FLAT' | 'MATCAP';
  specular: boolean;
  vcolor?: boolean;
  mask?: boolean;
  weight?: boolean;
  faceSets?: boolean;
  faceSetOpacity?: number;
  map?: Texture | null;
  backface?: boolean;
  maskOpacity?: number;
  weightOpacity?: number;
}

const cache = new Map<string, ShaderMaterial>();

export function paintMaterial(o: PaintMatOpts): ShaderMaterial {
  const key = `${o.color.map((c) => c.toFixed(3)).join(',')}|${o.lighting}|${o.specular ? 1 : 0}|${o.vcolor ? 1 : 0}|${o.mask ? 1 : 0}|${o.weight ? 1 : 0}|${o.faceSets ? 1 : 0}|${o.map ? o.map.uuid : ''}|${o.backface ? 1 : 0}`;
  let m = cache.get(key);
  if (!m) {
    const defines: Record<string, string> = {};
    if (o.vcolor) defines.USE_VCOLOR = '';
    if (o.mask) defines.USE_MASK = '';
    if (o.weight) defines.USE_WEIGHT = '';
    if (o.faceSets) defines.USE_FSET = '';
    if (o.map) defines.USE_MAP = '';
    m = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      defines,
      uniforms: {
        uColor: {
          value: new Color().setRGB(o.color[0], o.color[1], o.color[2]),
        },
        uSpecular: { value: o.specular ? 1 : 0 },
        uLighting: {
          value: o.lighting === 'FLAT' ? 1 : o.lighting === 'MATCAP' ? 2 : 0,
        },
        uMaskOpacity: { value: 0.75 },
        uMaskColor: { value: paintDisplaySettings.maskColor },
        uWeightRamp: { value: paintDisplaySettings.weightRamp },
        ...studioUniforms,
        uWeightOpacity: { value: 1 },
        uFsetOpacity: { value: 1 },
        uMap: { value: o.map ?? null },
      },
      side: o.backface ? FrontSide : DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    cache.set(key, m);
    if (cache.size > 64) {
      const first = cache.keys().next().value as string;
      cache.get(first)?.dispose();
      cache.delete(first);
    }
  }
  m.uniforms.uMaskOpacity.value = o.maskOpacity ?? 0.75;
  m.uniforms.uWeightOpacity.value = o.weightOpacity ?? 1;
  m.uniforms.uFsetOpacity.value = o.faceSetOpacity ?? 1;
  return m;
}

// ---------------------------------------------------------------------------
// per-corner attributes

/** Fill (or refresh) a float corner attribute from per-vertex values. */
function cornerAttr(g: BufferGeometry, name: string, me: MeshData, src: Float32Array | null | undefined, key: string): BufferAttribute {
  let a = g.getAttribute(name) as BufferAttribute | undefined;
  const nc = me.indices.length;
  if (!a || a.count !== nc) {
    a = new BufferAttribute(new Float32Array(nc), 1);
    g.setAttribute(name, a);
    g.userData[name + 'Key'] = undefined;
  }
  if (g.userData[name + 'Key'] !== key || g.userData[name + 'Src'] !== src || g.userData[name + 'Idx'] !== me.indices) {
    const arr = a.array as Float32Array;
    if (src && src.length >= me.positions.length / 3) for (let c = 0; c < nc; c++) arr[c] = src[me.indices[c]];
    else arr.fill(0);
    a.needsUpdate = true;
    g.userData[name + 'Key'] = key;
    g.userData[name + 'Src'] = src;
    g.userData[name + 'Idx'] = me.indices;
  }
  return a;
}

/** Write per-vertex values into a corner attribute for the given vertices (during strokes). */
export function writeCornerValues(s: MeshSession, name: string, values: Float32Array, verts: ArrayLike<number>, n: number) {
  const m = s.syncedMesh();
  const a = m?.geometry.getAttribute(name) as BufferAttribute | undefined;
  if (!a || a.count !== s.nc) return;
  const arr = a.array as Float32Array;
  const o = s.vf.offsets,
    C = s.vf.corners;
  let lo = Infinity,
    hi = -1;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    const val = values[v];
    for (let k = o[v]; k < o[v + 1]; k++) {
      const c = C[k];
      arr[c] = val;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
  }
  if (hi >= lo) s.markAttrDirty(name, lo, hi);
}

const maskAny = new WeakMap<Float32Array, boolean>();
/** Whether a mask array has any masked vertex (cached; call `maskChanged` after editing in place). */
export function hasMask(mask: Float32Array | undefined): boolean {
  if (!mask) return false;
  let r = maskAny.get(mask);
  if (r === undefined) {
    r = false;
    for (let i = 0; i < mask.length; i++)
      if (mask[i] > 0) {
        r = true;
        break;
      }
    maskAny.set(mask, r);
  }
  return r;
}
export function maskChanged(mask: Float32Array) {
  maskAny.delete(mask);
}

/** Bump to force the mask/weight corner attributes to refresh (in-place edits). */
let attrVersion = 0;
export function invalidatePaintAttributes() {
  attrVersion++;
}

/** Paint texture shown in Texture Paint mode (set by the texture paint module). */
export const paintDisplay = {
  image: null as string | null,
  resolve: null as null | (() => string | null),
};

function solidBase(mat: Material): {
  color: [number, number, number];
  vcolor: boolean;
} {
  const sm = mat as ShaderMaterial;
  const c = sm.uniforms?.uColor?.value as Color | undefined;
  return {
    color: c ? [c.r, c.g, c.b] : [0.8, 0.8, 0.8],
    vcolor: !!sm.defines && 'USE_VCOLOR' in sm.defines,
  };
}

drawHooks.materials.push((so: SyncedObject, mode, view, mats) => {
  const docMode = app.doc.mode;
  const mesh = so.mesh;
  if (!mesh) return;
  const ob = so.ev.ob;
  const active = ob.id === app.activeObject?.id && ob.type === 'MESH';
  mesh.frustumCulled = !(active && docMode === 'SCULPT');
  if (mesh.geometry.userData.hideOrigIndex && !(active && isBrushMode(docMode))) restoreIndex(mesh.geometry);
  if (!active || !isBrushMode(docMode) || mode === 'WIREFRAME') return;
  const me = ob.data ? app.doc.meshes[ob.data] : undefined;
  if (!me) return;
  const g = mesh.geometry;
  applyHiddenFaces(g, me, so, docMode === 'SCULPT' ? activeHiddenFaces(me) : paintFilter(me).hidden);
  const pos = g.getAttribute('position');
  const direct = !!pos && pos.count === me.indices.length && so.ev.mesh?.indices === me.indices;
  const sh = view.shading;
  const lighting = sh.light;
  const specular = sh.show_specular_highlight;
  const backface = sh.show_backface_culling;
  if (docMode === 'SCULPT') {
    if (mode !== 'SOLID' || !direct) return;
    const ov = view.overlay;
    const showOv = ov.show_overlays !== false;
    const mask = showOv && ov.show_sculpt_mask !== false && hasMask(me.sculpt_mask);
    const fsets = showOv && ov.show_sculpt_face_sets !== false && hasVisibleFaceSets(me);
    if (!mask && !fsets) return;
    if (mask) cornerAttr(g, 'paintMask', me, me.sculpt_mask, `${attrVersion}`);
    if (fsets) faceSetAttr(g, me);
    for (let i = 0; i < mats.length; i++) {
      const b = solidBase(mats[i]);
      mats[i] = paintMaterial({
        color: b.color,
        vcolor: b.vcolor && !!g.getAttribute('color'),
        lighting,
        specular,
        backface,
        mask,
        maskOpacity: ov.sculpt_mode_mask_opacity,
        faceSets: fsets,
        faceSetOpacity: ov.sculpt_mode_face_sets_opacity ?? 1,
      });
    }
  } else if (docMode === 'VERTEX_PAINT') {
    if (mode !== 'SOLID' || !g.getAttribute('color')) return;
    for (let i = 0; i < mats.length; i++)
      mats[i] = paintMaterial({
        color: [1, 1, 1],
        vcolor: true,
        lighting,
        specular,
        backface,
      });
  } else if (docMode === 'WEIGHT_PAINT') {
    if (!direct) return;
    const gi = ob.vertex_group_active_index ?? 0;
    const w = me.weights[gi];
    cornerAttr(g, 'paintWeight', me, w, `${attrVersion}:${gi}`);
    for (let i = 0; i < mats.length; i++) {
      const b = mode === 'SOLID' ? solidBase(mats[i]).color : ([0.8, 0.8, 0.8] as [number, number, number]);
      mats[i] = paintMaterial({
        color: b,
        lighting: mode === 'SOLID' ? lighting : 'STUDIO',
        specular,
        backface,
        weight: true,
        weightOpacity: view.overlay.weight_paint_mode_opacity,
      });
    }
  } else if (docMode === 'TEXTURE_PAINT') {
    if (mode !== 'SOLID') return;
    const id = paintDisplay.resolve?.() ?? paintDisplay.image;
    const img = id ? app.doc.images[id] : undefined;
    if (!img) return;
    const tex = imageTexture(img);
    for (let i = 0; i < mats.length; i++)
      mats[i] = paintMaterial({
        color: [1, 1, 1],
        lighting,
        specular,
        backface,
        map: tex,
      });
  }
});

drawHooks.skipOutline.push((ob) => isBrushMode(app.doc.mode) && ob.id === app.activeObject?.id);

// ---------------------------------------------------------------------------
// face sets

/** Whether any face is in a colored (non-default) face set. */
const fsAny = new WeakMap<Int32Array, boolean>();
export function hasVisibleFaceSets(me: MeshData): boolean {
  const fs = faceSetsOf(me);
  if (!fs) return false;
  let r = fsAny.get(fs);
  if (r === undefined) {
    const def = me.face_sets_color_default ?? 1;
    r = false;
    for (let i = 0; i < fs.length; i++)
      if (fs[i] !== def) {
        r = true;
        break;
      }
    fsAny.set(fs, r);
  }
  return r;
}

/** Call after editing a face set array in place. */
export function faceSetsChanged(fs: Int32Array) {
  fsAny.delete(fs);
}

function faceSetAttr(g: BufferGeometry, me: MeshData) {
  const fs = faceSetsOf(me)!;
  const nc = me.indices.length;
  let a = g.getAttribute('paintFaceSet') as BufferAttribute | undefined;
  if (!a || a.count !== nc) {
    a = new BufferAttribute(new Float32Array(nc * 3), 3);
    g.setAttribute('paintFaceSet', a);
    g.userData.fsetSrc = undefined;
  }
  const seed = me.face_sets_color_seed ?? 0,
    def = me.face_sets_color_default ?? 1;
  const key = `${seed}:${def}`;
  if (g.userData.fsetSrc === fs && g.userData.fsetKey === key && g.userData.fsetIdx === me.indices && g.userData.fsetVer === attrVersion) return;
  const arr = a.array as Float32Array;
  const colors = new Map<number, [number, number, number]>();
  for (let f = 0; f < fs.length; f++) {
    let c = colors.get(fs[f]);
    if (!c) {
      c = faceSetColor(fs[f], seed, def);
      colors.set(fs[f], c);
    }
    for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++) arr.set(c, k * 3);
  }
  a.needsUpdate = true;
  g.userData.fsetSrc = fs;
  g.userData.fsetVer = attrVersion;
  g.userData.fsetKey = key;
  g.userData.fsetIdx = me.indices;
}

// ---------------------------------------------------------------------------
// hidden faces (Sculpt Mode): drawn by swapping in an index buffer without their triangles

function restoreIndex(g: BufferGeometry) {
  const u = g.userData;
  if (!u.hideOrigIndex) return;
  g.setIndex(u.hideOrigIndex);
  g.clearGroups();
  for (const gr of u.hideOrigGroups as { start: number; count: number; materialIndex?: number }[]) g.addGroup(gr.start, gr.count, gr.materialIndex);
  u.hideOrigIndex = undefined;
  u.hideOrigGroups = undefined;
  u.hideSrc = undefined;
}

function applyHiddenFaces(g: BufferGeometry, me: MeshData, so: SyncedObject, hide: Uint8Array | null) {
  const ev = so.ev.mesh;
  const usable = !!hide && !!ev && ev.indices === me.indices && ev.offsets === me.offsets;
  if (!usable) {
    restoreIndex(g);
    return;
  }
  const u = g.userData;
  if (u.hideSrc === hide && u.hideIdx === me.indices) return;
  restoreIndex(g);
  const info = meshGeometry(ev);
  if (info.geometry !== g && info.geometry.index !== g.index) return;
  const idx = g.index;
  if (!idx) return;
  const src = idx.array as ArrayLike<number>;
  const groups = g.groups.map((x) => ({ ...x }));
  const out = new (src instanceof Uint16Array ? Uint16Array : Uint32Array)(src.length);
  let n = 0;
  g.clearGroups();
  for (const gr of groups) {
    const start = n;
    for (let i = gr.start; i < gr.start + gr.count; i += 3) {
      const t = i / 3;
      if (hide![info.triFace[t]]) continue;
      out[n++] = src[i];
      out[n++] = src[i + 1];
      out[n++] = src[i + 2];
    }
    g.addGroup(start, n - start, gr.materialIndex);
  }
  u.hideOrigIndex = idx;
  u.hideOrigGroups = groups;
  g.setIndex(new BufferAttribute(out.slice(0, n), 1));
  u.hideSrc = hide;
  u.hideIdx = me.indices;
}
