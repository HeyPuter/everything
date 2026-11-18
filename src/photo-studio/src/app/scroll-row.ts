// Sideways scrolling for rows of controls with hidden scrollbars.
/** A row that scrolls sideways when its contents do not fit the window
 * (the options bar, the document tabs; their scrollbars are hidden): a mouse
 * wheel scrolls it, and an edge fades where more is (style.css). */
export function scrollableRow(root: HTMLElement, opts: { fade?: boolean; ignore?: (ev: WheelEvent) => boolean } = {}) {
  // The fade masks the row; a row with popups inside (the menu bar) draws its own.
  if (opts.fade !== false) root.classList.add('scroll-row');
  let frame = 0;
  const edges = () => {
    frame = 0;
    const more = root.scrollWidth - root.clientWidth;
    root.classList.toggle('more-left', more > 1 && root.scrollLeft > 1);
    root.classList.toggle('more-right', more > 1 && root.scrollLeft < more - 1);
  };
  const queue = () => (frame ||= requestAnimationFrame(edges));
  root.addEventListener(
    'wheel',
    (ev) => {
      if (root.scrollWidth <= root.clientWidth || ev.ctrlKey || Math.abs(ev.deltaX) >= Math.abs(ev.deltaY) || opts.ignore?.(ev)) return;
      // A focused field or list keeps the wheel for itself.
      const t = ev.target as HTMLElement;
      if (t === document.activeElement && t.matches('input,select,textarea')) return;
      root.scrollLeft += ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
      ev.preventDefault();
    },
    { passive: false },
  );
  root.addEventListener('scroll', queue, { passive: true });
  new ResizeObserver(queue).observe(root);
  new MutationObserver(queue).observe(root, { childList: true, subtree: true });
  queue();
}
