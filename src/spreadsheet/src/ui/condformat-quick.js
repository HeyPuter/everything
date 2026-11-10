/**
 * The Conditional Formatting drop-down: quick rules (highlight cells, top and
 * bottom, above or below average), data bars, color scales and icon sets for
 * the selection, clearing rules from the selection or the sheet, and the full
 * rules manager. Every rule is an ordinary workbook rule, so it saves, undoes
 * and exports as one made in the rules manager.
 */

import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { cellName, rangeName } from '../core/cell.js';
import { ICON_SETS, DATE_PERIODS } from '../core/condformat.js';
import { CELL_STYLES } from '../core/cellstyles.js';
import { numberOf, equalValueOf, ruleValueText } from './condformat.js';
import { dateTimeKind } from '../core/format.js';
import { t } from '../i18n/index.js';

/** Rows whose label (the element at `at`) is in the interface language each time it is read. */
const labelled = (rows, at, keys) => rows.map((row, i) => Object.defineProperty(row, at, { get: () => t(keys[i]), enumerable: true }));

const styleOf = key => ({ ...CELL_STYLES.find(s => s.key === key)?.patch });
/** Formats a quick rule can apply, drawn from the app's own Good, Bad and Neutral cell styles: [key, message key, style]. */
export const QUICK_STYLES = [
  ['bad', 'condformatQuick.style.bad', () => styleOf('bad')],
  ['neutral', 'condformatQuick.style.neutral', () => styleOf('neutral')],
  ['good', 'condformatQuick.style.good', () => styleOf('good')],
  ['redFill', 'condformatQuick.style.redFill', () => ({ bg: styleOf('bad').bg })],
  ['redText', 'condformatQuick.style.redText', () => ({ color: styleOf('bad').color })],
  ['bold', 'condformatQuick.style.bold', () => ({ bold: true })],
];

/** The quick rules: `title`, `prompt` and `menu` are message keys (the dialog's title and prompt, the menu item). */
export const QUICK_RULES = {
  gt: { title: 'condformatQuick.rule.gt', prompt: 'condformatQuick.prompt.gt', menu: 'condformatQuick.menu.gt', type: 'gt', args: 1, numeric: true },
  lt: { title: 'condformatQuick.rule.lt', prompt: 'condformatQuick.prompt.lt', menu: 'condformatQuick.menu.lt', type: 'lt', args: 1, numeric: true },
  between: { title: 'condformatQuick.rule.between', prompt: 'condformatQuick.prompt.between', menu: 'condformatQuick.menu.between', type: 'between', args: 2, numeric: true },
  eq: { title: 'condformatQuick.rule.eq', prompt: 'condformatQuick.prompt.eq', menu: 'condformatQuick.menu.eq', type: 'eq', args: 1 },
  contains: { title: 'condformatQuick.rule.contains', prompt: 'condformatQuick.prompt.contains', menu: 'condformatQuick.menu.contains', type: 'contains', args: 1 },
  date: { title: 'condformatQuick.rule.date', prompt: 'condformatQuick.prompt.date', menu: 'condformatQuick.menu.date', type: 'date', args: 0, date: true },
  dup: { title: 'condformatQuick.rule.dup', prompt: 'condformatQuick.prompt.dup', menu: 'condformatQuick.menu.dup', type: 'dup', args: 0, choice: [['dup', 'condformatQuick.choice.dup'], ['unique', 'condformatQuick.choice.unique']] },
  top: { title: 'condformatQuick.rule.top', prompt: 'condformatQuick.prompt.top', menu: 'condformatQuick.menu.top', type: 'top', args: 1, numeric: true, count: true },
  bottom: { title: 'condformatQuick.rule.bottom', prompt: 'condformatQuick.prompt.bottom', menu: 'condformatQuick.menu.bottom', type: 'bottom', args: 1, numeric: true, count: true },
  topPercent: { title: 'condformatQuick.rule.topPercent', prompt: 'condformatQuick.prompt.topPercent', menu: 'condformatQuick.menu.topPercent', type: 'top', args: 1, numeric: true, count: true, percent: true },
  bottomPercent: { title: 'condformatQuick.rule.bottomPercent', prompt: 'condformatQuick.prompt.bottomPercent', menu: 'condformatQuick.menu.bottomPercent', type: 'bottom', args: 1, numeric: true, count: true, percent: true },
  above: { title: 'condformatQuick.rule.above', prompt: 'condformatQuick.prompt.above', menu: 'condformatQuick.menu.above', type: 'formula', args: 0, average: '>' },
  below: { title: 'condformatQuick.rule.below', prompt: 'condformatQuick.prompt.below', menu: 'condformatQuick.menu.below', type: 'formula', args: 0, average: '<' },
};

