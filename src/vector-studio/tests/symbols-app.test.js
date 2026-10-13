import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { liveArtwork } from '../src/model/live.js';
import { applyStyle, commonStyle } from '../src/ops/paint-ops.js';
import { resolveItems } from '../src/ui/menubar.js';
import { MENUS, CONTEXT_MENU } from '../src/ui/menus.js';
import { symbolDefs, getDef, STORE_ID, instancesOf, isSymbolSet, editingStack } from '../src/features/symbols/model.js';
import { currentSymbol, setSymbolSelection, selectedSymbols } from '../src/features/symbols/state.js';
import { editingSymbol } from '../src/features/symbols/editing.js';
import { placeLibrarySymbol, openSymbolLibrary, closeSymbolLibraries } from '../src/features/symbols/library-window.js';
import { SYMBOL_LIBRARIES, libraryArtwork } from '../src/features/symbols/libraries.js';
import { setSymbolismOptions, falloff } from '../src/features/symbols/tools.js';

const red = { type: 'solid', color: '#ff0000' };
const green = { type: 'solid', color: '#00ff00' };

let app;

function addRect(x, y, w, h, style = {}) {
  const doc = app.editor.doc;
  const n = createPath(rectangle(x, y, w, h), true, { fill: red, stroke: null, ...style });
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  return n.id;
}

/** A tool event at a document point. */
function ev(x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: null, clicks: 1, ...extra };
}

async function makeSymbol() {
  const a = addRect(100, 100, 40, 20);
  const b = addRect(150, 100, 20, 20, { fill: { type: 'solid', color: '#0000ff' } });
  app.editor.select([a, b]);
  const out = await app.commands.run('symbol.new', { direct: true, name: 'Card' });
  return { a, b, ...out };
}

/** Click a button in the open dialog by its label. */
async function answer(label) {
  await new Promise((r) => setTimeout(r, 0));
  const btn = [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === label);
  expect(btn, `dialog button ${label}`).toBeTruthy();
  btn.click();
}

beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument({ width: 600, height: 400 });
});

afterEach(() => closeSymbolLibraries());

