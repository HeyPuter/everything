// Popup menus (dropdowns, context menus, menubar) with full keyboard support.

import { h, formatShortcut } from './dom';
import { icon } from './icons';

export interface MenuItem {
  label?: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  /** Radio-style item (checked shows a dot-less check). */
  radio?: boolean;
  run?: () => void;
  submenu?: () => MenuItem[];
  separator?: boolean;
  group?: string;
}

let open: { el: HTMLElement; close: () => void; parent?: HTMLElement | null } | null = null;
const stack: { el: HTMLElement; close: () => void }[] = [];

export function closeMenus() {
  while (stack.length) stack.pop()!.close();
  open = null;
}

export function isMenuOpen() {
  return stack.length > 0;
}

export interface MenuOptions {
  /** Element the menu belongs to (aria-expanded is managed). */
  anchor?: HTMLElement | null;
  /** Called when the menu closes (any reason). */
  onClose?: () => void;
  /** Keyboard navigation to sibling menus (menubar). */
  onNavigate?: (dir: -1 | 1) => void;
  level?: number;
  focusFirst?: boolean;
  label?: string;
}

/** Opens a menu at a viewport position (x, y = top-left preference). */
export function openMenu(items: MenuItem[], x: number, y: number, opts: MenuOptions = {}): HTMLElement {
  const level = opts.level ?? 0;
  while (stack.length > level) stack.pop()!.close();
  const el = h('div', { class: 'menu', role: 'menu', 'aria-label': opts.label ?? 'Menu', tabindex: '-1' });
  const buttons: HTMLElement[] = [];
  // Focus goes back where it came from, so a command run from the menu (and
  // any dialog it opens) does not leave keyboard focus on the page body.
  const returnFocus = opts.anchor ?? (level === 0 ? document.activeElement as HTMLElement | null : null);
  const closeThis = () => {
    const hadFocus = el.contains(document.activeElement);
    el.remove();
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    opts.anchor?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    opts.onClose?.();
  };
  const outside = (e: Event) => {
    const t = e.target as Node;
    if (stack.some((s) => s.el.contains(t))) return;
    if (opts.anchor && opts.anchor.contains(t)) return;
    closeMenus();
  };
  for (const it of items) {
    if (it.separator) { el.append(h('div', { class: 'sep', role: 'separator' })); continue; }
    if (it.group) { el.append(h('div', { class: 'group-label', role: 'presentation' }, it.group)); continue; }
    const role = it.checked !== undefined ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem';
    const b = h('button', {
      role,
      tabindex: '-1',
      'aria-disabled': it.disabled ? 'true' : null,
      'aria-checked': it.checked !== undefined ? String(!!it.checked) : null,
      'aria-haspopup': it.submenu ? 'menu' : null,
    }, h('span', { class: 'ic' }, it.checked ? icon('check', 16) : it.icon ? icon(it.icon, 16) : null), h('span', { class: 'lbl' }, it.label ?? ''),
    it.shortcut ? h('span', { class: 'kbd' }, formatShortcut(it.shortcut)) : null,
    it.submenu ? h('span', { class: 'sub-caret' }, icon('chevronRight', 14)) : null);
    const openSub = () => {
      if (!it.submenu || it.disabled) return;
      const r = b.getBoundingClientRect();
      openMenu(it.submenu(), r.right - 2, r.top - 4, { level: level + 1, anchor: b, focusFirst: true, label: it.label });
    };
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      if (it.submenu) { openSub(); return; }
      closeMenus();
      it.run?.();
    });
    b.addEventListener('pointerenter', () => {
      b.focus({ preventScroll: true });
      if (it.submenu) openSub();
      else while (stack.length > level + 1) stack.pop()!.close();
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && it.submenu) { e.preventDefault(); openSub(); }
    });
    buttons.push(b);
    el.append(b);
  }
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    const move = (d: number) => {
      if (!buttons.length) return;
      let j = i;
      for (let k = 0; k < buttons.length; k++) {
        j = (j + d + buttons.length) % buttons.length;
        if (buttons[j].getAttribute('aria-disabled') !== 'true') break;
      }
      buttons[j].focus();
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); buttons[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1]?.focus(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stack.pop()?.close();
      opts.anchor?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (level > 0) { stack.pop()?.close(); opts.anchor?.focus(); }
      else opts.onNavigate?.(-1);
    } else if (e.key === 'ArrowRight' && !(document.activeElement as HTMLElement)?.getAttribute('aria-haspopup')) {
      e.preventDefault();
      opts.onNavigate?.(1);
    } else if (e.key === 'Tab') {
      closeMenus();
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const start = i + 1;
      for (let n = 0; n < buttons.length; n++) {
        const b = buttons[(start + n) % buttons.length];
        if ((b.textContent || '').trim().toLowerCase().startsWith(k)) { b.focus(); break; }
      }
    }
  });
  document.body.append(el);
  // Keep inside the viewport.
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y;
  // A submenu that does not fit on the right opens to the left of its parent menu.
  const parentLeft = level > 0 ? opts.anchor?.closest('.menu')?.getBoundingClientRect().left : undefined;
  if (left + r.width > vw - 8) left = Math.max(8, parentLeft !== undefined ? parentLeft - r.width + 2 : vw - r.width - 8);
  if (top + r.height > vh - 8) top = Math.max(8, vh - r.height - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  opts.anchor?.setAttribute('aria-expanded', 'true');
  stack.push({ el, close: closeThis });
  open = { el, close: closeThis, parent: opts.anchor };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  if (opts.focusFirst !== false) (buttons.find((b) => b.getAttribute('aria-disabled') !== 'true') ?? el).focus({ preventScroll: true });
  else el.focus({ preventScroll: true });
  return el;
}

/** Opens a dropdown below an anchor element. */
export function dropdown(anchor: HTMLElement, items: MenuItem[], opts: MenuOptions = {}) {
  const r = anchor.getBoundingClientRect();
  return openMenu(items, r.left, r.bottom + 2, { anchor, ...opts });
}

export function currentMenu() {
  return open;
}
