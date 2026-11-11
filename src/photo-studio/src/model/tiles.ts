import type { IRect, Mask8, RGBA8 } from '../imaging/types';

// Destructive pixel editing stores layer content (and selections/channels) as a
// sparse grid of immutable 256 px tiles. History snapshots share tile IDs, so
// an edit only allocates the tiles it touches and undo is a reference swap.
export const TILE = 256;
export type TileGrid = {
  channels: 1 | 4;
  // Document position of local tile space. Moving a layer changes only this.
  x: number;
  y: number;
  // "tx,ty" → tile ID. Absent tiles are transparent (RGBA) or unselected (mask).
  tiles: Record<string, string>;
  // Tight content bounds in local space, maintained by writers; null when empty.
  bounds: IRect | null;
  // Value of absent mask tiles. A reveal-all layer mask or Select All stores no
  // tiles at all; only edited regions cost memory. RGBA grids are always 0.
  fill?: number;
};
export type TileData = Uint8ClampedArray;
export const tileKey = (tx: number, ty: number) => `${tx},${ty}`;
export function parseKey(key: string): [number, number] {
  const i = key.indexOf(',');
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}
export const emptyGrid = (channels: 1 | 4 = 4, x = 0, y = 0): TileGrid => ({
  channels,
  x,
  y,
  tiles: {},
  bounds: null,
});

/** Tile pixel storage. Committed tiles are never mutated; live strokes write
 * into fresh tiles and bump their version so caches can re-upload them. */
export class TileStore {
  private data = new Map<string, TileData>();
  private versions = new Map<string, number>();
  private counter = 0;
  get(id: string) {
    const d = this.data.get(id);
    if (!d) throw new Error('Missing pixel tile.');
    return d;
  }
  has(id: string) {
    return this.data.has(id);
  }
  add(data: TileData, id = `t${(this.counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`) {
    if (this.data.has(id)) throw new Error('Duplicate pixel tile identifier.');
    this.data.set(id, data);
    return id;
  }
  version(id: string) {
    return this.versions.get(id) ?? 0;
  }
  touch(id: string) {
    this.versions.set(id, this.version(id) + 1);
  }
  delete(id: string) {
    this.data.delete(id);
    this.versions.delete(id);
  }
  // Drop tiles no snapshot refers to any more.
  retain(keep: Set<string>) {
    for (const id of [...this.data.keys()]) if (!keep.has(id)) this.delete(id);
  }
  get size() {
    return this.data.size;
  }
  get bytes() {
    let total = 0;
    for (const d of this.data.values()) total += d.byteLength;
    return total;
  }
  clear() {
    this.data.clear();
    this.versions.clear();
  }
}

export function tileBytes(channels: 1 | 4) {
  return TILE * TILE * channels;
}
function tileEmpty(d: TileData, fill = 0) {
  for (let i = 0; i < d.length; i++) if (d[i] !== fill) return false;
  return true;
}
// Coverage lives in the alpha byte for RGBA tiles and the only byte for masks.
// Each row is scanned from both ends and stops at the first covered pixel, so
// opaque tiles cost two reads per row instead of a full scan.
function tileContentBounds(d: TileData, channels: 1 | 4): IRect | null {
  let x0 = TILE,
    y0 = TILE,
    x1 = -1,
    y1 = -1;
  const a = channels - 1;
  for (let y = 0; y < TILE; y++) {
    const row = y * TILE * channels + a;
    let first = 0;
    while (first < TILE && !d[row + first * channels]) first++;
    if (first === TILE) continue;
    if (first < x0) x0 = first;
    if (y < y0) y0 = y;
    y1 = y;
    // Only pixels right of the widest row so far can extend the bounds.
    for (let x = TILE - 1; x > x1 && x >= first; x--)
      if (d[row + x * channels]) {
        x1 = x;
        break;
      }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
export function unionRect(a: IRect | null, b: IRect | null): IRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
export function intersectRect(a: IRect, b: IRect): IRect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width),
    btm = Math.min(a.y + a.height, b.y + b.height);
  return r > x && btm > y ? { x, y, width: r - x, height: btm - y } : null;
}
/** Recompute tight bounds from all tiles (local space). */
export function computeBounds(store: TileStore, grid: TileGrid): IRect | null {
  // A filled mask covers everything; callers clip it to the canvas.
  if (grid.fill) return { x: -1e7, y: -1e7, width: 2e7, height: 2e7 };
  let bounds: IRect | null = null;
  for (const [key, id] of Object.entries(grid.tiles)) {
    const r = tileContentBounds(store.get(id), grid.channels);
    if (!r) continue;
    const [tx, ty] = parseKey(key);
    bounds = unionRect(bounds, { x: r.x + tx * TILE, y: r.y + ty * TILE, width: r.width, height: r.height });
  }
  return bounds;
}
/** Document-space content bounds. */
export function gridDocBounds(grid: TileGrid): IRect | null {
  const b = grid.bounds;
  return b ? { x: b.x + grid.x, y: b.y + grid.y, width: b.width, height: b.height } : null;
}

