/**
 * The Picture Format tab, shown while a floating picture is selected: Adjust (Corrections, Color,
 * Transparency, Reset Picture), Picture Styles, Alt Text, Arrange with Place in Cell, and Size (Crop
 * and the picture's height and width). Every command runs `pictureFormat` (see ui/pictures.js) on the
 * pictures selected; the descriptor shape is ribbon.js's (`resolve` returns the item a button runs or
 * the menu it opens, `element` builds a control in place).
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { closeMenu, lazySubmenu } from './menu.js';
import { arrangeGroup } from './arrange-ribbon.js';
import { pictureNode } from './picture.js';
import { CORRECTION_STEPS, TRANSPARENCY_STEPS, PICTURE_STYLES, CROP_ASPECTS, percent, pictureStyleOf, pictureFrameCss } from '../core/picture-format.js';

const flags = (ctx) => ctx?.flags?.() || {};
/** The picture the tab acts on: the selected one (the first selected, among several). */
export function activePicture(ctx) {
  const sheetId = ctx.sheetId?.(), id = ctx.grid?.selectedChart;
  const obj = id ? ctx.wb.chartById(sheetId, id) : null;
  return obj?.type === 'image' ? obj : null;
}
const cannotEdit = (ctx) => !!flags(ctx).editing || !activePicture(ctx) || !!ctx.wb.sheet(ctx.sheetId())?.protected;
const run = (ctx, arg) => ctx.run('pictureFormat', arg);

/** A grid of preview tiles in a menu: each a small copy of the picture with a change shown on it. */
function previewGrid(label, tiles, columns) {
  const grid = el('div.chart-gallery-grid.picture-gallery', { role: 'group', 'aria-label': label, style: { gridTemplateColumns: `repeat(${columns}, auto)` } },
    ...tiles.map((t) => el('button.chart-gallery-tile.picture-tile', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(!!t.checked), tabindex: -1, title: t.label, 'aria-label': t.label,
      onclick: () => { closeMenu(); t.onPick(); },
    }, el('span.picture-tile-preview', { 'aria-hidden': 'true' }, t.node))));
  grid.addEventListener('keydown', (e) => {
    const list = [...grid.querySelectorAll('button')], at = list.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[e.key];
    if (at < 0 || !step) return;
    const next = list[at + step];
    if (next) { e.preventDefault(); e.stopPropagation(); next.focus(); }
  });
  return grid;
}

/** The picture drawn small with `patch` applied, framed as its style would frame it. */
function thumb(obj, patch = {}, size = 58) {
  const next = { ...obj, ...patch, decorative: true };
  const k = Math.min(size / obj.w, size / obj.h);
  const frame = el('span.picture-thumb', { style: { width: `${Math.max(8, obj.w * k)}px`, height: `${Math.max(8, obj.h * k)}px`, ...pictureFrameCss(next, k * 1.6) } });
  if (next.shape) frame.style.overflow = 'hidden';
  frame.append(pictureNode(next));
  return frame;
}

function correctionsMenu(ctx) {
  const obj = activePicture(ctx);
  if (!obj) return [];
  const now = obj.adjust || { brightness: 0, contrast: 0 };
  const tiles = [];
  for (const contrast of [...CORRECTION_STEPS].reverse()) for (const brightness of CORRECTION_STEPS) {
    tiles.push({ label: `Brightness ${percent(brightness)}, contrast ${percent(contrast)}${!brightness && !contrast ? ' (Normal)' : ''}`,
      checked: Math.abs((now.brightness || 0) - brightness) < 1e-6 && Math.abs((now.contrast || 0) - contrast) < 1e-6,
      node: thumb(obj, { adjust: brightness || contrast ? { brightness, contrast } : null }),
      onPick: () => run(ctx, { action: 'adjust', adjust: { brightness, contrast } }) });
  }
  return [{ header: 'Brightness and Contrast' }, { custom: previewGrid('Brightness and Contrast', tiles, 5) },
    { separator: true }, { label: 'Picture Corrections Options…', icon: 'sliders', cmd: 'pictureFormat', arg: { action: 'correctionsDialog' } }];
}

function colorMenu(ctx) {
  const obj = activePicture(ctx);
  if (!obj) return [];
  return [{ header: 'Recolor' }, { custom: previewGrid('Recolor', [
    { label: 'Original Color', checked: !obj.recolor, node: thumb(obj, { recolor: null }), onPick: () => run(ctx, { action: 'recolor', recolor: null }) },
    { label: 'Grayscale', checked: obj.recolor === 'grayscale', node: thumb(obj, { recolor: 'grayscale' }), onPick: () => run(ctx, { action: 'recolor', recolor: 'grayscale' }) },
  ], 2) }];
}

function transparencyMenu(ctx) {
  const obj = activePicture(ctx);
  if (!obj) return [];
  return [{ custom: previewGrid('Transparency', TRANSPARENCY_STEPS.map((t) => ({
    label: `Transparency ${Math.round(t * 100)}%`, checked: Math.abs((obj.transparency || 0) - t) < 0.005,
    node: el('span.picture-checker', {}, thumb(obj, { transparency: t || null })), onPick: () => run(ctx, { action: 'transparency', transparency: t }),
  })), 4) }];
}

