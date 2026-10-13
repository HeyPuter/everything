/**
 * Window menu features: workspaces (built-in arrangements, saved ones,
 * New / Manage / Reset), tool sets (Basic, Advanced, an edited set from the
 * All Tools drawer) and showing the Tools panel, the Control bar, New
 * Window (a second view of a document), arranging documents (tabs, side by
 * side, stacked, floating) and the screen modes.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { openPopover, closePopover } from '../../ui/popover.js';
import { SelectionSet } from '../../editor.js';
import { TOOL_LAYOUT } from '../../ui/toolbar.js';
import { createControlBar } from './control-bar.js';

// ---- tool sets ----

/** The Basic tool set: everyday drawing, type, color and navigation tools. */
export const BASIC_TOOLS = [
  'selection', 'direct-selection', 'lasso', 'magic-wand',
  'pen', 'curvature', 'pencil', 'paintbrush', 'sketch-shape', 'eraser', 'scissors',
  'rectangle', 'ellipse', 'polygon', 'star', 'line',
  'type', 'area-type', 'type-on-path',
  'rotate', 'reflect', 'scale', 'width', 'free-transform', 'shape-builder',
  'gradient', 'eyedropper', 'blend',
  'artboard', 'hand', 'rotate-view', 'zoom',
];

export function toolSet(app) {
  return app.prefs.get('toolbarSet') || 'advanced';
}

/** Tools shown for the current set (ids; `null` means every tool). */
export function shownTools(app) {
  const set = toolSet(app);
  if (set === 'basic') return new Set(BASIC_TOOLS);
  if (set === 'custom') {
    const hidden = new Set(app.prefs.get('toolbarHidden') || []);
    return new Set([...app.toolClasses.keys()].filter((id) => !hidden.has(id)));
  }
  return null;
}

function applyToolSet(app) {
  const shown = shownTools(app);
  app.toolbarFilter = shown ? (id) => shown.has(id) : null;
  app.toolbar?.rebuild?.();
}

function setToolSet(app, set) {
  app.prefs.set('toolbarSet', set);
  applyToolSet(app);
}

/** Hide or show a tool in the toolbar (makes the set an edited one). */
export function setToolShown(app, id, shown) {
  const visible = shownTools(app) || new Set(app.toolClasses.keys());
  if (shown) visible.add(id);
  else visible.delete(id);
  app.prefs.set('toolbarHidden', [...app.toolClasses.keys()].filter((t) => !visible.has(t)));
  setToolSet(app, 'custom');
}

/**
 * A list of named items to rename, duplicate and delete (Manage
 * Workspaces). Resolves to the edited list, each item
 * with `orig` (its name before), or null when cancelled.
 */
async function manageNamedDialog(app, { title, items, label, empty, fallback }) {
  let list = items.map((w) => ({ ...w, orig: w.name }));
  const ul = h('ul.ev-list', { role: 'listbox', 'aria-label': label });
  const name = h('input#mw-name', { type: 'text', autocomplete: 'off', spellcheck: false });
  let sel = list[0]?.orig || null;
  const render = () => {
    ul.replaceChildren(...list.map((w) => h('li.ev-item', { role: 'option', tabindex: w.orig === sel ? '0' : '-1', 'aria-selected': String(w.orig === sel), onclick: () => ((sel = w.orig), render()) }, h('span.ev-name', w.name))));
    if (!list.length) ul.append(h('li.panel-empty', empty));
    const cur = list.find((w) => w.orig === sel);
    name.value = cur?.name || '';
    name.disabled = del.disabled = dup.disabled = !cur;
  };
  name.addEventListener('input', () => {
    const cur = list.find((w) => w.orig === sel);
    if (cur) cur.name = name.value;
    const el = ul.querySelector('[aria-selected="true"] .ev-name');
    if (el) el.textContent = name.value;
  });
  const del = h('button.btn.small', { type: 'button', onclick: () => ((list = list.filter((w) => w.orig !== sel)), (sel = list[0]?.orig || null), render()) }, 'Delete');
  const dup = h('button.btn.small', {
    type: 'button',
    onclick: () => {
      const cur = list.find((w) => w.orig === sel);
      if (!cur) return;
      const copy = { ...cur, name: `${cur.name} copy`, orig: `${cur.orig}\u0000${Date.now()}` };
      list.push(copy);
      sel = copy.orig;
      render();
    },
  }, 'Duplicate');
  render();
  const ok = await openDialog({
    title,
    body: h('div.form.edit-views', ul, h('div.form-row', h('label', { for: 'mw-name' }, 'Name'), name), h('div.ev-actions', dup, del)),
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'OK', value: true, primary: true },
    ],
  });
  if (!ok) return null;
  const seen = new Set();
  return list.map((w) => {
    let n = w.name.trim() || fallback;
    while (seen.has(n)) n = `${n} 2`;
    seen.add(n);
    return { ...w, name: n };
  });
}

