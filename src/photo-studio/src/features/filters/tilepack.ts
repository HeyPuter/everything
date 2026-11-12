// Moving tile grids to and from the filter worker. The main thread sends the
// tiles a region touches (no assembly or copying into one buffer on the UI
// thread) and receives finished tiles with their content bounds, so storing a
// 12 MP result costs a few map insertions instead of a long main-thread task.
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { TILE, computeBounds, tileKey, unionRect, type TileGrid, type TileStore } from '../../model/tiles';

export type GridPayload = { channels: 1 | 4; x: number; y: number; fill: number; tiles: Record<string, Uint8ClampedArray> };
export type TileResult = {
  channels: 1 | 4;
  // Local tile keys rewritten by the result; null data means the tile is now empty.
  tiles: { key: string; data: Uint8ClampedArray | null; bounds: IRect | null }[];
};

function tileRange(grid: { x: number; y: number }, rect: IRect) {
  const lx = rect.x - grid.x,
    ly = rect.y - grid.y;
  return {
    lx,
    ly,
    tx0: Math.floor(lx / TILE),
    ty0: Math.floor(ly / TILE),
    tx1: Math.floor((lx + rect.width - 1) / TILE),
    ty1: Math.floor((ly + rect.height - 1) / TILE),
  };
}
/** The tiles of `grid` that intersect `rect` (shared, not copied: posting
 * them to a worker clones them). */
