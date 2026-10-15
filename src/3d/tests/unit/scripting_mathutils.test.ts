// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { bpy } from '../../src/scripting/api';
import { Vector, Matrix, Euler, Quaternion, Color, mathutils } from '../../src/scripting/mathutils';
import { runJavaScript, output } from '../../src/scripting/runner';
import { pythonAvailable, runPy } from './support/python';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const { geometry: G, kdtree, bvhtree, noise } = mathutils;
const { KDTree } = kdtree;
const { BVHTree } = bvhtree;

const r4 = (v: Iterable<number> | number) => (typeof v === 'number' ? +v.toFixed(4) : [...v].map((x) => +x.toFixed(4) + 0));
const V = (...a: number[]) => new Vector(a);

beforeEach(() => {
  setApp(new App(startupDocument()));
  output.clear();
});

describe('Vector', () => {
  it('angles, interpolation and conversions', () => {
    expect(r4(V(1, 0).angle_signed([0, 1]) as number)).toBe(-1.5708);
    expect(r4(V(0, 1).angle_signed([1, 0]) as number)).toBe(1.5708);
    expect(r4(V(2, 0, 0).slerp([0, 4, 0], 0.25) as Vector)).toEqual([0.9239, 0.3827, 0]);
    expect(V(1, 0, 0).slerp([-1, 0, 0], 0.5, 7)).toBe(7);
    expect(r4(V(1, 2, 3).project([0, 0, 2]))).toEqual([0, 0, 3]);
    expect(r4(V(1, 2, 3).orthogonal())).toEqual([3, 3, -3]);
    expect(r4(V(3, 1, 0).orthogonal())).toEqual([-1, 3, 3]);
    expect(r4(V(1, 2).orthogonal())).toEqual([-2, 1]);
    expect(V(1, 2, 3).to_4d().toArray()).toEqual([1, 2, 3, 1]);
    expect(V(1, 2).to_3d().toArray()).toEqual([1, 2, 0]);
    const v = V(1, 2);
    v.resize_3d();
    expect(v.toArray()).toEqual([1, 2, 0]);
    expect(Vector.Linspace(0, 1, 5).toArray()).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(Vector.Range(1, 7, 2).toArray()).toEqual([1, 3, 5]);
    expect(Vector.Fill(3, 2.5).toArray()).toEqual([2.5, 2.5, 2.5]);
  });

  it('swizzles, products and in-place rotation', () => {
    const v = V(1, 2, 3) as Any;
    expect(v.zyx.toArray()).toEqual([3, 2, 1]);
    expect(v.xxyy.toArray()).toEqual([1, 1, 2, 2]);
    v.zx = [9, 8];
    expect(v.toArray()).toEqual([8, 2, 9]);
    expect((V(1, 2, 3).matmul(new Matrix([[1, 2, 3], [4, 5, 6], [7, 8, 9]])) as Vector).toArray()).toEqual([30, 36, 42]);
    expect(V(1, 2, 3).matmul([1, 1, 1])).toBe(6);
    const w = V(1, 0, 0);
    w.rotate(new Quaternion([0, 0, 1], Math.PI / 2));
    expect(r4(w)).toEqual([0, 1, 0]);
    expect(() => V(1, 2, 3).add([1, 2])).toThrow(/ValueError/);
  });

  it('rotation_difference and to_track_quat', () => {
    expect(r4(V(1, 0, 0).rotation_difference([0, 1, 0]))).toEqual([0.7071, 0, 0, 0.7071]);
    expect(r4(V(1, 0, 0).rotation_difference([-1, 0, 0]))).toEqual([0, 0, 0.7071, 0.7071]);
    expect(r4(V(1, 2, 3).to_track_quat('Z', 'Y'))).toEqual([0.2181, 0.0723, 0.3064, 0.9238]);
    expect(r4(V(1, 2, 3).to_track_quat('Y', 'Z'))).toEqual([0.8699, 0.4365, -0.1031, -0.2053]);
    expect(r4(V(1, 2, 3).to_track_quat('-X', 'Z'))).toEqual([0.4699, 0.3816, 0.2358, -0.7603]);
    expect(r4(V(1, 2, 3).to_track_quat('X', 'Y'))).toEqual([0.3709, 0.7043, 0.0625, 0.6021]);
    // looking straight down / up along the track axis
    expect(r4(V(0, 0, -5).to_track_quat('-Z', 'Y'))).toEqual([1, 0, 0, 0]);
    expect(r4(V(0, 0, 5).to_track_quat('Z', 'Y'))).toEqual([0, 0, 0, 1]);
    expect(r4(V(0, 0, 5).to_track_quat('Y', 'Z'))).toEqual([0.7071, 0.7071, 0, 0]);
    const m = V(0, 0, 5).to_track_quat('X', 'Y').to_matrix();
    expect(r4(m.col(0))).toEqual([0, 0, 1]);
    expect(r4(m.col(1))).toEqual([-1, 0, 0]);
  });
});

