// Light node trees: a light can use a shader node tree whose Light Output receives an emission
// shader. The renderers' lights are analytic, so the tree is reduced to a colour multiplier
// (Emission color × strength, with constant inputs, RGB, Value and Blackbody nodes folded).
import type { Color as ThreeColor } from 'three';
import type { DocumentData, LightData, NodeData, NodeTreeData } from '../../data/types';
import { activeOutput } from '../tree';
import { blackbodyToRgb } from '../curves';
import { uid } from '../../data/defaults';
import { sceneSyncHooks } from '../../render/scene';
import { lightTintHooks } from '../../render/final/renderscene';
import { app } from '../../app/app';

declare module '../../data/types' {
  interface LightData {
    /** shade the light with its node tree */
    use_nodes?: boolean;
    node_tree?: NodeTreeData | null;
  }
}

/** Default light tree: Emission (white, strength 1) → Light Output. */
export function defaultLightTree(): NodeTreeData {
  const em: NodeData = { id: uid('node'), type: 'ShaderNodeEmission', name: 'Emission', location: [-200, 0], inputs: {}, props: {} };
  const out: NodeData = { id: uid('node'), type: 'ShaderNodeOutputLight', name: 'Light Output', location: [60, 0], inputs: {}, props: { is_active_output: true, target: 'ALL' } };
  return { type: 'SHADER', nodes: [em, out], links: [{ id: uid('link'), from_node: em.id, from_socket: 'Emission', to_node: out.id, to_socket: 'Surface' }] };
}

const rgb = (v: unknown, d: number[]): number[] => (Array.isArray(v) ? (v as number[]) : d);
const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);

function from(tree: NodeTreeData, n: NodeData, socket: string): NodeData | null {
  const l = tree.links.find((x) => x.to_node === n.id && x.to_socket === socket && !x.is_muted);
  const f = l ? tree.nodes.find((x) => x.id === l.from_node) : undefined;
  return f && !f.mute ? f : null;
}

/** Constant colour of an input (folding RGB, Value and Blackbody nodes). */
function colorInput(tree: NodeTreeData, n: NodeData, socket: string, d: number[]): number[] {
  const f = from(tree, n, socket);
  if (!f) return rgb(n.inputs[socket], d);
  if (f.type === 'ShaderNodeRGB') return rgb(f.props['outputs.Color'], [0.5, 0.5, 0.5, 1]);
  if (f.type === 'ShaderNodeValue') return [num(f.props['outputs.Value'], 0.5), num(f.props['outputs.Value'], 0.5), num(f.props['outputs.Value'], 0.5), 1];
  if (f.type === 'ShaderNodeBlackbody') return [...blackbodyToRgb(num(f.inputs.Temperature, 1500)), 1];
  return d;
}

function valueInput(tree: NodeTreeData, n: NodeData, socket: string, d: number): number {
  const f = from(tree, n, socket);
  if (!f) return num(n.inputs[socket], d);
  if (f.type === 'ShaderNodeValue') return num(f.props['outputs.Value'], 0.5);
  return d;
}

/** Colour multiplier of a light from its node tree ([1, 1, 1] without nodes). */
export function lightNodeTint(la: LightData): [number, number, number] {
  const tree = la.use_nodes ? la.node_tree : null;
  if (!tree) return [1, 1, 1];
  const out = activeOutput(tree, 'ShaderNodeOutputLight');
  if (!out) return [1, 1, 1];
  const sh = from(tree, out, 'Surface');
  if (!sh) return [0, 0, 0];
  const emit = (n: NodeData): number[] => {
    if (n.type === 'ShaderNodeEmission' || n.type === 'ShaderNodeBackground') {
      const c = colorInput(tree, n, 'Color', [1, 1, 1, 1]);
      const s = valueInput(tree, n, 'Strength', 1);
      return [c[0] * s, c[1] * s, c[2] * s];
    }
    if (n.type === 'ShaderNodeAddShader') {
      const a = from(tree, n, 'Shader'),
        b = from(tree, n, 'Shader_001');
      const ea = a ? emit(a) : [0, 0, 0],
        eb = b ? emit(b) : [0, 0, 0];
      return [ea[0] + eb[0], ea[1] + eb[1], ea[2] + eb[2]];
    }
    if (n.type === 'ShaderNodeMixShader') {
      const f = Math.min(1, Math.max(0, valueInput(tree, n, 'Fac', 0.5)));
      const a = from(tree, n, 'Shader'),
        b = from(tree, n, 'Shader_001');
      const ea = a ? emit(a) : [0, 0, 0],
        eb = b ? emit(b) : [0, 0, 0];
      return [ea[0] * (1 - f) + eb[0] * f, ea[1] * (1 - f) + eb[1] * f, ea[2] * (1 - f) + eb[2] * f];
    }
    return [0, 0, 0];
  };
  const e = emit(sh);
  return [e[0], e[1], e[2]];
}

const tint = (doc: DocumentData, la: LightData | undefined, c: ThreeColor) => {
  if (!la?.use_nodes) return;
  const t = lightNodeTint(la);
  c.setRGB(c.r * t[0], c.g * t[1], c.b * t[2]);
  void doc;
};

// viewport lights
sceneSyncHooks.push((doc, ev, so) => {
  if (!so.light || ev.ob.type !== 'LIGHT' || !ev.ob.data) return;
  tint(doc, doc.lights[ev.ob.data], so.light.color);
});
// final render lights
lightTintHooks.push((la, color) => tint(app?.doc, la, color));
