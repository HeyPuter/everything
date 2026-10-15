// IR material ⇄ Principled BSDF node trees.
// Socket keys are the node socket identifiers (e.g. 'Base Color', 'A_Color').
import type { DocumentData, LinkData, MaterialData, NodeData, NodeTreeData, ID } from '../../data/types';
import { newMaterial, uid } from '../../data/defaults';
import type { IRMaterial, IRTexRef } from './ir';

// ---------------------------------------------------------------------------
// Build

class TreeBuilder {
  nodes: NodeData[] = [];
  links: LinkData[] = [];
  node(type: string, name: string, x: number, y: number, inputs: NodeData['inputs'] = {}, props: NodeData['props'] = {}, label?: string): NodeData {
    let n = name,
      i = 1;
    while (this.nodes.some((o) => o.name === n)) n = `${name}.${String(i++).padStart(3, '0')}`;
    const node: NodeData = { id: uid('node'), type, name: n, location: [x, y], inputs, props, ...(label ? { label } : {}) };
    this.nodes.push(node);
    return node;
  }
  link(from: NodeData, fromSocket: string, to: NodeData, toSocket: string) {
    this.links.push({ id: uid('link'), from_node: from.id, from_socket: fromSocket, to_node: to.id, to_socket: toSocket });
  }
}

/**
 * Build a material from an IR material. `imageIds[i]` is the document image id for IR image i.
 */