/**
 * Edit Toolbar: the All Tools drawer. Tools not in the toolbar are listed
 * by section; drag one onto the Tools panel (or press its Add button) to
 * show it, drag a tool from the panel onto the drawer (or press Remove) to
 * hide it.
 */
export function openToolDrawer(app, anchor) {
  const body = h('div.tool-drawer');
  const render = () => {
    const shown = shownTools(app) || new Set(app.toolClasses.keys());
    const sections = TOOL_LAYOUT.map((s) => ({ label: s.label, ids: s.groups.flat().filter((id) => app.toolClasses.has(id)) })).filter((s) => s.ids.length);
    const listed = new Set(sections.flatMap((s) => s.ids));
    const others = [...app.toolClasses.keys()].filter((id) => !listed.has(id));
    if (others.length) sections.push({ label: 'More', ids: others });
    body.replaceChildren(
      h('p.tool-drawer-hint', 'Drag tools onto the Tools panel to add them, or from the panel onto this drawer to remove them.'),
      ...sections.map((s) =>
        h(
          'section.tool-drawer-section',
          h('h3.tool-drawer-title', s.label),
          h(
            'ul.tool-drawer-list',
            s.ids.map((id) => {
              const T = app.toolClasses.get(id);
              const on = shown.has(id);
              const item = h(
                'li.tool-drawer-item',
                { draggable: 'true', 'data-tool': id, 'aria-label': `${T.label}${on ? ', in toolbar' : ''}` },
                h('span.tool-drawer-icon', { 'aria-hidden': 'true' }, icon(T.icon, 18)),
                h('span.tool-drawer-name', T.label.replace(/ Tool$/, '')),
                h('button.btn.small', { type: 'button', 'aria-pressed': String(on), onclick: () => (setToolShown(app, id, !on), render()) }, on ? 'Remove' : 'Add'),
              );
              item.classList.toggle('in-toolbar', on);
              item.addEventListener('dragstart', (e) => {
                e.dataTransfer?.setData('text/x-vs-tool', id);
                e.dataTransfer && (e.dataTransfer.effectAllowed = 'move');
              });
              return item;
            }),
          ),
        ),
      ),
      h(
        'div.popover-actions',
        h('button.btn.small', { type: 'button', onclick: () => (setToolSet(app, 'basic'), render()) }, 'Basic'),
        h('button.btn.small', { type: 'button', onclick: () => (setToolSet(app, 'advanced'), render()) }, 'All Tools'),
      ),
    );
  };
  // Dropping a toolbar tool on the drawer hides it.
  body.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('text/x-vs-toolbar')) e.preventDefault();
  });
  body.addEventListener('drop', (e) => {
    const id = e.dataTransfer?.getData('text/x-vs-toolbar');
    if (!id) return;
    e.preventDefault();
    setToolShown(app, id, false);
    render();
  });
  render();
  openPopover(anchor || app.toolbar.el, body, { label: 'All tools', placement: 'right' });
  return body;
}

