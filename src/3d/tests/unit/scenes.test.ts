// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import { encodeDocument, decodeDocument } from '../../src/io/native';
import '../../src/ops/data';
import '../../src/object/index';
import '../../src/scenes/ops';
import { activateScene, allScenes, deleteScene, sceneObjects, withScene, renameScene } from '../../src/scenes/scenes';
import { activeLayerIndex, addViewLayer, ensureViewLayers, layerFlags, layerRender, removeViewLayer, renderLayers, setActiveViewLayer } from '../../src/scenes/viewlayers';
import { visibleObjects } from '../../src/eval/depsgraph';

beforeEach(() => setApp(new App(startupDocument())));

const names = () => allScenes(app.doc).map((s) => s.name);
const visible = () => [...visibleObjects(app.doc).keys()].map((id) => app.doc.objects[id].name).sort();

describe('scenes', () => {
  it('scene.new NEW adds an empty active scene and keeps the old one', () => {
    const first = app.doc.scene;
    app.doc.scene.frame_end = 77;
    expect(app.run('scene.new', { type: 'NEW' }, { invoke: false })).toBe('FINISHED');
    expect(app.doc.scene).not.toBe(first);
    expect(app.doc.scene.name).toBe('Scene.001');
    expect(app.doc.scene.frame_end).toBe(250);
    expect(app.doc.scene.world).toBeNull();
    expect(visible()).toEqual([]);
    expect(names().sort()).toEqual(['Scene', 'Scene.001']);
    // the old scene's master collection left doc.collections
    expect(app.doc.collections[first.collection]).toBeUndefined();
    activateScene(app.doc, first.id!);
    expect(app.doc.scene).toBe(first);
    expect(visible()).toEqual(['Camera', 'Cube', 'Light']);
  });

  it('Copy Settings copies the settings but no content', () => {
    app.doc.scene.frame_end = 77;
    app.doc.scene.render.resolution_x = 1234;
    app.run('scene.new', { type: 'EMPTY' }, { invoke: false });
    expect(app.doc.scene.frame_end).toBe(77);
    expect(app.doc.scene.render.resolution_x).toBe(1234);
    expect(app.doc.scene.camera).toBeNull();
    expect(visible()).toEqual([]);
  });

  it('Linked Copy shares collections and objects', () => {
    const n = Object.keys(app.doc.objects).length;
    app.run('scene.new', { type: 'LINK_COPY' }, { invoke: false });
    expect(Object.keys(app.doc.objects).length).toBe(n);
    expect(visible()).toEqual(['Camera', 'Cube', 'Light']);
    expect(app.doc.scene.camera).toBe(Object.values(app.doc.objects).find((o) => o.name === 'Camera')!.id);
  });

  it('Full Copy duplicates collections, objects, data and the world', () => {
    const n = Object.keys(app.doc.objects).length;
    const worlds = Object.keys(app.doc.worlds).length;
    app.run('scene.new', { type: 'FULL_COPY' }, { invoke: false });
    expect(Object.keys(app.doc.objects).length).toBe(n * 2);
    expect(Object.keys(app.doc.worlds).length).toBe(worlds + 1);
    expect(visible()).toEqual(['Camera.001', 'Cube.001', 'Light.001']);
    const cam = app.doc.objects[app.doc.scene.camera!];
    expect(cam.name).toBe('Camera.001');
    // the original scene still shows the originals only
    const other = allScenes(app.doc).find((s) => s.name === 'Scene')!;
    withScene(app.doc, other.id!, () => expect(visible()).toEqual(['Camera', 'Cube', 'Light']));
    expect(visible()).toEqual(['Camera.001', 'Cube.001', 'Light.001']);
  });

  it('scene.delete removes the active scene and objects only it used', () => {
    const first = app.doc.scene;
    app.run('scene.new', { type: 'FULL_COPY' }, { invoke: false });
    const n = Object.keys(app.doc.objects).length;
    expect(app.run('scene.delete', {}, { invoke: false })).toBe('FINISHED');
    expect(app.doc.scene).toBe(first);
    // the copies lived in the deleted scene's (shared) collection, which stays: objects are kept
    expect(Object.keys(app.doc.objects).length).toBe(n);
    expect(app.run('scene.delete', {}, { invoke: false })).toBe('CANCELLED');
  });

  it('deleting a scene removes objects linked only to its scene collection', () => {
    app.run('scene.new', { type: 'NEW' }, { invoke: false });
    app.run('object.empty_add', {}, { invoke: false });
    const id = app.doc.scene.active_object!;
    expect(app.doc.objects[id]).toBeTruthy();
    deleteScene(app.doc, app.doc.scene.id!);
    expect(app.doc.objects[id]).toBeUndefined();
  });

  it('undo and redo restore the active scene', () => {
    const first = app.doc.scene.name;
    app.run('scene.new', { type: 'NEW' }, { invoke: false });
    app.undoStep();
    expect(app.doc.scene.name).toBe(first);
    expect(names().length).toBe(1);
    app.redoStep();
    expect(app.doc.scene.name).toBe('Scene.001');
  });

  it('round-trips through the native format', () => {
    app.run('scene.new', { type: 'LINK_COPY' }, { invoke: false });
    app.doc.scene.frame_end = 99;
    const { doc } = decodeDocument(encodeDocument(app.doc));
    expect(allScenes(doc).map((s) => s.name).sort()).toEqual(['Scene', 'Scene.001']);
    expect(doc.scene.frame_end).toBe(99);
    const other = allScenes(doc).find((s) => s.name === 'Scene')!;
    expect(other.master_collection).toBeTruthy();
    expect(sceneObjects(doc, other).size).toBe(3);
  });

  it('legacy documents get a scene id', () => {
    const d = startupDocument();
    delete d.scene.id;
    const { doc } = decodeDocument(encodeDocument(d));
    expect(doc.scene.id).toBeTruthy();
  });

  it('renaming keeps names unique', () => {
    app.run('scene.new', { type: 'NEW' }, { invoke: false });
    expect(renameScene(app.doc, app.doc.scene, 'Scene')).toBe('Scene.001');
    expect(renameScene(app.doc, app.doc.scene, 'Shot A')).toBe('Shot A');
  });

  it('Link Objects to Scene links the selection into another scene', () => {
    const first = app.doc.scene;
    app.run('scene.new', { type: 'NEW' }, { invoke: false });
    const target = app.doc.scene.id!;
    activateScene(app.doc, first.id!);
    app.evaluate();
    for (const o of Object.values(app.doc.objects)) o.select = o.name === 'Cube';
    expect(app.run('object.make_links_scene', { scene: target }, { invoke: false })).toBe('FINISHED');
    activateScene(app.doc, target);
    expect(visible()).toEqual(['Cube']);
  });
});

