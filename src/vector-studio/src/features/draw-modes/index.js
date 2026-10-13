/**
 * Drawing modes (Tools panel, Shift+D cycles): Draw Normal puts new
 * artwork on top of the target layer; Draw Behind puts it just behind the
 * selection (or at the bottom of the layer); Draw Inside puts it inside the
 * selected path, which becomes a clipping path the first time something is
 * drawn (its fill stays as the background, its stroke on top). Dashed
 * corners mark the Draw Inside object.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { overlayHooks } from '../../render/overlay.js';
import { createGroup } from '../../model/nodes.js';
import { nodeBounds } from '../../model/geometry.js';

export const DRAW_MODES = ['normal', 'behind', 'inside'];
const LABELS = { normal: 'Draw Normal', behind: 'Draw Behind', inside: 'Draw Inside' };

/** The current mode of an editor ('normal' when its Draw Inside object is gone). */
export function drawMode(editor) {
  if (!editor) return 'normal';
  if (editor.drawMode === 'inside' && !insideObject(editor)) return 'normal';
  return editor.drawMode || 'normal';
}

/** The Draw Inside object (the future or current clipping path), if still usable. */
function insideObject(editor) {
  const n = editor.drawInsideId && editor.doc.get(editor.drawInsideId);
  return n && (n.type === 'path' || n.type === 'compound') && !editor.doc.isLocked(n.id) ? n : null;
}

/** A single selected path or compound path to draw inside, or null. */
function insideCandidate(editor) {
  const top = editor.topSelection();
  if (top.length !== 1) return null;
  const n = editor.doc.get(top[0]);
  if (n?.type === 'path' || n?.type === 'compound') return n;
  // A clipping group: draw inside its clipping path.
  if (n?.type === 'group' && n.clip) {
    const mask = editor.doc.get(n.children[n.children.length - 1]);
    if (mask?.type === 'path' || mask?.type === 'compound') return mask;
  }
  return null;
}

/**
 * The clipping group around the Draw Inside object, made on first use: the
 * object becomes its clipping path (keeping its stroke on top) and a copy
 * with its fill and no stroke becomes the background.
 */
function ensureClipGroup(editor, obj) {
  const doc = editor.doc;
  const parent = doc.get(obj.parent);
  if (parent?.type === 'group' && parent.clip && parent.children[parent.children.length - 1] === obj.id) return parent;
  const index = parent.children.indexOf(obj.id);
  const g = createGroup([], { clip: true, name: '' });
  doc.insert(g, parent.id, index);
  if (obj.fill) {
    const { node: bg, descendants } = doc.cloneSubtree(obj.id);
    doc.insert({ ...bg, stroke: null }, g.id, Infinity, descendants);
  }
  doc.move(obj.id, g.id);
  doc.update(obj.id, { fill: null });
  return doc.get(g.id);
}

export function install(app) {
  const setMode = (mode) => {
    const ed = app.editor;
    if (!ed) return;
    if (mode === 'inside') {
      const obj = insideCandidate(ed);
      if (!obj) {
        app.notify('Select one path or compound path to draw inside.');
        return;
      }
      ed.drawInsideId = obj.id;
    } else ed.drawInsideId = null;
    ed.drawMode = mode;
    refresh();
    ed.emit('overlay');
    app.notify(LABELS[mode], { polite: true });
  };

  // Drawing tools ask the editor where new artwork goes.
  const hook = (editor, base) => {
    const mode = drawMode(editor);
    const doc = editor.doc;
    if (mode === 'behind') {
      const parent = doc.get(base.parentId);
      // Just behind the backmost selected object in the target container, else at its bottom.
      const idx = editor.topSelection().map((id) => parent.children.indexOf(id)).filter((i) => i >= 0);
      return { parentId: base.parentId, index: idx.length ? Math.min(...idx) : 0 };
    }
    if (mode === 'inside') {
      const g = ensureClipGroup(editor, insideObject(editor));
      // Above the content drawn so far, below the clipping path.
      return { parentId: g.id, index: g.children.length - 1 };
    }
    return null;
  };
  const attach = (ed) => {
    if (ed && !ed.drawTargetHook) ed.drawTargetHook = hook;
  };
  app.on('active-editor', () => {
    attach(app.editor);
    refresh();
  });
  attach(app.editor);

  for (const mode of DRAW_MODES) {
    app.commands.register({
      id: `view.drawMode.${mode}`,
      label: LABELS[mode],
      enabled: (a) => Boolean(a.editor) && (mode !== 'inside' || Boolean(insideCandidate(a.editor)) || drawMode(a.editor) === 'inside'),
      checked: (a) => drawMode(a.editor) === mode,
      run: () => setMode(mode),
    });
  }
  app.commands.register({
    id: 'view.drawMode.cycle',
    label: 'Cycle Drawing Modes',
    shortcut: 'Shift+D',
    enabled: (a) => Boolean(a.editor),
    run: (a) => {
      const cur = drawMode(a.editor);
      let next = DRAW_MODES[(DRAW_MODES.indexOf(cur) + 1) % DRAW_MODES.length];
      // Draw Inside needs a path to draw into; without one the cycle goes back to normal.
      if (next === 'inside' && !insideCandidate(a.editor)) next = 'normal';
      setMode(next);
    },
  });

  // ---- Tools panel button ----
  const btn = h('button.tool-btn.small.draw-mode-btn', { type: 'button', 'aria-haspopup': 'menu', onclick: (e) => app.showMenuAt(e.currentTarget, DRAW_MODES.map((m) => `view.drawMode.${m}`), 'Drawing Modes') });
  function refresh() {
    const mode = drawMode(app.editor);
    btn.replaceChildren(icon(`draw-${mode}`, 18));
    btn.setAttribute('aria-label', `Drawing Modes: ${LABELS[mode]}`);
    btn.setAttribute('data-tip', `Drawing Modes: ${LABELS[mode]} (Shift+D)`);
  }
  refresh();
  const mount = () => {
    const misc = app.toolbar?.el.querySelector('.toolbar-misc');
    if (misc && !misc.contains(btn)) misc.prepend(btn);
  };
  mount();
  app.on('chrome', mount);

  // ---- Draw Inside marker: dashed corners around the object ----
  overlayHooks.add((ctx, editor) => {
    if (editor !== app.editor || drawMode(editor) !== 'inside') return;
    const obj = insideObject(editor);
    const b = obj && nodeBounds(editor.doc, obj);
    if (!b) return;
    const a = editor.view.toScreen(b.x, b.y);
    const c = editor.view.toScreen(b.x + b.w, b.y + b.h);
    const x0 = Math.min(a.x, c.x) - 4;
    const y0 = Math.min(a.y, c.y) - 4;
    const x1 = Math.max(a.x, c.x) + 4;
    const y1 = Math.max(a.y, c.y) + 4;
    const l = Math.min(14, (x1 - x0) / 3, (y1 - y0) / 3);
    ctx.save();
    ctx.strokeStyle = '#4f80ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]]) {
      ctx.moveTo(x + dx * l, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * l);
    }
    ctx.stroke();
    ctx.restore();
  });
}
