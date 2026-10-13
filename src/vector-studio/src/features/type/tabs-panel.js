/**
 * Tabs panel (Shift+Cmd+T): tab stops of the current paragraphs on a
 * ruler. The panel holds the controls and a ruler scaled to fit; while it
 * is open a second ruler sits on the canvas right above the selected type
 * frame, at the frame's position and the view's zoom, so stops line up
 * with the text they move. Both rulers work the same: click to add a stop,
 * drag to move it, drag it off the ruler to remove it; the indent markers
 * set the first-line and left indents. Stops can snap to the ruler ticks.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { icon, registerIcons } from '../../ui/icons.js';
import { iconButton, numberField, segmented } from '../../ui/widgets.js';
import { UNITS, formatLength } from '../../lib/units.js';
import { apply as applyM } from '../../lib/matrix.js';
import { layoutText } from '../../model/text-layout.js';
import { applyParaStyle, currentParaStyle, currentTextNodes, session, MIXED } from './type-ops.js';
import './tabs-panel.css';

const ALIGNS = [
  { value: 'left', label: 'Left-Justified Tab', icon: 'tab-left' },
  { value: 'center', label: 'Center-Justified Tab', icon: 'tab-center' },
  { value: 'right', label: 'Right-Justified Tab', icon: 'tab-right' },
  { value: 'decimal', label: 'Decimal-Justified Tab', icon: 'tab-decimal' },
];
const ALIGN_NAME = { left: 'Left', center: 'Center', right: 'Right', decimal: 'Decimal' };

registerIcons({
  'tab-left': [['path', { d: 'M8 5v13h9' }]],
  'tab-center': [['path', { d: 'M12 5v13M5 18h14' }]],
  'tab-right': [['path', { d: 'M16 5v13H7' }]],
  'tab-decimal': [['path', { d: 'M12 5v13M5 18h14' }], ['circle', { cx: '16', cy: '11', r: '1.3', fill: 'currentColor' }]],
  'tab-magnet': [['path', { d: 'M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z' }], ['path', { d: 'M6 8h4M14 8h4' }]],
  'tab-snap': [['path', { d: 'M3 18h18M6 18v-4M10 18v-2M14 18v-4M18 18v-2' }], ['path', { d: 'M12 4v8M9 9l3 3 3-3' }]],
});

const sortTabs = (tabs) => tabs.slice().sort((a, b) => a.pos - b.pos);

/** Ruler tick spacing in points for a scale (px per pt) and document unit. */
export function tickSteps(scale, unit) {
  const f = UNITS[unit]?.factor || 1;
  const nice = unit === 'in' ? [0.125, 0.25, 0.5, 1, 2, 5, 10] : [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let label = nice[nice.length - 1] * f;
  for (const n of nice) {
    if (n * f * scale >= 48) {
      label = n * f;
      break;
    }
  }
  const sub = unit === 'in' ? 8 : 10;
  let minor = label / sub;
  while (minor * scale < 5 && minor < label) minor *= 2;
  return { label, minor };
}

/** The text a ruler measures: frame origin (local x), width and placement. */
function rulerContext(app) {
  const nodes = currentTextNodes(app);
  if (!nodes.length) return null;
  const s = session(app);
  let node = nodes.find((n) => n.kind === 'area') || nodes[0];
  if (s) {
    // The frame showing the caret, for threaded stories.
    const lay = s.layout();
    const li = lay.lines.findIndex((l) => s.caret >= l.start && s.caret <= l.end);
    const f = lay.frames?.[lay.lines[li]?.frame ?? 0];
    if (f) node = f;
  }
  if (node.kind === 'path') return { node, origin: 0, width: 400, top: null, vertical: false };
  const lay = layoutText(node);
  if (node.kind === 'area') {
    const inset = node.areaOptions?.inset || 0;
    if (node.vertical) return { node, origin: 0, width: node.height - 2 * inset, top: null, vertical: true };
    const b = lay.bounds;
    return { node, origin: b.x + inset, width: Math.max(1, b.w - 2 * inset), top: b.y, vertical: false };
  }
  if (node.vertical) return { node, origin: 0, width: 400, top: null, vertical: true };
  const b = lay.bounds;
  return { node, origin: node.x, width: Math.max(288, b.w + 72), top: b.y, vertical: false };
}

/** One ruler: ticks, indent markers and tab stop markers, interactive. */
class TabRuler {
  constructor(panel, { onCanvas = false } = {}) {
    this.panel = panel;
    this.onCanvas = onCanvas;
    this.track = h('div.tab-track');
    this.ticks = h('div.tab-ticks', { 'aria-hidden': 'true' });
    this.markers = h('div.tab-markers');
    this.el = h(
      `div.tab-ruler${onCanvas ? '.on-canvas' : ''}`,
      { role: 'group', 'aria-label': onCanvas ? 'Tab ruler above the text' : 'Tab ruler' },
      this.ticks,
      this.track,
      this.markers,
    );
    this.scale = 1;
    this.width = 0;
    this.track.addEventListener('pointerdown', (e) => this.onTrackDown(e));
  }

  /** Points from a client x. */
  posAt(clientX) {
    const r = this.el.getBoundingClientRect();
    return (clientX - r.left) / this.scale;
  }

  render(ctx, para, scale) {
    this.scale = scale;
    this.width = ctx.width;
    const px = Math.max(1, ctx.width * scale);
    this.el.style.width = `${px}px`;
    const unit = this.panel.unit();
    const { label, minor } = tickSteps(scale, unit);
    // Ticks as one inline SVG.
    const parts = [];
    const nTicks = Math.min(2000, Math.floor(ctx.width / minor) + 1);
    for (let k = 0; k < nTicks; k++) {
      const v = k * minor;
      const x = Math.round(v * scale) + 0.5;
      const major = Math.abs(v / label - Math.round(v / label)) < 1e-6;
      const half = !major && Math.abs((v * 2) / label - Math.round((v * 2) / label)) < 1e-6;
      parts.push(`<path d="M${x} ${major ? 0 : half ? 7 : 11}V16"/>`);
      if (major && k) parts.push(`<text x="${x + 2}" y="9">${Number((v / (UNITS[unit]?.factor || 1)).toFixed(3))}</text>`);
    }
    this.ticks.innerHTML = `<svg width="${px}" height="16" viewBox="0 0 ${px} 16">${parts.join('')}</svg>`;
    // Indent markers.
    const left = para.indentLeft === MIXED ? 0 : para.indentLeft || 0;
    const first = para.indentFirst === MIXED ? 0 : para.indentFirst || 0;
    const kids = [];
    kids.push(this.indentMarker('first', left + first, 'First-line indent'));
    kids.push(this.indentMarker('left', left, 'Left indent'));
    const tabs = para.tabs === MIXED ? [] : sortTabs(para.tabs || []);
    tabs.forEach((t, i) => kids.push(this.tabMarker(t, i)));
    this.markers.replaceChildren(...kids);
  }

  indentMarker(kind, pos, label) {
    const b = h(`button.tab-indent.${kind}`, { type: 'button', 'aria-label': `${label}: ${formatLength(pos, this.panel.unit())}`, 'data-tip': label });
    b.style.left = `${pos * this.scale}px`;
    b.addEventListener('pointerdown', (e) => this.dragIndent(e, kind));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      const step = (UNITS[this.panel.unit()]?.factor || 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
      this.panel.moveIndent(kind, pos + step);
    });
    return b;
  }

  tabMarker(t, i) {
    const sel = this.panel.selected === i;
    const b = h(
      `button.tab-stop.${t.align || 'left'}${sel ? '.selected' : ''}`,
      { type: 'button', 'aria-label': `${ALIGN_NAME[t.align || 'left']} tab at ${formatLength(t.pos, this.panel.unit())}${t.leader ? `, leader ${t.leader}` : ''}`, 'aria-pressed': String(sel), 'data-index': i },
      icon(`tab-${t.align || 'left'}`, 14),
    );
    b.style.left = `${t.pos * this.scale}px`;
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.panel.select(i);
      this.dragTab(e, i);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        this.panel.removeTab(i);
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      const step = (UNITS[this.panel.unit()]?.factor || 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
      this.panel.moveTab(i, t.pos + step, { coalesce: 'tabs-nudge' });
    });
    b.addEventListener('focus', () => this.panel.select(i, { quiet: true }));
    return b;
  }

  onTrackDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = this.panel.snap(this.posAt(e.clientX));
    const i = this.panel.addTab(pos);
    if (i >= 0) this.dragTab(e, i);
  }

  dragTab(e, i) {
    const target = e.currentTarget || this.track;
    const key = `tabs-drag-${Date.now()}`;
    const r0 = this.el.getBoundingClientRect();
    let index = i;
    let removed = false;
    const move = (ev) => {
      const off = Math.abs(ev.clientY - (r0.top + r0.height / 2)) > 36;
      if (off !== removed) {
        removed = off;
        this.el.classList.toggle('removing', off);
      }
      if (off) return;
      index = this.panel.moveTab(index, this.panel.snap(this.posAt(ev.clientX)), { coalesce: key });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.el.classList.remove('removing');
      if (removed) this.panel.removeTab(index, { coalesce: key });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    target?.focus?.();
  }

  dragIndent(e, kind) {
    e.preventDefault();
    e.stopPropagation();
    const key = `tabs-indent-${Date.now()}`;
    const move = (ev) => this.panel.moveIndent(kind, this.panel.snap(this.posAt(ev.clientX)), { coalesce: key });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

export class TabsPanel extends Panel {
  static id = 'tabs';
  static title = 'Tabs';
  static icon = 'tab-left';
  static placement = 'strip';
  static shortcut = 'Shift+Mod+T';

  build() {
    const app = this.app;
    this.selected = null;
    this.newAlign = 'left';
    this.alignSeg = segmented('Tab alignment', ALIGNS, 'left', (v) => this.setAlign(v));
    this.posField = numberField({ label: 'X', ariaLabel: 'Tab position', kind: 'length', value: null, unit: this.unit(), onCommit: (v) => this.selected != null && this.moveTab(this.selected, v) });
    this.leader = h('input.tab-text', { type: 'text', maxlength: 8, spellcheck: false, autocomplete: 'off', 'aria-label': 'Leader', placeholder: 'None' });
    this.leader.addEventListener('change', () => this.setLeader(this.leader.value));
    this.leader.addEventListener('keydown', (e) => e.stopPropagation());
    this.alignOn = h('input.tab-text.short', { type: 'text', maxlength: 1, spellcheck: false, autocomplete: 'off', 'aria-label': 'Align on character', placeholder: '.' });
    this.alignOn.addEventListener('change', () => this.setDecimal(this.alignOn.value));
    this.alignOn.addEventListener('keydown', (e) => e.stopPropagation());
    this.snapBtn = iconButton('tab-snap', 'Snap to Ruler Ticks', () => this.toggleSnap(), { className: 'small', pressed: this.snapOn() });
    this.canvasBtn = iconButton('tab-magnet', 'Show Ruler Above the Text', () => this.toggleCanvas(), { className: 'small', pressed: this.canvasOn() });
    this.ruler = new TabRuler(this);
    this.canvasRuler = new TabRuler(this, { onCanvas: true });
    this.note = h('p.panel-note');
    const lab = (text, el) => h('label.tab-label', text, el);
    this.el.append(
      h('div.tab-bar', this.alignSeg.el, h('span.tab-spacer'), this.snapBtn, this.canvasBtn),
      h('div.tab-fields', h('div.tab-pos', this.posField.el), lab('Leader', this.leader), lab('Align On', this.alignOn)),
      h('div.tab-ruler-wrap', this.ruler.el),
      this.note,
    );
    this.offView = app.on('view', () => this.placeCanvasRuler());
  }

  unit() {
    return this.app.editor?.doc.root.units || 'pt';
  }

  snapOn() {
    return this.app.prefs.get('tabsSnap') === true;
  }

  canvasOn() {
    return this.app.prefs.get('tabsOnCanvas') !== false;
  }

  toggleSnap() {
    this.app.prefs.set('tabsSnap', !this.snapOn());
    this.snapBtn.setAttribute('aria-pressed', String(this.snapOn()));
  }

  toggleCanvas() {
    this.app.prefs.set('tabsOnCanvas', !this.canvasOn());
    this.canvasBtn.setAttribute('aria-pressed', String(this.canvasOn()));
    this.update();
  }

  snap(pos) {
    const ctx = this.ctx;
    let v = Math.max(0, Math.min(ctx ? ctx.width : Infinity, pos));
    if (this.snapOn()) {
      const { minor } = tickSteps(this.ruler.scale || 1, this.unit());
      v = Math.round(v / minor) * minor;
    }
    return Math.round(v * 1000) / 1000;
  }

  para() {
    return currentParaStyle(this.app) || {};
  }

  tabs() {
    const t = this.para().tabs;
    return t === MIXED ? [] : sortTabs(t || []);
  }

  commit(tabs, label, coalesce = null) {
    applyParaStyle(this.app, { tabs: tabs.length ? sortTabs(tabs) : null }, { label, coalesce });
  }

  /** Add a stop (with the current alignment); returns its index. */
  addTab(pos) {
    const tabs = this.tabs();
    if (tabs.some((t) => Math.abs(t.pos - pos) < 0.5)) return tabs.findIndex((t) => Math.abs(t.pos - pos) < 0.5);
    const t = { pos, align: this.newAlign };
    if (this.newAlign === 'decimal') t.decimal = '.';
    const next = sortTabs([...tabs, t]);
    this.commit(next, 'Add Tab');
    this.selected = next.indexOf(t);
    this.refresh();
    return this.selected;
  }

  /** Move stop i; returns its new index after sorting. */
  moveTab(i, pos, { coalesce = null } = {}) {
    const tabs = this.tabs();
    if (!tabs[i]) return i;
    const t = { ...tabs[i], pos: Math.max(0, pos) };
    const next = sortTabs([...tabs.slice(0, i), t, ...tabs.slice(i + 1)]);
    this.commit(next, 'Move Tab', coalesce);
    this.selected = next.indexOf(t);
    this.refresh();
    return this.selected;
  }

  removeTab(i, { coalesce = null } = {}) {
    const tabs = this.tabs();
    if (!tabs[i]) return;
    this.commit([...tabs.slice(0, i), ...tabs.slice(i + 1)], 'Delete Tab', coalesce);
    this.selected = null;
    this.refresh();
  }

  patchSelected(patch, label) {
    const tabs = this.tabs();
    const i = this.selected;
    if (i == null || !tabs[i]) return false;
    const next = tabs.map((t, k) => (k === i ? { ...t, ...patch } : t));
    for (const t of next) for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
    this.commit(next, label);
    this.refresh();
    return true;
  }

  setAlign(v) {
    this.newAlign = v;
    this.alignSeg.set(v);
    this.patchSelected({ align: v, decimal: v === 'decimal' ? this.tabs()[this.selected]?.decimal || '.' : undefined }, 'Tab Alignment');
    this.alignOn.disabled = v !== 'decimal';
  }

  setLeader(v) {
    this.patchSelected({ leader: v || undefined }, 'Tab Leader');
  }

  setDecimal(v) {
    this.patchSelected({ decimal: v || '.' }, 'Tab Alignment');
  }

  moveIndent(kind, pos, { coalesce = null } = {}) {
    const p = this.para();
    const left = p.indentLeft === MIXED ? 0 : p.indentLeft || 0;
    const first = p.indentFirst === MIXED ? 0 : p.indentFirst || 0;
    if (kind === 'first') applyParaStyle(this.app, { indentFirst: pos - left }, { label: 'First-Line Indent', coalesce });
    else applyParaStyle(this.app, { indentLeft: pos, indentFirst: left + first - pos }, { label: 'Left Indent', coalesce });
    this.refresh();
  }

  select(i, { quiet = false } = {}) {
    this.selected = i;
    const t = this.tabs()[i];
    if (t) {
      this.newAlign = t.align || 'left';
      this.alignSeg.set(this.newAlign);
    }
    if (!quiet) this.refresh();
    else this.refreshFields();
  }

  /** Repeat the selected stop's distance from the previous stop (or the left indent) across the ruler. */
  repeatTab() {
    const tabs = this.tabs();
    const i = this.selected;
    const t = tabs[i];
    if (!t || !this.ctx) return;
    const prev = i > 0 ? tabs[i - 1].pos : Math.max(0, this.para().indentLeft || 0);
    const d = t.pos - prev;
    if (d < 1) return;
    const out = tabs.filter((x) => x.pos <= t.pos);
    for (let p = t.pos + d; p <= this.ctx.width + 0.01; p += d) out.push({ ...t, pos: Math.round(p * 1000) / 1000 });
    this.commit(out, 'Repeat Tab');
    this.refresh();
  }

  menu() {
    const ctx = this.app.editor ? rulerContext(this.app) : null;
    this.ctx = ctx;
    const hasSel = Boolean(ctx) && this.selected != null && Boolean(this.tabs()[this.selected]);
    return [
      { label: 'Clear All', enabled: Boolean(ctx) && this.tabs().length > 0, run: () => (this.commit([], 'Clear Tabs'), (this.selected = null), this.refresh()) },
      { label: 'Delete Tab', enabled: hasSel, run: () => this.removeTab(this.selected) },
      { label: 'Repeat Tab', enabled: hasSel, run: () => this.repeatTab() },
      '-',
      { label: 'Reset Indents', enabled: Boolean(ctx), run: () => (applyParaStyle(this.app, { indentLeft: 0, indentFirst: 0 }, { label: 'Reset Indents' }), this.refresh()) },
      '-',
      { label: 'Snap to Ruler Ticks', checked: this.snapOn(), run: () => this.toggleSnap() },
      { label: 'Show Ruler Above the Text', checked: this.canvasOn(), run: () => this.toggleCanvas() },
    ];
  }

  refreshFields() {
    const t = this.tabs()[this.selected];
    this.posField.setUnit(this.unit());
    this.posField.set(t ? t.pos : null);
    this.posField.input.disabled = !t;
    this.leader.disabled = !t;
    if (document.activeElement !== this.leader) this.leader.value = t?.leader || '';
    this.alignOn.disabled = !t || (t.align || 'left') !== 'decimal';
    if (document.activeElement !== this.alignOn) this.alignOn.value = t?.align === 'decimal' ? t.decimal || '.' : '';
  }

  refresh() {
    const ctx = (this.ctx = this.app.editor ? rulerContext(this.app) : null);
    this.el.classList.toggle('disabled', !ctx);
    if (!ctx) {
      this.note.textContent = 'Select type or click in text to set its tab stops.';
      this.ruler.el.hidden = true;
      this.placeCanvasRuler();
      this.refreshFields();
      return;
    }
    this.ruler.el.hidden = false;
    const para = this.para();
    const tabs = this.tabs();
    if (this.selected != null && !tabs[this.selected]) this.selected = null;
    this.note.textContent = para.tabs === MIXED ? 'The selected paragraphs have different tab stops; changes replace them all.' : ctx.vertical ? 'Stops are measured down the columns of vertical type.' : '';
    const avail = Math.max(160, (this.el.clientWidth || 260) - 24);
    this.ruler.render(ctx, para, avail / ctx.width);
    this.refreshFields();
    this.placeCanvasRuler();
  }

  /** Put the on-canvas ruler right above the frame, at the view's zoom. */
  placeCanvasRuler() {
    const r = this.canvasRuler;
    const ctx = this.ctx;
    const ed = this.app.editor;
    const host = this.app.canvasHost;
    const m = ctx?.node.transform;
    const show = this.visible && this.canvasOn() && ctx && ed && host && ctx.top != null && !ctx.vertical && m && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && m[0] > 0 && m[3] > 0;
    if (!show) {
      r.el.hidden = true;
      return;
    }
    if (r.el.parentNode !== host) host.append(r.el);
    r.el.hidden = false;
    const p = applyM(m, ctx.origin, ctx.top);
    const s = ed.view.toScreen(p.x, p.y);
    const scale = ed.view.zoom * m[0];
    r.render(ctx, this.para(), scale);
    r.el.style.left = `${Math.round(s.x)}px`;
    r.el.style.top = `${Math.round(s.y - 34)}px`;
  }

  update() {
    if (!this.built) return;
    this.refresh();
  }

  hidden() {
    super.hidden();
    this.canvasRuler.el.hidden = true;
  }
}

export function installTabsPanel(app) {
  app.registerPanel(TabsPanel);
}
