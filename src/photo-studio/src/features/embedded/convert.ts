// Turning layers into embedded objects and back, copies with independent
// content, resetting placement, replacing and exporting content, and opening
// a file as an embedded object.
import type { Editor } from '../../editor';
import { allLayers, containerOf, cropDocument, findLayer, layer, newDocument, type Layer, type PhotoDocument, type Rect } from '../../model/document';
import { setDocumentResolution } from '../../model/text-layer';
import { Assets } from '../../model/assets';
import { deserialize } from '../../model/serialization';
import { contentsOf, copyContents, type EmbeddedContents } from '../../model/embedded';
import { assertEditable } from '../../model/layers';
import { gridDocBounds, unionRect } from '../../model/tiles';
import { transformBounds } from '../../model/transform';
import { formDialog } from '../../ui/dialog';
import { download } from '../../persistence/puter';
import { isAffine, quadBounds, rectToQuad, transformQuad } from '../transform/math';
import { applyMat3, mat3Multiply, type Mat3 } from '../../imaging/filters/warp';
import { applyPrepared, contentLayers, prepareLayers } from '../transform/layer-ops';
import { encodePng } from '../files/png';
import { rasterizeLayer } from '../pixels';
import { baseName, contentsFromDocument, contentsFromFile, ensureEmbed, fittedTransform, instanceLayer, plainContents, setContents } from './contents';
import { alphaBounds, assetRGBA, cropSamples, documentSamples } from './render';
import { contentSource } from './frame';
import { instanceQuad } from './frame-math';

/** The single selected image layer, or undefined after a message. */
export function selectedObject(e: Editor): Layer | undefined {
  const l = e.selectedIds.size === 1 ? e.layer : undefined;
  if (l?.kind === 'image' && (l.asset || l.embed)) return l;
  e.message('Select one embedded object.');
}

/** Document area a layer can draw into (before effects). */
function contentBounds(doc: PhotoDocument, l: Layer): Rect | null {
  if (l.kind === 'group') return l.children.reduce<Rect | null>((r, c) => unionRect(r, contentBounds(doc, c)), null);
  if (l.kind === 'pixel') return l.pixels ? gridDocBounds(l.pixels) : null;
  if (l.kind === 'adjustment') return { x: 0, y: 0, width: doc.width, height: doc.height };
  return transformBounds(l.transform);
}
/** Crop a nested document whose tiles live in the editor's store, moving
 * pixel grids and document-space masks with the layers. */
function cropNested(e: Editor, doc: PhotoDocument, r: Rect) {
  const x = Math.round(r.x),
    y = Math.round(r.y);
  cropDocument(doc, { x, y, width: Math.round(r.width), height: Math.round(r.height) });
  for (const l of allLayers(doc.layers))
    if (l.kind !== 'pixel' && l.maskGrid) l.maskGrid = { ...l.maskGrid, x: l.maskGrid.x - x, y: l.maskGrid.y - y };
  // Pixel layers carry the move in `transform`; baking shifts their grids.
  e.normalizePixelLayers(doc, e.assets);
}
const roundOut = (r: Rect): Rect => {
  const x = Math.floor(r.x),
    y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
};
function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.width, b.x + b.width) - x,
    h = Math.min(a.y + a.height, b.y + b.height) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}
const fits = (r: Rect) => r.width <= 8192 && r.height <= 8192 && r.width * r.height <= 24_000_000;

/** A nested document holding copies of `roots` (layers of one container),
 * cropped to what they draw, with its composite. `undefined` after a message
 * when the layers are empty or too large. Used by Convert to Embedded Object
 * and by library graphics. */
