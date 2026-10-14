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
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[n].focus();
        buttons.forEach((x, j) => (x.tabIndex = j === n ? 0 : -1));
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
      buttons[0].focus();
    },
    open,
  };
}
