/**
 * AI formula helper: describe what a cell should calculate and get a formula
 * (with the sheet's headers, tables, and names described to the model), ask
 * for a plain-language explanation of the active cell's formula, or ask a
 * question about the selected cells (or the sheet's data).
 */

import { el, isComposing } from './dom.js';
import { icon } from './icons.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import * as P from '../lib/puter.js';
import { describeSheet, describeRange, dataBounds, sampleRange, formulaPrompt, explainPrompt, askPrompt, extractFormula } from '../core/aiformula.js';
import { cellName, colName, rangeName } from '../core/cell.js';
import { looksLikeHeader } from './sortdialog.js';
// The AI's reply is built from a prompt that quotes the sheet's own cells, so a formula it writes
// could send their contents anywhere: inserting one that reaches out asks first, as pasting it
// from a web page does (the same scan serves the open and paste paths, so none of them drifts).
import { textReachesOut } from '../core/reaches-out.js';
import { t } from '../i18n/index.js';

// What describeSheet (core/aiformula.js) sends along with the table, named
// range, and sheet names: the first row of the data as headers (31 columns at
// most) and the sample rows under it that sampleRange names.
function sheetDataNote(wb, sheetId) {
  const used = dataBounds(wb, sheetId);
  const name = wb.sheet(sheetId).name;
  if (!used) return t('aidialog.dataNote.noData', { name });
  const headers = `${cellName(used.r1, used.c1)}:${cellName(used.r1, Math.min(used.c2, used.c1 + 30))}`;
  const sample = sampleRange(wb, sheetId, used);
  if (!sample) return t('aidialog.dataNote.headers', { headers, name });
  const columns = `${colName(sample.c1)}:${colName(sample.c2)}`;
  return sample.r1 === sample.r2
    ? t('aidialog.dataNote.headersRow', { headers, row: sample.r1 + 1, columns, name })
    : t('aidialog.dataNote.headersRows', { headers, from: sample.r1 + 1, to: sample.r2 + 1, columns, name });
}

// An ask quotes the selection, or the sheet's data when one cell is selected,
// cut to this many rows and columns. The prompt and the note share the numbers.
const ASK_ROWS = 60;
const ASK_COLS = 15;

/**
 * The cells an ask about `sel` sends, or null when the sheet has no data:
 * `whole` is the selection (the sheet's data when `single`), `sent` the part
 * of it within the cut, and `header` the row that names the columns of a
 * selection starting under one — its table's header row, or the data's first
 * row when that reads as a header over these columns — as the cells' range
 * and the line quoting them. Nothing outside the selection goes but that row.
 */
function cellsToAsk(wb, sheetId, sel) {
  const used = dataBounds(wb, sheetId);
  if (!used) return null;
  const single = sel.r1 === sel.r2 && sel.c1 === sel.c2;
  const whole = single ? used : sel;
  const sent = { r1: whole.r1, c1: whole.c1, r2: Math.min(whole.r2, whole.r1 + ASK_ROWS - 1), c2: Math.min(whole.c2, whole.c1 + ASK_COLS - 1) };
  let header = null;
  if (!single) {
    const table = wb.tableAt(sheetId, sel.r1, sel.c1);
    const row = table ? (table.range.r1 < sel.r1 ? table.range.r1 : null)
      : sel.r1 > used.r1 && looksLikeHeader(wb, sheetId, { r1: used.r1, c1: sent.c1, r2: sel.r2, c2: sent.c2 }) ? used.r1 : null;
    const cells = [];
    for (let c = sent.c1; row != null && c <= sent.c2; c++) {
      const text = wb.getDisplay(sheetId, row, c);
      if (text) cells.push(`${cellName(row, c)}="${text.slice(0, 40)}"`);
    }
    if (cells.length) header = { range: { r1: row, c1: sent.c1, r2: row, c2: sent.c2 }, line: `Headers of these columns: ${cells.join(', ')}.` };
  }
  return { single, whole, sent, header };
}

/** The data part of an ask prompt: the header line, if any, then the cells as shown. */
function askText(wb, sheetId, { whole, header }) {
  const data = describeRange(wb, sheetId, whole, { maxRows: ASK_ROWS, maxCols: ASK_COLS });
  return header ? `${header.line}\n${data}` : data;
}

