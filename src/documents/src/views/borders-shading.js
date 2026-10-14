import { el } from '../ui/dom.js';
import { BORDER_STYLES, checkedParagraphBorder } from '../engine/paragraph-borders.js';
import { PAGE_BORDER_SIDES } from '../engine/page-borders.js';
import { patternedFill, SHADING_PERCENTAGES } from '../engine/docx-paragraph-shading.js';
import { tabStrip, field, checkbox, group, select, openFormatDialog, colorField } from './format-dialog-kit.js';

/** Line widths in eighths of a point (w:sz), as the width list offers them. */
export const BORDER_WIDTHS = [[2, '¼ pt'], [4, '½ pt'], [6, '¾ pt'], [8, '1 pt'], [12, '1½ pt'], [18, '2¼ pt'], [24, '3 pt'], [36, '4½ pt'], [48, '6 pt']];
const PARAGRAPH_SIDES = ['top', 'bottom', 'left', 'right', 'between'];
const SIDE_NAMES = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right', between: 'Between paragraphs' };
const visible = border => !!border && !['none', 'nil'].includes(border.style) && border.size !== 0;
const PATTERNS = [['clear', 'Clear'], ['solid', 'Solid (100%)'], ...SHADING_PERCENTAGES.map(p => [p, `${p.slice(3)}%`])];

/** The flat fill a fill/pattern/pattern-color choice paints as. */
export function shadingValue(fill, pattern, color) {
  if (pattern === 'clear') return fill;
  if (pattern === 'solid') return color === 'auto' ? 'foreground' : color;
  return patternedFill(pattern, color, fill);
}

/**
 * The Border side editor shared by the Borders and Page Border tabs: setting presets, style, color, width,
 * a clickable preview and per-side toggles. sides: which sides exist. initial: { side: border }.
 */
function borderEditor({ sides, initial, presets, label, page = false }) {
  const state = Object.fromEntries(sides.map(side => [side, initial?.[side] && visible(initial[side]) ? { ...initial[side] } : null]));
  const firstVisible = Object.values(state).find(Boolean);
  const style = select(`${label} style`, Object.entries(BORDER_STYLES).filter(([v]) => v !== 'none'), firstVisible?.style || 'single');
  const width = select(`${label} width`, BORDER_WIDTHS.map(([v, t]) => [String(v), t]), String(BORDER_WIDTHS.find(([v]) => v === firstVisible?.size)?.[0] ?? (page ? 4 : 4)));
  const color = colorField(`${label} color`, firstVisible?.color || 'auto', { onchange: () => restyle() });
  const current = () => ({ style: style.value, size: Number(width.value), space: page ? 24 : 1, color: color.value });
  let touched = false;
  const toggles = {};
  const preview = el('div.fmt-border-preview', { 'aria-hidden': 'true' });
  const sample = el('div.fmt-border-sample', {}, ...(page ? [el('div.fmt-border-page-lines')] : [el('p', {}, 'Text text text text text text text'), el('p', {}, 'Text text text text text text text')]));
  const hit = side => el(`button.fmt-border-hit.is-${side}`, { type: 'button', tabindex: -1, title: SIDE_NAMES[side], onclick: () => toggle(side) });
  preview.append(sample, ...sides.map(hit));
  function paint() {
    for (const side of sides) {
      const border = state[side];
      toggles[side].setAttribute('aria-pressed', String(!!border));
      const css = border ? `${Math.max(1, Math.round(border.size / 6))}px ${border.style === 'double' ? 'double' : /dot/i.test(border.style) && !/dash/i.test(border.style) ? 'dotted' : /dash/i.test(border.style) ? 'dashed' : 'solid'} ${border.color === 'auto' ? '#000' : `#${border.color}`}` : '';
      if (side === 'between') sample.style.setProperty('--between', css || '0 none');
      else sample.style[`border${side[0].toUpperCase()}${side.slice(1)}`] = css;
    }
    for (const [name, button] of Object.entries(presetButtons)) button.setAttribute('aria-pressed', String(name === presetName()));
  }
  function toggle(side) {
    touched = true;
    state[side] = state[side] && JSON.stringify(state[side]) === JSON.stringify({ ...state[side], ...current() }) ? null : current();
    paint();
  }
  const presetName = () => {
    const on = sides.filter(s => state[s]);
    for (const [name, list] of Object.entries(presets)) if (list.length === on.length && list.every(s => on.includes(s))) return name;
    return 'custom';
  };
  const presetButtons = Object.fromEntries(Object.entries(presets).map(([name, list]) => [name, el('button.btn.btn-outline.fmt-preset', { type: 'button', 'aria-pressed': 'false', onclick: () => {
    touched = true;
    for (const side of sides) state[side] = list.includes(side) ? current() : null;
    paint();
  } }, name === 'none' ? 'None' : name === 'box' ? 'Box' : name === 'all' ? 'All' : name === 'grid' ? 'Grid' : name)]));
  // Changing style, width or color restyles the sides already on, as the preview shows.
  const restyle = () => { touched = true; for (const side of sides) if (state[side]) state[side] = { ...state[side], ...current(), space: state[side].space ?? current().space }; paint(); };
  style.addEventListener('change', restyle); width.addEventListener('change', restyle);
  const node = el('div.fmt-border-editor', {},
    el('div.fmt-border-settings', {}, el('span.field-label', {}, 'Setting'), el('div.fmt-presets', { role: 'group', 'aria-label': `${label} setting` }, ...Object.values(presetButtons))),
    el('div.fmt-border-controls', {}, field('Style', style), field('Color', color), field('Width', width)),
    el('div.fmt-border-preview-wrap', {}, el('span.field-label', {}, 'Preview — click a side or use the buttons'), preview,
      el('div.fmt-side-toggles', { role: 'group', 'aria-label': `${label} sides` }, ...sides.map(side => (toggles[side] = el('button.btn.btn-outline.btn-sm', { type: 'button', 'aria-pressed': 'false', onclick: () => toggle(side) }, SIDE_NAMES[side]))))));
  paint();
  return { node, state, touched: () => touched, current };
}

