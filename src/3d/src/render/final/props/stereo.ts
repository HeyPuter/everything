// Stereoscopy panels: Output ▸ Stereoscopy (render views), Output ▸ Output ▸ Views (how views are
// saved) and Camera ▸ Stereoscopy (the stereo rig of the camera).
import { h, type Child } from '../../../ui/h';
import { app } from '../../../app/app';
import { panel, enumRow, checkbox } from '../../../ui/widgets';
import { num, bool, enumProp, textProp } from '../../../ui/props';
import { uiList } from '../../../editors/properties/uilist';
import type { RenderSettings } from '../../../data/types';
import { headerToggle, sub, changed } from './common';
import { multiview, cameraStereo } from '../stereo';
import { STEREO_ITEMS } from '../stereoops';
import { cameraExtraPanels } from './camera';
import '../stereoops';

export function stereoscopyPanel(r: RenderSettings): Child {
  const mv = multiview(r);
  return panel(
    'out-stereo',
    'Stereoscopy',
    () => {
      const stereo = mv.views_format === 'STEREO_3D';
      const shown = stereo ? mv.views.filter((v) => v.name === 'left' || v.name === 'right') : mv.views;
      const idx = Math.max(0, shown.indexOf(mv.views[mv.active_view_index]));
      const active = shown[idx];
      return [
        h(
          'div',
          { class: 'enum-tabs' },
          enumRow('out-views-format', [{ value: 'STEREO_3D', label: 'Stereo 3D' }, { value: 'MULTIVIEW', label: 'Multi-View' }], mv.views_format, (v) => {
            mv.views_format = v as typeof mv.views_format;
            changed('Views Format');
          }),
        ),
        uiList(
          'out-views',
          shown.map((v, i) => ({
            key: `${i}:${v.name}`,
            label: v.name,
            icon: 'camera_data',
            right: checkbox(`out-view-use-${v.name}`, '', v.use, (on) => {
              v.use = on;
              changed(on ? 'Enable View' : 'Disable View');
            }, { tip: 'Render this view' }),
            rightSize: 'compact' as const,
          })),
          idx,
          (i) => ((mv.active_view_index = mv.views.indexOf(shown[i])), app.changed('ui')),
          stereo
            ? {}
            : {
                add: () => app.run('scene.render_view_add'),
                remove: () => app.run('scene.render_view_remove'),
                rename: (i, name) => {
                  const v = shown[i];
                  if (!v || v.name === 'left' || v.name === 'right' || !name.trim()) return;
                  v.name = name.trim();
                  changed('Rename View');
                },
              },
        ),
        active ? textProp(active, 'camera_suffix', stereo ? 'File Suffix' : 'Camera Suffix', { tip: stereo ? 'Added to the file names of this eye' : 'This view renders through the camera named like the scene camera plus this suffix' }) : null,
      ];
    },
    { closed: true, header: headerToggle(r, 'use_multiview', 'Stereoscopy') },
  );
}

/** Output ▸ Output ▸ Views: save every view to its own file, or the eyes combined in one. */
export function viewsSubPanel(r: RenderSettings): Child {
  if (!r.use_multiview) return null;
  const mv = multiview(r);
  const f = mv.stereo_3d_format;
  const stereo = mv.views_format === 'STEREO_3D';
  return sub('out-output-views', 'Views', () => [
    stereo
      ? h(
          'div',
          { class: 'enum-tabs' },
          enumRow('out-image-views', [{ value: 'INDIVIDUAL', label: 'Individual' }, { value: 'STEREO_3D', label: 'Stereo 3D' }], mv.image_views_format, (v) => {
            mv.image_views_format = v as typeof mv.image_views_format;
            changed('Views Format');
          }),
        )
      : h('div', { class: 'prop-note' }, 'Each view is saved to its own file, named with its suffix.'),
    stereo && mv.image_views_format === 'STEREO_3D'
      ? [
          enumProp(f, 'display_mode', 'Stereo Mode', STEREO_ITEMS.DISPLAY_MODES, { tip: 'How the two eyes share one image' }),
          f.display_mode === 'ANAGLYPH' ? enumProp(f, 'anaglyph_type', 'Anaglyph Type', STEREO_ITEMS.ANAGLYPH, { tip: 'Colour filters of the glasses (left eye first)' }) : null,
          f.display_mode === 'INTERLACE' ? [enumProp(f, 'interlace_type', 'Interlace Type', STEREO_ITEMS.INTERLACE), bool(f, 'use_interlace_swap', 'Swap Left/Right')] : null,
          f.display_mode === 'SIDEBYSIDE' ? bool(f, 'use_sidebyside_crosseyed', 'Cross-Eyed', { tip: 'Right eye on the left, for viewing without glasses' }) : null,
          f.display_mode === 'SIDEBYSIDE' || f.display_mode === 'TOPBOTTOM' ? bool(f, 'use_squeezed_frame', 'Squeezed Frame', { tip: 'Keep the frame size: each eye is squeezed to half' }) : null,
        ]
      : null,
  ]);
}

// Camera ▸ Stereoscopy (when the scene renders stereo views)
cameraExtraPanels.push((_o, ca) => {
  const r = app.doc.scene.render;
  if (!r.use_multiview || multiview(r).views_format !== 'STEREO_3D') return null;
  const s = cameraStereo(ca);
  return panel(
    'ca-stereo',
    'Stereoscopy',
    () => [
      enumProp(s, 'convergence_mode', 'Mode', [['OFFAXIS', 'Off-Axis'], ['PARALLEL', 'Parallel'], ['TOE', 'Toe-in']], { tip: 'Off-Axis: the frusta are skewed so the eyes agree at the convergence distance; Toe-in: the eyes turn inward; Parallel: no convergence' }),
      num(s, 'convergence_distance', 'Convergence Plane Distance', { unit: 'distance', min: 1e-5, disabled: s.convergence_mode === 'PARALLEL', tip: 'Objects at this distance appear at the screen plane' }),
      num(s, 'interocular_distance', 'Interocular Distance', { unit: 'distance', min: 0, softMax: 1, tip: 'Distance between the eyes' }),
      enumProp(s, 'pivot', 'Pivot', [['LEFT', 'Left'], ['RIGHT', 'Right'], ['CENTER', 'Center']], { tip: 'Which eye sits at the camera position' }),
      h('div', { class: 'prop-note' }, 'Output ▸ Stereoscopy sets up the rendered eyes.'),
    ],
    { closed: true },
  );
});

