// Scene and view layer operators: scene.new / scene.delete, scene.view_layer_add / _remove,
// shader AOVs and light groups of the active view layer, Link Objects to Scene and Duplicate
// Marker to Scene.
import { app, registerOperators, type OpContext } from '../app/app';
import { objectMode, sceneChanged, switchScene, switchViewLayer } from './switch';
import { duplicateObject, uniqueName } from '../ops/object';
import type { DocumentData, ID } from '../data/types';
import { activeSceneId, allScenes, deleteScene, newScene, sceneById, scenesByName, type SceneNewType } from './scenes';
import { activeLayerIndex, activeViewLayer, addViewLayer, ensureViewLayers, removeViewLayer, type ViewLayerAddType } from './viewlayers';
import type { AovData } from '../render/final/idpasses';
import { linkDataMenuHooks } from '../object/menus';

const SCENE_NEW_ITEMS: [string, string, string][] = [
  ['NEW', 'New', 'Add a new, empty scene with default settings'],
  ['EMPTY', 'Copy Settings', 'Add a new, empty scene with the settings of the current scene'],
  ['LINK_COPY', 'Linked Copy', 'Link in the collections of the current scene (shallow copy)'],
  ['FULL_COPY', 'Full Copy', 'Make a full copy of the current scene, its collections, objects and their data'],
];

const LAYER_ADD_ITEMS: [string, string, string][] = [
  ['NEW', 'New', 'Add a new view layer'],
  ['COPY', 'Copy Settings', 'Copy the settings of the current view layer'],
  ['EMPTY', 'Blank', 'Add a new view layer with all collections disabled'],
];

/** Menu items of scene.new (for the topbar and the outliner). */
export function sceneNewMenu() {
  return SCENE_NEW_ITEMS.map(([v, l, d]) => ({ label: l, op: 'scene.new', props: { type: v }, description: d }));
}

export function viewLayerAddMenu() {
  return LAYER_ADD_ITEMS.map(([v, l, d]) => ({ label: l, op: 'scene.view_layer_add', props: { type: v }, description: d }));
}

function uniqueAovName(list: AovData[], base: string): string {
  const names = new Set(list.map((a) => a.name));
  let n = base;
  for (let i = 1; names.has(n); i++) n = `${base}.${String(i).padStart(3, '0')}`;
  return n;
}

/** Light group names used by objects and the world of the active scene. */
export function usedLightgroups(doc: DocumentData): string[] {
  const out = new Set<string>();
  for (const ob of Object.values(doc.objects)) if (ob.lightgroup) out.add(ob.lightgroup);
  const w = doc.scene.world ? doc.worlds[doc.scene.world] : null;
  if (w?.lightgroup) out.add(w.lightgroup);
  return [...out];
}

const sceneTargets = (ctx: OpContext) => allScenes(ctx.doc).filter((s) => s !== ctx.doc.scene);

