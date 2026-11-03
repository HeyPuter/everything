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

// What describeSheet (core/aiformula.js) sends along with the table, named
// range, and sheet names: the first row of the data as headers (31 columns at
// most) and the sample rows under it that sampleRange names.
function sheetDataNote(wb, sheetId) {
  const used = dataBounds(wb, sheetId);
  const name = wb.sheet(sheetId).name;
  if (!used) return `Data sent: only the names of the sheets, tables, and named ranges; ${name} has no data.`;
  const headers = `${cellName(used.r1, used.c1)}:${cellName(used.r1, Math.min(used.c2, used.c1 + 30))}`;
  const sample = sampleRange(wb, sheetId, used);
  const rows = !sample ? '' : sample.r1 === sample.r2
    ? ` and row ${sample.r1 + 1} of ${colName(sample.c1)}:${colName(sample.c2)}`
    : ` and rows ${sample.r1 + 1}–${sample.r2 + 1} of ${colName(sample.c1)}:${colName(sample.c2)}`;
  return `Data sent: headers in ${headers}${rows} on ${name}, values as shown, with the names of the sheets, tables, and named ranges.`;
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
  const part = cut ? `the first ${ASK_ROWS} rows and ${ASK_COLS} columns of ${single ? 'the sheet\'s data ' : ''}${rangeName(whole)}` : single ? 'the sheet\'s data' : '';
  const aside = single ? `${part}; select cells first to ask about part of it` : part;
  const headers = header ? ` and its header${header.range.c1 === header.range.c2 ? '' : 's'} ${rangeName(header.range)}` : '';
  return `Data sent: ${rangeName(sent)}${aside ? ` (${aside})` : ''}${headers} on ${wb.sheet(sheetId).name}, values as shown, with the names of the sheets, tables, and named ranges.`;
}

