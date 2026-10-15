// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newMeshData, newObject } from '../../src/data/defaults';
import { addObjectToScene } from '../../src/ops/object';
import * as prim from '../../src/mesh/primitives';
import type { ObjectData } from '../../src/data/types';
import '../../src/ops/data';
import '../../src/object/index';
import '../../src/physics/index';
import '../../src/hair/index';
import { hairOf, curveCount, pointCount, pointSelection, setSelection, getAttr, setCurves } from '../../src/hair/data';
import { duplicateSelected, extrudePoints, splitSelected, selectedPointMask } from '../../src/hair/edit';
import { snapToSurface, curvesToParticles } from '../../src/hair/convert';
import { surfaceOf } from '../../src/hair/common';
import type { ParticleSystemX } from '../../src/physics/types';
import { growByDistance } from '../../src/hair/sculptui';
import { deformOnSurface } from '../../src/hair/deformnode';
import { Surface } from '../../src/hair/surface';
import { Matrix4, Vector3 } from 'three';
const r3 = (a: ArrayLike<number>) => Array.from(a, (x) => Math.round(x * 1000) / 1000);

beforeEach(() => setApp(new App(startupDocument())));

const cube = () => Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
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
const pts = (...p: number[][]) => Float32Array.from(p.flat());

function emptyHair() {
  select(cube());
  expect(run('object.curves_empty_hair_add')).toBe('FINISHED');
  const ob = app.activeObject!;
  return { ob, hc: hairOf(app.doc, ob)! };
}