export function buildMaterial(ir: IRMaterial, imageIds: (ID | null)[], name: string): MaterialData {
  const ma = newMaterial(name, ir.baseColor);
  const b = new TreeBuilder();
  const bsdf = b.node('ShaderNodeBsdfPrincipled', 'Principled BSDF', 10, 300, {}, { distribution: 'MULTI_GGX', subsurface_method: 'RANDOM_WALK' });
  bsdf.width = 240;
  const out = b.node('ShaderNodeOutputMaterial', 'Material Output', 300, 300, {}, { target: 'ALL', is_active_output: true });
  b.link(bsdf, 'BSDF', out, 'Surface');
  const inp = bsdf.inputs;
  inp['Base Color'] = [...ir.baseColor.slice(0, 3), 1];
  inp['Metallic'] = ir.metallic;
  inp['Roughness'] = ir.roughness;
  inp['IOR'] = ir.ior ?? 1.5;
  inp['Alpha'] = ir.baseColor[3];
  if (ir.emissive) inp['Emission Color'] = [...ir.emissive, 1];
  inp['Emission Strength'] = ir.emissive && (ir.emissive[0] || ir.emissive[1] || ir.emissive[2] || ir.emissiveTex) ? (ir.emissiveStrength ?? 1) : 0;
  if (ir.transmission) inp['Transmission Weight'] = ir.transmission;
  if (ir.specular !== undefined) inp['Specular IOR Level'] = ir.specular;
  if (ir.specularTint) inp['Specular Tint'] = [...ir.specularTint, 1];
  if (ir.clearcoat) {
    inp['Coat Weight'] = ir.clearcoat;
    inp['Coat Roughness'] = ir.clearcoatRoughness ?? 0.03;
  }
  if (ir.sheenColor && (ir.sheenColor[0] || ir.sheenColor[1] || ir.sheenColor[2])) {
    inp['Sheen Weight'] = 1;
    inp['Sheen Tint'] = [...ir.sheenColor, 1];
    inp['Sheen Roughness'] = ir.sheenRoughness ?? 0.5;
  }

  let row = 0;
  const uvNodes = new Map<string, NodeData>();
  let texCoord: NodeData | null = null;
  const imageNode = (ref: IRTexRef, label: string): NodeData | null => {
    const imageId = imageIds[ref.image];
    if (!imageId) return null;
    const y = 300 - row * 300;
    row++;
    const tex = b.node(
      'ShaderNodeTexImage',
      'Image Texture',
      -500,
      y,
      {},
      { image: imageId, interpolation: ref.interpolation ?? 'Linear', extension: ref.extension ?? 'REPEAT', projection: 'FLAT' },
      label,
    );
    const hasXf = (ref.offset && (ref.offset[0] || ref.offset[1])) || ref.rotation || (ref.scale && (ref.scale[0] !== 1 || ref.scale[1] !== 1));
    if (hasXf) {
      const key = JSON.stringify([ref.offset, ref.rotation, ref.scale]);
      let map = uvNodes.get(key);
      if (!map) {
        texCoord ??= b.node('ShaderNodeTexCoord', 'Texture Coordinate', -1100, 300);
        map = b.node('ShaderNodeMapping', 'Mapping', -850, y, mappingInputs(ref), { vector_type: 'POINT' });
        b.link(texCoord, 'UV', map, 'Vector');
        uvNodes.set(key, map);
      }
      b.link(map, 'Vector', tex, 'Vector');
    }
    return tex;
  };
  const channelOut = (tex: NodeData, ch: IRTexRef['channel'] | undefined, x: number): [NodeData, string] => {
    if (!ch || ch === 'RGB') return [tex, 'Color'];
    if (ch === 'A') return [tex, 'Alpha'];
    const sep = b.node('ShaderNodeSeparateColor', 'Separate Color', x, tex.location[1], {}, { mode: 'RGB' });
    b.link(tex, 'Color', sep, 'Color');
    return [sep, ch === 'R' ? 'Red' : ch === 'G' ? 'Green' : 'Blue'];
  };

  // Base color (× factor, × vertex color)
  let baseSrc: [NodeData, string] | null = null;
  if (ir.baseColorTex) {
    const tex = imageNode(ir.baseColorTex, 'Base Color');
    if (tex) {
      baseSrc = [tex, 'Color'];
      const f = ir.baseColor;
      if (f[0] !== 1 || f[1] !== 1 || f[2] !== 1) {
        const mix = b.node(
          'ShaderNodeMix',
          'Mix',
          -200,
          tex.location[1],
          { Factor_Float: 1, B_Color: [f[0], f[1], f[2], 1] },
          { data_type: 'RGBA', blend_type: 'MULTIPLY', clamp_result: false, clamp_factor: true },
        );
        b.link(tex, 'Color', mix, 'A_Color');
        baseSrc = [mix, 'Result_Color'];
      }
      if (ir.alphaMode && ir.alphaMode !== 'OPAQUE' && !ir.alphaTex) {
        if (f[3] !== 1) {
          const m = b.node('ShaderNodeMath', 'Math', -200, tex.location[1] - 200, { Value_001: f[3] }, { operation: 'MULTIPLY', use_clamp: false });
          b.link(tex, 'Alpha', m, 'Value');
          b.link(m, 'Value', bsdf, 'Alpha');
        } else b.link(tex, 'Alpha', bsdf, 'Alpha');
      }
    }
  }
  if (ir.useVertexColor) {
    const vc = b.node('ShaderNodeVertexColor', 'Color Attribute', -500, 300 - row++ * 300, {}, { layer_name: '' });
    if (baseSrc) {
      const mix = b.node('ShaderNodeMix', 'Mix', -200, vc.location[1], { Factor_Float: 1 }, { data_type: 'RGBA', blend_type: 'MULTIPLY', clamp_result: false, clamp_factor: true });
      b.link(baseSrc[0], baseSrc[1], mix, 'A_Color');
      b.link(vc, 'Color', mix, 'B_Color');
      baseSrc = [mix, 'Result_Color'];
    } else {
      const f = ir.baseColor;
      if (f[0] !== 1 || f[1] !== 1 || f[2] !== 1) {
        const mix = b.node(
          'ShaderNodeMix',
          'Mix',
          -200,
          vc.location[1],
          { Factor_Float: 1, B_Color: [f[0], f[1], f[2], 1] },
          { data_type: 'RGBA', blend_type: 'MULTIPLY', clamp_result: false, clamp_factor: true },
        );
        b.link(vc, 'Color', mix, 'A_Color');
        baseSrc = [mix, 'Result_Color'];
      } else baseSrc = [vc, 'Color'];
    }
  }
  if (baseSrc) b.link(baseSrc[0], baseSrc[1], bsdf, 'Base Color');
  if (ir.alphaTex) {
    const tex = imageNode(ir.alphaTex, 'Alpha');
    if (tex) {
      const [n, s] = channelOut(tex, ir.alphaTex.channel ?? 'A', -250);
      b.link(n, s, bsdf, 'Alpha');
    }
  }

  // Metallic / roughness
  if (ir.metallicRoughnessTex) {
    const tex = imageNode(ir.metallicRoughnessTex, 'Metallic Roughness');
    if (tex) {
      const sep = b.node('ShaderNodeSeparateColor', 'Separate Color', -250, tex.location[1], {}, { mode: 'RGB' });
      b.link(tex, 'Color', sep, 'Color');
      const route = (socket: 'Green' | 'Blue', target: 'Roughness' | 'Metallic', factor: number) => {
        if (factor === 1) b.link(sep, socket, bsdf, target);
        else {
          const m = b.node('ShaderNodeMath', 'Math', -100, tex.location[1] - (target === 'Metallic' ? 0 : 150), { Value_001: factor }, { operation: 'MULTIPLY', use_clamp: false });
          b.link(sep, socket, m, 'Value');
          b.link(m, 'Value', bsdf, target);
        }
      };
      route('Green', 'Roughness', ir.roughness);
      route('Blue', 'Metallic', ir.metallic);
    }
  }
  for (const [ref, target] of [
    [ir.metallicTex, 'Metallic'],
    [ir.roughnessTex, 'Roughness'],
  ] as const) {
    if (!ref) continue;
    const tex = imageNode(ref, target);
    if (!tex) continue;
    const [n, s] = channelOut(tex, ref.channel ?? 'R', -250);
    b.link(n, s, bsdf, target);
  }

  // Normal / bump
  if (ir.normalTex) {
    const tex = imageNode(ir.normalTex, 'Normal');
    if (tex) {
      const nm = b.node('ShaderNodeNormalMap', 'Normal Map', -200, tex.location[1], { Strength: ir.normalTex.strength ?? 1 }, { space: 'TANGENT', uv_map: '' });
      b.link(tex, 'Color', nm, 'Color');
      b.link(nm, 'Normal', bsdf, 'Normal');
    }
  } else if (ir.bumpTex) {
    const tex = imageNode(ir.bumpTex, 'Bump');
    if (tex) {
      const bump = b.node('ShaderNodeBump', 'Bump', -200, tex.location[1], { Strength: Math.min(1, ir.bumpTex.strength ?? 1), Distance: 1 }, { invert: false });
      b.link(tex, 'Color', bump, 'Height');
      b.link(bump, 'Normal', bsdf, 'Normal');
    }
  }

  // Emission
  if (ir.emissiveTex) {
    const tex = imageNode(ir.emissiveTex, 'Emission');
    if (tex) {
      const e = ir.emissive ?? [1, 1, 1];
      if (e[0] !== 1 || e[1] !== 1 || e[2] !== 1) {
        const mix = b.node(
          'ShaderNodeMix',
          'Mix',
          -200,
          tex.location[1],
          { Factor_Float: 1, B_Color: [e[0], e[1], e[2], 1] },
          { data_type: 'RGBA', blend_type: 'MULTIPLY', clamp_result: false, clamp_factor: true },
        );
        b.link(tex, 'Color', mix, 'A_Color');
        b.link(mix, 'Result_Color', bsdf, 'Emission Color');
      } else b.link(tex, 'Color', bsdf, 'Emission Color');
      inp['Emission Strength'] = ir.emissiveStrength ?? 1;
    }
  }
  if (ir.transmissionTex) {
    const tex = imageNode(ir.transmissionTex, 'Transmission');
    if (tex) {
      const [n, s] = channelOut(tex, ir.transmissionTex.channel ?? 'R', -250);
      b.link(n, s, bsdf, 'Transmission Weight');
    }
  }

  // Unlit: emission-only shader
  if (ir.unlit) {
    inp['Emission Color'] = [...ir.baseColor.slice(0, 3), 1];
    inp['Emission Strength'] = 1;
    inp['Base Color'] = [0, 0, 0, 1];
    inp['Roughness'] = 1;
    inp['Specular IOR Level'] = 0;
    const link = b.links.find((l) => l.to_node === bsdf.id && l.to_socket === 'Base Color');
    if (link) link.to_socket = 'Emission Color';
  }

  const tree: NodeTreeData = { type: 'SHADER', nodes: b.nodes, links: b.links };
  ma.tree = tree;
  ma.diffuse_color = [...ir.baseColor] as [number, number, number, number];
  ma.metallic = ir.metallic;
  ma.roughness = ir.roughness;
  ma.blend_method = ir.alphaMode === 'BLEND' ? 'BLEND' : ir.alphaMode === 'MASK' ? 'CLIP' : 'OPAQUE';
  if (ir.alphaMode === 'BLEND') ma.shadow_method = 'HASHED';
  if (ir.alphaMode === 'MASK') ma.shadow_method = 'CLIP';
  ma.alpha_threshold = ir.alphaCutoff ?? 0.5;
  ma.use_backface_culling = ir.doubleSided === false;
  return ma;
}

