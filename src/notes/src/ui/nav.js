import { h, clamp } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { modKey } from '../lib/platform.js';
import { COLOR_BY_ID } from '../data/colors.js';
import { openMenu } from './menu.js';
import { prefs, setPref } from './prefs.js';

/**
 * Sections and pages panes. Both are flat role="tree" lists (aria-level
 * carries the nesting) with roving focus, inline rename, drag and drop and
 * context menus. All mutations go through the app.
 */
export class Nav {
  constructor(app) {
    this.app = app;
    this.el = h('div.nav', { role: 'navigation', 'aria-label': 'Notebook navigation' });
    this.buildSections();
    this.buildPages();
    this.el.append(this.sectionsPane, this.pagesPane);
    this.drag = null;
    this.applyWidths();
  }

  colorOf(id) {
    const c = COLOR_BY_ID.get(id);
    if (!c) return 'var(--line-strong)';
    return document.documentElement.dataset.themeResolved === 'dark' ? c.dark : c.light;
  }

  applyWidths() {
    const p = prefs();
    document.documentElement.style.setProperty('--sections-w', `${p.sectionsWidth}px`);
    document.documentElement.style.setProperty('--pages-w', `${p.pagesWidth}px`);
  }

  resizer(key) {
    const r = h('div.pane-resizer', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': key === 'sectionsWidth' ? 'Resize sections pane' : 'Resize pages pane', tabindex: '0', 'aria-valuemin': '120', 'aria-valuemax': '400' });
    const set = (w) => {
      const v = clamp(Math.round(w), 120, 400);
      setPref(key, v);
      r.setAttribute('aria-valuenow', String(v));
      this.applyWidths();
    };
    r.setAttribute('aria-valuenow', String(prefs()[key]));
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = prefs()[key];
      r.classList.add('dragging');
      const move = (ev) => set(w0 + ev.clientX - x0);
      const up = () => {
        r.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    r.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') set(prefs()[key] - 16);
      else if (e.key === 'ArrowRight') set(prefs()[key] + 16);
      else return;
      e.preventDefault();
    });
    return r;
  }

  // ------------------------------------------------------------ sections

