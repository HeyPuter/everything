// Adjustment layer creation (Layer > New Adjustment Layer, the Layers panel
// footer menu and the Adjustments panel) and the Adjustments panel itself.
import type { Editor } from '../../editor';
import { registerCommand, type Panel } from '../../app/registry';
import { ADJUSTMENT_KINDS, ADJUSTMENT_LABELS, defaultAdjustment, type Adjustment, type AdjustmentKind } from '../../imaging/adjust';
import { allLayers, findLayer, insertLayerAt, layer, type Layer } from '../../model/document';
import { allMask } from '../../model/tiles';
import { selectionGrid } from '../../model/selection';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { adjustmentLayerName, adjustmentSpec } from './compile';
import { kindIcon } from './icons';

/** Add an adjustment layer above the selected layer. Its mask reveals all,
 * or the active selection (which is then dropped, as the mask carries it). */
export function addAdjustmentLayer(e: Editor, kind: AdjustmentKind, adjustment: Adjustment = defaultAdjustment(kind)) {
  const doc = e.doc;
  const l = layer('adjustment', adjustmentLayerName(kind, allLayers(doc.layers).map((x) => x.name)), doc.width, doc.height);
  l.adjustment = adjustmentSpec(adjustment);
  const sel = selectionGrid(doc, e.assets.tiles);
  l.maskGrid = sel ?? allMask(255);
  const anchor = e.selected;
  // Inside a clipping group (above its base or one of its clipped layers) the
  // new layer joins the group.
  if (findLayer(doc.layers, anchor)?.clipped) l.clipped = true;
  e.command(`New ${ADJUSTMENT_LABELS[kind]} Layer`, (d) => {
    const insert = (layers: Layer[]): boolean => {
      const i = layers.findIndex((x) => x.id === anchor);
      if (i >= 0) {
        insertLayerAt(layers, i + 1, l);
        return true;
      }
      return layers.some((x) => insert(x.children));
    };
    if (!anchor || !insert(d.layers)) d.layers.push(l);
    if (sel) {
      d.selection = null;
      d.selectionMask = null;
    }
  });
  e.selected = l.id;
  e.hasDocument = true;
  e.dock?.show('properties');
  e.update();
  return l.id;
}

export function registerAdjustmentLayerCommands(e: Editor) {
  for (const kind of ADJUSTMENT_KINDS)
    registerCommand({
      id: `layer.adj-${kind}`,
      label: ADJUSTMENT_LABELS[kind],
      description: `Add a non-destructive ${ADJUSTMENT_LABELS[kind]} adjustment layer`,
      enabled: (ed) => ed.hasDocument,
      run: () => void addAdjustmentLayer(e, kind),
    });
}

export const adjustmentsPanel: Panel = {
  id: 'adjustments',
  title: 'Adjustments',
  icon: 'adj-levels',
  location: 'dock-middle',
  mount: (_e, el) => {
    el.classList.add('adj-panel');
    el.innerHTML = `<p class="adj-panel-hint">Add an adjustment</p><div class="adj-grid" role="toolbar" aria-label="Add an adjustment layer">${ADJUSTMENT_KINDS.map(
      (k) => `<button type="button" class="adj-grid-button" data-command="layer.adj-${k}" title="${escapeXML(ADJUSTMENT_LABELS[k])}" aria-label="Add ${escapeXML(ADJUSTMENT_LABELS[k])} adjustment layer" data-label="${escapeXML(ADJUSTMENT_LABELS[k])}">${svg(kindIcon[k], 20)}</button>`,
    ).join('')}</div>`;
    const hint = el.querySelector('.adj-panel-hint')!;
    const show = (ev: Event) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-label]');
      hint.textContent = b ? b.dataset.label! : 'Add an adjustment';
    };
    el.addEventListener('pointerover', show);
    el.addEventListener('focusin', show);
    el.addEventListener('pointerleave', () => (hint.textContent = 'Add an adjustment'));
  },
  update: (ed, el) => {
    for (const b of el.querySelectorAll<HTMLButtonElement>('.adj-grid-button')) b.disabled = !ed.hasDocument;
  },
  menu: () => ADJUSTMENT_KINDS.map((k) => `layer.adj-${k}`),
};
