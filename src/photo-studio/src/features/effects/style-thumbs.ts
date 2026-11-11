import type { LayerStyle } from '../../imaging/effects/types';
import type { RGBA8 } from '../../imaging/types';
import { renderThumb } from './style-client';
import { stylePresets, type StylePreset } from '../../imaging/effects/presets';
import { validLayerStyle } from '../../model/layer-style';

// Swatches of layer styles, rendered off the main thread and cached.
const cache = new Map<string, string>();
const waiting = new Map<string, Promise<string>>();
function toUrl(img: RGBA8) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c.toDataURL();
}
export function styleThumbnail(style: LayerStyle, size = 48, fillOpacity = 1): Promise<string> {
  const k = JSON.stringify([style, size, fillOpacity]);
  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);
  let p = waiting.get(k);
  if (!p) {
    p = renderThumb(style, size, fillOpacity).then((img) => {
      const url = toUrl(img);
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      cache.set(k, url);
      waiting.delete(k);
      return url;
    });
    waiting.set(k, p);
  }
  return p;
}
/** Shows a style swatch in `img` once rendered (latest request wins). */
export function showStyleThumbnail(img: HTMLImageElement, style: LayerStyle, size = 48, fillOpacity = 1) {
  const k = JSON.stringify([style, size, fillOpacity]);
  img.dataset.thumb = k;
  const hit = cache.get(k);
  if (hit) {
    img.src = hit;
    return;
  }
  styleThumbnail(style, size, fillOpacity).then((url) => {
    if (img.dataset.thumb === k) img.src = url;
  }, () => {});
}

const key = 'photo-studio-styles';
export function loadUserStyles(): StylePreset[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(v)) return v.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && validLayerStyle(s.style));
  } catch {
    /* Optional. */
  }
  return [];
}
function store(list: StylePreset[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* Optional. */
  }
}
export function saveUserStyle(name: string, style: LayerStyle) {
  store([...loadUserStyles(), { id: `user-${crypto.randomUUID()}`, name, style }]);
}
export function setUserStyles(list: StylePreset[]) {
  store(list);
}
export function deleteUserStyle(id: string) {
  store(loadUserStyles().filter((s) => s.id !== id));
}
export const allStyles = (): StylePreset[] => [...stylePresets, ...loadUserStyles()];
