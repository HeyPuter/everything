/**
 * Flare tool: drag to place a lens flare (the press is its center, the drag
 * sets its size), then click or drag again to place the end of its rings.
 * Click without dragging to type its options. With a flare selected, drag
 * its center or end handle with the tool; double-click a flare (Selection
 * tool) or the tool to edit its options.
 */
import { registerLive, virtualId } from '../../model/live.js';
import { DEFAULT_STYLE } from '../../model/nodes.js';
import { Tool, fmt } from '../../tools/tool.js';
import { overlayHooks, layerColor } from '../../render/overlay.js';
import { selectionDoubleClickHooks } from '../../tools/selection.js';
import { paintHooks } from '../../ops/paint-ops.js';
import { registerIcons } from '../../ui/icons.js';
import { isFlare, createFlare, flareParts, flareOptions, transformFlare, endFromOptions, FLARE_DEFAULTS } from './flare-model.js';

const C = (cx, cy, r, extra = {}) => ['circle', { cx: String(cx), cy: String(cy), r: String(r), ...extra }];
registerIcons({
  'tool-flare': [C(12, 12, 3), C(12, 12, 6.5, { 'stroke-dasharray': '1.5 2' }), ['path', { d: 'M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2 2M17.4 17.4l2 2M4.6 19.4l2-2M17.4 6.6l2-2' }], C(19, 19, 1.2), C(21, 21, 0.6)],
});

registerLive('flare', {
  label: '<Flare>',
  test: isFlare,
  generate(doc, node) {
    const extra = new Map();
    const items = [];
    for (const p of flareParts(node)) {
      const id = virtualId(node.id);
      extra.set(id, { id, type: 'path', name: '', anchors: p.anchors, closed: p.closed, hidden: false, locked: false, ...DEFAULT_STYLE, fill: p.fill, stroke: null, strokeWidth: 0 });
      items.push(id);
    }
    return { items, extra };
  },
  transformParams: (node, m) => transformFlare(node, m),
});

const HANDLE = 6;

function selectedFlares(editor) {
  return editor ? editor.selectedNodes().filter((n) => isFlare(n) && !editor.doc.isLocked(n.id)) : [];
}

/** The remembered options for new flares. */
function newFlareOptions(app) {
  return flareOptions(app.prefs.get('flareOptions') || {});
}

/** Flare Options: edit a flare (with preview) or the options for new flares. Returns the values or null. */
export async function flareOptionsDialog(app, { flare = null, title = 'Flare Tool Options' } = {}) {
  const ed = app.editor;
  const o = flare ? flareOptions(flare) : newFlareOptions(app);
  const doc = ed?.doc;
  let tx = null;
  const toOpts = (v) => ({
    center: { diameter: v.diameter, opacity: v.opacity, brightness: v.brightness },
    halo: { growth: v.growth, fuzziness: v.haloFuzz },
    rays: { on: v.raysOn, number: Math.round(v.rays), longest: v.longest, fuzziness: v.rayFuzz },
    rings: { on: v.ringsOn, path: v.path, number: Math.round(v.rings), largest: v.largest, direction: v.direction },
  });
  const patchFor = (v) => {
    const opts = toOpts(v);
    // Path and direction place the end point from the center.
    return { ...opts, ...endFromOptions(flare.cx, flare.cy, opts.rings) };
  };
  const pathNow = flare ? Math.hypot(flare.ex - flare.cx, flare.ey - flare.cy) : o.rings.path;
  const dirNow = flare ? (Math.atan2(-(flare.ey - flare.cy), flare.ex - flare.cx) * 180) / Math.PI : o.rings.direction;
  const fields = [
    { type: 'heading', label: 'Center' },
    { key: 'diameter', label: 'Diameter', type: 'length', value: o.center.diameter, min: 0, max: 10000 },
    { key: 'opacity', label: 'Opacity', type: 'percent', value: o.center.opacity, min: 0, max: 100 },
    { key: 'brightness', label: 'Brightness', type: 'percent', value: o.center.brightness, min: 0, max: 100 },
    { type: 'heading', label: 'Halo' },
    { key: 'growth', label: 'Growth', type: 'percent', value: o.halo.growth, min: 0, max: 300 },
    { key: 'haloFuzz', label: 'Fuzziness', type: 'percent', value: o.halo.fuzziness, min: 0, max: 100 },
    { type: 'heading', label: 'Rays' },
    { key: 'raysOn', label: 'Draw rays', type: 'checkbox', value: o.rays.on },
    { key: 'rays', label: 'Number', type: 'number', value: o.rays.number, min: 0, max: 50 },
    { key: 'longest', label: 'Longest', type: 'percent', value: o.rays.longest, min: 0, max: 1000 },
    { key: 'rayFuzz', label: 'Fuzziness', type: 'percent', value: o.rays.fuzziness, min: 0, max: 100 },
    { type: 'heading', label: 'Rings' },
    { key: 'ringsOn', label: 'Draw rings', type: 'checkbox', value: o.rings.on },
    { key: 'path', label: 'Path length', type: 'length', value: Math.round(pathNow * 100) / 100, min: 0, max: 10000 },
    { key: 'rings', label: 'Number', type: 'number', value: o.rings.number, min: 0, max: 50 },
    { key: 'largest', label: 'Largest', type: 'percent', value: o.rings.largest, min: 0, max: 250 },
    { key: 'direction', label: 'Direction', type: 'angle', value: Math.round(dirNow * 100) / 100, min: -360, max: 360 },
    ...(flare ? [{ key: 'preview', label: 'Preview', type: 'checkbox', value: true }] : []),
  ];
  let v;
  try {
    v = await app.dialogs.form({
      title,
      fields,
      previewToggle: Boolean(flare),
      onChange: flare
        ? (vals) => {
            if (tx) tx.cancel();
            tx = null;
            if (!vals.preview) return;
            tx = doc.begin('Flare Options');
            doc.update(flare.id, patchFor(vals));
          }
        : undefined,
    });
  } finally {
    if (tx) tx.cancel();
    tx = null;
  }
  if (!v) return null;
  const opts = toOpts(v);
  app.prefs.set('flareOptions', { ...opts, color: o.color });
  if (flare) doc.transact('Flare Options', () => doc.update(flare.id, patchFor(v)));
  return opts;
}

