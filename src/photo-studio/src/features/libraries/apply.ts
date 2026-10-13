// Moving things between documents and libraries: capturing items from the
// current context ("+" menu) and using them (apply on click, place or drop
// graphics, linked placements that follow later changes of the item).
import type { Editor } from '../../editor';
import type { Gradient } from '../../imaging/gradient/gradient';
import type { LayerStyle } from '../../imaging/effects/types';
import type { RGBA8 } from '../../imaging/types';
import type { CharacterStyleDef, ParagraphStyleDef } from '../../imaging/text/styles';
import { allLayers, containerOf } from '../../model/document';
import { contentsOf, type EmbeddedContents } from '../../model/embedded';
import { serialize } from '../../model/serialization';
import { gridFromImage, readMask } from '../../model/tiles';
import { selectionBounds, selectionGrid } from '../../model/selection';
import { sha256Hex } from '../../model/provenance';
import { encodePng } from '../files/png';
import { resampleRGBA } from '../files/resample';
import { decodeBrowserImage } from '../files/open';
import { compositeRGBA } from '../pixels';
import { currentPattern, effectsState } from '../effects/state';
import { applyLayerStyle } from '../effects/commands';
import { applyBrushPreset, currentBrushPreset, type BrushPresetData } from '../brushes';
import { applyExternalTextStyle, captureAttributes } from '../type/styles-panel';
import { contentsFromFile, fittedTransform, insertInstance, instanceLayer, setContents } from '../embedded/contents';
import { nestedFromLayers } from '../embedded/convert';
import { statuses } from '../embedded/link-state';
import { libraries } from './service';
import { TYPE_SINGULAR, type LibraryItem } from './model';
import type { AddSource } from './context';

const png = (img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }) =>
  new Blob([encodePng({ width: img.width, height: img.height, data: img.data, channels: 4 }) as Uint8Array<ArrayBuffer>], { type: 'image/png' });

/** A PNG preview at most `max` pixels on its longer side. */
function thumbnail(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray | Float32Array }, max = 160): Blob {
  let data: Uint8ClampedArray;
  if (img.data instanceof Float32Array) {
    data = new Uint8ClampedArray(img.data.length);
    for (let i = 0; i < data.length; i++) data[i] = Math.round(Math.max(0, Math.min(1, img.data[i])) * 255);
  } else data = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k)),
    h = Math.max(1, Math.round(img.height * k));
  return png({ width: w, height: h, data: k < 1 ? resampleRGBA(data, img.width, img.height, w, h, 'bicubic') : data });
}

type Captured = { type: LibraryItem['type']; name: string; data: Record<string, unknown>; blobs?: Record<string, Blob> };
/** Add an item from the current context to a library. */
export async function addFromContext(e: Editor, src: AddSource, libraryId: string): Promise<LibraryItem | undefined> {
  const c = await captureItem(e, src);
  return c && libraries().addItem(libraryId, c, c.blobs);
}
/** Replace an item's content with the current context of its kind (a
 * graphic from the selected layers or the selection, a color from the
 * foreground...). Linked placements of a graphic follow. */
