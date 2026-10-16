// Image data-blocks → GPU textures (decoded from bytes or generated).
import { CanvasTexture, SRGBColorSpace, NoColorSpace, RepeatWrapping, type Texture, LinearMipmapLinearFilter, LinearFilter, NearestFilter } from 'three';
import type { ImageData as Img, DocumentData } from '../data/types';
import { isTiled, tilesKey, drawAtlas, onTileReady, setGeneratedDrawer } from './udim';

interface Entry {
  key: string;
  tex: CanvasTexture;
  canvas: HTMLCanvasElement;
  ready: boolean;
}

const cache = new Map<string, Entry>();

/** Texture sampling quality (Preferences ▸ Viewport ▸ Textures). */
export const textureSettings = { anisotropy: 8 };

/** Re-apply texture settings to every cached texture. */
export function applyTextureSettings() {
  for (const e of cache.values()) {
    if (e.tex.anisotropy === textureSettings.anisotropy) continue;
    e.tex.anisotropy = textureSettings.anisotropy;
    e.tex.needsUpdate = true;
  }
}
let onReady: (() => void) | null = null;
export function onImageReady(fn: () => void) {
  onReady = fn;
}

/** bumps when a UDIM tile finished decoding (tiled images rebuild their atlas) */
let tileVersion = 0;

function keyOf(img: Img) {
  if (isTiled(img)) return `T|${tilesKey(img)}|${tileVersion}|${img.colorspace}`;
  return `${img.width}x${img.height}|${img.source}|${img.generated_type}|${img.generated_color?.join(',')}|${img.revision ?? 0}|${img.bytes ? img.bytes.length : 0}|${img.colorspace}`;
}

export function generatedPixels(img: Img, ctx: CanvasRenderingContext2D) {
  const w = img.width,
    h = img.height;
  if (img.generated_type === 'UV_GRID') {
    const cell = Math.max(1, Math.floor(w / 8));
    for (let y = 0; y < h; y += cell)
      for (let x = 0; x < w; x += cell) {
        ctx.fillStyle = ((x / cell + y / cell) & 1) === 0 ? '#272829' : '#c9cacb';
        ctx.fillRect(x, y, cell, cell);
      }
    ctx.strokeStyle = 'rgba(255, 255, 255,.45)';
    ctx.lineWidth = Math.max(1, w / 512);
    for (let i = 0; i <= 32; i++) {
      const p = (i / 32) * w;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, h);
      ctx.moveTo(0, p);
      ctx.lineTo(w, p);
      ctx.stroke();
    }
  } else if (img.generated_type === 'COLOR_GRID') {
    const n = 8,
      cw = w / n,
      ch = h / n;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = `hsl(${(i / n) * 360}, 70%, ${30 + (j / n) * 45}%)`;
        ctx.fillRect(i * cw, h - (j + 1) * ch, cw, ch);
        ctx.fillStyle = 'rgba(0, 0, 0,.6)';
        ctx.font = `${Math.floor(ch / 3)}px sans-serif`;
        ctx.fillText(`${String.fromCharCode(65 + i)}${j + 1}`, i * cw + cw * 0.3, h - j * ch - ch * 0.35);
      }
  } else {
    const c = img.generated_color ?? [0, 0, 0, 1];
    const to = (x: number) => Math.round(Math.max(0, Math.min(1, x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055)) * 255);
    ctx.fillStyle = `rgba(${to(c[0])},${to(c[1])},${to(c[2])},${c[3]})`;
    ctx.fillRect(0, 0, w, h);
  }
}

/** Canvas holding the current pixels of an image (for painting and display). */
export function imageCanvas(img: Img): HTMLCanvasElement {
  return entry(img).canvas;
}