registerOperators([
  {
    idname: 'scene.new',
    label: 'New Scene',
    description: 'Add a new scene and make it the active one',
    icon: 'scene_data',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'NEW', items: SCENE_NEW_ITEMS }],
    poll: () => !app.modal,
    exec: (ctx, p) => {
      if (!objectMode()) return 'CANCELLED';
      const sc = newScene(ctx.doc, p.type as SceneNewType, { duplicateObject, uniqueName: (d, b, k) => uniqueName(d, b, k ?? 'objects') });
      sceneChanged();
      app.report('INFO', `Added scene “${sc.name}”`);
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.delete',
    label: 'Delete Scene',
    description: 'Delete the active scene (objects only it uses are removed too)',
    icon: 'x',
    poll: (ctx) => allScenes(ctx.doc).length > 1,
    exec: (ctx) => {
      if (!objectMode()) return 'CANCELLED';
      const name = ctx.doc.scene.name;
      if (!deleteScene(ctx.doc, activeSceneId(ctx.doc))) return 'CANCELLED';
      sceneChanged();
      app.report('INFO', `Deleted scene “${name}”`);
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.view_layer_add',
    label: 'Add View Layer',
    description: 'Add a view layer to the scene and make it active',
    icon: 'view_layer',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'NEW', items: LAYER_ADD_ITEMS }],
    exec: (ctx, p) => {
      addViewLayer(ctx.doc, p.type as ViewLayerAddType);
      sceneChanged();
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.view_layer_remove',
    label: 'Remove View Layer',
    description: 'Remove the active view layer (a scene keeps at least one)',
    icon: 'x',
    poll: (ctx) => ensureViewLayers(ctx.doc.scene).length > 1,
    exec: (ctx) => {
      if (!removeViewLayer(ctx.doc, activeLayerIndex(ctx.doc.scene))) return 'CANCELLED';
      sceneChanged();
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.view_layer_add_aov',
    label: 'Add AOV',
    description: 'Add a shader AOV pass to the view layer (written by AOV Output nodes)',
    icon: 'add',
    exec: (ctx) => {
      const r = ctx.doc.scene.render;
      const list = (r.aovs ??= []);
      list.push({ name: uniqueAovName(list, 'AOV'), type: 'COLOR' });
      activeViewLayer(ctx.doc.scene).active_aov_index = list.length - 1;
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.view_layer_remove_aov',
    label: 'Remove AOV',
    description: 'Remove the active shader AOV of the view layer',
    icon: 'remove',
    poll: (ctx) => !!ctx.doc.scene.render.aovs?.length,
    exec: (ctx) => {
      const r = ctx.doc.scene.render;
      const vl = activeViewLayer(ctx.doc.scene);
      const list = r.aovs ?? [];
      const i = Math.min(list.length - 1, Math.max(0, vl.active_aov_index ?? 0));
      if (i < 0) return 'CANCELLED';
      r.aovs = list.filter((_, k) => k !== i);
      vl.active_aov_index = Math.max(0, i - 1);
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.view_layer_add_lightgroup',
    label: 'Add Lightgroup',
    description: 'Add a light group to the view layer: its lights render into a pass of their own',
    icon: 'add',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    exec: (ctx, p) => {
      const vl = activeViewLayer(ctx.doc.scene);
      const list = (vl.lightgroups ??= []);
      const base = String(p.name ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_') || 'Lightgroup';
      const names = new Set(list.map((g) => g.name));
      let n = base;
      for (let i = 1; names.has(n); i++) n = `${base}_${String(i).padStart(3, '0')}`;
      list.push({ name: n });
      vl.active_lightgroup_index = list.length - 1;
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.view_layer_remove_lightgroup',
    label: 'Remove Lightgroup',
    description: 'Remove the active light group of the view layer',
    icon: 'remove',
    poll: (ctx) => !!activeViewLayer(ctx.doc.scene).lightgroups?.length,
    exec: (ctx) => {
      const vl = activeViewLayer(ctx.doc.scene);
      const list = vl.lightgroups ?? [];
      const i = Math.min(list.length - 1, Math.max(0, vl.active_lightgroup_index ?? 0));
      if (i < 0) return 'CANCELLED';
      list.splice(i, 1);
      vl.active_lightgroup_index = Math.max(0, i - 1);
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.view_layer_add_used_lightgroups',
    label: 'Add Used Lightgroups',
    description: 'Add a light group for every light group name used by objects or the world',
    exec: (ctx) => {
      const vl = activeViewLayer(ctx.doc.scene);
      const list = (vl.lightgroups ??= []);
      const have = new Set(list.map((g) => g.name));
      let n = 0;
      for (const name of usedLightgroups(ctx.doc).sort())
        if (!have.has(name)) {
          list.push({ name });
          n++;
        }
      if (!n) {
        app.report('INFO', 'Every used light group is already in the list');
        return 'CANCELLED';
      }
      return 'FINISHED';
    },
  },
  {
    idname: 'scene.view_layer_remove_unused_lightgroups',
    label: 'Remove Unused Lightgroups',
    description: 'Remove light groups that no object or world uses',
    exec: (ctx) => {
      const vl = activeViewLayer(ctx.doc.scene);
      const used = new Set(usedLightgroups(ctx.doc));
      const before = vl.lightgroups?.length ?? 0;
      vl.lightgroups = (vl.lightgroups ?? []).filter((g) => used.has(g.name));
      if (vl.lightgroups.length === before) return 'CANCELLED';
      vl.active_lightgroup_index = Math.min(vl.active_lightgroup_index ?? 0, Math.max(0, vl.lightgroups.length - 1));
      return 'FINISHED';
    },
  },
  {
    idname: 'object.make_links_scene',
    label: 'Link Objects to Scene',
    description: 'Link the selected objects into another scene (into its scene collection)',
    props: [{ id: 'scene', label: 'Scene', type: 'string', default: '' }],
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && sceneTargets(ctx).length > 0 && app.selectedObjects().length > 0,
    exec: (ctx, p) => {
      const target = sceneById(ctx.doc, String(p.scene)) ?? allScenes(ctx.doc).find((s) => s.name === p.scene);
      if (!target || target === ctx.doc.scene) {
        app.report('ERROR', 'Choose another scene to link the objects into');
        return 'CANCELLED';
      }
      const master = target.master_collection;
      if (!master) return 'CANCELLED';
      let n = 0;
      for (const ob of app.selectedObjects())
        if (!master.objects.includes(ob.id)) {
          master.objects.push(ob.id);
          n++;
        }
      app.report('INFO', `Linked ${n} object${n === 1 ? '' : 's'} to “${target.name}”`);
      return 'FINISHED';
    },
  },
  {
    idname: 'marker.make_links_scene',
    label: 'Duplicate Marker to Scene',
    description: 'Copy the selected time markers into another scene',
    props: [{ id: 'scene', label: 'Scene', type: 'string', default: '' }],
    poll: (ctx) => sceneTargets(ctx).length > 0 && ctx.doc.scene.timeline_markers.some((m) => m.select),
    exec: (ctx, p) => {
      const target = sceneById(ctx.doc, String(p.scene)) ?? allScenes(ctx.doc).find((s) => s.name === p.scene);
      if (!target || target === ctx.doc.scene) return 'CANCELLED';
      const sel = ctx.doc.scene.timeline_markers.filter((m) => m.select);
      for (const m of sel) target.timeline_markers.push({ ...m, select: false, camera: m.camera ?? null });
      app.report('INFO', `Copied ${sel.length} marker${sel.length === 1 ? '' : 's'} to “${target.name}”`);
      return 'FINISHED';
    },
  },
]);

/** Submenu listing the other scenes for an operator with a `scene` property. */
export function otherScenesMenu(op: string) {
  const doc = app.doc;
  const list = scenesByName(doc).filter((s) => s !== doc.scene);
  if (!list.length) return [{ label: 'No other scenes', disabled: true }];
  return list.map((s) => ({ label: s.name, icon: 'scene_data', op, props: { scene: s.id } }));
}

export { switchScene, switchViewLayer };

// Link/Transfer Data ▸ Link Objects to Scene
linkDataMenuHooks.top.push(() => [{ label: 'Link Objects to Scene', submenu: () => otherScenesMenu('object.make_links_scene') }, { separator: true }]);
