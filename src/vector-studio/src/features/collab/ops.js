/**
 * Edit batches for shared documents: what a committed transaction changed,
 * expressed so it can be replayed on a document that others changed too.
 *
 * A batch is { id, nodes: [op], assets: { id: asset }, comments: [op] }.
 * Node ops, applied in order:
 *   { id, put: node }                      create (or replace) a node
 *   { id, del: true }                      remove a node
 *   { id, set: {k: v}, unset: [k], kids }  change fields: every field is
 *                                          its own last-writer-wins register
 *                                          (geometry such as `anchors` is one
 *                                          value, so competing moves never mix);
 *                                          `kids` edits the children list as
 *                                          removals and insertions next to
 *                                          neighbours, so concurrent additions
 *                                          to one layer all survive.
 *
 * The worker gives every batch a sequence number, and every client folds
 * batches in that order with applyBatch(), so all copies converge. A
 * client's own unconfirmed batches are replayed on top of what it has
 * received (see session.js). After each batch the tree is repaired
 * deterministically: children of a removed container move up to its
 * parent, a node listed by two containers stays in the one its `parent`
 * names, and nodes whose container is gone move to the first layer.
 *
 * Shared by the browser and the collaboration worker.
 */
import { applyCommentOps } from './comments.js';

export const MAX_BATCH_OPS = 20000;
const ID = /^[A-Za-z0-9_-]{1,120}$/;

/** Structural equality for JSON values (node fields). */
export function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !same(a[k], b[k])) return false;
  return true;
}

