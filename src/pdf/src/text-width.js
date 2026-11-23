import { el, button } from './lib/ui.js';
import { arrowKeyGesture } from './lib/arrow-key-gesture.js';

/** Adjust a paragraph's physical column width without disturbing its native text selection. */
export function textWidthControls({
  input,
  getWidth,
  setWidth,
  zoom,
  pointAt = (e) => [e.clientX, e.clientY],
  changed,
  edited = () => {},
  completed = () => {},
}) {
  let gesture,
    maximum = Infinity,
    shown;
  const field = el('input', {
    type: 'number',
    min: 1,
    required: true,
    step: 'any',
    'aria-label': 'Paragraph width in points',
  });
  const pending = () =>
    shown !== undefined &&
    field.value !== shown &&
    (!field.validity.valid || field.valueAsNumber !== getWidth());
  const syncValue = (replace = false) => {
    if (document.activeElement !== field && (replace || !pending())) {
      shown = String(Number(getWidth().toFixed(3)));
      field.value = shown;
    }
  };
  const sync = (limit) => {
    maximum = limit;
    // A source paragraph may already extend past a crop edge; opening it must remain a no-op.
    field.max = String(Math.ceil(Math.max(limit, getWidth()) * 1000) / 1000);
    // Text/style/position refreshes must not discard a width still awaiting correction.
    syncValue();
    const transform = new DOMMatrix(input.style.transform);
    resize.style.cursor =
      Math.abs(transform.a) >= Math.abs(transform.b) ? 'ew-resize' : 'ns-resize';
  };
  const update = (width) => {
    setWidth(Math.max(1, Math.min(width, maximum)));
    syncValue(true);
    changed();
  };
  field.onchange = () => {
    if (!field.checkValidity()) return;
    update(Number(field.value));
  };
  field.oninput = edited;
  const resize = button('Resize width', 'ArrowUpRight', () => {}, 'btn text-width', {
    'aria-label': 'Resize paragraph width',
    title: 'Drag along the text direction to resize. Arrow keys adjust 1 pt; Shift adjusts 10 pt.',
  });
  resize.addEventListener('pointerdown', (e) => {
    if (gesture || !e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Commit any typed width before remembering the drag's starting width.
    resize.focus({ preventScroll: true });
    const transform = new DOMMatrix(input.style.transform);
    const length = Math.hypot(transform.a, transform.b);
    const from = pointAt(e);
    gesture = {
      id: e.pointerId,
      last: from,
      from,
      event: e,
      width: getWidth(),
      a: transform.a / length,
      b: transform.b / length,
    };
    resize.setPointerCapture(e.pointerId);
  });
  const drag = (e) => {
    if (gesture?.id !== e.pointerId) return;
    gesture.event = e;
    const p = pointAt(e);
    if (gesture.last.every((value, i) => value === p[i])) return;
    gesture.last = p;
    const delta =
      ((p[0] - gesture.from[0]) * gesture.a + (p[1] - gesture.from[1]) * gesture.b) / zoom;
    update(gesture.width + delta);
  };
  resize.addEventListener('pointermove', drag);
  resize.addEventListener('pointerup', (e) => {
    if (gesture?.id !== e.pointerId) return;
    drag(e);
    const resized = getWidth() !== gesture.width;
    gesture = null;
    if (resized) completed();
  });
  const cancel = () => {
    if (!gesture) return false;
    const width = gesture.width;
    gesture = null;
    setWidth(width);
    syncValue(true);
    changed();
    return true;
  };
  resize.addEventListener('pointercancel', (e) => {
    if (gesture?.id === e.pointerId) cancel();
  });
  resize.addEventListener('lostpointercapture', (e) => {
    if (gesture?.id === e.pointerId) cancel();
  });
  resize.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cancel()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  });
  const keys = arrowKeyGesture(resize, {
    completed,
    update: ([x, y], distance) => {
      if (gesture) return false;
      update(getWidth() + (x || -y) * distance);
    },
  });
  return {
    root: el('div', { class: 'text-position-controls' }, el('label', {}, 'Width', field, 'pt')),
    handle: resize,
    /** Arrow-key nudges not yet completed (see arrowKeyGesture). */
    keys,
    sync,
    refresh: () => {
      if (gesture) drag(gesture.event);
    },
    get pending() {
      return pending();
    },
    validate: () => {
      if (!field.reportValidity()) throw new Error('Choose a paragraph width within the page.');
    },
  };
}
