// Relight layers: settings, light colors and the shared geometry of the
// surface estimate. Plain JSON so the settings live in an adjustment spec
// (kind 'relight') and travel through projects, history and collaboration.
//
// Coordinates: a light's x and y are fractions of the document width and
// height (0..1 is over the canvas; lights may sit a little outside). Its
// depth runs from -100 (behind the subject, a back or rim light) to 100 (in
// front, toward the viewer). Heights and distances are measured in document
// pixels, scaled by the document's long side so a relit look survives a
// resize.
import type { RGB8 } from '../adjust/gradient-stops';

export const MAX_LIGHTS = 8;

export type RelightLight = {
  id: string;
  name: string;
  visible: boolean;
  x: number; // fraction of the document width, -0.5..1.5
  y: number; // fraction of the document height, -0.5..1.5
  depth: number; // -100 behind .. 100 in front
  temperature: number; // Kelvin, 1500..12000 (used when color is null)
  color: RGB8 | null; // a custom color instead of a temperature
  brightness: number; // 0..200 percent
  spread: number; // 0..100: how far the light reaches
  softness: number; // 0..100: how far light wraps around the shape
};

export type RelightParams = {
  lights: RelightLight[];
  ambient: number; // 0..100 percent of the existing lighting kept
  relief: number; // 0..100 strength of the estimated surface shape
  detail: number; // 0..100 fine detail (100) versus broad forms (0)
  shadows: number; // 0..100 strength of soft shadows cast by the shape
};

export const LIGHT_DEFAULTS: Omit<RelightLight, 'id' | 'name'> = {
  visible: true,
  x: 0.5,
  y: 0.4,
  depth: 40,
  temperature: 5500,
  color: null,
  brightness: 100,
  spread: 50,
  softness: 40,
};

export const defaultRelightParams = (): RelightParams => ({
  lights: [newLight([])],
  ambient: 60,
  relief: 50,
  detail: 50,
  shadows: 30,
});

/** A light with the defaults, named and identified after those in `lights`.
 * New lights are placed around the canvas so they do not stack up. */
export function newLight(
  lights: readonly RelightLight[],
  at?: { x: number; y: number },
): RelightLight {
  let n = 1;
  const names = new Set(lights.map((l) => l.name));
  while (names.has(`Light ${n}`)) n++;
  let k = 1;
  const ids = new Set(lights.map((l) => l.id));
  while (ids.has(`light-${k}`)) k++;
  const spots = [
    [0.5, 0.4],
    [0.25, 0.3],
    [0.75, 0.3],
    [0.3, 0.7],
    [0.7, 0.7],
    [0.5, 0.15],
    [0.15, 0.55],
    [0.85, 0.55],
  ];
  const [x, y] = at ? [at.x, at.y] : spots[lights.length % spots.length];
  return { ...LIGHT_DEFAULTS, id: `light-${k}`, name: `Light ${n}`, x, y };
}

// Original color choices: a temperature in Kelvin with a plain description.
export const TEMPERATURE_PRESETS: { kelvin: number; label: string }[] = [
  { kelvin: 1900, label: 'Candlelight' },
  { kelvin: 2700, label: 'Warm bulb' },
  { kelvin: 3200, label: 'Studio tungsten' },
  { kelvin: 4200, label: 'Warm white' },
  { kelvin: 5500, label: 'Neutral' },
  { kelvin: 6500, label: 'Overcast' },
  { kelvin: 7500, label: 'Open shade' },
  { kelvin: 9500, label: 'Blue hour' },
];

const num = (v: unknown, def: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
const byte = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v))) : 0;
const LIGHT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Settings from any stored value: missing or invalid fields take defaults,
 * values are clamped, at most MAX_LIGHTS lights with unique identifiers. */
export function normalizeRelight(value: unknown): RelightParams {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const def = defaultRelightParams();
  const lights: RelightLight[] = [];
  const raw = Array.isArray(v.lights) ? v.lights : def.lights;
  for (const item of raw.slice(0, MAX_LIGHTS)) {
    if (!item || typeof item !== 'object') continue;
    const l = item as Record<string, unknown>;
    const fresh = newLight(lights);
    const id =
      typeof l.id === 'string' && LIGHT_ID.test(l.id) && !lights.some((o) => o.id === l.id)
        ? l.id
        : fresh.id;
    const color =
      Array.isArray(l.color) && l.color.length === 3
        ? ([byte(l.color[0]), byte(l.color[1]), byte(l.color[2])] as RGB8)
        : null;
    lights.push({
      id,
      name: typeof l.name === 'string' && l.name.trim() ? l.name.slice(0, 64) : fresh.name,
      visible: typeof l.visible === 'boolean' ? l.visible : true,
      x: num(l.x, fresh.x, -0.5, 1.5),
      y: num(l.y, fresh.y, -0.5, 1.5),
      depth: num(l.depth, LIGHT_DEFAULTS.depth, -100, 100),
      temperature: num(l.temperature, LIGHT_DEFAULTS.temperature, 1500, 12000),
      color,
      brightness: num(l.brightness, LIGHT_DEFAULTS.brightness, 0, 200),
      spread: num(l.spread, LIGHT_DEFAULTS.spread, 0, 100),
      softness: num(l.softness, LIGHT_DEFAULTS.softness, 0, 100),
    });
  }
  return {
    lights,
    ambient: num(v.ambient, def.ambient, 0, 100),
    relief: num(v.relief, def.relief, 0, 100),
    detail: num(v.detail, def.detail, 0, 100),
    shadows: num(v.shadows, def.shadows, 0, 100),
  };
}

