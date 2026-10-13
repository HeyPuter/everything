/**
 * Popover menus: the menu bar's menus, style and color pickers, per-file
 * menus. A menu can open another beside it, and the two stay open together as
 * one chain: Escape or Left closes the innermost, an outside click or a chosen
 * item closes them all, and focus returns to whatever opened the outermost.
 *
 * items: [{ label, icon?, picture?, shortcut?, hint?, onSelect, disabled?, checked?, radio?, danger? },
 *         // picture: a command icon drawn large beside the label, as a gallery shows its choices
 *         // checked: a toggle; with radio, one choice of an exclusive group
 *         { note: 'Text' },                    // a line of prose, read as a note, not a dimmed item
 *         { label, icon?, items: [...] },      // a submenu written out here
 *         { label, icon?, submenu(anchor) },   // a submenu its own opener builds
 *         { separator: true }, { header: 'Label' }, { custom: HTMLElement }]
 *
 * A submenu opens under the mouse after a moment, or on Enter or Right, and
 * its items reach the same `openMenu` from an anchor inside the menu above:
 * anything that opens a menu from a menu item is a submenu of it, which is how
 * the openers that have to read the document first join the chain unchanged.
 *
 * align: 'start' puts the menu's left edge on the anchor's, 'end' its right
 * edge on the anchor's, and 'auto' picks by which half of the window the
 * anchor sits in. A submenu ignores it and opens beside its item.
 *
 * Clicking the anchor of an open menu closes it. The press itself lands
 * outside the menu and closes it, so the click that follows would reopen it
 * at once; the anchor is remembered for the length of that click instead.
 */

import { el, isComposing } from './dom.js';
import { icon, hasIcon } from './icons.js';
import { commandIcon } from './command-icons.js';

// Menu items name icons from either set. Menus opened from the word-processor chrome (its ribbon,
// title bar and document) prefer the office icons the ribbon shows, so a menu never mixes the two
// styles; other menus prefer the outline icons. Each falls back to the other set.
const menuIcon = (name, office) => office ? commandIcon(name, 17) || icon(name, 17) : hasIcon(name) ? icon(name, 17) : commandIcon(name, 17) || icon(name, 17);
const EDITOR_CHROME = '.ed-workspace, .ribbon-flyout';

/** A submenu waits out a passing mouse, and lingers while one crosses it. */
const HOVER_OPEN_MS = 90;
const HOVER_CLOSE_MS = 220;

let chain = []; // the open menus, the outermost first
let noteSequence = 0;
let reclosed = null; // { anchor, until }: a menu the pointer just closed by pressing its own anchor
let hoverTimer = null;
let listening = false;

/** Which open menu holds this node, or -1 for none. */
function panelAt(node) {
  return node instanceof Node ? chain.findIndex((p) => p.panel.contains(node)) : -1;
}

export function closeMenu() {
  closeFrom(0);
}

/**
 * Close this menu and everything it opened. Only the outermost one closed
 * hands focus back, so leaving a submenu lands on the item that opened it and
 * closing the lot lands where the first menu was opened from.
 */
function closeFrom(index, { focus = true } = {}) {
  clearTimeout(hoverTimer);
  for (let i = chain.length - 1; i > index; i--) chain[i].dispose({ focus: false });
  if (index >= 0 && index < chain.length) chain[index].dispose({ focus });
}

export function isMenuOpen() {
  return chain.length > 0;
}

/** The element the outermost open menu is anchored to, or null. */
export function menuAnchor() {
  return chain[0]?.anchor || null;
}

/**
 * Whether Left or Right belongs to the menus themselves: Right opens the
 * submenu on the focused item, and Left closes the submenu it is in. A menu
 * bar asks before taking those keys to move between its own names.
 */
export function menuTakesArrow(key) {
  if (!chain.length) return false;
  const active = document.activeElement;
  if (active?.closest?.('.menu[role="dialog"]')) return true;
  if (key === 'ArrowLeft') return panelAt(active) > 0;
  if (key === 'ArrowRight') return !!active?.closest?.('.menu-item[aria-haspopup]');
  return false;
}

/**
 * Whether a click on `anchor` just closed the menu it had opened, in which
 * case the click means "close", not "open again". Consumed once. An opener
 * that fetches its items before calling openMenu asks this first, since the
 * click has bubbled past by the time the items arrive.
 */
let headerId = 0;