describe('hair curves objects', () => {
  it('adds empty hair attached to the active mesh', () => {
    const { ob, hc } = emptyHair();
    expect(ob.type).toBe('CURVES');
    expect(ob.parent).toBe(cube().id);
    expect(hc.surface).toBe(cube().id);
    expect(curveCount(hc)).toBe(0);
  });

  it('grows fur on the selected mesh', () => {
    select(cube());
    run('object.quick_fur', { density: 'LOW', length: 0.2, use_noise: false, use_frizz: false });
    const ob = app.activeObject!;
    const hc = hairOf(app.doc, ob)!;
    expect(ob.type).toBe('CURVES');
    expect(curveCount(hc)).toBeGreaterThan(600);
    // the evaluated mesh carries the strands
    expect(app.graph.get(ob.id)!.mesh!.curves!.length).toBe(curveCount(hc));
    // roots lie on the cube surface (|max coord| = 1)
    for (let c = 0; c < 20; c++) {
      const i = hc.curve_offsets[c] * 3;
      expect(Math.max(Math.abs(hc.positions[i]), Math.abs(hc.positions[i + 1]), Math.abs(hc.positions[i + 2]))).toBeCloseTo(1, 3);
    }
  });

  it('enters Edit and Sculpt mode and back', () => {
    emptyHair();
    expect(run('object.editmode_toggle')).toBe('FINISHED');
    expect(app.doc.mode).toBe('EDIT');
    run('object.mode_set', { mode: 'OBJECT' });
    expect(run('curves.sculptmode_toggle')).toBe('FINISHED');
    expect(app.doc.mode).toBe('SCULPT_CURVES');
    run('curves.sculptmode_toggle');
    expect(app.doc.mode).toBe('OBJECT');
  });

  it('edits points: select, extrude, duplicate, split, delete', () => {
    const { hc } = emptyHair();
    setCurves(hc, [{ points: pts([0, 0, 1], [0, 0, 1.5], [0, 0, 2]) }, { points: pts([0.5, 0, 1], [0.5, 0, 2]) }]);
    run('object.mode_set', { mode: 'EDIT' });
    run('curves.select_all', { action: 'DESELECT' });
    setSelection(hc, Float32Array.from([0, 0, 1, 0, 0]), 'POINT');
    expect(extrudePoints(hc, selectedPointMask(hc))).toBe(true);
    expect(Array.from(hc.curve_offsets)).toEqual([0, 4, 6]);
    expect(Array.from(pointSelection(hc))).toEqual([0, 0, 0, 1, 0, 0]);
    expect(duplicateSelected(hc)).toBe(1);
    expect(curveCount(hc)).toBe(3);
    setSelection(hc, Float32Array.from([0, 1, 1, 1, 0, 0, 0]), 'POINT');
    expect(splitSelected(hc)).toBe(true);
    expect(curveCount(hc)).toBe(4);
    run('curves.select_all', { action: 'SELECT' });
    run('curves.set_selection_domain', { domain: 'CURVE' });
    expect(hc.selection_domain).toBe('CURVE');
    run('curves.select_all', { action: 'DESELECT' });
    setSelection(hc, Float32Array.from([1, 0, 0, 0]), 'CURVE');
    expect(run('curves.delete')).toBe('FINISHED');
    expect(curveCount(hc)).toBe(3);
  });

  it('subdivides, toggles cyclic, switches direction and sets curve types', () => {
    const { hc } = emptyHair();
    setCurves(hc, [{ points: pts([0, 0, 1], [0, 0, 2], [1, 0, 2]) }]);
    run('object.mode_set', { mode: 'EDIT' });
    run('curves.select_all', { action: 'SELECT' });
    expect(run('curves.subdivide', { number_cuts: 2 })).toBe('FINISHED');
    expect(pointCount(hc)).toBe(7);
    run('curves.cyclic_toggle');
    expect(Array.from(getAttr(hc, 'cyclic')!.data)).toEqual([1]);
    run('curves.switch_direction');
    expect(Array.from(hc.positions.slice(0, 3))).toEqual([1, 0, 2]);
    run('curves.curve_type_set', { type: 'BEZIER' });
    expect(Array.from(getAttr(hc, 'curve_type')!.data)).toEqual([2]);
    expect(getAttr(hc, 'handle_left')).toBeTruthy();
    run('curves.curve_type_set', { type: 'POLY' });
    expect(getAttr(hc, 'curve_type')).toBeUndefined();
    expect(run('curves.add_circle')).toBe('FINISHED');
    expect(curveCount(hc)).toBe(2);
  });

  it('snaps roots to the surface and keeps their UVs', () => {
    // a plane (unique UVs) as the surface
    const me = newMeshData('Plane', prim.plane(2));
    app.doc.meshes[me.id] = me;
    const pl = newObject('Plane', 'MESH', me.id);
    addObjectToScene(app.doc, pl, { location: [0, 0, 0] });
    select(pl);
    run('object.curves_empty_hair_add');
    const ob = app.activeObject!;
    const hc = hairOf(app.doc, ob)!;
    setCurves(hc, [{ points: pts([0.2, 0.3, 0.5], [0.2, 0.3, 1.5]) }]);
    app.graph.evaluate(app.doc, false);
    expect(snapToSurface(ob, hc, 'NEAREST')).toBe(1);
    expect(hc.positions[2]).toBeCloseTo(0, 4);
    expect(hc.positions[5]).toBeCloseTo(1, 4);
    // move away, snap back by UV
    hc.positions = pts([3, 3, 3], [3, 3, 4]);
    expect(snapToSurface(ob, hc, 'DEFORM')).toBe(1);
    expect(hc.positions[0]).toBeCloseTo(0.2, 3);
    expect(hc.positions[1]).toBeCloseTo(0.3, 3);
    expect(hc.positions[2]).toBeCloseTo(0, 3);
  });

  it('converts to a hair particle system and back', () => {
    const { ob, hc } = emptyHair();
    setCurves(hc, [{ points: pts([0, 0, 1], [0, 0, 1.5], [0, 0, 2]) }, { points: pts([0.5, 0, 1], [0.5, 0, 2]) }]);
    app.graph.evaluate(app.doc, false);
    const so = surfaceOf(ob, hc)!;
    const ps = curvesToParticles(app.doc, ob, hc, so.ob, so.toSurface);
    expect(ps.edited_hair!.key_offsets.length).toBe(3);
    const c = cube();
    expect(c.particle_systems.length).toBe(1);
    select(c);
    expect(run('curves.convert_from_particle_system')).toBe('FINISHED');
    const back = hairOf(app.doc, app.activeObject)!;
    expect(curveCount(back)).toBe(2);
    // first strand: root to tip along the curve
    expect(back.positions[2]).toBeCloseTo(1, 3);
  });

  it('converts Curves objects to meshes and curve objects', () => {
    const { ob, hc } = emptyHair();
    setCurves(hc, [{ points: pts([0, 0, 1], [0, 0, 2]) }]);
    select(ob);
    expect(run('object.convert', { target: 'CURVE' })).toBe('FINISHED');
    expect(ob.type).toBe('CURVE');
    expect(app.doc.curves[ob.data!].splines[0].points.length).toBe(2);
    expect(run('object.convert', { target: 'CURVES' })).toBe('FINISHED');
    expect(ob.type).toBe('CURVES');
    expect(pointCount(hairOf(app.doc, ob)!)).toBe(2);
    expect(run('object.convert', { target: 'MESH' })).toBe('FINISHED');
    expect(ob.type).toBe('MESH');
    expect(Array.from(app.doc.meshes[ob.data!].loose_edges!)).toEqual([0, 1]);
  });

  it('grows the sculpt selection by distance', () => {
    const { hc } = emptyHair();
    setCurves(hc, [{ points: pts([0, 0, 1], [0, 0, 2]) }, { points: pts([0.1, 0, 1], [0.1, 0, 2]) }, { points: pts([1, 0, 1], [1, 0, 2]) }]);
    hc.selection_domain = 'CURVE';
    setSelection(hc, Float32Array.from([1, 0, 0]), 'CURVE');
    growByDistance(hc, 0.2);
    expect(Array.from(getAttr(hc, '.selection')!.data)).toEqual([1, 1, 0]);
    growByDistance(hc, -0.05);
    expect(Array.from(getAttr(hc, '.selection')!.data)).toEqual([1, 1, 0]);
  });
});

