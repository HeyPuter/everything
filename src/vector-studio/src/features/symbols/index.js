/**
 * Symbols feature: symbol definitions and live instances (model.js),
 * editing symbols in place (editing.js), the Symbols panel, symbol
 * libraries, the symbolism tools, the Properties section for instances,
 * recoloring parts of dynamic instances, and carrying symbols through the
 * clipboard.
 */
import './styles.css';
import { PropertiesPanel } from '../../ui/panels/properties.js';
import { clipboardHooks } from '../../ops/clipboard.js';
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { registerSymbolIcons } from './icons.js';
import { SymbolsPanel } from './panel.js';
import { SYMBOLISM_TOOLS } from './tools.js';
import { registerSymbolCommands } from './commands.js';
import { installParts } from './parts.js';
import { symbolSection } from './props-section.js';
import { SYMBOL_LIBRARIES } from './libraries.js';
import { openSymbolLibrary } from './library-window.js';
import { userLibraryMenu } from '../paint/user-libraries.js';
import { exportSymbolsFor, importSymbols, remapInstances, indexSymbolNames, getDef, masterBounds, updateDefinition } from './model.js';
import { syncSymbolEditing, editingSymbol } from './editing.js';
import { importedSymbolGroups, convertImportedSymbols } from './svg-symbols.js';

export function install(app) {
  registerSymbolIcons();
  app.registerPanel(SymbolsPanel);
  for (const T of SYMBOLISM_TOOLS) app.registerTool(T);
  registerSymbolCommands(app);
  installParts(app);
  if (!PropertiesPanel.extraSections.some((s) => s.id === 'symbol')) PropertiesPanel.extraSections.push(symbolSection(app));
  app.menuSources.set('symbolLibraries', (a) => [
    ...SYMBOL_LIBRARIES.map((lib) => ({ label: lib.name, run: () => openSymbolLibrary(a, lib.id) })),
    '-',
    {
      label: 'User Defined',
      submenu: userLibraryMenu(a, 'symbols', (l) => {
        a.openPanel('symbols');
        a.dock.panels.get('symbols')?.openUserLibrary(l);
      }),
    },
  ]);

  installClipboardHooks();

  // Each document: keep symbol names for labels and the editing mode in step with the document.
  const wired = new WeakSet();
  const wire = (ed) => {
    if (!ed || wired.has(ed)) return;
    wired.add(ed);
    const doc = ed.doc;
    // A document opened from SVG turns its <symbol> uses into symbols as part of opening.
    if (!doc.undoStack.length && importedSymbolGroups(doc).length) {
      const clean = !doc.dirty;
      doc.transact('Make Symbols', () => convertImportedSymbols(doc));
      doc.undoStack.length = 0;
      if (clean) doc.markSaved();
    }
    indexSymbolNames(doc);
    doc.on('change', (e) => {
      if (!e.commit) return;
      indexSymbolNames(doc);
      syncSymbolEditing(app, ed);
      // SVG pasted or placed with <symbol> uses: make symbols of them right after.
      if (e.structural && !e.undo && e.ids) {
        const marked = importedSymbolGroups(doc, e.ids);
        if (marked.length) queueMicrotask(() => !doc.tx && doc.transact('Make Symbols', () => convertImportedSymbols(doc, importedSymbolGroups(doc, marked))));
      }
    });
    ed.on('symbols', () => app.dock?.update());
    syncSymbolEditing(app, ed);
  };
  app.on('active-editor', wire);
  if (app.editor) wire(app.editor);

  // The isolation bar names the symbol being edited.
  app.on('chrome', () => {
    const ed = app.editor;
    const bar = app.isolationBar;
    const sym = editingSymbol(ed);
    bar?.classList.toggle('symbol-edit', Boolean(sym));
    if (!sym || !bar) return;
    const label = bar.querySelector('span');
    if (label) label.replaceChildren(icon('symbol', 13), h('span', `Editing symbol: ${getDef(ed.doc, sym)?.name || 'Symbol'}`));
  });

  installCanvasDrop(app);
  installSliceGuides(app);
}

let clipboardHooked = false;

/** Copy carries the definitions of copied instances; paste adds the missing ones. */
function installClipboardHooks() {
  if (clipboardHooked) return;
  clipboardHooked = true;
  clipboardHooks.push({
    copy(doc, ids, data) {
      const nodes = data.items.flatMap((it) => it.nodes);
      const symbols = exportSymbolsFor(doc, nodes);
      if (symbols.length) data.symbols = symbols;
    },
    paste(doc, data, items) {
      if (!data.symbols?.length) return items;
      const map = importSymbols(doc, data.symbols);
      return items.map((it) => ({ ...it, nodes: remapInstances(it.nodes, map) }));
    },
  });
}

