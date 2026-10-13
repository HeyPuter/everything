/**
 * Layers panel: the document tree (layers, sublayers, groups, objects),
 * top of the stack first. Rows toggle visibility and lock, expand and
 * collapse, rename on double-click, select on click (Shift/Cmd to extend),
 * show selection and target indicators, and reorder by drag and drop.
 *
 * Rows are virtualized (only the visible rows exist in the DOM), so
 * documents with tens of thousands of objects stay responsive. Keyboard:
 * the tree follows the ARIA tree pattern (Up/Down, Left/Right collapse and
 * expand, Enter selects, F2 renames, Space toggles visibility).
 */
import { h } from '../../lib/dom.js';
import { Panel } from './panel.js';
import { icon } from '../icons.js';
import { iconButton } from '../widgets.js';
import { defaultLabel } from '../../model/nodes.js';
import { drawNode } from '../../render/draw.js';
import { visualBounds } from '../../model/geometry.js';
import { layerPicks } from '../../ops/layer-ops.js';

const thumbCache = new WeakMap();

/** Row heights of the Panel Options sizes (px). */
export const ROW_SIZES = { small: 20, medium: 28, large: 44 };

export const DEFAULT_LAYER_PANEL_OPTIONS = Object.freeze({ layersOnly: false, rowSize: 'medium', rowHeight: 28, thumbLayers: true, thumbTopOnly: false, thumbGroups: true, thumbObjects: true });

/** The Layers panel options (prefs 'layersPanel') with defaults filled in. */
export function layerPanelOptions(prefs) {
  return { ...DEFAULT_LAYER_PANEL_OPTIONS, ...(prefs?.get('layersPanel') || {}) };
}

/**
 * A small rendering of a row's artwork. Leaves cache by node identity
 * (immutable nodes); containers also key on the document revision because
 * their children can change without the container object changing.
 */
function thumbnail(doc, node, { defer = null, size: THUMB = 20 } = {}) {
  const key = `${node.children ? doc.revision : 0}:${THUMB}`;
  const hit = thumbCache.get(node);
  if (hit && hit.key === key) return hit.el.cloneNode(true);
  // A container redraws all of its contents: while edits keep coming, show the last
  // picture and redraw once things settle, so large layers do not slow every change.
  if (hit && defer && node.children) {
    defer();
    return hit.el.cloneNode(true);
  }
  const b = visualBounds(doc, node);
  if (!b || !(b.w > 0 || b.h > 0)) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = THUMB * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.setTransform !== 'function') return null;
  const s = (THUMB - 2) / Math.max(b.w, b.h, 1e-6);
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (THUMB / 2 - (b.x + b.w / 2) * s), dpr * (THUMB / 2 - (b.y + b.h / 2) * s));
  drawNode(ctx, doc, { ...node, hidden: false }, { hairline: 1 / s, scale: s * dpr });
  let el;
  try {
    el = Object.assign(document.createElement('img'), { src: canvas.toDataURL(), alt: '', width: THUMB, height: THUMB });
  } catch {
    return null;
  }
  thumbCache.set(node, { key, el });
  return el.cloneNode(true);
}

const ROW_H = 28;
const coarse = () => Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);

export class LayersPanel extends Panel {
  static id = 'layers';
  static title = 'Layers';
  static icon = 'layers';
  static placement = 'dock';

  /** The panel's options menu: command ids, so entries light up as the layers feature registers them. */
  menu() {
    return [
      'layer.newWithOptions',
      'layers.newSublayer',
      'layers.duplicate',
      'layers.delete',
      '-',
      'layers.options',
      '-',
      'layers.clipMask',
      '-',
      'layers.isolate',
      'object.exitIsolation',
      '-',
      'layers.locate',
      '-',
      'layers.merge',
      'layers.flatten',
      'layers.collect',
      '-',
      'layers.releaseSequence',
      'layers.releaseBuild',
      'layers.reverse',
      '-',
      'layers.template',
      'layers.hideOthers',
      'layers.outlineOthers',
      'layers.lockOthers',
      '-',
      'layers.pasteRemembers',
      '-',
      'layers.panelOptions',
    ];
  }

  get options() {
    return layerPanelOptions(this.app.prefs);
  }

