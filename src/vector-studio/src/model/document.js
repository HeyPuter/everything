/**
 * VDocument: the node store, transactions and undo history.
 *
 * All nodes live in one flat Map keyed by id; containers list child ids
 * back-to-front (index 0 is drawn first). The special node 'root' holds the
 * layer list and document-level settings (artboards, guides, swatches,
 * units), so every change, including artboard edits, is a node update and
 * goes through the same undo path.
 *
 * Changes happen inside a transaction:
 *   doc.transact('Move', () => { doc.update(id, { anchors }) })
 * or, for interactive drags that change many times before committing:
 *   const tx = doc.begin('Move'); ...; doc.update(...); ...; tx.commit()
 * The first time a transaction touches a node it keeps the old object; the
 * undo record is just those old objects plus the current ones at commit.
 */
import { Emitter } from '../lib/emitter.js';
import { UserError } from '../lib/errors.js';
import { uid } from '../lib/ids.js';
import { createLayer, isContainer } from './nodes.js';
import { DEFAULT_SWATCHES } from './swatches.js';

export const FORMAT_VERSION = 1;
const HISTORY_LIMIT = 200;

/** The node map, with a version that changes on every write (for derived caches). */
class NodeMap extends Map {
  version = 0;

  set(key, value) {
    this.version++;
    return super.set(key, value);
  }

  delete(key) {
    this.version++;
    return super.delete(key);
  }

  clear() {
    this.version++;
    super.clear();
  }
}

/** Fields whose value differs between two versions of a node. */
function changedFields(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) if (a?.[k] !== b?.[k]) out.push(k);
  return out;
}

/** `value` with the fields someone else changed (prev -> next) taken from `next`. */
function withRemote(value, fields, next, children) {
  const out = { ...value };
  for (const k of fields) {
    if (k === 'children' && children) out.children = children;
    else if (k in next) out[k] = next[k];
    else delete out[k];
  }
  return out;
}

/** Rebase one undo record on a remote change to node `id` (see applyRemote). */
function rebaseRecord(rec, id, prev, next) {
  if (!rec.before.has(id)) return;
  if (next === undefined) {
    rec.before.delete(id);
    rec.after.delete(id);
    return;
  }
  if (prev === undefined) return;
  const fields = changedFields(prev, next);
  const b = rec.before.get(id);
  const a = rec.after.get(id);
  let beforeKids = null;
  if (fields.includes('children') && b?.children && a?.children && next.children) {
    // Keep this record's own insertions and removals, on top of the remote list.
    const added = new Set(a.children.filter((c) => !b.children.includes(c)));
    const kids = next.children.filter((c) => !added.has(c));
    b.children.forEach((c, i) => {
      if (!a.children.includes(c) && !kids.includes(c)) kids.splice(Math.min(i, kids.length), 0, c);
    });
    beforeKids = kids;
  }
  if (b) rec.before.set(id, withRemote(b, fields, next, beforeKids || next.children));
  if (a) rec.after.set(id, withRemote(a, fields, next, next.children));
}

export class VDocument extends Emitter {
  constructor() {
    super();
    this.nodes = new NodeMap();
    this.undoStack = [];
    this.redoStack = [];
    this.tx = null;
    this.revision = 0;
    this.savedRevision = 0;
    /** Optional { get(), set(value) } so undo can restore the editor selection. */
    this.selection = null;
    /** Binary assets (images) by id: { mime, data (data URL) }. Not part of undo. */
    this.assets = new Map();
    /** Review comments (plain data, see features/collab/comments.js). Saved with the file, not part of undo. */
    this.comments = null;
    this.commentsRevision = 0;
    this.savedCommentsRevision = 0;
    /** A view-only document refuses every transaction (shared with a viewer or commenter role). */
    this.readOnly = false;
    this.on('saved', () => {
      this.savedCommentsRevision = this.commentsRevision;
    });
  }

