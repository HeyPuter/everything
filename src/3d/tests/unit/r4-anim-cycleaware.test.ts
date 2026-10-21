// @vitest-environment happy-dom
// Cycle-Aware Keying, compared with the reference: keys inserted from the interface on a curve
// repeated by a Cycles modifier land inside the cycle; a key on the cycle's start also sets its end.
// Script insertions (keyframe_insert) key the frame given.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import '../../src/ops/screen';
import type { ObjectData } from '../../src/data/types';
import { keyProperty } from '../../src/anim/keyframes';

let cube: ObjectData;
const keys = () => app.doc.actions[cube.animation_data!.action!].fcurves[0].keyframe_points.map((k) => [k.co[0], +k.co[1].toFixed(3)]);

beforeEach(() => {
  setApp(new App(startupDocument()));
  cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
  for (const o of Object.values(app.doc.objects)) o.select = o === cube;
  app.activeObject = cube;
  for (const [f, v] of [
    [1, 0],
    [11, 1],
    [21, 0],
  ]) {
    cube.location[0] = v;
    keyProperty(app.doc, cube, 'location', 0, f);
  }
  app.doc.actions[cube.animation_data!.action!].fcurves[0].modifiers.push({ type: 'CYCLES', mode_before: 'REPEAT', mode_after: 'REPEAT' });
  app.doc.scene.tool_settings.use_keyframe_cycle_aware = true;
});

const insertAt = (frame: number, v: number) => {
  app.doc.scene.frame_current = frame;
  cube.location[0] = v;
  expect(app.run('anim.keyframe_insert_by_name', { type: 'Location' }, { invoke: false })).toBe('FINISHED');
};

describe('Cycle-Aware Keying', () => {
  it('maps inserted keys into the cycle like the reference', () => {
    insertAt(35, 5);
    expect(keys()).toEqual([[1, 0], [11, 1], [15, 5], [21, 0]]);
    insertAt(41, 2);
    expect(keys()).toEqual([[1, 2], [11, 1], [15, 5], [21, 2]]);
    insertAt(-5, 3);
    expect(keys()).toEqual([[1, 2], [11, 1], [15, 3], [21, 2]]);
  });
  it('scripts and the option turned off key the frame given', () => {
    app.doc.scene.frame_current = 35;
    cube.location[0] = 5;
    keyProperty(app.doc, cube, 'location', 0);
    expect(keys().map((k) => k[0])).toEqual([1, 11, 21, 35]);
    app.doc.scene.tool_settings.use_keyframe_cycle_aware = false;
    insertAt(50, 7);
    expect(keys().map((k) => k[0])).toEqual([1, 11, 21, 35, 50]);
  });
});
