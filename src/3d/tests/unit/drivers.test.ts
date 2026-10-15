import { describe, it, expect, beforeEach } from 'vitest';
import { emptyDocument, newObject } from '../../src/data/defaults';
import type { DocumentData, Driver, DriverTarget, DriverVariable, FCurve, ObjectData } from '../../src/data/types';
import { compileExpr, runExpr, exprErrorText } from '../../src/anim/driverexpr';
import { evaluateDriver, runDriver, variableValue, variableNameError, driverCurveValue, parseExpression, evalExpression } from '../../src/anim/drivers';
import { Depsgraph } from '../../src/eval/depsgraph';
import { insertKeyframe } from '../../src/anim/fcurve';

const ev = (src: string, vars: Record<string, number> = {}) => runExpr(compileExpr(src), { vars });

describe('driver expressions', () => {
  it('follows Python precedence and operators', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('-2 ** 2')).toBe(-4);
    expect(ev('2 ** -1')).toBe(0.5);
    expect(ev('2 ** 3 ** 2')).toBe(512);
    expect(ev('7 // 2')).toBe(3);
    expect(ev('-7 // 2')).toBe(-4);
    expect(ev('-7 % 3')).toBe(2);
    expect(ev('7 % -3')).toBe(-2);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('1_000 + 0x10 + 1e1 + .5')).toBe(1026.5);
    expect(ev('6 & 3 | 8 ^ 1')).toBe(11);
    expect(ev('1 << 4 >> 2')).toBe(4);
    expect(ev('~5')).toBe(-6);
  });

  it('handles comparisons, booleans and conditionals', () => {
    expect(ev('1 < 2 < 3')).toBe(1);
    expect(ev('1 < 3 < 2')).toBe(0);
    expect(ev('x if x > 0 else -x', { x: -4 })).toBe(4);
    expect(ev('0 or 5')).toBe(5);
    expect(ev('2 and 3')).toBe(3);
    expect(ev('not 0')).toBe(1);
    expect(ev('True + True')).toBe(2);
    expect(ev('1 == 1.0')).toBe(1);
    expect(ev('a != b', { a: 1, b: 2 })).toBe(1);
  });

  it('provides math functions, constants and the frame', () => {
    expect(ev('sin(pi / 2)')).toBeCloseTo(1);
    expect(ev('math.cos(0) + math.pi')).toBeCloseTo(1 + Math.PI);
    expect(ev('max(1, 5, 3) + min([4, 2])')).toBe(7);
    expect(ev('round(2.5) + round(3.5) + round(1.2345, 2)')).toBeCloseTo(6 + 1.23);
    expect(ev('clamp(1.5) + clamp(-3, -1, 1) + lerp(0, 10, 0.25)')).toBe(2.5);
    expect(ev('smoothstep(0, 1, 0.5)')).toBeCloseTo(0.5);
    expect(ev('int(3.9) + abs(-2) + float(1)')).toBe(6);
    expect(ev('degrees(radians(90))')).toBeCloseTo(90);
    expect(ev('hypot(3, 4) + sqrt(16) + log(e) + log10(100)')).toBeCloseTo(12);
    expect(ev('frame / 10', { frame: 25 })).toBe(2.5);
    expect(ev('sum((1, 2, 3)) + len([1, 2])')).toBe(8);
  });

  it('reports errors in Python terms', () => {
    const msg = (src: string, vars: Record<string, number> = {}) => {
      try {
        ev(src, vars);
        return '';
      } catch (e) {
        return exprErrorText(e);
      }
    };
    expect(msg('1 +')).toMatch(/^SyntaxError/);
    expect(msg('foo + 1')).toBe("NameError: name 'foo' is not defined");
    expect(msg('1 / 0')).toMatch(/^ZeroDivisionError/);
    expect(msg('sqrt(-1)')).toBe('ValueError: math domain error');
    expect(msg('__import__("os")')).toMatch(/NameError/);
    expect(msg('import os')).toMatch(/SyntaxError/);
    expect(msg('self.location[0]')).toMatch(/self/);
  });

  it('marks expressions without data access as simple', () => {
    expect(compileExpr('var * 2 + sin(frame)').simple).toBe(true);
    expect(compileExpr('self.location.x').simple).toBe(false);
    expect([...compileExpr('a + b * frame').names].sort()).toEqual(['a', 'b', 'frame']);
  });

  it('keeps the number-field helpers working', () => {
    expect(evalExpression(parseExpression('2*pi/4'), {})).toBeCloseTo(Math.PI / 2);
  });
});

