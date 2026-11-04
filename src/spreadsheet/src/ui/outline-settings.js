/**
 * Data ▸ Outline ▸ Settings…: where the outline's summary rows and columns sit beside their detail, and
 * whether its summary lines are styled automatically. Create builds the outline from the summary formulas
 * with these settings; Apply Styles sets the summary lines in bold now.
 */

import { el, fieldId } from './dom.js';
import { openModal } from './modal.js';
import { outlineSettingsOf } from '../core/workbook.js';
import { t } from '../i18n/index.js';

export function openOutlineSettings(ctx) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const current = outlineSettingsOf(wb.sheet(sheetId));
  const box = (label, checked, hint) => {
    const id = fieldId('outline');
    const input = el('input', { type: 'checkbox', id, checked, 'aria-describedby': `${id}-hint` });
    return { input, node: el('div.outline-setting', {}, input, el('label', { for: id }, label), el('span.field-hint', { id: `${id}-hint` }, hint)) };
  };
  const below = box(t('outlineSettings.below'), current.summaryBelow, t('outlineSettings.belowHint'));
  const right = box(t('outlineSettings.right'), current.summaryRight, t('outlineSettings.rightHint'));
  const auto = box(t('outlineSettings.autoStyles'), current.autoStyles, t('outlineSettings.autoStylesHint'));
  const read = () => ({ summaryBelow: below.input.checked, summaryRight: right.input.checked, autoStyles: auto.input.checked });
  // OK, Create and Apply Styles all keep the settings shown; the two buttons then act with them, in the same undo step.
  const finish = (then = null) => {
    modal.close();
    ctx.run('outlineSettings', { settings: read(), then });
  };
  const content = el('form.outline-settings', { onsubmit: (e) => { e.preventDefault(); finish(); } },
    el('fieldset', {}, el('legend', {}, t('outlineSettings.direction')), below.node, right.node),
    auto.node,
    el('div.row.style-dialog-actions', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => finish('create') }, t('outlineSettings.create')),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => finish('styles') }, t('outlineSettings.applyStyles')),
      el('span.spacer'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('outlineSettings.title'), content, initialFocus: below.input, onClose: () => ctx.grid?.focus?.() });
  return modal;
}
