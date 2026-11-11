// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { Vector3 } from 'three';
import { App, setApp, app, operators } from '../../src/app/app';
import { startupDocument, newObject } from '../../src/data/defaults';
import type { ObjectData } from '../../src/data/types';
import { addObjectToScene } from '../../src/ops/object';
import '../../src/ops/data';
import '../../src/object/index';
import '../../src/ops/view3d';

beforeEach(() => setApp(new App(startupDocument())));

function select(...obs: ObjectData[]) {
  for (const o of Object.values(app.doc.objects)) o.select = false;
  for (const o of obs) o.select = true;
  app.doc.scene.active_object = obs[0]?.id ?? null;
  app.graph.evaluate(app.doc, false);
}
function run(op: string, props: Record<string, unknown> = {}) {
  const r = app.run(op, props, { invoke: false });
  app.graph.evaluate(app.doc, false);
  return r;
}
const worldPos = (ob: ObjectData) => new Vector3().setFromMatrixPosition(app.graph.get(ob.id)!.world);
const round = (v: Vector3) => v.toArray().map((x) => +x.toFixed(4) + 0);

function parentPair() {
  const p = newObject('P', 'EMPTY', null);
  addObjectToScene(app.doc, p, { location: [1, 0, 0] });
  const c = newObject('C', 'EMPTY', null);
  addObjectToScene(app.doc, c, { location: [3, 0, 0] });
  c.parent = p.id;
  // keep the child's world position: parent inverse of the parent's world
  c.matrix_parent_inverse = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1] as never;
  app.graph.evaluate(app.doc, false);
  return { p, c };
}

describe('snap selection with parent and child selected', () => {
  it('moves the child with its parent (to cursor)', () => {
    const { p, c } = parentPair();
    expect(round(worldPos(c))).toEqual([3, 0, 0]);
    app.doc.scene.cursor.location = [0, 5, 0];
    select(p, c);
    run('view3d.snap_selected_to_cursor', { use_offset: true });
    // the median (2, 0, 0) lands on the cursor: everything shifts by (-2, 5, 0)
    expect(round(worldPos(p))).toEqual([-1, 5, 0]);
    expect(round(worldPos(c))).toEqual([1, 5, 0]);
  });

  it('moves the child with its parent (to grid)', () => {
    const { p, c } = parentPair();
    p.location = [1.4, 0, 0];
    app.graph.evaluate(app.doc, false);
    select(p, c);
    run('view3d.snap_selected_to_grid');
    expect(round(worldPos(p))).toEqual([1, 0, 0]);
    expect(round(worldPos(c))).toEqual([3, 0, 0]);
  });
});

describe('apply a negative scale', () => {
  // per (face, vertex) key → value, independent of the corner order
  function cornerMap(me: { offsets: Uint32Array; indices: Uint32Array }, data: ArrayLike<number>, stride: number) {
    const out = new Map<string, number[]>();
    for (let f = 0; f < me.offsets.length - 1; f++)
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) out.set(`${f}:${me.indices[c]}`, Array.from({ length: stride }, (_, k) => +Number(data[c * stride + k]).toFixed(4)));
    return out;
  }
  // per edge (vertex pair) → value of the edge flag stored on the corner that starts it
  function edgeMap(me: { offsets: Uint32Array; indices: Uint32Array }, data: ArrayLike<number>) {
    const out = new Map<string, number>();
    for (let f = 0; f < me.offsets.length - 1; f++) {
      const s = me.offsets[f],
        e = me.offsets[f + 1];
      for (let c = s; c < e; c++) {
        const a = me.indices[c],
          b = me.indices[c + 1 < e ? c + 1 : s];
        const k = a < b ? `${a}-${b}` : `${b}-${a}`;
        out.set(k, Math.max(out.get(k) ?? 0, data[c]));
      }
    }
    return out;
  }

  it('keeps seams, extra UV maps and corner colors on their edges and corners', () => {
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
    const me = app.doc.meshes[cube.data!];
    const nc = me.indices.length;
    me.seams = new Uint32Array(nc);
    me.seams[0] = 1;
    me.seams[5] = 1;
    me.bevel_weight_edge = new Float32Array(nc);
    me.bevel_weight_edge[2] = 0.5;
    me.uv_layers_extra = [{ name: 'UV2', data: Float32Array.from({ length: nc * 2 }, (_, i) => i / 10) }];
    me.color_attributes = [{ name: 'Col', domain: 'CORNER', data: Float32Array.from({ length: nc * 4 }, (_, i) => i / 100) }];
    const seams0 = edgeMap(me, me.seams);
    const bevel0 = edgeMap(me, me.bevel_weight_edge);
    const uv0 = cornerMap(me, me.uvs, 2);
    const uv20 = cornerMap(me, me.uv_layers_extra[0].data, 2);
    const col0 = cornerMap(me, me.color_attributes[0].data, 4);
    cube.scale = [-1, 1, 1];
    select(cube);
    run('object.transform_apply', { location: false, rotation: false, scale: true });
    const m2 = app.doc.meshes[cube.data!];
    expect(edgeMap(m2, m2.seams!)).toEqual(seams0);
    expect(edgeMap(m2, m2.bevel_weight_edge!)).toEqual(bevel0);
    expect(cornerMap(m2, m2.uvs, 2)).toEqual(uv0);
    expect(cornerMap(m2, m2.uv_layers_extra![0].data, 2)).toEqual(uv20);
    expect(cornerMap(m2, m2.color_attributes[0].data, 4)).toEqual(col0);
    // faces still point outwards
    for (let f = 0; f < m2.offsets.length - 1; f++) {
      const c = m2.offsets[f];
      const center = [0, 0, 0];
      for (let k = m2.offsets[f]; k < m2.offsets[f + 1]; k++) for (let j = 0; j < 3; j++) center[j] += m2.positions[m2.indices[k] * 3 + j];
      expect(center[0] * m2.normals[c * 3] + center[1] * m2.normals[c * 3 + 1] + center[2] * m2.normals[c * 3 + 2]).toBeGreaterThan(0);
    }
  });
});

