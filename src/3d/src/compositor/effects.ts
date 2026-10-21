// Built-in compositor effects: node groups made in code from the compositor's own nodes (Vignette,
// Film Grain, Sensor Noise, Chromatic Aberration, Sepia, Split Toning, Unsharp Mask, Tune Image).
// They are offered on the compositor's asset shelf and in its Add menu; adding one appends its node
// group to the file once (later uses reuse it) and places a group node.
import type { DocumentData, NodeData, NodeGroupData, NodeTreeData, SocketValue } from '../data/types';
import type { SocketType } from '../nodes/types';
import { uid } from '../data/defaults';
import { addInterfaceSocket, addNode, connect, ctxOf, uniqueGroupName } from '../nodes/tree';

export interface Effect {
  id: string;
  name: string;
  /** shelf / Add-menu category */
  category: 'Camera & Lens Effects' | 'Creative' | 'Utilities';
  description: string;
  build(doc: DocumentData): NodeTreeData;
}

export const EFFECT_CATEGORIES: Effect['category'][] = ['Camera & Lens Effects', 'Creative', 'Utilities'];

/** Small builder for effect trees. */
class Builder {
  tree: NodeTreeData = { type: 'COMPOSITOR', nodes: [], links: [], interface: [] };
  gin: NodeData;
  gout: NodeData;
  private ins: Record<string, string> = {};
  constructor(private doc: DocumentData) {
    this.gin = addNode(this.tree, 'NodeGroupInput', [-900, 0]);
    this.gout = addNode(this.tree, 'NodeGroupOutput', [700, 0]);
    this.input('Image', 'RGBA', [1, 1, 1, 1]);
    addInterfaceSocket(this.tree, 'OUTPUT', 'Image', 'RGBA');
  }
  /** Group input socket; returns its identifier. */
  input(name: string, type: SocketType, d: SocketValue, o: { min?: number; max?: number; description?: string } = {}) {
    const it = addInterfaceSocket(this.tree, 'INPUT', name, type, d);
    if (o.min !== undefined) it.min_value = o.min;
    if (o.max !== undefined) it.max_value = o.max;
    if (o.description) it.description = o.description;
    this.ins[name] = it.identifier;
    return it.identifier;
  }
  node(type: string, x: number, y: number, inputs: Record<string, SocketValue> = {}, props: Record<string, SocketValue> = {}) {
    const n = addNode(this.tree, type, [x, y], props as Record<string, never>);
    Object.assign(n.inputs, inputs);
    return n;
  }
  /** Link `from.out` (or a group input by name when `from` is a string) into `to.input`. */
  link(from: NodeData | string, out: string, to: NodeData, input: string) {
    const ctx = ctxOf(this.doc, this.tree);
    if (typeof from === 'string') connect(ctx, this.gin.id, this.ins[from], to.id, input);
    else connect(ctx, from.id, out, to.id, input);
  }
  output(from: NodeData, out: string) {
    const id = this.tree.interface!.find((i) => i.in_out === 'OUTPUT')!.identifier;
    connect(ctxOf(this.doc, this.tree), from.id, out, this.gout.id, id);
  }
  math(op: string, x: number, y: number, inputs: Record<string, SocketValue> = {}) {
    return this.node('ShaderNodeMath', x, y, inputs, { operation: op });
  }
  mix(blend: string, x: number, y: number, inputs: Record<string, SocketValue> = {}) {
    return this.node('ShaderNodeMix', x, y, { Factor_Float: 1, ...inputs }, { data_type: 'RGBA', blend_type: blend, clamp_result: false });
  }
}