describe('Color, Euler, Quaternion', () => {
  it('color HSV and color space conversions', () => {
    const c = new Color([0.2, 0.4, 0.6]);
    expect(r4(c.hsv)).toEqual([0.5833, 0.6667, 0.6]);
    expect([r4(c.h), r4(c.s), r4(c.v)]).toEqual([0.5833, 0.6667, 0.6]);
    c.hsv = [0.9, 0.5, 0.5];
    expect(r4(c)).toEqual([0.5, 0.25, 0.4]);
    const d = new Color([0.2, 0.4, 0.6]);
    expect(r4(d.from_scene_linear_to_srgb())).toEqual([0.4845, 0.6652, 0.7977]);
    expect(r4(d.from_srgb_to_scene_linear())).toEqual([0.0331, 0.1329, 0.3185]);
    expect(r4(d.from_scene_linear_to_xyz_d65())).toEqual([0.3338, 0.3719, 0.6219]);
    expect(r4(d.from_xyz_d65_to_scene_linear())).toEqual([-0.2659, 0.5815, 0.5637]);
    d.from_aces_to_scene_linear().toArray().forEach((x, i) => expect(x).toBeCloseTo([-0.18185, 0.43605, 0.63675][i], 3));
    expect(r4(d.from_scene_linear_to_srgb().from_srgb_to_scene_linear())).toEqual([0.2, 0.4, 0.6]);
    expect(d.add([0.1, 0.1, 0.1])).toBeInstanceOf(Color);
  });

  it('euler rotate, rotate_axis and make_compatible', () => {
    const e = new Euler([0.1, 0.2, 0.3]);
    e.rotate(new Euler([0.3, 0.2, 0.1]));
    expect(r4(e)).toEqual([0.4578, 0.2923, 0.4578]);
    const f = new Euler([0.1, 0.2, 0.3], 'ZXY');
    f.rotate_axis('X', 0.5);
    expect(r4(f)).toEqual([0.5744, 0.3696, 0.3578]);
    const g = new Euler([6, -4, 0.2]);
    g.make_compatible([0, 0, 0]);
    expect(r4(g)).toEqual([-0.2832, 2.2832, 0.2]);
    expect(() => new Euler([0, 0, 0], 'XXY' as Any)).toThrow(/ValueError/);
  });

  it('quaternion operations', () => {
    const q = new Quaternion([1, 2, 3, 4]).normalized(),
      r = new Quaternion([0.5, -0.2, 0.3, 0.1]).normalized();
    expect(r4(q.rotation_difference(r))).toEqual([0.4093, -0.0877, -0.0585, -0.9063]);
    expect(r4(q.to_exponential_map())).toEqual([1.0304, 1.5456, 2.0608]);
    expect(r4(new Quaternion([0.1, 0.2, 0.3]))).toEqual([0.9826, 0.0497, 0.0994, 0.1491]);
    expect(r4(new Quaternion([1, 2, 3]))).toEqual([0.2956, -0.2553, -0.5106, -0.766]);
    const [swing, twist] = q.to_swing_twist('Z');
    expect(r4(swing)).toEqual([0.7528, -0.4428, 0.4871, 0]);
    expect(r4(twist)).toBe(2.6516);
    expect(r4(q.cross(r))).toEqual([-0.1169, -0.0292, 0.2339, 0.9648]);
    expect(r4(q.dot(r))).toBe(0.4093);
    expect(r4(q.mul(r))).toEqual([0.1462, -0.1169, 0.2631, 0.1169]);
    expect(r4(q.slerp(r, 0.3))).toEqual([0.4407, 0.1697, 0.6104, 0.6359]);
    expect(r4(new Quaternion().axis)).toEqual([0, 1, 0]);
    const a = new Quaternion();
    a.angle = 1;
    expect(r4(a)).toEqual([0.8776, 0, 0.4794, 0]);
    const b = new Quaternion([0.9, 0.1, 0.2, 0.3]);
    b.axis = [0, 0, 1];
    expect(r4(b)).toEqual([0.9, 0, 0, 0.3742]);
    const c = new Quaternion([0.9, 0.1, 0.2, 0.3]);
    c.make_compatible([-1, 0, 0, 0]);
    expect(r4(c)).toEqual([-0.9, -0.1, -0.2, -0.3]);
    const d = new Quaternion([1, 2, 3, 4]);
    d.conjugate();
    expect(d.toArray()).toEqual([1, -2, -3, -4]);
    d.identity();
    expect(d.toArray()).toEqual([1, 0, 0, 0]);
  });
});

describe('Matrix', () => {
  it('constructors', () => {
    expect(Matrix.Shear('XY', 4, [0.5, 0.2]).rows[0][2]).toBe(0.5);
    expect(Matrix.Shear('XY', 4, [0.5, 0.2]).rows[1][2]).toBe(0.2);
    expect(Matrix.Shear('XZ', 3, [0.5, 0.2]).rows).toEqual([[1, 0.5, 0], [0, 1, 0], [0, 0.2, 1]]);
    expect(Matrix.Shear('YZ', 3, [0.5, 0.2]).rows).toEqual([[1, 0, 0], [0.5, 1, 0], [0.2, 0, 1]]);
    expect(Matrix.Shear('X', 2, 0.5).rows).toEqual([[1, 0.5], [0, 1]]);
    expect(Matrix.OrthoProjection('XY', 3).rows).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 0]]);
    expect(Matrix.OrthoProjection('X', 2).rows).toEqual([[1, 0], [0, 0]]);
    expect(Matrix.OrthoProjection([1, 1, 0], 3).rows.map((r) => r4(r))).toEqual([[0.5, -0.5, 0], [-0.5, 0.5, 0], [0, 0, 1]]);
    expect(Matrix.Scale(2, 3, [1, 1, 0]).rows.map((r) => r4(r))).toEqual([[1.5, 0.5, 0], [0.5, 1.5, 0], [0, 0, 1]]);
    expect(Matrix.Rotation(0.5, 4, [1, 1, 0]).rows.map((r) => r4(r))).toEqual([[0.9388, 0.0612, 0.339, 0], [0.0612, 0.9388, -0.339, 0], [-0.339, 0.339, 0.8776, 0], [0, 0, 0, 1]]);
  });

  it('properties and decompositions', () => {
    const m = Matrix.LocRotScale([1, 2, 3], new Euler([0.1, 0.2, 0.3]), [1, 2, 3]);
    expect(m.adjugated().rows.map((r) => r4(r))).toEqual([
      [5.6178, 1.7378, -1.192, -5.5173],
      [-0.8253, 2.8693, 0.2935, -5.7939],
      [0.4367, -0.0739, 1.9503, -6.1399],
      [0, 0, 0, 6],
    ]);
    expect(r4(m.median_scale)).toBe(2.1602);
    expect(r4(new Matrix([[1, 1, 0], [0, 1, 0], [0, 0, 1]]).median_scale)).toBe(1.4142);
    expect(m.is_negative).toBe(false);
    expect(m.is_orthogonal).toBe(false);
    expect(Matrix.Rotation(0.3, 3, 'X').is_orthogonal).toBe(true);
    const rs = Matrix.Rotation(Math.PI / 6, 3, 'Z').matmul(Matrix.Diagonal([1, 2, 1])) as Matrix;
    expect(rs.is_orthogonal_axis_vectors).toBe(true);
    expect(rs.transposed().is_orthogonal_axis_vectors).toBe(false);
    expect(Matrix.Scale(-1, 3).is_negative).toBe(true);
    const [loc, rot, sca] = m.decompose();
    expect(loc.toArray()).toEqual([1, 2, 3]);
    expect(r4(rot)).toEqual([0.9833, 0.0343, 0.106, 0.1436]);
    expect(r4(sca)).toEqual([1, 2, 3]);
    expect(m.normalized().rows.map((r) => r4(r))[0]).toEqual([0.9363, -0.2751, 0.2184, 1]);
    expect(new Matrix([[1, 0, 0], [0, 0, 0], [0, 0, 1]]).inverted_safe().rows[1][1]).toBeCloseTo(1e8, -2);
    expect(Matrix.Identity(3).lerp(Matrix.Scale(3, 3), 0.5).rows[1][1]).toBe(2);
    expect(r4(Matrix.Rotation(3.0, 3, 'X').to_quaternion())).toEqual([0.0707, 0.9975, 0, 0]);
    expect(Matrix.Identity(2).mul(new Matrix([[1, 2], [3, 4]])).rows).toEqual([[1, 0], [0, 4]]);
    expect(Matrix.Identity(2).to_4x4().is_identity).toBe(true);
    expect(m.to_3x3().size).toBe(3);
    expect(m.to_2x2().rows).toEqual([m.rows[0].slice(0, 2), m.rows[1].slice(0, 2)]);
  });

  it('4x4 times a 3D vector uses w = 1 without a perspective divide', () => {
    expect((new Matrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 1, 0]]).matmul([1, 2, 3]) as Vector).toArray()).toEqual([1, 2, 3]);
    expect((new Matrix([[2, 0, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 2]]).matmul([1, 2, 3]) as Vector).toArray()).toEqual([3, 2, 3]);
  });

  it('rows are live views and element access works', () => {
    const m = Matrix.Identity(4) as Any;
    m[0][3] = 5;
    expect(m.rows[0][3]).toBe(5);
    expect(m.translation.toArray()).toEqual([5, 0, 0]);
    m.row(1).y = 7;
    expect(m.rows[1][1]).toBe(7);
    expect(m.col(3).toArray()).toEqual([5, 0, 0, 1]);
    expect([...m].length).toBe(4);
    m.zero();
    expect(m.rows.flat().every((x: number) => x === 0)).toBe(true);
  });

  it('is available to JavaScript scripts', () => {
    const r = runJavaScript(`
      const m = Matrix.Translation([1, 2, 3]).matmul(Matrix.Rotation(Math.PI / 2, 4, 'Z'));
      const v = m.matmul(new Vector([1, 0, 0]));
      const t = new mathutils.kdtree.KDTree(2); t.insert([0, 0, 0], 4); t.insert([5, 0, 0], 9); t.balance();
      print(v.toArray().map((x) => x.toFixed(3)).join(','), t.find([4, 0, 0])[1], geometry.area_tri([0, 0], [2, 0], [0, 2]));
    `);
    expect(r.ok).toBe(true);
    expect(output.lines.map((l) => l.text).join('\n')).toBe('1.000,3.000,3.000 9 2');
  });
});