/** The note saying what an ask sends: exactly the cells askText quotes. */
function askNote(wb, sheetId, { single, whole, sent, header }) {
  const cut = sent.r2 < whole.r2 || sent.c2 < whole.c2;
  const values = {
    sent: rangeName(sent), whole: rangeName(whole), rows: ASK_ROWS, cols: ASK_COLS, sheet: wb.sheet(sheetId).name,
    headers: !header ? 'none' : header.range.c1 === header.range.c2 ? 'one' : 'many', headerRange: header ? rangeName(header.range) : '',
  };
  if (single) return cut ? t('aidialog.askNote.sheetCut', values) : t('aidialog.askNote.sheet', values);
  return cut ? t('aidialog.askNote.rangeCut', values) : t('aidialog.askNote.range', values);
}

export function openAiDialog(ctx, { mode = 'write' } = {}) {
  if (!P.canAI()) { toast(t('aidialog.notAvailable'), { icon: 'info' }); return null; }
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const active = ctx.active();
  const cell = wb.getCell(sheetId, active.r, active.c);
  const existing = cell?.f != null ? cell.f : null;
  // A formula hidden on a protected sheet is shown nowhere (the formula bar leaves it out): neither here nor to the AI.
  if (mode === 'explain' && existing != null && wb.formulaHiddenAt?.(sheetId, active.r, active.c)) {
    toast(t('aidialog.formulaHidden', { cell: cellName(active.r, active.c) }), { icon: 'info' });
    return null;
  }
  const explainable = mode === 'explain' && existing;
  const asking = mode === 'ask';
  // Ask mode: the selection, or the sheet's data when a single cell is selected.
  const toAsk = asking ? cellsToAsk(wb, sheetId, ctx.range()) : null;

  const request = el('textarea.input.ai-request', {
    rows: 3, spellcheck: true,
    placeholder: asking ? t('aidialog.askPlaceholder') : t('aidialog.formulaPlaceholder'),
    'aria-label': asking ? t('aidialog.questionLabel') : t('aidialog.formulaLabel'),
  });
  // Enter asks, as it sends in the assistant's box; Shift+Enter starts a new line.
  request.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || isComposing(e)) return;
    e.preventDefault();
    request.form?.requestSubmit(askBtn);
  });
  // Progress and soft outcomes are read out as they change; a failure is an alert. A refusal about the
  // question box names it, as every other dialog's does, so a screen reader hears which field is at fault.
  const status = el('p.field-hint', { role: 'status' });
  const { alert: error, refuse, clear: clearError } = fieldAlert('ai');
  const showError = (message) => refuse(null, message);
  const result = el('div.numfmt-preview.ai-result', { hidden: true, 'aria-live': 'polite' });
  const insertBtn = el('button.btn.btn-primary', { type: 'button', hidden: true }, t('aidialog.insertInto', { cell: cellName(active.r, active.c) }));
  const copyBtn = el('button.btn', { type: 'button', hidden: true, onclick: async () => { try { await navigator.clipboard.writeText(answer || ''); toast(t('aidialog.answerCopied'), { icon: 'check', duration: 1500 }); } catch { toast(t('aidialog.couldNotCopy'), { icon: 'info' }); } } }, t('aidialog.copyAnswer'));
  const writeBtn = el('button.btn', { type: 'button', hidden: true, onclick: () => { if (answer) writeResult(`'${answer}`, 'answer'); } }, t('aidialog.writeInto', { cell: cellName(active.r, active.c) }));
  const askBtn = el('button.btn.btn-primary', { type: 'submit' }, explainable ? t('aidialog.explain') : asking ? t('aidialog.ask') : t('aidialog.writeFormula'));
  let formula = null;
  let answer = null;
  let busy = false;

  function writeResult(input, kind) {
    if (!wb.sheet(sheetId) || wb.lockedAt(sheetId, active.r, active.c)) {
      showError(wb.sheet(sheetId)
        ? t('aidialog.cellProtected', { cell: cellName(active.r, active.c) })
        : t('aidialog.sheetGone'));
      return;
    }
    // A cell inside a multi-cell array formula takes no entry of its own: the write would be refused without a word,
    // and the dialog would close saying it was made.
    const array = wb.fixedArrayAt?.(sheetId, active.r, active.c);
    if (array && (array.rows > 1 || array.cols > 1)) {
      showError(t('aidialog.inArray', { cell: cellName(active.r, active.c), range: rangeName(array) }));
      return;
    }
    // A formula Excel refuses as typed would go in as its text, the dialog closing as though it were written.
    const problem = wb.typedFormulaProblem(input);
    if (problem) {
      showError(t('aidialog.formulaProblem', { problem: problem.message }));
      return;
    }
    const verdict = wb.validateInput(sheetId, active.r, active.c, input);
    if (!verdict.ok && verdict.rule?.strict !== false) {
      showError(verdict.message || t('aidialog.failsValidation'));
      return;
    }
    if (textReachesOut(input)) ctx.doc?.distrustExternal?.(); // before the cell exists, or it reaches out once unasked
    wb.setInput(sheetId, active.r, active.c, input);
    modal.close();
    toast(t('aidialog.written', { kind, cell: cellName(active.r, active.c) }), { icon: 'sparkle', duration: 2200 });
    ctx.grid.focus();
  }

  async function ask(e) {
    e?.preventDefault();
    if (busy) return;
    // What the last attempt said is stale once another is made, even one that stops at an empty field.
    clearError();
    status.textContent = '';
    // An ask quotes its own cells, so the sheet is described without any of its cells: only what the note names goes.
    const context = describeSheet(wb, sheetId, active, { cells: !asking });
    // An empty box used to send the focus back without a word: say what to type, and mark the box.
    if (!explainable && !request.value.trim()) return refuse(request, asking ? t('aidialog.typeQuestion') : t('aidialog.typeFormula'));
    if (asking && !toAsk) { showError(t('aidialog.noData')); return; }
    const prompt = explainable ? explainPrompt(existing, context)
      : asking ? askPrompt(request.value.trim(), context, askText(wb, sheetId, toAsk))
        : formulaPrompt(request.value.trim(), context);
    busy = true;
    askBtn.disabled = true;
    askBtn.setAttribute('aria-busy', 'true');
    status.textContent = t('aidialog.asking');
    result.hidden = true;
    insertBtn.hidden = true;
    copyBtn.hidden = true;
    writeBtn.hidden = true;
    try {
      const reply = await P.aiChat(prompt, { feature: asking ? 'ask-data' : explainable ? 'explain-formula' : 'generate-formula' });
      if (asking) {
        answer = String(reply).trim();
        result.textContent = answer;
        result.hidden = false;
        copyBtn.hidden = false;
        writeBtn.hidden = false;
        status.textContent = t('aidialog.answerCaution');
      } else if (explainable) {
        result.textContent = String(reply).trim();
        result.hidden = false;
        status.textContent = '';
      } else {
        formula = extractFormula(reply);
        if (!formula) { status.textContent = t('aidialog.noFormula'); result.textContent = String(reply).trim().slice(0, 400); result.hidden = false; }
        else { result.textContent = formula; result.hidden = false; insertBtn.hidden = false; status.textContent = t('aidialog.formulaCaution'); }
      }
    } catch (err) {
      status.textContent = '';
      showError(err?.message ? t('aidialog.couldNotAsk', { message: err.message }) : t('aidialog.couldNotAskUnknown'));
    } finally {
      busy = false;
      askBtn.disabled = false;
      askBtn.removeAttribute('aria-busy');
    }
  }
  insertBtn.addEventListener('click', () => {
    if (formula) writeResult(formula, 'formula');
  });

  const dataNote = asking
    ? toAsk && el('p.field-hint', {}, askNote(wb, sheetId, toAsk))
    : el('p.field-hint', {}, sheetDataNote(wb, sheetId));
  const content = el('form', { onsubmit: ask },
    explainable
      ? el('div.field', {}, el('span.field-label', {}, t('aidialog.formulaIn', { cell: cellName(active.r, active.c) })), el('div.numfmt-preview', {}, `=${existing}`))
      : el('label.field', {}, el('span.field-label', {}, asking ? t('aidialog.yourQuestion') : t('aidialog.formulaLabel')), request),
    dataNote,
    status,
    result,
    error,
    el('div.row.row-end', { style: { marginTop: '14px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.close')),
      copyBtn,
      writeBtn,
      insertBtn,
      askBtn));
  const modal = openModal({ title: explainable ? t('aidialog.title.explain') : asking ? t('aidialog.title.ask') : t('aidialog.title.write'), content, initialFocus: explainable ? null : request, onClose: () => ctx.grid.focus() });
  if (explainable) ask();
  return modal;
}

export const AI_ICON = icon('sparkle', 16);
