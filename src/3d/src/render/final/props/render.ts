// Properties ▸ Render: engine choice and the settings each engine honours.
import { h, type Child } from '../../../ui/h';
import { registerTab } from '../../../editors/properties/properties';
import { panel, enumMenu, enumRow } from '../../../ui/widgets';
import { num, bool, enumProp, colorProp, splitRow } from '../../../ui/props';
import { LOOKS } from '../colormanage';
import type { RenderSettings } from '../../../data/types';
import { renderSettings, changed, headerToggle, sub } from './common';
import { curveWidget } from './curvewidget';
import { ensureRealtimeDefaults, samplingShadowsPanel, samplingAdvancedPanel, raytracingPanel, volumesPanel, bloomPanel } from '../../realtime/props';

export const ENGINES = [
  { value: 'RASTER', label: 'Realtime (Raster)', description: 'Realtime rasterization with shadows, ambient occlusion and bloom' },
  { value: 'PATHTRACE', label: 'Path Tracer', description: 'Physically based path tracing: accurate light bounces, slower' },
  { value: 'SOLID', label: 'Solid (Workbench)', description: 'Renders like the viewport’s Solid shading' },
];

const VIEWS: [string, string][] = [
  ['STANDARD', 'Standard'],
  ['KHRONOS_PBR_NEUTRAL', 'Khronos PBR Neutral'],
  ['AGX', 'AgX'],
  ['FILMIC', 'Filmic'],
  ['RAW', 'Raw'],
];

function engineRow(r: RenderSettings): Child {
  return splitRow(
    'Render Engine',
    enumMenu('rs-engine', ENGINES, r.engine, (v) => {
      r.engine = v as RenderSettings['engine'];
      changed('Render Engine');
    }),
    null,
    'rs-engine',
  );
}

function simplifyPanel(r: RenderSettings): Child {
  return panel(
    'rs-simplify',
    'Simplify',
    () => [
      sub('rs-simplify-vp', 'Viewport', () => [
        num(r, 'simplify_subdivision', 'Max Subdivision', { int: true, min: 0, max: 6, tip: 'Highest subdivision level used by modifiers in the viewport' }),
        num(r, 'simplify_child_particles', 'Child Particles', { min: 0, max: 1, slider: true, tip: 'Fraction of child particles generated in the viewport' }),
      ]),
      sub('rs-simplify-render', 'Render', () => [
        num(r, 'simplify_subdivision_render', 'Max Subdivision', { int: true, min: 0, max: 6, tip: 'Highest subdivision level used by modifiers in final renders' }),
        num(r, 'simplify_child_particles_render', 'Child Particles', { min: 0, max: 1, slider: true, tip: 'Fraction of child particles generated in final renders' }),
      ]),
    ],
    { closed: true, header: headerToggle(r, 'use_simplify', 'Simplify') },
  );
}