  /**
   * A new document with one or more artboards and one layer. `bleed` is a
   * number (all sides) or { top, bottom, left, right } in points and is
   * stored as the object form.
   */
  static create({ name = 'Untitled-1', width = 612, height = 792, units = 'pt', artboards = 1, colorMode = 'RGB', bleed = 0, rasterResolution = 72, grid = null, spacing = 20, columns = 0 } = {}) {
    const doc = new VDocument();
    const layer = createLayer('Layer 1');
    const boards = [];
    const gap = spacing;
    const cols = columns > 0 ? columns : Math.ceil(Math.sqrt(artboards));
    const b = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
    const bleeds = typeof bleed === 'object' && bleed ? { top: b(bleed.top), bottom: b(bleed.bottom), left: b(bleed.left), right: b(bleed.right) } : { top: b(bleed), bottom: b(bleed), left: b(bleed), right: b(bleed) };
    for (let i = 0; i < artboards; i++) {
      boards.push({
        id: uid('a'),
        name: `Artboard ${i + 1}`,
        x: (i % cols) * (width + gap),
        y: Math.floor(i / cols) * (height + gap),
        w: width,
        h: height,
      });
    }
    doc.nodes.set('root', {
      id: 'root',
      type: 'root',
      name,
      children: [layer.id],
      artboards: boards,
      guides: [],
      swatches: DEFAULT_SWATCHES.map((s) => ({ ...s })),
      units,
      colorMode,
      bleed: bleeds,
      rasterResolution,
      grid: grid && grid.spacing > 0 && grid.subdivisions >= 1 ? { spacing: grid.spacing, subdivisions: Math.round(grid.subdivisions) } : { spacing: 72, subdivisions: 8 },
    });
    layer.parent = 'root';
    doc.nodes.set(layer.id, layer);
    return doc;
  }

  static fromJSON(data) {
    if (!data || typeof data !== 'object' || !data.nodes || !data.nodes.root) throw new Error('Not a Vector Studio document');
    const doc = new VDocument();
    for (const [id, node] of Object.entries(data.nodes)) doc.nodes.set(id, node);
    for (const [id, asset] of Object.entries(data.assets || {})) doc.assets.set(id, asset);
    if (data.comments && typeof data.comments === 'object' && !Array.isArray(data.comments)) doc.comments = data.comments;
    doc.repairParents();
    return doc;
  }

  toJSON() {
    const nodes = {};
    for (const [id, node] of this.nodes) nodes[id] = node;
    const assets = {};
    for (const [id, a] of this.assets) assets[id] = a;
    const out = { format: 'vector-studio', version: FORMAT_VERSION, nodes, assets };
    if (this.comments) out.comments = this.comments;
    return out;
  }

  /** Recompute parent pointers from the children lists (after load). */
  repairParents() {
    const visit = (id, parent) => {
      const node = this.nodes.get(id);
      if (!node) return;
      if (node.parent !== parent) this.nodes.set(id, { ...node, parent });
      if (node.children) for (const c of node.children) visit(c, id);
    };
    visit('root', null);
  }

  get root() {
    return this.nodes.get('root');
  }

  get name() {
    return this.root.name;
  }

  get artboards() {
    return this.root.artboards;
  }

  get dirty() {
    return this.revision !== this.savedRevision || this.commentsRevision !== this.savedCommentsRevision;
  }

  /** Replace the comments data (immutable). Remote changes leave a saved document saved. */
  setComments(next, { remote = false } = {}) {
    if (next === this.comments) return;
    const clean = this.commentsRevision === this.savedCommentsRevision;
    this.comments = next;
    this.commentsRevision++;
    if (remote && clean) this.savedCommentsRevision = this.commentsRevision;
    this.emit('comments', { remote });
  }

  markSaved() {
    this.savedRevision = this.revision;
    this.emit('saved');
  }

  get(id) {
    return this.nodes.get(id);
  }

  has(id) {
    return this.nodes.has(id);
  }

  parentOf(id) {
    const n = this.nodes.get(id);
    return n && n.parent ? this.nodes.get(n.parent) : null;
  }

  children(id) {
    const n = this.nodes.get(id);
    return n?.children ? n.children.map((c) => this.nodes.get(c)).filter(Boolean) : [];
  }

  layers() {
    return this.children('root');
  }

  /** The layer containing a node. */
  layerOf(id) {
    let n = this.nodes.get(id);
    while (n && n.type !== 'layer') n = n.parent ? this.nodes.get(n.parent) : null;
    return n || null;
  }