describe('mathutils.geometry', () => {
  it('ray / line / plane intersections', () => {
    const tri = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    const [a, b, c] = tri;
    expect(r4(G.intersect_ray_tri(a, b, c, [0, 0, -1], [0.2, 0.2, 1])!)).toEqual([0.2, 0.2, 0]);
    expect(G.intersect_ray_tri(a, b, c, [0, 0, 1], [0.2, 0.2, 1])).toBeNull();
    expect(G.intersect_ray_tri(a, b, c, [0, 0, -1], [2, 2, 1])).toBeNull();
    expect(r4(G.intersect_ray_tri(a, b, c, [0, 0, -1], [2, 2, 1], false)!)).toEqual([2, 2, 0]);
    expect(r4(G.intersect_ray_tri(a, c, b, [0, 0, -1], [0.2, 0.2, 1])!)).toEqual([0.2, 0.2, 0]);
    const ll = G.intersect_line_line([0, 0, 0], [1, 0, 0], [0.5, 1, 1], [0.5, 2, 1])!;
    expect(ll.map((v) => r4(v))).toEqual([[0.5, 0, 0], [0.5, 0, 1]]);
    expect(G.intersect_line_line([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0])).toBeNull();
    expect(G.intersect_line_line([0, 0], [1, 0], [0.5, 1], [0.5, 2])!.map((v) => r4(v))).toEqual([[0.5, 0], [0.5, 0]]);
    expect(r4(G.intersect_line_line_2d([0, 0], [2, 2], [0, 2], [2, 0])!)).toEqual([1, 1]);
    expect(G.intersect_line_line_2d([0, 0], [1, 1], [0, 2], [0.5, 1.5])).toBeNull();
    expect(r4(G.intersect_line_plane([0, 0, 1], [0, 0, 2], [0, 0, 0], [0, 0, 1])!)).toEqual([0, 0, 0]);
    expect(G.intersect_line_plane([0, 0, 1], [1, 0, 1], [0, 0, 0], [0, 0, 1])).toBeNull();
    const pp = G.intersect_plane_plane([0, 0, 1], [0, 0, 2], [1, 0, 0], [2, 1, 0]);
    expect(pp.map((v) => r4(v!))).toEqual([[0.8, 0.4, 1], [-0.4472, 0.8944, 0]]);
    expect(r4(G.intersect_plane_plane([5, 5, 1], [0, 0, 1], [1, 7, 3], [1, 0, 0])[0]!)).toEqual([1, 0, 1]);
    expect(G.intersect_plane_plane([0, 0, 1], [0, 0, 1], [0, 0, 2], [0, 0, 1])).toEqual([null, null]);
  });

  it('spheres, points and triangles', () => {
    const ls = (r: (Vector | null)[]) => r.map((v) => (v ? r4(v) : null));
    expect(ls(G.intersect_line_sphere([-2, 0, 0], [2, 0, 0], [0, 0, 0], 1))).toEqual([[1, 0, 0], [-1, 0, 0]]);
    expect(ls(G.intersect_line_sphere([-2, 0, 0], [-1.5, 0, 0], [0, 0, 0], 1))).toEqual([null, null]);
    expect(ls(G.intersect_line_sphere([-2, 0, 0], [-1.5, 0, 0], [0, 0, 0], 1, false))).toEqual([[1, 0, 0], [-1, 0, 0]]);
    expect(ls(G.intersect_line_sphere([-2, 0, 0], [0, 0, 0], [0, 0, 0], 1))).toEqual([null, [-1, 0, 0]]);
    expect(ls(G.intersect_line_sphere_2d([-2, 0.5], [0, 0.5], [0, 0], 1))).toEqual([null, [-0.866, 0.5]]);
    expect(ls(G.intersect_sphere_sphere_2d([0, 0], 1, [1, 0], 1))).toEqual([[0.5, -0.866], [0.5, 0.866]]);
    expect(G.intersect_sphere_sphere_2d([0, 0], 2, [0.5, 0], 1)).toEqual([null, null]);
    const [pl, t] = G.intersect_point_line([3, 1, 0], [0, 0, 0], [2, 0, 0]);
    expect([r4(pl), t]).toEqual([[3, 0, 0], 1.5]);
    expect(r4(G.intersect_point_tri([0.2, 0.2, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0])!)).toEqual([0.2, 0.2, 0]);
    expect(G.intersect_point_tri([2, 2, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeNull();
    expect(G.intersect_point_tri_2d([0.2, 0.2], [0, 0], [1, 0], [0, 1])).toBe(1);
    expect(G.intersect_point_tri_2d([0.2, 0.2], [0, 0], [0, 1], [1, 0])).toBe(-1);
    expect(G.intersect_point_tri_2d([2, 2], [0, 0], [1, 0], [0, 1])).toBe(0);
    expect(G.intersect_point_tri_2d([0.5, 0], [0, 0], [1, 0], [0, 1])).toBe(1);
    expect(G.intersect_point_quad_2d([0.5, 0.5], [0, 0], [1, 0], [1, 1], [0, 1])).toBe(1);
    expect(G.intersect_point_quad_2d([0.5, 0.5], [0, 0], [0, 1], [1, 1], [1, 0])).toBe(-1);
    expect(G.intersect_point_quad_2d([1.5, 0.5], [0, 0], [1, 0], [1, 1], [0, 1])).toBe(0);
    expect(G.intersect_tri_tri_2d([0, 0], [1, 0], [0, 1], [0.2, 0.2], [2, 0.2], [0.2, 2])).toBe(true);
    expect(G.intersect_tri_tri_2d([0, 0], [1, 0], [0, 1], [2, 2], [3, 2], [2, 3])).toBe(false);
    expect(G.intersect_tri_tri_2d([0, 0], [1, 0], [0, 1], [1, 0], [2, 0], [1, 1])).toBe(true);
    expect(r4(G.closest_point_on_tri([2, 2, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0]))).toEqual([0.5, 0.5, 0]);
    expect(r4(G.closest_point_on_tri([-1, -1, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0]))).toEqual([0, 0, 0]);
    expect(G.distance_point_to_plane([0, 0, 3], [0, 0, 1], [0, 0, 2])).toBe(2);
    expect(G.area_tri([0, 0, 0], [2, 0, 0], [0, 2, 0])).toBe(2);
    expect(G.area_tri([0, 0], [0, 2], [2, 0])).toBe(2);
    expect(G.volume_tri([1, 0, 0], [0, 1, 0], [0, 0, 1])).toBeCloseTo(1 / 6);
    expect(r4(G.normal([0, 0, 0], [1, 0, 0], [0, 1, 0]))).toEqual([0, 0, 1]);
    expect(r4(G.normal([[0, 0, 0], [1, 0, 0], [1, 1, 0.2], [0, 1, 0]]))).toEqual([-0.099, -0.099, 0.9901]);
    expect(r4(G.normal([0, 0, 0], [1, 0, 0], [2, 0, 0]))).toEqual([0, 0, 0]);
    expect(r4(G.barycentric_transform([0.25, 0.25, 0.5], [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0], [2, 0, 0], [0, 2, 0]))).toEqual([0.5, 0.5, 1]);
    expect(r4(G.barycentric_transform([0.25, 0.25, 0.5], [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0], [0, 2, 0], [0, 0, 2]))).toEqual([1, 0.5, 0.5]);
    expect(G.interpolate_bezier([0, 0, 0], [1, 0, 0], [2, 1, 0], [3, 1, 0], 4).map((v) => r4(v))).toEqual([[0, 0, 0], [1, 0.2593, 0], [2, 0.7407, 0], [3, 1, 0]]);
  });

  it('tessellate_polygon fills polygons with holes', () => {
    const area = (pts: number[][], tris: number[][]) => tris.reduce((s, [a, b, c]) => s + G.area_tri(pts[a], pts[b], pts[c]), 0);
    const sq = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const t1 = G.tessellate_polygon([sq]);
    expect(t1.length).toBe(2);
    expect(area(sq, t1)).toBeCloseTo(1);
    const outer = [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0]],
      hole = [[1, 1, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0]];
    const t2 = G.tessellate_polygon([outer, hole]);
    expect(t2.length).toBe(8);
    expect(area([...outer, ...hole], t2)).toBeCloseTo(15);
    // winding follows the input: counter-clockwise loops give upward-facing triangles
    for (const [a, b, c] of t2) expect((G.normal([...outer, ...hole][a], [...outer, ...hole][b], [...outer, ...hole][c]) as Vector).z).toBeCloseTo(1);
    const concave = [[0, 0], [2, 0], [2, 2], [1, 1], [0, 2]];
    const t3 = G.tessellate_polygon([concave]);
    expect(t3.length).toBe(3);
    expect(area(concave, t3)).toBeCloseTo(3);
  });

  it('2D hulls, box fitting and packing, plane volumes', () => {
    expect(G.convex_hull_2d([[0, 0], [1, 0], [0.5, 0.5], [1, 1], [0, 1], [0.5, 2]])).toEqual([0, 1, 3, 5, 4]);
    const a = G.box_fit_2d([[0, 0], [1, 1], [2, 2], [1.5, 2.5], [0.5, -0.5]]);
    expect(r4(a)).toBe(0.5404);
    const boxes = [[0, 0, 1, 1], [0, 0, 2, 1], [0, 0, 1, 3], [0, 0, 0.5, 0.5]];
    const [w, h] = G.box_pack_2d(boxes);
    expect(w * h).toBeLessThanOrEqual(9 + 1e-9);
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i][0] + boxes[i][2]).toBeLessThanOrEqual(w + 1e-9);
      expect(boxes[i][1] + boxes[i][3]).toBeLessThanOrEqual(h + 1e-9);
      for (let j = 0; j < i; j++) {
        const [ax, ay, aw, ah] = boxes[i],
          [bx, by, bw, bh] = boxes[j];
        expect(ax + aw <= bx + 1e-9 || bx + bw <= ax + 1e-9 || ay + ah <= by + 1e-9 || by + bh <= ay + 1e-9).toBe(true);
      }
    }
    const planes = [[1, 0, 0, -1], [-1, 0, 0, -1], [0, 1, 0, -1], [0, -1, 0, -1], [0, 0, 1, -1], [0, 0, -1, -1]];
    const [verts, used] = G.points_in_planes(planes);
    expect(verts.map((v) => r4(v))).toEqual([[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]]);
    expect(used).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('mathutils.kdtree', () => {
  function tree() {
    const kd = new KDTree(5);
    [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 3, 0], [5, 5, 5]].forEach((c, i) => kd.insert(c, i * 10));
    kd.balance();
    return kd;
  }
  it('find, find_n and find_range', () => {
    const kd = tree();
    const [co, idx, dist] = kd.find([0.9, 0.2, 0]);
    expect([r4(co!), idx, r4(dist!)]).toEqual([[1, 0, 0], 10, 0.2236]);
    expect(kd.find([0.9, 0.2, 0], (i: number) => i !== 10)[1]).toBe(0);
    expect(kd.find_n([0.4, 0, 0], 3).map((h) => [h[1], r4(h[2])])).toEqual([[0, 0.4], [10, 0.6], [20, 1.6]]);
    expect(kd.find_range([0, 0, 0], 2).map((h) => [h[1], h[2]])).toEqual([[0, 0], [10, 1], [20, 2]]);
    const empty = new KDTree(0);
    empty.balance();
    expect(empty.find([0, 0, 0])).toEqual([null, null, null]);
    expect(empty.find_n([0, 0, 0], 2)).toEqual([]);
    const full = new KDTree(1);
    full.insert([0, 0, 0], 0);
    expect(() => full.insert([1, 1, 1], 1)).toThrow(/RuntimeError: Trying to insert more items/);
    expect(() => full.find([0, 0, 0])).toThrow(/must be balanced/);
  });

  it('agrees with brute force on random points', () => {
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 10 - 5;
    const pts = Array.from({ length: 3000 }, () => [rnd(), rnd(), rnd()]);
    const kd = new KDTree(pts.length);
    pts.forEach((p, i) => kd.insert(p, i));
    kd.balance();
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (let q = 0; q < 50; q++) {
      const p = [rnd(), rnd(), rnd()];
      const brute = pts.map((x, i) => [d(x, p), i]).sort((a, b) => a[0] - b[0]);
      expect(kd.find(p)[1]).toBe(brute[0][1]);
      expect(kd.find_n(p, 7).map((h) => h[1])).toEqual(brute.slice(0, 7).map((b) => b[1]));
      expect(kd.find_range(p, 1.2).map((h) => h[1])).toEqual(brute.filter((b) => b[0] <= 1.2).map((b) => b[1]));
    }
  });
});

describe('mathutils.bvhtree', () => {
  const verts = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0], [2, 1, 0.5]];
  const polys = [[0, 1, 2, 3], [1, 4, 5, 2]];

  it('ray_cast, find_nearest, find_nearest_range and overlap', () => {
    const t = BVHTree.FromPolygons(verts, polys);
    const hit = (h: (Vector | number | null)[]) => h.map((x) => (x instanceof Vector ? r4(x) : x === null ? null : r4(x)));
    expect(hit(t.ray_cast([0.5, 0.5, 1], [0, 0, -1]))).toEqual([[0.5, 0.5, 0], [0, 0, 1], 0, 1]);
    expect(hit(t.ray_cast([0.5, 0.5, 1], [0, 0, -2]))).toEqual([[0.5, 0.5, 0], [0, 0, 1], 0, 1]);
    expect(t.ray_cast([0.5, 0.5, 1], [0, 0, -1], 0.5)).toEqual([null, null, null, null]);
    expect(hit(t.ray_cast([0.5, 0.5, -1], [0, 0, 1]))).toEqual([[0.5, 0.5, 0], [0, 0, 1], 0, 1]);
    expect(hit(t.ray_cast([1.5, 0.5, 2], [0, 0, -1]))).toEqual([[1.5, 0.5, 0], [-0.2357, -0.2357, 0.9428], 1, 2]);
    expect(t.ray_cast([5, 5, 1], [0, 0, -1])).toEqual([null, null, null, null]);
    expect(hit(t.find_nearest([0.5, 0.5, 1]))).toEqual([[0.5, 0.5, 0], [0, 0, 1], 0, 1]);
    expect(t.find_nearest([0.5, 0.5, 1], 0.5)).toEqual([null, null, null, null]);
    expect(hit(t.find_nearest([-1, -1, 0]))).toEqual([[0, 0, 0], [0, 0, 1], 0, 1.4142]);
    const range = t.find_nearest_range([1, 0.5, 0.2], 1);
    expect(range.length).toBe(4);
    expect(range.map((h) => h[2]).sort()).toEqual([0, 0, 1, 1]);
    expect(r4(range[0][3])).toBe(0.2);
    const t2 = BVHTree.FromPolygons([[0.5, 0.5, -1], [0.5, 0.5, 1], [0.6, 0.7, 0]], [[0, 1, 2]]);
    expect(t.overlap(t2)).toEqual([[0, 0]]);
    expect(t2.overlap(t)).toEqual([[0, 0]]);
    const t3 = BVHTree.FromPolygons(verts, [[0, 1, 2], [0, 2, 3]], true);
    expect(hit(t3.ray_cast([0.2, 0.6, 1], [0, 0, -1]))).toEqual([[0.2, 0.6, 0], [0, 0, 1], 1, 1]);
  });

  it('FromObject uses the evaluated mesh in object space', () => {
    const B = bpy as Any;
    const cube = B.data.objects['Cube'];
    cube.location = [10, 0, 0];
    const t = BVHTree.FromObject(cube, B.context.evaluated_depsgraph_get());
    const [loc, nor, , dist] = t.ray_cast([0.3, 0.2, 5], [0, 0, -1]);
    expect(r4(loc!)).toEqual([0.3, 0.2, 1]);
    expect(r4(nor!)).toEqual([0, 0, 1]);
    expect(dist).toBeCloseTo(4);
    const side = t.ray_cast([5, 0.1, 0.2], [-1, 0, 0]);
    expect(r4(side[0]!)).toEqual([1, 0.1, 0.2]);
    expect(r4(side[1]!)).toEqual([1, 0, 0]);
    expect(t.ray_cast([0, 0, 0], [0, 0, 1])[3]).toBeCloseTo(1);
    const near = t.find_nearest([0.2, 0.1, 3]);
    expect(r4(near[0]!)).toEqual([0.2, 0.1, 1]);
    expect(near[3]).toBeCloseTo(2);
    expect(() => BVHTree.FromObject(B.data.objects['Camera'])).toThrow(/no mesh data/);
  });

  it('FromBMesh reads verts and faces generically', () => {
    const bv = verts.map((co, index) => ({ co: new Vector(co), index }));
    let updated = false;
    const vertsColl = Object.assign([...bv], { index_update: () => (updated = true) });
    const bm = { verts: vertsColl, faces: polys.map((p) => ({ verts: p.map((i) => bv[i]) })) };
    const t = BVHTree.FromBMesh(bm);
    expect(updated).toBe(true);
    expect(t.ray_cast([1.5, 0.5, 2], [0, 0, -1])[2]).toBe(1);
  });

  it('is fast and exact on a large mesh', () => {
    // 200 x 200 grid of quads with a bumpy height field: 80k triangles
    const n = 200;
    const vs: number[][] = [];
    const h = (x: number, y: number) => 0.2 * Math.sin(x * 0.3) * Math.cos(y * 0.2);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vs.push([i, j, h(i, j)]);
    const ps: number[][] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) ps.push([j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i]);
    let t0 = performance.now();
    const t = BVHTree.FromPolygons(vs, ps);
    const build = performance.now() - t0;
    t0 = performance.now();
    let hits = 0;
    for (let k = 0; k < 20000; k++) {
      const x = 0.5037 + ((k * 7919) % 19900) / 100,
        y = 0.5071 + ((k * 104729) % 19900) / 100;
      const r = t.ray_cast([x, y, 10], [0, 0, -1]);
      if (r[0]) {
        hits++;
        expect(r[2]).toBe(Math.floor(y) * n + Math.floor(x));
      }
    }
    const cast = performance.now() - t0;
    expect(hits).toBe(20000);
    expect(build).toBeLessThan(3000);
    expect(cast).toBeLessThan(3000);
    const near = t.find_nearest([50.5, 60.5, 3]);
    expect(near[2]).toBe(60 * n + 50);
  });
});

