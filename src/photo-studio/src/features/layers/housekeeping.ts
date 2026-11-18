// Layer housekeeping: linking, finding and isolating layers, the Background
// layer, bulk deletion and rasterizing, mask links, per-layer export and the
// File → Scripts clean-up passes.
import type { Editor } from '../../editor';
import { registerCommand, type Command } from '../../app/registry';
import { allLayers, containerOf, findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { allLinked, cleanLinks, expandLinked, linkLayers, maskLinked, unlinkLayers } from '../../model/links';
import { makeBackground, releaseBackground, removeEmptyLayers, removeHiddenLayers, transparencyToMask } from '../../model/housekeeping';
import { setPixelMaskLinked } from '../../model/pixel-mask';
import { layerLock } from '../../model/locks';
import { hasMask } from '../../model/masks';
import { selectedRoots } from '../../model/layers';
import { activeLayerStyle } from '../../model/layer-style';
import { clearToPixelLayer, setLayerPixels } from '../../model/pixel-layer';
import { emptyGrid, gridDocBounds, gridFromImage, readMask, readRGBA, writeRect, type TileGrid } from '../../model/tiles';
import { canvasRect } from '../../model/selection';
import { transformBounds } from '../../model/transform';
import { formDialog } from '../../ui/dialog';
import { svg } from '../../app/icons';
import { layerListBanners, layerRowFilters } from '../panels/layers';
import { hexRgb, layerRGBA, legacyMaskToGrid, prepareRasterize } from '../pixels';
import type { RGBA8 } from '../../imaging/types';

const masked = (l: Layer | undefined) => !!l && (hasMask(l) || !!l.maskGrid);

// Isolation keeps a set of layer IDs per open document; the Layers panel shows
// only those layers (and their contents) until isolation is turned off.
const isolation = new WeakMap<object, Set<string>>();
const isolated = (e: Editor) => isolation.get(e.session);

export function installHousekeeping(e: Editor) {
  const cmd = (c: Command) => registerCommand(c);
  layerRowFilters.push((e, l) => {
    const set = isolated(e);
    return !set || set.has(l.id);
  });
  layerListBanners.push((e) => {
    const set = isolated(e);
    if (!set) return '';
    return `<div class="layer-banner" role="status">${svg('focus', 13)}<span>Isolated layers</span><button data-command="select.isolate-layers" title="Show all layers again">Show All</button></div>`;
  });

  // ----- Linking -----
  const linkCommand: Command = {
    id: 'layer.link',
    label: 'Link Layers',
    description: 'Linked layers move and transform together',
    enabled: (e) => e.selectedIds.size > 1 || !!(e.selectedIds.size === 1 && e.layer?.linkGroup),
    run: (e) => {
      const ids = [...e.selectedIds];
      const unlink = ids.length === 1 || allLinked(e.doc.layers, ids);
      e.command(unlink ? 'Unlink Layers' : 'Link Layers', (d) => (unlink ? unlinkLayers(d.layers, ids) : linkLayers(d.layers, ids)));
    },
  };
  // The menu shows Unlink Layers when the selection is already linked.
  Object.defineProperty(linkCommand, 'label', {
    get: () => (e.selectedIds.size === 1 ? !!e.layer?.linkGroup : allLinked(e.doc.layers, e.selectedIds)) ? 'Unlink Layers' : 'Link Layers',
  });
  cmd(linkCommand);
  // A link group left with one member (its partners were deleted, merged or
  // cut) dissolves, whatever edit removed them.
  e.documentHooks.push((d) => cleanLinks(d.layers));
  cmd({
    id: 'layer.select-linked',
    label: 'Select Linked Layers',
    enabled: (e) => [...e.selectedIds].some((id) => findLayer(e.doc.layers, id)?.linkGroup),
    run: (e) => {
      e.selectLayers([...expandLinked(e.doc.layers, e.selectedIds)]);
      e.update();
    },
    recordable: false,
  });

  // ----- Finding and isolating -----
  cmd({
    id: 'select.find-layers',
    label: 'Find Layers',
    shortcut: 'Mod+Alt+Shift+F',
    enabled: (e) => e.hasDocument,
    run: (e) => {
      e.dock.show('layers');
      const input = e.root.querySelector<HTMLInputElement>('.layers-panel .layer-filter-text');
      input?.focus();
      input?.select();
    },
    recordable: false,
  });
  cmd({
    id: 'select.isolate-layers',
    label: 'Isolate Layers',
    description: 'Show only the selected layers in the Layers panel',
    checked: (e) => !!isolated(e),
    enabled: (e) => !!isolated(e) || e.selectedIds.size > 0,
    run: (e) => {
      if (isolated(e)) isolation.delete(e.session);
      else {
        const roots = selectedRoots(e.doc.layers, e.selectedIds);
        isolation.set(e.session, new Set(allLayers(roots).map((l) => l.id)));
      }
      e.dock.show('layers');
      e.update();
    },
    recordable: false,
  });
  // Layers created while isolating join the isolated set.
  e.onUpdate((e) => {
    const set = isolated(e);
    if (set) for (const id of e.selectedIds) set.add(id);
  });

  // ----- Background layer -----
  cmd({
    id: 'layer.from-background',
    label: 'Layer from Background…',
    enabled: (e) => !!e.layer?.background,
    run: async (e) => {
      const l = e.layer;
      if (!l?.background) return;
      const v = await formDialog('New Layer', [{ name: 'name', label: 'Name', value: 'Layer 0' }], 'OK', 'Converts the Background into a normal layer that can be moved and made transparent.');
      if (!v) return;
      const id = l.id;
      e.command('Layer from Background', (d) => {
        const x = findLayer(d.layers, id)!;
        releaseBackground(x);
        x.name = v.name.trim() || 'Layer 0';
      });
    },
  });
  cmd({
    id: 'layer.background-from-layer',
    label: 'Background from Layer',
    description: 'Make the selected pixel layer an opaque Background at the bottom',
    enabled: (e) => e.selectedIds.size === 1 && e.layer?.kind === 'pixel' && !e.layer.background && !e.doc.layers.some((l) => l.background),
    run: (e) => {
      const l = e.layer;
      if (!l || l.kind !== 'pixel' || !l.pixels) return;
      // Transparent areas take the background color, as on a flattened image.
      const area = canvasRect(e.doc);
      const src = readRGBA(e.assets.tiles, l.pixels, area);
      const [r, g, b] = hexRgb(e.background);
      const out = new Uint8ClampedArray(src.data.length);
      for (let i = 0; i < out.length; i += 4) {
        const a = src.data[i + 3] / 255;
        out[i] = src.data[i] * a + r * (1 - a);
        out[i + 1] = src.data[i + 1] * a + g * (1 - a);
        out[i + 2] = src.data[i + 2] * a + b * (1 - a);
        out[i + 3] = 255;
      }
      const grid = gridFromImage(e.assets.tiles, { width: area.width, height: area.height, data: out });
      const id = l.id;
      e.command('Background from Layer', (d) => {
        const list = containerOf(d.layers, id)!;
        const [x] = list.splice(list.findIndex((y) => y.id === id), 1);
        setLayerPixels(x, grid, d);
        x.name = 'Background';
        x.opacity = 1;
        x.blend = 'normal';
        delete x.clipped;
        makeBackground(x);
        d.layers.unshift(x);
        cleanLinks(d.layers);
      });
    },
  });

  // ----- Deleting, renaming, rasterizing -----
  cmd({
    id: 'layer.delete-hidden',
    label: 'Hidden Layers',
    enabled: (e) => allLayers(e.doc.layers).some((l) => !l.visible),
    run: (e) => {
      const hidden = allLayers(e.doc.layers).filter((l) => !l.visible);
      if (hidden.some((l) => layerLock(e.doc.layers, l.id, 'all'))) {
        e.message('Unlock the hidden layers before deleting them.');
        return;
      }
      let n = 0;
      e.command('Delete Hidden Layers', (d) => void (n = removeHiddenLayers(d.layers)));
      e.message(`Deleted ${n} hidden layer${n === 1 ? '' : 's'}.`);
    },
  });
  cmd({
    id: 'layer.rename',
    label: 'Rename Layer…',
    enabled: (e) => e.selectedIds.size === 1 && !!e.layer,
    run: async (e) => {
      const l = e.layer;
      if (!l) return;
      // Rename in place in the Layers panel when it is open, else in a dialog.
      e.dock.show('layers');
      const name = e.root.querySelector<HTMLElement>(`.layers-panel [data-row="${CSS.escape(l.id)}"] .layer-name .name-text`);
      if (name && !l.background) {
        name.scrollIntoView({ block: 'nearest' });
        name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return;
      }
      const v = await formDialog('Rename Layer', [{ name: 'name', label: 'Name', value: l.name }], 'Rename');
      if (v?.name.trim()) e.editLayer('Rename Layer', (x) => (x.name = v.name.trim()));
    },
    recordable: false,
  });
  cmd({
    id: 'layer.rasterize-all',
    label: 'All Layers',
    description: 'Rasterize every type, shape, fill and embedded layer',
    enabled: (e) => allLayers(e.doc.layers).some(rasterizable),
    run: async (e) => {
      const list = allLayers(e.doc.layers).filter((l) => rasterizable(l) && !layerLock(e.doc.layers, l.id, 'all'));
      const edits: ((d: PhotoDocument) => void)[] = [];
      for (const l of list) {
        const apply = await prepareRasterize(e, l.id);
        if (apply) edits.push(apply);
      }
      if (edits.length) e.command('Rasterize All Layers', (d) => edits.forEach((f) => f(d)));
      e.message(`Rasterized ${edits.length} layer${edits.length === 1 ? '' : 's'}.`);
    },
  });

  // ----- Masks -----
  cmd({
    id: 'layer.mask-from-transparency',
    label: 'From Transparency',
    description: 'Move the layer’s transparency into a layer mask',
    enabled: (e) => e.selectedIds.size === 1 && !!e.layer && !masked(e.layer) && !['group', 'adjustment'].includes(e.layer.kind),
    run: (e) => maskFromTransparency(e),
  });
  cmd({
    id: 'layer.mask-link',
    label: 'Link',
    description: 'Move the layer mask together with the layer',
    enabled: (e) => masked(e.layer) && !e.layer!.vectorMask,
    checked: (e) => !!e.layer && masked(e.layer) && !e.layer.vectorMask && maskLinked(e.layer),
    run: (e) => {
      const l = e.layer;
      if (!l) return;
      const linked = maskLinked(l);
      e.editLayer(linked ? 'Unlink Layer Mask' : 'Link Layer Mask', (x) => {
        if (x.pixelMask) setPixelMaskLinked(x, !linked);
        else if (linked) x.maskUnlinked = true;
        else delete x.maskUnlinked;
      });
    },
  });
  cmd({
    id: 'layer.vmask-link',
    label: 'Link',
    description: 'Move the vector mask together with the layer',
    enabled: (e) => !!e.layer?.vectorMask,
    checked: (e) => !!e.layer?.vectorMask && !e.layer.vectorMask.unlinked,
    run: (e) => {
      const l = e.layer;
      if (!l?.vectorMask) return;
      const linked = !l.vectorMask.unlinked;
      // The vector mask is rasterized into the layer mask; both share the link.
      e.editLayer(linked ? 'Unlink Vector Mask' : 'Link Vector Mask', (x) => {
        x.vectorMask = { ...x.vectorMask!, unlinked: linked || undefined };
        if (!x.vectorMask.unlinked) delete x.vectorMask.unlinked;
        if (linked) x.maskUnlinked = true;
        else delete x.maskUnlinked;
      });
    },
  });

  // ----- Export -----
  cmd({
    id: 'layer.quick-export',
    label: 'Quick Export as PNG',
    description: 'Export the selected layers, trimmed to their content, as a PNG',
    enabled: (e) => e.selectedIds.size > 0,
    run: async (e) => {
      const subject = layersDocument(e);
      if (!subject) return;
      const { loadSettings, encodeDocument, bytesBlob, formatBytes } = await import('../files/pipeline');
      const { exportFileName } = await import('../files/encode');
      const { download } = await import('../../persistence/puter');
      const out = await encodeDocument(e, { ...loadSettings(), format: 'png', canvasWidth: 0, canvasHeight: 0 }, subject);
      download(bytesBlob(out.bytes, out.mime), exportFileName(subject.name, 'png'));
      e.message(`PNG exported (${formatBytes(out.bytes.length)})`);
    },
    recordable: false,
  });
  cmd({
    id: 'layer.export-as',
    label: 'Export As…',
    shortcut: "Mod+Alt+Shift+'",
    description: 'Export the selected layers with format, size and color options',
    enabled: (e) => e.selectedIds.size > 0,
    run: async (e) => {
      const subject = layersDocument(e);
      if (!subject) return;
      const { exportAsDialog } = await import('../files/export-dialog');
      await exportAsDialog(e, {}, subject);
    },
    recordable: false,
  });

  // ----- File → Scripts -----
  cmd({
    id: 'file.delete-empty-layers',
    label: 'Delete All Empty Layers',
    enabled: (e) => e.hasDocument,
    run: (e) => {
      let n = 0;
      e.command('Delete All Empty Layers', (d) => void (n = removeEmptyLayers(d.layers)));
      e.message(n ? `Deleted ${n} empty layer${n === 1 ? '' : 's'}.` : 'There are no empty layers.');
    },
  });
  cmd({
    id: 'file.flatten-all-effects',
    label: 'Flatten All Layer Effects',
    description: 'Bake every layer style into its layer’s pixels',
    enabled: (e) => allLayers(e.doc.layers).some((l) => l.kind !== 'group' && !!activeLayerStyle(l)),
    run: (e) => flattenAllEffects(e),
  });
  cmd({
    id: 'file.flatten-all-masks',
    label: 'Flatten All Masks',
    description: 'Apply every layer mask and vector mask to its layer',
    enabled: (e) => allLayers(e.doc.layers).some((l) => maskable(l) && masked(l)),
    run: (e) => flattenAllMasks(e),
  });
}

const rasterizable = (l: Layer) => !['pixel', 'group', 'adjustment'].includes(l.kind);
const maskable = (l: Layer) => l.kind !== 'group' && l.kind !== 'adjustment';

/** A document with only the selected layers, cropped to their bounds. */
function layersDocument(e: Editor): PhotoDocument | undefined {
  const roots = selectedRoots(e.doc.layers, e.selectedIds);
  const leaves = allLayers(roots).filter((l) => l.kind !== 'group' && l.kind !== 'adjustment');
  const boxes = leaves.map((l) => (l.kind === 'pixel' && l.pixels ? gridDocBounds(l.pixels) : transformBounds(l.transform))).filter((b) => !!b);
  if (!boxes.length) {
    e.message('The selected layers have no content to export.');
    return;
  }
  const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)))),
    y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y))));
  const x1 = Math.min(e.doc.width, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)))),
    y1 = Math.min(e.doc.height, Math.ceil(Math.max(...boxes.map((b) => b.y + b.height))));
  if (x1 <= x0 || y1 <= y0) {
    e.message('The selected layers are outside the canvas.');
    return;
  }
  const doc: PhotoDocument = structuredClone({ ...e.doc, layers: roots.map((l) => ({ ...l, visible: true, clipped: false })), selection: null, selectionMask: null });
  doc.name = roots.length === 1 ? roots[0].name : `${e.doc.name} layers`;
  // Crop by shifting layer geometry; rendering places pending pixel-layer
  // moves exactly, so no pixels are rewritten here.
  if (x0 || y0 || x1 - x0 !== doc.width || y1 - y0 !== doc.height) {
    for (const l of allLayers(doc.layers)) {
      if (l.kind === 'group') continue;
      if (l.pixels) l.pixels = { ...l.pixels, x: l.pixels.x - x0, y: l.pixels.y - y0 };
      if (l.maskGrid) l.maskGrid = { ...l.maskGrid, x: l.maskGrid.x - x0, y: l.maskGrid.y - y0 };
      if (l.liveSource) l.liveSource = { ...l.liveSource, x: l.liveSource.x - x0, y: l.liveSource.y - y0 };
      l.transform = { ...l.transform, x: l.transform.x - x0, y: l.transform.y - y0 };
    }
    doc.width = x1 - x0;
    doc.height = y1 - y0;
  }
  return doc;
}