describe('making and placing symbols', () => {
  it('New Symbol turns the selection into an instance and selects the symbol', async () => {
    const { def, instance } = await makeSymbol();
    const ed = app.editor;
    expect([...ed.selection]).toEqual([instance.id]);
    expect(currentSymbol(ed)).toBe(def.id);
    expect(def.name).toBe('Card');
    expect(ed.doc.leaves()).toHaveLength(1);
    expect(app.commands.isEnabled('symbol.place')).toBe(true);
    // One undo step.
    ed.doc.undo();
    expect(ed.doc.leaves()).toHaveLength(2);
    expect(ed.doc.has(STORE_ID)).toBe(false);
  });

  it('New Symbol asks for options first', async () => {
    const a = addRect(0, 0, 10, 10);
    app.editor.select([a]);
    const p = app.commands.run('symbol.new');
    await new Promise((r) => setTimeout(r, 0));
    const name = document.querySelector('dialog[open] input[type="text"]');
    name.value = 'Pebble';
    document.querySelector('dialog[open] input[value="static"]').checked = true;
    await answer('OK');
    const out = await p;
    expect(out.def.name).toBe('Pebble');
    expect(out.def.symbolDef.kind).toBe('static');
  });

  it('Place Symbol Instance puts the current symbol in the middle of the view', async () => {
    const { def } = await makeSymbol();
    const ed = app.editor;
    const inst = await app.commands.run('symbol.place');
    expect(inst.symbol).toBe(def.id);
    const c = ed.view.toDoc(ed.view.width / 2, ed.view.height / 2);
    const b = nodeBounds(ed.doc, ed.doc.get(inst.id));
    expect(b.x + b.w / 2).toBeCloseTo(c.x);
    expect(b.y + b.h / 2).toBeCloseTo(c.y);
    expect([...ed.selection]).toEqual([inst.id]);
  });

  it('Break Link, Reset Transformation and Select Same Symbol Instance', async () => {
    const { instance, def } = await makeSymbol();
    const ed = app.editor;
    const second = await app.commands.run('symbol.place');
    ed.select([instance.id]);
    await app.commands.run('select.same.symbol');
    expect(new Set(ed.selection)).toEqual(new Set([instance.id, second.id]));
    ed.select([second.id]);
    ed.doc.transact('scale', () => ed.doc.update(second.id, { transform: [2, 0, 0, 2, 10, 10] }));
    expect(app.commands.isEnabled('symbol.reset')).toBe(true);
    await app.commands.run('symbol.reset');
    const t = ed.doc.get(second.id).transform;
    expect(t[0]).toBeCloseTo(1);
    expect(t[3]).toBeCloseTo(1);
    await app.commands.run('symbol.breakLink');
    expect(ed.doc.has(second.id)).toBe(false);
    expect(instancesOf(ed.doc, def.id)).toHaveLength(1);
  });

  it('the context menu offers Edit Symbol and Break Link for an instance', async () => {
    await makeSymbol();
    const labels = resolveItems(app, CONTEXT_MENU).filter((i) => i.enabled).map((i) => i.label);
    expect(labels).toContain('Edit Symbol');
    expect(labels).toContain('Break Link to Symbol');
  });

  it('Window menu lists the panel and the symbol libraries', () => {
    const win = resolveItems(app, MENUS.find((m) => m.label === 'Window').submenu);
    expect(win.some((i) => i.label === 'Symbols')).toBe(true);
    const libs = win.find((i) => i.label === 'Symbol Libraries');
    expect(libs.items.filter((i) => i.type === 'cmd').map((i) => i.label)).toEqual(SYMBOL_LIBRARIES.map((l) => l.name));
    expect(libs.items.at(-1).label).toBe('User Defined');
    expect(app.commands.get('panel.symbols').shortcut).toBe('Shift+Mod+F11');
  });
});

describe('editing a symbol', () => {
  it('opens the master in place from an instance and closes it again', async () => {
    const { instance, def, a } = await makeSymbol();
    const ed = app.editor;
    const doc = ed.doc;
    const other = await app.commands.run('symbol.place');
    const before = nodeBounds(doc, doc.get(other.id));
    await app.commands.run('symbol.edit', { id: other.id });
    expect(editingSymbol(ed)).toBe(def.id);
    expect(ed.isolation).toBe(def.id);
    // The master now sits on the page where that instance is.
    expect(doc.get(def.id).parent).toBe(doc.get(other.id).parent);
    const mb = nodeBounds(doc, doc.get(def.id));
    for (const k of ['x', 'y', 'w', 'h']) expect(mb[k]).toBeCloseTo(before[k]);
    // Nothing else moved.
    expect(nodeBounds(doc, doc.get(instance.id))).toEqual({ x: 100, y: 100, w: 70, h: 20 });
    // Edit the master: every instance follows.
    doc.transact('Recolor', () => doc.update(a, { fill: green }));
    expect(liveArtwork(doc, doc.get(instance.id)).items[0].fill).toEqual(green);
    // Select All works inside the master only.
    await app.commands.run('select.all');
    expect(new Set(ed.selection)).toEqual(new Set(doc.get(def.id).children));
    await app.commands.run('object.exitIsolation');
    expect(editingSymbol(ed)).toBeNull();
    expect(ed.isolation).toBeNull();
    expect(doc.get(def.id).parent).toBe(STORE_ID);
    expect([...ed.selection]).toEqual([other.id]);
    // Undoing the exit goes back into the symbol; undoing the entry leaves it.
    doc.undo();
    expect(editingSymbol(ed)).toBe(def.id);
    doc.undo(); // recolor
    doc.undo(); // enter
    expect(editingSymbol(ed)).toBeNull();
    expect(doc.get(def.id).parent).toBe(STORE_ID);
    expect(liveArtwork(doc, doc.get(instance.id)).items[0].fill).toEqual(red);
  });

  it('double-clicking an instance with the Selection tool edits it, Escape ends editing', async () => {
    const { instance, def } = await makeSymbol();
    app.setTool('selection');
    app.tool.onDoubleClick(ev(110, 110));
    expect(editingSymbol(app.editor)).toBe(def.id);
    document.querySelector('.canvas-host').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(editingSymbol(app.editor)).toBeNull();
    expect(app.editor.doc.has(instance.id)).toBe(true);
  });

  it('opens from the panel without an instance', async () => {
    const { def } = await makeSymbol();
    app.editor.clearSelection();
    await app.commands.run('symbol.edit', { id: def.id });
    expect(editingSymbol(app.editor)).toBe(def.id);
    expect(app.editor.doc.get(def.id).parent).toBe(app.editor.doc.layers()[0].id);
    expect(app.commands.isEnabled('symbol.delete')).toBe(false);
    await app.commands.run('symbol.exitEdit');
    expect(editingStack(app.editor.doc)).toEqual([]);
  });
});

