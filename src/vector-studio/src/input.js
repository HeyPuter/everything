/**
 * Canvas input: pointer, wheel, touch gestures and temporary tools.
 *
 * - Space (hold) pans with the Hand tool; Cmd/Ctrl+Space zooms in and
 *   Alt+Cmd/Ctrl+Space zooms out.
 * - Holding Cmd/Ctrl temporarily switches to the last Selection tool.
 * - Wheel scrolls; Cmd/Ctrl+wheel, Alt+wheel and trackpad pinch zoom at the
 *   pointer; middle-button drag pans.
 * - Two-finger touch pans and pinch-zooms without disturbing the tool: a
 *   finger's tool press waits a moment (or until it moves) so a pinch that
 *   starts with one finger never selects or deselects anything.
 * - A touch long press opens the context menu (iPad Safari sends no
 *   contextmenu event for it).
 */

/** How long a single finger waits for a second one before the tool starts. */
export const TOUCH_SETTLE_MS = 90;
/** Hold time for the touch context menu, and the slop that still counts as holding. */
export const LONG_PRESS_MS = 550;
const TOUCH_SLOP = 8;
import { IS_MAC } from './commands/registry.js';

export class CanvasInput {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.pointers = new Map();
    this.gesture = null;
    this.active = null; // { id, tool, button }
    this.spaceDown = false;
    this.tempTool = null;
    this.lastClick = { t: 0, x: 0, y: 0 };
    host.addEventListener('pointerdown', (e) => this.down(e));
    host.addEventListener('pointermove', (e) => this.move(e));
    host.addEventListener('pointerup', (e) => this.up(e));
    host.addEventListener('pointercancel', (e) => this.cancel(e));
    host.addEventListener('pointerleave', () => this.leave());
    host.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    host.addEventListener('contextmenu', (e) => this.contextMenu(e));
    // Safari trackpad pinch.
    host.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  get editor() {
    return this.app.editor;
  }

  /** The active document's view area (documents can sit side by side in the canvas). */
  viewRect() {
    return (this.app.views?.get(this.editor)?.host || this.host).getBoundingClientRect();
  }

  /** Normalized tool event from a pointer event. */
  toEvent(e) {
    const r = this.viewRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const p = this.editor.view.toDoc(sx, sy);
    return {
      x: p.x,
      y: p.y,
      sx,
      sy,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: IS_MAC ? e.metaKey : e.ctrlKey,
      button: e.button,
      pointerType: e.pointerType,
      pressure: e.pressure || 0.5,
      native: e,
    };
  }

  /** The tool handling input right now (temporary tools win). */
  currentTool() {
    return this.tempTool || this.app.tool;
  }

  down(e) {
    if (!this.editor) return;
    this.host.focus({ preventScroll: true });
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (e.pointerType === 'touch' && this.pointers.size === 2) {
      // Second finger: abandon the tool interaction and start a pinch.
      this.#clearTouchTimers();
      this.pendingTouch = null;
      if (this.active) {
        this.active.tool.cancel?.();
        this.active = null;
      }
      this.startGesture();
      return;
    }
    if (this.pointers.size > 2) return;
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointers cannot be captured.
    }
    if (e.button === 1 || (e.button === 0 && this.spaceDown && !this.tempTool)) {
      this.startPan(e);
      return;
    }
    if (e.button === 2) return; // context menu
    if (e.pointerType === 'touch') {
      this.longPressed = false;
      this.pendingTouch = { e, x: e.clientX, y: e.clientY, timer: setTimeout(() => this.#flushTouch(), TOUCH_SETTLE_MS) };
      this.longPressTimer = setTimeout(() => this.#longPress(e), LONG_PRESS_MS);
      return;
    }
    this.#startTool(e);
  }

  /** Start the deferred one-finger tool press (it moved, lifted or waited long enough). */
  #flushTouch() {
    const p = this.pendingTouch;
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingTouch = null;
    if (this.pointers.has(p.e.pointerId) || this.lifting === p.e.pointerId) this.#startTool(p.e);
  }

  #clearTouchTimers() {
    clearTimeout(this.pendingTouch?.timer);
    clearTimeout(this.longPressTimer);
    this.longPressTimer = 0;
  }

