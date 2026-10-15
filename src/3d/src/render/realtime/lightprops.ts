// Light ▸ sub-panels of the realtime engine: Influence, Shadow and Custom Distance.
import { h, type Child } from '../../ui/h';
import { checkbox } from '../../ui/widgets';
import { num, bool } from '../../ui/props';
import { app } from '../../app/app';
import type { LightData, ObjectData } from '../../data/types';
import { sub } from '../final/props/common';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

export function lightInfluencePanel(o: ObjectData, la: LightData): Child {
  const anim = (path: string) => ({ ob: o, path: `data.${path}` });
  return sub('la-influence', 'Influence', () => [
    num(la, 'diffuse_factor', 'Diffuse', { min: 0, softMax: 1, slider: true, anim: anim('diffuse_factor'), tip: 'Multiplier of the light on diffuse surfaces' }),
    num(la, 'specular_factor', 'Glossy', { min: 0, softMax: 1, slider: true, anim: anim('specular_factor'), tip: 'Multiplier of the light in glossy reflections' }),
    num(la, 'volume_factor', 'Volume Scatter', { min: 0, softMax: 1, slider: true, anim: anim('volume_factor'), tip: 'Multiplier of the light scattered by volumes (smoke)' }),
  ]);
}

export function lightShadowPanel(la: LightData): Child {
  const area = la.type === 'AREA';
  return sub(
    'la-shadow',
    'Shadow',
    () => [
      bool(la, 'use_shadow_jitter', 'Jitter', { tip: 'Move the shadow across the light’s size from sample to sample for accurate soft shadows (needs several samples)' }),
      num(la, 'shadow_jitter_overblur', 'Overblur', { min: 0, max: 100, softMax: 20, precision: 1, disabled: !la.use_shadow_jitter, tip: 'Extra blur (percent) that hides the steps between jittered samples' }),
      num(la, 'shadow_filter_radius', 'Filter', { min: 0, softMax: 5, tip: 'Blur of the shadow map lookups' }),
      num(la, 'shadow_maximum_resolution', 'Resolution Limit', { unit: 'distance', min: 0, softMax: 0.02, precision: 4, tip: 'Smallest size of a shadow map texel: larger values use smaller, blurrier shadow maps' }),
      bool(la, 'use_absolute_resolution', 'Absolute Resolution', { disabled: la.type === 'SUN', tip: 'The limit applies one unit away from the light instead of at the shadowed surfaces' }),
      num(la as never, 'shadow_buffer_bias' as never, 'Bias', { min: 0, tip: 'Offset of the shadow map to avoid self-shadowing artifacts' }),
      area ? h('div', { class: 'prop-note' }, 'Area lights do not cast shadows in the realtime engine.') : null,
    ],
    { header: checkbox('la-shadow-on', '', la.use_shadow, (v) => ((la.use_shadow = v), changed('Light Shadow'))) },
  );
}

export function lightDistancePanel(la: LightData): Child {
  return sub('la-cutoff', 'Custom Distance', () => [num(la as never, 'cutoff_distance' as never, 'Distance', { unit: 'distance', min: 0, tip: 'Distance at which the light stops influencing surfaces' })], {
    closed: true,
    header: checkbox('la-cut-on', '', !!la.use_custom_distance, (v) => ((la.use_custom_distance = v), changed('Custom Distance'))),
  });
}

/** Fill realtime light fields missing from older documents (the panels edit them). */
export function ensureLightDefaults(la: LightData) {
  la.use_shadow_jitter ??= false;
  la.shadow_jitter_overblur ??= 10;
  la.shadow_filter_radius ??= 1;
  la.shadow_maximum_resolution ??= 0.001;
  la.use_absolute_resolution ??= false;
  la.shadow_buffer_bias ??= 1;
}