  /** Row height in px: the Panel Options size, at least 36 on touch screens. */
  get rowH() {
    const o = this.options;
    const base = o.rowSize === 'other' ? Math.max(12, Math.min(100, Number(o.rowHeight) || ROW_H)) : ROW_SIZES[o.rowSize] || ROW_H;
    return Math.max(base, coarse() ? 36 : 0);
  }

  build() {
    this.expanded = new Set();
    this.rows = [];
    this.focusIndex = 0;
    this.filter = '';
    const app = this.app;
    this.search = h('input.layers-search', {
      type: 'search',
      placeholder: 'Search all layers',
      'aria-label': 'Search layers',
      oninput: () => {
        this.filter = this.search.value.trim().toLowerCase();
        this.update();
      },
      onkeydown: (e) => e.stopPropagation(),
    });
    this.tree = h('div.layers-tree', { role: 'tree', 'aria-label': 'Layers', 'aria-multiselectable': 'true', tabindex: '0' });
    this.spacer = h('div.layers-spacer');
    this.viewport = h('div.layers-viewport', this.spacer, this.tree);
    this.viewport.addEventListener('scroll', () => this.renderRows());
    this.tree.addEventListener('keydown', (e) => this.onKey(e));
    this.tree.addEventListener('focus', () => this.renderRows());
    this.countEl = h('span.layers-count');
    const footer = h(
      'div.layers-footer',
      this.countEl,
      h(
        'div.layers-actions',
        iconButton('square-dashed', 'Make/Release Clipping Mask', () => this.clipButton()),
        iconButton('file-plus', 'Create New Sublayer', () => this.newLayer(true)),
        iconButton('plus', 'Create New Layer', () => this.newLayer(false)),
        iconButton('trash', 'Delete Selection', () => this.deleteSelected()),
      ),
    );
    this.el.append(h('div.layers-top', this.search), this.viewport, footer);
    this.dragState = null;
    this.thumbsSettled = false;
    this.thumbTimer = 0;
    this.deferThumbs = () => {
      clearTimeout(this.thumbTimer);
      this.thumbTimer = setTimeout(() => {
        this.thumbsSettled = true;
        try {
          this.renderRows();
        } finally {
          this.thumbsSettled = false;
        }
      }, 400);
    };
    this.ro = new ResizeObserver(() => this.renderRows());
    this.ro.observe(this.viewport);
  }

  /**
   * Make/Release Clipping Mask: works on the selection, or with nothing
   * selected on the whole active layer, whose top object then clips the rest.
   */
  clipButton() {
    const app = this.app;
    const ed = app.editor;
    if (!ed) return;
    if (ed.selectedNodes().some((n) => n.type === 'group' && n.clip)) {
      app.commands.run('object.clipRelease');
      return;
    }
    if (!ed.selection.size) {
      const layer = ed.doc.get(ed.activeLayerId);
      const ids = (layer?.children || []).filter((c) => {
        const n = ed.doc.get(c);
        return n && n.type !== 'layer' && !n.hidden && !n.locked;
      });
      if (ids.length < 2) {
        app.notify('A clipping mask needs at least two objects: the top one clips the others.');
        return;
      }
      ed.select(ids);
    }
    app.commands.run('object.clipMake');
  }

  newLayer(sub) {
    const ed = this.app.editor;
    if (!ed) return;
    const doc = ed.doc;
    doc.transact(sub ? 'New Sublayer' : 'New Layer', () => {
      if (sub) {
        const parent = doc.get(ed.activeLayerId);
        const layer = doc.addLayer();
        doc.move(layer.id, parent.id);
        doc.update(layer.id, { name: `Layer ${doc.layers().length + countSublayers(doc) }` });
        this.expanded.add(parent.id);
        ed.activeLayerId = layer.id;
      } else {
        const idx = doc.root.children.indexOf(doc.layerOf(ed.activeLayerId)?.id);
        const layer = doc.addLayer(undefined, idx + 1);
        ed.activeLayerId = layer.id;
      }
    });
    ed.emit('active-layer');
  }

