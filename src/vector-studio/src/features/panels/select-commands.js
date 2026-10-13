/**
 * Select menu commands: Same > Shapes & Text, Appearance Attribute and
 * Graphic Style, Object > Direction Handles, Start/Stop Global Edit, and
 * named selections (Save Selection, Edit Selection, Update Selection,
 * Select > Saved Selections). Saved
 * selections live in the document (doc.root.savedSelections), so they are
 * saved with the file and changes to them undo.
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { UserError } from '../../lib/errors.js';
import { graphicStylesOf, styleOfNode } from '../paint/graphic-styles.js';

const hasDoc = (a) => Boolean(a.editor);
const hasSel = (a) => Boolean(a.editor?.selection.size);

/** Visible, unlocked objects that can be matched: paths, compounds, text and images (compounds whole). */
function candidates(doc) {
  const out = [];
  doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if (n.type === 'compound') {
      out.push(n);
      return false;
    }
    if (n.type === 'path' || n.type === 'text' || n.type === 'image') out.push(n);
    return true;
  });
  return out;
}

function referenceNode(editor) {
  const doc = editor.doc;
  for (const n of editor.selectedNodes()) {
    if (n.type === 'path' && doc.get(n.parent)?.type === 'compound') return doc.get(n.parent);
    if (n.type !== 'group' && n.type !== 'layer') return n;
  }
  return null;
}

// ---- Same Shapes & Text ----

/**
 * Objects matching any selected object's content: paths and compound paths
 * with the same outline (up to position, whatever their paint), text
 * objects with the same characters (whatever their style).
 */
export function selectSameShapesText(editor) {
  const doc = editor.doc;
  const shapes = new Set();
  const texts = new Set();
  for (const n of editor.selectedNodes()) {
    const ref = n.type === 'path' && doc.get(n.parent)?.type === 'compound' ? doc.get(n.parent) : n;
    if (ref.type === 'text') texts.add(ref.text || '');
    else if (ref.type === 'path' || ref.type === 'compound') {
      const k = shapeKey(doc, ref);
      if (k != null) shapes.add(`${ref.type}:${k}`);
    }
  }
  if (!shapes.size && !texts.size) throw new UserError('Select a path or a type object to match.');
  const ids = candidates(doc)
    .filter((n) => (n.type === 'text' ? texts.has(n.text || '') : n.type !== 'image' && shapes.has(`${n.type}:${shapeKey(doc, n)}`)))
    .map((n) => n.id);
  editor.select(ids);
  return ids;
}

// ---- Same Appearance Attribute ----

/** The appearance attributes of an object: its visible effects, by kind. */
export function appearanceAttributes(node) {
  return (node.effects || []).filter((e) => e && !e.hidden).map((e) => e.type);
}

/** Objects sharing at least one appearance attribute (effect kind) with the reference. */
export function selectSameAppearanceAttribute(editor) {
  const ref = referenceNode(editor);
  if (!ref) throw new UserError('Select an object to match.');
  const kinds = new Set(appearanceAttributes(ref));
  if (!kinds.size) throw new UserError('The selected object has no appearance attributes (effects) to match.');
  const ids = candidates(editor.doc)
    .filter((n) => appearanceAttributes(n).some((k) => kinds.has(k)))
    .map((n) => n.id);
  editor.select(ids);
  return ids;
}

// ---- Same Graphic Style ----

const DEFAULTS = { fill: null, stroke: null, strokeWidth: 1, strokeCap: 'butt', strokeJoin: 'miter', miterLimit: 10, strokeAlign: 'center', dash: [], dashOffset: 0, opacity: 1, blendMode: 'normal', effects: [] };

function stripIds(effects) {
  return (effects || []).map((e) => {
    const out = { ...e };
    delete out.id;
    return out;
  });
}

function normPaint(p) {
  if (!p) return null;
  const out = { ...p };
  delete out.swatchId;
  delete out.cmyk;
  delete out.mode;
  return out;
}

/** Does a node's appearance match a graphic style's (only the fields the style sets)? */
export function matchesStyle(doc, node, style) {
  const s = styleOfNode(doc, node);
  for (const [k, v] of Object.entries(style)) {
    if (v === undefined) continue;
    let a = s[k] ?? DEFAULTS[k] ?? null;
    let b = v;
    if (k === 'effects') {
      a = stripIds(a);
      b = stripIds(b);
    } else if (k === 'fill' || k === 'stroke') {
      a = normPaint(a);
      b = normPaint(b);
    }
    if (k === 'strokeWidth' && !s.stroke && !style.stroke) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}

/** Objects with the same graphic style as the reference (the first style its appearance matches). */
export function selectSameGraphicStyle(editor) {
  const doc = editor.doc;
  const ref = referenceNode(editor) || editor.selectedNodes()[0];
  if (!ref) throw new UserError('Select an object to match.');
  const style = graphicStylesOf(doc).find((gs) => matchesStyle(doc, ref, gs.style));
  if (!style) throw new UserError('The selected object does not use a graphic style.');
  const pool = [...candidates(doc)];
  doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if (n.type === 'group') pool.push(n);
    return true;
  });
  const ids = pool.filter((n) => matchesStyle(doc, n, style.style)).map((n) => n.id);
  editor.select(ids);
  return { style, ids };
}

