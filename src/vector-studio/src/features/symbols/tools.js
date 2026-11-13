/**
 * Symbolism tools: brushes that spray symbol instances into a symbol set
 * and then shift, scrunch, size, spin, stain, screen and style the
 * instances under the brush. The longer the pointer stays down, the more
 * the effect builds up (Intensity sets the rate); the brush falls off
 * smoothly toward its edge. Alt reverses the effect (removes, spreads,
 * shrinks, unstains, unscreens, unstyles). [ and ] change the diameter;
 * double-clicking any of the tools opens the shared options.
 *
 * One stroke is one undo step.
 */
import { h } from '../../lib/dom.js';
import { Tool } from '../../tools/tool.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { icon } from '../../ui/icons.js';
import { formatLength, parseLength } from '../../lib/units.js';
import { multiply, translate, scale, rotate, IDENTITY } from '../../lib/matrix.js';
import { nodeBounds } from '../../model/geometry.js';
import { STYLE_KEYS } from '../../model/nodes.js';
import { mix } from '../../lib/color.js';
import {
  getDef,
  isInstance,
  isSymbolSet,
  createSymbolSet,
  createInstance,
  placementMatrix,
  masterBounds,
  wouldNestItself,
} from './model.js';
import { currentSymbol } from './state.js';
import { graphicStylesOf } from '../paint/graphic-styles.js';

export const METHODS = [
  { value: 'average', label: 'Average' },
  { value: 'user', label: 'User Defined' },
  { value: 'random', label: 'Random' },
];

export const DEFAULT_OPTIONS = Object.freeze({
  diameter: 72,
  intensity: 8,
  density: 5,
  showBrush: true,
  methods: Object.freeze({ shifter: 'user', scruncher: 'user', sizer: 'user', spinner: 'user', stainer: 'user', screener: 'user', styler: 'user' }),
  // How the Sprayer sets up new instances, per property.
  spray: Object.freeze({ scrunch: 'average', size: 'average', spin: 'average', screen: 'average', stain: 'average', style: 'average' }),
});

/** The shared options (stored in preferences). */
export function symbolismOptions(app) {
  const saved = app?.prefs?.get('symbolismOptions');
  const o = saved && typeof saved === 'object' ? saved : {};
  return { ...DEFAULT_OPTIONS, ...o, methods: { ...DEFAULT_OPTIONS.methods, ...(o.methods || {}) }, spray: { ...DEFAULT_OPTIONS.spray, ...(o.spray || {}) } };
}

export function setSymbolismOptions(app, patch) {
  const next = { ...symbolismOptions(app), ...patch };
  app.prefs?.set('symbolismOptions', next);
  app.editor?.emit('overlay');
  return next;
}

/** Brush weight at distance d from the center of a brush of radius r: 1 in the middle, 0 at the edge. */
export function falloff(d, r) {
  if (!(r > 0) || d >= r) return 0;
  const t = d / r;
  return (1 - t * t) ** 2;
}

function center(doc, n) {
  const b = nodeBounds(doc, n);
  return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: n.transform[4], y: n.transform[5] };
}

