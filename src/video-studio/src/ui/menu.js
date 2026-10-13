/**
 * Accessible popup menus (menu button pattern) and context menus.
 *
 * items: [{ label, icon?, shortcut?, onSelect, disabled?, checked?, danger?, submenu? } | 'separator' | { heading }]
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { shortcutLabel } from '../lib/platform.js';

let openMenu = null;

export function closeMenus() {
  if (openMenu) openMenu.close();
}

function position(menu, anchorRect, { align = 'start', side = 'bottom' } = {}) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const r = menu.getBoundingClientRect();
  let x = align === 'end' ? anchorRect.right - r.width : anchorRect.left;
  let y = side === 'top' ? anchorRect.top - r.height - 4 : side === 'right' ? anchorRect.top - 4 : anchorRect.bottom + 4;
  if (side === 'right') x = anchorRect.right + 2;
  if (x + r.width > vw - 8) x = side === 'right' ? anchorRect.left - r.width - 2 : vw - r.width - 8;
  if (y + r.height > vh - 8) y = Math.max(8, side === 'bottom' ? anchorRect.top - r.height - 4 : vh - r.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  menu.style.visibility = '';
}

/**
 * Show a menu. anchor is an element (menu button) or a {x, y} point.
 * Returns a handle with close().
 */
export function showMenu(anchor, items, opts = {}) {
  if (openMenu && !opts.nested) openMenu.close();
  const menu = h('div.menu', { role: 'menu', tabindex: '-1', 'aria-label': opts.label || null });
  const entries = [];
  let child = null;
  const handle = {
    el: menu,
    close(returnFocus = true) {
      child?.close(false);
      menu.remove();
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'false');
      if (openMenu === handle) openMenu = null;
      if (returnFocus && anchor instanceof Element && document.contains(anchor)) anchor.focus({ preventScroll: true });
      opts.onClose?.();
    },
  };
  for (const it of items) {
    if (!it) continue;
    if (it === 'separator') {
      menu.append(h('div.menu-sep', { role: 'separator' }));
      continue;
    }
    if (it.heading) {
      menu.append(h('div.menu-heading', { role: 'presentation' }, it.heading));
      continue;
    }
    const role = it.checked === undefined ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox';
    const btn = h(
      `button.menu-item${it.danger ? '.danger' : ''}`,
      {
        type: 'button',
        role,
        tabindex: '-1',
        disabled: it.disabled,
        'aria-disabled': it.disabled ? 'true' : null,
        'aria-checked': it.checked === undefined ? null : String(Boolean(it.checked)),
        'aria-haspopup': it.submenu ? 'menu' : null,
        'aria-expanded': it.submenu ? 'false' : null,
      },
      h('span.menu-check', it.checked ? icon('check', 14) : null),
      it.swatch ? h('span.menu-swatch', { style: { background: it.swatch } }) : it.icon ? icon(it.icon, 16) : null,
      h('span.menu-label', it.label),
      it.shortcut ? h('span.menu-shortcut', shortcutLabel(it.shortcut)) : it.hint ? h('span.menu-shortcut', it.hint) : null,
      it.submenu ? icon('chevronRight', 14, 'menu-sub-arrow') : null,
    );
    const openSub = () => {
      child?.close(false);
      const rect = btn.getBoundingClientRect();
      child = showMenu(rect, typeof it.submenu === 'function' ? it.submenu() : it.submenu, { nested: true, side: 'right', label: it.label, onClose: () => btn.setAttribute('aria-expanded', 'false'), parent: handle });
      btn.setAttribute('aria-expanded', 'true');
      return child;
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      if (it.submenu) {
        openSub().focusFirst();
        return;
      }
      let root = handle;
      while (root.parent) root = root.parent;
      root.close(it.keepFocus !== false && !opts.noReturnFocus);
      it.onSelect?.();
    });
    btn.addEventListener('pointerenter', () => {
      btn.focus({ preventScroll: true });
      if (it.submenu && !it.disabled) openSub();
      else if (child) {
        child.close(false);
        child = null;
      }
    });
    entries.push({ btn, it, openSub });
    menu.append(btn);
  }
  handle.parent = opts.parent || null;
  const focusables = () => entries.filter((e) => !e.it.disabled).map((e) => e.btn);
  handle.focusFirst = () => focusables()[0]?.focus({ preventScroll: true });
  menu.addEventListener('keydown', (e) => {
    const list = focusables();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handle.close(true);
      if (handle.parent) handle.parent.focusFirst?.();
    } else if (e.key === 'ArrowRight') {
      const entry = entries.find((x) => x.btn === document.activeElement);
      if (entry?.it.submenu) {
        e.preventDefault();
        entry.openSub().focusFirst();
      }
    } else if (e.key === 'ArrowLeft' && handle.parent) {
      e.preventDefault();
      handle.close(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      let root = handle;
      while (root.parent) root = root.parent;
      root.close(true);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      const start = i + 1;
      for (let k = 0; k < list.length; k++) {
        const b = list[(start + k) % list.length];
        if (b.textContent.trim().toLowerCase().startsWith(ch)) {
          b.focus();
          break;
        }
      }
    }
  });
  document.body.append(menu);
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor.getBoundingClientRect ? anchor : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  position(menu, rect, opts);
  if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'true');
  const onOutside = (e) => {
    if (menu.contains(e.target) || (anchor instanceof Element && anchor.contains(e.target))) return;
    let p = handle;
    while (p.parent) p = p.parent;
    let inChain = false;
    for (let m = child; m; m = null) if (m.el.contains(e.target)) inChain = true;
    if (inChain) return;
    if (opts.nested) return;
    handle.close(false);
  };
  const onBlur = () => {
    if (!opts.nested) handle.close(false);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
  });
  if (!opts.nested) openMenu = handle;
  if (opts.focus !== false) requestAnimationFrame(() => handle.focusFirst());
  return handle;
}

/** Wire a button as a menu button: click/Enter/Space/ArrowDown open the menu. */
export function menuButton(button, getItems, opts = {}) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  let handle = null;
  const open = () => {
    if (handle && document.contains(handle.el)) {
      handle.close();
      handle = null;
      return;
    }
    handle = showMenu(button, getItems(), { ...opts, onClose: () => (handle = null) });
  };
  button.addEventListener('click', open);
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!handle) open();
    }
  });
  return button;
}