  /** Ancestors from the parent up to (excluding) root. */
  ancestors(id) {
    const out = [];
    let n = this.nodes.get(id);
    while (n && n.parent && n.parent !== 'root') {
      n = this.nodes.get(n.parent);
      if (n) out.push(n);
    }
    return out;
  }

  isAncestor(ancestorId, id) {
    let n = this.nodes.get(id);
    while (n && n.parent) {
      if (n.parent === ancestorId) return true;
      n = this.nodes.get(n.parent);
    }
    return false;
  }

  /** Effective hidden/locked: a node is hidden if it or any ancestor is. */
  isHidden(id) {
    let n = this.nodes.get(id);
    while (n) {
      if (n.hidden) return true;
      n = n.parent ? this.nodes.get(n.parent) : null;
    }
    return false;
  }

  isLocked(id) {
    let n = this.nodes.get(id);
    while (n) {
      if (n.locked) return true;
      n = n.parent ? this.nodes.get(n.parent) : null;
    }
    return false;
  }

  /** Depth-first walk in paint order (back to front). fn(node, depth) returning false skips children. */
  walk(fn, id = 'root', depth = 0) {
    const node = this.nodes.get(id);
    if (!node) return;
    if (id !== 'root' && fn(node, depth) === false) return;
    if (node.children) for (const c of node.children) this.walk(fn, c, depth + 1);
  }

  /** All descendants of a node (not including it). */
  descendants(id) {
    const out = [];
    const visit = (nid) => {
      const n = this.nodes.get(nid);
      if (!n?.children) return;
      for (const c of n.children) {
        const cn = this.nodes.get(c);
        if (!cn) continue;
        out.push(cn);
        visit(c);
      }
    };
    visit(id);
    return out;
  }

  /** Global paint-order index for sorting selections back to front. */
  paintOrder() {
    // Cached until any node changes: selection code sorts by it many times per frame.
    if (this.#order && this.#orderVersion === this.nodes.version) return this.#order;
    const order = new Map();
    let i = 0;
    this.walk((n) => {
      order.set(n.id, i++);
    });
    this.#order = order;
    this.#orderVersion = this.nodes.version;
    return order;
  }

  #order = null;
  #orderVersion = -1;

  sortByPaintOrder(ids) {
    const order = this.paintOrder();
    return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  // ---- transactions ----

  /**
   * Open a transaction. `coalesce` merges this change into the previous
   * undo step when that step had the same key and is recent (slider drags,
   * repeated nudges, live color edits), so one gesture is one undo.
   */
  begin(label, { coalesce = null } = {}) {
    if (this.tx) throw new Error(`Transaction "${this.tx.label}" is still open`);
    if (this.readOnly) throw new UserError('This document is view only.');
    const tx = {
      label,
      coalesce,
      before: new Map(),
      selectionBefore: this.selection ? this.selection.get() : null,
      changed: new Set(),
      structural: false,
      commit: () => this.#commit(tx),
      cancel: () => this.#cancel(tx),
    };
    this.tx = tx;
    return tx;
  }

  /** Run fn inside a transaction; commits on success, rolls back on throw. */
  transact(label, fn, opts) {
    if (this.tx) return fn(this.tx); // nested: join the open transaction
    const tx = this.begin(label, opts);
    let result;
    try {
      result = fn(tx);
    } catch (err) {
      tx.cancel();
      throw err;
    }
    tx.commit();
    return result;
  }

  #touch(id) {
    const tx = this.tx;
    if (!tx) throw new Error('Document changes must happen inside a transaction');
    if (!tx.before.has(id)) tx.before.set(id, this.nodes.get(id));
    tx.changed.add(id);
  }

  #commit(tx) {
    if (this.tx !== tx) return;
    this.tx = null;
    const after = new Map();
    for (const id of tx.before.keys()) after.set(id, this.nodes.get(id));
    // Drop no-op touches.
    for (const [id, old] of tx.before) if (old === after.get(id)) tx.before.delete(id), after.delete(id);
    if (!tx.before.size) {
      this.emit('change', { ids: tx.changed, structural: tx.structural, commit: true });
      return;
    }
    const last = this.undoStack[this.undoStack.length - 1];
    if (tx.coalesce && last && last.coalesce === tx.coalesce && Date.now() - last.time < 1500 && !this.redoStack.length && this.revision !== this.savedRevision) {
      for (const [id, old] of tx.before) if (!last.before.has(id)) last.before.set(id, old);
      for (const id of last.before.keys()) last.after.set(id, this.nodes.get(id));
      last.selectionAfter = this.selection ? this.selection.get() : null;
      last.time = Date.now();
      this.emit('transaction', { label: tx.label, before: tx.before, after });
      this.emit('change', { ids: tx.changed, structural: tx.structural, commit: true });
      this.emit('history');
      return;
    }
    const record = {
      label: tx.label,
      coalesce: tx.coalesce,
      before: tx.before,
      after,
      selectionBefore: tx.selectionBefore,
      selectionAfter: this.selection ? this.selection.get() : null,
      structural: tx.structural,
      time: Date.now(),
    };
    this.undoStack.push(record);
    while (this.undoStack.length > (this.historyLimit || HISTORY_LIMIT)) this.undoStack.shift();
    this.redoStack.length = 0;
    this.revision++;
    this.emit('transaction', { label: tx.label, before: tx.before, after });
    this.emit('change', { ids: tx.changed, structural: tx.structural, commit: true });
    this.emit('history');
  }