/** A shown shortcut ("Cmd+Shift+.", "Ctrl+Alt+O") as aria-keyshortcuts spells it ("Meta+Shift+."). */
export function ariaKeyshortcuts(shortcut) {
  const names = { Cmd: 'Meta', Ctrl: 'Control', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Esc: 'Escape', Return: 'Enter', Del: 'Delete' };
  return String(shortcut).split(/\s*(?:,|\bor\b)\s*/).filter(Boolean).map((chord) => chord.split('+').map((key) => names[key] || key).join('+')).join(' ');
}

export function clickClosedMenu(anchor) {
  if (!anchor || reclosed?.anchor !== anchor || performance.now() >= reclosed.until) return false;
  reclosed = null;
  return true;
}

// Whether the last press was the pointer's, so a menu it opens can hold back keyboard focus rings.
let pointerLast = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { pointerLast = true; }, true);
  document.addEventListener('keydown', () => { pointerLast = false; }, true);
}

export function openMenu({ anchor, items, x = null, y = null, align = 'start', label = 'Menu', onClose = null, minWidth = null, restoreFocus = true, className = '', closeOnWindowBlur = true, focusFirst = true, role = 'menu', pointer = false }) {
  // An opener that read the document first can resolve after its menu is
  // gone (a scroll or window switch closed it) or after the pointer moved on
  // to a sibling item whose own submenu is showing: nothing opens then.
  if (anchor && !anchor.isConnected) return { close() {}, menu: null };
  // An anchor inside an open menu makes this a submenu of it; anything else
  // starts again from one menu.
  const parent = panelAt(anchor);
  if (parent >= 0) {
    // A sibling's submenu is showing and holds the user's focus: this late one does not replace it.
    const showing = chain[parent + 1];
    const active = document.activeElement;
    if (showing && showing.anchor !== anchor && (active === showing.anchor || showing.panel.contains(active))) return { close() {}, menu: null };
  }
  if (parent === -1) {
    closeMenu();
    if (clickClosedMenu(anchor)) return { close() {}, menu: null };
    reclosed = null;
  } else {
    closeFrom(parent + 1, { focus: false });
  }

  const menu = el('div.menu', { role, 'aria-label': label, tabindex: -1 });
  // A submenu draws its icons as the menu it came from does.
  const commandIcons = parent >= 0 ? chain[parent].panel.dataset.icons === 'command' : !!anchor?.closest?.(EDITOR_CHROME);
  if (commandIcons) menu.dataset.icons = 'command';
  if (className) menu.classList.add(className);
  if (parent >= 0) menu.classList.add('menu-sub');
  if (minWidth) menu.style.minWidth = `${minWidth}px`;

  /** This menu's place in the chain, once it is in it. */
  const depth = () => chain.findIndex((p) => p.panel === menu);

  /** Open the submenu on `item`, or leave the one already showing alone. */
  function openChild(button, item, { focus }) {
    const at = depth();
    if (at === -1 || item.disabled) return;
    // Right or Enter on an item whose submenu the mouse already opened moves into it.
    if (chain[at + 1]?.anchor === button) { if (focus) focusIn(chain[at + 1].panel, 0); return; }
    closeFrom(at + 1, { focus: false });
    if (item.items) openMenu({ anchor: button, items: item.items, label: item.submenuLabel || String(item.label), minWidth: item.submenuMinWidth || null, focusFirst: focus });
    else item.submenu(button, { focusFirst: focus });
  }

  const buttons = [];
  // Items under a header form a group named by it, so assistive technology reads the header with them.
  let group = null;
  const place = (node) => (group || menu).append(node);
  for (const item of items) {
    if (!item) continue;
    if (item.separator) { group = null; menu.append(el('div.menu-sep', { role: 'separator' })); continue; }
    if (item.header) {
      const header = el('div.menu-header', { id: `menu-header-${++headerId}` }, item.header);
      menu.append(header);
      group = el('div.menu-group', { role: 'group', 'aria-labelledby': header.id });
      menu.append(group);
      continue;
    }
    if (item.note) {
      // A menu may hold only items, groups and separators; prose about the menu describes the menu itself.
      const note = el('div.menu-note', { role: 'none', id: `menu-note-${++noteSequence}` }, item.note);
      menu.setAttribute('aria-describedby', [menu.getAttribute('aria-describedby'), note.id].filter(Boolean).join(' '));
      place(note);
      continue;
    }
    if (item.custom) { place(item.custom); continue; }
    const isCheck = item.checked !== undefined;
    const opensChild = !!(item.items?.length || item.submenu);
    const btn = el('button', {
      type: 'button',
      role: isCheck ? (item.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem',
      'aria-checked': isCheck ? String(!!item.checked) : null,
      'aria-keyshortcuts': item.shortcut ? ariaKeyshortcuts(item.shortcut) : null,
      'aria-haspopup': opensChild ? item.popupRole || 'menu' : null,
      'aria-expanded': opensChild ? 'false' : null,
      disabled: !!item.disabled,
      tabindex: -1,
      className: `menu-item${item.danger ? ' danger' : ''}${item.checked ? ' checked' : ''}`,
      onclick: () => {
        if (item.disabled) return;
        if (opensChild) { openChild(btn, item, { focus: true }); return; }
        closeFrom(0);
        item.onSelect?.();
      },
      // Focus follows the mouse so that the keyboard carries on from wherever
      // it is, and so an item with a submenu can show it without being clicked.
      onpointerenter: (e) => {
        if (e.pointerType && e.pointerType !== 'mouse') return;
        const at = depth();
        if (at === -1) return;
        clearTimeout(hoverTimer);
        btn.focus({ preventScroll: true });
        if (opensChild) hoverTimer = setTimeout(() => { if (btn.isConnected) openChild(btn, item, { focus: false }); }, HOVER_OPEN_MS);
        else if (chain.length > at + 1) hoverTimer = setTimeout(() => closeFrom(at + 1, { focus: false }), HOVER_CLOSE_MS);
      },
    },
      el('span.menu-icon', { html: isCheck ? (item.checked ? icon('check', 16, 2.2) : '') : (item.icon ? menuIcon(item.icon, commandIcons) : '') }),
      // A gallery choice shows a large picture of itself beside its name.
      item.picture && el('span.menu-picture', { 'aria-hidden': 'true', html: commandIcon(item.picture, 32) || '' }),
      // A color choice shows its color beside its name.
      item.swatch && el(item.swatch === 'none' ? 'span.menu-swatch.is-none' : 'span.menu-swatch', { 'aria-hidden': 'true', style: item.swatch === 'none' ? null : { background: item.swatch } }),
      // A command that opens a dialog ends in an ellipsis; only a submenu shows an arrow.
      el('span.menu-label', { style: item.labelStyle || null }, item.label, item.ellipsis && !String(item.label).endsWith('…') && el('span', { 'aria-hidden': 'true' }, '…'), item.hint && el('span.menu-hint', {}, item.hint)),
      item.shortcut && el('span.menu-shortcut', { 'aria-hidden': 'true' }, item.shortcut),
      opensChild && item.popupRole !== 'dialog' && el('span.menu-arrow', { 'aria-hidden': 'true', html: icon('chevR', 15) }));
    buttons.push(btn);
    place(btn);
  }

  // A submenu hands focus back to the item it opened from, whatever had focus
  // when it was built (a menu that reads the document first replaces a
  // placeholder, and that placeholder is gone by then). Any other menu hands
  // it back to whatever had it.
  const opener = parent >= 0 ? anchor : (document.activeElement instanceof HTMLElement ? document.activeElement : anchor);
  document.body.append(menu);
  position(menu, anchor, x, y, align, parent >= 0 ? chain[parent].panel : null);

  function dispose({ focus = true } = {}) {
    const at = depth();
    if (at === -1) return;
    chain.splice(at, 1);
    menu.remove();
    anchor?.setAttribute?.('aria-expanded', 'false');
    if (!chain.length) stopListening();
    if (restoreFocus && focus && opener?.isConnected) opener.focus({ preventScroll: true });
    onClose?.();
  }

  anchor?.setAttribute?.('aria-expanded', 'true');
  chain.push({ panel: menu, anchor: anchor || null, dispose, closeOnWindowBlur });
  startListening();
  // A menu opened by the pointer starts with no item chosen, as a native context menu does; the keyboard
  // picks up from the menu itself. Focus moved from a text field would otherwise ring its first item.
  if (pointer || pointerLast) menu.dataset.pointer = '';
  if (pointer) menu.focus();
  else if (focusFirst && focusables(menu).length) focusIn(menu, 0);
  else if (focusFirst) menu.focus();
  return { close: () => { const at = depth(); if (at !== -1) closeFrom(at); }, menu };
}

function focusables(menu) {
  return [...menu.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter((b) => !b.closest('[hidden]') && (!b.closest('.menu-custom-grid') || b.matches('.swatch')));
}

function focusIn(menu, i) {
  const enabled = focusables(menu);
  if (!enabled.length) return;
  const n = ((i % enabled.length) + enabled.length) % enabled.length;
  let target = enabled[n];
  // A radio group is one item: arriving at it lands on its chosen option.
  const group = target.closest('[role="radiogroup"]');
  if (group) target = group.querySelector('[role="radio"][aria-checked="true"]:not([disabled])') || target;
  target.focus();
}

/* ---------- One set of listeners for the whole chain ---------- */

let openWidth = 0;
let openedAt = 0;
function startListening() {
  if (listening) return;
  listening = true;
  openWidth = window.innerWidth;
  openedAt = performance.now();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('blur', onWindowBlur);
}

function stopListening() {
  listening = false;
  clearTimeout(hoverTimer);
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('scroll', onScroll, { capture: true });
  window.removeEventListener('resize', onResize);
  window.removeEventListener('blur', onWindowBlur);
}

/**
 * A menu is placed against its anchor; when the list or page under it scrolls
 * away, the menu would float loose, so it closes as native menus do. A menu's
 * own capped list scrolls freely, and so does anything while a field in the
 * menu has the focus (a phone scrolling the field into view over its keyboard).
 */
function onScroll(e) {
  if (performance.now() - openedAt < 150) return;
  if (panelAt(e.target) !== -1 || panelAt(document.activeElement) !== -1 && document.activeElement.matches('input, textarea, select')) return;
  closeMenu();
}

/**
 * A menu is placed for the window it opened in, so a resize closes it. A
 * phone's keyboard rising only shortens the window, and it rises because a
 * field in the menu was tapped: that menu stays for the typing.
 */
function onResize() {
  const field = document.activeElement?.matches?.('input, textarea, select, [contenteditable]') ? document.activeElement : null;
  const typing = window.innerWidth === openWidth && !!field && chain.some((entry) => entry.panel.contains(field));
  if (!typing) closeMenu();
}

function onWindowBlur() {
  // A palette whose native color picker takes the window's focus asks to
  // stay, wherever it sits in the chain: closing the menu it opened from
  // would take it along.
  if (chain.every((entry) => entry.closeOnWindowBlur)) closeMenu();
}

function onOutside(e) {
  if (panelAt(e.target) !== -1) return;
  const anchor = chain[0]?.anchor;
  if (anchor && e.target instanceof Node && anchor.contains(e.target)) {
    reclosed = { anchor, until: performance.now() + 600 };
    document.addEventListener('click', () => { if (reclosed?.anchor === anchor) reclosed = null; }, { once: true });
  }
  // A press on a dialog's scrim dismisses the menu opened from that dialog (a color palette); the click the
  // same press ends with must not also dismiss the dialog and the settings in it.
  const scrim = e.target instanceof Element ? e.target.closest('.modal-scrim') : null;
  if (scrim) {
    const swallow = (click) => { if (scrim.contains(click.target)) click.stopPropagation(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 600);
  }
  closeMenu();
}

function onKey(e) {
  const before = document.activeElement;
  handleKey(e);
  // The keyboard moved on within a menu whose submenu the mouse had opened beside another item: that submenu goes.
  const after = document.activeElement;
  if (after === before) return;
  const at = panelAt(after);
  if (at !== -1 && chain[at + 1] && chain[at + 1].anchor !== after) closeFrom(at + 1, { focus: false });
}

function handleKey(e) {
  if (isComposing(e) || !chain.length) return;
  for (const { panel } of chain) delete panel.dataset.pointer;
  // Keys belong to the menu the focus is in, and to the innermost one when
  // focus has gone elsewhere (a menu opened by the mouse and never entered).
  const at = Math.max(0, panelAt(document.activeElement) === -1 ? chain.length - 1 : panelAt(document.activeElement));
  const menu = chain[at].panel;
  const enabled = focusables(menu);
  const index = enabled.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFrom(at); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    const form = document.activeElement?.closest('form');
    const next = enabled[index + (e.shiftKey ? -1 : 1)];
    if (next && (menu.getAttribute('role') === 'dialog' || form?.contains(next))) next.focus();
    else closeMenu();
    return;
  }
  // Non-modal form popovers retain native cursor, select and text editing keys.
  if (menu.getAttribute('role') === 'dialog') return;
  // A field keeps its own keys; Up and Down leave a color or text field for
  // the items around it, since neither field has a use for them.
  const field = document.activeElement?.matches?.('input, select') ? document.activeElement : null;
  if (field && !(['ArrowUp', 'ArrowDown'].includes(e.key) && field.matches('input[type="color"], input[type="text"]'))) return;
  const parentItem = document.activeElement?.closest?.('.menu-item[aria-haspopup]');
  if (e.key === 'ArrowRight' && parentItem) { e.preventDefault(); e.stopPropagation(); parentItem.click(); return; }
  const grid = document.activeElement?.closest('.menu-custom-grid[data-columns]');
  // Left closes a submenu, except inside a grid or radio group, where it moves within it.
  if (e.key === 'ArrowLeft' && at > 0 && !grid && !document.activeElement?.closest('[role="radiogroup"]')) { e.preventDefault(); e.stopPropagation(); closeFrom(at); return; }
  if (grid && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    const columns = Number(grid.dataset.columns) || 1;
    const cells = enabled.filter((b) => grid.contains(b));
    const cell = cells.indexOf(document.activeElement);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[e.key];
    e.preventDefault();
    if (e.key === 'ArrowDown' && cell + step >= cells.length) focusIn(menu, enabled.indexOf(cells.at(-1)) + 1);
    else if (e.key === 'ArrowUp' && cell + step < 0) focusIn(menu, enabled.indexOf(cells[0]) - 1);
    else cells[(cell + step + cells.length) % cells.length]?.focus();
    return;
  }
  // Up and Down step over a radio group as a whole; its own Left and Right pick within it.
  const group = document.activeElement?.closest('[role="radiogroup"]');
  const members = group ? enabled.filter((b) => group.contains(b)) : null;
  if (e.key === 'ArrowDown') { e.preventDefault(); focusIn(menu, (members ? enabled.indexOf(members.at(-1)) : index) + 1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); focusIn(menu, (members ? enabled.indexOf(members[0]) : index === -1 ? 0 : index) - 1); return; }
  if (e.key === 'Home') { e.preventDefault(); focusIn(menu, 0); return; }
  if (e.key === 'End') { e.preventDefault(); focusIn(menu, -1); return; }
  if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    const ch = e.key.toLowerCase();
    for (let k = 0; k < enabled.length; k++) {
      const b = enabled[(index + 1 + k) % enabled.length];
      if ((b.getAttribute('aria-label') || b.textContent).trim().toLowerCase().startsWith(ch)) { b.focus(); break; }
    }
  }
}

/**
 * Below the anchor, left edges aligned, by default. A menu that does not fit
 * below goes above when there is room there; otherwise it stays on the side
 * with more room and scrolls, so it never slides up over its own anchor (a
 * menu bar's other names must stay reachable while one menu is open).
 * A submenu opens beside its item instead, on whichever side it fits.
 */
/** How far the status bar, notch and home indicator reach into the page in a home-screen app; zero in a browser tab. */
function safeInsets() {
  const style = getComputedStyle(document.documentElement);
  const px = (name) => { const v = parseFloat(style.getPropertyValue(name)); return Number.isFinite(v) && v > 0 ? v : 0; };
  return { top: px('--safe-t'), right: px('--safe-r'), bottom: px('--safe-b'), left: px('--safe-l') };
}

function position(menu, anchor, x, y, align, parentPanel) {
  const pad = 8;
  // A menu pushed to an edge of the window stays clear of what overlays that edge, like the rest of the shell does.
  const safe = safeInsets();
  const padT = pad + safe.top, padR = pad + safe.right, padB = pad + safe.bottom, padL = pad + safe.left;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  let height = rect.height;
  let left;
  let top;
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
    if (left + rect.width > vw - padR) {
      const other = p.left - rect.width + 1;
      // On a narrow screen neither side has room; the submenu then sits over
      // the menu it came from, edges aligned, and reads as a step inwards.
      left = other >= padL ? other : p.left;
    }
    // The first item lines up with the item that opened it.
    top = a.top - 6;
    if (height > vh - padT - padB) cap(vh - padT - padB);
  } else if (x != null && y != null) {
    left = x;
    top = y;
    // Opened at the pointer: flip to the other side of the point when the
    // menu would run off the window, as native context menus do, rather than
    // sliding back over the point that was clicked.
    if (top + height > vh - padB && y - height >= padT) top = y - height;
    if (left + rect.width > vw - padR && x - rect.width >= padL) left = x - rect.width;
  } else if (anchor) {
    const a = anchor.getBoundingClientRect();
    if (align === 'auto') align = a.left + a.width / 2 > vw / 2 ? 'end' : 'start';
    left = align === 'end' ? a.right - rect.width : a.left;
    top = a.bottom + 4;
    const below = vh - padB - top;
    const above = a.top - 4 - padT;
    if (height > below) {
      if (height <= above) top = a.top - 4 - height;
      else if (above > below) { cap(above); top = a.top - 4 - height; }
      else cap(below);
    }
  } else {
    left = (vw - rect.width) / 2;
    top = (vh - height) / 2;
  }
  if (height > vh - padT - padB) cap(vh - padT - padB);
  if (left + rect.width > vw - padR) left = Math.max(padL, vw - padR - rect.width);
  if (left < padL) left = padL;
  if (top + height > vh - padB) top = Math.max(padT, vh - padB - height);
  if (top < padT) top = padT;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}
