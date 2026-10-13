// A Photo Studio document as a Yjs document, so concurrent edits merge.
//
//   doc       Y.Map  document settings, one atomic register per property
//   layers    Y.Map  layer ID → Y.Map:
//                      parent  ID of the enclosing group ('' at the top level)
//                      order   fractional key among its siblings (see order.ts)
//                      p:<key> one atomic register per layer property
//                      g:<key> tile grid placement (channels, origin, fill)
//                      t:<key> Y.Map tile key → content hash, one per tile
//   assets    Y.Map  asset ID → { type, size, chunks: content hashes }
//   comments  Y.Map  review threads (see ycomments.ts)
//
// Edits are written as the difference between the document before and after
// an editor history step, so only what the step changed is sent. Different
// layers and different properties merge; the same property is last writer
// wins; painting on one layer merges per 256-pixel tile, the same tile being
// last writer wins. Tile grids inside other registers (alpha channels,
// patterns, altered video frames) are atomic with their register. Selections
// are each person's own and never shared.
import * as Y from 'yjs';
import type { Layer, PhotoDocument } from '../model/document';
import { computeBounds, type TileGrid } from '../model/tiles';
import { syncPixelTransform } from '../model/pixel-layer';
import type { Assets } from '../model/assets';
import type { TileIndex } from './tile-index';
import { orderKeys } from './order';
import { hash } from './protocol';
import { documentAssetIds } from '../model/serialization';

export { documentAssetIds };

/** Transaction origins. Only `local` edits enter this person's Undo. */
export const ORIGIN = {
  local: { kind: 'local' },
  remote: { kind: 'remote' },
  comments: { kind: 'comments' },
  untracked: { kind: 'untracked' },
} as const;

export const SCHEMA = 1;
// Document properties every participant keeps for themselves.
const PRIVATE_DOC = new Set(['layers', 'selection', 'selectionMask']);
// Layer properties held as per-tile maps.
export const GRID_KEYS = ['pixels', 'maskGrid', 'liveSource', 'liveMask'] as const;
const GRID_SET = new Set<string>(GRID_KEYS);
const CHUNK = 4 * 1024 * 1024;

type GridMeta = { channels: 1 | 4; x: number; y: number; fill?: number };
type GridRef = GridMeta & { $grid: 1; tiles: Record<string, string> };
export type AssetRef = { type: string; size: number; chunks: string[] };

