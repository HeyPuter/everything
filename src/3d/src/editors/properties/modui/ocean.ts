// Panel of the Ocean modifier.
import { h } from '../../../ui/h';
import { num, bool, enumProp, splitRow } from '../../../ui/props';
import { enumRow, opButton } from '../../../ui/widgets';
import type { ModifierBase, ObjectData } from '../../../data/types';
import { modifierFields, modifierExtraUI } from '../stack';
import { sub, headerCheck, touch } from './kit';

type Rec = Record<string, unknown>;

const anim = (ob: ObjectData, m: ModifierBase, key: string) => ({ ob, path: `modifiers["${m.name}"].${key}` });

modifierFields.OCEAN = [];
modifierExtraUI.OCEAN = (ob, m) => {
  const r = m as Rec;
  const generate = r.geometry_mode !== 'DISPLACE';
  const jonswap = r.spectrum === 'JONSWAP' || r.spectrum === 'TEXEL_MARSEN_ARSLOE';
  return [
    splitRow(
      'Geometry',
      enumRow(
        `${m.id}.geometry_mode`,
        [
          { value: 'GENERATE', label: 'Generate' },
          { value: 'DISPLACE', label: 'Displace' },
        ],
        String(r.geometry_mode ?? 'GENERATE'),
        (v) => ((r.geometry_mode = v), touch('Change Geometry')),
      ),
    ),
    generate ? num(r, 'repeat_x', 'Repeat X', { int: true, min: 1, max: 1024, softMax: 100 }) : null,
    generate ? num(r, 'repeat_y', 'Y', { int: true, min: 1, max: 1024, softMax: 100 }) : null,
    num(r, 'time', 'Time', { min: 0, anim: anim(ob, m, 'time') }),
    num(r, 'depth', 'Depth', { unit: 'distance', min: 0, anim: anim(ob, m, 'depth') }),
    num(r, 'size', 'Size', { min: 0, anim: anim(ob, m, 'size') }),
    num(r, 'spatial_size', 'Spatial Size', { int: true, min: 1, softMax: 512 }),
    num(r, 'viewport_resolution', 'Resolution Viewport', { int: true, min: 1, max: 16 }),
    num(r, 'resolution', 'Render', { int: true, min: 1, max: 16 }),
    num(r, 'random_seed', 'Random Seed', { int: true, min: 0 }),
    bool(r, 'use_normals', 'Generate Normals'),
    sub(
      m,
      'waves',
      'Waves',
      () => [
        num(r, 'wave_scale', 'Scale', { min: 0, anim: anim(ob, m, 'wave_scale') }),
        num(r, 'wave_scale_min', 'Smallest Wave', { unit: 'distance', min: 0 }),
        num(r, 'choppiness', 'Choppiness', { min: 0, softMax: 4, anim: anim(ob, m, 'choppiness') }),
        num(r, 'wind_velocity', 'Wind Velocity', { anim: anim(ob, m, 'wind_velocity') }),
        num(r, 'wave_alignment', 'Alignment', { min: 0, max: 1, slider: true }),
        num(r, 'wave_direction', 'Direction', { unit: 'angle', disabled: !r.wave_alignment }),
        num(r, 'damping', 'Damping', { min: 0, max: 1, slider: true, disabled: !r.wave_alignment }),
      ],
      { closed: false },
    ),
    sub(m, 'spectrum', 'Spectrum', () => [
      enumProp(r, 'spectrum', 'Spectrum', [
        ['PHILLIPS', 'Turbulent Ocean'],
        ['PIERSON_MOSKOWITZ', 'Established Ocean'],
        ['JONSWAP', 'Established Ocean (Sharp Peaks)'],
        ['TEXEL_MARSEN_ARSLOE', 'Shallow Water'],
      ]),
      jonswap ? num(r, 'sharpen_peak_jonswap', 'Sharpen Peak', { min: 0, max: 1, slider: true }) : null,
      jonswap ? num(r, 'fetch_jonswap', 'Fetch', { min: 0 }) : null,
    ]),
    sub(m, 'foam', 'Foam', () => [num(r, 'foam_coverage', 'Coverage', { disabled: !r.use_foam }), h('div', { class: 'mod-note' }, r.use_spray ? 'Foam is written to the alpha of the color attribute.' : 'Foam is written to the color attribute.')], { header: headerCheck(m, 'use_foam', 'Foam') }),
    sub(m, 'spray', 'Spray', () => [bool(r, 'invert_spray', 'Invert', { disabled: !r.use_spray, tip: 'Point the spray vectors the other way' }), h('div', { class: 'mod-note' }, 'Spray directions (where the waves push together) are written to the red and green of the color attribute.')], { header: headerCheck(m, 'use_spray', 'Spray'), closed: true }),
    sub(m, 'bake', 'Bake', () => {
      const cached = !!r.is_cached;
      return [
        num(r, 'frame_start', 'Frame Start', { int: true, disabled: cached }),
        num(r, 'frame_end', 'End', { int: true, min: (r.frame_start as number) ?? 1, disabled: cached }),
        num(r, 'bake_foam_fade', 'Foam Fade', { min: 0, max: 1, slider: true, disabled: cached || !r.use_foam, tip: 'How much of the previous frame\'s foam stays (foam builds up over time in a bake)' }),
        h(
          'div',
          { class: 'row-aligned', style: { padding: '2px 8px' } },
          cached ? opButton('object.ocean_bake', 'Delete Bake', { modifier: m.name, free: true }) : opButton('object.ocean_bake', 'Bake', { modifier: m.name, free: false }, { tip: 'Bake the ocean for the frame range' }),
        ),
      ];
    }, { closed: true }),
  ];
};