/** Longest increasing subsequence of numbers: the indices that can stay put. */
function stableSet(positions) {
  const tails = [];
  const prev = new Array(positions.length).fill(-1);
  const tailIdx = [];
  for (let i = 0; i < positions.length; i++) {
    const v = positions[i];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const keep = new Set();
  let k = tailIdx[tails.length - 1];
  while (k !== undefined && k >= 0) {
    keep.add(k);
    k = prev[k];
  }
  return keep;
}

/**
 * Children-list edits turning `a` into `b`: ['-', id] removes, and
 * ['+', id, after, before] inserts after the `after` sibling (null: first),
 * or before `before` when `after` is gone (at the end when both are).
 */
export function listOps(a, b) {
  const ops = [];
  const inB = new Set(b);
  for (const id of a) if (!inB.has(id)) ops.push(['-', id]);
  const posA = new Map(a.map((id, i) => [id, i]));
  const common = b.filter((id) => posA.has(id));
  const keep = stableSet(common.map((id) => posA.get(id)));
  const stay = new Set(common.filter((_, i) => keep.has(i)));
  for (let i = 0; i < b.length; i++) {
    const id = b[i];
    if (stay.has(id)) continue;
    if (posA.has(id)) ops.push(['-', id]);
    ops.push(['+', id, i > 0 ? b[i - 1] : null, i < b.length - 1 ? b[i + 1] : null]);
  }
  return ops;
}

/** Apply children-list edits to a copy of `list`. */
export function applyListOps(list, ops) {
  const out = list.slice();
  for (const op of ops) {
    const [kind, id, after, before] = op;
    const at = out.indexOf(id);
    if (at >= 0) out.splice(at, 1);
    if (kind !== '+') continue;
    let i = -1;
    if (after == null) out.unshift(id);
    else if ((i = out.indexOf(after)) >= 0) out.splice(i + 1, 0, id);
    else if (before != null && (i = out.indexOf(before)) >= 0) out.splice(i, 0, id);
    else out.push(id);
  }
  return out;
}

/**
 * Node ops for a committed change: `before` and `after` map node ids to
 * their old and new values (undefined: absent).
 */
export function diffNodes(before, after) {
  const ops = [];
  for (const [id, old] of before) {
    const now = after.get(id);
    if (old === now) continue;
    if (old === undefined && now === undefined) continue;
    if (old === undefined) {
      ops.push({ id, put: now });
      continue;
    }
    if (now === undefined) {
      ops.push({ id, del: true });
      continue;
    }
    const op = { id };
    const set = {};
    const unset = [];
    for (const k of Object.keys(now)) {
      if (k === 'children' || k === 'id') continue;
      if (!same(old[k], now[k])) set[k] = now[k];
    }
    for (const k of Object.keys(old)) if (!(k in now)) unset.push(k);
    if (Object.keys(set).length) op.set = set;
    if (unset.length) op.unset = unset;
    if (Array.isArray(now.children) && !same(old.children || [], now.children)) op.kids = listOps(old.children || [], now.children);
    if (op.set || op.unset || op.kids) ops.push(op);
  }
  return ops;
}

/** The first layer of the document: where nodes without a container go. */
function fallbackLayer(store) {
  const root = store.get('root');
  for (const id of root?.children || []) if (store.get(id)?.type === 'layer') return id;
  return null;
}

/** Whether `ancestor` contains `id` (guards against cycles from concurrent moves). */
function containedIn(store, id, ancestor) {
  let n = store.get(id);
  for (let guard = 0; n && n.parent && guard < 10000; guard++) {
    if (n.parent === ancestor) return true;
    n = store.get(n.parent);
  }
  return false;
}

/**
 * Apply node ops to a store ({ get, set, delete, has }, such as a Map).
 * Returns the ids whose value changed (including repairs).
 */
export function applyNodeOps(store, ops) {
  const changed = new Set();
  const check = new Set(); // containers whose children lists need repair
  const removed = new Map(); // id -> { parent, children }
  for (const op of ops) {
    const id = op.id;
    const cur = store.get(id);
    if (op.del) {
      if (!cur || id === 'root') continue;
      removed.set(id, { parent: cur.parent, children: cur.children || [] });
      store.delete(id);
      changed.add(id);
      if (cur.parent) check.add(cur.parent);
      continue;
    }
    if (op.put) {
      if (id === 'root' && !op.put.children) continue;
      store.set(id, { ...op.put, id });
      changed.add(id);
      check.add(id);
      if (cur?.parent && cur.parent !== op.put.parent) check.add(cur.parent);
      if (op.put.parent) check.add(op.put.parent);
      continue;
    }
    if (!cur) continue; // removed elsewhere: removal wins over changes
    let next = op.set ? { ...cur, ...op.set, id } : { ...cur };
    if (op.unset) for (const k of op.unset) if (k !== 'id' && k !== 'children') delete next[k];
    if (op.kids && Array.isArray(cur.children)) next.children = applyListOps(cur.children, op.kids);
    store.set(id, next);
    changed.add(id);
    if (next.children) check.add(id);
    if (cur.parent !== next.parent) {
      if (cur.parent) check.add(cur.parent);
      if (next.parent) check.add(next.parent);
    }
  }
  // Children of a removed container that were not removed with it move up.
  for (const [id, info] of removed) {
    for (const c of info.children) {
      const child = store.get(c);
      if (!child || child.parent !== id) continue;
      let target = info.parent;
      while (target && !store.get(target) && removed.has(target)) target = removed.get(target).parent;
      if (!target || !store.get(target)?.children) target = fallbackLayer(store);
      if (!target) {
        store.delete(c);
        changed.add(c);
        continue;
      }
      store.set(c, { ...child, parent: target });
      const t = store.get(target);
      store.set(target, { ...t, children: [...t.children.filter((x) => x !== c), c] });
      changed.add(c);
      changed.add(target);
    }
  }
  // Containers list only existing nodes that name them as parent, once.
  for (const cid of check) {
    const c = store.get(cid);
    if (!c?.children) continue;
    const seen = new Set();
    const kids = c.children.filter((k) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return store.get(k)?.parent === cid;
    });
    if (kids.length !== c.children.length) {
      store.set(cid, { ...c, children: kids });
      changed.add(cid);
    }
  }
  // Every changed node sits in its container (or the first layer when that is gone).
  for (const id of [...changed]) {
    if (id === 'root') continue;
    const n = store.get(id);
    if (!n) continue;
    let pid = n.parent;
    let p = pid ? store.get(pid) : null;
    if (!p?.children || pid === id || containedIn(store, pid, id) || (n.type === 'layer' && pid !== 'root')) {
      pid = n.type === 'layer' ? 'root' : fallbackLayer(store);
      if (pid === id) pid = 'root';
      p = pid ? store.get(pid) : null;
      if (!p) {
        store.delete(id);
        changed.add(id);
        continue;
      }
      store.set(id, { ...n, parent: pid });
      // Remove it from wherever it was listed.
      const old = n.parent && store.get(n.parent);
      if (old?.children?.includes(id)) store.set(n.parent, { ...old, children: old.children.filter((x) => x !== id) });
      p = store.get(pid);
    }
    if (!p.children.includes(id)) {
      store.set(pid, { ...p, children: [...p.children, id] });
      changed.add(pid);
    }
  }
  return changed;
}

/**
 * Apply a whole batch to a document state:
 * { nodes: store, assets: Map-like, comments } -> changed node ids.
 * `comments` is replaced (immutable data).
 */
export function applyBatch(state, batch) {
  if (batch.assets) for (const [id, a] of Object.entries(batch.assets)) if (!state.assets.has(id)) state.assets.set(id, a);
  const changed = batch.nodes?.length ? applyNodeOps(state.nodes, batch.nodes) : new Set();
  if (batch.comments?.length) state.comments = applyCommentOps(state.comments, batch.comments);
  return changed;
}

/**
 * A copy-on-write view over a base Map: writes stay in the overlay, so a
 * client can replay its unconfirmed batches on the confirmed state cheaply.
 */
export class Overlay {
  constructor(base) {
    this.base = base;
    this.own = new Map();
  }

  get(id) {
    if (this.own.has(id)) return this.own.get(id);
    return this.base.get(id);
  }

  has(id) {
    return this.get(id) !== undefined;
  }

  set(id, value) {
    this.own.set(id, value);
    return this;
  }

  delete(id) {
    this.own.set(id, undefined);
    return true;
  }
}

/** Serializable state for the worker and for joining: plain objects. */
export function stateToJSON(state) {
  const nodes = {};
  for (const [id, n] of state.nodes) if (n !== undefined) nodes[id] = n;
  const assets = {};
  for (const [id, a] of state.assets) assets[id] = a;
  return { nodes, assets, comments: state.comments || null };
}

