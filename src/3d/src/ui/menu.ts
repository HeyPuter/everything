// Popup menus, submenus, pie menus, search popups and tooltips.
import { h, patch, clearRoot, type VNode, type Child } from './h';
import { icon } from './icons';
import { app, operators } from '../app/app';

export interface MenuItem {
  label?: string;
  icon?: string;
  /** operator idname to run */
  op?: string;
  props?: Record<string, unknown>;
  /** custom action */
  action?: () => void;
  shortcut?: string;
  submenu?: () => MenuItem[];
  separator?: boolean;
  /** section heading */
  heading?: string;
  checked?: boolean;
  disabled?: boolean;
  /** radio-like enum item */
  active?: boolean;
  description?: string;
  /** keep menu open after click (e.g. toggles) */
  keepOpen?: boolean;
  /** custom inline content (sliders etc) */
  custom?: () => VNode;
}

let layer: HTMLElement;
function ensureLayer() {
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'popup-layer';
    document.body.append(layer);
  }
  return layer;
}

interface OpenMenu {
  el: HTMLElement;
  items: MenuItem[];
  index: number;
  parent?: OpenMenu;
  child?: OpenMenu;
  owner?: HTMLElement;
  /** typing a character hands it to this (e.g. to start a search) instead of jumping to an item */
  onType?: (ch: string) => void;
}

const stack: OpenMenu[] = [];
let closeCallbacks: (() => void)[] = [];

export function anyPopupOpen() {
  return stack.length > 0 || !!document.querySelector('.popup-layer > .popover');
}

export function closeMenus() {
  while (stack.length) {
    const m = stack.pop()!;
    clearRoot(m.el);
    m.el.remove();
  }
  document.querySelectorAll('.popup-layer > .popover').forEach((p) => p.remove());
  const cbs = closeCallbacks;
  closeCallbacks = [];
  cbs.forEach((f) => f());
}

export function onMenusClosed(fn: () => void) {
  closeCallbacks.push(fn);
}

function shortcutFor(item: MenuItem): string {
  if (item.shortcut !== undefined) return item.shortcut;
  return '';
}

function itemLabel(item: MenuItem) {
  if (item.label) return item.label;
  if (item.op) return operators.get(item.op)?.label ?? item.op;
  return '';
}

function isDisabled(item: MenuItem) {
  if (item.disabled) return true;
  if (item.op && !app.poll(item.op)) return true;
  return false;
}

function activate(m: OpenMenu, item: MenuItem, e?: MouseEvent) {
  if (isDisabled(item)) return;
  if (item.submenu) {
    openSubmenu(m, item);
    return;
  }
  if (!item.keepOpen) closeMenus();
  if (item.action) item.action();
  else if (item.op) app.run(item.op, item.props ?? {}, { event: e ? { x: e.clientX, y: e.clientY } : undefined });
  if (item.keepOpen) redrawMenus();
}

function redrawMenus() {
  for (const m of stack) renderMenu(m);
}

function renderMenu(m: OpenMenu) {
  const vnodes: Child[] = m.items.map((item, i) => {
    if (item.separator) return h('div', { class: 'menu-sep' });
    if (item.heading) return h('div', { class: 'menu-heading' }, item.heading);
    if (item.custom) return h('div', { class: 'menu-custom' }, item.custom());
    const disabled = isDisabled(item);
    const desc = item.description ?? (item.op ? operators.get(item.op)?.description : undefined);
    return h(
      'div',
      {
        class: { 'menu-item': true, hl: i === m.index, disabled, 'has-sub': !!item.submenu },
        role: 'menuitem',
        title: desc ?? '',
        'aria-disabled': disabled ? 'true' : null,
        onpointerenter: () => {
          m.index = i;
          if (item.submenu && !disabled) openSubmenu(m, item);
          else closeChild(m);
          renderMenu(m);
        },
        onpointerup: (e: PointerEvent) => {
          // releasing the press that opened any menu (e.g. a header menu opened on pointerdown) without dragging does not pick an item
          if (pressStart.time <= openedAt.time && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) < 6) return;
          // the release of the press that opened a context menu picks an item only after a drag
          const p = openPress;
          const opening = !!p && pressCount === p.presses;
          if (opening && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
          // right button: only that press-drag-release picks; other right clicks open the item's own menu
          if (e.button === 0 || (e.button === 2 && opening)) activate(m, item, e);
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (!disabled && !item.submenu) openItemContext(m, item, e.clientX, e.clientY);
        },
      },
      h('span', { class: 'mi-icon' }, item.checked !== undefined ? icon(item.checked ? 'checkbox_hlt' : 'checkbox_dehlt') : item.active ? icon('dot') : item.icon ? icon(item.icon) : null),
      h('span', { class: 'mi-label' }, itemLabel(item)),
      h('span', { class: 'mi-key' }, shortcutFor(item)),
      item.submenu ? h('span', { class: 'mi-arrow' }, icon('right_arrow')) : null,
    );
  });
  patch(m.el, vnodes);
}

