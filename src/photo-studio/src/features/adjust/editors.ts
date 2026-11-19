// One editor per adjustment kind, shared by the Properties panel and the
// destructive Image > Adjustments dialogs.
import type { KindEditors } from './host';
import {
  blackWhiteEditor,
  brightnessContrastEditor,
  channelMixerEditor,
  colorBalanceEditor,
  colorLookupEditor,
  exposureEditor,
  invertEditor,
  photoFilterEditor,
  posterizeEditor,
  selectiveColorEditor,
  thresholdEditor,
  vibranceEditor,
  lightToneEditor,
  colorVibranceEditor,
  clarityDehazeEditor,
  grainEditor,
} from './editors-basic';
import { levelsEditor } from './levels';
import { curvesEditor } from './curves';
import { hueSaturationEditor } from './hue-sat';
import { gradientMapEditor } from './gradient-map';
import { relightEditor } from './relight-editor';

export const kindEditors: KindEditors = {
  'brightness-contrast': brightnessContrastEditor,
  levels: levelsEditor,
  curves: curvesEditor,
  exposure: exposureEditor,
  vibrance: vibranceEditor,
  'hue-saturation': hueSaturationEditor,
  'color-balance': colorBalanceEditor,
  'black-white': blackWhiteEditor,
  'photo-filter': photoFilterEditor,
  'channel-mixer': channelMixerEditor,
  'color-lookup': colorLookupEditor,
  invert: invertEditor,
  posterize: posterizeEditor,
  threshold: thresholdEditor,
  'gradient-map': gradientMapEditor,
  'selective-color': selectiveColorEditor,
  'light-tone': lightToneEditor,
  'color-vibrance': colorVibranceEditor,
  'clarity-dehaze': clarityDehazeEditor,
  grain: grainEditor,
  relight: relightEditor,
};

export { kindIcon } from './icons';