function mappingInputs(ref: IRTexRef): NodeData['inputs'] {
  // KHR_texture_transform operates on glTF UVs (top-left origin); our UVs are bottom-left
  // (v' = 1 - v). Convert the 2D affine transform accordingly.
  const [ox, oy] = ref.offset ?? [0, 0];
  const [sx, sy] = ref.scale ?? [1, 1];
  const r = ref.rotation ?? 0;
  const c = Math.cos(r),
    s = Math.sin(r);
  // glTF: uv_out = T(o) * R(r) * S(s) * uv, with R = [[c, s], [-s, c]]
  // In flipped space: u' = u, v' = 1 - v. Express as Mapping (POINT): out = T * R(-r about Z)... computed numerically.
  const map = (u: number, v: number): [number, number] => {
    const gu = u,
      gv = 1 - v;
    const x = c * sx * gu + s * sy * gv + ox,
      y = -s * sx * gu + c * sy * gv + oy;
    return [x, 1 - y];
  };
  const o = map(0, 0),
    ex = map(1, 0),
    ey = map(0, 1);
  const ax = [ex[0] - o[0], ex[1] - o[1]],
    ay = [ey[0] - o[0], ey[1] - o[1]];
  const scaleX = Math.hypot(ax[0], ax[1]),
    rot = Math.atan2(ax[1], ax[0]);
  const det = ax[0] * ay[1] - ax[1] * ay[0];
  const scaleY = Math.sign(det || 1) * Math.hypot(ay[0], ay[1]);
  return { Location: [o[0], o[1], 0], Rotation: [0, 0, rot], Scale: [scaleX, scaleY, 1] };
}