  deleteSelected() {
    const ed = this.app.editor;
    if (!ed) return;
    if (ed.selection.size) {
      this.app.commands.run('edit.clear');
      return;
    }
    const doc = ed.doc;
    const layer = doc.get(ed.activeLayerId);
    if (!layer) return;
    if (doc.layers().length <= 1 && layer.parent === 'root') {
      this.app.notify('A document needs at least one layer.');
      return;
    }
    doc.transact('Delete Layer', () => doc.remove(layer.id));
  }

  /** Flatten the tree into rows (top of the stack first). */
  flatten() {
    const ed = this.app.editor;
    const doc = ed.doc;
    const rows = [];
    const f = this.filter;
    const layersOnly = this.options.layersOnly;
    const matches = (n) => !f || defaultLabel(n).toLowerCase().includes(f);
    const subtreeMatches = (n) => matches(n) || (n.children || []).some((c) => subtreeMatches(doc.get(c)));
    const visit = (id, depth, parentHidden, parentLocked) => {
      const n = doc.get(id);
      if (!n) return;
      if (f && !subtreeMatches(n)) return;
      let kids = n.type === 'compound' ? [] : n.children || [];
      if (layersOnly) kids = kids.filter((c) => doc.get(c)?.type === 'layer');
      const open = this.expanded.has(id) || (f && kids.length > 0);
      rows.push({ id, depth, node: n, hasKids: kids.length > 0, open, dimHidden: parentHidden, dimLocked: parentLocked });
      if (open) for (let i = kids.length - 1; i >= 0; i--) visit(kids[i], depth + 1, parentHidden || n.hidden, parentLocked || n.locked);
    };
    const layers = doc.root.children;
    for (let i = layers.length - 1; i >= 0; i--) visit(layers[i], 0, false, false);
    return rows;
  }

  update() {
    const ed = this.app.editor;
    if (!ed) {
      this.rows = [];
      this.tree.replaceChildren(h('p.panel-empty', 'No document open.'));
      this.countEl.textContent = '';
      return;
    }
    // Reveal selected objects by expanding their ancestors.
    for (const id of ed.selection) for (const a of ed.doc.ancestors(id)) this.expanded.add(a.id);
    this.rows = this.flatten();
    const layerCount = ed.doc.layers().length;
    this.countEl.textContent = `${layerCount} ${layerCount === 1 ? 'Layer' : 'Layers'}`;
    this.spacer.style.height = `${this.rows.length * this.rowH}px`;
    this.renderRows(true);
  }

