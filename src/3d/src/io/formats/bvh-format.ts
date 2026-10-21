// Motion capture registration: File ▸ Import / Export ▸ Motion Capture (.bvh)
import { app } from '../../app/app';
import type { RotationMode } from '../../data/types';
import { Depsgraph } from '../../eval/depsgraph';
import { setMode } from '../../ops/object';
import { defineFormat, reportWarnings } from './glue';
import { armaturePoseAt, importBvh, parseBvh, writeBvh } from './bvh';
import { AXIS_ITEMS, stripExt, type AxisId } from './common';

const EULER: [string, string][] = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'].map((m) => [m, `Euler (${m})`]);

defineFormat({
  id: 'bvh',
  label: 'Motion Capture (.bvh)',
  extensions: ['.bvh'],
  description: 'Biovision Hierarchy motion capture: a skeleton with its animation',
  importOps: ['import_anim.bvh'],
  exportOps: ['export_anim.bvh'],
  importOpLabel: 'Import BVH',
  exportOpLabel: 'Export BVH',
  importOptions: [
    {
      id: 'target',
      label: 'Target',
      type: 'enum',
      default: 'ARMATURE',
      items: [
        ['ARMATURE', 'Armature'],
        ['OBJECT', 'Object (empties)'],
      ],
    },
    { id: 'global_scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 1e6 },
    { id: 'frame_start', label: 'Start Frame', type: 'int', default: 1, min: -1048574, max: 1048574 },
    { id: 'use_fps_scale', label: 'Scale FPS', type: 'bool', default: false, description: "Stretch the keys so the motion plays at its own speed at the scene's frame rate" },
    { id: 'update_scene_fps', label: 'Update Scene FPS', type: 'bool', default: false, description: "Set the scene's frame rate to the file's" },
    { id: 'update_scene_duration', label: 'Update Scene Duration', type: 'bool', default: false, description: "Extend the scene's frame range to the whole motion" },
    { id: 'use_cyclic', label: 'Loop', type: 'bool', default: false, description: 'Repeat the motion before and after its keys' },
    { id: 'rotate_mode', label: 'Rotation', type: 'enum', default: 'NATIVE', items: [['NATIVE', 'Native (file order)'], ['QUATERNION', 'Quaternion'], ...EULER] },
    { id: 'axis_forward', label: 'Forward', type: 'enum', default: '-Z', items: AXIS_ITEMS },
    { id: 'axis_up', label: 'Up', type: 'enum', default: 'Y', items: AXIS_ITEMS },
  ],
  exportOptions: [
    { id: 'global_scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 1e6 },
    { id: 'frame_start', label: 'Start Frame', type: 'int', default: 1, min: -1048574, max: 1048574, dynamicDefault: () => app.doc.scene.frame_start },
    { id: 'frame_end', label: 'End Frame', type: 'int', default: 250, min: -1048574, max: 1048574, dynamicDefault: () => app.doc.scene.frame_end },
    { id: 'rotate_mode', label: 'Rotation', type: 'enum', default: 'NATIVE', items: [['NATIVE', "Native (each bone's order)"], ...EULER] },
    { id: 'root_transform_only', label: 'Root Translation Only', type: 'bool', default: false, description: 'Only the root bone gets position channels' },
    { id: 'sort_children_by_names', label: 'Sort Children by Name', type: 'bool', default: false },
  ],
  importData(src, o) {
    const doc = app.doc;
    if (doc.mode !== 'OBJECT') setMode(doc, 'OBJECT');
    const bvh = parseBvh(new TextDecoder().decode(src.bytes));
    const fps = doc.scene.render.fps / (doc.scene.render.fps_base || 1);
    const res = importBvh(doc, bvh, {
      target: o.target as 'ARMATURE',
      scale: Number(o.global_scale) || 1,
      frameStart: Number(o.frame_start),
      useFpsScale: !!o.use_fps_scale,
      sceneFps: fps,
      rotateMode: o.rotate_mode as 'NATIVE',
      forward: o.axis_forward as AxisId,
      up: o.axis_up as AxisId,
      cyclic: !!o.use_cyclic,
      name: stripExt(src.name),
    });
    reportWarnings(res.warnings);
    if (o.update_scene_fps) {
      const rate = 1 / bvh.frameTime;
      doc.scene.render.fps = Math.max(1, Math.round(rate));
      doc.scene.render.fps_base = doc.scene.render.fps / rate;
    }
    if (o.update_scene_duration) {
      doc.scene.frame_start = Math.min(doc.scene.frame_start, Number(o.frame_start));
      doc.scene.frame_end = Math.max(doc.scene.frame_end, Math.ceil(res.frameEnd));
    }
    for (const ob of Object.values(doc.objects)) ob.select = false;
    for (const ob of res.objects) ob.select = true;
    doc.scene.active_object = res.objects[0]?.id ?? doc.scene.active_object;
    app.changed('doc', 'select', 'frame');
  },
  exportData(o, target) {
    const doc = app.doc;
    const act = doc.scene.active_object ? doc.objects[doc.scene.active_object] : undefined;
    const ob = act?.type === 'ARMATURE' ? act : Object.values(doc.objects).find((x) => x.type === 'ARMATURE' && x.select);
    if (!ob || !ob.data || !doc.armatures[ob.data]) throw new Error('Select an armature to export its motion');
    const arm = doc.armatures[ob.data];
    const graph = new Depsgraph(doc);
    const original = doc.scene.frame_current,
      sub = doc.scene.frame_subframe;
    let text: string;
    try {
      text = writeBvh(arm, (f) => armaturePoseAt(doc, graph, ob, f), (name) => (ob.pose?.[name]?.rotation_mode ?? 'QUATERNION') as RotationMode, {
        frameStart: Number(o.frame_start),
        frameEnd: Math.max(Number(o.frame_start), Number(o.frame_end)),
        scale: Number(o.global_scale) || 1,
        rotateMode: o.rotate_mode as 'NATIVE',
        rootTransformOnly: !!o.root_transform_only,
        sortChildrenByName: !!o.sort_children_by_names,
        fps: doc.scene.render.fps / (doc.scene.render.fps_base || 1),
      });
    } finally {
      doc.scene.frame_current = original;
      doc.scene.frame_subframe = sub;
    }
    void target;
    return { bytes: text, mime: 'text/plain', ext: '.bvh' };
  },
});