export async function nestedFromLayers(e: Editor, roots: Layer[], doc: PhotoDocument = e.doc) {
  let area = roots.reduce<Rect | null>((r, l) => unionRect(r, contentBounds(doc, l)), null);
  if (!area) {
    e.message('The selected layers are empty.');
    return;
  }
  // Room for strokes and effects; the result is trimmed to what is drawn.
  const pad = allLayers(roots).some((l) => l.style || l.vector?.stroke?.enabled) ? 256 : 8;
  area = roundOut({ x: area.x - pad, y: area.y - pad, width: area.width + pad * 2, height: area.height + pad * 2 });
  area = intersect(area, { x: -doc.width, y: -doc.height, width: doc.width * 3, height: doc.height * 3 }) ?? area;
  if (!fits(area)) area = intersect(area, { x: 0, y: 0, width: doc.width, height: doc.height }) ?? area;
  if (!fits(area)) {
    e.message('The selected layers are too large for an embedded object (8192 pixels or 24 megapixels).');
    return;
  }
  const top = roots.at(-1)!;
  // Named after the topmost layer with content of its own.
  const name = [...roots].reverse().find((l) => l.kind !== 'adjustment')?.name ?? top.name;
  const used = new Set(allLayers(roots).flatMap((l) => (l.embed ? [l.embed.contents] : [])));
  const nested: PhotoDocument = {
    ...newDocument(doc.width, doc.height, name),
    ...(doc.iccProfile ? { iccProfile: doc.iccProfile } : {}),
    ...(doc.iccUntaggedProfile ? { iccUntaggedProfile: true } : {}),
    ...(doc.bitsPerChannel ? { bitsPerChannel: doc.bitsPerChannel } : {}),
    ...(doc.resolution ? { resolution: structuredClone(doc.resolution) } : {}),
    ...(doc.patterns ? { patterns: structuredClone(doc.patterns) } : {}),
    layers: structuredClone(roots),
  };
  if (used.size) nested.embeds = Object.fromEntries(Object.entries(doc.embeds ?? {}).filter(([id]) => used.has(id)));
  // One layer: its opacity, blend mode and clipping stay on the object so
  // the stack looks the same.
  const lifted = roots.length === 1 ? { opacity: top.opacity, blend: top.blend === 'pass through' ? 'normal' : top.blend, clipped: top.clipped } : undefined;
  if (lifted) {
    const inner = nested.layers[0];
    inner.opacity = 1;
    inner.blend = inner.kind === 'group' && inner.blend === 'pass through' ? 'pass through' : 'normal';
    delete inner.clipped;
  }
  cropNested(e, nested, area);
  let samples = await documentSamples(e, nested, e.assets);
  const tight = alphaBounds(samples);
  if (tight && (tight.width < nested.width || tight.height < nested.height)) {
    cropNested(e, nested, tight);
    samples = cropSamples(samples, tight);
    area = { x: area.x + tight.x, y: area.y + tight.y, width: tight.width, height: tight.height };
  }
  return { nested, area, name, samples, lifted, top };
}

/** Layer → Embedded Objects → Convert to Embedded Object. */
export async function convertToEmbedded(e: Editor) {
  const doc = e.doc;
  const roots = e.selectedLayers;
  if (!roots.length) {
    e.message('Select the layers to convert.');
    return;
  }
  assertEditable(doc, roots);
  const list = containerOf(doc.layers, roots[0].id)!;
  if (roots.some((l) => containerOf(doc.layers, l.id) !== list)) {
    e.message('Move the selected layers into the same group before converting them.');
    return;
  }
  const built = await nestedFromLayers(e, roots, doc);
  if (!built) return;
  const { nested, area, name, samples, lifted, top } = built;
  const c = await contentsFromDocument(e, doc, e.assets, nested, e.assets, { name, samples });
  const inst = instanceLayer(c, name, { ...area, rotation: 0 });
  if (lifted) Object.assign(inst, lifted);
  if (!inst.clipped) delete inst.clipped;
  const ids = new Set(roots.map((l) => l.id));
  e.command('Convert to Embedded Object', (d) => {
    const list = containerOf(d.layers, top.id)!;
    const at = list.filter((x, i) => i < list.findIndex((y) => y.id === top.id) && !ids.has(x.id)).length;
    for (let i = list.length - 1; i >= 0; i--) if (ids.has(list[i].id)) list.splice(i, 1);
    list.splice(at, 0, inst);
    d.embeds = { ...d.embeds, [c.id]: c };
  });
  e.selected = inst.id;
  e.update();
}

/** New Embedded Object via Copy: duplicates with their own content. */
export function newViaCopy(e: Editor) {
  const roots = e.selectedLayers.filter((l) => l.kind === 'image');
  if (!roots.length) {
    e.message('Select an embedded object to copy.');
    return;
  }
  const copies: string[] = [];
  const assets = e.assets;
  e.command('New Embedded Object via Copy', (d) => {
    for (const r of roots) {
      const src = findLayer(d.layers, r.id);
      if (!src) continue;
      ensureEmbed(d, src, assets);
      const c = copyContents(d.embeds![src.embed!.contents]);
      d.embeds = { ...d.embeds, [c.id]: c };
      const copy = structuredClone(src);
      copy.id = crypto.randomUUID();
      delete copy.psdId;
      copy.name = `${src.name} copy`;
      copy.embed!.contents = c.id;
      const list = containerOf(d.layers, src.id)!;
      list.splice(list.indexOf(src) + 1, 0, copy);
      copies.push(copy.id);
    }
  });
  e.selectLayers(copies);
  e.update();
}