describe('apply transforms to a parent and its child', () => {
  it('keeps the child geometry in place whatever the selection order', () => {
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
    const p = newObject('P', 'EMPTY', null);
    addObjectToScene(app.doc, p, { location: [5, 0, 0] });
    p.scale = [2, 2, 2];
    cube.parent = p.id;
    cube.location = [1, 0, 0];
    cube.scale = [1, 3, 1];
    app.graph.evaluate(app.doc, false);
    const worldVerts = () => {
      const ev = app.graph.get(cube.id)!;
      const P = app.doc.meshes[cube.data!].positions;
      const out: number[] = [];
      for (let i = 0; i < P.length; i += 3) out.push(...new Vector3(P[i], P[i + 1], P[i + 2]).applyMatrix4(ev.world).toArray().map((x) => +x.toFixed(4) + 0));
      return out;
    };
    const before = worldVerts();
    // the child comes first in the object order
    expect(app.doc.object_order.indexOf(cube.id)).toBeLessThan(app.doc.object_order.indexOf(p.id));
    select(cube, p);
    run('object.transform_apply', { location: true, rotation: true, scale: true });
    expect(worldVerts()).toEqual(before);
  });

  it('keeps a grandchild in place when the whole chain is applied', () => {
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
    const p = newObject('P', 'EMPTY', null);
    addObjectToScene(app.doc, p, { location: [5, 0, 0] });
    p.scale = [2, 2, 2];
    cube.parent = p.id;
    cube.location = [1, 0, 0];
    const g = newObject('G', 'EMPTY', null);
    addObjectToScene(app.doc, g, { location: [0, 0, 0] });
    g.parent = cube.id;
    g.location = [0, 1, 0];
    app.graph.evaluate(app.doc, false);
    const g0 = round(worldPos(g));
    select(p, cube);
    run('object.transform_apply', { location: true, rotation: true, scale: true });
    expect(round(worldPos(g))).toEqual(g0);
  });
});

