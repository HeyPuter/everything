/**
 * Lists that a finger scrolls but whose items a pen drags. touch-action is
 * read when a pen touches down, so while a pen hovers over `el` it gets the
 * class `pen-direct` (its items then set touch-action: none in CSS) and loses
 * it when the pen leaves, unless `holding()` says a drag is under way, or
 * when another kind of pointer moves over it. A finger still scrolls the list.
 * Returns a function telling whether a pen is hovering there.
 */
export function trackPenHover(el, { holding = () => false } = {}) {
  let on = false;
  const set = (v) => {
    if (on === v) return;
    on = v;
    el.classList.toggle('pen-direct', v);
  };
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'pen') set(false);
    else if (!e.buttons) set(true);
  });
  el.addEventListener('pointerleave', (e) => {
    if (!holding() || e.pointerType !== 'pen') set(false);
  });
  return () => on;
}
