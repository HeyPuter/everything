import type { Guide, Layer, PhotoDocument, Rect } from './document';

// Guides come in two kinds. Canvas guides (`doc.guides`) are in document
// coordinates and run across the whole canvas and pasteboard. Artboard guides
// (`layer.artboard.guides`) belong to one artboard: their positions are
// offsets from the artboard's top-left corner, they span only the artboard
// and move, duplicate and disappear with it. Only type imports here: the
// document model calls this module.

/** Where a guide lives: the canvas, or the artboard layer with this ID. */
export type GuideOwner = 'canvas' | { artboard: string };
/** One guide in document coordinates, with where it is stored. */
export type PlacedGuide = Guide & {
  owner: GuideOwner;
  index: number;
  // Selection key: "c:<index>" or "a:<artboard id>:<index>".
  key: string;
  // Extent of an artboard guide (the artboard rectangle); absent for canvas guides.
  extent?: Rect;
};

type ArtboardLike = Layer & { artboard: NonNullable<Layer['artboard']> };
const artboards = (doc: Pick<PhotoDocument, 'layers'>) => doc.layers.filter((l): l is ArtboardLike => !!l.artboard && l.kind === 'group');

export const guideKey = (owner: GuideOwner, index: number) => (owner === 'canvas' ? `c:${index}` : `a:${owner.artboard}:${index}`);
/** Parse a selection key back into its owner and index. */
export function parseGuideKey(key: string): { owner: GuideOwner; index: number } | undefined {
  const c = /^c:(\d+)$/.exec(key);
  if (c) return { owner: 'canvas', index: Number(c[1]) };
  const a = /^a:(.+):(\d+)$/.exec(key);
  if (a) return { owner: { artboard: a[1] }, index: Number(a[2]) };
  return undefined;
}

/** Absolute position of an artboard guide given in artboard offsets. */
export const toDocument = (g: Guide, rect: Rect): Guide => ({ orientation: g.orientation, position: g.position + (g.orientation === 'vertical' ? rect.x : rect.y) });
/** Artboard offset of a guide given in document coordinates. */
export const toArtboard = (g: Guide, rect: Rect): Guide => ({ orientation: g.orientation, position: g.position - (g.orientation === 'vertical' ? rect.x : rect.y) });

/** Every guide in document coordinates. Filters choose canvas or artboard guides. */
export function placedGuides(doc: Pick<PhotoDocument, 'guides' | 'layers'>, opts: { canvas?: boolean; artboards?: boolean } = {}): PlacedGuide[] {
  const out: PlacedGuide[] = [];
  if (opts.canvas !== false) (doc.guides ?? []).forEach((g, index) => out.push({ ...g, owner: 'canvas', index, key: guideKey('canvas', index) }));
  if (opts.artboards !== false)
    for (const a of artboards(doc)) {
      const owner = { artboard: a.id };
      (a.artboard.guides ?? []).forEach((g, index) => out.push({ ...toDocument(g, a.artboard.rect), owner, index, key: guideKey(owner, index), extent: { ...a.artboard.rect } }));
    }
  return out;
}
/** Guide positions by axis for snapping (canvas and artboard guides). */
export function guideLines(doc: Pick<PhotoDocument, 'guides'> & Partial<Pick<PhotoDocument, 'layers'>>): { x: number[]; y: number[] } {
  const out = { x: [] as number[], y: [] as number[] };
  for (const g of placedGuides({ guides: doc.guides, layers: doc.layers ?? [] })) (g.orientation === 'vertical' ? out.x : out.y).push(g.position);
  return out;
}

/** Top-level artboard under a document point (topmost first), if any. */
export function artboardAt(doc: Pick<PhotoDocument, 'layers'>, x: number, y: number): ArtboardLike | undefined {
  const list = artboards(doc);
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i].artboard.rect;
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return list[i];
  }
  return undefined;
}

/** The guide list an owner stores (read only). */
export function ownerGuides(doc: Pick<PhotoDocument, 'guides' | 'layers'>, owner: GuideOwner): Guide[] {
  if (owner === 'canvas') return doc.guides ?? [];
  return artboards(doc).find((a) => a.id === owner.artboard)?.artboard.guides ?? [];
}
/** Replace an owner's guide list in a draft document (empty lists are removed). */
export function setOwnerGuides(doc: PhotoDocument, owner: GuideOwner, guides: Guide[]) {
  if (owner === 'canvas') {
    doc.guides = guides.length ? guides : undefined;
    return;
  }
  const a = artboards(doc).find((l) => l.id === owner.artboard);
  if (!a) return;
  a.artboard = { ...a.artboard };
  if (guides.length) a.artboard.guides = guides;
  else delete a.artboard.guides;
}
/** Remove guides by selection key; returns how many were removed. */
export function removeGuides(doc: PhotoDocument, keys: Iterable<string>): number {
  const byOwner = new Map<string, { owner: GuideOwner; drop: Set<number> }>();
  for (const k of keys) {
    const p = parseGuideKey(k);
    if (!p) continue;
    const id = p.owner === 'canvas' ? 'canvas' : p.owner.artboard;
    const entry = byOwner.get(id) ?? { owner: p.owner, drop: new Set<number>() };
    entry.drop.add(p.index);
    byOwner.set(id, entry);
  }
  let n = 0;
  for (const { owner, drop } of byOwner.values()) {
    const list = ownerGuides(doc, owner);
    const kept = list.filter((_, i) => !drop.has(i));
    n += list.length - kept.length;
    setOwnerGuides(doc, owner, kept);
  }
  return n;
}

