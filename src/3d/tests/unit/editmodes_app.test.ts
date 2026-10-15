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

import { readFileSync } from 'node:fs';
import { layoutText, parseFontBytes } from '../../src/io/fonts';

describe('custom fonts', () => {
  it('a packed font file is used for layout and survives save / load', () => {
    app.run('object.text_add');
    const ob = app.activeObject!;
    const cu = app.doc.curves[ob.data!] as CurveData;
    const raw = readFileSync('node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff');
    const bytes = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    expect(parseFontBytes(bytes)).toBeTruthy();
    expect(parseFontBytes(new Uint8Array([1, 2, 3]))).toBe(null);
    app.doc.fonts = { vf1: { id: 'vf1', name: 'Mono', filepath: 'mono.woff', bytes } };
    cu.font = 'vf1';
    // built-in fonts are not loaded in tests: the custom font alone lays out the text
    const l = layoutText(cu);
    expect(l.splines.length).toBeGreaterThan(3);
    const { doc } = decodeDocument(encodeDocument(app.doc));
    expect(doc.fonts!.vf1.bytes!.length).toBe(bytes.length);
    expect((doc.curves[ob.data!] as CurveData).font).toBe('vf1');
  });
});

describe('join curves and armatures', () => {
  it('joins curve splines into the active curve, in place', () => {
    app.run('object.select_all', { action: 'DESELECT' });
    app.run('curve.primitive_bezier_curve_add', { location: [0, 0, 0] });
    const a = app.activeObject!;
    app.run('curve.primitive_bezier_circle_add', { location: [5, 0, 0] });
    const b = app.activeObject!;
    a.select = b.select = true;
    app.doc.scene.active_object = a.id;
    app.graph.evaluate(app.doc);
    expect(app.run('object.join')).toBe('FINISHED');
    expect(app.doc.objects[b.id]).toBeUndefined();
    const cu = app.doc.curves[a.data!];
    expect(cu.splines.length).toBe(2);
    // circle points moved by the object offset
    const xs = cu.splines[1].bezier_points.map((p) => p.co[0]);
    expect(Math.min(...xs)).toBeGreaterThan(3);
  });

  it('joins armatures, renaming clashing bones and keeping collections', () => {
    app.run('object.select_all', { action: 'DESELECT' });
    app.run('object.armature_add', { location: [0, 0, 0] });
    const a = app.activeObject!;
    app.run('object.armature_add', { location: [2, 0, 0] });
    const b = app.activeObject!;
    a.select = b.select = true;
    app.doc.scene.active_object = a.id;
    app.graph.evaluate(app.doc);
    expect(app.run('object.join')).toBe('FINISHED');
    const arm = app.doc.armatures[a.data!];
    expect(arm.bones.map((x) => x.name)).toEqual(['Bone', 'Bone.001']);
    expect(arm.bones[1].head.map((v) => +v.toFixed(4))).toEqual([2, 0, 0]);
    expect(arm.bones[1].collections).toEqual(['Bones']);
    expect(arm.collections!.length).toBe(1);
    expect(Object.keys(a.pose!)).toEqual(['Bone', 'Bone.001']);
  });
});

import { boneRestMatrix } from '../../src/eval/armature';
import { Vector3 as V3, Matrix4 as M4 } from 'three';
import * as transformMod from '../../src/ops/transform';

describe('join keeps bone orientation', () => {
  it('rotated armatures keep their bones\' roll in world space', () => {
    app.run('object.select_all', { action: 'DESELECT' });
    app.run('object.armature_add', { location: [0, 0, 0] });
    const a = app.activeObject!;
    app.run('object.armature_add', { location: [0, 0, 0], rotation: [0.3, 0.7, 1.1] });
    const b = app.activeObject!;
    app.doc.armatures[b.data!].bones[0].roll = 0.4;
    app.graph.evaluate(app.doc);
    const before = app.graph.get(b.id)!.world.clone().multiply(boneRestMatrix(app.doc.armatures[b.data!].bones[0]));
    a.select = b.select = true;
    app.doc.scene.active_object = a.id;
    app.run('object.join');
    app.graph.evaluate(app.doc);
    const after = app.graph.get(a.id)!.world.clone().multiply(boneRestMatrix(app.doc.armatures[a.data!].bones[1]));
    for (let c = 0; c < 3; c++) {
      const x = new V3().setFromMatrixColumn(before, c).normalize(),
        y = new V3().setFromMatrixColumn(after, c).normalize();
      expect(x.distanceTo(y)).toBeLessThan(1e-4);
    }
  });
});

