/**
 * Pathfinder panel menu extras:
 *
 *  - Compound shapes: live shape-mode results. Alt-clicking a shape mode
 *    (or Make Compound Shape) groups the selection with a Pathfinder effect
 *    (`group.compoundShape`), so the operands stay editable and the result
 *    updates as they change. Alt-clicking another mode with a compound
 *    shape selected changes its mode. Release gives back the objects;
 *    Expand bakes the result into ordinary paths.
 *  - Trap: thin overprinting strips where differently colored objects meet
 *    (see mix-trap.js), added as a group above the selection.
 */
import { createGroup } from '../../model/nodes.js';
import { OP, loadGeom, runGeomSync } from './engine/index.js';
import { geometryLeaves, styleOf, subpathsOf, nodeFromSubpaths, groupOf, insertionPoint } from './nodes-io.js';
import { fillShapes, trapStrips } from './mix-trap.js';
import { expandNodeAppearance } from '../../ops/expand-appearance.js';
import { SHAPE_MODES } from './pathfinder.js';

/** Is a node a compound shape (a group with a live shape mode)? */
export function isCompoundShape(n) {
  return n?.type === 'group' && Boolean(n.compoundShape) && (n.effects || []).some((e) => e.type === 'pathfinder');
}

/** The shape mode of a compound shape ('unite', 'minusFront', 'intersect', 'exclude'). */
export function compoundShapeMode(n) {
  return [...(n?.effects || [])].reverse().find((e) => e.type === 'pathfinder')?.kind || null;
}

/** Compound shapes among the selected objects. */
export function selectedCompoundShapes(editor) {
  return editor ? editor.topSelection().map((id) => editor.doc.get(id)).filter(isCompoundShape) : [];
}

const setMode = (n, kind) => {
  let done = false;
  const effects = [...(n.effects || [])].reverse().map((e) => {
    if (!done && e.type === 'pathfinder') {
      done = true;
      return { ...e, kind };
    }
    return e;
  });
  return effects.reverse();
};

/**
 * Make a compound shape of the editor's selection with a shape mode, or
 * change the mode of a selected compound shape. Returns the group id.
 */
export function makeCompoundShape(editor, kind = 'unite') {
  const doc = editor.doc;
  if (!SHAPE_MODES.some((m) => m.kind === kind)) kind = 'unite';
  const shapes = selectedCompoundShapes(editor);
  const ids = editor.topSelection();
  if (shapes.length && shapes.length === ids.length) {
    doc.transact('Compound Shape Mode', () => shapes.forEach((n) => doc.update(n.id, { effects: setMode(n, kind) })));
    return shapes.at(-1).id;
  }
  if (!ids.length) return null;
  const sorted = doc.sortByPaintOrder(ids);
  let gid = null;
  doc.transact('Make Compound Shape', () => {
    const top = doc.get(sorted.at(-1));
    const parent = doc.get(top.parent);
    const g = createGroup([], { compoundShape: true, name: '', effects: [{ type: 'pathfinder', kind }] });
    doc.insert(g, parent.id, parent.children.indexOf(top.id) + 1);
    for (const id of sorted) doc.move(id, g.id);
    gid = g.id;
  });
  editor.select([gid]);
  return gid;
}

/** Release compound shapes: their objects go back where the group was. Returns the released ids. */
export function releaseCompoundShapes(editor) {
  const doc = editor.doc;
  const shapes = selectedCompoundShapes(editor);
  const out = [];
  doc.transact('Release Compound Shape', () => {
    for (const g of shapes) {
      const parent = doc.get(g.parent);
      let index = parent.children.indexOf(g.id);
      for (const c of g.children.slice()) {
        doc.move(c, parent.id, index++);
        out.push(c);
      }
      doc.remove(g.id);
    }
  });
  editor.select(out);
  return out;
}