/** Make the toolbar a drop target for drawer tools and its buttons draggable onto the drawer. */
function wireToolbarDrag(app) {
  const el = app.toolbar?.el;
  if (!el) return;
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('text/x-vs-tool')) {
      e.preventDefault();
      el.classList.add('drop-target');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-target');
    const id = e.dataTransfer?.getData('text/x-vs-tool');
    if (!id) return;
    e.preventDefault();
    setToolShown(app, id, true);
    closePopover();
  });
  el.addEventListener('dragstart', (e) => {
    const btn = e.target.closest?.('.tool-btn');
    const id = btn?._ids?.find((t) => app.toolClasses.get(t)?.label === btn.getAttribute('aria-label'));
    if (id) e.dataTransfer?.setData('text/x-vs-toolbar', id);
  });
  const mark = () => el.querySelectorAll('.tool-btn').forEach((b) => b._ids && b.setAttribute('draggable', 'true'));
  mark();
  app.on('chrome', mark);
}

// ---- workspaces ----

/** Built-in workspaces: panel arrangement, tool set and bars. */
export const WORKSPACES = {
  automation: { name: 'Automation', dock: ['properties', 'actions', 'layers'], strip: ['variables', 'history', 'links', 'documentInfo', 'swatches', 'color'], active: 'actions', toolbar: 'advanced', controlBar: false },
  essentials: { name: 'Essentials', dock: ['properties', 'layers'], strip: ['color', 'swatches', 'stroke', 'gradient', 'transparency', 'appearance', 'align', 'pathfinder', 'character', 'paragraph'], active: 'properties', toolbar: 'advanced', controlBar: false },
  classic: { name: 'Essentials Classic', dock: ['properties', 'layers', 'swatches'], strip: ['color', 'stroke', 'gradient', 'transparency', 'appearance', 'graphicStyles', 'align', 'transform', 'pathfinder', 'character', 'paragraph', 'navigator', 'info', 'artboards'], active: 'properties', toolbar: 'advanced', controlBar: true },
  gettingStarted: { name: 'Getting Started', dock: ['properties', 'layers'], strip: ['swatches', 'color', 'libraries'], active: 'properties', toolbar: 'basic', controlBar: false },
  layout: { name: 'Layout', dock: ['properties', 'layers', 'artboards'], strip: ['align', 'transform', 'character', 'paragraph', 'characterStyles', 'paragraphStyles', 'swatches', 'color', 'stroke', 'info', 'navigator'], active: 'artboards', toolbar: 'advanced', controlBar: true },
  painting: { name: 'Painting', dock: ['properties', 'swatches', 'color'], strip: ['brushes', 'gradient', 'transparency', 'appearance', 'graphicStyles', 'stroke', 'layers', 'navigator'], active: 'color', toolbar: 'basic', controlBar: false },
  printing: { name: 'Printing and Proofing', dock: ['properties', 'layers', 'separations'], strip: ['attributes', 'flattenerPreview', 'documentInfo', 'links', 'swatches', 'color', 'artboards'], active: 'properties', toolbar: 'advanced', controlBar: true },
  tracing: { name: 'Tracing', dock: ['properties', 'traceImage', 'layers'], strip: ['navigator', 'color', 'swatches', 'stroke', 'transparency', 'pathfinder'], active: 'traceImage', toolbar: 'advanced', controlBar: false },
  typography: { name: 'Typography', dock: ['properties', 'character', 'paragraph'], strip: ['characterStyles', 'paragraphStyles', 'glyphs', 'openType', 'tabs', 'layers', 'swatches', 'color', 'align'], active: 'character', toolbar: 'advanced', controlBar: true },
  web: { name: 'Web', dock: ['properties', 'layers', 'assetExport'], strip: ['swatches', 'color', 'align', 'transform', 'info', 'artboards', 'symbols', 'svgInteractivity', 'navigator'], active: 'properties', toolbar: 'advanced', controlBar: true },
};