export const EFFECTS: Effect[] = [
  {
    id: 'vignette',
    name: 'Vignette',
    category: 'Camera & Lens Effects',
    description: 'Darken the image towards its corners',
    build: (doc) => {
      const b = new Builder(doc);
      b.input('Strength', 'FLOAT', 0.6, { min: 0, max: 1, description: 'How dark the corners get' });
      b.input('Size', 'FLOAT', 0.85, { min: 0, max: 2, description: 'Distance from the center where the darkening ends' });
      b.input('Softness', 'FLOAT', 0.6, { min: 0, max: 1, description: 'Width of the transition, as a part of the size' });
      const co = b.node('CompositorNodeImageCoordinates', -700, -200);
      b.link('Image', '', co, 'Image');
      const centered = b.node('ShaderNodeVectorMath', -500, -200, { Vector_001: [-0.5, -0.5, 0], Vector_002: [0, 0, 0] }, { operation: 'ADD' });
      b.link(co, 'Normalized', centered, 'Vector');
      const len = b.node('ShaderNodeVectorMath', -320, -200, { Scale: 2 }, { operation: 'SCALE' });
      b.link(centered, 'Vector', len, 'Vector');
      const dist = b.node('ShaderNodeVectorMath', -150, -200, {}, { operation: 'LENGTH' });
      b.link(len, 'Vector', dist, 'Vector');
      const inner = b.math('MULTIPLY', -320, -420);
      const keep = b.math('SUBTRACT', -500, -420, { Value: 1 });
      b.link('Softness', '', keep, 'Value_001');
      b.link('Size', '', inner, 'Value');
      b.link(keep, 'Value', inner, 'Value_001');
      const dark = b.math('SUBTRACT', -320, -560, { Value: 1 });
      b.link('Strength', '', dark, 'Value_001');
      const fall = b.node('ShaderNodeMapRange', 50, -260, { 'To Min': 1 }, { interpolation_type: 'SMOOTHSTEP', clamp: true });
      b.link(dist, 'Value', fall, 'Value');
      b.link(inner, 'Value', fall, 'From Min');
      b.link('Size', '', fall, 'From Max');
      b.link(dark, 'Value', fall, 'To Max');
      const out = b.mix('MULTIPLY', 300, 0);
      b.link('Image', '', out, 'A_Color');
      b.link(fall, 'Result', out, 'B_Color');
      b.output(out, 'Result_Color');
      return b.tree;
    },
  },
  {
    id: 'film_grain',
    name: 'Film Grain',
    category: 'Camera & Lens Effects',
    description: 'Soft, animated grain like the texture of film stock',
    build: (doc) => {
      const b = new Builder(doc);
      b.input('Strength', 'FLOAT', 0.12, { min: 0, max: 1, description: 'Contrast of the grain' });
      b.input('Size', 'FLOAT', 1.6, { min: 0.5, max: 10, description: 'Grain size in pixels' });
      const co = b.node('CompositorNodeImageCoordinates', -700, -200);
      b.link('Image', '', co, 'Image');
      const px = b.node('ShaderNodeVectorMath', -500, -200, {}, { operation: 'DIVIDE' });
      b.link(co, 'Pixel', px, 'Vector');
      const sz = b.node('ShaderNodeCombineXYZ', -700, -380, { Z: 1 });
      b.link('Size', '', sz, 'X');
      b.link('Size', '', sz, 'Y');
      b.link(sz, 'Vector', px, 'Vector_001');
      const time = b.node('CompositorNodeSceneTime', -700, -520);
      const w = b.math('MULTIPLY', -500, -520, { Value_001: 3.71 });
      b.link(time, 'Frame', w, 'Value');
      const noise = b.node('ShaderNodeTexNoise', -300, -260, { Scale: 1, Detail: 1, Roughness: 0.5 }, { noise_dimensions: '4D' });
      b.link(px, 'Vector', noise, 'Vector');
      b.link(w, 'Value', noise, 'W');
      const centered = b.math('SUBTRACT', -100, -260, { Value_001: 0.5 });
      b.link(noise, 'Fac', centered, 'Value');
      const amount = b.math('MULTIPLY', 80, -260);
      b.link(centered, 'Value', amount, 'Value');
      const twice = b.math('MULTIPLY', -100, -420, { Value_001: 2 });
      b.link('Strength', '', twice, 'Value');
      b.link(twice, 'Value', amount, 'Value_001');
      const out = b.mix('ADD', 300, 0);
      b.link('Image', '', out, 'A_Color');
      b.link(amount, 'Value', out, 'B_Color');
      b.output(out, 'Result_Color');
      return b.tree;
    },
  },
  {
    id: 'sensor_noise',
    name: 'Sensor Noise',
    category: 'Camera & Lens Effects',
    description: 'Per-pixel color noise that grows with brightness, like a digital sensor',
    build: (doc) => {
      const b = new Builder(doc);
      b.input('Amount', 'FLOAT', 0.08, { min: 0, max: 1, description: 'Strength of the noise' });
      const co = b.node('CompositorNodeImageCoordinates', -700, -200);
      b.link('Image', '', co, 'Image');
      const time = b.node('CompositorNodeSceneTime', -700, -420);
      const sep = b.node('ShaderNodeSeparateXYZ', -520, -200);
      b.link(co, 'Pixel', sep, 'Vector');
      const pos = b.node('ShaderNodeCombineXYZ', -340, -260);
      b.link(sep, 'X', pos, 'X');
      b.link(sep, 'Y', pos, 'Y');
      b.link(time, 'Frame', pos, 'Z');
      const noise = b.node('ShaderNodeTexWhiteNoise', -160, -260, {}, { noise_dimensions: '3D' });
      b.link(pos, 'Vector', noise, 'Vector');
      const centered = b.mix('SUBTRACT', 20, -260, { B_Color: [0.5, 0.5, 0.5, 0] });
      b.link(noise, 'Color', centered, 'A_Color');
      const luma = b.node('CompositorNodeRGBToBW', -340, 120);
      b.link('Image', '', luma, 'Image');
      const pos0 = b.math('MAXIMUM', -160, 120, { Value_001: 0 });
      b.link(luma, 'Val', pos0, 'Value');
      const root = b.math('SQRT', 0, 120);
      b.link(pos0, 'Value', root, 'Value');
      const k = b.math('MULTIPLY', 160, 120);
      b.link(root, 'Value', k, 'Value');
      b.link('Amount', '', k, 'Value_001');
      const out = b.mix('ADD', 360, 0);
      b.link('Image', '', out, 'A_Color');
      b.link(centered, 'Result_Color', out, 'B_Color');
      b.link(k, 'Value', out, 'Factor_Float');
      b.output(out, 'Result_Color');
      return b.tree;
    },
  },
  {
    id: 'chromatic_aberration',
    name: 'Chromatic Aberration',
    category: 'Camera & Lens Effects',
    description: 'Colored fringes towards the edges, like a lens that bends colors differently',
    build: (doc) => {
      const b = new Builder(doc);
      b.input('Amount', 'FLOAT', 0.04, { min: 0, max: 1, description: 'How far the color channels drift apart' });
      const lens = b.node('CompositorNodeLensdist', 0, 0, { Fit: true });
      b.link('Image', '', lens, 'Image');
      b.link('Amount', '', lens, 'Dispersion');
      b.output(lens, 'Image');
      return b.tree;
    },
  },
  {
    id: 'sepia',
    name: 'Sepia',
    category: 'Creative',
    description: 'Warm brown monochrome, like an old photograph',
    build: (doc) => {
      const b = new Builder(doc);
      b.input('Amount', 'FLOAT', 1, { min: 0, max: 1, description: 'Blend between the original colors and the sepia tone' });
      b.input('Tone', 'RGBA', [1, 0.8, 0.58, 1], { description: 'Color of the monochrome image' });
      const bw = b.node('CompositorNodeRGBToBW', -400, -150);
      b.link('Image', '', bw, 'Image');
      const tint = b.mix('MULTIPLY', -150, -150);
      b.link(bw, 'Val', tint, 'A_Color');
      b.link('Tone', '', tint, 'B_Color');
      const out = b.mix('MIX', 200, 0);
      b.link('Image', '', out, 'A_Color');
      b.link(tint, 'Result_Color', out, 'B_Color');
      b.link('Amount', '', out, 'Factor_Float');
      b.output(out, 'Result_Color');
      return b.tree;
    },
  },
  {
    id: 'split_toning',
    name: 'Split Toning',
    category: 'Creative',
    description: 'Tint the shadows and the highlights with different colors',
    build: (doc) => {
      const b = new Builder(doc);
      b.input('Shadows', 'RGBA', [0.16, 0.36, 0.62, 1], { description: 'Tint of the dark parts' });
      b.input('Highlights', 'RGBA', [0.98, 0.68, 0.36, 1], { description: 'Tint of the bright parts' });
      b.input('Balance', 'FLOAT', 0, { min: -1, max: 1, description: 'Moves the split towards the shadows (negative) or the highlights' });
      b.input('Amount', 'FLOAT', 0.5, { min: 0, max: 1, description: 'Strength of the toning' });
      const bw = b.node('CompositorNodeRGBToBW', -500, -200);
      b.link('Image', '', bw, 'Image');
      const half = b.math('MULTIPLY', -500, -380, { Value_001: -0.5 });
      b.link('Balance', '', half, 'Value');
      const t = b.math('ADD', -320, -200);
      b.link(bw, 'Val', t, 'Value');
      b.link(half, 'Value', t, 'Value_001');
      const st = b.node('ShaderNodeMapRange', -150, -200, {}, { interpolation_type: 'SMOOTHSTEP', clamp: true });
      b.link(t, 'Value', st, 'Value');
      const tone = b.mix('MIX', 50, -200);
      b.link(st, 'Result', tone, 'Factor_Float');
      b.link('Shadows', '', tone, 'A_Color');
      b.link('Highlights', '', tone, 'B_Color');
      const out = b.mix('SOFT_LIGHT', 300, 0);
      b.link('Image', '', out, 'A_Color');
      b.link(tone, 'Result_Color', out, 'B_Color');
      b.link('Amount', '', out, 'Factor_Float');
      b.output(out, 'Result_Color');
      return b.tree;
    },
  },
  {
    id: 'unsharp_mask',
    name: 'Unsharp Mask',
    category: 'Utilities',
    description: 'Sharpen by adding back the difference to a blurred copy',
    build: (doc) => {
      const b = new Builder(doc);
      b.input('Radius', 'FLOAT', 3, { min: 0, max: 50, description: 'Blur radius in pixels: the size of the details that get sharper' });
      b.input('Amount', 'FLOAT', 0.8, { min: 0, max: 5, description: 'Strength of the sharpening' });
      const size = b.node('ShaderNodeCombineXYZ', -500, -250);
      b.link('Radius', '', size, 'X');
      b.link('Radius', '', size, 'Y');
      const blur = b.node('CompositorNodeBlur', -300, -150);
      b.link('Image', '', blur, 'Image');
      b.link(size, 'Vector', blur, 'Size');
      const detail = b.mix('SUBTRACT', -50, -150);
      b.link('Image', '', detail, 'A_Color');
      b.link(blur, 'Image', detail, 'B_Color');
      const out = b.mix('ADD', 250, 0);
      b.link('Image', '', out, 'A_Color');
      b.link(detail, 'Result_Color', out, 'B_Color');
      b.link('Amount', '', out, 'Factor_Float');
      b.output(out, 'Result_Color');
      return b.tree;
    },
  },
  {
    id: 'tune_image',
    name: 'Tune Image',
    category: 'Utilities',
    description: 'Exposure, contrast, saturation and gamma in one node',
    build: (doc) => {
      const b = new Builder(doc);
      b.input('Exposure', 'FLOAT', 0, { min: -10, max: 10, description: 'Brightness change in stops' });
      b.input('Contrast', 'FLOAT', 0, { min: -100, max: 100, description: 'Contrast change' });
      b.input('Saturation', 'FLOAT', 1, { min: 0, max: 2, description: 'Color intensity (0 is grey)' });
      b.input('Gamma', 'FLOAT', 1, { min: 0.001, max: 10, description: 'Gamma applied last' });
      const ex = b.node('CompositorNodeExposure', -500, 0);
      b.link('Image', '', ex, 'Image');
      b.link('Exposure', '', ex, 'Exposure');
      const bc = b.node('CompositorNodeBrightContrast', -280, 0);
      b.link(ex, 'Image', bc, 'Image');
      b.link('Contrast', '', bc, 'Contrast');
      const hs = b.node('CompositorNodeHueSat', -60, 0);
      b.link(bc, 'Image', hs, 'Image');
      b.link('Saturation', '', hs, 'Saturation');
      const gm = b.node('ShaderNodeGamma', 160, 0);
      b.link(hs, 'Image', gm, 'Color');
      b.link('Gamma', '', gm, 'Gamma');
      b.output(gm, 'Color');
      return b.tree;
    },
  },
];

type EffectGroup = NodeGroupData & { effect_id?: string };

/** The document's copy of an effect's node group (appended on first use). */
export function effectGroup(doc: DocumentData, fx: Effect): NodeGroupData {
  const have = Object.values(doc.node_groups).find((g) => (g as EffectGroup).effect_id === fx.id && g.tree.type === 'COMPOSITOR');
  if (have) return have;
  const g: EffectGroup = { id: uid('ng'), name: uniqueGroupName(doc, fx.name), tree: fx.build(doc), effect_id: fx.id };
  g.tree.description = fx.description;
  doc.node_groups[g.id] = g;
  return g;
}

/** A standalone copy of an effect's group (thumbnails, tests): not added to any document. */
export function effectPreviewGroup(doc: DocumentData, fx: Effect): NodeGroupData {
  return { id: `__fx_${fx.id}`, name: fx.name, tree: fx.build(doc) };
}
