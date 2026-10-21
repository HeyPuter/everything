// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import { buildMesh } from '../../src/mesh/mesh';
import { UVTopo, visibleFaces } from '../../src/editors/uv/uvcore';
import { makeLayerForTest, limitToNearestIsland, relaxStep } from '../../src/editors/uv/uvsculpt';

function twoIslands() {
  const arr = buildMesh(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 3, 0, 0, 4, 0, 0, 4, 1, 0, 3, 1, 0],
    [
      { verts: [0, 1, 2, 3], uvs: [0.1, 0.1, 0.3, 0.1, 0.3, 0.3, 0.1, 0.3] },
      { verts: [4, 5, 6, 7], uvs: [0.32, 0.1, 0.5, 0.1, 0.5, 0.3, 0.32, 0.3] },
    ],
  );
  const me = newMeshData('Q', arr);
  me.select_vert = new Uint8Array(8).fill(1);
  return new UVTopo({ me, faces: visibleFaces(me, false), sync: false });
}

describe('UV sculpt islands', () => {
  it('brushes only the island nearest to the stroke start', () => {
    const t = twoIslands();
    const l = makeLayerForTest(t);
    limitToNearestIsland([l], 0.12, 0.12);
    const movable = Array.from(l.movable);
    // the first quad's four UV vertices stay movable, the second's do not
    expect(movable.filter(Boolean).length).toBe(4);
    const before = Array.from(l.uvs);
    relaxStep(l, 0.31, 0.2, 0.5, 1);
    const after = Array.from(l.uvs);
    // second island (corners 4..7) untouched
    for (let c = 4; c < 8; c++) {
      expect(after[c * 2]).toBe(before[c * 2]);
      expect(after[c * 2 + 1]).toBe(before[c * 2 + 1]);
    }
  });
});
