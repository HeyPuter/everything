// Parameter model for every color adjustment. One plain, JSON-friendly object
// per kind (except a parsed `lut` look source) so adjustment layers can be
// stored, diffed and re-rendered. Units:
// percentages are -100..100, levels are 0..255 codes, hues are degrees.
import type { Gradient, RGB8 } from './gradient-stops';
import { twoColorGradient } from './gradient-stops';
import type { CubeLut } from './cube';
import type { BuiltinLookId } from './looks';
import { defaultRelightParams, type RelightParams } from '../relight/model';
export type { RelightParams } from '../relight/model';

export type ChannelKey = 'rgb' | 'r' | 'g' | 'b';
export type PerChannel<T> = Record<ChannelKey, T>;

export type BrightnessContrastParams = {
  brightness: number; // -150..150 (legacy: -100..100)
  contrast: number; // -50..100 (legacy: -100..100)
  legacy: boolean;
};

export type LevelsChannel = {
  inBlack: number; // 0..253
  inWhite: number; // 2..255
  gamma: number; // 0.01..9.99, >1 brightens midtones
  outBlack: number; // 0..255
  outWhite: number; // 0..255
};
export type LevelsParams = PerChannel<LevelsChannel>;

export type CurveChannel = {
  // 'points': monotone cubic through `points`; 'pencil': `values` drawn freely.
  mode: 'points' | 'pencil';
  points: [number, number][]; // input, output in 0..255
  values?: number[]; // 256 outputs in 0..255 for pencil mode
};
export type CurvesParams = PerChannel<CurveChannel>;

export type ExposureParams = {
  exposure: number; // stops, -20..20
  offset: number; // -0.5..0.5 added in linear light
  gamma: number; // 0.01..9.99
};

export type VibranceParams = { vibrance: number; saturation: number }; // -100..100

export const HUE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const;
export type HueRangeName = (typeof HUE_RANGES)[number];
export type HueSatAmounts = { hue: number; saturation: number; lightness: number };
// range: [falloff start, full start, full end, falloff end] in degrees; may wrap.
export type HueSatRange = HueSatAmounts & { range: [number, number, number, number] };
export type HueSaturationParams = {
  master: HueSatAmounts; // hue -180..180, saturation -100..100, lightness -100..100
  ranges: Record<HueRangeName, HueSatRange>;
  colorize: boolean;
  colorizeHue: number; // 0..360
  colorizeSaturation: number; // 0..100; master.lightness also applies
};

export type ToneTriple = [number, number, number]; // cyan-red, magenta-green, yellow-blue, -100..100
export type ColorBalanceParams = {
  shadows: ToneTriple;
  midtones: ToneTriple;
  highlights: ToneTriple;
  preserveLuminosity: boolean;
};

export type BlackWhiteParams = Record<HueRangeName, number> & {
  // Percent contribution of each hue to the gray value, -200..300.
  tint: boolean;
  tintHue: number; // 0..360
  tintSaturation: number; // 0..100
};

export type PhotoFilterPreset = 'warming' | 'warming-strong' | 'cooling' | 'cooling-strong' | 'sepia' | 'deep-water' | 'custom';
export type PhotoFilterParams = {
  preset: PhotoFilterPreset;
  color: RGB8; // the filter color actually applied (presets fill it in)
  density: number; // 0..100
  preserveLuminosity: boolean;
};

export type MixerRow = { r: number; g: number; b: number; constant: number }; // -200..200 percent
export type ChannelMixerParams = { red: MixerRow; green: MixerRow; blue: MixerRow; gray: MixerRow; monochrome: boolean };

export type LookSource =
  | { type: 'builtin'; id: BuiltinLookId }
  | { type: 'cube'; name: string; text: string }
  | { type: 'lut'; name: string; lut: CubeLut };
export type ColorLookupParams = { source: LookSource | null; amount: number }; // amount 0..100

export type InvertParams = Record<string, never>;
export type PosterizeParams = { levels: number }; // 2..255
export type ThresholdParams = { level: number }; // 1..255
export type GradientMapParams = { gradient: Gradient; reverse: boolean; dither: boolean };

export const SELECTIVE_RANGES = [...HUE_RANGES, 'whites', 'neutrals', 'blacks'] as const;
export type SelectiveRangeName = (typeof SELECTIVE_RANGES)[number];
export type CmykAmounts = { cyan: number; magenta: number; yellow: number; black: number }; // -100..100
export type SelectiveColorParams = {
  ranges: Record<SelectiveRangeName, CmykAmounts>;
  method: 'relative' | 'absolute';
};

