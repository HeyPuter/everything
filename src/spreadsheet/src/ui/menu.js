/**
 * Popover menus: the File menu, the number-format picker, right-click
 * context menus, color swatches. One menu at a time; Escape or an outside
 * click closes it; arrows move between items; focus returns to the anchor.
 *
 * items: [{ label, icon?, shortcut?, hint?, detail?, onSelect, disabled?, checked?, radio?, keepOpen?, danger?, style? }
 *           `hint` is a muted second line, spoken as the item's description; `checked` makes a
 *           checkbox item, or with `radio` one choice of several (a font, a size, a number format);
 *           `detail` is a value printed at the right (a statistic beside its name), read with the label;
 *           `keepOpen` on a checkbox item toggles it in place and leaves the menu open for the next
 *         { label, icon?, submenu: [items] }   opens a child menu beside the item (hover, click, or Right arrow)
 *         { separator: true }, { header: 'Label' }, { custom: HTMLElement }]
 *
 * `onNavigate(dir)` (menu bars) is called when Left or Right is pressed at the
 * top level of the menu, or Right on a submenu item that opens nothing more,
 * so the bar can open the neighbouring menu. `opener` is
 * the element focus returns to when the menu closes (by default whatever had
 * focus when it opened): a bar that swaps menus that way passes the current title.
 * `onClose(reason)` says why the menu went: 'select' (an item was chosen), 'escape', 'tab',
 * 'outside' (a press elsewhere), 'scroll', 'resize', 'blur' (the window lost focus) or 'api'
 * (closed by code), so a caller can decide where focus belongs afterwards.
 * `search` opts a long, flat list into substring filtering; its text labels the search field.
 * The popup keeps a stable height, and Enter in an empty field preserves a checked choice.
 * `focusChecked` starts a value picker on its selected radio item; ordinary action menus start at the top.
 */

import { isComposing, el, fieldId } from './dom.js';
import { icon } from './icons.js';

let current = null;

const KEY_MODIFIERS = { '⌘': 'Meta', cmd: 'Meta', command: 'Meta', meta: 'Meta', ctrl: 'Control', control: 'Control', '⌃': 'Control', '⇧': 'Shift', shift: 'Shift', '⌥': 'Alt', alt: 'Alt', option: 'Alt' };
const KEY_NAMES = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', '↩': 'Enter', tab: 'Tab', space: 'Space',
  delete: 'Delete', del: 'Delete', backspace: 'Backspace', '⌫': 'Backspace', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight', plus: 'Plus',
};

/**
 * The shortcut hint printed beside an item ("⌘+Shift+P") in the spelling
 * aria-keyshortcuts takes ("Meta+Shift+P"): the printed hint is aria-hidden,
 * so this is how a screen reader learns the keys. Null when the hint is not
 * a key combination, since the same slot shows sample values, colours and names.
 */
export function ariaKeyShortcuts(hint) {
  if (typeof hint !== 'string' || !hint) return null;
  const parts = hint.split('+');
  if (parts.length > 2 && parts.at(-1) === '' && parts.at(-2) === '') parts.splice(-2, 2, 'Plus'); // "Ctrl++": the plus key
  const modifiers = [];
  let key = null;
  for (const raw of parts) {
    const part = raw.trim();
    const modifier = KEY_MODIFIERS[part.toLowerCase()];
    if (modifier) { if (key) return null; modifiers.push(modifier); continue; }
    if (key) return null; // two keys are a phrase, not a combination
    const named = KEY_NAMES[part.toLowerCase()];
    if (named) key = named;
    else if (/^F([1-9]|1[0-2])$/i.test(part)) key = part.toUpperCase();
    else if ([...part].length === 1 && /\S/.test(part)) key = part;
    else return null;
  }
  return key ? [...modifiers, key].join('+') : null;
}

/** Give `item` a submenu built on first use: a ribbon refresh asks only whether a button opens a menu, not what is in it. */
export function lazySubmenu(item, build) {
  let built;
  return Object.defineProperty(item, 'submenu', { enumerable: true, configurable: true, get: () => (built ??= build()) });
}

export function closeMenu() {
  if (current) current.close();
}

export function isMenuOpen() {
  return !!current;
}

