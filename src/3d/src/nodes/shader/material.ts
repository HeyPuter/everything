// Material node trees → three.js MeshPhysicalMaterial with node GLSL injected through
// onBeforeCompile. three's lighting, shadows and environment lighting keep working; the node
// closure only replaces the surface parameters (base color, roughness, normal, emission, …).
import {
  MeshPhysicalMaterial,
  Material,
  DoubleSide,
  FrontSide,
  DataTexture,
  RGBAFormat,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  ClampToEdgeWrapping,
  DataUtils,
  Vector3,
  Vector4,
  Uniform,
  UniformsGroup,
  ShaderChunk,
  BufferAttribute,
  type BufferGeometry,
  type Object3D,
  type WebGLRenderer,
  type Group,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import type { DocumentData, MaterialData } from '../../data/types';
import { setMaterialCompiler, setMaterialKeyExtra, principledFallback, errorMaterial } from '../../render/pbr';
import { imageTexture } from '../../render/images';
import { compileTree, DISPLACE_MARK, type CompiledTree, type UniformSpec } from './codegen';
import { app } from '../../app/app';
import { renderContext } from '../../render/context';
import { hashName } from './util';
import { patchFx } from '../../render/realtime/fxshader';
import { applyRealtimeMaterial, realtimeMaterialKey } from '../../render/realtime/materialfx';

interface Entry {
  key: string;
  mat: MeshPhysicalMaterial;
  uniforms: Record<string, Uniform>;
  luts: DataTexture[];
  errors: string[];
}

const cache = new Map<string, Entry>();
const failedKeys = new Set<string>();
/** Latest non-fatal compile messages per material id (unsupported nodes, invalid links). */
export const compileMessages = new Map<string, string[]>();

// ---------------------------------------------------------------------------
// Uniform values

function lutTexture(data: Float32Array, width: number, nearest: boolean): DataTexture {
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = DataUtils.toHalfFloat(data[i]);
  const t = new DataTexture(half, width, 1, RGBAFormat, HalfFloatType);
  t.magFilter = t.minFilter = nearest ? NearestFilter : LinearFilter;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function updateLut(t: DataTexture, data: Float32Array, nearest: boolean) {
  const arr = t.image.data as Uint16Array;
  if (arr.length !== data.length) return false;
  for (let i = 0; i < data.length; i++) arr[i] = DataUtils.toHalfFloat(data[i]);
  t.magFilter = t.minFilter = nearest ? NearestFilter : LinearFilter;
  t.needsUpdate = true;
  return true;
}

function initialValue(doc: DocumentData, u: UniformSpec, luts: DataTexture[]): unknown {
  const v = u.value;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.length === 3 ? new Vector3(v[0], v[1], v[2]) : new Vector4(v[0], v[1], v[2], v[3] ?? 1);
  if (v.kind === 'lut') {
    const t = lutTexture(v.data, v.width, !!v.nearest);
    luts.push(t);
    return t;
  }
  const img = v.image ? doc.images[v.image] : undefined;
  return img ? imageTexture(img, v.interpolation as 'Linear') : null;
}

function assignValue(doc: DocumentData, target: Uniform, u: UniformSpec) {
  const v = u.value;
  if (typeof v === 'number') target.value = v;
  else if (Array.isArray(v)) {
    if (v.length === 3) (target.value as Vector3).set(v[0], v[1], v[2]);
    else (target.value as Vector4).set(v[0], v[1], v[2], v[3] ?? 1);
  } else if (v.kind === 'lut') updateLut(target.value as DataTexture, v.data, !!v.nearest);
  else {
    const img = v.image ? doc.images[v.image] : undefined;
    target.value = img ? imageTexture(img, v.interpolation as 'Linear') : null;
  }
}

// ---------------------------------------------------------------------------
// Shader assembly

const has = (body: string, id: string) => new RegExp(`\\b${id}\\b`).test(body);

/** Fragment preamble defining the shading context variables used by the body. */
export function materialPreamble(body: string) {
  const L: string[] = [];
  L.push('vec3 ndP = vNdP;');
  L.push('float ndBack = gl_FrontFacing ? 0.0 : 1.0;');
  L.push('vec3 ndN = normalize((vec4(normalize(vNormal), 0.0) * viewMatrix).xyz) * (gl_FrontFacing ? 1.0 : -1.0);');
  L.push('vec3 ndI = isOrthographic ? normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])) : normalize(cameraPosition - ndP);');
  L.push('vec2 ndUV = vNdUV;');
  if (has(body, 'ndNg')) L.push('vec3 ndNg = normalize(cross(dFdx(ndP), dFdy(ndP))); if (dot(ndNg, ndN) < 0.0) ndNg = -ndNg;');
  if (has(body, 'ndObj') || has(body, 'ndOrco')) L.push('vec3 ndObj = vNdObj;');
  if (has(body, 'ndObjN')) L.push('vec3 ndObjN = normalize(vNdObjN) * (gl_FrontFacing ? 1.0 : -1.0);');
  if (has(body, 'ndOrco')) L.push('vec3 ndOrco = (ndObj - ndBBoxMin.xyz) / max(ndBBoxMax.xyz - ndBBoxMin.xyz, vec3(1e-6));');
  if (has(body, 'ndViewPos') || has(body, 'ndCam')) L.push('vec3 ndViewPos = (viewMatrix * vec4(ndP, 1.0)).xyz;');
  if (has(body, 'ndCam')) L.push('vec3 ndCam = vec3(ndViewPos.xy, -ndViewPos.z);');
  if (has(body, 'ndWin')) L.push('vec3 ndWin = vec3((gl_FragCoord.xy - ndViewport.xy) / max(ndViewport.zw, vec2(1.0)), 0.0);');
  if (has(body, 'ndRefl')) L.push('vec3 ndRefl = reflect(-ndI, ndN);');
  if (has(body, 'ndCol')) L.push('vec4 ndCol = vec4(0.0);\n#if defined( USE_COLOR_ALPHA )\nndCol = vColor;\n#elif defined( USE_COLOR )\nndCol = vec4(vColor.rgb, 1.0);\n#endif');
  if (has(body, 'ndT') || has(body, 'ndB')) {
    L.push('vec3 ndT, ndB;');
    L.push(
      '{ vec3 dp1 = dFdx(ndP), dp2 = dFdy(ndP); vec2 du1 = dFdx(ndUV), du2 = dFdy(ndUV); vec3 p2 = cross(dp2, ndN), p1 = cross(ndN, dp1); vec3 T = p2 * du1.x + p1 * du2.x; vec3 B = p2 * du1.y + p1 * du2.y; float m = max(dot(T, T), dot(B, B)); float s = m > 0.0 ? inversesqrt(m) : 0.0; ndT = m > 0.0 ? normalize(T * s) : normalize(cross(ndN, vec3(0.0, 0.0, 1.0)) + vec3(1e-4, 0.0, 0.0)); ndB = m > 0.0 ? normalize(B * s) : cross(ndN, ndT); }',
    );
  }
  if (has(body, 'ndBary')) L.push('vec3 ndBary = vNdBary;');
  L.push('float ndTexel = 0.0;');
  return L.join('\n');
}

export function usesObjectBlock(body: string) {
  return has(body, 'ndOrco') || has(body, 'ndWin') || /ndObj(Info|Color|Loc)\b/.test(body);
}

const OBJECT_BLOCK = 'layout(std140) uniform NdObject { vec4 ndBBoxMin; vec4 ndBBoxMax; vec4 ndObjInfo; vec4 ndObjColor; vec4 ndObjLoc; vec4 ndViewport; };';

/** Produce the patched fragment & vertex shader sources (exported for tests). */
export function patchShaders(vertex: string, fragment: string, ct: CompiledTree, opts: { alphaMode: 'OPAQUE' | 'ALPHA' }) {
  let body = ct.body;
  if (ct.features.displacement) body = body.replace(DISPLACE_MARK, 'ndN = nd_bump(ndP, ndN, dot(ndDisp, ndN), 1.0, 1.0, false);');
  const preamble = materialPreamble(body);
  const fullBody = preamble + '\n' + body;
  const bary = has(fullBody, 'vNdBary');
  const objBlock = usesObjectBlock(fullBody);
  const v = vertex
    .replace(
      '#include <common>',
      `#include <common>\nvarying vec3 vNdP;\nvarying vec3 vNdObj;\nvarying vec3 vNdObjN;\nvarying vec2 vNdUV;\n${bary ? 'attribute vec3 ndBary;\nvarying vec3 vNdBary;' : ''}`,
    )
    .replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>\nvNdObj = transformed; vNdObjN = objectNormal; vNdUV = uv;\n{ vec4 ndWP = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\nndWP = instanceMatrix * ndWP;\n#endif\nvNdP = (modelMatrix * ndWP).xyz; }\n${bary ? 'vNdBary = ndBary;' : ''}`,
    );
  const alpha = opts.alphaMode === 'ALPHA' ? 'clamp(ndC.alpha, 0.0, 1.0)' : '1.0';
  const transmission = ShaderChunk.transmission_fragment.replace('material.transmission = transmission;', 'material.transmission = clamp(ndC.transmission, 0.0, 1.0);');
  const f = fragment
    .replace(
      '#include <common>',
      `#include <common>\nvarying vec3 vNdP;\nvarying vec3 vNdObj;\nvarying vec3 vNdObjN;\nvarying vec2 vNdUV;\n${bary ? 'varying vec3 vNdBary;' : ''}\n#ifndef USE_TRANSMISSION\nuniform mat4 modelMatrix;\n#endif\n${objBlock ? OBJECT_BLOCK : ''}\n${ct.decls}\n${ct.lib}\n// nd-key:${ct.key}`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>\n${fullBody}\nfloat ndS = clamp(ndC.weight / max(ndC.alpha, 1e-4), 0.0, 1.0);\ndiffuseColor = vec4(max(ndC.base, vec3(0.0)) * ndS, ${alpha});`,
    )
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(ndC.roughness, 0.0, 1.0);')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(ndC.metallic, 0.0, 1.0);')
    .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(ndC.N, 0.0)).xyz);')
    .replace(
      '#include <clearcoat_normal_fragment_begin>',
      '#include <clearcoat_normal_fragment_begin>\n#ifdef USE_CLEARCOAT\nclearcoatNormal = normalize((viewMatrix * vec4(ndC.coatN, 0.0)).xyz);\n#endif',
    )
    .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = max(ndC.emission, vec3(0.0));')
    .replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
material.ior = max(ndC.ior, 1.0);
{
  float ndSI = ndC.specular * 2.0 * ndS;
  material.specularF90 = mix(min(ndSI, 1.0), 1.0, metalnessFactor);
  material.specularColor = min(pow2((material.ior - 1.0) / (material.ior + 1.0)) * ndC.specTint, vec3(1.0)) * ndSI;
  material.specularColorBlended = mix(material.specularColor, diffuseColor.rgb, metalnessFactor);
}
#ifdef USE_CLEARCOAT
material.clearcoat = saturate(ndC.coat);
material.clearcoatRoughness = min(max(ndC.coatRough, 0.0525) + geometryRoughness, 1.0);
material.clearcoatF0 = vec3(pow2((ndC.coatIor - 1.0) / (ndC.coatIor + 1.0)));
#endif
#ifdef USE_SHEEN
material.sheenColor = ndC.sheenTint * ndC.sheen;
material.sheenRoughness = clamp(ndC.sheenRough, 0.0001, 1.0);
#endif
#ifdef USE_IRIDESCENCE
material.iridescence = ndC.thinFilm > 0.0 ? 1.0 : 0.0;
material.iridescenceIOR = max(ndC.thinFilmIor, 1.0);
material.iridescenceThickness = ndC.thinFilm;
#endif
#ifdef USE_ANISOTROPY
{
  float ndA = ndC.anisoRot * 6.2831853;
  vec2 ndAV = vec2(cos(ndA), sin(ndA));
  material.anisotropy = saturate(abs(ndC.aniso));
  material.alphaT = mix(pow2(material.roughness), 1.0, pow2(material.anisotropy));
  material.anisotropyT = tbn[0] * ndAV.x + tbn[1] * ndAV.y;
  material.anisotropyB = tbn[1] * ndAV.x - tbn[0] * ndAV.y;
}
#endif`,
    )
    .replace('#include <transmission_fragment>', transmission);
  return { vertex: v, fragment: f, objectBlock: objBlock, barycentric: bary };
}

// ---------------------------------------------------------------------------
// Per-object data (uniform block) and lazily added barycentric attributes

const tmpV = new Vector4();
function baryAttribute(geometry: BufferGeometry) {
  if (geometry.getAttribute('ndBary')) return;
  const pos = geometry.getAttribute('position');
  if (!pos) return;
  const n = pos.count;
  const bary = new Float32Array(n * 3);
  const color = new Int8Array(n).fill(-1);
  const index = geometry.getIndex();
  const tri = (a: number, b: number, c: number) => {
    const used = new Set<number>();
    for (const v of [a, b, c]) if (color[v] >= 0) used.add(color[v]);
    for (const v of [a, b, c])
      if (color[v] < 0) {
        let k = 0;
        while (used.has(k) && k < 2) k++;
        color[v] = k;
        used.add(k);
      }
  };
  if (index) for (let i = 0; i + 2 < index.count; i += 3) tri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  else for (let i = 0; i + 2 < n; i += 3) tri(i, i + 1, i + 2);
  for (let i = 0; i < n; i++) bary[i * 3 + Math.max(0, color[i])] = 1;
  geometry.setAttribute('ndBary', new BufferAttribute(bary, 3));
}

function makeObjectGroup() {
  const g = new UniformsGroup();
  g.setName('NdObject');
  for (let i = 0; i < 6; i++) g.add(new Uniform(new Vector4()));
  return g;
}

function updateObjectGroup(g: UniformsGroup, renderer: WebGLRenderer, geometry: BufferGeometry, object: Object3D, group: Group | null) {
  const u = g.uniforms as Uniform[];
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  (u[0].value as Vector4).set(bb.min.x, bb.min.y, bb.min.z, 0);
  (u[1].value as Vector4).set(bb.max.x, bb.max.y, bb.max.z, 0);
  const id = object.userData.id as string | undefined;
  const ob = id ? app?.doc.objects[id] : undefined;
  (u[2].value as Vector4).set(ob ? hashName(ob.name) : 0, ob?.pass_index ?? 0, (group as unknown as { materialIndex?: number } | null)?.materialIndex ?? 0, 0);
  const c = ob?.color ?? [1, 1, 1, 1];
  (u[3].value as Vector4).set(c[0], c[1], c[2], c[3] ?? 1);
  const e = object.matrixWorld.elements;
  (u[4].value as Vector4).set(e[12], e[13], e[14], 1);
  renderer.getCurrentViewport(tmpV);
  (u[5].value as Vector4).copy(tmpV);
}

// ---------------------------------------------------------------------------

function build(doc: DocumentData, ma: MaterialData, ct: CompiledTree, key: string): Entry {
  const base = principledFallback(doc, ma) as MeshPhysicalMaterial;
  const mat = base;
  const uniforms: Record<string, Uniform> = {};
  const luts: DataTexture[] = [];
  for (const u of ct.uniforms) uniforms[u.name] = new Uniform(initialValue(doc, u, luts));
  const f = ct.features;
  // enable the three.js features the closure may use
  mat.transmission = f.transmission ? 1 : 0;
  mat.thickness = f.transmission ? 0.5 : 0;
  mat.clearcoat = f.coat ? 1 : 0;
  mat.sheen = f.sheen ? 1 : 0;
  mat.anisotropy = f.anisotropy ? 1 : 0;
  mat.iridescence = f.thinFilm ? 1 : 0;
  if (f.thinFilm) mat.iridescenceThicknessRange = [0, 1000];
  mat.vertexColors = f.vertexColor;
  mat.side = ma.use_backface_culling ? FrontSide : DoubleSide;
  const alphaUsed = f.alpha || f.volumeOnly;
  const mode = f.volumeOnly ? 'BLEND' : ma.blend_method;
  mat.transparent = false;
  mat.alphaTest = 0;
  mat.alphaHash = false;
  mat.depthWrite = true;
  if (alphaUsed) {
    if (mode === 'CLIP') mat.alphaTest = Math.max(1e-4, ma.alpha_threshold);
    else if (mode === 'HASHED') mat.alphaHash = true;
    else if (mode === 'BLEND') {
      mat.transparent = true;
      mat.depthWrite = ma.show_transparent_back === false;
    }
  }
  const alphaMode = alphaUsed && mode !== 'OPAQUE' ? 'ALPHA' : 'OPAQUE';
  const objectGroup = makeObjectGroup();
  let objectBlock = false;
  let barycentric = false;
  {
    // determine attribute/block needs up front (same text the compiler will produce)
    const probe = patchShaders('#include <common>\n#include <worldpos_vertex>', '#include <common>', ct, { alphaMode });
    objectBlock = probe.objectBlock;
    barycentric = probe.barycentric;
  }
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    const r = patchShaders(shader.vertexShader, shader.fragmentShader, ct, {
      alphaMode,
    });
    shader.vertexShader = r.vertex;
    shader.fragmentShader = r.fragment;
    Object.assign(shader.uniforms, uniforms);
    patchFx(shader);
  };
  applyRealtimeMaterial(mat, ma);
  mat.customProgramCacheKey = () => `nd:${key}`;
  if (objectBlock) (mat as unknown as { uniformsGroups: UniformsGroup[] }).uniformsGroups = [objectGroup];
  if (objectBlock || barycentric) {
    mat.onBeforeRender = (renderer, _scene, _camera, geometry, object, group) => {
      if (barycentric) baryAttribute(geometry);
      if (objectBlock) updateObjectGroup(objectGroup, renderer, geometry, object, group);
    };
  }
  // the viewport cache disposes replaced materials; we manage disposal ourselves
  const realDispose = mat.dispose.bind(mat);
  mat.dispose = () => {};
  (mat as unknown as { ndDispose: () => void }).ndDispose = () => {
    realDispose();
    objectGroup.dispose();
    for (const t of luts) t.dispose();
  };
  mat.name = ma.name;
  return { key, mat, uniforms, luts, errors: ct.errors };
}

function release(e: Entry) {
  (e.mat as unknown as { ndDispose: () => void }).ndDispose();
}

export function compileMaterial(doc: DocumentData, ma: MaterialData): Material {
  if (!hooked && renderContext) installShaderErrorHook(renderContext.engine.renderer);
  if (!ma.use_nodes) return principledFallback(doc, ma);
  const ct = compileTree(doc, ma.tree, 'MATERIAL');
  const key = `${ct.key}|${ma.blend_method}|${ma.use_backface_culling ? 1 : 0}|${ma.show_transparent_back === false ? 0 : 1}|${realtimeMaterialKey(ma)}`;
  compileMessages.set(ma.id, ct.errors);
  if (failedKeys.has(key)) return errorMaterial;
  const hit = cache.get(ma.id);
  if (hit && hit.key === key) {
    for (const u of ct.uniforms) {
      const target = hit.uniforms[u.name];
      if (target) assignValue(doc, target, u);
    }
    if (ma.blend_method === 'CLIP') hit.mat.alphaTest = hit.mat.alphaTest > 0 ? Math.max(1e-4, ma.alpha_threshold) : 0;
    return hit.mat;
  }
  if (hit) release(hit);
  const e = build(doc, ma, ct, key);
  cache.set(ma.id, e);
  return e.mat;
}

/** Called by the renderer's shader error hook: show the error material and report. */
export function markShaderFailure(fragmentSource: string) {
  const m = /nd-key:(\S+)/.exec(fragmentSource);
  if (!m) return false;
  for (const [id, e] of cache) {
    if (!e.key.startsWith(m[1])) continue;
    failedKeys.add(e.key);
    const ma = app?.doc.materials[id];
    app?.report('ERROR', `Shader compilation failed for material "${ma?.name ?? id}" (see console)`);
  }
  // force the viewport cache to recompile
  setMaterialCompiler(compileMaterial);
  return true;
}

let hooked = false;
/** Install the GLSL error hook on the renderer (idempotent). */
export function installShaderErrorHook(renderer: WebGLRenderer) {
  if (hooked) return;
  hooked = true;
  const prev = renderer.debug.onShaderError;
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const src = gl.getShaderSource(fs) ?? '';
    if (src.includes('nd-key:')) {
      console.error('Node shader compile error:', gl.getShaderInfoLog(fs), gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs));
      markShaderFailure(src);
      return;
    }
    if (prev) prev(gl, program, vs, fs);
    else console.error('THREE.WebGLProgram: shader error', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs));
  };
}

setMaterialCompiler(compileMaterial);

/** Node groups (and their images) used by a material also invalidate its cached shader. */
setMaterialKeyExtra((doc, ma) => {
  let k = '';
  const seen = new Set<string>();
  const visit = (nodes: { props: Record<string, unknown> }[]) => {
    for (const n of nodes) {
      const gid = n.props.node_tree as string | undefined;
      if (gid && !seen.has(gid) && doc.node_groups[gid]) {
        seen.add(gid);
        const g = doc.node_groups[gid];
        k += `|g:${JSON.stringify(g.tree)}`;
        visit(g.tree.nodes);
      }
      const img = n.props.image as string | undefined;
      if (img && seen.size && doc.images[img]) k += `|i:${img}:${doc.images[img].revision ?? 0}`;
    }
  };
  visit(ma.tree.nodes);
  return k;
});