/** Dragging artwork from the canvas onto the Symbols panel makes a symbol of it. */
function installCanvasDrop(app) {
  let over = false;
  const panel = () => app.dock?.panels.get('symbols');
  const movingTool = () => {
    const t = app.input?.active?.tool || app.tool;
    const d = t?.drag;
    return d && d.kind === 'move' && d.session ? t : null;
  };
  const setOver = (on) => {
    if (on === over) return;
    over = on;
    panel()?.setDropHighlight(on);
  };
  window.addEventListener('pointermove', (e) => setOver(Boolean(movingTool() && panel()?.isDropTarget(e.clientX, e.clientY))), true);
  window.addEventListener(
    'pointerup',
    (e) => {
      if (!over) return;
      setOver(false);
      const t = movingTool();
      if (!t || !panel()?.isDropTarget(e.clientX, e.clientY)) return;
      // The move is undone; the artwork becomes a symbol where it was.
      t.cancel();
      app.commands.run('symbol.new');
    },
    true,
  );
}

/**
 * While editing a symbol with 9-slice guides, the guides can be dragged
 * with the selection tools.
 */
function installSliceGuides(app) {
  const SLOP = 4;
  let drag = null;
  const guideAt = (e) => {
    const ed = app.editor;
    const sym = editingSymbol(ed);
    if (!sym || !['selection', 'direct-selection', 'group-selection'].includes(app.toolId)) return null;
    const def = getDef(ed.doc, sym);
    const g = def?.symbolDef.slice9;
    if (!g) return null;
    const r = app.canvasHost.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const a = ed.view.toScreen(g.x, g.y);
    const b = ed.view.toScreen(g.x + g.w, g.y + g.h);
    const hits = [
      ['left', Math.abs(sx - a.x)],
      ['right', Math.abs(sx - b.x)],
      ['top', Math.abs(sy - a.y)],
      ['bottom', Math.abs(sy - b.y)],
    ].filter(([, d]) => d <= SLOP);
    if (!hits.length) return null;
    hits.sort((p, q) => p[1] - q[1]);
    return { def, edge: hits[0][0] };
  };
  const host = () => app.canvasHost;
  const onDown = (e) => {
    if (e.button !== 0 || !app.editor) return;
    const hit = guideAt(e);
    if (!hit) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const doc = app.editor.doc;
    drag = { ...hit, tx: doc.begin('Move 9-Slice Guide'), bounds: masterBounds(doc, hit.def) };
    try {
      host().setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer.
    }
  };
  const onMove = (e) => {
    if (!drag) {
      if (!e.buttons && app.editor && guideAt(e)) {
        const hit = guideAt(e);
        app.setCanvasCursor(hit.edge === 'left' || hit.edge === 'right' ? 'col-resize' : 'row-resize');
        e.stopImmediatePropagation();
      }
      return;
    }
    e.stopImmediatePropagation();
    const ed = app.editor;
    const r = host().getBoundingClientRect();
    const p = ed.view.toDoc(e.clientX - r.left, e.clientY - r.top);
    const def = getDef(ed.doc, drag.def.id);
    const g = { ...def.symbolDef.slice9 };
    const b = drag.bounds || g;
    const x2 = g.x + g.w;
    const y2 = g.y + g.h;
    const clampX = (v) => Math.max(b.x, Math.min(b.x + b.w, v));
    const clampY = (v) => Math.max(b.y, Math.min(b.y + b.h, v));
    if (drag.edge === 'left') Object.assign(g, { x: Math.min(clampX(p.x), x2), w: x2 - Math.min(clampX(p.x), x2) });
    if (drag.edge === 'right') g.w = Math.max(g.x, clampX(p.x)) - g.x;
    if (drag.edge === 'top') Object.assign(g, { y: Math.min(clampY(p.y), y2), h: y2 - Math.min(clampY(p.y), y2) });
    if (drag.edge === 'bottom') g.h = Math.max(g.y, clampY(p.y)) - g.y;
    updateDefinition(ed.doc, def.id, { slice9: g });
    ed.emit('overlay');
  };
  const onUp = (e) => {
    if (!drag) return;
    e.stopImmediatePropagation();
    const d = drag;
    drag = null;
    if (app.editor?.doc.tx === d.tx) d.tx.commit();
  };
  app.on('started', () => {
    host().addEventListener('pointerdown', onDown, true);
    host().addEventListener('pointermove', onMove, true);
    host().addEventListener('pointerup', onUp, true);
  });
}
