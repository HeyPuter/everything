import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { allLayers, findLayer, layer as newLayer, type Layer } from '../../model/document';
import { selectedRoots } from '../../model/layers';
import { layerLock } from '../../model/locks';
import { clearToPixelLayer, setLayerPixels } from '../../model/pixel-layer';
import { gridFromImage, readRGBA } from '../../model/tiles';
import { canvasRect, selectionBounds, selectionGrid } from '../../model/selection';
import { readMask, writeRect } from '../../model/tiles';
import { renderPattern } from '../../imaging/pattern/pattern';
import { compositeRGBA8 } from '../../imaging/blend/composite';
import type { DocumentPattern, LayerFill } from '../../model/fill-layer';
import type { LayerStyle } from '../../imaging/effects/types';
import type { AdvancedBlending } from '../../model/blending';
import { stylePreset } from '../../imaging/effects/presets';
import { activeLayerStyle, documentAnchored } from '../../renderer/layer-style';
import { sanitizeStyle } from '../../model/layer-style';
import { styleBoundsExpansion } from '../../imaging/effects/bounds';
import { layerBounds } from '../../model/artboard';
import { assertSize, cropDocument, type PhotoDocument } from '../../model/document';
import { hasMask } from '../../model/masks';
import type { RGBA8 } from '../../imaging/types';
import { formDialog } from '../../ui/dialog';
import { insertAboveSelection } from '../layers/insert';
import { commitTarget, compositeRGBA, pixelTarget, toRGBA8 } from '../pixels';
import { currentPattern, effectsState, resolveGradient } from './state';
import { effectLabels } from './effect-order';
import { lazy } from '../../app/lazy';

// The Layer Style dialog and Create Layers load on first use.
const styleDialog = lazy(() => import('./style-dialog'));
const styleLayers = lazy(() => import('./style-layers'));
import { allStyles } from './style-thumbs';

// Layer style, fill layer and pattern definition commands.
// Effects with a direct entry in Layer → Layer Style, in dialog order.
const effectEntries = Object.entries(effectLabels).filter(([k]) => k !== 'blending');
// Document patterns the style uses travel with it (as pixels: each document
// keeps its own tiles), so pasting into another document keeps them.
type CopiedPattern = Omit<DocumentPattern, 'grid'> & { image: RGBA8 };
let clipboard: { style?: LayerStyle; fillOpacity?: number; blending?: AdvancedBlending; patterns: CopiedPattern[] } | undefined;
// What Copy Layer Style carries: effects, fill opacity and blending options.
const copyable = (l: Layer | undefined) => hasStyle(l) || !!l?.blending || (l?.fillOpacity ?? 1) !== 1;
/** Pattern IDs a layer style refers to (pattern overlay, pattern strokes). */
function stylePatternIds(style: LayerStyle): Set<string> {
  const ids = new Set<string>();
  if (style.patternOverlay?.patternId) ids.add(style.patternOverlay.patternId);
  for (const s of Array.isArray(style.stroke) ? style.stroke : []) if (s?.fill?.type === 'pattern' && s.fill.patternId) ids.add(s.fill.patternId);
  return ids;
}
const styleable = (l: Layer | undefined) => !!l && l.kind !== 'adjustment';
const hasStyle = (l: Layer | undefined) => !!l?.style && Object.keys(l.style).some((k) => !['enabled', 'scale', 'globalAngle', 'globalAltitude'].includes(k));

