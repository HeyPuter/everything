// World node trees → equirectangular environment texture. The compiled world shader is rendered
// once into a float render target (re-baked only when the tree, its values or its images change)
// and handed to the viewport as its environment / background.
import {
  ShaderMaterial,
  Mesh,
  PlaneGeometry,
  Scene,
  OrthographicCamera,
  WebGLRenderTarget,
  HalfFloatType,
  RGBAFormat,
  LinearFilter,
  LinearSRGBColorSpace,
  Vector3,
  Vector4,
  Uniform,
  DataTexture,
  DataUtils,
  NearestFilter,
  ClampToEdgeWrapping,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { DocumentData, WorldData } from '../../data/types';
import { compileTree, type CompiledTree, type UniformSpec } from './codegen';
import { imageTexture } from '../../render/images';
import { setWorldBaker, type WorldEval } from '../../render/world';
import { renderContext } from '../../render/context';

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Fragment shader for a compiled world tree (exported for tests). */
export function worldFragment(ct: CompiledTree) {
  return `
#define ND_NO_DERIV
varying vec2 vUv;
uniform float ndTexel;
${ct.decls}
${ct.lib}
// nd-key:${ct.key}
void main() {
  float phi = (vUv.x - 0.5) * 6.2831853;
  float th = (vUv.y - 0.5) * 3.14159265;
  // texel direction in three.js' equirectangular convention (world space, Z up)
  vec3 ndDir = vec3(cos(th) * cos(phi), sin(th), cos(th) * sin(phi));
  vec2 ndWinUV = vUv;
  vec3 ndN = -ndDir;
  vec3 ndB = vec3(0.0, 1.0, 0.0);
  ${ct.body}
  gl_FragColor = vec4(max(ndC.emission, vec3(0.0)), 1.0);
}
`;
}

interface Bake {
  structKey: string;
  valueKey: string;
  material: ShaderMaterial;
  uniforms: Record<string, Uniform>;
  luts: DataTexture[];
  target: WebGLRenderTarget;
}

let current: Bake | null = null;
let quad: { scene: Scene; camera: OrthographicCamera; mesh: Mesh } | null = null;

function lut(data: Float32Array, width: number, nearest: boolean) {
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = DataUtils.toHalfFloat(data[i]);
  const t = new DataTexture(half, width, Math.max(1, Math.floor(data.length / 4 / width)), RGBAFormat, HalfFloatType);
  t.magFilter = t.minFilter = nearest ? NearestFilter : LinearFilter;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function value(doc: DocumentData, u: UniformSpec, luts: DataTexture[]): unknown {
  const v = u.value;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.length === 3 ? new Vector3(v[0], v[1], v[2]) : new Vector4(v[0], v[1], v[2], v[3] ?? 1);
  if (v.kind === 'lut') {
    const t = lut(v.data, v.width, !!v.nearest);
    luts.push(t);
    return t;
  }
  const img = v.image ? doc.images[v.image] : undefined;
  return img ? imageTexture(img, v.interpolation as 'Linear') : null;
}

function valueKey(doc: DocumentData, ct: CompiledTree) {
  const parts: string[] = [];
  for (const u of ct.uniforms) {
    const v = u.value;
    if (typeof v === 'number' || Array.isArray(v)) parts.push(JSON.stringify(v));
    else if (v.kind === 'lut') parts.push(Array.from(v.data.subarray(0, 1024), (x) => x.toFixed(4)).join(','));
    else {
      const img = v.image ? doc.images[v.image] : undefined;
      const tex = img ? (imageTexture(img, v.interpolation as 'Linear') as Texture) : null;
      parts.push(`${v.image}:${img?.revision ?? 0}:${tex?.version ?? 0}:${v.interpolation}`);
    }
  }
  return parts.join('|');
}

function resolution(doc: DocumentData, ct: CompiledTree): [number, number] {
  let w = 1024;
  for (const u of ct.uniforms) {
    const v = u.value;
    if (typeof v === 'object' && !Array.isArray(v) && v.kind === 'image' && v.image) {
      const img = doc.images[v.image];
      if (img) w = Math.max(w, Math.min(4096, img.width));
    }
  }
  w = Math.min(4096, 2 ** Math.ceil(Math.log2(w)));
  return [w, w / 2];
}

function render(renderer: WebGLRenderer, b: Bake) {
  quad ??= (() => {
    const scene = new Scene();
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mesh = new Mesh(new PlaneGeometry(2, 2));
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { scene, camera, mesh };
  })();
  quad.mesh.material = b.material;
  const prevTarget = renderer.getRenderTarget();
  const prevScissor = renderer.getScissorTest();
  const prevAutoClear = renderer.autoClear;
  const vp = new Vector4(),
    sc = new Vector4();
  renderer.getViewport(vp);
  renderer.getScissor(sc);
  renderer.setScissorTest(false);
  renderer.autoClear = true;
  renderer.setRenderTarget(b.target);
  renderer.render(quad.scene, quad.camera);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  renderer.setViewport(vp);
  renderer.setScissor(sc);
  renderer.setScissorTest(prevScissor);
}

/** Bake the world tree into an equirectangular texture (null if no renderer is available). */
let memo: { key: string; result: WorldEval } | null = null;

/** Cheap change key for a world tree (tree data + referenced image state). */
function memoKey(doc: DocumentData, w: WorldData) {
  let k = JSON.stringify(w.tree);
  for (const n of w.tree.nodes) {
    const id = n.props.image as string | undefined;
    const img = id ? doc.images[id] : undefined;
    if (img) k += `|${id}:${img.revision ?? 0}:${(imageTexture(img) as { version: number }).version}`;
  }
  for (const n of w.tree.nodes) {
    const gid = n.props.node_tree as string | undefined;
    if (gid && doc.node_groups[gid]) k += `|g${JSON.stringify(doc.node_groups[gid].tree)}`;
  }
  return k;
}

export function bakeWorld(doc: DocumentData, w: WorldData): WorldEval | null {
  const renderer = renderContext?.engine.renderer;
  if (!renderer) return null;
  const mk = memoKey(doc, w);
  if (memo && memo.key === mk) return memo.result;
  const result = bake(renderer, doc, w);
  memo = result ? { key: mk, result } : null;
  return result;
}

function bake(renderer: WebGLRenderer, doc: DocumentData, w: WorldData): WorldEval | null {
  const ct = compileTree(doc, w.tree, 'WORLD');
  const [W, H] = resolution(doc, ct);
  const structKey = `${ct.key}:${W}`;
  const vkey = valueKey(doc, ct);
  if (current && current.structKey === structKey && current.valueKey === vkey)
    return {
      kind: 'texture',
      texture: current.target.texture,
      key: `nw:${structKey}:${hashKey(vkey)}`,
    };
  if (!current || current.structKey !== structKey) {
    if (current) {
      current.material.dispose();
      current.luts.forEach((t) => t.dispose());
      // keep the previous target alive one more bake: it may still be the bound background
      const old = current.target;
      setTimeout(() => old.dispose(), 1000);
    }
    const luts: DataTexture[] = [];
    const uniforms: Record<string, Uniform> = {
      ndTexel: new Uniform(Math.PI / H),
    };
    for (const u of ct.uniforms) uniforms[u.name] = new Uniform(value(doc, u, luts));
    const material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: worldFragment(ct),
      uniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const target = new WebGLRenderTarget(W, H, {
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    target.texture.colorSpace = LinearSRGBColorSpace;
    current = { structKey, valueKey: '', material, uniforms, luts, target };
  } else {
    // same structure: update uniform values in place
    const luts = current.luts.splice(0);
    luts.forEach((t) => t.dispose());
    for (const u of ct.uniforms) current.uniforms[u.name].value = value(doc, u, current.luts);
    // render into a fresh target so the viewport sees a new texture key
    const old = current.target;
    current.target = new WebGLRenderTarget(W, H, {
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    current.target.texture.colorSpace = LinearSRGBColorSpace;
    setTimeout(() => old.dispose(), 1000);
  }
  current.valueKey = vkey;
  render(renderer, current);
  return {
    kind: 'texture',
    texture: current.target.texture,
    key: `nw:${structKey}:${hashKey(vkey)}`,
  };
}

function hashKey(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}${s.length}`;
}

setWorldBaker((doc, w) => {
  try {
    return bakeWorld(doc, w);
  } catch (e) {
    console.warn('World bake failed', e);
    return null;
  }
});
