/**
 * Review ▸ Show Changes: the pane along the right of the window listing the recent edits to the
 * workbook's cells, newest first (the record itself is kept by core/change-history.js). Each card says
 * who made the edit and when, where it was, and what the cell held before and after; an edit that
 * reached many cells (a paste, a fill) is one card that opens onto the cells it changed. A click on a
 * card selects its cells.
 *
 * The list can be narrowed to the sheet shown and to a range (the selection, or one typed in); the
 * cell menu's Show Changes opens the pane narrowed to the selected cells. Older edits wait behind
 * Load More. The foot of the pane leads on to the file's version history, and clears the record.
 */
import { el, relativeTime, fieldId } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog } from './modal.js';
import { changeEntries, clearChangeHistory, entrySheet, entryPlace, detailPlace } from '../core/change-history.js';
import { rangeName, parseRange, parseCellRef } from '../core/cell.js';

const PAGE = 50;
const KIND_LABEL = { undo: 'Undo', redo: 'Redo' };

/** A typed range, "B2" or "B2:D9" (absolute marks allowed); null when it is not one. */
function readRange(text) {
  const t = String(text || '').trim().replace(/\$/g, '').toUpperCase();
  if (!t) return null;
  if (t.includes(':')) return parseRange(t);
  const cell = parseCellRef(t);
  return cell ? { r1: cell.r, c1: cell.c, r2: cell.r, c2: cell.c } : null;
}

/**
 * ctx.reveal(sheetId, range) selects cells; ctx.currentUser() is the signed-in user's name, whose own
 * edits read "You"; ctx.run opens version history.
 */