const isGrid = (v: unknown): v is TileGrid => {
  const g = v as TileGrid;
  return !!g && typeof g === 'object' && (g.channels === 1 || g.channels === 4) && typeof g.x === 'number' && typeof g.y === 'number' && !!g.tiles && typeof g.tiles === 'object' && 'bounds' in g;
};
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Tile IDs a document refers to, wherever they are. */
export function documentTiles(doc: PhotoDocument, into = new Set<string>()) {
  const walk = (v: unknown, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 12) return;
    if (isGrid(v)) {
      for (const id of Object.values(v.tiles)) into.add(id);
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  for (const [k, v] of Object.entries(doc)) if (k !== 'selectionMask') walk(v);
  return into;
}

/** What an edit needs uploaded before its change is sent. */
export type Prepared = { tiles: Map<string, string>; assets: Map<string, { ref: AssetRef; chunks: Blob[] }> };

export class SharedProject {
  readonly doc: Y.Map<unknown>;
  readonly layers: Y.Map<Y.Map<unknown>>;
  readonly assets: Y.Map<AssetRef>;
  readonly meta: Y.Map<unknown>;
  // Projected layers by ID, reused until their entry changes.
  private cache = new Map<string, Layer>();
  private dirty = new Set<string>();
  private allDirty = true;
  private docCache?: Record<string, unknown>;
  constructor(
    public tiles: TileIndex,
    public ydoc = new Y.Doc(),
  ) {
    this.doc = ydoc.getMap('doc');
    this.layers = ydoc.getMap('layers');
    this.assets = ydoc.getMap('assets');
    this.meta = ydoc.getMap('meta');
    this.layers.observeDeep((events) => {
      for (const ev of events) {
        if (ev.target === this.layers) for (const k of (ev as Y.YMapEvent<unknown>).keysChanged) this.dirty.add(k);
        else if (typeof ev.path[0] === 'string') this.dirty.add(ev.path[0]);
      }
    });
    this.doc.observe(() => (this.docCache = undefined));
  }

  // ----- Writing -----

  /** Hash new tiles and package new assets an edit refers to. */
  async prepare(after: PhotoDocument, assets: Assets): Promise<Prepared> {
    const tiles = await this.tiles.ensure(documentTiles(after));
    const out: Prepared = { tiles, assets: new Map() };
    for (const id of documentAssetIds(after)) {
      if (this.assets.has(id) || !assets.has(id)) continue;
      const blob = assets.blob(id);
      const chunks: Blob[] = [];
      for (let at = 0; at < blob.size || at === 0; at += CHUNK) {
        chunks.push(blob.slice(at, at + CHUNK));
        if (!blob.size) break;
      }
      const hashes = await Promise.all(chunks.map(async (c) => hash(new Uint8Array(await c.arrayBuffer()))));
      out.assets.set(id, { ref: { type: blob.type, size: blob.size, chunks: hashes }, chunks });
    }
    return out;
  }

  private encode(v: unknown, depth = 0): unknown {
    if (depth > 64) throw new Error('This document is nested too deeply to share.');
    if (isGrid(v)) return this.gridRef(v);
    if (Array.isArray(v)) return v.map((x) => this.encode(x, depth + 1));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = this.encode(x, depth + 1);
      return o;
    }
    return v;
  }
  private tileHash(id: string) {
    const h = this.tiles.hashOf(id);
    if (!h) throw new Error('A tile was changed before it was prepared for sharing.');
    return h;
  }
  private gridRef(g: TileGrid): GridRef {
    const tiles: Record<string, string> = {};
    for (const [k, id] of Object.entries(g.tiles)) tiles[k] = this.tileHash(id);
    return { $grid: 1, channels: g.channels, x: g.x, y: g.y, ...(g.fill ? { fill: g.fill } : {}), tiles };
  }

  /** Write the change from `before` to `after` (one editor step). Assets
   * from `prepared` are registered in the same transaction. */
  write(before: PhotoDocument | null, after: PhotoDocument, prepared?: Prepared, origin: object = ORIGIN.local) {
    this.ydoc.transact(() => {
      if (!this.meta.has('schema')) this.meta.set('schema', SCHEMA);
      for (const [id, { ref }] of prepared?.assets ?? []) if (!this.assets.has(id)) this.assets.set(id, ref);
      this.writeDoc(before, after);
      this.writeLayers(before, after);
    }, origin);
  }
  private writeDoc(before: PhotoDocument | null, after: PhotoDocument) {
    const a = (before ?? {}) as unknown as Record<string, unknown>,
      b = after as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (PRIVATE_DOC.has(key)) continue;
      const next = b[key];
      if (next === undefined) {
        if (a[key] !== undefined && this.doc.has(key)) this.doc.delete(key);
      } else if (!before || !same(a[key], next)) this.doc.set(key, this.encode(next));
    }
  }
  private writeLayers(before: PhotoDocument | null, after: PhotoDocument) {
    const index = (doc: PhotoDocument | null) => {
      const m = new Map<string, { layer: Layer; parent: string }>();
      const walk = (layers: Layer[], parent: string) => {
        for (const l of layers) {
          m.set(l.id, { layer: l, parent });
          walk(l.children, l.id);
        }
      };
      if (doc) walk(doc.layers, '');
      return m;
    };
    const was = index(before),
      now = index(after);
    for (const id of was.keys()) if (!now.has(id) && this.layers.has(id)) this.layers.delete(id);
    const moved = new Set<string>();
    for (const [id, { layer, parent }] of now) {
      const old = was.get(id);
      let entry = this.layers.get(id);
      if (!old || !entry) {
        // New layer (or one another person removed meanwhile: added again).
        entry = new Y.Map<unknown>();
        this.layers.set(id, entry);
        entry.set('parent', parent);
        this.writeLayer(entry, null, layer);
        moved.add(parent);
        continue;
      }
      if (old.parent !== parent) {
        entry.set('parent', parent);
        moved.add(parent);
      }
      this.writeLayer(entry, old.layer, layer);
    }
    // Sibling order: only parents whose children changed order get new keys.
    const children = (doc: PhotoDocument | null, parent: string) => {
      if (!doc) return [];
      if (!parent) return doc.layers.map((l) => l.id);
      return (now.get(parent)?.layer ?? was.get(parent)?.layer)?.children.map((l) => l.id) ?? [];
    };
    const parents = new Set<string>(['', ...[...now.values()].filter((x) => x.layer.kind === 'group').map((x) => x.layer.id)]);
    for (const p of parents) {
      const ids = children(after, p);
      const old = p === '' ? (before?.layers.map((l) => l.id) ?? []) : (was.get(p)?.layer.children.map((l) => l.id) ?? []);
      if (!moved.has(p) && same(ids, old)) continue;
      const keys = orderKeys(ids, (id) => {
        const v = this.layers.get(id)?.get('order');
        return typeof v === 'string' ? v : undefined;
      });
      for (const [id, key] of keys) this.layers.get(id)?.set('order', key);
    }
  }
  private writeLayer(entry: Y.Map<unknown>, before: Layer | null, after: Layer) {
    const a = (before ?? {}) as unknown as Record<string, unknown>,
      b = after as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === 'id' || key === 'children') continue;
      const prev = a[key],
        next = b[key];
      if (GRID_SET.has(key)) {
        this.writeGrid(entry, key, before ? (prev as TileGrid | undefined) : undefined, next as TileGrid | undefined);
        continue;
      }
      if (next === undefined) {
        if (prev !== undefined) entry.delete('p:' + key);
      } else if (!before || !same(prev, next)) entry.set('p:' + key, this.encode(next));
    }
  }
  private writeGrid(entry: Y.Map<unknown>, key: string, prev: TileGrid | undefined, next: TileGrid | undefined) {
    if (!next) {
      if (prev) {
        entry.delete('g:' + key);
        entry.delete('t:' + key);
      }
      return;
    }
    const meta: GridMeta = { channels: next.channels, x: next.x, y: next.y, ...(next.fill ? { fill: next.fill } : {}) };
    let tiles = entry.get('t:' + key);
    const fresh = !prev || !(tiles instanceof Y.Map) || prev.channels !== next.channels;
    if (fresh || !same(entry.get('g:' + key), meta)) entry.set('g:' + key, meta);
    if (fresh) {
      tiles = new Y.Map<string>();
      entry.set('t:' + key, tiles);
      for (const [k, id] of Object.entries(next.tiles)) (tiles as Y.Map<string>).set(k, this.tileHash(id));
      return;
    }
    const map = tiles as Y.Map<string>;
    for (const [k, id] of Object.entries(next.tiles)) if (prev!.tiles[k] !== id) map.set(k, this.tileHash(id));
    for (const k of Object.keys(prev!.tiles)) if (!(k in next.tiles) && map.has(k)) map.delete(k);
  }

  // ----- Reading -----

  /** Content hashes and assets the projection needs that this browser lacks. */
  missing(assets: Assets): { tiles: Set<string>; assets: Map<string, AssetRef> } {
    const tiles = new Set<string>();
    const need = (h: unknown) => {
      if (typeof h === 'string' && !this.tiles.tileFor(h)) tiles.add(h);
    };
    const walk = (v: unknown, depth = 0) => {
      if (!v || typeof v !== 'object' || depth > 64) return;
      if ((v as GridRef).$grid === 1) {
        for (const h of Object.values((v as GridRef).tiles ?? {})) need(h);
        return;
      }
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
    };
    for (const v of this.doc.values()) walk(v);
    for (const entry of this.layers.values()) {
      if (!(entry instanceof Y.Map)) continue;
      for (const [k, v] of entry) {
        if (k.startsWith('t:') && v instanceof Y.Map) for (const h of v.values()) need(h);
        else if (k.startsWith('p:')) walk(v);
      }
    }
    const out = new Map<string, AssetRef>();
    for (const [id, ref] of this.assets) if (!assets.has(id) && this.referenced(id)) out.set(id, ref);
    return { tiles, assets: out };
  }
  private referencedIds?: Set<string>;
  private referenced(id: string) {
    return this.referencedIds?.has(id) ?? true;
  }

  private decode(v: unknown, depth = 0): unknown {
    if (depth > 64) throw new Error('Invalid shared document.');
    if (v && typeof v === 'object' && (v as GridRef).$grid === 1) return this.resolveGrid(v as GridRef, (v as GridRef).tiles);
    if (Array.isArray(v)) return v.map((x) => this.decode(x, depth + 1));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = this.decode(x, depth + 1);
      return o;
    }
    return v;
  }
  private resolveGrid(meta: GridMeta, hashes: Record<string, string> | Iterable<[string, string]>): TileGrid {
    if (!meta || (meta.channels !== 1 && meta.channels !== 4) || !Number.isFinite(meta.x) || !Number.isFinite(meta.y)) throw new Error('Invalid shared tile grid.');
    const grid: TileGrid = { channels: meta.channels, x: meta.x, y: meta.y, tiles: {}, bounds: null };
    if (meta.channels === 1 && Number.isInteger(meta.fill) && meta.fill! > 0 && meta.fill! <= 255) grid.fill = meta.fill;
    const entries = Symbol.iterator in Object(hashes) ? (hashes as Iterable<[string, string]>) : Object.entries(hashes);
    for (const [k, h] of entries) {
      if (!/^-?\d{1,6},-?\d{1,6}$/.test(k)) throw new Error('Invalid shared tile key.');
      const id = typeof h === 'string' ? this.tiles.tileFor(h) : undefined;
      // A tile still downloading is left out; the projection is redone once it arrives.
      if (id) grid.tiles[k] = id;
      else this.incomplete = true;
    }
    grid.bounds = computeBounds(this.tiles.store, grid);
    return grid;
  }
  private incomplete = false;

  private projectLayer(id: string, entry: Y.Map<unknown>): Layer {
    const l: Record<string, unknown> = { id };
    for (const [k, v] of entry) {
      if (k.startsWith('p:')) l[k.slice(2)] = this.decode(v);
      else if (k.startsWith('g:') && GRID_SET.has(k.slice(2))) {
        const tiles = entry.get('t:' + k.slice(2));
        l[k.slice(2)] = this.resolveGrid(v as GridMeta, tiles instanceof Y.Map ? (tiles.entries() as Iterable<[string, string]>) : {});
      }
    }
    l.children = [];
    return l as unknown as Layer;
  }

  /** The shared document as an editor document; `local` supplies this
   * person's selection. Returns `complete: false` while tiles download. */
  project(local: Pick<PhotoDocument, 'selection' | 'selectionMask'>): { document: PhotoDocument; complete: boolean } {
    let complete = true;
    const ids = [...this.layers.keys()];
    for (const id of this.cache.keys()) if (!this.layers.has(id)) this.cache.delete(id);
    for (const id of ids) {
      if (!this.allDirty && !this.dirty.has(id) && this.cache.has(id) && !this.stale.has(id)) continue;
      const entry = this.layers.get(id);
      if (!(entry instanceof Y.Map)) continue;
      this.incomplete = false;
      this.cache.set(id, this.projectLayer(id, entry));
      if (this.incomplete) this.stale.add(id);
      else this.stale.delete(id);
    }
    if (this.stale.size) complete = false;
    this.dirty.clear();
    this.allDirty = false;
    // Tree: children sorted by order key, then ID; orphans and cycles go to the top level.
    const parentOf = new Map<string, string>();
    for (const id of ids) {
      const p = this.layers.get(id)?.get('parent');
      parentOf.set(id, typeof p === 'string' && p !== id && this.cache.get(p)?.kind === 'group' ? p : '');
    }
    for (const id of ids) {
      const seen: string[] = [];
      let at = id;
      while (at && !seen.includes(at)) {
        seen.push(at);
        at = parentOf.get(at) ?? '';
      }
      if (at) {
        // A cycle from concurrent moves: the greatest ID in it moves to the top.
        const loop = seen.slice(seen.indexOf(at));
        parentOf.set(loop.sort().at(-1)!, '');
      }
    }
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const p = parentOf.get(id)!;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(id);
    }
    const key = (id: string) => {
      const v = this.layers.get(id)?.get('order');
      return typeof v === 'string' ? v : '';
    };
    for (const list of groups.values()) list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : a > b ? 1 : 0));
    let docRegs = this.docCache;
    if (!docRegs) {
      this.incomplete = false;
      docRegs = {};
      for (const [k, v] of this.doc) if (!PRIVATE_DOC.has(k)) docRegs[k] = this.decode(v);
      if (this.incomplete) complete = false;
      else this.docCache = docRegs;
    }
    const document = { ...structuredCloneShallow(docRegs), selection: local.selection ?? null } as PhotoDocument;
    if (local.selectionMask) document.selectionMask = local.selectionMask;
    const build = (parent: string, depth: number): Layer[] =>
      (groups.get(parent) ?? []).map((id) => {
        const l = { ...this.cache.get(id)! };
        l.children = depth < 12 ? build(id, depth + 1) : [];
        // Pixel layers keep their transform equal to their merged content.
        if (l.kind === 'pixel' && l.pixels?.bounds) syncPixelTransform(l, document);
        return l;
      });
    document.layers = build('', 0);
    document.version = 1;
    this.referencedIds = new Set(documentAssetIds(document));
    return { document, complete };
  }
  private stale = new Set<string>();
  /** Project everything again (after tiles arrived). */
  invalidate() {
    this.allDirty = true;
    this.docCache = undefined;
  }
}
// Registers are never mutated by the editor (history clones before editing),
// so a shallow copy of the top-level record is enough.
const structuredCloneShallow = <T extends object>(o: T): T => ({ ...o });