function colorManagementPanel(r: RenderSettings): Child {
  const looks = LOOKS[r.view_transform] ? Object.keys(LOOKS[r.view_transform]) : [];
  return panel(
    'rs-cm',
    'Color Management',
    () => [
      enumProp(r, 'display_device' as never, 'Display Device', [['sRGB', 'sRGB']], { tip: 'Display the image is shown on' }),
      splitRow(
        'View Transform',
        enumMenu('rs-cm-view', VIEWS.map(([value, label]) => ({ value, label })), r.view_transform, (v) => {
          r.view_transform = v as RenderSettings['view_transform'];
          // looks belong to a view transform
          if (r.look !== 'None' && !LOOKS[r.view_transform]?.[r.look]) r.look = 'None';
          changed('View Transform');
        }),
      ),
      splitRow(
        'Look',
        enumMenu('rs-cm-look', [{ value: 'None', label: 'None' }, ...looks.map((l) => ({ value: l, label: l.replace(/^AgX - /, '') }))], looks.includes(r.look) ? r.look : 'None', (v) => {
          r.look = v;
          changed('Look');
        }, { disabled: !looks.length, tip: looks.length ? 'Additional contrast and saturation grade on top of the view transform' : 'This view transform has no looks' }),
      ),
      num(r, 'exposure', 'Exposure', { min: -32, max: 32, softMin: -10, softMax: 10, tip: 'Exposure (stops) applied before the view transform' }),
      num(r, 'gamma', 'Gamma', { min: 0, max: 5, tip: 'Extra gamma applied after the view transform' }),
      sub(
        'rs-cm-wb',
        'White Balance',
        () => [
          num(r, 'white_balance_temperature', 'Temperature', { min: 1800, max: 100000, softMin: 2000, softMax: 11000, precision: 0, tip: 'Colour temperature (K) of the light in the scene: the image is corrected so it appears white' }),
          num(r, 'white_balance_tint', 'Tint', { min: -500, max: 500, softMin: -150, softMax: 150, precision: 1, tip: 'Green–magenta shift of the light in the scene' }),
        ],
        { closed: true, header: headerToggle(r, 'use_white_balance', 'White Balance') },
      ),
      sub(
        'rs-cm-curves',
        'Curves',
        () =>
          curveWidget(
            'rs-cm-curve',
            () => r.curve_mapping ?? [[0, 0], [1, 1]],
            (pts) => (r.curve_mapping = pts),
            'Display curve applied after the view transform',
          ),
        { closed: true, header: headerToggle(r, 'use_curve_mapping', 'Curves') },
      ),
    ],
    { closed: true },
  );
}

function performanceViewport(r: RenderSettings): Child {
  return sub('rs-perf-vp', 'Viewport', () => [
    enumProp(r, 'preview_pixel_size' as never, 'Pixel Size', [['AUTO', 'Automatic'], ['1', '1×'], ['2', '2×'], ['4', '4×'], ['8', '8×']], { tip: 'Pixel size of the Rendered viewport: larger pixels render faster' }),
  ]);
}

function rasterPanels(r: RenderSettings): Child {
  ensureRealtimeDefaults(r);
  return [
    panel('rs-sampling', 'Sampling', () => [
      sub('rs-samp-vp', 'Viewport', () => [num(r, 'preview_raster_samples', 'Samples', { int: true, min: 1, max: 1024, tip: 'Anti-aliasing samples accumulated in the Rendered viewport while the view is still' })]),
      sub('rs-samp-render', 'Render', () => [num(r, 'raster_samples', 'Samples', { int: true, min: 1, max: 4096, tip: 'Anti-aliasing samples averaged for final renders (also used for depth of field and motion blur)' })]),
      samplingShadowsPanel(r),
      samplingAdvancedPanel(r),
    ]),
    panel(
      'rs-lightpaths',
      'Light Paths',
      () => [
        sub('rs-lp-intensity', 'Intensity', () => [
          num(r, 'direct_light_intensity', 'Direct Light', { min: 0, softMax: 3, tip: 'Strength of light coming from lamps' }),
          num(r, 'indirect_light_intensity', 'Indirect Light', { min: 0, softMax: 3, tip: 'Strength of light coming from the world' }),
        ]),
        sub('rs-lp-clamp', 'Clamping', () => [
          sub('rs-lp-clamp-surface', 'Surface', () => [
            num(r, 'clamp_surface_direct', 'Direct Light', { min: 0, softMax: 100, tip: 'Maximum brightness each light adds to a surface (0 for no limit): removes harsh highlights' }),
            num(r, 'clamp_surface_indirect', 'Indirect Light', { min: 0, softMax: 100, tip: 'Maximum brightness of light from the world, probes and bounces (0 for no limit)' }),
          ]),
        ], { closed: true }),
      ],
      { closed: true },
    ),
    raytracingPanel(r),
    volumesPanel(r),
    bloomPanel(r),
    simplifyPanel(r),
    panel(
      'rs-dof',
      'Depth of Field',
      () => [
        bool(r, 'use_bokeh_jittered', 'Jitter Camera', { tip: 'Render depth of field by moving the camera across its aperture between samples (cameras with Depth of Field enabled); more samples give smoother blur' }),
        h('div', { class: 'prop-note' }, 'Focus and aperture are set on the camera (Camera ▸ Depth of Field).'),
      ],
      { closed: true },
    ),
    motionBlurPanel(r),
    panel(
      'rs-film',
      'Film',
      () => [
        num(r, 'filter_size', 'Filter Size', { min: 0, max: 100, softMax: 10, precision: 2, tip: 'Width (pixels) of the anti-aliasing filter: larger values give softer edges' }),
        bool(r, 'film_transparent', 'Transparent', { tip: 'Render the world background as transparent' }),
        sub('rs-film-overscan', 'Overscan', () => [num(r, 'overscan_size', 'Size', { min: 0, max: 50, softMax: 10, precision: 1, tip: 'Margin (percent of the frame) traced around the image: reflections and occlusion near the edges stay stable' })], {
          closed: true,
          header: headerToggle(r, 'use_overscan', 'Overscan'),
        }),
      ],
      { closed: true },
    ),
    panel('rs-perf', 'Performance', () => [performanceViewport(r)], { closed: true }),
  ];
}

