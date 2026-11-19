// Properties for layers: name and locks, Transform (size with a link, position,
// angle and flips, in the ruler units), Align and Distribute, the kind's own
// controls, Adjustments, the mask and Quick Actions. Type and shape editors
// reuse this markup with their own parts in place of some sections.
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { findCommand } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { layerLock, ownLock } from '../../model/locks';
import { hasMask } from '../../model/masks';
import { layerLocked } from '../../model/transform';
import { isVectorGradient } from '../../model/vector-gradient';
import { isVectorPattern } from '../../model/vector-pattern';
import { vectorDisplayHex } from '../../color/vector';
import { gradientProperties, number, strokeProperties } from '../../ui/panels';
import { docPpi } from '../transform/dialog';
import type { LengthUnit } from '../transform/math';
import { commandButton, commandToggle, field, fieldHandlers, section } from './property-fields';
import {
  clamp,
  formatLength,
  formatNumber,
  isLengthUnit,
  linkedSize,
  normalizeAngle,
  parseLength,
  parseNumber,
  UNIT_SUFFIX,
} from './property-values';

// Marks where feature sections (embedded objects, generated content) go.
export const ADJUSTMENTS_MARK = '<!--adjustments-->';

const KIND_ICON: Record<string, string> = {
  pixel: 'image',
  image: 'embedded-object',
  text: 'type',
  vector: 'shapes',
  solid: 'swatch-book',
  group: 'folder',
  adjustment: 'adjustment-layer',
  paint: 'paintbrush',
};
export function kindTitle(l: Layer) {
  if (l.kind === 'image') return 'EMBEDDED OBJECT';
  if (l.kind === 'vector') return 'SHAPE LAYER';
  if (l.kind === 'text') return 'TYPE LAYER';
  if (l.kind === 'solid') return l.fill ? `${l.fill.type.toUpperCase()} FILL LAYER` : 'FILL LAYER';
  return `${l.kind.toUpperCase()} LAYER`;
}
/** The kind icon and title above a layer's properties. */
export const layerTitle = (l: Layer, title = kindTitle(l)) =>
  `<div class="pf-title">${svg(KIND_ICON[l.kind] ?? 'layers', 14)}<span class="eyebrow">${escapeXML(title)}</span></div>`;

export const layerUnit = (e: Editor): LengthUnit =>
  isLengthUnit(e.preferences.rulerUnits) ? e.preferences.rulerUnits : 'px';
export const linked = (e: Editor) => e.settings.propertiesLayerLinked === true;
export type Axis = 'x' | 'y' | 'width' | 'height';
export const lengthCtx = (e: Editor, key: Axis) => ({
  unit: layerUnit(e),
  ppi: docPpi(e.doc),
  base: key === 'x' || key === 'width' ? e.doc.width : e.doc.height,
});

/** Transform fields for one layer: W and H with a link, X, Y and the angle,
 * then flips. Values come from `t` (a live Free Transform draft included). */
export function transformSection(e: Editor, l: Layer, disabled: boolean, t = l.transform) {
  const unit = layerUnit(e);
  const step = unit === 'px' || unit === 'percent' ? 1 : 0.1;
  const len = (key: Axis, label: string, title: string) =>
    field({
      key: `layer.${key}`,
      label,
      title,
      value: formatLength(t[key], lengthCtx(e, key)),
      suffix: UNIT_SUFFIX[unit],
      disabled,
      step,
    });
  const on = linked(e);
  const body = `<div class="pf-transform">
<button type="button" class="icon-button toggle pf-link" data-pf-link="layer" aria-pressed="${on}" title="${on ? 'Width and height keep their proportions (click to unlink)' : 'Link width and height to keep proportions'}" aria-label="Link layer width and height" ${disabled ? 'disabled' : ''}>${svg(on ? 'link' : 'unlink', 14)}</button>
${len('width', 'W', 'Width')}${len('x', 'X', 'Horizontal position of the left edge')}
${len('height', 'H', 'Height')}${len('y', 'Y', 'Vertical position of the top edge')}
</div>
<div class="pf-angle">${field({ key: 'layer.rotation', label: 'Angle', title: 'Rotation in degrees', value: formatNumber(t.rotation, 2), suffix: '°', disabled, step: 1 })}<div class="pf-flips">${commandButton(e, 'edit.flip-horizontal', 'Flip horizontal', 'flip-horizontal-2', { iconOnly: true })}${commandButton(e, 'edit.flip-vertical', 'Flip vertical', 'flip-vertical-2', { iconOnly: true })}</div></div>`;
  return section('layer-transform', 'Transform', body);
}