describe('Direct Selection on dynamic instances', () => {
  it('recolors one part without changing the symbol', async () => {
    const { instance, a, b } = await makeSymbol();
    const ed = app.editor;
    app.setTool('direct-selection');
    app.tool.onPointerDown(ev(110, 110));
    app.tool.onPointerUp(ev(110, 110));
    expect([...ed.symbolParts.parts]).toEqual([a]);
    expect(commonStyle(ed, 'fill')).toEqual(red);
    applyStyle(ed, { fill: green });
    const inst = ed.doc.get(instance.id);
    expect(inst.overrides[a].fill).toEqual(green);
    expect(ed.doc.get(a).fill).toEqual(red);
    expect(commonStyle(ed, 'fill')).toEqual(green);
    // Shift adds the other part.
    app.tool.onPointerDown(ev(160, 110, { shift: true }));
    expect(new Set(ed.symbolParts.parts)).toEqual(new Set([a, b]));
    expect(commonStyle(ed, 'fill')).toBe('mixed');
    // Choosing another tool ends part selection.
    app.setTool('selection');
    expect(ed.symbolParts).toBeNull();
    ed.doc.undo();
    expect(ed.doc.get(instance.id).overrides).toBeUndefined();
  });
});

describe('Symbols panel', () => {
  it('lists symbols, filters, switches views and selects', async () => {
    const { def } = await makeSymbol();
    app.openPanel('symbols');
    const panel = app.dock.panels.get('symbols');
    panel.update();
    const items = () => [...panel.el.querySelectorAll('.sym-item')];
    expect(items()).toHaveLength(1);
    expect(items()[0].getAttribute('aria-selected')).toBe('true');
    expect(items()[0].classList.contains('used')).toBe(true);
    panel.setView('large');
    expect(panel.el.querySelector('.sym-meta').textContent).toContain('1 instance');
    panel.search.value = 'zzz';
    panel.search.dispatchEvent(new Event('input'));
    expect(items()).toHaveLength(0);
    panel.search.value = 'car';
    panel.search.dispatchEvent(new Event('input'));
    expect(items()).toHaveLength(1);
    setSymbolSelection(app.editor, []);
    items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(selectedSymbols(app.editor)).toEqual([def.id]);
  });

  it('deleting a symbol in use asks what to do with its instances', async () => {
    const { def, instance } = await makeSymbol();
    const doc = app.editor.doc;
    setSymbolSelection(app.editor, [def.id]);
    const p = app.commands.run('symbol.delete');
    await answer('Expand Instances');
    await p;
    expect(getDef(doc, def.id)).toBeNull();
    expect(doc.has(instance.id)).toBe(false);
    expect(doc.leaves()).toHaveLength(2);
  });

  it('Select All Unused and Select All Instances', async () => {
    const { def, instance } = await makeSymbol();
    const c = addRect(300, 300, 10, 10);
    app.editor.select([c]);
    await app.commands.run('symbol.new', { direct: true, name: 'Dot' });
    // Break the only Dot instance: Dot is unused now.
    await app.commands.run('symbol.breakLink');
    await app.commands.run('symbol.selectUnused');
    expect(selectedSymbols(app.editor).map((id) => getDef(app.editor.doc, id).name)).toEqual(['Dot']);
    setSymbolSelection(app.editor, [def.id]);
    await app.commands.run('symbol.selectInstances');
    expect([...app.editor.selection]).toEqual([instance.id]);
  });

  it('Symbol Options renames and switches on 9-slice guides', async () => {
    const { def } = await makeSymbol();
    const p = app.commands.run('symbol.options', { id: def.id });
    await new Promise((r) => setTimeout(r, 0));
    document.querySelector('dialog[open] input[type="text"]').value = 'Banner';
    const slice = [...document.querySelectorAll('dialog[open] input[type="checkbox"]')][0];
    slice.checked = true;
    slice.dispatchEvent(new Event('change'));
    await answer('OK');
    await p;
    const d = getDef(app.editor.doc, def.id);
    expect(d.name).toBe('Banner');
    expect(d.symbolDef.slice9.w).toBeCloseTo(70 / 3);
  });
});