export function savedWorkspaces(app) {
  const list = app.prefs.get('workspaces');
  return Array.isArray(list) ? list : [];
}

/** The current state as a workspace. */
export function captureWorkspace(app, name) {
  const layout = app.dock.getLayout();
  return {
    name,
    dock: layout.dock,
    strip: layout.strip,
    active: layout.active,
    toolbar: toolSet(app),
    toolbarHidden: app.prefs.get('toolbarHidden') || [],
    controlBar: Boolean(app.prefs.get('controlBar')),
    toolbarVisible: app.prefs.get('toolbarVisible') !== false,
    dockOpen: app.dockOpen,
  };
}

export function applyWorkspace(app, ws, key) {
  app.dock.setLayout(ws);
  if (ws.toolbarHidden) app.prefs.set('toolbarHidden', ws.toolbarHidden);
  setToolSet(app, ws.toolbar || 'advanced');
  setControlBar(app, Boolean(ws.controlBar));
  setToolbarVisible(app, ws.toolbarVisible !== false);
  if (ws.dockOpen !== false && !app.dockOpen) app.setDockOpen(true);
  app.root.classList.remove('hide-panels', 'hide-dock');
  app.prefs.set('workspace', key);
  app.refreshChrome();
}

/** Workspace by key: 'essentials', ..., or 'saved:<name>'. */
export function workspaceByKey(app, key) {
  if (key?.startsWith('saved:')) return savedWorkspaces(app).find((w) => w.name === key.slice(6)) || null;
  return WORKSPACES[key] || null;
}

function currentKey(app) {
  return app.prefs.get('workspace') || 'essentials';
}

async function newWorkspaceDialog(app) {
  const v = await app.dialogs.form({ title: 'New Workspace', description: 'Saves the panels, tools and bars as they are now.', fields: [{ key: 'name', label: 'Name', type: 'text', value: `Workspace ${savedWorkspaces(app).length + 1}` }] });
  const name = v?.name.trim();
  if (!name) return;
  const list = savedWorkspaces(app);
  if (list.some((w) => w.name === name) && !(await app.dialogs.confirm({ title: 'New Workspace', message: `Replace the workspace "${name}"?`, okLabel: 'Replace' }))) return;
  app.prefs.set('workspaces', [...list.filter((w) => w.name !== name), captureWorkspace(app, name)]);
  app.prefs.set('workspace', `saved:${name}`);
  app.notify(`Saved workspace "${name}".`, { polite: true });
}

async function manageWorkspacesDialog(app) {
  const out = await manageNamedDialog(app, { title: 'Manage Workspaces', items: savedWorkspaces(app), label: 'Saved workspaces', empty: 'No saved workspaces. Use New Workspace to save one.', fallback: 'Workspace' });
  if (!out) return;
  for (const w of out) if (currentKey(app) === `saved:${w.orig}`) app.prefs.set('workspace', `saved:${w.name}`);
  app.prefs.set('workspaces', out.map(({ orig, ...rest }) => rest));
}

// ---- bars ----

/** The Control bar, built the first time it is shown. */
function ensureControlBar(app) {
  if (!app.controlBar && app.topbar) {
    app.controlBar = createControlBar(app);
    app.topbar.after(app.controlBar.el);
  }
  return app.controlBar;
}

function setControlBar(app, on) {
  app.prefs.set('controlBar', on);
  if (on) ensureControlBar(app)?.setVisible(true);
  else app.controlBar?.setVisible(false);
}

function setToolbarVisible(app, on) {
  app.prefs.set('toolbarVisible', on);
  app.root.classList.toggle('hide-toolbar', !on);
}

// ---- documents: new window, arrangement ----