/** Position and uniform size of a group or several layers, from their
 * combined frame; flips turn them all. */
export function frameSection(e: Editor, disabled: boolean) {
  const f = e.transform.selectionFrame;
  if (!f) return '';
  const unit = layerUnit(e);
  const step = unit === 'px' || unit === 'percent' ? 1 : 0.1;
  const len = (key: Axis, label: string, title: string) =>
    field({
      key: `frame.${key}`,
      label,
      title,
      value: formatLength(f[key], lengthCtx(e, key)),
      suffix: UNIT_SUFFIX[unit],
      disabled,
      step,
    });
  const body = `<div class="pf-transform">
<button type="button" class="icon-button toggle pf-link" aria-pressed="true" title="Groups and several layers scale proportionally" aria-label="Width and height keep proportions" disabled>${svg('link', 14)}</button>
${len('width', 'W', 'Width of the combined bounds')}${len('x', 'X', 'Left edge of the combined bounds')}
${len('height', 'H', 'Height of the combined bounds')}${len('y', 'Y', 'Top edge of the combined bounds')}
</div>
<div class="pf-angle"><span class="pf-note">Scales proportionally about the center.</span><div class="pf-flips">${commandButton(e, 'edit.flip-horizontal', 'Flip horizontal', 'flip-horizontal-2', { iconOnly: true })}${commandButton(e, 'edit.flip-vertical', 'Flip vertical', 'flip-vertical-2', { iconOnly: true })}</div></div>`;
  return section('layer-transform', 'Transform', body);
}

/** Show a live transform (a Free Transform drag) in the fields without committing. */
export function syncTransformFields(e: Editor, t: Layer['transform']) {
  const root = e.root.querySelector<HTMLElement>('#properties');
  if (!root) return;
  // The next panel update redraws even when its markup did not change.
  root.dataset.stale = 'true';
  for (const key of ['x', 'y', 'width', 'height', 'rotation'] as const) {
    const input = root.querySelector<HTMLInputElement>(`input[data-field="layer.${key}"]`);
    if (!input || document.activeElement === input) continue;
    const v =
      key === 'rotation' ? formatNumber(t.rotation, 2) : formatLength(t[key], lengthCtx(e, key));
    input.value = v;
    input.dataset.initial = v;
  }
}

const ALIGN: [string, string, string][] = [
  ['layer.align-left', 'Align left edges', 'align-start-vertical'],
  ['layer.align-hcenter', 'Align horizontal centers', 'align-horizontal-justify-center'],
  ['layer.align-right', 'Align right edges', 'align-end-vertical'],
  ['layer.align-top', 'Align top edges', 'align-start-horizontal'],
  ['layer.align-vcenter', 'Align vertical centers', 'align-vertical-justify-center'],
  ['layer.align-bottom', 'Align bottom edges', 'align-end-horizontal'],
];
export function alignSection(e: Editor) {
  const many = e.selectedIds.size >= 3;
  const single = e.selectedIds.size === 1;
  const body = `<div class="pf-icons" role="group" aria-label="Align">${ALIGN.map(([id, label, icon]) => commandButton(e, id, label, icon, { iconOnly: true })).join('')}</div>
<div class="pf-icons" role="group" aria-label="Distribute">${commandButton(e, 'layer.distribute-hcenter', 'Distribute horizontal centers', 'distribute-h', { iconOnly: true })}${commandButton(e, 'layer.distribute-vcenter', 'Distribute vertical centers', 'distribute-v', { iconOnly: true })}${commandButton(e, 'layer.distribute-h-space', 'Distribute horizontal space', 'move-horizontal', { iconOnly: true })}${commandButton(e, 'layer.distribute-v-space', 'Distribute vertical space', 'move-vertical', { iconOnly: true })}</div>
${single ? '<p class="pf-note">One layer aligns to the selection, or to the canvas when nothing is selected.</p>' : commandToggle(e, 'layer.align-to-canvas', 'Align to canvas')}${!single && !many ? '<p class="pf-note">Select three or more layers to distribute them.</p>' : ''}`;
  return section('layer-align', 'Align and Distribute', body);
}

