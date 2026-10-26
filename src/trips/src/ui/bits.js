import { el } from './dom.js';
import { icon } from './icons.js';
import { t } from '../lib/i18n/index.js';

export function button(label, { icon: name, variant = '', size = '', busy = false, ...attrs } = {}) {
  const node = el(`button.btn${variant ? `.btn-${variant}` : ''}${size ? `.btn-${size}` : ''}`, {
    type: 'button', ...attrs, 'aria-busy': busy,
  }, name && icon(name), label);
  node.addEventListener('click', (event) => {
    if (node.getAttribute('aria-busy') === 'true') { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true });
  return node;
}
export function iconButton(name, label, attrs = {}) {
  return el('button.icon-btn', { type: 'button', title: label, 'aria-label': label, ...attrs }, icon(name));
}
/** `level` is the title's heading level (1–6), or 0 for a plain title where a heading would break the page outline. */
export function emptyState({ title, body, icon: name = 'pin', action, level = 3 }) {
  const heading = level >= 1 && level <= 6 ? el(`h${level}.empty-title`, {}, title) : el('p.empty-title', {}, title);
  return el('div.empty', {}, el('div.empty-icon', {}, icon(name, 28)), heading,
    body && el('p', {}, body), action);
}
export function chip(label, { status = '', onRemove } = {}) {
  return el(`span.chip${status ? `.chip-${status}` : ''}`, {}, label,
    onRemove && iconButton('close', t('ui.remove', { name: label }), { onclick: onRemove }));
}
export function spinner() { return el('span.spinner', { role: 'status', 'aria-label': t('ui.loading') }); }
export function skeleton(width = '100%') { return el('div.skeleton', { 'aria-hidden': 'true', style: { width } }); }