async function maskFromTransparency(e: Editor) {
  const l = e.layer;
  if (!l || masked(l)) return;
  if (layerLock(e.doc.layers, l.id, 'all')) {
    e.message('Unlock this layer to add a mask.');
    return;
  }
  const id = l.id;
  if (l.kind === 'pixel') {
    const b = l.pixels ? gridDocBounds(l.pixels) : null;
    if (!b || !l.pixels) {
      e.message('The layer is empty.');
      return;
    }
    const { mask, opaque } = transparencyToMask(readRGBA(e.assets.tiles, l.pixels, b));
    // Outside the content the mask hides everything.
    const grid = writeRect(e.assets.tiles, emptyGrid(1), b.x, b.y, mask);
    const pixels = writeRect(e.assets.tiles, l.pixels, b.x, b.y, opaque);
    e.command('Mask from Transparency', (d) => {
      const x = findLayer(d.layers, id)!;
      setLayerPixels(x, pixels, d);
      x.maskGrid = grid;
      delete x.maskDisabled;
      delete x.maskInverted;
    });
  } else {
    // Other layers keep their content; the mask reproduces their coverage.
    const img = await layerRGBA(e, { ...l, opacity: 1, blend: 'normal', fillOpacity: 1, style: undefined });
    const { mask } = transparencyToMask(img);
    const grid = writeRect(e.assets.tiles, emptyGrid(1), 0, 0, mask);
    e.command('Mask from Transparency', (d) => {
      findLayer(d.layers, id)!.maskGrid = grid;
    });
  }
  e.maskTarget = id;
  e.update();
}