export async function redefineItem(e: Editor, item: LibraryItem): Promise<boolean> {
  const src: AddSource = item.type === 'color' ? 'foreground' : item.type === 'graphic' ? (item.data.kind === 'image' ? 'selection' : 'layers') : item.type;
  const c = await captureItem(e, src);
  if (!c) return false;
  await libraries().updateItem(item.id, { data: c.type === 'character-style' || c.type === 'paragraph-style' ? { def: { ...(c.data.def as object), name: item.name } } : c.data }, c.blobs);
  return true;
}
async function captureItem(e: Editor, src: AddSource): Promise<Captured | undefined> {
  const add = (type: LibraryItem['type'], name: string, data: Record<string, unknown>, blobs?: Record<string, Blob>): Captured => ({ type, name, data, blobs });
  switch (src) {
    case 'foreground':
    case 'background': {
      const hex = (src === 'foreground' ? e.color : e.background).toLowerCase();
      return add('color', hex.toUpperCase(), { hex });
    }
    case 'gradient': {
      const g: Gradient = structuredClone(effectsState.gradient);
      return add('gradient', g.name || 'Gradient', { gradient: g });
    }
    case 'pattern': {
      const p = currentPattern(e);
      if (!p) return void e.message('There is no current pattern.');
      return add('pattern', p.name, { width: p.tile.width, height: p.tile.height }, { content: png(p.tile), thumb: thumbnail(p.tile, 96) });
    }
    case 'layer-style': {
      const l = e.layer;
      if (!l?.style) return void e.message('The selected layer has no layer style.');
      return add('layer-style', `${l.name} Style`, { style: structuredClone(l.style) });
    }
    case 'character-style':
    case 'paragraph-style': {
      if (e.layer?.kind !== 'text') return void e.message('Select a text layer.');
      const kind = src === 'character-style' ? 'character' : 'paragraph';
      const attrs = captureAttributes(e, kind);
      const name = `${e.layer.name.slice(0, 40)} ${kind === 'character' ? 'Character' : 'Paragraph'}`;
      return add(src, name, { def: { id: '', name, ...attrs } });
    }
    case 'brush': {
      const preset = currentBrushPreset(e, `${e.activeTool?.label?.replace(/ Tool$/, '') ?? 'Brush'} ${Math.round(Number(currentBrushPreset(e, '').tip.size ?? 30))} px`);
      return add('brush', preset.name, { preset });
    }
    case 'layers': {
      const roots = e.selectedLayers;
      const list = roots.length ? containerOf(e.doc.layers, roots[0].id) : undefined;
      if (!roots.length || roots.some((l) => containerOf(e.doc.layers, l.id) !== list)) return void e.message('Select layers of one group to add them as a graphic.');
      const built = await nestedFromLayers(e, roots);
      if (!built) return;
      // The layers stay editable: the graphic is a layered project, placed as an embedded object.
      const project = await serialize(built.nested, e.assets);
      const name = built.name;
      return add('graphic', name, { width: built.nested.width, height: built.nested.height, kind: 'project', sourceName: `${safeName(name)}.photo` }, { content: project, thumb: thumbnail(built.samples) });
    }
    case 'selection': {
      const grid = selectionGrid(e.doc, e.assets.tiles);
      const rect = grid ? selectionBounds(e.doc, grid) : null;
      if (!grid || !rect) return void e.message('Make a selection first.');
      const all = await compositeRGBA(e);
      const mask = readMask(e.assets.tiles, grid, rect);
      const img: RGBA8 = { width: rect.width, height: rect.height, data: new Uint8ClampedArray(rect.width * rect.height * 4) };
      for (let y = 0; y < rect.height; y++)
        for (let x = 0; x < rect.width; x++) {
          const s = ((rect.y + y) * all.width + rect.x + x) * 4,
            d = (y * rect.width + x) * 4;
          img.data.set(all.data.subarray(s, s + 3), d);
          img.data[d + 3] = Math.round((all.data[s + 3] * mask.data[y * rect.width + x]) / 255);
        }
      const name = `${e.doc.name} Selection`;
      return add('graphic', name, { width: rect.width, height: rect.height, kind: 'image', sourceName: `${safeName(name)}.png` }, { content: png(img), thumb: thumbnail(img) });
    }
  }
}
const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'Graphic';

/** Use an item: colors set the foreground (background with `alt`), styles
 * apply to the selected layers or text, gradients, patterns and brushes
 * become current, graphics are placed. */
export async function applyItem(e: Editor, item: LibraryItem, opts: { alt?: boolean; at?: [number, number] } = {}) {
  switch (item.type) {
    case 'color': {
      const hex = String(item.data.hex);
      if (opts.alt) e.setBackground(hex);
      else e.setForeground(hex);
      e.message(`${opts.alt ? 'Background' : 'Foreground'} color set to ${item.name}.`);
      return;
    }
    case 'gradient':
      effectsState.gradient = structuredClone(item.data.gradient as Gradient);
      e.options();
      e.dock.update();
      e.message(`${item.name} is the current gradient.`);
      return;
    case 'pattern':
      return usePattern(e, item);
    case 'layer-style':
      if (!e.hasDocument || !e.selectedLayers.length) return void e.message('Select the layers to apply the style to.');
      applyLayerStyle(e, item.data.style as LayerStyle, `Apply ${item.name}`);
      return;
    case 'character-style':
    case 'paragraph-style':
      if (!e.hasDocument) return void e.message('Open a document to use text styles.');
      await applyExternalTextStyle(e, item.type === 'character-style' ? 'character' : 'paragraph', { ...(item.data.def as CharacterStyleDef & ParagraphStyleDef), name: item.name });
      return;
    case 'brush':
      applyBrushPreset(e, item.data.preset as BrushPresetData);
      e.message(`Brush set to ${item.name}.`);
      return;
    case 'graphic':
      return placeGraphic(e, item, { at: opts.at });
  }
}

