// Clip editor panels for camera solving: the toolbar's Solve tab (Solve, Clean Up, Geometry,
// Orientation, Scene Setup, Object) and the sidebar's Objects list and lens distortion rows.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { panel, opButton, checkbox } from '../ui/widgets';
import { num, bool, enumProp, splitRow } from '../ui/props';
import { isCameraActive, tobj, trackingObjects, type MovieClipData } from './types';
import type { ClipEditor } from './editor';

const commit = (label: string) => {
  app.changed('doc');
  app.pushUndo(label);
};

/** "Solve error: 0.1234 px" (or null without a valid solution of the active object). */
export function solveErrorText(c: MovieClipData): string | null {
  const rec = tobj(c).reconstruction;
  return rec?.is_valid ? `Solve error: ${rec.average_error.toFixed(4)} px` : null;
}

export function solveToolbar(ed: ClipEditor, c: MovieClipData): Child[] {
  const s = c.tracking.settings;
  const o = tobj(c);
  const cam = isCameraActive(c);
  const rec = o.reconstruction;
  const auto = s.use_keyframe_selection !== false;
  s.use_keyframe_selection ??= true;
  o.keyframe_a ??= 1;
  o.keyframe_b ??= 30;
  const refine = (key: 'refine_intrinsics_focal_length' | 'refine_intrinsics_principal_point' | 'refine_intrinsics_radial_distortion' | 'refine_intrinsics_tangential_distortion', label: string, tip: string) =>
    checkbox(`clip-refine-${key}`, label, !!s[key], (v) => ((s[key] = v), commit(`Refine ${label}`)), { tip });
  const out: Child[] = [
    panel('clip-t-solve', 'Solve', () => [
      cam ? bool(s, 'use_tripod_solver', 'Tripod', { tip: 'Solve a shot where the camera only rotates (no parallax): the tracks become directions' }) : null,
      bool(s, 'use_keyframe_selection', 'Keyframe', { tip: 'Choose the two keyframes the reconstruction starts from automatically' }),
      num(o, 'keyframe_a', 'Keyframe A', { int: true, min: 1, disabled: auto, tip: 'First keyframe used to start the reconstruction' }),
      num(o, 'keyframe_b', 'B', { int: true, min: 1, disabled: auto, tip: 'Second keyframe used to start the reconstruction' }),
      cam
        ? splitRow(
            'Refine',
            h(
              'div',
              { class: 'clip-refine-col' },
              refine('refine_intrinsics_focal_length', 'Focal Length', 'Refine the focal length during the solve'),
              refine('refine_intrinsics_principal_point', 'Optical Center', 'Refine the optical center during the solve (needs strong parallax)'),
              refine('refine_intrinsics_radial_distortion', 'Radial Distortion', 'Refine the radial lens distortion coefficients during the solve'),
              c.tracking.camera.distortion_model === 'BROWN' ? refine('refine_intrinsics_tangential_distortion', 'Tangential Distortion', 'Refine the tangential lens distortion coefficients during the solve') : null,
            ),
          )
        : null,
      h('div', { class: 'btn-col' }, opButton('clip.solve_camera', cam ? 'Solve Camera Motion' : 'Solve Object Motion', {}, { icon: 'camera_data' })),
      rec?.is_valid
        ? h('div', { class: 'clip-solve-status' }, `${solveErrorText(c)} · ${rec.cameras.length} frames · ${o.tracks.filter((t) => t.has_bundle).length} bundles`)
        : h('div', { class: 'clip-info' }, cam ? 'Not solved yet' : 'Object not solved yet'),
      rec?.is_valid || o.tracks.some((t) => t.has_bundle) ? h('div', { class: 'btn-col' }, opButton('clip.clear_solution', 'Clear Solution')) : null,
    ]),
    panel('clip-t-cleanup', 'Clean Up', () => {
      s.clean_frames ??= 0;
      s.clean_error ??= 0;
      s.clean_action ??= 'SELECT';
      return [
        num(s, 'clean_frames', 'Tracked Frames', { int: true, min: 0, tip: 'Tracks with fewer tracked frames in a row are affected by the clean up' }),
        num(s, 'clean_error', 'Reprojection Error', { min: 0, unit: 'pixel', precision: 3, tip: 'Tracks whose solve error is larger are affected by the clean up (0 disables)' }),
        enumProp(s, 'clean_action', 'Type', [
          ['SELECT', 'Select'],
          ['DELETE_TRACK', 'Delete Track'],
          ['DELETE_SEGMENTS', 'Delete Segments'],
        ]),
        h('div', { class: 'btn-col' }, opButton('clip.clean_tracks', 'Clean Up', { frames: s.clean_frames, error: s.clean_error, action: s.clean_action })),
        h('div', { class: 'btn-col' }, opButton('clip.filter_tracks', 'Filter Tracks')),
      ];
    }, { closed: true }),
    panel('clip-t-plane', 'Plane Track', () => [h('div', { class: 'btn-col' }, opButton('clip.create_plane_track', 'Create Plane Track')), h('div', { class: 'clip-info' }, 'Select four or more tracks on a flat surface.')], { closed: true }),
    panel('clip-t-geometry', 'Geometry', () => [h('div', { class: 'btn-col' }, opButton('clip.bundles_to_mesh', '3D Markers to Mesh'), opButton('clip.track_to_empty', 'Link Empty to Track'))], { closed: true }),
  ];
  if (cam) {
    s.distance ??= 1;
    out.push(
      panel('clip-t-orientation', 'Orientation', () => [
        h('div', { class: 'btn-row' }, opButton('clip.set_plane', 'Floor', { plane: 'FLOOR' }), opButton('clip.set_plane', 'Wall', { plane: 'WALL' })),
        h('div', { class: 'btn-col' }, opButton('clip.set_origin', 'Set Origin')),
        h('div', { class: 'btn-row' }, opButton('clip.set_axis', 'Set X Axis', { axis: 'X' }), opButton('clip.set_axis', 'Set Y Axis', { axis: 'Y' })),
        num(s, 'distance', 'Distance', { unit: 'distance', min: 0, tip: 'Distance between the two selected tracks used by Set Scale and Apply Scale' }),
        h('div', { class: 'btn-row' }, opButton('clip.set_scale', 'Set Scale', { distance: s.distance }), opButton('clip.apply_solution_scale', 'Apply Scale', { distance: s.distance })),
        h('div', { class: 'clip-info' }, 'Select 3 tracks for a plane, 1 for an axis, 2 for the scale.'),
      ]),
      panel('clip-t-scene', 'Scene Setup', () => [h('div', { class: 'btn-col' }, opButton('clip.set_viewport_background', 'Set as Background'), opButton('clip.setup_tracking_scene', 'Setup Tracking Scene'))]),
    );
  } else {
    s.object_distance ??= 1;
    out.push(
      panel('clip-t-object', 'Object', () => [
        num(s, 'object_distance', 'Distance', { unit: 'distance', min: 0, tip: 'Distance between the two selected tracks used by Set Solution Scale' }),
        h('div', { class: 'btn-col' }, opButton('clip.set_solution_scale', 'Set Solution Scale', { distance: s.object_distance })),
      ]),
    );
  }
  void ed;
  return out;
}

