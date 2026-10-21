// Properties ▸ Camera data: lens, sensor, depth of field (with aperture shape), safe areas and
// viewport display (composition guides). The overlays are drawn by ../cameraoverlay.ts.
import { h, type Child } from '../../../ui/h';
import { app } from '../../../app/app';
import { panel, numberField, checkbox } from '../../../ui/widgets';
import { num, bool, enumProp, splitRow, objectProp } from '../../../ui/props';
import type { CameraData, ObjectData, SceneData } from '../../../data/types';
import { DEFAULT_SAFE_AREAS } from '../cameraoverlay';
import { panorama, PANORAMA_TYPES } from '../ptcamera';
import { changed, headerToggle, sub } from './common';

function safeAreas(): NonNullable<SceneData['safe_areas']> {
  const s = app.doc.scene;
  if (!s.safe_areas) s.safe_areas = JSON.parse(JSON.stringify(DEFAULT_SAFE_AREAS));
  return s.safe_areas!;
}

/** X / Y pair of margins as two rows. */
function margins(owner: Record<string, [number, number]>, key: string, label: string): Child {
  const v = owner[key];
  const field = (i: 0 | 1, l: string) =>
    splitRow(
      l,
      numberField({
        id: `safe-${key}-${i}`,
        value: v[i],
        min: 0,
        max: 1,
        slider: true,
        set: (x, final) => {
          v[i] = x;
          app.changed('doc');
          if (final) app.pushUndo('Safe Areas');
        },
      }),
    );
  return [field(0, `${label} X`), field(1, 'Y')];
}

/** Panels other modules add after the built-in camera data panels. */
export const cameraExtraPanels: ((o: ObjectData, ca: CameraData) => Child)[] = [];

/** Lens rows of panoramic cameras (rendered by the path tracer). */
function panoramaRows(ca: CameraData): Child {
  const p = panorama(ca);
  const t = p.panorama_type;
  const ang = (k: keyof typeof p & string, label: string, min: number, max: number) => num(p, k, label, { unit: 'angle', min, max });
  return [
    enumProp(p, 'panorama_type', 'Panorama Type', PANORAMA_TYPES, { tip: 'Projection of the panoramic camera (rendered by the path tracer; other engines show a perspective view)' }),
    t === 'FISHEYE_EQUIDISTANT' ? ang('fisheye_fov', 'Field of View', 0.1745, Math.PI * 2) : null,
    t === 'FISHEYE_EQUISOLID' ? [num(p, 'fisheye_lens', 'Lens', { unit: 'none', min: 0.01, max: 100, softMax: 15, precision: 2, tip: 'Focal length of the fisheye lens (mm)' }), ang('fisheye_fov', 'Field of View', 0.1745, Math.PI * 2)] : null,
    t === 'EQUIRECTANGULAR' ? [ang('latitude_min', 'Latitude Min', -Math.PI / 2, Math.PI / 2), ang('latitude_max', 'Max', -Math.PI / 2, Math.PI / 2), ang('longitude_min', 'Longitude Min', -Math.PI, Math.PI), ang('longitude_max', 'Max', -Math.PI, Math.PI)] : null,
    t === 'FISHEYE_LENS_POLYNOMIAL'
      ? (['fisheye_polynomial_k0', 'fisheye_polynomial_k1', 'fisheye_polynomial_k2', 'fisheye_polynomial_k3', 'fisheye_polynomial_k4'] as const).map((k, i) => num(p, k, `K${i}`, { precision: 6, step: 0.0001, tip: 'Coefficient of the lens polynomial: angle from the radius on the sensor (mm)' }))
      : null,
    t === 'CENTRAL_CYLINDRICAL'
      ? [
          ang('central_cylindrical_range_u_min', 'Range U Min', -Math.PI * 2, Math.PI * 2),
          ang('central_cylindrical_range_u_max', 'Max', -Math.PI * 2, Math.PI * 2),
          num(p, 'central_cylindrical_range_v_min', 'Range V Min', { unit: 'distance', softMin: -10, softMax: 10 }),
          num(p, 'central_cylindrical_range_v_max', 'Max', { unit: 'distance', softMin: -10, softMax: 10 }),
          num(p, 'central_cylindrical_radius', 'Radius', { unit: 'distance', min: 1e-5, softMax: 10 }),
        ]
      : null,
  ];
}