/** Back to the content's own size and an upright rectangle, centered where
 * the object is now. */
export function resetTransform(e: Editor) {
  const ids = e.selectedLayers.filter((l) => l.kind === 'image').map((l) => l.id);
  if (!ids.length) return;
  e.command('Reset Transform', (d) => {
    for (const id of ids) {
      const t = findLayer(d.layers, id);
      if (!t) continue;
      const b = quadBounds(instanceQuad(t));
      const s = contentSource(d, t);
      if (t.embed) delete t.embed.frame;
      Object.assign(t, {
        asset: s.asset,
        assetColorSpace: s.colorSpace,
        sourceWidth: s.width,
        sourceHeight: s.height,
        transform: { x: b.x + b.width / 2 - s.width / 2, y: b.y + b.height / 2 - s.height / 2, width: s.width, height: s.height, rotation: 0 },
      });
    }
  });
}

/** Convert to Layers: unpack the content into a group in place. Moves,
 * rotation and scale are applied to the layers where they can be; warps and
 * distortions cannot be, and the layers are placed unwarped. */
export async function convertToLayers(e: Editor) {
  const l = selectedObject(e);
  if (!l) return;
  assertEditable(e.doc, [l]);
  const c = contentsOf(e.doc, l);
  if (!c?.project) {
    // A single placed image becomes one pixel layer with its placement applied.
    await rasterizeLayer(e, l.id, 'Convert to Layers');
    return;
  }
  const loaded = await deserialize(e.assets.blob(c.project), e.assets);
  const nested = loaded.document;
  // Type keeps its size in pixels at this document's resolution.
  setDocumentResolution(nested, e.doc.resolution);
  for (const x of allLayers(nested.layers)) {
    x.id = crypto.randomUUID();
    delete x.psdId;
  }
  // Content space → document: the frame's bounds when warped (not applied).
  const content = { x: 0, y: 0, width: c.width, height: c.height };
  const warped = !!l.embed?.frame;
  let m: Mat3;
  if (warped) {
    const b = quadBounds(instanceQuad(l));
    m = [1, 0, b.x + b.width / 2 - c.width / 2, 0, 1, b.y + b.height / 2 - c.height / 2, 0, 0, 1];
  } else m = rectToQuad(content, transformQuad(l.transform));
  if (!isAffine(m)) m = [1, 0, m[2], 0, 1, m[5], 0, 0, 1];
  // Whole-pixel translation first (exact), then the rest about the result.
  const o = applyMat3(m, 0, 0);
  const dx = Math.round(o.x),
    dy = Math.round(o.y);
  cropNested(e, nested, { x: -dx, y: -dy, width: e.doc.width, height: e.doc.height });
  const rest = mat3Multiply(m, [1, 0, -dx, 0, 1, -dy, 0, 0, 1]);
  // A sub-pixel remainder of a plain move is not worth resampling for.
  const identity = [0, 1, 3, 4, 6, 7, 8].every((i) => Math.abs(rest[i] - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) < 1e-6);
  const leaves = contentLayers(nested.layers);
  const { prepared, skipped } = identity ? { prepared: new Map(), skipped: [] as string[] } : await prepareLayers(e, leaves, rest, e.doc, false);
  // A normal (isolated) group composites like the object did.
  const group = layer('group', l.name, e.doc.width, e.doc.height);
  Object.assign(group, { children: nested.layers, blend: l.blend, opacity: l.opacity, visible: l.visible });
  if (l.maskGrid) group.maskGrid = l.maskGrid;
  if (l.clipped) group.clipped = true;
  if (l.style) group.style = structuredClone(l.style);
  // Nested objects keep their contents; an ID the parent already uses for
  // different contents gets a new one so other instances are unaffected.
  const usedEmbeds: Record<string, EmbeddedContents> = {};
  for (const [id, nc] of Object.entries(nested.embeds ?? {})) {
    const mine = e.doc.embeds?.[id];
    const next = mine && JSON.stringify(mine) !== JSON.stringify(nc) ? { ...nc, id: crypto.randomUUID() } : nc;
    usedEmbeds[next.id] = next;
    if (next.id !== id) for (const x of allLayers(nested.layers)) if (x.embed?.contents === id) x.embed.contents = next.id;
  }
  e.command('Convert to Layers', (d) => {
    const list = containerOf(d.layers, l.id);
    if (!list) return;
    list.splice(list.findIndex((x) => x.id === l.id), 1, group);
    if (Object.keys(usedEmbeds).length) d.embeds = { ...d.embeds, ...usedEmbeds };
    if (!identity) applyPrepared(d, prepared, rest, e.assets);
  });
  e.selected = group.id;
  e.update();
  const notes = [
    warped ? 'The warp or distortion was not applied; the layers are placed unwarped.' : '',
    skipped.length ? `Type and shape layers keep their size and position: ${skipped.join(', ')}.` : '',
    Object.values(l.filters).some(Boolean) ? 'Layer adjustments (brightness, contrast...) were not carried over.' : '',
    c.stack && c.stack !== 'none' ? 'The layers are shown normally; the stack mode applies only to the embedded object.' : '',
  ].filter(Boolean);
  if (notes.length) e.message(notes.join(' '));
}

