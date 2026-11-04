import { el } from './lib/ui.js';

/**
 * The page overlay of Prepare a form: every field on the page as a labelled box that can be
 * selected, dragged, resized by its corner, opened for its properties (double-click or
 * Enter), and deleted (Delete). The editor turns the gestures into document edits.
 *
 * callbacks: { onMove(field, rect), onOpen(field), onDelete(field), onSelect(field) }
 * Rectangles handed out are in PDF user space { x, y, width, height }.
 */
const TYPE_LABELS = {
  text: 'Text field',
  date: 'Date field',
  checkbox: 'Check box',
  radio: 'Radio button',
  dropdown: 'Dropdown',
  listbox: 'List box',
  button: 'Button',
  signature: 'Signature field',
};
export const fieldTypeLabel = (type) => TYPE_LABELS[type] || 'Field';
/** Where a box of `size` may start within low..high, or at least no further out than `origin`. */
const span = (start, size, origin, low, high) =>
  Math.min(Math.max(start, Math.min(low, origin)), Math.max(high - size, origin));

export function createFormDesigner({ onMove, onOpen, onDelete, onSelect }) {
  const root = el('div', { class: 'form-designer', hidden: true });
  let viewport = null;
  let fields = [];
  let selected = null; // `${name}#${widgetIndex}`
  let drag = null;
  // The box to focus once the fields are redrawn after a keyboard action: the field nudged or
  // edited, or after a deletion its neighbor, so the focus does not fall back to the page.
  let refocus = null,
    // The field whose action set it: the focus may come back there first (a dialog closing).
    refocusFrom = null;
  const keyOf = (field) => `${field.name}#${field.widgetIndex}`;

  /** The field's box on screen, from its PDF rectangle. */
  function screenBox(field) {
    const { x, y, width, height } = field.rect;
    const [x1, y1] = viewport.convertToViewportPoint(x, y);
    const [x2, y2] = viewport.convertToViewportPoint(x + width, y + height);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }
  /** A screen box back in PDF user space. */
  function pdfRect(box) {
    const [ax, ay] = viewport.convertToPdfPoint(box.left, box.top);
    const [bx, by] = viewport.convertToPdfPoint(box.left + box.width, box.top + box.height);
    return {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
    };
  }

  /**
   * Keep a moved or resized box on the page, so a field cannot be dropped where nobody can
   * see or reach it; a box already partly off the page may stay where it was.
   */
  function onPage(box, from) {
    const width = Math.min(box.width, Math.max(viewport.width - box.left, from.width)),
      height = Math.min(box.height, Math.max(viewport.height - box.top, from.height));
    return {
      left: span(box.left, width, from.left, 0, viewport.width),
      top: span(box.top, height, from.top, 0, viewport.height),
      width,
      height,
    };
  }

  /** The smallest box a field can have, on screen: 4 points, and big enough to grab. */
  function smallest() {
    const [ox, oy] = viewport.convertToViewportPoint(0, 0);
    const [px, py] = viewport.convertToViewportPoint(1, 0);
    return Math.max(8, 4.01 * Math.hypot(px - ox, py - oy));
  }

  function place(node, box) {
    Object.assign(node.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
  }

  function select(field, focus = false) {
    selected = field ? keyOf(field) : null;
    root.querySelectorAll('.designer-field').forEach((node) => {
      const on = node.dataset.key === selected;
      node.classList.toggle('is-selected', on);
      node.setAttribute('aria-pressed', String(on));
      if (on && focus) node.focus({ preventScroll: true });
    });
    onSelect?.(field || null);
  }

  function startDrag(e, field, node, mode) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    refocus = null;
    select(field);
    const box = screenBox(field);
    drag = { field, node, mode, x: e.clientX, y: e.clientY, box, moved: false, id: e.pointerId };
    node.setPointerCapture(e.pointerId);
    window.addEventListener('keydown', escapeDrag, true);
  }
  /** Escape, or a cancelled pointer, puts the box back where it was, with nothing changed. */
  function cancelDrag(e) {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    const done = drag;
    drag = null;
    window.removeEventListener('keydown', escapeDrag, true);
    place(done.node, done.box);
    if (done.node.hasPointerCapture(done.id)) done.node.releasePointerCapture(done.id);
  }
  function escapeDrag(e) {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    cancelDrag(e);
  }
  function moveDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    const box = onPage(
      drag.mode === 'move'
        ? { ...drag.box, left: drag.box.left + dx, top: drag.box.top + dy }
        : {
            ...drag.box,
            width: Math.max(smallest(), drag.box.width + dx),
            height: Math.max(smallest(), drag.box.height + dy),
          },
      drag.box,
    );
    drag.current = box;
    place(drag.node, box);
  }
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const done = drag;
    drag = null;
    window.removeEventListener('keydown', escapeDrag, true);
    if (done.moved && done.current) onMove(done.field, pdfRect(done.current));
  }

  /** The focus goes on to the field's neighbor once the field is deleted and the boxes redrawn. */
  function deleting(field) {
    const index = fields.findIndex((entry) => keyOf(entry) === keyOf(field));
    if (index < 0) return;
    const neighbor = fields[index + 1] ?? fields[index - 1];
    // The buttons after a deleted one in its group move up a place.
    refocus = !neighbor
      ? null
      : neighbor.name === field.name && neighbor.widgetIndex > field.widgetIndex
        ? `${neighbor.name}#${neighbor.widgetIndex - 1}`
        : keyOf(neighbor);
    refocusFrom = keyOf(field);
  }

  function render(next, nextViewport) {
    fields = next;
    viewport = nextViewport;
    root.replaceChildren(
      ...fields.map((field) => {
        // The buttons of a radio group share its name; their export values tell them apart.
        const option =
          field.type === 'radio' && field.props?.exportValue ? `: ${field.props.exportValue}` : '';
        const node = el(
          'button',
          {
            type: 'button',
            class: `designer-field type-${field.type}`,
            'data-key': keyOf(field),
            'aria-label': `${fieldTypeLabel(field.type)} ${field.name}${option}`,
            'aria-pressed': String(keyOf(field) === selected),
            title: `${field.name}${option} (${fieldTypeLabel(field.type)}). Double-click for properties.`,
            onpointerdown: (e) => startDrag(e, field, node, 'move'),
            onpointermove: moveDrag,
            onpointerup: endDrag,
            onpointercancel: cancelDrag,
            ondblclick: () => onOpen(field),
            onkeydown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                refocus = refocusFrom = keyOf(field);
                onOpen(field);
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                deleting(field);
                onDelete(field);
              } else if (e.key.startsWith('Arrow') && !e.altKey && !e.ctrlKey && !e.metaKey) {
                // Arrow keys nudge a point at a time in the direction they point on screen,
                // also on turned pages; Shift moves ten. Alt with an arrow turns the page.
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                const { x, y, width, height } = field.rect;
                const sx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0,
                  sy = { ArrowUp: -1, ArrowDown: 1 }[e.key] || 0;
                const [ox, oy] = viewport.convertToPdfPoint(0, 0);
                const [px, py] = viewport.convertToPdfPoint(sx, sy);
                const length = Math.hypot(px - ox, py - oy) || 1;
                const dx = Math.round(((px - ox) / length) * step * 1000) / 1000,
                  dy = Math.round(((py - oy) / length) * step * 1000) / 1000;
                // Up to the edge of the page, and no further.
                const page = pdfRect({
                  left: 0,
                  top: 0,
                  width: viewport.width,
                  height: viewport.height,
                });
                const next = {
                  x: span(x + dx, width, x, page.x, page.x + page.width),
                  y: span(y + dy, height, y, page.y, page.y + page.height),
                  width,
                  height,
                };
                if (next.x === x && next.y === y) return;
                refocus = refocusFrom = keyOf(field);
                onMove(field, next);
              }
            },
            onfocus: () => {
              // Moving on to another field drops a pending return of the focus elsewhere.
              if (refocus && ![refocus, refocusFrom].includes(keyOf(field))) refocus = null;
              select(field);
            },
          },
          el('span', { class: 'designer-name' }, field.name),
          el('span', {
            class: 'designer-resize',
            'aria-hidden': 'true',
            onpointerdown: (e) => startDrag(e, field, node, 'resize'),
          }),
        );
        place(node, screenBox(field));
        if (keyOf(field) === selected) node.classList.add('is-selected');
        return node;
      }),
    );
    const active = document.activeElement;
    if (refocus && (active === document.body || !active || root.contains(active))) {
      root.querySelector(`[data-key="${CSS.escape(refocus)}"]`)?.focus({ preventScroll: true });
      refocus = null;
    }
  }

  return {
    root,
    render,
    setEnabled(on) {
      root.hidden = !on;
      if (!on) select(null);
    },
    get selected() {
      return fields.find((field) => keyOf(field) === selected) || null;
    },
    /**
     * A field took another name: its box keeps the selection and gets the pending focus. A
     * radio button that joined another group gives its place in that group (`widgetIndex`).
     */
    renamed(from, to, widgetIndex) {
      const swap = (key) =>
        key?.startsWith(`${from}#`) ? `${to}#${widgetIndex ?? key.slice(from.length + 1)}` : key;
      refocus = swap(refocus);
      selected = swap(selected);
    },
    deleting,
    /** The field's width and height as the page shows them, in its own units, or null. */
    shownSize(field) {
      if (!viewport || !field.rect) return null;
      const { width, height } = field.rect;
      return viewport.rotation % 180 ? { width: height, height: width } : { width, height };
    },
    /** The field's rectangle at `size` as shown, its top left corner on screen staying put. */
    resizedRect(field, { width, height }) {
      const box = screenBox(field);
      const [ox, oy] = viewport.convertToViewportPoint(0, 0);
      const [px, py] = viewport.convertToViewportPoint(1, 0);
      const unit = Math.hypot(px - ox, py - oy);
      return pdfRect({ left: box.left, top: box.top, width: width * unit, height: height * unit });
    },
    focusField(name) {
      const field = fields.find((entry) => entry.name === name);
      if (field) select(field, true);
    },
  };
}