function stylesMenu(ctx) {
  const obj = activePicture(ctx);
  if (!obj) return [];
  const current = pictureStyleOf(obj);
  return [{ custom: previewGrid('Picture Styles', PICTURE_STYLES.map((s) => ({
    label: s.label, checked: current === s.id, node: thumb(obj, s.patch), onPick: () => run(ctx, { action: 'style', style: s.id }),
  })), 4) }];
}

function cropMenu(ctx) {
  const obj = activePicture(ctx);
  if (!obj) return [];
  return [
    { label: 'Crop…', icon: 'crop', cmd: 'pictureFormat', arg: { action: 'crop' } },
    { label: 'Crop to Aspect Ratio', icon: 'crop', submenu: CROP_ASPECTS.map(([kind, label, ratio]) => ({ label: `${label} ${kind === 'Square' ? '(square)' : `(${kind.toLowerCase()})`}`, cmd: 'pictureFormat', arg: { action: 'cropAspect', ratio } })) },
    { separator: true },
    { label: 'Remove Crop', cmd: 'pictureFormat', arg: { action: 'uncrop' }, disabled: !obj.srcRect && !obj.fillRect },
  ];
}

const menu = (label, glyph, build, extra = {}) => ({ label, glyph, ariaLabel: extra.ariaLabel || label, ...extra,
  resolve: (menus, ctx) => { const disabled = cannotEdit(ctx); return lazySubmenu({ label, disabled }, () => (disabled ? [] : build(ctx))); } });
const action = (label, glyph, arg, extra = {}) => ({ label, glyph, ariaLabel: extra.ariaLabel || label, ...extra,
  resolve: (menus, ctx) => ({ label, cmd: extra.cmd || 'pictureFormat', arg, disabled: cannotEdit(ctx) || !!extra.unavailable?.(ctx), hint: extra.hint }) });

/** Size: the picture's height and width in inches (96 pixels each), and whether they keep its proportions. */
function sizeFields(ctx) {
  const field = (label, key) => {
    const input = el('input.input.ribbon-control.chart-size-input', { type: 'number', min: 0.1, max: 60, step: 0.01, 'aria-label': `Picture ${label}`, tabindex: -1,
      onchange: () => { const inches = Number(input.value); if (Number.isFinite(inches) && inches > 0) run(ctx, { action: 'size', [key]: Math.round(inches * 96) }); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); input.dispatchEvent(new Event('change')); ctx.grid.focus(); } } });
    return { input, row: el('label.chart-size-field', {}, el('span', { html: icon(key === 'h' ? 'rowHeight' : 'colWidth', 16), 'aria-hidden': 'true' }), el('span.chart-size-label', {}, label), input, el('span', {}, '"')) };
  };
  const h = field('Height', 'h'), w = field('Width', 'w');
  const lock = el('input', { type: 'checkbox', tabindex: -1, 'aria-label': 'Lock aspect ratio', onchange: () => run(ctx, { action: 'lockAspect', on: lock.checked }) });
  const lockRow = el('label.chart-size-field.picture-lock', { title: 'Height and width change together' }, lock, el('span.chart-size-label', {}, 'Lock aspect ratio'));
  const sync = () => {
    const obj = activePicture(ctx), off = !obj || cannotEdit(ctx);
    for (const [f, key] of [[h, 'h'], [w, 'w']]) {
      f.input.disabled = off;
      if (document.activeElement !== f.input) f.input.value = obj ? (obj[key] / 96).toFixed(2) : '';
    }
    lock.disabled = off;
    lock.checked = !!obj && obj.lockAspect !== false;
  };
  sync();
  return Object.assign(el('div.chart-size-fields', {}, h.row, w.row, lockRow), { refresh: sync });
}

export function pictureFormatGroups() {
  return [
    ['Adjust',
      { ...menu('Corrections', 'corrections', correctionsMenu), large: true },
      menu('Color', 'pictureColor', colorMenu),
      menu('Transparency', 'transparency', transparencyMenu),
      { label: 'Reset Picture', glyph: 'resetPicture', ariaLabel: 'Reset Picture',
        resolve: (menus, ctx) => ({ label: 'Reset Picture', cmd: 'pictureFormat', arg: { action: 'reset' }, disabled: cannotEdit(ctx) }),
        split: (menus, ctx) => [
          { label: 'Reset Picture', icon: 'resetPicture', cmd: 'pictureFormat', arg: { action: 'reset' }, disabled: cannotEdit(ctx) },
          { label: 'Reset Picture & Size', cmd: 'pictureFormat', arg: { action: 'resetSize' }, disabled: cannotEdit(ctx) },
        ] }],
    ['Picture Styles', { ...menu('Picture Styles', 'pictureStyles', stylesMenu, { ariaLabel: 'Picture Styles' }), large: true }],
    ['Accessibility', { ...action('Alt Text', 'altText', null, { cmd: 'altText' }), large: true }],
    [...arrangeGroup({ large: false }), action('Place in Cell', 'placeInCell', null, { cmd: 'placeObjectInCell', hint: 'Put the picture in the cell under its top-left corner' })],
    ['Size', { ...menu('Crop', 'crop', cropMenu), large: true }, { label: 'Size', element: sizeFields }],
  ];
}
