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

/**
 * Keep a scroller where it is across a re-render: taking out the rows (and the
 * focused control with them) drops its position. Returns restore(), to call
 * once the new content is in place.
 */
export function keepScroll(scroller) {
  const top = scroller?.scrollTop;
  const left = scroller?.scrollLeft;
  return () => {
    if (!scroller || (!top && !left)) return;
    scroller.scrollTop = top;
    scroller.scrollLeft = left;
  };
}

/** Whether el has keyboard focus (true where :focus-visible is not supported). */
export function focusVisible(el) {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}