describe('mathutils.noise', () => {
  it('is deterministic and in range', () => {
    noise.seed_set(5);
    const a = [noise.random(), noise.random()];
    noise.seed_set(5);
    expect([noise.random(), noise.random()]).toEqual(a);
    expect(noise.random_unit_vector().length).toBeCloseTo(1);
    expect(noise.random_unit_vector(2).size).toBe(2);
    const p = [0.3, 0.2, 0.1];
    const n1 = noise.noise(p);
    noise.seed_set(99);
    expect(noise.noise(p)).toBe(n1);
    for (const basis of ['BLENDER', 'PERLIN_ORIGINAL', 'PERLIN_NEW', 'VORONOI_F1', 'VORONOI_F2', 'VORONOI_F2F1', 'VORONOI_CRACKLE', 'CELLNOISE'] as const) {
      let mn = Infinity,
        mx = -Infinity;
      for (let i = 0; i < 500; i++) {
        const v = noise.noise([i * 0.37 - 40, i * 0.71 - 90, i * 0.13], basis);
        mn = Math.min(mn, v);
        mx = Math.max(mx, v);
      }
      expect(mn).toBeGreaterThanOrEqual(-1);
      expect(mx).toBeLessThanOrEqual(1);
      expect(mx - mn).toBeGreaterThan(0.3);
    }
    expect(noise.noise_vector(p).size).toBe(3);
    expect(noise.turbulence(p, 4, true)).toBeGreaterThanOrEqual(0);
    expect(noise.fractal(p, 1, 2, 4)).toBeCloseTo(noise.turbulence(p, 4, false, 'PERLIN_ORIGINAL', 0.5, 2), 10);
    expect(noise.multi_fractal(p, 1, 2, 4)).toBeGreaterThan(0);
    expect(Number.isFinite(noise.ridged_multi_fractal(p, 1, 2, 4, 1, 1))).toBe(true);
    expect(Number.isFinite(noise.hybrid_multi_fractal(p, 1, 2, 4, 1, 1))).toBe(true);
    expect(Number.isFinite(noise.hetero_terrain(p, 1, 2, 4, 1))).toBe(true);
    expect(Number.isFinite(noise.variable_lacunarity(p, 1))).toBe(true);
    const [dists, pts] = noise.voronoi(p);
    expect(dists.length).toBe(4);
    expect(pts.length).toBe(4);
    expect(dists[0]).toBeCloseTo(Math.hypot(...pts[0].sub(p).toArray()));
    expect([...dists].sort((x, y) => x - y)).toEqual(dists);
    expect(noise.cell([0.3, 0.2, 0.1])).toBe(noise.cell([0.9, 0.7, 0.4]));
    expect(() => noise.noise(p, 'NOPE' as Any)).toThrow(/ValueError/);
  });
});