// ---- Direction handles ----

const hasHandle = (a) => a.ix !== a.x || a.iy !== a.y || a.ox !== a.x || a.oy !== a.y;

/**
 * Select the anchors with direction handles on the selected paths (only
 * among already selected anchors when some are), and switch to Direct
 * Selection so the handles show and can be dragged.
 */
export function selectDirectionHandles(app) {
  const editor = app.editor;
  const doc = editor.doc;
  const paths = [];
  const visit = (n) => {
    if (!n) return;
    if (n.type === 'path') paths.push(n);
    else if (n.children) for (const c of n.children) visit(doc.get(c));
  };
  for (const id of editor.selection) visit(doc.get(id));
  const picks = [];
  for (const p of [...new Map(paths.map((n) => [n.id, n])).values()]) {
    const among = editor.anchors.get(p.id);
    const idx = p.anchors.map((a, i) => i).filter((i) => hasHandle(p.anchors[i]) && (!among || among.has(i)));
    if (idx.length) picks.push([p.id, idx]);
  }
  if (!picks.length) throw new UserError('The selected paths have no direction handles.');
  app.setTool?.('direct-selection');
  picks.forEach(([id, idx], k) => editor.selectAnchors(id, idx, { add: k > 0 }));
  return picks.length;
}

// ---- Global edit ----

const KEY_DIGITS = 2;

function shapeKey(doc, n) {
  const subs = n.type === 'compound' ? n.children.map((c) => doc.get(c)).filter((c) => c?.anchors) : [n];
  if (!subs.length || !subs[0].anchors?.length) return null;
  const o = subs[0].anchors[0];
  const r = (v) => (Math.round(v * 10 ** KEY_DIGITS) / 10 ** KEY_DIGITS).toFixed(KEY_DIGITS);
  return subs.map((s) => `${s.closed ? 'c' : 'o'}:${s.anchors.map((a) => [a.x - o.x, a.y - o.y, a.ix - o.x, a.iy - o.y, a.ox - o.x, a.oy - o.y].map(r).join(',')).join(';')}`).join('|');
}

const STYLE_FIELDS = ['fill', 'stroke', 'strokeWidth', 'strokeCap', 'strokeJoin', 'miterLimit', 'strokeAlign', 'dash', 'dashOffset', 'opacity', 'blendMode', 'effects', 'arrowStart', 'arrowEnd'];

function styleKey(n) {
  return JSON.stringify(STYLE_FIELDS.map((k) => (k === 'effects' ? stripIds(n[k]) : k === 'fill' || k === 'stroke' ? normPaint(n[k]) : n[k] ?? null)));
}

/** Objects with the same geometry (up to position) and appearance as `ref`. */
export function similarObjects(doc, ref) {
  const sk = shapeKey(doc, ref);
  if (sk == null) return [];
  const st = styleKey(ref);
  return candidates(doc)
    .filter((n) => n.type === ref.type && (n.id === ref.id || (shapeKey(doc, n) === sk && styleKey(n) === st)))
    .map((n) => n.id);
}

function originOf(doc, n) {
  const first = n.type === 'compound' ? doc.get(n.children[0]) : n;
  const a = first?.anchors?.[0];
  return a ? { x: a.x, y: a.y } : { x: 0, y: 0 };
}

function pathsOf(doc, n) {
  return n.type === 'compound' ? n.children.map((c) => doc.get(c)) : [n];
}

/**
 * A global edit session: the matched objects are selected; reshaping one of
 * them (anchors and handles) or changing its appearance applies the same
 * change to the others, inside the same undo step. Moving an object only
 * moves that object.
 */
export class GlobalEdit {
  constructor(app, editor, ids) {
    this.app = app;
    this.editor = editor;
    this.doc = editor.doc;
    this.members = new Map(ids.map((id) => [id, this.state(this.doc.get(id))]));
    this.syncing = false;
    this.off = this.doc.on('change', (e) => this.onChange(e));
  }

  state(n) {
    return { origin: originOf(this.doc, n), shape: shapeKey(this.doc, n), style: styleKey(n), node: n, paths: pathsOf(this.doc, n) };
  }

  get size() {
    return this.members.size;
  }

  resync() {
    for (const [id] of this.members) this.members.set(id, this.state(this.doc.get(id)));
  }

