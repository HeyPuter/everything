// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { Matrix4, Quaternion, Vector3, Euler } from 'three';
import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newObject } from '../../src/data/defaults';
import type { ObjectData } from '../../src/data/types';
import { addObjectToScene } from '../../src/ops/object';
import '../../src/ops/data';
import '../../src/object/index';
import { mirrorMatrix } from '../../src/object/globaltransform';
import { keyProperty } from '../../src/anim/keyframes';

beforeEach(() => setApp(new App(startupDocument())));

const byName = (n: string) => Object.values(app.doc.objects).find((o) => o.name === n)!;
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

describe('mirrorMatrix', () => {
  it('reflects the location along the axis and the rotation through the plane', () => {
    const q = new Quaternion().setFromEuler(new Euler(0, 0, 0.5));
    const m = new Matrix4().compose(new Vector3(2, 1, 3), q, new Vector3(1, 1, 1));
    const r = mirrorMatrix(m, null, 'x', 'x');
    const p = new Vector3(),
      q2 = new Quaternion(),
      s = new Vector3();
    r.decompose(p, q2, s);
    expect(p.toArray().map((x) => +x.toFixed(6))).toEqual([-2, 1, 3]);
    // a Z rotation mirrored over the YZ plane turns the other way
    const e = new Euler().setFromQuaternion(q2);
    expect(e.z).toBeCloseTo(-0.5, 6);
  });

  it('mirrors relative to a reference object', () => {
    const ref = new Matrix4().makeTranslation(10, 0, 0);
    const m = new Matrix4().makeTranslation(12, 0, 0);
    const r = mirrorMatrix(m, ref, 'x', 'z');
    expect(new Vector3().setFromMatrixPosition(r).x).toBeCloseTo(8, 6);
  });
});

describe('global transform operators', () => {
  it('pastes mirrored and relative transforms', () => {
    const cube = byName('Cube');
    cube.location = [2, 3, 1];
    select(cube);
    run('object.copy_global_transform');
    const e = newObject('E', 'EMPTY', null);
    addObjectToScene(app.doc, e, { location: [0, 0, 0] });
    select(e);
    run('object.paste_transform', { use_mirror: true, mirror_axis_loc: 'x' });
    expect(worldPos(e).toArray().map((x) => +x.toFixed(5))).toEqual([-2, 3, 1]);
    // relative to the scene camera: moving the camera carries the pasted object along
    select(cube);
    run('object.copy_relative_transform');
    const cam = byName('Camera');
    cam.location = [cam.location[0] + 1, cam.location[1], cam.location[2]];
    app.graph.evaluate(app.doc, false);
    select(e);
    run('object.paste_transform', { use_relative: true });
    expect(worldPos(e).x).toBeCloseTo(3, 4);
  });

  it('fixes an object to a moving camera with generated keys, and deletes them', () => {
    const cam = byName('Camera');
    const cube = byName('Cube');
    app.doc.scene.frame_start = 1;
    app.doc.scene.frame_end = 5;
    app.setFrame(1);
    // the camera slides along X over the range
    cam.location = [0, -10, 0];
    keyProperty(app.doc, cam, 'location', -1, 1);
    cam.location = [4, -10, 0];
    keyProperty(app.doc, cam, 'location', -1, 5);
    app.setFrame(1);
    app.flush();
    select(cube);
    expect(run('object.fix_to_camera')).toBe('FINISHED');
    app.setFrame(5);
    app.flush();
    expect(worldPos(cube).x).toBeCloseTo(4, 4);
    const act = app.doc.actions[cube.animation_data!.action!];
    const locX = act.fcurves.find((f) => f.data_path === 'location' && f.array_index === 0)!;
    expect(locX.keyframe_points.length).toBe(5);
    expect(locX.keyframe_points.every((k) => k.type === 'GENERATED')).toBe(true);
    expect(run('object.delete_fix_to_camera_keys')).toBe('FINISHED');
    expect(act.fcurves.filter((f) => f.data_path === 'location').length).toBe(0);
  });
});
