// Embedded objects: an `image` layer that draws the rendered composite of
// nested content. The content (a layered document saved as a .photo project,
// or an original placed file) lives once in `doc.embeds`; every layer that
// names it is an instance, so duplicating a layer shares the content and
// editing it updates all instances. Assets are immutable, so history states
// share them and undo is a reference swap like everywhere else.
import { allLayers, type Layer, type PhotoDocument, type Rect } from './document';
import { validatePinFrame } from './pin-warp';

export const projectMimeType = 'application/x-photo-editor';
// Original files the browser cannot draw (TIFF, PSD...), kept as opaque bytes.
export const sourceMimeType = 'application/x-photo-editor-source';

export type StackMode =
  | 'none' | 'mean' | 'median' | 'minimum' | 'maximum' | 'range' | 'sum'
  | 'variance' | 'deviation' | 'entropy' | 'skewness' | 'kurtosis';
export const stackModes: [StackMode, string][] = [
  ['none', 'None'],
  ['mean', 'Mean'],
  ['median', 'Median'],
  ['minimum', 'Minimum'],
  ['maximum', 'Maximum'],
  ['range', 'Range'],
  ['sum', 'Sum'],
  ['variance', 'Variance'],
  ['deviation', 'Standard Deviation'],
  ['entropy', 'Entropy'],
  ['skewness', 'Skewness'],
  ['kurtosis', 'Kurtosis'],
];

/** Where linked content comes from. Local files can be re-read only while the
 * page keeps the file handle; Puter files are re-read from their path;
 * library graphics from the library item named by `path`. */
export type EmbedLink = {
  kind: 'local' | 'puter' | 'library';
  name: string;
  path?: string;
  size: number;
  modified: number;
  // SHA-256 of the file bytes the cached content was made from.
  hash: string;
};

export type EmbeddedContents = {
  id: string;
  name: string;
  // Pixel size of the content (and of `composite`).
  width: number;
  height: number;
  // Layered content as a .photo project; absent for a placed file that was
  // never edited (its `source` is the content).
  project?: string;
  // The original placed file, kept for Export Contents and re-editing. A file
  // the browser draws directly is also the composite (same asset ID).
  source?: string;
  sourceName?: string;
  // Rendered result drawn by every instance, and its color space.
  composite: string;
  colorSpace: 'document' | 'srgb';
  link?: EmbedLink;
  // Per-pixel statistic across the nested layers instead of the composite.
  stack?: StackMode;
};

/** Non-affine placement (skew, distort, perspective, warp) of one instance.
 * `quad` (and `mesh`, interleaved x,y over the content) are document points
 * of the content's corners when the cache was rendered; `rect` is where the
 * cached result sat. Later rectangle edits of `transform` map from `rect`,
 * so the frame is always derived from the content, never from the cache. */
export type EmbedFrame = {
  quad: [number, number][];
  mesh?: { cols: number; rows: number; points: number[]; mode?: 'bezier' | 'smooth' | 'bilinear' };
  rect: Rect;
  // Composite asset the cache was rendered from; a mismatch means stale.
  source: string;
  // Pin Warp of the content placed by `quad` (no `mesh` then).
  pins?: import('./pin-warp').PinFrame;
};
export type LayerEmbed = { contents: string; frame?: EmbedFrame };

export const contentsOf = (doc: Pick<PhotoDocument, 'embeds'>, l: Layer | undefined) =>
  l?.embed ? doc.embeds?.[l.embed.contents] : undefined;
