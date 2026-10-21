import { fillColorCss } from '../core/fill-color.js';
import { NATIVE_ICON_SETS, nativeIconCount, nativeIconChoice } from '../core/native-icons.js';
import { conditionalIconNode } from './conditional-icon.js';
import { conditionalRuleGroups, splitConditionalRanges } from '../core/conditional-groups.js';
import { duplicateSourceAreas } from '../core/conditional-duplicates.js';
import { BAR_FORMULAS, SCALE_FORMULAS, ICON_FORMULAS, conditionalThresholdIsFormula } from '../core/conditional-scale.js';
/**
 * Conditional formatting manager: the active sheet's rules, with a form to
 * add or edit one. Rules apply to a range and either match a condition
 * (then apply a fill, text color, bold) or paint a two- or three-color scale.
 */

import { fontColorCss } from '../core/font-color.js';
import { el, clear, fieldId, isComposing } from './dom.js';
import { icon } from './icons.js';
import { openModal, focusListRow, fieldAlert } from './modal.js';
import { pickCustomColor } from './colorpicker.js';
import { toast } from './toast.js';
import { RULE_TYPES, ICON_SETS, DATE_PERIODS, describeRule, barColorOf } from '../core/condformat.js';
import { rangeName } from '../core/cell.js';
import { parseInput, formatGeneral, formatValue, dateTimeKind } from '../core/format.js';
import { codeDateKind } from '../core/numfmt.js';
import { FILL_COLORS, TEXT_COLORS, swatchColor } from './toolbar.js';
import { customFormulaProblem } from './validation.js';

// A condition's number, read and shown as the grid reads and shows one: 1,5
// is one and a half where the decimal mark is a comma, 1,234.5 where it is not.
export const numberOf = (text) => { const { v } = parseInput(text.trim()); return typeof v === 'number' ? v : null; };
export const numberText = (v) => (typeof v === 'number' ? formatGeneral(v) : v);
/**
 * A condition's number as the rule's cells show it: a date or a time where the first cell holds one (written
 * 2024-03-15, or 15:30:00, which read back as the same number in every regional format), so Greater than a date
 * typed as 3/15/2024 is listed and edited as that date rather than the serial 45366. Anything else as numberText.
 */
export function ruleValueText(v, wb, sheetId, rule) {
  if (typeof v !== 'number' || !['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq'].includes(rule?.type) || !rule.range) return numberText(v);
  const kind = dateTimeKind(wb.displayStyleAt?.(sheetId, rule.range.r1, rule.range.c1), v);
  if (!kind || v < 0) return numberText(v);
  const code = kind === 'time' && v < 1 ? 'hh:mm:ss' : Number.isInteger(v) ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss';
  const text = formatValue(v, { fmt: 'custom', code });
  return parseInput(text).v === v ? text : numberText(v);
}
/**
 * The value an Equal to or Not equal to condition compares with: a number typed as the grid reads one (1,5
 * where the decimal mark is a comma, 50%, $1,200) is that number, so it matches the cells that hold it; other
 * text, a date or a time among it, is kept as typed and compared as text.
 */
export const equalValueOf = (text) => {
  const typed = text.trim();
  const { v, fmt, code } = parseInput(typed);
  return typeof v === 'number' && !['date', 'time', 'datetime'].includes(fmt) && !(fmt === 'custom' && codeDateKind(v, code)) ? v : text;
};

