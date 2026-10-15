// Material data-blocks → three.js materials for Material Preview / Rendered modes.
// The full shader-node compiler registers itself through `setMaterialCompiler`;
// this module provides the cache and a direct Principled-BSDF fallback.
import { MeshPhysicalMaterial, Color, DoubleSide, FrontSide, type Material } from 'three';
import type { DocumentData, MaterialData, NodeData } from '../data/types';
import { imageTexture } from './images';
import { applyRealtimeMaterial, withRealtimeFx } from './realtime/materialfx';

export type MaterialCompiler = (doc: DocumentData, ma: MaterialData) => Material;

let compiler: MaterialCompiler | null = null;
export function setMaterialCompiler(c: MaterialCompiler) {
  compiler = c;
  cache.clear();
}

const cache = new Map<string, { key: string; mat: Material }>();

/** Extra cache-key data (e.g. node groups used by the tree), registered by the node compiler. */
let materialKeyExtra: ((doc: DocumentData, ma: MaterialData) => string) | null = null;
export function setMaterialKeyExtra(f: ((doc: DocumentData, ma: MaterialData) => string) | null) {
  materialKeyExtra = f;
  cache.clear();
}

function materialKey(doc: DocumentData, ma: MaterialData) {
  let k = JSON.stringify(ma);
  if (materialKeyExtra) k += materialKeyExtra(doc, ma);
  for (const n of ma.tree.nodes) {
    const img = n.props.image as string | undefined;
    if (img && doc.images[img]) k += `|${img}:${doc.images[img].revision ?? 0}:${doc.images[img].bytes?.length ?? 0}`;
  }
  return k;
}

export function viewportMaterial(doc: DocumentData, id: string | null | undefined): Material {
  const ma = id ? doc.materials[id] : undefined;
  if (!ma) return defaultMaterial;
  const key = materialKey(doc, ma);
  const hit = cache.get(ma.id);
  if (hit && hit.key === key) return hit.mat;
  hit?.mat.dispose();
  let mat: Material;
  try {
    mat = compiler ? compiler(doc, ma) : principledFallback(doc, ma);
  } catch (e) {
    console.warn('Material compile failed', e);
    mat = errorMaterial;
  }
  cache.set(ma.id, { key, mat });
  return mat;
}

export const defaultMaterial = withRealtimeFx(new MeshPhysicalMaterial({ color: new Color(0.8, 0.8, 0.8), roughness: 0.5, metalness: 0, side: DoubleSide }));
export const errorMaterial = withRealtimeFx(new MeshPhysicalMaterial({ color: new Color(1, 0, 1), roughness: 0.5 }));

function input(n: NodeData, name: string, def: unknown) {
  return n.inputs[name] ?? def;
}

export function principledFallback(doc: DocumentData, ma: MaterialData): Material {
  const m = principledBase(doc, ma);
  applyRealtimeMaterial(m, ma);
  return withRealtimeFx(m);
}

function principledBase(doc: DocumentData, ma: MaterialData): Material {
  const out = ma.tree.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial');
  const link = out && ma.tree.links.find((l) => l.to_node === out.id && l.to_socket === 'Surface');
  const bsdf = link ? ma.tree.nodes.find((n) => n.id === link.from_node) : undefined;
  const m = new MeshPhysicalMaterial({ side: ma.use_backface_culling ? FrontSide : DoubleSide });
  if (!ma.use_nodes || !bsdf) {
    m.color.setRGB(ma.diffuse_color[0], ma.diffuse_color[1], ma.diffuse_color[2]);
    m.metalness = ma.metallic;
    m.roughness = ma.roughness;
    return m;
  }
  if (bsdf.type === 'ShaderNodeBsdfPrincipled') {
    const bc = input(bsdf, 'Base Color', [0.8, 0.8, 0.8, 1]) as number[];
    m.color.setRGB(bc[0], bc[1], bc[2]);
    m.metalness = input(bsdf, 'Metallic', 0) as number;
    m.roughness = input(bsdf, 'Roughness', 0.5) as number;
    m.ior = input(bsdf, 'IOR', 1.5) as number;
    const alpha = input(bsdf, 'Alpha', 1) as number;
    m.opacity = alpha;
    // blended transparency sorts; clip cuts; otherwise transparency is dithered
    m.transparent = ma.blend_method === 'BLEND';
    m.alphaTest = ma.blend_method === 'CLIP' && alpha < 1 ? Math.max(1e-4, ma.alpha_threshold) : 0;
    m.alphaHash = alpha < 1 && ma.blend_method !== 'BLEND' && ma.blend_method !== 'CLIP';
    m.transmission = input(bsdf, 'Transmission Weight', 0) as number;
    m.clearcoat = input(bsdf, 'Coat Weight', 0) as number;
    m.clearcoatRoughness = input(bsdf, 'Coat Roughness', 0.03) as number;
    m.sheen = input(bsdf, 'Sheen Weight', 0) as number;
    const ec = input(bsdf, 'Emission Color', [1, 1, 1, 1]) as number[];
    const es = input(bsdf, 'Emission Strength', 0) as number;
    m.emissive.setRGB(ec[0], ec[1], ec[2]);
    m.emissiveIntensity = es;
    // image texture on Base Color
    const bcl = ma.tree.links.find((l) => l.to_node === bsdf.id && l.to_socket === 'Base Color');
    const tex = bcl ? ma.tree.nodes.find((n) => n.id === bcl.from_node && n.type === 'ShaderNodeTexImage') : undefined;
    const img = tex?.props.image ? doc.images[tex.props.image as string] : undefined;
    if (img) {
      m.map = imageTexture(img, (tex!.props.interpolation as 'Linear') ?? 'Linear');
      m.color.setRGB(1, 1, 1);
    }
  } else if (bsdf.type === 'ShaderNodeEmission') {
    const c = input(bsdf, 'Color', [1, 1, 1, 1]) as number[];
    m.color.setRGB(0, 0, 0);
    m.emissive.setRGB(c[0], c[1], c[2]);
    m.emissiveIntensity = input(bsdf, 'Strength', 1) as number;
  } else if (bsdf.type === 'ShaderNodeBsdfDiffuse') {
    const c = input(bsdf, 'Color', [0.8, 0.8, 0.8, 1]) as number[];
    m.color.setRGB(c[0], c[1], c[2]);
    m.roughness = 1;
  }
  return m;
}
