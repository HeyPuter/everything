// View Layer ▸ Passes: data and light passes rendered with override materials after the
// beauty pass (Position, UV, Object/Material Index, Diffuse Color, Emission).
import { ShaderMaterial, DoubleSide, MeshBasicMaterial, Color, type Camera, type Material, type Mesh, type WebGLRenderer, type MeshPhysicalMaterial, type WebGLRenderTarget } from 'three';
import type { DocumentData, RenderSettings } from '../../data/types';
import { floatTarget, renderOverride } from './gbuffer';
import { pathTracerMaterial } from './ptmaterial';
import { materialSlots } from '../../editors/view3d/draw';
import type { RenderScene } from './renderscene';
import type { PassName } from './result';

export function wantsExtraPasses(r: RenderSettings): boolean {
  return !!(r.use_pass_position || r.use_pass_uv || r.use_pass_object_index || r.use_pass_material_index || r.use_pass_diffuse_color || r.use_pass_emit);
}

const positionMaterial = new ShaderMaterial({
  side: DoubleSide,
  vertexShader: /* glsl */ `
    #include <common>
    #include <batching_pars_vertex>
    varying vec3 vWorld;
    void main() {
      #include <batching_vertex>
      #include <begin_vertex>
      #include <project_vertex>
      vec4 wp = vec4(transformed, 1.0);
      #ifdef USE_BATCHING
        wp = batchingMatrix * wp;
      #endif
      #ifdef USE_INSTANCING
        wp = instanceMatrix * wp;
      #endif
      vWorld = (modelMatrix * wp).xyz;
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vWorld;
    void main() { gl_FragColor = vec4(vWorld, 1.0); }`,
});

const uvMaterial = new ShaderMaterial({
  side: DoubleSide,
  vertexShader: /* glsl */ `
    #include <common>
    #include <batching_pars_vertex>
    varying vec2 vUvPass;
    void main() {
      #include <batching_vertex>
      #include <begin_vertex>
      #include <project_vertex>
      #ifdef USE_UV
        vUvPass = uv;
      #else
        vUvPass = vec2(0.0);
      #endif
    }`,
  fragmentShader: /* glsl */ `
    varying vec2 vUvPass;
    void main() { gl_FragColor = vec4(vUvPass, 0.0, 1.0); }`,
});
// expose the uv attribute to the shader
uvMaterial.defines = { USE_UV: '' };

const flatCache = new Map<number, MeshBasicMaterial>();
/** Unlit material writing a constant value (index passes). */
function valueMaterial(v: number): MeshBasicMaterial {
  let m = flatCache.get(v);
  if (!m) {
    m = new MeshBasicMaterial({ color: new Color(v, v, v), side: DoubleSide, toneMapped: false });
    flatCache.set(v, m);
  }
  return m;
}

const colorCache = new WeakMap<Material, { diffuse: MeshBasicMaterial; emit: MeshBasicMaterial; version: number }>();
function colorMaterials(src: Material) {
  const pm = pathTracerMaterial(src) as MeshPhysicalMaterial;
  const hit = colorCache.get(src);
  if (hit && hit.version === pm.version) return hit;
  const diffuse = hit?.diffuse ?? new MeshBasicMaterial({ side: DoubleSide, toneMapped: false });
  const emit = hit?.emit ?? new MeshBasicMaterial({ side: DoubleSide, toneMapped: false });
  // the diffuse colour of metals and glass is black
  const k = (1 - Math.min(1, Math.max(0, pm.metalness))) * (1 - Math.min(1, Math.max(0, pm.transmission)));
  diffuse.color.copy(pm.color).multiplyScalar(k);
  diffuse.map = k > 0 ? pm.map : null;
  diffuse.vertexColors = pm.vertexColors;
  diffuse.needsUpdate = true;
  emit.color.copy(pm.emissive).multiplyScalar(pm.emissiveIntensity ?? 1);
  emit.map = pm.emissiveMap;
  emit.needsUpdate = true;
  const out = { diffuse, emit, version: pm.version };
  colorCache.set(src, out);
  return out;
}

function perMaterial(m: Mesh, fn: (mat: Material, slot: number) => Material): Material | Material[] {
  if (Array.isArray(m.material)) return m.material.map((x, i) => fn(x, i));
  return fn(m.material, 0);
}

function read(renderer: WebGLRenderer, rt: WebGLRenderTarget, W: number, H: number, channels: number): Float32Array {
  const buf = new Float32Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  const out = new Float32Array(W * H * channels);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W;
    for (let x = 0; x < W; x++) {
      const i = (src + x) * 4,
        o = (y * W + x) * channels;
      for (let c = 0; c < channels; c++) out[o + c] = buf[i + c];
    }
  }
  return out;
}

/** Render the enabled extra passes for the scene as seen by `camera` (top-down rows). */
export function extraPasses(renderer: WebGLRenderer, rs: RenderScene, camera: Camera, W: number, H: number, r: RenderSettings, doc: DocumentData): Partial<Record<PassName, Float32Array>> {
  const out: Partial<Record<PassName, Float32Array>> = {};
  const shadows = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  const rt = floatTarget(W, H);
  const pass = (name: PassName, channels: number, mat: Material | null, perMesh?: (m: Mesh) => Material | Material[]) => {
    renderOverride(renderer, rs.scene, camera, rt, mat, perMesh);
    out[name] = read(renderer, rt, W, H, channels);
  };
  try {
    if (r.use_pass_position) pass('Position', 4, positionMaterial);
    if (r.use_pass_uv) pass('UV', 4, uvMaterial);
    if (r.use_pass_object_index) pass('IndexOB', 1, null, (m) => valueMaterial(doc.objects[m.userData.id as string]?.pass_index ?? 0));
    if (r.use_pass_material_index)
      pass('IndexMA', 1, null, (m) => {
        const ob = doc.objects[m.userData.id as string];
        const slots = ob ? materialSlots(doc, ob) : [];
        return perMaterial(m, (_x, i) => valueMaterial(doc.materials[slots[i] ?? '']?.pass_index ?? 0));
      });
    if (r.use_pass_diffuse_color) pass('DiffCol', 4, null, (m) => perMaterial(m, (x) => colorMaterials(x).diffuse));
    if (r.use_pass_emit) pass('Emit', 4, null, (m) => perMaterial(m, (x) => colorMaterials(x).emit));
  } finally {
    rt.dispose();
    renderer.shadowMap.enabled = shadows;
  }
  return out;
}
