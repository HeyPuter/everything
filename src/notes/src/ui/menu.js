import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { shortcutLabel } from '../lib/platform.js';

/*
 * Accessible popup menus (role="menu"), used for dropdowns, split buttons and
 * context menus. Items:
 *   { label, icon, shortcut, checked, radio, disabled, danger, run, submenu, swatch, hint }
 *   { type: 'sep' } | { type: 'header', label } | { type: 'custom', render(close) }
 *   { type: 'swatches', colors: [...], selected, label, run(color) }
 */

let openStack = [];

export function closeAllMenus() {
  while (openStack.length) openStack.pop().close(false);
}

export function isMenuOpen() {
  return openStack.length > 0;
}

/**
 * Opens a menu at an anchor element (below it) or a {x, y} point.
 * Returns a handle with close().
 */
export function openMenu(anchor, items, { label = 'Menu', onClose, align = 'start', returnFocus = true, parent = null, className = '' } = {}) {
  if (!parent) closeAllMenus();
  const previousFocus = document.activeElement;
  const menu = h(`div.menu${className ? '.' + className : ''}`, { role: 'menu', 'aria-label': label, tabindex: '-1' });
  const focusables = [];
  let submenu = null;
  let closed = false;

  const handle = {
    el: menu,
    close(restore = true) {
      if (closed) return;
      closed = true;
      submenu?.close(false);
      menu.remove();
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', blurClose);
      window.removeEventListener('resize', blurClose);
      openStack = openStack.filter((m) => m !== handle);
      if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'false');
      if (restore && returnFocus && previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      onClose?.();
    },
  };

  const run = (item) => {
    closeAllMenus();
    if (returnFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    item.run?.();
  };

  for (const item of items.filter(Boolean)) {
    if (item.hidden) continue;
    if (item.type === 'sep') {
      menu.append(h('div.menu-sep', { role: 'separator' }));
      continue;
    }
    if (item.type === 'header') {
      menu.append(h('div.menu-header', { role: 'presentation' }, item.label));
      continue;
    }
    if (item.type === 'custom') {
      menu.append(item.render(() => handle.close()));
      continue;
    }
    if (item.type === 'swatches') {
      const grid = h('div.menu-swatches', { role: 'group', 'aria-label': item.label || 'Colors' });
      for (const color of item.colors) {
        const value = typeof color === 'string' ? color : color.value;
        const name = typeof color === 'string' ? color : color.label;
        const sw = h('button.swatch', {
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': String(item.selected === value),
          'aria-label': name,
          title: name,
          tabindex: '-1',
          style: { '--swatch': value || 'transparent' },
          onclick: () => run({ run: () => item.run(value) }),
        });
        if (!value) sw.classList.add('none');
        grid.append(sw);
        focusables.push(sw);
      }
      menu.append(grid);
      continue;
    }
    const role = item.radio ? 'menuitemradio' : item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
    const btn = h('button.menu-item', {
      type: 'button',
      role,
      tabindex: '-1',
      'aria-disabled': item.disabled ? 'true' : null,
      'aria-checked': item.checked !== undefined ? String(Boolean(item.checked)) : null,
      'aria-haspopup': item.submenu ? 'menu' : null,
      'aria-expanded': item.submenu ? 'false' : null,
    });
    if (item.danger) btn.classList.add('danger');
    const lead = h('span.menu-lead');
    if (item.checked !== undefined && item.checked) lead.append(icon('check', 16));
    else if (item.swatch) lead.append(h('span.menu-swatch', { style: { '--swatch': item.swatch } }));
    else if (item.icon) lead.append(icon(item.icon, 16));
    btn.append(lead, h('span.menu-label', item.label));
    if (item.hint) btn.append(h('span.menu-hint', item.hint));
    if (item.shortcut) btn.append(h('span.menu-shortcut', shortcutLabel(item.shortcut)));
    if (item.submenu) btn.append(h('span.menu-chev', icon('chevRight', 14)));
    const openSub = () => {
      if (item.disabled) return;
      if (submenu && !submenu.closed) return;
      const subItems = typeof item.submenu === 'function' ? item.submenu() : item.submenu;
      const r = btn.getBoundingClientRect();
      submenu = openMenu({ x: r.right - 2, y: r.top - 4, flipX: r.left }, subItems, { label: item.label, parent: handle, returnFocus: false });
      btn.setAttribute('aria-expanded', 'true');
      const subClose = submenu.close;
      submenu.close = (restore) => {
        subClose(restore);
        submenu.closed = true;
        btn.setAttribute('aria-expanded', 'false');
      };
    };
    btn.addEventListener('click', () => {
      if (item.disabled) return;
      if (item.submenu) {
        openSub();
        submenu?.el.querySelector('[role^="menuitem"]')?.focus();
      } else run(item);
    });
    btn.addEventListener('pointerenter', () => {
      btn.focus({ preventScroll: true });
      if (submenu && !submenu.closed && !item.submenu) submenu.close(false);
      if (item.submenu) openSub();
    });
    btn._openSub = item.submenu ? openSub : null;
    menu.append(btn);
    focusables.push(btn);
  }

  // Closing a submenu marks its item collapsed, so find the item first.
  const backToParent = () => {
    const item = parent.el.querySelector('[aria-expanded="true"]');
    handle.close(false);
    item?.focus();
  };

  menu.addEventListener('keydown', (e) => {
    const i = focusables.indexOf(document.activeElement);
    const focus = (n) => focusables[(n + focusables.length) % focusables.length]?.focus();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focus(i + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focus(i < 0 ? focusables.length - 1 : i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focus(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focus(focusables.length - 1);
    } else if (e.key === 'ArrowRight' && document.activeElement?._openSub) {
      e.preventDefault();
      document.activeElement._openSub();
      submenu?.el.querySelector('[role^="menuitem"]')?.focus();
    } else if (e.key === 'ArrowLeft' && parent) {
      e.preventDefault();
      backToParent();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (parent) backToParent();
      else handle.close();
    } else if (e.key === 'Tab') {
      // Focus goes back to the button that opened the menu, then Tab moves on.
      const root = openStack[0];
      while (openStack.length > 1) openStack.pop().close(false);
      root?.close(true);
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      const ch = e.key.toLowerCase();
      const start = i + 1;
      for (let k = 0; k < focusables.length; k++) {
        const el = focusables[(start + k) % focusables.length];
        if (el.textContent.trim().toLowerCase().startsWith(ch)) {
          el.focus();
          break;
        }
      }
    }
  });

  const outside = (e) => {
    if (openStack.some((m) => m.el.contains(e.target))) return;
    if (anchor instanceof Element && anchor.contains(e.target)) {
      // Let the anchor's own click toggle the menu closed.
      e.stopPropagation();
      closeAllMenus();
      anchor._menuJustClosed = true;
      setTimeout(() => (anchor._menuJustClosed = false), 300);
      return;
    }
    closeAllMenus();
  };
  const blurClose = () => closeAllMenus();

  document.body.append(menu);
  position(menu, anchor, align);
  if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'true');
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', blurClose);
    window.addEventListener('resize', blurClose);
  });
  openStack.push(handle);
  const first = focusables.find((f) => f.getAttribute('aria-checked') === 'true') || focusables.find((f) => f.getAttribute('aria-disabled') !== 'true');
  (first || menu).focus({ preventScroll: true });
  return handle;
}

function position(menu, anchor, align) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.maxHeight = `${vh - 16}px`;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x;
  let y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    x = align === 'end' ? r.right - mw : r.left;
    y = r.bottom + 2;
    if (y + mh > vh - 8 && r.top - mh - 2 > 8) y = r.top - mh - 2;
  } else {
    x = anchor.x;
    y = anchor.y;
    if (x + mw > vw - 8 && anchor.flipX !== undefined) x = anchor.flipX - mw + 2;
    if (y + mh > vh - 8) y = Math.max(8, vh - mh - 8);
  }
  x = Math.max(8, Math.min(x, vw - mw - 8));
  y = Math.max(8, Math.min(y, vh - mh - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

/** Wires a button so click / ArrowDown open a menu built by itemsFn(). */
export function menuButton(btn, itemsFn, opts = {}) {
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  const open = () => {
    if (btn._menuJustClosed) return;
    openMenu(btn, itemsFn(), { label: opts.label || btn.getAttribute('aria-label') || btn.textContent.trim(), ...opts });
  };
  btn.addEventListener('click', open);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.altKey && e.key === 'ArrowDown')) {
      e.preventDefault();
      open();
    }
  });
  return btn;
}