const ACTIONS: Record<string, [string, string, string][]> = {
  pixel: [
    ['layer.remove-background', 'Remove Background', 'eraser-background'],
    ['select.subject', 'Select Subject', 'scan-face'],
    ['layer.mask-from-transparency', 'Mask From Transparency', 'mask-add'],
    ['layer.embed-convert', 'Convert to Embedded Object', 'embedded-object'],
  ],
  image: [
    ['layer.remove-background', 'Remove Background', 'eraser-background'],
    ['select.subject', 'Select Subject', 'scan-face'],
    ['layer.embed-edit', 'Edit Contents', 'pen-line'],
    ['layer.embed-reset', 'Reset Transform', 'rotate-ccw'],
    ['layer.embed-to-layers', 'Convert to Layers', 'layers'],
    ['layer.embed-rasterize', 'Rasterize', 'grid-2x2'],
  ],
  vector: [
    ['layer.rasterize-shape', 'Rasterize', 'grid-2x2'],
    ['view.guides-from-shape', 'Guides From Shape', 'layout-grid'],
    ['layer.embed-convert', 'Convert to Embedded Object', 'embedded-object'],
  ],
  solid: [
    ['layer.rasterize-fill', 'Rasterize', 'grid-2x2'],
    ['layer.embed-convert', 'Convert to Embedded Object', 'embedded-object'],
  ],
  group: [
    ['layer.ungroup', 'Ungroup', 'ungroup'],
    ['layer.merge-down', 'Merge Group', 'merge'],
    ['layer.embed-convert', 'Convert to Embedded Object', 'embedded-object'],
  ],
};
export function quickActionsSection(e: Editor, l: Layer) {
  const list = (ACTIONS[l.kind] ?? []).filter(([id]) => commandExists(id));
  if (!list.length) return '';
  return section(
    `layer-actions`,
    'Quick Actions',
    `<div class="pf-actions">${list.map(([id, label, icon]) => commandButton(e, id, label, icon)).join('')}</div>`,
  );
}
const commandExists = (id: string) => !!findCommand(id);

export type LayerPropertyParts = {
  // Replace the generic Transform section (shape layers bring their own).
  transform?: string | false;
  // Extra sections before Adjustments (type sections).
  insert?: string;
  // The text shortcuts (Edit text, Character and Paragraph, Warp text).
  textButtons?: boolean;
  // The plain color row of fill and shape layers.
  color?: boolean;
  title?: string;
  // Leave out the kind icon and title (the editor shows its own).
  header?: boolean;
};

