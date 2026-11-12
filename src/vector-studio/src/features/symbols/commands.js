/**
 * Symbol commands: Symbols panel actions, the context menu's Edit Symbol
 * and Break Link, Select > Same > Symbol Instance.
 */
import { UserError } from '../../lib/errors.js';
import { IDENTITY } from '../../lib/matrix.js';
import {
  getDef, isInstance, isSymbolSet, symbolDefs, instancesOf, onPage, createSymbolFrom, placeInstance, replacePatch, resetTransformPatch, breakLink,
  duplicateSymbol, deleteSymbols, sortSymbolsByName, unusedSymbols, updateDefinition, masterBounds, redefineSymbol, registrationPoint, editingStack,
  wouldNestItself,
} from './model.js';
import { enterSymbolEdit, exitSymbolEdit, editingSymbol } from './editing.js';
import { symbolOptionsDialog, deleteInUseDialog, registrationCode } from './dialogs.js';
import { currentSymbol, selectedSymbols, setSymbolSelection } from './state.js';

const NESTED_ITSELF = 'A symbol cannot be placed inside itself.';

/** Instances in the selection, including those inside selected symbol sets. */
export function selectedInstances(editor, { sets = true } = {}) {
  if (!editor) return [];
  const doc = editor.doc;
  const out = [];
  for (const id of editor.topSelection()) {
    const n = doc.get(id);
    if (isInstance(n)) out.push(n);
    else if (sets && isSymbolSet(n)) for (const c of n.children) if (isInstance(doc.get(c))) out.push(doc.get(c));
  }
  return out;
}

const hasInstances = (a) => selectedInstances(a.editor).length > 0;

/** Ids of the page objects a new symbol is made from. */
function symbolSources(editor) {
  return editor.topSelection().filter((id) => {
    const n = editor.doc.get(id);
    return n && n.type !== 'layer' && !getDef(editor.doc, id);
  });
}

/** New Symbol: the dialog (unless `direct`), then the selection becomes a symbol and an instance. */
export async function newSymbol(app, { direct = false, name = null } = {}) {
  const ed = app.editor;
  if (!ed) return null;
  const ids = symbolSources(ed);
  if (!ids.length) throw new UserError('Select artwork to make a symbol.');
  const doc = ed.doc;
  const n = symbolDefs(doc).length + 1;
  const prefs = app.prefs;
  let opts = {
    name: name || `New Symbol ${n}`.replace(/ 1$/, ''),
    kind: prefs?.get('symbolKind') || 'dynamic',
    registration: prefs?.get('symbolRegistration') || 'cc',
    slice9: false,
    pixelAlign: false,
  };
  if (!direct) {
    const res = await symbolOptionsDialog(app, { title: 'New Symbol', values: opts });
    if (!res) return null;
    opts = res;
    prefs?.set('symbolKind', res.kind);
    if (res.registration) prefs?.set('symbolRegistration', res.registration);
  }
  let out = null;
  doc.transact('New Symbol', () => {
    out = createSymbolFrom(doc, ids, { ...opts, registration: opts.registration || 'cc' });
  });
  if (!out) return null;
  ed.select([out.instance.id]);
  setSymbolSelection(ed, [out.def.id]);
  return out;
}

/** Place the current symbol: at a point, or centered in the view. */
export function placeSymbol(app, symbolId = currentSymbol(app.editor), point = null) {
  const ed = app.editor;
  if (!ed || !getDef(ed.doc, symbolId)) throw new UserError('Choose a symbol in the Symbols panel first.');
  const doc = ed.doc;
  const layer = ed.targetLayer();
  if (!layer || doc.isLocked(layer.id) || doc.isHidden(layer.id)) throw new UserError('Unlock or show the layer to place the symbol.');
  const p = point || ed.view.toDoc(ed.view.width / 2, ed.view.height / 2);
  // Without a drop point the symbol's middle lands in the middle of the view.
  let x = p.x;
  let y = p.y;
  if (!point) {
    const def = getDef(doc, symbolId);
    const b = masterBounds(doc, def);
    if (b) {
      x += def.symbolDef.reg.x - (b.x + b.w / 2);
      y += def.symbolDef.reg.y - (b.y + b.h / 2);
    }
  }
  const t = ed.drawTarget();
  if (wouldNestItself(doc, symbolId, t.parentId)) throw new UserError(NESTED_ITSELF);
  let inst = null;
  doc.transact('Place Symbol Instance', () => {
    inst = placeInstance(doc, symbolId, t.parentId, x, y, t.index);
  });
  ed.select([inst.id]);
  return inst;
}

export function replaceSymbol(app, symbolId = currentSymbol(app.editor)) {
  const ed = app.editor;
  const doc = ed.doc;
  const all = selectedInstances(ed);
  const insts = all.filter((n) => !wouldNestItself(doc, symbolId, n.parent));
  if (all.length && !insts.length) throw new UserError(NESTED_ITSELF);
  if (!insts.length || !getDef(doc, symbolId)) return false;
  doc.transact('Replace Symbol', () => {
    for (const n of insts) if (n.symbol !== symbolId) doc.update(n.id, replacePatch(doc, n, symbolId));
  });
  return true;
}

