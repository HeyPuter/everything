// UDIM tiled images: one image made of tiles, each covering one unit square of UV space
// (tile 1001 + u + 10 × v). The first tile keeps its pixels in the image's own fields; the others
// are in `img.tiles`. For display and shading the tiles are laid out in one atlas canvas whose
// cells follow the UV squares (cell (c, r) holds tile 1001 + c + 10 r).
import type { ImageData as Img, UdimTile } from '../data/types';

export const UDIM_START = 1001;
/** Largest atlas side (px): tiles are scaled down to fit. */
export const ATLAS_LIMIT = 8192;

export function isTiled(img: Img | null | undefined): img is Img & { tiles: UdimTile[] } {
  return !!img && img.source === 'TILED' && !!img.tiles?.length;
}

/** Column and row of a tile number (1001 → 0, 0; 1012 → 1, 1). */
export function tileCell(n: number): [number, number] {
  const k = n - UDIM_START;
  return [((k % 10) + 10) % 10, Math.floor(k / 10)];
}

/** The tile number covering UV point (u, v), or null outside the UDIM range. */
export function tileNumberAt(u: number, v: number): number | null {
  const c = Math.floor(u),
    r = Math.floor(v);
  if (c < 0 || c > 9 || r < 0 || r > 99) return null;
  return UDIM_START + c + 10 * r;
}

/** Columns and rows spanned by the tiles (at least 1 × 1). */
export function tileGrid(numbers: number[]): { cols: number; rows: number } {
  let cols = 1,
    rows = 1;
  for (const n of numbers) {
    const [c, r] = tileCell(n);
    cols = Math.max(cols, c + 1);
    rows = Math.max(rows, r + 1);
  }
  return { cols, rows };
}

export function validTileNumber(n: number) {
  return Number.isInteger(n) && n >= UDIM_START && n <= 2000;
}

/** First free tile number at or after `from`. */
export function nextFreeTile(numbers: number[], from = UDIM_START): number {
  const used = new Set(numbers);
  let n = Math.max(UDIM_START, from);
  while (used.has(n) && n < 2000) n++;
  return n;
}

/** A file name for a tile: the <UDIM> token (or a four-digit 1xxx number) replaced by the tile number. */
export function udimFileName(pattern: string, n: number): string {
  if (pattern.includes('<UDIM>')) return pattern.replace('<UDIM>', String(n));
  const m = /^(.*[._-])(1\d{3})(\.[a-z0-9]+)$/i.exec(pattern);
  if (m) return `${m[1]}${n}${m[3]}`;
  const dot = pattern.lastIndexOf('.');
  return dot > 0 ? `${pattern.slice(0, dot)}.${n}${pattern.slice(dot)}` : `${pattern}.${n}`;
}

/**
 * Group file names that share a UDIM pattern (`name.1001.png`, `name.1002.png`, … or `name_1001.png`).
 * Returns the pattern with <UDIM> and the tile number of each file.
 */
export function detectUdimSets(names: string[]): { pattern: string; files: { index: number; number: number }[] }[] {
  const groups = new Map<string, { index: number; number: number }[]>();
  names.forEach((name, index) => {
    const m = /^(.*[._-])(1\d{3})(\.[a-z0-9]+)$/i.exec(name);
    if (!m || !validTileNumber(Number(m[2]))) return;
    const pattern = `${m[1]}<UDIM>${m[3]}`;
    let l = groups.get(pattern);
    if (!l) groups.set(pattern, (l = []));
    l.push({ index, number: Number(m[2]) });
  });
  return [...groups].map(([pattern, files]) => ({ pattern, files: files.sort((a, b) => a.number - b.number) }));
}

/** Tile data in one shape whether it is the first tile (the image's fields) or another one. */
export interface TileView {
  number: number;
  label: string;
  bytes: Uint8Array | null;
  mime: string;
  width: number;
  height: number;
  generated_type: 'BLANK' | 'UV_GRID' | 'COLOR_GRID';
  generated_color: [number, number, number, number];
  revision: number;
}

export function tileView(img: Img, i: number): TileView {
  const t = img.tiles![i];
  if (i === 0)
    return {
      number: t.number,
      label: t.label ?? '',
      bytes: img.bytes && img.bytes.length ? img.bytes : null,
      mime: img.mime,
      width: img.width,
      height: img.height,
      generated_type: img.generated_type ?? 'BLANK',
      generated_color: (img.generated_color ?? [0, 0, 0, 1]) as [number, number, number, number],
      revision: img.revision ?? 0,
    };
  return {
    number: t.number,
    label: t.label ?? '',
    bytes: t.bytes && t.bytes.length ? t.bytes : null,
    mime: t.mime ?? 'image/png',
    width: t.width,
    height: t.height,
    generated_type: t.generated_type ?? 'BLANK',
    generated_color: (t.generated_color ?? [0, 0, 0, 1]) as [number, number, number, number],
    revision: t.revision ?? 0,
  };
}

