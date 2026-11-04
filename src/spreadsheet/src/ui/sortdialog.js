/**
 * Sort dialog: up to 64 sort keys over a range, sorting rows top to
 * bottom (the usual) or columns left to right, by value (A to Z, Z to A, or a
 * custom list's order, such as Jan to Dec) or by fill color, with options to
 * keep a header in place and to compare text case-sensitively.
 */

import { el, fieldId } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { swatchColor } from './toolbar.js';
import { colName, colIndex, rangeName } from '../core/cell.js';
import { dateNames, getLocale } from '../core/format.js';
import * as S from '../core/selection.js';
import { t } from '../i18n/index.js';

// Past this many lines a key is typed rather than picked from a list: a
// whole-column selection has a million rows, and a list of them takes seconds.
const MAX_LINE_OPTIONS = 500;
const MAX_LEVELS = 64;

/**
 * The custom lists a key can sort by, as Excel's Order offers them: the weekdays and the months, short and whole,
 * in the regional format's names. Each is offered in its order and reversed; the values a list does not name
 * follow its entries (see keyComparators in the workbook).
 */
export function sortLists(loc = getLocale()) {
  const { months, days } = dateNames(loc);
  const label = (items) => t('sortdialog.listLabel', { first: items[0], second: items[1], third: items[2], last: items.at(-1) });
  return [days.short, days.long, months.short, months.long].map((items) => ({ items, label: label(items), reverse: label([...items].reverse()) }));
}

/** A text first row above non-text data reads as a header. */
export function looksLikeHeader(wb, sheetId, range) {
  if (range.r1 >= range.r2) return false;
  let textHeads = 0;
  let filledHeads = 0;
  let typedBelow = 0;
  for (let c = range.c1; c <= range.c2; c++) {
    const head = wb.getValue(sheetId, range.r1, c);
    const below = wb.getValue(sheetId, range.r1 + 1, c);
    if (head != null && head !== '') filledHeads++;
    if (typeof head === 'string' && head) textHeads++;
    if (below != null && typeof below !== 'string') typedBelow++;
  }
  // Every filled cell of the first row must be text; then a typed row below
  // (or an all-text first row across every column) reads as a header.
  if (!textHeads || textHeads !== filledHeads) return false;
  return typedBelow > 0 || textHeads === range.c2 - range.c1 + 1;
}

/**
 * Whether the Sort dialog starts with "Data has a header row" ticked, by the quick sort's rule:
 * the block read around one cell, or whole columns, takes an all-text first row as a header (a
 * title over a list of names has no other way to stay put); an explicit selection keeps its first
 * row only when that text row sits over typed values, so a selected list of
 * names sorts whole, its first entry included.
 */
export function sortHeaderDefault(wb, sheetId, range, { expanded = false } = {}) {
  // The first row of a filtered list is its header whatever it holds (years over the figures under them), as Excel
  // reads it: taken for data, it was sorted in among the rows and the filter's buttons stood over a record.
  if (range.r1 < range.r2 && wb.filtersForSheet(sheetId).some(({ range: f }) => f.r1 === range.r1 && f.c1 <= range.c2 && f.c2 >= range.c1)) return true;
  if (!looksLikeHeader(wb, sheetId, range)) return false;
  if (expanded) return true;
  for (let c = range.c1; c <= range.c2; c++) {
    const below = wb.getValue(sheetId, range.r1 + 1, c);
    if (below != null && typeof below !== 'string') return true;
  }
  return false;
}

/**
 * Why the rows (or, for axis 'col', the columns) of a range cannot change
 * places, as a sentence for a toast; '' when they can. `verb` names the tool
 * ("sort", "remove duplicates").
 */
export function rearrangeProblem(wb, sheetId, range, axis = 'row', verb = 'sort') {
  const reason = wb.rearrangeBlocker(sheetId, range, axis);
  if (!reason) return '';
  const what = reason === 'table' && axis === 'col' ? 'tableColumns'
    : ['merged', 'array', 'protected', 'pivot', 'table'].includes(reason) ? reason : 'other';
  return t('sortdialog.rearrangeProblem', { verb: { sort: 'sort', 'remove duplicates': 'dedupe', shuffle: 'shuffle' }[verb] || 'other', what });
}

