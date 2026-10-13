/**
 * Window > Flattener Preview: which parts of the artwork transparency
 * flattening (for print and PDF output, or Object > Flatten Transparency)
 * would change with a flattener preset, highlighted in a zoomable preview.
 *
 * The analysis follows the flattener (effects/flatten.js): objects with
 * opacity, blending, see-through paint or raster effects are transparent;
 * everything painted under them where they overlap is affected. Affected
 * gradients, images, patterns, type and effects need an image (complex
 * regions) unless the balance keeps vectors; at balance 0 every affected
 * area is rasterized. Type is outlined when the preset converts text to
 * outlines, and otherwise filled from the image; strokes are outlined
 * unless kept as strokes.
 */
import { h } from '../../lib/dom.js';
import { Panel, emptyState } from '../../ui/panels/panel.js';
import { icon } from '../../ui/icons.js';
import { drawArtwork, drawNode } from '../../render/draw.js';
import { rasterEffects } from '../../render/effects.js';
import { visualBounds } from '../../model/geometry.js';
import { liveDef } from '../../model/live.js';
import { flattenerControls, normalizeFlattener, FLATTENER_BUILTINS } from './flattener-presets.js';
import { listPresets, getPreset, savePreset, uniqueName } from './presets.js';

export const HIGHLIGHTS = [
  ['none', 'None (Color Preview)'],
  ['complex', 'Rasterized Complex Regions'],
  ['transparent', 'Transparent Objects'],
  ['affected', 'All Affected Objects'],
  ['links', 'Affected Linked Files'],
  ['patterns', 'Expanded Patterns'],
  ['strokes', 'Outlined Strokes'],
  ['text', 'Outlined Text'],
  ['rasterFill', 'Raster-fill Text and Strokes'],
  ['rasterized', 'All Rasterized Regions'],
];

const overlap = (a, b) => Boolean(a && b) && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const seeThrough = (p) => Boolean(p) && ((p.opacity ?? 1) < 1 || (p.stops || []).some((s) => (s.opacity ?? 1) < 1));
const complexPaint = (p) => Boolean(p) && p.type !== 'solid';

/** Whether an object is transparent for flattening. */
export function isTransparentNode(n, overprint = 'preserve') {
  if ((n.opacity ?? 1) < 1 || (n.blendMode && n.blendMode !== 'normal') || n.knockout) return true;
  if (rasterEffects(n)) return true;
  if (overprint === 'simulate' && (n.overprintFill || n.overprintStroke)) return true;
  return seeThrough(n.fill) || seeThrough(n.stroke);
}

/**
 * Analyze the document (or a region) for flattening.
 * Returns { leaves, transparent, affected, links, patterns, strokes, text,
 * rasterFill, complexRegions, rasterRegions } (Sets of ids and arrays of rects).
 */
export function analyzeFlattening(doc, values, { overprint = 'preserve', region = null } = {}) {
  const v = normalizeFlattener(values);
  // Paint-ordered visible leaves (groups contribute their transparency to their leaves).
  const leaves = [];
  const visit = (id, inherited) => {
    const n = doc.get(id);
    if (!n || n.hidden) return;
    const transparentHere = n.type !== 'layer' && isTransparentNode(n, overprint);
    const t = inherited || transparentHere;
    const leaf = !n.children || n.type === 'compound' || (liveDef(n) && n.type !== 'group');
    if (leaf || (n.type === 'group' && n.clip)) {
      const b = visualBounds(doc, n);
      if (b && (!region || overlap(b, region))) leaves.push({ n, b, transparent: t });
      return;
    }
    for (const c of n.children) visit(c, t);
  };
  for (const id of doc.root.children) {
    const l = doc.get(id);
    if (l && !l.hidden && !l.template && l.print !== false) visit(id, false);
  }
  const transparent = new Set(leaves.filter((x) => x.transparent).map((x) => x.n.id));
  const affected = new Set(transparent);
  for (let i = 0; i < leaves.length; i++) {
    if (!leaves[i].transparent) continue;
    // Everything below a transparent object that it overlaps is involved in the flattening.
    for (let j = 0; j < i; j++) if (overlap(leaves[j].b, leaves[i].b)) affected.add(leaves[j].n.id);
  }
  const out = { leaves: leaves.map((x) => x.n.id), transparent, affected, links: new Set(), patterns: new Set(), strokes: new Set(), text: new Set(), rasterFill: new Set(), complexRegions: [], rasterRegions: [] };
  for (const { n, b } of leaves) {
    if (!affected.has(n.id)) continue;
    const complex = n.type === 'image' || complexPaint(n.fill) || complexPaint(n.stroke) || Boolean(rasterEffects(n)) || (n.type === 'text' && !v.textToOutlines) || Boolean(liveDef(n));
    if (n.type === 'image' && n.link) out.links.add(n.id);
    if (n.fill?.type === 'pattern' || n.stroke?.type === 'pattern') out.patterns.add(n.id);
    const stroked = n.stroke && (n.strokeWidth ?? 0) > 0;
    if (n.type === 'text') {
      if (v.textToOutlines) out.text.add(n.id);
      else out.rasterFill.add(n.id);
    } else if (stroked) {
      if (complexPaint(n.stroke)) out.rasterFill.add(n.id);
      else if (v.strokesToOutlines || transparent.has(n.id)) out.strokes.add(n.id);
    }
    if (v.balance <= 0 || complex) out.complexRegions.push(b);
  }
  // Everything that becomes an image: complex regions, raster effects anywhere, and all affected areas at balance 0.
  out.rasterRegions = [...out.complexRegions];
  for (const { n, b } of leaves) if (rasterEffects(n) && !affected.has(n.id)) out.rasterRegions.push(b);
  return out;
}

