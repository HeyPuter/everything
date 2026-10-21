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
  }
  function moveDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    const box =
      drag.mode === 'move'
        ? { ...drag.box, left: drag.box.left + dx, top: drag.box.top + dy }
        : {
            ...drag.box,
            width: Math.max(8, drag.box.width + dx),
            height: Math.max(8, drag.box.height + dy),
          };
    drag.current = box;
    place(drag.node, box);
  }
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const done = drag;
    drag = null;
    if (done.moved && done.current) onMove(done.field, pdfRect(done.current));
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
            onpointercancel: endDrag,
            ondblclick: () => onOpen(field),
            onkeydown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                refocus = refocusFrom = keyOf(field);
                onOpen(field);
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                const index = fields.indexOf(field);
                const neighbor = fields[index + 1] ?? fields[index - 1];
                refocus = neighbor ? keyOf(neighbor) : null;
                refocusFrom = keyOf(field);
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
                refocus = refocusFrom = keyOf(field);
                onMove(field, { x: x + dx, y: y + dy, width, height });
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
    focusField(name) {
      const field = fields.find((entry) => entry.name === name);
      if (field) select(field, true);
    },
  };
}