export function breakLinks(app) {
  const ed = app.editor;
  const doc = ed.doc;
  const top = ed.topSelection();
  const out = [];
  doc.transact('Break Link to Symbol', () => {
    for (const id of top) {
      const n = doc.get(id);
      if (isInstance(n)) out.push(breakLink(doc, id)?.id);
      else if (isSymbolSet(n)) {
        for (const c of [...n.children]) if (isInstance(doc.get(c))) breakLink(doc, c);
        // The set is now a group of plain artwork.
        doc.update(id, { live: undefined });
        out.push(id);
      }
    }
  });
  ed.select(out.filter((id) => id && doc.has(id)));
}

export function resetTransforms(app) {
  const ed = app.editor;
  const doc = ed.doc;
  const insts = selectedInstances(ed);
  doc.transact('Reset Transformation', () => {
    for (const n of insts) {
      const p = resetTransformPatch(doc, n);
      if (p) doc.update(n.id, p);
    }
  });
}

/** Edit Symbol: `id` is an instance (edit in place) or a symbol (from the panel). */
export function editSymbol(app, id) {
  const ed = app.editor;
  const doc = ed.doc;
  let target = id ? doc.get(id) : null;
  if (!target) {
    const insts = selectedInstances(ed, { sets: false });
    target = insts.length === 1 ? insts[0] : getDef(doc, currentSymbol(ed));
  }
  if (!target) return false;
  if (isInstance(target)) {
    if (!getDef(doc, target.symbol)) throw new UserError('The symbol of this instance is missing.');
    return enterSymbolEdit(app, ed, target.symbol, { via: target.id });
  }
  return enterSymbolEdit(app, ed, target.id);
}

export async function deleteSelectedSymbols(app, ids = selectedSymbols(app.editor)) {
  const ed = app.editor;
  if (!ed || !ids.length) return false;
  const doc = ed.doc;
  if (editingStack(doc).some((e) => ids.includes(e.id))) throw new UserError('Finish editing the symbol before deleting it.');
  const set = new Set(ids);
  const used = instancesOf(doc).filter((n) => set.has(n.symbol) && ![...set].some((s) => doc.isAncestor(s, n.id)));
  let mode = 'expand';
  if (used.length) {
    const names = ids.map((id) => getDef(doc, id)?.name).filter(Boolean);
    mode = await deleteInUseDialog({ names, count: used.length });
    if (!mode) return false;
  } else {
    const ok = await app.dialogs.confirm({ title: 'Delete Symbol', message: ids.length === 1 ? `Delete the symbol "${getDef(doc, ids[0])?.name}"?` : `Delete ${ids.length} symbols?`, okLabel: 'Delete', danger: true });
    if (!ok) return false;
  }
  doc.transact('Delete Symbol', () => deleteSymbols(doc, ids, { instances: mode }));
  setSymbolSelection(ed, []);
  return true;
}

/** Symbol Options for a symbol. */
export async function symbolOptions(app, id = currentSymbol(app.editor)) {
  const ed = app.editor;
  const doc = ed?.doc;
  const def = doc && getDef(doc, id);
  if (!def) return false;
  const sd = def.symbolDef;
  const b = masterBounds(doc, def);
  const g = sd.slice9;
  const res = await symbolOptionsDialog(app, {
    values: {
      name: def.name,
      kind: sd.kind,
      registration: registrationCode(b, sd.reg),
      slice9: Boolean(g),
      insets: g && b ? { left: g.x - b.x, top: g.y - b.y, right: b.x + b.w - (g.x + g.w), bottom: b.y + b.h - (g.y + g.h) } : null,
      pixelAlign: sd.pixelAlign,
    },
    bounds: b,
  });
  if (!res) return false;
  doc.transact('Symbol Options', () => {
    const patch = { name: res.name, kind: res.kind, pixelAlign: res.pixelAlign };
    if (res.registration && b) patch.reg = registrationPoint(b, res.registration);
    if (!res.slice9) patch.slice9 = null;
    else if (b) {
      const i = res.insets || { left: b.w / 3, top: b.h / 3, right: b.w / 3, bottom: b.h / 3 };
      patch.slice9 = { x: b.x + i.left, y: b.y + i.top, w: Math.max(0, b.w - i.left - i.right), h: Math.max(0, b.h - i.top - i.bottom) };
    }
    updateDefinition(doc, def.id, patch);
  });
  return true;
}

export function selectAllInstances(app, ids = selectedSymbols(app.editor)) {
  const ed = app.editor;
  const doc = ed.doc;
  const set = new Set(ids);
  const iso = ed.isolation;
  const out = instancesOf(doc)
    .filter((n) => set.has(n.symbol) && onPage(doc, n.id) && !doc.isHidden(n.id) && !doc.isLocked(n.id) && (!iso || doc.isAncestor(iso, n.id)))
    .map((n) => n.id);
  ed.select(out);
  return out;
}

