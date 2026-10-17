/**
 * The Conditional Formatting drop-down: quick rules (highlight cells, top and
 * bottom, above or below average), data bars, color scales and icon sets for
 * the selection, clearing rules from the selection or the sheet, and the full
 * rules manager. Every rule is an ordinary workbook rule, so it saves, undoes
 * and exports as one made in the rules manager.
 */

import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { cellName, rangeName, normalizeRange } from '../core/cell.js';
import { ICON_SETS, DATE_PERIODS } from '../core/condformat.js';
import { conditionalRuleGroups } from '../core/conditional-groups.js';
import { CELL_STYLES } from '../core/cellstyles.js';
import { numberOf, numberText } from './condformat.js';

const styleOf = key => ({ ...CELL_STYLES.find(s => s.key === key)?.patch });
/** Formats a quick rule can apply, drawn from the app's own Good, Bad and Neutral cell styles. */
export const QUICK_STYLES = [
  ['bad', 'Light red fill with dark red text', () => styleOf('bad')],
  ['neutral', 'Yellow fill with dark yellow text', () => styleOf('neutral')],
  ['good', 'Green fill with dark green text', () => styleOf('good')],
  ['redFill', 'Light red fill', () => ({ bg: styleOf('bad').bg })],
  ['redText', 'Red text', () => ({ color: styleOf('bad').color })],
  ['bold', 'Bold text', () => ({ bold: true })],
];

export const QUICK_RULES = {
  gt: { title: 'Greater Than', prompt: 'Format cells that are GREATER THAN:', type: 'gt', args: 1, numeric: true },
  lt: { title: 'Less Than', prompt: 'Format cells that are LESS THAN:', type: 'lt', args: 1, numeric: true },
  between: { title: 'Between', prompt: 'Format cells that are BETWEEN:', type: 'between', args: 2, numeric: true },
  eq: { title: 'Equal To', prompt: 'Format cells that are EQUAL TO:', type: 'eq', args: 1 },
  contains: { title: 'Text That Contains', prompt: 'Format cells that contain the text:', type: 'contains', args: 1 },
  date: { title: 'A Date Occurring', prompt: 'Format cells that contain a date occurring:', type: 'date', args: 0, date: true },
  dup: { title: 'Duplicate Values', prompt: 'Format cells that contain:', type: 'dup', args: 0, choice: [['dup', 'Duplicate'], ['unique', 'Unique']] },
  top: { title: 'Top 10 Items', prompt: 'Format cells that rank in the TOP:', type: 'top', args: 1, numeric: true, count: true },
  bottom: { title: 'Bottom 10 Items', prompt: 'Format cells that rank in the BOTTOM:', type: 'bottom', args: 1, numeric: true, count: true },
  above: { title: 'Above Average', prompt: 'Format cells that are ABOVE the average for the selected range:', type: 'formula', args: 0, average: '>' },
  below: { title: 'Below Average', prompt: 'Format cells that are BELOW the average for the selected range:', type: 'formula', args: 0, average: '<' },
};

const BAR_COLORS = [['Blue', '#8fb8ff'], ['Green', '#9fdcb4'], ['Orange', '#ffd58a'], ['Red', '#f6a6a6'], ['Purple', '#c9b8f5'], ['Gray', '#c3c2b7']];
export const SCALES = [
  ['Green - Yellow - Red', '#63be7b', '#ffeb84', '#f8696b'], ['Red - Yellow - Green', '#f8696b', '#ffeb84', '#63be7b'],
  ['Green - White - Red', '#63be7b', '#fcfcff', '#f8696b'], ['Red - White - Green', '#f8696b', '#fcfcff', '#63be7b'],
  ['Blue - White - Red', '#5a8ac6', '#fcfcff', '#f8696b'], ['White - Green', '#fcfcff', null, '#63be7b'],
  ['Green - White', '#63be7b', null, '#fcfcff'], ['White - Red', '#fcfcff', null, '#f8696b'],
];

/** The menu's items; `run` reaches the editor's commands. */
export function conditionalFormattingItems(run) {
  const quick = key => ({ label: `${QUICK_RULES[key].title}…`, onSelect: () => run('quickRule', key) });
  return [
    { label: 'Highlight Cells Rules', icon: 'highlighter', submenu: ['gt', 'lt', 'between', 'eq', 'contains', 'date', 'dup'].map(quick) },
    { label: 'Top/Bottom Rules', icon: 'sortDesc', submenu: ['top', 'bottom', 'above', 'below'].map(quick) },
    { label: 'Data Bars', icon: 'chartBar', submenu: BAR_COLORS.map(([label, color]) => ({ label: `${label} data bar`, swatch: color, onSelect: () => run('quickRule', { kind: 'databar', barColor: color }) })) },
    { label: 'Color Scales', icon: 'palette', submenu: SCALES.map(([label, from, mid, to]) => ({ label, swatch: from, onSelect: () => run('quickRule', { kind: 'scale', from, mid, to }) })) },
    { label: 'Icon Sets', icon: 'sparkle', submenu: Object.entries(ICON_SETS).map(([set, def]) => ({ label: `${def.label}  ${def.glyphs.join(' ')}`, onSelect: () => run('quickRule', { kind: 'icons', set }) })) },
    { separator: true },
    { label: 'New Rule…', icon: 'plus', onSelect: () => run('condFormat') },
    { label: 'Clear Rules', icon: 'eraser', submenu: [
      { label: 'Clear Rules from Selected Cells', onSelect: () => run('clearRules', 'selection') },
      { label: 'Clear Rules from Entire Sheet', onSelect: () => run('clearRules', 'sheet') },
    ] },
    { label: 'Manage Rules…', icon: 'sliders', onSelect: () => run('condFormat') },
  ];
}

