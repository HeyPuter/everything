// Menus: a menubar with dropdowns, context menus, and keyboard "accelerator"
// chords. A label marks its accelerator with '&' ('&Place'); pressing that
// letter while the menu is open activates the item, so 'P' then 'W' runs
// Place > Wire without touching the mouse.
//
// Item shapes:
//   { label, command }                      run a registered command
//   { label, run, shortcut, icon, checked, disabled }
//   { label, items: [...] }                 submenu
//   { separator: true } | { heading: 'Text' }
//   items may be a function returning an array (built when opened)

import { h, shortcutLabel } from './dom.js';
import { icon } from './icons.js';

function parseLabel(label) {
  const i = label.indexOf('&');
  if (i < 0 || i === label.length - 1) return { text: label, accel: null, nodes: [label] };
  const accel = label[i + 1].toLowerCase();
  return { text: label.replace('&', ''), accel, nodes: [label.slice(0, i), h('span.accel', label[i + 1]), label.slice(i + 2)] };
}

let openStack = [];
let commands = null;

/** Gives menus access to the command registry (labels, shortcuts, state). */
export function setMenuCommands(registry) { commands = registry; }

function resolveItem(item) {
  if (item.command && commands) {
    const c = commands.get(item.command);
    if (!c) return null;
    if (c.visible && !c.visible()) return null;
    return {
      ...item,
      label: item.label || c.menuLabel || c.label,
      icon: item.icon ?? c.icon,
      shortcut: item.shortcut ?? c.shortcutLabel ?? c.shortcut,
      disabled: c.enabled ? !c.enabled() : false,
      checked: c.checked ? c.checked() : undefined,
      run: () => commands.run(item.command),
    };
  }
  return item;
}

export function closeMenus(depth = 0) {
  while (openStack.length > depth) {
    const m = openStack.pop();
    m.el.remove();
    m.onClose?.();
  }
  if (!openStack.length) document.removeEventListener('pointerdown', onOutside, true);
}

function onOutside(e) {
  if (openStack.some((m) => m.el.contains(e.target) || m.anchor?.contains(e.target))) return;
  closeMenus();
}

/**
 * Opens a menu at a point or under an anchor element.
 * @returns {{el:HTMLElement, close:Function}}
 */
export function openMenu(items, { x, y, anchor, depth = 0, label = 'Menu', onClose, focusFirst = true, chord = false } = {}) {
  // Where focus goes back to when the menu closes from the keyboard or runs an
  // item: the element focused before the menu opened (the canvas for a chord),
  // kept while moving between menubar menus.
  const before = document.activeElement;
  const inherit = openStack[0]?.el.contains(before);
  const returnFocus = depth > 0 ? null : inherit ? openStack[0].returnFocus : before;
  closeMenus(depth);
  const list = (typeof items === 'function' ? items() : items).map((it) => (it.separator || it.heading ? it : resolveItem(it))).filter(Boolean);
  // Drop leading, trailing and doubled separators left by hidden items.
  const clean = list.filter((it, i, a) => !(it.separator && (i === 0 || i === a.length - 1 || a[i - 1]?.separator)));
  const el = h('div.menu', { role: 'menu', 'aria-label': label.replace('&', ''), tabindex: -1 });
  const entries = [];
  for (const it of clean) {
    if (it.separator) { el.append(h('div.menu-sep', { role: 'separator' })); continue; }
    if (it.heading) { el.append(h('div.menu-head', { role: 'presentation' }, it.heading)); continue; }
    const { nodes, accel, text } = parseLabel(it.label);
    const hasSub = !!it.items;
    const role = it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem';
    const btn = h('button.menu-item', {
      role, type: 'button', tabindex: -1,
      'aria-disabled': it.disabled ? 'true' : null,
      'aria-checked': it.checked !== undefined ? String(!!it.checked) : null,
      'aria-haspopup': hasSub ? 'menu' : null,
    },
    h('span', { 'aria-hidden': 'true' }, it.checked ? icon('check', 14, 'check') : it.icon ? icon(it.icon, 15) : null),
    h('span.lbl', nodes),
    h('span.kbd', hasSub ? '' : shortcutLabel(it.shortcut)),
    hasSub ? icon('chevron-right', 13) : h('span'));
    const entry = { it, btn, accel, text };
    entries.push(entry);
    btn.addEventListener('click', (e) => { e.stopPropagation(); activate(entry); });
    btn.addEventListener('pointerenter', () => { focusEntry(entry); if (hasSub) openSub(entry); else closeMenus(depth + 1); });
    el.append(btn);
  }
  if (!entries.length) el.append(h('div.menu-head', 'No items'));
  document.body.append(el);

  // Position inside the viewport.
  const r = el.getBoundingClientRect();
  let left = x ?? 0, top = y ?? 0;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = depth > 0 ? a.right - 2 : a.left;
    top = depth > 0 ? a.top - 4 : a.bottom + 2;
  }
  if (left + r.width > innerWidth - 4) left = Math.max(4, depth > 0 && anchor ? anchor.getBoundingClientRect().left - r.width + 2 : innerWidth - r.width - 4);
  if (top + r.height > innerHeight - 4) top = Math.max(4, innerHeight - r.height - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const state = { el, anchor, entries, onClose, focused: -1, returnFocus };
  openStack.push(state);
  if (openStack.length === 1) document.addEventListener('pointerdown', onOutside, true);

  function focusEntry(entry) {
    state.focused = entries.indexOf(entry);
    for (const e of entries) e.btn.classList.toggle('focus', e === entry);
    entry.btn.focus({ preventScroll: true });
  }
  function openSub(entry) {
    openMenu(entry.it.items, { anchor: entry.btn, depth: depth + 1, label: entry.text, focusFirst: false });
  }
  function activate(entry) {
    if (entry.it.disabled) return;
    if (entry.it.items) { openSub(entry); const sub = openStack[depth + 1]; sub?.entries[0] && sub.entries[0].btn.focus(); return; }
    const back = openStack[0]?.returnFocus;
    closeMenus();
    restoreFocus(back);
    entry.it.run?.();
  }
  el.addEventListener('keydown', (e) => {
    const n = entries.length;
    if (!n) { if (e.key === 'Escape') closeMenus(depth); return; }
    const move = (d) => {
      let i = state.focused;
      for (let k = 0; k < n; k++) { i = (i + d + n) % n; if (!entries[i].it.disabled) break; }
      focusEntry(entries[i]);
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); state.focused = -1; move(1); }
    else if (e.key === 'End') { e.preventDefault(); state.focused = 0; move(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (state.focused >= 0) activate(entries[state.focused]); }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = entries[state.focused];
      if (cur?.it.items) activate(cur);
      else if (depth === 0) state.onArrow?.(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (depth > 0) { closeMenus(depth); openStack[depth - 1]?.entries[openStack[depth - 1].focused]?.btn.focus(); }
      else state.onArrow?.(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenus(depth);
      if (depth > 0) openStack[depth - 1]?.entries[openStack[depth - 1].focused]?.btn.focus();
      else if (!restoreFocus(returnFocus)) anchor?.focus?.();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const back = openStack[0]?.returnFocus;
      closeMenus();
      restoreFocus(back);
    }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const byAccel = entries.filter((x) => x.accel === k && !x.it.disabled);
      const match = byAccel[0] || entries.find((x) => x.text.toLowerCase().startsWith(k) && !x.it.disabled);
      if (match) { e.preventDefault(); e.stopPropagation(); focusEntry(match); if (byAccel.length <= 1) activate(match); }
    }
    e.stopPropagation();
  });
  if (focusFirst || chord) {
    const first = entries.find((x) => !x.it.disabled);
    if (first) focusEntry(first); else el.focus();
  }
  return { el, close: () => closeMenus(depth), state };
}