const BAR_COLORS = [['condformatQuick.bar.blue', '#8fb8ff'], ['condformatQuick.bar.green', '#9fdcb4'], ['condformatQuick.bar.orange', '#ffd58a'], ['condformatQuick.bar.red', '#f6a6a6'], ['condformatQuick.bar.purple', '#c9b8f5'], ['condformatQuick.bar.gray', '#c3c2b7']];
/** The color scale presets: [name, low, middle (or null), high]. */
export const SCALES = labelled([
  ['', '#63be7b', '#ffeb84', '#f8696b'], ['', '#f8696b', '#ffeb84', '#63be7b'],
  ['', '#63be7b', '#fcfcff', '#f8696b'], ['', '#f8696b', '#fcfcff', '#63be7b'],
  ['', '#5a8ac6', '#fcfcff', '#f8696b'], ['', '#fcfcff', null, '#63be7b'],
  ['', '#63be7b', null, '#fcfcff'], ['', '#fcfcff', null, '#f8696b'],
], 0, [
  'condformatQuick.scale.gyr', 'condformatQuick.scale.ryg', 'condformatQuick.scale.gwr', 'condformatQuick.scale.rwg', 'condformatQuick.scale.bwr', 'condformatQuick.scale.wg', 'condformatQuick.scale.gw', 'condformatQuick.scale.wr',
]);

/** The menu's items; `run` reaches the editor's commands. */
export function conditionalFormattingItems(run) {
  const quick = key => ({ label: t(QUICK_RULES[key].menu), onSelect: () => run('quickRule', key) });
  return [
    { label: t('condformatQuick.highlightRules'), icon: 'highlighter', submenu: ['gt', 'lt', 'between', 'eq', 'contains', 'date', 'dup'].map(quick) },
    { label: t('condformatQuick.topBottomRules'), icon: 'sortDesc', submenu: ['top', 'topPercent', 'bottom', 'bottomPercent', 'above', 'below'].map(quick) },
    { label: t('condformatQuick.dataBars'), icon: 'chartBar', submenu: BAR_COLORS.map(([labelKey, color]) => ({ label: t(labelKey), swatch: color, onSelect: () => run('quickRule', { kind: 'databar', barColor: color }) })) },
    { label: t('condformatQuick.colorScales'), icon: 'palette', submenu: SCALES.map(([label, from, mid, to]) => ({ label, swatch: from, onSelect: () => run('quickRule', { kind: 'scale', from, mid, to }) })) },
    { label: t('condformatQuick.iconSets'), icon: 'sparkle', submenu: Object.entries(ICON_SETS).map(([set, def]) => ({ label: t('condformatQuick.iconSetItem', { name: def.label, glyphs: def.glyphs.join(' ') }), onSelect: () => run('quickRule', { kind: 'icons', set }) })) },
    { separator: true },
    { label: t('condformatQuick.newRule'), icon: 'plus', onSelect: () => run('condFormat') },
    { label: t('condformatQuick.clearRules'), icon: 'eraser', submenu: [
      { label: t('condformatQuick.clearSelection'), onSelect: () => run('clearRules', 'selection') },
      { label: t('condformatQuick.clearSheet'), onSelect: () => run('clearRules', 'sheet') },
    ] },
    { label: t('condformatQuick.manageRules'), icon: 'sliders', onSelect: () => run('condFormat') },
  ];
}

/** A rule for a one-click choice (data bar, color scale, icon set) over a range. */
export function presetRule(range, preset) {
  if (preset.kind === 'databar') return { range, type: 'databar', style: {}, barColor: preset.barColor };
  // As Excel's presets, a three-color scale's middle color marks the 50th percentile (the median), not the
  // halfway point between the extremes.
  if (preset.kind === 'scale') return { range, type: 'scale', style: {}, from: preset.from, to: preset.to, ...(preset.mid ? { mid: preset.mid, scaleMidType: 'percentile', scaleMid: '50' } : {}) };
  if (preset.kind === 'icons') return { range, type: 'icons', style: {}, set: preset.set, lo: 33, hi: 67 };
  return null;
}

/**
 * A quick rule from the dialog's choices. Above and below average are formulas for the range's top-left cell;
 * as in Excel they format numbers only, never text or blank cells.
 */
export function quickRule(range, key, { value = '', value2 = '', choice = null, style = {} } = {}) {
  const def = QUICK_RULES[key];
  if (def.average) {
    const abs = rangeName(range).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');
    const cell = cellName(range.r1, range.c1);
    return { range, type: 'formula', value: `AND(ISNUMBER(${cell}),${cell}${def.average}AVERAGE(${abs}))`, style };
  }
  const type = def.choice ? choice || def.type : def.type;
  const number = v => (def.numeric ? Number(v) : v);
  return {
    range, type, style,
    ...(def.percent ? { percent: true } : {}),
    ...(def.args >= 1 || def.date ? { value: def.date ? value : number(value) } : {}),
    ...(def.args >= 2 ? { value2: number(value2) } : {}),
  };
}