/** Pick local files (resolves empty when the picker is dismissed). */
export function pickLocalFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
export const fileAccept = () => document.querySelector<HTMLInputElement>('#file-input')?.accept ?? 'image/*,.photo,.psd,.psb';

/** Replace the content of the selected object (all its instances) from a file. */
export async function replaceContents(e: Editor, file?: File) {
  const l = selectedObject(e);
  if (!l) return;
  file ??= (await pickLocalFiles(fileAccept()))[0];
  if (!file) return;
  const doc = e.doc;
  const c = await contentsFromFile(e, doc, e.assets, file, file.name);
  const assets = e.assets;
  e.command('Replace Contents', (d) => {
    const t = findLayer(d.layers, l.id);
    if (!t) return;
    ensureEmbed(d, t, assets);
    setContents(d, { ...c, id: t.embed!.contents, name: d.embeds![t.embed!.contents].name || c.name });
  });
  e.message(`Replaced the contents with ${file.name}.`);
}

const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' };
/** Save the content as a file: the original file, the layered project, or a PNG. */
export async function exportContents(e: Editor) {
  const l = selectedObject(e);
  if (!l) return;
  const c: EmbeddedContents = contentsOf(e.doc, l) ?? plainContents(l, e.assets);
  const options: [string, string][] = [];
  if (c.source) options.push(['source', `Original file${c.sourceName ? ` (${c.sourceName})` : ''}`]);
  if (c.project) options.push(['project', 'Layered project (.photo)']);
  options.push(['png', 'Flattened image (.png)']);
  let pick = options[0][0];
  if (options.length > 1) {
    const v = await formDialog('Export Contents', [{ name: 'format', label: 'Save as', type: 'select', value: pick, options }], 'Export', `Contents of “${c.name}”, ${c.width} × ${c.height} px.`);
    if (!v) return;
    pick = v.format;
  }
  const name = baseName(c.sourceName ?? c.name);
  if (pick === 'source') {
    const blob = e.assets.blob(c.source!);
    download(new Blob([blob], { type: extensions[blob.type] ? blob.type : 'application/octet-stream' }), c.sourceName ?? `${name}.${extensions[blob.type] ?? 'bin'}`);
  } else if (pick === 'project') download(e.assets.blob(c.project!), `${name}.photo`);
  else {
    const img = await assetRGBA(e, e.doc, e.assets, c.composite, c.colorSpace, c.width, c.height);
    download(new Blob([encodePng({ width: img.width, height: img.height, data: img.data, channels: 4 }).slice()], { type: 'image/png' }), `${name}.png`);
  }
  e.message(`Exported the contents of “${c.name}”.`);
}

/** File → Open as Embedded Object: a new document holding the file as one
 * embedded object, its layers available through Edit Contents. */
export async function openAsEmbedded(e: Editor, file?: File) {
  file ??= (await pickLocalFiles(fileAccept()))[0];
  if (!file) return;
  const assets = new Assets();
  try {
    const shell = newDocument(1, 1, baseName(file.name));
    const c = await contentsFromFile(e, shell, assets, file, file.name);
    const doc: PhotoDocument = { ...newDocument(c.width, c.height, baseName(file.name)), embeds: { [c.id]: c } };
    doc.layers.push(instanceLayer(c, c.name, fittedTransform(doc, c.width, c.height)));
    const s = e.sessionForOpen();
    await e.renderer?.settle();
    s.assets.clear();
    s.assets = assets;
    s.history.reset(doc);
    s.hasDocument = true;
    s.storage.reset();
    s.saved = s.doc;
    s.fileName = `${baseName(file.name)}.photo`;
    e.selected = doc.layers[0].id;
    e.fit();
    e.update();
    e.message(`Opened ${file.name} as an embedded object.`);
  } catch (error) {
    if (e.session.assets !== assets) assets.clear();
    throw error;
  }
}