  renderRows() {
    const ed = this.app.editor;
    if (!ed || !this.rows) return;
    const top = this.viewport.scrollTop;
    const height = this.viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / this.rowH) - 4);
    const last = Math.min(this.rows.length, Math.ceil((top + height) / this.rowH) + 4);
    this.tree.style.transform = `translateY(${first * this.rowH}px)`;
    const frag = [];
    const selectedLeaves = new Set(ed.selection);
    const selectedIn = new Set();
    for (const id of ed.selection) for (const a of ed.doc.ancestors(id)) selectedIn.add(a.id);
    for (let i = first; i < last; i++) frag.push(this.renderRow(this.rows[i], i, selectedLeaves, selectedIn));
    this.tree.replaceChildren(...frag);
    const focused = this.rows[this.focusIndex];
    this.tree.setAttribute('aria-activedescendant', focused ? `lrow-${focused.id}` : '');
  }

  renderRow(r, index, selected, selectedIn) {
    const { node: n } = r;
    const ed = this.app.editor;
    const doc = ed.doc;
    const isLayer = n.type === 'layer';
    const color = doc.layerOf(n.id)?.color || '#4f80ff';
    const isSel = selected.has(n.id);
    const picked = isLayer && layerPicks(ed).has(n.id);
    const opts = this.options;
    const rowH = this.rowH;
    const row = h('div.layer-row', {
      id: `lrow-${n.id}`,
      role: 'treeitem',
      'aria-level': String(r.depth + 1),
      'aria-selected': String(isSel || picked),
      'aria-expanded': r.hasKids ? String(r.open) : null,
      'aria-label': `${defaultLabel(n)}${n.hidden ? ', hidden' : ''}${n.locked ? ', locked' : ''}`,
      draggable: 'true',
      style: { '--depth': r.depth, '--layer-color': color, height: `${rowH}px` },
    });
    row.classList.toggle('picked', picked);
    row.classList.toggle('template', Boolean(isLayer && n.template));
    row.classList.toggle('is-layer', isLayer);
    row.classList.toggle('selected', isSel);
    row.classList.toggle('active-layer', isLayer && n.id === ed.activeLayerId);
    row.classList.toggle('focused', index === this.focusIndex);
    row.classList.toggle('dim', Boolean(r.dimHidden || n.hidden));
    const eye = h(
      'button.lr-eye',
      {
        type: 'button',
        tabindex: '-1',
        'aria-label': n.hidden ? 'Show' : 'Hide',
        // Cmd/Ctrl-click a layer's eye switches that layer between Preview and Outline.
        onclick: (e) => (e.stopPropagation(), isLayer && (e.metaKey || e.ctrlKey) && !n.hidden ? this.toggle(n, 'outline', e.altKey) : this.toggle(n, 'hidden', e.altKey)),
      },
      n.hidden ? null : icon(n.outline ? 'eye-off' : 'eye', 14),
    );
    const lock = h(
      'button.lr-lock',
      { type: 'button', tabindex: '-1', 'aria-label': n.locked ? 'Unlock' : 'Lock', onclick: (e) => (e.stopPropagation(), this.toggle(n, 'locked', e.altKey)) },
      n.locked ? icon('lock', 13) : null,
    );
    const twisty = h(
      'button.lr-twisty',
      { type: 'button', tabindex: '-1', 'aria-hidden': 'true', onclick: (e) => (e.stopPropagation(), this.setOpen(n.id, !r.open)) },
      r.hasKids ? icon(r.open ? 'chevron-down' : 'chevron-right', 12) : null,
    );
    // Panel Options decide which rows show thumbnails; the rest show a type icon (layers nothing).
    const showThumb = isLayer ? opts.thumbLayers && (!opts.thumbTopOnly || n.parent === 'root') : n.type === 'group' ? opts.thumbGroups : opts.thumbObjects;
    const size = Math.max(12, Math.min(48, rowH - 8));
    const thumb = h(
      'span.lr-thumb',
      { 'aria-hidden': 'true', style: { width: `${size + 2}px`, height: `${size + 2}px` } },
      (showThumb && thumbnail(doc, n, { defer: this.thumbsSettled ? null : this.deferThumbs, size })) || (isLayer ? null : icon(typeIcon(n), 12)),
    );
    if (!showThumb && isLayer) thumb.hidden = true;
    const name = h('span.lr-name', defaultLabel(n));
    // Symbol instances carry a symbol glyph next to their (symbol) name.
    if (n.type === 'instance') name.prepend(h('span.lr-symbol', { role: 'img', 'aria-label': 'Symbol instance:' }, icon('symbol', 12)));
    const target = h('span.lr-target', { 'aria-hidden': 'true' });
    target.classList.toggle('on', isSel);
    target.classList.toggle('partial', !isSel && selectedIn.has(n.id));
    const selBox = h('button.lr-select', { type: 'button', tabindex: '-1', 'aria-label': `Select ${defaultLabel(n)}`, onclick: (e) => (e.stopPropagation(), this.selectRow(n, e)) }, target);
    row.append(h('span.lr-colorbar'), eye, lock, h('span.lr-indent'), twisty, thumb, name, selBox);
    row.addEventListener('click', (e) => {
      this.focusIndex = index;
      if (isLayer) {
        this.pickLayer(n, e);
        return;
      }
      this.selectRow(n, e);
    });
    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      // Double-clicking the name renames in place; the rest of a layer row opens Layer Options.
      if (isLayer && !e.target.closest('.lr-name, .lr-rename, button')) this.layerOptions(n);
      else this.rename(row, n);
    });
    // Drag and drop reordering.
    row.addEventListener('dragstart', (e) => {
      // Dragging a selected row moves the whole selection, like the canvas.
      this.dragState = { id: n.id, ids: ed.selection.has(n.id) ? ed.topSelection() : [n.id] };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', n.id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      this.dragState = null;
      row.classList.remove('dragging');
    });
    row.addEventListener('dragover', (e) => {
      if (!this.dragState || this.dragState.id === n.id) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const y = (e.clientY - rect.top) / rect.height;
      const zone = y < 0.3 ? 'above' : y > 0.7 ? 'below' : n.children && n.type !== 'compound' ? 'into' : y < 0.5 ? 'above' : 'below';
      row.dataset.drop = zone;
    });
    row.addEventListener('dragleave', () => delete row.dataset.drop);
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const zone = row.dataset.drop;
      delete row.dataset.drop;
      if (!this.dragState) return;
      this.dropOn(this.dragState.ids, n, zone);
    });
    return row;
  }

  /**
   * Drop one or more rows (ids) on a target row: 'above', 'below' or 'into'.
   * Several items keep their stacking order and land together.
   */
  dropOn(dragIds, target, zone) {
    const doc = this.app.editor.doc;
    const ids = doc.sortByPaintOrder((Array.isArray(dragIds) ? dragIds : [dragIds]).filter((id) => doc.get(id) && id !== target.id && !doc.isAncestor(id, target.id)));
    if (!ids.length) return;
    doc.transact('Reorder', () => {
      // The backmost item goes where it was dropped, each next one right above the previous.
      let prev = null;
      for (const id of ids) {
        if (this.#dropOne(id, prev ? doc.get(prev) : target, prev ? 'above' : zone)) prev = id;
      }
    });
  }

  #dropOne(dragId, target, zone) {
    const doc = this.app.editor.doc;
    const drag = doc.get(dragId);
    if (!drag || !target || dragId === target.id || doc.isAncestor(dragId, target.id)) return false;
    // Layers can only go into root or other layers; objects cannot go to root.
    // The top of a container's contents: in a clip group that is just under the clipping path.
    const topIndex = (c) => (c.type === 'group' && c.clip ? c.children.filter((x) => x !== dragId).length - 1 : Infinity);
    // Just below an expanded container's row is the top of its contents, where its first child row shows.
    const open = target.children?.length && target.type !== 'compound' && this.expanded.has(target.id);
    if (zone === 'below' && open && !(drag.type === 'layer' && target.type !== 'layer')) zone = 'into';
    if (zone === 'into') {
      if (drag.type === 'layer' && target.type !== 'layer') return false;
      doc.move(dragId, target.id, Math.max(0, topIndex(target)));
      this.expanded.add(target.id);
      return true;
    }
    const parent = doc.get(target.parent);
    if (!parent) return false;
    if (parent.id === 'root' && drag.type !== 'layer') {
      // Dropped above/below a layer: go to the top/bottom of that layer instead.
      doc.move(dragId, target.id, zone === 'above' ? topIndex(target) : 0);
      return true;
    }
    if (drag.type === 'layer' && parent.type !== 'root' && parent.type !== 'layer') return false;
    const siblings = parent.children.filter((c) => c !== dragId);
    const ti = siblings.indexOf(target.id);
    // Rows are top-first; children arrays are back-to-front. Nothing goes above a clipping path.
    doc.move(dragId, parent.id, Math.min(zone === 'above' ? ti + 1 : ti, topIndex(parent)));
    return true;
  }

  toggle(n, key, others) {
    const ed = this.app.editor;
    const doc = ed.doc;
    const label = { hidden: n.hidden ? 'Show' : 'Hide', locked: n.locked ? 'Unlock' : 'Lock', outline: n.outline ? 'Preview Layer' : 'Outline Layer' }[key];
    doc.transact(label, () => {
      if (others) {
        // Alt-click: toggle every other layer at this level.
        const parent = doc.get(n.parent);
        const value = !parent.children.filter((c) => c !== n.id).every((c) => doc.get(c)[key]);
        for (const c of parent.children) if (c !== n.id) doc.update(c, { [key]: value });
        doc.update(n.id, { [key]: false });
      } else doc.update(n.id, { [key]: !n[key] });
    });
    if (key !== 'hidden' || !n.hidden) {
      for (const id of [...ed.selection]) if (doc.isHidden(id) || doc.isLocked(id)) ed.selection.delete(id);
      ed.emit('selection');
    }
  }

  /** Layer Options: name, color, template, lock, show, print and preview for an existing layer. */
  async layerOptions(n) {
    const ed = this.app.editor;
    const doc = ed?.doc;
    if (!doc) return;
    const v = await this.app.dialogs.form({
      title: 'Layer Options',
      fields: [
        { key: 'name', label: 'Name', type: 'text', value: n.name || defaultLabel(n) },
        { key: 'color', label: 'Color', type: 'color', value: n.color || '#4f80ff' },
        { key: 'template', label: 'Template', type: 'checkbox', value: Boolean(n.template) },
        { key: 'locked', label: 'Lock', type: 'checkbox', value: Boolean(n.locked) },
        { key: 'show', label: 'Show', type: 'checkbox', value: !n.hidden },
        { key: 'print', label: 'Print', type: 'checkbox', value: n.print !== false },
        { key: 'preview', label: 'Preview', type: 'checkbox', value: !n.outline },
        { key: 'dim', label: 'Dim Images', type: 'checkbox', value: n.dimImages != null ? n.dimImages > 0 : Boolean(n.template) },
        { key: 'dimImages', label: 'Dim images to (%)', type: 'number', value: n.dimImages || 50, min: 0, max: 100 },
      ],
    });
    const cur = doc.get(n.id);
    if (!v || !cur) return;
    // A template layer is locked and does not print.
    const becameTemplate = v.template && !cur.template;
    doc.transact('Layer Options', () =>
      doc.update(n.id, {
        name: String(v.name || '').trim() || cur.name,
        color: v.color,
        template: Boolean(v.template),
        locked: Boolean(v.locked || becameTemplate),
        hidden: !v.show,
        print: v.template ? false : Boolean(v.print),
        outline: !v.preview,
        dimImages: v.dim ? Math.max(0, Math.min(100, v.dimImages)) : 0,
      }),
    );
    for (const id of [...ed.selection]) if (doc.isHidden(id) || doc.isLocked(id)) ed.selection.delete(id);
    ed.emit('selection');
  }

  /**
   * Click on a layer row: it becomes the active layer and the picked layer
   * (the layers the panel menu's layer commands act on). Cmd/Ctrl-click
   * adds or removes it, Shift-click picks the range from the last pick.
   */
  pickLayer(n, e = {}) {
    const ed = this.app.editor;
    const picks = layerPicks(ed);
    if (e.metaKey || e.ctrlKey) {
      if (picks.has(n.id) && picks.size > 1) picks.delete(n.id);
      else picks.add(n.id);
    } else if (e.shiftKey && this.lastPick && picks.has(this.lastPick)) {
      const layerRows = this.rows.filter((r) => r.node.type === 'layer').map((r) => r.id);
      const a = layerRows.indexOf(this.lastPick);
      const b = layerRows.indexOf(n.id);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) picks.add(layerRows[i]);
      else picks.add(n.id);
    } else {
      picks.clear();
      picks.add(n.id);
    }
    if (!e.shiftKey) this.lastPick = n.id;
    ed.activeLayerId = n.id;
    ed.emit('active-layer');
    this.renderRows();
  }

  /** Locate Object: reveal an object's row (expanding its ancestors), scroll to it and focus it. */
  locate(id) {
    const ed = this.app.editor;
    if (!ed || !ed.doc.has(id)) return false;
    this.ensureBuilt();
    for (const a of ed.doc.ancestors(id)) this.expanded.add(a.id);
    if (this.filter) {
      this.filter = '';
      this.search.value = '';
    }
    this.rows = this.flatten();
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.focusIndex = i;
    const rowH = this.rowH;
    this.spacer.style.height = `${this.rows.length * rowH}px`;
    const view = this.viewport.clientHeight || 400;
    this.viewport.scrollTop = Math.max(0, i * rowH - view / 2 + rowH / 2);
    this.renderRows();
    this.tree.focus({ preventScroll: true });
    return true;
  }

  /** Panel Options: rows for layers only, row size and which rows show thumbnails. */
  async panelOptions() {
    const o = this.options;
    const v = await this.app.dialogs.form({
      title: 'Layers Panel Options',
      fields: [
        { key: 'layersOnly', label: 'Show Layers Only', type: 'checkbox', value: o.layersOnly },
        { type: 'heading', label: 'Row Size' },
        {
          key: 'rowSize',
          label: 'Row size',
          type: 'radio',
          value: o.rowSize,
          options: [
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
            { value: 'other', label: 'Other' },
          ],
        },
        { key: 'rowHeight', label: 'Other height (px)', type: 'number', value: o.rowHeight, min: 12, max: 100 },
        { type: 'heading', label: 'Thumbnails' },
        { key: 'thumbLayers', label: 'Layers', type: 'checkbox', value: o.thumbLayers },
        { key: 'thumbTopOnly', label: 'Top Level Only', type: 'checkbox', value: o.thumbTopOnly },
        { key: 'thumbGroups', label: 'Groups', type: 'checkbox', value: o.thumbGroups },
        { key: 'thumbObjects', label: 'Objects', type: 'checkbox', value: o.thumbObjects },
      ],
    });
    if (!v) return;
    const next = { ...o, ...v, rowHeight: Math.round(Number(v.rowHeight) || o.rowHeight) };
    this.app.prefs.set('layersPanel', next);
    this.update();
  }

  setOpen(id, open) {
    if (open) this.expanded.add(id);
    else this.expanded.delete(id);
    this.update();
  }

  selectRow(n, e) {
    const ed = this.app.editor;
    const doc = ed.doc;
    if (doc.isLocked(n.id) || doc.isHidden(n.id)) return;
    const add = e?.shiftKey || e?.metaKey || e?.ctrlKey;
    if (n.type === 'layer') {
      // Selecting a layer's target selects everything on it.
      const ids = n.children.filter((c) => !doc.get(c)?.locked && !doc.get(c)?.hidden);
      ed.select(ids, { add });
      ed.activeLayerId = n.id;
      ed.emit('active-layer');
      return;
    }
    ed.select([n.id], { toggle: add, add });
  }

  rename(row, n) {
    const nameEl = row.querySelector('.lr-name');
    const input = h('input.lr-rename', { type: 'text', value: n.name || defaultLabel(n), 'aria-label': 'Name' });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const done = (commit) => {
      if (commit && input.value !== (n.name || defaultLabel(n))) {
        const doc = this.app.editor.doc;
        doc.transact('Rename', () => doc.update(n.id, { name: input.value.trim() }));
      } else this.renderRows();
      this.tree.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true), { once: true });
  }

  onKey(e) {
    const rows = this.rows;
    if (!rows.length) return;
    const r = rows[this.focusIndex];
    const move = (i) => {
      this.focusIndex = Math.max(0, Math.min(rows.length - 1, i));
      const top = this.focusIndex * this.rowH;
      if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
      else if (top + this.rowH > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = top + this.rowH - this.viewport.clientHeight;
      this.renderRows();
    };
    switch (e.key) {
      case 'ArrowDown':
        move(this.focusIndex + 1);
        break;
      case 'ArrowUp':
        move(this.focusIndex - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (r.hasKids && !r.open) this.setOpen(r.id, true);
        else move(this.focusIndex + 1);
        break;
      case 'ArrowLeft':
        if (r.hasKids && r.open) this.setOpen(r.id, false);
        else {
          const pi = rows.findIndex((x) => x.id === r.node.parent);
          if (pi >= 0) move(pi);
        }
        break;
      case 'Enter':
        this.selectRow(r.node, e);
        break;
      case ' ':
        this.toggle(r.node, 'hidden', false);
        break;
      case 'F2': {
        const row = this.tree.querySelector(`#lrow-${CSS.escape(r.id)}`);
        if (row) this.rename(row, r.node);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
}

function countSublayers(doc) {
  let n = 0;
  doc.walk((x) => {
    if (x.type === 'layer' && x.parent !== 'root') n++;
    return x.type === 'layer';
  });
  return n;
}

function typeIcon(n) {
  if (n.type === 'instance') return 'symbol';
  if (n.type === 'group') return n.clip ? 'square-dashed' : 'group';
  if (n.type === 'text') return 'type';
  if (n.type === 'image') return 'image';
  if (n.type === 'compound') return 'combine';
  if (n.type === 'mesh') return 'tool-mesh';
  if (n.shape?.kind === 'rect') return 'square';
  if (n.shape?.kind === 'ellipse') return 'circle';
  if (n.shape?.kind === 'polygon') return 'hexagon';
  if (n.shape?.kind === 'star') return 'star';
  return 'spline';
}
