/**
 * Evaluate formula: every part of the active cell's formula with the value it
 * produces, innermost first, so a wrong result can be traced to its cause.
 */

import { el } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { cellName } from '../core/cell.js';
import { evaluateParts, describeValue } from '../core/formula/print.js';

// The parser's reasons are written for the code ("Unterminated string", "Unexpected token"): the dialog
// says them in the words of the formula as typed, and any it does not know with a lowercase start.
const PLAIN_REASONS = [
  [/^Unterminated string$/, () => 'a quoted text has no closing quote'],
  [/^Unexpected end of formula$/, () => 'it ends before it is complete'],
  [/^Unexpected character "(.+)"$/, (m) => `"${m[1]}" is out of place`],
  [/^Unexpected token$/, () => 'an operator, comma, or parenthesis is out of place'],
  [/^Unclosed "\["$/, () => 'a [ has no closing ]'],
  [/^Expected ("[)}]")$/, (m) => `a closing ${m[1]} is missing`],
  [/^Expected a reference after ":"$/, () => 'a range has nothing after its ":"'],
  [/^Unknown error literal$/, () => 'it names an error value that does not exist'],
];
function plainReason(reason) {
  for (const [re, say] of PLAIN_REASONS) { const m = re.exec(reason); if (m) return say(m); }
  return reason.charAt(0).toLowerCase() + reason.slice(1);
}

export function openEvaluateDialog(ctx) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const a = ctx.active();
  const cell = wb.getCell(sheetId, a.r, a.c);
  if (cell?.f == null) { toast('Select a cell with a formula', { icon: 'info' }); return null; }
  // A formula hidden on a protected sheet is shown nowhere (the formula bar leaves it out), nor taken apart here.
  if (wb.formulaHiddenAt?.(sheetId, a.r, a.c)) {
    toast(`The formula in ${cellName(a.r, a.c)} is hidden while the sheet is protected.`, { icon: 'info' });
    return null;
  }
  let taken;
  try { taken = evaluateParts(cell.f, wb.contextFor(sheetId, a.r, a.c)); } catch (e) {
    // A formula nested deeper than the stack allows cannot be taken apart; the cell shows what it can.
    if (!(e instanceof RangeError)) throw e;
    taken = { error: 'it nests too deeply to follow', parts: [] };
  }
  const { error, parts } = taken;
  const rows = parts.map((p, i) => el('tr', { className: i === parts.length - 1 ? 'eval-final' : '' },
    el('td.eval-expr', { style: { paddingLeft: `${8 + p.depth * 14}px` } }, el('code', {}, p.text)),
    el('td.eval-value', {}, describeValue(p.value))));
  const content = el('div', {},
    el('div.numfmt-preview', {}, `=${cell.f}`),
    error ? el('p.field-error', { role: 'alert' }, `Cannot read this formula: ${plainReason(error)}`) : null,
    el('p.field-hint', {}, 'Each part of the formula and what it produces, working outward from the innermost pieces. Indentation shows nesting; the last line is the cell\'s result.'),
    el('div.eval-scroll', {}, el('table.details-table.eval-table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Part'), el('th', {}, 'Value'))), el('tbody', {}, ...rows))),
    el('div.row.row-end', { style: { marginTop: '12px' } }, el('button.btn.btn-primary', { type: 'button', onclick: () => modal.close() }, 'Done')));
  const modal = openModal({ title: `Evaluate ${cellName(a.r, a.c)}`, content, wide: true, onClose: () => ctx.grid.focus() });
  return modal;
}
