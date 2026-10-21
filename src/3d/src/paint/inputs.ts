// Extra viewport mouse input of the paint modes: Shift+right-click sets the sculpt pivot on the
// surface under the pointer (instead of placing the 3D cursor); with a Hide tool, right-click shows
// everything again.
import { app } from '../app/app';
import { viewportExtensions } from '../editors/view3d/hooks';
import { activeTools } from '../app/prefs';

viewportExtensions.push((v) => {
  const down = (e: PointerEvent) => {
    if (e.defaultPrevented || e.button !== 2 || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || app.modal || app.doc.mode !== 'SCULPT') return;
    if (!app.poll('sculpt.set_pivot_position')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    app.run('sculpt.set_pivot_position', { mode: 'SURFACE' }, { event: { x: e.clientX, y: e.clientY }, area: v.area as never });
  };
  const hideTool = (e: PointerEvent) => {
    if (e.defaultPrevented || e.button !== 2 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || app.modal || app.doc.mode !== 'SCULPT') return;
    const tool = activeTools.SCULPT ?? '';
    if (!/^builtin\.(box|lasso|line|polyline)_hide$/.test(tool) || !app.poll('paint.hide_show_all')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    app.run('paint.hide_show_all', { action: 'SHOW' }, { area: v.area as never });
  };
  v.el.addEventListener('pointerdown', down, true);
  v.el.addEventListener('pointerdown', hideTool, true);
  return () => {
    v.el.removeEventListener('pointerdown', down, true);
    v.el.removeEventListener('pointerdown', hideTool, true);
  };
});
