/**
 * Pattern Options panel: the tile, layout and preview settings of the
 * pattern being edited. Every change is a document edit on the editing
 * layer (undoable), so the copies around the tile update as you type. Out
 * of pattern editing mode the panel offers Make Pattern and Edit Pattern.
 * The panel menu makes, edits, saves, finishes or cancels patterns and
 * toggles the tile and preview options.
 */
import { h } from '../../lib/dom.js';
import { Panel, emptyState } from '../../ui/panels/panel.js';
import { numberField, segmented, selectField, iconButton } from '../../ui/widgets.js';
import { TILE_TYPES, BRICK_OFFSETS, COPIES, lattice } from './model.js';
import { editLayer, editTile, setOptions, defFromLayer } from './edit.js';
import { cellBitmap } from './render.js';

const DIM_STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
let fid = 0;

function check(label, onChange) {
  const id = `po-${++fid}`;
  const input = h('input', { type: 'checkbox', id, onchange: () => onChange(input.checked) });
  return { el: h('div.check-row', input, h('label', { for: id }, label)), input };
}

function row(label, control, forId) {
  return h('div.prop-row', h(forId ? 'label.prop-label' : 'span.prop-label', forId ? { for: forId } : {}, label), control);
}

export class PatternOptionsPanel extends Panel {
  static id = 'patternOptions';
  static title = 'Pattern Options';
  static icon = 'pattern-options';
  static placement = 'strip';