  onChange(e) {
    if (this.syncing) return;
    const doc = this.doc;
    for (const id of [...this.members.keys()]) if (!doc.has(id)) this.members.delete(id);
    if (this.members.size < 2) {
      this.app.stopGlobalEdit?.();
      return;
    }
    // Undo and redo restore every member together: just take the new state.
    if (e.undo) {
      this.resync();
      return;
    }
    // The member whose own node or paths changed.
    let changed = null;
    for (const [id, st] of this.members) {
      const n = doc.get(id);
      if (n !== st.node || pathsOf(doc, n).some((p, i) => p !== st.paths[i])) {
        changed = id;
        break;
      }
    }
    if (!changed || !doc.tx) {
      this.resync();
      return;
    }
    const src = doc.get(changed);
    const prev = this.members.get(changed);
    const shape = shapeKey(doc, src);
    const style = styleKey(src);
    this.syncing = true;
    try {
      // The changed member's first anchor before the change: a pure move keeps
      // the shape key (no propagation), a reshape is copied relative to it.
      const origin = prev.origin;
      if (shape !== prev.shape) {
        // Reshaped: copy the new outline to every other member, relative to each one's own origin.
        const rel = pathsOf(doc, src).map((p) => p.anchors.map((a) => ({ x: a.x - origin.x, y: a.y - origin.y, ix: a.ix - origin.x, iy: a.iy - origin.y, ox: a.ox - origin.x, oy: a.oy - origin.y })));
        for (const [id, st] of this.members) {
          if (id === changed) continue;
          const o = st.origin;
          pathsOf(doc, doc.get(id)).forEach((p, i) => {
            if (!p || !rel[i]) return;
            doc.update(p.id, { anchors: rel[i].map((a) => ({ x: a.x + o.x, y: a.y + o.y, ix: a.ix + o.x, iy: a.iy + o.y, ox: a.ox + o.x, oy: a.oy + o.y })), shape: undefined });
          });
        }
      }
      if (style !== prev.style) {
        const patch = {};
        for (const k of STYLE_FIELDS) patch[k] = src[k] === undefined ? undefined : structuredClone(src[k]);
        for (const [id] of this.members) if (id !== changed) doc.update(id, patch);
      }
    } finally {
      this.syncing = false;
    }
    this.resync();
  }

  stop() {
    this.off?.();
    this.off = null;
  }
}

export function startGlobalEdit(app) {
  const editor = app.editor;
  const ref = referenceNode(editor);
  if (!ref || (ref.type !== 'path' && ref.type !== 'compound')) throw new UserError('Select a path or compound path to start a global edit.');
  const ids = similarObjects(editor.doc, ref);
  if (ids.length < 2) throw new UserError('No other objects match the selected object.');
  app.stopGlobalEdit?.();
  const session = new GlobalEdit(app, editor, ids);
  app.globalEdit = session;
  editor.select(ids);
  app.notify(`Editing ${ids.length} matching objects together. Choose Stop Global Edit when done.`, { timeout: 5000 });
  return session;
}

// ---- Saved selections ----

export function savedSelectionsOf(doc) {
  return doc.root.savedSelections || [];
}

export function saveSelection(doc, name, ids) {
  const list = savedSelectionsOf(doc).filter((s) => s.name !== name);
  doc.updateRoot({ savedSelections: [...list, { id: uid('sel'), name, ids: [...ids] }] });
}

export function applySavedSelection(editor, id) {
  const s = savedSelectionsOf(editor.doc).find((x) => x.id === id);
  if (!s) return 0;
  const ids = s.ids.filter((nid) => editor.doc.has(nid));
  editor.select(ids);
  editor.activeSavedSelection = s.id;
  return ids.length;
}

/** The saved selection last saved or chosen in this window (Update Selection's target), if it still exists. */
export function activeSavedSelection(editor) {
  const id = editor?.activeSavedSelection;
  return (id && savedSelectionsOf(editor.doc).find((s) => s.id === id)) || null;
}

/** Update Selection: the active saved selection now holds the current selection. */
export function updateSavedSelection(editor) {
  const s = activeSavedSelection(editor);
  if (!s) throw new UserError('Save or choose a saved selection first.');
  const ids = editor.topSelection();
  editor.doc.transact('Update Selection', () =>
    editor.doc.updateRoot({ savedSelections: savedSelectionsOf(editor.doc).map((x) => (x.id === s.id ? { ...x, ids: [...ids] } : x)) }),
  );
  return s;
}

