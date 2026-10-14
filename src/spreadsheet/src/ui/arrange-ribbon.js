/**
 * The Arrange group (Page Layout ▸ Arrange, and the Format tab of a selected chart): the stacking order,
 * the Selection Pane, Align, Group and Rotate for the drawing objects selected on the sheet. The ribbon's
 * descriptor shape is described in ribbon.js: `resolve` returns the item a button runs or the menu it opens.
 */
import { lazySubmenu } from './menu.js';
import { withGroups, canRotate } from '../core/arrange.js';

const flags = (ctx) => ctx?.flags?.() || {};
/** The objects selected on the sheet, and what the Arrange commands can do with them. */
function selection(ctx) {
  const ids = ctx?.grid?.selectedCharts || [];
  const sheet = ctx?.wb?.sheet(ctx.sheetId?.());
  const objects = ids.map((id) => sheet?.charts.find((o) => o.id === id)).filter(Boolean);
  const units = new Set(objects.map((o) => o.group || o.id));
  return {
    ids, objects, locked: !!sheet?.protected, busy: !!flags(ctx).editing,
    canGroup: units.size > 1, grouped: objects.some((o) => o.group),
    canRegroup: !!sheet && !!ctx.wb.canRegroup?.(sheet.id),
    rotatable: objects.some(canRotate), all: sheet?.charts || [],
  };
}
const off = (s) => s.busy || s.locked || !s.ids.length;

/** A command button or menu item acting on the objects selected. */
const item = (label, glyph, cmd, arg, need = off) => ({ label, glyph, ariaLabel: label,
  resolve: (menus, ctx) => ({ label, icon: glyph, cmd, arg, disabled: need(selection(ctx)) }) });
const entry = (label, glyph, cmd, arg, disabled) => ({ label, icon: glyph, cmd, arg, disabled });

const forwardMenu = (menus, ctx) => {
  const s = selection(ctx);
  return [entry('Bring Forward', 'bringForward', 'orderObject', { where: 'forward' }, off(s)), entry('Bring to Front', 'bringForward', 'orderObject', { where: 'front' }, off(s))];
};
const backwardMenu = (menus, ctx) => {
  const s = selection(ctx);
  return [entry('Send Backward', 'sendBackward', 'orderObject', { where: 'backward' }, off(s)), entry('Send to Back', 'sendBackward', 'orderObject', { where: 'back' }, off(s))];
};

/** Align's menu: the six alignments, the two distributions, and the snapping switches. */
export function alignMenu(ctx) {
  const s = selection(ctx), f = flags(ctx);
  const units = new Set(s.objects.map((o) => o.group || o.id)).size;
  const align = (label, how, glyph) => entry(label, glyph, 'alignObjects', how, off(s) || s.ids.length < 2);
  return [
    align('Align Left', 'left', 'alignObjects'), align('Align Center', 'center', 'alignCenter'), align('Align Right', 'right', 'alignRight'),
    { separator: true },
    align('Align Top', 'top', 'valignTop'), align('Align Middle', 'middle', 'valignMiddle'), align('Align Bottom', 'bottom', 'valignBottom'),
    { separator: true },
    entry('Distribute Horizontally', 'distributeH', 'alignObjects', 'horizontal', off(s) || units < 3 && s.ids.length < 3),
    entry('Distribute Vertically', 'distributeV', 'alignObjects', 'vertical', off(s) || units < 3 && s.ids.length < 3),
    { separator: true },
    { label: 'Snap to Grid', cmd: 'snapObjects', arg: 'grid', checked: !!f.snapGrid, hint: 'Line up with cell edges (Alt: free)' },
    { label: 'Snap to Shape', cmd: 'snapObjects', arg: 'shape', checked: !!f.snapShape, hint: 'Line up with other objects' },
    { label: 'View Gridlines', cmd: 'gridlines', checked: f.gridlines !== false },
  ];
}

const groupMenu = (ctx) => {
  const s = selection(ctx);
  return [
    entry('Group', 'groupObjects', 'groupObjects', 'group', s.busy || s.locked || !s.canGroup),
    entry('Regroup', 'groupObjects', 'groupObjects', 'regroup', s.busy || s.locked || !s.canRegroup),
    entry('Ungroup', 'ungroup', 'groupObjects', 'ungroup', s.busy || s.locked || !s.grouped),
  ];
};

const rotateMenu = (ctx) => {
  const s = selection(ctx), no = s.busy || s.locked || !s.rotatable;
  return [
    entry('Rotate Right 90°', 'rotateObjects', 'rotateObjects', 'right', no),
    entry('Rotate Left 90°', 'rotateLeft', 'rotateObjects', 'left', no),
    entry('Flip Vertical', 'flipV', 'rotateObjects', 'flipV', no),
    entry('Flip Horizontal', 'flipH', 'rotateObjects', 'flipH', no),
  ];
};

const menu = (label, glyph, build) => ({ label, glyph, ariaLabel: label,
  resolve: (menus, ctx) => lazySubmenu({ label }, () => build(ctx)) });

/** The group, as [name, ...descriptors]; `large` gives the first buttons the large size Page Layout uses. */
export function arrangeGroup({ large = true } = {}) {
  const big = (d) => (large ? { ...d, large: true } : d);
  return ['Arrange',
    big({ ...item('Bring Forward', 'bringForward', 'orderObject', { where: 'forward' }), split: forwardMenu }),
    big({ ...item('Send Backward', 'sendBackward', 'orderObject', { where: 'backward' }), split: backwardMenu }),
    big({ label: 'Selection Pane', glyph: 'selectionPane', ariaLabel: 'Selection Pane',
      resolve: (menus, ctx) => ({ label: 'Selection Pane', cmd: 'selectionPane', checked: !!flags(ctx).selectionPane, disabled: !!flags(ctx).editing }) }),
    menu('Align', 'alignObjects', alignMenu),
    menu('Group', 'groupObjects', groupMenu),
    menu('Rotate', 'rotateObjects', rotateMenu),
  ];
}

/** The objects a command acts on: those named, or else the ones selected, widened to whole groups. */
export function arrangeTargets(ctx, ids) {
  const sheet = ctx.wb.sheet(ctx.sheetId());
  return sheet ? withGroups(sheet.charts, ids?.length ? ids : ctx.grid.selectedCharts || []) : [];
}