/**
 * The block a sort of an explicit selection would tear apart: when data sits right beside the selection, in
 * the rows it covers, sorting only the selection moves its values away from the rest of their rows (scores
 * leave their names). That block, joined with the selection, is returned, so the sort can be offered over it
 * as Excel's Sort Warning offers; null when nothing lies beside it. A table needs no offer: its rows always
 * move whole.
 */
export function sortExpansion(wb, sheetId, range) {
  const sheet = wb.sheet(sheetId);
  const used = wb.usedRange(sheetId);
  if (!sheet || !used) return null;
  if (sheet.tables.some(({ range: t }) => t.r1 <= range.r2 && t.r2 >= range.r1 && t.c1 <= range.c2 && t.c2 >= range.c1)) return null;
  const filled = (r, c) => { const v = wb.getValue(sheetId, r, c); return v != null && v !== ''; };
  for (const c of [range.c1 - 1, range.c2 + 1]) {
    if (c < 0 || c > used.c2) continue;
    for (let r = Math.max(range.r1, used.r1), last = Math.min(range.r2, used.r2); r <= last; r++) {
      if (!filled(r, c)) continue;
      const block = wb.dataRegion(sheetId, r, c);
      if (!block) continue;
      return { r1: Math.min(block.r1, range.r1), c1: Math.min(block.c1, range.c1), r2: Math.max(block.r2, range.r2), c2: Math.max(block.c2, range.c2) };
    }
  }
  return null;
}

/**
 * Excel's Sort Warning, for a selection with data beside it: resolves true to take in the whole block (the
 * default, as rows then stay together), false to work on the selection alone, null when cancelled. `kind`
 * is what is about to happen: 'sort', or 'dedupe' (Remove Duplicates; also chosen by the older `verb: 'removed'`).
 * `title` and `action` override the dialog's title and its button.
 */