function motionBlurPanel(r: RenderSettings): Child {
  return panel(
    'rs-motion',
    'Motion Blur',
    () => [
      enumProp(r, 'motion_blur_position' as never, 'Position', [['START', 'Start on Frame'], ['CENTER', 'Center on Frame'], ['END', 'End on Frame']], { tip: 'Where the shutter interval lies relative to the frame' }),
      num(r, 'motion_blur_shutter', 'Shutter', { min: 0, max: 2, softMax: 1, tip: 'Time (in frames) the shutter is open' }),
    ],
    { header: headerToggle(r, 'use_motion_blur', 'Motion Blur'), closed: true },
  );
}

/** Extra panels appended to the path tracer's Render properties (e.g. Bake). */
export const pathTraceExtraPanels: ((r: RenderSettings) => Child)[] = [];

function pathTracePanels(r: RenderSettings): Child {
  return [
    panel('rs-sampling', 'Sampling', () => [
      sub('rs-samp-vp', 'Viewport', () => [num(r, 'preview_samples', 'Max Samples', { int: true, min: 1, max: 65536, tip: 'Samples of the Rendered viewport' }), bool(r, 'preview_denoising', 'Denoise', { tip: 'Denoise the Rendered viewport' })]),
      sub('rs-samp-render', 'Render', () => [
        num(r, 'samples', 'Max Samples', { int: true, min: 1, max: 65536, tip: 'Samples per pixel of final renders' }),
        num(r, 'time_limit', 'Time Limit', { unit: 'time', min: 0, softMax: 3600, tip: 'Stop sampling after this time (0 for no limit)' }),
        bool(r, 'use_denoising', 'Denoise', { tip: 'Denoise final renders' }),
      ]),
    ]),
    panel(
      'rs-lightpaths',
      'Light Paths',
      () => [
        sub('rs-lp-bounces', 'Max Bounces', () => [
          num(r, 'max_bounces', 'Total', { int: true, min: 0, max: 1024, softMax: 64, tip: 'Total number of light bounces' }),
          num(r, 'diffuse_bounces' as never, 'Diffuse', { int: true, min: 0, max: 1024, softMax: 64 }),
          num(r, 'glossy_bounces' as never, 'Glossy', { int: true, min: 0, max: 1024, softMax: 64 }),
          num(r, 'transmission_bounces' as never, 'Transmission', { int: true, min: 0, max: 1024, softMax: 64 }),
        ]),
        sub('rs-lp-clamp', 'Clamping', () => [
          num(r, 'sample_clamp_direct', 'Direct Light', { min: 0, softMax: 100, tip: 'Limit the brightness of direct light samples to reduce noise (0 disables)' }),
          num(r, 'sample_clamp_indirect', 'Indirect Light', { min: 0, softMax: 100, tip: 'Limit the brightness of bounced light samples to reduce fireflies (0 disables)' }),
        ]),
        sub('rs-lp-caustics', 'Caustics', () => [num(r, 'blur_glossy', 'Filter Glossy', { min: 0, max: 10, tip: 'Blur glossy reflections seen after rough bounces to reduce caustic noise' })], { closed: true }),
      ],
      { closed: true },
    ),
    simplifyPanel(r),
    motionBlurPanel(r),
    panel(
      'rs-film',
      'Film',
      () => [
        num(r, 'film_exposure', 'Exposure', { min: 0, softMax: 10, tip: 'Image brightness scale' }),
        sub('rs-film-filter', 'Pixel Filter', () => [
          enumProp(r, 'pixel_filter_type' as never, 'Type', [['BOX', 'Box'], ['GAUSSIAN', 'Gaussian'], ['BLACKMAN_HARRIS', 'Blackman-Harris']], { tip: 'Shape of the anti-aliasing filter' }),
          num(r, 'filter_width', 'Width', { min: 0.01, max: 10, precision: 2, disabled: r.pixel_filter_type === 'BOX', tip: 'Width (pixels) of the anti-aliasing filter' }),
        ]),
        sub('rs-film-transparent', 'Transparent', () => h('div', { class: 'prop-note' }, 'The world background renders transparent (it still lights the scene).'), { header: headerToggle(r, 'film_transparent', 'Transparent'), closed: true }),
      ],
      { closed: true },
    ),
    panel(
      'rs-perf',
      'Performance',
      () => [
        sub('rs-perf-final', 'Final Render', () => [
          bool(r, 'use_auto_tile', 'Use Tiling', { tip: 'Render large images in tiles to keep the interface responsive' }),
          num(r, 'tile_size', 'Tile Size', { int: true, unit: 'pixel', min: 8, max: 8192, disabled: r.use_auto_tile === false }),
        ]),
        performanceViewport(r),
      ],
      { closed: true },
    ),
    pathTraceExtraPanels.map((p) => p(r)),
  ];
}