/** Focuses el if it is still in the page; returns whether it did. */
function restoreFocus(el) {
  if (!el || el === document.body || !el.isConnected || !el.focus) return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

export const isMenuOpen = () => openStack.length > 0;

/**
 * Menubar. menus: [{ label: '&File', items: [...] | () => [...] }]
 * Returns { el, setMenus(menus), openByAccel(letter) }.
 */
export function createMenubar() {
  // The menubar sits in a navigation landmark (a role on the nav itself would
  // replace the landmark).
  const bar = h('div.menubar', { role: 'menubar', 'aria-label': 'Main menu' });
  const el = h('nav.menubar-nav', { 'aria-label': 'Main menu' }, bar);
  let menus = [];
  let buttons = [];
  let current = -1;

  const open = (i, focusFirst = true) => {
    current = i;
    buttons.forEach((b, j) => b.setAttribute('aria-expanded', String(j === i)));
    const m = openMenu(menus[i].items, {
      anchor: buttons[i], label: menus[i].label, focusFirst,
      onClose: () => { buttons[i]?.setAttribute('aria-expanded', 'false'); if (current === i) current = -1; },
    });
    m.state.onArrow = (d) => open((i + d + menus.length) % menus.length);
  };

  function setMenus(next) {
    menus = next;
    bar.replaceChildren();
    buttons = menus.map((m, i) => {
      const { nodes } = parseLabel(m.label);
      const b = h('button', { type: 'button', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: i === 0 ? 0 : -1 }, nodes);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (current === i) closeMenus(); else open(i); });
      b.addEventListener('pointerenter', () => { if (current >= 0 && current !== i) open(i, false); });
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
      });
      bar.append(b);
      return b;
    });
  }

  /** Opens the menu whose accelerator letter matches (chord start). */
  function openByAccel(letter) {
    const k = letter.toLowerCase();
    const i = menus.findIndex((m) => parseLabel(m.label).accel === k);
    if (i < 0) return false;
    open(i);
    return true;
  }

  return { el, setMenus, openByAccel, get menus() { return menus; } };
}

/** Context menu at the pointer. */
export function contextMenu(e, items, label = 'Context menu') {
  e.preventDefault?.();
  return openMenu(items, { x: e.clientX, y: e.clientY, label });
}
