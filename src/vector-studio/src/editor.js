/**
 * Editor: per-document editing state (selection, view, current paint, tool,
 * view options) around one VDocument. The app keeps one Editor per open
 * document tab; panels and tools talk to the active one.
 *
 * Selection model:
 *   selection  Set of selected node ids (objects). The Selection tool puts
 *              top-level objects here; Direct Selection puts the paths whose
 *              anchors it selected.
 *   anchors    Map pathId -> Set of selected anchor indices (Direct
 *              Selection). A path in `selection` with no entry here counts
 *              as fully selected.
 */
import { Emitter } from './lib/emitter.js';
import { Viewport } from './render/viewport.js';
import { DEFAULT_STYLE } from './model/nodes.js';
import { selectionBounds, selectionFrame, nodeBounds } from './model/geometry.js';

export const DEFAULT_VIEW_OPTIONS = {
  mode: 'preview', // preview | outline
  pixelPreview: false,
  rulers: true,
  grid: false,
  guides: true,
  lockGuides: false,
  alignmentGuides: true,
  snapToGrid: false,
  snapToPoint: true,
  snapToPixel: false,
  boundingBox: true,
  artboards: true,
  edges: true,
  transparencyGrid: false,
  textThreads: true,
  gradientAnnotator: true,
  cornerWidget: true, // live-corner widgets on selected shapes
  slices: true,
  lockSlices: false,
  trim: false, // Trim View: only what is on the artboards
  template: true, // template layers shown
  overprint: false, // Overprint Preview
  proof: 'cmyk', // Proof Setup: cmyk | grayscale | protanopia | deuteranopia | tritanopia
  proofColors: false,
  printTiling: false,
  globalRulers: false,
  videoRulers: false,
};

/** The selection set, with a version that changes on every edit (for derived caches). */
export class SelectionSet extends Set {
  version = 0;

  add(id) {
    if (!this.has(id)) this.version++;
    return super.add(id);
  }

  delete(id) {
    const had = super.delete(id);
    if (had) this.version++;
    return had;
  }

  clear() {
    if (this.size) this.version++;
    super.clear();
  }
}

export class Editor extends Emitter {
  constructor(doc, { file = null, prefs } = {}) {
    super();
    this.doc = doc;
    this.file = file; // { path, name, kind: 'puter'|'local'|null }
    this.prefs = prefs;
    this.view = new Viewport();
    this.selection = new SelectionSet();
    this.anchors = new Map();
    this.viewOptions = { ...DEFAULT_VIEW_OPTIONS };
    this.style = { ...DEFAULT_STYLE };
    this.focusPaint = 'fill'; // which of fill/stroke is in front in the toolbar
    this.activeLayerId = doc.root.children[doc.root.children.length - 1];
    this.activeArtboard = 0;
    this.isolation = null; // group id in isolation mode
    this.hover = null;
    this.textEdit = null; // { id, caret, anchor } while editing type
    this.lastTransform = null; // matrix for Transform Again
    this.viewInitialized = false;

    doc.selection = {
      get: () => ({ ids: [...this.selection], anchors: [...this.anchors].map(([k, v]) => [k, [...v]]) }),
      set: (s) => {
        this.selection = new SelectionSet(s.ids.filter((id) => doc.has(id)));
        this.anchors = new Map(s.anchors.filter(([k]) => doc.has(k)).map(([k, v]) => [k, new Set(v)]));
        this.emit('selection');
      },
    };
    doc.on('change', (e) => {
      if (e.structural) this.#pruneSelection();
      if (!doc.has(this.activeLayerId)) this.activeLayerId = doc.root.children[doc.root.children.length - 1];
      this.emit('doc-change', e);
    });
  }

  /** Tab and title name: the file name once saved or opened, else the document name. */
  get name() {
    return this.file?.name || this.doc.root.name;
  }