/**
 * The api of a menu that did not open, because its anchor was pressed again to close it: an empty,
 * detached menu element and methods that do nothing, so whatever the caller does to its menu next
 * (focus a swatch, read an item) finds nothing rather than fails.
 */
function closedMenu() {
  const menu = el('div.menu', { role: 'menu' });
  return { close() {}, closeAll() {}, menu, owns: () => false, focusBack() {}, focusFirst() {}, focusLast() {} };
}

export function openMenu({ anchor, items, x = null, y = null, altRight = null, align = 'start', label = 'Menu', onClose = null, minWidth = null, restoreFocus = true, parent = null, onNavigate = null, opener = null, autoFocus = true, search = null, focusChecked = false }) {
  if (!parent) {
    // A second press on the button that opened the menu closes it, as a menu-bar title does, instead of
    // opening a fresh copy over the one the press left in place (the press on an anchor is the anchor's to handle).
    const toggling = !!anchor && current?.anchor === anchor;
    closeMenu();
    if (toggling) return closedMenu();
  }
  const menu = el('div.menu', { role: search ? 'dialog' : 'menu', 'aria-label': label, tabindex: -1, className: parent ? 'menu submenu' : 'menu' });
  const choicesHost = search ? el('div.menu-choices', { role: 'menu', 'aria-label': label }) : menu;
  // Focusing an opener can scroll its toolbar before this menu opens, with the scroll event
  // arriving afterwards. Only a subsequent change should dismiss the correctly placed menu.
  const openingScroll = new Map();
  for (let node = anchor?.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) {
      openingScroll.set(node, { left: node.scrollLeft, top: node.scrollTop });
    }
  }
  if (minWidth) menu.style.setProperty('--menu-min-width', `${minWidth}px`); // the stylesheet caps it at the viewport
  let child = null; // the open submenu, if any
  let hoverTimer = null;
  let typed = ''; // letters typed in quick succession, matched as a prefix
  let typedAt = 0;
  // Opt-in filtering for long, flat choice lists. Keep the field and popup stable as results shrink.
  const searchStatus = search ? el('div.menu-search-status', { role: 'status', 'aria-live': 'polite', hidden: true }) : null;
  const searchInput = search ? el('input.input', { type: 'search', placeholder: search, 'aria-label': search, autocomplete: 'off', spellcheck: false }) : null;
  if (searchInput) {
    menu.classList.add('menu-searchable');
    menu.append(el('div.menu-search', {}, searchInput), searchStatus);
    searchInput.addEventListener('input', () => {
      closeChild();
      const query = searchInput.value.trim().toLocaleLowerCase();
      const entries = [...choicesHost.children].filter(node => node._item);
      for (const node of entries) node.hidden = !!query && !node._item.label.toLocaleLowerCase().includes(query);
      for (const node of choicesHost.children) {
        if (node.classList.contains('menu-sep')) node.hidden = !!query;
        if (node.classList.contains('menu-header')) {
          let next = node.nextElementSibling, any = false;
          while (next && !next.classList.contains('menu-header') && !next.classList.contains('menu-sep')) {
            if (next._item && !next.hidden) any = true;
            next = next.nextElementSibling;
          }
          node.hidden = !!query && !any;
        }
      }
      const count = entries.filter(node => !node.hidden).length;
      choicesHost.hidden = !count;
      searchStatus.hidden = !query;
      searchStatus.textContent = count ? `${count} ${count === 1 ? 'result' : 'results'}` : 'No matches';
      menu.scrollTop = 0;
    });
    searchInput.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusIndex(e.key === 'ArrowDown' ? 0 : -1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const choices = enabledButtons();
        const selected = !searchInput.value.trim() && choices.find(node => node.getAttribute('aria-checked') === 'true');
        (selected || choices[0])?.click();
      }
    });
    menu.append(choicesHost);
  }

  for (const item of items) {
    if (!item) continue;
    if (item.separator) { choicesHost.append(el('div.menu-sep', { role: 'separator' })); continue; }
    if (item.header) { choicesHost.append(el('div.menu-header', {}, item.header)); continue; }
    if (item.custom) { choicesHost.append(item.custom); continue; }
    const isCheck = item.checked !== undefined;
    const isSub = Array.isArray(item.submenu);
    // The hint is the item's description, not part of its name: the label alone names it.
    const hintId = item.hint ? fieldId('menu-hint') : null;
    const btn = el('button', {
      type: 'button',
      role: isCheck ? (item.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem',
      'aria-label': item.ariaLabel || (item.hint ? item.label : null),
      'aria-describedby': hintId,
      'aria-checked': isCheck ? String(!!item.checked) : null,
      'aria-haspopup': isSub ? 'menu' : null,
      'aria-expanded': isSub ? 'false' : null,
      'aria-keyshortcuts': ariaKeyShortcuts(item.shortcut),
      disabled: !!item.disabled,
      tabindex: -1,
      className: `menu-item${item.danger ? ' danger' : ''}${item.checked ? ' checked' : ''}${isSub ? ' has-sub' : ''}`,
      onclick: () => {
        if (item.disabled) return;
        if (isSub) { openSub(item, btn); return; }
        if (item.keepOpen && isCheck && !item.radio) {
          // A list of switches (what the status bar shows): each click flips one, and the menu stays for the next.
          item.onSelect?.();
          item.checked = !item.checked;
          btn.setAttribute('aria-checked', String(item.checked));
          btn.classList.toggle('checked', item.checked);
          btn.querySelector('.menu-icon').innerHTML = item.checked ? icon('check', 16, 2.2) : '';
          return;
        }
        closeAll('select');
        item.onSelect?.();
      },
    },
      item.swatch
        ? el('span.menu-icon', {}, el('span.menu-swatch', { style: { backgroundColor: item.swatch }, 'aria-hidden': 'true' }, isCheck && item.checked ? el('span', { html: icon('check', 12, 2.4) }) : null))
        : el('span.menu-icon', { html: isCheck ? (item.checked ? icon('check', 16, 2.2) : '') : (item.icon ? icon(item.icon, 17) : '') }),
      // `paper` marks a sample of how the sheet draws something: its tokens are the paper's, whatever the theme.
      el(item.paper ? 'span.menu-label.sheet-paper' : 'span.menu-label', { style: item.style || null }, item.label, item.hint && el('span.menu-hint', { id: hintId }, item.hint)),
      item.shortcut && el('span.menu-shortcut', { 'aria-hidden': 'true' }, item.shortcut),
      item.detail != null && item.detail !== '' && el('span.menu-shortcut.menu-detail', {}, item.detail),
      isSub && el('span.menu-chevron', { html: icon('chevR', 14, 2), 'aria-hidden': 'true' }));
    if (isSub) {
      // Hovering opens the submenu after a moment; leaving for another item closes it.
      btn.addEventListener('pointerenter', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { if (child?.item !== item) openSub(item, btn, { focus: false }); }, 140); });
      btn.addEventListener('pointerleave', () => clearTimeout(hoverTimer));
    } else {
      // Resting on another item closes an open submenu. An item only crossed on the way into the submenu
      // (the usual diagonal move from the opener to a lower item of it) must not close it under the
      // pointer, so leaving the item cancels the close it armed, as leaving an opener cancels its opening.
      btn.addEventListener('pointerenter', () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => closeChild(), 200); });
      btn.addEventListener('pointerleave', () => clearTimeout(hoverTimer));
    }
    btn._item = item;
    choicesHost.append(btn);
  }

  // Roving tabindex makes the focused choice a real keyboard entry point, including in a
  // scrollable picker. Custom fields and grids retain their own tab-order management.
  const choiceButtons = () => [...choicesHost.querySelectorAll('.menu-item')];
  const firstChoice = choiceButtons().find(node => !node.disabled && !node.closest('[hidden], [inert]'));
  if (firstChoice) firstChoice.tabIndex = 0;
  menu.addEventListener('focusin', (e) => {
    if (!e.target.matches?.('.menu-item')) return;
    for (const node of choiceButtons()) node.tabIndex = node === e.target ? 0 : -1;
  });

  const returnTo = opener || (document.activeElement instanceof HTMLElement ? document.activeElement : anchor);
  document.body.append(menu);
  position(menu, anchor, x, y, align, altRight);
  // Filter values, search results and validation messages can change the menu's
  // size after it opens. Keep its actual layout box inside the viewport before
  // a user has to scroll the page to reach its controls (which dismisses it).
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null;
  resizeObserver?.observe(menu);

  function reposition() {
    if (!menu.isConnected) return;
    const { left, top } = menu.style;
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
    position(menu, anchor, x, y, align, altRight);
    // Submenus were placed beside their opener's previous position.
    if (menu.style.left !== left || menu.style.top !== top) closeChild();
  }

  /** Close the open submenu. Focus inside it goes back to its opener rather than being dropped with it. */
  function closeChild() {
    if (!child) return;
    const c = child;
    child = null;
    const focusedInside = c.owns(document.activeElement);
    c.close();
    c.btn.setAttribute('aria-expanded', 'false');
    if (focusedInside) c.btn.focus({ preventScroll: true });
  }

  /** Open the item's submenu. The keyboard (Right) and a click move focus into it; a hover leaves focus where it is. */
  function openSub(item, btn, { focus = true } = {}) {
    if (child?.item !== item) {
      closeChild();
      const r = btn.getBoundingClientRect();
      // Beside the item on the right; when there is no room there, on its left rather than on top of it.
      const sub = openMenu({ items: item.submenu, x: r.right + 2, y: r.top - 6, altRight: r.left - 2, label: item.label, parent: menuApi, onNavigate, restoreFocus: false, autoFocus: false });
      // The pointer arriving in the submenu keeps it: a close armed by an item it brushed on the way is off.
      sub.menu.addEventListener('pointerenter', () => clearTimeout(hoverTimer));
      child = { item, btn, close: sub.close, menu: sub.menu, owns: sub.owns, focusFirst: sub.focusFirst };
      btn.setAttribute('aria-expanded', 'true');
    }
    if (focus) child.focusFirst();
  }

  /** Close this menu and every menu above it (an item was chosen, or Tab left the tree). */
  function closeAll(reason) {
    if (parent) parent.closeAll(reason); else close(reason);
  }

  function close(reason = 'api') {
    if (!parent && current?.close !== close) return;
    if (!parent) current = null;
    clearTimeout(hoverTimer);
    closeChild();
    resizeObserver?.disconnect();
    menu.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onDismissKey, true);
    document.removeEventListener('keydown', onNavigateKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('scroll', onScroll, true);
    // A button that declares no popup (Undo, whose history is an extra on a right-click) is not left "collapsed".
    if (anchor?.hasAttribute?.('aria-haspopup')) anchor.setAttribute('aria-expanded', 'false');
    else anchor?.removeAttribute?.('aria-expanded');
    if (!parent && restoreFocus && returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    onClose?.(reason);
  }

  /** Is the node inside this menu or any open submenu of it? */
  function owns(node) {
    return menu.contains(node) || (child ? child.menu.contains(node) || (child.owns?.(node) ?? false) : false);
  }

  // A menu stays where it opened while the sheet scrolls under it; close instead, unless the menu itself scrolls.
  // A submenu stands beside its opener, so it closes when this menu's list scrolls the opener away from it.
  function onScroll(e) {
    if (owns(e.target)) { if (menu.contains(e.target)) closeChild(); return; }
    const before = openingScroll.get(e.target);
    if (before && e.target.scrollLeft === before.left && e.target.scrollTop === before.top) return;
    close('scroll');
  }

  function onBlur() {
    close('blur');
  }

  // The on-screen keyboard resizes the viewport when a field in the menu takes focus (the filter
  // search, a colour's hex field): a menu that holds focus moves into the room that is left instead
  // of closing under the typist. Any other resize closes it, as the anchor may have moved.
  function onResize() {
    if (!owns(document.activeElement)) { close('resize'); return; }
    reposition();
  }

  function onOutside(e) {
    if (parent) return; // the top menu decides
    if (owns(e.target)) return;
    // A press on the anchor is the anchor's to handle (a menu-bar title toggles its menu).
    if (anchor?.contains?.(e.target)) return;
    close('outside');
  }

  // Custom content (function search results and color swatches) may replace
  // its items while open. Read the live menu instead of the original config.
  function enabledButtons() {
    // Radio buttons in a custom row (the theme switch) are part of the arrow-key path too.
    return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="radio"]')]
      .filter((node) => !node.matches(':disabled') && !node.closest('[hidden], [inert]'));
  }

  /** Every control in the menu, fields and plain buttons included, in reading order: the Tab path. */
  function focusables() {
    return [...menu.querySelectorAll('button, input, select, textarea, [tabindex]')]
      .filter((node) => !node.matches(':disabled, [type="hidden"]') && !node.closest('[hidden], [inert]'));
  }

  function focusIndex(i) {
    const enabled = enabledButtons();
    if (!enabled.length) return;
    closeChild(); // a submenu the pointer opened is stale once the keyboard moves on in this menu
    const n = ((i % enabled.length) + enabled.length) % enabled.length;
    enabled[n].focus();
  }

  function onKey(e) {
    if (isComposing(e) || e.defaultPrevented) return;
    // A submenu that is open handles the keys while focus is inside it.
    if (child?.owns(document.activeElement)) return;
    // And only then: one the pointer opened, with the focus left on its parent, leaves the parent's keys to
    // it. Left jumped to the item that opened it, and a letter the parent had no match for moved in here.
    if (parent && !owns(document.activeElement)) return;
    const enabled = enabledButtons();
    const at = enabled.indexOf(document.activeElement);
    // Escape peels one level: a submenu the pointer opened, with focus still here, goes first.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (child) closeChild(); else if (parent) { parent.focusBack(); close('escape'); } else close('escape'); return; }
    if (e.key === 'Tab') {
      e.stopPropagation();
      // A field in the menu (a colour's hex code, a search box) makes it a small form: Tab and Shift+Tab
      // walk its controls, fields and buttons alike, since the arrows visit only the items. Past the last
      // or first control, and in a menu of items alone, Tab leaves the entire menu tree, restoring its
      // opener before the browser advances focus in the requested direction.
      const stops = focusables();
      const next = stops.some((node) => node.matches('input, select, textarea')) ? stops[stops.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1)] : null;
      if (next) { e.preventDefault(); closeChild(); next.focus(); return; }
      closeAll('tab');
      return;
    }
    // A field inside any menu owns its caret and selection keys.
    if (menu.contains(e.target) && e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    // Radios in a row (the theme switch) answer Left and Right as a radio group does: the neighbouring
    // choice, wrapping within the group, takes focus and is chosen. Up and Down walk on through the menu.
    const radiogroup = at >= 0 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') ? enabled[at].closest('[role="radiogroup"]') : null;
    if (radiogroup && menu.contains(radiogroup)) {
      e.preventDefault();
      const group = enabled.filter((node) => radiogroup.contains(node));
      const next = group[(group.indexOf(enabled[at]) + (e.key === 'ArrowRight' ? 1 : -1) + group.length) % group.length];
      next.focus();
      next.click();
      return;
    }
    // Swatches sit in a grid whose width `data-cols` gives. In a menu holding one, Right and Left move a swatch
    // at a time throughout, crossing out of the grid at its ends; Down and Up move a row inside the grid, and
    // past its last or first row go on to the item after or before it. So the recent colours, the Custom
    // swatch and the rest of the menu are all on the arrow path.
    if (menu.querySelector('[data-cols]') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); focusIndex(at + (e.key === 'ArrowRight' ? 1 : -1)); return; }
    const grid = at >= 0 ? enabled[at].closest('[data-cols]') : null;
    if (grid && menu.contains(grid) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const cells = enabled.filter((node) => grid.contains(node));
      const cols = Number(grid.dataset.cols) || cells.length;
      const gi = cells.indexOf(enabled[at]);
      if (e.key === 'ArrowDown') focusIndex(gi + cols < cells.length ? at + cols : enabled.indexOf(cells.at(-1)) + 1);
      else focusIndex(gi - cols >= 0 ? at - cols : enabled.indexOf(cells[0]) - 1);
      return;
    }
    if (e.key === 'ArrowRight' && at >= 0 && enabled[at]._item?.submenu) { e.preventDefault(); openSub(enabled[at]._item, enabled[at]); return; }
    if (e.key === 'ArrowLeft' && parent) { e.preventDefault(); parent.focusBack(); close(); return; }
    // In a menu bar, Left and Right at the top level move to the neighbouring menu, as does Right on
    // a submenu item with nothing more to open (Left there went back to the parent item, above).
    if (onNavigate && (e.key === 'ArrowRight' || (e.key === 'ArrowLeft' && !parent))) { e.preventDefault(); onNavigate(e.key === 'ArrowRight' ? 1 : -1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIndex(at + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (searchInput && at === 0) searchInput.focus(); else focusIndex(at < 0 ? -1 : at - 1); return; } // from a custom control, Up reaches the last item
    if (e.key === 'Home') { e.preventDefault(); focusIndex(0); return; }
    if (e.key === 'End') { e.preventDefault(); focusIndex(-1); return; }
    if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      // Letters typed within a moment form a prefix ("pr" reaches Print past
      // Paste and Paste special); a lone letter cycles through its matches.
      const now = Date.now();
      typed = now - typedAt < 700 ? typed + e.key.toLowerCase() : e.key.toLowerCase();
      typedAt = now;
      const find = (prefix, from) => {
        for (let k = 0; k < enabled.length; k++) {
          const b = enabled[(((from + k) % enabled.length) + enabled.length) % enabled.length];
          if (b.textContent.trim().toLowerCase().startsWith(prefix)) return b;
        }
        return null;
      };
      let match = find(typed, typed.length > 1 ? Math.max(at, 0) : at + 1);
      if (!match && typed.length > 1) { typed = e.key.toLowerCase(); match = find(typed, at + 1); }
      if (match) { closeChild(); match.focus(); }
    }
  }

  // Escape/Tab must still dismiss fields that stop propagation. Navigation
  // runs after custom grids have had a chance to handle their own arrow keys.
  function onDismissKey(e) { if (e.key === 'Escape' || e.key === 'Tab') onKey(e); }
  function onNavigateKey(e) { if (e.key !== 'Escape' && e.key !== 'Tab') onKey(e); }

  const menuApi = {
    close, closeAll, menu, owns,
    /** Called by a closing submenu: put focus back on the item that opened it. */
    focusBack() { const b = child?.btn; child = null; b?.setAttribute('aria-expanded', 'false'); b?.focus(); },
    focusFirst() { if (enabledButtons().length) focusIndex(0); else menu.focus(); },
    focusLast() { if (enabledButtons().length) focusIndex(-1); else menu.focus(); },
  };
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onDismissKey, true);
  document.addEventListener('keydown', onNavigateKey);
  if (!parent) {
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    anchor?.setAttribute?.('aria-expanded', 'true');
    current = { close, anchor };
  }
  if (autoFocus) {
    const checked = focusChecked && enabledButtons().find(node => node.matches('[role="menuitemradio"][aria-checked="true"]'));
    if (searchInput) searchInput.focus();
    else if (checked) checked.focus();
    else menuApi.focusFirst();
  }
  return menuApi;
}

