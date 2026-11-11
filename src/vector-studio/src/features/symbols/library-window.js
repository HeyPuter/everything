/**
 * Symbol library window: a floating, non-modal panel showing one or more
 * symbol libraries as tabs. Click a symbol to choose it, double-click (or
 * Place) to place an instance in the middle of the view, drag it onto the
 * canvas to place it there, or add it to the document's Symbols panel.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { SYMBOL_LIBRARIES, findLibrary, ensureLibrarySymbol } from './libraries.js';
import { placeInstance, masterBounds } from './model.js';
import { setSymbolSelection } from './state.js';
import { dragToCanvas } from './drag.js';

const escapeXml = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let win = null;

/** Inline SVG preview of a library symbol (crisp at any size). */
export function librarySymbolSVG(sym, size) {
  const parts = sym.parts
    .map((p) => {
      const attrs = [`d="${escapeXml(p.d)}"`, `fill="${p.fill || 'none'}"`];
      if (p.rule) attrs.push(`fill-rule="${p.rule}"`);
      if (p.stroke) attrs.push(`stroke="${p.stroke}" stroke-width="${p.width || 2}" stroke-linecap="${p.cap || 'butt'}" stroke-linejoin="${p.join || 'miter'}"`);
      return `<path ${attrs.join(' ')}/>`;
    })
    .join('');
  const el = h('span.sym-lib-thumb', { 'aria-hidden': 'true' });
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 68 68" width="${size}" height="${size}">${parts}</svg>`;
  return el;
}

/** Add a library symbol to the active document and place it (at a point, or centered in the view). */
export function placeLibrarySymbol(app, lib, sym, point = null) {
  const ed = app.editor;
  if (!ed) return null;
  const doc = ed.doc;
  const layer = ed.targetLayer();
  if (!layer || doc.isLocked(layer.id) || doc.isHidden(layer.id)) {
    app.notify('Unlock or show the layer to place the symbol.', { error: true });
    return null;
  }
  let inst = null;
  doc.transact('Place Symbol Instance', () => {
    const def = ensureLibrarySymbol(doc, lib, sym);
    let p = point;
    if (!p) {
      const c = ed.view.toDoc(ed.view.width / 2, ed.view.height / 2);
      const b = masterBounds(doc, def);
      p = b ? { x: c.x + def.symbolDef.reg.x - (b.x + b.w / 2), y: c.y + def.symbolDef.reg.y - (b.y + b.h / 2) } : c;
    }
    const t = ed.drawTarget();
    inst = placeInstance(doc, def.id, t.parentId, p.x, p.y, t.index);
    setSymbolSelection(ed, [def.id]);
  });
  ed.select([inst.id]);
  return inst;
}

export function addLibrarySymbols(app, lib, syms) {
  const ed = app.editor;
  if (!ed || !syms.length) return [];
  const ids = [];
  ed.doc.transact('Add Symbols', () => {
    for (const s of syms) ids.push(ensureLibrarySymbol(ed.doc, lib, s).id);
  });
  setSymbolSelection(ed, ids);
  return ids;
}

export function closeSymbolLibraries() {
  if (!win) return;
  win.el.remove();
  document.removeEventListener('keydown', win.onKey, true);
  win = null;
}

/** Open (or bring forward) a symbol library. */
export function openSymbolLibrary(app, libId) {
  const lib = findLibrary(libId);
  if (!lib) return null;
  if (!win) win = createWindow(app);
  if (!win.open.includes(lib.id)) win.open.push(lib.id);
  win.current = lib.id;
  win.selected = new Set();
  win.render();
  win.el.hidden = false;
  win.grid.querySelector('[data-id]')?.focus();
  return win;
}

