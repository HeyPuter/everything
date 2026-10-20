/**
 * Popover menus for the menu bar and the folded phone menu. A menu can open another beside
 * it (a submenu), and the two stay open together as one chain: Escape or Left closes the
 * innermost, an outside press or a chosen item closes them all, and focus returns to
 * whatever opened the outermost.
 *
 * items: [{ label, icon?, shortcut? ("Mod+Shift+S"), hint?, onSelect, disabled?, checked?, danger? },
 *         { label, icon?, items: [...] },   // a submenu
 *         { separator: true }, { header: 'Label' }]
 *
 * Clicking the anchor of an open menu closes it. The press itself lands outside the menu
 * and closes it, so the click that follows would reopen it at once. Suppress that click,
 * however long the pointer is held.
 */
import { ariaShortcut, el, formatShortcut, icon } from './ui.js';

const HOVER_OPEN_MS = 90;
const HOVER_CLOSE_MS = 220;
let chain = []; // the open menus, the outermost first
let closingPress = null; // Listeners for the click from a press that just closed a menu.
let hoverTimer = null;
let listening = false;

const panelAt = (node) =>
  node instanceof Node ? chain.findIndex((entry) => entry.panel.contains(node)) : -1;

export function closeMenu() {
  closeFrom(0);
}
function closeFrom(index, { focus = true } = {}) {
  clearTimeout(hoverTimer);
  for (let i = chain.length - 1; i > index; i--) chain[i].dispose({ focus: false });
  if (index >= 0 && index < chain.length) chain[index].dispose({ focus });
}
export const isMenuOpen = () => chain.length > 0;
/** The element the outermost open menu is anchored to, or null. */
export const menuAnchor = () => chain[0]?.anchor || null;
/**
 * Whether Left or Right belongs to the menus themselves: Right opens the submenu on the
 * focused item, and Left closes the submenu it is in. The menu bar asks before taking those
 * keys to move between its own names.
 */
export function menuTakesArrow(key) {
  if (!chain.length) return false;
  const active = document.activeElement;
  if (key === 'ArrowLeft') return panelAt(active) > 0;
  if (key === 'ArrowRight') return !!active?.closest?.('.menu-item[aria-haspopup="menu"]');
  return false;
}
function clearClosingPress() {
  closingPress?.abort();
  closingPress = null;
}
function suppressClosingClick(anchor, pointerId) {
  clearClosingPress();
  closingPress = new AbortController();
  const options = { capture: true, signal: closingPress.signal };
  document.addEventListener(
    'click',
    (e) => {
      const suppress = e.detail > 0 && e.target instanceof Node && anchor.contains(e.target);
      clearClosingPress();
      if (suppress) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    options,
  );
  // Cancellation or a new press cannot leave a stale click waiting to be suppressed.
  document.addEventListener(
    'pointercancel',
    (e) => {
      if (e.pointerId === pointerId) clearClosingPress();
    },
    options,
  );
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.isPrimary) clearClosingPress();
    },
    options,
  );
  window.addEventListener('blur', clearClosingPress, { signal: closingPress.signal });
}

