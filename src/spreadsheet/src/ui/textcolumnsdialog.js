/**
 * Data ▸ Text to Columns: cut the text of a column into several, by separators or at fixed character
 * positions, with a live preview of the first rows. Each column of the preview chooses how its pieces are
 * read (as values, kept as typed text, or left out), and the pieces can land somewhere other than over
 * the text. One page rather than a sequence of steps: every choice shows its effect at once.
 */

import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { rangeName } from '../core/cell.js';
import { splitPieces, detectDelimiter, suggestBreaks } from '../core/text-split.js';

const PREVIEW_ROWS = 8;
const SEPARATORS = [['\t', 'Tab'], [';', 'Semicolon'], [',', 'Comma'], [' ', 'Space']];
const FORMATS = [['general', 'General'], ['text', 'Text'], ['skip', 'Skip']];

/** The text cells the split reads: the first column of the range, in order. */
function columnTexts(wb, sheetId, range, limit = 500) {
  const out = [];
  for (let r = range.r1; r <= range.r2 && out.length < limit; r++) {
    const cell = wb.getCell(sheetId, r, range.c1);
    if (cell && cell.f == null && typeof cell.v === 'string') out.push(cell.v);
  }
  return out;
}

/** Break positions typed as "6, 14" (characters from the start of the line), sorted and without repeats; null when unreadable. */
export function parseBreaks(text) {
  const parts = String(text).split(/[\s,;]+/).filter(Boolean);
  if (parts.some((p) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 32767)) return null;
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

/**
 * `onSplit(options)` receives the choices as splitTextToColumns takes them (text-split.js), with `formats`
 * and, when the pieces go elsewhere, `dest`. `resolve(text)` reads a typed destination ({ sheetId, range }).
 */
export function openTextToColumnsDialog(ctx, { range, onSplit, resolve, allowDest = true }) {
  const sheetId = ctx.sheetId();
  const texts = columnTexts(ctx.wb, sheetId, range);
  const detected = detectDelimiter(texts);
  const state = {
    // Text with no separator in it but laid out in columns starts on Fixed width; anything else on separators.
    mode: !detected && suggestBreaks(texts).length ? 'fixed' : 'delimited',
    delimiters: new Set(detected ? [detected] : [',']),
    other: '', consecutive: detected === ' ', qualifier: '"', breaks: suggestBreaks(texts), formats: [],
  };
  const options = () => ({
    mode: state.mode, consecutive: state.consecutive, qualifier: state.qualifier, breaks: state.breaks,
    delimiters: [...state.delimiters, ...(state.other ? [state.other] : [])],
  });

  /* ---- Split by ---- */
  const modeName = fieldId('ttc-mode');
  const modeRadio = (value, label) => {
    const id = fieldId('ttc');
    const input = el('input', { type: 'radio', name: modeName, id, value, checked: state.mode === value, onchange: () => { state.mode = value; sync(); } });
    return el('label.find-option', { for: id }, input, el('span', {}, label));
  };
  const modeGroup = el('div.ttc-mode', { role: 'radiogroup', 'aria-label': 'Split by' },
    modeRadio('delimited', 'Separators, such as commas or tabs'), modeRadio('fixed', 'Fixed width, at character positions'));

  /* ---- Separators ---- */
  const check = (label, checked, onchange, extra = {}) => {
    const id = fieldId('ttc');
    const input = el('input', { type: 'checkbox', id, checked, onchange: () => onchange(input.checked), ...extra });
    return el('label.find-option', { for: id }, input, el('span', {}, label));
  };
  const otherInput = el('input.input.ttc-other', { type: 'text', maxlength: 1, 'aria-label': 'Other separator', spellcheck: false, autocomplete: 'off',
    oninput: () => { state.other = otherInput.value; otherCheck.querySelector('input').checked = !!state.other; renderPreview(); } });
  const otherCheck = check('Other', false, (on) => { if (on) otherInput.focus(); else { otherInput.value = ''; state.other = ''; } renderPreview(); });
  const qualifier = el('select.select', { 'aria-label': 'Text qualifier', onchange: () => { state.qualifier = qualifier.value; renderPreview(); } },
    [['"', 'Double quote "'], ["'", "Single quote '"], ['', 'None']].map(([v, label]) => el('option', { value: v, selected: v === state.qualifier }, label)));
  const delimitedBox = el('fieldset.fc-group.ttc-separators', {}, el('legend', {}, 'Separators'),
    el('div.ttc-checks', {}, ...SEPARATORS.map(([d, label]) => check(label, state.delimiters.has(d), (on) => {
      if (on) state.delimiters.add(d); else state.delimiters.delete(d);
      renderPreview();
    })), el('div.ttc-other-row', {}, otherCheck, otherInput)),
    check('Treat repeated separators as one', state.consecutive, (on) => { state.consecutive = on; renderPreview(); }),
    el('label.field.ttc-qualifier', {}, el('span.field-label', {}, 'Text qualifier'), el('div.select-wrap', {}, qualifier)));

  /* ---- Fixed width ---- */
  const { alert: breaksError, refuse: refuseBreaks, clear: clearBreaksError } = fieldAlert('ttc-breaks');
  const breaksInput = el('input.input', { type: 'text', 'aria-label': 'Break positions', spellcheck: false, autocomplete: 'off', placeholder: 'e.g. 8, 20',
    value: state.breaks.join(', '), oninput: () => { const b = parseBreaks(breaksInput.value); if (b) { state.breaks = b; renderPreview(); } } });
  const fixedBox = el('fieldset.fc-group.ttc-fixed', {}, el('legend', {}, 'Breaks'),
    el('label.field', {}, el('span.field-label', {}, 'Cut before characters'), breaksInput), breaksError,
    el('p.field-hint', {}, 'Click between characters in the ruler below to add a break, or on a break to remove it.'));

  /* ---- Preview ---- */
  const ruler = el('div.ttc-ruler', { 'aria-hidden': 'true' });
  const table = el('table.ttc-preview', { 'aria-label': 'Preview' });
  const previewBox = el('div.ttc-preview-wrap', {}, table);
  ruler.addEventListener('click', (e) => {
    const pos = Number(e.target.closest('[data-pos]')?.dataset.pos);
    if (!pos) return;
    const set = new Set(state.breaks);
    if (set.has(pos)) set.delete(pos); else set.add(pos);
    state.breaks = [...set].sort((a, b) => a - b);
    breaksInput.value = state.breaks.join(', ');
    clearBreaksError();
    renderPreview();
  });
  function renderRuler(sample) {
    // One cell per character of the longest sample line; a break draws a line on the left of its cell.
    const width = Math.min(160, Math.max(10, ...sample.map((t) => t.length)) + 2);
    const breaks = new Set(state.breaks);
    const scale = el('div.ttc-scale', {}, Array.from({ length: width }, (_, i) => el('span', { dataset: { pos: i }, className: breaks.has(i) ? 'brk' : '' }, i && i % 10 === 0 ? String(i) : i % 5 === 0 && i ? '·' : '')));
    const lines = sample.map((t) => el('div.ttc-line', {}, Array.from({ length: width }, (_, i) => el('span', { dataset: { pos: i }, className: breaks.has(i) ? 'brk' : '' }, t[i] ?? ''))));
    ruler.replaceChildren(scale, ...lines);
  }
  function renderPreview() {
    const sample = texts.slice(0, PREVIEW_ROWS);
    const opts = options();
    const rows = sample.map((t) => splitPieces(t, opts));
    const cols = Math.max(1, ...rows.map((r) => r.length));
    state.formats.length = Math.max(state.formats.length, cols);
    const head = el('tr', {}, Array.from({ length: cols }, (_, i) => {
      const sel = el('select.select.ttc-format', { 'aria-label': `Column ${i + 1} format`,
        onchange: () => { state.formats[i] = sel.value; renderPreview(); } },
      FORMATS.map(([v, label]) => el('option', { value: v, selected: (state.formats[i] || 'general') === v }, label)));
      return el('th', {}, sel);
    }));
    const body = rows.map((parts) => el('tr', {}, Array.from({ length: cols }, (_, i) =>
      el(`td${state.formats[i] === 'skip' ? '.skip' : ''}`, {}, parts[i] ?? ''))));
    table.replaceChildren(el('thead', {}, head), el('tbody', {}, body.length ? body : [el('tr', {}, el('td.muted', { colSpan: cols }, 'The selected column holds no text to split.'))]));
    if (state.mode === 'fixed') renderRuler(sample);
  }

  /* ---- Destination ---- */
  const { alert: destError, refuse: refuseDest } = fieldAlert('ttc-dest');
  const destDefault = rangeName({ r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c1 });
  const destInput = el('input.input', { type: 'text', value: destDefault, 'aria-label': 'Destination', spellcheck: false, autocomplete: 'off' });
  const destField = el('label.field.ttc-dest', { hidden: !allowDest }, el('span.field-label', {}, 'Put the first piece in'), destInput, destError);

  function sync() {
    delimitedBox.hidden = state.mode !== 'delimited';
    fixedBox.hidden = state.mode !== 'fixed';
    ruler.hidden = state.mode !== 'fixed';
    renderPreview();
  }

  const submit = (e) => {
    e?.preventDefault();
    const opts = options();
    if (opts.mode === 'fixed') {
      const breaks = parseBreaks(breaksInput.value);
      if (!breaks) return refuseBreaks(breaksInput, 'Enter character positions such as 8, 20');
      opts.breaks = breaks;
    }
    const out = { ...opts, formats: [...state.formats].map((f) => f || 'general') };
    const destText = destInput.value.trim();
    if (allowDest && destText && destText.toUpperCase() !== destDefault) {
      const target = resolve?.(destText);
      if (!target || target.sheetId !== sheetId) return refuseDest(destInput, 'Enter a cell on this sheet, such as C1');
      out.dest = { r: target.range.r1, c: target.range.c1 };
    }
    modal.close();
    onSplit(out);
  };
  const content = el('form.ttc-form', { onsubmit: submit, novalidate: true },
    el('p.modal-text', {}, `Cut the text in ${rangeName({ r1: range.r1, c1: range.c1, r2: range.r2, c2: range.c1 })} into columns.`),
    el('div.ttc-top', {}, el('div.ttc-left', {}, el('span.field-label', {}, 'Split by'), modeGroup, destField), delimitedBox, fixedBox),
    el('div.field', {}, el('span.field-label', {}, 'Preview'), ruler, previewBox,
      el('p.field-hint', {}, 'Choose above each column whether its pieces are read as values, kept as typed text, or skipped.')),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Split')));
  const modal = openModal({ title: 'Text to Columns', content, wide: true, className: 'ttc-dialog', onClose: () => ctx.grid?.focus?.() });
  sync();
  return modal;
}
