// Long press on a touch screen opens the context menu everywhere.
//
// Android browsers fire `contextmenu` on a long press; iOS Safari never does,
// so the design tree, sketch dimensions and other DOM items had no context
// menu on iPhone and iPad. A touch held still for a while dispatches the
// `contextmenu` event itself, unless the browser fires one first; when the
// browser fires one after it (a slower Android long press), that one is
// dropped so a menu never opens twice.

const DELAY = 500;
const SLOP = 8;

let installed = false;

export function installLongPressContextMenu(root: Document = document) {
  if (installed) return;
  installed = true;
  let press: { id: number; x: number; y: number; target: Element; timer: number } | null = null;
  /** The touch whose long press opened a menu: the browser's late contextmenu and the click when it lifts are dropped. */
  let opened: { id: number; until: number; liftedAt: number | null; dropped: boolean } | null = null;
  let dispatching = false;

  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  root.addEventListener('pointerdown', (e) => {
    cancel();
    opened = null;
    if (e.pointerType !== 'touch' || !e.isPrimary || !(e.target instanceof Element)) return;
    // The graphics area has its own long press (it knows about drags and pinches).
    if (e.target.closest('canvas, input, textarea, select, [contenteditable]')) return;
    const target = e.target;
    const { clientX: x, clientY: y, pointerId: id } = e;
    press = {
      id, x, y, target,
      timer: window.setTimeout(() => {
        press = null;
        // A list redrawn under the finger (the design tree after a rebuild) replaced the element.
        const el = target.isConnected ? target : document.elementFromPoint(x, y);
        if (!el) return;
        dispatching = true;
        let handled = false;
        try {
          handled = !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 2, buttons: 0 }));
        } finally {
          dispatching = false;
        }
        if (handled) opened = { id, until: performance.now() + 1500, liftedAt: null, dropped: false };
      }, DELAY),
    };
  }, true);
  root.addEventListener('pointermove', (e) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) cancel();
  }, true);
  for (const type of ['pointerup', 'pointercancel'] as const) {
    root.addEventListener(type, (e) => {
      if (press && e.pointerId === press.id) cancel();
      if (opened?.id === e.pointerId) opened.liftedAt = performance.now();
    }, true);
  }
  // Scrolling the list under the finger (or a second finger, above) is not a long press.
  root.addEventListener('scroll', (e) => {
    if (press && e.target instanceof Node && e.target.contains(press.target)) cancel();
  }, true);
  root.addEventListener('contextmenu', (e) => {
    if (dispatching) return;
    // The browser's own long press came first: it opens the menu.
    if (press) { cancel(); return; }
    if (opened && opened.liftedAt === null && !opened.dropped && performance.now() < opened.until) {
      opened.dropped = true;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  // Lifting the finger after the menu opened is not also a tap on the item.
  root.addEventListener('click', (e) => {
    if (opened?.liftedAt != null && performance.now() - opened.liftedAt < 500) {
      opened = null;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}
