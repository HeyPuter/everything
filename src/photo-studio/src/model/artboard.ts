import { allLayers, assertSize, containerOf, cropDocument, findLayer, layer, type Layer, type PhotoDocument, type Rect } from './document';
import { transformBounds, transformSelection } from './transform';

// Artboards are top-level groups with their own rectangle, a background and
// an option to clip their contents. Layers outside every artboard stay on the
// canvas (pasteboard). Rectangles are in document pixels.
export type ArtboardBackground = 'white' | 'black' | 'transparent' | 'custom';
export type ArtboardData = {
  rect: Rect;
  background: ArtboardBackground;
  // #rrggbb for a custom background.
  color?: string;
  // Clip contents to the rectangle (default true).
  clip?: boolean;
  // Preset the size came from, shown in Properties until the size changes.
  preset?: string;
  // Artboard guides: offsets from the rectangle's top-left corner (model/guides.ts).
  guides?: import('./document').Guide[];
};
export type ArtboardLayer = Layer & { artboard: ArtboardData };

export const isArtboard = (l: Layer | undefined): l is ArtboardLayer => !!l?.artboard && l.kind === 'group';
export const artboardLayers = (doc: Pick<PhotoDocument, 'layers'>) => doc.layers.filter(isArtboard);
export const hasArtboards = (doc: Pick<PhotoDocument, 'layers'>) => doc.layers.some(isArtboard);

/** Background fill color, or null for a transparent artboard. */
export function artboardFill(a: ArtboardData): string | null {
  if (a.background === 'white') return '#ffffff';
  if (a.background === 'black') return '#000000';
  if (a.background === 'custom') return a.color ?? '#ffffff';
  return null;
}

// Common output sizes in pixels. Print sizes assume 300 pixels per inch.
export type ArtboardPreset = { id: string; category: string; name: string; width: number; height: number };
export const artboardPresets: ArtboardPreset[] = [
  { id: 'phone-compact', category: 'Phone', name: 'Compact phone', width: 360, height: 640 },
  { id: 'phone', category: 'Phone', name: 'Phone', width: 390, height: 844 },
  { id: 'phone-large', category: 'Phone', name: 'Large phone', width: 430, height: 932 },
  { id: 'tablet', category: 'Tablet', name: 'Tablet', width: 768, height: 1024 },
  { id: 'tablet-large', category: 'Tablet', name: 'Large tablet', width: 1024, height: 1366 },
  { id: 'watch', category: 'Wearable', name: 'Watch face', width: 198, height: 242 },
  { id: 'laptop', category: 'Desktop', name: 'Laptop', width: 1366, height: 768 },
  { id: 'desktop', category: 'Desktop', name: 'Desktop', width: 1440, height: 900 },
  { id: 'full-hd', category: 'Desktop', name: 'Full HD', width: 1920, height: 1080 },
  { id: 'qhd', category: 'Desktop', name: 'Quad HD', width: 2560, height: 1440 },
  { id: 'web-banner', category: 'Web', name: 'Leaderboard banner', width: 728, height: 90 },
  { id: 'web-rectangle', category: 'Web', name: 'Medium rectangle', width: 300, height: 250 },
  { id: 'web-hero', category: 'Web', name: 'Hero image', width: 1600, height: 900 },
  { id: 'social-square', category: 'Social', name: 'Square post', width: 1080, height: 1080 },
  { id: 'social-portrait', category: 'Social', name: 'Portrait post', width: 1080, height: 1350 },
  { id: 'social-story', category: 'Social', name: 'Story / vertical video', width: 1080, height: 1920 },
  { id: 'social-link', category: 'Social', name: 'Link preview', width: 1200, height: 630 },
  { id: 'social-cover', category: 'Social', name: 'Profile cover', width: 1500, height: 500 },
  { id: 'video-thumb', category: 'Social', name: 'Video thumbnail', width: 1280, height: 720 },
  { id: 'icon-app', category: 'Icon', name: 'App icon', width: 1024, height: 1024 },
  { id: 'icon-fav', category: 'Icon', name: 'Small icon', width: 64, height: 64 },
  { id: 'print-a4', category: 'Print (300 ppi)', name: 'A4', width: 2480, height: 3508 },
  { id: 'print-a5', category: 'Print (300 ppi)', name: 'A5', width: 1748, height: 2480 },
  { id: 'print-letter', category: 'Print (300 ppi)', name: 'US Letter', width: 2550, height: 3300 },
  { id: 'print-postcard', category: 'Print (300 ppi)', name: 'Postcard 4 × 6 in', width: 1200, height: 1800 },
  { id: 'print-card', category: 'Print (300 ppi)', name: 'Business card 3.5 × 2 in', width: 1050, height: 600 },
  { id: 'print-poster', category: 'Print (300 ppi)', name: 'Poster 11 × 17 in', width: 3300, height: 5100 },
];
export const presetById = (id: string | undefined) => artboardPresets.find((p) => p.id === id);
/** Preset whose size (either orientation) matches; used to label sizes. */
export function matchingPreset(width: number, height: number, hint?: string) {
  const exact = (p: ArtboardPreset) => p.width === width && p.height === height;
  const same = (p: ArtboardPreset) => exact(p) || (p.width === height && p.height === width);
  const preferred = presetById(hint);
  return preferred && same(preferred) ? preferred : (artboardPresets.find(exact) ?? artboardPresets.find(same));
}