export function confirmSortExpansion({ kind = 'sort', verb = null, title = null, action = null } = {}) {
  const dedupe = kind === 'dedupe' || verb === 'removed';
  title ??= dedupe ? t('sortdialog.expand.dedupeTitle') : t('sortdialog.expand.title');
  action ??= dedupe ? t('sortdialog.expand.continue') : t('sortdialog.sort');
  return new Promise((resolve) => {
    let answer = null;
    const name = fieldId('sort-expand');
    const radio = (value, label, checked) => {
      const id = fieldId('sort-expand');
      return el('label.find-option', { for: id }, el('input', { type: 'radio', name, id, value, checked }), el('span', {}, label));
    };
    const expand = radio('expand', t('sortdialog.expand.expand'), true);
    const content = el('form.sort-expand', { onsubmit: (e) => {
      e.preventDefault();
      answer = expand.querySelector('input').checked;
      modal.close();
    } },
    el('p.modal-text', {}, dedupe ? t('sortdialog.expand.dedupeMessage') : t('sortdialog.expand.message')),
    el('div', { role: 'radiogroup', 'aria-label': t('sortdialog.expand.what'), style: { display: 'grid', gap: '8px' } },
      expand, radio('selection', t('sortdialog.expand.selection'), false)),
    el('div.row.row-end', { style: { marginTop: '16px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, action)));
    const modal = openModal({ title, content, initialFocus: expand.querySelector('input'), onClose: () => resolve(answer) });
  });
}

/** `expanded`: the range was widened from the selection (see sortExpansion), and reads its header as a block around a cell does. */
export function openSortDialog(ctx, range, { expanded: widened = false } = {}) {
  const sheetId = ctx.sheetId();
  const headerId = fieldId('sort');
  // The range came expanded from one selected cell, or covers whole columns: read as the quick sort reads them.
  const expanded = widened || (!!ctx.selection && S.isSingle(ctx.selection())) || (range.r1 === 0 && range.r2 >= ctx.wb.sheet(sheetId).rows - 1);
  const rowHeader = sortHeaderDefault(ctx.wb, sheetId, range, { expanded });
  const headerInput = el('input', { type: 'checkbox', id: headerId, checked: rowHeader });
  // The default reads the first row; until the box is ticked or cleared by hand, it follows the direction.
  let headerTouched = false;
  const headerText = el('span', {}, t('sortdialog.headerRow'));
  const caseId = fieldId('sort');
  const caseInput = el('input', { type: 'checkbox', id: caseId });
  const orientSelect = el('select.select', { 'aria-label': t('sortdialog.direction.label') },
    el('option', { value: 'rows' }, t('sortdialog.direction.rows')),
    el('option', { value: 'cols' }, t('sortdialog.direction.cols')));
  const levels = el('div.sort-levels', { role: 'list', 'aria-label': t('sortdialog.levels') });
  const lists = sortLists();
  let selectedRow = null;
  const byRows = () => orientSelect.value === 'rows';
  // The lines a key can pick: columns when sorting rows, rows when sorting columns.
  const firstLine = () => (byRows() ? range.c1 : range.r1);
  const lastLine = () => (byRows() ? range.c2 : range.r2);
  const lineCount = () => lastLine() - firstLine() + 1;
  const lines = () => Array.from({ length: lineCount() }, (_, i) => firstLine() + i);
  const labelFor = (i) => {
    if (byRows()) {
      const head = headerInput.checked ? ctx.wb.getDisplay(sheetId, range.r1, i) : '';
      return head ? t('sortdialog.line.columnHead', { column: colName(i), head }) : t('sortdialog.line.column', { column: colName(i) });
    }
    const head = headerInput.checked ? ctx.wb.getDisplay(sheetId, i, range.c1) : '';
    return head ? t('sortdialog.line.rowHead', { row: i + 1, head }) : t('sortdialog.line.row', { row: i + 1 });
  };

  function addLevel(defaultLine, draft = null, after = null) {
    if (levels.children.length >= MAX_LEVELS) return;
    const typed = lineCount() > MAX_LINE_OPTIONS;
    const lineSelect = typed
      ? el('input.input', { type: 'text', 'aria-label': byRows() ? t('sortdialog.byColumn') : t('sortdialog.byRow'), value: byRows() ? colName(defaultLine) : String(defaultLine + 1), autocomplete: 'off', spellcheck: false })
      : el('select.select', { 'aria-label': byRows() ? t('sortdialog.byColumn') : t('sortdialog.byRow') }, lines().map((i) => el('option', { value: i, selected: i === defaultLine }, labelFor(i))));
    // The chosen line, or null when the typed one is not a line of the range.
    const lineOf = () => {
      if (!typed) return Number(lineSelect.value);
      const text = lineSelect.value.trim();
      const line = byRows() ? colIndex(text) : /^\d+$/.test(text) ? Number(text) - 1 : -1;
      return line >= firstLine() && line <= lastLine() ? line : null;
    };
    const modeSelect = el('select.select', { 'aria-label': t('sortdialog.sortOn') },
      el('option', { value: 'value' }, t('sortdialog.on.values')),
      el('option', { value: 'color', disabled: !byRows() }, t('sortdialog.on.cellColor')),
      el('option', { value: 'font', disabled: true }, t('sortdialog.on.fontColor')),
      el('option', { value: 'icon', disabled: true }, t('sortdialog.on.cellIcon')));
    const dirSelect = el('select.select', { 'aria-label': t('sortdialog.orderLabel') });
    const syncOrder = (value) => {
      const color = modeSelect.value === 'color';
      dirSelect.replaceChildren(...(color
        ? [el('option', { value: 'colorTop' }, t('sortdialog.order.top')), el('option', { value: 'colorBottom' }, t('sortdialog.order.bottom'))]
        : [el('option', { value: 'asc' }, t('sortdialog.order.asc')), el('option', { value: 'desc' }, t('sortdialog.order.desc')),
          el('optgroup', { label: t('sortdialog.order.customLists') }, ...lists.flatMap((list, i) => [el('option', { value: `list${i}` }, list.label), el('option', { value: `list${i}r` }, list.reverse)]))]));
      if ([...dirSelect.options].some((o) => o.value === value)) dirSelect.value = value;
    };
    // Sorting by fill: the colors present in the chosen column, as swatches.
    const colorSelect = el('select.select.sort-color', { 'aria-label': t('sortdialog.fillColor'), hidden: true });
    const fillColors = () => {
      const col = lineOf();
      const dataRange = headerInput.checked ? { ...range, r1: range.r1 + 1 } : range;
      const fills = byRows() && col != null && dataRange.r1 <= dataRange.r2 ? ctx.wb.columnFills(sheetId, dataRange, col) : [];
      const current = colorSelect.value;
      // Only a hex colour is painted: `background` also takes a url(), and a fill string smuggled into
      // an imported file must not fetch anything when its column is listed here.
      colorSelect.replaceChildren(...fills.map(({ color, count }) => el('option', { value: color, style: { background: swatchColor(color) || '' } }, t('sortdialog.fillCount', { color, count }))));
      if (fills.some((f) => f.color === current)) colorSelect.value = current;
      colorSelect.style.background = swatchColor(colorSelect.value) || '';
      colorSelect.disabled = !fills.length;
      if (!fills.length) colorSelect.append(el('option', { value: '' }, t('sortdialog.noFillInColumn')));
    };
    const byColor = () => modeSelect.value === 'color';
    const colorField = el('label.sort-field.sort-fill', {}, el('span.sort-field-label', {}, t('sortdialog.fillColor')), el('div.select-wrap', {}, colorSelect));
    const noColor = el('span.sort-no-color', {}, '—');
    colorField.append(noColor);
    const syncColor = () => {
      colorSelect.hidden = !byRows() || !byColor();
      noColor.hidden = !colorSelect.hidden;
      colorField.classList.toggle('inactive', colorSelect.hidden);
      if (!colorSelect.hidden) fillColors();
    };
    modeSelect.addEventListener('change', () => { syncOrder(); syncColor(); });
    lineSelect.addEventListener('change', () => { if (!colorSelect.hidden) fillColors(); });
    colorSelect.addEventListener('change', () => { colorSelect.style.background = swatchColor(colorSelect.value) || ''; });
    const row = el('div.sort-level', { role: 'listitem' },
      el('span.sort-priority'),
      el('label.sort-field', {}, el('span.sort-field-label.sort-line-label', {}, byRows() ? t('sortdialog.column') : t('sortdialog.row')), el(typed ? 'div' : 'div.select-wrap', {}, lineSelect)),
      el('label.sort-field', {}, el('span.sort-field-label', {}, t('sortdialog.sortOn')), el('div.select-wrap', {}, modeSelect)),
      el('label.sort-field', {}, el('span.sort-field-label', {}, t('sortdialog.orderLabel')), el('div.select-wrap', {}, dirSelect)),
      colorField,
      el('button.icon-btn.sort-level-remove', { type: 'button', html: icon('x', 16), 'aria-label': t('sortdialog.removeLevel'), onclick: () => {
        // The button goes with its level, so the focus moves to the next level's (or the previous one's), or to adding a level.
        const neighbour = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        if (selectedRow === row) selectedRow = neighbour;
        syncAdd();
        (neighbour?.querySelector('.sort-level-remove') || addBtn).focus({ preventScroll: true });
      } }));
    // A refusal about this level's colour points at the line to change, not at the colour select,
    // which is disabled and empty exactly when the refusal happens.
    row.focusLine = () => { lineSelect.focus({ preventScroll: true }); row.scrollIntoView?.({ block: 'nearest' }); };
    row.read = () => {
      if (byColor() && byRows()) return { line: lineOf(), ascending: dirSelect.value === 'colorTop', color: colorSelect.value || '' };
      const list = /^list(\d+)(r?)$/.exec(dirSelect.value);
      return list ? { line: lineOf(), ascending: !list[2], list: lists[Number(list[1])].items } : { line: lineOf(), ascending: dirSelect.value === 'asc' };
    };
    row.relabel = () => {
      if (!typed) [...lineSelect.options].forEach((o) => { o.textContent = labelFor(Number(o.value)); });
      syncColor();
    };
    row.copyDraft = () => ({ line: lineOf(), text: lineSelect.value, mode: modeSelect.value, order: dirSelect.value, color: colorSelect.value });
    row.addEventListener('focusin', () => { if (row.parentElement === levels) selectRow(row); });
    row.addEventListener('click', () => { if (row.parentElement === levels) selectRow(row); });
    if (draft) {
      lineSelect.value = draft.text;
      modeSelect.value = draft.mode;
    }
    syncOrder(draft?.order);
    syncColor();
    if (draft?.color && [...colorSelect.options].some((o) => o.value === draft.color)) {
      colorSelect.value = draft.color;
      colorSelect.style.background = swatchColor(colorSelect.value) || '';
    }
    if (after) after.after(row);
    else levels.append(row);
    selectRow(row);
    return row;
  }

  // Prefer an unused line. Once all lines are used, more levels can still
  // prioritize another fill color in the same column.
  const addBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', html: icon('plus', 14, 2), onclick: () => {
    const used = new Set([...levels.children].map((row) => row.read().line));
    let line = firstLine();
    while (used.has(line) && line < lastLine()) line++;
    addLevel(line)?.focusLine();
  } }, el('span', {}, t('sortdialog.addLevel')));
  const copyBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => {
    if (!selectedRow || levels.children.length >= MAX_LEVELS) return;
    const draft = selectedRow.copyDraft();
    addLevel(draft.line ?? firstLine(), draft, selectedRow)?.focusLine();
  } }, t('sortdialog.copyLevel'));
  const move = (direction) => {
    if (!selectedRow) return;
    const neighbour = direction < 0 ? selectedRow.previousElementSibling : selectedRow.nextElementSibling;
    if (!neighbour) return;
    if (direction < 0) neighbour.before(selectedRow);
    else neighbour.after(selectedRow);
    syncAdd();
    selectedRow.focusLine();
  };
  const upBtn = el('button.icon-btn', { type: 'button', html: icon('arrowUp', 16), 'aria-label': t('sortdialog.moveUp'), title: t('sortdialog.moveUp'), onclick: () => move(-1) });
  const downBtn = el('button.icon-btn', { type: 'button', html: icon('arrowDown', 16), 'aria-label': t('sortdialog.moveDown'), title: t('sortdialog.moveDown'), onclick: () => move(1) });
  const status = el('span.sort-level-count', { role: 'status', 'aria-live': 'polite' });
  function selectRow(row) { selectedRow = row; syncAdd(); }
  function syncAdd() {
    addBtn.disabled = levels.children.length >= MAX_LEVELS;
    copyBtn.disabled = !selectedRow || addBtn.disabled;
    upBtn.disabled = !selectedRow?.previousElementSibling;
    downBtn.disabled = !selectedRow?.nextElementSibling;
    [...levels.children].forEach((row, i) => {
      row.querySelector('.sort-priority').textContent = i ? t('sortdialog.thenBy') : t('sortdialog.sortBy');
      row.classList.toggle('selected', row === selectedRow);
      row.setAttribute('aria-label', t('sortdialog.levelLabel', { index: i + 1 }));
    });
    const index = [...levels.children].indexOf(selectedRow);
    const text = index < 0 ? t('sortdialog.noLevels') : t('sortdialog.levelOf', { index: index + 1, count: levels.children.length });
    if (status.textContent !== text) status.textContent = text;
  }
  headerInput.addEventListener('change', () => { headerTouched = true; for (const row of levels.children) row.relabel(); });
  orientSelect.addEventListener('change', () => {
    headerText.textContent = byRows() ? t('sortdialog.headerRow') : t('sortdialog.headerColumn');
    // A header row says nothing of the first column: sorting left to right starts with every column in the sort,
    // as Excel's does, rather than keeping column A in place because row 1 read as headings.
    if (!headerTouched) headerInput.checked = byRows() && rowHeader;
    levels.replaceChildren();
    selectedRow = null;
    addLevel(byRows() ? Math.max(range.c1, Math.min(range.c2, ctx.active().c)) : Math.max(range.r1, Math.min(range.r2, ctx.active().r)));
  });

  const submit = (e) => {
    e.preventDefault();
    // A protected sheet refuses the sort; say so rather than reporting a sort that did not happen.
    if (ctx.wb.isProtected(sheetId)) { toast(t('sortdialog.protected'), { icon: 'lock' }); return; }
    const keys = [...levels.children].map((row) => row.read());
    // Every level can be removed; with none left there is nothing to sort by, and silence would read as a sort that did nothing.
    if (!keys.length) { toast(t('sortdialog.addLevelFirst'), { icon: 'info' }); return; }
    if (keys.some((k) => k.line == null)) {
      toast(byRows() ? t('sortdialog.enterColumn', { first: colName(range.c1), last: colName(range.c2) }) : t('sortdialog.enterRow', { first: range.r1 + 1, last: range.r2 + 1 }), { icon: 'info' });
      return;
    }
    const opts = { caseSensitive: caseInput.checked };
    let dataRange;
    let sorted;
    if (byRows()) {
      dataRange = headerInput.checked ? { ...range, r1: range.r1 + 1 } : range;
      // A lone header row has nothing under it to sort; say so rather than closing as if it had been sorted.
      if (dataRange.r1 > dataRange.r2) { toast(t('sortdialog.nothingBelowHeader'), { icon: 'info' }); return; }
      // No colour can be picked when the column has none: name the column and the two ways out,
      // rather than asking for a colour from a select that is empty and disabled.
      const colorless = keys.findIndex((k) => k.color === '');
      if (colorless >= 0) {
        toast(t('sortdialog.noFillColors', { column: colName(keys[colorless].line) }), { icon: 'info' });
        levels.children[colorless]?.focusLine();
        return;
      }
      // Merged cells, an array result, or protected cells refuse the sort; say which, rather than reporting a sort that did not happen.
      const problem = rearrangeProblem(ctx.wb, sheetId, dataRange, 'row');
      if (problem) { toast(problem, { icon: 'info' }); return; }
      sorted = ctx.wb.sortRangeBy(sheetId, dataRange, keys.map((k) => (k.color ? { col: k.line, ascending: k.ascending, color: k.color }
        : { col: k.line, ascending: k.ascending, ...(k.list ? { list: k.list } : {}) })), opts);
    } else {
      dataRange = headerInput.checked ? { ...range, c1: range.c1 + 1 } : range;
      if (dataRange.c1 > dataRange.c2) { toast(t('sortdialog.nothingRightOfHeader'), { icon: 'info' }); return; }
      const problem = rearrangeProblem(ctx.wb, sheetId, dataRange, 'col');
      if (problem) { toast(problem, { icon: 'info' }); return; }
      sorted = ctx.wb.sortColumnsBy(sheetId, dataRange, keys.map((k) => ({ row: k.line, ascending: k.ascending, ...(k.list ? { list: k.list } : {}) })), opts);
    }
    if (!sorted) { toast(t('sortdialog.cantSort', { range: rangeName(dataRange) }), { icon: 'info' }); return; }
    modal.close();
    toast(t('sortdialog.sorted', { range: rangeName(dataRange) }));
    ctx.grid.focus();
  };

  const content = el('form.sort-form', { onsubmit: submit },
    el('p.modal-text', {}, t('sortdialog.intro', { range: rangeName(range) })),
    el('div.sort-options', {},
      el('label.field', {}, el('span.field-label', {}, t('sortdialog.directionField')), el('div.select-wrap', {}, orientSelect)),
      el('div.sort-flags', {},
        el('label.find-option', { for: headerId }, headerInput, headerText),
        el('label.find-option', { for: caseId }, caseInput, el('span', {}, t('sortdialog.caseSensitive'))))),
    el('div.sort-level-toolbar', { role: 'group', 'aria-label': t('sortdialog.levelActions') }, addBtn, copyBtn, upBtn, downBtn, status),
    el('div.sort-level-scroll', {},
      el('div.sort-level-head', { 'aria-hidden': 'true' }, el('span'), el('span', { className: 'sort-head-line' }, t('sortdialog.column')), el('span', {}, t('sortdialog.sortOn')), el('span', {}, t('sortdialog.orderLabel')), el('span', {}, t('sortdialog.fillColor')), el('span')),
      levels),
    el('div.row.row-end', { style: { marginTop: '16px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('sortdialog.sort'))));
  orientSelect.addEventListener('change', () => { content.querySelector('.sort-head-line').textContent = byRows() ? t('sortdialog.column') : t('sortdialog.row'); });
  const modal = openModal({ title: t('sortdialog.title'), content, wide: true, className: 'sort-dialog', onClose: () => ctx.grid?.focus?.() });
  addLevel(Math.max(range.c1, Math.min(range.c2, ctx.active().c)));
  return modal;
}
