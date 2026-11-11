/**
 * Pattern swatches: pattern paints for fills and strokes, Object > Pattern
 * (Make, Edit Pattern, Tile Edge Color), pattern editing mode with the
 * Pattern Options panel and the Pattern Tile tool, pattern swatch
 * libraries, and moving patterns inside objects (Transform Patterns, or
 * dragging with the ` key held to move only the pattern).
 *
 * Interfaces for other modules:
 *   app.patterns.ensureDef(doc, def)   add a library definition to a document (in a transaction)
 *   app.patterns.isEditing(editor)
 */
import './styles.css';
import { h } from '../../lib/dom.js';
import { registerIcons, icon } from '../../ui/icons.js';
import { drawNode } from '../../render/draw.js';
import { viewHooks } from '../../render/canvas-view.js';
import { overlayHooks } from '../../render/overlay.js';
import { paintCssHooks } from '../../ui/widgets.js';
import { commonStyle } from '../../ops/paint-ops.js';
import { findSwatch } from '../paint/swatch-model.js';
import { SWATCH_LIBRARIES } from '../paint/swatch-libraries.js';
import { findPattern, addPattern, previewCopies, patternsOf, patternClipboardHook } from './model.js';
import { clipboardHooks } from '../../ops/clipboard.js';
import { patternCss, rememberPatterns } from './render.js';
import { editLayer, editDef, makePattern, editPattern, finishEditing, cancelEditing, savePatternCopy, syncEditing } from './edit.js';
import { PatternOptionsPanel } from './panel.js';
import { PatternTileTool, drawTileOverlay } from './tile-tool.js';
import { patternLibraries } from './libraries.js';

const R = (x, y, w, h, extra = {}) => ['rect', { x: String(x), y: String(y), width: String(w), height: String(h), ...extra }];
const P = (d, extra = {}) => ['path', { d, ...extra }];
const F = (d) => ['path', { d, fill: 'currentColor', stroke: 'none' }];

registerIcons({
  'pattern-swatch': [R(3, 3, 18, 18, { rx: '2' }), F('M7 6.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM17 6.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM12 11a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM7 15a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3zM17 15a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3z')],
  'pattern-options': [R(3, 3, 8, 8), R(13, 3, 8, 8, { 'stroke-dasharray': '2 2' }), R(3, 13, 8, 8, { 'stroke-dasharray': '2 2' }), R(13, 13, 8, 8, { 'stroke-dasharray': '2 2' }), F('M5.5 5.5h3v3h-3z')],
  'pattern-tile-tool': [R(6, 6, 12, 12), P('M3 6h3M3 18h3M18 3v3M6 3v3M21 18h-3M21 6h-3M18 21v-3M6 21v-3'), F('M10.5 10.5h3v3h-3z')],
  'overlap-left': [R(10, 6, 11, 11, { rx: '1', 'stroke-dasharray': '2 2' }), ['rect', { x: '3', y: '7', width: '11', height: '11', rx: '1', fill: 'currentColor', 'fill-opacity': '0.35' }]],
  'overlap-right': [R(3, 6, 11, 11, { rx: '1', 'stroke-dasharray': '2 2' }), ['rect', { x: '10', y: '7', width: '11', height: '11', rx: '1', fill: 'currentColor', 'fill-opacity': '0.35' }]],
  'overlap-top': [R(6, 10, 11, 11, { rx: '1', 'stroke-dasharray': '2 2' }), ['rect', { x: '7', y: '3', width: '11', height: '11', rx: '1', fill: 'currentColor', 'fill-opacity': '0.35' }]],
  'overlap-bottom': [R(6, 3, 11, 11, { rx: '1', 'stroke-dasharray': '2 2' }), ['rect', { x: '7', y: '10', width: '11', height: '11', rx: '1', fill: 'currentColor', 'fill-opacity': '0.35' }]],
});

export const TILE_EDGE_DEFAULT = '#3c8cff';

/** The pattern the Edit Pattern command acts on: an argument, the selected swatch, or the selection's paint. */
function editTarget(app, args) {
  const ed = app.editor;
  if (!ed) return null;
  const doc = ed.doc;
  if (args?.patternId) return findPattern(doc, args.patternId) ? args.patternId : null;
  const sp = app.dock?.panels.get('swatches');
  if (sp?.selected?.size === 1) {
    const sw = findSwatch(doc, [...sp.selected][0]);
    if (sw?.paint?.type === 'pattern' && findPattern(doc, sw.paint.id)) return sw.paint.id;
  }
  if (ed.selection.size) {
    for (const key of [ed.focusPaint, ed.focusPaint === 'fill' ? 'stroke' : 'fill']) {
      const p = commonStyle(ed, key);
      if (p && p !== 'mixed' && p.type === 'pattern' && findPattern(doc, p.id)) return p.id;
    }
  }
  return null;
}