describe('background scene', () => {
  it('shows the set scene objects, not selectable', () => {
    const first = app.doc.scene;
    app.run('scene.new', { type: 'NEW' }, { invoke: false });
    app.doc.scene.background_set = first.id!;
    const vis = visibleObjects(app.doc);
    expect([...vis.keys()].map((id) => app.doc.objects[id].name).sort()).toEqual(['Camera', 'Cube', 'Light']);
    expect([...vis.values()].every((v) => v.noSelect)).toBe(true);
    deleteScene(app.doc, first.id!);
    expect(app.doc.scene.background_set).toBeNull();
  });
});

describe('view layers', () => {
  it('a scene has a default view layer', () => {
    expect(ensureViewLayers(app.doc.scene).map((l) => l.name)).toEqual(['ViewLayer']);
  });

  it('each layer keeps its own passes and collection flags', () => {
    const col = Object.values(app.doc.collections).find((c) => c.name === 'Collection')!;
    app.doc.scene.render.use_pass_z = true;
    addViewLayer(app.doc, 'NEW');
    expect(app.doc.scene.view_layers!.map((l) => l.name)).toEqual(['ViewLayer', 'ViewLayer.001']);
    expect(activeLayerIndex(app.doc.scene)).toBe(1);
    expect(app.doc.scene.render.use_pass_z).toBe(false);
    col.exclude = true;
    app.doc.scene.render.use_pass_mist = true;
    expect(visible()).toEqual([]);
    setActiveViewLayer(app.doc, 0);
    expect(col.exclude).toBe(false);
    expect(app.doc.scene.render.use_pass_z).toBe(true);
    expect(app.doc.scene.render.use_pass_mist).toBe(false);
    expect(visible()).toEqual(['Camera', 'Cube', 'Light']);
    expect(layerFlags(app.doc, app.doc.scene, 1, col.id).exclude).toBe(true);
    expect(layerRender(app.doc.scene, 1).use_pass_mist).toBe(true);
  });

  it('Copy Settings and Blank', () => {
    const col = Object.values(app.doc.collections).find((c) => c.name === 'Collection')!;
    col.holdout = true;
    app.doc.scene.render.use_pass_normal = true;
    addViewLayer(app.doc, 'COPY');
    expect(col.holdout).toBe(true);
    expect(app.doc.scene.render.use_pass_normal).toBe(true);
    addViewLayer(app.doc, 'EMPTY');
    expect(col.exclude).toBe(true);
    expect(col.holdout).toBeFalsy();
    expect(app.doc.scene.render.use_pass_normal).toBe(false);
  });

  it('remove keeps at least one layer', () => {
    addViewLayer(app.doc, 'NEW');
    expect(removeViewLayer(app.doc, 1)).toBe(true);
    expect(removeViewLayer(app.doc, 0)).toBe(false);
    expect(app.doc.scene.view_layers!.length).toBe(1);
  });

  it('render layers skip layers that are not used for rendering', () => {
    addViewLayer(app.doc, 'NEW');
    app.doc.scene.render.use_view_layer = false;
    expect(renderLayers(app.doc.scene)).toEqual([0]);
  });

  it('collection flags of a scene survive switching scenes', () => {
    const col = Object.values(app.doc.collections).find((c) => c.name === 'Collection')!;
    const first = app.doc.scene;
    col.exclude = true;
    app.run('scene.new', { type: 'LINK_COPY' }, { invoke: false });
    // the copy starts with the same flags
    expect(col.exclude).toBe(true);
    col.exclude = false;
    expect(visible()).toEqual(['Camera', 'Cube', 'Light']);
    activateScene(app.doc, first.id!);
    expect(col.exclude).toBe(true);
    expect(visible()).toEqual([]);
  });

  it('view layer operators are undoable', () => {
    app.run('scene.view_layer_add', { type: 'NEW' }, { invoke: false });
    expect(app.doc.scene.view_layers!.length).toBe(2);
    app.undoStep();
    expect(ensureViewLayers(app.doc.scene).length).toBe(1);
  });

  it('AOV and light group operators', () => {
    app.run('scene.view_layer_add_aov', {}, { invoke: false });
    app.run('scene.view_layer_add_aov', {}, { invoke: false });
    expect(app.doc.scene.render.aovs!.map((a) => a.name)).toEqual(['AOV', 'AOV.001']);
    app.run('scene.view_layer_remove_aov', {}, { invoke: false });
    expect(app.doc.scene.render.aovs!.map((a) => a.name)).toEqual(['AOV']);
    app.run('scene.view_layer_add_lightgroup', {}, { invoke: false });
    const vl = app.doc.scene.view_layers![0];
    expect(vl.lightgroups!.map((g) => g.name)).toEqual(['Lightgroup']);
    const light = Object.values(app.doc.objects).find((o) => o.name === 'Light')!;
    light.lightgroup = 'key';
    app.run('scene.view_layer_add_used_lightgroups', {}, { invoke: false });
    expect(app.doc.scene.view_layers![0].lightgroups!.map((g) => g.name)).toEqual(['Lightgroup', 'key']);
    app.run('scene.view_layer_remove_unused_lightgroups', {}, { invoke: false });
    expect(app.doc.scene.view_layers![0].lightgroups!.map((g) => g.name)).toEqual(['key']);
  });
});