export class FlareTool extends Tool {
  static id = 'flare';
  static label = 'Flare Tool';
  static shortcut = '';
  static icon = 'tool-flare';
  static hint = 'Drag to place a flare, then click to place its rings | Click to enter options | Drag a selected flare’s handles to edit it | Shift constrains the angle';

  constructor(app) {
    super(app);
    this.drag = null;
    this.pending = null;
  }

  activate() {
    this.setCursor('crosshair');
    this.status();
  }

  deactivate() {
    this.cancel();
    this.pending = null;
  }

  #handleAt(e) {
    const view = this.editor.view;
    for (const f of selectedFlares(this.editor)) {
      for (const [part, x, y] of [['end', f.ex, f.ey], ['center', f.cx, f.cy]]) {
        const s = view.toScreen(x, y);
        if (Math.hypot(s.x - e.sx, s.y - e.sy) <= HANDLE) return { flare: f, part };
      }
    }
    return null;
  }

  onHover(e) {
    this.setCursor(this.#handleAt(e) ? 'move' : 'crosshair');
  }

  onPointerDown(e) {
    const editor = this.editor;
    const doc = editor.doc;
    const handle = this.#handleAt(e);
    if (handle) {
      this.drag = { kind: handle.part, flare: handle.flare, x0: e.x, y0: e.y, tx: null };
      return;
    }
    const pending = this.pending && doc.get(this.pending);
    if (pending && editor.selection.has(pending.id)) {
      // Second gesture: place the end of the rings.
      this.drag = { kind: 'end', flare: pending, x0: e.x, y0: e.y, tx: doc.begin('Flare'), place: true };
      this.#moveEnd(e);
      return;
    }
    this.pending = null;
    if (!editor.canDrawInTarget()) {
      this.app.notify('The target layer is locked or hidden.');
      return;
    }
    this.drag = { kind: 'new', x0: e.x, y0: e.y, sx0: e.sx, sy0: e.sy, moved: false, tx: null, id: null };
  }

  #moveEnd(e) {
    const d = this.drag;
    const f = d.flare;
    let x = e.x;
    let y = e.y;
    if (e.shift) {
      const len = Math.hypot(x - f.cx, y - f.cy);
      const a = Math.round(Math.atan2(y - f.cy, x - f.cx) / (Math.PI / 4)) * (Math.PI / 4);
      x = f.cx + Math.cos(a) * len;
      y = f.cy + Math.sin(a) * len;
    }
    this.editor.doc.update(f.id, { ex: x, ey: y });
    this.editor.feedback = { sx: e.sx, sy: e.sy, text: `Path: ${fmt(this.editor, Math.hypot(x - f.cx, y - f.cy))}` };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const editor = this.editor;
    const doc = editor.doc;
    if (d.kind === 'new') {
      if (!d.moved && Math.hypot(e.sx - d.sx0, e.sy - d.sy0) < 3) return;
      d.moved = true;
      const o = newFlareOptions(this.app);
      const dist = Math.hypot(e.x - d.x0, e.y - d.y0);
      // The drag reaches the edge of the halo.
      const diameter = Math.max(1, (2 * dist) / (1 + (o.halo.growth / 100) * 4));
      if (!d.tx) {
        d.tx = doc.begin('Flare');
        const color = editor.style.fill?.type === 'solid' ? editor.style.fill.color : FLARE_DEFAULTS.color;
        const f = createFlare(d.x0, d.y0, { ...o, color, center: { ...o.center, diameter } });
        editor.insertDrawn(f);
        d.id = f.id;
        editor.select([f.id]);
      }
      const f = doc.get(d.id);
      const end = endFromOptions(d.x0, d.y0, o.rings);
      doc.update(d.id, { center: { ...f.center, diameter }, ...end });
      editor.feedback = { sx: e.sx, sy: e.sy, text: `Diameter: ${fmt(editor, diameter)}` };
      return;
    }
    if (!d.tx) d.tx = doc.begin('Edit Flare');
    if (d.kind === 'end') this.#moveEnd(e);
    else if (d.kind === 'center') {
      const dx = e.x - d.x0;
      const dy = e.y - d.y0;
      const f = d.flare;
      doc.update(f.id, { cx: f.cx + dx, cy: f.cy + dy, ex: f.ex + dx, ey: f.ey + dy });
    }
  }

  async onPointerUp() {
    const d = this.drag;
    this.drag = null;
    const editor = this.editor;
    editor.feedback = null;
    if (!d) return;
    if (d.kind === 'new' && !d.moved) {
      const opts = await flareOptionsDialog(this.app);
      if (!opts) return;
      const color = editor.style.fill?.type === 'solid' ? editor.style.fill.color : FLARE_DEFAULTS.color;
      let id;
      editor.doc.transact('Flare', () => {
        const f = createFlare(d.x0, d.y0, { ...opts, color });
        editor.insertDrawn(f);
        id = f.id;
      });
      editor.select([id]);
      return;
    }
    d.tx?.commit();
    if (d.kind === 'new') this.pending = d.id;
    else if (d.place) this.pending = null;
    this.overlay();
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape' && (this.drag || this.pending)) {
      this.cancel();
      this.pending = null;
      return true;
    }
    return false;
  }

  cancel() {
    const d = this.drag;
    this.drag = null;
    d?.tx?.cancel();
    if (this.editor) this.editor.feedback = null;
    this.overlay();
  }

  openOptions() {
    const f = selectedFlares(this.editor)[0];
    flareOptionsDialog(this.app, { flare: f || null, title: f ? 'Flare Options' : 'Flare Tool Options' });
  }
}

