/**
 * Pointer drags for the workspace chrome (panel tabs, panel icons, floating
 * panels, the Tools panel grip). One code path for mouse, touch and stylus:
 * the drag starts once the pointer has moved past a small threshold, so a
 * tap or click on the same control still works, and the click that follows
 * a real drag is swallowed. Listeners sit on the window, so a drag survives
 * its handle being moved to another part of the page mid-drag.
 */

/** Movement (px) before a press becomes a drag: a finger wobbles more than a mouse. */
export function dragThreshold(e) {
  return e.pointerType === 'touch' ? 10 : e.pointerType === 'pen' ? 6 : 4;
}

/**
 * Track a drag from a pointerdown event `e`.
 * handlers: { threshold, start(ev, origin), move(ev), end(ev, { cancelled }) }
 * `start` runs once the pointer passes the threshold (return false to give
 * up); `move` and `end` run only after a start. Returns a function that
 * cancels the drag.
 */
export function trackDrag(e, { threshold = dragThreshold(e), start, move, end } = {}) {
  const pointerId = e.pointerId ?? 1;
  const origin = { x: e.clientX, y: e.clientY };
  let started = false;
  let done = false;
  const onMove = (ev) => {
    if ((ev.pointerId ?? 1) !== pointerId || done) return;
    if (!started) {
      if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < threshold) return;
      if (start && start(ev, origin) === false) return finish(ev, true, false);
      started = true;
    }
    ev.preventDefault?.();
    move?.(ev);
  };
  const onUp = (ev) => {
    if ((ev.pointerId ?? 1) !== pointerId || done) return;
    finish(ev, ev.type !== 'pointerup', started);
  };
  function finish(ev, cancelled, notify) {
    done = true;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    if (!notify) return;
    end?.(ev, { cancelled });
    // The click that follows the release belongs to the drag, not to the control.
    const swallow = (c) => {
      c.preventDefault();
      c.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  }
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  return () => {
    if (!done) finish(null, true, false);
  };
}

/** Whether client point (x, y) is inside element `el` (grown by `pad` px); false for hidden elements. */
export function pointIn(el, x, y, pad = 0) {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}