/** Read a document-space rectangle. Pixels outside the grid are zero. */
export function readRect(store: TileStore, grid: TileGrid, rect: IRect): RGBA8 | Mask8 {
  const c = grid.channels,
    { width, height } = rect;
  const out = c === 4 ? new Uint8ClampedArray(width * height * 4) : new Uint8Array(width * height);
  if (c === 1 && grid.fill) out.fill(grid.fill);
  const lx = rect.x - grid.x,
    ly = rect.y - grid.y;
  const tx0 = Math.floor(lx / TILE),
    ty0 = Math.floor(ly / TILE),
    tx1 = Math.floor((lx + width - 1) / TILE),
    ty1 = Math.floor((ly + height - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const id = grid.tiles[tileKey(tx, ty)];
      if (!id) continue;
      const d = store.get(id);
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
export function readRGBA(store: TileStore, grid: TileGrid, rect: IRect): RGBA8 {
  if (grid.channels !== 4) throw new Error('Expected a color tile grid.');
  return readRect(store, grid, rect) as RGBA8;
}
export function readMask(store: TileStore, grid: TileGrid, rect: IRect): Mask8 {
  if (grid.channels !== 1) throw new Error('Expected a mask tile grid.');
  return readRect(store, grid, rect) as Mask8;
}

/** Return a new grid with a document-space rectangle replaced by `src`.
 * Touched tiles are copied (never mutated) and empty tiles are dropped.
 * Tiles the write leaves as they were stay shared, so rewriting a whole
 * layer to change a few pixels costs memory only for the tiles that change. */
export function writeRect(
  store: TileStore,
  grid: TileGrid,
  x: number,
  y: number,
  src: { width: number; height: number; data: ArrayLike<number> & { subarray(a: number, b: number): ArrayLike<number> } },
): TileGrid {
  const c = grid.channels,
    { width, height } = src;
  if (!width || !height) return grid;
  const next: TileGrid = { ...grid, tiles: { ...grid.tiles } };
  const lx = x - grid.x,
    ly = y - grid.y;
  const tx0 = Math.floor(lx / TILE),
    ty0 = Math.floor(ly / TILE),
    tx1 = Math.floor((lx + width - 1) / TILE),
    ty1 = Math.floor((ly + height - 1) / TILE);
  let boundsDirty = false;
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = tileKey(tx, ty),
        old = grid.tiles[key];
      const sx0 = Math.max(lx, tx * TILE),
        sy0 = Math.max(ly, ty * TILE),
        sx1 = Math.min(lx + width, (tx + 1) * TILE),
        sy1 = Math.min(ly + height, (ty + 1) * TILE);
      if (writesNothing(src.data, width, lx, ly, sx0, sy0, sx1, sy1, c, tx, ty, old ? store.get(old) : undefined, c === 1 ? (grid.fill ?? 0) : 0)) continue;
      const d = old ? new Uint8ClampedArray(store.get(old)) : new Uint8ClampedArray(tileBytes(c));
      if (!old && c === 1 && grid.fill) d.fill(grid.fill);
      for (let yy = sy0; yy < sy1; yy++) {
        const from = ((yy - ly) * width + (sx0 - lx)) * c;
        d.set(src.data.subarray(from, from + (sx1 - sx0) * c) as ArrayLike<number>, ((yy - ty * TILE) * TILE + (sx0 - tx * TILE)) * c);
      }
      if (tileEmpty(d, c === 1 ? (grid.fill ?? 0) : 0)) delete next.tiles[key];
      else next.tiles[key] = store.add(d);
      boundsDirty = true;
    }
  if (boundsDirty) next.bounds = computeBounds(store, next);
  return next;
}

// True when writing the source span into a tile would not change it: the
// tile holds the same values, or it is absent and the values are its fill.
// Byte data is compared four bytes at a time when both sides are aligned.
const words = (a: ArrayLike<number>) =>
  (a instanceof Uint8Array || a instanceof Uint8ClampedArray) && a.byteOffset % 4 === 0
    ? new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2)
    : undefined;
function writesNothing(
  data: ArrayLike<number>,
  width: number,
  lx: number,
  ly: number,
  sx0: number,
  sy0: number,
  sx1: number,
  sy1: number,
  c: number,
  tx: number,
  ty: number,
  tile: TileData | undefined,
  fill: number,
) {
  const span = (sx1 - sx0) * c;
  const wide = c === 4 && (!tile || tile.byteOffset % 4 === 0) ? words(data) : undefined;
  const tileWords = wide && tile ? new Uint32Array(tile.buffer, tile.byteOffset, tile.byteLength >> 2) : undefined;
  for (let yy = sy0; yy < sy1; yy++) {
    const from = ((yy - ly) * width + (sx0 - lx)) * c;
    const to = ((yy - ty * TILE) * TILE + (sx0 - tx * TILE)) * c;
    if (wide) {
      const f = from >> 2, n = span >> 2;
      if (tileWords) {
        const t = to >> 2;
        for (let k = 0; k < n; k++) if (wide[f + k] !== tileWords[t + k]) return false;
      } else for (let k = 0; k < n; k++) if (wide[f + k] !== 0) return false;
    } else if (tile) {
      for (let k = 0; k < span; k++) if (data[from + k] !== tile[to + k]) return false;
    } else for (let k = 0; k < span; k++) if (data[from + k] !== fill) return false;
  }
  return true;
}

/** Build a grid (aligned with the document tile grid) from a buffer placed at a document position. */
export function gridFromImage(store: TileStore, img: RGBA8 | Mask8, x = 0, y = 0): TileGrid {
  const channels = img.data.length === img.width * img.height ? 1 : 4;
  return writeRect(store, emptyGrid(channels), x, y, img as RGBA8);
}
/** A mask grid with a constant value over a rectangle (Select All, rect marquee). */
export const allMask = (value = 255): TileGrid => ({ ...emptyGrid(1), fill: value, bounds: value ? { x: -1e7, y: -1e7, width: 2e7, height: 2e7 } : null });
export function filledMask(store: TileStore, rect: IRect, value = 255): TileGrid {
  const m = new Uint8Array(rect.width * rect.height).fill(value);
  return writeRect(store, emptyGrid(1), rect.x, rect.y, { width: rect.width, height: rect.height, data: m });
}
/** All tile IDs referenced by a grid. */
export function gridTileIds(grid: TileGrid | undefined | null, into = new Set<string>()) {
  if (grid) for (const id of Object.values(grid.tiles)) into.add(id);
  return into;
}

// Serialization packs one grid into a single binary asset: a small JSON header
// followed by each tile's bytes, deflated as a whole.
export const tilePackMimeType = 'application/x-photo-studio-tiles';
export async function packGrid(store: TileStore, grid: TileGrid): Promise<Blob> {
  const { deflate } = await import('pako');
  const keys = Object.keys(grid.tiles);
  const size = tileBytes(grid.channels);
  const header = new TextEncoder().encode(
    JSON.stringify({ v: 1, channels: grid.channels, x: grid.x, y: grid.y, fill: grid.fill ?? 0, keys }),
  );
  const raw = new Uint8Array(4 + header.length + keys.length * size);
  new DataView(raw.buffer).setUint32(0, header.length, true);
  raw.set(header, 4);
  keys.forEach((k, i) => raw.set(store.get(grid.tiles[k]), 4 + header.length + i * size));
  return new Blob([deflate(raw, { level: 3 })], { type: tilePackMimeType });
}
export async function unpackGrid(store: TileStore, blob: Blob): Promise<TileGrid> {
  const { inflate } = await import('pako');
  const raw = inflate(new Uint8Array(await blob.arrayBuffer()));
  const length = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + length))) as {
    v: number;
    channels: 1 | 4;
    x: number;
    y: number;
    fill: number;
    keys: string[];
  };
  if (header.v !== 1 || (header.channels !== 1 && header.channels !== 4) || !Array.isArray(header.keys))
    throw new Error('Invalid pixel tile pack.');
  const size = tileBytes(header.channels);
  if (raw.length !== 4 + length + header.keys.length * size) throw new Error('Invalid pixel tile pack length.');
  const grid = emptyGrid(header.channels, header.x, header.y);
  if (header.channels === 1 && Number.isInteger(header.fill) && header.fill > 0 && header.fill <= 255) grid.fill = header.fill;
  header.keys.forEach((k, i) => {
    if (!/^-?\d+,-?\d+$/.test(k)) throw new Error('Invalid pixel tile key.');
    const start = 4 + length + i * size;
    grid.tiles[k] = store.add(new Uint8ClampedArray(raw.slice(start, start + size)));
  });
  grid.bounds = computeBounds(store, grid);
  return grid;
}
