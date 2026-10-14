/**
 * Data ▸ Outline ▸ Settings…: where the outline's summary rows and columns sit beside their detail, and
 * whether its summary lines are styled automatically. Create builds the outline from the summary formulas
 * with these settings; Apply Styles sets the summary lines in bold now.
 */

import { el, fieldId } from './dom.js';
import { openModal } from './modal.js';
import { outlineSettingsOf } from '../core/workbook.js';

export function openOutlineSettings(ctx) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const current = outlineSettingsOf(wb.sheet(sheetId));
  const box = (label, checked, hint) => {
    const id = fieldId('outline');
    const input = el('input', { type: 'checkbox', id, checked, 'aria-describedby': `${id}-hint` });
    return { input, node: el('div.outline-setting', {}, input, el('label', { for: id }, label), el('span.field-hint', { id: `${id}-hint` }, hint)) };
  };
  const below = box('Summary rows below detail', current.summaryBelow, 'Totals come after the rows they add up; off, they head them.');
  const right = box('Summary columns to right of detail', current.summaryRight, 'Totals come after the columns they add up; off, they lead them.');
  const auto = box('Automatic styles', current.autoStyles, 'Set summary rows and columns in bold when the outline is created.');
  const read = () => ({ summaryBelow: below.input.checked, summaryRight: right.input.checked, autoStyles: auto.input.checked });
  // OK, Create and Apply Styles all keep the settings shown; the two buttons then act with them, in the same undo step.
  const finish = (then = null) => {
    modal.close();
    ctx.run('outlineSettings', { settings: read(), then });
  };
  const content = el('form.outline-settings', { onsubmit: (e) => { e.preventDefault(); finish(); } },
    el('fieldset', {}, el('legend', {}, 'Direction'), below.node, right.node),
    auto.node,
    el('div.row.style-dialog-actions', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => finish('create') }, 'Create'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => finish('styles') }, 'Apply Styles'),
      el('span.spacer'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Outline Settings', content, initialFocus: below.input, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
