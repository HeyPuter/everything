/**
 * Data validation manager: dropdown lists, number ranges, and checkboxes
 * for a range of cells, with optional strict rejection and a help message.
 */

import { el, clear, fieldId, isComposing } from './dom.js';
import { icon } from './icons.js';
import { openModal, focusListRow, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { VALIDATION_TYPES, VALIDATION_OPERATORS, describeValidation, CHIP_PALETTE, chipFor, isRangeSource, splitList, joinList, ruleFormulaBody, relativeListSource } from '../core/validation.js';
import { cellName, rangeName } from '../core/cell.js';
import { formatDate, formatTime, parseTime, ymdToSerial, ERROR_HELP } from '../core/format.js';
import { parseFormula } from '../core/formula/parser.js';
import { syntaxErrorText } from '../core/formula/tokenizer.js';
import { t } from '../i18n/index.js';

/**
 * Why `text`, a custom formula written for the top-left cell of `range`, cannot
 * serve as a rule: it does not read, or it comes out #NAME? or #REF! there. An
 * unknown function or name, or a broken reference, fails on every cell alike,
 * so the rule would refuse every entry or never match; an error that hangs on
 * the cell's data (a division by zero, say) is left to that cell. Null when
 * the formula can serve. Shared with the conditional formatting dialog.
 */
export function customFormulaProblem(wb, sheetId, range, text) {
  try { parseFormula(ruleFormulaBody(text)); } catch (e) { return t('validation.formulaUnreadable', { detail: syntaxErrorText(e) }); }
  const result = wb.evalRuleFormula(sheetId, text, range, range.r1, range.c1);
  const code = result && typeof result === 'object' ? result.error : null;
  if (code === '#NAME?' || code === '#REF!') return t('validation.formulaGives', { cell: cellName(range.r1, range.c1), code, help: ERROR_HELP[code] });
  return null;
}

export function openValidationManager(ctx, { type = null } = {}) {
  const sheetId = ctx.sheetId();
  const list = el('div.cf-list', { role: 'list', 'aria-label': t('validation.rules') });
  let editingId = null;
  // Keys the rule being edited leaves out, each with the value the form shows in its place. A rule
  // written elsewhere (a template's, an imported file's) carries fewer keys than this form writes, so
  // handing one of these back unchanged is not an edit: dropping it keeps Save on an untouched rule
  // from recording an undo step and marking the document unsaved.
  let implied = {};
  let literalSource = null;
  let literalText = '';
  let dateBounds = null; // the loaded rule's date serials, with the text the date fields were given for them
  let timeBounds = null;

  const rangeInput = el('input.input', { type: 'text', 'aria-label': t('validation.applyToRange'), value: rangeName(ctx.range()), spellcheck: false, autocomplete: 'off' });
  const typeSelect = el('select.select', { 'aria-label': t('validation.type') }, VALIDATION_TYPES.map((type) => el('option', { value: type.value }, t(type.label))));
  const sourceInput = el('textarea.input', { rows: 2, 'aria-label': t('validation.listOptions'), placeholder: t('validation.listPlaceholder'), autocomplete: 'off', spellcheck: false });
  const minInput = el('input.input', { type: 'number', 'aria-label': t('validation.minimum'), placeholder: t('validation.minimumOptional'), step: 'any' });
  const maxInput = el('input.input', { type: 'number', 'aria-label': t('validation.maximum'), placeholder: t('validation.maximumOptional'), step: 'any' });
  const minDate = el('input.input', { type: 'date', 'aria-label': t('validation.earliestDate') });
  const maxDate = el('input.input', { type: 'date', 'aria-label': t('validation.latestDate') });
  const minTime = el('input.input', { type: 'text', 'aria-label': t('validation.earliestTime'), placeholder: '09:00', autocomplete: 'off' });
  const maxTime = el('input.input', { type: 'text', 'aria-label': t('validation.latestTime'), placeholder: '17:00', autocomplete: 'off' });
  const comparison = el('select.select', { 'aria-label': t('validation.comparison') }, VALIDATION_OPERATORS.map(([value, label]) => el('option', { value }, t(label))));
  const formulaInput = el('input.input', { type: 'text', 'aria-label': t('validation.formula'), placeholder: '=COUNTIF($A$1:$A$100,A1)=1', autocomplete: 'off', spellcheck: false });
  const messageInput = el('textarea.input', { rows: 3, 'aria-label': t('validation.helpMessage'), placeholder: t('validation.helpPlaceholder'), autocomplete: 'off' });
  const promptInput = el('textarea.input', { rows: 3, 'aria-label': t('validation.inputMessage'), placeholder: t('validation.inputPlaceholder'), autocomplete: 'off', maxlength: 300 });
  const promptTitle = el('input.input', { type: 'text', 'aria-label': t('validation.inputTitle'), maxlength: 32, autocomplete: 'off' });
  const errorTitle = el('input.input', { type: 'text', 'aria-label': t('validation.errorTitle'), maxlength: 32, autocomplete: 'off' });
  const showPromptId = fieldId('dv');
  const showPrompt = el('input', { type: 'checkbox', id: showPromptId, checked: true });
  const syncPrompt = () => { promptTitle.disabled = promptInput.disabled = !showPrompt.checked; };
  showPrompt.addEventListener('change', syncPrompt);
  const strictId = fieldId('dv');
  const strictInput = el('input', { type: 'checkbox', id: strictId, checked: true });
  const alertSelect = el('select.select', { 'aria-label': t('validation.alertStyle'), disabled: true },
    el('option', { value: 'stop', disabled: true }, t('validation.alert.stop')),
    el('option', { value: 'none' }, t('validation.alert.none')),
    el('option', { value: 'warning' }, t('validation.alert.warning')),
    el('option', { value: 'information' }, t('validation.alert.information')));
  let nonStrictAlert = 'none';
  strictInput.addEventListener('change', () => {
    if (strictInput.checked) nonStrictAlert = alertSelect.value;
    alertSelect.value = strictInput.checked ? 'stop' : nonStrictAlert;
    alertSelect.disabled = strictInput.checked;
  });
  const blankId = fieldId('dv');
  const blankInput = el('input', { type: 'checkbox', id: blankId, checked: true });
  // A refusal names the field it is about; one the workbook makes (a protected sheet) names none.
  const { alert: error, refuse: refuseField, clear: clearError } = fieldAlert('dv');
  const refuse = (field, message) => {
    const panel = field?.closest('[role="tabpanel"]');
    if (panel) { activeTab = panel.dataset.key; syncTabs(); }
    return refuseField(field, message);
  };

  const listHint = el('span.field-hint');
  const listField = el('label.field', {}, el('span.field-label', {}, t('common.options')), sourceInput, listHint);
  // Colored chips: draw each value as a pill, with a fill per option.
  const chipsId = fieldId('dv');
  const chipsInput = el('input', { type: 'checkbox', id: chipsId });
  const colorRows = el('div.chip-colors');
  let colors = Object.create(null);
  const chipsField = el('div.field.chips-field', {},
    el('label.find-option', { for: chipsId }, chipsInput, el('span', {}, t('validation.chips'))),
    colorRows);
  function sourceForForm() {
    const source = sourceInput.value;
    if (!literalSource) return source.trim();
    if (source === literalText) return literalSource;
    // Appending options to an existing literal list preserves its type, even
    // when the resulting CSV is also syntactically a reference union.
    const appended = source.startsWith(literalText) && /^[,\r\n]/.test(source.slice(literalText.length));
    if (!appended && isRangeSource(source)) {
      // Switching a literal list to a formula requires a complete formula;
      // appending CSV options to a literal "=Name" must keep them literal.
      try {
        if (source.trim().startsWith('=')) parseFormula(source.trim().slice(1));
        return source.trim();
      } catch { /* Continue editing the literal options. */ }
    }
    const label = (v) => typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
    const originals = new Map();
    for (const value of literalSource) {
      const text = label(value).replace(/\r\n?/g, '\n');
      if (!originals.has(text)) originals.set(text, value);
    }
    // Preserve existing option types when editing a generated list. New labels remain
    // literal text, read with the same grammar as a typed list (quotes keep commas).
    return splitList(source).map((text) => originals.has(text) ? originals.get(text) : text);
  }
  function optionsForForm() {
    const source = sourceForForm();
    if (!source) return [];
    return ctx.wb.listOptionsFor(sheetId, { type: 'list', source }).slice(0, 40);
  }
  function renderColors() {
    colorRows.hidden = !chipsInput.checked;
    clear(colorRows);
    if (!chipsInput.checked) return;
    const options = optionsForForm();
    if (!options.length) { colorRows.append(el('span.small.muted', {}, t('validation.chipsEmpty'))); return; }
    const preview = { type: 'list', chips: true, colors };
    for (const option of options) {
      const sel = el('select.select.select-sm', { 'aria-label': t('validation.colorFor', { option }) },
        el('option', { value: '' }, t('common.automatic')),
        ...CHIP_PALETTE.map(([hex, name]) => el('option', { value: hex, selected: typeof colors[option] === 'string' && colors[option].toLowerCase() === hex }, t(name))));
      const chipEl = el('span.chip', { style: { backgroundColor: chipFor(preview, option, options).bg, color: '#1a1a1a' } }, option);
      sel.addEventListener('change', () => {
        if (sel.value) colors[option] = sel.value; else delete colors[option];
        chipEl.style.backgroundColor = chipFor({ ...preview, colors }, option, options).bg;
      });
      colorRows.append(el('div.chip-color-row', {}, chipEl, el('div.select-wrap', {}, sel)));
    }
  }
  chipsInput.addEventListener('change', renderColors);
  sourceInput.addEventListener('input', () => { if (chipsInput.checked) renderColors(); });
  const numberLabel = el('span.field-label', {}, t('validation.allowedRange'));
  const numberField = el('div.field', { hidden: true }, numberLabel, el('div.cf-values', {}, minInput, maxInput));
  const dateLabel = el('span.field-label');
  const dateField = el('div.field', { hidden: true }, dateLabel, el('div.cf-values', {}, minDate, maxDate));
  const timeLabel = el('span.field-label');
  const timeField = el('div.field', { hidden: true }, timeLabel, el('div.cf-values', {}, minTime, maxTime), el('span.field-hint', {}, t('validation.timeHint')));
  const comparisonField = el('label.field', { hidden: true }, el('span.field-label', {}, t('validation.comparison')), el('div.select-wrap', {}, comparison));
  const formulaField = el('label.field', { hidden: true }, el('span.field-label', {}, t('validation.formula')), formulaInput, el('span.field-hint', {}, t('validation.formulaHint')));
  const optionsBlock = el('div.field', {},
    el('label.find-option', { for: strictId }, strictInput, el('span', {}, t('validation.strict'))),
    el('label.field', {}, el('span.field-label', {}, t('validation.alertStyle')), el('div.select-wrap', {}, alertSelect)));

  function syncType() {
    const kind = typeSelect.value;
    const dual = ['between', 'notBetween'].includes(comparison.value);
    comparisonField.hidden = !['number', 'whole', 'text', 'date', 'time'].includes(kind);
    for (const input of [maxInput, maxDate, maxTime]) input.hidden = !dual;
    minInput.setAttribute('aria-label', dual ? t('validation.minimum') : t('validation.comparisonValue'));
    minDate.setAttribute('aria-label', dual ? t('validation.earliestDate') : t('validation.comparisonDate'));
    minTime.setAttribute('aria-label', dual ? t('validation.earliestTime') : t('validation.comparisonTime'));
    blankInput.disabled = kind === 'any';
    if (kind === 'any') blankInput.checked = true;
    listHint.textContent = t('validation.listHint');
    listField.hidden = kind !== 'list';
    chipsField.hidden = kind !== 'list';
    numberField.hidden = !['number', 'whole', 'text'].includes(kind);
    numberLabel.textContent = !dual ? t('common.value') : kind === 'text' ? t('validation.length') : t('validation.allowedRange');
    const optional = comparison.value === 'between' && kind !== 'whole';
    minInput.placeholder = !dual ? t('validation.comparisonValue') : kind === 'text' ? (optional ? t('validation.shortestOptional') : t('validation.shortest'))
      : optional ? t('validation.minimumOptional') : t('validation.minimum');
    maxInput.placeholder = kind === 'text' ? (optional ? t('validation.longestOptional') : t('validation.longest')) : optional ? t('validation.maximumOptional') : t('validation.maximum');
    dateLabel.textContent = !dual ? t('validation.comparisonDate') : optional ? t('validation.allowedDatesOptional') : t('validation.allowedDates');
    timeLabel.textContent = dual ? t('validation.allowedTimes') : t('validation.comparisonTime');
    dateField.hidden = kind !== 'date';
    timeField.hidden = kind !== 'time';
    formulaField.hidden = kind !== 'formula';
    optionsBlock.hidden = kind === 'checkbox';
    tabs.querySelector('[data-key="prompt"]').disabled = kind === 'checkbox';
    tabs.querySelector('[data-key="error"]').disabled = kind === 'checkbox';
    if (kind === 'checkbox' && activeTab !== 'settings') activeTab = 'settings';
    syncTabs();
  }
  // A different type asks for different fields: a refusal about one the form no longer shows
  // would leave a visible message tied to a hidden field, and a mark a screen reader still
  // reports. It goes with the fields it blamed.
  typeSelect.addEventListener('change', () => { clearError(); syncType(); });
  comparison.addEventListener('change', () => { clearError(); syncType(); });

  function resetForm() {
    clearError();
    editingId = null;
    implied = {};
    literalSource = null;
    literalText = '';
    rangeInput.value = rangeName(ctx.range());
    // Opened for one kind of rule (Insert checkbox, Insert dropdown), the form stays on it after each rule.
    typeSelect.value = type || 'list';
    sourceInput.value = '';
    chipsInput.checked = false;
    colors = Object.create(null);
    renderColors();
    minInput.value = '';
    maxInput.value = '';
    minDate.value = '';
    maxDate.value = '';
    dateBounds = null;
    timeBounds = null;
    minTime.value = maxTime.value = '';
    comparison.value = 'between';
    formulaInput.value = '';
    messageInput.value = '';
    promptInput.value = '';
    promptTitle.value = '';
    errorTitle.value = '';
    showPrompt.checked = true;
    syncPrompt();
    strictInput.checked = true;
    nonStrictAlert = 'none';
    alertSelect.value = 'stop'; alertSelect.disabled = true;
    blankInput.checked = true;
    saveBtn.textContent = t('validation.addRule');
    cancelEdit.hidden = true;
    activeTab = 'settings';
    syncType();
  }

  function loadRule(rule) {
    // The form no longer holds the refused value: the message and the mark go with it.
    clearError();
    editingId = rule.id;
    rangeInput.value = rangeName(rule.range);
    typeSelect.value = rule.type;
    literalSource = rule.type === 'list' && Array.isArray(rule.source) ? rule.source : null;
    sourceInput.value = literalSource ? joinList(literalSource) : rule.type === 'list' ? rule.source || '' : '';
    literalText = sourceInput.value;
    chipsInput.checked = rule.type === 'list' && !!rule.chips;
    colors = Object.assign(Object.create(null), rule.colors || {});
    renderColors();
    formulaInput.value = rule.type === 'formula' ? rule.source || '' : '';
    minInput.value = rule.type === 'date' ? '' : rule.min ?? '';
    maxInput.value = rule.type === 'date' ? '' : rule.max ?? '';
    minDate.value = rule.type === 'date' && rule.min != null ? formatDate(rule.min, 'iso') : '';
    maxDate.value = rule.type === 'date' && rule.max != null ? formatDate(rule.max, 'iso') : '';
    // A date input holds neither a time of day nor a date outside its calendar (shown blank), so the
    // serials themselves are kept for a bound whose field is saved as it was loaded.
    dateBounds = rule.type === 'date' ? { min: rule.min ?? null, max: rule.max ?? null, minText: minDate.value, maxText: maxDate.value } : null;
    const timeText = n => n == null ? '' : n >= 0 && n < 1 ? formatTime(n, true) : String(n);
    minTime.value = rule.type === 'time' ? timeText(rule.min) : '';
    maxTime.value = rule.type === 'time' ? timeText(rule.max) : '';
    timeBounds = rule.type === 'time' ? { min: rule.min ?? null, max: rule.max ?? null, minText: minTime.value, maxText: maxTime.value } : null;
    comparison.value = rule.operator || 'between';
    messageInput.value = rule.message || '';
    promptInput.value = rule.prompt || '';
    promptTitle.value = rule.promptTitle || '';
    errorTitle.value = rule.errorTitle || '';
    showPrompt.checked = rule.showInputMessage !== false;
    syncPrompt();
    strictInput.checked = rule.strict !== false;
    nonStrictAlert = rule.showErrorMessage !== false && ['warning', 'information'].includes(rule.errorStyle) ? rule.errorStyle : 'none';
    alertSelect.value = strictInput.checked ? 'stop' : nonStrictAlert;
    alertSelect.disabled = strictInput.checked;
    blankInput.checked = rule.allowBlank !== false;
    saveBtn.textContent = t('validation.saveRule');
    cancelEdit.hidden = false;
    implied = {};
    // An absent bound leaves its field empty, which the form reads back as null.
    for (const [key, shown] of Object.entries({ strict: strictInput.checked, allowBlank: blankInput.checked, min: null, max: null })) {
      if (!(key in rule)) implied[key] = shown;
    }
    activeTab = 'settings';
    syncType();
    rangeInput.focus();
  }

  function changed(result) {
    if (result) { clearError(); return true; }
    refuse(null, ctx.wb.isProtected(sheetId)
      ? t('validation.protected')
      : t('validation.changeFailed'));
    return false;
  }

  function submit(e) {
    e.preventDefault();
    const parsed = ctx.wb.rangeFromText(sheetId, rangeInput.value.trim());
    const range = parsed && parsed.sheetId === sheetId ? parsed.range : null;
    if (!range) return refuse(rangeInput, parsed ? t('validation.rangeOtherSheet') : t('validation.rangeInvalid'));
    const type = typeSelect.value;
    if (type === 'list' && !sourceInput.value.trim()) return refuse(sourceInput, t('validation.noOptions'));
    if (type === 'formula' && !formulaInput.value.trim().startsWith('=')) return refuse(formulaInput, t('validation.formulaNoEquals'));
    const formulaProblem = type === 'formula' ? customFormulaProblem(ctx.wb, sheetId, range, formulaInput.value.trim()) : null;
    if (formulaProblem) return refuse(formulaInput, formulaProblem);
    // A number or date field holding what it cannot read (a lone minus, half a date) has no value to go by.
    const bounds = type === 'date' ? [minDate, maxDate] : type === 'time' ? [minTime, maxTime] : ['number', 'whole', 'text'].includes(type) ? [minInput, maxInput] : [];
    const unreadable = bounds.find((input) => !input.hidden && input.validity?.badInput);
    if (unreadable) return refuse(unreadable, unreadable.type === 'date' ? t('validation.badDate') : t('validation.badNumber'));
    const toSerial = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? ymdToSerial(Number(m[1]), Number(m[2]), Number(m[3])) : null; };
    let min = minInput.value.trim() === '' ? null : Number(minInput.value);
    let max = maxInput.value.trim() === '' ? null : Number(maxInput.value);
    if (type === 'date') {
      min = dateBounds && minDate.value === dateBounds.minText ? dateBounds.min : toSerial(minDate.value);
      max = dateBounds && maxDate.value === dateBounds.maxText ? dateBounds.max : toSerial(maxDate.value);
    }
    if (type === 'time') {
      const readTime = input => input.value.trim() === '' ? null : parseTime(input.value) ?? (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(input.value.trim()) ? Number(input.value) : NaN);
      min = timeBounds && minTime.value === timeBounds.minText ? timeBounds.min : readTime(minTime);
      max = timeBounds && maxTime.value === timeBounds.maxText ? timeBounds.max : readTime(maxTime);
      const invalid = !Number.isFinite(min) && min != null ? minTime : !maxTime.hidden && !Number.isFinite(max) && max != null ? maxTime : null;
      if (invalid) return refuse(invalid, t('validation.badTime'));
    }
    const ranged = ['number', 'whole', 'text', 'date', 'time'].includes(type);
    const dual = ['between', 'notBetween'].includes(comparison.value);
    if (ranged && (!dual || comparison.value === 'notBetween' || ['whole', 'time'].includes(type))) {
      if (min == null) return refuse(bounds[0], t('validation.noComparison'));
      if (dual && max == null) return refuse(bounds[1], t('validation.noSecondComparison'));
    }
    if (ranged && !dual) max = undefined;
    const badLength = (n) => n != null && (n < 0 || !Number.isInteger(n));
    if (type === 'text' && (badLength(min) || badLength(max))) return refuse(badLength(min) ? minInput : maxInput, t('validation.lengthNotWhole'));
    if (ranged && dual && min != null && max != null && min > max) return refuse(bounds[0], t('validation.minAboveMax'));
    clearError();
    const rule = {
      range, type,
      source: type === 'list' ? sourceForForm() : type === 'formula' ? formulaInput.value.trim() : undefined,
      chips: type === 'list' && chipsInput.checked ? true : undefined,
      colors: type === 'list' && chipsInput.checked && Object.keys(colors).length ? { ...colors } : undefined,
      min: ranged ? min : undefined,
      max: ranged ? max : undefined,
      strict: strictInput.checked,
      allowBlank: type === 'any' || blankInput.checked,
      message: messageInput.value.trim() || undefined,
      prompt: promptInput.value.trim() || undefined,
    };
    const previous = ctx.wb.sheet(sheetId)?.validations.find(v => v.id === editingId);
    // A dependent dropdown (=INDIRECT(A2)) reads each cell's own row; a rule that already did (one from Excel) keeps doing so.
    if (type === 'list' && previous?.relativeSource !== true && relativeListSource(rule.source)) rule.relativeSource = true;
    rule.operator = ranged ? previous && comparison.value === (previous.operator || 'between') ? previous.operator : comparison.value === 'between' ? undefined : comparison.value : undefined;
    // Untouched imported titles and explicit visibility flags retain their exact spelling/presence.
    for (const [key, input] of [['promptTitle', promptTitle], ['errorTitle', errorTitle]]) {
      rule[key] = previous && input.value === (previous[key] || '') ? previous[key] : input.value.trim() || undefined;
    }
    rule.showInputMessage = previous && showPrompt.checked === (previous.showInputMessage !== false)
      ? previous.showInputMessage : showPrompt.checked ? undefined : false;
    const previousAlert = previous?.strict !== false ? 'stop' : previous?.showErrorMessage !== false && ['warning', 'information'].includes(previous?.errorStyle) ? previous.errorStyle : 'none';
    if (strictInput.checked !== (previous?.strict !== false) || alertSelect.value !== previousAlert) {
      rule.errorStyle = strictInput.checked ? 'stop' : alertSelect.value === 'none' ? 'stop' : alertSelect.value;
      rule.showErrorMessage = strictInput.checked || alertSelect.value !== 'none';
    }
    for (const [key, shown] of Object.entries(implied)) if (key in rule && rule[key] === shown) rule[key] = undefined;
    const result = editingId ? ctx.wb.updateValidation(sheetId, editingId, rule) : ctx.wb.addValidation(sheetId, rule);
    if (!changed(result)) return;
    toast(editingId ? t('validation.updated') : t('validation.added'));
    resetForm();
    render();
  }

  function render() {
    clear(list);
    const rules = ctx.wb.sheet(sheetId)?.validations || [];
    ruleSummary.textContent = t('validation.rulesOnSheet', { count: rules.length });
    if (!rules.length) {
      list.append(el('p.small.muted', { style: { padding: '6px 2px' } }, t('validation.noRules')));
      return;
    }
    // Deleting rebuilds the rows; the focus goes to the row that took the deleted one's place, or to the range field.
    rules.forEach((rule, idx) => {
      list.append(el('div.names-row', { role: 'listitem' },
        el('button.names-main', { type: 'button', onclick: () => loadRule(rule) },
          el('span.menu-icon', { html: icon(rule.type === 'checkbox' ? 'check' : rule.type === 'list' ? 'chevUD' : rule.type === 'date' ? 'calendar' : rule.type === 'text' ? 'text' : rule.type === 'formula' ? 'fx' : 'number', 16) }),
          el('span.names-name', {}, rangeName(rule.range)),
          el('span.names-ref', {}, describeValidation(rule, { display: true }))),
        el('button.icon-btn', { type: 'button', html: icon('trash', 16), 'aria-label': t('validation.deleteRule', { range: rangeName(rule.range) }), dataset: { action: 'delete' }, onclick: () => { if (!changed(ctx.wb.deleteValidation(sheetId, rule.id))) return; if (editingId === rule.id) resetForm(); render(); focusListRow(list, idx, 'delete', rangeInput); } })));
    });
  }

  const messageField = el('label.field', {}, el('span.field-label', {}, t('validation.errorMessage')), messageInput);
  const promptField = el('label.field', {}, el('span.field-label', {}, t('validation.inputMessage')), promptInput);
  const saveBtn = el('button.btn.btn-primary', { type: 'submit' }, t('validation.addRule'));
  // Hiding the button it was pressed on would drop the focus to the page: it goes to the form's first field, as in Named ranges.
  const cancelEdit = el('button.btn.btn-ghost', { type: 'button', hidden: true, onclick: () => { resetForm(); rangeInput.focus(); } }, t('validation.cancelEdit'));
  // The number and date fields are hidden for most types; an unreadable value left in one would fail the
  // browser's own check silently, with nowhere to show its bubble. submit() checks the shown ones itself.
  const settingsPanel = el('div.dv-panel', { dataset: { key: 'settings' } },
    el('div.names-fields', {},
      el('label.field', {}, el('span.field-label', {}, t('validation.applyTo')), rangeInput),
      el('label.field', {}, el('span.field-label', {}, t('validation.type')), el('div.select-wrap', {}, typeSelect))),
    listField,
    chipsField,
    comparisonField,
    numberField,
    dateField,
    timeField,
    formulaField,
    el('label.find-option', { for: blankId }, blankInput, el('span', {}, t('validation.allowBlank'))));
  const promptPanel = el('div.dv-panel', { dataset: { key: 'prompt' } },
    el('label.find-option', { for: showPromptId }, showPrompt, el('span', {}, t('validation.showPrompt'))),
    el('label.field', {}, el('span.field-label', {}, t('validation.title')), promptTitle), promptField);
  const errorPanel = el('div.dv-panel', { dataset: { key: 'error' } }, optionsBlock,
    el('label.field', {}, el('span.field-label', {}, t('validation.title')), errorTitle), messageField);
  const panels = { settings: settingsPanel, prompt: promptPanel, error: errorPanel };
  let activeTab = 'settings';
  const tabId = fieldId('dv-tabs');
  for (const [key, panel] of Object.entries(panels)) {
    panel.id = `${tabId}-${key}-panel`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `${tabId}-${key}`);
  }
  const tabs = el('div.seg.dv-tabs', { role: 'tablist', 'aria-label': t('validation.tabsLabel') },
    [['settings', t('validation.tab.settings')], ['prompt', t('validation.tab.prompt')], ['error', t('validation.tab.error')]].map(([key, label]) => el('button.seg-btn', {
      type: 'button', role: 'tab', id: `${tabId}-${key}`, dataset: { key }, 'aria-controls': panels[key].id,
      onclick: () => { activeTab = key; syncTabs(); },
    }, label)));
  function syncTabs() {
    for (const button of tabs.children) {
      button.setAttribute('aria-selected', String(button.dataset.key === activeTab));
      button.tabIndex = button.dataset.key === activeTab ? 0 : -1;
    }
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== activeTab;
  }
  tabs.addEventListener('keydown', (e) => {
    if (isComposing(e) || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const available = [...tabs.children].filter(button => !button.disabled);
    const current = available.indexOf(e.target);
    if (current < 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      panels[activeTab].querySelector('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')?.focus();
      return;
    }
    const next = e.key === 'ArrowRight' ? (current + 1) % available.length
      : e.key === 'ArrowLeft' ? (current + available.length - 1) % available.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? available.length - 1 : null;
    if (next == null) return;
    e.preventDefault(); e.stopPropagation();
    activeTab = available[next].dataset.key;
    syncTabs(); available[next].focus();
  });
  const form = el('form.cf-form.dv-form', { onsubmit: submit, novalidate: true }, tabs,
    el('div.dv-panels', {}, settingsPanel, promptPanel, errorPanel),
    error,
    el('div.row.row-end.dv-actions', {}, cancelEdit,
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.done')), saveBtn));
  const ruleSummary = el('summary');
  const rulesDetails = el('details.dv-rules', {}, ruleSummary, list);
  typeSelect.value = type || 'list';
  syncType();

  // Opened for one kind of rule (Insert dropdown): start ready to type its options.
  const modal = openModal({ title: t('validation.dialogTitle'), content: el('div.dv-body', {}, rulesDetails, form), wide: true, className: 'dv-dialog', initialFocus: type ? (type === 'list' ? sourceInput : rangeInput) : null, onClose: () => ctx.grid?.focus?.() });
  resetForm();
  render();
  // Opened on cells that already have a rule, the dialog shows that rule to change, as Excel's does, rather than
  // an empty form whose Add rule would lay a second rule over the first.
  const selection = ctx.range(), at = ctx.active?.();
  const current = !type && at ? ctx.wb.validationAt(sheetId, at.r, at.c) : null;
  if (current && selection.r1 >= current.range.r1 && selection.r2 <= current.range.r2 && selection.c1 >= current.range.c1 && selection.c2 <= current.range.c2) {
    rulesDetails.open = true;
    // The focus stays where the dialog put it (no keyboard springs up on a phone); loadRule moves it for a click.
    const focused = document.activeElement;
    loadRule(current);
    focused?.focus?.();
  }
  return modal;
}