/** A second editor (view) on the same document, shown as its own tab. */
export function newWindow(app, editor = app.editor) {
  if (!editor) return null;
  const doc = editor.doc;
  const n = app.editors.filter((e) => e.doc === doc).length + 1;
  const base = editor.windowOf || editor;
  const ed = app.addDocument(doc, { file: editor.file, activate: false });
  ed.windowOf = base;
  Object.defineProperty(ed, 'name', { get: () => `${base.name}:${n}`, configurable: true });
  ed.view.set({ zoom: editor.view.zoom, panX: editor.view.panX, panY: editor.view.panY, rotation: editor.view.rotation, width: editor.view.width, height: editor.view.height, dpr: editor.view.dpr });
  ed.viewInitialized = true;
  ed.viewOptions = { ...editor.viewOptions };
  ed.activeArtboard = editor.activeArtboard;
  ed.activeLayerId = editor.activeLayerId;
  app.activate(ed);
  return ed;
}

/** Undo restores the selection of the window being worked in (documents shown in several windows). */
function bindSelection(doc, editor) {
  doc.selection = {
    get: () => ({ ids: [...editor.selection], anchors: [...editor.anchors].map(([k, v]) => [k, [...v]]) }),
    set: (s) => {
      editor.selection = new SelectionSet(s.ids.filter((id) => doc.has(id)));
      editor.anchors = new Map(s.anchors.filter(([k]) => doc.has(k)).map(([k, v]) => [k, new Set(v)]));
      editor.emit('selection');
    },
  };
}

export const ARRANGEMENTS = ['tabs', 'tile', 'stack'];

/** Show the documents' views: one at a time (tabs), side by side (tile) or stacked (stack); floating ones on top. */
export function layoutViews(app) {
  const mode = app.arrangement || 'tabs';
  const host = app.canvasHost;
  if (!host) return;
  const floating = app.floating || new Set();
  const docked = app.editors.filter((e) => !floating.has(e));
  const tiled = mode !== 'tabs' && docked.length > 1;
  host.classList.toggle('arrange-tile', tiled && mode === 'tile');
  host.classList.toggle('arrange-stack', tiled && mode === 'stack');
  app.root.classList.toggle('arrange-tiled', tiled || floating.size > 0);
  if (tiled && mode === 'tile') {
    const cols = Math.ceil(Math.sqrt(docked.length));
    host.style.setProperty('--tile-cols', String(cols));
  }
  for (const [ed, view] of app.views) {
    const isFloat = floating.has(ed);
    const visible = isFloat || (tiled ? docked.includes(ed) : ed === app.editor || (floating.has(app.editor) && ed === app.lastDocked));
    view.host.hidden = !visible;
    view.host.classList.toggle('floating', isFloat);
    view.host.classList.toggle('active-pane', ed === app.editor && (tiled || floating.size > 0));
    view.host.style.order = tiled && !isFloat ? String(docked.indexOf(ed)) : '';
    // The active floating window sits above the others.
    view.host.style.zIndex = isFloat && ed === app.editor ? '4' : '';
    if (isFloat) ensureFloatChrome(app, ed, view);
    else view.host.querySelector(':scope > .float-head')?.remove();
    if (visible) view.resize();
  }
}

function ensureFloatChrome(app, ed, view) {
  const host = view.host;
  if (host.querySelector(':scope > .float-head')) {
    host.querySelector('.float-title').textContent = ed.name;
    return;
  }
  if (!host.style.left) {
    const k = [...app.floating].indexOf(ed);
    Object.assign(host.style, { left: `${24 + k * 24}px`, top: `${24 + k * 24}px`, width: '50%', height: '55%' });
  }
  const head = h(
    'div.float-head',
    h('span.float-title', ed.name),
    h('button.icon-btn.small', { type: 'button', 'aria-label': `Dock ${ed.name}`, 'data-tip': 'Consolidate into tabs', onclick: () => unfloat(app, ed) }, icon('x', 12)),
  );
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    app.activate(ed);
    const x0 = e.clientX - host.offsetLeft;
    const y0 = e.clientY - host.offsetTop;
    head.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      host.style.left = `${Math.max(0, ev.clientX - x0)}px`;
      host.style.top = `${Math.max(0, ev.clientY - y0)}px`;
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  host.prepend(head);
}