async function usePattern(e: Editor, item: LibraryItem) {
  const blob = await libraries().readAsset(item.assets?.content ?? '');
  if (!blob) return void e.message(`The content of ${item.name} is not available. Sync and try again.`);
  const id = `library-${item.assets!.content.slice(0, 24)}`;
  if (e.hasDocument && !(e.doc.patterns ?? []).some((p) => p.id === id)) {
    const img = await decodeBrowserImage(blob, true);
    const grid = gridFromImage(e.assets.tiles, img);
    e.command('Add Library Pattern', (d) => (d.patterns = [...(d.patterns ?? []), { id, name: item.name, width: img.width, height: img.height, grid }]));
  }
  if (!e.hasDocument) return void e.message('Open a document to use library patterns.');
  effectsState.patternId = id;
  e.options();
  e.dock.update();
  e.message(`${item.name} is the current pattern.`);
}

async function graphicContents(e: Editor, item: LibraryItem): Promise<{ c: EmbeddedContents; blob: Blob } | undefined> {
  const blob = await libraries().readAsset(item.assets?.content ?? '');
  if (!blob) {
    e.message(`The content of ${item.name} is not available. Sync and try again.`);
    return;
  }
  const c = await contentsFromFile(e, e.doc, e.assets, blob, String(item.data.sourceName ?? `${item.name}.png`));
  return { c: { ...c, name: item.name }, blob };
}

/** Place a graphic as an embedded object (centered, or centered on `at`).
 * Linked placements re-read the item when it changes. */
export async function placeGraphic(e: Editor, item: LibraryItem, opts: { linked?: boolean; at?: [number, number] } = {}) {
  if (!e.hasDocument) return void e.message('Open a document to place a graphic.');
  const got = await graphicContents(e, item);
  if (!got) return;
  let { c } = got;
  if (opts.linked) c = { ...c, link: { kind: 'library', name: String(item.data.sourceName ?? item.name), path: item.id, size: got.blob.size, modified: Date.parse(item.modified) || Date.now(), hash: item.assets!.content } };
  const t = fittedTransform(e.doc, c.width, c.height);
  if (opts.at) Object.assign(t, { x: opts.at[0] - t.width / 2, y: opts.at[1] - t.height / 2 });
  insertInstance(e, instanceLayer(c, item.name, t), c, opts.linked ? 'Place Linked Graphic' : 'Place Graphic');
  if (opts.linked) statuses.set(c.id, 'current');
  e.message(`Placed ${item.name}${opts.linked ? ' (linked to the library)' : ''}.`);
}

/** Bytes of the library item a linked placement names (Update Modified Content). */
export async function readLibraryLink(c: EmbeddedContents): Promise<Blob | undefined> {
  const lib = libraries();
  await lib.load();
  const found = lib.item(c.link?.path);
  return found?.item.assets?.content ? lib.readAsset(found.item.assets.content) : undefined;
}

/** Contents in `e.doc` linked to library items, with the item's current content hash. */
function libraryLinks(e: Editor) {
  const lib = libraries();
  const out: { c: EmbeddedContents; item?: LibraryItem }[] = [];
  const seen = new Set<string>();
  for (const l of allLayers(e.doc.layers)) {
    const c = contentsOf(e.doc, l);
    if (c?.link?.kind !== 'library' || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ c, item: lib.item(c.link.path)?.item });
  }
  return out;
}
/** Whether a linked placement in the document no longer matches its item. */
export function staleLibraryLinks(e: Editor): boolean {
  return libraryLinks(e).some(({ c, item }) => (item?.assets?.content ?? '') !== c.link!.hash);
}
/** Mark library-linked placements of the document whose item changed, and
 * update them in one step. Returns the number updated. */
export async function updateLibraryLinks(e: Editor): Promise<number> {
  const updates: EmbeddedContents[] = [];
  for (const { c, item } of libraryLinks(e)) {
    const hash = item?.assets?.content;
    if (!item || !hash) {
      statuses.set(c.id, 'unavailable');
      continue;
    }
    if (hash === c.link!.hash) {
      statuses.set(c.id, 'current');
      continue;
    }
    const got = await graphicContents(e, item);
    if (!got) {
      statuses.set(c.id, 'modified');
      continue;
    }
    updates.push({ ...got.c, id: c.id, name: c.name, link: { ...c.link!, size: got.blob.size, modified: Date.parse(item.modified) || Date.now(), hash: await sha256Hex(got.blob) } });
  }
  if (updates.length) {
    e.command('Update Library Graphics', (d) => updates.forEach((n) => setContents(d, n)));
    for (const n of updates) statuses.set(n.id, 'current');
    e.message(`Updated ${updates.length} linked library graphic${updates.length === 1 ? '' : 's'}.`);
  }
  return updates.length;
}

/** Item description for tooltips. */
export const describeItem = (item: LibraryItem) =>
  `${item.name} — ${TYPE_SINGULAR[item.type]}${item.type === 'graphic' ? ` (${item.data.width} × ${item.data.height} px)` : item.type === 'color' ? ` ${item.data.hex}` : ''}`;
