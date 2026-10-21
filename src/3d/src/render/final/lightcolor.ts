// Light colour options shared by the render engines: colour temperature (black body) and
// exposure (stops), applied on top of the light's colour.
import type { Color } from 'three';
import type { LightData } from '../../data/types';
import { blackbodyToRgb } from '../../nodes/curves';
import { lightTintHooks } from './renderscene';
import { sceneLightTintHooks } from '../scene';

/** Linear RGB of a black body at `kelvin` with unit luminance (brightness stays the same). */
export function temperatureColor(kelvin: number): [number, number, number] {
  const c = blackbodyToRgb(kelvin);
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return y > 0 ? [c[0] / y, c[1] / y, c[2] / y] : [1, 1, 1];
}

/** Multiplier of the light colour from its temperature and exposure (null when neutral). */
export function lightColorScale(la: Pick<LightData, 'use_temperature' | 'temperature' | 'exposure'>): [number, number, number] | null {
  const e = la.exposure ? Math.pow(2, la.exposure) : 1;
  if (!la.use_temperature && e === 1) return null;
  const t = la.use_temperature ? temperatureColor(la.temperature ?? 6500) : [1, 1, 1];
  return [t[0] * e, t[1] * e, t[2] * e];
}

export function tintLight(la: LightData, color: Color) {
  const s = lightColorScale(la);
  if (s) color.setRGB(color.r * s[0], color.g * s[1], color.b * s[2]);
}

lightTintHooks.push(tintLight);
sceneLightTintHooks.push(tintLight);

/** Fill the colour options missing from older documents (the Light panel edits them). */
export function ensureLightColorDefaults(la: LightData) {
  la.use_temperature ??= false;
  la.temperature ??= 6500;
  la.exposure ??= 0;
  la.normalize ??= true;
  la.spread ??= Math.PI;
}
