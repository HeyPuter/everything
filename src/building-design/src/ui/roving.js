/**
 * Roving tabindex for radio groups and grids: one Tab stop for the whole
 * group (the checked item, or the first), arrow keys to move within it.
 *
 *   h  index step for Left/Right (default 1)
 *   v  index step for Up/Down (default: the same as h)
 * Returns sync(), to call after the checked item changes.
 */
export function roving(container, selector, { h = 1, v } = {}) {
  const vStep = v ?? h;
  const items = () => [...container.querySelectorAll(selector)].filter((b) => !b.disabled);
  const sync = () => {
    const list = items();
    const cur = list.find((b) => b.getAttribute('aria-checked') === 'true') ?? list[0];
    for (const b of list) b.tabIndex = b === cur ? 0 : -1;
  };
  container.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    let j;
    if (e.key === 'ArrowRight') j = i + h;
    else if (e.key === 'ArrowLeft') j = i - h;
    else if (e.key === 'ArrowDown') j = i + vStep;
    else if (e.key === 'ArrowUp') j = i - vStep;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    else return;
    e.preventDefault();
    j = Math.max(0, Math.min(list.length - 1, j));
    list[i].tabIndex = -1;
    list[j].tabIndex = 0;
    list[j].focus();
  });
  sync();
  return sync;
}