/** Rectangle spanned by two points, on whole pixels, at least 1 × 1. */
export function dragRect(a: [number, number], b: [number, number]): Rect {
  const x = Math.round(Math.min(a[0], b[0])),
    y = Math.round(Math.min(a[1], b[1]));
  return {
    x,
    y,
    width: Math.max(1, Math.round(Math.max(a[0], b[0])) - x),
    height: Math.max(1, Math.round(Math.max(a[1], b[1])) - y),
  };
}
export const rectContains = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
export const rectsOverlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
export function unionRect(rects: Rect[]): Rect | undefined {
  if (!rects.length) return;
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

/** Topmost visible artboard under a document point. */
export function artboardAt(doc: Pick<PhotoDocument, 'layers'>, x: number, y: number, exclude?: string) {
  return [...artboardLayers(doc)].reverse().find((a) => a.id !== exclude && a.visible && rectContains(a.artboard.rect, x, y));
}
/** The artboard that directly or indirectly contains a layer. */
export function artboardOf(doc: Pick<PhotoDocument, 'layers'>, id: string): ArtboardLayer | undefined {
  return artboardLayers(doc).find((a) => a.id === id || !!findLayer(a.children, id));
}

/** Document-space bounds of a layer: artboard/frame rectangles, transformed
 * leaf bounds, or the union of a group's children. */
export function layerBounds(l: Layer): Rect | undefined {
  if (l.artboard) return { ...l.artboard.rect };
  if (l.frame) return { ...l.frame.rect };
  if (l.kind === 'adjustment') return;
  if (l.kind !== 'group') return transformBounds(l.transform);
  return unionRect(l.children.map(layerBounds).filter((r): r is Rect => !!r));
}

/** Gap between neighboring artboards for an artboard of this size. */
export const artboardGap = (r: Rect) => Math.round(Math.max(32, Math.min(200, Math.min(r.width, r.height) * 0.1)));

/** A free rectangle of the same size beside `from`, skipping past other
 * artboards on that side. */
export function besideRect(doc: Pick<PhotoDocument, 'layers'>, from: Rect, side: 'left' | 'right' | 'top' | 'bottom', size: { width: number; height: number } = from): Rect {
  const gap = artboardGap(from);
  const others = artboardLayers(doc).map((a) => a.artboard.rect);
  let r: Rect =
    side === 'right'
      ? { x: from.x + from.width + gap, y: from.y, ...size }
      : side === 'left'
        ? { x: from.x - gap - size.width, y: from.y, ...size }
        : side === 'bottom'
          ? { x: from.x, y: from.y + from.height + gap, ...size }
          : { x: from.x, y: from.y - gap - size.height, ...size };
  for (let guard = 0; guard < 200; guard++) {
    const hit = others.find((o) => rectsOverlap(o, r));
    if (!hit) break;
    if (side === 'right') r = { ...r, x: hit.x + hit.width + gap };
    else if (side === 'left') r = { ...r, x: hit.x - gap - r.width };
    else if (side === 'bottom') r = { ...r, y: hit.y + hit.height + gap };
    else r = { ...r, y: hit.y - gap - r.height };
  }
  return r;
}
/** Where a new artboard of this size goes: to the right of the existing
 * artboards (top-aligned with the first), or at the canvas origin. */
export function newArtboardRect(doc: Pick<PhotoDocument, 'layers'>, width: number, height: number): Rect {
  const list = artboardLayers(doc);
  if (!list.length) return { x: 0, y: 0, width, height };
  const rightmost = list.reduce((a, b) => (b.artboard.rect.x + b.artboard.rect.width > a.artboard.rect.x + a.artboard.rect.width ? b : a));
  const r = besideRect(doc, rightmost.artboard.rect, 'right', { width, height });
  return { ...r, y: list[0].artboard.rect.y };
}

/** A new artboard group named "Artboard N". */
export function createArtboard(doc: PhotoDocument, rect: Rect, data: Partial<ArtboardData> = {}, name?: string): ArtboardLayer {
  const used = new Set(allLayers(doc.layers).map((l) => l.name));
  let n = artboardLayers(doc).length + 1;
  while (!name && used.has(`Artboard ${n}`)) n++;
  const l = layer('group', name ?? `Artboard ${n}`, doc.width, doc.height) as ArtboardLayer;
  l.artboard = { rect: { ...rect }, background: 'white', clip: true, ...data };
  return l;
}

/** Wrap top-level layers (or one top-level group) into an artboard sized to
 * their bounds. Returns the artboard's ID. */
export function artboardFromLayers(doc: PhotoDocument, ids: ReadonlySet<string>, fromGroup = false): string {
  const roots = doc.layers.filter((l) => ids.has(l.id));
  const nested = [...ids].some((id) => !doc.layers.some((l) => l.id === id) && findLayer(doc.layers, id));
  if (!roots.length || nested) throw new Error('Select top-level layers outside artboards.');
  if (roots.some(isArtboard)) throw new Error('Artboards cannot contain other artboards.');
  const bounds = unionRect(roots.map(layerBounds).filter((r): r is Rect => !!r)) ?? { x: 0, y: 0, width: doc.width, height: doc.height };
  const rect = {
    x: Math.floor(bounds.x),
    y: Math.floor(bounds.y),
    width: Math.max(1, Math.ceil(bounds.x + bounds.width) - Math.floor(bounds.x)),
    height: Math.max(1, Math.ceil(bounds.y + bounds.height) - Math.floor(bounds.y)),
  };
  if (fromGroup) {
    const g = roots[0];
    if (roots.length !== 1 || g.kind !== 'group' || g.frame) throw new Error('Select one group to convert.');
    g.artboard = { rect, background: 'transparent', clip: true };
    if (g.blend === 'pass through') g.blend = 'normal';
    return g.id;
  }
  const a = createArtboard(doc, rect, { background: 'transparent' });
  const top = Math.max(...roots.map((l) => doc.layers.indexOf(l)));
  const insertion = doc.layers.slice(0, top).filter((l) => !roots.includes(l)).length;
  a.children = roots;
  doc.layers = doc.layers.filter((l) => !roots.includes(l));
  doc.layers.splice(insertion, 0, a);
  return a.id;
}

/** Move layers whose center now lies over a different artboard into it (on
 * top of its stack), or out to the canvas when they left every artboard.
 * Only top-level layers and direct artboard children move; nested content
 * travels with its group. Returns true when anything changed. */
export function nestIntoArtboards(doc: PhotoDocument, ids: Iterable<string>): boolean {
  if (!hasArtboards(doc)) return false;
  let changed = false;
  for (const id of ids) {
    const l = findLayer(doc.layers, id);
    if (!l || isArtboard(l) || l.clipped) continue;
    const list = containerOf(doc.layers, id)!;
    const parent = list === doc.layers ? undefined : artboardLayers(doc).find((a) => a.children === list);
    if (list !== doc.layers && !parent) continue;
    const b = layerBounds(l);
    if (!b) continue;
    const target = artboardAt(doc, b.x + b.width / 2, b.y + b.height / 2);
    if (target === parent) continue;
    // Clipped layers above travel with their base.
    const i = list.indexOf(l);
    let j = i + 1;
    while (j < list.length && list[j].clipped) j++;
    const run = list.splice(i, j - i);
    if (target) target.children.push(...run);
    else doc.layers.splice(doc.layers.indexOf(parent!) + 1, 0, ...run);
    changed = true;
  }
  return changed;
}

/** Canvas rectangle needed to show the document and every artboard. */
export function artboardCanvas(doc: Pick<PhotoDocument, 'layers' | 'width' | 'height'>): Rect {
  return unionRect([{ x: 0, y: 0, width: doc.width, height: doc.height }, ...artboardLayers(doc).map((a) => a.artboard.rect)])!;
}
/** The latest canvas growth, so the view can keep artboards in place on
 * screen; the workspace reads and clears it after each edit. */
export const canvasGrowth: { pending?: { dx: number; dy: number; dw: number; dh: number } } = {};
/** Grow the canvas to contain every artboard (coordinates shift when it
 * grows up or left). Returns the shift. */
export function expandCanvasToArtboards(doc: PhotoDocument): { dx: number; dy: number } | undefined {
  const r = artboardCanvas(doc);
  if (r.x === 0 && r.y === 0 && r.width === doc.width && r.height === doc.height) return;
  try {
    assertSize(r.width, r.height);
  } catch {
    throw new Error('Artboards must fit within a canvas of 8192 × 8192 pixels and 24 megapixels.');
  }
  const w = doc.width,
    h = doc.height;
  cropDocument(doc, r);
  const shift = { dx: -r.x || 0, dy: -r.y || 0 };
  canvasGrowth.pending = { ...shift, dw: doc.width - w, dh: doc.height - h };
  return shift;
}
/** Place duplicated artboards beside their originals, contents included. */
export function placeDuplicateArtboards(doc: PhotoDocument, copies: Layer[]) {
  for (const c of copies) {
    if (!isArtboard(c)) continue;
    const from = { ...c.artboard.rect, rotation: 0 };
    const to = besideRect({ layers: doc.layers.filter((l) => l !== c) }, c.artboard.rect, 'right');
    transformSelection([c], from, { ...from, x: to.x, y: to.y });
  }
  if (copies.some(isArtboard)) expandCanvasToArtboards(doc);
}

/** Artboards may only live at the top level. */
export function assertArtboardsTopLevel(layers: Layer[]) {
  for (const l of layers)
    for (const c of allLayers(l.children)) if (c.artboard) throw new Error('Artboards cannot be placed inside groups or other artboards.');
}

export function validateArtboard(l: Layer, topLevel: boolean) {
  const a = l.artboard;
  if (a === undefined) return;
  const finite = (r: Rect) => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
  if (
    l.kind !== 'group' ||
    !topLevel ||
    !a ||
    typeof a !== 'object' ||
    !finite(a.rect) ||
    !['white', 'black', 'transparent', 'custom'].includes(a.background) ||
    (a.color !== undefined && !/^#[0-9a-f]{6}$/i.test(a.color)) ||
    (a.clip !== undefined && typeof a.clip !== 'boolean') ||
    (a.preset !== undefined && typeof a.preset !== 'string') ||
    l.frame
  )
    throw new Error('Invalid artboard.');
}
