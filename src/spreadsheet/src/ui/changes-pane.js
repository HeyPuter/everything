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
import { t, formatDate } from '../i18n/index.js';

const PAGE = 50;
/** What an undo or a redo entry says, around the name of the step it undid or redid. */
const KIND_LABEL = { undo: 'changesPane.undoStep', redo: 'changesPane.redoStep' };

/** A typed range, "B2" or "B2:D9" (absolute marks allowed); null when it is not one. */
function readRange(text) {
  const typed = String(text || '').trim().replace(/\$/g, '').toUpperCase();
  if (!typed) return null;
  if (typed.includes(':')) return parseRange(typed);
  const cell = parseCellRef(typed);
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
  const close = el('button.icon-btn', { type: 'button', 'aria-label': t('changesPane.closeChanges'), html: icon('x', 16), onclick: () => api.hide() });
  const scopeSelect = el('select.select.chg-scope', { id: `${uid}-scope`, onchange: () => { scope = scopeSelect.value; limit = PAGE; render(true); } },
    el('option', { value: 'all' }, t('changesPane.allSheets')), el('option', { value: 'sheet' }, t('changesPane.thisSheet')));
  const rangeInput = el('input.input.chg-range', {
    id: `${uid}-range`, type: 'text', placeholder: t('changesPane.anyRange'), autocomplete: 'off', spellcheck: false,
    'aria-describedby': `${uid}-range-hint`,
    oninput: () => { rangeText = rangeInput.value; limit = PAGE; render(true); },
    onkeydown: (e) => { if (e.key === 'Escape' && rangeInput.value) { e.stopPropagation(); setRange(''); } },
  });
  const useSelection = el('button.btn.btn-sm.chg-use-selection', { type: 'button', title: t('changesPane.useSelectionTitle'), onclick: () => filterToSelection() }, t('changesPane.selection'));
  const clearRange = el('button.icon-btn.chg-clear-range', { type: 'button', 'aria-label': t('changesPane.clearRange'), title: t('changesPane.anyRange'), html: icon('x', 14), onclick: () => setRange('') });
  const rangeHint = el('span.chg-hint', { id: `${uid}-range-hint`, role: 'status', 'aria-live': 'polite' });
  const summary = el('p.chg-summary', { role: 'status', 'aria-live': 'polite' });
  const list = el('ol.chg-list', { 'aria-label': t('changesPane.listLabel') });
  const more = el('button.btn.btn-sm.chg-more', { type: 'button', onclick: () => { limit += PAGE; render(true); } }, t('changesPane.loadMore'));
  const versions = el('button.btn.btn-sm.btn-ghost.chg-versions', { type: 'button', onclick: () => ctx.run?.('versions') }, el('span', { html: icon('clock', 14) }), t('changesPane.versionHistory'));
  const clearAll = el('button.btn.btn-sm.btn-ghost.chg-clear', { type: 'button', onclick: () => clearHistory() }, el('span', { html: icon('trash', 14) }), t('changesPane.clear'));
  const root = el('section.a11y-pane.chg-pane', { role: 'region', 'aria-label': t('changesPane.changes'), hidden: true },
    el('div.a11y-head', {}, el('span.a11y-title', {}, t('changesPane.changes')), close),
    el('div.chg-filters', {},
      el('label.chg-field', { for: `${uid}-scope` }, el('span.chg-field-label', {}, t('changesPane.sheet')), scopeSelect),
      el('div.chg-field', {}, el('label.chg-field-label', { for: `${uid}-range` }, t('changesPane.range')),
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
    const ok = await confirmDialog({ title: t('changesPane.clearTitle'), message: t('changesPane.clearMessage'), confirmLabel: t('changesPane.clearHistory') });
    if (!ok) return;
    clearChangeHistory(wb);
    limit = PAGE;
    render(true);
  }

  const authorName = (author) => {
    if (!author) return t('changesPane.unknownAuthor');
    const me = ctx.currentUser?.();
    return me && author === me ? t('changesPane.you') : author;
  };
  const shown = (text) => (text == null ? el('span.chg-blank', {}, t('changesPane.blank')) : el('span.chg-value', { dir: 'auto', title: text }, text));
  const exactTime = (at) => formatDate(new Date(at), { dateStyle: 'medium', timeStyle: 'short' });

  function reveal(entry, range = entry.box) {
    const sheet = entrySheet(wb, entry);
    if (!sheet || !range) return;
    ctx.reveal?.(sheet.id, range);
  }

  function card(entry) {
    const sheet = entrySheet(wb, entry);
    const place = entryPlace(wb, entry);
    const name = authorName(entry.author);
    // A step's name is kept with the book as it was said when it was made; only the record's own default is the app's to translate.
    const step = entry.label === 'Edit' ? t('changesPane.edit') : entry.label;
    const what = KIND_LABEL[entry.kind] ? t(KIND_LABEL[entry.kind], { label: step }) : step;
    const reachable = !!sheet && !!entry.box && !sheet.hidden;
    const head = el('div.chg-head', {},
      el('span.chg-avatar', { 'aria-hidden': 'true' }, (entry.author ? name : '?').slice(0, 1).toUpperCase()),
      el('span.chg-author', {}, name),
      el('time.chg-time', { datetime: new Date(entry.at).toISOString(), title: exactTime(entry.at) }, relativeTime(entry.at)));
    const placeNode = reachable
      ? el('button.chg-place', { type: 'button', title: t('changesPane.selectPlace', { place }), onclick: () => reveal(entry) }, place)
      : el('span.chg-place.chg-place-gone', { title: sheet ? place : t('changesPane.sheetGone') }, place || t('changesPane.workbook'));
    const body = [el('div.chg-what', {}, el('span.chg-label', {}, what), placeNode)];
    if (entry.kind === 'cells') {
      const single = entry.count === 1 && entry.cells.length === 1;
      if (single) {
        const d = entry.cells[0];
        body.push(el('div.chg-diff', {}, shown(d.from), el('span.chg-arrow', { 'aria-label': t('changesPane.changedTo'), html: icon('arrowRight', 12, 2) }), shown(d.to)));
      } else {
        const listed = entry.cells.length;
        const rows = entry.cells.map((d) => el('li.chg-cell', {},
          el('button.chg-cell-ref', { type: 'button', disabled: !reachable, onclick: () => reveal(entry, { r1: d.r, c1: d.c, r2: d.r, c2: d.c }) }, detailPlace(d)),
          shown(d.from), el('span.chg-arrow', { 'aria-label': t('changesPane.changedTo'), html: icon('arrowRight', 12, 2) }), shown(d.to)));
        const rest = entry.partial ? 0 : entry.count - listed;
        const details = el('details.chg-cells', { open: expanded.has(entry.id), ontoggle: () => { if (details.open) expanded.add(entry.id); else expanded.delete(entry.id); } },
          el('summary', {}, t('changesPane.cellsChanged', { count: entry.count })),
          el('ul', {}, ...rows),
          rest > 0 && el('p.chg-rest', {}, t('changesPane.moreNotListed', { count: rest })));
        body.push(details);
      }
    } else if (entry.count > 1) {
      body.push(el('div.chg-diff.chg-muted', {}, t('changesPane.times', { count: entry.count })));
    }
    return el('li.chg-card', { className: `chg-card chg-${entry.kind}`, 'aria-label': place ? t('changesPane.cardLabelAt', { name, when: relativeTime(entry.at), what, place }) : t('changesPane.cardLabel', { name, when: relativeTime(entry.at), what }) }, head, ...body);
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
    rangeHint.textContent = badRange ? t('changesPane.badRange') : range && scope === 'all' ? t('changesPane.everySheet') : '';
    const filter = { sheetId: scope === 'sheet' ? sheetId : null, range: badRange ? null : range, limit };
    const { entries, more: hasMore } = changeEntries(wb, filter);
    list.replaceChildren(...entries.map(card));
    more.hidden = !hasMore;
    clearAll.disabled = !history.length;
    if (!history.length) summary.textContent = t('changesPane.noneYet');
    else if (!entries.length) summary.textContent = range ? t('changesPane.noneTo', { range: rangeName(range), scope: scope === 'sheet' ? 'sheet' : 'all' }) : t('changesPane.noneOnSheet');
    else {
      const counted = { count: entries.length, more: hasMore ? 'yes' : 'no' };
      if (range) summary.textContent = scope === 'sheet' ? t('changesPane.countToOnSheet', { ...counted, range: rangeName(range) }) : t('changesPane.countTo', { ...counted, range: rangeName(range) });
      else summary.textContent = scope === 'sheet' ? t('changesPane.countOnSheet', counted) : t('changesPane.count', counted);
    }
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
