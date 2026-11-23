import { el, button } from './lib/ui.js';
import { arrowKeyGesture } from './lib/arrow-key-gesture.js';

/** Physical PDF point controls and pointer/keyboard positioning for an inline text draft. */
export function textPositionControls({
  getPosition,
  setPosition,
  viewport,
  pointAt,
  changed,
  edited = () => {},
  completed = () => {},
  dragThreshold = 0,
}) {
  let gesture;
  const fields = [];
  const shown = [];
  const pending = (input, i) =>
    shown[i] !== undefined &&
    input.value !== shown[i] &&
    (!input.validity.valid || input.valueAsNumber !== getPosition()[i] * viewport.userUnit);
  const sync = (replace = false) =>
    fields.forEach((input, i) => {
      if (document.activeElement !== input && (replace || !pending(input, i))) {
        shown[i] = String(Number((getPosition()[i] * viewport.userUnit).toFixed(3)));
        input.value = shown[i];
      }
    });
  const update = (point, replace = true) => {
    setPosition(point);
    sync(replace);
    changed();
  };
  const move = button('Move text', 'MousePointer2', () => {}, 'btn text-move', {
    'aria-label': 'Move text',
    title: 'Drag to move. Arrow keys move 1 pt; Shift moves 10 pt.',
  });
  const begin = (e, { capture = true, from = pointAt(e), focus = true } = {}) => {
    if (gesture || !e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Focus commits a typed coordinate through change before the drag remembers its origin.
    if (focus) move.focus({ preventScroll: true });
    const initial = pointAt(e);
    gesture = {
      id: e.pointerId,
      from,
      position: getPosition(),
      // Opening properties may have changed the viewport since an unselected
      // object's press. That layout shift is not a drag; subsequent movement or
      // scrolling is measured from the settled geometry, retaining the grab point.
      initial,
      last: initial,
      event: e,
      dragged: false,
    };
    if (capture) move.setPointerCapture(e.pointerId);
  };
  move.addEventListener('pointerdown', begin);
  const drag = (e) => {
    if (gesture?.id !== e.pointerId) return;
    gesture.event = e;
    const p = pointAt(e);
    if (gesture.last.every((value, i) => value === p[i])) return;
    if (
      !gesture.dragged &&
      Math.hypot(p[0] - gesture.initial[0], p[1] - gesture.initial[1]) *
        viewport.scale *
        viewport.userUnit <
        dragThreshold
    )
      return;
    gesture.dragged = true;
    gesture.last = p;
    update(gesture.position.map((n, i) => n + p[i] - gesture.from[i]));
  };
  move.addEventListener('pointermove', drag);
  const end = (e) => {
    if (gesture?.id !== e.pointerId) return;
    drag(e);
    const moved = getPosition().some((n, i) => n !== gesture.position[i]);
    gesture = null;
    if (moved) completed();
  };
  move.addEventListener('pointerup', end);
  const cancel = () => {
    if (!gesture) return false;
    const p = gesture.position;
    gesture = null;
    update(p);
    return true;
  };
  move.addEventListener('pointercancel', (e) => {
    if (gesture?.id === e.pointerId) cancel();
  });
  move.addEventListener('lostpointercapture', (e) => {
    if (gesture?.id === e.pointerId) cancel();
  });
  move.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cancel()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  });
  const keys = arrowKeyGesture(move, {
    completed,
    update: (direction, distance) => {
      if (gesture) return false;
      const step = distance * viewport.scale;
      const a = viewport.convertToPdfPoint(0, 0),
        b = viewport.convertToPdfPoint(direction[0] * step, direction[1] * step);
      update(getPosition().map((n, i) => n + b[i] - a[i]));
    },
  });
  const root = el('div', { class: 'text-position-controls' });
  for (const [i, label] of ['X', 'Y'].entries()) {
    const input = el('input', {
      type: 'number',
      step: 'any',
      required: true,
      'aria-label': `Text ${label} in points`,
      title: `${label} position in PDF points, measured from the page origin at bottom left.`,
    });
    input.onchange = () => {
      // Keep incomplete input available for correction, without blocking Cancel on blur.
      if (!input.checkValidity()) return;
      const p = getPosition();
      p[i] = Number(input.value) / viewport.userUnit;
      // Changing one axis must leave an incomplete draft in the other axis intact.
      update(p, false);
    };
    input.oninput = edited;
    fields.push(input);
    root.append(el('label', {}, label, input));
  }
  sync();
  return {
    root,
    handle: move,
    /** Arrow-key nudges not yet completed (see arrowKeyGesture). */
    keys,
    begin,
    drag,
    end,
    cancel,
    refresh: () => {
      if (gesture) drag(gesture.event);
    },
    get pending() {
      return fields.some(pending);
    },
    validate: () => {
      for (const input of fields)
        if (!input.reportValidity()) throw new Error('Choose a valid text position.');
    },
  };
}
