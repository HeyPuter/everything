import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { formatRelative } from '../lib/dates.js';
import { TAG_BY_ID, tagLabel, setTagDoneInHtml, extractTags } from '../data/tags.js';
import { pageText } from '../data/store.js';
import { insertHtml } from '../editor/format.js';
import { blockOf, blocksInRange, editableRoot, textOffset } from '../editor/selection.js';
import { textToHtml } from '../editor/page-editor.js';
import { openDialog, confirmDialog } from './dialog.js';
import { toast } from './toast.js';
import { ASSIST_ACTIONS } from './assist.js';

/**
 * The task pane on the right of the page: Tags Summary, Page Versions and
 * Assist share one slot, so only one is open at a time.
 */
export class TaskPanes {
  constructor(app) {
    this.app = app;
    this.kind = null;
    this.title = h('h2.side-title');
    this.body = h('div.side-body');
    this.el = h('aside.task-pane', { hidden: true, 'aria-labelledby': 'task-pane-title' },
      h('div.side-head', Object.assign(this.title, { id: 'task-pane-title' }), h('button.icon-btn', { type: 'button', 'aria-label': 'Close pane', onclick: () => this.toggle(this.kind) }, icon('x', 16))),
      this.body,
    );
    this.tagOptions = { scope: 'notebook', group: 'tag', openOnly: false };
  }

  toggle(kind) {
    if (this.kind === kind) {
      this.kind = null;
      this.el.hidden = true;
      this.app.taskPaneKind = null;
      this.app.editor.restoreRange();
      this.app.ribbon.refresh();
      return;
    }
    this.kind = kind;
    this.app.taskPaneKind = kind;
    this.el.hidden = false;
    this.render();
    this.app.ribbon.refresh();
    setTimeout(() => this.el.querySelector('button:not(.icon-btn), select, textarea, input')?.focus(), 0);
  }

  pageChanged() {
    if (this.kind === 'versions' || this.kind === 'assist') this.render();
  }

  render() {
    if (this.kind === 'tags') this.renderTags();
    else if (this.kind === 'versions') this.renderVersions();
    else if (this.kind === 'assist') this.renderAssist();
  }

  // ------------------------------------------------------------ Tags Summary

  scopeValue() {
    const { state } = this.app;
    const s = this.tagOptions.scope;
    if (s === 'page') return state.pageId ? `page:${state.pageId}` : 'all';
    if (s === 'section') return state.sectionId ? `section:${state.sectionId}` : 'all';
    if (s === 'notebook') return state.notebookId ? `notebook:${state.notebookId}` : 'all';
    return 'all';
  }

