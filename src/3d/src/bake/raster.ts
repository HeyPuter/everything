// UV-space rasterization for baking: every triangle of the target is drawn at its texture
// coordinates, so each covered texel receives the surface point that maps to it. One pass writes
// the geometry (position, smooth normal, tangent frame); material passes run the object's own
// shaders (node trees included) and output a surface property instead of lighting it.
import {
  Scene,
  Mesh,
  OrthographicCamera,
  ShaderMaterial,
  WebGLRenderTarget,
  FloatType,
  RGBAFormat,
  NearestFilter,
  DoubleSide,
  NoBlending,
  Matrix3,
  Material,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  type BufferGeometry,
  type Matrix4,
  type WebGLRenderer,
  type WebGLProgramParametersWithUniforms,
} from 'three';

/** Surface properties the material pass can output. */
export type MaterialChannel = 'BASE' | 'DIFFUSE_COLOR' | 'GLOSSY_COLOR' | 'TRANSMISSION_COLOR' | 'EMIT' | 'ROUGHNESS' | 'NORMAL' | 'ALPHA';
const CHANNEL_INDEX: Record<MaterialChannel, number> = { BASE: 0, DIFFUSE_COLOR: 1, GLOSSY_COLOR: 2, TRANSMISSION_COLOR: 3, EMIT: 4, ROUGHNESS: 5, NORMAL: 6, ALPHA: 7 };

/** Geometry outputs: world position (a = coverage), smooth normal, tangent and bitangent. */
export type GeometryChannel = 'POSITION' | 'NORMAL' | 'TANGENT' | 'BITANGENT';
const GEOMETRY_INDEX: Record<GeometryChannel, number> = { POSITION: 0, NORMAL: 1, TANGENT: 2, BITANGENT: 3 };

// identity view: view space is world space, so material normals come out in world space
const camera = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
camera.updateMatrixWorld(true);

const geometryMaterial = new ShaderMaterial({
  side: DoubleSide,
  depthTest: false,
  depthWrite: false,
  blending: NoBlending,
  uniforms: { bakeMode: { value: 0 }, bakeNormalMatrix: { value: new Matrix3() } },
  vertexShader: /* glsl */ `
    uniform mat3 bakeNormalMatrix;
    varying vec3 vBakeP;
    varying vec3 vBakeN;
    varying vec2 vBakeUV;
    void main() {
      vBakeP = (modelMatrix * vec4(position, 1.0)).xyz;
      vBakeN = bakeNormalMatrix * normal;
      vBakeUV = uv;
      gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform int bakeMode;
    varying vec3 vBakeP;
    varying vec3 vBakeN;
    varying vec2 vBakeUV;
    void main() {
      vec3 N = normalize(vBakeN);
      if (bakeMode == 0) { gl_FragColor = vec4(vBakeP, 1.0); return; }
      if (bakeMode == 1) { gl_FragColor = vec4(N, 1.0); return; }
      // tangent frame from the change of position along the texture coordinates (the same
      // construction the shading nodes use, so baked tangent normals decode exactly)
      vec3 dp1 = dFdx(vBakeP), dp2 = dFdy(vBakeP);
      vec2 du1 = dFdx(vBakeUV), du2 = dFdy(vBakeUV);
      vec3 p2 = cross(dp2, N), p1 = cross(N, dp1);
      vec3 T = p2 * du1.x + p1 * du2.x;
      vec3 B = p2 * du1.y + p1 * du2.y;
      float m = max(dot(T, T), dot(B, B));
      float s = m > 0.0 ? inversesqrt(m) : 0.0;
      vec3 t = m > 0.0 ? normalize(T * s) : normalize(cross(N, vec3(0.0, 0.0, 1.0)) + vec3(1e-4, 0.0, 0.0));
      vec3 b = m > 0.0 ? normalize(B * s) : cross(N, t);
      gl_FragColor = vec4(bakeMode == 2 ? t : b, 1.0);
    }`,
});

const hidden = new ShaderMaterial({ visible: false });

/** Float render target reused between passes of the same size. */
let target: WebGLRenderTarget | null = null;
function targetFor(w: number, h: number) {
  if (!target || target.width !== w || target.height !== h) {
    target?.dispose();
    target = new WebGLRenderTarget(w, h, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false, generateMipmaps: false });
  }
  return target;
}

export function disposeRaster() {
  target?.dispose();
  target = null;
}

/** What to draw: the object's geometry (with material groups), its world matrix, and per group whether it is baked. */
export interface RasterSource {
  geometry: BufferGeometry;
  world: Matrix4;
  /** material slot index → baked (only these groups are drawn) */
  slots: Set<number>;
}

function draw(renderer: WebGLRenderer, src: RasterSource, materials: (slot: number) => Material, w: number, h: number): Float32Array {
  const n = Math.max(1, ...src.geometry.groups.map((g) => (g.materialIndex ?? 0) + 1));
  const mats: Material[] = [];
  for (let s = 0; s < n; s++) mats.push(src.slots.has(s) ? materials(s) : hidden);
  const mesh = new Mesh(src.geometry, src.geometry.groups.length ? mats : mats[0]);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(src.world);
  mesh.matrixWorld.copy(src.world);
  mesh.frustumCulled = false;
  const scene = new Scene();
  scene.matrixWorldAutoUpdate = false;
  scene.add(mesh);
  const rt = targetFor(w, h);
  const prev = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevScissor = renderer.getScissorTest();
  renderer.setRenderTarget(rt);
  renderer.setScissorTest(false);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.autoClear = false;
  renderer.render(scene, camera);
  renderer.autoClear = prevAuto;
  renderer.setScissorTest(prevScissor);
  const out = new Float32Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, out);
  renderer.setRenderTarget(prev);
  return out;
}