function solidPanels(r: RenderSettings): Child {
  const s = r.display_shading!;
  const set = (label: string) => changed(label);
  return [
    panel('rs-wb-light', 'Lighting', () => [
      h('div', { class: 'enum-tabs' }, enumRow('rs-wb-light-row', [{ value: 'STUDIO', label: 'Studio' }, { value: 'MATCAP', label: 'MatCap' }, { value: 'FLAT', label: 'Flat' }], s.light, (v) => ((s.light = v as typeof s.light), set('Lighting')))),
    ]),
    panel('rs-wb-color', 'Color', () => [
      enumProp(s, 'color_type', 'Color', [['MATERIAL', 'Material'], ['OBJECT', 'Object'], ['SINGLE', 'Single'], ['RANDOM', 'Random'], ['VERTEX', 'Attribute'], ['TEXTURE', 'Texture']]),
      s.color_type === 'SINGLE' ? colorProp(s, 'single_color', 'Single Color') : null,
    ]),
    panel('rs-wb-options', 'Options', () => [
      bool(s, 'show_backface_culling', 'Backface Culling'),
      bool(s, 'show_xray', 'X-Ray'),
      s.show_xray ? num(s, 'xray_alpha', 'Alpha', { min: 0, max: 1, slider: true }) : null,
      bool(s, 'show_shadows', 'Shadow'),
      bool(s, 'show_cavity', 'Cavity'),
      bool(s, 'show_object_outline', 'Outline'),
      bool(s, 'show_specular_highlight', 'Specular Lighting'),
    ]),
    panel('rs-sampling', 'Sampling', () => [num(r, 'raster_samples', 'Render', { int: true, min: 1, max: 16, tip: 'Anti-aliasing samples of final renders' })], { closed: true }),
    panel('rs-film', 'Film', () => [bool(r, 'film_transparent', 'Transparent', { tip: 'Render the background as transparent' })], { closed: true }),
  ];
}

/** Extra Render tab panels shown above Color Management (registered by feature modules). */
export const renderExtraPanels: ((r: RenderSettings) => Child)[] = [];

registerTab({
  id: 'RENDER',
  label: 'Render',
  icon: 'render',
  group: 1,
  poll: () => true,
  draw: () => {
    const r = renderSettings();
    return [
      engineRow(r),
      r.engine === 'PATHTRACE' ? pathTracePanels(r) : r.engine === 'RASTER' ? rasterPanels(r) : solidPanels(r),
      ...renderExtraPanels.map((f) => f(r)),
      colorManagementPanel(r),
    ];
  },
});

