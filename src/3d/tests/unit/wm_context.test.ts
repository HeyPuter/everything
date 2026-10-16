// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { cycleItem, cycleInt, rotateArray, scaleValue, parseContextValue, enumLabel } from '../../src/ops/wm_context_core';
import { contextRef, contextObject, enumItemsOf } from '../../src/ops/wm_context';
import { applyPropertyEdit, convertValue, customPropMeta, editPropsFor, typeOf, uniquePropName } from '../../src/ui/customprops';
import { getValue, setValue } from '../../src/data/rna';
import { locateOwner, relDataPath, animTarget } from '../../src/ui/rnapath';

let doc: DocumentData;
let cube: ObjectData;

beforeEach(() => {
  doc = startupDocument();
  setApp(new App(doc));
  cube = Object.values(doc.objects).find((o) => o.type === 'MESH')!;
  doc.scene.active_object = cube.id;
});

describe('context value helpers', () => {
  it('cycles enum items with and without wrapping', () => {
    const items = ['A', 'B', 'C'];
    expect(cycleItem(items, 'A', false, false)).toBe('B');
    expect(cycleItem(items, 'C', false, false)).toBe('C');
    expect(cycleItem(items, 'C', false, true)).toBe('A');
    expect(cycleItem(items, 'A', true, true)).toBe('C');
    expect(cycleItem(items, 'X', false, true)).toBe('A');
    expect(cycleItem(items, 'X', true, true)).toBe('C');
  });
  it('steps integers within limits', () => {
    expect(cycleInt(4, false, false)).toBe(5);
    expect(cycleInt(4, true, false, 0, 10)).toBe(3);
    expect(cycleInt(10, false, false, 0, 10)).toBe(10);
    expect(cycleInt(10, false, true, 0, 10)).toBe(0);
    expect(cycleInt(0, true, true, 0, 10)).toBe(10);
  });
  it('rotates arrays and scales values', () => {
    expect(rotateArray([1, 2, 3], false)).toEqual([3, 1, 2]);
    expect(rotateArray([1, 2, 3], true)).toEqual([2, 3, 1]);
    expect(scaleValue(2, 1.5, false, false)).toBe(3);
    expect(scaleValue(2, 1.1, true, true)).toBe(3);
    expect(scaleValue(2, 1 / 1.1, true, true)).toBe(1);
    expect(scaleValue(10, 1.5, true, true)).toBe(15);
  });
  it('reads typed values from text', () => {
    expect(parseContextValue('True')).toBe(true);
    expect(parseContextValue('none')).toBeNull();
    expect(parseContextValue('2.5')).toBe(2.5);
    expect(parseContextValue("'SOLID'")).toBe('SOLID');
    expect(parseContextValue('(1, 2, [3, "a,b"])')).toEqual([1, 2, [3, 'a,b']]);
    expect(parseContextValue('[]')).toEqual([]);
    expect(parseContextValue('MATERIAL')).toBe('MATERIAL');
    expect(enumLabel('INVERSE_SQUARE')).toBe('Inverse Square');
  });
});

describe('context paths', () => {
  it('finds tool settings, object and object data values', () => {
    const r = contextRef('tool_settings.use_snap')!;
    expect(r.owner).toBe(doc.scene.tool_settings);
    expect(r.scope).toBe('doc');
    const loc = contextRef('object.location')!;
    expect(loc.owner).toBe(cube);
    expect(loc.key).toBe('location');
    expect(contextObject('object.data')).toBe(doc.meshes[cube.data!]);
    expect(contextObject('scene')).toBe(doc.scene);
    expect(contextRef('sculpt_object.location')).toBeNull();
    expect(contextRef('tool_settings.no_such_setting')).toBeNull();
    expect(enumItemsOf(contextRef('tool_settings.proportional_edit_falloff')!)!.map(([v]) => v)).toContain('INVERSE_SQUARE');
  });
});

