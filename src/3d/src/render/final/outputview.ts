// Output ▸ Output ▸ Color Management: saved images follow the scene's view settings, or their own.
import type { RenderSettings } from '../../data/types';
import type { ViewSettings } from './colormanage';

export interface OutputViewSettings {
  /** FOLLOW_SCENE: the scene's view transform; OVERRIDE: `image_view_settings` */
  image_color_management?: 'FOLLOW_SCENE' | 'OVERRIDE';
  image_view_settings?: ViewSettings;
}

/** View settings used when writing render output (a result's own view, e.g. solid renders, wins). */
export function outputView(r: RenderSettings, resultView?: ViewSettings): ViewSettings {
  if (resultView) return resultView;
  const o = r as RenderSettings & OutputViewSettings;
  if (o.image_color_management === 'OVERRIDE' && o.image_view_settings) return o.image_view_settings;
  return r;
}

/** Override settings, created from the scene's when first needed. */
export function outputViewSettings(r: RenderSettings): ViewSettings {
  const o = r as RenderSettings & OutputViewSettings;
  o.image_view_settings ??= { view_transform: r.view_transform, look: r.look, exposure: r.exposure, gamma: r.gamma };
  return o.image_view_settings;
}
