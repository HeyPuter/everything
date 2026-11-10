/**
 * Print options: what to print, how to orient and scale it, and what to
 * show around the cells. Choices are remembered for next time.
 */

import { el, fieldId, isComposing } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { printSheet, printFolder, PAPER_SIZES, MARGINS, defaultPrintFooter, supportsPageMarginBoxes, sheetPrintPrefs, printSettingsFromPrefs, printableWidth, printableHeight, savedPrintPrefs, savePrintPrefs } from './print.js';
import { toast } from './toast.js';
import { rangeName, colName } from '../core/cell.js';
import { parseRefText } from '../core/refs.js';
import { getLocale } from '../core/format.js';
import * as S from '../core/selection.js';
import { createPrintPreview } from './print-preview.js';
import { resolvedAbsolutePath } from '../lib/puter.js';
import { sectionEditText, sectionStoredText } from './page-layout.js';
import { t } from '../i18n/index.js';

/** The saved print preferences of this account, as the dialog would start from them. */
export function currentPrintPrefs(sheet) {
  const prefs = { ...savedPrintPrefs(), ...sheetPrintPrefs(sheet) };
  if (prefs.area === 'selection') prefs.area = 'sheet';
  return prefs;
}

export function openPrintDialog(ctx) {
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return;
  const sheetId = ctx.sheetId();
  const sheet = ctx.wb.sheet(sheetId);
  const chartSheet = sheet.kind === 'chart';
  const range = ctx.range();
  // Every range of the selection (Ctrl+click adds them), the one selected last among them; each prints on pages of its own.
  const ranges = (ctx.ranges?.() || [range]).map((rg) => ({ ...rg }));
  const hasSelection = !chartSheet && (ranges.length > 1 || !S.isSingle(ctx.selection()));
  const selectionName = ranges.length > 3 ? t('printdialog.rangeCount', { count: ranges.length }) : ranges.map(rangeName).join(', ');
  const prefs = { ...savedPrintPrefs(), ...sheetPrintPrefs(sheet) };
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
  const areaSeg = radios('area', t('printdialog.print'), [
    ...(!chartSheet && sheet.printSettings?.areas.length ? [['printArea', t('printdialog.area.printArea')]] : []),
    ['sheet', t('printdialog.area.sheet')],
    ...(!chartSheet ? [['selection', hasSelection ? t('printdialog.area.selectionOf', { name: selectionName }) : t('printdialog.area.selection'), !hasSelection]] : []),
    ['workbook', t('printdialog.area.allSheets', { count: visibleSheets }), visibleSheets < 2],
  ], () => prefs.area);
  const orientSeg = radios('orientation', t('printdialog.orientation'), [['portrait', t('printdialog.portrait')], ['landscape', t('printdialog.landscape')]], () => prefs.orientation);
  const fitSeg = radios('fit', t('printdialog.scale'), [['width', t('printdialog.fit.width')], ['actual', t('printdialog.fit.actual')], ['scale', t('common.custom')], ['pages', t('printdialog.fit.pages')]], () => prefs.fit);
  const scaleErrorId = fieldId('print');
  const scaleError = el('p.field-error', { id: scaleErrorId, hidden: true, role: 'alert' });
  const scaleInput = el('input.input.input-sm', {
    type: 'number', min: 10, max: 400, step: 5, value: prefs.scale || 100, 'aria-label': t('printdialog.scalePercent'), 'aria-describedby': scaleErrorId,
    // A changed value is no longer the one refused: the mark and the message go until the next Print.
    oninput: () => { scaleError.hidden = true; scaleInput.removeAttribute('aria-invalid'); const n = Number(scaleInput.value); if (n >= 10 && n <= 400) prefs.scale = n; },
  });
  const scaleField = el('label.print-scale', {}, scaleInput, el('span', {}, '%'));
  const pageInputs = ['fitWidth', 'fitHeight'].map((key, i) => el('input.input.input-sm', {
    type: 'number', min: 0, max: 32767, step: 1, value: prefs[key] ?? 1, 'aria-label': i ? t('printdialog.pagesTall') : t('printdialog.pagesWide'),
    oninput: e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= 32767) prefs[key] = n; },
  }));
  const pagesField = el('div.field', {}, el('div.row.row-2', {}, pageInputs.map((input, i) => el('label.field', {}, el('span.field-label', {}, i ? t('printdialog.pagesTall') : t('printdialog.pagesWide')), input))), el('span.small.muted', {}, t('printdialog.zeroAutomatic')));
  const marginsSeg = radios('margins', t('printdialog.margins'), [...MARGINS.map(([k, label]) => [k, t(label)]), ['custom', t('common.custom')]], () => prefs.margins);
  const MARGIN_LABELS = { top: 'printdialog.margin.top', right: 'printdialog.margin.right', bottom: 'printdialog.margin.bottom', left: 'printdialog.margin.left' };
  const MARGIN_SHORT = { top: 'printdialog.marginShort.top', right: 'printdialog.marginShort.right', bottom: 'printdialog.marginShort.bottom', left: 'printdialog.marginShort.left' };
  const marginInputs = ['top', 'right', 'bottom', 'left'].map(key => el('input.input.input-sm', {
    type: 'number', min: 0, max: 100, step: 'any', value: prefs.customMargins?.[key] ?? .5, 'aria-label': t(MARGIN_LABELS[key]),
    oninput: e => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 0 && n <= 100) (prefs.customMargins ||= {})[key] = n; },
  }));
  const marginField = el('div.row', {}, marginInputs.map((input, i) => el('label.field', {}, el('span.small', {}, t(MARGIN_SHORT[['top', 'right', 'bottom', 'left'][i]])), input)));
  const layoutError = fieldAlert('print-layout');
  const titleError = fieldAlert('print-titles');
  const titleInputs = ['titleRows', 'titleCols'].map((key, i) => el('input.input', {
    type: 'text', value: prefs[key]?.map(n => i ? colName(n) : n + 1).join(':') || '',
    'aria-label': i ? t('printdialog.titleCols') : t('printdialog.titleRows'), placeholder: i ? 'A:C' : '1:3',
    oninput: (e) => {
      titleError.clear();
      // The preview repeats the lines as they are typed; one that does not read yet changes nothing until Print says why.
      const text = e.target.value.trim(), ref = text ? parseRefText(text) : null;
      if (!text) prefs[key] = null;
      else if (ref && !ref.sheet && !ref.sheetEnd && ref.kind === (i ? 'cols' : 'rows')) prefs[key] = i ? [ref.c1, ref.c2] : [ref.r1, ref.r2];
      sync();
    },
  }));
  const titleFields = el('div.field', {}, el('div.row.row-2', {}, titleInputs.map((input, i) =>
    el('label.field', {}, el('span.field-label', {}, i ? t('printdialog.titleCols') : t('printdialog.titleRows')), input))), titleError.alert);
  const paperSel = el('select.select', { 'aria-label': t('printdialog.paperSize'), onchange: () => { prefs.paper = paperSel.value; } },
    ...PAPER_SIZES.map(([k, label]) => el('option', { value: k }, t(label))));
  paperSel.value = PAPER_SIZES.some(([k]) => k === prefs.paper) ? prefs.paper : 'letter';
  const marginBoxes = supportsPageMarginBoxes();
  // The header and footer are typed as they read, fields as &[Page] and an ampersand as itself (see sectionStoredText);
  // what is typed is kept as the file keeps it, in prefs, where the preview and the print read it.
  const original = { ...prefs };
  const stored = (key, input) => { prefs[key] = sectionStoredText(input.value, original[key] || '', { sections: true }); };
  const headerInput = el('input.input', { type: 'text', value: sectionEditText(prefs.header || ''), placeholder: prefs.native ? t('common.none') : marginBoxes ? t('printdialog.headerNothing') : (ctx.doc?.name || t('printdialog.documentTitle')), 'aria-label': t('printdialog.headerText'), maxlength: 255, oninput: () => stored('header', headerInput) });
  const footerInput = el('input.input', { type: 'text', value: sectionEditText(prefs.footer || ''), placeholder: prefs.native ? t('common.none') : marginBoxes ? defaultPrintFooter() : t('printdialog.todaysDate', { date: new Date().toLocaleDateString(getLocale()) }), 'aria-label': t('printdialog.footerText'), maxlength: 255, oninput: () => stored('footer', footerInput) });
  // Token chips type into whichever of the two fields was used last.
  let tokenTarget = footerInput;
  headerInput.addEventListener('focus', () => { tokenTarget = headerInput; });
  footerInput.addEventListener('focus', () => { tokenTarget = footerInput; });
  // Each variant field's label and its input's accessible name, as catalog keys.
  const VARIANT_LABELS = {
    firstHeader: ['printdialog.variant.firstHeader', 'printdialog.variant.firstHeaderText'],
    firstFooter: ['printdialog.variant.firstFooter', 'printdialog.variant.firstFooterText'],
    evenHeader: ['printdialog.variant.evenHeader', 'printdialog.variant.evenHeaderText'],
    evenFooter: ['printdialog.variant.evenFooter', 'printdialog.variant.evenFooterText'],
  };
  const variantFields = ['first', 'even'].map(prefix => {
    const flag = prefix === 'first' ? 'differentFirst' : 'differentOddEven';
    const fields = el('div.row.row-2', {}, ['Header', 'Footer'].map(kind => {
      const key = prefix + kind;
      const [labelKey, textKey] = VARIANT_LABELS[key];
      const input = el('input.input', { type: 'text', value: sectionEditText(prefs[key] || ''), maxlength: 255,
        placeholder: t('common.none'), 'aria-label': t(textKey),
        oninput: () => stored(key, input), onfocus: () => { tokenTarget = input; } });
      return el('label.field', {}, el('span.field-label', {}, t(labelKey)), input);
    }));
    const toggle = el('input', { type: 'checkbox', checked: !!prefs[flag], onchange: () => { prefs[flag] = toggle.checked; sync(); } });
    const control = el('div.field', {}, el('label.check', {}, toggle,
      el('span', {}, prefix === 'first' ? t('printdialog.differentFirst') : t('printdialog.differentOddEven'))), fields);
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
  const TOKENS = [['&[Page]', 'printdialog.token.page'], ['&[Pages]', 'printdialog.token.pages'], ['&[Date]', 'printdialog.token.date'], ['&[Time]', 'printdialog.token.time'], ['&[Tab]', 'printdialog.token.tab'], ['&[File]', 'printdialog.token.file']];
  const tokenRow = el('div.print-tokens', { role: 'group', 'aria-label': t('printdialog.insertGroup') },
    el('span.small.muted', {}, t('printdialog.insertLabel')),
    TOKENS.map(([token, label]) => el('button.btn.btn-ghost.btn-sm', { type: 'button', title: t('printdialog.insertToken', { token }), onmousedown: (e) => e.preventDefault(), onclick: () => insertToken(token) }, t(label))),
    el('span.small.muted.print-tokens-hint', {}, marginBoxes
      ? t('printdialog.sectionsHint')
      : t('printdialog.noPageNumbersHint')));
  const check = (name, label, note) => {
    const input = el('input', { type: 'checkbox', checked: !!prefs[name], onchange: () => { prefs[name] = input.checked; } });
    return el('label.check', {}, input, el('span', {}, label, note && el('span.muted', {}, ` ${note}`)));
  };
  const frozenNote = sheet.frozenRows ? t('printdialog.frozenRows', { count: sheet.frozenRows }) : t('printdialog.noFrozenRows');

  const frozenCheck = check('repeatFrozen', t('printdialog.repeatFrozen'), frozenNote);
  function sync() {
    for (const { fields, flag } of variantFields) {
      fields.hidden = !prefs[flag];
      if (fields.hidden && fields.contains(tokenTarget)) tokenTarget = footerInput;
    }
    frozenCheck.querySelector('input').disabled = !!titleInputs[0].value.trim();
    frozenCheck.title = titleInputs[0].value.trim() ? t('printdialog.titleRowsPrecedence') : '';

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
  // The folder the file is in, for &[Path] in the header or footer.
  const filePath = printFolder(resolvedAbsolutePath(ctx.doc?.path));
  const preview = chartSheet ? null : createPrintPreview({ wb: ctx.wb, sheetId, docName: ctx.doc?.name, filePath, getPrefs: () => prefs, getRange: () => ranges });

  const controller = new AbortController();
  let preparing = false;
  const submit = async (e) => {
    e?.preventDefault();
    if (preparing || controller.signal.aborted) return;
    for (const input of [...(prefs.fit === 'pages' ? pageInputs : []), ...(prefs.margins === 'custom' ? marginInputs : [])]) {
      if (!input.value.trim() || !input.checkValidity()) {
        layoutError.refuse(input, pageInputs.includes(input) ? t('printdialog.error.pages') : t('printdialog.error.margin'));
        return;
      }
    }
    if (prefs.fit === 'scale') {
      // A scale outside the range is refused beside the field, as every other dialog refuses a bad value, rather than clamped and printed.
      const n = scaleInput.value.trim() === '' ? NaN : Number(scaleInput.value);
      if (!(n >= 10 && n <= 400)) {
        scaleError.textContent = t('printdialog.error.scale');
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
      layoutError.refuse(marginInputs[printableWidth(prefs) <= 1 ? 3 : 0], t('printdialog.error.marginsTooLarge'));
      return;
    }
    if (!chartSheet) for (const [i, input] of titleInputs.entries()) {
      const text = input.value.trim(), ref = text ? parseRefText(text) : null;
      if (text && (!ref || ref.sheet || ref.sheetEnd || ref.kind !== (i ? 'cols' : 'rows'))) {
        titleError.refuse(input, i ? t('printdialog.error.titleCols') : t('printdialog.error.titleRows'));
        return;
      }
      prefs[i ? 'titleCols' : 'titleRows'] = ref ? i ? [ref.c1, ref.c2] : [ref.r1, ref.r2] : null;
    }
    const { area, native, titleRows, titleCols, ...remembered } = prefs;
    savePrintPrefs(remembered);
    if (sheet.printSettings || prefs.titleRows || prefs.titleCols) ctx.wb.setPrintSettings(sheetId, printSettingsFromPrefs(sheet, prefs));
    preparing = true;
    const button = content.querySelector('[type="submit"]');
    button.disabled = true;
    button.textContent = t('printdialog.preparing');
    content.setAttribute('aria-busy', 'true');
    const ok = await printSheet(ctx.wb, sheetId, ctx.doc?.name, { ...prefs, range: area === 'selection' ? range : null, ranges: area === 'selection' ? ranges : null, filePath, signal: controller.signal });
    preparing = false;
    button.disabled = false;
    button.textContent = t('printdialog.print');
    content.removeAttribute('aria-busy');
    if (controller.signal.aborted) return;
    if (ok) modal.close();
    else toast(t('printdialog.unavailable'), { icon: 'alert' });
  };

  // The scale field is hidden unless Custom is chosen; the browser must not check it then.
  const settings = el('div.print-settings', {},
    el('div.field', {}, el('span.field-label', {}, t('printdialog.print')), areaSeg),
    el('div.row.row-2', {},
      el('div.field', {}, el('span.field-label', {}, t('printdialog.orientation')), orientSeg),
      el('label.field', {}, el('span.field-label', {}, t('printdialog.paperSize')), paperSel)),
    chartSheet ? el('p.small.muted', {}, t('printdialog.chartFits')) : el('div.field', {}, el('span.field-label', {}, t('printdialog.scale')), el('div.row', {}, fitSeg, scaleField), scaleError),
    pagesField,
    el('div.field', {}, el('span.field-label', {}, t('printdialog.margins')), marginsSeg, marginField, layoutError.alert),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, t('printdialog.header')), headerInput),
      el('label.field', {}, el('span.field-label', {}, t('printdialog.footer')), footerInput)),
    ...variantFields.map(({ control }) => control),
    tokenRow,
    !chartSheet && titleFields,
    !chartSheet && el('div.field.print-checks', {},
      check('gridlines', t('printdialog.gridlines')),
      check('headers', t('printdialog.headings')),
      frozenCheck,
      check('horizontalCentered', t('printdialog.centerHorizontally')),
      check('verticalCentered', t('printdialog.centerVertically')),
      check('title', t('printdialog.titleAndSheet'))));
  const content = el('form.print-form', { onsubmit: submit, novalidate: true },
    el('div.print-layout', {}, settings, preview?.el),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('printdialog.print'))));
  // Before the modal opens, as the chart dialog does: it starts on the first control that is in the
  // tab order, and until sync() has laid the roving tabindex over the groups every option is, so the
  // dialog would open on an unchecked radio the Tab trap then bounces to the Close button.
  sync();
  if (preview) { content.addEventListener('input', preview.refresh); content.addEventListener('change', preview.refresh); }
  const modal = openModal({ title: t('printdialog.print'), content, wide: true, className: preview ? 'print-dialog' : '', onClose: () => { controller.abort(); preview?.destroy(); ctx.grid.focus(); } });
  preview?.refresh();
  return modal;
}
