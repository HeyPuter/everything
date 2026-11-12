// Touch screens that have no long-press context menu of their own (iPadOS,
// and Chrome on touch laptops) get one: a finger held still for a moment
// sends the element under it a contextmenu event, so layer, panel and tab
// menus open as they do with a right click. The canvas keeps touch for its
// tools, and the toolbar has its own long press (the tool flyout).

const HOLD = 550;
const SLOP = 8;

type Press = { id: number; x: number; y: number; timer: number; fired: boolean };

export function installLongPress() {
  let press: Press | undefined;
  const cancel = () => {
    if (press && !press.fired) clearTimeout(press.timer);
  };
  document.addEventListener(
    'pointerdown',
    (ev) => {
      cancel();
      press = undefined;
      if (ev.pointerType !== 'touch' || !ev.isPrimary) return;
      const target = ev.target as Element;
      if (!target.closest || target.closest('#viewport, .toolbar, input, textarea, select, [contenteditable="true"]')) return;
      const p: Press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, timer: 0, fired: false };
      p.timer = window.setTimeout(() => {
        p.fired = true;
        if (target.isConnected)
          target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 2, buttons: 0 }));
      }, HOLD);
      press = p;
    },
    true,
  );
  document.addEventListener(
    'pointermove',
    (ev) => {
      if (press && ev.pointerId === press.id && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > SLOP) cancel();
    },
    true,
  );
  document.addEventListener('pointercancel', cancel, true);
  document.addEventListener(
    'pointerup',
    (ev) => {
      if (press && ev.pointerId === press.id) cancel();
    },
    true,
  );
  // A browser's own long-press menu event (Android) comes by itself: only one
  // menu opens.
  document.addEventListener(
    'contextmenu',
    (ev) => {
      if (!press || !ev.isTrusted) return;
      if (!press.fired) return cancel();
      ev.preventDefault();
      ev.stopImmediatePropagation();
    },
    true,
  );
  // Lifting the finger after the menu opened is not a click on what is under it.
  document.addEventListener(
    'click',
    (ev) => {
      if (!press?.fired) return;
      press = undefined;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    },
    true,
  );
}
