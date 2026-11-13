/**
 * Tool base class and registry.
 *
 * Tools receive normalized pointer events in document space:
 *   { x, y, sx, sy, shift, alt, mod, button, pointerType, pressure, native, clicks }
 * where `mod` is Command on macOS and Ctrl elsewhere. A tool's handlers run
 * against `this.app.editor`, the active document's editor.
 */

export class Tool {
  /** Stable id, e.g. 'selection'. */
  static id = 'tool';
  /** Accessible name shown in tooltips and the status bar. */
  static label = 'Tool';
  /** Single key shortcut like 'V' or 'Shift+M'. */
  static shortcut = '';
  /** Icon name from ui/icons.js. */
  static icon = 'mouse-pointer-2';
  /** Short hint shown in the status bar while the tool is active. */
  static hint = '';

  constructor(app) {
    this.app = app;
    this.cursor = 'default';
    this.selectionMode = 'object';
    this.showsBoundingBox = false;
  }

  get editor() {
    return this.app.editor;
  }

  get doc() {
    return this.app.editor?.doc;
  }

  get id() {
    return this.constructor.id;
  }

  activate() {}

  deactivate() {}

  onPointerDown() {}

  onPointerMove() {}

  onPointerUp() {}

  /** Pointer moved with no button down. */
  onHover() {}

  /** The pointer left the canvas with no button down (a pen lifted out of range, a mouse moved off). */
  onLeave() {}

  onDoubleClick() {}

  /** Return true when the key was handled. */
  onKeyDown() {
    return false;
  }

  onKeyUp() {
    return false;
  }

  /** Draw tool feedback on the overlay (CSS pixel space). */
  drawOverlay() {}

  /** Cancel any in-progress interaction (Escape, tool switch, undo). */
  cancel() {}

  /** Finish any in-progress interaction (tool switch, Enter). */
  commit() {}

  /** Options dialog opened by double-clicking the tool button. */
  openOptions() {}

  setCursor(c) {
    this.cursor = c;
    this.app.setCanvasCursor?.(c);
  }

  /** Redraw the overlay. */
  overlay() {
    this.editor?.emit('overlay');
  }

  status(text) {
    this.app.setStatusHint?.(text ?? this.constructor.hint);
  }
}

/** Distance threshold in document units for a CSS-pixel radius. */
export function tol(editor, px = 4) {
  // Preferences > Selection & Anchor Display > Tolerance scales hit areas (3 px is the default).
  const scale = (editor.prefs?.get('selectionTolerance') || 3) / 3;
  return (px * scale) / editor.view.zoom;
}

/**
 * Constrain a vector to multiples of 45 degrees (Shift while drawing),
 * measured from `baseDeg`, the Constrain Angle preference (counterclockwise,
 * as on screen; the document's y axis points down).
 */
export function constrain45(x0, y0, x, y, baseDeg = 0) {
  const dx = x - x0;
  const dy = y - y0;
  const len = Math.hypot(dx, dy);
  const base = (-(Number(baseDeg) || 0) * Math.PI) / 180;
  const a = Math.round((Math.atan2(dy, dx) - base) / (Math.PI / 4)) * (Math.PI / 4) + base;
  return { x: x0 + Math.cos(a) * len, y: y0 + Math.sin(a) * len };
}

/** The Constrain Angle preference in degrees. */
export function constrainAngle(app) {
  const v = Number(app?.prefs?.get('constrainAngle'));
  return Number.isFinite(v) ? v : 0;
}

/** Format a length in the document's units for feedback labels. */
export function fmt(editor, v, digits = 2) {
  const units = editor.doc.root.units || 'pt';
  const conv = UNIT_FACTORS[units] || 1;
  const n = v / conv;
  return `${Number(n.toFixed(digits))} ${units}`;
}

/** Points per unit. */
export const UNIT_FACTORS = { pt: 1, px: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, pc: 12 };