function installCommands(app) {
  const editing = (a) => Boolean(a.editor && editLayer(a.editor.doc));
  app.commands.register([
    { id: 'pattern.make', label: 'Make', enabled: (a) => Boolean(a.editor) && !editing(a), run: (a) => makePattern(a, a.editor) },
    { id: 'pattern.edit', label: 'Edit Pattern', enabled: (a, args) => !editing(a) && Boolean(editTarget(a, args)), run: (a, args) => editPattern(a, a.editor, editTarget(a, args)) },
    {
      id: 'pattern.tileEdgeColor',
      label: 'Tile Edge Color...',
      run: async (a) => {
        const v = await a.dialogs.form({ title: 'Tile Edge Color', fields: [{ key: 'color', label: 'Tile edge color', type: 'color', value: a.prefs.get('patternTileEdgeColor') || TILE_EDGE_DEFAULT }] });
        if (!v) return;
        a.prefs.set('patternTileEdgeColor', v.color);
        a.editor?.emit('overlay');
      },
    },
    { id: 'pattern.done', label: 'Done', enabled: editing, run: (a) => finishEditing(a, a.editor) },
    { id: 'pattern.cancel', label: 'Cancel Pattern Editing', enabled: editing, run: (a) => cancelEditing(a, a.editor) },
    {
      id: 'pattern.saveCopy',
      label: 'Save a Copy...',
      enabled: editing,
      run: async (a) => {
        const layer = editLayer(a.editor.doc);
        const v = await a.dialogs.form({ title: 'Save a Copy', description: 'The copy is added to Swatches; you keep editing the current pattern.', fields: [{ key: 'name', label: 'Name', type: 'text', value: `${layer.pattern.name} copy` }] });
        if (!v) return;
        savePatternCopy(a, a.editor, v.name.trim() || undefined);
        a.notify(`Saved "${v.name.trim() || 'pattern copy'}" to Swatches.`, { polite: true });
      },
    },
  ]);
  // Esc and Exit Isolation Mode finish pattern editing (inside a group in the tile they step back out first).
  const exitIso = app.commands.get('object.exitIsolation');
  if (exitIso) {
    app.commands.register({
      ...exitIso,
      run: (a, args) => {
        const ed = a.editor;
        const layer = ed && editLayer(ed.doc);
        if (!layer) return exitIso.run(a, args);
        if (ed.isolation && ed.isolation !== layer.id) {
          ed.isolation = layer.id;
          ed.clearSelection();
          ed.emit('isolation');
          ed.invalidate();
          return undefined;
        }
        return finishEditing(a, ed);
      },
    });
  }
}

/** The bar above the canvas in pattern editing mode. */
function installEditBar(app) {
  let bar = null;
  const render = () => {
    const ed = app.editor;
    const layer = ed ? editLayer(ed.doc) : null;
    app.root.classList.toggle('pattern-editing', Boolean(layer));
    if (!bar) {
      if (!app.isolationBar) return;
      bar = h('div.pattern-bar', { role: 'toolbar', 'aria-label': 'Pattern editing', hidden: true });
      app.isolationBar.after(bar);
    }
    bar.hidden = !layer;
    if (!layer) return;
    bar.replaceChildren(
      h('button.icon-btn', { type: 'button', 'aria-label': 'Done Editing Pattern', 'data-tip': 'Done Editing Pattern (Esc)', onclick: () => app.commands.run('pattern.done') }, icon('chevron-left', 14)),
      icon('pattern-swatch', 14),
      h('span.pattern-bar-name', layer.pattern.name || 'Pattern'),
      h('span.pattern-bar-spacer'),
      h('button.btn.small', { type: 'button', onclick: () => app.commands.run('pattern.saveCopy') }, 'Save a Copy'),
      h('button.btn.small', { type: 'button', onclick: () => app.commands.run('pattern.cancel') }, 'Cancel'),
      h('button.btn.small.primary', { type: 'button', onclick: () => app.commands.run('pattern.done') }, 'Done'),
    );
  };
  app.on('chrome', render);
  app.on('started', render);
}

