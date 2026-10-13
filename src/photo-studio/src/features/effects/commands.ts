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
import type { LayerFill } from '../../model/fill-layer';
import type { LayerStyle } from '../../imaging/effects/types';
import type { AdvancedBlending } from '../../model/blending';
import { stylePreset } from '../../imaging/effects/presets';
import { activeLayerStyle } from '../../renderer/layer-style';
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
let clipboard: { style: LayerStyle; fillOpacity?: number; blending?: AdvancedBlending } | undefined;
const styleable = (l: Layer | undefined) => !!l && l.kind !== 'adjustment';
const hasStyle = (l: Layer | undefined) => !!l?.style && Object.keys(l.style).some((k) => !['enabled', 'scale', 'globalAngle', 'globalAltitude'].includes(k));

/** Applies `edit` to every selected, editable layer that can carry a style. */
function editStyles(e: Editor, label: string, edit: (l: Layer) => void) {
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
      enabled: (e) => hasStyle(e.layer),
      recordable: false,
      run: (e) => {
        const l = e.layer;
        if (!l?.style) return;
        clipboard = { style: structuredClone(l.style) as LayerStyle, fillOpacity: l.fillOpacity, blending: l.blending && structuredClone(l.blending) };
        e.message('Layer style copied.');
      },
    },
    {
      id: 'layer.style-paste',
      label: 'Paste Layer Style',
      enabled: (e) => !!clipboard && styleable(e.layer),
      run: (e) => {
        const c = clipboard;
        if (!c) return;
        editStyles(e, 'Paste Layer Style', (l) => {
          l.style = structuredClone(c.style) as Record<string, unknown>;
          if (c.fillOpacity !== undefined && c.fillOpacity !== 1) l.fillOpacity = c.fillOpacity;
          else delete l.fillOpacity;
          // Blending options travel with the style.
          if (c.blending) l.blending = structuredClone(c.blending);
          else delete l.blending;
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
        const samples = await e.renderer.layerPixels({ ...l, opacity: 1, blend: 'normal' }, e.doc, e.assets);
        const grid = gridFromImage(e.assets.tiles, toRGBA8(samples, e.doc.width, e.doc.height));
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
  let img = l?.kind === 'pixel' && l.pixels ? readRGBA(e.assets.tiles, l.pixels, rect) : undefined;
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
  const alpha = src.data.filter((_, i) => i % 4 === 3);
  compositeRGBA8(src, img, 'normal', opacity, cover);
  if (preserve || layerLock(doc.layers, target.layer.id, 'transparency')) for (let i = 0; i < alpha.length; i++) src.data[i * 4 + 3] = alpha[i];
  commitTarget(e, target, writeRect(e.assets.tiles, target.grid, b.x, b.y, src), 'Fill');
}
