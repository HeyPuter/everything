/**
 * Template picker: a grid of starting points (blank, budget, invoice, ...).
 * Picking one opens a new, unsaved document built from it.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { TEMPLATES } from '../core/templates.js';
import { templateThumbnail } from './template-thumbnail.js';
import { t } from '../i18n/index.js';

export function openTemplatePicker({ onPick }) {
  const cards = TEMPLATES.map((tpl) => el('button.template-card', {
    type: 'button', dataset: { template: tpl.id },
    onclick: () => { modal.close(); onPick(tpl.id); },
  },
    el('span.template-thumb', { 'aria-hidden': 'true' }, templateThumbnail(tpl.id) || el('span.template-icon', { html: icon(tpl.icon, 22) })),
    el('span.template-name', {}, tpl.name),
    el('span.template-desc', {}, tpl.description)));
  // A group, not a list: the cards are buttons, and a list of buttons reads as a list of nothing.
  const content = el('div.template-grid', { role: 'group', 'aria-label': t('templates.templates') }, ...cards);
  const modal = openModal({ title: t('templates.title'), content, wide: true });
  cards[0]?.focus();
  return modal;
}