async function saveSelectionDialog(app) {
  const ed = app.editor;
  const n = savedSelectionsOf(ed.doc).length + 1;
  const res = await app.dialogs.form({ title: 'Save Selection', fields: [{ key: 'name', label: 'Name', type: 'text', value: `Selection ${n}` }] });
  const name = res?.name?.trim();
  if (!name) return;
  const exists = savedSelectionsOf(ed.doc).some((s) => s.name === name);
  if (exists && !(await app.dialogs.confirm({ title: 'Save Selection', message: `Replace the saved selection "${name}"?`, okLabel: 'Replace' }))) return;
  ed.doc.transact('Save Selection', () => saveSelection(ed.doc, name, ed.topSelection()));
  ed.activeSavedSelection = savedSelectionsOf(ed.doc).find((s) => s.name === name)?.id || null;
}

async function editSelectionsDialog(app) {
  const ed = app.editor;
  const doc = ed.doc;
  let list = savedSelectionsOf(doc).map((s) => ({ ...s }));
  if (!list.length) {
    app.notify('There are no saved selections in this document.');
    return;
  }
  const rows = h('ul.saved-sel-list', { 'aria-label': 'Saved selections' });
  const render = () => {
    rows.replaceChildren(
      ...list.map((s) => {
        const name = h('input', { type: 'text', value: s.name, 'aria-label': 'Selection name', spellcheck: false, oninput: () => (s.name = name.value) });
        const count = s.ids.filter((id) => doc.has(id)).length;
        return h(
          'li.saved-sel-row',
          name,
          h('span.muted', `${count} object${count === 1 ? '' : 's'}`),
          h('button.btn.small', { type: 'button', onclick: () => applySavedSelection(ed, s.id) }, 'Select'),
          h('button.btn.small', { type: 'button', 'aria-label': `Delete ${s.name}`, onclick: () => {
            list = list.filter((x) => x !== s);
            render();
          } }, 'Delete'),
        );
      }),
    );
    if (!list.length) rows.append(h('li.muted', 'No saved selections.'));
  };
  render();
  const ok = await app.dialogs.open({ title: 'Edit Selection', body: h('div.form', rows), buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: true }] });
  if (!ok) return;
  const next = list.filter((s) => s.name.trim()).map((s) => ({ id: s.id, name: s.name.trim(), ids: s.ids }));
  doc.transact('Edit Selection', () => doc.updateRoot({ savedSelections: next }));
}

export function registerSelectCommands(app) {
  app.stopGlobalEdit = () => {
    if (!app.globalEdit) return;
    app.globalEdit.stop();
    app.globalEdit = null;
    app.notify('Global edit stopped.', { polite: true });
  };
  app.on('active-editor', (ed) => {
    if (app.globalEdit && app.globalEdit.editor !== ed) app.stopGlobalEdit();
  });
  app.on('closed', (ed) => {
    if (app.globalEdit?.editor === ed) app.stopGlobalEdit();
  });
  app.commands.register([
    { id: 'select.same.shapesText', label: 'Shapes & Text', enabled: hasSel, run: (a) => selectSameShapesText(a.editor) },
    { id: 'select.same.appearanceAttribute', label: 'Appearance Attribute', enabled: hasSel, run: (a) => selectSameAppearanceAttribute(a.editor) },
    { id: 'select.same.graphicStyle', label: 'Graphic Style', enabled: hasSel, run: (a) => selectSameGraphicStyle(a.editor) },
    {
      id: 'select.object.handles',
      label: 'Direction Handles',
      enabled: (a) => Boolean(a.editor?.selectedNodes().some((n) => n.type === 'path' || n.type === 'compound' || n.type === 'group')),
      run: (a) => selectDirectionHandles(a),
    },
    {
      id: 'select.globalEdit',
      label: (a) => (a.globalEdit ? 'Stop Global Edit' : 'Start Global Edit'),
      enabled: (a) => Boolean(a.globalEdit) || hasSel(a),
      run: (a) => (a.globalEdit ? a.stopGlobalEdit() : startGlobalEdit(a)),
    },
    { id: 'select.save', label: 'Save Selection...', enabled: hasSel, run: (a) => saveSelectionDialog(a) },
    { id: 'select.edit', label: 'Edit Selection...', enabled: (a) => Boolean(a.editor && savedSelectionsOf(a.editor.doc).length), run: (a) => editSelectionsDialog(a) },
    {
      id: 'select.update',
      label: (a) => (activeSavedSelection(a.editor) ? `Update Selection "${activeSavedSelection(a.editor).name}"` : 'Update Selection'),
      enabled: (a) => Boolean(hasSel(a) && activeSavedSelection(a.editor)),
      run: (a) => {
        const s = updateSavedSelection(a.editor);
        a.notify(`Updated the saved selection "${s.name}".`, { polite: true });
      },
    },
  ]);
  app.menuSources.set('savedSelections', (a) =>
    a.editor
      ? savedSelectionsOf(a.editor.doc).map((s) => ({ type: 'cmd', label: s.name, enabled: true, checked: a.editor.activeSavedSelection === s.id, run: () => applySavedSelection(a.editor, s.id) }))
      : [],
  );
}
