/**
 * Print options: what to print, how to orient and scale it, and what to
 * show around the cells. Choices are remembered for next time.
 */

import { el, fieldId, isComposing } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { printSheet, PRINT_DEFAULTS, PAPER_SIZES, MARGINS, supportsPageMarginBoxes, sheetPrintPrefs, printSettingsFromPrefs, printableWidth, printableHeight } from './print.js';
import { toast } from './toast.js';
import { rangeName, colName } from '../core/cell.js';
import { parseRefText } from '../core/refs.js';
import { getLocale } from '../core/format.js';
import * as S from '../core/selection.js';
import { accountStorageKey } from '../lib/account-storage.js';
import { createPrintPreview } from './print-preview.js';

const STORAGE_KEY = 'spreadsheet:print';

function loadPrefs(key) {
  try { return { ...PRINT_DEFAULTS, ...(JSON.parse(localStorage.getItem(key) || '{}') || {}) }; } catch { return { ...PRINT_DEFAULTS }; }
}

function savePrefs(key, prefs) {
  try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* no storage */ }
}

/** The saved print preferences of this account, as the dialog would start from them. */
export function currentPrintPrefs(sheet) {
  const prefs = { ...loadPrefs(accountStorageKey(STORAGE_KEY)), ...sheetPrintPrefs(sheet) };
  if (prefs.area === 'selection') prefs.area = 'sheet';
  return prefs;
}

