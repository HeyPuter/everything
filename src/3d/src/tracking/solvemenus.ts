// Solving (Shift S) and Reconstruction (Shift W) pies of the clip editor.
import { app } from '../app/app';
import { addKeys } from '../app/keymap';
import { openPie, type PieItem } from '../ui/menu';
import { currentClipEditor, sceneDistance } from './editor';
import { isCameraActive } from './types';

const inClipView = () => {
  const ed = currentClipEditor();
  return !!ed && ed.view === 'CLIP' && ed.mode === 'TRACKING';
};

function settingToggle(label: string, key: 'use_tripod_solver' | 'use_keyframe_selection' | 'refine_intrinsics_focal_length' | 'refine_intrinsics_radial_distortion'): PieItem {
  const c = currentClipEditor()?.clip;
  const s = c?.tracking.settings;
  const on = key === 'use_keyframe_selection' ? s?.[key] !== false : !!s?.[key];
  return {
    label,
    active: on,
    icon: on ? 'checkbox_hlt' : 'checkbox_dehlt',
    action: () => {
      if (!s) return;
      s[key] = !on;
      app.pushUndo(`Toggle ${label}`);
      app.changed('doc');
    },
  };
}

/** Shift S: solving pie. */
function solvingPie() {
  const c = currentClipEditor()?.clip;
  const cam = !c || isCameraActive(c);
  openPie(
    'Solving',
    [
      { label: 'Set Keyframe A', op: 'clip.set_solver_keyframe', props: { keyframe: 'KEYFRAME_A' } },
      { label: 'Set Keyframe B', op: 'clip.set_solver_keyframe', props: { keyframe: 'KEYFRAME_B' } },
      { label: cam ? 'Solve Camera' : 'Solve Object', op: 'clip.solve_camera' },
      { label: 'Clear Solution', op: 'clip.clear_solution' },
      settingToggle('Tripod', 'use_tripod_solver'),
      settingToggle('Keyframe', 'use_keyframe_selection'),
      settingToggle('Refine Focal Length', 'refine_intrinsics_focal_length'),
      settingToggle('Refine Radial Distortion', 'refine_intrinsics_radial_distortion'),
    ],
    app.pointer.x,
    app.pointer.y,
    'KeyS',
  );
}

/** Shift W: reconstruction pie. */
function reconstructionPie() {
  openPie(
    'Reconstruction',
    [
      { label: 'Set Viewport Background', op: 'clip.set_viewport_background' },
      { label: 'Setup Tracking Scene', op: 'clip.setup_tracking_scene' },
      { label: 'Set Floor', op: 'clip.set_plane', props: { plane: 'FLOOR' } },
      { label: 'Set Origin', op: 'clip.set_origin' },
      { label: 'Set X Axis', op: 'clip.set_axis', props: { axis: 'X' } },
      { label: 'Set Y Axis', op: 'clip.set_axis', props: { axis: 'Y' } },
      { label: 'Set Scale', op: 'clip.set_scale', props: { distance: sceneDistance() } },
      { label: 'Apply Solution Scale', op: 'clip.apply_solution_scale', props: { distance: sceneDistance() } },
    ],
    app.pointer.x,
    app.pointer.y,
    'KeyW',
  );
}

addKeys('Clip', [
  { key: 'S', shift: true, when: inClipView, action: solvingPie },
  { key: 'W', shift: true, when: inClipView, action: reconstructionPie },
]);
