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
    h('button.mode-btn', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { kind }, onclick: () => app.commands.run(cmd), title: `${label} (${kind === 'audio' ? '9' : '0'})` }, icon(ic, 16), h('span', label));
  const modes = h('div.mode-switch', { role: 'radiogroup', 'aria-label': 'Editor' }, modeBtn('audio', 'mode-waveform', 'Waveform', 'view.waveform'), modeBtn('session', 'mode-multitrack', 'Multitrack', 'view.multitrack'));
  const displayBtns = h(
    'div.tool-group',
    { role: 'group', 'aria-label': 'Display' },
    h('button.icon-btn', { type: 'button', 'aria-label': 'Show Spectral Frequency Display (Shift+D)', title: 'Show Spectral Frequency Display (Shift+D)', dataset: { cmd: 'view.spectral' }, onclick: () => app.commands.run('view.spectral') }, icon('spectral-frequency', 18)),
    h('button.icon-btn', { type: 'button', 'aria-label': 'Show Spectral Pitch Display', title: 'Show Spectral Pitch Display', dataset: { cmd: 'view.spectralPitch' }, onclick: () => app.commands.run('view.spectralPitch') }, icon('spectral-pitch', 18)),
  );
  const toolBtns = h(
    'div.tool-group.tools',
    { role: 'toolbar', 'aria-label': 'Tools' },
    TOOLS.map(([id, ic, label]) => h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, 'aria-pressed': 'false', dataset: { tool: id, cmd: `tool.${id}` }, onclick: () => app.commands.run(`tool.${id}`) }, icon(ic, 18))),
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
    }
    for (const b of toolbar.querySelectorAll('[data-cmd]')) {
      b.disabled = !app.commands.isEnabled(b.dataset.cmd);
      if (b.dataset.tool) b.setAttribute('aria-pressed', String(app.tool === b.dataset.tool));
      else if (app.commands.get(b.dataset.cmd)?.checked) b.setAttribute('aria-pressed', String(app.commands.isChecked(b.dataset.cmd)));
    }
    docTitle.textContent = app.active ? `${app.active.name}${app.active.dirty ? ' *' : ''}` : '';
    document.title = app.active ? `${app.active.name}${app.active.dirty ? ' *' : ''} - Audio Studio` : 'Audio Studio';
    // Workspace tabs.
    const names = tabNames(app);
    const current = app.prefs.get('workspace');
    if (!names.includes(current)) names.push(current);
    workspaceTabs.replaceChildren(
      ...names.flatMap((n) => {
        const tab = h('button.workspace-tab', { type: 'button', role: 'tab', 'aria-selected': String(n === current), onclick: () => app.setWorkspace(n) }, n);
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
    workspaceTabs.hidden = app.layoutMode !== 'desktop';
    workspaceMore.hidden = app.layoutMode !== 'desktop';
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
  const NAV_WIDGETS = '[role=menu], [role=listbox], [role=grid], [role=tree], [role=treegrid], [role=tablist], [role=slider], [role=radiogroup], [role=spinbutton], [role=separator], input[type=range], [data-own-keys]';
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const t = e.target;
    // puter.js's user menu takes its own keys (they arrive from the element).
    if (t instanceof Element && t.closest('puter-user-menu')) return;
    const typing = t instanceof HTMLElement && (t.isContentEditable || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (typing && !(e.metaKey || e.ctrlKey)) return;
    if (document.querySelector('.dialog-backdrop')) return;
    const id = app.commands.match(e);
    if (!id) return;
    // Plain keys (Space, letters) should still activate focused buttons and menus.
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (plain && (e.key === ' ' || e.key === 'Enter') && t instanceof HTMLElement && t.closest('button, [role=menuitem], [role=tab], [role=option], a, summary')) return;
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

/** Command search: type to filter every command; Enter runs the first match. */
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
    const results = [];
    paths ??= commandMenuPaths();
    for (const id of app.commands.commands.keys()) {
      const label = contextLabel(id, app.commands.label(id), paths);
      if (!label.toLowerCase().includes(q) && !id.toLowerCase().includes(q)) continue;
      results.push({ type: 'cmd', id, label, shortcut: app.commands.shortcutLabel(id), enabled: app.commands.isEnabled(id), checked: null });
      if (results.length >= 14) break;
    }
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
