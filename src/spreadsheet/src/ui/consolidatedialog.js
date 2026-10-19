/** Data ▸ Consolidate: the function, the references to combine, and whether their top row and left column hold labels. */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { CONSOLIDATE_FUNCTIONS } from '../core/consolidate.js';
import { rangeName } from '../core/cell.js';
import { quoteSheet } from '../core/refs.js';

export function openConsolidateDialog(ctx) {
  const refs = [];
  const fn = el('select.select', { 'aria-label': 'Function' }, ...CONSOLIDATE_FUNCTIONS.map(([value, label]) => el('option', { value }, label)));
  const sheetName = ctx.wb.sheet(ctx.sheetId())?.name || '';
  const range = ctx.range();
  const reference = el('input.input', { type: 'text', 'aria-label': 'Reference', autocomplete: 'off', spellcheck: false,
    value: range.r1 === range.r2 && range.c1 === range.c2 ? '' : `${quoteSheet(sheetName)}!${rangeName(range)}` });
  const list = el('select.select.consolidate-refs', { size: 5, 'aria-label': 'All references' });
  const top = el('input', { type: 'checkbox', id: fieldId('consolidate-top') });
  const left = el('input', { type: 'checkbox', id: fieldId('consolidate-left') });
  const { alert, refuse } = fieldAlert('consolidate');
  const sync = () => list.replaceChildren(...refs.map((r) => el('option', { value: r }, r)));
  const add = () => {
    const text = reference.value.trim();
    if (!text) return;
    if (!ctx.resolveRange(text)) { refuse(reference, 'Enter a range such as Sheet1!A1:C10'); return; }
    if (!refs.includes(text)) refs.push(text);
    reference.value = '';
    sync();
  };
  const remove = () => { const i = list.selectedIndex; if (i >= 0) { refs.splice(i, 1); sync(); } };
  const submit = (e) => {
    e.preventDefault();
    if (reference.value.trim()) add();
    if (!refs.length) { refuse(reference, 'Add at least one reference to consolidate'); return; }
    // The result goes at the active cell: inside a source it would be written over the data it is made from.
    const at = ctx.active?.();
    const inside = at && refs.find((text) => {
      const hit = ctx.resolveRange(text);
      return hit?.sheetId === ctx.sheetId() && at.r >= hit.range.r1 && at.r <= hit.range.r2 && at.c >= hit.range.c1 && at.c <= hit.range.c2;
    });
    if (inside) { refuse(list, `The result would be written at the selected cell, inside ${inside}. Select a cell outside the references first`); return; }
    modal.close();
    ctx.run('consolidate', { fn: fn.value, refs: [...refs], topRow: top.checked, leftColumn: left.checked });
  };
  const content = el('form.consolidate-dialog', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, 'Function'), el('div.select-wrap', {}, fn)),
    el('label.field', {}, el('span.field-label', {}, 'Reference'), el('div.row', {}, reference,
      el('button.btn', { type: 'button', onclick: add }, 'Add'))),
    alert,
    el('label.field', {}, el('span.field-label', {}, 'All references'), el('div.row', {}, list, el('button.btn', { type: 'button', onclick: remove }, 'Delete'))),
    el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, 'Use labels in'),
      el('label.check', { for: top.id }, top, el('span', {}, 'Top row')), el('label.check', { for: left.id }, left, el('span', {}, 'Left column'))),
    el('div.row.row-end', { style: { marginTop: '12px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Consolidate', content, initialFocus: reference, onClose: () => ctx.grid.focus() });
  return modal;
}