export function openConditionalFormatting(ctx) {
  const sheetId = ctx.sheetId();
  const list = el('div.cf-list', { role: 'list', 'aria-label': 'Rules' });
  let editingId = null;
  let nativeDuplicates = false;
  let nativeBar = false, extendedBar = false, nativeIcons = false;
  // Keys the rule being edited leaves out, each with the value the form shows in its place. A rule
  // written elsewhere (a template's, an imported file's) carries fewer keys than this form writes, so
  // handing one of these back unchanged is not an edit: dropping it keeps Save on an untouched rule
  // from recording an undo step and marking the document unsaved.
  let implied = {};

  const rangeInput = el('input.input', { type: 'text', 'aria-label': 'Apply to range', value: rangeName(ctx.range()), spellcheck: false, autocomplete: 'off' });
  const typeSelect = el('select.select', { 'aria-label': 'Condition' }, RULE_TYPES.map((t) => el('option', { value: t.value }, t.label)));
  const value1 = el('input.input', { type: 'text', 'aria-label': 'Value', placeholder: 'Value', autocomplete: 'off', spellcheck: false });
  const value2 = el('input.input', { type: 'text', 'aria-label': 'Second value', placeholder: 'and', autocomplete: 'off' });
  const formulaHint = el('span.field-hint', { hidden: true }, 'Written for the top-left cell of the first area; relative references move with each cell, e.g. =$C2>B2 or =ISBLANK(A2).');
  const duplicateSource = el('input.input', { type: 'text', 'aria-label': 'Count values in', spellcheck: false, autocomplete: 'off' });
  const duplicateBlock = el('label.field', { hidden: true }, el('span.field-label', {}, 'Count values in'), duplicateSource,
    el('span.field-hint', {}, 'The ranges used to find duplicates or unique values. For separate areas, use (A1:A20,C1:C20). These ranges can differ from the cells being formatted.'));
  const boldId = fieldId('cf');
  const boldInput = el('input', { type: 'checkbox', id: boldId });
  // A refusal names the field it is about; one the workbook makes (a protected sheet) names none.
  const { alert: error, refuse, clear: clearError } = fieldAlert('cf');

  let fill = '#fef3c7';
  let color = null;
  let from = '#ffffff';
  let mid = '#fef3c7';
  let to = '#4a8dff';
  const threeId = fieldId('cf');
  const threeInput = el('input', { type: 'checkbox', id: threeId });
  let band1 = '#f2f1ee';
  let band2 = '#ffffff';
  let bandHeader = '#e0ecff';
  const headerId = fieldId('cf');
  const headerInput = el('input', { type: 'checkbox', id: headerId, checked: true });

  const swatches = (label, palette, get, set, allowNone, paint = swatchColor) => {
    const group = el('div.swatches.cf-swatches', { role: 'radiogroup', 'aria-label': label });
    const render = () => {
      const hadFocus = group.contains(document.activeElement);
      clear(group);
      if (allowNone) group.append(el('button.swatch.none', { type: 'button', role: 'radio', 'aria-checked': String(get() == null), 'aria-label': 'None', tabindex: get() == null ? 0 : -1, onclick: () => { set(null); render(); } }));
      const chosen = get();
      const shown = chosen && !palette.includes(chosen) ? [...palette, chosen] : palette;
      for (const hex of shown) {
        // A rule's own colour joins the palette, and a file can carry anything there: only validated color values
        // are painted, since `background` also takes a url() that would fetch when the list is drawn.
        group.append(el('button.swatch', { type: 'button', role: 'radio', 'aria-checked': String(chosen === hex), 'aria-label': typeof hex === 'object' ? paint(hex) || 'Unknown color' : hex, tabindex: chosen === hex ? 0 : -1, style: { background: paint(hex) || 'transparent' }, onclick: () => { set(hex); render(); } }));
      }
      group.append(el('button.swatch.custom', {
        type: 'button', 'aria-label': `Custom ${label.toLowerCase()}…`, title: 'Custom color…',
        // When the browser's colour popup closes it hands the focus to the `<input type=color>` that
        // owned it, which lives on the body, aria-hidden and out of the tab order — and render() has
        // just replaced the swatch that opened it. So the chosen swatch takes the focus itself,
        // rather than leaving it outside the dialog for the Tab trap to bounce to Close.
        onclick: (e) => pickCustomColor({ current: paint(chosen), anchor: e.currentTarget, onPick: (hex) => { set(hex); render(); (group.querySelector('[aria-checked="true"]') || group.querySelector('.swatch.custom'))?.focus(); } }),
      }));
      const selected = group.querySelector('[aria-checked="true"]') || group.querySelector('[role="radio"]');
      if (selected) selected.tabIndex = 0;
      if (hadFocus) selected?.focus();
    };
    group.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      const step = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 0;
      if (!step) return;
      const choices = [...group.querySelectorAll('[role="radio"]')];
      const index = choices.indexOf(e.target.closest('[role="radio"]'));
      if (index < 0) return;
      e.preventDefault();
      const next = choices[(index + step + choices.length) % choices.length];
      next.focus();
      next.click();
    });
    render();
    group.refresh = render;
    return group;
  };
  const fillSwatches = swatches('Fill color', FILL_COLORS, () => fill, (v) => { fill = v; }, true, value => swatchColor(fillColorCss(value)));
  const colorSwatches = swatches('Text color', TEXT_COLORS, () => color, (v) => { color = v; }, true, fontColorCss);
  const fromSwatches = swatches('Low color', ['#ffffff', '#fde8e8', '#fef3c7', '#e3f5e1', '#e0ecff', '#f2f1ee'], () => from, (v) => { from = v; }, false);
  const midSwatches = swatches('Midpoint color', ['#fef3c7', '#ffffff', '#fde8e8', '#e3f5e1', '#e0ecff', '#eda100'], () => mid, (v) => { mid = v; }, false);
  const toSwatches = swatches('High color', ['#4a8dff', '#c22a2a', '#eda100', '#1baf7a', '#4a3aa7', '#0b0b0b'], () => to, (v) => { to = v; }, false);
  const BAND_PALETTE = ['#ffffff', '#f2f1ee', '#e7e6e1', '#fde8e8', '#fdebd3', '#fef3c7', '#e3f5e1', '#dff3f6', '#e0ecff', '#ebe6fb', '#fbe4ef'];
  const band1Swatches = swatches('First color', BAND_PALETTE, () => band1, (v) => { band1 = v; }, false);
  const band2Swatches = swatches('Second color', BAND_PALETTE, () => band2, (v) => { band2 = v; }, false);
  const bandHeaderSwatches = swatches('Header color', ['#e0ecff', '#c3c2b7', '#fdebd3', '#e3f5e1', '#ebe6fb', '#0b0b0b'], () => bandHeader, (v) => { bandHeader = v; }, false);
  let barColor = '#8fb8ff';
  const barSwatches = swatches('Bar color', ['#8fb8ff', '#9fdcb4', '#ffd58a', '#f6a6a6', '#c9b8f5', '#c3c2b7'], () => barColor, (v) => { barColor = v; }, false);

  const iconSelect = el('select.select', { 'aria-label': 'Icon set' }, Object.entries(ICON_SETS).map(([k, set]) => el('option', { value: k }, `${set.glyphs.join(' ')}  ${set.label}`)));
  const loInput = el('input.input', { type: 'number', min: 0, max: 100, step: 1, 'aria-label': 'Low threshold percent', value: '33' });
  const hiInput = el('input.input', { type: 'number', min: 0, max: 100, step: 1, 'aria-label': 'High threshold percent', value: '67' });
  const iconOnlyId = fieldId('cf');
  const iconOnlyInput = el('input', { type: 'checkbox', id: iconOnlyId });
  const iconBlock = el('div.cf-style', { hidden: true },
    el('div.field', {}, el('span.field-label', {}, 'Icons'), el('div.select-wrap', {}, iconSelect)),
    el('div.names-fields', {},
      el('label.field', {}, el('span.field-label', {}, 'Top icon from (% of range)'), hiInput),
      el('label.field', {}, el('span.field-label', {}, 'Bottom icon below (%)'), loInput)),
    el('label.find-option', { for: iconOnlyId }, iconOnlyInput, el('span', {}, 'Show the icon only, not the value')));
  const dateSelect = el('select.select', { 'aria-label': 'Period', hidden: true }, DATE_PERIODS.map((p) => el('option', { value: p.value }, p.label)));
  // Top and Bottom rank a count of values, or with this a percentage of them (Excel's Top 10%).
  const percentId = fieldId('cf');
  const percentInput = el('input', { type: 'checkbox', id: percentId });
  const percentField = el('label.find-option', { for: percentId, hidden: true }, percentInput, el('span', {}, '% of the values'));
  const valueRow = el('div.cf-values', {}, value1, value2, dateSelect, percentField);
  const styleBlock = el('div.cf-style', {},
    el('div.field', {}, el('span.field-label', {}, 'Fill'), fillSwatches),
    el('div.field', {}, el('span.field-label', {}, 'Text color'), colorSwatches),
    el('label.find-option', { for: boldId }, boldInput, el('span', {}, 'Bold')));
  const thresholdTypes = (input, bar = false) => {
    const select = el('select.select', { 'aria-label': `${input.getAttribute('aria-label')} type` },
      [['', 'Number or formula'], ['num', 'Number'], ['min', 'Lowest value'], ['max', 'Highest value'],
        ['percent', 'Percent of value range'], ['percentile', 'Percentile'],
        ...(bar ? [['autoMin', 'Lowest value or zero'], ['autoMax', 'Highest value or zero']] : [])]
        .map(([value, text]) => el('option', { value }, text)));
    select.addEventListener('change', () => { input.disabled = ['min', 'max', 'autoMin', 'autoMax'].includes(select.value); });
    return select;
  };
  const loadThresholds = (inputs, types, keys, rule = {}) => inputs.forEach((input, i) => {
    const type = rule[`${keys[i]}Type`] || '';
    types[i].value = type;
    input.disabled = ['min', 'max', 'autoMin', 'autoMax'].includes(type);
    input.value = rule[keys[i]] != null ? `${conditionalThresholdIsFormula(rule, keys[i]) ? '=' : ''}${rule[keys[i]]}` : '';
  });
  const nativeIconSelect = el('select.select', { 'aria-label': 'Built-in icon set' }, Object.entries(NATIVE_ICON_SETS).map(([key, set]) => el('option', { value: key }, set.label)));
  const nativeIconKeys = ICON_FORMULAS.slice(1);
  const nativeIconInputs = nativeIconKeys.map((key, i) => el('input.input', { type: 'text', 'aria-label': `Icon boundary ${i + 1}`, autocomplete: 'off', spellcheck: false }));
  const nativeIconTypes = nativeIconInputs.map(input => {
    const select = thresholdTypes(input);
    for (const option of [...select.options]) if (['min', 'max'].includes(option.value)) option.remove();
    return select;
  });
  const nativeIconComparisons = nativeIconKeys.map((key, i) => el('select.select', { 'aria-label': `Icon boundary ${i + 1} comparison` },
    el('option', { value: 'gte' }, 'Greater than or equal to'), el('option', { value: 'gt' }, 'Greater than')));
  const nativeIconFields = nativeIconInputs.map((input, i) => el('label.field', {}, el('span.field-label', {}, `Icon boundary ${i + 1}`),
    el('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1.6fr) minmax(0, 1fr)', gap: '6px' } }, nativeIconComparisons[i], nativeIconTypes[i], input)));
  const nativeIconReverse = el('input', { type: 'checkbox', 'aria-label': 'Reverse icon order' });
  const nativeIconCustom = el('input', { type: 'checkbox', 'aria-label': 'Customize icons' });
  const nativeIconChoices = ICON_FORMULAS.map((_, i) => el('select.select', { 'aria-label': `Icon category ${i + 1}` },
    el('option', { value: 'NoIcons:0' }, 'No cell icon'), ...Object.entries(NATIVE_ICON_SETS).flatMap(([name, set]) => set.symbols.map((symbol, id) =>
      el('option', { value: `${name}:${id}` }, `${set.label}: ${symbol} (${id + 1} of ${set.count})`)))));
  const nativeIconPreviews = nativeIconChoices.map(() => el('span', { style: { minWidth: '16px' } }));
  const nativeIconChoiceFields = nativeIconChoices.map((select, i) => el('label.field', {}, el('span.field-label', {}, `Category ${i + 1}${i === 0 ? ' (lowest)' : ''}`),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, nativeIconPreviews[i], select)));
  const nativeIconCustomBlock = el('div', { hidden: true }, ...nativeIconChoiceFields);
  const nativeIconActive = el('input.input', { type: 'text', 'aria-label': 'Show icons when', placeholder: 'Always (or enter a formula)', autocomplete: 'off', spellcheck: false });
  const nativeIconBlock = el('div', { hidden: true }, el('label.field', {}, el('span.field-label', {}, 'Icon set'), nativeIconSelect),
    ...nativeIconFields, el('label.find-option', { style: { display: 'flex', marginBottom: '8px' } }, nativeIconReverse, el('span', {}, 'Reverse icon order')),
    el('label.find-option', { style: { display: 'flex', marginBottom: '8px' } }, nativeIconCustom, el('span', {}, 'Customize icons')), nativeIconCustomBlock,
    el('label.field', {}, el('span.field-label', {}, 'Show icons when'), nativeIconActive));
  const appIconFields = [...iconBlock.children].slice(0, 2);
  iconBlock.prepend(nativeIconBlock);
  const syncIconFields = () => {
    const count = NATIVE_ICON_SETS[nativeIconSelect.value]?.count || 3;
    nativeIconFields.forEach((field, i) => { field.hidden = i >= count - 1; });
    nativeIconCustomBlock.hidden = !nativeIconCustom.checked;
    nativeIconReverse.disabled = nativeIconCustom.checked;
    nativeIconChoiceFields.forEach((field, i) => {
      field.hidden = i >= count;
      const [name, id] = nativeIconChoices[i].value.split(':');
      const choice = nativeIconChoice({ iconSet: name }, Number(id));
      nativeIconPreviews[i].replaceChildren(...(choice?.iconImage ? [conditionalIconNode(choice)] : []));
    });
  };
  nativeIconSelect.addEventListener('change', syncIconFields);
  nativeIconCustom.addEventListener('change', () => {
    if (nativeIconCustom.checked) {
      const count = NATIVE_ICON_SETS[nativeIconSelect.value].count;
      nativeIconChoices.forEach((select, i) => {
        const index = Math.min(i, count - 1);
        select.value = `${nativeIconSelect.value}:${nativeIconReverse.checked ? count - 1 - index : index}`;
      });
    }
    syncIconFields();
  });
  for (const input of nativeIconChoices) input.addEventListener('change', syncIconFields);
  const scaleInputs = SCALE_FORMULAS.map((key, i) => el('input.input', { type: 'text', 'aria-label': ['Low threshold', 'Midpoint threshold', 'High threshold'][i],
    placeholder: ['Lowest value (automatic)', 'Halfway between thresholds (automatic)', 'Highest value (automatic)'][i], autocomplete: 'off', spellcheck: false }));
  const scaleTypes = scaleInputs.map(input => thresholdTypes(input));
  const scaleFields = scaleInputs.map((input, i) => el('label.field', {}, el('span.field-label', {}, ['Low threshold', 'Midpoint threshold', 'High threshold'][i]), scaleTypes[i], input));
  const midField = el('div.field', { hidden: true }, el('span.field-label', {}, 'Midpoint'), midSwatches);
  threeInput.addEventListener('change', () => { midField.hidden = scaleFields[1].hidden = !threeInput.checked; });
  const scaleBlock = el('div.cf-style', { hidden: true },
    el('div.field', {}, el('span.field-label', {}, 'Low color'), fromSwatches), scaleFields[0],
    el('label.find-option', { for: threeId }, threeInput, el('span', {}, 'Three colors')),
    midField, scaleFields[1],
    el('div.field', {}, el('span.field-label', {}, 'High color'), toSwatches), scaleFields[2],
    el('p.small.muted', {}, 'Leave thresholds blank for automatic values, or enter a number or a formula starting with =. Threshold formulas use fixed sheet references.'));
  const barInputs = BAR_FORMULAS.map((key, i) => el('input.input', { type: 'text', 'aria-label': ['Minimum bar value', 'Maximum bar value'][i], spellcheck: false, autocomplete: 'off' }));
  const barTypes = barInputs.map(input => thresholdTypes(input, true));
  const barLengths = ['Shortest bar (%)', 'Longest bar (%)'].map(label => el('input.input', { type: 'number', min: 0, max: 100, step: 1, 'aria-label': label }));
  const barOnlyId = fieldId('cf'), barOnlyInput = el('input', { type: 'checkbox', id: barOnlyId });
  const nativeBarActive = el('input.input', { type: 'text', 'aria-label': 'Show bars when', placeholder: 'Always (or enter a formula)', autocomplete: 'off', spellcheck: false });
  const nativeBarBlock = el('div', { hidden: true },
    el('label.field', {}, el('span.field-label', {}, 'Show bars when'), nativeBarActive),
    ...barInputs.map((input, i) => el('label.field', {}, el('span.field-label', {}, ['Minimum value', 'Maximum value'][i]), barTypes[i], input)),
    el('div.names-fields', {}, ...barLengths.map((input, i) => el('label.field', {}, el('span.field-label', {}, ['Shortest bar (%)', 'Longest bar (%)'][i]), input))),
    el('label.find-option', { for: barOnlyId }, barOnlyInput, el('span', {}, 'Show the bar only, not the value')),
    el('p.small.muted', {}, 'Thresholds accept numbers or formulas. Formulas use fixed sheet references; leave them blank to use the formatted range’s minimum and maximum.'));
  const barControls = {};
  const barOption = (key, label, defaultValue, choices) => {
    const checkbox = typeof defaultValue === 'boolean';
    const input = choices ? el('select.select', { 'aria-label': label }, choices.map(([value, text]) => el('option', { value }, text)))
      : el(checkbox ? 'input' : 'input.input', { type: checkbox ? 'checkbox' : 'color', 'aria-label': label,
        ...(!checkbox ? { style: { width: '64px', height: '36px', padding: '3px', cursor: 'pointer' } } : {}) });
    const field = checkbox ? el('div', { style: { margin: '6px 0' } }, el('label.find-option', {}, input, el('span', {}, label)))
      : el('label.field', {}, el('span.field-label', {}, label), input);
    barControls[key] = { input, field, defaultValue };
    return field;
  };
  const extendedBarBlock = el('div.cf-style', { hidden: true },
    el('div.names-fields', {}, barOption('barAxisPosition', 'Zero axis', 'automatic', [['automatic', 'Automatic'], ['middle', 'Center'], ['none', 'None']]),
      barOption('barDirection', 'Bar direction', 'context', [['context', 'Follow sheet direction'], ['leftToRight', 'Left to right'], ['rightToLeft', 'Right to left']])),
    barOption('barGradient', 'Gradient fill', true),
    barOption('barBorder', 'Bar border', false),
    barOption('barBorderColor', 'Bar border color', '#638ec6'),
    barOption('barNegativeColorSame', 'Use positive fill color for negative values', false),
    barOption('barNegativeColor', 'Negative bar color', '#ff0000'),
    barOption('barNegativeBorderColorSame', 'Use positive border color for negative values', true),
    barOption('barNegativeBorderColor', 'Negative border color', '#ff0000'),
    barOption('barAxisColor', 'Zero axis color', '#000000'));
  function syncBarOptions() {
    const border = barControls.barBorder.input.checked;
    barControls.barBorderColor.field.hidden = !border;
    barControls.barNegativeBorderColorSame.field.hidden = !border;
    barControls.barNegativeBorderColor.field.hidden = !border || barControls.barNegativeBorderColorSame.input.checked;
    barControls.barNegativeColor.field.hidden = barControls.barNegativeColorSame.input.checked;
    barControls.barAxisColor.field.hidden = barControls.barAxisPosition.input.value === 'none';
  }
  for (const { input } of Object.values(barControls)) input.addEventListener('change', syncBarOptions);
  const barOptions = () => Object.fromEntries(Object.entries(barControls).map(([key, { input }]) => [key, input.type === 'checkbox' ? input.checked : input.value]));
  const barHint = el('p.small.muted', {}, 'Bars grow from zero (or from the lowest value when there are negatives) to the largest value in the range.');
  const barBlock = el('div.cf-style', { hidden: true },
    el('div.field', {}, el('span.field-label', {}, 'Bar color'), barSwatches),
    nativeBarBlock, extendedBarBlock, barHint);
  const bandsBlock = el('div.cf-style', { hidden: true },
    el('label.find-option', { for: headerId }, headerInput, el('span', {}, 'First row is a header')),
    el('div.field', {}, el('span.field-label', {}, 'Header'), bandHeaderSwatches),
    el('div.field', {}, el('span.field-label', {}, 'First color'), band1Swatches),
    el('div.field', {}, el('span.field-label', {}, 'Second color'), band2Swatches));

  function syncType() {
    const t = RULE_TYPES.find((x) => x.value === typeSelect.value);
    value1.hidden = t.args < 1 || !!t.date;
    value2.hidden = t.args < 2;
    dateSelect.hidden = !t.date;
    percentField.hidden = t.value !== 'top' && t.value !== 'bottom';
    valueRow.hidden = t.args === 0;
    styleBlock.hidden = !!t.scale || !!t.bands || !!t.databar || !!t.icons;
    scaleBlock.hidden = !t.scale;
    iconBlock.hidden = !t.icons;
    nativeIconBlock.hidden = !nativeIcons; appIconFields.forEach(field => { field.hidden = nativeIcons; }); syncIconFields();
    barBlock.hidden = !t.databar;
    bandsBlock.hidden = !t.bands;
    value1.placeholder = t.formula ? '=$B2>100' : t.value === 'top' || t.value === 'bottom' ? 'How many' : t.numeric ? 'Number' : 'Value';
    formulaHint.hidden = !t.formula;
    nativeBarBlock.hidden = !nativeBar; barHint.hidden = nativeBar;
    extendedBarBlock.hidden = !extendedBar;
    syncBarOptions();
    duplicateBlock.hidden = !nativeDuplicates || !['dup', 'unique'].includes(t.value);
  }
  // A different condition asks for different fields: a refusal about one the form no longer
  // shows would leave a visible message tied to a hidden field, and a mark a screen reader
  // still reports. It goes with the fields it blamed.
  typeSelect.addEventListener('change', () => { clearError(); syncType(); });

  function resetForm() {
    clearError();
    editingId = null;
    nativeDuplicates = false; nativeBar = extendedBar = nativeIcons = false;
    duplicateSource.value = '';
    loadThresholds(barInputs, barTypes, BAR_FORMULAS);
    barLengths.forEach((input, i) => { input.value = String(i ? 90 : 10); });
    barOnlyInput.checked = false;
    implied = {};
    barColor = '#8fb8ff';
    rangeInput.value = rangeName(ctx.range());
    typeSelect.value = 'gt';
    value1.value = '';
    value2.value = '';
    percentInput.checked = false;
    fill = '#fef3c7'; color = null; from = '#ffffff'; mid = '#fef3c7'; to = '#4a8dff';
    band1 = '#f2f1ee'; band2 = '#ffffff'; bandHeader = '#e0ecff';
    boldInput.checked = false;
    headerInput.checked = true;
    threeInput.checked = false;
    midField.hidden = scaleFields[1].hidden = true;
    loadThresholds(scaleInputs, scaleTypes, SCALE_FORMULAS);
    iconSelect.value = 'arrows'; loInput.value = '33'; hiInput.value = '67'; iconOnlyInput.checked = false;
    for (const g of [fillSwatches, colorSwatches, fromSwatches, midSwatches, toSwatches, band1Swatches, band2Swatches, bandHeaderSwatches, barSwatches]) g.refresh();
    saveBtn.textContent = 'Add rule';
    cancelEdit.hidden = true;
    syncType();
  }

  function loadRule(rule, areas = [rule.range]) {
    // The form no longer holds the refused value: the message and the mark go with it.
    clearError();
    if (rule.type === 'databar') barColor = rule.barColor || '#8fb8ff';
    editingId = rule.id;
    nativeIcons = rule.type === 'icons' && !!NATIVE_ICON_SETS[rule.iconSet];
    nativeIconSelect.value = rule.iconSet || '3TrafficLights1';
    loadThresholds(nativeIconInputs, nativeIconTypes, nativeIconKeys, rule);
    nativeIconInputs.forEach((input, i) => {
      if (rule[nativeIconKeys[i]] == null) { input.value = String((i + 1) * 20); nativeIconTypes[i].value = 'percent'; }
      nativeIconComparisons[i].value = rule[`${nativeIconKeys[i]}Gte`] === false ? 'gt' : 'gte';
    });
    nativeIconReverse.checked = !!rule.iconReverse;
    nativeIconCustom.checked = !!rule.iconCustom;
    nativeIconActive.value = rule.iconActiveFormula ? `=${rule.iconActiveFormula}` : '';
    nativeIconChoices.forEach((select, i) => { select.value = rule.iconCustom && rule[`icon${i}Set`] ? `${rule[`icon${i}Set`]}:${rule[`icon${i}Id`]}`
      : `${rule.iconSet || '3TrafficLights1'}:${Math.min(i, (nativeIconCount(rule) || 3) - 1)}`; });
    nativeBar = rule.type === 'databar' && ['legacy', 'extended'].includes(rule.barMode);
    extendedBar = nativeBar && rule.barMode === 'extended';
    for (const type of barTypes) for (const option of type.options) if (['autoMin', 'autoMax'].includes(option.value)) option.disabled = !extendedBar;
    for (const [key, control] of Object.entries(barControls)) {
      const value = rule[key] ?? (key === 'barBorderColor' ? barColorOf(rule) : control.defaultValue);
      if (control.input.type === 'checkbox') control.input.checked = value;
      else control.input.value = value;
    }
    loadThresholds(barInputs, barTypes, BAR_FORMULAS, rule);
    barLengths.forEach((input, i) => { input.value = String(rule[i ? 'barMaxLength' : 'barMinLength'] ?? (i ? 90 : 10)); });
    barOnlyInput.checked = !!rule.barOnly;
    nativeBarActive.value = rule.barActiveFormula ? `=${rule.barActiveFormula}` : '';
    nativeDuplicates = ['dup', 'unique'].includes(rule.type) && typeof rule.duplicateRange === 'string';
    duplicateSource.value = nativeDuplicates ? rule.duplicateRange : '';
    rangeInput.value = areas.map(rangeName).join(', ');
    typeSelect.value = rule.type;
    value1.value = rule.type === 'date' ? '' : rule.type === 'formula' ? `=${String(rule.value ?? '').trim().replace(/^=/, '')}` : (ruleValueText(rule.value, ctx.wb, sheetId, rule) ?? '');
    value2.value = ruleValueText(rule.value2, ctx.wb, sheetId, rule) ?? '';
    if (rule.type === 'date') dateSelect.value = rule.value || 'today';
    percentInput.checked = !!rule.percent;
    fill = rule.style?.bg ?? null;
    color = rule.style?.color ?? null;
    boldInput.checked = !!rule.style?.bold;
    from = rule.from || '#ffffff';
    mid = rule.mid || '#fef3c7';
    to = rule.to || '#4a8dff';
    threeInput.checked = !!rule.mid;
    midField.hidden = scaleFields[1].hidden = !rule.mid;
    loadThresholds(scaleInputs, scaleTypes, SCALE_FORMULAS, rule);
    iconSelect.value = ICON_SETS[rule.set] ? rule.set : 'arrows';
    loInput.value = String(rule.lo ?? 33);
    hiInput.value = String(rule.hi ?? 67);
    iconOnlyInput.checked = !!rule.iconOnly;
    band1 = rule.color1 || '#f2f1ee';
    band2 = rule.color2 || '#ffffff';
    // A rule with no header colour of its own paints its header in its first colour (bandColor in
    // core/condformat.js), so that is the colour the swatch shows — not the default the form starts from.
    bandHeader = rule.headerColor || rule.color1 || '#e0ecff';
    headerInput.checked = rule.header !== false;
    for (const g of [fillSwatches, colorSwatches, fromSwatches, midSwatches, toSwatches, band1Swatches, band2Swatches, bandHeaderSwatches, barSwatches]) g.refresh();
    saveBtn.textContent = 'Save rule';
    cancelEdit.hidden = false;
    implied = {};
    for (const [key, shown] of Object.entries({ set: iconSelect.value, lo: Number(loInput.value), hi: Number(hiInput.value), iconOnly: iconOnlyInput.checked, from, to, barColor, color1: band1, color2: band2, headerColor: bandHeader, header: headerInput.checked, ...(extendedBar ? barOptions() : {}), ...(nativeBar ? { barOnly: barOnlyInput.checked, barMinLength: Number(barLengths[0].value), barMaxLength: Number(barLengths[1].value) } : {}) })) {
      if (!(key in rule)) implied[key] = shown;
    }
    syncType();
    rangeInput.focus();
  }

  function changed(result) {
    if (result) { clearError(); return true; }
    refuse(null, ctx.wb.isProtected(sheetId)
      ? 'This sheet is protected. Unprotect it before changing conditional formatting.'
      : 'The rule could not be changed. Its sheet or rule may no longer exist.');
    return false;
  }

  function submit(e) {
    e.preventDefault();
    const parts = splitConditionalRanges(rangeInput.value), parsed = parts?.map(part => ctx.wb.rangeFromText(sheetId, part));
    if (!parsed?.length || parsed.some(item => !item)) return refuse(rangeInput, 'Enter a range like B2:B20, a table column like Sales[Amount], or separate areas like B2:B20,D2:D20');
    if (parsed.some(item => item.sheetId !== sheetId)) return refuse(rangeInput, 'Enter a range on this sheet');
    const areas = parsed.map(item => item.range), range = areas[0];
    const t = RULE_TYPES.find((x) => x.value === typeSelect.value);
    if (t.args >= 1 && !t.date && value1.value.trim() === '') return refuse(value1, 'Enter a value');
    if (t.args >= 2 && value2.value.trim() === '') return refuse(value2, 'Enter both values');
    const n1 = t.numeric ? numberOf(value1.value) : null;
    const n2 = t.args >= 2 ? numberOf(value2.value) : null;
    if (t.numeric && (n1 == null || (t.args === 2 && n2 == null))) return refuse(n1 == null ? value1 : value2, 'This condition needs numbers');
    const ranked = t.value === 'top' || t.value === 'bottom', percent = ranked && percentInput.checked;
    if (ranked && (!Number.isInteger(n1) || n1 < 1)) return refuse(value1, 'Enter how many values, as a whole number of at least 1');
    if (percent && n1 > 100) return refuse(value1, 'Enter a percentage from 1 to 100');
    if (t.formula && !value1.value.trim().startsWith('=')) return refuse(value1, 'A custom formula starts with =');
    const formulaProblem = t.formula ? customFormulaProblem(ctx.wb, sheetId, range, value1.value.trim()) : null;
    if (formulaProblem) return refuse(value1, formulaProblem);
    let duplicateRange;
    if (nativeDuplicates && ['dup', 'unique'].includes(t.value)) {
      duplicateRange = duplicateSource.value.trim().replace(/^=/, '').trim();
      const areas = duplicateSourceAreas(duplicateRange);
      if (!areas?.length) return refuse(duplicateSource, 'Enter a range like A1:A20, or separate areas like (A1:A20,C1:C20)');
      if (areas.some(ref => ref.sheet && !ctx.wb.sheetByName(ref.sheet))) return refuse(duplicateSource, 'One of these ranges refers to a sheet that does not exist');
    }
    // A cleared threshold field would read as zero.
    if (t.icons && !nativeIcons && (loInput.value.trim() === '' || hiInput.value.trim() === '')) return refuse(loInput.value.trim() === '' ? loInput : hiInput, 'Enter both thresholds');
    const lo = Number(loInput.value);
    const hi = Number(hiInput.value);
    if (t.icons && !nativeIcons && (!(lo >= 0 && lo <= 100) || !(hi >= 0 && hi <= 100) || lo > hi)) return refuse(!(lo >= 0 && lo <= 100) ? loInput : hiInput, 'Thresholds are percentages from 0 to 100, low at or below high');
    const thresholds = {};
    const thresholdFields = t.scale ? SCALE_FORMULAS.map((key, i) => [key, scaleInputs[i], i === 1 && !threeInput.checked, scaleTypes[i]])
      : t.databar && nativeBar ? BAR_FORMULAS.map((key, i) => [key, barInputs[i], false, barTypes[i]])
      : t.icons && nativeIcons ? nativeIconKeys.map((key, i) => [key, nativeIconInputs[i], nativeIconFields[i].hidden, nativeIconTypes[i]]) : [];
    for (const [key, input, omit, typeInput] of thresholdFields) {
      const thresholdType = omit ? '' : typeInput.value;
      thresholds[`${key}Type`] = thresholdType || undefined;
      if (['min', 'max', 'autoMin', 'autoMax'].includes(thresholdType)) { thresholds[key] = undefined; continue; }
      if (thresholdType) {
        if (input.value.trim().startsWith('=')) {
          const problem = customFormulaProblem(ctx.wb, sheetId, { r1: 0, c1: 0 }, input.value.trim());
          if (problem) return refuse(input, problem);
          thresholds[key] = input.value.trim().slice(1).trim(); continue;
        }
        const value = numberOf(input.value);
        if (input.value.trim() === '' || !Number.isFinite(value)) return refuse(input, 'Enter a number');
        if (['percent', 'percentile'].includes(thresholdType) && (value < 0 || value > 100)) return refuse(input, 'Enter a percentage from 0 to 100');
        thresholds[key] = String(value); continue;
      }
      const text = omit ? '' : input.value.trim();
      if (t.icons && nativeIcons && !omit && !text) return refuse(input, 'Enter a number or a formula starting with =');
      let formula;
      if (text.startsWith('=')) {
        const problem = customFormulaProblem(ctx.wb, sheetId, { r1: 0, c1: 0 }, text);
        if (problem) return refuse(input, problem);
        formula = text.slice(1).trim();
      } else if (text) {
        const value = numberOf(text);
        if (!Number.isFinite(value)) return refuse(input, 'Enter a number or a formula starting with =');
        formula = String(value);
      }
      thresholds[key] = formula;
    }
    const activation = {};
    for (const [key, input, active] of [['iconActiveFormula', nativeIconActive, t.icons && nativeIcons], ['barActiveFormula', nativeBarActive, t.databar && nativeBar]]) {
      activation[key] = undefined;
      if (!active || !input.value.trim()) continue;
      const text = input.value.trim();
      if (!text.startsWith('=')) return refuse(input, 'Enter a formula starting with =');
      const problem = customFormulaProblem(ctx.wb, sheetId, range, text);
      if (problem) return refuse(input, problem);
      activation[key] = text.slice(1).trim();
    }
    const iconChoices = Object.fromEntries(nativeIconChoices.flatMap((select, i) => {
      const [name, id] = select.value.split(':');
      const used = t.icons && nativeIcons && nativeIconCustom.checked && !nativeIconChoiceFields[i].hidden;
      return [[`icon${i}Set`, used ? name : undefined], [`icon${i}Id`, used ? Number(id) : undefined]];
    }));
    const lengths = barLengths.map(input => input.value.trim() ? Number(input.value) : NaN);
    if (t.databar && nativeBar && (!lengths.every(Number.isInteger) || lengths[0] < 0 || lengths[0] > lengths[1] || lengths[1] > 100))
      return refuse(barLengths[0], 'Bar lengths are whole percentages from 0 to 100, shortest at or below longest');
    clearError();
    const rule = {
      range, type: t.value,
      ...(nativeDuplicates ? { duplicateRange } : {}),
      ...(nativeBar && !t.databar ? { barMode: undefined, barActiveFormula: undefined, barMinFormula: undefined, barMaxFormula: undefined, barMinFormulaType: undefined, barMaxFormulaType: undefined,
        barMinLength: undefined, barMaxLength: undefined, barFullHeight: undefined, barOnly: undefined,
        ...Object.fromEntries(Object.keys(barControls).map(key => [key, undefined])) } : {}),
      value: t.date ? dateSelect.value : t.args >= 1 ? (t.numeric ? n1 : ['eq', 'neq'].includes(t.value) ? equalValueOf(value1.value) : value1.value) : undefined,
      value2: t.args >= 2 ? n2 : undefined,
      percent: percent || undefined,
      style: t.scale || t.bands || t.databar || t.icons ? {} : { ...(fill ? { bg: fill } : {}), ...(color ? { color } : {}), ...(boldInput.checked ? { bold: true } : {}) },
      ...(t.icons ? { ...(nativeIcons ? { iconSet: nativeIconSelect.value, ...thresholds,
        iconReverse: nativeIconReverse.checked || undefined, iconCustom: nativeIconCustom.checked || undefined, iconActiveFormula: activation.iconActiveFormula,
        ...iconChoices,
        ...Object.fromEntries(nativeIconKeys.map((key, i) => [`${key}Gte`, !nativeIconFields[i].hidden && nativeIconComparisons[i].value === 'gt' ? false : undefined]))
      } : { set: iconSelect.value, lo, hi }), iconOnly: iconOnlyInput.checked } : {}),
      ...(nativeIcons && !t.icons ? { iconSet: undefined, iconReverse: undefined, iconPercent: undefined, iconCustom: undefined, iconActiveFormula: undefined, ...iconChoices,
        ...Object.fromEntries(ICON_FORMULAS.flatMap(key => [[key, undefined], [`${key}Type`, undefined], [`${key}Gte`, undefined]])) } : {}),
      ...(t.scale ? { from, to, mid: threeInput.checked ? mid : undefined, ...thresholds } : {}),
      ...(t.databar ? { barColor, ...(extendedBar ? barOptions() : {}), ...(nativeBar ? { ...thresholds, barActiveFormula: activation.barActiveFormula, barMinLength: lengths[0], barMaxLength: lengths[1], barOnly: barOnlyInput.checked } : {}) } : {}),
      ...(t.bands ? { color1: band1, color2: band2, headerColor: bandHeader, header: headerInput.checked } : {}),
    };
    // A header the rule leaves out follows the rule's first colour, so what "unchanged" means for it
    // moves with the First color the form now holds: changing that writes the header out rather than
    // letting it follow the band away from the colour the swatch shows.
    if ('headerColor' in implied) implied.headerColor = band1 || '#e0ecff';
    if ('barBorderColor' in implied) implied.barBorderColor = barColor;
    for (const [key, shown] of Object.entries(implied)) if (key in rule && rule[key] === shown) rule[key] = undefined;
    const result = ctx.wb.setRuleAreas(sheetId, editingId, rule, areas);
    if (!changed(result)) return;
    toast(editingId ? 'Rule updated' : 'Rule added');
    resetForm();
    render();
  }

  function render() {
    clear(list);
    const rules = conditionalRuleGroups(ctx.wb.sheet(sheetId)?.rules || []);
    if (!rules.length) {
      list.append(el('p.small.muted', { style: { padding: '6px 2px' } }, 'No rules on this sheet yet.'));
      return;
    }
    rules.forEach(({ rule, rules: pieces }, idx) => {
      const areas = pieces.map(piece => piece.range), label = areas.map(rangeName).join(', ');
      // A rule of a kind this build has no form for (from a file saved elsewhere) is listed to be
      // moved or deleted, not opened: the form has no fields for it and would misread it as another kind.
      const known = RULE_TYPES.some((t) => t.value === rule.type);
      // Every colour a rule carries is painted only as a hex colour: a file can store any string there,
      // and `background` takes a url() that would fetch a remote image as soon as the list is drawn.
      const hex = (value, fallback) => swatchColor(value) || fallback;
      const ruleBg = swatchColor(fillColorCss(rule.style?.bg));
      const preview = el('span.cf-preview', { style: rule.type === 'scale'
        ? { background: `linear-gradient(90deg, ${hex(rule.from, '#ffffff')}, ${rule.mid ? `${hex(rule.mid, '#fef3c7')}, ` : ''}${hex(rule.to, '#4a8dff')})` }
        : rule.type === 'databar'
          ? { background: `linear-gradient(90deg, ${barColorOf(rule)} 60%, transparent 60%)`, border: '1px solid var(--hairline-strong)' }
        : rule.type === 'bands'
          ? { background: `repeating-linear-gradient(180deg, ${hex(rule.color1, '#f2f1ee')} 0 25%, ${hex(rule.color2, '#ffffff')} 25% 50%)`, border: '1px solid var(--hairline-strong)' }
          : rule.type === 'icons'
            ? { border: '1px solid var(--hairline-strong)', color: (ICON_SETS[rule.set] || ICON_SETS.arrows).colors[0], fontSize: '11px' }
          : { background: ruleBg || 'transparent', color: fontColorCss(rule.style?.color) || 'inherit', fontWeight: rule.style?.bold ? '700' : '500', border: ruleBg ? 0 : '1px solid var(--hairline-strong)' } },
      rule.type === 'icons' ? (ICON_SETS[rule.set] || ICON_SETS.arrows).glyphs[0] : rule.type === 'scale' || rule.type === 'bands' || rule.type === 'databar' ? '' : 'Aa');
      if (rule.type === 'icons' && NATIVE_ICON_SETS[rule.iconSet]) {
        const choice = nativeIconChoice(rule, nativeIconCount(rule) - 1);
        preview.textContent = ''; if (choice?.iconImage) preview.append(conditionalIconNode(choice));
      }
      list.append(el('div.names-row', { role: 'listitem' },
        el('button.names-main', { type: 'button', disabled: !known, onclick: () => loadRule(rule, areas) },
          preview,
          el('span.names-name', {}, label),
          el('span.names-ref', {}, known ? describeRule({ ...rule, value: ruleValueText(rule.value, ctx.wb, sheetId, rule), value2: ruleValueText(rule.value2, ctx.wb, sheetId, rule) }) : `A rule of the kind "${rule.type}", which this version cannot edit`)),
        // Each action rebuilds the rows; the focus follows the moved rule, or goes to the row that took a deleted one's place, or to the range field.
        el('button.icon-btn', { type: 'button', html: icon('chevU', 16), 'aria-label': `Move the rule for ${label} up`, title: 'Move up (earlier rules win where they overlap)', disabled: idx === 0, dataset: { action: 'up' }, onclick: () => { if (!changed(ctx.wb.moveRuleGroup(sheetId, rule.id, -1))) return; render(); focusListRow(list, idx - 1, 'up', rangeInput); } }),
        el('button.icon-btn', { type: 'button', html: icon('chevD', 16), 'aria-label': `Move the rule for ${label} down`, title: 'Move down (later rules give way to earlier ones)', disabled: idx === rules.length - 1, dataset: { action: 'down' }, onclick: () => { if (!changed(ctx.wb.moveRuleGroup(sheetId, rule.id, 1))) return; render(); focusListRow(list, idx + 1, 'down', rangeInput); } }),
        el('button.icon-btn', { type: 'button', html: icon('trash', 16), 'aria-label': `Delete rule for ${label}`, dataset: { action: 'delete' }, onclick: () => { if (!changed(ctx.wb.deleteRuleGroup(sheetId, rule.id))) return; if (editingId === rule.id) resetForm(); render(); focusListRow(list, idx, 'delete', rangeInput); } })));
    });
  }

  const saveBtn = el('button.btn.btn-primary', { type: 'submit' }, 'Add rule');
  // Hiding the button it was pressed on would drop the focus to the page: it goes to the form's first field, as in Named ranges.
  const cancelEdit = el('button.btn.btn-ghost', { type: 'button', hidden: true, onclick: () => { resetForm(); rangeInput.focus(); } }, 'Cancel edit');
  // Threshold fields are hidden for most rule types; submit() checks them itself when they apply.
  const form = el('form.cf-form', { onsubmit: submit, novalidate: true },
    el('div.names-fields', {},
      el('label.field', {}, el('span.field-label', {}, 'Apply to'), rangeInput, el('span.field-hint', {}, 'For separate areas, use B2:B20,D2:D20.')),
      el('label.field', {}, el('span.field-label', {}, 'Condition'), el('div.select-wrap', {}, typeSelect))),
    el('div.field', {}, valueRow, formulaHint),
    duplicateBlock,
    styleBlock,
    scaleBlock,
    barBlock,
    iconBlock,
    bandsBlock,
    error,
    el('div.row.row-end', {}, cancelEdit, saveBtn));

  const modal = openModal({ title: 'Conditional formatting', content: el('div', {}, list, form), wide: true, onClose: () => ctx.grid?.focus?.() });
  resetForm();
  render();
  return modal;
}