function createWindow(app) {
  const state = { open: [], current: null, selected: new Set(), query: '' };
  const tabs = h('div.sym-lib-tabs', { role: 'tablist', 'aria-label': 'Open libraries' });
  const close = h('button.icon-btn', { type: 'button', 'aria-label': 'Close symbol libraries', 'data-tip': 'Close', onclick: () => closeSymbolLibraries() }, icon('x', 14));
  const header = h('div.sym-lib-header', tabs, close);
  const search = h('input.sym-search', { type: 'search', placeholder: 'Search library', 'aria-label': 'Search library' });
  const grid = h('div.sym-lib-grid', { role: 'listbox', 'aria-label': 'Library symbols', 'aria-multiselectable': 'true', id: 'sym-lib-grid' });
  const prev = h('button.icon-btn', { type: 'button', 'aria-label': 'Previous library', 'data-tip': 'Previous library', onclick: () => step(-1) }, icon('chevron-left', 14));
  const next = h('button.icon-btn', { type: 'button', 'aria-label': 'Next library', 'data-tip': 'Next library', onclick: () => step(1) }, icon('chevron-right', 14));
  const addBtn = h('button.btn.small', { type: 'button', onclick: () => addLibrarySymbols(app, cur(), chosen()) }, 'Add to Symbols');
  const placeBtn = h('button.btn.small.primary', { type: 'button', onclick: () => chosen().forEach((s) => placeLibrarySymbol(app, cur(), s)) }, 'Place');
  const el = h(
    'div.sym-lib-window',
    { role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Symbol Libraries' },
    header,
    h('div.sym-lib-bar', prev, search, next),
    grid,
    h('p.sym-lib-hint', 'Drag a symbol onto the canvas, or double-click to place it.'),
    h('div.sym-lib-actions', addBtn, placeBtn),
  );
  const cur = () => findLibrary(state.current);
  const chosen = () => cur().symbols.filter((s) => state.selected.has(s.id));
  const step = (d) => {
    const i = SYMBOL_LIBRARIES.findIndex((l) => l.id === state.current);
    const lib = SYMBOL_LIBRARIES[(i + d + SYMBOL_LIBRARIES.length) % SYMBOL_LIBRARIES.length];
    openSymbolLibrary(app, lib.id);
  };
  search.addEventListener('input', () => {
    state.query = search.value.trim().toLowerCase();
    render();
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  grid.addEventListener('keydown', (e) => {
    const items = [...grid.querySelectorAll('[data-id]')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.stopPropagation();
    const top = items[0].offsetTop;
    const cols = Math.max(1, items.filter((x) => x.offsetTop === top).length);
    const go = (j) => {
      const t = items[Math.max(0, Math.min(items.length - 1, j))];
      items.forEach((x) => (x.tabIndex = -1));
      t.tabIndex = 0;
      t.focus();
    };
    const id = items[i].dataset.id;
    if (e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'ArrowDown') go(i + cols);
    else if (e.key === 'ArrowUp') go(i - cols);
    else if (e.key === ' ') {
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      render();
      grid.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
    } else if (e.key === 'Enter') placeLibrarySymbol(app, cur(), cur().symbols.find((s) => s.id === id));
    else return;
    e.preventDefault();
  });
  const onKey = (e) => {
    if (e.key === 'Escape' && el.contains(document.activeElement)) {
      e.stopPropagation();
      closeSymbolLibraries();
      app.canvasHost?.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);

  // Drag the window by its header (not on phones, where it is a bottom sheet).
  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || (typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px)').matches)) return;
    const r = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    const move = (ev) => {
      el.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, start.left + ev.clientX - start.x))}px`;
      el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, start.top + ev.clientY - start.y))}px`;
      el.style.right = 'auto';
    };
    const up = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
    };
    try {
      header.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer.
    }
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
  });

  function render() {
    const lib = cur();
    tabs.replaceChildren(
      ...state.open.map((id) => {
        const l = findLibrary(id);
        const active = id === state.current;
        const tab = h(
          'div.sym-lib-tab',
          h('button.sym-lib-tab-btn', { type: 'button', role: 'tab', 'aria-selected': String(active), 'aria-controls': 'sym-lib-grid', onclick: () => openSymbolLibrary(app, id) }, l.name),
          h('button.icon-btn.sym-lib-tab-close', {
            type: 'button',
            'aria-label': `Close ${l.name}`,
            onclick: () => {
              state.open = state.open.filter((x) => x !== id);
              if (!state.open.length) closeSymbolLibraries();
              else {
                if (state.current === id) state.current = state.open[state.open.length - 1];
                render();
              }
            },
          }, icon('x', 10)),
        );
        tab.classList.toggle('active', active);
        return tab;
      }),
    );
    const shown = state.query ? lib.symbols.filter((s) => s.name.toLowerCase().includes(state.query)) : lib.symbols;
    grid.setAttribute('aria-label', `${lib.name} symbols`);
    grid.replaceChildren(
      ...shown.map((s, i) => {
        const item = h('div.sym-item.sym-lib-item', { role: 'option', tabindex: i === 0 ? '0' : '-1', 'aria-selected': String(state.selected.has(s.id)), 'aria-label': s.name, 'data-id': s.id, 'data-tip': s.name }, librarySymbolSVG(s, 40));
        item.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            if (state.selected.has(s.id)) state.selected.delete(s.id);
            else state.selected.add(s.id);
          } else state.selected = new Set([s.id]);
          render();
          grid.querySelector(`[data-id="${CSS.escape(s.id)}"]`)?.focus();
        });
        item.addEventListener('dblclick', () => placeLibrarySymbol(app, lib, s));
        item.addEventListener('pointerdown', (e) => dragToCanvas(app, item, e, { preview: () => librarySymbolSVG(s, 40), onDrop: (p) => placeLibrarySymbol(app, lib, s, p) }));
        return item;
      }),
    );
    if (!shown.length) grid.append(h('p.panel-empty', 'No symbols match.'));
    addBtn.disabled = placeBtn.disabled = !state.selected.size;
  }

  document.body.append(el);
  return Object.assign(state, { el, grid, render, onKey });
}
