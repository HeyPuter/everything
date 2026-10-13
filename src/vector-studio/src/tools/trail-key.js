/**
 * The trail key (` or ~): held while dragging a shape tool, every pointer
 * move leaves a copy of the shape being drawn, so one drag draws a trail of
 * shapes. Tracked at the document so it can be pressed before the drag.
 */
let down = false;
let installed = false;

const isTrailKey = (e) => e.code === 'Backquote' || e.key === '`' || e.key === '~';

function typing(t) {
  return Boolean(t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)));
}

export function trailKeyDown() {
  return down;
}

export function installTrailKey() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('keydown', (e) => {
    if (isTrailKey(e) && !e.metaKey && !e.ctrlKey && !typing(e.target)) down = true;
  }, true);
  document.addEventListener('keyup', (e) => {
    if (isTrailKey(e)) down = false;
  }, true);
  window.addEventListener('blur', () => {
    down = false;
  });
}
