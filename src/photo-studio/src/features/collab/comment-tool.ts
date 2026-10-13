// Comment tool: click to pin a comment to a point, drag to comment on a
// region, click a pin to open its thread, drag a pin to move it.
import type { Editor } from '../../editor';
import type { Tool } from '../../app/registry';
import { normalizeAnchor } from '../../collab/comments';
import { commentsOf, threadAt, view } from './state';
import { focusComposer, revealThread } from './comments-panel';

type Drag = { kind: 'region'; x0: number; y0: number } | { kind: 'move'; id: string; dx: number; dy: number; x: number; y: number; moved: boolean };
let drag: Drag | undefined;

function showPanel(e: Editor) {
  if (!e.dock.isVisible('comments')) e.dock.show('comments');
}

export const commentTool: Tool = {
  id: 'comment',
  label: 'Comment Tool',
  key: 'I',
  icon: 'comment',
  group: 'eyedropper',
  cursor: () => 'crosshair',
  options: () =>
    `<span class="option-hint">Click to pin a comment, drag to comment on a region, drag a pin to move it.</span><span class="divider"></span><button data-command="view.show-comments">${view.hidden ? 'Show' : 'Hide'} Comments</button><button data-command="window.panel.comments">Comments Panel</button>`,
  pointerDown: (e, p) => {
    const store = commentsOf(e);
    const hit = threadAt(e, p.x, p.y);
    if (hit) {
      view.selected = hit.id;
      view.draft = null;
      showPanel(e);
      revealThread(e, hit.id, false);
      if (store.canComment()) drag = { kind: 'move', id: hit.id, dx: p.x - hit.anchor.x, dy: p.y - hit.anchor.y, x: hit.anchor.x, y: hit.anchor.y, moved: false };
      e.overlay();
      e.dock.update();
      return;
    }
    if (!store.canComment()) {
      e.message('You can view this document but not comment on it.');
      return;
    }
    if (p.x < 0 || p.y < 0 || p.x > e.doc.width || p.y > e.doc.height) return;
    drag = { kind: 'region', x0: p.x, y0: p.y };
    view.draft = null;
    view.dragging = { x: p.x, y: p.y, width: 0, height: 0 };
    e.overlay();
  },
  pointerMove: (e, p) => {
    if (!drag) return;
    if (drag.kind === 'region') {
      const x = Math.max(0, Math.min(e.doc.width, p.x)),
        y = Math.max(0, Math.min(e.doc.height, p.y));
      view.dragging = { x: Math.min(drag.x0, x), y: Math.min(drag.y0, y), width: Math.abs(x - drag.x0), height: Math.abs(y - drag.y0) };
    } else {
      drag.x = Math.round(p.x - drag.dx);
      drag.y = Math.round(p.y - drag.dy);
      drag.moved = true;
      const t = commentsOf(e).threads().find((x) => x.id === (drag as { id: string }).id);
      if (t) view.dragging = { ...t.anchor, x: drag.x, y: drag.y, width: t.anchor.width ?? 0, height: t.anchor.height ?? 0 };
    }
    e.overlay();
  },
  pointerUp: (e) => {
    const d = drag;
    drag = undefined;
    const rect = view.dragging;
    view.dragging = null;
    if (!d || !rect) return e.overlay();
    if (d.kind === 'move') {
      if (d.moved) {
        const t = commentsOf(e).threads().find((x) => x.id === d.id);
        if (t) {
          const x = Math.max(0, Math.min(e.doc.width, d.x)),
            y = Math.max(0, Math.min(e.doc.height, d.y));
          commentsOf(e).move(d.id, { ...t.anchor, x, y });
        }
      }
      return e.overlay();
    }
    // A short drag is a click: a point comment.
    view.draft = normalizeAnchor(rect.width >= 4 && rect.height >= 4 ? rect : { x: d.x0, y: d.y0 });
    view.selected = '';
    showPanel(e);
    e.overlay();
    e.dock.update();
    focusComposer(e);
  },
  keyDown: (e, ev) => {
    if (ev.key === 'Escape' && (view.draft || view.selected)) {
      view.draft = null;
      view.selected = '';
      e.overlay();
      e.dock.update();
      return true;
    }
    return false;
  },
  deactivate: (e) => {
    drag = undefined;
    view.dragging = null;
    e.overlay();
  },
};
