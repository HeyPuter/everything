/**
 * Menu bar and popup menus following the WAI-ARIA menubar pattern:
 * Left/Right move across the bar, Down/Enter/Space open, Up/Down move in
 * a menu, Right opens a submenu, Left/Escape close, Home/End jump, and
 * typing a letter moves to the next item starting with it.
 */
import { h } from '../lib/dom.js';
import { icon } from './icons.js';

/**
 * Whether a pointerenter is a hover. A finger or pen tap enters the element
 * just before it presses, so opening a menu on that enter would put the menu
 * under the tap (which then picks one of its items, or closes it again).
 */
const hovering = (e) => e.pointerType !== 'touch' && e.pointerType !== 'pen';

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
    if (item.expand) {
      out.push(...resolveItems(app, item.expand(app)));
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
  const returnFocus = parentMenu ? null : anchor?.closest?.('.menubar') ? (app.focusTarget?.() || anchor) : document.activeElement;

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
        if (submenu?.row === row) return;
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
      row.addEventListener('pointerenter', (e) => hovering(e) && openSub(false));
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
        else restoreFocus(api);
        break;
      case 'Tab': {
        e.preventDefault();
        close('tab');
        parentMenu?.closeAll?.();
        let root = api;
        while (root.parentMenu) root = root.parentMenu;
        restoreFocus(root);
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
  // A menu dropped from a button keeps clear of it (moved up over the button,
  // a tall menu would put its first item where the button was): it scrolls in
  // the room below, or opens above when there is more room there.
  const from = !parentMenu && !above && anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  if (top + mh > vh - 4 && from) {
    const below = vh - 4 - top;
    if (below >= Math.min(mh, 160) || below >= from.top - 6) menu.style.maxHeight = `${below}px`;
    else {
      top = Math.max(4, from.top - 2 - mh);
      menu.style.maxHeight = `${from.top - 2 - top}px`;
    }
  } else if (top + mh > vh - 4) top = Math.max(4, vh - mh - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const api = {
    el: menu,
    close,
    parentMenu,
    anchor,
    returnFocus,
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
    onNavigate: null,
  };
  if (parentMenu) parentMenu.child = api;
  if (focus === 'first') (focusable()[0] || menu).focus();
  else if (focus === 'last') (focusable().slice(-1)[0] || menu).focus();
  // 'keep' leaves focus where it is (a search field that keeps taking typing).
  else if (focus !== 'keep') menu.focus({ preventScroll: true });
  return api;
}

/** After a menu is dismissed: back to the button that opened it, else to what had focus before. */
function restoreFocus(root) {
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
  const back = root.anchor?.isConnected ? root.anchor : root.returnFocus;
  if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
}

/** The application menu bar. */
export function createMenubar(app, menus) {
  const bar = h('div.menubar', { role: 'menubar', 'aria-label': 'Application menu' });
  const buttons = [];
  let open = null;
  let openIndex = -1;

  const openAt = (i, focus = 'first') => {
    if (open) open.close('switch');
    const btn = buttons[i];
    const r = btn.getBoundingClientRect();
    openIndex = i;
    // Roving tabindex follows the open menu, so Escape and Tab leave from its button.
    buttons.forEach((b, j) => (b.tabIndex = j === i ? 0 : -1));
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
        onpointerenter: (e) => {
          if (open && openIndex !== i && hovering(e)) openAt(i, 'none');
        },
        onkeydown: (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
            buttons.forEach((b) => (b.tabIndex = -1));
            buttons[next].tabIndex = 0;
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

/** Canvas context menu: like the native one, it lists only what applies right now. */
export function contextMenu(app, spec, x, y, label = 'Context menu') {
  const items = applicableItems(resolveItems(app, spec));
  if (!items.length) return null;
  return openMenu(app, items, { x, y, label });
}
