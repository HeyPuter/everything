// Render region from the Image Editor (Ctrl B / Ctrl Alt B over the Render Result) and closing
// the render view (Esc).
import { app, registerOperators } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { ImageEditor, RENDER_RESULT } from './imageeditor';
import { renderSize, regionFromImageRect } from './units';
import { isRenderWindowOpen, closeRenderWindow } from './renderwindow';

function hoveredEditor(): ImageEditor | null {
  const a = app.hoverArea ?? app.activeArea;
  const ed = a?.editor;
  return ed instanceof ImageEditor ? ed : null;
}

const overRenderResult = () => hoveredEditor()?.imageId === RENDER_RESULT;


registerOperators([
  {
    idname: 'image.render_border',
    label: 'Render Region',
    description: 'Drag a rectangle over the Render Result to render only that part of the image',
    undo: false,
    poll: () => overRenderResult(),
    invoke: () => {
      const ed = hoveredEditor();
      if (!ed) return 'CANCELLED';
      const rect = ed.el.getBoundingClientRect();
      let start: { x: number; y: number } | null = null;
      const box = document.createElement('div');
      Object.assign(box.style, { position: 'absolute', border: '1px dashed #dc5236', pointerEvents: 'none', display: 'none' });
      ed.el.append(box);
      app.startModal({
        label: 'Render Region',
        cursor: 'crosshair',
        header: () => 'Drag a rectangle to set the render region',
        onPointerDown(e) {
          if (e.button !== 0) return 'CANCELLED';
          start = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          return undefined;
        },
        onPointerMove(e) {
          if (!start) return;
          const x = e.clientX - rect.left,
            y = e.clientY - rect.top;
          Object.assign(box.style, { display: 'block', left: `${Math.min(x, start.x)}px`, top: `${Math.min(y, start.y)}px`, width: `${Math.abs(x - start.x)}px`, height: `${Math.abs(y - start.y)}px` });
        },
        onPointerUp(e) {
          if (!start) return undefined;
          const x = e.clientX - rect.left,
            y = e.clientY - rect.top;
          const size = ed.imageSize();
          const r = app.doc.scene.render;
          if (size && Math.abs(x - start.x) > 2 && Math.abs(y - start.y) > 2) {
            const [ax, ay] = ed.toImage(start.x, start.y);
            const [bx, by] = ed.toImage(x, y);
            const g = regionFromImageRect(ax, ay, bx, by, size[0], size[1], r, renderSize(r));
            r.border_min_x = g.min_x;
            r.border_max_x = g.max_x;
            r.border_min_y = g.min_y;
            r.border_max_y = g.max_y;
            r.use_border = g.max_x - g.min_x > 1e-4 && g.max_y - g.min_y > 1e-4;
            app.changed('doc');
            return 'FINISHED';
          }
          return 'CANCELLED';
        },
        onKey(e) {
          if (e.key === 'Escape') return 'CANCELLED';
          return undefined;
        },
        cancel: () => box.remove(),
        finish: () => box.remove(),
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'image.clear_render_border',
    label: 'Clear Render Region',
    description: 'Render the whole frame again',
    poll: () => !!app.doc.scene.render.use_border,
    exec: () => {
      const r = app.doc.scene.render;
      r.use_border = false;
      r.border_min_x = r.border_min_y = 0;
      r.border_max_x = r.border_max_y = 1;
      app.changed('doc');
    },
  },
  {
    idname: 'render.view_cancel',
    label: 'Cancel Render View',
    description: 'Close the render view',
    undo: false,
    poll: () => isRenderWindowOpen(),
    exec: () => {
      closeRenderWindow();
      return 'CANCELLED';
    },
  },
]);

addKeys('Image', [
  { key: 'B', ctrl: true, op: 'image.render_border', when: overRenderResult },
  { key: 'B', ctrl: true, alt: true, op: 'image.clear_render_border', when: overRenderResult },
]);
