/** Re-renders `container` and moves focus back to the control with the same `data-focus` key, if it had focus. */
export function keepFocus(container, render) {
  const active = container.ownerDocument.activeElement;
  const key = active && container.contains(active) ? active.closest('[data-focus]')?.dataset.focus : null;
  render();
  if (key) [...container.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === key)?.focus({ preventScroll: true });
}

/** True while a menu opened from inside `container` is showing; re-rendering would detach its anchor. */
export const menuOpen = (container) => Boolean(container.querySelector('[aria-expanded="true"]'));