describe('Properties and Layers', () => {
  it('show a symbol section and the symbol name', async () => {
    const { instance } = await makeSymbol();
    const props = app.dock.panels.get('properties');
    props.ensureBuilt();
    props.update();
    expect(props.header.textContent).toBe('Symbol Instance');
    const sec = props.extra.find((e) => e.def.id === 'symbol');
    expect(sec.def.when(app.editor)).toBe(true);
    sec.inst.refresh();
    expect(sec.inst.el.querySelector('select').value).toBe(instance.symbol);
    app.openPanel('layers');
    const layers = app.dock.panels.get('layers');
    layers.ensureBuilt();
    layers.update();
    const names = [...layers.el.querySelectorAll('.lr-name')].map((n) => n.textContent);
    expect(names).toContain('Card');
    expect(layers.el.querySelector('.lr-symbol')).toBeTruthy();
  });
});

describe('clipboard', () => {
  it('carries symbols into another document', async () => {
    const { def } = await makeSymbol();
    await app.commands.run('edit.copy');
    app.newDocument();
    const doc2 = app.editor.doc;
    await app.commands.run('edit.paste');
    const defs = symbolDefs(doc2);
    expect(defs.map((d) => d.name)).toEqual(['Card']);
    expect(defs[0].id).not.toBe(def.id);
    const [inst] = doc2.leaves();
    expect(inst.symbol).toBe(defs[0].id);
    // Pasting again reuses the symbol now in this document.
    await app.commands.run('edit.paste');
    expect(symbolDefs(doc2)).toHaveLength(1);
  });
});

describe('symbol libraries', () => {
  it('have original artwork that builds into paths', () => {
    expect(SYMBOL_LIBRARIES.length).toBeGreaterThanOrEqual(5);
    for (const lib of SYMBOL_LIBRARIES) {
      expect(lib.symbols.length).toBeGreaterThanOrEqual(6);
      for (const s of lib.symbols) expect(libraryArtwork(s).length).toBeGreaterThan(0);
    }
  });

  it('place into the document, adding the symbol once', () => {
    const lib = SYMBOL_LIBRARIES[0];
    placeLibrarySymbol(app, lib, lib.symbols[0]);
    placeLibrarySymbol(app, lib, lib.symbols[0], { x: 10, y: 10 });
    const doc = app.editor.doc;
    expect(symbolDefs(doc)).toHaveLength(1);
    expect(doc.leaves()).toHaveLength(2);
    const win = openSymbolLibrary(app, 'weather');
    expect(document.querySelectorAll('.sym-lib-window .sym-lib-item')).toHaveLength(SYMBOL_LIBRARIES.find((l) => l.id === 'weather').symbols.length);
    expect(win.open).toEqual(['weather']);
  });
});