  build() {
    const app = this.app;
    const set = (patch, label) => app.editor && setOptions(app.editor, patch, label);
    this.empty = h(
      'div.po-empty',
      emptyState('Select artwork and make a pattern, or edit a pattern swatch. Its tile and layout settings appear here while you edit it.'),
      h(
        'div.po-empty-actions',
        (this.makeBtn = h('button.btn.small', { type: 'button', onclick: () => app.commands.run('pattern.make') }, 'Make Pattern')),
        (this.editBtn = h('button.btn.small', { type: 'button', onclick: () => app.commands.run('pattern.edit') }, 'Edit Pattern')),
      ),
    );
    const unit = () => app.editor?.doc.root.units || 'pt';
    this.tileTool = iconButton('pattern-tile-tool', 'Pattern Tile Tool (drag the tile edges)', () => app.setTool(app.toolId === 'pattern-tile' ? app.lastSelectionTool : 'pattern-tile'), { className: 'small po-tile-tool', pressed: false });
    this.name = h('input.po-name', { type: 'text', id: 'po-name', spellcheck: false, autocomplete: 'off' });
    this.name.addEventListener('change', () => this.name.value.trim() && set({ name: this.name.value.trim() }, 'Rename Pattern'));
    this.name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.name.blur();
    });
    this.type = selectField('Tile Type', TILE_TYPES, 'grid', (v) => set({ tileType: v }), { id: 'po-type' });
    this.offset = selectField('Brick Offset', BRICK_OFFSETS.map((v) => ({ value: v, label: v })), '1/2', (v) => set({ brickOffset: v }), { id: 'po-offset' });
    this.preview = h('canvas.po-preview', { width: 64, height: 64, role: 'img', 'aria-label': 'Tile preview' });
    this.linkSize = false;
    this.linkSpacing = false;
    const sizeLink = () => iconButton('link', 'Keep width and height proportional', (e) => {
      this.linkSize = !this.linkSize;
      e.currentTarget.setAttribute('aria-pressed', String(this.linkSize));
    }, { className: 'small', pressed: false });
    this.w = numberField({ label: 'Width', unit: unit(), min: 0.01, value: 72, onCommit: (v) => this.setSize('width', v) });
    this.hgt = numberField({ label: 'Height', unit: unit(), min: 0.01, value: 72, onCommit: (v) => this.setSize('height', v) });
    this.sizeToArt = check('Size Tile to Art', (v) => set({ sizeToArt: v }));
    this.moveWithArt = check('Move Tile with Art', (v) => set({ moveWithArt: v }));
    this.hs = numberField({ label: 'H Spacing', unit: unit(), value: 0, onCommit: (v) => set(this.linkSpacing ? { hSpacing: v, vSpacing: v } : { hSpacing: v }) });
    this.vs = numberField({ label: 'V Spacing', unit: unit(), value: 0, onCommit: (v) => set(this.linkSpacing ? { hSpacing: v, vSpacing: v } : { vSpacing: v }) });
    const spacingLink = iconButton('link', 'Use the same spacing both ways', (e) => {
      this.linkSpacing = !this.linkSpacing;
      e.currentTarget.setAttribute('aria-pressed', String(this.linkSpacing));
    }, { className: 'small', pressed: false });
    this.overlapH = segmented('Horizontal overlap', [{ value: 'left', label: 'Left in Front', icon: 'overlap-left' }, { value: 'right', label: 'Right in Front', icon: 'overlap-right' }], 'left', (v) => set({ overlapH: v }));
    this.overlapV = segmented('Vertical overlap', [{ value: 'top', label: 'Top in Front', icon: 'overlap-top' }, { value: 'bottom', label: 'Bottom in Front', icon: 'overlap-bottom' }], 'top', (v) => set({ overlapV: v }));
    this.copies = selectField('Copies', COPIES.map((c) => ({ value: c, label: c.replace('x', ' × ') })), '5x5', (v) => set({ copies: v }, 'Pattern Preview'), { id: 'po-copies' });
    this.dimCopies = check('Dim Copies to', (v) => set({ dimCopies: v }, 'Pattern Preview'));
    this.dim = selectField('Dim amount', DIM_STEPS.map((d) => ({ value: String(d), label: `${d}%` })), '70', (v) => set({ dim: Number(v) }, 'Pattern Preview'));
    this.tileEdge = check('Show Tile Edge', (v) => set({ showTileEdge: v }, 'Pattern Preview'));
    this.swatchBounds = check('Show Swatch Bounds', (v) => set({ showSwatchBounds: v }, 'Pattern Preview'));
    this.form = h(
      'div.po-form',
      h('div.po-head', this.tileTool, h('span.po-hint', 'Drag the tile with the Pattern Tile tool, or set its size below.')),
      h(
        'section.panel-section',
        h('div.po-top', h('div.po-fields', row('Name', this.name, 'po-name'), row('Tile Type', this.type.el, 'po-type'), row('Brick Offset', this.offset.el, 'po-offset')), this.preview),
      ),
      h(
        'section.panel-section',
        h('h3.section-title', 'Tile'),
        h('div.po-pair', h('div', this.w.el, this.hgt.el), sizeLink()),
        this.sizeToArt.el,
        this.moveWithArt.el,
        h('div.po-pair', h('div', this.hs.el, this.vs.el), spacingLink),
        row('Overlap', h('div.po-overlap', this.overlapH.el, this.overlapV.el)),
      ),
      h(
        'section.panel-section',
        h('h3.section-title', 'Preview'),
        row('Copies', this.copies.el, 'po-copies'),
        h('div.po-dim', this.dimCopies.el, this.dim.el),
        this.tileEdge.el,
        this.swatchBounds.el,
      ),
      h(
        'div.po-actions',
        h('button.btn.small', { type: 'button', onclick: () => app.commands.run('pattern.saveCopy') }, 'Save a Copy'),
        h('span.po-spacer'),
        h('button.btn.small', { type: 'button', onclick: () => app.commands.run('pattern.cancel') }, 'Cancel'),
        h('button.btn.small.primary', { type: 'button', onclick: () => app.commands.run('pattern.done') }, 'Done'),
      ),
    );
    this.el.append(this.empty, this.form);
  }

  menu() {
    const app = this.app;
    const ed = app.editor;
    const layer = ed ? editLayer(ed.doc) : null;
    const p = layer?.pattern || {};
    const toggle = (key, label, extra = {}) => ({ label, checked: Boolean(p[key]), enabled: Boolean(layer) && extra.enabled !== false, run: () => setOptions(ed, { [key]: !p[key] }, extra.undo || label) });
    return [
      { id: 'pattern.make', label: 'Make Pattern' },
      'pattern.edit',
      '-',
      { id: 'pattern.saveCopy', label: 'Save a Copy...' },
      { id: 'pattern.done', label: 'Exit Pattern Editing' },
      'pattern.cancel',
      '-',
      toggle('sizeToArt', 'Size Tile to Art'),
      toggle('moveWithArt', 'Move Tile with Art', { enabled: !p.sizeToArt }),
      '-',
      toggle('dimCopies', 'Dim Copies', { undo: 'Pattern Preview' }),
      toggle('showTileEdge', 'Show Tile Edge', { undo: 'Pattern Preview' }),
      toggle('showSwatchBounds', 'Show Swatch Bounds', { undo: 'Pattern Preview' }),
      '-',
      'pattern.tileEdgeColor',
    ];
  }

  setSize(key, v) {
    const ed = this.app.editor;
    const layer = ed && editLayer(ed.doc);
    if (!layer) return;
    const t = editTile(ed.doc, layer);
    const patch = { [key]: v, sizeToArt: false };
    if (this.linkSize) {
      const r = key === 'width' ? t.h / t.w : t.w / t.h;
      patch[key === 'width' ? 'height' : 'width'] = v * r;
    }
    // Size fields set the tile from its current size (a tile sized to the art keeps the other side).
    if (!this.linkSize) patch[key === 'width' ? 'height' : 'width'] = key === 'width' ? t.h : t.w;
    setOptions(ed, patch, 'Tile Size');
  }

  update() {
    const ed = this.app.editor;
    const layer = ed ? editLayer(ed.doc) : null;
    this.empty.hidden = Boolean(layer);
    this.form.hidden = !layer;
    if (!layer) {
      this.makeBtn.disabled = !ed || !this.app.commands.isEnabled('pattern.make');
      this.editBtn.disabled = !ed || !this.app.commands.isEnabled('pattern.edit');
      return;
    }
    const p = layer.pattern;
    const unit = ed.doc.root.units || 'pt';
    for (const f of [this.w, this.hgt, this.hs, this.vs]) f.setUnit(unit);
    if (document.activeElement !== this.name) this.name.value = p.name || '';
    this.type.set(p.tileType);
    this.offset.set(p.brickOffset);
    this.offset.el.disabled = !String(p.tileType).startsWith('brick');
    const t = editTile(ed.doc, layer);
    this.w.set(t.w);
    this.hgt.set(t.h);
    this.sizeToArt.input.checked = Boolean(p.sizeToArt);
    this.moveWithArt.input.checked = Boolean(p.moveWithArt);
    this.moveWithArt.input.disabled = Boolean(p.sizeToArt);
    this.hs.set(p.hSpacing || 0);
    this.vs.set(p.vSpacing || 0);
    this.hs.input.disabled = this.vs.input.disabled = !p.sizeToArt;
    this.overlapH.set(p.overlapH);
    this.overlapV.set(p.overlapV);
    this.copies.set(p.copies);
    this.dimCopies.input.checked = Boolean(p.dimCopies);
    this.dim.set(String(p.dim ?? 70));
    this.dim.el.disabled = !p.dimCopies;
    this.tileEdge.input.checked = Boolean(p.showTileEdge);
    this.swatchBounds.input.checked = Boolean(p.showSwatchBounds);
    this.tileTool.setAttribute('aria-pressed', String(this.app.toolId === 'pattern-tile'));
    this.drawPreview(ed, layer);
  }

  /** A few repeats of the tile, as the swatch will look. */
  drawPreview(ed, layer) {
    const c = this.preview;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = 64;
    if (c.width !== size * dpr) {
      c.width = c.height = size * dpr;
      c.style.width = c.style.height = `${size}px`;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const def = defFromLayer(ed.doc, layer);
    const { cell } = lattice(def);
    // About two tiles across.
    const s = (size * dpr) / (2 * Math.max(def.width, def.height));
    const bmp = cellBitmap(ed.doc, def, s);
    if (!bmp) return;
    const pat = ctx.createPattern?.(bmp.canvas, 'repeat');
    if (!pat) return;
    if (pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([(cell.w * s) / bmp.pw, 0, 0, (cell.h * s) / bmp.ph, 0, 0]));
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, c.width, c.height);
  }
}