  #pruneSelection() {
    let changed = false;
    for (const id of this.selection) {
      if (!this.doc.has(id)) {
        this.selection.delete(id);
        this.anchors.delete(id);
        changed = true;
      }
    }
    for (const [id, set] of this.anchors) {
      const n = this.doc.get(id);
      if (!n) {
        this.anchors.delete(id);
        changed = true;
        continue;
      }
      for (const i of set) if (!n.anchors || i >= n.anchors.length) set.delete(i), (changed = true);
    }
    if (changed) this.emit('selection');
  }

  // ---- selection ----

  /** Selected node objects, back to front. */
  selectedNodes() {
    return this.doc.sortByPaintOrder(this.selection).map((id) => this.doc.get(id)).filter(Boolean);
  }

  /** Selected ids without those whose ancestor is also selected (for transforms). */
  topSelection() {
    // Panels, the task bar and the overlay all ask for this after each
    // change: compute once per selection and document state.
    const c = this.#topCache;
    if (c && c.sel === this.selection && c.selVersion === this.selection.version && c.docVersion === this.doc.nodes.version) return c.ids.slice();
    // Walk each id's ancestors (O(n * depth)) instead of testing every pair.
    const sel = this.selection;
    const ids = [];
    for (const id of sel) if (!this.#hasSelectedAncestor(id)) ids.push(id);
    const sorted = this.doc.sortByPaintOrder(ids);
    this.#topCache = { sel, selVersion: sel.version, docVersion: this.doc.nodes.version, ids: sorted };
    return sorted.slice();
  }

  #topCache = null;

  /**
   * A value derived from the selection and the document, recomputed only
   * when either changes (bounds, common paint, operands of commands).
   */
  memo(key, compute) {
    const stamp = `${this.selection.version}:${this.doc.nodes.version}`;
    if (this.#memoSel !== this.selection || this.#memoStamp !== stamp) {
      this.#memo.clear();
      this.#memoSel = this.selection;
      this.#memoStamp = stamp;
    }
    if (!this.#memo.has(key)) this.#memo.set(key, compute());
    return this.#memo.get(key);
  }

  #memo = new Map();
  #memoSel = null;
  #memoStamp = '';

  #hasSelectedAncestor(id) {
    let n = this.doc.get(id);
    while (n && n.parent) {
      if (this.selection.has(n.parent)) return true;
      n = this.doc.get(n.parent);
    }
    return false;
  }

  hasSelection() {
    return this.selection.size > 0;
  }

  select(ids, { add = false, toggle = false } = {}) {
    if (!add && !toggle) {
      this.selection.clear();
      this.anchors.clear();
    }
    for (const id of ids) {
      if (!this.doc.has(id)) continue;
      if (toggle && this.selection.has(id)) {
        this.selection.delete(id);
        this.anchors.delete(id);
      } else {
        this.selection.add(id);
        this.anchors.delete(id);
      }
    }
    this.#syncActiveLayer();
    this.#syncActiveArtboard();
    this.emit('selection');
  }

  /**
   * Selecting artwork makes its artboard active, so
   * rulers and X/Y follow it. Selections spanning several artboards
   * (Select All) leave the active artboard alone.
   */
  #syncActiveArtboard() {
    const boards = this.doc.artboards;
    if (boards.length < 2 || !this.selection.size) return;
    const b = selectionBounds(this.doc, this.selection, false);
    if (!b) return;
    let hit = -1;
    for (let i = 0; i < boards.length; i++) {
      const a = boards[i];
      if (b.x <= a.x + a.w && b.x + b.w >= a.x && b.y <= a.y + a.h && b.y + b.h >= a.y) {
        if (hit >= 0) return;
        hit = i;
      }
    }
    if (hit >= 0 && hit !== this.activeArtboard) this.setActiveArtboard(hit);
  }

  clearSelection() {
    if (!this.selection.size && !this.anchors.size) return;
    this.selection.clear();
    this.anchors.clear();
    this.emit('selection');
  }

  /** Select specific anchors (Direct Selection). */
  selectAnchors(pathId, indices, { add = false, toggle = false } = {}) {
    if (!add && !toggle) {
      this.selection.clear();
      this.anchors.clear();
    }
    let set = this.anchors.get(pathId);
    if (!set) {
      set = new Set();
      this.anchors.set(pathId, set);
    }
    for (const i of indices) {
      if (toggle && set.has(i)) set.delete(i);
      else set.add(i);
    }
    this.selection.add(pathId);
    this.#syncActiveLayer();
    this.emit('selection');
  }

  /** Selected anchor indices of a path: all of them when the path is wholly selected. */
  selectedAnchors(pathId) {
    const n = this.doc.get(pathId);
    if (!n || !n.anchors) return new Set();
    const set = this.anchors.get(pathId);
    if (set) return set;
    if (this.selection.has(pathId) || this.#hasSelectedAncestor(pathId)) {
      return new Set(n.anchors.map((_, i) => i));
    }
    return new Set();
  }

  isPartiallySelected(pathId) {
    const set = this.anchors.get(pathId);
    const n = this.doc.get(pathId);
    return Boolean(set && n && set.size < n.anchors.length);
  }

  #syncActiveLayer() {
    const last = [...this.selection].pop();
    if (!last) return;
    const layer = this.doc.layerOf(last);
    if (layer && layer.id !== this.activeLayerId) {
      this.activeLayerId = layer.id;
      this.emit('active-layer');
    }
  }

  /**
   * The object the Selection tool picks for a clicked leaf: the topmost
   * ancestor below the layer (so clicking a grouped path selects the group),
   * or below the isolated group in isolation mode.
   */
  selectionTarget(id) {
    let n = this.doc.get(id);
    const stop = this.isolation || null;
    while (n && n.parent) {
      const p = this.doc.get(n.parent);
      if (!p || p.type === 'layer' || p.type === 'root' || p.id === stop) break;
      n = p;
    }
    return n;
  }

  selectionBounds(visual = this.prefs?.get('previewBounds')) {
    const b = this.memo(`bounds:${Boolean(visual)}`, () => selectionBounds(this.doc, this.topSelection(), visual));
    return b && { ...b };
  }

  /**
   * The selection's bounding box in its frame: { x, y, w, h, angle }, turned
   * by the objects' shared frame angle (see geometry.js selectionFrame).
   */
  selectionFrame(visual = this.prefs?.get('previewBounds')) {
    return selectionFrame(this.doc, this.topSelection(), visual);
  }

  /** Active artboard rect. */
  artboard(index = this.activeArtboard) {
    const boards = this.doc.artboards;
    return boards[Math.min(index, boards.length - 1)] || null;
  }

  setActiveArtboard(i) {
    const n = this.doc.artboards.length;
    this.activeArtboard = Math.max(0, Math.min(n - 1, i));
    this.emit('artboard');
  }

  /** Artboard index containing a document point, or -1. */
  artboardAt(x, y) {
    const boards = this.doc.artboards;
    for (let i = boards.length - 1; i >= 0; i--) {
      const a = boards[i];
      if (x >= a.x && y >= a.y && x <= a.x + a.w && y <= a.y + a.h) return i;
    }
    return -1;
  }

  /** The layer new objects go into (unlocked, visible); null when none is usable. */
  targetLayer() {
    if (this.isolation && this.doc.has(this.isolation)) return this.doc.get(this.isolation);
    let layer = this.doc.get(this.activeLayerId);
    if (!layer || layer.type !== 'layer') layer = this.doc.layers().slice(-1)[0];
    return layer;
  }

  /**
   * Where drawing tools put new artwork: { parentId, index } (index counts
   * back to front). Drawing modes (behind, inside) redirect it through
   * `drawTargetHook`, which may also build a container inside the open
   * transaction.
   */
  drawTarget() {
    const base = { parentId: this.targetLayer().id, index: Infinity };
    return this.drawTargetHook?.(this, base) || base;
  }

  /** Insert newly drawn artwork (and its built descendants) at the draw target. */
  insertDrawn(node, descendants = []) {
    const t = this.drawTarget();
    this.doc.insert(node, t.parentId, t.index, descendants);
    return node.id;
  }

  canDrawInTarget() {
    const t = this.targetLayer();
    return t && !this.doc.isLocked(t.id) && !this.doc.isHidden(t.id);
  }

  setStyle(patch) {
    this.style = { ...this.style, ...patch };
    this.emit('style');
  }

  setViewOption(key, value) {
    this.viewOptions = { ...this.viewOptions, [key]: value };
    this.emit('view-options');
    this.emit('view');
  }

  /** Notify a view change (zoom, pan, rotation). */
  viewChanged() {
    this.emit('view');
  }

  fitArtboard(index = this.activeArtboard) {
    const a = this.artboard(index);
    if (a) this.view.fit(a, 48);
    this.viewChanged();
  }

  fitAll() {
    let r = null;
    for (const a of this.doc.artboards) {
      r = r ? { x: Math.min(r.x, a.x), y: Math.min(r.y, a.y), w: Math.max(r.x + r.w, a.x + a.w) - Math.min(r.x, a.x), h: Math.max(r.y + r.h, a.y + a.h) - Math.min(r.y, a.y) } : { ...a };
    }
    if (r) this.view.fit(r, 48);
    this.viewChanged();
  }

  actualSize() {
    const c = this.view.toDoc(this.view.width / 2, this.view.height / 2);
    this.view.set({ zoom: 1 });
    this.view.centerOn(c.x, c.y);
    this.viewChanged();
  }

  nodeBounds(id) {
    return nodeBounds(this.doc, this.doc.get(id));
  }

  /** Request an artwork redraw (the canvas view listens). */
  invalidate() {
    this.emit('invalidate');
  }
}
