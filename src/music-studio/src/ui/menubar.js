// Menu bar (ARIA menubar). Top-level items open drop-downs built from the
// menu spec in commands/menus.js; with a menu open, Left and Right move to
// the neighbouring menu and hovering another title switches to it. On phones
// the bar collapses into one button that lists every menu as a submenu.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { openMenu, closeMenus } from './menu.js';
import { MENUS, buildMenuItems } from '../commands/menus.js';

export function createMenubar(app) {
  const el = h('nav.menubar', { 'aria-label': 'Main menu' });
  const list = h('div.menubar-list', { role: 'menubar', 'aria-label': 'Main menu' });
  const compact = h('button.icon-btn.menubar-compact', { type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'menu', title: 'Menu' }, icon('menu', 18));
  el.append(compact, list);
  let openIndex = -1;
  let current = null;
  let returnTo = null; // focus before F10, restored by Escape

  const buttons = MENUS.map((m, i) => {
    const b = h('button.menubar-item', { type: 'button', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: i === 0 ? '0' : '-1' }, m.label);
    b.addEventListener('click', () => (openIndex === i ? closeMenus() : open(i, false)));
    b.addEventListener('pointerenter', () => {
      if (openIndex >= 0 && openIndex !== i) open(i, false);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(i, true);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const n = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[n].focus();
        buttons.forEach((x, j) => (x.tabIndex = j === n ? 0 : -1));
      } else if (e.key === 'Escape' && openIndex < 0) {
        // Leave the menu bar: back to where F10 came from.
        e.preventDefault();
        const back = returnTo?.isConnected && !el.contains(returnTo) ? returnTo : null;
        returnTo = null;
        if (back) back.focus();
        else app.shell?.focus?.(app.activePanel);
      }
    });
    list.append(b);
    return b;
  });

  function open(i, byKeyboard) {
    const b = buttons[i];
    closeMenus();
    openIndex = i;
    buttons.forEach((x, j) => {
      x.setAttribute('aria-expanded', String(j === i));
      x.tabIndex = j === i ? 0 : -1;
    });
    current = openMenu(buildMenuItems(app, MENUS[i].items), {
      anchor: b,
      label: MENUS[i].label,
      focusFirst: byKeyboard,
      onClose: (kb) => {
        b.setAttribute('aria-expanded', 'false');
        if (openIndex === i) openIndex = -1;
        if (kb) b.focus();
      },
    });
    current.onArrow = (dir) => {
      const n = (i + dir + buttons.length) % buttons.length;
      open(n, true);
    };
  }

  compact.addEventListener('click', () => {
    openMenu(
      MENUS.map((m) => ({ type: 'submenu', label: m.label, items: () => buildMenuItems(app, m.items) })),
      { anchor: compact, label: 'Menu' },
    );
  });

  return {
    el,
    /** Focuses the first menu title (F10 / Alt, like desktop apps). */
    focus() {
      if (!el.contains(document.activeElement)) returnTo = document.activeElement;
      // On phones the titles are collapsed into the menu button.
      if (compact.offsetParent && !buttons[0].offsetParent) compact.focus();
      else buttons[0].focus();
    },
    open,
  };
}
