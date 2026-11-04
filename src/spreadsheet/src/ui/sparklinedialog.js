import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { cellName } from '../core/cell.js';
import { nativeSparklineAt, nativeSparklineLocation, nativeSparklineColorValues, nativeSparklineDateMismatch } from '../core/native-sparkline-data.js';
import { effectiveColorPalette } from '../core/font-color.js';
import { t } from '../i18n/index.js';

export function openSparklineDialog(ctx) {
  const sheetId = ctx.sheetId(), { r, c } = ctx.active(), ref = cellName(r, c);
  const found = nativeSparklineAt(ctx.wb, sheetId, r, c);
  if (!found) { toast(t('sparklinedialog.selectCell'), { icon: 'info' }); return null; }
  const { group, spark } = found, inputs = {}, originals = {}, colors = {};
  const content = el('form.sparkline-settings', { noValidate: true }), { alert, refuse: showError } = fieldAlert('sparkline');
  const refuse = (field, message) => {
    for (let details = field?.closest('details'); details; details = details.parentElement?.closest('details')) details.open = true;
    return showError(field, message);
  };
  const field = (parent, key, label, value, choices = null, attrs = {}) => {
    const input = choices ? el('select.select', { 'aria-label': label }, choices.map(([value, text]) => el('option', { value }, text)))
      : el('input.input', { type: 'text', 'aria-label': label, autocomplete: 'off', ...attrs });
    input.value = value ?? ''; inputs[key] = input; originals[key] = input.value;
    parent.append(el('label.field', {}, el('span.field-label', {}, label), input));
    return input;
  };
  const check = (parent, key, label) => {
    const input = inputs[key] = el('input', { type: 'checkbox', checked: group[key], 'aria-label': label });
    originals[key] = input.checked; parent.append(el('label.check', {}, input, el('span', {}, label)));
    return input;
  };
  const section = title => { const body = el('div.sparkline-options'); content.append(el('details', {}, el('summary', {}, title), body)); return body; };
  field(content, 'formula', t('sparklinedialog.dataRangeFor', { ref }), spark.formula);
  content.append(el('p.small.muted', {}, group.sparklines.length === 1 ? t('sparklinedialog.appliesOnlyTo', { ref })
    : t('sparklinedialog.appliesToGroup', { count: group.sparklines.length, ref })));
  const main = el('div.sparkline-fields'); content.append(main);
  field(main, 'type', t('sparklinedialog.chartType'), group.type, [['line', t('sparklinedialog.typeLine')], ['column', t('sparklinedialog.typeColumn')], ['stacked', t('sparklinedialog.typeWinLoss')]]);
  field(main, 'lineWeight', t('sparklinedialog.lineWeight'), group.lineWeight, null, { type: 'number', min: 0, max: 1584, step: 'any', required: true });
  field(content, 'displayEmptyCellsAs', t('sparklinedialog.emptyCells'), group.displayEmptyCellsAs, [['gap', t('sparklinedialog.emptyGaps')], ['zero', t('sparklinedialog.emptyZero')], ['span', t('sparklinedialog.emptySpan')]]);
  check(content, 'displayHidden', t('sparklinedialog.includeHidden'));
  const axes = section(t('sparklinedialog.axes')), limits = el('div.sparkline-fields'); axes.append(limits);
  const bounds = [['minAxisType', 'manualMin', t('sparklinedialog.minScale'), t('sparklinedialog.minValue')],
    ['maxAxisType', 'manualMax', t('sparklinedialog.maxScale'), t('sparklinedialog.maxValue')]];
  for (const [mode, bound, scaleLabel, valueLabel] of bounds) {
    const select = field(limits, mode, scaleLabel, group[mode], [['individual', t('sparklinedialog.scaleEach')], ['group', t('sparklinedialog.scaleGroup')], ['custom', t('common.custom')]]);
    const number = field(limits, bound, valueLabel, group[bound], null, { type: 'number', step: 'any' });
    const sync = () => { number.disabled = select.value !== 'custom'; number.required = !number.disabled; };
    select.addEventListener('change', sync); sync();
  }
  check(axes, 'displayXAxis', t('sparklinedialog.showAxis')); check(axes, 'rightToLeft', t('sparklinedialog.rightToLeft'));
  const dateAxis = check(axes, 'dateAxis', t('sparklinedialog.dateAxis'));
  const dates = field(axes, 'dateFormula', t('sparklinedialog.dateRange'), group.dateFormula);
  const syncDates = () => { dates.disabled = !dateAxis.checked; }; dateAxis.addEventListener('change', syncDates); syncDates();
  const markers = section(t('sparklinedialog.markersAndColors')), points = el('div.sparkline-fields'); markers.append(points);
  const pointLabels = [['markers', t('sparklinedialog.allMarkers')], ['high', t('sparklinedialog.high')], ['low', t('sparklinedialog.low')],
    ['negative', t('sparklinedialog.negative')], ['first', t('sparklinedialog.first')], ['last', t('sparklinedialog.last')]];
  for (const [key, label] of pointLabels) check(points, key, label);
  const paints = nativeSparklineColorValues(group, effectiveColorPalette(ctx.wb.colorPalette)), colorFields = el('div.sparkline-fields'); markers.append(colorFields);
  const colorLabels = [['Series', t('sparklinedialog.colorSeries')], ['Axis', t('sparklinedialog.colorAxis')], ['Markers', t('sparklinedialog.colorMarkers')],
    ['High', t('sparklinedialog.colorHigh')], ['Low', t('sparklinedialog.colorLow')], ['Negative', t('sparklinedialog.colorNegative')],
    ['First', t('sparklinedialog.colorFirst')], ['Last', t('sparklinedialog.colorLast')]];
  for (const [key, label] of colorLabels) {
    const input = field(colorFields, `color${key}`, label, paints[key.toLowerCase()], null, { type: 'color', className: 'chart-color-input' });
    // Untouched theme/indexed colors and tints retain their original meaning.
    input.addEventListener('input', () => {
      if (input.value === originals[`color${key}`]) delete colors[`color${key}`];
      else colors[`color${key}`] = { rgb: `FF${input.value.slice(1).toUpperCase()}` };
    });
  }
  content.append(alert, el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), el('button.btn.btn-primary', { type: 'submit' }, t('common.save'))));
  const validRange = input => {
    const location = nativeSparklineLocation(ctx.wb, sheetId, input.value.trim(), { r, c });
    return location && !location.sheetEnd && ctx.wb.sheetByName(location.sheet) && (location.r1 === location.r2 || location.c1 === location.c2) ? location : null;
  };
  content.addEventListener('submit', event => {
    event.preventDefault();
    for (const input of Object.values(inputs)) if (input.type === 'number' && !input.disabled) {
      const number = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(number)) return refuse(input, t('sparklinedialog.finiteNumber'));
      if (input.min !== '' && number < Number(input.min) || input.max !== '' && number > Number(input.max)) return refuse(input, t('sparklinedialog.numberRange', { min: input.min, max: input.max }));
    }
    const settings = { ...colors };
    for (const [key, input] of Object.entries(inputs)) {
      if (key === 'formula' || key.startsWith('color') || input.disabled) continue;
      const value = input.type === 'checkbox' ? input.checked : input.value;
      if (value !== originals[key]) settings[key] = input.type === 'number' ? Number(value) : value || null;
    }
    const formula = inputs.formula.value.trim(), changedSource = inputs.formula.value !== (spark.formula ?? '');
    if (changedSource && formula && !validRange(inputs.formula)) return refuse(inputs.formula, t('sparklinedialog.singleRowOrColumn'));
    if (dateAxis.checked && (dateAxis.checked !== group.dateAxis || dates.value !== originals.dateFormula) && !validRange(dates)) return refuse(dates, t('sparklinedialog.singleDates'));
    if (dateAxis.checked && (changedSource || dateAxis.checked !== group.dateAxis || dates.value !== originals.dateFormula)) {
      if (!validRange(dates)) return refuse(dates, t('sparklinedialog.singleDates'));
      const members = group.sparklines.map(member => member.ref === ref ? { ...member, formula } : member);
      if (nativeSparklineDateMismatch(ctx.wb, sheetId, dates.value.trim(), members))
        return refuse(dates, t('sparklinedialog.dateMismatch'));
    }
    const minimum = inputs.minAxisType.value === 'custom' ? Number(inputs.manualMin.value) : null;
    const maximum = inputs.maxAxisType.value === 'custom' ? Number(inputs.manualMax.value) : null;
    if (minimum != null && maximum != null && minimum > maximum) return refuse(inputs.manualMax, t('sparklinedialog.maxBelowMin'));
    const error = ctx.wb.updateNativeSparkline(sheetId, ref, { settings, ...(changedSource ? { formula: formula || null } : {}), expectedGroupUid: group.uid });
    if (error) return refuse(null, error);
    modal.close();
  });
  const modal = openModal({ title: t('sparklinedialog.title'), content, initialFocus: inputs.formula, onClose: () => ctx.grid.focus() });
  return modal;
}