export const isEmbedded = (l: Layer | undefined): l is Layer & { kind: 'image' } => l?.kind === 'image';
export function instancesOf(doc: PhotoDocument, contents: string) {
  return allLayers(doc.layers).filter((l) => l.embed?.contents === contents);
}
/** Asset IDs an embedded object needs saved with the document. */
export function embedAssetIds(contents: EmbeddedContents) {
  return [contents.project, contents.source, contents.composite].filter((id): id is string => !!id);
}
/** Contents referenced by a layer (others are left from deleted layers). */
export function usedEmbeds(doc: PhotoDocument): Record<string, EmbeddedContents> | undefined {
  if (!doc.embeds) return undefined;
  const used = new Set(allLayers(doc.layers).flatMap((l) => (l.embed ? [l.embed.contents] : [])));
  const out: Record<string, EmbeddedContents> = {};
  for (const [id, c] of Object.entries(doc.embeds)) if (used.has(id)) out[id] = c;
  return Object.keys(out).length ? out : undefined;
}
/** Copy of a contents entry under a new ID (assets are shared; immutable). */
export function copyContents(c: EmbeddedContents): EmbeddedContents {
  return { ...structuredClone(c), id: crypto.randomUUID() };
}

const isId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 128;
const finite = (...v: unknown[]) => v.every((n) => typeof n === 'number' && Number.isFinite(n));
/** Structural validation of saved embedded objects (asset types are checked
 * when the assets load). */
export function validateEmbeds(doc: PhotoDocument) {
  const embeds = doc.embeds;
  if (embeds !== undefined) {
    if (!embeds || typeof embeds !== 'object' || Array.isArray(embeds) || Object.keys(embeds).length > 1000)
      throw new Error('Invalid embedded objects.');
    for (const [key, c] of Object.entries(embeds)) {
      if (!c || typeof c !== 'object' || c.id !== key || !isId(c.id) || typeof c.name !== 'string' || c.name.length > 512 ||
        !Number.isInteger(c.width) || !Number.isInteger(c.height) || c.width < 1 || c.height < 1 || c.width > 8192 || c.height > 8192 ||
        !isId(c.composite) || (c.project !== undefined && !isId(c.project)) || (c.source !== undefined && !isId(c.source)) ||
        (c.sourceName !== undefined && (typeof c.sourceName !== 'string' || c.sourceName.length > 512)) ||
        !['document', 'srgb'].includes(c.colorSpace) ||
        (c.stack !== undefined && !stackModes.some(([m]) => m === c.stack)))
        throw new Error('Invalid embedded object contents.');
      const link = c.link;
      if (link !== undefined && (!link || typeof link !== 'object' || !['local', 'puter', 'library'].includes(link.kind) ||
        typeof link.name !== 'string' || link.name.length > 512 || (link.path !== undefined && (typeof link.path !== 'string' || link.path.length > 4096)) ||
        !finite(link.size, link.modified) || typeof link.hash !== 'string' || !/^[0-9a-f]{64}$/.test(link.hash)))
        throw new Error('Invalid linked object.');
    }
  }
  for (const l of allLayers(doc.layers)) {
    const e = l.embed;
    if (e === undefined) continue;
    if (l.kind !== 'image' || !e || typeof e !== 'object' || !isId(e.contents) || !embeds?.[e.contents])
      throw new Error('Invalid embedded object layer.');
    const f = e.frame;
    if (f === undefined) continue;
    const pointsOk = (p: unknown) => Array.isArray(p) && p.length === 2 && finite(...p);
    if (!f || !Array.isArray(f.quad) || f.quad.length !== 4 || !f.quad.every(pointsOk) ||
      !f.rect || !finite(f.rect.x, f.rect.y, f.rect.width, f.rect.height) || f.rect.width <= 0 || f.rect.height <= 0 ||
      typeof f.source !== 'string')
      throw new Error('Invalid embedded object frame.');
    if (f.pins !== undefined) {
      if (f.mesh !== undefined) throw new Error('Invalid embedded object warp.');
      validatePinFrame(f.pins);
    }
    const m = f.mesh;
    if (m !== undefined && (!m || !Number.isInteger(m.cols) || !Number.isInteger(m.rows) || m.cols < 2 || m.rows < 2 || m.cols * m.rows > 4096 ||
      !Array.isArray(m.points) || m.points.length !== m.cols * m.rows * 2 || !finite(...m.points) ||
      (m.mode !== undefined && !['bezier', 'smooth', 'bilinear'].includes(m.mode))))
      throw new Error('Invalid embedded object warp.');
  }
}