function openItemContext(m: OpenMenu, item: MenuItem, x: number, y: number) {
  const items = itemContextHooks.flatMap((f) => {
    try {
      return f(item);
    } catch {
      return [];
    }
  });
  if (!items.length) return;
  closeChild(m);
  m.child = createMenu(items, x + 2, y - 4, m);
}

function closeChild(m: OpenMenu) {
  if (m.child) {
    closeChild(m.child);
    const i = stack.indexOf(m.child);
    if (i >= 0) stack.splice(i, 1);
    clearRoot(m.child.el);
    m.child.el.remove();
    m.child = undefined;
  }
}

function openSubmenu(m: OpenMenu, item: MenuItem) {
  const rowEl = m.el.children[m.items.indexOf(item)] as HTMLElement | undefined;
  if (m.child && m.child.owner === rowEl) return;
  closeChild(m);
  if (!rowEl) return;
  const r = rowEl.getBoundingClientRect();
  const sub = createMenu(item.submenu!(), r.right - 2, r.top - 4, m);
  sub.owner = rowEl;
  m.child = sub;
}

/** When the last top-level menu opened, and where/when the last press started (see item pointerup). */
const openedAt = { time: 0 };
const pressStart = { time: -1, x: 0, y: 0 };
if (typeof addEventListener === 'function')
  addEventListener(
    'pointerdown',
    (e) => {
      pressStart.time = performance.now();
      pressStart.x = e.clientX;
      pressStart.y = e.clientY;
    },
    true,
  );

function createMenu(items: MenuItem[], x: number, y: number, parent?: OpenMenu, title?: string): OpenMenu {
  if (!parent) openedAt.time = performance.now();
  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  ensureLayer().append(el);
  const m: OpenMenu = { el, items, index: -1, parent };
  if (title) el.dataset.title = title;
  renderMenu(m);
  stack.push(m);
  // position within viewport
  const rect = el.getBoundingClientRect();
  let left = x,
    top = y;
  if (left + rect.width > innerWidth - 4) left = parent ? parent.el.getBoundingClientRect().left - rect.width + 2 : innerWidth - rect.width - 4;
  if (top + rect.height > innerHeight - 4) top = Math.max(4, innerHeight - rect.height - 4);
  el.style.left = `${Math.max(4, left)}px`;
  el.style.top = `${Math.max(4, top)}px`;
  return m;
}

/** Builders of the right-click menu of a menu item (e.g. Add to Quick Favorites). */
export const itemContextHooks: ((item: MenuItem) => MenuItem[])[] = [];

let capturing: MenuItem[][] | null = null;
/** Where the last context menu was opened at the pointer, and the press count then. */
let openPress: { presses: number; x: number; y: number } | null = null;
let pressCount = 0;
if (typeof addEventListener === 'function') addEventListener('pointerdown', () => pressCount++, { capture: true, passive: true });

/**
 * Run `open` (code that would open a menu, e.g. a header button's pointer handler) and return the
 * menu's items instead of showing it. Used for collapsed header menus and menu search.
 */
export function captureMenuItems(open: () => void): MenuItem[] {
  const prev = capturing;
  capturing = [];
  try {
    open();
    return capturing[0] ?? [];
  } catch {
    return [];
  } finally {
    capturing = prev;
  }
}

