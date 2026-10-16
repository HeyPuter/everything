// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { encodeDocument, decodeDocument } from '../../src/io/native';
import { runJavaScript, output } from '../../src/scripting/runner';
import type { MeshData, ModifierBase } from '../../src/data/types';
import { freestyleSettings, activeLineSet, lineStyleOf } from '../../src/lines/defaults';
import { linestyleTable } from '../../src/lines/types';
import { computeLineArt } from '../../src/lines/lineart';
import { gpOf } from '../../src/greasepencil/data';

function run(code: string) {
  output.clear();
  const r = runJavaScript(code);
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  return output.lines.map((l) => l.text).join('\n');
}
const cube = () => Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;

beforeAll(async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  await new Promise((r) => setTimeout(r, 10));
}, 60000);

beforeEach(() => setApp(new App(startupDocument())));

describe('line set and line style operators', () => {
  it('adds, copies, pastes, moves and removes line sets', () => {
    const fs = freestyleSettings(app.doc);
    expect(fs.linesets.map((s) => s.name)).toEqual(['LineSet']);
    app.run('scene.freestyle_lineset_add');
    expect(fs.linesets.map((s) => s.name)).toEqual(['LineSet', 'LineSet 2']);
    expect(fs.active_lineset_index).toBe(1);
    // each new set has its own style
    expect(new Set(fs.linesets.map((s) => s.linestyle)).size).toBe(2);
    fs.linesets[1].select_crease = false;
    app.run('scene.freestyle_lineset_copy');
    fs.active_lineset_index = 0;
    app.run('scene.freestyle_lineset_paste');
    expect(fs.linesets[0].select_crease).toBe(false);
    expect(fs.linesets[0].name).toBe('LineSet 2.001');
    app.run('scene.freestyle_lineset_move', { direction: 'DOWN' });
    expect(fs.active_lineset_index).toBe(1);
    expect(fs.linesets[1].name).toBe('LineSet 2.001');
    app.run('scene.freestyle_lineset_remove');
    expect(fs.linesets.length).toBe(1);
  });

  it('copies line styles and edits modifier lists', () => {
    const set = activeLineSet(app.doc)!;
    const before = lineStyleOf(app.doc, set)!;
    before.thickness = 7;
    app.run('scene.freestyle_linestyle_new');
    const ls = lineStyleOf(app.doc, set)!;
    expect(ls.id).not.toBe(before.id);
    expect(ls.thickness).toBe(7);
    app.run('scene.freestyle_color_modifier_add', { type: 'NOISE' });
    app.run('scene.freestyle_color_modifier_add', { type: 'TANGENT' });
    expect(ls.color_modifiers.map((m) => m.type)).toEqual(['NOISE', 'TANGENT']);
    app.run('scene.freestyle_modifier_move', { modifier_type: 'COLOR', index: 1, direction: 'UP' });
    expect(ls.color_modifiers.map((m) => m.type)).toEqual(['TANGENT', 'NOISE']);
    app.run('scene.freestyle_modifier_copy', { modifier_type: 'COLOR', index: 0 });
    expect(ls.color_modifiers.map((m) => m.name)).toEqual(['Tangent', 'Tangent.001', 'Noise']);
    app.run('scene.freestyle_modifier_remove', { modifier_type: 'COLOR', index: 2 });
    expect(ls.color_modifiers.length).toBe(2);
    // the default geometry modifier samples strokes
    expect(ls.geometry_modifiers[0].type).toBe('SAMPLING');
  });

  it('fills a distance range from the selected objects', () => {
    const ls = lineStyleOf(app.doc, activeLineSet(app.doc))!;
    app.run('scene.freestyle_thickness_modifier_add', { type: 'DISTANCE_FROM_CAMERA' });
    for (const o of Object.values(app.doc.objects)) o.select = o.name === 'Cube';
    app.evaluate();
    app.run('scene.freestyle_fill_range_by_selection', { type: 'THICKNESS', name: 'Distance from Camera' });
    const m = ls.thickness_modifiers[0];
    const camOb = app.doc.objects[app.doc.scene.camera!];
    const d = Math.hypot(...camOb.location);
    expect(m.range_min as number).toBeLessThan(d);
    expect(m.range_max as number).toBeGreaterThan(d);
    expect((m.range_max as number) - (m.range_min as number)).toBeLessThan(4);
  });
});