/** Rasterize a geometry channel in UV space (rows bottom-up; alpha marks covered texels). */
export function rasterGeometry(renderer: WebGLRenderer, src: RasterSource, channel: GeometryChannel, w: number, h: number): Float32Array {
  geometryMaterial.uniforms.bakeMode.value = GEOMETRY_INDEX[channel];
  (geometryMaterial.uniforms.bakeNormalMatrix.value as Matrix3).getNormalMatrix(src.world);
  return draw(renderer, src, () => geometryMaterial, w, h);
}

/** Rasterize a material channel in UV space with each slot's own shader. */
export function rasterMaterial(renderer: WebGLRenderer, src: RasterSource, channel: MaterialChannel, slotMaterial: (slot: number) => Material, w: number, h: number): Float32Array {
  return draw(renderer, src, (s) => bakeVariant(slotMaterial(s), channel), w, h);
}

// ---------------------------------------------------------------------------
// material variants that output a surface property

const variants = new WeakMap<Material, Map<MaterialChannel, { version: number; mat: Material }>>();

/** The shader output replacing lighting, per channel (after the material's surface code ran). */
function outputGLSL(channel: MaterialChannel, nodes: boolean): string {
  const tr = nodes
    ? 'clamp(ndC.transmission, 0.0, 1.0)'
    : '0.0\n#ifdef USE_TRANSMISSION\n + transmission\n#endif\n';
  const lines = [`float bakeTr = ${tr};`];
  switch (channel) {
    case 'BASE':
      lines.push('gl_FragColor = vec4(diffuseColor.rgb, 1.0);');
      break;
    case 'DIFFUSE_COLOR':
      lines.push('gl_FragColor = vec4(diffuseColor.rgb * (1.0 - metalnessFactor) * (1.0 - bakeTr), 1.0);');
      break;
    case 'GLOSSY_COLOR':
      lines.push('gl_FragColor = vec4(material.specularColorBlended, 1.0);');
      break;
    case 'TRANSMISSION_COLOR':
      lines.push('gl_FragColor = vec4(diffuseColor.rgb * (1.0 - metalnessFactor) * bakeTr, 1.0);');
      break;
    case 'EMIT':
      lines.push('gl_FragColor = vec4(totalEmissiveRadiance, 1.0);');
      break;
    case 'ROUGHNESS':
      lines.push('gl_FragColor = vec4(vec3(roughnessFactor), 1.0);');
      break;
    case 'NORMAL':
      lines.push('gl_FragColor = vec4(normalize(normal), 1.0);');
      break;
    case 'ALPHA':
      lines.push('gl_FragColor = vec4(vec3(diffuseColor.a), 1.0);');
      break;
  }
  return `{\n${lines.join('\n')}\nreturn;\n}\n`;
}

/** Patch compiled material shaders to draw in UV space and output `channel` (exported for tests). */
export function patchBakeShader(vertex: string, fragment: string, channel: MaterialChannel): { vertex: string; fragment: string } {
  const v = vertex.replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);');
  const nodes = /\bndC\b/.test(fragment);
  let f = fragment
    // the surface is seen from straight above (view-dependent nodes, back-facing mirrored islands)
    .replace(/vec3 ndI = [^;]*;/, 'vec3 ndI = ndN;')
    .replace(/gl_FrontFacing/g, 'true');
  // after the surface (and lighting setup) is known, before ambient occlusion and output
  const anchor = ['#include <aomap_fragment>', '#include <opaque_fragment>'].find((a) => f.includes(a));
  if (anchor) f = f.replace(anchor, outputGLSL(channel, nodes) + anchor);
  return { vertex: v, fragment: f };
}

function bakeVariant(src: Material, channel: MaterialChannel): Material {
  let per = variants.get(src);
  if (!per) variants.set(src, (per = new Map()));
  const hit = per.get(channel);
  if (hit && hit.version === src.version) return hit.mat;
  hit?.mat.dispose();
  const std = src as MeshStandardMaterial;
  let mat: MeshStandardMaterial;
  if (std.isMeshStandardMaterial) {
    mat = (std as MeshPhysicalMaterial).isMeshPhysicalMaterial ? new MeshPhysicalMaterial() : new MeshStandardMaterial();
    // copy everything but user data (which may hold large path tracer hints)
    const ud = src.userData;
    src.userData = {};
    mat.copy(std);
    src.userData = ud;
  } else {
    // unlit or custom shaders: their colour as base color
    mat = new MeshStandardMaterial({ color: (src as unknown as { color?: MeshStandardMaterial['color'] }).color ?? 0xcccccc });
  }
  const original = std.isMeshStandardMaterial ? src.onBeforeCompile.bind(src) : null;
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => {
    original?.(shader, renderer);
    const p = patchBakeShader(shader.vertexShader, shader.fragmentShader, channel);
    shader.vertexShader = p.vertex;
    shader.fragmentShader = p.fragment;
  };
  const key = std.isMeshStandardMaterial ? src.customProgramCacheKey() : 'std';
  mat.customProgramCacheKey = () => `${key}|bake:${channel}`;
  const groups = (src as unknown as { uniformsGroups?: unknown[] }).uniformsGroups;
  if (groups?.length) (mat as unknown as { uniformsGroups: unknown[] }).uniformsGroups = groups;
  if (src.onBeforeRender !== Material.prototype.onBeforeRender) mat.onBeforeRender = src.onBeforeRender.bind(src);
  mat.side = DoubleSide;
  mat.transparent = false;
  mat.blending = NoBlending;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.alphaTest = 0;
  mat.alphaHash = false;
  mat.toneMapped = false;
  per.set(channel, { version: src.version, mat });
  return mat;
}
