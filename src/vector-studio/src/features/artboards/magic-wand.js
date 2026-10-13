/**
 * Magic Wand tool (Y): click an object to select every object with a
 * similar fill color (within a tolerance), and optionally similar stroke
 * color, stroke weight, opacity and blending mode. Shift-click adds,
 * Option-click subtracts. Double-click the tool for its options.
 */
import { h } from '../../lib/dom.js';
import { Tool, tol } from '../../tools/tool.js';
import { hitTest } from '../../render/hit.js';
import { hexToRgb } from '../../lib/color.js';
import { BLEND_LABELS } from '../../ui/panels/properties.js';

export const DEFAULT_WAND = Object.freeze({
  fill: { on: true, tol: 32 },
  stroke: { on: false, tol: 32 },
  strokeWeight: { on: false, tol: 5 },
  opacity: { on: false, tol: 5 },
  blendMode: { on: false },
  allLayers: { on: true },
});

export function wandOptions(app) {
  const saved = app.prefs.get('magicWand') || {};
  const out = {};
  for (const k of Object.keys(DEFAULT_WAND)) out[k] = { ...DEFAULT_WAND[k], ...(saved[k] || {}) };
  return out;
}

/** Representative RGB of a paint (solid color, or the mean of gradient stops), or null for None. */
export function paintRgb(p) {
  if (!p) return null;
  if (p.type === 'solid') return hexToRgb(p.color);
  if (p.stops?.length) {
    const cs = p.stops.map((s) => hexToRgb(s.color));
    const n = cs.length;
    return { r: cs.reduce((s, c) => s + c.r, 0) / n, g: cs.reduce((s, c) => s + c.g, 0) / n, b: cs.reduce((s, c) => s + c.b, 0) / n };
  }
  return null;
}

/** Colors match when every RGB channel differs by at most `tolerance` (0-255). None only matches None. */
export function colorsMatch(a, b, tolerance) {
  const ca = paintRgb(a);
  const cb = paintRgb(b);
  if (!ca || !cb) return !ca && !cb;
  return Math.abs(ca.r - cb.r) <= tolerance && Math.abs(ca.g - cb.g) <= tolerance && Math.abs(ca.b - cb.b) <= tolerance;
}

/** Does `node` match the reference object under the wand options? */
export function wandMatches(ref, node, opts) {
  if (opts.fill.on && !colorsMatch(ref.fill, node.fill, opts.fill.tol)) return false;
  if (opts.stroke.on && !colorsMatch(ref.stroke, node.stroke, opts.stroke.tol)) return false;
  if (opts.strokeWeight.on && Math.abs((ref.stroke ? ref.strokeWidth : 0) - (node.stroke ? node.strokeWidth : 0)) > opts.strokeWeight.tol) return false;
  if (opts.opacity.on && Math.abs((ref.opacity ?? 1) - (node.opacity ?? 1)) * 100 > opts.opacity.tol) return false;
  if (opts.blendMode.on && (ref.blendMode || 'normal') !== (node.blendMode || 'normal')) return false;
  return true;
}

/** Visible, unlocked paintable objects (compound paths as a whole). */
export function wandCandidates(doc) {
  const out = [];
  doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if (n.type === 'compound') {
      out.push(n);
      return false;
    }
    if (n.type === 'path' || n.type === 'text') out.push(n);
    return true;
  });
  return out;
}

/** Ids of every object matching `ref` (on its layer only when Use All Layers is off). */
export function magicWandSelect(doc, ref, opts) {
  const layer = opts.allLayers?.on === false ? doc.layerOf(ref.id)?.id : null;
  return wandCandidates(doc)
    .filter((n) => wandMatches(ref, n, opts) && (!layer || doc.layerOf(n.id)?.id === layer))
    .map((n) => n.id);
}

export class MagicWandTool extends Tool {
  static id = 'magic-wand';
  static label = 'Magic Wand Tool';
  static shortcut = 'Y';
  static icon = 'tool-magic-wand';
  static hint = 'Click to select objects with similar attributes | Shift+Click to add | Option+Click to subtract | Double-click the tool for options';

  activate() {
    this.setCursor('crosshair');
    this.status();
  }

  hitAt(e) {
    const ed = this.editor;
    return hitTest(ed.doc, e.x, e.y, tol(ed, 3), { outline: ed.viewOptions.mode === 'outline' });
  }

  onPointerDown(e) {
    const ed = this.editor;
    let hit = this.hitAt(e);
    if (hit?.type === 'path' && ed.doc.get(hit.parent)?.type === 'compound') hit = ed.doc.get(hit.parent);
    if (!hit || hit.type === 'image') {
      if (!e.shift && !e.alt) ed.clearSelection();
      return;
    }
    const ids = magicWandSelect(ed.doc, hit, wandOptions(this.app));
    if (e.alt) {
      const drop = new Set(ids);
      ed.select([...ed.selection].filter((id) => !drop.has(id)));
    } else ed.select(ids, { add: e.shift });
  }

  openOptions() {
    // The Magic Wand panel holds the options when it is installed.
    if (this.app.dock?.panels.has('magicWand')) this.app.openPanel('magicWand');
    else openWandOptions(this.app);
  }
}

export async function openWandOptions(app) {
  const o = wandOptions(app);
  const unit = app.editor?.doc.root.units || 'pt';
  const rows = [
    ['fill', 'Fill Color', 'Tolerance', 0, 255],
    ['stroke', 'Stroke Color', 'Tolerance', 0, 255],
    ['strokeWeight', 'Stroke Weight', `Tolerance (${unit === 'px' ? 'px' : 'pt'})`, 0, 1000],
    ['opacity', 'Opacity', 'Tolerance (%)', 0, 100],
  ];
  const inputs = {};
  const body = h(
    'div.form.wand-options',
    rows.map(([key, label, tolLabel, min, max]) => {
      const cid = `wand-${key}`;
      const tid = `wand-${key}-tol`;
      const chk = h('input', { type: 'checkbox', id: cid, checked: o[key].on });
      const num = h('input', { type: 'number', id: tid, min, max, step: 1, value: o[key].tol, disabled: !o[key].on });
      chk.addEventListener('change', () => (num.disabled = !chk.checked));
      inputs[key] = { chk, num };
      return h('div.wand-row', h('div.check-row', chk, h('label', { for: cid }, label)), h('div.wand-tol', h('label', { for: tid }, tolLabel), num));
    }),
    (() => {
      const chk = h('input', { type: 'checkbox', id: 'wand-blend', checked: o.blendMode.on });
      inputs.blendMode = { chk };
      return h('div.wand-row', h('div.check-row', chk, h('label', { for: 'wand-blend' }, 'Blending Mode')), h('p.form-help', `Matches the same mode (${BLEND_LABELS.multiply}, ${BLEND_LABELS.screen}, ...).`));
    })(),
  );
  const ok = await app.dialogs.open({ title: 'Magic Wand', body, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: true }] });
  if (!ok) return;
  const out = {};
  for (const [key, r] of Object.entries(inputs)) {
    out[key] = { on: r.chk.checked };
    if (r.num) {
      const v = Number(r.num.value);
      out[key].tol = Number.isFinite(v) ? Math.max(Number(r.num.min), Math.min(Number(r.num.max), v)) : DEFAULT_WAND[key].tol;
    }
  }
  app.prefs.set('magicWand', out);
}