/**
 * Borders and Shading: paragraph borders, page borders and shading (fill and pattern), each in one undo
 * step. values: { paragraphBorders (null if mixed), paragraphShading, runShading, pageBorders, singleSection }.
 * apply({ paragraphBorders?, paragraphShading?, runShading?, pageBorders? }) returns false on failure.
 */
export function openBordersAndShading({ values: v, apply, onClose, initialTab = 'borders' }) {
  /* ---- Borders ---- */
  const paragraph = borderEditor({ sides: PARAGRAPH_SIDES, initial: v.paragraphBorders || {}, label: 'Border', presets: { none: [], box: ['top', 'bottom', 'left', 'right'], all: ['top', 'bottom', 'left', 'right', 'between'] } });
  const distances = Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, el('input.input', { type: 'number', min: 0, max: 31, step: 1, value: v.paragraphBorders?.[side]?.space ?? (side === 'left' || side === 'right' ? 4 : 1), 'aria-label': `${SIDE_NAMES[side]} distance from text (pt)` })]));
  const bordersPanel = el('div', {}, paragraph.node,
    group('Distance from text (pt)', el('div.fmt-grid.is-four', {}, ...Object.entries(distances).map(([side, input]) => field(SIDE_NAMES[side], input)))),
    v.paragraphBorders === null ? el('p.field-hint', {}, 'Borders differ across the selection. Changing them sets every selected paragraph.') : null,
    el('p.field-hint', {}, 'Borders apply to the selected paragraphs. Matching borders join adjacent paragraphs; Between paragraphs draws the divider.'));

  /* ---- Page Border ---- */
  const pageBorders = v.pageBorders || null;
  const pageEditor = borderEditor({ sides: PAGE_BORDER_SIDES, initial: pageBorders?.borders || {}, label: 'Page border', page: true, presets: { none: [], box: ['top', 'bottom', 'left', 'right'] } });
  const measure = select('Measure from', [['text', 'Text'], ['page', 'Edge of page']], pageBorders?.offsetFrom || 'text');
  const display = select('Apply to', [['allPages', 'Whole document'], ['firstPage', 'First page only'], ['notFirstPage', 'All except first page']], pageBorders?.display || 'allPages');
  const front = checkbox('Always display in front of text', (pageBorders?.zOrder || 'front') === 'front');
  const pageSpace = Object.fromEntries(PAGE_BORDER_SIDES.map(side => [side, el('input.input', { type: 'number', min: 0, max: 31, step: 1, value: pageBorders?.borders?.[side]?.space ?? 24, 'aria-label': `${SIDE_NAMES[side]} page border margin (pt)` })]));
  const pagePanel = el('div', {}, pageEditor.node,
    group('Options', el('div.fmt-grid', {}, field('Apply to', display), field('Measure from', measure)), front,
      el('div.fmt-grid.is-four', {}, ...PAGE_BORDER_SIDES.map(side => field(`${SIDE_NAMES[side]} (pt)`, pageSpace[side])))),
    !v.singleSection ? el('p.field-error', {}, 'This document has several sections; page borders are kept as they are.') : null,
    el('p.field-hint', {}, 'Margins are measured from the text or the page edge. Art borders are not available.'));
  if (!v.singleSection) for (const control of pagePanel.querySelectorAll('button, input, select')) control.disabled = true;

  /* ---- Shading ---- */
  const target = select('Apply shading to', [['paragraph', 'Paragraph'], ['text', 'Text']], 'paragraph');
  const initialFill = value => value === null ? null : value === 'foreground' ? 'auto' : value;
  let shadingTouched = false;
  const touchShading = () => { shadingTouched = true; paintShading(); };
  const fill = colorField('Fill', initialFill(v.paragraphShading), { reset: { value: 'auto', label: 'No Color' }, onchange: touchShading });
  const pattern = select('Pattern style', PATTERNS, v.paragraphShading === 'foreground' ? 'solid' : 'clear');
  const patternColor = colorField('Pattern color', 'auto', { onchange: touchShading });
  const swatch = el('div.fmt-shading-swatch', { 'aria-hidden': 'true' });
  function paintShading() {
    patternColor.disabled = pattern.value === 'clear';
    let value = null;
    try { value = fill.value === null ? null : shadingValue(fill.value, pattern.value, patternColor.value); } catch { value = null; }
    swatch.style.background = value === null ? '' : value === 'auto' ? '#fff' : value === 'foreground' ? '#000' : `#${value}`;
  }
  pattern.addEventListener('change', touchShading);
  target.addEventListener('change', () => {
    const current = target.value === 'text' ? v.runShading : v.paragraphShading;
    fill.set(initialFill(current)); pattern.value = current === 'foreground' ? 'solid' : 'clear'; shadingTouched = false; paintShading();
  });
  paintShading();
  const shadingPanel = el('div', {},
    group('Fill', el('div.fmt-grid', {}, field('Fill', fill), field('Apply to', target))),
    group('Patterns', el('div.fmt-grid', {}, field('Style', pattern), field('Color', patternColor))),
    el('div.fmt-shading-preview', {}, el('span.field-label', {}, 'Preview'), swatch),
    el('p.field-hint', {}, 'Patterns are saved as the solid color they paint.'));

  const tabs = tabStrip('Borders and shading', [['borders', 'Borders', bordersPanel], ['page', 'Page Border', pagePanel], ['shading', 'Shading', shadingPanel]]);
  const modal = openFormatDialog({ title: 'Borders and Shading', className: 'fmt-borders-dialog', onClose,
    body: [tabs.node, bordersPanel, pagePanel, shadingPanel],
    submit: () => {
      const patch = {};
      const spacesChanged = Object.entries(distances).some(([side, input]) => String(input.defaultValue) !== input.value);
      if (paragraph.touched() || spacesChanged) {
        const borders = {};
        for (const side of PARAGRAPH_SIDES) {
          const border = paragraph.state[side];
          borders[side] = border ? checkedParagraphBorder({ style: border.style, size: border.size, color: border.color, space: side === 'between' ? 0 : Math.round(Number(distances[side].value) || 0) }) : checkedParagraphBorder({ style: 'none' });
        }
        patch.paragraphBorders = borders;
      }
      if (v.singleSection && (pageEditor.touched() || [measure, display].some(s => s.value !== (s === measure ? pageBorders?.offsetFrom || 'text' : pageBorders?.display || 'allPages')) || front.box.checked !== ((pageBorders?.zOrder || 'front') === 'front') || PAGE_BORDER_SIDES.some(side => pageSpace[side].value !== pageSpace[side].defaultValue))) {
        const sides = Object.fromEntries(PAGE_BORDER_SIDES.filter(side => pageEditor.state[side]).map(side => [side, { ...pageEditor.state[side], space: Math.round(Number(pageSpace[side].value) || 0) }]));
        patch.pageBorders = Object.keys(sides).length ? { offsetFrom: measure.value, display: display.value, zOrder: front.box.checked ? 'front' : 'back', borders: sides } : null;
      }
      if (shadingTouched && fill.value !== null) patch[target.value === 'text' ? 'runShading' : 'paragraphShading'] = shadingValue(fill.value, pattern.value, patternColor.value);
      return Object.keys(patch).length ? apply(patch) : true;
    } });
  if (initialTab !== 'borders') tabs.show(initialTab);
  tabs.buttons[['borders', 'page', 'shading'].indexOf(initialTab)]?.focus();
  return modal;
}