  buildSections() {
    this.nbButton = h('button.nb-picker', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-tip': 'Notebooks', 'data-tip-desc': 'Switch notebooks or create a new one.' });
    this.nbButton.addEventListener('click', () => {
      if (this.nbButton._menuJustClosed) return;
      this.app.openNotebookMenu(this.nbButton);
    });
    this.sectionsList = h('div.tree', { role: 'tree', 'aria-label': 'Sections' });
    this.sectionsBody = h('div.pane-body', this.sectionsList);
    const add = h('button.pane-add', { type: 'button', 'data-tip': 'Add section', 'data-tip-key': 'Mod+Alt+T', onclick: () => this.app.newSection() }, icon('plus', 16), 'Add section');
    this.sectionsPane = h('section.pane.sections-pane', { 'aria-label': 'Sections' },
      h('div.pane-head', this.nbButton),
      this.sectionsBody,
      h('div.pane-foot', add),
      this.resizer('sectionsWidth'),
    );
    this.sectionsBody.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.row')) return;
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'New Section', icon: 'plus', run: () => this.app.newSection() },
        { label: 'New Section Group', icon: 'sectionGroup', run: () => this.app.newSectionGroup() },
      ], { label: 'Sections' });
    });
    this.bindTreeKeys(this.sectionsList, 'section');
    this.bindDrop(this.sectionsList, 'section');
  }

  list(kind) {
    return kind === 'page' ? this.pagesList : this.sectionsList;
  }

  /** Re-renders a tree and keeps keyboard focus on the same row. */
  keepFocus(list, render) {
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('.row')?.dataset.id : null;
    render();
    if (focused) this.focusRow(focused);
  }

  /** An empty tree is not a tree: the message sits outside it. */
  setEmpty(list, message) {
    list.removeAttribute('role');
    list.replaceChildren(h('div.pane-empty', message));
  }

  renderSections() {
    this.keepFocus(this.sectionsList, () => this.renderSectionsNow());
  }

  renderPages() {
    this.keepFocus(this.pagesList, () => this.renderPagesNow());
  }

  renderSectionsNow() {
    const { store, state } = this.app;
    const nb = store.notebook(state.notebookId);
    this.nbButton.replaceChildren(
      h('span.nb-glyph', { style: { '--nb-color': this.colorOf(nb?.color) } }),
      h('span.nb-name', nb ? nb.name : 'No notebook'),
      icon('chevDown', 14),
    );
    this.nbButton.setAttribute('aria-label', nb ? `Notebook: ${nb.name}. Switch notebooks` : 'Notebooks');
    const rows = [];
    const walk = (list, depth) => {
      list.forEach((node, i) => {
        rows.push(this.sectionRow(node, depth, i + 1, list.length));
        if (node.type === 'group' && !node.collapsed) walk(node.children, depth + 1);
      });
    };
    if (nb) walk(nb.sections, 0);
    this.sectionsList.setAttribute('role', 'tree');
    this.sectionsList.replaceChildren(...rows);
    if (!rows.length) this.setEmpty(this.sectionsList, 'This notebook has no sections yet. Add one to start writing.');
    this.fixRoving(this.sectionsList, state.sectionId);
  }

  sectionRow(node, depth, pos, size) {
    const { state } = this.app;
    const selected = node.id === state.sectionId;
    const row = h('div.row.section-row', {
      role: 'treeitem',
      'aria-level': String(depth + 1),
      'aria-setsize': String(size),
      'aria-posinset': String(pos),
      'aria-selected': String(selected),
      tabindex: '-1',
      draggable: 'true',
      dataset: { id: node.id, kind: node.type },
      style: { '--depth': depth },
    });
    if (node.type === 'group') {
      row.setAttribute('aria-expanded', String(!node.collapsed));
      const twisty = h('button.row-twisty', { type: 'button', tabindex: '-1', 'aria-hidden': 'true', 'aria-expanded': String(!node.collapsed) }, icon('chevDown', 14));
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.store.toggleGroup(node.id);
      });
      row.append(twisty, h('span.group-icon', icon('sectionGroup', 16, undefined, { plain: true })), h('span.row-label', node.name));
    } else {
      row.append(h('span.section-tab', { style: { '--sec-color': this.colorOf(node.color) } }), h('span.row-label', node.name));
      if (node.locked) row.append(h('span.lock', { title: 'Password protected' }, icon(this.app.isUnlocked(node.id) ? 'unlock' : 'lock', 14, undefined, { plain: true })));
    }
    row.addEventListener('click', () => {
      if (node.type === 'group') this.app.store.toggleGroup(node.id);
      else this.app.selectSection(node.id);
    });
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.rename(row, node.name, (v) => this.app.store.renameNode(node.id, v));
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.app.sectionMenu(node, { x: e.clientX, y: e.clientY });
    });
    this.bindDrag(row, 'section', node.id);
    return row;
  }

  // ------------------------------------------------------------ pages

  buildPages() {
    this.sortBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Sort pages', 'data-tip': 'Sort pages', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('sort', 18));
    this.sortBtn.addEventListener('click', () => {
      if (this.sortBtn._menuJustClosed) return;
      const current = prefs().pageSort;
      const opt = (id, label) => ({ label, radio: true, checked: current === id, run: () => { setPref('pageSort', id); this.renderPages(); } });
      openMenu(this.sortBtn, [
        { type: 'header', label: 'Sort pages by' },
        opt('manual', 'None (your order)'),
        opt('created', 'Date created'),
        opt('modified', 'Date modified'),
        opt('alpha', 'Alphabetical'),
      ], { label: 'Sort pages', align: 'end' });
    });
    this.sectionLabel = h('span.pane-title.sr-only');
    this.pagesList = h('div.tree', { role: 'tree', 'aria-label': 'Pages' });
    this.pagesBody = h('div.pane-body', this.pagesList);
    const add = h('button.pane-add', { type: 'button', 'data-tip': 'Add page', 'data-tip-key': 'Mod+Alt+N', onclick: () => this.app.newPage() }, icon('plus', 16), 'Add page');
    this.pagesHeadTitle = h('span.row-label.mobile-only-text');
    this.pagesPane = h('section.pane.pages-pane', { 'aria-label': 'Pages' },
      h('div.pane-head', this.pagesHeadTitle, h('span.ribbon-spacer'), this.sortBtn),
      this.pagesBody,
      h('div.pane-foot', add),
      this.resizer('pagesWidth'),
    );
    this.bindTreeKeys(this.pagesList, 'page');
    this.bindDrop(this.pagesList, 'page');
  }

  sortedPages(section) {
    const sort = prefs().pageSort;
    const pages = section.pages;
    if (sort === 'manual') return pages.map((m) => ({ meta: m, level: m.level || 0 }));
    const flat = pages.map((m) => ({ meta: m, level: 0 }));
    const cmp = {
      created: (a, b) => (b.meta.created || '').localeCompare(a.meta.created || ''),
      modified: (a, b) => (b.meta.modified || '').localeCompare(a.meta.modified || ''),
      alpha: (a, b) => (a.meta.title || 'Untitled Page').localeCompare(b.meta.title || 'Untitled Page', undefined, { sensitivity: 'base', numeric: true }),
    }[sort];
    return flat.sort(cmp);
  }

  renderPagesNow() {
    const { store, state } = this.app;
    const section = store.section(state.sectionId);
    this.pagesHeadTitle.textContent = section?.name || '';
    if (!section) {
      this.setEmpty(this.pagesList, 'Select a section to see its pages.');
      return;
    }
    if (section.locked && !this.app.isUnlocked(section.id)) {
      this.setEmpty(this.pagesList, 'This section is password protected.');
      return;
    }
    const manual = prefs().pageSort === 'manual';
    const items = this.sortedPages(section);
    const rows = [];
    let hideBelow = Infinity;
    items.forEach(({ meta, level }, i) => {
      if (level > hideBelow) return;
      hideBelow = Infinity;
      const next = items[i + 1];
      const hasChildren = manual && next && next.level > level;
      if (hasChildren && meta.collapsed) hideBelow = level;
      rows.push(this.pageRow(meta, level, hasChildren, manual));
    });
    this.pagesList.setAttribute('role', 'tree');
    this.pagesList.replaceChildren(...rows);
    if (!rows.length) this.setEmpty(this.pagesList, 'No pages in this section. Press Add page to start one.');
    this.fixRoving(this.pagesList, state.pageId);
  }

  pageRow(meta, level, hasChildren, manual) {
    const { state } = this.app;
    const title = meta.title?.trim();
    const row = h('div.row.page-row', {
      role: 'treeitem',
      'aria-level': String(level + 1),
      'aria-selected': String(meta.id === state.pageId),
      tabindex: '-1',
      draggable: manual ? 'true' : 'false',
      dataset: { id: meta.id, kind: 'page', level: String(level) },
      style: { '--level': level },
    });
    if (hasChildren) {
      row.setAttribute('aria-expanded', String(!meta.collapsed));
      const twisty = h('button.row-twisty', { type: 'button', tabindex: '-1', 'aria-hidden': 'true', 'aria-expanded': String(!meta.collapsed) }, icon('chevDown', 14));
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.store.togglePageCollapsed(meta.id);
      });
      row.append(twisty);
    }
    row.append(h(`span.row-label${title ? '' : '.untitled'}`, title || 'Untitled Page'));
    row.addEventListener('click', () => this.app.openPage(meta.id));
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.rename(row, meta.title || '', (v) => this.app.renamePage(meta.id, v), true);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.app.pageMenu(meta, { x: e.clientX, y: e.clientY });
    });
    if (manual) this.bindDrag(row, 'page', meta.id);
    return row;
  }

  /** Updates one page row's label while its title is being typed. */
  updatePageTitle(pageId, title) {
    const row = this.pagesList.querySelector(`.row[data-id="${CSS.escape(pageId)}"] .row-label`);
    if (!row) return;
    row.textContent = title.trim() || 'Untitled Page';
    row.classList.toggle('untitled', !title.trim());
  }

  // ------------------------------------------------------------ shared tree behavior

  fixRoving(list, selectedId) {
    const rows = [...list.querySelectorAll('.row')];
    const active = rows.find((r) => r.dataset.id === selectedId) || rows[0];
    for (const r of rows) r.tabIndex = r === active ? 0 : -1;
  }

  focusRow(id) {
    const row = this.el.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) {
      for (const r of row.parentElement.querySelectorAll('.row')) r.tabIndex = -1;
      row.tabIndex = 0;
      row.focus();
    }
  }

  bindTreeKeys(list, kind) {
    list.addEventListener('keydown', (e) => {
      const row = e.target.closest('.row');
      if (!row || e.target.closest('input')) return;
      const rows = [...list.querySelectorAll('.row')];
      const i = rows.indexOf(row);
      const go = (n) => {
        const target = rows[clamp(n, 0, rows.length - 1)];
        if (!target) return;
        for (const r of rows) r.tabIndex = -1;
        target.tabIndex = 0;
        target.focus();
        const id = target.dataset.id;
        // Opening re-renders the list; put focus back on the row it was on.
        const done = target.dataset.kind === 'page' ? this.app.openPage(id, { focus: false }) : target.dataset.kind === 'section' ? this.app.selectSection(id, { focus: false }) : null;
        this.focusRow(id);
        Promise.resolve(done).then(() => this.list(kind).contains(document.activeElement) || document.activeElement === document.body ? this.focusRow(id) : null);
      };
      const mod = modKey(e);
      if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        this.app.moveByKeyboard(kind, row.dataset.id, e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (kind === 'page' && mod && e.altKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        e.preventDefault();
        this.app.store.setPageLevel(row.dataset.id, e.code === 'BracketRight' ? 1 : -1);
        this.focusRow(row.dataset.id);
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          go(i + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          go(i - 1);
          break;
        case 'Home':
          e.preventDefault();
          go(0);
          break;
        case 'End':
          e.preventDefault();
          go(rows.length - 1);
          break;
        case 'ArrowRight':
          if (row.getAttribute('aria-expanded') === 'false') {
            e.preventDefault();
            if (row.dataset.kind === 'group') this.app.store.toggleGroup(row.dataset.id, false);
            else this.app.store.togglePageCollapsed(row.dataset.id);
            this.focusRow(row.dataset.id);
          } else if (row.getAttribute('aria-expanded') === 'true') {
            e.preventDefault();
            go(i + 1);
          }
          break;
        case 'ArrowLeft': {
          e.preventDefault();
          if (row.getAttribute('aria-expanded') === 'true') {
            if (row.dataset.kind === 'group') this.app.store.toggleGroup(row.dataset.id, true);
            else this.app.store.togglePageCollapsed(row.dataset.id);
            this.focusRow(row.dataset.id);
          } else {
            const level = Number(row.getAttribute('aria-level'));
            for (let k = i - 1; k >= 0; k--) {
              if (Number(rows[k].getAttribute('aria-level')) < level) {
                rows[k].tabIndex = 0;
                rows[k].focus();
                break;
              }
            }
          }
          break;
        }
        case 'Enter':
          e.preventDefault();
          if (row.dataset.kind === 'group') this.app.store.toggleGroup(row.dataset.id);
          else if (kind === 'section') {
            this.app.selectSection(row.dataset.id);
            this.pagesList.querySelector('.row[tabindex="0"]')?.focus();
          } else this.app.openPage(row.dataset.id, { focus: true });
          break;
        case ' ':
          e.preventDefault();
          row.click();
          break;
        case 'F2':
          e.preventDefault();
          row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          break;
        case 'Delete':
          e.preventDefault();
          if (kind === 'page') this.app.deletePage(row.dataset.id);
          else this.app.deleteSection(row.dataset.id);
          break;
        case 'ContextMenu':
          e.preventDefault();
          this.openRowMenu(row);
          break;
        default:
          if (e.key === 'F10' && e.shiftKey) {
            e.preventDefault();
            this.openRowMenu(row);
          }
      }
    });
  }

  openRowMenu(row) {
    const r = row.getBoundingClientRect();
    const point = { x: r.left + 24, y: r.bottom };
    if (row.dataset.kind === 'page') {
      const f = this.app.store.findPage(row.dataset.id);
      if (f) this.app.pageMenu(f.meta, point);
    } else {
      const f = this.app.store.findNode(row.dataset.id);
      if (f) this.app.sectionMenu(f.node, point);
    }
  }

  /** Inline rename. commit(value) runs on Enter or blur. */
  rename(row, value, commit, allowEmpty = false) {
    const label = row.querySelector('.row-label');
    if (!label) return;
    const input = h('input.row-rename', { type: 'text', value, 'aria-label': 'New name', spellcheck: 'false' });
    label.replaceWith(input);
    row.draggable = false;
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && (v || allowEmpty) && v !== value) commit(v);
      // Renaming the open page changes its title without redrawing the
      // list, so put the label back whenever the box is still there.
      if (input.isConnected) this.app.renderNav();
      setTimeout(() => this.focusRow(row.dataset.id));
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // ------------------------------------------------------------ drag and drop

  bindDrag(row, kind, id) {
    row.addEventListener('dragstart', (e) => {
      this.drag = { kind, id };
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      this.clearDrop();
      this.drag = null;
    });
  }

  clearDrop() {
    for (const el of this.el.querySelectorAll('.drop-before, .drop-after, .drop-into')) el.classList.remove('drop-before', 'drop-after', 'drop-into');
    this.dropTarget = null;
  }

  bindDrop(list, kind) {
    list.addEventListener('dragover', (e) => {
      if (!this.drag) return;
      const row = e.target.closest('.row');
      this.clearDrop();
      if (!row || row.dataset.id === this.drag.id) {
        if (!row && this.drag.kind === kind) {
          e.preventDefault();
          this.dropTarget = { end: true };
        }
        return;
      }
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      if (this.drag.kind === 'page' && kind === 'section') {
        if (row.dataset.kind !== 'section') return;
        e.preventDefault();
        row.classList.add('drop-into');
        this.dropTarget = { into: row.dataset.id };
        return;
      }
      if (this.drag.kind !== kind) return;
      e.preventDefault();
      if (kind === 'section' && row.dataset.kind === 'group' && y > 0.25 && y < 0.75) {
        row.classList.add('drop-into');
        this.dropTarget = { into: row.dataset.id };
        return;
      }
      const before = y < 0.5;
      row.classList.add(before ? 'drop-before' : 'drop-after');
      let level;
      if (kind === 'page') {
        level = clamp(Math.round((e.clientX - r.left - 14) / 16), 0, 2);
        row.style.setProperty('--drop-indent', `${level * 16}px`);
      }
      this.dropTarget = { id: row.dataset.id, before, level };
    });
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) this.clearDrop();
    });
    list.addEventListener('drop', (e) => {
      if (!this.drag || !this.dropTarget) return;
      e.preventDefault();
      const target = this.dropTarget;
      const drag = this.drag;
      this.clearDrop();
      this.app.drop(drag, target, kind);
    });
  }
}