/** Applies `edit` to every selected, editable layer that can carry a style. */
function editStyles(e: Editor, label: string, edit: (l: Layer) => void, also?: (d: PhotoDocument) => void) {
  const ids = selectedRoots(e.doc.layers, e.selectedIds).filter((l) => styleable(l) && !layerLock(e.doc.layers, l.id, 'all')).map((l) => l.id);
  if (!ids.length) {
    e.message('Select an unlocked layer first.');
    return;
  }
  e.command(label, (d) => {
    for (const id of ids) {
      const l = findLayer(d.layers, id);
      if (l) edit(l);
    }
    also?.(d);
  });
}
/** Give the selected layers a copy of `style` as one step (Libraries). */
export function applyLayerStyle(e: Editor, style: LayerStyle, label = 'Apply Style') {
  editStyles(e, label, (l) => (l.style = structuredClone(style) as Record<string, unknown>));
}
export function applyStylePreset(e: Editor, id: string) {
  const preset = allStyles().find((s) => s.id === id);
  const style = preset ? structuredClone(preset.style) : stylePreset(id);
  if (!style) return;
  editStyles(e, 'Apply Style', (l) => (l.style = structuredClone(style) as Record<string, unknown>));
}
export function fillLayerFor(e: Editor, type: 'gradient' | 'pattern'): LayerFill {
  return type === 'gradient'
    ? { type: 'gradient', gradient: resolveGradient(e, effectsState.gradient), style: 'linear', angle: 90, scale: 1, alignWithLayer: true, dither: true, method: 'perceptual' }
    : { type: 'pattern', patternId: effectsState.patternId, scale: 1, angle: 0 };
}