// Combined tone controls (one global tone curve): exposure in stops -5..5,
// the others -100..100.
export type LightToneParams = { exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number };
// White balance shift and color intensity, -100..100 each.
export type ColorVibranceParams = { temperature: number; tint: number; vibrance: number; saturation: number };
// Spatial kinds: local contrast and haze removal, -100..100 each.
export type ClarityDehazeParams = { clarity: number; dehaze: number };
// Film grain: amount, size, roughness and color, 0..100 each.
export type GrainParams = { amount: number; size: number; roughness: number; color: number };

export type AdjustmentParamsMap = {
  'brightness-contrast': BrightnessContrastParams;
  levels: LevelsParams;
  curves: CurvesParams;
  exposure: ExposureParams;
  vibrance: VibranceParams;
  'hue-saturation': HueSaturationParams;
  'color-balance': ColorBalanceParams;
  'black-white': BlackWhiteParams;
  'photo-filter': PhotoFilterParams;
  'channel-mixer': ChannelMixerParams;
  'color-lookup': ColorLookupParams;
  invert: InvertParams;
  posterize: PosterizeParams;
  threshold: ThresholdParams;
  'gradient-map': GradientMapParams;
  'selective-color': SelectiveColorParams;
  'light-tone': LightToneParams;
  'color-vibrance': ColorVibranceParams;
  'clarity-dehaze': ClarityDehazeParams;
  grain: GrainParams;
  relight: RelightParams;
};
export type AdjustmentKind = keyof AdjustmentParamsMap;
export type Adjustment = { [K in AdjustmentKind]: { kind: K; params: AdjustmentParamsMap[K] } }[AdjustmentKind];
export type AdjustmentOf<K extends AdjustmentKind> = Extract<Adjustment, { kind: K }>;

export const ADJUSTMENT_KINDS: AdjustmentKind[] = [
  'brightness-contrast',
  'levels',
  'curves',
  'exposure',
  'vibrance',
  'hue-saturation',
  'color-balance',
  'black-white',
  'photo-filter',
  'channel-mixer',
  'color-lookup',
  'invert',
  'posterize',
  'threshold',
  'gradient-map',
  'selective-color',
  'light-tone',
  'color-vibrance',
  'clarity-dehaze',
  'grain',
  'relight',
];
// Kinds that look at neighboring pixels or the pixel position: they have no
// color table, so the compositor and the CPU path run them as image filters.
export const SPATIAL_KINDS: readonly AdjustmentKind[] = ['clarity-dehaze', 'grain', 'relight'];
// Kinds that are made only as layers (no destructive Image > Adjustments command).
export const LAYER_ONLY_KINDS: readonly AdjustmentKind[] = ['relight'];
export const isSpatialKind = (k: string) => (SPATIAL_KINDS as readonly string[]).includes(k);
export const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = {
  'brightness-contrast': 'Brightness/Contrast',
  levels: 'Levels',
  curves: 'Curves',
  exposure: 'Exposure',
  vibrance: 'Vibrance',
  'hue-saturation': 'Hue/Saturation',
  'color-balance': 'Color Balance',
  'black-white': 'Black & White',
  'photo-filter': 'Photo Filter',
  'channel-mixer': 'Channel Mixer',
  'color-lookup': 'Color Lookup',
  invert: 'Invert',
  posterize: 'Posterize',
  threshold: 'Threshold',
  'gradient-map': 'Gradient Map',
  'selective-color': 'Selective Color',
  'light-tone': 'Light & Tone',
  'color-vibrance': 'Color & Vibrance',
  'clarity-dehaze': 'Clarity & Dehaze',
  grain: 'Grain',
  relight: 'Relight',
};

// Six 60-degree sectors whose falloffs cross at 50 percent, so the weights of
// neighboring ranges always sum to one.
export const DEFAULT_HUE_RANGES: Record<HueRangeName, [number, number, number, number]> = {
  reds: [315, 345, 15, 45],
  yellows: [15, 45, 75, 105],
  greens: [75, 105, 135, 165],
  cyans: [135, 165, 195, 225],
  blues: [195, 225, 255, 285],
  magentas: [255, 285, 315, 345],
};