export function openAiDialog(ctx, { mode = 'write' } = {}) {
  if (!P.canAI()) { toast('AI is not available here', { icon: 'info' }); return null; }
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const active = ctx.active();
  const cell = wb.getCell(sheetId, active.r, active.c);
  const existing = cell?.f != null ? cell.f : null;
  // A formula hidden on a protected sheet is shown nowhere (the formula bar leaves it out): neither here nor to the AI.
  if (mode === 'explain' && existing != null && wb.formulaHiddenAt?.(sheetId, active.r, active.c)) {
    toast(`The formula in ${cellName(active.r, active.c)} is hidden while the sheet is protected.`, { icon: 'info' });
    return null;
  }
  const explainable = mode === 'explain' && existing;
  const asking = mode === 'ask';
  // Ask mode: the selection, or the sheet's data when a single cell is selected.
  const toAsk = asking ? cellsToAsk(wb, sheetId, ctx.range()) : null;

  const request = el('textarea.input.ai-request', {
    rows: 3, spellcheck: true,
    placeholder: asking ? 'e.g. Which category is most over budget? Summarize these expenses in two sentences.' : 'e.g. total of Planned where Category is Rent, or the number of days until the due date in C2',
    'aria-label': asking ? 'Your question about the data' : 'What should the formula calculate?',
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
  const insertBtn = el('button.btn.btn-primary', { type: 'button', hidden: true }, `Insert into ${cellName(active.r, active.c)}`);
  const copyBtn = el('button.btn', { type: 'button', hidden: true, onclick: async () => { try { await navigator.clipboard.writeText(answer || ''); toast('Answer copied', { icon: 'check', duration: 1500 }); } catch { toast('Could not copy', { icon: 'info' }); } } }, 'Copy answer');
  const writeBtn = el('button.btn', { type: 'button', hidden: true, onclick: () => { if (answer) writeResult(`'${answer}`, 'Answer'); } }, `Write into ${cellName(active.r, active.c)}`);
  const askBtn = el('button.btn.btn-primary', { type: 'submit' }, explainable ? 'Explain' : asking ? 'Ask' : 'Write formula');
  let formula = null;
  let answer = null;
  let busy = false;

  function writeResult(input, kind) {
    if (!wb.sheet(sheetId) || wb.lockedAt(sheetId, active.r, active.c)) {
      showError(wb.sheet(sheetId)
        ? `${cellName(active.r, active.c)} is protected. Unprotect it before inserting the result.`
        : 'The destination sheet no longer exists.');
      return;
    }
    // A cell inside a multi-cell array formula takes no entry of its own: the write would be refused without a word,
    // and the dialog would close saying it was made.
    const array = wb.fixedArrayAt?.(sheetId, active.r, active.c);
    if (array && (array.rows > 1 || array.cols > 1)) {
      showError(`${cellName(active.r, active.c)} is part of the array formula in ${rangeName(array)}, which can only be changed as a whole. Select another cell and ask again.`);
      return;
    }
    const verdict = wb.validateInput(sheetId, active.r, active.c, input);
    if (!verdict.ok && verdict.rule?.strict !== false) {
      showError(verdict.message || 'This result does not meet the cell’s validation rule.');
      return;
    }
    if (textReachesOut(input)) ctx.doc?.distrustExternal?.(); // before the cell exists, or it reaches out once unasked
    wb.setInput(sheetId, active.r, active.c, input);
    modal.close();
    toast(`${kind} written into ${cellName(active.r, active.c)}`, { icon: 'sparkle', duration: 2200 });
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
    if (!explainable && !request.value.trim()) return refuse(request, asking ? 'Type a question about the data' : 'Type what the formula should calculate');
    if (asking && !toAsk) { showError('There is no data on this sheet to ask about.'); return; }
    const prompt = explainable ? explainPrompt(existing, context)
      : asking ? askPrompt(request.value.trim(), context, askText(wb, sheetId, toAsk))
        : formulaPrompt(request.value.trim(), context);
    busy = true;
    askBtn.disabled = true;
    askBtn.setAttribute('aria-busy', 'true');
    status.textContent = 'Asking Puter AI…';
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
        status.textContent = 'The AI can be wrong: check figures against the sheet.';
      } else if (explainable) {
        result.textContent = String(reply).trim();
        result.hidden = false;
        status.textContent = '';
      } else {
        formula = extractFormula(reply);
        if (!formula) { status.textContent = 'The reply held no formula. Try describing it differently.'; result.textContent = String(reply).trim().slice(0, 400); result.hidden = false; }
        else { result.textContent = formula; result.hidden = false; insertBtn.hidden = false; status.textContent = 'Check it before you use it: the AI can be wrong.'; }
      }
    } catch (err) {
      status.textContent = '';
      showError(`Could not ask the AI: ${err?.message || 'unknown error'}`);
    } finally {
      busy = false;
      askBtn.disabled = false;
      askBtn.removeAttribute('aria-busy');
    }
  }
  insertBtn.addEventListener('click', () => {
    if (formula) writeResult(formula, 'Formula');
  });

  const dataNote = asking
    ? toAsk && el('p.field-hint', {}, askNote(wb, sheetId, toAsk))
    : el('p.field-hint', {}, sheetDataNote(wb, sheetId));
  const content = el('form', { onsubmit: ask },
    explainable
      ? el('div.field', {}, el('span.field-label', {}, `Formula in ${cellName(active.r, active.c)}`), el('div.numfmt-preview', {}, `=${existing}`))
      : el('label.field', {}, el('span.field-label', {}, asking ? 'Your question' : 'What should the formula calculate?'), request),
    dataNote,
    status,
    result,
    error,
    el('div.row.row-end', { style: { marginTop: '14px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Close'),
      copyBtn,
      writeBtn,
      insertBtn,
      askBtn));
  const modal = openModal({ title: explainable ? 'Explain this formula' : asking ? 'Ask AI about this data' : 'Write a formula with AI', content, initialFocus: explainable ? null : request, onClose: () => ctx.grid.focus() });
  if (explainable) ask();
  return modal;
}

export const AI_ICON = icon('sparkle', 16);
