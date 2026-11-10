/**
 * Custom number format dialog: type a number format code, pick a preset, and
 * see the active cell's value as it would look.
 */

import { el, fieldId } from './dom.js';
import { openModal } from './modal.js';
import { formatWithCode, formatCodeError, CUSTOM_FORMAT_PRESETS } from '../core/numfmt.js';
import { styleToNumFmt, formatGeneral, AUTOMATIC_FORMAT } from '../core/format.js';
import { t } from '../i18n/index.js';

export function openCustomFormatDialog(ctx) {
  const style = ctx.style();
  const value = ctx.wb.getValue(ctx.sheetId(), ctx.active().r, ctx.active().c);
  const sample = typeof value === 'number' ? value : 1234.5678;
  const errorId = fieldId('numfmt');
  // The cell's format as a code to start from (#,##0.00 for a Number with two places), as Excel's Custom
  // category shows it; a cell in no format starts empty.
  const start = style.fmt === 'custom' ? style.code || '' : style.fmt && style.fmt !== 'general' ? styleToNumFmt(style) : '';
  const input = el('input.input', { type: 'text', value: start, placeholder: '#,##0.00', 'aria-label': t('numfmtdialog.formatCode'), spellcheck: false, autocomplete: 'off', 'aria-describedby': errorId });
  const preview = el('div.numfmt-preview', { 'aria-live': 'polite' });
  const error = el('p.field-error', { id: errorId, hidden: true, role: 'alert' });
  const refresh = () => {
    const code = input.value.trim();
    // A malformed code ('"', '[', 'E+') would blank every number: the preview names the problem, and Apply refuses it.
    const problem = code ? formatCodeError(code) : null;
    let text = '';
    try { text = code && !problem ? formatWithCode(sample, code) : ''; } catch { text = ''; }
    // The value as the cell would show it in General, with the regional decimal mark (1234,5678 in German).
    preview.textContent = !code ? t('numfmtdialog.typeToPreview') : problem || t('numfmtdialog.preview', { value: formatGeneral(sample), text });
  };
  // A changed code, typed or picked from the examples, is no longer the one refused: the mark and the message go until the next Apply.
  const changed = () => {
    error.hidden = true;
    input.removeAttribute('aria-invalid');
    refresh();
  };
  input.addEventListener('input', changed);
  // Plain buttons in a labelled group: a list role would hide them from assistive technology.
  const presets = el('div.numfmt-presets', { role: 'group', 'aria-label': t('numfmtdialog.exampleFormats') }, CUSTOM_FORMAT_PRESETS.map(([code, labelKey]) => el('button.numfmt-preset', {
    type: 'button', onclick: () => { input.value = code; changed(); input.focus(); },
  }, el('span.numfmt-code', {}, code), el('span.numfmt-label', {}, t(labelKey)), el('span.numfmt-sample', {}, formatWithCode(code.includes('y') || code.includes('h') ? 45306.5729 : sample, code)))));
  const submit = (e) => {
    e?.preventDefault();
    const code = input.value.trim();
    const problem = formatCodeError(code);
    if (problem) { error.textContent = problem; error.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    // The code @ is Excel's Text format, as Format Cells applies it, so what is typed into the cell stays as typed.
    ctx.run('fmt', code === '@' ? { ...AUTOMATIC_FORMAT, fmt: 'text' } : { fmt: 'custom', code, dec: null, dateStyle: null });
    modal.close();
  };
  const content = el('form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, t('numfmtdialog.formatCode')), input, error,
      el('span.field-hint', {}, t('numfmtdialog.hint'))),
    preview,
    el('div.field', {}, el('span.field-label', {}, t('numfmtdialog.examples')), presets),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.apply'))));
  const modal = openModal({ title: t('numfmtdialog.title'), content, wide: true, initialFocus: input, onClose: () => ctx.grid.focus() });
  refresh();
  return modal;
}
