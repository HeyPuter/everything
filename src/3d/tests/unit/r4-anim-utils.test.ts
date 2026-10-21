// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import type { ObjectData } from '../../src/data/types';
import { keyProperty, ensureFCurve, keyingTarget } from '../../src/anim/keyframes';
import { insertKeyframe } from '../../src/anim/fcurve';
import { applyAnimData } from '../../src/anim/evaluate';
import { keyingSetScript, updateTransformConstraintCurves } from '../../src/animation/animutils';
import { pythonAvailable, runPy } from './support/python';
import '../../src/ops/object';

let cube: ObjectData;
beforeEach(() => {
  setApp(new App(startupDocument()));
  cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
});

describe('disabled F-Curves', () => {
  it('a curve whose property is gone gets disabled, and revive clears it', () => {
    keyProperty(app.doc, cube, 'location', 0, 1);
    const { act, slot } = keyingTarget(app.doc, cube);
    const bad = ensureFCurve(act, 'modifiers["Gone"].levels', 0, slot);
    insertKeyframe(bad, 1, 2);
    applyAnimData(app.doc, cube, cube.animation_data!, 1);
    expect(bad.disabled).toBe(true);
    expect(act.fcurves[0].disabled).toBeUndefined();
    // a modifier with that name appears: the curve stays disabled until revived
    cube.modifiers.push({ id: 'm1', name: 'Gone', type: 'SUBSURF', levels: 1, show_viewport: true, show_render: true } as never);
    applyAnimData(app.doc, cube, cube.animation_data!, 1);
    expect((cube.modifiers[0] as unknown as { levels: number }).levels).toBe(1);
    expect(app.run('anim.channels_fcurves_enable')).toBe('FINISHED');
    expect(bad.disabled).toBeUndefined();
    applyAnimData(app.doc, cube, cube.animation_data!, 2);
    expect((cube.modifiers[0] as unknown as { levels: number }).levels).toBe(2);
  });
});

describe('keying set export', () => {
  it('writes a script that rebuilds the set', () => {
    const set = { name: 'My Set', paths: [{ id: cube.id, data_path: 'location', index: -1 }, { id: cube.id, data_path: 'scale', index: 2 }] };
    app.doc.scene.keying_sets = [set];
    app.doc.scene.keying_set = 'KS:My Set';
    const src = keyingSetScript(app.doc, set);
    expect(src).toContain('ks = scene.keying_sets.new(idname="My Set", name="My Set")');
    expect(src).toContain('ks.paths.add(bpy.data.objects["Cube"], "location", index=-1)');
    expect(src).toContain('ks.paths.add(bpy.data.objects["Cube"], "scale", index=2)');
    expect(app.run('anim.keying_set_export')).toBe('FINISHED');
    const text = Object.values(app.doc.texts).find((t) => t.name === 'My_Set.py')!;
    expect(text.language).toBe('python');
    expect(text.body).toBe(src);
  });

  let py = false;
  beforeAll(async () => {
    py = await pythonAvailable();
  }, 120000);
  it('the exported script runs and recreates the set', () => {
    if (!py) return;
    const set = { name: 'Again', paths: [{ id: cube.id, data_path: 'rotation_euler', index: 1 }] };
    const src = keyingSetScript(app.doc, set);
    runPy(src);
    const made = app.doc.scene.keying_sets!.find((k) => k.name === 'Again')!;
    expect(made.paths).toEqual([{ id: cube.id, data_path: 'rotation_euler', index: 1 }]);
  });
});

describe('transform constraint animation update', () => {
  it('moves range curves to the _rot properties and converts degrees', () => {
    cube.constraints.push({ id: 'c1', name: 'Transformation', type: 'TRANSFORM', mute: false, influence: 1, show_expanded: true, map_from: 'ROTATION', map_to: 'LOCATION' });
    const { act, slot } = keyingTarget(app.doc, cube);
    const fc = ensureFCurve(act, 'constraints["Transformation"].from_max_x', 0, slot);
    insertKeyframe(fc, 1, 90);
    const to = ensureFCurve(act, 'constraints["Transformation"].to_max_x', 0, slot);
    insertKeyframe(to, 1, 3);
    expect(updateTransformConstraintCurves(app.doc, true)).toBe(1);
    expect(fc.data_path).toBe('constraints["Transformation"].from_max_x_rot');
    expect(fc.keyframe_points[0].co[1]).toBeCloseTo(Math.PI / 2, 6);
    // map_to is LOCATION: unchanged
    expect(to.data_path).toBe('constraints["Transformation"].to_max_x');
  });
});

describe('sync markers and auto-merge', () => {
  it('selected markers move with transformed keys; auto-merge off keeps both keys', async () => {
    const { transformKeys } = await import('../../src/animation/transformkeys');
    const { insertKeyframe } = await import('../../src/anim/fcurve');
    const fc = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT' as const, modifiers: [] };
    insertKeyframe(fc, 1, 0);
    insertKeyframe(fc, 10, 1);
    fc.keyframe_points.forEach((k: { select_control_point?: boolean }, i: number) => (k.select_control_point = i === 0));
    const act = { id: 'a', name: 'A', fcurves: [fc] };
    const marker = { name: 'M', frame: 5, select: true };
    const host = {
      transformCurves: () => [{ ob: cube, action: act, fc }],
      graph: false,
      ppf: () => 10,
      ppv: () => 10,
      toDisp: (_f: unknown, v: number) => v,
      fromDisp: (_f: unknown, d: number) => d,
      screen: (x: number, d: number) => ({ x, y: d }),
      autoSnap: true,
      handlesVisible: () => true,
      autoMerge: false,
      syncMarkers: [marker],
    };
    transformKeys(host as never, { mode: 'TIME_TRANSLATE', value: [9, 0], constraint: 'NONE' } as never);
    expect(marker.frame).toBe(14);
    expect(fc.keyframe_points.map((k: { co: number[] }) => k.co[0])).toEqual([10, 10]);
  });
});

describe('NLA sound clips', () => {
  it('a speaker plays from its sound strip', async () => {
    const { addSoundStrip } = await import('../../src/animation/nlasound');
    const { newObject } = await import('../../src/data/defaults');
    const { defaultSpeaker } = await import('../../src/object/speakerdata');
    const sp = newObject('Speaker', 'SPEAKER' as never, null);
    sp.speaker = { ...defaultSpeaker(), sound: { filepath: 'beep.wav', mime: 'audio/wav', bytes: new Uint8Array(4) } as never };
    app.doc.objects[sp.id] = sp;
    const strip = addSoundStrip(sp, 24, 48);
    expect(strip.type).toBe('SOUND');
    expect([strip.frame_start, strip.frame_end]).toEqual([24, 72]);
    expect(sp.animation_data!.nla_tracks[0].name).toBe('SoundTrack');
    applyAnimData(app.doc, sp, sp.animation_data!, 1);
    expect(sp.speaker!.frame_start).toBe(24);
    strip.frame_start = 30;
    applyAnimData(app.doc, sp, sp.animation_data!, 1);
    expect(sp.speaker!.frame_start).toBe(30);
  });
});