/** A rule for a one-click choice (data bar, color scale, icon set) over a range. */
export function presetRule(range, preset) {
  if (preset.kind === 'databar') return { range, type: 'databar', style: {}, barColor: preset.barColor };
  if (preset.kind === 'scale') return { range, type: 'scale', style: {}, from: preset.from, to: preset.to, ...(preset.mid ? { mid: preset.mid } : {}) };
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
    ...(def.args >= 1 || def.date ? { value: def.date ? value : number(value) } : {}),
    ...(def.args >= 2 ? { value2: number(value2) } : {}),
  };
}

/** Numbers in a range, for the values a quick rule suggests first. */
function numbersIn(wb, sheetId, range) {
  const out = [];
  for (let r = range.r1; r <= range.r2 && out.length < 5000; r++) for (let c = range.c1; c <= range.c2 && out.length < 5000; c++) {
    const v = wb.getValue(sheetId, r, c);
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
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
  // Suggested numbers are written, and typed ones read, in the regional format, as the rules manager does.
  const first = def.count ? '10' : key === 'between' ? numberText(round(min)) : def.numeric ? numberText(round(avg)) : '';
  const value1 = el('input.input', { type: 'text', 'aria-label': def.title, value: first, autocomplete: 'off', spellcheck: false });
  const value2 = el('input.input', { type: 'text', 'aria-label': 'and', value: numberText(round(max)), autocomplete: 'off', spellcheck: false });
  const period = el('select.select', { 'aria-label': def.title }, ...DATE_PERIODS.map(p => el('option', { value: p.value }, p.label)));
  const choice = el('select.select', { 'aria-label': 'Values' }, ...(def.choice || []).map(([value, label]) => el('option', { value }, label)));
  const format = el('select.select', { 'aria-label': 'with' }, ...QUICK_STYLES.map(([value, label]) => el('option', { value }, label)));
  const { alert: error, refuse } = fieldAlert(fieldId('cfq'));
  const submit = e => {
    e?.preventDefault();
    if (def.args >= 1 && !value1.value.trim()) return refuse(value1, 'Enter a value');
    const n1 = def.numeric && def.args >= 1 ? numberOf(value1.value) : null, n2 = def.args >= 2 ? numberOf(value2.value) : null;
    if (def.numeric && def.args >= 1 && n1 == null) return refuse(value1, 'Enter a number');
    if (def.count && !(Number.isInteger(n1) && n1 >= 1 && n1 <= 1000)) return refuse(value1, 'Enter a whole number from 1 to 1000');
    if (def.args >= 2 && n2 == null) return refuse(value2, 'Enter a number');
    const style = QUICK_STYLES.find(([k]) => k === format.value)[2]();
    const value = def.date ? period.value : def.numeric ? n1 : value1.value.trim();
    const rule = quickRule(range, key, { value, value2: n2, choice: choice.value, style });
    if (!wb.addRule(sheetId, rule)) return refuse(def.args ? value1 : format, wb.isProtected(sheetId) ? 'This sheet is protected' : 'The rule could not be added');
    modal.close();
  };
  const fields = def.date ? [period] : def.choice ? [choice] : def.args >= 2 ? [value1, el('span.cfq-and', {}, 'and'), value2] : def.args ? [value1] : [];
  const content = el('form.cfq', { onsubmit: submit },
    el('p.cfq-prompt', {}, def.prompt),
    el('div.cfq-row', {}, ...fields, el('span.cfq-with', {}, def.choice ? 'values with' : 'with'), el('div.select-wrap', {}, format)),
    el('p.field-hint', {}, `Applies to ${rangeName(range)}.`), error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: def.title, content, className: 'cfq-dialog', initialFocus: fields[0] || format, onClose: () => ctx.grid?.focus?.() });
  if (fields[0]?.select) fields[0].select();
  return modal;
}

/** What is left of rectangle `a` once `b` is taken out of it: up to four rectangles. */
export function subtractRange(a, b) {
  const r1 = Math.max(a.r1, b.r1), r2 = Math.min(a.r2, b.r2), c1 = Math.max(a.c1, b.c1), c2 = Math.min(a.c2, b.c2);
  if (r1 > r2 || c1 > c2) return [a];
  const out = [];
  if (a.r1 < r1) out.push({ r1: a.r1, c1: a.c1, r2: r1 - 1, c2: a.c2 });
  if (r2 < a.r2) out.push({ r1: r2 + 1, c1: a.c1, r2: a.r2, c2: a.c2 });
  if (a.c1 < c1) out.push({ r1, c1: a.c1, r2, c2: c1 - 1 });
  if (c2 < a.c2) out.push({ r1, c1: c2 + 1, r2, c2: a.c2 });
  return out;
}

/** Clear rules from the selected ranges (or every rule on the sheet) as one undo step. Returns how many rules were touched. */
export function clearRules(wb, sheetId, ranges = null) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return 0;
  const groups = conditionalRuleGroups(sheet.rules);
  let touched = 0;
  wb.transaction('Clear rules', () => {
    for (const group of groups) {
      const areas = group.rules.map(rule => normalizeRange(rule.range));
      const left = ranges ? ranges.reduce((list, cut) => list.flatMap(area => subtractRange(area, normalizeRange(cut))), areas) : [];
      if (ranges && left.length === areas.length && left.every((area, i) => JSON.stringify(area) === JSON.stringify(areas[i]))) continue;
      touched++;
      if (!left.length) wb.deleteRuleGroup(sheetId, group.rules[0].id);
      else wb.setRuleAreas(sheetId, group.rules[0].id, {}, left);
    }
  });
  return touched;
}
