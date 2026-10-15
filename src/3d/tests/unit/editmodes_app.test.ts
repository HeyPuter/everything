// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { encodeDocument, decodeDocument } from '../../src/io/native';
import { bpy } from '../../src/scripting/api';
import { inScript } from '../../src/scripting/runner';
import '../../src/modes/index';
import type { ArmatureData, CurveData } from '../../src/data/types';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const B = bpy as Any;

beforeEach(() => {
  setApp(new App(startupDocument()));
});

const arm = () => app.doc.armatures[app.activeObject!.data!] as ArmatureData;

describe('armature edit operators in the app', () => {
  it('fills and splits in Edit Mode', () => {
    app.run('object.select_all', { action: 'DESELECT' });
    app.run('object.armature_add');
    app.run('object.mode_set', { mode: 'EDIT' });
    expect(app.doc.mode).toBe('EDIT');
    const b = arm().bones[0];
    b.select = b.select_head = false;
    b.select_tail = true;
    app.run('armature.fill', {}, { invoke: false });
    expect(arm().bones.length).toBe(2);
    expect(arm().bones[1].collections).toEqual(['Bones']);
    app.run('armature.select_all', { action: 'SELECT' });
    app.run('armature.split');
    expect(arm().bones.every((x) => !x.parent)).toBe(true);
  });

  it('bone collections through the scripting API', () => {
    app.run('object.armature_add');
    const data = B.data.armatures[arm().name];
    inScript('Run Script', () => {
      const c = data.collections.new('Deform');
      c.assign(data.bones[0]);
    });
    expect(arm().collections!.map((c) => c.name)).toEqual(['Bones', 'Deform']);
    expect(arm().bones[0].collections).toEqual(['Bones', 'Deform']);
    expect(data.collections.active_name).toBe('Deform');
    expect([...data.collections].length).toBe(2);
    inScript('Run Script', () => data.collections.remove(data.collections['Bones']));
    expect(arm().bones[0].collections).toEqual(['Deform']);
  });

  it('bone collections and text formats survive save / load', () => {
    app.run('object.armature_add');
    arm().collections![0].is_visible = false;
    app.run('object.text_add');
    const cu = app.doc.curves[app.activeObject!.data!] as CurveData;
    cu.body_format = [{ use_bold: true }, {}, {}, { use_underline: true, kerning: 2 }];
    cu.text_boxes = [{ x: 0, y: 0, width: 3, height: 1 }];
    const { doc } = decodeDocument(encodeDocument(app.doc));
    const a = Object.values(doc.armatures).find((x) => x.collections?.length)!;
    expect(a.collections![0]).toEqual({ name: 'Bones', is_visible: false });
    const t = Object.values(doc.curves).find((x) => x.body === 'Text')!;
    expect(t.body_format![3]).toEqual({ use_underline: true, kerning: 2 });
    expect(t.text_boxes).toEqual([{ x: 0, y: 0, width: 3, height: 1 }]);
  });
});

describe('curve edit operators in the app', () => {
  it('split, separate and radius through operators', () => {
    app.run('curve.primitive_bezier_circle_add');
    app.run('object.mode_set', { mode: 'EDIT' });
    const cu = () => app.doc.curves[app.activeObject!.data!] as CurveData;
    app.run('curve.select_all', { action: 'SELECT' });
    app.run('curve.subdivide', { number_cuts: 1 });
    expect(cu().splines[0].bezier_points.length).toBe(8);
    app.run('curve.select_all', { action: 'DESELECT' });
    for (const i of [1, 2, 3]) {
      const b = cu().splines[0].bezier_points[i];
      b.select_control_point = b.select_left_handle = b.select_right_handle = true;
    }
    app.run('curve.radius_set', { radius: 2 });
    expect(cu().splines[0].bezier_points[2].radius).toBe(2);
    app.run('curve.separate');
    expect(cu().splines[0].bezier_points.length).toBe(7);
    expect(Object.values(app.doc.objects).filter((o) => o.type === 'CURVE').length).toBe(2);
    app.run('transform.tilt', { value: 0.5 }, { invoke: false });
  });
});
