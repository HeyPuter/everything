// The volume shader an object renders with: its first material's Volume output, the default
// grey smoke when it has no material, and nothing when its material only has a surface.
import type { DocumentData, ObjectData } from '../data/types';
import { materialSlots } from '../geonodes/convert';
import { defaultVolumeShader, volumeShaderOfTree, type VolumeShader } from './shader';

const cache = new WeakMap<object, { key: string; s: VolumeShader | null }>();

export function objectVolumeShader(doc: DocumentData, ob: ObjectData): VolumeShader | null {
  const id = materialSlots(doc, ob).find((m) => !!m) ?? null;
  const ma = id ? doc.materials[id] : undefined;
  if (!ma) return defaultVolumeShader();
  if (!ma.use_nodes) return { ...defaultVolumeShader(), scatter: [ma.diffuse_color[0], ma.diffuse_color[1], ma.diffuse_color[2]] };
  const key = JSON.stringify([ma.tree.nodes.map((n) => [n.type, n.inputs, n.props, n.mute]), ma.tree.links]);
  const hit = cache.get(ma.tree);
  if (hit && hit.key === key) return hit.s;
  const s = volumeShaderOfTree(ma.tree);
  cache.set(ma.tree, { key, s });
  return s;
}