/** Markup for one selected layer. */
export function layerProperties(
  e: Editor,
  doc: PhotoDocument,
  l: Layer,
  locked: boolean,
  parts: LayerPropertyParts = {},
) {
  const ancestorLocked = layerLock(doc.layers, l.id, 'all', false);
  const implicitPixels = ['text', 'vector', 'solid'].includes(l.kind);
  const partial = (key: 'transparency' | 'composite' | 'position', label: string) => {
    const implicit = implicitPixels && key !== 'position';
    const checked = implicit || ownLock(l, key === 'composite' ? 'pixels' : key);
    return `<label class="lock-label"><input type="checkbox" data-lock="${key}" ${checked ? 'checked' : ''} ${ancestorLocked || implicit ? 'disabled' : ''}> ${label}</label>`;
  };
  const posLocked = !!layerLock(doc.layers, l.id, 'position');
  const transform =
    parts.transform === false
      ? ''
      : (parts.transform ??
        (l.kind !== 'group'
          ? transformSection(e, l, locked || posLocked)
          : frameSection(e, locked || posLocked)));
  const kindControls = isVectorGradient(l.vector?.fill)
    ? gradientProperties(l, doc)
    : isVectorPattern(l.vector?.fill)
      ? `<h3>Pattern fill</h3>${number('patternPhaseX', 'Pattern offset X (px)', l.vector!.fill.phase?.x ?? 0)}${number('patternPhaseY', 'Pattern offset Y (px)', l.vector!.fill.phase?.y ?? 0)}<label class="lock-label"><input type="checkbox" data-property="patternLinked" ${l.vector!.fill.align === false ? '' : 'checked'}> Link pattern to layer</label>`
      : parts.color !== false && (l.kind === 'solid' || l.kind === 'vector')
        ? `<label class="color-row">Color <input type="color" data-property="color" value="${l.kind === 'vector' ? vectorDisplayHex(l, doc) : l.color}"></label>`
        : '';
  const text =
    l.kind === 'text' && parts.textButtons !== false
      ? `<button data-command="type.edit" class="wide">${svg('type', 13)} Edit text</button><button data-command="type.toggle-panels" class="wide">${svg('case-upper', 13)} Character and Paragraph</button><button data-command="type.warp" class="wide">${svg('waves', 13)} Warp text</button>`
      : '';
  const adjustments = section(
    'layer-adjustments',
    'Adjustments',
    (['brightness', 'contrast', 'saturation', 'blur'] as const)
      .map(
        (k) =>
          `<label class="slider-field"><span>${k[0].toUpperCase() + k.slice(1)}<output>${l.filters[k]}</output></span><input data-filter="${k}" aria-label="${k}" type="range" min="${k === 'blur' ? 0 : -100}" max="${k === 'blur' ? 30 : 100}" value="${l.filters[k]}"></label>`,
      )
      .join(''),
    `<button data-action="reset-filters" class="pf-head-button" title="Reset adjustments" aria-label="Reset adjustments">${svg('rotate-ccw', 12)}</button>`,
  );
  return `<div class="property-body">${parts.header === false ? '' : layerTitle(l, parts.title)}<input class="layer-name-input" data-property="name" aria-label="Layer name" value="${escapeXML(l.name)}" ${locked ? 'disabled' : ''}><label class="lock-label"><input type="checkbox" data-property="locked" ${l.locked ? 'checked' : ''} ${ancestorLocked ? 'disabled' : ''}> Lock layer</label><div class="partial-locks">${partial('transparency', 'Lock transparency')}${partial('composite', 'Lock image pixels')}${partial('position', 'Lock position')}</div><fieldset ${locked ? 'disabled' : ''}>
${transform}${alignSection(e)}${text}${kindControls}${l.vector ? strokeProperties(l, doc) : ''}${parts.insert ?? ''}${ADJUSTMENTS_MARK}${adjustments}${maskSection(e, l)}${quickActionsSection(e, l)}</fieldset></div>`;
}

/** Features add mask commands to the Mask section: [command, label, icon]. */
export const maskActions: [string, string, string][] = [];
/** The Mask section: density and link of an imported mask, state, refine and apply. */
export function maskSection(e: Editor, l: Layer) {
  // Painted masks (maskGrid) are masks too, as in the Layers panel.
  const masked = hasMask(l) || !!l.maskGrid;
  const maskBody = `${l.pixelMask ? `${number('maskDensity', 'Mask density (%)', (l.pixelMask.userMaskDensity ?? 1) * 100, 0, 100)}<label class="lock-label"><input type="checkbox" data-property="maskLinked" ${l.pixelMask.positionRelativeToLayer ? '' : 'checked'}> Link mask to layer</label>` : masked && !l.vectorMask ? commandToggle(e, 'layer.mask-link', 'Link mask to layer') : ''}${
    masked
      ? `<div class="mask-info">${svg('square-dashed', 13)} ${l.maskDisabled ? 'Mask disabled' : 'Layer mask active'} <button data-action="invert-mask">Invert</button><button data-action="toggle-mask">${l.maskDisabled ? 'Enable' : 'Disable'}</button><button data-action="remove-mask" aria-label="Remove mask">${svg('x', 13)}</button></div><div class="pf-actions pf-mask-actions">${commandButton(e, 'select.mask-refine', 'Select and Mask…', 'feather')}${commandButton(e, 'layer.mask-apply', 'Apply Mask', 'check')}${maskActions
          .filter(([id]) => commandExists(id))
          .map(([id, label, icon]) => commandButton(e, id, label, icon))
          .join('')}</div>`
      : '<button data-action="mask" class="wide">Add layer mask</button>'
  }`;
  return section('layer-mask', 'Mask', maskBody);
}

