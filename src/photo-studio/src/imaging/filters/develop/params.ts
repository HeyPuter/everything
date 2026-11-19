// Develop settings: every parameter with its range and default, the panels
// they belong to (shared by the workspace UI and the pipeline's on/off
// switches), and migration of settings saved by earlier versions.
//
// Version 1 (the first Develop filter) had white balance, tone, presence,
// a circular vignette that scaled linear light and grain. Version 2 keeps
// those keys and meanings and adds the rest; a version 1 vignette maps to
// the round, color-priority style with the same falloff, so old Live Filters
// and recorded actions render as before.
import type { NormPath, ParamSpec, ParamValues } from '../../types';

export const DEVELOP_VERSION = 2;

type NumDef = [
  key: string,
  label: string,
  min: number,
  max: number,
  def?: number,
  step?: number,
  unit?: string,
];
const n = ([key, label, min, max, def = 0, step = 1, unit]: NumDef): ParamSpec => ({
  key,
  label,
  type: 'number',
  min,
  max,
  step,
  default: def,
  ...(unit ? { unit } : {}),
});
const sel = (key: string, label: string, options: [string, string][], def: string): ParamSpec => ({
  key,
  label,
  type: 'select',
  options: options.map(([value, l]) => ({ value, label: l })),
  default: def,
});
const check = (key: string, label: string, def = true): ParamSpec => ({
  key,
  label,
  type: 'checkbox',
  default: def,
});
const curve = (key: string, label: string): ParamSpec => ({
  key,
  label,
  type: 'paths',
  default: [],
  limit: 1,
});

/** The eight hue bands of the Color Mixer, centered on these hues (degrees). */
export const BANDS = [
  { id: 'Red', hue: 0 },
  { id: 'Orange', hue: 30 },
  { id: 'Yellow', hue: 60 },
  { id: 'Green', hue: 120 },
  { id: 'Aqua', hue: 180 },
  { id: 'Blue', hue: 225 },
  { id: 'Purple', hue: 270 },
  { id: 'Magenta', hue: 315 },
] as const;
export type BandId = (typeof BANDS)[number]['id'];

export const PROFILES: { id: string; label: string; mono?: boolean }[] = [
  { id: 'natural', label: 'Natural' },
  { id: 'vivid', label: 'Vivid' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'landscape', label: 'Landscape' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'faded', label: 'Faded' },
  { id: 'mono', label: 'Monochrome', mono: true },
  { id: 'mono-contrast', label: 'Monochrome High Contrast', mono: true },
  { id: 'mono-soft', label: 'Monochrome Soft', mono: true },
  { id: 'mono-warm', label: 'Monochrome Warm', mono: true },
];
export const isMonoProfile = (id: unknown) => PROFILES.some((p) => p.id === id && p.mono);

export const WB_PRESETS: [string, string][] = [
  ['as-shot', 'As Shot'],
  ['auto', 'Auto'],
  ['daylight', 'Daylight'],
  ['cloudy', 'Cloudy'],
  ['shade', 'Shade'],
  ['tungsten', 'Tungsten'],
  ['fluorescent', 'Fluorescent'],
  ['flash', 'Flash'],
  ['custom', 'Custom'],
];
/** Temperature and tint for the fixed presets of an already-rendered image
 * (relative shifts; As Shot is no change). */
export const WB_SHIFTS: Record<string, [number, number]> = {
  'as-shot': [0, 0],
  daylight: [6, 2],
  cloudy: [18, 4],
  shade: [30, 6],
  tungsten: [-45, 6],
  fluorescent: [-30, 22],
  flash: [10, 2],
};

const mixer = BANDS.flatMap((b) => [
  n([`hue${b.id}`, `${b.id} hue`, -100, 100]),
  n([`sat${b.id}`, `${b.id} saturation`, -100, 100]),
  n([`lum${b.id}`, `${b.id} luminance`, -100, 100]),
]);
const grayMix = BANDS.map((b) => n([`gray${b.id}`, `${b.id} gray mix`, -100, 100]));
const wheel = (id: string, label: string) => [
  n([`grade${id}Hue`, `${label} hue`, 0, 360, 0, 1, '°']),
  n([`grade${id}Sat`, `${label} saturation`, 0, 100]),
  n([`grade${id}Lum`, `${label} luminance`, -100, 100]),
];