export function cameraPanels(o: ObjectData, ca: CameraData): Child {
  const dof = ca.dof as CameraData['dof'] & { aperture_rotation: number; aperture_ratio: number };
  dof.aperture_rotation ??= 0;
  dof.aperture_ratio ??= 1;
  const guides: [keyof CameraData & string, string][] = [
    ['show_composition_thirds', 'Thirds'],
    ['show_composition_center', 'Center'],
    ['show_composition_center_diagonal', 'Diagonal'],
    ['show_composition_golden', 'Golden'],
    ['show_composition_golden_tria_a', 'Golden Triangle A'],
    ['show_composition_golden_tria_b', 'Golden Triangle B'],
    ['show_composition_harmony_tri_a', 'Harmonious Triangle A'],
    ['show_composition_harmony_tri_b', 'Harmonious Triangle B'],
  ];
  return [
    panel('ca-lens', 'Lens', () => [
      enumProp(ca, 'type', 'Type', [['PERSP', 'Perspective'], ['ORTHO', 'Orthographic'], ['PANO', 'Panoramic']]),
      ca.type === 'PANO'
        ? panoramaRows(ca)
        : ca.type === 'ORTHO'
        ? num(ca, 'ortho_scale', 'Orthographic Scale', { min: 0.001, anim: { ob: o, path: 'data.ortho_scale' } })
        : ca.lens_unit === 'FOV'
          ? splitRow('Field of View', numberField({ id: 'ca-fov', value: 2 * Math.atan(ca.sensor_width / 2 / ca.lens), unit: 'angle', min: 0.0064, max: 3.0107, set: (v, f) => ((ca.lens = ca.sensor_width / 2 / Math.tan(v / 2)), app.changed('doc'), f && app.pushUndo('Field of View')) }))
          : num(ca, 'lens', 'Focal Length', { min: 1, max: 5000, softMax: 500, precision: 1, anim: { ob: o, path: 'data.lens' } }),
      ca.type !== 'PANO' ? enumProp(ca, 'lens_unit', 'Lens Unit', [['MILLIMETERS', 'Millimeters'], ['FOV', 'Field of View']]) : null,
      num(ca, 'shift_x', 'Shift X', { min: -10, max: 10, step: 0.01 }),
      num(ca, 'shift_y', 'Y', { min: -10, max: 10, step: 0.01 }),
      num(ca, 'clip_start', 'Clip Start', { unit: 'distance', min: 1e-6 }),
      num(ca, 'clip_end', 'End', { unit: 'distance', min: 1e-6 }),
    ]),
    panel('ca-sensor', 'Camera', () => [enumProp(ca, 'sensor_fit', 'Sensor Fit', [['AUTO', 'Auto'], ['HORIZONTAL', 'Horizontal'], ['VERTICAL', 'Vertical']]), num(ca, 'sensor_width', ca.sensor_fit === 'VERTICAL' ? 'Width' : 'Size', { unit: 'none', min: 1, max: 100 }), ca.sensor_fit !== 'AUTO' ? num(ca, 'sensor_height', 'Height', { min: 1, max: 100 }) : null], { closed: true }),
    panel(
      'ca-dof',
      'Depth of Field',
      () => [
        objectProp(ca.dof, 'focus_object', 'Focus on Object', { undo: 'Focus Object', filter: (x) => x.id !== o.id }),
        num(ca.dof, 'focus_distance', 'Focus Distance', { unit: 'distance', min: 0, disabled: !!ca.dof.focus_object, anim: { ob: o, path: 'data.dof.focus_distance' } }),
        sub('ca-dof-aperture', 'Aperture', () => [
          num(ca.dof, 'aperture_fstop', 'F-Stop', { min: 0.1, softMax: 128, precision: 1, tip: 'Lower values give a shallower depth of field' }),
          num(ca.dof, 'aperture_blades', 'Blades', { int: true, min: 0, max: 16, tip: 'Number of aperture blades (0 for a round bokeh)' }),
          num(dof, 'aperture_rotation', 'Rotation', { unit: 'angle', min: -Math.PI, max: Math.PI, tip: 'Rotation of the aperture blades' }),
          num(dof, 'aperture_ratio', 'Ratio', { min: 0.01, max: 100, softMax: 2, tip: 'Anamorphic stretch of the bokeh' }),
        ]),
      ],
      { closed: true, header: headerToggle(ca.dof, 'use_dof', 'Depth of Field') },
    ),
    panel(
      'ca-safe',
      'Safe Areas',
      () => {
        const sa = safeAreas() as unknown as Record<string, [number, number]>;
        return [
          margins(sa, 'title', 'Title Safe'),
          margins(sa, 'action', 'Action Safe'),
          sub('ca-safe-center', 'Center-Cut Safe Areas', () => [margins(sa, 'title_center', 'Title Safe'), margins(sa, 'action_center', 'Action Safe')], { closed: true, header: headerToggle(ca, 'show_safe_center', 'Center-Cut Safe Areas') }),
        ];
      },
      { closed: true, header: headerToggle(ca, 'show_safe_areas', 'Safe Areas') },
    ),
    panel(
      'ca-display',
      'Viewport Display',
      () => [
        num(ca, 'display_size', 'Size', { unit: 'distance', min: 0.01, max: 1000 }),
        bool(ca, 'show_name', 'Name', { tip: 'Show the camera name in camera view' }),
        splitRow('Passepartout', checkbox('ca-pp', '', ca.show_passepartout, (v) => ((ca.show_passepartout = v), changed('Passepartout')))),
        num(ca, 'passepartout_alpha', 'Opacity', { min: 0, max: 1, slider: true, disabled: !ca.show_passepartout }),
        sub('ca-guides', 'Composition Guides', () => h('div', { class: 'out-stamp-grid' }, guides.map(([k, l]) => checkbox(`ca-${k}`, l, !!ca[k], (v) => (((ca as unknown as Record<string, boolean>)[k] = v), changed(`Composition ${l}`))))), { closed: true }),
      ],
      { closed: true },
    ),
    ...cameraExtraPanels.map((f) => f(o, ca)),
  ];
}