// ---------------------------------------------------------------------------
// Read (for exporters)

export interface ExportTexRef extends Omit<IRTexRef, 'image'> {
  /** document image id */
  imageId: ID;
}

export interface ExportMaterial extends Omit<
  IRMaterial,
  'baseColorTex' | 'metallicRoughnessTex' | 'metallicTex' | 'roughnessTex' | 'normalTex' | 'bumpTex' | 'emissiveTex' | 'occlusionTex' | 'alphaTex' | 'transmissionTex'
> {
  id: ID;
  baseColorTex?: ExportTexRef;
  metallicTex?: ExportTexRef;
  roughnessTex?: ExportTexRef;
  normalTex?: ExportTexRef & { strength?: number };
  emissiveTex?: ExportTexRef;
  alphaTex?: ExportTexRef;
  transmissionTex?: ExportTexRef;
  warnings: string[];
}

function num(v: unknown, d: number) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function col(v: unknown, d: number[]): number[] {
  return Array.isArray(v) && v.length >= 3 ? (v as number[]) : d;
}

/** Inspect a material's node tree and summarise it as Principled parameters + textures. */
export function readMaterial(doc: DocumentData, ma: MaterialData): ExportMaterial {
  const warnings: string[] = [];
  const res: ExportMaterial = {
    id: ma.id,
    name: ma.name,
    baseColor: [...ma.diffuse_color] as [number, number, number, number],
    metallic: ma.metallic,
    roughness: ma.roughness,
    alphaMode: ma.blend_method === 'BLEND' || ma.blend_method === 'HASHED' ? 'BLEND' : ma.blend_method === 'CLIP' ? 'MASK' : 'OPAQUE',
    alphaCutoff: ma.alpha_threshold,
    doubleSided: !ma.use_backface_culling,
    warnings,
  };
  const t = ma.tree;
  if (!ma.use_nodes || !t) return res;
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const out = t.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial' && n.props.is_active_output !== false) ?? t.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial');
  const linkTo = (n: NodeData, socket: string) => t.links.find((l) => l.to_node === n.id && l.to_socket === socket && !l.is_muted);
  const surf = out && linkTo(out, 'Surface');
  const shader = surf ? byId.get(surf.from_node) : undefined;
  if (!shader) return res;
  if (shader.type === 'ShaderNodeEmission') {
    const c = col(shader.inputs['Color'], [1, 1, 1]);
    res.baseColor = [0, 0, 0, 1];
    res.emissive = [c[0], c[1], c[2]];
    res.emissiveStrength = num(shader.inputs['Strength'], 1);
    return res;
  }
  if (shader.type === 'ShaderNodeBsdfDiffuse') {
    const c = col(shader.inputs['Color'], [0.8, 0.8, 0.8]);
    res.baseColor = [c[0], c[1], c[2], 1];
    res.roughness = 1;
    return res;
  }
  if (shader.type !== 'ShaderNodeBsdfPrincipled') {
    warnings.push(`Material "${ma.name}": shader "${shader.name}" is not a Principled BSDF; exported with viewport colors`);
    return res;
  }
  const I = shader.inputs;
  const bc = col(I['Base Color'], [0.8, 0.8, 0.8]);
  res.baseColor = [bc[0], bc[1], bc[2], num(I['Alpha'], 1)];
  res.metallic = num(I['Metallic'], 0);
  res.roughness = num(I['Roughness'], 0.5);
  res.ior = num(I['IOR'], 1.5);
  const es = num(I['Emission Strength'], 0);
  const ec = col(I['Emission Color'], [1, 1, 1]);
  if (es > 0) {
    res.emissive = [ec[0], ec[1], ec[2]];
    res.emissiveStrength = es;
  }
  res.transmission = num(I['Transmission Weight'], 0);
  res.clearcoat = num(I['Coat Weight'], 0);
  res.clearcoatRoughness = num(I['Coat Roughness'], 0.03);
  if (num(I['Sheen Weight'], 0) > 0) {
    const st = col(I['Sheen Tint'], [1, 1, 1]);
    const w = num(I['Sheen Weight'], 0);
    res.sheenColor = [st[0] * w, st[1] * w, st[2] * w];
    res.sheenRoughness = num(I['Sheen Roughness'], 0.5);
  }
  if (I['Specular IOR Level'] !== undefined) res.specular = num(I['Specular IOR Level'], 0.5);

  // Follow links upstream to an image texture, recording channel / factor / mapping.
  interface Trace {
    tex?: NodeData;
    channel?: IRTexRef['channel'];
    factor?: number[];
    scalar?: number;
    vertexColor?: boolean;
    normalStrength?: number;
  }
  const trace = (n: NodeData | undefined, socket: string, depth = 0): Trace => {
    if (!n || depth > 8) return {};
    if (n.type === 'ShaderNodeTexImage') return { tex: n, channel: socket === 'Alpha' ? 'A' : 'RGB' };
    if (n.type === 'ShaderNodeVertexColor' || n.type === 'ShaderNodeAttribute') return { vertexColor: true };
    if (n.type === 'ShaderNodeSeparateColor' || n.type === 'ShaderNodeSeparateRGB') {
      const l = linkTo(n, n.type === 'ShaderNodeSeparateRGB' ? 'Image' : 'Color');
      const r = l ? trace(byId.get(l.from_node), l.from_socket, depth + 1) : {};
      const ch = socket.startsWith('R') ? 'R' : socket.startsWith('G') ? 'G' : 'B';
      return { ...r, channel: ch };
    }
    if (n.type === 'ShaderNodeNormalMap') {
      const l = linkTo(n, 'Color');
      const r = l ? trace(byId.get(l.from_node), l.from_socket, depth + 1) : {};
      return { ...r, normalStrength: num(n.inputs['Strength'], 1) };
    }
    if ((n.type === 'ShaderNodeMix' && n.props.blend_type === 'MULTIPLY') || (n.type === 'ShaderNodeMixRGB' && n.props.blend_type === 'MULTIPLY')) {
      const aKey = n.type === 'ShaderNodeMix' ? 'A_Color' : 'Color1',
        bKey = n.type === 'ShaderNodeMix' ? 'B_Color' : 'Color2';
      const la = linkTo(n, aKey),
        lb = linkTo(n, bKey);
      const ra = la ? trace(byId.get(la.from_node), la.from_socket, depth + 1) : {};
      const rb = lb ? trace(byId.get(lb.from_node), lb.from_socket, depth + 1) : {};
      const tex = ra.tex ?? rb.tex;
      const vc = ra.vertexColor || rb.vertexColor;
      const f = !la ? col(n.inputs[aKey], [1, 1, 1]) : !lb ? col(n.inputs[bKey], [1, 1, 1]) : undefined;
      return { tex, channel: (ra.tex ? ra.channel : rb.channel) ?? 'RGB', factor: f, vertexColor: vc };
    }
    if (n.type === 'ShaderNodeMath' && n.props.operation === 'MULTIPLY') {
      const l0 = linkTo(n, 'Value'),
        l1 = linkTo(n, 'Value_001');
      const r = l0 ? trace(byId.get(l0.from_node), l0.from_socket, depth + 1) : l1 ? trace(byId.get(l1.from_node), l1.from_socket, depth + 1) : {};
      const s = l0 && !l1 ? num(n.inputs['Value_001'], 1) : l1 && !l0 ? num(n.inputs['Value'], 1) : 1;
      return { ...r, scalar: s };
    }
    if (n.type === 'NodeReroute') {
      const l = linkTo(n, 'Input');
      return l ? trace(byId.get(l.from_node), l.from_socket, depth + 1) : {};
    }
    return {};
  };
  const mapping = (tex: NodeData): Partial<IRTexRef> => {
    const l = linkTo(tex, 'Vector');
    const m = l ? byId.get(l.from_node) : undefined;
    if (!m || m.type !== 'ShaderNodeMapping') return {};
    const loc = col(m.inputs['Location'], [0, 0, 0]),
      rot = col(m.inputs['Rotation'], [0, 0, 0]),
      sc = col(m.inputs['Scale'], [1, 1, 1]);
    return mappingToGltf(loc, rot[2], sc);
  };
  const ref = (tex: NodeData, channel: IRTexRef['channel']): ExportTexRef | undefined => {
    const imageId = tex.props.image as string | undefined;
    if (!imageId || !doc.images[imageId]) return undefined;
    return {
      imageId,
      channel,
      interpolation: tex.props.interpolation === 'Closest' ? 'Closest' : 'Linear',
      extension: (tex.props.extension as IRTexRef['extension']) ?? 'REPEAT',
      ...mapping(tex),
    };
  };
  const linked = (socket: string) => {
    const l = linkTo(shader, socket);
    return l ? trace(byId.get(l.from_node), l.from_socket) : null;
  };
  const base = linked('Base Color');
  if (base) {
    if (base.tex) {
      res.baseColorTex = ref(base.tex, 'RGB');
      const f = base.factor ?? [1, 1, 1];
      res.baseColor = [f[0], f[1], f[2], res.baseColor[3]];
    }
    if (base.vertexColor) {
      res.useVertexColor = true;
      if (!base.tex) {
        const f = base.factor ?? [1, 1, 1];
        res.baseColor = [f[0], f[1], f[2], res.baseColor[3]];
      }
    }
    if (!base.tex && !base.vertexColor) warnings.push(`Material "${ma.name}": Base Color input is driven by nodes that cannot be exported`);
  }
  const alpha = linked('Alpha');
  if (alpha?.tex) {
    const r = ref(alpha.tex, alpha.channel);
    if (r && base?.tex && alpha.tex.id === base.tex.id && alpha.channel === 'A') res.baseColor[3] = alpha.scalar ?? 1;
    else if (r) res.alphaTex = r;
    if (res.alphaMode === 'OPAQUE') res.alphaMode = 'BLEND';
  }
  const rough = linked('Roughness'),
    metal = linked('Metallic');
  if (rough?.tex) {
    res.roughnessTex = ref(rough.tex, rough.channel === 'RGB' ? 'R' : rough.channel);
    res.roughness = rough.scalar ?? 1;
  }
  if (metal?.tex) {
    res.metallicTex = ref(metal.tex, metal.channel === 'RGB' ? 'R' : metal.channel);
    res.metallic = metal.scalar ?? 1;
  }
  const nrm = linked('Normal');
  if (nrm?.tex) {
    const r = ref(nrm.tex, 'RGB');
    if (r) res.normalTex = { ...r, strength: nrm.normalStrength ?? 1 };
  }
  const em = linked('Emission Color');
  if (em?.tex) {
    res.emissiveTex = ref(em.tex, 'RGB');
    const f = em.factor ?? [1, 1, 1];
    res.emissive = [f[0], f[1], f[2]];
    res.emissiveStrength = es || 1;
  }
  const tr = linked('Transmission Weight');
  if (tr?.tex) {
    res.transmissionTex = ref(tr.tex, tr.channel === 'RGB' ? 'R' : tr.channel);
    res.transmission = 1;
  }
  return res;
}

