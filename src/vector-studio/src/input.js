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
 * - A pen opens the context menu with its side button: clicked with the pen
 *   just above the screen, or held as the pen taps. A pen tip held still on
 *   the screen does not: Android turns that hold into a contextmenu event,
 *   which would interrupt precise drawing.
 * - A pen's eraser end erases with the Eraser tool, whatever the tool.
 * - Palm rejection: while a pen touches the canvas, touches are ignored, and
 *   a pen landing ends whatever a touch (a resting palm) had started.
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
    // Touches ignored because a pen is on the canvas (a palm resting while drawing).
    this.palms = new Set();
    host.addEventListener('pointerdown', (e) => this.down(e));
    host.addEventListener('pointermove', (e) => this.move(e));
    host.addEventListener('pointerup', (e) => this.up(e));
    host.addEventListener('pointercancel', (e) => this.cancel(e));
    host.addEventListener('lostpointercapture', (e) => this.lostCapture(e));
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
    if (e.pointerType === 'touch' && this.#penDown()) {
      this.palms.add(e.pointerId);
      return;
    }
    if (this.#sideButton(e)) {
      // A side-button press is no stroke: the pen stays untracked, so it holds back no touch.
      this.#sideButtonDown(e);
      return;
    }
    if (e.pointerType === 'pen') this.#rejectPalms();
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
      this.pendingTouch = {
        e,
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => this.#settleTouch(), TOUCH_SETTLE_MS),
      };
      this.longPressTimer = setTimeout(() => this.#longPress(e), LONG_PRESS_MS);
      return;
    }
    this.#startTool(e);
  }

  /** Whether a pen is touching the canvas. */
  #penDown() {
    for (const p of this.pointers.values()) if (p.type === 'pen') return true;
    return false;
  }

  /**
   * A pen landed: touches already on the canvas are a palm resting on the
   * screen (or a hand steadying it), so whatever they started (a press
   * waiting to start, a tool drag, a pinch, a long press) ends without
   * effect, and they are ignored until they lift.
   */
  #rejectPalms() {
    let any = false;
    for (const [id, p] of this.pointers) {
      if (p.type !== 'touch') continue;
      any = true;
      this.pointers.delete(id);
      this.palms.add(id);
    }
    if (!any) return;
    this.#clearTouchTimers();
    this.pendingTouch = null;
    this.touchStart = null;
    this.longPressed = false;
    this.gesture = null;
    if (this.active && !this.pointers.has(this.active.id)) {
      this.active.tool.cancel?.();
      this.active = null;
    }
  }

  /** Start the deferred one-finger tool press (it moved, lifted or waited long enough). */
  #flushTouch(dragged = false) {
    const p = this.pendingTouch;
    if (!p) return;
    clearTimeout(p.timer);
    // Keep the press origin after settling so later movement cancels the hold.
    this.touchStart = { x: p.x, y: p.y };
    this.pendingTouch = null;
    if (this.pointers.has(p.e.pointerId) || this.lifting === p.e.pointerId)
      this.#startTool(p.e, dragged);
  }

  /**
   * The finger rested without moving: start the press, unless it may be the
   * second tap of a double-tap, which waits to see whether it lifts (a
   * double-tap) or drags (a press).
   */
  #settleTouch() {
    const p = this.pendingTouch;
    if (!p) return;
    if (this.#isDoubleClick(p.e, this.toEvent(p.e))) p.timer = 0;
    else this.#flushTouch();
  }

  /** A second press within 400 ms and 6 px of the last click. */
  #isDoubleClick(e, ev) {
    // Time of the press itself: a deferred touch press starts the tool later.
    const now = e.timeStamp || performance.now();
    return (
      now - this.lastClick.t < 400 &&
      Math.hypot(ev.sx - this.lastClick.x, ev.sy - this.lastClick.y) < 6
    );
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
    this.lastPressMenu = performance.now();
    this.#openContextMenu(e);
  }

  /**
   * Whether a pen event, with the tip off the screen, has the side button
   * pressed. The Pointer Events spec reports it as button 2. Android reports
   * the S Pen button clicked in the air as the contact bit with no pressure,
   * in hovering moves.
   */
  #sideButton(e) {
    if (e.pointerType !== 'pen' || this.pointers.has(e.pointerId)) return false;
    return e.button === 2 || (e.buttons & 2) !== 0 || ((e.buttons & 1) !== 0 && !e.pressure);
  }

  /** The side button went down: one menu per press, where the pen is. */
  #sideButtonDown(e) {
    if (this.sidePressed) return;
    this.sidePressed = true;
    // A tap with the button held already opened it through contextmenu.
    if (this.lastContextMenu && performance.now() - this.lastContextMenu < 1500) return;
    this.lastPressMenu = performance.now();
    this.#openContextMenu(e);
  }

  /**
   * A contextmenu event from a pen tip held still on the screen. Android
   * sends it while the pen touches, as a right-button press, and Windows as
   * it lifts. A tap with the side button held sends one with no pen press,
   * so it is not one of these.
   */
  #penHold() {
    return this.#penDown() || (this.penLifted && performance.now() - this.penLifted < 500);
  }

  /**
   * The tool for a press of the pen's eraser end: the Eraser (or the Path
   * Eraser when that is the tool in use), or null for any other press.
   */
  #eraserFor(e) {
    if (e.pointerType !== 'pen' || !(e.button === 5 || e.buttons & 32)) return null;
    const tool = this.currentTool();
    if (tool?.id === 'eraser' || tool?.id === 'path-eraser') return tool;
    return this.app.getTool?.('eraser') || null;
  }

  /** `dragged`: a deferred touch press that started because the finger moved. */
  #startTool(e, dragged = false) {
    const eraser = this.#eraserFor(e);
    const tool = eraser || this.currentTool();
    if (!tool) return;
    const ev = this.toEvent(e);
    if (eraser) {
      // The eraser end presses like the tip: no double-click, and its overlay shows the eraser.
      ev.button = 0;
      this.lastClick = { t: 0, x: ev.sx, y: ev.sy };
      this.active = { id: e.pointerId, tool, last: e };
      if (tool !== this.currentTool()) {
        this.editor.pressTool = tool;
        this.app.setCanvasCursor(tool.cursor);
      }
      tool.onPointerDown(ev);
      return;
    }
    // Double-click detection that works for pen and touch as well as mouse.
    let dbl = this.#isDoubleClick(e, ev);
    // A second touch press that drags before lifting is a drag, not a double-tap,
    // unless the tool drags from a double-tap (word selection in type).
    const tapDrag = dbl && dragged && !!tool.doubleTapDrags?.(ev);
    if (dragged && !tapDrag) dbl = false;
    this.lastClick = { t: dbl ? 0 : e.timeStamp || performance.now(), x: ev.sx, y: ev.sy };
    this.active = { id: e.pointerId, tool, last: e };
    if (dbl) {
      if (!tapDrag) this.active = null;
      tool.onDoubleClick(ev);
      return;
    }
    tool.onPointerDown(ev);
  }

  move(e) {
    if (!this.editor || this.palms.has(e.pointerId)) return;
    if (e.pointerType === 'pen' && !this.pointers.has(e.pointerId)) {
      if (this.#sideButton(e)) {
        this.#sideButtonDown(e);
        return;
      }
      if (!e.buttons) this.sidePressed = false;
    }
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (e.pointerType === 'touch' && this.pointers.has(e.pointerId)) {
      if (this.longPressed) return;
      const p = this.pendingTouch;
      const start = p || this.touchStart;
      if (p && p.e.pointerId === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) {
        this.#flushTouch(true);
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
    if (this.active && this.active.id === e.pointerId) {
      this.active.last = e;
      // A press that turned into a drag is not the first click of a double-click.
      if (this.lastClick.t && Math.hypot(ev.sx - this.lastClick.x, ev.sy - this.lastClick.y) >= 6) this.lastClick.t = 0;
      this.active.tool.onPointerMove(ev);
    } else if (!this.active && tool && e.pointerType !== 'touch') tool.onHover(ev);
  }

  up(e) {
    if (this.palms.delete(e.pointerId)) return;
    this.#penUp(e);
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
      this.#applyPendingTempTool();
      return;
    }
    if (this.active && this.active.id === e.pointerId) {
      const { tool } = this.active;
      this.active = null;
      const ev = this.toEvent(e);
      if (this.#endPress(tool)) ev.button = 0;
      tool.onPointerUp(ev);
      this.#applyPendingTempTool();
    }
  }

  /** A press ended: the tool standing in for the pen's eraser end gives way. Returns whether it did. */
  #endPress(tool) {
    const ed = this.editor;
    if (!ed?.pressTool || ed.pressTool !== tool) return false;
    ed.pressTool = null;
    this.app.setCanvasCursor(this.currentTool()?.cursor || 'default');
    ed.emit('overlay');
    return true;
  }

  /** End document-owned input before the app changes the active editor. */
  reset() {
    this.#clearTouchTimers();
    this.sidePressed = false;
    this.pendingTouch = null;
    this.touchStart = null;
    this.longPressed = false;
    this.lifting = null;
    if (this.active) {
      this.active.tool.cancel?.();
      this.#endPress(this.active.tool);
      this.active = null;
    }
    this.pan = null;
    this.gesture = null;
    this.pointers.clear();
    this.palms.clear();
    this.lastClick = { t: 0, x: 0, y: 0 };
    this.pendingTempTool = null;
    this.spaceDown = false;
    this.setTempTool(null);
    this.app.setCanvasCursor(this.app.tool?.cursor || 'default');
  }

  cancel(e) {
    if (this.palms.delete(e.pointerId)) return;
    this.#penUp(e);
    if (this.pendingTouch?.e.pointerId === e.pointerId) this.pendingTouch = null;
    this.#clearTouchTimers();
    this.longPressed = false;
    this.pointers.delete(e.pointerId);
    if (this.active && this.active.id === e.pointerId) {
      this.active.tool.cancel?.();
      this.#endPress(this.active.tool);
      this.active = null;
    }
    this.pan = null;
    if (this.pointers.size < 2) this.gesture = null;
    this.#applyPendingTempTool();
  }

  /**
   * The canvas lost pointer capture mid-press (released by script, the
   * canvas hidden or moved...): the pointerup may now land on another
   * element and never reach the canvas, so the press ends here, where the
   * pointer last was, instead of leaving the tool dragging. After a normal
   * pointerup or pointercancel nothing is active and this does nothing.
   */
  lostCapture(e) {
    if (this.pan && !this.active && this.pointers.has(e.pointerId)) {
      this.pointers.delete(e.pointerId);
      this.pan = null;
      this.app.setCanvasCursor(this.currentTool()?.cursor || 'default');
      this.#applyPendingTempTool();
      return;
    }
    if (!this.active || this.active.id !== e.pointerId) return;
    const { tool, last } = this.active;
    this.active = null;
    this.pointers.delete(e.pointerId);
    const ev = this.toEvent(last);
    if (this.#endPress(tool)) ev.button = 0;
    tool.onPointerUp(ev);
    this.#applyPendingTempTool();
  }

  leave() {
    this.app.rulers?.setPointer(null);
    // Brush outlines that follow the pointer go with it (a pen lifted out of range, a mouse moved off).
    if (!this.active) this.currentTool()?.onLeave?.();
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

  /** A pen lifted: its side button is up, and a tip that touched remembers when. */
  #penUp(e) {
    if (e.pointerType !== 'pen') return;
    if (!e.buttons) this.sidePressed = false;
    if (this.pointers.has(e.pointerId)) this.penLifted = performance.now();
  }

  contextMenu(e) {
    e.preventDefault();
    if (!this.editor || this.gesture || this.#penHold()) return;
    // Android also fires contextmenu after a long press or a side-button press: that press already opened it.
    if (this.lastPressMenu && performance.now() - this.lastPressMenu < 1500) return;
    this.lastContextMenu = performance.now();
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

  #applyPendingTempTool() {
    const p = this.pendingTempTool;
    if (!p || this.active || this.pan) return;
    this.pendingTempTool = null;
    this.setTempTool(p.tool);
  }

  /** Space / Cmd temporary tools (called from the app's key handlers). */
  setTempTool(tool) {
    // Mid-drag the tool in use keeps the pointer: Space or Command pressed or
    // released during a drag takes effect when the button comes up.
    if (this.active || this.pan) {
      this.pendingTempTool = { tool };
      return;
    }
    this.pendingTempTool = null;
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