// ---------- Local adjustment masks (masks.ts renders them) ----------
export type MaskType = 'off' | 'linear' | 'radial' | 'brush';
export const MASK_SLOTS = 4;
export const MASK_ADJUST: [
  suffix: string,
  label: string,
  min: number,
  max: number,
  step: number,
][] = [
  ['Exposure', 'Exposure', -4, 4, 0.05],
  ['Contrast', 'Contrast', -100, 100, 1],
  ['Highlights', 'Highlights', -100, 100, 1],
  ['Shadows', 'Shadows', -100, 100, 1],
  ['Temperature', 'Temperature', -100, 100, 1],
  ['Tint', 'Tint', -100, 100, 1],
  ['Saturation', 'Saturation', -100, 100, 1],
];

/** Settings of one mask slot (n from 1). */
export function maskSpecs(n: number): ParamSpec[] {
  const k = (s: string) => `mask${n}${s}`;
  const nm = (
    key: string,
    label: string,
    min: number,
    max: number,
    def: number,
    step = 1,
  ): ParamSpec => ({
    key: k(key),
    label: `Mask ${n} ${label}`,
    type: 'number',
    min,
    max,
    step,
    default: def,
  });
  return [
    {
      key: k('Type'),
      label: `Mask ${n} type`,
      type: 'select',
      options: [
        { value: 'off', label: 'None' },
        { value: 'linear', label: 'Linear Gradient' },
        { value: 'radial', label: 'Radial Gradient' },
        { value: 'brush', label: 'Brush' },
      ],
      default: 'off',
    },
    nm('Ax', 'start x', 0, 1, 0.5, 0.001),
    nm('Ay', 'start y', 0, 1, 0.3, 0.001),
    nm('Bx', 'end x', 0, 1, 0.5, 0.001),
    nm('By', 'end y', 0, 1, 0.7, 0.001),
    nm('Feather', 'feather', 0, 100, 50),
    nm('Amount', 'amount', 0, 100, 100),
    { key: k('Invert'), label: `Mask ${n} invert`, type: 'checkbox', default: false },
    { key: k('Strokes'), label: `Mask ${n} brush strokes`, type: 'paths', default: [], limit: 256 },
    ...MASK_ADJUST.map(([s, label, min, max, step]) =>
      nm(s, label.toLowerCase(), min, max, 0, step),
    ),
  ];
}
export const maskKeys = (n: number) => maskSpecs(n).map((s) => s.key);