export function createChangesPane(ctx) {
  const wb = ctx.wb;
  let limit = PAGE;
  let scope = 'all'; // 'all' sheets, or 'sheet': the sheet shown
  let rangeText = '';
  let lastSignature = '';
  let timer = null;
  const expanded = new Set(); // the many-cell cards opened onto their cells, kept open as the list is drawn again

  const uid = fieldId('changes');
  const close = el('button.icon-btn', { type: 'button', 'aria-label': 'Close Changes', html: icon('x', 16), onclick: () => api.hide() });
  const scopeSelect = el('select.select.chg-scope', { id: `${uid}-scope`, onchange: () => { scope = scopeSelect.value; limit = PAGE; render(true); } },
    el('option', { value: 'all' }, 'All sheets'), el('option', { value: 'sheet' }, 'This sheet'));
  const rangeInput = el('input.input.chg-range', {
    id: `${uid}-range`, type: 'text', placeholder: 'Any range', autocomplete: 'off', spellcheck: false,
    'aria-describedby': `${uid}-range-hint`,
    oninput: () => { rangeText = rangeInput.value; limit = PAGE; render(true); },
    onkeydown: (e) => { if (e.key === 'Escape' && rangeInput.value) { e.stopPropagation(); setRange(''); } },
  });
  const useSelection = el('button.btn.btn-sm.chg-use-selection', { type: 'button', title: 'Show the changes to the selected cells', onclick: () => filterToSelection() }, 'Selection');
  const clearRange = el('button.icon-btn.chg-clear-range', { type: 'button', 'aria-label': 'Show changes anywhere on the sheet', title: 'Any range', html: icon('x', 14), onclick: () => setRange('') });
  const rangeHint = el('span.chg-hint', { id: `${uid}-range-hint`, role: 'status', 'aria-live': 'polite' });
  const summary = el('p.chg-summary', { role: 'status', 'aria-live': 'polite' });
  const list = el('ol.chg-list', { 'aria-label': 'Changes, newest first' });
  const more = el('button.btn.btn-sm.chg-more', { type: 'button', onclick: () => { limit += PAGE; render(true); } }, 'Load More');
  const versions = el('button.btn.btn-sm.btn-ghost.chg-versions', { type: 'button', onclick: () => ctx.run?.('versions') }, el('span', { html: icon('clock', 14) }), 'Version History…');
  const clearAll = el('button.btn.btn-sm.btn-ghost.chg-clear', { type: 'button', onclick: () => clearHistory() }, el('span', { html: icon('trash', 14) }), 'Clear…');
  const root = el('section.a11y-pane.chg-pane', { role: 'region', 'aria-label': 'Changes', hidden: true },
    el('div.a11y-head', {}, el('span.a11y-title', {}, 'Changes'), close),
    el('div.chg-filters', {},
      el('label.chg-field', { for: `${uid}-scope` }, el('span.chg-field-label', {}, 'Sheet'), scopeSelect),
      el('div.chg-field', {}, el('label.chg-field-label', { for: `${uid}-range` }, 'Range'),
        el('div.chg-range-row', {}, rangeInput, clearRange, useSelection)),
      rangeHint),
    el('div.a11y-body.chg-body', {}, summary, list, more),
    el('div.chg-foot', {}, versions, clearAll));

  function setRange(text) {
    rangeInput.value = text;
    rangeText = text;
    limit = PAGE;
    render(true);
  }

  /** Narrow the list to the selection on the sheet shown. */
  function filterToSelection() {
    scope = 'sheet';
    scopeSelect.value = 'sheet';
    const rg = ctx.range?.();
    setRange(rg ? rangeName(rg) : '');
  }

  async function clearHistory() {
    if (!wb.changeHistory?.length) return;
    const ok = await confirmDialog({ title: 'Clear change history?', message: 'The list of changes kept with this spreadsheet will be emptied for everyone who opens it. The cells themselves stay as they are, and saved versions are kept.', confirmLabel: 'Clear history' });
    if (!ok) return;
    clearChangeHistory(wb);
    limit = PAGE;
    render(true);
  }

  const authorName = (author) => {
    if (!author) return 'Unknown author';
    const me = ctx.currentUser?.();
    return me && author === me ? 'You' : author;
  };
  const shown = (text) => (text == null ? el('span.chg-blank', {}, 'blank') : el('span.chg-value', { dir: 'auto', title: text }, text));
  const exactTime = (at) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function reveal(entry, range = entry.box) {
    const sheet = entrySheet(wb, entry);
    if (!sheet || !range) return;
    ctx.reveal?.(sheet.id, range);
  }

  function card(entry) {
    const sheet = entrySheet(wb, entry);
    const place = entryPlace(wb, entry);
    const name = authorName(entry.author);
    const what = KIND_LABEL[entry.kind] ? `${KIND_LABEL[entry.kind]}: ${entry.label}` : entry.label;
    const reachable = !!sheet && !!entry.box && !sheet.hidden;
    const head = el('div.chg-head', {},
      el('span.chg-avatar', { 'aria-hidden': 'true' }, (name === 'Unknown author' ? '?' : name).slice(0, 1).toUpperCase()),
      el('span.chg-author', {}, name),
      el('time.chg-time', { datetime: new Date(entry.at).toISOString(), title: exactTime(entry.at) }, relativeTime(entry.at)));
    const placeNode = reachable
      ? el('button.chg-place', { type: 'button', title: `Select ${place}`, onclick: () => reveal(entry) }, place)
      : el('span.chg-place.chg-place-gone', { title: sheet ? place : 'The sheet is no longer in the workbook' }, place || 'Workbook');
    const body = [el('div.chg-what', {}, el('span.chg-label', {}, what), placeNode)];
    if (entry.kind === 'cells') {
      const single = entry.count === 1 && entry.cells.length === 1;
      if (single) {
        const d = entry.cells[0];
        body.push(el('div.chg-diff', {}, shown(d.from), el('span.chg-arrow', { 'aria-label': 'changed to', html: icon('arrowRight', 12, 2) }), shown(d.to)));
      } else {
        const listed = entry.cells.length;
        const rows = entry.cells.map((d) => el('li.chg-cell', {},
          el('button.chg-cell-ref', { type: 'button', disabled: !reachable, onclick: () => reveal(entry, { r1: d.r, c1: d.c, r2: d.r, c2: d.c }) }, detailPlace(d)),
          shown(d.from), el('span.chg-arrow', { 'aria-label': 'changed to', html: icon('arrowRight', 12, 2) }), shown(d.to)));
        const rest = entry.partial ? 0 : entry.count - listed;
        const details = el('details.chg-cells', { open: expanded.has(entry.id), ontoggle: () => { if (details.open) expanded.add(entry.id); else expanded.delete(entry.id); } },
          el('summary', {}, `${entry.count.toLocaleString()} cell${entry.count === 1 ? '' : 's'} changed`),
          el('ul', {}, ...rows),
          rest > 0 && el('p.chg-rest', {}, `and ${rest.toLocaleString()} more not listed`));
        body.push(details);
      }
    } else if (entry.count > 1) {
      body.push(el('div.chg-diff.chg-muted', {}, `${entry.count} times`));
    }
    return el('li.chg-card', { className: `chg-card chg-${entry.kind}`, 'aria-label': `${name}, ${relativeTime(entry.at)}: ${what}${place ? ` at ${place}` : ''}` }, head, ...body);
  }

  function render(force = false) {
    if (root.hidden) return;
    const sheetId = ctx.sheetId?.() ?? wb.activeSheetId;
    const range = readRange(rangeText);
    const badRange = !!rangeText.trim() && !range;
    const history = wb.changeHistory || [];
    const signature = `${history.length}|${history.at(-1)?.id}|${history.at(-1)?.count}|${scope}|${sheetId}|${rangeText}|${limit}|${ctx.currentUser?.() || ''}`;
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    rangeInput.setAttribute('aria-invalid', String(badRange));
    clearRange.hidden = !rangeText;
    rangeHint.textContent = badRange ? 'Type a cell or range, like B2 or A1:D20' : range && scope === 'all' ? 'The range is looked for on every sheet' : '';
    const filter = { sheetId: scope === 'sheet' ? sheetId : null, range: badRange ? null : range, limit };
    const { entries, more: hasMore } = changeEntries(wb, filter);
    list.replaceChildren(...entries.map(card));
    more.hidden = !hasMore;
    clearAll.disabled = !history.length;
    if (!history.length) summary.textContent = 'No changes yet. Edits to cells are listed here as they are made.';
    else if (!entries.length) summary.textContent = range ? `No changes to ${rangeName(range)}${scope === 'sheet' ? ' on this sheet' : ''}.` : 'No changes on this sheet.';
    else summary.textContent = `${entries.length.toLocaleString()} change${entries.length === 1 ? '' : 's'}${hasMore ? ' shown, older ones below' : ''}${range ? ` to ${rangeName(range)}` : ''}${scope === 'sheet' ? ' on this sheet' : ''}.`;
  }

  // Edits arrive as the workbook's change events; the times ("2 min ago") are written again each minute.
  const onChange = (e) => { if (!root.hidden && e.detail?.type !== 'active-sheet') queueMicrotask(() => render()); };
  wb.addEventListener('change', onChange);
  const unsubscribe = ctx.subscribe?.(() => render());

  const api = {
    el: root,
    get open() { return !root.hidden; },
    /** Open the pane; `selection` narrows it to the selected cells on the sheet shown. */
    show({ selection = false } = {}) {
      root.hidden = false;
      if (selection) filterToSelection();
      else render(true);
      clearInterval(timer);
      timer = setInterval(() => render(true), 60_000);
      (selection ? list.querySelector('button') || close : scopeSelect).focus({ preventScroll: true });
    },
    hide() { root.hidden = true; clearInterval(timer); timer = null; ctx.grid?.focus?.(); },
    toggle() { if (root.hidden) api.show(); else api.hide(); },
    render,
    destroy() { clearInterval(timer); wb.removeEventListener('change', onChange); unsubscribe?.(); root.remove(); },
  };
  return api;
}
