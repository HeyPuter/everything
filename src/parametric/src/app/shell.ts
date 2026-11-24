// Builds the application chrome: title bar (brand, menus, quick access,
// document title, command search, GitHub link, Apps launcher, account; or
// puter.js's <puter-user-menu> in place of the last two), CommandManager
// (tool groups and tabs), left pane, viewport host, task pane and status bar.

import { h, formatShortcut, titleWhenClipped } from '../ui/dom';
import { icon } from '../ui/icons';
import { attachTooltip } from '../ui/overlay';
import { dropdown, type MenuItem, closeMenus } from '../ui/menu';
import type { CommandRegistry } from './commands';
import { appsButton } from './apps-panel';
import { userMenuElement } from './user-menu';

export const REPO_URL = 'https://github.com/heyputer/everything';

export type RibbonItem =
  | { cmd: string; size?: 'big' | 'row'; menu?: string[] }
  | { stack: { cmd: string; menu?: string[] }[] };

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonItem[][];
  /** Names of the groups, shown under them. */
  labels?: string[];
}

export interface Shell {
  root: HTMLElement;
  menubar: HTMLElement;
  docTitle: HTMLButtonElement;
  docState: HTMLElement;
  search: HTMLInputElement;
  searchResults: HTMLElement;
  account: HTMLButtonElement;
  apps: HTMLButtonElement;
  /** puter.js's <puter-user-menu>, when the loaded SDK defines it (see user-menu.ts). */
  userMenu: HTMLElement | null;
  cmTools: HTMLElement;
  cmTabs: HTMLElement;
  leftpane: HTMLElement;
  lpTabs: HTMLElement;
  lpBody: HTMLElement;
  splitter: HTMLElement;
  viewport: HTMLElement;
  hud: HTMLElement;
  confirm: HTMLElement;
  taskpane: HTMLElement;
  tpStrip: HTMLElement;
  tpPanel: HTMLElement;
  statusMsg: HTMLElement;
  statusSketch: HTMLElement;
  statusUnits: HTMLButtonElement;
  statusRebuild: HTMLElement;
  statusCoords: HTMLElement;
  treeToggle: HTMLButtonElement;
  mobileMenu: HTMLButtonElement;
}