/** Center and end handles of selected flares, with the ring path between them. */
function drawFlareOverlay(ctx, editor) {
  if (!editor.viewOptions.edges) return;
  for (const f of selectedFlares(editor)) {
    const color = layerColor(editor, f.id);
    const c = editor.view.toScreen(f.cx, f.cy);
    const e = editor.view.toScreen(f.ex, f.ey);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(c.x - 7, c.y);
    ctx.lineTo(c.x + 7, c.y);
    ctx.moveTo(c.x, c.y - 7);
    ctx.lineTo(c.x, c.y + 7);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(e.x, e.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** Fill colors recolor selected flares; the fill swatch shows a flare's color. */
function installFlarePaint() {
  const prevApply = paintHooks.applyStyle;
  const prevCommon = paintHooks.commonStyle;
  paintHooks.applyStyle = (editor, patch, label, coalesce) => {
    if (prevApply?.(editor, patch, label, coalesce)) return true;
    const flares = selectedFlares(editor);
    const color = patch.fill?.type === 'solid' ? patch.fill.color : null;
    if (!flares.length || !color) return false;
    editor.doc.transact('Flare Color', () => flares.forEach((f) => editor.doc.update(f.id, { color })), { coalesce });
    if (flares.length < editor.topSelection().length) return false;
    editor.setStyle(patch);
    return true;
  };
  paintHooks.commonStyle = (editor, key) => {
    const v = prevCommon?.(editor, key);
    if (v !== undefined || key !== 'fill') return v;
    const flares = selectedFlares(editor);
    if (!flares.length || flares.length !== editor.selection.size) return undefined;
    const c = flareOptions(flares[0]).color;
    return flares.every((f) => flareOptions(f).color === c) ? { type: 'solid', color: c } : 'mixed';
  };
}

function editFlareOnDoubleClick(tool, target) {
  if (!isFlare(target) || tool.editor.doc.isLocked(target.id)) return false;
  flareOptionsDialog(tool.app, { flare: target, title: 'Flare Options' });
  return true;
}

export function install(app) {
  app.registerTool(FlareTool);
  installFlarePaint();
  overlayHooks.add(drawFlareOverlay);
  if (!selectionDoubleClickHooks.includes(editFlareOnDoubleClick)) selectionDoubleClickHooks.push(editFlareOnDoubleClick);
}
