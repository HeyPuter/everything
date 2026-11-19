// Floating windows (panel frames undocked from the workspace and modeless effect
// windows) share one stack: the window last clicked or opened comes to the front.
// They all stay under modal dialogs, menus, toasts and tooltips (z-index 900+).

const BASE = 800;
const TOP = 899;
let top = BASE;

const stacked = () => [...document.querySelectorAll('.dock-float, .dialog-backdrop.modeless')];
const z = (el) => Number(el.style.zIndex) || BASE;

/** Brings `el` (a .dock-float or a modeless .dialog-backdrop) in front of the other floating windows. */
export function raiseWindow(el) {
  if (!el) return;
  const others = stacked().filter((w) => w !== el);
  if (el.style.zIndex && others.every((w) => z(w) < z(el))) return;
  if (top >= TOP) {
    // Out of room: number the windows again from the bottom, keeping their order.
    top = BASE;
    for (const w of others.sort((a, b) => z(a) - z(b))) w.style.zIndex = String(++top);
  }
  el.style.zIndex = String(++top);
}

/** Raises `el` whenever a pointer goes down anywhere in it (before the click lands) or focus moves into it. */
export function stackWindow(el) {
  el.addEventListener('pointerdown', () => raiseWindow(el), true);
  el.addEventListener('focusin', () => raiseWindow(el));
  return el;
}

/** Test hook: forget the stack. */
export function resetWindowStack() {
  top = BASE;
}