/** Markup for several selected layers. */
export function multipleProperties(e: Editor, count: number) {
  return `<div class="property-body"><div class="pf-title">${svg('layers', 14)}<span class="eyebrow">MULTIPLE LAYERS</span></div><h3>${count} layers selected</h3>${frameSection(e, false)}${alignSection(e)}${section(
    'multi-actions',
    'Quick Actions',
    `<div class="pf-actions">${commandButton(e, 'edit.free-transform', 'Free Transform', 'transform-box')}<button type="button" class="pf-action" data-action="group">${svg('folder-plus', 14)}<span>Group selected layers</span></button>${commandButton(e, 'layer.merge-down', 'Merge Layers', 'merge')}${commandButton(e, 'layer.link', 'Link Layers', 'link')}</div>`,
  )}<p class="muted">Shift-click selects a range. Cmd/Ctrl-click toggles a layer.</p></div>`;
}

// ----- Transform field commits -----

function transformed(
  e: Editor,
  l: Layer,
  key: string,
  text: string,
): { t: Layer['transform'] } | string {
  const t = { ...l.transform };
  if (key === 'rotation') {
    const v = parseNumber(text, ['°', 'deg']);
    if (v === undefined) return 'Enter an angle in degrees, such as 45 or -90.';
    t.rotation = normalizeAngle(v);
    return { t };
  }
  const k = key as Axis;
  const px = parseLength(text, lengthCtx(e, k));
  if (px === undefined) return `Enter a value such as 120, 2 in or 50%.`;
  if (k === 'x' || k === 'y') t[k] = Math.round(px * 100) / 100;
  else {
    const s = linkedSize(t.width, t.height, k, clamp(px, 1, 8192), linked(e));
    t.width = clamp(Math.round(s.width * 100) / 100, 1, 8192);
    t.height = clamp(Math.round(s.height * 100) / 100, 1, 8192);
  }
  return { t };
}
const LABELS: Record<string, string> = {
  x: 'Move Layer',
  y: 'Move Layer',
  width: 'Resize Layer',
  height: 'Resize Layer',
  rotation: 'Rotate Layer',
};
fieldHandlers.set('layer', {
  commit: (e, key, text) => {
    const k = key.slice(6);
    const l = e.layer;
    if (!l || e.selectedIds.size !== 1) return;
    const r = transformed(e, findLayer(e.displayDoc.layers, l.id) ?? l, k, text);
    if (typeof r === 'string') return r;
    const same = (['x', 'y', 'width', 'height', 'rotation'] as const).every(
      (p) => Math.abs(r.t[p] - l.transform[p]) < 1e-9,
    );
    if (same && !e.transform.document) return void e.update();
    e.editLayer(LABELS[k] ?? 'Transform Layer', (x) => Object.assign(x.transform, r.t), 'position');
  },
  preview: (e, key, text) => {
    const l = e.layer;
    if (
      !l ||
      e.selectedIds.size !== 1 ||
      layerLocked(e.doc.layers, l.id) ||
      layerLock(e.doc.layers, l.id, 'position')
    )
      return;
    const r = transformed(e, l, key.slice(6), text);
    if (typeof r === 'string') return;
    const doc = structuredClone(e.doc);
    Object.assign(findLayer(doc.layers, l.id)!.transform, r.t);
    e.preview(doc);
  },
  cancel: (e) => e.preview(e.displayDoc),
});

fieldHandlers.set('frame', {
  commit: (e, key, text) => {
    const k = key.slice(6) as Axis;
    const f = e.transform.selectionFrame;
    if (!f) return;
    const px = parseLength(text, lengthCtx(e, k));
    if (px === undefined) return 'Enter a value such as 120, 2 in or 50%.';
    const next = { x: f.x, y: f.y, width: f.width, height: f.height };
    if (k === 'x' || k === 'y') next[k] = Math.round(px * 100) / 100;
    else {
      const s = linkedSize(f.width, f.height, k, clamp(px, 1, 30000), true);
      // Uniform scaling about the center keeps the frame centered.
      next.x = f.x + (f.width - s.width) / 2;
      next.y = f.y + (f.height - s.height) / 2;
      next.width = s.width;
      next.height = s.height;
    }
    if (['x', 'y', 'width', 'height'].every((p) => Math.abs(next[p as Axis] - f[p as Axis]) < 1e-9))
      return void e.update();
    e.transform.setFrame(next, k === 'x' || k === 'y' ? 'Move Layers' : 'Resize Layers');
  },
});

/** Handle a click on a layer control; true when it was one. */
export function layerClick(e: Editor, target: HTMLElement): boolean {
  if (target.closest('[data-pf-link="layer"]')) {
    e.settings.propertiesLayerLinked = !linked(e);
    e.update();
    return true;
  }
  return false;
}
