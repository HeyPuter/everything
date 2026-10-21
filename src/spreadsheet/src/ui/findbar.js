/**
 * Find and replace panel, docked over the top-right of the grid. Non-modal:
 * the grid stays live behind it, matches are highlighted as the query
 * changes, Enter steps forward, Shift+Enter back, Escape closes.
 */

import { isComposing, el, fieldId } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { compilePattern, findAll, findAllSheets, nextIndex, patternSubjectLimit, replaceCells, searchBudget } from '../core/search.js';
import { nestedRepeat } from '../core/formula/regex-safety.js';
import { cellName, rangeName } from '../core/cell.js';
import * as S from '../core/selection.js';
import { createFindResults } from './findresults.js';

export function createFindBar(ctx) {
  let open = false;
  let matches = [];
  let current = -1;
  let replaceMode = false;
  let resultsVisible = false;
  const opts = { matchCase: false, wholeCell: false, formulas: true, allSheets: false, regex: false, selection: false };
  let homeSheet = null; // the sheet the search started on, so the order stays put while stepping
  let scope = null; // { sheetId, range } captured when "Selection only" is on

  const statusId = fieldId('find-status');
  const optionsId = fieldId('find-options');
  const resultsId = fieldId('find-results');
  const query = el('input.input.find-input', { type: 'search', placeholder: 'Find in sheet', 'aria-label': 'Find', 'aria-describedby': statusId, autocomplete: 'off', spellcheck: false });
  const replacement = el('input.input.find-input', { type: 'text', placeholder: 'Replace with', 'aria-label': 'Replace with', autocomplete: 'off', spellcheck: false });
  const count = el('div.find-count', { id: statusId, hidden: true, 'aria-live': 'polite', 'aria-atomic': 'true' }, '');
  const prevBtn = el('button.icon-btn', { type: 'button', html: icon('chevU', 18), 'aria-label': 'Previous match', title: 'Previous (Shift+Enter)', onclick: () => step(-1) });
  const nextBtn = el('button.icon-btn', { type: 'button', html: icon('chevD', 18), 'aria-label': 'Next match', title: 'Next (Enter)', onclick: () => step(1) });
  const closeBtn = el('button.icon-btn', { type: 'button', html: icon('x', 18), 'aria-label': 'Close find', title: 'Close (Esc)', onclick: () => close() });
  const toggleReplace = el('button.icon-btn', { type: 'button', html: icon('chevR', 18), 'aria-label': 'Show replace', 'aria-expanded': 'false', title: 'Replace', onclick: () => setReplaceMode(!replaceMode) });

  const inputs = {};
  const option = (key, label) => {
    const id = fieldId('find');
    const input = el('input', { type: 'checkbox', id, checked: opts[key], onchange: () => {
      opts[key] = input.checked;
      // "All sheets" and "Selection only" say opposite things about where to look. Both could be ticked, and
      // the narrower one won without a word — "All sheets" lit while two of four matches were found. Ticking
      // one clears the other, as the single "Search:" chooser in Sheets allows only one at a time.
      if (input.checked && (key === 'allSheets' || key === 'selection')) {
        const other = key === 'allSheets' ? 'selection' : 'allSheets';
        opts[other] = false;
        inputs[other].input.checked = false;
      }
      if (key === 'selection' || key === 'allSheets') captureScope();
      search({ keepIndex: true });
    } });
    inputs[key] = { input, text: el('span', {}, label) };
    return el('label.find-option', { for: id }, input, inputs[key].text);
  };
  /** Remember the selected range while "Selection only" is on; a single cell means the whole sheet. */
  function captureScope() {
    const range = ctx.grid.range;
    const single = range.r1 === range.r2 && range.c1 === range.c2;
    scope = opts.selection && !single ? { sheetId: ctx.sheetId(), range: { ...range } } : null;
    if (opts.selection && single) { opts.selection = false; inputs.selection.input.checked = false; }
    inputs.selection.text.textContent = scope ? `Selection only (${rangeName(scope.range)})` : 'Selection only';
  }
  /**
   * Rows or columns were inserted, deleted or moved on the sheet the scope was taken from, so the same
   * A1:A3 now covers different cells: a blank inserted row fell inside the scope and a cell the user had
   * highlighted fell outside it, and Replace all acted on that without a word. The scope is read from the
   * selection again, and lets go — turning "Selection only" off in plain sight — when there is no range on
   * that sheet to hold on to.
   */
  function rescope() {
    if (!scope) return;
    const range = ctx.grid.range;
    const single = range.r1 === range.r2 && range.c1 === range.c2;
    const held = rangeName(scope.range);
    if (ctx.sheetId() === scope.sheetId && !single) scope = { sheetId: scope.sheetId, range: { ...range } };
    else { scope = null; opts.selection = false; inputs.selection.input.checked = false; }
    inputs.selection.text.textContent = scope ? `Selection only (${rangeName(scope.range)})` : 'Selection only';
    if (!scope) {
      toast('Find is searching the whole sheet: the rows moved under the range “Selection only” held', { icon: 'info', duration: 4000 });
      ctx.announce('Selection only turned off');
    } else if (rangeName(scope.range) !== held) ctx.announce(`Selection only, ${rangeName(scope.range)}`);
    search({ keepIndex: true });
  }

  /** Search options as the core takes them: a scope range when one is set. */
  const searchOpts = () => ({ ...opts, range: scope?.range || null });

  const replaceBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => replaceOne() }, 'Replace');
  const replaceAllBtn = el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => replaceAll() }, 'Replace all');
  const replaceRow = el('div.find-row.find-replace', { hidden: true }, replacement, replaceBtn, replaceAllBtn);
  const optionsRow = el('div.find-row.find-options', { id: optionsId, hidden: true }, option('matchCase', 'Match case'), option('wholeCell', 'Entire cell'), option('formulas', 'Search formulas'), option('allSheets', 'All sheets'), option('regex', 'Regular expression'), option('selection', 'Selection only'));
  const optionsLabel = el('span', {}, 'Options');
  const optionsButton = el('button.find-options-toggle', {
    type: 'button', 'aria-label': 'Search options', 'aria-expanded': 'false', 'aria-controls': optionsId,
    onclick: () => {
      optionsRow.hidden = !optionsRow.hidden;
      optionsButton.setAttribute('aria-expanded', String(!optionsRow.hidden));
      revealMatch();
    },
  }, optionsLabel, el('span.find-options-chevron', { html: icon('chevD', 14), 'aria-hidden': 'true' }));
  const results = createFindResults({ wb: ctx.wb, onSelect: chooseResult, focusQuery: () => query.focus() });
  results.el.id = resultsId;
  const findAllButton = el('button.find-all-toggle', { type: 'button', 'aria-controls': resultsId, 'aria-expanded': 'false', onclick: () => {
    resultsVisible = !resultsVisible;
    results.el.hidden = !resultsVisible;
    root.classList.toggle('find-expanded', resultsVisible);
    if (resultsVisible) { search({ keepIndex: true }); revealMatch(); }
    else refreshStatus();
  } }, 'Find all');

  const root = el('div.find-panel', { role: 'search', 'aria-label': 'Find and replace', hidden: true },
    el('div.find-row.find-query', {}, toggleReplace, query, prevBtn, nextBtn, closeBtn),
    replaceRow,
    el('div.find-summary', {}, count, findAllButton, optionsButton),
    optionsRow, results.el);

  /** Why the query cannot be searched as a regular expression, or null when it can (or is plain text). */
  function patternProblem() {
    if (!opts.regex || !query.value) return null;
    if (compilePattern(query.value, { matchCase: opts.matchCase, wholeCell: opts.wholeCell })) return null;
    return nestedRepeat(query.value) ? 'This pattern could run for ever' : 'Invalid regular expression';
  }

  /** Keep explanations out of the input's row, and make unavailable actions clear without
   * blocking an immediate Enter or click while the latest query is waiting to be searched. */
  function refreshStatus() {
    const problem = patternProblem();
    if (problem) query.setAttribute('aria-invalid', 'true');
    else query.removeAttribute('aria-invalid');
    const pending = debounce !== null;
    const unavailable = !query.value || !!problem || (!pending && !matches.length);
    const actionFocused = [prevBtn, nextBtn, replaceBtn, replaceAllBtn].includes(document.activeElement);
    prevBtn.disabled = nextBtn.disabled = replaceBtn.disabled = replaceAllBtn.disabled = unavailable;
    if (unavailable && actionFocused) query.focus();
    count.textContent = !query.value ? '' : problem || (pending ? 'Searching…' : countText(current));
    count.hidden = !count.textContent;
    count.classList.toggle('none', !!problem || (!!query.value && !pending && !matches.length));
    const activeOptions = Object.keys(opts).filter(key => key === 'formulas' ? !opts[key] : opts[key]);
    optionsLabel.textContent = activeOptions.length ? `Options · ${activeOptions.length}` : 'Options';
    const description = activeOptions.length
      ? `Active options: ${activeOptions.map(key => key === 'formulas' ? 'Cell values only' : inputs[key].text.textContent).join(', ')}`
      : 'Default search options';
    optionsButton.title = description;
    optionsButton.setAttribute('aria-description', description);
    optionsButton.classList.toggle('active', !!activeOptions.length);
    findAllButton.disabled = !resultsVisible && (!query.value || !!problem);
    findAllButton.textContent = resultsVisible ? 'Hide results' : 'Find all';
    findAllButton.setAttribute('aria-expanded', String(resultsVisible));
    if (resultsVisible) results.render(matches, current, !query.value ? 'Enter a search term' : problem || (pending ? 'Searching…' : ''));
  }

  let stopped = false; // the last search ran out of time, so the matches are only those found by then

  let last = null; // the last search that ran to the end: what it was for, the workbook's version then, what it found

  /**
   * Matches for the current query: one sheet, or every sheet tagged with its id. `since`, a workbook version the
   * last search was run at or after, asks for what changed from then on: when that is cells written and nothing
   * else, only what a write can change is looked at again (see findAll), not every cell of a large sheet on each
   * Enter while the panel is open.
   */
  function collect(since = null) {
    const q = query.value;
    stopped = false;
    const previous = last;
    last = null;
    if (!q || patternProblem()) return [];
    // A regular expression is the user's own, and one that backtracks badly could hold the page for as
    // long as it likes on every keystroke: such a search gets a second, and shows what it found by then.
    // A plain-text search is bounded but not cheap — a large book takes seconds of it on every pause in
    // typing, with nothing on screen meanwhile — so it gets a budget too, a longer one.
    const budget = searchBudget(opts.regex ? 1000 : 3000);
    const searched = JSON.stringify([q, searchOpts(), scope?.sheetId ?? null, opts.allSheets ? homeSheet : ctx.sheetId()]);
    const changes = since != null && previous?.searched === searched && previous.version >= since ? ctx.wb.changesSince(since) : null;
    const written = changes?.every((ch) => ch.type === 'cells' && ch.box && ch.sheetId != null)
      ? { previous: previous.found, boxes: changes.map((ch) => ({ sheetId: ch.sheetId, ...ch.box })) } : null;
    const o = { ...searchOpts(), budget, ...(written ? { written } : {}) };
    let found = null;
    if (scope) {
      // A scope is one range on one sheet, whatever the other sheets hold.
      if (!ctx.wb.sheet(scope.sheetId)) { scope = null; opts.selection = false; inputs.selection.input.checked = false; captureScope(); }
      else found = findAll(ctx.wb, scope.sheetId, q, o).map((m) => ({ ...m, sheetId: scope.sheetId }));
    }
    if (!found && !opts.allSheets) found = findAll(ctx.wb, ctx.sheetId(), q, o).map((m) => ({ ...m, sheetId: ctx.sheetId() }));
    if (!found) {
      if (!homeSheet || !ctx.wb.sheet(homeSheet)) homeSheet = ctx.sheetId();
      found = findAllSheets(ctx.wb, q, o, homeSheet);
    }
    stopped = !!budget?.exceeded;
    if (!stopped) last = { searched, version: ctx.wb.version, found };
    return found;
  }

  /** Highlight only the matches on the sheet in view. */
  function paint(i) {
    const here = ctx.sheetId();
    const local = matches.filter((m) => m.sheetId === here);
    const cur = i >= 0 && matches[i]?.sheetId === here ? local.indexOf(matches[i]) : -1;
    ctx.grid.setHighlights(local, cur);
  }

  const STOPPED = 'search stopped: the pattern is slow';
  const STOPPED_PLAIN = 'search stopped: too much to search';
  /** The notes a search carries: it ran out of time, or its pattern skips the longest cells. */
  function notes() {
    const out = [];
    if (stopped) out.push(opts.regex ? STOPPED : STOPPED_PLAIN);
    const limit = opts.regex && query.value && !patternProblem() ? patternSubjectLimit(query.value, { wholeCell: opts.wholeCell }) : Infinity;
    if (limit !== Infinity) out.push(`cells over ${limit.toLocaleString()} characters skipped`);
    return out.length ? ` (${out.join('; ')})` : '';
  }
  function countText(i) {
    if (!matches.length) return patternProblem() || (query.value ? `No matches${notes()}` : '');
    const sheets = new Set(matches.map((m) => m.sheetId)).size;
    return `${i + 1} of ${matches.length}${opts.allSheets && sheets > 1 ? ` on ${sheets} sheets` : ''}${notes()}`;
  }

  function setReplaceMode(on) {
    replaceMode = on;
    replaceRow.hidden = !on;
    toggleReplace.setAttribute('aria-expanded', String(on));
    toggleReplace.setAttribute('aria-label', on ? 'Hide replace' : 'Show replace');
    toggleReplace.innerHTML = icon(on ? 'chevD' : 'chevR', 18);
    if (on) replacement.focus();
    revealMatch();
  }

  /** Leave the search controls in place whenever scrolling can uncover the result.
   * A first-row result on a narrow screen (or a frozen cell) may need the panel below it. */
  function revealMatch() {
    if (!open || !root.isConnected || !ctx.grid.scrollToActive) return;
    const m = matches[current], active = ctx.grid.active;
    if (!m || m.sheetId !== ctx.sheetId() || m.r !== active.r || m.c !== active.c) return;
    if (!root.getBoundingClientRect().height) return;
    if (ctx.grid.scrollToActive({ avoid: root.getBoundingClientRect() })) return;
    root.classList.toggle('find-bottom');
    if (!ctx.grid.scrollToActive({ avoid: root.getBoundingClientRect() })) root.classList.toggle('find-bottom');
  }

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(revealMatch) : null;
  resizeObserver?.observe(root);
  if (ctx.grid.viewport) resizeObserver?.observe(ctx.grid.viewport);

  function search({ keepIndex = false } = {}) {
    if (!open) return;
    clearTimeout(debounce);
    debounce = null;
    if (!keepIndex) homeSheet = ctx.sheetId();
    matches = collect();
    if (!matches.length) {
      current = -1;
      refreshStatus();
      ctx.grid.setHighlights([], -1);
      return;
    }
    if (!keepIndex || current < 0 || current >= matches.length) {
      // Start from the match at or after the active cell on this sheet.
      const a = ctx.grid.active;
      const here = ctx.sheetId();
      const idx = matches.findIndex((m) => m.sheetId === here && (m.r > a.r || (m.r === a.r && m.c >= a.c)));
      current = idx < 0 ? Math.max(0, matches.findIndex((m) => m.sheetId === here)) : idx;
    }
    show(current, { scroll: !keepIndex });
  }

  function show(i, { scroll = true } = {}) {
    current = i;
    const m = matches[i];
    refreshStatus();
    if (m && m.sheetId !== ctx.sheetId()) ctx.wb.setActiveSheet(m.sheetId);
    paint(i);
    if (m) ctx.grid.setSelection(S.single(m.r, m.c), { scroll, announce: false });
    if (m && scroll) revealMatch();
    if (m) {
      const sheetName = ctx.wb.sheet(m.sheetId)?.name;
      ctx.announce(`Match ${i + 1} of ${matches.length}, ${opts.allSheets && sheetName ? `${sheetName} ` : ''}${cellName(m.r, m.c)}`);
    }
  }

  function step(direction) {
    // Enter or a navigation button can arrive before the typing delay ends.
    if (debounce !== null) { search(); return; }
    if (!matches.length) { search(); return; }
    if (opts.allSheets) {
      // Matches are already in sheet-then-reading order: walk the list.
      const here = ctx.sheetId();
      const a = ctx.grid.active;
      const at = matches.findIndex((m) => m.sheetId === here && m.r === a.r && m.c === a.c);
      const base = at >= 0 ? at : current;
      show(((base + direction) % matches.length + matches.length) % matches.length);
      return;
    }
    const from = ctx.grid.active;
    const i = nextIndex(matches, from, direction);
    show(i);
  }

  function chooseResult(index) {
    const target = matches[index];
    if (!target) return;
    if (debounce !== null) { search(); return; }
    // A workbook edit can arrive before the editor subscription refreshes the displayed rows.
    // Revalidate that this cell still matches, instead of selecting a stale result on another sheet.
    if (ctx.wb.version !== lastVersion || ctx.sheetId() !== lastSheet) refreshMatches();
    const fresh = matches.findIndex(m => m.sheetId === target.sheetId && m.r === target.r && m.c === target.c);
    const sheet = ctx.wb.sheet(target.sheetId);
    if (fresh < 0 || !sheet || sheet.hidden) return;
    show(fresh);
  }

  /**
   * Why a match was left alone, in the words Replace uses: `one` follows the cell's name, `count`
   * is the noun counted in a summary (singular, plural), `all` follows "the matches are".
   */
  const LEFT_ALONE = {
    protected: { one: 'is protected', count: ['protected cell', 'protected cells'], all: 'protected', icon: 'lock' },
    formula: { one: 'is a formula result', count: ['formula result', 'formula results'], all: 'formula results', icon: 'info' },
    spill: { one: 'is a value spilled by an array formula', count: ['spilled value', 'spilled values'], all: 'values spilled by array formulas', icon: 'info' },
    display: { one: 'matches only in its number format', count: ['number-format match', 'number-format matches'], all: 'in how the numbers are formatted, not in their values', icon: 'info' },
  };
  const plural = (k, [one, many]) => `${k} ${k === 1 ? one : many}`;

  function replaceOne() {
    if (debounce !== null) search();
    if (!matches.length || current < 0) { search(); if (!matches.length) return; }
    const target = matches[current];
    const keep = current;
    const skipped = [];
    const n = replaceCells(ctx.wb, target.sheetId, [target], query.value, replacement.value, { ...opts, skipped });
    if (!n) {
      const why = LEFT_ALONE[skipped[0]?.reason];
      if (why) toast(`${cellName(target.r, target.c)} ${why.one} and was left alone`, { icon: why.icon });
      step(1);
      return;
    }
    // Replacement text can still match ("cat" → "cats"). Advance past it
    // instead of repeatedly changing the same cell, and wrap at the end.
    matches = collect();
    if (!matches.length) { search(); return; }
    const retained = matches.findIndex((m) => m.sheetId === target.sheetId && m.r === target.r && m.c === target.c);
    show((retained >= 0 ? retained + 1 : keep) % matches.length);
  }

  function replaceAll() {
    if (!query.value || patternProblem()) return;
    const all = collect();
    let n = 0;
    const skipped = [];
    ctx.wb.transaction('Replace all', () => {
      for (const sheet of ctx.wb.sheets) {
        const mine = all.filter((m) => m.sheetId === sheet.id);
        if (mine.length) n += replaceCells(ctx.wb, sheet.id, mine, query.value, replacement.value, { ...opts, skipped });
      }
    });
    // Matches that were left alone stay in the list and would otherwise look like a failure, so they are
    // counted by kind; every match being protected or a formula result is not the same as nothing to replace.
    const counts = new Map();
    for (const { reason } of skipped) counts.set(reason, (counts.get(reason) || 0) + 1);
    const alone = [...counts].map(([reason, k]) => plural(k, LEFT_ALONE[reason].count)).join(', ');
    const only = counts.size === 1 && skipped.length === all.length ? LEFT_ALONE[skipped[0].reason] : null;
    let text = 'Nothing to replace';
    let icon = 'info';
    if (n) { text = `Replaced ${plural(n, ['cell', 'cells'])}${alone ? `; ${alone} left alone` : ''}`; icon = 'check'; }
    else if (only) { text = `Nothing replaced: the matches are ${only.all}`; icon = only.icon; }
    else if (alone) text = `Nothing to replace; ${alone} left alone`;
    // A search cut short by its time budget replaced what it found, which may not be every match.
    if (stopped) text += '; the search stopped early, so more may remain';
    toast(text, { icon });
    search();
  }

  function openPanel({ replace = false } = {}) {
    if (ctx.grid.editing) ctx.grid.commitEdit();
    open = true;
    root.hidden = false;
    setReplaceMode(replace);
    // Opening with a range selected searches just that range, as Sheets does; the box can turn it off. An
    // "All sheets" already chosen stays chosen: the two contradict each other, so the scope does not join it.
    const range = ctx.grid.range;
    const single = range.r1 === range.r2 && range.c1 === range.c2;
    opts.selection = !single && !opts.allSheets;
    inputs.selection.input.checked = opts.selection;
    captureScope();
    // Seed the query with the active cell's text when it is short.
    const cell = ctx.activeCell();
    if (!query.value && cell && cell.f == null && typeof cell.v === 'string' && cell.v.length < 40) query.value = cell.v;
    query.focus();
    query.select();
    if (query.value) search();
    else refreshStatus();
  }

  function close() {
    if (!open) return;
    clearTimeout(debounce);
    debounce = null;
    open = false;
    root.hidden = true;
    root.classList.remove('find-bottom');
    root.classList.remove('find-expanded');
    resultsVisible = false;
    results.el.hidden = true;
    results.clear();
    matches = [];
    current = -1;
    ctx.grid.setHighlights([], -1);
    ctx.grid.focus();
  }

  let debounce = null;
  query.addEventListener('input', () => {
    clearTimeout(debounce);
    if (!query.value) { search(); return; }
    debounce = setTimeout(() => search(), 120);
    refreshStatus();
  });
  root.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter' && (e.target === query || e.target === replacement)) {
      e.preventDefault();
      if (e.target === replacement) replaceOne();
      else step(e.shiftKey ? -1 : 1);
    }
  });

  /** The list on screen is out of date: collect it again, keeping the place in it where that still exists. */
  function refreshMatches(since = null) {
    const before = matches.length;
    matches = collect(since);
    if (matches.length !== before || current >= matches.length) current = Math.min(Math.max(current, 0), matches.length - 1);
    refreshStatus();
    paint(current);
  }

  // Keep matches fresh while the sheet changes underneath the panel.
  const unsubscribe = ctx.subscribe(() => {
    if (!open || !query.value) return;
    if (ctx.wb.version !== lastVersion || ctx.sheetId() !== lastSheet) {
      const since = ctx.sheetId() === lastSheet ? lastVersion : null;
      lastVersion = ctx.wb.version;
      lastSheet = ctx.sheetId();
      refreshMatches(since);
    }
  });
  let lastVersion = ctx.wb.version;
  let lastSheet = ctx.sheetId();

  const onWorkbookChange = (e) => {
    if (!open) return;
    // Recalculate all formulas (F9), a change of regional format and an answer arriving for an AI formula
    // change what the cells show without touching a cell, so the workbook's version — all the panel watches
    // — stays put and the matches on screen went on describing the values from before. The engine says so
    // with a 'recalc' notice; where it does not yet, nothing here fires and nothing else changes.
    if (e.detail?.type === 'recalc') { if (query.value) refreshMatches(); return; }
    // A structural edit moves the cells the scope was taken from; it is read again before the next search.
    if (!scope || e.detail?.type !== 'structure') return;
    if (e.detail.sheetId && e.detail.sheetId !== scope.sheetId) return;
    rescope();
    lastVersion = ctx.wb.version;
  };
  ctx.wb.addEventListener('change', onWorkbookChange);

  function destroy() {
    open = false;
    clearTimeout(debounce);
    resizeObserver?.disconnect();
    ctx.wb.removeEventListener('change', onWorkbookChange);
    unsubscribe();
  }

  refreshStatus();
  /** Shift+F4: the next match of the last search, or the bar itself when nothing has been searched for. */
  function findNext() {
    if (!query.value) { openPanel({}); return; }
    if (open) { step(1); return; }
    // With the panel closed, as Shift+F4 is used in Excel once its Find box is gone, the last search runs again
    // from the active cell and the next match is selected, with nothing highlighted that only the panel's closing
    // would clear (the search ran only while the panel was up, so the key did nothing). The range "Selection
    // only" held was not followed while the panel was closed, so the sheet is searched.
    const sheetId = ctx.sheetId();
    scope = null;
    homeSheet = sheetId; // every sheet in order from this one
    const found = patternProblem() ? [] : collect();
    if (!found.length) { toast(`No matches for “${query.value}”`, { icon: 'info' }); return; }
    const a = ctx.grid.active;
    const after = found.findIndex((m) => m.sheetId !== sheetId || m.r > a.r || (m.r === a.r && m.c > a.c));
    const i = after < 0 ? 0 : after;
    const m = found[i];
    if (m.sheetId !== sheetId) ctx.wb.setActiveSheet(m.sheetId);
    ctx.grid.setSelection(S.single(m.r, m.c), { scroll: true, announce: false });
    const sheetName = ctx.wb.sheet(m.sheetId)?.name;
    ctx.announce(`Match ${i + 1} of ${found.length}, ${opts.allSheets && sheetName ? `${sheetName} ` : ''}${cellName(m.r, m.c)}`);
  }
  return { el: root, open: openPanel, close, findNext, get isOpen() { return open; }, destroy };
}