  async renderTags() {
    this.title.textContent = 'Tags Summary';
    const o = this.tagOptions;
    const select = (label, key, options) => {
      const sel = h('select.select', { 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: o[key] === v }, l)));
      sel.addEventListener('change', () => {
        o[key] = sel.value;
        this.renderTags();
      });
      return h('label.field', h('span.field-label', label), sel);
    };
    const openOnly = h('input', { type: 'checkbox', checked: o.openOnly });
    openOnly.addEventListener('change', () => {
      o.openOnly = openOnly.checked;
      this.renderTags();
    });
    const list = h('div', { 'aria-busy': 'true' }, h('div.empty-state', h('div.spinner')));
    this.body.replaceChildren(
      h('div', { style: { padding: '0 14px' } },
        select('Group tags by', 'group', [['tag', 'Tag name'], ['section', 'Section'], ['title', 'Page title'], ['date', 'Date'], ['text', 'Note text']]),
        select('Search', 'scope', [['page', 'This page'], ['section', 'This section'], ['notebook', 'This notebook'], ['all', 'All notebooks']]),
        h('label.check-row', openOnly, 'Show only unchecked items'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '8px 0 12px' } },
          h('button.btn.small', { type: 'button', onclick: () => this.renderTags() }, icon('sync', 14), 'Refresh Results'),
          h('button.btn.small', { type: 'button', onclick: () => this.summaryPage() }, icon('newPage', 14), 'Create Summary Page'),
        ),
      ),
      list,
    );
    this.app.editor.flush();
    // A slower earlier search (another scope or filter) must not win.
    const token = (this.tagsToken = {});
    let items = await this.app.store.collectTags(this.scopeValue());
    if (token !== this.tagsToken) return;
    if (o.openOnly) items = items.filter((t) => TAG_BY_ID.get(t.tag)?.kind === 'check' && !t.done);
    this.lastTags = items;
    list.removeAttribute('aria-busy');
    if (!items.length) {
      list.replaceChildren(h('div.empty-state', icon('findTags', 28), h('p', 'No tagged notes found.')));
      return;
    }
    const keyOf = {
      tag: (t) => tagLabel(t.tag),
      section: (t) => t.section.name,
      title: (t) => t.meta.title || 'Untitled Page',
      date: (t) => formatRelative(t.meta.modified || t.meta.created),
      text: (t) => (t.text[0] || '#').toUpperCase(),
    }[o.group];
    const groups = new Map();
    for (const t of items) {
      const k = keyOf(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const nodes = [];
    for (const [k, group] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      nodes.push(h('div.group-label', { role: 'presentation' }, `${k} (${group.length})`));
      for (const t of group) nodes.push(this.tagItem(t));
    }
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Tagged notes');
    list.replaceChildren(...nodes);
  }

  tagItem(t) {
    const def = TAG_BY_ID.get(t.tag);
    const glyph = h('span.tag-glyph', { style: { '--tag-color': def?.color, '--tag-icon': `var(--tagicon-${t.tag})` } });
    const row = h('div.result', { role: 'listitem', style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } });
    if (def?.kind === 'check') {
      const box = h('input', { type: 'checkbox', checked: t.done, 'aria-label': `Mark "${t.text}" as ${t.done ? 'not done' : 'done'}`, style: { marginTop: '2px', accentColor: 'var(--accent)' } });
      box.addEventListener('change', async () => {
        if ((await this.setDone(t, box.checked)) === false) box.checked = !box.checked;
      });
      row.append(box);
    } else row.append(glyph);
    const open = h('button.link-btn', { type: 'button', style: { fontWeight: '400', color: 'var(--text)', textAlign: 'left', flex: '1', textDecoration: t.done ? 'line-through' : 'none' } },
      h('div', t.text || '(empty)'),
      h('div.result-path', `${t.meta.title || 'Untitled Page'} · ${t.section.name}`),
    );
    open.addEventListener('click', () => this.app.openPage(t.meta.id, { find: t.text.slice(0, 60) }));
    row.append(open);
    return row;
  }

  async setDone(t, done) {
    const page = await this.app.store.loadPage(t.meta.id);
    if (this.app.state.pageId === page.id) this.app.editor.flush();
    const outline = page.outlines.find((o) => o.id === t.outlineId);
    // The note may have changed since the list was made: find the listed
    // tag again rather than trusting its old position.
    const now = outline ? extractTags([outline]) : [];
    const same = (c) => c.tag === t.tag && c.text === t.text;
    const index = now[t.index] && same(now[t.index]) ? t.index : now.findIndex(same);
    if (index < 0) {
      toast('That note has changed. Refresh Results and try again.');
      return false;
    }
    outline.html = setTagDoneInHtml(outline.html, index, done);
    this.app.store.pageChanged(page);
    if (this.app.state.pageId === page.id) await this.app.editor.render();
    t.done = done;
  }

  summaryPage() {
    const items = this.lastTags || [];
    if (!items.length) {
      toast('There are no tagged notes to summarize.');
      return;
    }
    const groups = new Map();
    for (const t of items) {
      const k = tagLabel(t.tag);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    let html = '';
    for (const [k, list] of groups) {
      html += `<h2>${escape(k)}</h2>`;
      for (const t of list) {
        const done = TAG_BY_ID.get(t.tag)?.kind === 'check' ? ` data-done="${t.done}"` : '';
        html += `<p><span class="nt-tag" data-tag="${t.tag}"${done} contenteditable="false"></span>${escape(t.text)} (<a href="#page=${t.meta.id}">${escape(t.meta.title || 'Untitled Page')}</a>)</p>`;
      }
    }
    this.app.newPage({ title: 'Tags Summary', outlines: [{ id: 'o-summary', x: 48, y: 140, w: 640, html }] });
  }

  // ------------------------------------------------------------ Page Versions

  async renderVersions() {
    this.title.textContent = 'Page Versions';
    const pageId = this.app.state.pageId;
    if (!pageId) {
      this.body.replaceChildren(h('div.empty-state', h('p', 'Open a page to see its versions.')));
      return;
    }
    this.body.replaceChildren(h('div.empty-state', h('div.spinner')));
    const versions = await this.app.store.versions(pageId);
    if (pageId !== this.app.state.pageId) return;
    if (!versions.length) {
      this.body.replaceChildren(h('div.empty-state', icon('history', 28), h('p', 'No earlier versions yet. A version is kept each time you come back to edit a page after a while.')));
      return;
    }
    this.body.replaceChildren(
      h('p.field-hint', { style: { padding: '0 14px 8px' } }, 'Earlier versions of this page. Restoring keeps the current version as a version too.'),
      ...versions.map((v) => {
        const when = new Date(v.at);
        const preview = h('button.btn.small', { type: 'button', onclick: () => this.previewVersion(v) }, 'Preview');
        const restore = h('button.btn.small', { type: 'button', onclick: async () => {
          if (!(await confirmDialog({ title: 'Restore this version?', message: `The page will go back to how it was on ${when.toLocaleString()}.`, okLabel: 'Restore' }))) return;
          let restored;
          try {
            restored = await this.app.store.restoreVersion(pageId, v.at);
          } catch (err) {
            console.error(err);
            toast("Couldn't restore this version. Check your connection and try again.", { kind: 'error' });
            return;
          }
          toast(restored ? 'Version restored' : 'That version is no longer available.', { kind: restored ? 'info' : 'error' });
          this.renderVersions();
        } }, 'Restore');
        return h('div.result', { style: { display: 'grid', gap: '6px' } },
          h('div.result-title', when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })),
          h('div.result-snippet', pageText(v.page).slice(0, 140) || '(empty page)'),
          h('div', { style: { display: 'flex', gap: '6px' } }, preview, restore),
        );
      }),
    );
  }

  previewVersion(v) {
    openDialog({
      title: `Version from ${new Date(v.at).toLocaleString()}`,
      width: 640,
      body: h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.5', maxHeight: '60vh', overflow: 'auto' } }, pageText(v.page) || '(empty page)'),
      actions: [{ label: 'Close', primary: true }],
    });
  }

  // ------------------------------------------------------------ Assist

  renderAssist() {
    this.title.textContent = 'Assist';
    const app = this.app;
    const output = h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: '1.5', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: '6px', background: 'var(--bg-input)', minHeight: '80px' }, 'aria-live': 'polite' });
    const outputActions = h('div', { style: { display: 'flex', gap: '6px', margin: '8px 0' }, hidden: true });
    let result = '';
    let lastSelection = null;
    const run = async (prompt, label) => {
      output.replaceChildren(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-3)' } }, h('div.spinner'), `${label}...`));
      outputActions.hidden = true;
      try {
        result = (await app.ai.ask(prompt)).trim();
        output.textContent = result || 'No answer.';
        // Rewrite and proofread replace the text they were given.
        insert.replaceChildren(icon('plus', 14), lastSelection ? 'Replace Selection' : 'Insert on Page');
        outputActions.hidden = !result;
      } catch (err) {
        output.textContent = `Assist could not answer: ${err?.message || err?.error?.message || 'request failed'}`;
      }
    };
    const pageTextNow = () => {
      app.editor.flush();
      return app.editor.page ? pageText(app.editor.page).slice(0, 12000) : '';
    };
    const buttons = ASSIST_ACTIONS.map((a) => h('button.btn', { type: 'button', style: { justifyContent: 'flex-start' }, onclick: () => {
      let text;
      if (a.needsSelection) {
        app.editor.restoreRange();
        text = window.getSelection()?.toString();
        if (!text) {
          toast('Select some text on the page first.');
          return;
        }
        lastSelection = app.editor.lastRange?.cloneRange();
      } else {
        text = pageTextNow();
        lastSelection = null;
        if (!text.trim()) {
          toast('This page has no text yet.');
          return;
        }
      }
      run(a.prompt(text), a.label);
    } }, icon('sparkles', 14), a.label));
    const ask = h('textarea.input', { rows: 3, placeholder: 'Ask a question about this page', 'aria-label': 'Ask a question about this page' });
    const askBtn = h('button.btn.primary', { type: 'button', onclick: () => {
      const q = ask.value.trim();
      if (!q) return;
      lastSelection = null;
      run(`Answer the question using these notes. Reply in plain text.\n\nNotes:\n${pageTextNow()}\n\nQuestion: ${q}`, 'Thinking');
    } }, 'Ask');
    const insert = h('button.btn.small', { type: 'button', onclick: () => {
      if (!result) return;
      if (lastSelection && lastSelection.commonAncestorContainer.isConnected) {
        app.editor.lastRange = withoutNextParagraph(lastSelection);
        app.editor.restoreRange();
        insertHtml(textToHtml(result));
      } else {
        const html = result.split('\n').filter(Boolean).map((l) => `<p>${escape(l)}</p>`).join('');
        const el = app.editor.createOutlineAt(48, app.editor.nextFreeY(), '');
        el.querySelector('.outline-body').innerHTML = html;
      }
      app.editor.markActiveDirty();
      toast('Added to the page');
    } }, icon('plus', 14), 'Insert on Page');
    const copy = h('button.btn.small', { type: 'button', onclick: () => navigator.clipboard?.writeText(result).then(() => toast('Copied')) }, icon('copy', 14), 'Copy');
    outputActions.append(insert, copy);
    this.body.replaceChildren(h('div', { style: { padding: '0 14px 16px', display: 'grid', gap: '8px' } },
      h('p.field-hint', 'Assist uses AI through your Puter account. Check its answers before relying on them.'),
      ...buttons,
      h('div.field', { style: { marginTop: '8px' } }, ask, askBtn),
      output,
      outputActions,
    ));
  }
}

/**
 * A triple-clicked paragraph is selected up to the start of the next one;
 * replacing that range would merge the next paragraph into the new text.
 * Ends the range at the end of the last paragraph it really covers.
 */
function withoutNextParagraph(selection) {
  const range = selection.cloneRange();
  const root = editableRoot(range.commonAncestorContainer);
  const end = root && blockOf(range.endContainer, root);
  if (!end || end === blockOf(range.startContainer, root) || textOffset(end, range.endContainer, range.endOffset) > 0) return range;
  const last = blocksInRange(range, root).filter((b) => b !== end && !b.contains(end)).at(-1);
  if (last) range.setEnd(last, last.childNodes.length);
  return range;
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
