// Sun extraction: world lighting brighter than World ▸ Settings ▸ Sun ▸ Threshold (e.g. the sun
// of an HDRI) is removed from the environment and turned into a sun light that casts sharp
// shadows. The environment keeps the light below the threshold. Pure math is unit tested.
import { DataTexture, EquirectangularReflectionMapping, FloatType, LinearFilter, LinearSRGBColorSpace, RGBAFormat } from 'three';
import { texelDirection } from '../final/environment';

export interface ExtractedSun {
  /** world direction towards the sun (Z-up) */
  direction: [number, number, number];
  /** irradiance (RGB) of the extracted light on a surface facing it */
  irradiance: [number, number, number];
  /** environment texels with the excess above the threshold removed */
  data: Float32Array;
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Extract the part of an equirect radiance map (three.js convention, RGBA rows) above
 * `threshold` (luminance) as a directional light. Returns null when nothing exceeds it.
 */
export function extractSun(data: Float32Array, W: number, H: number, threshold: number): ExtractedSun | null {
  if (!(threshold > 0)) return null;
  const out = new Float32Array(data);
  const dir = [0, 0, 0];
  const E = [0, 0, 0];
  let any = false;
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    // solid angle of a texel: dφ · dθ · cos θ
    const theta = (v - 0.5) * Math.PI;
    const dw = ((2 * Math.PI) / W) * (Math.PI / H) * Math.cos(theta);
    for (let i = 0; i < W; i++) {
      const k = (j * W + i) * 4;
      const r = data[k],
        g = data[k + 1],
        b = data[k + 2];
      const L = lum(r, g, b);
      if (L <= threshold) continue;
      any = true;
      // keep the threshold's worth of light in the environment, move the excess into the sun
      const f = (L - threshold) / L;
      const er = r * f,
        eg = g * f,
        eb = b * f;
      out[k] = r - er;
      out[k + 1] = g - eg;
      out[k + 2] = b - eb;
      E[0] += er * dw;
      E[1] += eg * dw;
      E[2] += eb * dw;
      const d = texelDirection((i + 0.5) / W, v);
      const w = lum(er, eg, eb) * dw;
      dir[0] += d[0] * w;
      dir[1] += d[1] * w;
      dir[2] += d[2] * w;
    }
  }
  if (!any) return null;
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return { direction: [dir[0] / len, dir[1] / len, dir[2] / len], irradiance: [E[0], E[1], E[2]], data: out };
}

const cache = { key: '', sun: null as (Omit<ExtractedSun, 'data'> & { texture: DataTexture }) | null };

/** The world environment with its sun removed (cached per environment and threshold). */
export function splitWorldSun(env: { key: string; texture: DataTexture }, threshold: number): (Omit<ExtractedSun, 'data'> & { texture: DataTexture }) | null {
  const key = `${env.key}|${threshold}`;
  if (cache.key === key) return cache.sun;
  cache.sun?.texture.dispose();
  cache.key = key;
  const img = env.texture.image as { data: Float32Array; width: number; height: number };
  const s = img?.data instanceof Float32Array ? extractSun(img.data, img.width, img.height, threshold) : null;
  if (!s) return (cache.sun = null);
  const tex = new DataTexture(s.data, img.width, img.height, RGBAFormat, FloatType);
  tex.colorSpace = LinearSRGBColorSpace;
  tex.mapping = EquirectangularReflectionMapping;
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cache.sun = { direction: s.direction, irradiance: s.irradiance, texture: tex };
  return cache.sun;
}
