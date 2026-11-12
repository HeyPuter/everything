// Workspace management: Save Changes to this Workspace, Save as New
// Workspace, and the Edit Workspaces dialog (order; toolbar tab, overflow
// menu or Window menu only; rename and delete custom workspaces).
//
// Storage (prefs):
//   layouts            name -> current layout, updated as panels are moved
//   savedLayouts       name -> layout saved with "Save Changes" (Reset returns here)
//   customWorkspaces   name -> layout of a user workspace as first saved
//   workspaceOrder     names in menu order (missing names follow in default order)
//   workspaceTabs      names shown as toolbar tabs
//   workspaceHidden    names listed only in Window > Workspace

import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { openDialog, promptDialog, confirmDialog } from './dialog.js';
import { WORKSPACES, DEFAULT_TABS } from './workspaces.js';

const TAB_LIMIT = 6;

/** Workspace names in the user's order: known names first, then any others in default order. */
export function orderedNames(all, order = []) {
  const known = order.filter((n) => all.includes(n));
  return [...known, ...all.filter((n) => !known.includes(n))];
}

/** Names shown as toolbar tabs: the saved choice, else the default set. */
export function tabNames(app) {
  const all = app.workspaceNames();
  const saved = app.prefs.get('workspaceTabs');
  const tabs = (Array.isArray(saved) ? saved : DEFAULT_TABS).filter((n) => all.includes(n));
  return tabs.length ? tabs : all.slice(0, 1);
}

/** Problem with a new workspace name, or ''. */
export function workspaceNameProblem(name, existing, current = null) {
  const n = name.trim();
  if (!n) return 'Enter a name.';
  if (n.length > 40) return 'Use 40 characters or fewer.';
  if (existing.some((x) => x.toLowerCase() === n.toLowerCase() && x !== current)) return 'A workspace with that name already exists.';
  return '';
}

/** Renames a key in a name-keyed prefs object. */
function renameKey(obj, from, to) {
  if (!obj || !(from in obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
  return out;
}

async function saveAsNew(app) {
  const name = await promptDialog({
    title: 'New Workspace',
    label: 'Name:',
    value: `${app.prefs.get('workspace')} Copy`,
    confirm: 'Save',
    validate: (v) => workspaceNameProblem(v, app.workspaceNames()),
  });
  if (!name) return;
  const n = name.trim();
  const layout = app.dock.layout();
  app.prefs.set('customWorkspaces', { ...(app.prefs.get('customWorkspaces') || {}), [n]: layout });
  app.prefs.set('workspaceOrder', [...orderedNames(app.workspaceNames().filter((x) => x !== n), app.prefs.get('workspaceOrder')), n]);
  app.setWorkspace(n);
  app.setStatus(`Saved workspace "${n}"`);
}

/** Names in Window > Workspace only (left out of the toolbar's overflow menu). */
export function hiddenNames(app) {
  const all = app.workspaceNames();
  const saved = app.prefs.get('workspaceHidden');
  return Array.isArray(saved) ? saved.filter((n) => all.includes(n)) : [];
}

/** The three places a workspace can be listed, each in the user's order. */
export function workspaceGroups(app) {
  const order = orderedNames(app.workspaceNames(), app.prefs.get('workspaceOrder'));
  const bar = new Set(tabNames(app));
  const hidden = new Set(hiddenNames(app).filter((n) => !bar.has(n)));
  return {
    bar: order.filter((n) => bar.has(n)),
    overflow: order.filter((n) => !bar.has(n) && !hidden.has(n)),
    hidden: order.filter((n) => hidden.has(n)),
  };
}

const GROUPS = [
  { id: 'bar', label: 'Toolbar' },
  { id: 'overflow', label: 'Overflow Menu' },
  { id: 'hidden', label: 'Window Menu Only' },
];

/**
 * Moves `name` one step up (-1) or down (1). At the edge of its group it
 * crosses into the neighbouring group. Returns new groups (or the same when
 * it cannot move).
 */
export function moveWorkspace(groups, name, dir) {
  const ids = GROUPS.map((g) => g.id);
  const gi = ids.findIndex((id) => groups[id].includes(name));
  if (gi < 0) return groups;
  const list = groups[ids[gi]];
  const i = list.indexOf(name);
  const next = { ...groups, [ids[gi]]: list.slice() };
  if ((dir < 0 && i > 0) || (dir > 0 && i < list.length - 1)) {
    const l = next[ids[gi]];
    [l[i], l[i + dir]] = [l[i + dir], l[i]];
    return next;
  }
  const gj = gi + dir;
  if (gj < 0 || gj >= ids.length) return groups;
  next[ids[gi]].splice(i, 1);
  next[ids[gj]] = dir < 0 ? [...groups[ids[gj]], name] : [name, ...groups[ids[gj]]];
  return next;
}

/** Puts `name` into group `to` before `before` (or at the end). */
export function placeWorkspace(groups, name, to, before = null) {
  const next = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.filter((n) => n !== name)]));
  const list = next[to];
  const at = before ? list.indexOf(before) : -1;
  list.splice(at < 0 ? list.length : at, 0, name);
  return next;
}