// Original filter colors (approximations of common optical filter tints).
export const PHOTO_FILTER_PRESETS: Record<Exclude<PhotoFilterPreset, 'custom'>, { label: string; color: RGB8 }> = {
  warming: { label: 'Warming', color: [238, 150, 40] },
  'warming-strong': { label: 'Warming (strong)', color: [230, 112, 20] },
  cooling: { label: 'Cooling', color: [40, 120, 240] },
  'cooling-strong': { label: 'Cooling (strong)', color: [10, 80, 235] },
  sepia: { label: 'Sepia', color: [170, 120, 60] },
  'deep-water': { label: 'Deep Water', color: [0, 170, 160] },
};

// Black & White weights that reproduce Rec. 709 luma exactly for every color:
// each secondary weight equals the sum of its two primaries.
export const LUMA_GRAY_WEIGHTS: Record<HueRangeName, number> = {
  reds: 21.26,
  yellows: 92.78,
  greens: 71.52,
  cyans: 78.74,
  blues: 7.22,
  magentas: 28.48,
};

const levelsChannel = (): LevelsChannel => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
const curveChannel = (): CurveChannel => ({ mode: 'points', points: [[0, 0], [255, 255]] });
const mixerRow = (r: number, g: number, b: number): MixerRow => ({ r, g, b, constant: 0 });
const cmyk = (): CmykAmounts => ({ cyan: 0, magenta: 0, yellow: 0, black: 0 });
const perRange = <T>(make: (name: HueRangeName) => T) =>
  Object.fromEntries(HUE_RANGES.map((n) => [n, make(n)])) as Record<HueRangeName, T>;

export function defaultParams<K extends AdjustmentKind>(kind: K): AdjustmentParamsMap[K] {
  const make: { [P in AdjustmentKind]: () => AdjustmentParamsMap[P] } = {
    'brightness-contrast': () => ({ brightness: 0, contrast: 0, legacy: false }),
    levels: () => ({ rgb: levelsChannel(), r: levelsChannel(), g: levelsChannel(), b: levelsChannel() }),
    curves: () => ({ rgb: curveChannel(), r: curveChannel(), g: curveChannel(), b: curveChannel() }),
    exposure: () => ({ exposure: 0, offset: 0, gamma: 1 }),
    vibrance: () => ({ vibrance: 0, saturation: 0 }),
    'hue-saturation': () => ({
      master: { hue: 0, saturation: 0, lightness: 0 },
      ranges: perRange((n) => ({ hue: 0, saturation: 0, lightness: 0, range: [...DEFAULT_HUE_RANGES[n]] as HueSatRange['range'] })),
      colorize: false,
      colorizeHue: 30,
      colorizeSaturation: 25,
    }),
    'color-balance': () => ({ shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true }),
    'black-white': () => ({ ...LUMA_GRAY_WEIGHTS, tint: false, tintHue: 35, tintSaturation: 25 }),
    'photo-filter': () => ({
      preset: 'warming',
      color: [...PHOTO_FILTER_PRESETS.warming.color] as RGB8,
      density: 25,
      preserveLuminosity: true,
    }),
    'channel-mixer': () => ({
      red: mixerRow(100, 0, 0),
      green: mixerRow(0, 100, 0),
      blue: mixerRow(0, 0, 100),
      gray: mixerRow(30, 59, 11),
      monochrome: false,
    }),
    'color-lookup': () => ({ source: null, amount: 100 }),
    invert: () => ({}),
    posterize: () => ({ levels: 4 }),
    threshold: () => ({ level: 128 }),
    'gradient-map': () => ({ gradient: twoColorGradient([0, 0, 0], [255, 255, 255]), reverse: false, dither: false }),
    'selective-color': () => ({
      ranges: Object.fromEntries(SELECTIVE_RANGES.map((n) => [n, cmyk()])) as Record<SelectiveRangeName, CmykAmounts>,
      method: 'relative',
    }),
    'light-tone': () => ({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 }),
    'color-vibrance': () => ({ temperature: 0, tint: 0, vibrance: 0, saturation: 0 }),
    'clarity-dehaze': () => ({ clarity: 0, dehaze: 0 }),
    grain: () => ({ amount: 25, size: 25, roughness: 50, color: 0 }),
    relight: () => defaultRelightParams(),
  };
  return make[kind]() as AdjustmentParamsMap[K];
}

export function defaultAdjustment<K extends AdjustmentKind>(kind: K): AdjustmentOf<K> {
  return { kind, params: defaultParams(kind) } as unknown as AdjustmentOf<K>;
}

// Deep copy that keeps typed arrays and parsed LUT objects intact.
export function cloneAdjustment<A extends Adjustment>(adj: A): A {
  return structuredClone(adj);
}
