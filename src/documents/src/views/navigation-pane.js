import { el, isComposing } from '../ui/dom.js';
import { iconEl } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';

const THUMB_WIDTH = 132;

/**
 * The Navigation pane: search the document, then browse by Headings (a collapsible outline that
 * tracks the current heading), Pages (thumbnails) or Results (each match in its context).
 *
 * api: navigate(paragraphId), goToPage(index), pages() → canvases, search(text) → matches,
 *      text() → document text, selectMatch(match), highlight(matches), close(), focusEditor(),
 *      headingActions() → optional { canEdit(), move(id, targetId, 'before' | 'after'), promote(id), demote(id),
 *      remove(id), insert(id, 'before' | 'after' | 'sub'), select(id) }: headings can then be dragged to
 *      reorder their sections, and their context menu promotes, demotes, adds and deletes them.
 */
export function createNavigationPane(api) {
  let tab = 'headings', entries = [], position = 0, signature = '', matches = [], collapsed = new Set();
  const search = el('input.input.nav-search', { type: 'search', 'aria-label': 'Search document', placeholder: 'Search document', autocomplete: 'off', spellcheck: false });
  const status = el('p.nav-status', { role: 'status', 'aria-live': 'polite' });
  const tabs = [['headings', 'Headings'], ['pages', 'Pages'], ['results', 'Results']];
  const tabButtons = tabs.map(([id, label], i) => el('button.nav-tab', { type: 'button', role: 'tab', id: `nav-tab-${id}`, 'aria-controls': `nav-panel-${id}`, 'aria-selected': String(!i), tabindex: i ? -1 : 0,
    onclick: () => select(id),
    onkeydown: e => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault(); const next = tabs[(i + step + tabs.length) % tabs.length][0]; select(next); tabButtons.find(b => b.id === `nav-tab-${next}`).focus();
    } }, label));
  const headingList = el('ol.nav-headings', { role: 'tree', 'aria-label': 'Headings' });
  const headingEmpty = el('p.field-hint', {}, 'Create an interactive outline of your document. It is a great way to keep track of where you are or quickly move your content around. To get started, apply heading styles to the headings in your document.');
  const pageGrid = el('div.nav-pages', { role: 'list', 'aria-label': 'Pages' });
  const resultList = el('ol.nav-results', { 'aria-label': 'Search results' });
  const resultEmpty = el('p.field-hint');
  const panels = {
    headings: el('div.nav-panel', { role: 'tabpanel', id: 'nav-panel-headings', 'aria-labelledby': 'nav-tab-headings' }, headingEmpty, headingList),
    pages: el('div.nav-panel', { role: 'tabpanel', id: 'nav-panel-pages', 'aria-labelledby': 'nav-tab-pages', hidden: true }, pageGrid),
    results: el('div.nav-panel', { role: 'tabpanel', id: 'nav-panel-results', 'aria-labelledby': 'nav-tab-results', hidden: true }, resultEmpty, resultList),
  };
  const node = el('aside.canvas-outline-panel.nav-pane', { 'aria-label': 'Navigation', hidden: true },
    el('div.canvas-panel-heading', {}, el('h2', {}, 'Navigation'),
      el('button.icon-btn', { type: 'button', 'aria-label': 'Close Navigation pane', onclick: () => api.close() }, iconEl('x', 18))),
    el('div.nav-search-row', {}, search), status,
    el('div.nav-tabs', { role: 'tablist', 'aria-label': 'Browse by' }, ...tabButtons),
    el('div.canvas-panel-scroll.nav-scroll', {}, ...Object.values(panels)));
  node.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || isComposing(e)) return;
    e.preventDefault();
    // With a search, Escape clears it and goes back to the document (at the result chosen), as the find bar's does,
    // leaving the pane open; without one it closes the pane.
    if (search.value) { search.value = ''; runSearch(); api.focusEditor(); return; }
    api.close(); api.focusEditor();
  });

  function select(id) {
    tab = id;
    for (const button of tabButtons) { const on = button.id === `nav-tab-${id}`; button.setAttribute('aria-selected', String(on)); button.tabIndex = on ? 0 : -1; }
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== id;
    render();
  }

  /* ---- Search: highlights every match in the document and lists them under Results ---- */
  let current = -1;
  function runSearch() {
    const text = search.value;
    matches = text ? api.search(text) : [];
    current = -1;
    api.highlight(matches);
    status.textContent = !text ? '' : matches.length ? `${matches.length} result${matches.length === 1 ? '' : 's'}` : 'No matches';
    if (text && tab === 'headings' && matches.length) select('results'); else render();
  }
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || isComposing(e) || !matches.length) return;
    e.preventDefault();
    // From a fresh search, Shift+Enter goes to the last result (it went to the one before the last).
    current = current < 0 ? (e.shiftKey ? matches.length - 1 : 0) : (current + (e.shiftKey ? -1 : 1) + matches.length) % matches.length;
    api.selectMatch(matches[current]);
    status.textContent = `Result ${current + 1} of ${matches.length}`;
    renderResults();
  });

  /** The heading button for a paragraph, found by its id (no selector to escape, which not every environment offers). */
  const headingButton = id => [...headingList.querySelectorAll('.nav-heading')].find(button => button.dataset.paragraph === id) || null;

  /* ---- Rendering ---- */
  function renderHeadings() {
    const next = JSON.stringify([entries, [...collapsed]]);
    headingEmpty.hidden = entries.length > 0;
    if (next !== signature) {
      signature = next;
      const focused = node.contains(document.activeElement) ? document.activeElement.dataset.paragraph : null;
      const rows = [];
      let hiddenBelow = Infinity;
      entries.forEach((entry, i) => {
        if (entry.level > hiddenBelow) return;
        hiddenBelow = Infinity;
        const parent = entries[i + 1] && entries[i + 1].level > entry.level;
        const closed = collapsed.has(entry.id);
        if (parent && closed) hiddenBelow = entry.level;
        const toggle = parent ? el('button.nav-twisty', { type: 'button', tabindex: -1, 'aria-label': closed ? `Expand ${entry.text}` : `Collapse ${entry.text}`,
          onclick: e => { e.stopPropagation(); closed ? collapsed.delete(entry.id) : collapsed.add(entry.id); renderHeadings(); } }, el('span.nav-caret', { 'aria-hidden': 'true', dataset: { closed: String(closed) } })) : el('span.nav-twisty-space');
        const heading = el('button.canvas-outline-entry.nav-heading', { type: 'button', role: 'treeitem', 'aria-level': entry.level, ...(parent ? { 'aria-expanded': String(!closed) } : {}),
          dataset: { paragraph: entry.id }, 'aria-label': `Level ${entry.level}: ${entry.text}, page ${entry.page}`, onclick: () => api.navigate(entry.id),
          oncontextmenu: e => { e.preventDefault(); headingMenu(entry, heading, e); },
          onkeydown: e => {
            if (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') { e.preventDefault(); headingMenu(entry, heading, null); }
            else if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); moveInTree(entry, e.key); }
            else if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && editable() && !entry.inTable) {
              // Move the section past its neighbour, as dragging would.
              e.preventDefault();
              const at = entries.indexOf(entry), step = e.key === 'ArrowUp' ? -1 : 1;
              let target = at + step;
              while (entries[target] && (entries[target].level > entry.level || entries[target].inTable)) target += step;
              if (entries[target]) { actions().move(entry.id, entries[target].id, step < 0 ? 'before' : 'after'); refocus(entry.id); }
            }
          } }, el('span', {}, entry.text));
        const row = el('div.nav-heading-row', { style: { paddingInlineStart: `${4 + (entry.level - 1) * 14}px` } }, toggle, heading);
        if (editable() && !entry.inTable) dragHeading(row, heading, entry);
        rows.push(el('li', { role: 'none' }, row));
      });
      headingList.replaceChildren(...rows);
      if (focused) headingButton(focused)?.focus();
    }
    const here = entries.filter(entry => entry.start <= position).at(-1)?.id;
    for (const button of headingList.querySelectorAll('.nav-heading')) {
      if (here === button.dataset.paragraph) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
    }
  }
  /**
   * The tree's keys: Up and Down (Home, End) move between the headings shown; Right expands a collapsed
   * heading or goes to its first subheading, Left collapses an expanded one or goes to its parent.
   */
  function moveInTree(entry, key) {
    const shown = [...headingList.querySelectorAll('.nav-heading')], at = shown.findIndex(b => b.dataset.paragraph === entry.id);
    const focus = button => button?.focus();
    const index = entries.indexOf(entry), parent = entries[index + 1]?.level > entry.level;
    if (key === 'ArrowDown') focus(shown[at + 1]);
    else if (key === 'ArrowUp') focus(shown[at - 1]);
    else if (key === 'Home') focus(shown[0]);
    else if (key === 'End') focus(shown.at(-1));
    else if (key === 'ArrowRight' && parent) {
      if (collapsed.has(entry.id)) { collapsed.delete(entry.id); renderHeadings(); } else focus(shown[at + 1]);
    } else if (key === 'ArrowLeft') {
      if (parent && !collapsed.has(entry.id)) { collapsed.add(entry.id); renderHeadings(); return; }
      const up = entries.slice(0, index).findLast(e => e.level < entry.level);
      if (up) focus(headingButton(up.id));
    }
  }
  /* ---- Rearranging headings: drag a heading to move its section; its menu changes levels ---- */
  const actions = () => api.headingActions?.() || null;
  const editable = () => !!actions()?.canEdit?.();
  const refocus = id => requestAnimationFrame(() => headingButton(id)?.focus());
  let dragging = null;
  function dragHeading(row, heading, entry) {
    heading.draggable = true;
    heading.addEventListener('dragstart', e => { dragging = entry; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', entry.text); row.classList.add('is-dragging'); });
    heading.addEventListener('dragend', () => { dragging = null; row.classList.remove('is-dragging'); clearDrop(); });
    row.addEventListener('dragover', e => {
      if (!dragging || dragging.id === entry.id) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const box = row.getBoundingClientRect(), after = e.clientY > box.top + box.height / 2;
      clearDrop(); row.classList.add(after ? 'drop-after' : 'drop-before');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', e => {
      if (!dragging || dragging.id === entry.id) return;
      e.preventDefault();
      const placement = row.classList.contains('drop-after') ? 'after' : 'before', moved = dragging.id;
      clearDrop(); dragging = null;
      actions().move(moved, entry.id, placement);
      refocus(moved);
    });
  }
  const clearDrop = () => { for (const row of headingList.querySelectorAll('.drop-before, .drop-after')) row.classList.remove('drop-before', 'drop-after'); };
  function headingMenu(entry, anchor, event) {
    // A heading in a table stays with its table: the commands that move, add or delete sections are off, and say why.
    const act = actions(), can = editable() && !entry.inTable;
    const run = fn => () => { fn(); refocus(entry.id); };
    openMenu({ anchor, x: event?.clientX ?? null, y: event?.clientY ?? null, label: `${entry.text} heading`, pointer: !!event, items: [
      ...(entry.inTable ? [{ note: 'This heading is in a table. Move or delete it with its table, in the document.' }] : []),
      { label: 'Promote', icon: 'promote', disabled: !can || entry.level <= 1, onSelect: run(() => act.promote(entry.id)) },
      { label: 'Demote', icon: 'demote', disabled: !can || entry.level >= 9, onSelect: run(() => act.demote(entry.id)) },
      { separator: true },
      { label: 'New Heading Before', disabled: !can, onSelect: () => act.insert(entry.id, 'before') },
      { label: 'New Heading After', disabled: !can, onSelect: () => act.insert(entry.id, 'after') },
      { label: 'New Subheading', disabled: !can || entry.level >= 9, onSelect: () => act.insert(entry.id, 'sub') },
      { separator: true },
      { label: 'Select Heading and Content', disabled: !act || entry.inTable, onSelect: () => act.select(entry.id) },
      { label: 'Delete', icon: 'deleteComment', danger: true, disabled: !can, onSelect: () => act.remove(entry.id) },
      { separator: true },
      { label: 'Expand All', onSelect: () => { collapsed.clear(); signature = ''; renderHeadings(); refocus(entry.id); } },
      { label: 'Collapse All', onSelect: () => { collapsed = new Set(entries.filter((e, i) => entries[i + 1]?.level > e.level).map(e => e.id)); signature = ''; renderHeadings(); refocus(entries.findLast(e => e.start <= entry.start && e.level === 1)?.id || entry.id); } },
    ] });
  }
  let pagesToken = 0;
  function renderPages() {
    const canvases = api.pages();
    const token = ++pagesToken;
    // Thumbnails draw the screen pages scaled down, so they show exactly what the document shows.
    requestAnimationFrame(() => {
      if (token !== pagesToken || node.hidden || tab !== 'pages') return;
      const currentPage = api.currentPage();
      while (pageGrid.children.length > canvases.length) pageGrid.lastChild.remove();
      canvases.forEach((source, i) => {
        // Each list item holds a button, so the page is announced as a button in a list of pages.
        if (!pageGrid.children[i]) {
          const button = el('button.nav-page', { type: 'button', onclick: () => api.goToPage(Number(button.dataset.index)) }, el('canvas'), el('span.nav-page-number'));
          pageGrid.append(el('div.nav-page-item', { role: 'listitem' }, button));
        }
        const item = pageGrid.children[i].firstChild;
        item.dataset.index = i;
        item.setAttribute('aria-label', `Page ${i + 1}`);
        item.lastChild.textContent = String(i + 1);
        if (i === currentPage) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
        const thumb = item.firstChild, ratio = source.height / source.width || 1.294, scale = window.devicePixelRatio || 1;
        thumb.width = Math.round(THUMB_WIDTH * scale); thumb.height = Math.round(THUMB_WIDTH * ratio * scale);
        thumb.style.width = `${THUMB_WIDTH}px`; thumb.style.height = `${Math.round(THUMB_WIDTH * ratio)}px`;
        const ctx = thumb.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, thumb.width, thumb.height);
        if (source.width) ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
      });
    });
  }
  function renderResults() {
    const text = search.value;
    resultEmpty.hidden = !!matches.length;
    resultEmpty.textContent = text ? `We couldn't find what you're looking for. Check the spelling, or try another search.` : 'Search for text in the box above. Matches appear here in context.';
    const body = matches.length ? api.text() : '';
    // Choosing a result redraws the list; keyboard focus stays on the same row instead of dropping to the page.
    const focused = [...resultList.querySelectorAll('.nav-result')].indexOf(document.activeElement);
    resultList.replaceChildren(...matches.slice(0, 500).map((match, i) => {
      const start = Math.max(body.lastIndexOf('\n', match.start - 1) + 1, match.start - 40), end = Math.min(...[body.indexOf('\n', match.end), match.end + 60].filter(n => n >= 0));
      return el('li', {}, el('button.nav-result', { type: 'button', 'aria-current': i === current ? 'true' : null, onclick: () => { current = i; api.selectMatch(match); status.textContent = `Result ${i + 1} of ${matches.length}`; renderResults(); } },
        (start > 0 && body[start - 1] !== '\n' ? '…' : '') + body.slice(start, match.start), el('mark', {}, body.slice(match.start, match.end)), body.slice(match.end, end)));
    }));
    if (focused >= 0) (resultList.querySelectorAll('.nav-result')[Math.min(focused, matches.length - 1)] || search).focus();
  }
  function render() {
    if (node.hidden) return;
    if (tab === 'headings') renderHeadings();
    else if (tab === 'pages') renderPages();
    else renderResults();
  }

  return {
    node,
    /** The document changed or the caret moved: entries are the outline's headings. */
    refresh(nextEntries, caret) {
      entries = nextEntries; position = caret;
      if (node.hidden) return;
      if (search.value) {
        matches = api.search(search.value); api.highlight(matches);
        // The count and the current result follow edits to the document.
        if (current >= matches.length) current = -1;
        status.textContent = !matches.length ? 'No matches' : current >= 0 ? `Result ${current + 1} of ${matches.length}` : `${matches.length} result${matches.length === 1 ? '' : 's'}`;
      }
      render();
    },
    open({ focus = true } = {}) {
      node.hidden = false; signature = ''; render();
      if (focus) (tab === 'headings' && (headingList.querySelector('[aria-current]') || headingList.querySelector('.nav-heading')) || search).focus();
    },
    hide() { node.hidden = true; if (search.value) api.highlight([]); },
    focusSearch() { search.focus(); search.select(); },
    setSearch(text) { search.value = text; runSearch(); search.focus(); search.select(); },
    /** The text searched for last, for Find Next. */
    get query() { return search.value; },
    get tab() { return tab; },
    select,
  };
}