function unfloat(app, ed) {
  app.floating?.delete(ed);
  const host = app.views.get(ed)?.host;
  if (host) {
    host.style.left = host.style.top = host.style.width = host.style.height = '';
  }
  layoutViews(app);
}

export function setArrangement(app, mode, { float = false } = {}) {
  app.floating ||= new Set();
  if (float && app.editor) {
    app.floating.add(app.editor);
  } else if (mode === 'tabs' || mode === 'tile') {
    // Tiling and consolidating dock every floating window first.
    for (const ed of [...app.floating]) unfloat(app, ed);
  }
  if (mode) app.arrangement = mode;
  layoutViews(app);
}

/** Float All in Windows: every document in its own window; windows already floating keep their place. */
export function floatAll(app) {
  app.floating ||= new Set();
  for (const ed of app.editors) app.floating.add(ed);
  layoutViews(app);
}

/** Cascade: every document in a floating window, stacked diagonally from the top left with the active one in front. */
export function cascadeWindows(app) {
  app.floating ||= new Set();
  for (const ed of [...app.floating]) unfloat(app, ed);
  const order = [...app.editors.filter((e) => e !== app.editor), ...(app.editor ? [app.editor] : [])];
  for (const ed of order) app.floating.add(ed);
  layoutViews(app);
}

// ---- screen modes ----

export const SCREEN_MODES = ['normal', 'menu', 'full'];

export function setScreenMode(app, mode) {
  app.screenMode = mode;
  app.root.classList.toggle('screen-menu', mode === 'menu');
  app.root.classList.toggle('screen-full', mode === 'full');
  const fs = typeof document !== 'undefined' ? document.fullscreenElement : null;
  if (mode === 'normal') {
    if (fs) document.exitFullscreen?.()?.catch?.(() => {});
  } else if (!fs) document.documentElement.requestFullscreen?.()?.catch?.(() => {});
  if (mode === 'full') app.notify('Full Screen Mode: press F or Esc to leave.', { polite: true });
  for (const v of app.views.values()) v.resize();
  app.refreshChrome?.();
}

// ---- install ----