/** Open a popup menu at a screen position (or below an element). */
export function openMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement, opts: { title?: string; under?: boolean; onType?: (ch: string) => void } = {}) {
  if (capturing) {
    capturing.push(items);
    return null;
  }
  closeMenus();
  let x: number, y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 1;
    at.classList.add('menu-open');
    onMenusClosed(() => at.classList.remove('menu-open'));
  } else {
    x = at.x;
    y = at.y;
  }
  const withTitle = opts.title ? [{ heading: opts.title }, ...items] : items;
  const m = createMenu(withTitle, x, y, undefined, opts.title);
  if (opts.onType) m.onType = opts.onType;
  openPress = at instanceof HTMLElement ? null : { presses: pressCount, x: at.x, y: at.y };
  // context menus open with the pointer over the first actionable item
  if (!(at instanceof HTMLElement) && !opts.under) {
    const firstIdx = withTitle.findIndex((i) => !i.heading && !i.separator);
    const row = m.el.children[firstIdx] as HTMLElement | undefined;
    if (row) {
      const rr = row.getBoundingClientRect();
      const dx = x - (rr.left + 30),
        dy = y - (rr.top + rr.height / 2);
      const left = parseFloat(m.el.style.left) + dx,
        top = parseFloat(m.el.style.top) + dy;
      m.el.style.left = `${Math.max(4, Math.min(innerWidth - m.el.offsetWidth - 4, left))}px`;
      m.el.style.top = `${Math.max(4, Math.min(innerHeight - m.el.offsetHeight - 4, top))}px`;
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Pie menus

export interface PieItem {
  label: string;
  icon?: string;
  op?: string;
  props?: Record<string, unknown>;
  action?: () => void;
  active?: boolean;
}

/** Pie menu item order: W, E, S, N, NW, NE, SW, SE. */
const PIE_DIRS = [180, 0, 270, 90, 135, 45, 225, 315];

let pie: { el: HTMLElement; items: (PieItem | null)[]; cx: number; cy: number; hl: number; opened: number; key?: string } | null = null;

export function pieOpen() {
  return !!pie;
}

export function openPie(title: string, items: (PieItem | null)[], x: number, y: number, key?: string) {
  closeMenus();
  closePie();
  const el = document.createElement('div');
  el.className = 'pie';
  ensureLayer().append(el);
  pie = { el, items, cx: x, cy: y, hl: -1, opened: performance.now(), key };
  renderPie(title);
  const move = (e: PointerEvent) => {
    if (!pie) return;
    const dx = e.clientX - pie.cx,
      dy = pie.cy - e.clientY;
    const dist = Math.hypot(dx, dy);
    let hl = -1;
    if (dist > 20) {
      const ang = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      let best = 999;
      pie.items.forEach((it, i) => {
        if (!it) return;
        const d = Math.abs(((ang - PIE_DIRS[i] + 540) % 360) - 180);
        if (d < best) {
          best = d;
          hl = i;
        }
      });
    }
    if (hl !== pie.hl) {
      pie.hl = hl;
      renderPie(title);
    }
  };
  const up = (e: PointerEvent) => {
    if (!pie) return;
    if (e.button !== 0) return;
    choosePie();
  };
  const keyup = (e: KeyboardEvent) => {
    // release of the invoking key after a drag selects the highlighted item
    if (!pie || !pie.key || e.code !== pie.key) return;
    if (performance.now() - pie.opened > 250 && pie.hl >= 0) choosePie();
  };
  const keydown = (e: KeyboardEvent) => {
    if (!pie) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePie();
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 9) {
      // numpad-style direction picking
      const map: Record<number, number> = { 4: 0, 6: 1, 2: 2, 8: 3, 7: 4, 9: 5, 1: 6, 3: 7 };
      if (map[n] !== undefined && pie.items[map[n]]) {
        pie.hl = map[n];
        e.preventDefault();
        e.stopPropagation();
        choosePie();
      }
    }
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('keyup', keyup, true);
  addEventListener('keydown', keydown, true);
  (pie as unknown as { dispose: () => void }).dispose = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('keyup', keyup, true);
    removeEventListener('keydown', keydown, true);
  };
}

function choosePie() {
  if (!pie) return;
  const it = pie.hl >= 0 ? pie.items[pie.hl] : null;
  closePie();
  if (!it) return;
  if (it.action) it.action();
  else if (it.op) app.run(it.op, it.props ?? {});
}

export function closePie() {
  if (!pie) return;
  (pie as unknown as { dispose?: () => void }).dispose?.();
  clearRoot(pie.el);
  pie.el.remove();
  pie = null;
}

function renderPie(title: string) {
  if (!pie) return;
  const R = 110;
  const p = pie;
  patch(p.el, [
    h('div', { class: 'pie-center', style: { left: `${p.cx}px`, top: `${p.cy}px` } }, h('div', { class: 'pie-ring' }), p.hl >= 0 ? h('div', { class: 'pie-dir', style: { transform: `rotate(${-PIE_DIRS[p.hl]}deg)` } }) : null),
    h('div', { class: 'pie-title', style: { left: `${p.cx}px`, top: `${p.cy - R - 46}px` } }, title),
    ...p.items.map((it, i) => {
      if (!it) return null;
      const a = (PIE_DIRS[i] * Math.PI) / 180;
      const x = p.cx + Math.cos(a) * R,
        y = p.cy - Math.sin(a) * R * 0.82;
      const align = Math.abs(Math.cos(a)) < 0.2 ? 'center' : Math.cos(a) > 0 ? 'left' : 'right';
      return h(
        'div',
        {
          class: { 'pie-item': true, hl: i === p.hl, active: !!it.active, [align]: true },
          style: { left: `${x}px`, top: `${y}px` },
          onpointerenter: () => {
            p.hl = i;
            renderPie(title);
          },
        },
        it.icon ? icon(it.icon) : null,
        h('span', null, it.label),
      );
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Popovers (panels that float under a button)

export function openPopover(anchor: HTMLElement | { x: number; y: number }, render: () => Child, opts: { width?: number; className?: string } = {}) {
  // collecting menu items (captureMenuItems) never opens popovers
  if (capturing) return { el: document.createElement('div'), redraw: () => {} };
  closeMenus();
  const el = document.createElement('div');
  el.className = `popover ${opts.className ?? ''}`;
  if (opts.width) el.style.width = `${opts.width}px`;
  ensureLayer().append(el);
  const draw = () => patch(el, render());
  draw();
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, right: anchor.x };
  const rect = el.getBoundingClientRect();
  let left = r.left;
  if (left + rect.width > innerWidth - 4) left = Math.max(4, (r as DOMRect).right - rect.width);
  let top = r.bottom + 2;
  if (top + rect.height > innerHeight - 4) top = Math.max(4, innerHeight - rect.height - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const unsub = app.subscribe(() => el.isConnected && draw());
  onMenusClosed(() => unsub());
  // close when the pointer leaves the popover by a margin
  const leave = (e: PointerEvent) => {
    if (!el.isConnected) return removeEventListener('pointermove', leave);
    if (document.activeElement && el.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    if (dragging) return;
    const b = el.getBoundingClientRect();
    const anchorRect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : null;
    const inAnchor = anchorRect && e.clientX >= anchorRect.left - 4 && e.clientX <= anchorRect.right + 4 && e.clientY >= anchorRect.top - 4 && e.clientY <= anchorRect.bottom + 4;
    const m = 60;
    if (!inAnchor && (e.clientX < b.left - m || e.clientX > b.right + m || e.clientY < b.top - m || e.clientY > b.bottom + m)) {
      removeEventListener('pointermove', leave);
      closeMenus();
    }
  };
  addEventListener('pointermove', leave);
  if (anchor instanceof HTMLElement) {
    anchor.classList.add('menu-open');
    onMenusClosed(() => anchor.classList.remove('menu-open'));
  }
  return { el, redraw: draw };
}

let dragging = false;
export function setWidgetDragging(v: boolean) {
  dragging = v;
}

// ---------------------------------------------------------------------------
// Search popup (F3 menu search / operator search)

export interface SearchEntry {
  label: string;
  path?: string;
  shortcut?: string;
  icon?: string;
  run: () => void;
  disabled?: boolean;
}

export function openSearch(entries: () => SearchEntry[], x = innerWidth / 2 - 200, y = 120, placeholder = 'Search…', initial = '') {
  closeMenus();
  const el = document.createElement('div');
  el.className = 'menu search-popup';
  ensureLayer().append(el);
  stack.push({ el, items: [], index: 0 });
  el.style.left = `${Math.max(4, Math.min(innerWidth - 420, x))}px`;
  el.style.top = `${Math.max(4, y)}px`;
  let query = initial,
    hl = 0;
  const all = entries();
  const results = () => {
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 30);
    const words = q.split(/\s+/);
    return all
      .map((e) => {
        const text = `${e.path ?? ''} ${e.label}`.toLowerCase();
        if (!words.every((w) => text.includes(w))) return null;
        // unavailable entries sort last so Enter runs the best available match
        const score = (e.disabled ? 2 : 0) + (e.label.toLowerCase().startsWith(words[0]) ? 0 : 1) + text.length / 1000;
        return { e, score };
      })
      .filter(Boolean)
      .sort((a, b) => a!.score - b!.score)
      .slice(0, 40)
      .map((x) => x!.e);
  };
  const draw = () => {
    const list = results();
    hl = Math.max(0, Math.min(hl, list.length - 1));
    patch(el, [
      h('div', { class: 'search-field' }, icon('search'), h('input', { class: 'search-input', placeholder, value: query, oninput: (e: Event) => ((query = (e.target as HTMLInputElement).value), (hl = 0), draw()), onkeydown: key })),
      ...list.map((e, i) =>
        h(
          'div',
          { class: { 'menu-item': true, hl: i === hl, disabled: !!e.disabled }, onpointerenter: () => ((hl = i), draw()), onpointerup: () => !e.disabled && (closeMenus(), e.run()) },
          h('span', { class: 'mi-icon' }, e.icon ? icon(e.icon) : null),
          h('span', { class: 'mi-label' }, e.path ? h('span', { class: 'mi-path' }, `${e.path} ▸ `) : null, e.label),
          h('span', { class: 'mi-key' }, e.shortcut ?? ''),
        ),
      ),
      list.length ? null : h('div', { class: 'menu-heading' }, 'No results'),
    ]);
  };
  const key = (e: KeyboardEvent) => {
    const list = results();
    if (e.key === 'ArrowDown') hl = Math.min(list.length - 1, hl + 1);
    else if (e.key === 'ArrowUp') hl = Math.max(0, hl - 1);
    else if (e.key === 'Enter') {
      const it = list[hl];
      if (it && !it.disabled) {
        closeMenus();
        it.run();
      }
      return;
    } else if (e.key === 'Escape') {
      closeMenus();
      return;
    } else return;
    e.preventDefault();
    draw();
  };
  draw();
  const input = el.querySelector('input') as HTMLInputElement | null;
  input?.focus();
  if (input && initial) input.setSelectionRange(initial.length, initial.length);
}

// ---------------------------------------------------------------------------
// Tooltips

let tipTimer = 0;
let tipEl: HTMLElement | null = null;

export function installTooltips(root: HTMLElement) {
  root.addEventListener('pointerover', (e) => {
    const t = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
    clearTimeout(tipTimer);
    hideTip();
    if (!t) return;
    tipTimer = window.setTimeout(() => showTip(t), 650);
  });
  root.addEventListener('pointerdown', () => {
    clearTimeout(tipTimer);
    hideTip();
  });
}

/** Extra tooltip content for an element: an optional title (when it has no tip text) and lines (e.g. the data path). */
export const tooltipHooks: ((el: HTMLElement) => { title?: string; lines: string[] } | null)[] = [];

function showTip(t: HTMLElement) {
  if (!t.isConnected || anyPopupOpen()) return;
  let text = t.dataset.tip ?? '';
  for (const hk of tooltipHooks) {
    const x = hk(t);
    if (!x) continue;
    if (!text && x.title) text = x.title;
    if (text && x.lines.length) text += `\n${x.lines.join('\n')}`;
  }
  if (!text) return;
  tipEl = document.createElement('div');
  tipEl.className = 'tooltip';
  const [title, ...rest] = text.split('\n');
  const tt = document.createElement('div');
  tt.className = 'tt-title';
  tt.textContent = title;
  tipEl.append(tt);
  for (const line of rest) {
    const d = document.createElement('div');
    d.className = line.startsWith('Python:') || line.startsWith('Shortcut:') ? 'tt-meta' : 'tt-desc';
    d.textContent = line;
    tipEl.append(d);
  }
  ensureLayer().append(tipEl);
  const r = t.getBoundingClientRect(),
    tr = tipEl.getBoundingClientRect();
  tipEl.style.left = `${Math.max(4, Math.min(innerWidth - tr.width - 4, r.left))}px`;
  tipEl.style.top = `${r.bottom + tr.height + 8 > innerHeight ? r.top - tr.height - 6 : r.bottom + 6}px`;
}

function hideTip() {
  tipEl?.remove();
  tipEl = null;
}

// ---------------------------------------------------------------------------
// Keyboard navigation for menus

export function menuKey(e: KeyboardEvent): boolean {
  if (pie) return true;
  if (!stack.length) return false;
  const m = stack[stack.length - 1];
  // text popups (search, rename prompt) handle their own keys; swallowing them here would block typing
  if (m.el.classList.contains('search-popup') || m.el.classList.contains('prompt-popup')) return false;
  const actionable = m.items.map((it, i) => (!it.separator && !it.heading && !it.custom ? i : -1)).filter((i) => i >= 0);
  if (e.key === 'Escape') {
    closeMenus();
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const pos = actionable.indexOf(m.index);
    const next = e.key === 'ArrowDown' ? actionable[(pos + 1) % actionable.length] : actionable[(pos - 1 + actionable.length) % actionable.length];
    m.index = next;
    renderMenu(m);
    return true;
  }
  if (e.key === 'ArrowRight' && m.items[m.index]?.submenu) {
    openSubmenu(m, m.items[m.index]);
    if (m.child) {
      m.child.index = m.child.items.findIndex((it) => !it.separator && !it.heading);
      renderMenu(m.child);
    }
    return true;
  }
  if (e.key === 'ArrowLeft' && m.parent) {
    closeChild(m.parent);
    return true;
  }
  if (e.key === 'Enter' && m.index >= 0) {
    activate(m, m.items[m.index]);
    return true;
  }
  let root = m;
  while (root.parent) root = root.parent;
  if (root.onType && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const fn = root.onType;
    closeMenus();
    fn(e.key);
    return true;
  }
  // underline-style accelerators: first letter of label
  if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
    const k = e.key.toLowerCase();
    const found = actionable.find((i) => itemLabel(m.items[i]).toLowerCase().startsWith(k));
    if (found !== undefined) {
      m.index = found;
      activate(m, m.items[found]);
    }
    return true;
  }
  return true;
}

export function pointerDownOutsideMenus(target: EventTarget | null) {
  // synthetic presses used to collect menu items (captureMenuItems) never close menus
  if (capturing) return false;
  if (!stack.length && !document.querySelector('.popup-layer > .popover')) return false;
  const t = target as HTMLElement;
  if (t?.closest?.('.menu, .popover, .pie')) return false;
  closeMenus();
  return true;
}

// ---------------------------------------------------------------------------
// Small text prompt popup (rename etc.), positioned at the pointer.

export function promptText(title: string, value: string, done: (v: string) => void, at?: { x: number; y: number }) {
  closeMenus();
  const el = document.createElement('div');
  el.className = 'menu prompt-popup';
  ensureLayer().append(el);
  stack.push({ el, items: [], index: 0 });
  const p = at ?? { x: app.pointer.x - 120, y: app.pointer.y - 20 };
  el.style.left = `${Math.max(4, Math.min(innerWidth - 260, p.x))}px`;
  el.style.top = `${Math.max(4, Math.min(innerHeight - 80, p.y))}px`;
  let current = value;
  const finish = (ok: boolean) => {
    closeMenus();
    if (ok) done(current.trim());
  };
  patch(el, [
    h('div', { class: 'menu-heading' }, title),
    h('input', {
      class: 'prompt-input',
      value,
      spellcheck: 'false',
      ref: (i: HTMLInputElement) =>
        requestAnimationFrame(() => {
          i.focus();
          i.select();
        }),
      oninput: (e: Event) => (current = (e.target as HTMLInputElement).value),
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      },
    }),
  ]);
}