describe('edge and face marks', () => {
  it('marks edges and faces in Edit Mode and keeps them through saving', () => {
    app.doc.scene.active_object = cube().id;
    cube().select = true;
    app.run('object.mode_set', { mode: 'EDIT' });
    app.run('mesh.select_all', { action: 'SELECT' });
    app.run('mesh.mark_freestyle_edge');
    app.run('mesh.mark_freestyle_face');
    const me = app.doc.meshes[cube().data!] as MeshData;
    expect(me.freestyle_edge?.every(Boolean)).toBe(true);
    expect(me.freestyle_face?.every(Boolean)).toBe(true);
    // marks survive other edits (subdivide renumbers corners)
    app.run('mesh.subdivide');
    const me2 = app.doc.meshes[cube().data!] as MeshData;
    expect(me2.freestyle_face?.length).toBe(me2.offsets.length - 1);
    expect(me2.freestyle_face?.every(Boolean)).toBe(true);
    // the outer edges keep their marks on both halves
    expect(me2.freestyle_edge?.filter(Boolean).length).toBeGreaterThanOrEqual(48);
    app.run('mesh.mark_freestyle_edge', { clear: true });
    expect(app.doc.meshes[cube().data!].freestyle_edge).toBeUndefined();
    app.run('object.mode_set', { mode: 'OBJECT' });
    const { doc } = decodeDocument(encodeDocument(app.doc));
    expect(doc.meshes[cube().data!].freestyle_face?.some(Boolean)).toBe(true);
  });
});

describe('scripting', () => {
  it('reaches line styles, line sets and modifiers', () => {
    const out = run(`
      const fs = bpy.context.view_layer.freestyle_settings;
      bpy.context.scene.render.use_freestyle = true;
      fs.crease_angle = 1.2;
      const set = fs.linesets.new('Outlines');
      set.select_silhouette = false;
      const ls = bpy.data.linestyles.new('Ink');
      set.linestyle = ls;
      ls.thickness = 5;
      ls.color_modifiers.new('Fade', 'ALONG_STROKE');
      ls.geometry_modifiers.new('Wobble', 'SPATIAL_NOISE');
      print(fs.linesets.length, set.name, set.linestyle.name, ls.color_modifiers[0].type, bpy.context.view_layer.use_freestyle);
    `);
    expect(out).toBe('2 Outlines Ink ALONG_STROKE true');
    const fs = freestyleSettings(app.doc);
    expect(fs.crease_angle).toBeCloseTo(1.2);
    const ls = Object.values(linestyleTable(app.doc)).find((x) => x.name === 'Ink')!;
    expect(fs.linesets[1].linestyle).toBe(ls.id);
    expect(ls.geometry_modifiers.map((m) => m.type)).toEqual(['SAMPLING', 'SPATIAL_NOISE']);
    expect(app.doc.scene.render.use_freestyle).toBe(true);
  });
});

describe('line art', () => {
  it('adds a scene line art object that draws the cube', () => {
    app.run('object.grease_pencil_add', { type: 'LINEART_SCENE' });
    const ob = app.activeObject!;
    expect(ob.name).toBe('LineArt');
    expect(ob.show_in_front).toBe(true);
    const m = ob.modifiers.find((x) => x.type === 'LINEART') as ModifierBase & Record<string, unknown>;
    expect(m.target_layer).toBe('Layer');
    expect(m.target_material).toBe(gpOf(app.doc, ob)!.materials[0]);
    app.evaluate();
    const strokes = computeLineArt(m, app.doc);
    expect(strokes.length).toBeGreaterThan(0);
    const pts = strokes.reduce((n, s) => n + s.points.length, 0);
    expect(pts).toBeGreaterThan(6);
    // hidden edges appear only with a higher occlusion level
    m.level_start = 1;
    const hidden = computeLineArt(m, app.doc);
    expect(hidden.length).toBeGreaterThan(0);
    m.use_contour = m.use_crease = m.use_loose = m.use_edge_mark = false;
    expect(computeLineArt(m, app.doc).length).toBe(0);
  });

  it('object line art takes the active object as source', () => {
    app.doc.scene.active_object = cube().id;
    app.run('object.grease_pencil_add', { type: 'LINEART_OBJECT' });
    const m = app.activeObject!.modifiers[0] as ModifierBase & Record<string, unknown>;
    expect(m.source_type).toBe('OBJECT');
    expect(m.source_object).toBe(cube().id);
  });

  it('transfers source vertex group weights to the strokes', async () => {
    const me = app.doc.meshes[cube().data!] as MeshData;
    me.vertex_groups = [{ name: 'rim' } as never];
    me.weights = [new Float32Array(me.positions.length / 3).fill(0.75)];
    app.run('object.grease_pencil_add', { type: 'LINEART_SCENE' });
    const ob = app.activeObject!;
    const m = ob.modifiers[0] as ModifierBase & Record<string, unknown>;
    m.source_vertex_group = 'ri';
    m.use_output_vertex_group_match_by_name = false;
    m.vertex_group = 'lines';
    app.evaluate();
    const { lineArtStrokes } = await import('../../src/lines/lineart');
    const { Matrix4 } = await import('three');
    const strokes = lineArtStrokes(m, app.doc, new Matrix4(), gpOf(app.doc, ob)!.materials);
    expect(strokes.length).toBeGreaterThan(0);
    expect(strokes[0].points[0].weights?.lines).toBeCloseTo(0.75);
  });

  it('a Line Art modifier added from the menu targets the active layer', () => {
    app.run('object.grease_pencil_add', { type: 'STROKE' });
    app.run('object.modifier_add', { type: 'LINEART' });
    const ob = app.activeObject!;
    const m = ob.modifiers[ob.modifiers.length - 1] as ModifierBase & Record<string, unknown>;
    const gp = gpOf(app.doc, ob)!;
    expect(m.target_layer).toBe(gp.layers[gp.active_layer_index].name);
    expect(m.target_material).toBe(gp.materials[0]);
  });

  it('clears baked line art', () => {
    app.run('object.grease_pencil_add', { type: 'LINEART_SCENE' });
    const ob = app.activeObject!;
    const m = ob.modifiers[0] as ModifierBase & Record<string, unknown>;
    m.is_baked = true;
    expect(app.run('object.lineart_clear')).toBe('FINISHED');
    expect(m.is_baked).toBe(false);
  });
});

