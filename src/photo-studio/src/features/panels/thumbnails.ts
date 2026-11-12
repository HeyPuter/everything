import type { TileGrid, TileStore } from '../../model/tiles';
import { TILE, tileKey } from '../../model/tiles';

const cache = new WeakMap<TileGrid, Map<string, string>>();
// Every history state is a structured clone, so each edit hands the panels new
// grid objects with the same tiles. Thumbnails are also kept by content (tile
// data and version), per store, so an edit to one layer does not redraw the
// thumbnail of every other layer.
const byContent = new WeakMap<TileStore, { urls: Map<string, string>; chars: number }>();
const serials = new WeakMap<object, number>();
let serial = 0;
// Keys of very large grids are long; bound the characters kept per store.
const CONTENT_LIMIT = 1024,
  CONTENT_CHARS = 4_000_000;
function contentKey(store: TileStore, grid: TileGrid, key: string) {
  let s = `${key}|${grid.channels}|${grid.x},${grid.y}|${grid.fill ?? 0}|`;
  for (const k in grid.tiles) {
    const id = grid.tiles[k];
    let n = 0;
    if (store.has(id)) {
      const data = store.get(id);
      n = serials.get(data) ?? 0;
      if (!n) serials.set(data, (n = ++serial));
    }
    s += `${k}=${n}:${store.version(id)};`;
  }
  return s;
}
const checker = (x: number, y: number) => (((x >> 2) + (y >> 2)) & 1 ? 204 : 255);

/** A small data-URL thumbnail of a tile grid over a document-sized frame,
 * sampled directly from tiles (nearest) so it costs O(thumbnail pixels). */
export function gridThumbnail(store: TileStore, grid: TileGrid, docW: number, docH: number, size = 40, mask = false): string {
  const key = `${docW}x${docH}:${size}:${mask}`;
  let entry = cache.get(grid);
  const hit = entry?.get(key);
  if (hit) return hit;
  const remember = (url: string) => {
    if (!entry) {
      entry = new Map();
      cache.set(grid, entry);
    }
    entry.set(key, url);
    return url;
  };
  const content = contentKey(store, grid, key);
  let known = byContent.get(store);
  const same = known?.urls.get(content);
  if (same) return remember(same);
  const scale = Math.min(size / docW, size / docH);
  const w = Math.max(1, Math.round(docW * scale)),
    h = Math.max(1, Math.round(docH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // CPU-backed: toDataURL must not wait for a busy GPU queue (seconds with large uploads).
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = c.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = Math.floor((x + 0.5) / scale) - grid.x,
        dy = Math.floor((y + 0.5) / scale) - grid.y;
      const tx = Math.floor(dx / TILE),
        ty = Math.floor(dy / TILE);
      const id = grid.tiles[tileKey(tx, ty)];
      const o = (y * w + x) * 4;
      const lx = dx - tx * TILE,
        ly = dy - ty * TILE;
      if (grid.channels === 1) {
        const v = id ? store.get(id)[ly * TILE + lx] : (grid.fill ?? 0);
        d[o] = d[o + 1] = d[o + 2] = v;
        d[o + 3] = 255;
        continue;
      }
      const bg = checker(x, y);
      if (!id) {
        d[o] = d[o + 1] = d[o + 2] = bg;
        d[o + 3] = 255;
        continue;
      }
      const t = store.get(id),
        i = (ly * TILE + lx) * 4,
        a = t[i + 3] / 255;
      d[o] = t[i] * a + bg * (1 - a);
      d[o + 1] = t[i + 1] * a + bg * (1 - a);
      d[o + 2] = t[i + 2] * a + bg * (1 - a);
      d[o + 3] = 255;
    }
  c.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  if (!known) byContent.set(store, (known = { urls: new Map(), chars: 0 }));
  // Oldest first: drop thumbnails of content no recent update showed.
  for (const [k, v] of known.urls) {
    if (known.urls.size < CONTENT_LIMIT && known.chars + content.length + url.length <= CONTENT_CHARS) break;
    known.urls.delete(k);
    known.chars -= k.length + v.length;
  }
  known.urls.set(content, url);
  known.chars += content.length + url.length;
  return remember(url);
}
