/**
 * Menu bar and popup menus following the WAI-ARIA menubar pattern:
 * Left/Right move across the bar, Down/Enter/Space open, Up/Down move in
 * a menu, Right opens a submenu, Left/Escape close, Home/End jump, and
 * typing a letter moves to the next item starting with it.
 */
import { h } from '../lib/dom.js';
import { icon } from './icons.js';

/**
 * A pointer entering because it touched down there: a finger, or a pen that
 * cannot hover (it enters as it lands, with its tip pressed). Its tap opens
 * menus with the click instead.
 */
const landed = (e) => e.pointerType === 'touch' || (e.pointerType === 'pen' && e.buttons > 0);

/** Resolve a menu spec into concrete entries for the current app state. */
export function resolveItems(app, spec) {
  const out = [];
  for (const item of spec) {
    if (item === '-') {
      if (out.length && out[out.length - 1].type !== 'sep') out.push({ type: 'sep' });
      continue;
    }
    if (typeof item === 'string') {
      const cmd = app.commands.get(item);
      if (!cmd) continue;
      out.push({
        type: 'cmd',
        id: item,
        label: app.commands.label(item),
        shortcut: app.commands.shortcutLabel(item),
        enabled: app.commands.isEnabled(item),
        checked: cmd.checked ? app.commands.isChecked(item) : null,
      });
      continue;
    }
    if (item.id && !item.submenu) {
      // A command with a label for this context (e.g. "Make Clipping Mask" in the context menu).
      const [entry] = resolveItems(app, [item.id]);
      if (entry) out.push({ ...entry, label: item.label || entry.label });
      continue;
    }
    if (item.submenu) {
      const sub = resolveItems(app, item.submenu);
      if (sub.some((s) => s.type !== 'sep')) out.push({ type: 'sub', label: item.label, items: sub });
      continue;
    }
    if (item.source) {
      // A dynamic submenu a feature module provides: app.menuSources.set(name, (app) => items).
      const fn = app.menuSources?.get(item.source);
      if (!fn) continue;
      const sub = resolveItems(app, fn(app) || []);
      out.push({ type: 'sub', label: item.label, items: sub.length ? sub : [{ type: 'cmd', label: 'None', enabled: false }] });
      continue;
    }
    if (item.items) {
      const sub = item.items(app);
      out.push({ type: 'sub', label: item.label, items: sub.length ? sub : [{ type: 'cmd', label: 'None', enabled: false }] });
      continue;
    }
    if (item.run) out.push({ type: 'cmd', label: item.label, run: item.run, enabled: item.enabled !== false, checked: item.checked ?? null, shortcut: item.shortcut || '' });
  }
  while (out.length && out[out.length - 1].type === 'sep') out.pop();
  return out;
}

/**
 * A popup menu. `onClose(reason)` is called once when it closes.
 * Returns { el, close, focusFirst }.
 */