describe('symbolism tools', () => {
  it('fall off toward the brush edge', () => {
    expect(falloff(0, 10)).toBe(1);
    expect(falloff(10, 10)).toBe(0);
    expect(falloff(5, 10)).toBeGreaterThan(0);
  });

  it('the Sprayer makes a symbol set in one undo step', async () => {
    const { def } = await makeSymbol();
    const ed = app.editor;
    ed.clearSelection();
    setSymbolismOptions(app, { diameter: 200, intensity: 10, density: 3 });
    app.setTool('symbol-sprayer');
    const tool = app.tool;
    const steps = ed.doc.undoStack.length;
    tool.onPointerDown(ev(300, 300));
    for (let i = 0; i < 20; i++) tool.step(ev(300, 300), 0.1);
    tool.onPointerUp(ev(300, 300));
    const set = ed.doc.get([...ed.selection][0]);
    expect(isSymbolSet(set)).toBe(true);
    expect(set.children.length).toBeGreaterThan(2);
    for (const c of set.children) expect(ed.doc.get(c).symbol).toBe(def.id);
    expect(ed.doc.undoStack.length).toBe(steps + 1);
    ed.doc.undo();
    expect(ed.doc.has(set.id)).toBe(false);
  });

  it('size, screen, stain and spin instances under the brush', async () => {
    const { def } = await makeSymbol();
    const ed = app.editor;
    const doc = ed.doc;
    ed.clearSelection();
    setSymbolismOptions(app, { diameter: 300, intensity: 10, density: 1 });
    app.setTool('symbol-sprayer');
    app.tool.onPointerDown(ev(300, 250));
    for (let i = 0; i < 10; i++) app.tool.step(ev(300, 250), 0.1);
    app.tool.onPointerUp(ev(300, 250));
    const setId = [...ed.selection][0];
    const first = () => doc.get(doc.get(setId).children[0]);
    const scaleOf = (n) => Math.hypot(n.transform[0], n.transform[1]);
    const run = (id, opts = {}) => {
      app.setTool(id);
      const t = app.tool;
      const c = nodeBounds(doc, first());
      const e = ev(c.x + c.w / 2, c.y + c.h / 2, opts);
      t.onPointerDown(e);
      for (let i = 0; i < 5; i++) t.step(e, 0.1);
      t.onPointerUp(e);
    };
    const s0 = scaleOf(first());
    run('symbol-sizer');
    expect(scaleOf(first())).toBeGreaterThan(s0);
    run('symbol-screener');
    expect(first().opacity).toBeLessThan(1);
    ed.setStyle({ fill: green });
    run('symbol-stainer');
    expect(first().tint.color).toBe('#00ff00');
    expect(first().tint.amount).toBeGreaterThan(0);
    run('symbol-stainer', { alt: true });
    run('symbol-styler');
    expect(first().style).toBeTruthy();
    expect(getDef(doc, def.id)).toBeTruthy();
  });
});