export function openMenu({
  anchor,
  items,
  x = null,
  y = null,
  align = 'start',
  label = 'Menu',
  minWidth = null,
  focusFirst = true,
}) {
  // An anchor inside an open menu makes this a submenu of it; anything else starts again.
  const parent = panelAt(anchor);
  if (parent === -1) {
    closeMenu();
    clearClosingPress();
  } else closeFrom(parent + 1, { focus: false });
  const menu = el('div', {
    class: `menu${parent >= 0 ? ' menu-sub' : ''}`,
    role: 'menu',
    'aria-label': label,
    tabindex: -1,
  });
  if (minWidth) menu.style.minWidth = `${minWidth}px`;
  const depth = () => chain.findIndex((entry) => entry.panel === menu);
  function openChild(button, item, { focus }) {
    const at = depth();
    if (at === -1 || item.disabled) return;
    const child = chain[at + 1];
    if (child?.anchor === button) {
      // Hover opens without taking focus; keyboard or click activation must still enter it.
      if (focus) {
        if (focusables(child.panel).length) focusIn(child.panel, 0);
        else child.panel.focus();
      }
      return;
    }
    closeFrom(at + 1, { focus: false });
    openMenu({ anchor: button, items: item.items, label: String(item.label), focusFirst: focus });
  }
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      menu.append(el('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (item.header) {
      menu.append(el('div', { class: 'menu-header' }, item.header));
      continue;
    }
    const isCheck = item.checked !== undefined;
    const opensChild = !!item.items?.length;
    const button = el(
      'button',
      {
        type: 'button',
        role: isCheck ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': isCheck ? String(!!item.checked) : null,
        'aria-haspopup': opensChild ? 'menu' : null,
        'aria-expanded': opensChild ? 'false' : null,
        'aria-keyshortcuts': item.shortcut ? ariaShortcut(item.shortcut) : null,
        disabled: !!item.disabled,
        tabindex: -1,
        class: `menu-item${item.danger ? ' danger' : ''}${item.checked ? ' checked' : ''}`,
        onclick: () => {
          if (item.disabled) return;
          if (opensChild) {
            openChild(button, item, { focus: true });
            return;
          }
          closeFrom(0);
          item.onSelect?.();
        },
        // Focus follows the mouse so the keyboard carries on from wherever it is, and so
        // an item with a submenu can show it without being clicked.
        onpointerenter: (e) => {
          if (e.pointerType && e.pointerType !== 'mouse') return;
          const at = depth();
          if (at === -1) return;
          clearTimeout(hoverTimer);
          button.focus({ preventScroll: true });
          if (opensChild)
            hoverTimer = setTimeout(() => {
              if (button.isConnected) openChild(button, item, { focus: false });
            }, HOVER_OPEN_MS);
          else if (chain.length > at + 1)
            hoverTimer = setTimeout(() => closeFrom(at + 1, { focus: false }), HOVER_CLOSE_MS);
        },
      },
      el(
        'span',
        { class: 'menu-icon' },
        isCheck
          ? item.checked
            ? icon('Check', 15)
            : null
          : item.icon
            ? icon(item.icon, 16)
            : null,
      ),
      el(
        'span',
        { class: 'menu-label' },
        item.label,
        item.hint && el('span', { class: 'menu-hint' }, item.hint),
      ),
      item.shortcut &&
        el(
          'span',
          { class: 'menu-shortcut', 'aria-hidden': 'true' },
          formatShortcut(item.shortcut),
        ),
      opensChild &&
        el('span', { class: 'menu-arrow', 'aria-hidden': 'true' }, icon('ChevronRight', 14)),
    );
    menu.append(button);
  }
  // Context-menu anchors can have their own expansion state (for example, bookmarks).
  // Only menu buttons use aria-expanded to describe this popup.
  const menuButton = ['menu', 'true'].includes(anchor?.getAttribute?.('aria-haspopup'));
  // A submenu hands focus back to the item it opened from; any other menu to whatever had it.
  const opener =
    parent >= 0
      ? anchor
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : anchor;
  // Full screen shows only its own element, so a menu opened there (a link's or a page's)
  // goes inside it; on the body it would take the focus while staying out of sight.
  (document.fullscreenElement || document.body).append(menu);
  position(menu, anchor, x, y, align, parent >= 0 ? chain[parent].panel : null);
  function dispose({ focus = true } = {}) {
    const at = depth();
    if (at === -1) return;
    chain.splice(at, 1);
    menu.remove();
    if (menuButton) anchor.setAttribute('aria-expanded', 'false');
    if (!chain.length) stopListening();
    if (focus && opener?.isConnected) opener.focus({ preventScroll: true });
  }
  if (menuButton) anchor.setAttribute('aria-expanded', 'true');
  chain.push({ panel: menu, anchor: anchor || null, dispose });
  startListening();
  if (focusFirst && focusables(menu).length) focusIn(menu, 0);
  else if (focusFirst) menu.focus();
  return {
    close: () => {
      const at = depth();
      if (at !== -1) closeFrom(at);
    },
    menu,
  };
}

const focusables = (menu) => [...menu.querySelectorAll('button:not([disabled])')];
function focusIn(menu, i) {
  const enabled = focusables(menu);
  if (!enabled.length) return;
  enabled[((i % enabled.length) + enabled.length) % enabled.length].focus();
}