function pixelLayerFrom(d: PhotoDocument, id: string, grid: TileGrid, keepStyle: boolean) {
  const t = findLayer(d.layers, id);
  if (!t) return;
  const name = t.name;
  clearToPixelLayer(t);
  setLayerPixels(t, grid, d);
  t.name = name;
  const drop = ['maskGrid', 'maskAsset', 'pixelMask', 'maskStrokes', 'maskInverted', 'maskDisabled', 'maskUnlinked', 'vectorMask'] as const;
  for (const k of drop) delete t[k];
  if (!keepStyle) {
    delete t.style;
    delete t.fillOpacity;
  }
  t.mask = null;
}

async function flattenAllEffects(e: Editor) {
  const list = allLayers(e.doc.layers).filter((l) => l.kind !== 'group' && !!activeLayerStyle(l) && !layerLock(e.doc.layers, l.id, 'all'));
  const results: [string, TileGrid][] = [];
  for (const l of list) {
    // As with Rasterize → Layer Style, effects composite onto transparency.
    const img = await layerRGBA(e, { ...l, opacity: 1, blend: 'normal' });
    results.push([l.id, gridFromImage(e.assets.tiles, img)]);
  }
  if (results.length) e.command('Flatten All Layer Effects', (d) => results.forEach(([id, g]) => pixelLayerFrom(d, id, g, false)));
  e.message(`Flattened effects on ${results.length} layer${results.length === 1 ? '' : 's'}.`);
}