export function installEffectCommands() {
  registerCommand(
    {
      id: 'layer.style-dialog',
      label: 'Layer Style…',
      description: 'Add or edit effects such as shadows, glows, strokes and overlays',
      enabled: (e) => styleable(e.layer),
      run: async (e, arg) => (await styleDialog()).openStyleDialog(e, typeof arg === 'string' && arg ? arg : undefined),
      prefetch: styleDialog.prefetch,
    },
    {
      id: 'layer.style-blending',
      label: 'Blending Options…',
      description: 'Blend modes, Blend If ranges, channels and knockout',
      enabled: (e) => styleable(e.layer),
      run: async (e) => (await styleDialog()).openStyleDialog(e),
      prefetch: styleDialog.prefetch,
    },
    ...effectEntries.map(([key, label]) => ({
      id: `layer.style-${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`,
      label: `${label}…`,
      description: `Add or edit the ${label.toLowerCase()} effect`,
      enabled: (e: Editor) => styleable(e.layer),
      run: async (e: Editor) => (await styleDialog()).openStyleDialog(e, key),
      prefetch: styleDialog.prefetch,
    })),
    {
      id: 'layer.global-light',
      label: 'Global Light…',
      description: 'Set the light direction shared by effects in this document',
      enabled: (e) => e.hasDocument,
      run: async (e) => (await styleLayers()).globalLightDialog(e),
    },
    {
      id: 'layer.style-create-layers',
      label: 'Create Layers',
      description: 'Turn the layer’s effects into separate layers',
      enabled: (e) => !!e.layer && !!activeLayerStyle(e.layer),
      run: async (e) => (await styleLayers()).createStyleLayers(e),
    },
    {
      id: 'layer.content-options',
      label: 'Layer Content Options…',
      description: 'Edit the settings of the selected fill or adjustment layer',
      enabled: (e) => e.layer?.kind === 'adjustment' || e.layer?.kind === 'solid',
      run: (e) => {
        const l = e.layer;
        if (!l) return;
        // Adjustment, gradient and pattern settings live in Properties; a
        // solid color fill opens the color picker.
        if (l.kind === 'solid' && !l.fill) void e.runCommand('color.pick-layer-color');
        else if (l.kind === 'adjustment' || l.kind === 'solid') e.dock?.show('properties');
      },
    },
    {
      id: 'layer.style-copy',
      label: 'Copy Layer Style',
      enabled: (e) => copyable(e.layer),
      recordable: false,
      run: (e) => {
        const l = e.layer;
        if (!l || !copyable(l)) return;
        const style = l.style ? (structuredClone(l.style) as LayerStyle) : undefined;
        const used = style ? stylePatternIds(style) : new Set<string>();
        const patterns = (e.doc.patterns ?? [])
          .filter((p) => used.has(p.id))
          .map(({ grid, ...p }) => ({ ...p, image: readRGBA(e.assets.tiles, grid, { x: 0, y: 0, width: p.width, height: p.height }) }));
        clipboard = { style, fillOpacity: l.fillOpacity, blending: l.blending && structuredClone(l.blending), patterns };
        e.message('Layer style copied.');
      },
    },
    {
      id: 'layer.style-paste',
      label: 'Paste Layer Style',
      // Pastes onto every selected layer that can carry a style (editStyles).
      enabled: (e) => !!clipboard && e.selectedLayers.some(styleable),
      run: (e) => {
        const c = clipboard;
        if (!c) return;
        const missing = c.patterns
          .filter((p) => !e.doc.patterns?.some((x) => x.id === p.id))
          .map(({ image, ...p }) => ({ ...p, grid: gridFromImage(e.assets.tiles, image) }));
        editStyles(e, 'Paste Layer Style', (l) => {
          if (c.style) l.style = structuredClone(c.style) as Record<string, unknown>;
          else delete l.style;
          if (c.fillOpacity !== undefined && c.fillOpacity !== 1) l.fillOpacity = c.fillOpacity;
          else delete l.fillOpacity;
          // Blending options travel with the style.
          if (c.blending) l.blending = structuredClone(c.blending);
          else delete l.blending;
        }, (d) => {
          if (missing.length) d.patterns = [...(d.patterns ?? []), ...missing];
        });
      },
    },
    {
      id: 'layer.style-clear',
      label: 'Clear Layer Style',
      enabled: (e) => e.selectedLayers.some(hasStyle),
      run: (e) => editStyles(e, 'Clear Layer Style', (l) => delete l.style),
    },
    {
      id: 'layer.style-hide-all',
      label: 'Hide All Effects',
      enabled: (e) => allLayers(e.doc.layers).some(hasStyle),
      checked: (e) => {
        const styled = allLayers(e.doc.layers).filter(hasStyle);
        return styled.length > 0 && styled.every((l) => (l.style as LayerStyle).enabled === false);
      },
      run: (e) => {
        const styled = allLayers(e.doc.layers).filter(hasStyle);
        const show = styled.every((l) => (l.style as LayerStyle).enabled === false);
        e.command(show ? 'Show All Effects' : 'Hide All Effects', (d) => {
          for (const l of allLayers(d.layers)) if (hasStyle(l)) (l.style as LayerStyle).enabled = show;
        });
      },
    },
    {
      id: 'layer.style-scale',
      label: 'Scale Effects…',
      enabled: (e) => hasStyle(e.layer),
      run: async (e) => {
        const v = await formDialog('Scale Layer Effects', [{ name: 'scale', label: 'Scale (%)', value: 100, type: 'number', min: 1, max: 1000 }], 'OK');
        const k = Number(v?.scale) / 100;
        if (!v || !Number.isFinite(k) || k <= 0) return;
        editStyles(e, 'Scale Effects', (l) => {
          if (!l.style) return;
          const s = l.style as LayerStyle;
          s.scale = Math.min(10, Math.max(0.01, (s.scale ?? 1) * k));
        });
      },
    },
    {
      id: 'layer.rasterize-style',
      label: 'Layer Style',
      description: 'Bake the layer and its effects into pixels',
      enabled: (e) => !!e.layer && e.layer.kind !== 'group' && !!activeLayerStyle(e.layer),
      run: async (e) => {
        const l = e.layer;
        if (!l || !activeLayerStyle(l)) return;
        if (layerLock(e.doc.layers, l.id, 'all')) {
          e.message('Unlock this layer to rasterize its style.');
          return;
        }
        // Effects composite onto transparency here: modes such as Multiply
        // then look like Normal, as when merging onto an empty layer.
        const max = e.renderer.backend.maxSize;
        const { doc: area, layer: source, rect } = rasterArea(e.doc, l, max);
        const plain = { ...source, opacity: 1, blend: 'normal' as const };
        const samples = await e.renderer.layerPixels(plain, area, e.assets);
        const image = toRGBA8(samples, rect.width, rect.height);
        const grid = gridFromImage(e.assets.tiles, image, rect.x, rect.y);
        const id = l.id;
        e.command('Rasterize Layer Style', (d) => {
          const t = findLayer(d.layers, id)!;
          const name = t.name;
          clearToPixelLayer(t);
          setLayerPixels(t, grid, d);
          t.name = name;
          for (const k of ['style', 'fillOpacity', 'maskGrid', 'maskAsset', 'pixelMask', 'maskStrokes', 'maskInverted', 'maskDisabled'] as const) delete t[k];
          t.mask = null;
        });
      },
    },
    {
      id: 'layer.fill-gradient',
      label: 'Gradient',
      description: 'A non-destructive layer filled with the current gradient',
      enabled: (e) => e.hasDocument,
      run: (e) => newFillLayer(e, 'gradient'),
    },
    {
      id: 'layer.fill-pattern',
      label: 'Pattern',
      description: 'A non-destructive layer filled with the current pattern',
      enabled: (e) => e.hasDocument,
      run: (e) => newFillLayer(e, 'pattern'),
    },
    {
      id: 'edit.define-pattern',
      label: 'Define Pattern…',
      description: 'Save the selected area as a pattern in this document',
      enabled: (e) => e.hasDocument,
      run: (e) => definePattern(e),
    },
    {
      id: 'layer.style-preset',
      label: 'Apply Style Preset',
      hidden: true,
      run: (e, arg) => applyStylePreset(e, String(arg)),
    },
  );
}
function newFillLayer(e: Editor, type: 'gradient' | 'pattern') {
  const l = newLayer('solid', type === 'gradient' ? 'Gradient Fill' : 'Pattern Fill', e.doc.width, e.doc.height);
  l.fill = fillLayerFor(e, type);
  if (e.doc.selection) l.maskGrid = selectionGrid(e.doc, e.assets.tiles) ?? undefined;
  insertAboveSelection(e, l, 'New Fill Layer');
  e.dock?.show('properties');
}
/** Where a layer is rendered to rasterize its style: the canvas grown to the
 * layer and its effects, so content outside the canvas is kept. Styles
 * anchored to the document (unaligned gradients, unlinked patterns) and
 * areas too large for one render use the canvas as it is. */
