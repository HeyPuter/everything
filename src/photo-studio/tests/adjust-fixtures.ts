// Shared inputs for the adjustment tests: seeded random images and one
// non-trivial setting per adjustment kind.
import { rgba8, type RGBA8 } from '../src/imaging/types';
import { defaultParams, type Adjustment, type AdjustmentKind } from '../src/imaging/adjust';

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function randomImage(w: number, h: number, seed = 1, alpha = false): RGBA8 {
  const img = rgba8(w, h);
  const r = rng(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r() * 256;
    img.data[i + 1] = r() * 256;
    img.data[i + 2] = r() * 256;
    img.data[i + 3] = alpha ? r() * 256 : 255;
  }
  return img;
}

// Every 8-bit gray level plus a coarse sweep of the RGB cube.
export function rampImage(): RGBA8 {
  const img = rgba8(256, 2);
  for (let x = 0; x < 256; x++) {
    img.data.set([x, x, x, 255], x * 4);
    img.data.set([x, 255 - x, (x * 7) & 255, 255], (256 + x) * 4);
  }
  return img;
}

export function sampleAdjustment(kind: AdjustmentKind): Adjustment {
  switch (kind) {
    case 'brightness-contrast':
      return { kind, params: { brightness: 40, contrast: 30, legacy: false } };
    case 'levels': {
      const p = defaultParams('levels');
      p.rgb = { inBlack: 20, inWhite: 230, gamma: 1.3, outBlack: 5, outWhite: 250 };
      p.b = { inBlack: 0, inWhite: 255, gamma: 0.8, outBlack: 0, outWhite: 255 };
      return { kind, params: p };
    }
    case 'curves': {
      const p = defaultParams('curves');
      p.rgb.points = [[0, 10], [64, 50], [128, 140], [192, 210], [255, 245]];
      p.r.points = [[0, 0], [128, 150], [255, 255]];
      return { kind, params: p };
    }
    case 'exposure':
      return { kind, params: { exposure: 0.7, offset: -0.01, gamma: 1.1 } };
    case 'vibrance':
      return { kind, params: { vibrance: 60, saturation: -10 } };
    case 'hue-saturation': {
      const p = defaultParams('hue-saturation');
      p.master = { hue: 15, saturation: 20, lightness: -5 };
      p.ranges.blues = { ...p.ranges.blues, hue: -20, saturation: 30, lightness: 10 };
      p.ranges.reds = { ...p.ranges.reds, saturation: -40 };
      return { kind, params: p };
    }
    case 'color-balance':
      return { kind, params: { shadows: [-20, 0, 30], midtones: [25, -10, -15], highlights: [0, 10, -20], preserveLuminosity: true } };
    case 'black-white': {
      const p = defaultParams('black-white');
      Object.assign(p, { reds: 60, yellows: 80, blues: 10, tint: true, tintHue: 40, tintSaturation: 30 });
      return { kind, params: p };
    }
    case 'photo-filter':
      return { kind, params: { preset: 'cooling', color: [40, 120, 240], density: 40, preserveLuminosity: true } };
    case 'channel-mixer': {
      const p = defaultParams('channel-mixer');
      p.red = { r: 80, g: 30, b: -10, constant: 2 };
      p.blue = { r: 0, g: 20, b: 90, constant: -3 };
      return { kind, params: p };
    }
    case 'color-lookup':
      return { kind, params: { source: { type: 'builtin', id: 'teal-shadows' }, amount: 80 } };
    case 'invert':
      return { kind, params: {} };
    case 'posterize':
      return { kind, params: { levels: 5 } };
    case 'threshold':
      return { kind, params: { level: 110 } };
    case 'gradient-map':
      return {
        kind,
        params: {
          gradient: {
            stops: [
              { location: 0, color: [20, 0, 60], midpoint: 0.5 },
              { location: 0.6, color: [220, 80, 40], midpoint: 0.4 },
              { location: 1, color: [255, 240, 200], midpoint: 0.5 },
            ],
          },
          reverse: false,
          dither: false,
        },
      };
    case 'selective-color': {
      const p = defaultParams('selective-color');
      p.ranges.reds = { cyan: -30, magenta: 10, yellow: 20, black: 0 };
      p.ranges.neutrals = { cyan: 0, magenta: 0, yellow: -10, black: 5 };
      p.ranges.blues = { cyan: 20, magenta: -20, yellow: 0, black: 10 };
      return { kind, params: p };
    }
    case 'light-tone':
      return { kind, params: { exposure: 0.4, contrast: 25, highlights: -30, shadows: 35, whites: 10, blacks: -15 } };
    case 'color-vibrance':
      return { kind, params: { temperature: 30, tint: -15, vibrance: 40, saturation: 10 } };
    case 'clarity-dehaze':
      return { kind, params: { clarity: 50, dehaze: 30 } };
    case 'grain':
      return { kind, params: { amount: 40, size: 30, roughness: 50, color: 30 } };
    case 'relight': {
      const p = defaultParams('relight');
      p.lights[0] = { ...p.lights[0], x: 0.3, y: 0.2, temperature: 3200, brightness: 140 };
      p.ambient = 50;
      return { kind, params: p };
    }
  }
}

export function diffStats(a: RGBA8, b: RGBA8) {
  let max = 0,
    sum = 0,
    n = 0;
  for (let i = 0; i < a.data.length; i++) {
    if ((i & 3) === 3) continue;
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > max) max = d;
    sum += d;
    n++;
  }
  return { max, mean: sum / n };
}