const active = (l: RelightLight) => l.visible && l.brightness > 0;
/** Lights that contribute (shown and brighter than zero). */
export const activeLights = (p: RelightParams) => p.lights.filter(active);
export const isIdentityRelight = (p: RelightParams) => p.ambient >= 100 && !p.lights.some(active);

// ----- Light color -----

// Chromaticity of a black body at temperature T (CIE 1931 xy), from the
// cubic approximation of the Planckian locus (valid 1667..25000 K).
export function planckianXY(kelvin: number): [number, number] {
  const T = Math.min(25000, Math.max(1667, kelvin));
  const t = 1e3 / T,
    t2 = t * t,
    t3 = t2 * t;
  const x =
    T <= 4000
      ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.17991
      : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  const x2 = x * x,
    x3 = x2 * x;
  const y =
    T <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

function xyToLinearRgb(x: number, y: number): [number, number, number] {
  const X = x / y,
    Z = (1 - x - y) / y;
  return [
    Math.max(0, 3.2406 * X - 1.5372 - 0.4986 * Z),
    Math.max(0, -0.9689 * X + 1.8758 + 0.0415 * Z),
    Math.max(0, 0.0557 * X - 0.204 + 1.057 * Z),
  ];
}

const NEUTRAL = xyToLinearRgb(...planckianXY(5500));
/** Linear-light color of a temperature, balanced so 5500 K is white; the
 * largest channel is 1. */
export function temperatureRgb(kelvin: number): [number, number, number] {
  const c = xyToLinearRgb(...planckianXY(kelvin)).map((v, i) => v / NEUTRAL[i]);
  const m = Math.max(c[0], c[1], c[2], 1e-6);
  return [c[0] / m, c[1] / m, c[2] / m];
}

export const toLinear = (v: number) => Math.pow(Math.max(0, v), 2.2);
export const fromLinear = (v: number) => Math.pow(Math.max(0, v), 1 / 2.2);

/** Linear-light color of a light (temperature or custom color). */
export function lightRgb(l: RelightLight): [number, number, number] {
  if (l.color)
    return [toLinear(l.color[0] / 255), toLinear(l.color[1] / 255), toLinear(l.color[2] / 255)];
  return temperatureRgb(l.temperature);
}

/** Display color of a light, as CSS (for swatches and canvas handles). */
export function lightCss(l: RelightLight) {
  const c = lightRgb(l).map((v) => Math.round(fromLinear(v) * 255));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// ----- Geometry shared by the CPU reference and the GPU passes -----

// The surface is estimated on a reduced copy at most this many pixels on the
// long side: shapes are smooth, so the cost stays independent of the size.
export const RELIGHT_WORK = 512;

export type RelightGeometry = {
  factor: number;
  width: number; // reduced plane size
  height: number;
  // Gaussian deviations and radii of the three luminance scales (reduced pixels).
  sigmas: [number, number, number];
  radii: [number, number, number];
  // Weights of the three scales in the height map (they sum to 1).
  weights: [number, number, number];
  // Edge-aware smoothing of the height map: spatial deviation and radius,
  // range deviation on the guide luminance.
  sigmaS: number;
  radiusS: number;
  sigmaR: number;
  // Height in document pixels of a luminance step of 1.
  relief: number;
  // Document long side, from which distances are measured.
  docMax: number;
  // Shadow march: steps and their length in reduced pixels.
  shadowSteps: number;
  shadowStep: number;
};

export function relightGeometry(
  width: number,
  height: number,
  p: Pick<RelightParams, 'relief' | 'detail'>,
  docMax = Math.max(width, height),
): RelightGeometry {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / RELIGHT_WORK));
  const w = Math.ceil(width / factor),
    h = Math.ceil(height / factor);
  // The scales are fractions of the reduced document so a crop or a resize
  // keeps the same look.
  const scale = Math.max(1, docMax) / factor / RELIGHT_WORK;
  const sigmas: [number, number, number] = [1.5 * scale, 6 * scale, 20 * scale].map((s) =>
    Math.max(0.8, s),
  ) as [number, number, number];
  const d = Math.min(1, Math.max(0, p.detail / 100));
  const weights: [number, number, number] = [0.1 + 0.5 * d, 0.3, 0.6 - 0.5 * d];
  const sigmaS = Math.max(1, 2.5 * scale);
  return {
    factor,
    width: w,
    height: h,
    sigmas,
    radii: sigmas.map((s) => Math.ceil(3 * s)) as [number, number, number],
    weights,
    sigmaS,
    radiusS: Math.ceil(2 * sigmaS),
    sigmaR: 0.08,
    relief: (Math.min(100, Math.max(0, p.relief)) / 100) * 0.12 * Math.max(1, docMax),
    docMax: Math.max(1, docMax),
    shadowSteps: 24,
    shadowStep: Math.max(1, 1.5 * scale),
  };
}

/** One light as the shading math uses it: position in document pixels,
 * reach, linear color times intensity and the wrap factor. */
export type PreparedLight = {
  x: number;
  y: number;
  z: number;
  reach: number;
  r: number;
  g: number;
  b: number;
  wrap: number;
};

export function prepareLights(
  p: RelightParams,
  docWidth: number,
  docHeight: number,
): PreparedLight[] {
  const D = Math.max(1, docWidth, docHeight);
  return activeLights(p)
    .slice(0, MAX_LIGHTS)
    .map((l) => {
      const c = lightRgb(l),
        k = l.brightness / 100;
      return {
        x: l.x * docWidth,
        y: l.y * docHeight,
        z: (l.depth / 100) * 0.75 * D,
        reach: (0.12 + 1.2 * (l.spread / 100)) * 0.5 * D,
        r: c[0] * k,
        g: c[1] * k,
        b: c[2] * k,
        wrap: (l.softness / 100) * 0.75,
      };
    });
}