export function stateFromJSON(data) {
  return {
    nodes: new Map(Object.entries(data?.nodes || {})),
    assets: new Map(Object.entries(data?.assets || {})),
    comments: data?.comments || null,
  };
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const isBoard = (a) => Boolean(a) && typeof a === 'object' && finite(a.x) && finite(a.y) && finite(a.w) && finite(a.h) && a.w > 0 && a.h > 0;
/** Document root fields every copy relies on (the rules files are checked with on opening). */
const ROOT_FIELDS = {
  type: (v) => v === 'root',
  artboards: (v) => Array.isArray(v) && v.length > 0 && v.every(isBoard),
  guides: Array.isArray,
  swatches: Array.isArray,
  units: (v) => typeof v === 'string',
  name: (v) => typeof v === 'string',
  grid: (v) => Boolean(v) && typeof v === 'object' && finite(v.spacing) && finite(v.subdivisions) && v.spacing > 0 && v.subdivisions >= 1,
};

/**
 * Whether a node op would leave the document unusable for everyone: a root
 * whose required fields are missing or malformed, or another node posing as
 * the root.
 */
export function harmfulOp(op) {
  if (op.id !== 'root') return op.put?.type === 'root' || op.set?.type === 'root';
  if (op.del) return true;
  if (op.put) return !Object.entries(ROOT_FIELDS).every(([k, ok]) => ok(op.put[k])) || op.put.parent != null;
  if (op.set) for (const [k, v] of Object.entries(op.set)) if ((k === 'parent' && v != null) || (ROOT_FIELDS[k] && !ROOT_FIELDS[k](v))) return true;
  return Boolean(op.unset?.some((k) => k in ROOT_FIELDS));
}

/**
 * A batch without ops that would break the document (see harmfulOp). The
 * server refuses them; clients drop any an older server let through, all in
 * the same way, so their copies still agree.
 */
export function safeBatch(batch) {
  if (!batch.nodes?.some(harmfulOp)) return batch;
  return { ...batch, nodes: batch.nodes.filter((op) => !harmfulOp(op)) };
}

/** Check a batch's shape (not permissions). Throws a readable error. */
export function validateBatch(batch) {
  const bad = (m) => {
    throw Object.assign(new Error(m), { status: 400 });
  };
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) bad('Invalid edit.');
  if (typeof batch.id !== 'string' || !ID.test(batch.id)) bad('Invalid edit id.');
  const nodes = batch.nodes ?? [];
  if (!Array.isArray(nodes) || nodes.length > MAX_BATCH_OPS) bad('Invalid edit.');
  for (const op of nodes) {
    if (!op || typeof op !== 'object' || typeof op.id !== 'string' || !ID.test(op.id)) bad('Invalid object id.');
    const kinds = ['put', 'del', 'set', 'unset', 'kids'].filter((k) => op[k] !== undefined);
    if (!kinds.length) bad('Invalid edit.');
    if (op.del !== undefined && (op.del !== true || kinds.length > 1)) bad('Invalid removal.');
    if (op.put !== undefined) {
      if (kinds.length > 1 || !op.put || typeof op.put !== 'object' || Array.isArray(op.put) || typeof op.put.type !== 'string') bad('Invalid object.');
      if (op.put.children !== undefined && !(Array.isArray(op.put.children) && op.put.children.every((c) => typeof c === 'string'))) bad('Invalid object.');
    }
    if (op.id === 'root' && op.del) bad('The document root cannot be removed.');
    if (op.set !== undefined && (!op.set || typeof op.set !== 'object' || Array.isArray(op.set) || 'children' in op.set)) bad('Invalid change.');
    if (op.unset !== undefined && !(Array.isArray(op.unset) && op.unset.every((k) => typeof k === 'string'))) bad('Invalid change.');
    if (op.kids !== undefined) {
      if (!Array.isArray(op.kids)) bad('Invalid change.');
      for (const k of op.kids) {
        if (!Array.isArray(k) || (k[0] !== '-' && k[0] !== '+') || typeof k[1] !== 'string') bad('Invalid change.');
        if (k[0] === '+' && ((k[2] != null && typeof k[2] !== 'string') || (k[3] != null && typeof k[3] !== 'string'))) bad('Invalid change.');
      }
    }
    if (harmfulOp(op)) bad(op.id === 'root' ? 'Invalid document settings.' : 'Invalid object.');
  }
  if (batch.assets !== undefined) {
    if (!batch.assets || typeof batch.assets !== 'object' || Array.isArray(batch.assets)) bad('Invalid image data.');
    for (const [id, a] of Object.entries(batch.assets)) if (!ID.test(id) || !a || typeof a.data !== 'string') bad('Invalid image data.');
  }
  if (batch.comments !== undefined && !Array.isArray(batch.comments)) bad('Invalid comment.');
  return batch;
}

/** Whether a batch edits artwork (not only comments). */
export function editsContent(batch) {
  return Boolean(batch.nodes?.length || (batch.assets && Object.keys(batch.assets).length));
}
