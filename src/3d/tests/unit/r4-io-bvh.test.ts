// @vitest-environment happy-dom
// BVH motion capture: parsing, armature import (world motion checked against values measured in
// the reference app for the same file) and export → import round trips.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vector3 } from 'three';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument, emptyDocument } from '../../src/data/defaults';
import { runJavaScript } from '../../src/scripting/runner';
import { vfsRead, vfsWrite, vfsClear } from '../../src/io/vfs';
import { parseBvh, importBvh, jointWorld, rotationOrder } from '../../src/io/formats/bvh';
import { Depsgraph } from '../../src/eval/depsgraph';
import type { DocumentData, ObjectData } from '../../src/data/types';

const probe = readFileSync(resolve(__dirname, '../fixtures/formats/r4_probe.bvh'), 'utf8');

beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
}, 120000);
beforeEach(() => {
  setApp(new App(startupDocument()));
  vfsClear();
});

const js = (code: string) => {
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error}`);
};

/** World head / tail of every bone at a frame. */
function bonesAt(doc: DocumentData, ob: ObjectData, frame: number) {
  const g = new Depsgraph(doc);
  doc.scene.frame_current = frame;
  g.evaluate(doc);
  const ev = g.get(ob.id)!;
  const out: Record<string, { head: number[]; tail: number[] }> = {};
  for (const [name, b] of ev.pose!.bones) {
    const h = new Vector3().applyMatrix4(b.pose).applyMatrix4(ev.world);
    const t = new Vector3(0, b.length, 0).applyMatrix4(b.pose).applyMatrix4(ev.world);
    const r = (v: Vector3) => [v.x, v.y, v.z].map((x) => Math.round(x * 1e4) / 1e4 + 0);
    out[name] = { head: r(h), tail: r(t) };
  }
  return out;
}

describe('BVH', () => {
  it('parses the hierarchy, channels and motion', () => {
    const b = parseBvh(probe);
    expect(b.joints.map((j) => j.name)).toEqual(['Hips', 'Chest', 'Head', 'LegL']);
    expect(rotationOrder(b.joints[0])).toBe('ZXY');
    expect(b.motion.length).toBe(2);
    expect(b.frameTime).toBeCloseTo(1 / 30, 5);
    // channels compose in listed order
    const w = jointWorld(b, 1).get(b.joints[1])!;
    expect([w.p.x, w.p.y, w.p.z].map((v) => +v.toFixed(4))).toEqual([0.5603, 3.6276, 2.684]);
  });

  it('imports an armature whose motion matches the reference app', () => {
    const doc = emptyDocument();
    const { objects } = importBvh(doc, parseBvh(probe), { name: 'probe' });
    const ob = objects[0];
    expect(ob.type).toBe('ARMATURE');
    const arm = doc.armatures[ob.data!];
    const hips = arm.bones.find((b) => b.name === 'Hips')!;
    expect(hips.head).toEqual([1, -3, 2]);
    expect(hips.tail.map((v) => +v.toFixed(4))).toEqual([1.5, -3, 3]);
    expect(ob.pose!.Hips.rotation_mode).toBe('ZXY');
    const f1 = bonesAt(doc, ob, 1);
    expect(f1.LegL).toEqual({ head: [2, -3, 2], tail: [2, -3, 0] });
    const f2 = bonesAt(doc, ob, 2);
    // measured in the reference app after importing the same file
    expect(f2.Hips.head).toEqual([1.5, -2, 2]);
    expect(f2.Hips.tail).toEqual([1.4417, -2.2604, 3.0857]);
    expect(f2.Chest.head).toEqual([0.5603, -2.684, 3.6276]);
    expect(f2.Head.head).toEqual([0.0404, -2.99, 4.5689]);
    expect(f2.Head.tail).toEqual([-0.6526, -3.1219, 5.2777]);
    expect(f2.LegL.head).toEqual([2.3232, -1.8368, 2.5438]);
    expect(f2.LegL.tail).toEqual([2.2815, -0.4514, 1.102]);
  });

  it('imports as quaternions or as a hierarchy of empties', () => {
    const doc = emptyDocument();
    const { objects } = importBvh(doc, parseBvh(probe), { rotateMode: 'QUATERNION' });
    expect(objects[0].pose!.Chest.rotation_mode).toBe('QUATERNION');
    expect(bonesAt(doc, objects[0], 2).Head.tail).toEqual([-0.6526, -3.1219, 5.2777]);
    const doc2 = emptyDocument();
    const res = importBvh(doc2, parseBvh(probe), { target: 'OBJECT' });
    expect(res.objects.map((o) => o.name)).toEqual(['Hips', 'Chest', 'Head', 'LegL']);
    const g = new Depsgraph(doc2);
    doc2.scene.frame_current = 2;
    g.evaluate(doc2);
    const head = res.objects[2];
    const p = new Vector3().setFromMatrixPosition(g.get(head.id)!.world);
    expect([p.x, p.y, p.z].map((v) => Math.round(v * 1e4) / 1e4 + 0)).toEqual([0.0404, -2.99, 4.5689]);
  });

  it('round-trips through the operators', () => {
    vfsWrite('/tmp/probe.bvh', probe);
    js(`bpy.ops.import_anim.bvh({ filepath: '/tmp/probe.bvh' })`);
    const ob = app.doc.objects[app.doc.scene.active_object!];
    expect(ob.type).toBe('ARMATURE');
    const before = bonesAt(app.doc, ob, 2);
    js(`
      bpy.context.scene.frame_start = 1; bpy.context.scene.frame_end = 2;
      bpy.ops.export_anim.bvh({ filepath: '/tmp/out.bvh' });
    `);
    const text = new TextDecoder().decode(vfsRead('/tmp/out.bvh')!);
    if (process.env.BVH_OUT) writeFileSync(process.env.BVH_OUT, text);
    expect(text).toMatch(/^HIERARCHY\nROOT Hips\n\{\n\tOFFSET 1\.000000 -3\.000000 2\.000000\n\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation/);
    expect(text).toMatch(/Frames: 2\nFrame Time: 0\.041667/);
    // the export is in armature space (Z up): import it back with Z up and Y forward
    js(`bpy.ops.import_anim.bvh({ filepath: '/tmp/out.bvh', axis_forward: 'Y', axis_up: 'Z' })`);
    const ob2 = app.doc.objects[app.doc.scene.active_object!];
    expect(ob2.id).not.toBe(ob.id);
    const after = bonesAt(app.doc, ob2, 2);
    for (const name of Object.keys(before)) {
      expect(after[name].head).toEqual(before[name].head);
      expect(after[name].tail.map((v, i) => Math.abs(v - before[name].tail[i]) < 2e-3)).toEqual([true, true, true]);
    }
  });
});
