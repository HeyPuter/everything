// Builds the application chrome: title bar (brand, menus, quick access,
// document title, command search, GitHub link, account), CommandManager
// (tool groups and tabs), left pane, viewport host, task pane and status bar.

import { h, formatShortcut } from '../ui/dom';
import { icon } from '../ui/icons';
import { attachTooltip } from '../ui/overlay';
import { dropdown, type MenuItem, closeMenus } from '../ui/menu';
import type { CommandRegistry } from './commands';

export const REPO_URL = 'https://github.com/heyputer/everything';

export type RibbonItem =
  | { cmd: string; size?: 'big' | 'row'; menu?: string[] }
  | { stack: { cmd: string; menu?: string[] }[] };

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonItem[][];
}

export interface Shell {
  root: HTMLElement;
  menubar: HTMLElement;
  docTitle: HTMLButtonElement;
  docState: HTMLElement;
  search: HTMLInputElement;
  searchResults: HTMLElement;
  account: HTMLButtonElement;
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
  statusSketch: HTMLButtonElement;
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
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-cmd]')) {
    const id = b.dataset.cmd!;
    const c = cmds.get(id);
    if (!c) continue;
    b.disabled = !cmds.isEnabled(id);
    if (c.checked) b.setAttribute('aria-pressed', String(cmds.isChecked(id)));
  }
}

export function buildShell(cmds: CommandRegistry, menus: { label: string; items: () => MenuItem[] }[]): Shell {
  const menubar = h('nav', { class: 'menubar', role: 'menubar', 'aria-label': 'Main menu' });
  const menuButtons: HTMLButtonElement[] = [];
  let menuOpenIndex = -1;
  const openAt = (i: number) => {
    const b = menuButtons[(i + menuButtons.length) % menuButtons.length];
    const idx = menuButtons.indexOf(b);
    menuOpenIndex = idx;
    dropdown(b, menus[idx].items(), {
      label: menus[idx].label,
      onNavigate: (d) => { closeMenus(); openAt(idx + d); },
      onClose: () => { if (menuOpenIndex === idx) menuOpenIndex = -1; },
    });
  };
  menus.forEach((m, i) => {
    const b = h('button', { role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', type: 'button', tabindex: i === 0 ? '0' : '-1' }, m.label) as HTMLButtonElement;
    b.addEventListener('click', () => openAt(i));
    b.addEventListener('pointerenter', () => { if (menuOpenIndex >= 0 && menuOpenIndex !== i) { closeMenus(); openAt(i); } });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); menuButtons[(i + 1) % menuButtons.length].focus(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); menuButtons[(i - 1 + menuButtons.length) % menuButtons.length].focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); openAt(i); }
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
  const searchResults = h('div', { class: 'cmd-results', role: 'listbox', id: 'cmd-results', hidden: true });
  const github = h('a', { class: 'icon-btn', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Source code on GitHub' }, icon('github', 18));
  attachTooltip(github, 'Source code on GitHub');
  const account = h('button', { class: 'avatar-btn', type: 'button', 'aria-label': 'Account', 'aria-haspopup': 'menu' }) as HTMLButtonElement;

  const titlebar = h('header', { class: 'titlebar' },
    mobileMenu,
    h('div', { class: 'tb-brand' }, h('img', { src: './icon-128.png', alt: '' }), h('span', { class: 'name' }, 'Parametric'), h('span', { class: 'alpha-tag', title: 'Early alpha' }, 'Alpha')),
    menubar, h('span', { class: 'tb-sep hide-mobile' }), quick,
    h('div', { class: 'tb-center' }, docTitle, docState),
    h('div', { class: 'tb-right' }, h('div', { class: 'cmd-search' }, icon('search', 14), search, searchResults),
      commandButton(cmds, 'assistant'),
      (() => { const b = commandButton(cmds, 'share'); b.classList.add('hide-mobile'); return b; })(), github, account));

  const cmTools = h('div', { class: 'cm-tools', role: 'toolbar', 'aria-label': 'Commands' });
  const cmTabs = h('div', { class: 'cm-tabs', role: 'tablist', 'aria-label': 'Command groups' });
  const cm = h('section', { class: 'cm', 'aria-label': 'CommandManager' }, cmTools, cmTabs);

  const lpTabs = h('div', { class: 'lp-tabs' });
  const lpBody = h('div', { class: 'lp-body', id: 'left-panel' });
  const leftpane = h('aside', { class: 'leftpane', 'aria-label': 'Design tree and properties' }, lpTabs, lpBody);
  const splitter = h('div', { class: 'splitter', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize panel', tabindex: '0', 'aria-valuemin': '200', 'aria-valuemax': '520', 'aria-valuenow': '280' });
  const hud = h('div', { class: 'hud', role: 'toolbar', 'aria-label': 'View' });
  const confirm = h('div', { class: 'confirm-corner', hidden: true });
  const viewport = h('section', { class: 'viewport', id: 'main', 'aria-label': 'Graphics area' }, hud, confirm);
  const tpStrip = h('div', { class: 'tp-strip', role: 'tablist', 'aria-label': 'Task pane', 'aria-orientation': 'vertical' });
  const tpPanel = h('div', { class: 'tp-panel', hidden: true });
  const taskpane = h('aside', { class: 'taskpane', 'aria-label': 'Task pane' }, tpStrip, tpPanel);
  const workspace = h('main', { class: 'workspace' }, leftpane, splitter, viewport, taskpane);

  const treeToggle = h('button', { class: 'cell mobile-only', type: 'button', 'aria-label': 'Show design tree', 'aria-expanded': 'false', 'aria-controls': 'left-panel' }, icon('tree', 14), 'Tree') as HTMLButtonElement;
  const statusMsg = h('span', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const statusCoords = h('span', { class: 'cell hide-mobile', 'aria-live': 'off' });
  const statusRebuild = h('span', { class: 'cell hide-mobile', title: 'Time of the last rebuild' });
  const statusSketch = h('button', { class: 'cell', type: 'button', hidden: true }) as HTMLButtonElement;
  const statusUnits = h('button', { class: 'cell', type: 'button', 'aria-haspopup': 'menu', title: 'Unit system' }, 'MMGS') as HTMLButtonElement;
  const statusbar = h('footer', { class: 'statusbar' }, treeToggle, statusMsg, statusCoords, statusSketch, statusRebuild, statusUnits);

  const root = h('div', { class: 'app' }, titlebar, cm, workspace, statusbar);
  return {
    root, menubar, docTitle, docState, search, searchResults, account, cmTools, cmTabs, leftpane, lpTabs, lpBody, splitter, viewport, hud,
    confirm, taskpane, tpStrip, tpPanel, statusMsg, statusSketch, statusUnits, statusRebuild, statusCoords, treeToggle, mobileMenu,
  };
}

/** Renders one CommandManager tab's tools. */
export function renderRibbon(target: HTMLElement, tab: RibbonTab, cmds: CommandRegistry) {
  target.textContent = '';
  for (const group of tab.groups) {
    const g = h('div', { class: 'cm-group', role: 'group' });
    for (const it of group) {
      if ('stack' in it) {
        const st = h('div', { class: 'cm-stack' });
        for (const s of it.stack) st.append(commandButton(cmds, s.cmd, 'row', 16, s.menu));
        g.append(st);
      } else g.append(commandButton(cmds, it.cmd, it.size === 'row' ? 'row' : 'big', 26, it.menu));
    }
    target.append(g);
  }
  syncCommandButtons(target, cmds);
}

export function shortcutLabel(s?: string) {
  return formatShortcut(s);
}