function rasterArea(doc: PhotoDocument, l: Layer, maxSize: number) {
  const canvas = { x: 0, y: 0, width: doc.width, height: doc.height };
  const style = sanitizeStyle(activeLayerStyle(l)!);
  const b = layerBounds(l);
  if (!b || documentAnchored(style)) return { doc, layer: l, rect: canvas };
  const r = styleBoundsExpansion(style);
  const x0 = Math.min(0, Math.floor(b.x - r.left)),
    y0 = Math.min(0, Math.floor(b.y - r.top));
  const x1 = Math.max(doc.width, Math.ceil(b.x + b.width + r.right)),
    y1 = Math.max(doc.height, Math.ceil(b.y + b.height + r.bottom));
  const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const same = rect.width === doc.width && rect.height === doc.height;
  if (same) return { doc, layer: l, rect: canvas };
  try {
    assertSize(rect.width, rect.height);
    if (rect.width > maxSize || rect.height > maxSize) throw new Error();
  } catch {
    return { doc, layer: l, rect: canvas };
  }
  const area = structuredClone({ ...doc, layers: [l] }) as PhotoDocument;
  cropDocument(area, rect);
  return { doc: area, layer: area.layers[0], rect };
}

async function definePattern(e: Editor) {
  const doc = e.doc;
  const sel = selectionGrid(doc, e.assets.tiles);
  const rect = sel ? selectionBounds(doc, sel) : canvasRect(doc);
  if (!rect || rect.width < 1 || rect.height < 1) {
    e.message('Select an area to define a pattern.');
    return;
  }
  if (rect.width > 1024 || rect.height > 1024) {
    e.message('Patterns can be up to 1024 × 1024 pixels. Select a smaller area.');
    return;
  }
  const v = await formDialog('Pattern Name', [{ name: 'name', label: 'Name', value: `Pattern ${(doc.patterns?.length ?? 0) + 1}` }], 'OK');
  if (!v) return;
  // The visible pixels of the selected layer, or of the image when no pixel layer is selected.
  const l = e.layer;
  let img: RGBA8 | undefined;
  if (l?.kind === 'pixel' && l.pixels) {
    const masked = !l.maskDisabled && (hasMask(l) || !!l.maskGrid || !!l.pixelMask);
    if (!masked) img = readRGBA(e.assets.tiles, l.pixels, rect);
    else {
      // The mask decides what is visible: render the layer alone, without effects.
      const samples = await e.renderer.layerPixels({ ...l, style: undefined }, doc, e.assets);
      const all = toRGBA8(samples, doc.width, doc.height);
      const data = new Uint8ClampedArray(rect.width * rect.height * 4);
      img = { width: rect.width, height: rect.height, data };
      for (let y = 0; y < rect.height; y++) {
        const from = ((rect.y + y) * all.width + rect.x) * 4;
        img.data.set(all.data.subarray(from, from + rect.width * 4), y * rect.width * 4);
      }
    }
  }
  if (!img) {
    const all = await compositeRGBA(e);
    img = { width: rect.width, height: rect.height, data: new Uint8ClampedArray(rect.width * rect.height * 4) };
    for (let y = 0; y < rect.height; y++) img.data.set(all.data.subarray(((rect.y + y) * all.width + rect.x) * 4, ((rect.y + y) * all.width + rect.x + rect.width) * 4), y * rect.width * 4);
  }
  const grid = gridFromImage(e.assets.tiles, img);
  const id = `user-${crypto.randomUUID()}`;
  e.command('Define Pattern', (d) => {
    d.patterns = [...(d.patterns ?? []), { id, name: v.name.trim() || 'Pattern', width: rect.width, height: rect.height, grid }];
  });
  effectsState.patternId = id;
  e.dock?.update();
  e.message(`Pattern “${v.name.trim() || 'Pattern'}” defined.`);
}