export function installWindow(app) {
  const hasDoc = (a) => Boolean(a.editor);
  const ws = (key) => ({
    id: `window.workspace.${key}`,
    label: WORKSPACES[key].name,
    checked: (a) => currentKey(a) === key,
    run: (a) => applyWorkspace(a, WORKSPACES[key], key),
  });
  app.commands.register([
    ...Object.keys(WORKSPACES).map(ws),
    { id: 'window.workspace.new', label: 'New Workspace...', run: (a) => newWorkspaceDialog(a) },
    { id: 'window.workspace.manage', label: 'Manage Workspaces...', run: (a) => manageWorkspacesDialog(a) },
    {
      id: 'window.resetWorkspace',
      label: (a) => `Reset ${workspaceByKey(a, currentKey(a))?.name || 'Essentials'}`,
      run: (a) => {
        const key = currentKey(a);
        applyWorkspace(a, workspaceByKey(a, key) || WORKSPACES.essentials, workspaceByKey(a, key) ? key : 'essentials');
        a.dock.closeFlyout(false);
      },
    },
    { id: 'window.toolbar.basic', label: 'Basic', checked: (a) => toolSet(a) === 'basic', run: (a) => setToolSet(a, 'basic') },
    { id: 'window.toolbar.advanced', label: 'Advanced', checked: (a) => toolSet(a) === 'advanced', run: (a) => setToolSet(a, 'advanced') },
    { id: 'window.toolbar.edit', label: 'Edit Toolbar...', run: (a) => openToolDrawer(a, a.toolbar?.el.querySelector('.toolbar-misc .tool-btn')) },
    { id: 'window.toolbar', label: 'Tools', checked: (a) => a.prefs.get('toolbarVisible') !== false, run: (a) => setToolbarVisible(a, a.prefs.get('toolbarVisible') === false) },
    { id: 'window.controlBar', label: 'Control', checked: (a) => Boolean(a.prefs.get('controlBar')), run: (a) => setControlBar(a, !a.prefs.get('controlBar')) },
    { id: 'window.newWindow', label: 'New Window', enabled: hasDoc, run: (a) => newWindow(a) },
    { id: 'window.arrange.cascade', label: 'Cascade', enabled: (a) => a.editors.length > 0, run: (a) => cascadeWindows(a) },
    { id: 'window.arrange.tile', label: 'Tile', enabled: (a) => a.editors.length > 1, checked: (a) => a.arrangement === 'tile' && !a.floating?.size, run: (a) => setArrangement(a, 'tile') },
    { id: 'window.arrange.float', label: 'Float in Window', enabled: (a) => Boolean(a.editor) && !a.floating?.has(a.editor), run: (a) => setArrangement(a, null, { float: true }) },
    { id: 'window.arrange.floatAll', label: 'Float All in Windows', enabled: (a) => a.editors.some((e) => !a.floating?.has(e)), run: (a) => floatAll(a) },
    { id: 'window.arrange.consolidate', label: 'Consolidate All Windows', enabled: (a) => (a.arrangement && a.arrangement !== 'tabs') || a.floating?.size > 0, run: (a) => setArrangement(a, 'tabs') },
    ...SCREEN_MODES.map((m) => ({
      id: `window.screenMode.${m}`,
      label: { normal: 'Normal Screen Mode', menu: 'Full Screen with Menu Bar', full: 'Full Screen Mode' }[m],
      checked: (a) => (a.screenMode || 'normal') === m,
      run: (a) => setScreenMode(a, m),
    })),
    {
      id: 'window.screenMode',
      label: 'Change Screen Mode',
      shortcut: 'F',
      run: (a) => setScreenMode(a, SCREEN_MODES[(SCREEN_MODES.indexOf(a.screenMode || 'normal') + 1) % SCREEN_MODES.length]),
    },
  ]);
  app.menuSources.set('workspaces', (a) => {
    const list = savedWorkspaces(a);
    return list.map((w) => ({ label: w.name, checked: currentKey(a) === `saved:${w.name}`, run: () => applyWorkspace(a, w, `saved:${w.name}`) }));
  });
  app.openToolDrawer = (anchor) => openToolDrawer(app, anchor);

  // A document shown in several windows: closing one window never asks to save.
  const close = app.closeDocument.bind(app);
  app.closeDocument = (editor = app.editor, opts = {}) => {
    const shared = editor && app.editors.some((e) => e !== editor && e.doc === editor.doc);
    app.floating?.delete(editor);
    return close(editor, { ...opts, force: opts.force || shared });
  };

  app.on('started', () => {
    if (app.prefs.get('controlBar')) setControlBar(app, true);
    applyToolSet(app);
    setToolbarVisible(app, app.prefs.get('toolbarVisible') !== false);
    const key = app.prefs.get('workspace');
    const saved = key && workspaceByKey(app, key);
    if (saved && key !== 'essentials') app.dock.setLayout(saved);
    wireToolbarDrag(app);
    // Clicking or scrolling over a document beside the active one makes it active first.
    const pick = (e) => {
      const pane = e.target.closest?.('.view-host');
      if (!pane) return;
      for (const [ed, view] of app.views) if (view.host === pane && ed !== app.editor) app.activate(ed);
    };
    app.canvasHost.addEventListener('pointerdown', pick, true);
    app.canvasHost.addEventListener('wheel', pick, { capture: true, passive: true });
  });
  app.on('active-editor', (ed) => {
    if (ed && !app.floating?.has(ed)) app.lastDocked = ed;
    if (ed) bindSelection(ed.doc, ed);
    layoutViews(app);
  });
  app.on('closed', () => layoutViews(app));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.screenMode === 'full' && !document.querySelector('dialog[open]')) setScreenMode(app, 'normal');
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && app.screenMode && app.screenMode !== 'normal') setScreenMode(app, 'normal');
  });
}
