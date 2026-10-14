/**
 * Popover menus (dropdowns and context menus) with full keyboard support:
 * arrow keys move, Enter/Space activate, Escape closes and returns focus,
 * typing a letter jumps to the next matching item.
 *
 * items: [{ label, icon, shortcut, checked, disabled, action, submenu: items }, { separator: true }, { header: 'Text' }]
 */
import { h } from './dom.js';
import { icon } from './icons.js';

/** Open menus, outermost first (submenus stack on top of their parent). */
const stack = [];

export function closeMenus(keep = 0) {
  while (stack.length > keep) stack.pop().close();
}

/**
 * Show a menu. `at` is { x, y } (client px) or an anchor element.
 * Returns a handle with close().
 */
export function showMenu(at, items, opts = {}) {
  // Clicking the button of an open menu closes it.
  if (!opts.parentFocus && at instanceof Element && stack[0]?.anchor === at) {
    closeMenus();
    return null;
  }
  closeMenus(opts.parentFocus ? opts.level ?? 1 : 0);
  const prevFocus = document.activeElement;
  const level = opts.parentFocus ? opts.level ?? 1 : 0;
  // Focus goes back where it was before the outermost menu opened.
  const rootFocus = opts.rootFocus ?? prevFocus;
  const restore = () => {
    if (opts.restoreFocus !== false && rootFocus?.isConnected) rootFocus.focus({ preventScroll: true });
  };
  const el = h('div.menu', { role: 'menu', tabindex: '-1', 'aria-label': opts.label || 'Menu' });
  if (opts.className) el.classList.add(opts.className);
  const entries = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator) {
      el.append(h('div.menu-sep', { role: 'separator' }));
      continue;
    }
    if (it.header) {
      el.append(h('div.menu-header', it.header));
      continue;
    }
    if (it.custom) {
      el.append(it.custom);
      continue;
    }
    const role = it.checked !== undefined ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem';
    const btn = h(
      'button.menu-item',
      {
        type: 'button',
        role,
        tabindex: '-1',
        disabled: it.disabled,
        'aria-checked': it.checked !== undefined ? String(!!it.checked) : null,
        'aria-haspopup': it.submenu ? 'menu' : null,
        title: it.title,
      },
      h('span.menu-check', it.checked ? icon('check', 14) : null),
      it.icon ? h('span.menu-icon', typeof it.icon === 'string' ? icon(it.icon, 16) : it.icon) : h('span.menu-icon'),
      h('span.menu-label', it.label),
      it.shortcut ? h('kbd.menu-kbd', it.shortcut) : null,
      it.submenu ? h('span.menu-sub', icon('chevron-right', 14)) : null,
    );
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.submenu) {
        const r = btn.getBoundingClientRect();
        showMenu({ x: r.right - 2, y: r.top - 4 }, it.submenu, { ...opts, parentFocus: btn, level: level + 1, rootFocus });
        return;
      }
      closeMenus();
      restore();
      it.action?.();
    });
    btn.addEventListener('pointerenter', () => btn.focus({ preventScroll: true }));
    entries.push({ btn, it });
    el.append(btn);
  }
  document.body.append(el);

  // Position inside the viewport.
  let x, y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = opts.alignRight ? r.right - el.offsetWidth : r.left;
    y = r.bottom + 2;
    if (y + el.offsetHeight > innerHeight - 8 && r.top - el.offsetHeight - 2 > 8) y = r.top - el.offsetHeight - 2;
  } else {
    x = at.x;
    y = at.y;
    if (y + el.offsetHeight > innerHeight - 8) y = Math.max(8, innerHeight - el.offsetHeight - 8);
  }
  x = Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8));
  y = Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  const focusables = () => [...el.querySelectorAll('button:not([disabled])')];
  const move = (dir) => {
    const list = focusables();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const next = list[(i + dir + list.length) % list.length];
    next.focus({ preventScroll: true });
  };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusables()[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      focusables().at(-1)?.focus();
    } else if (e.key === 'Escape' || (e.key === 'ArrowLeft' && opts.parentFocus)) {
      e.preventDefault();
      e.stopPropagation();
      closeMenus(opts.parentFocus ? level : 0);
      if (opts.parentFocus?.isConnected) opts.parentFocus.focus({ preventScroll: true });
      else restore();
    } else if (e.key === 'ArrowRight') {
      const cur = entries.find((x) => x.btn === document.activeElement);
      if (cur?.it.submenu) cur.btn.click();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      closeMenus();
      restore();
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const list = focusables();
      const start = list.indexOf(document.activeElement);
      for (let k = 1; k <= list.length; k++) {
        const b = list[(start + k) % list.length];
        if (b.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())) {
          b.focus();
          break;
        }
      }
    }
  });

  const onDown = (e) => {
    if (stack.some((m) => m.el.contains(e.target))) return;
    if (!(at instanceof Element && at.contains(e.target))) closeMenus();
  };
  const onBlur = () => closeMenus();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
  });
  if (at instanceof Element && !opts.parentFocus) at.setAttribute('aria-expanded', 'true');
  const handle = {
    el,
    anchor: at instanceof Element ? at : null,
    close() {
      if (at instanceof Element && !opts.parentFocus) at.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      el.remove();
      opts.onClose?.();
    },
  };
  stack.push(handle);
  if (opts.focusFirst !== false) requestAnimationFrame(() => (focusables()[0] ?? el).focus({ preventScroll: true }));
  return handle;
}