/** Ids or rects to highlight for a highlight mode. */
export function highlightTargets(analysis, mode) {
  switch (mode) {
    case 'transparent':
      return { ids: analysis.transparent, rects: [] };
    case 'affected':
      return { ids: analysis.affected, rects: [] };
    case 'links':
      return { ids: analysis.links, rects: [] };
    case 'patterns':
      return { ids: analysis.patterns, rects: [] };
    case 'strokes':
      return { ids: analysis.strokes, rects: [] };
    case 'text':
      return { ids: analysis.text, rects: [] };
    case 'rasterFill':
      return { ids: analysis.rasterFill, rects: [] };
    case 'complex':
      return { ids: new Set(), rects: analysis.complexRegions };
    case 'rasterized':
      return { ids: new Set(), rects: analysis.rasterRegions };
    default:
      return { ids: new Set(), rects: [] };
  }
}

const HIGHLIGHT = '#ff2a2a';

/** A view of the document painting the chosen objects in the highlight color. */
function highlightView(doc, ids) {
  const red = { type: 'solid', color: HIGHLIGHT };
  return {
    get: (id) => {
      const n = doc.get(id);
      if (!n || !ids.has(id)) return n;
      return { ...n, fill: n.fill || n.type === 'text' ? red : null, stroke: n.stroke ? red : null, opacity: 1, blendMode: 'normal', effects: [] };
    },
    has: (id) => doc.has(id),
    assets: doc.assets,
    get root() {
      return doc.root;
    },
    name: doc.name,
    artboards: doc.artboards,
    walk: (fn) => doc.walk(fn),
  };
}

export class FlattenerPreviewPanel extends Panel {
  static id = 'flattenerPreview';
  static title = 'Flattener Preview';
  static icon = 'panel-flattener';
  static placement = 'strip';

