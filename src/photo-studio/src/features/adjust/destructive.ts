// Image > Adjustments and the automatic corrections, applied destructively to
// the target layer (or mask) within the selection.
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { ADJUSTMENT_KINDS, ADJUSTMENT_LABELS, adjustmentOperations, autoLevels, defaultParams, equalizeMap, histograms, type Adjustment, type AdjustmentKind } from '../../imaging/adjust';
import type { RGBA8 } from '../../imaging/types';
import { readMask } from '../../model/tiles';
import { selectionGrid } from '../../model/selection';
import { applyToLayer } from '../pixels';
import { lazy } from '../../app/lazy';
import { adjustInWorker } from './worker-client';

// Image > Adjustments works on pixels, masks and Quick Mask; groups have no
// pixels, and an adjustment layer only offers its mask.
// The dialogs load with the first adjustment opened.
const dialogs = lazy(() => import('./dialog'));

export const canAdjust = (e: Editor) =>
  e.hasDocument && (!!e.settings.quickMask || (!!e.layer && e.selectedIds.size === 1 && e.layer.kind !== 'group' && (e.layer.kind !== 'adjustment' || e.editingMask)));

const SHORTCUTS: Partial<Record<AdjustmentKind, string>> = {
  levels: 'Mod+L',
  curves: 'Mod+M',
  'hue-saturation': 'Mod+U',
  'color-balance': 'Mod+B',
  'black-white': 'Mod+Alt+Shift+B',
  invert: 'Mod+I',
};

/** Selection coverage for an area, for analysis that should only count
 * selected pixels (Auto, Equalize). */
function selectionFor(e: Editor, rect: { x: number; y: number; width: number; height: number }) {
  const sel = selectionGrid(e.doc, e.assets.tiles);
  return sel ? readMask(e.assets.tiles, sel, rect) : undefined;
}

/** Apply an adjustment derived from the target pixels themselves. */
async function analyzed(e: Editor, label: string, make: (src: RGBA8, sel?: ReturnType<typeof selectionFor>) => Adjustment) {
  await applyToLayer(e, label, (src, rect) => adjustInWorker(src, make(src, selectionFor(e, rect))));
}

export function registerDestructiveCommands(e: Editor) {
  for (const kind of ADJUSTMENT_KINDS)
    registerCommand({
      id: `adjust.${kind}`,
      label: kind === 'invert' ? 'Invert' : `${ADJUSTMENT_LABELS[kind]}…`,
      shortcut: SHORTCUTS[kind],
      enabled: canAdjust,
      run: async (ed, arg) =>
        kind === 'invert'
          ? await applyToLayer(ed, 'Invert', (src) => adjustInWorker(src, { kind: 'invert', params: {} }))
          : (await dialogs()).adjustmentDialog(ed, kind, arg && typeof arg === 'object' ? (arg as never) : undefined),
      prefetch: kind === 'invert' ? undefined : dialogs.prefetch,
    });
  const auto = (id: string, label: string, mode: 'tone' | 'contrast' | 'color', shortcut: string) =>
    registerCommand({
      id,
      label,
      shortcut,
      enabled: canAdjust,
      run: (ed) => analyzed(ed, label, (src, selection) => ({ kind: 'levels', params: autoLevels(src, mode, { selection }) })),
    });
  auto('image.auto-tone', 'Auto Tone', 'tone', 'Mod+Shift+L');
  auto('image.auto-contrast', 'Auto Contrast', 'contrast', 'Mod+Alt+Shift+L');
  auto('image.auto-color', 'Auto Color', 'color', 'Mod+Shift+B');
  registerCommand({
    id: 'adjust.desaturate',
    label: 'Desaturate',
    shortcut: 'Mod+Shift+U',
    enabled: canAdjust,
    run: (ed) => {
      const params = defaultParams('hue-saturation');
      params.master.saturation = -100;
      return applyToLayer(ed, 'Desaturate', (src) => adjustInWorker(src, { kind: 'hue-saturation', params }));
    },
  });
  registerCommand({
    id: 'adjust.equalize',
    label: 'Equalize',
    enabled: canAdjust,
    // Mapping from the selected pixels' histogram, applied within the selection.
    run: (ed) =>
      analyzed(ed, 'Equalize', (src, selection) => {
        const params = defaultParams('curves');
        params.rgb = { mode: 'pencil', points: params.rgb.points, values: Array.from(equalizeMap(histograms(src, selection).rgb)) };
        return { kind: 'curves', params };
      }),
  });
  const op = (id: string) => adjustmentOperations.find((o) => o.id === id)!;
  registerCommand({
    id: 'adjust.shadows-highlights',
    label: 'Shadows/Highlights…',
    enabled: canAdjust,
    run: async (ed) => (await dialogs()).operationDialog(ed, op('adjust.shadows-highlights')),
    prefetch: dialogs.prefetch,
  });
  registerCommand({
    id: 'adjust.replace-color',
    label: 'Replace Color…',
    enabled: canAdjust,
    run: async (ed) => {
      const m = await dialogs();
      return m.operationDialog(ed, op('adjust.replace-color'), m.sampledColorControl('color'));
    },
    prefetch: dialogs.prefetch,
  });
  registerCommand({
    id: 'adjust.match-color',
    label: 'Match Color…',
    enabled: canAdjust,
    run: async (ed) => (await dialogs()).matchColorDialog(ed),
    prefetch: dialogs.prefetch,
  });
  void e;
}