function editDialog(app) {
  const prefs = app.prefs;
  let groups = workspaceGroups(app);
  let custom = { ...(prefs.get('customWorkspaces') || {}) };
  let selected = prefs.get('workspace');
  // Renames and deletions in the order they were made: a name can be deleted and reused.
  const changes = [];
  const list = h('div.ws-list', { role: 'listbox', 'aria-label': 'Workspaces', tabindex: '0' });
  const note = h('p.dlg-note.ws-note', icon('info', 14), h('span', `Drag workspaces into the order and place you want, or use the arrow buttons. Up to ${TAB_LIMIT} fit on the toolbar.`));
  const all = () => [...groups.bar, ...groups.overflow, ...groups.hidden];
  const rename = h('button.btn', { type: 'button' }, 'Rename...');
  const del = h('button.btn', { type: 'button' }, 'Delete');
  const up = h('button.icon-btn', { type: 'button', title: 'Move up', 'aria-label': 'Move up' }, icon('arrow-up', 14));
  const down = h('button.icon-btn', { type: 'button', title: 'Move down', 'aria-label': 'Move down' }, icon('arrow-down', 14));
  const apply = (next) => {
    if (next.bar.length > TAB_LIMIT) return app.notify(`Up to ${TAB_LIMIT} workspaces fit on the toolbar.`);
    groups = next;
    render();
  };
  let dragging = null;
  const render = () => {
    if (!all().includes(selected)) selected = all()[0];
    const rows = [];
    for (const g of GROUPS) {
      const head = h('div.ws-group', { dataset: { group: g.id } }, h('span', `${g.label}:`), g.id === 'bar' ? h('span.faint', ` ${groups.bar.length}/${TAB_LIMIT}`) : null);
      head.addEventListener('dragover', (e) => dragging && e.preventDefault());
      head.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragging) apply(placeWorkspace(groups, dragging, g.id, groups[g.id][0] || null));
      });
      rows.push(head);
      if (!groups[g.id].length) rows.push(h('div.ws-empty.faint', { dataset: { group: g.id } }, 'Drop a workspace here'));
      for (const name of groups[g.id]) {
        const isCustom = !WORKSPACES[name];
        const row = h('div.ws-row', { role: 'option', id: `ws-option-${rows.length}`, draggable: 'true', 'aria-selected': String(name === selected), dataset: { name } }, icon('grip-vertical', 14), h('span.ws-name', name), isCustom ? h('span.faint', '(custom)') : null);
        row.addEventListener('click', () => {
          selected = name;
          render();
        });
        row.addEventListener('dragstart', (e) => {
          dragging = name;
          e.dataTransfer?.setData('text/plain', name);
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
          dragging = null;
          row.classList.remove('dragging');
        });
        row.addEventListener('dragover', (e) => dragging && dragging !== name && e.preventDefault());
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          if (dragging && dragging !== name) apply(placeWorkspace(groups, dragging, g.id, name));
        });
        rows.push(row);
      }
    }
    list.replaceChildren(...rows);
    // Focus stays on the list: name the selected workspace to screen readers.
    const current = rows.find((r) => r.dataset.name === selected);
    if (current) list.setAttribute('aria-activedescendant', current.id);
    else list.removeAttribute('aria-activedescendant');
    for (const empty of list.querySelectorAll('.ws-empty')) {
      empty.addEventListener('dragover', (e) => dragging && e.preventDefault());
      empty.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragging) apply(placeWorkspace(groups, dragging, empty.dataset.group));
      });
    }
    const isCustom = selected && !WORKSPACES[selected];
    rename.disabled = !isCustom;
    del.disabled = !isCustom || all().length <= 1;
    up.disabled = moveWorkspace(groups, selected, -1) === groups;
    down.disabled = moveWorkspace(groups, selected, 1) === groups;
  };
  up.addEventListener('click', () => apply(moveWorkspace(groups, selected, -1)));
  down.addEventListener('click', () => apply(moveWorkspace(groups, selected, 1)));
  list.addEventListener('keydown', (e) => {
    const names = all();
    const i = names.indexOf(selected);
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      e.preventDefault();
      apply(moveWorkspace(groups, selected, e.key === 'ArrowUp' ? -1 : 1));
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      selected = names[Math.max(0, Math.min(names.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))];
      render();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!del.disabled) del.click();
    }
  });
  rename.addEventListener('click', async () => {
    const name = selected;
    const next = await promptDialog({ title: 'Rename Workspace', label: 'Name:', value: name, validate: (v) => workspaceNameProblem(v, all(), name) });
    if (!next || next.trim() === name) return;
    const n = next.trim();
    groups = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((x) => (x === name ? n : x))]));
    custom = renameKey(custom, name, n);
    changes.push(['rename', name, n]);
    selected = n;
    render();
  });
  del.addEventListener('click', async () => {
    const name = selected;
    if (!(await confirmDialog({ title: 'Delete Workspace', message: `Delete the workspace "${name}"?`, confirm: 'Delete', danger: true }))) return;
    groups = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.filter((x) => x !== name)]));
    delete custom[name];
    changes.push(['delete', name]);
    render();
  });
  render();
  return openDialog({
    title: 'Edit Workspaces',
    className: 'ws-dialog',
    body: h('div.ws-edit', h('div.ws-main', list, h('div.ws-side', up, down)), note),
    footerStart: h('div.row', rename, del),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
  }).then((r) => {
    if (r !== 'ok') return;
    // Carry current and saved layouts over to renamed workspaces; drop deleted ones.
    let layouts = { ...(prefs.get('layouts') || {}) };
    let saved = { ...(prefs.get('savedLayouts') || {}) };
    let current = prefs.get('workspace');
    for (const [kind, from, to] of changes) {
      if (kind === 'rename') {
        layouts = renameKey(layouts, from, to);
        saved = renameKey(saved, from, to);
        if (current === from) current = to;
      } else {
        delete layouts[from];
        delete saved[from];
        if (current === from) current = null;
      }
    }
    const order = all();
    prefs.set('customWorkspaces', custom);
    prefs.set('layouts', layouts);
    prefs.set('savedLayouts', saved);
    prefs.set('workspaceOrder', order);
    prefs.set('workspaceTabs', groups.bar.slice());
    prefs.set('workspaceHidden', groups.hidden.slice());
    if (!current || !order.includes(current)) current = order[0];
    app.setWorkspace(current);
  });
}