  build() {
    const app = this.app;
    this.mode = 'complex';
    this.overprint = 'preserve';
    this.presetName = 'Medium Resolution';
    this.values = normalizeFlattener(FLATTENER_BUILTINS['Medium Resolution']);
    this.analysis = null;
    this.stale = true;
    this.view = null; // { s, ox, oy } document -> canvas
    this.showOptions = false;
    this.empty = emptyState('Open a document to preview flattening.');
    this.refreshBtn = h('button.btn.small', { type: 'button', onclick: () => this.refresh() }, icon('refresh-cw', 14), 'Refresh');
    this.highlight = h('select', { 'aria-label': 'Highlight', onchange: () => {
      this.mode = this.highlight.value;
      this.draw();
    } }, HIGHLIGHTS.map(([v, l]) => h('option', { value: v, selected: v === this.mode }, l)));
    this.overSel = h('select', { 'aria-label': 'Overprint', onchange: () => {
      this.overprint = this.overSel.value;
      this.refresh();
    } }, [['preserve', 'Preserve Overprint'], ['simulate', 'Simulate Overprint'], ['discard', 'Discard Overprint']].map(([v, l]) => h('option', { value: v }, l)));
    this.presetSel = h('select', { 'aria-label': 'Flattener preset', onchange: () => {
      const p = getPreset(app, 'flattener', this.presetSel.value);
      if (p) {
        this.presetName = p.name;
        this.values = p.values;
        this.controls.set(p.values);
      }
      this.refresh();
    } });
    this.controls = flattenerControls(this.values, (v) => {
      this.values = v;
      this.presetName = '';
      this.fillPresets();
      this.refresh();
    });
    this.options = h('div.fp-options', { hidden: true }, this.controls.el);
    this.optionsBtn = h('button.btn.small.ghost', { type: 'button', 'aria-expanded': 'false', onclick: () => this.toggleOptions() }, 'Show Options');
    this.canvas = h('canvas.fp-canvas', { width: 260, height: 200, role: 'img', 'aria-label': 'Flattener preview', tabindex: '0' });
    this.status = h('p.fp-status', { role: 'status' });
    this.zoomOut = h('button.icon-btn', { type: 'button', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(1 / 1.5) }, icon('zoom-out', 14));
    this.zoomIn = h('button.icon-btn', { type: 'button', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.5) }, icon('zoom-in', 14));
    this.fitBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Fit artboard', onclick: () => this.fit() }, icon('maximize', 14));
    this.body = h(
      'div.fp-body',
      h('div.fp-row', this.refreshBtn, h('label.fp-field', 'Highlight', this.highlight)),
      h('label.fp-field', 'Overprint', this.overSel),
      h('label.fp-field', 'Preset', this.presetSel),
      this.optionsBtn,
      this.options,
      h('div.fp-preview', this.canvas, h('div.fp-zoom', this.zoomOut, this.fitBtn, this.zoomIn)),
      this.status,
    );
    this.el.append(this.empty, this.body);
    this.fillPresets();
    this.bindCanvas();
    app.prefs.on?.('change', ({ key }) => key === 'flattenerPresets' && this.fillPresets());
  }

  fillPresets() {
    const presets = listPresets(this.app, 'flattener');
    this.presetSel.replaceChildren(...presets.map((p) => h('option', { value: p.name, selected: p.name === this.presetName }, p.name)), h('option', { value: '', selected: !this.presetName }, 'Custom'));
  }

  toggleOptions(force) {
    this.showOptions = force ?? !this.showOptions;
    this.options.hidden = !this.showOptions;
    this.optionsBtn.textContent = this.showOptions ? 'Hide Options' : 'Show Options';
    this.optionsBtn.setAttribute('aria-expanded', String(this.showOptions));
  }

  bindCanvas() {
    let drag = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.view) return;
      drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy };
      this.canvas.setPointerCapture?.(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.view = { ...this.view, ox: drag.ox + e.clientX - drag.x, oy: drag.oy + e.clientY - drag.y };
      this.draw();
    });
    this.canvas.addEventListener('pointerup', () => (drag = null));
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.view) return;
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    this.canvas.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') this.zoomBy(1.5);
      else if (e.key === '-') this.zoomBy(1 / 1.5);
      else if (e.key === '0') this.fit();
      else if (e.key.startsWith('Arrow') && this.view) {
        const d = 20;
        this.view = { ...this.view, ox: this.view.ox + (e.key === 'ArrowLeft' ? d : e.key === 'ArrowRight' ? -d : 0), oy: this.view.oy + (e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0) };
        this.draw();
      } else return;
      e.preventDefault();
    });
  }

  /** Zoom around a canvas point (default: the center). */
  zoomBy(f, cx = this.canvasSize().w / 2, cy = this.canvasSize().h / 2) {
    if (!this.view) return;
    const s = Math.max(0.01, Math.min(64, this.view.s * f));
    const k = s / this.view.s;
    this.view = { s, ox: cx - (cx - this.view.ox) * k, oy: cy - (cy - this.view.oy) * k };
    this.draw();
  }

  canvasSize() {
    const w = Math.max(160, Math.round(this.el.clientWidth || 260) - 20);
    return { w, h: Math.round(w * 0.75) };
  }

  /** The area previewed: the active artboard, or the artwork. */
  area() {
    const ed = this.editor;
    const a = ed?.artboard?.();
    return a ? { x: a.x, y: a.y, w: a.w, h: a.h } : { x: 0, y: 0, w: 612, h: 792 };
  }

  fit() {
    const { w, h: hh } = this.canvasSize();
    const r = this.area();
    const s = Math.min((w - 16) / r.w, (hh - 16) / r.h);
    this.view = { s, ox: (w - r.w * s) / 2 - r.x * s, oy: (hh - r.h * s) / 2 - r.y * s };
    this.draw();
  }

  refresh() {
    const ed = this.editor;
    if (!ed) return;
    this.analysis = analyzeFlattening(ed.doc, this.values, { overprint: this.overprint });
    this.stale = false;
    if (!this.view) this.fit();
    else this.draw();
  }

  menu() {
    const has = () => Boolean(this.app.editor);
    return [
      { label: 'Refresh', enabled: has, run: () => this.refresh() },
      { label: this.showOptions ? 'Hide Options' : 'Show Options', run: () => this.toggleOptions() },
      { label: 'Zoom to Fit', enabled: has, run: () => this.fit() },
      '-',
      { label: 'Save Flattener Preset...', run: () => this.savePreset() },
      { label: 'Redefine Preset', enabled: () => Boolean(this.presetName && !FLATTENER_BUILTINS[this.presetName]), run: () => savePreset(this.app, 'flattener', this.presetName, this.values) },
    ];
  }

  async savePreset() {
    const names = listPresets(this.app, 'flattener').map((p) => p.name);
    const v = await this.app.dialogs.form({ title: 'Save Flattener Preset', fields: [{ key: 'name', label: 'Name', type: 'text', value: uniqueName(names, 'Flattener Preset', true) }] });
    const name = v?.name?.trim();
    if (!name) return;
    try {
      savePreset(this.app, 'flattener', name, this.values);
    } catch (err) {
      this.app.notify(err.message, { error: true });
      return;
    }
    this.presetName = name;
    this.fillPresets();
  }

  update() {
    if (!this.built) return;
    const ed = this.editor;
    this.empty.hidden = Boolean(ed);
    this.body.hidden = !ed;
    if (!ed) return;
    if (this.lastDoc !== ed.doc) {
      this.lastDoc = ed.doc;
      this.view = null;
      this.stale = true;
    } else if (this.lastVersion !== ed.doc.nodes?.version) this.stale = true;
    this.lastVersion = ed.doc.nodes?.version;
    if (!this.analysis || this.lastAnalyzed !== ed.doc) {
      this.lastAnalyzed = ed.doc;
      this.refresh();
    } else this.draw();
  }

  draw() {
    const ed = this.editor;
    if (!ed || !this.analysis) return;
    const { w, h: hh } = this.canvasSize();
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== w * dpr || this.canvas.height !== hh * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = hh * dpr;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${hh}px`;
    }
    const ctx = this.canvas.getContext('2d');
    const { ids, rects } = highlightTargets(this.analysis, this.mode);
    const count = ids.size || rects.length;
    const label = HIGHLIGHTS.find(([v]) => v === this.mode)[1];
    this.status.textContent = this.mode === 'none' ? `${this.analysis.affected.size} object${this.analysis.affected.size === 1 ? '' : 's'} affected by transparency.${this.stale ? ' The document changed: Refresh to update.' : ''}` : `${label}: ${count} ${ids.size ? 'object' : 'region'}${count === 1 ? '' : 's'}.${this.stale ? ' The document changed: Refresh to update.' : ''}`;
    if (!ctx || typeof ctx.fillRect !== 'function' || !this.view) return;
    const v = this.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, w, hh);
    ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.ox, dpr * v.oy);
    const a = this.area();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(a.x, a.y, a.w, a.h);
    const viewRect = { x: -v.ox / v.s, y: -v.oy / v.s, w: w / v.s, h: hh / v.s };
    const opts = { viewRect, outline: false, hairline: 1 / v.s, scale: v.s * dpr, overprint: this.overprint === 'simulate' };
    const doc = ed.doc;
    if (this.mode === 'none') drawArtwork(ctx, doc, opts);
    else {
      // The artwork faded to gray with the highlighted parts in red on top.
      if ('filter' in ctx) ctx.filter = 'grayscale(1) opacity(0.45)';
      drawArtwork(ctx, doc, opts);
      if ('filter' in ctx) ctx.filter = 'none';
      if (ids.size) {
        const hv = highlightView(doc, ids);
        for (const id of ids) drawNode(ctx, hv, hv.get(id), opts);
      }
      ctx.fillStyle = 'rgba(255, 42, 42, 0.55)';
      for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
