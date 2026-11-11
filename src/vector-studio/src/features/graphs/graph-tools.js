/**
 * The graph tools: drag to size a graph (Shift for a square, Option from
 * the center) or click to type its size; the Graph Data window then opens
 * for the new graph. Double-clicking a tool opens Graph Type for the
 * selected graph.
 */
import { Tool, fmt } from '../../tools/tool.js';
import { buildSnapIndex, snapPoint } from '../../tools/snap.js';
import { TYPE_LABELS, graphOptions } from './graph-math.js';
import { createGraph } from './graph-ops.js';

export class GraphTool extends Tool {
  static graphType = 'column';

  constructor(app) {
    super(app);
    this.drag = null;
  }

  activate() {
    this.setCursor('crosshair');
    this.status();
  }

  deactivate() {
    this.cancel();
  }

  onPointerDown(e) {
    const editor = this.editor;
    if (!editor.canDrawInTarget()) {
      this.app.notify('The target layer is locked or hidden.');
      return;
    }
    const snap = buildSnapIndex(editor);
    const p = snapPoint(editor, e.x, e.y, snap);
    this.drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, sx0: e.sx, sy0: e.sy, snap, moved: false, shift: e.shift, alt: e.alt };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.sx - d.sx0, e.sy - d.sy0) < 3) return;
    d.moved = true;
    const p = snapPoint(this.editor, e.x, e.y, d.snap);
    this.editor.alignmentGuides = { lines: p.lines, labels: p.labels };
    Object.assign(d, { x: p.x, y: p.y, shift: e.shift, alt: e.alt });
    const b = this.box(d);
    this.editor.feedback = { sx: e.sx, sy: e.sy, text: `W: ${fmt(this.editor, b.w)}\nH: ${fmt(this.editor, b.h)}` };
    this.overlay();
  }

  box(d) {
    let w = d.x - d.x0;
    let h = d.y - d.y0;
    if (d.shift) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    if (d.alt) return { x: d.x0 - Math.abs(w), y: d.y0 - Math.abs(h), w: Math.abs(w) * 2, h: Math.abs(h) * 2 };
    return { x: Math.min(d.x0, d.x0 + w), y: Math.min(d.y0, d.y0 + h), w: Math.abs(w), h: Math.abs(h) };
  }

  async onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    const editor = this.editor;
    editor.feedback = null;
    editor.alignmentGuides = null;
    this.overlay();
    if (!d) return;
    if (d.moved) {
      const b = this.box(d);
      if (b.w < 1 || b.h < 1) return;
      this.make(b);
      return;
    }
    const last = this.app.prefs.get('lastGraphSize') || { w: 250, h: 150 };
    const v = await this.app.dialogs.form({
      title: 'Graph',
      description: 'Size of the graph area, not counting labels and legend.',
      fields: [
        { key: 'w', label: 'Width', type: 'length', value: last.w, min: 1 },
        { key: 'h', label: 'Height', type: 'length', value: last.h, min: 1 },
      ],
    });
    if (!v || !(v.w > 0) || !(v.h > 0)) return;
    this.app.prefs.set('lastGraphSize', { w: v.w, h: v.h });
    const x = e?.alt ? d.x0 - v.w / 2 : d.x0;
    const y = e?.alt ? d.y0 - v.h / 2 : d.y0;
    this.make({ x, y, w: v.w, h: v.h });
  }

  /** Create the graph and open its data. */
  make(b) {
    const editor = this.editor;
    const doc = editor.doc;
    const remembered = this.app.prefs.get('graphOptions');
    let id;
    doc.transact(`${TYPE_LABELS[this.constructor.graphType]} Graph`, () => {
      const t = editor.drawTarget();
      id = createGraph(doc, t.parentId, b, this.constructor.graphType, { options: remembered ? { ...graphOptions(remembered), series: {} } : {}, index: t.index });
    });
    editor.select([id]);
    this.app.graphData?.show(id);
  }

  onKeyDown(ev) {
    if (ev.key === 'Escape' && this.drag) {
      this.cancel();
      return true;
    }
    return false;
  }

  cancel() {
    this.drag = null;
    if (this.editor) {
      this.editor.feedback = null;
      this.editor.alignmentGuides = null;
    }
    this.overlay();
  }

  openOptions() {
    this.app.commands.run('graph.type');
  }

  drawOverlay(ctx, editor) {
    const d = this.drag;
    if (!d?.moved) return;
    const b = this.box(d);
    const a = editor.view.toScreen(b.x, b.y);
    const c = editor.view.toScreen(b.x + b.w, b.y + b.h);
    ctx.save();
    ctx.strokeStyle = '#4f80ff';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(Math.min(a.x, c.x)) + 0.5, Math.round(Math.min(a.y, c.y)) + 0.5, Math.abs(c.x - a.x), Math.abs(c.y - a.y));
    ctx.restore();
  }
}

const HINT = 'Drag to draw a graph | Shift for a square | Option from the center | Click to enter a size';

const make = (type, label, shortcut = '') =>
  class extends GraphTool {
    static id = `graph-${type}`;
    static label = label;
    static shortcut = shortcut;
    static icon = `tool-graph-${type}`;
    static hint = HINT;
    static graphType = type;
  };

export const GRAPH_TOOLS = [
  make('column', 'Column Graph Tool', 'J'),
  make('stacked-column', 'Stacked Column Graph Tool'),
  make('bar', 'Bar Graph Tool'),
  make('stacked-bar', 'Stacked Bar Graph Tool'),
  make('line', 'Line Graph Tool'),
  make('area', 'Area Graph Tool'),
  make('scatter', 'Scatter Graph Tool'),
  make('pie', 'Pie Graph Tool'),
  make('radar', 'Radar Graph Tool'),
];