export function registerSymbolCommands(app) {
  const ed = () => app.editor;
  const hasDoc = (a) => Boolean(a.editor);
  const hasCurrent = (a) => Boolean(a.editor && getDef(a.editor.doc, currentSymbol(a.editor)));
  const hasPanelSel = (a) => selectedSymbols(a.editor).length > 0;
  app.commands.register([
    { id: 'symbol.new', label: 'New Symbol...', shortcut: 'F8', enabled: (a) => Boolean(a.editor) && symbolSources(a.editor).length > 0, run: (a, args) => newSymbol(a, args || {}) },
    { id: 'symbol.place', label: 'Place Symbol Instance', enabled: hasCurrent, run: (a, args) => placeSymbol(a, args?.id || currentSymbol(a.editor), args?.point || null) },
    { id: 'symbol.replace', label: 'Replace Symbol', enabled: (a) => hasCurrent(a) && hasInstances(a), run: (a, args) => replaceSymbol(a, args?.id || currentSymbol(a.editor)) },
    { id: 'symbol.breakLink', label: 'Break Link to Symbol', enabled: (a) => Boolean(a.editor) && a.editor.topSelection().some((id) => isInstance(a.editor.doc.get(id)) || isSymbolSet(a.editor.doc.get(id))), run: (a) => breakLinks(a) },
    {
      id: 'symbol.edit',
      label: 'Edit Symbol',
      enabled: (a, args) => {
        const e = a.editor;
        if (!e) return false;
        if (args?.id) return Boolean(e.doc.get(args.id));
        return selectedInstances(e, { sets: false }).length === 1 || (!e.selection.size && hasCurrent(a));
      },
      run: (a, args) => editSymbol(a, args?.id),
    },
    { id: 'symbol.exitEdit', label: 'Exit Symbol Editing', enabled: (a) => Boolean(editingSymbol(a.editor)), run: (a) => exitSymbolEdit(a, a.editor) },
    { id: 'symbol.reset', label: 'Reset Transformation', enabled: (a) => selectedInstances(a.editor).some((n) => !sameMatrix(n.transform, resetTransformPatch(a.editor.doc, n)?.transform)), run: (a) => resetTransforms(a) },
    { id: 'symbol.duplicate', label: 'Duplicate Symbol', enabled: hasPanelSel, run: (a) => {
      const doc = ed().doc;
      const out = [];
      doc.transact('Duplicate Symbol', () => {
        for (const id of selectedSymbols(ed())) out.push(duplicateSymbol(doc, id).id);
      });
      setSymbolSelection(ed(), out);
    } },
    { id: 'symbol.delete', label: 'Delete Symbol', enabled: (a) => hasPanelSel(a) && !selectedSymbols(a.editor).some((id) => editingStack(a.editor.doc).some((e) => e.id === id)), run: (a, args) => deleteSelectedSymbols(a, args?.ids) },
    { id: 'symbol.options', label: 'Symbol Options...', enabled: hasCurrent, run: (a, args) => symbolOptions(a, args?.id) },
    {
      id: 'symbol.redefine',
      label: 'Redefine Symbol',
      enabled: (a) => hasCurrent(a) && symbolSources(a.editor).length > 0 && !editingSymbol(a.editor),
      run: (a) => {
        const doc = ed().doc;
        const id = currentSymbol(ed());
        doc.transact('Redefine Symbol', () => redefineSymbol(doc, id, symbolSources(ed())));
      },
    },
    { id: 'symbol.selectUnused', label: 'Select All Unused', enabled: (a) => hasDoc(a) && unusedSymbols(a.editor.doc).length > 0, run: (a) => setSymbolSelection(a.editor, unusedSymbols(a.editor.doc).map((d) => d.id)) },
    { id: 'symbol.selectInstances', label: 'Select All Instances', enabled: hasPanelSel, run: (a) => selectAllInstances(a) },
    { id: 'symbol.sortByName', label: 'Sort by Name', enabled: (a) => hasDoc(a) && symbolDefs(a.editor.doc).length > 1, run: (a) => a.editor.doc.transact('Sort Symbols', () => sortSymbolsByName(a.editor.doc)) },
    {
      id: 'select.same.symbol',
      label: 'Symbol Instance',
      enabled: (a) => selectedInstances(a.editor, { sets: false }).length > 0,
      run: (a) => selectAllInstances(a, [...new Set(selectedInstances(a.editor, { sets: false }).map((n) => n.symbol))]),
    },
  ]);

  // Leaving isolation while editing a symbol finishes the edit; leaving a
  // group isolated inside the master goes back to the symbol.
  const exitIso = app.commands.get('object.exitIsolation');
  if (exitIso) {
    app.commands.register({
      ...exitIso,
      enabled: (a) => exitIso.enabled(a) || Boolean(editingSymbol(a.editor)),
      run: (a, args) => {
        const e = a.editor;
        const sym = editingSymbol(e);
        if (sym && (e.isolation === sym || !e.isolation)) return exitSymbolEdit(a, e);
        const r = exitIso.run(a, args);
        if (sym && !e.isolation) {
          e.isolation = sym;
          e.emit('isolation');
        }
        return r;
      },
    });
  }
}

function sameMatrix(a = IDENTITY, b = IDENTITY) {
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}