  /** Touch and hold: the tool press becomes a context menu on what is under the finger. */
  #longPress(e) {
    this.longPressTimer = 0;
    if (this.pointers.size !== 1 || !this.pointers.has(e.pointerId) || this.gesture || !this.editor) return;
    this.pendingTouch && clearTimeout(this.pendingTouch.timer);
    this.pendingTouch = null;
    if (this.active) {
      this.active.tool.cancel?.();
      this.active = null;
    }
    this.longPressed = true;
    this.lastTouchMenu = performance.now();
    this.#openContextMenu(e);
  }

  #startTool(e) {
    const tool = this.currentTool();
    if (!tool) return;
    const ev = this.toEvent(e);
    // Double-click detection that works for pen and touch as well as mouse.
    // Time of the press itself: a deferred touch press starts the tool later.
    const now = e.timeStamp || performance.now();
    const dbl = now - this.lastClick.t < 400 && Math.hypot(ev.sx - this.lastClick.x, ev.sy - this.lastClick.y) < 6;
    this.lastClick = { t: dbl ? 0 : now, x: ev.sx, y: ev.sy };
    this.active = { id: e.pointerId, tool };
    if (dbl) {
      this.active = null;
      tool.onDoubleClick(ev);
      return;
    }
    tool.onPointerDown(ev);
  }

  move(e) {
    if (!this.editor) return;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (e.pointerType === 'touch' && this.pointers.has(e.pointerId)) {
      if (this.longPressed) return;
      const p = this.pendingTouch;
      const start = p || this.touchStart;
      if (p && p.e.pointerId === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) {
        this.touchStart = { x: p.x, y: p.y };
        this.#flushTouch();
      }
      if (this.longPressTimer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > TOUCH_SLOP) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = 0;
      }
      if (this.pendingTouch) return;
    }
    if (this.gesture) {
      this.updateGesture();
      return;
    }
    if (this.pan) {
      const v = this.editor.view;
      v.set({ panX: this.pan.panX + e.clientX - this.pan.x, panY: this.pan.panY + e.clientY - this.pan.y });
      this.editor.viewChanged();
      return;
    }
    const ev = this.toEvent(e);
    this.app.rulers?.setPointer({ sx: ev.sx, sy: ev.sy });
    this.app.setPointerStatus?.(ev);
    const tool = this.currentTool();
    if (this.active && this.active.id === e.pointerId) this.active.tool.onPointerMove(ev);
    else if (!this.active && tool && e.pointerType !== 'touch') tool.onHover(ev);
  }

  up(e) {
    if (e.pointerType === 'touch') {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = 0;
      if (this.longPressed) {
        // The menu took this press; lifting the finger must not click anything.
        this.longPressed = false;
        this.pointers.delete(e.pointerId);
        return;
      }
      // A quick tap: run the deferred press now, then release it.
      if (this.pendingTouch?.e.pointerId === e.pointerId) {
        this.lifting = e.pointerId;
        this.#flushTouch();
        this.lifting = null;
      }
      this.touchStart = null;
    }
    this.pointers.delete(e.pointerId);
    if (this.gesture) {
      if (this.pointers.size < 2) this.gesture = null;
      return;
    }
    if (this.pan) {
      this.pan = null;
      this.app.setCanvasCursor(this.currentTool()?.cursor || 'default');
      return;
    }
    if (this.active && this.active.id === e.pointerId) {
      const { tool } = this.active;
      this.active = null;
      tool.onPointerUp(this.toEvent(e));
    }
  }

  cancel(e) {
    if (this.pendingTouch?.e.pointerId === e.pointerId) this.pendingTouch = null;
    this.#clearTouchTimers();
    this.longPressed = false;
    this.pointers.delete(e.pointerId);
    if (this.active && this.active.id === e.pointerId) {
      this.active.tool.cancel?.();
      this.active = null;
    }
    this.pan = null;
    if (this.pointers.size < 2) this.gesture = null;
  }

  leave() {
    this.app.rulers?.setPointer(null);
    if (this.editor && this.editor.hover && !this.active) {
      this.editor.hover = null;
      this.editor.emit('overlay');
    }
  }

  startPan(e) {
    const v = this.editor.view;
    this.pan = { x: e.clientX, y: e.clientY, panX: v.panX, panY: v.panY };
    this.app.setCanvasCursor('grabbing');
  }

  startGesture() {
    const [a, b] = [...this.pointers.values()];
    const v = this.editor.view;
    this.gesture = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      zoom0: v.zoom,
      panX: v.panX,
      panY: v.panY,
    };
  }

  updateGesture() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const g = this.gesture;
    const v = this.editor.view;
    const r = this.viewRect();
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Restore the gesture start, then apply pan and zoom about the midpoint.
    v.set({ zoom: g.zoom0, panX: g.panX + (c.x - g.c0.x), panY: g.panY + (c.y - g.c0.y) });
    v.zoomAt(g.zoom0 * (d / g.d0), c.x - r.left, c.y - r.top);
    this.editor.viewChanged();
  }

  wheel(e) {
    if (!this.editor) return;
    e.preventDefault();
    const v = this.editor.view;
    const r = this.viewRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    }
    // With Zoom with Mouse Wheel on, the plain wheel zooms and Alt/Command+wheel scrolls.
    const wheelZooms = this.app.prefs?.get('zoomWithWheel') && !e.shiftKey;
    if (wheelZooms ? !(e.altKey || e.metaKey) : e.ctrlKey || e.metaKey || e.altKey) {
      // Pinch on trackpads arrives as ctrl+wheel with small deltas.
      const factor = Math.exp(-dy * (e.ctrlKey && !e.metaKey && Math.abs(dy) < 50 ? 0.01 : 0.0025));
      v.zoomAt(v.zoom * factor, sx, sy);
    } else if (e.shiftKey && !dx) {
      v.set({ panX: v.panX - dy });
    } else {
      v.set({ panX: v.panX - dx, panY: v.panY - dy });
    }
    this.editor.viewChanged();
  }

  contextMenu(e) {
    e.preventDefault();
    if (!this.editor || this.gesture) return;
    // Android also fires contextmenu after a long press: the touch handler already opened it.
    if (this.lastTouchMenu && performance.now() - this.lastTouchMenu < 1500) return;
    this.#openContextMenu(e);
  }

  #openContextMenu(e) {
    // Right-clicking an unselected object selects it first, so the menu acts on it.
    const tool = this.currentTool();
    if (tool?.hitAt && !this.active) {
      const ev = this.toEvent(e);
      const hit = tool.hitAt(ev);
      if (hit) {
        const target = this.editor.selectionTarget(hit.id);
        if (!this.editor.selection.has(target.id)) this.editor.select([target.id]);
      }
    }
    this.app.showContextMenu(e.clientX, e.clientY);
  }

  /** Space / Cmd temporary tools (called from the app's key handlers). */
  setTempTool(tool) {
    if (this.active) return;
    if (this.tempTool === tool) return;
    this.tempTool?.deactivate?.();
    this.tempTool = tool;
    if (tool) {
      tool.activate?.();
      this.app.setCanvasCursor(tool.cursor);
    } else this.app.setCanvasCursor(this.app.tool?.cursor || 'default');
    this.editor?.emit('overlay');
  }
}