describe('apply rotation with custom normals', () => {
  it('turns the custom normals with the geometry', () => {
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
    const me = app.doc.meshes[cube.data!];
    const nc = me.indices.length;
    // every corner normal points +X
    me.custom_normals = Float32Array.from({ length: nc * 3 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    cube.rotation_euler = [0, 0, Math.PI / 2];
    cube.scale = [1, 1, 1];
    select(cube);
    run('object.transform_apply', { location: false, rotation: true, scale: false });
    const cn = app.doc.meshes[cube.data!].custom_normals!;
    // +X turned 90° around Z is +Y
    expect([cn[0], cn[1], cn[2]].map((x) => +x.toFixed(4) + 0)).toEqual([0, 1, 0]);
  });
});

describe('framing with broken coordinates', () => {
  it('ignores non-finite positions in the bounds', async () => {
    const { worldBounds } = await import('../../src/editors/view3d/view3d');
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
    const e = newObject('E', 'EMPTY', null);
    addObjectToScene(app.doc, e, { location: [NaN, 0, 0] });
    const me = app.doc.meshes[cube.data!];
    const P = new Float32Array(me.positions);
    P[0] = Infinity;
    me.positions = P;
    app.graph.evaluate(app.doc, false);
    const b = worldBounds([cube.id, e.id]);
    expect([...b.min.toArray(), ...b.max.toArray()].every(Number.isFinite)).toBe(true);
    expect(b.max.toArray()).toEqual([1, 1, 1]);
  });
});

// transform operators poll for a 3D view: call their exec directly
function execOp(op: string, props: Record<string, unknown>) {
  const r = operators.get(op)!.exec!(app.context(null), props);
  app.graph.evaluate(app.doc, false);
  return r;
}

describe('transforms with a zero scale', () => {
  const cubeOf = () => Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
  it('scales an axis to zero keeping the rotation', () => {
    const cube = cubeOf();
    cube.rotation_euler = [0, 0, 0.5];
    cube.scale = [1, 2, 3];
    select(cube);
    execOp('transform.resize', { value: [1, 1, 0], orient_type: 'LOCAL', constraint_axis: [false, false, true] });
    expect(cube.scale.map((x) => +x.toFixed(5) + 0)).toEqual([1, 2, 0]);
    expect(cube.rotation_euler.map((x) => +x.toFixed(5) + 0)).toEqual([0, 0, 0.5]);
    execOp('transform.resize', { value: [0, 0, 0] });
    expect(cube.scale.map((x) => +x.toFixed(5) + 0)).toEqual([0, 0, 0]);
    expect(cube.rotation_euler.map((x) => +x.toFixed(5) + 0)).toEqual([0, 0, 0.5]);
  });

  it('rotates and moves an object scaled to zero', () => {
    const cube = cubeOf();
    cube.scale = [0, 0, 0];
    cube.location = [1, 0, 0];
    select(cube);
    execOp('transform.rotate', { value: Math.PI / 2, orient_axis: 'Z', orient_type: 'GLOBAL' });
    expect(cube.scale).toEqual([0, 0, 0]);
    expect(cube.rotation_euler.map((x) => +x.toFixed(5) + 0)).toEqual([0, 0, +(Math.PI / 2).toFixed(5)]);
    execOp('transform.translate', { value: [0, 0, 2] });
    expect(cube.location.map((x) => +x.toFixed(5) + 0)).toEqual([1, 0, 2]);
    expect(cube.scale).toEqual([0, 0, 0]);
  });
});

describe('join', () => {
  it('keeps the faces of a mirrored object pointing outwards and carries corner/vertex data', () => {
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
    const me0 = app.doc.meshes[cube.data!];
    me0.color_attributes = [{ name: 'Col', domain: 'POINT', data: new Float32Array((me0.positions.length / 3) * 4).fill(0.5) }];
    select(cube);
    run('object.duplicate_move', {});
    const dup = app.activeObject!;
    dup.location = [5, 0, 0];
    dup.scale = [-1, 1, 1];
    app.graph.evaluate(app.doc, false);
    select(cube, dup);
    app.doc.scene.active_object = cube.id;
    app.graph.evaluate(app.doc, false);
    run('object.join');
    const me = app.doc.meshes[cube.data!];
    const nv = me.positions.length / 3;
    expect(nv).toBe(16);
    // the colour attribute grows with the vertices
    expect(me.color_attributes[0]?.data.length).toBe(nv * 4);
    // every face points away from the centre of its own cube
    for (let f = 0; f < me.offsets.length - 1; f++) {
      const c = [0, 0, 0];
      const s = me.offsets[f],
        e = me.offsets[f + 1];
      for (let k = s; k < e; k++) for (let j = 0; j < 3; j++) c[j] += me.positions[me.indices[k] * 3 + j] / (e - s);
      const cx = c[0] > 2.5 ? 5 : 0;
      const d = (c[0] - cx) * me.normals[s * 3] + c[1] * me.normals[s * 3 + 1] + c[2] * me.normals[s * 3 + 2];
      expect(d, `face ${f}`).toBeGreaterThan(0);
    }
  });
});

describe('show hidden objects with several scenes', () => {
  it('only reveals (and selects) objects of the current scene', async () => {
    const { newScene, activateScene } = await import('../../src/scenes/scenes');
    const { duplicateObject } = await import('../../src/ops/object');
    const { uniqueName } = await import('../../src/ops/object');
    const first = app.doc.scene;
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
    cube.hide = true;
    cube.select = false;
    const sc = newScene(app.doc, 'FULL_COPY', { duplicateObject, uniqueName: (d, b, k) => uniqueName(d, b, k ?? 'objects') });
    app.graph.evaluate(app.doc, false);
    expect(app.doc.scene).toBe(sc);
    run('object.hide_view_clear');
    expect(cube.hide).toBe(true);
    expect(cube.select).toBe(false);
    const copy = Object.values(app.doc.objects).find((o) => o.name === 'Cube.001')!;
    expect(copy.hide).toBe(false);
    activateScene(app.doc, first.id!);
  });
});