describe('driver variables', () => {
  let doc: DocumentData;
  let P: ObjectData, C: ObjectData, D: ObjectData, O: ObjectData;
  const add = (o: ObjectData) => {
    doc.objects[o.id] = o;
    doc.object_order.push(o.id);
    return o;
  };
  const tx = (id: string, extra: Partial<DriverTarget> = {}): DriverTarget => ({ id, data_path: '', ...extra });
  const graphCtx = () => {
    const g = new Depsgraph(doc).evaluate(doc);
    return {
      world: (id: string) => g.get(id)?.world,
      basis: (id: string) => g.get(id)?.worldBasis,
    };
  };

  beforeEach(() => {
    doc = emptyDocument();
    P = add(newObject('P', 'EMPTY', null));
    P.location = [1, 2, 3];
    P.rotation_euler = [0.3, 0, 0.5];
    P.scale = [2, 2, 2];
    C = add(newObject('C', 'EMPTY', null));
    C.parent = P.id;
    C.location = [0.5, -1, 2];
    C.rotation_euler = [0.4, -0.7, 4.0];
    C.scale = [1, 2, 3];
    D = add(newObject('D', 'EMPTY', null));
    D.location = [4, 0, -1];
    O = add(newObject('O', 'EMPTY', null));
  });

  const chan = (space: DriverTarget['transform_space'], rotation_mode: string, transform_type: string) =>
    variableValue(doc, { name: 'v', type: 'TRANSFORMS', targets: [tx(C.id, { transform_space: space, rotation_mode, transform_type })] }, graphCtx());

  it('reads transform channels in world space', () => {
    const types = ['LOC_X', 'LOC_Y', 'LOC_Z', 'ROT_X', 'ROT_Y', 'ROT_Z', 'ROT_W', 'SCALE_X', 'SCALE_Y', 'SCALE_Z', 'SCALE_AVG'];
    const auto = types.map((t) => chan('WORLD_SPACE', 'AUTO', t));
    const expected = [3.36033, -0.23472, 6.23031, 0.18267, -0.46049, 4.62034, 0, 2, 4, 6, 3.63424];
    auto.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 3));
    // an explicit Euler order decomposes without following the object's own angles
    expect(chan('WORLD_SPACE', 'XYZ', 'ROT_Z')).toBeCloseTo(-1.66285, 3);
    const zyx = ['ROT_X', 'ROT_Y', 'ROT_Z'].map((t) => chan('WORLD_SPACE', 'ZYX', t));
    [-0.47393, -0.14118, -1.65407].forEach((x, i) => expect(zyx[i]).toBeCloseTo(x, 3));
    const quat = ['ROT_W', 'ROT_X', 'ROT_Y', 'ROT_Z'].map((t) => chan('WORLD_SPACE', 'QUATERNION', t));
    [0.66869, -0.10809, -0.21875, -0.70237].forEach((x, i) => expect(quat[i]).toBeCloseTo(x, 3));
  });

  it('reads local and transform space channels', () => {
    expect(chan('LOCAL_SPACE', 'AUTO', 'ROT_Z')).toBeCloseTo(4.0); // raw angle beyond 180°
    expect(chan('LOCAL_SPACE', 'XYZ', 'ROT_Z')).toBeCloseTo(-2.28319, 3);
    expect(chan('TRANSFORM_SPACE', 'AUTO', 'LOC_X')).toBeCloseTo(0.5);
    expect(chan('TRANSFORM_SPACE', 'AUTO', 'ROT_Z')).toBeCloseTo(4.0);
    expect(chan('LOCAL_SPACE', 'AUTO', 'SCALE_AVG')).toBeCloseTo(1.81712, 4);
    const q = ['ROT_W', 'ROT_X', 'ROT_Y', 'ROT_Z'].map((t) => chan('LOCAL_SPACE', 'QUATERNION', t));
    [0.44507, -0.22792, -0.30955, -0.80879].forEach((x, i) => expect(q[i]).toBeCloseTo(x, 3));
    // swing + twist: the twist angle around the axis and the swing angle
    expect(chan('LOCAL_SPACE', 'SWING_TWIST_X', 'ROT_X')).toBeCloseTo(-0.94655, 3);
    expect(chan('LOCAL_SPACE', 'SWING_TWIST_X', 'ROT_W')).toBeCloseTo(2.09432, 3);
    expect(chan('LOCAL_SPACE', 'SWING_TWIST_Z', 'ROT_Z')).toBeCloseTo(-2.13546, 3);
  });

  it('measures distances and rotational differences', () => {
    const ctx = graphCtx();
    const dist = (space: DriverTarget['transform_space']) =>
      variableValue(doc, { name: 'd', type: 'LOC_DIFF', targets: [tx(C.id, { transform_space: space }), tx(D.id)] }, ctx);
    expect(dist('WORLD_SPACE')).toBeCloseTo(7.26234, 4);
    expect(dist('LOCAL_SPACE')).toBeCloseTo(4.71699, 4);
    D.rotation_mode = 'QUATERNION';
    D.rotation_quaternion = [0.8, 0.2, 0.4, 0.1];
    const r = variableValue(doc, { name: 'r', type: 'ROTATION_DIFF', targets: [tx(C.id), tx(D.id)] }, graphCtx());
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(Math.PI);
  });

  it('reads properties of other data-blocks, the context and fallbacks', () => {
    doc.scene.frame_end = 250;
    expect(variableValue(doc, { name: 's', type: 'SINGLE_PROP', targets: [{ id: 'scene', id_type: 'SCENE', data_path: 'frame_end' }] })).toBe(250);
    expect(variableValue(doc, { name: 'c', type: 'CONTEXT_PROP', targets: [{ id: null, context_property: 'ACTIVE_SCENE', data_path: 'render.fps' }] })).toBe(doc.scene.render.fps);
    expect(variableValue(doc, { name: 'p', type: 'SINGLE_PROP', targets: [{ id: C.id, data_path: 'location[2]' }] })).toBe(2);
    const missing: DriverVariable = { name: 'm', type: 'SINGLE_PROP', targets: [{ id: C.id, data_path: 'nothing_here' }] };
    expect(() => variableValue(doc, missing)).toThrow(/not found/);
    missing.targets[0].use_fallback_value = true;
    missing.targets[0].fallback_value = 7;
    expect(variableValue(doc, missing)).toBe(7);
    expect(() => variableValue(doc, { name: 'n', type: 'SINGLE_PROP', targets: [{ id: null, data_path: 'location[0]' }] })).toThrow(/no data-block/);
  });

  it('validates variable names', () => {
    expect(variableNameError('var')).toBeNull();
    expect(variableNameError('var_001')).toBeNull();
    expect(variableNameError('1abc')).toMatch(/number/);
    expect(variableNameError('_x')).toMatch(/underscore/);
    expect(variableNameError('a b')).toMatch(/space/);
    expect(variableNameError('a.b')).toMatch(/dot/);
    expect(variableNameError('a-b')).toMatch(/special/);
    expect(variableNameError('lambda')).toMatch(/reserved/);
  });
});

