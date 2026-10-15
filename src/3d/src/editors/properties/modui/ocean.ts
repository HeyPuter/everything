// Panel of the Ocean modifier.
import { h } from '../../../ui/h';
import { num, bool, enumProp, splitRow } from '../../../ui/props';
import { enumRow } from '../../../ui/widgets';
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
    sub(m, 'foam', 'Foam', () => [num(r, 'foam_coverage', 'Coverage', { disabled: !r.use_foam }), h('div', { class: 'mod-note' }, 'Foam is written to the vertex colors.')], { header: headerCheck(m, 'use_foam', 'Foam') }),
  ];
};
