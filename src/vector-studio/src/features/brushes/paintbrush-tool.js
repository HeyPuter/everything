/**
 * Paintbrush tool (B) with brushes: strokes are painted with the current
 * brush (chosen in the Brushes panel), pen pressure is recorded for brushes
 * that vary with pressure and drawing speed for brushes that vary with
 * velocity, a plain stroke (or a calligraphic brush of a fixed size) gets
 * its width from the pen pressure, and with "Edit selected paths" a stroke drawn
 * from a selected path redraws just that part of it instead of making a new
 * path (tools/reshape.js), keeping the pressure, speed and widths of the
 * rest. Double-click the tool for its options.
 */
import { PaintbrushTool } from '../../tools/freehand.js';
import { newPathStyle } from '../../tools/pen.js';
import { brushById } from './brush-model.js';
import { brushState } from './brush-actions.js';
import { pressureSamples, pressureWidthProfile, smoothPressures, pressureScale, GrowingStrokePreview } from './pressure.js';
import { drawString, SMOOTHING_STYLES } from '../../tools/stabilizer.js';

export { pressureSamples };

const DEFAULTS = { fidelity: 50, smoothing: 0, corners: 0, fill: false, keepSelected: true, editSelected: true, within: 12, pressure: true };

/** Screen speed (pixels per millisecond) that counts as fast (velocity 1). */
const FAST = 2.5;

/**
 * Drawing speed (0 slow .. 1 fast) at each stroke point from timestamps:
 * the screen speed over the neighboring points, smoothed.
 */
export function velocities(points, times, zoom = 1) {
  if (!times || times.length !== points.length || points.length < 2) return null;
  const n = points.length;
  const raw = points.map((_, i) => {
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    let d = 0;
    for (let k = a; k < b; k++) d += Math.hypot(points[k + 1].x - points[k].x, points[k + 1].y - points[k].y);
    const dt = Math.max(1, times[b] - times[a]);
    return Math.min(1, (d * zoom) / dt / FAST);
  });
  return raw.map((_, i) => {
    let sum = 0;
    let c = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) {
      sum += raw[k];
      c++;
    }
    return sum / c;
  });
}

export class BrushPaintbrushTool extends PaintbrushTool {
  static hint = 'Drag to paint with the current brush | Draw from a selected path to redraw part of it | [ and ] change the stroke weight | Double-click the tool for options';

  constructor(app) {
    super(app);
    const saved = app.prefs.get('paintbrushOptions') || {};
    this.opts = { ...DEFAULTS, ...saved };
    this.fidelity = this.opts.fidelity;
    this.keepSelected = this.opts.keepSelected;
  }

  /** Smoothing lives with the other Paintbrush options. */
  get smoothing() {
    const v = Number(this.opts?.smoothing);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
  }

  set smoothing(v) {
    this.opts = { ...this.opts, smoothing: Math.max(0, Math.min(100, Number(v) || 0)) };
    this.app.prefs.set('paintbrushOptions', this.opts);
  }

  /** Corners live with the other Paintbrush options too. */
  get corners() {
    const v = Number(this.opts?.corners);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
  }

  set corners(v) {
    this.opts = { ...this.opts, corners: Math.max(0, Math.min(100, Number(v) || 0)) };
    this.app.prefs.set('paintbrushOptions', this.opts);
  }

  /** "Edit selected paths" and Within live with the other Paintbrush options. */
  get editSelected() {
    return this.opts?.editSelected !== false;
  }

  set editSelected(v) {
    this.opts = { ...this.opts, editSelected: Boolean(v) };
    this.app.prefs.set('paintbrushOptions', this.opts);
  }

  get within() {
    const v = Number(this.opts?.within);
    return Number.isFinite(v) && v > 0 ? Math.max(2, Math.min(20, v)) : DEFAULTS.within;
  }

  set within(v) {
    this.opts = { ...this.opts, within: Math.max(2, Math.min(20, Number(v) || DEFAULTS.within)) };
    this.app.prefs.set('paintbrushOptions', this.opts);
  }

  onPointerDown(e) {
    this.preview?.reset();
    super.onPointerDown(e);
    this.pressures = e.pointerType === 'pen' ? [e.pressure ?? 0.5] : null;
    this.times = this.points ? this.points.map(() => e.native?.timeStamp ?? performance.now()) : null;
  }