describe('drivers', () => {
  let doc: DocumentData;
  let A: ObjectData, B: ObjectData;
  beforeEach(() => {
    doc = emptyDocument();
    A = newObject('A', 'EMPTY', null);
    B = newObject('B', 'EMPTY', null);
    // B comes first in the list but reads A: evaluation must still see A's driven/animated state
    for (const o of [B, A]) {
      doc.objects[o.id] = o;
      doc.object_order.push(o.id);
    }
  });

  const drv = (over: Partial<Driver> = {}): Driver => ({
    data_path: 'location',
    array_index: 2,
    type: 'SCRIPTED',
    expression: 'var * 2',
    variables: [{ name: 'var', type: 'TRANSFORMS', targets: [{ id: A.id, data_path: '', transform_type: 'LOC_X', transform_space: 'WORLD_SPACE' }] }],
    ...over,
  });

  it('combines variables by driver type', () => {
    const vars: DriverVariable[] = [1, 4, 7].map((x, i) => ({ name: `v${i}`, type: 'SINGLE_PROP', targets: [{ id: A.id, data_path: `location[${i}]` }] }));
    A.location = [1, 4, 7];
    const run = (type: Driver['type']) => evaluateDriver(doc, B, drv({ type, variables: vars }), 1);
    expect(run('AVERAGE')).toBe(4);
    expect(run('SUM')).toBe(12);
    expect(run('MIN')).toBe(1);
    expect(run('MAX')).toBe(7);
  });

  it('drives properties during evaluation in dependency order', () => {
    B.animation_data = { action: null, nla_tracks: [], drivers: [drv()] };
    A.location = [1.5, 0, 0];
    const g = new Depsgraph(doc).evaluate(doc);
    expect(B.location[2]).toBe(3);
    expect(g.get(B.id)!.world.elements[14]).toBe(3);
    // A parented under a moved empty: the driver reads its world position
    const P = newObject('P', 'EMPTY', null);
    P.location = [10, 0, 0];
    doc.objects[P.id] = P;
    doc.object_order.unshift(P.id);
    A.parent = P.id;
    g.evaluate(doc);
    expect(B.location[2]).toBe(23);
  });

  it('follows the frame and uses self when allowed', () => {
    B.location = [2, 0, 0];
    const d = drv({ array_index: 1, expression: 'frame / 10 + self.location.x', use_self: true, variables: [] });
    B.animation_data = { action: null, nla_tracks: [], drivers: [d] };
    doc.scene.frame_current = 30;
    new Depsgraph(doc).evaluate(doc);
    expect(B.location[1]).toBeCloseTo(5);
    d.use_self = false;
    expect(runDriver(doc, B, d, 30).error).toMatch(/self/);
  });

  it('maps the value through the driver F-Curve', () => {
    const fc: FCurve = { data_path: 'location', array_index: 2, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [] };
    expect(driverCurveValue(fc, 3)).toBe(3); // nothing: pass through
    fc.modifiers.push({ type: 'GENERATOR', coefficients: [1, 2] });
    expect(driverCurveValue(fc, 3)).toBe(7); // 1 + 2x
    fc.modifiers.length = 0;
    insertKeyframe(fc, 0, 0);
    insertKeyframe(fc, 1, 10);
    fc.keyframe_points.forEach((k) => (k.interpolation = 'LINEAR'));
    expect(driverCurveValue(fc, 0.5)).toBeCloseTo(5);
    A.location = [0.25, 0, 0];
    expect(evaluateDriver(doc, B, drv({ expression: 'var', fcurve: fc }), 1)).toBeCloseTo(2.5);
  });

  it('reports errors and leaves the property alone', () => {
    B.location = [0, 0, 9];
    const d = drv({ expression: 'var +' });
    B.animation_data = { action: null, nla_tracks: [], drivers: [d] };
    new Depsgraph(doc).evaluate(doc);
    expect(B.location[2]).toBe(9);
    expect(runDriver(doc, B, d, 1).error).toMatch(/SyntaxError/);
    d.expression = 'var';
    d.variables[0].targets[0].id = null;
    expect(runDriver(doc, B, d, 1).error).toMatch(/Variable 'var'/);
    // muted driver curves disable the driver
    d.variables[0].targets[0].id = A.id;
    A.location = [4, 0, 0];
    d.fcurve = { data_path: 'location', array_index: 2, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], mute: true };
    new Depsgraph(doc).evaluate(doc);
    expect(B.location[2]).toBe(9);
  });
});