/** Uniform scale of an instance's matrix. */
function instScale(n) {
  const m = n.transform || IDENTITY;
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/** Direction of an instance's x axis in degrees. */
function instAngle(n) {
  const m = n.transform || IDENTITY;
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

const normDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

const TOOL_KEYS = ['sprayer', 'shifter', 'scruncher', 'sizer', 'spinner', 'stainer', 'screener', 'styler'];

export class SymbolismTool extends Tool {
  static id = 'symbol-tool';
  static label = 'Symbolism Tool';
  static key = 'sprayer';
  static verb = 'Symbolism';

  constructor(app) {
    super(app);
    this.pos = null;
    this.stroke = null;
    this.timer = 0;
  }

  get options() {
    return symbolismOptions(this.app);
  }

  activate() {
    this.setCursor('crosshair');
    this.status();
  }

  deactivate() {
    this.commit();
    this.pos = null;
    this.overlay();
  }

  /** Instances the tool works on: those in selected symbol sets, plus selected instances. */
  targets() {
    const ed = this.editor;
    const doc = ed.doc;
    const out = [];
    for (const id of ed.topSelection()) {
      const n = doc.get(id);
      if (isSymbolSet(n)) {
        for (const c of n.children) {
          const cn = doc.get(c);
          if (isInstance(cn) && !cn.locked && !cn.hidden) out.push(cn);
        }
      } else if (isInstance(n) && !n.locked) out.push(n);
    }
    return out;
  }

  /** Instances under the brush at (x, y) with their weights. */
  underBrush(x, y) {
    const r = this.options.diameter / 2;
    const doc = this.editor.doc;
    const out = [];
    for (const n of this.targets()) {
      const c = center(doc, n);
      const w = falloff(Math.hypot(c.x - x, c.y - y), r);
      if (w > 0) out.push({ node: n, c, w });
    }
    return out;
  }

  onHover(e) {
    this.pos = { x: e.x, y: e.y };
    this.overlay();
  }

  onLeave() {
    if (this.stroke || !this.pos) return;
    this.pos = null;
    this.overlay();
  }

  onPointerDown(e) {
    const ed = this.editor;
    if (!ed || ed.doc.tx) return;
    this.pos = { x: e.x, y: e.y };
    if (!this.canStart(e)) return;
    this.stroke = { tx: ed.doc.begin(this.constructor.verb), last: { x: e.x, y: e.y }, dir: null, alt: e.alt, shift: e.shift, time: performance.now(), carry: 0 };
    this.begin?.(e);
    this.step(e, 1 / 30);
    this.timer = setInterval(() => {
      if (!this.stroke) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.stroke.time) / 1000);
      this.stroke.time = now;
      this.step({ ...this.stroke.last, alt: this.stroke.alt, shift: this.stroke.shift }, dt);
    }, 40);
  }

  onPointerMove(e) {
    this.pos = { x: e.x, y: e.y };
    const s = this.stroke;
    if (!s) {
      this.overlay();
      return;
    }
    const dx = e.x - s.last.x;
    const dy = e.y - s.last.y;
    if (Math.hypot(dx, dy) > 1e-9) s.dir = { x: dx, y: dy };
    s.alt = e.alt;
    s.shift = e.shift;
    this.move?.(e, dx, dy);
    s.last = { x: e.x, y: e.y };
    const now = performance.now();
    const dt = Math.min(0.1, (now - s.time) / 1000);
    s.time = now;
    this.step(e, dt);
  }

  onPointerUp() {
    this.commit();
  }

  /** Apply the effect for `dt` seconds of brushing at e (inside the stroke's transaction). */
  step(e, dt) {
    const rate = (this.options.intensity / 10) * dt * 3;
    this.apply(e, rate);
    this.overlay();
  }

  canStart() {
    if (!this.targets().length) {
      this.app.notify('Select a symbol set or symbol instances first.', { polite: true });
      this.status('Select a symbol set or symbol instances to work on.');
      return false;
    }
    return true;
  }

  apply() {}

  commit() {
    clearInterval(this.timer);
    this.timer = 0;
    const s = this.stroke;
    this.stroke = null;
    if (s && this.editor?.doc.tx === s.tx) s.tx.commit();
  }

  cancel() {
    clearInterval(this.timer);
    this.timer = 0;
    const s = this.stroke;
    this.stroke = null;
    if (s && this.editor?.doc.tx === s.tx) s.tx.cancel();
    this.overlay();
  }

  onKeyDown(e) {
    if (e.key === '[' || e.key === ']') {
      const d = this.options.diameter;
      const stepBy = d < 20 ? 2 : d < 100 ? 6 : 12;
      setSymbolismOptions(this.app, { diameter: Math.max(2, Math.min(2000, d + (e.key === ']' ? stepBy : -stepBy))) });
      this.status(`Diameter: ${formatLength(this.options.diameter, this.editor?.doc.root.units || 'pt')}`);
      return true;
    }
    if (e.key === 'Escape' && this.stroke) {
      this.cancel();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, editor) {
    if (!this.pos || !this.options.showBrush) return;
    const s = editor.view.toScreen(this.pos.x, this.pos.y);
    const r = (this.options.diameter / 2) * editor.view.zoom;
    ctx.save();
    // Two strokes so the circle reads on light and dark artwork; the inner ring shows the intensity.
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(30,30,30,0.85)';
    ctx.stroke();
    const k = this.options.intensity / 10;
    ctx.lineWidth = 1 + 3 * k;
    ctx.strokeStyle = `rgba(80,120,255,${0.25 + 0.5 * k})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(1, r - 3 - ctx.lineWidth / 2), -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
    ctx.stroke();
    ctx.restore();
  }

  openOptions() {
    return symbolismOptionsDialog(this.app, this.constructor.key);
  }

  /** The method this tool uses (Average, User Defined, Random). */
  get method() {
    return this.options.methods[this.constructor.key] || 'user';
  }

  /** Values of instances under the brush, for the Average method. */
  average(list, fn) {
    if (!list.length) return null;
    let s = 0;
    let w = 0;
    for (const it of list) {
      s += fn(it.node) * it.w;
      w += it.w;
    }
    return w ? s / w : null;
  }
}

// ---- the eight tools ----

export class SymbolSprayerTool extends SymbolismTool {
  static id = 'symbol-sprayer';
  static label = 'Symbol Sprayer Tool';
  static shortcut = 'Shift+S';
  static icon = 'tool-symbol-sprayer';
  static key = 'sprayer';
  static verb = 'Spray Symbols';
  static hint = 'Drag to spray the current symbol | Alt+Drag to remove instances | [ ] change the brush size';

  /** The symbol to spray: the panel's current one, else the most common one in the selected set. */
  symbol() {
    const ed = this.editor;
    const cur = currentSymbol(ed);
    if (cur) return cur;
    const count = new Map();
    for (const n of this.targets()) count.set(n.symbol, (count.get(n.symbol) || 0) + 1);
    let best = null;
    for (const [id, c] of count) if (!best || c > count.get(best)) best = id;
    return best && getDef(ed.doc, best) ? best : null;
  }

  canStart(e) {
    if (e.alt) return this.targets().length > 0;
    if (!this.symbol()) {
      this.app.notify('Choose a symbol in the Symbols panel to spray.', { polite: true });
      return false;
    }
    const layer = this.editor.targetLayer();
    if (!layer || this.editor.doc.isLocked(layer.id) || this.editor.doc.isHidden(layer.id)) {
      this.app.notify('Unlock or show the layer to spray symbols.', { error: true });
      return false;
    }
    const ed = this.editor;
    const set = ed.topSelection().map((id) => ed.doc.get(id)).find(isSymbolSet);
    if (wouldNestItself(ed.doc, this.symbol(), set ? set.id : ed.drawTarget().parentId)) {
      this.app.notify('A symbol cannot be placed inside itself.', { error: true });
      return false;
    }
    return true;
  }

  begin() {
    const ed = this.editor;
    const sel = ed.topSelection().map((id) => ed.doc.get(id)).find(isSymbolSet);
    this.stroke.set = sel ? sel.id : null;
  }

  /** The set new instances go into, created on the first one. */
  ensureSet() {
    const ed = this.editor;
    const doc = ed.doc;
    if (this.stroke.set && doc.has(this.stroke.set)) return this.stroke.set;
    const t = ed.drawTarget();
    const set = doc.insert(createSymbolSet([]), t.parentId, t.index);
    this.stroke.set = set.id;
    ed.select([set.id]);
    return set.id;
  }

  apply(e, rate) {
    const ed = this.editor;
    const doc = ed.doc;
    const r = this.options.diameter / 2;
    if (e.alt) {
      // Remove instances near the middle of the brush, a few per second.
      const s = this.stroke;
      s.carry += rate * 4;
      while (s.carry >= 1) {
        s.carry -= 1;
        const list = this.underBrush(e.x, e.y).sort((a, b) => b.w - a.w);
        if (!list.length) break;
        doc.remove(list[0].node.id);
      }
      return;
    }
    const symbolId = this.symbol();
    const def = getDef(doc, symbolId);
    if (!def) return;
    const b = masterBounds(doc, def);
    const size = b ? Math.max(b.w, b.h, 1) : 20;
    const near = this.underBrush(e.x, e.y);
    const avgScale = this.average(near, instScale) ?? 1;
    // Spacing between instances shrinks as Density goes up.
    const spacing = size * avgScale * (1.6 - this.options.density * 0.12);
    const s = this.stroke;
    s.carry += rate * 10;
    let budget = Math.floor(s.carry);
    s.carry -= budget;
    const setId = this.ensureSet();
    const existing = doc.get(setId).children.map((c) => doc.get(c)).filter(isInstance).map((n) => center(doc, n));
    while (budget-- > 0) {
      let spot = null;
      for (let tries = 0; tries < 10 && !spot; tries++) {
        const a = Math.random() * Math.PI * 2;
        const d = r * Math.sqrt(Math.random());
        const p = { x: e.x + Math.cos(a) * d, y: e.y + Math.sin(a) * d };
        if (existing.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= spacing)) spot = p;
      }
      if (!spot) break;
      const inst = this.newInstance(doc, def, spot, near);
      doc.insert(inst, setId);
      existing.push(spot);
    }
  }

  /** A new instance at a point, sized, turned and colored by the spray methods. */
  newInstance(doc, def, p, near) {
    const sp = this.options.spray;
    const pick = (method, avg, rand, base) => (method === 'average' && avg !== null ? avg : method === 'random' ? rand() : base);
    const s = pick(sp.size, this.average(near, instScale), () => 0.6 + Math.random() * 0.8, 1);
    const angle = pick(sp.spin, this.average(near, instAngle), () => Math.random() * 360 - 180, 0);
    const opacity = pick(sp.screen, this.average(near, (n) => n.opacity ?? 1), () => 0.4 + Math.random() * 0.6, 1);
    const b = masterBounds(doc, def);
    const c = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : def.symbolDef.reg;
    // Place the master's middle on the point, then size and turn it about that point.
    let m = multiply(placementMatrix(doc, def, p.x, p.y), translate(def.symbolDef.reg.x - c.x, def.symbolDef.reg.y - c.y));
    if (Math.abs(s - 1) > 1e-6 || Math.abs(angle) > 1e-6) m = multiply(multiply(rotate(angle, p.x, p.y), scale(s, s, p.x, p.y)), m);
    const extra = {};
    if (Math.abs(opacity - 1) > 1e-6) extra.opacity = opacity;
    const tinted = near.find((it) => it.node.tint?.amount > 0);
    if (sp.stain === 'average' && tinted) extra.tint = { ...tinted.node.tint };
    const styled = near.find((it) => it.node.style);
    if (sp.style === 'average' && styled) {
      extra.style = styled.node.style;
      if (styled.node.effects?.length) extra.effects = structuredClone(styled.node.effects);
    }
    return createInstance(def.id, m, extra);
  }
}

export class SymbolShifterTool extends SymbolismTool {
  static id = 'symbol-shifter';
  static label = 'Symbol Shifter Tool';
  static icon = 'tool-symbol-shifter';
  static key = 'shifter';
  static verb = 'Shift Symbols';
  static hint = 'Drag to push instances along | Shift+Click brings an instance forward, Alt+Shift+Click sends it back';

  begin(e) {
    if (!e.shift) return;
    // Shift-click restacks the instance under the pointer within its set.
    const doc = this.editor.doc;
    const hit = this.underBrush(e.x, e.y).sort((a, b) => b.w - a.w)[0];
    if (!hit) return;
    const parent = doc.get(hit.node.parent);
    const i = parent.children.indexOf(hit.node.id);
    doc.move(hit.node.id, parent.id, e.alt ? Math.max(0, i - 1) : i + 2);
    this.stroke.restacked = true;
  }

  move(e, dx, dy) {
    if (this.stroke.restacked) return;
    const doc = this.editor.doc;
    const k = Math.min(1, this.options.intensity / 8);
    for (const it of this.underBrush(e.x - dx, e.y - dy)) {
      const f = it.w * k;
      doc.update(it.node.id, { transform: multiply(translate(dx * f, dy * f), it.node.transform) });
    }
  }
}

export class SymbolScruncherTool extends SymbolismTool {
  static id = 'symbol-scruncher';
  static label = 'Symbol Scruncher Tool';
  static icon = 'tool-symbol-scruncher';
  static key = 'scruncher';
  static verb = 'Scrunch Symbols';
  static hint = 'Hold or drag to pull instances together | Alt to push them apart';

  apply(e, rate) {
    const doc = this.editor.doc;
    for (const it of this.underBrush(e.x, e.y)) {
      let f = Math.min(0.5, rate * it.w);
      if (e.alt) f = -f;
      if (this.method === 'random') f *= 0.5 + Math.random();
      const dx = (e.x - it.c.x) * f;
      const dy = (e.y - it.c.y) * f;
      doc.update(it.node.id, { transform: multiply(translate(dx, dy), it.node.transform) });
    }
  }
}

export class SymbolSizerTool extends SymbolismTool {
  static id = 'symbol-sizer';
  static label = 'Symbol Sizer Tool';
  static icon = 'tool-symbol-sizer';
  static key = 'sizer';
  static verb = 'Size Symbols';
  static hint = 'Hold or drag to enlarge instances | Alt to shrink them';

  apply(e, rate) {
    const doc = this.editor.doc;
    const list = this.underBrush(e.x, e.y);
    const avg = this.method === 'average' ? this.average(list, instScale) : null;
    for (const it of list) {
      let f;
      if (avg !== null) {
        // Average: sizes even out toward the brush's average.
        const cur = instScale(it.node);
        f = 1 + ((avg - cur) / cur) * Math.min(1, rate * it.w * 2);
      } else {
        const g = rate * it.w * (this.method === 'random' ? Math.random() * 2 : 1);
        f = e.alt ? 1 / (1 + g) : 1 + g;
      }
      if (!(f > 0) || Math.abs(f - 1) < 1e-6) continue;
      if (instScale(it.node) * f < 0.02) continue;
      doc.update(it.node.id, { transform: multiply(scale(f, f, it.c.x, it.c.y), it.node.transform) });
    }
  }
}

export class SymbolSpinnerTool extends SymbolismTool {
  static id = 'symbol-spinner';
  static label = 'Symbol Spinner Tool';
  static icon = 'tool-symbol-spinner';
  static key = 'spinner';
  static verb = 'Spin Symbols';
  static hint = 'Drag to turn instances toward the drag direction';

  apply(e, rate) {
    const doc = this.editor.doc;
    const list = this.underBrush(e.x, e.y);
    let target = null;
    if (this.method === 'average') target = this.average(list, instAngle);
    else if (this.stroke.dir) target = (Math.atan2(this.stroke.dir.y, this.stroke.dir.x) * 180) / Math.PI;
    for (const it of list) {
      let d;
      if (this.method === 'random') d = (Math.random() - 0.5) * 60 * rate * it.w;
      else if (target === null) continue;
      else d = normDeg(target - instAngle(it.node)) * Math.min(1, rate * it.w * 2);
      if (Math.abs(d) < 1e-6) continue;
      doc.update(it.node.id, { transform: multiply(rotate(d, it.c.x, it.c.y), it.node.transform) });
    }
  }
}

export class SymbolStainerTool extends SymbolismTool {
  static id = 'symbol-stainer';
  static label = 'Symbol Stainer Tool';
  static icon = 'tool-symbol-stainer';
  static key = 'stainer';
  static verb = 'Stain Symbols';
  static hint = 'Hold or drag to tint instances with the fill color | Alt to remove the tint';

  apply(e, rate) {
    const doc = this.editor.doc;
    const fill = this.editor.style.fill;
    const color = fill?.type === 'solid' ? fill.color : fill?.stops?.[0]?.color || '#000000';
    for (const it of this.underBrush(e.x, e.y)) {
      const t = it.node.tint || { color, amount: 0 };
      let g = Math.min(1, rate * it.w);
      if (this.method === 'random') g *= Math.random() * 2;
      if (e.alt) {
        const amount = Math.max(0, t.amount - g);
        doc.update(it.node.id, { tint: amount > 0.001 ? { ...t, amount } : undefined });
        continue;
      }
      const amount = Math.min(1, t.amount + g);
      // A different tint color blends in proportionally to what is added.
      const c = t.amount > 0 && t.color.toLowerCase() !== color.toLowerCase() ? mix(t.color, color, g / amount) : color;
      doc.update(it.node.id, { tint: { color: c, amount } });
    }
  }
}

export class SymbolScreenerTool extends SymbolismTool {
  static id = 'symbol-screener';
  static label = 'Symbol Screener Tool';
  static icon = 'tool-symbol-screener';
  static key = 'screener';
  static verb = 'Screen Symbols';
  static hint = 'Hold or drag to make instances more transparent | Alt to make them opaque again';

  apply(e, rate) {
    const doc = this.editor.doc;
    const list = this.underBrush(e.x, e.y);
    const avg = this.method === 'average' ? this.average(list, (n) => n.opacity ?? 1) : null;
    for (const it of list) {
      const cur = it.node.opacity ?? 1;
      let g = Math.min(1, rate * it.w) * 0.6;
      if (this.method === 'random') g *= Math.random() * 2;
      let next;
      if (avg !== null && !e.alt) next = cur + (avg - cur) * Math.min(1, g * 3) - g * 0.25;
      else next = e.alt ? cur + g : cur - g;
      next = Math.max(0.05, Math.min(1, next));
      if (Math.abs(next - cur) > 1e-6) doc.update(it.node.id, { opacity: next });
    }
  }
}

/** Paint fields of a graphic style that go onto every part of an instance. */
function partStyle(style) {
  const out = {};
  for (const k of STYLE_KEYS) if (style[k] !== undefined && k !== 'effects' && k !== 'opacity' && k !== 'blendMode') out[k] = style[k];
  return out;
}

export class SymbolStylerTool extends SymbolismTool {
  static id = 'symbol-styler';
  static label = 'Symbol Styler Tool';
  static icon = 'tool-symbol-styler';
  static key = 'styler';
  static verb = 'Style Symbols';
  static hint = 'Hold or drag to apply the selected graphic style | Alt to remove it';

  /** The graphic style chosen in the Graphic Styles panel, else the current fill and stroke. */
  style() {
    const panel = this.app.dock?.panels?.get('graphicStyles');
    const doc = this.editor.doc;
    const gs = panel?.selected ? graphicStylesOf(doc).find((s) => s.id === panel.selected) : null;
    if (gs) return gs.style;
    const st = this.editor.style;
    return { fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth };
  }

  apply(e, rate) {
    const doc = this.editor.doc;
    const style = this.style();
    const paint = partStyle(style);
    for (const it of this.underBrush(e.x, e.y)) {
      // Instances take the style one by one, the ones in the middle first.
      const chance = Math.min(1, rate * it.w * 3);
      if (Math.random() >= chance && it.w < 0.95) continue;
      if (e.alt) {
        if (it.node.style) doc.update(it.node.id, { style: undefined, effects: [] });
        continue;
      }
      doc.update(it.node.id, { style: paint, effects: structuredClone(style.effects || []) });
    }
  }
}

export const SYMBOLISM_TOOLS = [SymbolSprayerTool, SymbolShifterTool, SymbolScruncherTool, SymbolSizerTool, SymbolSpinnerTool, SymbolStainerTool, SymbolScreenerTool, SymbolStylerTool];

// ---- options dialog ----

const SPRAY_LABELS = { scrunch: 'Scrunch', size: 'Size', spin: 'Spin', screen: 'Screen', stain: 'Stain', style: 'Style' };

/** Symbolism Tools Options: shared brush settings and each tool's method. */
export async function symbolismOptionsDialog(app, startKey = 'sprayer') {
  const o = symbolismOptions(app);
  const unit = app.editor?.doc.root.units || 'pt';
  let key = startKey;
  const methods = { ...o.methods };
  const spray = { ...o.spray };
  const diameter = h('input', { type: 'text', id: 'symt-diameter', value: formatLength(o.diameter, unit), inputmode: 'decimal', spellcheck: false, autocomplete: 'off' });
  const intensity = h('input', { type: 'range', id: 'symt-intensity', min: 1, max: 10, step: 1, value: o.intensity });
  const intensityOut = h('output.range-out', { for: 'symt-intensity' }, String(o.intensity));
  intensity.addEventListener('input', () => (intensityOut.textContent = intensity.value));
  const density = h('input', { type: 'range', id: 'symt-density', min: 1, max: 10, step: 1, value: o.density });
  const densityOut = h('output.range-out', { for: 'symt-density' }, String(o.density));
  density.addEventListener('input', () => (densityOut.textContent = density.value));
  const showBrush = h('input', { type: 'checkbox', id: 'symt-brush', checked: o.showBrush });
  const methodSel = (value, onChange, id) => {
    const s = h('select', { id }, METHODS.map((m) => h('option', { value: m.value, selected: m.value === value }, m.label)));
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };
  const toolBar = h('div.symt-tools', { role: 'tablist', 'aria-label': 'Tool' });
  const toolPanel = h('div.symt-tool-panel', { role: 'tabpanel', id: 'symt-tool-panel' });
  const renderTool = () => {
    toolBar.replaceChildren(
      ...SYMBOLISM_TOOLS.map((T) =>
        h('button.icon-btn.symt-tool', {
          type: 'button',
          role: 'tab',
          'aria-selected': String(T.key === key),
          'aria-controls': 'symt-tool-panel',
          'aria-label': T.label.replace(' Tool', ''),
          'data-tip': T.label.replace(' Tool', ''),
          tabindex: T.key === key ? '0' : '-1',
          onclick: () => {
            key = T.key;
            renderTool();
            toolBar.querySelector('[aria-selected="true"]')?.focus();
          },
          onkeydown: (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const i = TOOL_KEYS.indexOf(key);
            key = TOOL_KEYS[(i + (e.key === 'ArrowRight' ? 1 : TOOL_KEYS.length - 1)) % TOOL_KEYS.length];
            renderTool();
            toolBar.querySelector('[aria-selected="true"]')?.focus();
          },
        }, icon(T.icon, 18)),
      ),
    );
    if (key === 'sprayer') {
      toolPanel.replaceChildren(
        h('p.symt-note', 'How new instances are set up:'),
        h(
          'div.symt-spray',
          ...Object.entries(SPRAY_LABELS).map(([k, label]) => h('div.form-row', h('label', { for: `symt-spray-${k}` }, label), methodSel(spray[k], (v) => (spray[k] = v), `symt-spray-${k}`))),
        ),
      );
    } else {
      toolPanel.replaceChildren(h('div.form-row', h('label', { for: 'symt-method' }, 'Method'), methodSel(methods[key], (v) => (methods[key] = v), 'symt-method')));
    }
  };
  renderTool();
  const error = h('p.form-error', { role: 'alert' });
  const body = h(
    'div.form.symt-options',
    h('div.form-row', h('label', { for: 'symt-diameter' }, 'Diameter'), diameter),
    h('div.form-row', h('label', { for: 'symt-intensity' }, 'Intensity'), h('div.range-wrap', intensity, intensityOut)),
    h('div.form-row', h('label', { for: 'symt-density' }, 'Symbol set density'), h('div.range-wrap', density, densityOut)),
    toolBar,
    toolPanel,
    h('div.form-row.check', showBrush, h('label', { for: 'symt-brush' }, 'Show brush size and intensity')),
    error,
  );
  const res = await openDialog({
    title: 'Symbolism Tools Options',
    body,
    className: 'symbolism-options',
    initialFocus: () => diameter,
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        validate: () => {
          const d = parseLength(diameter.value, unit);
          if (!Number.isFinite(d) || d <= 0) {
            error.textContent = 'Enter a diameter greater than zero.';
            diameter.focus();
            return false;
          }
          return true;
        },
        value: () => ({ diameter: parseLength(diameter.value, unit), intensity: Number(intensity.value), density: Number(density.value), showBrush: showBrush.checked, methods, spray }),
      },
    ],
  });
  if (!res) return null;
  return setSymbolismOptions(app, res);
}
