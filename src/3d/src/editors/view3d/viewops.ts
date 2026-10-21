// 3D View operators: MatCap flip, mode pie-or-toggle, centring a locked view, and the
// interactive Rotate / Pan view operators (for keymaps and scripts; the mouse buttons are
// handled by the viewport itself).
import { app, registerOperators } from '../../app/app';
import { keymaps } from '../../app/keymap';
import { prefs } from '../../app/prefs';
import { renderContext } from '../../render/context';
import { modePie } from '../../app/keys';
import { activeView3D, type View3D } from './view3d';
import { availableModes } from './header';

const v3d = () => !!activeView3D();

function redraw(v: View3D) {
  renderContext?.engine.requestDraw();
  v.afterNav();
  app.changed('view');
}

/** Drag the view with the mouse until a button is released (or a click / Enter); Esc / RMB restore it. */
function viewDrag(kind: 'ROTATE' | 'PAN', label: string) {
  const v = activeView3D()!;
  v.leaveCamera();
  const nav = v.nav;
  const before = { pivot: nav.pivot.clone(), rot: nav.rot.clone(), distance: nav.distance, view: nav.view };
  let last: { x: number; y: number } | null = null;
  const speed = 0.0075 * (Math.max(0.05, prefs.view_rotate_sensitivity) / 0.43);
  app.startModal({
    label,
    header: () => (kind === 'ROTATE' ? 'Rotate View: move the mouse · release / LMB / Enter to confirm · RMB / Esc to cancel' : 'Pan View: move the mouse · release / LMB / Enter to confirm · RMB / Esc to cancel'),
    onPointerMove(e) {
      if (!last) {
        last = { x: e.clientX, y: e.clientY };
        return;
      }
      const dx = e.clientX - last.x,
        dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (kind === 'PAN' || v.lockRotation) nav.pan(dx, dy);
      else nav.orbit(dx * speed, dy * speed);
      v.afterNav();
    },
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : e.button === 0 ? 'FINISHED' : undefined),
    onPointerUp: (e) => (e.button === 1 || e.button === 0 ? 'FINISHED' : undefined),
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      return true;
    },
    cancel() {
      nav.pivot.copy(before.pivot);
      nav.rot.copy(before.rot);
      nav.distance = before.distance;
      nav.view = before.view;
      redraw(v);
    },
  });
  return 'RUNNING_MODAL' as const;
}

registerOperators([
  {
    idname: 'view3d.toggle_matcap_flip',
    label: 'Flip MatCap',
    description: 'Mirror the MatCap of this viewport left to right',
    undo: false,
    poll: () => !!activeView3D() && activeView3D()!.shading.type === 'SOLID' && activeView3D()!.shading.light === 'MATCAP',
    exec: () => {
      const v = activeView3D()!;
      v.shading.matcap_flip = !v.shading.matcap_flip;
      renderContext?.forceSync();
      renderContext?.engine.requestDraw();
      app.changed('ui', 'view');
    },
  },
  {
    idname: 'view3d.object_mode_pie_or_toggle',
    label: 'Object Mode Menu',
    description: 'Open the mode pie, or switch straight between Object and Edit Mode when those are the only modes',
    undo: false,
    poll: () => !!app.activeObject,
    invoke: () => {
      const modes = availableModes().map((m) => m.mode);
      if (modes.length > 2) {
        modePie();
        return 'CANCELLED';
      }
      if (modes.includes('EDIT')) return app.run('object.mode_set', { mode: 'EDIT', toggle: true }) === 'FINISHED' ? 'FINISHED' : 'CANCELLED';
      return 'CANCELLED';
    },
  },
  {
    idname: 'view3d.view_center_lock',
    label: 'View Lock Center',
    description: 'Center a locked view on its lock target again (removes the panning offset)',
    undo: false,
    poll: () => {
      const v = activeView3D();
      return !!v && !v.cameraView && (!!v.lockObject || v.lockCursor);
    },
    exec: () => {
      const v = activeView3D()!;
      v.lockOffset.set(0, 0, 0);
      const at = v.lockTarget();
      if (at) v.nav.pivot.copy(at);
      redraw(v);
    },
  },
  {
    idname: 'view3d.rotate',
    label: 'Rotate View',
    description: 'Orbit the view with the mouse',
    undo: false,
    poll: v3d,
    props: [{ id: 'use_cursor_init', label: 'Use Mouse Position', type: 'bool', default: true, hidden: true }],
    invoke: () => viewDrag('ROTATE', 'Rotate View'),
  },
  {
    idname: 'view3d.move',
    label: 'Pan View',
    description: 'Move the view with the mouse',
    undo: false,
    poll: v3d,
    props: [{ id: 'use_cursor_init', label: 'Use Mouse Position', type: 'bool', default: true, hidden: true }],
    invoke: () => viewDrag('PAN', 'Pan View'),
  },
]);

// Home in a locked view centres it on the lock target (before the generic Frame All binding)
(keymaps['3D View'] ??= []).unshift({ key: 'HOME', op: 'view3d.view_center_lock', when: () => !!activeView3D() && !activeView3D()!.cameraView && (!!activeView3D()!.lockObject || activeView3D()!.lockCursor) });
