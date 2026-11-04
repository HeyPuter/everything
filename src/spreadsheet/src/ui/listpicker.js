/** Dropdown menus keep long lists searchable and render at most one page. */
import { el, fieldId, isComposing } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { t } from '../i18n/index.js';

const PAGE_SIZE = 200;

/**
 * `current` is the index of the option the cell holds (the checked item), or
 * -1; the list opens on it. Left out, it is found by asking itemAt.
 */
export function openValuePicker({ anchor, labels, itemAt, clearItem, onClose, minWidth = 160, current }) {
  const tail = clearItem ? [{ separator: true }, clearItem] : [];
  const config = { anchor, label: t('listpicker.chooseValue'), minWidth, onClose };
  if (current === undefined) { current = -1; for (let i = 0; i < labels.length && current < 0; i++) if (itemAt(i).checked) current = i; }
  const focusCurrent = (root) => root.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')?.focus();
  if (labels.length <= PAGE_SIZE) {
    const menu = openMenu({ ...config, items: [...labels.map((_, i) => itemAt(i)), ...tail] });
    if (current >= 0) focusCurrent(menu.menu);
    return menu;
  }

  const results = el('div.fn-list', { id: fieldId('list-options') });
  const search = el('input.input', { type: 'search', 'aria-label': t('listpicker.searchLabel'), 'aria-controls': results.id, placeholder: t('listpicker.searchPlaceholder'), autocomplete: 'off' });
  const status = el('div.menu-header', { role: 'status', 'aria-live': 'polite' });
  const pages = el('div');
  let matched = labels.map((_, i) => i);
  let page = current >= 0 ? Math.floor(current / PAGE_SIZE) : 0; // the page holding the cell's value
  let menu;

  function render(focus = false) {
    const start = page * PAGE_SIZE;
    results.replaceChildren(...matched.slice(start, start + PAGE_SIZE).map((index) => {
      const item = itemAt(index);
      const checked = !!item.checked;
      const mark = checked ? icon('check', 16, 2.2) : '';
      return el('button.menu-item', {
        type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(checked), tabindex: -1,
        'aria-label': item.ariaLabel || null,
        className: `menu-item${checked ? ' checked' : ''}`,
        onclick: () => { menu.close(); item.onSelect?.(); },
      },
      item.swatch
        ? el('span.menu-icon', {}, el('span.menu-swatch', { style: { backgroundColor: item.swatch }, 'aria-hidden': 'true', html: mark }))
        : el('span.menu-icon', { html: mark }),
      el('span.menu-label', {}, item.label),
      item.shortcut && el('span.menu-shortcut', { 'aria-hidden': 'true' }, item.shortcut));
    }));
    status.textContent = matched.length ? t('listpicker.range', { from: start + 1, to: Math.min(start + PAGE_SIZE, matched.length), count: matched.length }) : t('listpicker.noMatches');
    const changePage = (delta) => { page += delta; render(true); };
    pages.replaceChildren(...[
      page > 0 && el('button.menu-item', { type: 'button', role: 'menuitem', tabindex: -1, onclick: () => changePage(-1) }, t('listpicker.previous')),
      start + PAGE_SIZE < matched.length && el('button.menu-item', { type: 'button', role: 'menuitem', tabindex: -1, onclick: () => changePage(1) }, t('listpicker.next')),
    ].filter(Boolean));
    results.scrollTop = 0;
    if (focus) (results.querySelector('button') || search).focus();
  }

  search.addEventListener('input', () => {
    const query = search.value.toLowerCase();
    matched = [];
    for (let i = 0; i < labels.length; i++) if (labels[i].toLowerCase().includes(query)) matched.push(i);
    page = 0;
    render();
  });
  search.addEventListener('keydown', (event) => {
    if (isComposing(event)) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const buttons = results.querySelectorAll('button');
    const target = event.key === 'ArrowUp' ? buttons[buttons.length - 1] : buttons[0];
    if (event.key === 'Enter') target?.click();
    else target?.focus();
  });
  results.addEventListener('keydown', (event) => {
    if (isComposing(event) || event.key !== 'ArrowUp' || event.target !== results.querySelector('button')) return;
    event.preventDefault();
    event.stopPropagation();
    search.focus();
  });
  render();
  menu = openMenu({ ...config, items: [
    { custom: el('div.fn-search', {}, search) }, { custom: status }, { custom: results }, { custom: pages }, ...tail,
  ] });
  if (current >= 0) focusCurrent(results); else search.focus();
  return menu;
}