  onPointerMove(e) {
    if (!this.points) return;
    const before = this.points.length;
    super.onPointerMove(e);
    const samples = e.native?.getCoalescedEvents?.() || [];
    const added = this.points.length - before;
    if (this.pressures) {
      for (let i = 0; i < added; i++) this.pressures.push(samples.length > 1 && samples[i] ? samples[i].pressure ?? e.pressure : e.pressure ?? 0.5);
    }
    if (this.times) {
      const now = e.native?.timeStamp ?? performance.now();
      for (let i = 0; i < added; i++) this.times.push(samples.length > 1 && samples[i]?.timeStamp ? samples[i].timeStamp : now);
    }
  }

  onPointerUp(e) {
    // The stroke's pen pressures and timestamps, for the new path or the stretch it redraws.
    this.strokePressures = this.pressures;
    this.strokeTimes = this.times;
    this.pressures = null;
    this.times = null;
    try {
      super.onPointerUp(e);
    } finally {
      this.strokePressures = null;
      this.strokeTimes = null;
    }
  }

  newStroke(pts, corners, e) {
    const pressures = this.strokePressures;
    this.lastPressure = pressureSamples(pts, pressures);
    this.lastWidth = pressures && this.opts.pressure ? pressureWidthProfile(pressureSamples(pts, smoothPressures(pressures), 32)) : null;
    this.lastVelocity = pressureSamples(pts, velocities(pts, this.strokeTimes, this.editor?.view.zoom || 1));
    try {
      super.newStroke(pts, corners, e);
    } finally {
      this.lastPressure = null;
      this.lastWidth = null;
      this.lastVelocity = null;
    }
  }

  /**
   * What the stroke redrawing part of `node` carries along it, as the path
   * would get it drawn new: pen pressure for a brush that reads it, drawing
   * speed for a brush that reads that, and widths from the pen pressure for
   * a plain stroke or a calligraphic brush of a fixed size.
   */
  strokeRows(pts, node) {
    const rows = {};
    const pressures = this.strokePressures;
    const brush = node?.brush?.id ? brushById(this.editor.doc, node.brush.id) : null;
    if (brush && brushUsesPressure(brush)) {
      const p = pressureSamples(pts, pressures);
      if (p) rows.brushPressure = p;
    }
    if (brush && brushUsesMode(brush, 'velocity')) {
      const v = pressureSamples(pts, velocities(pts, this.strokeTimes, this.editor?.view.zoom || 1));
      if (v) rows.velocity = v;
    }
    const widths = this.opts.pressure && (!brush || (brush.type === 'calligraphic' && !brushUsesPressure(brush)));
    if (widths && pressures) {
      const prof = pressureWidthProfile(pressureSamples(pts, smoothPressures(pressures), 32));
      if (prof) rows.widthProfile = prof.map((w) => [w.t, w.l, w.r]);
    }
    return rows;
  }

  pathStyle() {
    const ed = this.editor;
    const style = newPathStyle(ed);
    style.fill = this.opts.fill ? ed.style.fill || null : null;
    style.stroke = ed.style.stroke || ed.style.fill || { type: 'solid', color: '#000000' };
    if (!(style.strokeWidth > 0)) style.strokeWidth = 1;
    const id = brushState(this.app).currentId;
    // Pen pressure becomes the stroke's width profile (editable afterwards with the Width tool).
    if (this.lastWidth && this.pressureShapesWidth()) style.widthProfile = this.lastWidth;
    if (id && brushById(ed.doc, id)) {
      style.brush = { id, seed: Math.floor(Math.random() * 0x7fffffff) };
      if (this.lastPressure && brushUsesPressure(brushById(ed.doc, id))) style.brushPressure = this.lastPressure;
      // Drawing speed rides on the brush reference (the brush reads it as `velocity`).
      if (this.lastVelocity && brushUsesMode(brushById(ed.doc, id), 'velocity')) style.brush.velocity = this.lastVelocity;
    } else {
      style.strokeCap = 'round';
      style.strokeJoin = 'round';
    }
    return style;
  }

