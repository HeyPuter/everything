/**
 * Object menu commands: Ungroup All, Lock / Hide All Artwork Above, Create
 * Trim Marks, Path > Smooth, Align center on both axes and the Align To
 * choices, Artboards > Switch Orientation and Clipping Mask > Edit Contents.
 */
import { h } from '../../lib/dom.js';
import { createGroup, createPath } from '../../model/nodes.js';
import { anchor, flattenPath, fitCurve, autoSmooth, pathBounds } from '../../model/bezier.js';
import { nodeBounds, rectsIntersect, selectionBounds } from '../../model/geometry.js';
import { align } from '../../ops/object-ops.js';
import { alignTarget, setKeyObject } from '../artboards/align-panel.js';
import { updateArtboard } from '../artboards/artboard-ops.js';

const hasDoc = (a) => Boolean(a.editor);
const hasSel = (a) => Boolean(a.editor?.selection.size);

// ---- Ungroup All ----

/** Plain groups (not live artwork) at or under the given ids, deepest first. */
function plainGroupsUnder(doc, ids) {
  const out = [];
  const visit = (id) => {
    const n = doc.get(id);
    if (!n || n.type !== 'group' || n.live || n.blend) return;
    for (const c of n.children) visit(c);
    out.push(id);
  };
  for (const id of ids) visit(id);
  return out;
}

/** Release every group in the selection, nested ones included. Returns the released objects. */
export function ungroupAll(editor) {
  const { doc } = editor;
  const top = editor.topSelection();
  const groups = plainGroupsUnder(doc, top);
  if (!groups.length) return [];
  const removed = new Set(groups);
  // What ends up in place of each selected object: itself, or the non-group objects it held.
  const terminals = (id) => (removed.has(id) ? doc.get(id).children.flatMap(terminals) : [id]);
  const result = top.flatMap(terminals);
  doc.transact('Ungroup All', () => {
    for (const id of groups) {
      const g = doc.get(id);
      const parent = doc.get(g.parent);
      let index = parent.children.indexOf(id);
      for (const c of g.children.slice()) doc.move(c, parent.id, index++);
      doc.remove(id);
    }
  });
  editor.select(result.filter((id) => doc.has(id)));
  return result;
}

// ---- Lock / Hide All Artwork Above ----

/** Top-level objects stacked above the selection that overlap it. */
export function artworkAbove(editor) {
  const { doc } = editor;
  const sel = editor.topSelection();
  if (!sel.length) return [];
  const order = doc.paintOrder();
  const topIndex = Math.max(...sel.map((id) => order.get(id) ?? 0));
  const b = selectionBounds(doc, sel, true);
  if (!b) return [];
  const chosen = new Set(sel);
  const out = [];
  // Sublayers are looked into, never locked or hidden themselves (Unlock All and Show All leave layers alone).
  const visit = (lid) => {
    const layer = doc.get(lid);
    if (!layer || layer.locked || layer.hidden) return;
    for (const id of layer.children) {
      const n = doc.get(id);
      if (!n || chosen.has(id) || n.locked || n.hidden) continue;
      if (n.type === 'layer') {
        visit(id);
        continue;
      }
      if ((order.get(id) ?? 0) <= topIndex) continue;
      const nb = nodeBounds(doc, n);
      if (nb && rectsIntersect(nb, b)) out.push(id);
    }
  };
  for (const lid of doc.root.children) visit(lid);
  return out;
}

function lockOrHideAbove(editor, key) {
  const ids = artworkAbove(editor);
  if (!ids.length) return 0;
  const { doc } = editor;
  doc.transact(key === 'locked' ? 'Lock All Artwork Above' : 'Hide All Artwork Above', () => ids.forEach((id) => doc.update(id, { [key]: true })));
  return ids.length;
}

// ---- Trim marks ----

/**
 * Crop marks around a rectangle: two short lines at each corner, set off
 * from it by `offset`, `length` long, in a hairline registration black.
 */
export function trimMarkPaths(r, { offset = 6, length = 18, width = 0.3, color = '#000000' } = {}) {
  const line = (x1, y1, x2, y2) => createPath([anchor(x1, y1), anchor(x2, y2)], false, { fill: null, stroke: { type: 'solid', color }, strokeWidth: width }, { name: '' });
  const out = [];
  const xs = [r.x, r.x + r.w];
  const ys = [r.y, r.y + r.h];
  for (const [i, x] of xs.entries()) {
    const sx = i === 0 ? -1 : 1;
    for (const [j, y] of ys.entries()) {
      const sy = j === 0 ? -1 : 1;
      // Horizontal mark beside the corner, vertical mark above/below it.
      out.push(line(x + sx * offset, y, x + sx * (offset + length), y));
      out.push(line(x, y + sy * offset, x, y + sy * (offset + length)));
    }
  }
  return out;
}

