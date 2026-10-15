// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { locateOwner, fullDataPath, relDataPath, animTarget } from '../../src/ui/rnapath';
import { defaultValue, pasteButtonValue } from '../../src/ui/buttons';
import { visibleIndices } from '../../src/editors/properties/uilist';
import type { PropBinding } from '../../src/ui/binding';
import { newModifier } from '../../src/eval/modifiers';

let doc: DocumentData;
let cube: ObjectData;

const bind = (owner: object, key: string, extra: Partial<PropBinding> = {}): PropBinding => ({ id: 'x', owner: owner as Record<string, unknown>, key, label: key, kind: 'number', ...extra });

beforeEach(() => {
  doc = startupDocument();
  setApp(new App(doc));
  cube = Object.values(doc.objects).find((o) => o.type === 'MESH')!;
});

describe('property data paths', () => {
  it('locates owners inside data-blocks and builds data paths', () => {
    const loc = locateOwner(doc, cube)!;
    expect(loc).toMatchObject({ table: 'objects', path: '' });
    expect(fullDataPath(loc, 'location', 1)).toBe('bpy.data.objects["Cube"].location[1]');
    const md = newModifier('SUBSURF', 'md1', cube.modifiers);
    cube.modifiers.push(md);
    const ml = locateOwner(doc, md, 1)!;
    expect(relDataPath(ml, 'levels')).toBe(`modifiers["${md.name}"].levels`);
    expect(animTarget(doc, ml, 'levels')).toEqual({ ob: cube, path: `modifiers["${md.name}"].levels` });
    const rl = locateOwner(doc, doc.scene.render, 2)!;
    expect(fullDataPath(rl, 'resolution_x')).toBe('bpy.data.scenes["Scene"].render.resolution_x');
    expect(animTarget(doc, rl, 'resolution_x')).toBeNull();
    const light = Object.values(doc.objects).find((o) => o.type === 'LIGHT')!;
    const ll = locateOwner(doc, doc.lights[light.data!], 3)!;
    expect(animTarget(doc, ll, 'energy')).toEqual({ ob: light, path: 'data.energy' });
  });
});

describe('button defaults and paste', () => {
  it('finds defaults from factories and type registries', () => {
    expect(defaultValue(bind(cube, 'location'))).toEqual([0, 0, 0]);
    expect(defaultValue(bind(cube, 'scale'))).toEqual([1, 1, 1]);
    const md = newModifier('SUBSURF', 'md1', []);
    md.levels = 4;
    cube.modifiers.push(md);
    expect(defaultValue(bind(md, 'levels'))).toBe(newModifier('SUBSURF', 'x', []).levels);
    doc.scene.render.resolution_x = 640;
    expect(defaultValue(bind(doc.scene.render, 'resolution_x'))).toBe(1920);
    expect(defaultValue(bind(cube, 'name', { def: 'Thing' }))).toBe('Thing');
  });

  it('parses pasted numbers, vectors, colors and booleans', () => {
    expect(pasteButtonValue(bind(cube, 'location', { index: 1, kind: 'vector' }), '2.5', false)).toBe(true);
    expect([...cube.location]).toEqual([0, 2.5, 0]);
    expect(pasteButtonValue(bind(cube, 'location', { index: 0, kind: 'vector' }), '[1, 2, 3]', true)).toBe(true);
    expect([...cube.location]).toEqual([1, 2, 3]);
    expect(pasteButtonValue(bind(cube, 'hide_render', { kind: 'bool' }), 'True', false)).toBe(true);
    expect(cube.hide_render).toBe(true);
    const mat = Object.values(doc.materials)[0] as unknown as Record<string, unknown>;
    mat.diffuse_color = [0, 0, 0, 1];
    expect(pasteButtonValue(bind(mat, 'diffuse_color', { kind: 'color' }), '#ffffff', true)).toBe(true);
    expect((mat.diffuse_color as number[]).map((v) => Math.round(v * 100) / 100)).toEqual([1, 1, 1, 1]);
    expect(pasteButtonValue(bind(cube, 'location', { index: 0, kind: 'vector' }), 'not a number', false)).toBe(false);
    expect(pasteButtonValue(bind(cube, 'rotation_mode', { kind: 'enum', items: ['XYZ', 'QUATERNION'] }), 'BOGUS', false)).toBe(false);
    expect(app.doc).toBe(doc);
  });
});

describe('UI list filtering', () => {
  it('filters, inverts, sorts and reverses', () => {
    const items = [{ label: 'Group.010' }, { label: 'Arm' }, { label: 'Group.2' }, { label: 'leg' }];
    expect(visibleIndices(items, { text: 'group', invert: false, sortAlpha: false, reverse: false })).toEqual([0, 2]);
    expect(visibleIndices(items, { text: 'group', invert: true, sortAlpha: false, reverse: false })).toEqual([1, 3]);
    expect(visibleIndices(items, { text: '', invert: false, sortAlpha: true, reverse: false })).toEqual([1, 2, 0, 3]);
    expect(visibleIndices(items, { text: 'g*', invert: false, sortAlpha: false, reverse: true })).toEqual([2, 0]);
  });
});

describe('node input data paths', () => {
  it('addresses material node inputs through the active material', () => {
    const mat = Object.values(doc.materials)[0];
    const node = mat.tree!.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
    const loc = locateOwner(doc, node.inputs, 7)!;
    expect(loc.table).toBe('materials');
    expect(relDataPath(loc, 'Roughness')).toBe(`node_tree.nodes["${node.name}"].inputs["Roughness"].default_value`);
    expect(fullDataPath(loc, 'Roughness')).toBe(`bpy.data.materials["${mat.name}"].node_tree.nodes["${node.name}"].inputs["Roughness"].default_value`);
    const t = animTarget(doc, loc, 'Roughness', cube)!;
    expect(t.ob).toBe(cube);
    expect(t.path).toBe(`material.nodes["${node.name}"].inputs["Roughness"].default_value`);
  });
});