/* One set of listeners for the whole chain. */
function startListening() {
  if (listening) return;
  listening = true;
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
}
function stopListening() {
  listening = false;
  clearTimeout(hoverTimer);
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('blur', closeMenu);
}
function onOutside(e) {
  if (panelAt(e.target) !== -1) return;
  const anchor = chain[0]?.anchor;
  if (anchor && e.target instanceof Node && anchor.contains(e.target)) {
    suppressClosingClick(anchor, e.pointerId);
  }
  closeMenu();
}
function onKey(e) {
  if (e.isComposing || !chain.length) return;
  // Keys belong to the menu the focus is in, and to the innermost one when focus has gone
  // elsewhere (a menu opened by the mouse and never entered).
  const inside = panelAt(document.activeElement);
  const at = Math.max(0, inside === -1 ? chain.length - 1 : inside);
  const menu = chain[at].panel;
  const enabled = focusables(menu);
  const index = enabled.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFrom(at);
    return;
  }
  if (e.key === 'Tab') {
    // Restore the opener, then let native Tab move to its next or previous control.
    closeMenu();
    return;
  }
  const parentItem = document.activeElement?.closest?.('.menu-item[aria-haspopup="menu"]');
  if (e.key === 'ArrowRight' && parentItem) {
    e.preventDefault();
    e.stopPropagation();
    parentItem.click();
    return;
  }
  if (e.key === 'ArrowLeft' && at > 0) {
    e.preventDefault();
    e.stopPropagation();
    closeFrom(at);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusIn(menu, index + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusIn(menu, index < 0 ? -1 : index - 1);
  } else if (e.key === 'Home') {
    e.preventDefault();
    focusIn(menu, 0);
  } else if (e.key === 'End') {
    e.preventDefault();
    focusIn(menu, -1);
  } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const ch = e.key.toLowerCase();
    for (let k = 0; k < enabled.length; k++) {
      const b = enabled[(index + 1 + k) % enabled.length];
      if (b.textContent.trim().toLowerCase().startsWith(ch)) {
        b.focus();
        break;
      }
    }
  }
}

/**
 * Below the anchor, left edges aligned, by default. A menu that does not fit below goes
 * above when there is room there; otherwise it stays on the side with more room and
 * scrolls, so it never slides up over its own anchor (the menu bar's other names must stay
 * reachable while one menu is open). A submenu opens beside its item, on the side it fits.
 */