describe('custom properties', () => {
  it('converts values between property types', () => {
    expect(convertValue(2.6, 'INT')).toBe(3);
    expect(convertValue(1, 'BOOL')).toBe(true);
    expect(convertValue(1.5, 'FLOAT_ARRAY', 3)).toEqual([1.5, 1.5, 1.5]);
    expect(convertValue([1, 2], 'INT_ARRAY', 4)).toEqual([1, 2, 2, 2]);
    expect(convertValue(3, 'STRING')).toBe('3');
    expect(typeOf([true, false])).toBe('BOOL_ARRAY');
    expect(typeOf(2, { type: 'INT' })).toBe('INT');
    expect(uniquePropName({ prop: 1, prop1: 2 })).toBe('prop2');
  });

  it('edits name, type, limits and default of a property', () => {
    const block = cube as unknown as Record<string, unknown>;
    cube.custom = { prop: 0.5 };
    const p = editPropsFor(block, 'prop', 'object');
    expect(p).toMatchObject({ property_type: 'FLOAT', value_float: 0.5, old_name: 'prop' });
    const name = applyPropertyEdit(block, { ...p, property_name: 'weight', property_type: 'INT', value_int: 7, min: 0, max: 5, default_value: 2 });
    expect(name).toBe('weight');
    expect(cube.custom).toEqual({ weight: 5 });
    expect(customPropMeta(block, 'weight')).toMatchObject({ type: 'INT', min: 0, max: 5, default: 2 });
    expect(customPropMeta(block, 'prop')).toEqual({});
    applyPropertyEdit(block, { ...editPropsFor(block, 'weight', 'object'), property_type: 'FLOAT_ARRAY', array_length: 2 });
    expect(cube.custom.weight).toEqual([5, 5]);
  });

  it('addresses custom properties as ["name"] in data paths, drivers and animation', () => {
    cube.custom = { amount: 2 };
    expect(getValue(doc, cube, '["amount"]')).toBe(2);
    setValue(doc, cube, '["amount"]', -1, 4);
    expect(cube.custom.amount).toBe(4);
    const loc = locateOwner(doc, cube.custom, 7)!;
    expect(relDataPath(loc, 'amount')).toBe('["amount"]');
    expect(animTarget(doc, loc, 'amount')).toEqual({ ob: cube, path: '["amount"]' });
    const me = doc.meshes[cube.data!] as unknown as { custom?: Record<string, unknown> };
    me.custom = { level: 1 };
    const ml = locateOwner(doc, me.custom, 8)!;
    expect(animTarget(doc, ml, 'level')).toEqual({ ob: cube, path: 'data["level"]' });
    expect(getValue(doc, cube, 'data["level"]')).toBe(1);
    expect(app.doc).toBe(doc);
  });
});

describe('number field expressions with units', () => {
  it('adds mixed units and converts to base units', async () => {
    const { parseNumber } = await import('../../src/ui/widgets');
    expect(parseNumber('1m+20cm', 'distance')).toBeCloseTo(1.2);
    expect(parseNumber('6ft 2in', 'distance')).toBeCloseTo(1.8796);
    expect(parseNumber('1e3mm', 'distance')).toBeCloseTo(1);
    expect(parseNumber('2*3', 'distance')).toBe(6);
    expect(parseNumber('45', 'angle')).toBeCloseTo(Math.PI / 4);
    expect(parseNumber('90°', 'angle')).toBeCloseTo(Math.PI / 2);
    expect(parseNumber('1.5rad', 'angle')).toBeCloseTo(1.5);
    expect(parseNumber('250ms', 'time')).toBeCloseTo(0.25);
    expect(parseNumber('3 s', 'time')).toBe(3);
    expect(parseNumber('5 px', 'pixel')).toBe(5);
    expect(parseNumber('100 W', 'power')).toBe(100);
    expect(parseNumber('50%', 'percentage')).toBe(50);
    expect(() => parseNumber('1d', 'none')).toThrow();
  });
});

describe('custom properties in files', () => {
  it('values and settings survive a .p3d round trip', async () => {
    const { encodeDocument, decodeDocument } = await import('../../src/io/native');
    const block = cube as unknown as Record<string, unknown>;
    cube.custom = { weight: 2 };
    applyPropertyEdit(block, { ...editPropsFor(block, 'weight', 'object'), property_type: 'INT', value_int: 3, min: 0, max: 9, default_value: 1, description: 'Count' });
    const me = doc.meshes[cube.data!] as unknown as Record<string, unknown>;
    me.custom = { level: 0.25 };
    const back = decodeDocument(encodeDocument(doc)).doc;
    const ob2 = back.objects[cube.id] as unknown as Record<string, unknown>;
    expect(ob2.custom).toEqual({ weight: 3 });
    expect(customPropMeta(ob2, 'weight')).toMatchObject({ type: 'INT', min: 0, max: 9, default: 1, description: 'Count' });
    expect((back.meshes[cube.data!] as unknown as Record<string, unknown>).custom).toEqual({ level: 0.25 });
  });
});