/** The device's safe-area inset on one side (a notch, the home indicator), as the stylesheet resolved it. */
function safeInset(side) {
  try { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--safe-${side}`)) || 0; } catch { return 0; }
}

function position(menu, anchor, x, y, align, altRight = null) {
  const pad = 8;
  // Menus keep clear of the notch and home indicator, as the app's own frame does.
  const padL = pad + safeInset('l');
  const padR = pad + safeInset('r');
  const padT = pad + safeInset('t');
  const padB = pad + safeInset('b');
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  // The opening animation starts the menu scaled down, so a bounding rect
  // taken now under-reports its size; the layout box is the resting size.
  const rect = { width: menu.offsetWidth, height: menu.offsetHeight };
  let left;
  let top;
  if (x != null && y != null) {
    left = x;
    top = y;
    if (altRight != null && left + rect.width > vw - padR && altRight - rect.width >= padL) left = altRight - rect.width;
  } else if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = align === 'end' ? a.right - rect.width : a.left;
    top = a.bottom + 4;
    if (top + rect.height > vh - padB && a.top - rect.height - 4 > padT) top = a.top - rect.height - 4;
  } else {
    left = (vw - rect.width) / 2;
    top = (vh - rect.height) / 2;
  }
  if (left + rect.width > vw - padR) left = Math.max(padL, vw - padR - rect.width);
  if (left < padL) left = padL;
  if (top + rect.height > vh - padB) top = Math.max(padT, vh - padB - rect.height);
  if (top < padT) top = padT;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  if (rect.height > vh - padT - padB) {
    menu.style.maxHeight = `${vh - padT - padB}px`;
    menu.style.overflowY = 'auto';
  }
}
