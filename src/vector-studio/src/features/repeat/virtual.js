/**
 * Virtual copies for live artwork: a node and its whole subtree moved by a
 * matrix, with fresh virtual ids, ready to return from a live kind's
 * generate(). Every copy names the document object it came from in
 * `source`, so clicking a copy picks that object (and the live group above
 * it with the Selection tool). Nested live objects stay live: their
 * parameters move with the matrix through the kind's transformParams.
 */
import { virtualId, isVirtualId } from '../../model/live.js';
import { transformPatches, nodeBounds, unionRect } from '../../model/geometry.js';
import { isIdentity } from '../../lib/matrix.js';
import { remapIdRefs } from '../../model/document.js';

/**
 * A virtual copy of `node` transformed by `m`. Descendants go into `extra`
 * (id -> node); the copy itself is returned (callers add it to `items`).
 * `patch` (optional) is merged into the top copy (e.g. a paint override).
 */
export function transformedCopy(doc, node, m, extra, { base = 'copy', patch = null } = {}) {
  const patches = isIdentity(m) ? new Map() : transformPatches(doc, node, m, {});
  const ids = new Map();
  const copy = (n) => {
    let out = { ...n, ...(patches.get(n.id) || {}), id: virtualId(base) };
    ids.set(n.id, out.id);
    const src = isVirtualId(n.id) ? n.source : n.id;
    if (src) out.source = src;
    else delete out.source;
    if (n.children) {
      out.children = [];
      for (const c of n.children) {
        const cn = doc.get(c);
        if (!cn) continue;
        const cc = copy(cn);
        cc.parent = out.id;
        extra.set(cc.id, cc);
        out.children.push(cc.id);
      }
      // Nested live objects that name their children (interlace zones) name the copies.
      out = remapIdRefs(out, ids);
    }
    return out;
  };
  const out = copy(node);
  if (patch) Object.assign(out, patch);
  return out;
}

/** Union of the geometric bounds of a live group's visible children (its source artwork). */
export function childrenBounds(doc, node, ids = node.children) {
  let b = null;
  for (const c of ids || []) {
    const cn = doc.get(c);
    if (cn && !cn.hidden) b = unionRect(b, nodeBounds(doc, cn));
  }
  return b;
}

/** Bounds of the children as seen through matrix m (exact for paths: their copies are measured). */
export function childrenBoundsIn(doc, node, m, ids = node.children) {
  if (isIdentity(m)) return childrenBounds(doc, node, ids);
  const extra = new Map();
  const view = { get: (id) => extra.get(id) || doc.get(id), has: (id) => extra.has(id) || doc.has(id), assets: doc.assets, root: doc.root };
  let b = null;
  for (const c of ids || []) {
    const cn = doc.get(c);
    if (!cn || cn.hidden) continue;
    const v = transformedCopy(doc, cn, m, extra);
    extra.set(v.id, v);
    b = unionRect(b, nodeBounds(view, v));
  }
  return b;
}