describe('select pattern for bones', () => {
  it('matches bone names in armature Edit Mode', () => {
    app.run('object.select_all', { action: 'DESELECT' });
    app.run('object.armature_add');
    app.run('object.mode_set', { mode: 'EDIT' });
    const a = app.doc.armatures[app.activeObject!.data!];
    a.bones[0].name = 'Arm.L';
    app.run('armature.select_all', { action: 'DESELECT' });
    app.run('object.select_pattern', { pattern: '*.l', extend: false }, { invoke: false });
    expect(a.bones[0].select).toBe(true);
    app.run('object.select_pattern', { pattern: 'Leg*', extend: false }, { invoke: false });
    expect(a.bones[0].select).toBe(false);
  });
});

describe('cursor snapping in curve Edit Mode', () => {
  it('Cursor to Selected uses the selected control points', () => {
    app.run('object.select_all', { action: 'DESELECT' });
    app.run('curve.primitive_bezier_curve_add', { location: [3, 0, 0] });
    app.run('object.mode_set', { mode: 'EDIT' });
    app.graph.evaluate(app.doc);
    const cu = app.doc.curves[app.activeObject!.data!];
    app.run('curve.select_all', { action: 'DESELECT' });
    const b = cu.splines[0].bezier_points[1];
    b.select_control_point = b.select_left_handle = b.select_right_handle = true;
    app.run('view3d.snap_cursor_to_selected');
    expect(app.doc.scene.cursor.location.map((v) => +v.toFixed(4))).toEqual([3 + b.co[0], b.co[1], b.co[2]]);
  });
});

describe('individual origins for bones', () => {
  it('scales separate bones around their own heads', () => {
    app.run('object.select_all', { action: 'DESELECT' });
    app.run('object.armature_add');
    app.run('object.mode_set', { mode: 'EDIT' });
    const arm = app.doc.armatures[app.activeObject!.data!];
    app.run('armature.select_all', { action: 'SELECT' });
    app.run('armature.duplicate_move', {}, { invoke: true });
    app.endModal?.('CANCELLED');
    arm.bones[1].head = [2, 0, 0];
    arm.bones[1].tail = [2, 0, 1];
    for (const b of arm.bones) b.select = b.select_head = b.select_tail = true;
    app.doc.scene.tool_settings.transform_pivot_point = 'INDIVIDUAL_ORIGINS';
    app.graph.evaluate(app.doc);
    const { transformProviders } = transformMod;
    let data = null as ReturnType<(typeof transformProviders)[number]['collect']>;
    for (let i = transformProviders.length - 1; i >= 0 && !data; i--) data = transformProviders[i].collect({ proportional: false, connected: false, individual: true });
    expect(data!.elements.length).toBe(2);
    const S = new M4().makeScale(2, 2, 2);
    for (const e of data!.elements) e.apply(new M4().makeTranslation(e.center.x, e.center.y, e.center.z).multiply(S).multiply(new M4().makeTranslation(-e.center.x, -e.center.y, -e.center.z)), { mode: 'RESIZE', value: [2, 2, 2] });
    expect(arm.bones[0].tail.map((v) => +v.toFixed(4))).toEqual([0, 0, 2]);
    expect(arm.bones[1].head.map((v) => +v.toFixed(4))).toEqual([2, 0, 0]);
    expect(arm.bones[1].tail.map((v) => +v.toFixed(4))).toEqual([2, 0, 2]);
  });
});

describe('B-Bone size', () => {
  it('scales the B-Bone display size of selected bones', () => {
    app.run('object.select_all', { action: 'DESELECT' });
    app.run('object.armature_add');
    app.run('object.mode_set', { mode: 'EDIT' });
    const b = app.doc.armatures[app.activeObject!.data!].bones[0];
    app.run('armature.select_all', { action: 'SELECT' });
    app.run('transform.bbone_resize', { value: 2 }, { invoke: false });
    expect(b.bbone_x).toBeCloseTo(0.2, 6);
    expect(b.bbone_z).toBeCloseTo(0.2, 6);
  });
});