function position(menu, anchor, x, y, align, parentPanel) {
  // Menus keep clear of the screen edges and, on phones, of the notch and corner insets too.
  const style = getComputedStyle(document.documentElement);
  const inset = (side) => parseFloat(style.getPropertyValue(`--safe-${side}`)) || 0;
  const pad = 8;
  const padTop = pad + inset('top'),
    padRight = pad + inset('right'),
    padBottom = pad + inset('bottom'),
    padLeft = pad + inset('left');
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  let height = rect.height;
  let left, top;
  const cap = (h) => {
    height = Math.max(0, Math.floor(h));
    menu.style.maxHeight = `${height}px`;
    menu.style.overflowY = 'auto';
  };
  if (parentPanel && anchor) {
    const a = anchor.getBoundingClientRect();
    const p = parentPanel.getBoundingClientRect();
    // The two menus touch, so crossing between them never leaves the pair.
    left = p.right - 1;
    if (left + rect.width > vw - pad) {
      const other = p.left - rect.width + 1;
      // On a narrow screen neither side has room; the submenu then sits over the menu it
      // came from, edges aligned, and reads as a step inwards.
      left = other >= pad ? other : p.left;
    }
    top = a.top - 6;
    if (left < p.right - 1 && left + rect.width > p.left + 1) {
      // Over its parent, the submenu hangs below or above its item so the item stays in
      // view and clickable, scrolling when it must; only when neither side has room does
      // it cover the parent outright.
      const below = vh - pad - (a.bottom + 4),
        above = a.top - 4 - pad,
        least = 160;
      if (height <= below) top = a.bottom + 4;
      else if (height <= above) top = a.top - 4 - height;
      else if (above >= least && above >= below) {
        cap(above);
        top = a.top - 4 - height;
      } else if (below >= least) {
        cap(below);
        top = a.bottom + 4;
      }
    }
  } else if (x != null && y != null) {
    left = x;
    top = y;
    if (top + height > vh - pad && y - height >= pad) top = y - height;
    if (left + rect.width > vw - pad && x - rect.width >= pad) left = x - rect.width;
  } else if (anchor) {
    const a = anchor.getBoundingClientRect();
    if (align === 'auto') align = a.left + a.width / 2 > vw / 2 ? 'end' : 'start';
    left = align === 'end' ? a.right - rect.width : a.left;
    top = a.bottom + 4;
    const below = vh - pad - top;
    const above = a.top - 4 - pad;
    if (height > below) {
      if (height <= above) top = a.top - 4 - height;
      else if (above > below) {
        cap(above);
        top = a.top - 4 - height;
      } else cap(below);
    }
  } else {
    left = (vw - rect.width) / 2;
    top = (vh - height) / 2;
  }
  if (height > vh - padTop - padBottom) cap(vh - padTop - padBottom);
  if (left + rect.width > vw - padRight) left = Math.max(padLeft, vw - padRight - rect.width);
  if (left < padLeft) left = padLeft;
  if (top + height > vh - padBottom) top = Math.max(padTop, vh - padBottom - height);
  if (top < padTop) top = padTop;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

/**
 * The menu bar under the document title. Each name opens its menu through the function
 * given for it. The bar is one tab stop, with Left and Right (or Home and End) moving
 * between the names and Down or Enter opening one. While a menu is open, Left and Right
 * switch to the neighboring menu, and so does sliding the mouse along the bar.
 *
 * createMenubar([{ label, open(anchor) }], { label }) -> { el, buttons, destroy }
 */
export function createMenubar(entries, { label = 'Menu bar' } = {}) {
  const bar = el('nav', { class: 'menubar', role: 'menubar', 'aria-label': label });
  const buttons = [];
  const wrap = (i) => ((i % buttons.length) + buttons.length) % buttons.length;
  const openIndex = () => buttons.indexOf(menuAnchor());
  const setTabStop = (i) =>
    buttons.forEach((b, k) => b.setAttribute('tabindex', k === i ? '0' : '-1'));
  const focusAt = (i) => buttons[wrap(i)].focus({ preventScroll: true });
  // The open menu goes first so that focus returning to its name does not outlive the move
  // to the new one; Escape then brings focus back here.
  function open(i) {
    closeMenu();
    focusAt(i);
    entries[wrap(i)].open(buttons[wrap(i)]);
  }
  entries.forEach((entry, i) => {
    const button = el(
      'button',
      {
        type: 'button',
        class: 'menu-btn',
        role: 'menuitem',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        tabindex: i === 0 ? 0 : -1,
        onclick: () => open(i),
        onfocus: () => setTabStop(i),
        // A tap raises pointerenter before the press that would close the menu again, so
        // only the mouse sweeps along the bar.
        onpointerenter: (e) => {
          if (e.pointerType === 'mouse' || !e.pointerType) {
            const at = openIndex();
            if (at !== -1 && at !== i) open(i);
          }
        },
        onkeydown: (e) => {
          if (e.altKey || e.ctrlKey || e.metaKey) return;
          const move = {
            ArrowDown: () => open(i),
            ArrowUp: () => open(i),
            ArrowRight: () => focusAt(i + 1),
            ArrowLeft: () => focusAt(i - 1),
            Home: () => focusAt(0),
            End: () => focusAt(-1),
          }[e.key];
          if (!move) return;
          // The keys are the bar's alone: the page beneath must not also take Home or End to
          // its first or last page.
          e.preventDefault();
          e.stopPropagation();
          move();
        },
      },
      entry.label,
    );
    buttons.push(button);
    bar.append(button);
  });
  // With a menu open, focus is in the popup; Left and Right there move along the bar.
  function onKey(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = openIndex();
    if (at === -1) return;
    if (document.activeElement?.matches?.('input, select, textarea')) return;
    if (menuTakesArrow(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    open(at + (e.key === 'ArrowRight' ? 1 : -1));
  }
  document.addEventListener('keydown', onKey, true);
  return {
    el: bar,
    buttons,
    destroy: () => {
      document.removeEventListener('keydown', onKey, true);
      if (openIndex() !== -1) closeMenu();
    },
  };
}
