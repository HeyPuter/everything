// Properties panel editor for adjustment layers. Dragging previews the
// modified document; releasing commits one history step. The panel re-mounts
// editors whenever the stored adjustment changes, so the editor DOM (with its
// working state) is cached and re-attached when the stored value is the one
// this editor just committed.
import type { Editor } from '../../editor';
import { ADJUSTMENT_LABELS, defaultParams, type Adjustment, type AdjustmentKind } from '../../imaging/adjust';
import { findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { layerLock } from '../../model/locks';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import type { AdjustHost } from './host';
import { adjustmentSpec, specAdjustment } from './compile';
import { kindEditors, kindIcon } from './editors';
import { belowSource, cancelPick, pickPoint, sampleAt } from './source';
import { h } from './ui';

// `dirty`: the editor shows values that were previewed or refused but never
// stored, so it must be rebuilt from the layer rather than re-attached.
type Mounted = { session: string; layerId: string; json: string; root: HTMLElement; footer: () => void; dirty?: boolean };
let mounted: Mounted | undefined;

export function replaceLayer(layers: Layer[], id: string, fn: (l: Layer) => Layer): Layer[] {
  return layers.map((l) => (l.id === id ? fn(l) : l.children.length ? { ...l, children: replaceLayer(l.children, id, fn) } : l));
}

export function mountLayerEditor(e: Editor, el: HTMLElement, l: Layer) {
  const json = JSON.stringify(l.adjustment);
  if (mounted && mounted.session === e.session.id && mounted.layerId === l.id && mounted.json === json && !mounted.dirty) {
    el.append(mounted.root);
    mounted.footer();
    return;
  }
  cancelPick();
  const adj = specAdjustment(l.adjustment);
  if (!adj) {
    el.innerHTML = `<div class="adj-props"><p class="adj-note">This adjustment (${escapeXML(l.adjustment?.kind ?? 'unknown')}) is not supported and is kept unchanged.</p></div>`;
    mounted = undefined;
    return;
  }
  const id = l.id,
    kind = adj.kind;
  const root = h('div', { class: 'adj-props' });
  root.innerHTML = `<div class="adj-props-head">${svg(kindIcon[kind], 18)}<div><span class="eyebrow">ADJUSTMENT</span><h3>${escapeXML(ADJUSTMENT_LABELS[kind])}</h3></div></div>`;
  const body = h('div', { class: 'adj-body' });
  const footer = h('div', { class: 'adj-footer' });
  root.append(body, footer);
  const state: Mounted = { session: e.session.id, layerId: id, json, root, footer: () => drawFooter() };
  mounted = state;

  const current = () => findLayer(e.doc.layers, id);
  const host: AdjustHost = {
    e,
    kind,
    params: adj.params,
    ui: {},
    dialog: false,
    change(commit) {
      const spec = adjustmentSpec({ kind, params: host.params } as Adjustment);
      if (!commit) {
        state.dirty = true;
        const doc: PhotoDocument = { ...e.doc, layers: replaceLayer(e.doc.layers, id, (x) => ({ ...x, adjustment: spec })) };
        e.preview(doc);
        return;
      }
      if (!current()) return;
      if (layerLock(e.doc.layers, id, 'all')) {
        // Refused: the editor goes back to the stored settings.
        const stored = specAdjustment(current()!.adjustment);
        if (stored) host.params = stored.params as typeof host.params;
        state.dirty = false;
        host.rerender();
        e.message('Unlock this layer to edit it.');
        e.update();
        return;
      }
      state.json = JSON.stringify(spec);
      state.dirty = false;
      e.command(`Modify ${ADJUSTMENT_LABELS[kind]} Layer`, (d) => {
        const t = findLayer(d.layers, id);
        if (t) t.adjustment = spec;
      });
    },
    source: () => belowSource(e, id),
    async pick() {
      const pt = await pickPoint(e);
      if (!pt) return null;
      const s = await belowSource(e, id);
      return sampleAt(s.image, pt[0], pt[1]);
    },
    rerender() {
      body.innerHTML = '';
      kindEditors[kind](body, host as never);
    },
  };
  host.rerender();

  const drawFooter = () => {
    const t = current();
    if (!t) return;
    footer.innerHTML = `<button type="button" class="icon-button" data-adj="clip" aria-pressed="${!!t.clipped}" title="${t.clipped ? 'Affects only the layer below (click to affect all layers below)' : 'Clip to the layer below'}" aria-label="Clip to layer">${svg('adj-clip', 16)}</button>
<button type="button" class="icon-button" data-adj="visible" aria-pressed="${!t.visible}" title="${t.visible ? 'Hide' : 'Show'} this adjustment" aria-label="${t.visible ? 'Hide' : 'Show'} adjustment">${svg(t.visible ? 'eye' : 'eye-off', 16)}</button>
<button type="button" class="icon-button" data-adj="reset" title="Reset to adjustment defaults" aria-label="Reset adjustment">${svg('rotate-ccw', 16)}</button>
<button type="button" class="icon-button" data-adj="delete" title="Delete this adjustment layer" aria-label="Delete adjustment layer">${svg('trash-2', 16)}</button>`;
  };
  footer.addEventListener('click', (ev) => {
    const action = (ev.target as HTMLElement).closest<HTMLElement>('[data-adj]')?.dataset.adj;
    if (!action || !current()) return;
    if (action === 'delete') {
      e.selectLayers([id]);
      void e.runCommand('layer.delete');
      return;
    }
    if (layerLock(e.doc.layers, id, 'all')) return e.message('Unlock this layer to edit it.');
    if (action === 'reset') {
      host.params = defaultParams(kind as AdjustmentKind);
      host.ui = {};
      host.change(true);
      host.rerender();
      return;
    }
    e.command(action === 'clip' ? (current()!.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask') : 'Toggle visibility', (d) => {
      const t = findLayer(d.layers, id);
      if (!t) return;
      if (action === 'clip') t.clipped = !t.clipped;
      else t.visible = !t.visible;
    });
  });
  drawFooter();
  el.append(root);
}

/** Keep the footer toggles in sync with edits made elsewhere (Layers panel). */
export function refreshLayerEditor() {
  if (mounted?.root.isConnected) mounted.footer();
}
