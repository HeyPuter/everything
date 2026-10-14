// Popup menus (menu bar drop-downs, context menus, toolbar menus).
//
// Items: { type: 'cmd' | 'check' | 'radio' | 'sep' | 'heading' | 'submenu',
//   label, keys, checked, enabled (default true), run(), items (submenu:
//   array or () => array), swatch (css color), icon (name) }
//
// Keyboard: Up/Down/Home/End move, Enter/Space activate, Right opens a
// submenu, Left/Escape close it, typing jumps to an item by its first letters.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';

const stack = []; // open menus, outermost first

export function closeMenus() {
  while (stack.length) stack.pop().close(false);
}

export function isMenuOpen() {
  return stack.length > 0;
}

/**
 * Opens a menu at { x, y } (viewport px) or below/right of `anchor`.
 * Resolves when it closes. `onClose(byKeyboard)` runs when it closes.
 */
export function openMenu(items, { x = 0, y = 0, anchor = null, label = 'Menu', parent = null, onClose, focusFirst = true, placement = 'below' } = {}) {
  if (!parent) closeMenus();
  const el = h('div.menu', { role: 'menu', 'aria-label': label, tabindex: '-1' });
  const entries = [];
  let typed = '';
  let typedAt = 0;
  let child = null;

  const resolved = typeof items === 'function' ? items() : items;
  for (const it of resolved) {
    if (!it) continue;
    if (it.type === 'sep' || it === '-') {
      if (el.lastChild && el.lastChild.tagName !== 'HR') el.append(h('hr', { role: 'separator' }));
      continue;
    }
    if (it.type === 'heading') {
      el.append(h('div.mi-heading', { role: 'presentation' }, it.label));
      continue;
    }
    const enabled = it.enabled !== false;
    const role = it.type === 'check' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem';
    const btn = h(
      'button',
      {
        type: 'button',
        role,
        tabindex: '-1',
        'aria-disabled': enabled ? null : 'true',
        'aria-checked': it.type === 'check' || it.type === 'radio' ? String(Boolean(it.checked)) : null,
        'aria-haspopup': it.type === 'submenu' ? 'menu' : null,
        'aria-expanded': it.type === 'submenu' ? 'false' : null,
      },
      h('span.mi-check', it.checked ? icon('check', 14) : it.swatch ? h('span.mi-swatch', { style: { background: it.swatch } }) : it.icon ? icon(it.icon, 14) : null),
      h('span.mi-label', it.label),
      it.type === 'submenu' ? icon('chevron-right', 14) : it.keys ? h('span.mi-keys', it.keys) : null,
    );
    const entry = { it, btn, enabled };
    entries.push(entry);
    btn.addEventListener('pointerenter', () => {
      btn.focus({ preventScroll: true });
      if (child && child.owner !== entry) closeChild();
      if (it.type === 'submenu' && enabled) openChild(entry, false);
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      activate(entry, e.detail === 0);
    });
    el.append(btn);
  }
  if (el.lastChild?.tagName === 'HR') el.lastChild.remove();

  function openChild(entry, byKeyboard) {
    if (child?.owner === entry) return;
    closeChild();
    const r = entry.btn.getBoundingClientRect();
    const sub = typeof entry.it.items === 'function' ? entry.it.items() : entry.it.items || [];
    entry.btn.setAttribute('aria-expanded', 'true');
    child = openMenu(sub, { x: r.right - 2, y: r.top - 5, parent: api, label: entry.it.label, focusFirst: byKeyboard, placement: 'right' });
    child.owner = entry;
  }

  function closeChild() {
    if (!child) return;
    child.owner?.btn.setAttribute('aria-expanded', 'false');
    child.close(false);
    child = null;
  }

  function activate(entry, byKeyboard) {
    if (!entry.enabled) return;
    if (entry.it.type === 'submenu') {
      openChild(entry, byKeyboard);
      return;
    }
    closeMenus();
    entry.it.run?.();
  }

  const focusIndex = (i) => {
    const list = entries;
    if (!list.length) return;
    const n = (i + list.length) % list.length;
    list[n].btn.focus({ preventScroll: false });
  };
  const current = () => entries.findIndex((e) => e.btn === document.activeElement);

  el.addEventListener('keydown', (e) => {
    const i = current();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusIndex(i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusIndex(i < 0 ? -1 : i - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        focusIndex(-1);
        break;
      case 'ArrowRight':
        if (i >= 0 && entries[i].it.type === 'submenu') {
          e.preventDefault();
          openChild(entries[i], true);
        } else if (!parent) {
          e.preventDefault();
          api.onArrow?.(1);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (parent) {
          const owner = api.owner;
          parent.closeChildFromKeyboard();
          owner?.btn.focus();
        } else api.onArrow?.(-1);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (parent) {
          const owner = api.owner;
          parent.closeChildFromKeyboard();
          owner?.btn.focus();
        } else api.close(true);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (i >= 0) activate(entries[i], true);
        break;
      case 'Tab':
        e.preventDefault();
        closeMenus();
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = performance.now();
          typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
          typedAt = now;
          const start = Math.max(0, i);
          const order = [...entries.slice(start + (typed.length === 1 ? 1 : 0)), ...entries.slice(0, start + 1)];
          const hit = order.find((x) => x.it.label.toLowerCase().startsWith(typed));
          hit?.btn.focus();
        }
    }
    e.stopPropagation();
  });

  document.body.append(el);
  // Position, flipping to stay on screen.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = x;
  let top = y;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    left = placement === 'right' ? r.right : r.left;
    top = placement === 'right' ? r.top : r.bottom + 2;
  }
  if (left + mw > vw - 8) left = parent ? Math.max(8, x - mw - (parent.width || 0) + 4) : Math.max(8, vw - mw - 8);
  if (top + mh > vh - 8) top = Math.max(8, anchor && placement === 'below' ? anchor.getBoundingClientRect().top - mh - 2 : vh - mh - 8);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;

  const previous = parent ? null : document.activeElement;
  let closed = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const api = {
    el,
    width: mw,
    owner: null,
    onArrow: null,
    done,
    close(byKeyboard) {
      if (closed) return;
      closed = true;
      closeChild();
      el.remove();
      const idx = stack.indexOf(api);
      if (idx >= 0) stack.splice(idx, 1);
      if (!parent) {
        document.removeEventListener('pointerdown', outside, true);
        window.removeEventListener('blur', blur);
        window.removeEventListener('resize', blur);
        if (byKeyboard && previous?.isConnected) previous.focus({ preventScroll: true });
      }
      onClose?.(byKeyboard);
      resolveDone();
    },
    closeChildFromKeyboard() {
      closeChild();
    },
  };
  stack.push(api);
  const outside = (e) => {
    if (stack.some((m) => m.el.contains(e.target))) return;
    if (anchor?.contains(e.target)) return; // the anchor toggles itself
    closeMenus();
  };
  const blur = () => closeMenus();
  if (!parent) {
    // Deferred past the opening click; skipped if the menu closed meanwhile.
    setTimeout(() => {
      if (!closed) document.addEventListener('pointerdown', outside, true);
    }, 0);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
  }
  if (focusFirst) {
    const first = entries.find((e) => e.enabled) || entries[0];
    first?.btn.focus({ preventScroll: true });
  } else el.focus({ preventScroll: true });
  return api;
}

/** Context menu at the pointer for a contextmenu/pointer event. */
export function contextMenu(e, items, label = 'Context menu') {
  e.preventDefault?.();
  return openMenu(items, { x: e.clientX, y: e.clientY, label });
}

/** Context menu for keyboard users: Shift+F10 or the Menu key on a focused element. */
export function isContextKey(e) {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
}