/** A guide mapped through a point map (canvas rotation, resize, crop), or
 * undefined when it no longer runs along an axis. */
export function mapGuide(g: Guide, f: (x: number, y: number) => [number, number]): Guide | undefined {
  const eps = 1e-6;
  const v = g.orientation === 'vertical';
  const a = f(v ? g.position : 0, v ? 0 : g.position),
    b = f(v ? g.position : 1, v ? 1 : g.position);
  if (Math.abs(a[0] - b[0]) < eps) return { orientation: 'vertical', position: a[0] };
  if (Math.abs(a[1] - b[1]) < eps) return { orientation: 'horizontal', position: a[1] };
  return undefined;
}
/** Artboard guides through a canvas edit: offsets from the old rectangle
 * become offsets from the mapped rectangle. */
export function mapArtboardGuides(guides: Guide[], before: Rect, after: Rect, f: (x: number, y: number) => [number, number]): Guide[] {
  const out: Guide[] = [];
  for (const g of guides) {
    const m = mapGuide(toDocument(g, before), f);
    if (m) out.push(toArtboard(m, after));
  }
  return out;
}

/** An artboard's guides after its rectangle changes from `before` to
 * `after` without scaling (a resize from any edge): each guide keeps its
 * place on the content, so offsets shift by the moved corner, and guides now
 * outside the artboard are dropped, as a crop drops canvas guides. */
export function resizedArtboardGuides(guides: Guide[], before: Rect, after: Rect): Guide[] {
  const out: Guide[] = [];
  for (const g of guides) {
    const v = g.orientation === 'vertical';
    const position = g.position + (v ? before.x - after.x : before.y - after.y);
    if (position >= 0 && position <= (v ? after.width : after.height)) out.push({ orientation: g.orientation, position });
  }
  return out;
}
/** Give an artboard (in a draft) a new rectangle, keeping its guides on the content. */
export function setArtboardRect(a: Pick<ArtboardLike, 'artboard'>, rect: Rect) {
  const guides = a.artboard.guides && resizedArtboardGuides(a.artboard.guides, a.artboard.rect, rect);
  a.artboard.rect = rect;
  if (guides?.length) a.artboard.guides = guides;
  else delete a.artboard.guides;
}

const validGuide = (g: unknown): g is Guide =>
  !!g && typeof g === 'object' && ((g as Guide).orientation === 'vertical' || (g as Guide).orientation === 'horizontal') && Number.isFinite((g as Guide).position) && Math.abs((g as Guide).position) < 1e7;
/** Guides of a project as read from a file: entries that are not guides are
 * dropped (older projects stored them without checks) and positions keep only
 * their two orientations. Older projects have only canvas guides, which stay
 * canvas guides; artboard guides were introduced with `artboard.guides`.
 * Throws when a guide list is not a list at all. */
export function migrateGuides(doc: PhotoDocument) {
  const clean = (list: unknown, what: string): Guide[] | undefined => {
    if (list === undefined || list === null) return undefined;
    if (!Array.isArray(list)) throw new Error(`Invalid ${what}.`);
    const out = list.filter(validGuide).map((g) => ({ orientation: g.orientation, position: g.position }));
    return out.length ? out : undefined;
  };
  const canvas = clean(doc.guides, 'guides');
  if (canvas) doc.guides = canvas;
  else delete doc.guides;
  for (const l of artboards(doc)) {
    const list = clean(l.artboard.guides, 'artboard guides');
    if (list) l.artboard.guides = list;
    else delete l.artboard.guides;
  }
}

/** Guides along the bounds and center of a rectangle (New Guides From Shape). */
export function rectGuides(r: Rect, center = true): Guide[] {
  const out: Guide[] = [
    { orientation: 'vertical', position: r.x },
    { orientation: 'vertical', position: r.x + r.width },
    { orientation: 'horizontal', position: r.y },
    { orientation: 'horizontal', position: r.y + r.height },
  ];
  if (center) out.push({ orientation: 'vertical', position: r.x + r.width / 2 }, { orientation: 'horizontal', position: r.y + r.height / 2 });
  return out;
}
/** Add guides to a list, skipping ones already there (within 0.01 px). */
export function mergeGuides(list: Guide[], add: Guide[]): Guide[] {
  const out = [...list];
  for (const g of add) if (!out.some((h) => h.orientation === g.orientation && Math.abs(h.position - g.position) < 0.01)) out.push(g);
  return out;
}
