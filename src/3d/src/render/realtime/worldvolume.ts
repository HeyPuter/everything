// World volume (fog): a homogeneous medium from the World Output's Volume input (Volume Scatter,
// Principled Volume or Volume Absorption with constant inputs). Surfaces fade towards the light
// the medium scatters, with Beer–Lambert transmittance over their view distance, limited to
// Render ▸ Volumes ▸ Custom Range when set. Pure parts are unit tested.
import type { NodeData, WorldData } from '../../data/types';

export interface WorldVolume {
  /** scattering albedo (black for pure absorption) */
  albedo: [number, number, number];
  /** extinction per unit distance */
  density: number;
}

/** The world's volume shader, when its inputs are constants. */
export function worldVolume(w: WorldData | null | undefined): WorldVolume | null {
  if (!w?.use_nodes && w?.use_nodes !== undefined) return null;
  const tree = w?.tree;
  if (!tree) return null;
  const out = tree.nodes.find((n) => n.type === 'ShaderNodeOutputWorld' && n.props.is_active_output !== false) ?? tree.nodes.find((n) => n.type === 'ShaderNodeOutputWorld');
  const link = out && tree.links.find((l) => l.to_node === out.id && l.to_socket === 'Volume');
  const node: NodeData | undefined = link ? tree.nodes.find((n) => n.id === link.from_node) : undefined;
  if (!node) return null;
  const num = (id: string, d: number) => (typeof node.inputs[id] === 'number' ? (node.inputs[id] as number) : d);
  const col = (id: string, d: number[]) => ((Array.isArray(node.inputs[id]) ? node.inputs[id] : d) as number[]);
  if (node.type === 'ShaderNodeVolumeScatter' || node.type === 'ShaderNodeVolumePrincipled') {
    const c = col('Color', node.type === 'ShaderNodeVolumeScatter' ? [0.8, 0.8, 0.8] : [0.5, 0.5, 0.5]);
    return { albedo: [c[0], c[1], c[2]], density: Math.max(0, num('Density', 1)) };
  }
  if (node.type === 'ShaderNodeVolumeAbsorption') return { albedo: [0, 0, 0], density: Math.max(0, num('Density', 1)) };
  return null;
}

/** Transmittance through `distance` of the medium (Beer–Lambert). */
export function fogTransmittance(density: number, distance: number): number {
  return Math.exp(-Math.max(0, density) * Math.max(0, distance));
}

/** Average radiance of an equirect map (three.js convention RGBA rows), solid-angle weighted. */
export function envAverage(data: Float32Array, W: number, H: number): [number, number, number] {
  const s = [0, 0, 0];
  let wsum = 0;
  for (let j = 0; j < H; j++) {
    const w = Math.cos(((j + 0.5) / H - 0.5) * Math.PI);
    for (let i = 0; i < W; i++) {
      const k = (j * W + i) * 4;
      s[0] += data[k] * w;
      s[1] += data[k + 1] * w;
      s[2] += data[k + 2] * w;
      wsum += w;
    }
  }
  return wsum > 0 ? [s[0] / wsum, s[1] / wsum, s[2] / wsum] : [0, 0, 0];
}