  #cancel(tx) {
    if (this.tx !== tx) return;
    this.tx = null;
    for (const [id, old] of tx.before) {
      if (old === undefined) this.nodes.delete(id);
      else this.nodes.set(id, old);
    }
    if (this.selection && tx.selectionBefore != null) this.selection.set(tx.selectionBefore);
    this.emit('change', { ids: tx.changed, structural: true, commit: true });
  }

  get canUndo() {
    return this.undoStack.length > 0 && !this.tx;
  }

  get canRedo() {
    return this.redoStack.length > 0 && !this.tx;
  }

  get undoLabel() {
    return this.undoStack[this.undoStack.length - 1]?.label || '';
  }

  get redoLabel() {
    return this.redoStack[this.redoStack.length - 1]?.label || '';
  }

  undo() {
    if (!this.canUndo) return false;
    const rec = this.undoStack.pop();
    const prev = this.#restore(rec.before);
    this.redoStack.push(rec);
    this.revision--;
    this.emit('transaction', { label: rec.label, before: prev, after: rec.before, undo: true });
    if (this.selection && rec.selectionBefore != null) this.selection.set(rec.selectionBefore);
    this.emit('change', { ids: new Set(rec.before.keys()), structural: true, commit: true, undo: true });
    this.emit('history');
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    const rec = this.redoStack.pop();
    const prev = this.#restore(rec.after);
    this.undoStack.push(rec);
    this.revision++;
    this.emit('transaction', { label: rec.label, before: prev, after: rec.after, redo: true });
    if (this.selection && rec.selectionAfter != null) this.selection.set(rec.selectionAfter);
    this.emit('change', { ids: new Set(rec.after.keys()), structural: true, commit: true, undo: true });
    this.emit('history');
    return true;
  }

  #restore(map) {
    const prev = new Map();
    for (const [id, node] of map) {
      prev.set(id, this.nodes.get(id));
      if (node === undefined) this.nodes.delete(id);
      else this.nodes.set(id, node);
    }
    return prev;
  }

  /**
   * Apply changes made elsewhere (a collaborator's edits): `changes` maps
   * node ids to their new value (undefined removes). No undo step is
   * recorded, and the history is rebased so Undo and Redo only revert this
   * document's own changes: a field someone else changed since is left as
   * they set it, and nodes they removed are not brought back.
   */
  applyRemote(changes) {
    if (this.tx) throw new Error(`Transaction "${this.tx.label}" is still open`);
    const ids = new Set();
    for (const [id, next] of changes) {
      const prev = this.nodes.get(id);
      if (prev === next || (id === 'root' && next === undefined)) continue;
      if (next === undefined) this.nodes.delete(id);
      else this.nodes.set(id, next);
      ids.add(id);
      for (const rec of this.undoStack) rebaseRecord(rec, id, prev, next);
      for (const rec of this.redoStack) rebaseRecord(rec, id, prev, next);
    }
    if (!ids.size) return ids;
    // Caches keyed on the revision see the change; a saved document stays saved.
    const clean = this.revision === this.savedRevision;
    this.revision++;
    if (clean) this.savedRevision = this.revision;
    this.emit('change', { ids, structural: true, commit: true, remote: true });
    return ids;
  }

  // ---- history browsing (History panel) ----

  /** The undo history, oldest first: { steps: [{ label, time }], index } where `index` steps are applied. */
  history() {
    const steps = [...this.undoStack, ...this.redoStack.slice().reverse()].map((r) => ({ label: r.label, time: r.time }));
    return { steps, index: this.undoStack.length };
  }

  /** Undo or redo until exactly `n` history steps are applied. */
  goToHistory(n) {
    if (this.tx) return false;
    const total = this.undoStack.length + this.redoStack.length;
    const target = Math.max(0, Math.min(total, n));
    while (this.undoStack.length > target && this.undo());
    while (this.undoStack.length < target && this.redo());
    return true;
  }

  /** Forget every undo and redo step (the document itself is unchanged). */
  clearHistory() {
    if (this.tx) return;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit('history');
  }

  /** The whole document state. Nodes are immutable, so this is a cheap shallow copy. */
  snapshot() {
    return { nodes: new Map(this.nodes), assets: new Map(this.assets) };
  }

  /**
   * Inside a transaction: make every node match a snapshot (from snapshot()
   * or another document), as one undoable change. Assets are only added.
   */
  restoreSnapshot(snap) {
    const changed = new Set();
    for (const id of new Set([...this.nodes.keys(), ...snap.nodes.keys()])) {
      const next = snap.nodes.get(id);
      if (this.nodes.get(id) === next) continue;
      this.#touch(id);
      // A container this transaction mutated in place must not share the snapshot's children array.
      this.tx.owned?.delete(id);
      if (next === undefined) this.nodes.delete(id);
      else this.nodes.set(id, next);
      changed.add(id);
    }
    for (const [id, a] of snap.assets || []) if (!this.assets.has(id)) this.assets.set(id, a);
    this.tx.structural = true;
    this.emit('change', { ids: changed, structural: true, live: true });
    return changed.size;
  }

  // ---- mutations (inside a transaction) ----

  /** Shallow-merge a patch into a node, replacing the object. */
  update(id, patch) {
    const old = this.nodes.get(id);
    if (!old) return null;
    this.#touch(id);
    const next = { ...old, ...patch };
    // A patched children list is a fresh array the caller owns; stop mutating in place.
    if (patch.children && this.tx.owned) this.tx.owned.delete(id);
    this.nodes.set(id, next);
    this.emit('change', { ids: new Set([id]), structural: false, live: true });
    return next;
  }

  /**
   * Insert a node (and optionally its already-built descendants) under a
   * parent. `index` counts back-to-front; default puts it on top.
   */
  insert(node, parentId, index = Infinity, descendants = []) {
    const parent = this.nodes.get(parentId);
    if (!parent || !parent.children) throw new Error(`Cannot insert into ${parentId}`);
    for (const d of descendants) {
      this.#touch(d.id);
      this.nodes.set(d.id, d);
    }
    const prior = this.nodes.get(node.id);
    this.#touch(node.id);
    this.nodes.set(node.id, { ...node, parent: parentId });
    const children = this.#ownedChildren(parentId);
    // Only a node already in this parent needs the (linear) duplicate check.
    if (prior && prior.parent === parentId) {
      const existing = children.indexOf(node.id);
      if (existing >= 0) children.splice(existing, 1);
    }
    const at = Math.max(0, Math.min(children.length, index));
    if (at === children.length) children.push(node.id);
    else children.splice(at, 0, node.id);
    this.tx.structural = true;
    return this.nodes.get(node.id);
  }

  /**
   * The children array of a container that this transaction may mutate in
   * place: the first touch copies the node (the old object stays the undo
   * snapshot), later inserts reuse the copy. Bulk inserts stay O(n).
   */
  #ownedChildren(parentId) {
    const tx = this.tx;
    if (!tx.owned) tx.owned = new Set();
    if (!tx.owned.has(parentId)) {
      this.#touch(parentId);
      const p = this.nodes.get(parentId);
      this.nodes.set(parentId, { ...p, children: p.children.slice() });
      tx.owned.add(parentId);
    }
    return this.nodes.get(parentId).children;
  }

  /** Remove a node and all its descendants. */
  remove(id) {
    const node = this.nodes.get(id);
    if (!node || id === 'root') return;
    for (const d of this.descendants(id)) {
      this.#touch(d.id);
      this.nodes.delete(d.id);
    }
    this.#touch(id);
    this.nodes.delete(id);
    const parent = node.parent ? this.nodes.get(node.parent) : null;
    if (parent) {
      this.#touch(parent.id);
      this.nodes.set(parent.id, { ...parent, children: parent.children.filter((c) => c !== id) });
    }
    this.tx.structural = true;
  }

  /** Move a node to another parent (or reorder within the same one). */
  move(id, parentId, index = Infinity) {
    const node = this.nodes.get(id);
    if (!node) return;
    if (id === parentId || this.isAncestor(id, parentId)) throw new Error('Cannot move a node into itself');
    const oldParent = node.parent ? this.nodes.get(node.parent) : null;
    if (oldParent) {
      this.#touch(oldParent.id);
      this.nodes.set(oldParent.id, { ...oldParent, children: oldParent.children.filter((c) => c !== id) });
    }
    const parent = this.nodes.get(parentId);
    this.#touch(parentId);
    const children = parent.children.filter((c) => c !== id);
    const at = Math.max(0, Math.min(children.length, index));
    children.splice(at, 0, id);
    this.nodes.set(parentId, { ...parent, children });
    this.#touch(id);
    this.nodes.set(id, { ...node, parent: parentId });
    this.tx.structural = true;
  }

  /** Deep copy of a subtree with fresh ids: { node, descendants }. */
  cloneSubtree(id, idMap = new Map()) {
    const src = this.nodes.get(id);
    const descendants = [];
    const copy = (n, parent) => {
      const nid = uid(n.type[0]);
      idMap.set(n.id, nid);
      const out = { ...n, id: nid, parent };
      if (n.children) {
        out.children = n.children.map((c) => {
          const cn = this.nodes.get(c);
          const cc = copy(cn, nid);
          descendants.push(cc);
          return cc.id;
        });
      }
      return out;
    };
    const node = copy(src, src.parent);
    return { node, descendants };
  }

  /** Serializable subtree for the clipboard: { root, nodes: [...] } with original ids. */
  exportSubtree(id) {
    const nodes = [this.nodes.get(id), ...this.descendants(id)];
    return { root: id, nodes };
  }

  /** Re-id and insert a subtree produced by exportSubtree(). Returns the new root node. */
  importSubtree(sub, parentId, index = Infinity) {
    const map = new Map();
    for (const n of sub.nodes) map.set(n.id, uid(n.type[0]));
    const nodes = sub.nodes.map((n) => {
      const out = { ...n, id: map.get(n.id) };
      if (n.children) out.children = n.children.map((c) => map.get(c)).filter(Boolean);
      if (n.parent && map.has(n.parent)) out.parent = map.get(n.parent);
      return out;
    });
    const root = nodes[0];
    return this.insert(root, parentId, index, nodes.slice(1));
  }

  // ---- root helpers ----

  updateRoot(patch) {
    return this.update('root', patch);
  }

  addLayer(name, index = Infinity) {
    const used = new Set(this.layers().map((l) => l.color));
    const colors = ['#4f80ff', '#ff4f4f', '#4fc24f', '#4fb8ff', '#ff4fd8', '#ffc34f', '#9b6bff', '#ff8a3d', '#3dd1b8'];
    const color = colors.find((c) => !used.has(c)) || colors[this.layers().length % colors.length];
    const layer = createLayer(name || `Layer ${this.layers().length + 1}`, color);
    return this.insert(layer, 'root', index);
  }

  /** Every leaf that renders (paths, text, images, compounds) in paint order. */
  leaves() {
    const out = [];
    this.walk((n) => {
      if (n.type === 'compound') {
        out.push(n);
        return false;
      }
      if (!isContainer(n)) out.push(n);
      return true;
    });
    return out;
  }
}