/** Edit > Fill with the current pattern (document-anchored tiles). */
export async function fillWithPattern(e: Editor, opacity: number, preserve: boolean) {
  const pattern = currentPattern(e);
  if (!pattern) return;
  const target = await pixelTarget(e);
  if (!target) return;
  const doc = e.doc;
  const sel = target.kind === 'quick-mask' ? null : selectionGrid(doc, e.assets.tiles);
  const b = sel ? selectionBounds(doc, sel) : canvasRect(doc);
  if (!b) return;
  const cover = sel ? readMask(e.assets.tiles, sel, b) : undefined;
  const img = renderPattern(b.width, b.height, pattern, { scale: effectsState.patternScale }, { x: b.x, y: b.y });
  if (target.kind !== 'pixels') {
    const m = readMask(e.assets.tiles, target.grid, b);
    for (let i = 0; i < m.data.length; i++) {
      const k = opacity * (img.data[i * 4 + 3] / 255) * (cover ? cover.data[i] / 255 : 1);
      const v = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
      m.data[i] += (v - m.data[i]) * k;
    }
    commitTarget(e, target, writeRect(e.assets.tiles, target.grid, b.x, b.y, m), 'Fill');
    return;
  }
  const src = readRGBA(e.assets.tiles, target.grid, b);
  if (preserve || layerLock(doc.layers, target.layer.id, 'transparency')) {
    // Preserving transparency mixes the pattern into each pixel's color by
    // the pattern's coverage and keeps the alpha (as Fill with a color does).
    const d = src.data, p = img.data;
    for (let i = 0; i < d.length / 4; i++) {
      const k = opacity * (p[i * 4 + 3] / 255) * (cover ? cover.data[i] / 255 : 1);
      if (!k) continue;
      for (let c = 0; c < 3; c++) d[i * 4 + c] += (p[i * 4 + c] - d[i * 4 + c]) * k;
    }
  } else compositeRGBA8(src, img, 'normal', opacity, cover);
  commitTarget(e, target, writeRect(e.assets.tiles, target.grid, b.x, b.y, src), 'Fill');
}
