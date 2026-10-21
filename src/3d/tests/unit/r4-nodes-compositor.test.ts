// Compositor additions: the Viewer Region mask and the legacy Cryptomatte node's pass inputs.
import { describe, it, expect } from 'vitest';
import { viewerRegion, setViewerRegion, regionPixels, maskToRegion } from '../../src/compositor/viewregion';
import type { NodeTreeData } from '../../src/data/types';

describe('viewer region', () => {
  it('stores a clamped, ordered region and clears it', () => {
    const tree = { type: 'COMPOSITOR', nodes: [], links: [], interface: [] } as unknown as NodeTreeData;
    expect(viewerRegion(tree)).toBeNull();
    setViewerRegion(tree, [0.8, 1.2, 0.2, 0.5]);
    expect(viewerRegion(tree)).toEqual([0.2, 0.5, 0.8, 1]);
    setViewerRegion(tree, null);
    expect(viewerRegion(tree)).toBeNull();
  });

  it('masks pixels outside the region (rows from the top, region y up)', () => {
    const w = 4,
      h = 4;
    const img = { data: new Float32Array(w * h * 4).fill(1), width: w, height: h, display: null };
    // left half, upper half of the image
    const r: [number, number, number, number] = [0, 0.5, 0.5, 1];
    expect(regionPixels(r, w, h)).toEqual([0, 0, 2, 2]);
    maskToRegion(img, r);
    const at = (x: number, y: number) => img.data[(y * w + x) * 4];
    expect(at(0, 0)).toBe(1);
    expect(at(1, 1)).toBe(1);
    expect(at(2, 0)).toBe(0);
    expect(at(0, 2)).toBe(0);
    expect(at(3, 3)).toBe(0);
  });
});
