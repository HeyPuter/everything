/**
 * Clipboard: Cut, Copy, Paste, Paste in Front/Back/Place, Paste on All
 * Artboards. The app keeps its own clipboard (full fidelity, works without
 * clipboard permissions) and also writes SVG text to the system clipboard
 * so artwork can be pasted into other apps. Pasting from the system
 * clipboard (SVG markup or images) goes through `app.importers`.
 */
import { UserError } from '../lib/errors.js';
import { selectionBounds, transformNodes, unionRect } from '../model/geometry.js';
import { pathBounds, segmentCount } from '../model/bezier.js';
import { createPath } from '../model/nodes.js';
import { translate } from '../lib/matrix.js';
import { deleteSelection, selectedSegment, selectedSegmentHits } from './object-ops.js';

export const clipboard = { data: null };

/**
 * Feature hooks: [{ copy(doc, ids, data), paste(doc, data, items), targetLayer(doc, data, item) }].
 * copy() can add what the copied objects need to the clipboard data (e.g.
 * the brush or symbol definitions they use); paste() runs inside the Paste
 * transaction, before the objects arrive, to bring that into the target
 * document, and may return the items to insert instead (e.g. with symbol
 * references renamed). targetLayer() may name the layer an item pastes
 * into (Paste Remembers Layers); null keeps the usual target.
 */
export const clipboardHooks = [];

/**
 * Segments of partially selected paths (Direct Selection), per path id: the
 * clicked segment, the segments a marquee crossed, or the segments touching
 * selected anchors. These are exactly what Delete removes.
 */
export function partialSegments(editor) {
  const { doc } = editor;
  const out = new Map();
  const seg = selectedSegment(editor);
  if (seg) return out.set(seg.id, [seg.index]);
  for (const [id, set] of editor.anchors) {
    const n = doc.get(id);
    if (!n?.anchors || !set.size || set.size >= n.anchors.length) continue;
    const count = segmentCount(n.anchors, n.closed);
    const idx = [];
    for (let i = 0; i < count; i++) if (set.has(i) || set.has((i + 1) % n.anchors.length)) idx.push(i);
    out.set(id, idx);
  }
  for (const [id, indices] of selectedSegmentHits(editor)) out.set(id, indices);
  return out;
}

/** Open paths made of the given segments of a path (consecutive segments join into one path). */
export function segmentRuns(path, indices) {
  const n = path.anchors.length;
  const count = segmentCount(path.anchors, path.closed);
  const set = new Set(indices.filter((i) => i >= 0 && i < count));
  if (!set.size) return [];
  if (set.size === count && path.closed) return [{ anchors: path.anchors, closed: true }];
  // Start each run where the previous segment is not selected (wrapping on closed paths).
  const prev = (i) => (i > 0 ? i - 1 : path.closed ? count - 1 : -1);
  const runs = [];
  for (const i of [...set].sort((a, b) => a - b)) {
    if (set.has(prev(i))) continue;
    const pts = [path.anchors[i]];
    let j = i;
    do {
      pts.push(path.anchors[(j + 1) % n]);
      j = (j + 1) % count;
    } while (set.has(j) && j !== i && (path.closed || j > 0));
    const last = pts.length - 1;
    pts[0] = { ...pts[0], ix: pts[0].x, iy: pts[0].y };
    pts[last] = { ...pts[last], ox: pts[last].x, oy: pts[last].y };
    runs.push({ anchors: pts, closed: false });
  }
  return runs;
}