describe('grease pencil modifier segments', () => {
  it('adds, moves and removes dash and time segments', () => {
    app.run('object.grease_pencil_add', { type: 'STROKE' });
    app.run('object.modifier_add', { type: 'GREASE_PENCIL_DASH' });
    const ob = app.activeObject!;
    const dash = ob.modifiers[ob.modifiers.length - 1] as ModifierBase & { segments: { name: string }[]; segment_active_index?: number };
    app.run('object.grease_pencil_dash_modifier_segment_add', { modifier: dash.name });
    expect(dash.segments.map((s) => s.name)).toEqual(['Segment', 'Segment.001']);
    app.run('object.grease_pencil_dash_modifier_segment_move', { modifier: dash.name, type: 'UP' });
    expect(dash.segments.map((s) => s.name)).toEqual(['Segment.001', 'Segment']);
    app.run('object.grease_pencil_dash_modifier_segment_remove', { modifier: dash.name });
    expect(dash.segments.length).toBe(1);
    // the last dash segment stays
    expect(app.run('object.grease_pencil_dash_modifier_segment_remove', { modifier: dash.name })).toBe('CANCELLED');
    app.run('object.modifier_add', { type: 'GREASE_PENCIL_TIME' });
    const time = ob.modifiers[ob.modifiers.length - 1] as ModifierBase & { segments?: { seg_start: number }[] };
    app.run('object.grease_pencil_time_modifier_segment_add', { modifier: time.name });
    app.run('object.grease_pencil_time_modifier_segment_add', { modifier: time.name });
    expect(time.segments!.map((s) => s.seg_start)).toEqual([1, 3]);
  });
});

describe('annotation layers', () => {
  it('adds, moves, clears and removes layers', () => {
    const sc = app.doc.scene as unknown as { annotation_layers?: { name: string }[]; annotation_layer_active?: number; annotations?: { layer?: string }[] };
    expect(app.run('gpencil.annotation_add')).toBe('FINISHED');
    app.run('gpencil.layer_annotation_add');
    expect(sc.annotation_layers!.map((l) => l.name)).toEqual(['Note', 'Note.001']);
    expect(sc.annotation_layer_active).toBe(1);
    sc.annotations = [{ layer: 'Note' }, { layer: 'Note.001' }] as never;
    app.run('gpencil.annotation_active_frame_delete');
    expect(sc.annotations!.map((s) => s.layer)).toEqual(['Note']);
    app.run('gpencil.layer_annotation_move', { type: 'DOWN' });
    expect(sc.annotation_layers!.map((l) => l.name)).toEqual(['Note.001', 'Note']);
    expect(sc.annotation_layer_active).toBe(0);
    sc.annotation_layer_active = 1;
    app.run('gpencil.layer_annotation_remove');
    expect(sc.annotations!.length).toBe(0);
    app.run('gpencil.data_unlink');
    expect(sc.annotation_layers!.length).toBe(0);
  });
});
