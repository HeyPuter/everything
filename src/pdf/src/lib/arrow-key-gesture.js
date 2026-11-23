/** How long arrow keys rest before their nudges complete as one action, in milliseconds. */
const REST = 180;

/**
 * Group a held arrow (including repeats), and presses in quick succession, into one completed
 * geometry action. Completing saves the document and replaces the control, so completing
 * after every press lost the presses that came while it saved.
 *
 * Returns `waiting` (nudges made, not yet completed) and `hold()`, which keeps them waiting
 * instead: Undo saves and undoes them itself, so the save cannot turn Undo off mid-click.
 */
export function arrowKeyGesture(handle, { update, completed }) {
  const held = new Set();
  let resting = 0,
    waiting = false,
    holding = false;
  const stop = () => {
    clearTimeout(resting);
    resting = 0;
  };
  /** Complete the nudges at once: another key, or the focus leaving, acts on them as saved. */
  const flush = () => {
    stop();
    if (!waiting) return;
    waiting = holding = false;
    completed();
  };
  handle.addEventListener('keydown', (e) => {
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[e.key];
    if (!direction || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) {
      // Delete takes the moved text away as it is (the pending save then finds it gone);
      // saving the move first would leave the key to the saved text's locked controls.
      if (!['Shift', 'Control', 'Alt', 'Meta', 'Delete', 'Backspace'].includes(e.key)) flush();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (update(direction, e.shiftKey ? 10 : 1) !== false) {
      held.add(e.key);
      waiting = true;
      holding = false;
      stop();
    }
  });
  handle.addEventListener('keyup', (e) => {
    if (!held.delete(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (held.size || holding) return;
    stop();
    resting = setTimeout(flush, REST);
  });
  // A key released outside the control must not leave the action pending indefinitely.
  handle.addEventListener('blur', () => {
    held.clear();
    if (!holding) flush();
  });
  return {
    get waiting() {
      return waiting;
    },
    hold() {
      if (!waiting) return;
      holding = true;
      stop();
    },
  };
}
