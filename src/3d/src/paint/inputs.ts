// Extra viewport mouse input of the paint modes: Shift+right-click sets the sculpt pivot on the
// surface under the pointer (instead of placing the 3D cursor).
import { app } from '../app/app';
import { viewportExtensions } from '../editors/view3d/hooks';

viewportExtensions.push((v) => {
  const down = (e: PointerEvent) => {
    if (e.defaultPrevented || e.button !== 2 || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || app.modal || app.doc.mode !== 'SCULPT') return;
    if (!app.poll('sculpt.set_pivot_position')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    app.run('sculpt.set_pivot_position', { mode: 'SURFACE' }, { event: { x: e.clientX, y: e.clientY }, area: v.area as never });
  };
  v.el.addEventListener('pointerdown', down, true);
  return () => v.el.removeEventListener('pointerdown', down, true);
});