/** Canvas: hide the rest of the document while editing and draw the copies around the tile. */
function installViewHooks(app) {
  viewHooks.artOptions.push((editor, opts) => {
    const layer = editLayer(editor.doc);
    if (!layer) return opts;
    const prev = opts.layerFilter;
    return { ...opts, layerFilter: (l) => l.id === layer.id && (!prev || prev(l)) };
  });
  // The editing layer is shown without the isolation fade (the copies are dimmed instead).
  viewHooks.dimIsolation.push((editor) => !editLayer(editor.doc));
  viewHooks.afterArt.push((ctx, editor, view, artOpts) => {
    const doc = editor.doc;
    const layer = editLayer(doc);
    if (!layer || !layer.children.length) return;
    const p = layer.pattern;
    const def = editDef(doc, layer);
    const copies = previewCopies(def, p.copies);
    const alpha = p.dimCopies ? Math.max(0.05, Math.min(1, (p.dim ?? 70) / 100)) : 1;
    const kids = layer.children.map((id) => doc.get(id)).filter((n) => n && !n.hidden);
    const opts = { ...(artOpts || {}), viewRect: null, leafFilter: null, layerFilter: null };
    const vis = view.visibleRect(4);
    copies.forEach((c, i) => {
      // drawArtwork drew the art itself; it is drawn again in overlap order when copies come before it.
      if (c.center && i === 0) return;
      ctx.save();
      ctx.globalAlpha = c.center ? 1 : alpha;
      ctx.translate(c.dx, c.dy);
      const rect = { x: vis.x - c.dx, y: vis.y - c.dy, w: vis.w, h: vis.h };
      for (const n of kids) drawNode(ctx, doc, n, { ...opts, viewRect: rect });
      ctx.restore();
    });
  });
  overlayHooks.add((ctx, editor) => drawTileOverlay(ctx, editor, app.prefs.get('patternTileEdgeColor') || TILE_EDGE_DEFAULT));
}

/** Holding ` while dragging moves only the patterns inside the selected objects. */
function installPatternKey(app) {
  const setKey = (down) => {
    for (const ed of app.editors) ed.patternsOnly = down;
  };
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target;
      if (t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName)) return;
      setKey(true);
    }
  });
  document.addEventListener('keyup', (e) => e.code === 'Backquote' && setKey(false));
  window.addEventListener('blur', () => setKey(false));
}

export function install(app) {
  paintCssHooks.pattern = (paint) => patternCss(paint, app.editor?.doc);

  app.patterns = {
    ensureDef(doc, def) {
      if (!findPattern(doc, def.id)) addPattern(doc, structuredClone(def));
    },
    isEditing: (editor) => Boolean(editor && editLayer(editor.doc)),
    libraries: patternLibraries,
  };
  const prevExtra = app.extraSwatchLibraries;
  app.extraSwatchLibraries = () => [...(prevExtra?.() || []), ...patternLibraries()];

  // Pasting into another document brings the pattern definitions along.
  if (!clipboardHooks.includes(patternClipboardHook)) clipboardHooks.push(patternClipboardHook);

  app.registerPanel(PatternOptionsPanel);
  app.registerTool(PatternTileTool);
  installCommands(app);
  installEditBar(app);
  installViewHooks(app);
  installPatternKey(app);

  // Swatch previews look definitions up by id; keep them current for the active document.
  const remember = (ed) => ed && rememberPatterns(patternsOf(ed.doc));
  app.on('active-editor', (ed) => {
    remember(ed);
    if (ed) syncEditing(app, ed);
  });
  app.on('chrome', () => remember(app.editor));
  const wired = new WeakSet();
  const wire = (ed) => {
    if (!ed || wired.has(ed)) return;
    wired.add(ed);
    let patterns = null;
    ed.on('doc-change', () => {
      if (ed.doc.root.patterns !== patterns) {
        patterns = ed.doc.root.patterns;
        rememberPatterns(patterns);
      }
      syncEditing(app, ed);
    });
    syncEditing(app, ed);
  };
  app.on('active-editor', wire);

  // Window > Swatch Libraries lists the color and pattern libraries (opened from the Swatches panel).
  if (!app.menuSources.has('swatchLibraries')) {
    app.menuSources.set('swatchLibraries', (a) => {
      const libs = [...SWATCH_LIBRARIES, ...patternLibraries()];
      return libs.map((lib) => ({
        label: lib.name,
        run: () => {
          a.openPanel('swatches');
          const panel = a.dock.panels.get('swatches');
          const anchor = panel?.el.querySelector('.sw-footer .icon-btn') || panel?.el;
          if (panel?.openLibrary && anchor) panel.openLibrary(anchor, lib);
        },
      }));
    });
  }
}