export function openPrintDialog(ctx) {
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return;
  const sheetId = ctx.sheetId();
  const sheet = ctx.wb.sheet(sheetId);
  const chartSheet = sheet.kind === 'chart';
  const range = ctx.range();
  const hasSelection = !chartSheet && !S.isSingle(ctx.selection());
  const storageKey = accountStorageKey(STORAGE_KEY);
  const prefs = { ...loadPrefs(storageKey), ...sheetPrintPrefs(sheet) };
  const visibleSheets = ctx.wb.sheets.filter((sh) => !sh.hidden).length;
  if (!hasSelection && prefs.area === 'selection' || prefs.area === 'workbook' && visibleSheets < 2) prefs.area = sheet.printSettings?.areas.length ? 'printArea' : 'sheet';

  const radios = (name, label, options, value) => {
    const group = el('div.seg', { role: 'radiogroup', 'aria-label': label });
    for (const [key, text, disabled] of options) {
      group.append(el('button.seg-btn', {
        type: 'button', role: 'radio', 'aria-checked': String(value() === key), disabled: !!disabled, dataset: { key },
        onclick: () => { prefs[name] = key; sync(); },
      }, text));
    }
    // One tab stop per group, the arrow keys moving the choice, as the app's other radio groups work.
    group.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      const step = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 0;
      if (!step) return;
      const buttons = [...group.querySelectorAll('.seg-btn:not([disabled])')];
      const index = buttons.indexOf(e.target.closest('[role="radio"]'));
      if (index < 0) return;
      e.preventDefault();
      const next = buttons[(index + step + buttons.length) % buttons.length];
      next.click();
      next.focus();
    });
    return group;
  };
  const areaSeg = radios('area', 'Print', [
    ...(!chartSheet && sheet.printSettings?.areas.length ? [['printArea', 'Print area']] : []),
    ['sheet', 'This sheet'],
    ...(!chartSheet ? [['selection', hasSelection ? `Selection (${rangeName(range)})` : 'Selection', !hasSelection]] : []),
    ['workbook', `All sheets (${visibleSheets})`, visibleSheets < 2],
  ], () => prefs.area);
  const orientSeg = radios('orientation', 'Orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']], () => prefs.orientation);
  const fitSeg = radios('fit', 'Scale', [['width', 'Fit to page width'], ['actual', 'Actual size'], ['scale', 'Custom'], ['pages', 'Fit to pages']], () => prefs.fit);
  const scaleErrorId = fieldId('print');
  const scaleError = el('p.field-error', { id: scaleErrorId, hidden: true, role: 'alert' });
  const scaleInput = el('input.input.input-sm', {
    type: 'number', min: 10, max: 400, step: 5, value: prefs.scale || 100, 'aria-label': 'Scale percent', 'aria-describedby': scaleErrorId,
    // A changed value is no longer the one refused: the mark and the message go until the next Print.
    oninput: () => { scaleError.hidden = true; scaleInput.removeAttribute('aria-invalid'); const n = Number(scaleInput.value); if (n >= 10 && n <= 400) prefs.scale = n; },
  });
  const scaleField = el('label.print-scale', {}, scaleInput, el('span', {}, '%'));
  const pageInputs = ['fitWidth', 'fitHeight'].map((key, i) => el('input.input.input-sm', {
    type: 'number', min: 0, max: 32767, step: 1, value: prefs[key] ?? 1, 'aria-label': i ? 'Pages tall' : 'Pages wide',
    oninput: e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 32767) prefs[key] = n; },
  }));
  const pagesField = el('div.field', {}, el('div.row.row-2', {}, pageInputs.map((input, i) => el('label.field', {}, el('span.field-label', {}, i ? 'Pages tall' : 'Pages wide'), input))), el('span.small.muted', {}, 'Use 0 for automatic.'));
  const marginsSeg = radios('margins', 'Margins', [...MARGINS.map(([k, label]) => [k, label]), ['custom', 'Custom']], () => prefs.margins);
  const marginInputs = ['top', 'right', 'bottom', 'left'].map(key => el('input.input.input-sm', {
    type: 'number', min: 0, max: 100, step: 'any', value: prefs.customMargins?.[key] ?? .5, 'aria-label': `${key[0].toUpperCase() + key.slice(1)} margin in inches`,
    oninput: e => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0 && n <= 100) (prefs.customMargins ||= {})[key] = n; },
  }));
  const marginField = el('div.row', {}, marginInputs.map((input, i) => el('label.field', {}, el('span.small', {}, ['Top', 'Right', 'Bottom', 'Left'][i] + ' (in)'), input)));
  const layoutError = fieldAlert('print-layout');
  const titleError = fieldAlert('print-titles');
  const titleInputs = ['titleRows', 'titleCols'].map((key, i) => el('input.input', {
    type: 'text', value: prefs[key]?.map(n => i ? colName(n) : n + 1).join(':') || '',
    'aria-label': i ? 'Columns to repeat at left' : 'Rows to repeat at top', placeholder: i ? 'A:C' : '1:3',
    oninput: () => { titleError.clear(); sync(); },
  }));
  const titleFields = el('div.field', {}, el('div.row.row-2', {}, titleInputs.map((input, i) =>
    el('label.field', {}, el('span.field-label', {}, i ? 'Columns to repeat at left' : 'Rows to repeat at top'), input))), titleError.alert);
  const paperSel = el('select.input', { 'aria-label': 'Paper size', onchange: () => { prefs.paper = paperSel.value; } },
    ...PAPER_SIZES.map(([k, label]) => el('option', { value: k }, label)));
  paperSel.value = PAPER_SIZES.some(([k]) => k === prefs.paper) ? prefs.paper : 'letter';
  const marginBoxes = supportsPageMarginBoxes();
  const headerInput = el('input.input', { type: 'text', value: prefs.header || '', placeholder: prefs.native ? 'None' : marginBoxes ? 'Nothing (the title prints above the cells)' : (ctx.doc?.name || 'Document title'), 'aria-label': 'Header text', maxlength: 120, oninput: () => { prefs.header = headerInput.value; } });
  const footerInput = el('input.input', { type: 'text', value: prefs.footer || '', placeholder: prefs.native ? 'None' : marginBoxes ? 'Page &[Page] of &[Pages]' : `Today’s date (${new Date().toLocaleDateString(getLocale())})`, 'aria-label': 'Footer text', maxlength: 120, oninput: () => { prefs.footer = footerInput.value; } });
  // Token chips type into whichever of the two fields was used last.
  let tokenTarget = footerInput;
  headerInput.addEventListener('focus', () => { tokenTarget = headerInput; });
  footerInput.addEventListener('focus', () => { tokenTarget = footerInput; });
  const variantFields = ['first', 'even'].map(prefix => {
    const label = prefix === 'first' ? 'First page' : 'Even pages';
    const flag = prefix === 'first' ? 'differentFirst' : 'differentOddEven';
    const fields = el('div.row.row-2', {}, ['Header', 'Footer'].map(kind => {
      const key = prefix + kind;
      const input = el('input.input', { type: 'text', value: prefs[key] || '', maxlength: 255,
        placeholder: 'None', 'aria-label': `${label} ${kind.toLowerCase()} text`,
        oninput: () => { prefs[key] = input.value; }, onfocus: () => { tokenTarget = input; } });
      return el('label.field', {}, el('span.field-label', {}, `${label} ${kind.toLowerCase()}`), input);
    }));
    const toggle = el('input', { type: 'checkbox', checked: !!prefs[flag], onchange: () => { prefs[flag] = toggle.checked; sync(); } });
    const control = el('div.field', {}, el('label.check', {}, toggle,
      el('span', {}, prefix === 'first' ? 'Different first page' : 'Different odd and even pages')), fields);
    return { control, fields, flag };
  });
  const insertToken = (token) => {
    const input = tokenTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + token + input.value.slice(end);
    input.dispatchEvent(new Event('input'));
    input.focus();
    input.setSelectionRange(start + token.length, start + token.length);
  };
  const TOKENS = [['&[Page]', 'Page number'], ['&[Pages]', 'Page count'], ['&[Date]', 'Date'], ['&[Time]', 'Time'], ['&[Tab]', 'Sheet name'], ['&[File]', 'File name']];
  const tokenRow = el('div.print-tokens', { role: 'group', 'aria-label': 'Insert into the header or footer' },
    el('span.small.muted', {}, 'Insert:'),
    TOKENS.map(([token, label]) => el('button.btn.btn-ghost.btn-sm', { type: 'button', title: `Insert ${token}`, onmousedown: (e) => e.preventDefault(), onclick: () => insertToken(token) }, label)),
    el('span.small.muted.print-tokens-hint', {}, marginBoxes
      ? '&L, &C, and &R start the left, center, and right parts.'
      : 'Page numbers are unavailable in this browser. &L, &C, and &R align the text.'));
  const check = (name, label, note) => {
    const input = el('input', { type: 'checkbox', checked: !!prefs[name], onchange: () => { prefs[name] = input.checked; } });
    return el('label.check', {}, input, el('span', {}, label, note && el('span.muted', {}, ` ${note}`)));
  };
  const frozenNote = sheet.frozenRows ? `(${sheet.frozenRows} frozen row${sheet.frozenRows === 1 ? '' : 's'})` : '(no frozen rows)';

  const frozenCheck = check('repeatFrozen', 'Repeat frozen rows on every page', frozenNote);
  function sync() {
    for (const { fields, flag } of variantFields) {
      fields.hidden = !prefs[flag];
      if (fields.hidden && fields.contains(tokenTarget)) tokenTarget = footerInput;
    }
    frozenCheck.querySelector('input').disabled = !!titleInputs[0].value.trim();
    frozenCheck.title = titleInputs[0].value.trim() ? 'Rows to repeat at top take precedence.' : '';

    for (const [seg, name] of [[areaSeg, 'area'], [orientSeg, 'orientation'], [fitSeg, 'fit'], [marginsSeg, 'margins']]) {
      const buttons = [...seg.querySelectorAll('.seg-btn')];
      for (const b of buttons) {
        const on = b.dataset.key === prefs[name];
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      // A remembered choice that is not offered leaves the group's first option reachable.
      if (!buttons.some((b) => b.tabIndex === 0 && !b.disabled)) { const first = buttons.find((b) => !b.disabled); if (first) first.tabIndex = 0; }
    }
    scaleField.hidden = prefs.fit !== 'scale';
    pagesField.hidden = chartSheet || prefs.fit !== 'pages';
    marginField.hidden = prefs.margins !== 'custom';
    preview?.refresh();
  }
  // Beside the choices, the pages as they will print, following each change (not for a chart sheet, which is one page).
  const preview = chartSheet ? null : createPrintPreview({ wb: ctx.wb, sheetId, docName: ctx.doc?.name, getPrefs: () => prefs, getRange: () => range });

  const controller = new AbortController();
  let preparing = false;
  const submit = async (e) => {
    e?.preventDefault();
    if (preparing || controller.signal.aborted) return;
    for (const input of [...(prefs.fit === 'pages' ? pageInputs : []), ...(prefs.margins === 'custom' ? marginInputs : [])]) {
      if (!input.value.trim() || !input.checkValidity()) {
        layoutError.refuse(input, pageInputs.includes(input) ? 'Enter a whole number from 0 to 32767.' : 'Enter a margin from 0 to 100 inches.');
        return;
      }
    }
    if (prefs.fit === 'scale') {
      // A scale outside the range is refused beside the field, as every other dialog refuses a bad value, rather than clamped and printed.
      const n = scaleInput.value.trim() === '' ? NaN : Number(scaleInput.value);
      if (!(n >= 10 && n <= 400)) {
        scaleError.textContent = 'Scale is 10 to 400 percent';
        scaleError.hidden = false;
        scaleInput.setAttribute('aria-invalid', 'true');
        scaleInput.focus();
        return;
      }
      prefs.scale = n;
    }
    if (prefs.fit === 'pages') { prefs.fitWidth = Number(pageInputs[0].value); prefs.fitHeight = Number(pageInputs[1].value); }
    if (prefs.margins === 'custom') prefs.customMargins = { ...prefs.customMargins, ...Object.fromEntries(['top', 'right', 'bottom', 'left'].map((k, i) => [k, Number(marginInputs[i].value)])) };
    if (prefs.margins === 'custom' && (printableWidth(prefs) <= 1 || printableHeight(prefs) <= 1)) {
      layoutError.refuse(marginInputs[printableWidth(prefs) <= 1 ? 3 : 0], 'The margins must leave room on the page for your sheet.');
      return;
    }
    if (!chartSheet) for (const [i, input] of titleInputs.entries()) {
      const text = input.value.trim(), ref = text ? parseRefText(text) : null;
      if (text && (!ref || ref.sheet || ref.sheetEnd || ref.kind !== (i ? 'cols' : 'rows'))) {
        titleError.refuse(input, i ? 'Enter a column range, such as A:C, or leave this blank.' : 'Enter a row range, such as 1:3, or leave this blank.');
        return;
      }
      prefs[i ? 'titleCols' : 'titleRows'] = ref ? i ? [ref.c1, ref.c2] : [ref.r1, ref.r2] : null;
    }
    const { area, native, titleRows, titleCols, ...remembered } = prefs;
    savePrefs(storageKey, remembered);
    if (sheet.printSettings || prefs.titleRows || prefs.titleCols) ctx.wb.setPrintSettings(sheetId, printSettingsFromPrefs(sheet, prefs));
    preparing = true;
    const button = content.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = 'Preparing…';
    content.setAttribute('aria-busy', 'true');
    const ok = await printSheet(ctx.wb, sheetId, ctx.doc?.name, { ...prefs, range: area === 'selection' ? range : null, signal: controller.signal });
    preparing = false;
    button.disabled = false;
    button.textContent = 'Print';
    content.removeAttribute('aria-busy');
    if (controller.signal.aborted) return;
    if (ok) modal.close();
    else toast('Printing is not available here', { icon: 'alert' });
  };

  // The scale field is hidden unless Custom is chosen; the browser must not check it then.
  const settings = el('div.print-settings', {},
    el('div.field', {}, el('span.field-label', {}, 'Print'), areaSeg),
    el('div.row.row-2', {},
      el('div.field', {}, el('span.field-label', {}, 'Orientation'), orientSeg),
      el('label.field', {}, el('span.field-label', {}, 'Paper size'), paperSel)),
    chartSheet ? el('p.small.muted', {}, 'The chart fits on one page.') : el('div.field', {}, el('span.field-label', {}, 'Scale'), el('div.row', {}, fitSeg, scaleField), scaleError),
    pagesField,
    el('div.field', {}, el('span.field-label', {}, 'Margins'), marginsSeg, marginField, layoutError.alert),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, 'Header'), headerInput),
      el('label.field', {}, el('span.field-label', {}, 'Footer'), footerInput)),
    ...variantFields.map(({ control }) => control),
    tokenRow,
    !chartSheet && titleFields,
    !chartSheet && el('div.field.print-checks', {},
      check('gridlines', 'Gridlines'),
      check('headers', 'Row numbers and column letters'),
      frozenCheck,
      check('horizontalCentered', 'Center horizontally'),
      check('verticalCentered', 'Center vertically'),
      check('title', 'Title and sheet name')));
  const content = el('form.print-form', { onsubmit: submit, novalidate: true },
    el('div.print-layout', {}, settings, preview?.el),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Print')));
  // Before the modal opens, as the chart dialog does: it starts on the first control that is in the
  // tab order, and until sync() has laid the roving tabindex over the groups every option is, so the
  // dialog would open on an unchecked radio the Tab trap then bounces to the Close button.
  sync();
  if (preview) { content.addEventListener('input', preview.refresh); content.addEventListener('change', preview.refresh); }
  const modal = openModal({ title: 'Print', content, wide: true, className: preview ? 'print-dialog' : '', onClose: () => { controller.abort(); ctx.grid.focus(); } });
  preview?.refresh();
  return modal;
}
