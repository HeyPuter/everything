// Right-button gestures on rulers: a right-drag picks a range to zoom to, a
// right-click without moving opens the ruler's menu. Browsers on macOS fire
// `contextmenu` on press and others on release, so the menu waits for the
// release either way, and a finished drag swallows a menu event that follows
// it before the next press.
//
//   bindRightDrag(el, {
//     filter(e)             -> false to ignore an event (default: all)
//     move(start, current)  pointer events, while dragging (after 4 px)
//     done(start, end)      pointer events, at the end of a drag
//     cancel()              the drag was cancelled
//     menu(x, y)            client coordinates, for a click without a drag
//   })

const THRESHOLD = 4;

export function bindRightDrag(el, { filter = () => true, move, done, cancel, menu }) {
  let drag = null;
  let swallow = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 2 || !filter(e)) return;
    swallow = false;
    drag = { start: e, moved: false, menuAt: null };
    el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.start.clientX, e.clientY - drag.start.clientY) < THRESHOLD) return;
    drag.moved = true;
    move?.(drag.start, e);
  });
  const end = (e, cancelled) => {
    if (!drag || (e.button !== 2 && e.type === 'pointerup')) return;
    const d = drag;
    drag = null;
    if (d.moved) {
      swallow = true;
      if (cancelled) cancel?.();
      else done?.(d.start, e);
    } else if (d.menuAt && !cancelled) menu?.(d.menuAt.x, d.menuAt.y);
  };
  el.addEventListener('pointerup', (e) => end(e, false));
  el.addEventListener('pointercancel', (e) => end(e, true));
  el.addEventListener('contextmenu', (e) => {
    if (!filter(e)) return;
    e.preventDefault();
    if (swallow) {
      swallow = false;
      return;
    }
    // Pressed and not yet released (macOS): open on release unless it turns into a drag.
    if (drag) drag.menuAt = { x: e.clientX, y: e.clientY };
    else menu?.(e.clientX, e.clientY);
  });
}