/** Sidebar "Objects" panel: the camera and tracked objects. */
export function objectsPanel(c: MovieClipData): Child {
  const objs = trackingObjects(c);
  const active = c.tracking.active_object_index ?? 0;
  return panel('clip-n-objects', 'Objects', () => [
    h(
      'div',
      { class: 'clip-list-wrap' },
      h(
        'div',
        { class: 'clip-list clip-objects' },
        objs.map((o, i) =>
          h(
            'div',
            {
              key: o.name,
              class: { 'clip-list-item': true, on: i === active },
              onclick: () => {
                if (i === active) return;
                c.tracking.active_object_index = i;
                commit('Set Active Tracking Object');
              },
            },
            icon(o.is_camera ? 'camera_data' : 'object'),
            h('span', { class: 'clip-obj-name' }, o.name),
            o.data.reconstruction?.is_valid ? h('span', { class: 'clip-obj-err' }, `${o.data.reconstruction.average_error.toFixed(3)} px`) : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'clip-list-btns' },
        h('button', { class: 'btn icon-btn', 'data-tip': 'Add a tracking object', onclick: () => app.run('clip.tracking_object_new') }, icon('add')),
        h('button', { class: 'btn icon-btn', 'data-tip': 'Remove the active tracking object', disabled: !app.poll('clip.tracking_object_remove'), onclick: () => app.run('clip.tracking_object_remove') }, icon('remove')),
      ),
    ),
    active > 0 && c.tracking.objects?.[active - 1]
      ? [
          splitRow(
            'Name',
            h('input', {
              class: 'text-field',
              value: c.tracking.objects[active - 1].name,
              onchange: (e: Event) => {
                const v = (e.target as HTMLInputElement).value.trim();
                const ob = c.tracking.objects![active - 1];
                if (!v || objs.some((x) => x.name === v)) return void app.changed('ui');
                // keep constraints pointing at this object
                for (const o of Object.values(app.doc.objects)) for (const con of o.constraints) if ((con.type === 'OBJECT_SOLVER' || con.type === 'FOLLOW_TRACK') && con.object === ob.name) con.object = v;
                ob.name = v;
                commit('Rename Tracking Object');
              },
            }),
          ),
          num(c.tracking.objects[active - 1], 'scale', 'Scale', { min: 0.0001, tip: 'Scale of the object solution in camera space' }),
        ]
      : null,
  ]);
}

/** Lens distortion rows of the sidebar Camera ▸ Lens panel for the chosen model. */
export function distortionRows(c: MovieClipData): Child[] {
  const cam = c.tracking.camera;
  const k = (key: keyof typeof cam, label: string) => {
    if (cam[key] === undefined) (cam as unknown as Record<string, number>)[key] = 0;
    return num(cam, key, label, { softMin: -10, softMax: 10, precision: 4 });
  };
  const rows: Child[] = [
    enumProp(cam, 'distortion_model', 'Lens Distortion', [
      ['POLYNOMIAL', 'Polynomial'],
      ['DIVISION', 'Divisions'],
      ['BROWN', 'Brown'],
    ]),
  ];
  if (cam.distortion_model === 'DIVISION') rows.push(k('division_k1', 'K1'), k('division_k2', 'K2'));
  else if (cam.distortion_model === 'BROWN') rows.push(k('brown_k1', 'K1'), k('brown_k2', 'K2'), k('brown_k3', 'K3'), k('brown_k4', 'K4'), k('brown_p1', 'P1'), k('brown_p2', 'P2'));
  else rows.push(k('k1', 'K1'), k('k2', 'K2'), k('k3', 'K3'));
  return rows;
}