describe('particle edit mode', () => {
  function hairSystem(count = 20) {
    const c = cube();
    select(c);
    run('object.particle_system_add');
    const s = app.doc.particles[c.particle_systems[0].settings];
    s.type = 'HAIR';
    s.count = count;
    s.hair_length = 0.5;
    app.graph.evaluate(app.doc, false);
    return { c, ps: c.particle_systems[0] as ParticleSystemX };
  }

  it('builds keys from the generated hair on entering', () => {
    const { ps } = hairSystem();
    expect(run('particle.particle_edit_toggle')).toBe('FINISHED');
    expect(app.doc.mode).toBe('PARTICLE_EDIT');
    expect(ps.edited_hair!.key_offsets.length).toBe(21);
    run('particle.particle_edit_toggle');
    expect(app.doc.mode).toBe('OBJECT');
    // the edited keys drive the hair afterwards
    expect(run('particle.edited_clear')).toBe('FINISHED');
    expect(ps.edited_hair).toBeNull();
  });

  it('selects roots / tips and edits keys', () => {
    const { ps } = hairSystem(10);
    run('object.mode_set', { mode: 'PARTICLE_EDIT' });
    run('particle.select_tips');
    expect(ps.edited_hair!.select.reduce((a, b) => a + b, 0)).toBe(10);
    run('particle.select_linked');
    expect(ps.edited_hair!.select.reduce((a, b) => a + b, 0)).toBe(60);
    expect(run('particle.rekey', { keys_number: 3 })).toBe('FINISHED');
    expect(ps.edited_hair!.co.length / 3).toBe(30);
    run('particle.select_all', { action: 'DESELECT' });
    run('particle.select_roots');
    expect(run('particle.weight_set', { factor: 0.25 })).toBe('FINISHED');
    expect(ps.edited_hair!.weight[0]).toBe(0.25);
    run('particle.select_all', { action: 'SELECT' });
    run('particle.hide');
    expect(ps.edited_hair!.hide.every((x) => x === 1)).toBe(true);
    run('particle.reveal');
    expect(ps.edited_hair!.hide.every((x) => x === 0)).toBe(true);
    expect(run('particle.mirror')).toBe('FINISHED');
    expect(ps.edited_hair!.key_offsets.length - 1).toBe(20);
    expect(run('particle.delete', { type: 'PARTICLE' })).toBe('FINISHED');
    expect(ps.edited_hair!.key_offsets.length - 1).toBe(0);
  });
});


describe('deform curves on surface', () => {
  it('carries curves along with their moved and rotated surface', () => {
    const p2 = prim.plane(2);
    const rest = { positions: p2.positions, offsets: p2.offsets, indices: p2.indices, uvs: p2.uvs, normals: new Float32Array(0) };
    // curve standing on the plane at UV of point (0.5, 0.5)
    const s = Surface.of(rest);
    const uv = s.closest(new Vector3(0.5, 0.5, 0))!.uv!;
    const P = pts([0.5, 0.5, 0], [0.5, 0.5, 1]);
    // identity deformation leaves the curve alone
    expect(r3(deformOnSurface(P, [0, 2], uv, rest, rest.positions)!)).toEqual(r3(P));
    // surface rotated 90° about X and lifted by 3
    const m = new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, 3);
    const def = Float32Array.from(rest.positions);
    const v = new Vector3();
    for (let i = 0; i < def.length; i += 3) v.fromArray(def, i).applyMatrix4(m).toArray(def, i);
    const out = deformOnSurface(P, [0, 2], uv, rest, def)!;
    expect(r3(out)).toEqual(r3([...new Vector3(0.5, 0.5, 0).applyMatrix4(m).toArray(), ...new Vector3(0.5, 0.5, 1).applyMatrix4(m).toArray()]));
  });
});
