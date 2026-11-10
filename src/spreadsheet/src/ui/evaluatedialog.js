/**
 * Evaluate formula: every part of the active cell's formula with the value it
 * produces, innermost first, so a wrong result can be traced to its cause.
 */

import { el } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { cellName } from '../core/cell.js';
import { evaluateParts, describeValue } from '../core/formula/print.js';
import { t } from '../i18n/index.js';

// The parser's reasons are written for the code ("Unterminated string", "Unexpected token"), and in English
// whatever the interface language: the dialog says them in the words of the formula as typed, and any it does
// not know with a lowercase start.
const PLAIN_REASONS = [
  [/^Unterminated string$/, () => t('evaluatedialog.reason.unterminatedString')],
  [/^Unexpected end of formula$/, () => t('evaluatedialog.reason.unexpectedEnd')],
  [/^Unexpected character "(.+)"$/, (m) => t('evaluatedialog.reason.unexpectedCharacter', { ch: m[1] })],
  [/^Unexpected token$/, () => t('evaluatedialog.reason.unexpectedToken')],
  [/^Unclosed "\["$/, () => t('evaluatedialog.reason.unclosedBracket')],
  [/^Expected ("[)}]")$/, (m) => t('evaluatedialog.reason.missingClose', { what: m[1] })],
  [/^Expected a reference after ":"$/, () => t('evaluatedialog.reason.rangeEndMissing')],
  [/^Unknown error literal$/, () => t('evaluatedialog.reason.unknownErrorLiteral')],
  [/^Number out of range$/, () => t('evaluatedialog.reason.numberOutOfRange')],
  [/^Invalid sheet span$/, () => t('evaluatedialog.reason.invalidSheetSpan')],
  [/^Expected an intersecting reference$/, () => t('evaluatedialog.reason.expectedIntersectingReference')],
  [/^Bad reference$/, () => t('evaluatedialog.reason.badReference')],
  [/^A 3D span cannot carry #$/, () => t('evaluatedialog.reason.spanCannotSpill')],
  [/^Only a single cell can carry # for its spill$/, () => t('evaluatedialog.reason.onlyCellSpills')],
  [/^Empty array$/, () => t('evaluatedialog.reason.emptyArray')],
  [/^Array rows must be the same width$/, () => t('evaluatedialog.reason.arrayRowsWidth')],
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
  if (cell?.f == null) { toast(t('evaluatedialog.selectFormulaCell'), { icon: 'info' }); return null; }
  // A formula hidden on a protected sheet is shown nowhere (the formula bar leaves it out), nor taken apart here.
  if (wb.formulaHiddenAt?.(sheetId, a.r, a.c)) {
    toast(t('evaluatedialog.formulaHidden', { cell: cellName(a.r, a.c) }), { icon: 'info' });
    return null;
  }
  let taken;
  try { taken = evaluateParts(cell.f, wb.contextFor(sheetId, a.r, a.c)); } catch (e) {
    // A formula nested deeper than the stack allows cannot be taken apart; the cell shows what it can.
    if (!(e instanceof RangeError)) throw e;
    taken = { error: null, tooDeep: true, parts: [] };
  }
  const { error, tooDeep, parts } = taken;
  const rows = parts.map((p, i) => el('tr', { className: i === parts.length - 1 ? 'eval-final' : '' },
    el('td.eval-expr', { style: { paddingLeft: `${8 + p.depth * 14}px` } }, el('code', {}, p.text)),
    el('td.eval-value', {}, describeValue(p.value))));
  const content = el('div', {},
    el('div.numfmt-preview', {}, `=${cell.f}`),
    error || tooDeep ? el('p.field-error', { role: 'alert' }, t('evaluatedialog.cannotRead', { reason: tooDeep ? t('evaluatedialog.reason.tooDeep') : plainReason(error) })) : null,
    el('p.field-hint', {}, t('evaluatedialog.hint')),
    el('div.eval-scroll', {}, el('table.details-table.eval-table', {}, el('thead', {}, el('tr', {}, el('th', {}, t('evaluatedialog.part')), el('th', {}, t('common.value')))), el('tbody', {}, ...rows))),
    el('div.row.row-end', { style: { marginTop: '12px' } }, el('button.btn.btn-primary', { type: 'button', onclick: () => modal.close() }, t('common.done'))));
  const modal = openModal({ title: t('evaluatedialog.title', { cell: cellName(a.r, a.c) }), content, wide: true, onClose: () => ctx.grid.focus() });
  return modal;
}