/**
 * Numbers in a range, for the values a quick rule suggests first. Only the cells holding something are read, as
 * the rules themselves read them: walking every coordinate froze the tab for seconds over a few whole columns
 * selected, and for an hour over the whole sheet.
 */
function numbersIn(wb, sheetId, range) {
  const out = [];
  const sheet = wb.sheet(sheetId);
  if (!sheet) return out;
  for (const v of wb._rangeValues(sheet, range)) {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    if (out.length >= 5000) break;
  }
  return out;
}
const round = n => Math.round(n * 100) / 100;

/** The small dialog for a quick rule: its value(s) and the format to apply. Returns the modal. */
export function openQuickRuleDialog(ctx, key, range) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const def = QUICK_RULES[key];
  const nums = numbersIn(wb, sheetId, range);
  const min = nums.length ? Math.min(...nums) : 0, max = nums.length ? Math.max(...nums) : 0;
  const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  // Suggested numbers are written, and typed ones read, in the regional format, as the rules manager does; over
  // dates they are whole days, written as dates as the rules manager lists them.
  const dated = ['date', 'datetime'].includes(dateTimeKind(wb.displayStyleAt?.(sheetId, range.r1, range.c1), avg));
  const suggest = (n) => ruleValueText(dated ? Math.round(n) : round(n), wb, sheetId, { type: def.type, range });
  const first = def.count ? '10' : key === 'between' ? suggest(min) : def.numeric ? suggest(avg) : '';
  const title = t(def.title);
  const value1 = el('input.input', { type: 'text', 'aria-label': title, value: first, autocomplete: 'off', spellcheck: false });
  const value2 = el('input.input', { type: 'text', 'aria-label': t('condformat.and'), value: suggest(max), autocomplete: 'off', spellcheck: false });
  const period = el('select.select', { 'aria-label': title }, ...DATE_PERIODS.map(p => el('option', { value: p.value }, p.label)));
  const choice = el('select.select', { 'aria-label': t('condformatQuick.values') }, ...(def.choice || []).map(([value, labelKey]) => el('option', { value }, t(labelKey))));
  const format = el('select.select', { 'aria-label': t('condformatQuick.with') }, ...QUICK_STYLES.map(([value, labelKey]) => el('option', { value }, t(labelKey))));
  const { alert: error, refuse } = fieldAlert(fieldId('cfq'));
  const submit = e => {
    e?.preventDefault();
    if (def.args >= 1 && !value1.value.trim()) return refuse(value1, t('condformat.enterValue'));
    const n1 = def.numeric && def.args >= 1 ? numberOf(value1.value) : null, n2 = def.args >= 2 ? numberOf(value2.value) : null;
    if (def.numeric && def.args >= 1 && n1 == null) return refuse(value1, t('condformat.enterNumber'));
    const most = def.percent ? 100 : 1000;
    if (def.count && !(Number.isInteger(n1) && n1 >= 1 && n1 <= most)) return refuse(value1, t('condformatQuick.wholeNumber', { max: most }));
    if (def.args >= 2 && n2 == null) return refuse(value2, t('condformat.enterNumber'));
    const style = QUICK_STYLES.find(([k]) => k === format.value)[2]();
    const value = def.date ? period.value : def.numeric ? n1 : def.type === 'eq' ? equalValueOf(value1.value) : value1.value.trim();
    const rule = quickRule(range, key, { value, value2: n2, choice: choice.value, style });
    if (!wb.addRule(sheetId, rule)) return refuse(def.args ? value1 : format, wb.isProtected(sheetId) ? t('condformatQuick.protected') : t('condformatQuick.notAdded'));
    modal.close();
  };
  const fields = def.date ? [period] : def.choice ? [choice] : def.args >= 2 ? [value1, el('span.cfq-and', {}, t('condformat.and')), value2] : def.percent ? [value1, el('span.cfq-and', {}, '%')] : def.args ? [value1] : [];
  const content = el('form.cfq', { onsubmit: submit },
    el('p.cfq-prompt', {}, t(def.prompt)),
    el('div.cfq-row', {}, ...fields, el('span.cfq-with', {}, def.choice ? t('condformatQuick.valuesWith') : t('condformatQuick.with')), el('div.select-wrap', {}, format)),
    el('p.field-hint', {}, t('condformatQuick.appliesTo', { range: rangeName(range) })), error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title, content, className: 'cfq-dialog', initialFocus: fields[0] || format, onClose: () => ctx.grid?.focus?.() });
  if (fields[0]?.select) fields[0].select();
  return modal;
}

// Clearing rules is the workbook's own business now, kept with the rule groups; these names stay for the menus.
export { subtractRange, clearRules } from '../core/conditional-groups.js';
