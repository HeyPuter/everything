// Merged shared documents that the editor's checks would refuse. Layer
// properties are separate registers, so concurrent edits can combine into a
// layer no single person made: one person rasterizes a text layer (kind
// becomes 'pixel', the text is removed) while another edits its text (the text
// register is written again). Projection repairs such combinations the same
// way in every browser, so the document never stops opening; nothing here is
// written back to the shared document.
import type { Layer, PhotoDocument } from '../model/document';
import { validateDocument } from '../model/serialization';

const LIVE = ['liveSource', 'liveFilters', 'liveMask', 'liveMaskDisabled'] as const;

/** Drop data that does not belong to the layer's merged kind (deterministic). */
export function fitLayerToKind(l: Layer) {
  const r = l as unknown as Record<string, unknown>;
  const kind = l.kind;
  if (kind === 'pixel') {
    // Kept in step with the kind by every edit; an empty grid if a merge lost it.
    if (!l.pixels) l.pixels = { channels: 4, x: 0, y: 0, tiles: {}, bounds: null };
    if (l.liveSource === undefined || !Array.isArray(l.liveFilters)) for (const k of LIVE) delete r[k];
  } else {
    delete r.pixels;
    delete r.video;
    for (const k of LIVE) delete r[k];
  }
  if (kind !== 'text') {
    delete r.textData;
    delete r.textFrame;
  }
  if (kind !== 'vector') delete r.vector;
  if (kind !== 'adjustment') delete r.adjustment;
  if (kind !== 'solid') delete r.fill;
  if (kind !== 'group') {
    delete r.artboard;
    delete r.frame;
    if (l.blend === 'pass through') l.blend = 'normal';
  } else if (l.artboard !== undefined && l.frame !== undefined) delete r.frame;
}

// Document properties every document has; the others can be left out.
const REQUIRED_DOC = new Set(['version', 'name', 'width', 'height', 'layers', 'selection', 'selectionMask']);

/**
 * Make a projected document pass `validateDocument`, leaving out what still
 * fails after `fitLayerToKind`: document settings that are invalid on their
 * own (tried one at a time, in key order), then layers that are invalid with
 * their (already checked) children, which take their place. Returns what was
 * left out; throws when the document still cannot be shown.
 */
export function salvageDocument(doc: PhotoDocument): string[] {
  try {
    validateDocument(doc);
    return [];
  } catch {
    /* Find what to leave out below. */
  }
  const dropped: string[] = [];
  const record = doc as unknown as Record<string, unknown>;
  const valid = (d: unknown) => {
    try {
      validateDocument(d);
      return true;
    } catch {
      return false;
    }
  };
  // Settings: checked without layers.
  for (let round = 0; !valid({ ...doc, layers: [] }) && round < 64; round++) {
    const key = Object.keys(record)
      .filter((k) => !REQUIRED_DOC.has(k))
      .sort()
      .find((k) => {
        const without = { ...doc, layers: [] } as unknown as Record<string, unknown>;
        delete without[k];
        return valid(without);
      });
    if (!key) break;
    delete record[key];
    dropped.push(`document setting “${key}”`);
  }
  const shell = { ...doc, layers: [] as Layer[] };
  const keep = (layers: Layer[]): Layer[] =>
    layers.flatMap((l) => {
      const candidate = { ...l, children: keep(l.children) };
      if (valid({ ...shell, layers: [structuredClone(candidate)] })) return [candidate];
      dropped.push(`layer “${l.name}”`);
      return candidate.children;
    });
  doc.layers = keep(doc.layers);
  validateDocument(doc);
  return dropped;
}
