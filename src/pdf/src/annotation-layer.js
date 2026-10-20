import { el } from './lib/ui.js';
import { annotationAccepts } from './core/annotations.js';

/**
 * Comments drawn as annotations (text boxes, callouts, shapes, pencil drawings, stamps) as
 * targets over the page in Select: a click selects one, a drag moves it, Delete removes it.
 * The editor shows the selected one's settings in the properties panel and turns the
 * gestures into edits.
 *
 * callbacks: { onSelect(entry | null, { refresh }), onMove(entry, rect), onDelete(entry) }; a
 * refresh is the selected comment redrawn after an edit rather than a new choice.
 */
export const ANNOTATION_KINDS = new Set([
  'FreeText',
  'Square',
  'Circle',
  'Line',
  'Polygon',
  'PolyLine',
  'Ink',
  'Stamp',
  'Caret',
  'FileAttachment',
  'Squiggly',
]);
/** Whether a comment can be dragged or nudged: a squiggly underline stays on its words. */
const movable = (entry) =>
  !entry.locked && !entry.readOnly && annotationAccepts(entry.subtype, 'rect');

export function createAnnotationLayer({ onSelect, onMove, onDelete }) {
  const root = el('div', { class: 'annotation-targets' });
  let viewport = null,
    entries = [],
    selected = null,
    drag = null;

  function screenBox({ x, y, width, height }) {
    const [x1, y1] = viewport.convertToViewportPoint(x, y);
    const [x2, y2] = viewport.convertToViewportPoint(x + width, y + height);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.max(6, Math.abs(x2 - x1)),
      height: Math.max(6, Math.abs(y2 - y1)),
    };
  }
  /** A screen offset as a PDF offset, for any page rotation. */
  function pdfOffset(dx, dy) {
    const [ax, ay] = viewport.convertToPdfPoint(0, 0);
    const [bx, by] = viewport.convertToPdfPoint(dx, dy);
    return [bx - ax, by - ay];
  }
  const place = (node, box) =>
    Object.assign(node.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });

  function select(entry, focus = false) {
    selected = entry?.id ?? null;
    root.querySelectorAll('.annotation-target').forEach((node) => {
      const on = node.dataset.id === selected;
      node.classList.toggle('is-selected', on);
      node.setAttribute('aria-pressed', String(on));
      if (on && focus) node.focus({ preventScroll: true });
    });
    onSelect(entry || null);
  }

  function render(next, nextViewport) {
    entries = next;
    viewport = nextViewport;
    const kept = selected && entries.find((entry) => entry.id === selected);
    if (selected && !kept) select(null);
    // An edited comment is redrawn: its settings follow the new version.
    else if (kept) onSelect(kept, { refresh: true });
    // Redrawing replaces the targets; the selected one keeps the keyboard focus it had, so
    // arrow keys and Delete go on working after a nudge or a move.
    const refocus = kept && root.contains(document.activeElement);
    root.replaceChildren(
      ...entries.map((entry) => {
        const node = el('button', {
          type: 'button',
          class: 'annotation-target',
          'data-id': entry.id,
          'aria-pressed': String(entry.id === selected),
          'aria-label': `${entry.kind}${entry.contents ? `: ${entry.contents.slice(0, 60)}` : ''}`,
          title: entry.contents || entry.kind,
          onpointerdown: (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            if (selected !== entry.id) select(entry);
            // Preventing the default also prevents focus; the selected comment takes it, as
            // a desktop editor's does, for the arrow keys, Delete, and Escape.
            node.focus({ preventScroll: true });
            if (!movable(entry)) return;
            drag = { entry, node, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
            node.setPointerCapture(e.pointerId);
          },
          onpointermove: (e) => {
            if (!drag || drag.id !== e.pointerId) return;
            const dx = e.clientX - drag.x,
              dy = e.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < 3) return;
            drag.moved = true;
            drag.dx = dx;
            drag.dy = dy;
            node.style.transform = `translate(${dx}px, ${dy}px)`;
          },
          onpointerup: (e) => {
            if (!drag || drag.id !== e.pointerId) return;
            const done = drag;
            drag = null;
            if (!done.moved) return;
            const [ox, oy] = pdfOffset(done.dx, done.dy);
            const { x, y, width, height } = done.entry.rect;
            onMove(done.entry, { x: x + ox, y: y + oy, width, height });
          },
          onpointercancel: () => {
            if (drag) drag.node.style.transform = '';
            drag = null;
          },
          onkeydown: (e) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              onDelete(entry);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              select(null);
            } else if (e.key.startsWith('Arrow') && movable(entry)) {
              e.preventDefault();
              const step = e.shiftKey ? 10 : 1;
              const dx = { ArrowLeft: -step, ArrowRight: step }[e.key] || 0,
                dy = { ArrowUp: -step, ArrowDown: step }[e.key] || 0;
              const [ox, oy] = pdfOffset(dx, dy);
              const { x, y, width, height } = entry.rect;
              onMove(entry, { x: x + ox, y: y + oy, width, height });
            }
          },
          onfocus: () => {
            if (selected !== entry.id) select(entry);
          },
        });
        place(node, screenBox(entry.rect));
        // Only a comment that can move offers the move pointer.
        if (!movable(entry)) node.style.cursor = 'pointer';
        if (entry.id === selected) node.classList.add('is-selected');
        return node;
      }),
    );
    if (refocus)
      [...root.children]
        .find((node) => node.dataset.id === selected)
        ?.focus({ preventScroll: true });
  }

  return {
    root,
    render,
    setEnabled(on) {
      root.hidden = !on;
      if (!on && selected) select(null);
    },
    get selected() {
      return entries.find((entry) => entry.id === selected) || null;
    },
    clear() {
      if (selected) select(null);
    },
    focus(id) {
      const entry = entries.find((item) => item.id === id);
      if (entry) select(entry, true);
    },
  };
}
