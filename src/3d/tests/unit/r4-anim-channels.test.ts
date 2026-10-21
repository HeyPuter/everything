// @vitest-environment happy-dom
// Graph Editor pins: with Only Show Selected, a pinned object stays listed while unselected and a
// pinned group stays listed while its bone is unselected (as observed in the reference app; the
// Dope Sheet ignores pins).
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import '../../src/ops/modes';
import '../../src/modes/index';
import type { ObjectData } from '../../src/data/types';
import { keyProperty } from '../../src/anim/keyframes';
import { buildChannels, type ChannelFilter } from '../../src/animation/channels';
import { pythonAvailable, runPy } from './support/python';

const filter = (): ChannelFilter => ({ onlySelected: true, showHidden: false, search: '', isVisible: () => true, activeObject: app.activeObject });
let cube: ObjectData;

beforeEach(() => {
  setApp(new App(startupDocument()));
  cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
  keyProperty(app.doc, cube, 'location', 0, 1);
});

describe('channel pins', () => {
  it('a pinned object stays listed in the Graph Editor while unselected', () => {
    cube.select = false;
    expect(buildChannels(app.doc, 'GRAPH', filter()).curves.length).toBe(0);
    cube.animation_data!.use_pin = true;
    expect(buildChannels(app.doc, 'GRAPH', filter()).curves.length).toBe(1);
    expect(buildChannels(app.doc, 'DOPESHEET', filter()).curves.length).toBe(0);
  });
  it('a pinned group stays listed while its bone is unselected', () => {
    app.run('object.armature_add');
    const arm = app.activeObject!;
    app.run('object.mode_set', { mode: 'POSE' });
    keyProperty(app.doc, arm, 'pose.bones["Bone"].location', 0, 1);
    const act = app.doc.actions[arm.animation_data!.action!];
    const group = act.fcurves[0].group!;
    expect(group).toBe('Bone');
    arm.pose!['Bone'].select = false;
    const armCurves = () => buildChannels(app.doc, 'GRAPH', filter()).curves.filter((r) => r.ob === arm).length;
    expect(armCurves()).toBe(0);
    act.pinned_groups = [group];
    expect(armCurves()).toBe(1);
  });
});

describe('pins from scripts', () => {
  let py = false;
  beforeAll(async () => {
    py = await pythonAvailable();
  }, 120000);
  it('animation_data.use_pin and group use_pin', () => {
    if (!py) return;
    runPy(`import bpy
ob = bpy.data.objects["Cube"]
ob.animation_data.use_pin = True
cb = ob.animation_data.action.layers[0].strips[0].channelbags[0]
g = cb.groups.new("Extra")
cb.fcurves[0].group = g
g.use_pin = True
assert cb.groups["Extra"].use_pin
`);
    expect(cube.animation_data!.use_pin).toBe(true);
    expect(app.doc.actions[cube.animation_data!.action!].pinned_groups).toEqual(['Extra']);
  });
});