// ---------------------------------------------------------------------------
// Python

describe('mathutils in Python', () => {
  let py = false;
  beforeAll(async () => {
    py = await pythonAvailable();
  }, 60000);

  it('submodules import in every form', () => {
    if (!py) return;
    expect(
      runPy(`
        import mathutils
        import mathutils.geometry
        from mathutils import geometry, kdtree, bvhtree, noise
        from mathutils.kdtree import KDTree
        from mathutils.bvhtree import BVHTree
        from mathutils.geometry import intersect_ray_tri
        print(mathutils.geometry is geometry, KDTree is kdtree.KDTree, BVHTree is bvhtree.BVHTree, intersect_ray_tri is geometry.intersect_ray_tri, noise.__name__)
      `),
    ).toBe('True True True True mathutils.noise');
  });

  it('vector, quaternion and matrix additions', () => {
    if (!py) return;
    expect(
      runPy(`
        from mathutils import Vector, Matrix, Quaternion, Euler, Color
        r = lambda v: tuple(round(x, 4) + 0.0 for x in v)
        print(round(Vector((1, 0)).angle_signed(Vector((0, 1))), 4))
        print(r(Vector((2, 0, 0)).slerp(Vector((0, 4, 0)), 0.25)))
        print(r(Vector((1, 2, 3)).to_track_quat('Z', 'Y')), r(Vector((1, 2, 3)).orthogonal()))
        print(r(Vector((1, 0, 0)).rotation_difference(Vector((-1, 0, 0)))))
        q = Quaternion((1, 2, 3, 4)).normalized()
        s, t = q.to_swing_twist('Z')
        print(r(s), round(t, 4), r(Quaternion((1, 2, 3))))
        print(r(Matrix.Shear('XZ', 3, (0.5, 0.2))[2]), r(Matrix.OrthoProjection('XZ', 3)[1]), r(Matrix.OrthoProjection(Vector((1, 1, 0)), 3)[0]))
        m = Matrix.LocRotScale((1, 2, 3), Euler((0.1, 0.2, 0.3)), (1, 2, 3))
        print(r(m.adjugated()[0]), round(m.median_scale, 4), m.is_orthogonal_axis_vectors, Matrix.Identity(3).is_identity)
        print(r(Matrix(((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 1, 0))) @ Vector((1, 2, 3))))
        c = Color((0.2, 0.4, 0.6))
        print(r(c.from_scene_linear_to_srgb()), r(c.from_scene_linear_to_xyz_d65()), r(c.from_scene_linear_to_acescg()))
        print(r(Vector((1, 2, 3)).zyx), r(Vector.Linspace(0, 1, 3)))
        e = Euler((0.1, 0.2, 0.3), 'ZXY'); e.rotate_axis('X', 0.5); print(r(e))
      `),
    ).toBe(
      [
        '-1.5708',
        '(0.9239, 0.3827, 0.0)',
        '(0.2181, 0.0723, 0.3064, 0.9238) (3.0, 3.0, -3.0)',
        '(0.0, 0.0, 0.7071, 0.7071)',
        '(0.7528, -0.4428, 0.4871, 0.0) 2.6516 (0.2956, -0.2553, -0.5106, -0.766)',
        '(0.0, 0.2, 1.0) (0.0, 0.0, 0.0) (0.5, -0.5, 0.0)',
        '(5.6178, 1.7378, -1.192, -5.5173) 2.1602 True True',
        '(1.0, 2.0, 3.0)',
        '(0.4845, 0.6652, 0.7977) (0.3338, 0.3719, 0.6219) (0.2869, 0.3887, 0.5698)',
        '(3.0, 2.0, 1.0) (0.0, 0.5, 1.0)',
        '(0.5744, 0.3696, 0.3578)',
      ].join('\n'),
    );
  });

  it('geometry functions return the documented shapes', () => {
    if (!py) return;
    expect(
      runPy(`
        from mathutils import Vector
        from mathutils import geometry as G
        r = lambda v: tuple(round(x, 4) + 0.0 for x in v)
        hit = G.intersect_ray_tri(Vector((0, 0, 0)), Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, -1)), Vector((0.2, 0.2, 1)))
        print(type(hit).__name__, r(hit), G.intersect_ray_tri((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, -1), (2, 2, 1)))
        print(r(G.intersect_ray_tri((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, -1), (2, 2, 1), clip=False)))
        a, b = G.intersect_line_line((0, 0, 0), (1, 0, 0), (0.5, 1, 1), (0.5, 2, 1))
        print(r(a), r(b), G.intersect_line_line((0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0)))
        print(G.intersect_plane_plane((0, 0, 1), (0, 0, 1), (0, 0, 2), (0, 0, 1)), G.intersect_line_sphere((-2, 0, 0), (0, 0, 0), (0, 0, 0), 1.0))
        p, t = G.intersect_point_line((3, 1, 0), (0, 0, 0), (2, 0, 0))
        print(r(p), t, G.intersect_point_tri_2d((0.2, 0.2), (0, 0), (0, 1), (1, 0)), G.intersect_tri_tri_2d((0, 0), (1, 0), (0, 1), (2, 2), (3, 2), (2, 3)))
        print(G.area_tri((0, 0, 0), (2, 0, 0), (0, 2, 0)), r(G.normal([(0, 0, 0), (1, 0, 0), (0, 1, 0)])), r(G.normal((0, 0, 0), (1, 0, 0), (0, 1, 0))))
        print(G.tessellate_polygon([[(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]]), G.convex_hull_2d([(0, 0), (1, 0), (0.5, 0.5), (1, 1), (0, 1), (0.5, 2)]))
        print([r(v) for v in G.interpolate_bezier((0, 0, 0), (1, 0, 0), (2, 1, 0), (3, 1, 0), 3)])
        boxes = [[0, 0, 1, 1], [0, 0, 2, 1]]
        w, h = G.box_pack_2d(boxes)
        print(w * h <= 4.0, boxes[0][2:], all(isinstance(x, float) for x in boxes[1][:2]))
        verts, used = G.points_in_planes([(1, 0, 0, -1), (-1, 0, 0, -1), (0, 1, 0, -1), (0, -1, 0, -1), (0, 0, 1, -1), (0, 0, -1, -1)])
        print(len(verts), used, round(G.box_fit_2d([(0, 0), (1, 1), (2, 2), (1.5, 2.5), (0.5, -0.5)]), 4))
        print(r(G.barycentric_transform((0.25, 0.25, 0.5), (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 0), (2, 0, 0), (0, 2, 0))), r(G.closest_point_on_tri((2, 2, 1), (0, 0, 0), (1, 0, 0), (0, 1, 0))))
        try:
            G.normal((0, 0, 0))
        except ValueError as e:
            print("ValueError")
      `),
    ).toBe(
      [
        'Vector (0.2, 0.2, 0.0) None',
        '(2.0, 2.0, 0.0)',
        '(0.5, 0.0, 0.0) (0.5, 0.0, 1.0) None',
        '(None, None) (None, Vector((-1.0, 0.0, 0.0)))',
        '(3.0, 0.0, 0.0) 1.5 -1 False',
        '2.0 (0.0, 0.0, 1.0) (0.0, 0.0, 1.0)',
        '[(3, 0, 1), (1, 2, 3)] [0, 1, 3, 5, 4]',
        '[(0.0, 0.0, 0.0), (1.5, 0.5, 0.0), (3.0, 1.0, 0.0)]',
        'True [1, 1] True',
        '8 [0, 1, 2, 3, 4, 5] 0.5404',
        '(0.5, 0.5, 1.0) (0.5, 0.5, 0.0)',
        'ValueError',
      ].join('\n'),
    );
  });

  it('KDTree', () => {
    if (!py) return;
    expect(
      runPy(`
        from mathutils.kdtree import KDTree
        kd = KDTree(5)
        for i, c in enumerate([(0, 0, 0), (1, 0, 0), (2, 0, 0), (0, 3, 0), (5, 5, 5)]):
            kd.insert(c, i * 10)
        kd.balance()
        co, index, dist = kd.find((0.9, 0.2, 0))
        print(co, index, round(dist, 4))
        print(kd.find((0.9, 0.2, 0), filter=lambda i: i != 10)[1])
        print([(i, round(d, 4)) for (_, i, d) in kd.find_n((0.4, 0, 0), 3)])
        print([(i, d) for (_, i, d) in kd.find_range((0, 0, 0), 2.0)])
        e = KDTree(0); e.balance(); print(e.find((0, 0, 0)), e.find_n((0, 0, 0), 2))
        try:
            KDTree(1).find((0, 0, 0))
        except RuntimeError as ex:
            print("RuntimeError", ex)
        k = KDTree(1); k.insert((0, 0, 0), 0)
        try:
            k.insert((1, 1, 1), 1)
        except RuntimeError as ex:
            print("RuntimeError")
      `),
    ).toBe(
      [
        '<Vector (1.0000, 0.0000, 0.0000)> 10 0.2236',
        '0',
        '[(0, 0.4), (10, 0.6), (20, 1.6)]',
        '[(0, 0.0), (10, 1.0), (20, 2.0)]',
        '(None, None, None) []',
        'RuntimeError KDTree must be balanced before calling find()',
        'RuntimeError',
      ].join('\n'),
    );
  });

  it('BVHTree from polygons, the scene and duck-typed BMesh', () => {
    if (!py) return;
    expect(
      runPy(`
        import bpy
        from mathutils import Vector
        from mathutils.bvhtree import BVHTree
        r = lambda v: tuple(round(x, 4) + 0.0 for x in v)
        verts = [Vector((0, 0, 0)), Vector((1, 0, 0)), Vector((1, 1, 0)), Vector((0, 1, 0)), Vector((2, 0, 0)), Vector((2, 1, 0.5))]
        t = BVHTree.FromPolygons(verts, [(0, 1, 2, 3), (1, 4, 5, 2)])
        loc, nor, idx, dist = t.ray_cast(Vector((1.5, 0.5, 2)), Vector((0, 0, -1)))
        print(r(loc), r(nor), idx, dist)
        print(t.ray_cast((0.5, 0.5, 1), (0, 0, -1), distance=0.5), t.find_nearest((0.5, 0.5, 1), distance=0.5))
        loc, nor, idx, dist = t.find_nearest((-1, -1, 0))
        print(r(loc), idx, round(dist, 4), len(t.find_nearest_range((1, 0.5, 0.2), 1.0)))
        t2 = BVHTree.FromPolygons([(0.5, 0.5, -1), (0.5, 0.5, 1), (0.6, 0.7, 0)], [(0, 1, 2)], all_triangles=True)
        print(t.overlap(t2))
        cube = bpy.data.objects['Cube']
        tc = BVHTree.FromObject(cube, bpy.context.evaluated_depsgraph_get())
        loc, nor, idx, dist = tc.ray_cast((0.3, 0.2, 5), (0, 0, -1))
        print(r(loc), r(nor), round(dist, 4))
        class V:
            def __init__(s, co, i): s.co, s.index = Vector(co), i
        class F:
            def __init__(s, vs): s.verts = vs
        class BM:
            pass
        bm = BM(); bm.verts = [V(c, i) for i, c in enumerate(verts)]
        bm.faces = [F([bm.verts[i] for i in p]) for p in [(0, 1, 2, 3), (1, 4, 5, 2)]]
        print(BVHTree.FromBMesh(bm).ray_cast((1.5, 0.5, 2), (0, 0, -1))[2])
      `),
    ).toBe(
      [
        '(1.5, 0.5, 0.0) (-0.2357, -0.2357, 0.9428) 1 2.0',
        '(None, None, None, None) (None, None, None, None)',
        '(0.0, 0.0, 0.0) 0 1.4142 4',
        '[(0, 0)]',
        '(0.3, 0.2, 1.0) (0.0, 0.0, 1.0) 4.0',
        '1',
      ].join('\n'),
    );
  });

  it('noise forwards to the shared implementation', () => {
    if (!py) return;
    noise.seed_set(3);
    const js = [noise.random(), noise.noise([0.3, 0.2, 0.1]), noise.fractal([0.3, 0.2, 0.1], 1, 2, 4)].map((x) => x.toFixed(6));
    expect(
      runPy(`
        from mathutils import noise, Vector
        noise.seed_set(3)
        print("%.6f %.6f %.6f" % (noise.random(), noise.noise(Vector((0.3, 0.2, 0.1))), noise.fractal((0.3, 0.2, 0.1), 1.0, 2.0, 4)))
        d, p = noise.voronoi((0.3, 0.2, 0.1))
        print(len(d), type(p[0]).__name__, type(noise.noise_vector((0.1, 0.2, 0.3))).__name__, round(noise.random_unit_vector().length, 6))
        print(isinstance(noise.turbulence((0.1, 0.2, 0.3), 3, True, noise_basis='VORONOI_F1'), float))
      `),
    ).toBe([js.join(' '), '4 Vector Vector 1.0', 'True'].join('\n'));
  });
});
