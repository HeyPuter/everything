// Drivers read from a .blend file (tests/fixtures/blend/make_drivers.py): variable types, bone
// targets, spaces, rotation modes, fallback values and the driver F-Curves (keys, modifiers)
// convert, and the scene evaluates to the values the file was saved with.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBlend } from '../../src/io/blend/convert';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { Depsgraph } from '../../src/eval/depsgraph';

let doc: DocumentData;
let ob: ObjectData;

beforeAll(async () => {
  const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/blend/drivers_zstd.blend')));
  doc = (await readBlend(bytes)).doc;
  ob = Object.values(doc.objects).find((o) => o.name === 'Driven')!;
});

describe('drivers from .blend files', () => {
  it('convert variables, targets and driver curves', () => {
    const ds = ob.animation_data!.drivers;
    const at = (path: string, i: number) => ds.find((d) => d.data_path === path && d.array_index === i)!;
    const bone = at('rotation_euler', 2).variables[0].targets[0];
    expect(bone.bone_target).toBe('Bone');
    expect(bone.transform_space).toBe('TRANSFORM_SPACE');
    expect(bone.rotation_mode).toBe('QUATERNION');
    expect(bone.transform_type).toBe('ROT_Y');
    expect(at('rotation_euler', 2).fcurve!.modifiers).toEqual([expect.objectContaining({ type: 'GENERATOR', coefficients: [1, 3] })]);
    const ctxVar = at('location', 0).variables[0];
    expect(ctxVar.type).toBe('CONTEXT_PROP');
    expect(ctxVar.targets[0]).toMatchObject({ context_property: 'ACTIVE_SCENE', data_path: 'frame_end' });
    expect(at('location', 0).fcurve!.keyframe_points.map((k) => k.co)).toEqual([
      [0, 0],
      [2, 10],
    ]);
    const s = at('scale', 1);
    expect(s.use_self).toBe(true);
    expect(s.variables.map((v) => v.targets[0].transform_type ?? '')).toEqual(['ROT_W', 'SCALE_AVG', '']);
    expect(s.variables.map((v) => v.targets[0].transform_space)).toEqual(['WORLD_SPACE', 'WORLD_SPACE', 'LOCAL_SPACE']);
    expect(s.variables[2].targets[0]).toMatchObject({ use_fallback_value: true, fallback_value: 0.25 });
  });

  it('evaluate to the saved results', () => {
    doc.scene.frame_current = 3;
    new Depsgraph(doc).evaluate(doc);
    expect(ob.location[0]).toBeCloseTo(6, 4);
    expect(ob.location[1]).toBeCloseTo(2.41091, 4);
    expect(ob.location[2]).toBeCloseTo(6, 4);
    expect(ob.scale[0]).toBeCloseTo(-2, 4);
    expect(ob.scale[1]).toBeCloseTo(2.40430, 4);
    expect(ob.rotation_euler[2]).toBeCloseTo(1.88656, 4);
  });
});