async function flattenAllMasks(e: Editor) {
  const list = allLayers(e.doc.layers).filter((l) => maskable(l) && masked(l) && !layerLock(e.doc.layers, l.id, 'all'));
  const results: [string, TileGrid][] = [];
  for (const l of list) {
    if (l.kind === 'pixel' && l.pixels) {
      const b = gridDocBounds(l.pixels);
      const mask = await legacyMaskToGrid(e, l);
      if (!b || !mask) continue;
      results.push([l.id, applyMaskToGrid(e, l.pixels, mask, b, l)]);
    } else {
      // Other kinds are rendered with their mask applied, then become pixels.
      const img: RGBA8 = await layerRGBA(e, { ...l, opacity: 1, blend: 'normal', fillOpacity: 1, style: undefined });
      results.push([l.id, gridFromImage(e.assets.tiles, img)]);
    }
  }
  if (results.length)
    e.command('Flatten All Masks', (d) => {
      for (const [id, g] of results) {
        const t = findLayer(d.layers, id);
        if (t?.kind === 'pixel') {
          setLayerPixels(t, g, d);
          for (const k of ['maskGrid', 'maskAsset', 'pixelMask', 'maskStrokes', 'maskInverted', 'maskDisabled', 'maskUnlinked', 'vectorMask'] as const) delete t[k];
          t.mask = null;
        } else pixelLayerFrom(d, id, g, true);
      }
    });
  e.maskTarget = '';
  e.message(`Applied masks on ${results.length} layer${results.length === 1 ? '' : 's'}.`);
}
function applyMaskToGrid(e: Editor, pixels: TileGrid, mask: TileGrid, b: { x: number; y: number; width: number; height: number }, l: Layer) {
  const src = readRGBA(e.assets.tiles, pixels, b);
  const m = readMask(e.assets.tiles, mask, b).data;
  if (!l.maskDisabled)
    for (let i = 0; i < m.length; i++) src.data[i * 4 + 3] = (src.data[i * 4 + 3] * (l.maskInverted ? 255 - m[i] : m[i])) / 255;
  return writeRect(e.assets.tiles, pixels, b.x, b.y, src);
}
