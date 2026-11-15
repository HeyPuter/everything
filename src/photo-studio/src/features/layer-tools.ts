import type { Editor } from '../editor';
import { registerTool } from '../app/registry';
import type { CanvasPointer } from '../app/pointer';
import { findLayer } from '../model/document';
import { compositeRGBA, layerRGBA, rgbHex } from './pixels';
import { readRGBA } from '../model/tiles';
import type { RGBA8 } from '../imaging/types';
import { svg } from '../app/icons';
import { sampleAverage, SAMPLE_SIZES } from '../imaging/measure/geometry';


export function installLayerTools(e: Editor) {
  registerTool({
    id: 'move',
    label: 'Move Tool',
    key: 'V',
    icon: 'move',
    group: 'move',
    // Pointer handling lives in FreeTransform (selection, drag, handles).
    options: (e) => moveOptions(e),
    bindOptions: ({ e, el }) => {
      el.querySelector<HTMLInputElement>('#auto-select')?.addEventListener('change', (ev) => {
        e.autoSelect = (ev.target as HTMLInputElement).checked;
        el.querySelector<HTMLSelectElement>('#auto-select-target')!.disabled = !e.autoSelect;
      });
      el.querySelector<HTMLSelectElement>('#auto-select-target')?.addEventListener('change', (ev) => (e.settings.autoSelectTarget = (ev.target as HTMLSelectElement).value));
      el.querySelector<HTMLInputElement>('#show-transform-controls')?.addEventListener('change', (ev) => {
        e.settings.showTransformControls = (ev.target as HTMLInputElement).checked;
        e.overlay();
      });
      el.querySelector<HTMLButtonElement>('#move-more')?.addEventListener('click', (ev) => {
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        void import('../app/menubar').then(({ showContextMenu }) => showContextMenu(e, r.left, r.bottom + 2, moveOverflow));
      });
    },
  });
  // The Crop and Perspective Crop tools live in features/transform/crop.ts.
  registerTool({
    id: 'eyedropper',
    label: 'Eyedropper Tool',
    key: 'I',
    icon: 'pipette',
    group: 'eyedropper',
    cursor: () => 'crosshair',
    options: (e) =>
      `<label>Sample Size <select id="sample-size">${SAMPLE_SIZES.map((n) => `<option value="${n}" ${Number(e.settings.sampleSize ?? 1) === n ? 'selected' : ''}>${n === 1 ? 'Point Sample' : `${n} by ${n} Average`}</option>`).join('')}</select></label><label>Sample <select id="sample-layers"><option value="current" ${e.settings.sampleAll ? '' : 'selected'}>Current Layer</option><option value="all" ${e.settings.sampleAll ? 'selected' : ''}>All Layers</option></select></label>`,
    bindOptions: ({ e, el }) => {
      el.querySelector<HTMLSelectElement>('#sample-size')?.addEventListener('change', (ev) => (e.settings.sampleSize = Number((ev.target as HTMLSelectElement).value)));
      el.querySelector<HTMLSelectElement>('#sample-layers')?.addEventListener('change', (ev) => (e.settings.sampleAll = (ev.target as HTMLSelectElement).value === 'all'));
    },
    pointerDown: (e, p) => sampleColorAt(e, p, p.alt),
    pointerMove: (e, p) => sampleColorAt(e, p, p.alt),
  });
  void e;
}
/** More arrangement commands than fit the options bar. */
const moveOverflow = [
  { label: 'Distribute', items: ['layer.distribute-top', 'layer.distribute-vcenter', 'layer.distribute-bottom', '-', 'layer.distribute-left', 'layer.distribute-hcenter', 'layer.distribute-right'] },
  { label: 'Distribute Spacing', items: ['layer.distribute-h-space', 'layer.distribute-v-space'] },
  '-',
  'layer.align-to-canvas',
];
/** Move tool options: Auto-Select with its target, the transform frame
 * toggle, snapping, then align and distribute buttons. */
function moveOptions(e: Editor) {
  const target = e.settings.autoSelectTarget === 'group' ? 'group' : 'layer';
  const button = (id: string, label: string, icon: string, enabled: boolean) => `<button class="icon-button" data-command="${id}" title="${label}" aria-label="${label}" ${enabled ? '' : 'disabled'}>${svg(icon, 16)}</button>`;
  const any = e.selectedIds.size >= 1,
    many = e.selectedIds.size >= 3;
  return (
    `<label class="transform-setting"><input id="auto-select" type="checkbox" ${e.autoSelect ? 'checked' : ''}>Auto-Select</label>` +
    `<select id="auto-select-target" aria-label="Auto-select target" title="What a click selects: the layer under the pointer or its outermost group" ${e.autoSelect ? '' : 'disabled'}><option value="layer">Layer</option><option value="group" ${target === 'group' ? 'selected' : ''}>Group</option></select>` +
    `<label class="transform-setting"><input id="show-transform-controls" type="checkbox" ${e.settings.showTransformControls !== false ? 'checked' : ''}>Show Transform Controls</label>` +
    `<label class="transform-setting"><input id="transform-snap" type="checkbox" ${e.transform.snapping ? 'checked' : ''}>Snap</label><button data-command="edit.free-transform" ${!e.selectedIds.size ? 'disabled' : ''}>Free Transform</button><span class="divider"></span>` +
    ['align-left', 'align-hcenter', 'align-right', 'align-top', 'align-vcenter', 'align-bottom']
      .map((a) => button(`layer.${a}`, a.replace('align-', 'Align ').replace('hcenter', 'horizontal centers').replace('vcenter', 'vertical centers'), alignIcon(a), any))
      .join('') +
    `<span class="divider"></span>` +
    button('layer.distribute-hcenter', 'Distribute horizontal centers', 'distribute-h', many) +
    button('layer.distribute-vcenter', 'Distribute vertical centers', 'distribute-v', many) +
    `<button class="icon-button" id="move-more" title="More align and distribute options" aria-label="More align and distribute options" aria-haspopup="menu">${svg('ellipsis', 16)}</button>`
  );
}
function alignIcon(a: string) {
  return (
    {
      'align-left': 'align-start-vertical',
      'align-hcenter': 'align-horizontal-justify-center',
      'align-right': 'align-end-vertical',
      'align-top': 'align-start-horizontal',
      'align-vcenter': 'align-vertical-justify-center',
      'align-bottom': 'align-end-horizontal',
    } as Record<string, string>
  )[a];
}
let sampleCache: { doc: unknown; layer?: string; all: boolean; image: Promise<RGBA8> } | undefined;
/** Eyedropper sampling with its Sample Size and Sample settings; painting
 * tools use it for Alt-click (Option-click) color picking. */
export async function sampleColorAt(e: Editor, p: CanvasPointer, background = false) {
  const all = !!e.settings.sampleAll;
  const l = e.layer;
  if (!sampleCache || sampleCache.doc !== e.doc || sampleCache.all !== all || sampleCache.layer !== l?.id)
    sampleCache = {
      doc: e.doc,
      layer: l?.id,
      all,
      image: all || !l ? compositeRGBA(e) : l.kind === 'pixel' && l.pixels ? Promise.resolve(readRGBA(e.assets.tiles, l.pixels, { x: 0, y: 0, width: e.doc.width, height: e.doc.height })) : layerRGBA(e, findLayer(e.doc.layers, l.id)!),
    };
  const img = await sampleCache.image;
  const c = sampleAverage(img, p.x, p.y, Number(e.settings.sampleSize ?? 1));
  if (!c) return;
  const hex = rgbHex(c[0], c[1], c[2]);
  if (background) e.setBackground(hex);
  else e.setForeground(hex);
}
