// Projects panel: the open project as an accessible tree of documents.
// Enter or double click opens a document; the context menu renames, removes
// and reorders. Arrow keys move through the tree as in a file explorer.

import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { contextMenu } from '../menu.js';
import { promptDialog, confirmDialog } from '../dialog.js';

export class ProjectsPanel {
  constructor(app) {
    this.app = app;
    this.el = h('section.panel', { 'aria-labelledby': 'projects-title' });
    this.tree = h('ul.tree', { role: 'tree', 'aria-labelledby': 'projects-title' });
    this.expanded = true;
    this.el.append(
      h('div.panel-head', h('h2#projects-title', 'Projects'),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Add schematic sheet', 'data-tip': 'Add schematic sheet', onClick: () => app.commands.run('project.addSheet') }, icon('symbol', 15)),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Add board', 'data-tip': 'Add board', onClick: () => app.commands.run('project.addBoard') }, icon('board', 15)),
        h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Project options', 'data-tip': 'Project options', onClick: (e) => contextMenu(e, this._projectMenu()) }, icon('more', 15))),
      h('div.panel-scroll', this.tree),
    );
    this.tree.addEventListener('keydown', (e) => this._onKey(e));
  }

  _projectMenu() {
    return [
      { command: 'project.addSheet' }, { command: 'project.addBoard' },
      { separator: true },
      { command: 'project.rename' }, { command: 'file.save' }, { command: 'file.download' },
      { separator: true },
      { command: 'project.compile' }, { command: 'sch.annotate' }, { command: 'project.updateBoard' },
      { separator: true },
      { command: 'file.close' },
    ];
  }

  refresh() {
    const p = this.app.project;
    clear(this.tree);
    this.empty?.remove();
    this.tree.hidden = !p;
    if (!p) {
      this.empty = h('p.panel-empty', 'No project open. Create one or open an existing project from the File menu.');
      this.tree.after(this.empty);
      return;
    }
    const active = this.app.activeDocId;
    const docs = p.docs.map((d) => {
      const kids = h('li', { role: 'treeitem', 'aria-selected': String(d.id === active), tabindex: d.id === active ? 0 : -1, dataset: { doc: d.id }, 'aria-level': 2 },
        h('div.tree-row', { class: { 'active-doc': d.id === active }, style: { paddingLeft: '30px' } },
          icon(d.kind === 'sch' ? 'symbol' : 'board', 15), h('span.label', d.name), d.dirty ? h('span.dirty', { title: 'Unsaved changes', 'aria-label': 'unsaved changes' }) : null));
      kids.addEventListener('click', () => this._focus(kids));
      kids.addEventListener('dblclick', () => this.app.openDoc(d.id));
      kids.addEventListener('contextmenu', (e) => { this._focus(kids); contextMenu(e, this._docMenu(d)); });
      return kids;
    });
    const libCount = Object.keys(p.library).length;
    const libItem = h('li', { role: 'treeitem', tabindex: -1, dataset: { lib: '1' }, 'aria-level': 2 },
      h('div.tree-row', { style: { paddingLeft: '30px' } }, icon('library', 15), h('span.label', 'Component library'), h('span.meta', String(libCount))));
    libItem.addEventListener('dblclick', () => this.app.commands.run('lib.manage'));
    libItem.addEventListener('click', () => this._focus(libItem));
    const root = h('li', { role: 'treeitem', 'aria-expanded': String(this.expanded), tabindex: active ? -1 : 0, 'aria-level': 1, dataset: { root: '1' } },
      h('div.tree-row', { style: { paddingLeft: '6px' } },
        h('span.twisty', icon(this.expanded ? 'chevron-down' : 'chevron-right', 13)), icon('chip', 15),
        h('span.label', { style: { fontWeight: 600 } }, p.name), p.dirty ? h('span.dirty', { title: 'Unsaved changes', 'aria-label': 'unsaved changes' }) : null,
        h('span.meta', this.app.locationLabel || '')),
      h('ul', { role: 'group', hidden: !this.expanded }, docs, libItem));
    root.firstChild.addEventListener('click', () => { this.expanded = !this.expanded; this.refresh(); });
    root.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-doc]')) return; contextMenu(e, this._projectMenu()); });
    this.tree.append(root);
  }

  _docMenu(d) {
    const p = this.app.project;
    return [
      { label: '&Open', icon: 'open', run: () => this.app.openDoc(d.id) },
      { label: '&Rename', icon: 'pencil', run: async () => {
        const name = await promptDialog({ title: 'Rename document', label: 'Name', value: d.name, validate: (v) => (!v ? 'Enter a name' : p.docs.some((x) => x !== d && x.name.toLowerCase() === v.toLowerCase()) ? 'Another document has this name' : null) });
        if (name) p.renameDoc(d.id, name);
      } },
      { label: 'Move &up', run: () => p.moveDoc(d.id, -1), disabled: p.docs[0] === d },
      { label: 'Move &down', run: () => p.moveDoc(d.id, 1), disabled: p.docs[p.docs.length - 1] === d },
      { separator: true },
      { label: 'Re&move from project', icon: 'trash', run: async () => {
        // Autosave keeps the removal within seconds, so it cannot be taken back by not saving.
        const history = this.app.location ? ' Earlier saves stay in File, Version history.' : '';
        const ok = await confirmDialog({ title: 'Remove document', message: `Remove ${d.name} and everything on it from the project? This cannot be undone.${history}`, confirm: 'Remove', danger: true });
        if (ok) this.app.removeDoc(d.id);
      } },
    ];
  }

  _items() { return [...this.tree.querySelectorAll('[role="treeitem"]')].filter((el) => !el.closest('[hidden]')); }

  _focus(el) {
    for (const x of this._items()) x.tabIndex = -1;
    el.tabIndex = 0;
    el.focus();
  }

  _onKey(e) {
    const items = this._items();
    const cur = document.activeElement?.closest('[role="treeitem"]');
    const i = items.indexOf(cur);
    if (e.key === 'ArrowDown') { e.preventDefault(); if (i < items.length - 1) this._focus(items[i + 1]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) this._focus(items[i - 1]); }
    else if (e.key === 'Home') { e.preventDefault(); this._focus(items[0]); }
    else if (e.key === 'End') { e.preventDefault(); this._focus(items[items.length - 1]); }
    else if (e.key === 'ArrowRight' && cur?.dataset.root && !this.expanded) { e.preventDefault(); this.expanded = true; this.refresh(); this._focus(this._items()[0]); }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (cur?.dataset.root) { this.expanded = false; this.refresh(); this._focus(this._items()[0]); } else this._focus(items[0]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (cur?.dataset.doc) this.app.openDoc(cur.dataset.doc);
      else if (cur?.dataset.lib) this.app.commands.run('lib.manage');
      else if (cur?.dataset.root) { this.expanded = !this.expanded; this.refresh(); this._focus(this._items()[0]); }
    } else if (e.key === 'F2' && cur?.dataset.doc) {
      e.preventDefault();
      const d = this.app.project.getDoc(cur.dataset.doc);
      this._docMenu(d)[1].run();
    }
  }
}