export function openMenu(app, items, { x, y, anchor, onClose, parentMenu = null, label = 'Menu', focus = 'first', above = false } = {}) {
  const menu = h('div.menu', { role: 'menu', 'aria-label': label, tabindex: '-1' });
  const rows = [];
  let submenu = null;
  let closed = false;

  const closeSub = () => {
    if (submenu) {
      submenu.close('sub');
      submenu = null;
    }
  };

  const close = (reason = 'close') => {
    if (closed) return;
    closed = true;
    closeSub();
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    onClose?.(reason);
  };

  // Where focus goes after a command runs (and where dialogs return it):
  // the document for menu bar commands, otherwise what had focus before.
  const returnFocus = parentMenu ? null : anchor?.closest?.('.menubar') ? (app.editor ? app.canvasHost : anchor) : document.activeElement;

  const activate = async (item) => {
    if (!item.enabled) return;
    let root = api;
    while (root.parentMenu) root = root.parentMenu;
    close('activate');
    parentMenu?.closeAll?.();
    const back = root.returnFocus;
    if (back?.isConnected && back !== document.body && (document.activeElement === document.body || !document.activeElement)) back.focus({ preventScroll: true });
    if (item.run) item.run(app);
    else if (item.id) await app.commands.run(item.id);
  };

  for (const item of items) {
    if (item.type === 'sep') {
      menu.append(h('div.menu-sep', { role: 'separator' }));
      continue;
    }
    const isSub = item.type === 'sub';
    const role = item.checked != null ? 'menuitemcheckbox' : 'menuitem';
    const row = h(
      'div.menu-item',
      {
        role,
        tabindex: '-1',
        'aria-disabled': item.enabled === false ? 'true' : null,
        'aria-checked': item.checked != null ? String(Boolean(item.checked)) : null,
        'aria-haspopup': isSub ? 'menu' : null,
        'aria-expanded': isSub ? 'false' : null,
      },
      h('span.menu-check', item.checked ? icon('check', 14) : null),
      h('span.menu-label', item.label),
      h('span.menu-shortcut', item.shortcut || ''),
      isSub ? h('span.menu-arrow', icon('chevron-right', 14)) : null,
    );
    row._item = item;
    if (isSub) {
      const openSub = (focusFirst) => {
        if (submenu?.row === row) {
          // Already open from hovering: the keyboard moves into it.
          if (focusFirst) submenu.focusFirst();
          return;
        }
        closeSub();
        const r = row.getBoundingClientRect();
        row.setAttribute('aria-expanded', 'true');
        submenu = openMenu(app, item.items, {
          x: r.right - 2,
          y: r.top - 4,
          label: item.label,
          parentMenu: api,
          focus: focusFirst ? 'first' : 'none',
          onClose: () => row.setAttribute('aria-expanded', 'false'),
        });
        submenu.row = row;
      };
      // Hovering opens the submenu and keeps focus on its row, so Right or Enter moves into it.
      // A touch, or a pen that cannot hover, opens it with the tap instead: opened
      // as the finger lands, the submenu (which covers its menu on a phone) took
      // the tap and opened the row under the finger too.
      row.addEventListener('pointerenter', (e) => {
        if (landed(e)) return;
        row.focus();
        openSub(false);
      });
      row.addEventListener('click', () => openSub(true));
      row._open = openSub;
    } else {
      row.addEventListener('pointerenter', () => {
        closeSub();
        row.focus();
      });
      row.addEventListener('click', () => activate(item));
    }
    rows.push(row);
    menu.append(row);
  }

  const focusable = () => rows.filter((r) => r._item.enabled !== false || r._item.type === 'sub');
  const move = (dir) => {
    const list = focusable();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    const next = list[(i + dir + list.length) % list.length] || list[0];
    next.focus();
  };

  menu.addEventListener('keydown', (e) => {
    const row = document.activeElement?.closest?.('.menu-item');
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        focusable()[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        focusable().slice(-1)[0]?.focus();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (row?._open) row._open(true);
        else if (!parentMenu) api.onNavigate?.(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (parentMenu) {
          close('back');
          parentMenu.refocus();
        } else api.onNavigate?.(-1);
        break;
      case 'Escape':
        e.preventDefault();
        close('escape');
        if (parentMenu) parentMenu.refocus();
        else {
          // Back to the button that opened the menu (or what had focus before a context menu).
          const back = anchor?.isConnected ? anchor : returnFocus;
          if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
        }
        break;
      case 'Tab': {
        // Close the menus and put focus back on the menu's button without
        // preventing the key: Tab then moves on from there, as the menubar
        // pattern asks (focus used to drop to the page).
        let root = api;
        while (root.parentMenu) root = root.parentMenu;
        const back = root.anchor?.isConnected ? root.anchor : root.returnFocus;
        close('tab');
        parentMenu?.closeAll?.();
        if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (row?._open) row._open(true);
        else if (row) activate(row._item);
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const list = focusable();
          const i = list.indexOf(document.activeElement);
          const k = e.key.toLowerCase();
          for (let j = 1; j <= list.length; j++) {
            const r = list[(i + j) % list.length];
            if (r._item.label.toLowerCase().startsWith(k)) {
              r.focus();
              break;
            }
          }
        }
    }
    e.stopPropagation();
  });

  const outside = (e) => {
    if (menu.contains(e.target)) return;
    let sub = submenu;
    while (sub) {
      if (sub.el.contains(e.target)) return;
      sub = sub.child;
    }
    if (anchor && anchor.contains(e.target)) return;
    if (!parentMenu) close('outside');
  };
  document.addEventListener('pointerdown', outside, true);

  document.body.append(menu);
  // Position within the viewport.
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x ?? 0;
  // `above`: open upward from y (menus anchored to the status bar).
  let top = above ? Math.max(4, (y ?? 0) - mh) : y ?? 0;
  if (left + mw > vw - 4) left = parentMenu ? Math.max(4, left - mw - (parentMenu.el.offsetWidth - 4)) : Math.max(4, vw - mw - 4);
  if (top + mh > vh - 4) {
    // A menu dropping from its button never covers the button (moved over
    // the menu bar it would open whatever lands under the pointer): it
    // scrolls below the button, or opens above it when there is more room.
    if (anchor && !above) {
      const a = anchor.getBoundingClientRect();
      const below = vh - top - 4;
      const aboveRoom = a.top - 8;
      if (aboveRoom > below) {
        top = Math.max(4, a.top - 4 - mh);
        if (mh > aboveRoom) menu.style.maxHeight = `${aboveRoom}px`;
      } else menu.style.maxHeight = `${below}px`;
    } else top = Math.max(4, vh - mh - 4);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const api = {
    el: menu,
    close,
    parentMenu,
    returnFocus,
    anchor,
    child: null,
    refocus: () => {
      const r = submenu?.row;
      submenu = null;
      (r || focusable()[0])?.focus();
    },
    closeAll: () => {
      close('activate');
      parentMenu?.closeAll?.();
    },
    focusFirst: () => (focusable()[0] || menu).focus(),
    onNavigate: null,
  };
  if (parentMenu) parentMenu.child = api;
  if (focus === 'first') (focusable()[0] || menu).focus();
  else if (focus === 'last') (focusable().slice(-1)[0] || menu).focus();
  else if (!parentMenu) menu.focus({ preventScroll: true });
  return api;
}

/** The application menu bar. */
export function createMenubar(app, menus) {
  const bar = h('div.menubar', { role: 'menubar', 'aria-label': 'Application menu' });
  const buttons = [];
  let open = null;
  let openIndex = -1;

  // One tab stop (roving tabindex): the menu last opened or moved to.
  const rove = (i) => buttons.forEach((b, j) => (b.tabIndex = j === i ? 0 : -1));

  const openAt = (i, focus = 'first') => {
    if (open) open.close('switch');
    const btn = buttons[i];
    rove(i);
    const r = btn.getBoundingClientRect();
    openIndex = i;
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('open');
    const items = resolveItems(app, menus[i].submenu);
    const m = openMenu(app, items, {
      x: r.left,
      y: r.bottom + 2,
      anchor: btn,
      label: menus[i].label,
      focus,
      onClose: (reason) => {
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('open');
        if (open === m) {
          open = null;
          openIndex = -1;
        }
        if (reason === 'escape') btn.focus();
      },
    });
    m.onNavigate = (dir) => {
      const next = (i + dir + buttons.length) % buttons.length;
      openAt(next);
    };
    open = m;
  };

  menus.forEach((m, i) => {
    const btn = h(
      'button.menubar-item',
      {
        type: 'button',
        role: 'menuitem',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        tabindex: i === 0 ? '0' : '-1',
        onclick: () => (open && openIndex === i ? open.close('toggle') : openAt(i)),
        // Moving across the bar switches menus; a touch or a pen switches with its tap (opened
        // as it landed, the menu was then closed again by the tap's click).
        onpointerenter: (e) => {
          if (open && openIndex !== i && !landed(e)) openAt(i, 'none');
        },
        onkeydown: (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
            rove(next);
            buttons[next].focus();
          } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openAt(i);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openAt(i, 'last');
          }
        },
      },
      m.label,
    );
    buttons.push(btn);
    bar.append(btn);
  });
  return bar;
}

/** Show a context menu at a client point. */
/** Keep only enabled commands (and non-empty submenus), tidying separators. */
export function applicableItems(items) {
  const out = [];
  for (const it of items) {
    if (it.type === 'sep') {
      if (out.length && out[out.length - 1].type !== 'sep') out.push(it);
      continue;
    }
    if (it.type === 'sub') {
      const sub = applicableItems(it.items);
      if (sub.length) out.push({ ...it, items: sub });
      continue;
    }
    if (it.enabled !== false) out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'sep') out.pop();
  return out;
}

/** Canvas context menu: it lists only what applies right now. */
export function contextMenu(app, spec, x, y, label = 'Context menu') {
  const items = applicableItems(resolveItems(app, spec));
  if (!items.length) return null;
  return openMenu(app, items, { x, y, label });
}