export const developParams: ParamSpec[] = [
  n(['version', 'Settings version', 1, 99, DEVELOP_VERSION]),
  // Profile and treatment.
  sel(
    'profile',
    'Profile',
    PROFILES.map((p) => [p.id, p.label]),
    'natural',
  ),
  n(['profileAmount', 'Profile amount', 0, 200, 100]),
  // Light.
  n(['exposure', 'Exposure', -5, 5, 0, 0.05, 'EV']),
  n(['contrast', 'Contrast', -100, 100]),
  n(['highlights', 'Highlights', -100, 100]),
  n(['shadows', 'Shadows', -100, 100]),
  n(['whites', 'Whites', -100, 100]),
  n(['blacks', 'Blacks', -100, 100]),
  // Color.
  sel('whiteBalance', 'White balance', WB_PRESETS, 'as-shot'),
  n(['temperature', 'Temperature', -100, 100]),
  n(['tint', 'Tint', -100, 100]),
  n(['vibrance', 'Vibrance', -100, 100]),
  n(['saturation', 'Saturation', -100, 100]),
  // Effects.
  n(['texture', 'Texture', -100, 100]),
  n(['clarity', 'Clarity', -100, 100]),
  n(['dehaze', 'Dehaze', -100, 100]),
  n(['vignette', 'Vignette', -100, 100]),
  sel(
    'vignetteStyle',
    'Vignette style',
    [
      ['highlights', 'Highlight Priority'],
      ['color', 'Color Priority'],
      ['paint', 'Paint Overlay'],
    ],
    'highlights',
  ),
  n(['vignetteMidpoint', 'Midpoint', 0, 100, 50]),
  n(['vignetteRoundness', 'Roundness', -100, 100, 0]),
  n(['vignetteFeather', 'Feather', 0, 100, 50]),
  n(['grain', 'Grain', 0, 100]),
  n(['grainSize', 'Grain size', 0, 100, 25]),
  n(['grainRoughness', 'Grain roughness', 0, 100, 50]),
  // Curve: parametric regions and point curves (one polyline each, empty = straight).
  n(['curveHighlights', 'Highlights', -100, 100]),
  n(['curveLights', 'Lights', -100, 100]),
  n(['curveDarks', 'Darks', -100, 100]),
  n(['curveShadows', 'Shadows', -100, 100]),
  n(['curveSplit1', 'Shadows split', 10, 40, 25]),
  n(['curveSplit2', 'Midtones split', 30, 70, 50]),
  n(['curveSplit3', 'Highlights split', 60, 90, 75]),
  curve('curveRGB', 'Point curve'),
  curve('curveRed', 'Red curve'),
  curve('curveGreen', 'Green curve'),
  curve('curveBlue', 'Blue curve'),
  // Color Mixer (and its gray mix in black and white).
  ...mixer,
  ...grayMix,
  // Color Grading.
  ...wheel('Shadow', 'Shadows'),
  ...wheel('Midtone', 'Midtones'),
  ...wheel('Highlight', 'Highlights'),
  ...wheel('Global', 'Global'),
  n(['gradeBlending', 'Blending', 0, 100, 50]),
  n(['gradeBalance', 'Balance', -100, 100]),
  // Detail.
  n(['sharpenAmount', 'Sharpening', 0, 150]),
  n(['sharpenRadius', 'Radius', 0.5, 3, 1, 0.1, 'px']),
  n(['sharpenDetail', 'Detail', 0, 100, 25]),
  n(['sharpenMasking', 'Masking', 0, 100]),
  n(['noiseReduction', 'Noise reduction', 0, 100]),
  n(['noiseDetail', 'Detail', 0, 100, 50]),
  n(['noiseContrast', 'Contrast', 0, 100]),
  n(['colorNoise', 'Color noise reduction', 0, 100]),
  n(['colorNoiseDetail', 'Detail', 0, 100, 50]),
  n(['colorNoiseSmoothness', 'Smoothness', 0, 100, 50]),
  // Optics.
  n(['lensDistortion', 'Distortion', -100, 100]),
  n(['lensVignetting', 'Vignetting', -100, 100]),
  n(['lensVignettingMidpoint', 'Midpoint', 0, 100, 50]),
  check('removeCA', 'Remove chromatic aberration', false),
  n(['defringePurple', 'Purple fringe', 0, 20]),
  n(['defringeGreen', 'Green fringe', 0, 20]),
  // Geometry.
  sel(
    'upright',
    'Upright',
    [
      ['off', 'Off'],
      ['auto', 'Auto'],
      ['level', 'Level'],
      ['vertical', 'Vertical'],
      ['full', 'Full'],
    ],
    'off',
  ),
  n(['geoVertical', 'Vertical', -100, 100]),
  n(['geoHorizontal', 'Horizontal', -100, 100]),
  n(['geoRotate', 'Rotate', -10, 10, 0, 0.1, '°']),
  n(['geoAspect', 'Aspect', -100, 100]),
  n(['geoScale', 'Scale', 50, 150, 100, 1, '%']),
  n(['geoOffsetX', 'Offset X', -100, 100]),
  n(['geoOffsetY', 'Offset Y', -100, 100]),
  check('geoConstrain', 'Constrain crop', false),
  // Calibration.
  n(['calShadowTint', 'Shadows tint', -100, 100]),
  n(['calRedHue', 'Red primary hue', -100, 100]),
  n(['calRedSat', 'Red primary saturation', -100, 100]),
  n(['calGreenHue', 'Green primary hue', -100, 100]),
  n(['calGreenSat', 'Green primary saturation', -100, 100]),
  n(['calBlueHue', 'Blue primary hue', -100, 100]),
  n(['calBlueSat', 'Blue primary saturation', -100, 100]),
  // Panel switches (the eye on each panel header).
  check('lightOn', 'Light on'),
  check('colorOn', 'Color on'),
  check('effectsOn', 'Effects on'),
  check('curveOn', 'Curve on'),
  check('mixerOn', 'Color Mixer on'),
  check('gradingOn', 'Color Grading on'),
  check('detailOn', 'Detail on'),
  check('opticsOn', 'Optics on'),
  check('geometryOn', 'Geometry on'),
  check('calibrationOn', 'Calibration on'),
  check('masksOn', 'Masks on'),
  // Masks.
  ...Array.from({ length: MASK_SLOTS }, (_, i) => maskSpecs(i + 1)).flat(),
];

export type PanelId =
  | 'light'
  | 'color'
  | 'effects'
  | 'curve'
  | 'mixer'
  | 'grading'
  | 'detail'
  | 'optics'
  | 'geometry'
  | 'calibration'
  | 'masks';
