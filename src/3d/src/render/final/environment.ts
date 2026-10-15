// World → equirectangular float environment for final rendering and the path tracer.
// The texture is baked in three.js' equirect convention (Y = "up" axis of the lookup) but
// indexed by our Z-up world directions, so no environment rotation is needed and image
// backgrounds keep their expected orientation.
import { DataTexture, RGBAFormat, FloatType, HalfFloatType, DataUtils, LinearSRGBColorSpace, EquirectangularReflectionMapping, LinearFilter, Color, type Texture, type WebGLRenderTarget } from 'three';
import { renderContext } from '../context';
import type { DocumentData, WorldData } from '../../data/types';
import { evaluateWorldForViewport } from '../world';
import { imageCanvas, imageTexture } from '../images';
import { srgbDecode } from './colormanage';

export interface WorldEnvironment {
  key: string;
  /** equirect radiance (linear, strength applied) */
  texture: DataTexture;
  /** uniform colour when the world is a flat colour (used as the background) */
  color: Color | null;
}

/** World direction (Z-up) for texel centre (u,v) of a three.js-convention equirect map. */
export function texelDirection(u: number, v: number): [number, number, number] {
  const phi = (u - 0.5) * 2 * Math.PI;
  const theta = (v - 0.5) * Math.PI;
  return [Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi)];
}

/** Z-up equirect coordinates of a world direction. */
export function zUpEquirectUV(d: [number, number, number]): [number, number] {
  const u = (Math.atan2(d[1], -d[0]) + Math.PI) / (2 * Math.PI);
  const v = (Math.atan2(d[2], Math.hypot(d[0], d[1])) + Math.PI / 2) / Math.PI;
  return [u - Math.floor(u), Math.min(1, Math.max(0, v))];
}

function worldStrength(w: WorldData): number {
  const out = w.tree.nodes.find((n) => n.type === 'ShaderNodeOutputWorld');
  const link = out && w.tree.links.find((l) => l.to_node === out.id && l.to_socket === 'Surface');
  const bg = link ? w.tree.nodes.find((n) => n.id === link.from_node) : undefined;
  return bg?.type === 'ShaderNodeBackground' ? ((bg.inputs.Strength as number) ?? 1) : 1;
}

let current: WorldEnvironment | null = null;

