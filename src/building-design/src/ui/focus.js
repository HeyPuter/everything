/**
 * Keep keyboard focus across a re-render: controls carry a data-key, and
 * the control with the same key gets focus back afterwards.
 */
export function preserveFocus(container, render) {
  const active = document.activeElement;
  const key = container.contains(active) ? active?.dataset?.key : null;
  render();
  if (!key) return;
  const next = [...container.querySelectorAll('[data-key]')].find((el) => el.dataset.key === key);
  next?.focus({ preventScroll: true });
}
