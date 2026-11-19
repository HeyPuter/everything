// Arrow-key movement inside a panel toolbar (WAI-ARIA toolbar pattern): one
// tab stop for the whole toolbar, Left/Right (and Up/Down) move between its
// enabled buttons, Home and End jump to the ends. The button last focused is
// the one Tab returns to.

/** The buttons the keys move between: shown and enabled, in document order. */
export function toolbarItems(root) {
  return [...root.querySelectorAll('button')].filter((b) => !b.disabled && !b.hidden && !b.closest('[hidden]'));
}

/** Makes `root` (role=toolbar) keyboard-navigable; call `sync()` after buttons change state. */
export function toolbarKeys(root) {
  let current = null;
  const sync = () => {
    const items = toolbarItems(root);
    if (!items.includes(current)) current = items[0] || null;
    for (const b of root.querySelectorAll('button')) {
      const want = b === current ? '0' : '-1';
      if (b.getAttribute('tabindex') !== want) b.setAttribute('tabindex', want);
    }
  };
  root.addEventListener('focusin', (e) => {
    const b = e.target.closest?.('button');
    if (b && root.contains(b) && b !== current) {
      current = b;
      sync();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const items = toolbarItems(root);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let j;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    items[j].focus();
  });
  sync();
  return { sync };
}
