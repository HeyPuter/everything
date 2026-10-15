// Material ▸ Settings (Properties editor and the Shader Editor sidebar): how a surface renders in
// the realtime engine — dithered or blended transparency, backface culling, shadows, refraction.
import { h, type Child } from '../../ui/h';
import { panel, enumMenu } from '../../ui/widgets';
import { num, bool, splitRow } from '../../ui/props';
import { app } from '../../app/app';
import type { MaterialData } from '../../data/types';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

/** Render Method shown for a blend mode: everything but blending is dithered. */
export function renderMethod(ma: Pick<MaterialData, 'blend_method'>): 'DITHERED' | 'BLENDED' {
  return ma.blend_method === 'BLEND' ? 'BLENDED' : 'DITHERED';
}

/** Blend mode after choosing a render method (dithered keeps an alpha clip set by older files). */
export function blendForMethod(ma: Pick<MaterialData, 'blend_method'>, method: 'DITHERED' | 'BLENDED'): MaterialData['blend_method'] {
  if (method === 'BLENDED') return 'BLEND';
  return ma.blend_method === 'BLEND' ? 'HASHED' : ma.blend_method;
}

/** Shadow mode shown for a material (older Alpha Clip shadows count as transparent). */
export function shadowMode(ma: Pick<MaterialData, 'shadow_method'>): 'NONE' | 'OPAQUE' | 'TRANSPARENT' {
  const m = ma.shadow_method ?? 'OPAQUE';
  return m === 'NONE' ? 'NONE' : m === 'OPAQUE' ? 'OPAQUE' : 'TRANSPARENT';
}

function enumRow(id: string, label: string, items: [string, string, string][], value: string, set: (v: string) => void): Child {
  return splitRow(label, enumMenu(id, items.map(([v, l, d]) => ({ value: v, label: l, description: d })), value, set));
}

/** The Settings panel with its Surface sub-panel; `prefix` keeps panel ids apart per editor. */
export function materialSettingsPanel(ma: MaterialData, prefix = 'ma'): Child {
  return panel(
    `${prefix}-settings`,
    'Settings',
    () => [
      num(ma as never, 'pass_index' as never, 'Pass Index', { int: true, min: 0, max: 32767, tip: 'Index of the material in the Material Index pass' }),
      panel(
        `${prefix}-settings-surface`,
        'Surface',
        () => [
          enumRow(
            `${prefix}-render-method`,
            'Render Method',
            [
              ['DITHERED', 'Dithered', 'Transparency by a stochastic pattern that averages out over samples; correct depth sorting'],
              ['BLENDED', 'Blended', 'Transparency by blending over what is behind; sorted per object'],
            ],
            renderMethod(ma),
            (v) => {
              ma.blend_method = blendForMethod(ma, v as 'DITHERED' | 'BLENDED');
              changed('Render Method');
            },
          ),
          ma.blend_method === 'BLEND' ? bool(ma as never, 'show_transparent_back' as never, 'Transparency Overlap', { tip: 'Show the back of the surface through its front (off: only the nearest layer)' }) : null,
          ma.blend_method === 'CLIP' ? num(ma, 'alpha_threshold', 'Clip Threshold', { min: 0, max: 1, slider: true, tip: 'Alpha below which the surface is cut away' }) : null,
          h('div', { class: 'sub-label' }, 'Backface Culling'),
          bool(ma, 'use_backface_culling', 'Camera', { tip: 'Hide the back of faces as seen by the camera' }),
          bool(ma, 'use_backface_culling_shadow', 'Shadow', { tip: 'Back faces do not cast shadows' }),
          enumRow(
            `${prefix}-shadow-mode`,
            'Shadow Mode',
            [
              ['NONE', 'None', 'The surface casts no shadow'],
              ['OPAQUE', 'Opaque', 'The whole surface casts shadow'],
              ['TRANSPARENT', 'Transparent', 'Transparent parts of the surface let light through'],
            ],
            shadowMode(ma),
            (v) => {
              ma.shadow_method = v === 'NONE' ? 'NONE' : v === 'OPAQUE' ? 'OPAQUE' : 'HASHED';
              changed('Shadow Mode');
            },
          ),
          bool(ma, 'use_raytrace_refraction', 'Raytraced Transmission', { tip: 'Refraction shows what is behind the surface on screen (off: only light probes and the world)' }),
          num(ma, 'refraction_depth', 'Refraction Depth', { unit: 'distance', min: 0, softMax: 10, tip: 'Thickness of refractive objects, offsetting what is seen through them (0: automatic)' }),
        ],
        { sub: true },
      ),
    ],
    // closed in the Properties editor, open in the Shader Editor sidebar
    { closed: prefix === 'ma' },
  );
}

/** Fill fields older materials lack (the settings panel edits them). */
export function ensureMaterialDefaults(ma: MaterialData) {
  ma.use_backface_culling_shadow ??= false;
  ma.use_raytrace_refraction ??= true;
  ma.refraction_depth ??= 0;
  ma.pass_index ??= 0;
  ma.show_transparent_back ??= true;
  ma.shadow_method ??= 'OPAQUE';
}