export function copy(editor, { cut = false } = {}) {
  const { doc } = editor;
  const ids = editor.topSelection();
  if (!ids.length) return false;
  // A partial Direct Selection copies just its segments, as open paths.
  const parts = partialSegments(editor);
  const items = [];
  const whole = [];
  let bounds = null;
  for (const id of ids) {
    const n = doc.get(id);
    if (parts.has(id)) {
      for (const run of segmentRuns(n, parts.get(id))) {
        const piece = { ...n, id: createPath([], false).id, anchors: run.anchors, closed: run.closed, shape: undefined };
        items.push({ root: piece.id, nodes: [piece] });
        bounds = unionRect(bounds, pathBounds(run.anchors, run.closed));
      }
    } else if (editor.anchors.get(id)?.size === 0) {
      // A path the marquee touched without selecting any of it.
    } else {
      items.push(doc.exportSubtree(id));
      whole.push(id);
    }
  }
  if (!items.length) return false;
  clipboard.data = {
    items,
    bounds: unionRect(bounds, selectionBounds(doc, whole)),
    artboard: editor.artboard(),
    assets: collectAssets(doc, whole),
    stamp: Date.now(),
  };
  for (const hk of clipboardHooks) hk.copy?.(doc, whole, clipboard.data);
  if (cut) deleteSelection(editor, 'Cut');
  return true;
}

function collectAssets(doc, ids) {
  const out = {};
  for (const id of ids) {
    for (const n of [doc.get(id), ...doc.descendants(id)]) {
      if (n?.type === 'image' && doc.assets.has(n.asset)) out[n.asset] = doc.assets.get(n.asset);
    }
  }
  return out;
}

/**
 * Paste. mode:
 *   'center'  centered in the view (Edit > Paste)
 *   'front'   in place, above the selection (Paste in Front)
 *   'back'    in place, below the selection (Paste in Back)
 *   'place'   in place, on top of the active layer (Paste in Place)
 *   'all'     in place on every artboard (Paste on All Artboards)
 */
export function paste(editor, mode = 'center') {
  const data = clipboard.data;
  if (!data) return false;
  const { doc } = editor;
  for (const [id, a] of Object.entries(data.assets || {})) if (!doc.assets.has(id)) doc.assets.set(id, a);
  const pasted = [];
  doc.transact('Paste', () => {
    const sel = editor.topSelection();
    let parentId = editor.targetLayer().id;
    let index = Infinity;
    if (mode === 'center' || mode === 'place') {
      // Paste and Paste in Place follow the drawing mode (behind the selection, inside a path).
      ({ parentId, index } = editor.drawTarget());
    } else if ((mode === 'front' || mode === 'back') && sel.length) {
      const anchorId = mode === 'front' ? sel[sel.length - 1] : sel[0];
      const node = doc.get(anchorId);
      parentId = node.parent;
      const parent = doc.get(parentId);
      index = parent.children.indexOf(anchorId) + (mode === 'front' ? 1 : 0);
    } else if (mode === 'back') index = 0;
    if (doc.isLocked(parentId)) parentId = doc.layers().find((l) => !l.locked && !l.hidden)?.id;
    if (!parentId) throw new UserError('All layers are locked or hidden.');
    let items = data.items;
    for (const hk of clipboardHooks) items = hk.paste?.(doc, data, items) || items;
    const placeOnce = (dx, dy) => {
      const ids = [];
      let i = index;
      for (const item of items) {
        // Paste Remembers Layers: a hook may send the item back to the layer it came from.
        const into = mode === 'front' || mode === 'back' ? null : clipboardHooks.reduce((r, hk) => r || hk.targetLayer?.(doc, data, item) || null, null);
        const node = into ? doc.importSubtree(item, into) : doc.importSubtree(item, parentId, i);
        if (Number.isFinite(i)) i++;
        ids.push(node.id);
      }
      if (dx || dy) transformNodes(doc, ids, translate(dx, dy));
      pasted.push(...ids);
    };
    if (mode === 'all') {
      const src = data.artboard;
      for (const a of doc.artboards) placeOnce(src ? a.x - src.x : 0, src ? a.y - src.y : 0);
    } else if (mode === 'center') {
      // Edit > Paste centers the artwork in the view.
      const b = data.bounds;
      const v = editor.view;
      const c = v.toDoc(v.width / 2, v.height / 2);
      placeOnce(0, 0);
      if (b) transformNodes(doc, pasted, translate(c.x - (b.x + b.w / 2), c.y - (b.y + b.h / 2)));
    } else placeOnce(0, 0);
  });
  editor.select(pasted);
  return true;
}