/** Panels in workspace order with the keys each one resets and switches off. */
export const PANELS: { id: PanelId; label: string; toggle: string; keys: string[] }[] = [
  {
    id: 'light',
    label: 'Light',
    toggle: 'lightOn',
    keys: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  },
  {
    id: 'color',
    label: 'Color',
    toggle: 'colorOn',
    keys: ['whiteBalance', 'temperature', 'tint', 'vibrance', 'saturation'],
  },
  {
    id: 'effects',
    label: 'Effects',
    toggle: 'effectsOn',
    keys: [
      'texture',
      'clarity',
      'dehaze',
      'vignette',
      'vignetteStyle',
      'vignetteMidpoint',
      'vignetteRoundness',
      'vignetteFeather',
      'grain',
      'grainSize',
      'grainRoughness',
    ],
  },
  {
    id: 'curve',
    label: 'Curve',
    toggle: 'curveOn',
    keys: [
      'curveHighlights',
      'curveLights',
      'curveDarks',
      'curveShadows',
      'curveSplit1',
      'curveSplit2',
      'curveSplit3',
      'curveRGB',
      'curveRed',
      'curveGreen',
      'curveBlue',
    ],
  },
  {
    id: 'mixer',
    label: 'Color Mixer',
    toggle: 'mixerOn',
    keys: [...mixer, ...grayMix].map((s) => s.key),
  },
  {
    id: 'grading',
    label: 'Color Grading',
    toggle: 'gradingOn',
    keys: [
      ...wheel('Shadow', ''),
      ...wheel('Midtone', ''),
      ...wheel('Highlight', ''),
      ...wheel('Global', ''),
    ]
      .map((s) => s.key)
      .concat('gradeBlending', 'gradeBalance'),
  },
  {
    id: 'detail',
    label: 'Detail',
    toggle: 'detailOn',
    keys: [
      'sharpenAmount',
      'sharpenRadius',
      'sharpenDetail',
      'sharpenMasking',
      'noiseReduction',
      'noiseDetail',
      'noiseContrast',
      'colorNoise',
      'colorNoiseDetail',
      'colorNoiseSmoothness',
    ],
  },
  {
    id: 'optics',
    label: 'Optics',
    toggle: 'opticsOn',
    keys: [
      'lensDistortion',
      'lensVignetting',
      'lensVignettingMidpoint',
      'removeCA',
      'defringePurple',
      'defringeGreen',
    ],
  },
  {
    id: 'geometry',
    label: 'Geometry',
    toggle: 'geometryOn',
    keys: [
      'upright',
      'geoVertical',
      'geoHorizontal',
      'geoRotate',
      'geoAspect',
      'geoScale',
      'geoOffsetX',
      'geoOffsetY',
      'geoConstrain',
    ],
  },
  {
    id: 'calibration',
    label: 'Calibration',
    toggle: 'calibrationOn',
    keys: [
      'calShadowTint',
      'calRedHue',
      'calRedSat',
      'calGreenHue',
      'calGreenSat',
      'calBlueHue',
      'calBlueSat',
    ],
  },
  {
    id: 'masks',
    label: 'Masks',
    toggle: 'masksOn',
    keys: Array.from({ length: MASK_SLOTS }, (_, i) => maskKeys(i + 1)).flat(),
  },
];

const specByKey = new Map(developParams.map((s) => [s.key, s]));
export const developSpec = (key: string) => specByKey.get(key);
export const developDefaults = (): ParamValues =>
  Object.fromEntries(
    developParams.map((s) => [
      s.key,
      Array.isArray(s.default) ? [] : (s.default as ParamValues[string]),
    ]),
  );

/** Settings from an earlier version brought up to the current one (before
 * normalizing). Settings without a version are version 1. */
export function migrateDevelop(raw: Record<string, unknown>): Record<string, unknown> {
  const p = { ...(raw ?? {}) };
  const v = typeof p.version === 'number' && Number.isFinite(p.version) ? p.version : 1;
  if (v < 2) {
    // The first vignette was circular and scaled linear light; its falloff
    // matches midpoint 50 and feather 50.
    p.vignetteStyle = 'color';
    p.vignetteRoundness = 100;
    p.vignetteMidpoint = 50;
    p.vignetteFeather = 50;
  }
  p.version = DEVELOP_VERSION;
  return p;
}

/** True when a panel's settings are all at their defaults. */
export function panelIsDefault(p: ParamValues, id: PanelId): boolean {
  const panel = PANELS.find((x) => x.id === id)!;
  return panel.keys.every((k) => isDefault(p, k));
}
export function isDefault(p: ParamValues, key: string): boolean {
  const s = specByKey.get(key);
  if (!s) return true;
  const v = p[key];
  if (s.type === 'paths') return !isCurveActive(v as NormPath[] | undefined);
  return v === undefined || v === s.default;
}
/** A point curve does something when it has a point off the diagonal. */
export function isCurveActive(v: NormPath[] | undefined): boolean {
  const pts = Array.isArray(v) ? v[0] : undefined;
  return !!pts && pts.some((q) => Math.abs(q.x - q.y) > 1e-4);
}
/** The panel switch is on (missing means on). */
export const panelOn = (p: ParamValues, id: PanelId) =>
  p[PANELS.find((x) => x.id === id)!.toggle] !== false;
