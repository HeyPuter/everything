// Properties editor UI for the Follow Track constraint.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { checkbox, enumMenu, opButton } from '../ui/widgets';
import { splitRow } from '../ui/props';
import { constraintExtraUI } from '../editors/properties/stack';
import type { Constraint, ObjectData } from '../data/types';
import { clipTable, trackingObjects, trackingObjectByName, type MovieClipData } from './types';

function set(c: Constraint, key: string, v: unknown, label: string) {
  c[key] = v;
  app.pushUndo(label);
  app.changed('doc');
}

constraintExtraUI.FOLLOW_TRACK = (_ob: ObjectData, c: Constraint): Child => {
  const doc = app.doc;
  const clips = Object.values(clipTable(doc));
  const clip = c.use_active_clip ? clipTable(doc)[doc.scene.active_clip ?? ''] : clipTable(doc)[(c.clip as string) ?? ''];
  const none = { value: '', label: '—' };
  const objects = (type: string) => [none, ...Object.values(doc.objects).filter((o) => o.type === type).map((o) => ({ value: o.id, label: o.name }))];
  return [
    h(
      'div',
      { class: 'split-row check' },
      h('div', { class: 'sr-label' }),
      h('div', { class: 'sr-value' }, checkbox(`ft-active-${c.id}`, 'Active Clip', !!c.use_active_clip, (v) => set(c, 'use_active_clip', v, 'Change Active Clip'), { tip: "Use active clip defined in scene" })),
    ),
    c.use_active_clip
      ? splitRow('Clip', h('span', { class: 'clip-value' }, clip ? clip.name : 'No active clip (open one in a Movie Clip Editor)'))
      : splitRow(
          'Clip',
          enumMenu(`ft-clip-${c.id}`, [none, ...clips.map((x) => ({ value: x.id, label: x.name, icon: 'clip_editor' }))], (c.clip as string) ?? '', (v) => set(c, 'clip', v || null, 'Change Clip'), { tip: 'Movie Clip to get tracking data from' }),
        ),
    h(
      'div',
      { class: 'split-row check' },
      h('div', { class: 'sr-label' }),
      h('div', { class: 'sr-value' }, checkbox(`ft-undist-${c.id}`, 'Undistort', !!c.use_undistorted_position, (v) => set(c, 'use_undistorted_position', v, 'Change Undistort'), { tip: 'Parent to undistorted position of 2D track' })),
    ),
    h(
      'div',
      { class: 'split-row check' },
      h('div', { class: 'sr-label' }),
      h('div', { class: 'sr-value' }, checkbox(`ft-3d-${c.id}`, '3D Position', !!c.use_3d_position, (v) => set(c, 'use_3d_position', v, 'Change 3D Position'), { tip: 'Follow the reconstructed 3D position of the track instead of its 2D marker' })),
    ),
    clip ? objectRow(c, clip, 'ft', true) : null,
    splitRow(
      'Track',
      enumMenu(`ft-track-${c.id}`, [none, ...(clip ? trackingObjectByName(clip, c.object as string).tracks : []).map((t) => ({ value: t.name, label: t.name, icon: 'tracker' }))], (c.track as string) ?? '', (v) => set(c, 'track', v, 'Change Track'), { tip: 'Movie tracking track to follow' }),
    ),
    splitRow('Camera', enumMenu(`ft-cam-${c.id}`, objects('CAMERA').map((o) => (o.value ? o : { value: '', label: 'Scene Camera' })), (c.camera as string) ?? '', (v) => set(c, 'camera', v || null, 'Change Camera'), { tip: 'Camera to which motion is parented (if empty active scene camera is used)' })),
    splitRow('Depth Object', enumMenu(`ft-depth-${c.id}`, objects('MESH'), (c.depth_object as string) ?? '', (v) => set(c, 'depth_object', v || null, 'Change Depth Object'), { tip: 'Object used to define depth in camera space by projecting onto surface of this object' })),
    splitRow(
      'Frame Method',
      enumMenu(
        `ft-fm-${c.id}`,
        [
          { value: 'STRETCH', label: 'Stretch' },
          { value: 'FIT', label: 'Fit' },
          { value: 'CROP', label: 'Crop' },
        ],
        (c.frame_method as string) ?? 'STRETCH',
        (v) => set(c, 'frame_method', v, 'Change Frame Method'),
        { tip: 'How the footage fits in the camera frame' },
      ),
    ),
    h('div', { class: 'btn-col' }, opButton('clip.constraint_to_fcurve', 'Constraint to F-Curve', { constraint: c.name })),
  ];
};

