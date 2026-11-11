// Media Browser panel: browse Puter files and folders on this device with a
// folder tree and a list (Name, Duration, Format, Size), filter to audio,
// search, preview with a small transport, open (double-click / Enter), insert
// into a multitrack session, and drag into the editor. Durations come from
// header reads, not whole-file downloads; Puter previews stream through a
// temporary read URL. Device folders use the File System Access API (see
// storage/local-folders.js) and are listed under "This Device".

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import * as puter from '../storage/puter.js';
import * as local from '../storage/local-folders.js';
import { AUDIO_EXTENSIONS, extensionOf, decodeAudio } from '../audio/decode.js';
import { encodeWav } from '../audio/wav.js';
import { openFiles } from '../storage/files.js';
import { probeSource, describeProbe } from '../storage/probe.js';
import { formatBytesShort } from '../export/formats.js';
import { formatTime } from '../lib/time.js';

export const PUTER_DRAG_TYPE = 'application/x-audio-studio-puter';
const AUDIO = new Set(AUDIO_EXTENSIONS);
const probes = new Map(); // `${path}:${modified}` -> probe result (or a pending promise)

export const isAudioName = (name) => AUDIO.has(extensionOf(name));

/** Sorts folders first, then by name (natural order). Pure. */
export function sortItems(items) {
  return items.slice().sort((a, b) => Number(puter.isDir(b)) - Number(puter.isDir(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** Items shown for a query and the audio-only filter. Pure. */
export function filterItems(items, { query = '', audioOnly = true } = {}) {
  const q = query.trim().toLowerCase();
  return items.filter((it) => (puter.isDir(it) || !audioOnly || isAudioName(it.name)) && (!q || it.name.toLowerCase().includes(q)));
}

/** Breadcrumb segments for a Puter path, or a device folder path: [{ name, path }]. Pure. */
export function crumbs(path, rootName = null) {
  if (local.isLocalPath(path)) {
    const { rootId, parts } = local.parseLocalPath(path);
    const root = local.rootPath(rootId);
    return [{ name: rootName || 'Folder', path: root }, ...parts.map((name, i) => ({ name, path: [root, ...parts.slice(0, i + 1)].join('/') }))];
  }
  const parts = String(path || '/').split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }));
}

// Device folders known to this window, shared with drop handlers that turn
// dragged device items back into Files.
let deviceRoots = [];

/**
 * Items dragged from the Media Browser, ready for openFiles: Puter entries as
 * they are, device files as File objects. Missing device files are dropped.
 */
export async function resolveMediaItems(items) {
  const out = [];
  for (const it of items || []) {
    if (!it?.local) out.push(it);
    else {
      try {
        out.push(await local.localFile(deviceRoots, it.path));
      } catch {
        // Gone or no permission: skip it.
      }
    }
  }
  return out;
}

export function mediaBrowserPanel(app) {
  let dir = app.prefs.get('mediaFolder') || null;
  let home = null;
  let items = [];
  let selected = null;
  let loading = false;
  let error = '';
  let generation = 0;
  let visible = false;
  let started = false;
  const tree = new Map(); // path -> { children: string[] | null, expanded }
  const access = new Map(); // device root id -> 'granted' | 'prompt' | 'denied'

  // ------------------------------------------------------- file systems
  // Puter paths start with '/', device folder paths with 'local:'.
  const isDir = (it) => puter.isDir(it);
  const rootOf = (path) => (local.isLocalPath(path) ? deviceRoots.find((r) => r.id === local.parseLocalPath(path).rootId) : null);
  const readdir = (path) => (local.isLocalPath(path) ? local.readLocalDir(deviceRoots, path) : puter.readdir(path));
  const dirname = (path) => (local.isLocalPath(path) ? local.localDirname(path) : puter.dirname(path));
  const isTop = (path) => !path || path === home || path === '/' || (local.isLocalPath(path) && !local.parseLocalPath(path).parts.length);
  const readRange = async (it, offset, count) => (it.local ? (await local.localFile(deviceRoots, it.path)).slice(offset, offset + count) : puter.readRange(it.path, offset, count));
  const readBlob = (it) => (it.local ? local.localFile(deviceRoots, it.path) : puter.readFile(it.path));
  /** What openFiles takes for an item: a Puter entry, or the device File. */
  const openable = async (it) => (it.local ? local.localFile(deviceRoots, it.path) : fsItem(it));

  // ------------------------------------------------------------- elements
  const tbtn = (ic, label, onclick) => h('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onclick }, icon(ic, 15));
  const upBtn = tbtn('corner-left-up', 'Up One Level', () => dir && !isTop(dir) && navigate(dirname(dir)));
  const refreshBtn = tbtn('refresh-cw', 'Refresh', () => navigate(dir, { force: true }));
  const addFolderBtn = tbtn('folder-plus', 'Add a Folder from This Device', () => addFolder());
  addFolderBtn.hidden = !local.supported();
  const crumbBar = h('nav.media-crumbs', { 'aria-label': 'Folder path' });
  const search = h('input.input.panel-search', { type: 'search', placeholder: 'Search', 'aria-label': 'Search this folder' });
  const audioOnly = h('button.icon-btn', { type: 'button', 'aria-label': 'Show only audio files', title: 'Show only audio files', 'aria-pressed': String(app.prefs.get('mediaAudioOnly') !== false) }, icon('file-audio', 15));
  const toolbar = h('div.panel-toolbar.media-toolbar', upBtn, refreshBtn, addFolderBtn, crumbBar, search, audioOnly);
  const treeEl = h('ul.media-tree', { role: 'tree', 'aria-label': 'Folders' });
  const body = h('tbody');
  const table = h(
    'table.data-table.media-table',
    { role: 'grid', 'aria-label': 'Files' },
    h('thead', h('tr', h('th', { scope: 'col' }, 'Name'), h('th.num', { scope: 'col' }, 'Duration'), h('th.media-format', { scope: 'col' }, 'Format'), h('th.num', { scope: 'col' }, 'Size'))),
    body,
  );
  const listWrap = h('div.table-scroll.media-list', table);
  const split = h('div.media-split', h('div.media-tree-wrap', treeEl), listWrap);

  // Preview transport.
  const audio = new Audio();
  audio.preload = 'auto';
  const playBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Play Preview', title: 'Play Preview' }, icon('play', 15));
  const stopBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Stop Preview', title: 'Stop Preview' }, icon('square', 13));
  const loopBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Loop Preview', title: 'Loop Preview', 'aria-pressed': 'false' }, icon('repeat', 15));
  const seek = h('input.media-seek', { type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Preview position', disabled: true });
  const time = h('span.media-time.tabular', '0:00.000');
  const autoPlay = h('input', { type: 'checkbox', checked: Boolean(app.prefs.get('mediaAutoPlay')) });
  const previewName = h('span.media-preview-name.muted');
  const preview = h('div.media-preview', { role: 'group', 'aria-label': 'Preview' }, playBtn, stopBtn, loopBtn, seek, time);
  const actions = h(
    'div.media-actions',
    h('label.check.media-autoplay', autoPlay, 'Auto-play'),
    previewName,
    h('span.spacer'),
    h('button.btn', { type: 'button', onclick: () => selected && open([selected]) }, icon('folder-open', 14), 'Open'),
    h('button.btn', { type: 'button', dataset: { cmd: 'mt.insertFiles' }, onclick: () => selected && insert([selected]) }, icon('mode-multitrack', 14), 'Insert into Multitrack'),
  );
  const content = h('div.media-content', toolbar, split, h('div.panel-footer.media-footer', preview, actions));
  const gate = h('div.empty-state.media-gate');
  const el = h('div.media-panel', content, gate);

  // ------------------------------------------------------------- browsing
  const signedIn = () => Boolean(puter.sdk()) && puter.isSignedIn();

  const signIn = async () => {
    try {
      if (await puter.signIn()) {
        await app.refreshAccount?.();
        home = null;
        start();
      }
    } catch (err) {
      app.notify(err?.message || 'Sign in failed.', { error: true });
    }
  };

  // The gate shows only when there is nothing at all to browse.
  const renderGate = () => {
    const ok = signedIn() || deviceRoots.length > 0;
    content.hidden = !ok;
    gate.hidden = ok;
    if (ok) return;
    gate.replaceChildren(
      icon('cloud', 28),
      h('p', puter.sdk() ? 'Sign in to Puter to browse your audio files.' : 'Puter is not available. Check your connection to browse your files.'),
      puter.sdk() ? h('button.btn.primary', { type: 'button', onclick: signIn }, icon('log-in', 14), 'Sign In') : null,
      local.supported() ? h('p.faint', 'Or browse a folder on this device.') : null,
      local.supported() ? h('button.btn', { type: 'button', onclick: () => addFolder() }, icon('folder-plus', 14), 'Add Folder...') : null,
    );
  };

  async function loadDeviceRoots() {
    deviceRoots = await local.loadRoots();
    for (const r of deviceRoots) {
      access.set(r.id, await local.permission(r.handle));
      const path = local.rootPath(r.id);
      if (!tree.has(path)) tree.set(path, { children: null, expanded: false });
    }
  }

  async function addFolder() {
    try {
      const root = await local.addRoot();
      if (!root) return;
      await loadDeviceRoots();
      access.set(root.id, 'granted');
      renderGate();
      await navigate(local.rootPath(root.id));
    } catch (err) {
      app.notify(err?.message || 'The folder could not be added.', { error: true });
    }
  }

  async function removeFolder(id) {
    await local.removeRoot(id);
    const path = local.rootPath(id);
    for (const k of [...tree.keys()]) if (k === path || k.startsWith(`${path}/`)) tree.delete(k);
    await loadDeviceRoots();
    if (dir && (dir === path || dir.startsWith(`${path}/`))) {
      dir = null;
      items = [];
      await start();
    } else renderTree();
    renderGate();
  }

  /** Read access to a device root, asking the user if needed (call from a click). */
  async function ensureAccess(path) {
    const root = rootOf(path);
    if (!root) return !local.isLocalPath(path);
    if (access.get(root.id) === 'granted') return true;
    const state = await local.permission(root.handle, { request: true });
    access.set(root.id, state);
    return state === 'granted';
  }

  async function start() {
    started = true;
    await loadDeviceRoots();
    renderGate();
    if (signedIn()) {
      if (!home) home = await puter.homeDir();
      tree.set(home, tree.get(home) || { children: null, expanded: true });
    }
    const usable = (p) => p && ((local.isLocalPath(p) && rootOf(p) && access.get(rootOf(p).id) === 'granted') || (!local.isLocalPath(p) && home && p.startsWith(home)));
    if (!usable(dir)) {
      if (home) dir = await puter.appDir().then(async (d) => ((await puter.exists(d)) ? d : home));
      else {
        const r = deviceRoots.find((x) => access.get(x.id) === 'granted');
        dir = r ? local.rootPath(r.id) : null;
      }
    }
    if (dir) await navigate(dir);
    else {
      renderTree();
      renderList();
      renderCrumbs();
    }
  }

  async function listFolders(path) {
    const node = tree.get(path) || { children: null, expanded: false };
    tree.set(path, node);
    if (node.children) return node.children;
    try {
      const list = await readdir(path);
      node.children = sortItems(list.filter(isDir)).map((d) => d.path);
      for (const c of node.children) if (!tree.has(c)) tree.set(c, { children: null, expanded: false });
    } catch {
      node.children = [];
    }
    return node.children;
  }

  async function navigate(path, { force = false } = {}) {
    if (!path) return;
    if (!(await ensureAccess(path))) {
      app.notify('Allow access to this folder to browse it.');
      renderTree();
      return;
    }
    const gen = ++generation;
    loading = true;
    error = '';
    dir = path;
    app.prefs.set('mediaFolder', path);
    renderList();
    renderCrumbs();
    try {
      const list = await readdir(path);
      if (gen !== generation) return;
      items = sortItems(list);
      const node = tree.get(path) || { children: null, expanded: true };
      node.children = items.filter(isDir).map((d) => d.path);
      node.expanded = true;
      tree.set(path, node);
      for (const c of node.children) if (!tree.has(c)) tree.set(c, { children: null, expanded: false });
      // Load and expand the ancestors so the tree shows where we are.
      for (const c of crumbs(path)) {
        if (c.path === path || (!local.isLocalPath(path) && (!home || c.path.length < home.length))) continue;
        await listFolders(c.path);
        tree.get(c.path).expanded = true;
      }
      if (gen !== generation) return;
      if (force) probesFor(items).forEach((k) => probes.delete(k));
    } catch (err) {
      if (gen !== generation) return;
      items = [];
      error = err?.message || 'This folder could not be read.';
    }
    loading = false;
    renderList();
    renderTree();
    probeVisible(gen);
  }

  const probesFor = (list) => list.filter((it) => !isDir(it)).map((it) => `${it.path}:${it.modified}`);

  async function probeVisible(gen) {
    const queue = items.filter((it) => !isDir(it) && isAudioName(it.name) && !probes.has(`${it.path}:${it.modified}`)).slice(0, 300);
    const worker = async () => {
      while (queue.length && gen === generation) {
        const it = queue.shift();
        const key = `${it.path}:${it.modified}`;
        try {
          const size = it.size || 0;
          const p = await probeSource(async (at, n) => new Uint8Array(await (await readRange(it, at, n)).arrayBuffer()), size);
          probes.set(key, p);
        } catch {
          probes.set(key, { format: extensionOf(it.name).toUpperCase() });
        }
        if (gen === generation) updateRow(it);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // ------------------------------------------------------------- rendering
  function renderCrumbs() {
    if (!dir) {
      crumbBar.replaceChildren();
      upBtn.disabled = true;
      return;
    }
    const root = rootOf(dir);
    const segs = crumbs(dir, root?.name).filter((c) => local.isLocalPath(dir) || !home || c.path.length >= home.length);
    crumbBar.replaceChildren(
      ...segs
        .flatMap((c, i) => [
          i ? h('span.media-crumb-sep', { 'aria-hidden': 'true' }, '/') : null,
          h('button.media-crumb', { type: 'button', 'aria-current': c.path === dir ? 'location' : null, onclick: () => navigate(c.path) }, c.path === home ? 'Home' : c.name),
        ])
        .filter(Boolean),
    );
    upBtn.disabled = isTop(dir);
  }

  function renderTree() {
    const build = (path, level, label, rootIcon) => {
      const node = tree.get(path) || { children: null, expanded: false };
      const name = label || path.slice(path.lastIndexOf('/') + 1);
      const hasKids = node.children === null || node.children.length > 0;
      const root = level === 1 ? rootOf(path) : null;
      const locked = root && access.get(root.id) !== 'granted';
      const row = h(
        'div.media-tree-row',
        { style: { paddingLeft: `${4 + (level - 1) * 12}px` } },
        h('span.media-tree-twisty', { 'aria-hidden': 'true' }, hasKids && !locked ? icon(node.expanded ? 'chevron-down' : 'chevron-right', 12) : null),
        icon(rootIcon || (node.expanded ? 'folder-open' : 'folder'), 14),
        h('span.media-tree-name', name),
        locked ? h('span.media-tree-lock', { title: 'Click to allow access' }, icon('lock', 12)) : null,
      );
      const li = h('li', { role: 'treeitem', 'aria-level': String(level), 'aria-selected': String(path === dir), 'aria-expanded': hasKids && !locked ? String(Boolean(node.expanded)) : null, tabindex: path === dir ? '0' : '-1', dataset: { path } }, row);
      if (node.expanded && !locked && node.children?.length) li.append(h('ul', { role: 'group' }, node.children.map((c) => build(c, level + 1))));
      return li;
    };
    const focused = treeEl.contains(document.activeElement) ? document.activeElement?.dataset?.path : null;
    const groups = [];
    if (home) groups.push(h('li.media-tree-group', { role: 'presentation' }, 'Puter'), build(home, 1, 'Home', 'cloud'));
    else if (puter.sdk()) groups.push(h('li.media-tree-group', { role: 'presentation' }, 'Puter'), h('li', { role: 'treeitem', 'aria-level': '1', tabindex: '-1', dataset: { action: 'signin' } }, h('div.media-tree-row', h('span.media-tree-twisty'), icon('log-in', 14), h('span.media-tree-name', 'Sign in to browse'))));
    if (deviceRoots.length || local.supported()) groups.push(h('li.media-tree-group', { role: 'presentation' }, 'This Device'));
    for (const r of deviceRoots) groups.push(build(local.rootPath(r.id), 1, r.name, 'hard-drive'));
    if (local.supported()) groups.push(h('li', { role: 'treeitem', 'aria-level': '1', tabindex: '-1', dataset: { action: 'add' } }, h('div.media-tree-row.faint', h('span.media-tree-twisty'), icon('folder-plus', 14), h('span.media-tree-name', 'Add Folder...'))));
    treeEl.replaceChildren(...groups);
    if (!treeEl.querySelector('[tabindex="0"]')) treeEl.querySelector('[role=treeitem]')?.setAttribute('tabindex', '0');
    if (focused) treeEl.querySelector(`[data-path="${CSS.escape(focused)}"]`)?.focus();
  }

  async function toggleFolder(path, expand) {
    if (!(await ensureAccess(path))) return renderTree();
    const node = tree.get(path) || { children: null, expanded: false };
    node.expanded = expand ?? !node.expanded;
    tree.set(path, node);
    if (node.expanded) await listFolders(path);
    renderTree();
  }

  const treeAction = (li) => {
    if (li.dataset.action === 'add') addFolder();
    else if (li.dataset.action === 'signin') signIn();
    else return false;
    return true;
  };
  treeEl.addEventListener('click', (e) => {
    const li = e.target.closest('[role=treeitem]');
    if (!li || treeAction(li)) return;
    if (e.target.closest('.media-tree-twisty')) toggleFolder(li.dataset.path);
    else navigate(li.dataset.path);
  });
  treeEl.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('[role=treeitem]');
    const root = li?.dataset.path && li.getAttribute('aria-level') === '1' ? rootOf(li.dataset.path) : null;
    if (!root) return;
    e.preventDefault();
    app.openMenu([{ type: 'cmd', label: 'Remove from List', enabled: true, run: () => removeFolder(root.id) }], { x: e.clientX, y: e.clientY, label: root.name });
  });
  treeEl.addEventListener('keydown', (e) => {
    const li = e.target.closest('[role=treeitem]');
    if (!li) return;
    const all = [...treeEl.querySelectorAll('[role=treeitem]')];
    const i = all.indexOf(li);
    const path = li.dataset.path;
    const node = path ? tree.get(path) : null;
    const focus = (t) => {
      if (!t) return;
      all.forEach((x) => x.setAttribute('tabindex', '-1'));
      t.setAttribute('tabindex', '0');
      t.focus();
    };
    if (e.key === 'ArrowDown') focus(all[i + 1]);
    else if (e.key === 'ArrowUp') focus(all[i - 1]);
    else if (e.key === 'ArrowRight' && path) {
      if (node && !node.expanded) toggleFolder(path, true);
      else focus(all[i + 1]);
    } else if (e.key === 'ArrowLeft' && path) {
      if (node?.expanded && li.getAttribute('aria-level') !== '1') toggleFolder(path, false);
      else focus(li.parentElement?.closest('[role=treeitem]'));
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (!treeAction(li)) navigate(path);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });

  const durationText = (p) => (p?.duration ? formatTime(Math.round(p.duration * 1000), 1000, 'decimal') : '');

  function rowFor(it) {
    const dirItem = isDir(it);
    const p = probes.get(`${it.path}:${it.modified}`);
    const row = h(
      'tr',
      {
        tabindex: it.path === selected?.path ? '0' : '-1',
        'aria-selected': String(it.path === selected?.path),
        draggable: dirItem ? null : 'true',
        dataset: { path: it.path },
      },
      h('td.name-cell', icon(dirItem ? 'folder' : isAudioName(it.name) ? 'file-audio' : 'file-music', 14), h('span', it.name)),
      h('td.num.tabular', dirItem ? '' : durationText(p)),
      h('td.media-format', dirItem ? 'Folder' : describeProbe(p) || extensionOf(it.name).toUpperCase()),
      h('td.num.tabular', dirItem ? '' : formatBytesShort(it.size || 0)),
    );
    row.item = it;
    return row;
  }

  function updateRow(it) {
    const row = body.querySelector(`tr[data-path="${CSS.escape(it.path)}"]`);
    if (!row) return;
    const next = rowFor(it);
    row.replaceWith(next);
    if (row === document.activeElement) next.focus();
  }

  function renderList() {
    const shown = filterItems(items, { query: search.value, audioOnly: audioOnly.getAttribute('aria-pressed') === 'true' });
    body.replaceChildren();
    if (!dir) body.append(h('tr', h('td.empty-row', { colspan: '4' }, h('span.empty-text', 'Choose a folder on the left.'))));
    else if (loading) body.append(h('tr', h('td.empty-row', { colspan: '4' }, h('span.empty-text', 'Loading...'))));
    else if (error) body.append(h('tr', h('td.empty-row', { colspan: '4' }, h('span.empty-text', error))));
    else if (!shown.length) body.append(h('tr', h('td.empty-row', { colspan: '4' }, h('span.empty-text', items.length ? 'No matching files' : 'This folder is empty'))));
    else for (const it of shown) body.append(rowFor(it));
    if (!body.querySelector('tr[tabindex="0"]')) body.querySelector('tr[data-path]')?.setAttribute('tabindex', '0');
    syncActions();
  }

  function syncActions() {
    const file = selected && !isDir(selected);
    for (const b of actions.querySelectorAll('button')) b.disabled = !file || (b.dataset.cmd && !app.commands.isEnabled(b.dataset.cmd, { docs: [true] }));
  }

  function select(it, { play } = {}) {
    selected = it;
    for (const r of body.querySelectorAll('tr[data-path]')) {
      const on = r.dataset.path === it?.path;
      r.setAttribute('aria-selected', String(on));
      r.setAttribute('tabindex', on ? '0' : '-1');
    }
    syncActions();
    if (it && !isDir(it) && isAudioName(it.name) && (play ?? autoPlay.checked)) startPreview(it);
  }

  // ------------------------------------------------------------- actions
  const fsItem = (it) => ({ name: it.name, path: it.path, uid: it.uid || it.id, size: it.size, is_dir: false });
  const dragItem = (it) => (it.local ? { name: it.name, path: it.path, local: true } : fsItem(it));

  async function open(list) {
    stopPreview();
    const files = await Promise.all(list.filter((it) => !isDir(it)).map(openable));
    const docs = await openFiles(app, files);
    if (docs.length) app.dock?.openPanel('editor');
    return docs;
  }

  async function insert(list) {
    const files = list.filter((it) => !isDir(it));
    if (!files.length) return;
    // Files land in the Files panel too, as when inserting from a file list.
    const opened = await Promise.all(files.map(openable));
    const docs = await openFiles(app, opened, { activate: false });
    if (docs.length) await app.commands.run('mt.insertFiles', { docs, items: opened });
  }

  body.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-path]');
    if (row) select(row.item);
  });
  body.addEventListener('dblclick', (e) => {
    const row = e.target.closest('tr[data-path]');
    if (!row) return;
    if (isDir(row.item)) navigate(row.item.path);
    else open([row.item]);
  });
  body.addEventListener('keydown', (e) => {
    const row = e.target.closest('tr[data-path]');
    if (!row) return;
    const rows = [...body.querySelectorAll('tr[data-path]')];
    const i = rows.indexOf(row);
    const go = (r) => {
      if (!r) return;
      r.focus();
      select(r.item);
    };
    if (e.key === 'ArrowDown') go(rows[i + 1]);
    else if (e.key === 'ArrowUp') go(rows[i - 1]);
    else if (e.key === 'Home') go(rows[0]);
    else if (e.key === 'End') go(rows[rows.length - 1]);
    else if (e.key === 'Enter') {
      if (isDir(row.item)) navigate(row.item.path);
      else open([row.item]);
    } else if (e.key === 'Backspace' || (e.key === 'ArrowUp' && e.altKey)) upBtn.click();
    else if (e.key === ' ') {
      if (!isDir(row.item)) togglePreview(row.item);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  body.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('tr[data-path]');
    if (!row) return;
    e.preventDefault();
    select(row.item, { play: false });
    const it = row.item;
    const file = !isDir(it);
    app.openMenu(
      [
        { type: 'cmd', label: file ? 'Open' : 'Open Folder', enabled: true, run: () => (file ? open([it]) : navigate(it.path)) },
        { type: 'cmd', label: 'Insert into Multitrack', enabled: file && app.commands.isEnabled('mt.insertFiles', { docs: [true] }), run: () => insert([it]) },
        { type: 'sep' },
        { type: 'cmd', label: 'Play Preview', enabled: file && isAudioName(it.name), run: () => startPreview(it) },
      ],
      { x: e.clientX, y: e.clientY, label: it.name },
    );
  });
  body.addEventListener('dragstart', (e) => {
    const row = e.target.closest('tr[data-path]');
    if (!row || isDir(row.item)) return;
    e.dataTransfer.setData(PUTER_DRAG_TYPE, JSON.stringify([dragItem(row.item)]));
    e.dataTransfer.setData('text/plain', row.item.name);
    e.dataTransfer.effectAllowed = 'copy';
  });
  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => e.stopPropagation());
  audioOnly.addEventListener('click', () => {
    const on = audioOnly.getAttribute('aria-pressed') !== 'true';
    audioOnly.setAttribute('aria-pressed', String(on));
    app.prefs.set('mediaAudioOnly', on);
    renderList();
  });

  // ------------------------------------------------------------- preview
  let previewItem = null;
  let objectUrl = null;
  const setPlaying = (on) => {
    playBtn.replaceChildren(icon(on ? 'pause' : 'play', 15));
    playBtn.setAttribute('aria-label', on ? 'Pause Preview' : 'Play Preview');
    playBtn.title = on ? 'Pause Preview' : 'Play Preview';
  };
  const showTime = () => {
    const d = audio.duration;
    time.textContent = formatTime(Math.round((audio.currentTime || 0) * 1000), 1000, 'decimal');
    if (Number.isFinite(d) && d > 0) {
      seek.disabled = false;
      seek.value = String(Math.round((audio.currentTime / d) * 1000));
      seek.setAttribute('aria-valuetext', time.textContent);
    }
  };
  async function startPreview(it) {
    stopPreview();
    previewItem = it;
    previewName.textContent = it.name;
    try {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = it.local ? URL.createObjectURL(await local.localFile(deviceRoots, it.path)) : null;
      audio.src = objectUrl || (await puter.readURL(it.path));
      audio.currentTime = 0;
      await audio.play();
    } catch (err) {
      if (previewItem === it && err?.name !== 'AbortError') fallbackPreview(it);
    }
  }
  // Browsers cannot stream every format (AIFF in Chrome, for one): decode and
  // play a WAV copy of smaller files instead.
  async function fallbackPreview(it) {
    if ((it.size || 0) > 300 * 1024 * 1024) {
      app.notify(`"${it.name}" cannot be previewed in this browser. Open it instead.`);
      return;
    }
    try {
      previewName.textContent = `${it.name} (decoding...)`;
      const blob = await readBlob(it);
      if (previewItem !== it) return;
      const r = await decodeAudio(await blob.arrayBuffer(), it.name);
      if (previewItem !== it) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(encodeWav({ sampleRate: r.sampleRate, channels: r.channels.slice(0, 2), bitDepth: 16, dither: false }));
      audio.src = objectUrl;
      previewName.textContent = it.name;
      await audio.play();
    } catch (err) {
      previewName.textContent = it.name;
      if (previewItem === it) app.notify(err?.message || `"${it.name}" could not be previewed.`, { error: true });
    }
  }
  function stopPreview() {
    audio.pause();
    previewItem = null;
    setPlaying(false);
    seek.value = '0';
    seek.disabled = true;
    time.textContent = '0:00.000';
  }
  function togglePreview(it) {
    if (previewItem === it && !audio.paused) audio.pause();
    else if (previewItem === it && audio.src) audio.play().catch(() => {});
    else startPreview(it);
  }
  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('ended', () => setPlaying(false));
  audio.addEventListener('timeupdate', showTime);
  audio.addEventListener('loadedmetadata', showTime);
  playBtn.addEventListener('click', () => {
    const it = previewItem || (selected && !isDir(selected) ? selected : null);
    if (it) togglePreview(it);
  });
  stopBtn.addEventListener('click', stopPreview);
  loopBtn.addEventListener('click', () => {
    audio.loop = !audio.loop;
    loopBtn.setAttribute('aria-pressed', String(audio.loop));
  });
  seek.addEventListener('input', () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
  });
  autoPlay.addEventListener('change', () => app.prefs.set('mediaAutoPlay', autoPlay.checked));

  // Narrow panels hide the tree; the breadcrumb and Up button remain.
  const ro = new ResizeObserver(() => el.classList.toggle('narrow', el.clientWidth < 460));
  ro.observe(el);
  app.on('account', () => {
    if (!signedIn()) home = null;
    renderGate();
    if (visible) start();
  });
  app.commands && app.on('documents', syncActions);

  return {
    el,
    show() {
      visible = true;
      if (!started || (!items.length && !loading)) start();
      else renderGate();
    },
    hide() {
      visible = false;
      audio.pause();
    },
    focus() {
      (body.querySelector('tr[tabindex="0"]') || search).focus();
    },
    navigate,
    /** Shows a file's folder and selects the file. */
    async reveal(path) {
      if (!started) await start();
      await navigate(dirname(path));
      const it = items.find((x) => x.path === path);
      if (it) {
        select(it, { play: false });
        body.querySelector(`tr[data-path="${CSS.escape(path)}"]`)?.scrollIntoView?.({ block: 'nearest' });
      }
    },
  };
}