/** Readable name of a tile (its label, else its number). */
export function tileName(img: Img, i: number): string {
  const t = img.tiles?.[i];
  if (!t) return '';
  return t.label ? `${t.number} · ${t.label}` : String(t.number);
}

/** Change of any tile (for caches). */
export function tilesKey(img: Img): string {
  if (!isTiled(img)) return '';
  return img.tiles.map((_, i) => {
    const v = tileView(img, i);
    return `${v.number}:${v.width}x${v.height}:${v.bytes?.length ?? 0}:${v.revision}:${v.generated_type}:${v.generated_color.join(',')}`;
  }).join(';');
}

// ---------------------------------------------------------------------------
// tile pixels (browser)

interface TileCanvas {
  key: string;
  canvas: HTMLCanvasElement;
  ready: boolean;
}

const tileCache = new Map<string, Map<number, TileCanvas>>();
let readyListener: (() => void) | null = null;
/** Called when a tile finished decoding (images.ts redraws its users). */
export function onTileReady(fn: () => void) {
  readyListener = fn;
}

/** Draw a generated tile (same patterns as generated images). */
let drawGenerated: ((v: TileView, ctx: CanvasRenderingContext2D) => void) | null = null;
export function setGeneratedDrawer(fn: (v: TileView, ctx: CanvasRenderingContext2D) => void) {
  drawGenerated = fn;
}

/** Canvas with the pixels of tile `i` (decoded asynchronously from bytes). */
export function tileCanvas(img: Img, i: number): TileCanvas {
  const v = tileView(img, i);
  const key = `${v.width}x${v.height}|${v.bytes?.length ?? 0}|${v.revision}|${v.generated_type}|${v.generated_color.join(',')}`;
  let per = tileCache.get(img.id);
  if (!per) tileCache.set(img.id, (per = new Map()));
  const hit = per.get(v.number);
  if (hit && hit.key === key) return hit;
  const canvas = hit?.canvas ?? document.createElement('canvas');
  canvas.width = Math.max(1, v.width);
  canvas.height = Math.max(1, v.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const e: TileCanvas = { key, canvas, ready: false };
  per.set(v.number, e);
  if (v.bytes) {
    createImageBitmap(new Blob([v.bytes as Uint8Array<ArrayBuffer>], { type: v.mime }), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      .then((bmp) => {
        if (per!.get(v.number) !== e) return;
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        e.ready = true;
        readyListener?.();
      })
      .catch(() => {
        ctx.fillStyle = '#ff00ff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        e.ready = true;
      });
  } else {
    drawGenerated?.(v, ctx);
    e.ready = true;
  }
  return e;
}

/** Store pixels into tile `i` (PNG), as `writePixels` does for single images. */
export function encodeTilePixels(data: globalThis.ImageData): Uint8Array {
  const c = document.createElement('canvas');
  c.width = data.width;
  c.height = data.height;
  c.getContext('2d')!.putImageData(data, 0, 0);
  const url = c.toDataURL('image/png');
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return bytes;
}

/** Size of the atlas cells and the grid for an image's tiles. */
export function atlasLayout(img: Img): { cols: number; rows: number; cw: number; ch: number } {
  const n = img.tiles?.length ?? 0;
  const { cols, rows } = tileGrid((img.tiles ?? []).map((t) => t.number));
  let cw = 1,
    ch = 1;
  for (let i = 0; i < n; i++) {
    const v = tileView(img, i);
    cw = Math.max(cw, v.width);
    ch = Math.max(ch, v.height);
  }
  const k = Math.min(1, ATLAS_LIMIT / (cols * cw), ATLAS_LIMIT / (rows * ch));
  return { cols, rows, cw: Math.max(1, Math.floor(cw * k)), ch: Math.max(1, Math.floor(ch * k)) };
}

/** Draw every tile into the atlas canvas (cell rows bottom-up: v grows upwards). Returns how many tiles are ready. */
export function drawAtlas(img: Img, canvas: HTMLCanvasElement): number {
  const { cols, rows, cw, ch } = atlasLayout(img);
  if (canvas.width !== cols * cw || canvas.height !== rows * ch) {
    canvas.width = cols * cw;
    canvas.height = rows * ch;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  let ready = 0;
  img.tiles!.forEach((t, i) => {
    const tc = tileCanvas(img, i);
    if (tc.ready) ready++;
    const [c, r] = tileCell(t.number);
    ctx.drawImage(tc.canvas, c * cw, (rows - 1 - r) * ch, cw, ch);
  });
  return ready;
}

export function forgetTiles(id: string) {
  tileCache.delete(id);
}