export function createTrimMarks(editor) {
  const { doc } = editor;
  const sel = editor.topSelection();
  const r = sel.length ? selectionBounds(doc, sel, true) : editor.artboard();
  if (!r) return null;
  const layer = editor.targetLayer();
  if (!layer) return null;
  let gid = null;
  doc.transact('Create Trim Marks', () => {
    const paths = trimMarkPaths(r);
    const g = createGroup([], { name: 'Trim Marks' });
    const t = editor.newArtTarget();
    doc.insert(g, t.parentId, t.index);
    for (const p of paths) doc.insert(p, g.id);
    gid = g.id;
  });
  editor.select([gid]);
  return gid;
}

// ---- Smooth ----

/**
 * Smooth anchors: `amount` 0-100. Up to 40 the handles blend toward smooth
 * (Catmull-Rom style) handles; past that the outline is refit with fewer
 * anchors, within a tolerance that grows with the amount.
 */
export function smoothAnchors(anchors, closed, amount) {
  if (!(amount > 0) || anchors.length < 2) return anchors;
  const w = Math.min(1, amount / 40);
  const blended = anchors.map((a, i) => {
    const s = autoSmooth(anchors, i, closed);
    return { x: a.x, y: a.y, ix: a.ix + (s.ix - a.ix) * w, iy: a.iy + (s.iy - a.iy) * w, ox: a.ox + (s.ox - a.ox) * w, oy: a.oy + (s.oy - a.oy) * w };
  });
  if (amount <= 40 || anchors.length < 3) return blended;
  const b = pathBounds(blended, closed);
  const diag = Math.hypot(b.w, b.h) || 1;
  const tol = ((amount - 40) / 60) * diag * 0.03;
  const pts = flattenPath(blended, closed, Math.max(0.05, tol / 8));
  if (closed && pts.length) pts.push({ ...pts[0] });
  let fit = fitCurve(pts, Math.max(0.01, tol * tol));
  if (closed && fit.length > 2) {
    // The fit starts and ends on the same point: fold the last anchor into the first.
    const last = fit.pop();
    fit[0] = { ...fit[0], ix: last.ix, iy: last.iy };
  }
  if (fit.length >= blended.length || fit.length < (closed ? 3 : 2)) return blended;
  return fit;
}

function smoothTargets(editor) {
  const { doc } = editor;
  const out = [];
  const visit = (n) => {
    if (!n || n.locked) return;
    if (n.type === 'path' && n.anchors.length > 1) out.push(n);
    else if (n.children) for (const c of n.children) visit(doc.get(c));
  };
  for (const id of editor.selection) visit(doc.get(id));
  return [...new Map(out.map((n) => [n.id, n])).values()];
}

export function applySmooth(doc, nodes, amount) {
  for (const n of nodes) doc.update(n.id, { anchors: smoothAnchors(n.anchors, n.closed, amount), shape: undefined });
}

async function smoothDialog(app) {
  const ed = app.editor;
  const doc = ed.doc;
  const nodes = smoothTargets(ed);
  if (!nodes.length) {
    app.notify('Select paths to smooth.');
    return;
  }
  const count = (amount) => nodes.reduce((s, n) => s + smoothAnchors(n.anchors, n.closed, amount).length, 0);
  const before = nodes.reduce((s, n) => s + n.anchors.length, 0);
  const range = h('input', { type: 'range', id: 'smooth-amount', min: 0, max: 100, step: 1, value: 0 });
  const out = h('output.range-out', { for: 'smooth-amount' }, '0');
  const info = h('p.form-help', { 'aria-live': 'polite' });
  const preview = h('input', { type: 'checkbox', id: 'smooth-preview', checked: true });
  let tx = doc.begin('Smooth');
  const apply = () => {
    const v = Number(range.value);
    out.textContent = String(v);
    for (const n of nodes) doc.update(n.id, { anchors: n.anchors, shape: n.shape });
    if (preview.checked && v > 0) applySmooth(doc, nodes, v);
    info.textContent = `Anchor points: ${before} → ${v > 0 ? count(v) : before}`;
  };
  const auto = h('button.btn.small', {
    type: 'button',
    onclick: () => {
      // The smallest amount that removes at least a fifth of the anchors (or the strongest).
      let pick = 100;
      for (let v = 45; v <= 100; v += 5) {
        if (count(v) <= before * 0.8) {
          pick = v;
          break;
        }
      }
      range.value = String(pick);
      apply();
    },
  }, 'Auto-Smooth');
  range.addEventListener('input', apply);
  preview.addEventListener('change', apply);
  apply();
  const body = h(
    'div.form.smooth-form',
    h('div.form-row', h('label', { for: 'smooth-amount' }, 'Smoothing'), h('div.range-wrap', h('span.muted', { 'aria-hidden': 'true' }, 'Less'), range, h('span.muted', { 'aria-hidden': 'true' }, 'More'), out)),
    info,
    h('div.smooth-actions', auto, h('div.check-row', preview, h('label', { for: 'smooth-preview' }, 'Preview'))),
  );
  let res = null;
  try {
    res = await app.dialogs.open({ title: 'Smooth', body, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => ({ amount: Number(range.value) }) }] });
  } finally {
    if (!res) {
      tx.cancel();
      tx = null;
    }
  }
  if (!res) return;
  if (!(res.amount > 0)) {
    // No smoothing: no change and no undo step.
    tx.cancel();
    return;
  }
  for (const n of nodes) doc.update(n.id, { anchors: n.anchors, shape: n.shape });
  applySmooth(doc, nodes, res.amount);
  tx.commit();
}