function entry(img: Img): Entry {
  const key = keyOf(img);
  let e = cache.get(img.id);
  if (e && e.key === key) return e;
  if (isTiled(img)) return tiledEntry(img, key, e);
  const canvas = e?.canvas ?? document.createElement('canvas');
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = Math.max(1, img.width);
    canvas.height = Math.max(1, img.height);
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const tex = e?.tex ?? new CanvasTexture(canvas);
  const fresh: Entry = { key, tex, canvas, ready: false };
  cache.set(img.id, fresh);
  // painted images keep their canvas pixels (bytes are synced lazily on save)
  const painted = e && img.revision && e.key.split('|')[4] !== String(img.revision) && img.source !== 'FILE';
  if (img.bytes && img.bytes.length && !painted) {
    const blob = new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.mime });
    createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      .then((bmp) => {
        if (cache.get(img.id) !== fresh) return;
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0);
        fresh.ready = true;
        tex.needsUpdate = true;
        onReady?.();
      })
      .catch(() => {
        ctx.fillStyle = '#ff00ff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        tex.needsUpdate = true;
      });
  } else if (!painted) {
    generatedPixels(img, ctx);
    fresh.ready = true;
  } else fresh.ready = true;
  tex.colorSpace = img.colorspace === 'sRGB' ? SRGBColorSpace : NoColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = textureSettings.anisotropy;
  tex.needsUpdate = true;
  return fresh;
}

/** UDIM images: the tiles laid out in one atlas (cells follow the UV squares). */
function tiledEntry(img: Img, key: string, e: Entry | undefined): Entry {
  const canvas = e?.canvas ?? document.createElement('canvas');
  const tex = e?.tex ?? new CanvasTexture(canvas);
  const fresh: Entry = { key, tex, canvas, ready: false };
  cache.set(img.id, fresh);
  fresh.ready = drawAtlas(img, canvas) === img.tiles!.length;
  if (tex.image !== canvas) tex.image = canvas;
  tex.colorSpace = img.colorspace === 'sRGB' ? SRGBColorSpace : NoColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = textureSettings.anisotropy;
  tex.needsUpdate = true;
  return fresh;
}

onTileReady(() => {
  tileVersion++;
  onReady?.();
});
setGeneratedDrawer((v, ctx) => generatedPixels({ id: '', name: '', mime: v.mime, bytes: null, width: v.width, height: v.height, source: 'GENERATED', colorspace: 'sRGB', generated_type: v.generated_type, generated_color: v.generated_color }, ctx));

export function imageTexture(img: Img, interpolation: 'Linear' | 'Closest' | 'Cubic' | 'Smart' = 'Linear', colorspace?: 'sRGB' | 'Non-Color'): Texture {
  const e = entry(img);
  e.tex.magFilter = interpolation === 'Closest' ? NearestFilter : LinearFilter;
  e.tex.minFilter = interpolation === 'Closest' ? NearestFilter : LinearMipmapLinearFilter;
  if (colorspace) e.tex.colorSpace = colorspace === 'sRGB' ? SRGBColorSpace : NoColorSpace;
  return e.tex;
}

/** Mark an image's GPU texture as changed after painting into its canvas. */
export function touchImage(img: Img) {
  const e = cache.get(img.id);
  if (e) {
    e.tex.needsUpdate = true;
    img.revision = (img.revision ?? 0) + 1;
    e.key = keyOf(img);
  }
}

/** Encode an image's current canvas pixels into PNG bytes. */
export async function encodeImage(img: Img): Promise<Uint8Array> {
  const c = imageCanvas(img);
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export function pruneImages(doc: DocumentData) {
  for (const id of [...cache.keys()])
    if (!doc.images[id]) {
      cache.get(id)!.tex.dispose();
      cache.delete(id);
    }
}

/** Whether the image's canvas holds its current pixels (decoding finished). */
export function imageReady(img: Img): boolean {
  const e = cache.get(img.id);
  return !!e && e.key === keyOf(img) && e.ready;
}

/** Install already-known pixels for an image (after an edit) so it shows without re-decoding. */
export function primeImage(img: Img, pixels: globalThis.ImageData) {
  const e = entry(img);
  const canvas = e.canvas;
  if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
    canvas.width = pixels.width;
    canvas.height = pixels.height;
  }
  canvas.getContext('2d', { willReadFrequently: true })!.putImageData(pixels, 0, 0);
  // the decode started by entry() must not overwrite these pixels
  const fresh: Entry = { key: keyOf(img), tex: e.tex, canvas, ready: true };
  cache.set(img.id, fresh);
  e.tex.needsUpdate = true;
}