/** Button bound to a command, kept in sync with enabled/checked state. */
export function commandButton(cmds: CommandRegistry, id: string, variant: 'icon' | 'big' | 'row' = 'icon', size = 18, menu?: string[]): HTMLElement {
  const c = cmds.get(id);
  if (!c) throw new Error(`Unknown command ${id}`);
  let b: HTMLButtonElement;
  if (variant === 'icon') {
    b = h('button', { class: 'icon-btn', type: 'button', 'aria-label': c.label, 'data-cmd': id }, icon(c.icon ?? 'settings', size)) as HTMLButtonElement;
  } else {
    b = h('button', { class: `tool${variant === 'row' ? ' row' : ''}`, type: 'button', 'data-cmd': id },
      icon(c.icon ?? 'settings', variant === 'big' ? 26 : 16), h('span', { class: 'lbl' }, c.label)) as HTMLButtonElement;
  }
  attachTooltip(b, c.label, c.shortcut, c.description);
  b.addEventListener('click', () => cmds.run(id));
  if (!menu || variant === 'icon') return b;
  // Split button: the caret is a separate button (never nested in the main one).
  const caret = h('button', { class: 'tool-caret', type: 'button', 'aria-label': `More ${c.label} options`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('chevronDown', 10));
  caret.addEventListener('click', () => {
    dropdown(caret, menu.map((m) => {
      const mc = cmds.get(m)!;
      return { label: mc.label, icon: mc.icon, shortcut: mc.shortcut, disabled: !cmds.isEnabled(m), run: () => cmds.run(m) };
    }), { label: `${c.label} options` });
  });
  return h('div', { class: 'tool-split' }, b, caret);
}

export function syncCommandButtons(root: ParentNode, cmds: CommandRegistry) {
  const focused = document.activeElement;
  let lostFocus: HTMLButtonElement | null = null;
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-cmd]')) {
    const id = b.dataset.cmd!;
    const c = cmds.get(id);
    if (!c) continue;
    b.disabled = !cmds.isEnabled(id);
    if (b.disabled && b === focused) lostFocus = b;
    if (c.checked) b.setAttribute('aria-pressed', String(cmds.isChecked(id)));
  }
  // A disabled button drops keyboard focus to the page (Undo pressed until
  // there is nothing left to undo): it moves on to its toolbar's next button.
  if (lostFocus) {
    const bar = lostFocus.closest<HTMLElement>('[role="toolbar"]') ?? lostFocus.parentElement;
    const all = [...(bar?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = all.indexOf(lostFocus);
    const usable = all.filter((x) => !x.disabled && x.getClientRects().length);
    const next = usable.find((x) => all.indexOf(x) > i) ?? usable.findLast((x) => all.indexOf(x) < i);
    next?.focus({ preventScroll: true });
  }
}

export function buildShell(cmds: CommandRegistry, menus: { label: string; items: () => MenuItem[] }[]): Shell {
  const menubar = h('nav', { class: 'menubar', role: 'menubar', 'aria-label': 'Main menu' });
  const menuButtons: HTMLButtonElement[] = [];
  let menuOpenIndex = -1;
  const openAt = (i: number, last = false) => {
    const b = menuButtons[(i + menuButtons.length) % menuButtons.length];
    const idx = menuButtons.indexOf(b);
    menuOpenIndex = idx;
    dropdown(b, menus[idx].items(), {
      label: menus[idx].label,
      focusLast: last,
      onNavigate: (d) => { closeMenus(); openAt(idx + d); },
      onClose: () => { if (menuOpenIndex === idx) menuOpenIndex = -1; },
    });
  };
  menus.forEach((m, i) => {
    const b = h('button', { role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', type: 'button', tabindex: i === 0 ? '0' : '-1' }, m.label) as HTMLButtonElement;
    b.addEventListener('click', () => openAt(i));
    b.addEventListener('pointerenter', () => { if (menuOpenIndex >= 0 && menuOpenIndex !== i) { closeMenus(); openAt(i); } });
    // One tab stop: the menu last moved to (Shift+Tab from Edit leaves the menubar instead of going to File).
    b.addEventListener('focus', () => menuButtons.forEach((x) => x.setAttribute('tabindex', x === b ? '0' : '-1')));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); menuButtons[(i + 1) % menuButtons.length].focus(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); menuButtons[(i - 1 + menuButtons.length) % menuButtons.length].focus(); }
      if (e.key === 'Home') { e.preventDefault(); menuButtons[0].focus(); }
      if (e.key === 'End') { e.preventDefault(); menuButtons[menuButtons.length - 1].focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); openAt(i); }
      // Up opens the menu at its last item, as in any menubar.
      if (e.key === 'ArrowUp') { e.preventDefault(); openAt(i, true); }
    });
    menuButtons.push(b);
    menubar.append(b);
  });

  const mobileMenu = h('button', { class: 'icon-btn mobile-only', type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'menu' }, icon('menu', 20)) as HTMLButtonElement;
  mobileMenu.addEventListener('click', () => {
    dropdown(mobileMenu, menus.map((m) => ({ label: m.label, submenu: m.items })), { label: 'Menu' });
  });

  const quick = h('div', { class: 'quick', role: 'toolbar', 'aria-label': 'Quick access' },
    commandButton(cmds, 'new'), commandButton(cmds, 'open'), commandButton(cmds, 'save'),
    h('span', { class: 'tb-sep hide-mobile' }),
    commandButton(cmds, 'undo'), commandButton(cmds, 'redo'),
    h('span', { class: 'tb-sep hide-mobile' }),
    (() => { const b = commandButton(cmds, 'rebuild'); b.classList.add('hide-mobile'); return b; })(),
    (() => { const b = commandButton(cmds, 'options'); b.classList.add('hide-tablet', 'hide-mobile'); return b; })());
  for (const b of quick.querySelectorAll<HTMLElement>('[data-cmd="new"], [data-cmd="open"]')) b.classList.add('hide-mobile');

  const docTitle = h('button', { class: 'doc-title', type: 'button', title: 'Rename part' }, 'Part1') as HTMLButtonElement;
  const docState = h('span', { class: 'doc-state', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', placeholder: 'Search commands', 'aria-label': 'Search commands', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'cmd-results', 'aria-autocomplete': 'list' }) as HTMLInputElement;
  // The narrow box of tablet-width title bars (130px, see app.css) clips "Search commands"
  // in most fonts: it says "Search" there. Its name stays "Search commands".
  if (typeof matchMedia !== 'undefined') {
    const narrow = matchMedia('(max-width: 1180px)');
    const sync = () => { search.placeholder = narrow.matches ? 'Search' : 'Search commands'; };
    narrow.addEventListener?.('change', sync);
    sync();
  }
  const searchResults = h('div', { class: 'cmd-results', role: 'listbox', id: 'cmd-results', hidden: true });
  // Narrow windows leave its room to the part name: Help › Source Code on GitHub has it too.
  const github = h('a', { class: 'icon-btn hide-tablet', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Source code on GitHub' }, icon('github', 18));
  attachTooltip(github, 'Source code on GitHub');
  const apps = appsButton();
  const account = h('button', { class: 'avatar-btn', type: 'button', 'aria-label': 'Account', 'aria-haspopup': 'menu' }) as HTMLButtonElement;
  // puter.js was loaded (deferred) before this module ran, so it has defined
  // <puter-user-menu> by now if it has one. Where it renders, the app's own
  // launcher and account button stand down from the first paint.
  const userMenu = userMenuElement();
  if (userMenu && !userMenu.hidden) apps.hidden = account.hidden = true;

  const titlebar = h('header', { class: 'titlebar' },
    mobileMenu,
    h('div', { class: 'tb-brand' }, h('img', { src: './icon-128.png', alt: '' }), h('span', { class: 'name' }, 'Parametric'), h('span', { class: 'alpha-tag', title: 'Early alpha' }, 'Alpha')),
    menubar, h('span', { class: 'tb-sep hide-mobile' }), quick,
    h('div', { class: 'tb-center' }, docTitle, docState),
    h('div', { class: 'tb-right' }, h('div', { class: 'cmd-search' }, icon('search', 14), search, searchResults),
      commandButton(cmds, 'assistant'),
      (() => { const b = commandButton(cmds, 'share'); b.classList.add('hide-mobile'); return b; })(), github, apps, account, userMenu));

  const cmTools = h('div', { class: 'cm-tools', role: 'toolbar', 'aria-label': 'Commands' });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fitRibbon(cmTools)).observe(cmTools);
  // A narrow window clips the tools on the right and the strip has no
  // scrollbar: a plain mouse wheel scrolls it sideways (trackpads and touch
  // already can).
  cmTools.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.deltaX || !e.deltaY || cmTools.scrollWidth <= cmTools.clientWidth) return;
    e.preventDefault();
    cmTools.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  }, { passive: false });
  const cmTabs = h('div', { class: 'cm-tabs', role: 'tablist', 'aria-label': 'Command groups' });
  const cm = h('section', { class: 'cm', 'aria-label': 'CommandManager' }, ribbonScroller(cmTools), cmTabs);

  const lpTabs = h('div', { class: 'lp-tabs' });
  const lpBody = h('div', { class: 'lp-body', id: 'left-panel', role: 'tabpanel' });
  const leftpane = h('aside', { class: 'leftpane', 'aria-label': 'Design tree and properties' }, lpTabs, lpBody);
  const splitter = h('div', { class: 'splitter', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize panel', tabindex: '0', 'aria-valuemin': '200', 'aria-valuemax': '520', 'aria-valuenow': '280' });
  const hud = h('div', { class: 'hud', role: 'toolbar', 'aria-label': 'View' });
  const confirm = h('div', { class: 'confirm-corner', hidden: true });
  const viewport = h('section', { class: 'viewport', id: 'main', 'aria-label': 'Graphics area' }, hud, confirm);
  const tpStrip = h('div', { class: 'tp-strip', role: 'tablist', 'aria-label': 'Task pane', 'aria-orientation': 'vertical' });
  const tpPanel = h('div', { class: 'tp-panel', id: 'task-pane-panel', role: 'tabpanel', hidden: true });
  const taskpane = h('aside', { class: 'taskpane', 'aria-label': 'Task pane' }, tpStrip, tpPanel);
  const workspace = h('main', { class: 'workspace' }, leftpane, splitter, viewport, taskpane);

  const treeToggle = h('button', { class: 'cell mobile-only', type: 'button', 'aria-label': 'Show design tree', 'aria-expanded': 'false', 'aria-controls': 'left-panel' }, icon('tree', 14), 'Tree') as HTMLButtonElement;
  const statusMsg = h('span', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  titleWhenClipped(statusMsg);
  const statusCoords = h('span', { class: 'cell hide-mobile', 'aria-live': 'off' });
  const statusRebuild = h('span', { class: 'cell hide-mobile', title: 'Time of the last rebuild' });
  // The sketch's definition status: text, not a button (it has no action).
  const statusSketch = h('span', { class: 'cell', hidden: true });
  const statusUnits = h('button', { class: 'cell', type: 'button', 'aria-haspopup': 'menu', title: 'Unit system' }, 'MMGS') as HTMLButtonElement;
  const statusbar = h('footer', { class: 'statusbar' }, treeToggle, statusMsg, statusCoords, statusSketch, statusRebuild, statusUnits);

  const root = h('div', { class: 'app' }, titlebar, cm, workspace, statusbar);
  return {
    root, menubar, docTitle, docState, search, searchResults, account, apps, userMenu, cmTools, cmTabs, leftpane, lpTabs, lpBody, splitter, viewport, hud,
    confirm, taskpane, tpStrip, tpPanel, statusMsg, statusSketch, statusUnits, statusRebuild, statusCoords, treeToggle, mobileMenu,
  };
}

/** Shows the scroll buttons a clipped CommandManager needs (see ribbonScroller). */
const ribbonScrollSync = new WeakMap<HTMLElement, () => void>();

/**
 * A window too narrow for the CommandManager's tools clips them on the right,
 * with no scrollbar: buttons at its ends, over a fade, say that more is there
 * and scroll to it. They appear only while there is more that way, and a tool
 * reached with Tab is scrolled clear of them.
 */
function ribbonScroller(tools: HTMLElement): HTMLElement {
  const step = (dir: -1 | 1) => {
    const smooth = !matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    tools.scrollBy({ left: dir * Math.max(80, tools.clientWidth * 0.7), behavior: smooth ? 'smooth' : 'auto' });
  };
  const button = (dir: -1 | 1) => {
    // Not the classes start/end: .start is the start screen's.
    const b = h('button', { class: `cm-scroll ${dir < 0 ? 'to-start' : 'to-end'}`, type: 'button', hidden: true, 'aria-label': dir < 0 ? 'Scroll commands left' : 'Scroll commands right' },
      icon(dir < 0 ? 'chevronLeft' : 'chevronRight', 16)) as HTMLButtonElement;
    attachTooltip(b, dir < 0 ? 'More commands to the left' : 'More commands to the right');
    b.addEventListener('click', () => step(dir));
    return b;
  };
  const start = button(-1);
  const end = button(1);
  const sync = () => {
    const over = tools.scrollWidth > tools.clientWidth + 1;
    const atStart = tools.scrollLeft <= 1;
    const atEnd = tools.scrollLeft + tools.clientWidth >= tools.scrollWidth - 1;
    const lost = [start, end].find((b) => document.activeElement === b);
    start.hidden = !over || atStart;
    end.hidden = !over || atEnd;
    // Scrolled all the way with it: focus moves to the tool now at that end, not to the page.
    if (lost?.hidden) {
      const usable = [...tools.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.disabled);
      (lost === start ? usable[0] : usable[usable.length - 1])?.focus({ preventScroll: true });
    }
  };
  tools.addEventListener('scroll', sync, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(tools);
  ribbonScrollSync.set(tools, sync);
  // A tool reached with Tab comes into view clear of the buttons over the ends.
  tools.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement;
    const r = t.getBoundingClientRect();
    const box = tools.getBoundingClientRect();
    // Clear of a button only where one is shown (none at the start of the strip).
    const lead = start.hidden ? 0 : 32;
    const trail = end.hidden ? 0 : 32;
    if (r.left < box.left + lead) tools.scrollLeft -= box.left + lead - r.left;
    else if (r.right > box.right - trail) tools.scrollLeft += r.right - (box.right - trail);
  });
  return h('div', { class: 'cm-bar' }, start, tools, end);
}

/** Renders one CommandManager tab's tools. */
export function renderRibbon(target: HTMLElement, tab: RibbonTab, cmds: CommandRegistry) {
  target.textContent = '';
  tab.groups.forEach((group, i) => {
    const name = tab.labels?.[i];
    const g = h('div', { class: 'cm-group', role: 'group', ...(name ? { 'aria-label': name, 'data-group': name.toLowerCase() } : {}) });
    for (const it of group) {
      if ('stack' in it) {
        const st = h('div', { class: 'cm-stack' });
        for (const s of it.stack) st.append(commandButton(cmds, s.cmd, 'row', 16, s.menu));
        g.append(st);
      } else g.append(commandButton(cmds, it.cmd, it.size === 'row' ? 'row' : 'big', 26, it.menu));
    }
    target.append(g);
  });
  syncCommandButtons(target, cmds);
  fitRibbon(target);
  target.scrollLeft = 0;
  ribbonScrollSync.get(target)?.();
}

/**
 * When a tab's tools are wider than the window, groups that can (the sketch
 * constraints) show their row buttons as icons only, named in tooltips.
 */
export function fitRibbon(tools: HTMLElement) {
  tools.classList.remove('compact');
  if (tools.scrollWidth > tools.clientWidth + 1) tools.classList.add('compact');
}

export function shortcutLabel(s?: string) {
  return formatShortcut(s);
}
