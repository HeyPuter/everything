import { describe, expect, it } from 'vitest';
import { appendPoints, duplicatePoints, newPointCloud, pointCount, radii, randomPoints, selection, setAttr, setSelection, subsetPoints, removeAttr, getAttr } from '../../src/pointcloud/data';
import { applySelectAction, randomSelection } from '../../src/pointcloud/data';
import { pointCloudEvalMesh } from '../../src/pointcloud/eval';
import { evalMeshToGeometry } from '../../src/geonodes/convert';
import { mergedSpheres } from '../../src/pointcloud/spheres';

function cloud() {
  const pc = newPointCloud();
  pc.positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
  setAttr(pc, 'radius', 'FLOAT', new Float32Array([0.1, 0.2, 0.3]));
  setAttr(pc, 'temp', 'INT', new Int32Array([5, 6, 7]));
  return pc;
}

describe('point clouds', () => {
  it('scatters deterministic random points in the unit cube', () => {
    const a = randomPoints(400, 1, 0.05, 1),
      b = randomPoints(400, 1, 0.05, 1);
    expect(a.positions).toEqual(b.positions);
    expect(a.positions.length).toBe(1200);
    expect(Math.max(...a.positions.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(Math.max(...a.radius)).toBeLessThanOrEqual(0.05);
  });

  it('keeps attributes in step with subsets, copies and appends', () => {
    const pc = cloud();
    const s = subsetPoints(pc, [1, 0, 1]);
    expect(Array.from(s.positions)).toEqual([0, 0, 0, 2, 0, 0]);
    expect(Array.from(getAttr(s, 'temp')!.data)).toEqual([5, 7]);
    const d = duplicatePoints(pc, [2]);
    expect(pointCount(d)).toBe(4);
    expect(Array.from(radii(d))).toEqual([0.1, 0.2, 0.3, 0.3].map((x) => Math.fround(x)));
    const ap = appendPoints(pc, [9, 9, 9], 0.5);
    expect(pointCount(ap)).toBe(4);
    expect(radii(ap)[3]).toBe(0.5);
    expect(getAttr(ap, 'temp')!.data[3]).toBe(0);
    expect(removeAttr(pc, 'temp')).toBe(true);
  });

  it('selects all, none, inverted and random points', () => {
    const pc = cloud();
    expect(Array.from(selection(pc))).toEqual([1, 1, 1]);
    setSelection(pc, new Uint8Array([1, 0, 0]));
    expect(Array.from(applySelectAction(selection(pc), 'INVERT'))).toEqual([0, 1, 1]);
    expect(Array.from(applySelectAction(selection(pc), 'TOGGLE'))).toEqual([0, 0, 0]);
    const r = randomSelection(new Uint8Array(1000), 0.3, 4, true);
    const n = r.reduce((a, b) => a + b, 0);
    expect(n).toBeGreaterThan(220);
    expect(n).toBeLessThan(380);
  });

  it('evaluates to points with radii and attributes for geometry nodes', () => {
    const pc = cloud();
    setSelection(pc, new Uint8Array([1, 0, 1]));
    const m = pointCloudEvalMesh(pc);
    expect(Array.from(m.pointRadius!)).toEqual([0.1, 0.2, 0.3].map((x) => Math.fround(x)));
    const g = evalMeshToGeometry(m);
    expect(g.points?.count).toBe(3);
    expect(g.points?.attrs.get('temp')?.type).toBe('INT');
    expect(g.points?.attrs.has('.selection')).toBe(false);
  });

  it('builds one sphere mesh around all points', () => {
    const g = mergedSpheres(new Float32Array([0, 0, 0, 5, 0, 0]), [1, 2]);
    g.computeBoundingBox();
    expect(g.boundingBox!.min.x).toBeCloseTo(-1);
    expect(g.boundingBox!.max.x).toBeCloseTo(7);
  });
});
