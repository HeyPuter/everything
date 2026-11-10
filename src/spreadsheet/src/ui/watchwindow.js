/**
 * Watch Window (Formulas ▸ Watch Window): a floating panel listing watched cells with their sheet, name,
 * cell, value and formula, kept current as the workbook changes. Add Watch takes the selected cells;
 * Delete Watch removes the chosen rows; a double-click goes to the cell. From the keyboard the arrows move between
 * rows, Space picks one (Cmd/Ctrl+Space adds it to those picked), Enter goes to its cell and Delete removes the
 * watches picked, or the one the focus is on.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { cellName } from '../core/cell.js';
import { parseRefText } from '../core/refs.js';
import { t } from '../i18n/index.js';

export function createWatchWindow(ctx) {
  // The watches picked, as the workbook's own entries: a structural edit carries a watch to another cell, and it stays picked.
  let chosen = new Set();
  const body = el('tbody');
  const table = el('table.watch-table', { role: 'grid', 'aria-label': t('watchwindow.watchedCells'), 'aria-multiselectable': 'true' },
    el('thead', {}, el('tr', {}, ...[t('watchwindow.book'), t('watchwindow.sheet'), t('common.name'), t('watchwindow.cell'), t('common.value'), t('watchwindow.formula')].map((h) => el('th', { scope: 'col' }, h)))), body);
  const addBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => ctx.run('addWatch') }, el('span', { html: icon('watch', 16) }), el('span', {}, t('watchwindow.addWatch')));
  const deleteBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => {
    ctx.wb.removeWatches(ctx.wb.watches.filter((w) => chosen.has(w)));
    chosen = new Set();
  } }, t('watchwindow.deleteWatch'));
  const close = el('button.icon-btn', { type: 'button', 'aria-label': t('watchwindow.close'), html: icon('x', 16), onclick: () => api.hide() });
  const head = el('div.watch-head', {}, el('span.watch-title', {}, t('watchwindow.title')), close);
  const root = el('section.watch-window', { role: 'region', 'aria-label': t('watchwindow.title'), hidden: true },
    head, el('div.watch-actions', {}, addBtn, deleteBtn), el('div.watch-scroll', {}, table));
  const nameOf = (sheet, r, c) => {
    for (const n of ctx.wb.names || []) {
      if (n.hidden) continue;
      const ref = parseRefText(String(n.ref || '').replace(/^=/, ''));
      if (ref && (ref.sheet || sheet.name) === sheet.name && ref.r1 === r && ref.c1 === c && ref.r2 === r && ref.c2 === c) return n.name;
    }
    return '';
  };
  const pick = (w, add) => { if (!add) chosen = new Set(); chosen.add(w); render(); };
  const rowOf = (w) => [...body.rows].find((tr) => watchOf.get(tr) === w);
  const watchOf = new WeakMap();
  function render() {
    if (root.hidden) return;
    const book = ctx.docName?.() || '';
    // The rows are drawn afresh: the one with the focus hands it to its successor, so an edit (or a click) leaves it there.
    const focused = watchOf.get(document.activeElement);
    chosen = new Set(ctx.wb.watches.filter((w) => chosen.has(w)));
    body.replaceChildren(...ctx.wb.watches.map((w) => {
      const sheet = ctx.wb.sheet(w.sheetId);
      if (!sheet) return null;
      const cell = ctx.wb.getCell(w.sheetId, w.r, w.c);
      const row = el('tr', { tabindex: 0, 'aria-selected': String(chosen.has(w)),
        onclick: (e) => pick(w, e.metaKey || e.ctrlKey),
        ondblclick: () => ctx.goTo(sheet.id, w.r, w.c),
        onkeydown: (e) => {
          if (e.target !== row) return;
          const step = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[e.key];
          if (step) {
            e.preventDefault();
            const all = [...body.rows], at = all.indexOf(row);
            all[Math.max(0, Math.min(all.length - 1, at + step))]?.focus();
          } else if (e.key === ' ') { e.preventDefault(); pick(w, e.metaKey || e.ctrlKey); }
          else if (e.key === 'Enter') { e.preventDefault(); ctx.goTo(sheet.id, w.r, w.c); }
          else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            const gone = chosen.size ? ctx.wb.watches.filter((x) => chosen.has(x)) : [w];
            const all = ctx.wb.watches, at = all.indexOf(w);
            // The focus goes on to the watch after those removed (or the one before, at the end of the list).
            const next = all.slice(at + 1).find((x) => !gone.includes(x)) || all.slice(0, at).reverse().find((x) => !gone.includes(x));
            chosen = new Set();
            ctx.wb.removeWatches(gone);
            render();
            (next && rowOf(next) || addBtn).focus();
          }
        } },
        el('td', {}, book), el('td', {}, sheet.name), el('td', {}, nameOf(sheet, w.r, w.c)), el('td', {}, cellName(w.r, w.c)),
        el('td', {}, ctx.wb.getDisplay(w.sheetId, w.r, w.c)), el('td.mono', {}, cell?.f != null && !ctx.wb.formulaHiddenAt?.(w.sheetId, w.r, w.c) ? `=${cell.f}` : ''));
      watchOf.set(row, w);
      return row;
    }).filter(Boolean));
    deleteBtn.disabled = !chosen.size;
    if (focused) rowOf(focused)?.focus();
  }
  // The window moves by its title bar, kept inside the page.
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const start = { x: e.clientX, y: e.clientY, left: root.offsetLeft, top: root.offsetTop };
    const move = (ev) => {
      root.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, start.left + ev.clientX - start.x))}px`;
      root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, start.top + ev.clientY - start.y))}px`;
      root.style.right = 'auto'; root.style.bottom = 'auto';
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  const unsubscribe = ctx.subscribe(render);
  const api = {
    el: root,
    get open() { return !root.hidden; },
    show() { root.hidden = false; render(); },
    hide() { root.hidden = true; ctx.grid.focus(); },
    toggle() { if (root.hidden) api.show(); else api.hide(); },
    destroy() { unsubscribe(); root.remove(); },
  };
  return api;
}