describe('opening SVG with <symbol> uses', () => {
  it('turns them into symbols without an undo step or unsaved changes', async () => {
    const { svgToDocument } = await import('../src/features/io/svg-import.js');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
      <symbol id="leaf"><title>Leaf</title><rect width="10" height="10" fill="#0a0"/></symbol>
      <use href="#leaf" x="10" y="10"/><use href="#leaf" x="50" y="10"/></svg>`;
    const ed = app.addDocument(svgToDocument(svg, { name: 'icons' }));
    expect(symbolDefs(ed.doc).map((d) => d.name)).toEqual(['Leaf']);
    expect(instancesOf(ed.doc)).toHaveLength(2);
    expect(ed.doc.undoStack).toHaveLength(0);
    expect(ed.doc.dirty).toBe(false);
  });
});

describe('dragging between the canvas and the Symbols panel', () => {
  it('dropping dragged artwork on the panel makes a symbol where the artwork was', async () => {
    const a = addRect(100, 100, 40, 20);
    const ed = app.editor;
    app.openPanel('symbols');
    const panel = app.dock.panels.get('symbols');
    panel.update();
    app.setTool('selection');
    const tool = app.tool;
    tool.onPointerDown(ev(110, 110));
    tool.onPointerMove(ev(160, 160));
    expect(tool.drag?.session).toBeTruthy();
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => panel.list;
    try {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5 }));
      expect(panel.el.classList.contains('drop-target')).toBe(true);
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 5, clientY: 5 }));
    } finally {
      document.elementFromPoint = orig;
    }
    expect(panel.el.classList.contains('drop-target')).toBe(false);
    await answer('OK');
    await new Promise((r) => setTimeout(r, 0));
    const [inst] = ed.doc.leaves();
    expect(inst.type).toBe('instance');
    expect(nodeBounds(ed.doc, inst)).toEqual({ x: 100, y: 100, w: 40, h: 20 });
    expect(getDef(ed.doc, inst.symbol).children).toEqual([a]);
  });

  it('dropping a symbol from the panel on the canvas places it under the pointer', async () => {
    const { def } = await makeSymbol();
    app.openPanel('symbols');
    const panel = app.dock.panels.get('symbols');
    panel.update();
    const item = panel.el.querySelector('.sym-item');
    const host = app.canvasHost;
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => host;
    try {
      item.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
      item.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 40 }));
      expect(document.querySelector('.sym-drag-ghost')).toBeTruthy();
      item.dispatchEvent(new PointerEvent('pointerup', { clientX: 30, clientY: 40 }));
    } finally {
      document.elementFromPoint = orig;
    }
    expect(document.querySelector('.sym-drag-ghost')).toBeNull();
    const placed = instancesOf(app.editor.doc, def.id);
    expect(placed).toHaveLength(2);
    const r = host.getBoundingClientRect();
    const p = app.editor.view.toDoc(30 - r.left, 40 - r.top);
    const t = placed[1].transform;
    expect(t[4] + def.symbolDef.reg.x).toBeCloseTo(p.x);
    expect(t[5] + def.symbolDef.reg.y).toBeCloseTo(p.y);
  });
});

describe('symbolism tool options', () => {
  it('[ and ] resize the brush; the options dialog saves the shared settings', async () => {
    const { symbolismOptions } = await import('../src/features/symbols/tools.js');
    app.setTool('symbol-sizer');
    const d0 = symbolismOptions(app).diameter;
    expect(app.tool.onKeyDown({ key: ']' })).toBe(true);
    expect(symbolismOptions(app).diameter).toBeGreaterThan(d0);
    app.tool.onKeyDown({ key: '[' });
    expect(symbolismOptions(app).diameter).toBe(d0);
    const p = app.tool.openOptions();
    await new Promise((r) => setTimeout(r, 0));
    const dlg = document.querySelector('dialog[open]');
    expect(dlg.querySelectorAll('.symt-tool')).toHaveLength(8);
    expect(dlg.querySelector('.symt-tool[aria-selected="true"]').getAttribute('aria-label')).toBe('Symbol Sizer');
    dlg.querySelector('#symt-diameter').value = '40 pt';
    dlg.querySelector('#symt-method').value = 'random';
    dlg.querySelector('#symt-method').dispatchEvent(new Event('change'));
    await answer('OK');
    await p;
    expect(symbolismOptions(app).diameter).toBe(40);
    expect(symbolismOptions(app).methods.sizer).toBe('random');
  });
});