// ---- Clipping mask: Edit Contents ----

function clipContext(editor) {
  const { doc } = editor;
  const nodes = editor.selectedNodes();
  const groups = nodes.filter((n) => n.type === 'group' && n.clip && n.children.length > 1);
  if (groups.length) return { mode: 'contents', groups };
  const parents = [...new Set(nodes.map((n) => doc.get(n.parent)).filter((p) => p?.type === 'group' && p.clip))];
  if (parents.length) return { mode: 'mask', groups: parents };
  return null;
}

export function editClipContents(editor) {
  const ctx = clipContext(editor);
  if (!ctx) return false;
  const ids = [];
  for (const g of ctx.groups) {
    const kids = g.children;
    if (ctx.mode === 'contents') ids.push(...kids.slice(0, -1));
    else ids.push(kids[kids.length - 1]);
  }
  editor.select(ids);
  return true;
}

// ---- Artboards ----

export function switchOrientation(doc, index) {
  const a = doc.artboards[index];
  if (!a || a.w === a.h) return false;
  updateArtboard(doc, index, { w: a.h, h: a.w });
  return true;
}

export function registerObjectCommands(app) {
  const ed = () => app.editor;
  const target = (to) => (a) => {
    if (to === 'key') {
      const e = a.editor;
      if (!(a.alignKey && e?.selection.has(a.alignKey))) {
        const top = e?.topSelection();
        if (top?.length) setKeyObject(a, top[top.length - 1]);
      }
      a.alignTo = 'selection';
    } else {
      setKeyObject(a, null);
      a.alignTo = to;
    }
    a.dock?.update();
  };
  app.commands.register([
    {
      id: 'object.ungroupAll',
      label: 'Ungroup All',
      shortcut: 'Alt+Shift+G',
      enabled: (a) => Boolean(a.editor?.selectedNodes().some((n) => n.type === 'group' && !n.live && !n.blend)),
      run: () => ungroupAll(ed()),
    },
    {
      id: 'object.lockAbove',
      label: 'All Artwork Above',
      enabled: hasSel,
      run: (a) => {
        if (!lockOrHideAbove(ed(), 'locked')) a.notify('No artwork above the selection overlaps it.');
      },
    },
    {
      id: 'object.hideAbove',
      label: 'All Artwork Above',
      enabled: hasSel,
      run: (a) => {
        if (!lockOrHideAbove(ed(), 'hidden')) a.notify('No artwork above the selection overlaps it.');
      },
    },
    { id: 'object.trimMarks', label: 'Create Trim Marks', enabled: hasDoc, run: () => createTrimMarks(ed()) },
    { id: 'path.smooth', label: 'Smooth...', enabled: (a) => Boolean(a.editor && smoothTargets(a.editor).length), run: (a) => smoothDialog(a) },
    {
      id: 'align.center',
      label: 'Horizontal & Vertical Align Center',
      enabled: hasSel,
      run: (a) => {
        const e = a.editor;
        const key = a.alignKey && e.selection.has(a.alignKey) ? a.alignKey : null;
        const opts = { to: key ? 'key' : a.alignTo || 'selection', key, previewBounds: a.prefs.get('previewBounds') };
        e.doc.transact('Align', () => {
          align(e, 'hcenter', opts);
          align(e, 'vcenter', opts);
        });
      },
    },
    { id: 'align.toSelection', label: 'Align To Selection', enabled: hasDoc, checked: (a) => alignTarget(a) === 'selection', run: target('selection') },
    { id: 'align.toKeyObject', label: 'Align To Key Object', enabled: (a) => (a.editor?.topSelection().length || 0) >= 2, checked: (a) => alignTarget(a) === 'key', run: target('key') },
    { id: 'align.toArtboard', label: 'Align To Artboard', enabled: hasDoc, checked: (a) => alignTarget(a) === 'artboard', run: target('artboard') },
    {
      id: 'artboards.switchOrientation',
      label: 'Switch Orientation',
      enabled: (a) => {
        const b = a.editor?.artboard();
        return Boolean(b && b.w !== b.h);
      },
      run: () => {
        const e = ed();
        e.doc.transact('Switch Orientation', () => switchOrientation(e.doc, e.activeArtboard));
      },
    },
    {
      id: 'object.clipEdit',
      label: (a) => (a.editor && clipContext(a.editor)?.mode === 'mask' ? 'Edit Clipping Path' : 'Edit Contents'),
      enabled: (a) => Boolean(a.editor && clipContext(a.editor)),
      run: () => editClipContents(ed()),
    },
  ]);
}
