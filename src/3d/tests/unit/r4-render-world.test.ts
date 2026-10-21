// @vitest-environment happy-dom
// World operators: new world and converting the world volume to a mesh.
import { describe, expect, it } from 'vitest';
import { newWorld, uid } from '../../src/data/defaults';
import { worldVolumeLink, upstreamNodes } from '../../src/render/final/worldops';
import type { WorldData } from '../../src/data/types';

function fogWorld(): WorldData {
  const w = newWorld();
  const out = w.tree.nodes.find((n) => n.type === 'ShaderNodeOutputWorld')!;
  const scatter = { id: uid('node'), type: 'ShaderNodeVolumeScatter', name: 'Volume Scatter', location: [0, 0] as [number, number], inputs: { Density: 0.1 }, props: {} };
  const value = { id: uid('node'), type: 'ShaderNodeValue', name: 'Value', location: [0, 0] as [number, number], inputs: {}, props: {} };
  w.tree.nodes.push(scatter, value);
  w.tree.links.push({ id: uid('link'), from_node: value.id, from_socket: 'Value', to_node: scatter.id, to_socket: 'Density' });
  w.tree.links.push({ id: uid('link'), from_node: scatter.id, from_socket: 'Volume', to_node: out.id, to_socket: 'Volume' });
  return w;
}

describe('world volume', () => {
  it('finds the volume link and the nodes feeding it', () => {
    expect(worldVolumeLink(newWorld())).toBeNull();
    const w = fogWorld();
    const link = worldVolumeLink(w)!;
    expect(link.to_socket).toBe('Volume');
    const ids = upstreamNodes(w.tree, link.from_node);
    expect(ids.size).toBe(2);
    // the background chain is not part of it
    expect([...ids].some((id) => w.tree.nodes.find((n) => n.id === id)?.type === 'ShaderNodeBackground')).toBe(false);
  });
});

describe('mesh volumes', () => {
  it('detects volume-only materials and fills the mesh bounds', async () => {
    const { isVolumeOnlyMaterial, boxVolume } = await import('../../src/render/final/meshvolume');
    const { newMaterial } = await import('../../src/data/defaults');
    const { uvwToObject } = await import('../../src/volume/pack');
    const ma = newMaterial();
    expect(isVolumeOnlyMaterial(ma)).toBe(false);
    const out = ma.tree.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial')!;
    const surf = ma.tree.links.find((l) => l.to_node === out.id && l.to_socket === 'Surface')!;
    surf.to_socket = 'Volume';
    expect(isVolumeOnlyMaterial(ma)).toBe(true);
    const p = boxVolume([-1, -2, 0], [1, 2, 4]);
    const m = uvwToObject(p);
    // uvw (0,0,0) and (1,1,1) map to the box corners
    expect([m[12], m[13], m[14]]).toEqual([-1, -2, 0]);
    expect([m[0] + m[12], m[5] + m[13], m[10] + m[14]]).toEqual([1, 2, 4]);
    expect(p.data.filter((_, i) => i % 4 === 0).every((x) => x === 255)).toBe(true);
  });
});
