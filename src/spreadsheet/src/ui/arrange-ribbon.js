/**
 * The Arrange group (Page Layout ▸ Arrange, and the Format tab of a selected chart): the stacking order,
 * the Selection Pane, Align, Group and Rotate for the drawing objects selected on the sheet. The ribbon's
 * descriptor shape is described in ribbon.js: `resolve` returns the item a button runs or the menu it opens.
 */
import { lazySubmenu } from './menu.js';
import { withGroups, canRotate } from '../core/arrange.js';
import { t, tSource } from '../i18n/index.js';

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

/**
 * A ribbon descriptor's names from the catalog `key`: its label, and `keytip`, the English its key tip is worked
 * out from (see keytips.js), so it is the same in every language.
 */
const naming = (key) => ({ label: t(key), ariaLabel: t(key), keytip: tSource(key) });
/** A command button acting on the objects selected. */
const item = (key, glyph, cmd, arg, need = off) => {
  const n = naming(key);
  return { ...n, glyph, resolve: (menus, ctx) => ({ label: n.label, icon: glyph, cmd, arg, disabled: need(selection(ctx)) }) };
};
/** A menu item acting on the objects selected. */
const entry = (key, glyph, cmd, arg, disabled) => ({ label: t(key), icon: glyph, cmd, arg, disabled });

const forwardMenu = (menus, ctx) => {
  const s = selection(ctx);
  return [entry('arrangeRibbon.bringForward', 'bringForward', 'orderObject', { where: 'forward' }, off(s)), entry('arrangeRibbon.bringToFront', 'bringForward', 'orderObject', { where: 'front' }, off(s))];
};
const backwardMenu = (menus, ctx) => {
  const s = selection(ctx);
  return [entry('arrangeRibbon.sendBackward', 'sendBackward', 'orderObject', { where: 'backward' }, off(s)), entry('arrangeRibbon.sendToBack', 'sendBackward', 'orderObject', { where: 'back' }, off(s))];
};

/** Align's menu: the six alignments, the two distributions, and the snapping switches. */
export function alignMenu(ctx) {
  const s = selection(ctx), f = flags(ctx);
  // A group aligns and distributes as one object (see Workbook.alignObjects): one group alone has nothing to line up with.
  const units = new Set(s.objects.map((o) => o.group || o.id)).size;
  const align = (key, how, glyph) => entry(key, glyph, 'alignObjects', how, off(s) || units < 2);
  return [
    align('arrangeRibbon.alignLeft', 'left', 'alignObjects'), align('arrangeRibbon.alignCenter', 'center', 'alignCenter'), align('arrangeRibbon.alignRight', 'right', 'alignRight'),
    { separator: true },
    align('arrangeRibbon.alignTop', 'top', 'valignTop'), align('arrangeRibbon.alignMiddle', 'middle', 'valignMiddle'), align('arrangeRibbon.alignBottom', 'bottom', 'valignBottom'),
    { separator: true },
    entry('arrangeRibbon.distributeHorizontally', 'distributeH', 'alignObjects', 'horizontal', off(s) || units < 3),
    entry('arrangeRibbon.distributeVertically', 'distributeV', 'alignObjects', 'vertical', off(s) || units < 3),
    { separator: true },
    { label: t('arrangeRibbon.snapToGrid'), cmd: 'snapObjects', arg: 'grid', checked: !!f.snapGrid, hint: t('arrangeRibbon.snapToGridHint') },
    { label: t('arrangeRibbon.snapToShape'), cmd: 'snapObjects', arg: 'shape', checked: !!f.snapShape, hint: t('arrangeRibbon.snapToShapeHint') },
    { label: t('arrangeRibbon.viewGridlines'), cmd: 'gridlines', checked: f.gridlines !== false },
  ];
}

const groupMenu = (ctx) => {
  const s = selection(ctx);
  return [
    entry('arrangeRibbon.group', 'groupObjects', 'groupObjects', 'group', s.busy || s.locked || !s.canGroup),
    entry('arrangeRibbon.regroup', 'groupObjects', 'groupObjects', 'regroup', s.busy || s.locked || !s.canRegroup),
    entry('arrangeRibbon.ungroup', 'ungroup', 'groupObjects', 'ungroup', s.busy || s.locked || !s.grouped),
  ];
};

const rotateMenu = (ctx) => {
  const s = selection(ctx), no = s.busy || s.locked || !s.rotatable;
  return [
    entry('arrangeRibbon.rotateRight90', 'rotateObjects', 'rotateObjects', 'right', no),
    entry('arrangeRibbon.rotateLeft90', 'rotateLeft', 'rotateObjects', 'left', no),
    entry('arrangeRibbon.flipVertical', 'flipV', 'rotateObjects', 'flipV', no),
    entry('arrangeRibbon.flipHorizontal', 'flipH', 'rotateObjects', 'flipH', no),
  ];
};

const menu = (key, glyph, build) => {
  const n = naming(key);
  return { ...n, glyph, resolve: (menus, ctx) => lazySubmenu({ label: n.label }, () => build(ctx)) };
};

/**
 * The group, as [name, ...descriptors]; `large` gives the first buttons the large size Page Layout uses. The name is
 * the group's id, in English: the ribbon shows its own name for it (see groupNaming in ribbon.js).
 */
export function arrangeGroup({ large = true } = {}) {
  const big = (d) => (large ? { ...d, large: true } : d);
  return ['Arrange',
    big({ ...item('arrangeRibbon.bringForward', 'bringForward', 'orderObject', { where: 'forward' }), split: forwardMenu }),
    big({ ...item('arrangeRibbon.sendBackward', 'sendBackward', 'orderObject', { where: 'backward' }), split: backwardMenu }),
    big({ ...naming('arrangeRibbon.selectionPane'), glyph: 'selectionPane',
      resolve: (menus, ctx) => ({ label: t('arrangeRibbon.selectionPane'), cmd: 'selectionPane', checked: !!flags(ctx).selectionPane, disabled: !!flags(ctx).editing }) }),
    menu('arrangeRibbon.align', 'alignObjects', alignMenu),
    menu('arrangeRibbon.group', 'groupObjects', groupMenu),
    menu('arrangeRibbon.rotate', 'rotateObjects', rotateMenu),
  ];
}

/** The objects a command acts on: those named, or else the ones selected, widened to whole groups. */
export function arrangeTargets(ctx, ids) {
  const sheet = ctx.wb.sheet(ctx.sheetId());
  return sheet ? withGroups(sheet.charts, ids?.length ? ids : ctx.grid.selectedCharts || []) : [];
}
