import { el, isComposing } from './dom.js';
import { cellName } from '../core/cell.js';

// Bound the rendered list independently of how many matches the search engine found.
const PAGE_SIZE = 100;
const excerpt = text => {
  const value = String(text ?? '');
  return value.length > 200 ? `${value.slice(0, 199)}…` : value;
};

export function createFindResults({ wb, onSelect, focusQuery }) {
  let matches = [], current = -1, start = 0, rendered = null;
  const summary = el('span.find-results-summary', { role: 'status' });
  const previous = el('button.btn.btn-ghost.btn-sm', { type: 'button', 'aria-label': 'Previous results page', onclick: () => { if (start > 0) activate(start - PAGE_SIZE); } }, 'Previous');
  const next = el('button.btn.btn-ghost.btn-sm', { type: 'button', 'aria-label': 'Next results page', onclick: () => { if (start + PAGE_SIZE < matches.length) activate(start + PAGE_SIZE); } }, 'Next');
  const body = el('tbody');
  const table = el('table.find-results-table', { 'aria-label': 'Matching cells' },
    el('thead', {}, el('tr', {}, ...['Sheet', 'Cell', 'Value', 'Formula'].map(label => el('th', { scope: 'col' }, label)))), body);
  const scroll = el('div.find-results-scroll', {}, table);
  const root = el('div.find-results', { role: 'region', 'aria-label': 'Find results', hidden: true },
    el('div.find-results-header', {}, summary, previous, next), scroll);

  function activate(index, focus = false) {
    if (!matches[index]) return;
    onSelect(index);
    if (focus) {
      const button = body.querySelector(`[data-find-index="${current}"]`);
      if (button) { button.focus({ preventScroll: true }); button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      else focusQuery();
    }
  }

  function render(found, selected, message = '') {
    const hadFocus = body.contains(document.activeElement);
    const previousCurrent = current;
    matches = message ? [] : found;
    current = selected;
    const offset = Math.floor(Math.max(0, current) / PAGE_SIZE) * PAGE_SIZE;
    const rebuild = rendered !== matches || offset !== start;
    start = offset;
    const end = Math.min(start + PAGE_SIZE, matches.length);
    summary.textContent = message || (matches.length ? `${start + 1}–${end} of ${matches.length} results` : 'No matches');
    previous.setAttribute('aria-disabled', String(!matches.length || start === 0));
    next.setAttribute('aria-disabled', String(end >= matches.length));
    previous.hidden = next.hidden = matches.length <= PAGE_SIZE;
    scroll.hidden = !matches.length;
    if (rebuild) {
      rendered = matches;
      body.replaceChildren(...matches.slice(start, end).map((match, k) => {
        const index = start + k, address = cellName(match.r, match.c);
        const sheet = wb.sheet(match.sheetId);
        const cell = wb.getCell(match.sheetId, match.r, match.c);
        const value = excerpt(wb.getDisplay(match.sheetId, match.r, match.c));
        const formula = cell?.f == null || wb.formulaHiddenAt(match.sheetId, match.r, match.c) ? '' : `=${excerpt(cell.f)}`;
        const button = el('button.find-result-cell', { type: 'button', 'data-find-index': index,
          'aria-label': `${sheet?.name || 'Sheet'} ${address}`, onclick: () => activate(index) }, address);
        const row = el('tr', { onclick: e => { if (!e.target.closest('button')) activate(index); } },
          el('td', {}, el('span', { dir: 'auto' }, sheet?.name || '')),
          el('td', {}, button), el('td', { title: value }, value), el('td', { title: formula }, formula));
        button.addEventListener('keydown', e => {
          if (isComposing(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
          const to = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: matches.length - 1,
            PageDown: index + PAGE_SIZE, PageUp: index - PAGE_SIZE }[e.key];
          if (to == null) return;
          e.preventDefault();
          activate(Math.max(0, Math.min(matches.length - 1, to)), true);
        });
        return row;
      }));
    }
    for (const button of body.querySelectorAll('[data-find-index]')) {
      const selectedRow = Number(button.dataset.findIndex) === current;
      button.tabIndex = selectedRow ? 0 : -1;
      if (selectedRow) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
      button.closest('tr').classList.toggle('current', selectedRow);
    }
    if (!root.hidden && (rebuild || previousCurrent !== current)) body.querySelector(`[data-find-index="${current}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (rebuild && hadFocus) {
      const button = body.querySelector(`[data-find-index="${current}"]`);
      if (button) button.focus({ preventScroll: true }); else focusQuery();
    }
  }

  return { el: root, render, clear: () => render([], -1, 'Enter a search term') };
}
