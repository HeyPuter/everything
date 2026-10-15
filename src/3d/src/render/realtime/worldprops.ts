// World ▸ Settings of the realtime engine: the sun extracted from the world's lighting and its
// shadow.
import { app, onAppReady } from '../../app/app';
import { propertiesTabs } from '../../editors/properties/properties';
import { panel } from '../../ui/widgets';
import { num, bool } from '../../ui/props';
import type { Child } from '../../ui/h';
import type { WorldData } from '../../data/types';
import { headerToggle, sub } from '../final/props/common';

export function ensureWorldDefaults(w: WorldData) {
  w.sun_threshold ??= 10;
  w.sun_angle ??= (0.526 * Math.PI) / 180;
  w.use_sun_shadow ??= true;
  w.sun_shadow_filter_radius ??= 1;
  w.sun_shadow_maximum_resolution ??= 0.001;
  w.use_sun_shadow_jitter ??= false;
  w.sun_shadow_jitter_overblur ??= 10;
}

export function worldSettingsPanel(w: WorldData): Child {
  ensureWorldDefaults(w);
  return panel(
    'wo-rt-settings',
    'Settings',
    () => [
      sub('wo-rt-sun', 'Sun', () => [
        num(w, 'sun_threshold', 'Threshold', { min: 0, softMax: 100, tip: 'World light brighter than this becomes a sun light with shadows (0 turns it off)' }),
        num(w, 'sun_angle', 'Angle', { unit: 'angle', min: 0, max: Math.PI, tip: 'Angular diameter of the extracted sun: softens its shadows' }),
        sub(
          'wo-rt-sun-shadow',
          'Shadow',
          () => [
            bool(w, 'use_sun_shadow_jitter', 'Jitter', { tip: 'Move the shadow across the sun’s angle from sample to sample' }),
            num(w, 'sun_shadow_jitter_overblur', 'Overblur', { min: 0, max: 100, softMax: 20, disabled: !w.use_sun_shadow_jitter, tip: 'Extra blur (percent) hiding the steps between jittered samples' }),
            num(w, 'sun_shadow_filter_radius', 'Filter', { min: 0, softMax: 5, tip: 'Blur of the shadow map lookups' }),
            num(w, 'sun_shadow_maximum_resolution', 'Resolution Limit', { unit: 'distance', min: 0, softMax: 0.02, precision: 4, tip: 'Smallest size of a shadow map texel' }),
          ],
          { header: headerToggle(w, 'use_sun_shadow', 'Sun Shadow') },
        ),
      ]),
    ],
    { closed: true },
  );
}

onAppReady(() => {
  const tab = propertiesTabs.find((t) => t.id === 'WORLD');
  if (!tab) return;
  const draw = tab.draw;
  tab.draw = (p) => {
    const doc = app.doc;
    const w = doc.scene.world ? doc.worlds[doc.scene.world] : null;
    return [draw(p), w && doc.scene.render.engine === 'RASTER' ? worldSettingsPanel(w) : null];
  };
});