/** Expand compound shapes into the paths they show. Returns the new ids. */
export function expandCompoundShapes(editor) {
  const doc = editor.doc;
  const shapes = selectedCompoundShapes(editor);
  const out = [];
  doc.transact('Expand Compound Shape', () => {
    for (const g of shapes) {
      let n = doc.get(expandNodeAppearance(doc, g.id));
      // Plain wrapper groups around one resulting shape go away.
      const plain = (x) => x?.type === 'group' && x.children.length === 1 && !x.clip && (x.opacity ?? 1) === 1 && (x.blendMode || 'normal') === 'normal' && !x.effects?.length;
      while (plain(n)) {
        const parent = doc.get(n.parent);
        const child = n.children[0];
        doc.move(child, parent.id, parent.children.indexOf(n.id));
        doc.remove(n.id);
        n = doc.get(child);
      }
      if (!n) continue;
      if (n.compoundShape) doc.update(n.id, { compoundShape: undefined });
      out.push(n.id);
    }
  });
  editor.select(out.filter((id) => doc.has(id)));
  return out;
}

/**
 * Trap the selected objects (inside the caller's transaction, the engine
 * loaded): a group of trap strips goes above them. Returns its id or null.
 */
export function trapSelection(doc, leaves, opts) {
  const items = leaves.map((n) => ({ style: styleOf(n), subpaths: subpathsOf(doc, n), fillRule: n.fillRule }));
  const { shapes, owners } = fillShapes(items);
  if (shapes.length < 2) return null;
  const engine = (op, s, params) => {
    try {
      return runGeomSync(op, s, params);
    } catch {
      return null;
    }
  };
  const records = engine(OP.DIVIDE, shapes, []);
  if (!records) return null;
  const faces = records.filter((r) => owners[r.owner] && r.subpaths.length).map((r) => ({ style: { ...owners[r.owner].style, stroke: null }, subpaths: r.subpaths }));
  const traps = trapStrips(faces, opts, engine) || [];
  const built = traps.map((t) => nodeFromSubpaths(t.subpaths, { ...t.style, effects: [] }, { overprintFill: true })).filter(Boolean);
  if (!built.length) return null;
  const at = insertionPoint(doc, leaves);
  const group = groupOf(built, { name: 'Traps' });
  doc.insert(group.node, at.parentId, at.index, group.descendants);
  return group.node.id;
}

/** Pathfinder panel menu > Trap: the options dialog, then traps for the selection. */
export async function trapCommand(app) {
  const ed = app.editor;
  if (!ed) return false;
  const leaves = geometryLeaves(ed.doc, ed.topSelection());
  if (leaves.filter((n) => n.fill).length < 2) {
    app.notify('Select two or more filled objects to trap.');
    return false;
  }
  const last = app.prefs.get('trapOptions') || {};
  const v = await app.dialogs.form({
    title: 'Pathfinder Trap',
    fields: [
      { key: 'thickness', label: 'Thickness', type: 'length', value: last.thickness ?? 0.25, min: 0.01, max: 5000, step: 0.05 },
      { key: 'tint', label: 'Tint reduction (%)', type: 'number', value: Math.round((last.tint ?? 0.4) * 100), min: 0, max: 100 },
      { key: 'reverse', label: 'Reverse traps (spread the darker color)', type: 'checkbox', value: Boolean(last.reverse) },
    ],
  });
  if (!v) return false;
  const opts = { thickness: v.thickness, tint: v.tint / 100, reverse: v.reverse };
  app.prefs.set('trapOptions', opts);
  await loadGeom();
  if (app.editor !== ed) return false;
  let id = null;
  ed.doc.transact('Trap', () => {
    id = trapSelection(ed.doc, leaves.filter((n) => ed.doc.has(n.id)), opts);
  });
  if (!id) {
    app.notify('The selected objects do not meet, so there is nothing to trap.', { polite: true });
    return false;
  }
  ed.select([id]);
  return true;
}
