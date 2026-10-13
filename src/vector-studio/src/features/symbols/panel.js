/**
 * Symbols panel: the document's symbols as thumbnails, a small list or a
 * large list, with search, the panel menu (including saving symbols as a
 * user-defined library), symbol libraries, and buttons
 * for Place Symbol Instance, Break Link, Symbol Options, New Symbol and
 * Delete. Click selects (Shift for a range, Cmd/Ctrl to toggle),
 * double-click edits the symbol, Enter places it; drag a symbol onto the
 * canvas to place it there, or drag artwork from the canvas onto the
 * panel to make a symbol.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { symbolDefs, instancesOf, onPage, getDef, editingStack, symbolStore } from './model.js';
import { symbolThumb, pruneThumbs } from './thumbs.js';
import { symbolState, setSymbolSelection } from './state.js';
import { selectedInstances, placeSymbol } from './commands.js';
import { dragToCanvas } from './drag.js';
import { SYMBOL_LIBRARIES } from './libraries.js';
import { openSymbolLibrary } from './library-window.js';
import { exportSymbolsFor, importSymbols } from './model.js';
import { userLibraryMenu, saveLibraryDialog } from '../paint/user-libraries.js';

const VIEWS = [
  { id: 'grid', label: 'Thumbnail View', icon: 'symbols-grid' },
  { id: 'small', label: 'Small List View', icon: 'symbols-list-small' },
  { id: 'large', label: 'Large List View', icon: 'symbols-list-large' },
];

export class SymbolsPanel extends Panel {
  static id = 'symbols';
  static title = 'Symbols';
  static icon = 'symbol';
  static placement = 'strip';
  static shortcut = 'Shift+Mod+F11';

  build() {
    const app = this.app;
    this.view = VIEWS.some((v) => v.id === app.prefs.get('symbolsView')) ? app.prefs.get('symbolsView') : 'grid';
    this.query = '';
    this.anchorId = null;
    this.search = h('input.sym-search', { type: 'search', placeholder: 'Search symbols', 'aria-label': 'Search symbols' });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.viewBtns = VIEWS.map((v) => iconButton(v.icon, v.label, () => this.setView(v.id), { className: 'small', pressed: this.view === v.id }));
    this.list = h('div.sym-list', { role: 'listbox', 'aria-label': 'Symbols', 'aria-multiselectable': 'true', tabindex: '-1' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('click', (e) => {
      if (e.target === this.list) {
        setSymbolSelection(this.editor, []);
        this.render();
      }
    });
    this.count = h('span.sym-count', { 'aria-live': 'polite' });
    const libBtn = iconButton('symbol-library', 'Symbol Libraries menu', (e) => this.openLibraries(e.currentTarget), { className: 'small' });
    libBtn.setAttribute('aria-haspopup', 'menu');
    this.btn = {
      place: iconButton('symbol-place', 'Place Symbol Instance', () => this.run('symbol.place'), { className: 'small' }),
      breakLink: iconButton('symbol-break', 'Break Link to Symbol', () => this.run('symbol.breakLink'), { className: 'small' }),
      options: iconButton('sliders-horizontal', 'Symbol Options', () => this.run('symbol.options'), { className: 'small' }),
      add: iconButton('plus', 'New Symbol', (e) => this.run('symbol.new', { direct: e.altKey }), { className: 'small' }),
      del: iconButton('trash', 'Delete Symbol', () => this.run('symbol.delete'), { className: 'small' }),
    };
    this.footer = h('div.sym-footer', libBtn, this.count, h('span.sym-spacer'), ...Object.values(this.btn));
    this.dropHint = h('div.sym-drop-hint', { 'aria-hidden': 'true' }, 'Drop to make a symbol');
    this.el.append(h('div.sym-top', this.search, h('div.sym-views', { role: 'group', 'aria-label': 'View' }, ...this.viewBtns)), h('div.sym-list-wrap', this.list, this.dropHint), this.footer);
  }

  run(id, args) {
    return this.app.commands.run(id, args);
  }

  setView(v) {
    this.view = v;
    this.app.prefs.set('symbolsView', v);
    VIEWS.forEach((x, i) => this.viewBtns[i].setAttribute('aria-pressed', String(x.id === v)));
    this.render();
  }

  update() {
    const ed = this.editor;
    this.el.classList.toggle('disabled', !ed);
    const doc = ed?.doc;
    const store = doc ? symbolStore(doc) : null;
    const defs = doc ? symbolDefs(doc) : [];
    const inUse = ed ? selectedInstances(ed).map((n) => n.symbol).join(',') : '';
    const st = ed ? symbolState(ed) : null;
    const key = [doc, store, ...defs, ...(defs.map((d) => d.children.map((c) => doc.get(c)))).flat(), inUse, st && [...st.selected].join(','), st?.current, ed && editingStack(doc).length];
    if (this.renderKey && key.length === this.renderKey.length && key.every((k, i) => k === this.renderKey[i])) {
      this.refreshButtons();
      return;
    }
    this.renderKey = key;
    this.render();
  }

  refreshButtons() {
    const c = this.app.commands;
    this.btn.place.disabled = !c.isEnabled('symbol.place');
    this.btn.breakLink.disabled = !c.isEnabled('symbol.breakLink');
    this.btn.options.disabled = !c.isEnabled('symbol.options');
    this.btn.add.disabled = !c.isEnabled('symbol.new');
    this.btn.del.disabled = !c.isEnabled('symbol.delete');
  }

  /** Is a client point over the symbol list (a drop target for artwork dragged from the canvas)? */
  isDropTarget(clientX, clientY) {
    if (!this.visible || !this.built) return false;
    const under = document.elementFromPoint?.(clientX, clientY);
    return Boolean(under && this.el.contains(under) && this.el.isConnected);
  }

  setDropHighlight(on) {
    this.el.classList.toggle('drop-target', Boolean(on));
  }

  render() {
    const ed = this.editor;
    this.list.className = `sym-list view-${this.view}`;
    if (!ed) {
      this.list.replaceChildren(h('p.panel-empty', 'No document'));
      this.count.textContent = '';
      this.refreshButtons();
      return;
    }
    const doc = ed.doc;
    const defs = symbolDefs(doc);
    pruneThumbs(defs.map((d) => d.id));
    const st = symbolState(ed);
    for (const id of [...st.selected]) if (!getDef(doc, id)) st.selected.delete(id);
    const used = new Set(selectedInstances(ed).map((n) => n.symbol));
    const editing = new Set(editingStack(doc).map((e) => e.id));
    const shown = this.query ? defs.filter((d) => d.name.toLowerCase().includes(this.query)) : defs;
    const counts = new Map();
    if (this.view === 'large') for (const n of instancesOf(doc)) if (onPage(doc, n.id)) counts.set(n.symbol, (counts.get(n.symbol) || 0) + 1);
    const items = shown.map((d) => this.item(d, st.selected.has(d.id), used.has(d.id), editing.has(d.id), counts.get(d.id) || 0));
    this.list.replaceChildren(...items);
    if (!defs.length) this.list.append(h('p.panel-empty.sym-empty', 'No symbols yet. Select artwork and choose New Symbol, drag artwork here, or place one from a library.'));
    else if (!items.length) this.list.append(h('p.panel-empty', 'No symbols match.'));
    const focusId = st.current && shown.some((d) => d.id === st.current) ? st.current : shown[0]?.id;
    const focusEl = focusId ? this.list.querySelector(`[data-id="${CSS.escape(focusId)}"]`) : null;
    if (focusEl) focusEl.tabIndex = 0;
    this.count.textContent = defs.length ? `${defs.length} ${defs.length === 1 ? 'symbol' : 'symbols'}` : '';
    this.refreshButtons();
  }

  item(def, selected, used, editing, count) {
    const size = this.view === 'grid' ? 44 : this.view === 'large' ? 36 : 18;
    const kind = def.symbolDef.kind === 'static' ? 'Static' : 'Dynamic';
    const label = `${def.name}, ${kind.toLowerCase()} symbol${editing ? ', being edited' : ''}${used ? ', used by the selection' : ''}`;
    const el = h(
      'div.sym-item',
      { role: 'option', tabindex: '-1', 'aria-selected': String(selected), 'aria-label': label, 'data-id': def.id, 'data-tip': this.view === 'grid' ? def.name : null },
      h('span.sym-thumb-wrap', symbolThumb(this.editor.doc, def, size)),
      this.view !== 'grid' ? h('span.sym-name', def.name) : null,
      this.view === 'large' ? h('span.sym-meta', `${kind}${def.symbolDef.slice9 ? ' · 9-slice' : ''} · ${count} ${count === 1 ? 'instance' : 'instances'}`) : null,
    );
    el.classList.toggle('used', used);
    el.classList.toggle('editing', editing);
    el.addEventListener('click', (e) => this.onClick(def.id, e));
    el.addEventListener('dblclick', () => this.run('symbol.edit', { id: def.id }));
    el.addEventListener('pointerdown', (e) =>
      dragToCanvas(this.app, el, e, {
        preview: () => symbolThumb(this.editor.doc, def, 40),
        onDrop: (p) => placeSymbol(this.app, def.id, p),
      }),
    );
    return el;
  }

  onClick(id, e) {
    const ed = this.editor;
    const st = symbolState(ed);
    let ids;
    if (e.metaKey || e.ctrlKey) {
      ids = new Set(st.selected);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      ids = [...ids];
    } else if (e.shiftKey && this.anchorId) {
      const order = [...this.list.querySelectorAll('[data-id]')].map((n) => n.dataset.id);
      const a = order.indexOf(this.anchorId);
      const b = order.indexOf(id);
      ids = a >= 0 && b >= 0 ? order.slice(Math.min(a, b), Math.max(a, b) + 1) : [id];
    } else ids = [id];
    if (!e.shiftKey) this.anchorId = id;
    setSymbolSelection(ed, ids, ids.includes(id) ? id : ids[ids.length - 1] || null);
    this.render();
    this.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
  }

  onKey(e) {
    const items = [...this.list.querySelectorAll('[data-id]')];
    const cur = items.indexOf(document.activeElement);
    if (cur < 0) return;
    const ed = this.editor;
    const move = (i) => {
      const t = items[Math.max(0, Math.min(items.length - 1, i))];
      items.forEach((x) => (x.tabIndex = -1));
      t.tabIndex = 0;
      t.focus();
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
        this.anchorId = t.dataset.id;
        setSymbolSelection(ed, [t.dataset.id]);
        this.render();
        this.list.querySelector(`[data-id="${CSS.escape(t.dataset.id)}"]`)?.focus();
      }
    };
    let cols = 1;
    if (this.view === 'grid' && items.length > 1) {
      const top = items[0].offsetTop;
      cols = Math.max(1, items.filter((x) => x.offsetTop === top).length);
    }
    e.stopPropagation();
    const id = items[cur].dataset.id;
    if (e.key === 'ArrowRight') move(cur + 1);
    else if (e.key === 'ArrowLeft') move(cur - 1);
    else if (e.key === 'ArrowDown') move(cur + cols);
    else if (e.key === 'ArrowUp') move(cur - cols);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === ' ') {
      const st = symbolState(ed);
      const ids = new Set(st.selected);
      if (ids.has(id) && (e.metaKey || e.ctrlKey)) ids.delete(id);
      else ids.add(id);
      setSymbolSelection(ed, e.metaKey || e.ctrlKey ? [...ids] : [id], id);
      this.render();
      this.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
    } else if (e.key === 'Enter') {
      setSymbolSelection(ed, [id]);
      // Enter places the symbol; Alt+Enter opens it for editing.
      this.run(e.altKey ? 'symbol.edit' : 'symbol.place', { id });
    } else if (e.key === 'F2') this.run('symbol.options', { id });
    else if (e.key === 'Delete' || e.key === 'Backspace') this.run('symbol.delete');
    else return;
    e.preventDefault();
  }

  /** Save the selected symbols (or all) as a user-defined library. */
  saveLibrary() {
    const ed = this.editor;
    if (!ed) return null;
    const doc = ed.doc;
    const st = symbolState(ed);
    const defs = symbolDefs(doc);
    const picked = defs.filter((d) => st.selected.has(d.id));
    const items = exportSymbolsFor(doc, (picked.length ? picked : defs).map((d) => ({ type: 'instance', symbol: d.id })));
    return saveLibraryDialog(this.app, 'symbols', { title: 'Save Symbol Library', items: structuredClone(items), defaultName: 'My Symbols' });
  }

  /** Add a saved library's symbols to the document. */
  openUserLibrary(lib) {
    const ed = this.editor;
    if (!ed) return;
    let map = null;
    ed.doc.transact('Add Symbols', () => (map = importSymbols(ed.doc, structuredClone(lib.items))));
    const ids = [...new Set(map.values())];
    setSymbolSelection(ed, ids);
    this.app.notify(`Added ${lib.name} (${ids.length} ${ids.length === 1 ? 'symbol' : 'symbols'}) to Symbols.`, { polite: true });
  }

  menu() {
    return [
      'symbol.new',
      'symbol.redefine',
      'symbol.duplicate',
      'symbol.delete',
      'symbol.edit',
      '-',
      'symbol.place',
      'symbol.replace',
      'symbol.breakLink',
      'symbol.reset',
      '-',
      'symbol.selectUnused',
      'symbol.selectInstances',
      '-',
      'symbol.sortByName',
      '-',
      ...VIEWS.map((v) => ({ label: v.label, checked: this.view === v.id, run: () => this.setView(v.id) })),
      '-',
      'symbol.options',
      '-',
      {
        label: 'Open Symbol Library',
        submenu: [
          ...SYMBOL_LIBRARIES.map((lib) => ({ label: lib.name, run: () => openSymbolLibrary(this.app, lib.id) })),
          '-',
          { label: 'User Defined', submenu: userLibraryMenu(this.app, 'symbols', (l) => this.openUserLibrary(l)) },
        ],
      },
      { label: 'Save Symbol Library...', enabled: Boolean(this.editor && symbolDefs(this.editor.doc).length), run: () => this.saveLibrary() },
    ];
  }

  openLibraries(anchor) {
    this.app.showMenuAt(
      anchor,
      SYMBOL_LIBRARIES.map((lib) => ({ label: lib.name, run: () => openSymbolLibrary(this.app, lib.id) })),
      'Symbol libraries',
    );
  }
}
