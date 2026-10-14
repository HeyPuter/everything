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
    if (search.value) { search.value = ''; runSearch(); search.focus(); return; }
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
    current = (current + (e.shiftKey ? -1 : 1) + matches.length) % matches.length;
    api.selectMatch(matches[current]);
    status.textContent = `Result ${current + 1} of ${matches.length}`;
    renderResults();
  });

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
            else if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && editable()) {
              // Move the section past its neighbour, as dragging would.
              e.preventDefault();
              const at = entries.indexOf(entry), step = e.key === 'ArrowUp' ? -1 : 1;
              let target = at + step;
              while (entries[target] && entries[target].level > entry.level) target += step;
              if (entries[target]) { actions().move(entry.id, entries[target].id, step < 0 ? 'before' : 'after'); refocus(entry.id); }
            }
          } }, el('span', {}, entry.text));
        const row = el('div.nav-heading-row', { style: { paddingInlineStart: `${4 + (entry.level - 1) * 14}px` } }, toggle, heading);
        if (editable()) dragHeading(row, heading, entry);
        rows.push(el('li', { role: 'none' }, row));
      });
      headingList.replaceChildren(...rows);
      if (focused) headingList.querySelector(`[data-paragraph="${CSS.escape(focused)}"]`)?.focus();
    }
    const here = entries.filter(entry => entry.start <= position).at(-1)?.id;
    for (const button of headingList.querySelectorAll('.nav-heading')) {
      if (here === button.dataset.paragraph) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
    }
  }
  /* ---- Rearranging headings: drag a heading to move its section; its menu changes levels ---- */
  const actions = () => api.headingActions?.() || null;
  const editable = () => !!actions()?.canEdit?.();
  const refocus = id => requestAnimationFrame(() => headingList.querySelector(`[data-paragraph="${CSS.escape(id)}"]`)?.focus());
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
    const act = actions(), can = editable();
    const run = fn => () => { fn(); refocus(entry.id); };
    openMenu({ anchor, x: event?.clientX ?? null, y: event?.clientY ?? null, label: `${entry.text} heading`, pointer: !!event, items: [
      { label: 'Promote', icon: 'promote', disabled: !can || entry.level <= 1, onSelect: run(() => act.promote(entry.id)) },
      { label: 'Demote', icon: 'demote', disabled: !can || entry.level >= 9, onSelect: run(() => act.demote(entry.id)) },
      { separator: true },
      { label: 'New Heading Before', disabled: !can, onSelect: () => act.insert(entry.id, 'before') },
      { label: 'New Heading After', disabled: !can, onSelect: () => act.insert(entry.id, 'after') },
      { label: 'New Subheading', disabled: !can || entry.level >= 9, onSelect: () => act.insert(entry.id, 'sub') },
      { separator: true },
      { label: 'Select Heading and Content', disabled: !act, onSelect: () => act.select(entry.id) },
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
        let item = pageGrid.children[i];
        if (!item) {
          item = el('button.nav-page', { type: 'button', role: 'listitem', onclick: () => api.goToPage(Number(item.dataset.index)) }, el('canvas'), el('span.nav-page-number'));
          pageGrid.append(item);
        }
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
    resultList.replaceChildren(...matches.slice(0, 500).map((match, i) => {
      const start = Math.max(body.lastIndexOf('\n', match.start - 1) + 1, match.start - 40), end = Math.min(...[body.indexOf('\n', match.end), match.end + 60].filter(n => n >= 0));
      return el('li', {}, el('button.nav-result', { type: 'button', 'aria-current': i === current ? 'true' : null, onclick: () => { current = i; api.selectMatch(match); status.textContent = `Result ${i + 1} of ${matches.length}`; renderResults(); } },
        (start > 0 && body[start - 1] !== '\n' ? '…' : '') + body.slice(start, match.start), el('mark', {}, body.slice(match.start, match.end)), body.slice(match.end, end)));
    }));
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
      if (search.value) { matches = api.search(search.value); api.highlight(matches); }
      render();
    },
    open({ focus = true } = {}) {
      node.hidden = false; signature = ''; render();
      if (focus) (tab === 'headings' && (headingList.querySelector('[aria-current]') || headingList.querySelector('.nav-heading')) || search).focus();
    },
    hide() { node.hidden = true; if (search.value) api.highlight([]); },
    focusSearch() { search.focus(); search.select(); },
    setSearch(text) { search.value = text; runSearch(); search.focus(); search.select(); },
    get tab() { return tab; },
    select,
  };
}