export function installWorkspaceCommands(app) {
  const desktop = (a) => a.layoutMode === 'desktop' && Boolean(a.dock);
  app.commands.register([
    {
      id: 'workspace.saveChanges',
      label: 'Save Changes to this Workspace',
      enabled: desktop,
      run: () => {
        const name = app.prefs.get('workspace');
        app.prefs.set('savedLayouts', { ...(app.prefs.get('savedLayouts') || {}), [name]: app.dock.layout() });
        app.setStatus(`Saved the layout of "${name}"`);
      },
    },
    { id: 'workspace.saveAs', label: 'Save as New Workspace...', enabled: desktop, run: () => saveAsNew(app) },
    { id: 'workspace.edit', label: 'Edit Workspaces...', enabled: desktop, run: () => editDialog(app) },
    { id: 'workspace.reset', label: 'Reset to Saved Layout', enabled: desktop, run: () => app.setWorkspace(app.prefs.get('workspace'), { reset: true }) },
  ]);
  const item = (id) => ({ type: 'cmd', label: app.commands.label(id), enabled: app.commands.isEnabled(id), run: () => app.commands.run(id) });
  // The toolbar's overflow menu leaves out "Window Menu Only" workspaces.
  app.workspaceMenuItems = ({ overflow = false } = {}) => [
    ...orderedNames(app.workspaceNames(), app.prefs.get('workspaceOrder'))
      .filter((name) => !overflow || !hiddenNames(app).includes(name) || name === app.prefs.get('workspace'))
      .map((name) => ({
        type: 'cmd',
        label: name,
        enabled: app.layoutMode === 'desktop',
        checked: app.prefs.get('workspace') === name,
        run: () => app.setWorkspace(name),
      })),
    { type: 'sep' },
    item('workspace.reset'),
    item('workspace.saveChanges'),
    item('workspace.saveAs'),
    { type: 'sep' },
    item('workspace.edit'),
  ];
}