export function gridPayload(store: TileStore, grid: TileGrid, rect: IRect): GridPayload {
  const tiles: Record<string, Uint8ClampedArray> = {};
  if (rect.width > 0 && rect.height > 0) {
    const { tx0, ty0, tx1, ty1 } = tileRange(grid, rect);
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const id = grid.tiles[tileKey(tx, ty)];
        if (id) tiles[tileKey(tx, ty)] = store.get(id);
      }
  }
  return { channels: grid.channels, x: grid.x, y: grid.y, fill: grid.fill ?? 0, tiles };
}
/** Same result as `readRect` on the original grid. */
export function readPayload(p: GridPayload, rect: IRect): RGBA8 | Mask8 {
  const c = p.channels,
    { width, height } = rect;
  const out = c === 4 ? new Uint8ClampedArray(width * height * 4) : new Uint8Array(width * height);
  if (c === 1 && p.fill) out.fill(p.fill);
  const { lx, ly, tx0, ty0, tx1, ty1 } = tileRange(p, rect);
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const d = p.tiles[tileKey(tx, ty)];
      if (!d) continue;
      const sx0 = Math.max(lx, tx * TILE),
        sy0 = Math.max(ly, ty * TILE),
        sx1 = Math.min(lx + width, (tx + 1) * TILE),
        sy1 = Math.min(ly + height, (ty + 1) * TILE);
      const span = (sx1 - sx0) * c;
      for (let y = sy0; y < sy1; y++) {
        const from = ((y - ty * TILE) * TILE + (sx0 - tx * TILE)) * c;
        out.set(d.subarray(from, from + span), ((y - ly) * width + (sx0 - lx)) * c);
      }
    }
  return { width, height, data: out } as RGBA8 | Mask8;
}
function contentBounds(d: Uint8ClampedArray, channels: 1 | 4): IRect | null {
  let x0 = TILE,
    y0 = TILE,
    x1 = -1,
    y1 = -1;
  // RGBA coverage is alpha; masks count any nonzero value.
  const stride = channels;
  for (let y = 0; y < TILE; y++) {
    let i = y * TILE * stride + stride - 1;
    for (let x = 0; x < TILE; x++, i += stride)
      if (d[i]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
function isUniform(d: Uint8ClampedArray, value: number) {
  for (let i = 0; i < d.length; i++) if (d[i] !== value) return false;
  return true;
}
/** New tiles for every tile `rect` touches: the base tile with `img` written
 * over it, or null when the tile ends up empty (equal to the grid's fill). */
export function tileize(base: GridPayload, rect: IRect, img: RGBA8 | Mask8): TileResult {
  const c = base.channels,
    { width, height } = rect;
  const tiles: TileResult['tiles'] = [];
  if (!width || !height) return { channels: c, tiles };
  const { lx, ly, tx0, ty0, tx1, ty1 } = tileRange(base, rect);
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = tileKey(tx, ty),
        old = base.tiles[key];
      const d = old ? new Uint8ClampedArray(old) : new Uint8ClampedArray(TILE * TILE * c);
      if (!old && c === 1 && base.fill) d.fill(base.fill);
      const sx0 = Math.max(lx, tx * TILE),
        sy0 = Math.max(ly, ty * TILE),
        sx1 = Math.min(lx + width, (tx + 1) * TILE),
        sy1 = Math.min(ly + height, (ty + 1) * TILE);
      for (let yy = sy0; yy < sy1; yy++) {
        const from = ((yy - ly) * width + (sx0 - lx)) * c;
        d.set(img.data.subarray(from, from + (sx1 - sx0) * c), ((yy - ty * TILE) * TILE + (sx0 - tx * TILE)) * c);
      }
      if (isUniform(d, c === 1 ? base.fill : 0)) tiles.push({ key, data: null, bounds: null });
      else tiles.push({ key, data: d, bounds: contentBounds(d, c) });
    }
  return { channels: c, tiles };
}
/** Store a worker result as a new grid derived from `grid` (which must be the
 * grid the payload came from). Equivalent to `writeRect`. */
export function mergeTiles(store: TileStore, grid: TileGrid, result: TileResult): TileGrid {
  if (!result.tiles.length) return grid;
  const next: TileGrid = { ...grid, tiles: { ...grid.tiles } };
  const touched = new Set<string>();
  let bounds: IRect | null = null;
  for (const t of result.tiles) {
    touched.add(t.key);
    if (!t.data) {
      delete next.tiles[t.key];
      continue;
    }
    next.tiles[t.key] = store.add(t.data);
    if (t.bounds) {
      const [tx, ty] = t.key.split(',').map(Number);
      bounds = unionRect(bounds, { x: t.bounds.x + tx * TILE, y: t.bounds.y + ty * TILE, width: t.bounds.width, height: t.bounds.height });
    }
  }
  if (grid.fill) {
    // Filled masks report unbounded coverage either way.
    next.bounds = computeBounds(store, next);
    return next;
  }
  // Content of untouched tiles keeps its own bounds; scan only those tiles.
  const rest: TileGrid = { ...grid, tiles: {} };
  let any = false;
  for (const [k, id] of Object.entries(grid.tiles))
    if (!touched.has(k)) {
      rest.tiles[k] = id;
      any = true;
    }
  if (any) bounds = unionRect(bounds, computeBounds(store, rest));
  next.bounds = bounds;
  return next;
}

/** True when a pixel of an RGBA grid inside document rect `r` is fully transparent. */
export function gridHasTransparent(store: TileStore, grid: TileGrid, r: IRect): boolean {
  const x0 = r.x - grid.x, y0 = r.y - grid.y, x1 = x0 + r.width, y1 = y0 + r.height;
  for (let ty = Math.floor(y0 / TILE); ty * TILE < y1; ty++)
    for (let tx = Math.floor(x0 / TILE); tx * TILE < x1; tx++) {
      const id = grid.tiles[tileKey(tx, ty)];
      const t = id ? store.get(id) : undefined;
      if (!t) return true;
      const ax = Math.max(x0, tx * TILE) - tx * TILE, bx = Math.min(x1, (tx + 1) * TILE) - tx * TILE;
      const ay = Math.max(y0, ty * TILE) - ty * TILE, by = Math.min(y1, (ty + 1) * TILE) - ty * TILE;
      for (let y = ay; y < by; y++)
        for (let j = (y * TILE + ax) * 4 + 3, end = (y * TILE + bx) * 4; j < end; j += 4) if (t[j] === 0) return true;
    }
  return false;
}