/** Tracking object selector ('' = the camera). */
function objectRow(c: Constraint, clip: MovieClipData, prefix: string, allowCamera: boolean) {
  const items = trackingObjects(clip)
    .filter((o) => allowCamera || !o.is_camera)
    .map((o) => ({ value: o.is_camera ? '' : o.name, label: o.name, icon: o.is_camera ? 'camera_data' : 'object' }));
  return splitRow('Object', enumMenu(`${prefix}-obj-${c.id}`, items.length ? items : [{ value: '', label: '—' }], (c.object as string) ?? '', (v) => set(c, 'object', v, 'Change Tracking Object'), { tip: 'Tracking object whose tracks / solution are used' }));
}

function clipRows(c: Constraint, prefix: string): Child[] {
  const doc = app.doc;
  const clips = Object.values(clipTable(doc));
  const clip = c.use_active_clip !== false ? clipTable(doc)[doc.scene.active_clip ?? ''] : clipTable(doc)[(c.clip as string) ?? ''];
  return [
    h(
      'div',
      { class: 'split-row check' },
      h('div', { class: 'sr-label' }),
      h('div', { class: 'sr-value' }, checkbox(`${prefix}-active-${c.id}`, 'Active Clip', c.use_active_clip !== false, (v) => set(c, 'use_active_clip', v, 'Change Active Clip'), { tip: 'Use the scene\'s active movie clip' })),
    ),
    c.use_active_clip !== false
      ? splitRow('Clip', h('span', { class: 'clip-value' }, clip ? `${clip.name}${clip.tracking.reconstruction?.is_valid ? '' : ' (not solved)'}` : 'No active clip'))
      : splitRow('Clip', enumMenu(`${prefix}-clip-${c.id}`, [{ value: '', label: '—' }, ...clips.map((x) => ({ value: x.id, label: x.name, icon: 'clip_editor' }))], (c.clip as string) ?? '', (v) => set(c, 'clip', v || null, 'Change Clip'), { tip: 'Movie clip to get the solution from' })),
  ];
}

constraintExtraUI.CAMERA_SOLVER = (_ob: ObjectData, c: Constraint): Child => [...clipRows(c, 'cs'), h('div', { class: 'btn-col' }, opButton('clip.constraint_to_fcurve', 'Constraint to F-Curve', { constraint: c.name }))];

constraintExtraUI.OBJECT_SOLVER = (_ob: ObjectData, c: Constraint): Child => {
  const doc = app.doc;
  const clip = c.use_active_clip !== false ? clipTable(doc)[doc.scene.active_clip ?? ''] : clipTable(doc)[(c.clip as string) ?? ''];
  return [
    ...clipRows(c, 'os'),
    clip ? objectRow(c, clip, 'os', false) : null,
    splitRow('Camera', enumMenu(`os-cam-${c.id}`, [{ value: '', label: 'Scene Camera' }, ...Object.values(doc.objects).filter((o) => o.type === 'CAMERA').map((o) => ({ value: o.id, label: o.name }))], (c.camera as string) ?? '', (v) => set(c, 'camera', v || null, 'Change Camera'), { tip: 'Camera the object moves relative to (the scene camera when empty)' })),
    h('div', { class: 'btn-row' }, opButton('constraint.objectsolver_set_inverse', 'Set Inverse', { constraint: c.name, owner: 'OBJECT' }), opButton('constraint.objectsolver_clear_inverse', 'Clear Inverse', { constraint: c.name, owner: 'OBJECT' })),
    h('div', { class: 'btn-col' }, opButton('clip.constraint_to_fcurve', 'Constraint to F-Curve', { constraint: c.name })),
  ];
};
