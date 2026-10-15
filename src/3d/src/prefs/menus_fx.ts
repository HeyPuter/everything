// Menu preferences: pie menu geometry and timing, submenu delay, Python tooltips, and
// opening menu-bar menus by resting the pointer on them.
import { anyPopupOpen, menuSettings } from '../ui/menu';
import { prefs } from '../app/prefs';
import { onPrefsApply } from './store';

onPrefsApply((p) => {
  menuSettings.pieRadius = Math.max(40, Math.min(300, p.pie_menu_radius));
  menuSettings.pieThreshold = Math.max(2, Math.min(200, p.pie_menu_threshold));
  menuSettings.pieConfirm = p.pie_menu_confirm > 0 ? Math.max(menuSettings.pieThreshold + 1, p.pie_menu_confirm) : 0;
  menuSettings.pieTapTimeout = Math.max(0, p.pie_tap_timeout);
  menuSettings.pieAnimation = p.use_reduce_motion ? 0 : Math.max(0, p.pie_animation_timeout);
  menuSettings.submenuDelay = Math.max(0, p.open_sublevel_delay);
  menuSettings.pythonTips = p.show_tooltips_python;
});

/** Menu-bar buttons that open a menu on press. */
const MENU_BAR = '.hdr-menu, .tb-menu';
let hoverTimer = 0;

if (typeof document !== 'undefined')
  document.addEventListener(
    'pointerover',
    (e) => {
      clearTimeout(hoverTimer);
      if (!prefs.use_mouse_over_open || e.pointerType === 'touch') return;
      const el = (e.target as HTMLElement).closest?.(MENU_BAR) as HTMLElement | null;
      if (!el || el.classList.contains('menu-open') || anyPopupOpen()) return;
      const { clientX, clientY } = e;
      hoverTimer = window.setTimeout(() => {
        if (!el.isConnected || !el.matches(':hover') || anyPopupOpen()) return;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 0, clientX, clientY, pointerType: 'mouse' }));
      }, Math.max(0, prefs.open_toplevel_delay));
    },
    true,
  );