/** Inverse of `mappingInputs`: Mapping node (POINT) → KHR_texture_transform. */
export function mappingToGltf(loc: number[], rotZ: number, sc: number[]): Pick<IRTexRef, 'offset' | 'rotation' | 'scale'> {
  const c = Math.cos(rotZ),
    s = Math.sin(rotZ);
  // our mapping: p' = loc + Rz(rot) * (scale ⊙ p)
  const map = (u: number, v: number): [number, number] => {
    const x = sc[0] * u,
      y = sc[1] * v;
    return [loc[0] + c * x - s * y, loc[1] + s * x + c * y];
  };
  // glTF space: g = (u, 1 - v)
  const g = (gu: number, gv: number): [number, number] => {
    const r = map(gu, 1 - gv);
    return [r[0], 1 - r[1]];
  };
  const o = g(0, 0),
    ex = g(1, 0),
    ey = g(0, 1);
  const ax = [ex[0] - o[0], ex[1] - o[1]],
    ay = [ey[0] - o[0], ey[1] - o[1]];
  // glTF: column x = (c*sx, -s*sx), column y = (s*sy, c*sy)
  const sx = Math.hypot(ax[0], ax[1]);
  const rot = Math.atan2(-ax[1], ax[0]);
  const det = ax[0] * ay[1] - ax[1] * ay[0];
  const sy = Math.sign(det || 1) * Math.hypot(ay[0], ay[1]);
  const out: Pick<IRTexRef, 'offset' | 'rotation' | 'scale'> = {};
  if (Math.abs(o[0]) > 1e-7 || Math.abs(o[1]) > 1e-7) out.offset = [o[0], o[1]];
  if (Math.abs(rot) > 1e-7) out.rotation = rot;
  if (Math.abs(sx - 1) > 1e-7 || Math.abs(sy - 1) > 1e-7) out.scale = [sx, sy];
  return out;
}
