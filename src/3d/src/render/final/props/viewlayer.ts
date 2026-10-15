// Properties ▸ View Layer: whether the layer renders, its passes and what it includes.
import { h, type Child } from '../../../ui/h';
import { registerTab } from '../../../editors/properties/properties';
import { panel } from '../../../ui/widgets';
import { bool, num } from '../../../ui/props';
import { renderSettings, sub } from './common';

/** Extra rows of Passes ▸ Data and extra View Layer panels (registered by feature modules). */
export const viewLayerDataItems: (() => Child)[] = [];
export const viewLayerPanels: (() => Child)[] = [];

registerTab({
  id: 'VIEW_LAYER',
  label: 'View Layer',
  icon: 'view_layer',
  group: 1,
  poll: () => true,
  draw: () => {
    const r = renderSettings();
    r.ambient_occlusion_distance ??= 1;
    return [
      panel('vl-layer', 'View Layer', () => [bool(r, 'use_view_layer', 'Use for Rendering', { tip: 'Render this view layer (F12 / Ctrl F12)' })]),
      panel('vl-passes', 'Passes', () => [
        sub('vl-passes-data', 'Data', () => [
          bool(r, 'use_pass_combined', 'Combined', { tip: 'The final image (always rendered)', disabled: true }),
          bool(r, 'use_pass_z', 'Z', { tip: 'Distance of surfaces along the camera axis' }),
          bool(r, 'use_pass_mist', 'Mist', { tip: 'Distance mapped through the world’s mist range (World ▸ Mist Pass)' }),
          bool(r, 'use_pass_normal', 'Normal', { tip: 'World-space surface normals' }),
          bool(r, 'use_pass_position', 'Position', { tip: 'World-space surface positions' }),
          bool(r, 'use_pass_uv', 'UV', { tip: 'Texture coordinates of the active UV map' }),
          ...viewLayerDataItems.map((f) => f()),
          h('div', { class: 'sub-label' }, 'Indexes'),
          bool(r, 'use_pass_object_index', 'Object Index', { tip: 'Pass Index of objects (Object ▸ Relations)' }),
          bool(r, 'use_pass_material_index', 'Material Index', { tip: 'Pass Index of materials (Material ▸ Settings)' }),
        ]),
        sub('vl-passes-light', 'Light', () => [
          bool(r, 'use_pass_diffuse_color', 'Diffuse Color', { tip: 'Base colour of diffuse surfaces' }),
          bool(r, 'use_pass_emit', 'Emission', { tip: 'Light emitted by surfaces' }),
          bool(r, 'use_pass_ambient_occlusion', 'Ambient Occlusion', { tip: 'How open each surface point is to its surroundings (1 open, 0 occluded)' }),
          r.use_pass_ambient_occlusion ? num(r, 'ambient_occlusion_distance', 'AO Distance', { unit: 'distance', min: 0, softMax: 100, tip: 'Distance of objects that occlude in the Ambient Occlusion pass' }) : null,
        ]),
      ]),
      ...viewLayerPanels.map((f) => f()),
      panel(
        'vl-filter',
        'Filter',
        () => [
          bool(r, 'use_sky', 'Environment', { tip: 'Render the world background (off: transparent background, the world still lights the scene)' }),
          bool(r, 'use_solid', 'Surfaces', { tip: 'Render surfaces of objects' }),
        ],
        { closed: true },
      ),
    ];
  },
});