export function worldEnvironment(doc: DocumentData): WorldEnvironment | null {
  const w = doc.scene.world ? doc.worlds[doc.scene.world] : null;
  if (!w) return null;
  const ev = evaluateWorldForViewport(doc, w);
  let key: string;
  if (ev.kind === 'color') key = `c${ev.color.join(',')}`;
  else if (ev.kind === 'texture') key = `${ev.key}:${(ev.texture as Texture).version}:${worldStrength(w)}`;
  else key = ev.key;
  if (current && current.key === key) return current;
  current?.texture.dispose();
  // PMREM needs at least a few mip levels: keep even flat colours at 256x128
  let W = 256,
    H = 128;
  let sample: (d: [number, number, number], out: number[]) => void;
  let color: Color | null = null;
  if (ev.kind === 'color') {
    color = new Color(ev.color[0], ev.color[1], ev.color[2]);
    sample = (_d, o) => ((o[0] = ev.color[0]), (o[1] = ev.color[1]), (o[2] = ev.color[2]));
  } else if (ev.kind === 'sky') {
    sample = (d, o) => {
      const elev = Math.asin(Math.max(-1, Math.min(1, d[2])));
      let k: number, a: number[], b: number[];
      if (elev >= 0) {
        k = Math.pow(Math.sin(elev), 0.5);
        a = ev.horizon;
        b = ev.top;
      } else {
        k = Math.min(1, -elev * 4);
        a = ev.horizon;
        b = ev.ground;
      }
      for (let i = 0; i < 3; i++) o[i] = a[i] + (b[i] - a[i]) * k;
    };
  } else if ((ev.texture as Texture & { renderTarget?: WebGLRenderTarget }).renderTarget && renderContext) {
    // baked by the world node compiler: already in our equirect convention (strength applied)
    const rt = (ev.texture as Texture & { renderTarget: WebGLRenderTarget }).renderTarget;
    const sw = rt.width,
      sh = rt.height;
    const n = sw * sh * 4;
    const half = rt.texture.type === HalfFloatType;
    const buf = half ? new Uint16Array(n) : new Float32Array(n);
    renderContext.engine.renderer.readRenderTargetPixels(rt, 0, 0, sw, sh, buf);
    const src = half ? Float32Array.from(buf as Uint16Array, (v) => DataUtils.fromHalfFloat(v)) : (buf as Float32Array);
    // box-downsample to at most 1024 px wide
    const f = Math.max(1, Math.ceil(sw / 1024));
    W = Math.max(1, Math.floor(sw / f));
    H = Math.max(1, Math.floor(sh / f));
    const data = new Float32Array(W * H * 4);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        let r = 0,
          g = 0,
          b = 0;
        for (let y = 0; y < f; y++)
          for (let x = 0; x < f; x++) {
            const k = ((j * f + y) * sw + i * f + x) * 4;
            r += src[k];
            g += src[k + 1];
            b += src[k + 2];
          }
        const k = (j * W + i) * 4;
        const q = 1 / (f * f);
        data[k] = r * q;
        data[k + 1] = g * q;
        data[k + 2] = b * q;
        data[k + 3] = 1;
      }
    return (current = { key, texture: makeTexture(data, W, H), color: null });
  } else {
    const img = doc.images[(w.tree.nodes.find((n) => n.type === 'ShaderNodeTexEnvironment')?.props.image as string) ?? ''];
    const canvas = img ? imageCanvas(img) : null;
    const strength = worldStrength(w);
    if (!canvas || !img) return null;
    imageTexture(img, 'Linear');
    const sw = canvas.width,
      sh = canvas.height;
    const scale = Math.min(1, 1024 / sw);
    W = Math.max(256, Math.round(sw * scale));
    H = Math.round(W / 2);
    const px = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, sw, sh).data;
    const lin = img.colorspace === 'sRGB';
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = lin ? srgbDecode(i / 255) : i / 255;
    sample = (d, o) => {
      const [u, v] = zUpEquirectUV(d);
      // bilinear lookup (image rows are top-down: v=1 is row 0)
      const fx = u * sw - 0.5,
        fy = (1 - v) * sh - 0.5;
      const x0 = Math.floor(fx),
        y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
      const y1 = Math.min(sh - 1, y0 + 1);
      const tx = fx - x0,
        ty = Math.min(1, Math.max(0, fy - y0));
      const xa = ((x0 % sw) + sw) % sw,
        xb = (xa + 1) % sw;
      for (let c = 0; c < 3; c++) {
        const p00 = lut[px[(y0 * sw + xa) * 4 + c]],
          p10 = lut[px[(y0 * sw + xb) * 4 + c]],
          p01 = lut[px[(y1 * sw + xa) * 4 + c]],
          p11 = lut[px[(y1 * sw + xb) * 4 + c]];
        o[c] = ((p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty) * strength;
      }
    };
  }
  const data = new Float32Array(W * H * 4);
  const o = [0, 0, 0];
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      sample(texelDirection((i + 0.5) / W, (j + 0.5) / H), o);
      const k = (j * W + i) * 4;
      data[k] = o[0];
      data[k + 1] = o[1];
      data[k + 2] = o[2];
      data[k + 3] = 1;
    }
  current = { key, texture: makeTexture(data, W, H), color };
  return current;
}

function makeTexture(data: Float32Array, W: number, H: number) {
  const tex = new DataTexture(data, W, H, RGBAFormat, FloatType);
  tex.colorSpace = LinearSRGBColorSpace;
  tex.mapping = EquirectangularReflectionMapping;
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

let studio: DataTexture | null = null;
/** Neutral studio environment (soft overhead key, darker floor) for scene-world-off renders. */
export function studioEquirect(): DataTexture {
  if (studio) return studio;
  const W = 128,
    H = 64;
  const data = new Float32Array(W * H * 4);
  const key: [number, number, number] = [0.45, -0.55, 0.7];
  const kl = Math.hypot(...key);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const d = texelDirection((i + 0.5) / W, (j + 0.5) / H);
      const up = d[2];
      let v = up >= 0 ? 0.6 + 0.4 * up : 0.35 + 0.25 * up;
      const c = (d[0] * key[0] + d[1] * key[1] + d[2] * key[2]) / kl;
      v += Math.pow(Math.max(0, c), 24) * 6;
      const k = (j * W + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = v;
      data[k + 3] = 1;
    }
  studio = new DataTexture(data, W, H, RGBAFormat, FloatType);
  studio.colorSpace = LinearSRGBColorSpace;
  studio.mapping = EquirectangularReflectionMapping;
  studio.minFilter = studio.magFilter = LinearFilter;
  studio.needsUpdate = true;
  return studio;
}
