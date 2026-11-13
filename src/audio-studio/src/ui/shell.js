// The application frame: menu bar, toolbar, docked workspace and status bar.
// Also routes keyboard shortcuts, file drops and the responsive layout mode.

import { h, announce } from '../lib/dom.js';
import { icon, appIcon } from './icons.js';
import { createMenubar, resolveItems, openMenu } from './menubar.js';
import { MENUS, commandMenuPaths, contextLabel } from './menus.js';
import { Dock } from './dock.js';
import { createAccount } from './account.js';
import { openFiles } from '../storage/files.js';
import { statusParts } from './status-fields.js';
import { tabNames } from './workspace-manager.js';
import { TOOLS } from './tools.js';
import { eventKey } from '../commands/registry.js';
import { keyedLabel, syncKeyedLabel } from '../panels/transport-controls.js';

/** Actions offered by the menu beside the current workspace tab. */
const WORKSPACE_ACTIONS = ['workspace.reset', 'workspace.saveChanges', 'workspace.saveAs', '-', 'workspace.edit'];

export function createShell(app, root) {
  const menubar = createMenubar(app, MENUS);
  const appMenuBtn = h(
    'button.icon-btn.app-menu-btn',
    { type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'menu', title: 'Menu' },
    icon('menu', 18),
  );
  appMenuBtn.addEventListener('click', () => {
    const r = appMenuBtn.getBoundingClientRect();
    const items = MENUS.map((m) => ({ type: 'sub', label: m.label, items: resolveItems(app, m.submenu) }));
    openMenu(app, items, { x: r.left, y: r.bottom + 2, anchor: appMenuBtn, label: 'Application menu' });
  });
  const title = h('div.app-title', h('span.app-logo', appIcon(20)), h('span.app-name', 'Audio Studio'));
  const docTitle = h('div.doc-title');
  const appbar = h('header.appbar', appMenuBtn, title, menubar, docTitle, h('div.spacer'), createAccount(app));

  // Toolbar ------------------------------------------------------------------
  const modeBtn = (kind, ic, label, cmd) =>
    h('button.mode-btn', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { kind, label, keyOf: cmd }, title: keyedLabel(app, cmd, label), onclick: () => app.commands.run(cmd) }, icon(ic, 16), h('span', label));
  const modes = h('div.mode-switch', { role: 'radiogroup', 'aria-label': 'Editor' }, modeBtn('audio', 'mode-waveform', 'Waveform', 'view.waveform'), modeBtn('session', 'mode-multitrack', 'Multitrack', 'view.multitrack'));
  // A command button whose label names the command's current key ("Move Tool (V)").
  const keyedButton = (cmd, label, glyph, data = {}) => {
    const text = keyedLabel(app, cmd, label);
    const dataset = { ...data, cmd, label, keyOf: cmd };
    const attrs = { type: 'button', 'aria-label': text, title: text, dataset };
    if (data.tool) attrs['aria-pressed'] = 'false';
    return h('button.icon-btn', { ...attrs, onclick: () => app.commands.run(cmd) }, glyph);
  };
  const displayBtns = h(
    'div.tool-group',
    { role: 'group', 'aria-label': 'Display' },
    keyedButton('view.spectral', 'Show Spectral Frequency Display', icon('spectral-frequency', 18)),
    h('button.icon-btn', { type: 'button', 'aria-label': 'Show Spectral Pitch Display', title: 'Show Spectral Pitch Display', dataset: { cmd: 'view.spectralPitch' }, onclick: () => app.commands.run('view.spectralPitch') }, icon('spectral-pitch', 18)),
  );
  const toolBtns = h(
    'div.tool-group.tools',
    { role: 'toolbar', 'aria-label': 'Tools' },
    TOOLS.map(([id, ic, label]) => keyedButton(`tool.${id}`, label, icon(ic, 18), { tool: id })),
  );
  const workspaceTabs = h('div.workspace-tabs', { role: 'tablist', 'aria-label': 'Workspaces' });
  const workspaceMore = h('button.icon-btn', { type: 'button', 'aria-label': 'All workspaces', title: 'Workspaces', 'aria-haspopup': 'menu' }, icon('chevrons-right', 16));
  workspaceMore.addEventListener('click', () => {
    const r = workspaceMore.getBoundingClientRect();
    app.openMenu(app.workspaceMenuItems({ overflow: true }), { x: r.left - 160, y: r.bottom + 2, anchor: workspaceMore, label: 'Workspaces' });
  });
  const search = h('input.input.command-search', { type: 'search', placeholder: 'Search commands', 'aria-label': 'Search commands', autocomplete: 'off' });
  const searchWrap = h('div.command-search-wrap', icon('search', 14), search);
  bindCommandSearch(app, search);
  const toolbar = h('div.toolbar', { role: 'toolbar', 'aria-label': 'Main toolbar' }, modes, h('div.toolbar-sep'), displayBtns, h('div.toolbar-sep'), toolBtns, h('div.spacer'), workspaceTabs, workspaceMore, searchWrap);

  const dockRoot = h('main.workspace', { 'aria-label': 'Workspace' });
  const status = h('span.status-message', { role: 'status' });
  const statusInfo = h('div.status-info');
  const statusbar = h('footer.statusbar', status, h('div.spacer'), statusInfo);
  const live = h('div#live-region.sr-only', { 'aria-live': 'polite', 'aria-atomic': 'true' });
  root.replaceChildren(appbar, toolbar, dockRoot, statusbar, live);

  const dock = new Dock(app, dockRoot, app.panels);
  app.dock = dock;
  dock.on('change', () => app.saveLayout());

  // Updates ------------------------------------------------------------------
  const refreshToolbar = () => {
    const kind = app.active?.kind;
    for (const b of modes.querySelectorAll('.mode-btn')) {
      const on = b.dataset.kind === kind;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
      // The mode buttons show their text: the key goes in the tooltip only.
      b.title = keyedLabel(app, b.dataset.keyOf, b.dataset.label);
    }
    for (const b of toolbar.querySelectorAll('[data-cmd]')) {
      syncKeyedLabel(app, b);
      b.disabled = !app.commands.isEnabled(b.dataset.cmd);
      if (b.dataset.tool) b.setAttribute('aria-pressed', String(app.tool === b.dataset.tool));
      else if (app.commands.get(b.dataset.cmd)?.checked) b.setAttribute('aria-pressed', String(app.commands.isChecked(b.dataset.cmd)));
    }
    docTitle.textContent = app.active ? `${app.active.name}${app.active.dirty ? ' *' : ''}` : '';
    document.title = app.active ? `${app.active.name}${app.active.dirty ? ' *' : ''} - Audio Studio` : 'Audio Studio';
    workspaceTabs.hidden = app.layoutMode !== 'desktop';
    workspaceMore.hidden = app.layoutMode !== 'desktop';
    // Workspace tabs.
    const names = tabNames(app);
    const current = app.prefs.get('workspace');
    if (!names.includes(current)) names.push(current);
    // Rebuilt only when the workspaces change (refreshes come with every status
    // message and playback change), keeping keyboard focus on the same tab.
    const tabsKey = JSON.stringify([names, current]);
    if (tabsKey === workspaceTabs.dataset.key) return;
    workspaceTabs.dataset.key = tabsKey;
    const had = workspaceTabs.contains(document.activeElement) ? document.activeElement : null;
    workspaceTabs.replaceChildren(
      ...names.flatMap((n) => {
        const tab = h('button.workspace-tab', { type: 'button', role: 'tab', 'aria-selected': String(n === current), dataset: { name: n }, onclick: () => app.setWorkspace(n) }, n);
        if (n !== current) return [tab];
        // The current workspace carries a menu to reset, save or edit workspaces.
        const menuBtn = h('button.icon-btn.workspace-menu-btn', { type: 'button', 'aria-label': `${n} workspace menu`, title: 'Workspace menu', 'aria-haspopup': 'menu' }, icon('menu', 14));
        menuBtn.addEventListener('click', () => {
          const r = menuBtn.getBoundingClientRect();
          openMenu(app, resolveItems(app, WORKSPACE_ACTIONS), { x: r.left, y: r.bottom + 2, anchor: menuBtn, label: `${n} workspace` });
        });
        return [tab, menuBtn];
      }),
    );
    if (had) {
      const tabs = [...workspaceTabs.querySelectorAll('.workspace-tab')];
      const same = had.classList.contains('workspace-menu-btn')
        ? workspaceTabs.querySelector('.workspace-menu-btn')
        : tabs.find((t) => t.dataset.name === had.dataset.name);
      (same || workspaceTabs.querySelector('[aria-selected=true]'))?.focus({ preventScroll: true });
    }
  };
  const refreshStatus = () => {
    status.textContent = app.statusMessage || '';
    const doc = app.active;
    statusbar.hidden = !app.prefs.get('statusBar');
    const parts = statusParts(app, doc, app.statusLive || {});
    statusInfo.replaceChildren(...parts.map((p) => h('span.status-cell', p)));
  };
  let pending = 0;
  const refresh = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      refreshToolbar();
      refreshStatus();
    });
  };
  for (const ev of ['active', 'documents', 'tool', 'prefs', 'transport', 'status', 'clipboard', 'workspace']) app.on(ev, refresh);
  app.on('doc-change', (doc, e) => doc === app.active && e.kind !== 'view' && e.kind !== 'cursor' && refresh());
  app.on('status-live', () => statusbar.hidden || refreshStatus());

  // Responsive layout ----------------------------------------------------------
  const modeFor = (w) => (w < 700 ? 'phone' : w < 1100 ? 'tablet' : 'desktop');
  const applyMode = () => {
    const mode = modeFor(window.innerWidth);
    document.documentElement.dataset.layout = mode;
    if (mode !== app.layoutMode || !dock.groups().length) {
      app.layoutMode = mode;
      dock.setLayout(app.currentLayout());
      refresh();
    }
  };
  app.layoutMode = modeFor(window.innerWidth);
  document.documentElement.dataset.layout = app.layoutMode;
  window.addEventListener('resize', applyMode);
  dock.setLayout(app.currentLayout());

  // Keyboard -----------------------------------------------------------------
  const TEXT_KEYS = /^([acvxyz]|backspace|delete|home|end|arrow(up|down|left|right))$/;
  const NAV_WIDGETS = '[role=menu], [role=listbox], [role=grid], [role=tree], [role=treegrid], [role=tablist], [role=slider], [role=radiogroup], [role=spinbutton], [role=separator], input[type=range], [data-own-keys]';
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const t = e.target;
    // puter.js's user menu takes its own keys (they arrive from the element).
    if (t instanceof Element && t.closest('puter-user-menu')) return;
    const typing = t instanceof HTMLElement && (t.isContentEditable || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (typing && !(e.metaKey || e.ctrlKey)) return;
    // Text editing keys (select all, clipboard, undo, caret and word moves) stay with the field.
    if (typing && TEXT_KEYS.test(eventKey(e))) return;
    if (document.querySelector('.dialog-backdrop')) return;
    const id = app.commands.match(e);
    if (!id) return;
    // Plain keys (Space, letters) should still activate focused buttons and menus.
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (plain && (e.key === ' ' || e.key === 'Enter') && t instanceof HTMLElement && t.closest('button, input[type=checkbox], input[type=radio], [role=menuitem], [role=menuitemcheckbox], [role=tab], [role=option], [role=checkbox], [role=switch], [role=radio], a, summary')) return;
    // Navigation keys stay with focused widgets that move with them (lists, tabs, sliders).
    const nav = /^(Delete|Backspace|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right))$/.test(e.key);
    if (plain && nav && t instanceof HTMLElement && t.closest(NAV_WIDGETS)) return;
    if (plain && nav && !app.commands.isEnabled(id)) return;
    if (typing && plain) return;
    e.preventDefault();
    app.commands.run(id);
  });

  // Drag and drop ------------------------------------------------------------
  let dragDepth = 0;
  const dropHint = h('div.drop-hint', h('div.drop-hint-inner', icon('download', 28), h('span', 'Drop audio files to open them')));
  document.body.append(dropHint);
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    dropHint.classList.add('on');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropHint.classList.remove('on');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    dragDepth = 0;
    dropHint.classList.remove('on');
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.length) openFiles(app, files);
  });

  window.addEventListener('beforeunload', (e) => {
    if (import.meta.env?.DEV) return;
    if (app.documents.some((d) => d.dirty)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  refresh();
  announce('Audio Studio ready');
  return { dock };
}

/**
 * How well command search text `q` (lower case) matches a command: 0 for the
 * whole name, 1 for its start, 2 for the start of a word, 3 anywhere in it,
 * 4 for the command id only, -1 for no match. `labels` are the names it is
 * listed under (with and without its menu context).
 */
export function searchRank(q, labels, id = '') {
  let best = -1;
  for (const raw of labels) {
    const l = String(raw).toLowerCase();
    const at = l.indexOf(q);
    if (at < 0) continue;
    const wordStart = l.split(/[\s>/(]+/).some((w) => w.startsWith(q)) || /[\s>/(]/.test(l[at - 1]);
    const r = l === q ? 0 : at === 0 ? 1 : wordStart ? 2 : 3;
    if (best < 0 || r < best) best = r;
  }
  if (best < 0 && id.toLowerCase().includes(q)) best = 4;
  return best;
}

/** Command search: type to filter every command; Enter runs the first (best) match. */
function bindCommandSearch(app, input) {
  let menu = null;
  let paths = null;
  const close = () => {
    menu?.close('search');
    menu = null;
  };
  const show = () => {
    close();
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    paths ??= commandMenuPaths();
    const found = [];
    for (const id of app.commands.commands.keys()) {
      const name = app.commands.label(id);
      const label = contextLabel(id, name, paths);
      const rank = searchRank(q, [label, String(name).replace(/\.\.\.$/, '')], id);
      if (rank < 0) continue;
      found.push({ rank, i: found.length, id, label });
    }
    // Best matches first ("play" lists Play before Move Playhead...), else in registration order.
    found.sort((a, b) => a.rank - b.rank || a.i - b.i);
    const results = found.slice(0, 14).map(({ id, label }) => {
      const enabled = app.commands.isEnabled(id);
      return { type: 'cmd', id, label, shortcut: app.commands.shortcutLabel(id), enabled, checked: null };
    });
    if (!results.length) results.push({ type: 'cmd', label: 'No matching commands', enabled: false });
    const r = input.getBoundingClientRect();
    menu = openMenu(app, results, {
      x: r.left,
      y: r.bottom + 2,
      anchor: input,
      label: 'Command results',
      // The field keeps focus so typing goes on refining the search.
      focus: 'keep',
      onClose: (reason) => {
        menu = null;
        if (reason === 'escape') input.focus();
      },
    });
  };
  input.addEventListener('input', show);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && menu) {
      e.preventDefault();
      menu.el.querySelector('.menu-item:not([aria-disabled=true])')?.focus();
    } else if (e.key === 'Enter') {
      const first = menu?.el.querySelector('.menu-item:not([aria-disabled=true])');
      first?.click();
      input.value = '';
    } else if (e.key === 'Escape') {
      input.value = '';
      close();
    }
    e.stopPropagation();
  });
}
