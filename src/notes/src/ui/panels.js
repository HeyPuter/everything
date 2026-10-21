import { h, debounce, escapeHtml } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatRelative } from '../lib/dates.js';
import { normalize, foldWithOffsets } from '../data/store.js';

function highlightSnippet(text, terms) {
  const html = escapeHtml(text);
  const { flat, from, to } = foldWithOffsets(text);
  // Mark matches by position on the accent-folded copy.
  const marks = [];
  for (const t of terms) {
    let i = flat.indexOf(t);
    while (i >= 0 && marks.length < 20) {
      marks.push([from(i), to(i + t.length)]);
      i = flat.indexOf(t, i + t.length);
    }
  }
  if (!marks.length) return html;
  marks.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e] of marks) {
    if (s < pos) continue;
    out += escapeHtml(text.slice(pos, s)) + `<mark>${escapeHtml(text.slice(s, e))}</mark>`;
    pos = e;
  }
  return out + escapeHtml(text.slice(pos));
}

function resultRow(app, { notebook, section, meta, snippet }, terms, find) {
  const color = app.nav.colorOf(section.color);
  const btn = h('button.result', { type: 'button', 'aria-current': String(meta.id === app.state.pageId) },
    h('div.result-title', meta.title?.trim() || 'Untitled Page'),
    h('div.result-path', h('span.dot', { style: { '--sec-color': color } }), `${notebook.name} › ${section.name}`, h('span', { style: { marginLeft: 'auto' } }, formatRelative(meta.modified || meta.created))),
  );
  if (snippet) btn.append(h('div.result-snippet', { html: highlightSnippet(snippet, terms) }));
  btn.addEventListener('click', () => app.openPage(meta.id, { find }));
  return btn;
}

/** Search across notebooks (rail > Search). */
export class SearchPanel {
  constructor(app) {
    this.app = app;
    this.input = h('input.input', { type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes', autocomplete: 'off', spellcheck: 'false' });
    this.scope = h('select', { 'aria-label': 'Search scope' });
    this.status = h('div.sr-only', { role: 'status', 'aria-live': 'polite' });
    this.results = h('div.side-body', { role: 'region', 'aria-label': 'Search results' });
    this.el = h('section.side-panel', { 'aria-label': 'Search', hidden: true },
      h('div.side-head', h('h2.side-title', 'Search'), h('button.icon-btn', { type: 'button', 'aria-label': 'Close search', onclick: () => app.closeSidePanel() }, icon('x', 16))),
      h('div.search-box', icon('search', 16), this.input),
      h('label.search-scope', 'In', this.scope),
      this.status,
      this.results,
    );
    const run = debounce(() => this.run(), 220);
    this.input.addEventListener('input', run);
    this.scope.addEventListener('change', () => this.run());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Results still showing an earlier query would open the wrong
        // page, so search for what is typed now first.
        const want = this.queryKey();
        const ready = this.shown === want && !run.pending() ? null : (run.cancel(), this.run());
        Promise.resolve(ready).then(() => {
          if (this.shown === want) this.results.querySelector('.result')?.click();
        });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.results.querySelector('.result')?.focus();
      } else if (e.key === 'Escape') {
        if (this.input.value) this.input.value = '';
        else app.closeSidePanel();
        this.run();
      }
    });
    this.results.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = [...this.results.querySelectorAll('.result')];
      const i = list.indexOf(document.activeElement);
      e.preventDefault();
      if (e.key === 'ArrowUp' && i <= 0) this.input.focus();
      else list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    });
  }

  show() {
    const { state, store } = this.app;
    const nb = store.notebook(state.notebookId);
    const section = store.section(state.sectionId);
    const current = this.scope.value;
    this.scope.replaceChildren(
      h('option', { value: 'all' }, 'All Notebooks'),
      nb ? h('option', { value: `notebook:${nb.id}` }, `This Notebook (${nb.name})`) : null,
      section ? h('option', { value: `section:${section.id}` }, `This Section (${section.name})`) : null,
      state.pageId ? h('option', { value: `page:${state.pageId}` }, 'This Page') : null,
    );
    if ([...this.scope.options].some((o) => o.value === current)) this.scope.value = current;
    this.run();
  }

  focus() {
    this.input.focus();
    this.input.select();
  }

  queryKey() {
    return `${this.scope.value || 'all'}\n${this.input.value.trim()}`;
  }

  async run() {
    const q = this.input.value.trim();
    const key = this.queryKey();
    const token = (this.token = Symbol('search'));
    this.shown = null;
    if (!q) {
      this.results.replaceChildren(h('div.empty-state', icon('search', 28), h('p', 'Search titles and text in your notebooks.')));
      this.status.textContent = '';
      return;
    }
    this.results.replaceChildren(h('div.empty-state', h('div.spinner'), h('p', 'Searching...')));
    const results = await this.app.store.search(q, { scope: this.scope.value || 'all' });
    if (token !== this.token) return;
    const terms = normalize(q).split(/\s+/).filter(Boolean);
    if (!results.length) {
      this.results.replaceChildren(h('div.empty-state', h('p', `No results for "${q}".`)));
    } else {
      this.results.replaceChildren(h('div.group-label', `${results.length} ${results.length === 1 ? 'result' : 'results'}`), ...results.map((r) => resultRow(this.app, r, terms, q)));
    }
    this.status.textContent = results.length ? `${results.length} results` : 'No results';
    this.shown = key;
  }
}

/** Recently edited pages across notebooks (rail > Recent). */
export class RecentPanel {
  constructor(app) {
    this.app = app;
    this.list = h('div.side-body');
    this.el = h('section.side-panel', { 'aria-label': 'Recent notes', hidden: true },
      h('div.side-head', h('h2.side-title', 'Recent Notes'), h('button.icon-btn', { type: 'button', 'aria-label': 'Close recent notes', onclick: () => app.closeSidePanel() }, icon('x', 16))),
      this.list,
    );
    this.list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...this.list.querySelectorAll('.result')];
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    });
  }

  render() {
    const items = this.app.store.recentPages(50);
    if (!items.length) {
      this.list.replaceChildren(h('div.empty-state', icon('recent', 28), h('p', 'Pages you edit show up here.')));
      return;
    }
    const groups = new Map();
    const now = new Date();
    for (const it of items) {
      const d = new Date(it.meta.modified || it.meta.created);
      const days = Math.floor((now - d) / 86400000);
      const label = days < 1 && d.getDate() === now.getDate() ? 'Today' : days < 7 ? 'This Week' : days < 31 ? 'This Month' : 'Older';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(it);
    }
    const nodes = [];
    for (const [label, list] of groups) {
      nodes.push(h('div.group-label', label));
      nodes.push(...list.map((r) => resultRow(this.app, r, [])));
    }
    this.list.replaceChildren(...nodes);
  }
}