  /**
   * Whether pen pressure sets the width of the stroke being drawn: with the
   * option on, for a plain stroke and for a calligraphic brush that does not
   * read pressure itself (other brushes use pressure the way they are set up).
   */
  pressureShapesWidth() {
    if (!this.opts.pressure) return false;
    const ed = this.editor;
    const id = brushState(this.app).currentId;
    const brush = id ? brushById(ed.doc, id) : null;
    return !brush || (brush.type === 'calligraphic' && !brushUsesPressure(brush));
  }

  /** While drawing with pen pressure, the preview shows the width the stroke will get. */
  drawOverlay(ctx, editor) {
    const pts = this.points;
    const pressures = this.pressures;
    const brushed = Boolean(brushState(this.app).currentId && brushById(editor.doc, brushState(this.app).currentId));
    if (!pts || pts.length < 2 || !pressures || pressures.length !== pts.length || brushed || !this.pressureShapesWidth()) {
      this.preview?.reset();
      super.drawOverlay(ctx, editor);
      return;
    }
    const half = Math.max(0.5, ((editor.style.strokeWidth > 0 ? editor.style.strokeWidth : 1) * editor.view.zoom) / 2);
    const st = editor.style.stroke || editor.style.fill;
    // Pressure smoothing reaches two points ahead, so all but the last two keep their width; live
    // smoothing still moves the points near the pen.
    (this.preview ||= new GrowingStrokePreview()).draw(
      ctx,
      pts.map((p) => editor.view.toScreen(p.x, p.y)),
      smoothPressures(pressures).map((p) => half * pressureScale(p)),
      { color: st?.type === 'solid' ? st.color : '#000000', settled: Math.min(pts.length - 2, this.stabilizer?.firm ?? pts.length), key: half },
    );
    drawString(ctx, editor, this.stabilizer);
  }

  async openOptions() {
    const o = this.opts;
    const v = await this.app.dialogs.form({
      title: 'Paintbrush Tool Options',
      fields: [
        { key: 'fidelity', label: 'Fidelity (Accurate to Smooth)', type: 'range', min: 0, max: 100, value: o.fidelity },
        { key: 'smoothing', label: 'Smoothing (steadies the line while drawing)', type: 'range', min: 0, max: 100, value: o.smoothing ?? 0 },
        { key: 'corners', label: 'Corners (keeps sharp turns sharp)', type: 'range', min: 0, max: 100, value: o.corners ?? 0 },
        { key: 'smoothingStyle', label: 'Smoothing style', type: 'radio', options: SMOOTHING_STYLES, value: this.smoothingStyle },
        { type: 'heading', label: 'Options' },
        { key: 'fill', label: 'Fill new brush strokes', type: 'checkbox', value: o.fill },
        { key: 'keepSelected', label: 'Keep selected', type: 'checkbox', value: o.keepSelected },
        { key: 'editSelected', label: 'Edit selected paths', type: 'checkbox', value: o.editSelected },
        { key: 'pressure', label: 'Pen pressure varies the width', type: 'checkbox', value: o.pressure },
        { key: 'within', label: 'Within (pixels)', type: 'range', min: 2, max: 20, value: o.within },
      ],
      extraButtons: [{ label: 'Reset', action: 'reset' }],
    });
    if (!v) return;
    const next = v.__action === 'reset' ? { ...DEFAULTS } : { fidelity: v.fidelity, smoothing: v.smoothing, corners: v.corners, fill: v.fill, keepSelected: v.keepSelected, editSelected: v.editSelected, within: v.within, pressure: v.pressure };
    if (v.__action !== 'reset') this.smoothingStyle = v.smoothingStyle;
    this.opts = next;
    this.fidelity = next.fidelity;
    this.keepSelected = next.keepSelected;
    this.app.prefs.set('paintbrushOptions', next);
    if (v.__action === 'reset') this.openOptions();
  }
}

/** Whether a brush reads pen pressure anywhere. */
export function brushUsesPressure(b) {
  if (!b) return false;
  if (b.type === 'bristle') return true;
  return brushUsesMode(b, 'pressure');
}

/** Whether any of a brush's variable parameters uses a mode ('pressure', 'velocity', ...). */
export function brushUsesMode(b, mode) {
  return Boolean(b) && Object.values(b).some((v) => v && typeof v === 'object' && v.mode === mode);
}
