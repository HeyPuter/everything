/**
 * Modifier keys for taps. Android reports no modifier state on touch and
 * stylus events, even while a hardware keyboard's Shift, Alt, Ctrl or Command
 * is held, so Shift-tap could never extend a selection there although Shift+B
 * and other shortcuts worked. Keyboard events do carry the keys, so the keys
 * held are tracked from them and copied onto touch and pen events (and the
 * click and mouse events a tap produces) before any handler sees them.
 * Modifiers are only ever added, never cleared, and mouse events are left alone.
 */

const PROPS = ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'];
const POINTER_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
const installed = new WeakSet();

/** Install the tracking on `win` (once per window); returns the live state, for tests. */
export function installHeldModifiers(win = window) {
  const held = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
  if (!win || installed.has(win)) return held;
  installed.add(win);
  // Whether the last pointer pressed was a finger or a stylus: click and mouse events
  // that browsers make from a tap may not say so themselves.
  let tapping = false;
  const fromKeys = (e) => {
    for (const p of PROPS) held[p] = Boolean(e[p]);
  };
  const clear = () => {
    for (const p of PROPS) held[p] = false;
  };
  win.addEventListener('keydown', fromKeys, true);
  win.addEventListener('keyup', fromKeys, true);
  // A key released while the window is in the background never sends its keyup.
  win.addEventListener('blur', clear);
  win.document?.addEventListener('visibilitychange', () => win.document.visibilityState === 'hidden' && clear());
  const onPointer = (e) => {
    const type = e.pointerType;
    if (e.type === 'pointerdown' && type) tapping = type === 'touch' || type === 'pen';
    // Keyboard-activated clicks (detail 0, no pointer type) are not taps.
    const isTap = type ? type === 'touch' || type === 'pen' : tapping && e.detail > 0;
    if (!isTap) return;
    for (const p of PROPS) {
      if (held[p] && !e[p]) Object.defineProperty(e, p, { value: true, configurable: true });
    }
  };
  for (const t of POINTER_EVENTS) win.addEventListener(t, onPointer, true);
  return held;
}
